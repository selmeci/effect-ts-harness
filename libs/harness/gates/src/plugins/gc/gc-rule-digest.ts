import { join } from "node:path"
import { computeContentSha256, HARNESS_GATE_RULE_VERSION } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { type GcFinding, readTextOrReport } from "./gc-helpers.js"

export const GATE_RULE_SOURCE_FILES = [
  "libs/harness/gates/src/plugins/ast-gate-visitors.ts",
  "libs/harness/gates/src/plugins/self-dogfooding-plugin.ts",
  "libs/harness/gates/src/plugins/harness-tier-topology.ts",
  "libs/harness/gates/src/plugins/sqlite-migrator-ast.ts",
  "tools/oxlint/syntax-bans.js",
  "libs/harness/gates/src/plugins/ast-gate-law-helpers.ts",
  "libs/harness/contract/src/ast-and-gate-primitives.ts",
  "libs/harness/gates/src/plugins/gc/gc-workspace-io.ts",
] as const

export const EXPECTED_GATE_RULE_VERSION_DIGEST =
  "bcc113dbb2d99cd6675466f204d65a881a9bd50ba4c817e4341314c108fb9e85"

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
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export const computeGateRuleVersionDigest = (sources: ReadonlyArray<string>): string => {
  const sortedRuleIds = extractGateRuleIdsFromSources(
    sources[0] ?? "",
    sources[1] ?? "",
    sources[2] ?? "",
    sources[4] ?? "",
    sources[7] ?? "",
  )
  const sourceHashes = sources.map((s) => computeContentSha256(s)).join(",")
  return computeContentSha256(
    `${HARNESS_GATE_RULE_VERSION}:${sortedRuleIds.join(",")}:${sourceHashes}`,
  )
}

export const evaluateGateRuleDigestCheck = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const gateRuleAbsPaths = GATE_RULE_SOURCE_FILES.map((rel) => join(repoRoot, rel))
  const someExist = gateRuleAbsPaths.some((p) => hostIo.existsSync(p))
  const allExist = gateRuleAbsPaths.every((p) => hostIo.existsSync(p))
  if (someExist && !allExist) {
    const missing = GATE_RULE_SOURCE_FILES.filter((rel) => !hostIo.existsSync(join(repoRoot, rel)))
    findings.push({
      kind: "stale-gate-rule-version",
      nodeId: "HARNESS_GATE_RULE_VERSION",
      location: "libs/harness/gates/src/plugins/gc/gc-rule-digest.ts",
      message: `Missing gate rule source file(s) required for digest verification: ${missing.join(", ")}.`,
      action: `Restore missing gate rule source file(s) (${missing.join(", ")}) or update GATE_RULE_SOURCE_FILES.`,
    })
    return
  }
  if (!allExist) return

  const gateRuleSources: Array<string> = []
  let allReadable = true
  for (const absPath of gateRuleAbsPaths) {
    const src = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (src === undefined) {
      allReadable = false
      break
    }
    gateRuleSources.push(src)
  }
  if (allReadable) {
    const actualDigest = computeGateRuleVersionDigest(gateRuleSources)
    if (actualDigest !== EXPECTED_GATE_RULE_VERSION_DIGEST) {
      findings.push({
        kind: "stale-gate-rule-version",
        nodeId: "HARNESS_GATE_RULE_VERSION",
        location: "libs/harness/gates/src/plugins/gc/gc-rule-digest.ts",
        message: `Gate rule IDs or gate source files changed without bumping HARNESS_GATE_RULE_VERSION / EXPECTED_GATE_RULE_VERSION_DIGEST (expected ${EXPECTED_GATE_RULE_VERSION_DIGEST}, got ${actualDigest}).`,
        action: `Bump HARNESS_GATE_RULE_VERSION in @harness/contract and update EXPECTED_GATE_RULE_VERSION_DIGEST to "${actualDigest}".`,
      })
    }
  }
}
