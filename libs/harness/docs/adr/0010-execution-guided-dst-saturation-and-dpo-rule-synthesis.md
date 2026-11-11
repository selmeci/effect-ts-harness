---
id: harness:ADR-0010
title: Execution-Guided Deterministic Simulation Testing, Zero-Respawn Mutant Schemata, EARS Consistency & Self-Evolving DPO Rule Synthesis
status: accepted
date: 2026-11-11
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/ears-consistency.ts
  - libs/harness/gates/src/dst-engine.ts
  - libs/harness/gates/src/span-budget.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/rule-synthesizer.ts
  - libs/harness/gates/src/friction-log.ts
  - libs/harness/ingest/src/recording-tracer.ts
  - libs/harness/decision/src/ears-semantics-decision.ts
  - libs/harness/decision/src/dst-hazard-decision.ts
  - libs/harness/decision/src/mutant-equivalence-decision.ts
  - libs/harness/decision/src/rule-quality-decision.ts
  - libs/harness/decision/src/plan-search-decision.ts
spans:
  - EarsConsistency.decide
  - DstEngine.decide
  - SpanBudget.decide
  - MutationCheck.decide
  - RuleSynthesizer.decide
  - PlanSearch.decide
  - EarsClauseSemantics.evaluate
  - DstHazardPrior.evaluate
  - MutantEquivalence.evaluate
  - SynthesizedRuleQuality.evaluate
  - PlanSearchScorer.evaluate
services: []
errors:
  - EarsConsistencyError
  - DstScheduleError
  - SpanCausalityError
  - RuleSynthesisError
  - PlanSearchError
informs:
  - harness:SPEC-0009
---

# ADR-0010 · Execution-Guided Deterministic Simulation Testing, Zero-Respawn Mutant Schemata, EARS Consistency & Self-Evolving DPO Rule Synthesis

## Context and Problem Statement

Even when a workspace satisfies static type-checking, AST lints, and stratified Datalog hypergraph invariants (`harness:ADR-0009`), four classes of semantic defects and scaling bottlenecks remain (`RFC-0005`):

1. **Contradictory, Shadowed, or Incomplete EARS Specifications:** Two EARS clauses can prescribe contradictory outcomes under overlapping states and guards (`EARS-01`), an earlier broad clause can shadow a more specific subsequent clause (`EARS-02`), or a state-driven specification can omit variants of a closed `Schema.TaggedUnion` state domain (`EARS-03`).
2. **Untested Concurrency Interleavings, Partial Failures, and `TestClock` Deadlocks:** Happy-path unit tests rarely exercise fiber interruptions, jittered I/O latencies, or saga compensation paths (`CAUS-01`, `CAUS-02`), while naive fault injection that calls `TestClock.adjust` synchronously inside a mocked service method before failing can deadlock sibling fibers awaiting `Effect.sleep`.
3. **Subprocess-Respawn Mutation Overhead and Unexercised Error Channels:** Rewriting files on disk and spawning cold `vitest` subprocesses per mutant requires seconds per mutant, and binary `ExercisesSpan` edges do not distinguish whether a span's declared `TaggedError` channels (`SAT-01`) or multi-way `match` branches (`SAT-02`) were actually exercised across the span or its descendant call tree.
4. **Prose-Only Friction Promotion and Unbounded Thrashing Recovery:** Promoting `.harness/friction-log.jsonl` clusters only into Markdown prose relies on LLM attention rather than deterministic graph gates, while unconstrained self-modification risks corrupting the harness Trusted Computing Base (TCB).

How do we achieve execution-guided deterministic simulation testing, sub-200ms in-process mutation and error-channel saturation verification, finite algebraic EARS consistency checking, and safe self-evolving DPO rule synthesis without external SMT solvers or subprocess thrashing?

## Decision Drivers

