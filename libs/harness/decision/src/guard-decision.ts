import { Cause, Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  DEFAULT_DECISION_MODEL_TIMEOUT_MS,
  GuardDecisionInput,
  GuardDecisionResult,
  GuardFastPathVerdict,
  GuardModelErrorDetail,
  GuardModelOutcome,
  GuardReasonText,
  GuardRiskProbability,
  ShellCommandText,
  WORKFLOW_TIMEOUT_BUDGETS,
  isPureInterruptCause,
} from "@harness/contract"
import { match } from "ts-pattern"
import { classifyCommand, explainCommandDenyReason } from "@harness/gates/hook-fastpath"

export {
  GuardDecisionInput,
  GuardDecisionResult,
  GuardFastPathVerdict,
  GuardModelErrorDetail,
  GuardModelOutcome,
  GuardReasonText,
  GuardRiskProbability,
  ShellCommandText,
}

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

export const GUARD_DECISION_TIMEOUT_MS: typeof DEFAULT_DECISION_MODEL_TIMEOUT_MS =
  WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs

const WORKER_SENSITIVE_FALLBACK_PATTERN =
  /\bharness(?:-cli)?\b|auth-tokens|daemon\.soc|\.harness\/omnigraph-cluster/i

const MAX_SHELL_COMMAND_LENGTH = 32_768
const MAX_GUARD_REASON_LENGTH = 1_024
const MAX_MODEL_ERROR_DETAIL_LENGTH = 256

const toGuardReasonText = (raw: string, fallback: string): GuardReasonText => {
  const trimmed = raw.trim()
  const normalized = trimmed.length > 0 ? trimmed : fallback
  const bounded =
    normalized.length > MAX_GUARD_REASON_LENGTH
      ? `${normalized.slice(0, MAX_GUARD_REASON_LENGTH - 3)}...`
      : normalized
  return GuardReasonText.make(bounded)
}

const toGuardModelErrorDetail = (raw: string): GuardModelErrorDetail => {
  const collapsed = raw.replace(/\s+/g, " ").trim()
  const normalized = collapsed.length > 0 ? collapsed : "unknown error"
  const bounded =
    normalized.length > MAX_MODEL_ERROR_DETAIL_LENGTH
      ? `${normalized.slice(0, MAX_MODEL_ERROR_DETAIL_LENGTH - 3)}...`
      : normalized
  return GuardModelErrorDetail.make(bounded)
}

const toGuardRiskProbability = (value: number): GuardRiskProbability =>
  GuardRiskProbability.make(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1)

