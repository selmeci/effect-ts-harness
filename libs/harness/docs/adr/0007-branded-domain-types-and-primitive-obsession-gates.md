---
id: harness:ADR-0007
title: "Two-Layer Branded Type Enforcement (oxlint AST + TypeScript TypeChecker '~effect/Brand' Graph Policy)"
status: accepted
date: 2026-10-31
enforced_by:
  - tools/oxlint/syntax-bans.js
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/decision/src/idiom-router.ts
  - libs/harness/decision/src/triage-decision.ts
spans:
  - Harness.routeStep
  - Harness.triageFailure
  - Album.decide
  - Sample.uploadPhoto
  - Sample.getPhotoById
services:
  - PhotoRepo
  - AlbumCounterClient
errors:
  - PhotoNotFoundError
  - AlbumQuotaExceededError
---

# ADR-0007: Two-Layer Branded Type Enforcement (`oxlint` AST + TypeScript `TypeChecker` `"~effect/Brand"` Graph Policy)

## Context and Problem Statement

In TypeScript's structural type system, unbranded primitives (`string`, `number`, `boolean`) and decode-only Effect schemas (`Schema.Int`, `Schema.Natural`, `Schema.NonEmptyString`) widen to plain `number` or `string` in their decoded TypeScript `Type` channel (`typeof Schema.Int.Type` is `number`). Without compile-time nominal branding via `.pipe(Schema.brand("BrandName"))` or `Brand.Branded<A, "BrandName">`, two failure modes repeatedly escape to runtime:

1. **Identifier & Quantity Transposition:** Functions accepting multiple structurally identical parameters (such as `(userId: string, albumId: string)` or `(photoId: number, currentCount: number)`) allow callers to swap arguments without a compiler error.
2. **In-Memory Bypass of Boundary Refinements:** Because `typeof Schema.Natural.Type` is plain `number`, in-memory domain code can pass `-1` or `3.14` to a function expecting a non-negative integer unless the schema carries a compile-time `Brand`.

We need a deterministic enforcement architecture that prevents raw primitive type definitions, unbranded contract schemas, unbranded service/domain function boundaries, and unsafe `as <BrandedType>` casts across the workspace.

## Decision Drivers

- Decode-only schemas (`Schema.Int`, `Schema.Natural`, `Schema.NonEmptyString`) must never masquerade as compile-time nominal types in `type:contract`, `type:service`, or `type:domain`.
- Developers and autonomous agents must receive sub-second actionable feedback during file edits (`PostToolUse` / `oxlint`) explaining how to apply `Schema.brand("BrandName")`.
- Cross-file type aliases and imported schemas that omit `"~effect/Brand"` must be caught deterministically during `harness plan-check` and `harness verify` even when the AST at the call site only references an identifier name.
- Finite literal discriminants (`_tag: "Created"`) and `void` effects must not trigger false positives.

## Considered Options

- **Option 1:** Two-Layer Gate (`oxlint` AST Syntax Bans + Type-Aware `ts-morph` `"~effect/Brand"` Graph Policy) with Deterministic Routing and Triage.
- **Option 2:** AST-Only Linting (`tools/oxlint/syntax-bans.js`) Based Solely on Identifier Naming Regexes.
- **Option 3:** Runtime Wrapper Classes (`new ValueObject(raw)`) Instead of Zero-Cost Effect `Schema.brand` Phantom Brands.

## Decision Outcome

**Chosen option:** "Two-Layer Gate (`oxlint` AST Syntax Bans + Type-Aware `ts-morph` `"~effect/Brand"` Graph Policy) with Deterministic Routing and Triage", because combining fast AST syntax checks with TypeScript `TypeChecker` inspection of Effect's `"~effect/Brand"` phantom property provides instant editor/hook guidance while guaranteeing that no unbranded `string` or `number` crosses `type:contract`, `type:service`, or `type:domain` boundaries via imported aliases.

We enforce the following architectural rules:

