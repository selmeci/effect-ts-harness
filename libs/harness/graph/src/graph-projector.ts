import { Effect } from "effect"
import {
  type GraphPatch,
  type RewritePhase,
  type RewriteRuleId,
} from "./model.js"
import {
  isolateFirstOffendingPatchIndex,
  safeProjectPatchesToInMemoryWorkspace,
  verifyProjectedSubset,
} from "./projector/shadow-bisection-verifier.js"
import {
  AstProjectionResult,
  BisectionProbeCount,
  type GraphProjectorInput,
  GraphProjectorError,
  VerificationStatus,
  validateRelPath,
} from "./projector/skeleton-templates.js"
import { createTypeScriptProgramSession, resolveRepoRoot } from "./type-extractor.js"

export {
  AstProjectionResult,
  BisectionProbeCount,
  VerificationStatus,
  GraphProjectorError,
  validateRelPath,
  type GraphProjectorInput,
  AstCodeModOperation,
  ShadowFileOverlay,
} from "./projector/skeleton-templates.js"

export {
  projectPatchesToInMemoryWorkspace,
  applyRep05UntracedDeciderRepair,
  applyRep07DiscriminantMatchRepair,
  applyRep08DecodeBoundaryRepair,
  applyRep11DeleteUnusedService,
  coProjectBarrelExports,
} from "./projector/ast-codemods.js"

export {
  safeProjectPatchesToInMemoryWorkspace,
  verifyProjectedSubset,
  isolateFirstOffendingPatchIndex,
  type BatchVerificationOutcome,
} from "./projector/shadow-bisection-verifier.js"

/**
 * In-Memory Bidirectional AST Code Projector (`RFC-0004 §4.3–4.4, §5.1–5.2, §8`).
 *
 * Maps Double-Pushout `GraphPatch` deltas (`PLAN-01..04`, `REP-01..11`) into in-memory
 * TypeScript overlays (`ShadowFileOverlay`) via `ts-morph` (`{ useInMemoryFileSystem: true }`)
 * and `@ast-grep/napi`, co-projecting Nx package barrel files (`src/index.ts`), preserving
 * existing function and `Layer` implementations during repairs, and verifying the
 * Stratum-Boundary Batch Shadow LSP Round-Trip Commutativity Law
 * $\alpha_{\Delta}(W_{\text{disk}} \oplus \Delta W_{\text{RAM}}^{(k)}) \cong H$ with $O(\log k)$
 * binary-search fault isolation and explicit `VerificationStatus` (`Verified | Partial | Unverified`).
 *
 * Never writes to disk (disk persistence is gated in CLI commands by `VerificationStatus === "Verified"`
 * and `classifyFileWrite` `"allow"` verdicts).
 *
 * Enforces: harness:ADR-0009, harness:SPEC-0008
 */
