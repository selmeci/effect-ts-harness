import { Effect, Layer } from "effect"
import {
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  SubprocessExitCode,
  SubprocessOutput,
} from "@harness/contract"
import {
  HarnessSubprocessRunner,
  type HarnessSubprocessRunnerShape,
  type SyncHostIo,
} from "@harness/service"

export { HarnessSubprocessRunner, type HarnessSubprocessRunnerShape }

export const validateSubprocessInput = (
  input: SubprocessExecInput,
): Effect.Effect<void, HarnessSubprocessError> =>
  Effect.gen(function* () {
    if (input.command.trim().length === 0) {
      return yield* new HarnessSubprocessError({
        command: input.command,
        exitCode: SubprocessExitCode.make(1),
        stderr: SubprocessOutput.make("Empty command"),
        reason: ErrorReasonMessage.make("Subprocess command must not be empty"),
      })
    }
    if (input.command.includes("\0")) {
      return yield* new HarnessSubprocessError({
        command: input.command,
        exitCode: SubprocessExitCode.make(1),
        stderr: SubprocessOutput.make("Null byte in command"),
        reason: ErrorReasonMessage.make("Subprocess command contains null bytes"),
      })
    }
    if (input.args.some((a) => a.includes("\0"))) {
      return yield* new HarnessSubprocessError({
        command: input.command,
        exitCode: SubprocessExitCode.make(1),
        stderr: SubprocessOutput.make("Null byte in argument"),
        reason: ErrorReasonMessage.make("Subprocess arguments contain null bytes"),
      })
    }
  })

export const makeHarnessSubprocessRunnerHostIoLayer = (
  hostIo: SyncHostIo,
): Layer.Layer<HarnessSubprocessRunner> =>
  Layer.succeed(HarnessSubprocessRunner, {
    exec: (input) =>
      Effect.gen(function* () {
        yield* validateSubprocessInput(input)
        const res = yield* Effect.try({
          try: () =>
            hostIo.execFileSync(input.command, input.args, {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 60_000,
              maxBufferBytes: input.maxBufferBytes ?? 10 * 1024 * 1024,
            }),
          catch: (err) =>
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make(err instanceof Error ? err.message : String(err)),
              reason: ErrorReasonMessage.make(
                `Command '${input.command}' failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
              ),
            }),
        })
        return {
          command: input.command,
          exitCode: SubprocessExitCode.make(res.exitCode),
          stdout: SubprocessOutput.make(res.stdout),
          stderr: SubprocessOutput.make(res.stderr),
        }
      }),
  })

export const makeHarnessSubprocessRunnerTestLayer = (
  handler: (
    input: SubprocessExecInput,
  ) => Effect.Effect<SubprocessExecResult, HarnessSubprocessError>,
): Layer.Layer<HarnessSubprocessRunner> =>
  Layer.succeed(HarnessSubprocessRunner, {
    exec: handler,
  })

export const execCheckedSubprocess = Effect.fn("HarnessSubprocess.execChecked")(function* (
  input: SubprocessExecInput,
): Effect.fn.Return<SubprocessExecResult, HarnessSubprocessError, HarnessSubprocessRunner> {
  yield* validateSubprocessInput(input)
  const runner = yield* HarnessSubprocessRunner
  const result = yield* runner.exec(input)
  if (result.exitCode !== 0) {
    const errText = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim()
    const reasonText =
      errText.length > 0
        ? `Command '${input.command}' failed with exit code ${result.exitCode}: ${errText}`
        : `Command '${input.command}' failed with exit code ${result.exitCode}`
    return yield* new HarnessSubprocessError({
      command: input.command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      reason: ErrorReasonMessage.make(reasonText),
    })
  }
  return result
})
