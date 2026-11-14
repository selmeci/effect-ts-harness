import { NodeServices } from "@effect/platform-node"
import {
  type Cause,
  Effect,
  type Exit,
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
  type DecisionCacheKey,
  DecisionCachePayloadJson,
  type DecisionCacheStatsSnapshot,
  type DecisionCacheTtlMillis,
  ErrorReasonMessage,
  NonNegativeCount,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { DecisionCachePort, type DecisionCachePortShape } from "@harness/service"

export type { DecisionCacheStatsSnapshot }

const DECISION_SCOPED_CACHE_CAPACITY = 512

const PersistedDecisionEntrySchema = Schema.Struct({
  payload: DecisionCachePayloadJson,
  expiresAtMs: Schema.Finite,
})
type PersistedDecisionEntry = typeof PersistedDecisionEntrySchema.Type

const PersistedDecisionStoreSchema = Schema.Struct({
  entries: Schema.Record(Schema.String, PersistedDecisionEntrySchema),
})

const decodePersistedStore = Schema.decodeOption(
  Schema.fromJsonString(PersistedDecisionStoreSchema),
)

interface DecisionCacheState {
  readonly loaded: boolean
  readonly entries: ReadonlyMap<string, PersistedDecisionEntry>
  readonly hits: number
  readonly misses: number
  readonly coalescedRequests: number
}

interface PendingComputation {
  readonly ttlMillis: DecisionCacheTtlMillis
  readonly run: Effect.Effect<Exit.Exit<DecisionCachePayloadJson, never>>
}

const toReadError = (filePath: WorkspaceFilePath, err: unknown): WorkspaceFsError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : "Failed to read decision cache"
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
      : "Failed to persist decision cache"
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("write"),
    reason: ErrorReasonMessage.make(message),
  })
}

/**
 * Constructs a `DecisionCachePort` layer requiring `FileSystem` and `Path`.
 *
 * Architectural rationale ("why"): `ScopedCache` (capacity 512) provides bounded
 * in-memory single-flight deduplication so concurrent callers for the same
 * `DecisionCacheKey` share one computation, while `SynchronizedRef` serializes
 * immutable state snapshots with atomic write-before-commit disk persistence to
 * `.harness/` so failed disk writes never diverge in-memory state from disk.
 */
