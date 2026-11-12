import { spawnSync } from "node:child_process"
import { Context, Effect, Layer } from "effect"
import {
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  SubprocessExitCode,
  SubprocessOutput,
} from "../plugins/self-dogfooding-contract.js"

export interface HarnessSubprocessRunnerShape {
  readonly exec: (
    input: SubprocessExecInput,
  ) => Effect.Effect<SubprocessExecResult, HarnessSubprocessError>
}

export class HarnessSubprocessRunner extends Context.Service<
  HarnessSubprocessRunner,
  HarnessSubprocessRunnerShape
>()("@harness/gates/HarnessSubprocessRunner") {}

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

export const HarnessSubprocessRunnerLive: Layer.Layer<HarnessSubprocessRunner> = Layer.succeed(
  HarnessSubprocessRunner,
  {
    exec: (input) =>
      Effect.gen(function* () {
        yield* validateSubprocessInput(input)
        const res = spawnSync(input.command, [...input.args], {
          cwd: input.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: input.timeoutMs ?? 60_000,
          maxBuffer: input.maxBufferBytes ?? 10 * 1024 * 1024,
          windowsHide: true,
        })
        if (res.error !== undefined) {
          const isTimeout =
            "code" in res.error &&
            (res.error as { readonly code?: unknown }).code === "ETIMEDOUT"
          const reasonText = isTimeout
            ? `Command '${input.command}' timed out`
            : `Command '${input.command}' failed to spawn: ${res.error.message}`
          const stderrText = (res.stderr ?? "").trim() || res.error.message
          return yield* new HarnessSubprocessError({
            command: input.command,
            exitCode: SubprocessExitCode.make(1),
            stderr: SubprocessOutput.make(stderrText),
            reason: ErrorReasonMessage.make(reasonText),
          })
        }
        if (res.signal !== null) {
          const stderrText = (res.stderr ?? "").trim() || `Terminated by signal ${res.signal}`
          return yield* new HarnessSubprocessError({
            command: input.command,
            exitCode: SubprocessExitCode.make(1),
            stderr: SubprocessOutput.make(stderrText),
            reason: ErrorReasonMessage.make(
              `Command '${input.command}' terminated by signal ${res.signal}`,
            ),
          })
        }
        return {
          command: input.command,
          exitCode: SubprocessExitCode.make(res.status ?? 0),
          stdout: SubprocessOutput.make(res.stdout ?? ""),
          stderr: SubprocessOutput.make(res.stderr ?? ""),
        }
      }),
  },
)

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
