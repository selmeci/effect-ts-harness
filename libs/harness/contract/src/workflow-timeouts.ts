import { Match, Result, Schema } from "effect"
import { ErrorReasonMessage } from "./workspace-and-process.js"

/** Canonical stage count matching `SHIP_STAGES.length` in `./workflow.js` (kept local to avoid a circular ESM import via `workflow -> review-routing -> workflow-timeouts`). */
const SHIP_STAGE_COUNT = 6

const MAX_SETTLE_TIMEOUT_MS = 2_147_483_647

/** Branded positive 32-bit signed integer duration in milliseconds (`1..2_147_483_647`) safe for Node timers across workflow IPC, verification, and lease timeouts. */
export const WorkflowTimeoutMs = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_SETTLE_TIMEOUT_MS })),
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

/** Branded positive integer count of stages in a multi-stage workflow. */
export const WorkflowStageCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("WorkflowStageCount"),
)
export type WorkflowStageCount = typeof WorkflowStageCount.Type

/** Branded trimmed non-empty label identifying a multi-stage workflow in timeout diagnostics. */
export const WorkflowStageLabel = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("WorkflowStageLabel"),
)
export type WorkflowStageLabel = typeof WorkflowStageLabel.Type

/** Input for `validateMultiStageTimeoutBudget` (`settleMs > stageCount * perStageCommandMs`). */
export const MultiStageTimeoutBudgetInput = Schema.Struct({
  stageCount: WorkflowStageCount,
  perStageCommandMs: WorkflowTimeoutMs,
  settleMs: WorkflowTimeoutMs,
  workflowLabel: WorkflowStageLabel,
})
export type MultiStageTimeoutBudgetInput = typeof MultiStageTimeoutBudgetInput.Type

/** Validates that a multi-stage workflow settle budget strictly exceeds `stageCount * perStageCommandMs`. */
export const validateMultiStageTimeoutBudget = (
  input: MultiStageTimeoutBudgetInput,
): Result.Result<WorkflowTimeoutMs, ErrorReasonMessage> => {
  const minStageBudgetMs = input.stageCount * input.perStageCommandMs
  if (input.settleMs <= minStageBudgetMs) {
    return Result.fail(
      ErrorReasonMessage.make(
        `${input.workflowLabel} settleMs (${input.settleMs}) must exceed stageCount (${input.stageCount}) * perStageCommandMs (${input.perStageCommandMs}) = ${minStageBudgetMs}`,
      ),
    )
  }
  return Result.succeed(input.settleMs)
}

const RawWorkflowTimeoutBudgets = Schema.Struct({
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
  shipGateCommandMs: WorkflowTimeoutMs,
  shipWorkflowSettleMs: WorkflowTimeoutMs,
  shipWorkflowIpcMs: WorkflowTimeoutMs,
  shipServerSocketMs: WorkflowTimeoutMs,
  httpRequestTimeoutMs: WorkflowTimeoutMs,
  claimTimeoutMs: WorkflowTimeoutMs,
  writerLeaseHeartbeatTtlMs: WorkflowTimeoutMs,
  agentRunClaudeMs: WorkflowTimeoutMs,
  agentRunAntigravityMs: WorkflowTimeoutMs,
  agentKillGraceMs: WorkflowTimeoutMs,
  agentStartupRetryMaxAttempts: WorkflowPollAttempts,
  agentStartupRetryBackoffMs: WorkflowTimeoutMs,
  decisionModelTimeoutMs: WorkflowTimeoutMs,
  lspDiagnosticsWatchdogMs: WorkflowTimeoutMs,
  ollamaWarmupProbeMs: WorkflowTimeoutMs,
})
type RawWorkflowTimeoutBudgets = typeof RawWorkflowTimeoutBudgets.Type

const SHIP_GATE_COMMAND_MS = WorkflowTimeoutMs.make(300_000)
const SHIP_SETTLE_OVERHEAD_MS = 60_000
const SHIP_IPC_OVERHEAD_MS = 30_000
const SHIP_SOCKET_OVERHEAD_MS = 30_000
const SHIP_WORKFLOW_SETTLE_MS = WorkflowTimeoutMs.make(
  SHIP_STAGE_COUNT * SHIP_GATE_COMMAND_MS + SHIP_SETTLE_OVERHEAD_MS,
)
const SHIP_WORKFLOW_IPC_MS = WorkflowTimeoutMs.make(SHIP_WORKFLOW_SETTLE_MS + SHIP_IPC_OVERHEAD_MS)
const SHIP_SERVER_SOCKET_MS = WorkflowTimeoutMs.make(SHIP_WORKFLOW_IPC_MS + SHIP_SOCKET_OVERHEAD_MS)

