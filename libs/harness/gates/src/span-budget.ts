import { Effect, Schema } from "effect"
import { match } from "ts-pattern"

export const SpanIdString = Schema.NonEmptyString.pipe(Schema.brand("SpanIdString"))
export type SpanIdString = typeof SpanIdString.Type

export const SpanNameString = Schema.NonEmptyString.pipe(Schema.brand("SpanNameString"))
export type SpanNameString = typeof SpanNameString.Type

export const SpanBudgetRuleId = Schema.Literals(["BUDG-01", "CAUS-01", "CAUS-02"]).pipe(
  Schema.brand("SpanBudgetRuleId"),
)
export type SpanBudgetRuleId = typeof SpanBudgetRuleId.Type

export const SpanBudgetViolationKind = Schema.Literals([
  "n-plus-one-call",
  "span-duration-exceeded",
  "temporal-order-violation",
  "forbidden-descendant-span",
]).pipe(Schema.brand("SpanBudgetViolationKind"))
export type SpanBudgetViolationKind = typeof SpanBudgetViolationKind.Type

export const SpanBudgetCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("SpanBudgetCount"),
)
export type SpanBudgetCount = typeof SpanBudgetCount.Type

export const SpanBudgetMessage = Schema.NonEmptyString.pipe(Schema.brand("SpanBudgetMessage"))
export type SpanBudgetMessage = typeof SpanBudgetMessage.Type

export const MustPrecedeCausalityRule = Schema.TaggedStruct("MustPrecede", {
  prerequisiteSpan: SpanNameString,
  dependentSpan: SpanNameString,
})
export type MustPrecedeCausalityRule = typeof MustPrecedeCausalityRule.Type

export const ForbiddenUnderCausalityRule = Schema.TaggedStruct("ForbiddenUnder", {
  ancestorSpan: SpanNameString,
  forbiddenDescendantSpan: SpanNameString,
})
export type ForbiddenUnderCausalityRule = typeof ForbiddenUnderCausalityRule.Type

export const RequireCompensationOnFailureRule = Schema.TaggedStruct(
  "RequireCompensationOnFailure",
  {
    failedSpan: SpanNameString,
    compensationSpan: SpanNameString,
  },
)
export type RequireCompensationOnFailureRule = typeof RequireCompensationOnFailureRule.Type

export const TemporalCausalityRule = Schema.Union([
  MustPrecedeCausalityRule,
  ForbiddenUnderCausalityRule,
  RequireCompensationOnFailureRule,
])
export type TemporalCausalityRule = typeof TemporalCausalityRule.Type

export interface SpanSample {
  readonly spanId: string
  readonly name: string
  readonly parentSpanId: string | null
  readonly durationMs?: number | undefined
  readonly startTimeMs?: number | undefined
  readonly endTimeMs?: number | undefined
  readonly exitTag?: "Success" | "Failure" | "Defect" | undefined
  readonly errorTag?: string | null | undefined
}

export interface SpanBudgetInput {
  readonly spans: ReadonlyArray<SpanSample>
  readonly maxRepeatedChildCalls?: number | undefined
  readonly maxSpanDurationMs?: number | undefined
  readonly causalityRules?: ReadonlyArray<TemporalCausalityRule> | undefined
  readonly failOnViolation?: boolean | undefined
}

export interface SpanBudgetViolation {
  readonly ruleId?: "BUDG-01" | "CAUS-01" | "CAUS-02" | undefined
  readonly kind:
    | "n-plus-one-call"
    | "span-duration-exceeded"
    | "temporal-order-violation"
    | "forbidden-descendant-span"
  readonly parentSpan: string
  readonly targetSpan: string
  readonly count: number
  readonly maxAllowed: number
  readonly message: string
}

export const SpanBudgetViolationSchema = Schema.Struct({
  ruleId: Schema.optional(SpanBudgetRuleId),
  kind: SpanBudgetViolationKind,
  parentSpan: SpanNameString,
  targetSpan: SpanNameString,
  count: SpanBudgetCount,
  maxAllowed: SpanBudgetCount,
  message: SpanBudgetMessage,
})

export class SpanCausalityError extends Schema.TaggedError<SpanCausalityError>()(
  "SpanCausalityError",
  {
    violations: Schema.Array(SpanBudgetViolationSchema),
    message: SpanBudgetMessage,
  },
) {}

