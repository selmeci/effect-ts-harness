import { join, relative } from "node:path"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CANONICAL_MCP_TOOL_NAMES,
  compareCodeUnits,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS } from "../../policy-worker-isolation.js"
import { type GcFinding, collectMarkdownFilesRecursive, readTextOrReport } from "./gc-helpers.js"

const LIVE_CATALOG_TOP_LEVEL_DOCS: ReadonlyArray<string> = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "docs/architecture-and-workflow.md",
  "docs/specs/README.md",
  "docs/adr/README.md",
]

const LIVE_CATALOG_DOC_DIRS: ReadonlyArray<string> = ["agent-patterns", "adapters"]

const MCP_TOOLS_DIRECT_RE =
  /(?<![.\d])\b(\d+)\*{0,2}\s+(?:[\p{L}/_-]+,?\s+){0,12}MCP\s+(?:tools?|nástroj(?:e|ov|a)?)\b/giu
const HARNESS_MCP_LINE_RE = /\bharness-mcp\b/i
const HARNESS_MCP_TOOLS_RE =
  /(?<![.\d])\b(\d+)\*{0,2}\s+(?:[\p{L}/_-]+,?\s+){0,6}(?:tools?|nástroj(?:e|ov|a)?)\b/giu
const BACKTICK_MCP_TOOL_RE = /`(harness_[a-z][a-z0-9_]*)`/g

const PNPM_HARNESS_CMD_RE = /\bpnpm\s+harness\s+([a-z][a-z0-9-]*)\b/g
const CLI_COMMANDS_DIRECT_RE =
  /(?<![.\d])\b(\d+)\*{0,2}\s+(?:[\p{L}/_-]+,?\s+){0,8}CLI\s+(?:sub)?commands?\b/giu
const HARNESS_CLI_LINE_RE = /\bharness-cli\b/i
const HARNESS_CLI_COMMANDS_RE =
  /(?<![.\d])\b(\d+)\*{0,2}\s+(?:[\p{L}/_-]+,?\s+){0,6}(?:sub)?commands?\b/giu

const recordMcpToolCountMismatch = (
  relDoc: string,
  lineNum: number,
  rawCount: string,
  expectedCount: number,
  seenCounts: Set<string>,
  findings: Array<GcFinding>,
): void => {
  const parsed = Number.parseInt(rawCount, 10)
  const dedupeKey = `${lineNum}:${parsed}`
  if (parsed === expectedCount || seenCounts.has(dedupeKey)) return
  seenCounts.add(dedupeKey)
  findings.push({
    kind: "doc-mcp-tool-count-truth",
    nodeId: `${relDoc}:L${lineNum}:mcp-count:${parsed}`,
    location: `${relDoc}:${lineNum}`,
    message: `Documentation "${relDoc}:${lineNum}" states MCP tool count ${parsed}, but CANONICAL_MCP_TOOL_NAMES defines ${expectedCount}.`,
    action: `Update the MCP tool count in "${relDoc}:${lineNum}" to ${expectedCount}.`,
  })
}

const recordCliCommandCountMismatch = (
  relDoc: string,
  lineNum: number,
  rawCount: string,
  expectedCount: number,
  seenCounts: Set<string>,
  findings: Array<GcFinding>,
): void => {
  const parsed = Number.parseInt(rawCount, 10)
  const dedupeKey = `${lineNum}:${parsed}`
  if (parsed === expectedCount || seenCounts.has(dedupeKey)) return
  seenCounts.add(dedupeKey)
  findings.push({
    kind: "doc-cli-command-truth",
    nodeId: `${relDoc}:L${lineNum}:cli-count:${parsed}`,
    location: `${relDoc}:${lineNum}`,
    message: `Documentation "${relDoc}:${lineNum}" states CLI command count ${parsed}, but CANONICAL_CLI_COMMAND_NAMES defines ${expectedCount}.`,
    action: `Update the CLI command count in "${relDoc}:${lineNum}" to ${expectedCount}.`,
  })
}

/**
 * Pure catalog parity check verifying MCP tool counts, backticked `harness_*`
 * tool identifiers, `pnpm harness <subcommand>` invocations, and CLI subcommand
 * counts in live markdown documentation against `@harness/contract` catalogs.
 */
