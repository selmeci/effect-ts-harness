import { Context, Effect, Layer } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"

/** Configurable Clef-flash (9B) DecisionModel Layer requiring an explicit HttpClient. */
const makeLocalDecisionModelLayer = (options?: {
  readonly apiUrl?: string
  readonly model?: string
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

      const loadDelegate = yield* Effect.cached(
        Effect.gen(function* () {
          const { TypeSafeClient, TypeSafeDecisionModel } = yield* Effect.tryPromise({
            try: () => import("@effect/ai-typesafe"),
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
          const ctx = yield* Layer.buildWithScope(innerLayer, scope)
          return Context.get(ctx, DecisionModel.DecisionModel)
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
