# Effect-TS Engineering Harness — Phase 0 (MVP v2 Reconcile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the existing `feat/repo-bootstrap` branch (built from `docs/mvp.md` v1) with `docs/mvp_v2.md` Phase 0 by upgrading Drizzle to `1.0.0-rc.5-ab785fc` with a fresh v1 baseline migration, adding the `stub<A, E, R>(...args)` skeleton helper and its `oxlint` verify ban, expanding import bans to `alchemy/*` and `@effect/sql-*`, updating the `@harness/{ingest,decision}` and `harness-cli` seeds for Omnigraph + resident `clef-flash`, and aligning all repo docs (`AGENTS.md`, `README.md`, `docs/dependency-pins.md`).

**Architecture:** We modify the uncommitted/unmerged `feat/repo-bootstrap` workspace in place, replacing v1 assumptions (`drizzle-orm@0.45.3`, `code-graph-rag` JSONL trace headers, Docker/Memgraph docs, missing `stub<A, E, R>`) with the exact Phase 0 foundations required by `docs/mvp_v2.md`. Every task ends with `pnpm verify:all` green.

**Tech Stack:** pnpm 12.9.1 · Node ≥ 24 · Nx 23.2.1 · TypeScript 7.0.2 (`@effect/tsgo` 0.48.0) + TypeScript 5.9.3 (scoped JS compiler API override) · effect 4.0.0 · `@effect/vitest` 4.0.0 + vitest 5.0.3 · `@effect/ai-typesafe` 4.0.0 · oxlint 1.86.0 + `oxlint-tsgolint` 7.0.2003 · alchemy 2.0.0-beta.80 · `drizzle-orm` `1.0.0-rc.5-ab785fc` + `drizzle-kit` `1.0.0-rc.5-ab785fc`

**Spec:** [docs/mvp_v2.md](../../mvp_v2.md) (§0, §5, §6, §7, §10, §12 Phase 0). Supersedes the post-bootstrap gaps of [2026-10-04-repo-bootstrap.md](./2026-10-04-repo-bootstrap.md).

## Global Constraints

- **Exact version pins only** (`save-exact=true` in `.npmrc`, `saveExact: true` in `pnpm-workspace.yaml`).
- **Drizzle v1 RC pin for Alchemy v2 compatibility:** `drizzle-orm@1.0.0-rc.5-ab785fc` and `drizzle-kit@1.0.0-rc.5-ab785fc` (required by `alchemy@2.0.0-beta.80` for `drizzle-orm/effect-d1` and `drizzle-orm/effect-sqlite-do`). Delete the old `0.31.11` migration (`libs/sample/infra/migrations/0000_talented_lyja.sql` and `migrations/meta/`) and generate a fresh v1 baseline migration (`migrations/<timestamp>_*/migration.sql` + `snapshot.json`).
- **Skeleton `stub<A, E, R>` pattern:** `@harness/gates` exports `stub<A, E = never, R = never>(..._usedArgs: ReadonlyArray<unknown>): Effect.Effect<A, E, R>`. Allowed in `oxlint` when `HARNESS_PLAN_CHECK=1`; banned in normal `lint` / `verify`.
- **Nx boundary tag for `@harness/gates`:** Tag `@harness/gates` with `["type:contract", "scope:harness"]` (or allow `scope:harness` in `type:domain`) so `type:domain` libraries can import `stub` from `@harness/gates` without violating `@nx/enforce-module-boundaries`.
- **Import bans (`no-restricted-imports` patterns):** Ban `["drizzle-orm", "drizzle-orm/*", "alchemy", "alchemy/*", "@effect/sql-*"]` in all `libs/**/src/**/*.ts` and `apps/**/src/**/*.ts`, disabled only in `**/infra/src/**/*.ts`, `**/infra/test/**/*.ts`, and `apps/sample/**`.
- **Single resident decision model:** Only `clef-flash` (9B) via Ollama; never reference `clef` 27B or Docker/Memgraph/`code-graph-rag` as active dependencies.
- **Definition of done:** `pnpm verify:all` (`nx run-many -t verify`) green across all 9 workspace projects.

## Review Focus

