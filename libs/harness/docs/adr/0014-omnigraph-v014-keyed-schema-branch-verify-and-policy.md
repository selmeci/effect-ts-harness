---
id: harness:ADR-0014
title: Omnigraph v0.14.0 Keyed Incidence Schema, Lossless Branch Lifecycle, Hybrid RRF Search, and Cedar Policy Enforcement
status: accepted
date: 2026-11-16
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/omnigraph.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/queries/harness.gq
  - libs/harness/graph/cluster.yaml
  - libs/harness/graph/graph.policy.yaml
  - libs/harness/graph/cluster.policy.yaml
  - libs/harness/graph/policy-tests.yaml
  - libs/harness/gates/src/omnigraph-branch-verify.ts
  - libs/harness/gates/src/omnigraph-lint.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - libs/harness/graph/src/omnigraph-operations.ts
  - libs/harness/graph/src/omnigraph-v014-ops.ts
  - libs/harness/service/src/host-io.ts
  - libs/harness/infra/src/node-host-io.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle.ts
  - apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts
  - apps/harness-cli/src/commands/omnigraph-safety-helpers.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/done-omnigraph-helpers.ts
  - apps/harness-cli/src/commands/gc-and-ontology.command.ts
  - apps/harness-mcp/src/daemon/unix-socket-daemon.ts
  - tools/omnigraph-mcp-launcher.mjs
spans:
  - OmnigraphSync.sync
  - OmnigraphSync.mergeBranch
  - OmnigraphSync.dryRunMerge
  - OmnigraphSync.mutateConditional
  - OmnigraphSync.pollChanges
  - OmnigraphBranchVerify.decide
  - OmnigraphSchemaEvolution.decide
  - OmnigraphLint.decide
services:
  - "@harness/graph/OmnigraphSync"
errors:
  - OmnigraphPreconditionError
  - OmnigraphMergeConflictError
  - OmnigraphLintError
informs:
  - harness:SPEC-0013
---

# ADR-0014 · Omnigraph v0.14.0 Keyed Incidence Schema, Lossless Branch Lifecycle, Hybrid RRF Search, and Cedar Policy Enforcement

## Context and Problem Statement

In [RFC-0001](../../../../docs/rfcs/0001-polymorphic-hypergraph-and-pera-ontology-model.md)..[RFC-0003](../../../../docs/rfcs/0003-algebraic-graph-rewriting-dpo-auto-repair-and-planning.md), `harness:ADR-0006`, and `harness:ADR-0009`, `@modernrelay/omnigraph` v0.14.0 stores the workspace's PERA Bipartite Levi Incidence Hypergraph across `plan/*`, `impl/*`, and `main` branches. However, as documented in [RFC-0009](../../../../docs/rfcs/0009-omnigraph-v014-native-capabilities-and-harness-integration.md), unkeyed `Plays*Role` edges in `libs/harness/graph/schema.pg` cause `mode: "merge"` loads to duplicate edges on `main`, pre-load `og.branches.delete` calls erase task branch commit history, `rmRecursiveSync` on `.config-stamp` drift destroys `.harness/omnigraph-cluster`, `diffOmnigraphBranches` results are discarded, `dryRun: true` merge checks never run during `verify`, and Cedar policies in `graph.policy.yaml` remain unmounted in `cluster.yaml`.

Leaving these workarounds in place undermines graph integrity, hides concurrent worktree merge conflicts until `done`, wipes Lance branch lineage on additive schema or query updates, and leaves `main` unprotected at the database authorization layer.

## Decision Drivers

- **Zero Edge Duplication & Lossless Branch Lineage:** Guarantee idempotent edge identity and accurate deletion of removed symbols on `plan/*` and `impl/*` without deleting task branch commit history.
- **Deterministic Merge Conflict & Plan Refinement Gates:** Surface concurrent branch merge conflicts and dropped or stubbed planned symbols deterministically during `pnpm harness verify` via pure `R = never` deciders.
- **Database-Layer Policy Protection & OCC:** Protect `main` at the storage authorization layer via mounted Cedar policy bundles (`protected_branches: [main]`) and Optimistic Concurrency Control (`ifGraphCommit` / HTTP `412`).
- **Native Hybrid Search & Incremental Change-Feed Sync:** Accelerate semantic routing and typed-hole completion via native scope-first `rrf(nearest(...), bm25(...))` search and keep `DatalogSession` incrementally synchronized via `og.changes.poll`.
- **Offline Schema/Query Validation & Non-Destructive Evolution:** Validate `.pg` and `.gq` files offline via `omnigraph lint` and evolve live clusters via `cluster apply` rather than `rmRecursiveSync`.

## Considered Options

