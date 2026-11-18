import { join } from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import {
  evaluateOntologyConflictsWithStatus,
  extractOntologyConflictPairs,
  IDIOM_BLOCKS,
  type OntologyConflictEvaluationReport,
} from "@harness/decision"
import {
  decideGraphEntropy,
  decideOntologyInvariants,
  type GraphGcReport,
  loadGovernanceDocsChecked,
} from "@harness/gates"
import {
  extractWorkspaceTypeAwareGraph,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  renderOntologyMermaid,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  type CliEnv,
  type CliResult,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveDecisionModelLayer,
} from "./daemon-and-omnigraph.service.js"
import { runOmnigraphMaintenance } from "./done-omnigraph-helpers.js"

export const handleGc = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const strict = argv.includes("--strict")
    const { docs: governanceDocs, findings: docReadFindings } = loadGovernanceDocsChecked(
      repoRoot,
      nodeSyncHostIo,
    )
    if (docReadFindings.length > 0) {
      const failReport: GraphGcReport = {
        clean: false,
        findings: docReadFindings,
      }
      return {
        exitCode: strict ? 1 : 0,
        stdout: JSON.stringify(failReport),
        stderr: "",
      }
    }
    const graph =
      options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo))
    const hasPatternsDir = nodeSyncHostIo.existsSync(join(repoRoot, "agent-patterns"))
    const finalReport = yield* decideGraphEntropy({
      graph,
      expectedPatterns: hasPatternsDir ? IDIOM_BLOCKS : undefined,
      checkUntestedDomainFns: true,
      checkDeciderPropertyTests: true,
      governanceDocs,
      ...(strict ? { workspaceRoot: repoRoot, hostIo: nodeSyncHostIo } : {}),
    })
    if (
      strict &&
      !options?.skipBackgroundDaemons &&
      options?.implGraph === undefined &&
      !isIsolatedExternalWorkspace(repoRoot)
    ) {
      runOmnigraphMaintenance(repoRoot, { includeCleanup: false })
    }
    return {
      exitCode: strict && !finalReport.clean ? 1 : 0,
      stdout: JSON.stringify(finalReport),
      stderr: "",
    }
  })

export const handleOntology = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const graph =
      options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo))
    const sub = argv[1] ?? "layers"

    return yield* match(sub)
      .with("why", () => {
        const symbol = argv[2] ?? ""
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyWhy(graph, symbol)),
          stderr: "",
        })
      })
      .with("impact", () => {
        const symbol = argv[2] ?? ""
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyImpact(graph, symbol)),
          stderr: "",
        })
      })
      .with("layers", () => {
        const formatMermaid = argv.includes("--format=mermaid")
        return Effect.succeed({
          exitCode: 0,
          stdout: formatMermaid
            ? renderOntologyMermaid(graph)
            : JSON.stringify(projectOntologyLayers(graph)),
          stderr: "",
        })
      })
      .with("check", () =>
        Effect.gen(function* () {
          const strict = argv.includes("--strict")
          const deterministic = argv.includes("--deterministic")
          const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
          const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

          const checkedDocs =
            options?.governanceDocs !== undefined
              ? { docs: options.governanceDocs, findings: [] }
              : loadGovernanceDocsChecked(repoRoot, nodeSyncHostIo)
          const allDocs = checkedDocs.docs
          const docFindings = checkedDocs.findings
          if (docFindings.length > 0) {
            const msg = docFindings.map((f) => `[${f.kind}] ${f.location}: ${f.message}`).join("\n")
            return {
              exitCode: 1,
              stdout: JSON.stringify({
                clean: false,
                degraded: true,
                semanticSkipped: deterministic,
                findings: docFindings,
                semanticConflicts: [],
                evaluatedPairs: 0,
              }),
              stderr: `Ontology check failed: unreadable governance docs\n${msg}`,
            }
          }
          const docs = scope
            ? allDocs.filter(
                (doc) =>
                  doc.id.startsWith(`${scope}:`) ||
                  doc.docPath.includes(`libs/${scope}/`) ||
                  doc.docPath.includes(`apps/${scope}/`) ||
                  doc.docPath.includes(`packages/${scope}/`),
              )
            : allDocs

          const invariants = yield* decideOntologyInvariants({
            graph,
            governanceDocs: docs,
          })
          const pairs = yield* extractOntologyConflictPairs(docs, scope)
          const semanticReport: OntologyConflictEvaluationReport = deterministic
            ? { conflicts: [], degraded: false }
            : yield* evaluateOntologyConflictsWithStatus(pairs).pipe(
                Effect.provide(decisionLayer),
                Effect.catchCause((cause) => {
                  if (isPureInterruptCause(cause)) {
                    return Effect.interrupt
                  }
                  const pretty = Cause.pretty(cause)
                  process.stderr.write(
                    `[harness:ontology] semantic conflict check failed: ${pretty}\n`,
                  )
                  return Effect.succeed<OntologyConflictEvaluationReport>({
                    conflicts: [],
                    degraded: true,
                    evaluationError: pretty,
                  })
                }),
              )
          const degraded = semanticReport.degraded
          const clean = invariants.clean && semanticReport.conflicts.length === 0 && !degraded

          return {
            exitCode: strict && !clean ? 1 : 0,
            stdout: JSON.stringify({
              clean,
              degraded,
              semanticSkipped: deterministic,
              ...(semanticReport.evaluationError !== undefined
                ? { evaluationError: semanticReport.evaluationError }
                : {}),
              findings: invariants.findings,
              semanticConflicts: semanticReport.conflicts,
              evaluatedPairs: pairs.length,
            }),
            stderr: "",
          }
        }),
      )
      .otherwise(() =>
        Effect.succeed({
          exitCode: 1,
          stdout: "",
          stderr: `unknown ontology subcommand: ${sub}\nusage: harness ontology <why|impact|layers|check>`,
        }),
      )
  })
