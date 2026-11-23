import { type ChildProcess, spawn } from "node:child_process"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import type { WorkspaceFsError } from "@harness/contract"
import type { SyncHostExecResult } from "@harness/service/host-io"

const MAX_CAPTURE_BYTES = 64 * 1024
const STDIO_DRAIN_GRACE_MS = 100
const KILL_GRACE_MS = 500
const POST_KILL_SETTLE_MS = 150
const GROUP_POLL_INTERVAL_MS = 10

interface BoundedTailBuffer {
  chunks: Array<Buffer>
  totalBytes: number
}

const createBoundedTailBuffer = (): BoundedTailBuffer => ({
  chunks: [],
  totalBytes: 0,
})

const appendBoundedTailChunk = (state: BoundedTailBuffer, chunk: Buffer | string): void => {
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
  if (buf.length === 0) {
    return
  }
  if (buf.length >= MAX_CAPTURE_BYTES) {
    state.chunks = [buf.subarray(buf.length - MAX_CAPTURE_BYTES)]
    state.totalBytes = MAX_CAPTURE_BYTES
    return
  }
  state.chunks.push(buf)
  state.totalBytes += buf.length
  while (state.totalBytes > MAX_CAPTURE_BYTES && state.chunks.length > 0) {
    const overflow = state.totalBytes - MAX_CAPTURE_BYTES
    const head = state.chunks[0]!
    if (head.length <= overflow) {
      state.chunks.shift()
      state.totalBytes -= head.length
    } else {
      state.chunks[0] = head.subarray(overflow)
      state.totalBytes -= overflow
    }
  }
}

const readBoundedTailText = (state: BoundedTailBuffer): string =>
  state.totalBytes === 0 ? "" : Buffer.concat(state.chunks, state.totalBytes).toString("utf8")

/**
 * Sends a signal to a POSIX process group (`-pgid`) without checking `child.exitCode`,
 * allowing callers to signal or reap surviving descendants after the direct child exits.
 */
const killProcessGroupPosix = (pgid: number, signal: NodeJS.Signals | 0): boolean =>
  process.platform !== "win32" &&
  match(
    Result.try(() => {
      process.kill(-pgid, signal)
    }),
  )
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()

/**
 * Sends a signal to the detached child's process group on POSIX when `child.pid` is available,
 * falling back cleanly to `child.kill(signal)` on Windows or ESRCH/exit races.
 */
const signalChildProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (child.pid !== undefined && killProcessGroupPosix(child.pid, signal)) {
    return
  }
  match(
    Result.try(() => {
      child.kill(signal)
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
}

const isProcessGroupAlive = (pgid: number): boolean => killProcessGroupPosix(pgid, 0)

interface ReapProcessGroupOptions {
  readonly pgid: number | undefined
  readonly termGraceMs: number
  readonly sigtermSent: boolean
  readonly sigkillSent: boolean
  readonly onSigtermSent: () => void
  readonly onSigkillSent: () => void
  readonly onSettled: () => void
}

/**
 * Reaps any remaining members of a POSIX process group with bounded
 * `SIGTERM` grace -> `SIGKILL` (`-pgid`) -> post-kill settle timing.
 * Does not gate on `child.exitCode`, so grandchildren surviving after direct child exit are still killed.
 */
const reapProcessGroup = (opts: ReapProcessGroupOptions): (() => void) => {
  const { pgid } = opts
  if (pgid === undefined || !isProcessGroupAlive(pgid)) {
    opts.onSettled()
    return () => {}
  }

  let sigtermSent = opts.sigtermSent
  let sigkillSent = opts.sigkillSent
  if (!sigtermSent && !sigkillSent) {
    sigtermSent = true
    opts.onSigtermSent()
    killProcessGroupPosix(pgid, "SIGTERM")
  }

  const now0 = Date.now()
  let postKillDeadlineMs: number | undefined = sigkillSent ? now0 + POST_KILL_SETTLE_MS : undefined
  const termDeadlineMs = now0 + Math.max(0, opts.termGraceMs)

  if (postKillDeadlineMs === undefined && now0 >= termDeadlineMs) {
    sigkillSent = true
    opts.onSigkillSent()
    killProcessGroupPosix(pgid, "SIGKILL")
    postKillDeadlineMs = now0 + POST_KILL_SETTLE_MS
  }

  let done = false
  const groupPoll = setInterval(() => {
    if (done) {
      return
    }
    if (!isProcessGroupAlive(pgid)) {
      done = true
      clearInterval(groupPoll)
      opts.onSettled()
      return
    }
    const nowMs = Date.now()
    if (postKillDeadlineMs !== undefined) {
      if (nowMs >= postKillDeadlineMs) {
        done = true
        clearInterval(groupPoll)
        opts.onSettled()
      }
      return
    }
    if (nowMs >= termDeadlineMs) {
      sigkillSent = true
      opts.onSigkillSent()
      killProcessGroupPosix(pgid, "SIGKILL")
      postKillDeadlineMs = nowMs + POST_KILL_SETTLE_MS
    }
  }, GROUP_POLL_INTERVAL_MS)
  groupPoll.unref()

  return () => {
    if (done) {
      return
    }
    done = true
    clearInterval(groupPoll)
  }
}

/**
 * Spawns a verification command in its own process group with bounded tail stdio capture,
 * timeout enforcement, and deterministic process-group termination on timeout or fiber interruption.
 */
const spawnVerifyCommand = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
  },
): Effect.Effect<SyncHostExecResult, WorkspaceFsError> =>
  Effect.callback<SyncHostExecResult, WorkspaceFsError>((resume) => {
    let settled = false
    let timedOut = false
    let childExited = false
    let childClosed = false
    let sigtermSent = false
    let sigtermSentAtMs: number | undefined = undefined
    let sigkillSent = false
    let reapComplete = false
    let reapCancel: (() => void) | undefined = undefined
    let exitOutcome:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined = undefined
    const stdoutBuf = createBoundedTailBuffer()
    const stderrBuf = createBoundedTailBuffer()
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let stdioDrainTimer: ReturnType<typeof setTimeout> | undefined = undefined
    const exitWaiters: Array<() => void> = []

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })

    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendBoundedTailChunk(stdoutBuf, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendBoundedTailChunk(stderrBuf, chunk)
    })

    const sendGroupOrChildSignal = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined && killProcessGroupPosix(child.pid, signal)) {
        return
      }
      signalChildProcessGroup(child, signal)
    }

    const terminateChild = (): void => {
      if (sigtermSent || child.killed) {
        if (!sigkillSent) {
          const groupAlive = child.pid !== undefined && isProcessGroupAlive(child.pid)
          if (!childExited || groupAlive) {
            sigkillSent = true
            sendGroupOrChildSignal("SIGKILL")
          }
        }
        return
      }
      if (childExited || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      sigtermSent = true
      sigtermSentAtMs = Date.now()
      sendGroupOrChildSignal("SIGTERM")
      killGraceTimer = setTimeout(() => {
        if (sigkillSent) {
          return
        }
        const groupAlive = child.pid !== undefined && isProcessGroupAlive(child.pid)
        if ((!childExited && child.exitCode === null && child.signalCode === null) || groupAlive) {
          sigkillSent = true
          sendGroupOrChildSignal("SIGKILL")
        }
      }, KILL_GRACE_MS)
      killGraceTimer.unref()
    }

    const timeoutTimer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild()
          }, opts.timeoutMs)
        : undefined
    if (timeoutTimer !== undefined) {
      timeoutTimer.unref()
    }

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
      }
      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer)
      }
    }

    const destroyStdio = (): void => {
      child.stdout?.removeAllListeners("data")
      child.stdout?.destroy()
      child.stderr?.removeAllListeners("data")
      child.stderr?.destroy()
    }

    const notifyChildExit = (): void => {
      childExited = true
      while (exitWaiters.length > 0) {
        const waiter = exitWaiters.shift()
        if (waiter !== undefined) {
          waiter()
        }
      }
    }

    const settleWithExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()
      destroyStdio()
      const stdout = readBoundedTailText(stdoutBuf)
      const stderr = readBoundedTailText(stderrBuf)
      if (timedOut) {
        resume(
          Effect.succeed({
            _tag: "TimedOut",
            stdout,
            stderr,
            ...(signal !== null ? { signal } : {}),
          }),
        )
        return
      }
      if (signal !== null) {
        resume(
          Effect.succeed({
            _tag: "Signaled",
            signal,
            stdout,
            stderr,
          }),
        )
        return
      }
      resume(
        Effect.succeed({
          _tag: "Exited",
          exitCode: code ?? 1,
          stdout,
          stderr,
        }),
      )
    }

    const scheduleStdioDrainOrSettle = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return
      }
      if (childClosed) {
        settleWithExit(code, signal)
        return
      }
      if (stdioDrainTimer === undefined) {
        stdioDrainTimer = setTimeout(() => {
          settleWithExit(code, signal)
        }, STDIO_DRAIN_GRACE_MS)
        stdioDrainTimer.unref()
      }
    }

    const handleTimedOutChildEvent = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      exitOutcome = { code, signal }
      const pgid = child.pid
      if (reapComplete || pgid === undefined || !isProcessGroupAlive(pgid)) {
        reapComplete = true
        scheduleStdioDrainOrSettle(code, signal)
        return
      }
      if (reapCancel !== undefined) {
        return
      }
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
        killGraceTimer = undefined
      }
      const elapsedSinceTermMs =
        sigtermSentAtMs !== undefined ? Math.max(0, Date.now() - sigtermSentAtMs) : 0
      const remainingGraceMs = Math.max(0, KILL_GRACE_MS - elapsedSinceTermMs)
      reapCancel = reapProcessGroup({
        pgid,
        termGraceMs: remainingGraceMs,
        sigtermSent,
        sigkillSent,
        onSigtermSent: () => {
          sigtermSent = true
          sigtermSentAtMs = Date.now()
        },
        onSigkillSent: () => {
          sigkillSent = true
        },
        onSettled: () => {
          reapCancel = undefined
          reapComplete = true
          if (settled) {
            return
          }
          const finalOutcome = exitOutcome ?? { code, signal }
          scheduleStdioDrainOrSettle(finalOutcome.code, finalOutcome.signal)
        },
      })
    }

    child.once("error", (err) => {
      notifyChildExit()
      if (settled) {
        return
      }
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()
      destroyStdio()
      resume(
        Effect.succeed({
          _tag: "SpawnFailed",
          spawnError: err.message,
          stdout: readBoundedTailText(stdoutBuf),
          stderr: readBoundedTailText(stderrBuf),
        }),
      )
    })

    child.once("exit", (code, signal) => {
      notifyChildExit()
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
      if (settled) {
        return
      }
      if (timedOut) {
        handleTimedOutChildEvent(code, signal)
        return
      }
      if (stdioDrainTimer === undefined) {
        stdioDrainTimer = setTimeout(() => {
          settleWithExit(code, signal)
        }, STDIO_DRAIN_GRACE_MS)
        stdioDrainTimer.unref()
      }
    })

    child.once("close", (code, signal) => {
      notifyChildExit()
      childClosed = true
      if (settled) {
        return
      }
      if (timedOut) {
        handleTimedOutChildEvent(code, signal)
        return
      }
      settleWithExit(code, signal)
    })

    return Effect.callback<void>((done) => {
      const sigtermAlreadySentBeforeInterrupt = sigtermSent
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()

      let finalized = false
      const finishInterrupt = (): void => {
        if (finalized) {
          return
        }
        finalized = true
        reapCancel = undefined
        done(Effect.void)
      }

      const awaitProcessGroupExit = (): void => {
        cleanupTimers()
        destroyStdio()
        const termGraceMs = sigtermAlreadySentBeforeInterrupt
          ? 0
          : sigtermSentAtMs !== undefined
            ? Math.max(0, sigtermSentAtMs + KILL_GRACE_MS - Date.now())
            : KILL_GRACE_MS
        reapCancel = reapProcessGroup({
          pgid: child.pid,
          termGraceMs,
          sigtermSent,
          sigkillSent,
          onSigtermSent: () => {
            sigtermSent = true
            sigtermSentAtMs = Date.now()
          },
          onSigkillSent: () => {
            sigkillSent = true
          },
          onSettled: finishInterrupt,
        })
      }

      if (childExited || child.exitCode !== null || child.signalCode !== null) {
        awaitProcessGroupExit()
        return
      }
      exitWaiters.push(awaitProcessGroupExit)
      terminateChild()
    })
  })

export { signalChildProcessGroup, spawnVerifyCommand }
