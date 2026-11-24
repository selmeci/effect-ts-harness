import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { DaemonSocketPath } from "./cache-and-daemon.js"
import { AbsoluteRepoRoot, GitCommitSha } from "./repo-identity.js"
import {
  AttemptNumber,
  EscalationOrdinal,
  OwnedRelPath,
  PackageStampHash,
  PlanSha256,
  RunnerId,
  ShipAttempt,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowLevel,
  WorkflowRunId,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
} from "./workflow.js"
import type { ShipAttemptKey, ShipAttemptStatus } from "./workflow-ship.js"
import { ErrorReasonMessage, toErrorReasonMessage } from "./workspace-and-process.js"

const SEQ_KEY_WIDTH = 20
const MAX_SEQ_KEY_BIGINT = 10n ** 20n - 1n
const MAX_WORKFLOW_STORE_FAILURE_REASON_LEN = 1024

const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const SingleLineTrimmedPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
)

/**
 * 20-character zero-padded decimal string (`00000000000000000000`..`99999999999999999999`)
 * for lossless lexicographic `ORDER BY` of 64-bit Snowflake IDs (`> Number.MAX_SAFE_INTEGER`)
 * in Omnigraph.
 */
export const SeqKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{20}$/)),
  Schema.brand("SeqKey"),
)
export type SeqKey = typeof SeqKey.Type

/** Unsigned 64-bit decimal Snowflake string (`1..20` ASCII digits) identifying a `WfMessage` node. */
export const MessageKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{1,20}$/)),
  Schema.brand("MessageKey"),
)
export type MessageKey = typeof MessageKey.Type

/** Unsigned 64-bit decimal Snowflake string (`1..20` ASCII digits) identifying a `WfReply` node. */
export const ReplyKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{1,20}$/)),
  Schema.brand("ReplyKey"),
)
export type ReplyKey = typeof ReplyKey.Type

/** Trimmed/bounded idempotency key (`1..255` chars; verbatim if `<=255`, else `sha256:<hex>`) on `WfMessage.primaryKeyHash`. */
export const PrimaryKeyHash = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(255)),
  Schema.brand("PrimaryKeyHash"),
)
export type PrimaryKeyHash = typeof PrimaryKeyHash.Type

const hasNoControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

const parseSeqBigInt = (
  value: bigint | number | string,
): Result.Result<bigint, ErrorReasonMessage> => {
  if (typeof value === "bigint") {
    return Result.succeed(value)
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? Result.succeed(BigInt(value))
      : Result.fail(
          ErrorReasonMessage.make(
            `Cannot encode SeqKey from non-safe-integer number: ${String(value)}`,
          ),
        )
  }
  return /^\d+$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(
        ErrorReasonMessage.make(
          `Cannot encode SeqKey from non-decimal string: ${JSON.stringify(value)}`,
        ),
      )
}

/**
 * Encodes a non-negative `bigint`, safe non-negative integer `number`, or decimal digit string
 * (<= 20 digits) into a zero-padded 20-character `SeqKey`.
 */
export const encodeSeqKey = (
  value: bigint | number | string,
): Result.Result<SeqKey, ErrorReasonMessage> =>
  Result.flatMap(parseSeqBigInt(value), (digits) =>
    digits < 0n || digits > MAX_SEQ_KEY_BIGINT
      ? Result.fail(
          ErrorReasonMessage.make(
            `SeqKey sequence out of 20-digit unsigned bounds: ${digits.toString()}`,
          ),
        )
      : Result.succeed(SeqKey.make(digits.toString().padStart(SEQ_KEY_WIDTH, "0"))),
  )

/** Losslessly decodes a 20-character `SeqKey` back into a non-negative `bigint`. */
export const decodeSeqKey = (seqKey: SeqKey): bigint => BigInt(seqKey)

/** Monotonically increasing fencing epoch (`>= 1`) for the active workflow single-writer lease. */
export const LeaseEpoch = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("LeaseEpoch"),
)
export type LeaseEpoch = typeof LeaseEpoch.Type

/**
 * Trimmed non-empty identifier of the daemon instance holding the writer lease.
 * Disallows `#`, `@`, NUL, CR, and LF so serialized lock metadata tokens remain unambiguously parseable.
 */