1. **`drizzle-kit@1.0.0-rc.5-ab785fc` subfolder migration layout in `check-migrations.mjs`:** Drizzle Kit v1 writes `<timestamp>_<name>/migration.sql` inside subdirectories rather than flat `0000_*.sql` files; `listSql` in `libs/sample/infra/scripts/check-migrations.mjs` must scan `readdir(dir, { recursive: true })` so uncommitted drift and `DROP` SQL inside subdirectories are caught (tested in Task 1).
2. **`stub<A, E, R>(...args)` type inference and `HARNESS_PLAN_CHECK=1` toggle:** Calling `stub<Out, Err, Svc>(input)` inside `Effect.fn("...")(function* (input) { return yield* stub<Out, Err, Svc>(input) })` must infer `Effect.Effect<Out, Err, Svc>` (never collapsing `E` or `R` to `never`), pass `oxlint` when `HARNESS_PLAN_CHECK=1`, and fail `harness/syntax-bans` when `HARNESS_PLAN_CHECK` is unset (tested in Task 2).
3. **`alchemy/*` and `@effect/sql-*` subpath imports in `type:domain`:** Importing `alchemy/Cloudflare` or `@effect/sql-d1` inside `libs/sample/domain/src/index.ts` must fail `oxlint` `no-restricted-imports`, while `apps/sample/alchemy.run.ts` continues to pass (tested in Task 3).
4. **`IdiomRouterV1` option count vs. Ollama System One limit:** Adding the v2 application-stack blocks (`d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom`, `alchemy-infra`, `services-and-layers`, `errors`, `testing`) must keep `Object.keys(criteria).length <= 26` and `review` at index 0 (tested in Task 4).
5. **CLI command registry completeness for v2 hooks and workflows:** `apps/harness-cli` must accept `plan-check` and `doctor` in addition to `guard`, `route`, `verify`, `done`, `ingest`, `session`, `help` (tested in Task 4).

---

### Task 1: Upgrade Drizzle to `1.0.0-rc.5-ab785fc` and regenerate baseline migration

**Files:**

- Delete: `libs/sample/infra/migrations/0000_talented_lyja.sql`, `libs/sample/infra/migrations/meta/_journal.json`, `libs/sample/infra/migrations/meta/0000_snapshot.json`
- Modify: `libs/sample/infra/package.json:20-28`
- Modify: `libs/sample/infra/scripts/check-migrations.mjs:18-76`
- Create: `libs/sample/infra/migrations/<timestamp>_baseline/migration.sql`, `libs/sample/infra/migrations/<timestamp>_baseline/snapshot.json` (via `drizzle-kit generate`)
- Modify: `libs/sample/infra/test/index.test.ts`

**Interfaces:**

- Consumes: `libs/sample/infra/src/db/schema.ts` (`photos` table).
- Produces: `drizzle-orm@1.0.0-rc.5-ab785fc` + `drizzle-kit@1.0.0-rc.5-ab785fc` in `@harness/sample-infra`; recursive `check-migrations.mjs` supporting Drizzle v1 subfolder migrations (`<dir>/migration.sql`).

- [ ] **Step 1: Write the failing test in `libs/sample/infra/test/index.test.ts` verifying `drizzle-orm/effect-d1` and `photos` schema exports**

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { photos } from "../src/db/schema.js"
import { logToConsole } from "../src/index.js"

