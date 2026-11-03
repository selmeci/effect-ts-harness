# Effect-TS Engineering Harness — Phase 2 (Resident `clef-flash` Decision Model, CLI Gates & Claude Code Adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete `libs/harness/decision` definitions (`IdiomRouterV1`, `GuardV1`, `TriageV1`, `PlanStepCoverageV1`) over a single resident `clef-flash` (9B) model with a deterministic test Layer, wire all `apps/harness-cli` commands (`session`, `guard`, `route`, `plan-check`, `verify` with `.harness/verify-stamp.json`, `done` with Omnigraph branch diff/merge and Claude Code `Stop` JSON protocol, `doctor`), and package the thin Claude Code adapter (`adapters/claude-code`).

**Architecture:** Deterministic rules in `@harness/gates` always execute first. Only open questions reach `clef-flash` via `@effect/ai-typesafe` (`http://127.0.0.1:11434/v1`, warm timeout `1500 millis`, session warm-up timeout `10 seconds`). No 27B model is ever loaded locally (solving Showstopper #3 VRAM thrashing). `harness verify` computes and writes a SHA-256 working-tree stamp (`.harness/verify-stamp.json`) and loads the `impl/<task>` graph branch. `harness done` validates the stamp, diffs `impl/<task>` against `plan/<task>` (`Graph.difference` + `og.branches.diff`), runs per-step `clef-flash` coverage checks, merges `impl/<task>` into `main`, and returns Claude Code `Stop` hook JSON (`{"decision": "block", "reason": "..."}` on failure).

**Tech Stack:** effect 4.0.0 (`effect/ai/Decision`, `effect/ai/DecisionModel`, `effect/http/FetchHttpClient`) · `@effect/ai-typesafe` 4.0.0 · `@modernrelay/omnigraph` 0.14.0 · `@effect/vitest` 4.0.0

**Spec:** [docs/mvp_v2.md](../../mvp_v2.md) (§0.1 Showstopper #3, §4.1–4.2, §6, §7, §8.2, §11, §12 Phase 2).

## Global Constraints

- **Single resident local model:** `clef-flash` (9B) only. Never reference or load `clef` (27B).
- **Timeouts & fallback safety:**
  - `harness session` warm-up ping: `10 seconds` timeout.
  - Hot-path calls (`guard`, `route`, `triage`, per-step `done`): `1500 millis` timeout.
  - On timeout or `AiError`: `guard` falls back to `"ask"`, `route` returns `"review"`, `triage` falls back to `"semantic"`, `done` blocks with a clear reason.
- **Claude Code Hook Protocol compliance:**
  - `PreToolUse` (`harness guard`): `allow` -> exit `0`; `deny` -> exit `2` with message on stderr; `ask` -> exit `0` with stdout JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"..."}}`.
  - `Stop` (`harness done`): `allow` -> exit `0`; `block` -> exit `0` with stdout JSON `{"decision":"block","reason":"..."}` (never `"permissionDecision": "ask"`, which Claude Code `Stop` hooks do not support).
- **Cryptographic `verify` stamp:** `.harness/verify-stamp.json` records `{ treeHash, timestamp, taskBranch }` where `treeHash` is the SHA-256 over `git rev-parse HEAD` and all tracked/untracked non-ignored workspace file hashes. Any edit after `harness verify` invalidates the stamp and causes `harness done` to block immediately.

## Review Focus

1. **Ollama down or `1500 millis` timeout during `harness guard` on an unknown command:** When `classifyCommand("curl https://example.com")` returns `"escalate"` and `DecisionModel` fails with `AiError` or times out, `evaluateGuard` must return `"ask"` (never `"allow"`) (tested in Task 1 and Task 3).
2. **Stale `.harness/verify-stamp.json` after post-verify file edit:** Modifying any source file after `harness verify` changes `computeWorkspaceTreeHash(repoRoot)`, causing `harness done` to return `{"decision": "block", "reason": "Run harness verify after your latest edits before finishing."}` without calling Ollama (tested in Task 2 and Task 3).
3. **Remaining `isStub: true` or missing planned `EffectFn` in `impl/<task>` vs `plan/<task>`:** `verifyGraphBranchDiff(planGraph, implGraph)` must reject if any planned `EffectFn` is missing in `implGraph`, has `isStub: true`, or changed its `RequiresService` / `FailsWith` edges (tested in Task 2).
4. **Known `tsgo` / `oxlint` diagnostic codes in failure triage:** Known mechanical diagnostics (`floatingEffect`, `harness/syntax-bans`, `no-restricted-imports`, `@nx/enforce-module-boundaries`) must map deterministically to `"mechanical"` with a pattern hint without calling `clef-flash` (tested in Task 1).
5. **Claude Code `Stop` hook JSON schema:** `harness done` must output `{"decision": "block", "reason": "Plan step ..."}` on stdout with exit code `0` when a step fails `PlanStepCoverageV1` (`implemented < 0.7` or `noOutOfScopeEdits < 0.7`) (tested in Task 3).

---

### Task 1: Complete `libs/harness/decision` definitions (`GuardV1`, `TriageV1`, `PlanStepCoverageV1`) and deterministic mock Layer

**Files:**

- Create: `libs/harness/decision/src/guard-decision.ts`, `libs/harness/decision/src/triage-decision.ts`, `libs/harness/decision/src/plan-coverage-decision.ts`, `libs/harness/decision/src/mock-layer.ts`, `libs/harness/decision/src/index.ts`
- Modify: `libs/harness/decision/package.json`
- Create: `libs/harness/decision/test/decisions.test.ts`

**Interfaces:**

- Consumes: `Decision`, `DecisionModel` from `"effect/ai/*"`, `Effect`, `Layer`, `Schema` from `"effect"`.
- Produces:
  - `GuardV1` & `decideGuardCommand(command: string): Effect.Effect<{ readonly verdict: "allow" | "deny" | "ask"; readonly reason: string }, never, DecisionModel.DecisionModel>` (with `1500 millis` timeout + fallback to `"ask"`).
  - `TriageV1` & `triageFailure(failureOutput: string): Effect.Effect<{ readonly kind: "mechanical" | "semantic"; readonly hint: string }, never, DecisionModel.DecisionModel>` (deterministic table first for `floatingEffect`, `harness/syntax-bans`, `no-restricted-imports`, `enforce-module-boundaries`).
  - `PlanStepCoverageV1` & `checkPlanStepCoverage(input: { readonly stepId: string; readonly planStep: string; readonly stepDiff: string }): Effect.Effect<{ readonly covered: boolean; readonly reason: string }, never, DecisionModel.DecisionModel>`
  - `makeMockDecisionModelLayer(overrides?)`: deterministic `Layer.Layer<DecisionModel.DecisionModel>` for unit and CI tests without Ollama.

- [ ] **Step 1: Write the failing test in `libs/harness/decision/test/decisions.test.ts`**

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  assertDecisionLimits,
  checkPlanStepCoverage,
  decideGuardCommand,
  GuardV1,
  IdiomRouterV1,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  PlanStepCoverageV1,
  routeStep,
  triageFailure,
  TriageV1,
} from "../src/index.js"

describe("Harness decision definitions & fallbacks", () => {
  it("keeps all 4 decision definitions within Ollama System One limits (<=26 options, <=64 questions)", () => {
    for (const def of [IdiomRouterV1, GuardV1, TriageV1, PlanStepCoverageV1]) {
      expect(() => assertDecisionLimits(def)).not.toThrow()
    }
  })

  it.effect(
    "falls back to 'ask' in decideGuardCommand and 'review' in routeStep when Ollama fails or times out",
    () =>
      Effect.gen(function* () {
        const guardRes = yield* decideGuardCommand("curl https://unknown.example").pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(guardRes.verdict).toBe("ask")

        const routeRes = yield* routeStep(
          "Retry failed HTTP requests with exponential backoff",
        ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
        expect(routeRes).toBe("review")
      }),
  )

  it.effect(
    "classifies known tsgo/oxlint diagnostics as mechanical without calling DecisionModel",
    () =>
      Effect.gen(function* () {
        const res = yield* triageFailure(
          "error: floatingEffect: Effect.log('x') is not yielded",
        ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
        expect(res.kind).toBe("mechanical")
        expect(res.hint).toContain("yield*")
      }),
  )

  it.effect("evaluates per-step plan coverage with deterministic mock DecisionModel", () =>
    Effect.gen(function* () {
      const pass = yield* checkPlanStepCoverage({
        stepId: "step-1",
        planStep: "Add GreetInput schema",
        stepDiff: "+export const GreetInput = Schema.Struct({ name: Schema.String })",
      }).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({ implementedProb: 0.95, noOutOfScopeProb: 0.95 }),
        ),
      )
      expect(pass.covered).toBe(true)

      const fail = yield* checkPlanStepCoverage({
        stepId: "step-2",
        planStep: "Add PhotoRepo D1 insert",
        stepDiff: "",
      }).pipe(
        Effect.provide(makeMockDecisionModelLayer({ implementedProb: 0.2, noOutOfScopeProb: 0.9 })),
      )
      expect(fail.covered).toBe(false)
      expect(fail.reason).toContain("step-2")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/decision:test`