export const LeaseHolderId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(/^[^\0\r\n#@]+$/)),
  Schema.brand("LeaseHolderId"),
)
export type LeaseHolderId = typeof LeaseHolderId.Type

/** POSIX file path to the workflow writer advisory lock file (`<git-common-dir>/harness/daemon.lock`). */
export const LeaseFilePath = SingleLineTrimmedPath.pipe(Schema.brand("LeaseFilePath"))
export type LeaseFilePath = typeof LeaseFilePath.Type

/** OS process ID (`>= 1`) of a workflow writer lease holder. */
export const LeaseHolderPid = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("LeaseHolderPid"),
)
export type LeaseHolderPid = typeof LeaseHolderPid.Type

/** Positive integer string identifying the workflow daemon IPC protocol version. */
export const WorkflowProtocolVersion = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[1-9]\d*$/)),
  Schema.brand("WorkflowProtocolVersion"),
)
export type WorkflowProtocolVersion = typeof WorkflowProtocolVersion.Type

export const WORKFLOW_DAEMON_PROTOCOL_VERSION: WorkflowProtocolVersion =
  WorkflowProtocolVersion.make("1")

/** Capability identifier advertised by the workflow daemon during `workflow.handshake`. */
export const WorkflowDaemonCapability = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._:-]*$/)),
  Schema.brand("WorkflowDaemonCapability"),
)
export type WorkflowDaemonCapability = typeof WorkflowDaemonCapability.Type

export const DaemonProtocolMismatchDetail = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.brand("DaemonProtocolMismatchDetail"),
)
export type DaemonProtocolMismatchDetail = typeof DaemonProtocolMismatchDetail.Type

/** Canonical POSIX absolute path to the shared git common directory (`<repo>/.git` or explicit git common dir). */
export const GitCommonDirPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isPattern(/^(?:\/(?!\.\.?(?:\/|$))[^\\/]+)+$/)),
  Schema.check(
    Schema.makeFilter(hasNoControlChars, {
      message: "GitCommonDirPath must not contain ASCII control characters",
    }),
  ),
  Schema.brand("GitCommonDirPath"),
)
export type GitCommonDirPath = typeof GitCommonDirPath.Type

export const WorktreePathKind = Schema.Literals(["canonical", "linked"])
export type WorktreePathKind = typeof WorktreePathKind.Type

/**
 * Validated git worktree root bound to its shared `commonGitDir`.
 * Enforces structural consistency between `kind` and `commonGitDir`: `"canonical"`
 * requires `<worktreeRoot>/.git` while `"linked"` requires an external `commonGitDir`.
 */
export const ValidatedWorktreeRoot = Schema.Struct({
  worktreeRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  kind: WorktreePathKind,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (v) =>
        match(v.kind)
          .with("canonical", () => v.commonGitDir === `${v.worktreeRoot}/.git`)
          .with("linked", () => v.commonGitDir !== `${v.worktreeRoot}/.git`)
          .exhaustive(),
      {
        message:
          'ValidatedWorktreeRoot kind "canonical" requires commonGitDir === "<worktreeRoot>/.git" and "linked" requires an external commonGitDir',
      },
    ),
  ),
)
export type ValidatedWorktreeRoot = typeof ValidatedWorktreeRoot.Type

/**
 * Request payload sent inside the canonical `workflow.handshake` daemon command.
 * The daemon responds with `{ id, ok: true, handshake: DaemonHandshakeResponse }`.
 */
export const DaemonHandshakeRequest = Schema.Struct({
  protocolVersion: WorkflowProtocolVersion,
  repoRoot: AbsoluteRepoRoot,
  commonGitDir: Schema.optional(GitCommonDirPath),
})
export type DaemonHandshakeRequest = typeof DaemonHandshakeRequest.Type

/**
 * Handshake metadata returned under `{ id, ok: true, handshake: DaemonHandshakeResponse }`.
 * Active workflow-leased daemons advertise `writerLeaseEpoch` (`>= 1`); daemons running without
 * an active workflow lease omit `writerLeaseEpoch`.
 */
export const DaemonHandshakeResponse = Schema.Struct({
  protocolVersion: WorkflowProtocolVersion,
  capabilities: Schema.Array(WorkflowDaemonCapability),
  repoRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  writerLeaseEpoch: Schema.optional(LeaseEpoch),
})
export type DaemonHandshakeResponse = typeof DaemonHandshakeResponse.Type

