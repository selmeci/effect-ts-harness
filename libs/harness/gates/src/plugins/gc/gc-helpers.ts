/**
 * GC Check Helpers, Schemas, and Reachability Context.
 *
 * Provides shared types, schemas, and AST/file utilities for garbage-collection
 * and zero-entropy gates across all GC plugins.
 *
 * Types & Schemas:
 * - GcFindingKind: Discriminated union of all 21 GC finding kinds.
 * - GcFinding: Finding schema with nodeId, location, message, and action.
 * - GovernanceDocRef: Reference schema for ADR and EARS governance docs.
 * - GraphGcReport: Aggregated report schema with clean flag and findings.
 * - GraphReachabilityContext: Indexed graph reachability and relation counts.
 */
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import * as Graph from "effect/Graph"
import type { GovernanceDocStatus, GraphInferenceResult, HarnessGraph, HarnessNode } from "@harness/graph"
import { isModularPluginPath } from "../self-dogfooding-plugin.js"

export const GcFindingKind = Schema.Literals([
  "unused-service", "unprovided-service", "dead-tagged-error", "orphan-effect-fn",
  "missing-pattern-doc", "untested-effect-fn", "missing-decider-property-test",
  "shallow-decider-property-test", "empty-source-module", "unused-package-dependency",
  "stale-doc-reference", "ears-spec-lint", "adr-doc-lint", "ontology-invariant",
  "unused-contract-export", "node-sqlite-in-infra", "unmanaged-sql-ddl",
  "invalid-migrator-record-key", "unsafe-sql-migration", "untrusted-row-brand-make",
  "architecture-policy-violation",
])
export type GcFindingKind = typeof GcFindingKind.Type

export const GcFinding = Schema.Struct({
  kind: GcFindingKind, nodeId: Schema.String, message: Schema.String,
  location: Schema.optional(Schema.String), action: Schema.optional(Schema.String),
})
export type GcFinding = typeof GcFinding.Type

