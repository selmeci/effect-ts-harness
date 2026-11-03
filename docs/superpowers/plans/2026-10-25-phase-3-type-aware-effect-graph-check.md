# Effect-TS Engineering Harness — Phase 3 (Type-Aware `effect-graph:check` & Skeleton Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `@harness/graph` with a type-aware extractor (`ts-morph@28.0.0` backed by `typescript@5.9.3` scoped alias) that resolves exact `Effect<A, E, R>` and `Layer<ROut, E, RIn>` channels—including `stub<A, E, R>(...args)` skeletons and Alchemy `Provider`/`Binding` requirements—and wire the cacheable `effect-graph:check` gate into `harness plan-check` and `nx affected -t verify`.

**Architecture:** Because `typescript@7.0.2` (`tsgo`) is a native binary wrapper whose JS export is only `{ version: "7.0.2" }` (`ts.createProgram === undefined`, Showstopper #4), `libs/harness/graph` uses `ts-morph@28.0.0` pinned to `typescript@5.9.3` via `pnpm-workspace.yaml` `overrides`/`packageExtensions`. The extractor inspects the return type of every exported `Effect.fn` and the type arguments of every exported `Layer<ROut, E, RIn>` and `Context.Service`, populating `RequiresService`, `FailsWith`, `ProvidesService`, and `LayerRequires` edges in `effect/Graph`. `effect-graph:check` uses `Graph.findCycle` and `Graph.simplePaths` to block circular Layers and domain-to-infra / cloud-binding leaks on both skeletons and implementations.

**Tech Stack:** `effect` 4.0.0 (`effect/Graph`) · `ts-morph` 28.0.0 · `typescript` 5.9.3 (scoped override for `ts-morph`) · `@effect/vitest` 4.0.0

**Spec:** [docs/mvp_v2.md](../../mvp_v2.md) (§0.1 Showstopper #2 & #4, §6, §7, §8.1–8.2, §9, §12 Phase 3).

## Global Constraints

- **TypeScript 7 vs. TypeScript 5.9 coexistence:** Root typechecking stays on `typescript@7.0.2` (`@effect/tsgo@0.48.0`); `ts-morph@28.0.0` in `@harness/graph` resolves `typescript@5.9.3` via `pnpm-workspace.yaml` `overrides` (`"ts-morph>typescript": "5.9.3"`, `"@ts-morph/common>typescript": "5.9.3"`).
- **Exact `A, E, R` extraction on both `stub<A, E, R>` skeletons and `Effect.gen` implementations:** When an `Effect.fn` returns `yield* stub<Out, ErrA | ErrB, SvcA | SvcB>(input)`, the extractor must emit `isStub: true`, `FailsWith` edges to `ErrA` and `ErrB`, and `RequiresService` edges to `SvcA` and `SvcB`.
- **Policy rules enforced by `effect-graph:check`:**
  1. **No `type:domain` -> `type:infra` capability leak:** No `EffectFn` in a `type:domain` package may have a path (`Graph.simplePaths`) to a `ServiceTag` defined in `type:infra` or to an Alchemy cloud `Provider<*>` / `Binding.*`.
  2. **No cyclic `Layer` dependencies:** `Graph.findCycle` on the `ServiceLayer -> ServiceTag -> ServiceLayer` projection must return `Option.none()`.
  3. **Decider purity (`R = never`):** Any `Effect.fn` whose span name ends with `.decide` in `type:domain` must have zero `RequiresService` edges.

## Review Focus

1. **`ts-morph` loading under `typescript@7.0.2` workspace root:** Without `"ts-morph>typescript": "5.9.3"` and `"@ts-morph/common>typescript": "5.9.3"` in `pnpm-workspace.yaml`, `new Project()` throws `ts.createProgram is not a function`; the test in Task 1 pins in-process `Project` creation (tested in Task 1).
2. **Union types in `E` and `R` channels (`OutOfStockError | PaymentError`, `InventoryRepo | PaymentService`):** When `E` or `R` is a TypeScript union (`type.isUnion()`), the extractor must split every union member into its own `FailsWith` or `RequiresService` edge rather than treating the union string as a single opaque node (tested in Task 1).
3. **`stub<A, E, R>` skeleton in `type:domain` requiring an Alchemy `Provider` or `type:infra` service:** `checkEffectGraph(graph)` must fail and report the exact `Graph.simplePaths` dependency chain even before implementation code is written (tested in Task 2).
4. **Cyclic `Layer` dependencies (`LayerA` requires `ServiceB`, `LayerB` requires `ServiceA`):** `checkEffectGraph(graph)` must detect the cycle via `Graph.findCycle` and fail with the cycle path (tested in Task 2).
5. **Mermaid topology output in `harness plan-check`:** Running `harness plan-check` must include the `Graph.toMermaid` output showing planned `EffectFn -> ServiceTag` and `ServiceLayer -> ServiceTag` edges for human review (tested in Task 3).

---

### Task 1: Type-aware `A / E / R` and `Layer<ROut, E, RIn>` extractor using `ts-morph@28.0.0` (`typescript@5.9.3`)

**Files:**

- Modify: `pnpm-workspace.yaml` (add `ts-morph` TypeScript 5.9.3 overrides)
- Modify: `libs/harness/graph/package.json` (add `"ts-morph": "28.0.0"`)
- Create: `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/test/type-extractor.test.ts`
- Modify: `libs/harness/graph/src/index.ts`

**Interfaces:**

- Consumes: `Project`, `Type` from `"ts-morph"`, `buildHarnessGraph` from `./graph-engine.js`.
- Produces:
  - `extractTypeAwareGraphFromSource(files: ReadonlyArray<{ readonly filePath: string; readonly content: string; readonly packageTag: PackageTag }>): HarnessGraph`
  - `extractWorkspaceTypeAwareGraph(repoRoot: string): Effect.Effect<HarnessGraph>`

- [ ] **Step 1: Write the failing test in `libs/harness/graph/test/type-extractor.test.ts`**

```ts
import { describe, expect, it } from "vitest"
import { extractTypeAwareGraphFromSource, findCallees } from "../src/index.js"

describe("Type-aware Effect<A, E, R> and Layer<ROut, E, RIn> extractor", () => {
  it("extracts union E and R channels from both stub<A, E, R> skeletons and Effect.fn implementations", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Data, Effect } from "effect"
          export class OutOfStockError extends Data.TaggedError("OutOfStockError")<{ readonly sku: string }> {}
          export class PaymentError extends Data.TaggedError("PaymentError")<{ readonly reason: string }> {}
          export class InventoryRepo extends Context.Service<InventoryRepo, {
            readonly reserve: (sku: string) => Effect.Effect<void, OutOfStockError>
          }>()("InventoryRepo") {}
          export class PaymentService extends Context.Service<PaymentService, {
            readonly charge: (cents: number) => Effect.Effect<void, PaymentError>
          }>()("PaymentService") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/checkout.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { stub } from "@harness/gates"
          import { InventoryRepo, OutOfStockError, PaymentError, PaymentService } from "../../service/src/index.js"

          export const checkoutSkeleton = Effect.fn("Cart.checkout")(function* (sku: string) {
            return yield* stub<{ readonly orderId: string }, OutOfStockError | PaymentError, InventoryRepo | PaymentService>(sku)
          })
        `,
      },
    ])

    const callees = findCallees(graph, "Cart.checkout")
    expect(callees.map((c) => c.qualname).sort()).toEqual([
      "InventoryRepo",
      "OutOfStockError",
      "PaymentError",
      "PaymentService",
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/graph:test`
Expected: FAIL (`extractTypeAwareGraphFromSource is not exported`).

- [ ] **Step 3: Add `ts-morph@28.0.0` with `typescript@5.9.3` workspace override and implement `libs/harness/graph/src/type-extractor.ts`**

In `pnpm-workspace.yaml`, add under `overrides:`:

```yaml
"ts-morph>typescript": "5.9.3"
"@ts-morph/common>typescript": "5.9.3"
```

Add `"ts-morph": "28.0.0"` to `libs/harness/graph/package.json`.
In `libs/harness/graph/src/type-extractor.ts`, inspect exported variable declarations initialized with `Effect.fn(...)` or `Layer.*(...)` and exported classes extending `Context.Service` or `Data.TaggedError`. For each `Effect.fn`, get the call signature's return type `Effect<A, E, R>`, decompose union members of `E` (`FailsWith` edges) and `R` (`RequiresService` edges), and detect `stub(...)` calls (`isStub: true`).

- [ ] **Step 4: Run `@harness/graph:verify`**

Run: `pnpm install && pnpm nx run @harness/graph:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml libs/harness/graph
git commit -m "feat(graph): add ts-morph type-aware A/E/R and Layer extractor with TS 5.9 override"
```

---

### Task 2: Implement `effect-graph:check` policy verifier (`Graph.simplePaths`, `Graph.findCycle`, decider purity)

**Files:**

- Create: `libs/harness/graph/src/policy-check.ts`, `libs/harness/graph/test/policy-check.test.ts`
- Modify: `libs/harness/graph/src/index.ts`

**Interfaces:**

- Consumes: `Graph` from `"effect/Graph"`, `HarnessGraph` from `./graph-engine.js`.
- Produces:
  - `GraphPolicyViolation`: `{ readonly rule: "domain-requires-infra" | "domain-requires-cloud-binding" | "layer-cycle" | "impure-decider"; readonly message: string; readonly path: ReadonlyArray<string> }`
  - `checkEffectGraph(graph: HarnessGraph): { readonly ok: boolean; readonly violations: ReadonlyArray<GraphPolicyViolation>; readonly mermaid: string }`

- [ ] **Step 1: Write the failing test in `libs/harness/graph/test/policy-check.test.ts`**

```ts
import { describe, expect, it } from "vitest"
import { buildHarnessGraph, checkEffectGraph } from "../src/index.js"

describe("effect-graph:check policy rules", () => {
  it("fails when a type:domain Effect.fn requires an infra ServiceTag or cloud binding in R", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#badUseCase",
          spanName: "Sample.badUseCase",
          file: "libs/sample/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: true,
        },
      ],
      services: [
        {
          tagId: "Cloudflare.R2.BucketBinding",
          name: "BucketBinding",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#badUseCase",
          tagId: "Cloudflare.R2.BucketBinding",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe("domain-requires-infra")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/domain/src/index.ts#badUseCase",
      "Cloudflare.R2.BucketBinding",
    ])
  })

  it("fails when ServiceLayers form a dependency cycle via Graph.findCycle", () => {
    const graph = buildHarnessGraph({
      fns: [],
      services: [
        { tagId: "SvcA", name: "SvcA", packageTag: "service", file: "a.ts" },
        { tagId: "SvcB", name: "SvcB", packageTag: "service", file: "b.ts" },
      ],
      layers: [
        { qualname: "LayerA", layerKind: "live", packageTag: "infra", file: "a.ts" },
        { qualname: "LayerB", layerKind: "live", packageTag: "infra", file: "b.ts" },
      ],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [
        { layerQualname: "LayerA", tagId: "SvcA" },
        { layerQualname: "LayerB", tagId: "SvcB" },
      ],
      layerRequires: [
        { layerQualname: "LayerA", tagId: "SvcB" },
        { layerQualname: "LayerB", tagId: "SvcA" },
      ],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "layer-cycle")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run @harness/graph:test`
Expected: FAIL (`checkEffectGraph is not exported`).

- [ ] **Step 3: Implement `libs/harness/graph/src/policy-check.ts` using `Graph.simplePaths`, `Graph.findCycle`, and `Graph.toMermaid`**

Check:

1. Every `EffectFn` with `packageTag === "domain"` has no path in `graph` (`Graph.simplePaths`) to a `ServiceTag` with `packageTag === "infra"` or `tagId` matching `/^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/`.
2. Any `EffectFn` in `packageTag === "domain"` whose `spanName` ends with `.decide` has zero `RequiresService` edges (`impure-decider`).
3. The induced Layer dependency graph has no cycle (`Graph.findCycle`).

- [ ] **Step 4: Run `@harness/graph:verify`**

Run: `pnpm nx run @harness/graph:verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/harness/graph
git commit -m "feat(graph): implement effect-graph:check rules with Graph.simplePaths and Graph.findCycle"
```

---

### Task 3: Wire `effect-graph:check` into `harness plan-check`, `harness verify`, and workspace Nx targets

**Files:**

- Modify: `package.json`, `nx.json`
- Modify: `apps/harness-cli/src/index.ts`, `apps/harness-cli/test/index.test.ts`

**Interfaces:**

- Consumes: `extractWorkspaceTypeAwareGraph`, `checkEffectGraph` from `@harness/graph`.
- Produces:
  - Root script `"effect-graph:check": "node apps/harness-cli/src/index.ts plan-check --graph-only"` and cacheable `effect-graph:check` target in `nx.json`.
  - `harness plan-check` and `harness verify` running `checkEffectGraph` and emitting the `Graph.toMermaid` diagram on pass or exact `GraphPolicyViolation` paths on failure.

- [ ] **Step 1: Write the failing test in `apps/harness-cli/test/index.test.ts`**

Add a test verifying that `runCli(["plan-check", "--graph-only"])` extracts the workspace `HarnessGraph`, runs `checkEffectGraph`, outputs the Mermaid `flowchart` diagram, and exits `0` on the clean workspace.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx run harness-cli:test`
Expected: FAIL.

- [ ] **Step 3: Wire `extractWorkspaceTypeAwareGraph` + `checkEffectGraph` into `apps/harness-cli/src/index.ts`, `package.json`, and `nx.json`**

Update `plan-check` and `verify` in `apps/harness-cli/src/index.ts` to call `extractWorkspaceTypeAwareGraph` and `checkEffectGraph`, printing violations and exiting `1` if `!result.ok`, and printing `result.mermaid` in `plan-check`. Add `"effect-graph:check": { "cache": true }` to `nx.json` `targetDefaults`.

- [ ] **Step 4: Run `pnpm effect-graph:check` and `pnpm verify:all`**

Run: `pnpm effect-graph:check && pnpm verify:all`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json nx.json apps/harness-cli
git commit -m "feat(cli): wire type-aware effect-graph:check and Mermaid output into plan-check and verify"
```
