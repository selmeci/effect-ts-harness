import { Cause, Context, Effect, Exit, Function, Layer, Option, Tracer } from "effect"
import { match } from "ts-pattern"
import type { IndexedEffectFn } from "./fn-index.js"
import type { ExercisesSpanEdge, TracedCallEdge } from "./trace-format.js"

export type SpanExitTag = "Success" | "Failure" | "Defect"

export interface RecordedSpanEvent {
  readonly traceId: string
  readonly spanId: string
  readonly name: string
  readonly parentSpanId: string | null
  readonly attributes: Readonly<Record<string, unknown>>
  readonly durationMs?: number | undefined
  readonly startTimeMs?: number | undefined
  readonly endTimeMs?: number | undefined
  readonly exitTag?: SpanExitTag | undefined
  readonly errorTag?: string | null | undefined
  readonly valueTag?: string | null | undefined
}

export interface SpanSaturationSummary {
  readonly spanName: string
  readonly callCount: number
  readonly successCount: number
  readonly failureCount: number
  readonly defectCount: number
  readonly observedErrorTags: ReadonlyArray<string>
  readonly observedValueTags: ReadonlyArray<string>
}

export const findRecoverableError = <E>(cause: Cause.Cause<E>): Option.Option<E> =>
  Cause.findErrorOption(cause)

export const extractRuntimeTag = (val: unknown): string | null => {
  if (typeof val === "object" && val !== null && "_tag" in val) {
    const tag = (val as { readonly _tag?: unknown })._tag
    if (typeof tag === "string" && tag.length > 0) {
      return tag
    }
  }
  if (val instanceof Error && val.name.length > 0) {
    return val.name
  }
  if (val === undefined || val === null) {
    return null
  }
  return typeof val
}

export interface SpanRecorderShape {
  readonly spans: ReadonlyArray<RecordedSpanEvent>
  readonly record: (span: RecordedSpanEvent) => void
  readonly toTraceEdges: (
    fnIndex: ReadonlyMap<string, IndexedEffectFn>,
    externalSpans?: ReadonlyArray<RecordedSpanEvent>,
    defaultReceiverLayer?: string | null,
  ) => {
    readonly tracedCalls: ReadonlyArray<TracedCallEdge>
    readonly exercisesSpans: ReadonlyArray<ExercisesSpanEdge>
  }
}

export const makeSpanRecorder = (): SpanRecorderShape => {
  const recorded: Array<RecordedSpanEvent> = []
  const recordedIds = new Set<string>()

  const record = (event: RecordedSpanEvent): void => {
    if (recordedIds.has(event.spanId)) {
      const idx = recorded.findIndex((s) => s.spanId === event.spanId)
      if (idx !== -1) {
        recorded[idx] = event
      }
    } else {
      recordedIds.add(event.spanId)
      recorded.push(event)
    }
  }

  return {
    record,
    get spans(): ReadonlyArray<RecordedSpanEvent> {
      return [...recorded]
    },
    toTraceEdges: (fnIndex, externalSpans, defaultReceiverLayer) =>
      toTraceEdges([...recorded, ...(externalSpans ?? [])], fnIndex, defaultReceiverLayer),
  }
}

export class SpanRecorder extends Context.Service<SpanRecorder, SpanRecorderShape>()(
  "@harness/ingest/SpanRecorder",
) {
  static readonly layer: Layer.Layer<SpanRecorder> = Layer.sync(SpanRecorder, makeSpanRecorder)
}

