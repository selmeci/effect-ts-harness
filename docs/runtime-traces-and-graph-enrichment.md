# Runtime Traces & Graph Enrichment

This guide explains how the Effect-TS Engineering Harness captures runtime telemetry from tests and enriches the workspace graph (`HarnessGraph` and Omnigraph) with dynamic execution evidence.

---

## 1. Motivation: Why Static Analysis Is Not Enough

In an Effect-TS architecture, business logic and infrastructure are decoupled via capabilities (`Context.Tag`, `Service`, `Layer`) and distributed actors (such as Cloudflare Durable Objects or HTTP RPC).

Static Abstract Syntax Tree (AST) analysis can extract:

- Declared types, interfaces, and schemas.
- Imports and export bindings.
- Service dependencies required by signatures (`R`).

However, static analysis **cannot** definitively determine:

1. Which concrete service implementation was invoked at runtime.
2. How many times a function or query was executed during a request or transaction.
3. The exact execution path through polymorphic dispatchers or distributed RPC boundaries.
4. Whether a test merely imported a file or actually executed a specific domain logic path.

By instrumenting test execution with `@harness/ingest`, the harness captures runtime OpenTelemetry-compatible trace trees and lifts them directly into the graph as first-class edges.

---

## 2. Ingestion Architecture (`@harness/ingest`)

Telemetry capture is powered by `runWithTestTracer` and `recordingTracerLayer` from `libs/harness/ingest/src/recording-tracer.ts`.

### 2.1 Trace Recording Workflow

```
       +---------------------------------------------+
       |   @effect/vitest (it.effect)                |
       |   runWithTestTracer(testId, effect, ...)    |
       +---------------------------------------------+
                             |
                   emits Test:<testId> span
                             |
         +-------------------+-------------------+
         |                                       |
  Effect.fn("Domain.checkout")           Effect.fn("Inventory.reserve")
  emits child span (parent: Test)        emits child span (parent: checkout)
         |                                       |
         +-------------------+-------------------+
                             |
               W3C traceparent HTTP Header
                             |
       +---------------------------------------------+
       |   Durable Object RPC / Workerd Handler     |
       |   emits remote spans under same traceId    |
       +---------------------------------------------+
                             |
                             v
                toTraceEdges(recordedSpans)
                             |
         +-------------------+-------------------+
         |                                       |
         v                                       v
ExercisesSpan Edge                       TracedCall Edge
(VitestCase -> EffectFn)                 (EffectFn -> EffectFn)
```

1. **Root Test Span:**
   Each test run creates a root span named `Test:<testId>`.
2. **Hierarchical Span Capture:**
   Every function declared with `Effect.fn("SpanName")` automatically generates a child span containing:
   - `traceId`: Shared across the entire execution tree.
   - `spanId` & `parentSpanId`: Preserving caller-to-callee relationships.
   - `durationMs`: Execution time in milliseconds.
   - `attributes`: Layer metadata (e.g. `harness.receiverLayer`).
3. **Distributed Trace Propagation:**
   When crossing process boundaries (e.g. HTTP RPC into a Cloudflare Durable Object), the client injects standard W3C `traceparent` headers. The receiving RPC handler resumes the trace context, ensuring external workerd spans share the root test's `traceId`.

---

## 3. Dynamic Graph Enrichment

After test execution, `toTraceEdges(...)` converts the raw span events into graph edges stored in `HarnessGraph` and synced with Omnigraph.

### 3.1 `ExercisesSpan` Edges (`VitestCase -> EffectFn`)

Connects a specific test case node (`VitestCase`) to the function node (`EffectFn`) that was physically executed.

```typescript
export interface ExercisesSpanEdge {
  readonly _tag: "ExercisesSpan"
  readonly testId: string // e.g. "libs/sample/domain/test/index.test.ts::greets by name"
  readonly calleeQualname: string // e.g. "Sample.greet"
  readonly callCount: number // Number of times executed during this test
  readonly receiverLayer: string | null // e.g. "TestRepoLive" vs "InMemoryMock"
}
```

_Value to Developers:_

- Provides proof of test execution (distinguishing real execution from vacuous tests or mere module imports).
- Records which Layer variant (`receiverLayer`) serviced the execution.

### 3.2 `TracedCall` Edges (`EffectFn -> EffectFn`)

Connects a caller function to a callee function, capturing the actual runtime execution tree.

```typescript
export interface TracedCallEdge {
  readonly _tag: "TracedCall"
  readonly callerQualname: string // e.g. "Domain.uploadPhoto"
  readonly calleeQualname: string // e.g. "AlbumCounterClient.increment"
  readonly callCount: number // Exact execution count
  readonly receiverLayer: string | null
}
```

_Value to Developers:_

- Uncovers the exact runtime call graph across abstractions and layers.
- Detects loop iterations, fan-outs, and invocation bottlenecks.

---

## 4. The Complete Ontological Verification Chain