const makeDecisionCacheLayer = (options?: {
  readonly cacheFilePath?: WorkspaceFilePath
}): Layer.Layer<DecisionCachePort, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    DecisionCachePort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateRef = yield* SynchronizedRef.make<DecisionCacheState>({
        loaded: options?.cacheFilePath === undefined,
        entries: new Map<string, PersistedDecisionEntry>(),
        hits: 0,
        misses: 0,
        coalescedRequests: 0,
      })
      const pendingComputesRef = yield* Ref.make<ReadonlyMap<string, PendingComputation>>(new Map())
      const inFlightWaitersRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

      const ensureLoaded = (
        state: DecisionCacheState,
      ): Effect.Effect<DecisionCacheState, WorkspaceFsError> =>
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
                    `Corrupt decision cache at '${filePath}'; resetting to empty store`,
                  ).pipe(
                    Effect.as({
                      ...state,
                      loaded: true,
                      entries: new Map<string, PersistedDecisionEntry>(),
                    }),
                  ),
                )
                .with({ _tag: "Some" }, ({ value: store }) => {
                  const now = Date.now()
                  const nextEntries = new Map<string, PersistedDecisionEntry>()
                  for (const [key, entry] of Object.entries(store.entries)) {
                    if (now <= entry.expiresAtMs) {
                      nextEntries.set(key, entry)
                    }
                  }
                  return Effect.succeed({
                    ...state,
                    loaded: true,
                    entries: nextEntries,
                  })
                })
                .exhaustive(),
            )
            .exhaustive()
        })

      const persistEntries = (
        entries: ReadonlyMap<string, PersistedDecisionEntry>,
      ): Effect.Effect<void, WorkspaceFsError> =>
        Effect.gen(function* () {
          if (options?.cacheFilePath === undefined) {
            return
          }
          const filePath = options.cacheFilePath
          const serializedEntries: Record<string, PersistedDecisionEntry> = {}
          const now = Date.now()
          for (const [key, entry] of entries.entries()) {
            if (now <= entry.expiresAtMs) {
              serializedEntries[key] = entry
            }
          }
          const json = JSON.stringify({ entries: serializedEntries })
          const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(tmpPath, json)),
            Effect.andThen(fs.rename(tmpPath, filePath)),
            Effect.mapError((err) => toWriteError(filePath, err)),
            Effect.ensuring(fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
          )
        })

      const commitEntry = (
        key: DecisionCacheKey,
        payload: DecisionCachePayloadJson,
        ttlMillis: DecisionCacheTtlMillis,
      ): Effect.Effect<void, WorkspaceFsError> =>
        SynchronizedRef.updateEffect(stateRef, (state) =>
          Effect.gen(function* () {
            const loaded = yield* ensureLoaded(state)
            const nextEntries = new Map(loaded.entries)
            nextEntries.set(key, {
              payload,
              expiresAtMs: Date.now() + ttlMillis,
            })
            yield* persistEntries(nextEntries)
            return {
              ...loaded,
              entries: nextEntries,
            }
          }),
        )

      const scopedCache = yield* ScopedCache.make<
        DecisionCacheKey,
        Exit.Exit<DecisionCachePayloadJson, never>,
        WorkspaceFsError
      >({
        capacity: DECISION_SCOPED_CACHE_CAPACITY,
        lookup: (key) =>
          Effect.gen(function* () {
            const pendingMap = yield* Ref.get(pendingComputesRef)
            const pending = pendingMap.get(key)
            if (pending === undefined) {
              return yield* new WorkspaceFsError({
                filePath: options?.cacheFilePath ?? WorkspaceFilePath.make(key),
                operation: WorkspaceFsOperation.make("read"),
                reason: ErrorReasonMessage.make(
                  `Missing pending computation for decision cache key '${key}'`,
                ),
              })
            }
            const exit = yield* pending.run
            yield* match(exit)
              .with({ _tag: "Success" }, ({ value }) =>
                commitEntry(key, value, pending.ttlMillis),
              )
              .with({ _tag: "Failure" }, () => Effect.void)
              .exhaustive()
            return exit
          }),
      })

      const lookup = Effect.fn("DecisionCachePort.lookup")(function* (
        key: DecisionCacheKey,
      ): Effect.fn.Return<Option.Option<DecisionCachePayloadJson>, WorkspaceFsError> {
        return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* () {
            const loaded = yield* ensureLoaded(state)
            const existing = loaded.entries.get(key)
            if (existing === undefined) {
              return [
                Option.none<DecisionCachePayloadJson>(),
                { ...loaded, misses: loaded.misses + 1 },
              ] as const
            }
            if (Date.now() > existing.expiresAtMs) {
              const nextEntries = new Map(loaded.entries)
              nextEntries.delete(key)
              return [
                Option.none<DecisionCachePayloadJson>(),
                { ...loaded, entries: nextEntries, misses: loaded.misses + 1 },
              ] as const
            }
            return [
              Option.some(existing.payload),
              { ...loaded, hits: loaded.hits + 1 },
            ] as const
          }),
        )
      })

      const store = Effect.fn("DecisionCachePort.store")(function* (
        key: DecisionCacheKey,
        payload: DecisionCachePayloadJson,
        ttlMillis: DecisionCacheTtlMillis,
      ): Effect.fn.Return<void, WorkspaceFsError> {
        yield* commitEntry(key, payload, ttlMillis)
        yield* ScopedCache.invalidate(scopedCache, key)
      })

      const lookupOrCompute = <E, R>(input: {
        readonly key: DecisionCacheKey
        readonly ttlMillis: DecisionCacheTtlMillis
        readonly compute: Effect.Effect<DecisionCachePayloadJson, E, R>
      }): Effect.Effect<DecisionCachePayloadJson, E | WorkspaceFsError, R> =>
        Effect.gen(function* () {
          const cachedOpt = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
            Effect.gen(function* () {
              const loaded = yield* ensureLoaded(state)
              const existing = loaded.entries.get(input.key)
              if (existing !== undefined && Date.now() <= existing.expiresAtMs) {
                return [
                  Option.some(existing.payload),
                  { ...loaded, hits: loaded.hits + 1 },
                ] as const
              }
              return [Option.none<DecisionCachePayloadJson>(), loaded] as const
            }),
          )

          return yield* match(cachedOpt)
            .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
            .with({ _tag: "None" }, () =>
              Effect.gen(function* () {
                const callerContext = yield* Effect.context<R>()
                const isCoalesced = yield* Ref.modify(inFlightWaitersRef, (waiters) => {
                  const count = waiters.get(input.key) ?? 0
                  const next = new Map(waiters)
                  next.set(input.key, count + 1)
                  return [count > 0, next] as const
                })

                if (isCoalesced) {
                  yield* SynchronizedRef.update(stateRef, (state) => ({
                    ...state,
                    coalescedRequests: state.coalescedRequests + 1,
                  }))
                } else {
                  yield* ScopedCache.invalidate(scopedCache, input.key)
                  yield* SynchronizedRef.update(stateRef, (state) => ({
                    ...state,
                    misses: state.misses + 1,
                  }))
                  yield* Ref.update(pendingComputesRef, (pending) => {
                    const next = new Map(pending)
                    next.set(input.key, {
                      ttlMillis: input.ttlMillis,
                      run: Effect.exit(
                        input.compute.pipe(Effect.provide(callerContext)),
                      ) as Effect.Effect<Exit.Exit<DecisionCachePayloadJson, never>>,
                    })
                    return next
                  })
                }

                const exit = yield* ScopedCache.get(scopedCache, input.key).pipe(
                  Effect.tapError(() => ScopedCache.invalidate(scopedCache, input.key)),
                  Effect.ensuring(
                    Effect.gen(function* () {
                      const shouldDeletePending = yield* Ref.modify(
                        inFlightWaitersRef,
                        (waiters) => {
                          const current = waiters.get(input.key) ?? 0
                          const next = new Map(waiters)
                          if (current <= 1) {
                            next.delete(input.key)
                            return [true, next] as const
                          }
                          next.set(input.key, current - 1)
                          return [false, next] as const
                        },
                      )
                      if (shouldDeletePending) {
                        yield* Ref.update(pendingComputesRef, (pending) => {
                          const next = new Map(pending)
                          next.delete(input.key)
                          return next
                        })
                      }
                    }),
                  ),
                )
                return yield* match(exit)
                  .with({ _tag: "Success" }, ({ value }) => Effect.succeed(value))
                  .with({ _tag: "Failure" }, ({ cause }) =>
                    ScopedCache.invalidate(scopedCache, input.key).pipe(
                      Effect.andThen(Effect.failCause(cause as Cause.Cause<E>)),
                    ),
                  )
                  .exhaustive()
              }),
            )
            .exhaustive()
        })

      const clear: Effect.Effect<void> = SynchronizedRef.updateEffect(stateRef, () =>
        Effect.gen(function* () {
          yield* ScopedCache.invalidateAll(scopedCache)
          if (options?.cacheFilePath !== undefined) {
            yield* fs.remove(options.cacheFilePath, { force: true }).pipe(Effect.ignore)
          }
          return {
            loaded: true,
            entries: new Map<string, PersistedDecisionEntry>(),
            hits: 0,
            misses: 0,
            coalescedRequests: 0,
          }
        }),
      )

      const stats: Effect.Effect<DecisionCacheStatsSnapshot> = SynchronizedRef.modifyEffect(
        stateRef,
        (state) =>
          ensureLoaded(state).pipe(
            Effect.orElseSucceed(() => state),
            Effect.map((loaded) => {
              const snapshot: DecisionCacheStatsSnapshot = {
                hits: NonNegativeCount.make(loaded.hits),
                misses: NonNegativeCount.make(loaded.misses),
                coalescedRequests: NonNegativeCount.make(loaded.coalescedRequests),
                size: NonNegativeCount.make(loaded.entries.size),
              }
              return [snapshot, loaded] as const
            }),
          ),
      )

      const impl: DecisionCachePortShape = {
        lookup,
        store,
        lookupOrCompute,
        clear,
        stats,
      }

      return impl
    }),
  )

export { makeDecisionCacheLayer }

export const DecisionCacheLive: Layer.Layer<DecisionCachePort> = makeDecisionCacheLayer().pipe(
  Layer.provide(NodeServices.layer),
)
