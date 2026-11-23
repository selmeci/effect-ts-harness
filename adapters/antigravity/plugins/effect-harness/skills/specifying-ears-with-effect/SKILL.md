---
name: specifying-ears-with-effect
description: Use when starting any new feature, requirement, or behavior change before writing code or skeletons, especially when requirements are informal, incomplete, or lack EARS clauses.
---

# Specifying EARS with Effect

Turn informal feature requests into unambiguous **EARS (Easy Approach to Requirements Syntax)** specifications grounded in the Effect graph before writing code or skeletons.

**Violating the letter of the rules is violating the spirit of the rules.**

## Discovery & Interview Sequence

1. **Three-Tier Discovery & Archetype Check First:** Determine whether the repository/scope is an **application** (business domains in `type:domain`) or a **framework/library** (generic engines/protocols in `type:core`/`type:contract`; business entities like Cart/Inventory belong strictly to `test/fixtures/**` with `scope:fixture`). Before drafting or bulk-reading `.md` files:
   - Call `harness_doc_tree(mode: "catalog")` (omit `scope` when cross-cutting/root ADRs may apply, or pass `scope`) to list all existing `AdrDoc` and `EarsSpec` IDs, statuses, `informed_by` links, and determine the next `SPEC-NNNN` without running `ls` or reading files.
   - Call `harness_search_knowledge(query)` (optionally filtered by `kinds`, `status`, `limit`) to retrieve related `PatternDoc`, `AdrDoc`, and `EarsRequirement` clauses alongside their hydrated `linkedSymbols`.
   - When an existing ADR or spec needs deeper detail, call `harness_doc_tree(mode: "tree", path)` for its heading outline and `harness_doc_tree(mode: "section", path, sectionId)` for bounded slices — never bulk-read whole governance documents into context.
   - Call `harness_resolve` (inspecting its fuzzy `suggestions` on miss) and `harness_callers` on discovered/related domain symbols (`EffectFn`, `ServiceTag`, `TaggedError`), then call `harness_ontology_why` and `harness_ontology_impact` to trace existing ArchiMate layers (`Motivation -> Business -> Application -> Technology`) and `ADR <-informed_by- EarsSpec` chains.
2. **Apply Specificity Test & Clarify Ambiguities:** Point at the exact words in the user's prompt or graph before drafting requirements. If the source is silent and blocking, ask at most one targeted question per turn (or use `ask_question`). Never smuggle unprompted numbers, fields, or mechanisms into requirements; separate confirmed facts from `## Assumptions` and `## Out of scope`.
3. **Write EARS Requirements & Run 3-Role Review:** Draft requirements using the canonical template and rules in `references/ears-patterns.md`. Perform the 3-role review (Implementer, `@effect-ears-test-reviewer`, Source Author).
4. **Persist and Verify Specification:** Save the specification to `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (falling back to root `docs/specs/` only for cross-cutting tasks) with machine-verifiable YAML frontmatter (`id: <scope>:SPEC-NNNN`, `title`, `status: proposed` for the active Plan-as-Code task or `status: draft` for multi-wave backlog entries exempt from `INF-07` and `doc-missing-file-path` while still checked by `EarsSpecLint.decide`, `archetype: application` | `framework`, `date`, `informed_by`, `enforced_by`, `spans`, `services`, `errors`) linking governing `<scope>:ADR-NNNN` IDs discovered in step 1 (use `[]` or omit `informed_by` only if no existing ADR governs; `status: proposed` exempts planned unbuilt symbols from code-existence checks until `accepted`). Verify with `harness gc --strict` and run `harness_ontology_check` (or CLI `harness ontology check --scope=<scope> --strict`) to verify both deterministic cross-layer invariants (`OntologyInvariants.decide`) and hybrid `OntologyConflictV1` semantic conflict pairs (`SemanticConflictPairer.decide`).

## Output Contract (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`)

Every specification must follow this canonical template:

