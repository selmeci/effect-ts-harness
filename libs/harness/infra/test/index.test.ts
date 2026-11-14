import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import {
  ActiveMutantId,
  AstSourceContent,
  AstSourceFilePath,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  HARNESS_GATE_RULE_VERSION,
  SubprocessArg,
  SubprocessCommand,
  SubprocessMaxBufferBytes,
  SubprocessTimeoutMs,
  WorkspaceFileContent,
  WorkspaceFilePath,
} from "@harness/contract"
import { execCheckedSubprocess, statAndReadWorkspaceFiles } from "@harness/gates"
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
  makeAstGateCacheLayer,
  makeDecisionCacheLayer,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
  makeUnixSocketDaemonLayer,
  makeWorkspaceFsHostIoLayer,
  makeWorkspaceFsLayer,
  nodeSyncHostIo,
  queryUnixSocketLine,
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

        const stats = yield* statAndReadWorkspaceFiles([targetPath])
        expect(stats).toHaveLength(1)
        expect(stats[0]?.lineCount).toBe(3)

        const readErr = yield* fs.readTextFile(missingPath).pipe(Effect.flip)
        expect(readErr._tag).toBe("WorkspaceFsError")
        expect(readErr.operation).toBe("read")
        expect(readErr.filePath).toBe(missingPath)
      }).pipe(Effect.provide(WorkspaceFsLive)),
    ),
  )

  it.live("HarnessSubprocessRunnerLive executes zero, failing, and timed-out commands", () =>
    Effect.gen(function* () {
      const okResult = yield* execCheckedSubprocess({
        command: SubprocessCommand.make(process.execPath),
        args: [
          SubprocessArg.make("-e"),
          SubprocessArg.make("process.stdout.write('hello-infra')"),
        ],
      })
      expect(okResult.exitCode).toBe(0)
      expect(okResult.stdout).toBe("hello-infra")

      const failErr = yield* execCheckedSubprocess({
        command: SubprocessCommand.make(process.execPath),
        args: [
          SubprocessArg.make("-e"),
          SubprocessArg.make("process.stderr.write('boom'); process.exit(2)"),
        ],
      }).pipe(Effect.flip)
      expect(failErr._tag).toBe("HarnessSubprocessError")
      expect(failErr.exitCode).toBe(2)
      expect(failErr.stderr).toContain("boom")

      const timeoutErr = yield* execCheckedSubprocess({
        command: SubprocessCommand.make(process.execPath),
        args: [
          SubprocessArg.make("-e"),
          SubprocessArg.make("setTimeout(() => {}, 5000)"),
        ],
        timeoutMs: SubprocessTimeoutMs.make(50),
      }).pipe(Effect.flip)
      expect(timeoutErr._tag).toBe("HarnessSubprocessError")
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
          const first = yield* cache.evaluateBatch(batch)
          const second = yield* cache.evaluateBatch(batch)
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
          return yield* cache.evaluateBatch(batch)
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

  it.effect("F-4.2: nodeSyncHostIo.execFileSync populates spawnError, timedOut, exitCode: -1, and rejects null bytes", () =>
    Effect.sync(() => {
      const missingRes = nodeSyncHostIo.execFileSync("definitely-nonexistent-binary-xyz-42", [])
      expect(missingRes.exitCode).toBe(-1)
      expect(missingRes.spawnError).toBeDefined()
      expect(missingRes.timedOut).toBe(false)

      const timeoutRes = nodeSyncHostIo.execFileSync(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        { timeoutMs: 50 },
      )
      expect(timeoutRes.exitCode).toBe(-1)
      expect(timeoutRes.timedOut).toBe(true)

      expect(() => nodeSyncHostIo.execFileSync("node\0bad", [])).toThrow()
      expect(() => nodeSyncHostIo.execFileSync(process.execPath, ["arg\0bad"])).toThrow()
      expect(() =>
        nodeSyncHostIo.execFileSync(process.execPath, ["-e", "0"], { cwd: "/tmp/bad\0cwd" }),
      ).toThrow()
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

  it.live("F-8.1b & S-1.5: DecisionCacheLive lookupOrCompute deduplicates concurrent calls via ScopedCache", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("concurrent-key-1")
      const ttl = DecisionCacheTtlMillis.make(60_000)
      let computeRuns = 0

      const results = yield* Effect.all(
        Array.from({ length: 5 }, () =>
          cache.lookupOrCompute({
            key,
            ttlMillis: ttl,
            compute: Effect.sleep("25 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  computeRuns += 1
                  return DecisionCachePayloadJson.make('{"ok":true}')
                }),
              ),
            ),
          }),
        ),
        { concurrency: "unbounded" },
      )

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
          yield* cache.evaluateBatch([{ filePath, content }])
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
          return yield* cache.evaluateBatch([{ filePath, content }])
        }).pipe(Effect.provide(reloadedLayer))
        expect(report.cacheHitCount).toBe(0)
      }),
    ),
  )

  it.effect("F-15.1: DecisionCacheLive and AstGateCacheLive do not commit in-memory state when disk persist fails", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const blockingFile = join(dir, "blocking-file")
        writeFileSync(blockingFile, "not-a-dir", "utf8")
        const unwritableDecisionPath = WorkspaceFilePath.make(join(blockingFile, "decisions.json"))
        const unwritableAstPath = WorkspaceFilePath.make(join(blockingFile, "ast.json"))

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
        expect(decisionStats.size).toBe(0)

        const astLayer = makeAstGateCacheLayer({ cacheFilePath: unwritableAstPath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const [evalErr, astSize] = yield* Effect.gen(function* () {
          const cache = yield* AstGateCachePort
          const err = yield* cache
            .evaluateBatch([
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/a.ts"),
                content: AstSourceContent.make("export const a = 1\n"),
              },
            ])
            .pipe(Effect.flip)
          const size = yield* cache.cacheSize
          return [err, size] as const
        }).pipe(Effect.provide(astLayer))
        expect(evalErr._tag).toBe("WorkspaceFsError")
        expect(astSize).toBe(0)
      }),
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
      expect(spawnErr.exitCode).toBe(-1)

      const timeoutErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("setTimeout(() => {}, 5000)")],
          timeoutMs: SubprocessTimeoutMs.make(50),
        })
        .pipe(Effect.flip)
      expect(timeoutErr.failureKind).toBe("timeout")
      expect(timeoutErr.exitCode).toBe(-1)

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
      expect(maxBufErr.exitCode).toBe(-1)

      const invalidArgErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("bad\0arg")],
        })
        .pipe(Effect.flip)
      expect(invalidArgErr.failureKind).toBe("invalid-input")

      const invalidCwdErr = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("0")],
          cwd: WorkspaceFilePath.make("/tmp/bad\0cwd"),
        })
        .pipe(Effect.flip)
      expect(invalidCwdErr.failureKind).toBe("invalid-input")
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
            expect(Option.getOrNull(benchReply)).toContain('"ok":true')

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

  it.effect("S-2.1: make*Layer factories compose with NodeServices.layer and HarnessInfraLive provides all 6 ports", () =>
    Effect.gen(function* () {
      const fs = yield* WorkspaceFs
      const runner = yield* HarnessSubprocessRunner
      const decisionCache = yield* DecisionCachePort
      const astCache = yield* AstGateCachePort
      const daemon = yield* UnixSocketDaemonPort
      const mutantCtx = yield* ActiveMutantContext

      expect(fs).toBeDefined()
      expect(runner).toBeDefined()
      expect(decisionCache).toBeDefined()
      expect(astCache).toBeDefined()
      expect(daemon).toBeDefined()
      expect(Option.isNone(yield* mutantCtx.getCurrentMutant)).toBe(true)

      const composed = Layer.mergeAll(
        makeWorkspaceFsLayer(),
        makeHarnessSubprocessRunnerLayer(),
      ).pipe(Layer.provide(NodeServices.layer))
      expect(composed).toBeDefined()
    }).pipe(Effect.provide(HarnessInfraLive)),
  )
})
