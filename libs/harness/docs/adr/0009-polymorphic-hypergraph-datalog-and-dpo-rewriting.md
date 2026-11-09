---
id: harness:ADR-0009
title: Polymorphic PERA Hypergraph & Stratified Datalog Inference Without TypeDB
status: accepted
date: 2026-11-06
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/concept-lattice.ts
  - libs/harness/graph/src/datalog-engine.ts
  - libs/harness/graph/src/graph-rewrite.ts
  - libs/harness/graph/src/graph-engine.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - libs/harness/decision/src/hole-prior-decision.ts
  - libs/harness/decision/src/dpo-ranker-decision.ts
  - apps/harness-mcp/src/server.ts
spans:
  - ConceptLattice.decide
  - GraphInfer.decide
  - DatalogSession.stepFileDelta
  - GraphRewrite.decide
  - GraphPolicy.decide
  - GraphEngine.loadSnapshot
  - GraphEngine.deserializeSnapshot
  - GraphGc.decide
  - HoleRelevanceAndEdgePrior.evaluate
  - HoleRelevanceAndEdgePrior.evaluateBatch
  - DpoCandidateRanker.evaluate
  - DpoCandidateRanker.evaluateBatch
  - HarnessMcp.executeTool
services:
  - OmnigraphSync
  - DatalogSession
errors:
  - ConceptLatticeCycleError
  - GraphInferenceError
  - GraphRewriteError
  - GraphSnapshotError
---

# ADR-0009 · Polymorphic PERA Hypergraph & Stratified Datalog Inference Without TypeDB

## Context and Problem Statement

Representing a workspace architecture as a flat binary directed graph exhibits three structural limitations:

1. **Loss of $k$-ary Tuple Coherence:** An `Effect.fn("Span")<A, E, R>` signature is an atomic multi-way relation binding a caller span, a set of required services $R$, a set of emitted errors $E$, and input/output schemas $A$. Decomposing this signature into independent binary edges loses the invariant that those channels belong to the same signature declaration; the same loss affects `Layer<ROut, E, RIn>` wiring and `ADR -> EARS -> Span -> Test` governance realization chains.
2. **Procedural Policy Verification Without Proof Lineage:** Ad-hoc recursive graph traversals (`Graph.dfs`, `Graph.simplePaths`) cannot declaratively compose stratified negation, infer missing architectural edges (`SuggestedEdge`), or emit machine-verifiable `DerivationProof` DAGs explaining *why* a violation or edge suggestion holds.
3. **Foundation for Algebraic Graph Rewriting (Milestone 2):** Without reified $k$-ary relations and role edges, future planning and auto-repair (scheduled for Milestone 2 in `RFC-0003` and `RFC-0004`) cannot be formulated over typed hyperedges in an in-process TypeScript engine.

How should the harness represent $k$-ary polymorphic architectural relations and execute recursive and negated architectural inference with proof trees while remaining 100% in-process inside Node.js without external JVM/Rust database daemons?

## Decision Drivers

- **Zero External Daemon Footprint:** The graph engine must execute 100% in-process within `libs/harness/graph` and `apps/harness-mcp` with sub-50ms execution latency and zero external server processes.
- **Bipartite Levi Incidence Hypergraph ($G_{\text{Levi}}$):** Represent all semantic relations as reified `RelationNode` vertices connected to `EntityNode` vertices via typed `PlaysRoleEdge` incidences, without catch-all `node Any` vertices in PG-Schema.
- **Pure Decider Semantics (`R = never`):** Ontology lattice validation (`ConceptLattice.decide`) and stratified Datalog inference (`GraphInfer.decide`) must be pure, deterministic Effect deciders with `R = never` and typed error channels (`ConceptLatticeCycleError`, `GraphInferenceError`).
- **Auditable Proof Trees:** Every inferred transitive dependency, architectural antipattern (`INF-04..09`), and normative missing-edge completion (`COMP-01..06`) must carry a deterministic `DerivationProof` DAG derived from Soufflé min-height provenance and Flix lattice joins.
- **Columnar CoW Persistence:** Preserve copy-on-write branch isolation (`plan/*` -> `impl/*`) in `@modernrelay/omnigraph` using explicit vertex labels and role-specific `Plays*Role` edges in `libs/harness/graph/schema.pg`.

## Considered Options

1. **PERA Bipartite Levi Hypergraph (`effect/Graph`) + Stratified Differential Dataflow (`@electric-sql/d2ts`) + Columnar CoW (`@modernrelay/omnigraph`)** — Reify all $k$-ary semantic relations as `RelationNode` vertices ($V_R$) connected to `EntityNode` vertices ($V_E$) via `PlaysRoleEdge` ($E_{\text{role}}$), validate the concept hierarchy and role cardinalities via `ConceptLattice.decide`, and execute 4-stratum Datalog inference and edge completion via `GraphInfer.decide` over `@electric-sql/d2ts`.
2. **External TypeDB 3.x Server + TypeQL Queries** — Delegate hypergraph storage and TypeQL rule inference to a sidecar TypeDB daemon accessed over gRPC.
3. **Binary Graph + Dual-Write / Shadow-Parity Adapter Layer** — Maintain binary edge tags alongside reified hyperedges and run procedural DFS checks in parallel with Datalog.

