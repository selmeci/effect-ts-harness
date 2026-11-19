import { createHash, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  GitCommonDirPath,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupMode,
  type WorkflowBackupSummary,
  type WorkflowRestoreRequest,
  type WorkflowRestoreSummary,
  type WorkflowStoreUnavailableError,
  type WorkspaceFsError,
} from "@harness/contract"
import {
  OmnigraphClient,
  readAuthTokensFromClusterDir,
  resolveGitCommonDir,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
} from "@harness/graph"
import {
  makeWorkflowGraphBackupLayer,
  nodeSyncHostIo,
  resolveWorkflowRuntimePaths,
  withAdvisoryFlock,
} from "@harness/infra"
import { WorkflowGraphBackup } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"
import { isValidLockId, probeOmnigraphServerReady } from "./omnigraph-safety-helpers.js"

export interface WorkflowRebuildBackupArtifact {
  readonly mode: WorkflowBackupMode
  readonly sha256: BackupFileHash
}

export type WorkflowBeforeRebuildResult =
  | { readonly _tag: "Skipped"; readonly reason: "no-cluster" | "no-workflow-graph" }
  | {
      readonly _tag: "BackedUp"
      readonly backupFile: WorkflowBackupFilePath
      readonly sha256: BackupFileHash
      readonly entityCount: WorkflowBackupCount
    }
  | { readonly _tag: "Failed"; readonly reason: string }

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

