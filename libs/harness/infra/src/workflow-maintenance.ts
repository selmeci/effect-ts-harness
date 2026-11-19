import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type BackupDirPath,
  type GitCommonDirPath,
  OmnigraphServerMetaSchema,
  toErrorReasonMessage,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupTimestampMs,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { resolveOmnigraphClusterDir, WORKFLOW_OMNIGRAPH_GRAPH_ID } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import { toWorkflowStoreUnavailableError } from "./omnigraph-workflow-store.js"
import { resolveWorkflowRuntimePaths } from "./worktree-repo-root.js"
import { isLocalPidAlive, withAdvisoryFlock } from "./writer-lease.js"

const execFileAsync = promisify(execFile)

/** Default number of recent Lance MVCC versions retained during offline cleanup. */
export const DEFAULT_WORKFLOW_CLEANUP_KEEP_VERSIONS: WorkflowBackupCount =
  WorkflowBackupCount.make(1)

const LOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RAW_STARTUP_LOCK_GRACE_MS = 2_000
const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const StartupLockJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Finite),
    lockToken: Schema.optional(Schema.String),
    createdAtMs: Schema.optional(Schema.Finite),
  }),
)
const ServerPidFallbackSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
)
const decodeServerMetaOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)
const decodeServerPidFallbackOption = Schema.decodeUnknownOption(ServerPidFallbackSchema)

export interface WorkflowMaintenanceInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly commonGitDir: GitCommonDirPath
  readonly backupDir: BackupDirPath
  readonly keepVersions?: WorkflowBackupCount | undefined
  readonly omnigraphBin?: string | undefined
  readonly clusterDir?: string | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly isPidAlive?: ((pid: number) => boolean) | undefined
}

export interface WorkflowMaintenanceSummary {
  readonly backupFile: WorkflowBackupFilePath
  readonly reclaimedBytes: WorkflowBackupCount
  readonly completedAtMs: WorkflowBackupTimestampMs
}

const toWorkspaceFsError = (
  filePath: string,
  operation: "read" | "write",
  cause: unknown,
): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-maintenance-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(cause, `Workflow maintenance ${operation} failed`),
  })
}

const resolveDefaultOmnigraphBin = (env: Readonly<Record<string, string | undefined>>): string =>
  env.OMNIGRAPH_BIN?.trim() ||
  join(env.HOME ?? process.env.HOME ?? "/root", ".local", "bin", "omnigraph")

const measureTreeBytes = (targetPath: string, hostIo: ExtendedHostIo): number => {
  if (!hostIo.existsSync(targetPath)) {
    return 0
  }
  const res = Result.try(() => {
    let total = 0
    const walk = (current: string): void => {
      if (hostIo.isDirectorySync(current)) {
        for (const entry of hostIo.readdirSync(current)) {
          walk(join(current, entry.name))
        }
        return
      }
      if (hostIo.isFileSync(current)) {
        const st = statSync(current, { throwIfNoEntry: false })
        if (st !== undefined) {
          total += st.size
        }
      }
    }
    walk(targetPath)
    return total
  })
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => 0)
    .exhaustive()
}

const compareAndUnlinkStaleStartupLock = (
  lockPath: string,
  expectedRaw: string,
  hostIo: ExtendedHostIo,
): boolean =>
  Result.getOrElse(
    Result.try(() => {
      if (hostIo.readTextSync(lockPath) !== expectedRaw) return false
      const tombstonePath = `${lockPath}.tombstone.${process.pid}.${randomBytes(6).toString("hex")}`
      hostIo.renameSync(lockPath, tombstonePath)
      const movedMatches = Result.getOrElse(
        Result.try(() => hostIo.readTextSync(tombstonePath) === expectedRaw),
        () => false,
      )
      if (!movedMatches) {
        Result.try(() => {
          hostIo.renameSync(tombstonePath, lockPath)
        })
        return false
      }
      Result.try(() => {
        hostIo.unlinkSync(tombstonePath)
      })
      return true
    }),
    () => false,
  )

