import { join, relative } from "node:path"
import { Schema } from "effect"
import { match } from "ts-pattern"
import { SelfDogfoodingRuleId } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type GcFinding,
  GcFindingKind,
  type GraphEntropyInput,
  collectMarkdownFilesRecursive,
  readdirOrReport,
  readTextOrReport,
} from "./gc-helpers.js"
import {
  DOC_TRUTH_RULE_ID_SOURCES,
  checkAstGateRuleClosure,
  extractGateRuleIdsFromSources,
} from "./gc-rule-ids.js"

export { extractGateRuleIdsFromSources }

const PkgManifestDepsSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const decodePkgManifestDeps = Schema.decodeUnknownOption(
  Schema.fromJsonString(PkgManifestDepsSchema),
)

const HookLeafSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
})
const HookEntrySchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
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

const VALID_HARNESS_OXLINT_RULES = new Set(["syntax-bans", "test-integrity"])
const NON_PACKAGE_HANDLES = new Set(["@harness/architecture"])

const collectWorkspacePackageDeps = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): {
  readonly names: ReadonlySet<string>
  readonly depsByPkg: ReadonlyMap<string, ReadonlySet<string>>
  readonly pkgByRelDir: ReadonlyMap<string, string>
} => {
  const names = new Set<string>()
  const depsByPkg = new Map<string, Set<string>>()
  const pkgByRelDir = new Map<string, string>()
  const scanPkgJson = (pkgJsonPath: string, relDir?: string): void => {
    if (!hostIo.existsSync(pkgJsonPath)) return
    const text = readTextOrReport(pkgJsonPath, hostIo, repoRoot, findings)
    if (text === undefined) return
    match(decodePkgManifestDeps(text))
      .with({ _tag: "Some" }, ({ value }) => {
        if (value.name !== undefined && value.name.trim().length > 0) {
          const pkgName = value.name.trim()
          names.add(pkgName)
          if (relDir !== undefined) {
            pkgByRelDir.set(relDir, pkgName)
          }
          const deps = new Set<string>([
            ...Object.keys(value.dependencies ?? {}),
            ...Object.keys(value.peerDependencies ?? {}),
            ...Object.keys(value.optionalDependencies ?? {}),
          ])
          depsByPkg.set(pkgName, deps)
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
        if (tier.isDirectory) {
          scanPkgJson(join(scopeDir, tier.name, "package.json"), `libs/${scope.name}/${tier.name}`)
        }
      }
    }
  }
  const appsDir = join(repoRoot, "apps")
  if (hostIo.existsSync(appsDir)) {
    for (const app of readdirOrReport(appsDir, hostIo, repoRoot, findings) ?? []) {
      if (app.isDirectory) {
        scanPkgJson(join(appsDir, app.name, "package.json"), `apps/${app.name}`)
      }
    }
  }
  return { names, depsByPkg, pkgByRelDir }
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
      if (e.isFile && e.name.startsWith("0009-") && e.name.endsWith(".md")) {
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
  files.push(
    ...collectMarkdownFilesRecursive(
      join(repoRoot, "libs/harness/docs"),
      hostIo,
      repoRoot,
      findings,
    ),
  )
  files.push(
    ...collectMarkdownFilesRecursive(
      join(repoRoot, "libs/sample/docs"),
      hostIo,
      repoRoot,
      findings,
    ),
  )
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
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
    readOptional(DOC_TRUTH_RULE_ID_SOURCES.astVisitors),
    readOptional(DOC_TRUTH_RULE_ID_SOURCES.selfDogfooding),
    readOptional(DOC_TRUTH_RULE_ID_SOURCES.tierTopology),
    readOptional(DOC_TRUTH_RULE_ID_SOURCES.syntaxBans),
    readOptional(DOC_TRUTH_RULE_ID_SOURCES.gcWorkspaceIo),
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
            if (h.type === "command" && h.command !== undefined) {
              const cmdMatch = /(?:index|hook-entry)\.ts\b[\s\S]*?\b(guard|done)\b/.exec(h.command)
              if (cmdMatch !== null) {
                const subcommand = cmdMatch[1]!
                const hasFailClosedExit = h.command.includes("||") && /\bexit\s+2\b/.test(h.command)
                const needsAntigravityDecision = h.command.includes("--format=antigravity")
                const expectedDecision = subcommand === "guard" ? "deny" : "continue"
                const hasDecisionJson =
                  !needsAntigravityDecision ||
                  new RegExp(`"decision"\\s*:\\s*"${expectedDecision}"`).test(h.command)
                if (!hasFailClosedExit || !hasDecisionJson) {
                  findings.push({
                    kind: "hook-bootstrap-fail-closed",
                    nodeId: `${relPath}:${hookEvent}`,
                    location: relPath,
                    message: `Hook command in "${relPath}" (${hookEvent}) invoking ${subcommand} must fail closed with "|| ... exit 2"${needsAntigravityDecision ? ` and emit fallback JSON with "decision":"${expectedDecision}"` : ""}.`,
                    action: `Wrap the ${hookEvent} command in "${relPath}" with a shell fallback that exits 2${needsAntigravityDecision ? ` and prints {"decision":"${expectedDecision}"} JSON` : ""}.`,
                  })
                }
              }
            }
          }
        }
      }
    })
    .exhaustive()
}

