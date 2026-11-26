import { type ChildProcess, spawn } from "node:child_process"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import type { WorkspaceFsError } from "@harness/contract"
import type { SyncHostExecResult } from "@harness/service/host-io"

const MAX_CAPTURE_BYTES = 64 * 1024
const MAX_HEAD_CAPTURE_BYTES = 1024 * 1024
const DEFAULT_BOUNDED_ASYNC_BYTES = 1024 * 1024
const STDIO_DRAIN_GRACE_MS = 100
const KILL_GRACE_MS = 500
const POST_KILL_SETTLE_MS = 150
const GROUP_POLL_INTERVAL_MS = 10

const getSpawnErrnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined

interface BoundedTailBuffer {
  chunks: Array<Buffer>
  totalBytes: number
}

const createBoundedTailBuffer = (): BoundedTailBuffer => ({ chunks: [], totalBytes: 0 })

const appendBoundedTailChunk = (state: BoundedTailBuffer, chunk: Buffer | string): void => {
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
  if (buf.length === 0) return
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

interface BoundedHeadBuffer {
  readonly chunks: Array<Buffer>
  totalBytes: number
  overflowed: boolean
}

const appendBoundedHeadChunk = (
  state: BoundedHeadBuffer,
  chunk: Buffer | string,
  maxBytes: number,
): void => {
  if (state.overflowed) return
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
  if (buf.length === 0) return
  const remaining = maxBytes - state.totalBytes
  if (buf.length > remaining) {
    if (remaining > 0) {
      state.chunks.push(buf.subarray(0, remaining))
      state.totalBytes += remaining
    }
    state.overflowed = true
    return
  }
  state.chunks.push(buf)
  state.totalBytes += buf.length
}

/** Sends a signal to `-pgid` without gating on `child.exitCode`, allowing survivor reaping after direct child exit. */
const killProcessGroupPosix = (pgid: number, signal: NodeJS.Signals | 0): boolean =>
  process.platform !== "win32" &&
  Number.isInteger(pgid) &&
  pgid >= 2 &&
  pgid !== process.pid &&
  match(
    Result.try(() => {
      process.kill(-pgid, signal)
    }),
  )
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()

/** Sends a signal to the detached child's process group on POSIX, falling back to `child.kill(signal)`. */
const signalChildProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid !== undefined && killProcessGroupPosix(child.pid, signal)) return
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

/** Reaps remaining POSIX process-group members with bounded `SIGTERM` grace -> `SIGKILL` (`-pgid`) -> post-kill settle. */
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
    if (done) return
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
    if (done) return
    done = true
    clearInterval(groupPoll)
  }
}

export type StdoutCaptureMode = "tail-64k" | "head-1m" | "bounded-async"

interface SupervisedProcessGroupPgidHooks<E> {
  readonly onSpawned: (pid: number) => E | undefined
  readonly onSettledCleanup: () => void
}

interface SupervisedProcessGroupOptions<E> {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly timeoutMs: number
  readonly killGraceMs: number
  readonly stdoutCaptureMode: StdoutCaptureMode
  readonly maxBufferBytes?: number | undefined
  readonly mapSpawnThrow?: ((message: string) => E) | undefined
  readonly mapStdoutOverflow?: ((maxBytes: number) => E) | undefined
  readonly pgidRecord?: SupervisedProcessGroupPgidHooks<E> | undefined
}

/**
 * Shared supervised POSIX process-group spawner used by `spawnVerifyCommand`,
 * `spawnSupervisedAgentProcess`, and `execFileAsyncEffect` (`SPEC-0036 REQ-1.4`).
 * Reaps any surviving process-group members on every settle path (`exit`, `close`, `error`, `timedOut`, `interrupt`)
 * BEFORE calling `pgidRecord.onSettledCleanup` and resuming.
 */
