import { join } from "node:path"
import { Cause, Effect, Option } from "effect"
import * as Graph from "effect/Graph"
import { match, P } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { type GovernanceDocRef, IGNORED_ERRORS, loadGovernanceDocsChecked } from "@harness/gates"
import {
  BisectionProbeCount,
  checkEffectGraph,
  decideGraphProjection,
  decideGraphRewrite,
  extractWorkspaceTypeAwareGraph,
  getNodeKey,
  type HarnessGraph,
  makeOmnigraphSyncLayer,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
  VerificationStatus,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { buildWorkspaceFnIndex } from "@harness/ingest"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  formatSubprocessError,
  isIsolatedExternalWorkspace,
  recordTelemetry,
  resolveClusterRepoRoot,
  resolveNxAffectedArgs,
} from "./daemon-and-omnigraph.service.js"
import { formatPlanCheckCompactSummary } from "./declarative-cli-extra.js"
import { runOfflineOmnigraphLintGate } from "./omnigraph-auth-and-drift.js"
import {
  computeSyncEmbeddingsForGraph,
  toSyncEmbeddingOptions,
} from "./omnigraph-embedding-sync-helper.js"
import {
  checkPlanEarsConsistency,
  finalizeProjectionCliResult,
  formatProjectionError,
  matchesExactSpecToken,
} from "./plan-ears-and-overlays.js"
import {
  persistReusedPlanSnapshotIfSafe,
  tryLoadReusableVerifiedPlanSnapshot,
} from "./plan-snapshot-fastpath.js"