/** Directory path where `harness-workflows` NDJSON backups are stored (`<git-common-dir>/harness/workflow-backups`). */
export const BackupDirPath = SingleLineTrimmedPath.pipe(Schema.brand("BackupDirPath"))
export type BackupDirPath = typeof BackupDirPath.Type

/** File path to a specific `harness-workflows` NDJSON backup file. */
export const WorkflowBackupFilePath = SingleLineTrimmedPath.pipe(
  Schema.brand("WorkflowBackupFilePath"),
)
export type WorkflowBackupFilePath = typeof WorkflowBackupFilePath.Type

/** Non-negative count of entities exported or restored in a `harness-workflows` backup. */
export const WorkflowBackupCount = NonNegativeInt.pipe(Schema.brand("WorkflowBackupCount"))
export type WorkflowBackupCount = typeof WorkflowBackupCount.Type

/** Positive integer count (`>= 1`) of retained Lance MVCC versions for offline cleanup (`--keep <n>`). */
export const WorkflowCleanupKeepVersions = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("WorkflowCleanupKeepVersions"),
)
export type WorkflowCleanupKeepVersions = typeof WorkflowCleanupKeepVersions.Type

/** Non-negative epoch millisecond timestamp recorded for a `harness-workflows` backup or restore. */
export const WorkflowBackupTimestampMs = NonNegativeInt.pipe(
  Schema.brand("WorkflowBackupTimestampMs"),
)
export type WorkflowBackupTimestampMs = typeof WorkflowBackupTimestampMs.Type

/** Lowercase 64-hex SHA-256 digest of a serialized `harness-workflows` backup file. */
export const BackupFileHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("BackupFileHash"),
)
export type BackupFileHash = typeof BackupFileHash.Type

export const WorkflowBackupMode = Schema.Literals(["merge", "replace"])
export type WorkflowBackupMode = typeof WorkflowBackupMode.Type

/** Shared receipt fields present on workflow backup summaries, restore summaries, and pending-restore journals. */
export const WorkflowBackupReceiptFields = {
  backupFile: WorkflowBackupFilePath,
  timestampMs: WorkflowBackupTimestampMs,
  sha256: BackupFileHash,
} as const

export const WorkflowBackupSummary = Schema.Struct({
  ...WorkflowBackupReceiptFields,
  entityCount: WorkflowBackupCount,
})
export type WorkflowBackupSummary = typeof WorkflowBackupSummary.Type

export const MergeWorkflowRestoreRequest = Schema.Struct({
  backupFile: WorkflowBackupFilePath,
  mode: Schema.Literal("merge"),
  expectedSha256: Schema.optional(BackupFileHash),
})
export type MergeWorkflowRestoreRequest = typeof MergeWorkflowRestoreRequest.Type

export const ReplaceWorkflowRestoreRequest = Schema.Struct({
  backupFile: WorkflowBackupFilePath,
  mode: Schema.Literal("replace"),
  expectedSha256: BackupFileHash,
})
export type ReplaceWorkflowRestoreRequest = typeof ReplaceWorkflowRestoreRequest.Type

/**
 * Discriminated backup restore request keyed by `mode`: `"replace"` destructively overwrites
 * target branch contents and therefore always requires a verified `expectedSha256` digest.
 */
export const WorkflowRestoreRequest = Schema.Union([
  MergeWorkflowRestoreRequest,
  ReplaceWorkflowRestoreRequest,
])
export type WorkflowRestoreRequest = typeof WorkflowRestoreRequest.Type

export const WorkflowRestoreSummary = Schema.Struct({
  ...WorkflowBackupReceiptFields,
  mode: WorkflowBackupMode,
  restoredEntityCount: WorkflowBackupCount,
})
export type WorkflowRestoreSummary = typeof WorkflowRestoreSummary.Type

export const WorkflowStoreOperation = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("WorkflowStoreOperation"),
)
export type WorkflowStoreOperation = typeof WorkflowStoreOperation.Type

export const WorkflowStoreFailureReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(MAX_WORKFLOW_STORE_FAILURE_REASON_LEN)),
  Schema.brand("WorkflowStoreFailureReason"),
)
export type WorkflowStoreFailureReason = typeof WorkflowStoreFailureReason.Type

