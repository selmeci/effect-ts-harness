---
id: harness:ADR-0025
title: Three-Tier Retrieval with Selective Qwen3-Embedding 8B Omnigraph RRF and Deterministic PageIndex-lite
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/retrieval.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/service/src/retrieval-ports.ts
  - libs/harness/gates/src/embedding-sync-plan.ts
  - libs/harness/decision/src/semantic-conflict-pairer.ts
  - libs/harness/decision/src/idiom-router.ts
  - libs/harness/graph/src/doc-tree.ts
  - libs/harness/graph/src/embedding-sync.ts
  - libs/harness/graph/src/extractor/governance-body-extractor.ts
  - libs/harness/graph/src/extractor/governance-markdown-helpers.ts
  - libs/harness/graph/src/extractor/test-and-governance-extractor.ts
  - libs/harness/graph/src/pattern-index.ts
  - libs/harness/graph/src/archimate-ontology.ts
  - libs/harness/graph/src/omnigraph-operations.ts
  - libs/harness/graph/src/omnigraph-v014-ops.ts
  - libs/harness/graph/src/gq-queries.ts
  - libs/harness/graph/src/gq-query-descriptors.ts
  - libs/harness/graph/src/gq-retrieval-memory.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/queries/harness.gq
  - libs/harness/graph/cluster.yaml
  - libs/harness/infra/src/embedding-client-live.ts
  - libs/harness/infra/src/embedding-cache-live.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts
  - apps/harness-cli/src/commands/omnigraph-lint-gate.ts
  - apps/harness-cli/src/commands/done-omnigraph-helpers.ts
  - apps/harness-cli/src/commands/gc-and-ontology.command.ts
  - apps/harness-cli/src/commands/omnigraph-embedding-sync-helper.ts
  - apps/harness-mcp/src/tools/retrieval.tools.ts
  - apps/harness-mcp/src/tools/retrieval-search-helpers.ts
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
  - apps/harness-mcp/src/tools/ontology-and-gq.tools.ts
spans:
  - EmbeddingSyncPlan.decide
  - SemanticConflictPairer.decide
  - OntologyConflict.collectSemanticCandidates
  - DocTree.parseMarkdownTree
  - DocTree.buildGovernanceCatalog
  - DocTree.inspect
  - GraphEmbeddings.embedDelta
  - GraphEmbeddings.sync
  - OllamaEmbeddingClient.embedBatch
  - FileEmbeddingCache.read
  - FileEmbeddingCache.write
  - HarnessMcp.searchKnowledge
  - HarnessMcp.docTree
services:
  - "@harness/service/EmbeddingClient"
  - "@harness/service/EmbeddingCachePort"
errors:
  - EmbeddingProviderError
  - EmbeddingCacheError
  - DocTreePathError
informs:
  - harness:SPEC-0031
---

# ADR-0025 · Three-Tier Retrieval with Selective Qwen3-Embedding 8B Omnigraph RRF and Deterministic PageIndex-lite

## Context and Problem Statement

`harness:ADR-0015` and `harness:SPEC-0014` (`OMNI-02`) added seven nullable `Vector(768)? @embed(...)` columns to `libs/harness/graph/schema.pg` (`EffectFn.signatureEmbedding`, `ServiceTag.capabilityEmbedding`, `TaggedError.errorEmbedding`, `SchemaDef.schemaEmbedding`, `PatternDoc.summaryEmbedding`, `AdrDoc.titleEmbedding`, and `EarsSpec.titleEmbedding`) alongside `providers.embedding.local-ollama` pointing at `nomic-embed-text`. In practice, five gaps kept hybrid retrieval inactive:

