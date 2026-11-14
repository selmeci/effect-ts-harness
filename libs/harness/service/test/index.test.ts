import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  ActiveMutantId,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  NonNegativeCount,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessOutput,
  WorkspaceFileContent,
  WorkspaceFilePath,
  makeAstGateEvaluationReport,
} from "@harness/contract"
import {
  ActiveMutantContext,
  AstGateCachePort,
  DecisionCachePort,
  HarnessSubprocessRunner,
  UnixSocketDaemonPort,
  WorkspaceFs,
} from "../src/index.js"

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
      const res = yield* ctx.runWithMutant(ActiveMutantId.make("m-1"), Effect.succeed("ran"))
      expect(res).toBe("ran")
    }).pipe(
      Effect.provideService(ActiveMutantContext, {
        getCurrentMutant: Effect.succeedNone,
        runWithMutant: (_id, eff) => eff,
      }),
    ),
  )

  it.effect("resolves AstGateCachePort, DecisionCachePort, and UnixSocketDaemonPort from test layers", () =>
    Effect.gen(function* () {
      const astCache = yield* AstGateCachePort
      const astReport = yield* astCache.evaluateBatch([])
      expect(astReport.verdict).toBe("clean")

      const decCache = yield* DecisionCachePort
      const payload = yield* decCache.lookupOrCompute({
        key: DecisionCacheKey.make("k1"),
        ttlMillis: DecisionCacheTtlMillis.make(1000),
        compute: Effect.succeed(DecisionCachePayloadJson.make('{"ok":true}')),
      })
      expect(payload).toBe('{"ok":true}')

      const daemon = yield* UnixSocketDaemonPort
      const alive = yield* daemon.isSocketAlive(DaemonSocketPath.make("/tmp/test.sock"))
      expect(alive).toBe(false)
    }).pipe(
      Effect.provideService(AstGateCachePort, {
        evaluateBatch: () =>
          Effect.succeed(
            makeAstGateEvaluationReport({
              violations: [],
              inspectedFileCount: NonNegativeCount.make(0),
              cacheHitCount: NonNegativeCount.make(0),
            }),
          ),
        clearCache: Effect.void,
        cacheSize: Effect.succeed(NonNegativeCount.make(0)),
      }),
      Effect.provideService(DecisionCachePort, {
        lookup: () => Effect.succeedNone,
        store: () => Effect.void,
        lookupOrCompute: (input) => input.compute,
        clear: Effect.void,
        stats: Effect.succeed({
          hits: NonNegativeCount.make(0),
          misses: NonNegativeCount.make(0),
          coalescedRequests: NonNegativeCount.make(0),
          size: NonNegativeCount.make(0),
        }),
      }),
      Effect.provideService(UnixSocketDaemonPort, {
        startServer: (repoRoot) =>
          Effect.succeed({
            socketPath: DaemonSocketPath.make("/tmp/test.sock"),
            repoRoot,
          }),
        isSocketAlive: () => Effect.succeed(false),
      }),
    ),
  )
})
