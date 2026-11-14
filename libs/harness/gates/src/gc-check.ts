/**
 * Garbage Collection & Zero-Entropy Gate Coordinator (`GraphGc.decide`).
 *
 * Coordinates graph entropy checks and zero-entropy garbage collection gates.
 * Dispatches to modular plugins and combines findings in deterministic sequence:
 * 1. Topology Entropy: unused-service, unprovided-service, dead-tagged-error, missing-pattern-doc
 * 2. Test & Decider: untested-effect-fn, missing-decider-property-test, shallow-decider-property-test
 * 3. Governance Docs: stale-doc-reference, ears-spec-lint, adr-doc-lint, ontology-invariant
 * 4. Branching SQLite Violations: node-sqlite-in-infra
 * 5. Package & Migration Hygiene: empty-source-module, unused-package-dependency,
 *    unused-contract-export, node-sqlite-in-infra, untrusted-row-brand-make,
 *    unmanaged-sql-ddl, invalid-migrator-record-key, unsafe-sql-migration, architecture-policy-violation
 */
import { Effect } from "effect"
import { match } from "ts-pattern"
import { decideGraphInference } from "@harness/graph"
import {
  augmentReachabilityWithInference,
  buildGraphReachabilityContext,
  type GcFinding,
  type GcFindingKind,
  type GraphEntropyInput,
  type GraphGcReport,
} from "./plugins/gc/gc-helpers.js"
import {
  evaluateBranchingSqliteViolations,
  evaluateTopologyEntropyPlugin,
} from "./plugins/gc/gc-topology-entropy.plugin.js"
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
  evaluateBranchingSqliteViolations,
  checkUnusedContractExports,
} from "./plugins/gc/gc-topology-entropy.plugin.js"
export { evaluateTestAndDeciderPlugin } from "./plugins/gc/gc-test-and-decider.plugin.js"
export { evaluateGovernanceDocsPlugin } from "./plugins/gc/gc-governance-docs.plugin.js"
export {
  evaluatePackageAndMigrationPlugin,
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
  const sqliteFindings = evaluateBranchingSqliteViolations(input)

  findings.push(...topoFindings, ...testFindings, ...docFindings, ...sqliteFindings)

  if (input.workspaceRoot !== undefined) {
    const pkgFindings = yield* evaluatePackageAndMigrationPlugin(input, ctx)
    findings.push(...pkgFindings)
  }

  return {
    clean: findings.length === 0,
    findings,
  } satisfies GraphGcReport
})
