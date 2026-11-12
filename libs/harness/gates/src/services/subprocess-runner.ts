import { execFileSync } from "node:child_process"
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

export const HarnessSubprocessRunnerLive: Layer.Layer<HarnessSubprocessRunner> = Layer.succeed(
  HarnessSubprocessRunner,
  {
    exec: (input) =>
      Effect.suspend(() => {
        if (input.command.trim().length === 0) {
          return Effect.fail(
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make("Empty command"),
              reason: ErrorReasonMessage.make("Subprocess command must not be empty"),
            }),
          )
        }
        if (input.command.includes("\0")) {
          return Effect.fail(
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make("Null byte in command"),
              reason: ErrorReasonMessage.make("Subprocess command contains null bytes"),
            }),
          )
        }
        if (input.args.some((a) => a.includes("\0"))) {
          return Effect.fail(
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make("Null byte in argument"),
              reason: ErrorReasonMessage.make("Subprocess arguments contain null bytes"),
            }),
          )
        }
        return Effect.try({
          try: () => {
            const out = execFileSync(input.command, [...input.args], {
              cwd: input.cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 60_000,
              maxBuffer: 10 * 1024 * 1024,
              windowsHide: true,
            })
            return {
              command: input.command,
              exitCode: SubprocessExitCode.make(0),
              stdout: SubprocessOutput.make(out),
              stderr: SubprocessOutput.make(""),
            }
          },
          catch: (err) => {
            const hasStatus =
              typeof err === "object" &&
              err !== null &&
              "status" in err &&
              typeof (err as { readonly status?: unknown }).status === "number"
            const status = hasStatus ? ((err as { readonly status: number }).status ?? 1) : 1
            const stderr =
              typeof err === "object" &&
              err !== null &&
              "stderr" in err &&
              typeof (err as { readonly stderr?: unknown }).stderr === "string"
                ? (err as { readonly stderr: string }).stderr
                : err instanceof Error
                  ? err.message
                  : String(err)
            const reasonText =
              hasStatus
                ? `Command '${input.command}' failed with exit code ${status}`
                : err instanceof Error && err.message.trim().length > 0
                  ? err.message
                  : `Command '${input.command}' failed with exit code ${status}`
            return new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(status === 0 ? 1 : status),
              stderr: SubprocessOutput.make(stderr),
              reason: ErrorReasonMessage.make(reasonText),
            })
          },
        })
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
  const runner = yield* HarnessSubprocessRunner
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
  const result = yield* runner.exec(input)
  if (result.exitCode !== 0) {
    return yield* new HarnessSubprocessError({
      command: input.command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      reason: ErrorReasonMessage.make(
        `Command '${input.command}' failed with exit code ${result.exitCode}`,
      ),
    })
  }
  return result
})
