import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path, Schema, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import {
  type AstGateEvaluationReport,
  type AstGateFileBatchInput,
  AstGateViolationContract,
  ErrorReasonMessage,
  GateVerdict,
  HARNESS_GATE_RULE_VERSION,
  NonNegativeCount,
  type WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import {
  computeContentSha256,
  getOrCreateCachedSourceFile,
  inferPackageTagFromPath,
  visitSourceFileSinglePass,
} from "@harness/gates"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"

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
  loaded: boolean
  readonly entries: Map<string, PersistedAstCacheEntry>
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

const makeAstGateCacheLayer = (options?: {
  readonly cacheFilePath?: WorkspaceFilePath
}): Layer.Layer<AstGateCachePort> =>
  Layer.effect(
    AstGateCachePort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateRef = yield* SynchronizedRef.make<AstGateCacheState>({
        loaded: options?.cacheFilePath === undefined,
        entries: new Map<string, PersistedAstCacheEntry>(),
      })

      const ensureLoaded = (state: AstGateCacheState): Effect.Effect<void> =>
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
          const rawOpt = yield* fs
            .readFileString(filePath)
            .pipe(Effect.option)
          match(rawOpt)
            .with({ _tag: "None" }, () => undefined)
            .with({ _tag: "Some" }, ({ value: raw }) => {
              const decoded = decodePersistedStore(raw)
              match(decoded)
                .with({ _tag: "None" }, () => undefined)
                .with({ _tag: "Some" }, ({ value: store }) => {
                  for (const [key, entry] of Object.entries(store.entries)) {
                    state.entries.set(key, entry)
                  }
                })
                .exhaustive()
            })
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

      const evaluateBatch = Effect.fn("AstGateCachePort.evaluateBatch")(function* (
        files: ReadonlyArray<AstGateFileBatchInput>,
      ): Effect.fn.Return<AstGateEvaluationReport, WorkspaceFsError> {
        return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* () {
            yield* ensureLoaded(state)

            let cacheHitCount = 0
            let dirty = false
            const violations: Array<AstGateViolationContract> = []

            for (const file of files) {
              const pkgTag = file.packageTag ?? inferPackageTagFromPath(file.filePath)
              const cacheKey = `${file.filePath}\0${pkgTag}`
              const contentSha256 = computeContentSha256(file.content)
              const existing = state.entries.get(cacheKey)

              if (
                existing !== undefined &&
                existing.contentSha256 === contentSha256 &&
                existing.ruleVersion === HARNESS_GATE_RULE_VERSION
              ) {
                cacheHitCount += 1
                violations.push(...existing.violations)
                continue
              }

              const { sourceFile } = getOrCreateCachedSourceFile(
                file.filePath,
                file.content,
                contentSha256,
              )
              const fileViolations = visitSourceFileSinglePass(
                sourceFile,
                file.filePath,
                pkgTag,
              )
              const contractViolations: Array<AstGateViolationContract> = fileViolations.map(
                (v) => ({
                  category: v.category,
                  rule: v.rule,
                  message: v.message,
                  file: v.file,
                  line: v.line,
                  enclosingSymbol: v.enclosingSymbol,
                }),
              )

              state.entries.set(cacheKey, {
                contentSha256,
                ruleVersion: HARNESS_GATE_RULE_VERSION,
                violations: contractViolations,
              })
              dirty = true
              violations.push(...contractViolations)
            }

            if (dirty) {
              yield* persistEntries(state.entries)
            }

            const report: AstGateEvaluationReport = {
              verdict:
                violations.length === 0 ? GateVerdict.make("clean") : GateVerdict.make("violated"),
              violations,
              inspectedFileCount: NonNegativeCount.make(files.length),
              cacheHitCount: NonNegativeCount.make(cacheHitCount),
            }

            return [report, state] as const
          }),
        )
      })

      const clearCache: Effect.Effect<void> = SynchronizedRef.updateEffect(stateRef, (state) =>
        Effect.gen(function* () {
          state.entries.clear()
          state.loaded = true
          if (options?.cacheFilePath !== undefined) {
            yield* fs.remove(options.cacheFilePath, { force: true }).pipe(Effect.ignore)
          }
          return state
        }),
      )

      const cacheSize: Effect.Effect<NonNegativeCount> = SynchronizedRef.modifyEffect(
        stateRef,
        (state) =>
          Effect.gen(function* () {
            yield* ensureLoaded(state)
            return [NonNegativeCount.make(state.entries.size), state] as const
          }),
      )

      const impl: AstGateCachePortShape = {
        evaluateBatch,
        clearCache,
        cacheSize,
      }

      return impl
    }),
  ).pipe(Layer.provide(NodeServices.layer))

export { makeAstGateCacheLayer }

export const AstGateCacheLive: Layer.Layer<AstGateCachePort> = makeAstGateCacheLayer()
