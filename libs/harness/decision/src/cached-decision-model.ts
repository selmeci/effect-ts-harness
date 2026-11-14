import { createHash } from "node:crypto"
import { join } from "node:path"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import * as AiError from "effect/ai/AiError"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  type WorkspaceFsError,
} from "@harness/contract"
import { NonNegativeCount, resolveHarnessStateDir } from "@harness/gates"
import { DecisionCachePort } from "@harness/service"
import { match } from "ts-pattern"

export { DecisionCacheKey }

export const DecisionTaskId = Schema.NonEmptyString.pipe(Schema.brand("DecisionTaskId"))
export type DecisionTaskId = typeof DecisionTaskId.Type

export const DecisionPromptVersion = Schema.NonEmptyString.pipe(
  Schema.brand("DecisionPromptVersion"),
)
export type DecisionPromptVersion = typeof DecisionPromptVersion.Type

export const HARNESS_DECISION_PROMPT_VERSION: DecisionPromptVersion =
  DecisionPromptVersion.make("decisions-v1")

export const DecisionCacheHitStatus = Schema.Literals(["hit", "miss"]).pipe(
  Schema.brand("DecisionCacheHitStatus"),
)
export type DecisionCacheHitStatus = typeof DecisionCacheHitStatus.Type

export const CanonicalInputJson = Schema.String.pipe(Schema.brand("CanonicalInputJson"))
export type CanonicalInputJson = typeof CanonicalInputJson.Type

export const CachedDecisionLookupInput = Schema.Struct({
  taskId: DecisionTaskId,
  promptVersion: DecisionPromptVersion,
  canonicalInputJson: CanonicalInputJson,
})
export type CachedDecisionLookupInput = typeof CachedDecisionLookupInput.Type

export const CachedDecisionLookupResult = Schema.Struct({
  cacheKey: DecisionCacheKey,
  cacheStatus: DecisionCacheHitStatus,
  coalescedFiberCount: NonNegativeCount,
})
export type CachedDecisionLookupResult = typeof CachedDecisionLookupResult.Type

const CachedUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(Schema.Finite),
  outputTokens: Schema.optional(Schema.Finite),
})

const CachedDecisionEntrySchema = Schema.Struct({
  cacheKey: DecisionCacheKey,
  taskId: DecisionTaskId,
  promptVersion: DecisionPromptVersion,
  answers: Schema.Record(Schema.String, Schema.Unknown),
  usage: CachedUsageSchema,
  id: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Finite),
})
export type CachedDecisionEntry = typeof CachedDecisionEntrySchema.Type

const decodeCachedDecisionEntry = Schema.decodeOption(
  Schema.fromJsonString(CachedDecisionEntrySchema),
)

export interface CachedDecisionModelStats {
  readonly hits: number
  readonly misses: number
  readonly coalescedRequests: number
  readonly size: number
}

export interface CachedDecisionModelOptions {
  readonly taskId?: string | undefined
  readonly promptVersion?: string | undefined
  readonly modelId?: string | undefined
  readonly cacheFilePath?: string | undefined
  readonly ttlMillis?: number | undefined
}

export const resolveDecisionCachePath = (repoRoot: string): string =>
  join(resolveHarnessStateDir(repoRoot), "cache", "decisions-v1.json")

export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null"
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>
    const sortedKeys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    return `{${pairs.join(",")}}`
  }
  return "null"
}

export const computeDecisionCacheKey = (params: {
  readonly taskId: string
  readonly promptVersion?: string | undefined
  readonly modelId?: string | undefined
  readonly input: unknown
}): DecisionCacheKey => {
  const version = params.promptVersion ?? HARNESS_DECISION_PROMPT_VERSION
  const modelSegment =
    params.modelId !== undefined && params.modelId.length > 0 ? `\0${params.modelId}` : ""
  const payload = `${params.taskId}\0${version}${modelSegment}\0${canonicalJson(params.input)}`
  const digest = createHash("sha256").update(payload, "utf8").digest("hex")
  return DecisionCacheKey.make(digest)
}

const deriveDefinitionTaskId = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
): string => {
  const keys = Object.keys(definition.decisions).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `${keys.join(",")}:${canonicalJson(definition.decisions)}`
}

const ProbeDecisionDefinition = Decision.make({
  input: Schema.Struct({
    canonicalInputJson: Schema.String,
  }),
  decisions: {
    cachedProbe: Decision.probability({
      instructions: "Evaluate cached decision lookup probe.",
    }),
  },
})

