import type { SyncHostIo } from "@harness/service"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { decideGraphInference } from "../datalog-engine.js"
import { buildHarnessGraph, verifySubgraphMonomorphism } from "../graph-engine.js"
import { applyDpoPatchToGraph } from "../graph-rewrite.js"
import {
  type GraphPatch,
  type HarnessGraph,
  type PlaysRoleEdge,
  getNodeKey,
} from "../model.js"
import {
  type SourceFileInput,
  type TypeScriptProgramSession,
  createTypeScriptProgramSession,
  evaluateOverlayDiagnostics,
  extractTypeAwareGraphFromSource,
  resolveContainedRelPath,
  resolvePackageTag,
} from "../type-extractor.js"
import { projectPatchesToInMemoryWorkspace } from "./ast-codemods.js"
import { GraphProjectorError } from "./skeleton-templates.js"

export interface BatchVerificationOutcome {
  readonly isClean: boolean
  readonly diagnostics: ReadonlyArray<string>
}

export const CODE_VERIFIABLE_ROLES = new Set<string>([
  "requires-service",
  "fails-with",
  "provided-service",
  "required-service",
])

export const verifyProjectedSubset = (
  repoRoot: string,
  baseGraph: HarnessGraph | undefined,
  fallbackTargetGraph: HarnessGraph,
  subsetPatches: ReadonlyArray<GraphPatch>,
  overlayMap: Readonly<Record<string, string>>,
  existingFiles?: Readonly<Record<string, string>>,
  forceFailRuleIds?: ReadonlySet<string>,
  session?: TypeScriptProgramSession,
  hostIo?: SyncHostIo,
): Effect.Effect<BatchVerificationOutcome, never, never> =>
  Effect.gen(function* () {
    if (subsetPatches.length === 0) {
      return { isClean: true, diagnostics: [] }
    }

    if (forceFailRuleIds !== undefined && forceFailRuleIds.size > 0) {
      const forced = subsetPatches.find((p) => forceFailRuleIds.has(p.ruleId))
      if (forced !== undefined) {
        return {
          isClean: false,
          diagnostics: [`Forced verification failure for rule '${forced.ruleId}'.`],
        }
      }
    }

    const combinedOverlays: Record<string, string> = {
      ...existingFiles,
      ...overlayMap,
    }

    const activeSession = session ?? createTypeScriptProgramSession(repoRoot, hostIo)
    const compilerDiagExit = yield* Effect.try({
      try: () => evaluateOverlayDiagnostics(repoRoot, combinedOverlays, activeSession, hostIo),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.exit)
    if (compilerDiagExit._tag === "Failure" && Cause.hasInterrupts(compilerDiagExit.cause)) {
      return yield* Effect.interrupt
    }
    const compilerDiags = match(compilerDiagExit)
      .with({ _tag: "Success" }, (s) => s.value)
      .with({ _tag: "Failure" }, () => [])
      .exhaustive()
    const compilerCrashDiags = match(compilerDiagExit)
      .with({ _tag: "Success" }, () => [])
      .with({ _tag: "Failure" }, (f) => [`Compiler overlay diagnostic evaluation failed: ${String(f.cause)}`])
      .exhaustive()
    const errorDiags = [
      ...compilerCrashDiags,
      ...compilerDiags
        .filter((d) => d.severity === "error")
        .map((d) => `${d.file}:${d.line}:${d.column} ${d.code}: ${d.message}`),
    ]

    const sourceInputs: Array<SourceFileInput> = []
    for (const [relFile, content] of Object.entries(combinedOverlays)) {
      const contained = resolveContainedRelPath(repoRoot, relFile, hostIo)
      if (contained === null) continue
      const norm = contained
      if (norm.includes("/test/") || norm.endsWith(".test.ts") || norm.endsWith(".spec.ts")) {
        continue
      }
      sourceInputs.push({
        filePath: norm,
        content,
        packageTag: resolvePackageTag(repoRoot, norm, hostIo),
      })
    }

    const extractExit = yield* Effect.try({
      try: () =>
        extractTypeAwareGraphFromSource(sourceInputs, {
          repoRoot,
          overlays: combinedOverlays,
          session: activeSession,
          ...(hostIo !== undefined ? { hostIo } : {}),
        }),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.exit)
    if (extractExit._tag === "Failure") {
      if (Cause.hasInterrupts(extractExit.cause)) {
        return yield* Effect.interrupt
      }
      return {
        isClean: false,
        diagnostics: [...errorDiags, `Overlay type-aware extraction failed: ${String(extractExit.cause)}`],
      }
    }
    const extractedOverlayGraph = extractExit.value

    const effectiveBase =
      baseGraph ??
      buildHarnessGraph({
        fns: [],
        services: [],
        layers: [],
        errors: [],
        schemas: [],
        tests: [],
        patternDocs: [],
      })
    let currentGraph = effectiveBase
    for (const patch of subsetPatches) {
      const stepped = yield* Effect.exit(applyDpoPatchToGraph(currentGraph, patch))
      if (stepped._tag === "Failure" && Cause.hasInterrupts(stepped.cause)) {
        return yield* Effect.interrupt
      }
      const replayError = match(stepped)
        .with({ _tag: "Success" }, (s) => {
          currentGraph = s.value
          return undefined
        })
        .with(
          { _tag: "Failure" },
          (f) => `DPO patch replay failed for rule '${patch.ruleId}': ${String(f.cause)}`,
        )
        .exhaustive()
      if (replayError !== undefined) {
        return {
          isClean: false,
          diagnostics: [...errorDiags, replayError],
        }
      }
    }
    const expectedGraph: HarnessGraph = currentGraph

    const requiredEntityKeys = new Set<string>()
    const requiredRelationIds = new Set<string>()
    const requiredRoleEdges: Array<PlaysRoleEdge> = []

    for (const p of subsetPatches) {
      for (const ent of p.insertedEntityNodes) {
        match(ent)
          .with(
            { _tag: "SchemaDef" },
            { _tag: "TaggedError" },
            { _tag: "ServiceTag" },
            { _tag: "EffectFn" },
            { _tag: "ServiceLayer" },
            (n) => {
              requiredEntityKeys.add(getNodeKey(n))
            },
          )
          .with(
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            () => undefined,
          )
          .exhaustive()
      }
      for (const delKey of p.deletedEntityKeys) {
        requiredEntityKeys.delete(delKey)
      }
      for (const edge of p.insertedRoleEdges) {
        if (!CODE_VERIFIABLE_ROLES.has(edge.role)) {
          continue
        }
        requiredRelationIds.add(edge.relationId)
        requiredRoleEdges.push(edge)
      }
    }

    const mono = verifySubgraphMonomorphism(extractedOverlayGraph, expectedGraph, {
      requiredEntityKeys,
      requiredRelationIds,
      requiredRoleEdges,
    })

    const infExit = yield* Effect.exit(decideGraphInference(extractedOverlayGraph))
    if (infExit._tag === "Failure" && Cause.hasInterrupts(infExit.cause)) {
      return yield* Effect.interrupt
    }
    const infDiag = match(infExit)
      .with({ _tag: "Failure" }, (f) => [
        `Datalog verification failed on projected overlay: ${String(f.cause)}`,
      ])
      .with({ _tag: "Success" }, () => [])
      .exhaustive()

    const monoDiags: Array<string> = [
      ...mono.missingEntities.map((e) => `Missing projected entity in round-trip graph: ${e}`),
      ...mono.missingRelations.map((r) => `Missing projected relation in round-trip graph: ${r}`),
      ...mono.missingRoleEdges.map(
        (edge) =>
          `Missing projected role edge in round-trip graph: ${edge.relationId} --[${edge.role}]--> ${edge.entityKey}`,
      ),
    ]

    const allDiagnostics = [...errorDiags, ...monoDiags, ...infDiag]
    return {
      isClean: allDiagnostics.length === 0,
      diagnostics: allDiagnostics,
    }
  })

export const safeProjectPatchesToInMemoryWorkspace = (
  repoRoot: string,
  targetGraph: HarnessGraph,
  patches: ReadonlyArray<GraphPatch>,
  initialGraph?: HarnessGraph,
  existingFiles?: Readonly<Record<string, string>>,
  hostIo?: SyncHostIo,
): Effect.Effect<
  ReturnType<typeof projectPatchesToInMemoryWorkspace>,
  GraphProjectorError,
  never
> =>
  Effect.gen(function* () {
    const projected = yield* Effect.try({
      try: () =>
        projectPatchesToInMemoryWorkspace(
          repoRoot,
          targetGraph,
          patches,
          initialGraph,
          existingFiles,
          hostIo,
        ),
      catch: (err) =>
        err instanceof GraphProjectorError
          ? err
          : new GraphProjectorError({
              reason: "ast-parse-error",
              message: err instanceof Error ? err.message : String(err),
            }),
    })
    if (projected.pendingError !== undefined) {
      return yield* projected.pendingError
    }
    return projected
  })

export const isolateFirstOffendingPatchIndex = (
  repoRoot: string,
  baseGraph: HarnessGraph | undefined,
  targetGraph: HarnessGraph,
  prefixPatches: ReadonlyArray<GraphPatch>,
  phasePatches: ReadonlyArray<GraphPatch>,
  existingFiles?: Readonly<Record<string, string>>,
  forceFailRuleIds?: ReadonlySet<string>,
  session?: TypeScriptProgramSession,
  hostIo?: SyncHostIo,
): Effect.Effect<
  { readonly offendingIndex: number; readonly probes: number },
  GraphProjectorError,
  never
> =>
  Effect.gen(function* () {
    const activeSession = session ?? createTypeScriptProgramSession(repoRoot, hostIo)
    let low = 0
    let high = phasePatches.length - 1
    let probes = 0

    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      probes += 1
      const candidateSlice = [...prefixPatches, ...phasePatches.slice(0, mid + 1)]
      const projected = yield* safeProjectPatchesToInMemoryWorkspace(
        repoRoot,
        targetGraph,
        candidateSlice,
        baseGraph,
        existingFiles,
        hostIo,
      )
      const check = yield* verifyProjectedSubset(
        repoRoot,
        baseGraph,
        targetGraph,
        candidateSlice,
        projected.overlayMap,
        existingFiles,
        forceFailRuleIds,
        activeSession,
        hostIo,
      )
      if (!check.isClean) {
        high = mid
      } else {
        low = mid + 1
      }
    }

    return { offendingIndex: low, probes }
  })
