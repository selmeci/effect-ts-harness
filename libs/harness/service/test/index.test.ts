import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  ActiveMutantId,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessOutput,
  WorkspaceFileContent,
  WorkspaceFilePath,
} from "@harness/contract"
import { ActiveMutantContext, HarnessSubprocessRunner, WorkspaceFs } from "../src/index.js"

describe("@harness/service ports", () => {
  it.effect("resolves WorkspaceFs from a test layer", () =>
    Effect.gen(function* () {
      const fs = yield* WorkspaceFs
      const path = WorkspaceFilePath.make("README.md")
      const exists = yield* fs.exists(path)
      const content = yield* fs.readTextFile(path)
      expect(exists).toBe(true)
      expect(content).toBe("hello")
    }).pipe(
      Effect.provideService(WorkspaceFs, {
        readTextFile: () => Effect.succeed(WorkspaceFileContent.make("hello")),
        writeTextFileAtomic: () => Effect.void,
        exists: () => Effect.succeed(true),
      }),
    ),
  )

  it.effect("resolves HarnessSubprocessRunner from a test layer", () =>
    Effect.gen(function* () {
      const runner = yield* HarnessSubprocessRunner
      const result = yield* runner.exec({
        command: SubprocessCommand.make("echo"),
        args: [],
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("ok")
    }).pipe(
      Effect.provideService(HarnessSubprocessRunner, {
        exec: (input) =>
          Effect.succeed({
            command: input.command,
            exitCode: SubprocessExitCode.make(0),
            stdout: SubprocessOutput.make("ok"),
            stderr: SubprocessOutput.make(""),
          }),
      }),
    ),
  )

  it.effect("resolves ActiveMutantContext from a test layer", () =>
    Effect.gen(function* () {
      const ctx = yield* ActiveMutantContext
      const current = yield* ctx.getCurrentMutant
      expect(Option.isNone(current)).toBe(true)
      const res = yield* ctx.runWithMutant(
        ActiveMutantId.make("m-1"),
        Effect.succeed("ran"),
      )
      expect(res).toBe("ran")
    }).pipe(
      Effect.provideService(ActiveMutantContext, {
        getCurrentMutant: Effect.succeedNone,
        runWithMutant: (_id, eff) => eff,
      }),
    ),
  )
})