interface StartupLockHandle {
  readonly lockPath: string
  readonly lockToken: string
}

const withOmnigraphClusterStartupLock = <A, E, R>(
  clusterDir: string,
  hostIo: ExtendedHostIo,
  nowMsFn: () => number,
  pidAliveFn: (pid: number) => boolean,
  operation: WorkflowStoreOperation,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkflowStoreUnavailableError, R> => {
  const lockPath = `${clusterDir}.startup.lock`
  const lockToken = randomBytes(16).toString("hex")

  const acquire = Effect.suspend(
    (): Effect.Effect<StartupLockHandle, WorkflowStoreUnavailableError> => {
      const prepRes = Result.try({
        try: () => {
          hostIo.mkdirRecursiveSync(dirname(clusterDir), 0o700)
        },
        catch: (err) => toErrorReasonMessage(err, `Failed to create lock dir for ${lockPath}`),
      })
      if (
        match(prepRes)
          .with({ _tag: "Failure" }, () => true)
          .with({ _tag: "Success" }, () => false)
          .exhaustive()
      ) {
        const msg = match(prepRes)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .with({ _tag: "Success" }, () => "")
          .exhaustive()
        return Effect.fail(toWorkflowStoreUnavailableError(operation, msg))
      }
      if (hostIo.isSymbolicLinkSync(lockPath)) {
        return Effect.fail(
          toWorkflowStoreUnavailableError(
            operation,
            `Refusing symlink cluster startup lock: ${lockPath}`,
          ),
        )
      }
      const payload = JSON.stringify({ pid: process.pid, lockToken, createdAtMs: nowMsFn() })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const writeStep = match(hostIo.tryWriteExclusiveTextSync(lockPath, payload, 0o600))
          .with({ _tag: "Written" }, () => ({
            done: true as const,
            result: Effect.succeed<StartupLockHandle>({ lockPath, lockToken }),
          }))
          .with({ _tag: "Failed" }, ({ message }) => ({
            done: true as const,
            result: Effect.fail<WorkflowStoreUnavailableError>(
              toWorkflowStoreUnavailableError(
                operation,
                `Startup lock ${lockPath} failed: ${message}`,
              ),
            ),
          }))
          .with({ _tag: "Exists" }, () => ({
            done: false as const,
            result: undefined,
          }))
          .exhaustive()
        if (writeStep.done) {
          return writeStep.result
        }
        const existingRaw = match(Result.try(() => hostIo.readTextSync(lockPath)))
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, () => undefined)
          .exhaustive()
        if (existingRaw === undefined) {
          if (!hostIo.existsSync(lockPath)) continue
          return Effect.fail(
            toWorkflowStoreUnavailableError(operation, `Cluster startup lock held at ${lockPath}`),
          )
        }
        const canBreakStale = match(Schema.decodeOption(StartupLockJsonSchema)(existingRaw))
          .with(
            { _tag: "Some" },
            ({ value }) => !(typeof value.pid === "number" && pidAliveFn(value.pid)),
          )
          .with({ _tag: "None" }, () => {
            const mtimeMs = hostIo.statMtimeMsSync(lockPath)
            return mtimeMs !== undefined && nowMsFn() - mtimeMs >= RAW_STARTUP_LOCK_GRACE_MS
          })
          .exhaustive()
        if (!canBreakStale || !compareAndUnlinkStaleStartupLock(lockPath, existingRaw, hostIo)) {
          return Effect.fail(
            toWorkflowStoreUnavailableError(operation, `Cluster startup lock held at ${lockPath}`),
          )
        }
      }
      return Effect.fail(
        toWorkflowStoreUnavailableError(operation, `Cluster startup lock held at ${lockPath}`),
      )
    },
  )

  const release = (handle: StartupLockHandle): Effect.Effect<void> =>
    Effect.sync(() => {
      Result.try(() => {
        if (hostIo.isSymbolicLinkSync(handle.lockPath) || !hostIo.existsSync(handle.lockPath)) {
          return
        }
        match(Schema.decodeOption(StartupLockJsonSchema)(hostIo.readTextSync(handle.lockPath)))
          .with({ _tag: "Some" }, ({ value }) => {
            if (value.pid === process.pid && value.lockToken === handle.lockToken) {
              hostIo.unlinkSync(handle.lockPath)
            }
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      })
    })

  return Effect.acquireUseRelease(acquire, () => use, release)
}

const runOmnigraphCli = (
  omnigraphBin: string,
  args: ReadonlyArray<string>,
  operation: WorkflowStoreOperation,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<
  { readonly stdout: string; readonly stderr: string },
  WorkflowStoreUnavailableError
> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync(omnigraphBin, [...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, ...env },
      }),
    catch: (cause) => toWorkflowStoreUnavailableError(operation, cause),
  })