- **Zero External Solver Dependencies (`RFC-0005 §3`):** All consistency, simulation, saturation, and anti-unification deciders must execute 100% in-process in TypeScript with `R = never`, calibrated by bounded System One (`clef-flash`) priors memoized via `CachedDecisionModel`.
- **Deadlock-Free Deterministic Simulation (`RFC-0005 §4.2.2`):** Simulated faults must never advance `TestClock` synchronously inside a failing service method; virtual time must be driven exclusively by a decoupled supervisor `clockDriver` fiber (`Effect.yieldNow()` followed by `TestClock.adjust`), governed by a reproducible 64-bit `DstSeed`.
- **Zero-Respawn Mutant Schemata (`RFC-0005 §4.3.2`):** Candidate mutations must be scoped to `git diff` modified lines, compiled into a single in-memory Mutant Schema AST switched by `globalThis.__HARNESS_ACTIVE_MUTANT_ID`, and evaluated over `ExercisesSpan`-linked tests in a single warm process in under 200ms.
- **Descendant-Span Error Accounting (`RFC-0005 §4.3.1`):** Error-channel saturation (`SAT-01`) must credit `Failure` exits recorded on both a span $s_f$ and any of its descendant spans $s_c$ ($s_f \prec_{\text{parent}}^+ s_c$) so boundary catch-and-translate handlers are not falsely penalized.
- **Immutable TCB & Zero False-Positive DPO Rule Synthesis (`RFC-0005 §4.4`):** Synthesized DPO rules extracted via Plotkin's First-Order Graph Anti-Unification (Least General Generalization, LGG) must pass a 4-stage AlphaEvolve cascade evaluator with zero false positives on healthy graph snapshots and a hard ban on modifying TCB gate files.

## Considered Options

- **Option 1: Finite Algebraic EARS Consistency + Execution-Guided DST (`DstEngine.decide` & Decoupled `clockDriver`) + Zero-Respawn Mutant Schemata + LGG DPO `RuleSynthesizer.decide` with System One Priors (`RFC-0005` Architecture).** Implement finite relational EARS consistency checking (`EarsConsistency.decide` + `EarsClauseSemanticsV1`), XorShift64* deterministic simulation (`DstEngine.decide` + `DstHazardPriorV1`) with LISA temporal causality in `SpanBudget.decide`, enriched `SpanRecorder` exit/error/value tags with in-memory Mutant Schemata (`MutationCheck.decide` + `MutantEquivalenceV1`), and LGG DPO rule synthesis (`RuleSynthesizer.decide` + `SynthesizedRuleQualityV1`) plus `PlanSearch.decide` (`PlanSearchScorerV1`).
- **Option 2: External Z3 / CVC5 SMT Subprocess + Cold Per-Mutant `vitest` Subprocesses.** Shell out to an external SMT binary for EARS consistency and spawn a fresh `vitest` process per mutated source file.
- **Option 3: Unconstrained LLM Code Generation for Rule Synthesis and Chaos Tests.** Prompt an LLM to write ad-hoc lint rules and chaos tests directly into `libs/harness/gates/src/` without algebraic anti-unification or TCB immutability checks.

## Decision Outcome

Chosen option: **Option 1 (Finite Algebraic EARS Consistency + Execution-Guided DST + Zero-Respawn Mutant Schemata + LGG DPO `RuleSynthesizer.decide` with System One Priors)**, because it delivers deterministic mathematical soundness, sub-200ms in-process mutation evaluation, reproducible single-seed concurrency simulation, and zero-false-positive rule synthesis while protecting the harness TCB.

## Rejected Alternatives

### 1 · External Z3 / CVC5 SMT Subprocess + Cold Per-Mutant `vitest` Subprocesses

Invoke an external SMT solver for specification consistency and spawn a new `vitest` child process for each source mutation.

**Why rejected:** External native solver binaries add cross-platform installation fragility for checks that are finite relational set operations over closed `Schema.TaggedUnion` variants, and spawning cold `vitest` subprocesses per mutant adds 800ms–1.5s of startup overhead per mutation, violating inner-loop latency budgets.

### 2 · Unconstrained LLM Code Generation for Rule Synthesis and Chaos Tests

Allow `pnpm harness learn` to emit arbitrary TypeScript gate code directly into `libs/harness/gates/src/`.

**Why rejected:** Unconstrained code generation can introduce non-terminating checks, false positives on existing healthy code, or accidental weakening of `policy.ts`, `verify-stamp.ts`, and `ast-cache.ts` inside the Trusted Computing Base.

## Consequences and Enforcement

### Positive Consequences