export const GovernanceDocRef = Schema.Struct({
  docPath: Schema.String, id: Schema.String,
  status: Schema.Literals(["accepted", "proposed", "superseded", "deprecated"]),
  markdown: Schema.optional(Schema.String),
  enforcedByFiles: Schema.optional(Schema.Array(Schema.String)),
  existingFiles: Schema.optional(Schema.Array(Schema.String)),
  referencedSpans: Schema.optional(Schema.Array(Schema.String)),
  referencedServices: Schema.optional(Schema.Array(Schema.String)),
  referencedErrors: Schema.optional(Schema.Array(Schema.String)),
  enforcedByFileContents: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type GovernanceDocRef = typeof GovernanceDocRef.Type
export type GovernanceDocReference = GovernanceDocRef

export const GraphGcReport = Schema.Struct({ clean: Schema.Boolean, findings: Schema.Array(GcFinding) })
export type GraphGcReport = typeof GraphGcReport.Type
export type GcReport = GraphGcReport

export interface GraphEntropyInput {
  readonly graph: HarnessGraph; readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
  readonly workspaceRoot?: string | undefined; readonly expectedPatterns?: ReadonlyArray<string> | undefined
  readonly checkUntestedDomainFns?: boolean | undefined; readonly checkDeciderPropertyTests?: boolean | undefined
  readonly documentedSymbols?: ReadonlyArray<string> | undefined; readonly testedSpanNames?: ReadonlyArray<string> | undefined
  readonly propertyTestedSpanNames?: ReadonlyArray<string> | undefined
  readonly propertyTestAssertionsBySpan?: ReadonlyMap<string, number> | undefined
}

export const IGNORED_SERVICES = new Set([
  "DecisionModel", "DecisionModel.DecisionModel", "OmnigraphSync", "SpanRecorder",
  "@harness/ingest/SpanRecorder", "ChaosFaultController", "@harness/gates/ChaosFaultController",
  "SampleApiClient", "CartEsAtomClient", "ActiveCounterStore",
])

export const IGNORED_ERRORS = new Set([
  "OmnigraphLoadError", "SchemaError", "UnknownToolError", "DstStepFailureError",
])

export const IGNORED_UNTESTED_FNS = new Set([
  "Friction.decide", "GraphGc.decide", "MigrationSafety.decide", "MutationCheck.decide",
  "SessionHandoff.decide", "SpanBudget.decide", "Harness.decideGuardCommand", "Harness.routeStep",
  "Harness.proposeLearningAction", "Harness.checkPlanStepCoverage", "Harness.triageFailure",
  "EarsSpecLint.decide", "AdrDocLint.decide", "OntologyInvariants.decide", "SessionReport.decide",
  "Harness.checkOntologyPairConflict", "Harness.evaluateOntologyConflicts", "HarnessMcp.executeTool",
])

export interface GraphReachabilityContext {
  readonly nodeByIndex: ReadonlyMap<Graph.NodeIndex, HarnessNode>
  readonly nodeIndexById: ReadonlyMap<string, Graph.NodeIndex>
  readonly incomingByTarget: ReadonlyMap<Graph.NodeIndex, ReadonlyArray<Graph.EdgeIndex>>
  readonly outgoingBySource: ReadonlyMap<Graph.NodeIndex, ReadonlyArray<Graph.EdgeIndex>>
  readonly providedServiceIds: ReadonlySet<string>; readonly requiredServiceIds: ReadonlySet<string>
  readonly producedErrorIds: ReadonlySet<string>; readonly handledErrorIds: ReadonlySet<string>
  readonly reachableNodeIds: ReadonlySet<string>; readonly appEntryIndices: ReadonlyArray<Graph.NodeIndex>
  readonly exportedTestIndices: ReadonlyArray<Graph.NodeIndex>
  readonly incomingRequires: Map<Graph.NodeIndex, number>; readonly incomingLayerRequires: Map<Graph.NodeIndex, number>
  readonly incomingProvides: Map<Graph.NodeIndex, number>; readonly incomingFailsWith: Map<Graph.NodeIndex, number>
  readonly incomingTestOrCall: Map<Graph.NodeIndex, number>; readonly incomingPropertyTests: Map<Graph.NodeIndex, number>
  readonly incomingRichPropertyTests: Map<Graph.NodeIndex, number>; readonly hasVitestCases: boolean
}

export const buildGraphReachabilityContext = (harnessGraph: HarnessGraph): GraphReachabilityContext => {
  const g = harnessGraph.graph
  const nodeByIndex = new Map<Graph.NodeIndex, HarnessNode>(), nodeIndexById = new Map<string, Graph.NodeIndex>()
  const incomingByTarget = new Map<Graph.NodeIndex, Array<Graph.EdgeIndex>>(), outgoingBySource = new Map<Graph.NodeIndex, Array<Graph.EdgeIndex>>()
  const providedServiceIds = new Set<string>(), requiredServiceIds = new Set<string>()
  const producedErrorIds = new Set<string>(), handledErrorIds = new Set<string>(), reachableNodeIds = new Set<string>()
  const appEntryIndices: Array<Graph.NodeIndex> = [], exportedTestIndices: Array<Graph.NodeIndex> = []
  const incomingRequires = new Map<Graph.NodeIndex, number>(), incomingLayerRequires = new Map<Graph.NodeIndex, number>(), incomingProvides = new Map<Graph.NodeIndex, number>()
  const incomingFailsWith = new Map<Graph.NodeIndex, number>(), incomingTestOrCall = new Map<Graph.NodeIndex, number>(), incomingPropertyTests = new Map<Graph.NodeIndex, number>(), incomingRichPropertyTests = new Map<Graph.NodeIndex, number>()
  let hasVitestCases = false

  for (const [idx, node] of Graph.nodes(g)) {
    nodeByIndex.set(idx, node)
    match(node)
      .with({ _tag: "ServiceTag" }, (n) => { nodeIndexById.set(n.tagId, idx); nodeIndexById.set(n.name, idx) })
      .with({ _tag: "TaggedError" }, (n) => { nodeIndexById.set(n.errorTag, idx) })
      .with({ _tag: "EffectFn" }, (n) => {
        nodeIndexById.set(n.spanName, idx); nodeIndexById.set(n.qualname, idx)
        if (n.packageTag === "app") appEntryIndices.push(idx)
      })
      .with({ _tag: "VitestCase" }, () => { hasVitestCases = true; exportedTestIndices.push(idx) })
      .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "PatternDoc" }, { _tag: "SchemaDef" },
            { _tag: "ServiceLayer" }, { _tag: "EffectSignature" }, { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" }, () => {})
      .exhaustive()
  }

  const getOutEdges = (idx: Graph.NodeIndex) =>
    [...Graph.outgoingEdges(g, idx)].flatMap((eIdx) =>
      match(Graph.getEdge(g, eIdx)).with({ _tag: "Some" }, ({ value }) => [{ edgeIdx: eIdx, ...value }]).with({ _tag: "None" }, () => []).exhaustive()
    )

  for (const [relIdx, node] of Graph.nodes(g)) {
    const outEdges = getOutEdges(relIdx)
    outgoingBySource.set(relIdx, outEdges.map((e) => e.edgeIdx))
    for (const e of outEdges) {
      const list = incomingByTarget.get(e.target) ?? []
      list.push(e.edgeIdx); incomingByTarget.set(e.target, list)
    }
    match(node)
      .with({ _tag: "EffectSignature" }, () => {
        for (const { target, data } of outEdges) {
          match<string>(data.role)
            .with("requires-service", () => {
              incomingRequires.set(target, (incomingRequires.get(target) ?? 0) + 1)
              match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "ServiceTag" } }, ({ value }) => { requiredServiceIds.add(value.tagId) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
            })
            .with("fails-with", () => {
              incomingFailsWith.set(target, (incomingFailsWith.get(target) ?? 0) + 1)
              match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "TaggedError" } }, ({ value }) => { producedErrorIds.add(value.errorTag) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
            })
            .with("callee", () => { incomingTestOrCall.set(target, (incomingTestOrCall.get(target) ?? 0) + 1) })
            .otherwise(() => {})
        }
      })
      .with({ _tag: "LayerFlow" }, () => {
        const hasProvider = outEdges.some((e) => e.data.role === "provider-layer" && match(Graph.getNode(g, e.target)).with({ _tag: "Some", value: { _tag: "ServiceLayer" } }, () => true).with({ _tag: "Some" }, () => false).with({ _tag: "None" }, () => false).exhaustive())
        for (const { target, data } of outEdges) {
          match<string>(data.role)
            .with("provided-service", () => {
              if (hasProvider) {
                incomingProvides.set(target, (incomingProvides.get(target) ?? 0) + 1)
                match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "ServiceTag" } }, ({ value }) => { providedServiceIds.add(value.tagId) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
              }
            })
            .with("required-service", () => {
              incomingLayerRequires.set(target, (incomingLayerRequires.get(target) ?? 0) + 1)
              match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "ServiceTag" } }, ({ value }) => { requiredServiceIds.add(value.tagId) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
            })
            .with("fails-with", () => { incomingFailsWith.set(target, (incomingFailsWith.get(target) ?? 0) + 1) })
            .otherwise(() => {})
        }
      })
      .with({ _tag: "TraceabilityTuple" }, () => {
        const testNodes: Array<{ readonly isPropertyTest?: boolean | undefined; readonly hasNonPrimitiveArbitrary?: boolean | undefined }> = []
        const spanTargets: Array<Graph.NodeIndex> = []
        for (const { target, data } of outEdges) {
          match<string>(data.role)
            .with("exercising-test", "verifying-test", () => {
              match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "VitestCase" } }, ({ value }) => { testNodes.push(value) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
            })
            .with("exercised-span", "realizing-symbol", () => {
              match(Graph.getNode(g, target)).with({ _tag: "Some", value: { _tag: "EffectFn" } }, () => { spanTargets.push(target) }).with({ _tag: "Some" }, () => {}).with({ _tag: "None" }, () => {}).exhaustive()
            })
            .otherwise(() => {})
        }
        for (const s of spanTargets) {
          incomingTestOrCall.set(s, (incomingTestOrCall.get(s) ?? 0) + testNodes.length)
          for (const t of testNodes) {
            if (t.isPropertyTest === true) {
              incomingPropertyTests.set(s, (incomingPropertyTests.get(s) ?? 0) + 1)
              if (t.hasNonPrimitiveArbitrary !== false) incomingRichPropertyTests.set(s, (incomingRichPropertyTests.get(s) ?? 0) + 1)
            }
          }
        }
      })
      .with({ _tag: "HttpEndpointTuple" }, () => {
        for (const { target, data } of outEdges) {
          match<string>(data.role)
            .with("endpoint-error", () => { incomingFailsWith.set(target, (incomingFailsWith.get(target) ?? 0) + 1) })
            .with("endpoint-handler", () => { incomingTestOrCall.set(target, (incomingTestOrCall.get(target) ?? 0) + 1) })
            .otherwise(() => {})
        }
      })
      .with({ _tag: "MigrationTuple" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectFn" },
            { _tag: "PatternDoc" }, { _tag: "SchemaDef" }, { _tag: "ServiceLayer" }, { _tag: "ServiceTag" },
            { _tag: "TaggedError" }, { _tag: "VitestCase" }, () => {})
      .exhaustive()
  }

  for (const [key, idx] of harnessGraph.nodeIndexByKey) {
    if (!nodeIndexById.has(key)) nodeIndexById.set(key, idx)
  }

  return {
    nodeByIndex, nodeIndexById, incomingByTarget, outgoingBySource, providedServiceIds,
    requiredServiceIds, producedErrorIds, handledErrorIds, reachableNodeIds,
    appEntryIndices, exportedTestIndices, incomingRequires, incomingLayerRequires,
    incomingProvides, incomingFailsWith, incomingTestOrCall, incomingPropertyTests,
    incomingRichPropertyTests, hasVitestCases,
  }
}

