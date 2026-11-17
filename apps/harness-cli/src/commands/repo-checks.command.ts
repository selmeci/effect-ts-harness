import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { AstSourceContent, AstSourceFilePath, HARNESS_GATE_RULE_VERSION } from "@harness/contract"
import {
  EventSchemaEvolutionInput,
  type EventVersionSnapshotEntry as EventVersionSnapshotEntryType,
  EventVersionSnapshotEntry,
  type EventUpcasterLink,
  FrozenEventSchemaViolationError,
} from "@harness/es-contract"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "@harness/es-core"
import {
  analyzeSqliteMigratorFromRecordAst,
  AstGateCache,
  checkMigrationSqlSafety,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import { extractFlag, resolveRepoPathOrMessage } from "./repo-path.js"

const decodeUnknownJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))
const decodeSnapshotArray = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(EventVersionSnapshotEntry)),
)

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
  const res = resolveRepoPathOrMessage(repoRoot, moduleFlag, "Module path")
  if (!res.ok) {
    return Effect.fail(new RepoCheckCliError({ message: res.message }))
  }
  return Effect.succeed(pathToFileURL(res.resolvedPath).href)
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
    const resolved = resolveRepoPathOrMessage(repoRoot, cliBaselinePath, "OpenAPI baseline path")
    if (!resolved.ok) {
      return { ok: false, result: failResult(`ERROR: ${resolved.message}\n`) }
    }
    if (nodeSyncHostIo.existsSync(resolved.resolvedPath)) {
      return { ok: true, json: nodeSyncHostIo.readTextSync(resolved.resolvedPath), source: `file:${cliBaselinePath}` }
    }
  }

  const envBaselinePath = process.env.OPENAPI_BASELINE_PATH
  if (envBaselinePath !== undefined && envBaselinePath.length > 0) {
    const resolvedEnv = resolveRepoPathOrMessage(repoRoot, envBaselinePath, "OPENAPI_BASELINE_PATH")
    if (!resolvedEnv.ok) {
      return { ok: false, result: failResult(`ERROR: ${resolvedEnv.message}\n`) }
    }
    if (nodeSyncHostIo.existsSync(resolvedEnv.resolvedPath)) {
      return { ok: true, json: nodeSyncHostIo.readTextSync(resolvedEnv.resolvedPath), source: `env:${envBaselinePath}` }
    }
  }

  for (const ref of ["main", "HEAD"] as const) {
    const gitRes = nodeSyncHostIo.execFileSync(
      "git",
      ["show", `${ref}:libs/sample/contract/openapi.json`],
      { cwd: repoRoot },
    )
    const ok = match(gitRes)
      .with({ _tag: "Exited" }, (e) => e.exitCode === 0 && e.stdout.trim().length > 0)
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
      .exhaustive()
    if (ok) {
      return { ok: true, json: gitRes.stdout, source: `git:${ref}` }
    }
  }

  return { ok: true, json: committedJson, source: "committed" }
}

