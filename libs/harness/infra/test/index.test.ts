import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Logger, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ActiveMutantId,
  AstGatePackageTag,
  type AstGateViolationContract,
  AstSourceContent,
  AstSourceFilePath,
  CompilerVersionTag,
  computeContentSha256,
  computeGateRuleVersionFromSources,
  computeWorkspaceFileLineCount,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  EnclosingSymbolName,
  EvaluatorId,
  GateRuleId,
  GateRuleVersion,
  GateViolationMessage,
  makePersistedAstCacheKey,
  PersistedAstCacheStore,
  SourceLineNumber,
  SubprocessArg,
  SubprocessCommand,
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
  type AstGateCacheRuleSourceConfig,
  DecisionCacheLive,
  HarnessInfraLive,
  HarnessSubprocessRunnerLive,
  makeAstGateCacheLayer,
  makeDecisionCacheLayer,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeUnixSocketDaemonLayer,
  makeWorkspaceFsHostIoLayer,
  nodeSyncHostIo,
  queryUnixSocketLine,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  WorkspaceFsLive,
} from "../src/index.js"
import { HookInfraLive } from "../src/hook-fastpath.js"
import { withTempDir } from "./helpers/infra-index-fixture.js"

const TEST_RULE_SOURCE_FILES = [
  WorkspaceFilePath.make("rules/rule-a.ts"),
  WorkspaceFilePath.make("rules/rule-b.ts"),
] as const

const makeTestAstCacheLayer = (
  cacheFilePath: WorkspaceFilePath,
  ruleSource: AstGateCacheRuleSourceConfig,
) => makeAstGateCacheLayer({ cacheFilePath, ruleSource }).pipe(Layer.provide(NodeServices.layer))

const makeCaptureLogger = () => {
  const entries: Array<{ readonly level: string; readonly text: string }> = []
  const logger = Logger.make(({ logLevel, message }) => {
    entries.push({ level: String(logLevel), text: String(message) })
  })
  return { entries, layer: Logger.layer([logger]) }
}

