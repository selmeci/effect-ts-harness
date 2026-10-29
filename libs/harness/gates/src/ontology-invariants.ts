import { Effect, Option } from "effect"
import * as Graph from "effect/Graph"
import {
  getNodeKey,
  type HarnessGraph,
  queryOntologyWhy,
  resolveNode
} from "@harness/graph"
import { decideEarsSpecQuality, type EarsRequirementRow } from "./ears-lint.js"
import type { GovernanceDocReference } from "./gc-check.js"

export type OntologyInvariantFindingKind =
  | "ontology-while-decider-mismatch"
  | "ontology-if-then-error-mismatch"
  | "ontology-conflicting-requirements"
  | "ontology-broken-realization-chain"
  | "ontology-unverified-requirement"

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

const normalizeConditionPrefix = (requirement: string): string => {
  const clean = requirement.replace(/[*_`]/g, "").trim().toLowerCase()
  const matchWithSubject = clean.match(
    /^(.*?)(?:,\s*)?(?:then\s+)?the\s+[a-z0-9_-]+\s+shall\b/
  )
  if (matchWithSubject && matchWithSubject[1]) {
    return matchWithSubject[1].trim()
  }
  const matchShall = clean.match(/^(.*?)(?:,\s*)?shall\b/)
  if (matchShall && matchShall[1]) {
    return matchShall[1].trim()
  }
  return ""
}

const hasShallNot = (text: string): boolean => /\bshall\s+not\b/.test(text)
const hasPlainShall = (text: string): boolean =>
  /\bshall\b/.test(text) && !hasShallNot(text)

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

export const decideOntologyInvariants = Effect.fn("OntologyInvariants.decide")(
  function* (input: OntologyInvariantsInput) {
    yield* Effect.void

    const findings: Array<OntologyInvariantFinding> = []
    const g = input.graph.graph

    const incomingTestOrCall = new Map<Graph.NodeIndex, number>()
    const incomingPropertyTests = new Map<Graph.NodeIndex, number>()

    for (const [, edge] of Graph.edges(g)) {
      if (edge.data._tag === "ExercisesSpan" || edge.data._tag === "TracedCall") {
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
        (doc.docPath.includes("/specs/") ||
          doc.id.includes(":SPEC-") ||
          doc.id.startsWith("SPEC-"))
      ) {
        const lintReport = yield* decideEarsSpecQuality({
          docPath: doc.docPath,
          markdown: doc.markdown
        })

        let refErrors = doc.referencedErrors ?? []
        if (refErrors.length === 0) {
          const specNode = resolveNode(input.graph, doc.id)
          if (specNode && specNode._tag === "EarsSpec" && specNode.referencedErrors !== undefined) {
            refErrors = specNode.referencedErrors
          }
        }

        parsedSpecs.push({
          doc,
          requirements: lintReport.requirements,
          referencedErrors: refErrors
        })
      }
    }

    // Rule 1: ontology-while-decider-mismatch
    for (const spec of parsedSpecs) {
      for (const row of spec.requirements) {
        if (row.pattern.toLowerCase() === "state-driven") {
          if (row.effectSymbol !== undefined && row.effectSymbol.length > 0) {
            const resolved = resolveNode(input.graph, row.effectSymbol)
            if (resolved !== undefined && resolved._tag === "EffectFn") {
              const isDecider =
                resolved.spanName === "decide" ||
                resolved.spanName.endsWith(".decide")

              let hasOutgoingRequires = false
              const resolvedKey = getNodeKey(resolved)
              const nodeIdx = input.graph.nodeIndexByKey.get(resolvedKey)
              if (nodeIdx !== undefined) {
                const outEdges = Graph.outgoingEdges(g, nodeIdx)
                for (const eIdx of outEdges) {
                  const edgeOpt = Graph.getEdge(g, eIdx)
                  if (
                    Option.isSome(edgeOpt) &&
                    edgeOpt.value.data._tag === "RequiresService"
                  ) {
                    hasOutgoingRequires = true
                    break
                  }
                }
              }

              if (!isDecider || hasOutgoingRequires) {
                findings.push({
                  kind: "ontology-while-decider-mismatch",
                  nodeId: `${spec.doc.id}:${row.id}`,
                  message: `State-driven requirement ${row.id} maps to '${row.effectSymbol}' which is not a pure decider (must end with .decide and require 0 services).`
                })
              }
            }
          }
        }
      }
    }

    // Rule 2: ontology-if-then-error-mismatch
    for (const spec of parsedSpecs) {
      if (spec.doc.status === "accepted" || spec.doc.status === "proposed") {
        for (const err of spec.referencedErrors) {
          const isReferenced = spec.requirements.some(
            (r) => r.effectSymbol === err || r.requirement.includes(err)
          )
          if (!isReferenced) {
            findings.push({
              kind: "ontology-if-then-error-mismatch",
              nodeId: `${spec.doc.id}:${err}`,
              message: `Referenced error "${err}" in ${spec.doc.id} is never referenced in any requirement row.`
            })
          }
        }

        for (const row of spec.requirements) {
          const pat = row.pattern.toLowerCase()
          if (pat === "unwanted behaviour" || pat === "unwanted behavior") {
            if (row.effectSymbol !== undefined && row.effectSymbol.endsWith("Error")) {
              if (
                spec.doc.referencedErrors !== undefined ||
                spec.referencedErrors.length > 0
              ) {
                if (!spec.referencedErrors.includes(row.effectSymbol)) {
                  findings.push({
                    kind: "ontology-if-then-error-mismatch",
                    nodeId: `${spec.doc.id}:${row.id}`,
                    message: `Unwanted behaviour requirement ${row.id} specifies error "${row.effectSymbol}" which is missing from referencedErrors in ${spec.doc.id}.`
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
      if (spec.doc.status === "accepted" || spec.doc.status === "proposed") {
        for (const row of spec.requirements) {
          if (row.effectSymbol !== undefined && row.effectSymbol.length > 0) {
            const prefix = normalizeConditionPrefix(row.requirement)
            if (
              prefix.length > 10 &&
              (prefix.startsWith("when ") ||
                prefix.startsWith("while ") ||
                prefix.startsWith("if "))
            ) {
              const groupKey = `${row.effectSymbol}:::${prefix}`
              const list = rowsBySymbolAndCond.get(groupKey) ?? []
              list.push({
                specId: spec.doc.id,
                id: row.id,
                requirement: row.requirement,
                effectSymbol: row.effectSymbol,
                conditionPrefix: prefix
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
                  message: `Requirement ${rowA.specId}:${rowA.id} contradicts ${rowB.specId}:${rowB.id} for symbol "${rowA.effectSymbol}".`
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
      if (node._tag === "EarsSpec" && node.status === "accepted") {
        if (node.id.includes(":")) {
          const scope = node.id.split(":")[0]
          if (scope) {
            governedScopes.add(scope)
          }
        }
      }
    }

    for (const [, node] of Graph.nodes(g)) {
      if (
        node._tag === "EffectFn" &&
        node.packageTag === "domain" &&
        !node.isStub
      ) {
        const inGovernedScope = Array.from(governedScopes).some(
          (scope) =>
            node.file.includes(`libs/${scope}/`) ||
            node.file.includes(`packages/${scope}/`)
        )

        if (inGovernedScope) {
          const why = queryOntologyWhy(input.graph, node.qualname)
          if (!why.justified) {
            findings.push({
              kind: "ontology-broken-realization-chain",
              nodeId: node.spanName,
              message: `Domain function '${node.spanName}' (${node.qualname}) in governed scope is not justified by any accepted ADR or EARS spec.`
            })
          }
        }
      }
    }

    // Rule 5: ontology-unverified-requirement
    for (const spec of parsedSpecs) {
      if (spec.doc.status === "accepted" || spec.doc.status === "proposed") {
        for (const row of spec.requirements) {
          const verif = row.verification.trim().toLowerCase()
          if (/\bR\s*=\s*never\b/.test(row.requirement) && verif === "unittest") {
            findings.push({
              kind: "ontology-unverified-requirement",
              nodeId: `${spec.doc.id}:${row.id}`,
              message: `Requirement ${row.id} specifies a static type-channel invariant (R = never) with UnitTest verification — use GraphCheck or AstGate instead.`
            })
          }
        }
      }
    }

    if (hasVitestCases) {
      for (const spec of parsedSpecs) {
        if (spec.doc.status === "accepted" || spec.doc.status === "proposed") {
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
              if (
                resolved !== undefined &&
                resolved._tag === "EffectFn" &&
                !resolved.isStub
              ) {
                const resolvedKey = getNodeKey(resolved)
                const nodeIdx = input.graph.nodeIndexByKey.get(resolvedKey)
                const propTestCount =
                  nodeIdx !== undefined
                    ? (incomingPropertyTests.get(nodeIdx) ?? 0)
                    : 0
                const testOrCallCount =
                  nodeIdx !== undefined
                    ? (incomingTestOrCall.get(nodeIdx) ?? 0)
                    : 0

                if (verif === "propertytest") {
                  if (propTestCount === 0) {
                    findings.push({
                      kind: "ontology-unverified-requirement",
                      nodeId: `${spec.doc.id}:${row.id}`,
                      message: `Requirement ${row.id} claims PropertyTest verification for '${row.effectSymbol}' but 0 property tests exercise it.`
                    })
                  }
                } else {
                  if (testOrCallCount === 0) {
                    findings.push({
                      kind: "ontology-unverified-requirement",
                      nodeId: `${spec.doc.id}:${row.id}`,
                      message: `Requirement ${row.id} claims ${row.verification} verification for '${row.effectSymbol}' but 0 tests exercise it.`
                    })
                  }
                }
              }
            }
          }
        }
      }
    }

    return {
      clean: findings.length === 0,
      findings
    } satisfies OntologyInvariantsReport
  }
)

export const checkOntologyInvariants = (
  input: OntologyInvariantsInput
): OntologyInvariantsReport => Effect.runSync(decideOntologyInvariants(input))
