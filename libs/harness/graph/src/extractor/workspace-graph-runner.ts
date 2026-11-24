import * as path from "node:path"
import type { SyncHostIo } from "@harness/service/host-io"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type EffectFnNode,
  type HarnessEdge,
  type HarnessGraph,
  type HarnessNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type UnresolvedGraphReference,
} from "../model.js"
import { loadPatternDocs } from "../pattern-index.js"
import {
  type ExtractTypeGraphOptions,
  type SourceFileInput,
  type TypeExtractorOptions,
  checkTopologySnapshotMatch,
  checkWorkspaceSnapshotMatch,
  computeBaseTopologyHash,
  createTypeScriptProgramSession,
  findWorkspaceSrcFiles,
  findWorkspaceTestFiles,
  loadFileGraphFragmentsFromDisk,
} from "./compiler-session.js"
import {
  resolveContainedRelPath,
  resolvePackageTag,
  resolveRepoRoot,
  sha256Hex,
} from "./extractor-types-and-helpers.js"
import { loadWorkspaceGovernanceDocsWithViolations } from "./governance-doc-parser.js"
import { buildGovAndPatternShaMaps } from "./file-graph-cache.js"
import {
  assembleTestAndGovernanceGraph,
  checkNodeSqliteTestViolations,
  checkUnassertedStateFieldsForInputs,
} from "./test-and-governance-extractor.js"

/**
 * Synchronous workspace type-aware HarnessGraph runner with disk snapshot caching.
 */
