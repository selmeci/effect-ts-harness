import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { Project, ts } from "ts-morph"
import { match } from "ts-pattern"
import { buildHarnessGraph } from "./graph-engine.js"
import {
  type BranchingViolation, type EffectFnNode, type HarnessEdge, type HarnessGraph,
  type HarnessNode, type SchemaDefNode, type ServiceLayerNode, type ServiceTagNode,
  type TaggedErrorNode, type UnresolvedGraphReference,
} from "./model.js"
import { loadPatternDocs } from "./pattern-index.js"
import {
  type TaggedSchemaInfo, computeDynamicPaths, resolveContainedRelPath, resolveImportSpecToRelFile,
  resolvePackageTag, resolveRepoRoot, sha256Hex,
} from "./extractor/extractor-types-and-helpers.js"
import {
  type ExtractTypeGraphOptions, type SourceFileInput, type TypeExtractorOptions,
  checkTopologySnapshotMatch, checkWorkspaceSnapshotMatch, computeBaseTopologyHash, findWorkspaceSrcFiles,
  findWorkspaceTestFiles, getOrCreateWarmProgramSession,
} from "./extractor/compiler-session.js"
import { checkPass0ZeroToleranceAst, runAstPolicyChecks } from "./extractor/ast-policy-extractor.js"
import { checkBrandedDomainTypesAndPrimitiveBoundaries, checkSchemaBooleanStateAndBrandedFields, extractSchemaDefinitions } from "./extractor/schema-and-brand-extractor.js"
import {
  autoRegisterReferencedEntities, commitSessionFragments, extractLayers,
  extractServicesAndErrors, syncSessionCacheAndProject,
} from "./extractor/service-and-layer-extractor.js"
import { extractEffectFns } from "./extractor/effect-fn-extractor.js"
import { checkDeciderTracing, checkEventSourcingReducers, checkMissingAggregateIdGuard } from "./extractor/decider-reducer-extractor.js"
import {
  assembleTestAndGovernanceGraph, checkNodeSqliteTestViolations,
  checkUnassertedStateFieldsForInputs, loadWorkspaceGovernanceDocs,
} from "./extractor/test-and-governance-extractor.js"

export * from "./extractor/extractor-types-and-helpers.js"
export * from "./extractor/compiler-session.js"
export * from "./extractor/ast-policy-extractor.js"
export * from "./extractor/schema-and-brand-extractor.js"
export * from "./extractor/service-and-layer-extractor.js"
export * from "./extractor/effect-fn-extractor.js"
export * from "./extractor/decider-reducer-extractor.js"
export * from "./extractor/test-and-governance-extractor.js"

