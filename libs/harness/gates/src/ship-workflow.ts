import { Cause, Effect, Exit } from "effect"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  GateDurationMs,
  MutationRestoreError,
  SHIP_STAGES,
  ShipReceipt,
  type ShipRecoverBackupInput,
  ShipStage,
  type ShipStageCommandInput,
  ShipStageFailed,
  ShipStagePassed,
  ShipStreamProgressEvent,
  ShipTreeDriftError,
  type ShipTreeHashInput,
  ShipTreeMismatchError,
  ShipWorkflowError,
  ShipWorkflowPayload,
  WorkflowActivityTag,
  WorkflowExecutionId,
  encodeWorkflowActivityName,
  toShipFailureMessage,
} from "@harness/contract"
import { ShipGateRunner } from "@harness/service"

/** Durable verification & shipping workflow keyed by `${runId}:${treeHash}:${attempt}`. */
export const ShipWorkflow = Workflow.make("ShipWorkflow", {
  payload: ShipWorkflowPayload,
  success: ShipReceipt,
  error: ShipWorkflowError,
  idempotencyKey: ({ runId, treeHash, attempt }) => `${runId}:${treeHash}:${attempt}`,
})

/** Computes the deterministic `WorkflowExecutionId` for a `ShipWorkflowPayload`. */
export const shipExecutionIdOf = Effect.fn("ShipWorkflow.executionIdOf")(function* (
  payload: ShipWorkflowPayload,
): Effect.fn.Return<WorkflowExecutionId> {
  const raw = yield* ShipWorkflow.executionId(payload)
  return WorkflowExecutionId.make(raw)
})

const toTreeHashInput = (payload: ShipWorkflowPayload, stage: ShipStage): ShipTreeHashInput => ({
  runId: payload.runId,
  attempt: payload.attempt,
  stage,
  ...(payload.repoRoot !== undefined ? { repoRoot: payload.repoRoot } : {}),
})

const toRecoverBackupInput = (payload: ShipWorkflowPayload): ShipRecoverBackupInput => ({
  runId: payload.runId,
  attempt: payload.attempt,
  expectedTreeHash: payload.treeHash,
  ...(payload.repoRoot !== undefined ? { repoRoot: payload.repoRoot } : {}),
})

const toStageCommandInput = (
  payload: ShipWorkflowPayload,
  stage: ShipStage,
): ShipStageCommandInput => ({
  runId: payload.runId,
  attempt: payload.attempt,
  stage,
  treeHash: payload.treeHash,
  ...(payload.repoRoot !== undefined ? { repoRoot: payload.repoRoot } : {}),
})

/**
 * Executes a single `ShipStage` asserting identical workspace tree hashes before every gate,
 * before/after `mutate-strict` backup recovery, and after `done --cli`.
 */
