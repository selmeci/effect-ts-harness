import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  HARNESS_GATE_RULE_VERSION,
} from "@harness/contract"
import {
  EventSchemaEvolutionInput,
  type EventVersionSnapshotEntry as EventVersionSnapshotEntryType,
  EventVersionSnapshotEntry,
  type EventUpcasterLink,
  FrozenEventSchemaViolationError,
} from "@harness/es-contract"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "@harness/es-core"
import {
  AstGateCache,
  checkMigrationSqlSafety,
  collectWorkspaceTsFiles,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import { resolveRepoPath } from "./repo-path.js"

const decodeUnknownJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))
const decodeSnapshotArray = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(EventVersionSnapshotEntry)),
)

const extractFlag = (subArgs: ReadonlyArray<string>, flagName: string): string | undefined => {
  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i]
    if (arg === flagName && i + 1 < subArgs.length) {
      return subArgs[i + 1]
    }
    if (arg !== undefined && arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
  }
  return undefined
}

const failResult = (stderr: string, exitCode = 1): CliResult => ({ exitCode, stdout: "", stderr })

const decodeJsonResult = (
  raw: string,
  errorLabel: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly result: CliResult } =>
  match(decodeUnknownJson(raw))
    .with({ _tag: "None" }, () => ({ ok: false as const, result: failResult(`ERROR: ${errorLabel}\n`) }))
    .with({ _tag: "Some" }, ({ value }) => ({ ok: true as const, value }))
    .exhaustive()

const resolveRepoRoot = (options?: CliEnv): string =>
  options?.repoRoot ?? findWorkspaceRoot()

interface OpenApiModuleShape {
  readonly buildOpenApiSpec: () => unknown
  readonly detectOpenApiBreakingChanges: (
    baseline: unknown,
    current: unknown,
  ) => ReadonlyArray<string>
}

interface EventModuleShape {
  readonly computeSnapshots: Effect.Effect<
    ReadonlyArray<EventVersionSnapshotEntryType>,
    RepoCheckCliError
  >
  readonly registeredUpcasters: ReadonlyArray<EventUpcasterLink>
}

class RepoCheckCliError extends Schema.TaggedError<RepoCheckCliError>()(
  "RepoCheckCliError",
  {
    message: Schema.String,
  },
) {}

const isSnapshotsEffect = (
  value: unknown,
): value is Effect.Effect<ReadonlyArray<EventVersionSnapshotEntryType>> => Effect.isEffect(value)

const resolveModuleSpecifier = (
  repoRoot: string,
  moduleFlag: string | undefined,
  defaultSpecifier: string,
): Effect.Effect<string, RepoCheckCliError> => {
  if (moduleFlag === undefined) {
    return Effect.succeed(defaultSpecifier)
  }
  const resolved = resolveRepoPath(repoRoot, moduleFlag)
  if (resolved === undefined) {
    return Effect.fail(
      new RepoCheckCliError({ message: `Module path '${moduleFlag}' escapes repository root` }),
    )
  }
  return Effect.succeed(pathToFileURL(resolved).href)
}

