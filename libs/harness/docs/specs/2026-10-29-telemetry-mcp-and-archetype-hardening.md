---
id: harness:SPEC-0002
title: Telemetry session scoping, cross-repo MCP resolution, and framework archetype gate hardening
status: accepted
archetype: framework
date: 2026-10-29
enforced_by:
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/gates/src/friction-log.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/src/ontology-invariants.ts
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/decision/src/idiom-router.ts
  - apps/harness-cli/src/index.ts
  - apps/harness-mcp/src/server.ts
spans:
  - SessionReport.decide
  - LoopCircuitBreaker.decide
  - GraphGc.decide
  - MutationCheck.decide
  - OntologyInvariants.decide
  - Harness.routeStep
  - Harness.decideGuardCommand
---

# harness:SPEC-0002: Telemetry session scoping, cross-repo MCP resolution, and framework archetype gate hardening

## Context

Forensic review of the first Event Sourcing pull request (`selmeci/effect-es#3`, conversation `9c378353-0377-4dde-8a81-274ca5af82e5`) and subsequent adversarial code review revealed both telemetry distortions and semantic gate blind spots:

1. **Premature Session Slicing by `Stop` Hook (`-15 pts`):** When `pnpm harness verify` ran for `31.6 s` and moved to a background task, the Antigravity `Stop` hook (`done --format=antigravity`) fired with `{"fullyIdle": false}` and exited `0` (`{"decision": "stop"}`). `runCliEffect` recorded `{ surface: "hook", toolName: "done", outcome: "ok" }`, and when `verify` finished 17 seconds later, `scopeSessionReportInput` treated that `Stop` hook turn boundary as the end of a prior task, slicing off `plan-check`, `route`, `gc`, and `mutate` and reporting `planBeforeVerify: false`.
2. **Guard Escalation Penalty on `verdict=allow` (`-20 pts`):** `decideSessionReport` deducted `-5` points per `guard_escalation` event even when `decideGuardCommand` approved the command with `verdict=allow`, and `decideLoopThrashing` counted `verdict=allow` escalations toward stuck-loop thrashing.
3. **Cross-Repo MCP Split-Brain (`bySurface.mcp: 0`):** Because `harness-mcp` is spawned from the plugin directory inside `effect-ts-harness`, `resolveDefaultRepoRoot()` resolved `effect-ts-harness` instead of the active workspace (`effect-es`), and `resolveGraph()` only read `.harness/graph-snapshot.json` (ignoring `.harness/plan-graph-snapshot.json` during planning).
4. **Graph Extraction, Plan-vs-GC Drift & `type:core` Blind Spots (`-10 pts`):** `extractTypeAwareGraphFromSource` missed generic `Schema.TaggedError<Self>()("Tag", ...)` declarations (`TaggedError<`), required `Effect.fn` wrappers on synchronous `evolve` reducers, flagged schema-version `version` fields in `dead-event-payload`, failed to trace test coverage through `Decider.make({ decide, evolve })` bindings, and ignored `type:core` (`libs/<scope>/core/src`) in `mutation-check.ts`.
5. **Semantic & Test-Fidelity Blind Spots (Grok PR #3 Review):** The static graph and GC gates did not flag `JSON.stringify` equality fallbacks alongside `Equal.equals`, optional/omitted error parameters on `.thenFails()`, `Effect.runSync` inside domain reducers or `Decider.make({ evolve })`, `if (Exit.isSuccess(exit))` branching, shallow property tests that only generate scalar numbers (`PositiveInt`) instead of event/command union arrays, untested failure branches in `testing.ts`, undeclared `*Error` symbols inside Mermaid spec diagrams, `UnitTest` verification labels on static `R = never` type invariants, empty `export {}` source modules, or unused dependencies in `package.json`.

- **Reused contracts / functions:** `scopeSessionReportInput`, `decideSessionReport` (`libs/harness/gates/src/telemetry.ts`); `decideLoopThrashing` (`libs/harness/gates/src/friction-log.ts`); `classifyCommand`, `isCommandAllowed`, `ALLOWLIST` (`libs/harness/gates/src/policy.ts`); `decideGraphEntropy` (`libs/harness/gates/src/gc-check.ts`); `decideOntologyInvariants` (`libs/harness/gates/src/ontology-invariants.ts`); `discoverDomainMutants` (`libs/harness/gates/src/mutation-check.ts`); `extractTypeAwareGraphFromSource`, `extractWorkspaceTypeAwareGraph` (`libs/harness/graph/src/type-extractor.ts`); `checkEffectGraph` (`libs/harness/graph/src/policy-check.ts`); `IdiomRouterV1` (`libs/harness/decision/src/idiom-router.ts`).
- **Reused services:** `DecisionModel.DecisionModel`, `OmnigraphSync`.
- **New capabilities needed:** `fullyIdle=false` hook discrimination in `scopeSessionReportInput`; non-penalizing `verdict=allow` handling in `SessionReport.decide` and `LoopCircuitBreaker.decide`; active workspace breadcrumb resolution and snapshot mtime selection in `harness-mcp`; `TaggedError<`, synchronous reducer, `Decider.make`, `fallback-json-equality`, `vacuous-error-assertion`, `unscoped-effect-run`, and `Exit.is*` `discriminant-branching` support in `type-extractor.ts`; `shallow-decider-property-test`, Mermaid error reference, `empty-source-module`, and `unused-package-dependency` checks in `gc-check.ts`; `guard-condition` mutants in `mutation-check.ts`; and an `"event-sourcing"` block in `IdiomRouterV1`.

## Goal

Eliminate false telemetry penalties, cross-repo MCP split-brain, and `type:core` / Event Sourcing semantic and test-fidelity blind spots so clean sessions achieve a `95–100/100 (Grade: A)` health score and catch silent assertion/reducer bugs deterministically before PR review.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is one sentence with bold keywords (`When`, `While`, `If … then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Telemetry session window scoping and friction scoring

**Source (forensic audit 2026-10-29, findings 1.1 and 1.4):** `Stop` hook with `{"fullyIdle": false}` sliced active sessions in `scopeSessionReportInput`, and `verdict=allow` guard escalations deducted 20 health score points.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Unwanted behaviour | **If** the Antigravity Stop hook (`done --format=antigravity`) receives `{"fullyIdle": false}`, **then** the `runCliEffect` telemetry recorder **shall** annotate the hook event with `detail: "fullyIdle=false"` without overwriting `session-report.json`. | SessionReport.decide | test |
| REQ-1.2 | Ubiquitous | The `scopeSessionReportInput` window slicer **shall** treat a `done` telemetry event as a task-completion boundary only when `outcome` is `"ok"`, `detail` is not `"fullyIdle=false"`, and either `surface` is `"cli"`, `detail` is `"completed"`, or the immediately preceding event is a successful `omnigraph:merge-main`. | SessionReport.decide | test |
| REQ-1.3 | Event-driven | **When** `SessionReport.decide` computes `frictionCount` and `healthScore`, the session report decider **shall** exclude `guard_escalation` friction events whose `detail` starts with `"verdict=allow"`. | SessionReport.decide | test |
| REQ-1.4 | Event-driven | **When** `LoopCircuitBreaker.decide` evaluates consecutive failures, the circuit breaker decider **shall** ignore `guard_escalation` events whose `detail` starts with `"verdict=allow"`. | LoopCircuitBreaker.decide | test |

### 2 · Cross-repo MCP workspace resolution and plan-graph fallback

**Source (forensic audit 2026-10-29, finding 1.2):** `harness-mcp` resolved `effect-ts-harness` instead of `effect-es` and ignored `plan-graph-snapshot.json` prior to the first `verify`.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-2.1 | Event-driven | **When** `harness-cli` executes a command against a workspace containing `pnpm-workspace.yaml`, the CLI runner **shall** record the active workspace root in `.harness/active-workspace.json` under the harness server repository root. | SessionReport.decide | test |
| REQ-2.2 | Event-driven | **When** `harness-mcp` resolves the target workspace root, the MCP server **shall** prioritize explicit `repoRoot` or file-path arguments, then non-plugin `process.cwd()`, and then the active workspace breadcrumb in `.harness/active-workspace.json`. | SessionReport.decide | test |
| REQ-2.3 | Event-driven | **When** `harness-mcp` loads the workspace graph in `resolveGraph`, the MCP server **shall** load whichever of `.harness/graph-snapshot.json` or `.harness/plan-graph-snapshot.json` has the newer modification timestamp. | SessionReport.decide | test |

### 3 · Graph extraction, dead-error plan check, and framework archetype support

**Source (forensic audit 2026-10-29, findings 1.3, 2.1, 3.1, and 3.3):** `type-extractor.ts` missed generic `Schema.TaggedError<Self>()(...)`, required `Effect.fn` wrappers on synchronous `evolve` reducers, failed to trace `Decider.make` test edges, and `mutation-check.ts` skipped `type:core`.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-3.1 | Event-driven | **When** `extractTypeAwareGraphFromSource` inspects class declarations and synchronous reducer functions (`evolve*` or `*Reducer`), the type extractor **shall** extract generic `Schema.TaggedError` classes (`TaggedError<`) as `TaggedError` nodes and synchronous 2-parameter reducers as `EffectFn` nodes. | SessionReport.decide | test |
| REQ-3.2 | Event-driven | **When** `extractWorkspaceTypeAwareGraph` links Vitest suites to `EffectFn` nodes, the graph extractor **shall** propagate `ExercisesSpan` edges through `Decider.make({ decide, evolve })` bindings and ignore `_tag` and `version` metadata fields in `dead-event-payload`. | SessionReport.decide | test |
| REQ-3.3 | Unwanted behaviour | **If** a `TaggedError` declared in an active `EarsSpec` or `AdrDoc` has zero incoming `FailsWith` edges during `plan-check` in a workspace with `EffectFn` nodes, **then** the `handlePlanCheck` gate **shall** reject the plan before writing `plan-graph-snapshot.json`. | SessionReport.decide | test |
| REQ-3.4 | Event-driven | **When** `findDomainFiles` in `mutation-check.ts` and `resolvePackageTag` in `type-extractor.ts` scan a workspace, the harness **shall** treat `libs/*/core/src` (`type:core`) identically to `libs/*/domain/src` (`type:domain`). | MutationCheck.decide | test |

### 4 · Guard policy ergonomics and Event Sourcing idiom routing

**Source (forensic audit 2026-10-29, findings 1.4 and 2.3):** `pnpm --filter`, `HARNESS_PLAN_CHECK=1`, `grep`, and `rg` missed the static allowlist, and `harness route "decider core"` resulted in a `route_miss`.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-4.1 | Event-driven | **When** `isCommandAllowed` evaluates a single command prefixed with `CI=` or `HARNESS_*=` environment variables or starting with `pnpm --filter`, `pnpm install`, `git remote`, `grep`, or `rg`, the `classifyCommand` guard policy **shall** return `allow` provided no deny, ask, or destructive/redirection escalation rule matches first. | Harness.decideGuardCommand | test |
| REQ-4.2 | Event-driven | **When** `Harness.routeStep` routes an Event Sourcing or Decider plan step via `IdiomRouterV1`, the router **shall** include `"event-sourcing"` in `IDIOM_BLOCKS` backed by `agent-patterns/event-sourcing.md`. | Harness.routeStep | test |

### 5 · Semantic graph policy, test-fidelity, and governance hygiene gates

**Source (Grok PR #3 adversarial review 2026-10-29, findings G1–G7):** `JSON.stringify` equality fallbacks, optional `.thenFails()` error arguments, `Effect.runSync` in `Decider.make({ evolve })`, `Exit.isSuccess` `if`-branching, scalar-only property tests, untested guard conditions in `testing.ts`, undeclared Mermaid `*Error` symbols, empty `export {}` modules, and unused `package.json` dependencies passed the existing gates.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-5.1 | Unwanted behaviour | **If** non-harness source code uses `JSON.stringify` as an equality comparison or fallback (`fallback-json-equality`), declares an optional error parameter on `thenFails`/`assertFails`/`expectError` (`vacuous-error-assertion`), invokes `Effect.runSync` or `Effect.runPromise` inside a domain reducer or `Decider.make` (`unscoped-effect-run`), or branches on `Exit.isSuccess`/`Exit.isFailure`/`Option.isSome`/`Either.isRight` via `if` or ternary (`discriminant-branching`), **then** `checkEffectGraph` **shall** report a policy violation. | GraphGc.decide | test |
| REQ-5.2 | Unwanted behaviour | **If** `checkDeciderPropertyTests` is enabled in `GraphGc.decide` and all property tests exercising a domain decider use only primitive scalar arbitraries (`hasNonPrimitiveArbitrary === false`), **then** `GraphGc.decide` **shall** emit a `shallow-decider-property-test` finding. | GraphGc.decide | test |
| REQ-5.3 | Event-driven | **When** `discoverDomainMutants` scans a `domain`, `core`, or `contract` file containing `if (!Equal.equals(`, `if (Equal.equals(`, or `if (Exit.isSuccess(`, `MutationCheck.decide` **shall** generate `guard-condition` mutants so untested assertion or validation branches survive and fail `harness mutate --strict`. | MutationCheck.decide | test |
| REQ-5.4 | Unwanted behaviour | **If** an accepted governance doc references an undeclared `*Error` symbol inside a Mermaid diagram or if an EARS requirement specifies a static `R = never` or `E = never` type-channel invariant with `UnitTest` verification instead of `GraphCheck` or `AstGate`, **then** `GraphGc.decide` and `OntologyInvariants.decide` **shall** report a finding. | OntologyInvariants.decide | test |
| REQ-5.5 | Unwanted behaviour | **If** a workspace package under `libs/*/*` contains an empty `export {}` source module in `src/` or declares a `dependencies` entry in `package.json` that is never imported in `src/`, **then** `scanWorkspacePackageHygiene` in `GraphGc.decide` **shall** report `empty-source-module` or `unused-package-dependency`. | GraphGc.decide | test |

### 6 · Multi-repository Omnigraph cluster isolation and shared worktree branching

**Source (multi-repository runtime audit 2026-10-29):** An `omnigraph-server` instance booted by `effect-es` on hardcoded port `127.0.0.1:8080` (`--cluster file:///.../effect-es/.harness/omnigraph-cluster`) caused `effect-ts-harness` to pass `checkOmnigraphServerReady("http://127.0.0.1:8080")` and read/write `effect-es`'s graph cluster, while `HARNESS_WORKTREE_ID` and linked git worktrees resolved separate `omnigraph-cluster` directories instead of sharing the canonical repository root cluster via branches.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-6.1 | Event-driven | **When** `resolveCanonicalRepoRoot` and `resolveOmnigraphClusterDir` resolve the Omnigraph cluster path from a main checkout, a linked `git worktree` (`.git` file pointing to `gitdir: .../.git/worktrees/<name>`), or `HARNESS_WORKTREE_ID`, the worktree resolver **shall** resolve the shared canonical main repository root (`<canonicalRepoRoot>/.harness/omnigraph-cluster`) while scoping task branch names (`plan/wt-<id>`, `impl/wt-<id>`) via `resolveOmnigraphTaskBranches`. | SessionHandoff.decide | test |
| REQ-6.2 | Event-driven | **When** `deriveRepoOmnigraphPort` and `ensureLocalOmnigraphReady` initialize or check a repository's local `omnigraph-server`, the CLI runner **shall** derive a deterministic repository-specific port (`18080..28079`) from `sha256(canonicalRepoRoot)`, persist `<clusterRootDir>/server.json` (`pid`, `port`, `baseUrl`, `canonicalRepoRoot`), and verify that the running server belongs to `canonicalRepoRoot` so concurrent repositories never collide on port `8080` or overwrite each other's graphs. | SessionHandoff.decide | test |
| REQ-6.3 | Unwanted behaviour | **If** `ensureLocalOmnigraphReady` restarts a drifted or stale `omnigraph-server` for `clusterRootDir`, **then** the process manager **shall** terminate only the `omnigraph-server` process matching `clusterRootDir` (or the recorded PID in `server.json`) and never execute a global `pkill -f omnigraph-server` across other repositories. | SessionHandoff.decide | test |

## Assumptions

* Chained commands (`&&`, `||`, `;`) continue to return `"escalate"` in `classifyCommand` so `scenarios/01-clef-guard` (`s1-escalated-to-clef`) and `libs/harness/gates/test/policy.test.ts` (REQ-1.5) remain satisfied; because REQ-1.3 excludes `verdict=allow` escalations from health score penalties, escalated safe compound commands no longer degrade the session grade.
* `tools/oxlint/syntax-bans.js` is not modified so that existing exact-message unit tests in `apps/harness-cli/test/index.test.ts` and `classifyFileWrite` governance rules remain untouched; Effect v4 `Schema.Int.check(Schema.isGreaterThan(0))` and `Schema.TaggedError<Self>()("Tag", ...)` idioms are documented in `agent-patterns/*.md` and skills.

## Acceptance criteria

* Every REQ-1.x through REQ-6.x row has passing unit tests across `libs/harness/gates/test/`, `libs/harness/graph/test/`, `libs/harness/decision/test/`, `apps/harness-cli/test/`, and `apps/harness-mcp/test/`.
* Re-evaluating the `effect-es` PR #3 session telemetry with the updated `decideSessionReport` and `scopeSessionReportInput` recovers all 62 session events (`planBeforeVerify: true`) and scores Grade A.
* `pnpm harness plan-check`, `pnpm harness gc --strict`, and `pnpm harness verify` exit `0`.
