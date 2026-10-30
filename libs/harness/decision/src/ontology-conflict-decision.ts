import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  checkOntologyInvariants,
  decideOntologyInvariants,
  type EarsRequirementRow,
  type GovernanceDocReference,
  lintEarsSpecMarkdown,
  loadGovernanceDocsFromDisk,
  type OntologyInvariantFinding,
  type OntologyInvariantsReport
} from "@harness/gates"
import { assertDecisionLimits } from "./idiom-router.js"

export {
  checkOntologyInvariants,
  decideOntologyInvariants,
  type GovernanceDocReference,
  loadGovernanceDocsFromDisk,
  type OntologyInvariantFinding,
  type OntologyInvariantsReport
}

export const ONTOLOGY_CONFLICT_KINDS = [
  "none",
  "state-transition-conflict",
  "error-contract-conflict",
  "adr-constraint-violation",
  "duplicate-overlap"
] as const
export type OntologyConflictKind = (typeof ONTOLOGY_CONFLICT_KINDS)[number]

export const OntologyConflictV1 = Decision.make({
  input: Schema.Struct({
    sourceId: Schema.String,
    sourceText: Schema.String,
    targetId: Schema.String,
    targetText: Schema.String,
    sharedSymbol: Schema.String
  }),
  decisions: {
    contradicts: Decision.probability({
      instructions:
        "Do these two requirements or architectural constraints contradict each other or require incompatible behavior for the shared symbol?"
    }),
    conflictKind: Decision.classify({
      instructions:
        "Which category best describes the relationship or conflict between these two statements?",
      criteria: {
        none: "Compatible, complementary, or orthogonal statements",
        "state-transition-conflict":
          "Contradictory state preconditions or outcomes (WHILE/WHEN conflict)",
        "error-contract-conflict":
          "Incompatible failure conditions or TaggedError expectations (IF/THEN conflict)",
        "adr-constraint-violation":
          "Requirement violates an architectural driver, principle, or rejected alternative in an ADR",
        "duplicate-overlap":
          "Redundant or ambiguous duplicate requirement for the same behavior"
      }
    })
  }
})

assertDecisionLimits(OntologyConflictV1)

export interface OntologyConflictInput {
  readonly sourceId: string
  readonly sourceText: string
  readonly targetId: string
  readonly targetText: string
  readonly sharedSymbol: string
}

export interface OntologyConflictResult {
  readonly hasConflict: boolean
  readonly probability: number
  readonly conflictKind: OntologyConflictKind
  readonly reason: string
  readonly timedOutOrUnavailable?: boolean
}

export const checkOntologyPairConflict = Effect.fn(
  "Harness.checkOntologyPairConflict"
)(function* (input: OntologyConflictInput) {
  const outcome = yield* DecisionModel.decide(OntologyConflictV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone)
  )

  if (Option.isNone(outcome)) {
    return {
      hasConflict: false,
      probability: 0,
      conflictKind: "none" as const,
      reason:
        "DecisionModel unavailable or timed out; relying on deterministic ontology invariants.",
      timedOutOrUnavailable: true
    } satisfies OntologyConflictResult
  }

  const { answers } = outcome.value
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "OntologyConflictV1",
    "decision.contradicts": answers.contradicts.probability,
    "decision.conflictKind": answers.conflictKind.label
  })

  const hasConflict =
    answers.contradicts.probability >= 0.7 && answers.conflictKind.label !== "none"

  return {
    hasConflict,
    probability: answers.contradicts.probability,
    conflictKind: hasConflict
      ? (answers.conflictKind.label as OntologyConflictKind)
      : ("none" as const),
    reason: hasConflict
      ? `Semantic conflict (${answers.conflictKind.label}, p=${answers.contradicts.probability}) between ${input.sourceId} and ${input.targetId} on ${input.sharedSymbol}.`
      : `No semantic conflict detected between ${input.sourceId} and ${input.targetId}.`,
    timedOutOrUnavailable: false
  } satisfies OntologyConflictResult
})

const MAX_CANDIDATE_PAIRS = 16

