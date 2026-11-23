import { join } from "node:path"
import { Effect, Graph, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  OmnigraphBranchName,
  OmnigraphDiagnosticCode,
  OmnigraphEntityId,
  type OmnigraphLintDiagnostic,
  type OmnigraphLintInput,
  OmnigraphLintStatus,
  OmnigraphTargetName,
  OmnigraphTypeName,
} from "@harness/contract"
import { decideOmnigraphLint } from "@harness/gates"
import {
  type HarnessGraph,
  type makeOmnigraphSyncLayer,
  OmnigraphSync,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { CliResult } from "./hook-format.js"
import { isIsolatedExternalWorkspace, resolveClusterRepoRoot } from "./repo-path.js"

const RawOmnigraphLintDiagnosticSchema = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  targetName: Schema.optional(Schema.NullOr(Schema.String)),
  target_name: Schema.optional(Schema.NullOr(Schema.String)),
  target: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.Literals(["error", "warning", "info"])),
})

const OmnigraphLintJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.optional(Schema.NullOr(Schema.String)),
    queries_processed: Schema.optional(Schema.NullOr(Schema.Finite)),
    findings: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
    diagnostics: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
  }),
)

export const resolveDefaultOmnigraphBin = (): string =>
  join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")

const runOmnigraphMaintenanceCommands = (
  clusterRootDir: string,
  omnigraphBin: string,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): void => {
  if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
    return
  }
  if (!nodeSyncHostIo.existsSync(omnigraphBin)) {
    process.stderr.write(
      `[harness:omnigraph] Warning: omnigraph binary not found at ${omnigraphBin}; skipping cluster optimize/cleanup\n`,
    )
    return
  }
  for (const args of commands) {
    const subcommand = args[0] ?? "optimize"
    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(omnigraphBin, [...args], { timeoutMs: 15_000 }),
    )
    match(execAttempt)
      .with({ _tag: "Failure" }, ({ failure }) => {
        process.stderr.write(
          `[harness:omnigraph] Warning: omnigraph ${subcommand} failed: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        )
      })
      .with({ _tag: "Success" }, ({ success: res }) => {
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
            const combined = stderr || stdout
            if (exitCode !== 0) {
              const msg = combined.includes("[state_lock_held]")
                ? `[harness:omnigraph] Info: skipped offline omnigraph ${subcommand} because cluster state lock is held by running omnigraph-server\n`
                : `[harness:omnigraph] Warning: omnigraph ${subcommand} exited ${exitCode}: ${combined}\n`
              process.stderr.write(msg)
            }
          })
          .with({ _tag: "TimedOut" }, ({ stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} timed out: ${stderr}\n`,
            )
          })
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} killed by ${signal}: ${stderr}\n`,
            )
          })
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} spawn failed: ${spawnError}\n`,
            )
          })
          .exhaustive()
      })
      .exhaustive()
  }
}

export const runOmnigraphRebuildFullTextIndexes = (
  clusterRootDir: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
  branches: ReadonlyArray<string> = ["main"],
): void => {
  const targetUri = `file://${clusterRootDir}`
  const seen = new Set<string>()
  const commands: Array<ReadonlyArray<string>> = []
  for (const branch of branches) {
    const trimmed = branch.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    commands.push([
      "rebuild-full-text-indexes",
      "--target",
      targetUri,
      "--graph",
      "harness",
      "--branch",
      trimmed,
    ])
  }
  if (commands.length === 0) {
    commands.push([
      "rebuild-full-text-indexes",
      "--target",
      targetUri,
      "--graph",
      "harness",
      "--branch",
      "main",
    ])
  }
  runOmnigraphMaintenanceCommands(clusterRootDir, omnigraphBin, commands)
}

