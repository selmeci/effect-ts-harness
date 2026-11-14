import { NodeServices } from "@effect/platform-node"
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
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

type InFlightDecision = Deferred.Deferred<
  Option.Option<DecisionCachePayloadJson>,
  WorkspaceFsError
>

const toReadError = (filePath: WorkspaceFilePath, err: unknown): WorkspaceFsError => {
  if (err instanceof WorkspaceFsError) {
    return err
  }
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
  if (err instanceof WorkspaceFsError) {
    return err
  }
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
 * When `options.cacheFilePath` is omitted, the cache operates in-memory only;
 * `HarnessInfraLive` / `makeHarnessInfraLayer` wires it to
 * `.harness/cache/decision-cache-v1.json` under the repository root.
 *
 * Architectural rationale ("why"): Per-key `Deferred` single-flight deduplication
 * coalesces concurrent `lookupOrCompute` callers without type casts, while
 * `SynchronizedRef` serializes immutable state snapshots with atomic
 * write-before-commit disk persistence so failed writes never diverge memory from disk.
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
      const inFlightRef = yield* Ref.make<ReadonlyMap<DecisionCacheKey, InFlightDecision>>(
        new Map(),
      )

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
                const newDeferred = yield* Deferred.make<
                  Option.Option<DecisionCachePayloadJson>,
                  WorkspaceFsError
                >()
                const existingOrNull = yield* Ref.modify(inFlightRef, (inFlight) => {
                  const existing = inFlight.get(input.key)
                  if (existing !== undefined) {
                    return [existing, inFlight] as const
                  }
                  const next = new Map(inFlight)
                  next.set(input.key, newDeferred)
                  return [null, next] as const
                })

                if (existingOrNull !== null) {
                  yield* SynchronizedRef.update(stateRef, (state) => ({
                    ...state,
                    coalescedRequests: state.coalescedRequests + 1,
                  }))
                  const resOpt = yield* Deferred.await(existingOrNull)
                  return yield* match(resOpt)
                    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                    .with({ _tag: "None" }, () => input.compute)
                    .exhaustive()
                }

                return yield* Effect.gen(function* () {
                  yield* SynchronizedRef.update(stateRef, (state) => ({
                    ...state,
                    misses: state.misses + 1,
                  }))
                  const computeExit = yield* Effect.exit(input.compute)
                  return yield* match(computeExit)
                    .with({ _tag: "Success" }, ({ value }) =>
                      Effect.gen(function* () {
                        const commitExit = yield* Effect.exit(
                          commitEntry(input.key, value, input.ttlMillis),
                        )
                        return yield* match(commitExit)
                          .with({ _tag: "Success" }, () =>
                            Deferred.succeed(newDeferred, Option.some(value)).pipe(
                              Effect.as(value),
                            ),
                          )
                          .with({ _tag: "Failure" }, ({ cause }) =>
                            Deferred.failCause(newDeferred, cause).pipe(
                              Effect.andThen(Effect.failCause(cause)),
                            ),
                          )
                          .exhaustive()
                      }),
                    )
                    .with({ _tag: "Failure" }, ({ cause }) =>
                      Deferred.succeed(newDeferred, Option.none()).pipe(
                        Effect.andThen(Effect.failCause(cause)),
                      ),
                    )
                    .exhaustive()
                }).pipe(
                  Effect.ensuring(
                    Ref.update(inFlightRef, (inFlight) => {
                      if (inFlight.get(input.key) !== newDeferred) {
                        return inFlight
                      }
                      const next = new Map(inFlight)
                      next.delete(input.key)
                      return next
                    }).pipe(
                      Effect.andThen(
                        Deferred.succeed(newDeferred, Option.none()).pipe(Effect.ignore),
                      ),
                    ),
                  ),
                )
              }),
            )
            .exhaustive()
        })

      const clear: Effect.Effect<void, WorkspaceFsError> = SynchronizedRef.updateEffect(
        stateRef,
        () =>
          Effect.gen(function* () {
            if (options?.cacheFilePath !== undefined) {
              const filePath = options.cacheFilePath
              yield* fs
                .remove(filePath, { force: true })
                .pipe(Effect.mapError((err) => toWriteError(filePath, err)))
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

      const stats: Effect.Effect<DecisionCacheStatsSnapshot, WorkspaceFsError> =
        SynchronizedRef.modifyEffect(stateRef, (state) =>
          ensureLoaded(state).pipe(
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
