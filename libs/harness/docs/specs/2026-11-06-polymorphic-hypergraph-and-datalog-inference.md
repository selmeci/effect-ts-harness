---
id: harness:SPEC-0007
title: Polymorphic Hypergraph & Stratified Datalog Inference Engine
status: accepted
date: 2026-11-06
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0009
enforced_by:
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/concept-lattice.ts
  - libs/harness/graph/src/datalog-engine.ts
  - libs/harness/graph/src/graph-engine.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - libs/harness/decision/src/hole-prior-decision.ts
  - apps/harness-mcp/src/server.ts
spans:
  - ConceptLattice.decide
  - GraphInfer.decide
  - GraphPolicy.decide
  - GraphEngine.loadSnapshot
  - GraphEngine.deserializeSnapshot
  - GraphGc.decide
  - HoleRelevanceAndEdgePrior.evaluate
  - HarnessMcp.executeTool
services:
  - OmnigraphSync
errors:
  - ConceptLatticeCycleError
  - GraphInferenceError
  - GraphSnapshotError
---

# SPEC-0007 · Polymorphic Hypergraph & Stratified Datalog Inference Engine

## Context

This specification defines the behavioral requirements for Milestone 1 of the PERA Bipartite Levi Incidence Hypergraph and Stratified Datalog Inference Engine (`harness:ADR-0009`, `RFC-0001`, `RFC-0002`). The workspace architecture graph is represented as a bipartite Levi incidence hypergraph $G_{\text{Levi}} = (V_E \sqcup V_R, E_{\text{role}})$, validated by `ConceptLattice.decide` and reasoned over by `GraphInfer.decide` across 4 strata in `@electric-sql/d2ts`.

- **Reused Contracts / Errors:** `HarnessGraph`, `OmnigraphSyncError`
- **Reused Services:** `OmnigraphSync`
- **New Capabilities Needed:** `EntityNode`, `RelationNode`, `PlaysRoleEdge`, `ConceptLatticeConfig`, `ConceptLatticeResult`, `ConceptLatticeCycleError`, `GraphSnapshotError`, `GraphInferenceError`, `ConceptLattice.decide`, `DatalogRule`, `DerivationProof`, `InferredAntiPattern`, `SuggestedEdge`, `TypedHoleContextBundle`, `SemanticEdgePriors`, `GraphInferenceResult`, `GraphInfer.decide`, `GraphPolicy.decide`, `HoleRelevanceAndEdgePrior.evaluate`, `harness_graph_infer`, `harness_graph_complete`

## Goal

Every workspace architecture graph is constructed, persisted, and queried as a bipartite PERA hypergraph where ontology subtyping and role cardinalities are verified by `ConceptLattice.decide` and recursive dependency closures, architectural antipatterns (`INF-04..09`), missing-edge completions (`COMP-01..05`), and Personalized PageRank typed-hole context bundles (`COMP-06`) are derived with deterministic `DerivationProof` trees by `GraphInfer.decide`.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and modal verb `shall` or `shall not`.

## Requirements

### 1 · Concept Lattice Validation & Role Inheritance

**Source (`harness:ADR-0009`, `RFC-0001`):** TypeDB-inspired PERA ontology requires acyclic subtype hierarchies, valid role refinements, and inherited role sets before hyperedge validation.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-1.1 | State-driven | **While** evaluating a `ConceptLatticeConfig` within the pure ontology decider, the `ConceptLattice.decide` decider **shall** compute the reflexive-transitive subtype closure and inherited role sets with `R = never` and zero effectful dependencies. | `ConceptLattice.decide` | `GraphCheck` |
| REQ-1.2 | Event-driven | **When** `ConceptLattice.decide` receives a valid acyclic `ConceptLatticeConfig`, the `ConceptLattice.decide` span **shall** return a `ConceptLatticeResult` containing all inherited roles and transitive supertypes for every registered concept within 20ms. | `ConceptLattice.decide` | `PropertyTest` |
| REQ-1.3 | Unwanted behaviour | **If** a `ConceptLatticeConfig` contains a direct or transitive subtype cycle, dangling supertype, duplicate concept ID, or invalid covariant role refinement, **then** the `ConceptLattice.decide` span **shall** fail with a typed `ConceptLatticeCycleError` identifying the offending concept path and reason. | `ConceptLatticeCycleError` | `UnitTest` |

### 2 · Stratified Datalog Inference & Edge Completion

**Source (`harness:ADR-0009`, `RFC-0002`):** Procedural DFS policy checks cannot compose stratified negation, missing-edge completion, or deterministic proof trees.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-2.1 | State-driven | **While** evaluating a bipartite PERA `HarnessGraph` across strata $S_0$ through $S_3$, the `GraphInfer.decide` decider **shall** execute Differential Dataflow fixed-point inference and stratified anti-joins purely in-memory with `R = never`. | `GraphInfer.decide` | `GraphCheck` |
| REQ-2.2 | Event-driven | **When** `GraphInfer.decide` executes stratum $S_1$ over `EffectSignature`, `LayerFlow`, and `TraceabilityTuple` relations, the `GraphInfer.decide` span **shall** derive fixed-point transitive closures with Soufflé min-height provenance for `EffectiveRequires` (`INF-01`), `EffectiveFailsWith` (`INF-02`), and `LayerDependsOn` / `EffectiveTestReach` (`INF-03`) within 50ms. | `GraphInfer.decide` | `PropertyTest` |
| REQ-2.3 | Event-driven | **When** `GraphInfer.decide` executes stratum $S_2$ over the converged $S_1$ closure, the `GraphInfer.decide` span **shall** emit deterministic `InferredAntiPattern` diagnostics with `DerivationProof` DAGs for rules `INF-04` through `INF-09`. | `GraphInfer.decide` | `UnitTest` |
| REQ-2.4 | Event-driven | **When** `GraphInfer.decide` executes stratum $S_3$ over incomplete governance or signature relations and `stub<A, E, R>()` holes, the `GraphInfer.decide` span **shall** emit Flix-lattice-joined `SuggestedEdge` completions (`ConfidenceMillis` with merged `parentProofIds` lineage) and 10-iteration Personalized PageRank `TypedHoleContextBundle` slices for rules `COMP-01` through `COMP-06`. | `GraphInfer.decide` | `UnitTest` |
| REQ-2.5 | Unwanted behaviour | **If** Differential Dataflow execution or hypergraph validation encounters an unexpected runtime failure during `GraphInfer.decide` or `GraphPolicy.decide`, **then** the `GraphInfer.decide` span **shall** fail with a typed `GraphInferenceError` describing the failure reason. | `GraphInferenceError` | `UnitTest` |

