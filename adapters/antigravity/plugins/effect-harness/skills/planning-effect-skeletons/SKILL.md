---
name: planning-effect-skeletons
description: Use when translating requirements or EARS specifications into a technical plan in an Effect-TS project, before writing implementation bodies or tests.
---

# Planning Effect Skeletons (Plan-as-Code)

## Overview

In this project, the plan IS compilable TypeScript code. Never write long Markdown files containing unverified code blocks. Instead, translate EARS clauses directly into `type:contract` Schemas, `type:service` interfaces, and `stub<A, E, R>(...args)` skeletons in `.ts` files, then verify the topology with `harness plan-check`.

**Violating the letter of the rules is violating the spirit of the rules.**

## Step-by-Step Recipe

1. **Three-Tier Discovery, Idiom Routing & Bounded Doc Reads:** Before writing `.ts` stubs:
   - **Tier 3 (`harness_doc_tree` — PageIndex-lite):** Read the triggering EARS spec outline first (`harness_doc_tree({ mode: "tree", path })`), then pull bounded sections (`mode: "section", sectionId`) for `spans`, `services`, `errors`, `informed_by`, and clauses; inspect `harness_doc_tree({ mode: "catalog", scope? })` (e.g. `scope: "harness"`, or omit for all scopes) instead of dumping full 300+ line ADRs.
   - **Tier 2 (`harness_search_knowledge` & `harness_route` — Hybrid Retrieval):** Call `harness_search_knowledge({ query, kinds?: ("PatternDoc" | "AdrDoc" | "EarsRequirement")[], status?: "accepted" | "proposed" | "superseded" | "deprecated", limit? })` to recall relevant clauses + hydrated `linkedSymbols`. Call `harness_route({ planStep })` (`patternFile`, `candidatePatterns`, `"planning"` block + `clef-flash`) for each non-trivial capability and read long `agent-patterns/*.md` via `tree`/`section`.
   - **Tier 1 (`harness_resolve` & Ontology — Code Graph):** Call `harness_resolve({ symbolOrSpan })` on uncertain symbols (using fuzzy `suggestions` on miss; fall back to `harness_structural_search` / `harness_gq_query` only if both `suggestions` and `linkedSymbols` miss), then `harness_ontology_why({ symbolOrSpan })` and `harness_ontology_impact({ symbolOrSpan })` to trace `ADR <-informed_by- EarsSpec -> EffectFn` before modifying services/barrels. Use `harness_lsp_diagnostics({ filePath | project })` for fast typechecks on stubs.
