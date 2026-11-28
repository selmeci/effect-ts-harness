import { createHash, randomUUID } from "node:crypto"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  GitCommonDirPath,
  toBoundedReason,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupReceiptFields,
  WorkflowBackupTimestampMs,
  type WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  OmnigraphClient,
  isLoopbackOmnigraphUrl,
  readAuthTokensFromClusterDir,
  resolveGitCommonDir,
  resolveOmnigraphClusterDir,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
} from "@harness/graph"
import {
  invokeWorkflowStoreQuery,
  nodeSyncHostIo,
  resolveWorkflowRuntimePaths,
  withAdvisoryFlock,
} from "@harness/infra/omnigraph-session"

export type WorkflowBeforeRebuildResult =
  | { readonly _tag: "Skipped"; readonly reason: "no-cluster" | "no-workflow-graph" }
  | {
      readonly _tag: "BackedUp"
      readonly backupFile: WorkflowBackupFilePath
      readonly timestampMs: WorkflowBackupTimestampMs
      readonly sha256: BackupFileHash
      readonly entityCount: WorkflowBackupCount
    }
  | { readonly _tag: "Failed"; readonly reason: WorkflowStoreFailureReason }

const PENDING_RESTORE_JOURNAL_NAME = "pending-workflow-restore.json"

const PendingRestoreJournalSchema = Schema.fromJsonString(
  Schema.Struct({
    ...WorkflowBackupReceiptFields,
    entityCount: WorkflowBackupCount,
    clusterRootDir: WorkspaceFilePath,
    preRebuildConfigStamp: Schema.NullOr(Schema.String),
    expectedPostRebuildConfigStamp: Schema.optional(Schema.NullOr(Schema.String)),
    createdAt: Schema.String,
  }),
)

export type PendingRestoreJournalRead =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Some"
      readonly backup: Extract<WorkflowBeforeRebuildResult, { readonly _tag: "BackedUp" }>
      readonly clusterRootDir: WorkspaceFilePath
      readonly preRebuildConfigStamp: string | null
      readonly expectedPostRebuildConfigStamp?: string | null | undefined
    }
  | { readonly _tag: "Invalid"; readonly reason: WorkflowStoreFailureReason }

export interface ReadPendingWorkflowRestoreJournalOptions {
  readonly expectedPreRebuildConfigStamp?: string | null | undefined
  readonly allowPostRebuildConfigStamp?: boolean | undefined
}

export const computeSha256Hex = (content: string): BackupFileHash =>
  BackupFileHash.make(createHash("sha256").update(content, "utf8").digest("hex"))

export const readClusterConfigStampDigest = (clusterRootDir: string): string | null => {
  const stampPath = join(clusterRootDir, ".config-stamp")
  if (
    nodeSyncHostIo.isSymbolicLinkSync(stampPath) ||
    !nodeSyncHostIo.existsSync(stampPath) ||
    !nodeSyncHostIo.isFileSync(stampPath)
  ) {
    return null
  }
  return match(Result.try(() => nodeSyncHostIo.readTextSync(stampPath)))
    .with({ _tag: "Success" }, ({ success }) => computeSha256Hex(success))
    .with({ _tag: "Failure" }, () => null)
    .exhaustive()
}

export const decodeAbsClusterRepoRoot = (clusterRepoRoot: string): AbsoluteRepoRoot | undefined =>
  match(Schema.decodeOption(AbsoluteRepoRoot)(resolve(clusterRepoRoot)))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

/**
 * Builds an `OmnigraphClient` bound to `harness-workflows`, gating local CLI bearer token
 * attachment behind `isLoopbackOmnigraphUrl(baseUrl)` so secrets read from `auth-tokens.json`
 * are never attached or leaked to non-loopback / remote endpoints.
 */
export const makeWorkflowClientForCluster = (baseUrl: string, clusterRootDir: string) => {
  const cliToken = isLoopbackOmnigraphUrl(baseUrl)
    ? readAuthTokensFromClusterDir(clusterRootDir, nodeSyncHostIo, "harness-cli")
    : undefined
  return new OmnigraphClient({
    baseUrl,
    graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
    ...(cliToken !== undefined ? { token: cliToken } : {}),
  })
}

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

