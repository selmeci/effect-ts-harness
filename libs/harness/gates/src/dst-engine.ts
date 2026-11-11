import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { match } from "ts-pattern"

export const DstSeed = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DstSeed"),
)
export type DstSeed = typeof DstSeed.Type

export const DstStepIndex = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DstStepIndex"),
)
export type DstStepIndex = typeof DstStepIndex.Type

export const DstStepCount = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 512 })),
  Schema.brand("DstStepCount"),
)
export type DstStepCount = typeof DstStepCount.Type

export const DstTickMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DstTickMillis"),
)
export type DstTickMillis = typeof DstTickMillis.Type

export const DstProbabilityMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("DstProbabilityMillis"),
)
export type DstProbabilityMillis = typeof DstProbabilityMillis.Type

export const DstServiceTag = Schema.NonEmptyString.pipe(Schema.brand("DstServiceTag"))
export type DstServiceTag = typeof DstServiceTag.Type

export const DstMethodName = Schema.NonEmptyString.pipe(Schema.brand("DstMethodName"))
export type DstMethodName = typeof DstMethodName.Type

export const DstErrorTag = Schema.NonEmptyString.pipe(Schema.brand("DstErrorTag"))
export type DstErrorTag = typeof DstErrorTag.Type

export const DstMessage = Schema.NonEmptyString.pipe(Schema.brand("DstMessage"))
export type DstMessage = typeof DstMessage.Type

export const DST_HAZARD_RISK_LEVELS = [
  "pure_lookup",
  "idempotent_io",
  "stateful_mutation",
  "distributed_saga_step",
] as const

export const DstHazardRiskLevel = Schema.Literals(DST_HAZARD_RISK_LEVELS).pipe(
  Schema.brand("DstHazardRiskLevel"),
)
export type DstHazardRiskLevel = typeof DstHazardRiskLevel.Type

export const DstExecutionTier = Schema.Literals(["fast", "full"]).pipe(
  Schema.brand("DstExecutionTier"),
)
export type DstExecutionTier = typeof DstExecutionTier.Type

export const FAST_DST_SEED_COUNT = DstStepCount.make(10)
export const FULL_DST_SEED_COUNT = DstStepCount.make(100)

export const HAZARD_LEVEL_DEFAULT_MILLIS: Readonly<
  Record<(typeof DST_HAZARD_RISK_LEVELS)[number], number>
> = {
  pure_lookup: 100,
  idempotent_io: 300,
  stateful_mutation: 650,
  distributed_saga_step: 900,
}

export const DstTargetServiceMethod = Schema.Struct({
  serviceTag: DstServiceTag,
  methodName: DstMethodName,
  declaredErrors: Schema.Array(DstErrorTag),
  hazardRiskLevel: Schema.optional(DstHazardRiskLevel),
})
export type DstTargetServiceMethod = typeof DstTargetServiceMethod.Type

export const DstEngineConfig = Schema.Struct({
  seed: DstSeed,
  stepCount: DstStepCount,
  targets: Schema.Array(DstTargetServiceMethod),
  baseFailureProbMillis: DstProbabilityMillis,
  baseDelayProbMillis: DstProbabilityMillis,
  baseInterruptProbMillis: DstProbabilityMillis,
  maxDelayTicksMs: DstTickMillis,
  hazardPriors: Schema.optional(Schema.Record(Schema.String, DstProbabilityMillis)),
})
export type DstEngineConfig = typeof DstEngineConfig.Type

export const DstSucceedAfterDelay = Schema.TaggedStruct("SucceedAfterDelay", {
  delayMs: DstTickMillis,
})
export type DstSucceedAfterDelay = typeof DstSucceedAfterDelay.Type

export const DstFailWithError = Schema.TaggedStruct("FailWithError", {
  delayMs: DstTickMillis,
  errorTag: DstErrorTag,
})
export type DstFailWithError = typeof DstFailWithError.Type

export const DstInterruptFiber = Schema.TaggedStruct("InterruptFiber", {
  delayMs: DstTickMillis,
})
export type DstInterruptFiber = typeof DstInterruptFiber.Type

export const DstYieldThenContinue = Schema.TaggedStruct("YieldThenContinue", {
  delayMs: DstTickMillis,
})
export type DstYieldThenContinue = typeof DstYieldThenContinue.Type

export const DstFaultDecision = Schema.Union([
  DstSucceedAfterDelay,
  DstFailWithError,
  DstInterruptFiber,
  DstYieldThenContinue,
])
export type DstFaultDecision = typeof DstFaultDecision.Type

export const DstFaultStep = Schema.Struct({
  stepIndex: DstStepIndex,
  serviceTag: DstServiceTag,
  methodName: DstMethodName,
  decision: DstFaultDecision,
})
export type DstFaultStep = typeof DstFaultStep.Type

export const DstSchedule = Schema.Struct({
  seed: DstSeed,
  steps: Schema.Array(DstFaultStep),
})
export type DstSchedule = typeof DstSchedule.Type