const RAW_WORKFLOW_TIMEOUT_BUDGETS: RawWorkflowTimeoutBudgets = {
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
  shipGateCommandMs: SHIP_GATE_COMMAND_MS,
  shipWorkflowSettleMs: SHIP_WORKFLOW_SETTLE_MS,
  shipWorkflowIpcMs: SHIP_WORKFLOW_IPC_MS,
  shipServerSocketMs: SHIP_SERVER_SOCKET_MS,
  httpRequestTimeoutMs: WorkflowTimeoutMs.make(15_000),
  claimTimeoutMs: WorkflowTimeoutMs.make(6 * 60 * 60 * 1_000),
  writerLeaseHeartbeatTtlMs: WorkflowTimeoutMs.make(45_000),
  agentRunClaudeMs: WorkflowTimeoutMs.make(600_000),
  agentRunAntigravityMs: WorkflowTimeoutMs.make(600_000),
  agentKillGraceMs: WorkflowTimeoutMs.make(5_000),
  agentStartupRetryMaxAttempts: WorkflowPollAttempts.make(3),
  agentStartupRetryBackoffMs: WorkflowTimeoutMs.make(1_000),
  decisionModelTimeoutMs: WorkflowTimeoutMs.make(5_000),
  lspDiagnosticsWatchdogMs: WorkflowTimeoutMs.make(45_000),
  ollamaWarmupProbeMs: WorkflowTimeoutMs.make(10_000),
}

const findWorkflowTimeoutBudgetViolation = (
  budgets: RawWorkflowTimeoutBudgets,
): string | undefined => {
  const pollSettleBudgetMs = budgets.pollSettleMaxAttempts * budgets.pollSettleIntervalMs
  const abortSettleBudgetMs = budgets.abortSettleMaxAttempts * budgets.abortSettleIntervalMs

  if (budgets.workflowServerSocketMs <= budgets.workflowCompleteIpcMs) {
    return `workflowServerSocketMs (${budgets.workflowServerSocketMs}) must exceed workflowCompleteIpcMs (${budgets.workflowCompleteIpcMs})`
  }
  if (budgets.workflowCompleteIpcMs <= budgets.unitVerifyMs + pollSettleBudgetMs) {
    return `workflowCompleteIpcMs (${budgets.workflowCompleteIpcMs}) must exceed unitVerifyMs + pollSettleBudgetMs (${budgets.unitVerifyMs + pollSettleBudgetMs})`
  }
  if (budgets.defaultServerSocketMs <= budgets.workflowIpcMs) {
    return `defaultServerSocketMs (${budgets.defaultServerSocketMs}) must exceed workflowIpcMs (${budgets.workflowIpcMs})`
  }
  if (budgets.workflowIpcMs <= abortSettleBudgetMs) {
    return `workflowIpcMs (${budgets.workflowIpcMs}) must exceed abortSettleBudgetMs (${abortSettleBudgetMs})`
  }
  if (budgets.shipServerSocketMs <= budgets.shipWorkflowIpcMs) {
    return `shipServerSocketMs (${budgets.shipServerSocketMs}) must exceed shipWorkflowIpcMs (${budgets.shipWorkflowIpcMs})`
  }
  if (budgets.shipWorkflowIpcMs <= budgets.shipWorkflowSettleMs) {
    return `shipWorkflowIpcMs (${budgets.shipWorkflowIpcMs}) must exceed shipWorkflowSettleMs (${budgets.shipWorkflowSettleMs})`
  }
  const shipStageBudget = validateMultiStageTimeoutBudget(
    MultiStageTimeoutBudgetInput.make({
      stageCount: WorkflowStageCount.make(SHIP_STAGE_COUNT),
      perStageCommandMs: budgets.shipGateCommandMs,
      settleMs: budgets.shipWorkflowSettleMs,
      workflowLabel: WorkflowStageLabel.make("ShipWorkflow"),
    }),
  )
  const shipStageError = Match.value(shipStageBudget).pipe(
    Match.tag("Failure", ({ failure }) => failure),
    Match.tag("Success", () => undefined),
    Match.exhaustive,
  )
  if (shipStageError !== undefined) {
    return shipStageError
  }
  if (budgets.shipGateCommandMs <= budgets.workflowServerSocketMs) {
    return `shipGateCommandMs (${budgets.shipGateCommandMs}) must exceed workflowServerSocketMs (${budgets.workflowServerSocketMs})`
  }
  if (budgets.agentRunClaudeMs <= budgets.agentKillGraceMs) {
    return `agentRunClaudeMs (${budgets.agentRunClaudeMs}) must exceed agentKillGraceMs (${budgets.agentKillGraceMs})`
  }
  if (budgets.agentRunAntigravityMs <= budgets.agentKillGraceMs) {
    return `agentRunAntigravityMs (${budgets.agentRunAntigravityMs}) must exceed agentKillGraceMs (${budgets.agentKillGraceMs})`
  }
  const startupRetryBudgetMs =
    budgets.agentStartupRetryMaxAttempts * budgets.agentStartupRetryBackoffMs
  if (budgets.agentRunAntigravityMs <= startupRetryBudgetMs) {
    return `agentRunAntigravityMs (${budgets.agentRunAntigravityMs}) must exceed agentStartupRetryMaxAttempts * agentStartupRetryBackoffMs (${startupRetryBudgetMs})`
  }
  if (budgets.claimTimeoutMs <= budgets.agentRunClaudeMs + budgets.agentKillGraceMs) {
    return `claimTimeoutMs (${budgets.claimTimeoutMs}) must exceed agentRunClaudeMs + agentKillGraceMs (${budgets.agentRunClaudeMs + budgets.agentKillGraceMs})`
  }
  const maxAntigravityCycleMs =
    budgets.agentStartupRetryMaxAttempts *
      (budgets.agentRunAntigravityMs + budgets.agentKillGraceMs) +
    Math.max(0, budgets.agentStartupRetryMaxAttempts - 1) * budgets.agentStartupRetryBackoffMs
  if (budgets.claimTimeoutMs <= maxAntigravityCycleMs) {
    return `claimTimeoutMs (${budgets.claimTimeoutMs}) must exceed worst-case antigravity retry budget (${maxAntigravityCycleMs})`
  }
  if (budgets.ollamaWarmupProbeMs < budgets.decisionModelTimeoutMs) {
    return `ollamaWarmupProbeMs (${budgets.ollamaWarmupProbeMs}) must be >= decisionModelTimeoutMs (${budgets.decisionModelTimeoutMs})`
  }
  if (budgets.lspDiagnosticsWatchdogMs <= budgets.decisionModelTimeoutMs) {
    return `lspDiagnosticsWatchdogMs (${budgets.lspDiagnosticsWatchdogMs}) must exceed decisionModelTimeoutMs (${budgets.decisionModelTimeoutMs})`
  }
  if (budgets.workflowIpcMs <= budgets.decisionModelTimeoutMs) {
    return `workflowIpcMs (${budgets.workflowIpcMs}) must exceed decisionModelTimeoutMs (${budgets.decisionModelTimeoutMs})`
  }
  return undefined
}