export const checkTemporalCausality = (
  spans: ReadonlyArray<SpanSample>,
  rules: ReadonlyArray<TemporalCausalityRule>,
  spansById: ReadonlyMap<string, SpanSample>,
): ReadonlyArray<SpanBudgetViolation> => {
  const violations: Array<SpanBudgetViolation> = []
  const allHaveStartTimes = spans.every((s) => s.startTimeMs !== undefined)
  const orderedSpans = spans.map((span, originalIndex) => ({ span, originalIndex }))
  if (allHaveStartTimes) {
    orderedSpans.sort((a, b) => {
      const diff = (a.span.startTimeMs ?? 0) - (b.span.startTimeMs ?? 0)
      return diff !== 0 ? diff : a.originalIndex - b.originalIndex
    })
  }

  const indexedSpans = orderedSpans.map((item, sortedIndex) => ({
    span: item.span,
    index: sortedIndex,
    originalIndex: item.originalIndex,
    startTimeMs: item.span.startTimeMs,
    endTimeMs: item.span.endTimeMs,
  }))

  for (const rule of rules) {
    match(rule)
      .with({ _tag: "MustPrecede" }, ({ prerequisiteSpan, dependentSpan }) => {
        const prereqEntries = indexedSpans.filter((e) => e.span.name === prerequisiteSpan)
        const dependentEntries = indexedSpans.filter((e) => e.span.name === dependentSpan)
        for (const dep of dependentEntries) {
          const hasCompletedPrereq = prereqEntries.some((pre) => {
            if (pre.endTimeMs !== undefined && dep.startTimeMs !== undefined) {
              return pre.endTimeMs <= dep.startTimeMs
            }
            return pre.index < dep.index
          })
          if (!hasCompletedPrereq) {
            violations.push({
              ruleId: "CAUS-01",
              kind: "temporal-order-violation",
              parentSpan: prerequisiteSpan,
              targetSpan: dependentSpan,
              count: 1,
              maxAllowed: 0,
              message: `[CAUS-01] Temporal order violation: "${dependentSpan}" executed before prerequisite span "${prerequisiteSpan}" completed.`,
            })
          }
        }
      })
      .with({ _tag: "ForbiddenUnder" }, ({ ancestorSpan, forbiddenDescendantSpan }) => {
        for (const { span } of indexedSpans) {
          if (span.name !== forbiddenDescendantSpan) {
            continue
          }

          const visited = new Set<string>([span.spanId])
          let cursorParentId = span.parentSpanId
          let isDescendant = false
          let danglingParentId: string | null = null

          while (
            cursorParentId !== null &&
            cursorParentId.length > 0 &&
            !visited.has(cursorParentId)
          ) {
            visited.add(cursorParentId)
            const parent = spansById.get(cursorParentId)
            if (parent === undefined) {
              danglingParentId = cursorParentId
              break
            }
            if (parent.name === ancestorSpan) {
              isDescendant = true
              break
            }
            cursorParentId = parent.parentSpanId
          }

          if (isDescendant) {
            violations.push({
              ruleId: "CAUS-02",
              kind: "forbidden-descendant-span",
              parentSpan: ancestorSpan,
              targetSpan: forbiddenDescendantSpan,
              count: 1,
              maxAllowed: 0,
              message: `[CAUS-02] Forbidden descendant span: "${forbiddenDescendantSpan}" was invoked inside restricted ancestor span "${ancestorSpan}".`,
            })
          } else if (danglingParentId !== null) {
            violations.push({
              ruleId: "CAUS-02",
              kind: "forbidden-descendant-span",
              parentSpan: ancestorSpan,
              targetSpan: forbiddenDescendantSpan,
              count: 1,
              maxAllowed: 0,
              message: `[CAUS-02] Forbidden descendant span: "${span.name}" has a dangling unverified parentSpanId "${danglingParentId}" while checking ForbiddenUnder for "${ancestorSpan}".`,
            })
          }
        }
      })
      .with({ _tag: "RequireCompensationOnFailure" }, ({ failedSpan, compensationSpan }) => {
        const failedEntries = indexedSpans.filter(
          (e) =>
            e.span.name === failedSpan &&
            (e.span.exitTag === "Failure" || e.span.exitTag === "Defect"),
        )
        const compensationEntries = indexedSpans.filter((e) => e.span.name === compensationSpan)
        for (const failed of failedEntries) {
          const hasSubsequentCompensation = compensationEntries.some(
            (comp) =>
              comp.span.exitTag !== "Failure" &&
              comp.span.exitTag !== "Defect" &&
              (comp.index > failed.index ||
                (comp.startTimeMs !== undefined &&
                  failed.endTimeMs !== undefined &&
                  comp.startTimeMs >= failed.endTimeMs)),
          )
          if (!hasSubsequentCompensation) {
            violations.push({
              ruleId: "CAUS-01",
              kind: "temporal-order-violation",
              parentSpan: failedSpan,
              targetSpan: compensationSpan,
              count: 1,
              maxAllowed: 0,
              message: `[CAUS-01] Missing saga compensation: "${failedSpan}" exited with ${failed.span.exitTag ?? "Failure"} without a subsequent "${compensationSpan}" compensation span.`,
            })
          }
        }
      })
      .exhaustive()
  }

  return violations
}

