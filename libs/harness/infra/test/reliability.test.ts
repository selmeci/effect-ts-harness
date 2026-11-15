import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  SubprocessArg,
  SubprocessCommand,
  WorkspaceFilePath,
} from "@harness/contract"
import { AstGateCachePort, DecisionCachePort, HarnessSubprocessRunner } from "@harness/service"
import {
  AstGateCacheLive,
  DecisionCacheLive,
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

  it.live("DecisionCacheLive.lookupOrCompute clears inFlight and lets waiting followers take over when leader is interrupted", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("interrupt-regression-key")
      const ttlMillis = DecisionCacheTtlMillis.make(60_000)
      const enteredCompute = yield* Deferred.make<void>()

      const leaderFiber = yield* cache
        .lookupOrCompute({
          key,
          ttlMillis,
          compute: Deferred.succeed(enteredCompute, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(enteredCompute)

      const followerFiber = yield* cache
        .lookupOrCompute({
          key,
          ttlMillis,
          compute: Effect.succeed(DecisionCachePayloadJson.make('{"followerTookOver":true}')),
        })
        .pipe(Effect.forkChild)

      yield* Effect.sleep("20 millis")
      yield* Fiber.interrupt(leaderFiber)

      const followerValue = yield* Fiber.join(followerFiber)
      expect(followerValue).toBe('{"followerTookOver":true}')

      const recovered = yield* cache.lookupOrCompute({
        key,
        ttlMillis,
        compute: Effect.succeed(DecisionCachePayloadJson.make('{"recomputed":false}')),
      })
      expect(recovered).toBe('{"followerTookOver":true}')
    }).pipe(Effect.provide(DecisionCacheLive)),
  )

  it.live("AstGateCacheLive.evaluateBatch cleans pendingEvalRef on interruption so subsequent evaluations succeed", () =>
    Effect.gen(function* () {
      const cache = yield* AstGateCachePort
      const files = [
        {
          filePath: AstSourceFilePath.make("libs/sample/domain/src/interrupt-test.ts"),
          content: AstSourceContent.make("export const x = 1\n"),
        },
      ] as const

      const interruptedFiber = yield* cache
        .evaluateBatch(files, () => [])
        .pipe(Effect.forkChild)
      yield* Fiber.interrupt(interruptedFiber)

      const report = yield* cache.evaluateBatch(files, () => [])
      expect(report.inspectedFileCount).toBe(1)
      expect(report.violations).toEqual([])
    }).pipe(Effect.provide(AstGateCacheLive)),
  )
})
