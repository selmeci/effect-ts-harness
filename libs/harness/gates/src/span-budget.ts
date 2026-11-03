import { Effect } from "effect"

export interface SpanSample {
  readonly spanId: string
  readonly name: string
  readonly parentSpanId: string | null
  readonly durationMs?: number | undefined
}

export interface SpanBudgetInput {
  readonly spans: ReadonlyArray<SpanSample>
  readonly maxRepeatedChildCalls?: number | undefined
  readonly maxSpanDurationMs?: number | undefined
}

export interface SpanBudgetViolation {
  readonly kind: "n-plus-one-call" | "span-duration-exceeded"
  readonly parentSpan: string
  readonly targetSpan: string
  readonly count: number
  readonly maxAllowed: number
  readonly message: string
}

export const decideSpanBudgets = Effect.fn("SpanBudget.decide")(function* (input: SpanBudgetInput) {
  yield* Effect.void

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

  return violations as ReadonlyArray<SpanBudgetViolation>
})

export const checkSpanBudgets = (input: SpanBudgetInput): ReadonlyArray<SpanBudgetViolation> =>
  Effect.runSync(decideSpanBudgets(input))
