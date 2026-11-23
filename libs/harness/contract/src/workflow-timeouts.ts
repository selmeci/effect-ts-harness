import { Result, Schema } from "effect"
import { ErrorReasonMessage } from "./workspace-and-process.js"

/** Branded positive integer duration in milliseconds used across workflow IPC, verification, and lease timeouts. */
export const WorkflowTimeoutMs = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("WorkflowTimeoutMs"),
)
export type WorkflowTimeoutMs = typeof WorkflowTimeoutMs.Type

/** Branded positive integer retry/poll attempt bound for workflow RPC settle loops. */
export const WorkflowPollAttempts = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("WorkflowPollAttempts"),
)
export type WorkflowPollAttempts = typeof WorkflowPollAttempts.Type

/** Paired RPC polling budget (`maxAttempts * intervalMs` bounded settle window). */
export const WorkflowPollBudget = Schema.Struct({
  maxAttempts: WorkflowPollAttempts,
  intervalMs: WorkflowTimeoutMs,
})
export type WorkflowPollBudget = typeof WorkflowPollBudget.Type

/** Canonical hierarchy of workflow daemon, socket, verifier, store HTTP, settle, and lease timeouts. */
export const WorkflowTimeoutBudgets = Schema.Struct({
  defaultSocketMs: WorkflowTimeoutMs,
  defaultServerSocketMs: WorkflowTimeoutMs,
  workflowIpcMs: WorkflowTimeoutMs,
  unitVerifyMs: WorkflowTimeoutMs,
  pollSettleMaxAttempts: WorkflowPollAttempts,
  pollSettleIntervalMs: WorkflowTimeoutMs,
  abortSettleMaxAttempts: WorkflowPollAttempts,
  abortSettleIntervalMs: WorkflowTimeoutMs,
  workflowCompleteIpcMs: WorkflowTimeoutMs,
  workflowServerSocketMs: WorkflowTimeoutMs,
  httpRequestTimeoutMs: WorkflowTimeoutMs,
  claimTimeoutMs: WorkflowTimeoutMs,
  writerLeaseHeartbeatTtlMs: WorkflowTimeoutMs,
})
export type WorkflowTimeoutBudgets = typeof WorkflowTimeoutBudgets.Type

const RAW_WORKFLOW_TIMEOUT_BUDGETS: WorkflowTimeoutBudgets = {
  defaultSocketMs: WorkflowTimeoutMs.make(5_000),
  defaultServerSocketMs: WorkflowTimeoutMs.make(35_000),
  workflowIpcMs: WorkflowTimeoutMs.make(30_000),
  unitVerifyMs: WorkflowTimeoutMs.make(120_000),
  pollSettleMaxAttempts: WorkflowPollAttempts.make(80),
  pollSettleIntervalMs: WorkflowTimeoutMs.make(25),
  abortSettleMaxAttempts: WorkflowPollAttempts.make(200),
  abortSettleIntervalMs: WorkflowTimeoutMs.make(50),
  workflowCompleteIpcMs: WorkflowTimeoutMs.make(150_000),
  workflowServerSocketMs: WorkflowTimeoutMs.make(160_000),
  httpRequestTimeoutMs: WorkflowTimeoutMs.make(15_000),
  claimTimeoutMs: WorkflowTimeoutMs.make(6 * 60 * 60 * 1_000),
  writerLeaseHeartbeatTtlMs: WorkflowTimeoutMs.make(45_000),
}

/** Validates strict monotonicity invariants across nested workflow timeout and settle-loop layers (`SPEC-0027 REQ-2.2`). */
export const validateWorkflowTimeoutBudgets = (
  budgets: WorkflowTimeoutBudgets,
): Result.Result<WorkflowTimeoutBudgets, ErrorReasonMessage> => {
  const pollSettleBudgetMs = budgets.pollSettleMaxAttempts * budgets.pollSettleIntervalMs
  const abortSettleBudgetMs = budgets.abortSettleMaxAttempts * budgets.abortSettleIntervalMs

  if (budgets.workflowServerSocketMs <= budgets.workflowCompleteIpcMs) {
    return Result.fail(
      ErrorReasonMessage.make(
        `workflowServerSocketMs (${budgets.workflowServerSocketMs}) must exceed workflowCompleteIpcMs (${budgets.workflowCompleteIpcMs})`,
      ),
    )
  }
  if (budgets.workflowCompleteIpcMs <= budgets.unitVerifyMs + pollSettleBudgetMs) {
    return Result.fail(
      ErrorReasonMessage.make(
        `workflowCompleteIpcMs (${budgets.workflowCompleteIpcMs}) must exceed unitVerifyMs + pollSettleBudgetMs (${budgets.unitVerifyMs + pollSettleBudgetMs})`,
      ),
    )
  }
  if (budgets.defaultServerSocketMs <= budgets.workflowIpcMs) {
    return Result.fail(
      ErrorReasonMessage.make(
        `defaultServerSocketMs (${budgets.defaultServerSocketMs}) must exceed workflowIpcMs (${budgets.workflowIpcMs})`,
      ),
    )
  }
  if (budgets.workflowIpcMs <= abortSettleBudgetMs) {
    return Result.fail(
      ErrorReasonMessage.make(
        `workflowIpcMs (${budgets.workflowIpcMs}) must exceed abortSettleBudgetMs (${abortSettleBudgetMs})`,
      ),
    )
  }

  return Result.succeed(budgets)
}

/** Single-source canonical timeout budgets consumed across daemon, verifier, store, and MCP RPC layers, validated at module initialization (`SPEC-0027 REQ-2.2`). */
export const WORKFLOW_TIMEOUT_BUDGETS: WorkflowTimeoutBudgets = Result.getOrThrowWith(
  validateWorkflowTimeoutBudgets(RAW_WORKFLOW_TIMEOUT_BUDGETS),
  (reason) => new Error(`Invalid WORKFLOW_TIMEOUT_BUDGETS: ${reason}`),
)
