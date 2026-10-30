---
id: harness:ADR-0006
title: Git-Aware Omnigraph Branch Lifecycle, Post-Merge HEAD Reconciliation, and Temp-Workspace Isolation
status: accepted
date: 2026-10-30
deciders:
  - "@harness/graph"
  - "@harness/gates"
  - "@harness/cli"
  - "@harness/mcp"
enforced_by:
  - libs/harness/graph/src/cluster-resolver.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - apps/harness-cli/src/index.ts
  - apps/harness-mcp/src/server.ts
spans:
  - OmnigraphReconcile.decide
  - OmnigraphSync.sync
  - OmnigraphSync.mergeBranch
  - Harness.ingestWorkspace
services:
  - "@harness/graph/OmnigraphSync"
errors: []
---

# Git-Aware Omnigraph Branch Lifecycle, Post-Merge HEAD Reconciliation, and Temp-Workspace Isolation

## Context and Problem Statement

In the Effect-TS Engineering Harness, the code topology and ArchiMate ontology graph is stored both in a local JSON snapshot (`.harness/graph-snapshot.json`) and in the repo-scoped Omnigraph server (`main` and task branches). However, four lifecycle gaps existed between Git state transitions and Omnigraph state transitions:

1. Merging a Pull Request on GitHub followed by `git pull`, or merging a local Git branch into `main` (`git merge`), updated `.git/HEAD` without updating `.harness/graph-snapshot.json` or Omnigraph `main`. Neither `harness session` (`PreInvocation` hook), `harness doctor`, `harness-mcp`, nor `harness ingest` tracked the Git `HEAD` SHA at which the graph snapshot was generated.
2. `resolveOmnigraphTaskBranches` mapped all non-worktree checkouts to `plan/current` and `impl/current` unless `HARNESS_WORKTREE_ID` was set, ignoring `.git/HEAD` when working on named local Git feature branches (`feat/...`, `fix/...`).
3. `pnpm harness ingest` only ran the lightweight AST regex indexer (`buildWorkspaceFnIndex`) and did not extract or sync the `HarnessGraph` to `.harness/graph-snapshot.json` or Omnigraph.
4. CLI unit tests running in temporary directories (`/tmp/harness-cli-*`) fell back to `CLI_REPO_ROOT` when resolving `cluster.yaml`, syncing synthetic test nodes (`Sample.fnA`, `Sample.real`) into the repository's live Omnigraph `main` branch.

## Decision Drivers

- **Automatic post-merge reconciliation without Git hook fragility:** After `git pull`, `git merge`, or branch checkout, the harness (`harness session`, `harness doctor`, `harness ingest`, and `harness-mcp`) must deterministically detect `HEAD` drift and reconcile `.harness/graph-snapshot.json` and Omnigraph `main`.
- **Zero-subprocess Git state inspection:** Resolving the current Git branch and `HEAD` SHA must read `.git/HEAD`, `.git/refs`, and `packed-refs` directly in memory (`0ms`) without spawning `git` child processes.
- **Pure functional decision core (`R = never`):** Deciding whether reconciliation is needed and which Omnigraph branch to target must be a pure `.decide` function (`OmnigraphReconcile.decide`) verified by property-based tests.
- **Strict isolation between temporary test workspaces and the live repository cluster:** Temp directories outside `CLI_REPO_ROOT` without `cluster.yaml` must never write synthetic test graphs into the repository's live Omnigraph server.

## Considered Options

1. **Pure `OmnigraphReconcile.decide` + `.harness/graph-head.json` tracking + Git-branch-scoped `resolveOmnigraphTaskBranches` + full `Harness.ingestWorkspace` + post-merge branch cleanup + temp-workspace isolation**
2. **Rely solely on `.git/hooks/post-merge` and `.git/hooks/post-checkout` shell scripts calling `pnpm harness verify`**
3. **Re-extract the full TypeScript `ts-morph` graph on every single MCP tool call without caching `.harness/graph-head.json`**

## Decision Outcome

Chosen option: **Option 1 — Pure `OmnigraphReconcile.decide` + `.harness/graph-head.json` tracking + Git-branch-scoped `resolveOmnigraphTaskBranches` + full `Harness.ingestWorkspace` + post-merge branch cleanup + temp-workspace isolation**, because it guarantees automatic reconciliation whenever Git `HEAD` advances (`git pull`, `git merge`, PR merge) while preserving `<5ms` cached reads when `HEAD` is unchanged and preventing test pollution of the live Omnigraph cluster.

## Rejected Alternatives

### 1 · Rely solely on `.git/hooks/post-merge` shell scripts calling `pnpm harness verify`

Installing local Git hooks in `.git/hooks/` to run `pnpm harness verify` after every merge or pull.

**Why rejected:** `.git/hooks` are not version-controlled by Git unless manually configured via `core.hooksPath`, do not fire when IDEs or external tools manipulate refs, and running full `pnpm harness verify` (including `nx affected -t verify`) on every `git pull` is far too slow compared to reconciling the graph snapshot and Omnigraph `main` via `Harness.ingestWorkspace` / `OmnigraphSync.sync`.

### 2 · Re-extract the full `ts-morph` graph on every MCP tool call without `.harness/graph-head.json`

Bypassing `.harness/graph-snapshot.json` and running `extractWorkspaceTypeAwareGraph` on every `harness_resolve` or `harness_ontology_check` call.

**Why rejected:** Full `ts-morph` extraction across the monorepo takes `~1.5s–3s`, whereas reading `.harness/graph-head.json` and `.git/HEAD` takes `<1ms` and only triggers re-extraction when the Git `HEAD` SHA or branch actually changes.

## Consequences and Enforcement

### Positive Consequences

- Pulling merged PRs (`git pull`) or merging local branches into `main` automatically reconciles `.harness/graph-snapshot.json`, `.harness/graph-head.json`, and Omnigraph `main` on the next `harness session`, `harness doctor`, `harness ingest`, or `harness-mcp` query.
- Local Git feature branches automatically isolate their Omnigraph task state under `plan/branch-<slug>` and `impl/branch-<slug>`, and `OmnigraphSync.mergeBranch` cleans up merged task branches upon `harness done`.
- Temporary test workspaces (`/tmp/harness-cli-*`) no longer leak synthetic test nodes into `CLI_REPO_ROOT`'s live Omnigraph server.

### Negative Consequences and Trade-offs

- Uncommitted working-tree edits on the same `HEAD` SHA still rely on `harness plan-check`, `harness ingest`, or `harness verify` to refresh `.harness/graph-snapshot.json`, which matches the intended task gate lifecycle.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Pure reconciliation decision from Git `HEAD` SHA, branch, and snapshot state (`R = never`) | `libs/harness/graph/src/cluster-resolver.ts` | `vitest` property & unit suite (`omnigraph-gq.test.ts`) | `OmnigraphReconcile.decide` |
| Snapshot synchronization records `.harness/graph-head.json` and `mergeBranch` cleans up merged task branches | `libs/harness/graph/src/omnigraph-sync.ts` | `vitest` unit suite (`omnigraph-gq.test.ts`) | `OmnigraphSync.sync`, `OmnigraphSync.mergeBranch`, `@harness/graph/OmnigraphSync` |
| `harness ingest` extracts and syncs the full workspace graph and isolates temp workspaces | `apps/harness-cli/src/index.ts` | `vitest` unit suite (`index.test.ts`) | `Harness.ingestWorkspace` |
