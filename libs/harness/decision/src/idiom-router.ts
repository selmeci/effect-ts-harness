import { Effect, Layer, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

/** Ordered building blocks for MVP v2 (docs/mvp_v2.md §5 & §11); `review` first is a
 * deliberate mitigation for Clef-flash's weak out-of-scope detection (ties follow option order). */
export const IDIOM_BLOCKS = [
  "review",
  "services-and-layers",
  "errors",
  "schema",
  "pattern-matching",
  "resources-scope",
  "concurrency",
  "schedule",
  "testing",
  "alchemy-infra",
  "d1-repository",
  "durable-object-state",
  "httpapi",
  "rpc",
  "atom",
  "effect"
] as const
export type IdiomBlock = (typeof IDIOM_BLOCKS)[number]

/** Versioned decision definition: reviewed data, not a prompt string. */
export const IdiomRouterV1 = Decision.make({
  input: Schema.Struct({ planStep: Schema.String }),
  decisions: {
    fitsAny: Decision.probability({
      instructions: "Does this step map to a single Effect or Alchemy building block?"
    }),
    block: Decision.classify({
      instructions: "Which Effect or Alchemy pattern file best implements this step?",
      criteria: {
        review: "Unclear or spans multiple blocks",
        "services-and-layers": "Context.Service capability definitions and Layer wiring",
        errors: "Tagged domain/API errors and typed E-channel handling",
        schema: "Decoding, encoding, validating data at a boundary",
        "pattern-matching":
          "Exhaustive ts-pattern match().with().exhaustive() over discriminated unions (Schema.TaggedUnion / TaggedStruct)",
        "resources-scope": "Acquiring and releasing resources with Scope",
        concurrency: "Forking fibers, racing, bounded parallel work",
        schedule: "Retries, repetition, backoff, timing policies",
        testing: "@effect/vitest, TestClock, mock Layers, emulated tests",
        "alchemy-infra": "Alchemy cloud resources and bindings inside Layers",
        "d1-repository": "D1 SQLite tables and Drizzle repositories in type:infra",
        "durable-object-state": "Durable Object SQLite state and synchronous transactions",
        httpapi: "Public HttpApi endpoints with declared error Schemas and OpenAPI",
        rpc: "Internal RpcGroup procedures and Cloudflare.toHttpClient DO calls",
        atom: "Frontend AtomHttpApi reactive state over the public contract",
        effect: "Plain sequential effectful logic with Effect.gen / Effect.fn"
      }
    })
  }
})

/** Validates Ollama System One limits (1–64 questions per call, 2–26 options per choice/score). */
export const assertDecisionLimits = (definition: {
  readonly decisions: Readonly<
    Record<string, { readonly _tag: string; readonly criteria?: Readonly<Record<string, string>> | undefined }>
  >
}): void => {
  const entries = Object.entries(definition.decisions)
  if (entries.length < 1 || entries.length > 64) {
    Effect.runSync(
      Effect.die(new Error(`Decision definition must have 1..64 questions, got ${entries.length}`))
    )
  }
  for (const [name, question] of entries) {
    if (question.criteria !== undefined) {
      const optionCount = Object.keys(question.criteria).length
      if (optionCount < 2 || optionCount > 26) {
        Effect.runSync(
          Effect.die(
            new Error(`Decision question "${name}" must have 2..26 options, got ${optionCount}`)
          )
        )
      }
    }
  }
}

export const routeStep = Effect.fn("Harness.routeStep")(function* (planStep: string) {
  const outcome = yield* DecisionModel.decide(IdiomRouterV1, { input: { planStep } }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone)
  )

  if (Option.isNone(outcome)) {
    return "review" as const
  }

  const { answers } = outcome.value
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "IdiomRouterV1",
    "decision.block": answers.block.label,
    "decision.fitsAny": answers.fitsAny.probability
  })
  return answers.fitsAny.probability >= 0.7 ? answers.block.label : "review"
})

/** Local resident Clef-flash (9B) through Ollama's System One endpoint. */
export const LocalDecisionModel = TypeSafeDecisionModel.layer({ model: "clef-flash" }).pipe(
  Layer.provide(TypeSafeClient.layer({ apiUrl: "http://localhost:11434/v1" })),
  Layer.provide(FetchHttpClient.layer)
)
