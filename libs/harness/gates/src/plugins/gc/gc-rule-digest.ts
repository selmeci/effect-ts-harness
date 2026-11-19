import { compareCodeUnits, GATE_RULE_SOURCE_FILES } from "@harness/contract"

export { GATE_RULE_SOURCE_FILES }

export const extractGateRuleIdsFromSources = (
  astVisitorsSource: string,
  selfDogfoodingSource: string,
  tierTopologySource: string,
  syntaxBansSource = "",
  gcHelpersSource = "",
): ReadonlyArray<string> => {
  const ids = new Set<string>()
  for (const m of astVisitorsSource.matchAll(/pushViolation\s*\(\s*[^,]+,\s*"([a-z0-9-]+)"/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of astVisitorsSource.matchAll(/GateRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of selfDogfoodingSource.matchAll(
    /SelfDogfoodingRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g,
  )) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of tierTopologySource.matchAll(
    /TierTopologyRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g,
  )) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of syntaxBansSource.matchAll(/["'`]\[([a-z][a-z0-9-]*(?:-[a-z0-9]+)+)\]/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  const gcKindBlock = /GcFindingKind\s*=\s*Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(gcHelpersSource)
  if (gcKindBlock !== null) {
    for (const m of gcKindBlock[1]!.matchAll(/"([a-z][a-z0-9-]*(?:-[a-z0-9]+)+)"/g)) {
      if (m[1] !== undefined) ids.add(m[1])
    }
  }
  return [...ids].sort(compareCodeUnits)
}