const runOasdiffIfAvailable = (
  repoRoot: string,
  baselineJson: string,
  openApiPath: string,
): CliResult | undefined => {
  const versionCheck = nodeSyncHostIo.execFileSync("oasdiff", ["--version"], { cwd: repoRoot })
  const hasOasdiff = match(versionCheck)
    .with({ _tag: "Exited" }, (e) => e.exitCode === 0)
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
    .exhaustive()
  if (!hasOasdiff) {
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

  const diffFailed = match(diffResult)
    .with({ _tag: "Exited" }, (e) => e.exitCode !== 0)
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => true)
    .exhaustive()
  if (diffFailed) {
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
  const openApiPathRes = resolveRepoPathOrMessage(repoRoot, rawSpecPath, "OpenAPI spec path")
  if (!openApiPathRes.ok) {
    return failResult(`ERROR: ${openApiPathRes.message}\n`)
  }
  const openApiPath = openApiPathRes.resolvedPath

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

const collectPackageFiles = (
  dir: string,
  predicate: (name: string) => boolean,
  prefix = "",
): ReadonlyArray<string> => {
  if (!nodeSyncHostIo.isDirectorySync(dir)) return []
  const collected: Array<string> = []
  for (const entry of nodeSyncHostIo.readdirSync(dir)) {
    const relPath = prefix.length > 0 ? join(prefix, entry.name) : entry.name
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        collected.push(...collectPackageFiles(fullPath, predicate, relPath))
      }
      continue
    }
    if ((entry.isFile || nodeSyncHostIo.isSymbolicLinkSync(fullPath)) && predicate(entry.name)) {
      collected.push(relPath)
    }
  }
  return collected.sort()
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
    const dirRes = resolveRepoPathOrMessage(repoRoot, dirFlag, "migrations dir")
    if (!dirRes.ok) {
      return failResult(`migration check: FAIL — ${dirRes.message}\n`)
    }
    migrationsDir = dirRes.resolvedPath
  } else {
    const targetPkg = packageFlag ?? join("libs", "sample", "infra")
    const pkgRes = resolveRepoPathOrMessage(repoRoot, targetPkg, "package path")
    if (!pkgRes.ok) {
      return failResult(`migration check: FAIL — ${pkgRes.message}\n`)
    }
    packageRoot = pkgRes.resolvedPath
    const migRes = resolveRepoPathOrMessage(
      repoRoot,
      join(targetPkg, "migrations"),
      `migrations dir in '${targetPkg}'`,
    )
    if (!migRes.ok) {
      return failResult(`migration check: FAIL — ${migRes.message}\n`)
    }
    migrationsDir = migRes.resolvedPath
  }

  let srcDir: string | undefined
  if (packageRoot !== undefined) {
    const srcRes = resolveRepoPathOrMessage(repoRoot, join(packageRoot, "src"), "package src dir")
    if (!srcRes.ok) {
      return failResult(`migration check: FAIL — ${srcRes.message}\n`)
    }
    srcDir = srcRes.resolvedPath
  }
  const srcFiles: Array<{ readonly filePath: AstSourceFilePath; readonly content: AstSourceContent }> = []
  if (srcDir !== undefined && nodeSyncHostIo.isDirectorySync(srcDir)) {
    const tsFiles = collectPackageFiles(
      srcDir,
      (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts"),
    ).map((rel) => join(srcDir, rel))
    for (const absFile of tsFiles) {
      const safeRes = resolveRepoPathOrMessage(repoRoot, absFile, "source file")
      if (!safeRes.ok) {
        return failResult(`migration check: FAIL — ${safeRes.message}\n`)
      }
      const readRes = Result.try(() => nodeSyncHostIo.readTextSync(safeRes.resolvedPath))
      const readContent = match(readRes)
        .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, content: success }))
        .with({ _tag: "Failure" }, ({ failure }) => ({
          ok: false as const,
          error: `migration check: FAIL — unreadable source file '${safeRes.resolvedPath}': ${failure instanceof Error ? failure.message : String(failure)}\n`,
        }))
        .exhaustive()
      if (!readContent.ok) {
        return failResult(readContent.error)
      }
      srcFiles.push({
        filePath: AstSourceFilePath.make(relative(repoRoot, safeRes.resolvedPath).replace(/\\/g, "/")),
        content: AstSourceContent.make(readContent.content),
      })
    }
  }

  let totalFromRecordCalls = 0
  let totalCheckedKeys = 0
  const astMessages: Array<string> = []
  for (const file of srcFiles) {
    const analysis = analyzeSqliteMigratorFromRecordAst({
      filePath: file.filePath,
      content: file.content,
    })
    totalFromRecordCalls += analysis.fromRecordCallCount
    totalCheckedKeys += analysis.checkedKeyCount
    for (const issue of analysis.keyIssues) {
      astMessages.push(
        `migration check: ESCALATE — [invalid-migrator-record-key] ${issue.filePath}:${issue.line}: ${issue.message}`,
      )
    }
    for (const issue of analysis.unsafeSqlIssues) {
      astMessages.push(
        `migration check: ESCALATE — [unsafe-sql-migration] ${issue.filePath}:${issue.line}: ${issue.message}`,
      )
    }
  }

  const hasMigrationsDir = nodeSyncHostIo.isDirectorySync(migrationsDir)
  const committedFiles = hasMigrationsDir
    ? collectPackageFiles(migrationsDir, (name) => name.endsWith(".sql"))
    : []

  if (committedFiles.length === 0 && totalCheckedKeys === 0) {
    return failResult(
      `migration check: FAIL — no committed .sql migrations in '${relative(repoRoot, migrationsDir) || migrationsDir}' and no SqliteMigrator.fromRecord records were found to validate (fromRecordCalls=${totalFromRecordCalls})\n`,
    )
  }

  if (committedFiles.length > 0) {
    const committedSqlFiles: Array<{ readonly file: string; readonly sql: string }> = []
    for (const file of committedFiles) {
      const absSql = join(migrationsDir, file)
      const safeRes = resolveRepoPathOrMessage(repoRoot, absSql, "SQL file")
      if (!safeRes.ok) {
        return failResult(`migration check: FAIL — ${safeRes.message}\n`)
      }
      const readRes = Result.try(() => nodeSyncHostIo.readTextSync(safeRes.resolvedPath))
      const readSql = match(readRes)
        .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, sql: success }))
        .with({ _tag: "Failure" }, ({ failure }) => ({
          ok: false as const,
          error: `migration check: FAIL — unreadable SQL file '${file}': ${failure instanceof Error ? failure.message : String(failure)}\n`,
        }))
        .exhaustive()
      if (!readSql.ok) {
        return failResult(readSql.error)
      }
      committedSqlFiles.push({ file, sql: readSql.sql })
    }
    const committedReport = checkMigrationSqlSafety(committedSqlFiles)
    if (committedReport.requiresEscalation) {
      const stderr = `${committedReport.violations
        .map((v) => `migration check: ESCALATE — ${v.message} (${v.file}):\n${v.statement}`)
        .join("\n")}\n`
      return { exitCode: 2, stdout: "", stderr }
    }
  }

  if (astMessages.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `${astMessages.join("\n")}\n` }
  }

  if (srcFiles.length > 0) {
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
  const snapshotFileRes = resolveRepoPathOrMessage(repoRoot, snapshotFlag, "Snapshot path")
  if (!snapshotFileRes.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[check-event-schemas] ${snapshotFileRes.message}\n`,
    }
  }
  const snapshotFilePath = snapshotFileRes.resolvedPath
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
      return { exitCode: 0, stdout: `[check-event-schemas] Updated ${snapshotFilePath} with ${validatedSnapshots.length} verified append-only event snapshots.\n`, stderr: "" } satisfies CliResult
    }
    const valid = yield* verifyCommittedSnapshotParity(input)
    return { exitCode: 0, stdout: `[check-event-schemas] Event schema evolution verified: ${valid.checkedEventCount} snapshots valid.\n`, stderr: "" } satisfies CliResult
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