export const augmentReachabilityWithInference = (
  ctx: GraphReachabilityContext, graph: HarnessGraph, inferred: GraphInferenceResult,
): void => {
  for (const r of inferred.effectiveRequires) { const i = graph.nodeIndexByKey.get(r.serviceKey); if (i !== undefined && (ctx.incomingRequires.get(i) ?? 0) === 0) ctx.incomingRequires.set(i, 1) }
  for (const f of inferred.effectiveFailsWith) { const i = graph.nodeIndexByKey.get(f.errorKey); if (i !== undefined && (ctx.incomingFailsWith.get(i) ?? 0) === 0) ctx.incomingFailsWith.set(i, 1) }
  for (const d of inferred.effectiveLayerDeps) { const i = graph.nodeIndexByKey.get(d.requiredServiceKey); if (i !== undefined && (ctx.incomingLayerRequires.get(i) ?? 0) === 0) ctx.incomingLayerRequires.set(i, 1) }
  for (const t of inferred.effectiveTestReach) {
    const i = graph.nodeIndexByKey.get(t.targetSpanKey)
    if (i !== undefined) {
      if ((ctx.incomingTestOrCall.get(i) ?? 0) === 0) ctx.incomingTestOrCall.set(i, 1)
      if (t.isPropertyTest && (ctx.incomingPropertyTests.get(i) ?? 0) === 0) ctx.incomingPropertyTests.set(i, 1)
    }
  }
}

