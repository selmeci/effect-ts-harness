import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"

export const TriageV1 = Decision.make({
  input: Schema.Struct({ failureOutput: Schema.String }),
  decisions: {
    kind: Decision.classify({
      instructions:
        "Is this test or compilation failure mechanical (syntax, imports, boundaries, typing) or semantic (logic, test expectations)?",
      criteria: {
        mechanical: "Mechanical error: syntax, typecheck, lint, or module boundary issue",
        semantic: "Semantic error: logical test failure, incorrect behavior, or unexpected runtime state"
      }
    })
  }
})

export interface TriageResult {
  readonly kind: "mechanical" | "semantic"
  readonly hint: string
}

const DETERMINISTIC_TRIAGE_RULES: ReadonlyArray<{
  readonly pattern: string
  readonly result: TriageResult
}> = [
  {
    pattern: "floatingEffect",
    result: {
      kind: "mechanical",
      hint: "Unhandled Effect value — yield* the Effect inside Effect.gen or return it (see agent-patterns/services-and-layers.md)."
    }
  },
  {
    pattern: "harness/syntax-bans",
    result: {
      kind: "mechanical",
      hint: "Banned syntax in Effect code — use Effect.gen, Schema.fromJsonString, and typed errors instead of async/await, try/catch, throw, or JSON.parse (see agent-patterns/errors.md and agent-patterns/schema.md)."
    }
  },
  {
    pattern: "no-restricted-imports",
    result: {
      kind: "mechanical",
      hint: "Restricted infra import outside type:infra — move drizzle-orm, alchemy, or @effect/sql-* usage to a type:infra library (see agent-patterns/d1-repository.md and agent-patterns/alchemy-infra.md)."
    }
  },
  {
    pattern: "enforce-module-boundaries",
    result: {
      kind: "mechanical",
      hint: "Nx module boundary violation — check package.json nx.tags against the allowed dependency hierarchy."
    }
  },
  {
    pattern: "lazy-effect",
    result: {
      kind: "mechanical",
      hint: "Effect/Layer is already lazy (TS377091) — do not wrap zero-argument Effect or Layer members in `() => Effect<...>` (use `readonly prop: Effect.Effect<...>` or parameterize factory functions; see agent-patterns/services-and-layers.md)."
    }
  },
  {
    pattern: "lazyEffect",
    result: {
      kind: "mechanical",
      hint: "Effect/Layer is already lazy (TS377091) — do not wrap zero-argument Effect or Layer members in `() => Effect<...>` (use `readonly prop: Effect.Effect<...>` or parameterize factory functions; see agent-patterns/services-and-layers.md)."
    }
  },
  {
    pattern: "redundant-or-die",
    result: {
      kind: "mechanical",
      hint: "Redundant Effect.orDie inside generator (TS377088) — hoist `Effect.orDie` once to the outer `Effect.gen(...).pipe(Effect.orDie)` or `Effect.fn(..., Effect.orDie)`."
    }
  },
  {
    pattern: "schema-number",
    result: {
      kind: "mechanical",
      hint: "Non-finite Schema number (TS377087) — use `Schema.Finite` or `Schema.FiniteFromString` (or `Schema.Int`) instead of `Schema.Number` / `Schema.NumberFromString`."
    }
  },
  {
    pattern: "prefer-typed-schema-decoder",
    result: {
      kind: "mechanical",
      hint: "Input is already assignable to Schema Encoded type (TS377092) — use `Schema.decodeSync` / `Schema.decodeEffect` instead of `decodeUnknown*`."
    }
  },
  {
    pattern: "Config.redacted",
    result: {
      kind: "mechanical",
      hint: "Sensitive configuration keys (SECRET, TOKEN, PASSWORD, API_KEY, PRIVATE_KEY, CREDENTIAL) must use Config.redacted(...) instead of Config.string(...) to prevent leaking secrets in logs and spans."
    }
  },
  {
    pattern: "SQL injection risk",
    result: {
      kind: "mechanical",
      hint: "Raw SQL template interpolation in .exec() or .prepare() is banned (SQL injection risk) — use parameterized queries or Drizzle ORM."
    }
  },
  {
    pattern: "Impure global",
    result: {
      kind: "mechanical",
      hint: "Impure global Date.now() / new Date() / Math.random() is banned in type:domain — pass timestamps/randomness via input or use Effect Clock / Random services so domain deciders remain deterministic."
    }
  },
  {
    pattern: "Schedule.forever",
    result: {
      kind: "mechanical",
      hint: "Unbounded Effect.retry with Schedule.forever is banned (retry storm risk) — bound retries with Schedule.recurs(n) or Schedule.upTo(duration)."
    }
  },
  {
    pattern: "Effect.ignore",
    result: {
      kind: "mechanical",
      hint: "Swallowing typed errors with Effect.ignore is banned in type:domain — surface failures in the E channel or handle them explicitly."
    }
  },
  {
    pattern: "Skipping or focusing tests",
    result: {
      kind: "mechanical",
      hint: "Skipping or focusing tests (.skip, .only, .todo) is banned by Three-Layer Test Defence (E4 §3) — fix the failing test or implementation instead of bypassing verification."
    }
  },
  {
    pattern: "TypeScript suppression",
    result: {
      kind: "mechanical",
      hint: "TypeScript suppression directives (@ts-ignore, @ts-expect-error, @ts-nocheck) are banned — fix the underlying type error instead of silencing the compiler."
    }
  },
  {
    pattern: "Suppressing `effecttsgo/*`",
    result: {
      kind: "mechanical",
      hint: "Suppressing effecttsgo/* (@effect/language-service) or harness/* diagnostics with oxlint-disable/eslint-disable/@effect-diagnostics is banned — fix the underlying violation instead."
    }
  },
  {
    pattern: "discriminant-branching",
    result: {
      kind: "mechanical",
      hint: "Do not branch on union discriminants with if/else or ternary — enumerate all variants explicitly with match(value).with(...).exhaustive() from ts-pattern (see agent-patterns/pattern-matching.md)."
    }
  },
  {
    pattern: "non-exhaustive-union-match",
    result: {
      kind: "mechanical",
      hint: "Matching on a closed union with .otherwise() hides unhandled variants — enumerate every variant and terminate with .exhaustive() (see agent-patterns/pattern-matching.md)."
    }
  },
  {
    pattern: "No switch statements",
    result: {
      kind: "mechanical",
      hint: "Switch statements are banned in domain/app code — use match(value).with(...).exhaustive() from ts-pattern (see agent-patterns/pattern-matching.md)."
    }
  },
  {
    pattern: "enumerate all states with match",
    result: {
      kind: "mechanical",
      hint: "Branching on discriminated unions or tagged types (_tag, Option, Either, Result) with if/else or ternary is banned — enumerate all variants with match(value).with(...).exhaustive() from ts-pattern (see agent-patterns/pattern-matching.md)."
    }
  },
  {
    pattern: "match(...).run() is banned",
    result: {
      kind: "mechanical",
      hint: "match(...).run() throws at runtime on unhandled states — terminate with .exhaustive() for closed unions or .otherwise() for open primitive types (see agent-patterns/pattern-matching.md)."
    }
  }
]

export const triageFailure = Effect.fn("Harness.triageFailure")(function* (
  failureOutput: string
) {
  for (const rule of DETERMINISTIC_TRIAGE_RULES) {
    if (failureOutput.includes(rule.pattern)) {
      return rule.result
    }
  }

  const outcome = yield* DecisionModel.decide(TriageV1, { input: { failureOutput } }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone)
  )

  if (Option.isNone(outcome)) {
    return {
      kind: "semantic" as const,
      hint: "Inspect failing test and Effect graph neighborhood via harness_tests_reaching / harness_callees."
    }
  }

  const { answers } = outcome.value
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "TriageV1",
    "decision.kind": answers.kind.label
  })

  if (answers.kind.label === "mechanical") {
    return {
      kind: "mechanical" as const,
      hint: "Mechanical error identified by decision model; inspect syntax, types, or configuration."
    }
  }

  return {
    kind: "semantic" as const,
    hint: "Inspect failing test and Effect graph neighborhood via harness_tests_reaching / harness_callees."
  }
})