const extractAdrSummary = (markdown: string, fallbackId: string): string => {
  const lines = markdown.split("\n")
  for (const line of lines) {
    if (/chosen option:/i.test(line)) {
      return line.replace(/[*_`]/g, "").trim()
    }
  }
  for (const line of lines) {
    if (line.startsWith("# ")) {
      return line.replace(/^#\s+/, "").trim()
    }
  }
  return fallbackId
}

export const extractOntologyConflictPairs = (
  governanceDocs: ReadonlyArray<GovernanceDocReference>,
  scope?: string
): ReadonlyArray<OntologyConflictInput> => {
  const activeDocs = governanceDocs.filter((doc) => {
    if (doc.status !== "accepted" && doc.status !== "proposed") {
      return false
    }
    if (scope !== undefined && scope.length > 0) {
      const match =
        doc.id.startsWith(`${scope}:`) ||
        doc.docPath.includes(`libs/${scope}/`) ||
        doc.docPath.includes(`apps/${scope}/`) ||
        doc.docPath.includes(`packages/${scope}/`)
      if (!match) {
        return false
      }
    }
    return true
  })

  interface RequirementRef {
    readonly specId: string
    readonly row: EarsRequirementRow
  }

  const specRows: Array<RequirementRef> = []
  const adrDocs: Array<GovernanceDocReference> = []

  for (const doc of activeDocs) {
    if (
      doc.markdown !== undefined &&
      (doc.id.includes("ADR-") || doc.docPath.includes("/adr/"))
    ) {
      adrDocs.push(doc)
    }

    if (
      doc.markdown !== undefined &&
      (doc.docPath.includes("/specs/") ||
        doc.id.includes(":SPEC-") ||
        doc.id.startsWith("SPEC-"))
    ) {
      const lintReport = lintEarsSpecMarkdown(doc.docPath, doc.markdown)
      for (const row of lintReport.requirements) {
        if (
          row.id.startsWith("REQ-") &&
          row.effectSymbol !== undefined &&
          row.effectSymbol.length > 0
        ) {
          specRows.push({ specId: doc.id, row })
        }
      }
    }
  }

  const pairs: Array<OntologyConflictInput> = []
  const seenPairKeys = new Set<string>()

  // 1. Group rows by effectSymbol
  const rowsBySymbol = new Map<string, Array<RequirementRef>>()
  for (const item of specRows) {
    const sym = item.row.effectSymbol
    if (sym !== undefined && sym.length > 0) {
      const existing = rowsBySymbol.get(sym) ?? []
      existing.push(item)
      rowsBySymbol.set(sym, existing)
    }
  }

  for (const [effectSymbol, rows] of rowsBySymbol) {
    if (rows.length >= 2) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (pairs.length >= MAX_CANDIDATE_PAIRS) {
            break
          }
          const rowA = rows[i]
          const rowB = rows[j]
          if (rowA !== undefined && rowB !== undefined) {
            const sourceId = `${rowA.specId}#${rowA.row.id}`
            const targetId = `${rowB.specId}#${rowB.row.id}`
            const pairKey = `${sourceId}<->${targetId}`
            if (!seenPairKeys.has(pairKey)) {
              seenPairKeys.add(pairKey)
              pairs.push({
                sourceId,
                sourceText: rowA.row.requirement,
                targetId,
                targetText: rowB.row.requirement,
                sharedSymbol: effectSymbol
              })
            }
          }
        }
        if (pairs.length >= MAX_CANDIDATE_PAIRS) {
          break
        }
      }
    }
    if (pairs.length >= MAX_CANDIDATE_PAIRS) {
      break
    }
  }

  // 2. Cross-reference REQ rows with active ADRs that share a governed symbol
  for (const adr of adrDocs) {
    if (pairs.length >= MAX_CANDIDATE_PAIRS) {
      break
    }
    const governed = new Set([
      ...(adr.referencedSpans ?? []),
      ...(adr.referencedServices ?? []),
      ...(adr.referencedErrors ?? [])
    ])
    if (governed.size === 0) {
      continue
    }

    const adrSummary = extractAdrSummary(adr.markdown ?? "", adr.id)

    for (const item of specRows) {
      if (pairs.length >= MAX_CANDIDATE_PAIRS) {
        break
      }
      const sym = item.row.effectSymbol
      if (sym === undefined || sym.length === 0) {
        continue
      }
      const matches =
        governed.has(sym) ||
        Array.from(governed).some(
          (s) => s.endsWith(`.${sym}`) || sym.endsWith(`.${s}`)
        )
      if (matches) {
        const sourceId = `${item.specId}#${item.row.id}`
        const targetId = adr.id
        const pairKey = `${sourceId}<->${targetId}`
        if (!seenPairKeys.has(pairKey)) {
          seenPairKeys.add(pairKey)
          pairs.push({
            sourceId,
            sourceText: item.row.requirement,
            targetId,
            targetText: adrSummary,
            sharedSymbol: sym
          })
        }
      }
    }
  }

  return pairs
}

export const evaluateOntologyConflicts = Effect.fn(
  "Harness.evaluateOntologyConflicts"
)(function* (pairs: ReadonlyArray<OntologyConflictInput>) {
  if (pairs.length === 0) {
    return []
  }

  const firstPair = pairs[0]!
  const firstResult = yield* checkOntologyPairConflict(firstPair)

  if (firstResult.timedOutOrUnavailable === true) {
    return []
  }

  const firstEvaluated = { ...firstPair, ...firstResult }
  const rest = pairs.slice(1)
  const restEvaluated = yield* Effect.forEach(
    rest,
    (pair) =>
      checkOntologyPairConflict(pair).pipe(
        Effect.map((res) => ({ ...pair, ...res }))
      ),
    { concurrency: 4 }
  )

  const evaluated = [firstEvaluated, ...restEvaluated]
  return evaluated.filter((res) => res.hasConflict) as ReadonlyArray<
    OntologyConflictResult & OntologyConflictInput
  >
})
