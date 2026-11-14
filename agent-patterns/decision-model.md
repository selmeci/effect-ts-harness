# Advisory `DecisionModel` (`clef-flash` — TypeSafe System One)

Use `Decision.make` and `DecisionModel.decide` from `effect/ai` backed by `@effect/ai-typesafe` (`clef-flash`) for fast advisory classification, scoring, and probability estimation with a mandatory `1500 millis` timeout and deterministic fallback.

## 1. Defining & Invoking a `Decision` (`effect/ai`)

`Decision.make` batches 1–64 questions per inference pass using `Decision.classify` (2–26 options), `Decision.rate` (bounded score), and `Decision.probability` (0.0–1.0). Wrap `DecisionModel.decide` in `Effect.timeoutOption("1500 millis")` + `Effect.catchCause` (re-interrupting on `Cause.hasInterrupts(cause)`), then branch with `match(outcome)...exhaustive()`:

```ts
import { Cause, Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"

export const RouteDecision = Decision.make({
  input: Schema.Struct({ step: Schema.String }),
  decisions: {
    fits: Decision.probability({ instructions: "Does a known recipe fit this step?" }),
    category: Decision.classify({
      instructions: "Pick the closest pattern category.",
      options: { schema: "Schema", testing: "Testing", review: "Review" },
    }),
    confidence: Decision.rate({ instructions: "Rate confidence 1 to 5.", min: 1, max: 5 }),
  },
})

export const decideRoute = Effect.fn("Harness.decideRoute")(function* (step: string) {
  const outcome = yield* DecisionModel.decide(RouteDecision, { input: { step } }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning(`DecisionModel fallback: ${Cause.pretty(cause)}`).pipe(
            Effect.as(Option.none()),
          ),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () => Effect.succeed("review" as const))
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.succeed(value.answers.fits.probability >= 0.7 ? value.answers.category.choice : "review"),
    )
    .exhaustive()
})
```

## 2. Live Layer Wiring (`@effect/ai-typesafe`)

```ts
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import { Layer } from "effect"

export const LocalDecisionModel = TypeSafeDecisionModel.layer({ model: "clef-flash" }).pipe(
  Layer.provide(TypeSafeClient.layer({ apiUrl: "http://localhost:11434/v1" })),
  Layer.provide(FetchHttpClient.layer),
)
```

## 3. System One HTTP Protocol & Banned Endpoints

- `clef-flash` (`clef-*`) is a **TypeSafe System One** structured decision model, **NOT** a text-generation or chat LLM.
- **BANNED (returns HTTP 400/404 errors & blocked by harness guard/lint):** `POST /api/generate`, `POST /api/chat`, `POST /v1/chat/completions`, `POST /v1/completions`, `ollama run clef-flash`.
- **ONLY valid inference endpoint:** `POST http://localhost:11434/v1/systemone` with `{ "model": "clef-flash", "state": { ... }, "questions": { "<key>": { "type": "noul" | "choice" | "score", "instructions": "...", ... } } }` (model discovery: `GET /v1/models` or `GET /api/tags`).
- **Warm-up & VRAM retention:** Run `pnpm harness doctor` (or `OLLAMA_KEEP_ALIVE=-1` on `ollama serve`); cold VRAM load takes ~2.5–4s, warm pass ~40–130ms.
