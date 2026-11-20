import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type BackupDirPath,
  type BackupFileHash,
  toBoundedReason,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  type WorkflowBackupMode,
  type WorkflowBackupSummary,
  WorkflowBackupTimestampMs,
  type WorkflowRestoreRequest,
  type WorkflowRestoreSummary,
  type WorkflowStoreUnavailableError,
  type WorkspaceFsError,
} from "@harness/contract"
import { makeWorkflowGraphBackupLayer, nodeSyncHostIo } from "@harness/infra"
import { WorkflowGraphBackup } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"
import { isValidLockId, probeOmnigraphServerReady } from "./omnigraph-safety-helpers.js"
import {
  clearPendingWorkflowRestoreJournal,
  computeSha256Hex,
  decodeAbsClusterRepoRoot,
  makeWorkflowClientForCluster,
  type PendingRestoreJournalRead,
  readClusterConfigStampDigest,
  readPendingWorkflowRestoreJournal,
  type ReadPendingWorkflowRestoreJournalOptions,
  resolveWorkflowBackupDir,
  verifyWorkflowGraphEmptyBeforeNonRebuildRestore,
  withClusterDaemonLockIfGit,
  type WorkflowBeforeRebuildResult,
  writePendingWorkflowRestoreJournal,
  writeSecureBackupFileAtomic,
} from "./omnigraph-workflow-journal.js"

export {
  clearPendingWorkflowRestoreJournal,
  computeSha256Hex,
  type PendingRestoreJournalRead,
  readClusterConfigStampDigest,
  readPendingWorkflowRestoreJournal,
  type ReadPendingWorkflowRestoreJournalOptions,
  resolveWorkflowBackupDir,
  verifyWorkflowGraphEmptyBeforeNonRebuildRestore,
  withClusterDaemonLockIfGit,
  type WorkflowBeforeRebuildResult,
  writePendingWorkflowRestoreJournal,
}

export interface WorkflowRebuildBackupArtifact {
  readonly mode: WorkflowBackupMode
  readonly sha256: BackupFileHash
}

const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

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

const ExportRecordLineSchema = Schema.fromJsonString(
  Schema.Union([ExportNodeRecordSchema, ExportEdgeRecordSchema]),
)

export const matchExecSyncStdout = (
  label: string,
  res: ReturnType<SyncHostIo["execFileSync"]>,
  allowExitCode1 = false,
): string | undefined =>
  match(res)
    .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
      if (exitCode !== 0 && !(allowExitCode1 && exitCode === 1)) {
        process.stderr.write(
          `[harness:omnigraph] ${label} (exitCode=${exitCode}): ${stderr || stdout || "unknown error"}\n`,
        )
        return undefined
      }
      return stdout
    })
    .with({ _tag: "TimedOut" }, ({ stderr }) => {
      process.stderr.write(`[harness:omnigraph] ${label} timed out: ${stderr}\n`)
      return undefined
    })
    .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
      process.stderr.write(`[harness:omnigraph] ${label} killed by ${signal}: ${stderr}\n`)
      return undefined
    })
    .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
      process.stderr.write(`[harness:omnigraph] ${label} spawn failed: ${spawnError}\n`)
      return undefined
    })
    .exhaustive()

export interface UnlockClusterResult {
  readonly ok: boolean
  readonly reason?: string | undefined
}

export function unlockOmnigraphClusterIfNeeded(
  omnigraphBin: string,
  clusterRootDir: string,
  applyOutput?: string,
): UnlockClusterResult {
  const lockIds = new Set<string>()
  if (applyOutput) {
    const lockMatch = applyOutput.match(/Admission lock:\s*([A-Za-z0-9._-]+)/)
    if (lockMatch?.[1] && isValidLockId(lockMatch[1])) {
      lockIds.add(lockMatch[1])
    }
  }
  const lockPath = join(clusterRootDir, "__cluster", "lock.json")
  if (nodeSyncHostIo.existsSync(lockPath)) {
    const readRes = Result.try(() => nodeSyncHostIo.readTextSync(lockPath))
    const rawLock = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => {
        const reason = toBoundedReason(failure, `Failed to read ${lockPath}`)
        process.stderr.write(`[harness:omnigraph] ${reason}\n`)
        return undefined
      })
      .exhaustive()
    if (rawLock === undefined) {
      return { ok: false, reason: "failed-to-read-lock-json" }
    }
    const parsedOpt = Schema.decodeOption(LockJsonSchema)(rawLock)
    const decodedOk = match(parsedOpt)
      .with({ _tag: "Some" }, ({ value }) => {
        for (const key of ["lock_id", "id", "lockId"]) {
          const val = value[key]
          if (typeof val === "string" && val.length > 0) {
            if (isValidLockId(val)) {
              lockIds.add(val)
            } else {
              process.stderr.write(
                `[harness:omnigraph] Ignoring invalid lock.json ${key}: ${val}\n`,
              )
            }
          }
        }
        return true
      })
      .with({ _tag: "None" }, () => {
        process.stderr.write(`[harness:omnigraph] Error: failed to decode ${lockPath} as JSON\n`)
        return false
      })
      .exhaustive()
    if (!decodedOk) {
      return { ok: false, reason: "invalid-lock-json" }
    }
  }
  for (const lockId of lockIds) {
    const execTry = Result.try(() =>
      nodeSyncHostIo.execFileSync(
        omnigraphBin,
        ["cluster", "force-unlock", lockId, "--target", `file://${clusterRootDir}`],
        { timeoutMs: 5_000 },
      ),
    )
    const unlockOk = match(execTry)
      .with({ _tag: "Failure" }, ({ failure }) => {
        process.stderr.write(
          `[harness:omnigraph] force-unlock threw for ${lockId}: ${toBoundedReason(failure)}\n`,
        )
        return false
      })
      .with(
        { _tag: "Success" },
        ({ success: res }) =>
          matchExecSyncStdout(`force-unlock failed for ${lockId}`, res) !== undefined,
      )
      .exhaustive()
    if (!unlockOk) {
      return { ok: false, reason: `force-unlock-failed:${lockId}` }
    }
  }
  return { ok: true }
}

