import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import type { GovernanceDocStatus, HarnessGraph } from "@harness/graph"
import { decideEarsSpecQuality } from "./ears-lint.js"
import { decideAdrDocQuality } from "./adr-lint.js"
import { decideOntologyInvariants } from "./ontology-invariants.js"

export type GcFindingKind =
  | "unused-service"
  | "unprovided-service"
  | "dead-tagged-error"
  | "orphan-effect-fn"
  | "missing-pattern-doc"
  | "untested-effect-fn"
  | "missing-decider-property-test"
  | "shallow-decider-property-test"
  | "empty-source-module"
  | "unused-package-dependency"
  | "stale-doc-reference"
  | "ears-spec-lint"
  | "adr-doc-lint"
  | "ontology-invariant"

export interface GcFinding {
  readonly kind: GcFindingKind
  readonly nodeId: string
  readonly message: string
}

export interface GcReport {
  readonly clean: boolean
  readonly findings: ReadonlyArray<GcFinding>
}

export type { GovernanceDocStatus }

export interface GovernanceDocReference {
  readonly docPath: string
  readonly id: string
  readonly status: GovernanceDocStatus
  readonly markdown?: string | undefined
  readonly enforcedByFiles?: ReadonlyArray<string> | undefined
  readonly existingFiles?: ReadonlyArray<string> | undefined
  readonly referencedSpans?: ReadonlyArray<string> | undefined
  readonly referencedServices?: ReadonlyArray<string> | undefined
  readonly referencedErrors?: ReadonlyArray<string> | undefined
}

export interface GraphEntropyInput {
  readonly graph: HarnessGraph
  readonly expectedPatterns?: ReadonlyArray<string> | undefined
  readonly checkUntestedDomainFns?: boolean | undefined
  readonly checkDeciderPropertyTests?: boolean | undefined
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
}

const IGNORED_SERVICES = new Set([
  "DecisionModel",
  "DecisionModel.DecisionModel",
  "OmnigraphSync",
  "SpanRecorder",
  "@harness/ingest/SpanRecorder",
  "SampleApiClient",
  "ActiveCounterStore"
])

const IGNORED_ERRORS = new Set([
  "OmnigraphLoadError",
  "SchemaError",
  "UnknownToolError"
])

const IGNORED_UNTESTED_FNS = new Set([
  "Friction.decide",
  "GraphGc.decide",
  "MigrationSafety.decide",
  "MutationCheck.decide",
  "SessionHandoff.decide",
  "SpanBudget.decide",
  "Harness.decideGuardCommand",
  "Harness.routeStep",
  "Harness.proposeLearningAction",
  "Harness.checkPlanStepCoverage",
  "Harness.triageFailure",
  "EarsSpecLint.decide",
  "AdrDocLint.decide",
  "OntologyInvariants.decide",
  "SessionReport.decide",
  "Harness.checkOntologyPairConflict",
  "Harness.evaluateOntologyConflicts",
  "HarnessMcp.executeTool"
])

