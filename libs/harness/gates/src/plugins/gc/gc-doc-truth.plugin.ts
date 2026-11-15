import { join, relative } from "node:path"
import { Schema } from "effect"
import { match } from "ts-pattern"
import {
  computeContentSha256,
  HARNESS_GATE_RULE_VERSION,
  SelfDogfoodingRuleId,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type GcFinding,
  GcFindingKind,
  type GraphEntropyInput,
  readdirOrReport,
  readTextOrReport,
} from "./gc-helpers.js"

const PkgNameOnlySchema = Schema.Struct({
  name: Schema.optional(Schema.String),
})
const decodePkgNameOnly = Schema.decodeUnknownOption(Schema.fromJsonString(PkgNameOnlySchema))

const HookLeafSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
})
const HookEntrySchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
  hooks: Schema.optional(Schema.Array(HookLeafSchema)),
})
const HooksContainerSchema = Schema.Struct({
  PreToolUse: Schema.optional(Schema.Array(HookEntrySchema)),
  Stop: Schema.optional(Schema.Array(HookEntrySchema)),
})
const HooksFileSchema = Schema.Struct({
  hooks: Schema.optional(HooksContainerSchema),
  "effect-harness": Schema.optional(HooksContainerSchema),
})
const decodeHooksFile = Schema.decodeUnknownOption(Schema.fromJsonString(HooksFileSchema))

export const GATE_RULE_SOURCE_FILES = [
  "libs/harness/gates/src/plugins/ast-gate-visitors.ts",
  "libs/harness/gates/src/plugins/self-dogfooding-plugin.ts",
  "libs/harness/gates/src/plugins/harness-tier-topology.ts",
  "libs/harness/gates/src/plugins/sqlite-migrator-ast.ts",
  "tools/oxlint/syntax-bans.js",
] as const

export const EXPECTED_GATE_RULE_VERSION_DIGEST =
  "1e64caddf4095a84d3a24fe464b8d9f08bca80fe47c61f08d555b2f0fd2758f6"

const VALID_HARNESS_OXLINT_RULES = new Set(["syntax-bans", "test-integrity"])
const NON_PACKAGE_HANDLES = new Set(["@harness/architecture"])

const collectMarkdownFilesRecursive = (
  dir: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): ReadonlyArray<string> => {
  if (!hostIo.existsSync(dir)) return []
  const entries = readdirOrReport(dir, hostIo, repoRoot, findings)
  if (entries === undefined) return []
  const out: Array<string> = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory) {
      out.push(...collectMarkdownFilesRecursive(full, hostIo, repoRoot, findings))
      continue
    }
    if (e.isFile && e.name.endsWith(".md")) {
      out.push(full)
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

const collectWorkspacePackageNames = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): ReadonlySet<string> => {
  const names = new Set<string>()
  const scanPkgJson = (pkgJsonPath: string): void => {
    if (!hostIo.existsSync(pkgJsonPath)) return
    const text = readTextOrReport(pkgJsonPath, hostIo, repoRoot, findings)
    if (text === undefined) return
    match(decodePkgNameOnly(text))
      .with({ _tag: "Some" }, ({ value }) => {
        if (value.name !== undefined && value.name.trim().length > 0) {
          names.add(value.name.trim())
        }
      })
      .with({ _tag: "None" }, () => {})
      .exhaustive()
  }

  scanPkgJson(join(repoRoot, "package.json"))
  const libsDir = join(repoRoot, "libs")
  if (hostIo.existsSync(libsDir)) {
    for (const scope of readdirOrReport(libsDir, hostIo, repoRoot, findings) ?? []) {
      if (!scope.isDirectory) continue
      const scopeDir = join(libsDir, scope.name)
      for (const tier of readdirOrReport(scopeDir, hostIo, repoRoot, findings) ?? []) {
        if (tier.isDirectory) scanPkgJson(join(scopeDir, tier.name, "package.json"))
      }
    }
  }
  const appsDir = join(repoRoot, "apps")
  if (hostIo.existsSync(appsDir)) {
    for (const app of readdirOrReport(appsDir, hostIo, repoRoot, findings) ?? []) {
      if (app.isDirectory) scanPkgJson(join(appsDir, app.name, "package.json"))
    }
  }
  return names
}

const collectDocTargetFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
  includeAgentPatterns: boolean,
): ReadonlyArray<string> => {
  const files: Array<string> = []
  for (const rel of ["README.md", "AGENTS.md", "docs/architecture-and-workflow.md"]) {
    const abs = join(repoRoot, rel)
    if (hostIo.existsSync(abs)) files.push(abs)
  }
  const rfcsDir = join(repoRoot, "docs/rfcs")
  if (hostIo.existsSync(rfcsDir)) {
    for (const e of readdirOrReport(rfcsDir, hostIo, repoRoot, findings) ?? []) {
      if (e.isFile && e.name.startsWith("0008-") && e.name.endsWith(".md")) {
        files.push(join(rfcsDir, e.name))
      }
    }
  }
  if (includeAgentPatterns) {
    const patternsDir = join(repoRoot, "agent-patterns")
    if (hostIo.existsSync(patternsDir)) {
      for (const e of readdirOrReport(patternsDir, hostIo, repoRoot, findings) ?? []) {
        if (e.isFile && e.name.endsWith(".md")) files.push(join(patternsDir, e.name))
      }
    }
  }
  files.push(...collectMarkdownFilesRecursive(join(repoRoot, "libs/harness/docs"), hostIo, repoRoot, findings))
  files.push(...collectMarkdownFilesRecursive(join(repoRoot, "libs/sample/docs"), hostIo, repoRoot, findings))
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

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
  for (const m of selfDogfoodingSource.matchAll(/SelfDogfoodingRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of tierTopologySource.matchAll(/TierTopologyRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g)) {
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

export const computeGateRuleVersionDigest = (
  sources: ReadonlyArray<string>,
): string => {
  const sortedRuleIds = extractGateRuleIdsFromSources(
    sources[0] ?? "",
    sources[1] ?? "",
    sources[2] ?? "",
    sources[4] ?? "",
  )
  const sourceHashes = sources.map((s) => computeContentSha256(s)).join(",")
  return computeContentSha256(`${HARNESS_GATE_RULE_VERSION}:${sortedRuleIds.join(",")}:${sourceHashes}`)
}

const collectKnownGateRuleIds = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): ReadonlySet<string> => {
  const known = new Set<string>([
    ...VALID_HARNESS_OXLINT_RULES,
    ...GcFindingKind.literals,
    ...SelfDogfoodingRuleId.literals,
  ])
  const readOptional = (relPath: string): string => {
    const absPath = join(repoRoot, relPath)
    if (!hostIo.existsSync(absPath)) return ""
    return readTextOrReport(absPath, hostIo, repoRoot, findings) ?? ""
  }
  const extracted = extractGateRuleIdsFromSources(
    readOptional(GATE_RULE_SOURCE_FILES[0]),
    readOptional(GATE_RULE_SOURCE_FILES[1]),
    readOptional(GATE_RULE_SOURCE_FILES[2]),
    readOptional(GATE_RULE_SOURCE_FILES[4]),
    readOptional("libs/harness/gates/src/plugins/gc/gc-helpers.ts"),
  )
  for (const id of extracted) known.add(id)
  return known
}

const checkHookTimeouts = (
  repoRoot: string,
  relPath: string,
  rootKey: "hooks" | "effect-harness",
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const absPath = join(repoRoot, relPath)
  if (!hostIo.existsSync(absPath)) return
  const text = readTextOrReport(absPath, hostIo, repoRoot, findings)
  if (text === undefined) return
  match(decodeHooksFile(text))
    .with({ _tag: "None" }, () => {
      findings.push({
        kind: "hook-timeout-parity",
        nodeId: relPath,
        location: relPath,
        message: `Hook config "${relPath}" is invalid JSON or failed schema validation.`,
        action: `Fix JSON syntax in "${relPath}".`,
      })
    })
    .with({ _tag: "Some" }, ({ value: parsed }) => {
      const container = rootKey === "hooks" ? parsed.hooks : parsed["effect-harness"]
      if (container === undefined) {
        findings.push({
          kind: "hook-timeout-parity",
          nodeId: relPath,
          location: relPath,
          message: `Hook config "${relPath}" is missing required "${rootKey}" container with PreToolUse and Stop hooks.`,
          action: `Add "${rootKey}" with PreToolUse and Stop command hooks (each with a positive numeric "timeout") in "${relPath}".`,
        })
        return
      }
      for (const hookEvent of ["PreToolUse", "Stop"] as const) {
        const entries = hookEvent === "PreToolUse" ? container.PreToolUse : container.Stop
        if (entries === undefined || entries.length === 0) {
          findings.push({
            kind: "hook-timeout-parity",
            nodeId: `${relPath}:${hookEvent}`,
            location: relPath,
            message: `Hook config "${relPath}" is missing required "${hookEvent}" hook entries — both PreToolUse and Stop hooks with positive timeouts are required.`,
            action: `Add non-empty "${hookEvent}" command hooks with positive numeric "timeout" in "${relPath}".`,
          })
          continue
        }
        for (const entry of entries) {
          const leafHooks = entry.hooks ?? [entry]
          for (const h of leafHooks) {
            if (h.type === "command" && (h.timeout === undefined || h.timeout <= 0)) {
              findings.push({
                kind: "hook-timeout-parity",
                nodeId: `${relPath}:${hookEvent}`,
                location: relPath,
                message: `Hook command in "${relPath}" (${hookEvent}) is missing a positive numeric "timeout" — all PreToolUse and Stop hooks require explicit timeouts.`,
                action: `Add a positive numeric "timeout" (e.g. 15 or 30) to the ${hookEvent} command hook in "${relPath}".`,
              })
            }
          }
        }
      }
    })
    .exhaustive()
}

export const evaluateDocTruthPlugin = (
  input: GraphEntropyInput,
): ReadonlyArray<GcFinding> => {
  if (input.workspaceRoot === undefined || input.hostIo === undefined) return []
  const repoRoot = input.workspaceRoot
  const hostIo = input.hostIo
  const findings: Array<GcFinding> = []

  const workspacePkgNames = collectWorkspacePackageNames(repoRoot, hostIo, findings)
  const docFilesWithPatterns = collectDocTargetFiles(repoRoot, hostIo, findings, true)
  const docFilesForPaths = new Set(docFilesWithPatterns)
  const knownGateRuleIds = collectKnownGateRuleIds(repoRoot, hostIo, findings)

  for (const absDoc of docFilesWithPatterns) {
    const relDoc = relative(repoRoot, absDoc).replace(/\\/g, "/")
    const content = readTextOrReport(absDoc, hostIo, repoRoot, findings)
    if (content === undefined) continue

    if (workspacePkgNames.size > 0) {
      const seenPkgs = new Set<string>()
      for (const m of content.matchAll(/@harness\/[a-z0-9-]+/g)) {
        const pkgName = m[0]
        const nextChar = content[m.index + pkgName.length]
        if (pkgName.endsWith("-") || nextChar === "*") continue
        if (
          !NON_PACKAGE_HANDLES.has(pkgName) &&
          !workspacePkgNames.has(pkgName) &&
          !seenPkgs.has(pkgName)
        ) {
          seenPkgs.add(pkgName)
          findings.push({
            kind: "doc-unknown-package-name",
            nodeId: `${relDoc}:${pkgName}`,
            location: relDoc,
            message: `Documentation "${relDoc}" references unknown workspace package "${pkgName}".`,
            action: `Update or remove "${pkgName}" in "${relDoc}".`,
          })
        }
      }
    }

    const seenRules = new Set<string>()
    for (const m of content.matchAll(/(?<![@./A-Za-z0-9_-])effect-harness\/[a-z0-9-]+/g)) {
      const ruleRef = m[0]
      if (!seenRules.has(ruleRef)) {
        seenRules.add(ruleRef)
        findings.push({
          kind: "doc-unknown-rule-id",
          nodeId: `${relDoc}:${ruleRef}`,
          location: relDoc,
          message: `Documentation "${relDoc}" references legacy rule prefix "${ruleRef}" — use "harness/syntax-bans" or "harness/test-integrity".`,
          action: `Replace "${ruleRef}" in "${relDoc}".`,
        })
      }
    }
    for (const m of content.matchAll(/(?<![@./A-Za-z0-9_-])harness\/([a-z0-9-]+)/g)) {
      const ruleName = m[1]!
      const fullRule = `harness/${ruleName}`
      if (!VALID_HARNESS_OXLINT_RULES.has(ruleName) && !seenRules.has(fullRule)) {
        seenRules.add(fullRule)
        findings.push({
          kind: "doc-unknown-rule-id",
          nodeId: `${relDoc}:${fullRule}`,
          location: relDoc,
          message: `Documentation "${relDoc}" references unknown oxlint rule "${fullRule}" (valid: harness/syntax-bans, harness/test-integrity).`,
          action: `Fix or remove "${fullRule}" in "${relDoc}".`,
        })
      }
    }

    let inRuleTable: "none" | "rule-id" | "rule-prose" = "none"
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (/^\|\s*Rule\s+ID\s*\|/i.test(trimmed)) {
        inRuleTable = "rule-id"
        continue
      }
      if (/^\|\s*Rule\s*\|/i.test(trimmed)) {
        inRuleTable = "rule-prose"
        continue
      }
      if (inRuleTable === "none") continue
      if (!trimmed.startsWith("|")) {
        inRuleTable = "none"
        continue
      }
      const firstPipe = trimmed.indexOf("|")
      const secondPipe = trimmed.indexOf("|", firstPipe + 1)
      if (secondPipe === -1) continue
      const col1 = trimmed.slice(firstPipe + 1, secondPipe).trim()
      if (/^[\s:-]+$/.test(col1)) continue
      const ruleMatches =
        inRuleTable === "rule-id"
          ? [...col1.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)]
          : [...col1.matchAll(/^`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`$/g)]
      for (const m of ruleMatches) {
        const ruleId = m[1]!
        if (!knownGateRuleIds.has(ruleId) && !seenRules.has(ruleId)) {
          seenRules.add(ruleId)
          findings.push({
            kind: "doc-unknown-rule-id",
            nodeId: `${relDoc}:${ruleId}`,
            location: relDoc,
            message: `Documentation "${relDoc}" rule table references unknown gate rule ID "${ruleId}".`,
            action: `Replace "${ruleId}" with a real gate rule ID or remove it from "${relDoc}".`,
          })
        }
      }
    }

    if (docFilesForPaths.has(absDoc)) {
      const seenPaths = new Set<string>()
      for (const m of content.matchAll(/`([^`\n]+)`/g)) {
        const raw = m[1]!.trim().replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "")
        if (raw.includes("*") || raw.includes("<") || raw.includes("{") || raw.includes("...")) continue
        if (!/^(?:libs|apps|tools|adapters)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|sql|md)$/.test(raw)) continue
        if (!seenPaths.has(raw) && !hostIo.existsSync(join(repoRoot, raw))) {
          seenPaths.add(raw)
          findings.push({
            kind: "doc-missing-file-path",
            nodeId: `${relDoc}:${raw}`,
            location: relDoc,
            message: `Documentation "${relDoc}" references non-existent file path "${raw}".`,
            action: `Update or remove stale path "${raw}" in "${relDoc}".`,
          })
        }
      }
    }
  }

  const agentsPath = join(repoRoot, "AGENTS.md")
  if (hostIo.existsSync(agentsPath)) {
    const agentsContent = readTextOrReport(agentsPath, hostIo, repoRoot, findings)
    if (agentsContent !== undefined) {
      const seenH2 = new Set<string>()
      for (const line of agentsContent.split(/\r?\n/)) {
        const h2 = /^##\s+(.+)$/.exec(line.trim())
        if (h2 !== null) {
          const heading = h2[1]!.trim()
          if (seenH2.has(heading)) {
            findings.push({
              kind: "agents-duplicate-section",
              nodeId: `AGENTS.md:${heading}`,
              location: "AGENTS.md",
              message: `AGENTS.md contains duplicate H2 section "## ${heading}".`,
              action: `Deduplicate "## ${heading}" in AGENTS.md.`,
            })
          }
          seenH2.add(heading)
        }
      }

      for (const adapterRel of [
        "adapters/antigravity/plugins/effect-harness/rules/AGENTS.md",
        "adapters/claude-code/rules/AGENTS.md",
      ]) {
        const adapterAbs = join(repoRoot, adapterRel)
        if (!hostIo.existsSync(adapterAbs)) continue
        const adapterContent = readTextOrReport(adapterAbs, hostIo, repoRoot, findings)
        if (adapterContent !== undefined && adapterContent !== agentsContent) {
          findings.push({
            kind: "adapter-rules-drift",
            nodeId: adapterRel,
            location: adapterRel,
            message: `Adapter rules file "${adapterRel}" has drifted from root AGENTS.md.`,
            action: `Sync "${adapterRel}" with root AGENTS.md.`,
          })
        }
      }
    }
  }

  checkHookTimeouts(repoRoot, "adapters/claude-code/hooks.json", "hooks", hostIo, findings)
  checkHookTimeouts(
    repoRoot,
    "adapters/antigravity/plugins/effect-harness/hooks.json",
    "effect-harness",
    hostIo,
    findings,
  )

  const gateRuleAbsPaths = GATE_RULE_SOURCE_FILES.map((rel) => join(repoRoot, rel))
  if (gateRuleAbsPaths.every((p) => hostIo.existsSync(p))) {
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
          location: "libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts",
          message: `Gate rule IDs or gate source files changed without bumping HARNESS_GATE_RULE_VERSION / EXPECTED_GATE_RULE_VERSION_DIGEST (expected ${EXPECTED_GATE_RULE_VERSION_DIGEST}, got ${actualDigest}).`,
          action: `Bump HARNESS_GATE_RULE_VERSION in @harness/contract and update EXPECTED_GATE_RULE_VERSION_DIGEST to "${actualDigest}".`,
        })
      }
    }
  }

  return findings
}