Expected: FAIL (`Cannot find module '../src/index.js'`).

- [ ] **Step 3: Implement `guard-decision.ts`, `triage-decision.ts`, `plan-coverage-decision.ts`, `mock-layer.ts`, and `index.ts` in `libs/harness/decision/src/`**

Wrap every `DecisionModel.decide(...)` call in `Effect.timeout("1500 millis")` and `Effect.catchAll` so timeouts and `AiError` produce safe fallback outcomes (`"ask"` for guard, `"review"` for router, `"semantic"` for triage, `{ covered: false, reason: ... }` for plan step coverage) and annotate the active span with `decision.definition` and probabilities.

- [ ] **Step 4: Run `@harness/decision:verify`**

Run: `pnpm nx run @harness/decision:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/decision
git commit -m "feat(decision): add GuardV1, TriageV1, PlanStepCoverageV1 and mock DecisionModel layer"
```

---

### Task 2: Add working-tree SHA-256 stamp and `plan` vs. `impl` graph diffing in `@harness/gates`

**Files:**

- Modify: `libs/harness/gates/package.json` (add `@harness/graph: "workspace:*"`)
- Create: `libs/harness/gates/src/verify-stamp.ts`, `libs/harness/gates/src/branch-diff.ts`
- Modify: `libs/harness/gates/src/index.ts`
- Create: `libs/harness/gates/test/verify-stamp-and-diff.test.ts`

