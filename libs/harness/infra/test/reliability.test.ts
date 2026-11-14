import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SubprocessArg, SubprocessCommand, WorkspaceFilePath } from "@harness/contract"
import { HarnessSubprocessRunner } from "@harness/service"
import {
  HarnessSubprocessRunnerLive,
  queryUnixSocketLine,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "../src/index.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-infra-rel-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

describe("@harness/infra reliability", () => {
  it.live("HarnessSubprocessRunnerLive classifies SIGKILL child exit as signal failureKind", () =>
    Effect.gen(function* () {
      const runner = yield* HarnessSubprocessRunner
      const err = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [
            SubprocessArg.make("-e"),
            SubprocessArg.make("process.kill(process.pid, 'SIGKILL')"),
          ],
        })
        .pipe(Effect.flip)

      expect(err._tag).toBe("HarnessSubprocessError")
      expect(err.failureKind).toBe("signal")
    }).pipe(Effect.provide(HarnessSubprocessRunnerLive)),
  )

  it.live("UnixSocketDaemonLive processes concurrent lineHandler requests without head-of-line blocking", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const info = yield* startScopedUnixSocketDaemon(repoRoot, {
              lineHandler: (line) =>
                line === "slow"
                  ? Effect.sleep("250 millis").pipe(Effect.as("slow:done"))
                  : Effect.succeed(`fast:${line}`),
            })

            const [slowReply, fastReply] = yield* Effect.all(
              [
                queryUnixSocketLine(info.socketPath, "slow", 1000),
                Effect.sleep("15 millis").pipe(
                  Effect.andThen(queryUnixSocketLine(info.socketPath, "ping", 100)),
                ),
              ],
              { concurrency: "unbounded" },
            )

            expect(Option.getOrNull(fastReply)).toBe("fast:ping")
            expect(Option.getOrNull(slowReply)).toBe("slow:done")
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )
})
