import { Effect } from "effect"
import { type PolicyFastPathInput } from "@harness/contract"
import { classifyCommand, type GuardVerdict } from "./policy.js"

export type { PolicyFastPathInput }

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
