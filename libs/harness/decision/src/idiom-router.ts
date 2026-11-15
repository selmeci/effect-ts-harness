import { Cause, Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { isPureInterruptCause } from "@harness/contract"
import { match } from "ts-pattern"

/** Ordered building blocks for MVP v2 (docs/mvp_v2.md §5 & §11); `review` first is a
 * deliberate mitigation for Clef-flash's weak out-of-scope detection (ties follow option order). */
export const IDIOM_BLOCKS = [
  "review",
  "services-and-layers",
  "errors",
  "schema",
  "pattern-matching",
  "event-sourcing",
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
  "decision-model",
  "effect",
] as const
export type IdiomBlock = (typeof IDIOM_BLOCKS)[number]
export type BuildingBlock = IdiomBlock

export interface DeterministicRouteRule {
  readonly id: string
  readonly pattern: RegExp
  readonly block: BuildingBlock
}

export const DETERMINISTIC_ROUTE_RULES: ReadonlyArray<DeterministicRouteRule> = [
  {
    id: "schema",
    pattern:
      /\b(?:brand(?:ed)?(?:\s+type)?|schema\.brand|frombrand|nominal\s+type|primitive\s+obsession|tojsonschemadocument)\b/i,
    block: "schema",
  },
  {
    id: "httpapi",
    pattern:
      /\b(?:httpapi|httpapiendpoint|httpapigroup|httpapibuilder|aggregateapispec|aggregate[-\s]+api[-\s]+spec)\b/i,
    block: "httpapi",
  },
  {
    id: "testing",
    pattern: /\b(?:testclock|snapshot[-\s]+testing|snapshot[-\s]+tests?)\b/i,
    block: "testing",
  },
  {
    id: "event-sourcing",
    pattern:
      /\b(?:event[-\s]+sourcing|decider|evolve|event[-\s]+store|aggregate(?:\s+root)?|upcasters?|event[-\s]+upcasters?|event[-\s]+snapshots?)\b/i,
    block: "event-sourcing",
  },
  {
    id: "pattern-matching",
    pattern:
      /\b(?:ts-pattern|pattern[-\s]+matching|exhaustive\s+match|discriminated\s+union|tagged\s*union)\b/i,
    block: "pattern-matching",
  },
  {
    id: "d1-repository",
    pattern: /\b(?:d1[-\s]+repository|@effect\/sql-d1|sqlclient|sqlitemigrator|d1\s+database)\b/i,
    block: "d1-repository",
  },
  {
    id: "durable-object-state",
    pattern: /\b(?:durable[-\s]+object|sqlitedo|runsynctransaction)\b/i,
    block: "durable-object-state",
  },
  {
    id: "rpc",
    pattern: /\b(?:rpcgroup|rpctest|tohttpclient|durable\s+object\s+rpc)\b/i,
    block: "rpc",
  },
  {
    id: "atom",
    pattern: /\b(?:atomhttpapi|useatom|effect[-\s]+atom)\b/i,
    block: "atom",
  },
  {
    id: "decision-model",
    pattern:
      /\b(?:decision[-\s]*model|clef(?:-flash)?|system\s*one|systemone|ai-typesafe|typesafedecisionmodel|typesafeclient)\b/i,
    block: "decision-model",
  },
]

/** Versioned decision definition: reviewed data, not a prompt string. */
export const IdiomRouterV1 = Decision.make({
  input: Schema.Struct({ planStep: Schema.String }),
  decisions: {
    fitsAny: Decision.probability({
      instructions: "Does this step map to a single Effect or Alchemy building block?",
    }),
    block: Decision.classify({
      instructions: "Which Effect or Alchemy pattern file best implements this step?",
      criteria: {
        review: "Unclear or spans multiple blocks",
        "services-and-layers": "Context.Service capability definitions and Layer wiring",
        errors: "Tagged domain/API errors and typed E-channel handling",
        schema:
          "Decoding, encoding, validating data at a boundary, and branded domain types (Schema.brand / Brand.Branded)",
        "pattern-matching":
          "Exhaustive ts-pattern match().with().exhaustive() over discriminated unions (Schema.TaggedUnion / TaggedStruct)",
        "event-sourcing":
          "Event-sourced Decider (decide / evolve / initialState), EventStore, aggregate command handling, and non-empty event batches",
        "resources-scope": "Acquiring and releasing resources with Scope",
        concurrency: "Forking fibers, racing, bounded parallel work",
        schedule: "Retries, repetition, backoff, timing policies",
        testing: "@effect/vitest, TestClock, mock Layers, emulated tests",
        "alchemy-infra": "Alchemy cloud resources and bindings inside Layers",
        "d1-repository": "D1 SQLite tables and @effect/sql-d1 SqlClient repositories in type:infra",
        "durable-object-state": "Durable Object SQLite state and synchronous transactions",
        httpapi: "Public HttpApi endpoints with declared error Schemas and OpenAPI",
        rpc: "Internal RpcGroup procedures and Cloudflare.toHttpClient DO calls",
        atom: "Frontend AtomHttpApi reactive state over the public contract",
        "decision-model":
          "Advisory System One decisions: Decision.make (classify, rate, probability), DecisionModel.decide, @effect/ai-typesafe TypeSafeDecisionModel & TypeSafeClient over POST /v1/systemone",
        effect: "Plain sequential effectful logic with Effect.gen / Effect.fn",
      },
    }),
  },
})

/** Validates Ollama System One limits (1–64 questions per call, 2–26 options per choice/score). */
export const validateDecisionLimits = Effect.fn("Harness.validateDecisionLimits")(function* (definition: {
  readonly decisions: Readonly<
    Record<
      string,
      {
        readonly _tag: string
        readonly criteria?: Readonly<Record<string, unknown>> | ReadonlyArray<unknown> | undefined
      }
    >
  >
}): Effect.fn.Return<void> {
  const entries = Object.entries(definition.decisions)
  if (entries.length < 1 || entries.length > 64) {
    return yield* Effect.die(
      new Error(`Decision definition must have 1..64 questions, got ${entries.length}`),
    )
  }
  for (const [name, question] of entries) {
    if (question.criteria !== undefined) {
      const optionCount = Array.isArray(question.criteria)
        ? question.criteria.length
        : Object.keys(question.criteria).length
      if (optionCount < 2 || optionCount > 26) {
        return yield* Effect.die(
          new Error(`Decision question "${name}" must have 2..26 options, got ${optionCount}`),
        )
      }
    }
  }
})

export type RouteStepSource = "deterministic" | "model" | "degraded-fallback"

export interface RouteStepStatusResult {
  readonly block: BuildingBlock
  readonly source: RouteStepSource
}

export const routeStepWithStatus = Effect.fn("Harness.routeStepWithStatus")(function* (
  step: string,
): Effect.fn.Return<RouteStepStatusResult, never, DecisionModel.DecisionModel> {
  const trimmed = step.trim()
  if (trimmed.length === 0) {
    return { block: "review" as const, source: "deterministic" as const }
  }

  for (const rule of DETERMINISTIC_ROUTE_RULES) {
    if (rule.pattern.test(trimmed)) {
      return { block: rule.block, source: "deterministic" as const }
    }
  }

  const outcome = yield* DecisionModel.decide(IdiomRouterV1, { input: { planStep: step } }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCauseIf(
      (cause) => !isPureInterruptCause(cause),
      (cause) =>
        Effect.logWarning(`Decision model fallback: ${Cause.pretty(cause)}`).pipe(
          Effect.as(Option.none()),
        ),
    ),
    Effect.orElseSucceed(() => Option.none()),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.succeed({ block: "review" as const, source: "degraded-fallback" as const }),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const { answers } = value
        yield* Effect.annotateCurrentSpan({
          "decision.definition": "IdiomRouterV1",
          "decision.block": answers.block.label,
          "decision.fitsAny": answers.fitsAny.probability,
        })
        return {
          block: answers.fitsAny.probability >= 0.7 ? answers.block.label : ("review" as const),
          source: "model" as const,
        }
      }),
    )
    .exhaustive()
})

export const routeStep = Effect.fn("Harness.routeStep")(function* (step: string) {
  const result = yield* routeStepWithStatus(step)
  return result.block
})
