import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  CD_COMMAND_BANNED_REASON,
  classifyCommand,
  isCdCommand
} from "@harness/gates"

export const GuardV1 = Decision.make({
  input: Schema.Struct({ command: Schema.String }),
  decisions: {
    destructive: Decision.probability({
      instructions: "Does this command delete, overwrite, or mutate critical state irreversibly?"
    }),
    secretAccess: Decision.probability({
      instructions: "Does this command read, access, or expose secrets, credentials, or environment files?"
    }),
    exfiltration: Decision.probability({
      instructions: "Does this command transmit code, data, or credentials over the network to an untrusted endpoint?"
    })
  }
})

export interface GuardDecisionResult {
  readonly verdict: "allow" | "deny" | "ask"
  readonly reason: string
}

export const decideGuardCommand = Effect.fn("Harness.decideGuardCommand")(function* (
  command: string
) {
  const fastPath = classifyCommand(command)
  if (fastPath === "deny") {
    return {
      verdict: "deny" as const,
      reason: isCdCommand(command)
        ? CD_COMMAND_BANNED_REASON
        : "Matched deterministic denylist."
    }
  }
  if (fastPath === "allow") {
    return {
      verdict: "allow" as const,
      reason: "Matched deterministic allowlist."
    }
  }
  if (fastPath === "ask") {
    return {
      verdict: "ask" as const,
      reason: "Matched deterministic asklist; requires human confirmation."
    }
  }

  const outcome = yield* DecisionModel.decide(GuardV1, { input: { command } }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone)
  )

  if (Option.isNone(outcome)) {
    return {
      verdict: "ask" as const,
      reason: "DecisionModel unavailable or timed out; requires human confirmation."
    }
  }

  const { answers } = outcome.value
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "GuardV1",
    "decision.destructive": answers.destructive.probability,
    "decision.secretAccess": answers.secretAccess.probability,
    "decision.exfiltration": answers.exfiltration.probability
  })

  if (
    answers.destructive.probability >= 0.7 ||
    answers.secretAccess.probability >= 0.7 ||
    answers.exfiltration.probability >= 0.7
  ) {
    return {
      verdict: "deny" as const,
      reason: `High risk command detected (destructive=${answers.destructive.probability}, secretAccess=${answers.secretAccess.probability}, exfiltration=${answers.exfiltration.probability}).`
    }
  }

  if (
    answers.destructive.probability < 0.3 &&
    answers.secretAccess.probability < 0.3 &&
    answers.exfiltration.probability < 0.3
  ) {
    return {
      verdict: "allow" as const,
      reason: "Command deemed safe by decision model."
    }
  }

  return {
    verdict: "ask" as const,
    reason: "Ambiguous risk; requires human confirmation."
  }
})