```markdown
---
id: <scope>:SPEC-NNNN
title: <Feature Title>
status: proposed
archetype: application # or: framework
date: YYYY-MM-DD
informed_by:
  - <scope>:ADR-NNNN
enforced_by:
  - libs/<scope>/contract/src/index.ts
  - libs/<scope>/service/src/index.ts
  - libs/<scope>/core/src/index.ts # or: libs/<scope>/domain/src/index.ts
  - libs/<scope>/infra/src/index.ts
spans:
  - <planned Effect.fn span names, e.g. Domain.useCase, Domain.decide>
services:
  - <planned Context.Service tags, e.g. MyService>
errors:
  - <planned TaggedError classes, e.g. MyError>
---

## Context

Two paragraphs describing what happens today, why this work is needed, and the existing graph context:

- **Reused Contracts / Errors:** `<symbols from type:contract>`
- **Reused Services:** `<Context.Service tags from type:service>`
- **New Capabilities Needed:** `<new schemas, errors, or service methods>`

## Goal

One paragraph describing what will be true about the product when finished — never what this document does.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

### Verification Column Mapping Rules

The `Verification` column in the EARS table maps each requirement to its deterministic enforcement mechanism:

- **`UnitTest` / `PropertyTest`:** Dynamic runtime assertions in `@effect/vitest` for business logic, return channel `A`, and typed failure channel `E`.
- **`GraphCheck` / `AstGate`:** Static type-channel invariants (`R = never` for pure deciders, `E = never` for infallible reducers) **must** use `Verification: GraphCheck` or `AstGate` (never `UnitTest`), enforced by `ontology-unverified-requirement`. Pure deciders cannot be proven pure by runtime tests alone.
- **`TraceTest`:** Distributed trace capture with `@harness/ingest`.

### Frontmatter & Mermaid Symbol Parity Rules

- **Frontmatter Symbol Ownership (`spec-source-symbol-ownership`):** Every non-placeholder `Effect Symbol` entry in a requirement table **must** be declared in the spec's YAML frontmatter `spans:`, `services:`, or `errors:` list (use `—` for pure schema/config rows that map cleanly without a named span/service/error).
- **Backlog `status: draft` vs. Active `status: proposed`:** Record queued multi-wave backlog specs with `status: draft` (keeps planned `spans`/`services`/`errors`/`enforced_by` intact without failing `INF-07` or `doc-missing-file-path`, while still enforced by `EarsSpecLint.decide`) and promote to `status: proposed` when entering `planning-effect-skeletons`.
- **Mermaid Diagram `*Error` Parity:** Any `*Error` symbol appearing inside a Mermaid diagram in an EARS spec or ADR **must** be declared in frontmatter `errors:` and emitted by an `EffectFn`. Failing to do so triggers `stale-doc-reference` (if undeclared or non-existent in code) and `dead-tagged-error` (if declared in frontmatter but not yielded by an `EffectFn`).
- **No Future-Phase Leaks:** Never reference unbuilt errors, hypothetical command deduplication, or future-phase types in Mermaid diagrams or prose.

## Requirements

### 1 · <Area Name>

**Source (<origin>):** <why it matters>.

| ID      | Pattern            | Requirement                                                                                                                                 | Effect Symbol      | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------ |
| REQ-1.1 | Event-driven       | **When** a valid PhotoUpload payload is submitted, the Sample.uploadPhoto use-case **shall** store the photo and return PhotoMetadata.      | Sample.uploadPhoto | UnitTest     |
| REQ-1.2 | State-driven       | **While** currentCount is greater than or equal to maxAllowed, the AlbumQuota.decide decider **shall** return QuotaExceeded with R = never. | AlbumQuota.decide  | GraphCheck   |
| REQ-1.3 | Unwanted behaviour | **If** the requested photoId is not present in PhotoRepo, **then** the Sample.getPhoto use-case **shall** fail with PhotoNotFoundError.     | PhotoNotFoundError | UnitTest     |

## Assumptions

- **REQ-1.1:** Maximum upload size defaults to 10MB; configurable via MaxUploadSizeConfig.

## Out of scope

- **Soft-delete retention policy.** Purge delay for deleted photos. Decides: Product team.

## Known residual risks

- Concurrent photo uploads to the same album rely on Durable Object atomic transactions; high concurrency on a single album may queue behind the DO actor mailbox.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`, `PropertyTest`, `TraceTest`, `GraphCheck`, `AstGate`).
- Affected 5-tier hexagonal Nx packages updated: `type:contract` -> `type:service` -> `type:core` / `type:domain` -> `type:infra` -> `type:app` (`scope:web`).
- Frontmatter updated to `status: accepted` upon implementation and verified by `harness gc --strict`.
```

## Rationalization Table

| Excuse                                                                           | Reality                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The user said 'quickly / no time', so I'll invent default assumptions silently" | Silent assumptions cause full rewrites across 5 hexagonal Nx tiers. Put defaults in `## Assumptions` and confirm EARS clauses first.                                                                                          |
| "I can `ls` / grep and read existing ADRs and specs directly to save tool calls" | Bulk-reading governance docs blows context and misses unlinked decisions. Always start with `harness_doc_tree(mode: "catalog")` + `harness_search_knowledge` and read bounded slices via `harness_doc_tree(mode: "section")`. |
| "I can skip `informed_by` in frontmatter if I read the ADR"                      | Without `informed_by`, `harness_ontology_why` and `harness_ontology_impact` cannot traverse `ADR <-informed_by- EarsSpec` (`ArchimateOntology`). Always list governing ADRs in `informed_by`.                                 |
| "I can write a prose Markdown implementation plan instead of EARS"               | Prose plans hide missing `E` (error) and `WHILE` (pure `.decide` over `Schema.TaggedUnion` with `match()...exhaustive()`) channels. EARS maps 1:1 to `Effect<A, E, R>`.                                                       |
| "I don't need `harness_resolve` before asking questions"                         | Asking without checking the graph wastes the user's time on things already defined in `type:contract` or `type:service` (and `harness_resolve` returns fuzzy `suggestions` on miss).                                          |
| "I can use 'the system shall' to save time"                                      | Generic subjects fail `EarsSpecLint.decide` (`generic-subject`). Every Effect requirement must name a concrete symbol.                                                                                                        |
| "I can verify `R = never` or `E = never` with a `UnitTest`"                      | Static type-channel invariants cannot be verified by running a unit test; they must be verified by `GraphCheck` or `AstGate` (`ontology-unverified-requirement`).                                                             |
| "I can show future error paths in the Mermaid diagram"                           | Any `*Error` in a spec or ADR Mermaid diagram must be declared in frontmatter `errors:` and emitted by an `EffectFn` (`stale-doc-reference` & `dead-tagged-error`).                                                           |

## Red Flags — STOP

- Reading whole ADR/spec markdown files or running manual `ls`/grep before `harness_doc_tree(mode: "catalog")` and `harness_search_knowledge`
- Omitting `informed_by` frontmatter when existing ADRs govern the design
- Starting to edit `.ts` files before EARS clauses (`WHEN`, `IF/THEN`, `WHILE`) are stated and saved to `libs/<scope>/docs/specs/`
- Using generic subjects like "the system shall" or compound obligations ("and shall")
- Writing full implementation code inside a `.md` plan file
- Inventing domain error or quota rules without checking `harness_resolve`
- Adding `Status` or `Evidence` columns to the requirements table
- Using `UnitTest` to verify static type-channel invariants like `R = never` or `E = never` (use `GraphCheck` or `AstGate`)
- Drawing `*Error` symbols in Mermaid diagrams that are not declared in frontmatter `errors:` and emitted by an `EffectFn` (`stale-doc-reference`, `dead-tagged-error`)

**REQUIRED NEXT SKILL:** After the user approves the EARS specification, use `planning-effect-skeletons`.
