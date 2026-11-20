import { randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  toBoundedReason,
  toErrorReasonMessage,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { isLocalPidAlive } from "./flock-lock.js"

const RAW_STARTUP_LOCK_GRACE_MS = 2_000
const DEFAULT_STARTUP_LOCK_OPERATION = WorkflowStoreOperation.make("OmnigraphCluster.startupLock")

const StartupLockJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Finite),
    lockToken: Schema.optional(Schema.String),
    createdAtMs: Schema.optional(Schema.Finite),
  }),
)

export interface OmnigraphClusterLockHandle {
  readonly lockPath: string
  readonly lockToken: string
}

export interface ClusterLockAcquired {
  readonly _tag: "Acquired"
  readonly handle: OmnigraphClusterLockHandle
}

export interface ClusterLockContended {
  readonly _tag: "Contended"
}

export interface ClusterLockFailed {
  readonly _tag: "Failed"
  readonly reason: string
}

export type OmnigraphClusterLockAttemptResult =
  | ClusterLockAcquired
  | ClusterLockContended
  | ClusterLockFailed

export interface OmnigraphClusterStartupLockOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly nowMs?: (() => number) | undefined
  readonly isPidAlive?: ((pid: number) => boolean) | undefined
  readonly operation?: WorkflowStoreOperation | undefined
  readonly timeoutMs?: number | undefined
}

const isStaleLockFilePayload = (
  filePath: string,
  raw: string,
  hostIo: ExtendedHostIo,
  nowMsFn: () => number,
  pidAliveFn: (pid: number) => boolean,
): boolean =>
  match(Schema.decodeOption(StartupLockJsonSchema)(raw))
    .with(
      { _tag: "Some" },
      ({ value }) => !(typeof value.pid === "number" && pidAliveFn(value.pid)),
    )
    .with({ _tag: "None" }, () => {
      const mtimeMs = hostIo.statMtimeMsSync(filePath)
      return mtimeMs !== undefined && nowMsFn() - mtimeMs >= RAW_STARTUP_LOCK_GRACE_MS
    })
    .exhaustive()

const tryAcquireBreakerFile = (
  breakerPath: string,
  hostIo: ExtendedHostIo,
  nowMsFn: () => number,
  pidAliveFn: (pid: number) => boolean,
): boolean => {
  const breakerPayload = JSON.stringify({ pid: process.pid, createdAtMs: nowMsFn() })
  for (let i = 0; i < 2; i += 1) {
    const attempt = match(hostIo.tryWriteExclusiveTextSync(breakerPath, breakerPayload, 0o600))
      .with({ _tag: "Written" }, () => "acquired" as const)
      .with({ _tag: "Failed" }, () => "failed" as const)
      .with({ _tag: "Exists" }, () => "exists" as const)
      .exhaustive()
    if (attempt === "acquired") return true
    if (attempt === "failed") return false
    if (hostIo.isSymbolicLinkSync(breakerPath)) return false
    const existingRaw = Result.try(() => hostIo.readTextSync(breakerPath))
    const staleBreaker = match(existingRaw)
      .with({ _tag: "Success" }, ({ success }) =>
        isStaleLockFilePayload(breakerPath, success, hostIo, nowMsFn, pidAliveFn),
      )
      .with({ _tag: "Failure" }, () => !hostIo.existsSync(breakerPath))
      .exhaustive()
    if (!staleBreaker) return false
    Result.try(() => {
      if (hostIo.existsSync(breakerPath) && !hostIo.isSymbolicLinkSync(breakerPath)) {
        hostIo.unlinkSync(breakerPath)
      }
    })
  }
  return false
}

