import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ActiveMutantId,
  AstSourceContent,
  AstSourceFilePath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  SubprocessArg,
  SubprocessCommand,
  SubprocessMaxBufferBytes,
  WorkspaceFileContent,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  ActiveMutantContext,
  AstGateCachePort,
  DecisionCachePort,
  HarnessSubprocessRunner,
  WorkspaceFs,
} from "@harness/service"
import {
  ActiveMutantContextLive,
  AstGateCacheLive,
  DecisionCacheLive,
  HarnessSubprocessRunnerLive,
  makeAstGateCacheLayer,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeWorkspaceFsHostIoLayer,
  nodeSyncHostIo,
  WorkspaceFsLive,
} from "../src/index.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-conformance-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

const runWorkspaceFsConformance = (name: string, layer: Layer.Layer<WorkspaceFs>) => {
  it.effect(`WorkspaceFs conformance (${name}): write, exists, read, and missing-file error`, () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* WorkspaceFs
        const target = WorkspaceFilePath.make(join(dir, "sub", "item.txt"))
        const missing = WorkspaceFilePath.make(join(dir, "does-not-exist.txt"))

        expect(yield* fs.exists(target)).toBe(false)
        yield* fs.writeTextFileAtomic(target, WorkspaceFileContent.make("conformance-data"))
        expect(yield* fs.exists(target)).toBe(true)
        expect(yield* fs.readTextFile(target)).toBe("conformance-data")

        const readErr = yield* fs.readTextFile(missing).pipe(Effect.flip)
        expect(readErr._tag).toBe("WorkspaceFsError")
        expect(readErr.operation).toBe("read")

        if (typeof process.getuid === "function" && process.getuid() !== 0) {
          const lockedDir = join(dir, "locked-dir")
          mkdirSync(lockedDir, { recursive: true })
          chmodSync(lockedDir, 0o000)
          const inaccessible = WorkspaceFilePath.make(join(lockedDir, "secret.txt"))
          const statErr = yield* fs.exists(inaccessible).pipe(
            Effect.flip,
            Effect.ensuring(
              Effect.sync(() => {
                chmodSync(lockedDir, 0o700)
              }),
            ),
          )
          expect(statErr._tag).toBe("WorkspaceFsError")
          expect(statErr.operation).toBe("stat")
        }
      }).pipe(Effect.provide(layer)),
    ),
  )
}

const runSubprocessConformance = (name: string, layer: Layer.Layer<HarnessSubprocessRunner>) => {
  it.live(
    `HarnessSubprocessRunner conformance (${name}): zero exit, non-zero exit, and invalid-input`,
    () =>
      Effect.gen(function* () {
        const runner = yield* HarnessSubprocessRunner

        const ok = yield* runner.exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("process.stdout.write('ok')")],
        })
        expect(ok.exitCode).toBe(0)
        expect(ok.stdout).toBe("ok")

        const nonZero = yield* runner.exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("process.exit(3)")],
        })
        expect(nonZero.exitCode).toBe(3)

        expect(() => Schema.decodeSync(SubprocessArg)("bad\0arg")).toThrow()
      }).pipe(Effect.provide(layer)),
  )
}

