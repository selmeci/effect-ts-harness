---
id: harness:ADR-0009
title: Polymorphic Hypergraph, Stratified Datalog & DPO Graph Rewriting Without TypeDB
status: accepted
date: 2026-11-06
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/concept-lattice.ts
  - libs/harness/graph/src/datalog-engine.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - apps/harness-mcp/src/server.ts
spans:
  - ConceptLattice.decide
  - GraphInfer.decide
  - GraphGc.decide
  - HarnessMcp.executeTool
services:
  - OmnigraphSync
errors:
  - ConceptLatticeCycleError
---

# ADR-0009 · Polymorphic Hypergraph, Stratified Datalog & DPO Graph Rewriting Without TypeDB

## Context and Problem Statement

The Effect-TS Engineering Harness previously represented workspace architecture as a flat binary directed graph where nodes were a 9-member union (`HarnessNode`) and edges were an 8-member binary union (`RequiresService`, `FailsWith`, `ProvidesService`, `LayerRequires`, `TracedCall`, `ExercisesSpan`, `GovernsSymbol`, `SpecifiesSymbol`), projected into Omnigraph via a weakly-typed `node Any` supertype (`schema.pg`) and checked via procedural depth-first search loops in `libs/harness/graph/src/policy-check.ts`.

This legacy binary graph exhibited three foundational limitations:

1. **Loss of $k$-ary Tuple Coherence:** An `Effect.fn("Span")<A, E, R>` signature is an atomic 4-way relation binding a caller span, a set of required services $R$, a set of emitted errors $E$, and payload schemas $A$. Shattering this signature into independent binary edges lost the invariant that those channels belong to the same signature declaration; the same loss affected `Layer<ROut, E, RIn>` wiring and `ADR -> EARS -> Span -> Test` governance realization chains.
2. **Procedural Policy Verification Without Proof Lineage:** Architectural rules in `libs/harness/graph/src/policy-check.ts` used bespoke recursive loops (`Graph.dfs`, `Graph.simplePaths`) that could not compose stratified negation, infer missing architectural edges (`SuggestedEdge`), or emit machine-verifiable `DerivationProof` DAGs explaining *why* a violation or edge suggestion holds.
3. **Lack of In-Process Algebraic Graph Rewriting:** Without reified $k$-ary relations and role edges, planning and auto-repair could not be formulated as confluent Double-Pushout (DPO) graph transformations over an in-process TypeScript engine.

How should the harness represent $k$-ary polymorphic architectural relations, execute recursive and negated architectural inference with proof trees, and prepare for algebraic graph rewriting while remaining 100% in-process inside Node.js without external JVM/Rust database daemons?

## Decision Drivers

- **Zero External Daemon Footprint:** The graph engine must execute 100% in-process within `libs/harness/graph` and `apps/harness-mcp` with sub-50ms execution latency and zero external server processes.
- **Clean-Slate Bipartite Levi Hypergraph ($G_{\text{Levi}}$):** Eliminate legacy binary edges and `node Any` completely rather than maintaining dual-write adapters or shadow-parity compatibility layers.
- **Pure Decider Semantics (`R = never`):** Ontology lattice validation (`ConceptLattice.decide`) and stratified Datalog inference (`GraphInfer.decide`) must be pure, deterministic Effect deciders with `R = never`.
- **Auditable Proof Trees:** Every inferred transitive dependency, architectural antipattern (`INF-04..09`), and normative missing-edge completion (`COMP-01..05`) must carry a deterministic `DerivationProof` DAG.
- **Columnar CoW Persistence:** Preserve copy-on-write branch isolation (`plan/*` -> `impl/*`) in `@modernrelay/omnigraph` using explicit vertex labels and `PlaysRole` edges in `libs/harness/graph/schema.pg`.

## Considered Options