### 3 · Policy Delegation, Omnigraph Sync & MCP Tools

**Source (`harness:ADR-0009`, `RFC-0001`, `RFC-0002`):** Downstream policy evaluation, Omnigraph persistence, and MCP agents must consume the reified PERA hypergraph and Datalog inference results directly.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-3.1 | Optional feature | **Where** `OmnigraphSync` synchronizes a `HarnessGraph` into `@modernrelay/omnigraph`, the `OmnigraphSync` service **shall** persist only typed `EntityNode` and `RelationNode` vertices connected by role-specific `Plays*Role` edges in `schema.pg` without `node Any`. | `OmnigraphSync` | `UnitTest` |
| REQ-3.2 | Event-driven | **When** `HarnessMcp.executeTool` receives a `harness_graph_infer` or `harness_graph_complete` request, the `HarnessMcp.executeTool` span **shall** evaluate `HoleRelevanceAndEdgePrior.evaluate` priors when completing edges and return the stratified `GraphInferenceResult` or filtered `SuggestedEdge` candidates with their `DerivationProof` trees within 100ms. | `HarnessMcp.executeTool` | `UnitTest` |
| REQ-3.3 | Unwanted behaviour | **If** a persisted graph snapshot file is missing, contains malformed JSON, fails schema decoding, or contains dangling `PlaysRole` edges during `GraphEngine.loadSnapshot` or `GraphEngine.deserializeSnapshot`, **then** the snapshot loader **shall** fail with a typed `GraphSnapshotError`. | `GraphSnapshotError` | `UnitTest` |

## Assumptions

- **REQ-2.1:** `@electric-sql/d2ts` runs synchronously in memory over bounded workspace graphs (`< 50,000` vertices).

## Out of scope

- **Double-Pushout (DPO) Graph Rewriting & AST Code Projection.** Scheduled for Milestone 2 (`RFC-0003`, `RFC-0004`, `harness:SPEC-0008`).

## Known residual risks

- Cyclic call graphs in workspace TypeScript code require canonical tuple deduplication inside `@electric-sql/d2ts` `.iterate()` so fixed-point convergence terminates in at most $|V|$ steps.

## Acceptance criteria

- All requirement rows pass their declared verification method (`GraphCheck`, `PropertyTest`, `UnitTest`).
- `libs/harness/graph`, `libs/harness/gates`, `libs/harness/decision`, `apps/harness-mcp`, and `apps/harness-cli` pass `pnpm harness gc --strict` and `CI=true pnpm harness verify`.

## Verified Architecture Topology

```mermaid
flowchart TD
    subgraph Ontology["ConceptLattice.decide (R = never)"]
        CL["ConceptLatticeConfig (PERA Subtypes & Roles)"] --> CLDecide["ConceptLattice.decide"]
        CLDecide -->|Valid| CLRes["ConceptLatticeResult (subtypes*, roles*)"]
        CLDecide -->|Cycle / Invalid| CLErr["ConceptLatticeCycleError"]
    end

    subgraph LeviHypergraph["Bipartite Levi Hypergraph G_Levi = (V_E + V_R, E_role)"]
        VE["EntityNode (V_E: EffectFn, ServiceTag, ServiceLayer, TaggedError, SchemaDef, VitestCase, AdrDoc, EarsSpec, PatternDoc)"]
        VR["RelationNode (V_R: EffectSignature, LayerFlow, TraceabilityTuple, HttpEndpointTuple, MigrationTuple)"]
        VE <-->|"PlaysRoleEdge (E_role)"| VR
    end

    subgraph Datalog["GraphInfer.decide (@electric-sql/d2ts, R = never)"]
        S0["Stratum S0: EDB Base Facts"] --> S1["Stratum S1: .iterate() Closures + Souffle Min-Height (INF-01..03)"]
        S1 --> S2["Stratum S2: .antiJoin() Antipatterns (INF-04..09)"]
        S2 --> S3["Stratum S3: Flix Join Edge Completion + PPR Holes (COMP-01..06)"]
        S3 --> Proof["GraphInferenceResult + DerivationProof DAG"]
    end

    LeviHypergraph --> S0
    Proof --> Policy["GraphPolicy.decide & GraphGc.decide"]
    Proof --> MCP["HarnessMcp.executeTool + HoleRelevanceAndEdgePrior.evaluate"]
    LeviHypergraph --> Omni["OmnigraphSync (role-specific Plays*Role edges in schema.pg)"]
```


