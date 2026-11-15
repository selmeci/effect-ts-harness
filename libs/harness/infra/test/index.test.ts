import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { match } from "ts-pattern"
import {
  ActiveMutantId,
  AstSourceContent,
  AstSourceFilePath,
  computeWorkspaceFileLineCount,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  EnclosingSymbolName,
  EvaluatorId,
  GateRuleId,
  GateViolationMessage,
  HARNESS_GATE_RULE_VERSION,
  SourceLineNumber,
  SubprocessArg,
  SubprocessCommand,
  SubprocessMaxBufferBytes,
  SubprocessTimeoutMs,
  WorkspaceFileContent,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  ActiveMutantContext,
  AstGateCachePort,
  DecisionCachePort,
  HarnessSubprocessRunner,
  UnixSocketDaemonPort,
  WorkspaceFs,
} from "@harness/service"
import {
  ActiveMutantContextLive,
  AstGateCacheLive,
  DecisionCacheLive,
  HarnessInfraLive,
  HarnessSubprocessRunnerLive,
  LocalDecisionModel,
  makeAstGateCacheLayer,
  makeDecisionCacheLayer,
  makeHarnessInfraLayer,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
  makeLocalDecisionModelLayer,
  makeUnixSocketDaemonLayer,
  makeWorkspaceFsHostIoLayer,
  makeWorkspaceFsLayer,
  nodeSyncHostIo,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveAstGateCachePath,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  WorkspaceFsLive,
} from "../src/index.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-infra-test-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