export class DstScheduleError extends Schema.TaggedError<DstScheduleError>()("DstScheduleError", {
  seed: DstSeed,
  message: DstMessage,
}) {}

export const DstSimulationOptions = Schema.Struct({
  seed: DstSeed,
  tickMs: DstTickMillis,
  maxTicks: DstStepCount,
})
export type DstSimulationOptions = typeof DstSimulationOptions.Type

const MASK_64 = 0xffffffffffffffffn
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n
const XORSHIFT_MULT = 0x2545f4914f6cdd1dn

export interface XorShift64StarPrng {
  readonly nextUint64: () => bigint
  readonly nextInt: (exclusiveMax: number) => number
}

export const makeXorShift64Star = (seed: DstSeed): XorShift64StarPrng => {
  let state = (BigInt(seed) ^ GOLDEN_GAMMA) & MASK_64
  if (state === 0n) {
    state = GOLDEN_GAMMA
  }

  const nextUint64 = (): bigint => {
    state ^= state >> 12n
    state ^= (state << 25n) & MASK_64
    state ^= state >> 27n
    return (state * XORSHIFT_MULT) & MASK_64
  }

  const nextInt = (exclusiveMax: number): number => {
    const bound = Math.max(1, Math.floor(exclusiveMax))
    const raw = nextUint64()
    return Number(raw % BigInt(bound))
  }

  return { nextUint64, nextInt }
}

const resolveEffectiveFailureProbMillis = (
  target: DstTargetServiceMethod,
  config: DstEngineConfig,
): number => {
  const key = `${target.serviceTag}.${target.methodName}`
  const explicitPrior = config.hazardPriors?.[key] ?? config.hazardPriors?.[target.serviceTag]
  if (explicitPrior !== undefined) {
    return Math.min(1000, Math.max(0, Math.round((config.baseFailureProbMillis + explicitPrior) / 2)))
  }
  if (target.hazardRiskLevel !== undefined) {
    const levelPrior =
      HAZARD_LEVEL_DEFAULT_MILLIS[
        target.hazardRiskLevel as (typeof DST_HAZARD_RISK_LEVELS)[number]
      ]
    return Math.min(1000, Math.max(0, Math.round((config.baseFailureProbMillis + levelPrior) / 2)))
  }
  return config.baseFailureProbMillis
}

export const decideDstSchedule = Effect.fn("DstEngine.decide")(function* (
  config: DstEngineConfig,
): Effect.fn.Return<DstSchedule, DstScheduleError, never> {
  if (config.targets.length === 0) {
    return yield* new DstScheduleError({
      seed: config.seed,
      message: DstMessage.make(
        `DstEngine.decide requires at least one target service method (seed=${config.seed}).`,
      ),
    })
  }
  if (config.stepCount < 1 || config.stepCount > 512) {
    return yield* new DstScheduleError({
      seed: config.seed,
      message: DstMessage.make(
        `DstEngine.decide stepCount=${config.stepCount} is out of bounds [1, 512] (seed=${config.seed}).`,
      ),
    })
  }

  const prng = makeXorShift64Star(config.seed)
  const steps: Array<DstFaultStep> = []

  for (let i = 0; i < config.stepCount; i++) {
    const targetIdx = i < config.targets.length ? i : prng.nextInt(config.targets.length)
    const target = config.targets[targetIdx]!
    const effectiveFailProb = resolveEffectiveFailureProbMillis(target, config)
    const roll = prng.nextInt(1000)
    const rawDelay =
      config.maxDelayTicksMs > 0 ? prng.nextInt(config.maxDelayTicksMs + 1) : 0
    const delayMs = DstTickMillis.make(rawDelay)

    let decision: DstFaultDecision
    if (roll < effectiveFailProb && target.declaredErrors.length > 0) {
      const errIdx = prng.nextInt(target.declaredErrors.length)
      const errorTag = target.declaredErrors[errIdx]!
      decision = DstFailWithError.make({
        delayMs,
        errorTag,
      })
    } else if (roll < effectiveFailProb + config.baseInterruptProbMillis) {
      decision = DstInterruptFiber.make({ delayMs })
    } else if (
      roll <
      effectiveFailProb + config.baseInterruptProbMillis + config.baseDelayProbMillis
    ) {
      decision = DstSucceedAfterDelay.make({
        delayMs: DstTickMillis.make(Math.max(1, rawDelay)),
      })
    } else {
      decision = DstYieldThenContinue.make({
        delayMs: DstTickMillis.make(0),
      })
    }

    steps.push({
      stepIndex: DstStepIndex.make(i),
      serviceTag: target.serviceTag,
      methodName: target.methodName,
      decision,
    })
  }

  return {
    seed: config.seed,
    steps,
  }
})

export const DstEngine = {
  decide: decideDstSchedule,
} as const