1. **Omnigraph `load` and `mutate` never auto-generate embeddings:** Per Omnigraph v0.14.0 (`embedding_generation: null` on local cluster `/health` and stats), `@embed` metadata does not compute vectors on write, and `toOmnigraphServerNdjsonResult` never emitted any vector property. Every vector column stayed `null`, while `omnigraph-lifecycle-setup.ts` spawned `omnigraph-server` with `OMNIGRAPH_EMBEDDINGS_MOCK=1` whenever `OMNIGRAPH_EMBEDDING_API_KEY` was unset.
2. **Code identifier embeddings carry no value over lexical/graph traversal:** Embedding short symbol names (`spanName`, `name`, `errorTag`, `schemaName`) duplicates exact/fuzzy matching already handled deterministically by the PERA Levi hypergraph, Datalog inference, `@ast-grep/napi`, and Omnigraph `bm25`/`fuzzy(..., 2)`.
3. **Missing governance extraction granularity:** `parseGovernanceDocFile` omitted YAML `informed_by` links (leaving `EarsSpecNode.informedByAdrs` empty in `queryOntologyWhy`), individual `REQ-X.Y` clauses were not first-class entity nodes in `HarnessGraph`, `PatternDoc` captured only the first paragraph, and `SemanticConflictPairer` / `OntologyConflictV1` only compared pairs sharing identical `Effect Symbol` strings.
4. **Routing ceiling and unjoined retrieval:** `IdiomRouterV1` is bounded by Ollama System One's 26-option ceiling (`planning.md` was previously omitted with 18 of 26 slots registered; adding `planning` brings `IDIOM_BLOCKS` to 19 of 26 slots), and agents had no single semantic governance search MCP tool or deterministic section tree for large documents (`docs/rfcs/`, `docs/alchemy-llms-full.txt`, `docs/architecture-and-workflow.md`) or complete EARS/ADR catalog inspection.
5. **Unsuitability of LLM PageIndex for short governance files:** EARS specs (up to ~250 lines) and ADRs (up to ~194 lines) already pass deterministic structural linters (`EarsSpecLint.decide`, `AdrDocLint.decide`), making LLM-based tree generation and multi-step LLM tree search expensive and slow for short files while leaving large monolithic markdown references unindexed.

## Decision Drivers

- **No Vector Overhead on TypeScript Code Navigation:** Preserve deterministic PERA Levi graph, Datalog, AST search, and native Omnigraph `bm25`/`fuzzy` for code symbols without GPU indexing cost.
- **Selective 4096-Dim Embeddings with Content-Hash Caching:** Use locally served `qwen3-embedding:8b` (`Vector(4096)?`, 40k context, strong multilingual and technical recall) only on rich natural-language governance and pattern nodes (`PatternDoc`, `AdrDoc`, and `EarsRequirement`), backed by a `sha256` content-hash cache so unchanged document-sync runs incur 0 ms re-embedding latency.
- **Explicit Graceful Degradation (No Client-Side Mock Vectors):** Never fabricate mock vectors during client-side embedding sync (`GraphEmbeddings.sync`) or query retrieval when Ollama is unavailable; explicitly fall back to Omnigraph `bm25` or tokenized in-memory lexical ranking and surface `retrievalMode` + `degradedReason` transparently (note: `omnigraph-lifecycle-setup.ts` only retains `OMNIGRAPH_EMBEDDINGS_MOCK=1` for `omnigraph-server` subprocess startup when live Ollama is not detected).
- **Deterministic PageIndex-lite Over Markdown Headings:** Provide an instant, zero-LLM flat governance catalog (`AdrDoc` and `EarsSpec`) plus on-demand `tree` and `section` navigation for long docs and incomplete manual `README.md` indexes.
- **Pure Decider Isolation (`R = never`) & Clean-Slate Replacement:** Keep sync planning (`EmbeddingSyncPlan.decide`) and semantic conflict pairing (`SemanticConflictPairer.decide`) pure with `R = never`, and replace the unused `Vector(768)?` columns in place under the repository's clean-slate experimental policy.

## Considered Options

