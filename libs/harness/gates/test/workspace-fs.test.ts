import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { WorkspaceFilePath, WorkspaceFsError } from "@harness/contract"
import { statAndReadWorkspaceFiles } from "../src/services/workspace-fs.js"
import { makeWorkspaceFsMemoryLayer } from "./helpers/test-layers.js"

describe("WorkspaceFs.statAndReadAll", () => {
  it.effect("reads multiple workspace files in order and computes line counts", () =>
    Effect.gen(function* () {
      const files = {
        "libs/alpha.ts": "const a = 1\nconst b = 2\n",
        "libs/beta.ts": "single-line",
        "libs/gamma.ts": "one\ntwo\nthree",
      }
      const stats = yield* statAndReadWorkspaceFiles([
        WorkspaceFilePath.make("libs/gamma.ts"),
        WorkspaceFilePath.make("libs/alpha.ts"),
        WorkspaceFilePath.make("libs/beta.ts"),
      ]).pipe(Effect.provide(makeWorkspaceFsMemoryLayer(files)))

      expect(stats.map((s) => s.filePath)).toEqual([
        "libs/gamma.ts",
        "libs/alpha.ts",
        "libs/beta.ts",
      ])
      expect(stats[0]?.lineCount).toBe(3)
      expect(stats[1]?.lineCount).toBe(3)
      expect(stats[2]?.lineCount).toBe(1)
    }),
  )

  it.effect("propagates WorkspaceFsError when any requested file is missing", () =>
    Effect.gen(function* () {
      const exit = yield* statAndReadWorkspaceFiles([
        WorkspaceFilePath.make("libs/alpha.ts"),
        WorkspaceFilePath.make("libs/missing.ts"),
      ]).pipe(
        Effect.provide(makeWorkspaceFsMemoryLayer({ "libs/alpha.ts": "export const ok = true\n" })),
        Effect.exit,
      )

      const failureCause = match(exit)
        .with({ _tag: "Failure" }, (f) => f.cause)
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected statAndReadWorkspaceFiles to fail on missing file")
        })
        .exhaustive()

      const errOpt = Cause.findErrorOption(failureCause)
      const fsError = match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => {
          throw new Error("Expected typed WorkspaceFsError in failure cause")
        })
        .exhaustive()

      expect(fsError).toBeInstanceOf(WorkspaceFsError)
      expect(fsError.filePath).toBe("libs/missing.ts")
      expect(fsError.operation).toBe("read")
    }),
  )
})