**Interfaces:**

- Consumes: `HarnessGraph` from `@harness/graph`.
- Produces:
  - `VerifyStamp`: `{ readonly treeHash: string; readonly timestamp: string; readonly taskBranch: string }`
  - `computeWorkspaceTreeHash(repoRoot: string): string`
  - `writeVerifyStamp(repoRoot: string, taskBranch?: string): VerifyStamp`
  - `checkVerifyStamp(repoRoot: string): { readonly valid: true; readonly stamp: VerifyStamp } | { readonly valid: false; readonly reason: string }`
  - `diffPlanAndImplGraphs(planGraph: HarnessGraph, implGraph: HarnessGraph): { readonly ok: boolean; readonly reasons: ReadonlyArray<string> }`

- [ ] **Step 1: Write the failing test in `libs/harness/gates/test/verify-stamp-and-diff.test.ts`**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildHarnessGraph } from "@harness/graph"
import { checkVerifyStamp, diffPlanAndImplGraphs, writeVerifyStamp } from "../src/index.js"

describe("verify-stamp and plan/impl graph diff", () => {
  it("invalidates verify-stamp.json when a file changes after verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-stamp-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n")
      writeVerifyStamp(dir, "impl/current")
      expect(checkVerifyStamp(dir).valid).toBe(true)

      writeFileSync(join(dir, "file.ts"), "export const x = 2\n")
      const afterEdit = checkVerifyStamp(dir)
      expect(afterEdit.valid).toBe(false)
      if (!afterEdit.valid) {
        expect(afterEdit.reason).toContain("Run harness verify")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("blocks when impl/current still has isStub:true or misses a planned EffectFn", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: true,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const stillStub = diffPlanAndImplGraphs(planGraph, planGraph)
    expect(stillStub.ok).toBe(false)
    expect(stillStub.reasons[0]).toContain("isStub")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/gates:test`
Expected: FAIL.

- [ ] **Step 3: Implement `libs/harness/gates/src/verify-stamp.ts` and `libs/harness/gates/src/branch-diff.ts`**

Note: Keep `@harness/gates` tagged `["type:contract", "type:service"]` and update `.oxlintrc.json` `depConstraints` so `type:service` is allowed by `@harness/gates` (or keep `diffPlanAndImplGraphs` in `@harness/graph` and re-export / call from `@harness/gates` if `type:contract` only depends on `type:contract`). Specifically: if `@harness/gates` has `"tags": ["type:service"]` and `.oxlintrc.json` allows `type:domain` to depend on `["type:contract", "type:domain", "type:service"]` (which matches the standard Clean Architecture rule where domain uses service interfaces!), then `@harness/gates` (`type:service`) can depend on `@harness/graph` (`type:service`) and `@harness/sample-domain` (`type:domain`) can depend on `@harness/gates` (`type:service`) cleanly!

- [ ] **Step 4: Run `@harness/gates:verify`**

Run: `pnpm install && pnpm nx run @harness/gates:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/gates .oxlintrc.json pnpm-lock.yaml
git commit -m "feat(gates): add cryptographic verify-stamp and plan/impl graph branch diff"
```

---

### Task 3: Wire full `apps/harness-cli` commands (`session`, `guard`, `route`, `plan-check`, `verify`, `done`, `doctor`)

**Files:**

- Modify: `apps/harness-cli/package.json`
- Modify: `apps/harness-cli/src/index.ts`, `apps/harness-cli/test/index.test.ts`

**Interfaces:**

- Consumes: `@harness/gates`, `@harness/decision`, `@harness/graph`, `@harness/ingest`.
- Produces:
  - `runCli(argv: ReadonlyArray<string>, options?: CliEnv): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>`
  - Subcommands:
    - `guard <command>` (or Claude Code `PreToolUse` stdin JSON): runs `classifyCommand`, then `decideGuardCommand` on `"escalate"`; outputs Claude Code `PreToolUse` JSON on `"ask"`, exits `2` on `"deny"`, exits `0` on `"allow"`.
    - `route <planStep>`: calls `routeStep` and prints the matched `agent-patterns/<block>.md` path.
    - `plan-check`: runs `HARNESS_PLAN_CHECK=1` typecheck + lint, builds the skeleton `HarnessGraph`, renders `Graph.toMermaid`, saves `.harness/plan-graph-snapshot.json` (and syncs to Omnigraph branch `plan/current`).
    - `verify`: runs `nx affected -t verify` (or `nx run-many -t verify`), builds `impl/current` graph snapshot, and writes `.harness/verify-stamp.json`.
    - `done`: checks `.harness/verify-stamp.json`, diffs `impl/current` vs `plan/current`, runs `checkPlanStepCoverage` per step, and returns `{ exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }) }` on any failure or merges `impl/current` into `main` on success.
    - `session` / `doctor`: checks Node ≥ 24, `omnigraph` / snapshot directory, and pings Ollama (`10 seconds` warm-up timeout).

- [ ] **Step 1: Write the failing tests in `apps/harness-cli/test/index.test.ts` for `guard`, `done`, `route`, `plan-check`, and `doctor`**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { writeVerifyStamp } from "@harness/gates"
import { runCli } from "../src/index.js"

describe("harness-cli v2 commands", () => {
  it("guard blocks rm -rf (exit 2), allows pnpm test (exit 0), and outputs PreToolUse ask JSON for alchemy deploy", async () => {
    const deny = await runCli(["guard", "rm -rf /tmp/outside"])
    expect(deny.exitCode).toBe(2)

    const allow = await runCli(["guard", "pnpm test"])
    expect(allow.exitCode).toBe(0)

    const ask = await runCli(["guard", "alchemy deploy"])
    expect(ask.exitCode).toBe(0)
    expect(JSON.parse(ask.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    })
  })

  it("done outputs Stop hook block JSON when verify-stamp.json is missing or stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-"))
    try {
      writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
      const missing = await runCli(["done"], { repoRoot: dir })
      expect(missing.exitCode).toBe(0)
      expect(JSON.parse(missing.stdout)).toEqual({
        decision: "block",
        reason: expect.stringContaining("Run harness verify"),
      })

      writeVerifyStamp(dir, "impl/current")
      const green = await runCli(["done"], {
        repoRoot: dir,
        decisionLayer: makeMockDecisionModelLayer({
          implementedProb: 0.95,
          noOutOfScopeProb: 0.95,
        }),
      })
      expect(green.exitCode).toBe(0)
      expect(green.stdout).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run harness-cli:test`
Expected: FAIL (`runCli is not exported`).

- [ ] **Step 3: Implement `runCli` and all subcommands in `apps/harness-cli/src/index.ts`**

Add `@harness/gates`, `@harness/decision`, `@harness/graph`, `@harness/ingest`, and `effect` to `apps/harness-cli/package.json`. Implement `runCli` and preserve `COMMANDS` and `run` exports for backwards compatibility.

- [ ] **Step 4: Run `harness-cli:verify`**

Run: `pnpm install && pnpm nx run harness-cli:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/harness-cli pnpm-lock.yaml
git commit -m "feat(harness-cli): implement guard, route, plan-check, verify, done, session, and doctor commands"
```

---

### Task 4: Create the Claude Code adapter (`adapters/claude-code`) and Cedar policy (`libs/harness/graph/policies.cedar`)

**Files:**

- Create:
  - `adapters/claude-code/hooks.json`
  - `adapters/claude-code/.mcp.json`
  - `adapters/claude-code/skills/effect-harness/SKILL.md`
  - `libs/harness/graph/policies.cedar`
- Create: `apps/harness-cli/test/adapter-config.test.ts`

**Interfaces:**

- Consumes: `apps/harness-cli`, `apps/harness-mcp`, `@modernrelay/omnigraph-mcp@0.14.0`.
- Produces:
  - `adapters/claude-code/hooks.json` wiring `SessionStart -> harness session`, `PreToolUse -> harness guard`, `PostToolUse -> tsc/reingest`, `Stop -> harness done`.
  - `adapters/claude-code/.mcp.json` configuring `harness-mcp`, `omnigraph-mcp` (read-only agent token), and `nx-mcp`.
  - `libs/harness/graph/policies.cedar` restricting `principal == Omnigraph::Subject::"agent-mcp"` to `Omnigraph::Action::"read"` on `main` and `plan/*` while granting `harness-cli` full branch/load permissions (`docs/mvp_v2.md` §8.2).

- [ ] **Step 1: Write the failing test in `apps/harness-cli/test/adapter-config.test.ts`**

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("Claude Code adapter & Omnigraph Cedar policy", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")

  it("wires SessionStart, PreToolUse, PostToolUse, and Stop hooks to harness-cli", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/hooks.json"), "utf8"),
    )
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "PreToolUse", "PostToolUse", "Stop"])
  })

  it("configures harness-mcp, omnigraph-mcp, and nx-mcp in .mcp.json", () => {
    const mcp = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/.mcp.json"), "utf8"),
    )
    expect(Object.keys(mcp.mcpServers)).toEqual(["harness-mcp", "omnigraph-mcp", "nx-mcp"])
  })

  it("forbids agent-mcp from mutating Omnigraph branches in policies.cedar", () => {
    const cedar = readFileSync(resolve(repoRoot, "libs/harness/graph/policies.cedar"), "utf8")
    expect(cedar).toContain('Omnigraph::Subject::"agent-mcp"')
    expect(cedar).toContain('Omnigraph::Action::"read"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run harness-cli:test`
Expected: FAIL (`ENOENT: no such file or directory, open '.../adapters/claude-code/hooks.json'`).

- [ ] **Step 3: Create `adapters/claude-code/{hooks.json,.mcp.json,skills/effect-harness/SKILL.md}` and `libs/harness/graph/policies.cedar`**

Write the hook configurations, MCP server definitions, the `effect-harness` skill instructions (teaching the workflow `plan -> stub<A, E, R> -> harness plan-check -> implement -> harness verify -> harness done` and `harness_*` MCP tools), and the Cedar policy file.

- [ ] **Step 4: Run `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code libs/harness/graph/policies.cedar apps/harness-cli/test/adapter-config.test.ts
git commit -m "feat(adapter): add Claude Code hooks, MCP config, skill, and Omnigraph Cedar policy"
```
