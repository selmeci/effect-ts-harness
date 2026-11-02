import { diffHarnessGraphs, type HarnessGraph } from "@harness/graph"

export interface PlanImplDiffResult {
  readonly ok: boolean
  readonly reasons: ReadonlyArray<string>
}

export const diffPlanAndImplGraphs = (
  planGraph: HarnessGraph,
  implGraph: HarnessGraph,
): PlanImplDiffResult => {
  const diff = diffHarnessGraphs(implGraph, planGraph)
  const reasons: Array<string> = []

  for (const stub of diff.remainingStubs) {
    reasons.push(`Planned EffectFn ${stub} still has isStub: true`)
  }
  for (const fn of diff.missingFns) {
    reasons.push(`Missing planned EffectFn: ${fn}`)
  }
  for (const service of diff.missingServices) {
    reasons.push(`Missing planned Service: ${service}`)
  }
  for (const edge of diff.missingEdges) {
    if (edge._tag === "RequiresService") {
      reasons.push(`Missing planned RequiresService edge: ${edge.callerQualname} -> ${edge.tagId}`)
    } else if (edge._tag === "FailsWith") {
      reasons.push(`Missing planned FailsWith edge: ${edge.callerQualname} -> ${edge.errorTag}`)
    } else if (edge._tag === "SpecifiesSymbol") {
      reasons.push(`Missing planned SpecifiesSymbol edge: ${edge.specId} -> ${edge.targetKey}`)
    } else if (edge._tag === "GovernsSymbol") {
      reasons.push(`Missing planned GovernsSymbol edge: ${edge.adrId} -> ${edge.targetKey}`)
    } else {
      reasons.push(`Missing planned edge: ${edge._tag}`)
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  }
}