describe("@harness/infra port conformance suite", () => {
  runWorkspaceFsConformance("WorkspaceFsLive", WorkspaceFsLive)
  runWorkspaceFsConformance(
    "makeWorkspaceFsHostIoLayer",
    makeWorkspaceFsHostIoLayer(nodeSyncHostIo),
  )

  runSubprocessConformance("HarnessSubprocessRunnerLive", HarnessSubprocessRunnerLive)
  runSubprocessConformance(
    "makeHarnessSubprocessRunnerHostIoLayer",
    makeHarnessSubprocessRunnerHostIoLayer(nodeSyncHostIo),
  )

  it.effect("DecisionCachePort conformance: miss, store, hit, lookupOrCompute, and clear", () =>
    Effect.gen(function* () {
      const cache = yield* DecisionCachePort
      const key = DecisionCacheKey.make("conformance-key")
      const payload = DecisionCachePayloadJson.make('{"status":"ok"}')
      const ttl = DecisionCacheTtlMillis.make(60_000)

      expect(Option.isNone(yield* cache.lookup(key))).toBe(true)
      yield* cache.store(key, payload, ttl)
      expect(Option.getOrNull(yield* cache.lookup(key))).toBe(payload)

      const computed = yield* cache.lookupOrCompute({
        key: DecisionCacheKey.make("conformance-key-2"),
        ttlMillis: ttl,
        compute: Effect.succeed(DecisionCachePayloadJson.make('{"computed":true}')),
      })
      expect(computed).toBe('{"computed":true}')

      yield* cache.clear
      const stats = yield* cache.stats
      expect(stats.size).toBe(0)
    }).pipe(Effect.provide(DecisionCacheLive)),
  )

  it.effect("AstGateCachePort conformance: evaluateBatch hit/miss and clearCache", () =>
    Effect.gen(function* () {
      const cache = yield* AstGateCachePort
      const batch = [
        {
          filePath: AstSourceFilePath.make("libs/sample/domain/src/conformance.ts"),
          content: AstSourceContent.make("export const value = 1\n"),
        },
      ]

      const first = yield* cache.evaluateBatch(batch, () => [])
      expect(first.verdict).toBe("clean")
      expect(first.cacheHitCount).toBe(0)

      const second = yield* cache.evaluateBatch(batch, () => [])
      expect(second.cacheHitCount).toBe(1)
      expect(yield* cache.cacheSize).toBe(1)

      yield* cache.clearCache
      expect(yield* cache.cacheSize).toBe(0)
    }).pipe(Effect.provide(AstGateCacheLive)),
  )

  it.effect("ActiveMutantContext conformance: default None, scoped activation, and reset", () =>
    Effect.gen(function* () {
      const ctx = yield* ActiveMutantContext
      const m1 = ActiveMutantId.make("conformance-mutant")

      expect(Option.isNone(yield* ctx.getCurrentMutant)).toBe(true)
      const active = yield* ctx.runWithMutant(m1, ctx.getCurrentMutant)
      expect(Option.getOrNull(active)).toBe(m1)
      expect(Option.isNone(yield* ctx.getCurrentMutant)).toBe(true)
    }).pipe(Effect.provide(ActiveMutantContextLive)),
  )

  it.live(
    "AstGateCacheLive deduplicates concurrent evaluateBatch calls and preserves read errors",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const memLayer = makeAstGateCacheLayer().pipe(Layer.provide(NodeServices.layer))
          let evalCalls = 0
          const batch = [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/concurrent.ts"),
              content: AstSourceContent.make("export const c = 1\n"),
            },
          ]
          yield* Effect.all(
            Array.from({ length: 4 }, () =>
              Effect.gen(function* () {
                const cache = yield* AstGateCachePort
                return yield* cache.evaluateBatch(batch, () => {
                  evalCalls += 1
                  return []
                })
              }),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.provide(memLayer))
          expect(evalCalls).toBe(1)

          const dirAsCache = WorkspaceFilePath.make(join(dir, "dir-cache"))
          mkdirSync(dirAsCache, { recursive: true })
          const badLayer = makeAstGateCacheLayer({ cacheFilePath: dirAsCache }).pipe(
            Layer.provide(NodeServices.layer),
          )
          const [evalErr, sizeErr] = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            const e1 = yield* cache.evaluateBatch(batch, () => []).pipe(Effect.flip)
            const e2 = yield* cache.cacheSize.pipe(Effect.flip)
            return [e1, e2] as const
          }).pipe(Effect.provide(badLayer))
          match(evalErr)
            .with({ _tag: "WorkspaceFsError" }, (err) => {
              expect(err.operation).toBe("read")
            })
            .with({ _tag: "AstGateEvaluationError" }, () => {
              expect.unreachable("Expected WorkspaceFsError")
            })
            .exhaustive()
          expect(sizeErr.operation).toBe("read")
        }),
      ),
  )

  it.live(
    "makeHarnessSubprocessRunnerHostIoLayer classifies signal, max-buffer, and spawn-error",
    () =>
      Effect.gen(function* () {
        const runner = yield* HarnessSubprocessRunner

        const sigErr = yield* runner
          .exec({
            command: SubprocessCommand.make(process.execPath),
            args: [
              SubprocessArg.make("-e"),
              SubprocessArg.make("process.kill(process.pid, 'SIGTERM')"),
            ],
          })
          .pipe(Effect.flip)
        expect(sigErr.failureKind).toBe("signal")

        const bufErr = yield* runner
          .exec({
            command: SubprocessCommand.make(process.execPath),
            args: [
              SubprocessArg.make("-e"),
              SubprocessArg.make("process.stdout.write('x'.repeat(4096))"),
            ],
            maxBufferBytes: SubprocessMaxBufferBytes.make(1024),
          })
          .pipe(Effect.flip)
        expect(bufErr.failureKind).toBe("max-buffer")

        const spawnErr = yield* runner
          .exec({
            command: SubprocessCommand.make("definitely-nonexistent-binary-xyz-42"),
            args: [],
          })
          .pipe(Effect.flip)
        expect(spawnErr.failureKind).toBe("spawn-error")
      }).pipe(Effect.provide(makeHarnessSubprocessRunnerHostIoLayer(nodeSyncHostIo))),
  )
})
