import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  CircuitBreakerStatus,
  GateDurationMs,
  GateExitCode,
  GateStderrSummary,
  MutationRestoreError,
  PlanSha256,
  ShipAttempt,
  ShipAttemptKey,
  ShipAttemptKeyParts,
  ShipAttemptStatus,
  ShipErrorTag,
  ShipFailureMessage,
  ShipGateFailedError,
  ShipReceipt,
  ShipStage,
  ShipStageFailed,
  ShipStagePassed,
  ShipStageProgress,
  ShipStreamProgressEvent,
  ShipTreeDriftError,
  ShipTreeMismatchError,
  ShipWorkflowError,
  WorkflowExecutionId,
  type WorkflowGqParamsMap,
  WorkflowRunId,
  WorkflowShipAttemptRecord,
  WorkflowShipOutcome,
  WorkflowShipRequest,
  WorkflowShipResponse,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
  decodeShipAttemptKey,
  encodeShipAttemptKey,
  toShipFailureMessage,
} from "../src/index.js"

const sampleRepoRoot = AbsoluteRepoRoot.make("/tmp/harness-ship-repo")
const sampleRunId = WorkflowRunId.make("ship-run-001")
const sampleExecutionId = WorkflowExecutionId.make("ship-exec-001")
const sampleAttempt1 = ShipAttempt.make(1)
const sampleAttempt2 = ShipAttempt.make(2)
const sampleTreeHashA = WorkspaceTreeHash.make("a".repeat(64))
const sampleTreeHashB = WorkspaceTreeHash.make("b".repeat(64))
const samplePlanSha = PlanSha256.make("c".repeat(64))

