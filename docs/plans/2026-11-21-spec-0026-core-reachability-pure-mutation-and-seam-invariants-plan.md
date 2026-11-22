---
title: "SPEC-0026 Implementation Plan: Core Tier Test Reachability, Pure-Module Infra/App Mutation Expansion, and Workflow Cross-Seam Invariant Tests"
type: feat
status: completed
date: 2026-11-21
spec: harness:SPEC-0026
---

# Goal

Implement `harness:SPEC-0026` (P0-B of the PR #44 post-mortem harness hardening roadmap): enforce `type:core` test reachability and composite property-test checks in `GraphGc.decide`, expand `MutationCheck.decide` target discovery to zero-I/O pure modules inside `type:infra` and `type:app`, and add cross-seam differential and worker-isolation invariant tests in `@harness/infra`.

---

## 1. Scope & Line-Budget Decomposition Strategy

`libs/harness/gates/src/mutation/mutation-target-discovery.ts` currently stands at 741/800 lines. Keep AST import inspection isolated in a dedicated cohesive helper module so neither discovery nor classifier nears the line ceiling:

1. `libs/harness/gates/src/mutation/mutation-pure-module-classifier.ts` (`<= 180` lines) — AST classifier (`isPureMutationCandidate`) backed by `ts.createSourceFile` from `@harness/graph`.
2. `libs/harness/gates/src/mutation/mutation-target-discovery.ts` — extends `DomainFile["tier"]` and scans `libs/harness/infra/src/**` and `apps/harness-*/src/**` via the classifier.
3. `apps/harness-cli/src/commands/verify-doc-fastpath.ts` (`<= 160` lines) — doc-only verify fast-path keeping `verify-and-done.command.ts` strictly `<= 650` lines.
4. `libs/harness/gates/src/verify-stamp.ts` & `apps/harness-cli/src/commands/done-omnigraph-helpers.ts` — mutable-only `mutate-stamp` hashing and `.harness/plan-graph-snapshot.json` cleanup after `done` (keep `done-omnigraph-helpers.ts` `<= 650` lines).

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 · Executable Tier Test & Zero-Exemption Decider Property Reachability (`REQ-1.1`, `REQ-1.2`)

- **Plugin & Exemptions Update (`libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts`, `gc-helpers.ts`):**
  - Extend `untested-effect-fn` at `L33` from `domain | contract` to `domain | contract | infra | app` (noting `PackageTag` already maps `type:core` to `"domain"`), and keep `missing-decider-property-test` / `shallow-decider-property-test` at `domain | contract` (covering `type:core`).
  - Delete legacy `IGNORED_UNTESTED_FNS` from `gc-helpers.ts`, `gc-test-and-decider.plugin.ts`, `gc-check.ts`, and `index.ts`.
- **Workspace Gap Audit & Remediation:**
  - Add composite `it.effect.prop` property test for `Friction.decide` in `libs/harness/gates/test/friction-log.test.ts`.
  - Add direct-call test reachability for all 15 previously 0-reach `infra`/`app` `EffectFn`s (`AstGateCache.*` helpers in `libs/harness/infra/test/ast-gate-cache-helpers.test.ts`, `WorkflowRpcDaemon.*` handlers in `apps/harness-mcp/test/workflow-rpc-daemon.test.ts`, and `replayActivityMessage` in `libs/harness/infra/test/workflow-replay-differential.test.ts`).

### Unit 2 · Pure-Module Infra/App Mutation Discovery & Pure Codec Extraction (`REQ-2.1`..`REQ-2.3`)

- **Extract Pure Workflow Store Helpers (`libs/harness/infra/src/workflow/workflow-store-codec.ts`):**
  - Extract pure zero-I/O helpers (`WorkflowStoreAttemptFailure`, `toWorkflowStoreUnavailableError`, `decodeJsonFieldSafely`, `parseFiniteNumberOrString`, `makeMintReplyKey`) from `omnigraph-workflow-store.ts` into `workflow-store-codec.ts` and re-export them from `omnigraph-workflow-store.ts`; update `read-model-rebuild-journal.ts` and `message-storage-codec.ts` to import from `./workflow-store-codec.js` so both become genuinely zero-I/O pure mutation targets.
- **New Classifier (`libs/harness/gates/src/mutation/mutation-pure-module-classifier.ts`):**
  - Export `classifyMutationModulePurity(relPath, sourceText)`, `isPureMutationCandidate(relPath, sourceText)`, and directory walkers using `ts.createSourceFile` (`@harness/graph`).
  - Reject barrel files (`index.ts`), `*.d.ts`, `*.config.ts`, entrypoint/live/command/tools files, runtime I/O builtins/packages (`node:fs`, `node:child_process`, `node:net`, `node:http*`, `@effect/platform-node`, `@effect/sql*`, `@effect/ai-typesafe`, `alchemy*`), relative I/O adapter modules (`node-host-io`, `omnigraph-workflow-store`, `unix-socket-daemon`, `daemon-client`, etc.), `process.*`, `fetch(...)`, `nodeSyncHostIo`, and runtime `Layer.*` resource builders (`Layer.effect`, `Layer.scoped`, `Layer.unwrapEffect`).
  - Permit `import type`, pure `node:path`, `node:crypto`, `node:url`, `node:util`, `effect`, `ts-pattern`, `@harness/contract`, `@harness/service`, and pure `@harness/gates`.
- **Discovery Integration (`libs/harness/gates/src/mutation/mutation-target-discovery.ts`, `mutation-suite-helpers.ts`):**
  - Expand `DomainFile["tier"]` from `"domain" | "core" | "contract"` to `"domain" | "core" | "contract" | "infra-pure" | "app-pure"` (keeping `PackageTierClassification` strict for package manifests).
  - Delegate pure `type:infra` (`libs/harness/infra/src/**`) and pure non-web `type:app` (`libs/*/app/src/**` and `apps/<app>/src/**`) walking to `mutation-pure-module-classifier.ts`.
  - Route `findReachingTestFilesChecked` for `scope === "apps"` `app-pure` files to `apps/<pkg>/test/**` and support `apps/<app>/` in `resolveSuiteTargets` overlays.

### Unit 3 · Workflow Cross-Seam Invariant Tests (`REQ-3.1`, `REQ-3.2`)

- **Workflow Replay Differential Test (`libs/harness/infra/test/workflow-replay-differential.test.ts`):**
  - Execute `HarnessTaskWorkflow` over `ClusterWorkflowEngine` + Omnigraph message/projection layers across four canonical traces:
    1. Multi-wave normal completion with sequential `driveSharedStep`.
    2. L1 `MergeSliceWave` conflict retry resolved into clean wave completion.
    3. Pause at `LlmPhaseDone` followed by phase completion and run finish.
    4. Operator abort / fiber interrupt mid-wave.
  - Snapshot live `WfRun`, `WfUnit`, `WfAttempt` rows, run `rebuildWorkflowReadModelViews`, and assert exact normalized `Equal.equals` / sorted row equality between live views and rebuilt views.
- **Worktree × Policy Seam Test (`libs/harness/infra/test/worktree-policy-seam.test.ts`):**
  - Generate real slice worktree directories via `resolveWorkflowWorktreeDir` validated by `validateWorktreeRepoRoot` (`WorktreeRepoRoot.validate`).
  - Evaluate `classifyFileWrite` and `classifyFileRead` (`@harness/gates`) with `{ unitWorkerMode: true }` against the real generated paths:
    - `<sliceWorktree>/libs/sample/src/index.ts` → `"allow"`
    - `<sliceWorktree>/.harness/verify-stamp.json`, `<sliceWorktree>/.env` → `"deny"`
    - `<gitCommonDir>/harness/daemon.sock`, `<gitCommonDir>/harness/auth-tokens.json`, `<gitCommonDir>/harness/state.json` → `"deny"`

### Unit 4 · Doc-Only Verify Fast-Path, Mutable-Only Mutate Stamp, Cache Isolation, and Done Cleanup (`REQ-4.1`..`REQ-4.4`)

- **Mutable-Only Stamp Hashing (`libs/harness/gates/src/verify-stamp.ts`, `libs/harness/gates/src/index.ts`):**
  - Export `isMarkdownDocPath`, `computeMutableTreeHashChecked`, and `computeMutableTreeHash` delegating to a shared `computeFilteredWorkspaceTreeHashChecked` helper.
  - Add optional `mutableTreeHash` to `VerifyStampSchema` populated by `writeVerifyStamp`.
  - Switch `writeMutateStamp` and `checkMutateStamp` to `computeMutableTreeHash*` so markdown-only edits never invalidate `mutate-stamp.json`.
- **Mutation Context Cache Isolation (`libs/harness/gates/src/mutation/mutation-context-digest.ts`, `mutation-backup.ts`):**
  - Add `"docs"` to `LIBS_EXCLUDED_DIRS` so `libs/*/docs/**` never pollutes `allLibsSrcDigest`.
  - Populate `packageSupportDigests`, `testSupportDigests`, and `fileDigests` for `apps/<app>` so `app-pure` modules use `.harness/cache/mutation-cache-v2.json`.
  - Include `apps/` alongside `libs/` in `collectUntrackedLibsFiles` and `diffFromMergeBase` (`mutation-backup.ts`).
- **Stale Plan Snapshot Cleanup on `done` (`apps/harness-cli/src/commands/done-omnigraph-helpers.ts`):**
  - Safely unlink `.harness/plan-graph-snapshot.json` (ignoring `ENOENT`, checking non-symlink) after `mergeOutcome.ok` cleans up `planBranch`.
- **Doc-Only Verify Fast-Path (`apps/harness-cli/src/commands/verify-doc-fastpath.ts`, `verify-and-done.command.ts`):**
  - When `existingStamp.mutableTreeHash === currentMutableTreeHash` (`options?.skipSubprocessVerify !== true`), verify `evaluateVerifyMutateStampGate` and `decideGraphEntropy`, refresh `verify-stamp.json`, and return early without Nx subprocess or 100-seed DST runs.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                                    | Positive Coverage                                                                                                | Negative / Fault Coverage                                                                                                                      | Property / Determinism Check                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `libs/harness/gates/test/gc-test-and-decider.test.ts`          | Tested `type:core` `EffectFn` and composite `*.decide` pass                                                      | Untested `core` `EffectFn` → `untested-effect-fn`; `core` `.decide` with 0 or scalar-only props → `missing-*` / `shallow-*`                    | `it.effect.prop` over generated `core` graph nodes                       |
| `libs/harness/gates/test/mutation-target-and-stamp.test.ts`    | `import type` from `node:fs` classified pure; `read-model-rebuild-journal.ts` & `hook-guard-payload.ts` included | Runtime `import` / `require` / dynamic `import("node:fs", "node:child_process", "@effect/sql-*")` excluded; 0 reaching tests → `untestedFiles` | `it.effect.prop` invariance under arbitrary type-only `node:*` imports   |
| `libs/harness/gates/test/mutate-stamp-and-subprocess.test.ts`  | Editing `.md` preserves `checkMutateStamp` validity and `allLibsSrcDigest`                                       | Editing `.ts` invalidates `mutate-stamp.json` immediately                                                                                      | `it.prop` invariance over arbitrary markdown paths (`isMarkdownDocPath`) |
| `apps/harness-cli/test/mutate-and-plan-check.test.ts`          | Doc-only `handleVerify` fast-path refreshes `verify-stamp.json`; `syncOmnigraphOnDone` removes plan snapshot     | Editing `.ts` after verify bypasses fast-path and fails on `verify:mutate-stamp`                                                               | Fail-closed when `decideGraphEntropy` reports findings on doc-only edit  |
| `libs/harness/infra/test/workflow-replay-differential.test.ts` | Live vs rebuilt row parity across 4 multi-wave traces                                                            | Corrupt/non-terminal partial journal events do not silently invent completed status or lose attempt verdicts                                   | Normalized state equivalence across all trace steps                      |
| `libs/harness/infra/test/worktree-policy-seam.test.ts`         | Valid slice worktree source writes allowed                                                                       | `.harness/**`, `.env*`, `daemon.sock`, `auth-tokens.json`, symlink escapes denied even inside generated worktree                               | `it.prop` across arbitrary valid `runId` / `unitId` worktree slugs       |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` once skeletons/signatures are staged.
2. Implement Units 1–3, add missing `core`/pure-`infra`/`app` tests until `mutate --strict` is 100% killed, and set `harness:SPEC-0026` frontmatter `status: accepted`.
3. Format only touched files via `pnpm oxfmt --write <explicit paths>` and verify with `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