- **Option 1:** Keyed role edges (`@key(@src, @dst, role)`), `mode: "overwrite"` branch sync, pure `OmnigraphBranchVerify.decide` + `OmnigraphSchemaEvolution.decide` + `OmnigraphLint.decide`, mounted Cedar policies, hybrid RRF search, OCC `ifGraphCommit`, `changes.poll` incremental Datalog sync, unpublished DPO commit proposals, and `Blob` / `omnigraph optimize` maintenance.
- **Option 2:** Retain unkeyed edges with `og.branches.delete` before load, `rmRecursiveSync` on config drift, and TypeScript-only JSON snapshot diffing.
- **Option 3:** Introduce a separate external vector/SQLite search service alongside Omnigraph for semantic pattern and hole search.

## Decision Outcome

**Chosen option:** "Option 1: Keyed role edges (`@key(@src, @dst, role)`), `mode: "overwrite"` branch sync, pure `OmnigraphBranchVerify.decide` + `OmnigraphSchemaEvolution.decide` + `OmnigraphLint.decide`, mounted Cedar policies, hybrid RRF search, OCC `ifGraphCommit`, `changes.poll` incremental Datalog sync, unpublished DPO commit proposals, and `Blob` / `omnigraph optimize` maintenance", because it eliminates edge duplication and destructive branch/cluster wipes while unifying branch verification, hybrid search, Cedar authorization, and incremental Datalog synchronization natively inside Omnigraph v0.14.0.

### Architectural Rules and Guarantees

1. **Keyed Incidence Edges & Lossless Sync (`OMNI-01`):** All 32 `Plays*Role` edges in `libs/harness/graph/schema.pg` declare `@key(@src, @dst, role)`. Task branch loads (`plan/*`, `impl/*`) in `OmnigraphSync.sync` (`syncToOmnigraphAndSnapshot`) use `mode: "overwrite"` without calling `og.branches.delete(branch)` prior to loading, preserving full branch commit history.
2. **Hybrid RRF Search & GQ 2.1 Suite (`OMNI-02`, `OMNI-05`, `OMNI-06`):** `schema.pg` declares `@index` text fields, nullable `Vector(768)? @embed(...)` columns, `@instruction` / `@description` annotations, and `GraphPolicy` nodes. `libs/harness/graph/queries/harness.gq` provides scope-first `rrf(nearest(...), bm25(...))`, `fuzzy(..., 2)`, multi-hop `{1,5}` traversals, and `EarsSpec` + `AdrDoc` union queries (`ontology_realized_by_doc`).
3. **Branch Diff & Dry-Run Merge Gate (`OMNI-03`):** Only the pure deciders (`decideOmnigraphBranchVerify`, `decideOmnigraphSchemaEvolution`, `decideOmnigraphLint`) execute with `R = never`. `OmnigraphBranchVerify.decide` (`decideOmnigraphBranchVerify`, `R = never`) evaluates `OmnigraphBranchDiff` and `dryRunConflicts` during `verify`. By contrast, `OmnigraphSync.dryRunMerge` (`dryRunMergeOmnigraphBranches`) and `OmnigraphSync.mergeBranch` (`mergeOmnigraphBranch`) run in `@harness/graph` with `R = OmnigraphSync`: `dryRunMergeOmnigraphBranches` fails with `OmnigraphMergeConflictError` on `ConflictError`, and `mergeOmnigraphBranch` passes `deleteBranch: true` on `done`.
4. **OCC Preconditions & Change-Feed Datalog Sync (`OMNI-04`):** `OmnigraphSync.mutateConditional` (`mutateOmnigraphConditional`) and `OmnigraphSync.pollChanges` (`pollOmnigraphChanges`) run in `@harness/graph` with `R = OmnigraphSync`. `mutateOmnigraphConditional` passes `ifGraphCommit` (`Omnigraph-If-Graph-Commit`) and fails with `OmnigraphPreconditionError` on HTTP `412`. `pollOmnigraphChanges` feeds `DatalogSession.stepFileDelta` in `apps/harness-mcp/src/daemon/unix-socket-daemon.ts` with `og.changes.baseline` recovery on HTTP `410`.
5. **Offline Lint, Non-Destructive Evolution & Cedar Policies (`OMNI-07`, `OMNI-08`):** `OmnigraphLint.decide` (`decideOmnigraphLint`, `R = never`) fails with `OmnigraphLintError` on non-empty `omnigraph lint --json` errors. `OmnigraphSchemaEvolution.decide` (`decideOmnigraphSchemaEvolution`, `R = never`) selects `LiveClusterApply` for additive schema or query updates rather than wiping `.harness/omnigraph-cluster`. `cluster.yaml` mounts the single `graph-access` bundle from `graph.policy.yaml` (`protected_branches: [main]`, `admins: [harness-cli]`), while `cluster.policy.yaml` is retained on disk as reference because Omnigraph CLI rejects mounting multiple bundles simultaneously (`matches 2 policy bundles`). Per-actor Bearer tokens (`harness-cli`, `agent-mcp`) are persisted in `auth-tokens.json` (`0o600`, omitted from `server.json`), passed via `OMNIGRAPH_SERVER_BEARER_TOKENS_JSON` without `--unauthenticated`, and verified by `tools/omnigraph-mcp-launcher.mjs`.
6. **DPO Proposals, Blob Artifacts & Lance Maintenance (`OMNI-09`, `OMNI-10`):** `OmnigraphSync` supports unpublished commit proposals (`commits.changes` / `publish` / `drop`), `og.blobs` reads/writes for `spanTraceBlob` and `markdownBlob`, and `omnigraph optimize` / `omnigraph cleanup` maintenance during `gc` and `done`.

