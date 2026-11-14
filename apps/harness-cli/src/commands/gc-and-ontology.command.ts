import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { evaluateOntologyConflicts, extractOntologyConflictPairs, IDIOM_BLOCKS } from "@harness/decision"
import {
  decideGraphEntropy,
  decideOntologyInvariants,
  loadGovernanceDocsFromDisk,
} from "@harness/gates"
import {
  extractWorkspaceTypeAwareGraph,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  renderOntologyMermaid,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"

export const handleGc = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const strict = argv.includes("--strict")
    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo)
    const hasPatternsDir = nodeSyncHostIo.existsSync(join(repoRoot, "agent-patterns"))
    const governanceDocs = loadGovernanceDocsFromDisk(repoRoot, nodeSyncHostIo)
    const finalReport = yield* decideGraphEntropy({
      graph,
      expectedPatterns: hasPatternsDir ? IDIOM_BLOCKS : undefined,
      checkUntestedDomainFns: true,
      checkDeciderPropertyTests: true,
      governanceDocs,
      ...(strict ? { workspaceRoot: repoRoot, hostIo: nodeSyncHostIo } : {}),
    })
    return {
      exitCode: strict && !finalReport.clean ? 1 : 0,
      stdout: JSON.stringify(finalReport),
      stderr: "",
    }
  })

export const handleOntology = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
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
          const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
          const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

          const allDocs =
            options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot, nodeSyncHostIo)
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
          const semanticConflicts = yield* evaluateOntologyConflicts(pairs).pipe(
            Effect.provide(decisionLayer),
          )
          const clean = invariants.clean && semanticConflicts.length === 0

          return {
            exitCode: strict && !clean ? 1 : 0,
            stdout: JSON.stringify({
              clean,
              findings: invariants.findings,
              semanticConflicts,
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
