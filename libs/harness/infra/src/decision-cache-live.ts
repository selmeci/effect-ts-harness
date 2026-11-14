import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option, Path, Schema, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import {
  type DecisionCacheKey,
  DecisionCachePayloadJson,
  type DecisionCacheStatsSnapshot,
  type DecisionCacheTtlMillis,
  ErrorReasonMessage,
  NonNegativeCount,
  type WorkspaceFilePath,
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
  loaded: boolean
  readonly entries: Map<string, PersistedDecisionEntry>
  hits: number
  misses: number
  coalescedRequests: number
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

const makeDecisionCacheLayer = (options?: {
  readonly cacheFilePath?: WorkspaceFilePath
}): Layer.Layer<DecisionCachePort> =>
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

      const ensureLoaded = (state: DecisionCacheState): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (state.loaded || options?.cacheFilePath === undefined) {
            state.loaded = true
            return
          }
          state.loaded = true
          const filePath = options.cacheFilePath
          const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
          if (!exists) {
            return
          }
          const rawOpt = yield* fs.readFileString(filePath).pipe(Effect.option)
          match(rawOpt)
            .with({ _tag: "None" }, () => undefined)
            .with({ _tag: "Some" }, ({ value: raw }) => {
              const decoded = decodePersistedStore(raw)
              match(decoded)
                .with({ _tag: "None" }, () => undefined)
                .with({ _tag: "Some" }, ({ value: store }) => {
                  const now = Date.now()
                  for (const [key, entry] of Object.entries(store.entries)) {
                    if (now <= entry.expiresAtMs) {
                      state.entries.set(key, entry)
                    }
                  }
                })
                .exhaustive()
            })
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

      const lookup = Effect.fn("DecisionCachePort.lookup")(function* (
        key: DecisionCacheKey,
      ): Effect.fn.Return<Option.Option<DecisionCachePayloadJson>> {
        return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* () {
            yield* ensureLoaded(state)
            const existing = state.entries.get(key)
            if (existing === undefined) {
              state.misses += 1
              return [Option.none<DecisionCachePayloadJson>(), state] as const
            }
            if (Date.now() > existing.expiresAtMs) {
              state.entries.delete(key)
              state.misses += 1
              return [Option.none<DecisionCachePayloadJson>(), state] as const
            }
            state.hits += 1
            return [Option.some(existing.payload), state] as const
          }),
        )
      })

      const store = Effect.fn("DecisionCachePort.store")(function* (
        key: DecisionCacheKey,
        payload: DecisionCachePayloadJson,
        ttlMillis: DecisionCacheTtlMillis,
      ): Effect.fn.Return<void, WorkspaceFsError> {
        yield* SynchronizedRef.updateEffect(stateRef, (state) =>
          Effect.gen(function* () {
            yield* ensureLoaded(state)
            state.entries.set(key, {
              payload,
              expiresAtMs: Date.now() + ttlMillis,
            })
            yield* persistEntries(state.entries)
            return state
          }),
        )
      })

      const clear: Effect.Effect<void> = SynchronizedRef.updateEffect(stateRef, (state) =>
        Effect.gen(function* () {
          state.entries.clear()
          state.hits = 0
          state.misses = 0
          state.coalescedRequests = 0
          state.loaded = true
          if (options?.cacheFilePath !== undefined) {
            yield* fs.remove(options.cacheFilePath, { force: true }).pipe(Effect.ignore)
          }
          return state
        }),
      )

      const stats: Effect.Effect<DecisionCacheStatsSnapshot> = SynchronizedRef.modifyEffect(
        stateRef,
        (state) =>
          Effect.gen(function* () {
            yield* ensureLoaded(state)
            const snapshot: DecisionCacheStatsSnapshot = {
              hits: NonNegativeCount.make(state.hits),
              misses: NonNegativeCount.make(state.misses),
              coalescedRequests: NonNegativeCount.make(state.coalescedRequests),
              size: NonNegativeCount.make(state.entries.size),
            }
            return [snapshot, state] as const
          }),
      )

      const impl: DecisionCachePortShape = {
        lookup,
        store,
        clear,
        stats,
      }

      return impl
    }),
  ).pipe(Layer.provide(NodeServices.layer))

export { makeDecisionCacheLayer }

export const DecisionCacheLive: Layer.Layer<DecisionCachePort> = makeDecisionCacheLayer()