## Rejected Alternatives

### 1 · Option 2: Unkeyed Edges + `branches.delete` + `rmRecursiveSync`

Retain unkeyed `Plays*Role` edges with `og.branches.delete` before every load, `rmRecursiveSync` on `.config-stamp` drift, and TypeScript-only JSON snapshot diffing.

**Why rejected:** Duplicates unkeyed edges on `main` during `merge` loads, discards branch history required by `mergeBase` and `branches.diff`, and wipes all Lance state whenever a single query is added to `harness.gq`.

### 2 · Option 3: External Sidecar Vector Index Outside Omnigraph

Introduce a separate external vector/SQLite search service alongside Omnigraph for semantic pattern and typed-hole search.

**Why rejected:** Breaks the single-source-of-truth PERA hypergraph and forfeits DataFusion's Scope-First, Rank-Second traversal + `rrf` join execution inside Omnigraph.

## Consequences and Enforcement

### Positive Consequences

- Exact, idempotent graph representation with zero duplicate edges on `main` and full commit lineage across `plan/*` and `impl/*`.
- Early conflict detection across concurrent worktrees during `verify`, stop-daemon plus `omnigraph cluster apply` (preserving Lance state without `rmRecursiveSync`) before restart on additive edits, under 8 ms hybrid search, and under 15 ms offline `.pg`/`.gq` linting.

### Negative Consequences and Trade-offs

- Requires a one-time clean-slate rebuild of `.harness/omnigraph-cluster` (`rfc-0009-v2` epoch) because Omnigraph v0.14.0 refuses adding `@key(...)` to existing unkeyed edge types in place.
- Requires local `nomic-embed-text` embeddings (or nullable `Vector(768)?` fallback) when evaluating ANN arms.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Keyed Role Edges & Lossless Sync (`OMNI-01`) | `libs/harness/graph/schema.pg`, `libs/harness/graph/src/omnigraph-sync.ts`, `libs/harness/graph/src/omnigraph-operations.ts` | `syncToOmnigraphAndSnapshot` (`@key(@src, @dst, role)` + `mode: "overwrite"`) | `OmnigraphSync.sync`, `@harness/graph/OmnigraphSync` |
| Offline Schema & GQ 2.1 Lint (`OMNI-07`) | `libs/harness/gates/src/omnigraph-lint.ts` | `decideOmnigraphLint` (`R = never`, `omnigraph lint --json`) | `OmnigraphLint.decide`, `OmnigraphLintError` |
| Dry-Run Merge & Plan Diff Gate (`OMNI-03`) | `libs/harness/gates/src/omnigraph-branch-verify.ts`, `libs/harness/graph/src/omnigraph-sync.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`, `libs/harness/graph/src/omnigraph-operations.ts`, `apps/harness-cli/src/commands/verify-and-done.command.ts`, `apps/harness-cli/src/commands/done-omnigraph-helpers.ts` | `decideOmnigraphBranchVerify` (`R = never`), `dryRunMergeOmnigraphBranches` (`R = OmnigraphSync`), `mergeOmnigraphBranch` (`R = OmnigraphSync`) | `OmnigraphBranchVerify.decide`, `OmnigraphMergeConflictError`, `OmnigraphSync.dryRunMerge`, `OmnigraphSync.mergeBranch` |
| OCC Preconditions & Change-Feed Datalog Sync (`OMNI-04`) | `libs/harness/graph/src/omnigraph-sync.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`, `libs/harness/graph/src/omnigraph-operations.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts` | `mutateOmnigraphConditional` (`R = OmnigraphSync`, `Omnigraph-If-Graph-Commit` / `og.changes.poll`), `pollOmnigraphChanges` (`R = OmnigraphSync`) | `OmnigraphSync.mutateConditional`, `OmnigraphSync.pollChanges`, `OmnigraphPreconditionError` |
| Non-Destructive Cluster Drift & Cedar Policies (`OMNI-07`, `OMNI-08`) | `libs/harness/gates/src/omnigraph-branch-verify.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle.ts`, `apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts`, `apps/harness-cli/src/commands/omnigraph-safety-helpers.ts`, `libs/harness/service/src/host-io.ts`, `libs/harness/infra/src/node-host-io.ts`, `libs/harness/graph/cluster.yaml`, `libs/harness/graph/graph.policy.yaml`, `libs/harness/graph/cluster.policy.yaml`, `libs/harness/graph/policy-tests.yaml`, `tools/omnigraph-mcp-launcher.mjs` | `decideOmnigraphSchemaEvolution` (`R = never`, `omnigraph policy test`) | `OmnigraphSchemaEvolution.decide`, `OmnigraphPreconditionError` |