Enriching the graph with runtime traces completes the end-to-end realization chain from business requirement down to physical test execution:

$$\text{EarsSpec (Requirement)} \xrightarrow{\text{SpecifiesSymbol}} \text{EffectFn (Implementation)} \xleftarrow{\text{ExercisesSpan}} \text{VitestCase (Test Evidence)}$$

When querying the graph via MCP:

- `harness_ontology_why("<Symbol>")`: Traces backward to the governing ADR and EARS specification, while confirming that forward test evidence exists.
- `harness_ontology_impact("<Symbol>")`: Reveals which requirements, downstream callers, and test suites are impacted if a symbol is modified.

---

## 5. Developer Workflows & MCP Tooling

### 5.1 Test Impact Analysis (`harness_tests_reaching`)

Instead of running all monorepo tests, developers and AI agents can query:

```json
{
  "tool": "harness_tests_reaching",
  "arguments": {
    "symbolOrSpan": "Sample.greet"
  }
}
```

**Result:**
The tool traverses incoming `ExercisesSpan` and `TracedCall` edges to return only the test suites that physically exercise `Sample.greet`, enabling rapid, targeted verification.

### 5.2 Call Hierarchy Inspection (`harness_callers` / `harness_callees`)

- `harness_callees`: Shows both static requirements (`RequiresService`) and observed runtime calls (`TracedCall`).
- `harness_callers`: Shows tests exercising the symbol (`ExercisesSpan`) and parent functions invoking it (`TracedCall`).

---

## 6. Automated Guardrails & Verification Gates

Runtime telemetry is continuously validated by deterministic gates:

### 6.1 `SpanBudget.decide` (Performance & Anti-Pattern Gate)

Defined in `libs/harness/gates/src/span-budget.ts`, this pure decider (`decideSpanBudgets` / `checkSpanBudgets`) is invoked inside trace-instrumented tests (alongside `runWithTestTracer`) to evaluate captured trace trees against operational thresholds (it is not invoked automatically by `handleVerify` in the CLI):

1. **N+1 Query Detection (`n-plus-one-call`):**
   - Counts repeated child span invocations under a single parent span (`parentSpanId::childName`).
   - If `count > maxRepeatedChildCalls` (default: 5), the gate fails with:
     > `N+1 span repetition detected: "Domain.checkout" invoked "Repo.findItem" 12 times (budget: 5). Batch queries or use Effect.all.`
2. **Span Duration Budgets (`span-duration-exceeded`):**
   - Asserts that critical operations do not violate execution latency budgets (`maxSpanDurationMs`).

### 6.2 `harness gc --strict` (`untested-effect-fn`)

If a non-stub `Effect.fn` in `type:domain` or `type:contract` has **0 reaching tests** (0 incoming `ExercisesSpan` or `TracedCall` edges), the zero-entropy garbage collection gate (`libs/harness/gates/src/gc-check.ts`) fails with `untested-effect-fn`. During `harness verify` and static workspace graph extraction, `ExercisesSpan` edges are also synthesized by scanning test source files for imported `Effect.fn` references in addition to dynamic `runWithTestTracer` span capture.

### 6.3 `OntologyInvariants.decide` (`ontology-unverified-requirement`)

Every requirement row in an EARS specification (`libs/<scope>/docs/specs/*.md`) claiming `UnitTest`, `PropertyTest`, or `TraceTest` must have at least one reaching test edge in the graph. Unexercised requirements fail verification.

---

## 7. Developer Example: Writing a Trace-Instrumented Test

When authoring `@effect/vitest` tests for domain use cases or infrastructure adapters:

```typescript
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { buildWorkspaceFnIndex, runWithTestTracer } from "@harness/ingest"
import { uploadPhoto } from "domain/photos"
import { TestPhotoRepoLive } from "infra/test-repo"

const fnIndex = buildWorkspaceFnIndex()

describe("Photo Domain", () => {
  it.effect("uploads valid photo and updates album count", () =>
    Effect.gen(function* () {
      const { result, edges, spans } = yield* runWithTestTracer(
        "libs/sample/domain/test/index.test.ts#uploadPhoto",
        uploadPhoto({ title: "Sunset", data: new Uint8Array([1, 2, 3]) }).pipe(
          Effect.provide(TestPhotoRepoLive),
        ),
        fnIndex,
        { receiverLayer: "TestPhotoRepoLive" },
      )

      expect(result.id).toBeDefined()
      // edges.exercisesSpans contains ExercisesSpan edges for uploadPhoto and nested deciders
      // edges.tracedCalls contains TracedCall edges between domain and repo
    }),
  )
})
```

### Key Rules

- **Do not break the trace context:** Avoid calling `Effect.runSync` or `Effect.runPromise` inside synchronous callbacks (`unscoped-effect-run`), as this severs the parent fiber's trace propagation.
- **Trace critical boundaries:** Ensure distributed clients and workers propagate and extract W3C `traceparent` headers.
