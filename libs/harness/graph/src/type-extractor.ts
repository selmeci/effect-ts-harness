import * as path from "node:path"
import { type ErrorReasonMessage, toErrorReasonMessage } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { Effect } from "effect"
import { Project, ts } from "ts-morph"
import { buildHarnessGraph } from "./graph-engine.js"
import {
  type BranchingViolation, type EffectFnNode, type HarnessGraph,
  type SchemaDefNode, type ServiceLayerNode, type ServiceTagNode, type TaggedErrorNode,
} from "./model.js"
import {
  type TaggedSchemaInfo, computeDynamicPaths, resolveContainedRelPath,
  resolveImportSpecToRelFile, resolvePackageTag, resolveRepoRoot,
} from "./extractor/extractor-types-and-helpers.js"
import {
  type ExtractTypeGraphOptions, type SourceFileInput, type TypeExtractorOptions,
} from "./extractor/compiler-session.js"
import { checkPass0ZeroToleranceAst, runAstPolicyChecks } from "./extractor/ast-policy-extractor.js"
import { checkBrandedDomainTypesAndPrimitiveBoundaries, checkSchemaBooleanStateAndBrandedFields, extractSchemaDefinitions } from "./extractor/schema-and-brand-extractor.js"
import { autoRegisterReferencedEntities, commitSessionFragments, extractLayers, extractServicesAndErrors, syncSessionCacheAndProject } from "./extractor/service-and-layer-extractor.js"
import { extractEffectFns } from "./extractor/effect-fn-extractor.js"
import { checkDeciderTracing, checkEventSourcingReducers, checkMissingAggregateIdGuard } from "./extractor/decider-reducer-extractor.js"
import { checkUnassertedStateFieldsForInputs } from "./extractor/test-and-governance-extractor.js"
import { runExtractWorkspaceTypeAwareGraph } from "./extractor/workspace-graph-runner.js"

export {
  computeDynamicPaths, resolveContainedRelPath, resolveImportSpecToRelFile,
  resolvePackageTag, resolveRepoRoot, stripCommentsAndTestTitles, type TaggedSchemaInfo,
} from "./extractor/extractor-types-and-helpers.js"
export {
  ts, createTypeScriptProgramSession,
  evaluateOverlayDiagnostics, emitDeclarationSignatureText,
  computeDeclHash, computeBaseTopologyHash, findWorkspaceSrcFiles, findWorkspaceTestFiles,
  type SourceFileInput, type TypeScriptProgramSession, type TypeExtractorOptions,
  type ExtractTypeGraphOptions, type OverlayDiagnosticItem, type FileGraphFragment,
} from "./extractor/compiler-session.js"
export { loadWorkspaceGovernanceDocs, loadWorkspaceGovernanceDocsWithViolations, parseGovernanceDocFile, parseGovernanceDocFileChecked, type ParseGovernanceDocFileResult } from "./extractor/governance-doc-parser.js"
export { extractLayers, extractServicesAndErrors } from "./extractor/service-and-layer-extractor.js"
export { extractEffectFns } from "./extractor/effect-fn-extractor.js"

/**
 * Extracts a type-aware HarnessGraph from source files, analyzing Effect.fn and Layer definitions.
 */
