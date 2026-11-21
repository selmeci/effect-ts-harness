import { Cause, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  BackupDirPath,
  BackupFileHash,
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonProtocolMismatchDetail,
  DaemonProtocolMismatchError,
  DaemonSocketPath,
  EmptyWorkflowGqParams,
  EscalationOrdinal,
  GitCommonDirPath,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  MessageKey,
  OwnedRelPath,
  PlanJsonPayload,
  PlanSha256,
  PrimaryKeyHash,
  RejectionJsonPayload,
  ReplyKey,
  RunnerId,
  SeqKey,
  ValidatedWorktreeRoot,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WORKFLOW_GQ_QUERY_NAMES,
  WaveIndex,
  WorkUnitId,
  WorkflowAttemptVerdict,
  WorkflowBackupCount,
  WorkflowCleanupKeepVersions,
  WorkflowBackupFilePath,
  WorkflowBackupMode,
  WorkflowBackupReceiptFields,
  WorkflowBackupSummary,
  WorkflowBackupTimestampMs,
  WorkflowDaemonCapability,
  WorkflowExecutionId,
  type WorkflowGqParamsMap,
  WorkflowGqQueryName,
  WorkflowLevel,
  WorkflowProtocolVersion,
  WorkflowRestoreRequest,
  WorkflowRestoreSummary,
  WorkflowRunId,
  WorkflowRunState,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkflowUnitKind,
  WorkflowUnitStatus,
  WorktreePathKind,
  WriterLeaseHeldError,
  decodeSeqKey,
  encodeSeqKey,
  GitCommitSha,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
  toBoundedReason,
} from "../src/index.js"

const expectDecodeSuccess = <A, E>(schema: Schema.Codec<A, E, never, never>, input: unknown): A => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  return match(exit)
    .with({ _tag: "Success" }, (s) => s.value)
    .with({ _tag: "Failure" }, (f) =>
      expect.unreachable(`Expected decode to succeed: ${Cause.pretty(f.cause)}`),
    )
    .exhaustive()
}

const expectDecodeFailure = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  input: unknown,
): void => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  match(exit)
    .with({ _tag: "Failure" }, (f) => {
      expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable(`Expected decode to fail for input: ${String(input)}`)
    })
    .exhaustive()
}

const expectCases = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  valid: ReadonlyArray<unknown>,
  invalid: ReadonlyArray<unknown>,
): void => {
  for (const input of valid) {
    expect(expectDecodeSuccess(schema, input)).toBe(input)
  }
  for (const input of invalid) {
    expectDecodeFailure(schema, input)
  }
}

const SHA_64_A = "a".repeat(64)