const checkSkillTierTables = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const adaptersDir = join(repoRoot, "adapters")
  const mdFiles = collectMarkdownFilesRecursive(adaptersDir, hostIo, repoRoot, findings)
  const tierRules: ReadonlyArray<{ readonly tier: string; readonly forbidden: RegExp }> = [
    { tier: "type:contract", forbidden: /(?:type:|`)(?:service|core|domain|infra|app)(?:`|\b)/ },
    { tier: "type:service", forbidden: /(?:type:|`)(?:core|domain|infra|app)(?:`|\b)/ },
    { tier: "type:core", forbidden: /(?:type:|`)(?:domain|infra|app)(?:`|\b)/ },
    { tier: "type:domain", forbidden: /(?:type:|`)(?:infra|app)(?:`|\b)/ },
    { tier: "type:infra", forbidden: /(?:type:|`)app(?:`|\b)/ },
    { tier: "scope:web", forbidden: /(?:type:|`)(?:service|core|domain|infra|app)(?:`|\b)/ },
  ]
  for (const absPath of mdFiles) {
    if (!absPath.endsWith("/SKILL.md") && !absPath.endsWith("\\SKILL.md")) continue
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    let tableHeaderParsed = false
    let tagColIdx = 0
    let allowedColIdx = 1
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("|")) {
        tableHeaderParsed = false
        tagColIdx = 0
        allowedColIdx = 1
        continue
      }
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
      if (cells.length < 2) continue
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue
      if (!tableHeaderParsed) {
        tableHeaderParsed = true
        const foundAllowed = cells.findIndex((c) =>
          /\b(?:allowed\s*imports|may\s*import)\b/i.test(c),
        )
        const foundTag = cells.findIndex((c) => /\b(?:tag|tier)\b/i.test(c))
        if (foundTag >= 0) tagColIdx = foundTag
        if (foundAllowed >= 0) allowedColIdx = foundAllowed
        continue
      }
      const tierCell = cells[tagColIdx] ?? ""
      const rawAllowedCell = cells[allowedColIdx] ?? ""
      const allowedCell = rawAllowedCell.replace(/\([^)]*\b(?:never|forbidden)\b[^)]*\)/gi, "")
      for (const rule of tierRules) {
        if (tierCell.includes(rule.tier) && rule.forbidden.test(allowedCell)) {
          findings.push({
            kind: "skill-tier-table-drift",
            nodeId: `${relPath}:${rule.tier}`,
            location: relPath,
            message: `Skill tier table in "${relPath}" lists forbidden dependency under "${rule.tier}" allowed column ("${rawAllowedCell}").`,
            action: `Update the "${rule.tier}" row in "${relPath}" to match AGENTS.md Nx taxonomy.`,
          })
        }
      }
    }
  }
}

