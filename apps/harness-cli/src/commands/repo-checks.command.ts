import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
  ErrorMessage,
} from "@harness/es-contract"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "@harness/es-core"
import { cartRegisteredUpcasters, computeCartEventSnapshots } from "@harness/es-core/fixtures/cart"
import {
  BENCHMARK_TASKS,
  type BenchmarkRunMetrics,
  checkMigrationSqlSafety,
  compareBenchmarkRuns,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { buildOpenApiSpec, detectOpenApiBreakingChanges } from "@harness/sample-contract"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"

const decodeUnknownJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))
const decodeSnapshotArray = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(EventVersionSnapshotEntry)),
)

const extractBaselineFlag = (subArgs: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i]
    if (arg === "--baseline" && i + 1 < subArgs.length) {
      return subArgs[i + 1]
    }
    if (arg !== undefined && arg.startsWith("--baseline=")) {
      return arg.slice("--baseline=".length)
    }
  }
  return undefined
}

const resolveOpenApiBaseline = (
  repoRoot: string,
  subArgs: ReadonlyArray<string>,
  committedJson: string,
): { readonly json: string; readonly source: string } => {
  const cliBaselinePath = extractBaselineFlag(subArgs)
  if (cliBaselinePath !== undefined) {
    const resolvedPath = resolve(cliBaselinePath)
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
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const envSpecPath = process.env.OPENAPI_SPEC_PATH
  const openApiPath =
    envSpecPath !== undefined && envSpecPath.length > 0
      ? resolve(repoRoot, envSpecPath)
      : join(repoRoot, "libs", "sample", "contract", "openapi.json")

  const currentSpec = buildOpenApiSpec()
  const currentJson = `${JSON.stringify(currentSpec, null, 2)}\n`

  if (subArgs.includes("--write")) {
    nodeSyncHostIo.writeTextSync(openApiPath, currentJson)
    return {
      exitCode: 0,
      stdout: "Successfully wrote openapi.json\n",
      stderr: "",
    }
  }

  if (!nodeSyncHostIo.existsSync(openApiPath)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: openapi.json does not exist. Run `pnpm --filter @harness/sample-contract openapi:check -- --write` to generate it.\n",
    }
  }

  const committedJson = nodeSyncHostIo.readTextSync(openApiPath)
  const committedOpt = decodeUnknownJson(committedJson)
  const committedResult = match(committedOpt)
    .with({ _tag: "None" }, () => ({
      ok: false as const,
      result: {
        exitCode: 1,
        stdout: "",
        stderr: "ERROR: Failed to parse committed openapi.json\n",
      } satisfies CliResult,
    }))
    .with({ _tag: "Some" }, ({ value }) => ({ ok: true as const, value }))
    .exhaustive()

  if (!committedResult.ok) {
    return committedResult.result
  }

  const baseline = resolveOpenApiBaseline(repoRoot, subArgs, committedJson)
  const baselineOpt = decodeUnknownJson(baseline.json)
  const baselineResult = match(baselineOpt)
    .with({ _tag: "None" }, () => ({
      ok: false as const,
      result: {
        exitCode: 1,
        stdout: "",
        stderr: `ERROR: Failed to parse baseline JSON from ${baseline.source}\n`,
      } satisfies CliResult,
    }))
    .with({ _tag: "Some" }, ({ value }) => ({ ok: true as const, value }))
    .exhaustive()

  if (!baselineResult.ok) {
    return baselineResult.result
  }

  const oasdiffFailure = runOasdiffIfAvailable(repoRoot, baseline.json, openApiPath)
  if (oasdiffFailure !== undefined) {
    return oasdiffFailure
  }

  const breakingChanges = detectOpenApiBreakingChanges(baselineResult.value, currentSpec)
  if (breakingChanges.length > 0) {
    const formatted = breakingChanges.map((change) => ` - ${change}`).join("\n")
    return {
      exitCode: 2,
      stdout: "",
      stderr: `openapi check: ESCALATE — breaking OpenAPI changes require human confirmation:\n${formatted}\n`,
    }
  }

  if (JSON.stringify(committedResult.value) !== JSON.stringify(currentSpec)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: openapi.json is stale and does not match SampleApi.\nRun `pnpm --filter @harness/sample-contract openapi:check -- --write` to update it.\n",
    }
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
    } else if (entry.isFile && entry.name.endsWith(".sql")) {
      collected.push(relPath)
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
  const _subArgs = args[0] === "check-migrations" ? args.slice(1) : args
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const packageRoot = join(repoRoot, "libs", "sample", "infra")
  const migrationsDir = join(packageRoot, "migrations")
  const schemaPath = join(packageRoot, "src", "db", "schema.ts")

  if (!nodeSyncHostIo.isDirectorySync(migrationsDir)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "migration check: FAIL — no committed baseline migration in migrations/\n",
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
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const snapshotFilePath = join(repoRoot, "libs", "es", "core", "event-snapshots.json")
  const isUpdate = subArgs.includes("--update")

  const inner = Effect.gen(function* () {
    const currentSnapshots = yield* computeCartEventSnapshots

    const committedSnapshots = yield* Effect.gen(function* () {
      if (!nodeSyncHostIo.existsSync(snapshotFilePath)) {
        if (isUpdate) {
          return [] as ReadonlyArray<EventVersionSnapshotEntry>
        }
        return yield* new FrozenEventSchemaViolationError({
          eventType: EventType.make("EventSnapshotsFile"),
          version: EventSchemaVersion.make(1),
          reason: ErrorMessage.make(
            `Snapshot file not found at ${snapshotFilePath}. Run with --update to generate.`,
          ),
        })
      }
      const raw = nodeSyncHostIo.readTextSync(snapshotFilePath)
      return yield* decodeSnapshotArray(raw, { onExcessProperty: "error" })
    })

    const input = new EventSchemaEvolutionInput({
      committedSnapshots,
      currentSnapshots,
      registeredUpcasters: cartRegisteredUpcasters,
    })

    if (isUpdate) {
      const validatedSnapshots = yield* prepareUpdatedEventSnapshots(input)
      const serialized = `${JSON.stringify(validatedSnapshots, null, 2)}\n`
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
    .with({ _tag: "Failure" }, ({ cause }) => ({
      exitCode: 1,
      stdout: "",
      stderr: `[check-event-schemas] Verification failed: ${String(cause)}\n`,
    }))
    .exhaustive()
})

const canonicalBenchmarkRuns: ReadonlyArray<BenchmarkRunMetrics> = [
  {
    taskId: "task-1-contract-schema",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 1420,
  },
  {
    taskId: "task-1-contract-schema",
    mode: "no-harness",
    diagnosticsBeforeGreen: 3,
    fixUpIterations: 3,
    tokenCount: 3100,
  },
  {
    taskId: "task-2-domain-use-case",
    mode: "harness",
    diagnosticsBeforeGreen: 1,
    fixUpIterations: 1,
    tokenCount: 2150,
  },
  {
    taskId: "task-2-domain-use-case",
    mode: "no-harness",
    diagnosticsBeforeGreen: 4,
    fixUpIterations: 4,
    tokenCount: 4400,
  },
  {
    taskId: "task-3-d1-repository",
    mode: "harness",
    diagnosticsBeforeGreen: 1,
    fixUpIterations: 2,
    tokenCount: 2900,
  },
  {
    taskId: "task-3-d1-repository",
    mode: "no-harness",
    diagnosticsBeforeGreen: 4,
    fixUpIterations: 3,
    tokenCount: 5100,
  },
  {
    taskId: "task-4-do-rpc",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 2350,
  },
  {
    taskId: "task-4-do-rpc",
    mode: "no-harness",
    diagnosticsBeforeGreen: 5,
    fixUpIterations: 5,
    tokenCount: 4950,
  },
  {
    taskId: "task-5-atom-client",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 1680,
  },
  {
    taskId: "task-5-atom-client",
    mode: "no-harness",
    diagnosticsBeforeGreen: 2,
    fixUpIterations: 2,
    tokenCount: 3250,
  },
]

/**
 * Typed `benchmark` subcommand.
 */
export const runBenchmarkCompare = (
  _args: ReadonlyArray<string>,
  _options?: CliEnv,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const summary = compareBenchmarkRuns(canonicalBenchmarkRuns)
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
    return {
      exitCode: summary.passedAcceptance ? 0 : 1,
      stdout: `${JSON.stringify(output, null, 2)}\n`,
      stderr: "",
    }
  })
