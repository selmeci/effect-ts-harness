import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, Layer, type PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  SubprocessExitCode,
  SubprocessFailureKind,
  SubprocessOutput,
  validateSubprocessInput,
} from "@harness/contract"
import {
  type HarnessSubprocessExecOptions,
  HarnessSubprocessRunner,
  type HarnessSubprocessRunnerShape,
} from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"

const DEFAULT_SUBPROCESS_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024

const extractErrnoCode = (err: unknown): string | undefined => {
  if (typeof err !== "object" || err === null) {
    return undefined
  }
  if ("code" in err && typeof err.code === "string") {
    return err.code
  }
  if ("cause" in err) {
    return extractErrnoCode(err.cause)
  }
  if ("reason" in err) {
    return extractErrnoCode(err.reason)
  }
  return undefined
}

const hasExitCodePlatformReason = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "reason" in err &&
  typeof err.reason === "object" &&
  err.reason !== null &&
  "method" in err.reason &&
  err.reason.method === "exitCode"

const classifySpawnErrorKind = (err: unknown, message: string): SubprocessFailureKind => {
  const code = extractErrnoCode(err)
  if (code === "ENOBUFS") {
    return SubprocessFailureKind.make("max-buffer")
  }
  if (code === "ETIMEDOUT") {
    return SubprocessFailureKind.make("timeout")
  }
  if (code === "ENOENT" || code === "EACCES") {
    return SubprocessFailureKind.make("spawn-error")
  }
  if (/\bENOBUFS\b|maxBuffer/i.test(message)) {
    return SubprocessFailureKind.make("max-buffer")
  }
  if (/\bETIMEDOUT\b|timed out/i.test(message)) {
    return SubprocessFailureKind.make("timeout")
  }
  if (
    hasExitCodePlatformReason(err) ||
    /terminated by signal|killed by signal|receipt of signal/i.test(message)
  ) {
    return SubprocessFailureKind.make("signal")
  }
  return SubprocessFailureKind.make("spawn-error")
}

const toSubprocessError = (
  command: SubprocessExecInput["command"],
  err: unknown,
): HarnessSubprocessError => {
  if (err instanceof HarnessSubprocessError) {
    return err
  }
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : `Command '${command}' failed to spawn`
  return new HarnessSubprocessError({
    command,
    stderr: SubprocessOutput.make(message),
    reason: ErrorReasonMessage.make(message),
    failureKind: classifySpawnErrorKind(err, message),
  })
}

const collectBoundedStreamText = (
  command: SubprocessExecInput["command"],
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxBufferBytes: number,
  streamName: "stdout" | "stderr",
): Effect.Effect<string, HarnessSubprocessError> =>
  Effect.gen(function* () {
    let totalBytes = 0
    const chunks: Array<Uint8Array> = []
    yield* Stream.runForEach(stream, (chunk) => {
      totalBytes += chunk.byteLength
      if (totalBytes > maxBufferBytes) {
        return Effect.fail(
          new HarnessSubprocessError({
            command,
            stderr: SubprocessOutput.make(
              `Command '${command}' ${streamName} exceeded maxBufferBytes (${maxBufferBytes})`,
            ),
            reason: ErrorReasonMessage.make(
              `Command '${command}' ${streamName} exceeded maxBufferBytes (${maxBufferBytes})`,
            ),
            failureKind: SubprocessFailureKind.make("max-buffer"),
          }),
        )
      }
      chunks.push(chunk)
      return Effect.void
    }).pipe(Effect.mapError((err) => toSubprocessError(command, err)))
    return Buffer.concat(chunks).toString("utf8")
  })