export const runGateAssertingTree = Effect.fn("ShipWorkflow.runGate")(function* (
  payload: ShipWorkflowPayload,
  stage: ShipStage,
): Effect.fn.Return<ShipStagePassed, ShipWorkflowError, ShipGateRunner> {
  const runner = yield* ShipGateRunner
  const treeHashInput = toTreeHashInput(payload, stage)
  let stageDurationMs = GateDurationMs.make(0)

  yield* runner.reportStageProgress(
    ShipStreamProgressEvent.cases.StageStarted.make({
      runId: payload.runId,
      attempt: payload.attempt,
      stage,
    }),
  )

  return yield* Effect.gen(function* () {
    const preHash = yield* runner.computeTreeHash(treeHashInput)
    if (preHash !== payload.treeHash) {
      return yield* new ShipTreeMismatchError({
        stage,
        expected: payload.treeHash,
        actual: preHash,
      })
    }

    yield* match(stage)
      .with("mutate-strict", () => runner.recoverMutationBackup(toRecoverBackupInput(payload)))
      .with(
        "format-check",
        "gc-strict",
        "ontology-check-strict",
        "verify",
        "done",
        () => Effect.void,
      )
      .exhaustive()

    const stageResult = yield* match(stage)
      .with("mutate-strict", () =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const cmdExit = yield* Effect.exit(
              restore(runner.executeStageCommand(toStageCommandInput(payload, stage))),
            )
            return yield* Exit.match(cmdExit, {
              onSuccess: (passed) => Effect.succeed(passed),
              onFailure: (cmdCause) =>
                Effect.gen(function* () {
                  yield* runner.recoverMutationBackup(toRecoverBackupInput(payload))
                  const postHashExit = yield* Effect.exit(runner.computeTreeHash(treeHashInput))
                  return yield* Exit.match(postHashExit, {
                    onSuccess: (postHash) =>
                      postHash !== payload.treeHash
                        ? Effect.fail(
                            new MutationRestoreError({
                              expected: payload.treeHash,
                              actual: postHash,
                            }),
                          )
                        : Effect.failCause(cmdCause),
                    onFailure: (hashCause) =>
                      match(Cause.findErrorOption(hashCause))
                        .with({ _tag: "Some" }, ({ value: gateErr }) =>
                          Effect.fail(
                            new MutationRestoreError({
                              expected: payload.treeHash,
                              detail: toShipFailureMessage(gateErr),
                            }),
                          ),
                        )
                        .with({ _tag: "None" }, () => Effect.failCause(hashCause))
                        .exhaustive(),
                  })
                }),
            })
          }),
        ),
      )
      .with("format-check", "gc-strict", "ontology-check-strict", "verify", "done", () =>
        runner.executeStageCommand(toStageCommandInput(payload, stage)),
      )
      .exhaustive()

    stageDurationMs = stageResult.durationMs

    yield* match(stage)
      .with("mutate-strict", () =>
        Effect.gen(function* () {
          const postHash = yield* runner.computeTreeHash(treeHashInput)
          if (postHash !== payload.treeHash) {
            return yield* new MutationRestoreError({
              expected: payload.treeHash,
              actual: postHash,
            })
          }
        }),
      )
      .with("done", () =>
        Effect.gen(function* () {
          const postHash = yield* runner.computeTreeHash(treeHashInput)
          if (postHash !== payload.treeHash) {
            return yield* new ShipTreeDriftError({
              stage,
              expected: payload.treeHash,
              actual: postHash,
            })
          }
        }),
      )
      .with("format-check", "gc-strict", "ontology-check-strict", "verify", () => Effect.void)
      .exhaustive()

    return stageResult
  }).pipe(
    Effect.tap((stageResult) =>
      runner.reportStageProgress(
        ShipStreamProgressEvent.cases.StageFinished.make({
          runId: payload.runId,
          attempt: payload.attempt,
          progress: stageResult,
        }),
      ),
    ),
    Effect.tapError((err) =>
      runner.reportStageProgress(
        ShipStreamProgressEvent.cases.StageFinished.make({
          runId: payload.runId,
          attempt: payload.attempt,
          progress: ShipStageFailed.make({
            stage,
            durationMs: match(err)
              .with({ _tag: "ShipGateFailedError" }, (e) => e.durationMs ?? stageDurationMs)
              .with(
                { _tag: "ShipTreeMismatchError" },
                { _tag: "MutationRestoreError" },
                { _tag: "ShipTreeDriftError" },
                () => stageDurationMs,
              )
              .exhaustive(),
            errorTag: err._tag,
            detail: toShipFailureMessage(err),
          }),
        }),
      ),
    ),
  )
})

/** Orchestrates `SHIP_STAGES` strictly in canonical order inside deterministic `Activity.make` steps. */
export const executeShipWorkflow = Effect.fn("ShipWorkflow.execute")(function* (
  payload: ShipWorkflowPayload,
): Effect.fn.Return<
  ShipReceipt,
  ShipWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Workflow.Execution<"ShipWorkflow">
  | ShipGateRunner
> {
  for (const stage of SHIP_STAGES) {
    yield* Activity.make({
      name: encodeWorkflowActivityName(WorkflowActivityTag.cases.RunGate.make({ stage })),
      success: ShipStagePassed,
      error: ShipWorkflowError,
      execute: runGateAssertingTree(payload, stage),
    })
  }

  return ShipReceipt.make({
    runId: payload.runId,
    attempt: payload.attempt,
    verifiedTreeHash: payload.treeHash,
    ...(payload.planSha !== undefined ? { planSha: payload.planSha } : {}),
  })
})

/** Workflow registration layer binding `ShipWorkflow` to `executeShipWorkflow`. */
export const ShipWorkflowLayer = ShipWorkflow.toLayer((payload) => executeShipWorkflow(payload))
