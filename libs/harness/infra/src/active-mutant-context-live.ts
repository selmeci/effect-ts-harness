/**
 * @fileoverview ActiveMutantContextLive — Context.Reference-backed fiber-local mutant isolation.
 */
import { Context, Effect, Layer, Option } from "effect"
import type { ActiveMutantId } from "@harness/contract"
import { ActiveMutantContext, type ActiveMutantContextShape } from "@harness/service"

const ActiveMutantRef = Context.Reference<Option.Option<ActiveMutantId>>(
  "@harness/infra/ActiveMutantRef",
  {
    defaultValue: () => Option.none(),
  },
)

/**
 * Live `ActiveMutantContext` layer backed by Effect v4 `Context.Reference` so
 * mutant IDs are strictly fiber-local and automatically restored on exit, failure,
 * or interruption without global mutable state.
 */
export const ActiveMutantContextLive: Layer.Layer<ActiveMutantContext> = Layer.effect(
  ActiveMutantContext,
  Effect.succeed<ActiveMutantContextShape>({
    getCurrentMutant: ActiveMutantRef,
    runWithMutant: <A, E, R>(mutantId: ActiveMutantId, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(ActiveMutantRef, Option.some(mutantId))),
  }),
)