const makeHarnessSubprocessRunnerLayer = (
  _options?: Record<string, never>,
): Layer.Layer<HarnessSubprocessRunner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    HarnessSubprocessRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const exec = Effect.fn("HarnessSubprocessRunner.exec")(function* (
        input: SubprocessExecInput,
        options?: HarnessSubprocessExecOptions,
      ): Effect.fn.Return<SubprocessExecResult, HarnessSubprocessError> {
        yield* match(validateSubprocessInput(input))
          .with({ _tag: "Some" }, ({ value }) => Effect.fail(value))
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()

        const timeoutMs = input.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS
        const maxBufferBytes = input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES

        const runSpawned = Effect.scoped(
          Effect.gen(function* () {
            const cmd = ChildProcess.make(input.command, [...input.args], {
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              stdin: "ignore",
              forceKillAfter: Duration.seconds(2),
            })
            const handle = yield* spawner.spawn(cmd)
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                collectBoundedStreamText(input.command, handle.stdout, maxBufferBytes, "stdout"),
                collectBoundedStreamText(input.command, handle.stderr, maxBufferBytes, "stderr"),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            return {
              command: input.command,
              exitCode: SubprocessExitCode.make(exitCode),
              stdout: SubprocessOutput.make(stdout),
              stderr: SubprocessOutput.make(stderr),
            } satisfies SubprocessExecResult
          }),
        ).pipe(Effect.mapError((err) => toSubprocessError(input.command, err)))

        const timed = yield* runSpawned.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
        const result = yield* match(timed)
          .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
          .with({ _tag: "None" }, () =>
            Effect.fail(
              new HarnessSubprocessError({
                command: input.command,
                stderr: SubprocessOutput.make(`Timed out after ${timeoutMs}ms`),
                reason: ErrorReasonMessage.make(
                  `Command '${input.command}' timed out after ${timeoutMs}ms`,
                ),
                failureKind: SubprocessFailureKind.make("timeout"),
              }),
            ),
          )
          .exhaustive()

        if (options?.checkExitCode === true && result.exitCode !== 0) {
          return yield* new HarnessSubprocessError({
            command: input.command,
            exitCode: result.exitCode,
            stderr: result.stderr,
            reason: ErrorReasonMessage.make(
              `Command '${input.command}' exited with code ${result.exitCode}`,
            ),
            failureKind: SubprocessFailureKind.make("non-zero-exit"),
          })
        }

        return result
      })

      const impl: HarnessSubprocessRunnerShape = {
        exec,
      }

      return impl
    }),
  )

export const HarnessSubprocessRunnerLive: Layer.Layer<HarnessSubprocessRunner> =
  makeHarnessSubprocessRunnerLayer().pipe(Layer.provide(NodeServices.layer))

const makeHarnessSubprocessRunnerHostIoLayer = (
  hostIo: SyncHostIo,
): Layer.Layer<HarnessSubprocessRunner> =>
  Layer.succeed(HarnessSubprocessRunner, {
    exec: (input, options) =>
      Effect.gen(function* () {
        yield* match(validateSubprocessInput(input))
          .with({ _tag: "Some" }, ({ value }) => Effect.fail(value))
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()

        const res = yield* Effect.try({
          try: () =>
            hostIo.execFileSync(input.command, input.args, {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
              maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
            }),
          catch: (err) => toSubprocessError(input.command, err),
        })

        return yield* match(res)
          .with({ _tag: "TimedOut" }, (timedOut) =>
            Effect.fail(
              new HarnessSubprocessError({
                command: input.command,
                stderr: SubprocessOutput.make(timedOut.stderr),
                reason: ErrorReasonMessage.make(`Command '${input.command}' timed out`),
                failureKind: SubprocessFailureKind.make("timeout"),
              }),
            ),
          )
          .with({ _tag: "SpawnFailed" }, (failed) =>
            Effect.fail(
              new HarnessSubprocessError({
                command: input.command,
                stderr: SubprocessOutput.make(failed.stderr),
                reason: ErrorReasonMessage.make(failed.spawnError),
                failureKind: classifySpawnErrorKind(
                  failed.errorCode !== undefined ? { code: failed.errorCode } : undefined,
                  failed.spawnError,
                ),
              }),
            ),
          )
          .with({ _tag: "Signaled" }, (signaled) =>
            Effect.fail(
              new HarnessSubprocessError({
                command: input.command,
                stderr: SubprocessOutput.make(signaled.stderr),
                reason: ErrorReasonMessage.make(
                  `Command '${input.command}' terminated by signal ${signaled.signal}`,
                ),
                failureKind: SubprocessFailureKind.make("signal"),
              }),
            ),
          )
          .with({ _tag: "Exited" }, (exited) => {
            const exitCode = SubprocessExitCode.make(exited.exitCode)
            if (options?.checkExitCode === true && exited.exitCode !== 0) {
              return Effect.fail(
                new HarnessSubprocessError({
                  command: input.command,
                  exitCode,
                  stderr: SubprocessOutput.make(exited.stderr),
                  reason: ErrorReasonMessage.make(
                    `Command '${input.command}' exited with code ${exited.exitCode}`,
                  ),
                  failureKind: SubprocessFailureKind.make("non-zero-exit"),
                }),
              )
            }
            return Effect.succeed({
              command: input.command,
              exitCode,
              stdout: SubprocessOutput.make(exited.stdout),
              stderr: SubprocessOutput.make(exited.stderr),
            })
          })
          .exhaustive()
      }),
  })

export { makeHarnessSubprocessRunnerHostIoLayer, makeHarnessSubprocessRunnerLayer }