export const runExtractWorkspaceTypeAwareGraph = (
  repoRoot: string,
  hostIo: SyncHostIo,
  extractFromSource: (
    files: ReadonlyArray<SourceFileInput>,
    options?: TypeExtractorOptions,
  ) => HarnessGraph,
  options?: Omit<ExtractTypeGraphOptions, "repoRoot" | "hostIo">,
): HarnessGraph => {
  const root = resolveRepoRoot(repoRoot, hostIo)
  const session =
    options?.session ??
    (() => {
      const s = createTypeScriptProgramSession(root, hostIo)
      s.persistToDisk = true
      loadFileGraphFragmentsFromDisk(s.repoRoot, s, hostIo)
      return s
    })()
  if (options?.previousProgram !== undefined) session.oldProgram = options.previousProgram
  const overlays = new Map<string, string>()
  if (options?.overlays) {
    for (const [k, v] of Object.entries(options.overlays)) {
      const rel = resolveContainedRelPath(root, k, hostIo)
      if (rel !== null) overlays.set(rel, v)
    }
  }
  const relFileSet = new Set<string>(findWorkspaceSrcFiles(root, hostIo))
  const testFileSet = new Set<string>(findWorkspaceTestFiles(root, hostIo))
  for (const ov of overlays.keys()) {
    if (
      (ov.endsWith(".test.ts") || ov.endsWith(".spec.ts") || ov.includes("/test/")) &&
      !ov.endsWith(".d.ts")
    ) {
      testFileSet.add(ov)
      continue
    }
    if (
      (ov.endsWith(".ts") || ov.endsWith(".tsx")) &&
      !ov.endsWith(".d.ts") &&
      !ov.endsWith(".config.ts")
    ) {
      relFileSet.add(ov)
    }
  }
  const relFiles = Array.from(relFileSet).sort((a, b) => a.localeCompare(b))
  const testFiles = Array.from(testFileSet).sort((a, b) => a.localeCompare(b))
  const inputs: Array<SourceFileInput> = []
  const inputShaMap = new Map<string, string>()
  for (const rel of relFiles) {
    const content = overlays.get(rel) ?? hostIo.readTextSync(path.join(root, rel))
    inputs.push({ filePath: rel, content, packageTag: resolvePackageTag(root, rel, hostIo) })
    inputShaMap.set(rel, sha256Hex(content))
  }
  const testShaMap = new Map<string, string>()
  const testContentMap = new Map<string, string>()
  for (const rel of testFiles) {
    const content = overlays.get(rel) ?? hostIo.readTextSync(path.join(root, rel))
    testShaMap.set(rel, sha256Hex(content))
    testContentMap.set(rel, content)
  }
  const { docs: governanceDocs, violations: governanceStatusViolations } =
    loadWorkspaceGovernanceDocsWithViolations(root, hostIo)
  const patternDocs = loadPatternDocs(root, hostIo)
  const { govShaMap, patternShaMap } = buildGovAndPatternShaMaps(governanceDocs, patternDocs)
  for (const v of governanceStatusViolations) {
    govShaMap.set(v.file, sha256Hex(`invalid-gov-status:${v.enclosingSymbol}:${v.message}`))
  }
  const fastSnap = checkWorkspaceSnapshotMatch(
    session,
    testShaMap,
    govShaMap,
    patternShaMap,
    inputShaMap,
  )
  if (fastSnap !== null) return fastSnap
  const baseGraph = extractFromSource(inputs, {
    repoRoot: root,
    hostIo,
    patternDocs,
    session,
    ...(options?.overlays !== undefined ? { overlays: options.overlays } : {}),
    ...(options?.previousProgram !== undefined ? { previousProgram: options.previousProgram } : {}),
  })
  const topoSnap = checkTopologySnapshotMatch(
    session,
    baseGraph,
    inputShaMap,
    testShaMap,
    govShaMap,
    patternShaMap,
    inputs,
  )
  if (topoSnap !== null) return topoSnap
  const effectFns: Array<EffectFnNode> = []
  const serviceTags: Array<ServiceTagNode> = []
  const taggedErrors: Array<TaggedErrorNode> = []
  for (const [, node] of Graph.nodes(baseGraph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (n) => {
        effectFns.push(n)
      })
      .with({ _tag: "ServiceTag" }, (n) => {
        serviceTags.push(n)
      })
      .with({ _tag: "TaggedError" }, (n) => {
        taggedErrors.push(n)
      })
      .with(
        { _tag: "ServiceLayer" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  const updatedNodeIndexByKey = new Map<string, Graph.NodeIndex>(baseGraph.nodeIndexByKey)
  const testFilesWithContent = testFiles.map((rel) => ({
    filePath: rel,
    getContent: () => testContentMap.get(rel) ?? "",
  }))
  const unassertedStateViolations = checkUnassertedStateFieldsForInputs(
    inputs,
    testFilesWithContent,
  )
  const nodeSqliteTestViolations = checkNodeSqliteTestViolations(testFiles, testContentMap)
  const unresolvedReferences: Array<UnresolvedGraphReference> = []
  const augmentedGraph = Graph.mutate<HarnessNode, HarnessEdge>(baseGraph.graph, (mutable) => {
    assembleTestAndGovernanceGraph(
      mutable,
      testFiles,
      testContentMap,
      governanceDocs,
      effectFns,
      serviceTags,
      taggedErrors,
      inputs,
      updatedNodeIndexByKey,
      unresolvedReferences,
      root,
      hostIo,
    )
  })
  const resultGraph: HarnessGraph = {
    graph: augmentedGraph,
    nodeIndexByKey: updatedNodeIndexByKey,
    branchingViolations: [
      ...(baseGraph.branchingViolations ?? []),
      ...unassertedStateViolations,
      ...nodeSqliteTestViolations,
      ...governanceStatusViolations,
    ],
    unresolvedReferences: [...(baseGraph.unresolvedReferences ?? []), ...unresolvedReferences],
  }
  session.lastWorkspaceSnapshot = {
    inputShaMap,
    testShaMap,
    govShaMap,
    patternShaMap,
    baseTopologyHash: computeBaseTopologyHash(session),
    domainContractInputHash: sha256Hex(
      inputs
        .filter((i) => i.packageTag === "contract" || i.packageTag === "domain")
        .map((i) => `${i.filePath}:${inputShaMap.get(i.filePath) ?? ""}`)
        .join("|"),
    ),
    unassertedStateViolations,
    nodeSqliteTestViolations,
    governanceStatusViolations,
    graph: resultGraph,
  }
  return resultGraph
}
