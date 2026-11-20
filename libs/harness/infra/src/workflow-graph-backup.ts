import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type BackupDirPath,
  BackupFileHash,
  toBoundedReason,
  toErrorReasonMessage,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupMode,
  WorkflowBackupReceiptFields,
  type WorkflowBackupSummary,
  WorkflowBackupTimestampMs,
  type WorkflowRestoreRequest,
  type WorkflowRestoreSummary,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import { WorkflowGraphBackup, type WorkflowGraphBackupShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  invokeWorkflowStoreQuery,
  parseFiniteNumberOrString,
  resolveWorkflowClientForStore,
  retryWorkflowStoreAttempt,
  toWorkflowStoreUnavailableError,
  type WorkflowStoreAttemptFailure,
  withWorkflowHttpPermit,
} from "./omnigraph-workflow-store.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** HTTP timeout (ms) enforced on backup export/load operations via `AbortSignal.timeout`. */
export const WORKFLOW_BACKUP_HTTP_TIMEOUT_MS = 30_000

export const WorkflowBackupArtifactMetadata = Schema.Struct({
  ...WorkflowBackupReceiptFields,
  mode: WorkflowBackupMode,
  entityCount: WorkflowBackupCount,
})
export type WorkflowBackupArtifactMetadata = typeof WorkflowBackupArtifactMetadata.Type

export interface WorkflowGraphBackupOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly client?: Omnigraph | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
}

const ExportNodeRecordSchema = Schema.Struct({
  type: Schema.NonEmptyString,
  id: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})

const ExportEdgeRecordSchema = Schema.Struct({
  edge: Schema.NonEmptyString,
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})

export const ExportRecordSchema = Schema.Union([ExportNodeRecordSchema, ExportEdgeRecordSchema])
export type ParsedExportRecord = typeof ExportRecordSchema.Type

const isExtendedHostIo = (hostIo: SyncHostIo): hostIo is ExtendedHostIo =>
  "chmodSync" in hostIo &&
  typeof hostIo.chmodSync === "function" &&
  "writeTextWithModeSync" in hostIo &&
  typeof hostIo.writeTextWithModeSync === "function"

const toWorkspaceFsError = (
  filePath: string,
  operation: "read" | "write",
  cause: unknown,
): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-backup-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(cause, `Workflow backup ${operation} failed`),
  })
}

const deriveRepoRootForBackup = (
  backupDirOrFile: string,
  explicitRepoRoot: AbsoluteRepoRoot | undefined,
  hostIo: SyncHostIo,
): AbsoluteRepoRoot => {
  if (explicitRepoRoot !== undefined) {
    return explicitRepoRoot
  }
  let current = resolve(backupDirOrFile)
  for (let i = 0; i < 6; i += 1) {
    if (hostIo.existsSync(join(current, ".git"))) {
      const matched = match(Schema.decodeOption(AbsoluteRepoRoot)(current))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (matched !== undefined) {
        return matched
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return match(Schema.decodeOption(AbsoluteRepoRoot)(resolve(process.cwd())))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => AbsoluteRepoRoot.make("/tmp"))
    .exhaustive()
}

const compareStringsLex = (a: string, b: string): number => {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => compareStringsLex(a, b))
    const out: Record<string, unknown> = {}
    for (const [key, val] of entries) {
      if (val !== undefined) {
        out[key] = canonicalizeJsonValue(val)
      }
    }
    return out
  }
  return value
}

const compareExportRecords = (a: ParsedExportRecord, b: ParsedExportRecord): number => {
  const aIsEdge = "edge" in a ? 1 : 0
  const bIsEdge = "edge" in b ? 1 : 0
  if (aIsEdge !== bIsEdge) {
    return aIsEdge - bIsEdge
  }
  const aType = "edge" in a ? a.edge : a.type
  const bType = "edge" in b ? b.edge : b.type
  if (aType !== bType) {
    return compareStringsLex(aType, bType)
  }
  return compareStringsLex(a.id, b.id)
}

const serializeExportRecordDeterministic = (record: ParsedExportRecord): string => {
  if ("edge" in record) {
    return JSON.stringify({
      edge: record.edge,
      id: record.id,
      from: record.from,
      to: record.to,
      data: canonicalizeJsonValue(record.data),
    })
  }
  return JSON.stringify({
    type: record.type,
    id: record.id,
    data: canonicalizeJsonValue(record.data),
  })
}

