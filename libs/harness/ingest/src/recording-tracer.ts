import { Context, Effect, Function, Layer, Option, Tracer } from "effect"
import type { IndexedEffectFn } from "./fn-index.js"
import type { ExercisesSpanEdge, TracedCallEdge } from "./trace-format.js"

export interface RecordedSpanEvent {
  readonly traceId: string
  readonly spanId: string
  readonly name: string
  readonly parentSpanId: string | null
  readonly attributes: Readonly<Record<string, unknown>>
  readonly durationMs?: number | undefined
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
      const parentSpanId = Option.isSome(options.parent) ? options.parent.value.spanId : null
      let durationMs: number | undefined = undefined

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
        origEnd(endTime, exit)
        syncRecord()
      }

      return span
    },
  })

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
    let current: RecordedSpanEvent | undefined = span
    while (current) {
      if (current.name.startsWith("Test:")) {
        return current.name.slice(5)
      }
      current = current.parentSpanId ? spansById.get(current.parentSpanId) : undefined
    }
    return null
  }

  const resolveCallerQualname = (span: RecordedSpanEvent): string | null => {
    let parentId = span.parentSpanId
    while (parentId) {
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
    let current: RecordedSpanEvent | undefined = span
    while (current) {
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