const collectAdmissionLockIds = (
  clusterDir: string,
  hostIo: ExtendedHostIo,
  extraOutputs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  // Prefer admission lock IDs emitted by this maintenance run before inspecting lock.json.
  const runLockIds = new Set<string>()
  for (const text of extraOutputs) {
    for (const m of text.matchAll(/Admission lock:\s*([A-Za-z0-9._-]+)/gi)) {
      if (m[1] && LOCK_ID_PATTERN.test(m[1])) {
        runLockIds.add(m[1])
      }
    }
  }
  if (runLockIds.size > 0) {
    return Array.from(runLockIds)
  }

  const fallbackLockIds = new Set<string>()
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (hostIo.existsSync(lockJsonPath)) {
    match(Result.try(() => hostIo.readTextSync(lockJsonPath)))
      .with({ _tag: "Failure" }, () => undefined)
      .with({ _tag: "Success" }, ({ success }) => {
        match(Schema.decodeOption(LockJsonSchema)(success))
          .with({ _tag: "None" }, () => undefined)
          .with({ _tag: "Some" }, ({ value }) => {
            for (const key of ["lock_id", "id", "lockId"]) {
              const val = value[key]
              if (typeof val === "string" && LOCK_ID_PATTERN.test(val)) {
                fallbackLockIds.add(val)
              }
            }
          })
          .exhaustive()
      })
      .exhaustive()
  }
  return Array.from(fallbackLockIds)
}

const forceUnlockClusterAdmissionLocks = (
  omnigraphBin: string,
  clusterDir: string,
  hostIo: ExtendedHostIo,
  env: Readonly<Record<string, string | undefined>>,
  extraOutputs: ReadonlyArray<string>,
): Effect.Effect<void, WorkflowStoreUnavailableError> => {
  const operation = WorkflowStoreOperation.make("WorkflowMaintenance.forceUnlock")
  const lockIds = collectAdmissionLockIds(clusterDir, hostIo, extraOutputs)
  return Effect.forEach(
    lockIds,
    (lockId) =>
      runOmnigraphCli(
        omnigraphBin,
        ["cluster", "force-unlock", lockId, "--target", `file://${clusterDir}`],
        operation,
        env,
      ).pipe(Effect.asVoid),
    { discard: true },
  )
}

