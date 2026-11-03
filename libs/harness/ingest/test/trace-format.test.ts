import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  ExercisesSpanEdge,
  makeTraceHeader,
  TracedCallEdge,
  TraceHeader,
  TRACE_FORMAT_VERSION,
} from "../src/trace-format.js"

describe("trace format (v2 Omnigraph & root TestSpan)", () => {
  it("emits the effect-span header with sampled:false", () => {
    expect(TRACE_FORMAT_VERSION).toBe(2)
    const rawHeader: unknown = makeTraceHeader("/repo")
    const header = Schema.decodeUnknownSync(TraceHeader)(rawHeader)
    expect(header.sampled).toBe(false)
    expect(header.tracer).toBe("effect-span")
  })

  it("validates TracedCallEdge and ExercisesSpanEdge records for Omnigraph sync", () => {
    const rawCall: unknown = {
      callerQualname: "libs/sample/domain/src/index.ts#greet",
      calleeQualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
      callCount: 1,
      receiverLayer: "libs/sample/infra/src/index.ts#PhotoRepoLive",
    }
    const call = Schema.decodeUnknownSync(TracedCallEdge)(rawCall)
    expect(call.callCount).toBe(1)

    const rawExercise: unknown = {
      testId: "libs/sample/domain/test/index.test.ts::greet greets by name",
      calleeQualname: "libs/sample/domain/src/index.ts#greet",
      callCount: 1,
      receiverLayer: null,
    }
    const exercise = Schema.decodeUnknownSync(ExercisesSpanEdge)(rawExercise)
    expect(exercise.testId).toContain("greet")
  })
})
