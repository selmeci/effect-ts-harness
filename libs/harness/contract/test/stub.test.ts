import { Cause, Context, Data, Effect, Exit } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { stub } from "../src/index.js"

class SampleError extends Data.TaggedError("SampleError")<{ readonly message: string }> {}
class SampleRepo extends Context.Service<
  SampleRepo,
  { readonly find: (id: string) => Effect.Effect<string> }
>()("SampleRepo") {}

describe("stub<A, E, R>", () => {
  it("preserves exact A, E, R types on Effect.fn skeletons", () => {
    const skeleton = Effect.fn("Sample.skeleton")(function* (id: string) {
      return yield* stub<{ readonly ok: boolean }, SampleError, SampleRepo>(id)
    })

    expectTypeOf(skeleton("123")).toEqualTypeOf<
      Effect.Effect<{ readonly ok: boolean }, SampleError, SampleRepo>
    >()
  })

  it("dies with HARNESS_PLAN_STUB if executed at runtime", () => {
    const exit = Effect.runSyncExit(stub<number>("unused-arg"))
    Exit.match(exit, {
      onSuccess: () => {
        expect.fail("Expected stub to die with HARNESS_PLAN_STUB, got Success")
      },
      onFailure: (cause) => {
        expect(Cause.hasDies(cause)).toBe(true)
        expect(String(Cause.squash(cause))).toContain("HARNESS_PLAN_STUB")
      },
    })
  })
})