export const writeSecureBackupFileAtomic = (
  dirPath: string,
  targetPath: string,
  content: string,
  expectedSha256?: BackupFileHash,
): Result.Result<void, WorkflowStoreFailureReason> => {
  if (nodeSyncHostIo.isSymbolicLinkSync(dirPath)) {
    return Result.fail(toBoundedReason(`Refusing symlink workflow backup dir: ${dirPath}`))
  }
  if (nodeSyncHostIo.isSymbolicLinkSync(targetPath)) {
    return Result.fail(toBoundedReason(`Refusing symlink workflow backup target: ${targetPath}`))
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
    catch: (err) => toBoundedReason(err, `Failed to write secure backup file ${targetPath}`),
  })
  if (nodeSyncHostIo.existsSync(tmpPath)) {
    Result.try(() => {
      nodeSyncHostIo.unlinkSync(tmpPath)
    })
  }
  return Result.flatMap(res, (shaOk) =>
    shaOk
      ? Result.void
      : Result.fail(toBoundedReason(`Backup SHA-256 verification mismatch for ${targetPath}`)),
  )
}

export const writePendingWorkflowRestoreJournal = (
  clusterRepoRoot: string,
  backup: Extract<WorkflowBeforeRebuildResult, { readonly _tag: "BackedUp" }>,
  clusterRootDir: string = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo),
  preRebuildConfigStamp: string | null = readClusterConfigStampDigest(clusterRootDir),
  expectedPostRebuildConfigStamp?: string | null,
): Result.Result<void, WorkflowStoreFailureReason> => {
  const backupDir = resolveWorkflowBackupDir(clusterRepoRoot)
  const resolvedClusterOpt = Schema.decodeOption(WorkspaceFilePath)(resolve(clusterRootDir))
  return match(resolvedClusterOpt)
    .with({ _tag: "None" }, () =>
      Result.fail(toBoundedReason(`Invalid clusterRootDir for pending restore: ${clusterRootDir}`)),
    )
    .with({ _tag: "Some" }, ({ value: boundClusterRootDir }) => {
      const payload = JSON.stringify(
        {
          backupFile: backup.backupFile,
          timestampMs: backup.timestampMs,
          sha256: backup.sha256,
          entityCount: backup.entityCount,
          clusterRootDir: boundClusterRootDir,
          preRebuildConfigStamp,
          ...(expectedPostRebuildConfigStamp !== undefined
            ? { expectedPostRebuildConfigStamp }
            : {}),
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
    })
    .exhaustive()
}

const validateJournalPreRebuildConfigStamp = (
  expectedClusterDir: string,
  actualStamp: string | null,
  options?: ReadPendingWorkflowRestoreJournalOptions,
): WorkflowStoreFailureReason | undefined => {
  if (options?.expectedPreRebuildConfigStamp !== undefined) {
    return actualStamp === options.expectedPreRebuildConfigStamp
      ? undefined
      : toBoundedReason(
          `Pending-restore journal preRebuildConfigStamp mismatch (expected ${String(options.expectedPreRebuildConfigStamp)}, found ${String(actualStamp)})`,
        )
  }
  if (options?.allowPostRebuildConfigStamp === true) {
    return undefined
  }
  const currentStamp = readClusterConfigStampDigest(expectedClusterDir)
  return currentStamp !== null && actualStamp !== currentStamp
    ? toBoundedReason(
        `Pending-restore journal preRebuildConfigStamp mismatch for ${expectedClusterDir}`,
      )
    : undefined
}

export const readPendingWorkflowRestoreJournal = (
  clusterRepoRoot: string,
  clusterRootDir: string = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo),
  options?: ReadPendingWorkflowRestoreJournalOptions,
): PendingRestoreJournalRead => {
  const backupDir = resolveWorkflowBackupDir(clusterRepoRoot)
  if (nodeSyncHostIo.isSymbolicLinkSync(backupDir)) {
    return {
      _tag: "Invalid",
      reason: toBoundedReason(`Refusing symlink workflow backup dir: ${backupDir}`),
    }
  }
  const journalPath = join(backupDir, PENDING_RESTORE_JOURNAL_NAME)
  if (nodeSyncHostIo.isSymbolicLinkSync(journalPath)) {
    return {
      _tag: "Invalid",
      reason: toBoundedReason(`Refusing symlink pending-restore journal: ${journalPath}`),
    }
  }
  if (!nodeSyncHostIo.existsSync(journalPath)) {
    return { _tag: "None" }
  }
  if (!nodeSyncHostIo.isFileSync(journalPath)) {
    return {
      _tag: "Invalid",
      reason: toBoundedReason(`Pending-restore journal is not a regular file: ${journalPath}`),
    }
  }
  const expectedClusterDir = resolve(clusterRootDir)
  return match(Result.try(() => nodeSyncHostIo.readTextSync(journalPath)))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Invalid" as const,
      reason: toBoundedReason(failure, `Failed to read ${journalPath}`),
    }))
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(Schema.decodeOption(PendingRestoreJournalSchema)(raw))
        .with({ _tag: "None" }, () => ({
          _tag: "Invalid" as const,
          reason: toBoundedReason(`Corrupt pending-restore journal JSON at ${journalPath}`),
        }))
        .with({ _tag: "Some" }, ({ value }) => {
          if (resolve(value.clusterRootDir) !== expectedClusterDir) {
            return {
              _tag: "Invalid" as const,
              reason: toBoundedReason(
                `Pending-restore journal clusterRootDir mismatch (expected ${expectedClusterDir}, found ${value.clusterRootDir})`,
              ),
            }
          }
          const stampMismatchReason = validateJournalPreRebuildConfigStamp(
            expectedClusterDir,
            value.preRebuildConfigStamp,
            options,
          )
          if (stampMismatchReason !== undefined) {
            return {
              _tag: "Invalid" as const,
              reason: stampMismatchReason,
            }
          }
          if (
            nodeSyncHostIo.isSymbolicLinkSync(value.backupFile) ||
            !nodeSyncHostIo.isFileSync(value.backupFile)
          ) {
            return {
              _tag: "Invalid" as const,
              reason: toBoundedReason(
                `Pending-restore backup file missing or unsafe: ${value.backupFile}`,
              ),
            }
          }
          const canonicalContainment = Result.try({
            try: () => {
              const realBackupDir = nodeSyncHostIo.realpathSync(backupDir)
              const realBackupFile = nodeSyncHostIo.realpathSync(value.backupFile)
              const rel = relative(realBackupDir, realBackupFile)
              return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
            },
            catch: (err) =>
              toBoundedReason(err, `Failed to canonicalize pending backup ${value.backupFile}`),
          })
          const containmentError = match(canonicalContainment)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, ({ success }) =>
              success
                ? undefined
                : toBoundedReason(
                    `Pending-restore backupFile escapes backupDir ${backupDir}: ${value.backupFile}`,
                  ),
            )
            .exhaustive()
          if (containmentError !== undefined) {
            return {
              _tag: "Invalid" as const,
              reason: containmentError,
            }
          }
          return match(
            Result.try(() => computeSha256Hex(nodeSyncHostIo.readTextSync(value.backupFile))),
          )
            .with({ _tag: "Failure" }, ({ failure }) => ({
              _tag: "Invalid" as const,
              reason: toBoundedReason(
                failure,
                `Failed to verify pending backup ${value.backupFile}`,
              ),
            }))
            .with({ _tag: "Success" }, ({ success: actualSha }) =>
              actualSha === value.sha256
                ? {
                    _tag: "Some" as const,
                    backup: {
                      _tag: "BackedUp" as const,
                      backupFile: value.backupFile,
                      timestampMs: value.timestampMs,
                      sha256: value.sha256,
                      entityCount: value.entityCount,
                    },
                    clusterRootDir: value.clusterRootDir,
                    preRebuildConfigStamp: value.preRebuildConfigStamp,
                    expectedPostRebuildConfigStamp: value.expectedPostRebuildConfigStamp ?? null,
                  }
                : {
                    _tag: "Invalid" as const,
                    reason: toBoundedReason(
                      `Pending-restore backup SHA-256 mismatch for ${value.backupFile}`,
                    ),
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
 * a git checkout, failing closed if `.git` exists with an unresolvable or invalid git common dir.
 */
export const withClusterDaemonLockIfGit = (
  clusterRepoRoot: string,
  effect: Effect.Effect<boolean>,
): Effect.Effect<boolean> => {
  const absRoot = resolve(clusterRepoRoot)
  const dotGitPath = join(absRoot, ".git")
  const hasDotGit =
    nodeSyncHostIo.existsSync(dotGitPath) || nodeSyncHostIo.isSymbolicLinkSync(dotGitPath)
  const commonGitDir = resolveGitCommonDir(absRoot, nodeSyncHostIo)
  if (commonGitDir === null) {
    if (!hasDotGit) {
      return effect
    }
    process.stderr.write(
      `[harness:omnigraph] Error: unable to resolve git common dir for ${absRoot} while .git exists; refusing unlocked cluster lifecycle operation\n`,
    )
    return Effect.succeed(false)
  }
  const decoded = Schema.decodeOption(GitCommonDirPath)(commonGitDir)
  return match(decoded)
    .with({ _tag: "None" }, () => {
      process.stderr.write(
        `[harness:omnigraph] Error: invalid git common dir '${commonGitDir}'; refusing unlocked cluster lifecycle operation\n`,
      )
      return Effect.succeed(false)
    })
    .with({ _tag: "Some" }, ({ value }) => {
      const { lockFilePath } = resolveWorkflowRuntimePaths(value)
      return withAdvisoryFlock(lockFilePath, effect, nodeSyncHostIo).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `[harness:omnigraph] Error: unable to acquire workflow daemon lock (${toBoundedReason(err)}); aborting cluster lifecycle change\n`,
            )
            return false
          }),
        ),
      )
    })
    .exhaustive()
}

