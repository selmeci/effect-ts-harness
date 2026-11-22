import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type BackupDirPath,
  type ErrorReasonMessage,
  type GitCommonDirPath,
  OmnigraphServerMetaSchema,
  toBoundedReason,
  toErrorReasonMessage,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupTimestampMs,
  WorkflowCleanupKeepVersions,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { resolveOmnigraphClusterDir, WORKFLOW_OMNIGRAPH_GRAPH_ID } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import { toWorkflowStoreUnavailableError } from "./omnigraph-workflow-store.js"
import { withOmnigraphClusterStartupLock } from "./workflow/cluster-startup-lock.js"
import { signalChildProcessGroup } from "./workflow/verify-child-process.js"
import {
  computeSha256Hex,
  parseAndValidateExportNdjson,
  writeSecureBackupAndVerifySha,
} from "./workflow-graph-backup.js"
import { resolveWorkflowRuntimePaths } from "./worktree-repo-root.js"
import { isLocalPidAlive, withAdvisoryFlock } from "./writer-lease.js"

const OMNIGRAPH_CLI_TIMEOUT_MS = 60_000
const OMNIGRAPH_CLI_MAX_BUFFER_BYTES = 64 * 1024 * 1024
const OMNIGRAPH_CLI_KILL_GRACE_MS = 500

/** Default number of recent Lance MVCC versions retained during offline cleanup. */
export const DEFAULT_WORKFLOW_CLEANUP_KEEP_VERSIONS: WorkflowCleanupKeepVersions =
  WorkflowCleanupKeepVersions.make(1)

const LOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
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
  readonly keepVersions?: WorkflowCleanupKeepVersions | undefined
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