/**
 * Total conversion from an arbitrary thrown/caught value into a trimmed, length-bounded
 * `WorkflowStoreFailureReason` (`1..1024` chars). Never throws `SchemaError`.
 */
export const toBoundedReason = (
  raw: unknown,
  fallback = "Workflow store request failed",
): WorkflowStoreFailureReason => {
  const cleanFallback = fallback.trim().slice(0, MAX_WORKFLOW_STORE_FAILURE_REASON_LEN).trim()
  const effectiveFallback =
    cleanFallback.length > 0 ? cleanFallback : "Workflow store request failed"
  const sanitized = toErrorReasonMessage(raw, effectiveFallback)
    .slice(0, MAX_WORKFLOW_STORE_FAILURE_REASON_LEN)
    .trim()
  return WorkflowStoreFailureReason.make(sanitized.length > 0 ? sanitized : effectiveFallback)
}

/** Exact declared stored GQ 2.1 query names in `libs/harness/graph/workflow-queries/workflows.gq`. */
export const WORKFLOW_GQ_QUERY_NAMES = [
  "wf_message_by_pk",
  "wf_messages_by_keys",
  "wf_reply_by_key",
  "wf_replies_by_keys",
  "wf_insert_request_message",
  "wf_insert_ack_chunk",
  "wf_insert_interrupt",
  "wf_save_reply_exit",
  "wf_save_reply_chunk",
  "wf_clear_replies_unconditional_delete",
  "wf_clear_replies_cas_delete",
  "wf_reset_message_for_clear",
  "wf_reset_message_for_clear_cas",
  "wf_dangling_processed_requests",
  "wf_repair_dangling_requests",
  "wf_replies_for",
  "wf_replies_for_unfiltered",
  "wf_unprocessed_candidate_messages",
  "wf_unprocessed_candidate_messages_for_addresses",
  "wf_claim_messages",
  "wf_unprocessed_messages_by_id",
  "wf_reset_requests",
  "wf_reset_address",
  "wf_reset_address_group",
  "wf_reset_shards",
  "wf_message_keys_for_address",
  "wf_clear_address",
  "wf_count_all",
  "wf_count_replies",
  "wf_all_entities",
  "wf_all_replies",
  "wf_orphan_entity_messages",
  "wf_quarantine_orphan_messages",
  "wf_get_writer_lease",
  "wf_insert_writer_lease",
  "wf_cas_writer_lease",
  "wf_refresh_writer_lease",
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
  "wf_ship_attempts_for_run",
  "wf_get_ship_attempt",
  "wf_insert_ship_attempt",
  "wf_update_ship_attempt",
  "wf_delete_run_views",
  "wf_probe_runs",
] as const

export const WorkflowGqQueryName = Schema.Literals(WORKFLOW_GQ_QUERY_NAMES)
export type WorkflowGqQueryName = typeof WorkflowGqQueryName.Type

const WORKFLOW_UNIT_KEY_RE = /^[a-z0-9][a-z0-9-]{7,63}\/[a-z0-9][a-z0-9_.:-]{0,63}$/
const WORKFLOW_ATTEMPT_KEY_RE =
  /^[a-z0-9][a-z0-9-]{7,63}\/[a-z0-9][a-z0-9_.:-]{0,63}#[1-3](?:\/r[1-9]\d*)?$/

export { WorkflowTimestampMs }

/** Composite key `<runId>/<unitId>` identifying a `WfUnit` read-model node. */
export const WorkflowUnitKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(WORKFLOW_UNIT_KEY_RE)),
  Schema.brand("WorkflowUnitKey"),
)
export type WorkflowUnitKey = typeof WorkflowUnitKey.Type

/** Composite key `<runId>/<unitId>#<attempt>(/r<n>)?` identifying a `WfAttempt` read-model node. */
export const WorkflowAttemptKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(WORKFLOW_ATTEMPT_KEY_RE)),
  Schema.brand("WorkflowAttemptKey"),
)
export type WorkflowAttemptKey = typeof WorkflowAttemptKey.Type

/** Canonical smart constructor for `WorkflowUnitKey` (`<runId>/<unitId>`). */
export const makeWorkflowUnitKey = (runId: WorkflowRunId, unitId: WorkUnitId): WorkflowUnitKey =>
  WorkflowUnitKey.make(`${runId}/${unitId}`)

