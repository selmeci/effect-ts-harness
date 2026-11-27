import { Effect } from "effect"
import { classifyCommand, type GuardVerdict } from "./policy.js"

/** Input payload for `PolicyFastPath.decide`. */
export interface PolicyFastPathInput {
  readonly command: string
  readonly unitWorkerMode?: boolean | undefined
}

/**
 * Pure Effect wrapper around `classifyCommand` (`R = never`) for fast-path guard evaluation (`SPEC-0037 REQ-4.4`).
 */
export const decidePolicyFastPath = Effect.fn("PolicyFastPath.decide")(function* (
  input: PolicyFastPathInput,
): Effect.fn.Return<GuardVerdict, never, never> {
  return yield* Effect.succeed(
    classifyCommand(
      input.command,
      input.unitWorkerMode !== undefined ? { unitWorkerMode: input.unitWorkerMode } : undefined,
    ),
  )
})

/** Deterministic fast-path policy decision module (`SPEC-0037 REQ-4.4`). */
export const PolicyFastPath = {
  decide: decidePolicyFastPath,
} as const
