import { Cause, Effect, Equal } from "effect"
import { expect } from "@effect/vitest"
import { match } from "ts-pattern"
import type { Decider } from "./decider.js"

export interface DeciderTestScenario<Command, Event, Err> {
  readonly when: (command: Command) => {
    readonly thenEvents: (expectedEvents: ReadonlyArray<Event>) => Effect.Effect<void, never, never>
    readonly thenNothing: () => Effect.Effect<void, never, never>
    readonly thenFails: (expectedError: Err) => Effect.Effect<void, never, never>
  }
}

export const makeDeciderTestHarness = <Command, Event, State, Err>(
  decider: Decider<Command, Event, State, Err>,
) => ({
  given: (history: ReadonlyArray<Event>): DeciderTestScenario<Command, Event, Err> => {
    const currentState = history.reduce(decider.evolve, decider.initialState)
    return {
      when: (command: Command) => ({
        thenEvents: (expectedEvents: ReadonlyArray<Event>): Effect.Effect<void, never, never> =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            yield* match(exit)
              .with({ _tag: "Success" }, (s): Effect.Effect<void, never, never> => {
                expect(s.value.length).toBe(expectedEvents.length)
                expect(Equal.equals(s.value, expectedEvents)).toBe(true)
                return Effect.void
              })
              .with({ _tag: "Failure" }, (f): Effect.Effect<void, never, never> =>
                Effect.die(
                  new Error(`Expected events but decider failed: ${Cause.pretty(f.cause)}`),
                ),
              )
              .exhaustive()
          }),

        thenNothing: (): Effect.Effect<void, never, never> =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            yield* match(exit)
              .with({ _tag: "Success" }, (s): Effect.Effect<void, never, never> => {
                expect(s.value.length).toBe(0)
                return Effect.void
              })
              .with({ _tag: "Failure" }, (f): Effect.Effect<void, never, never> =>
                Effect.die(
                  new Error(
                    `Expected empty event list but decider failed: ${Cause.pretty(f.cause)}`,
                  ),
                ),
              )
              .exhaustive()
          }),

        thenFails: (expectedError: Err): Effect.Effect<void, never, never> =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            yield* match(exit)
              .with({ _tag: "Success" }, (s): Effect.Effect<void, never, never> =>
                Effect.die(
                  new Error(
                    `Expected decider failure but succeeded with ${JSON.stringify(s.value)}`,
                  ),
                ),
              )
              .with({ _tag: "Failure" }, (f): Effect.Effect<void, never, never> => {
                expect(Cause.hasDies(f.cause)).toBe(false)
                const errorOpt = Cause.findErrorOption(f.cause)
                match(errorOpt)
                  .with({ _tag: "Some" }, (some) => {
                    expect(Equal.equals(some.value, expectedError)).toBe(true)
                  })
                  .with({ _tag: "None" }, () => {
                    expect.unreachable("Expected typed error but found None")
                  })
                  .exhaustive()
                return Effect.void
              })
              .exhaustive()
          }),
      }),
    }
  },
})

export interface AggregateApiSpecConfig<Event, _Response, Err, Env = never> {
  readonly seedEvents: (history: ReadonlyArray<Event>) => Effect.Effect<void, Err, Env>
  readonly readAppendedEvents: Effect.Effect<ReadonlyArray<Event>, Err, Env>
}

export interface AggregateApiTestScenario<Event, Response, Err, Env = never> {
  readonly when: <CallErr, CallEnv = never>(
    executeRequest: Effect.Effect<Response, CallErr, CallEnv>,
  ) => {
    readonly thenStatusAndEvents: (
      expectedResponse: Response,
      expectedAppendedEvents: ReadonlyArray<Event>,
    ) => Effect.Effect<void, never, Env | CallEnv>
    readonly thenFails: (expectedError: Err | CallErr) => Effect.Effect<void, never, Env | CallEnv>
  }
}

export const makeAggregateApiTestHarness = <Event, Response, Err, Env = never>(
  config: AggregateApiSpecConfig<Event, Response, Err, Env>,
) => ({
  given: (history: ReadonlyArray<Event>): AggregateApiTestScenario<Event, Response, Err, Env> => ({
    when: <CallErr, CallEnv = never>(
      executeRequest: Effect.Effect<Response, CallErr, CallEnv>,
    ) => ({
      thenStatusAndEvents: (
        expectedResponse: Response,
        expectedAppendedEvents: ReadonlyArray<Event>,
      ): Effect.Effect<void, never, Env | CallEnv> =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              yield* config.seedEvents(history)
              const response = yield* executeRequest
              const appended = yield* config.readAppendedEvents
              return { response, appended }
            }),
          )
          yield* match(exit)
            .with({ _tag: "Success" }, (s): Effect.Effect<void, never, never> => {
              expect(Equal.equals(s.value.response, expectedResponse)).toBe(true)
              expect(s.value.appended.length).toBe(expectedAppendedEvents.length)
              expect(Equal.equals(s.value.appended, expectedAppendedEvents)).toBe(true)
              return Effect.void
            })
            .with({ _tag: "Failure" }, (f): Effect.Effect<void, never, never> =>
              Effect.die(
                new Error(
                  `Expected AggregateApiSpec success with events but failed: ${Cause.pretty(f.cause)}`,
                ),
              ),
            )
            .exhaustive()
        }),

      thenFails: (expectedError: Err | CallErr): Effect.Effect<void, never, Env | CallEnv> =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              yield* config.seedEvents(history)
              return yield* executeRequest
            }),
          )
          yield* match(exit)
            .with({ _tag: "Success" }, (s): Effect.Effect<void, never, never> =>
              Effect.die(
                new Error(
                  `Expected AggregateApiSpec failure but succeeded with ${JSON.stringify(s.value)}`,
                ),
              ),
            )
            .with({ _tag: "Failure" }, (f): Effect.Effect<void, never, never> => {
              expect(Cause.hasDies(f.cause)).toBe(false)
              const errorOpt = Cause.findErrorOption(f.cause)
              match(errorOpt)
                .with({ _tag: "Some" }, (some) => {
                  expect(Equal.equals(some.value, expectedError)).toBe(true)
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed error in AggregateApiSpec but found None")
                })
                .exhaustive()
              return Effect.void
            })
            .exhaustive()
        }),
    }),
  }),
})