2. **Define Boundary Types (`type:contract` & `type:service` — Enforced by `HarnessTierTopology.decide`):**
   - **Single Canonical `type:*` Tag (`dual-contract-tier-tag`):** Every workspace package declares exactly one `type:*` Nx tag (`type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, or `type:app`) — dual `["type:contract", "type:service"]` tags are strictly banned.
   - `WHEN <trigger>` $\rightarrow$ Request/response `Schema.Struct` and `HttpApiEndpoint` / `Rpc` in `type:contract` (`0` workspace dependencies, external `effect` only; `forbidden-contract-dependency`).
   - `IF <condition>, THEN` $\rightarrow$ `Schema.TaggedError<Self>()("Tag", { ... })` in `type:contract`.
   - `WHILE <state>` $\rightarrow$ Closed discriminated unions (`Schema.TaggedUnion` / `Schema.TaggedStruct`) for domain states and decisions in `type:contract` (`agent-patterns/pattern-matching.md`).
   - Stateful capabilities $\rightarrow$ Pure `Context.Service` ports in `type:service` (`forbidden-service-dependency`, `impure-service-tier-import`: `type:service` imports `effect`, `type:contract`, and `type:service` only — constructing `Layer.*` values, importing `node:*`, or importing `type:core`/`type:domain`/`type:infra` inside `type:service` is strictly banned).
3. **Write `stub<A, E, R>()` Skeletons (`type:core`, `type:domain` & `type:infra` — Enforced by `SelfDogfooding.decide`):**
   - `WHILE <state>` $\rightarrow$ Pure decider `Effect.fn("<Domain>.decide")` in `type:domain` / `type:core` returning `yield* stub<Out, Err, never>(input)` (`R = never` is mandatory).
   - `WHEN <trigger>` $\rightarrow$ Use case / engine `Effect.fn("<Domain>.<useCase>")` in `type:domain` / `type:core` / `type:infra` returning `yield* stub<A, E, R>(input)` with exact union types for `E` and `R`.
   - **Hexagonal Purity in Non-Infra Tiers (`no-node-builtins-outside-infra`, `process-env-outside-infra-or-app`, `no-global-mutable-cache`, `impure-core-tier-import`):** Outside `type:infra` (`libs/*/infra/src/`), `node:*` built-in imports (except `{path, path/posix, path/win32, crypto, url}` — also enforced on `type:app`) and `FetchHttpClient` / `@effect/ai-typesafe` / `@effect/platform*` imports are banned. `process.env` is banned outside `type:infra` and `type:app`, and module-scope mutable caches (`let`, module-scope `Map`/`Set`/`WeakMap`, or mutated module-scope object literals) are banned across all production `src/` files.
4. **Run the Deterministic Plan Gate:**
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```
   Fix any type error, duplicate span name, or `GraphPolicyViolation` (`domain-requires-infra`, `domain-requires-cloud-binding`, `impure-decider`, `layer-cycle`, `discriminant-branching`, `non-exhaustive-union-match`, `unmapped-spec-symbol` — verifying that every `span`, `service`, and `error` in the EARS spec frontmatter is represented in the `.ts` skeleton graph) until `plan-check` exits `0` and prints the Mermaid graph.
5. **Pre-Implementation Adversarial & Feasibility Lens (for stateful or multi-package plans):** After `harness plan-check` exits `0` and prints the Mermaid graph, audit the skeleton graph against failure modes before dispatching implementers using the [Pre-Implementation Adversarial Plan Lens](references/adversarial-plan-lens.md) (or dispatching [@effect-adversarial-reviewer](../../executing-effect-stubs/references/personas/adversarial-reviewer.md)): verify idempotency keys are present in contract inputs, partial-failure compensation between DO/D1/Queue is represented in `E` and `R`, optimistic concurrency error channels are declared, and no domain `*.decide` function depends on impure services. For reviewer dispatch instructions and personas across all stages, consult the [Reviewer Dispatch Guide](../../executing-effect-stubs/references/dispatch-reviewers.md).
6. **Enforce Phase-Strict Scope, 5-Tier Hexagonal Topology & Doc-to-Code Parity Checklist:**
   - **5-Tier Hexagonal Topology (`HarnessTierTopology.decide`):** Single canonical `type:*` tag per package (`dual-contract-tier-tag`), `0` workspace dependencies on `type:contract` (`forbidden-contract-dependency`), zero `Layer.*` or `node:*` imports in `type:service` (`impure-service-tier-import`), and every `@harness/*` import in `src/` declared in `package.json` `dependencies` (`undeclared-workspace-dependency`).
   - **Self-Dogfooding Hygiene (`SelfDogfooding.decide`):** Zero `export * from` in `libs/**/src/index.ts` or `apps/**/src/index.ts` barrels (`facade-star-reexport` — use explicit named exports), zero dynamic `import("@harness/...")` (`dynamic-harness-import`), zero `Layer.build` inside `Layer.effect` (`no-layer-build-in-layer-effect`), and zero double-wrapped `Effect.fn` around `Effect.gen` (`no-double-wrapped-effect-fn`).
   - **No Future-Phase Leakage:** Never copy unimplemented future-phase symbols (e.g., `DeciderInvariantError`, `commandId` idempotency deduplication, partial event matching, or unconfigured `scope:fixture` Nx tags) into the current phase's EARS Spec or ADR.
   - **1:1 Symbol Parity:** Every method name (e.g. `.thenEvents`, `.thenNothing`, `.thenFails`), every `*Error` in prose or Mermaid diagrams, and every Nx tag in the Spec/ADR must match the current skeleton 1:1.
   - **No Empty Source Modules (`empty-source-module` gate):** Never leave placeholder `export {}` files in `src/`.
   - **Clean Dependency Manifests (`unused-package-dependency` gate):** Never leave unused dependencies in `package.json` `dependencies`. Move `@harness/contract` (when only used for `stub()`) to `devDependencies` once implementation replaces `stub()`.
7. **Specify Adversarial & Negative Test Matrix in the Plan:**
   - **Contract Schemas (`type:contract`):** Plan both positive decode tests and negative rejection tests (`-1`, `1.5`, `""`, missing fields) for all constrained schemas (`Schema.Int`, `Schema.Natural`, `PositiveInt`, `NonEmptyString`). Clarify that `Schema.Int`/`Schema.Natural` are decode-time checks whose TypeScript type is `number`; add `.pipe(Schema.brand("..."))` when compile-time branding is needed for in-memory construction.
   - **BDD / Test Runners (`testing.ts` in `type:core`):**
     - Compare values strictly with `Equal.equals(actual, expected)` — never add a `JSON.stringify(a) === JSON.stringify(b)` fallback (`fallback-json-equality` gate).
     - Require an explicit expected error instance or predicate in `.thenFails(expectedError)` — never make the error parameter optional (`vacuous-error-assertion` gate).
     - Plan negative meta-tests using a fake failing decider that verify the BDD runner itself fails (`Exit.isFailure` / `Cause.isDie`) on wrong event count, wrong event payload, unexpected success, and defect vs. typed `Fail` (`guard-condition` mutation gate).
   - **Decider / Reducer Property-Based Tests:**
     - Never write scalar-only property tests (`[PositiveInt, PositiveInt]`) that only fold hardcoded happy-path events (`shallow-decider-property-test` gate).
     - Always generate `Schema.Array(EventUnionSchema)` (covering empty streams, terminal events like `CheckedOut`, and post-terminal events) and assert chunked fold equivalence (`events.slice(0, k)` + `events.slice(k)` folded sequentially equals folding `events` at once).
8. **Update Spec and Record ADR (Spec & ADR Governance):**
   - **Update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`:** Append the verified Mermaid topology diagram printed by `harness plan-check` under `## 4. Verified Plan Topology Graph` and record the Pre-Implementation Adversarial Plan Lens summary checklist.
   - **Record Architectural Decisions (ADR):** If the planning phase decided a non-obvious architectural trade-off, boundary constraint, or rejected alternative meeting the **Counterfactual Eligibility Rule** (_"If this ADR did not exist, would a future engineer or autonomous agent reading the final code, types, and tests still be likely to repeat a rejected mistake, violate a hidden runtime constraint, or re-litigate this architectural trade-off?"_), author an ADR in `libs/<scope>/docs/adr/NNNN-<slug>.md` (with scoped `id: <scope>:ADR-NNNN`, or in root `docs/adr/` if workspace-wide) following the [ADR Authoring Guidelines & Canonical Template](references/adr-guidelines.md).
   - **Canonical 6-Section MADR Structure (Enforced by `AdrDocLint.decide`):**
     1. `## Context and Problem Statement` (current forces, runtime constraints, and what breaks if left undecided)
     2. `## Decision Drivers` (at least 2 `*` bullets naming non-negotiable constraints)
     3. `## Considered Options` (at least 2 `* **Option N:**` entries)
     4. `## Decision Outcome` (must open with `**Chosen option:** "<Option Name>"`, followed by binding architectural rules)
     5. `## Rejected Alternatives` (numbered `### N · <Option Name>` subsections with middle dot `·`, each opening with `**Why rejected:** <concrete failure mode or constraint violation>`)
     6. `## Consequences and Enforcement` (containing `### Positive Consequences`, `### Negative Consequences and Trade-offs`, and `### Deterministic Enforcement` with the 4-column table `| Rule | Enforced By | Gate / Mechanism | Governed Symbols |`)
   - **Parser-Safe Frontmatter & Omnigraph Links:** Include `id`, `title`, `status: accepted`, `date`, `enforced_by` (at least 1 existing repo file), and at least one of `spans:`, `services:`, or `errors:` to establish `GovernsSymbol` edges in Omnigraph.
   - **Verify Governance Docs with Deterministic Gate:** Run `gc --strict` and `ontology check --strict` (or MCP `harness_ontology_check`) to verify both EARS specs (`EarsSpecLint.decide`), ADRs (`AdrDocLint.decide` and `stale-doc-reference`), deterministic cross-layer ArchiMate invariants (`OntologyInvariants.decide`), and semantic conflict detection (`OntologyConflictV1`):
     ```bash
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
     ```

## Skeleton Example

```ts
import { Effect } from "effect"
import { stub } from "@harness/contract"
import { PhotoNotFoundError } from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"

export const decideAlbumDecrement = Effect.fn("AlbumDecrement.decide")(function* (input: {
  readonly currentCount: number
}) {
  return yield* stub<number, never, never>(input)
})

export const deletePhoto = Effect.fn("Sample.deletePhoto")(function* (id: number) {
  return yield* stub<void, PhotoNotFoundError, PhotoRepo | AlbumCounterClient>(id)
})
```

## Phase-Strict Scope, 5-Tier Hexagonal Topology & Doc-to-Code Parity Checklist

- [ ] **5-Tier Hexagonal Topology (`HarnessTierTopology.decide`):** Single canonical `type:*` tag per package (`dual-contract-tier-tag`), `0` workspace dependencies on `type:contract` (`forbidden-contract-dependency`), zero `Layer.*` or `node:*` imports in `type:service` (`impure-service-tier-import`), and all `@harness/*` imports declared in `package.json` `dependencies` (`undeclared-workspace-dependency`).
- [ ] **Self-Dogfooding Hygiene (`SelfDogfooding.decide`):** Zero `node:*` imports outside `type:infra` except `{path, path/posix, path/win32, crypto, url}` (`no-node-builtins-outside-infra`), zero `process.env` outside `type:infra`/`type:app` (`process-env-outside-infra-or-app`), zero module-scope mutable `let`/`Map`/`Set` caches (`no-global-mutable-cache`), and explicit named exports on all `index.ts` barrels (`facade-star-reexport` — no `export *`).
- [ ] **No Future-Phase Leakage:** Unimplemented future-phase symbols (`DeciderInvariantError`, `commandId` deduplication, partial event matching, unconfigured `scope:fixture` Nx tags) are omitted from current Spec and ADR.
- [ ] **Exact Symbol Parity:** Every method name (`.thenEvents`, `.thenNothing`, `.thenFails`), every `*Error` in prose/Mermaid diagrams, and every Nx tag matches the current skeleton 1:1.
- [ ] **No Empty Modules (`empty-source-module`):** Zero placeholder `export {}` files in `src/`.
- [ ] **Clean Dependencies (`unused-package-dependency`):** `@harness/contract` (when only used for `stub()`) in `devDependencies`, no unused runtime dependencies.

## Adversarial & Negative Test Matrix Checklist

- [ ] **Contract Schemas:** Decode-time checks (`Schema.Int`, `Schema.Natural`) paired with `.pipe(Schema.brand("..."))` for compile-time branding; positive decode tests and negative rejection tests (`-1`, `1.5`, `""`, missing fields).
- [ ] **BDD / Test Runners:** Values compared strictly with `Equal.equals` (no `JSON.stringify` fallback, `fallback-json-equality`); mandatory explicit expected error in `.thenFails(expectedError)` (`vacuous-error-assertion`); negative meta-tests with fake failing decider (`guard-condition`).
- [ ] **Decider Property Tests:** `Schema.Array(EventUnionSchema)` generated (empty streams, terminal states, post-terminal events); chunked fold equivalence asserted (no scalar-only property tests, `shallow-decider-property-test`).

## Rationalization Table

| Excuse                                                                             | Reality                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "I'll dump whole 350-line ADRs and specs via read_file before checking sections"   | Full-file reads waste scarce context window. Use `harness_search_knowledge` for semantic recall + hydrated symbols and `harness_doc_tree({ mode: "tree"                              | "section", path, sectionId })`to read only`Decision Outcome` / enforcement sections. |
| "My symbol name missed in harness_resolve, so I'll grep the whole workspace"       | `harness_resolve({ symbolOrSpan })` already returns top fuzzy `suggestions` on miss, and `harness_search_knowledge` returns `linkedSymbols`. Inspect those first.                    |
| "I'll write the plan in a `.md` file with code blocks first"                       | Uncompiled Markdown code drifts from `effect@4.0.0` types and burns 2x tokens. Write `.ts` skeletons with `stub<A, E, R>()` instead.                                                 |
| "I'll use `Effect.die('TODO')` instead of `stub<A, E, R>()`"                       | `Effect.die` erases `A`, `E`, and `R` to `never`, blinding `effect-graph:check`. Always use `stub<A, E, R>(...args)`.                                                                |
| "I'll put a default `Layer.succeed` in `type:service` or use dual `type:*` tags"   | `HarnessTierTopology.decide` rejects `Layer.*` or `node:*` in `type:service` (`impure-service-tier-import`) and rejects multiple `type:*` tags (`dual-contract-tier-tag`).           |
| "I'll use `export * from` in `src/index.ts` barrels to save time"                  | `SelfDogfooding.decide` rejects `export *` across all `libs/**/src/index.ts` and `apps/**/src/index.ts` barrels (`facade-star-reexport`). Always use explicit named exports.         |
| "This feature is small, I'll skip `plan-check` and write the body directly"        | `plan-check` snapshots `.harness/plan-graph-snapshot.json` required by `harness done` to verify plan-vs-impl parity.                                                                 |
| "I don't need to append the Mermaid graph or record ADRs in docs/"                 | Omitting the verified topology graph from `libs/<scope>/docs/specs/` deprives reviewer agents of ground truth. ADRs prevent future agents from re-litigating non-obvious trade-offs. |
| "I'll document future phase errors and commands in the ADR now so we don't forget" | Unimplemented symbols in specs/ADRs violate doc-to-code parity and fail `stale-doc-reference`. Document only what exists in the current phase skeleton.                              |
| "I'll add JSON.stringify fallback to BDD assertions for convenience"               | JSON stringification masks class prototype mismatch and non-enumerable properties (`fallback-json-equality`). Always use strict `Equal.equals(a, b)`.                                |
| "A simple scalar property test [PositiveInt, PositiveInt] is enough for deciders"  | Scalar tests only fold happy paths and miss boundary bugs (`shallow-decider-property-test`). Always generate `Schema.Array(EventUnion)` and test chunked fold equivalence.           |

## Red Flags — STOP

- Bulk-reading full 300+ line ADRs/specs or grepping blindly before calling `harness_search_knowledge`, `harness_doc_tree` (`catalog`/`tree`/`section`), `harness_route`, and `harness_resolve` (with fuzzy `suggestions`)
- Creating a `.md` plan with multi-line TypeScript code blocks instead of `.ts` `stub<A, E, R>()` skeletons
- Writing production `Effect.gen` bodies before `harness plan-check` exits `0`
- Adding `RequiresService` dependencies to a `*.decide` function (`impure-decider`)
- Constructing `Layer.*` values or importing `node:*` inside `type:service` (`impure-service-tier-import`), or declaring `0` or `>1` `type:*` tags on a package (`dual-contract-tier-tag`)
- Importing `node:*` (other than `path`, `crypto`, `url`) outside `type:infra` (`no-node-builtins-outside-infra`), reading `process.env` outside `type:infra`/`type:app` (`process-env-outside-infra-or-app`), declaring module-scope mutable `let`/`Map`/`Set` caches (`no-global-mutable-cache`), or using `export *` in `index.ts` barrels (`facade-star-reexport`)
- Skipping updating `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` with the verified Mermaid graph and adversarial lens summary after `plan-check`
- Creating an ADR that violates the canonical 6-section structure or omitting `**Chosen option:**` / `**Why rejected:**`
- Leaking future-phase symbols or unconfigured Nx tags into current phase specs/ADRs (`stale-doc-reference`)
- Leaving empty placeholder modules (`export {}`) in `src/` (`empty-source-module`) or unused dependencies in `package.json` (`unused-package-dependency`)
- Using `JSON.stringify` fallback equality in BDD runners (`fallback-json-equality`)
- Omitting explicit expected error parameter in `.thenFails(expectedError)` (`vacuous-error-assertion`)
- Writing scalar-only property tests for deciders without `Schema.Array(EventUnion)` chunked-fold invariants (`shallow-decider-property-test`)

**REQUIRED NEXT SKILL:** Once `harness plan-check` exits `0`, outputs the Mermaid graph, and updates the spec, use `executing-effect-stubs`.
