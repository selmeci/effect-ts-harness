---
id: harness:ADR-0013
title: Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split
status: accepted
date: 2026-11-14
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/index.ts
  - libs/harness/contract/src/stub.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/contract/src/tier-topology.ts
  - libs/harness/contract/src/cache-and-daemon.ts
  - libs/harness/service/src/index.ts
  - libs/harness/service/src/cache-and-daemon-ports.ts
  - libs/harness/service/src/host-io.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/plugins/harness-tier-topology.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/plugins/ast-gate-law-helpers.ts
  - libs/harness/gates/src/plugins/gc/gc-package-and-migration.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-rule-ids.ts
  - libs/harness/gates/src/services/workspace-fs.ts
  - libs/harness/decision/src/learn-decision.ts
  - libs/harness/decision/src/ontology-conflict-decision.ts
  - libs/harness/decision/src/plan-coverage-decision.ts
  - libs/harness/infra/src/index.ts
  - libs/harness/infra/src/active-mutant-context-live.ts
  - libs/harness/infra/src/workspace-fs-live.ts
  - libs/harness/infra/src/subprocess-runner-live.ts
  - libs/harness/infra/src/ast-gate-cache-live.ts
  - libs/harness/infra/src/ast-gate-cache-helpers.ts
  - libs/harness/infra/src/decision-cache-live.ts
  - libs/harness/infra/src/local-decision-model-live.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/node-host-io.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/repo-checks.command.ts
  - apps/harness-cli/src/commands/scenario.command.ts
  - apps/harness-cli/src/commands/scenario-eval.ts
  - apps/harness-cli/src/commands/verify-delta-gates.ts
  - apps/harness-mcp/src/managed-runtime.ts
  - apps/harness-mcp/src/server.ts
  - apps/harness-mcp/src/daemon/unix-socket-daemon.ts
  - apps/harness-mcp/src/daemon/ast-gate-daemon-helper.ts
  - tools/oxlint/syntax-bans.js
spans:
  - HarnessTierTopology.decide
  - SelfDogfooding.decide
  - GraphGc.decide
  - AstGateCache.decide
  - WorkspaceFs.statAndReadAll
  - WorkspaceFs.readAndVerifyFile
  - HarnessSubprocess.execChecked
  - MutationCheck.withActiveMutant
  - AstGateCache.evaluateCached
  - DecisionCache.lookupOrCompute
  - UnixSocketDaemon.startScoped
  - Harness.proposeLearningAction
  - Harness.checkOntologyPairConflict
  - OntologyConflict.extractPairs
  - Harness.evaluateOntologyConflicts
  - Harness.checkPlanStepCoverage
  - HarnessCli.readStdin
  - HarnessCli.runDeclarativeCli
  - HarnessCli.checkOpenApi
  - HarnessCli.checkMigrations
  - HarnessCli.checkEventSchemas
  - HarnessCli.runScenario
  - HarnessMcp.executeManagedTool
services:
  - "@harness/service/WorkspaceFs"
  - "@harness/service/HarnessSubprocessRunner"
  - "@harness/service/ActiveMutantContext"
  - "@harness/service/AstGateCachePort"
  - "@harness/service/DecisionCachePort"
  - "@harness/service/UnixSocketDaemonPort"
errors:
  - WorkspaceFsError
  - HarnessSubprocessError
  - SelfDogfoodingViolationError
  - TsCompilerOverlayError
  - CliCommandNotFoundError
  - UnknownToolError
  - DaemonServerError
  - StdinReadError
informs:
  - harness:SPEC-0012
---

# ADR-0013 · Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split

## Context and Problem Statement

As documented in [RFC-0009](../../../../docs/rfcs/0009-true-hexagonal-closure-and-effect-v4-runtime.md), previously the harness packages under `libs/harness/gates`, `libs/harness/graph`, and `libs/harness/ingest` carried dual Nx tags (`["type:contract", "type:service"]`) and co-located `effect/Schema` wire contracts, `Context.Service` capability ports, pure `*.decide` functions, and live Node/filesystem `Layer` implementations inside the same packages. Because `stub<A, E, R>` and shared gate schemas lived inside `@harness/gates`, `type:core` and `type:domain` libraries could not import `stub` or harness contract schemas without transitively pulling in `@harness/gates` infrastructure and Node-specific dependencies.

