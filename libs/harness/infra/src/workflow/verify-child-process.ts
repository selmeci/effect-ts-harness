import { type ChildProcess, spawn } from "node:child_process"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import type { WorkspaceFsError } from "@harness/contract"
import type { SyncHostExecResult } from "@harness/service/host-io"

const MAX_CAPTURE_BYTES = 64 * 1024
const STDIO_DRAIN_GRACE_MS = 100
const KILL_GRACE_MS = 500

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
 * Sends a signal to the detached child's process group on POSIX when `child.pid` is available,
 * falling back cleanly to `child.kill(signal)` on Windows or ESRCH/exit races.
 */
const signalChildProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    const pid = child.pid
    const sentGroup = match(
      Result.try(() => {
        process.kill(-pid, signal)
      }),
    )
      .with({ _tag: "Success" }, () => true)
      .with({ _tag: "Failure" }, () => false)
      .exhaustive()
    if (sentGroup) {
      return
    }
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

const isProcessGroupAlive = (pgid: number): boolean =>
  process.platform !== "win32" &&
  match(
    Result.try(() => {
      process.kill(-pgid, 0)
    }),
  )
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()

/**
 * Spawns a verification command in its own process group with bounded tail stdio capture,
 * timeout enforcement, and deterministic process-group termination on fiber interruption.
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
    let sigtermSent = false
    let sigkillSent = false
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

    const terminateChild = (): void => {
      if (childExited || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      if (sigtermSent || child.killed) {
        if (!sigkillSent) {
          sigkillSent = true
          signalChildProcessGroup(child, "SIGKILL")
        }
        return
      }
      sigtermSent = true
      signalChildProcessGroup(child, "SIGTERM")
      killGraceTimer = setTimeout(() => {
        if (!childExited && child.exitCode === null && child.signalCode === null && !sigkillSent) {
          sigkillSent = true
          signalChildProcessGroup(child, "SIGKILL")
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

    child.once("error", (err) => {
      notifyChildExit()
      if (settled) {
        return
      }
      settled = true
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
      if (settled || stdioDrainTimer !== undefined) {
        return
      }
      stdioDrainTimer = setTimeout(() => {
        settleWithExit(code, signal)
      }, STDIO_DRAIN_GRACE_MS)
      stdioDrainTimer.unref()
    })

    child.once("close", (code, signal) => {
      notifyChildExit()
      settleWithExit(code, signal)
    })

    return Effect.callback<void>((done) => {
      settled = true
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer)
      }
      const awaitProcessGroupExit = (): void => {
        cleanupTimers()
        destroyStdio()
        const pgid = child.pid
        if (pgid === undefined || !isProcessGroupAlive(pgid)) {
          done(Effect.void)
          return
        }
        const termDeadlineMs = Date.now() + KILL_GRACE_MS
        let postKillDeadlineMs: number | undefined = sigkillSent ? Date.now() + 150 : undefined
        const groupPoll = setInterval(() => {
          if (!isProcessGroupAlive(pgid)) {
            clearInterval(groupPoll)
            done(Effect.void)
            return
          }
          const nowMs = Date.now()
          if (postKillDeadlineMs !== undefined) {
            if (nowMs >= postKillDeadlineMs) {
              clearInterval(groupPoll)
              done(Effect.void)
            }
            return
          }
          if (nowMs >= termDeadlineMs) {
            sigkillSent = true
            match(
              Result.try(() => {
                process.kill(-pgid, "SIGKILL")
              }),
            )
              .with({ _tag: "Success" }, () => undefined)
              .with({ _tag: "Failure" }, () => undefined)
              .exhaustive()
            postKillDeadlineMs = nowMs + 150
          }
        }, 10)
        groupPoll.unref()
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