export const decideGraphEntropy = Effect.fn("GraphGc.decide")(function* (
  input: GraphEntropyInput
) {
  yield* Effect.void

  const g = input.graph.graph
  const findings: Array<GcFinding> = []

  const incomingRequires = new Map<Graph.NodeIndex, number>()
  const incomingLayerRequires = new Map<Graph.NodeIndex, number>()
  const incomingProvides = new Map<Graph.NodeIndex, number>()
  const incomingFailsWith = new Map<Graph.NodeIndex, number>()
  const incomingTestOrCall = new Map<Graph.NodeIndex, number>()
  const incomingPropertyTests = new Map<Graph.NodeIndex, number>()
  const incomingRichPropertyTests = new Map<Graph.NodeIndex, number>()

  for (const [, edge] of Graph.edges(g)) {
    if (edge.data._tag === "RequiresService") {
      incomingRequires.set(edge.target, (incomingRequires.get(edge.target) ?? 0) + 1)
    } else if (edge.data._tag === "LayerRequires") {
      incomingLayerRequires.set(edge.target, (incomingLayerRequires.get(edge.target) ?? 0) + 1)
    } else if (edge.data._tag === "ProvidesService") {
      const srcNode = Graph.getNode(g, edge.source)
      if (Option.isSome(srcNode) && srcNode.value._tag === "ServiceLayer") {
        incomingProvides.set(edge.target, (incomingProvides.get(edge.target) ?? 0) + 1)
      }
    } else if (edge.data._tag === "FailsWith") {
      incomingFailsWith.set(edge.target, (incomingFailsWith.get(edge.target) ?? 0) + 1)
    } else if (edge.data._tag === "ExercisesSpan" || edge.data._tag === "TracedCall") {
      incomingTestOrCall.set(edge.target, (incomingTestOrCall.get(edge.target) ?? 0) + 1)
      if (edge.data._tag === "ExercisesSpan") {
        const srcNode = Graph.getNode(g, edge.source)
        if (
          Option.isSome(srcNode) &&
          srcNode.value._tag === "VitestCase" &&
          srcNode.value.isPropertyTest === true
        ) {
          incomingPropertyTests.set(
            edge.target,
            (incomingPropertyTests.get(edge.target) ?? 0) + 1
          )
          if (
            (srcNode.value as { readonly hasNonPrimitiveArbitrary?: boolean | undefined })
              .hasNonPrimitiveArbitrary !== false
          ) {
            incomingRichPropertyTests.set(
              edge.target,
              (incomingRichPropertyTests.get(edge.target) ?? 0) + 1
            )
          }
        }
      }
    }
  }

  let hasVitestCases = false
  for (const [, node] of Graph.nodes(g)) {
    if (node._tag === "VitestCase") {
      hasVitestCases = true
      break
    }
  }

  // 1. unused-service
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "ServiceTag") {
      if (IGNORED_SERVICES.has(node.tagId) || IGNORED_SERVICES.has(node.name)) {
        continue
      }
      const totalConsumers =
        (incomingRequires.get(idx) ?? 0) + (incomingLayerRequires.get(idx) ?? 0)
      if (totalConsumers === 0) {
        findings.push({
          kind: "unused-service",
          nodeId: node.tagId,
          message: `ServiceTag "${node.tagId}" has no consumers (0 RequiresService / LayerRequires edges).`
        })
      }
    }
  }

  // 2. unprovided-service
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "ServiceTag") {
      if (IGNORED_SERVICES.has(node.tagId) || IGNORED_SERVICES.has(node.name)) {
        continue
      }
      const providers = incomingProvides.get(idx) ?? 0
      if (providers === 0) {
        findings.push({
          kind: "unprovided-service",
          nodeId: node.tagId,
          message: `ServiceTag "${node.tagId}" has no providing ServiceLayer (0 ProvidesService edges).`
        })
      }
    }
  }

  // 3. dead-tagged-error
  for (const [idx, node] of Graph.nodes(g)) {
    if (node._tag === "TaggedError") {
      if (IGNORED_ERRORS.has(node.errorTag)) {
        continue
      }
      const failsWithCount = incomingFailsWith.get(idx) ?? 0
      if (failsWithCount === 0) {
        findings.push({
          kind: "dead-tagged-error",
          nodeId: node.errorTag,
          message: `TaggedError "${node.errorTag}" is never emitted in any E channel (0 FailsWith edges).`
        })
      }
    }
  }

  // 4. missing-pattern-doc
  if (input.expectedPatterns !== undefined) {
    const existingPatternSlugs = new Set<string>()
    for (const [, node] of Graph.nodes(g)) {
      if (node._tag === "PatternDoc") {
        existingPatternSlugs.add(node.slug)
        if ("patternName" in node && typeof (node as any).patternName === "string") {
          existingPatternSlugs.add((node as any).patternName)
        }
        if (typeof node.path === "string" && node.path.endsWith(".md")) {
          const base = node.path.split("/").pop()?.replace(/\.md$/, "")
          if (base) {
            existingPatternSlugs.add(base)
          }
        }
      }
    }

    for (const p of input.expectedPatterns) {
      if (p === "review" || p === "effect") {
        continue
      }
      if (!existingPatternSlugs.has(p)) {
        findings.push({
          kind: "missing-pattern-doc",
          nodeId: `Pattern:${p}`,
          message: `Pattern doc "agent-patterns/${p}.md" registered in IdiomRouterV1 is missing from the graph.`
        })
      }
    }
  }

  // 5. untested-effect-fn
  if (input.checkUntestedDomainFns === true || hasVitestCases) {
    for (const [idx, node] of Graph.nodes(g)) {
      if (
        node._tag === "EffectFn" &&
        (node.packageTag === "domain" || node.packageTag === "contract") &&
        !node.isStub &&
        !IGNORED_UNTESTED_FNS.has(node.spanName)
      ) {
        if ((incomingTestOrCall.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "untested-effect-fn",
            nodeId: node.spanName,
            message: `Domain EffectFn "${node.spanName}" (${node.qualname}) has 0 reaching tests (0 ExercisesSpan / TracedCall edges).`
          })
        }
      }
    }
  }

  // 6. stale-doc-reference
  const docRefs: Array<GovernanceDocReference> = []
  const seenDocIds = new Set<string>()
  if (input.governanceDocs !== undefined && input.governanceDocs.length > 0) {
    for (const doc of input.governanceDocs) {
      docRefs.push(doc)
      seenDocIds.add(doc.id)
    }
  }

  for (const [, node] of Graph.nodes(g)) {
    if ((node._tag === "AdrDoc" || node._tag === "EarsSpec") && !seenDocIds.has(node.id)) {
      seenDocIds.add(node.id)
      docRefs.push({
        docPath: node.path,
        id: node.id,
        status: node.status,
        enforcedByFiles: node.enforcedByFiles,
        referencedSpans: node.referencedSpans,
        referencedServices: node.referencedServices,
        referencedErrors: node.referencedErrors
      })
    }
  }

  if (docRefs.length > 0) {
    const knownSpans = new Set<string>()
    const knownServices = new Set<string>()
    const knownErrors = new Set<string>()

    for (const [, node] of Graph.nodes(g)) {
      if (node._tag === "EffectFn") {
        knownSpans.add(node.spanName)
        knownSpans.add(node.qualname)
      } else if (node._tag === "ServiceTag") {
        knownServices.add(node.tagId)
        knownServices.add(node.name)
      } else if (node._tag === "TaggedError") {
        knownErrors.add(node.errorTag)
      }
    }

    for (const doc of docRefs) {
      if (doc.status !== "accepted") {
        continue
      }

      if (doc.enforcedByFiles !== undefined && doc.existingFiles !== undefined) {
        const existingSet = new Set(doc.existingFiles)
        for (const file of doc.enforcedByFiles) {
          if (!existingSet.has(file)) {
            findings.push({
              kind: "stale-doc-reference",
              nodeId: `${doc.id}:${file}`,
              message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent enforced_by file "${file}".`
            })
          }
        }
      }

      for (const span of doc.referencedSpans ?? []) {
        if (!knownSpans.has(span)) {
          findings.push({
            kind: "stale-doc-reference",
            nodeId: `${doc.id}:${span}`,
            message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent EffectFn span "${span}".`
          })
        }
      }

      for (const svc of doc.referencedServices ?? []) {
        if (!knownServices.has(svc)) {
          findings.push({
            kind: "stale-doc-reference",
            nodeId: `${doc.id}:${svc}`,
            message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent ServiceTag "${svc}".`
          })
        }
      }

      for (const err of doc.referencedErrors ?? []) {
        if (!knownErrors.has(err)) {
          findings.push({
            kind: "stale-doc-reference",
            nodeId: `${doc.id}:${err}`,
            message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent TaggedError "${err}".`
          })
        }
      }

      if (doc.markdown !== undefined) {
        const mermaidRegex = /```mermaid([\s\S]*?)```/g
        const ignoredMermaidErrors = new Set([
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "TaggedError",
          "SchemaError",
          "UnknownToolError",
          "OmnigraphLoadError"
        ])
        const seenDocMermaidErrors = new Set<string>()
        let mermaidMatch: RegExpExecArray | null
        while ((mermaidMatch = mermaidRegex.exec(doc.markdown)) !== null) {
          const block = mermaidMatch[1] ?? ""
          const errRegex = /\b([A-Z][A-Za-z0-9_]*Error)\b/g
          let errMatch: RegExpExecArray | null
          while ((errMatch = errRegex.exec(block)) !== null) {
            const errName = errMatch[1]!
            if (!ignoredMermaidErrors.has(errName) && !seenDocMermaidErrors.has(errName)) {
              seenDocMermaidErrors.add(errName)
              if (!knownErrors.has(errName)) {
                findings.push({
                  kind: "stale-doc-reference",
                  nodeId: `${doc.id}:${errName}`,
                  message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent TaggedError "${errName}" in a Mermaid diagram.`
                })
              }
            }
          }
        }
      }
    }
  }

  // 7. missing-decider-property-test
  if (input.checkDeciderPropertyTests === true) {
    for (const [idx, node] of Graph.nodes(g)) {
      if (
        node._tag === "EffectFn" &&
        (node.packageTag === "domain" || node.packageTag === "contract") &&
        !node.isStub &&
        (node.spanName.endsWith(".decide") || node.spanName === "decide") &&
        !IGNORED_UNTESTED_FNS.has(node.spanName)
      ) {
        if ((incomingPropertyTests.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "missing-decider-property-test",
            nodeId: node.spanName,
            message: `Pure domain decider "${node.spanName}" (${node.qualname}) has 0 Property-Based Tests (use it.effect.prop / it.prop with Schema arbitraries to prevent example-only blind spots).`
          })
        } else if ((incomingRichPropertyTests.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "shallow-decider-property-test",
            nodeId: node.spanName,
            message: `Pure domain decider "${node.spanName}" (${node.qualname}) is only exercised by scalar/primitive property tests — generate domain Event or Command schemas (e.g. Schema.Array(EventSchema)) in it.prop / it.effect.prop.`
          })
        }
      }
    }
  }

  // 8. ears-spec-lint
  for (const doc of input.governanceDocs ?? []) {
    if (doc.markdown !== undefined && (doc.docPath.includes("/specs/") || doc.id.includes(":SPEC-"))) {
      const lintReport = yield* decideEarsSpecQuality({ docPath: doc.docPath, markdown: doc.markdown })
      for (const f of lintReport.findings) {
        findings.push({
          kind: "ears-spec-lint",
          nodeId: doc.id,
          message: `EARS spec "${doc.id}" (${doc.docPath}:${f.line}) [${f.kind}]: ${f.message}`
        })
      }
    }
  }

  // 9. adr-doc-lint
  for (const doc of input.governanceDocs ?? []) {
    if (
      doc.markdown !== undefined &&
      (doc.docPath.includes("/adr/") || doc.id.includes(":ADR-") || doc.id.startsWith("ADR-"))
    ) {
      const adrLint = yield* decideAdrDocQuality({ docPath: doc.docPath, markdown: doc.markdown })
      for (const f of adrLint.findings) {
        findings.push({
          kind: "adr-doc-lint",
          nodeId: doc.id,
          message: `ADR doc "${doc.id}" (${doc.docPath}:${f.line}) [${f.kind}]: ${f.message}`
        })
      }
    }
  }

  // 10. ontology-invariants
  const ontologyReport = yield* decideOntologyInvariants({
    graph: input.graph,
    governanceDocs: input.governanceDocs
  })
  for (const f of ontologyReport.findings) {
    findings.push({
      kind: "ontology-invariant",
      nodeId: f.nodeId,
      message: `[${f.kind}] ${f.message}`
    })
  }

  return {
    clean: findings.length === 0,
    findings
  } satisfies GcReport
})

export const scanGraphEntropy = (
  graph: HarnessGraph,
  options?: {
    readonly expectedPatterns?: ReadonlyArray<string> | undefined
    readonly checkUntestedDomainFns?: boolean | undefined
    readonly checkDeciderPropertyTests?: boolean | undefined
    readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
  }
): GcReport =>
  Effect.runSync(
    decideGraphEntropy({
      graph,
      expectedPatterns: options?.expectedPatterns,
      checkUntestedDomainFns: options?.checkUntestedDomainFns,
      checkDeciderPropertyTests: options?.checkDeciderPropertyTests,
      governanceDocs: options?.governanceDocs
    })
  )

export const parseGovernanceDocFrontmatter = (
  docPath: string,
  markdown: string,
  existingFileCheck?: (relPath: string) => boolean
): GovernanceDocReference | null => {
  const normalized = markdown.replace(/^\uFEFF/, "")
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match || match[1] === undefined) {
    return null
  }

  const yamlContent = match[1]
  const lines = yamlContent.split(/\r?\n/)

  const scalars = new Map<string, string>()
  const lists = new Map<string, Array<string>>()

  let currentListKey: string | null = null

  const stripQuotes = (val: string): string => {
    let trimmed = val.trim()
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim()
    }
    const hashIdx = trimmed.indexOf("#")
    if (hashIdx !== -1) {
      trimmed = trimmed.slice(0, hashIdx).trim()
    }
    return trimmed
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) {
        const list = lists.get(currentListKey)
        if (list) {
          list.push(item)
        }
      }
      continue
    }

    currentListKey = null

    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim()
      const rest = keyValMatch[2]!.trim()

      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        const items =
          inner.length === 0
            ? []
            : inner
                .split(",")
                .map(stripQuotes)
                .filter((s) => s.length > 0)
        lists.set(key, items)
      } else if (rest === "") {
        lists.set(key, [])
        currentListKey = key
      } else {
        scalars.set(key, stripQuotes(rest))
      }
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") {
    return null
  }

  const rawStatus = scalars.get("status")
  const status: GovernanceDocStatus =
    rawStatus === "accepted" ||
    rawStatus === "proposed" ||
    rawStatus === "superseded" ||
    rawStatus === "deprecated"
      ? rawStatus
      : "proposed"

  const enforcedByRaw = lists.get("enforced_by")
  const enforcedByFiles: ReadonlyArray<string> | undefined = enforcedByRaw
  const existingFiles: ReadonlyArray<string> | undefined =
    enforcedByRaw !== undefined
      ? existingFileCheck !== undefined
        ? enforcedByRaw.filter(existingFileCheck)
        : [...enforcedByRaw]
      : undefined

  const referencedSpans = lists.get("spans")
  const referencedServices = lists.get("services")
  const referencedErrors = lists.get("errors")

  const isSpecOrAdr =
    docPath.includes("/specs/") ||
    docPath.includes("/adr/") ||
    id.includes(":SPEC-") ||
    id.includes(":ADR-") ||
    id.startsWith("ADR-") ||
    id.startsWith("SPEC-")

  return {
    docPath,
    id,
    status,
    ...(isSpecOrAdr ? { markdown } : {}),
    ...(enforcedByFiles !== undefined ? { enforcedByFiles, existingFiles } : {}),
    ...(referencedSpans !== undefined ? { referencedSpans } : {}),
    ...(referencedServices !== undefined ? { referencedServices } : {}),
    ...(referencedErrors !== undefined ? { referencedErrors } : {})
  }
}

export const loadGovernanceDocsFromDisk = (
  repoRoot: string
): ReadonlyArray<GovernanceDocReference> => {
  const candidateRelDirs: Array<string> = ["docs/adr", "docs/specs"]

  const listSubdirectories = (parentRel: string): ReadonlyArray<string> => {
    const parentPath = join(repoRoot, parentRel)
    return Effect.runSync(
      Effect.try({
        try: () => {
          if (!existsSync(parentPath)) {
            return []
          }
          return readdirSync(parentPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b))
        },
        catch: () => []
      }).pipe(Effect.orElseSucceed(() => []))
    )
  }

  const libScopes = listSubdirectories("libs")
  for (const scope of libScopes) {
    candidateRelDirs.push(`libs/${scope}/docs/adr`)
    candidateRelDirs.push(`libs/${scope}/docs/specs`)
  }

  const appNames = listSubdirectories("apps")
  for (const app of appNames) {
    candidateRelDirs.push(`apps/${app}/docs/adr`)
    candidateRelDirs.push(`apps/${app}/docs/specs`)
  }

  const results: Array<GovernanceDocReference> = []

  for (const relDir of candidateRelDirs) {
    const fullDir = join(repoRoot, relDir)
    if (!existsSync(fullDir)) {
      continue
    }

    const entries = Effect.runSync(
      Effect.try({
        try: () => readdirSync(fullDir, { withFileTypes: true }),
        catch: () => []
      }).pipe(Effect.orElseSucceed(() => []))
    )

    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "README.md" &&
          entry.name !== "TEMPLATE.md"
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const fullPath = join(repoRoot, relDocPath)
      const content = Effect.runSync(
        Effect.try({
          try: () => readFileSync(fullPath, "utf8"),
          catch: () => ""
        }).pipe(Effect.orElseSucceed(() => ""))
      )

      const parsed = parseGovernanceDocFrontmatter(
        `${relDir}/${file}`,
        content,
        (rel) => existsSync(join(repoRoot, rel))
      )

      if (parsed !== null) {
        if (
          relDir.endsWith("/specs") ||
          relDir.endsWith("/adr") ||
          parsed.id.includes(":SPEC-") ||
          parsed.id.includes(":ADR-") ||
          parsed.id.startsWith("ADR-") ||
          parsed.id.startsWith("SPEC-")
        ) {
          results.push({
            ...parsed,
            markdown: content
          })
        } else {
          results.push(parsed)
        }
      }
    }
  }

  return results
}

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PackageJsonSchema)
)

const SKIPPED_PACKAGE_DEPS = new Set([
  "effect",
  "@effect/sql-d1",
  "@effect/sql-sqlite-do",
  "@effect/ai-typesafe",
  "drizzle-orm"
])

export const scanWorkspacePackageHygiene = (
  repoRoot: string
): ReadonlyArray<GcFinding> => {
  const libsDir = join(repoRoot, "libs")
  const scopes = Effect.runSync(
    Effect.try({
      try: () => {
        if (!existsSync(libsDir)) {
          return []
        }
        return readdirSync(libsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b))
      },
      catch: () => []
    }).pipe(Effect.orElseSucceed(() => []))
  )

  const collectTsFiles = (dir: string): ReadonlyArray<string> =>
    Effect.runSync(
      Effect.try({
        try: () => {
          if (!existsSync(dir)) {
            return []
          }
          const entries = readdirSync(dir, { withFileTypes: true })
          const result: Array<string> = []
          for (const entry of entries) {
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              result.push(...collectTsFiles(full))
            } else if (
              entry.isFile() &&
              (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
              !entry.name.endsWith(".d.ts")
            ) {
              result.push(full)
            }
          }
          return result.sort((a, b) => a.localeCompare(b))
        },
        catch: () => []
      }).pipe(Effect.orElseSucceed(() => []))
    )

  const collectAllFiles = (dir: string): ReadonlyArray<string> =>
    Effect.runSync(
      Effect.try({
        try: () => {
          if (!existsSync(dir)) {
            return []
          }
          const entries = readdirSync(dir, { withFileTypes: true })
          const result: Array<string> = []
          for (const entry of entries) {
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              result.push(...collectAllFiles(full))
            } else if (entry.isFile()) {
              result.push(full)
            }
          }
          return result.sort((a, b) => a.localeCompare(b))
        },
        catch: () => []
      }).pipe(Effect.orElseSucceed(() => []))
    )

  const findings: Array<GcFinding> = []

  for (const scope of scopes) {
    const scopeDir = join(libsDir, scope)
    const tiers = Effect.runSync(
      Effect.try({
        try: () => {
          if (!existsSync(scopeDir)) {
            return []
          }
          return readdirSync(scopeDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b))
        },
        catch: () => []
      }).pipe(Effect.orElseSucceed(() => []))
    )

    for (const tier of tiers) {
      const tierDir = join(scopeDir, tier)
      const srcDir = join(tierDir, "src")
      const hasSrc = Effect.runSync(
        Effect.try({
          try: () => existsSync(srcDir),
          catch: () => false
        }).pipe(Effect.orElseSucceed(() => false))
      )
      if (!hasSrc) {
        continue
      }

      const srcFiles = collectTsFiles(srcDir)
      for (const file of srcFiles) {
        const content = Effect.runSync(
          Effect.try({
            try: () => readFileSync(file, "utf8"),
            catch: () => ""
          }).pipe(Effect.orElseSucceed(() => ""))
        )
        const stripped = content
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\r\n]*/g, "")
          .replace(/\s+/g, "")
        if (stripped === "" || stripped === "export{}" || stripped === "export{};") {
          const relFilePath = relative(repoRoot, file).replace(/\\/g, "/")
          findings.push({
            kind: "empty-source-module",
            nodeId: relFilePath,
            message: `Source module "${relFilePath}" contains only an empty export ('export {}') — remove dead placeholder modules or export concrete contracts.`
          })
        }
      }

      const pkgJsonPath = join(tierDir, "package.json")
      const pkgContent = Effect.runSync(
        Effect.try({
          try: () => (existsSync(pkgJsonPath) ? readFileSync(pkgJsonPath, "utf8") : ""),
          catch: () => ""
        }).pipe(Effect.orElseSucceed(() => ""))
      )

      if (pkgContent.length > 0) {
        const pkgOpt = decodePackageJson(pkgContent)
        if (Option.isSome(pkgOpt) && pkgOpt.value.dependencies !== undefined) {
          const dependencies = pkgOpt.value.dependencies
          const pkgName = pkgOpt.value.name ?? `${scope}/${tier}`
          const scriptsDir = join(tierDir, "scripts")
          const scriptFiles = Effect.runSync(
            Effect.try({
              try: () => (existsSync(scriptsDir) ? collectAllFiles(scriptsDir) : []),
              catch: () => []
            }).pipe(Effect.orElseSucceed(() => []))
          )
          const allPackageFiles = [...srcFiles, ...scriptFiles]
          const combinedContent = allPackageFiles
            .map((f) =>
              Effect.runSync(
                Effect.try({
                  try: () => readFileSync(f, "utf8"),
                  catch: () => ""
                }).pipe(Effect.orElseSucceed(() => ""))
              )
            )
            .join("\n")

          for (const depName of Object.keys(dependencies)) {
            if (SKIPPED_PACKAGE_DEPS.has(depName)) {
              continue
            }
            const isReferenced =
              combinedContent.includes(`"${depName}"`) ||
              combinedContent.includes(`'${depName}'`) ||
              combinedContent.includes(`"${depName}/`) ||
              combinedContent.includes(`'${depName}/`)
            if (!isReferenced) {
              findings.push({
                kind: "unused-package-dependency",
                nodeId: `${pkgName}:${depName}`,
                message: `Package "${pkgName}" declares dependency "${depName}" in package.json, but no file in src/ imports it.`
              })
            }
          }
        }
      }
    }
  }

  return findings
}
