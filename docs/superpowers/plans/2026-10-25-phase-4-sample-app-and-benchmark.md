# Effect-TS Engineering Harness — Phase 4 & 5 (Full Sample App on Alchemy v2 & 5-Task Benchmark) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the MVP v2 sample application across `type:contract` (`HttpApi`, `RpcGroup`, committed `openapi.json` + `oasdiff breaking` gate), `type:service` (`PhotoRepo`, `PhotoCounterRpc`), `type:domain` (`Effect.fn` use cases + pure decider), `type:infra` (`Drizzle.D1` on `@effect/sql-d1` + `Drizzle.DurableObject` on `@effect/sql-sqlite-do` with `Cloudflare.toHttpClient(doStub)` W3C trace propagation), `apps/sample` (Alchemy v2 stack + emulated test suite), `apps/sample-web` (Vite + React 19 + `AtomHttpApi` over `@effect/atom-react`), and the Phase 5 5-task evaluation benchmark (`tools/benchmark`).

**Architecture:** One contract (`@harness/sample-contract`) defines the domain Schemas (`Photo`, `CreatePhotoInput`), the public `HttpApi` (`SampleApi`), and the internal Durable Object `RpcGroup` (`PhotoCounterRpc`). `@harness/sample-infra` implements `PhotoRepoLive` over `Drizzle.D1` (`drizzle-orm/effect-d1`) and `PhotoCounterDO` over `Drizzle.DurableObject` (`drizzle-orm/effect-sqlite-do`), routing internal RPC calls over `Cloudflare.toHttpClient(doStub)` so W3C `traceparent` headers propagate `trace_id` from `@effect/vitest` into `workerd` (solving Showstopper #5). `apps/sample-web` consumes `SampleApi` strictly via `AtomHttpApi` with `scope:web` module boundary enforcement.

**Tech Stack:** `effect` 4.0.0 (`effect/httpapi/*`, `effect/rpc/*`, `effect/reactivity/*`) · `alchemy` 2.0.0-beta.80 · `drizzle-orm` `1.0.0-rc.5-ab785fc` · `@effect/sql-d1` 4.0.0 · `@effect/sql-sqlite-do` 4.0.0 · `@effect/atom-react` 4.0.0 · `react` 19.3.0 · `vite` 8.3.2 · `oasdiff` v1.33.0

**Spec:** [docs/mvp_v2.md](../../mvp_v2.md) (§0.1 Showstopper #5, §8.3, §9, §10, §12 Phase 4 & Phase 5).

## Global Constraints

- **Single source of truth in `type:contract`:** `Photo`, `CreatePhotoInput`, `PhotoNotFoundError`, `SampleApi` (`HttpApi`), and `PhotoCounterRpc` (`RpcGroup`) live in `@harness/sample-contract` (imports `effect` only).
- **OpenAPI breaking-change gate (`contract:openapi` + `oasdiff`):** `@harness/sample-contract` exports and commits `openapi.json` (`OpenApi.fromApi(SampleApi)`). Removing a required response field fails `oasdiff breaking` (exit code 2 -> human escalation).
- **Durable Object SQLite synchronous transaction rule (`docs/mvp_v2.md` §10):** All Schema decoding/encoding happens _before_ entering `db.transaction(...)` in `Drizzle.DurableObject` so `Scheduler.MixedScheduler("sync")` never encounters async I/O interleaving.
- **Distributed W3C trace propagation into Durable Objects (`docs/mvp_v2.md` §0.1 #5 & §10):** Internal RPC calls to Durable Objects use `Cloudflare.toHttpClient(doStub)` so W3C `traceparent` (`trace_id`, `span_id`) crosses the `Node <-> workerd` boundary and correlates with the `@effect/vitest` root `TestSpan`.
- **Frontend module boundary (`scope:web`):** `apps/sample-web` is tagged `["type:app", "scope:web"]` and `.oxlintrc.json` restricts `scope:web` to `onlyDependOnLibsWithTags: ["type:contract"]`, plus a ban on raw `fetch(...)` in `apps/sample-web/src/**`.

## Review Focus

1. **`openapi.json` drift or breaking field removal in `@harness/sample-contract`:** Removing a property from `Photo` without updating `openapi.json` fails `contract:openapi:check`, and comparing against a baseline with a removed response field triggers `ESCALATE` in `scripts/check-openapi.mjs` (tested in Task 1).
2. **Wrong column name in `Drizzle.D1` or `Drizzle.DurableObject` queries:** Accessing a non-existent column on `photos` or `photoCounters` fails `tsc --noEmit` at compile time, and `Drizzle` types never leak out of `@harness/sample-infra` (tested in Task 3).
3. **Cross-process `trace_id` correlation between `@effect/vitest` and Durable Object RPC spans:** Calling the DO RPC handler through an HTTP client propagating `traceparent: 00-<traceId>-<spanId>-01` must emit child spans carrying the exact same `traceId` so `@harness/ingest` joins them to the `VitestCase` root `TestSpan` (tested in Task 3).
4. **`apps/sample-web` importing `@harness/sample-domain` or `@harness/sample-infra` or calling `fetch()`:** `.oxlintrc.json` must fail `@nx/enforce-module-boundaries` if `apps/sample-web` imports any non-`type:contract` workspace library, and `tools/oxlint/syntax-bans.js` must fail if `apps/sample-web/src/**` calls `fetch(...)` directly instead of `AtomHttpApi` (tested in Task 4).
5. **5-Task Benchmark harness reproducibility (`tools/benchmark`):** Every benchmark task must record `{ taskId, diagnosticsBeforeGreen, fixUpIterations, totalTokens }` for both `harness` and `no-harness` modes and verify the acceptance criterion (winning on ≥2 of 3 metrics) (tested in Task 5).

---

### Task 1: Expand `@harness/sample-contract` with `HttpApi`, `RpcGroup`, `openapi.json`, and breaking-change gate

**Files:**

- Modify: `libs/sample/contract/package.json`
- Modify: `libs/sample/contract/src/index.ts`, `libs/sample/contract/test/index.test.ts`
- Create: `libs/sample/contract/scripts/check-openapi.mjs`, `libs/sample/contract/openapi.json`

**Interfaces:**

- Consumes: `Schema` from `"effect"`, `HttpApi`, `HttpApiEndpoint`, `HttpApiGroup`, `OpenApi` from `"effect/httpapi/*"`, `Rpc`, `RpcGroup` from `"effect/rpc/*"`.
- Produces:
  - `Photo`, `CreatePhotoInput`, `PhotoNotFoundError` (Schemas).
  - `PhotosApiGroup`, `SampleApi` (`HttpApi` with `GET /photos`, `POST /photos`, `GET /photos/:id`).
  - `PhotoCounterRpc` (`RpcGroup` with `IncrementAlbumCount` and `GetAlbumCount`).
  - Committed `libs/sample/contract/openapi.json` and `openapi:check` script verifying snapshot freshness and running `oasdiff breaking` (with structural breaking-change fallback when the `oasdiff` Go binary is absent in CI).

- [ ] **Step 1: Write the failing test in `libs/sample/contract/test/index.test.ts`**

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  buildOpenApiSpec,
  CreatePhotoInput,
  Photo,
  PhotoCounterRpc,
  SampleApi,
} from "../src/index.js"

describe("sample-contract (Schemas, HttpApi, RpcGroup, OpenAPI)", () => {
  it("decodes Photo and CreatePhotoInput Schemas", () => {
    const input = Schema.decodeUnknownSync(CreatePhotoInput)({
      name: "sunset.jpg",
      albumId: "vacation",
    })
    expect(input.albumId).toBe("vacation")
    const photo = Schema.decodeUnknownSync(Photo)({
      id: 1,
      name: "sunset.jpg",
      albumId: "vacation",
      createdAt: 1700000000,
    })
    expect(photo.id).toBe(1)
  })

  it("exports SampleApi HttpApi, PhotoCounterRpc RpcGroup, and an up-to-date openapi.json", () => {
    expect(SampleApi).toBeDefined()
    expect(PhotoCounterRpc).toBeDefined()
    const liveSpec = buildOpenApiSpec()
    const committed = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../openapi.json"), "utf8"),
    )
    expect(liveSpec).toEqual(committed)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/sample-contract:test`
Expected: FAIL.

- [ ] **Step 3: Implement `SampleApi`, `PhotoCounterRpc`, and `buildOpenApiSpec` in `libs/sample/contract/src/index.ts`, generate `openapi.json`, and add `scripts/check-openapi.mjs`**

Check exact `HttpApi` / `OpenApi` / `RpcGroup` imports against `repos/effect/packages/effect/src/unstable/httpapi` and `repos/effect/packages/effect/src/unstable/rpc` (per `AGENTS.md` authority #2). Write `libs/sample/contract/scripts/check-openapi.mjs` and add `"openapi:check": "node scripts/check-openapi.mjs"` to `libs/sample/contract/package.json` `verify`.

- [ ] **Step 4: Run `@harness/sample-contract:verify`**

Run: `pnpm nx run @harness/sample-contract:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sample/contract
git commit -m "feat(sample-contract): add Photo HttpApi, PhotoCounterRpc, openapi.json, and breaking-change gate"
```

---

### Task 2: Create `@harness/sample-service` (`type:service`) and expand `@harness/sample-domain` (`type:domain`) with pure decider and `Effect.fn` use cases

**Files:**

- Create: `libs/sample/service/package.json`, `libs/sample/service/tsconfig.json`, `libs/sample/service/vitest.config.ts`, `libs/sample/service/src/index.ts`, `libs/sample/service/test/index.test.ts`
- Modify: `libs/sample/domain/package.json`, `libs/sample/domain/src/index.ts`, `libs/sample/domain/test/index.test.ts`

**Interfaces:**

- Consumes: `@harness/sample-contract`.
- Produces:
  - `@harness/sample-service` (`type:service`): `PhotoRepo` (`Context.Service` with `insert`, `findById`, `listAll`) and `AlbumCounterClient` (`Context.Service` with `increment`, `getCount`).
  - `@harness/sample-domain` (`type:domain`):
    - `decideAlbumQuota` (`Effect.fn("Album.decide")` pure decider with `R = never`, failing with `AlbumQuotaExceededError` when count ≥ 100).
    - `uploadPhoto = Effect.fn("Sample.uploadPhoto")(...)` requiring `PhotoRepo | AlbumCounterClient`.
    - `getPhotoById = Effect.fn("Sample.getPhotoById")(...)` requiring `PhotoRepo`.

- [ ] **Step 1: Write the failing tests in `libs/sample/service/test/index.test.ts` and `libs/sample/domain/test/index.test.ts`**

In `libs/sample/domain/test/index.test.ts`, test `decideAlbumQuota` with zero Layers (`R = never`), and test `uploadPhoto` + `getPhotoById` with in-memory test Layers for `PhotoRepo` and `AlbumCounterClient` under `@harness/ingest`'s `runWithTestTracer`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm nx run @harness/sample-domain:test`
Expected: FAIL.

- [ ] **Step 3: Create `libs/sample/service` and implement `decideAlbumQuota`, `uploadPhoto`, and `getPhotoById` in `libs/sample/domain/src/index.ts`**

Follow the workflow: write the skeleton with `stub<Photo, AlbumQuotaExceededError, PhotoRepo | AlbumCounterClient>(input)` first, verify `HARNESS_PLAN_CHECK=1 pnpm effect-graph:check` passes, then replace `stub` with the `Effect.gen` implementation.

- [ ] **Step 4: Run `verify` on `@harness/sample-service` and `@harness/sample-domain`**

Run: `pnpm install && pnpm nx run-many -t verify -p @harness/sample-service @harness/sample-domain`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sample/service libs/sample/domain pnpm-lock.yaml
git commit -m "feat(sample-domain,sample-service): add PhotoRepo, AlbumCounterClient, pure decider, and uploadPhoto use case"
```

---

### Task 3: Implement `Drizzle.D1`, `Drizzle.DurableObject`, and `Cloudflare.toHttpClient` RPC with `trace_id` correlation in `@harness/sample-infra` and `apps/sample`

**Files:**

- Modify: `libs/sample/infra/package.json` (add `@effect/sql-d1: "4.0.0"`, `@effect/sql-sqlite-do: "4.0.0"`, `@harness/sample-contract: "workspace:*"`, `@harness/sample-service: "workspace:*"`, `@harness/sample-domain: "workspace:*"`)
- Modify: `libs/sample/infra/src/db/schema.ts` (add `albumId` to `photos` + `albumCounters` table for DO SQLite, regenerate Drizzle v1 migration)
- Modify: `libs/sample/infra/src/index.ts`, `libs/sample/infra/test/index.test.ts`
- Modify: `apps/sample/alchemy.run.ts`, `apps/sample/package.json`

**Interfaces:**

- Consumes: `@harness/sample-contract`, `@harness/sample-service`, `@harness/sample-domain`, `alchemy@2.0.0-beta.80`, `drizzle-orm@1.0.0-rc.5-ab785fc`.
- Produces:
  - `makePhotoRepoD1Layer(db)` and `PhotoRepoMemoryLayer` in `@harness/sample-infra`.
  - `makeAlbumCounterRpcHandler` + `makeAlbumCounterRpcClient(httpClient)` propagating W3C `traceparent` (`00-<traceId>-<spanId>-01`) so `workerd` / Durable Object RPC spans share the exact `traceId` of the calling `@effect/vitest` root `TestSpan`.
  - Updated `apps/sample/alchemy.run.ts` wiring `Cloudflare.D1.Database` (with `migrationsDir`), Durable Object binding, and `Cloudflare.R2.Bucket`.

- [ ] **Step 1: Write the failing test in `libs/sample/infra/test/index.test.ts`**

Test:

1. `PhotoRepo` queries against a SQLite/D1 Drizzle instance decode rows into contract `Photo` Schemas.
2. Calling `uploadPhoto` across `AlbumCounterClient` (over HTTP RPC with `traceparent` propagation) into the DO RPC handler emits remote spans with the same `traceId` as the root `TestSpan`, and `runWithTestTracer` joins those remote spans into `TracedCall` and `ExercisesSpan` edges.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/sample-infra:test`
Expected: FAIL.

- [ ] **Step 3: Update `libs/sample/infra/src/db/schema.ts`, regenerate the Drizzle migration, implement the repository + W3C trace-propagating RPC bridge in `libs/sample/infra/src/index.ts`, and update `apps/sample/alchemy.run.ts`**

Delete the previous baseline migration in `libs/sample/infra/migrations`, run `pnpm --filter @harness/sample-infra exec drizzle-kit generate --name photos_and_counters`, and implement the D1 repository and DO RPC handler (keeping all Schema decode/encode outside synchronous DO SQLite transactions per `docs/mvp_v2.md` §10).

- [ ] **Step 4: Run `verify` on `@harness/sample-infra` and `sample-app`**

Run: `pnpm install && pnpm nx run-many -t verify -p @harness/sample-infra sample-app`
Expected: PASS (including `migration:check` and `effect-graph:check`).

- [ ] **Step 5: Commit**

```bash
git add libs/sample/infra apps/sample pnpm-lock.yaml
git commit -m "feat(sample-infra,sample-app): add Drizzle D1/DO repositories, W3C traceparent RPC, and Alchemy stack"
```

---

### Task 4: Create `apps/sample-web` (`type:app`, `scope:web`) with `AtomHttpApi` and enforce `scope:web` module & `no-fetch` boundaries

**Files:**

- Create: `apps/sample-web/package.json`, `apps/sample-web/tsconfig.json`, `apps/sample-web/vitest.config.ts`, `apps/sample-web/src/client.ts`, `apps/sample-web/src/ index.ts`, `apps/sample-web/test/client.test.ts`
- Modify: `.oxlintrc.json`, `tools/oxlint/syntax-bans.js`

**Interfaces:**

- Consumes: `SampleApi` from `@harness/sample-contract`, `@effect/atom-react@4.0.0`, `react@19.3.0`, `vite@8.3.2`.
- Produces:
  - `SampleApiClient` derived via `AtomHttpApi` in `apps/sample-web/src/client.ts`.
  - `.oxlintrc.json` boundary rule `{ "sourceTag": "scope:web", "onlyDependOnLibsWithTags": ["type:contract"] }` and `tools/oxlint/syntax-bans.js` rule banning direct `fetch(...)` calls inside `apps/sample-web/src/**`.

- [ ] **Step 1: Write `apps/sample-web` files and the failing test in `apps/sample-web/test/client.test.ts`**

Check `AtomHttpApi` usage in `repos/effect` (`packages/effect/src/unstable/reactivity` or `@effect/atom-react`) and write `apps/sample-web/test/client.test.ts` testing that `SampleApiClient` constructs typed query/mutation atoms from `SampleApi` without raw `fetch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm nx run sample-web:test`
Expected: FAIL until `apps/sample-web/src/client.ts` is implemented.

- [ ] **Step 3: Implement `apps/sample-web/src/client.ts` and add `scope:web` boundary + raw `fetch` ban**

In `.oxlintrc.json`, add `{ "sourceTag": "scope:web", "onlyDependOnLibsWithTags": ["type:contract"] }` at the top of `depConstraints`.
In `tools/oxlint/syntax-bans.js`, report `CallExpression[callee.name='fetch']` when `context.filename` includes `sample-web/src/`.
Prove both gates by temporarily importing `@harness/sample-domain` and calling `fetch("/photos")` in `apps/sample-web/src/client.ts` (assert `oxlint` fails on both), then revert.

- [ ] **Step 4: Run `sample-web:verify`**

Run: `pnpm nx run sample-web:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sample-web .oxlintrc.json tools/oxlint/syntax-bans.js pnpm-lock.yaml
git commit -m "feat(sample-web): add AtomHttpApi client and enforce scope:web contract-only boundary"
```

---

### Task 5: Phase 5 — 5-Task Evaluation Benchmark (`tools/benchmark`) and Final Acceptance Gate

**Files:**

- Create: `libs/harness/gates/src/benchmark.ts`, `libs/harness/gates/test/benchmark.test.ts`
- Modify: `libs/harness/gates/src/index.ts`

**Interfaces:**

- Consumes: `@harness/gates`, `@harness/graph`, `@harness/decision`.
- Produces:
  - `BenchmarkRunMetrics`: `{ readonly taskId: string; readonly mode: "harness" | "no-harness"; readonly diagnosticsBeforeGreen: number; readonly fixUpIterations: number; readonly tokenCount: number }`
  - `compareBenchmarkRuns(runs: ReadonlyArray<BenchmarkRunMetrics>): { readonly winsOnDiagnostics: boolean; readonly winsOnIterations: boolean; readonly winsOnTokens: boolean; readonly passedAcceptance: boolean }`
  - 5 canonical benchmark task definitions (`task-1-contract-schema`, `task-2-domain-use-case`, `task-3-d1-repository`, `task-4-do-rpc`, `task-5-atom-client`) verifying the MVP v2 acceptance criterion (winning on at least 2 of 3 metrics).

- [ ] **Step 1: Write the failing test in `libs/harness/gates/test/benchmark.test.ts`**

```ts
import { describe, expect, it } from "vitest"
import { BENCHMARK_TASKS, compareBenchmarkRuns } from "../src/index.js"

describe("5-task MVP v2 benchmark evaluation", () => {
  it("defines 5 canonical benchmark tasks covering contract, domain, D1, DO RPC, and AtomHttpApi", () => {
    expect(BENCHMARK_TASKS).toHaveLength(5)
  })

  it("evaluates harness vs no-harness across the 3 acceptance metrics (winning >= 2 of 3)", () => {
    const summary = compareBenchmarkRuns([
      {
        taskId: "t1",
        mode: "harness",
        diagnosticsBeforeGreen: 0,
        fixUpIterations: 1,
        tokenCount: 1800,
      },
      {
        taskId: "t1",
        mode: "no-harness",
        diagnosticsBeforeGreen: 3,
        fixUpIterations: 3,
        tokenCount: 3200,
      },
    ])
    expect(summary.winsOnDiagnostics).toBe(true)
    expect(summary.winsOnIterations).toBe(true)
    expect(summary.winsOnTokens).toBe(true)
    expect(summary.passedAcceptance).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/gates:test`
Expected: FAIL.

- [ ] **Step 3: Implement `libs/harness/gates/src/benchmark.ts` and export from `libs/harness/gates/src/index.ts`**

Implement `BENCHMARK_TASKS` and `compareBenchmarkRuns` computing median/mean reductions across the 5 tasks for `diagnosticsBeforeGreen`, `fixUpIterations`, and `tokenCount`, setting `passedAcceptance = [winsOnDiagnostics, winsOnIterations, winsOnTokens].filter(Boolean).length >= 2`.

- [ ] **Step 4: Run full workspace verification (`pnpm verify:all` and `pnpm effect-graph:check`)**

Run: `pnpm verify:all && pnpm effect-graph:check`
Expected: PASS across all 12 workspace projects (`@harness/sample-contract`, `@harness/sample-service`, `@harness/sample-domain`, `@harness/sample-infra`, `@harness/ingest`, `@harness/decision`, `@harness/gates`, `@harness/graph`, `harness-cli`, `harness-mcp`, `sample-app`, `sample-web`).

- [ ] **Step 5: Commit**

```bash
git add libs/harness/gates
git commit -m "feat(gates): add 5-task benchmark evaluator and complete MVP v2 acceptance suite"
```