const importModuleRecord = Effect.fn("HarnessCli.importModuleRecord")(function* (
  repoRoot: string,
  moduleFlag: string | undefined,
  defaultSpecifier: string,
): Effect.fn.Return<{ readonly specifier: string; readonly mod: Record<string, unknown> }, RepoCheckCliError> {
  const specifier = yield* resolveModuleSpecifier(repoRoot, moduleFlag, defaultSpecifier)
  const mod = yield* Effect.tryPromise({
    try: () => import(specifier) as Promise<Record<string, unknown>>,
    catch: (error) =>
      new RepoCheckCliError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
  return { specifier, mod }
})

const loadOpenApiModule = Effect.fn("HarnessCli.loadOpenApiModule")(function* (
  repoRoot: string,
  moduleFlag: string | undefined,
): Effect.fn.Return<OpenApiModuleShape, RepoCheckCliError> {
  const { specifier, mod } = yield* importModuleRecord(repoRoot, moduleFlag, "@harness/sample-contract")
  const buildOpenApiSpec = mod["buildOpenApiSpec"]
  const detectOpenApiBreakingChanges = mod["detectOpenApiBreakingChanges"]
  if (typeof buildOpenApiSpec !== "function" || typeof detectOpenApiBreakingChanges !== "function") {
    return yield* new RepoCheckCliError({
      message: `Module '${specifier}' must export buildOpenApiSpec and detectOpenApiBreakingChanges`,
    })
  }
  return {
    buildOpenApiSpec: buildOpenApiSpec as () => unknown,
    detectOpenApiBreakingChanges: detectOpenApiBreakingChanges as (baseline: unknown, current: unknown) => ReadonlyArray<string>,
  }
})

const loadEventModule = Effect.fn("HarnessCli.loadEventModule")(function* (
  repoRoot: string,
  moduleFlag: string | undefined,
): Effect.fn.Return<EventModuleShape, RepoCheckCliError> {
  const { specifier, mod } = yield* importModuleRecord(repoRoot, moduleFlag, "@harness/es-core/fixtures/cart")
  const computeSnapshots = mod["computeEventSnapshots"] ?? mod["computeCartEventSnapshots"]
  const registeredUpcasters = mod["registeredUpcasters"] ?? mod["cartRegisteredUpcasters"]
  if ((!isSnapshotsEffect(computeSnapshots) && typeof computeSnapshots !== "function") || !Array.isArray(registeredUpcasters)) {
    return yield* new RepoCheckCliError({
      message: `Module '${specifier}' must export computeEventSnapshots/computeCartEventSnapshots and registeredUpcasters/cartRegisteredUpcasters`,
    })
  }
  const snapshotsEffect = isSnapshotsEffect(computeSnapshots)
    ? computeSnapshots
    : Effect.tryPromise({
        try: () => Promise.resolve((computeSnapshots as () => ReadonlyArray<EventVersionSnapshotEntryType>)()),
        catch: (error) => new RepoCheckCliError({ message: error instanceof Error ? error.message : String(error) }),
      })
  return {
    computeSnapshots: snapshotsEffect.pipe(
      Effect.mapError((error) => (error instanceof RepoCheckCliError ? error : new RepoCheckCliError({ message: String(error) }))),
    ),
    registeredUpcasters: registeredUpcasters as ReadonlyArray<EventUpcasterLink>,
  }
})

type BaselineResolution =
  | { readonly ok: true; readonly json: string; readonly source: string }
  | { readonly ok: false; readonly result: CliResult }

const resolveOpenApiBaseline = (
  repoRoot: string,
  subArgs: ReadonlyArray<string>,
  committedJson: string,
): BaselineResolution => {
  const cliBaselinePath = extractFlag(subArgs, "--baseline")
  if (cliBaselinePath !== undefined) {
    const resolvedPath = resolveRepoPath(repoRoot, cliBaselinePath)
    if (resolvedPath === undefined) {
      return {
        ok: false,
        result: failResult(`ERROR: OpenAPI baseline path '${cliBaselinePath}' escapes repository root\n`),
      }
    }
    if (nodeSyncHostIo.existsSync(resolvedPath)) {
      return { ok: true, json: nodeSyncHostIo.readTextSync(resolvedPath), source: `file:${cliBaselinePath}` }
    }
  }

  const envBaselinePath = process.env.OPENAPI_BASELINE_PATH
  if (envBaselinePath !== undefined && envBaselinePath.length > 0) {
    const resolvedEnvPath = resolveRepoPath(repoRoot, envBaselinePath)
    if (resolvedEnvPath === undefined) {
      return {
        ok: false,
        result: failResult(
          `ERROR: OPENAPI_BASELINE_PATH '${envBaselinePath}' escapes repository root\n`,
        ),
      }
    }
    if (nodeSyncHostIo.existsSync(resolvedEnvPath)) {
      return { ok: true, json: nodeSyncHostIo.readTextSync(resolvedEnvPath), source: `env:${envBaselinePath}` }
    }
  }

  const gitMain = nodeSyncHostIo.execFileSync(
    "git",
    ["show", "main:libs/sample/contract/openapi.json"],
    { cwd: repoRoot },
  )
  if (gitMain.exitCode === 0 && gitMain.stdout.trim().length > 0) {
    return { ok: true, json: gitMain.stdout, source: "git:main" }
  }

  const gitHead = nodeSyncHostIo.execFileSync(
    "git",
    ["show", "HEAD:libs/sample/contract/openapi.json"],
    { cwd: repoRoot },
  )
  if (gitHead.exitCode === 0 && gitHead.stdout.trim().length > 0) {
    return { ok: true, json: gitHead.stdout, source: "git:HEAD" }
  }

  return { ok: true, json: committedJson, source: "committed" }
}

const runOasdiffIfAvailable = (
  repoRoot: string,
  baselineJson: string,
  openApiPath: string,
): CliResult | undefined => {
  const versionCheck = nodeSyncHostIo.execFileSync("oasdiff", ["--version"], { cwd: repoRoot })
  if (versionCheck.exitCode !== 0) {
    return undefined
  }
  const tmpDir = nodeSyncHostIo.mkdtempSync("harness-openapi-baseline-")
  const tmpBaselinePath = join(tmpDir, "baseline.json")
  nodeSyncHostIo.writeTextSync(tmpBaselinePath, baselineJson)
  const diffResult = nodeSyncHostIo.execFileSync(
    "oasdiff",
    ["breaking", tmpBaselinePath, openApiPath],
    { cwd: repoRoot },
  )
  nodeSyncHostIo.rmRecursiveSync(tmpDir)

  if (diffResult.exitCode !== 0) {
    const details = [diffResult.stderr, diffResult.stdout].filter((s) => s.length > 0).join("\n")
    return {
      exitCode: 2,
      stdout: "",
      stderr: `openapi check: ESCALATE — breaking OpenAPI changes require human confirmation:\n${details}${details.endsWith("\n") ? "" : "\n"}`,
    }
  }
  return undefined
}

/**
 * Typed `check-openapi` subcommand.
 */
export const runCheckOpenApi = Effect.fn("HarnessCli.checkOpenApi")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "check-openapi" ? args.slice(1) : args
  const repoRoot = resolveRepoRoot(options)
  const outFlag = extractFlag(subArgs, "--out")
  const moduleFlag = extractFlag(subArgs, "--module")
  const envSpecPath = process.env.OPENAPI_SPEC_PATH
  const rawSpecPath =
    outFlag ??
    (envSpecPath !== undefined && envSpecPath.length > 0
      ? envSpecPath
      : join("libs", "sample", "contract", "openapi.json"))
  const openApiPath = resolveRepoPath(repoRoot, rawSpecPath)
  if (openApiPath === undefined) {
    return failResult(`ERROR: OpenAPI spec path '${rawSpecPath}' escapes repository root\n`)
  }

  const modExit = yield* Effect.exit(loadOpenApiModule(repoRoot, moduleFlag))
  const modResult = match(modExit)
    .with({ _tag: "Failure" }, ({ cause }) => ({
      ok: false as const,
      result: {
        exitCode: 1,
        stdout: "",
        stderr: `ERROR: Failed to load OpenAPI module: ${Cause.pretty(cause)}\n`,
      } satisfies CliResult,
    }))
    .with({ _tag: "Success" }, ({ value }) => ({ ok: true as const, value }))
    .exhaustive()
  if (!modResult.ok) {
    return modResult.result
  }

  const currentSpec = modResult.value.buildOpenApiSpec()
  const currentJson = `${JSON.stringify(currentSpec, null, 2)}\n`

  if (subArgs.includes("--write")) {
    nodeSyncHostIo.mkdirRecursiveSync(dirname(openApiPath))
    nodeSyncHostIo.writeTextSync(openApiPath, currentJson)
    return {
      exitCode: 0,
      stdout: "Successfully wrote openapi.json\n",
      stderr: "",
    }
  }

  if (!nodeSyncHostIo.existsSync(openApiPath)) {
    return failResult(
      "ERROR: openapi.json does not exist. Run `pnpm --filter @harness/sample-contract openapi:check -- --write` to generate it.\n",
    )
  }

  const committedJson = nodeSyncHostIo.readTextSync(openApiPath)
  const committedResult = decodeJsonResult(committedJson, "Failed to parse committed openapi.json")
  if (!committedResult.ok) {
    return committedResult.result
  }

  const baseline = resolveOpenApiBaseline(repoRoot, subArgs, committedJson)
  if (!baseline.ok) {
    return baseline.result
  }
  const baselineResult = decodeJsonResult(
    baseline.json,
    `Failed to parse baseline JSON from ${baseline.source}`,
  )
  if (!baselineResult.ok) {
    return baselineResult.result
  }

  const oasdiffFailure = runOasdiffIfAvailable(repoRoot, baseline.json, openApiPath)
  if (oasdiffFailure !== undefined) {
    return oasdiffFailure
  }

  const breakingChanges = modResult.value.detectOpenApiBreakingChanges(
    baselineResult.value,
    currentSpec,
  )
  if (breakingChanges.length > 0) {
    const formatted = breakingChanges.map((change) => ` - ${change}`).join("\n")
    return failResult(
      `openapi check: ESCALATE — breaking OpenAPI changes require human confirmation:\n${formatted}\n`,
      2,
    )
  }

  if (JSON.stringify(committedResult.value) !== JSON.stringify(currentSpec)) {
    return failResult(
      "ERROR: openapi.json is stale and does not match SampleApi.\nRun `pnpm --filter @harness/sample-contract openapi:check -- --write` to update it.\n",
    )
  }

  return yield* Effect.succeed({
    exitCode: 0,
    stdout: "OpenAPI check passed: openapi.json is fresh and backward-compatible.\n",
    stderr: "",
  })
})