export const decideGraphProjection = Effect.fn("GraphProjector.decide")(function* (
  input: GraphProjectorInput,
): Effect.fn.Return<AstProjectionResult, GraphProjectorError, never> {
  const repoRoot = resolveRepoRoot(
    input.workspaceRoot !== undefined ? String(input.workspaceRoot) : process.cwd(),
  )

  const allPatches: Array<GraphPatch> =
    input.patches.length > 0
      ? [...input.patches]
      : (input.appliedRewrites ?? []).flatMap((c) => c.patches)

  for (const patch of allPatches) {
    if (String(patch.ruleId).trim().length === 0) {
      return yield* new GraphProjectorError({
        reason: "Invalid GraphPatch with empty ruleId.",
      })
    }
    for (const ent of patch.insertedEntityNodes) {
      if ("file" in ent) {
        const validated = validateRelPath(repoRoot, String(ent.file), patch.ruleId)
        if (!validated.ok) {
          return yield* validated.error
        }
      }
    }
  }

  const shouldVerifyRoundTrip = input.verifyRoundTrip !== false

  if (allPatches.length === 0) {
    const emptyStatus = shouldVerifyRoundTrip
      ? VerificationStatus.make("Verified")
      : VerificationStatus.make("Unverified")
    return {
      operations: [],
      overlays: [],
      verificationStatus: emptyStatus,
      roundTripVerified: shouldVerifyRoundTrip,
      compilerDiagnostics: [],
      bisectionProbes: BisectionProbeCount.make(0),
      skippedRuleIds: [],
    }
  }

  const forceFailSet =
    input.forceFailRuleIds !== undefined
      ? new Set(input.forceFailRuleIds.map(String))
      : undefined

  if (!shouldVerifyRoundTrip) {
    const projected = yield* safeProjectPatchesToInMemoryWorkspace(
      repoRoot,
      input.targetGraph,
      allPatches,
      input.initialGraph,
      input.existingFiles,
    )
    return {
      operations: [...projected.operations],
      overlays: [...projected.overlays],
      verificationStatus: VerificationStatus.make("Unverified"),
      roundTripVerified: false,
      compilerDiagnostics: [],
      bisectionProbes: BisectionProbeCount.make(0),
      skippedRuleIds: [],
    }
  }

  // Group patches by RewritePhase in canonical order (Stratum-Boundary Batch Verification, RFC-0004 §4.4)
  const phaseOrder: ReadonlyArray<RewritePhase> = [
    "PLAN",
    "REPAIR_ARCH",
    "REPAIR_CODE",
    "CLEANUP",
  ]
  const acceptedPatches: Array<GraphPatch> = []
  const skippedRuleIds: Array<RewriteRuleId> = []
  const collectedDiagnostics: Array<string> = []
  let totalBisectionProbes = 0
  const probeSession = createTypeScriptProgramSession(repoRoot)

  for (const phase of phaseOrder) {
    let remainingInPhase = allPatches.filter((p) => p.phase === phase)
    if (remainingInPhase.length === 0) {
      continue
    }

    let phaseSettled = false
    while (!phaseSettled && remainingInPhase.length > 0) {
      const candidateBatch = [...acceptedPatches, ...remainingInPhase]
      const batchProjected = yield* safeProjectPatchesToInMemoryWorkspace(
        repoRoot,
        input.targetGraph,
        candidateBatch,
        input.initialGraph,
        input.existingFiles,
      )
      const batchCheck = yield* verifyProjectedSubset(
        repoRoot,
        input.initialGraph,
        input.targetGraph,
        candidateBatch,
        batchProjected.overlayMap,
        input.existingFiles,
        forceFailSet,
        probeSession,
      )

      if (batchCheck.isClean) {
        acceptedPatches.push(...remainingInPhase)
        phaseSettled = true
      } else {
        collectedDiagnostics.push(...batchCheck.diagnostics)
        if (remainingInPhase.length === 1) {
          totalBisectionProbes += 1
          skippedRuleIds.push(remainingInPhase[0]!.ruleId)
          remainingInPhase = []
          phaseSettled = true
        } else {
          const bisected = yield* isolateFirstOffendingPatchIndex(
            repoRoot,
            input.initialGraph,
            input.targetGraph,
            acceptedPatches,
            remainingInPhase,
            input.existingFiles,
            forceFailSet,
            probeSession,
          )
          totalBisectionProbes += bisected.probes
          const offending = remainingInPhase[bisected.offendingIndex]
          if (offending !== undefined) {
            skippedRuleIds.push(offending.ruleId)
          }
          acceptedPatches.push(...remainingInPhase.slice(0, bisected.offendingIndex))
          remainingInPhase = remainingInPhase.slice(bisected.offendingIndex + 1)
        }
      }
    }
  }

  const finalProjected = yield* safeProjectPatchesToInMemoryWorkspace(
    repoRoot,
    input.targetGraph,
    acceptedPatches,
    input.initialGraph,
    input.existingFiles,
  )

  const verificationStatus =
    skippedRuleIds.length === 0
      ? VerificationStatus.make("Verified")
      : acceptedPatches.length > 0
        ? VerificationStatus.make("Partial")
        : VerificationStatus.make("Unverified")

  return {
    operations: [...finalProjected.operations],
    overlays: [...finalProjected.overlays],
    verificationStatus,
    roundTripVerified: verificationStatus === "Verified",
    compilerDiagnostics: Array.from(new Set(collectedDiagnostics)),
    bisectionProbes: BisectionProbeCount.make(totalBisectionProbes),
    skippedRuleIds,
  }
})

export const GraphProjector = {
  decide: decideGraphProjection,
} as const
