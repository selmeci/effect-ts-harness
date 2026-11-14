/**
 * @fileoverview ActiveMutantContext service managing scoped mutant activation and isolation.
 */
import { Effect } from "effect"
import { type ActiveMutantId } from "@harness/contract"
import { ActiveMutantContext } from "@harness/service"

interface GlobalWithMutantId {
  __HARNESS_ACTIVE_MUTANT_ID?: string | undefined
}

export const getActiveMutantId = (): string | undefined =>
  (globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID ??
  process.env["HARNESS_ACTIVE_MUTANT_ID"]

export const setActiveMutantId = (mutantId: string | undefined): void => {
  ;(globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID = mutantId
}

export const withActiveMutantEffect = Effect.fn("MutationCheck.withActiveMutant")(function* (
  mutantId: ActiveMutantId,
  effect: Effect.Effect<boolean>,
): Effect.fn.Return<boolean, never, ActiveMutantContext> {
  const ctx = yield* ActiveMutantContext
  return yield* ctx.runWithMutant(mutantId, effect)
})
