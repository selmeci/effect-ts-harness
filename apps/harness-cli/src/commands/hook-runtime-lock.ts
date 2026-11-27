import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"

const BUILD_LOCK_FILENAME = ".build.lock"
const BUILD_LOCK_STALE_MS = 60_000
const BUILD_LOCK_MAX_WAIT_MS = 5_000
const BUILD_LOCK_POLL_MS = 40

const BuildLockPayloadSchema = Schema.Struct({
  pid: Schema.Int,
  createdAtMs: Schema.Finite,
  nonce: Schema.NonEmptyString,
})
const decodeBuildLock = Schema.decodeUnknownOption(Schema.fromJsonString(BuildLockPayloadSchema))

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const probe = Result.try(() => {
    process.kill(pid, 0)
    return true
  })
  return match(probe)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const errCode =
        typeof failure === "object" && failure !== null && "code" in failure
          ? (failure as { readonly code?: unknown }).code
          : undefined
      return errCode === "EPERM"
    })
    .exhaustive()
}

const syncSleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
}

/**
 * Serializes `.harness/hook-runtime/current` snapshot directory swaps across concurrent
 * `harness verify` processes using an exclusive PID/nonce lockfile.
 */
export const withHookRuntimeBuildLock = <T>(
  runtimeRootReal: string,
  fn: () => Result.Result<T, string>,
): Result.Result<T, string> => {
  const lockPath = join(runtimeRootReal, BUILD_LOCK_FILENAME)
  const ownerNonce = randomBytes(12).toString("hex")
  const deadlineMs = Date.now() + BUILD_LOCK_MAX_WAIT_MS
  let acquired = false

  while (!acquired) {
    const payload = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), nonce: ownerNonce })
    const res = nodeSyncHostIo.tryWriteExclusiveTextSync(lockPath, payload)
    const retryOrFail = match(res)
      .with({ _tag: "Written" }, () => {
        acquired = true
        return undefined
      })
      .with({ _tag: "Failed" }, ({ message }) => Result.fail(message))
      .with({ _tag: "Exists" }, () => {
        const rawLock = Result.try(() => nodeSyncHostIo.readTextSync(lockPath))
        const existingOpt = match(rawLock)
          .with({ _tag: "Success" }, ({ success }) => decodeBuildLock(success))
          .with({ _tag: "Failure" }, () => undefined)
          .exhaustive()
        const isStale =
          existingOpt !== undefined &&
          match(existingOpt)
            .with({ _tag: "None" }, () => {
              const mtime = nodeSyncHostIo.statMtimeMsSync(lockPath)
              return mtime !== undefined && Date.now() - mtime > 500
            })
            .with(
              { _tag: "Some" },
              ({ value }) =>
                Date.now() - value.createdAtMs > BUILD_LOCK_STALE_MS || !isPidAlive(value.pid),
            )
            .exhaustive()
        if (isStale) {
          const reRead = Result.try(() => nodeSyncHostIo.readTextSync(lockPath))
          const stillSame = match(reRead)
            .with({ _tag: "Success" }, ({ success }) =>
              match(rawLock)
                .with({ _tag: "Success" }, ({ success: prev }) => success === prev)
                .with({ _tag: "Failure" }, () => false)
                .exhaustive(),
            )
            .with({ _tag: "Failure" }, () => false)
            .exhaustive()
          if (stillSame) {
            Result.try(() => nodeSyncHostIo.unlinkSync(lockPath))
          }
        }
        if (Date.now() >= deadlineMs) {
          return Result.fail(`Timed out waiting for hook-runtime build lock at '${lockPath}'`)
        }
        syncSleepMs(BUILD_LOCK_POLL_MS)
        return undefined
      })
      .exhaustive()
    if (retryOrFail !== undefined) return retryOrFail
  }

  const outcome = Result.try(fn)
  const currentRaw = Result.try(() => nodeSyncHostIo.readTextSync(lockPath))
  match(currentRaw)
    .with({ _tag: "Success" }, ({ success }) =>
      match(decodeBuildLock(success))
        .with({ _tag: "Some" }, ({ value }) => {
          if (value.nonce === ownerNonce) {
            Result.try(() => nodeSyncHostIo.unlinkSync(lockPath))
          }
        })
        .with({ _tag: "None" }, () => {})
        .exhaustive(),
    )
    .with({ _tag: "Failure" }, () => {})
    .exhaustive()
  return match(outcome)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(failure instanceof Error ? failure.message : String(failure)),
    )
    .exhaustive()
}