describe("@harness/infra live adapters", () => {
  it.effect("exports live layers and nodeSyncHostIo", () =>
    Effect.sync(() => {
      expect(typeof nodeSyncHostIo.existsSync).toBe("function")
      expect(WorkspaceFsLive).toBeDefined()
      expect(HarnessSubprocessRunnerLive).toBeDefined()
      expect(AstGateCacheLive).toBeDefined()
      expect(DecisionCacheLive).toBeDefined()
      expect(UnixSocketDaemonLive).toBeDefined()
      expect(HarnessInfraLive).toBeDefined()
    }),
  )

  it.effect("WorkspaceFsLive reads, atomically writes, checks existence, and maps errors", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* WorkspaceFs
        const targetPath = WorkspaceFilePath.make(join(dir, "nested", "sample.txt"))
        const missingPath = WorkspaceFilePath.make(join(dir, "missing.txt"))

        const initialExists = yield* fs.exists(targetPath)
        expect(initialExists).toBe(false)

        yield* fs.writeTextFileAtomic(
          targetPath,
          WorkspaceFileContent.make("line1\nline2\n"),
        )
        const afterWriteExists = yield* fs.exists(targetPath)
        expect(afterWriteExists).toBe(true)

        const content = yield* fs.readTextFile(targetPath)
        expect(content).toBe("line1\nline2\n")
        expect(computeWorkspaceFileLineCount(content)).toBe(3)

        const readErr = yield* fs.readTextFile(missingPath).pipe(Effect.flip)
        expect(readErr._tag).toBe("WorkspaceFsError")
        expect(readErr.operation).toBe("read")
        expect(readErr.filePath).toBe(missingPath)
      }).pipe(Effect.provide(WorkspaceFsLive)),
    ),
  )

  it.live("HarnessSubprocessRunnerLive executes zero, failing, and timed-out commands", () =>
    Effect.gen(function* () {
      const runner = yield* HarnessSubprocessRunner
      const okResult = yield* runner.exec({
        command: SubprocessCommand.make(process.execPath),
        args: [
          SubprocessArg.make("-e"),
          SubprocessArg.make("process.stdout.write('hello-infra')"),
        ],
      })
      expect(okResult.exitCode).toBe(0)
      expect(okResult.stdout).toBe("hello-infra")

      const failRes = yield* runner.exec({
        command: SubprocessCommand.make(process.execPath),
        args: [
          SubprocessArg.make("-e"),
          SubprocessArg.make("process.stderr.write('boom'); process.exit(2)"),
        ],
      })
      expect(failRes.exitCode).toBe(2)
      expect(failRes.stderr).toContain("boom")

      const timeoutErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [
            SubprocessArg.make("-e"),
            SubprocessArg.make("setTimeout(() => {}, 5000)"),
          ],
          timeoutMs: SubprocessTimeoutMs.make(50),
        })
        .pipe(Effect.flip)
      expect(timeoutErr._tag).toBe("HarnessSubprocessError")
      expect(timeoutErr.failureKind).toBe("timeout")
    }).pipe(Effect.provide(HarnessSubprocessRunnerLive)),
  )

  it.effect("REQ-3.1: AstGateCacheLive reuses cached digests and persists across layer rebuilds", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const cacheFilePath = WorkspaceFilePath.make(join(dir, "cache", "ast-gates.json"))
        const batch = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/clean.ts"),
            content: AstSourceContent.make("export const answer = 42\n"),
          },
        ]

        const layer1 = makeAstGateCacheLayer({ cacheFilePath }).pipe(Layer.provide(NodeServices.layer))
        const [firstReport, secondReport, sizeAfter] = yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          const first = yield* cache.evaluateBatch(batch, () => [])
          const second = yield* cache.evaluateBatch(batch, () => [])
          const size = yield* cache.cacheSize
          return [first, second, size] as const
        }).pipe(Effect.provide(layer1))

        expect(firstReport.verdict).toBe("clean")
        expect(firstReport.inspectedFileCount).toBe(1)
        expect(firstReport.cacheHitCount).toBe(0)
        expect(secondReport.cacheHitCount).toBe(1)
        expect(sizeAfter).toBe(1)
        expect(existsSync(cacheFilePath)).toBe(true)

        const layer2 = makeAstGateCacheLayer({ cacheFilePath }).pipe(Layer.provide(NodeServices.layer))
        const persistedReport = yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          return yield* cache.evaluateBatch(batch, () => [])
        }).pipe(Effect.provide(layer2))

        expect(persistedReport.verdict).toBe("clean")
        expect(persistedReport.cacheHitCount).toBe(1)
      }),
    ),
  )

  it.effect("REQ-3.2: DecisionCacheLive memoizes payloads and persists across layer rebuilds", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const cacheFilePath = WorkspaceFilePath.make(join(dir, "cache", "decisions.json"))
        const key = DecisionCacheKey.make("decision-key-1")
        const payload = DecisionCachePayloadJson.make('{"verdict":"proceed"}')
        const ttl = DecisionCacheTtlMillis.make(60_000)

        const layer1 = makeDecisionCacheLayer({ cacheFilePath }).pipe(Layer.provide(NodeServices.layer))
        const [missOpt, hitOpt, statsAfter] = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          const miss = yield* cache.lookup(key)
          yield* cache.store(key, payload, ttl)
          const hit = yield* cache.lookup(key)
          const stats = yield* cache.stats
          return [miss, hit, stats] as const
        }).pipe(Effect.provide(layer1))

        expect(Option.getOrNull(missOpt)).toBeNull()
        expect(Option.getOrNull(hitOpt)).toBe(payload)
        expect(statsAfter.misses).toBe(1)
        expect(statsAfter.hits).toBe(1)
        expect(statsAfter.size).toBe(1)

        const layer2 = makeDecisionCacheLayer({ cacheFilePath }).pipe(Layer.provide(NodeServices.layer))
        const persistedOpt = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          return yield* cache.lookup(key)
        }).pipe(Effect.provide(layer2))

        expect(Option.getOrNull(persistedOpt)).toBe(payload)
      }),
    ),
  )

  it.effect("REQ-3.3: UnixSocketDaemonLive binds 0600 socket, answers ping, and unlinks on scope close", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const expectedSocketPath = resolveHarnessDaemonSocketPath(dir)

        const socketDuringScope = yield* Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* UnixSocketDaemonPort
            const info = yield* startScopedUnixSocketDaemon(repoRoot)
            expect(info.socketPath).toBe(expectedSocketPath)
            expect(existsSync(info.socketPath)).toBe(true)
            expect(statSync(info.socketPath).mode & 0o777).toBe(0o600)

            const alive = yield* daemon.isSocketAlive(info.socketPath)
            expect(alive).toBe(true)
            return info.socketPath
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))

        expect(existsSync(socketDuringScope)).toBe(false)
        const aliveAfterClose = yield* Effect.gen(function* () {
          const daemon = yield* UnixSocketDaemonPort
          return yield* daemon.isSocketAlive(socketDuringScope)
        }).pipe(Effect.provide(UnixSocketDaemonLive))
        expect(aliveAfterClose).toBe(false)
      }),
    ),
  )

  it.effect("REQ-3.4: startScopedUnixSocketDaemon fails with DaemonServerError for unbindable socket path", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const blockingFile = join(dir, "not-a-directory")
        writeFileSync(blockingFile, "regular-file", "utf8")
        const badSocketPath = DaemonSocketPath.make(join(blockingFile, "daemon.sock"))

        const err = yield* Effect.scoped(startScopedUnixSocketDaemon(repoRoot)).pipe(
          Effect.provide(
            makeUnixSocketDaemonLayer({ socketPathOverride: badSocketPath }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.flip,
        )

        expect(err._tag).toBe("DaemonServerError")
        expect(err.socketPath).toBe(badSocketPath)
      }),
    ),
  )

  it.effect("queryUnixSocketLine communicates with lineHandler daemon and returns None when missing", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const missingReply = yield* queryUnixSocketLine(join(dir, "missing.sock"), "ping", 200)
        expect(Option.isNone(missingReply)).toBe(true)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const info = yield* startScopedUnixSocketDaemon(repoRoot, {
              lineHandler: (line) => Effect.succeed(`echo:${line}`),
            })
            const reply = yield* queryUnixSocketLine(info.socketPath, "hello-daemon", 1000)
            expect(Option.getOrNull(reply)).toBe("echo:hello-daemon")
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )

  it.effect("ExtendedHostIo supports mkdtempSync, cpRecursiveSync, statMtimeMsSync, and rmRecursiveSync", () =>
    Effect.sync(() => {
      const tempRoot = nodeSyncHostIo.mkdtempSync("harness-extended-io-")
      try {
        const srcDir = join(tempRoot, "src")
        const destDir = join(tempRoot, "dest")
        const srcFile = join(srcDir, "nested.txt")
        nodeSyncHostIo.mkdirRecursiveSync(srcDir)
        nodeSyncHostIo.writeTextSync(srcFile, "hello-extended-io")

        const mtime = nodeSyncHostIo.statMtimeMsSync(srcFile)
        expect(typeof mtime).toBe("number")
        expect(nodeSyncHostIo.statMtimeMsSync(join(tempRoot, "missing.txt"))).toBeUndefined()

        nodeSyncHostIo.cpRecursiveSync(srcDir, destDir)
        expect(nodeSyncHostIo.readTextSync(join(destDir, "nested.txt"))).toBe("hello-extended-io")

        nodeSyncHostIo.rmRecursiveSync(destDir)
        expect(nodeSyncHostIo.existsSync(destDir)).toBe(false)
      } finally {
        nodeSyncHostIo.rmRecursiveSync(tempRoot)
      }
    }),
  )

  it.effect("F-4.2: nodeSyncHostIo.execFileSync & spawnDetached handle normal, trimmed, missing, timedOut, and invalid inputs safely", () =>
    Effect.sync(() => {
      const okRes = nodeSyncHostIo.execFileSync(`  ${process.execPath}  `, ["-e", "process.stdout.write('trimmed')"])
      match(okRes)
        .with({ _tag: "Exited" }, (exited) => {
          expect(exited.exitCode).toBe(0)
          expect(exited.stdout).toBe("trimmed")
        })
        .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => {
          expect.unreachable("Expected Exited")
        })
        .exhaustive()
      expect("signal" in okRes).toBe(false)

      const missingRes = nodeSyncHostIo.execFileSync("definitely-nonexistent-binary-xyz-42", [])
      match(missingRes)
        .with({ _tag: "SpawnFailed" }, (failed) => {
          expect(failed.spawnError.length).toBeGreaterThan(0)
        })
        .with({ _tag: "Exited" }, { _tag: "TimedOut" }, { _tag: "Signaled" }, () => {
          expect.unreachable("Expected SpawnFailed")
        })
        .exhaustive()

      const timeoutRes = nodeSyncHostIo.execFileSync(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        { timeoutMs: 50 },
      )
      expect(timeoutRes._tag).toBe("TimedOut")

      const badCmd = nodeSyncHostIo.execFileSync("node\0bad", [])
      expect(badCmd._tag).toBe("SpawnFailed")

      const badArg = nodeSyncHostIo.execFileSync(process.execPath, ["arg\0bad"])
      expect(badArg._tag).toBe("SpawnFailed")

      const badCwd = nodeSyncHostIo.execFileSync(process.execPath, ["-e", "0"], { cwd: "/tmp/bad\0cwd" })
      expect(badCwd._tag).toBe("SpawnFailed")

      const emptyCmd = nodeSyncHostIo.execFileSync("   ", [])
      expect(emptyCmd._tag).toBe("SpawnFailed")

      const detachedInvalid = nodeSyncHostIo.spawnDetached("  ", [])
      expect(detachedInvalid._tag).toBe("SpawnFailed")

      const wsCwdExec = nodeSyncHostIo.execFileSync(process.execPath, ["-e", "0"], { cwd: "   " })
      match(wsCwdExec)
        .with({ _tag: "SpawnFailed" }, (failed) => {
          expect(failed.spawnError).toBe("Subprocess cwd must not be empty")
        })
        .with({ _tag: "Exited" }, { _tag: "TimedOut" }, { _tag: "Signaled" }, () => {
          expect.unreachable("Expected SpawnFailed")
        })
        .exhaustive()

      const wsCwdDetached = nodeSyncHostIo.spawnDetached(process.execPath, ["-e", "0"], { cwd: "   " })
      match(wsCwdDetached)
        .with({ _tag: "SpawnFailed" }, (failed) => {
          expect(failed.spawnError).toBe("Subprocess cwd must not be empty")
        })
        .with({ _tag: "Spawned" }, () => {
          expect.unreachable("Expected SpawnFailed")
        })
        .exhaustive()

      const detachedMissing = nodeSyncHostIo.spawnDetached("definitely-nonexistent-binary-xyz-42", [])
      match(detachedMissing)
        .with({ _tag: "SpawnFailed" }, (failed) => {
          expect(failed.errorCode).toBe("ENOENT")
        })
        .with({ _tag: "Spawned" }, () => {
          expect.unreachable("Expected SpawnFailed")
        })
        .exhaustive()
    }),
  )

  it.effect("F-8.5a: ActiveMutantContextLive isolates mutantId per fiber and resets on exit/failure", () =>
    Effect.gen(function* () {
      const ctx = yield* ActiveMutantContext
      const m1 = ActiveMutantId.make("mutant-1")
      const m2 = ActiveMutantId.make("mutant-2")

      expect(Option.isNone(yield* ctx.getCurrentMutant)).toBe(true)

      const inner = yield* ctx.runWithMutant(
        m1,
        Effect.gen(function* () {
          const outerVal = yield* ctx.getCurrentMutant
          const nestedVal = yield* ctx.runWithMutant(m2, ctx.getCurrentMutant)
          const restoredVal = yield* ctx.getCurrentMutant
          return [outerVal, nestedVal, restoredVal] as const
        }),
      )
      expect(Option.getOrNull(inner[0])).toBe(m1)
      expect(Option.getOrNull(inner[1])).toBe(m2)
      expect(Option.getOrNull(inner[2])).toBe(m1)
      expect(Option.isNone(yield* ctx.getCurrentMutant)).toBe(true)

      const failed = yield* ctx.runWithMutant(m1, Effect.fail("boom")).pipe(Effect.flip)
      expect(failed).toBe("boom")
      expect(Option.isNone(yield* ctx.getCurrentMutant)).toBe(true)
    }).pipe(Effect.provide(ActiveMutantContextLive)),
  )

  it.effect("F-8.5a: makeWorkspaceFsHostIoLayer and makeHarnessSubprocessRunnerHostIoLayer work with nodeSyncHostIo", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* WorkspaceFs
        const runner = yield* HarnessSubprocessRunner
        const target = WorkspaceFilePath.make(join(dir, "hostio.txt"))
        yield* fs.writeTextFileAtomic(target, WorkspaceFileContent.make("via-host-io"))
        expect(yield* fs.readTextFile(target)).toBe("via-host-io")

        const res = yield* runner.exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("process.stdout.write('ok-hostio')")],
        })
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toBe("ok-hostio")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeWorkspaceFsHostIoLayer(nodeSyncHostIo),
            makeHarnessSubprocessRunnerHostIoLayer(nodeSyncHostIo),
          ),
        ),
      ),
    ),
  )

  it.live("F-8.1b & S-1.5: DecisionCacheLive lookupOrCompute deduplicates concurrent calls via Deferred single-flight", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("concurrent-key-1")
      const ttl = DecisionCacheTtlMillis.make(60_000)
      let computeRuns = 0
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const fibers = yield* Effect.forEach(Array.from({ length: 5 }), () =>
        cache
          .lookupOrCompute({
            key,
            ttlMillis: ttl,
            compute: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  computeRuns += 1
                  return DecisionCachePayloadJson.make('{"ok":true}')
                }),
              ),
            ),
          })
          .pipe(Effect.forkChild),
      )

      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const results = yield* Effect.forEach(fibers, Fiber.join)

      expect(computeRuns).toBe(1)
      expect(results).toHaveLength(5)
      for (const r of results) {
        expect(r).toBe('{"ok":true}')
      }
      const stats = yield* cache.stats
      expect(stats.coalescedRequests).toBeGreaterThanOrEqual(4)
    }).pipe(Effect.provide(DecisionCacheLive)),
  )

  it.effect("F-13.1: DecisionCacheLive and AstGateCacheLive handle corrupt JSON, unreadable directory paths, and stale ruleVersion", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const corruptDecisionPath = WorkspaceFilePath.make(join(dir, "corrupt-decisions.json"))
        writeFileSync(corruptDecisionPath, "{not-valid-json", "utf8")
        const decisionLayer = makeDecisionCacheLayer({ cacheFilePath: corruptDecisionPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const corruptLookup = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          return yield* cache.lookup(DecisionCacheKey.make("missing"))
        }).pipe(Effect.provide(decisionLayer))
        expect(Option.isNone(corruptLookup)).toBe(true)

        const dirAtDecisionPath = WorkspaceFilePath.make(join(dir, "dir-as-cache"))
        mkdirSync(dirAtDecisionPath, { recursive: true })
        const badDecisionLayer = makeDecisionCacheLayer({ cacheFilePath: dirAtDecisionPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const [err1, err2] = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          const e1 = yield* cache.lookup(DecisionCacheKey.make("k")).pipe(Effect.flip)
          const e2 = yield* cache.lookup(DecisionCacheKey.make("k")).pipe(Effect.flip)
          return [e1, e2] as const
        }).pipe(Effect.provide(badDecisionLayer))
        expect(err1._tag).toBe("WorkspaceFsError")
        expect(err2._tag).toBe("WorkspaceFsError")

        const staleAstPath = WorkspaceFilePath.make(join(dir, "stale-ast.json"))
        const filePath = AstSourceFilePath.make("libs/sample/domain/src/stale.ts")
        const content = AstSourceContent.make("export const x = 1\n")
        const freshLayer = makeAstGateCacheLayer({ cacheFilePath: staleAstPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          yield* cache.evaluateBatch([{ filePath, content }], () => [])
        }).pipe(Effect.provide(freshLayer))

        const parsed = JSON.parse(readFileSync(staleAstPath, "utf8")) as {
          version: string
          entries: Record<string, { contentSha256: string; ruleVersion: string; violations: unknown[] }>
        }
        for (const entry of Object.values(parsed.entries)) {
          entry.ruleVersion = `${HARNESS_GATE_RULE_VERSION}-stale`
        }
        writeFileSync(staleAstPath, JSON.stringify(parsed), "utf8")

        const reloadedLayer = makeAstGateCacheLayer({ cacheFilePath: staleAstPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const report = yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          return yield* cache.evaluateBatch([{ filePath, content }], () => [])
        }).pipe(Effect.provide(reloadedLayer))
        expect(report.cacheHitCount).toBe(0)
      }),
    ),
  )

  it.effect("F-15.1: DecisionCacheLive and AstGateCacheLive do not commit in-memory state when disk persist fails", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const readOnlyDir = join(dir, "read-only-cache-dir")
        mkdirSync(readOnlyDir, { recursive: true })
        chmodSync(readOnlyDir, 0o555)
        const unwritableDecisionPath = WorkspaceFilePath.make(join(readOnlyDir, "decisions.json"))
        const unwritableAstPath = WorkspaceFilePath.make(join(readOnlyDir, "ast.json"))

        const decisionLayer = makeDecisionCacheLayer({
          cacheFilePath: unwritableDecisionPath,
        }).pipe(Layer.provide(NodeServices.layer))
        const [storeErr, decisionStats] = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          const err = yield* cache
            .store(
              DecisionCacheKey.make("k-fail"),
              DecisionCachePayloadJson.make("{}"),
              DecisionCacheTtlMillis.make(1000),
            )
            .pipe(Effect.flip)
          const stats = yield* cache.stats
          return [err, stats] as const
        }).pipe(Effect.provide(decisionLayer))
        expect(storeErr._tag).toBe("WorkspaceFsError")
        expect(storeErr.operation).toBe("write")
        expect(decisionStats.size).toBe(0)

        const astLayer = makeAstGateCacheLayer({ cacheFilePath: unwritableAstPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const [evalReport, astSize] = yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          const report = yield* cache.evaluateBatch(
            [
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/a.ts"),
                content: AstSourceContent.make("export const a = 1\n"),
              },
            ],
            () => [],
          )
          const size = yield* cache.cacheSize
          return [report, size] as const
        }).pipe(Effect.provide(astLayer))
        expect(evalReport.verdict).toBe("clean")
        expect(astSize).toBe(1)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            chmodSync(join(dir, "read-only-cache-dir"), 0o755)
          }),
        ),
      ),
    ),
  )

  it.live("F-16.1b: HarnessSubprocessRunnerLive populates failureKind for spawn-error, timeout, max-buffer, and invalid-input", () =>
    Effect.gen(function* () {
      const runner = yield* HarnessSubprocessRunner

      const spawnErr = yield* runner
        .exec({
          command: SubprocessCommand.make("definitely-nonexistent-binary-xyz-42"),
          args: [],
        })
        .pipe(Effect.flip)
      expect(spawnErr.failureKind).toBe("spawn-error")
      expect(spawnErr.exitCode).toBeUndefined()

      const timeoutErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("setTimeout(() => {}, 5000)")],
          timeoutMs: SubprocessTimeoutMs.make(50),
        })
        .pipe(Effect.flip)
      expect(timeoutErr.failureKind).toBe("timeout")
      expect(timeoutErr.exitCode).toBeUndefined()

      const maxBufErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [
            SubprocessArg.make("-e"),
            SubprocessArg.make("process.stdout.write('x'.repeat(4096))"),
          ],
          maxBufferBytes: SubprocessMaxBufferBytes.make(1024),
        })
        .pipe(Effect.flip)
      expect(maxBufErr.failureKind).toBe("max-buffer")
      expect(maxBufErr.exitCode).toBeUndefined()

      expect(() => Schema.decodeSync(SubprocessArg)("bad\0arg")).toThrow()
      expect(() => Schema.decodeSync(WorkspaceFilePath)("/tmp/bad\0cwd")).toThrow()
    }).pipe(Effect.provide(HarnessSubprocessRunnerLive)),
  )

  it.effect("F-22.1: UnixSocketDaemonLive refuses second daemon without unlinking live socket, refuses regular file, and serves bench", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const info = yield* startScopedUnixSocketDaemon(repoRoot)
            const benchReply = yield* queryUnixSocketLine(
              info.socketPath,
              JSON.stringify({ id: "req-1", command: "bench" }),
              1000,
            )
            expect(Option.getOrNull(benchReply)).toContain('"fallbackToInProcess":true')

            const secondErr = yield* Effect.scoped(startScopedUnixSocketDaemon(repoRoot)).pipe(
              Effect.provide(UnixSocketDaemonLive),
              Effect.flip,
            )
            expect(secondErr._tag).toBe("DaemonServerError")
            expect(existsSync(info.socketPath)).toBe(true)

            const pingAfter = yield* queryUnixSocketLine(info.socketPath, "ping", 1000)
            expect(Option.getOrNull(pingAfter)).toContain('"ok":true')
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))

        const regularFileSocket = DaemonSocketPath.make(join(dir, "regular-file.sock"))
        writeFileSync(regularFileSocket, "keep-me", "utf8")
        const fileErr = yield* Effect.scoped(startScopedUnixSocketDaemon(repoRoot)).pipe(
          Effect.provide(
            makeUnixSocketDaemonLayer({ socketPathOverride: regularFileSocket }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.flip,
        )
        expect(fileErr._tag).toBe("DaemonServerError")
        expect(existsSync(regularFileSocket)).toBe(true)
      }),
    ),
  )

  it.effect("S-2.1: makeHarnessInfraLayer executes real port operations and persists caches across rebuilds", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const infraLayer1 = makeHarnessInfraLayer({ repoRoot })
        const infraLayer2 = makeHarnessInfraLayer({ repoRoot })

        const targetFile = WorkspaceFilePath.make(join(dir, "sample.txt"))
        const astBatch = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/s21.ts"),
            content: AstSourceContent.make("export const s21 = 1\n"),
          },
        ]
        const decisionKey = DecisionCacheKey.make("s21-decision-key")
        const decisionPayload = DecisionCachePayloadJson.make('{"ok":true}')

        yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* WorkspaceFs
            const runner = yield* HarnessSubprocessRunner
            const decisionCache = yield* DecisionCachePort
            const astCache = yield* AstGateCachePort
            const daemon = yield* UnixSocketDaemonPort
            const mutantCtx = yield* ActiveMutantContext

            yield* fs.writeTextFileAtomic(targetFile, WorkspaceFileContent.make("s21-content"))
            expect(yield* fs.readTextFile(targetFile)).toBe("s21-content")

            const execRes = yield* runner.exec({
              command: SubprocessCommand.make(process.execPath),
              args: [SubprocessArg.make("-e"), SubprocessArg.make("process.stdout.write('s21')")],
            })
            expect(execRes.stdout).toBe("s21")

            const astFirst = yield* astCache.evaluateBatch(astBatch, () => [])
            expect(astFirst.cacheHitCount).toBe(0)
            yield* decisionCache.store(decisionKey, decisionPayload, DecisionCacheTtlMillis.make(60_000))

            const daemonInfo = yield* daemon.startServer(repoRoot)
            expect(yield* daemon.isSocketAlive(daemonInfo.socketPath)).toBe(true)

            const active = yield* mutantCtx.runWithMutant(
              ActiveMutantId.make("m-s21"),
              mutantCtx.getCurrentMutant,
            )
            expect(Option.getOrNull(active)).toBe("m-s21")
          }),
        ).pipe(Effect.provide(infraLayer1))

        yield* Effect.gen(function* () {
          const astCache = yield* AstGateCachePort
          const decisionCache = yield* DecisionCachePort
          const astReloaded = yield* astCache.evaluateBatch(astBatch, () => [])
          expect(astReloaded.cacheHitCount).toBe(1)
          expect(Option.getOrNull(yield* decisionCache.lookup(decisionKey))).toBe(decisionPayload)
        }).pipe(Effect.provide(infraLayer2))

        expect(HarnessInfraLive).toBeDefined()
        expect(
          Layer.mergeAll(makeWorkspaceFsLayer(), makeHarnessSubprocessRunnerLayer()).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ).toBeDefined()
      }),
    ),
  )

  it.effect("UnixSocketDaemonLive handles lineHandler sync throws, Effect failures, and preserves override parent dir mode", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const parentDir = join(dir, "shared-parent")
        mkdirSync(parentDir, { recursive: true })
        chmodSync(parentDir, 0o755)
        const overrideSocket = DaemonSocketPath.make(join(parentDir, "override.sock"))

        yield* Effect.scoped(
          Effect.gen(function* () {
            const info = yield* startScopedUnixSocketDaemon(repoRoot, {
              socketPathOverride: overrideSocket,
              lineHandler: (line) => {
                if (line === "throw-sync") {
                  throw new Error("sync-boom")
                }
                return Effect.fail("effect-boom").pipe(Effect.orDie)
              },
            })
            expect(statSync(parentDir).mode & 0o777).toBe(0o755)
            expect(statSync(info.socketPath).mode & 0o777).toBe(0o600)

            const syncErrReply = yield* queryUnixSocketLine(info.socketPath, "throw-sync", 1000)
            expect(Option.getOrNull(syncErrReply)).toContain("sync-boom")

            const effErrReply = yield* queryUnixSocketLine(info.socketPath, "fail-effect", 1000)
            expect(Option.getOrNull(effErrReply)).toContain("effect-boom")
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )

  it.live("AstGateCacheLive does not negative-cache evaluateFile failures across subsequent evaluateBatch calls", () =>
    Effect.gen(function* () {
      const cache = yield* AstGateCachePort
      const batch = [{ filePath: AstSourceFilePath.make("libs/sample/domain/src/retry.ts"), content: AstSourceContent.make("export const r = 1\n") }]
      let calls = 0
      const failExit = yield* Effect.exit(cache.evaluateBatch(batch, () => { calls += 1; throw new Error("transient-boom") }))
      match(failExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          const failure = Option.getOrNull(Cause.findErrorOption(cause))
          expect(failure?._tag).toBe("AstGateEvaluationError")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected AstGateEvaluationError")
        })
        .exhaustive()
      const okReport = yield* cache.evaluateBatch(batch, () => { calls += 1; return [] })
      expect([okReport.verdict, okReport.cacheHitCount, calls]).toEqual(["clean", 0, 2])
    }).pipe(Effect.provide(AstGateCacheLive)),
  )
  it.live("DecisionCacheLive lookupOrCompute cleans up in-flight Deferred when leader fiber is interrupted", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("interrupt-key-1")
      const ttl = DecisionCacheTtlMillis.make(60_000)
      const entered = yield* Deferred.make<void>()
      const leader = yield* cache
        .lookupOrCompute({
          key,
          ttlMillis: ttl,
          compute: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(leader)
      expect(yield* cache.lookupOrCompute({ key, ttlMillis: ttl, compute: Effect.succeed(DecisionCachePayloadJson.make('{"v":2}')) })).toBe('{"v":2}')
    }).pipe(Effect.provide(DecisionCacheLive)))

  it.effect("nodeSyncHostIo.spawnDetached detects non-executable file (EACCES) synchronously", () =>
    withTempDir((dir) =>
      Effect.sync(() => {
        const scriptPath = join(dir, "non-exec.sh")
        writeFileSync(scriptPath, "#!/bin/sh\necho hi\n", "utf8")
        chmodSync(scriptPath, 0o644)
        const res = nodeSyncHostIo.spawnDetached(scriptPath, [])
        match(res)
          .with({ _tag: "SpawnFailed" }, (failed) => {
            expect(failed.errorCode).toBe("EACCES")
          })
          .with({ _tag: "Spawned" }, () => {
            expect.unreachable("Expected EACCES SpawnFailed")
          })
          .exhaustive()
      }),
    ),
  )

  it.live("AstGateCacheLive deduplicates batch entries, isolates evaluatorId, and resolves HARNESS_STATE_DIR", () =>
    Effect.gen(function* () {
      expect(
        resolveAstGateCachePath("/repo", { HARNESS_STATE_DIR: "/custom/state" }),
      ).toBe("/custom/state/cache/ast-gate-cache-v1.json")
      expect(
        resolveAstGateCachePath("/repo", { HARNESS_WORKTREE_ID: "wt-1" }),
      ).toBe("/repo/.harness/worktrees/wt-1/cache/ast-gate-cache-v1.json")

      const cache = yield* AstGateCachePort
      const dupFile = {
        filePath: AstSourceFilePath.make("libs/sample/domain/src/dup.ts"),
        content: AstSourceContent.make("export const d = 1\n"),
      }
      let evalCalls = 0
      const report1 = yield* cache.evaluateBatch(
        [dupFile, dupFile],
        (file) => {
          evalCalls += 1
          return [
            {
              category: "syntax-bans",
              rule: GateRuleId.make("test-rule"),
              message: GateViolationMessage.make("violation"),
              file: file.filePath,
              line: SourceLineNumber.make(1),
              enclosingSymbol: EnclosingSymbolName.make("d"),
            },
          ]
        },
        EvaluatorId.make("eval-a"),
      )
      expect(evalCalls).toBe(1)
      expect(report1.inspectedFileCount).toBe(1)
      expect(report1.violations).toHaveLength(1)

      const report2 = yield* cache.evaluateBatch([dupFile], () => {
        evalCalls += 1
        return []
      }, EvaluatorId.make("eval-b"))
      expect(evalCalls).toBe(2)
      expect(report2.verdict).toBe("clean")
    }).pipe(Effect.provide(AstGateCacheLive)),
  )

  it.live("DecisionCacheLive coalesces retry across followers when leader fails", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("coalesce-retry-1")
      const ttl = DecisionCacheTtlMillis.make(60_000)
      let computeCalls = 0
      const leaderEntered = yield* Deferred.make<void>()
      const releaseLeader = yield* Deferred.make<void>()

      const leaderFiber = yield* cache
        .lookupOrCompute({
          key,
          ttlMillis: ttl,
          compute: Deferred.succeed(leaderEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLeader)),
            Effect.andThen(
              Effect.sync(() => {
                computeCalls += 1
              }),
            ),
            Effect.andThen(Effect.fail("leader-failed")),
          ),
        })
        .pipe(Effect.exit, Effect.forkChild)

      yield* Deferred.await(leaderEntered)

      const followerEff = cache
        .lookupOrCompute({
          key,
          ttlMillis: ttl,
          compute: Effect.sync(() => {
            computeCalls += 1
            return DecisionCachePayloadJson.make('{"ok":true}')
          }),
        })
        .pipe(Effect.exit)

      const f1Fiber = yield* followerEff.pipe(Effect.forkChild)
      const f2Fiber = yield* followerEff.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseLeader, undefined)

      const [leaderExit, f1Exit, f2Exit] = yield* Effect.all([
        Fiber.join(leaderFiber),
        Fiber.join(f1Fiber),
        Fiber.join(f2Fiber),
      ])
      match(leaderExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Option.getOrNull(Cause.findErrorOption(cause))).toBe("leader-failed")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected leader to fail")
        })
        .exhaustive()
      expect(f1Exit._tag).toBe("Success")
      expect(f2Exit._tag).toBe("Success")
      expect(computeCalls).toBe(2)
    }).pipe(Effect.provide(DecisionCacheLive)),
  )

  it.live("UnixSocketDaemonLive refuses non-socket with reasonKind not-a-socket and queryUnixSocketLineDetailed reports reasons", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const regularFile = DaemonSocketPath.make(join(dir, "not-a-socket.sock"))
        writeFileSync(regularFile, "plain-file", "utf8")

        const nonSocketErr = yield* Effect.scoped(
          startScopedUnixSocketDaemon(repoRoot, { socketPathOverride: regularFile }),
        ).pipe(
          Effect.provide(UnixSocketDaemonLive),
          Effect.flip,
        )
        expect(nonSocketErr._tag).toBe("DaemonServerError")
        expect(nonSocketErr.reasonKind).toBe("not-a-socket")

        const missingQuery = yield* queryUnixSocketLineDetailed(
          join(dir, "missing.sock"),
          "ping",
          200,
        )
        match(missingQuery)
          .with({ _tag: "Unavailable" }, (unavail) => {
            expect(unavail.reason).toBe("missing-or-refused")
          })
          .with({ _tag: "Reply" }, () => {
            expect.unreachable("Expected Unavailable")
          })
          .exhaustive()
      }),
    ),
  )

  it.live("F-2.1 & F-20.5: UnixSocketDaemonLive returns fallbackToInProcess for bench and does not chmod socketPathOverride parent dir", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const repoRoot = WorkspaceFilePath.make(dir)
        const externalParent = join(dir, "external-parent")
        mkdirSync(externalParent, { recursive: true })
        chmodSync(externalParent, 0o755)
        const socketOverride = DaemonSocketPath.make(join(externalParent, "custom.sock"))

        yield* Effect.scoped(
          Effect.gen(function* () {
            const info = yield* startScopedUnixSocketDaemon(repoRoot, {
              socketPathOverride: socketOverride,
            })
            expect(info.socketPath).toBe(socketOverride)
            expect(statSync(externalParent).mode & 0o777).toBe(0o755)
            expect(statSync(socketOverride).mode & 0o777).toBe(0o600)

            const reply = yield* queryUnixSocketLine(
              socketOverride,
              JSON.stringify({ id: "b1", command: "bench" }),
              500,
            )
            expect(Option.getOrNull(reply)).toBe(
              JSON.stringify({ id: "b1", ok: false, command: "bench", fallbackToInProcess: true }),
            )
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )

  it.effect("F-15.1 & F-16.1: WorkspaceFsLive.exists returns false on ENOENT, fails with WorkspaceFsError on EACCES, and handles untrimmed/empty errors", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* WorkspaceFs
        const missing = WorkspaceFilePath.make(join(dir, "does-not-exist.txt"))
        expect(yield* fs.exists(missing)).toBe(false)

        const lockedDir = join(dir, "locked")
        mkdirSync(lockedDir, { recursive: true })
        writeFileSync(join(lockedDir, "secret.txt"), "x", "utf8")
        chmodSync(lockedDir, 0o000)
        const existsErr = yield* fs
          .exists(WorkspaceFilePath.make(join(lockedDir, "secret.txt")))
          .pipe(
            Effect.ensuring(Effect.sync(() => chmodSync(lockedDir, 0o755))),
            Effect.flip,
          )
        expect(existsErr._tag).toBe("WorkspaceFsError")
        expect(existsErr.operation).toBe("stat")

        const hostIo = {
          existsSync: () => {
            throw new Error("   ")
          },
          isFileSync: () => false,
          isDirectorySync: () => false,
          isSymbolicLinkSync: () => false,
          readTextSync: () => {
            throw new Error("  untrimmed host error  ")
          },
          readBytesSync: () => new Uint8Array(),
          writeTextSync: () => {},
          appendTextSync: () => {},
          mkdirRecursiveSync: () => {},
          renameSync: () => {},
          unlinkSync: () => {},
          readdirSync: () => [],
          realpathSync: (p: string) => p,
          execFileSync: () => ({
            _tag: "SpawnFailed" as const,
            spawnError: "   ",
            stdout: "",
            stderr: "",
          }),
        }

        const hostFsErr = yield* Effect.gen(function* () {
          const hfs = yield* WorkspaceFs
          return yield* hfs.exists(missing).pipe(Effect.flip)
        }).pipe(Effect.provide(makeWorkspaceFsHostIoLayer(hostIo)))
        expect(hostFsErr._tag).toBe("WorkspaceFsError")
        expect(hostFsErr.reason).toBe("Workspace filesystem stat failed")

        const hostReadErr = yield* Effect.gen(function* () {
          const hfs = yield* WorkspaceFs
          return yield* hfs.readTextFile(missing).pipe(Effect.flip)
        }).pipe(Effect.provide(makeWorkspaceFsHostIoLayer(hostIo)))
        expect(hostReadErr.reason).toBe("untrimmed host error")

        const runnerErr = yield* Effect.gen(function* () {
          const runner = yield* HarnessSubprocessRunner
          return yield* runner
            .exec({ command: SubprocessCommand.make("bad"), args: [] })
            .pipe(Effect.flip)
        }).pipe(Effect.provide(makeHarnessSubprocessRunnerHostIoLayer(hostIo)))
        expect(runnerErr._tag).toBe("HarnessSubprocessError")
        expect(runnerErr.reason).toBe("Command 'bad' failed to spawn")
      }).pipe(Effect.provide(makeWorkspaceFsLayer().pipe(Layer.provide(NodeServices.layer)))),
    ),
  )

  it.effect("F-6.1: LocalDecisionModel and makeLocalDecisionModelLayer normalize URL and wire HttpClient", () =>
    Effect.gen(function* () {
      expect(Layer.isLayer(LocalDecisionModel)).toBe(true)
      expect(DecisionModel.DecisionModel).toBeDefined()

      const captured: Array<{ readonly url: string; readonly model: string }> = []
      const mockHttpClient = HttpClient.make((req, url) => {
        const bodyText = match(req.body)
          .with({ _tag: "Uint8Array" }, (b) => b.text ?? new TextDecoder().decode(b.body))
          .with({ _tag: "Empty" }, () => "{}")
          .with({ _tag: "Raw" }, (b) => String(b.body))
          .with({ _tag: "FormData" }, () => "{}")
          .with({ _tag: "Stream" }, () => "{}")
          .exhaustive()
        const parsed = JSON.parse(bodyText) as { readonly model?: string }
        captured.push({ url: url.toString(), model: parsed.model ?? "" })
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({
                model: "clef-custom",
                answers: { check: { type: "noul", noul: 0.9 } },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      })

      const configured = makeLocalDecisionModelLayer({
        apiUrl: "  localhost:11434///  ",
        model: "clef-custom",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, mockHttpClient)))

      const TestDecision = Decision.make({
        input: Schema.Struct({ ok: Schema.Boolean }),
        decisions: {
          check: Decision.probability({ instructions: "Is the wiring valid?" }),
        },
      })

      const outcome = yield* DecisionModel.decide(TestDecision, { input: { ok: true } }).pipe(
        Effect.provide(configured),
      )
      expect(outcome.answers.check.probability).toBeCloseTo(0.9, 4)
      expect(captured).toEqual([
        { url: "http://localhost:11434/v1/systemone", model: "clef-custom" },
      ])
    }),
  )
})