const collectSqlFiles = (dir: string, prefix = ""): ReadonlyArray<string> => {
  if (!nodeSyncHostIo.isDirectorySync(dir)) {
    return []
  }
  const collected: Array<string> = []
  for (const entry of nodeSyncHostIo.readdirSync(dir)) {
    const relPath = prefix.length > 0 ? join(prefix, entry.name) : entry.name
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory) {
      collected.push(...collectSqlFiles(fullPath, relPath))
    } else {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        collected.push(relPath)
      }
    }
  }
  return collected.sort()
}

const MIGRATOR_KEY_RE = /^[1-9]\d*_[a-z0-9_]+$/

const findInvalidMigratorRecordKeys = (
  files: ReadonlyArray<{ readonly filePath: string; readonly content: string }>,
): ReadonlyArray<string> => {
  const errors: Array<string> = []
  const fromRecordRe = /\bfromRecord\s*(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g
  const keyRe = /^\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:/gm
  for (const file of files) {
    for (const block of file.content.matchAll(fromRecordRe)) {
      const body = block[1] ?? ""
      for (const km of body.matchAll(keyRe)) {
        const keyName = km[1] ?? km[2] ?? ""
        if (keyName.length > 0 && !MIGRATOR_KEY_RE.test(keyName)) {
          errors.push(
            `migration check: ESCALATE — [invalid-migrator-record-key] ${file.filePath}: invalid SqliteMigrator.fromRecord key '${keyName}' (must match /^[1-9]\\d*_[a-z0-9_]+$/)`,
          )
        }
      }
    }
  }
  return errors
}

/**
 * Typed `check-migrations` subcommand (zero Drizzle; native SQL + SqliteMigrator AST checks).
 */
export const runCheckMigrations = Effect.fn("HarnessCli.checkMigrations")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "check-migrations" ? args.slice(1) : args
  const repoRoot = resolveRepoRoot(options)
  const packageFlag = extractFlag(subArgs, "--package")
  const dirFlag = extractFlag(subArgs, "--dir")

  if (packageFlag !== undefined && dirFlag !== undefined) {
    return failResult("migration check: FAIL — cannot specify both --package and --dir\n")
  }

  let packageRoot: string | undefined
  let migrationsDir: string | undefined

  if (dirFlag !== undefined) {
    migrationsDir = resolveRepoPath(repoRoot, dirFlag)
    if (migrationsDir === undefined) {
      return failResult(`migration check: FAIL — migrations dir '${dirFlag}' escapes repository root\n`)
    }
  } else {
    const targetPkg = packageFlag ?? join("libs", "sample", "infra")
    packageRoot = resolveRepoPath(repoRoot, targetPkg)
    if (packageRoot === undefined) {
      return failResult(`migration check: FAIL — package path '${targetPkg}' escapes repository root\n`)
    }
    migrationsDir = resolveRepoPath(repoRoot, join(targetPkg, "migrations"))
    if (migrationsDir === undefined) {
      return failResult(
        `migration check: FAIL — migrations dir in '${targetPkg}' escapes repository root\n`,
      )
    }
  }

  let srcDir: string | undefined
  if (packageRoot !== undefined) {
    srcDir = resolveRepoPath(repoRoot, join(packageRoot, "src"))
    if (srcDir === undefined) {
      return failResult(`migration check: FAIL — package src dir escapes repository root\n`)
    }
  }
  const srcFiles: Array<{ readonly filePath: AstSourceFilePath; readonly content: AstSourceContent }> = []
  if (srcDir !== undefined && nodeSyncHostIo.isDirectorySync(srcDir)) {
    for (const absFile of collectWorkspaceTsFiles(srcDir, nodeSyncHostIo)) {
      const safeFile = resolveRepoPath(repoRoot, absFile)
      if (safeFile === undefined) {
        return failResult(`migration check: FAIL — source file '${absFile}' escapes repository root\n`)
      }
      srcFiles.push({
        filePath: AstSourceFilePath.make(relative(repoRoot, safeFile).replace(/\\/g, "/")),
        content: AstSourceContent.make(nodeSyncHostIo.readTextSync(safeFile)),
      })
    }
  }
  const hasSqliteMigrator = srcFiles.some((f) => f.content.includes("SqliteMigrator.fromRecord"))

  const hasMigrationsDir = nodeSyncHostIo.isDirectorySync(migrationsDir)
  const committedFiles = hasMigrationsDir ? collectSqlFiles(migrationsDir) : []

  if (committedFiles.length === 0 && !hasSqliteMigrator) {
    return failResult(
      `migration check: FAIL — no committed .sql migrations in '${relative(repoRoot, migrationsDir) || migrationsDir}' and no SqliteMigrator.fromRecord found\n`,
    )
  }

  if (committedFiles.length > 0) {
    const committedSqlFiles: Array<{ readonly file: string; readonly sql: string }> = []
    for (const file of committedFiles) {
      const absSql = join(migrationsDir, file)
      const safeSql = resolveRepoPath(repoRoot, absSql)
      if (safeSql === undefined) {
        return failResult(`migration check: FAIL — SQL file '${file}' escapes repository root\n`)
      }
      committedSqlFiles.push({ file, sql: nodeSyncHostIo.readTextSync(safeSql) })
    }
    const committedReport = checkMigrationSqlSafety(committedSqlFiles)
    if (committedReport.requiresEscalation) {
      const stderr = `${committedReport.violations
        .map((v) => `migration check: ESCALATE — ${v.message} (${v.file}):\n${v.statement}`)
        .join("\n")}\n`
      return { exitCode: 2, stdout: "", stderr }
    }
  }

  if (srcFiles.length > 0) {
    const invalidKeyMessages = findInvalidMigratorRecordKeys(srcFiles)
    if (invalidKeyMessages.length > 0) {
      return { exitCode: 2, stdout: "", stderr: `${invalidKeyMessages.join("\n")}\n` }
    }
    const astReport = yield* AstGateCache.decide({
      files: srcFiles,
      ruleVersion: HARNESS_GATE_RULE_VERSION,
    })
    const migrationViolations = astReport.violations.filter(
      (v) =>
        v.rule === "unsafe-sql-migration" ||
        v.rule === "invalid-migrator-record-key" ||
        v.rule === "unmanaged-sql-ddl",
    )
    if (migrationViolations.length > 0) {
      const stderr = `${migrationViolations
        .map((v) => `migration check: ESCALATE — [${v.rule}] ${v.file}:${v.line}: ${v.message}`)
        .join("\n")}\n`
      return { exitCode: 2, stdout: "", stderr }
    }
  }

  return {
    exitCode: 0,
    stdout: "migration check: committed migrations are additive and safe\n",
    stderr: "",
  }
})

