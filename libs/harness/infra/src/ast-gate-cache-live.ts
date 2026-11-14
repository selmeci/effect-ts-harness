import { NodeServices } from "@effect/platform-node"
import {
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
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  type AstGatePackageTag,
  AstGateViolationContract,
  type ContentSha256,
  ErrorReasonMessage,
  HARNESS_GATE_RULE_VERSION,
  makeAstGateEvaluationReport,
  NonNegativeCount,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import {
  type AstSourceFileCache,
  computeContentSha256,
  getOrCreateCachedSourceFile,
  inferPackageTagFromPath,
  visitSourceFileSinglePass,
} from "@harness/gates"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"

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
  readonly pkgTag: AstGatePackageTag
  readonly contentSha256: ContentSha256
  readonly localSourceFileCache: AstSourceFileCache
}

const toReadError = (filePath: WorkspaceFilePath, err: unknown): WorkspaceFsError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : "Failed to read AST gate cache"
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("read"),
    reason: ErrorReasonMessage.make(message),
  })
}

const toWriteError = (filePath: WorkspaceFilePath, err: unknown): WorkspaceFsError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : "Failed to persist AST gate cache"
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("write"),
    reason: ErrorReasonMessage.make(message),
  })
}

/**
 * Constructs an `AstGateCachePort` layer requiring `FileSystem` and `Path`.
 *
 * Architectural rationale ("why"): `ScopedCache` (capacity 2048) provides bounded
 * in-memory single-flight deduplication keyed by `(filePath, packageTag, contentSha256,
 * ruleVersion)`, while `SynchronizedRef` serializes immutable cache snapshots with
 * atomic write-before-commit disk persistence so failed writes never diverge memory from disk.
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

      const scopedCache = yield* ScopedCache.make<string, PersistedAstCacheEntry, WorkspaceFsError>({
        capacity: AST_GATE_SCOPED_CACHE_CAPACITY,
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
            const { sourceFile } = getOrCreateCachedSourceFile(
              pending.file.filePath,
              pending.file.content,
              pending.contentSha256,
              pending.localSourceFileCache,
            )
            const fileViolations = visitSourceFileSinglePass(
              sourceFile,
              pending.file.filePath,
              pending.pkgTag,
            )
            const contractViolations: ReadonlyArray<AstGateViolationContract> = fileViolations.map(
              (v) => ({
                category: v.category,
                rule: v.rule,
                message: v.message,
                file: v.file,
                line: v.line,
                enclosingSymbol: v.enclosingSymbol,
              }),
            )
            return {
              contentSha256: pending.contentSha256,
              ruleVersion: HARNESS_GATE_RULE_VERSION,
              violations: contractViolations,
            }
          }),
      })

      const evaluateBatch = Effect.fn("AstGateCachePort.evaluateBatch")(function* (
        files: ReadonlyArray<AstGateFileBatchInput>,
      ): Effect.fn.Return<AstGateEvaluationReport, WorkspaceFsError> {
        const localSourceFileCache: AstSourceFileCache = new Map()
        return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* () {
            const loaded = yield* ensureLoaded(state)
            const nextEntries = new Map(loaded.entries)

            let cacheHitCount = 0
            let dirty = false
            const violations: Array<AstGateViolationContract> = []

            for (const file of files) {
              const pkgTag = file.packageTag ?? inferPackageTagFromPath(file.filePath)
              const cacheKey = `${file.filePath}\0${pkgTag}`
              const contentSha256 = computeContentSha256(file.content)
              const existing = nextEntries.get(cacheKey)

              if (
                existing !== undefined &&
                existing.contentSha256 === contentSha256 &&
                existing.ruleVersion === HARNESS_GATE_RULE_VERSION
              ) {
                cacheHitCount += 1
                violations.push(...existing.violations)
                continue
              }

              const scopedKey = `${cacheKey}\0${contentSha256}\0${HARNESS_GATE_RULE_VERSION}`
              yield* Ref.update(pendingEvalRef, (pending) => {
                const next = new Map(pending)
                next.set(scopedKey, {
                  file,
                  pkgTag,
                  contentSha256,
                  localSourceFileCache,
                })
                return next
              })

              const computed = yield* ScopedCache.get(scopedCache, scopedKey).pipe(
                Effect.mapError((err) => toWriteError(file.filePath, err)),
                Effect.ensuring(
                  Ref.update(pendingEvalRef, (pending) => {
                    const next = new Map(pending)
                    next.delete(scopedKey)
                    return next
                  }),
                ),
              )

              nextEntries.set(cacheKey, computed)
              dirty = true
              violations.push(...computed.violations)
            }

            if (dirty) {
              yield* persistEntries(nextEntries)
            }

            const report = makeAstGateEvaluationReport({
              violations,
              inspectedFileCount: NonNegativeCount.make(files.length),
              cacheHitCount: NonNegativeCount.make(cacheHitCount),
            })

            return [
              report,
              {
                loaded: true,
                entries: nextEntries,
              },
            ] as const
          }),
        )
      })

      const clearCache: Effect.Effect<void> = SynchronizedRef.updateEffect(stateRef, () =>
        Effect.gen(function* () {
          yield* ScopedCache.invalidateAll(scopedCache)
          if (options?.cacheFilePath !== undefined) {
            yield* fs.remove(options.cacheFilePath, { force: true }).pipe(Effect.ignore)
          }
          return {
            loaded: true,
            entries: new Map<string, PersistedAstCacheEntry>(),
          }
        }),
      )

      const cacheSize: Effect.Effect<NonNegativeCount> = SynchronizedRef.modifyEffect(
        stateRef,
        (state) =>
          ensureLoaded(state).pipe(
            Effect.orElseSucceed(() => state),
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
