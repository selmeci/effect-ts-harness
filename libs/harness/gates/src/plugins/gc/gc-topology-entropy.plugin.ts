/**
 * Topology & Hypergraph Entropy Gate Plugin.
 *
 * Evaluates core graph topology and contract reachability rules.
 *
 * Rules owned:
 * - unused-service: Detects declared ServiceTags with 0 consumer edges.
 * - unprovided-service: Detects ServiceTags without a providing ServiceLayer.
 * - dead-tagged-error: Detects Schema.TaggedError types never emitted in E channels.
 * - missing-pattern-doc: Detects registered idiom patterns missing documentation.
 * - node-sqlite-in-infra: Enforces real workerd storage against branching violations.
 * - unused-contract-export: Detects dead contract exports not used across tiers.
 */
import { join, relative } from "node:path"
import * as Graph from "effect/Graph"
import type { SyncHostIo } from "@harness/service"
import {
  collectWorkspaceAllFiles,
  collectWorkspaceTsFiles,
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  IGNORED_ERRORS,
  IGNORED_SERVICES,
  safeFs,
} from "./gc-helpers.js"

export const checkUnusedContractExports = (
  repoRoot: string,
  hostIo: SyncHostIo,
  targetScope?: string,
): ReadonlyArray<GcFinding> => {
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return []
  const scopes = targetScope !== undefined
    ? [targetScope]
    : safeFs<ReadonlyArray<string>>(
        () =>
          hostIo
            .readdirSync(libsDir)
            .filter((e) => e.isDirectory)
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b)),
        [],
      )
  const findings: Array<GcFinding> = []

  for (const scope of scopes) {
    const scopeDir = join(libsDir, scope)
    const contractSrcDir = join(scopeDir, "contract", "src")
    if (!hostIo.existsSync(contractSrcDir)) continue

    const existingSiblingDirs: Array<string> = []
    const scopeChildren = safeFs(() => hostIo.readdirSync(scopeDir), [])
    for (const child of scopeChildren) {
      if (child.isDirectory && child.name !== "contract" && child.name !== "docs") {
        existingSiblingDirs.push(join(scopeDir, child.name))
      }
    }
    const appsDir = join(repoRoot, "apps")
    if (hostIo.existsSync(appsDir)) {
      const appChildren = safeFs(() => hostIo.readdirSync(appsDir), [])
      for (const appChild of appChildren) {
        if (
          appChild.isDirectory &&
          (appChild.name === scope || appChild.name.startsWith(`${scope}-`))
        ) {
          existingSiblingDirs.push(join(appsDir, appChild.name))
        }
      }
    }
    const contractScriptsDir = join(scopeDir, "contract", "scripts")
    if (hostIo.existsSync(contractScriptsDir)) existingSiblingDirs.push(contractScriptsDir)
    if (existingSiblingDirs.length === 0) continue

    const contractFiles = collectWorkspaceTsFiles(contractSrcDir, hostIo)
    const siblingFiles: Array<string> = []
    for (const sibDir of existingSiblingDirs) {
      if (sibDir.endsWith("/scripts")) siblingFiles.push(...collectWorkspaceAllFiles(sibDir, hostIo))
      else siblingFiles.push(...collectWorkspaceTsFiles(sibDir, hostIo))
    }

    const stripCommentsAndStrings = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\r\n]*/g, " ")
        .replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '""')

    const combinedSiblingContent = siblingFiles
      .map((f) => safeFs(() => hostIo.readTextSync(f), ""))
      .map((text) => stripCommentsAndStrings(text).replace(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["'][^"']*["']/g, ""))
      .join("\n")

    const nonTestSiblingContent = siblingFiles
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
      .map((f) => safeFs(() => hostIo.readTextSync(f), ""))
      .map(stripCommentsAndStrings)
      .join("\n")

    const hasActiveStubs = /\bstub\s*</.test(nonTestSiblingContent)

    for (const contractFile of contractFiles) {
      const content = safeFs(() => hostIo.readTextSync(contractFile), "")
      const strippedContractContent = stripCommentsAndStrings(content)
      const relContractFile = relative(repoRoot, contractFile).replace(/\\/g, "/")
      const exportRegex = /(?:^|\n)\s*export\s+(?:const|class|function)\s+([A-Za-z_$][\w$]*)/g
      const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      let exportMatch: RegExpExecArray | null
      while ((exportMatch = exportRegex.exec(strippedContractContent)) !== null) {
        const symbolName = exportMatch[1]!
        const escapedSym = escapeRegex(symbolName)
        const symbolRefRegex = new RegExp(`\\b${escapedSym}\\b`)
        const internalStripped = strippedContractContent
          .replace(new RegExp(`export\\s+class\\s+${escapedSym}\\b[\\s\\S]*?\\{`, "g"), "{")
          .replace(new RegExp(`export\\s+(?:const|function)\\s+${escapedSym}\\b[^\\n]*`, "g"), "")
          .replace(new RegExp(`export\\s+type\\s+${escapedSym}\\s*=[\\s\\S]*?(?:\\n|$)`, "g"), "")
        if (!symbolRefRegex.test(combinedSiblingContent) && !symbolRefRegex.test(internalStripped)) {
          findings.push({
            kind: "unused-contract-export",
            nodeId: `${scope}/contract:${symbolName}`,
            location: relContractFile,
            message: `Contract symbol "${symbolName}" exported from "${relContractFile}" is never imported or used by any downstream package or fixture in scope "${scope}".`,
            action: `Import "${symbolName}" in a downstream package/fixture or remove the unused contract export from "${relContractFile}".`,
          })
        }
      }

      if (!hasActiveStubs && nonTestSiblingContent.trim().length > 0) {
        const taggedErrorRegex = /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+Schema\.TaggedError/g
        let errMatch: RegExpExecArray | null
        while ((errMatch = taggedErrorRegex.exec(strippedContractContent)) !== null) {
          const errName = errMatch[1]!
          const escapedErr = escapeRegex(errName)
          const constructRegex = new RegExp(`(?:\\bnew\\s+${escapedErr}\\s*\\(|\\b${escapedErr}\\.make\\s*\\()`)
          if (!constructRegex.test(nonTestSiblingContent)) {
            findings.push({
              kind: "dead-tagged-error",
              nodeId: `${scope}/contract:${errName}`,
              location: relContractFile,
              message: `Contract TaggedError "${errName}" in "${relContractFile}" is never constructed (new ${errName}(...)) in any non-test implementation or fixture file in scope "${scope}".`,
              action: `Construct and fail with "new ${errName}(...)" in the implementation or remove the phantom error from "${relContractFile}".`,
            })
          }
        }
      }
    }
  }
  return findings
}

