import { Cause, Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  DEFAULT_DECISION_MODEL_TIMEOUT_MS,
  WORKFLOW_TIMEOUT_BUDGETS,
  isPureInterruptCause,
} from "@harness/contract"
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

export type GuardFastPathVerdict = "allow" | "deny" | "ask" | "escalate"

export type GuardModelOutcome =
  | { readonly _tag: "NotEvaluated" }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "ModelError"; readonly detail: string }
  | {
      readonly _tag: "Scored"
      readonly destructive: number
      readonly secretAccess: number
      readonly exfiltration: number
    }

export interface GuardDecisionInput {
  readonly command: string
  readonly fastPath: GuardFastPathVerdict
  readonly unitWorkerMode?: boolean | undefined
  readonly modelOutcome: GuardModelOutcome
}

export const GUARD_DECISION_TIMEOUT_MS: typeof DEFAULT_DECISION_MODEL_TIMEOUT_MS =
  WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs

const WORKER_SENSITIVE_FALLBACK_PATTERN =
  /\bharness(?:-cli)?\b|auth-tokens|daemon\.soc|\.harness\/omnigraph-cluster/i

/**
 * Pure domain decider (`R = never`) mapping deterministic fast-path verdicts and
 * optional `GuardV1` `DecisionModel` scores into a fail-closed `GuardDecisionResult`
 * using the unified `GUARD_DECISION_TIMEOUT_MS` (`5000 ms`) budget (`SPEC-0037 REQ-2.4`).
 */
export const decideGuardVerdict = Effect.fn("GuardDecision.decide")(function* (
  input: GuardDecisionInput,
): Effect.fn.Return<GuardDecisionResult, never, never> {
  const policyOptions =
    input.unitWorkerMode === undefined ? undefined : { unitWorkerMode: input.unitWorkerMode }

  return yield* match(input.fastPath)
    .with("deny", () =>
      Effect.succeed({
        verdict: "deny" as const,
        reason:
          explainCommandDenyReason(input.command, policyOptions) ??
          "Matched deterministic denylist.",
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
      match(input.modelOutcome)
        .with({ _tag: "NotEvaluated" }, () =>
          Effect.succeed({
            verdict: "ask" as const,
            reason: "DecisionModel was not evaluated; requires human confirmation.",
          }),
        )
        .with({ _tag: "TimedOut" }, () =>
          Effect.logWarning(
            `GuardV1 DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requiring human confirmation.`,
          ).pipe(
            Effect.as({
              verdict: "ask" as const,
              reason: `DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requires human confirmation.`,
            }),
          ),
        )
        .with({ _tag: "ModelError" }, ({ detail }) =>
          Effect.succeed({
            verdict: "ask" as const,
            reason: `DecisionModel unavailable (${detail}); requires human confirmation.`,
          }),
        )
        .with({ _tag: "Scored" }, ({ destructive, secretAccess, exfiltration }) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "decision.definition": "GuardV1",
              "decision.destructive": destructive,
              "decision.secretAccess": secretAccess,
              "decision.exfiltration": exfiltration,
            })

            if (destructive >= 0.7 || secretAccess >= 0.7 || exfiltration >= 0.7) {
              return {
                verdict: "deny" as const,
                reason: `High risk command detected (destructive=${destructive}, secretAccess=${secretAccess}, exfiltration=${exfiltration}).`,
              }
            }

            if (destructive < 0.3 && secretAccess < 0.3 && exfiltration < 0.3) {
              if (input.unitWorkerMode === true) {
                const workerDenyReason = explainCommandDenyReason(input.command, {
                  unitWorkerMode: true,
                })
                if (workerDenyReason !== undefined) {
                  return {
                    verdict: "deny" as const,
                    reason: workerDenyReason,
                  }
                }
                if (WORKER_SENSITIVE_FALLBACK_PATTERN.test(input.command.replace(/\\/g, "/"))) {
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
        .exhaustive(),
    )
    .exhaustive()
})

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

  const modelOutcome: GuardModelOutcome = yield* match(fastPath)
    .with("deny", "allow", "ask", () =>
      Effect.succeed({ _tag: "NotEvaluated" as const } satisfies GuardModelOutcome),
    )
    .with("escalate", () =>
      DecisionModel.decide(GuardV1, { input: { command } }).pipe(
        Effect.map(({ answers }): GuardModelOutcome => ({
          _tag: "Scored",
          destructive: answers.destructive.probability,
          secretAccess: answers.secretAccess.probability,
          exfiltration: answers.exfiltration.probability,
        })),
        Effect.catchCauseIf(
          (cause) => !isPureInterruptCause(cause),
          (cause) => {
            const collapsed = Cause.pretty(cause).replace(/\s+/g, " ").trim()
            const truncated = collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed
            const detail = truncated.length > 0 ? truncated : "unknown error"
            return Effect.logWarning(`Decision model fallback: ${Cause.pretty(cause)}`).pipe(
              Effect.as({ _tag: "ModelError", detail } satisfies GuardModelOutcome),
            )
          },
        ),
        Effect.orElseSucceed(
          () => ({ _tag: "ModelError", detail: "unknown error" }) satisfies GuardModelOutcome,
        ),
        Effect.timeoutOption(`${DEFAULT_DECISION_MODEL_TIMEOUT_MS} millis`),
        Effect.map((timed) =>
          match(timed)
            .with(
              { _tag: "None" },
              () => ({ _tag: "TimedOut" as const }) satisfies GuardModelOutcome,
            )
            .with({ _tag: "Some" }, ({ value }) => value)
            .exhaustive(),
        ),
      ),
    )
    .exhaustive()

  return yield* decideGuardVerdict({
    command,
    fastPath,
    unitWorkerMode,
    modelOutcome,
  })
})

/** Traced `GuardDecision.evaluate` wrapper delegating to `Harness.decideGuardCommand` (`SPEC-0037 REQ-2.4`). */
export const decideGuard = Effect.fn("GuardDecision.evaluate")(function* (
  input: string | GuardCommandInput,
  options?: GuardCommandOptions,
) {
  return yield* decideGuardCommand(input, options)
})

export const GuardDecision = {
  decide: decideGuardVerdict,
  evaluate: decideGuard,
} as const
