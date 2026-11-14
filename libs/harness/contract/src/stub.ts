import { Effect } from "effect"

/** Canonical plan-skeleton helper (docs/mvp_v2.md §6).
 * Preserves inferred A, E, R channels inside Effect.fn and consumes arguments for oxlint.
 * Allowed during `HARNESS_PLAN_CHECK=1`; banned by `harness/syntax-bans` during `verify`. */
export const stub = <A, E = never, R = never>(
  ..._usedArgs: ReadonlyArray<unknown>
): Effect.Effect<A, E, R> => Effect.die("HARNESS_PLAN_STUB")
