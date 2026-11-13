import { Effect, Option } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { decideGraphInference } from "./datalog-engine.js"
import {
  CandidateRank, type DpoCandidatePriors, type GraphInferenceResult, type GraphPatch,
  GraphRewriteError, type GraphRewriteOutcome, type HarnessGraph,
  type RewriteCandidate, type RewriteMode, type SystemOneScoreMillis,
} from "./model.js"
import {
  type DecideGraphRewriteOptions, applyDpoPatchToGraph, computeGraphMeasure, getPhasesForMode,
  isEqualMeasure, isStrictlyDecreasingMeasure, isZeroMeasure, mapInferenceErrorToRewriteError,
  scoreDraftPatch,
} from "./rewrite/dpo-algebra-core.js"
import { findPhase1PlanPatches } from "./rewrite/plan-rules.plugin.js"
import {
  evaluateAndSelectArchRepairBranch, findPhase2ArchRepairBranches,
} from "./rewrite/repair-rules-arch.plugin.js"
import {
  findPhase3CodeRepairPatches, findPhase4CleanupPatches,
} from "./rewrite/repair-rules-code.plugin.js"

export * from "./rewrite/dpo-algebra-core.js"
export * from "./rewrite/plan-rules.plugin.js"
export * from "./rewrite/repair-rules-arch.plugin.js"
export * from "./rewrite/repair-rules-code.plugin.js"

/**
 * Pure Double-Pushout (DPO) Algebraic Graph Rewriting Decider (`GraphRewrite.decide`, `R = never`).
 */
