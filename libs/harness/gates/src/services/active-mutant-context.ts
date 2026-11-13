/**
 * @fileoverview ActiveMutantContext service managing scoped mutant activation and isolation.
 */
import { Context, Effect, Layer, Option, Semaphore, SynchronizedRef } from "effect"
import { type ActiveMutantId } from "../plugins/self-dogfooding-contract.js"

interface GlobalWithMutantId {
  __HARNESS_ACTIVE_MUTANT_ID?: string | undefined
  __harnessActiveMutant?: string | undefined
}

export const getActiveMutantId = (): string | undefined =>
  (globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID ??
  (globalThis as GlobalWithMutantId).__harnessActiveMutant ??
  process.env["HARNESS_ACTIVE_MUTANT_ID"]

export const setActiveMutantId = (mutantId: string | undefined): void => {
  ;(globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID = mutantId
  ;(globalThis as GlobalWithMutantId).__harnessActiveMutant = mutantId
}

export interface ActiveMutantContextShape {
  readonly getCurrentMutant: Effect.Effect<Option.Option<ActiveMutantId>>
  readonly runWithMutant: <A, E, R>(
    mutantId: ActiveMutantId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ActiveMutantContext extends Context.Service<
  ActiveMutantContext,
  ActiveMutantContextShape
>()("@harness/gates/ActiveMutantContext") {}

export const ActiveMutantContextLive: Layer.Layer<ActiveMutantContext> = Layer.effect(
  ActiveMutantContext,
  Effect.gen(function* () {
    const stateRef = yield* SynchronizedRef.make<Option.Option<ActiveMutantId>>(Option.none())
    const sem = yield* Semaphore.make(1)
    let holdingFiberId: number | undefined = undefined

    return {
      getCurrentMutant: SynchronizedRef.get(stateRef),
      runWithMutant: <A, E, R>(mutantId: ActiveMutantId, effect: Effect.Effect<A, E, R>) =>
        Effect.withFiber((fiber) => {
          const isSameFiber = holdingFiberId !== undefined && holdingFiberId === fiber.id
          const bracket = Effect.acquireUseRelease(
            SynchronizedRef.modify(stateRef, (prev) => {
              const prevGlobal = getActiveMutantId()
              const prevHolder = holdingFiberId
              holdingFiberId = fiber.id
              setActiveMutantId(mutantId)
              return [{ prevRef: prev, prevGlobal, prevHolder }, Option.some(mutantId)] as const
            }),
            () => effect,
            ({ prevRef, prevGlobal, prevHolder }) =>
              SynchronizedRef.set(stateRef, prevRef).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    holdingFiberId = prevHolder
                    setActiveMutantId(prevGlobal)
                  }),
                ),
              ),
          )
          return isSameFiber ? bracket : sem.withPermits(1)(bracket)
        }),
    }
  }),
)

export const withActiveMutantEffect = Effect.fn("MutationCheck.withActiveMutant")(function* (
  mutantId: ActiveMutantId,
  callbackOrEffect: (() => boolean) | Effect.Effect<boolean>,
): Effect.fn.Return<boolean, never, ActiveMutantContext> {
  const ctx = yield* ActiveMutantContext
  const eff =
    typeof callbackOrEffect === "function"
      ? Effect.sync(callbackOrEffect)
      : callbackOrEffect
  return yield* ctx.runWithMutant(mutantId, eff)
})