const parseCountField = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim())
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/**
 * Guards non-rebuild pending-restore recovery so a stale `pending-workflow-restore.json`
 * never merges over an already-populated `harness-workflows` graph.
 */
export const verifyWorkflowGraphEmptyBeforeNonRebuildRestore = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly baseUrl: string
  readonly driftActionTag: "NoOp" | "LiveClusterApply"
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const absClusterRepoRoot = decodeAbsClusterRepoRoot(options.clusterRepoRoot)
    if (absClusterRepoRoot === undefined) {
      process.stderr.write(
        `[harness:omnigraph] Error: invalid absolute clusterRepoRoot for pending-restore safety check: ${options.clusterRepoRoot}\n`,
      )
      return false
    }
    const client = makeWorkflowClientForCluster(options.baseUrl, options.clusterRootDir)
    const msgRows = yield* invokeWorkflowStoreQuery({
      repoRoot: absClusterRepoRoot,
      operation: WorkflowStoreOperation.make("OmnigraphWorkflowBackup.verifyEmptyMessages"),
      queryName: "wf_count_all",
      params: {},
      expectMutation: false,
      client,
    })
    const replyRows = yield* invokeWorkflowStoreQuery({
      repoRoot: absClusterRepoRoot,
      operation: WorkflowStoreOperation.make("OmnigraphWorkflowBackup.verifyEmptyReplies"),
      queryName: "wf_count_replies",
      params: {},
      expectMutation: false,
      client,
    })
    const totalMessages = parseCountField(msgRows[0]?.totalMessages)
    const totalReplies = parseCountField(replyRows[0]?.totalReplies)
    if (totalMessages === undefined || totalReplies === undefined) {
      process.stderr.write(
        `[harness:omnigraph] Error: unable to verify empty harness-workflows graph before non-rebuild pending restore (totalMessages=${String(msgRows[0]?.totalMessages)}, totalReplies=${String(replyRows[0]?.totalReplies)})\n`,
      )
      return false
    }
    if (totalMessages > 0 || totalReplies > 0) {
      process.stderr.write(
        `[harness:omnigraph] Error: refusing to merge stale pending-workflow-restore.json into populated harness-workflows graph (totalMessages=${totalMessages}, totalReplies=${totalReplies}, drift=${options.driftActionTag})\n`,
      )
      return false
    }
    return true
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        process.stderr.write(
          `[harness:omnigraph] Error: failed to verify harness-workflows emptiness before pending restore: ${toBoundedReason(err)}\n`,
        )
        return false
      }),
    ),
  )
