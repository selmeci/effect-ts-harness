import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  type OmnigraphBranchVerifyInput,
  type OmnigraphBranchVerifyReport,
  type OmnigraphBranchViolation,
  OmnigraphConfigDriftKind,
  type OmnigraphSchemaEvolutionAction,
  type OmnigraphSchemaEvolutionInput,
  type OmnigraphSpanName,
  makeVerdictReport,
} from "@harness/contract"

export const decideOmnigraphBranchVerify = Effect.fn("OmnigraphBranchVerify.decide")(function* (
  input: OmnigraphBranchVerifyInput,
): Effect.fn.Return<OmnigraphBranchVerifyReport, never, never> {
  const violations: Array<OmnigraphBranchViolation> = []

  if (input.missingMergeBase === true) {
    violations.push({
      ruleId: "missing-merge-base",
      message: ErrorReasonMessage.make(
        `Missing merge base between '${input.planBranch}', '${input.implBranch}', and '${input.mainBranch}'.`,
      ),
    })
  }

  for (const conflict of input.dryRunConflicts) {
    violations.push({
      ruleId: "dry-run-merge-conflict",
      message: ErrorReasonMessage.make(
        `Dry-run merge (${input.implBranch} -> ${input.mainBranch}) conflict [${conflict.kind}] on ${conflict.typeName}(${conflict.entityId ?? "unknown"}): ${conflict.message}`,
      ),
      conflict,
    })
  }

  const activeSpanNames = new Set<OmnigraphSpanName>()
  for (const ch of input.diffChanges) {
    if (String(ch.typeName) === "EffectFn" && ch.spanName !== undefined) {
      match(ch.op)
        .with("insert", "update", () => {
          if (ch.spanName !== undefined) {
            activeSpanNames.add(ch.spanName)
          }
        })
        .with("delete", () => undefined)
        .exhaustive()
    }
  }

  for (const ch of input.diffChanges) {
    if (String(ch.typeName) === "EffectFn") {
      match(ch.op)
        .with("delete", () => {
          const movedOrRenamed = ch.spanName !== undefined && activeSpanNames.has(ch.spanName)
          if (!movedOrRenamed) {
            violations.push({
              ruleId: "planned-effect-fn-dropped",
              message: ErrorReasonMessage.make(
                `Planned EffectFn '${ch.entityId}' was dropped before verify on '${input.implBranch}'.`,
              ),
              change: ch,
            })
          }
        })
        .with("insert", "update", () => {
          if (ch.stubAfter) {
            violations.push({
              ruleId: "unimplemented-stub-remaining",
              message: ErrorReasonMessage.make(
                `Planned EffectFn '${ch.entityId}' remains a stub in '${input.implBranch}'.`,
              ),
              change: ch,
            })
          }
        })
        .exhaustive()
    }
  }

  if (
    input.remainingStubCount > 0 &&
    violations.every((v) => v.ruleId !== "unimplemented-stub-remaining")
  ) {
    violations.push({
      ruleId: "unimplemented-stub-remaining",
      message: ErrorReasonMessage.make(
        `Implementation branch '${input.implBranch}' still contains ${input.remainingStubCount} stub nodes.`,
      ),
    })
  }

  return yield* Effect.succeed(
    makeVerdictReport(violations, {
      verifiedChangeCount: NonNegativeCount.make(input.diffChanges.length),
      conflictCount: NonNegativeCount.make(input.dryRunConflicts.length),
    }),
  )
})

export const decideOmnigraphSchemaEvolution = Effect.fn("OmnigraphSchemaEvolution.decide")(
  function* (
    input: OmnigraphSchemaEvolutionInput,
  ): Effect.fn.Return<OmnigraphSchemaEvolutionAction, never, never> {
    const driftKind: OmnigraphConfigDriftKind = match({
      breaking: input.policyBundleOrEdgeKeyChanged,
      schemaAdditive: input.schemaAdditiveChanged,
      queries: input.queriesChanged,
    })
      .with({ breaking: true }, () =>
        OmnigraphConfigDriftKind.make("edge-key-or-policy-bundle-breaking"),
      )
      .with({ schemaAdditive: true, breaking: false }, () =>
        OmnigraphConfigDriftKind.make("schema-additive-or-rename"),
      )
      .with({ queries: true, schemaAdditive: false, breaking: false }, () =>
        OmnigraphConfigDriftKind.make("queries-only"),
      )
      .otherwise(() => OmnigraphConfigDriftKind.make("none"))

    return yield* Effect.succeed(
      match({
        clusterExists: input.clusterExists,
        driftKind,
      })
        .with({ clusterExists: false }, () => ({
          _tag: "LiveClusterApply" as const,
          requiresUnlock: true,
        }))
        .with({ driftKind: "edge-key-or-policy-bundle-breaking" }, () => ({
          _tag: "RequiresCleanRebuild" as const,
          reason: ErrorReasonMessage.make(
            "Applied policy bundle edits or edge @key changes cannot be applied in-place (Omnigraph deployment_scope / edge-key rule); rebuild cluster from workspace extract.",
          ),
        }))
        .with({ driftKind: "schema-additive-or-rename" }, { driftKind: "queries-only" }, () => ({
          _tag: "LiveClusterApply" as const,
          requiresUnlock: !input.serverAlive,
        }))
        .with({ driftKind: "none" }, () => ({
          _tag: "NoOp" as const,
        }))
        .exhaustive(),
    )
  },
)
