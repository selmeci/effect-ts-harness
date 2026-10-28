---
name: executing-effect-stubs
description: Use when stub<A, E, R>() skeletons have passed plan-check and are ready to be replaced with production Effect implementations and tests across one or more packages.
---

# Executing Effect Stubs (Subagent-Driven Implementation)

## Overview

Once `harness plan-check` has locked the `type:contract` Schemas, `type:service` interfaces, and `stub<A, E, R>()` signatures, replace every stub with a tested production implementation. For multi-package work, dispatch fast `flash` subagents per package boundary (`type:domain`, `type:infra`, `scope:web`), review their diffs, and close with `harness verify` and `harness done`.

**Violating the letter of the rules is violating the spirit of the rules.**

## Execution Recipe

### 1. Partition by Nx Taxonomy (`flash` Subagents)
Because `type:contract` and `type:service` are already compiled and locked by `plan-check`, work in downstream packages is isolated:
- **Unit A (`type:domain`):** Replace `*.decide` and use-case `stub<A, E, R>()` calls; test with `@effect/vitest` (`it.effect`) + `runWithTestTracer` + in-memory test `Layer`s.
- **Unit B (`type:infra`):** Implement Drizzle D1 / Durable Object `Layer`s (decoding rows into contract Schemas; synchronous DO SQLite transactions; W3C `traceparent` headers) and test with `@effect/vitest`.
- **Unit C (`scope:web`):** Derive `AtomHttpApi` query/mutation atoms from `type:contract` (zero raw `fetch`).

When launching parallel subagents that run CLI or build commands concurrently, isolate their workspaces using `Workspace: "share"` (in Antigravity `invoke_subagent`) or an isolated git worktree with `HARNESS_WORKTREE_ID=<unit>` (e.g. `HARNESS_WORKTREE_ID=unit-a`) so `.harness/worktrees/<id>` state files and stamps never collide.

When delegating a unit to an implementer subagent via `invoke_subagent` (`TypeName: "self"`, `Model: "flash"`, `Workspace: "share"`), provide this exact 4-part prompt:
1. **Target Stubs & Files:** Exact file paths and `Effect.fn("SpanName")` stubs to replace.
2. **EARS Acceptance Clauses:** The `WHEN`, `IF/THEN`, and `WHILE` clauses that must each have a matching `it.effect(...)` test.
3. **Pattern Reference:** Path to the relevant `agent-patterns/*.md` file (e.g., `agent-patterns/d1-repository.md`, `agent-patterns/durable-object-state.md`).
4. **Package Gate:** `CI=true pnpm nx run <project>:verify` (must pass with 0 active `stub()` calls in that package).

### 2. Implement & Write `@effect/vitest` Trace Tests
Implement the production code and tests within each package boundary:
- Write `@effect/vitest` tests (`it.effect`) validating every EARS requirement with `runWithTestTracer`.
- Require `it.effect.prop` / `it.prop` property-based tests with `Schema` arbitraries (via `effect/Arbitrary`) for every pure domain decider (`*.decide` / EARS `WHILE` clause) and projection reducer, ensuring boundary invariants and round-trips hold across arbitrary inputs so `harness gc --strict` passes `missing-decider-property-test`.
- Check span budgets using `checkSpanBudgets` (`SpanBudget.decide`) on recorded spans to prevent N+1 query/RPC repetitions (`maxRepeatedChildCalls` threshold, e.g. $\le 3$) and ensure latency budgets (`maxSpanDurationMs`) are honored.
- Keep `*.decide` deciders strictly pure (`R = never`), confining side effects and cloud bindings to `type:infra`.