- **Option 1: Dense Vector RAG Over All Code and Governance Files** — Populate `Vector(768)?` or `Vector(4096)?` embeddings on `EffectFn`, `ServiceTag`, `TaggedError`, `SchemaDef`, and chunked files via an external vector store or Omnigraph.
- **Option 2: Pure Lexical BM25 Plus LLM-Built VectifyAI PageIndex** — Drop vector embeddings completely and build LLM-summarized hierarchical trees over every ADR, EARS spec, and RFC.
- **Option 3: Three-Tier Retrieval (Graph/BM25 for Code + Selective `qwen3-embedding:8b` RRF with Content-Hash Cache + Deterministic PageIndex-lite)** — Keep Tier 1 deterministic code graph + `bm25`/`fuzzy`, upgrade Tier 2 in Omnigraph (`schema.pg` v3 `Vector(4096)?` on `PatternDoc`, `AdrDoc`, and `EarsRequirement` with `qwen3-embedding:8b`, `sha256` delta cache, `harness_search_knowledge`, two-stage `harness_route`, and cross-spec conflict candidate pairing), and add Tier 3 deterministic Markdown tree inspection (`harness_doc_tree`).

## Decision Outcome

**Chosen option:** "Three-Tier Retrieval (Graph/BM25 for Code + Selective `qwen3-embedding:8b` RRF + Deterministic PageIndex-lite)", because it matches each retrieval workload to its optimal mechanism: deterministic graph/AST/BM25 for exact code symbols, selective hybrid `rrf(nearest, bm25)` for natural-language governance/pattern intent, and zero-cost Markdown structure indexing for long documents and full catalog discovery.

### Architectural Rules and Guarantees

1. **Tier 1 — Deterministic Code & Governance Foundations:** `test-and-governance-extractor.ts` parses `informed_by` into `EarsSpecNode.informedByAdrs`, `governance-body-extractor.ts` extracts `EarsRequirement` (`REQ-X.Y`) nodes and rich `AdrDoc.searchText`, `pattern-index.ts` extracts full pattern summaries/titles/headings, and `schema.pg` drops bare-identifier embeddings on `EffectFn`, `ServiceTag`, `TaggedError`, `SchemaDef`, `EarsSpec`, and `AdrDoc.titleEmbedding`. `rank_candidate_services_for_stub` and `resolve_effect_fn_fuzzy` rely solely on native Omnigraph `bm25`/`fuzzy`.
2. **Tier 2 — Selective `qwen3-embedding:8b` Omnigraph Hybrid RRF (`Vector(4096)?`):** `schema.pg` declares `Vector(4096)? @embed(...) @index` solely on `PatternDoc.summaryEmbedding`, `AdrDoc.searchEmbedding`, and `EarsRequirement.clauseEmbedding` (omitting `model=` on `@embed` while `cluster.yaml` sets `model: qwen3-embedding:8b` so local mock test servers do not fail model-string checks and live servers match Ollama). `EmbeddingSyncPlan.decide` (`R = never`) plans minimal hash-diffed batches (`CacheHitAll | EmbedDelta | ModelMismatchRebuild`) persisted per batch in `embeddings-v1.json` via `@harness/service/EmbeddingCachePort` (`FileEmbeddingCache.read` / `FileEmbeddingCache.write`, failing closed with typed `EmbeddingCacheError` on symlink/boundary/I/O/snapshot errors rather than masquerading as a cold cache). `OllamaEmbeddingClientLive` (`@harness/service/EmbeddingClient`) validates model availability (distinguishing 7 unavailable causes), dimensions, finiteness, and L2 normalization, failing with `EmbeddingProviderError` on invalid responses while `GraphEmbeddings.sync` degrades cleanly on `EmbeddingProviderError` to `bm25-only` (propagating interrupts and defects, and omitting missing vector fields on degraded syncs so stored vectors are never wiped).
3. **Live Cluster Activation & Two-Stage Consumers:** `omnigraph-lifecycle-setup.ts` detects `qwen3-embedding:8b` on local Ollama `/api/tags` and leaves `OMNIGRAPH_EMBEDDINGS_MOCK` unset when present (`omnigraph-lifecycle.ts` respects the cluster startup lock and linked-worktree guard before any mock-to-live restart); `omnigraph-lint-gate.ts` (`runOmnigraphRebuildFullTextIndexes`, invoked from `gc-and-ontology.command.ts` / `done-omnigraph-helpers.ts`) keeps branch FTS indexes fresh so `bm25` does not fail with `409 FullTextIndexRequired`, and `omnigraph-v014-ops.ts` chunks large vector NDJSON payloads within server body limits. `HarnessMcp.searchKnowledge` (`harness_search_knowledge`) runs vector-parameterized Qwen3 instruction-prefixed RRF queries and hydrates `linkedSymbols`, `harness_route` combines Omnigraph shortlist + `IdiomRouterV1`, and `OntologyConflict.collectSemanticCandidates` (`SemanticConflictPairer.decide`) feeds cross-spec high-similarity requirement pairs without shared symbols into `OntologyConflictV1` (failing closed with `degraded: true` when active cross-spec requirements lack embeddings).
4. **Tier 3 — Deterministic PageIndex-lite (`DocTree` / `harness_doc_tree`):** `DocTree.parseMarkdownTree`, `DocTree.buildGovernanceCatalog`, and `DocTree.inspect` provide deterministic heading-to-line-range trees (ignoring fenced code blocks) and bounded section reads, rejecting escaping, `.git`/`node_modules`, or unsupported paths with `DocTreePathError`.

