import { Effect, Layer } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import type * as HttpClient from "effect/http/HttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

/** Configurable Clef-flash (9B) DecisionModel Layer requiring an explicit HttpClient. */
const makeLocalDecisionModelLayer = (options?: {
  readonly apiUrl?: string
  readonly model?: string
}): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> => {
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
  return TypeSafeDecisionModel.layer({ model }).pipe(
    Layer.provide(TypeSafeClient.layer({ apiUrl })),
  )
}

/** Local resident Clef-flash (9B) through Ollama's System One endpoint. */
export const LocalDecisionModel = Layer.unwrap(
  Effect.sync(() => makeLocalDecisionModelLayer()),
).pipe(Layer.provide(FetchHttpClient.layer))

export { makeLocalDecisionModelLayer }