export const runOmnigraphOptimizeAndCleanup = (
  clusterRootDir: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
  includeCleanup = true,
): void => {
  const targetUri = `file://${clusterRootDir}`
  const commands: ReadonlyArray<ReadonlyArray<string>> = includeCleanup
    ? [
        ["optimize", "--target", targetUri, "--graph", "harness"],
        ["cleanup", "--target", targetUri, "--graph", "harness", "--keep", "5", "--confirm"],
      ]
    : [["optimize", "--target", targetUri, "--graph", "harness"]]
  runOmnigraphMaintenanceCommands(clusterRootDir, omnigraphBin, commands)
}

export const findFirstVitestCaseId = (graph: HarnessGraph): string | undefined => {
  for (const [, node] of Graph.nodes(graph.graph)) {
    const found = match(node)
      .with({ _tag: "VitestCase" }, (vc) => vc.testId)
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

export const readExistingSpanTraceBlobIfSpansMissing = (
  repoRoot: string,
  clusterRepoRoot: string,
  branchName: string,
  graph: HarnessGraph,
  syncLayer: ReturnType<typeof makeOmnigraphSyncLayer>,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const spansPath = join(repoRoot, ".harness", "spans.jsonl")
    if (nodeSyncHostIo.existsSync(spansPath)) return undefined
    const firstTestId = findFirstVitestCaseId(graph)
    if (firstTestId === undefined) return undefined
    const ogSync = yield* OmnigraphSync.pipe(Effect.provide(syncLayer))
    const existing = yield* ogSync
      .getBlobText({
        repoRoot: clusterRepoRoot,
        entity: "node" as const,
        type: OmnigraphTypeName.make("VitestCase"),
        id: OmnigraphEntityId.make(firstTestId),
        property: "spanTraceBlob" as const,
        branch: OmnigraphBranchName.make(branchName),
      })
      .pipe(Effect.orElseSucceed(() => null))
    return typeof existing === "string" ? existing : undefined
  })

export const uploadAndVerifySpanTraceBlob = (
  repoRoot: string,
  clusterRepoRoot: string,
  branchName: string,
  graph: HarnessGraph,
  syncLayer: ReturnType<typeof makeOmnigraphSyncLayer>,
  phaseLabel: "verify" | "done",
  failExitCode: number,
  blockDecision?: string,
  fallbackBlobData?: string,
): Effect.Effect<
  | {
      readonly exitCode: number
      readonly stdout: string
      readonly stderr: string
    }
  | undefined
> =>
  Effect.gen(function* () {
    const spansPath = join(repoRoot, ".harness", "spans.jsonl")
    const hasSpansFile = nodeSyncHostIo.existsSync(spansPath)
    if (!hasSpansFile && fallbackBlobData === undefined) return undefined
    const firstTestId = findFirstVitestCaseId(graph)
    if (firstTestId === undefined) return undefined
    const makeFail = (reason: string) => ({
      exitCode: failExitCode,
      stdout:
        blockDecision !== undefined ? JSON.stringify({ decision: blockDecision, reason }) : "",
      stderr: `[GATE FAILURE] ${phaseLabel}:omnigraph-span-blob\n${reason}`,
    })
    const readOutcome = hasSpansFile
      ? match(Result.try(() => nodeSyncHostIo.readTextSync(spansPath)))
          .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, data: success }))
          .with({ _tag: "Failure" }, ({ failure }) => ({
            ok: false as const,
            reason: `Failed to read ${spansPath}: ${failure instanceof Error ? failure.message : String(failure)}`,
          }))
          .exhaustive()
      : { ok: true as const, data: fallbackBlobData ?? "" }
    if (!readOutcome.ok) return makeFail(readOutcome.reason)

    const blobSelector = {
      repoRoot: clusterRepoRoot,
      entity: "node" as const,
      type: OmnigraphTypeName.make("VitestCase"),
      id: OmnigraphEntityId.make(firstTestId),
      property: "spanTraceBlob" as const,
      branch: OmnigraphBranchName.make(branchName),
    }
    const ogSync = yield* OmnigraphSync.pipe(Effect.provide(syncLayer))
    const putOutcome = yield* ogSync.putBlob({ ...blobSelector, data: readOutcome.data }).pipe(
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((err) =>
        Effect.succeed({ ok: false as const, reason: `putBlob failed: ${String(err)}` }),
      ),
    )
    if (!putOutcome.ok) return makeFail(putOutcome.reason)

    const statOutcome = yield* ogSync.statBlob(blobSelector).pipe(
      Effect.map((stat) =>
        match(stat.status)
          .with(200, () => ({ ok: true as const }))
          .otherwise((status) => ({
            ok: false as const,
            reason: `statBlob returned status ${status}`,
          })),
      ),
      Effect.catch((err) =>
        Effect.succeed({ ok: false as const, reason: `statBlob failed: ${String(err)}` }),
      ),
    )
    return statOutcome.ok ? undefined : makeFail(statOutcome.reason)
  })

