import {
  diffHarnessGraphs,
  type HarnessGraph,
  verifySubgraphMonomorphism,
} from "@harness/graph"

export interface PlanImplDiffResult {
  readonly ok: boolean
  readonly monomorphic: boolean
  readonly reasons: ReadonlyArray<string>
}

export const formatEntityKey = (entityKey: string): string => {
  const colonIdx = entityKey.indexOf(":")
  if (colonIdx === -1) {
    return entityKey
  }
  const kind = entityKey.slice(0, colonIdx)
  const identifier = entityKey.slice(colonIdx + 1)
  return `${kind} "${identifier}"`
}

export const diffPlanAndImplGraphs = (
  planGraph: HarnessGraph,
  implGraph: HarnessGraph,
): PlanImplDiffResult => {
  const diff = diffHarnessGraphs(implGraph, planGraph)
  const mono = verifySubgraphMonomorphism(implGraph, planGraph)
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
  for (const layer of diff.missingLayers) {
    reasons.push(`Planned ServiceLayer '${layer}' is missing in implementation graph`)
  }
  for (const err of diff.missingErrors) {
    reasons.push(`Planned TaggedError '${err}' is missing in implementation graph`)
  }
  for (const edge of diff.missingEdges) {
    reasons.push(
      `Missing planned PlaysRole(${edge.role}) relation on ${formatEntityKey(edge.entityKey)} (${edge.relationId} -> ${edge.entityKey})`,
    )
  }

  return {
    ok: reasons.length === 0,
    monomorphic: mono.isMonomorphic && reasons.length === 0,
    reasons,
  }
}
