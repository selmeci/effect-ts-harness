import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { Readable, Writable } from "node:stream"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  LeaseEpoch,
  type LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  toErrorReasonMessage,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { toWorkflowStoreUnavailableError } from "../omnigraph-workflow-store.js"
import { makeHeldLeaseError } from "./writer-lease-codec.js"

const FLOCK_BIN_PATH = "/usr/bin/flock"
const CAT_BIN_PATH = "/usr/bin/cat"
const FLOCK_CONFLICT_EXIT_CODE = 75
const UNKNOWN_FLOCK_HOLDER = LeaseHolderId.make("unknown-holder")

const WriterLeaseMetaSchema = Schema.Struct({
  holderId: LeaseHolderId,
  holderPid: LeaseHolderPid,
  leaseEpoch: LeaseEpoch.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  acquiredAtMs: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  holderStartTime: Schema.optional(Schema.NonEmptyString),
})
export type WriterLeaseMeta = typeof WriterLeaseMetaSchema.Type

const decodeWriterLeaseMetaResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(WriterLeaseMetaSchema),
)

export interface LockMetaMissing {
  readonly _tag: "Missing"
}

export interface LockMetaValid {
  readonly _tag: "Valid"
  readonly meta: WriterLeaseMeta
}

export interface LockMetaCorrupt {
  readonly _tag: "Corrupt"
  readonly reason: string
}

export type LockMetaReadResult = LockMetaMissing | LockMetaValid | LockMetaCorrupt

const metaFilePathFor = (lockFilePath: LeaseFilePath): string => `${lockFilePath}.meta.json`

const readLinuxProcStartTime = (pid: number, hostIo: ExtendedHostIo): string | undefined => {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) {
    return undefined
  }
  const statPath = `/proc/${pid}/stat`
  return Result.getOrElse(
    Result.try(() => {
      const raw = hostIo.readTextSync(statPath)
      const commEnd = raw.lastIndexOf(")")
      if (commEnd < 0) return undefined
      const tailFields = raw
        .slice(commEnd + 1)
        .trim()
        .split(/\s+/)
      // Field 22 (starttime) is index 19 after "(comm)" (fields 3..22).
      const startTicks = tailFields[19]
      return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined
    }),
    () => undefined,
  )
}

const isLocalPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid < 1) {
    return false
  }
  const probe = Result.try({
    try: () => {
      process.kill(pid, 0)
    },
    catch: (err) =>
      typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
        ? err.code
        : "UNKNOWN",
  })
  return match(probe)
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, ({ failure }) => failure !== "ESRCH")
    .exhaustive()
}

const prepareLockPathsAndModes = (
  lockFilePath: LeaseFilePath,
  metaPath: string,
  hostIo: ExtendedHostIo,
): Result.Result<void, string> => {
  const lockDir = dirname(lockFilePath)
  if (hostIo.isSymbolicLinkSync(lockDir)) {
    return Result.fail(`Refusing symlink lock directory: ${lockDir}`)
  }
  if (hostIo.isSymbolicLinkSync(lockFilePath)) {
    return Result.fail(`Refusing symlink lock file: ${lockFilePath}`)
  }
  if (hostIo.isSymbolicLinkSync(metaPath)) {
    return Result.fail(`Refusing symlink lock metadata file: ${metaPath}`)
  }
  return Result.try({
    try: () => {
      hostIo.mkdirRecursiveSync(lockDir, 0o700)
      hostIo.chmodSync(lockDir, 0o700)
    },
    catch: (err) => toErrorReasonMessage(err, `Failed to prepare lock dir ${lockDir}`),
  })
}

const readLockMeta = (metaPath: string, hostIo: ExtendedHostIo): LockMetaReadResult => {
  const probeOutcome = Result.try({
    try: () => {
      if (hostIo.isSymbolicLinkSync(metaPath)) {
        return { _tag: "Symlink" as const }
      }
      if (!hostIo.existsSync(metaPath)) {
        return { _tag: "Missing" as const }
      }
      return { _tag: "Text" as const, raw: hostIo.readTextSync(metaPath) }
    },
    catch: (err) => toErrorReasonMessage(err, `Failed to inspect lock metadata at ${metaPath}`),
  })
  return match(probeOutcome)
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Corrupt" as const, reason: failure }))
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Symlink" }, () => ({
          _tag: "Corrupt" as const,
          reason: `Refusing symlink lock metadata file: ${metaPath}`,
        }))
        .with({ _tag: "Missing" }, () => ({ _tag: "Missing" as const }))
        .with({ _tag: "Text" }, ({ raw }) =>
          match(decodeWriterLeaseMetaResult(raw))
            .with({ _tag: "Success" }, ({ success: meta }) => ({
              _tag: "Valid" as const,
              meta,
            }))
            .with({ _tag: "Failure" }, ({ failure }) => ({
              _tag: "Corrupt" as const,
              reason: toErrorReasonMessage(failure, `Corrupt lock metadata JSON at ${metaPath}`),
            }))
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
}