## Rejected Alternatives

### 1 · Option 1: Dense Vector RAG Over All Code and Governance Files

Embed every `EffectFn`, `ServiceTag`, `TaggedError`, `SchemaDef`, and file chunk into vector storage.

**Why rejected:** Empirical coding-agent benchmarks and this repository's PERA hypergraph show AST/graph/lexical tools outperform dense embeddings on exact identifiers and call edges, while embedding hundreds of short code tokens wastes VRAM and causes stale-vector churn on every refactor.

### 2 · Option 2: Pure Lexical BM25 Plus LLM-Built VectifyAI PageIndex

Abandon vector embeddings completely and build LLM-generated summary trees across all EARS specs, ADRs, and RFCs.

**Why rejected:** EARS and ADR files are short (1–6 pages) and already structurally standardized by `EarsSpecLint.decide` and `AdrDocLint.decide`, so LLM tree construction adds high latency on every edit without helping cross-corpus semantic discovery (synonym mismatch, Slovak-to-English queries, or cross-spec conflict detection).

## Consequences and Enforcement

### Positive Consequences

- Eliminates wasted `Vector(768)` columns and silent `OMNIGRAPH_EMBEDDINGS_MOCK=1` fallback when `qwen3-embedding:8b` is running locally.
- Enables 0 ms cached document-sync embedding recomputation, single-call semantic governance discovery hydrated with graph symbols (`harness_search_knowledge`), and bounded section reading of large docs (`harness_doc_tree`).
- Unlocks cross-spec semantic conflict detection in `OntologyConflictV1` and restores `planning` coverage in `IdiomRouterV1`.

### Negative Consequences and Trade-offs

- Bumps `CLUSTER_SCHEMA_EPOCH` and changes `Vector(768)` to `Vector(4096)`, triggering a one-time clean rebuild of `.harness/omnigraph-cluster` (`RequiresCleanRebuild`).
- Increases `embeddings-v1.json` cache size proportionally to 4096-dim float arrays on `PatternDoc`, `AdrDoc`, and `EarsRequirement` nodes.

### Deterministic Enforcement