Leaving these dual tier tags and mixed contract-service-infra boundaries in place allows circular architectural coupling across harness packages, violates the five-tier hexagonal Nx taxonomy (`type:contract` → `type:service` → `type:domain`/`type:core` → `type:infra` → `type:app`), and prevents deterministic graph verification of pure contract and service boundaries.

## Decision Drivers

- **Strict Five-Tier Hexagonal Separation:** Every harness library must declare a single canonical Nx tier tag (`type:contract`, `type:service`, `type:core`/`type:domain`, or `type:infra`) with zero dual `["type:contract", "type:service"]` tags.
- **Pure `effect`-Only Contract Boundary (`@harness/contract`):** Shared schemas, tagged errors, AST/gate primitives, and `stub<A, E, R>` must live in `@harness/contract` (`type:contract`) with only `effect` as a runtime dependency so any domain or core package can import them without pulling in I/O or `gates`.
- **Pure Service Port Boundary (`@harness/service`):** `Context.Service` capability interfaces (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`) must be declared in `@harness/service` (`type:service`) importing only `@harness/contract` and `effect`, free of Node or infrastructure imports.
- **Deterministic Tier-Topology Enforcement:** A pure `R = never` decider (`HarnessTierTopology.decide`) must validate `project.json` tags, dependency edges, and service-tier imports on every `pnpm harness gc --strict` and `pnpm harness verify` run.

## Considered Options

- **Option 1:** Extract dedicated @harness/contract and @harness/service packages and eliminate dual Nx tier tags
- **Option 2:** Retain dual-tagged ["type:contract", "type:service"] packages
- **Option 3:** Collapse all harness libraries into a single monolithic package
- **Option 4:** Retain transitional backward-compatibility re-export shims in @harness/gates and duplicate layer aliases in @harness/infra

## Decision Outcome

**Chosen option:** "Option 1: Extract dedicated @harness/contract and @harness/service packages and eliminate dual Nx tier tags", because it aligns `libs/harness/*` with the workspace's five-tier hexagonal architecture, isolates `stub` and all shared schemas in `effect`-only `@harness/contract`, decouples `Context.Service` ports in `@harness/service` from live `Layer` implementations in `@harness/infra` (while pure in-memory registries/overlays such as `GatePluginRegistryLive` and `SpanRecorder.layer` remain in `type:core`), and enables deterministic verification via `HarnessTierTopology.decide`.

### Architectural Rules and Guarantees

1. `@harness/contract` (`libs/harness/contract`) carries `type:contract` only, depends exclusively on `effect` (0 workspace dependencies), and exports `stub`, `WorkspaceFsError`, `HarnessSubprocessError`, `SelfDogfoodingViolationError`, `TsCompilerOverlayError`, `CliCommandNotFoundError`, `UnknownToolError`, `DaemonServerError`, `StdinReadError`, subprocess validation, cache/daemon schemas, and discriminated union report schemas (`SelfDogfoodingReport`, `HarnessTierTopologyReport`, `AstGateEvaluationReport`, `AstGateDecisionReport` — each a `Schema.Union` of `{ verdict: "clean", violations: readonly [] }` vs `{ verdict: "violated", violations: NonEmptyArray<...> }`).
2. `@harness/service` (`libs/harness/service`) carries `type:service` only, depends exclusively on `effect` and `@harness/contract`, and exports pure `Context.Service` ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`) from its main barrel, while isolating `SyncHostIo` and `ExtendedHostIo` strictly on the `@harness/service/host-io` subpath (never exported from `@harness/service` main barrel or `@harness/ingest`) without Node, `Layer.*`, `type:core`, `type:domain`, or `type:infra` imports.
3. Every workspace package declares a single canonical `type:*` Nx tier tag (`@harness/{gates,graph,decision,ingest}` carry `type:core`), and no project may declare `0` or `>1` `type:*` tags in `package.json` or `project.json` (`dual-contract-tier-tag`). Tier matrix:
   - `type:contract` → `effect` only (workspace: `type:contract` / `[]`; forbidden: `service`, `core`, `domain`, `infra`, `app`, 3rd-party I/O)
   - `type:service` → `type:contract`, `type:service` (external: `effect` only; forbidden: `core`, `domain`, `infra`, `app`, Node/SQL drivers)
   - `type:core` → `type:contract`, `type:service`, `type:core` (forbidden: `type:domain`, `type:infra`, `type:app`)
   - `type:domain` → `type:contract`, `type:service`, `type:core`, `type:domain` (forbidden: `type:infra`, `type:app`, `alchemy`, `@effect/sql-*`)
   - `type:infra` → `type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra` (forbidden: `type:app`; `drizzle-orm`/`drizzle-kit` banned workspace-wide)
   - `type:app` → all library tiers + `type:app` (except `scope:web`, which may import `type:contract` and UI libraries only)
     `undeclared-workspace-dependency` verifies every `src/` `@harness/*` import is declared in `package.json` `dependencies`.
4. `WorkspaceFs` in `@harness/service` exposes `{ readTextFile, writeTextFileAtomic, exists }` behind the `@harness/service/WorkspaceFs` capability seam, failing with typed `WorkspaceFsError`, while `@harness/gates` provides `statAndReadWorkspaceFiles` (traced as `Effect.fn("WorkspaceFs.statAndReadAll")`) reading UTF-8 text via `WorkspaceFs.readTextFile` with bounded concurrency (`16`) and computing line counts into `WorkspaceFileStat` (`{ filePath, content, lineCount }`), and `WorkspaceFs.exists` returns `Effect<boolean, WorkspaceFsError>` (returning `false` only on `ENOENT`/`NotFound` and failing with `WorkspaceFsError` on `EACCES`/`EIO`/`ELOOP`).
5. `@harness/infra` (`libs/harness/infra`) carries `type:infra` only, depends only on `@harness/contract`, `@harness/service`, and `@harness/graph` (zero imports from `@harness/decision`, `@harness/gates`, or `@harness/ingest`), and exclusively owns all host OS filesystem, subprocess, persistent disk cache, Unix socket daemon, and `LocalDecisionModel` Live Layers:
   - `WorkspaceFsLive`, `HarnessSubprocessRunnerLive`, and `ActiveMutantContextLive`.
   - `LocalDecisionModel` (`makeLocalDecisionModelLayer` in `libs/harness/infra/src/local-decision-model-live.ts` using `@effect/ai-typesafe` + `FetchHttpClient.layer`) so `@harness/decision` (`type:core`) stays 100% pure.
   - `AstGateCacheLive` (`makeAstGateCacheLayer` wired into `verify-delta-gates.ts`, `unix-socket-daemon.ts` via `handleDaemonAstGatesRequest`, and `HarnessInfraLive` via `resolveAstGateCachePath`, honouring `HARNESS_STATE_DIR` and `HARNESS_WORKTREE_ID` and defaulting to `<repoRoot>/.harness/cache/ast-gate-cache-v1.json`) backs persistent production AST gate evaluation using an injected `AstGateFileEvaluator` (zero `infra -> gates` imports), `ScopedCache.makeWith` (with `Duration.zero` TTL on failure exits so failures are never negative-cached), `SynchronizedRef`, and `FileSystem.FileSystem`. Cache keys derive automatically from `computeGateRuleVersionFromSources` in `@harness/contract` hashing `@harness/gates` `AST_GATE_RULE_SOURCE_FILES` and `AST_GATE_TYPESCRIPT_VERSION` (`ts.version`), with `checkAstGateRuleClosure` enforcing transitive runtime closure in `GraphGc.decide`. `makeAstGateCacheLayer` resolves rule hashes lazily inside `SynchronizedRef`, falls back to non-clobbering, non-memoizing `Uncached` mode when any rule source fails or is symlinked, resets legacy envelopes without corrupt warnings via envelope-first decoding, refuses symlinked cache files with `WorkspaceFsError`, merges concurrent disk writes read-before-write via `readActiveEntriesForMerge`, and rejects stale daemon rule hashes (`fallbackToInProcess: true` after closing child port scopes), while `AstGateCache.decide` provides pure in-call `Map` deduplication for standalone CLI checks (`check-migrations`, `mutate`, `gc`).
   - `DecisionCacheLive` using per-key `Deferred` single-flight deduplication (`Ref` + `Deferred`) with `SynchronizedRef` and `FileSystem.FileSystem` so per-call `ttlMillis` and heterogeneous `R` work cleanly without casts.
   - `UnixSocketDaemonLive` always setting `0o600` on the Unix socket file itself and `0o700` on the default repo-local `.harness` directory as well as any newly created custom parent directory (`!dirExistedBefore`), while skipping `chmodSync` on pre-existing external parent directories when `socketPathOverride` is supplied.
     Pure in-memory registries/overlays (`GatePluginRegistryLive`, `SpanRecorder.layer`, etc.) live in `type:core`.
6. Non-infra packages (everything outside `type:infra` `libs/*/infra/src/`, including `type:contract`, `type:service`, `type:core`, `type:domain`, and `type:app`) must maintain zero `node:*` or bare Node built-in imports except `{path, path/posix, path/win32, crypto, url}` (`no-node-builtins-outside-infra`) and zero global mutable caches. `SyncHostIo` / `ExtendedHostIo` (`@harness/service/host-io`) back synchronous `ts.CompilerHost` callbacks and synchronous gate/extractor bridges (`mutation-check`, `compiler-session`), with an optional `ts.sys` fallback when standalone callers omit `hostIo`.
7. `apps/harness-cli/src/index.ts` executes via `NodeRuntime.runMain` over `HarnessCli.runDeclarativeCli` (`effect/cli` `Command.make`, `Flag`, `Argument`, reporting defects on `stderr` via `Cause.pretty` and failing closed on `StdinReadError` in hook guards), exposing typed subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`) with zero production `Effect.runSync` or `Effect.runPromise` calls.
8. `apps/harness-mcp` uses three scoped `ManagedRuntime` boundaries — `makeMcpManagedRuntime` (`src/managed-runtime.ts`, merging `HarnessInfraLive`, `NodeServices.layer`, `makeLiveMcpToolRegistryLayer(options)`, and `Layer.succeed(Logger.LogToStderr, true)` plus optional `options.extraLayer` for tool dispatch), `cliRuntime` (`ManagedRuntime.make(NodeServices.layer)` in `src/server.ts` bridging `server.connect(transport)`), and `daemonRuntime` (`src/daemon/unix-socket-daemon.ts`) — bridging foreign async callbacks strictly via `ManagedRuntime.runPromiseExit` in `src/server.ts` and `src/daemon/unix-socket-daemon.ts` with zero production `Effect.runSync` calls.
9. `ast-gate-visitors.ts` deletes the `isHarnessInternal` exemption and `tools/oxlint/syntax-bans.js` (`isEnforcedWorkspaceFile`, covering every `libs/<scope>/<pkg>/` and `apps/<app>/` across the workspace) enforces `discriminant-branching` and `unscoped-effect-run`: `runFork` and `runForkWith` are allowed in `apps/*/src/` (`type:app` composition boundaries) and banned across all `libs/*/src/` tiers, whereas `runSync*`, `runPromise*` (except `ManagedRuntime.runPromiseExit` at the MCP transport/daemon edge in `apps/harness-mcp/src/server.ts` and `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`), and `runCallback*` are banned everywhere. `libs/es/infra/src/memory.ts` retains ONLY `Effect.runSync(Effect.die(...))` inside synchronous `WorkerdSqlCursor.one()` and `SqlStorage.exec` bridge methods (enforced by AST predicate, not a blanket file-wide `run*` exemption).
10. `SelfDogfooding.decide` (whose cache invalidation is driven automatically by `AST_GATE_RULE_SOURCE_FILES` + `AST_GATE_TYPESCRIPT_VERSION`, with `18` total `SelfDogfoodingRuleId` rules in `@harness/contract`) permanently enforces **10** hexagonal hygiene rules across production source files: `no-global-mutable-cache` (including mutated module-scope object literals), `no-node-builtins-outside-infra` (banning static and dynamic `node:*` / bare Node built-ins outside `type:infra` `libs/*/infra/src/` except `{path, path/posix, path/win32, crypto, url}`; `type:app` is also enforced), `no-layer-build-in-layer-effect`, `no-double-wrapped-effect-fn`, `silent-gate-fs-fallback`, `test-env-branch-in-src`, `bare-cause-has-interrupts`, `process-env-outside-infra-or-app`, expanded `facade-star-reexport` across all `libs/**/src/index.ts`, `apps/**/src/index.ts`, and the 5 `@harness/graph` orchestrator facades (`isGraphOrchestratorFacadePath`) barrels, and `dynamic-harness-import` (banning dynamic `import("@harness/...")` and `require("@harness/...")` across `src/` and `test/`).
11. Zero transitional backward-compatibility re-export shims or duplicate layer aliases may remain in `@harness/gates` or `@harness/infra`: all consumers import contracts and `stub` directly from `@harness/contract`, canonical `@harness/service/*` ports from `@harness/service`, and canonical `*Live` layers from `@harness/infra`.

