import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  type OmnigraphBranchVerifyInput,
  type OmnigraphBranchVerifyReport,
  type OmnigraphBranchViolation,
  type OmnigraphSchemaEvolutionAction,
  type OmnigraphSchemaEvolutionInput,
  type OmnigraphSpanName,
  makeVerdictReport,
} from "@harness/contract"

export const decideOmnigraphBranchVerify = Effect.fn("OmnigraphBranchVerify.decide")(function* (
  input: OmnigraphBranchVerifyInput,
): Effect.fn.Return<OmnigraphBranchVerifyReport, never, never> {
  const violations: Array<OmnigraphBranchViolation> = []

  const resolvedDiff = match(input.diffState)
    .with({ _tag: "MissingMergeBase" }, () => {
      violations.push({
        _tag: "missing-merge-base",
        message: ErrorReasonMessage.make(
          `Missing merge base between '${input.planBranch}', '${input.implBranch}', and '${input.mainBranch}'.`,
        ),
      })
      return {
        changes: [],
        observedImplEffectFnCount: NonNegativeCount.make(0),
        unchangedStubCount: NonNegativeCount.make(0),
      }
    })
    .with({ _tag: "ResolvedDiff" }, (resolved) => resolved)
    .exhaustive()

  const diffChanges = resolvedDiff.changes

  for (const conflict of input.dryRunConflicts) {
    violations.push({
      _tag: "dry-run-merge-conflict",
      message: ErrorReasonMessage.make(
        `Dry-run merge (${input.implBranch} -> ${input.mainBranch}) conflict [${conflict.kind}] on ${conflict.typeName}(${conflict.entityId ?? "unknown"}): ${conflict.message}`,
      ),
      conflict,
    })
  }

  const activeSpanNames = new Set<OmnigraphSpanName>()
  let activeDiffEffectFnCount = 0
  for (const ch of diffChanges) {
    match(ch)
      .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, (fnChange) => {
        activeDiffEffectFnCount += 1
        if (fnChange.spanName !== null) {
          activeSpanNames.add(fnChange.spanName)
        }
      })
      .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => undefined)
      .exhaustive()
  }

  for (const ch of diffChanges) {
    match(ch)
      .with({ _tag: "EffectFnDeleted" }, (fnChange) => {
        const movedOrRenamed =
          fnChange.spanName !== null && activeSpanNames.has(fnChange.spanName)
        if (!movedOrRenamed) {
          violations.push({
            _tag: "planned-effect-fn-dropped",
            message: ErrorReasonMessage.make(
              `Planned EffectFn '${fnChange.entityId}' was dropped before verify on '${input.implBranch}'.`,
            ),
            change: fnChange,
          })
        }
      })
      .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, (fnChange) => {
        if (fnChange.stubAfter) {
          violations.push({
            _tag: "unimplemented-stub-remaining",
            message: ErrorReasonMessage.make(
              `Planned EffectFn '${fnChange.entityId}' remains a stub in '${input.implBranch}'.`,
            ),
            change: fnChange,
          })
        }
      })
      .with({ _tag: "EntityDiffChange" }, () => undefined)
      .exhaustive()
  }

  if (
    resolvedDiff.observedImplEffectFnCount !== null &&
    activeDiffEffectFnCount > 0 &&
    resolvedDiff.observedImplEffectFnCount === 0
  ) {
    const activeCount = NonNegativeCount.make(activeDiffEffectFnCount)
    violations.push({
      _tag: "no-effect-fn-implemented",
      message: ErrorReasonMessage.make(
        `Diff contains ${activeDiffEffectFnCount} active planned EffectFn(s) on '${input.implBranch}', but observed implEffectFnCount is 0.`,
      ),
      activeDiffEffectFnCount: activeCount,
    })
  }

  if (resolvedDiff.unchangedStubCount > 0) {
    violations.push({
      _tag: "unimplemented-stub-remaining",
      message: ErrorReasonMessage.make(
        `Implementation branch '${input.implBranch}' still contains ${resolvedDiff.unchangedStubCount} unchanged stub node(s) from plan.`,
      ),
      change: null,
    })
  }

  const implEffectFnCount =
    resolvedDiff.observedImplEffectFnCount ?? NonNegativeCount.make(activeDiffEffectFnCount)

  return yield* Effect.succeed(
    makeVerdictReport(violations, {
      verifiedChangeCount: NonNegativeCount.make(diffChanges.length),
      conflictCount: NonNegativeCount.make(input.dryRunConflicts.length),
      implEffectFnCount,
    }),
  )
})

export const decideOmnigraphSchemaEvolution = Effect.fn("OmnigraphSchemaEvolution.decide")(
  function* (
    input: OmnigraphSchemaEvolutionInput,
  ): Effect.fn.Return<OmnigraphSchemaEvolutionAction, never, never> {
    return yield* Effect.succeed(
      match(input)
        .with({ _tag: "ClusterMissing" }, () => ({
          _tag: "LiveClusterApply" as const,
          requiresUnlock: true,
        }))
        .with({ _tag: "ClusterPresent" }, ({ driftKind, serverAlive }) =>
          match(driftKind)
            .with("edge-key-or-policy-bundle-breaking", () => ({
              _tag: "RequiresCleanRebuild" as const,
              reason: ErrorReasonMessage.make(
                "Applied policy bundle edits or edge @key changes cannot be applied in-place (Omnigraph deployment_scope / edge-key rule); rebuild cluster from workspace extract.",
              ),
            }))
            .with("schema-additive-or-rename", "queries-only", () => ({
              _tag: "LiveClusterApply" as const,
              requiresUnlock: !serverAlive,
            }))
            .with("none", () => ({
              _tag: "NoOp" as const,
            }))
            .exhaustive(),
        )
        .exhaustive(),
    )
  },
)