describe("@harness/contract WF-2 workflow storage, lease, handshake, and backup schemas", () => {
  it("encodes and decodes 20-char SeqKey losslessly for Snowflakes > 2^53 and rejects out-of-bounds inputs", () => {
    const expectSeqOk = (
      input: bigint | number | string,
      expected: string,
      expectedBigInt: bigint,
    ): SeqKey => {
      const res = encodeSeqKey(input)
      return match(res)
        .with({ _tag: "Success" }, ({ success }) => {
          expect(success).toBe(expected)
          expect(success).toHaveLength(20)
          expect(decodeSeqKey(success)).toBe(expectedBigInt)
          return success
        })
        .with({ _tag: "Failure" }, ({ failure }) =>
          expect.unreachable(`Expected SeqKey encode success, got failure: ${failure}`),
        )
        .exhaustive()
    }

    const expectSeqErr = (input: bigint | number | string, expectedSubstr: string) => {
      const res = encodeSeqKey(input)
      match(res)
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure).toContain(expectedSubstr)
        })
        .with({ _tag: "Success" }, ({ success }) => {
          expect.unreachable(`Expected SeqKey encode failure, got success: ${success}`)
        })
        .exhaustive()
    }

    const max20Digit = 10n ** 20n - 1n
    const snowflakeA = 248476693641609216n
    const snowflakeB = 248476693641609217n

    expectSeqOk(0n, "0".repeat(20), 0n)
    expectSeqOk(0, "0".repeat(20), 0n)
    expectSeqOk("0", "0".repeat(20), 0n)
    expectSeqOk(42, "0".repeat(18) + "42", 42n)
    expectSeqOk(Number.MAX_SAFE_INTEGER, "00009007199254740991", BigInt(Number.MAX_SAFE_INTEGER))
    const encA = expectSeqOk(snowflakeA, "00248476693641609216", snowflakeA)
    const encB = expectSeqOk(snowflakeB, "00248476693641609217", snowflakeB)
    expectSeqOk("248476693641609216", "00248476693641609216", snowflakeA)
    expectSeqOk(max20Digit, "9".repeat(20), max20Digit)
    expect(encA < encB).toBe(true)

    expectSeqErr(-1n, "SeqKey sequence out of 20-digit unsigned bounds: -1")
    expectSeqErr(-1, "SeqKey sequence out of 20-digit unsigned bounds: -1")
    expectSeqErr(
      10n ** 20n,
      "SeqKey sequence out of 20-digit unsigned bounds: 100000000000000000000",
    )
    expectSeqErr("1" + "0".repeat(20), "SeqKey sequence out of 20-digit unsigned bounds")
    expectSeqErr(1.5, "Cannot encode SeqKey from non-safe-integer number: 1.5")
    expectSeqErr(Number.NaN, "Cannot encode SeqKey from non-safe-integer number: NaN")
    expectSeqErr(Number.MAX_SAFE_INTEGER + 1, "Cannot encode SeqKey from non-safe-integer number:")
    expectSeqErr("", 'Cannot encode SeqKey from non-decimal string: ""')
    expectSeqErr(" 42", 'Cannot encode SeqKey from non-decimal string: " 42"')
    expectSeqErr("42 ", 'Cannot encode SeqKey from non-decimal string: "42 "')
    expectSeqErr("-1", 'Cannot encode SeqKey from non-decimal string: "-1"')
    expectSeqErr("12a", 'Cannot encode SeqKey from non-decimal string: "12a"')

    expectCases(
      SeqKey,
      ["0".repeat(20), "00248476693641609216", "9".repeat(20)],
      ["", "0".repeat(19), "0".repeat(21), "0".repeat(19) + "a", 123],
    )
  })

  it("validates WF-2 key brands (MessageKey, ReplyKey, PrimaryKeyHash) and scalar schemas", () => {
    expectCases(
      MessageKey,
      ["0", "248476693641609216", "9".repeat(20)],
      ["", "0".repeat(21), "msg-1", " 123", "123 ", "-1", 123, null, undefined],
    )
    expectCases(
      ReplyKey,
      ["1", "248476693641609260", "9".repeat(20)],
      ["", "9".repeat(21), "reply-1", "12a", " 1", null, undefined],
    )
    expectCases(
      PrimaryKeyHash,
      ["pk-1", `sha256:${SHA_64_A}`, "x".repeat(255)],
      ["", "x".repeat(256), null, undefined],
    )

    expectCases(
      LeaseEpoch,
      [1, 2, 99],
      [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined],
    )
    expectCases(
      LeaseHolderId,
      ["daemon-1", "host_01:pid-42", "a".repeat(256)],
      [
        "",
        "  ",
        " a",
        "a ",
        "a#b",
        "a@b",
        "#daemon",
        "daemon@",
        "a\0b",
        "a\nb",
        "a\rb",
        "a".repeat(257),
        null,
        undefined,
      ],
    )
    expectCases(
      LeaseFilePath,
      ["/repo/.git/harness/daemon.lock", "a".repeat(1024)],
      ["", "  ", " /a", "/a ", "/a\0b", "/a\nb", "/a\rb", "a".repeat(1025), null, undefined],
    )
    expectCases(
      LeaseHolderPid,
      [1, 42, 65535],
      [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined],
    )
    expect(expectDecodeSuccess(WorkflowProtocolVersion, WORKFLOW_DAEMON_PROTOCOL_VERSION)).toBe("1")
    expectCases(
      WorkflowProtocolVersion,
      ["1", "2", "10"],
      ["", "0", "01", "v1", " 1", "1 ", 1, null, undefined],
    )
    expectCases(
      WorkflowDaemonCapability,
      ["workflow.handshake", "workflow:status_v1", "a".repeat(128)],
      ["", "  ", ".cap", "Cap", "a/b", "a".repeat(129), null, undefined],
    )
    expectCases(
      DaemonProtocolMismatchDetail,
      ["missing workflow.handshake handler", "a".repeat(1024)],
      ["", "  ", " a", "a ", "a".repeat(1025), null, undefined],
    )
    expectCases(
      GitCommonDirPath,
      ["/repo/.git", "/a/b c/.git", "/" + "a".repeat(1023)],
      [
        "",
        "/",
        "rel/.git",
        "/../.git",
        "/./.git",
        "/repo/.git/",
        "/a\\b",
        "/a\0b",
        "/a\x1fb",
        "/a\nb",
        "/a\x7fb",
        "/" + "a".repeat(1024),
        null,
        undefined,
      ],
    )
    expectCases(WorktreePathKind, ["canonical", "linked"], ["", "other", null, undefined])
    expectCases(
      BackupDirPath,
      ["/repo/.git/harness/workflow-backups", "a".repeat(1024)],
      ["", "  ", " /a", "/a ", "/a\0b", "/a\nb", "a".repeat(1025), null, undefined],
    )
    expectCases(
      WorkflowBackupFilePath,
      ["/repo/.git/harness/workflow-backups/b1.ndjson", "a".repeat(1024)],
      ["", "  ", " /a", "/a ", "/a\0b", "/a\rb", "a".repeat(1025), null, undefined],
    )
    expectCases(
      WorkflowBackupCount,
      [0, 1, 475],
      [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined],
    )
    expectCases(
      WorkflowBackupTimestampMs,
      [0, 1_700_000_000_000],
      [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined],
    )
    expectCases(
      BackupFileHash,
      [SHA_64_A],
      ["", "0".repeat(63), "0".repeat(65), "A".repeat(64), "g".repeat(64), null, undefined],
    )
    expectCases(WorkflowBackupMode, ["merge", "replace"], ["", "overwrite", null, undefined])
    expectCases(
      WorkflowStoreOperation,
      ["saveEnvelope", "a".repeat(128)],
      ["", "  ", " a", "a ", "a".repeat(129), null, undefined],
    )
    expectCases(
      WorkflowStoreFailureReason,
      ["ECONNREFUSED 127.0.0.1:4321", "a".repeat(1024)],
      ["", "  ", " a", "a ", "a".repeat(1025), null, undefined],
    )
  })

  it("enforces ValidatedWorktreeRoot canonical vs linked consistency and WorkflowRestoreRequest union constraints", () => {
    const roundtrip = <A, E>(schema: Schema.Codec<A, E, never, never>, value: A): A => {
      const encoded = Schema.encodeSync(schema)(value)
      const decoded = expectDecodeSuccess(schema, encoded)
      expect(decoded).toEqual(value)
      return decoded
    }

    roundtrip(ValidatedWorktreeRoot, {
      worktreeRoot: AbsoluteRepoRoot.make("/repo"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
      kind: "canonical",
    })
    roundtrip(ValidatedWorktreeRoot, {
      worktreeRoot: AbsoluteRepoRoot.make("/repo/.worktrees/slice-1"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
      kind: "linked",
    })
    expectDecodeFailure(ValidatedWorktreeRoot, {
      worktreeRoot: AbsoluteRepoRoot.make("/repo/.worktrees/slice-1"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
      kind: "canonical",
    })
    expectDecodeFailure(ValidatedWorktreeRoot, {
      worktreeRoot: AbsoluteRepoRoot.make("/repo"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
      kind: "linked",
    })

    roundtrip(DaemonHandshakeRequest, {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      repoRoot: AbsoluteRepoRoot.make("/repo"),
    })
    roundtrip(DaemonHandshakeRequest, {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      repoRoot: AbsoluteRepoRoot.make("/repo"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
    })

    roundtrip(DaemonHandshakeResponse, {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      capabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
      repoRoot: AbsoluteRepoRoot.make("/repo"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
      writerLeaseEpoch: LeaseEpoch.make(3),
    })
    roundtrip(DaemonHandshakeResponse, {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      capabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
      repoRoot: AbsoluteRepoRoot.make("/repo"),
      commonGitDir: GitCommonDirPath.make("/repo/.git"),
    })
    expectDecodeFailure(DaemonHandshakeResponse, {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      capabilities: ["workflow.handshake"],
      repoRoot: "/repo",
      commonGitDir: "/repo/.git",
      writerLeaseEpoch: 0,
    })

    const backupFile = WorkflowBackupFilePath.make("/repo/.git/harness/workflow-backups/b1.ndjson")
    expect(Object.keys(WorkflowBackupReceiptFields)).toEqual([
      "backupFile",
      "timestampMs",
      "sha256",
    ])

    roundtrip(WorkflowBackupSummary, {
      backupFile,
      entityCount: WorkflowBackupCount.make(475),
      timestampMs: WorkflowBackupTimestampMs.make(1_700_000_000_000),
      sha256: BackupFileHash.make(SHA_64_A),
    })
    roundtrip(WorkflowRestoreRequest, {
      backupFile,
      mode: "merge",
    })
    roundtrip(WorkflowRestoreRequest, {
      backupFile,
      mode: "merge",
      expectedSha256: BackupFileHash.make(SHA_64_A),
    })
    roundtrip(WorkflowRestoreRequest, {
      backupFile,
      mode: "replace",
      expectedSha256: BackupFileHash.make(SHA_64_A),
    })
    expectDecodeFailure(WorkflowRestoreRequest, {
      backupFile,
      mode: "replace",
    })
    expectDecodeFailure(WorkflowRestoreRequest, {
      backupFile,
      mode: "merge",
      expectedSha256: "not-a-sha256",
    })
    expectDecodeFailure(WorkflowRestoreRequest, {
      backupFile,
      mode: "replace",
      expectedSha256: "not-a-sha256",
    })
    roundtrip(WorkflowRestoreSummary, {
      backupFile,
      mode: WorkflowBackupMode.make("replace"),
      restoredEntityCount: WorkflowBackupCount.make(475),
      timestampMs: WorkflowBackupTimestampMs.make(1_700_000_000_123),
      sha256: BackupFileHash.make(SHA_64_A),
    })

    const seqKey = SeqKey.make("0".repeat(20))
    const backupDir = BackupDirPath.make("/repo/.git/harness/workflow-backups")
    const leaseFile = LeaseFilePath.make("/repo/.git/harness/daemon.lock")
    const msgKey = MessageKey.make("100")
    const replyKey = ReplyKey.make("100")
    const pkHash = PrimaryKeyHash.make("pk-1")

    // @ts-expect-error SeqKey cannot be assigned to WorkflowRunId
    const badRunFromSeq: WorkflowRunId = seqKey
    // @ts-expect-error BackupDirPath cannot be assigned to LeaseFilePath
    const badLeaseFromBackup: LeaseFilePath = backupDir
    // @ts-expect-error WorkflowBackupFilePath cannot be assigned to BackupDirPath
    const badDirFromFile: BackupDirPath = backupFile
    // @ts-expect-error MessageKey cannot be assigned to ReplyKey
    const badReplyFromMsg: ReplyKey = msgKey
    // @ts-expect-error ReplyKey cannot be assigned to PrimaryKeyHash
    const badPkFromReply: PrimaryKeyHash = replyKey

    expect(badRunFromSeq).toBe(seqKey)
    expect(badLeaseFromBackup).toBe(backupDir)
    expect(badDirFromFile).toBe(backupFile)
    expect(badReplyFromMsg).toBe(msgKey)
    expect(badPkFromReply).toBe(replyKey)
    expect(pkHash).toBe("pk-1")
    expect(leaseFile).toBe("/repo/.git/harness/daemon.lock")

    expectCases(
      WorkflowCleanupKeepVersions,
      [1, 3, 10],
      [0, -1, 1.5, Number.NaN, "1", null, undefined],
    )
  })

  it("validates WorkflowGqQueryName literals, WorkflowGqParamsMap alignment, and toBoundedReason", () => {
    expectCases(WorkflowGqQueryName, WORKFLOW_GQ_QUERY_NAMES, [
      "",
      "wf_nonexistent_query",
      "wf_count_all ",
      " wf_count_all",
      null,
      undefined,
    ])

    const emptyParams = expectDecodeSuccess(EmptyWorkflowGqParams, {})
    expect(emptyParams).toEqual({})

    const runIdSample = WorkflowRunId.make("run-wf3-01")
    const unitIdSample = WorkUnitId.make("unit-a")
    const unitKeySample = makeWorkflowUnitKey(runIdSample, unitIdSample)
    const attemptKeySample = makeWorkflowAttemptKey(
      runIdSample,
      unitIdSample,
      AttemptNumber.make(1),
      EscalationOrdinal.make(2),
    )
    expect(unitKeySample).toBe("run-wf3-01/unit-a")
    expect(attemptKeySample).toBe("run-wf3-01/unit-a#1/r2")

    const typedQuerySample: {
      readonly wf_count_all: WorkflowGqParamsMap["wf_count_all"]
      readonly wf_count_replies: WorkflowGqParamsMap["wf_count_replies"]
      readonly wf_message_by_pk: WorkflowGqParamsMap["wf_message_by_pk"]
      readonly wf_insert_run: WorkflowGqParamsMap["wf_insert_run"]
      readonly wf_insert_unit: WorkflowGqParamsMap["wf_insert_unit"]
      readonly wf_insert_attempt: WorkflowGqParamsMap["wf_insert_attempt"]
      readonly wf_delete_run_views: WorkflowGqParamsMap["wf_delete_run_views"]
    } = {
      wf_count_all: emptyParams,
      wf_count_replies: emptyParams,
      wf_message_by_pk: { primaryKeyHash: PrimaryKeyHash.make("pk-1") },
      wf_insert_run: {
        runId: runIdSample,
        executionId: WorkflowExecutionId.make("exec-1"),
        level: WorkflowLevel.make("slice"),
        planSha: PlanSha256.make(SHA_64_A),
        baseSha: GitCommitSha.make("a".repeat(40)),
        state: WorkflowRunState.make("running"),
        planJson: PlanJsonPayload.make("{}"),
        updatedMs: WorkflowTimestampMs.make(1_000),
      },
      wf_insert_unit: {
        unitKey: unitKeySample,
        runId: runIdSample,
        unitId: unitIdSample,
        kind: WorkflowUnitKind.make("slice"),
        waveIndex: WaveIndex.make(0),
        status: WorkflowUnitStatus.make("dispatched"),
        ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src")],
        updatedMs: WorkflowTimestampMs.make(1_000),
      },
      wf_insert_attempt: {
        attemptKey: attemptKeySample,
        runId: runIdSample,
        unitId: unitIdSample,
        attempt: AttemptNumber.make(1),
        verdict: WorkflowAttemptVerdict.make("rejected"),
        runner: RunnerId.make("antigravity"),
        rejection: RejectionJsonPayload.make('{"_tag":"StampMissing"}'),
        packageStampHash: null,
        updatedMs: WorkflowTimestampMs.make(1_000),
      },
      wf_delete_run_views: { runId: runIdSample },
    }
    expect(typedQuerySample.wf_message_by_pk.primaryKeyHash).toBe("pk-1")
    expect(typedQuerySample.wf_insert_run.runId).toBe(runIdSample)

    expect(toBoundedReason(new Error("  boom  "))).toBe("boom")
    expect(toBoundedReason("   ", "  custom fallback  ")).toBe("custom fallback")
    expect(toBoundedReason("", "   ")).toBe("Workflow store request failed")
    expect(toBoundedReason("   ", " " + "x".repeat(1200))).toHaveLength(1024)
    expect(toBoundedReason("x".repeat(1100) + "  ")).toHaveLength(1024)
    expect(toBoundedReason("   " + "a".repeat(1020) + "    ")).toBe("a".repeat(1020))
    expect(toBoundedReason({ message: "structured fail" })).toBe("structured fail")
    expect(Result.isResult(encodeSeqKey(1))).toBe(true)
  })

  it("constructs WF-2 TaggedErrors with expected payloads and exact .message getters", () => {
    const leaseWithPid = new WriterLeaseHeldError({
      holderId: LeaseHolderId.make("daemon-abc"),
      leaseEpoch: LeaseEpoch.make(4),
      lockFilePath: LeaseFilePath.make("/repo/.git/harness/daemon.lock"),
      holderPid: LeaseHolderPid.make(4242),
    })
    expect(leaseWithPid._tag).toBe("WriterLeaseHeldError")
    expect(leaseWithPid.message).toBe(
      "Workflow writer lease held by daemon-abc (epoch 4, pid 4242) at /repo/.git/harness/daemon.lock",
    )

    const leaseWithoutPid = new WriterLeaseHeldError({
      holderId: LeaseHolderId.make("daemon-abc"),
      lockFilePath: LeaseFilePath.make("/repo/.git/harness/daemon.lock"),
    })
    expect(leaseWithoutPid.message).toBe(
      "Workflow writer lease held by daemon-abc (epoch unknown) at /repo/.git/harness/daemon.lock",
    )
    expectDecodeSuccess(WriterLeaseHeldError, leaseWithoutPid)
    expectDecodeFailure(WriterLeaseHeldError, {
      _tag: "WriterLeaseHeldError",
      holderId: "daemon-abc",
      leaseEpoch: 0,
      lockFilePath: "/repo/.git/harness/daemon.lock",
    })
    expectDecodeSuccess(WriterLeaseHeldError, leaseWithPid)
    expectDecodeFailure(WriterLeaseHeldError, {
      _tag: "WriterLeaseHeldError",
      holderId: "",
      leaseEpoch: -1,
      lockFilePath: "",
    })

    const mismatchWithActual = new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      actualVersion: WorkflowProtocolVersion.make("2"),
      socketPath: DaemonSocketPath.make("/repo/.git/harness/daemon.sock"),
      detail: DaemonProtocolMismatchDetail.make("version mismatch"),
    })
    expect(mismatchWithActual._tag).toBe("DaemonProtocolMismatchError")
    expect(mismatchWithActual.message).toBe(
      "Daemon protocol mismatch at /repo/.git/harness/daemon.sock: expected v1, got v2 (version mismatch)",
    )

    const mismatchWithoutActual = new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      socketPath: DaemonSocketPath.make("/repo/.git/harness/daemon.sock"),
      detail: DaemonProtocolMismatchDetail.make("missing workflow.handshake"),
    })
    expect(mismatchWithoutActual.message).toBe(
      "Daemon protocol mismatch at /repo/.git/harness/daemon.sock: expected v1, got unsupported/missing (missing workflow.handshake)",
    )
    expectDecodeSuccess(DaemonProtocolMismatchError, mismatchWithActual)
    expectDecodeFailure(DaemonProtocolMismatchError, {
      _tag: "DaemonProtocolMismatchError",
      expectedVersion: "0",
      socketPath: "",
      detail: "",
    })

    const storeErr = new WorkflowStoreUnavailableError({
      operation: WorkflowStoreOperation.make("saveEnvelope"),
      reason: WorkflowStoreFailureReason.make("ECONNREFUSED 127.0.0.1:4321"),
    })
    expect(storeErr._tag).toBe("WorkflowStoreUnavailableError")
    expect(storeErr.message).toBe(
      "Workflow store unavailable during saveEnvelope: ECONNREFUSED 127.0.0.1:4321",
    )
    expectDecodeSuccess(WorkflowStoreUnavailableError, storeErr)
    expectDecodeFailure(WorkflowStoreUnavailableError, {
      _tag: "WorkflowStoreUnavailableError",
      operation: "",
      reason: "",
    })
  })
})
