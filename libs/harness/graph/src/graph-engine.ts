/**
 * Graph Engine — Clean-Slate PERA Bipartite Levi Hypergraph Engine.
 *
 * Provides hypergraph construction, traversal, serialization, snapshotting,
 * and subgraph monomorphism verification.
 */

export {
  type HarnessGraph,
  buildHarnessGraph,
  isHarnessGraph,
  mapPlaysRoleToOmnigraphEdgeName,
  type BuildHarnessGraphInput,
} from "./engine/hypergraph-store.js"

export {
  resolveNode,
  findCallers,
  findCallees,
  findTestsReaching,
  renderMermaid,
  type CallerMatch,
} from "./engine/traversal-queries.js"

export {
  serializeGraphSnapshot,
  deserializeGraphSnapshotEffect,
  saveGraphSnapshot,
  loadGraphSnapshotEffect,
  toOmnigraphNdjson,
  type SerializedGraphSnapshot,
} from "./engine/snapshot-codec.js"

export {
  diffHarnessGraphs,
  verifySubgraphMonomorphism,
  type GraphDiffResult,
  type SubgraphMonomorphismResult,
} from "./engine/graph-diff-monomorphism.js"
