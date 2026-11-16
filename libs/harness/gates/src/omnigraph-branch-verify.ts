import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  type EffectFnDiffChange,
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

  const diffChanges = match(input.diffState)
    .with({ _tag: "MissingMergeBase" }, () => {
      violations.push({
        _tag: "MissingMergeBaseViolation",
        ruleId: "missing-merge-base",
        message: ErrorReasonMessage.make(
          `Missing merge base between '${input.planBranch}', '${input.implBranch}', and '${input.mainBranch}'.`,
        ),
      })
      return []
    })
    .with({ _tag: "ResolvedDiff" }, ({ changes }) => changes)
    .exhaustive()

  for (const conflict of input.dryRunConflicts) {
    violations.push({
      _tag: "DryRunMergeConflictViolation",
      ruleId: "dry-run-merge-conflict",
      message: ErrorReasonMessage.make(
        `Dry-run merge (${input.implBranch} -> ${input.mainBranch}) conflict [${conflict.kind}] on ${conflict.typeName}(${conflict.entityId ?? "unknown"}): ${conflict.message}`,
      ),
      conflict,
    })
  }

  const activeSpanNames = new Set<OmnigraphSpanName>()
  let activeDiffEffectFnCount = 0
  let firstActiveEffectFn: EffectFnDiffChange | undefined
  for (const ch of diffChanges) {
    match(ch)
      .with({ _tag: "EffectFnDiffChange" }, (fnChange) => {
        match(fnChange.op)
          .with("insert", "update", () => {
            activeDiffEffectFnCount += 1
            if (firstActiveEffectFn === undefined) {
              firstActiveEffectFn = fnChange
            }
            if (fnChange.spanName !== null) {
              activeSpanNames.add(fnChange.spanName)
            }
          })
          .with("delete", () => undefined)
          .exhaustive()
      })
      .with({ _tag: "EntityDiffChange" }, () => undefined)
      .exhaustive()
  }

  let diffStubViolationCount = 0
  for (const ch of diffChanges) {
    match(ch)
      .with({ _tag: "EffectFnDiffChange" }, (fnChange) => {
        match(fnChange.op)
          .with("delete", () => {
            const movedOrRenamed =
              fnChange.spanName !== null && activeSpanNames.has(fnChange.spanName)
            if (!movedOrRenamed) {
              violations.push({
                _tag: "PlannedEffectFnDroppedViolation",
                ruleId: "planned-effect-fn-dropped",
                message: ErrorReasonMessage.make(
                  `Planned EffectFn '${fnChange.entityId}' was dropped before verify on '${input.implBranch}'.`,
                ),
                change: fnChange,
              })
            }
          })
          .with("insert", "update", () => {
            if (fnChange.stubAfter) {
              diffStubViolationCount += 1
              violations.push({
                _tag: "UnimplementedStubRemainingViolation",
                ruleId: "unimplemented-stub-remaining",
                message: ErrorReasonMessage.make(
                  `Planned EffectFn '${fnChange.entityId}' remains a stub in '${input.implBranch}'.`,
                ),
                change: fnChange,
              })
            }
          })
          .exhaustive()
      })
      .with({ _tag: "EntityDiffChange" }, () => undefined)
      .exhaustive()
  }

  if (
    activeDiffEffectFnCount > 0 &&
    input.implEffectFnCount === 0 &&
    firstActiveEffectFn !== undefined
  ) {
    violations.push({
      _tag: "PlannedEffectFnDroppedViolation",
      ruleId: "planned-effect-fn-dropped",
      message: ErrorReasonMessage.make(
        `Diff contains ${activeDiffEffectFnCount} active planned EffectFn(s) on '${input.implBranch}', but implEffectFnCount is 0.`,
      ),
      change: firstActiveEffectFn,
    })
  }

  if (input.remainingStubCount > diffStubViolationCount) {
    const extraStubCount = input.remainingStubCount - diffStubViolationCount
    violations.push({
      _tag: "UnimplementedStubRemainingViolation",
      ruleId: "unimplemented-stub-remaining",
      message: ErrorReasonMessage.make(
        `Implementation branch '${input.implBranch}' still contains ${input.remainingStubCount} stub node(s) (${extraStubCount} unchanged between plan and impl).`,
      ),
      change: null,
    })
  }

  return yield* Effect.succeed(
    makeVerdictReport(violations, {
      verifiedChangeCount: NonNegativeCount.make(diffChanges.length),
      conflictCount: NonNegativeCount.make(input.dryRunConflicts.length),
      implEffectFnCount: input.implEffectFnCount,
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