export type OfflineOmnigraphLintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

const lintOmnigraphSchemaAndQueryPair = (
  repoRoot: string,
  omnigraphBin: string,
  schemaPath: string,
  queryPath: string,
): Effect.Effect<OfflineOmnigraphLintResult> =>
  Effect.gen(function* () {
    if (!nodeSyncHostIo.existsSync(schemaPath) || !nodeSyncHostIo.existsSync(queryPath)) {
      return {
        ok: false as const,
        message: `Missing Omnigraph schema (${schemaPath}) or query (${queryPath}) file; cannot run offline lint gate`,
      }
    }

    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(
        omnigraphBin,
        ["lint", "--schema", schemaPath, "--query", queryPath, "--json"],
        { cwd: repoRoot, timeoutMs: 15_000 },
      ),
    )

    const execOutcome = match(execAttempt)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "ExecError" as const,
        message: `omnigraph lint execution failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      }))
      .with({ _tag: "Success" }, ({ success: res }) =>
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => ({
            _tag: "Exited" as const,
            exitCode,
            stdout,
            stderr,
          }))
          .with({ _tag: "TimedOut" }, ({ stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint timed out: ${stderr}`,
          }))
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint killed by ${signal}: ${stderr}`,
          }))
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint spawn failed: ${spawnError}`,
          }))
          .exhaustive(),
      )
      .exhaustive()

    return yield* match(execOutcome)
      .with({ _tag: "ExecError" }, ({ message }) => Effect.succeed({ ok: false as const, message }))
      .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
        Effect.gen(function* () {
          const parsedOpt = Schema.decodeOption(OmnigraphLintJsonSchema)(stdout)
          const parsed = match(parsedOpt)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()

          if (parsed === undefined) {
            const detail = stderr.trim() || stdout.trim() || `exitCode=${exitCode}`
            return {
              ok: false as const,
              message: `omnigraph lint returned invalid JSON (${detail})`,
            }
          }

          const rawDiagnostics = parsed.findings ?? parsed.diagnostics ?? []
          const diagnostics: Array<OmnigraphLintDiagnostic> = rawDiagnostics.map((d) => {
            const rawCode = (d.code ?? "LINT_ERROR").trim() || "LINT_ERROR"
            const rawMsg =
              (d.message ?? "Omnigraph lint diagnostic").trim() || "Omnigraph lint diagnostic"
            const rawTarget = (d.targetName ?? d.target_name ?? d.target ?? null)?.trim() ?? null
            return {
              code: OmnigraphDiagnosticCode.make(rawCode),
              message: ErrorReasonMessage.make(rawMsg),
              targetName:
                rawTarget && rawTarget.length > 0 ? OmnigraphTargetName.make(rawTarget) : null,
              severity: d.severity ?? "error",
            }
          })

          const statusOk = match(
            Schema.decodeUnknownOption(OmnigraphLintStatus)(parsed.status?.trim()),
          )
            .with({ _tag: "Some" }, ({ value }) =>
              match(value)
                .with("ok", () => true)
                .with("error", () => false)
                .exhaustive(),
            )
            .with({ _tag: "None" }, () => false)
            .exhaustive()

          const lintInput: OmnigraphLintInput = {
            statusOk,
            queriesProcessed: NonNegativeCount.make(
              Math.max(0, Math.floor(parsed.queries_processed ?? 0)),
            ),
            diagnostics,
            policy: "fail-on-error",
          }

          const lintRes = yield* decideOmnigraphLint(lintInput).pipe(
            Effect.map((report) => ({ _tag: "Report" as const, report })),
            Effect.catchTag("OmnigraphLintError", (err) =>
              Effect.succeed({ _tag: "Err" as const, err }),
            ),
          )

          return match(lintRes)
            .with({ _tag: "Err" }, ({ err }) => ({
              ok: false as const,
              message: `omnigraph lint failed (${err.errorCount} errors): ${err.diagnosticsSummary}`,
            }))
            .with({ _tag: "Report" }, ({ report }) =>
              match(report)
                .with({ verdict: "violated" }, ({ violations }) => {
                  const summary = violations.map((v) => `[${v._tag}] ${v.message}`).join("; ")
                  return { ok: false as const, message: `omnigraph lint failed: ${summary}` }
                })
                .with({ verdict: "clean" }, () => {
                  if (exitCode !== 0) {
                    const detail = stderr.trim() || `exitCode=${exitCode}`
                    return { ok: false as const, message: `omnigraph lint exited with ${detail}` }
                  }
                  return { ok: true as const }
                })
                .exhaustive(),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  })

export const runOfflineOmnigraphLintGate = (
  repoRoot: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
): Effect.Effect<OfflineOmnigraphLintResult> =>
  Effect.gen(function* () {
    if (!nodeSyncHostIo.existsSync(omnigraphBin)) {
      return {
        ok: false as const,
        message: `omnigraph binary not found at ${omnigraphBin}; cannot run offline lint gate`,
      }
    }
    const graphDir = join(repoRoot, "libs", "harness", "graph")
    const primaryRes = yield* lintOmnigraphSchemaAndQueryPair(
      repoRoot,
      omnigraphBin,
      join(graphDir, "schema.pg"),
      join(graphDir, "queries", "harness.gq"),
    )
    if (!primaryRes.ok) {
      return primaryRes
    }
    const wfSchemaPath = join(graphDir, "workflows.schema.pg")
    const wfQueryPath = join(graphDir, "workflow-queries", "workflows.gq")
    if (nodeSyncHostIo.existsSync(wfSchemaPath) || nodeSyncHostIo.existsSync(wfQueryPath)) {
      return yield* lintOmnigraphSchemaAndQueryPair(
        repoRoot,
        omnigraphBin,
        wfSchemaPath,
        wfQueryPath,
      )
    }
    return primaryRes
  })

export const runVerifyOmnigraphLintCheck = (
  repoRoot: string,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    if (isIsolatedExternalWorkspace(repoRoot)) {
      return undefined
    }
    const lintRes = yield* runOfflineOmnigraphLintGate(resolveClusterRepoRoot(repoRoot))
    if (!lintRes.ok) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:omnigraph-lint\n${lintRes.message}`,
      }
    }
    return undefined
  })

/**
 * Runs offline Omnigraph storage maintenance (`optimize`, and optionally `cleanup`)
 * on the local cluster when not in an isolated external workspace.
 */
export const runOmnigraphMaintenance = (
  repoRoot: string,
  options?: { readonly includeCleanup?: boolean },
): void => {
  if (isIsolatedExternalWorkspace(repoRoot)) return
  const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
  const clusterDir = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo)
  if (nodeSyncHostIo.existsSync(clusterDir)) {
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    runOmnigraphRebuildFullTextIndexes(clusterDir, undefined, [
      taskBranches.mainBranch,
      taskBranches.implBranch,
      taskBranches.planBranch,
    ])
    runOmnigraphOptimizeAndCleanup(clusterDir, undefined, options?.includeCleanup ?? true)
  }
}