const measureTreeBytes = (
  targetPath: string,
  hostIo: ExtendedHostIo,
): Result.Result<number, ErrorReasonMessage> => {
  if (!hostIo.existsSync(targetPath)) {
    return Result.succeed(0)
  }
  return Result.try({
    try: () => {
      let total = 0
      const walk = (current: string): void => {
        if (hostIo.isSymbolicLinkSync(current)) {
          return
        }
        if (hostIo.isDirectorySync(current)) {
          for (const entry of hostIo.readdirSync(current)) {
            walk(join(current, entry.name))
          }
          return
        }
        if (hostIo.isFileSync(current)) {
          const st = lstatSync(current, { throwIfNoEntry: false })
          if (st !== undefined && !st.isSymbolicLink()) {
            total += st.size
          }
        }
      }
      walk(targetPath)
      return total
    },
    catch: (err) => toErrorReasonMessage(err, `Failed to measure bytes under ${targetPath}`),
  })
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
  Effect.callback((resume) => {
    let settled = false
    let cancelled = false
    let childTerminated = false
    let timedOut = false
    let bufferExceeded = false
    let sigtermSent = false
    let sigkillSent = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks: Array<Buffer> = []
    const stderrChunks: Array<Buffer> = []
    const terminateWaiters: Array<() => void> = []

    const child = spawn(omnigraphBin, [...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })

    const clearTimeoutTimer = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
    }

    const clearGraceTimer = (): void => {
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
        killGraceTimer = undefined
      }
    }

    const destroyStdio = (): void => {
      child.stdout?.removeAllListeners("data")
      child.stdout?.destroy()
      child.stderr?.removeAllListeners("data")
      child.stderr?.destroy()
    }

    const notifyTerminated = (): void => {
      if (childTerminated) return
      childTerminated = true
      clearGraceTimer()
      destroyStdio()
      while (terminateWaiters.length > 0) {
        terminateWaiters.shift()?.()
      }
    }

    const terminateChild = (): void => {
      if (childTerminated || child.exitCode !== null || child.signalCode !== null) return
      if (sigtermSent) {
        if (!sigkillSent) {
          sigkillSent = true
          signalChildProcessGroup(child, "SIGKILL")
        }
        return
      }
      sigtermSent = true
      signalChildProcessGroup(child, "SIGTERM")
      killGraceTimer = setTimeout(() => {
        if (
          !childTerminated &&
          child.exitCode === null &&
          child.signalCode === null &&
          !sigkillSent
        ) {
          sigkillSent = true
          signalChildProcessGroup(child, "SIGKILL")
        }
      }, OMNIGRAPH_CLI_KILL_GRACE_MS)
      killGraceTimer.unref()
    }

    const appendBoundedChunk = (
      chunk: Buffer | string,
      chunks: Array<Buffer>,
      currentBytes: number,
    ): number => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      const nextBytes = currentBytes + buf.byteLength
      if (nextBytes > OMNIGRAPH_CLI_MAX_BUFFER_BYTES) {
        if (!bufferExceeded) {
          bufferExceeded = true
          clearTimeoutTimer()
          terminateChild()
        }
        return nextBytes
      }
      chunks.push(buf)
      return nextBytes
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBytes = appendBoundedChunk(chunk, stdoutChunks, stdoutBytes)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes = appendBoundedChunk(chunk, stderrChunks, stderrBytes)
    })

    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminateChild()
    }, OMNIGRAPH_CLI_TIMEOUT_MS)
    timeoutTimer.unref()

    child.once("error", (err) => {
      clearTimeoutTimer()
      notifyTerminated()
      if (!settled) {
        settled = true
        resume(Effect.fail(toWorkflowStoreUnavailableError(operation, err)))
      }
    })

    child.once("exit", () => {
      // Only destroy stdio on exit when aborting so normal runs drain stdout/stderr completely.
      if (cancelled || timedOut || bufferExceeded) {
        destroyStdio()
      }
      if (cancelled) {
        notifyTerminated()
      }
    })

    child.once("close", (code, signal) => {
      clearTimeoutTimer()
      notifyTerminated()
      if (settled) return
      settled = true
      const stdout = Buffer.concat(stdoutChunks).toString("utf8")
      const stderr = Buffer.concat(stderrChunks).toString("utf8")
      const stderrSuffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""
      const failWith = (message: string): void => {
        resume(Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(message))))
      }
      if (bufferExceeded) {
        failWith(`omnigraph CLI maxBuffer (${OMNIGRAPH_CLI_MAX_BUFFER_BYTES} bytes) exceeded`)
        return
      }
      if (timedOut) {
        failWith(`omnigraph CLI timed out after ${OMNIGRAPH_CLI_TIMEOUT_MS}ms${stderrSuffix}`)
        return
      }
      if (signal !== null) {
        failWith(`omnigraph CLI terminated by signal ${signal}${stderrSuffix}`)
        return
      }
      if ((code ?? 1) !== 0) {
        failWith(`omnigraph CLI exited with code ${code ?? 1}${stderrSuffix}`)
        return
      }
      resume(Effect.succeed({ stdout, stderr }))
    })

    return Effect.callback<void>((done) => {
      settled = true
      cancelled = true
      clearTimeoutTimer()
      if (childTerminated || child.exitCode !== null || child.signalCode !== null) {
        notifyTerminated()
        done(Effect.void)
        return
      }
      terminateWaiters.push(() => done(Effect.void))
      terminateChild()
    })
  })

const readLockIdsFromLockJson = (
  lockJsonPath: string,
  hostIo: ExtendedHostIo,
): ReadonlyArray<string> => {
  const ids = new Set<string>()
  if (!hostIo.existsSync(lockJsonPath) || hostIo.isSymbolicLinkSync(lockJsonPath)) {
    return []
  }
  match(
    Result.try({
      try: () => hostIo.readTextSync(lockJsonPath),
      catch: (err) => toErrorReasonMessage(err, `Failed to read ${lockJsonPath}`),
    }),
  )
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(`[harness:workflow] Warning: ${failure}\n`)
    })
    .with({ _tag: "Success" }, ({ success }) => {
      match(Schema.decodeOption(LockJsonSchema)(success))
        .with({ _tag: "None" }, () => {
          process.stderr.write(
            `[harness:workflow] Warning: Failed to decode admission lock metadata at ${lockJsonPath}\n`,
          )
        })
        .with({ _tag: "Some" }, ({ value }) => {
          for (const key of ["lock_id", "id", "lockId"]) {
            const val = value[key]
            if (typeof val === "string" && LOCK_ID_PATTERN.test(val)) {
              ids.add(val)
            }
          }
        })
        .exhaustive()
    })
    .exhaustive()
  return Array.from(ids)
}

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

  return readLockIdsFromLockJson(join(clusterDir, "__cluster", "lock.json"), hostIo)
}