/**
 * Effect-based (`R = never`) domain decider (logs structured warning on `TimedOut`)
 * mapping deterministic fast-path verdicts and optional `GuardV1` `DecisionModel` scores
 * into a fail-closed `GuardDecisionResult` using the unified `GUARD_DECISION_TIMEOUT_MS`
 * (`5000 ms`) budget (`SPEC-0037 REQ-2.4`).
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
        reason: toGuardReasonText(
          explainCommandDenyReason(input.command, policyOptions) ??
            "Matched deterministic denylist.",
          "Matched deterministic denylist.",
        ),
      }),
    )
    .with("allow", () =>
      Effect.succeed({
        verdict: "allow" as const,
        reason: GuardReasonText.make("Matched deterministic allowlist."),
      }),
    )
    .with("ask", () =>
      Effect.succeed({
        verdict: "ask" as const,
        reason: GuardReasonText.make("Matched deterministic asklist; requires human confirmation."),
      }),
    )
    .with("escalate", () =>
      match(input.modelOutcome)
        .with({ _tag: "NotEvaluated" }, () =>
          Effect.succeed({
            verdict: "ask" as const,
            reason: GuardReasonText.make(
              "DecisionModel was not evaluated; requires human confirmation.",
            ),
          }),
        )
        .with({ _tag: "TimedOut" }, () =>
          Effect.logWarning(
            `GuardV1 DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requiring human confirmation.`,
          ).pipe(
            Effect.as({
              verdict: "ask" as const,
              reason: GuardReasonText.make(
                `DecisionModel timed out after ${GUARD_DECISION_TIMEOUT_MS}ms; requires human confirmation.`,
              ),
            }),
          ),
        )
        .with({ _tag: "ModelError" }, ({ detail }) =>
          Effect.succeed({
            verdict: "ask" as const,
            reason: toGuardReasonText(
              `DecisionModel unavailable (${detail}); requires human confirmation.`,
              "DecisionModel unavailable; requires human confirmation.",
            ),
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
                reason: toGuardReasonText(
                  `High risk command detected (destructive=${destructive}, secretAccess=${secretAccess}, exfiltration=${exfiltration}).`,
                  "High risk command detected.",
                ),
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
                    reason: toGuardReasonText(workerDenyReason, "Matched worker denylist."),
                  }
                }
                if (WORKER_SENSITIVE_FALLBACK_PATTERN.test(input.command.replace(/\\/g, "/"))) {
                  return {
                    verdict: "ask" as const,
                    reason: GuardReasonText.make(
                      "Worker isolation mode (HARNESS_UNIT_WORKER=1) refuses DecisionModel auto-allow for unallowlisted harness or credential-referencing commands; requires human confirmation.",
                    ),
                  }
                }
              }
              return {
                verdict: "allow" as const,
                reason: GuardReasonText.make("Command deemed safe by decision model."),
              }
            }

            return {
              verdict: "ask" as const,
              reason: GuardReasonText.make("Ambiguous risk; requires human confirmation."),
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
): Effect.fn.Return<GuardDecisionResult, never, DecisionModel.DecisionModel> {
  const command = typeof input === "string" ? input : input.command
  const unitWorkerMode =
    typeof input === "string"
      ? options?.unitWorkerMode
      : (input.unitWorkerMode ?? options?.unitWorkerMode)
  const policyOptions = unitWorkerMode === undefined ? undefined : { unitWorkerMode }
  const fastPath = GuardFastPathVerdict.make(classifyCommand(command, policyOptions))

  const modelOutcome: GuardModelOutcome = yield* match(fastPath)
    .with("deny", "allow", "ask", () =>
      Effect.succeed({ _tag: "NotEvaluated" as const } satisfies GuardModelOutcome),
    )
    .with("escalate", () =>
      DecisionModel.decide(GuardV1, { input: { command } }).pipe(
        Effect.map(({ answers }): GuardModelOutcome => ({
          _tag: "Scored",
          destructive: toGuardRiskProbability(answers.destructive.probability),
          secretAccess: toGuardRiskProbability(answers.secretAccess.probability),
          exfiltration: toGuardRiskProbability(answers.exfiltration.probability),
        })),
        Effect.catchCauseIf(
          (cause) => !isPureInterruptCause(cause),
          (cause) => {
            const detail = toGuardModelErrorDetail(Cause.pretty(cause))
            return Effect.logWarning(`Decision model fallback: ${Cause.pretty(cause)}`).pipe(
              Effect.as({ _tag: "ModelError", detail } satisfies GuardModelOutcome),
            )
          },
        ),
        Effect.orElseSucceed(
          () =>
            ({
              _tag: "ModelError",
              detail: GuardModelErrorDetail.make("unknown error"),
            }) satisfies GuardModelOutcome,
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
    command: ShellCommandText.make(command.slice(0, MAX_SHELL_COMMAND_LENGTH)),
    fastPath,
    unitWorkerMode,
    modelOutcome,
  })
})

/** Traced `GuardDecision.evaluate` wrapper delegating to `Harness.decideGuardCommand` (`SPEC-0037 REQ-2.4`). */
export const decideGuard = Effect.fn("GuardDecision.evaluate")(function* (
  input: string | GuardCommandInput,
  options?: GuardCommandOptions,
): Effect.fn.Return<GuardDecisionResult, never, DecisionModel.DecisionModel> {
  return yield* decideGuardCommand(input, options)
})

export const GuardDecision = {
  decide: decideGuardVerdict,
  evaluate: decideGuard,
} as const