const checkDeadTaggedErrors = (
  graph: HarnessGraph,
  governanceDocs: ReadonlyArray<GovernanceDocRef>,
): CliResult | undefined => {
  let hasEffectFnNodes = false
  for (const [, node] of Graph.nodes(graph.graph)) {
    const isEffectFn = match(node)
      .with({ _tag: "EffectFn" }, () => true)
      .with(
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => false,
      )
      .exhaustive()
    if (isEffectFn) {
      hasEffectFnNodes = true
      break
    }
  }
  if (!hasEffectFnNodes) return undefined

  const failsWithErrorTags = new Set<string>()
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "EffectSignature" }, { _tag: "LayerFlow" }, (n) => {
        for (const errTag of n.emittedErrors ?? []) failsWithErrorTags.add(errTag)
      })
      .with({ _tag: "HttpEndpointTuple" }, (n) => {
        for (const errTag of n.errorTags) failsWithErrorTags.add(errTag)
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "TraceabilityTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  for (const [, edge] of Graph.edges(graph.graph)) {
    match<string>(edge.data.role)
      .with("fails-with", "endpoint-error", () => {
        const targetOpt = Graph.getNode(graph.graph, edge.target)
        match(targetOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            match(value)
              .with({ _tag: "TaggedError" }, (errNode) => {
                failsWithErrorTags.add(errNode.errorTag)
              })
              .with(
                { _tag: "EffectFn" },
                { _tag: "ServiceTag" },
                { _tag: "ServiceLayer" },
                { _tag: "SchemaDef" },
                { _tag: "VitestCase" },
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
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      })
      .otherwise(() => undefined)
  }
  const violations: Array<string> = []
  for (const doc of governanceDocs) {
    const isActive = match(doc.status)
      .with("accepted", "proposed", () => true)
      .with("draft", "deprecated", "superseded", () => false)
      .exhaustive()
    if (isActive) {
      for (const errName of doc.referencedErrors ?? []) {
        if (!failsWithErrorTags.has(errName) && !IGNORED_ERRORS.has(errName)) {
          violations.push(
            `[dead-tagged-error] Governance doc '${doc.id}' declares TaggedError '${errName}', which has 0 FailsWith edges in the plan graph`,
          )
        }
      }
    }
  }
  if (violations.length > 0) {
    return {
      exitCode: 1,
      stdout: JSON.stringify({ step: "type-graph-policy", valid: false, violations }, null, 2),
      stderr: "",
    }
  }
  return undefined
}

export const handlePlanCheck = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const checkedDocs =
      options?.governanceDocs !== undefined
        ? { docs: options.governanceDocs, findings: [] }
        : loadGovernanceDocsChecked(repoRoot, nodeSyncHostIo)
    if (checkedDocs.findings.length > 0) {
      const msg = checkedDocs.findings
        .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
        .join("\n")
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] plan-check:governance-docs\nUnreadable governance docs:\n${msg}`,
      }
    }
    const governanceDocs = checkedDocs.docs
    const graphOnly = argv.includes("--graph-only")

    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!graphOnly &&
        !isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        options?.skipBackgroundDaemons !== true)
    if (requireOllama && !(yield* ensureLocalOllamaReady())) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
      }
    }

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)
    if (fnIndex.duplicates.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Duplicate span names found: ${fnIndex.duplicates.join(", ")}`,
      }
    }
    const hasActiveStubs = Array.from(fnIndex.bySpanName.values()).some((fn) => fn.isStub)
    const reuseOutcome = yield* tryLoadReusableVerifiedPlanSnapshot(
      repoRoot,
      hasActiveStubs,
      nodeSyncHostIo,
    )

    type PlanGraphResolution =
      | { readonly _tag: "Resolved"; readonly graph: HarnessGraph; readonly reused: boolean }
      | { readonly _tag: "Failed"; readonly result: CliResult }

    const resolvedOutcome: PlanGraphResolution = yield* match(reuseOutcome)
      .with({ _tag: "Hit" }, ({ graph: reusedGraph }) =>
        Effect.succeed<PlanGraphResolution>({
          _tag: "Resolved",
          graph: reusedGraph,
          reused: true,
        }),
      )
      .with({ _tag: "Miss" }, () =>
        Effect.gen(function* () {
          if (
            !graphOnly &&
            !options?.skipSubprocessVerify &&
            nodeSyncHostIo.existsSync(join(repoRoot, "package.json"))
          ) {
            const nxArgs = resolveNxAffectedArgs(repoRoot, ["typecheck", "lint"])
            const subprocessErr = yield* Effect.try({
              try: () => {
                const res = nodeSyncHostIo.execFileSync("pnpm", nxArgs, {
                  cwd: repoRoot,
                  env: { ...process.env, HARNESS_PLAN_CHECK: "1", CI: "true" },
                })
                return match(res)
                  .with({ _tag: "Exited" }, (r) =>
                    r.exitCode === 0 ? null : formatSubprocessError(r),
                  )
                  .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, (r) =>
                    formatSubprocessError(r),
                  )
                  .exhaustive()
              },
              catch: (cause) => formatSubprocessError(cause),
            }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Plan check subprocess failed")))

            if (subprocessErr !== null) {
              return {
                _tag: "Failed" as const,
                result: {
                  exitCode: 1,
                  stdout: "",
                  stderr: `[GATE FAILURE] plan-check:subprocess\nHINT: Fix compilation or lint errors before plan graph generation.\n\nFAILED OUTPUT:\n${subprocessErr}`,
                },
              }
            }
          }
          const extracted = yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo)
          return { _tag: "Resolved" as const, graph: extracted, reused: false }
        }),
      )
      .exhaustive()

    return yield* match(resolvedOutcome)
      .with({ _tag: "Failed" }, ({ result }) => Effect.succeed(result))
      .with({ _tag: "Resolved" }, ({ graph, reused }) =>
        Effect.gen(function* () {
          const checkResult = checkEffectGraph(graph)
          if (!checkResult.ok) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: checkResult.violations
                .map((v) => `[${v.rule}] ${v.message} (${v.path.join(" -> ")})`)
                .join("\n"),
            }
          }

          const deadErrorResult = checkDeadTaggedErrors(graph, governanceDocs)
          if (deadErrorResult !== undefined) {
            return deadErrorResult
          }

          if (!graphOnly) {
            const omnigraphStartedAtMs = Date.now()
            const snapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
            const syncMode = reused
              ? ("reused" as const)
              : isIsolatedExternalWorkspace(repoRoot)
                ? ("isolated" as const)
                : ("omnigraph" as const)
            const syncFailResult = yield* match(syncMode)
              .with("reused", () =>
                Effect.sync((): CliResult | undefined => {
                  if (
                    isIsolatedExternalWorkspace(repoRoot) ||
                    nodeSyncHostIo.existsSync(snapshotPath)
                  ) {
                    const persistRes = persistReusedPlanSnapshotIfSafe(
                      repoRoot,
                      snapshotPath,
                      graph,
                      nodeSyncHostIo,
                    )
                    const persistErr = match(persistRes)
                      .with({ _tag: "Saved" }, () => undefined)
                      .with({ _tag: "Failed" }, ({ reason }) => ({
                        exitCode: 1,
                        stdout: "",
                        stderr: `[GATE FAILURE] plan-check:snapshot-write\n${reason}`,
                      }))
                      .exhaustive()
                    if (persistErr !== undefined) return persistErr
                  }
                  recordTelemetry(options, {
                    surface: "cli",
                    category: "graph_query",
                    toolName: "omnigraph:sync-plan",
                    outcome: "ok",
                    durationMs: Math.max(0, Date.now() - omnigraphStartedAtMs),
                    engineSource: "local",
                    detail: "reused-verified-snapshot",
                  })
                  return undefined
                }),
              )
              .with("isolated", () =>
                Effect.sync((): CliResult | undefined => {
                  saveGraphSnapshot(graph, snapshotPath, nodeSyncHostIo)
                  recordTelemetry(options, {
                    surface: "cli",
                    category: "graph_query",
                    toolName: "graph:snapshot-local",
                    outcome: "ok",
                    durationMs: Math.max(0, Date.now() - omnigraphStartedAtMs),
                    engineSource: "local",
                    detail: "skipped-isolated-workspace",
                  })
                  return undefined
                }),
              )
              .with("omnigraph", () =>
                Effect.gen(function* (): Effect.fn.Return<CliResult | undefined> {
                  const lintRes = yield* runOfflineOmnigraphLintGate(
                    resolveClusterRepoRoot(repoRoot),
                  )
                  if (!lintRes.ok) {
                    return {
                      exitCode: 1,
                      stdout: "",
                      stderr: `[GATE FAILURE] plan-check:omnigraph-lint\n${lintRes.message}`,
                    }
                  }
                  const omnigraphReady = yield* ensureLocalOmnigraphReady(repoRoot)
                  if (!omnigraphReady) {
                    return {
                      exitCode: 1,
                      stdout: "",
                      stderr:
                        "[GATE FAILURE] plan-check:omnigraph-ready\nOmnigraph server is not ready",
                    }
                  }
                  const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
                  const embeddingResult = yield* computeSyncEmbeddingsForGraph(
                    repoRoot,
                    graph,
                    options,
                  )
                  const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
                    repoRoot: resolveClusterRepoRoot(repoRoot),
                    branch: taskBranches.planBranch,
                    from: taskBranches.mainBranch,
                    snapshotPath,
                    ...toSyncEmbeddingOptions(embeddingResult),
                  }).pipe(
                    Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
                    Effect.catchCause((cause) => {
                      if (isPureInterruptCause(cause)) return Effect.interrupt
                      return Effect.succeed({
                        syncedToOmnigraph: false,
                        snapshotPath,
                        error: Cause.pretty(cause),
                      })
                    }),
                  )
                  recordTelemetry(options, {
                    surface: "cli",
                    category: "graph_query",
                    toolName: "omnigraph:sync-plan",
                    outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
                    durationMs: Math.max(0, Date.now() - omnigraphStartedAtMs),
                    engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback",
                  })
                  if (!syncRes.syncedToOmnigraph) {
                    return {
                      exitCode: 1,
                      stdout: "",
                      stderr: `Plan check failed: could not sync plan graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
                    }
                  }
                  return undefined
                }),
              )
              .exhaustive()
            if (syncFailResult !== undefined) {
              return syncFailResult
            }
          }

          const earsErr = yield* checkPlanEarsConsistency(governanceDocs)
          const stubCount = Array.from(fnIndex.bySpanName.values()).filter((fn) => fn.isStub).length
          return match(earsErr)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => ({
              exitCode: 0,
              stdout: argv.includes("--mermaid")
                ? checkResult.mermaid
                : formatPlanCheckCompactSummary({
                    snapshotReused: reused,
                    nodeCount: Graph.nodeCount(graph.graph),
                    edgeCount: Graph.edgeCount(graph.graph),
                    stubCount,
                    mermaid: checkResult.mermaid,
                  }),
              stderr: "",
            }))
            .exhaustive()
        }),
      )
      .exhaustive()
  })

export const handlePlanSynth = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldWrite = argv.includes("--write")
    const verifyRoundTrip = shouldWrite || argv.includes("--verify")
    const specId = argv.slice(1).find((arg) => !arg.startsWith("--"))

    if (specId === undefined || specId.trim().length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "usage: harness plan-synth <spec-id> [--write] [--verify]",
      }
    }

    const graph =
      options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo))
    const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-plan")
    const selected =
      Option.getOrUndefined(rewriteOutcome.result.recommendedCandidate) ??
      rewriteOutcome.result.alternativeCandidates[0]
    const filteredPatches =
      selected !== undefined
        ? selected.patches.filter(
            (p) =>
              matchesExactSpecToken(p.description, specId) ||
              p.insertedEntityNodes.some((n) => matchesExactSpecToken(getNodeKey(n), specId)) ||
              p.insertedRoleEdges.some(
                (e) =>
                  matchesExactSpecToken(e.entityKey, specId) ||
                  matchesExactSpecToken(e.relationId, specId),
              ),
          )
        : []

    if (filteredPatches.length === 0) {
      const msg = `No plan-synth patches matched specification '${specId}'.`
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          specId,
          mode: "auto-plan",
          error: msg,
          patchCount: 0,
          operationCount: 0,
          overlayCount: 0,
          overlays: [],
          operations: [],
          verificationStatus: VerificationStatus.make("Unverified"),
          roundTripVerified: false,
          compilerDiagnostics: [],
          bisectionProbes: BisectionProbeCount.make(0),
          skippedRuleIds: [],
          written: false,
          writtenFiles: [],
        }),
        stderr: msg,
      }
    }

    const projection = yield* decideGraphProjection({
      patches: filteredPatches,
      targetGraph: rewriteOutcome.targetGraph,
      workspaceRoot: repoRoot,
      initialGraph: graph,
      verifyRoundTrip,
      hostIo: nodeSyncHostIo,
    })

    return yield* finalizeProjectionCliResult({
      repoRoot,
      shouldWrite,
      totalStepsApplied: selected?.patches.length ?? 0,
      patchCount: filteredPatches.length,
      extraFields: { specId, mode: "auto-plan" },
      projection,
    })
  }).pipe(
    Effect.catch((err: unknown) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: formatProjectionError(err),
      }),
    ),
  )

export const handleRepair = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldWrite = argv.includes("--write")
    const verifyRoundTrip = shouldWrite || argv.includes("--verify")
    let ruleFilter: string | undefined = undefined
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!
      const nextArg = argv[i + 1]
      const parsed = match(arg)
        .with(P.string.startsWith("--rule="), (a) => ({
          filter: a.slice("--rule=".length),
          advance: 0,
        }))
        .with("--rule", () =>
          nextArg !== undefined
            ? { filter: nextArg, advance: 1 }
            : { filter: undefined, advance: 0 },
        )
        .otherwise(() => ({ filter: undefined, advance: 0 }))
      if (parsed.filter !== undefined) {
        ruleFilter = parsed.filter
        i += parsed.advance
      }
    }

    const graph =
      options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo))
    const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-repair")
    const selected =
      Option.getOrUndefined(rewriteOutcome.result.recommendedCandidate) ??
      rewriteOutcome.result.alternativeCandidates[0]
    const filteredPatches =
      selected !== undefined
        ? ruleFilter !== undefined && ruleFilter.length > 0
          ? selected.patches.filter((p) => p.ruleId === ruleFilter)
          : selected.patches
        : []

    if (ruleFilter !== undefined && ruleFilter.length > 0 && filteredPatches.length === 0) {
      const msg = `No repair patches matched rule filter '${ruleFilter}'.`
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          mode: "auto-repair",
          ruleFilter,
          error: msg,
          patchCount: 0,
          operationCount: 0,
          overlayCount: 0,
          overlays: [],
          operations: [],
          verificationStatus: VerificationStatus.make("Unverified"),
          roundTripVerified: false,
          compilerDiagnostics: [],
          bisectionProbes: BisectionProbeCount.make(0),
          skippedRuleIds: [],
          written: false,
          writtenFiles: [],
        }),
        stderr: msg,
      }
    }

    const projection =
      selected !== undefined && filteredPatches.length > 0
        ? yield* decideGraphProjection({
            patches: filteredPatches,
            targetGraph: rewriteOutcome.targetGraph,
            workspaceRoot: repoRoot,
            initialGraph: graph,
            verifyRoundTrip,
            hostIo: nodeSyncHostIo,
          })
        : {
            operations: [],
            overlays: [],
            verificationStatus: VerificationStatus.make("Unverified"),
            roundTripVerified: false,
            compilerDiagnostics: [],
            bisectionProbes: BisectionProbeCount.make(0),
            skippedRuleIds: [],
          }

    return yield* finalizeProjectionCliResult({
      repoRoot,
      shouldWrite,
      totalStepsApplied: selected?.patches.length ?? 0,
      patchCount: filteredPatches.length,
      extraFields: { mode: "auto-repair", ruleFilter: ruleFilter ?? null },
      projection,
    })
  }).pipe(
    Effect.catch((err: unknown) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: formatProjectionError(err),
      }),
    ),
  )