const computeSha256Hex = (content: string): BackupFileHash =>
  BackupFileHash.make(createHash("sha256").update(content, "utf8").digest("hex"))

/**
 * Validates every non-empty line in an Omnigraph NDJSON export against `ExportRecordSchema`,
 * ensuring zero unparsed lines and exact record-count parity.
 */
const parseAndValidateExportNdjson = (
  rawContent: string,
  filePath: string,
): Result.Result<ReadonlyArray<ParsedExportRecord>, WorkspaceFsError> => {
  const lines = rawContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const recordDecoder = Schema.decodeResult(Schema.fromJsonString(ExportRecordSchema))
  const parsedRecords: Array<ParsedExportRecord> = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    const decoded = recordDecoder(line)
    let lineError: WorkspaceFsError | undefined
    match(decoded)
      .with({ _tag: "Failure" }, ({ failure }) => {
        lineError = toWorkspaceFsError(
          filePath,
          "read",
          new Error(`Corrupt backup NDJSON at line ${i + 1}: ${toErrorReasonMessage(failure)}`),
        )
      })
      .with({ _tag: "Success" }, ({ success }) => {
        parsedRecords.push(success)
      })
      .exhaustive()
    if (lineError !== undefined) {
      return Result.fail(lineError)
    }
  }
  if (parsedRecords.length !== lines.length) {
    return Result.fail(
      toWorkspaceFsError(
        filePath,
        "read",
        new Error(
          `Backup NDJSON record count mismatch: parsed ${parsedRecords.length} of ${lines.length} lines`,
        ),
      ),
    )
  }
  return Result.succeed(parsedRecords)
}

const prepareSecureDir = (dirPath: string, hostIo: SyncHostIo): Result.Result<void, string> => {
  if (hostIo.isSymbolicLinkSync(dirPath)) {
    return Result.fail(`Refusing symlink backup directory: ${dirPath}`)
  }
  return Result.try({
    try: () => {
      hostIo.mkdirRecursiveSync(dirPath, 0o700)
      if (isExtendedHostIo(hostIo)) {
        hostIo.chmodSync(dirPath, 0o700)
      }
    },
    catch: (err) => toErrorReasonMessage(err, `Failed to prepare backup dir ${dirPath}`),
  })
}

const writeSecureBackupAndVerifySha = (
  backupDir: string,
  targetFilePath: string,
  tmpFilePath: string,
  content: string,
  expectedSha256: BackupFileHash,
  hostIo: SyncHostIo,
): Result.Result<void, string> =>
  match(prepareSecureDir(backupDir, hostIo))
    .with({ _tag: "Failure" }, (err) => err)
    .with({ _tag: "Success" }, () => {
      if (hostIo.isSymbolicLinkSync(targetFilePath)) {
        return Result.fail(`Refusing symlink backup file target: ${targetFilePath}`)
      }
      return Result.try({
        try: () => {
          if (isExtendedHostIo(hostIo)) {
            hostIo.writeTextWithModeSync(tmpFilePath, content, 0o600)
            hostIo.renameSync(tmpFilePath, targetFilePath)
            hostIo.chmodSync(targetFilePath, 0o600)
          } else {
            hostIo.writeTextSync(tmpFilePath, content)
            hostIo.renameSync(tmpFilePath, targetFilePath)
          }
          return hostIo.readTextSync(targetFilePath)
        },
        catch: (err) => toErrorReasonMessage(err, `Failed to write ${targetFilePath}`),
      }).pipe(
        Result.flatMap((persisted) => {
          const actualSha256 = computeSha256Hex(persisted)
          return actualSha256 === expectedSha256
            ? Result.void
            : Result.fail(
                `Backup read-back SHA-256 mismatch for ${targetFilePath}: expected ${expectedSha256}, actual ${actualSha256}`,
              )
        }),
      )
    })
    .exhaustive()

