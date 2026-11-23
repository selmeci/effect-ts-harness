import { Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan,
  CompleteSharedStepInput,
  CompletedWorkflowAttemptRecord,
  DispatchedWorkflowAttemptRecord,
  EarsRequirementKey,
  EscalationDecision,
  EscalationOrdinal,
  FrictionLogState,
  GateExitCode,
  GitCommonDirPath,
  GitCommitSha,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyFailureKind,
  PendingDeferredName,
  PlanJsonPayload,
  PlanSha256,
  RejectedWorkflowAttemptRecord,
  RejectionJsonPayload,
  ReviewDepth,
  ReviewRoutingReason,
  ReviewRoutingSource,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  TaskRunAbortedError,
  UnitEscalation,
  UnitOutcome,
  WORKFLOW_GQ_QUERY_NAMES,
  WaveIndex,
  WorkUnitId,
  WorkflowAttemptKey,
  WorkflowAttemptVerdict,
  WorkflowCompleteRequest,
  WorkflowCompleteResponse,
  WorkflowExecutionId,
  WorkflowGqQueryName,
  WorkflowLevel,
  WorkflowPlanToolOutput,
  WorkflowProjectionStatus,
  WorkflowRebuiltRunCount,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  WorkflowRpcEnvelope,
  WorkflowRpcErrorEnvelope,
  WorkflowRpcRequestId,
  WorkflowRpcSuccessEnvelope,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowRunState,
  WorkflowStartRequest,
  WorkflowStatusSummary,
  WorkflowStoreAvailabilityState,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowTerminalError,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  WorkflowUnitKind,
  WorkflowUnitStatus,
  WorkspaceFsOperation,
  WorkspaceTreeHash,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "../src/index.js"

describe("@harness/contract WF-3 workflow, RPC & storage schemas", () => {
  const makeWf3Fixtures = () => {
    const runId = WorkflowRunId.make("run-wf3-001")
    const execId = WorkflowExecutionId.make("exec-wf3-001")
    const unitId = WorkUnitId.make("unit-wf3-1")
    const planSha = PlanSha256.make("a".repeat(64))
    const baseSha = GitCommitSha.make("0123456789abcdef0123456789abcdef01234567")
    const treeHash = WorkspaceTreeHash.make("b".repeat(64))
    const stampHash = PackageStampHash.make("c".repeat(64))
    const repoRoot = AbsoluteRepoRoot.make("/workspace/repo")
    const commonGitDir = GitCommonDirPath.make("/workspace/repo/.git")
    const expectedUnitKey = makeWorkflowUnitKey(runId, unitId)
    const expectedAttemptKey = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(1))
    const dispatchedAttempt = Schema.decodeSync(DispatchedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "dispatched",
      runner: RunnerId.make("antigravity"),
      updatedMs: WorkflowTimestampMs.make(1_150),
    })
    const completedAttempt = Schema.decodeSync(CompletedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "completed",
      packageStampHash: stampHash,
      updatedMs: WorkflowTimestampMs.make(1_180),
    })
    const rejectedAttempt = Schema.decodeSync(RejectedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "rejected",
      runner: RunnerId.make("antigravity"),
      rejection: { _tag: "StampMissing" },
      packageStampHash: stampHash,
      updatedMs: WorkflowTimestampMs.make(1_200),
    })
    const pendingDeferreds = [
      {
        _tag: "UnitCompletion" as const,
        unitId,
        attempt: AttemptNumber.make(1),
        deferredName: PendingDeferredName.make(`unit/${unitId}/1`),
      },
      {
        _tag: "Escalation" as const,
        unitId,
        deferredName: PendingDeferredName.make(`escalation/${unitId}/1`),
        escalation: { _tag: "AuthRequired" as const, runner: RunnerId.make("claude-code") },
      },
      {
        _tag: "LlmPhase" as const,
        deferredName: PendingDeferredName.make("llm-phase-done"),
      },
    ]
    const skipReview = {
      _tag: "SkipReviewPlan" as const,
      depth: ReviewDepth.make("skip"),
      source: ReviewRoutingSource.make("deterministic"),
      reason: ReviewRoutingReason.make("doc-only"),
      selections: [] as const,
    }
    const runRecord = {
      runId,
      executionId: execId,
      level: WorkflowLevel.make("slice"),
      planSha,
      baseSha,
      state: WorkflowRunState.make("waiting"),
      planJson: PlanJsonPayload.make("{}"),
      updatedMs: WorkflowTimestampMs.make(1_000),
    }
    const unitRecord = {
      unitKey: WorkflowUnitKey.make(expectedUnitKey),
      runId,
      unitId,
      kind: WorkflowUnitKind.make("slice"),
      waveIndex: WaveIndex.make(0),
      status: WorkflowUnitStatus.make("escalated"),
      ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src")],
      updatedMs: WorkflowTimestampMs.make(1_100),
    }
    return {
      runId,
      execId,
      unitId,
      planSha,
      baseSha,
      treeHash,
      stampHash,
      repoRoot,
      commonGitDir,
      expectedUnitKey,
      expectedAttemptKey,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
      pendingDeferreds,
      skipReview,
      runRecord,
      unitRecord,
    }
  }

  it("validates WF-3 IDs, TaskRunAbortedError, 14 GQ query names, and CompleteSharedStepInput", () => {
    const { runId, baseSha, repoRoot } = makeWf3Fixtures()
    expect(SHARED_STEP_UNIT_ID).toBe("shared-step")
    expect(Schema.decodeSync(WorkUnitId)(SHARED_STEP_UNIT_ID)).toBe("shared-step")

    expect(Schema.decodeSync(WorkflowExecutionId)("exec-wf3-01")).toBe("exec-wf3-01")
    for (const badExecId of ["", "   ", " untrimmed ", "x".repeat(257)]) {
      expect(() => Schema.decodeSync(WorkflowExecutionId)(badExecId)).toThrow()
    }

    expect(Schema.decodeSync(EscalationOrdinal)(1)).toBe(1)
    expect(Schema.decodeSync(EscalationOrdinal)(3)).toBe(3)
    for (const badOrdinal of [0, -1, 1.5, Number.NaN, "1", null]) {
      expect(() => Schema.decodeUnknownSync(EscalationOrdinal)(badOrdinal)).toThrow()
    }

    expect(Schema.decodeSync(WorkflowRebuiltRunCount)(0)).toBe(0)
    expect(Schema.decodeSync(WorkflowRebuiltRunCount)(4)).toBe(4)
    for (const badRebuiltCount of [-1, 1.5, Number.NaN, "2", null]) {
      expect(() => Schema.decodeUnknownSync(WorkflowRebuiltRunCount)(badRebuiltCount)).toThrow()
    }

    const authAbort = new TaskRunAbortedError({
      runId,
      escalation: { _tag: "AuthRequired", runner: RunnerId.make("claude-code") },
    })
    expect(authAbort._tag).toBe("TaskRunAbortedError")
    expect(authAbort.message).toContain("claude-code")

    const retryAbort = new TaskRunAbortedError({
      runId,
      escalation: {
        _tag: "RetryBudgetExhausted",
        lastRejection: {
          _tag: "PackageVerifyFailed",
          exitCode: GateExitCode.make(1),
          failureKind: PackageVerifyFailureKind.make("non-zero-exit"),
        },
      },
    })
    expect(retryAbort.message).toContain("PackageVerifyFailed")

    const conflictAbort = new TaskRunAbortedError({
      runId,
      escalation: { _tag: "MergeConflict", branch: SliceBranchName.make("slice/wf3-a") },
    })
    expect(conflictAbort.message).toContain("slice/wf3-a")

    expect(
      Schema.decodeSync(TaskRunAbortedError)({
        _tag: "TaskRunAbortedError",
        runId,
        escalation: { _tag: "AuthRequired", runner: "antigravity" },
      }).escalation._tag,
    ).toBe("AuthRequired")
    expect(() =>
      Schema.decodeUnknownSync(TaskRunAbortedError)({
        _tag: "TaskRunAbortedError",
        runId: "bad",
        escalation: { _tag: "AuthRequired", runner: "unknown-runner" },
      }),
    ).toThrow()

    const wf3QueryNames = [
      "wf_get_run",
      "wf_list_runs",
      "wf_insert_run",
      "wf_update_run",
      "wf_units_for_run",
      "wf_get_unit",
      "wf_insert_unit",
      "wf_update_unit",
      "wf_attempts_for_run",
      "wf_get_attempt",
      "wf_insert_attempt",
      "wf_update_attempt",
      "wf_delete_run_views",
      "wf_probe_runs",
    ] as const
    for (const qName of wf3QueryNames) {
      expect(WORKFLOW_GQ_QUERY_NAMES).toContain(qName)
      expect(Schema.decodeSync(WorkflowGqQueryName)(qName)).toBe(qName)
    }
    expect(() => Schema.decodeUnknownSync(WorkflowGqQueryName)("wf_nonexistent_query")).toThrow()

    const sharedStepInput = Schema.decodeSync(CompleteSharedStepInput)({
      runId,
      baseSha,
      sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
      priorUnitOwnedPaths: [OwnedRelPath.make("libs/harness/contract/src")],
      attempt: AttemptNumber.make(1),
      cwd: repoRoot,
    })
    expect(sharedStepInput.priorUnitOwnedPaths).toEqual(["libs/harness/contract/src"])
    expect(() =>
      Schema.decodeUnknownSync(CompleteSharedStepInput)({
        runId,
        baseSha,
        sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(CompleteSharedStepInput)({
        runId,
        baseSha,
        sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        priorUnitOwnedPaths: [".harness/secret"],
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
      }),
    ).toThrow()
  })

  it("validates WF-3 start, complete, resume requests and workflow attempt record schemas", () => {
    const {
      runId,
      unitId,
      planSha,
      baseSha,
      repoRoot,
      expectedAttemptKey,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
    } = makeWf3Fixtures()

    const plan = Schema.decodeSync(CompiledPlan)({
      runId,
      level: WorkflowLevel.make("slice"),
      planSha,
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId,
          branch: SliceBranchName.make("slice/wf3-unit"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src")],
          earsKeys: [EarsRequirementKey.make("REQ-3.1")],
        },
      ],
      sharedStepPaths: [],
    })

    const startReq = Schema.decodeSync(WorkflowStartRequest)({ repoRoot, plan })
    expect(startReq.plan.runId).toBe(runId)
    expect(() => Schema.decodeSync(WorkflowStartRequest)({ repoRoot: "/", plan })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStartRequest)({ repoRoot, plan: { invalid: true } }),
    ).toThrow()

    const completeUnitReq = Schema.decodeSync(WorkflowCompleteRequest)({
      _tag: "CompleteUnit",
      repoRoot,
      unitId,
      runId,
    })
    const completeLlmReq = Schema.decodeSync(WorkflowCompleteRequest)({
      _tag: "CompleteLlmPhase",
      repoRoot,
    })
    expect(
      match(completeUnitReq)
        .with({ _tag: "CompleteUnit" }, (req) => req.unitId)
        .with({ _tag: "CompleteLlmPhase" }, () => "llm")
        .exhaustive(),
    ).toBe(unitId)
    expect(completeLlmReq._tag).toBe("CompleteLlmPhase")
    expect(() =>
      Schema.decodeSync(WorkflowCompleteRequest)({
        _tag: "CompleteUnit",
        repoRoot,
        unitId: "INVALID_UNIT",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCompleteRequest)({ _tag: "CompleteUnknown", repoRoot }),
    ).toThrow()

    const resumeEscalationReq = Schema.decodeSync(WorkflowResumeRequest)({
      _tag: "ResolveEscalation",
      repoRoot,
      runId,
      unitId,
      decision: EscalationDecision.make("retry"),
    })
    const resumeRunReq = Schema.decodeSync(WorkflowResumeRequest)({
      _tag: "ResumeRun",
      repoRoot,
      runId,
    })
    expect(
      match(resumeEscalationReq)
        .with({ _tag: "ResolveEscalation" }, (r) => r.decision)
        .with({ _tag: "ResumeRun" }, () => "run")
        .exhaustive(),
    ).toBe("retry")
    expect(resumeRunReq._tag).toBe("ResumeRun")
    expect(() =>
      Schema.decodeUnknownSync(WorkflowResumeRequest)({
        _tag: "ResolveEscalation",
        repoRoot,
        runId,
        unitId,
        decision: "skip",
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(WorkflowResumeRequest)({ repoRoot, runId })).toThrow()

    const retryEscalationAttemptKey = makeWorkflowAttemptKey(
      runId,
      unitId,
      AttemptNumber.make(1),
      EscalationOrdinal.make(2),
    )
    expect(retryEscalationAttemptKey).toBe(`${runId}/${unitId}#1/r2`)
    expect(Schema.decodeSync(WorkflowAttemptKey)(expectedAttemptKey)).toBe(expectedAttemptKey)
    expect(Schema.decodeSync(WorkflowAttemptVerdict)("rejected")).toBe("rejected")
    expect(dispatchedAttempt.verdict).toBe("dispatched")
    expect(completedAttempt.verdict).toBe("completed")
    expect(rejectedAttempt.rejection._tag).toBe("StampMissing")
    expect(Schema.decodeSync(RejectionJsonPayload)('{"_tag":"StampMissing"}')).toContain(
      "StampMissing",
    )
    expect(Schema.decodeSync(WorkflowStoreAvailabilityState)("ready")).toBe("ready")
    expect(() =>
      Schema.decodeUnknownSync(RejectedWorkflowAttemptRecord)({
        attemptKey: expectedAttemptKey,
        runId,
        unitId,
        attempt: AttemptNumber.make(1),
        verdict: "rejected",
        updatedMs: WorkflowTimestampMs.make(1_200),
      }),
    ).toThrow()
  })

  it("validates WF-3 outcomes, WorkflowStatusSummary, RPC envelopes, and WorkflowPlanToolOutput", () => {
    const {
      runId,
      unitId,
      planSha,
      treeHash,
      repoRoot,
      commonGitDir,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
      pendingDeferreds,
      skipReview,
      runRecord,
      unitRecord,
    } = makeWf3Fixtures()

    const failedOutcome = Schema.decodeSync(WorkflowRunOutcome)({
      _tag: "Failed",
      run: runRecord,
      units: [unitRecord],
      attempts: [rejectedAttempt],
      pendingDeferreds,
      terminalError: {
        _tag: "StoreUnavailable",
        operation: WorkflowStoreOperation.make("WorkflowRun.status"),
        reason: WorkflowStoreFailureReason.make("daemon stopped"),
      },
      projectionStatus: WorkflowProjectionStatus.make("fresh"),
    })
    expect(failedOutcome._tag).toBe("Failed")
    expect(
      Schema.decodeSync(WorkflowTerminalError)({
        _tag: "LeaseHeld",
        holderId: "daemon-1",
        lockFilePath: "/repo/.git/harness/daemon.lock",
      })._tag,
    ).toBe("LeaseHeld")

    const completedOutcome = Schema.decodeSync(WorkflowRunOutcome)({
      _tag: "Completed",
      run: { ...runRecord, state: WorkflowRunState.make("completed") },
      units: [unitRecord],
      attempts: [completedAttempt],
      pendingDeferreds: [],
      review: skipReview,
      terminalReceipt: {
        runId,
        planSha,
        review: skipReview,
        completedUnits: [unitId],
        llmPhase: { workspaceHash: treeHash, frictionLogCleared: FrictionLogState.make("cleared") },
      },
      projectionStatus: WorkflowProjectionStatus.make("fresh"),
    })
    expect(completedOutcome._tag).toBe("Completed")

    const offlineStatus = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "DaemonOffline",
      outcome: { _tag: "NotFound" },
    })
    expect(offlineStatus._tag).toBe("DaemonOffline")

    const pausedStatus = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "StorePaused",
      writerLeaseEpoch: LeaseEpoch.make(2),
      outcome: {
        _tag: "Active",
        run: runRecord,
        units: [unitRecord],
        attempts: [dispatchedAttempt],
        pendingDeferreds,
        projectionStatus: WorkflowProjectionStatus.make("stale"),
      },
    })
    expect(pausedStatus._tag).toBe("StorePaused")

    const statusSummary = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "Ready",
      writerLeaseEpoch: LeaseEpoch.make(1),
      outcome: failedOutcome,
    })
    expect(statusSummary._tag).toBe("Ready")
    expect(statusSummary.outcome._tag).toBe("Failed")
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStatusSummary)({
        _tag: "Offline",
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStatusSummary)({
        _tag: "Ready",
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(WorkflowStatusSummary)({
        _tag: "Ready",
        writerLeaseEpoch: 0,
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()

    const rpcSuccess = Schema.decodeSync(WorkflowRpcSuccessEnvelope)({
      id: WorkflowRpcRequestId.make("req-1"),
      ok: true,
      command: "workflow.status",
      result: statusSummary,
    })
    const rpcErr = Schema.decodeSync(WorkflowRpcErrorEnvelope)({
      id: WorkflowRpcRequestId.make("req-2"),
      ok: false,
      command: "workflow.start",
      error: WorkflowStoreFailureReason.make("WorkflowDaemonError"),
      detail: WorkflowStoreFailureReason.make("failed"),
    })
    expect(Schema.decodeSync(WorkflowRpcEnvelope)(rpcSuccess).ok).toBe(true)
    expect(Schema.decodeSync(WorkflowRpcEnvelope)(rpcErr).ok).toBe(false)

    const toolOutput = Schema.decodeSync(WorkflowPlanToolOutput)({
      resolvedRepoRoot: repoRoot,
      commonGitDir,
      status: statusSummary,
    })
    expect(toolOutput.resolvedRepoRoot).toBe(repoRoot)
    expect(toolOutput.commonGitDir).toBe(commonGitDir)
    expect(() =>
      Schema.decodeSync(WorkflowPlanToolOutput)({
        resolvedRepoRoot: repoRoot,
        commonGitDir: "relative/.git",
        status: statusSummary,
      }),
    ).toThrow()
  })

  it("round-trips all closed WorkflowTerminalError, WorkflowCompleteResponse, and WorkflowResumeResponse variants", () => {
    const { runId, treeHash, runRecord } = makeWf3Fixtures()
    const executionId = runRecord.executionId
    const unitId = WorkUnitId.make("unit-a")
    const roundtrip = <A, E>(schema: Schema.Codec<A, E, never, never>, value: A): A => {
      const encoded = Schema.encodeSync(schema)(value)
      const decoded = Schema.decodeSync(schema)(encoded)
      expect(decoded).toEqual(value)
      return decoded
    }

    const terminalVariants: ReadonlyArray<WorkflowTerminalError> = [
      WorkflowTerminalError.cases.Aborted.make({
        runId,
        escalation: UnitEscalation.cases.AuthRequired.make({
          runner: RunnerId.make("claude-code"),
        }),
      }),
      WorkflowTerminalError.cases.OperatorAborted.make({
        runId,
        reason: WorkflowStoreFailureReason.make("cancelled by operator"),
      }),
      WorkflowTerminalError.cases.WorkspaceFs.make({
        operation: WorkspaceFsOperation.make("read"),
        reason: WorkflowStoreFailureReason.make("unreadable snapshot"),
      }),
      WorkflowTerminalError.cases.StoreUnavailable.make({
        operation: WorkflowStoreOperation.make("rebuild"),
        reason: WorkflowStoreFailureReason.make("daemon store offline"),
      }),
      WorkflowTerminalError.cases.LeaseHeld.make({
        holderId: LeaseHolderId.make("worker-1"),
        lockFilePath: LeaseFilePath.make("/tmp/repo/.git/harness/daemon.lock"),
      }),
      WorkflowTerminalError.cases.LeaseHeld.make({
        holderId: LeaseHolderId.make("worker-2"),
        leaseEpoch: LeaseEpoch.make(7),
        lockFilePath: LeaseFilePath.make("/tmp/repo/.git/harness/daemon.lock"),
      }),
      WorkflowTerminalError.cases.Interrupted.make({
        reason: WorkflowStoreFailureReason.make("fiber interrupted"),
      }),
      WorkflowTerminalError.cases.Defect.make({
        reason: WorkflowStoreFailureReason.make("unexpected fiber defect"),
      }),
    ]
    for (const variant of terminalVariants) {
      expect(roundtrip(WorkflowTerminalError, variant)._tag).toBe(variant._tag)
    }

    const completeVariants: ReadonlyArray<WorkflowCompleteResponse> = [
      WorkflowCompleteResponse.cases.UnitCompleted.make({
        runId,
        executionId,
        outcome: UnitOutcome.cases.Completed.make({
          unitId,
          attempt: AttemptNumber.make(1),
          changedPaths: [],
          packageStampHash: PackageStampHash.make("b".repeat(64)),
        }),
      }),
      WorkflowCompleteResponse.cases.LlmPhaseCompleted.make({
        runId,
        executionId,
        receipt: { workspaceHash: treeHash, frictionLogCleared: FrictionLogState.make("cleared") },
      }),
    ]
    for (const variant of completeVariants) {
      expect(roundtrip(WorkflowCompleteResponse, variant)._tag).toBe(variant._tag)
    }

    const resumeVariants: ReadonlyArray<WorkflowResumeResponse> = [
      WorkflowResumeResponse.cases.WorkflowResumed.make({ runId, executionId }),
      WorkflowResumeResponse.cases.EscalationResolved.make({
        runId,
        executionId,
        unitId,
        decision: EscalationDecision.make("retry"),
      }),
    ]
    for (const variant of resumeVariants) {
      expect(roundtrip(WorkflowResumeResponse, variant)._tag).toBe(variant._tag)
    }
  })
})