const checkMermaidDependencyDrift = (
  repoRoot: string,
  hostIo: SyncHostIo,
  depsByPkg: ReadonlyMap<string, ReadonlySet<string>>,
  pkgByRelDir: ReadonlyMap<string, string>,
  findings: Array<GcFinding>,
): void => {
  const candidates: Array<string> = []
  for (const rel of ["README.md", "docs/architecture-and-workflow.md"]) {
    const abs = join(repoRoot, rel)
    if (hostIo.existsSync(abs)) candidates.push(abs)
  }
  const rfcsDir = join(repoRoot, "docs/rfcs")
  if (hostIo.existsSync(rfcsDir)) {
    for (const e of readdirOrReport(rfcsDir, hostIo, repoRoot, findings) ?? []) {
      if (e.isFile && e.name.startsWith("0009-") && e.name.endsWith(".md")) {
        candidates.push(join(rfcsDir, e.name))
      }
    }
  }
  for (const absPath of candidates) {
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    for (const blockMatch of content.matchAll(/```mermaid\s*\r?\n([\s\S]*?)```/g)) {
      const block = blockMatch[1] ?? ""
      if (!/\b(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/.test(block)) continue
      const nodeToPkg = new Map<string, string>()
      for (const nodeMatch of block.matchAll(
        /\b([A-Za-z0-9_]+)\s*(?:\["([^"]*)"\]|\(([^)]*)\)|\[([^\]]*)\])/g,
      )) {
        const nodeId = nodeMatch[1]!
        const label = nodeMatch[2] ?? nodeMatch[3] ?? nodeMatch[4] ?? ""
        const pkgMatch = /@harness\/[a-z0-9-]+/.exec(label)
        if (pkgMatch !== null) {
          nodeToPkg.set(nodeId, pkgMatch[0])
          continue
        }
        const relDirMatch = /\b((?:libs|apps)\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)\b/.exec(label)
        if (relDirMatch !== null) {
          const resolvedPkg = pkgByRelDir.get(relDirMatch[1]!)
          if (resolvedPkg !== undefined) {
            nodeToPkg.set(nodeId, resolvedPkg)
          }
        }
      }
      for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/;+$/, "")
        if (!/(?:-->|-\.->|==>)/.test(line)) continue
        const segments = line.split(/\s*(?:-->|-\.->|==>)(?:\|[^|]*\|)?\s*/)
        if (segments.length < 2) continue
        if (!segments.every((seg) => /^[A-Za-z0-9_]+(?:\s*&\s*[A-Za-z0-9_]+)*$/.test(seg.trim()))) {
          continue
        }
        for (let i = 0; i < segments.length - 1; i++) {
          const sources = segments[i]!.split("&").map((s) => s.trim())
          const targets = segments[i + 1]!.split("&").map((s) => s.trim())
          for (const srcId of sources) {
            const srcPkg = nodeToPkg.get(srcId)
            if (srcPkg === undefined) continue
            if (!depsByPkg.has(srcPkg)) continue
            const reachable = new Set<string>()
            const queue = [...(depsByPkg.get(srcPkg) ?? [])]
            while (queue.length > 0) {
              const dep = queue.shift()!
              if (reachable.has(dep)) continue
              reachable.add(dep)
              const transitive = depsByPkg.get(dep)
              if (transitive !== undefined) {
                for (const t of transitive) {
                  if (!reachable.has(t)) queue.push(t)
                }
              }
            }
            for (const dstId of targets) {
              const dstPkg = nodeToPkg.get(dstId)
              if (dstPkg === undefined || dstPkg === srcPkg) continue
              if (!reachable.has(dstPkg)) {
                findings.push({
                  kind: "mermaid-dependency-drift",
                  nodeId: `${relPath}:${srcPkg}->${dstPkg}`,
                  location: relPath,
                  message: `Mermaid flowchart in "${relPath}" draws edge "${srcPkg} --> ${dstPkg}", but "${srcPkg}" does not declare "${dstPkg}" in package.json.`,
                  action: `Remove or update the stale edge "${srcPkg} --> ${dstPkg}" in "${relPath}".`,
                })
              }
            }
          }
        }
      }
    }
  }
}

