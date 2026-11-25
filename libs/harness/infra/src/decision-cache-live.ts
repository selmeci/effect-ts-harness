import { NodeServices } from "@effect/platform-node"
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  SynchronizedRef,
} from "effect"
import { match, P } from "ts-pattern"
import {
  type DecisionCacheKey,
  DecisionCachePayloadJson,
  type DecisionCacheStatsSnapshot,
  type DecisionCacheTtlMillis,
  isPureInterruptCause,
  NonNegativeCount,
  type WorkspaceFilePath,
  type WorkspaceFsError,
} from "@harness/contract"
import { DecisionCachePort, type DecisionCachePortShape } from "@harness/service"
import { toReadError, toWriteError } from "./cache-helpers.js"

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

type InFlightDecision = Deferred.Deferred<Option.Option<DecisionCachePayloadJson>, WorkspaceFsError>

interface DecisionCacheState {
  readonly loaded: boolean
  readonly entries: ReadonlyMap<string, PersistedDecisionEntry>
  readonly inFlight: ReadonlyMap<DecisionCacheKey, InFlightDecision>
  readonly hits: number
  readonly misses: number
  readonly coalescedRequests: number
}

interface LookupStepHit {
  readonly _tag: "Hit"
  readonly value: DecisionCachePayloadJson
}

interface LookupStepFollow {
  readonly _tag: "Follow"
  readonly deferred: InFlightDecision
}

interface LookupStepLead {
  readonly _tag: "Lead"
  readonly deferred: InFlightDecision
}