export const evaluateTemporalCausalityRules = checkTemporalCausality

export const decideSpanBudgets = Effect.fn("SpanBudget.decide")(function* (
  input: SpanBudgetInput,
): Effect.fn.Return<ReadonlyArray<SpanBudgetViolation>, SpanCausalityError, never> {
  const maxRepeated = input.maxRepeatedChildCalls ?? 5
  const spansById = new Map<string, SpanSample>()
  for (const span of input.spans) {
    spansById.set(span.spanId, span)
  }

  const violations: Array<SpanBudgetViolation> = []

  // Group child spans by `${parentSpanId}::${child.name}` (where child.parentSpanId !== null)
  const childGroups = new Map<
    string,
    { readonly parentSpanId: string; readonly childName: string; count: number }
  >()

  for (const span of input.spans) {
    if (span.parentSpanId !== null) {
      const key = `${span.parentSpanId}::${span.name}`
      const existing = childGroups.get(key)
      if (existing !== undefined) {
        existing.count += 1
      } else {
        childGroups.set(key, {
          parentSpanId: span.parentSpanId,
          childName: span.name,
          count: 1,
        })
      }
    }
  }

  for (const { parentSpanId, childName, count } of childGroups.values()) {
    if (count > maxRepeated) {
      const parent = spansById.get(parentSpanId)
      const parentName = parent?.name ?? parentSpanId
      violations.push({
        kind: "n-plus-one-call",
        parentSpan: parentName,
        targetSpan: childName,
        count,
        maxAllowed: maxRepeated,
        message: `N+1 span repetition detected: "${parentName}" invoked "${childName}" ${count} times (budget: ${maxRepeated}). Batch queries or use Effect.all.`,
      })
    }
  }

  if (input.maxSpanDurationMs !== undefined) {
    for (const span of input.spans) {
      if (span.durationMs !== undefined && span.durationMs > input.maxSpanDurationMs) {
        const parent = span.parentSpanId !== null ? spansById.get(span.parentSpanId) : undefined
        const parentName = parent?.name ?? span.parentSpanId ?? "root"
        violations.push({
          kind: "span-duration-exceeded",
          parentSpan: parentName,
          targetSpan: span.name,
          count: Math.round(span.durationMs),
          maxAllowed: input.maxSpanDurationMs,
          message: `Span duration budget exceeded: "${span.name}" took ${Math.round(span.durationMs)}ms (budget: ${input.maxSpanDurationMs}ms).`,
        })
      }
    }
  }

  const causalityRules = input.causalityRules ?? []
  if (causalityRules.length > 0) {
    const causalityViolations = checkTemporalCausality(
      input.spans,
      causalityRules,
      spansById,
    )
    violations.push(...causalityViolations)
  }

  const shouldFail = input.failOnViolation ?? (causalityRules.length > 0)
  if (shouldFail && violations.length > 0) {
    return yield* new SpanCausalityError({
      violations: violations.map((v) => ({
        ruleId: v.ruleId !== undefined ? SpanBudgetRuleId.make(v.ruleId) : undefined,
        kind: SpanBudgetViolationKind.make(v.kind),
        parentSpan: SpanNameString.make(v.parentSpan || "root"),
        targetSpan: SpanNameString.make(v.targetSpan || "unknown"),
        count: SpanBudgetCount.make(Math.max(0, v.count)),
        maxAllowed: SpanBudgetCount.make(Math.max(0, v.maxAllowed)),
        message: SpanBudgetMessage.make(v.message),
      })),
      message: SpanBudgetMessage.make(
        `SpanBudget.decide failed with ${violations.length} violation(s): ${violations.map((v) => v.message).join("; ")}`,
      ),
    })
  }

  return violations as ReadonlyArray<SpanBudgetViolation>
})

export const SpanBudget = {
  decide: decideSpanBudgets,
} as const

export const checkSpanBudgets = (input: SpanBudgetInput): ReadonlyArray<SpanBudgetViolation> =>
  Effect.runSync(decideSpanBudgets(input))