const computeSha256Hex = (content: string): BackupFileHash =>
  BackupFileHash.make(createHash("sha256").update(content, "utf8").digest("hex"))

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
        const reason = `Failed to read ${lockPath}: ${failure instanceof Error ? failure.message : String(failure)}`
        process.stderr.write(`[harness:omnigraph] ${reason}\n`)
        return undefined
      })
      .exhaustive()
    if (rawLock === undefined) {
      return { ok: false, reason: `failed-to-read-lock-json` }
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
      return { ok: false, reason: `invalid-lock-json` }
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
          `[harness:omnigraph] force-unlock threw for ${lockId}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
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

const PENDING_RESTORE_JOURNAL_NAME = "pending-workflow-restore.json"

const PendingRestoreJournalSchema = Schema.fromJsonString(
  Schema.Struct({
    backupFile: WorkflowBackupFilePath,
    sha256: BackupFileHash,
    entityCount: WorkflowBackupCount,
    createdAt: Schema.String,
  }),
)

const decodeAbsClusterRepoRoot = (clusterRepoRoot: string): AbsoluteRepoRoot | undefined =>
  match(Schema.decodeOption(AbsoluteRepoRoot)(resolve(clusterRepoRoot)))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const makeWorkflowClientForCluster = (baseUrl: string, clusterRootDir: string) => {
  const cliToken = readAuthTokensFromClusterDir(clusterRootDir, nodeSyncHostIo, "harness-cli")
  return new OmnigraphClient({
    baseUrl,
    graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
    ...(cliToken !== undefined ? { token: cliToken } : {}),
  })
}

export type PendingRestoreJournalRead =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Some"
      readonly backup: Extract<WorkflowBeforeRebuildResult, { readonly _tag: "BackedUp" }>
    }
  | { readonly _tag: "Invalid"; readonly reason: string }

/**
 * Resolves the canonical workflow backup directory under `<git-common-dir>/harness/workflow-backups`,
 * falling back to `<clusterRepoRoot>/.harness/workflow-backups` outside git checkouts.
 */
export const resolveWorkflowBackupDir = (clusterRepoRoot: string): BackupDirPath => {
  const absRoot = resolve(clusterRepoRoot)
  const commonGitDir = resolveGitCommonDir(absRoot, nodeSyncHostIo)
  if (commonGitDir !== null) {
    const decodedGitDir = Schema.decodeOption(GitCommonDirPath)(commonGitDir)
    const resolvedFromGit = match(decodedGitDir)
      .with({ _tag: "Some" }, ({ value }) => resolveWorkflowRuntimePaths(value).backupDirPath)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (resolvedFromGit !== undefined) {
      return resolvedFromGit
    }
  }
  return BackupDirPath.make(join(absRoot, ".harness", "workflow-backups"))
}

const writeSecureBackupFileAtomic = (
  dirPath: string,
  targetPath: string,
  content: string,
  expectedSha256?: BackupFileHash,
): Result.Result<void, string> => {
  if (nodeSyncHostIo.isSymbolicLinkSync(dirPath)) {
    return Result.fail(`Refusing symlink workflow backup dir: ${dirPath}`)
  }
  if (nodeSyncHostIo.isSymbolicLinkSync(targetPath)) {
    return Result.fail(`Refusing symlink workflow backup target: ${targetPath}`)
  }
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  const res = Result.try({
    try: () => {
      nodeSyncHostIo.mkdirRecursiveSync(dirPath, 0o700)
      nodeSyncHostIo.chmodSync(dirPath, 0o700)
      nodeSyncHostIo.writeTextWithModeSync(tmpPath, content, 0o600)
      nodeSyncHostIo.renameSync(tmpPath, targetPath)
      nodeSyncHostIo.chmodSync(targetPath, 0o600)
      if (expectedSha256 !== undefined) {
        return computeSha256Hex(nodeSyncHostIo.readTextSync(targetPath)) === expectedSha256
      }
      return true
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  if (nodeSyncHostIo.existsSync(tmpPath)) {
    Result.try(() => {
      nodeSyncHostIo.unlinkSync(tmpPath)
    })
  }
  return Result.flatMap(res, (shaOk) =>
    shaOk ? Result.void : Result.fail(`Backup SHA-256 verification mismatch for ${targetPath}`),
  )
}

export const writePendingWorkflowRestoreJournal = (
  clusterRepoRoot: string,
  backup: Extract<WorkflowBeforeRebuildResult, { readonly _tag: "BackedUp" }>,
): Result.Result<void, string> => {
  const backupDir = resolveWorkflowBackupDir(clusterRepoRoot)
  const payload = JSON.stringify(
    {
      backupFile: backup.backupFile,
      sha256: backup.sha256,
      entityCount: backup.entityCount,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )
  return writeSecureBackupFileAtomic(
    backupDir,
    join(backupDir, PENDING_RESTORE_JOURNAL_NAME),
    payload,
  )
}

export const readPendingWorkflowRestoreJournal = (
  clusterRepoRoot: string,
): PendingRestoreJournalRead => {
  const backupDir = resolveWorkflowBackupDir(clusterRepoRoot)
  if (nodeSyncHostIo.isSymbolicLinkSync(backupDir)) {
    return { _tag: "Invalid", reason: `Refusing symlink workflow backup dir: ${backupDir}` }
  }
  const journalPath = join(backupDir, PENDING_RESTORE_JOURNAL_NAME)
  if (nodeSyncHostIo.isSymbolicLinkSync(journalPath)) {
    return { _tag: "Invalid", reason: `Refusing symlink pending-restore journal: ${journalPath}` }
  }
  if (!nodeSyncHostIo.existsSync(journalPath)) {
    return { _tag: "None" }
  }
  if (!nodeSyncHostIo.isFileSync(journalPath)) {
    return {
      _tag: "Invalid",
      reason: `Pending-restore journal is not a regular file: ${journalPath}`,
    }
  }
  return match(Result.try(() => nodeSyncHostIo.readTextSync(journalPath)))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Invalid" as const,
      reason: `Failed to read ${journalPath}: ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(Schema.decodeOption(PendingRestoreJournalSchema)(raw))
        .with({ _tag: "None" }, () => ({
          _tag: "Invalid" as const,
          reason: `Corrupt pending-restore journal JSON at ${journalPath}`,
        }))
        .with({ _tag: "Some" }, ({ value }) => {
          if (
            nodeSyncHostIo.isSymbolicLinkSync(value.backupFile) ||
            !nodeSyncHostIo.isFileSync(value.backupFile)
          ) {
            return {
              _tag: "Invalid" as const,
              reason: `Pending-restore backup file missing or unsafe: ${value.backupFile}`,
            }
          }
          return match(
            Result.try(() => computeSha256Hex(nodeSyncHostIo.readTextSync(value.backupFile))),
          )
            .with({ _tag: "Failure" }, ({ failure }) => ({
              _tag: "Invalid" as const,
              reason: `Failed to verify pending backup ${value.backupFile}: ${failure instanceof Error ? failure.message : String(failure)}`,
            }))
            .with({ _tag: "Success" }, ({ success: actualSha }) =>
              actualSha === value.sha256
                ? {
                    _tag: "Some" as const,
                    backup: {
                      _tag: "BackedUp" as const,
                      backupFile: value.backupFile,
                      sha256: value.sha256,
                      entityCount: value.entityCount,
                    },
                  }
                : {
                    _tag: "Invalid" as const,
                    reason: `Pending-restore backup SHA-256 mismatch for ${value.backupFile}`,
                  },
            )
            .exhaustive()
        })
        .exhaustive(),
    )
    .exhaustive()
}

