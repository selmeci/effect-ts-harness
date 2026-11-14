import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EventSchemaEvolutionInput,
  type EventVersionSnapshotEntry as EventVersionSnapshotEntryType,
  EventVersionSnapshotEntry,
  type EventUpcasterLink,
  FrozenEventSchemaViolationError,
} from "@harness/es-contract"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "@harness/es-core"
import {
  BENCHMARK_TASKS,
  type BenchmarkRunMetrics,
  checkMigrationSqlSafety,
  compareBenchmarkRuns,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"

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

const isInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const rel = relative(resolve(rootDir), resolve(candidatePath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const resolveRepoPath = (repoRoot: string, targetPath: string): string | undefined => {
  const resolved = resolve(repoRoot, targetPath)
  return isInsideRoot(repoRoot, resolved) ? resolved : undefined
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

const resolveOpenApiBaseline = (
  repoRoot: string,
  subArgs: ReadonlyArray<string>,
  committedJson: string,
): { readonly json: string; readonly source: string } => {
  const cliBaselinePath = extractFlag(subArgs, "--baseline")
  if (cliBaselinePath !== undefined) {
    const resolvedPath = resolve(repoRoot, cliBaselinePath)
    if (nodeSyncHostIo.existsSync(resolvedPath)) {
      return { json: nodeSyncHostIo.readTextSync(resolvedPath), source: `file:${cliBaselinePath}` }
    }
  }

  const envBaselinePath = process.env.OPENAPI_BASELINE_PATH
  if (envBaselinePath !== undefined && envBaselinePath.length > 0) {
    if (nodeSyncHostIo.existsSync(envBaselinePath)) {
      return { json: nodeSyncHostIo.readTextSync(envBaselinePath), source: `env:${envBaselinePath}` }
    }
  }

  const gitMain = nodeSyncHostIo.execFileSync(
    "git",
    ["show", "main:libs/sample/contract/openapi.json"],
    { cwd: repoRoot },
  )
  if (gitMain.exitCode === 0 && gitMain.stdout.trim().length > 0) {
    return { json: gitMain.stdout, source: "git:main" }
  }

  const gitHead = nodeSyncHostIo.execFileSync(
    "git",
    ["show", "HEAD:libs/sample/contract/openapi.json"],
    { cwd: repoRoot },
  )
  if (gitHead.exitCode === 0 && gitHead.stdout.trim().length > 0) {
    return { json: gitHead.stdout, source: "git:HEAD" }
  }

  return { json: committedJson, source: "committed" }
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

/**
 * Typed `check-migrations` subcommand.
 */
export const runCheckMigrations = Effect.fn("HarnessCli.checkMigrations")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "check-migrations" ? args.slice(1) : args
  const repoRoot = resolveRepoRoot(options)
  const packageFlag = extractFlag(subArgs, "--package") ?? join("libs", "sample", "infra")
  const packageRoot = resolveRepoPath(repoRoot, packageFlag)
  if (packageRoot === undefined) {
    return failResult(`migration check: FAIL — package path '${packageFlag}' escapes repository root\n`)
  }
  const migrationsDir = join(packageRoot, "migrations")
  const schemaPath = join(packageRoot, "src", "db", "schema.ts")

  if (!nodeSyncHostIo.isDirectorySync(migrationsDir)) {
    return failResult("migration check: FAIL — no committed baseline migration in migrations/\n")
  }

  const committedFiles = collectSqlFiles(migrationsDir)
  const committedSqlFiles = committedFiles.map((file) => ({
    file,
    sql: nodeSyncHostIo.readTextSync(join(migrationsDir, file)),
  }))
  const committedReport = checkMigrationSqlSafety(committedSqlFiles)
  if (committedReport.requiresEscalation) {
    const stderr = `${committedReport.violations
      .map((v) => `migration check: ESCALATE — ${v.message} (${v.file}):\n${v.statement}`)
      .join("\n")}\n`
    return { exitCode: 2, stdout: "", stderr }
  }

  if (!nodeSyncHostIo.existsSync(schemaPath)) {
    return {
      exitCode: 0,
      stdout: "migration check: committed migrations are additive and safe\n",
      stderr: "",
    }
  }

  const tempDir = nodeSyncHostIo.mkdtempSync("harness-migrations-")
  const runCheck = Effect.sync((): CliResult => {
    const outDir = join(tempDir, "migrations")
    nodeSyncHostIo.cpRecursiveSync(migrationsDir, outDir)
    const before = collectSqlFiles(outDir)

    const genResult = nodeSyncHostIo.execFileSync(
      "pnpm",
      [
        "exec",
        "drizzle-kit",
        "generate",
        "--dialect",
        "sqlite",
        "--schema",
        schemaPath,
        "--out",
        outDir,
        "--name",
        "drift",
      ],
      { cwd: packageRoot },
    )
    if (genResult.exitCode !== 0) {
      return {
        exitCode: genResult.exitCode,
        stdout: genResult.stdout,
        stderr: genResult.stderr || "migration check: drizzle-kit generate failed\n",
      }
    }

    const newFiles = collectSqlFiles(outDir).filter((file) => !before.includes(file))
    if (newFiles.length === 0) {
      return {
        exitCode: 0,
        stdout: "migration check: schema and committed migrations are in sync\n",
        stderr: "",
      }
    }

    const sqlFiles = newFiles.map((file) => ({
      file,
      sql: nodeSyncHostIo.readTextSync(join(outDir, file)),
    }))
    const report = checkMigrationSqlSafety(sqlFiles)
    if (report.requiresEscalation) {
      const stderr = `${report.violations
        .map((v) => `migration check: ESCALATE — ${v.message} (${v.file}):\n${v.statement}`)
        .join("\n")}\n`
      return { exitCode: 2, stdout: "", stderr }
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: `migration check: FAIL — schema changed without a committed migration:\n${newFiles.join("\n")}\n`,
    }
  })

  return yield* runCheck.pipe(
    Effect.ensuring(Effect.sync(() => nodeSyncHostIo.rmRecursiveSync(tempDir))),
  )
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

const BenchmarkRunMetricsSchema = Schema.Struct({
  taskId: Schema.String,
  mode: Schema.Literals(["harness", "no-harness"]),
  diagnosticsBeforeGreen: Schema.Finite,
  fixUpIterations: Schema.Finite,
  tokenCount: Schema.Finite,
})

const decodeBenchmarkRuns = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(BenchmarkRunMetricsSchema)),
)

const canonicalBenchmarkRuns: ReadonlyArray<BenchmarkRunMetrics> = [
  { taskId: "task-1-contract-schema", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 1420 },
  { taskId: "task-1-contract-schema", mode: "no-harness", diagnosticsBeforeGreen: 3, fixUpIterations: 3, tokenCount: 3100 },
  { taskId: "task-2-domain-use-case", mode: "harness", diagnosticsBeforeGreen: 1, fixUpIterations: 1, tokenCount: 2150 },
  { taskId: "task-2-domain-use-case", mode: "no-harness", diagnosticsBeforeGreen: 4, fixUpIterations: 4, tokenCount: 4400 },
  { taskId: "task-3-d1-repository", mode: "harness", diagnosticsBeforeGreen: 1, fixUpIterations: 2, tokenCount: 2900 },
  { taskId: "task-3-d1-repository", mode: "no-harness", diagnosticsBeforeGreen: 4, fixUpIterations: 3, tokenCount: 5100 },
  { taskId: "task-4-do-rpc", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 2350 },
  { taskId: "task-4-do-rpc", mode: "no-harness", diagnosticsBeforeGreen: 5, fixUpIterations: 5, tokenCount: 4950 },
  { taskId: "task-5-atom-client", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 1680 },
  { taskId: "task-5-atom-client", mode: "no-harness", diagnosticsBeforeGreen: 2, fixUpIterations: 2, tokenCount: 3250 },
]

/**
 * Typed `benchmark` subcommand.
 */
export const runBenchmarkCompare = Effect.fn("HarnessCli.benchmarkCompare")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "benchmark" ? args.slice(1) : args
  const repoRoot = resolveRepoRoot(options)
  const baselineFlag = extractFlag(subArgs, "--baseline")
  const outFlag = extractFlag(subArgs, "--out")

  let runs: ReadonlyArray<BenchmarkRunMetrics> = canonicalBenchmarkRuns
  if (baselineFlag !== undefined) {
    const baselinePath = resolveRepoPath(repoRoot, baselineFlag)
    if (baselinePath === undefined || !nodeSyncHostIo.existsSync(baselinePath)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `benchmark: FAIL — baseline file not found or escapes root: ${baselineFlag}\n`,
      }
    }
    const raw = nodeSyncHostIo.readTextSync(baselinePath)
    const parsedExit = yield* Effect.exit(decodeBenchmarkRuns(raw))
    const parsed = match(parsedExit)
      .with({ _tag: "Failure" }, ({ cause }) => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — invalid baseline JSON: ${Cause.pretty(cause)}\n`,
        } satisfies CliResult,
      }))
      .with({ _tag: "Success" }, ({ value }) => ({ ok: true as const, value }))
      .exhaustive()
    if (!parsed.ok) {
      return parsed.result
    }
    runs = parsed.value
  }

  const summary = compareBenchmarkRuns(runs)
  const output = {
    tasks: BENCHMARK_TASKS.map((task) => ({
      id: task.id,
      title: task.title,
      targetPackage: task.targetPackage,
      expectedPatternDoc: task.expectedPatternDoc,
    })),
    summary,
    passedAcceptance: summary.passedAcceptance,
  }
  const serialized = `${JSON.stringify(output, null, 2)}\n`

  if (outFlag !== undefined) {
    const outPath = resolveRepoPath(repoRoot, outFlag)
    if (outPath === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `benchmark: FAIL — output path escapes repository root: ${outFlag}\n`,
      }
    }
    nodeSyncHostIo.mkdirRecursiveSync(dirname(outPath))
    nodeSyncHostIo.writeTextSync(outPath, serialized)
  }

  return {
    exitCode: summary.passedAcceptance ? 0 : 1,
    stdout: serialized,
    stderr: "",
  }
})