1. **Contract Schema Branding (`type:contract`):** Every exported scalar schema and every domain field in `Schema.Struct` (including piped structs), `Schema.Class`, `Schema.TaggedStruct`, `Schema.TaggedClass`, `Schema.TaggedUnion`, and `Schema.TaggedError` must carry a compile-time brand via `.pipe(Schema.brand("BrandName"))` or `Schema.fromBrand(...)`. A brand key is owned by one canonical schema; wire-format adapters (such as URL path strings) compose into the canonical branded schema via `Schema.decodeTo(<BrandedSchema>)` rather than re-branding a wider primitive schema.
2. **Service and Domain Boundary Branding & Ban on Inline Object Types (`type:service` & `type:domain`):** All `Context.Service` method parameters/outputs and all exported `Effect.fn` / `stub<A, E, R>` parameters/outputs (except `void` / `never` and finite literal unions) must resolve to named contract schemas/types whose scalars carry `"~effect/Brand"`. Inline object type literals (`{ ... }`), `any`, and `unknown` at boundaries or in `type X = { ... }` aliases are banned so every structured payload is defined via `Schema` and derived via `typeof <Schema>.Type`.
3. **Ban on Raw Type Aliases and Unsafe Brand Casts:** Raw primitive type aliases (`type Id = string`) and unsafe `as <BrandedType>` type assertions are banned in production code; values must be decoded at boundaries (`Schema.decodeUnknownEffect`) or constructed via Effect v4 validated constructors (`<Schema>.make(val)`, `Brand.make(filter)`, `Brand.check(...)`, or `Brand.nominal<T>()`).

## Rejected Alternatives

### 1 · AST-Only Linting (`tools/oxlint/syntax-bans.js`) Based Solely on Identifier Naming Regexes

Relying only on untyped AST rules in `oxlint` to inspect property names (`*Id`, `*Count`) and type annotations.

- **Why rejected:** An untyped AST rule cannot inspect the resolved type of an imported schema or type alias across files. If a developer defines `export const AlbumId = Schema.NonEmptyString` (forgetting `.pipe(Schema.brand("AlbumId"))`) and uses `albumId: AlbumId` in another file, an AST-only check sees the identifier `AlbumId` and misses that `typeof AlbumId.Type` is still an unbranded `string`.

### 2 · Runtime Wrapper Classes (`new ValueObject(raw)`) Instead of Zero-Cost Effect `Schema.brand` Phantom Brands

Wrapping every identifier, count, and timestamp in a runtime class instance (`class PhotoId { constructor(readonly value: number) {} }`).

- **Why rejected:** Runtime wrapper objects allocate heap memory for every scalar field, break direct SQLite/JSON serialization without custom transformers on every field, and conflict with Effect v4's zero-cost `Brand<K>` intersection model (`T & Brand<K>`), which preserves the underlying primitive representation at runtime.

## Consequences and Enforcement

### Positive Consequences

- Compile-time nominal type safety across all aggregate IDs, quantities, counts, timestamps, and domain strings with zero runtime allocation overhead.
- Immediate remediation hints in `oxlint`, `checkEffectGraph`, and `Harness.triageFailure` guiding agents directly to `Schema.brand` and `agent-patterns/schema.md`.
- Full alignment between `plan-check` skeletons (`stub<A, E, R>()`) and production implementations.

### Negative Consequences and Trade-offs

- Constructing domain values in tests and in-memory adapters requires calling `<BrandSchema>.make(value)` or `Schema.decodeSync(<StructSchema>)(raw)` rather than passing bare string or number literals directly to typed domain functions.

### Deterministic Enforcement

| Rule                                                                                                                 | Enforced By                                                                                 | Gate / Mechanism                                    | Governed Symbols                                            |
| :------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ | :-------------------------------------------------- | :---------------------------------------------------------- |
| Ban raw primitive type aliases, unbranded contract schemas, raw primitive boundary annotations, and `as Brand` casts | `tools/oxlint/syntax-bans.js`                                                               | `harness/syntax-bans` (`oxlint --deny-warnings`)    | `Album.decide`, `Sample.uploadPhoto`, `Sample.getPhotoById` |
| Verify `"~effect/Brand"` presence on `type:contract` schemas and struct/error fields                                 | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/policy-check.ts`        | `checkEffectGraph` (`unbranded-contract-schema`)    | `PhotoNotFoundError`, `AlbumQuotaExceededError`             |
| Verify `"~effect/Brand"` presence on `type:service` and `type:domain` parameters, success channels, and `as` casts   | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/policy-check.ts`        | `checkEffectGraph` (`unbranded-primitive-boundary`) | `PhotoRepo`, `AlbumCounterClient`, `Album.decide`           |
| Deterministically route and triage branded type steps and failures to `agent-patterns/schema.md`                     | `libs/harness/decision/src/idiom-router.ts`, `libs/harness/decision/src/triage-decision.ts` | `Harness.routeStep`, `Harness.triageFailure`        | `Harness.routeStep`, `Harness.triageFailure`                |
