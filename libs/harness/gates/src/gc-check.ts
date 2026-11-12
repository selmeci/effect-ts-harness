import { Effect } from "effect"
import { match } from "ts-pattern"
import { decideGraphInference, type HarnessGraph } from "@harness/graph"
import {
  augmentReachabilityWithInference,
  buildGraphReachabilityContext,
  type GcFinding,
  type GcFindingKind,
  type GraphEntropyInput,
  type GraphGcReport,
} from "./plugins/gc/gc-helpers.js"
import { evaluateTopologyEntropyPlugin } from "./plugins/gc/gc-topology-entropy.plugin.js"
import { evaluateTestAndDeciderPlugin } from "./plugins/gc/gc-test-and-decider.plugin.js"
import { evaluateGovernanceDocsPlugin } from "./plugins/gc/gc-governance-docs.plugin.js"
import { evaluatePackageAndMigrationPlugin } from "./plugins/gc/gc-package-and-migration.plugin.js"

export {
  GcFindingKind,
  GcFinding,
  GovernanceDocRef,
  type GovernanceDocReference,
  GraphGcReport,
  type GcReport,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  buildGraphReachabilityContext,
  augmentReachabilityWithInference,
  levenshteinDistance,
  findClosestMatch,
  extractBalancedBraces,
  extractBalancedParens,
  extractTopLevelObjectAnalysis,
  parseGovernanceDocFrontmatter,
  loadGovernanceDocsFromDisk,
  collectWorkspaceTsFiles,
  collectWorkspaceSqlFiles,
  collectWorkspaceAllFiles,
  collectModularPluginFiles,
  IGNORED_SERVICES,
  IGNORED_ERRORS,
  IGNORED_UNTESTED_FNS,
} from "./plugins/gc/gc-helpers.js"
export type { GovernanceDocStatus } from "@harness/graph"
export {
  evaluateTopologyEntropyPlugin,
  checkUnusedContractExports,
} from "./plugins/gc/gc-topology-entropy.plugin.js"
export { evaluateTestAndDeciderPlugin } from "./plugins/gc/gc-test-and-decider.plugin.js"
export { evaluateGovernanceDocsPlugin } from "./plugins/gc/gc-governance-docs.plugin.js"
export {
  evaluatePackageAndMigrationPlugin,
  scanPackageAndMigrationHygiene,
  scanWorkspacePackageHygiene,
} from "./plugins/gc/gc-package-and-migration.plugin.js"

// ADR-0008 & SPEC-0006 Deterministic Enforcement literals:
// "node-sqlite-in-infra" "unmanaged-sql-ddl" "invalid-migrator-record-key" "unsafe-sql-migration"
export const GC_ENFORCEMENT_RULES = [
  "node-sqlite-in-infra",
  "unmanaged-sql-ddl",
  "invalid-migrator-record-key",
  "unsafe-sql-migration",
] as const satisfies ReadonlyArray<GcFindingKind>

export const decideGraphEntropy = Effect.fn("GraphGc.decide")(function* (
  input: GraphEntropyInput,
) {
  const ctx = buildGraphReachabilityContext(input.graph)
  const findings: Array<GcFinding> = []

  const inferenceExit = yield* Effect.exit(decideGraphInference(input.graph))
  match(inferenceExit)
    .with({ _tag: "Success" }, ({ value: inferred }) => {
      augmentReachabilityWithInference(ctx, input.graph, inferred)
    })
    .with({ _tag: "Failure" }, (f) => {
      findings.push({
        kind: "ontology-invariant",
        nodeId: "GraphInfer.decide",
        message: `Stratified Datalog inference failed during GC check: ${String(f.cause)}`,
        action:
          "Fix the ConceptLattice cycle or Datalog inference error reported by GraphInfer.decide.",
      })
    })
    .exhaustive()

  const topoFindings = evaluateTopologyEntropyPlugin(input, ctx)
  const testFindings = evaluateTestAndDeciderPlugin(input, ctx)
  const docFindings = yield* evaluateGovernanceDocsPlugin(input, ctx)
  const pkgFindings = yield* evaluatePackageAndMigrationPlugin(input, ctx)

  findings.push(...topoFindings, ...testFindings, ...docFindings, ...pkgFindings)

  return {
    clean: findings.length === 0,
    findings,
  } satisfies GraphGcReport
})

export const detectGraphEntropy = (
  graph: HarnessGraph,
  options?: Omit<GraphEntropyInput, "graph">,
): GraphGcReport =>
  Effect.runSync(
    decideGraphEntropy({
      graph,
      ...options,
    }),
  )

export const scanGraphEntropy = (
  graph: HarnessGraph,
  options?: Omit<GraphEntropyInput, "graph">,
): GraphGcReport => detectGraphEntropy(graph, options)