| Rule                                                           | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Gate / Mechanism                                                                                                                                                       | Governed Symbols                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure Delta Plan & Content-Hash Cache (`R = never`)             | `libs/harness/contract/src/retrieval.ts`, `libs/harness/gates/src/embedding-sync-plan.ts`, `libs/harness/service/src/retrieval-ports.ts`, `libs/harness/graph/src/embedding-sync.ts`, `libs/harness/infra/src/embedding-cache-live.ts`                                                                                                                                                                                                                                                                  | `decideEmbeddingSyncPlan` (`EmbeddingSyncPlan.decide`), `syncGraphEmbeddings` (`CacheHitAll`, `EmbedDelta`, `ModelMismatchRebuild`)                                    | `EmbeddingSyncPlan.decide`, `GraphEmbeddings.sync`, `GraphEmbeddings.embedDelta`, `FileEmbeddingCache.read`, `FileEmbeddingCache.write`, `@harness/service/EmbeddingCachePort`, `EmbeddingCacheError` |
| Validated Local Ollama Embeddings & Explicit Degradation       | `libs/harness/contract/src/retrieval.ts`, `libs/harness/service/src/retrieval-ports.ts`, `libs/harness/infra/src/embedding-client-live.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts`                                                                                                                                                                                                                                        | `embedBatchViaOllama`, `OllamaEmbeddingClientLive`, `EmbeddingProviderError`, `OMNIGRAPH_EMBEDDINGS_MOCK`                                                              | `@harness/service/EmbeddingClient`, `OllamaEmbeddingClient.embedBatch`, `EmbeddingProviderError`                                                                                                      |
| Selective 4096-Dim Omnigraph Schema & Hybrid RRF               | `libs/harness/graph/schema.pg`, `libs/harness/graph/queries/harness.gq`, `libs/harness/graph/cluster.yaml`, `libs/harness/graph/src/omnigraph-operations.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`, `libs/harness/graph/src/gq-queries.ts`, `apps/harness-cli/src/commands/omnigraph-lint-gate.ts`, `apps/harness-cli/src/commands/done-omnigraph-helpers.ts`                                                                                                                                 | `toOmnigraphServerNdjsonResult`, `runOmnigraphRebuildFullTextIndexes`, `rank_patterns_vector_hybrid`, `search_adrs_vector_hybrid`, `search_requirements_vector_hybrid` | `GraphEmbeddings.sync`                                                                                                                                                                                |
| Governance `informed_by`, `EarsRequirement` & Conflict Pairing | `libs/harness/graph/src/extractor/governance-body-extractor.ts`, `libs/harness/graph/src/extractor/governance-markdown-helpers.ts`, `libs/harness/graph/src/extractor/test-and-governance-extractor.ts`, `libs/harness/graph/src/archimate-ontology.ts`, `libs/harness/decision/src/semantic-conflict-pairer.ts`, `apps/harness-cli/src/commands/gc-and-ontology.command.ts`, `apps/harness-cli/src/commands/omnigraph-embedding-sync-helper.ts`, `apps/harness-mcp/src/tools/ontology-and-gq.tools.ts` | `extractEarsRequirements`, `extractAdrSearchText`, `decideSemanticConflictPairs`, `queryOntologyWhy`                                                                   | `SemanticConflictPairer.decide`, `OntologyConflict.collectSemanticCandidates`                                                                                                                         |
| Deterministic PageIndex-lite & Hybrid MCP Tools                | `libs/harness/graph/src/doc-tree.ts`, `libs/harness/contract/src/workspace-and-process.ts`, `apps/harness-mcp/src/tools/retrieval.tools.ts`, `apps/harness-mcp/src/tools/retrieval-search-helpers.ts`, `apps/harness-mcp/src/tools/graph-navigation.tools.ts`, `libs/harness/decision/src/idiom-router.ts`                                                                                                                                                                                              | `parseMarkdownTree`, `buildGovernanceCatalog`, `inspectDocTree`, `CANONICAL_MCP_TOOL_NAMES`, `harness_search_knowledge`, `harness_doc_tree`                            | `DocTree.parseMarkdownTree`, `DocTree.buildGovernanceCatalog`, `DocTree.inspect`, `DocTreePathError`, `HarnessMcp.searchKnowledge`, `HarnessMcp.docTree`                                              |
