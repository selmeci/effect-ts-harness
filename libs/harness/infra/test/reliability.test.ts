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
  execFileAsyncEffect,
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

  it.live(
    "UnixSocketDaemonLive processes concurrent lineHandler requests without head-of-line blocking",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const repoRoot = WorkspaceFilePath.make(dir)
          const slowStarted = yield* Deferred.make<void>()
          const releaseSlow = yield* Deferred.make<void>()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const info = yield* startScopedUnixSocketDaemon(repoRoot, {
                lineHandler: (line) =>
                  line === "slow"
                    ? Deferred.succeed(slowStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseSlow)),
                        Effect.as("slow:done"),
                      )
                    : Effect.succeed(`fast:${line}`),
              })

              const slowFiber = yield* queryUnixSocketLine(info.socketPath, "slow", 1000).pipe(
                Effect.forkChild,
              )
              yield* Deferred.await(slowStarted)
              const fastReply = yield* queryUnixSocketLine(info.socketPath, "ping", 500)
              yield* Deferred.succeed(releaseSlow, undefined)
              const slowReply = yield* Fiber.join(slowFiber)

              expect(Option.getOrNull(fastReply)).toBe("fast:ping")
              expect(Option.getOrNull(slowReply)).toBe("slow:done")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "DecisionCacheLive.lookupOrCompute clears inFlight and lets waiting followers take over when leader is interrupted",
    () =>
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

        yield* Effect.yieldNow
        yield* Effect.yieldNow
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

  it.live(
    "AstGateCacheLive.evaluateBatch cleans pendingEvalRef on interruption so subsequent evaluations succeed",
    () =>
      Effect.gen(function* () {
        const cache = yield* AstGateCachePort
        const files = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/interrupt-test.ts"),
            content: AstSourceContent.make("export const x = 1\n"),
          },
        ] as const

        const interruptedFiber = yield* cache.evaluateBatch(files, () => []).pipe(Effect.forkChild)
        yield* Fiber.interrupt(interruptedFiber)

        const report = yield* cache.evaluateBatch(files, () => [])
        expect(report.inspectedFileCount).toBe(1)
        expect(report.violations).toEqual([])
      }).pipe(Effect.provide(AstGateCacheLive)),
  )

  it.live(
    "execFileAsyncEffect maps Exited, non-zero exit, TimedOut, SpawnFailed, and interruption cleanup cleanly",
    () =>
      Effect.gen(function* () {
        const okRes = yield* execFileAsyncEffect(process.execPath, [
          "-e",
          "process.stdout.write('hello')",
        ])
        expect(okRes).toEqual({ _tag: "Exited", exitCode: 0, stdout: "hello", stderr: "" })

        const exitRes = yield* execFileAsyncEffect(process.execPath, [
          "-e",
          "process.stderr.write('err'); process.exit(3)",
        ])
        expect(exitRes).toEqual({ _tag: "Exited", exitCode: 3, stdout: "", stderr: "err" })

        const timeoutRes = yield* execFileAsyncEffect(
          process.execPath,
          ["-e", "setTimeout(() => {}, 5000)"],
          { timeoutMs: 50 },
        )
        expect(timeoutRes._tag).toBe("TimedOut")

        const spawnErr = yield* execFileAsyncEffect("/nonexistent-harness-binary-xyz", [])
        expect(spawnErr._tag).toBe("SpawnFailed")

        const fiber = yield* execFileAsyncEffect(process.execPath, [
          "-e",
          "setTimeout(() => {}, 5000)",
        ]).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
  )
})