## Rejected Alternatives

### 1 · Option 2: Retain dual-tagged ["type:contract", "type:service"] packages

Keep schemas, `stub`, `Context.Service` ports, and live Node `Layer` implementations inside `libs/harness/{gates,graph,ingest}` with dual `["type:contract", "type:service"]` Nx tags.

**Why rejected:** Dual tier tags bypass Nx module-boundary checks, force `type:core` and `type:domain` packages to depend on `@harness/gates` just to use `stub`, and allow `type:service` ports to import Node I/O modules directly.

### 2 · Option 3: Collapse all harness libraries into a single monolithic package

Merge `ingest`, `decision`, `gates`, `graph`, `contract`, and `service` into one monolithic core package.

**Why rejected:** A monolithic harness package erases compile-time tier boundaries, slows incremental `nx affected` builds, and makes it impossible to enforce pure `R = never` deciders separately from stateful `Layer` providers.

### 3 · Option 4: Retain transitional backward-compatibility re-export shims in @harness/gates and duplicate layer aliases in @harness/infra

Keep `@harness/gates/src/stub.ts`, transitional `@harness/contract` / `@harness/service` re-exports in `@harness/gates`, and duplicate `*NodeLive` layer aliases in `@harness/infra` as compatibility shims.

**Why rejected:** Transitional re-export shims preserve indirect coupling to `@harness/gates`, mask dead exports from `GraphGc.decide` (`unused-contract-export`), and perpetuate ambiguous `@harness/service/*` vs. legacy service tag IDs.

