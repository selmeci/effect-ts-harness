---
name: planning-effect-skeletons
description: Use when translating requirements or EARS specifications into a technical plan in an Effect-TS project, before writing implementation bodies or tests.
---

# Planning Effect Skeletons (Plan-as-Code)

## Overview

In this project, the plan IS compilable TypeScript code. Never write long Markdown files containing unverified code blocks. Instead, translate EARS clauses directly into `type:contract` Schemas, `type:service` interfaces, and `stub<A, E, R>(...args)` skeletons in `.ts` files, then verify the topology with `harness plan-check`.

**Violating the letter of the rules is violating the spirit of the rules.**

## Step-by-Step Recipe

1. **Route Idioms & Inspect Ontology:** Call `harness_route` for each non-trivial capability (e.g., D1, Durable Object RPC, `HttpApi`, `AtomHttpApi`) and read the matched `agent-patterns/*.md` file. For any existing services or use-cases being modified, call `harness_ontology_why` and `harness_ontology_impact` to inspect cross-layer ArchiMate dependencies and governing ADR/EARS constraints.
2. **Define Boundary Types (`type:contract` & `type:service`):**
   - `WHEN <trigger>` $\rightarrow$ Request/response `Schema.Struct` and `HttpApiEndpoint` / `Rpc` in `type:contract`.
   - `IF <condition>, THEN` $\rightarrow$ `Schema.TaggedErrorClass` in `type:contract`.
   - `WHILE <state>` $\rightarrow$ Closed discriminated unions (`Schema.TaggedUnion` / `Schema.TaggedStruct`) for domain states and decisions in `type:contract` (`agent-patterns/pattern-matching.md`).
   - Stateful capabilities $\rightarrow$ `Context.Service` methods in `type:service`.
3. **Write `stub<A, E, R>()` Skeletons (`type:domain` & `type:infra`):**
   - `WHILE <state>` $\rightarrow$ Pure decider `Effect.fn("<Domain>.decide")` returning `yield* stub<Out, Err, never>(input)` (`R = never` is mandatory).
   - `WHEN <trigger>` $\rightarrow$ Use case `Effect.fn("<Domain>.<useCase>")` returning `yield* stub<A, E, R>(input)` with exact union types for `E` and `R`.
4. **Run the Deterministic Plan Gate:**
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```
   Fix any type error, duplicate span name, or `GraphPolicyViolation` (`domain-requires-infra`, `domain-requires-cloud-binding`, `impure-decider`, `layer-cycle`, `discriminant-branching`, `non-exhaustive-union-match`, `unmapped-spec-symbol` — verifying that every `span`, `service`, and `error` in the EARS spec frontmatter is represented in the `.ts` skeleton graph) until `plan-check` exits `0` and prints the Mermaid graph.
5. **Pre-Implementation Adversarial & Feasibility Lens (for stateful or multi-package plans):** After `harness plan-check` exits `0` and prints the Mermaid graph, audit the skeleton graph against failure modes before dispatching implementers using the [Pre-Implementation Adversarial Plan Lens](references/adversarial-plan-lens.md) (or dispatching [@effect-adversarial-reviewer](../../executing-effect-stubs/references/personas/adversarial-reviewer.md)): verify idempotency keys are present in contract inputs, partial-failure compensation between DO/D1/Queue is represented in `E` and `R`, optimistic concurrency error channels are declared, and no domain `*.decide` function depends on impure services. For reviewer dispatch instructions and personas across all stages, consult the [Reviewer Dispatch Guide](../../executing-effect-stubs/references/dispatch-reviewers.md).
6. **Update Spec and Record ADR (Spec & ADR Governance):**
   - **Update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`:** Append the verified Mermaid topology diagram printed by `harness plan-check` under `## 4. Verified Plan Topology Graph` and record the Pre-Implementation Adversarial Plan Lens summary checklist.
   - **Record Architectural Decisions (ADR):** If the planning phase decided a non-obvious architectural trade-off, boundary constraint, or rejected alternative meeting the **Counterfactual Eligibility Rule** (*"If this ADR did not exist, would a future engineer or autonomous agent reading the final code, types, and tests still be likely to repeat a rejected mistake, violate a hidden runtime constraint, or re-litigate this architectural trade-off?"*), author an ADR in `libs/<scope>/docs/adr/NNNN-<slug>.md` (with scoped `id: <scope>:ADR-NNNN`, or in root `docs/adr/` if workspace-wide) following the [ADR Authoring Guidelines & Canonical Template](references/adr-guidelines.md).
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
import { stub } from "@harness/gates"
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

## Rationalization Table

| Excuse | Reality |
|---|---|
| "I'll write the plan in a `.md` file with code blocks first" | Uncompiled Markdown code drifts from `effect@4.0.0` types and burns 2x tokens. Write `.ts` skeletons with `stub<A, E, R>()` instead. |
| "I'll use `Effect.die('TODO')` instead of `stub<A, E, R>()`" | `Effect.die` erases `A`, `E`, and `R` to `never`, blinding `effect-graph:check`. Always use `stub<A, E, R>(...args)`. |
| "This feature is small, I'll skip `plan-check` and write the body directly" | `plan-check` snapshots `.harness/plan-graph-snapshot.json` required by `harness done` to verify plan-vs-impl parity. |
| "I don't need to append the Mermaid graph or record ADRs in docs/" | Omitting the verified topology graph from `libs/<scope>/docs/specs/` deprives reviewer agents of ground truth. ADRs prevent future agents from re-litigating non-obvious trade-offs. |

## Red Flags — STOP

- Creating a `.md` plan with multi-line TypeScript code blocks instead of `.ts` `stub<A, E, R>()` skeletons
- Writing production `Effect.gen` bodies before `harness plan-check` exits `0`
- Adding `RequiresService` dependencies to a `*.decide` function (`impure-decider`)
- Skipping updating `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` with the verified Mermaid graph and adversarial lens summary after `plan-check`
- Creating an ADR that violates the canonical 6-section structure or omitting `**Chosen option:**` / `**Why rejected:**`

**REQUIRED NEXT SKILL:** Once `harness plan-check` exits `0`, outputs the Mermaid graph, and updates the spec, use `executing-effect-stubs`.