export const extractTypeAwareGraphFromSource = (
  files: ReadonlyArray<SourceFileInput>,
  options?: TypeExtractorOptions,
): HarnessGraph => {
  const hostIo = options?.hostIo ?? options?.session?.hostIo
  const repoRoot = options?.repoRoot ?? resolveRepoRoot(process.cwd(), hostIo)
  const workspaceRoot = hostIo !== undefined && hostIo.existsSync(path.join(repoRoot, "libs/harness/graph/node_modules")) ? repoRoot : resolveRepoRoot(import.meta.dirname, hostIo)
  const dynamicPaths = computeDynamicPaths(repoRoot, workspaceRoot, hostIo), normalizedOverlays = new Map<string, string>()
  if (options?.overlays) for (const [k, v] of Object.entries(options.overlays)) {
    const rel = resolveContainedRelPath(repoRoot, k, hostIo)
    if (rel !== null) normalizedOverlays.set(rel, v)
  }

  const effectiveFiles: Array<SourceFileInput> = files.map((f) => {
    const rel = (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/"), ov = normalizedOverlays.get(rel) ?? normalizedOverlays.get(f.filePath)
    return ov !== undefined ? { ...f, content: ov } : f
  })
  for (const [rel, ov] of normalizedOverlays) if (!effectiveFiles.some((f) => (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/") === rel)) effectiveFiles.push({ filePath: rel, content: ov, packageTag: resolvePackageTag(repoRoot, rel, hostIo) })
  for (const f of effectiveFiles) {
    const rel = (path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath).replace(/\\/g, "/"), m = rel.match(/^libs\/([^/]+)\/(contract|service|domain|core|infra)\/src\/index\.ts$/)
    if (m?.[1] && m[2]) { const abs = path.resolve(repoRoot, rel); dynamicPaths[`@harness/${m[1]}-${m[2]}`] = [abs]; dynamicPaths[`@effect-${m[1]}/${m[2]}`] = [abs]; dynamicPaths[`@${m[1]}/${m[2]}`] = [abs] }
  }

  const session = options?.session
  const project = session?.project ?? new Project({ compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, esModuleInterop: true, skipLibCheck: true, baseUrl: repoRoot, paths: dynamicPaths } })
  if (session !== undefined) { session.project = project; if (JSON.stringify(project.compilerOptions.get().paths ?? {}) !== JSON.stringify(dynamicPaths)) project.compilerOptions.set({ paths: dynamicPaths }) }

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
      const tag = fileMap.get(rel)?.packageTag ?? resolvePackageTag(repoRoot, rel, hostIo)
      extractServicesAndErrors(sf, rel, tag, services, errors, classNameToTagId, serviceMethodErrors)
      extractSchemaDefinitions(sf, rel, tag, schemas, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)
    }
  }

  for (const sf of sortedSourceFiles) {
    if (session !== undefined && filesToReextract.size === 0) break
    const rel = path.relative(repoRoot, sf.getFilePath()).replace(/\\/g, "/")
    if (!fileMap.has(rel) || (session !== undefined && !filesToReextract.has(rel))) continue
    const tag = fileMap.get(rel)?.packageTag ?? resolvePackageTag(repoRoot, rel, hostIo)
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
  const isInMemoryTestFile = (filePath: string): boolean =>
    filePath.includes(".test.ts") || filePath.endsWith(".spec.ts") || filePath.endsWith(".spec.tsx")
  const inMemoryTests = effectiveFiles.filter((f) => isInMemoryTestFile(f.filePath))
  if (inMemoryTests.length > 0) {
    branchingViolations.push(...checkUnassertedStateFieldsForInputs(
      effectiveFiles.filter((f) => !isInMemoryTestFile(f.filePath)),
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

/**
 * Extracts a workspace-wide type-aware HarnessGraph with disk snapshot caching.
 */
export const extractWorkspaceTypeAwareGraph = Effect.fnUntraced(function* (
  repoRoot: string,
  hostIo: SyncHostIo,
  options?: Omit<ExtractTypeGraphOptions, "repoRoot" | "hostIo">,
): Effect.fn.Return<HarnessGraph> {
  return yield* Effect.sync(() =>
    runExtractWorkspaceTypeAwareGraph(repoRoot, hostIo, extractTypeAwareGraphFromSource, options),
  )
})

/**
 * Checked workspace extraction mapping synchronous FS/TS compiler errors into `ErrorReasonMessage`.
 */
export const extractTypeGraphChecked = (
  options: ExtractTypeGraphOptions,
): Effect.Effect<HarnessGraph, ErrorReasonMessage> =>
  Effect.try({
    try: () =>
      runExtractWorkspaceTypeAwareGraph(
        options.repoRoot,
        options.hostIo,
        extractTypeAwareGraphFromSource,
        options,
      ),
    catch: (err) => toErrorReasonMessage(err, "TypeGraph.extract failed with an unexpected error."),
  })

/**
 * TypeExtractor.extractWorkspace effectful entrypoint.
 */
export const extractTypeGraph = Effect.fn("TypeExtractor.extractWorkspace")(
  function* (options: ExtractTypeGraphOptions): Effect.fn.Return<HarnessGraph> {
    return yield* extractWorkspaceTypeAwareGraph(options.repoRoot, options.hostIo, options)
  })