const annotatePostLoadVerificationError = (
  backupFile: WorkflowBackupFilePath,
  err: WorkspaceFsError | WorkflowStoreUnavailableError,
): WorkspaceFsError | WorkflowStoreUnavailableError => {
  const prefix =
    "Post-restore verification failed after og.load already ran (target graph may be in a partial-restore state)"
  return match(err)
    .with(
      { _tag: "WorkspaceFsError" },
      (fsErr) =>
        new WorkspaceFsError({
          filePath: fsErr.filePath,
          operation: fsErr.operation,
          reason: toErrorReasonMessage(`${prefix}: ${fsErr.reason}`, `${prefix} for ${backupFile}`),
        }),
    )
    .with(
      { _tag: "WorkflowStoreUnavailableError" },
      (storeErr) =>
        new WorkflowStoreUnavailableError({
          operation: storeErr.operation,
          reason: toBoundedReason(`${prefix}: ${storeErr.reason}`, prefix),
        }),
    )
    .exhaustive()
}

/**
 * Exports all `harness-workflows` entities on branch `main` to a timestamped
 * NDJSON backup file inside `backupDir` (`0o700` dir / `0o600` file) with read-back
 * SHA-256 verification before cluster kill.
 */
export const exportWorkflowGraphBackup = Effect.fn("WorkflowGraphBackup.exportBackup")(function* (
  backupDir: BackupDirPath,
  options?: WorkflowGraphBackupOptions,
): Effect.fn.Return<WorkflowBackupSummary, WorkflowStoreUnavailableError | WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const repoRoot = deriveRepoRootForBackup(backupDir, options?.repoRoot, hostIo)
  const timestampMsNum = Math.max(0, Math.floor((options?.nowMs ?? (() => Date.now()))()))
  const timestampMs = WorkflowBackupTimestampMs.make(timestampMsNum)
  const operation = WorkflowStoreOperation.make("WorkflowGraphBackup.exportBackup")

  const rawRecords = yield* retryWorkflowStoreAttempt({
    operation,
    retryConflicts: false,
    runAttempt: () =>
      withWorkflowHttpPermit(
        Effect.acquireUseRelease(
          Effect.sync(() => new AbortController()),
          (controller) => {
            const og = resolveWorkflowClientForStore({
              repoRoot,
              client: options?.client,
              hostIo,
              env: options?.env,
            })
            return Stream.fromAsyncIterable(
              og.export(
                { branch: "main" },
                {
                  signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(WORKFLOW_BACKUP_HTTP_TIMEOUT_MS),
                  ]),
                },
              ),
              (cause): WorkflowStoreAttemptFailure => ({
                _tag: "WorkflowStoreAttemptFailure",
                operation,
                cause,
              }),
            ).pipe(Stream.runCollect)
          },
          (controller) =>
            Effect.sync(() => {
              controller.abort()
            }),
        ),
      ),
  }).pipe(
    Effect.mapError((err) =>
      match(err)
        .with({ _tag: "WriterLeaseHeldError" }, (held) =>
          toWorkflowStoreUnavailableError(operation, held),
        )
        .with({ _tag: "WorkflowStoreUnavailableError" }, (unavail) => unavail)
        .exhaustive(),
    ),
  )

  const decodedRecords: Array<ParsedExportRecord> = []
  for (let i = 0; i < rawRecords.length; i += 1) {
    const validated = yield* match(Schema.decodeUnknownOption(ExportRecordSchema)(rawRecords[i]))
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.fail(
          toWorkspaceFsError(
            backupDir,
            "write",
            new Error(`Exported record #${i} failed ExportRecord schema validation`),
          ),
        ),
      )
      .exhaustive()
    decodedRecords.push(validated)
  }

  decodedRecords.sort(compareExportRecords)
  const ndjsonContent =
    decodedRecords.length === 0
      ? ""
      : `${decodedRecords.map(serializeExportRecordDeterministic).join("\n")}\n`

  const sha256 = computeSha256Hex(ndjsonContent)
  const entityCount = WorkflowBackupCount.make(decodedRecords.length)
  const targetFilePath = WorkflowBackupFilePath.make(
    join(backupDir, `workflow-backup-${timestampMsNum}-${sha256.slice(0, 12)}.ndjson`),
  )
  const tmpFilePath = `${targetFilePath}.${process.pid}.${randomUUID()}.tmp`

  yield* match(
    writeSecureBackupAndVerifySha(
      backupDir,
      targetFilePath,
      tmpFilePath,
      ndjsonContent,
      sha256,
      hostIo,
    ),
  )
    .with({ _tag: "Success" }, () => Effect.void)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(toWorkspaceFsError(targetFilePath, "write", failure)),
    )
    .exhaustive()
    .pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (hostIo.existsSync(tmpFilePath)) {
            const unlinkRes = Result.try({
              try: () => {
                hostIo.unlinkSync(tmpFilePath)
              },
              catch: (err) => toErrorReasonMessage(err, `Failed to unlink ${tmpFilePath}`),
            })
            yield* match(unlinkRes)
              .with({ _tag: "Success" }, () => Effect.void)
              .with({ _tag: "Failure" }, ({ failure }) =>
                Effect.logWarning(`Failed to unlink temporary backup ${tmpFilePath}: ${failure}`),
              )
              .exhaustive()
          }
        }),
      ),
    )

  return {
    backupFile: targetFilePath,
    entityCount,
    timestampMs,
    sha256,
  }
})