const assertNoPreexistingAdmissionLock = (
  clusterDir: string,
  hostIo: ExtendedHostIo,
  operation: WorkflowStoreOperation,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  Effect.suspend(() => {
    const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
    if (hostIo.isSymbolicLinkSync(lockJsonPath)) {
      return Effect.fail(
        toWorkflowStoreUnavailableError(
          operation,
          `Refusing offline maintenance: symlink admission lock at ${lockJsonPath}`,
        ),
      )
    }
    if (!hostIo.existsSync(lockJsonPath)) {
      return Effect.void
    }
    const existingIds = readLockIdsFromLockJson(lockJsonPath, hostIo)
    const idSuffix = existingIds.length > 0 ? ` (lockId=${existingIds.join(",")})` : ""
    return Effect.fail(
      toWorkflowStoreUnavailableError(
        operation,
        `Refusing offline maintenance while pre-existing foreign cluster admission lock exists at ${lockJsonPath}${idSuffix}`,
      ),
    )
  })

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

const unlockAdmissionLocksOnError = (
  omnigraphBin: string,
  clusterDir: string,
  hostIo: ExtendedHostIo,
  env: Readonly<Record<string, string | undefined>>,
  stepName: string,
): Effect.Effect<void> =>
  forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, []).pipe(
    Effect.catch((err) =>
      Effect.logWarning(
        `Failed to force-unlock cluster admission locks after ${stepName} failure: ${err.reason}`,
      ),
    ),
  )

