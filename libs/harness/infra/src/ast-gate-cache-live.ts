import { NodeServices } from "@effect/platform-node"
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  ScopedCache,
  SynchronizedRef,
} from "effect"
import { match, P } from "ts-pattern"
import {
  AstGateEvaluationError,
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  type AstGateFileEvaluator,
  AstGatePackageTag,
  AstGateViolationContract,
  computeContentSha256,
  type ContentSha256,
  DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
  ErrorReasonMessage,
  EvaluatorId,
  GateRuleVersion,
  inferAstGatePackageTagFromPath,
  makeAstGateEvaluationReport,
  makePersistedAstCacheKey,
  NonNegativeCount,
  PersistedAstCacheEntry,
  PersistedAstCacheKey,
  toErrorReasonMessage,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"
import {
  type AstGateCacheRuleSourceConfig,
  checkNonSymlinkCachePath,
  decodeStoreForActiveVersion,
  encodePersistedStoreJson,
  readActiveEntriesForMerge,
  type ResolvedGateRuleVersion,
  resolveDiskGateRuleVersion,
  resolveDiskGateRuleVersionWithPlatform,
} from "./ast-gate-cache-helpers.js"
import { toReadError, toWriteError } from "./cache-helpers.js"

export {
  resolveDiskGateRuleVersion,
  type AstGateCacheRuleSourceConfig,
  type ResolvedGateRuleVersion,
}

const AST_GATE_SCOPED_CACHE_CAPACITY = 2048
const DEFAULT_EVALUATOR_ID = EvaluatorId.make("default")

interface AstGateCacheStateUnloaded {
  readonly _tag: "Unloaded"
}

interface AstGateCacheStateUncached {
  readonly _tag: "Uncached"
  readonly resolution: Extract<ResolvedGateRuleVersion, { readonly _tag: "Uncached" }>
}

interface AstGateCacheStateLoaded {
  readonly _tag: "Loaded"
  readonly ruleVersion: GateRuleVersion
  readonly entries: ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>
}

type AstGateCacheState =
  | AstGateCacheStateUnloaded
  | AstGateCacheStateUncached
  | AstGateCacheStateLoaded

interface PendingAstEvaluation {
  readonly file: AstGateFileBatchInput
  readonly contentSha256: ContentSha256
  readonly ruleVersion: GateRuleVersion
  readonly evaluateFile: AstGateFileEvaluator
  readonly waiters: number
}

/**
 * Constructs an `AstGateCachePort` layer requiring `FileSystem` and `Path`.
 *
 * Resolves `options.ruleSource` lazily on first port access (`Layer.effect` performs zero I/O).
 * When `ruleSource` resolves to `{ _tag: "Uncached" }`, evaluations bypass both memory and disk
 * persistence without clobbering any valid `.harness/cache/ast-gate-cache-v1.json` on disk.
 */
const makeAstGateCacheLayer = (options?: {
  readonly cacheFilePath?: WorkspaceFilePath
  readonly ruleSource?: AstGateCacheRuleSourceConfig
}): Layer.Layer<AstGateCachePort, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    AstGateCachePort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateRef = yield* SynchronizedRef.make<AstGateCacheState>({ _tag: "Unloaded" })
      const pendingEvalRef = yield* Ref.make<ReadonlyMap<string, PendingAstEvaluation>>(new Map())

      const ensureLoaded = (
        state: AstGateCacheState,
      ): Effect.Effect<AstGateCacheState, WorkspaceFsError> =>
        match(state)
          .with({ _tag: "Loaded" }, { _tag: "Uncached" }, (ready) => Effect.succeed(ready))
          .with({ _tag: "Unloaded" }, () =>
            Effect.gen(function* () {
              const ruleSourceConfig: AstGateCacheRuleSourceConfig = options?.ruleSource ?? {
                _tag: "ExplicitVersion",
                ruleVersion: DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
              }
              const resolution = yield* resolveDiskGateRuleVersionWithPlatform(
                fs,
                path,
                ruleSourceConfig,
              )
              return yield* match(resolution)
                .with({ _tag: "Uncached" }, (uncached) =>
                  Effect.succeed<AstGateCacheState>({ _tag: "Uncached", resolution: uncached }),
                )
                .with({ _tag: "Resolved" }, ({ ruleVersion: activeRuleVersion }) =>
                  Effect.gen(function* () {
                    if (options?.cacheFilePath === undefined) {
                      return {
                        _tag: "Loaded" as const,
                        ruleVersion: activeRuleVersion,
                        entries: new Map<PersistedAstCacheKey, PersistedAstCacheEntry>(),
                      }
                    }
                    const filePath = options.cacheFilePath
                    const existsNonSymlink = yield* checkNonSymlinkCachePath(
                      fs,
                      filePath,
                      toReadError,
                    )
                    if (!existsNonSymlink) {
                      return {
                        _tag: "Loaded" as const,
                        ruleVersion: activeRuleVersion,
                        entries: new Map<PersistedAstCacheKey, PersistedAstCacheEntry>(),
                      }
                    }
                    const rawOpt = yield* fs.readFileString(filePath).pipe(
                      Effect.asSome,
                      Effect.catchTag("PlatformError", (err) =>
                        match(err.reason)
                          .with({ _tag: "NotFound" }, () => Effect.succeedNone)
                          .with({ _tag: P.not("NotFound") }, () =>
                            Effect.fail(toReadError(filePath, err)),
                          )
                          .exhaustive(),
                      ),
                    )
                    const loadedEntries = yield* match(rawOpt)
                      .with({ _tag: "None" }, () =>
                        Effect.succeed<ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>>(
                          new Map(),
                        ),
                      )
                      .with({ _tag: "Some" }, ({ value: raw }) =>
                        decodeStoreForActiveVersion(raw, activeRuleVersion, filePath),
                      )
                      .exhaustive()
                    return {
                      _tag: "Loaded" as const,
                      ruleVersion: activeRuleVersion,
                      entries: loadedEntries,
                    }
                  }),
                )
                .exhaustive()
            }),
          )
          .exhaustive()

      const persistEntries = (
        activeRuleVersion: GateRuleVersion,
        entries: ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>,
      ): Effect.Effect<void, WorkspaceFsError> =>
        Effect.gen(function* () {
          if (options?.cacheFilePath === undefined) {
            return
          }
          const filePath = options.cacheFilePath
          const existsNonSymlink = yield* checkNonSymlinkCachePath(fs, filePath, toWriteError)
          const merged = new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
          if (existsNonSymlink) {
            const diskActive = yield* readActiveEntriesForMerge(fs, filePath, activeRuleVersion)
            for (const [k, v] of diskActive.entries()) {
              merged.set(k, v)
            }
          }
          for (const [k, v] of entries.entries()) {
            merged.set(k, v)
          }
          const serializedEntries: Record<string, PersistedAstCacheEntry> = Object.create(null)
          for (const [key, entry] of merged.entries()) {
            serializedEntries[key] = entry
          }
          const json = encodePersistedStoreJson({
            version: activeRuleVersion,
            entries: serializedEntries,
          })
          const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(tmpPath, json)),
            Effect.andThen(fs.rename(tmpPath, filePath)),
            Effect.mapError((err) => toWriteError(filePath, err)),
            Effect.ensuring(fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
          )
        })

      const scopedCache = yield* ScopedCache.makeWith<
        string,
        PersistedAstCacheEntry,
        WorkspaceFsError | AstGateEvaluationError
      >({
        capacity: AST_GATE_SCOPED_CACHE_CAPACITY,
        timeToLive: (exit) =>
          match(exit)
            .with({ _tag: "Success" }, () => Duration.infinity)
            .with({ _tag: "Failure" }, () => Duration.zero)
            .exhaustive(),
        lookup: (lookupKey) =>
          Effect.gen(function* () {
            const pendingMap = yield* Ref.get(pendingEvalRef)
            const pending = pendingMap.get(lookupKey)
            if (pending === undefined) {
              const safePathSegment = lookupKey.split("\0")[0]
              const fallbackPath = WorkspaceFilePath.make(
                safePathSegment !== undefined && safePathSegment.trim().length > 0
                  ? safePathSegment.trim()
                  : "in-memory",
              )
              return yield* new WorkspaceFsError({
                filePath: options?.cacheFilePath ?? fallbackPath,
                operation: WorkspaceFsOperation.make("read"),
                reason: ErrorReasonMessage.make(
                  `Missing pending AST evaluation for '${lookupKey}'`,
                ),
              })
            }
            const contractViolations = yield* Effect.try({
              try: () => pending.evaluateFile(pending.file),
              catch: (err) =>
                new AstGateEvaluationError({
                  filePath: pending.file.filePath,
                  reason: toErrorReasonMessage(err, "AST gate evaluator failed"),
                }),
            })
            return {
              contentSha256: pending.contentSha256,
              ruleVersion: pending.ruleVersion,
              violations: contractViolations,
            }
          }),
      })

      const dedupeBatchFiles = (
        files: ReadonlyArray<AstGateFileBatchInput>,
      ): ReadonlyArray<{
        readonly file: AstGateFileBatchInput
        readonly pkgTag: AstGatePackageTag
      }> => {
        const result: Array<{
          readonly file: AstGateFileBatchInput
          readonly pkgTag: AstGatePackageTag
        }> = []
        const seen = new Set<string>()
        for (const file of files) {
          const pkgTag = file.packageTag ?? inferAstGatePackageTagFromPath(file.filePath)
          const dedupeKey = `${file.filePath}\0${pkgTag}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          result.push({ file, pkgTag })
        }
        return result
      }

      const evaluateBatch = Effect.fn("AstGateCachePort.evaluateBatch")(function* (
        files: ReadonlyArray<AstGateFileBatchInput>,
        evaluateFile: AstGateFileEvaluator,
        evaluatorId?: EvaluatorId,
      ): Effect.fn.Return<AstGateEvaluationReport, WorkspaceFsError | AstGateEvaluationError> {
        const snapshot = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          ensureLoaded(state).pipe(Effect.map((loaded) => [loaded, loaded] as const)),
        )
        const dedupedFiles = dedupeBatchFiles(files)

        return yield* match(snapshot)
          .with({ _tag: "Uncached" }, () =>
            Effect.forEach(
              dedupedFiles,
              ({ file }) =>
                Effect.try({
                  try: () => evaluateFile(file),
                  catch: (err) =>
                    new AstGateEvaluationError({
                      filePath: file.filePath,
                      reason: toErrorReasonMessage(err, "AST gate evaluator failed"),
                    }),
                }),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map((batches) =>
                makeAstGateEvaluationReport({
                  violations: batches.flat(),
                  inspectedFileCount: NonNegativeCount.make(dedupedFiles.length),
                  cacheHitCount: NonNegativeCount.make(0),
                }),
              ),
            ),
          )
          .with(
            { _tag: "Loaded" },
            ({ ruleVersion: activeRuleVersion, entries: snapshotEntries }) =>
              Effect.gen(function* () {
                interface PreparedMiss {
                  readonly cacheKey: PersistedAstCacheKey
                  readonly scopedKey: string
                  readonly file: AstGateFileBatchInput
                  readonly contentSha256: ContentSha256
                }

                const resolvedEvaluatorId =
                  evaluatorId !== undefined && evaluatorId.trim().length > 0
                    ? EvaluatorId.make(evaluatorId.trim())
                    : DEFAULT_EVALUATOR_ID
                const hitMap = new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
                const misses: Array<PreparedMiss> = []
                const orderedKeys: Array<PersistedAstCacheKey> = []
                let cacheHitCount = 0

                for (const { file, pkgTag } of dedupedFiles) {
                  const cacheKey = makePersistedAstCacheKey(
                    file.filePath,
                    pkgTag,
                    activeRuleVersion,
                    resolvedEvaluatorId,
                  )
                  orderedKeys.push(cacheKey)
                  const contentSha256 = computeContentSha256(file.content)
                  const existing = snapshotEntries.get(cacheKey)

                  if (
                    existing !== undefined &&
                    existing.contentSha256 === contentSha256 &&
                    existing.ruleVersion === activeRuleVersion
                  ) {
                    cacheHitCount += 1
                    hitMap.set(cacheKey, existing)
                  } else {
                    const scopedKey = `${cacheKey}\0${contentSha256}`
                    misses.push({ cacheKey, scopedKey, file, contentSha256 })
                  }
                }

                const computedMap = new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
                if (misses.length > 0) {
                  const computedPairs = yield* Effect.forEach(
                    misses,
                    (miss) =>
                      Effect.acquireUseRelease(
                        Ref.update(pendingEvalRef, (pending) => {
                          const next = new Map(pending)
                          const prev = next.get(miss.scopedKey)
                          next.set(miss.scopedKey, {
                            file: miss.file,
                            contentSha256: miss.contentSha256,
                            ruleVersion: activeRuleVersion,
                            evaluateFile,
                            waiters: (prev?.waiters ?? 0) + 1,
                          })
                          return next
                        }),
                        () =>
                          ScopedCache.get(scopedCache, miss.scopedKey).pipe(
                            Effect.mapError((err) => {
                              if (
                                err instanceof WorkspaceFsError ||
                                err instanceof AstGateEvaluationError
                              ) {
                                return err
                              }
                              return toWriteError(miss.file.filePath, err)
                            }),
                            Effect.map((entry) => [miss.cacheKey, entry] as const),
                          ),
                        () =>
                          Ref.update(pendingEvalRef, (pending) => {
                            const next = new Map(pending)
                            const prev = next.get(miss.scopedKey)
                            if (prev === undefined || prev.waiters <= 1) {
                              next.delete(miss.scopedKey)
                            } else {
                              next.set(miss.scopedKey, { ...prev, waiters: prev.waiters - 1 })
                            }
                            return next
                          }),
                      ),
                    { concurrency: "unbounded" },
                  )

                  for (const [cacheKey, entry] of computedPairs) {
                    computedMap.set(cacheKey, entry)
                  }

                  yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
                    Effect.gen(function* () {
                      const loaded = yield* ensureLoaded(state)
                      return yield* match(loaded)
                        .with({ _tag: "Uncached" }, { _tag: "Unloaded" }, (other) =>
                          Effect.succeed([undefined, other] as const),
                        )
                        .with(
                          { _tag: "Loaded" },
                          ({ ruleVersion: currentVer, entries: currentEntries }) =>
                            Effect.gen(function* () {
                              const nextEntries = new Map(currentEntries)
                              let dirty = false
                              for (const [cacheKey, entry] of computedMap.entries()) {
                                const prev = nextEntries.get(cacheKey)
                                if (
                                  prev === undefined ||
                                  prev.contentSha256 !== entry.contentSha256 ||
                                  prev.ruleVersion !== entry.ruleVersion
                                ) {
                                  nextEntries.set(cacheKey, entry)
                                  dirty = true
                                }
                              }
                              if (dirty) {
                                yield* persistEntries(currentVer, nextEntries).pipe(
                                  Effect.catchTag("WorkspaceFsError", (err) =>
                                    Effect.logWarning(
                                      `Failed to persist AST gate cache at '${err.filePath}': ${err.reason}`,
                                    ),
                                  ),
                                )
                              }
                              return [
                                undefined,
                                {
                                  _tag: "Loaded" as const,
                                  ruleVersion: currentVer,
                                  entries: nextEntries,
                                },
                              ] as const
                            }),
                        )
                        .exhaustive()
                    }),
                  )
                }

                const violations: Array<AstGateViolationContract> = []
                for (const cacheKey of orderedKeys) {
                  const entry = hitMap.get(cacheKey) ?? computedMap.get(cacheKey)
                  if (entry !== undefined) {
                    violations.push(...entry.violations)
                  }
                }

                return makeAstGateEvaluationReport({
                  violations,
                  inspectedFileCount: NonNegativeCount.make(orderedKeys.length),
                  cacheHitCount: NonNegativeCount.make(cacheHitCount),
                })
              }),
          )
          .with({ _tag: "Unloaded" }, () =>
            Effect.die(
              "Invariant violation: AstGateCacheState remained Unloaded after ensureLoaded",
            ),
          )
          .exhaustive()
      })

      const clearCache: Effect.Effect<void, WorkspaceFsError> = SynchronizedRef.updateEffect(
        stateRef,
        (state) =>
          Effect.gen(function* () {
            yield* ScopedCache.invalidateAll(scopedCache)
            if (options?.cacheFilePath !== undefined) {
              const filePath = options.cacheFilePath
              yield* fs
                .remove(filePath, { force: true })
                .pipe(Effect.mapError((err) => toWriteError(filePath, err)))
            }
            return match(state)
              .with({ _tag: "Uncached" }, (uncached) => uncached)
              .with({ _tag: "Unloaded" }, () => ({ _tag: "Unloaded" as const }))
              .with({ _tag: "Loaded" }, ({ ruleVersion }) => ({
                _tag: "Loaded" as const,
                ruleVersion,
                entries: new Map<PersistedAstCacheKey, PersistedAstCacheEntry>(),
              }))
              .exhaustive()
          }),
      )

      const cacheSize: Effect.Effect<NonNegativeCount, WorkspaceFsError> =
        SynchronizedRef.modifyEffect(stateRef, (state) =>
          ensureLoaded(state).pipe(
            Effect.map((loaded) => {
              const size = match(loaded)
                .with({ _tag: "Loaded" }, ({ entries }) => entries.size)
                .with({ _tag: "Uncached" }, { _tag: "Unloaded" }, () => 0)
                .exhaustive()
              return [NonNegativeCount.make(size), loaded] as const
            }),
          ),
        )

      const impl: AstGateCachePortShape = {
        evaluateBatch,
        clearCache,
        cacheSize,
      }

      return impl
    }),
  )

export { makeAstGateCacheLayer }

export const AstGateCacheLive: Layer.Layer<AstGateCachePort> = makeAstGateCacheLayer().pipe(
  Layer.provide(NodeServices.layer),
)