export const auditCatalogDocTruthInContent = (
  relDoc: string,
  content: string,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  const canonicalMcpTools = new Set<string>(CANONICAL_MCP_TOOL_NAMES)
  const canonicalCliCommands = new Set<string>(CANONICAL_CLI_COMMAND_NAMES)
  const expectedMcpCount = CANONICAL_MCP_TOOL_NAMES.length
  const expectedCliCount = CANONICAL_CLI_COMMAND_NAMES.length

  const seenUnknownMcpTools = new Set<string>()
  const seenMcpCounts = new Set<string>()
  const seenUnknownCliCmds = new Set<string>()
  const seenCliCounts = new Set<string>()

  interface ActiveFence {
    readonly char: "`" | "~"
    readonly len: number
    readonly lang: string
  }
  let activeFence: ActiveFence | null = null
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1
    if (activeFence === null) {
      const openMatch = /^\s*(?:(`{3,})([^`\r\n]*)|(~{3,})([^\r\n]*))$/.exec(line)
      if (openMatch !== null) {
        const fenceToken = (openMatch[1] ?? openMatch[3])!
        const info = (openMatch[2] ?? openMatch[4] ?? "").trim()
        const lang = info.split(/\s+/)[0]?.toLowerCase() ?? ""
        activeFence = {
          char: fenceToken[0] === "~" ? "~" : "`",
          len: fenceToken.length,
          lang,
        }
        continue
      }
    } else {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (
        closeMatch !== null &&
        closeMatch[1]![0] === activeFence.char &&
        closeMatch[1]!.length >= activeFence.len
      ) {
        activeFence = null
        continue
      }
    }

    for (const cmdMatch of line.matchAll(PNPM_HARNESS_CMD_RE)) {
      const subcmd = cmdMatch[1]!
      if (!canonicalCliCommands.has(subcmd) && !seenUnknownCliCmds.has(subcmd)) {
        seenUnknownCliCmds.add(subcmd)
        findings.push({
          kind: "doc-cli-command-truth",
          nodeId: `${relDoc}:cli:${subcmd}`,
          location: `${relDoc}:${lineNum}`,
          message: `Documentation "${relDoc}:${lineNum}" invokes unknown CLI subcommand "pnpm harness ${subcmd}".`,
          action: `Replace "pnpm harness ${subcmd}" in "${relDoc}" with a canonical subcommand from CANONICAL_CLI_COMMAND_NAMES.`,
        })
      }
    }

    const inNonMermaidFence = activeFence !== null && activeFence.lang !== "mermaid"
    if (inNonMermaidFence) continue

    for (const toolMatch of line.matchAll(BACKTICK_MCP_TOOL_RE)) {
      const toolName = toolMatch[1]!
      if (!canonicalMcpTools.has(toolName) && !seenUnknownMcpTools.has(toolName)) {
        seenUnknownMcpTools.add(toolName)
        findings.push({
          kind: "doc-mcp-tool-count-truth",
          nodeId: `${relDoc}:mcp:${toolName}`,
          location: `${relDoc}:${lineNum}`,
          message: `Documentation "${relDoc}:${lineNum}" references unknown MCP tool \`${toolName}\` absent from CANONICAL_MCP_TOOL_NAMES.`,
          action: `Replace or remove \`${toolName}\` in "${relDoc}" to match CANONICAL_MCP_TOOL_NAMES.`,
        })
      }
    }

    for (const countMatch of line.matchAll(MCP_TOOLS_DIRECT_RE)) {
      recordMcpToolCountMismatch(
        relDoc,
        lineNum,
        countMatch[1]!,
        expectedMcpCount,
        seenMcpCounts,
        findings,
      )
    }
    if (HARNESS_MCP_LINE_RE.test(line)) {
      for (const countMatch of line.matchAll(HARNESS_MCP_TOOLS_RE)) {
        recordMcpToolCountMismatch(
          relDoc,
          lineNum,
          countMatch[1]!,
          expectedMcpCount,
          seenMcpCounts,
          findings,
        )
      }
    }

    for (const cliCountMatch of line.matchAll(CLI_COMMANDS_DIRECT_RE)) {
      recordCliCommandCountMismatch(
        relDoc,
        lineNum,
        cliCountMatch[1]!,
        expectedCliCount,
        seenCliCounts,
        findings,
      )
    }
    if (HARNESS_CLI_LINE_RE.test(line)) {
      for (const cliCountMatch of line.matchAll(HARNESS_CLI_COMMANDS_RE)) {
        recordCliCommandCountMismatch(
          relDoc,
          lineNum,
          cliCountMatch[1]!,
          expectedCliCount,
          seenCliCounts,
          findings,
        )
      }
    }
  }

  return findings
}