const assertOmnigraphServerStopped = (
  clusterDir: string,
  hostIo: ExtendedHostIo,
  pidAliveFn: (pid: number) => boolean,
  operation: WorkflowStoreOperation,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  Effect.suspend(() => {
    const serverJsonPath = join(clusterDir, "server.json")
    if (hostIo.isSymbolicLinkSync(serverJsonPath)) {
      return Effect.fail(
        toWorkflowStoreUnavailableError(
          operation,
          `Refusing offline maintenance: symlink server metadata at ${serverJsonPath}`,
        ),
      )
    }
    if (!hostIo.existsSync(serverJsonPath)) {
      return Effect.void
    }
    return match(
      Result.try({
        try: () => hostIo.readTextSync(serverJsonPath),
        catch: (err) => toErrorReasonMessage(err, `Failed to read ${serverJsonPath}`),
      }),
    )
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          toWorkflowStoreUnavailableError(
            operation,
            `Failed to read ${serverJsonPath} to verify omnigraph-server is stopped: ${failure}`,
          ),
        ),
      )
      .with({ _tag: "Success" }, ({ success }) => {
        const pidFromMeta = match(decodeServerMetaOption(success))
          .with({ _tag: "Some" }, ({ value }) => value.pid)
          .with({ _tag: "None" }, () =>
            match(decodeServerPidFallbackOption(success))
              .with({ _tag: "Some" }, ({ value }) => value.pid)
              .with({ _tag: "None" }, () => {
                process.stderr.write(
                  `[harness:workflow] Warning: Failed to decode server metadata at ${serverJsonPath}\n`,
                )
                return undefined
              })
              .exhaustive(),
          )
          .exhaustive()
        if (pidFromMeta === undefined) {
          return Effect.fail(
            toWorkflowStoreUnavailableError(
              operation,
              `Failed to decode ${serverJsonPath} to verify omnigraph-server PID`,
            ),
          )
        }
        if (pidAliveFn(pidFromMeta)) {
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
 * refusing pre-existing admission locks or undecodable `server.json`, verifying exported safety
 * backups before destructive cleanup, and acquiring `<clusterDir>.startup.lock` strictly before `daemon.lock`.
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
    return yield* new WorkflowStoreUnavailableError({
      operation,
      reason: toBoundedReason(`omnigraph binary not found at ${omnigraphBin}`),
    })
  }

  const clusterDir = input.clusterDir ?? resolveOmnigraphClusterDir(input.repoRoot, hostIo, env)
  if (hostIo.isSymbolicLinkSync(clusterDir)) {
    return yield* new WorkflowStoreUnavailableError({
      operation,
      reason: toBoundedReason(`Refusing symlink Omnigraph cluster directory at ${clusterDir}`),
    })
  }
  if (!hostIo.existsSync(clusterDir)) {
    return yield* new WorkflowStoreUnavailableError({
      operation,
      reason: toBoundedReason(`Omnigraph cluster directory does not exist at ${clusterDir}`),
    })
  }

  yield* assertOmnigraphServerStopped(clusterDir, hostIo, pidAliveFn, operation)
  yield* assertNoPreexistingAdmissionLock(clusterDir, hostIo, operation)

  const { lockFilePath } = resolveWorkflowRuntimePaths(input.commonGitDir)
  const targetUri = `file://${clusterDir}`
  const workflowGraphDir = join(clusterDir, "graphs", `${WORKFLOW_OMNIGRAPH_GRAPH_ID}.omni`)

  const maintenanceSteps = Effect.gen(function* () {
    yield* assertOmnigraphServerStopped(clusterDir, hostIo, pidAliveFn, operation)
    yield* assertNoPreexistingAdmissionLock(clusterDir, hostIo, operation)

    const bytesBefore = yield* match(measureTreeBytes(workflowGraphDir, hostIo))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkspaceFsError(workflowGraphDir, "read", failure)),
      )
      .exhaustive()
    const startedAtMs = Math.max(0, Math.floor(nowMsFn()))

    // 1. Export offline safety backup before destructive cleanup (no --as on file://).
    const exportAttempt = yield* runOmnigraphCli(
      omnigraphBin,
      ["export", "--target", targetUri, "--graph", WORKFLOW_OMNIGRAPH_GRAPH_ID, "--branch", "main"],
      WorkflowStoreOperation.make("WorkflowMaintenance.export"),
      env,
    ).pipe(
      Effect.onError(() =>
        unlockAdmissionLocksOnError(omnigraphBin, clusterDir, hostIo, env, "export"),
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

    // Schema-validate every exported record line and verify SHA-256 read-back before cleanup.
    yield* match(parseAndValidateExportNdjson(exportAttempt.stdout, backupFile))
      .with({ _tag: "Success" }, () => Effect.void)
      .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
      .exhaustive()

    const expectedSha256 = computeSha256Hex(exportAttempt.stdout)
    const tmpBackupFile = `${backupFile}.${process.pid}.${randomUUID()}.tmp`
    yield* match(
      writeSecureBackupAndVerifySha(
        input.backupDir,
        backupFile,
        tmpBackupFile,
        exportAttempt.stdout,
        expectedSha256,
        hostIo,
      ),
    )
      .with({ _tag: "Success" }, () => Effect.void)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkspaceFsError(backupFile, "write", failure)),
      )
      .exhaustive()
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (hostIo.existsSync(tmpBackupFile)) {
              const unlinkRes = Result.try({
                try: () => {
                  hostIo.unlinkSync(tmpBackupFile)
                },
                catch: (err) => toErrorReasonMessage(err, `Failed to unlink ${tmpBackupFile}`),
              })
              yield* match(unlinkRes)
                .with({ _tag: "Success" }, () => Effect.void)
                .with({ _tag: "Failure" }, ({ failure }) =>
                  Effect.logWarning(
                    `Failed to unlink temporary maintenance backup ${tmpBackupFile}: ${failure}`,
                  ),
                )
                .exhaustive()
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
        unlockAdmissionLocksOnError(omnigraphBin, clusterDir, hostIo, env, "optimize"),
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
        unlockAdmissionLocksOnError(omnigraphBin, clusterDir, hostIo, env, "cleanup"),
      ),
    )

    // 4. Always finish with post-quiescence force-unlock
    yield* forceUnlockClusterAdmissionLocks(omnigraphBin, clusterDir, hostIo, env, [
      cleanupRes.stdout,
      cleanupRes.stderr,
    ])

    const bytesAfter = yield* match(measureTreeBytes(workflowGraphDir, hostIo))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkspaceFsError(workflowGraphDir, "read", failure)),
      )
      .exhaustive()
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
    withAdvisoryFlock(lockFilePath, maintenanceSteps, hostIo),
    { hostIo, nowMs: nowMsFn, isPidAlive: pidAliveFn, operation, timeoutMs: 0 },
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