/** Canonical smart constructor for `WorkflowAttemptKey` (`<runId>/<unitId>#<attempt>(/r<n>)?`). */
export const makeWorkflowAttemptKey = (
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  escalationOrdinal?: EscalationOrdinal,
): WorkflowAttemptKey =>
  WorkflowAttemptKey.make(
    escalationOrdinal !== undefined && escalationOrdinal > 1
      ? `${runId}/${unitId}#${attempt}/r${escalationOrdinal}`
      : `${runId}/${unitId}#${attempt}`,
  )

/** Serialized `CompiledPlan` JSON stored on `WfRun.planJson`. */
export const PlanJsonPayload = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PlanJsonPayload"),
)
export type PlanJsonPayload = typeof PlanJsonPayload.Type

/** Serialized `UnitRejection` JSON stored on `WfAttempt.rejection`. */
export const RejectionJsonPayload = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("RejectionJsonPayload"),
)
export type RejectionJsonPayload = typeof RejectionJsonPayload.Type

/** Lifecycle states persisted in `WfRun.state`. */
export const WorkflowRunState = Schema.Literals(["running", "waiting", "completed", "aborted"])
export type WorkflowRunState = typeof WorkflowRunState.Type

/** Unit kinds persisted in `WfUnit.kind`. */
export const WorkflowUnitKind = Schema.Literals(["slice", "package"])
export type WorkflowUnitKind = typeof WorkflowUnitKind.Type

/** Unit status values persisted in `WfUnit.status`. */
export const WorkflowUnitStatus = Schema.Literals([
  "pending",
  "dispatched",
  "completed",
  "escalated",
])
export type WorkflowUnitStatus = typeof WorkflowUnitStatus.Type

/** Attempt verdicts persisted in `WfAttempt.verdict`. */
export const WorkflowAttemptVerdict = Schema.Literals(["dispatched", "completed", "rejected"])
export type WorkflowAttemptVerdict = typeof WorkflowAttemptVerdict.Type

/** Empty GQ parameter map shared by zero-argument workflow queries. */
export const EmptyWorkflowGqParams = Schema.Struct({})
export type EmptyWorkflowGqParams = typeof EmptyWorkflowGqParams.Type