export const WORKER_ISOLATION_PARITY_DOC_PATHS: ReadonlyArray<string> = [
  "libs/harness/docs/adr/0018-durable-effect-workflow-omnigraph-engine-and-agent-runners.md",
  "adapters/claude-code/README.md",
  "adapters/claude-code/skills/effect-harness/SKILL.md",
  "adapters/antigravity/plugins/effect-harness/README.md",
  "adapters/antigravity/plugins/effect-harness/skills/effect-harness/SKILL.md",
]

const extractWorkerIsolatedDocSubcommands = (
  afterWorkerText: string,
): ReadonlyArray<string> | undefined => {
  const inlinePipeMatch = /`harness\s+workflow\s+([^`\n]+)`/i.exec(afterWorkerText)
  if (inlinePipeMatch !== null) {
    return inlinePipeMatch[1]!
      .split(/[|/]/)
      .map((tok) => tok.replace(/`/g, "").trim())
      .filter((tok) => tok.length > 0)
  }
  const parenListMatch = /`harness\s+workflow`\s*\(([^)\n]+)\)/i.exec(afterWorkerText)
  if (parenListMatch !== null) {
    return parenListMatch[1]!
      .split(/[|/]/)
      .map((tok) => tok.replace(/`/g, "").trim())
      .filter((tok) => tok.length > 0)
  }
  return undefined
}

/**
 * REQ-3.5: Verifies `policy.ts`, `ADR-0018`, and Claude Code / Antigravity `README.md` + `SKILL.md`
 * stay synchronized with `WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS`.
 */
export const auditWorkerIsolationSubcommandParity = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findingsOut: Array<GcFinding> = [],
): ReadonlyArray<GcFinding> => {
  const policyPath = join(repoRoot, "libs/harness/gates/src/policy.ts")
  const policyWorkerPath = join(repoRoot, "libs/harness/gates/src/policy-worker-isolation.ts")
  const hasWorkerIsolationSurface =
    hostIo.existsSync(policyPath) ||
    hostIo.existsSync(policyWorkerPath) ||
    WORKER_ISOLATION_PARITY_DOC_PATHS.some((rel) => hostIo.existsSync(join(repoRoot, rel)))
  if (!hasWorkerIsolationSurface) {
    return findingsOut
  }

  if (hostIo.existsSync(policyPath)) {
    const policyText = readTextOrReport(policyPath, hostIo, repoRoot, findingsOut)
    if (policyText !== undefined) {
      const joined = WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")
      const interpolatesCanonicalConst =
        /\$\{\s*WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS\.join\(\s*["'][^"']+["']\s*\)\s*\}/.test(
          policyText,
        )
      const hasAllJoined = policyText.includes(joined)
      if (!interpolatesCanonicalConst && !hasAllJoined) {
        findingsOut.push({
          kind: "worker-isolation-subcommand-parity",
          nodeId: "policy.ts:worker-isolation-subcommands",
          location: "libs/harness/gates/src/policy.ts",
          message: `policy.ts worker isolation deny reason does not derive from WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS (${joined}).`,
          action:
            "Import and interpolate WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS in libs/harness/gates/src/policy.ts.",
        })
      }
    }
  }

  const canonicalSet = new Set<string>(WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS)
  for (const relDoc of WORKER_ISOLATION_PARITY_DOC_PATHS) {
    const absDoc = join(repoRoot, relDoc)
    if (!hostIo.existsSync(absDoc)) {
      findingsOut.push({
        kind: "worker-isolation-subcommand-parity",
        nodeId: `${relDoc}:missing-doc`,
        location: relDoc,
        message: `Required worker isolation documentation file "${relDoc}" is missing.`,
        action: `Create "${relDoc}" documenting HARNESS_UNIT_WORKER=1 blocked workflow subcommands (${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")}).`,
      })
      continue
    }
    const content = readTextOrReport(absDoc, hostIo, repoRoot, findingsOut)
    if (content === undefined) continue
    const lines = content.split(/\r?\n/)
    const workerWindows: Array<{ readonly lineNum: number; readonly afterWorkerText: string }> = []
    for (let i = 0; i < lines.length; i++) {
      const markerMatch = /\bHARNESS_UNIT_WORKER\b/.exec(lines[i]!)
      if (markerMatch !== null) {
        const afterOnLine = lines[i]!.slice(markerMatch.index)
        const snippet = [afterOnLine, lines[i + 1] ?? ""].join(" ")
        workerWindows.push({ lineNum: i + 1, afterWorkerText: snippet })
      }
    }
    if (workerWindows.length === 0) {
      findingsOut.push({
        kind: "worker-isolation-subcommand-parity",
        nodeId: `${relDoc}:missing-worker-isolation`,
        location: relDoc,
        message: `Documentation "${relDoc}" is missing HARNESS_UNIT_WORKER=1 workflow isolation subcommand documentation.`,
        action: `Document HARNESS_UNIT_WORKER=1 blocked workflow subcommands (${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")}) in "${relDoc}".`,
      })
      continue
    }
    const parsedLists = workerWindows
      .map((w) => ({
        lineNum: w.lineNum,
        tokens: extractWorkerIsolatedDocSubcommands(w.afterWorkerText),
      }))
      .filter(
        (entry): entry is { readonly lineNum: number; readonly tokens: ReadonlyArray<string> } =>
          entry.tokens !== undefined,
      )
    const firstLine = workerWindows[0]!.lineNum
    if (parsedLists.length === 0) {
      findingsOut.push({
        kind: "worker-isolation-subcommand-parity",
        nodeId: `${relDoc}:missing-subcmd-list`,
        location: `${relDoc}:${firstLine}`,
        message: `Documentation "${relDoc}:${firstLine}" HARNESS_UNIT_WORKER=1 clause lacks a parseable 'harness workflow' blocked subcommand list.`,
        action: `Document blocked workflow subcommands (${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")}) after HARNESS_UNIT_WORKER=1 in "${relDoc}".`,
      })
      continue
    }
    const foundTokens = new Set<string>(parsedLists.flatMap((entry) => entry.tokens))
    for (const subcmd of WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS) {
      if (!foundTokens.has(subcmd)) {
        findingsOut.push({
          kind: "worker-isolation-subcommand-parity",
          nodeId: `${relDoc}:missing-subcmd:${subcmd}`,
          location: `${relDoc}:${firstLine}`,
          message: `Documentation "${relDoc}:${firstLine}" HARNESS_UNIT_WORKER=1 clause omits blocked workflow subcommand '${subcmd}'.`,
          action: `Add '${subcmd}' to the HARNESS_UNIT_WORKER=1 blocked subcommand list in "${relDoc}".`,
        })
      }
    }
    for (const extra of foundTokens) {
      if (!canonicalSet.has(extra)) {
        findingsOut.push({
          kind: "worker-isolation-subcommand-parity",
          nodeId: `${relDoc}:extra-subcmd:${extra}`,
          location: `${relDoc}:${firstLine}`,
          message: `Documentation "${relDoc}:${firstLine}" HARNESS_UNIT_WORKER=1 clause lists stale/extra workflow subcommand '${extra}' not in WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.`,
          action: `Remove '${extra}' from the HARNESS_UNIT_WORKER=1 blocked subcommand list in "${relDoc}".`,
        })
      }
    }
  }

  return findingsOut
}

export const checkCatalogDocTruth = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const targetPaths: Array<string> = []
  for (const rel of LIVE_CATALOG_TOP_LEVEL_DOCS) {
    const absPath = join(repoRoot, rel)
    if (hostIo.existsSync(absPath)) targetPaths.push(absPath)
  }
  for (const relDir of LIVE_CATALOG_DOC_DIRS) {
    targetPaths.push(
      ...collectMarkdownFilesRecursive(join(repoRoot, relDir), hostIo, repoRoot, findings),
    )
  }
  const sortedUnique = [...new Set(targetPaths)].sort(compareCodeUnits)
  for (const absPath of sortedUnique) {
    const relDoc = relative(repoRoot, absPath).replace(/\\/g, "/")
    const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    findings.push(...auditCatalogDocTruthInContent(relDoc, content))
  }
  auditWorkerIsolationSubcommandParity(repoRoot, hostIo, findings)
}