/**
 * Restores a verified `harness-workflows` NDJSON backup onto protected branch `main`
 * via `og.load({ mode: request.mode })`, refusing empty `mode: "replace"` restores,
 * validating `expectedSha256` on the single read buffer before calling `og.load`, and
 * verifying both `WfMessage` (`wf_count_all`) and `WfReply` (`wf_count_replies`) counts
 * post-restore with explicit partial-restore error annotation if post-load checks fail.
 */
export const restoreWorkflowGraphBackup = Effect.fn("WorkflowGraphBackup.restoreBackup")(function* (
  request: WorkflowRestoreRequest,
  options?: WorkflowGraphBackupOptions,
): Effect.fn.Return<WorkflowRestoreSummary, WorkflowStoreUnavailableError | WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const repoRoot = deriveRepoRootForBackup(request.backupFile, options?.repoRoot, hostIo)
  const timestampMs = WorkflowBackupTimestampMs.make(
    Math.max(0, Math.floor((options?.nowMs ?? (() => Date.now()))())),
  )
  const operation = WorkflowStoreOperation.make("WorkflowGraphBackup.restoreBackup")

  if (hostIo.isSymbolicLinkSync(request.backupFile)) {
    return yield* toWorkspaceFsError(
      request.backupFile,
      "read",
      `Refusing symlink backup file: ${request.backupFile}`,
    )
  }

  const rawContent = yield* Effect.try({
    try: () => hostIo.readTextSync(request.backupFile),
    catch: (err) => toWorkspaceFsError(request.backupFile, "read", err),
  })

  const sha256 = computeSha256Hex(rawContent)
  if (request.expectedSha256 !== undefined && sha256 !== request.expectedSha256) {
    return yield* toWorkspaceFsError(
      request.backupFile,
      "read",
      new Error(
        `Backup SHA-256 mismatch before restore: expected ${request.expectedSha256}, actual ${sha256}`,
      ),
    )
  }

  const parsedRecords = yield* match(parseAndValidateExportNdjson(rawContent, request.backupFile))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
    .exhaustive()

  const expectedTotalEntities = parsedRecords.length
  const expectedWfMessageCount = parsedRecords.filter(
    (rec) => "type" in rec && rec.type === "WfMessage",
  ).length
  const expectedWfReplyCount = parsedRecords.filter(
    (rec) => "type" in rec && rec.type === "WfReply",
  ).length

  if (request.mode === "replace" && expectedTotalEntities === 0) {
    return yield* toWorkspaceFsError(
      request.backupFile,
      "read",
      new Error("Refusing destructive mode='replace' restore from an empty (0-entity) backup"),
    )
  }

  const omnigraphMode = match(request.mode)
    .with("merge", () => "merge" as const)
    .with("replace", () => "overwrite" as const)
    .exhaustive()

  const verifyPostRestoreCounts = Effect.gen(function* () {
    const messageCountRows = yield* invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("WorkflowGraphBackup.verifyMessages"),
      queryName: "wf_count_all",
      params: {},
      expectMutation: false,
      client: options?.client,
      hostIo,
      env: options?.env,
    })

    const replyCountRows = yield* invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("WorkflowGraphBackup.verifyReplies"),
      queryName: "wf_count_replies",
      params: {},
      expectMutation: false,
      client: options?.client,
      hostIo,
      env: options?.env,
    })

    const rawMessages = messageCountRows[0]?.totalMessages
    const rawReplies = replyCountRows[0]?.totalReplies
    const actualWfMessages = parseFiniteNumberOrString(rawMessages) ?? Number.NaN
    const actualWfReplies = parseFiniteNumberOrString(rawReplies) ?? Number.NaN

    const messagesValid = match(request.mode)
      .with("replace", () => actualWfMessages === expectedWfMessageCount)
      .with(
        "merge",
        () => Number.isFinite(actualWfMessages) && actualWfMessages >= expectedWfMessageCount,
      )
      .exhaustive()

    const repliesValid = match(request.mode)
      .with("replace", () => actualWfReplies === expectedWfReplyCount)
      .with(
        "merge",
        () => Number.isFinite(actualWfReplies) && actualWfReplies >= expectedWfReplyCount,
      )
      .exhaustive()

    if (!messagesValid || !repliesValid) {
      return yield* toWorkspaceFsError(
        request.backupFile,
        "read",
        new Error(
          `Post-restore count verification failed (mode=${request.mode}, expectedMessages=${expectedWfMessageCount}, actualMessages=${String(rawMessages)}, expectedReplies=${expectedWfReplyCount}, actualReplies=${String(rawReplies)})`,
        ),
      )
    }
  })

  if (expectedTotalEntities > 0) {
    const loadResult = yield* retryWorkflowStoreAttempt({
      operation,
      retryConflicts: false,
      runAttempt: () =>
        withWorkflowHttpPermit(
          Effect.tryPromise({
            try: (fiberSignal) => {
              const og = resolveWorkflowClientForStore({
                repoRoot,
                client: options?.client,
                hostIo,
                env: options?.env,
              })
              return og.load(
                {
                  branch: "main",
                  mode: omnigraphMode,
                  data: rawContent,
                },
                {
                  signal: AbortSignal.any([
                    fiberSignal,
                    AbortSignal.timeout(WORKFLOW_BACKUP_HTTP_TIMEOUT_MS),
                  ]),
                },
              )
            },
            catch: (cause): WorkflowStoreAttemptFailure => ({
              _tag: "WorkflowStoreAttemptFailure",
              operation,
              cause,
            }),
          }),
        ),
    }).pipe(
      Effect.mapError((err) =>
        match(err)
          .with({ _tag: "WriterLeaseHeldError" }, (held) =>
            toWorkflowStoreUnavailableError(operation, held),
          )
          .with({ _tag: "WorkflowStoreUnavailableError" }, (unavail) => unavail)
          .exhaustive(),
      ),
    )

    yield* Effect.gen(function* () {
      if (loadResult.totalEntities !== expectedTotalEntities) {
        return yield* toWorkspaceFsError(
          request.backupFile,
          "read",
          new Error(
            `Backup restore entity count mismatch: loaded ${loadResult.totalEntities}, expected ${expectedTotalEntities}`,
          ),
        )
      }
      yield* verifyPostRestoreCounts
    }).pipe(Effect.mapError((err) => annotatePostLoadVerificationError(request.backupFile, err)))
  } else {
    yield* verifyPostRestoreCounts
  }

  return {
    backupFile: request.backupFile,
    mode: request.mode,
    restoredEntityCount: WorkflowBackupCount.make(expectedTotalEntities),
    timestampMs,
    sha256,
  }
})

/**
 * Constructs a `WorkflowGraphBackup` service layer bound to optional repo/host/client overrides.
 */
const makeWorkflowGraphBackupLayer = (
  options?: WorkflowGraphBackupOptions,
): Layer.Layer<WorkflowGraphBackup> =>
  Layer.succeed(WorkflowGraphBackup, {
    exportBackup: (backupDir) => exportWorkflowGraphBackup(backupDir, options),
    restoreBackup: (request) => restoreWorkflowGraphBackup(request, options),
  } satisfies WorkflowGraphBackupShape)

/**
 * Live `WorkflowGraphBackup` layer backed by Omnigraph export/load and atomic file I/O.
 */
export const WorkflowGraphBackupLive: Layer.Layer<WorkflowGraphBackup> =
  makeWorkflowGraphBackupLayer()

export {
  computeSha256Hex,
  makeWorkflowGraphBackupLayer,
  parseAndValidateExportNdjson,
  writeSecureBackupAndVerifySha,
}