## Consequences and Enforcement

### Positive Consequences

- `type:core` and `type:domain` packages import `stub` and gate schemas from `@harness/contract` with zero transitive infrastructure dependencies.
- `@harness/service` capability ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`) can be satisfied by in-memory test `Layer`s without loading Node filesystem or subprocess modules.
- `HarnessTierTopology.decide` deterministically catches any regression in Nx tier tags, contract/service/core dependencies, or impure service-tier imports.

### Negative Consequences and Trade-offs

- Adding a new harness schema or `Context.Service` capability requires placing the schema/error in `libs/harness/contract`, the port in `libs/harness/service`, and the live `Layer` in `libs/harness/infra`.
- Synchronous `ts.CompilerHost` / `ts-morph` APIs still require the synchronous `SyncHostIo` port interface (`nodeSyncHostIo` in `@harness/infra`) rather than asynchronous `WorkspaceFs` effects.

### Deterministic Enforcement

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Enforced By                                                                                                                                                                                                                                                                                                                                                                                  | Gate / Mechanism                                                                                | Governed Symbols                                                                                                                                                                                                                        |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reject zero or multiple `type:*` Nx tags (`dual-contract-tier-tag`) and workspace-wide `drizzle-orm`/`drizzle-kit` dependencies (`banned-workspace-dependency`)                                                                                                                                                                                                                                                                                                                                                                                                                            | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts`                                                                                                                                                                                                                                                                                      | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`)               | `HarnessTierTopology.decide`                                                                                                                                                                                                            |
| Enforce `effect`-only dependencies on `type:contract` packages (`forbidden-contract-dependency`) and `effect`/`type:contract`/`type:service` on `type:service` (`forbidden-service-dependency`)                                                                                                                                                                                                                                                                                                                                                                                            | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts`                                                                                                                                                                                                                                                                                      | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`)               | `HarnessTierTopology.decide`                                                                                                                                                                                                            |
| Enforce tier boundaries across `type:core` (`forbidden-core-dependency`), `type:domain` (`forbidden-domain-dependency`), `type:infra` (`forbidden-infra-dependency`), `scope:web` (`forbidden-web-app-dependency`), and undeclared imports (`undeclared-workspace-dependency`)                                                                                                                                                                                                                                                                                                             | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts`                                                                                                                                                                                                                                                                                      | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`)               | `HarnessTierTopology.decide`                                                                                                                                                                                                            |
| Ban Node/Layer/higher-tier imports inside `type:service` source files (`impure-service-tier-import`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts`                                                                                                                                                                                                                                                                                      | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`)               | `HarnessTierTopology.decide`                                                                                                                                                                                                            |
| `WorkspaceFs` `{ readTextFile, writeTextFileAtomic, exists }` port + `@harness/gates` `statAndReadWorkspaceFiles` (`WorkspaceFs.statAndReadAll` span, bounded concurrency `16` into `WorkspaceFileStat`) and `Effect<boolean, WorkspaceFsError>` via `WorkspaceFs.exists` (`false` only on `ENOENT`/`NotFound`)                                                                                                                                                                                                                                                                            | `libs/harness/gates/src/services/workspace-fs.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workspace-fs-live.ts`                                                                                                                                                                                                                                                        | `pnpm harness gc --strict` & `pnpm harness verify`                                              | `WorkspaceFs.statAndReadAll`, `WorkspaceFs.readAndVerifyFile`, `WorkspaceFsError`, `@harness/service/WorkspaceFs`                                                                                                                       |
| Native Effect v4 `@harness/infra` (`type:infra`) adapters over `@effect/platform-node` (`NodeServices.layer`, `FileSystem.FileSystem`, `Path.Path`, `ChildProcessSpawner`, `ScopedCache.makeWith` with `Duration.zero` failure TTL, automatic `computeGateRuleVersionFromSources` over `AST_GATE_RULE_SOURCE_FILES` + `AST_GATE_TYPESCRIPT_VERSION`, lazy non-clobbering `Uncached` fallback, envelope-first upgrade, and daemon startup-vs-disk drift rejection for `AstGateCacheLive`; per-key `Ref` + `Deferred` single-flight deduplication for `DecisionCacheLive`; `SynchronizedRef`, `Effect.acquireRelease`) and `LocalDecisionModel` with zero Node host I/O imports or global mutable caches in non-infra `libs/harness/*` | `libs/harness/contract/src/cache-and-daemon.ts`, `libs/harness/gates/src/ast-cache.ts`, `libs/harness/gates/src/plugins/gc/gc-rule-ids.ts`, `libs/harness/infra/src/index.ts`, `libs/harness/infra/src/ast-gate-cache-live.ts`, `libs/harness/infra/src/ast-gate-cache-helpers.ts`, `libs/harness/infra/src/decision-cache-live.ts`, `libs/harness/infra/src/local-decision-model-live.ts`, `libs/harness/infra/src/workspace-fs-live.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/infra/src/subprocess-runner-live.ts`, `libs/harness/infra/src/node-host-io.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-mcp/src/daemon/ast-gate-daemon-helper.ts` | `pnpm harness gc --strict` & `pnpm harness verify` | `AstGateCache.evaluateCached`, `DecisionCache.lookupOrCompute`, `UnixSocketDaemon.startScoped`, `@harness/service/AstGateCachePort`, `@harness/service/DecisionCachePort`, `@harness/service/UnixSocketDaemonPort`, `DaemonServerError` |
| Declarative `effect/cli` + `NodeRuntime.runMain` entry with fail-closed `StdinReadError` handling, typed repo-check & scenario subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`), and zero production `Effect.runSync`                                                                                                                                                                                                                                                                                                                     | `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`, `apps/harness-cli/src/commands/declarative-cli.ts`, `apps/harness-cli/src/commands/repo-checks.command.ts`, `apps/harness-cli/src/commands/scenario.command.ts`, `apps/harness-cli/src/commands/scenario-eval.ts`                                                                                                           | `pnpm harness gc --strict` & `pnpm harness verify`                                              | `HarnessCli.readStdin`, `HarnessCli.runDeclarativeCli`, `HarnessCli.checkOpenApi`, `HarnessCli.checkMigrations`, `HarnessCli.checkEventSchemas`, `HarnessCli.runScenario`, `StdinReadError`                                             |
| Three scoped `ManagedRuntime` boundaries (`makeMcpManagedRuntime`, `cliRuntime`, `daemonRuntime`) in `apps/harness-mcp` with zero production `Effect.runSync`                                                                                                                                                                                                                                                                                                                                                                                                                              | `apps/harness-mcp/src/managed-runtime.ts`, `apps/harness-mcp/src/server.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`                                                                                                                                                                                                                                                             | `pnpm harness gc --strict` & `pnpm harness verify`                                              | `HarnessMcp.executeManagedTool`                                                                                                                                                                                                         |
| Uniform AST enforcement across every `libs/<scope>/<pkg>/` and `apps/<app>/` via `isEnforcedWorkspaceFile` without `isHarnessInternal` (`discriminant-branching`, `unscoped-effect-run` allowing `runFork`/`runForkWith` in `apps/*/src/` only and `Effect.runSync(Effect.die(...))` in `libs/es/infra/src/memory.ts` inside synchronous `WorkerdSqlCursor.one()` / `SqlStorage.exec` bridge methods via AST predicate)                                                                                                                                                                    | `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/plugins/ast-gate-law-helpers.ts`, `apps/harness-cli/src/commands/verify-delta-gates.ts`, `tools/oxlint/syntax-bans.js`                                                                                                                                                                                        | `AstGateCache.decide` (`pnpm harness gc --strict` & `pnpm harness verify`)                      | `AstGateCache.decide`                                                                                                                                                                                                                   |
| **10** permanent hexagonal self-dogfooding rules automatically invalidated via `AST_GATE_RULE_SOURCE_FILES` + `AST_GATE_TYPESCRIPT_VERSION` (`no-global-mutable-cache`, `no-node-builtins-outside-infra`, `no-layer-build-in-layer-effect`, `no-double-wrapped-effect-fn`, `silent-gate-fs-fallback`, `test-env-branch-in-src`, `bare-cause-has-interrupts`, `process-env-outside-infra-or-app`, expanded `facade-star-reexport` on all `libs/**/src/index.ts` and `apps/**/src/index.ts`, `dynamic-harness-import`; `18` total `SelfDogfooding.decide` rules) and test migration hygiene (`inline-test-ddl-bypassing-migrations`) | `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`, `libs/harness/gates/src/plugins/ast-gate-law-helpers.ts`, `libs/harness/gates/src/plugins/gc/gc-package-and-migration.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-rule-ids.ts` | `SelfDogfooding.decide` & `GraphGc.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `SelfDogfooding.decide`, `GraphGc.decide`                                                                                                                                                                                               |