export const levenshteinDistance = (a: string, b: string): number => {
  const m = a.length, n = b.length
  const dp: Array<Array<number>> = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

export const findClosestMatch = (
  target: string, candidates: Iterable<string>, maxDistanceThreshold?: number,
): string | undefined => {
  const threshold = maxDistanceThreshold ?? Math.max(3, Math.floor(target.length * 0.35))
  let closest: string | undefined, minDistance = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    if (c === target) continue
    const d = levenshteinDistance(target, c)
    if (d < minDistance && d <= threshold) { minDistance = d; closest = c }
  }
  return closest
}

const extractBalancedPair = (
  text: string, openIdx: number, openCh: "{" | "(", closeCh: "}" | ")",
): { readonly body: string; readonly endIndex: number } | undefined => {
  if (text[openIdx] !== openCh) return undefined
  let depth = 0, i = openIdx
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch; i += 1
      while (i < text.length) {
        if (text[i] === "\\") i += 2; else if (text[i] === q) { i += 1; break } else i += 1
      }
      continue
    }
    if (ch === openCh) depth++
    else if (ch === closeCh && --depth === 0) return { body: text.slice(openIdx + 1, i), endIndex: i }
    i++
  }
  return undefined
}

export const extractBalancedBraces = (text: string, openBraceIndex: number) => extractBalancedPair(text, openBraceIndex, "{", "}")
export const extractBalancedParens = (text: string, openParenIndex: number) => extractBalancedPair(text, openParenIndex, "(", ")")