describe("workflow-ship contracts", () => {
  it("validates WorkflowShipRequest with optional runId and rejects invalid repoRoot or runId", () => {
    const reqWithoutRunId = Schema.decodeSync(WorkflowShipRequest)({
      repoRoot: "/tmp/harness-ship-repo",
    })
    expect(reqWithoutRunId.repoRoot).toBe(sampleRepoRoot)
    expect(reqWithoutRunId.runId).toBeUndefined()

    const reqWithRunId = Schema.decodeSync(WorkflowShipRequest)({
      repoRoot: "/tmp/harness-ship-repo",
      runId: "ship-run-001",
    })
    expect(reqWithRunId.runId).toBe(sampleRunId)

    expect(
      Result.isFailure(
        Schema.decodeResult(WorkflowShipRequest)({
          repoRoot: "relative/repo",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeResult(WorkflowShipRequest)({
          repoRoot: "/tmp/harness-ship-repo",
          runId: "BAD_RUN",
        }),
      ),
    ).toBe(true)
  })

  it("validates ShipStagePassed, ShipStageFailed, and ShipStreamProgressEvent unions exhaustively", () => {
    const passed = ShipStagePassed.make({
      stage: ShipStage.make("verify"),
      durationMs: GateDurationMs.make(1250),
    })
    const failed = ShipStageFailed.make({
      stage: ShipStage.make("mutate-strict"),
      durationMs: GateDurationMs.make(3400),
      errorTag: ShipErrorTag.make("ShipGateFailedError"),
      detail: ShipFailureMessage.make("Mutation gate failed with exit code 1"),
    })

    const decodedPassed = Schema.decodeSync(ShipStageProgress)(
      Schema.encodeSync(ShipStageProgress)(passed),
    )
    const decodedFailed = Schema.decodeSync(ShipStageProgress)(
      Schema.encodeSync(ShipStageProgress)(failed),
    )

    const describeProgress = (progress: ShipStageProgress): string =>
      match(progress)
        .with({ _tag: "Passed" }, (p) => `ok:${p.stage}:${p.durationMs}`)
        .with({ _tag: "Failed" }, (f) => `fail:${f.stage}:${f.errorTag}`)
        .exhaustive()

    expect(describeProgress(decodedPassed)).toBe("ok:verify:1250")
    expect(describeProgress(decodedFailed)).toBe("fail:mutate-strict:ShipGateFailedError")

    const startedEvt = ShipStreamProgressEvent.cases.StageStarted.make({
      runId: sampleRunId,
      attempt: sampleAttempt1,
      stage: ShipStage.make("gc-strict"),
    })
    const finishedEvt = ShipStreamProgressEvent.cases.StageFinished.make({
      runId: sampleRunId,
      attempt: sampleAttempt1,
      progress: passed,
    })

    for (const evt of [startedEvt, finishedEvt]) {
      const roundTripped = Schema.decodeSync(ShipStreamProgressEvent)(
        Schema.encodeSync(ShipStreamProgressEvent)(evt),
      )
      const label = match(roundTripped)
        .with({ _tag: "StageStarted" }, (s) => `start:${s.stage}`)
        .with({ _tag: "StageFinished" }, (f) => `finish:${describeProgress(f.progress)}`)
        .exhaustive()
      expect(label.length).toBeGreaterThan(0)
    }

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ShipStreamProgressEvent)({
          _tag: "StageStarted",
          runId: "ship-run-001",
          attempt: 1,
          stage: "unknown-stage",
        }),
      ),
    ).toBe(true)
  })

  it("validates WorkflowShipResponse and WorkflowShipOutcome Passed and Failed variants", () => {
    const passedStage = ShipStagePassed.make({
      stage: ShipStage.make("done"),
      durationMs: GateDurationMs.make(45),
    })
    const receipt = Schema.decodeSync(ShipReceipt)({
      runId: sampleRunId,
      planSha: samplePlanSha,
      attempt: sampleAttempt1,
      verifiedTreeHash: sampleTreeHashA,
    })

    const passedResponse: WorkflowShipResponse = Schema.decodeSync(WorkflowShipResponse)({
      runId: sampleRunId,
      attempt: sampleAttempt1,
      executionId: sampleExecutionId,
      treeHash: sampleTreeHashA,
      runOrigin: "compiled",
      outcome: WorkflowShipOutcome.cases.Passed.make({
        receipt,
        stages: [passedStage],
      }),
    })

    const passedSummary = match(passedResponse.outcome)
      .with({ _tag: "Passed" }, (p) => `${p.receipt.verifiedTreeHash}:${p.stages.length}`)
      .with({ _tag: "Failed" }, (f) => `failed:${f.error._tag}`)
      .exhaustive()
    expect(passedSummary).toBe(`${sampleTreeHashA}:1`)

    const gateErr = new ShipGateFailedError({
      stage: ShipStage.make("verify"),
      exitCode: GateExitCode.make(1),
      stderrSummary: GateStderrSummary.make("test failed"),
      circuitBreakerStatus: CircuitBreakerStatus.make("clear"),
    })
    const failedStage = ShipStageFailed.make({
      stage: ShipStage.make("verify"),
      durationMs: GateDurationMs.make(900),
      errorTag: ShipErrorTag.make("ShipGateFailedError"),
      detail: toShipFailureMessage(gateErr),
    })

    const failedResponse: WorkflowShipResponse = Schema.decodeSync(WorkflowShipResponse)(
      Schema.encodeSync(WorkflowShipResponse)({
        runId: sampleRunId,
        attempt: sampleAttempt2,
        executionId: sampleExecutionId,
        treeHash: sampleTreeHashA,
        runOrigin: "ephemeral",
        outcome: WorkflowShipOutcome.cases.Failed.make({
          runId: sampleRunId,
          attempt: sampleAttempt2,
          treeHash: sampleTreeHashA,
          stages: [passedStage, failedStage],
          error: gateErr,
        }),
      }),
    )

    const failedTag = match(failedResponse.outcome)
      .with({ _tag: "Passed" }, () => "passed")
      .with({ _tag: "Failed" }, (f) => `${f.error._tag}:${f.stages.length}`)
      .exhaustive()
    expect(failedTag).toBe("ShipGateFailedError:2")

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowShipResponse)({
          ...passedResponse,
          runOrigin: "manual",
        }),
      ),
    ).toBe(true)
  })

  it("validates WorkflowShipAttemptRecord and rejects invalid shipKey, status, hash, or attempt", () => {
    const shipKey = encodeShipAttemptKey(sampleRunId, sampleAttempt1)
    for (const status of ["running", "passed", "failed"] as const) {
      const record = Schema.decodeSync(WorkflowShipAttemptRecord)({
        shipKey,
        runId: sampleRunId,
        attempt: sampleAttempt1,
        treeHash: sampleTreeHashA,
        status: ShipAttemptStatus.make(status),
        updatedMs: WorkflowTimestampMs.make(1_700_000_000_000),
      })
      expect(record.shipKey).toBe(ShipAttemptKey.make("ship-run-001#1"))
      expect(record.status).toBe(status)
    }

    const invalidRecords: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      {
        shipKey: "bad-key",
        runId: sampleRunId,
        attempt: 1,
        treeHash: sampleTreeHashA,
        status: "running",
        updatedMs: 100,
      },
      {
        shipKey,
        runId: sampleRunId,
        attempt: 0,
        treeHash: sampleTreeHashA,
        status: "running",
        updatedMs: 100,
      },
      {
        shipKey,
        runId: sampleRunId,
        attempt: 1,
        treeHash: "not-hex",
        status: "running",
        updatedMs: 100,
      },
      {
        shipKey,
        runId: sampleRunId,
        attempt: 1,
        treeHash: sampleTreeHashA,
        status: "aborted",
        updatedMs: 100,
      },
      {
        shipKey,
        runId: sampleRunId,
        attempt: 1,
        treeHash: sampleTreeHashA,
        status: "passed",
        updatedMs: -1,
      },
    ]
    for (const bad of invalidRecords) {
      expect(Result.isFailure(Schema.decodeUnknownResult(WorkflowShipAttemptRecord)(bad))).toBe(
        true,
      )
    }
  })

  it("formats all 4 tagged ShipWorkflowError messages and converts via toShipFailureMessage", () => {
    const clearGateErr = new ShipGateFailedError({
      stage: ShipStage.make("verify"),
      exitCode: GateExitCode.make(1),
      stderrSummary: GateStderrSummary.make(""),
      circuitBreakerStatus: CircuitBreakerStatus.make("clear"),
    })
    expect(clearGateErr.message).toBe("Ship gate 'verify' failed with exit code 1")

    const trippedGateErr = new ShipGateFailedError({
      stage: ShipStage.make("mutate-strict"),
      exitCode: GateExitCode.make(2),
      stderrSummary: GateStderrSummary.make("mutant survived"),
      circuitBreakerStatus: CircuitBreakerStatus.make("tripped"),
      escalationMessage: ShipFailureMessage.make("manual fix required"),
    })
    expect(trippedGateErr.message).toBe(
      "Ship gate 'mutate-strict' failed with exit code 2 [circuit breaker tripped]: mutant survived — manual fix required",
    )

    const mismatchErr = new ShipTreeMismatchError({
      stage: ShipStage.make("gc-strict"),
      expected: sampleTreeHashA,
      actual: sampleTreeHashB,
    })
    expect(mismatchErr.message).toBe(
      `Workspace tree hash mismatch before 'gc-strict': expected ${sampleTreeHashA}, got ${sampleTreeHashB}`,
    )

    const restoreNoDetailErr = new MutationRestoreError({
      expected: sampleTreeHashA,
      actual: sampleTreeHashB,
    })
    expect(restoreNoDetailErr.message).toBe(
      `Mutation backup restore or tree check failed: expected ${sampleTreeHashA}, got ${sampleTreeHashB}`,
    )

    const restoreWithDetailErr = new MutationRestoreError({
      expected: sampleTreeHashA,
      actual: sampleTreeHashB,
      detail: ShipFailureMessage.make("tar extract failed"),
    })
    expect(restoreWithDetailErr.message).toBe(
      `Mutation backup restore or tree check failed: expected ${sampleTreeHashA}, got ${sampleTreeHashB} (tar extract failed)`,
    )

    const driftErr = new ShipTreeDriftError({
      stage: ShipStage.make("done"),
      expected: sampleTreeHashA,
      actual: sampleTreeHashB,
    })
    expect(driftErr.message).toBe(
      `Workspace tree hash drifted after 'done': expected ${sampleTreeHashA}, got ${sampleTreeHashB}`,
    )

    const allErrors: ReadonlyArray<ShipWorkflowError> = [
      clearGateErr,
      trippedGateErr,
      mismatchErr,
      restoreNoDetailErr,
      restoreWithDetailErr,
      driftErr,
    ]
    for (const err of allErrors) {
      const msg = toShipFailureMessage(err)
      expect(Schema.decodeSync(ShipFailureMessage)(msg)).toBe(msg)
      expect(msg).toBe(err.message)
      const roundTripped = Schema.decodeSync(ShipWorkflowError)(
        Schema.encodeSync(ShipWorkflowError)(err),
      )
      const tag = match(roundTripped)
        .with({ _tag: "ShipGateFailedError" }, (e) => e._tag)
        .with({ _tag: "ShipTreeMismatchError" }, (e) => e._tag)
        .with({ _tag: "MutationRestoreError" }, (e) => e._tag)
        .with({ _tag: "ShipTreeDriftError" }, (e) => e._tag)
        .exhaustive()
      expect(tag).toBe(err._tag)
    }

    const oversizedGateErr = new ShipGateFailedError({
      stage: ShipStage.make("format-check"),
      exitCode: GateExitCode.make(3),
      stderrSummary: GateStderrSummary.make("x".repeat(3000)),
      circuitBreakerStatus: CircuitBreakerStatus.make("clear"),
    })
    const bounded = toShipFailureMessage(oversizedGateErr)
    expect(bounded.length).toBe(2048)
    expect(Schema.decodeSync(ShipFailureMessage)(bounded)).toBe(bounded)
  })

  it("bounds ShipAttempt to I32 range and keeps ShipAttemptKey and decodeShipAttemptKey symmetric", () => {
    const maxI32Attempt = Schema.decodeSync(ShipAttempt)(2_147_483_647)
    expect(maxI32Attempt).toBe(2_147_483_647)
    expect(Schema.decodeSync(ShipAttempt)(1)).toBe(1)

    for (const badAttempt of [0, -1, 1.5, 2_147_483_648, 9_007_199_254_740_991]) {
      expect(Result.isFailure(Schema.decodeResult(ShipAttempt)(badAttempt))).toBe(true)
    }

    const minKey = `${sampleRunId}#1`
    const maxKey = `${sampleRunId}#2147483647`
    for (const [rawKey, expectedAttempt] of [
      [minKey, sampleAttempt1],
      [maxKey, maxI32Attempt],
    ] as const) {
      const schemaDecoded = Schema.decodeResult(ShipAttemptKey)(rawKey)
      const fnDecoded = decodeShipAttemptKey(rawKey)
      expect(Result.isSuccess(schemaDecoded)).toBe(true)
      match(fnDecoded)
        .with({ _tag: "Success" }, ({ success }) => {
          const typedParts: ShipAttemptKeyParts = success
          expect(typedParts).toEqual({ runId: sampleRunId, attempt: expectedAttempt })
          expect(Schema.decodeSync(ShipAttemptKeyParts)(typedParts)).toEqual(typedParts)
          expect(encodeShipAttemptKey(typedParts.runId, typedParts.attempt)).toBe(rawKey)
        })
        .with({ _tag: "Failure" }, ({ failure }) =>
          expect.unreachable(`Expected decodeShipAttemptKey('${rawKey}') to succeed: ${failure}`),
        )
        .exhaustive()
    }

    const rejectedKeys = [
      `${sampleRunId}#0`,
      `${sampleRunId}#01`,
      `${sampleRunId}#-1`,
      `${sampleRunId}#2147483648`,
      `${sampleRunId}#9007199254740992`,
      "short#1",
      "BAD_RUN_01#1",
      `${"a".repeat(65)}#1`,
      "ship-run-001",
      "ship-run-001#1#2",
      " ship-run-001#1",
      "ship-run-001#1 ",
    ]
    for (const badKey of rejectedKeys) {
      expect(Result.isFailure(Schema.decodeResult(ShipAttemptKey)(badKey))).toBe(true)
      expect(Result.isFailure(decodeShipAttemptKey(badKey))).toBe(true)
    }

    match(decodeShipAttemptKey("#1"))
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("expected '<runId>#<attempt>'")
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected decodeShipAttemptKey('#1') to fail"),
      )
      .exhaustive()

    const shipQuerySample: {
      readonly wf_ship_attempts_for_run: WorkflowGqParamsMap["wf_ship_attempts_for_run"]
      readonly wf_get_ship_attempt: WorkflowGqParamsMap["wf_get_ship_attempt"]
      readonly wf_insert_ship_attempt: WorkflowGqParamsMap["wf_insert_ship_attempt"]
      readonly wf_update_ship_attempt: WorkflowGqParamsMap["wf_update_ship_attempt"]
    } = {
      wf_ship_attempts_for_run: { runId: sampleRunId },
      wf_get_ship_attempt: { shipKey: encodeShipAttemptKey(sampleRunId, ShipAttempt.make(1)) },
      wf_insert_ship_attempt: {
        shipKey: encodeShipAttemptKey(sampleRunId, ShipAttempt.make(1)),
        runId: sampleRunId,
        attempt: ShipAttempt.make(1),
        treeHash: WorkspaceTreeHash.make("a".repeat(64)),
        status: ShipAttemptStatus.make("running"),
        updatedMs: WorkflowTimestampMs.make(1_000),
      },
      wf_update_ship_attempt: {
        shipKey: encodeShipAttemptKey(sampleRunId, ShipAttempt.make(1)),
        status: ShipAttemptStatus.make("passed"),
        updatedMs: WorkflowTimestampMs.make(2_000),
      },
    }
    expect(shipQuerySample.wf_insert_ship_attempt.shipKey).toBe(`${sampleRunId}#1`)
  })
})