- `EarsConsistency.decide` catches contradictory (`EARS-01`), shadowed (`EARS-02`), and state-incomplete (`EARS-03`) EARS requirements during `plan-check` and `gc --strict` using finite relational algebra calibrated by `EarsClauseSemanticsV1`.
- `DstEngine.decide` and `it.effect.dst` deterministically explore fiber interleavings, delays, and service failures with a decoupled `clockDriver` fiber, recording `DstSeed` in `.harness/verify-stamp.json` and checking LISA temporal causality (`CAUS-01`, `CAUS-02`) via `SpanBudget.decide`.
- `makeRecordingTracer` captures `exitTag`, `errorTag`, and `valueTag` without `any`, enabling descendant-aware `SAT-01` / `SAT-02` saturation gates and in-memory `globalThis.__HARNESS_ACTIVE_MUTANT_ID` Mutant Schemata in `MutationCheck.decide` filtered by `MutantEquivalenceV1`.
- `RuleSynthesizer.decide` generalizes `G_bad -> G_good` repair diffs via LGG anti-unification (`?Scope`), enforces the 4-stage cascade evaluator and Immutable TCB boundary, and `PlanSearch.decide` ranks multi-skeleton recovery candidates via `PlanSearchScorerV1`.

### Negative Consequences and Trade-offs

- Two-tier DST execution (`10` seeds in fast mode, `100` seeds in full `CI=true` verify) requires deterministic `XorShift64*` seeding and pure functional state restoration between seeds.
- Synthesized DPO rules that match any healthy corpus snapshot or touch TCB files are rejected and fall back to human review.

### Deterministic Enforcement

| Rule                                                                                                                               | Enforced By                                                                                                       | Gate / Mechanism                                                 | Governed Symbols                                                                              |
| :--------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| Finite algebraic EARS consistency (`EARS-01`, `EARS-02`, `EARS-03`) and `EarsClauseSemanticsV1` guard classification               | `libs/harness/gates/src/ears-consistency.ts`, `libs/harness/decision/src/ears-semantics-decision.ts`              | `pnpm harness plan-check` & `pnpm harness gc --strict`           | `EarsConsistency.decide`, `EarsClauseSemantics.evaluate`, `EarsConsistencyError`              |
| Deterministic simulation schedule (`XorShift64*`), decoupled `clockDriver` fiber, `DstSeed` stamp, and `DstHazardPriorV1`          | `libs/harness/gates/src/dst-engine.ts`, `libs/harness/decision/src/dst-hazard-decision.ts`                        | `pnpm harness verify`                                            | `DstEngine.decide`, `DstHazardPrior.evaluate`, `DstScheduleError`                             |
| LISA temporal causality (`MustPrecede`, `ForbiddenUnder`, `RequireCompensationOnFailure` — `CAUS-01`, `CAUS-02`)                   | `libs/harness/gates/src/span-budget.ts`, `libs/harness/ingest/src/recording-tracer.ts`                            | `pnpm harness verify`                                            | `SpanBudget.decide`, `SpanCausalityError`                                                     |
| Enriched `SpanRecorder` (`exitTag`, `errorTag`, `valueTag`), `SAT-01`/`SAT-02`, Mutant Schemata, and `MutantEquivalenceV1`         | `libs/harness/gates/src/mutation-check.ts`, `libs/harness/decision/src/mutant-equivalence-decision.ts`            | `pnpm harness mutate --strict` & `pnpm harness verify`           | `MutationCheck.decide`, `MutantEquivalence.evaluate`                                          |
| LGG DPO rule anti-unification (`?Scope`), 4-stage cascade evaluator, Immutable TCB check, and `SynthesizedRuleQualityV1`           | `libs/harness/gates/src/rule-synthesizer.ts`, `libs/harness/decision/src/rule-quality-decision.ts`                | `pnpm harness learn` & `pnpm harness verify`                     | `RuleSynthesizer.decide`, `SynthesizedRuleQuality.evaluate`, `RuleSynthesisError`             |
| Best-of-$K$ `PlanSearch.decide` candidate skeleton ranking and `LoopCircuitBreaker.decide` integration with `PlanSearchScorerV1`   | `libs/harness/gates/src/friction-log.ts`, `libs/harness/decision/src/plan-search-decision.ts`                     | `pnpm harness plan-check` & `pnpm harness verify`                | `PlanSearch.decide`, `PlanSearchScorer.evaluate`, `PlanSearchError`                           |
