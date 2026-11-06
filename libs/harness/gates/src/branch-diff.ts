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
    reasons.push(
      `Missing planned PlaysRole(${edge.role}) edge: ${edge.relationId} -> ${edge.entityKey}`,
    )
  }

  return {
    ok: reasons.length === 0,
    reasons,
  }
}