export const decideCachedDecisionLookup = Effect.fn("CachedDecisionModel.decide")(function* (
  input: CachedDecisionLookupInput,
): Effect.fn.Return<CachedDecisionLookupResult, never, DecisionModel.DecisionModel> {
  const cacheKey = computeDecisionCacheKey({
    taskId: input.taskId,
    promptVersion: input.promptVersion,
    input: input.canonicalInputJson,
  })
  const cachePortOpt = yield* Effect.serviceOption(DecisionCachePort)
  const existingOpt = yield* match(cachePortOpt)
    .with({ _tag: "Some" }, ({ value }) => value.lookup(cacheKey))
    .with({ _tag: "None" }, () => Effect.succeed(Option.none<DecisionCachePayloadJson>()))
    .exhaustive()

  const hitResult = match(existingOpt)
    .with({ _tag: "Some" }, () =>
      Option.some<CachedDecisionLookupResult>({
        cacheKey,
        cacheStatus: DecisionCacheHitStatus.make("hit"),
        coalescedFiberCount: NonNegativeCount.make(0),
      }),
    )
    .with({ _tag: "None" }, () => Option.none<CachedDecisionLookupResult>())
    .exhaustive()

  if (Option.isSome(hitResult)) {
    return hitResult.value
  }

  const outcome = yield* DecisionModel.decide(ProbeDecisionDefinition, {
    input: { canonicalInputJson: input.canonicalInputJson },
  }).pipe(Effect.option)

  yield* match(outcome)
    .with({ _tag: "Some" }, ({ value }) => {
      const entry: CachedDecisionEntry = {
        cacheKey,
        taskId: input.taskId,
        promptVersion: input.promptVersion,
        answers: value.answers,
        usage: {
          inputTokens: value.usage.inputTokens ?? 0,
          outputTokens: value.usage.outputTokens ?? 0,
        },
      }
      return match(cachePortOpt)
        .with({ _tag: "Some" }, ({ value: port }) =>
          port
            .store(
              cacheKey,
              DecisionCachePayloadJson.make(JSON.stringify(entry)),
              DecisionCacheTtlMillis.make(300_000),
            )
            .pipe(Effect.ignore),
        )
        .with({ _tag: "None" }, () => Effect.void)
        .exhaustive()
    })
    .with({ _tag: "None" }, () => Effect.void)
    .exhaustive()

  return {
    cacheKey,
    cacheStatus: DecisionCacheHitStatus.make("miss"),
    coalescedFiberCount: NonNegativeCount.make(1),
  }
})