describe("sample-infra", () => {
  it.effect("runs logToConsole without failing", () =>
    Effect.gen(function* () {
      yield* logToConsole("harness")
      expect(photos.id.name).toBe("id")
    }),
  )

  it("resolves drizzle-orm/effect-d1 from the 1.0.0-rc.5 pin", async () => {
    const mod = await import("drizzle-orm/effect-d1")
    expect(mod).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails on `drizzle-orm@0.45.3`**

Run: `pnpm nx run @harness/sample-infra:test`
Expected: FAIL with `Cannot find module 'drizzle-orm/effect-d1'`.

- [ ] **Step 3: Update `libs/sample/infra/package.json` to `1.0.0-rc.5-ab785fc`, update `check-migrations.mjs` for recursive `.sql` discovery, delete old `migrations/`, and regenerate baseline migration**

In `libs/sample/infra/package.json`, set:

- `"drizzle-orm": "1.0.0-rc.5-ab785fc"` in `dependencies`
- `"drizzle-kit": "1.0.0-rc.5-ab785fc"` in `devDependencies`

In `libs/sample/infra/scripts/check-migrations.mjs`, update `listSql(dir)` to use `readdir(dir, { recursive: true })`:

```js
const listSql = async (dir) => {
  try {
    return (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".sql")).sort()
  } catch {
    return []
  }
}
```

Then remove the old migration and generate the new v1 baseline:

```bash
rm -rf libs/sample/infra/migrations
pnpm install
pnpm --filter @harness/sample-infra exec drizzle-kit generate --name baseline
```

- [ ] **Step 4: Run test and migration drift gate (including drift and destructive SQL exit-code proofs)**

Run: `pnpm nx run @harness/sample-infra:verify`
Expected: PASS (`migration check: schema and committed migrations are in sync`).

Also verify Review Focus #1 by temporarily adding a column in `libs/sample/infra/src/db/schema.ts` (assert `pnpm nx run @harness/sample-infra:migration:check` exits `1`) and temporarily dropping `name` (assert `pnpm nx run @harness/sample-infra:migration:check` exits `2` with `ESCALATE`), then restore `src/db/schema.ts`.

- [ ] **Step 5: Commit**

```bash
git add libs/sample/infra pnpm-lock.yaml
git commit -m "feat(sample-infra): upgrade drizzle to 1.0.0-rc.5-ab785fc and regenerate v1 migration"
```

---

### Task 2: Add `stub<A, E, R>(...args)` to `@harness/gates` and enforce `no-stub` in `tools/oxlint/syntax-bans.js`

**Files:**

- Create: `libs/harness/gates/src/stub.ts`, `libs/harness/gates/src/index.ts`, `libs/harness/gates/test/stub.test.ts`
- Modify: `libs/harness/gates/package.json:6-11`
- Modify: `tools/oxlint/syntax-bans.js:1-74`

**Interfaces:**

- Consumes: `Effect` from `"effect"`.
- Produces:
  - `stub<A, E = never, R = never>(..._usedArgs: ReadonlyArray<unknown>): Effect.Effect<A, E, R>` exported from `@harness/gates`.
  - `harness/syntax-bans` rule in `tools/oxlint/syntax-bans.js` reporting `CallExpression[callee.name='stub']` (and `<ns>.stub(...)`) unless `process.env.HARNESS_PLAN_CHECK === "1"`.

- [ ] **Step 1: Write the failing test in `libs/harness/gates/test/stub.test.ts`**

```ts
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Context, Data, Effect } from "effect"
import { stub } from "../src/index.js"

class SampleError extends Data.TaggedError("SampleError")<{ readonly message: string }> {}
class SampleRepo extends Context.Service<
  SampleRepo,
  { readonly find: (id: string) => Effect.Effect<string> }
>()("SampleRepo") {}

describe("stub<A, E, R>", () => {
  it("preserves exact A, E, R types on Effect.fn skeletons", () => {
    const skeleton = Effect.fn("Sample.skeleton")(function* (id: string) {
      return yield* stub<{ readonly ok: boolean }, SampleError, SampleRepo>(id)
    })

    expectTypeOf(skeleton("123")).toEqualTypeOf<
      Effect.Effect<{ readonly ok: boolean }, SampleError, SampleRepo>
    >()
  })

  it.effect("dies with HARNESS_PLAN_STUB if executed at runtime", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(stub<number>("unused-arg"))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/gates:test`
Expected: FAIL with `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `libs/harness/gates/src/stub.ts`, `libs/harness/gates/src/index.ts`, update `libs/harness/gates/package.json`, and add `stub()` ban to `tools/oxlint/syntax-bans.js`**

Create `libs/harness/gates/src/stub.ts`:

```ts
import { Effect } from "effect"

/** Canonical plan-skeleton helper (docs/mvp_v2.md §6).
 * Preserves inferred A, E, R channels inside Effect.fn and consumes arguments for oxlint.
 * Allowed during `HARNESS_PLAN_CHECK=1`; banned by `harness/syntax-bans` during `verify`. */
export const stub = <A, E = never, R = never>(
  ..._usedArgs: ReadonlyArray<unknown>
): Effect.Effect<A, E, R> => Effect.die("HARNESS_PLAN_STUB")
```

Create `libs/harness/gates/src/index.ts`:

```ts
export * from "./policy.js"
export * from "./stub.js"
```

Update `libs/harness/gates/package.json` so `"exports": { ".": "./src/index.ts" }` and `"nx": { "tags": ["type:contract", "type:service"] }` (allowing `type:domain` libraries to import `stub` during plan skeletons).

Update `tools/oxlint/syntax-bans.js` to add:

```js
const stubMessage =
  "No `stub()` in verified code — replace plan-skeleton `stub<A, E, R>(...)` with a real implementation before running verify."

function isStubCall(node) {
  const callee = node.callee
  if (isIdentifier(callee, "stub")) return true
  return (
    callee != null &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.property, "stub")
  )
}
```

And inside `CallExpression(node)` in `tools/oxlint/syntax-bans.js`:

```js
if (process.env.HARNESS_PLAN_CHECK !== "1" && isStubCall(node)) {
  context.report({ node, message: stubMessage })
}
```

- [ ] **Step 4: Run tests and verify both `HARNESS_PLAN_CHECK=1` and normal `oxlint` behavior**

Run: `pnpm nx run @harness/gates:verify`
Expected: PASS (note: `test/` files are not matched by `libs/**/src/**/*.ts` override, so `stub.test.ts` runs cleanly).

Verify the `HARNESS_PLAN_CHECK` toggle by temporarily placing `stub<string>(input)` inside `libs/sample/domain/src/index.ts`:

- `HARNESS_PLAN_CHECK=1 pnpm nx run @harness/sample-domain:lint` -> PASS
- `pnpm nx run @harness/sample-domain:lint` -> FAIL with `No stub() in verified code`
  Revert the temporary edit in `libs/sample/domain/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/gates tools/oxlint/syntax-bans.js
git commit -m "feat(gates): add stub<A, E, R> skeleton helper and oxlint verify ban"
```

---

### Task 3: Expand `.oxlintrc.json` restricted-import patterns (`alchemy/*`, `@effect/sql-*`) and `.gitignore` (`.harness/`)

**Files:**

- Modify: `.oxlintrc.json:23-46`
- Modify: `.gitignore:1-18`

**Interfaces:**

- Consumes: `.oxlintrc.json` from Phase 0 v1.
- Produces: Static import bans for `drizzle-orm`, `drizzle-orm/*`, `alchemy`, `alchemy/*`, and `@effect/sql-*` outside `type:infra` and `apps/sample`; `.harness/` ignored in git.

- [ ] **Step 1: Update `.oxlintrc.json` `no-restricted-imports` patterns and overrides**

Replace lines 23–46 of `.oxlintrc.json` with:

```json
    {
      "files": ["libs/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      "rules": {
        "harness/syntax-bans": "error",
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "group": ["drizzle-orm", "drizzle-orm/*"],
                "message": "drizzle-orm is infra-only — import it only in type:infra libraries; repositories decode rows into contract Schemas (docs/mvp_v2.md §10)."
              },
              {
                "group": ["alchemy", "alchemy/*"],
                "message": "alchemy is infra/app-only — resources and bindings may live only in type:infra libraries and apps/sample/alchemy.run.ts (docs/mvp_v2.md §9)."
              },
              {
                "group": ["@effect/sql-*"],
                "message": "@effect/sql-* drivers are infra-only — import them only in type:infra libraries (docs/mvp_v2.md §10)."
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["**/infra/src/**/*.ts", "**/infra/test/**/*.ts", "apps/sample/**/*.ts"],
      "rules": {
        "no-restricted-imports": "off"
      }
    }
```

Also append `.harness/` to `.gitignore` under `.alchemy/`.

- [ ] **Step 2: Prove the new import bans on `libs/sample/domain` while `apps/sample` and `libs/sample/infra` pass**

Temporarily add `import * as Cloudflare from "alchemy/Cloudflare"` and `import * as SqlD1 from "@effect/sql-d1"` to `libs/sample/domain/src/index.ts` and run `pnpm exec oxlint libs/sample/domain`.
Expected: FAIL reporting both `alchemy/*` and `@effect/sql-*` import bans.
Revert `libs/sample/domain/src/index.ts` and run `pnpm exec oxlint .`.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .oxlintrc.json .gitignore
git commit -m "feat(gates): ban alchemy/* and @effect/sql-* imports outside infra and sample-app"
```

---

### Task 4: Align `@harness/ingest`, `@harness/decision`, and `apps/harness-cli` seeds with MVP v2

**Files:**

- Modify: `libs/harness/ingest/src/trace-format.ts`, `libs/harness/ingest/test/trace-format.test.ts`
- Modify: `libs/harness/decision/src/idiom-router.ts`, `libs/harness/decision/test/idiom-router.test.ts`
- Modify: `apps/harness-cli/src/index.ts`, `apps/harness-cli/test/index.test.ts`

**Interfaces:**

- Consumes: `effect` (`Schema`, `Effect`, `Layer`), `@effect/ai-typesafe`.
- Produces:
  - `@harness/ingest`: `TRACE_FORMAT_VERSION = 2`, `TracedCallEdge`, `ExercisesSpanEdge` Schemas matching `docs/mvp_v2.md` §8.2 (`schema.pg` `TracedCall` and `ExercisesSpan` edges) alongside `TraceHeader`.
  - `@harness/decision`: Expanded `IDIOM_BLOCKS` (15 blocks: `review`, `services-and-layers`, `errors`, `schema`, `resources-scope`, `concurrency`, `schedule`, `testing`, `alchemy-infra`, `d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom`, `effect`) matching `docs/mvp_v2.md` §5 and §11, plus `assertDecisionLimits(definition)` helper verifying ≤26 options and ≤64 questions.
  - `apps/harness-cli`: `COMMANDS = ["guard", "route", "plan-check", "verify", "done", "ingest", "session", "doctor", "help"] as const`.

- [ ] **Step 1: Write the failing tests in `libs/harness/ingest/test/trace-format.test.ts`, `libs/harness/decision/test/idiom-router.test.ts`, and `apps/harness-cli/test/index.test.ts`**

In `libs/harness/ingest/test/trace-format.test.ts`, add assertions for `TracedCallEdge` and `ExercisesSpanEdge`:

```ts
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  ExercisesSpanEdge,
  makeTraceHeader,
  TracedCallEdge,
  TraceHeader,
  TRACE_FORMAT_VERSION,
} from "../src/trace-format.js"

describe("trace format (v2 Omnigraph & root TestSpan)", () => {
  it("emits the effect-span header with sampled:false", () => {
    expect(TRACE_FORMAT_VERSION).toBe(2)
    const header = Schema.decodeUnknownSync(TraceHeader)(makeTraceHeader("/repo"))
    expect(header.sampled).toBe(false)
    expect(header.tracer).toBe("effect-span")
  })

  it("validates TracedCallEdge and ExercisesSpanEdge records for Omnigraph sync", () => {
    const call = Schema.decodeUnknownSync(TracedCallEdge)({
      callerQualname: "libs/sample/domain/src/index.ts#greet",
      calleeQualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
      callCount: 1,
      receiverLayer: "libs/sample/infra/src/index.ts#PhotoRepoLive",
    })
    expect(call.callCount).toBe(1)

    const exercise = Schema.decodeUnknownSync(ExercisesSpanEdge)({
      testId: "libs/sample/domain/test/index.test.ts::greet greets by name",
      calleeQualname: "libs/sample/domain/src/index.ts#greet",
      callCount: 1,
      receiverLayer: null,
    })
    expect(exercise.testId).toContain("greet")
  })
})
```

In `libs/harness/decision/test/idiom-router.test.ts`, assert that `IDIOM_BLOCKS` includes all v2 pattern categories (`d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom`, `alchemy-infra`) and `assertDecisionLimits(IdiomRouterV1)` passes while rejecting a definition with >26 options.

In `apps/harness-cli/test/index.test.ts`, assert `COMMANDS` contains `"plan-check"` and `"doctor"`.

- [ ] **Step 2: Run the tests across the three packages to verify they fail**

Run: `pnpm nx run-many -t test -p @harness/ingest @harness/decision harness-cli`
Expected: FAIL.

- [ ] **Step 3: Implement the v2 updates in `libs/harness/ingest/src/trace-format.ts`, `libs/harness/decision/src/idiom-router.ts`, and `apps/harness-cli/src/index.ts`**

1. In `libs/harness/ingest/src/trace-format.ts`: set `TRACE_FORMAT_VERSION = 2` (`Schema.Literal(2)`), keep `TraceHeader` and `makeTraceHeader`, and export `TracedCallEdge` (`callerQualname`, `calleeQualname`, `callCount`, `receiverLayer: Schema.NullOr(Schema.String)`) and `ExercisesSpanEdge` (`testId`, `calleeQualname`, `callCount`, `receiverLayer: Schema.NullOr(Schema.String)`).
2. In `libs/harness/decision/src/idiom-router.ts`: expand `IDIOM_BLOCKS` and `IdiomRouterV1` criteria to all 15 v2 categories (`review` first) and export `assertDecisionLimits(definition: { readonly decisions: Record<string, { readonly _tag: string; readonly criteria?: Record<string, string> }> }): void` that checks `questionCount >= 1 && questionCount <= 64` and each criteria map has `2 <= optionCount <= 26`.
3. In `apps/harness-cli/src/index.ts`: set `COMMANDS = ["guard", "route", "plan-check", "verify", "done", "ingest", "session", "doctor", "help"] as const`.

- [ ] **Step 4: Run `verify` on all three packages**

Run: `pnpm nx run-many -t verify -p @harness/ingest @harness/decision harness-cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/ingest libs/harness/decision apps/harness-cli
git commit -m "feat(harness): align ingest, decision, and cli seeds with MVP v2 spec"
```

---

### Task 5: Update `AGENTS.md`, `README.md`, `agent-patterns/README.md`, and `docs/dependency-pins.md` to MVP v2

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `agent-patterns/README.md`
- Modify: `docs/dependency-pins.md`

**Interfaces:**

- Consumes: `docs/mvp_v2.md`.
- Produces: Agent-neutral rules and project documentation reflecting `effect/Graph` + `Omnigraph v0.14.0` (zero Docker/Memgraph), `stub<A, E, R>(...args)`, `harness plan-check`, resident `clef-flash` (9B), and `drizzle-orm@1.0.0-rc.5-ab785fc`.

- [ ] **Step 1: Update `AGENTS.md`, `README.md`, `agent-patterns/README.md`, and `docs/dependency-pins.md`**

1. **`AGENTS.md`:**
   - Order of authority #2: `Source code and tests in repos/effect and repos/alchemy`
   - Order of authority #3: `agent-patterns/*.md and docs/alchemy-llms*.txt`
   - Order of authority #4: `effect/Graph + Omnigraph (harness-mcp / @modernrelay/omnigraph-mcp) and the Nx graph for services and Layers`
   - Workflow: `plan (in Effect idioms, agent-patterns/planning.md template) -> skeleton with stub<A, E, R>(...args) typechecks -> harness plan-check -> implement -> harness verify (the ONLY sanctioned verification) -> harness done.`
2. **`README.md`:**
   - Replace `code-graph-rag` and Docker/Memgraph prerequisites with `effect/Graph` + `omnigraph` (`v0.14.0`, local Lance storage in `.harness/omnigraph/`, zero Docker).
   - Document `stub<A, E, R>` skeleton pattern and `drizzle-orm@1.0.0-rc.5-ab785fc`.
   - Point to [docs/mvp_v2.md](docs/mvp_v2.md) as the active specification.
3. **`docs/dependency-pins.md`:**
   - Update `drizzle-orm` and `drizzle-kit` rows to `1.0.0-rc.5-ab785fc`.
   - Add Phase 1–3 pins (`@modernrelay/omnigraph` `0.14.0`, `@modernrelay/omnigraph-mcp` `0.14.0`, `@ast-grep/napi` `0.51.0`, `ts-morph` `28.0.0`, `typescript` `5.9.3` scoped compiler API override).

- [ ] **Step 2: Run full workspace verification**

Run: `pnpm verify:all`
Expected: PASS across all 9 projects (`@harness/sample-contract`, `@harness/sample-domain`, `@harness/sample-infra`, `@harness/ingest`, `@harness/decision`, `@harness/gates`, `harness-cli`, `harness-mcp`, `sample-app`).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md README.md agent-patterns/README.md docs/dependency-pins.md
git commit -m "docs: align AGENTS.md, README.md, and dependency-pins.md with MVP v2"
```
