import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  validateSubprocessInput,
} from "@harness/contract"
import { HarnessSubprocessRunner } from "@harness/service"

export { validateSubprocessInput }

export const execCheckedSubprocess = Effect.fn("HarnessSubprocess.execChecked")(function* (
  input: SubprocessExecInput,
): Effect.fn.Return<SubprocessExecResult, HarnessSubprocessError, HarnessSubprocessRunner> {
  yield* match(validateSubprocessInput(input))
    .with({ _tag: "Some" }, ({ value }) => Effect.fail(value))
    .with({ _tag: "None" }, () => Effect.void)
    .exhaustive()
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