/** Compile-time parameter contract for every stored query in `workflows.gq`. */
export interface WorkflowGqParamsMap {
  readonly wf_message_by_pk: { readonly primaryKeyHash: PrimaryKeyHash }
  readonly wf_messages_by_keys: { readonly messageKeys: ReadonlyArray<MessageKey> }
  readonly wf_reply_by_key: { readonly replyKey: ReplyKey }
  readonly wf_replies_by_keys: { readonly replyKeys: ReadonlyArray<ReplyKey> }
  readonly wf_insert_request_message: {
    readonly messageKey: MessageKey
    readonly seqKey: SeqKey
    readonly primaryKeyHash: PrimaryKeyHash | null
    readonly shardId: string
    readonly entityType: string
    readonly entityId: string
    readonly tag: string
    readonly payload: string
    readonly headers: string
    readonly traceId: string | null
    readonly spanId: string | null
    readonly sampled: boolean | null
    readonly requestId: MessageKey
    readonly deliverAtMs: number | null
  }
  readonly wf_insert_ack_chunk: {
    readonly messageKey: MessageKey
    readonly seqKey: SeqKey
    readonly primaryKeyHash: PrimaryKeyHash | null
    readonly shardId: string
    readonly entityType: string
    readonly entityId: string
    readonly requestId: MessageKey
    readonly replyId: ReplyKey
    readonly deliverAtMs: number | null
  }
  readonly wf_insert_interrupt: {
    readonly messageKey: MessageKey
    readonly seqKey: SeqKey
    readonly primaryKeyHash: PrimaryKeyHash | null
    readonly shardId: string
    readonly entityType: string
    readonly entityId: string
    readonly requestId: MessageKey
    readonly deliverAtMs: number | null
  }
  readonly wf_save_reply_exit: {
    readonly replyKey: ReplyKey
    readonly seqKey: SeqKey
    readonly requestId: MessageKey
    readonly payload: string
  }
  readonly wf_save_reply_chunk: {
    readonly replyKey: ReplyKey
    readonly seqKey: SeqKey
    readonly requestId: MessageKey
    readonly payload: string
    readonly sequence: number
  }
  readonly wf_clear_replies_unconditional_delete: { readonly requestId: MessageKey }
  readonly wf_clear_replies_cas_delete: { readonly requestId: MessageKey }
  readonly wf_reset_message_for_clear: {
    readonly requestId: MessageKey
    readonly clearReplyId: ReplyKey | null
    readonly clearReadMs: number | null
  }
  readonly wf_reset_message_for_clear_cas: {
    readonly requestId: MessageKey
    readonly expectedReplyId: ReplyKey
    readonly clearReplyId: ReplyKey | null
    readonly clearReadMs: number | null
  }
  readonly wf_dangling_processed_requests: EmptyWorkflowGqParams
  readonly wf_repair_dangling_requests: {
    readonly messageKeys: ReadonlyArray<MessageKey>
    readonly clearReplyId: ReplyKey | null
    readonly clearReadMs: number | null
  }
  readonly wf_replies_for: { readonly requestIds: ReadonlyArray<MessageKey> }
  readonly wf_replies_for_unfiltered: { readonly requestIds: ReadonlyArray<MessageKey> }
  readonly wf_unprocessed_candidate_messages: {
    readonly shardIds: ReadonlyArray<string>
    readonly claimCutoffMs: number
    readonly nowMs: number
  }
  readonly wf_unprocessed_candidate_messages_for_addresses: {
    readonly shardIds: ReadonlyArray<string>
    readonly entityType: string
    readonly entityIds: ReadonlyArray<string>
    readonly claimCutoffMs: number
    readonly nowMs: number
  }
  readonly wf_claim_messages: {
    readonly messageKeys: ReadonlyArray<MessageKey>
    readonly nowMs: number
  }
  readonly wf_unprocessed_messages_by_id: {
    readonly messageKeys: ReadonlyArray<MessageKey>
    readonly nowMs: number
  }
  readonly wf_reset_requests: {
    readonly messageKeys: ReadonlyArray<MessageKey>
    readonly clearReadMs: number | null
  }
  readonly wf_reset_address: {
    readonly shardId: string
    readonly entityType: string
    readonly entityId: string
    readonly clearReadMs: number | null
  }
  readonly wf_reset_address_group: {
    readonly shardId: string
    readonly entityType: string
    readonly entityIds: ReadonlyArray<string>
    readonly clearReadMs: number | null
  }
  readonly wf_reset_shards: {
    readonly shardIds: ReadonlyArray<string>
    readonly clearReadMs: number | null
  }
  readonly wf_message_keys_for_address: {
    readonly entityType: string
    readonly entityId: string
  }
  readonly wf_clear_address: {
    readonly requestIds: ReadonlyArray<MessageKey>
    readonly entityType: string
    readonly entityId: string
  }
  readonly wf_count_all: EmptyWorkflowGqParams
  readonly wf_count_replies: EmptyWorkflowGqParams
  readonly wf_all_entities: { readonly afterSeqKey: SeqKey | "" }
  readonly wf_all_replies: { readonly afterSeqKey: SeqKey | "" }
  readonly wf_orphan_entity_messages: { readonly knownEntityTypes: ReadonlyArray<string> }
  readonly wf_quarantine_orphan_messages: { readonly messageKeys: ReadonlyArray<MessageKey> }
  readonly wf_get_writer_lease: { readonly name: string }
  readonly wf_insert_writer_lease: {
    readonly name: string
    readonly owner: string
    readonly leaseEpoch: LeaseEpoch
    readonly heartbeatMs: number
  }
  readonly wf_cas_writer_lease: {
    readonly name: string
    readonly expectedEpoch: LeaseEpoch
    readonly owner: string
    readonly nextEpoch: LeaseEpoch
    readonly heartbeatMs: number
  }
  readonly wf_refresh_writer_lease: {
    readonly name: string
    readonly owner: string
    readonly expectedEpoch: LeaseEpoch
    readonly heartbeatMs: number
  }
  readonly wf_get_run: { readonly runId: WorkflowRunId }
  readonly wf_list_runs: EmptyWorkflowGqParams
  readonly wf_insert_run: {
    readonly runId: WorkflowRunId
    readonly executionId: WorkflowExecutionId
    readonly level: WorkflowLevel
    readonly planSha: PlanSha256
    readonly baseSha: GitCommitSha
    readonly state: WorkflowRunState
    readonly planJson: PlanJsonPayload | null
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_update_run: {
    readonly runId: WorkflowRunId
    readonly state: WorkflowRunState
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_units_for_run: { readonly runId: WorkflowRunId }
  readonly wf_get_unit: { readonly unitKey: WorkflowUnitKey }
  readonly wf_insert_unit: {
    readonly unitKey: WorkflowUnitKey
    readonly runId: WorkflowRunId
    readonly unitId: WorkUnitId
    readonly kind: WorkflowUnitKind
    readonly waveIndex: WaveIndex
    readonly status: WorkflowUnitStatus
    readonly ownedRelPaths: ReadonlyArray<OwnedRelPath>
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_update_unit: {
    readonly unitKey: WorkflowUnitKey
    readonly status: WorkflowUnitStatus
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_attempts_for_run: { readonly runId: WorkflowRunId }
  readonly wf_get_attempt: { readonly attemptKey: WorkflowAttemptKey }
  readonly wf_insert_attempt: {
    readonly attemptKey: WorkflowAttemptKey
    readonly runId: WorkflowRunId
    readonly unitId: WorkUnitId
    readonly attempt: AttemptNumber
    readonly verdict: WorkflowAttemptVerdict
    readonly runner: RunnerId | null
    readonly rejection: RejectionJsonPayload | null
    readonly packageStampHash: PackageStampHash | null
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_update_attempt: {
    readonly attemptKey: WorkflowAttemptKey
    readonly verdict: WorkflowAttemptVerdict
    readonly runner: RunnerId | null
    readonly rejection: RejectionJsonPayload | null
    readonly packageStampHash: PackageStampHash | null
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_ship_attempts_for_run: { readonly runId: WorkflowRunId }
  readonly wf_get_ship_attempt: { readonly shipKey: ShipAttemptKey }
  readonly wf_insert_ship_attempt: {
    readonly shipKey: ShipAttemptKey
    readonly runId: WorkflowRunId
    readonly attempt: ShipAttempt
    readonly treeHash: WorkspaceTreeHash
    readonly status: ShipAttemptStatus
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_update_ship_attempt: {
    readonly shipKey: ShipAttemptKey
    readonly status: ShipAttemptStatus
    readonly updatedMs: WorkflowTimestampMs
  }
  readonly wf_delete_run_views: { readonly runId: WorkflowRunId }
  readonly wf_probe_runs: EmptyWorkflowGqParams
}

export class WriterLeaseHeldError extends Schema.TaggedError<WriterLeaseHeldError>()(
  "WriterLeaseHeldError",
  {
    holderId: LeaseHolderId,
    leaseEpoch: Schema.optional(LeaseEpoch),
    lockFilePath: LeaseFilePath,
    holderPid: Schema.optional(LeaseHolderPid),
  },
) {
  override get message(): string {
    const epochPart = this.leaseEpoch !== undefined ? `epoch ${this.leaseEpoch}` : "epoch unknown"
    const pidPart = this.holderPid !== undefined ? `, pid ${this.holderPid}` : ""
    return `Workflow writer lease held by ${this.holderId} (${epochPart}${pidPart}) at ${this.lockFilePath}`
  }
}

export class DaemonProtocolMismatchError extends Schema.TaggedError<DaemonProtocolMismatchError>()(
  "DaemonProtocolMismatchError",
  {
    expectedVersion: WorkflowProtocolVersion,
    actualVersion: Schema.optional(WorkflowProtocolVersion),
    socketPath: DaemonSocketPath,
    detail: DaemonProtocolMismatchDetail,
  },
) {
  override get message(): string {
    const actualPart =
      this.actualVersion !== undefined ? `v${this.actualVersion}` : "unsupported/missing"
    return `Daemon protocol mismatch at ${this.socketPath}: expected v${this.expectedVersion}, got ${actualPart} (${this.detail})`
  }
}

export class WorkflowStoreUnavailableError extends Schema.TaggedError<WorkflowStoreUnavailableError>()(
  "WorkflowStoreUnavailableError",
  {
    operation: WorkflowStoreOperation,
    reason: WorkflowStoreFailureReason,
  },
) {
  override get message(): string {
    return `Workflow store unavailable during ${this.operation}: ${this.reason}`
  }
}