const writeLockMetaAtomic = (
  metaPath: string,
  meta: WriterLeaseMeta,
  hostIo: ExtendedHostIo,
): Result.Result<void, string> => {
  if (hostIo.isSymbolicLinkSync(metaPath)) {
    return Result.fail(`Refusing symlink lock metadata file: ${metaPath}`)
  }
  const tmpPath = `${metaPath}.${process.pid}.${randomUUID()}.tmp`
  return Result.try({
    try: () => {
      const metaDir = dirname(metaPath)
      hostIo.mkdirRecursiveSync(metaDir, 0o700)
      hostIo.chmodSync(metaDir, 0o700)
      hostIo.writeTextWithModeSync(tmpPath, JSON.stringify(meta), 0o600)
      hostIo.renameSync(tmpPath, metaPath)
      hostIo.chmodSync(metaPath, 0o600)
    },
    catch: (err) => {
      const baseMsg = toErrorReasonMessage(err, `Failed to write ${metaPath}`)
      const unlinkRes = Result.try({
        try: () => {
          if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
        },
        catch: (unlinkErr) => toErrorReasonMessage(unlinkErr, `Failed to unlink ${tmpPath}`),
      })
      return match(unlinkRes)
        .with({ _tag: "Success" }, () => baseMsg)
        .with({ _tag: "Failure" }, ({ failure }) => `${baseMsg} (temp cleanup failed: ${failure})`)
        .exhaustive()
    },
  })
}

const unlinkLockMetaIfOwned = (
  metaPath: string,
  holderId: LeaseHolderId,
  holderPid: LeaseHolderPid,
  hostIo: ExtendedHostIo,
): Result.Result<void, string> =>
  match(readLockMeta(metaPath, hostIo))
    .with({ _tag: "Missing" }, () => Result.void)
    .with({ _tag: "Corrupt" }, ({ reason }) => Result.fail(reason))
    .with({ _tag: "Valid" }, ({ meta }) => {
      if (meta.holderId === holderId && meta.holderPid === holderPid) {
        return Result.try({
          try: () => {
            if (!hostIo.isSymbolicLinkSync(metaPath) && hostIo.existsSync(metaPath)) {
              hostIo.unlinkSync(metaPath)
            }
          },
          catch: (err) => toErrorReasonMessage(err, `Failed to unlink ${metaPath}`),
        })
      }
      return Result.void
    })
    .exhaustive()

type FlockChild = ChildProcessByStdio<Writable, Readable, Readable>

const isChildTerminated = (child: FlockChild): boolean =>
  child.exitCode !== null || child.signalCode !== null

const isBenignStreamError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")

const destroyFlockStreams = (child: FlockChild): void => {
  Result.try(() => {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  })
}

const stopFlockChild = (child: FlockChild): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (isChildTerminated(child)) {
      destroyFlockStreams(child)
      resume(Effect.void)
      return
    }

    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      destroyFlockStreams(child)
      resume(Effect.void)
    }

    child.once("exit", finish)
    child.once("close", finish)

    if (isChildTerminated(child)) {
      finish()
      return
    }

    Result.try(() => {
      child.stdin.end()
    })
    Result.try(() => {
      child.kill("SIGTERM")
    })

    killTimer = setTimeout(() => {
      if (settled || isChildTerminated(child)) {
        finish()
        return
      }
      Result.try(() => {
        child.kill("SIGKILL")
      })
      fallbackTimer = setTimeout(finish, 250)
      fallbackTimer.unref?.()
    }, 250)
    killTimer.unref?.()
  })

export interface AcquireOsFlockOptions {
  readonly onUnexpectedLoss?: (() => void) | undefined
}

