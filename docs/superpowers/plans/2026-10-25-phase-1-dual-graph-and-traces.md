# Effect-TS Engineering Harness — Phase 1 (Dual-Layer Graph & Runtime Test Traces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP v2 dual-layer graph and runtime trace pipeline: `@harness/ingest` (syntactic `Effect.fn` index + `@effect/vitest` recording `Tracer` Layer with synthetic root `TestSpan` + `no-untraced-exports` lint rule), `@harness/graph` (`effect/Graph` functional graph builder + `schema.pg` + `@modernrelay/omnigraph@0.14.0` NDJSON sync + `@ast-grep/napi` structural search), reviewed `agent-patterns/*.md` files indexed as `PatternDoc` nodes, and `apps/harness-mcp` exposing `harness_resolve`, `harness_callers`, `harness_callees`, `harness_tests_reaching`, `harness_structural_search`, and `harness_route`.

**Architecture:** `libs/harness/ingest` records every `Effect.fn("Scope.name")` span executed inside `@effect/vitest` under a synthetic root `TestSpan` (`Test:<file>:<testName>`), emitting deterministic `TracedCall` and `ExercisesSpan` edges (solving Showstopper #1 where single-span leaf use cases had `parent = None`). `libs/harness/graph` builds an in-memory `Graph.DirectedGraph<HarnessNode, HarnessEdge>` (using `effect/Graph`) and persists snapshots to `.harness/graph-snapshot.json` while syncing NDJSON batches to Omnigraph (`@modernrelay/omnigraph@0.14.0`, backed by Lance files in `.harness/omnigraph/`). `apps/harness-mcp` exposes Effect-aware query tools backed by `effect/Graph` snapshots and Omnigraph `.gq` queries.

**Tech Stack:** effect 4.0.0 (`effect/Graph`, `effect/Tracer`) · `@effect/vitest` 4.0.0 · `@modernrelay/omnigraph` 0.14.0 · `@modernrelay/omnigraph-mcp` 0.14.0 · `@ast-grep/napi` 0.51.0 · `@modelcontextprotocol/sdk` 1.32.0 · zod 4.6.5

**Spec:** [docs/mvp_v2.md](../../mvp_v2.md) (§0.1 Showstopper #1, §5, §8.1–8.4, §12 Phase 1).

## Global Constraints

- **Zero Docker, zero Memgraph, zero Python:** All graph state lives in memory (`effect/Graph`), `.harness/graph-snapshot.json`, and local Lance files in `.harness/omnigraph/`.
- **Offline/CI fallback:** Every `@harness/graph` and `apps/harness-mcp` query must work against `.harness/graph-snapshot.json` (`effect/Graph`) even when `omnigraph-server` is not running, and sync to Omnigraph via `og.load({ branch, mode: "merge", data })` when `OMNIGRAPH_URL` (`http://127.0.0.1:8080`) is reachable.
- **Every exported use case and service method must be `Effect.fn("LiteralName")`:** Enforced by `tools/oxlint/syntax-bans.js` in `libs/sample/{domain,service,infra}/src/**/*.ts` with unique literal span names.
- **Synthetic Root `TestSpan`:** The `@effect/vitest` recording `Tracer` Layer must wrap each test in a root span `Test:<relativeTestFile>:<testName>` so leaf `Effect.fn` calls (like `Sample.greet`) always emit an `ExercisesSpan` edge from `VitestCase` to `EffectFn`.
- **Exact pins:** `@modernrelay/omnigraph@0.14.0`, `@modernrelay/omnigraph-mcp@0.14.0`, `@ast-grep/napi@0.51.0`.

## Review Focus

1. **Leaf use case (`Sample.greet`) with no child `Effect.fn` calls:** Without a synthetic root `TestSpan`, `Sample.greet` has `parent = None` and emits zero edges; the recording tracer must attach a root `TestSpan` so `harness_tests_reaching("Sample.greet")` returns the `VitestCase` that called it (tested in Task 2 and Task 5).
2. **Duplicate or non-literal `Effect.fn` names:** Writing `Effect.fn(dynamicName)(...)` or reusing `"Sample.greet"` across two exported functions must fail the static index / lint check deterministically (tested in Task 1).
3. **Transitive `tests_reaching` across `UseCase -> ServiceMethod`:** When a test calls `UseCase` which yields `ServiceMethod`, `harness_tests_reaching("ServiceMethod")` must traverse `VitestCase -[:ExercisesSpan]-> UseCase -[:TracedCall*]-> ServiceMethod` and return the test (tested in Task 3 and Task 5).
4. **Omnigraph NDJSON batch formatting for `og.load({ mode: "merge" })`:** Node and edge records exported by `@harness/graph` must match every `@key` and field type in `libs/harness/graph/schema.pg` (`EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `VitestCase`, `PatternDoc`, `TracedCall`, `ExercisesSpan`) (tested in Task 3).
5. **Graceful operation when `omnigraph-server` daemon is offline (CI mode):** `harness_resolve`, `harness_callers`, `harness_callees`, and `harness_tests_reaching` must fall back to the `.harness/graph-snapshot.json` `effect/Graph` snapshot without throwing unhandled network errors (tested in Task 5).

---

### Task 1: Syntactic `Effect.fn` index in `@harness/ingest` and exported `Effect.fn` literal-name rule

**Files:**

- Modify: `libs/harness/ingest/package.json` (add `@ast-grep/napi: "0.51.0"`, update exports)
- Create: `libs/harness/ingest/src/fn-index.ts`, `libs/harness/ingest/src/index.ts`, `libs/harness/ingest/test/fn-index.test.ts`
- Modify: `tools/oxlint/syntax-bans.js`

**Interfaces:**

- Consumes: `@ast-grep/napi` (`parse`, `Lang.TypeScript`).
- Produces:
  - `IndexedEffectFn`: `{ readonly qualname: string; readonly spanName: string; readonly exportName: string; readonly file: string; readonly line: number; readonly packageTag: "contract" | "domain" | "service" | "infra" | "app"; readonly isStub: boolean }`
  - `indexEffectFnsInFile(filePath: string, sourceText: string, packageTag: IndexedEffectFn["packageTag"]): ReadonlyArray<IndexedEffectFn>`
  - `buildWorkspaceFnIndex(repoRoot: string): Effect.Effect<{ readonly bySpanName: ReadonlyMap<string, IndexedEffectFn>; readonly duplicates: ReadonlyArray<string> }>`
  - Lint check in `tools/oxlint/syntax-bans.js` requiring `Effect.fn("LiteralName")` on exported functions in `libs/sample/domain/src/**/*.ts` and rejecting non-literal `Effect.fn(...)` arguments everywhere.

- [ ] **Step 1: Write the failing test in `libs/harness/ingest/test/fn-index.test.ts`**

```ts
import { describe, expect, it } from "@effect/vitest"
import { indexEffectFnsInFile, validateUniqueSpanNames } from "../src/fn-index.js"

describe("Effect.fn syntactic index", () => {
  it("extracts exported Effect.fn declarations and detects stub() bodies", () => {
    const src = `
      import { Effect } from "effect"
      import { stub } from "@harness/gates"
      export const greet = Effect.fn("Sample.greet")(function* (input: { name: string }) {
        return \`Hello, \${input.name}!\`
      })
      export const pending = Effect.fn("Sample.pending")(function* (id: string) {
        return yield* stub<string>(id)
      })
    `
    const fns = indexEffectFnsInFile("libs/sample/domain/src/index.ts", src, "domain")
    expect(fns).toEqual([
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        exportName: "greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        isStub: false,
      },
      {
        qualname: "libs/sample/domain/src/index.ts#pending",
        spanName: "Sample.pending",
        exportName: "pending",
        file: "libs/sample/domain/src/index.ts",
        line: 7,
        packageTag: "domain",
        isStub: true,
      },
    ])
  })

  it("reports duplicate spanName across indexed functions", () => {
    const a = indexEffectFnsInFile(
      "a.ts",
      `export const f = Effect.fn("Dup")(function* () {})`,
      "domain",
    )
    const b = indexEffectFnsInFile(
      "b.ts",
      `export const g = Effect.fn("Dup")(function* () {})`,
      "domain",
    )
    const result = validateUniqueSpanNames([...a, ...b])
    expect(result.duplicates).toEqual(["Dup"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/ingest:test`
Expected: FAIL with `Cannot find module '../src/fn-index.js'`.

- [ ] **Step 3: Install `@ast-grep/napi@0.51.0`, implement `libs/harness/ingest/src/fn-index.ts`, and add non-literal `Effect.fn` check to `tools/oxlint/syntax-bans.js`**

Add `"@ast-grep/napi": "0.51.0"` to `libs/harness/ingest/package.json` (`onlyBuiltDependencies` in `pnpm-workspace.yaml` if needed).
Implement `indexEffectFnsInFile`, `validateUniqueSpanNames`, and `buildWorkspaceFnIndex` in `libs/harness/ingest/src/fn-index.ts`.
In `tools/oxlint/syntax-bans.js`, check `CallExpression` where `callee` is `Effect.fn`: if `node.arguments[0]` is not a string `Literal` with a non-empty value, report `"Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name'))."`.

- [ ] **Step 4: Run `@harness/ingest:verify`**

Run: `pnpm nx run @harness/ingest:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/ingest tools/oxlint/syntax-bans.js pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(ingest): add syntactic Effect.fn index and literal span-name lint rule"
```

---

### Task 2: Recording `Tracer` Layer with synthetic root `TestSpan` in `@harness/ingest`

**Files:**

- Create: `libs/harness/ingest/src/recording-tracer.ts`, `libs/harness/ingest/test/recording-tracer.test.ts`
- Modify: `libs/harness/ingest/src/index.ts`

**Interfaces:**

- Consumes: `Effect`, `Layer`, `Option`, `Tracer` from `"effect"`, `IndexedEffectFn` from `./fn-index.js`, `TracedCallEdge`, `ExercisesSpanEdge` from `./trace-format.js`.
- Produces:
  - `RecordedSpanEvent`: `{ readonly traceId: string; readonly spanId: string; readonly name: string; readonly parentSpanId: string | null; readonly attributes: ReadonlyRecord<string, unknown> }`
  - `SpanRecorder`: `Context.Service` holding recorded spans and converting them via `toTraceEdges(fnIndex)` into `{ readonly tracedCalls: ReadonlyArray<TracedCallEdge>; readonly exercisesSpans: ReadonlyArray<ExercisesSpanEdge> }`
  - `withRecordedTestSpan(testId: string, receiverLayer?: string)`: wraps an `@effect/vitest` test Effect in a synthetic root span `Test:${testId}` with the recording `Tracer` installed.

- [ ] **Step 1: Write the failing test in `libs/harness/ingest/test/recording-tracer.test.ts`**

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { greet } from "@harness/sample-domain"
import { indexEffectFnsInFile } from "../src/fn-index.js"
import { runWithTestTracer } from "../src/recording-tracer.js"

const helper = Effect.fn("Sample.helper")(function* (name: string) {
  return yield* greet({ name })
})

describe("recording tracer with synthetic root TestSpan", () => {
  it.effect("records ExercisesSpan for a single-span leaf use case (Sample.greet)", () =>
    Effect.gen(function* () {
      const fnIndex = new Map([
        [
          "Sample.greet",
          indexEffectFnsInFile(
            "libs/sample/domain/src/index.ts",
            `export const greet = Effect.fn("Sample.greet")(function* () {})`,
            "domain",
          )[0]!,
        ],
      ])

      const { result, edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::greets by name",
        greet({ name: "Roman" }),
        fnIndex,
      )

      expect(result).toBe("Hello, Roman!")
      expect(edges.exercisesSpans).toEqual([
        {
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: null,
        },
      ])
    }),
  )

  it.effect("records both ExercisesSpan and parent->child TracedCall edges", () =>
    Effect.gen(function* () {
      const fns = indexEffectFnsInFile(
        "libs/sample/domain/src/index.ts",
        `
        export const greet = Effect.fn("Sample.greet")(function* () {})
        export const helper = Effect.fn("Sample.helper")(function* () {})
        `,
        "domain",
      )
      const fnIndex = new Map(fns.map((f) => [f.spanName, f]))

      const { edges } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts::helper calls greet",
        helper("Roman"),
        fnIndex,
      )

      expect(edges.tracedCalls).toEqual([
        {
          callerQualname: "libs/sample/domain/src/index.ts#helper",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: null,
        },
      ])
      expect(edges.exercisesSpans).toHaveLength(2)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/ingest:test`
Expected: FAIL with `Cannot find module '../src/recording-tracer.js'`.

- [ ] **Step 3: Implement `libs/harness/ingest/src/recording-tracer.ts`**

Use `Tracer.make` and `Effect.withTracer` + `Effect.withSpan(\`Test:\${testId}\`)`in`libs/harness/ingest/src/recording-tracer.ts`. Whenever a span starts, record `{ traceId: span.traceId, spanId: span.spanId, name, parentSpanId }`, and when `runWithTestTracer`completes, aggregate`(Test) -> (EffectFn)`pairs into`ExercisesSpanEdge[]`and`(ParentEffectFn) -> (ChildEffectFn)`pairs into`TracedCallEdge[]`. Also support merging external `workerd`spans by matching`traceId`to the root`TestSpan`'s `traceId`.

- [ ] **Step 4: Run `@harness/ingest:verify`**

Run: `pnpm --filter @harness/ingest add -D @harness/sample-domain@workspace:* && pnpm nx run @harness/ingest:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/ingest pnpm-lock.yaml
git commit -m "feat(ingest): implement recording Tracer with synthetic root TestSpan"
```

---

### Task 3: Create `@harness/graph` with `effect/Graph`, `schema.pg`, and Omnigraph NDJSON sync

**Files:**

- Create: `libs/harness/graph/package.json`, `libs/harness/graph/tsconfig.json`, `libs/harness/graph/vitest.config.ts`
- Create: `libs/harness/graph/schema.pg`
- Create: `libs/harness/graph/src/model.ts`, `libs/harness/graph/src/graph-engine.ts`, `libs/harness/graph/src/omnigraph-sync.ts`, `libs/harness/graph/src/structural-search.ts`, `libs/harness/graph/src/index.ts`
- Create: `libs/harness/graph/test/graph-engine.test.ts`

**Interfaces:**

- Consumes: `Graph` from `"effect/Graph"`, `@harness/ingest`, `@modernrelay/omnigraph@0.14.0`, `@ast-grep/napi@0.51.0`.
- Produces:
  - `libs/harness/graph/schema.pg` (exact schema from `docs/mvp_v2.md` §8.2).
  - `HarnessGraph`: wrapper around `Graph.DirectedGraph<HarnessNode, HarnessEdge>` with:
    - `buildHarnessGraph(input: { fns, services, layers, errors, tests, patternDocs, requiresService, failsWith, providesService, layerRequires, tracedCalls, exercisesSpans })`
    - `findTestsReaching(graph, targetNameOrQualname): ReadonlyArray<VitestCaseNode>` (uses `Graph.dfs` / reverse reachability over `ExercisesSpan` + `TracedCall`)
    - `findCallers(graph, target)` / `findCallees(graph, target)`
    - `renderMermaid(graph): string` (via `Graph.toMermaid`)
    - `toOmnigraphNdjson(graph): string` (NDJSON lines formatted for `og.load({ branch, mode: "merge", data })`)
    - `saveGraphSnapshot(graph, path)` / `loadGraphSnapshot(path)` (using `Graph.toSnapshot` / `Graph.fromSnapshot`).

- [ ] **Step 1: Scaffold `libs/harness/graph`, write `schema.pg`, and write the failing test in `libs/harness/graph/test/graph-engine.test.ts`**

Create `libs/harness/graph/package.json` (`"name": "@harness/graph"`, `"tags": ["type:service"]`, dependencies: `"effect": "4.0.0"`, `"@harness/ingest": "workspace:*"`, `"@modernrelay/omnigraph": "0.14.0"`, `"@ast-grep/napi": "0.51.0"`).
Copy the exact `.pg` schema from `docs/mvp_v2.md` §8.2 into `libs/harness/graph/schema.pg`.

Write `libs/harness/graph/test/graph-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  findCallees,
  findCallers,
  findTestsReaching,
  renderMermaid,
  toOmnigraphNdjson,
} from "../src/index.js"

describe("HarnessGraph (effect/Graph + Omnigraph NDJSON)", () => {
  const sampleGraph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        successType: "string",
        isStub: false,
      },
      {
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        spanName: "PhotoRepo.insert",
        file: "libs/sample/infra/src/index.ts",
        line: 10,
        packageTag: "infra",
        successType: "Photo",
        isStub: false,
      },
    ],
    services: [],
    layers: [],
    errors: [],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "abc123",
      },
    ],
    patternDocs: [],
    requiresService: [],
    failsWith: [],
    providesService: [],
    layerRequires: [],
    tracedCalls: [
      {
        callerQualname: "libs/sample/domain/src/index.ts#greet",
        calleeQualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        callCount: 1,
        receiverLayer: "PhotoRepoLive",
      },
    ],
    exercisesSpans: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 1,
        receiverLayer: null,
      },
    ],
  })

  it("resolves tests_reaching transitively from leaf and downstream spans", () => {
    const direct = findTestsReaching(sampleGraph, "Sample.greet")
    expect(direct.map((t) => t.testId)).toEqual([
      "libs/sample/domain/test/index.test.ts::greets by name",
    ])

    const transitive = findTestsReaching(sampleGraph, "PhotoRepo.insert")
    expect(transitive.map((t) => t.testId)).toEqual([
      "libs/sample/domain/test/index.test.ts::greets by name",
    ])
  })

  it("resolves callees and callers with receiverLayer metadata", () => {
    expect(findCallees(sampleGraph, "Sample.greet")).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        receiverLayer: "PhotoRepoLive",
      }),
    ])
    expect(findCallers(sampleGraph, "PhotoRepo.insert")).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/domain/src/index.ts#greet",
      }),
    ])
  })

  it("renders a Mermaid diagram via Graph.toMermaid and exports Omnigraph NDJSON", () => {
    const mermaid = renderMermaid(sampleGraph)
    expect(mermaid).toContain("flowchart")
    const ndjson = toOmnigraphNdjson(sampleGraph)
    expect(ndjson.split("\n").length).toBeGreaterThanOrEqual(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm install && pnpm nx run @harness/graph:test`
Expected: FAIL with `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `libs/harness/graph/src/{model,graph-engine,omnigraph-sync,structural-search,index}.ts`**

Use `import * as Graph from "effect/Graph"` (`Graph.directed`, `Graph.addNode`, `Graph.addEdge`, `Graph.dfs`, `Graph.toMermaid`, `Graph.toSnapshot`, `Graph.fromSnapshot`, `Graph.difference`).
In `omnigraph-sync.ts`, wrap `@modernrelay/omnigraph`'s `OmnigraphClient` in an Effect service (`OmnigraphSync`) that calls `og.load({ branch, mode: "merge", data: toOmnigraphNdjson(graph) })` when `OMNIGRAPH_URL` is reachable, and always writes `.harness/graph-snapshot.json`.
In `structural-search.ts`, wrap `@ast-grep/napi` `parse(Lang.TypeScript, src).root().findAll(pattern)` across workspace `.ts` files (excluding `repos/**`, `node_modules/**`, `dist/**`).

- [ ] **Step 4: Run `@harness/graph:verify`**

Run: `pnpm nx run @harness/graph:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/graph pnpm-lock.yaml
git commit -m "feat(graph): add effect/Graph engine, schema.pg, Omnigraph sync, and ast-grep search"
```

---

### Task 4: Generate reviewed `agent-patterns/*.md` files and index them as `PatternDoc` nodes

**Files:**

- Create:
  - `agent-patterns/planning.md`
  - `agent-patterns/services-and-layers.md`
  - `agent-patterns/errors.md`
  - `agent-patterns/schema.md`
  - `agent-patterns/resources-scope.md`
  - `agent-patterns/concurrency.md`
  - `agent-patterns/schedule.md`
  - `agent-patterns/testing.md`
  - `agent-patterns/alchemy-infra.md`
  - `agent-patterns/d1-repository.md`
  - `agent-patterns/durable-object-state.md`
  - `agent-patterns/httpapi.md`
  - `agent-patterns/rpc.md`
  - `agent-patterns/atom.md`
- Modify: `agent-patterns/README.md`
- Create: `libs/harness/graph/src/pattern-index.ts`, `libs/harness/graph/test/pattern-index.test.ts`

**Interfaces:**

- Consumes: `repos/effect/LLMS.md`, `repos/effect/packages/effect/src/*`, `repos/alchemy/packages/alchemy/src/*`, `docs/alchemy-llms-full.txt`.
- Produces: All 14 reviewed pattern files in `agent-patterns/*.md` (including the plan template in `agent-patterns/planning.md` with `stub<A, E, R>`) and `loadPatternDocs(repoRoot: string): ReadonlyArray<PatternDocNode>` in `@harness/graph`.

- [ ] **Step 1: Write the failing test in `libs/harness/graph/test/pattern-index.test.ts`**

```ts
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { loadPatternDocs } from "../src/pattern-index.js"

describe("agent-patterns index", () => {
  it("loads all 14 reviewed pattern files with non-empty summaries", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..")
    const docs = loadPatternDocs(repoRoot)
    expect(docs.map((d) => d.slug).sort()).toEqual([
      "alchemy-infra",
      "atom",
      "concurrency",
      "d1-repository",
      "durable-object-state",
      "errors",
      "httpapi",
      "planning",
      "resources-scope",
      "rpc",
      "schedule",
      "schema",
      "services-and-layers",
      "testing",
    ])
    for (const doc of docs) {
      expect(doc.summary.length).toBeGreaterThan(20)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/graph:test`
Expected: FAIL.

- [ ] **Step 3: Write the 14 `agent-patterns/*.md` files from `repos/effect` and `repos/alchemy` and implement `loadPatternDocs` in `libs/harness/graph/src/pattern-index.ts`**

Each `agent-patterns/<slug>.md` file starts with `# <Title>` followed by a one-sentence summary paragraph and idiomatic Effect v4 / Alchemy v2 code patterns verified against `repos/effect/LLMS.md` and `repos/alchemy`. `agent-patterns/planning.md` defines the exact 16-row Plan-as-Code markdown template from `docs/mvp_v2.md` §6 and shows the `stub<A, E, R>(...args)` skeleton pattern.

- [ ] **Step 4: Run `@harness/graph:verify`**

Run: `pnpm nx run @harness/graph:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-patterns libs/harness/graph
git commit -m "docs(agent-patterns): add 14 Effect v4 and Alchemy v2 pattern files and PatternDoc indexer"
```

---

### Task 5: Expose Effect graph & trace tools in `apps/harness-mcp` and wire workspace trace sync

**Files:**

- Modify: `apps/harness-mcp/package.json`
- Modify: `apps/harness-mcp/src/server.ts`, `apps/harness-mcp/test/server.test.ts`
- Modify: `libs/sample/domain/package.json`, `libs/sample/domain/test/index.test.ts`

**Interfaces:**

- Consumes: `@harness/graph`, `@harness/ingest`, `@harness/decision`.
- Produces:
  - `createServer(options?: { graph?: HarnessGraph; decisionLayer?: Layer.Layer<DecisionModel.DecisionModel> })` in `apps/harness-mcp/src/server.ts` registering tools:
    - `harness_resolve` (`{ symbolOrSpan: string }`)
    - `harness_callers` (`{ symbolOrSpan: string }`)
    - `harness_callees` (`{ symbolOrSpan: string }`)
    - `harness_tests_reaching` (`{ symbolOrSpan: string }`)
    - `harness_structural_search` (`{ pattern: string }`)
    - `harness_route` (`{ planStep: string }`)
  - `test:trace` script on `@harness/sample-domain` that runs `greet` under `runWithTestTracer`, updates `.harness/graph-snapshot.json`, and proves `harness_tests_reaching("Sample.greet")` returns `libs/sample/domain/test/index.test.ts::greets by name`.

- [ ] **Step 1: Write the failing test in `apps/harness-mcp/test/server.test.ts`**

```ts
import { describe, expect, it } from "vitest"
import { buildHarnessGraph } from "@harness/graph"
import { executeTool, createServer } from "../src/server.js"

describe("harness-mcp tools", () => {
  const graph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        successType: "string",
        isStub: false,
      },
    ],
    services: [],
    layers: [],
    errors: [],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "hash1",
      },
    ],
    patternDocs: [],
    requiresService: [],
    failsWith: [],
    providesService: [],
    layerRequires: [],
    tracedCalls: [],
    exercisesSpans: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 1,
        receiverLayer: null,
      },
    ],
  })

  it("resolves EffectFn node and tests_reaching from the graph snapshot", async () => {
    expect(createServer({ graph })).toBeDefined()
    const resolved = await executeTool(
      "harness_resolve",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(resolved).toMatchObject({
      qualname: "libs/sample/domain/src/index.ts#greet",
      spanName: "Sample.greet",
    })

    const tests = await executeTool(
      "harness_tests_reaching",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(tests).toEqual([
      expect.objectContaining({
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
      }),
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run harness-mcp:test`
Expected: FAIL (`executeTool is not exported`).

- [ ] **Step 3: Implement the 6 MCP tools in `apps/harness-mcp/src/server.ts` and add `test:trace` to `@harness/sample-domain`**

Add `@harness/graph`, `@harness/ingest`, `@harness/decision`, and `effect` to `apps/harness-mcp/package.json`.
Register `harness_resolve`, `harness_callers`, `harness_callees`, `harness_tests_reaching`, `harness_structural_search`, and `harness_route` on `McpServer`, loading `.harness/graph-snapshot.json` when no in-memory `graph` is injected.

- [ ] **Step 4: Run `pnpm verify:all`**

Run: `pnpm install && pnpm verify:all`
Expected: PASS across all 10 workspace projects (including `@harness/graph` and `harness-mcp`).

- [ ] **Step 5: Commit**

```bash
git add apps/harness-mcp libs/sample/domain pnpm-lock.yaml
git commit -m "feat(harness-mcp): expose Effect graph, trace reachability, ast-grep, and router MCP tools"
```
