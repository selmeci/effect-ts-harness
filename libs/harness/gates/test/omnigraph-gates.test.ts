import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  OmnigraphBranchName,
  type OmnigraphBranchVerifyInput,
  OmnigraphChangeOp,
  OmnigraphConflictKind,
  OmnigraphDiagnosticCode,
  OmnigraphDiffChangeSummary,
  OmnigraphEntityId,
  OmnigraphEntityKind,
  OmnigraphLintDiagnostic,
  type OmnigraphLintInput,
  OmnigraphLintPolicy,
  type OmnigraphMergeConflictDetail,
  OmnigraphSchemaEvolutionInput,
  OmnigraphSpanName,
  OmnigraphTargetName,
  OmnigraphTypeName,
} from "@harness/contract"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { match } from "ts-pattern"
import {
  decideOmnigraphBranchVerify,
  decideOmnigraphLint,
  decideOmnigraphSchemaEvolution,
} from "../src/index.js"

const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

describe("Omnigraph Phase 9A/9B pure deciders", () => {
  it.effect(
    "REQ-3.1: decideOmnigraphBranchVerify returns clean when no conflicts, dropped fns, or stubs remain",
    () =>
      Effect.gen(function* () {
        const input: OmnigraphBranchVerifyInput = {
          planBranch: OmnigraphBranchName.make("plan/task-1"),
          implBranch: OmnigraphBranchName.make("impl/task-1"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [
              {
                _tag: "EffectFnUpdated",
                entityId: OmnigraphEntityId.make("fn:Orders.create"),
                wasStubBefore: true,
                stubAfter: false,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
            ],
            observedImplEffectFnCount: NonNegativeCount.make(1),
            unchangedStubCount: NonNegativeCount.make(0),
          },
          dryRunConflicts: [],
        }

        const { result: report, spans } = yield* runWithTestTracer(
          "OmnigraphBranchVerify.decide::clean",
          decideOmnigraphBranchVerify(input),
          emptyFnIndex,
        )

        expect(report.verdict).toBe("clean")
        expect(report.violations).toHaveLength(0)
        expect(report.verifiedChangeCount).toBe(1)
        expect(report.conflictCount).toBe(0)
        expect(report.implEffectFnCount).toBe(1)
        expect(spans.some((s) => s.name === "OmnigraphBranchVerify.decide")).toBe(true)
      }),
  )

  it.effect(
    "REQ-3.1: decideOmnigraphBranchVerify flags conflicts, dropped/0-count EffectFns, remaining & unchanged stubs, and missing-merge-base",
    () =>
      Effect.gen(function* () {
        const movedClean = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/move"),
          implBranch: OmnigraphBranchName.make("impl/move"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [
              {
                _tag: "EffectFnDeleted",
                entityId: OmnigraphEntityId.make("fn:old-file:Orders.create"),
                wasStubBefore: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EffectFnInserted",
                entityId: OmnigraphEntityId.make("fn:new-file:Orders.create"),
                stubAfter: false,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EntityDiffChange",
                entityKind: OmnigraphEntityKind.make("node"),
                typeName: OmnigraphTypeName.make("ServiceTag"),
                entityId: OmnigraphEntityId.make("svc:DeprecatedService"),
                op: OmnigraphChangeOp.make("delete"),
              },
            ],
            observedImplEffectFnCount: NonNegativeCount.make(1),
            unchangedStubCount: NonNegativeCount.make(0),
          },
          dryRunConflicts: [],
        })
        expect(movedClean.verdict).toBe("clean")
        expect(movedClean.violations).toHaveLength(0)

        const conflict: OmnigraphMergeConflictDetail = {
          kind: OmnigraphConflictKind.make("divergent_update"),
          entityKind: OmnigraphEntityKind.make("node"),
          typeName: OmnigraphTypeName.make("EffectFn"),
          entityId: OmnigraphEntityId.make("fn:Cart.pay"),
          message: ErrorReasonMessage.make("Concurrent edit on main"),
        }

        const droppedFn: OmnigraphDiffChangeSummary = {
          _tag: "EffectFnDeleted",
          entityId: OmnigraphEntityId.make("fn:Cart.reserve"),
          wasStubBefore: true,
          spanName: null,
        }

        const stillStubFn: OmnigraphDiffChangeSummary = {
          _tag: "EffectFnInserted",
          entityId: OmnigraphEntityId.make("fn:Cart.refund"),
          stubAfter: true,
          spanName: OmnigraphSpanName.make("Cart.refund"),
        }

        const extraStubReport = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/task-2"),
          implBranch: OmnigraphBranchName.make("impl/task-2"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [droppedFn, stillStubFn],
            observedImplEffectFnCount: NonNegativeCount.make(0),
            unchangedStubCount: NonNegativeCount.make(1),
          },
          dryRunConflicts: [conflict],
        })

        expect(extraStubReport.verdict).toBe("violated")
        const stubViolations = extraStubReport.violations.filter(
          (v) => v._tag === "unimplemented-stub-remaining",
        )
        expect(stubViolations).toHaveLength(2)
        expect(extraStubReport.violations.some((v) => v._tag === "planned-effect-fn-dropped")).toBe(
          true,
        )
        expect(extraStubReport.violations.some((v) => v._tag === "no-effect-fn-implemented")).toBe(
          true,
        )
        expect(extraStubReport.conflictCount).toBe(1)

        const missingBaseReport = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/task-3"),
          implBranch: OmnigraphBranchName.make("impl/task-3"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: { _tag: "MissingMergeBase" },
          dryRunConflicts: [],
        })
        expect(missingBaseReport.verdict).toBe("violated")
        expect(missingBaseReport.violations.map((v) => v._tag)).toEqual(["missing-merge-base"])
      }),
  )

  it.effect(
    "REQ-3.1: move/rename exemption counts only non-stub EffectFnInserted and decrements per EffectFnDeleted",
    () =>
      Effect.gen(function* () {
        // Duplicate EffectFnDeleted with same spanName: only 1 is exempted by 1 EffectFnInserted
        const duplicateDelete = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/dup-del"),
          implBranch: OmnigraphBranchName.make("impl/dup-del"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [
              {
                _tag: "EffectFnDeleted",
                entityId: OmnigraphEntityId.make("fn:old1:Orders.create"),
                wasStubBefore: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EffectFnDeleted",
                entityId: OmnigraphEntityId.make("fn:old2:Orders.create"),
                wasStubBefore: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EffectFnInserted",
                entityId: OmnigraphEntityId.make("fn:new:Orders.create"),
                stubAfter: false,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
            ],
            observedImplEffectFnCount: NonNegativeCount.make(1),
            unchangedStubCount: NonNegativeCount.make(0),
          },
          dryRunConflicts: [],
        })
        expect(duplicateDelete.verdict).toBe("violated")
        expect(
          duplicateDelete.violations.filter((v) => v._tag === "planned-effect-fn-dropped"),
        ).toHaveLength(1)

        // EffectFnUpdated with same spanName does NOT exempt EffectFnDeleted
        const updatedNotExempt = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/upd-no-exempt"),
          implBranch: OmnigraphBranchName.make("impl/upd-no-exempt"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [
              {
                _tag: "EffectFnDeleted",
                entityId: OmnigraphEntityId.make("fn:old:Orders.create"),
                wasStubBefore: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EffectFnUpdated",
                entityId: OmnigraphEntityId.make("fn:other:Orders.create"),
                wasStubBefore: true,
                stubAfter: false,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
            ],
            observedImplEffectFnCount: NonNegativeCount.make(1),
            unchangedStubCount: NonNegativeCount.make(0),
          },
          dryRunConflicts: [],
        })
        expect(updatedNotExempt.verdict).toBe("violated")
        expect(
          updatedNotExempt.violations.filter((v) => v._tag === "planned-effect-fn-dropped"),
        ).toHaveLength(1)

        // EffectFnInserted with stubAfter=true does NOT exempt EffectFnDeleted
        const stubInsertNotExempt = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/stub-no-exempt"),
          implBranch: OmnigraphBranchName.make("impl/stub-no-exempt"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: {
            _tag: "ResolvedDiff",
            changes: [
              {
                _tag: "EffectFnDeleted",
                entityId: OmnigraphEntityId.make("fn:old:Orders.create"),
                wasStubBefore: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
              {
                _tag: "EffectFnInserted",
                entityId: OmnigraphEntityId.make("fn:new:Orders.create"),
                stubAfter: true,
                spanName: OmnigraphSpanName.make("Orders.create"),
              },
            ],
            observedImplEffectFnCount: NonNegativeCount.make(1),
            unchangedStubCount: NonNegativeCount.make(0),
          },
          dryRunConflicts: [],
        })
        expect(stubInsertNotExempt.verdict).toBe("violated")
        expect(
          stubInsertNotExempt.violations.filter((v) => v._tag === "planned-effect-fn-dropped"),
        ).toHaveLength(1)
      }),
  )

  it.effect.prop(
    "REQ-3.1 property: branch verify satisfies independent domain invariants",
    {
      diffChanges: Schema.Array(OmnigraphDiffChangeSummary),
      conflictCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      unchangedStubCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      missingMergeBase: Schema.Boolean,
      zeroObservedImplEffectFnCount: Schema.Boolean,
    },
    ({
      diffChanges,
      conflictCount,
      unchangedStubCount,
      missingMergeBase,
      zeroObservedImplEffectFnCount,
    }) =>
      Effect.gen(function* () {
        const dryRunConflicts: Array<OmnigraphMergeConflictDetail> = Array.from(
          { length: conflictCount },
          (_, idx) => ({
            kind: OmnigraphConflictKind.make("divergent_update"),
            entityKind: OmnigraphEntityKind.make("node"),
            typeName: OmnigraphTypeName.make("EffectFn"),
            entityId: OmnigraphEntityId.make(`fn:Test.conflict${idx}`),
            message: ErrorReasonMessage.make(`Conflict ${idx}`),
          }),
        )

        const activeFnCount = diffChanges.filter((ch) =>
          match(ch)
            .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, () => true)
            .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => false)
            .exhaustive(),
        ).length
        const observedImplEffectFnCount = NonNegativeCount.make(
          missingMergeBase ? 0 : zeroObservedImplEffectFnCount ? 0 : Math.max(1, activeFnCount),
        )

        const report = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/prop"),
          implBranch: OmnigraphBranchName.make("impl/prop"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffState: missingMergeBase
            ? { _tag: "MissingMergeBase" }
            : {
                _tag: "ResolvedDiff",
                changes: diffChanges,
                observedImplEffectFnCount,
                unchangedStubCount: NonNegativeCount.make(unchangedStubCount),
              },
          dryRunConflicts,
        })

        const actualTags = new Set(report.violations.map((v) => v._tag))
        expect(report.conflictCount).toBe(conflictCount)
        expect(report.implEffectFnCount).toBe(observedImplEffectFnCount)

        if (conflictCount > 0) {
          expect(report.verdict).toBe("violated")
          expect(report.violations.filter((v) => v._tag === "dry-run-merge-conflict")).toHaveLength(
            conflictCount,
          )
        }

        if (missingMergeBase) {
          expect(report.verdict).toBe("violated")
          expect(actualTags.has("missing-merge-base")).toBe(true)
          expect(report.verifiedChangeCount).toBe(0)
          return
        }

        expect(report.verifiedChangeCount).toBe(diffChanges.length)

        const hasStubInChanges = diffChanges.some((ch) =>
          match(ch)
            .with(
              { _tag: "EffectFnInserted" },
              { _tag: "EffectFnUpdated" },
              (fnCh) => fnCh.stubAfter,
            )
            .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => false)
            .exhaustive(),
        )
        if (hasStubInChanges || unchangedStubCount > 0) {
          expect(report.verdict).toBe("violated")
          expect(actualTags.has("unimplemented-stub-remaining")).toBe(true)
        }

        if (activeFnCount > 0 && observedImplEffectFnCount === 0) {
          expect(report.verdict).toBe("violated")
          expect(actualTags.has("no-effect-fn-implemented")).toBe(true)
        }

        const hasNullSpanDelete = diffChanges.some((ch) =>
          match(ch)
            .with({ _tag: "EffectFnDeleted" }, (fnCh) => fnCh.spanName === null)
            .with(
              { _tag: "EffectFnInserted" },
              { _tag: "EffectFnUpdated" },
              { _tag: "EntityDiffChange" },
              () => false,
            )
            .exhaustive(),
        )
        if (hasNullSpanDelete) {
          expect(report.verdict).toBe("violated")
          expect(actualTags.has("planned-effect-fn-dropped")).toBe(true)
        }

        const hasAnyDelete = diffChanges.some((ch) =>
          match(ch)
            .with({ _tag: "EffectFnDeleted" }, () => true)
            .with(
              { _tag: "EffectFnInserted" },
              { _tag: "EffectFnUpdated" },
              { _tag: "EntityDiffChange" },
              () => false,
            )
            .exhaustive(),
        )
        if (
          conflictCount === 0 &&
          unchangedStubCount === 0 &&
          !hasStubInChanges &&
          !hasAnyDelete &&
          observedImplEffectFnCount > 0
        ) {
          expect(report.verdict).toBe("clean")
          expect(report.violations).toHaveLength(0)
        }
      }),
  )

  it.effect(
    "REQ-7.2: decideOmnigraphSchemaEvolution emits LiveClusterApply, RequiresCleanRebuild, or NoOp with span",
    () =>
      Effect.gen(function* () {
        const { result: initAction, spans } = yield* runWithTestTracer(
          "OmnigraphSchemaEvolution.decide::init",
          decideOmnigraphSchemaEvolution({ _tag: "ClusterMissing" }),
          emptyFnIndex,
        )
        expect(initAction).toEqual({ _tag: "LiveClusterApply", requiresUnlock: true })
        expect(spans.some((s) => s.name === "OmnigraphSchemaEvolution.decide")).toBe(true)

        const rebuildAction = yield* decideOmnigraphSchemaEvolution({
          _tag: "ClusterPresent",
          driftKind: "edge-key-or-policy-bundle-breaking",
          serverAlive: true,
        })
        expect(rebuildAction._tag).toBe("RequiresCleanRebuild")

        const noopAction = yield* decideOmnigraphSchemaEvolution({
          _tag: "ClusterPresent",
          driftKind: "none",
          serverAlive: true,
        })
        expect(noopAction).toEqual({ _tag: "NoOp" })
      }),
  )

  it.effect.prop(
    "REQ-7.2 property: schema evolution decision is total, deterministic, and satisfies safety invariants",
    {
      input: OmnigraphSchemaEvolutionInput,
    },
    ({ input }) =>
      Effect.gen(function* () {
        const action = yield* decideOmnigraphSchemaEvolution(input)
        const action2 = yield* decideOmnigraphSchemaEvolution(input)
        expect(action2).toEqual(action)

        match(input)
          .with({ _tag: "ClusterMissing" }, () => {
            match(action)
              .with({ _tag: "LiveClusterApply" }, (a) => {
                expect(a.requiresUnlock).toBe(true)
              })
              .with({ _tag: "RequiresCleanRebuild" }, { _tag: "NoOp" }, () => {
                expect.unreachable("Expected LiveClusterApply for ClusterMissing")
              })
              .exhaustive()
          })
          .with({ _tag: "ClusterPresent" }, ({ driftKind, serverAlive }) => {
            if (driftKind === "edge-key-or-policy-bundle-breaking") {
              match(action)
                .with({ _tag: "RequiresCleanRebuild" }, (a) => {
                  expect(a.reason.length).toBeGreaterThan(0)
                })
                .with({ _tag: "LiveClusterApply" }, { _tag: "NoOp" }, () => {
                  expect.unreachable("Expected RequiresCleanRebuild for breaking drift")
                })
                .exhaustive()
            } else if (driftKind === "none") {
              expect(action).toEqual({ _tag: "NoOp" })
            } else {
              match(action)
                .with({ _tag: "LiveClusterApply" }, (a) => {
                  expect(a.requiresUnlock).toBe(!serverAlive)
                })
                .with({ _tag: "RequiresCleanRebuild" }, { _tag: "NoOp" }, () => {
                  expect.unreachable("Expected LiveClusterApply for non-breaking drift")
                })
                .exhaustive()
            }
          })
          .exhaustive()
      }),
  )

  it.effect(
    "REQ-7.1: decideOmnigraphLint returns clean on ok/warning-only input and fails closed with OmnigraphLintError on blocking diagnostics",
    () =>
      Effect.gen(function* () {
        const cleanInput: OmnigraphLintInput = {
          statusOk: true,
          queriesProcessed: NonNegativeCount.make(14),
          diagnostics: [
            {
              code: OmnigraphDiagnosticCode.make("GQ-W01"),
              message: ErrorReasonMessage.make("Unused index hint"),
              targetName: null,
              severity: "warning",
            },
          ],
          policy: "fail-on-error",
        }

        const { result: cleanReport, spans } = yield* runWithTestTracer(
          "OmnigraphLint.decide::clean-with-warning",
          decideOmnigraphLint(cleanInput),
          emptyFnIndex,
        )
        expect(cleanReport.verdict).toBe("clean")
        expect(cleanReport.violations).toHaveLength(0)
        expect(cleanReport.queriesProcessed).toBe(14)
        expect(cleanReport.errorCount).toBe(0)
        expect(cleanReport.warningCount).toBe(1)
        expect(spans.some((s) => s.name === "OmnigraphLint.decide")).toBe(true)

        const errorDiagExit = yield* Effect.exit(
          decideOmnigraphLint({
            statusOk: true,
            queriesProcessed: NonNegativeCount.make(14),
            diagnostics: [
              {
                code: OmnigraphDiagnosticCode.make("GQ-T37"),
                message: ErrorReasonMessage.make("rrf cannot be projected"),
                targetName: OmnigraphTargetName.make("rank_patterns_hybrid"),
                severity: "error",
              },
            ],
            policy: "fail-on-error",
          }),
        )

        const exitOk = Exit.match(errorDiagExit, {
          onSuccess: () => false,
          onFailure: (cause) =>
            !Cause.hasDies(cause) &&
            Option.match(Cause.findErrorOption(cause), {
              onNone: () => false,
              onSome: (err) =>
                err._tag === "OmnigraphLintError" &&
                err.errorCount === 1 &&
                err.diagnosticsSummary.includes("GQ-T37"),
            }),
        })
        expect(exitOk).toBe(true)
      }),
  )

  it.effect.prop(
    "REQ-7.1 property: OmnigraphLintPolicy satisfies independent blocking and error invariants",
    {
      statusOk: Schema.Boolean,
      diagnostics: Schema.Array(OmnigraphLintDiagnostic),
      policy: OmnigraphLintPolicy,
      queriesProcessed: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    },
    ({ statusOk, diagnostics, policy, queriesProcessed }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decideOmnigraphLint({
            statusOk,
            queriesProcessed: NonNegativeCount.make(queriesProcessed),
            diagnostics,
            policy,
          }),
        )

        const errorCount = diagnostics.filter((d) => d.severity === "error").length
        const warningCount = diagnostics.filter((d) => d.severity === "warning").length

        if (policy === "report-only") {
          Exit.match(exit, {
            onFailure: () => {
              expect.unreachable("report-only policy must never fail")
            },
            onSuccess: (report) => {
              expect(report.queriesProcessed).toBe(queriesProcessed)
              expect(report.errorCount).toBe(errorCount)
              expect(report.warningCount).toBe(warningCount)
              if (errorCount > 0 || !statusOk) {
                expect(report.verdict).toBe("violated")
              }
            },
          })
          return
        }

        const mustFail =
          errorCount > 0 || !statusOk || (policy === "deny-warnings" && warningCount > 0)

        expect(Exit.isFailure(exit)).toBe(mustFail)
        Exit.match(exit, {
          onFailure: (cause) => {
            expect(Cause.hasDies(cause)).toBe(false)
            Option.match(Cause.findErrorOption(cause), {
              onNone: () => {
                expect.unreachable("Expected typed OmnigraphLintError")
              },
              onSome: (err) => {
                expect(err._tag).toBe("OmnigraphLintError")
                expect(err.errorCount).toBeGreaterThanOrEqual(1)
                expect(err.diagnosticsSummary.length).toBeGreaterThan(0)
              },
            })
          },
          onSuccess: (report) => {
            expect(report.verdict).toBe("clean")
            expect(report.errorCount).toBe(0)
            expect(report.queriesProcessed).toBe(queriesProcessed)
          },
        })
      }),
  )
})
