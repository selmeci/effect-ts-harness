import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Context, Data, Effect } from "effect"
import { match } from "ts-pattern"
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

  it.effect("dies with HARNESS_PLAN_STUB if executed at runtime", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(stub<number>("unused-arg"))
      match(exit)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected stub to die with HARNESS_PLAN_STUB, got Success")
        })
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(String(Cause.squash(cause))).toContain("HARNESS_PLAN_STUB")
        })
        .exhaustive()
    }),
  )
})