const checkDocBannedOrPhantomTech = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const phantomTargets: Array<string> = []
  for (const rel of ["README.md", "docs/architecture-and-workflow.md"]) {
    const abs = join(repoRoot, rel)
    if (hostIo.existsSync(abs)) phantomTargets.push(abs)
  }
  const patternsDir = join(repoRoot, "agent-patterns")
  if (hostIo.existsSync(patternsDir)) {
    for (const e of readdirOrReport(patternsDir, hostIo, repoRoot, findings) ?? []) {
      if (e.isFile && e.name.endsWith(".md")) phantomTargets.push(join(patternsDir, e.name))
    }
  }
  for (const absPath of collectMarkdownFilesRecursive(
    join(repoRoot, "adapters"),
    hostIo,
    repoRoot,
    findings,
  )) {
    phantomTargets.push(absPath)
  }
  const negationRe =
    /\b(?:not|never|no|banned|removed|merged|without|instead\s+of|non-goal|replaced|superseded|do\s+not|does\s+not|avoid)\b/i
  for (const absPath of phantomTargets) {
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    for (const line of content.split(/\r?\n/)) {
      const m =
        /\b(oxc-parser|sqlite-vec|FTS5|Layer\.scoped|Schema\.TaggedErrorClass|Cause\.failureOption)\b/.exec(
          line,
        )
      if (m !== null && !negationRe.test(line)) {
        findings.push({
          kind: "doc-banned-or-phantom-tech",
          nodeId: `${relPath}:${m[1]!}`,
          location: relPath,
          message: `Documentation "${relPath}" claims unimplemented or removed Effect v3 API/technology "${m[1]!}" outside a negation/migration context.`,
          action: `Remove or replace "${m[1]!}" in "${relPath}".`,
        })
        break
      }
      if (
        relPath.startsWith("adapters/claude-code/skills/resolving-effect-review-feedback/") &&
        /\bmodel:\s*"flash"/.test(line) &&
        !negationRe.test(line)
      ) {
        findings.push({
          kind: "doc-banned-or-phantom-tech",
          nodeId: `${relPath}:claude-agent-model-flash`,
          location: relPath,
          message: `Claude Code skill "${relPath}" specifies invalid Agent model "flash" — use "haiku" or "sonnet" for Claude Code Agent tool dispatches.`,
          action: `Replace model: "flash" with model: "haiku" or "sonnet" in "${relPath}".`,
        })
        break
      }
      if (
        relPath.startsWith("adapters/claude-code/skills/resolving-effect-review-feedback/") &&
        /\b(?:swarm\s+workers|invoke_subagent)\b/.test(line) &&
        !negationRe.test(line)
      ) {
        findings.push({
          kind: "doc-banned-or-phantom-tech",
          nodeId: `${relPath}:claude-antigravity-terminology`,
          location: relPath,
          message: `Claude Code skill "${relPath}" leaks Antigravity terminology ("swarm workers" / "invoke_subagent") — use Claude Code Agent tool terminology.`,
          action: `Replace "swarm workers" / "invoke_subagent" with Claude Code Agent tool terminology in "${relPath}".`,
        })
        break
      }
    }
  }

  const docsDir = join(repoRoot, "docs")
  for (const absPath of collectMarkdownFilesRecursive(docsDir, hostIo, repoRoot, findings)) {
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
    if (relPath.startsWith("docs/superpowers/")) continue
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    if (/\b(?:drizzle-orm|drizzle-kit)\b/.test(content)) {
      const hasBanOrSupersession = /\b(?:banned|supersession|superseded|ADR-0008)\b|zakázan/i.test(
        content,
      )
      if (!hasBanOrSupersession) {
        findings.push({
          kind: "doc-banned-or-phantom-tech",
          nodeId: `${relPath}:drizzle`,
          location: relPath,
          message: `Documentation "${relPath}" references banned Drizzle ("drizzle-orm"/"drizzle-kit") without an explicit ban or supersession notice.`,
          action: `Update "${relPath}" to reference native Effect v4 SQL or add a Supersession notice referencing ADR-0008.`,
        })
      }
    }
  }
}

export const evaluateDocTruthPlugin = (input: GraphEntropyInput): ReadonlyArray<GcFinding> => {
  if (input.workspaceRoot === undefined || input.hostIo === undefined) return []
  const repoRoot = input.workspaceRoot
  const hostIo = input.hostIo
  const findings: Array<GcFinding> = []

  const {
    names: workspacePkgNames,
    depsByPkg,
    pkgByRelDir,
  } = collectWorkspacePackageDeps(repoRoot, hostIo, findings)
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
        const raw = m[1]!
          .trim()
          .replace(/#L\d+(?:-L?\d+)?$/, "")
          .replace(/:\d+(?::\d+)?$/, "")
        if (raw.includes("*") || raw.includes("<") || raw.includes("{") || raw.includes("..."))
          continue
        if (
          !/^(?:libs|apps|tools|adapters)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|sql|md)$/.test(raw)
        )
          continue
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
  checkSkillTierTables(repoRoot, hostIo, findings)
  checkMermaidDependencyDrift(repoRoot, hostIo, depsByPkg, pkgByRelDir, findings)
  checkDocBannedOrPhantomTech(repoRoot, hostIo, findings)
  checkAstGateRuleClosure(repoRoot, hostIo, findings)

  return findings
}
