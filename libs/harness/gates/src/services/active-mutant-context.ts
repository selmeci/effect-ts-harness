import { Context, Effect, Layer, Option, Semaphore, SynchronizedRef } from "effect"
import { type ActiveMutantId } from "../plugins/self-dogfooding-contract.js"
import { getActiveMutantId, setActiveMutantId } from "../mutation-check.js"

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

    return {
      getCurrentMutant: SynchronizedRef.get(stateRef),
      runWithMutant: <A, E, R>(mutantId: ActiveMutantId, effect: Effect.Effect<A, E, R>) =>
        sem.withPermits(1)(
          Effect.acquireUseRelease(
            SynchronizedRef.modify(stateRef, (prev) => {
              const prevGlobal = getActiveMutantId()
              setActiveMutantId(mutantId)
              return [{ prevRef: prev, prevGlobal }, Option.some(mutantId)] as const
            }),
            () => effect,
            ({ prevRef, prevGlobal }) =>
              SynchronizedRef.set(stateRef, prevRef).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    setActiveMutantId(prevGlobal)
                  }),
                ),
              ),
          ),
        ),
    }
  }),
)

export const withActiveMutantEffect = Effect.fn("MutationCheck.withActiveMutant")(function* (
  mutantId: ActiveMutantId,
  callback: () => boolean,
): Effect.fn.Return<boolean, never, ActiveMutantContext> {
  const ctx = yield* ActiveMutantContext
  return yield* ctx.runWithMutant(mutantId, Effect.sync(() => callback()))
})