/**
 * Typed `check-event-schemas` subcommand.
 */
export const runCheckEventSchemas = Effect.fn("HarnessCli.checkEventSchemas")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "check-event-schemas" ? args.slice(1) : args
  const repoRoot = resolveRepoRoot(options)
  const snapshotFlag =
    extractFlag(subArgs, "--snapshot") ??
    extractFlag(subArgs, "--out") ??
    join("libs", "es", "core", "event-snapshots.json")
  const snapshotFilePath = resolveRepoPath(repoRoot, snapshotFlag)
  if (snapshotFilePath === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[check-event-schemas] Snapshot path '${snapshotFlag}' escapes repository root\n`,
    }
  }
  const moduleFlag = extractFlag(subArgs, "--module")
  const isUpdate = subArgs.includes("--update")

  const inner = Effect.gen(function* () {
    const eventMod = yield* loadEventModule(repoRoot, moduleFlag)
    const currentSnapshots = yield* eventMod.computeSnapshots

    const committedSnapshots = yield* Effect.gen(function* () {
      if (!nodeSyncHostIo.existsSync(snapshotFilePath)) {
        if (isUpdate) {
          return [] as ReadonlyArray<EventVersionSnapshotEntryType>
        }
        return yield* new RepoCheckCliError({
          message: `Snapshot file not found at ${snapshotFilePath}. Run with --update to generate.`,
        })
      }
      const raw = nodeSyncHostIo.readTextSync(snapshotFilePath)
      return yield* decodeSnapshotArray(raw, { onExcessProperty: "error" })
    })

    const input = new EventSchemaEvolutionInput({
      committedSnapshots,
      currentSnapshots,
      registeredUpcasters: eventMod.registeredUpcasters,
    })

    if (isUpdate) {
      const validatedSnapshots = yield* prepareUpdatedEventSnapshots(input)
      const serialized = `${JSON.stringify(validatedSnapshots, null, 2)}\n`
      nodeSyncHostIo.mkdirRecursiveSync(dirname(snapshotFilePath))
      nodeSyncHostIo.writeTextSync(snapshotFilePath, serialized)
      return {
        exitCode: 0,
        stdout: `[check-event-schemas] Updated ${snapshotFilePath} with ${validatedSnapshots.length} verified append-only event snapshots.\n`,
        stderr: "",
      } satisfies CliResult
    }

    const valid = yield* verifyCommittedSnapshotParity(input)
    return {
      exitCode: 0,
      stdout: `[check-event-schemas] Event schema evolution verified: ${valid.checkedEventCount} snapshots valid.\n`,
      stderr: "",
    } satisfies CliResult
  })

  const exit = yield* Effect.exit(inner)
  return match(exit)
    .with({ _tag: "Success" }, ({ value }) => value)
    .with({ _tag: "Failure" }, ({ cause }) => {
      const squashed = Cause.squash(cause)
      const isFrozenViolation = squashed instanceof FrozenEventSchemaViolationError
      return {
        exitCode: isFrozenViolation ? 2 : 1,
        stdout: "",
        stderr: `[check-event-schemas] Verification failed: ${squashed instanceof Error ? squashed.message : String(squashed)}\n`,
      }
    })
    .exhaustive()
})

export { runBenchmarkCompare } from "./benchmark-compare.js"
