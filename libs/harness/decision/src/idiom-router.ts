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
  "planning",
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
  {
    id: "planning",
    pattern: /\b(?:plan-check|skeleton|stub<|ears\s+spec|planning\.md)\b/i,
    block: "planning",
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
        planning:
          "Two-stage Effect planning: mapping EARS clauses to schemas, Context.Service capabilities, Layer skeletons, and stub<A, E, R>()",
        effect: "Plain sequential effectful logic with Effect.gen / Effect.fn",
      },
    }),
  },
})

/** Validates Ollama System One limits (1–64 questions per call, 2–26 options per choice/score). */
export const validateDecisionLimits = Effect.fn("Harness.validateDecisionLimits")(
  function* (definition: {
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
  },
)

/** Minimum BM25 lexical score required to promote a `review` route via hybrid retrieval. */
export const HYBRID_ROUTE_BM25_THRESHOLD = 0.75

/**
 * Minimum RRF score (`1 / (60 + rankIdx)`) required to promote a `review` route
 * (`rank_patterns_vector_hybrid`, k = 60, accepting ranks 0, 1, and 2).
 */
export const HYBRID_ROUTE_RRF_THRESHOLD = 1 / 62

export type HybridCandidateScoreKind = "bm25" | "rrf"

export type RouteStepSource = "deterministic" | "model" | "hybrid-retrieval" | "degraded-fallback"

export interface RouteStepStatusResult {
  readonly block: BuildingBlock
  readonly source: RouteStepSource
}

export interface PatternCandidateSlug {
  readonly slug: string
  readonly path?: string | undefined
  readonly score?: number | undefined
  readonly scoreKind?: HybridCandidateScoreKind | undefined
}

const KNOWN_IDIOM_BLOCK_SET: ReadonlySet<string> = new Set(IDIOM_BLOCKS)

const isReviewBlock = (block: BuildingBlock): boolean =>
  match(block)
    .with("review", () => true)
    .with(
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
      "planning",
      "effect",
      () => false,
    )
    .exhaustive()

export const selectRouteWithHybridCandidates = (
  routed: RouteStepStatusResult,
  candidates: ReadonlyArray<PatternCandidateSlug>,
): RouteStepStatusResult => {
  const sourceAllowsHybrid = match(routed.source)
    .with("deterministic", () => false)
    .with("model", "hybrid-retrieval", "degraded-fallback", () => true)
    .exhaustive()
  if (!sourceAllowsHybrid || !isReviewBlock(routed.block)) {
    return routed
  }
  const matchingCandidate = candidates.find((c) => {
    if (!KNOWN_IDIOM_BLOCK_SET.has(c.slug) || c.slug === "review") return false
    if (c.score === undefined || !Number.isFinite(c.score)) return false
    const threshold = match(c.scoreKind ?? "bm25")
      .with("bm25", () => HYBRID_ROUTE_BM25_THRESHOLD)
      .with("rrf", () => HYBRID_ROUTE_RRF_THRESHOLD)
      .exhaustive()
    return c.score >= threshold
  })
  if (matchingCandidate !== undefined) {
    const matchedBlock = IDIOM_BLOCKS.find((b) => b === matchingCandidate.slug)
    if (matchedBlock !== undefined) {
      return {
        block: matchedBlock,
        source: "hybrid-retrieval" as const,
      }
    }
  }
  return routed
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