export const extractTypeAwareGraphFromSource = (
  files: ReadonlyArray<SourceFileInput>,
  options?: TypeExtractorOptions,
): HarnessGraph => {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot(process.cwd()), workspaceRoot = fs.existsSync(path.join(repoRoot, "libs/harness/graph/node_modules")) ? repoRoot : resolveRepoRoot(import.meta.dirname)
  const dynamicPaths = computeDynamicPaths(repoRoot, workspaceRoot), normalizedOverlays = new Map<string, string>()
  if (options?.overlays) for (const [k, v] of Object.entries(options.overlays)) {
    const rel = resolveContainedRelPath(repoRoot, k)
    if (rel !== null) normalizedOverlays.set(rel, v)
  }

  const effectiveFiles: Array<SourceFileInput> = files.map((f) => {
    const rel = (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/"), ov = normalizedOverlays.get(rel) ?? normalizedOverlays.get(f.filePath)
    return ov !== undefined ? { ...f, content: ov } : f
  })
  for (const [rel, ov] of normalizedOverlays) if (!effectiveFiles.some((f) => (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/") === rel)) effectiveFiles.push({ filePath: rel, content: ov, packageTag: resolvePackageTag(repoRoot, rel) })
  for (const f of effectiveFiles) {
    const rel = (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/"), m = rel.match(/^libs\/([^/]+)\/(contract|service|domain|core|infra)\/src\/index\.ts$/)
    if (m?.[1] && m[2]) { const abs = path.resolve(repoRoot, rel); dynamicPaths[`@harness/${m[1]}-${m[2]}`] = [abs]; dynamicPaths[`@effect-${m[1]}/${m[2]}`] = [abs]; dynamicPaths[`@${m[1]}/${m[2]}`] = [abs] }
  }

  const session = options?.session
  const project = session?.project ?? new Project({ compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, esModuleInterop: true, skipLibCheck: true, baseUrl: repoRoot, paths: dynamicPaths } })
  if (session !== undefined) session.project = project

  const fileMap = new Map<string, SourceFileInput>(), currentShas = new Map<string, string>(), currentDeclHashes = new Map<string, string>(), currentSpecs = new Map<string, ReadonlyArray<string>>()
  const filesToReextract = new Set<string>(), declChangedFiles = new Set<string>()

  for (const f of effectiveFiles) fileMap.set((path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/"), f)
  syncSessionCacheAndProject(session, project, repoRoot, fileMap, currentShas, currentDeclHashes, currentSpecs, filesToReextract, declChangedFiles, dynamicPaths)

  const sortedSourceFiles = [...project.getSourceFiles()].sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()))
  const fns: Array<EffectFnNode> = [], services: Array<ServiceTagNode> = [], layers: Array<ServiceLayerNode> = [], errors: Array<TaggedErrorNode> = [], schemas: Array<SchemaDefNode> = []
  const requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }> = [], failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }> = []
  const providesService: Array<{ readonly layerQualname: string; readonly tagId: string }> = [], layerRequires: Array<{ readonly layerQualname: string; readonly tagId: string }> = []
  const branchingViolations: Array<BranchingViolation> = [], classNameToTagId = new Map<string, string>(), serviceMethodErrors = new Map<string, Map<string, Array<string>>>()
  const referencedServices = new Set<string>(), referencedErrors = new Set<string>()
  const taggedSchemasByTag = new Map<string, TaggedSchemaInfo>(), taggedSchemasByName = new Map<string, TaggedSchemaInfo>(), unionSchemaTagsByName = new Map<string, ReadonlyArray<string>>()

  const pass1ScopeFiles = new Set<string>(filesToReextract)
  if (session !== undefined && filesToReextract.size > 0) {
    for (const frag of session.fileFragmentCache.values()) for (const s of frag.services ?? []) { classNameToTagId.set(s.name, s.tagId); classNameToTagId.set(s.tagId, s.tagId) }
    for (const rel of filesToReextract) {
      const m = rel.match(/^libs\/([^/]+)\//)
      if (m?.[1] && m[1] !== "harness") for (const k of fileMap.keys()) if (k.startsWith(`libs/${m[1]}/`)) pass1ScopeFiles.add(k)
    }
    const q = Array.from(pass1ScopeFiles)
    while (q.length > 0) {
      const curr = q.shift()!
      for (const spec of currentSpecs.get(curr) ?? []) {
        const target = resolveImportSpecToRelFile(curr, spec, repoRoot, fileMap, dynamicPaths)
        if (target !== null && !pass1ScopeFiles.has(target)) { pass1ScopeFiles.add(target); q.push(target) }
      }
    }
  }

  for (const sf of sortedSourceFiles) {
    const rel = path.relative(repoRoot, sf.getFilePath()).replace(/\\/g, "/"), f = fileMap.get(rel)
    if (f && (session === undefined || filesToReextract.has(rel))) checkPass0ZeroToleranceAst(sf, f, branchingViolations)
    if (fileMap.has(rel) && (session === undefined || pass1ScopeFiles.has(rel))) {
      const tag = fileMap.get(rel)?.packageTag ?? resolvePackageTag(repoRoot, rel)
      extractServicesAndErrors(sf, rel, tag, services, errors, classNameToTagId, serviceMethodErrors)
      extractSchemaDefinitions(sf, rel, tag, schemas, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)
    }
  }

  for (const sf of sortedSourceFiles) {
    if (session !== undefined && filesToReextract.size === 0) break
    const rel = path.relative(repoRoot, sf.getFilePath()).replace(/\\/g, "/")
    if (!fileMap.has(rel) || (session !== undefined && !filesToReextract.has(rel))) continue
    const tag = fileMap.get(rel)?.packageTag ?? resolvePackageTag(repoRoot, rel)
    extractEffectFns(sf, rel, tag, fns, failsWith, requiresService, classNameToTagId, serviceMethodErrors, referencedErrors, referencedServices, services, errors)
    extractLayers(sf, rel, tag, layers, providesService, layerRequires, classNameToTagId, referencedServices)
    if (!rel.startsWith("libs/harness/") && !rel.startsWith("apps/harness-")) {
      runAstPolicyChecks(sf, rel, tag, branchingViolations)
      checkSchemaBooleanStateAndBrandedFields(sf, rel, tag, branchingViolations)
      checkBrandedDomainTypesAndPrimitiveBoundaries(sf, rel, tag, branchingViolations)
      checkDeciderTracing(sf, rel, tag, branchingViolations)
      checkMissingAggregateIdGuard(sf, rel, tag, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName, branchingViolations)
      checkEventSourcingReducers(sf, rel, tag, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName, branchingViolations)
    }
  }

  if (session !== undefined) {
    commitSessionFragments(session, filesToReextract, fileMap, currentShas, currentDeclHashes, currentSpecs, repoRoot, {
      fns, services, layers, errors, schemas, requiresService, failsWith, providesService, layerRequires, branchingViolations, referencedServices, referencedErrors, classNameToTagId,
    }, options?.overlays !== undefined && Object.keys(options.overlays).length > 0)
  }

  autoRegisterReferencedEntities(services, errors, referencedServices, referencedErrors, classNameToTagId)
  const inMemoryTests = effectiveFiles.filter((f) => f.filePath.includes(".test.ts"))
  if (inMemoryTests.length > 0) {
    branchingViolations.push(...checkUnassertedStateFieldsForInputs(
      effectiveFiles.filter((f) => !f.filePath.includes(".test.ts")),
      inMemoryTests.map((t) => ({ filePath: t.filePath, getContent: () => t.content })),
    ))
  }

  return {
    ...buildHarnessGraph({
      fns, services, layers, errors, schemas, tests: [], patternDocs: options?.patternDocs ?? [],
      requiresService, failsWith, providesService, layerRequires, tracedCalls: [], exercisesSpans: [], branchingViolations,
    }),
    unresolvedReferences: [],
  }
}

export const extractWorkspaceTypeAwareGraph = (
  repoRoot: string,
  options?: Omit<ExtractTypeGraphOptions, "repoRoot">,
): Effect.Effect<HarnessGraph> =>
  Effect.sync(() => {
    const root = resolveRepoRoot(repoRoot), session = options?.session ?? getOrCreateWarmProgramSession(root)
    if (options?.previousProgram !== undefined) session.oldProgram = options.previousProgram

    const overlays = new Map<string, string>()
    if (options?.overlays) for (const [k, v] of Object.entries(options.overlays)) {
      const rel = resolveContainedRelPath(root, k)
      if (rel !== null) overlays.set(rel, v)
    }

    const relFileSet = new Set<string>(findWorkspaceSrcFiles(root)), testFileSet = new Set<string>(findWorkspaceTestFiles(root))
    for (const ov of overlays.keys()) {
      if ((ov.endsWith(".test.ts") || ov.endsWith(".spec.ts") || ov.includes("/test/")) && !ov.endsWith(".d.ts")) testFileSet.add(ov)
      else if ((ov.endsWith(".ts") || ov.endsWith(".tsx")) && !ov.endsWith(".d.ts") && !ov.endsWith(".config.ts")) relFileSet.add(ov)
    }

    const relFiles = Array.from(relFileSet).sort((a, b) => a.localeCompare(b)), testFiles = Array.from(testFileSet).sort((a, b) => a.localeCompare(b))
    const inputs: Array<SourceFileInput> = [], inputShaMap = new Map<string, string>()
    for (const rel of relFiles) {
      const content = overlays.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf-8")
      inputs.push({ filePath: rel, content, packageTag: resolvePackageTag(root, rel) }); inputShaMap.set(rel, sha256Hex(content))
    }

    const testShaMap = new Map<string, string>(), testContentMap = new Map<string, string>()
    for (const rel of testFiles) {
      const content = overlays.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf-8")
      testShaMap.set(rel, sha256Hex(content)); testContentMap.set(rel, content)
    }

    const governanceDocs = loadWorkspaceGovernanceDocs(root), govShaMap = new Map<string, string>()
    for (const d of governanceDocs) govShaMap.set(d.path, sha256Hex(`${d.id}:${d.title}:${d.status}:${(d.referencedSpans ?? []).join(",")}:${(d.referencedServices ?? []).join(",")}:${(d.referencedErrors ?? []).join(",")}`))

    const patternDocs = loadPatternDocs(root), patternShaMap = new Map<string, string>()
    for (const p of patternDocs) patternShaMap.set(p.path, sha256Hex(`${p.slug}:${p.summary}:${(p.coveredSpans ?? []).join(",")}:${(p.coveredTags ?? []).join(",")}`))

    const fastSnap = checkWorkspaceSnapshotMatch(session, testShaMap, govShaMap, patternShaMap, inputShaMap)
    if (fastSnap !== null) return fastSnap

    const baseGraph = extractTypeAwareGraphFromSource(inputs, {
      repoRoot: root, patternDocs, session,
      ...(options?.overlays !== undefined ? { overlays: options.overlays } : {}),
      ...(options?.previousProgram !== undefined ? { previousProgram: options.previousProgram } : {}),
    })

    const topoSnap = checkTopologySnapshotMatch(session, baseGraph, inputShaMap, testShaMap, govShaMap, patternShaMap, inputs)
    if (topoSnap !== null) return topoSnap

    const effectFns: Array<EffectFnNode> = [], serviceTags: Array<ServiceTagNode> = [], taggedErrors: Array<TaggedErrorNode> = []
    for (const [, node] of Graph.nodes(baseGraph.graph)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => { effectFns.push(n) })
        .with({ _tag: "ServiceTag" }, (n) => { serviceTags.push(n) })
        .with({ _tag: "TaggedError" }, (n) => { taggedErrors.push(n) })
        .with(
          { _tag: "ServiceLayer" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" },
          { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
          { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
          () => undefined,
        )
        .exhaustive()
    }

    const updatedNodeIndexByKey = new Map<string, Graph.NodeIndex>(baseGraph.nodeIndexByKey)
    const testFilesWithContent = testFiles.map((rel) => ({ filePath: rel, getContent: () => testContentMap.get(rel) ?? "" }))
    const unassertedStateViolations = checkUnassertedStateFieldsForInputs(inputs, testFilesWithContent)
    const nodeSqliteTestViolations = checkNodeSqliteTestViolations(testFiles, testContentMap)
    const unresolvedReferences: Array<UnresolvedGraphReference> = []

    const augmentedGraph = Graph.mutate<HarnessNode, HarnessEdge>(baseGraph.graph, (mutable) => {
      assembleTestAndGovernanceGraph(mutable, testFiles, testContentMap, governanceDocs, effectFns, serviceTags, taggedErrors, inputs, updatedNodeIndexByKey, unresolvedReferences, root)
    })

    const resultGraph: HarnessGraph = {
      graph: augmentedGraph, nodeIndexByKey: updatedNodeIndexByKey,
      branchingViolations: [...(baseGraph.branchingViolations ?? []), ...unassertedStateViolations, ...nodeSqliteTestViolations],
      unresolvedReferences: [...(baseGraph.unresolvedReferences ?? []), ...unresolvedReferences],
    }

    session.lastWorkspaceSnapshot = {
      inputShaMap, testShaMap, govShaMap, patternShaMap,
      baseTopologyHash: computeBaseTopologyHash(session),
      domainContractInputHash: sha256Hex(inputs.filter((i) => i.packageTag === "contract" || i.packageTag === "domain").map((i) => `${i.filePath}:${inputShaMap.get(i.filePath) ?? ""}`).join("|")),
      unassertedStateViolations, nodeSqliteTestViolations, graph: resultGraph,
    }
    return resultGraph
  })

export const extractTypeGraph = Effect.fn("TypeExtractor.extractWorkspace")(function* (
  options: ExtractTypeGraphOptions,
): Effect.fn.Return<HarnessGraph> {
  return yield* extractWorkspaceTypeAwareGraph(options.repoRoot, options)
})
