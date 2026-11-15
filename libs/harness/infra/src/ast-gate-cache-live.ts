import { NodeServices } from "@effect/platform-node"
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  ScopedCache,
  SynchronizedRef,
} from "effect"
import { match, P } from "ts-pattern"
import {
  AstGateEvaluationError,
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  type AstGateFileEvaluator,
  AstGateViolationContract,
  computeContentSha256,
  type ContentSha256,
  ErrorReasonMessage,
  type EvaluatorId,
  HARNESS_GATE_RULE_VERSION,
  inferAstGatePackageTagFromPath,
  makeAstGateEvaluationReport,
  NonNegativeCount,
  toErrorReasonMessage,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"
import { toReadError, toWriteError } from "./cache-helpers.js"

const AST_GATE_SCOPED_CACHE_CAPACITY = 2048

const PersistedAstCacheEntrySchema = Schema.Struct({
  contentSha256: Schema.String,
  ruleVersion: Schema.String,
  violations: Schema.Array(AstGateViolationContract),
})
type PersistedAstCacheEntry = typeof PersistedAstCacheEntrySchema.Type

const PersistedAstCacheStoreSchema = Schema.Struct({
  version: Schema.String,
  entries: Schema.Record(Schema.String, PersistedAstCacheEntrySchema),
})

const decodePersistedStore = Schema.decodeOption(
  Schema.fromJsonString(PersistedAstCacheStoreSchema),
)

interface AstGateCacheState {
  readonly loaded: boolean
  readonly entries: ReadonlyMap<string, PersistedAstCacheEntry>
}

interface PendingAstEvaluation {
  readonly file: AstGateFileBatchInput
  readonly contentSha256: ContentSha256
  readonly evaluateFile: AstGateFileEvaluator
  readonly waiters: number
}

/**
 * Constructs an `AstGateCachePort` layer requiring `FileSystem` and `Path`.
 *
 * When `options.cacheFilePath` is omitted, the cache operates in-memory only;
 * `HarnessInfraLive` / `makeHarnessInfraLayer` wires it to
 * `.harness/cache/ast-gates-v1.json` under the repository root.
 *
 * Architectural rationale ("why"): `ScopedCache` (capacity 2048) runs outside
 * `SynchronizedRef` so concurrent `evaluateBatch` callers and batch misses share
 * single-flight evaluation keyed by `(filePath, packageTag, contentSha256, ruleVersion)`,
 * while `SynchronizedRef` serializes atomic write-before-commit disk persistence.
 */
const makeAstGateCacheLayer = (options?: {
  readonly cacheFilePath?: WorkspaceFilePath
}): Layer.Layer<AstGateCachePort, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    AstGateCachePort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateRef = yield* SynchronizedRef.make<AstGateCacheState>({
        loaded: options?.cacheFilePath === undefined,
        entries: new Map<string, PersistedAstCacheEntry>(),
      })
      const pendingEvalRef = yield* Ref.make<ReadonlyMap<string, PendingAstEvaluation>>(new Map())

      const ensureLoaded = (
        state: AstGateCacheState,
      ): Effect.Effect<AstGateCacheState, WorkspaceFsError> =>
        Effect.gen(function* () {
          if (state.loaded) {
            return state
          }
          if (options?.cacheFilePath === undefined) {
            return { ...state, loaded: true }
          }
          const filePath = options.cacheFilePath
          const rawOpt = yield* fs.readFileString(filePath).pipe(
            Effect.asSome,
            Effect.catchTag("PlatformError", (err) =>
              match(err.reason)
                .with({ _tag: "NotFound" }, () => Effect.succeed(Option.none<string>()))
                .with({ _tag: P.not("NotFound") }, () => Effect.fail(toReadError(filePath, err)))
                .exhaustive(),
            ),
          )
          return yield* match(rawOpt)
            .with({ _tag: "None" }, () => Effect.succeed({ ...state, loaded: true }))
            .with({ _tag: "Some" }, ({ value: raw }) =>
              match(decodePersistedStore(raw))
                .with({ _tag: "None" }, () =>
                  Effect.logWarning(
                    `Corrupt AST gate cache at '${filePath}'; resetting to empty store`,
                  ).pipe(
                    Effect.as({
                      loaded: true,
                      entries: new Map<string, PersistedAstCacheEntry>(),
                    }),
                  ),
                )
                .with({ _tag: "Some" }, ({ value: store }) => {
                  const nextEntries = new Map<string, PersistedAstCacheEntry>()
                  for (const [key, entry] of Object.entries(store.entries)) {
                    nextEntries.set(key, entry)
                  }
                  return Effect.succeed({
                    loaded: true,
                    entries: nextEntries,
                  })
                })
                .exhaustive(),
            )
            .exhaustive()
        })

      const persistEntries = (
        entries: ReadonlyMap<string, PersistedAstCacheEntry>,
      ): Effect.Effect<void, WorkspaceFsError> =>
        Effect.gen(function* () {
          if (options?.cacheFilePath === undefined) {
            return
          }
          const filePath = options.cacheFilePath
          const serializedEntries: Record<string, PersistedAstCacheEntry> = {}
          for (const [key, entry] of entries.entries()) {
            serializedEntries[key] = entry
          }
          const json = JSON.stringify({
            version: HARNESS_GATE_RULE_VERSION,
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
              return yield* new WorkspaceFsError({
                filePath: options?.cacheFilePath ?? WorkspaceFilePath.make(lookupKey),
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
              ruleVersion: HARNESS_GATE_RULE_VERSION,
              violations: contractViolations,
            }
          }),
      })

      const evaluateBatch = Effect.fn("AstGateCachePort.evaluateBatch")(function* (
        files: ReadonlyArray<AstGateFileBatchInput>,
        evaluateFile: AstGateFileEvaluator,
        evaluatorId?: EvaluatorId,
      ): Effect.fn.Return<AstGateEvaluationReport, WorkspaceFsError | AstGateEvaluationError> {
        const snapshot = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          ensureLoaded(state).pipe(Effect.map((loaded) => [loaded, loaded] as const)),
        )

        interface PreparedMiss {
          readonly cacheKey: string
          readonly scopedKey: string
          readonly file: AstGateFileBatchInput
          readonly contentSha256: ContentSha256
        }

        const resolvedEvaluatorId =
          evaluatorId !== undefined && evaluatorId.trim().length > 0
            ? evaluatorId.trim()
            : "default"
        const hitMap = new Map<string, PersistedAstCacheEntry>()
        const misses: Array<PreparedMiss> = []
        const orderedKeys: Array<string> = []
        const seenBatchEntries = new Set<string>()
        let cacheHitCount = 0

        for (const file of files) {
          const pkgTag = file.packageTag ?? inferAstGatePackageTagFromPath(file.filePath)
          const dedupeKey = `${file.filePath}\0${pkgTag}`
          if (seenBatchEntries.has(dedupeKey)) {
            continue
          }
          seenBatchEntries.add(dedupeKey)

          const cacheKey = `${dedupeKey}\0${HARNESS_GATE_RULE_VERSION}\0${resolvedEvaluatorId}`
          orderedKeys.push(cacheKey)
          const contentSha256 = computeContentSha256(file.content)
          const existing = snapshot.entries.get(cacheKey)

          if (
            existing !== undefined &&
            existing.contentSha256 === contentSha256 &&
            existing.ruleVersion === HARNESS_GATE_RULE_VERSION
          ) {
            cacheHitCount += 1
            hitMap.set(cacheKey, existing)
          } else {
            const scopedKey = `${cacheKey}\0${contentSha256}`
            misses.push({ cacheKey, scopedKey, file, contentSha256 })
          }
        }

        const computedMap = new Map<string, PersistedAstCacheEntry>()
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
                    evaluateFile,
                    waiters: (prev?.waiters ?? 0) + 1,
                  })
                  return next
                }),
                () =>
                  ScopedCache.get(scopedCache, miss.scopedKey).pipe(
                    Effect.mapError((err) => {
                      if (err instanceof WorkspaceFsError || err instanceof AstGateEvaluationError) {
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
              const nextEntries = new Map(loaded.entries)
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
                yield* persistEntries(nextEntries).pipe(
                  Effect.catchTag("WorkspaceFsError", (err) =>
                    Effect.logWarning(
                      `Failed to persist AST gate cache at '${err.filePath}': ${err.reason}`,
                    ),
                  ),
                )
              }
              return [undefined, { loaded: true, entries: nextEntries }] as const
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
      })

      const clearCache: Effect.Effect<void, WorkspaceFsError> = SynchronizedRef.updateEffect(
        stateRef,
        () =>
          Effect.gen(function* () {
            yield* ScopedCache.invalidateAll(scopedCache)
            if (options?.cacheFilePath !== undefined) {
              const filePath = options.cacheFilePath
              yield* fs
                .remove(filePath, { force: true })
                .pipe(Effect.mapError((err) => toWriteError(filePath, err)))
            }
            return {
              loaded: true,
              entries: new Map<string, PersistedAstCacheEntry>(),
            }
          }),
      )

      const cacheSize: Effect.Effect<NonNegativeCount, WorkspaceFsError> =
        SynchronizedRef.modifyEffect(stateRef, (state) =>
          ensureLoaded(state).pipe(
            Effect.map((loaded) => [NonNegativeCount.make(loaded.entries.size), loaded] as const),
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