### 3. Final Verification & Closeout (Controller Only)
1. **Signal-Routed Multi-Lens `flash` Review (Parallel Specialist Subagents):** Before running `harness gc --strict` and `harness verify`, the controller selects and dispatches parallel `flash` review lenses using the [Reviewer Dispatch Guide](references/dispatch-reviewers.md) (invoking defined subagents or `TypeName: "research"`, `Model: "flash"`, `Workspace: "share"`) based on the packages and capabilities touched by the task:
   - **`EARS & Test-Fidelity Lens` ([@effect-ears-test-reviewer](references/personas/ears-test-reviewer.md), Always):** Reads the feature's `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`) file and verifies that every EARS clause (`WHEN`, `IF/THEN`, `WHILE`) and every declared `spans` / `errors` entry has a behavior-sensitive `@effect/vitest` assertion (rejecting vacuous/mock-only tests and checking sad-path `TaggedError` coverage).
   - **`Security & Trust-Boundary Lens` ([@effect-security-reviewer](references/personas/security-reviewer.md), When touching `type:contract`, `HttpApi`, `Rpc`, auth, or `Config`):** Checks actor/tenant authorization (IDOR) in domain use-cases, `Config.redacted` secret handling (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`), and boundary `Schema` constraints (bounded strings/arrays/finite numbers).
   - **`Reliability & Concurrency Lens` ([@effect-reliability-reviewer](references/personas/reliability-reviewer.md), When touching `type:infra`, DO SQLite, D1, Queues, `Schedule`, or `Scope`):** Checks synchronous DO SQLite transaction discipline (zero async I/O inside `runSyncTransaction`), bounded `Schedule` retries with jitter/cap (no unbounded `Schedule.forever`), external `HttpClient` timeouts, and `Scope` resource finalizers.
   - **`Adversarial Chaos Lens` ([@effect-adversarial-reviewer](references/personas/adversarial-reviewer.md), When touching stateful/multi-step flows, Event Sourcing, Outbox, Projections, or Process Managers):** Acts as a chaos engineer constructing concrete failure sequences (duplicate `commandId` delivery, out-of-order events, crash between SQLite commit and DO alarm/queue dispatch).
   Reviewers strictly enforce the Quote-the-Line Gate and False-Positive Suppression List described in [references/dispatch-reviewers.md](references/dispatch-reviewers.md).
2. **Spec Status, Graph Garbage Collection & Mutation Testing (`status: accepted`, `stale-doc-reference` & `harness mutate`):**
   Once implementation is complete and specialist reviews have passed:
   - Update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`) frontmatter from `status: proposed` to `status: accepted`.
   - Run the entropy and document reference scanner before verification:
     ```bash
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
     ```
     This invokes `GraphGc.decide` to verify zero dead `TaggedError`s (`dead-tagged-error`), unused/unprovided `ServiceTag`s (`unused-service`, `unprovided-service`), orphan `Effect.fn`s (`orphan-effect-fn`), untested domain functions (`untested-effect-fn`), missing property tests on pure deciders (`missing-decider-property-test`), missing pattern documentation (`missing-pattern-doc`), or stale references to deleted files/symbols in accepted ADRs and specs (`stale-doc-reference`).
   - When `type:domain` files are touched, run targeted domain AST mutation testing to verify 0 survived domain mutants (100% mutation score) before `harness verify`:
     ```bash
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
     ```
3. **Whole-Workspace Deterministic Gate:** Run the ONLY sanctioned completion sequence:
   ```bash
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
   ```
   - If `harness verify` exits `2` with `[ESCALATE: STUCK LOOP DETECTED]`, stop immediately and escalate to the user instead of retrying variations of the same fix.

## Rationalization Table

| Excuse | Reality |
|---|---|
| "I'll implement all 4 layers in one giant turn myself" | Monolithic edits across `domain`, `infra`, and `web` pollute context. Locked `stub<A, E, R>()` boundaries let `flash` subagents implement each package cleanly. |
| "Unit tests passed in `vitest`, so I don't need `harness verify`" | Only `harness verify` checks for leftover `stub()` calls, runs `checkEffectGraph`, and writes `.harness/verify-stamp.json`. Without it, `harness done` (and the `Stop` hook) blocks completion. |
| "I tweaked a comment/file after `harness verify`, no need to re-run" | `.harness/verify-stamp.json` hashes the entire working tree via SHA-256. Any post-verify file edit invalidates the stamp. |
| "harness gc isn't necessary if TypeScript builds" | TypeScript does not check for unused `TaggedError`s, unprovided service tags in layers, untested domain functions, or missing pattern documentation. `harness gc --strict` stops code entropy before it merges. |
| "Single example unit tests are enough for deciders" | Example tests suffer from test reward hacking and shared blind spots. `missing-decider-property-test` in `gc --strict` requires `it.effect.prop` / `it.prop`, and `harness mutate --strict` verifies zero mutants survive boundary shifts. |
| "I don't need to update docs/specs to status: accepted" | Leaving specs as `proposed` causes documentation drift. Setting `accepted` activates `stale-doc-reference` verification in `GraphGc.decide`. |

## Red Flags — STOP

- Leaving any `stub()` call in production code during `verify`
- Using `async/await`, `try/catch`, `throw`, raw `JSON.parse`, or raw `fetch()` in `scope:web`
- Using `switch` statements, `if / else if` chains, `match().run()`, `.otherwise()` on closed discriminated unions, or `if` / ternary (`? :`) branching on union discriminants (`_tag`, `Option.isSome`, `Either.isRight`, `Result.isSuccess`); always use `match(value).with(...).exhaustive()` from `ts-pattern` (`agent-patterns/pattern-matching.md`)
- Never use `it.skip`, `it.only`, `it.todo`, `@ts-ignore`, or `oxlint-disable` to bypass a failing test or lint rule (`harness/test-integrity` and `harness/syntax-bans` reject them deterministically).
- If `harness verify` exits `2` with `[ESCALATE: STUCK LOOP DETECTED]`, stop immediately and escalate to the user instead of retrying variations of the same fix.
- Dead `TaggedError`s, unprovided `ServiceTag`s, untested domain `Effect.fn`s, missing property tests on deciders (`missing-decider-property-test`), or `stale-doc-reference` detected by `harness gc`
- Survived mutants reported by `harness mutate --strict` on domain deciders
- N+1 query/RPC repetitions violating `checkSpanBudgets`
- Forgetting to mark `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`) as `status: accepted` prior to `gc --strict` and `verify`
- Claiming task completion without a fresh `.harness/verify-stamp.json` and a passing `harness done`

**OPTIONAL FOLLOW-UP SKILL:** If the task encountered route misses or repeated verify failures, use compounding-effect-learnings (harness learn).
