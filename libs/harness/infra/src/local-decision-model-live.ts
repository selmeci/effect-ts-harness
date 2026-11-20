import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import { match } from "ts-pattern"

/** Configurable Clef-flash (9B) DecisionModel Layer requiring an explicit HttpClient. */
const makeLocalDecisionModelLayer = (options?: {
  readonly apiUrl?: string
  readonly model?: string
  readonly loadModule?: () => Promise<typeof import("@effect/ai-typesafe")>
}): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const httpClient = yield* HttpClient.HttpClient
      const rawUrl = (
        options?.apiUrl ??
        process.env.HARNESS_OLLAMA_URL ??
        process.env.OLLAMA_HOST ??
        "http://localhost:11434/v1"
      )
        .trim()
        .replace(/\/+$/, "")
      const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`
      const apiUrl = withScheme.endsWith("/v1") ? withScheme : `${withScheme}/v1`
      const model = options?.model ?? process.env.HARNESS_CLEF_MODEL ?? "clef-flash"
      const loadModule = options?.loadModule ?? (() => import("@effect/ai-typesafe"))
      const semaphore = yield* Semaphore.make(1)
      const cachedRef = yield* Ref.make<Option.Option<DecisionModel.DecisionModel>>(Option.none())

      const loadDelegate: Effect.Effect<DecisionModel.DecisionModel, AiError.AiError> =
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* Ref.get(cachedRef)
            return yield* match(existing)
              .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
              .with({ _tag: "None" }, () =>
                Effect.gen(function* () {
                  const { TypeSafeClient, TypeSafeDecisionModel } = yield* Effect.tryPromise({
                    try: () => loadModule(),
                    catch: (cause) =>
                      AiError.make({
                        module: "DecisionModel",
                        method: "decide",
                        reason: new AiError.UnknownError({ description: String(cause) }),
                      }),
                  })
                  const innerLayer = TypeSafeDecisionModel.layer({ model }).pipe(
                    Layer.provide(TypeSafeClient.layer({ apiUrl })),
                    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
                  )
                  const ctx = yield* Layer.buildWithScope(innerLayer, scope).pipe(
                    Effect.mapError((cause) =>
                      AiError.make({
                        module: "DecisionModel",
                        method: "decide",
                        reason: new AiError.UnknownError({ description: String(cause) }),
                      }),
                    ),
                  )
                  const dm = Context.get(ctx, DecisionModel.DecisionModel)
                  yield* Ref.set(cachedRef, Option.some(dm))
                  return dm
                }).pipe(
                  Effect.tapError((err) =>
                    Effect.logWarning(`Failed to load LocalDecisionModel: ${err.message}`),
                  ),
                ),
              )
              .exhaustive()
          }),
        )

      return {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: (def, opts) => loadDelegate.pipe(Effect.flatMap((dm) => dm.decide(def, opts))),
      } satisfies DecisionModel.DecisionModel
    }),
  )

/** Local resident Clef-flash (9B) through Ollama's System One endpoint. */
export const LocalDecisionModel: Layer.Layer<DecisionModel.DecisionModel> =
  makeLocalDecisionModelLayer().pipe(Layer.provide(FetchHttpClient.layer))

export { makeLocalDecisionModelLayer }