const acquireOsFlock = (
  lockFilePath: LeaseFilePath,
  metaPath: string,
  hostIo: ExtendedHostIo,
  options?: AcquireOsFlockOptions,
): Effect.Effect<FlockChild, WriterLeaseHeldError | WorkflowStoreUnavailableError> => {
  const operation = WorkflowStoreOperation.make("WfWriterLease.acquire")
  return Effect.callback<FlockChild, WriterLeaseHeldError | WorkflowStoreUnavailableError>(
    (resume) => {
      const child = spawn(
        FLOCK_BIN_PATH,
        ["-n", "-F", "-E", String(FLOCK_CONFLICT_EXIT_CODE), "--", lockFilePath, CAT_BIN_PATH],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      )

      let settled = false
      let lossNotified = false
      let stdoutBuf = ""
      let stderrBuf = ""

      const notifyUnexpectedLoss = (): void => {
        if (!settled || lossNotified) return
        lossNotified = true
        options?.onUnexpectedLoss?.()
      }

      const failAndCleanup = (err: WriterLeaseHeldError | WorkflowStoreUnavailableError): void => {
        if (settled) {
          notifyUnexpectedLoss()
          return
        }
        settled = true
        destroyFlockStreams(child)
        if (!isChildTerminated(child)) {
          Result.try(() => {
            child.kill("SIGKILL")
          })
        }
        resume(Effect.fail(err))
      }

      const onStreamError = (streamName: string) => (err: unknown) => {
        if (isBenignStreamError(err)) return
        failAndCleanup(
          toWorkflowStoreUnavailableError(
            operation,
            new Error(`${streamName} error: ${toErrorReasonMessage(err)}`),
          ),
        )
      }

      child.stdin.on("error", onStreamError("flock stdin"))
      child.stdout.on("error", onStreamError("flock stdout"))
      child.stderr.on("error", onStreamError("flock stderr"))

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      })

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return
        stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
        if (stdoutBuf.includes("lock\n")) {
          settled = true
          resume(Effect.succeed(child))
        }
      })

      child.once("error", (err) => {
        failAndCleanup(toWorkflowStoreUnavailableError(operation, err))
      })

      child.once("exit", (code) => {
        if (settled) {
          notifyUnexpectedLoss()
          return
        }
        if (code === FLOCK_CONFLICT_EXIT_CODE) {
          const conflictErr = match(readLockMeta(metaPath, hostIo))
            .with({ _tag: "Valid" }, ({ meta }) =>
              makeHeldLeaseError(meta.holderId, meta.leaseEpoch, lockFilePath, meta.holderPid),
            )
            .with(
              { _tag: "Missing" },
              () =>
                new WriterLeaseHeldError({
                  holderId: UNKNOWN_FLOCK_HOLDER,
                  lockFilePath,
                }),
            )
            .with({ _tag: "Corrupt" }, ({ reason }) =>
              toWorkflowStoreUnavailableError(operation, new Error(reason)),
            )
            .exhaustive()
          failAndCleanup(conflictErr)
          return
        }
        const detail = stderrBuf.trim() || `flock exited unexpectedly with code ${String(code)}`
        failAndCleanup(toWorkflowStoreUnavailableError(operation, detail))
      })

      Result.try({
        try: () => {
          child.stdin.write("lock\n")
        },
        catch: (err) => {
          failAndCleanup(toWorkflowStoreUnavailableError(operation, err))
        },
      })

      return Effect.sync(() => {
        if (!settled && !isChildTerminated(child)) {
          Result.try(() => {
            child.kill("SIGKILL")
          })
        }
      })
    },
  )
}

/**
 * Acquires an exclusive non-blocking OS advisory `flock` on `lockFilePath` for
 * the duration of `use`, releasing the lock deterministically on completion or error.
 */
const withAdvisoryFlock = <A, E, R>(
  lockFilePath: LeaseFilePath,
  use: Effect.Effect<A, E, R>,
  hostIo: ExtendedHostIo = nodeSyncHostIo,
): Effect.Effect<A, E | WriterLeaseHeldError | WorkflowStoreUnavailableError, R> => {
  const metaPath = metaFilePathFor(lockFilePath)
  const flockOp = WorkflowStoreOperation.make("WfWriterLease.flock")
  return Effect.acquireUseRelease(
    match(prepareLockPathsAndModes(lockFilePath, metaPath, hostIo))
      .with({ _tag: "Success" }, () => acquireOsFlock(lockFilePath, metaPath, hostIo))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkflowStoreUnavailableError(flockOp, failure)),
      )
      .exhaustive(),
    () => use,
    (child) => stopFlockChild(child),
  )
}

export {
  acquireOsFlock,
  isLocalPidAlive,
  metaFilePathFor,
  prepareLockPathsAndModes,
  readLinuxProcStartTime,
  readLockMeta,
  stopFlockChild,
  unlinkLockMetaIfOwned,
  withAdvisoryFlock,
  writeLockMetaAtomic,
  type FlockChild,
}
