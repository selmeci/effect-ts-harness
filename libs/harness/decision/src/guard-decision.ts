import { Cause, Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { isPureInterruptCause } from "@harness/contract"
import { match } from "ts-pattern"
import { classifyCommand, explainCommandDenyReason } from "@harness/gates/hook-fastpath"

export const GuardV1 = Decision.make({
  input: Schema.Struct({ command: Schema.String }),
  decisions: {
    destructive: Decision.probability({
      instructions: "Does this command delete, overwrite, or mutate critical state irreversibly?",
    }),
    secretAccess: Decision.probability({
      instructions:
        "Does this command read, access, or expose secrets, credentials, or environment files?",
    }),
    exfiltration: Decision.probability({
      instructions:
        "Does this command transmit code, data, or credentials over the network to an untrusted endpoint?",
    }),
  },
})

export interface GuardCommandOptions {
  readonly unitWorkerMode?: boolean | undefined
}

export interface GuardCommandInput {
  readonly command: string
  readonly unitWorkerMode?: boolean | undefined
}

export interface GuardDecisionResult {
  readonly verdict: "allow" | "deny" | "ask"
  readonly reason: string
}

export const GUARD_DECISION_TIMEOUT_MS = 2500

const WORKER_SENSITIVE_FALLBACK_PATTERN =
  /\bharness(?:-cli)?\b|auth-tokens|daemon\.soc|\.harness\/omnigraph-cluster/i

export const decideGuardCommand = Effect.fn("Harness.decideGuardCommand")(function* (
  input: string | GuardCommandInput,
  options?: GuardCommandOptions,
) {
  const command = typeof input === "string" ? input : input.command
  const unitWorkerMode =
    typeof input === "string"
      ? options?.unitWorkerMode
      : (input.unitWorkerMode ?? options?.unitWorkerMode)
  const policyOptions = unitWorkerMode === undefined ? undefined : { unitWorkerMode }
  const fastPath = classifyCommand(command, policyOptions)
  return yield* match(fastPath)
    .with("deny", () =>
      Effect.succeed({
        verdict: "deny" as const,
        reason:
          explainCommandDenyReason(command, policyOptions) ?? "Matched deterministic denylist.",
      }),
    )
    .with("allow", () =>
      Effect.succeed({
        verdict: "allow" as const,
        reason: "Matched deterministic allowlist.",
      }),
    )
    .with("ask", () =>
      Effect.succeed({
        verdict: "ask" as const,
        reason: "Matched deterministic asklist; requires human confirmation.",
      }),
    )
    .with("escalate", () =>
      Effect.gen(function* () {
        const timedResult = yield* DecisionModel.decide(GuardV1, { input: { command } }).pipe(
          Effect.map((value) => ({ _tag: "Success" as const, value })),
          Effect.catchCauseIf(
            (cause) => !isPureInterruptCause(cause),
            (cause) => {
              const collapsed = Cause.pretty(cause).replace(/\s+/g, " ").trim()
              const truncated = collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed
              const detail = truncated.length > 0 ? truncated : "unknown error"
              return Effect.logWarning(`Decision model fallback: ${Cause.pretty(cause)}`).pipe(
                Effect.as({ _tag: "ModelError" as const, detail }),
              )
            },
          ),
          Effect.orElseSucceed(() => ({ _tag: "ModelError" as const, detail: "unknown error" })),
          Effect.timeoutOption(`${GUARD_DECISION_TIMEOUT_MS} millis`),
        )

        return yield* match(timedResult)
          .with({ _tag: "None" }, () =>
            Effect.logWarning(
              `GuardV1 DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requiring human confirmation.`,
            ).pipe(
              Effect.as({
                verdict: "ask" as const,
                reason: `DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requires human confirmation.`,
              }),
            ),
          )
          .with({ _tag: "Some", value: { _tag: "ModelError" } }, ({ value: { detail } }) =>
            Effect.succeed({
              verdict: "ask" as const,
              reason: `DecisionModel unavailable (${detail}); requires human confirmation.`,
            }),
          )
          .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { value } }) =>
            Effect.gen(function* () {
              const { answers } = value
              yield* Effect.annotateCurrentSpan({
                "decision.definition": "GuardV1",
                "decision.destructive": answers.destructive.probability,
                "decision.secretAccess": answers.secretAccess.probability,
                "decision.exfiltration": answers.exfiltration.probability,
              })

              if (
                answers.destructive.probability >= 0.7 ||
                answers.secretAccess.probability >= 0.7 ||
                answers.exfiltration.probability >= 0.7
              ) {
                return {
                  verdict: "deny" as const,
                  reason: `High risk command detected (destructive=${answers.destructive.probability}, secretAccess=${answers.secretAccess.probability}, exfiltration=${answers.exfiltration.probability}).`,
                }
              }

              if (
                answers.destructive.probability < 0.3 &&
                answers.secretAccess.probability < 0.3 &&
                answers.exfiltration.probability < 0.3
              ) {
                if (unitWorkerMode === true) {
                  const workerDenyReason = explainCommandDenyReason(command, {
                    unitWorkerMode: true,
                  })
                  if (workerDenyReason !== undefined) {
                    return {
                      verdict: "deny" as const,
                      reason: workerDenyReason,
                    }
                  }
                  if (WORKER_SENSITIVE_FALLBACK_PATTERN.test(command.replace(/\\/g, "/"))) {
                    return {
                      verdict: "ask" as const,
                      reason:
                        "Worker isolation mode (HARNESS_UNIT_WORKER=1) refuses DecisionModel auto-allow for unallowlisted harness or credential-referencing commands; requires human confirmation.",
                    }
                  }
                }
                return {
                  verdict: "allow" as const,
                  reason: "Command deemed safe by decision model.",
                }
              }

              return {
                verdict: "ask" as const,
                reason: "Ambiguous risk; requires human confirmation.",
              }
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