export interface ChaosFaultControllerShape {
  readonly seed: DstSeed
  readonly schedule: DstSchedule
  readonly nextStepFor: (
    serviceTag: DstServiceTag,
    methodName: DstMethodName,
  ) => Effect.Effect<DstFaultDecision>
}

export class ChaosFaultController extends Context.Service<
  ChaosFaultController,
  ChaosFaultControllerShape
>()("@harness/gates/ChaosFaultController") {}

export const makeChaosLayer = (
  schedule: DstSchedule,
): Layer.Layer<ChaosFaultController> =>
  Layer.effect(
    ChaosFaultController,
    Effect.gen(function* () {
      const cursorRef = yield* Ref.make(0)
      return {
        seed: schedule.seed,
        schedule,
        nextStepFor: (serviceTag, methodName) =>
          Effect.gen(function* () {
            const decision = yield* Ref.modify(cursorRef, (cursor) => {
              const matchIdx = schedule.steps.findIndex(
                (s, idx) =>
                  idx >= cursor && s.serviceTag === serviceTag && s.methodName === methodName,
              )
              if (matchIdx !== -1) {
                return [schedule.steps[matchIdx]!.decision, matchIdx + 1] as const
              }
              return [
                DstYieldThenContinue.make({
                  delayMs: DstTickMillis.make(0),
                }),
                cursor + 1,
              ] as const
            })

            const waitEffect =
              decision.delayMs > 0
                ? Effect.sleep(Duration.millis(decision.delayMs))
                : Effect.yieldNow

            yield* waitEffect
            return decision
          }),
      }
    }),
  )

/**
 * Deadlock-free virtual clock driver for Deterministic Simulation Testing (`RFC-0005 §4.2.2`).
 * Forks the tested `program` fiber and advances `TestClock` from a decoupled supervisor fiber
 * (`Effect.yieldNow` -> `TestClock.adjust`) so a failing or sleeping service method never
 * deadlocks sibling fibers.
 */
export const runWithDecoupledClockDriver = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: DstSimulationOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "dst.seed": options.seed,
      "dst.reproduce": `DST_SEED=${options.seed}`,
    })
    const mainFiber = yield* Effect.forkChild(program)
    const clockDriver = yield* Effect.forkChild(
      Effect.repeat(
        Effect.gen(function* () {
          yield* Effect.yieldNow
          yield* TestClock.adjust(Duration.millis(options.tickMs))
        }),
        Schedule.recurs(options.maxTicks),
      ),
    )

    const outcome = yield* Effect.raceFirst(
      Fiber.await(mainFiber).pipe(Effect.map((exit) => ({ _tag: "Program" as const, exit }))),
      Fiber.await(clockDriver).pipe(Effect.as({ _tag: "ClockExhausted" as const })),
    )

    return yield* match(outcome)
      .with({ _tag: "Program" }, ({ exit }) =>
        Effect.gen(function* () {
          yield* Fiber.interrupt(clockDriver)
          return yield* match(exit)
            .with({ _tag: "Success" }, ({ value }) => Effect.succeed(value))
            .with({ _tag: "Failure" }, ({ cause }) => Effect.failCause(cause))
            .exhaustive()
        }),
      )
      .with({ _tag: "ClockExhausted" }, () =>
        Effect.gen(function* () {
          yield* Fiber.interrupt(mainFiber)
          return yield* Effect.die(
            new Error(
              `DST simulation seed=${options.seed} deadlocked: TestClock exceeded maxTicks=${options.maxTicks} (${options.maxTicks * options.tickMs}ms) before main program completed.`,
            ),
          )
        }),
      )
      .exhaustive()
  })

export const withDeterministicFaults = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  config: DstEngineConfig,
  tickMs: DstTickMillis = DstTickMillis.make(10),
): Effect.Effect<A, E | DstScheduleError, Exclude<R, ChaosFaultController>> =>
  Effect.gen(function* () {
    const schedule = yield* decideDstSchedule(config)
    const chaosLayer = makeChaosLayer(schedule)
    return yield* runWithDecoupledClockDriver(
      program.pipe(Effect.provide(chaosLayer)),
      {
        seed: config.seed,
        tickMs,
        maxTicks: DstStepCount.make(Math.min(512, Math.max(16, config.stepCount * 4))),
      },
    )
  })

export const resolveDstSeedsForTier = (
  tier?: DstExecutionTier,
  envSeed?: string,
): ReadonlyArray<DstSeed> => {
  const rawSeed = envSeed ?? process.env.DST_SEED
  if (rawSeed !== undefined && /^\d+$/.test(rawSeed.trim())) {
    return [DstSeed.make(Number(rawSeed.trim()))]
  }
  const effectiveTier =
    tier ?? DstExecutionTier.make(process.env.CI === "true" ? "full" : "fast")
  const count = effectiveTier === "full" ? FULL_DST_SEED_COUNT : FAST_DST_SEED_COUNT
  return Array.from({ length: count }, (_, idx) => DstSeed.make(idx))
}
