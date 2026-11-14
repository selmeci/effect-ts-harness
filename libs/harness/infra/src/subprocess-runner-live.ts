import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  SubprocessExitCode,
  SubprocessOutput,
} from "@harness/contract"
import { validateSubprocessInput } from "@harness/gates"
import { HarnessSubprocessRunner, type HarnessSubprocessRunnerShape } from "@harness/service"

const toSubprocessError = (
  command: SubprocessExecInput["command"],
  err: unknown,
): HarnessSubprocessError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : `Command '${command}' failed to spawn`
  return new HarnessSubprocessError({
    command,
    exitCode: SubprocessExitCode.make(1),
    stderr: SubprocessOutput.make(message),
    reason: ErrorReasonMessage.make(message),
  })
}

export const HarnessSubprocessRunnerNodeLive: Layer.Layer<HarnessSubprocessRunner> = Layer.effect(
  HarnessSubprocessRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const exec = Effect.fn("HarnessSubprocessRunner.exec")(function* (
      input: SubprocessExecInput,
    ): Effect.fn.Return<SubprocessExecResult, HarnessSubprocessError> {
      yield* validateSubprocessInput(input)

      const runSpawned = Effect.scoped(
        Effect.gen(function* () {
          const cmd = ChildProcess.make(
            input.command,
            [...input.args],
            input.cwd !== undefined ? { cwd: input.cwd } : undefined,
          )
          const handle = yield* spawner.spawn(cmd)
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
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

      if (input.timeoutMs === undefined) {
        return yield* runSpawned
      }

      const timeoutMs = input.timeoutMs
      const timed = yield* runSpawned.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
      return yield* match(timed)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make(`Timed out after ${timeoutMs}ms`),
              reason: ErrorReasonMessage.make(
                `Command '${input.command}' timed out after ${timeoutMs}ms`,
              ),
            }),
          ),
        )
        .exhaustive()
    })

    const impl: HarnessSubprocessRunnerShape = {
      exec,
    }

    return impl
  }),
).pipe(Layer.provide(NodeServices.layer))

export const HarnessSubprocessRunnerLive: Layer.Layer<HarnessSubprocessRunner> =
  HarnessSubprocessRunnerNodeLive