1. **Clean-Slate PERA Bipartite Levi Hypergraph (`effect/Graph`) + Stratified Differential Dataflow (`@electric-sql/d2ts`) + Columnar CoW (`@modernrelay/omnigraph`)** — Reify all $k$-ary semantic relations as `RelationNode` vertices ($V_R$) connected to `EntityNode` vertices ($V_E$) exclusively via `PlaysRoleEdge` ($E_{\text{role}}$), validate the concept hierarchy via `ConceptLattice.decide`, and execute 4-stratum Datalog inference and edge completion via `GraphInfer.decide` over `@electric-sql/d2ts`.
2. **External TypeDB 3.x Server + TypeQL Queries** — Delegate hypergraph storage and TypeQL rule inference to a sidecar TypeDB daemon accessed over gRPC.
3. **Legacy Binary Graph + Dual-Write / Shadow-Parity Adapter Layer** — Retain the 8 binary edge tags alongside reified hyperedges and run procedural DFS checks in parallel with Datalog.

## Decision Outcome

**Chosen option:** "Clean-Slate PERA Bipartite Levi Hypergraph (`effect/Graph`) + Stratified Differential Dataflow (`@electric-sql/d2ts`) + Columnar CoW (`@modernrelay/omnigraph`)", because it delivers TypeDB-grade polymorphic $k$-ary relations, role inheritance, stratified negation, and missing-edge completion purely in-process in TypeScript with zero daemon overhead and zero legacy binary technical debt.

### Architectural Realization