/**
 * Exports and verifies `harness-workflows` before `killOmnigraphServerPidIfAlive`
 * during a cluster `RequiresCleanRebuild`. Fails closed if export fails.
 */
export const beforeRebuildWorkflowBackup = Effect.fn("OmnigraphWorkflowBackup.beforeRebuild")(
  function* (
    backupDir: BackupDirPath,
  ): Effect.fn.Return<
    WorkflowBackupSummary,
    WorkflowStoreUnavailableError | WorkspaceFsError,
    WorkflowGraphBackup
  > {
    const backup = yield* WorkflowGraphBackup
    return yield* backup.exportBackup(backupDir)
  },
)

/**
 * Restores the pre-rebuild `harness-workflows` NDJSON backup onto protected branch `main`
 * immediately after `omnigraph cluster apply` succeeds.
 */
export const afterRebuildWorkflowBackup = Effect.fn("OmnigraphWorkflowBackup.afterRebuild")(
  function* (
    request: WorkflowRestoreRequest,
  ): Effect.fn.Return<
    WorkflowRestoreSummary,
    WorkflowStoreUnavailableError | WorkspaceFsError,
    WorkflowGraphBackup
  > {
    const backup = yield* WorkflowGraphBackup
    return yield* backup.restoreBackup(request)
  },
)

const runOfflineWorkflowBackupExport = (options: {
  readonly omnigraphBin: string
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly backupDir: BackupDirPath
}): WorkflowBeforeRebuildResult => {
  if (!nodeSyncHostIo.existsSync(options.omnigraphBin)) {
    const reason = toBoundedReason(
      `Missing omnigraph binary (${options.omnigraphBin}) for offline harness-workflows backup`,
    )
    process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
    return { _tag: "Failed", reason }
  }
  const preUnlock = unlockOmnigraphClusterIfNeeded(options.omnigraphBin, options.clusterRootDir)
  if (!preUnlock.ok) {
    const reason = toBoundedReason(
      `Failed to unlock cluster before offline workflow backup: ${preUnlock.reason ?? "unknown"}`,
    )
    process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
    return { _tag: "Failed", reason }
  }
  const execAttempt = Result.try(() =>
    nodeSyncHostIo.execFileSync(
      options.omnigraphBin,
      [
        "export",
        "--graph",
        "harness-workflows",
        "--branch",
        "main",
        "--target",
        `file://${options.clusterRootDir}`,
      ],
      { cwd: options.clusterRepoRoot, timeoutMs: 30_000, maxBufferBytes: 64 * 1024 * 1024 },
    ),
  )
  const rawStdout = match(execAttempt)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:omnigraph] Error: offline harness-workflows export threw: ${toBoundedReason(failure)}\n`,
      )
      return undefined
    })
    .with({ _tag: "Success" }, ({ success: res }) =>
      matchExecSyncStdout("Offline harness-workflows export failed", res),
    )
    .exhaustive()
  if (rawStdout === undefined) {
    return { _tag: "Failed", reason: toBoundedReason("offline-export-failed") }
  }

  const lines = rawStdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? ""
    const validLine = match(Schema.decodeOption(ExportRecordLineSchema)(line))
      .with({ _tag: "Some" }, () => true)
      .with({ _tag: "None" }, () => false)
      .exhaustive()
    if (!validLine) {
      const reason = toBoundedReason(
        `Offline workflow backup NDJSON validation failed at line ${idx + 1}`,
      )
      process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
      return { _tag: "Failed", reason }
    }
  }

  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`
  const sha256 = computeSha256Hex(content)
  const timestampMs = WorkflowBackupTimestampMs.make(Math.max(0, Math.floor(Date.now())))
  const backupFile = WorkflowBackupFilePath.make(
    join(options.backupDir, `workflow-backup-${timestampMs}-${sha256.slice(0, 12)}.ndjson`),
  )
  return match(writeSecureBackupFileAtomic(options.backupDir, backupFile, content, sha256))
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(`[harness:omnigraph] Error: ${failure}\n`)
      return { _tag: "Failed" as const, reason: failure }
    })
    .with({ _tag: "Success" }, () => ({
      _tag: "BackedUp" as const,
      backupFile,
      timestampMs,
      sha256,
      entityCount: WorkflowBackupCount.make(lines.length),
    }))
    .exhaustive()
}

