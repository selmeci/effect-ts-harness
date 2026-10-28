---
name: specifying-ears-with-effect
description: Use when starting any new feature, requirement, or behavior change before writing code or skeletons, especially when requirements are informal, incomplete, or lack EARS clauses.
---

# Specifying EARS with Effect

Turn informal feature requests into unambiguous **EARS (Easy Approach to Requirements Syntax)** specifications grounded in the Effect graph before writing code or skeletons.

**Violating the letter of the rules is violating the spirit of the rules.**

## Discovery & Interview Sequence

1. **Inspect Existing Graph First:** Call `harness_resolve` and `harness_callers` on related domain symbols (`EffectFn`, `ServiceTag`, `TaggedError`), and call `harness_ontology_why` and `harness_ontology_impact` to trace existing ArchiMate layers (`Motivation -> Business -> Application -> Technology`) and see all governing ADRs and EARS requirements before drafting new requirements. `harness_callers` also returns `GovernsSymbol` (`AdrDoc`) and `SpecifiesSymbol` (`EarsSpec`) edges showing governing ADRs and EARS specs.
2. **Apply Specificity Test & Clarify Ambiguities:** Point at the exact words in the user's prompt or graph before drafting requirements. If the source is silent and blocking, ask at most one targeted question per turn (or use `ask_question`). Never smuggle unprompted numbers, fields, or mechanisms into requirements; separate confirmed facts from `## Assumptions` and `## Out of scope`.
3. **Write EARS Requirements & Run 3-Role Review:** Draft requirements using the canonical template and rules in `references/ears-patterns.md`. Perform the 3-role review (Implementer, `@effect-ears-test-reviewer`, Source Author).
4. **Persist and Verify Specification:** Save the specification to `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (falling back to root `docs/specs/` only for cross-cutting tasks) with machine-verifiable YAML frontmatter (`id: <scope>:SPEC-NNNN`, `status: proposed`, `spans`, `services`, `errors`). Verify with `harness gc --strict` and run `harness_ontology_check` (or CLI `harness ontology check --scope=<scope> --strict`) to verify both deterministic cross-layer invariants (`OntologyInvariants.decide`) and `clef-flash` semantic conflict checks (`OntologyConflictV1`).

## Output Contract (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`)

Every specification must follow this canonical template:

```markdown
---
id: <scope>:SPEC-NNNN
title: <Feature Title>
status: proposed
date: YYYY-MM-DD
enforced_by:
  - libs/<scope>/contract/src/index.ts
  - libs/<scope>/service/src/index.ts
  - libs/<scope>/domain/src/index.ts
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

## Requirements

### 1 · <Area Name>

**Source (<origin>):** <why it matters>.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Event-driven | **When** a valid PhotoUpload payload is submitted, the Sample.uploadPhoto use-case **shall** store the photo and return PhotoMetadata. | Sample.uploadPhoto | UnitTest |
| REQ-1.2 | State-driven | **While** currentCount is greater than or equal to maxAllowed, the AlbumQuota.decide decider **shall** return QuotaExceeded. | AlbumQuota.decide | PropertyTest |
| REQ-1.3 | Unwanted behaviour | **If** the requested photoId is not present in PhotoRepo, **then** the Sample.getPhoto use-case **shall** fail with PhotoNotFoundError. | PhotoNotFoundError | UnitTest |

## Assumptions
* **REQ-1.1:** Maximum upload size defaults to 10MB; configurable via MaxUploadSizeConfig.

## Out of scope
* **Soft-delete retention policy.** Purge delay for deleted photos. Decides: Product team.

## Known residual risks
* Concurrent photo uploads to the same album rely on Durable Object atomic transactions; high concurrency on a single album may queue behind the DO actor mailbox.

## Acceptance criteria
* All requirement rows pass their declared Verification methods (`UnitTest`, `PropertyTest`, `TraceTest`).
* Affected Nx packages updated: `type:contract` -> `type:service` -> `type:domain` -> `type:infra` -> `scope:web`.
* Frontmatter updated to `status: accepted` upon implementation and verified by `harness gc --strict`.
```

## Rationalization Table

| Excuse | Reality |
|---|---|
| "The user said 'quickly / no time', so I'll invent default assumptions silently" | Silent assumptions cause full rewrites across 4 Nx tiers. Put defaults in `## Assumptions` and confirm EARS clauses first. |
| "I can write a prose Markdown implementation plan instead of EARS" | Prose plans hide missing `E` (error) and `WHILE` (pure `.decide` over `Schema.TaggedUnion` with `match()...exhaustive()`) channels. EARS maps 1:1 to `Effect<A, E, R>`. |
| "I don't need `harness_resolve` before asking questions" | Asking without checking the graph wastes the user's time on things already defined in `type:contract` or `type:service`. |
| "I can use 'the system shall' to save time" | Generic subjects fail `EarsSpecLint.decide` (`generic-subject`). Every Effect requirement must name a concrete symbol. |

## Red Flags — STOP

- Starting to edit `.ts` files before EARS clauses (`WHEN`, `IF/THEN`, `WHILE`) are stated and saved to `libs/<scope>/docs/specs/`
- Using generic subjects like "the system shall" or compound obligations ("and shall")
- Writing full implementation code inside a `.md` plan file
- Inventing domain error or quota rules without checking `harness_resolve`
- Adding `Status` or `Evidence` columns to the requirements table

**REQUIRED NEXT SKILL:** After the user approves the EARS specification, use `planning-effect-skeletons`.