// Rule: node-sqlite-in-infra (branching violations filter)
export const evaluateBranchingSqliteViolations = (
  input: GraphEntropyInput,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  for (const bv of input.graph.branchingViolations ?? []) {
    if (bv.rule === "node-sqlite-in-infra") {
      findings.push({
        kind: "node-sqlite-in-infra",
        nodeId: bv.enclosingSymbol,
        location: `${bv.file}:${bv.line}`,
        message: bv.message,
        action:
          "Replace node:sqlite with real Cloudflare workerd storage via @alchemy.run/cloudflare-runtime (Workerd SQLite Durable Object or D1.local) per harness:ADR-0008 / harness:SPEC-0006.",
      })
    }
  }
  return findings
}

export const evaluateTopologyEntropyPlugin = (
  input: GraphEntropyInput,
  ctx: GraphReachabilityContext,
): ReadonlyArray<GcFinding> => {
  const g = input.graph.graph
  const findings: Array<GcFinding> = []

  // Rule: unused-service
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "ServiceTag") {
      if (IGNORED_SERVICES.has(node.tagId) || IGNORED_SERVICES.has(node.name)) continue
      const totalConsumers = (ctx.incomingRequires.get(idx) ?? 0) + (ctx.incomingLayerRequires.get(idx) ?? 0)
      if (totalConsumers === 0) {
        const location = node.file ? (typeof node.line === "number" ? `${node.file}:${node.line}` : node.file) : undefined
        findings.push({
          kind: "unused-service",
          nodeId: node.tagId,
          location,
          message: `ServiceTag "${node.tagId}" has no consumers (0 RequiresService / LayerRequires edges).`,
          action: `Either inject ServiceTag "${node.tagId}" into an Effect generator (yield* ${node.name}) or remove the unused declaration.`,
        })
      }
    }
  }

  // Rule: unprovided-service
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "ServiceTag") {
      if (IGNORED_SERVICES.has(node.tagId) || IGNORED_SERVICES.has(node.name)) continue
      const providers = ctx.incomingProvides.get(idx) ?? 0
      if (providers === 0) {
        const location = node.file ? (typeof node.line === "number" ? `${node.file}:${node.line}` : node.file) : undefined
        findings.push({
          kind: "unprovided-service",
          nodeId: node.tagId,
          location,
          message: `ServiceTag "${node.tagId}" has no providing ServiceLayer (0 ProvidesService edges).`,
          action: `Provide a live layer implementing "${node.tagId}" (e.g. Layer.succeed / Layer.effect) in type:infra.`,
        })
      }
    }
  }

  // Rule: dead-tagged-error
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "TaggedError") {
      if (IGNORED_ERRORS.has(node.errorTag)) continue
      const failsWithCount = ctx.incomingFailsWith.get(idx) ?? 0
      if (failsWithCount === 0) {
        const location = node.file ? (typeof node.line === "number" ? `${node.file}:${node.line}` : node.file) : undefined
        findings.push({
          kind: "dead-tagged-error",
          nodeId: node.errorTag,
          location,
          message: `TaggedError "${node.errorTag}" is never emitted in any E channel (0 FailsWith edges).`,
          action: `Fail with this error using Effect.fail(new ${node.errorTag}(...)) in a domain use case or prune unused error definition.`,
        })
      }
    }
  }

  // Rule: missing-pattern-doc
  if (input.expectedPatterns !== undefined) {
    const existingPatternSlugs = new Set<string>()
    for (const [, node] of Graph.nodes(g)) {
      if (node._tag === "PatternDoc") {
        existingPatternSlugs.add(node.slug)
        if (typeof node.patternName === "string") existingPatternSlugs.add(node.patternName)
        if (typeof node.path === "string" && node.path.endsWith(".md")) {
          const base = node.path.split("/").pop()?.replace(/\.md$/, "")
          if (base) existingPatternSlugs.add(base)
        }
      }
    }
    for (const p of input.expectedPatterns) {
      if (p === "review" || p === "effect") continue
      if (!existingPatternSlugs.has(p)) {
        findings.push({
          kind: "missing-pattern-doc",
          nodeId: `Pattern:${p}`,
          location: `agent-patterns/${p}.md`,
          message: `Pattern doc "agent-patterns/${p}.md" registered in IdiomRouterV1 is missing from the graph.`,
          action: `Create "agent-patterns/${p}.md" documenting this idiom or remove "${p}" from IDIOM_BLOCKS in IdiomRouter.`,
        })
      }
    }
  }

  return findings
}