/**
 * Exports and verifies `harness-workflows` prior to `killOmnigraphServerPidIfAlive` and cluster
 * deletion during `RequiresCleanRebuild`. Fails closed so a failed backup never destroys data.
 */
export const runWorkflowBackupBeforeRebuild = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly targetBaseUrl: string
  readonly omnigraphBin: string
  readonly serverAlive: boolean
}): Effect.Effect<WorkflowBeforeRebuildResult> =>
  Effect.gen(function* () {
    if (!nodeSyncHostIo.existsSync(options.clusterRootDir)) {
      return { _tag: "Skipped" as const, reason: "no-cluster" as const }
    }
    const wfGraphDir = join(options.clusterRootDir, "graphs", "harness-workflows.omni")
    if (!nodeSyncHostIo.existsSync(wfGraphDir)) {
      return { _tag: "Skipped" as const, reason: "no-workflow-graph" as const }
    }

    const backupDir = resolveWorkflowBackupDir(options.clusterRepoRoot)
    const serverReachable =
      options.serverAlive ||
      match(yield* probeOmnigraphServerReady(options.targetBaseUrl))
        .with({ _tag: "Ready" }, () => true)
        .with({ _tag: "NotReady" }, () => false)
        .exhaustive()

    if (!serverReachable) {
      return runOfflineWorkflowBackupExport({
        omnigraphBin: options.omnigraphBin,
        clusterRepoRoot: options.clusterRepoRoot,
        clusterRootDir: options.clusterRootDir,
        backupDir,
      })
    }

    const absClusterRepoRoot = decodeAbsClusterRepoRoot(options.clusterRepoRoot)
    if (absClusterRepoRoot === undefined) {
      const reason = toBoundedReason(
        `Invalid absolute clusterRepoRoot for workflow backup: ${options.clusterRepoRoot}`,
      )
      process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
      return { _tag: "Failed" as const, reason }
    }

    const client = makeWorkflowClientForCluster(options.targetBaseUrl, options.clusterRootDir)
    return yield* beforeRebuildWorkflowBackup(backupDir).pipe(
      Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot: absClusterRepoRoot, client })),
      Effect.map((summary): WorkflowBeforeRebuildResult => ({
        _tag: "BackedUp",
        backupFile: summary.backupFile,
        timestampMs: summary.timestampMs,
        sha256: summary.sha256,
        entityCount: summary.entityCount,
      })),
      Effect.catch((err): Effect.Effect<WorkflowBeforeRebuildResult> =>
        Effect.sync(() => {
          const reason = toBoundedReason(err, "Pre-rebuild harness-workflows backup failed")
          process.stderr.write(
            `[harness:omnigraph] Error: pre-rebuild harness-workflows backup failed: ${reason}\n`,
          )
          return { _tag: "Failed", reason }
        }),
      ),
    )
  })

/**
 * Restores a captured pre-rebuild `harness-workflows` backup onto `main` (`mode: "merge"`)
 * after `omnigraph cluster apply` + server startup succeed. Fails closed on error or hash mismatch.
 */
export const runWorkflowRestoreAfterRebuild = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly baseUrl: string
  readonly backup: WorkflowBeforeRebuildResult
}): Effect.Effect<boolean> =>
  match(options.backup)
    .with({ _tag: "Skipped" }, () => Effect.succeed(true))
    .with({ _tag: "Failed" }, () => Effect.succeed(false))
    .with({ _tag: "BackedUp" }, ({ backupFile, sha256, entityCount }) =>
      Effect.gen(function* () {
        const absClusterRepoRoot = decodeAbsClusterRepoRoot(options.clusterRepoRoot)
        if (absClusterRepoRoot === undefined) {
          process.stderr.write(
            `[harness:omnigraph] Error: invalid absolute clusterRepoRoot for workflow restore: ${options.clusterRepoRoot}\n`,
          )
          return false
        }

        const client = makeWorkflowClientForCluster(options.baseUrl, options.clusterRootDir)
        return yield* afterRebuildWorkflowBackup({
          backupFile,
          mode: "merge",
          expectedSha256: sha256,
        }).pipe(
          Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot: absClusterRepoRoot, client })),
          Effect.map((summary) => {
            if (summary.restoredEntityCount !== entityCount) {
              process.stderr.write(
                `[harness:omnigraph] Error: post-rebuild harness-workflows restore entityCount mismatch (expected ${entityCount}, restored ${summary.restoredEntityCount})\n`,
              )
              return false
            }
            return true
          }),
          Effect.catch((err) =>
            Effect.sync(() => {
              process.stderr.write(
                `[harness:omnigraph] Error: post-rebuild harness-workflows restore failed: ${toBoundedReason(err)}\n`,
              )
              return false
            }),
          ),
        )
      }),
    )
    .exhaustive()
