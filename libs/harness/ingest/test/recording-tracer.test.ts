import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { indexEffectFnsInFile } from "../src/fn-index.js"
import {
  SpanRecorder,
  runWithTestTracer,
  toTraceEdges,
  withRecordedTestSpan,
  type RecordedSpanEvent,
} from "../src/recording-tracer.js"

const greet = Effect.fn("Sample.greet")(function* (input: { readonly name: string }) {
  yield* Effect.void
  return `Hello, ${input.name}!`
})

const helper = Effect.fn("Sample.helper")(function* (name: string) {
  return yield* greet({ name })
})

describe("recording tracer with synthetic root TestSpan", () => {
  it.effect("records ExercisesSpan for a single-span leaf use case (Sample.greet)", () =>
    Effect.gen(function* () {
      const fnIndex = new Map([
        [
          "Sample.greet",
          indexEffectFnsInFile(
            "libs/sample/domain/src/index.ts",
            `export const greet = Effect.fn("Sample.greet")(function* () {})`,
            "domain",
          )[0]!,
        ],
      ])

      const { result, edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::greets by name",
        greet({ name: "Roman" }),
        fnIndex,
      )

      expect(result).toBe("Hello, Roman!")
      expect(edges.exercisesSpans).toEqual([
        {
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: null,
        },
      ])
    }),
  )

  it.effect("records both ExercisesSpan and parent->child TracedCall edges", () =>
    Effect.gen(function* () {
      const fns = indexEffectFnsInFile(
        "libs/sample/domain/src/index.ts",
        `
        export const greet = Effect.fn("Sample.greet")(function* () {})
        export const helper = Effect.fn("Sample.helper")(function* () {})
        `,
        "domain",
      )
      const fnIndex = new Map(fns.map((f) => [f.spanName, f]))

      const { edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::helper calls greet",
        helper("Roman"),
        fnIndex,
      )

      expect(edges.tracedCalls).toEqual([
        {
          callerQualname: "libs/sample/domain/src/index.ts#helper",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: null,
        },
      ])
      expect(edges.exercisesSpans).toHaveLength(2)
    }),
  )

  it.effect("aggregates repeated calls by summing callCount", () =>
    Effect.gen(function* () {
      const fns = indexEffectFnsInFile(
        "libs/sample/domain/src/index.ts",
        `
        export const greet = Effect.fn("Sample.greet")(function* () {})
        export const helper = Effect.fn("Sample.helper")(function* () {})
        `,
        "domain",
      )
      const fnIndex = new Map(fns.map((f) => [f.spanName, f]))

      const repeatEffect = Effect.gen(function* () {
        yield* helper("One")
        yield* helper("Two")
      })

      const { edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::repeated calls",
        repeatEffect,
        fnIndex,
      )

      expect(edges.tracedCalls).toEqual([
        {
          callerQualname: "libs/sample/domain/src/index.ts#helper",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 2,
          receiverLayer: null,
        },
      ])

      const helperExercise = edges.exercisesSpans.find(
        (e) => e.calleeQualname === "libs/sample/domain/src/index.ts#helper",
      )
      const greetExercise = edges.exercisesSpans.find(
        (e) => e.calleeQualname === "libs/sample/domain/src/index.ts#greet",
      )
      expect(helperExercise?.callCount).toBe(2)
      expect(greetExercise?.callCount).toBe(2)
    }),
  )

  it.effect("links external workerd spans with matching traceId", () =>
    Effect.gen(function* () {
      const fns = indexEffectFnsInFile(
        "libs/sample/domain/src/index.ts",
        `
        export const greet = Effect.fn("Sample.greet")(function* () {})
        export const externalHandler = Effect.fn("Sample.externalHandler")(function* () {})
        `,
        "domain",
      )
      const fnIndex = new Map(fns.map((f) => [f.spanName, f]))

      let capturedTraceId = ""
      const effectWithCapture = Effect.gen(function* () {
        const span = yield* Effect.currentSpan
        capturedTraceId = span.traceId
        return yield* greet({ name: "Roman" })
      })

      const testId = "libs/sample/domain/test/index.test.ts::external span test"
      const res = yield* runWithTestTracer(testId, effectWithCapture, fnIndex)

      const externalSpan: RecordedSpanEvent = {
        traceId: capturedTraceId,
        spanId: "ext-span-1",
        name: "Sample.externalHandler",
        parentSpanId: res.spans[0]?.spanId ?? null,
        attributes: {},
      }

      const edgesWithExternal = toTraceEdges([...res.spans, externalSpan], fnIndex)

      const externalExercise = edgesWithExternal.exercisesSpans.find(
        (e) => e.calleeQualname === "libs/sample/domain/src/index.ts#externalHandler",
      )
      expect(externalExercise).toEqual({
        testId,
        calleeQualname: "libs/sample/domain/src/index.ts#externalHandler",
        callCount: 1,
        receiverLayer: null,
      })
    }),
  )

  it.effect("respects receiverLayer attribute and default receiverLayer", () =>
    Effect.gen(function* () {
      const fnIndex = new Map([
        [
          "Sample.greet",
          indexEffectFnsInFile(
            "libs/sample/domain/src/index.ts",
            `export const greet = Effect.fn("Sample.greet")(function* () {})`,
            "domain",
          )[0]!,
        ],
      ])

      const { edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::receiverLayer test",
        greet({ name: "Roman" }),
        fnIndex,
        { receiverLayer: "SampleLive" },
      )

      expect(edges.exercisesSpans).toEqual([
        {
          testId: "libs/sample/domain/test/index.test.ts::receiverLayer test",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: "SampleLive",
        },
      ])
    }),
  )

  it.effect("withRecordedTestSpan combinator installs tracer and provides SpanRecorder", () =>
    Effect.gen(function* () {
      const effect = Effect.gen(function* () {
        const res = yield* greet({ name: "Roman" })
        const recorder = yield* SpanRecorder
        return { res, spanCount: recorder.spans.length }
      }).pipe(withRecordedTestSpan("libs/sample/domain/test/index.test.ts::combinator test"))

      const { res, spanCount } = yield* effect
      expect(res).toBe("Hello, Roman!")
      expect(spanCount).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect(
    "withRecordedTestSpan preserves receiverLayer from root TestSpan when toTraceEdges called without defaultReceiverLayer",
    () =>
      Effect.gen(function* () {
        const fnIndex = new Map([
          [
            "Sample.greet",
            indexEffectFnsInFile(
              "libs/sample/domain/src/index.ts",
              `export const greet = Effect.fn("Sample.greet")(function* () {})`,
              "domain",
            )[0]!,
          ],
        ])

        const testId = "libs/sample/domain/test/index.test.ts::receiverLayer from root TestSpan"
        const effect = Effect.gen(function* () {
          yield* greet({ name: "Roman" })
          const recorder = yield* SpanRecorder
          return recorder.toTraceEdges(fnIndex)
        }).pipe(withRecordedTestSpan(testId, "SampleLive"))

        const edges = yield* effect
        expect(edges.exercisesSpans).toEqual([
          {
            testId,
            calleeQualname: "libs/sample/domain/src/index.ts#greet",
            callCount: 1,
            receiverLayer: "SampleLive",
          },
        ])
      }),
  )

  it.effect("tracks durationMs when spans end via makeRecordingTracer", () =>
    Effect.gen(function* () {
      const fnIndex = new Map([
        [
          "Sample.greet",
          indexEffectFnsInFile(
            "libs/sample/domain/src/index.ts",
            `export const greet = Effect.fn("Sample.greet")(function* () {})`,
            "domain",
          )[0]!,
        ],
      ])

      const { spans } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::duration check",
        greet({ name: "Roman" }),
        fnIndex,
      )

      expect(spans.length).toBeGreaterThanOrEqual(1)
      for (const span of spans) {
        expect(span.durationMs).toBeDefined()
        expect(typeof span.durationMs).toBe("number")
        expect(span.durationMs).toBeGreaterThanOrEqual(0)
      }
    }),
  )
})