const writeFixtureRuleFiles = (ruleSourceRoot: string, contents: readonly [string, string]) => {
  TEST_RULE_SOURCE_FILES.forEach((rel, idx) => {
    const abs = join(ruleSourceRoot, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, contents[idx] ?? "", "utf8")
  })
}

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

        yield* fs.writeTextFileAtomic(targetPath, WorkspaceFileContent.make("line1\nline2\n"))
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
        args: [SubprocessArg.make("-e"), SubprocessArg.make("process.stdout.write('hello-infra')")],
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
          args: [SubprocessArg.make("-e"), SubprocessArg.make("setTimeout(() => {}, 5000)")],
          timeoutMs: SubprocessTimeoutMs.make(50),
        })
        .pipe(Effect.flip)
      expect(timeoutErr._tag).toBe("HarnessSubprocessError")
      expect(timeoutErr.failureKind).toBe("timeout")
    }).pipe(Effect.provide(HarnessSubprocessRunnerLive)),
  )

  it.effect(
    "REQ-3.1: AstGateCacheLive reuses cached digests and persists across layer rebuilds",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const cacheFilePath = WorkspaceFilePath.make(join(dir, "cache", "ast-gates.json"))
          const batch = [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/clean.ts"),
              content: AstSourceContent.make("export const answer = 42\n"),
            },
          ]

          const layer1 = makeAstGateCacheLayer({ cacheFilePath }).pipe(
            Layer.provide(NodeServices.layer),
          )
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

          const layer2 = makeAstGateCacheLayer({ cacheFilePath }).pipe(
            Layer.provide(NodeServices.layer),
          )
          const persistedReport = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(layer2))

          expect(persistedReport.verdict).toBe("clean")
          expect(persistedReport.cacheHitCount).toBe(1)
        }),
      ),
  )

  it.effect(
    "F-13.1: AstGateCacheLive hashes rule files + compilerVersion, invalidates on edit, and preserves non-empty violations",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const ruleSourceRoot = WorkspaceFilePath.make(join(dir, "rule-root"))
          const cacheFilePath = WorkspaceFilePath.make(join(dir, "cache", "ast-gate-cache.json"))
          const compilerVersion = CompilerVersionTag.make("5.9.3")
          const initialContents = ["// rule-a v1\n", "// rule-b v1\n"] as const
          writeFixtureRuleFiles(ruleSourceRoot, initialContents)
          const expectedV1 = Result.getOrThrow(
            computeGateRuleVersionFromSources(
              TEST_RULE_SOURCE_FILES.map((filePath, idx) => ({
                filePath,
                content: AstSourceContent.make(initialContents[idx] ?? ""),
              })),
              compilerVersion,
            ),
          )
          const ruleSource: AstGateCacheRuleSourceConfig = {
            _tag: "HashedSources",
            ruleSourceFiles: TEST_RULE_SOURCE_FILES,
            ruleSourceRoot,
            compilerVersion,
          }
          const targetPath = AstSourceFilePath.make("libs/sample/domain/src/clean.ts")
          const batch = [
            { filePath: targetPath, content: AstSourceContent.make("export const answer = 42\n") },
          ]

          const r1 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, ruleSource)))
          expect(r1.verdict).toBe("clean")
          expect(r1.cacheHitCount).toBe(0)

          const r2 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, ruleSource)))
          expect(r2.cacheHitCount).toBe(1)

          const storeV1 = yield* Schema.decodeEffect(Schema.fromJsonString(PersistedAstCacheStore))(
            readFileSync(cacheFilePath, "utf8"),
          )
          expect(storeV1.version).toBe(expectedV1)
          expect(Object.keys(storeV1.entries)).toHaveLength(1)

          // Mutating a rule file invalidates previous entries and persists non-empty violations
          const updatedContents = ["// rule-a v1\n", "// rule-b v2 stricter\n"] as const
          writeFixtureRuleFiles(ruleSourceRoot, updatedContents)
          const expectedV2 = Result.getOrThrow(
            computeGateRuleVersionFromSources(
              TEST_RULE_SOURCE_FILES.map((filePath, idx) => ({
                filePath,
                content: AstSourceContent.make(updatedContents[idx] ?? ""),
              })),
              compilerVersion,
            ),
          )
          expect(expectedV2).not.toBe(expectedV1)

          const persistedViolation: AstGateViolationContract = {
            category: "syntax-bans",
            rule: GateRuleId.make("stricter-rule"),
            message: GateViolationMessage.make("detected after rule update"),
            file: targetPath,
            line: SourceLineNumber.make(1),
            enclosingSymbol: EnclosingSymbolName.make("answer"),
          }
          const r3 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [persistedViolation])
          }).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, ruleSource)))
          expect(r3.verdict).toBe("violated")
          expect(r3.cacheHitCount).toBe(0)
          expect(r3.violations).toEqual([persistedViolation])

          const storeV2 = yield* Schema.decodeEffect(Schema.fromJsonString(PersistedAstCacheStore))(
            readFileSync(cacheFilePath, "utf8"),
          )
          expect(storeV2.version).toBe(expectedV2)
          expect(Object.keys(storeV2.entries)).toHaveLength(1)

          const r4 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, ruleSource)))
          expect(r4.verdict).toBe("violated")
          expect(r4.cacheHitCount).toBe(1)
          expect(r4.violations).toEqual([persistedViolation])
        }),
      ),
  )

  it.effect(
    "F-6.1 / F-4.1 / F-6.2: ExplicitVersion short-circuits disk reads and omitted ruleSourceRoot discovers workspace root",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const explicitCachePath = WorkspaceFilePath.make(join(dir, "explicit-ast.json"))
          const explicitRule: AstGateCacheRuleSourceConfig = {
            _tag: "ExplicitVersion",
            ruleVersion: GateRuleVersion.make("explicit-override-v1"),
          }
          const batch = [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/explicit.ts"),
              content: AstSourceContent.make("export const e = 1\n"),
            },
          ]
          const e1 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(explicitCachePath, explicitRule)))
          expect(e1.cacheHitCount).toBe(0)

          const e2 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(explicitCachePath, explicitRule)))
          expect(e2.cacheHitCount).toBe(1)

          const defaultRootCachePath = WorkspaceFilePath.make(join(dir, "default-root-ast.json"))
          const defaultRootRule: AstGateCacheRuleSourceConfig = {
            _tag: "HashedSources",
            ruleSourceFiles: [
              WorkspaceFilePath.make("libs/harness/gates/src/ast-cache.ts"),
              WorkspaceFilePath.make("libs/harness/gates/src/migration-check.ts"),
            ],
          }
          const d1 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(defaultRootCachePath, defaultRootRule)))
          expect(d1.cacheHitCount).toBe(0)

          const defaultStore = yield* Schema.decodeEffect(
            Schema.fromJsonString(PersistedAstCacheStore),
          )(readFileSync(defaultRootCachePath, "utf8"))
          expect(defaultStore.version).toMatch(/^ast-gates-[0-9a-f]{64}$/)

          const d2 = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(defaultRootCachePath, defaultRootRule)))
          expect(d2.cacheHitCount).toBe(1)
        }),
      ),
  )

  it.effect(
    "F-3.1 / F-6.3: 1-of-N missing rule file enters Uncached mode without memoizing or clobbering healthy disk cache",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const ruleSourceRoot = WorkspaceFilePath.make(join(dir, "rule-root"))
          const cacheFilePath = WorkspaceFilePath.make(join(dir, "cache", "ast-gate-cache-v1.json"))
          writeFixtureRuleFiles(ruleSourceRoot, ["// a\n", "// b\n"])
          const ruleSource: AstGateCacheRuleSourceConfig = {
            _tag: "HashedSources",
            ruleSourceFiles: TEST_RULE_SOURCE_FILES,
            ruleSourceRoot,
          }
          const batch = [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/x.ts"),
              content: AstSourceContent.make("export const x = 1\n"),
            },
          ]

          yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            yield* cache.evaluateBatch(batch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, ruleSource)))
          const healthyDiskBefore = readFileSync(cacheFilePath, "utf8")

          rmSync(join(ruleSourceRoot, TEST_RULE_SOURCE_FILES[1]))
          let evalCalls = 0
          const capture = makeCaptureLogger()
          const [r1, r2, sizeAfter] = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            const first = yield* cache.evaluateBatch(batch, () => {
              evalCalls += 1
              return []
            })
            const second = yield* cache.evaluateBatch(batch, () => {
              evalCalls += 1
              return []
            })
            const size = yield* cache.cacheSize
            return [first, second, size] as const
          }).pipe(
            Effect.provide(
              Layer.mergeAll(makeTestAstCacheLayer(cacheFilePath, ruleSource), capture.layer),
            ),
          )

          expect(evalCalls).toBe(2)
          expect(r1.cacheHitCount).toBe(0)
          expect(r2.cacheHitCount).toBe(0)
          expect(sizeAfter).toBe(0)
          expect(readFileSync(cacheFilePath, "utf8")).toBe(healthyDiskBefore)
          expect(capture.entries.some((e) => e.text.includes("rules/rule-b.ts"))).toBe(true)
        }),
      ),
  )

  it.effect(
    "F-9.1 / F-9.2 / F-12.1: resets legacy versions without Corrupt warning, recovers invalid JSON, logs evicted entries, and merges sibling writes",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const targetPath = AstSourceFilePath.make("libs/sample/domain/src/upgrade.ts")
          const batch = [
            { filePath: targetPath, content: AstSourceContent.make("export const u = 1\n") },
          ]

          // Legacy upgrade resets cleanly with info log and zero "Corrupt" warnings
          const legacyPath = WorkspaceFilePath.make(join(dir, "legacy-ast.json"))
          writeFileSync(
            legacyPath,
            JSON.stringify({ version: "ast-gates-v12", entries: { "legacy-bad": { foo: 1 } } }),
            "utf8",
          )
          const legacyCapture = makeCaptureLogger()
          const legacyReport = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                makeTestAstCacheLayer(legacyPath, {
                  _tag: "ExplicitVersion",
                  ruleVersion: GateRuleVersion.make("ast-gates-new"),
                }),
                legacyCapture.layer,
              ),
            ),
          )
          expect(legacyReport.cacheHitCount).toBe(0)
          expect(legacyCapture.entries.some((e) => e.text.includes("Corrupt"))).toBe(false)
          expect(
            legacyCapture.entries.some((e) => e.text.includes("Resetting AST gate cache")),
          ).toBe(true)

          // Corrupt JSON and schema-invalid JSON recover with warning
          const badPayloads = ["{not-json", JSON.stringify({ version: 123, entries: [] })] as const
          for (const [idx, rawBad] of badPayloads.entries()) {
            const badPath = WorkspaceFilePath.make(join(dir, `bad-${idx}.json`))
            writeFileSync(badPath, rawBad, "utf8")
            const badCapture = makeCaptureLogger()
            const badReport = yield* Effect.gen(function* () {
              const cache = yield* AstGateCachePort
              return yield* cache.evaluateBatch(batch, () => [])
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  makeAstGateCacheLayer({ cacheFilePath: badPath }).pipe(
                    Layer.provide(NodeServices.layer),
                  ),
                  badCapture.layer,
                ),
              ),
            )
            expect(badReport.cacheHitCount).toBe(0)
            expect(badCapture.entries.some((e) => e.text.includes("Corrupt AST gate cache"))).toBe(
              true,
            )
          }

          // Active version with 1 valid entry + 1 stale entry logs eviction and hits valid entry
          const evictPath = WorkspaceFilePath.make(join(dir, "evict-ast.json"))
          const activeVer = GateRuleVersion.make("evict-active-v1")
          const targetBatchItem = batch[0]
          const contentHash = computeContentSha256(
            targetBatchItem ? targetBatchItem.content : AstSourceContent.make(""),
          )
          const validKey = makePersistedAstCacheKey(
            targetPath,
            AstGatePackageTag.make("domain"),
            activeVer,
            EvaluatorId.make("default"),
          )
          const staleKey = makePersistedAstCacheKey(
            AstSourceFilePath.make("libs/sample/domain/src/stale.ts"),
            AstGatePackageTag.make("domain"),
            GateRuleVersion.make("evict-old-v0"),
            EvaluatorId.make("default"),
          )
          writeFileSync(
            evictPath,
            JSON.stringify({
              version: activeVer,
              entries: {
                [validKey]: { contentSha256: contentHash, ruleVersion: activeVer, violations: [] },
                [staleKey]: {
                  contentSha256: contentHash,
                  ruleVersion: "evict-old-v0",
                  violations: [],
                },
              },
            }),
            "utf8",
          )
          const evictCapture = makeCaptureLogger()
          const evictReport = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(batch, () => [])
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                makeTestAstCacheLayer(evictPath, {
                  _tag: "ExplicitVersion",
                  ruleVersion: activeVer,
                }),
                evictCapture.layer,
              ),
            ),
          )
          expect(evictReport.cacheHitCount).toBe(1)
          expect(evictCapture.entries.some((e) => e.text.includes("Evicted 1"))).toBe(true)

          // Cross-process read-before-write merge preserves sibling writes
          const sharedPath = WorkspaceFilePath.make(join(dir, "shared-merge.json"))
          const mergeVer: AstGateCacheRuleSourceConfig = {
            _tag: "ExplicitVersion",
            ruleVersion: GateRuleVersion.make("shared-merge-v1"),
          }
          const fileA = {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/a.ts"),
            content: AstSourceContent.make("export const a = 1\n"),
          }
          const fileB = {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/b.ts"),
            content: AstSourceContent.make("export const b = 2\n"),
          }
          yield* Effect.gen(function* () {
            const cacheB = yield* AstGateCachePort
            yield* cacheB.cacheSize
            yield* Effect.gen(function* () {
              const cacheA = yield* AstGateCachePort
              yield* cacheA.evaluateBatch([fileA], () => [])
            }).pipe(Effect.provide(makeTestAstCacheLayer(sharedPath, mergeVer)))
            yield* cacheB.evaluateBatch([fileB], () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(sharedPath, mergeVer)))

          const mergedReport = yield* Effect.gen(function* () {
            const cacheC = yield* AstGateCachePort
            return yield* cacheC.evaluateBatch([fileA, fileB], () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(sharedPath, mergeVer)))
          expect(mergedReport.cacheHitCount).toBe(2)
        }),
      ),
  )

  it.effect(
    "F-12.1 / F-10.1: handles content edits, packageTag isolation, disk clearCache, symlink refusal, and HookInfraLive decoupling",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const cacheFilePath = WorkspaceFilePath.make(join(dir, "ops-ast.json"))
          const verCfg: AstGateCacheRuleSourceConfig = {
            _tag: "ExplicitVersion",
            ruleVersion: GateRuleVersion.make("ops-v1"),
          }
          const targetPath = AstSourceFilePath.make("libs/sample/domain/src/ops.ts")
          const [editMissReport, tagSize, existsAfterClear, sizeAfterClear] = yield* Effect.gen(
            function* () {
              const cache = yield* AstGateCachePort
              yield* cache.evaluateBatch(
                [
                  {
                    filePath: targetPath,
                    content: AstSourceContent.make("export const v = 1\n"),
                    packageTag: AstGatePackageTag.make("domain"),
                  },
                ],
                () => [],
              )
              const edited = yield* cache.evaluateBatch(
                [
                  {
                    filePath: targetPath,
                    content: AstSourceContent.make("export const v = 2\n"),
                    packageTag: AstGatePackageTag.make("domain"),
                  },
                ],
                () => [],
              )
              yield* cache.evaluateBatch(
                [
                  {
                    filePath: targetPath,
                    content: AstSourceContent.make("export const v = 2\n"),
                    packageTag: AstGatePackageTag.make("infra"),
                  },
                ],
                () => [],
              )
              const sizeBeforeClear = yield* cache.cacheSize
              yield* cache.clearCache
              const existsPostClear = existsSync(cacheFilePath)
              const sizePostClear = yield* cache.cacheSize
              return [edited, sizeBeforeClear, existsPostClear, sizePostClear] as const
            },
          ).pipe(Effect.provide(makeTestAstCacheLayer(cacheFilePath, verCfg)))

          expect(editMissReport.cacheHitCount).toBe(0)
          expect(tagSize).toBe(2)
          expect(existsAfterClear).toBe(false)
          expect(sizeAfterClear).toBe(0)

          // Symlinked rule file enters Uncached without clobbering disk cache
          const symRuleRoot = WorkspaceFilePath.make(join(dir, "sym-rule-root"))
          const symCachePath = WorkspaceFilePath.make(join(dir, "sym-rule-cache.json"))
          writeFixtureRuleFiles(symRuleRoot, ["// clean-a\n", "// clean-b\n"])
          const symRuleCfg: AstGateCacheRuleSourceConfig = {
            _tag: "HashedSources",
            ruleSourceFiles: TEST_RULE_SOURCE_FILES,
            ruleSourceRoot: symRuleRoot,
          }
          const symBatch = [
            { filePath: targetPath, content: AstSourceContent.make("export const s = 1\n") },
          ]
          yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            yield* cache.evaluateBatch(symBatch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(symCachePath, symRuleCfg)))
          const symDiskBefore = readFileSync(symCachePath, "utf8")

          const targetRealFile = join(dir, "external-rule.ts")
          writeFileSync(targetRealFile, "// symlinked target\n", "utf8")
          const ruleBAbs = join(symRuleRoot, TEST_RULE_SOURCE_FILES[1])
          rmSync(ruleBAbs)
          symlinkSync(targetRealFile, ruleBAbs)

          const [symEval1, symEval2] = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            const first = yield* cache.evaluateBatch(symBatch, () => [])
            const second = yield* cache.evaluateBatch(symBatch, () => [])
            return [first, second] as const
          }).pipe(Effect.provide(makeTestAstCacheLayer(symCachePath, symRuleCfg)))
          expect(symEval1.cacheHitCount).toBe(0)
          expect(symEval2.cacheHitCount).toBe(0)
          expect(readFileSync(symCachePath, "utf8")).toBe(symDiskBefore)

          // Symlinked cacheFilePath fails with WorkspaceFsError
          const symCacheLink = WorkspaceFilePath.make(join(dir, "symlink-cache.json"))
          const symCacheTarget = join(dir, "real-cache-target.json")
          writeFileSync(symCacheTarget, "{}", "utf8")
          symlinkSync(symCacheTarget, symCacheLink)
          const symErr = yield* Effect.gen(function* () {
            const cache = yield* AstGateCachePort
            return yield* cache.evaluateBatch(symBatch, () => [])
          }).pipe(Effect.provide(makeTestAstCacheLayer(symCacheLink, verCfg)), Effect.flip)
          match(symErr)
            .with({ _tag: "WorkspaceFsError" }, (fsErr) => {
              expect(fsErr.operation).toBe("read")
              expect(fsErr.reason).toContain("Refusing symlink")
            })
            .with({ _tag: "AstGateEvaluationError" }, () => {
              expect.unreachable("Expected WorkspaceFsError")
            })
            .exhaustive()

          // HookInfraLive provides WorkspaceFs without AstGateCachePort
          yield* Effect.gen(function* () {
            const wsFs = yield* WorkspaceFs
            const astPortOpt = yield* Effect.serviceOption(AstGateCachePort)
            expect(wsFs).toBeDefined()
            expect(Option.isNone(astPortOpt)).toBe(true)
          }).pipe(Effect.provide(HookInfraLive))
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

        const layer1 = makeDecisionCacheLayer({ cacheFilePath }).pipe(
          Layer.provide(NodeServices.layer),
        )
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

        const layer2 = makeDecisionCacheLayer({ cacheFilePath }).pipe(
          Layer.provide(NodeServices.layer),
        )
        const persistedOpt = yield* Effect.gen(function* () {
          const cache = yield* DecisionCachePort
          return yield* cache.lookup(key)
        }).pipe(Effect.provide(layer2))

        expect(Option.getOrNull(persistedOpt)).toBe(payload)
      }),
    ),
  )

  it.effect(
    "REQ-3.3: UnixSocketDaemonLive binds 0600 socket, answers ping, and unlinks on scope close",
    () =>
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

  it.effect(
    "REQ-3.4: startScopedUnixSocketDaemon fails with DaemonServerError for unbindable socket path",
    () =>
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

  it.effect(
    "queryUnixSocketLine communicates with lineHandler daemon and returns None when missing",
    () =>
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

  it.effect(
    "ExtendedHostIo supports mkdtempSync, cpRecursiveSync, statMtimeMsSync, and rmRecursiveSync",
    () =>
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

  it.effect(
    "F-4.2: nodeSyncHostIo.execFileSync & spawnDetached handle normal, trimmed, missing, timedOut, and invalid inputs safely",
    () =>
      Effect.sync(() => {
        const okRes = nodeSyncHostIo.execFileSync(`  ${process.execPath}  `, [
          "-e",
          "process.stdout.write('trimmed')",
        ])
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

        const badCwd = nodeSyncHostIo.execFileSync(process.execPath, ["-e", "0"], {
          cwd: "/tmp/bad\0cwd",
        })
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

        const wsCwdDetached = nodeSyncHostIo.spawnDetached(process.execPath, ["-e", "0"], {
          cwd: "   ",
        })
        match(wsCwdDetached)
          .with({ _tag: "SpawnFailed" }, (failed) => {
            expect(failed.spawnError).toBe("Subprocess cwd must not be empty")
          })
          .with({ _tag: "Spawned" }, () => {
            expect.unreachable("Expected SpawnFailed")
          })
          .exhaustive()

        const detachedMissing = nodeSyncHostIo.spawnDetached(
          "definitely-nonexistent-binary-xyz-42",
          [],
        )
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

  it.effect(
    "F-8.5a: ActiveMutantContextLive isolates mutantId per fiber and resets on exit/failure",
    () =>
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

  it.effect(
    "F-8.5a: makeWorkspaceFsHostIoLayer and makeHarnessSubprocessRunnerHostIoLayer work with nodeSyncHostIo",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* WorkspaceFs
          const runner = yield* HarnessSubprocessRunner
          const target = WorkspaceFilePath.make(join(dir, "hostio.txt"))
          yield* fs.writeTextFileAtomic(target, WorkspaceFileContent.make("via-host-io"))
          expect(yield* fs.readTextFile(target)).toBe("via-host-io")

          const res = yield* runner.exec({
            command: SubprocessCommand.make(process.execPath),
            args: [
              SubprocessArg.make("-e"),
              SubprocessArg.make("process.stdout.write('ok-hostio')"),
            ],
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

  it.live(
    "F-8.1b & S-1.5: DecisionCacheLive lookupOrCompute deduplicates concurrent calls via Deferred single-flight",
    () =>
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
})
