import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import {
  ActiveMutantId,
  AstSourceContent,
  AstSourceFilePath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  SubprocessArg,
  SubprocessCommand,
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

const runWorkspaceFsConformance = (
  name: string,
  layer: Layer.Layer<WorkspaceFs>,
) => {
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
      }).pipe(Effect.provide(layer)),
    ),
  )
}

const runSubprocessConformance = (
  name: string,
  layer: Layer.Layer<HarnessSubprocessRunner>,
) => {
  it.live(`HarnessSubprocessRunner conformance (${name}): zero exit, non-zero exit, and invalid-input`, () =>
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

      const invalid = yield* runner
        .exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("bad\0arg")],
        })
        .pipe(Effect.flip)
      expect(invalid._tag).toBe("HarnessSubprocessError")
      expect(invalid.failureKind).toBe("invalid-input")
    }).pipe(Effect.provide(layer)),
  )
}

describe("@harness/infra port conformance suite", () => {
  runWorkspaceFsConformance("WorkspaceFsLive", WorkspaceFsLive)
  runWorkspaceFsConformance("makeWorkspaceFsHostIoLayer", makeWorkspaceFsHostIoLayer(nodeSyncHostIo))

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

      const first = yield* cache.evaluateBatch(batch)
      expect(first.verdict).toBe("clean")
      expect(first.cacheHitCount).toBe(0)

      const second = yield* cache.evaluateBatch(batch)
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
})