1. **PERA Ontology & Bipartite Levi Incidence Hypergraph (`libs/harness/graph/src/model.ts`, `libs/harness/graph/src/concept-lattice.ts`):**
   - Every vertex in `HarnessGraph` belongs to $V = V_E \sqcup V_R$, modeled as closed branded `Schema.TaggedUnion` types:
     - `EntityNode` ($V_E$): `EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `SchemaDef`, `VitestCase`, `PatternDoc`, `AdrDoc`, `EarsSpec`.
     - `RelationNode` ($V_R$): `EffectSignature`, `LayerFlow`, `TraceabilityTuple`, `HttpEndpointTuple`, `MigrationTuple`.
   - Every edge in `HarnessGraph` is a `PlaysRoleEdge` ($E_{\text{role}}$, `_tag: "PlaysRole"`) binding a `RelationId` and an `EntityNode` (`NodeKey`) via a typed `RoleName`.
   - `ConceptLattice.decide` (`decideConceptLattice`) validates that the concept subtype hierarchy is a strict DAG (failing with `ConceptLatticeCycleError` on any subtype cycle) and computes the reflexive-transitive subtype closure $\sqsubseteq^*$ and inherited role map $\text{roles}^*(c)$.
2. **Four-Stratum Datalog Inference & Edge Completion (`libs/harness/graph/src/datalog-engine.ts`):**
   - `GraphInfer.decide` (`decideGraphInference`) compiles `HarnessGraph` into an in-memory `@electric-sql/d2ts` Differential Dataflow pipeline across 4 strata:
     - **Stratum $S_0$ (EDB Base Facts):** Extracts entity, relation, and `PlaysRoleEdge` streams from $G_{\text{Levi}}$.
     - **Stratum $S_1$ (Recursive Positive Closure via `.iterate()`):** Computes fixed-point closures for `INF-01` (`EffectiveRequires` / transitive call graph), `INF-02` (`EffectiveFailsWith`), and `INF-03` (`LayerDependsOn` & `EffectiveTestReach`).
     - **Stratum $S_2$ (Stratified Negation via `.antiJoin()`):** Evaluates architectural antipatterns `INF-04` (`domain-requires-infra`, `domain-requires-cloud-binding`), `INF-05` (`impure-decider`, `impure-reducer`), `INF-06` (`layer-cycle`, `missing-layer-provider`), `INF-07` (`unmapped-spec-symbol`), `INF-08` (`aggregate-direct-bus-publish`), and `INF-09` (`untested-domain-span`, `unverified-migration`).
     - **Stratum $S_3$ (Normative Edge Completion `COMP-01..05`):** Infers missing `SuggestedEdge` candidates with deterministic `ConfidenceMillis` and `DerivationProof` lineage.
3. **Policy & MCP Integration (`libs/harness/graph/src/policy-check.ts`, `apps/harness-mcp/src/server.ts`):**
   - `checkEffectGraph` in `libs/harness/graph/src/policy-check.ts` delegates graph policy inference directly to `decideGraphInference` (`GraphInfer.decide`).
   - `HarnessMcp.executeTool` in `apps/harness-mcp/src/server.ts` exposes `harness_graph_infer` and `harness_graph_complete` alongside hypergraph-native traversal tools.

## Rejected Alternatives

### 1 · External TypeDB 3.x Server + TypeQL Queries

Run a standalone TypeDB 3.x server process and translate AST extractions into TypeQL insert and inference transactions over gRPC.

**Why rejected:** Requires an out-of-process Rust/JVM daemon, adds gRPC serialization latency and operational fragility to `pnpm harness verify` and `harness-mcp`, and lacks native copy-on-write git-branch snapshot semantics (`plan/*` -> `impl/*`).

### 2 · Legacy Binary Graph + Dual-Write / Shadow-Parity Adapter Layer

Preserve the 8 legacy binary edge types (`RequiresService`, `FailsWith`, etc.) and `node Any` in `schema.pg` while dual-writing reified `RelationNode` vertices during a multi-phase transition.

**Why rejected:** Doubles graph vertex/edge memory footprint, preserves the untyped `node Any` loophole in Omnigraph PG-Schema, and maintains redundant procedural DFS code in `policy-check.ts` with no architectural benefit.

## Consequences and Enforcement

### Positive Consequences

- Atomic $k$-ary relations (`EffectSignature`, `LayerFlow`, `TraceabilityTuple`, `HttpEndpointTuple`, `MigrationTuple`) preserve full multi-channel Effect and governance invariants.
- Every policy violation (`InferredAntiPattern`) and missing-edge recommendation (`SuggestedEdge`) includes a deterministic `DerivationProof` DAG (`ProofId`, `DatalogRuleId`, premises).
- `libs/harness/graph/schema.pg` eliminates `node Any` and enforces concrete entity/relation vertex types connected via `edge PlaysRole`.

### Negative Consequences and Trade-offs

- Traversing between two entities in $G_{\text{Levi}}$ takes two hops ($v_e \leftarrow v_r \rightarrow v'_e$) via `PlaysRoleEdge` incidence rather than a single binary edge hop.
- All graph consumers (`libs/harness/graph`, `libs/harness/gates`, `apps/harness-mcp`) must operate on the PERA hypergraph contracts.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Reified PERA hypergraph contracts (`EntityNode`, `RelationNode`, `PlaysRoleEdge`) with branded scalar keys | `libs/harness/graph/src/model.ts` | `PlaysRoleEdge`, `RelationNode`, `EntityNode` | `ConceptLattice.decide`, `GraphInfer.decide` |
| Acyclic concept lattice validation and inherited role closure ($\sqsubseteq^*$, $\text{roles}^*(c)$) | `libs/harness/graph/src/concept-lattice.ts` | `decideConceptLattice`, `ConceptLatticeCycleError` | `ConceptLattice.decide` |
| Four-stratum Differential Dataflow inference (`INF-01..09`) and edge completion (`COMP-01..05`) with `R = never` | `libs/harness/graph/src/datalog-engine.ts`, `libs/harness/graph/src/policy-check.ts` | `decideGraphInference`, `checkEffectGraph` | `GraphInfer.decide`, `GraphGc.decide` |
| Strict Omnigraph PG-Schema synchronization without `node Any` and MCP hypergraph inference tools | `libs/harness/graph/src/omnigraph-sync.ts`, `apps/harness-mcp/src/server.ts` | `OmnigraphSync`, `harness_graph_infer`, `harness_graph_complete` | `OmnigraphSync`, `HarnessMcp.executeTool` |