export const extractTopLevelObjectAnalysis = (
  objBody: string,
): { readonly keys: ReadonlyArray<string>; readonly spreads: ReadonlyArray<string> } => {
  const keys: Array<string> = [], spreads: Array<string> = []
  let b = 0, p = 0, k = 0, i = 0
  while (i < objBody.length) {
    const ch = objBody[i]!
    if (b === 0 && p === 0 && k === 0) {
      if (objBody.startsWith("...", i)) {
        const m = /^\.\.\.([A-Za-z_$][\w$]*)/.exec(objBody.slice(i))
        if (m) { spreads.push(m[1]!); i += m[0].length; continue }
      }
      const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(objBody.slice(i))
      if (m) { const name = m[1] ?? m[2] ?? m[3]; if (name) keys.push(name); i += m[0].length; continue }
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch; i += 1
      while (i < objBody.length) {
        if (objBody[i] === "\\") i += 2; else if (objBody[i] === q) { i += 1; break } else i += 1
      }
      continue
    }
    if (ch === "{") b++; else if (ch === "}") b = Math.max(0, b - 1)
    else if (ch === "(") p++; else if (ch === ")") p = Math.max(0, p - 1)
    else if (ch === "[") k++; else if (ch === "]") k = Math.max(0, k - 1)
    i++
  }
  return { keys, spreads }
}

export const parseGovernanceDocFrontmatter = (
  docPath: string, markdown: string, existingFileCheck?: (relPath: string) => boolean,
): GovernanceDocReference | null => {
  const normalized = markdown.replace(/^\uFEFF/, "")
  const matchFrontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!matchFrontmatter || matchFrontmatter[1] === undefined) return null

  const lines = matchFrontmatter[1].split(/\r?\n/)
  const scalars = new Map<string, string>(), lists = new Map<string, Array<string>>()
  let currentListKey: string | null = null

  const stripQuotes = (val: string): string => {
    let t = val.trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim()
    const hash = t.indexOf("#")
    return hash !== -1 ? t.slice(0, hash).trim() : t
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) { const l = lists.get(currentListKey); if (l) l.push(item) }
      continue
    }
    currentListKey = null
    const kv = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (!kv) continue
    const key = kv[1]!.trim(), rest = kv[2]!.trim()
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim()
      lists.set(key, inner.length === 0 ? [] : inner.split(",").map(stripQuotes).filter((s) => s.length > 0))
    } else if (rest === "") {
      lists.set(key, []); currentListKey = key
    } else {
      scalars.set(key, stripQuotes(rest))
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") return null
  const rawStatus = scalars.get("status")
  const status: GovernanceDocStatus =
    rawStatus === "accepted" || rawStatus === "proposed" || rawStatus === "superseded" || rawStatus === "deprecated"
      ? rawStatus : "proposed"

  const enforcedByRaw = lists.get("enforced_by")
  const enforcedByFiles: ReadonlyArray<string> | undefined = enforcedByRaw
  const existingFiles: ReadonlyArray<string> | undefined =
    enforcedByRaw !== undefined ? (existingFileCheck ? enforcedByRaw.filter(existingFileCheck) : [...enforcedByRaw]) : undefined
  const referencedSpans = lists.get("spans"), referencedServices = lists.get("services"), referencedErrors = lists.get("errors")
  const isSpecOrAdr = docPath.includes("/specs/") || docPath.includes("/adr/") || id.includes(":SPEC-") || id.includes(":ADR-") || id.startsWith("ADR-") || id.startsWith("SPEC-")

  return {
    docPath, id, status,
    ...(isSpecOrAdr ? { markdown } : {}),
    ...(enforcedByFiles !== undefined ? { enforcedByFiles, existingFiles } : {}),
    ...(referencedSpans !== undefined ? { referencedSpans } : {}),
    ...(referencedServices !== undefined ? { referencedServices } : {}),
    ...(referencedErrors !== undefined ? { referencedErrors } : {}),
  }
}