export const makeRecordingTracer = (recorder: SpanRecorderShape): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      const parentSpanId = Option.match(options.parent, {
        onNone: () => null,
        onSome: (p) => p.spanId,
      })
      const startTimeMs =
        typeof span.status.startTime === "bigint"
          ? Number(span.status.startTime) / 1_000_000
          : undefined
      let durationMs: number | undefined = undefined
      let endTimeMs: number | undefined = undefined
      let exitTag: SpanExitTag | undefined = undefined
      let errorTag: string | null | undefined = undefined
      let valueTag: string | null | undefined = undefined

      const syncRecord = (): void => {
        const attributes: Record<string, unknown> = {}
        for (const [k, v] of span.attributes.entries()) {
          attributes[k] = v
        }
        recorder.record({
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name,
          parentSpanId,
          attributes,
          durationMs,
          ...(startTimeMs !== undefined ? { startTimeMs } : {}),
          ...(endTimeMs !== undefined ? { endTimeMs } : {}),
          ...(exitTag !== undefined ? { exitTag } : {}),
          ...(errorTag !== undefined ? { errorTag } : {}),
          ...(valueTag !== undefined ? { valueTag } : {}),
        })
      }

      syncRecord()

      const origAttr = span.attribute.bind(span)
      span.attribute = (key, value) => {
        origAttr(key, value)
        syncRecord()
      }

      const origEnd = span.end.bind(span)
      span.end = (endTime, exit) => {
        durationMs =
          typeof endTime === "bigint" && typeof span.status.startTime === "bigint"
            ? Number(endTime - span.status.startTime) / 1_000_000
            : undefined
        endTimeMs = typeof endTime === "bigint" ? Number(endTime) / 1_000_000 : undefined
        Exit.match(exit, {
          onSuccess: (val) => {
            exitTag = "Success"
            errorTag = null
            valueTag = extractRuntimeTag(val)
          },
          onFailure: (cause) => {
            Option.match(findRecoverableError(cause), {
              onSome: (err) => {
                exitTag = "Failure"
                errorTag = extractRuntimeTag(err) ?? "UnknownError"
                valueTag = null
              },
              onNone: () => {
                exitTag = "Defect"
                errorTag = null
                valueTag = null
              },
            })
          },
        })
        origEnd(endTime, exit)
        syncRecord()
      }

      return span
    },
  })

/**
 * Computes descendant-aware error and value tag saturation per span (`RFC-0005 §4.3.1`).
 * For each span `s_f`, credits `errorTag` and `valueTag` observations recorded on `s_f`
 * AND on any transitive descendant span `s_c` (`s_f <+_parent s_c`) in the same trace.
 */
export const computeSpanSaturation = (
  spans: ReadonlyArray<RecordedSpanEvent>,
): ReadonlyMap<string, SpanSaturationSummary> => {
  const byId = new Map<string, RecordedSpanEvent>()
  for (const s of spans) {
    byId.set(s.spanId, s)
  }

  const getAncestorsAndSelf = (span: RecordedSpanEvent): ReadonlyArray<RecordedSpanEvent> => {
    const chain: Array<RecordedSpanEvent> = [span]
    const visited = new Set<string>([span.spanId])
    let curParentId = span.parentSpanId
    while (curParentId !== null && !visited.has(curParentId)) {
      visited.add(curParentId)
      const parent = byId.get(curParentId)
      if (parent === undefined) break
      chain.push(parent)
      curParentId = parent.parentSpanId
    }
    return chain
  }

  const accum = new Map<
    string,
    {
      callCount: number
      successCount: number
      failureCount: number
      defectCount: number
      errorTags: Set<string>
      valueTags: Set<string>
    }
  >()

  const ensureEntry = (name: string) => {
    let entry = accum.get(name)
    if (entry === undefined) {
      entry = {
        callCount: 0,
        successCount: 0,
        failureCount: 0,
        defectCount: 0,
        errorTags: new Set<string>(),
        valueTags: new Set<string>(),
      }
      accum.set(name, entry)
    }
    return entry
  }

  for (const span of spans) {
    if (span.name.startsWith("Test:")) continue
    const selfEntry = ensureEntry(span.name)
    selfEntry.callCount += 1
    if (span.exitTag !== undefined) {
      match(span.exitTag)
        .with("Success", () => {
          selfEntry.successCount += 1
        })
        .with("Failure", () => {
          selfEntry.failureCount += 1
        })
        .with("Defect", () => {
          selfEntry.defectCount += 1
        })
        .exhaustive()
    }

    const ancestors = getAncestorsAndSelf(span)
    for (const ancestor of ancestors) {
      if (ancestor.name.startsWith("Test:")) continue
      const targetEntry = ensureEntry(ancestor.name)
      if (
        span.exitTag === "Failure" &&
        typeof span.errorTag === "string" &&
        span.errorTag.length > 0
      ) {
        targetEntry.errorTags.add(span.errorTag)
      }
      if (typeof span.valueTag === "string" && span.valueTag.length > 0) {
        targetEntry.valueTags.add(span.valueTag)
      }
    }
  }

  const summaries = new Map<string, SpanSaturationSummary>()
  for (const [spanName, data] of accum.entries()) {
    summaries.set(spanName, {
      spanName,
      callCount: data.callCount,
      successCount: data.successCount,
      failureCount: data.failureCount,
      defectCount: data.defectCount,
      observedErrorTags: Array.from(data.errorTags).sort(),
      observedValueTags: Array.from(data.valueTags).sort(),
    })
  }
  return summaries
}