export const clearPendingWorkflowRestoreJournal = (clusterRepoRoot: string): void => {
  const journalPath = join(resolveWorkflowBackupDir(clusterRepoRoot), PENDING_RESTORE_JOURNAL_NAME)
  if (!nodeSyncHostIo.isSymbolicLinkSync(journalPath) && nodeSyncHostIo.existsSync(journalPath)) {
    Result.try(() => {
      nodeSyncHostIo.unlinkSync(journalPath)
    })
  }
}

/**
 * Acquires `<git-common-dir>/harness/daemon.lock` inside `.startup.lock` when operating inside
 * a git checkout, matching `runOfflineWorkflowMaintenance` lock ordering (`.startup.lock` -> `daemon.lock`).
 */
export const withClusterDaemonLockIfGit = (
  clusterRepoRoot: string,
  effect: Effect.Effect<boolean>,
): Effect.Effect<boolean> => {
  const commonGitDir = resolveGitCommonDir(resolve(clusterRepoRoot), nodeSyncHostIo)
  if (commonGitDir === null) {
    return effect
  }
  const decoded = Schema.decodeOption(GitCommonDirPath)(commonGitDir)
  return match(decoded)
    .with({ _tag: "None" }, () => effect)
    .with({ _tag: "Some" }, ({ value }) => {
      const { lockFilePath } = resolveWorkflowRuntimePaths(value)
      return withAdvisoryFlock(lockFilePath, effect, nodeSyncHostIo).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `[harness:omnigraph] Error: unable to acquire workflow daemon lock (${err.message}); aborting cluster lifecycle change\n`,
            )
            return false
          }),
        ),
      )
    })
    .exhaustive()
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
    const reason = `Missing omnigraph binary (${options.omnigraphBin}) for offline harness-workflows backup`
    process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
    return { _tag: "Failed", reason }
  }
  const preUnlock = unlockOmnigraphClusterIfNeeded(options.omnigraphBin, options.clusterRootDir)
  if (!preUnlock.ok) {
    const reason = `Failed to unlock cluster before offline workflow backup: ${preUnlock.reason ?? "unknown"}`
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
        `[harness:omnigraph] Error: offline harness-workflows export threw: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      )
      return undefined
    })
    .with({ _tag: "Success" }, ({ success: res }) =>
      matchExecSyncStdout("Offline harness-workflows export failed", res),
    )
    .exhaustive()
  if (rawStdout === undefined) {
    return { _tag: "Failed", reason: "offline-export-failed" }
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
      const reason = `Offline workflow backup NDJSON validation failed at line ${idx + 1}`
      process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
      return { _tag: "Failed", reason }
    }
  }

  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`
  const sha256 = computeSha256Hex(content)
  const timestampMs = Math.max(0, Math.floor(Date.now()))
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
      const reason = `Invalid absolute clusterRepoRoot for workflow backup: ${options.clusterRepoRoot}`
      process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
      return { _tag: "Failed" as const, reason }
    }

    const client = makeWorkflowClientForCluster(options.targetBaseUrl, options.clusterRootDir)
    return yield* beforeRebuildWorkflowBackup(backupDir).pipe(
      Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot: absClusterRepoRoot, client })),
      Effect.map((summary): WorkflowBeforeRebuildResult => ({
        _tag: "BackedUp",
        backupFile: summary.backupFile,
        sha256: summary.sha256,
        entityCount: summary.entityCount,
      })),
      Effect.catch((err): Effect.Effect<WorkflowBeforeRebuildResult> =>
        Effect.sync(() => {
          process.stderr.write(
            `[harness:omnigraph] Error: pre-rebuild harness-workflows backup failed: ${err.message}\n`,
          )
          return { _tag: "Failed", reason: err.message }
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
    .with({ _tag: "BackedUp" }, ({ backupFile, sha256 }) =>
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
          mode: WorkflowBackupMode.make("merge"),
          expectedSha256: sha256,
        }).pipe(
          Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot: absClusterRepoRoot, client })),
          Effect.map(() => true),
          Effect.catch((err) =>
            Effect.sync(() => {
              process.stderr.write(
                `[harness:omnigraph] Error: post-rebuild harness-workflows restore failed: ${err.message}\n`,
              )
              return false
            }),
          ),
        )
      }),
    )
    .exhaustive()
