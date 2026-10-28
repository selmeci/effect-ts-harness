---
id: harness:ADR-0002
title: "Exhaustive Pattern Matching with ts-pattern and Closed Discriminated Unions"
status: accepted
date: 2026-10-28
enforced_by:
  - tools/oxlint/syntax-bans.js
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/policy-check.ts
spans:
  - Album.decide
  - SampleInfra.handleAlbumCounterRpc
services:
  - PhotoRepo
errors:
  - AlbumQuotaExceededError
---

# ADR-0002: Exhaustive Pattern Matching with `ts-pattern` and Closed Discriminated Unions

## Context and Problem Statement

Imperative branching constructs (`switch` statements, multi-branch `if / else if` chains, and `if / else` or ternary checks on union discriminant properties) routinely hide unhandled domain states until runtime. When a new variant is added to a union type (`Schema.TaggedUnion`, `Schema.TaggedClass`, `Option`, `Either`, or `Result`), an `if (state._tag === "Active") { ... } else { ... }` silently absorbs the new variant into the `else` branch instead of failing compilation. We need a deterministic, two-layer enforcement mechanism that makes `ts-pattern` (`match(value).with(...).exhaustive()`) and closed discriminated unions the primary control-flow citizens of the harness.

## Decision Drivers

- Unhandled union variants must fail at compile time (`NonExhaustiveError`) rather than escaping to production runtime.
- Even binary (2-variant) discriminated unions (`Option`, `Either`, `Result`, or 2-member `Schema.TaggedUnion` types) must enumerate every state explicitly so adding a 3rd variant forces a compiler error at every call site.
- `.otherwise()` must remain available for genuinely open/infinite types (`number`, `string`, `unknown`) and single-struct guard refinements (`P.when`), while being strictly banned on closed discriminated unions.
- Simple non-union `if / else` checks (such as numeric bounds or empty-array checks) must remain ergonomic without false-positive lint noise.

## Considered Options

1. **Two-Layer Gate (`oxlint` AST + Type-Aware `ts-morph` Graph Policy) with `ts-pattern`** — Combine sub-second AST checks in `tools/oxlint/syntax-bans.js` with TypeScript `TypeChecker` union inspection in `libs/harness/graph/src/type-extractor.ts` and `checkEffectGraph`.
2. **AST-Only Linting (`tools/oxlint/syntax-bans.js`)** — Inspect syntax nodes only without TypeScript `TypeChecker` union resolution.
3. **`Effect.Match` Only without `ts-pattern`** — Use `Effect.Match` from `effect/Match` without `ts-pattern` structural tuple/nested pattern matching.

## Decision Outcome

**Chosen option:** "Two-Layer Gate (`oxlint` AST + Type-Aware `ts-morph` Graph Policy) with `ts-pattern`", because `oxlint` gives instant feedback in `PostToolUse` on `switch`, `else-if`, `match(...).run()`, and known tag guards (`_tag`, `Option.isSome`), while the `ts-morph` `TypeChecker` pass in `checkEffectGraph` catches custom union discriminant properties (`plan.tier === "free"`) and `.otherwise()` on closed union types (`non-exhaustive-union-match`) with zero false positives on open primitives.

## Rejected Alternatives

### 1 · AST-Only Linting (`tools/oxlint/syntax-bans.js`)

 Relying solely on untyped AST rules in `oxlint` to detect union branching and `.otherwise()` misuse.

- **Why rejected:** An untyped AST walker cannot know whether `x.tier === "free"` narrows a TypeScript union or compares a plain `string` property on a single struct, nor can it distinguish `match(closedUnion).otherwise(...)` from `match(statusCodeNumber).otherwise(...)` when patterns do not mention `_tag`.

### 2 · `Effect.Match` Only without `ts-pattern`

 Restricting pattern matching to `Effect.Match` instead of `ts-pattern`.

- **Why rejected:** The user and harness architecture explicitly standardize on `ts-pattern` (`match(value).with(...).exhaustive()`, `P.union`, `P.select`, `P.when`) for concise deep structural and tuple matching across domain deciders, infrastructure handlers, and UI state.

## Consequences and Enforcement

### Positive Consequences

- Every closed union state transition is statically proven exhaustive via `.exhaustive()`.
- Binary unions (`Option`, `Either`, 2-state domain unions) explicitly list both states, making future state additions compile-time safe.
- `IdiomRouterV1` and `DETERMINISTIC_TRIAGE_RULES` automatically route and triage branching violations to `agent-patterns/pattern-matching.md`.

### Negative Consequences and Trade-offs

- Inside `Effect.fn` / `Effect.gen`, `.with(pattern, handler)` callbacks cannot contain `yield*` directly; each branch must return an `Effect` (or yieldable `TaggedError`) and be yielded once via `return yield* match(...)...exhaustive()`.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Ban `switch`, `if / else if`, `match().run()`, and known discriminant `if` / ternary (`_tag`, `Option.isSome`) | `tools/oxlint/syntax-bans.js` | `harness/syntax-bans` (`oxlint --deny-warnings`) | `Album.decide`, `SampleInfra.handleAlbumCounterRpc` |
| Ban `if` / ternary narrowing any TypeScript union via literal discriminant property | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/policy-check.ts` | `checkEffectGraph` (`discriminant-branching`) | `Album.decide`, `PhotoRepo` |
| Ban `.otherwise()` when `match(arg)` inspects a closed finite union | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/policy-check.ts` | `checkEffectGraph` (`non-exhaustive-union-match`) | `SampleInfra.handleAlbumCounterRpc`, `AlbumQuotaExceededError` |