export const makeCachedDecisionModelLayer = (
  options?: CachedDecisionModelOptions,
): Layer.Layer<DecisionModel.DecisionModel, never, DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const inner = yield* DecisionModel.DecisionModel
      const cachePortOpt = yield* Effect.serviceOption(DecisionCachePort)
      const promptVersion = DecisionPromptVersion.make(
        options?.promptVersion ?? HARNESS_DECISION_PROMPT_VERSION,
      )
      const ttlMillis = options?.ttlMillis ?? 300_000
      const memoryCache = new Map<DecisionCacheKey, CachedDecisionEntry>()
      const memoryExpiresAt = new Map<DecisionCacheKey, number>()

      const inFlight = new Map<
        DecisionCacheKey,
        Deferred.Deferred<CachedDecisionEntry, AiError.AiError>
      >()

      return DecisionModel.DecisionModel.of({
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: <Input extends Schema.Constraint, Decisions extends Record<string, Decision.Any>>(
          definition: Decision.Definition<Input, Decisions>,
          decideOptions: DecisionModel.DecideOptions<Input>,
        ): Effect.Effect<
          DecisionModel.DecideResponse<Decisions>,
          AiError.AiError,
          Input["EncodingServices"]
        > =>
          Effect.gen(function* () {
            const taskIdStr =
              options?.taskId !== undefined && options.taskId.length > 0
                ? options.taskId
                : deriveDefinitionTaskId(definition)
            const cacheKey = computeDecisionCacheKey({
              taskId: taskIdStr,
              promptVersion,
              modelId: options?.modelId,
              input: decideOptions.input,
            })

            const nowMs = Date.now()
            const expAt = memoryExpiresAt.get(cacheKey)
            const cached = memoryCache.get(cacheKey)
            if (
              (expAt !== undefined && nowMs > expAt) ||
              (cached?.expiresAt !== undefined && nowMs > cached.expiresAt)
            ) {
              memoryCache.delete(cacheKey)
              memoryExpiresAt.delete(cacheKey)
            }

            const cachedEntry = memoryCache.get(cacheKey)
            if (cachedEntry !== undefined) {
              return {
                answers: cachedEntry.answers as Decision.Answers<Decisions>,
                usage: new DecisionModel.DecisionUsage({
                  inputTokens: cachedEntry.usage.inputTokens,
                  outputTokens: cachedEntry.usage.outputTokens,
                }),
                metadata: {},
              }
            }

            const portPayloadOpt = yield* match(cachePortOpt)
              .with({ _tag: "Some" }, ({ value: port }) => port.lookup(cacheKey))
              .with({ _tag: "None" }, () => Effect.succeed(Option.none<DecisionCachePayloadJson>()))
              .exhaustive()

            const portEntryOpt = match(portPayloadOpt)
              .with({ _tag: "Some" }, ({ value }) => decodeCachedDecisionEntry(value))
              .with({ _tag: "None" }, () => Option.none<CachedDecisionEntry>())
              .exhaustive()

            if (Option.isSome(portEntryOpt)) {
              const portEntry = portEntryOpt.value
              if (portEntry.expiresAt === undefined || nowMs <= portEntry.expiresAt) {
                memoryCache.set(cacheKey, portEntry)
                return {
                  answers: portEntry.answers as Decision.Answers<Decisions>,
                  usage: new DecisionModel.DecisionUsage({
                    inputTokens: portEntry.usage.inputTokens,
                    outputTokens: portEntry.usage.outputTokens,
                  }),
                  metadata: {},
                }
              }
            }

            const existingDeferred = inFlight.get(cacheKey)
            if (existingDeferred !== undefined) {
              const coalescedEntry = yield* Deferred.await(existingDeferred)
              return {
                answers: coalescedEntry.answers as Decision.Answers<Decisions>,
                usage: new DecisionModel.DecisionUsage({
                  inputTokens: coalescedEntry.usage.inputTokens,
                  outputTokens: coalescedEntry.usage.outputTokens,
                }),
                metadata: {},
              }
            }

            const deferred = yield* Deferred.make<CachedDecisionEntry, AiError.AiError>()
            inFlight.set(cacheKey, deferred)

            const compute = Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const response = yield* restore(inner.decide(definition, decideOptions))
                const entry: CachedDecisionEntry = {
                  cacheKey,
                  taskId: DecisionTaskId.make(taskIdStr),
                  promptVersion,
                  answers: response.answers as Readonly<Record<string, unknown>>,
                  usage: {
                    inputTokens: response.usage.inputTokens ?? 0,
                    outputTokens: response.usage.outputTokens ?? 0,
                  },
                  ...(options?.modelId !== undefined ? { modelId: options.modelId } : {}),
                  expiresAt: Date.now() + ttlMillis,
                }

                memoryCache.set(cacheKey, entry)
                memoryExpiresAt.set(cacheKey, Date.now() + ttlMillis)
                yield* match(cachePortOpt)
                  .with({ _tag: "Some" }, ({ value: port }) =>
                    port
                      .store(
                        cacheKey,
                        DecisionCachePayloadJson.make(JSON.stringify(entry)),
                        DecisionCacheTtlMillis.make(ttlMillis),
                      )
                      .pipe(Effect.ignore),
                  )
                  .with({ _tag: "None" }, () => Effect.void)
                  .exhaustive()

                return { response, entry }
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  inFlight.delete(cacheKey)
                }).pipe(
                  Effect.andThen(
                    match(exit)
                      .with({ _tag: "Failure" }, ({ cause }) => Deferred.failCause(deferred, cause))
                      .with({ _tag: "Success" }, ({ value }) => Deferred.succeed(deferred, value.entry))
                      .exhaustive(),
                  ),
                ),
              ),
            )

            const { response } = yield* compute
            return response
          }),
      })
    }),
  )

export const wrapDecisionModelLayer = <E, R>(
  innerLayer: Layer.Layer<DecisionModel.DecisionModel, E, R>,
  options?: CachedDecisionModelOptions,
): Layer.Layer<DecisionModel.DecisionModel, E, R> =>
  Layer.provide(makeCachedDecisionModelLayer(options), innerLayer)

export const evaluateBatchCachedDecisions = <A, E, R>(
  effects: ReadonlyArray<Effect.Effect<A, E, R>>,
): Effect.Effect<Array<A>, E, R> => Effect.all(effects, { concurrency: 4 })

export const lookupOrComputeDecisionPayload = Effect.fn("DecisionCache.lookupOrCompute")(
  function* (input: {
    readonly key: DecisionCacheKey
    readonly ttlMillis: DecisionCacheTtlMillis
    readonly compute: Effect.Effect<DecisionCachePayloadJson, WorkspaceFsError>
  }): Effect.fn.Return<DecisionCachePayloadJson, WorkspaceFsError, DecisionCachePort> {
    const cache = yield* DecisionCachePort
    const existing = yield* cache.lookup(input.key)
    return yield* match(existing)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.gen(function* () {
          const computed = yield* input.compute
          yield* cache.store(input.key, computed, input.ttlMillis)
          return computed
        }),
      )
      .exhaustive()
  },
)

export const CachedDecisionModel = {
  decide: decideCachedDecisionLookup,
  layer: makeCachedDecisionModelLayer,
  wrapLayer: wrapDecisionModelLayer,
  canonicalJson,
  computeCacheKey: computeDecisionCacheKey,
  resolveCachePath: resolveDecisionCachePath,
  evaluateBatch: evaluateBatchCachedDecisions,
} as const
