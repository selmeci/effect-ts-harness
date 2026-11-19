import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { Readable, Writable } from "node:stream"
import { Effect, Option, Result, Schema } from "effect"
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
import {
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"

const FLOCK_BIN_PATH = "/usr/bin/flock"
const CAT_BIN_PATH = "/usr/bin/cat"
const FLOCK_CONFLICT_EXIT_CODE = 75

const WriterLeaseMetaSchema = Schema.Struct({
  holderId: Schema.String,
  holderPid: Schema.Int,
  leaseEpoch: Schema.Int,
  acquiredAtMs: Schema.Finite,
  holderStartTime: Schema.optional(Schema.String),
})
type WriterLeaseMeta = typeof WriterLeaseMetaSchema.Type
const decodeWriterLeaseMetaOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(WriterLeaseMetaSchema),
)

const metaFilePathFor = (lockFilePath: LeaseFilePath): string => `${lockFilePath}.meta.json`

const safeDecodeLeaseHolderId = (raw: string): LeaseHolderId =>
  match(Schema.decodeOption(LeaseHolderId)(raw.trim().slice(0, 256)))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => LeaseHolderId.make("unknown-holder"))
    .exhaustive()

const safeDecodeLeaseEpoch = (raw: unknown): LeaseEpoch => {
  const num = parseFiniteNumberOrString(raw)
  return num !== undefined && Number.isSafeInteger(num) && num >= 0
    ? LeaseEpoch.make(num)
    : LeaseEpoch.make(0)
}

const safeDecodeLeaseHolderPid = (raw: unknown): LeaseHolderPid | undefined => {
  const num = parseFiniteNumberOrString(raw)
  return num !== undefined && Number.isSafeInteger(num) && num >= 1
    ? LeaseHolderPid.make(num)
    : undefined
}

const makeHeldLeaseError = (
  holderId: string,
  leaseEpoch: LeaseEpoch,
  lockFilePath: LeaseFilePath,
  holderPid: number | undefined,
): WriterLeaseHeldError => {
  const decodedPid = safeDecodeLeaseHolderPid(holderPid)
  return new WriterLeaseHeldError({
    holderId: safeDecodeLeaseHolderId(holderId),
    leaseEpoch,
    lockFilePath,
    ...(decodedPid !== undefined ? { holderPid: decodedPid } : {}),
  })
}

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

const readLockMeta = (metaPath: string, hostIo: ExtendedHostIo): Option.Option<WriterLeaseMeta> => {
  if (hostIo.isSymbolicLinkSync(metaPath) || !hostIo.existsSync(metaPath)) {
    return Option.none()
  }
  return match(Result.try(() => hostIo.readTextSync(metaPath)))
    .with({ _tag: "Failure" }, () => Option.none())
    .with({ _tag: "Success" }, ({ success }) => decodeWriterLeaseMetaOption(success))
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
      Result.try(() => {
        if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
      })
      return toErrorReasonMessage(err, `Failed to write ${metaPath}`)
    },
  })
}

const unlinkLockMetaIfOwned = (
  metaPath: string,
  holderId: LeaseHolderId,
  holderPid: LeaseHolderPid,
  hostIo: ExtendedHostIo,
): void => {
  match(readLockMeta(metaPath, hostIo))
    .with({ _tag: "Some" }, ({ value }) => {
      if (
        value.holderId === holderId &&
        value.holderPid === holderPid &&
        !hostIo.isSymbolicLinkSync(metaPath) &&
        hostIo.existsSync(metaPath)
      ) {
        Result.try(() => {
          hostIo.unlinkSync(metaPath)
        })
      }
    })
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

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

const acquireOsFlock = (
  lockFilePath: LeaseFilePath,
  metaPath: string,
  hostIo: ExtendedHostIo,
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
      let stdoutBuf = ""
      let stderrBuf = ""

      const failAndCleanup = (err: WriterLeaseHeldError | WorkflowStoreUnavailableError): void => {
        if (settled) return
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
        if (settled) return
        if (code === FLOCK_CONFLICT_EXIT_CODE) {
          const heldErr = match(readLockMeta(metaPath, hostIo))
            .with({ _tag: "Some" }, ({ value }) =>
              makeHeldLeaseError(
                value.holderId,
                safeDecodeLeaseEpoch(value.leaseEpoch),
                lockFilePath,
                value.holderPid,
              ),
            )
            .with({ _tag: "None" }, () =>
              makeHeldLeaseError("unknown-holder", LeaseEpoch.make(0), lockFilePath, undefined),
            )
            .exhaustive()
          failAndCleanup(heldErr)
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
  makeHeldLeaseError,
  metaFilePathFor,
  prepareLockPathsAndModes,
  readLinuxProcStartTime,
  readLockMeta,
  safeDecodeLeaseEpoch,
  stopFlockChild,
  unlinkLockMetaIfOwned,
  withAdvisoryFlock,
  writeLockMetaAtomic,
  type FlockChild,
  type WriterLeaseMeta,
}