export const recordingTracerLayer = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const recorder = yield* SpanRecorder
    return makeRecordingTracer(recorder)
  }),
)

export const toTraceEdges = (
  spans: ReadonlyArray<RecordedSpanEvent>,
  fnIndex: ReadonlyMap<string, IndexedEffectFn>,
  defaultReceiverLayer?: string | null,
): {
  readonly tracedCalls: ReadonlyArray<TracedCallEdge>
  readonly exercisesSpans: ReadonlyArray<ExercisesSpanEdge>
} => {
  const spansById = new Map<string, RecordedSpanEvent>()
  const traceIdToTestId = new Map<string, string>()
  const traceIdToReceiverLayer = new Map<string, string>()

  for (const span of spans) {
    spansById.set(span.spanId, span)
    if (span.name.startsWith("Test:")) {
      traceIdToTestId.set(span.traceId, span.name.slice(5))
      const receiver = span.attributes["harness.receiverLayer"]
      if (typeof receiver === "string") {
        traceIdToReceiverLayer.set(span.traceId, receiver)
      }
    }
  }

  const resolveTestId = (span: RecordedSpanEvent): string | null => {
    const fromTrace = traceIdToTestId.get(span.traceId)
    if (fromTrace) return fromTrace
    const visited = new Set<string>()
    let current: RecordedSpanEvent | undefined = span
    while (current !== undefined && !visited.has(current.spanId)) {
      visited.add(current.spanId)
      if (current.name.startsWith("Test:")) {
        return current.name.slice(5)
      }
      current = current.parentSpanId ? spansById.get(current.parentSpanId) : undefined
    }
    return null
  }

  const resolveCallerQualname = (span: RecordedSpanEvent): string | null => {
    const visited = new Set<string>([span.spanId])
    let parentId = span.parentSpanId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = spansById.get(parentId)
      if (!parent) break
      if (parent.name.startsWith("Test:")) break
      const indexed = fnIndex.get(parent.name)
      if (indexed) {
        return indexed.qualname
      }
      parentId = parent.parentSpanId
    }
    return null
  }

  const resolveReceiverLayer = (span: RecordedSpanEvent): string | null => {
    const attr = span.attributes["harness.receiverLayer"]
    if (typeof attr === "string") {
      return attr
    }
    const fromTrace = traceIdToReceiverLayer.get(span.traceId)
    if (fromTrace) {
      return fromTrace
    }
    const visited = new Set<string>()
    let current: RecordedSpanEvent | undefined = span
    while (current !== undefined && !visited.has(current.spanId)) {
      visited.add(current.spanId)
      if (current.name.startsWith("Test:")) {
        const rootAttr = current.attributes["harness.receiverLayer"]
        if (typeof rootAttr === "string") {
          return rootAttr
        }
      }
      current = current.parentSpanId ? spansById.get(current.parentSpanId) : undefined
    }
    return defaultReceiverLayer ?? null
  }

  const exercisesMap = new Map<string, ExercisesSpanEdge>()
  const tracedCallsMap = new Map<string, TracedCallEdge>()

  for (const span of spans) {
    if (span.name.startsWith("Test:")) continue

    const indexedFn = fnIndex.get(span.name)
    if (!indexedFn) continue

    const calleeQualname = indexedFn.qualname
    const receiverLayer = resolveReceiverLayer(span)
    const testId = resolveTestId(span)

    if (testId != null) {
      const key = `${testId}\0${calleeQualname}\0${receiverLayer}`
      const existing = exercisesMap.get(key)
      if (existing) {
        exercisesMap.set(key, {
          ...existing,
          callCount: existing.callCount + 1,
        })
      } else {
        exercisesMap.set(key, {
          testId,
          calleeQualname,
          callCount: 1,
          receiverLayer,
        })
      }
    }

    const callerQualname = resolveCallerQualname(span)
    if (callerQualname != null) {
      const key = `${callerQualname}\0${calleeQualname}\0${receiverLayer}`
      const existing = tracedCallsMap.get(key)
      if (existing) {
        tracedCallsMap.set(key, {
          ...existing,
          callCount: existing.callCount + 1,
        })
      } else {
        tracedCallsMap.set(key, {
          callerQualname,
          calleeQualname,
          callCount: 1,
          receiverLayer,
        })
      }
    }
  }

  return {
    tracedCalls: Array.from(tracedCallsMap.values()),
    exercisesSpans: Array.from(exercisesMap.values()),
  }
}

