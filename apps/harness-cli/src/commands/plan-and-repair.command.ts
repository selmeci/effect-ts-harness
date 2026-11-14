import { join } from "node:path"
import { Effect, Option } from "effect"
import * as Graph from "effect/Graph"
import { match, P } from "ts-pattern"
import { loadGovernanceDocsFromDisk } from "@harness/gates"
import {
  BisectionProbeCount,
  checkEffectGraph,
  decideGraphProjection,
  decideGraphRewrite,
  extractWorkspaceTypeAwareGraph,
  getNodeKey,
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
import {
  checkPlanEarsConsistency,
  finalizeProjectionCliResult,
  formatProjectionError,
  matchesExactSpecToken,
} from "./plan-ears-and-overlays.js"

export const handlePlanCheck = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const governanceDocs =
      options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot, nodeSyncHostIo)
    const graphOnly = argv.includes("--graph-only")

    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!graphOnly &&
        !isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    if (requireOllama && !(yield* ensureLocalOllamaReady())) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
      }
    }

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
          return res.exitCode === 0 ? null : formatSubprocessError(res)
        },
        catch: (cause) => formatSubprocessError(cause),
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Plan check subprocess failed")))

      if (subprocessErr !== null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] plan-check:subprocess\nHINT: Fix compilation or lint errors before plan graph generation.\n\nFAILED OUTPUT:\n${subprocessErr}`,
        }
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

    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo)
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
    if (hasEffectFnNodes) {
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
          .with("deprecated", "superseded", () => false)
          .exhaustive()
        if (isActive) {
          for (const errName of doc.referencedErrors ?? []) {
            if (!failsWithErrorTags.has(errName)) {
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
    }

    if (!graphOnly) {
      const snapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      if (isIsolatedExternalWorkspace(repoRoot)) {
        saveGraphSnapshot(graph, snapshotPath, nodeSyncHostIo)
        recordTelemetry(options, {
          surface: "cli",
          category: "graph_query",
          toolName: "omnigraph:sync-plan",
          outcome: "ok",
          durationMs: 1,
          engineSource: "local",
        })
      } else {
        yield* ensureLocalOmnigraphReady(repoRoot)
        const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
        const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
          repoRoot: resolveClusterRepoRoot(repoRoot),
          branch: taskBranches.planBranch,
          from: taskBranches.mainBranch,
          snapshotPath,
        }).pipe(
          Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
          Effect.orElseSucceed(() => ({
            syncedToOmnigraph: false,
            snapshotPath,
            error: undefined,
          })),
        )
        recordTelemetry(options, {
          surface: "cli",
          category: "graph_query",
          toolName: "omnigraph:sync-plan",
          outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
          durationMs: 1,
          engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback",
        })
        if (!syncRes.syncedToOmnigraph) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Plan check failed: could not sync plan graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
          }
        }
      }
    }

    const earsErr = yield* checkPlanEarsConsistency(governanceDocs)
    return match(earsErr)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => ({ exitCode: 0, stdout: checkResult.mermaid, stderr: "" }))
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
          nextArg !== undefined ? { filter: nextArg, advance: 1 } : { filter: undefined, advance: 0 },
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