/**
 * Canonical hierarchy of workflow daemon, socket, verifier, store HTTP, settle, lease, and
 * agent runner execution/kill-grace/startup-retry timeouts, with monotonicity validated at decode (`SPEC-0027 REQ-2.2`, `SPEC-0036 REQ-1.1`).
 */
export const WorkflowTimeoutBudgets = RawWorkflowTimeoutBudgets.pipe(
  Schema.check(
    Schema.makeFilter((budgets) => findWorkflowTimeoutBudgetViolation(budgets), {
      message: "WorkflowTimeoutBudgets violates strict monotonicity invariants",
    }),
  ),
)
export type WorkflowTimeoutBudgets = typeof WorkflowTimeoutBudgets.Type

/** Validates strict monotonicity invariants across nested workflow timeout and settle-loop layers (`SPEC-0027 REQ-2.2`). */
export const validateWorkflowTimeoutBudgets = (
  budgets: WorkflowTimeoutBudgets,
): Result.Result<WorkflowTimeoutBudgets, ErrorReasonMessage> =>
  Match.value(findWorkflowTimeoutBudgetViolation(budgets)).pipe(
    Match.when(undefined, () => Result.succeed(budgets)),
    Match.orElse((violation) => Result.fail(ErrorReasonMessage.make(violation))),
  )

/** Single-source canonical timeout budgets consumed across daemon, verifier, store, runner, and MCP RPC layers, validated at module initialization (`SPEC-0027 REQ-2.2`). */
export const WORKFLOW_TIMEOUT_BUDGETS: WorkflowTimeoutBudgets = Result.getOrThrowWith(
  validateWorkflowTimeoutBudgets(RAW_WORKFLOW_TIMEOUT_BUDGETS),
  (reason) => new Error(`Invalid WORKFLOW_TIMEOUT_BUDGETS: ${reason}`),
)

/** Unified `5000 ms` DecisionModel timeout budget shared across guard, triage, and review routing (`SPEC-0037 REQ-2.4`). */
export const DEFAULT_DECISION_MODEL_TIMEOUT_MS: WorkflowTimeoutMs =
  WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs

/** Default `45000 ms` watchdog timeout for `LspDiagnostics.run` subprocess supervision (`SPEC-0037 REQ-1.1`). */
export const DEFAULT_LSP_WATCHDOG_TIMEOUT_MS: WorkflowTimeoutMs =
  WORKFLOW_TIMEOUT_BUDGETS.lspDiagnosticsWatchdogMs