## Decision Outcome

**Chosen option:** "PERA Bipartite Levi Hypergraph (`effect/Graph`) + Stratified Differential Dataflow (`@electric-sql/d2ts`) + Columnar CoW (`@modernrelay/omnigraph`)", because it delivers TypeDB-grade polymorphic $k$-ary relations, role inheritance, stratified negation, and missing-edge completion purely in-process in TypeScript with zero daemon overhead.

### Architectural Realization

1. **PERA Ontology & Bipartite Levi Incidence Hypergraph (`libs/harness/graph/src/model.ts`, `libs/harness/graph/src/concept-lattice.ts`):**
   - Every vertex in `HarnessGraph` belongs to $V = V_E \sqcup V_R$, modeled as closed branded `Schema.TaggedUnion` types:
     - `EntityNode` ($V_E$): `EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `SchemaDef`, `VitestCase`, `PatternDoc`, `AdrDoc`, `EarsSpec`.
     - `RelationNode` ($V_R$): `EffectSignature`, `LayerFlow`, `TraceabilityTuple`, `HttpEndpointTuple`, `MigrationTuple`.
   - Every edge in `HarnessGraph` is a `PlaysRoleEdge` ($E_{\text{role}}$, `_tag: "PlaysRole"`) binding a `RelationId` and an `EntityNode` (`NodeKey`) via a typed `RoleName`.
   - `ConceptLattice.decide` (`decideConceptLattice`) validates that the concept subtype hierarchy is a strict DAG with valid supertypes, unique concept IDs, and covariant role refinements (failing with `ConceptLatticeCycleError` on any violation) and computes the reflexive-transitive subtype closure $\sqsubseteq^*$ and inherited role map $\text{roles}^*(c)$.
2. **Four-Stratum Datalog Inference & Edge Completion (`libs/harness/graph/src/datalog-engine.ts`):**
   - `GraphInfer.decide` (`decideGraphInference`) compiles `HarnessGraph` into an in-memory `@electric-sql/d2ts` Differential Dataflow pipeline across 4 strata:
     - **Stratum $S_0$ (EDB Base Facts):** Extracts entity, relation, and `PlaysRoleEdge` streams from $G_{\text{Levi}}$.
     - **Stratum $S_1$ (Recursive Positive Closure via `.iterate()`):** Computes fixed-point closures with Soufflé min-height provenance (`minHeightReducer`) for `INF-01` (`EffectiveRequires` / transitive call graph), `INF-02` (`EffectiveFailsWith`), and `INF-03` (`LayerDependsOn` & `EffectiveTestReach`), constructing minimal-height `DerivationProof` witness paths and parent proof DAGs directly from provenance annotations.
     - **Stratum $S_2$ (Stratified Negation & Antipattern Streams):** Evaluates architectural antipatterns `INF-04` (`domain-requires-infra`, `domain-requires-cloud-binding`), `INF-05` (`impure-decider`, `impure-reducer`), `INF-06` (`layer-cycle`, `missing-layer-provider`), `INF-07` (`unmapped-spec-symbol`), `INF-08` (`aggregate-direct-bus-publish`), and `INF-09` (`untested-domain-span`, `unverified-migration`) via `@electric-sql/d2ts` relational operators.
     - **Stratum $S_3$ (Normative Edge Completion `COMP-01..06` & Hazel Typed Hole PPR):** Infers missing `SuggestedEdge` candidates (`COMP-01..05`) joined over the Flix confidence semilattice (`flixConfidenceReducer` merging both `ConfidenceMillis` and `parentProofIds` lineage, modulated by `SemanticEdgePriors`) and computes 10-iteration Personalized PageRank ($\alpha = 0.85$) `TypedHoleContextBundle` slices (`COMP-06`) for `stub<A, E, R>()` holes.
3. **Policy, Omnigraph PG-Schema & MCP Integration (`libs/harness/graph/src/policy-check.ts`, `libs/harness/graph/src/omnigraph-sync.ts`, `apps/harness-mcp/src/server.ts`):**
   - `decideEffectGraphPolicy` (`GraphPolicy.decide`) and `checkEffectGraph` in `libs/harness/graph/src/policy-check.ts` delegate graph policy inference to `decideGraphInference` (`GraphInfer.decide`).
   - Because Omnigraph PG-Schema requires concrete endpoint vertex labels on edge types when `node Any` is absent, `libs/harness/graph/schema.pg` declares concrete role-specific edge types (`PlaysCallerRole`, `PlaysCalleeRole`, `PlaysRequiresServiceRole`, `PlaysFailsWithRole`, `PlaysInputSchemaRole`, `PlaysOutputSchemaRole`, `PlaysSpecifiedTargetRole`, etc.) mapped deterministically from `PlaysRoleEdge` by `toOmnigraphNdjson` and `mapPlaysRoleToOmnigraphEdgeName`.
   - `HarnessMcp.executeTool` in `apps/harness-mcp/src/server.ts` exposes `harness_graph_infer` and `harness_graph_complete` (wiring `HoleRelevanceAndEdgePrior.evaluate` into `SemanticEdgePriors`).

## Rejected Alternatives

### 1 · External TypeDB 3.x Server + TypeQL Queries

Run a standalone TypeDB 3.x server process and translate AST extractions into TypeQL insert and inference transactions over gRPC.

**Why rejected:** Requires an out-of-process Rust/JVM daemon, adds gRPC serialization latency and operational fragility to `pnpm harness verify` and `harness-mcp`, and lacks native copy-on-write git-branch snapshot semantics (`plan/*` -> `impl/*`).

### 2 · Binary Graph + Dual-Write / Shadow-Parity Adapter Layer

Maintain 8 binary edge types (`RequiresService`, `FailsWith`, etc.) and `node Any` in `schema.pg` while dual-writing reified `RelationNode` vertices during a multi-phase transition.

**Why rejected:** Doubles graph vertex/edge memory footprint, retains the untyped `node Any` supertype in Omnigraph PG-Schema, and maintains redundant procedural DFS code in `policy-check.ts` with no architectural benefit.

## Consequences and Enforcement

### Positive Consequences

- Atomic $k$-ary relations (`EffectSignature`, `LayerFlow`, `TraceabilityTuple`, `HttpEndpointTuple`, `MigrationTuple`) preserve full multi-channel Effect and governance invariants.
- Every policy violation (`InferredAntiPattern`) and missing-edge recommendation (`SuggestedEdge`) includes a deterministic `DerivationProof` DAG (`ProofId`, `DatalogRuleId`, `parentProofIds`, premises).
- `libs/harness/graph/schema.pg` enforces concrete entity/relation vertex types connected via role-specific `Plays*Role` edges without `node Any`.

### Negative Consequences and Trade-offs

- Traversing between two entities in $G_{\text{Levi}}$ takes two hops ($v_e \leftarrow v_r \rightarrow v'_e$) via `PlaysRoleEdge` incidence rather than a single binary edge hop.
- All graph consumers (`libs/harness/graph`, `libs/harness/gates`, `apps/harness-mcp`) must operate on the PERA hypergraph contracts.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Reified PERA hypergraph contracts (`EntityNode`, `RelationNode`, `PlaysRoleEdge`) with branded scalar keys and snapshot validation | `libs/harness/graph/src/model.ts`, `libs/harness/graph/src/graph-engine.ts` | `PlaysRoleEdge`, `RelationNode`, `EntityNode`, `GraphSnapshotError` | `ConceptLattice.decide`, `GraphInfer.decide` |
| Acyclic concept lattice validation, covariant role refinement, and inherited role closure ($\sqsubseteq^*$, $\text{roles}^*(c)$) | `libs/harness/graph/src/concept-lattice.ts` | `decideConceptLattice`, `ConceptLatticeCycleError` | `ConceptLattice.decide` |
| Four-stratum Differential Dataflow inference (`INF-01..09`), edge completion (`COMP-01..06`), and incremental DBSP $\mathbb{Z}$-set sessions | `libs/harness/graph/src/datalog-engine.ts`, `libs/harness/graph/src/policy-check.ts` | `decideGraphInference`, `DatalogSession`, `GraphInferenceError`, `decideEffectGraphPolicy` | `GraphInfer.decide`, `DatalogSession.stepFileDelta`, `GraphPolicy.decide`, `GraphGc.decide` |
| Double-Pushout (DPO) algebraic graph rewriting (`PLAN-01..04`, `REP-01..11`) preserving $V_R \in K$ and strictly decreasing $\mu(G) \in \mathbb{N}^6$ with `R = never` | `libs/harness/graph/src/graph-rewrite.ts`, `libs/harness/decision/src/dpo-ranker-decision.ts` | `decideGraphRewrite`, `GraphRewriteError`, `evaluateDpoCandidateRank`, `evaluateDpoCandidatePriorsBatch` | `GraphRewrite.decide`, `DpoCandidateRanker.evaluate`, `DpoCandidateRanker.evaluateBatch` |
| Role-specific Omnigraph PG-Schema synchronization without `node Any` and MCP hypergraph inference tools with System One priors | `libs/harness/graph/src/omnigraph-sync.ts`, `libs/harness/decision/src/hole-prior-decision.ts`, `apps/harness-mcp/src/server.ts` | `OmnigraphSync`, `evaluateHoleCandidatePrior`, `evaluateHoleCandidatePriorsBatch`, `harness_graph_infer`, `harness_graph_complete` | `OmnigraphSync`, `HoleRelevanceAndEdgePrior.evaluate`, `HoleRelevanceAndEdgePrior.evaluateBatch`, `HarnessMcp.executeTool` |

