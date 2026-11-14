import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  SubprocessArg,
  SubprocessCommand,
  SubprocessTimeoutMs,
  WorkspaceFileContent,
  WorkspaceFilePath,
} from "@harness/contract"
import { execCheckedSubprocess, statAndReadWorkspaceFiles } from "@harness/gates"
import { AstGateCachePort, DecisionCachePort, UnixSocketDaemonPort, WorkspaceFs } from "@harness/service"
import {
  AstGateCacheLive,
  DecisionCacheLive,
  HarnessInfraLive,
  HarnessSubprocessRunnerNodeLive,
  makeAstGateCacheLayer,
  makeDecisionCacheLayer,
  makeUnixSocketDaemonLayer,
  nodeSyncHostIo,
  queryUnixSocketLine,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  WorkspaceFsNodeLive,
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
      expect(WorkspaceFsNodeLive).toBeDefined()
      expect(HarnessSubprocessRunnerNodeLive).toBeDefined()
      expect(AstGateCacheLive).toBeDefined()
      expect(DecisionCacheLive).toBeDefined()
      expect(UnixSocketDaemonLive).toBeDefined()
      expect(HarnessInfraLive).toBeDefined()
    }),
  )

  it.effect("WorkspaceFsNodeLive reads, atomically writes, checks existence, and maps errors", () =>
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
      }).pipe(Effect.provide(WorkspaceFsNodeLive)),
    ),
  )

  it.live("HarnessSubprocessRunnerNodeLive executes zero, failing, and timed-out commands", () =>
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
    }).pipe(Effect.provide(HarnessSubprocessRunnerNodeLive)),
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

        const layer1 = makeAstGateCacheLayer({ cacheFilePath })
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

        const layer2 = makeAstGateCacheLayer({ cacheFilePath })
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

        const layer1 = makeDecisionCacheLayer({ cacheFilePath })
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

        const layer2 = makeDecisionCacheLayer({ cacheFilePath })
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
          Effect.provide(makeUnixSocketDaemonLayer({ socketPathOverride: badSocketPath })),
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
})
