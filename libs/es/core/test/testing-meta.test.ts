import { Cause, Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { match } from "ts-pattern"
import { makeDeciderTestHarness } from "../src/testing.js"

class FakeDomainError extends Schema.TaggedError<FakeDomainError>()("FakeDomainError", {
  reason: Schema.String
}) {}

describe("BDD Runner Meta-Tests (Assertion Engine Integrity)", () => {
  type TestEvent = { readonly _tag: "TestEvent"; readonly value: number }

  const succeedingDecider: {
    initialState: number
    evolve: (s: number, _e: TestEvent) => number
    decide: (
      _cmd: string,
      _s: number
    ) => Effect.Effect<ReadonlyArray<TestEvent>, FakeDomainError, never>
  } = {
    initialState: 0,
    evolve: (s: number, _e: TestEvent) => s + 1,
    decide: (_cmd: string, _s: number) =>
      Effect.succeed([{ _tag: "TestEvent" as const, value: 42 }])
  }

  const failingDecider = {
    initialState: 0,
    evolve: (s: number, _e: TestEvent) => s,
    decide: (_cmd: string, _s: number) =>
      Effect.fail(new FakeDomainError({ reason: "boom" }))
  }

  const dyingDecider: {
    initialState: number
    evolve: (s: number, _e: TestEvent) => number
    decide: (
      _cmd: string,
      _s: number
    ) => Effect.Effect<ReadonlyArray<TestEvent>, FakeDomainError, never>
  } = {
    initialState: 0,
    evolve: (s: number, _e: TestEvent) => s,
    decide: (_cmd: string, _s: number) =>
      Effect.die(new Error("fatal defect"))
  }

  const emptyDecider = {
    initialState: 0,
    evolve: (s: number, _e: TestEvent) => s,
    decide: (_cmd: string, _s: number) =>
      Effect.succeed([])
  }

  it.effect("runner succeeds on .thenNothing() when decider returns empty array", () =>
    makeDeciderTestHarness(emptyDecider)
      .given([])
      .when("noop")
      .thenNothing()
  )

  it.effect("runner dies on .thenNothing() when decider unexpectedly emits events", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(succeedingDecider)
          .given([])
          .when("cmd")
          .thenNothing()
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail when events emitted on thenNothing")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies on .thenNothing() when decider fails with typed error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(failingDecider)
          .given([])
          .when("cmd")
          .thenNothing()
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
          expect(Cause.pretty(f.cause)).toContain("Expected empty event list but decider failed")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail when decider fails on thenNothing")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when decider fails instead of emitting expected events", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(failingDecider)
          .given([])
          .when("cmd")
          .thenEvents([{ _tag: "TestEvent", value: 42 }])
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
          expect(Cause.pretty(f.cause)).toContain("Expected events but decider failed")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail when decider fails instead of emitting events")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when event count does not match expected", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(succeedingDecider)
          .given([])
          .when("cmd")
          .thenEvents([
            { _tag: "TestEvent", value: 42 },
            { _tag: "TestEvent", value: 43 }
          ])
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail on event count mismatch")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when event payload does not match expected", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(succeedingDecider)
          .given([])
          .when("cmd")
          .thenEvents([{ _tag: "TestEvent", value: 999 }])
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail on payload mismatch")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when decider succeeds instead of expected failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(succeedingDecider)
          .given([])
          .when("cmd")
          .thenFails(new FakeDomainError({ reason: "boom" }))
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
          expect(Cause.pretty(f.cause)).toContain("Expected decider failure but succeeded")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail when decider unexpectedly succeeds")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when decider dies with defect instead of typed failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(dyingDecider)
          .given([])
          .when("cmd")
          .thenFails(new FakeDomainError({ reason: "boom" }))
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail when decider dies with defect")
        })
        .exhaustive()
    })
  )

  it.effect("runner dies when decider fails with different typed error payload", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDeciderTestHarness(failingDecider)
          .given([])
          .when("cmd")
          .thenFails(new FakeDomainError({ reason: "different reason" }))
      )
      match(exit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runner to fail on mismatched error payload")
        })
        .exhaustive()
    })
  )
})