export const decideGraphRewrite = Effect.fn("GraphRewrite.decide")(function* (
  graph: HarnessGraph,
  mode: RewriteMode,
  candidatePriors?: DpoCandidatePriors,
  options?: DecideGraphRewriteOptions,
): Effect.fn.Return<GraphRewriteOutcome, GraphRewriteError, never> {
  const initialInference = yield* decideGraphInference(graph).pipe(
    Effect.mapError((err) => mapInferenceErrorToRewriteError(err)),
  )
  const initialMeasure = computeGraphMeasure(graph, initialInference)
  const activePhases = getPhasesForMode(mode)

  let currentGraph = graph
  let currentInference: GraphInferenceResult = initialInference
  let currentMeasure = initialMeasure
  const appliedPatches: Array<GraphPatch> = []
  const alternativeCandidates: Array<RewriteCandidate> = []
  let branchWinnerScore: SystemOneScoreMillis | undefined
  const maxSteps =
    options?.maxPhaseSteps !== undefined && options.maxPhaseSteps >= 1
      ? Math.floor(options.maxPhaseSteps)
      : Math.max(64, Graph.nodeCount(graph.graph) * 4)

  for (const phase of activePhases) {
    let phaseSteps = 0
    let converged = false
    while (phaseSteps < maxSteps && !converged) {
      yield* match(phase)
        .with("PLAN", () =>
          Effect.gen(function* () {
            const planDrafts = findPhase1PlanPatches(currentGraph, currentInference)
            const draft = planDrafts[0]
            if (draft === undefined) { converged = true; return }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) => mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey)),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (
              nextMeasure.archViolations > currentMeasure.archViolations ||
              nextMeasure.codeHygieneViolations > currentMeasure.codeHygieneViolations
            ) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId, nodeKey: draft.primaryNodeKey, reason: "non-decreasing-measure",
                message: `Planning rule ${draft.ruleId} introduced new architectural or code hygiene violations.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({ ...cleanDraft, beforeMeasure: currentMeasure, afterMeasure: nextMeasure })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .with("REPAIR_ARCH", () =>
          Effect.gen(function* () {
            const branches = findPhase2ArchRepairBranches(currentGraph, currentInference)
            if (branches.length === 0) { converged = true; return }
            phaseSteps += 1

            const { winner, alternatives } = yield* evaluateAndSelectArchRepairBranch(
              branches, currentGraph, currentMeasure, candidatePriors,
            )

            if (alternatives.length > 0 || branchWinnerScore === undefined) {
              branchWinnerScore = winner.scoreMillis
            }
            for (const alt of alternatives) {
              const { clearViolationFilter: _ignoredAlt, ...cleanAltDraft } = alt.draft
              alternativeCandidates.push({
                rank: CandidateRank.make(alternativeCandidates.length + 2),
                rationale: `${alt.draft.description} (System One tie-breaker: ${alt.scoreMillis}/1000)`,
                patches: [...appliedPatches, { ...cleanAltDraft, beforeMeasure: currentMeasure, afterMeasure: alt.nextMeasure }],
                finalMeasure: alt.nextMeasure,
                systemOneTieBreaker: alt.scoreMillis,
                isPolicyClean: isZeroMeasure(alt.nextMeasure),
              })
            }

            const { clearViolationFilter: _ignoredWin, ...cleanWinnerDraft } = winner.draft
            appliedPatches.push({ ...cleanWinnerDraft, beforeMeasure: currentMeasure, afterMeasure: winner.nextMeasure })
            currentGraph = winner.nextGraph
            currentInference = winner.nextInference
            currentMeasure = winner.nextMeasure
          }),
        )
        .with("REPAIR_CODE", () =>
          Effect.gen(function* () {
            const codeDrafts = findPhase3CodeRepairPatches(currentGraph, currentInference)
            const draft = codeDrafts[0]
            if (draft === undefined) { converged = true; return }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) => mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey)),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (!isStrictlyDecreasingMeasure(currentMeasure, nextMeasure)) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId, nodeKey: draft.primaryNodeKey, reason: "non-decreasing-measure",
                message: `Rule ${draft.ruleId} failed to strictly decrease measure mu(G) in N^6.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({ ...cleanDraft, beforeMeasure: currentMeasure, afterMeasure: nextMeasure })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .with("CLEANUP", () =>
          Effect.gen(function* () {
            const cleanupDrafts = findPhase4CleanupPatches(currentGraph)
            const draft = cleanupDrafts[0]
            if (draft === undefined) { converged = true; return }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) => mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey)),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (!isStrictlyDecreasingMeasure(currentMeasure, nextMeasure) && !isEqualMeasure(currentMeasure, nextMeasure)) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId, nodeKey: draft.primaryNodeKey, reason: "non-decreasing-measure",
                message: `Cleanup rule ${draft.ruleId} increased measure mu(G) in N^6.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({ ...cleanDraft, beforeMeasure: currentMeasure, afterMeasure: nextMeasure })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .exhaustive()
    }
    if (!converged) {
      const remainingAtBound = match(phase)
        .with("PLAN", () => findPhase1PlanPatches(currentGraph, currentInference).length)
        .with("REPAIR_ARCH", () => findPhase2ArchRepairBranches(currentGraph, currentInference).length)
        .with("REPAIR_CODE", () => findPhase3CodeRepairPatches(currentGraph, currentInference).length)
        .with("CLEANUP", () => findPhase4CleanupPatches(currentGraph).length)
        .exhaustive()
      if (remainingAtBound > 0) {
        return yield* new GraphRewriteError({
          reason: "step-bound-exceeded",
          message: `Phase '${phase}' exceeded maximum step bound (${maxSteps}) without reaching a normal form.`,
        })
      }
    }
  }

  if (appliedPatches.length === 0) {
    return {
      result: { mode, initialMeasure, recommendedCandidate: Option.none(), alternativeCandidates: [] },
      targetGraph: currentGraph,
    }
  }

  const firstPatch = appliedPatches[0]!
  const primaryScore = branchWinnerScore ?? scoreDraftPatch(firstPatch, graph, candidatePriors)

  const recommended: RewriteCandidate = {
    rank: CandidateRank.make(1),
    rationale: `Applied ${appliedPatches.length} DPO rewrite step(s) (${appliedPatches.map((p) => p.ruleId).join(" -> ")}) reaching measure (${currentMeasure.archViolations}, ${currentMeasure.unmappedSpecSymbols}, ${currentMeasure.codeHygieneViolations}, ${currentMeasure.missingLayerProviders}, ${currentMeasure.untestedDomainSpans}, ${currentMeasure.unresolvedSuggestedEdges}).`,
    patches: appliedPatches,
    finalMeasure: currentMeasure,
    systemOneTieBreaker: primaryScore,
    isPolicyClean: isZeroMeasure(currentMeasure),
  }

  return {
    result: {
      mode,
      initialMeasure,
      recommendedCandidate: Option.some(recommended),
      alternativeCandidates,
    },
    targetGraph: currentGraph,
  }
})