export const safeFs = <T>(fn: () => T, fallback: T): T =>
  Effect.runSync(
    Effect.try({
      try: fn,
      catch: (err) => {
        process.stderr.write(
          `[harness:gc] Warning: filesystem operation failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return fallback
      },
    }).pipe(Effect.orElseSucceed(() => fallback)),
  )

export const loadGovernanceDocsFromDisk = (repoRoot: string): ReadonlyArray<GovernanceDocReference> => {
  const relDirs: Array<string> = ["docs/adr", "docs/specs"]
  const listSubs = (p: string): ReadonlyArray<string> => {
    const full = join(repoRoot, p)
    return !existsSync(full) ? [] : safeFs<ReadonlyArray<Dirent>>(() => readdirSync(full, { withFileTypes: true }), [])
      .filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b))
  }
  for (const s of listSubs("libs")) relDirs.push(`libs/${s}/docs/adr`, `libs/${s}/docs/specs`)
  for (const a of listSubs("apps")) relDirs.push(`apps/${a}/docs/adr`, `apps/${a}/docs/specs`)

  const results: Array<GovernanceDocReference> = []
  for (const relDir of relDirs) {
    const fullDir = join(repoRoot, relDir)
    if (!existsSync(fullDir)) continue
    const files = safeFs<ReadonlyArray<Dirent>>(() => readdirSync(fullDir, { withFileTypes: true }), [])
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md" && e.name !== "TEMPLATE.md")
      .map((e) => e.name).sort((a, b) => a.localeCompare(b))
    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const content = safeFs(() => readFileSync(join(repoRoot, relDocPath), "utf8"), "")
      const parsed = parseGovernanceDocFrontmatter(relDocPath, content, (rel) => existsSync(join(repoRoot, rel)))
      if (parsed === null) continue
      const enforcedByFileContents: Record<string, string> = {}
      for (const ef of parsed.enforcedByFiles ?? []) {
        const fullEf = join(repoRoot, ef)
        if (existsSync(fullEf)) enforcedByFileContents[ef] = safeFs(() => readFileSync(fullEf, "utf8"), "")
      }
      const isSpecOrAdr = relDir.endsWith("/specs") || relDir.endsWith("/adr") || parsed.id.includes(":SPEC-") || parsed.id.includes(":ADR-") || parsed.id.startsWith("ADR-") || parsed.id.startsWith("SPEC-")
      results.push({ ...parsed, ...(isSpecOrAdr ? { markdown: content } : {}), enforcedByFileContents })
    }
  }
  return results
}

const EXCLUDED_WORKSPACE_SCAN_DIRS = new Set(["node_modules", "dist", "repos", ".git", ".nx", "coverage"])
const EXCLUDED_MODULAR_SCAN_DIRS = new Set([...EXCLUDED_WORKSPACE_SCAN_DIRS, "test"])

const collectWorkspaceFiles = (
  dir: string,
  predicate: (name: string) => boolean,
  excludedDirs: ReadonlySet<string> = EXCLUDED_WORKSPACE_SCAN_DIRS,
): ReadonlyArray<string> => {
  if (!existsSync(dir)) return []
  return safeFs<ReadonlyArray<string>>(() => {
    const result: Array<string> = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!excludedDirs.has(e.name)) result.push(...collectWorkspaceFiles(full, predicate, excludedDirs))
      } else if (e.isFile() && predicate(e.name)) result.push(full)
    }
    return result.sort((a, b) => a.localeCompare(b))
  }, [])
}

export const collectWorkspaceTsFiles = (dir: string): ReadonlyArray<string> => collectWorkspaceFiles(dir, (n) => (n.endsWith(".ts") || n.endsWith(".tsx")) && !n.endsWith(".d.ts"))
export const collectWorkspaceSqlFiles = (dir: string): ReadonlyArray<string> => collectWorkspaceFiles(dir, (n) => n.endsWith(".sql"))
export const collectWorkspaceAllFiles = (dir: string): ReadonlyArray<string> => collectWorkspaceFiles(dir, () => true)

export const collectModularPluginFiles = (repoRoot: string): ReadonlyArray<string> =>
  [...new Set(["libs", "apps"].map((d) => join(repoRoot, d)).filter((d) => existsSync(d)).flatMap((d) => collectWorkspaceFiles(d, (n) => (n.endsWith(".ts") || n.endsWith(".tsx")) && !n.endsWith(".d.ts"), EXCLUDED_MODULAR_SCAN_DIRS).filter((f) => isModularPluginPath(relative(repoRoot, f).replace(/\\/g, "/")))))].sort((a, b) => a.localeCompare(b))