type LookupStep = LookupStepHit | LookupStepFollow | LookupStepLead

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
        inFlight: new Map<DecisionCacheKey, InFlightDecision>(),
        hits: 0,
        misses: 0,
        coalescedRequests: 0,
      })

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
            Effect.ensuring(
              fs
                .remove(tmpPath, { force: true })
                .pipe(
                  Effect.catch((err) =>
                    Effect.logDebug("Failed to remove temporary decision cache file", err),
                  ),
                ),
            ),
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
            return [Option.some(existing.payload), { ...loaded, hits: loaded.hits + 1 }] as const
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
        Effect.acquireUseRelease(
          SynchronizedRef.modifyEffect(
            stateRef,
            (state): Effect.Effect<readonly [LookupStep, DecisionCacheState], WorkspaceFsError> =>
              Effect.gen(function* () {
                const loaded = yield* ensureLoaded(state)
                const existing = loaded.entries.get(input.key)
                if (existing !== undefined && Date.now() <= existing.expiresAtMs) {
                  return [
                    { _tag: "Hit", value: existing.payload } satisfies LookupStep,
                    { ...loaded, hits: loaded.hits + 1 },
                  ] as const
                }
                const existingInFlight = loaded.inFlight.get(input.key)
                if (existingInFlight !== undefined) {
                  return [
                    { _tag: "Follow", deferred: existingInFlight } satisfies LookupStep,
                    { ...loaded, coalescedRequests: loaded.coalescedRequests + 1 },
                  ] as const
                }
                const deferred = yield* Deferred.make<
                  Option.Option<DecisionCachePayloadJson>,
                  WorkspaceFsError
                >()
                const nextInFlight = new Map(loaded.inFlight)
                nextInFlight.set(input.key, deferred)
                return [
                  { _tag: "Lead", deferred } satisfies LookupStep,
                  { ...loaded, inFlight: nextInFlight, misses: loaded.misses + 1 },
                ] as const
              }),
          ),
          (step): Effect.Effect<DecisionCachePayloadJson, E | WorkspaceFsError, R> =>
            match(step)
              .with({ _tag: "Hit" }, ({ value }) => Effect.succeed(value))
              .with({ _tag: "Follow" }, ({ deferred }) =>
                Deferred.await(deferred).pipe(
                  Effect.flatMap((outcomeOpt) =>
                    match(outcomeOpt)
                      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                      .with({ _tag: "None" }, () => lookupOrCompute(input))
                      .exhaustive(),
                  ),
                ),
              )
              .with({ _tag: "Lead" }, ({ deferred }) =>
                Effect.gen(function* () {
                  const computeExit = yield* Effect.exit(input.compute)
                  return yield* match(computeExit)
                    .with({ _tag: "Success" }, ({ value }) =>
                      Effect.gen(function* () {
                        const commitExit = yield* Effect.exit(
                          SynchronizedRef.updateEffect(stateRef, (state) =>
                            Effect.gen(function* () {
                              const loaded = yield* ensureLoaded(state)
                              const nextEntries = new Map(loaded.entries)
                              nextEntries.set(input.key, {
                                payload: value,
                                expiresAtMs: Date.now() + input.ttlMillis,
                              })
                              yield* persistEntries(nextEntries)
                              const nextInFlight = new Map(loaded.inFlight)
                              if (nextInFlight.get(input.key) === deferred) {
                                nextInFlight.delete(input.key)
                              }
                              return {
                                ...loaded,
                                entries: nextEntries,
                                inFlight: nextInFlight,
                              }
                            }),
                          ),
                        )
                        return yield* match(commitExit)
                          .with({ _tag: "Success" }, () =>
                            Deferred.succeed(deferred, Option.some(value)).pipe(Effect.as(value)),
                          )
                          .with({ _tag: "Failure" }, ({ cause }) =>
                            SynchronizedRef.update(stateRef, (state) => {
                              if (state.inFlight.get(input.key) !== deferred) {
                                return state
                              }
                              const nextInFlight = new Map(state.inFlight)
                              nextInFlight.delete(input.key)
                              return { ...state, inFlight: nextInFlight }
                            }).pipe(
                              Effect.andThen(
                                isPureInterruptCause(cause)
                                  ? Deferred.succeed(deferred, Option.none())
                                  : Deferred.failCause(deferred, cause),
                              ),
                              Effect.andThen(Effect.failCause(cause)),
                            ),
                          )
                          .exhaustive()
                      }),
                    )
                    .with({ _tag: "Failure" }, ({ cause }) =>
                      SynchronizedRef.update(stateRef, (state) => {
                        if (state.inFlight.get(input.key) !== deferred) {
                          return state
                        }
                        const nextInFlight = new Map(state.inFlight)
                        nextInFlight.delete(input.key)
                        return { ...state, inFlight: nextInFlight }
                      }).pipe(
                        Effect.andThen(
                          match(Cause.findError(cause))
                            .with({ _tag: "Success" }, () =>
                              Deferred.succeed(deferred, Option.none()),
                            )
                            .with({ _tag: "Failure" }, ({ failure: defectOrInterruptCause }) =>
                              isPureInterruptCause(defectOrInterruptCause)
                                ? Deferred.succeed(deferred, Option.none())
                                : Deferred.failCause(deferred, defectOrInterruptCause),
                            )
                            .exhaustive(),
                        ),
                        Effect.andThen(Effect.failCause(cause)),
                      ),
                    )
                    .exhaustive()
                }),
              )
              .exhaustive(),
          (step) =>
            match(step)
              .with({ _tag: "Hit" }, { _tag: "Follow" }, () => Effect.void)
              .with({ _tag: "Lead" }, ({ deferred }) =>
                SynchronizedRef.update(stateRef, (state) => {
                  if (state.inFlight.get(input.key) !== deferred) {
                    return state
                  }
                  const nextInFlight = new Map(state.inFlight)
                  nextInFlight.delete(input.key)
                  return { ...state, inFlight: nextInFlight }
                }).pipe(
                  Effect.andThen(Deferred.succeed(deferred, Option.none()).pipe(Effect.asVoid)),
                ),
              )
              .exhaustive(),
        )

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
              inFlight: new Map<DecisionCacheKey, InFlightDecision>(),
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
