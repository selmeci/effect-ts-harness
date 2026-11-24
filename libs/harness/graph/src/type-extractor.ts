import { type ErrorReasonMessage, toErrorReasonMessage } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { Effect } from "effect"
import { type HarnessGraph } from "./model.js"
import {
  type ExtractTypeGraphOptions,
  type SourceFileInput,
  type TypeExtractorOptions,
} from "./extractor/compiler-session.js"
import { runExtractTypeAwareGraphFromSource } from "./extractor/source-graph-runner.js"
import { runExtractWorkspaceTypeAwareGraph } from "./extractor/workspace-graph-runner.js"

export {
  computeDynamicPaths,
  resolveContainedRelPath,
  resolveImportSpecToRelFile,
  resolvePackageTag,
  resolveRepoRoot,
  stripCommentsAndTestTitles,
  type TaggedSchemaInfo,
} from "./extractor/extractor-types-and-helpers.js"
export {
  ts,
  createTypeScriptProgramSession,
  evaluateOverlayDiagnostics,
  emitDeclarationSignatureText,
  computeDeclHash,
  computeBaseTopologyHash,
  findWorkspaceSrcFiles,
  findWorkspaceTestFiles,
  type SourceFileInput,
  type TypeScriptProgramSession,
  type TypeExtractorOptions,
  type ExtractTypeGraphOptions,
  type OverlayDiagnosticItem,
  type FileGraphFragment,
} from "./extractor/compiler-session.js"
export {
  loadWorkspaceGovernanceDocs,
  loadWorkspaceGovernanceDocsWithViolations,
  parseGovernanceDocFile,
  parseGovernanceDocFileChecked,
  type ParseGovernanceDocFileResult,
} from "./extractor/governance-doc-parser.js"
export { extractLayers, extractServicesAndErrors } from "./extractor/service-and-layer-extractor.js"
export { extractEffectFns } from "./extractor/effect-fn-extractor.js"

/**
 * Extracts a type-aware HarnessGraph from source files, analyzing Effect.fn and Layer definitions.
 */
export const extractTypeAwareGraphFromSource = (
  files: ReadonlyArray<SourceFileInput>,
  options?: TypeExtractorOptions,
): HarnessGraph => runExtractTypeAwareGraphFromSource(files, options)

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
export const extractTypeGraph = Effect.fn("TypeExtractor.extractWorkspace")(function* (
  options: ExtractTypeGraphOptions,
): Effect.fn.Return<HarnessGraph> {
  return yield* extractWorkspaceTypeAwareGraph(options.repoRoot, options.hostIo, options)
})
