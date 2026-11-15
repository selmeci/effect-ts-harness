import { Effect } from "effect"
import { match } from "ts-pattern"
import * as Graph from "effect/Graph"
import {
  decideGraphInference,
  getNodeKey,
  type HarnessGraph,
  queryOntologyWhy,
  resolveNode,
} from "@harness/graph"
import { decideEarsSpecQuality, type EarsRequirementRow } from "./ears-lint.js"
import type { GovernanceDocReference } from "./plugins/gc/gc-helpers.js"

export type OntologyInvariantFindingKind =
  | "ontology-while-decider-mismatch"
  | "ontology-if-then-error-mismatch"
  | "ontology-conflicting-requirements"
  | "ontology-broken-realization-chain"
  | "ontology-unverified-requirement"
  | "ontology-spec-adr-conflict"

export interface OntologyInvariantFinding {
  readonly kind: OntologyInvariantFindingKind
  readonly nodeId: string
  readonly message: string
}

export interface OntologyInvariantsInput {
  readonly graph: HarnessGraph
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
}

export interface OntologyInvariantsReport {
  readonly clean: boolean
  readonly findings: ReadonlyArray<OntologyInvariantFinding>
}

export const normalizeConditionPrefix = (requirement: string): string => {
  const clean = requirement.replace(/[*_`]/g, "").trim().toLowerCase()
  const matchWithSubject = clean.match(
    /^(.*)(?:,\s*|\s+)(?:then\s+)?the\s+[a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,2}\s+shall\b/,
  )
  if (matchWithSubject && matchWithSubject[1]) {
    return matchWithSubject[1].replace(/,\s*$/, "").trim()
  }
  const matchLeadingSubject = clean.match(
    /^(.*?)(?:,\s*)?(?:then\s+)?the\s+[a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,2}\s+shall\b/,
  )
  if (matchLeadingSubject && matchLeadingSubject[1]) {
    return matchLeadingSubject[1].replace(/,\s*$/, "").trim()
  }
  const matchShall = clean.match(/^(.*?)(?:,\s*)?shall\b/)
  if (matchShall && matchShall[1]) {
    return matchShall[1].replace(/,\s*$/, "").trim()
  }
  return ""
}

const hasShallNot = (text: string): boolean => /\bshall\s+not\b/.test(text)
const hasPlainShall = (text: string): boolean => /\bshall\b/.test(text) && !hasShallNot(text)

const POSITIVE_WORDS = /\b(approve|succeed|allow)\b/i
const NEGATIVE_WORDS = /\b(reject|fail|deny)\b/i

const isContradiction = (textA: string, textB: string): boolean => {
  const normA = textA.toLowerCase()
  const normB = textB.toLowerCase()

  const shallNotA = hasShallNot(normA)
  const shallNotB = hasShallNot(normB)
  if ((shallNotA && hasPlainShall(normB)) || (shallNotB && hasPlainShall(normA))) {
    return true
  }

  const posA = POSITIVE_WORDS.test(normA)
  const negA = NEGATIVE_WORDS.test(normA)
  const posB = POSITIVE_WORDS.test(normB)
  const negB = NEGATIVE_WORDS.test(normB)

  if ((posA && negB) || (negA && posB)) {
    return true
  }

  return false
}

const getDocScope = (doc: GovernanceDocReference): string | undefined => {
  if (doc.id.includes(":")) {
    return doc.id.split(":")[0]
  }
  const match = doc.docPath.match(/(?:libs|apps)\/([^/]+)\//)
  if (match) {
    return match[1]
  }
  return undefined
}

export const decideOntologyInvariants = Effect.fn("OntologyInvariants.decide")(function* (
  input: OntologyInvariantsInput,
) {
  const findings: Array<OntologyInvariantFinding> = []
  const g = input.graph.graph

  const incomingTestOrCall = new Map<Graph.NodeIndex, number>()
  const incomingPropertyTests = new Map<Graph.NodeIndex, number>()

  for (const [relIdx, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "EffectSignature" }, () => {
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, ({ value: { target, data } }) => {
              match<string>(data.role)
                .with("callee", () => {
                  incomingTestOrCall.set(target, (incomingTestOrCall.get(target) ?? 0) + 1)
                })
                .otherwise(() => {})
            })
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
      })
      .with({ _tag: "TraceabilityTuple" }, () => {
        const testNodes: Array<{ readonly isPropertyTest?: boolean | undefined }> = []
        const spanTargets: Array<Graph.NodeIndex> = []
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, ({ value: { target, data } }) => {
              match<string>(data.role)
                .with("exercising-test", "verifying-test", () => {
                  const tNode = Graph.getNode(g, target)
                  match(tNode)
                    .with({ _tag: "Some", value: { _tag: "VitestCase" } }, ({ value }) => {
                      testNodes.push(value)
                    })
                    .with({ _tag: "Some" }, () => {})
                    .with({ _tag: "None" }, () => {})
                    .exhaustive()
                })
                .with("exercised-span", "realizing-symbol", () => {
                  const tNode = Graph.getNode(g, target)
                  match(tNode)
                    .with({ _tag: "Some", value: { _tag: "EffectFn" } }, () => {
                      spanTargets.push(target)
                    })
                    .with({ _tag: "Some" }, () => {})
                    .with({ _tag: "None" }, () => {})
                    .exhaustive()
                })
                .otherwise(() => {})
            })
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
        if (testNodes.length > 0) {
          for (const spanIdx of spanTargets) {
            incomingTestOrCall.set(
              spanIdx,
              (incomingTestOrCall.get(spanIdx) ?? 0) + testNodes.length,
            )
            for (const testNode of testNodes) {
              if (testNode.isPropertyTest === true) {
                incomingPropertyTests.set(spanIdx, (incomingPropertyTests.get(spanIdx) ?? 0) + 1)
              }
            }
          }
        }
      })
      .with({ _tag: "HttpEndpointTuple" }, () => {
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, ({ value: { target, data } }) => {
              match<string>(data.role)
                .with("endpoint-handler", () => {
                  incomingTestOrCall.set(target, (incomingTestOrCall.get(target) ?? 0) + 1)
                })
                .otherwise(() => {})
            })
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
      })
      .with({ _tag: "LayerFlow" }, () => {
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, () => {})
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
      })
      .with({ _tag: "MigrationTuple" }, () => {
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, () => {})
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
      })
      .with(
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectFn" },
        { _tag: "PatternDoc" },
        { _tag: "SchemaDef" },
        { _tag: "ServiceLayer" },
        { _tag: "ServiceTag" },
        { _tag: "TaggedError" },
        { _tag: "VitestCase" },
        () => {},
      )
      .exhaustive()
  }

  let hasVitestCases = false
  for (const [, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "VitestCase" }, () => {
        hasVitestCases = true
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => {},
      )
      .exhaustive()
    if (hasVitestCases) break
  }

  // Augment reachability & decider purity via Stratified Datalog S_1/S_2 (`GraphInfer.decide` / RFC-0004 §8)
  const inferredImpureFnKeys = new Set<string>()
  const inferenceExit = yield* Effect.exit(decideGraphInference(input.graph))
  match(inferenceExit)
    .with({ _tag: "Success" }, ({ value: inferred }) => {
      for (const req of inferred.effectiveRequires) {
        inferredImpureFnKeys.add(req.callerKey)
      }
      for (const anti of inferred.antiPatterns) {
        if (anti.ruleId === "impure-decider") {
          inferredImpureFnKeys.add(anti.nodeKey)
        }
      }
      for (const reach of inferred.effectiveTestReach) {
        const fnIdx = input.graph.nodeIndexByKey.get(reach.targetSpanKey)
        if (fnIdx !== undefined) {
          incomingTestOrCall.set(fnIdx, (incomingTestOrCall.get(fnIdx) ?? 0) + 1)
          if (reach.isPropertyTest) {
            incomingPropertyTests.set(fnIdx, (incomingPropertyTests.get(fnIdx) ?? 0) + 1)
          }
        }
      }
    })
    .with({ _tag: "Failure" }, (f) => {
      findings.push({
        kind: "ontology-broken-realization-chain",
        nodeId: "GraphInfer.decide",
        message: `Stratified Datalog inference failed during ontology check: ${String(f.cause)}`,
      })
    })
    .exhaustive()

  // 1. Parse all EARS specs
  interface ParsedSpec {
    readonly doc: GovernanceDocReference
    readonly requirements: ReadonlyArray<EarsRequirementRow>
    readonly referencedErrors: ReadonlyArray<string>
  }

  const parsedSpecs: Array<ParsedSpec> = []

  for (const doc of input.governanceDocs ?? []) {
    if (
      doc.markdown !== undefined &&
      (doc.docPath.includes("/specs/") || doc.id.includes(":SPEC-") || doc.id.startsWith("SPEC-"))
    ) {
      const lintReport = yield* decideEarsSpecQuality({
        docPath: doc.docPath,
        markdown: doc.markdown,
      })

      let refErrors = doc.referencedErrors ?? []
      if (refErrors.length === 0) {
        const specNode = resolveNode(input.graph, doc.id)
        if (specNode !== undefined) {
          match(specNode)
            .with({ _tag: "EarsSpec" }, (es) => {
              if (es.referencedErrors !== undefined) {
                refErrors = es.referencedErrors
              }
            })
            .with(
              { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" },
              { _tag: "TaggedError" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" },
              { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EffectSignature" },
              { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
              { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
              () => {},
            )
            .exhaustive()
        }
      }

      parsedSpecs.push({
        doc,
        requirements: lintReport.requirements,
        referencedErrors: refErrors,
      })
    }
  }

  const isActiveDocStatus = (status: GovernanceDocReference["status"]): boolean =>
    match(status)
      .with("accepted", "proposed", () => true)
      .with("superseded", "deprecated", () => false)
      .exhaustive()

  // Rule 1: ontology-while-decider-mismatch
  for (const spec of parsedSpecs) {
    for (const row of spec.requirements) {
      if (row.pattern.toLowerCase() === "state-driven") {
        if (row.effectSymbol !== undefined && row.effectSymbol.length > 0) {
          const resolved = resolveNode(input.graph, row.effectSymbol)
          if (resolved !== undefined) {
            match(resolved)
              .with({ _tag: "EffectFn" }, (resolvedFn) => {
                const isDecider =
                  resolvedFn.spanName === "decide" || resolvedFn.spanName.endsWith(".decide")

                const resolvedKey = getNodeKey(resolvedFn)
                let hasOutgoingRequires = inferredImpureFnKeys.has(resolvedKey)
                const nodeIdx = input.graph.nodeIndexByKey.get(resolvedKey)
                if (!hasOutgoingRequires && nodeIdx !== undefined) {
                  for (const inEdgeIdx of Graph.incomingEdges(g, nodeIdx)) {
                    const inEdgeOpt = Graph.getEdge(g, inEdgeIdx)
                    match(inEdgeOpt)
                      .with({ _tag: "None" }, () => {})
                      .with({ _tag: "Some" }, ({ value: inEdge }) => {
                        const relIdx = inEdge.source
                        const relOpt = Graph.getNode(g, relIdx)
                        match(relOpt)
                          .with({ _tag: "None" }, () => {})
                          .with({ _tag: "Some" }, ({ value: relNode }) => {
                            match(relNode)
                              .with({ _tag: "EffectSignature" }, (sigNode) => {
                                match<string>(inEdge.data.role)
                                  .with("caller", () => {
                                    if (sigNode.requiredServices.length > 0) {
                                      hasOutgoingRequires = true
                                      return
                                    }
                                    for (const outEdgeIdx of Graph.outgoingEdges(g, relIdx)) {
                                      const outEdgeOpt = Graph.getEdge(g, outEdgeIdx)
                                      match(outEdgeOpt)
                                        .with({ _tag: "None" }, () => {})
                                        .with({ _tag: "Some" }, ({ value: outEdge }) => {
                                          match<string>(outEdge.data.role)
                                            .with("requires-service", () => { hasOutgoingRequires = true })
                                            .otherwise(() => {})
                                        })
                                        .exhaustive()
                                      if (hasOutgoingRequires) break
                                    }
                                  })
                                  .otherwise(() => {})
                              })
                              .with(
                                { _tag: "EffectFn" },
                                { _tag: "ServiceTag" },
                                { _tag: "ServiceLayer" },
                                { _tag: "TaggedError" },
                                { _tag: "SchemaDef" },
                                { _tag: "VitestCase" },
                                { _tag: "PatternDoc" },
                                { _tag: "AdrDoc" },
                                { _tag: "EarsSpec" },
                                { _tag: "LayerFlow" },
                                { _tag: "TraceabilityTuple" },
                                { _tag: "HttpEndpointTuple" },
                                { _tag: "MigrationTuple" },
                                () => {},
                              )
                              .exhaustive()
                          })
                          .exhaustive()
                      })
                      .exhaustive()
                    if (hasOutgoingRequires) break
                  }
                }

                if (!isDecider || hasOutgoingRequires) {
                  findings.push({
                    kind: "ontology-while-decider-mismatch",
                    nodeId: `${spec.doc.id}:${row.id}`,
                    message: `State-driven requirement ${row.id} maps to '${row.effectSymbol}' which is not a pure decider (must end with .decide and require 0 services).`,
                  })
                }
              })
              .with(
                { _tag: "ServiceTag" },
                { _tag: "ServiceLayer" },
                { _tag: "TaggedError" },
                { _tag: "SchemaDef" },
                { _tag: "VitestCase" },
                { _tag: "PatternDoc" },
                { _tag: "AdrDoc" },
                { _tag: "EarsSpec" },
                { _tag: "EffectSignature" },
                { _tag: "LayerFlow" },
                { _tag: "TraceabilityTuple" },
                { _tag: "HttpEndpointTuple" },
                                { _tag: "MigrationTuple" },
                () => {},
              )
              .exhaustive()
          }
        }
      }
    }
  }

  // Rule 2: ontology-if-then-error-mismatch
  for (const spec of parsedSpecs) {
    if (isActiveDocStatus(spec.doc.status)) {
      for (const err of spec.referencedErrors) {
        const isReferenced = spec.requirements.some(
          (r) => r.effectSymbol === err || r.requirement.includes(err),
        )
        if (!isReferenced) {
          findings.push({
            kind: "ontology-if-then-error-mismatch",
            nodeId: `${spec.doc.id}:${err}`,
            message: `Referenced error "${err}" in ${spec.doc.id} is never referenced in any requirement row.`,
          })
        }
      }

      for (const row of spec.requirements) {
        const pat = row.pattern.toLowerCase()
        if (pat === "unwanted behaviour" || pat === "unwanted behavior") {
          if (row.effectSymbol !== undefined && row.effectSymbol.endsWith("Error")) {
            if (spec.doc.referencedErrors !== undefined || spec.referencedErrors.length > 0) {
              if (!spec.referencedErrors.includes(row.effectSymbol)) {
                findings.push({
                  kind: "ontology-if-then-error-mismatch",
                  nodeId: `${spec.doc.id}:${row.id}`,
                  message: `Unwanted behaviour requirement ${row.id} specifies error "${row.effectSymbol}" which is missing from referencedErrors in ${spec.doc.id}.`,
                })
              }
            }
          }

          const cleanReq = row.requirement.replace(/[*_]/g, "")
          const errorRegex = /fail with (?:a |an |typed error )?`?`?([A-Z][A-Za-z0-9_]*Error)`?`?/gi
          const seenExtracted = new Set<string>()
          for (const match of cleanReq.matchAll(errorRegex)) {
            const extractedError = match[1]!
            if (extractedError !== "SchemaError" && !seenExtracted.has(extractedError)) {
              seenExtracted.add(extractedError)
              const inReferenced = spec.referencedErrors.includes(extractedError)
              const inGraph = resolveNode(input.graph, extractedError) !== undefined
              if (!inReferenced && !inGraph) {
                findings.push({
                  kind: "ontology-if-then-error-mismatch",
                  nodeId: `${spec.doc.id}:${row.id}`,
                  message: `Unwanted behaviour requirement ${row.id} prose references error "${extractedError}" which does not exist in referencedErrors or the workspace graph.`,
                })
              }
            }
          }
        }
      }
    }
  }

  // Rule 3: ontology-conflicting-requirements
  interface EnrichedRow {
    readonly specId: string
    readonly id: string
    readonly requirement: string
    readonly effectSymbol: string
    readonly conditionPrefix: string
  }

  const rowsBySymbolAndCond = new Map<string, Array<EnrichedRow>>()

  for (const spec of parsedSpecs) {
    if (isActiveDocStatus(spec.doc.status)) {
      for (const row of spec.requirements) {
        if (row.effectSymbol !== undefined && row.effectSymbol.length > 0) {
          const prefix = normalizeConditionPrefix(row.requirement)
          if (
            prefix.length > 10 &&
            (prefix.startsWith("when ") || prefix.startsWith("while ") || prefix.startsWith("if "))
          ) {
            const groupKey = `${row.effectSymbol}:::${prefix}`
            const list = rowsBySymbolAndCond.get(groupKey) ?? []
            list.push({
              specId: spec.doc.id,
              id: row.id,
              requirement: row.requirement,
              effectSymbol: row.effectSymbol,
              conditionPrefix: prefix,
            })
            rowsBySymbolAndCond.set(groupKey, list)
          }
        }
      }
    }
  }

  const seenConflictPairs = new Set<string>()
  for (const [, rows] of rowsBySymbolAndCond) {
    if (rows.length >= 2) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const rowA = rows[i]
          const rowB = rows[j]
          if (rowA && rowB && isContradiction(rowA.requirement, rowB.requirement)) {
            const pairKey = `${rowA.specId}:${rowA.id}<->${rowB.specId}:${rowB.id}`
            if (!seenConflictPairs.has(pairKey)) {
              seenConflictPairs.add(pairKey)
              findings.push({
                kind: "ontology-conflicting-requirements",
                nodeId: pairKey,
                message: `Requirement ${rowA.specId}:${rowA.id} contradicts ${rowB.specId}:${rowB.id} for symbol "${rowA.effectSymbol}".`,
              })
            }
          }
        }
      }
    }
  }

  // Rule 3b: ontology-spec-adr-conflict
  const adrDocs = (input.governanceDocs ?? []).filter(
    (doc) =>
      doc.markdown !== undefined &&
      (doc.docPath.includes("/adr/") || doc.id.includes(":ADR-") || doc.id.startsWith("ADR-")),
  )

  for (const spec of parsedSpecs) {
    const specScope = getDocScope(spec.doc)
    for (const row of spec.requirements) {
      if (/\bwithout\s+dying\b.*\bdefect/i.test(row.requirement)) {
        for (const adr of adrDocs) {
          if (
            adr.markdown &&
            /\b(?:dying|die|dies)\s+on\s+(?:unhandled\s+|unexpected\s+)?defects\b/i.test(
              adr.markdown,
            )
          ) {
            const adrScope = getDocScope(adr)
            const sameScope =
              (specScope !== undefined && adrScope !== undefined && specScope === adrScope) ||
              (specScope === undefined && adrScope === undefined) ||
              specScope === "harness" ||
              adrScope === "harness"
            const sharesSymbol =
              row.effectSymbol !== undefined &&
              row.effectSymbol.length > 0 &&
              (adr.referencedSpans?.includes(row.effectSymbol) ||
                adr.referencedServices?.includes(row.effectSymbol) ||
                adr.referencedErrors?.includes(row.effectSymbol) ||
                adr.markdown.includes(row.effectSymbol))

            if (sameScope || sharesSymbol) {
              findings.push({
                kind: "ontology-spec-adr-conflict",
                nodeId: `${spec.doc.id}:${row.id}`,
                message: `Requirement ${spec.doc.id}:${row.id} conflicts with ADR ${adr.id}: requirement specifies 'without dying on defects' while ${adr.id} mandates dying on unexpected defects.`,
              })
            }
          }
        }
      }
    }
  }

  // Rule 4: ontology-broken-realization-chain
  const governedScopes = new Set<string>()
  for (const [, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "EarsSpec", status: "accepted" }, (earsNode) => {
        if (earsNode.id.includes(":")) {
          const scope = earsNode.id.split(":")[0]
          if (scope) {
            governedScopes.add(scope)
          }
        }
      })
      .with(
        { _tag: "EarsSpec", status: "proposed" }, { _tag: "EarsSpec", status: "superseded" },
        { _tag: "EarsSpec", status: "deprecated" }, { _tag: "EffectFn" },
        { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
        { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
        { _tag: "AdrDoc" }, { _tag: "EffectSignature" }, { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
        () => {},
      )
      .exhaustive()
  }

  for (const [, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "EffectFn", packageTag: "domain", isStub: false }, (fnNode) => {
        const inGovernedScope = Array.from(governedScopes).some(
          (scope) => fnNode.file.includes(`libs/${scope}/`) || fnNode.file.includes(`packages/${scope}/`),
        )

        if (inGovernedScope) {
          const why = queryOntologyWhy(input.graph, fnNode.qualname)
          if (!why.justified) {
            findings.push({
              kind: "ontology-broken-realization-chain",
              nodeId: fnNode.spanName,
              message: `Domain function '${fnNode.spanName}' (${fnNode.qualname}) in governed scope is not justified by any accepted ADR or EARS spec.`,
            })
          }
        }
      })
      .with(
        { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" },
        { _tag: "TaggedError" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" },
        { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
        { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
        () => {},
      )
      .exhaustive()
  }

  // Rule 4b: ontology-broken-realization-chain for HttpEndpointTuple
  for (const [relIdx, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "HttpEndpointTuple" }, (epNode) => {
        let hasHandler = false
        let hasSchema = false
        for (const edgeIdx of Graph.outgoingEdges(g, relIdx)) {
          const edgeOpt = Graph.getEdge(g, edgeIdx)
          match(edgeOpt)
            .with({ _tag: "Some" }, ({ value: { data } }) => {
              match<string>(data.role)
                .with("endpoint-handler", () => {
                  hasHandler = true
                })
                .with("request-schema", "response-schema", "uses-schema", () => {
                  hasSchema = true
                })
                .otherwise(() => {})
            })
            .with({ _tag: "None" }, () => {})
            .exhaustive()
        }
        if (!hasHandler) {
          findings.push({
            kind: "ontology-broken-realization-chain",
            nodeId: epNode.relationId,
            message: `HttpEndpointTuple '${epNode.relationId}' (${epNode.method} ${epNode.path}) is missing an endpoint-handler ('handler-fn') role edge.`,
          })
        }
        if (!hasSchema) {
          findings.push({
            kind: "ontology-broken-realization-chain",
            nodeId: epNode.relationId,
            message: `HttpEndpointTuple '${epNode.relationId}' (${epNode.method} ${epNode.path}) is missing an endpoint-schema ('request-schema' or 'response-schema') role edge.`,
          })
        }
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "MigrationTuple" },
        () => {},
      )
      .exhaustive()
  }

  // Rule 5: ontology-unverified-requirement
  for (const spec of parsedSpecs) {
    if (isActiveDocStatus(spec.doc.status)) {
      for (const row of spec.requirements) {
        const verif = row.verification.trim().toLowerCase()
        if (/\bR\s*=\s*never\b/.test(row.requirement) && verif === "unittest") {
          findings.push({
            kind: "ontology-unverified-requirement",
            nodeId: `${spec.doc.id}:${row.id}`,
            message: `Requirement ${row.id} specifies a static type-channel invariant (R = never) with UnitTest verification — use GraphCheck or AstGate instead.`,
          })
        }
      }
    }
  }

  if (hasVitestCases) {
    for (const spec of parsedSpecs) {
      if (isActiveDocStatus(spec.doc.status)) {
        for (const row of spec.requirements) {
          const verif = row.verification.trim().toLowerCase()
          if (
            (verif === "unittest" ||
              verif === "propertytest" ||
              verif === "tracetest" ||
              verif === "test") &&
            row.effectSymbol !== undefined &&
            row.effectSymbol.length > 0
          ) {
            const resolved = resolveNode(input.graph, row.effectSymbol)
            if (resolved !== undefined) {
              match(resolved)
                .with({ _tag: "EffectFn", isStub: false }, (resolvedFn) => {
                  const resolvedKey = getNodeKey(resolvedFn)
                  const nodeIdx = input.graph.nodeIndexByKey.get(resolvedKey)
                  const propTestCount =
                    nodeIdx !== undefined ? (incomingPropertyTests.get(nodeIdx) ?? 0) : 0
                  const testOrCallCount =
                    nodeIdx !== undefined ? (incomingTestOrCall.get(nodeIdx) ?? 0) : 0

                  if (verif === "propertytest") {
                    if (propTestCount === 0) {
                      findings.push({
                        kind: "ontology-unverified-requirement",
                        nodeId: `${spec.doc.id}:${row.id}`,
                        message: `Requirement ${row.id} claims PropertyTest verification for '${row.effectSymbol}' but 0 property tests exercise it.`,
                      })
                    }
                  } else {
                    if (testOrCallCount === 0) {
                      findings.push({
                        kind: "ontology-unverified-requirement",
                        nodeId: `${spec.doc.id}:${row.id}`,
                        message: `Requirement ${row.id} claims ${row.verification} verification for '${row.effectSymbol}' but 0 tests exercise it.`,
                      })
                    }
                  }
                })
                .with(
                  { _tag: "EffectFn" },
                  { _tag: "ServiceTag" },
                  { _tag: "ServiceLayer" },
                  { _tag: "TaggedError" },
                  { _tag: "SchemaDef" },
                  { _tag: "VitestCase" },
                  { _tag: "PatternDoc" },
                  { _tag: "AdrDoc" },
                  { _tag: "EarsSpec" },
                  { _tag: "EffectSignature" },
                  { _tag: "LayerFlow" },
                  { _tag: "TraceabilityTuple" },
                  { _tag: "HttpEndpointTuple" },
                  { _tag: "MigrationTuple" },
                  () => {},
                )
                .exhaustive()
            }
          }
        }
      }
    }
  }

  return yield* Effect.succeed({
    clean: findings.length === 0,
    findings,
  } satisfies OntologyInvariantsReport)
})