export const withRecordedTestSpan: {
  (
    testId: string,
    receiverLayer?: string | null,
  ): <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, SpanRecorder | Tracer.ParentSpan>>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    testId: string,
    receiverLayer?: string | null,
  ): Effect.Effect<A, E, Exclude<R, SpanRecorder | Tracer.ParentSpan>>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <A, E, R>(effect: Effect.Effect<A, E, R>, testId: string, receiverLayer?: string | null) => {
    const recorder = makeSpanRecorder()
    const tracer = makeRecordingTracer(recorder)
    const spanOptions: Tracer.SpanOptions = {
      attributes: receiverLayer != null ? { "harness.receiverLayer": receiverLayer } : undefined,
    }
    return effect.pipe(
      Effect.withSpan(`Test:${testId}`, spanOptions),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(SpanRecorder, recorder),
    )
  },
)

export const runWithTestTracer = <A, E, R>(
  testId: string,
  effect: Effect.Effect<A, E, R>,
  fnIndex: ReadonlyMap<string, IndexedEffectFn>,
  options?: {
    readonly receiverLayer?: string | null
    readonly externalSpans?: ReadonlyArray<RecordedSpanEvent>
  },
): Effect.Effect<
  {
    readonly result: A
    readonly spans: ReadonlyArray<RecordedSpanEvent>
    readonly edges: {
      readonly tracedCalls: ReadonlyArray<TracedCallEdge>
      readonly exercisesSpans: ReadonlyArray<ExercisesSpanEdge>
    }
  },
  E,
  R
> =>
  Effect.gen(function* () {
    const recorder = makeSpanRecorder()
    const tracer = makeRecordingTracer(recorder)
    const spanOptions: Tracer.SpanOptions = {
      attributes:
        options?.receiverLayer != null
          ? { "harness.receiverLayer": options.receiverLayer }
          : undefined,
    }

    const result = yield* effect.pipe(
      Effect.withSpan(`Test:${testId}`, spanOptions),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(SpanRecorder, recorder),
    )

    if (options?.externalSpans) {
      for (const ext of options.externalSpans) {
        recorder.record(ext)
      }
    }

    const allSpans = recorder.spans
    const edges = toTraceEdges(allSpans, fnIndex, options?.receiverLayer)

    return {
      result,
      spans: allSpans,
      edges,
    }
  })