const spawnSupervisedProcessGroup = <E>(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: SupervisedProcessGroupOptions<E>,
): Effect.Effect<SyncHostExecResult, E> =>
  Effect.callback<SyncHostExecResult, E>((resume) => {
    const killGraceMs = Number.isFinite(opts.killGraceMs) ? Math.max(0, opts.killGraceMs) : 0
    const rawMaxBytes = opts.maxBufferBytes
    const boundedAsyncMaxBytes =
      rawMaxBytes !== undefined && Number.isFinite(rawMaxBytes)
        ? Math.max(0, rawMaxBytes)
        : DEFAULT_BOUNDED_ASYNC_BYTES
    let settled = false
    let timedOut = false
    let maxBufferExceededStream: "stdout" | "stderr" | undefined = undefined
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
    let spawnErrorInfo:
      | { readonly message: string; readonly code?: string | undefined }
      | undefined = undefined
    let pgidWriteError: E | undefined = undefined
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let stdioDrainTimer: ReturnType<typeof setTimeout> | undefined = undefined
    const exitWaiters: Array<() => void> = []

    const stdoutHeadBuf: BoundedHeadBuffer | undefined = match(opts.stdoutCaptureMode)
      .with("head-1m", "bounded-async", (): BoundedHeadBuffer => ({
        chunks: [],
        totalBytes: 0,
        overflowed: false,
      }))
      .with("tail-64k", () => undefined)
      .exhaustive()
    const stdoutTailBuf: BoundedTailBuffer | undefined = match(opts.stdoutCaptureMode)
      .with("tail-64k", () => createBoundedTailBuffer())
      .with("head-1m", "bounded-async", () => undefined)
      .exhaustive()
    const stderrHeadBuf: BoundedHeadBuffer | undefined = match(opts.stdoutCaptureMode)
      .with("bounded-async", (): BoundedHeadBuffer => ({
        chunks: [],
        totalBytes: 0,
        overflowed: false,
      }))
      .with("tail-64k", "head-1m", () => undefined)
      .exhaustive()
    const stderrTailBuf: BoundedTailBuffer | undefined = match(opts.stdoutCaptureMode)
      .with("tail-64k", "head-1m", () => createBoundedTailBuffer())
      .with("bounded-async", () => undefined)
      .exhaustive()
    const modeConfig = match(opts.stdoutCaptureMode)
      .with("tail-64k", () => ({
        isAsyncBounded: false,
        headLimit: MAX_HEAD_CAPTURE_BYTES,
        fallbackExitCode: 1,
        includeTimeoutSpawnError: false,
      }))
      .with("head-1m", () => ({
        isAsyncBounded: false,
        headLimit: MAX_HEAD_CAPTURE_BYTES,
        fallbackExitCode: 1,
        includeTimeoutSpawnError: false,
      }))
      .with("bounded-async", () => ({
        isAsyncBounded: true,
        headLimit: boundedAsyncMaxBytes,
        fallbackExitCode: 0,
        includeTimeoutSpawnError: true,
      }))
      .exhaustive()

    const spawnRes = Result.try({
      try: () =>
        spawn(cmd, args, {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env !== undefined ? { env: { ...opts.env } } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        }),
      catch: (err) => ({
        message: err instanceof Error ? err.message : String(err),
        code: getSpawnErrnoCode(err),
      }),
    })

    const child = match(spawnRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => {
        resume(
          opts.mapSpawnThrow !== undefined
            ? Effect.fail(opts.mapSpawnThrow(failure.message))
            : Effect.succeed({
                _tag: "SpawnFailed",
                spawnError: failure.message,
                ...(failure.code !== undefined ? { errorCode: failure.code } : {}),
                stdout: "",
                stderr: "",
              }),
        )
        return undefined
      })
      .exhaustive()

    if (child === undefined) return undefined

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (maxBufferExceededStream !== undefined) return
      if (stdoutHeadBuf !== undefined) {
        appendBoundedHeadChunk(stdoutHeadBuf, chunk, modeConfig.headLimit)
        if (modeConfig.isAsyncBounded && stdoutHeadBuf.overflowed) {
          maxBufferExceededStream = "stdout"
          cleanupTimers()
          destroyStdio()
          startGroupReap(() => {
            finishSettle(null, null)
          })
        }
      } else {
        appendBoundedTailChunk(stdoutTailBuf!, chunk)
      }
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (maxBufferExceededStream !== undefined) return
      if (stderrHeadBuf !== undefined) {
        appendBoundedHeadChunk(stderrHeadBuf, chunk, boundedAsyncMaxBytes)
        if (stderrHeadBuf.overflowed) {
          maxBufferExceededStream = "stderr"
          cleanupTimers()
          destroyStdio()
          startGroupReap(() => {
            finishSettle(null, null)
          })
        }
      } else {
        appendBoundedTailChunk(stderrTailBuf!, chunk)
      }
    })

    const sendGroupOrChildSignal = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined && killProcessGroupPosix(child.pid, signal)) return
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
      if (childExited || child.exitCode !== null || child.signalCode !== null) return
      sigtermSent = true
      sigtermSentAtMs = Date.now()
      sendGroupOrChildSignal("SIGTERM")
      killGraceTimer = setTimeout(() => {
        if (sigkillSent) return
        const groupAlive = child.pid !== undefined && isProcessGroupAlive(child.pid)
        if ((!childExited && child.exitCode === null && child.signalCode === null) || groupAlive) {
          sigkillSent = true
          sendGroupOrChildSignal("SIGKILL")
        }
      }, killGraceMs)
      killGraceTimer.unref()
    }

    const timeoutTimer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild()
          }, opts.timeoutMs)
        : undefined
    timeoutTimer?.unref()

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (killGraceTimer !== undefined) clearTimeout(killGraceTimer)
      if (stdioDrainTimer !== undefined) clearTimeout(stdioDrainTimer)
    }

    const destroyStdio = (): void => {
      child.stdout?.removeAllListeners("data")
      child.stdout?.destroy()
      child.stderr?.removeAllListeners("data")
      child.stderr?.destroy()
    }

    const notifyChildExit = (): void => {
      childExited = true
      while (exitWaiters.length > 0) exitWaiters.shift()?.()
    }

    const finishSettle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()
      destroyStdio()
      opts.pgidRecord?.onSettledCleanup()
      if (pgidWriteError !== undefined) {
        resume(Effect.fail(pgidWriteError))
        return
      }
      const stdout =
        stdoutHeadBuf !== undefined
          ? stdoutHeadBuf.totalBytes === 0
            ? ""
            : Buffer.concat(stdoutHeadBuf.chunks, stdoutHeadBuf.totalBytes).toString("utf8")
          : readBoundedTailText(stdoutTailBuf!)
      const stderr =
        stderrHeadBuf !== undefined
          ? stderrHeadBuf.totalBytes === 0
            ? ""
            : Buffer.concat(stderrHeadBuf.chunks, stderrHeadBuf.totalBytes).toString("utf8")
          : readBoundedTailText(stderrTailBuf!)
      if (spawnErrorInfo !== undefined) {
        resume(
          Effect.succeed({
            _tag: "SpawnFailed",
            spawnError: spawnErrorInfo.message,
            ...(spawnErrorInfo.code !== undefined ? { errorCode: spawnErrorInfo.code } : {}),
            stdout,
            stderr,
          }),
        )
        return
      }
      if (maxBufferExceededStream !== undefined) {
        resume(
          Effect.succeed({
            _tag: "SpawnFailed",
            spawnError: `${maxBufferExceededStream} maxBuffer length exceeded`,
            errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            stdout,
            stderr,
          }),
        )
        return
      }
      if (timedOut) {
        resume(
          Effect.succeed({
            _tag: "TimedOut",
            stdout,
            stderr,
            ...(signal !== null ? { signal } : {}),
            ...(modeConfig.includeTimeoutSpawnError
              ? { spawnError: `Command '${cmd}' timed out after ${opts.timeoutMs}ms` }
              : {}),
          }),
        )
        return
      }
      if (signal !== null) {
        resume(Effect.succeed({ _tag: "Signaled", signal, stdout, stderr }))
        return
      }
      if (stdoutHeadBuf?.overflowed === true && opts.mapStdoutOverflow !== undefined) {
        resume(Effect.fail(opts.mapStdoutOverflow(MAX_HEAD_CAPTURE_BYTES)))
        return
      }
      resume(
        Effect.succeed({
          _tag: "Exited",
          exitCode: code ?? modeConfig.fallbackExitCode,
          stdout,
          stderr,
        }),
      )
    }

    const startGroupReap = (onReaped: () => void): void => {
      const pgid = child.pid
      if (reapComplete || pgid === undefined || !isProcessGroupAlive(pgid)) {
        reapComplete = true
        onReaped()
        return
      }
      if (reapCancel !== undefined) return
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
        killGraceTimer = undefined
      }
      const elapsedSinceTermMs =
        sigtermSentAtMs !== undefined ? Math.max(0, Date.now() - sigtermSentAtMs) : 0
      reapCancel = reapProcessGroup({
        pgid,
        termGraceMs: Math.max(0, killGraceMs - elapsedSinceTermMs),
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
          if (!settled) onReaped()
        },
      })
    }

    const handleTerminalEvent = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      exitOutcome = { code, signal }
      if (timedOut) {
        startGroupReap(() => {
          const finalOutcome = exitOutcome ?? { code, signal }
          if (childClosed) {
            finishSettle(finalOutcome.code, finalOutcome.signal)
            return
          }
          if (stdioDrainTimer === undefined) {
            stdioDrainTimer = setTimeout(() => {
              const latest = exitOutcome ?? finalOutcome
              finishSettle(latest.code, latest.signal)
            }, STDIO_DRAIN_GRACE_MS)
            stdioDrainTimer.unref()
          }
        })
        return
      }
      const proceedToReap = (): void => {
        if (settled) return
        startGroupReap(() => {
          const latest = exitOutcome ?? { code, signal }
          finishSettle(latest.code, latest.signal)
        })
      }
      if (childClosed) {
        proceedToReap()
        return
      }
      if (stdioDrainTimer === undefined) {
        stdioDrainTimer = setTimeout(proceedToReap, STDIO_DRAIN_GRACE_MS)
        stdioDrainTimer.unref()
      }
    }

    child.once("error", (err) => {
      notifyChildExit()
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (settled) return
      spawnErrorInfo = {
        message: err.message,
        code: getSpawnErrnoCode(err),
      }
      startGroupReap(() => {
        finishSettle(null, null)
      })
    })
    child.once("exit", (code, signal) => {
      notifyChildExit()
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      handleTerminalEvent(code, signal)
    })
    child.once("close", (code, signal) => {
      notifyChildExit()
      childClosed = true
      handleTerminalEvent(code, signal)
    })

    if (opts.pgidRecord !== undefined && child.pid !== undefined) {
      const writeErr = opts.pgidRecord.onSpawned(child.pid)
      if (writeErr !== undefined) {
        pgidWriteError = writeErr
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        startGroupReap(() => {
          finishSettle(null, null)
        })
      }
    }

    return Effect.callback<void>((done) => {
      const sigtermAlreadySentBeforeInterrupt = sigtermSent
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()

      let finalized = false
      const finishInterrupt = (): void => {
        if (finalized) return
        finalized = true
        reapCancel = undefined
        opts.pgidRecord?.onSettledCleanup()
        done(Effect.void)
      }

      const awaitProcessGroupExit = (): void => {
        cleanupTimers()
        destroyStdio()
        const termGraceMs = sigtermAlreadySentBeforeInterrupt
          ? 0
          : sigtermSentAtMs !== undefined
            ? Math.max(0, sigtermSentAtMs + killGraceMs - Date.now())
            : killGraceMs
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

/** Spawns a verification command in its own process group with bounded tail stdio capture and reaping. */
const spawnVerifyCommand = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
  },
): Effect.Effect<SyncHostExecResult, WorkspaceFsError> =>
  spawnSupervisedProcessGroup<WorkspaceFsError>(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    killGraceMs: KILL_GRACE_MS,
    stdoutCaptureMode: "tail-64k",
  })

export {
  appendBoundedTailChunk,
  createBoundedTailBuffer,
  isProcessGroupAlive,
  killProcessGroupPosix,
  readBoundedTailText,
  reapProcessGroup,
  signalChildProcessGroup,
  spawnSupervisedProcessGroup,
  spawnVerifyCommand,
  type BoundedTailBuffer,
  type ReapProcessGroupOptions,
  type SupervisedProcessGroupOptions,
  type SupervisedProcessGroupPgidHooks,
}