const assertOmnigraphServerStopped = (
  clusterDir: string,
  hostIo: ExtendedHostIo,
  pidAliveFn: (pid: number) => boolean,
  operation: WorkflowStoreOperation,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  Effect.suspend(() => {
    const serverJsonPath = join(clusterDir, "server.json")
    if (!hostIo.existsSync(serverJsonPath)) {
      return Effect.void
    }
    return match(Result.try(() => hostIo.readTextSync(serverJsonPath)))
      .with({ _tag: "Failure" }, () => Effect.void)
      .with({ _tag: "Success" }, ({ success }) => {
        const pidFromMeta = match(decodeServerMetaOption(success))
          .with({ _tag: "Some" }, ({ value }) => value.pid)
          .with({ _tag: "None" }, () =>
            match(decodeServerPidFallbackOption(success))
              .with({ _tag: "Some" }, ({ value }) => value.pid)
              .with({ _tag: "None" }, () => undefined)
              .exhaustive(),
          )
          .exhaustive()
        if (pidFromMeta !== undefined && pidAliveFn(pidFromMeta)) {
          return Effect.fail(
            toWorkflowStoreUnavailableError(
              operation,
              `Refusing offline maintenance while omnigraph-server PID ${pidFromMeta} is still alive`,
            ),
          )
        }
        return Effect.void
      })
      .exhaustive()
  })

/**
 * Runs offline Lance maintenance (`omnigraph optimize`, `omnigraph cleanup --keep <n> --confirm`,
 * and post-quiescence `omnigraph cluster force-unlock`) while the daemon and server are stopped,
 * acquiring `<clusterDir>.startup.lock` strictly before `daemon.lock`.
 */
export const runOfflineWorkflowMaintenance = Effect.fn("WorkflowMaintenance.runOffline")(function* (
  input: WorkflowMaintenanceInput,
): Effect.fn.Return<WorkflowMaintenanceSummary, WorkflowStoreUnavailableError | WorkspaceFsError> {
  const hostIo = input.hostIo ?? nodeSyncHostIo
  const env = input.env ?? hostIo.getEnv()
  const nowMsFn = input.nowMs ?? (() => Date.now())
  const pidAliveFn = input.isPidAlive ?? isLocalPidAlive
  const keepVersions = input.keepVersions ?? DEFAULT_WORKFLOW_CLEANUP_KEEP_VERSIONS
  const operation = WorkflowStoreOperation.make("WorkflowMaintenance.runOffline")

  const omnigraphBin = input.omnigraphBin ?? resolveDefaultOmnigraphBin(env)
  if (!hostIo.existsSync(omnigraphBin)) {
    return yield* toWorkflowStoreUnavailableError(
      operation,
      `omnigraph binary not found at ${omnigraphBin}`,
    )
  }

  const clusterDir = input.clusterDir ?? resolveOmnigraphClusterDir(input.repoRoot, hostIo, env)
  if (!hostIo.existsSync(clusterDir)) {
    return yield* toWorkflowStoreUnavailableError(
      operation,
      `Omnigraph cluster directory does not exist at ${clusterDir}`,
    )
  }

  yield* assertOmnigraphServerStopped(clusterDir, hostIo, pidAliveFn, operation)

  const { lockFilePath } = resolveWorkflowRuntimePaths(input.commonGitDir)
  const targetUri = `file://${clusterDir}`
  const workflowGraphDir = join(clusterDir, "graphs", `${WORKFLOW_OMNIGRAPH_GRAPH_ID}.omni`)

  const maintenanceSteps = Effect.gen(function* () {
    yield* assertOmnigraphServerStopped(clusterDir, hostIo, pidAliveFn, operation)

    const bytesBefore = measureTreeBytes(workflowGraphDir, hostIo)
    const startedAtMs = Math.max(0, Math.floor(nowMsFn()))

    // 1. Export offline safety backup before destructive cleanup (no --as on file://).
    const exportAttempt = yield* runOmnigraphCli(
      omnigraphBin,
      ["export", "--target", targetUri, "--graph", WORKFLOW_OMNIGRAPH_GRAPH_ID, "--branch", "main"],
      WorkflowStoreOperation.make("WorkflowMaintenance.export"),
      env,
    ).pipe(
      Effect.onError(() =>
        forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, []).pipe(
          Effect.ignore,
        ),
      ),
    )
    yield* forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, [
      exportAttempt.stderr,
      exportAttempt.stdout,
    ])

    const backupFile = WorkflowBackupFilePath.make(
      join(input.backupDir, `workflow-maintenance-backup-${startedAtMs}.ndjson`),
    )
    if (hostIo.isSymbolicLinkSync(input.backupDir)) {
      return yield* toWorkspaceFsError(
        backupFile,
        "write",
        `Refusing symlink maintenance backup directory: ${input.backupDir}`,
      )
    }
    if (hostIo.isSymbolicLinkSync(backupFile)) {
      return yield* toWorkspaceFsError(
        backupFile,
        "write",
        `Refusing symlink maintenance backup file: ${backupFile}`,
      )
    }
    const tmpBackupFile = `${backupFile}.${process.pid}.${randomUUID()}.tmp`
    yield* Effect.try({
      try: () => {
        hostIo.mkdirRecursiveSync(input.backupDir, 0o700)
        hostIo.chmodSync(input.backupDir, 0o700)
        hostIo.writeTextWithModeSync(tmpBackupFile, exportAttempt.stdout, 0o600)
        hostIo.renameSync(tmpBackupFile, backupFile)
        hostIo.chmodSync(backupFile, 0o600)
      },
      catch: (err) => toWorkspaceFsError(backupFile, "write", err),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (hostIo.existsSync(tmpBackupFile)) {
            Result.try(() => {
              hostIo.unlinkSync(tmpBackupFile)
            })
          }
        }),
      ),
    )

    // 2. Offline optimize (never pass --as to optimize/cleanup per omnigraph 0.14.0 behavior)
    const optimizeRes = yield* runOmnigraphCli(
      omnigraphBin,
      ["optimize", "--target", targetUri, "--graph", WORKFLOW_OMNIGRAPH_GRAPH_ID],
      WorkflowStoreOperation.make("WorkflowMaintenance.optimize"),
      env,
    ).pipe(
      Effect.onError(() =>
        forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, []).pipe(
          Effect.ignore,
        ),
      ),
    )
    yield* forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, [
      optimizeRes.stdout,
      optimizeRes.stderr,
    ])

    // 3. Offline cleanup with --keep <n> --confirm (never pass --as)
    const cleanupRes = yield* runOmnigraphCli(
      omnigraphBin,
      [
        "cleanup",
        "--target",
        targetUri,
        "--graph",
        WORKFLOW_OMNIGRAPH_GRAPH_ID,
        "--keep",
        String(keepVersions),
        "--confirm",
      ],
      WorkflowStoreOperation.make("WorkflowMaintenance.cleanup"),
      env,
    ).pipe(
      Effect.onError(() =>
        forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, []).pipe(
          Effect.ignore,
        ),
      ),
    )

    // 4. Always finish with post-quiescence force-unlock
    yield* forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, [
      cleanupRes.stdout,
      cleanupRes.stderr,
    ])

    const bytesAfter = measureTreeBytes(workflowGraphDir, hostIo)
    const reclaimedBytes = WorkflowBackupCount.make(Math.max(0, bytesBefore - bytesAfter))
    const completedAtMs = WorkflowBackupTimestampMs.make(Math.max(0, Math.floor(nowMsFn())))

    return {
      backupFile,
      reclaimedBytes,
      completedAtMs,
    }
  })

  return yield* withOmnigraphClusterStartupLock(
    clusterDir,
    hostIo,
    nowMsFn,
    pidAliveFn,
    operation,
    withAdvisoryFlock(lockFilePath, maintenanceSteps, hostIo),
  ).pipe(
    Effect.mapError((err) =>
      match(err)
        .with({ _tag: "WriterLeaseHeldError" }, (held) =>
          toWorkflowStoreUnavailableError(operation, held.message),
        )
        .with(
          { _tag: "WorkflowStoreUnavailableError" },
          { _tag: "WorkspaceFsError" },
          (other) => other,
        )
        .exhaustive(),
    ),
  )
})