const compareAndUnlinkStaleStartupLock = (
  lockPath: string,
  expectedRaw: string,
  hostIo: ExtendedHostIo,
  nowMsFn: () => number,
  pidAliveFn: (pid: number) => boolean,
): boolean => {
  const breakerPath = `${lockPath}.breaking`
  if (!tryAcquireBreakerFile(breakerPath, hostIo, nowMsFn, pidAliveFn)) {
    return false
  }
  const removed = Result.getOrElse(
    Result.try(() => {
      if (hostIo.isSymbolicLinkSync(lockPath)) return false
      if (hostIo.readTextSync(lockPath) !== expectedRaw) return false
      hostIo.unlinkSync(lockPath)
      return true
    }),
    () => false,
  )
  match(
    Result.try({
      try: () => {
        if (!hostIo.isSymbolicLinkSync(breakerPath) && hostIo.existsSync(breakerPath)) {
          hostIo.unlinkSync(breakerPath)
        }
      },
      catch: (e) => toErrorReasonMessage(e, `Failed to unlink breaker ${breakerPath}`),
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:omnigraph] Warning: failed to unlink startup breaker ${breakerPath}: ${failure}\n`,
      )
    })
    .exhaustive()
  return removed
}

/**
 * Performs one non-blocking `O_EXCL` attempt to acquire `<clusterRootDir>.startup.lock`,
 * breaking stale locks whose owner PID is dead (or undecodable past the raw-lock grace window).
 */
const tryAcquireOmnigraphClusterLock = (
  clusterRootDir: string,
  options?: OmnigraphClusterStartupLockOptions,
): OmnigraphClusterLockAttemptResult => {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const nowMsFn = options?.nowMs ?? (() => Date.now())
  const pidAliveFn = options?.isPidAlive ?? isLocalPidAlive
  const lockParent = dirname(clusterRootDir)
  const mkdirErr = match(
    Result.try({
      try: () => {
        if (!hostIo.existsSync(lockParent)) {
          hostIo.mkdirRecursiveSync(lockParent, 0o700)
        }
      },
      catch: (err) => toErrorReasonMessage(err, `Failed to prepare lock dir ${lockParent}`),
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (mkdirErr !== undefined) {
    return { _tag: "Failed", reason: mkdirErr }
  }

  const lockPath = `${clusterRootDir}.startup.lock`
  if (hostIo.isSymbolicLinkSync(lockPath)) {
    return { _tag: "Failed", reason: `Refusing symlink cluster startup lock: ${lockPath}` }
  }

  const lockToken = randomBytes(16).toString("hex")
  const payload = JSON.stringify({ pid: process.pid, lockToken, createdAtMs: nowMsFn() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const writeStep = match(hostIo.tryWriteExclusiveTextSync(lockPath, payload, 0o600))
      .with({ _tag: "Written" }, () => ({
        done: true as const,
        result: { _tag: "Acquired" as const, handle: { lockPath, lockToken } },
      }))
      .with({ _tag: "Failed" }, ({ message }) => ({
        done: true as const,
        result: { _tag: "Failed" as const, reason: message },
      }))
      .with({ _tag: "Exists" }, () => ({ done: false as const, result: undefined }))
      .exhaustive()
    if (writeStep.done) {
      return writeStep.result
    }

    const readOutcome = match(Result.try(() => hostIo.readTextSync(lockPath)))
      .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, raw: success }))
      .with({ _tag: "Failure" }, () => ({ ok: false as const, raw: "" }))
      .exhaustive()
    if (!readOutcome.ok) {
      if (!hostIo.existsSync(lockPath)) continue
      return { _tag: "Contended" }
    }

    const raw = readOutcome.raw
    const canUnlinkStale = isStaleLockFilePayload(lockPath, raw, hostIo, nowMsFn, pidAliveFn)

    if (
      !canUnlinkStale ||
      !compareAndUnlinkStaleStartupLock(lockPath, raw, hostIo, nowMsFn, pidAliveFn)
    ) {
      return { _tag: "Contended" }
    }
  }
  return { _tag: "Contended" }
}

/** Releases a previously acquired `.startup.lock` handle if still owned by this process and token. */
const releaseOmnigraphClusterLock = (
  handle: OmnigraphClusterLockHandle | string | undefined,
  hostIo: ExtendedHostIo = nodeSyncHostIo,
): Result.Result<void, string> => {
  if (handle === undefined) {
    return Result.void
  }
  const targetPath = typeof handle === "string" ? handle : handle.lockPath
  return Result.try({
    try: () => {
      if (typeof handle === "string") {
        if (hostIo.existsSync(handle) && !hostIo.isSymbolicLinkSync(handle)) {
          hostIo.unlinkSync(handle)
        }
        return
      }
      if (hostIo.isSymbolicLinkSync(handle.lockPath) || !hostIo.existsSync(handle.lockPath)) {
        return
      }
      const parsedOpt = Schema.decodeOption(StartupLockJsonSchema)(
        hostIo.readTextSync(handle.lockPath),
      )
      const isOwner = match(parsedOpt)
        .with(
          { _tag: "Some" },
          ({ value }) => value.pid === process.pid && value.lockToken === handle.lockToken,
        )
        .with({ _tag: "None" }, () => false)
        .exhaustive()
      if (isOwner) {
        hostIo.unlinkSync(handle.lockPath)
      }
    },
    catch: (err) => toErrorReasonMessage(err, `Failed to release startup lock ${targetPath}`),
  })
}

/** Polls `tryAcquireOmnigraphClusterLock` until acquired or `timeoutMs` expires. */
export const acquireOmnigraphClusterLockEffect = Effect.fn("OmnigraphCluster.acquireStartupLock")(
  function* (
    clusterRootDir: string,
    options?: OmnigraphClusterStartupLockOptions,
  ): Effect.fn.Return<OmnigraphClusterLockHandle, WorkflowStoreUnavailableError> {
    const nowMsFn = options?.nowMs ?? (() => Date.now())
    const operation = options?.operation ?? DEFAULT_STARTUP_LOCK_OPERATION
    const timeoutMs = Math.max(0, options?.timeoutMs ?? 0)
    const deadlineMs = nowMsFn() + timeoutMs
    while (true) {
      const attempt = tryAcquireOmnigraphClusterLock(clusterRootDir, options)
      const resolved = yield* match(attempt)
        .with({ _tag: "Acquired" }, ({ handle }) => Effect.succeed({ done: true as const, handle }))
        .with({ _tag: "Failed" }, ({ reason }) =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation,
              reason: toBoundedReason(
                `Startup lock ${clusterRootDir}.startup.lock failed: ${reason}`,
              ),
            }),
          ),
        )
        .with({ _tag: "Contended" }, () =>
          Effect.succeed({ done: false as const, handle: undefined }),
        )
        .exhaustive()
      if (resolved.done) {
        return resolved.handle
      }
      if (nowMsFn() >= deadlineMs) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(`Cluster startup lock held at ${clusterRootDir}.startup.lock`),
        })
      }
      yield* Effect.sleep("100 millis")
    }
  },
)

/**
 * Canonical cluster startup-lock guard (`<clusterDir>.startup.lock`) shared by CLI
 * cluster lifecycle operations and offline Lance maintenance, ensuring deterministic
 * `Effect.acquireUseRelease` lock release and warning-logged cleanup failures.
 */
const withOmnigraphClusterStartupLock = <A, E, R>(
  clusterDir: string,
  use: Effect.Effect<A, E, R>,
  options?: OmnigraphClusterStartupLockOptions,
): Effect.Effect<A, E | WorkflowStoreUnavailableError, R> => {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  return Effect.acquireUseRelease(
    acquireOmnigraphClusterLockEffect(clusterDir, options),
    () => use,
    (handle) =>
      match(releaseOmnigraphClusterLock(handle, hostIo))
        .with({ _tag: "Success" }, () => Effect.void)
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.logWarning(
            `Failed to release cluster startup lock ${handle.lockPath}: ${failure}`,
          ),
        )
        .exhaustive(),
  )
}

export {
  releaseOmnigraphClusterLock,
  tryAcquireOmnigraphClusterLock,
  withOmnigraphClusterStartupLock,
}
