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
        expect(
          extraStubReport.violations.some((v) => v._tag === "planned-effect-fn-dropped"),
        ).toBe(true)
        expect(
          extraStubReport.violations.some((v) => v._tag === "no-effect-fn-implemented"),
        ).toBe(true)
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

  it.effect.prop(
    "REQ-3.1 property: mixed-type diffChanges and conflicts produce exact violation _tag sets",
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

        const effectiveChanges = missingMergeBase ? [] : diffChanges
        const activeDiffFns = effectiveChanges.filter((ch) =>
          match(ch)
            .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, () => true)
            .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => false)
            .exhaustive(),
        )
        const observedImplEffectFnCount = NonNegativeCount.make(
          missingMergeBase
            ? 0
            : zeroObservedImplEffectFnCount
              ? 0
              : Math.max(1, activeDiffFns.length),
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

        const activeSpanNames = new Set(
          activeDiffFns
            .map((ch) =>
              match(ch)
                .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, (fnCh) => fnCh.spanName)
                .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => null)
                .exhaustive(),
            )
            .filter((name): name is OmnigraphSpanName => name !== null),
        )

        const expectedRules = new Set<string>()
        if (missingMergeBase) expectedRules.add("missing-merge-base")
        if (conflictCount > 0) expectedRules.add("dry-run-merge-conflict")
        for (const ch of effectiveChanges) {
          match(ch)
            .with({ _tag: "EffectFnDeleted" }, (fnCh) => {
              if (fnCh.spanName === null || !activeSpanNames.has(fnCh.spanName)) {
                expectedRules.add("planned-effect-fn-dropped")
              }
            })
            .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, (fnCh) => {
              if (fnCh.stubAfter) {
                expectedRules.add("unimplemented-stub-remaining")
              }
            })
            .with({ _tag: "EntityDiffChange" }, () => undefined)
            .exhaustive()
        }
        if (activeDiffFns.length > 0 && observedImplEffectFnCount === 0) {
          expectedRules.add("no-effect-fn-implemented")
        }
        if (!missingMergeBase && unchangedStubCount > 0) {
          expectedRules.add("unimplemented-stub-remaining")
        }

        const actualRules = new Set(report.violations.map((v) => v._tag))
        expect(actualRules).toEqual(expectedRules)
        expect(report.verdict).toBe(expectedRules.size > 0 ? "violated" : "clean")
        expect(report.verifiedChangeCount).toBe(effectiveChanges.length)
        expect(report.conflictCount).toBe(conflictCount)
        expect(report.implEffectFnCount).toBe(observedImplEffectFnCount)
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
    "REQ-7.2 property: schema evolution decision is total and deterministic across union inputs",
    {
      input: OmnigraphSchemaEvolutionInput,
    },
    ({ input }) =>
      Effect.gen(function* () {
        const action = yield* decideOmnigraphSchemaEvolution(input)

        match(input)
          .with({ _tag: "ClusterMissing" }, () => {
            expect(action).toEqual({ _tag: "LiveClusterApply", requiresUnlock: true })
            expect(Object.keys(action).sort()).toEqual(["_tag", "requiresUnlock"])
          })
          .with({ _tag: "ClusterPresent" }, ({ driftKind, serverAlive }) => {
            match(driftKind)
              .with("edge-key-or-policy-bundle-breaking", () => {
                expect(action).toEqual({
                  _tag: "RequiresCleanRebuild",
                  reason: ErrorReasonMessage.make(
                    "Applied policy bundle edits or edge @key changes cannot be applied in-place (Omnigraph deployment_scope / edge-key rule); rebuild cluster from workspace extract.",
                  ),
                })
                expect(Object.keys(action).sort()).toEqual(["_tag", "reason"])
              })
              .with("schema-additive-or-rename", "queries-only", () => {
                expect(action).toEqual({
                  _tag: "LiveClusterApply",
                  requiresUnlock: !serverAlive,
                })
                expect(Object.keys(action).sort()).toEqual(["_tag", "requiresUnlock"])
              })
              .with("none", () => {
                expect(action).toEqual({ _tag: "NoOp" })
                expect(Object.keys(action)).toEqual(["_tag"])
              })
              .exhaustive()
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
    "REQ-7.1 property: OmnigraphLintPolicy governs blocking violations and OmnigraphLintError",
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

        const denyWarnings = policy === "deny-warnings"
        const errorCount = diagnostics.filter((d) => d.severity === "error").length
        const warningCount = diagnostics.filter((d) => d.severity === "warning").length
        const blockingCount = diagnostics.filter(
          (d) => d.severity === "error" || (d.severity === "warning" && denyWarnings),
        ).length
        const hasBlockingErrors = blockingCount > 0 || !statusOk
        const shouldFail = policy !== "report-only" && hasBlockingErrors
        const expectedVerdict = hasBlockingErrors ? "violated" : "clean"

        const checkResult = Exit.match(exit, {
          onFailure: (cause) =>
            shouldFail &&
            !Cause.hasDies(cause) &&
            Option.match(Cause.findErrorOption(cause), {
              onNone: () => false,
              onSome: (err) =>
                err._tag === "OmnigraphLintError" &&
                err.errorCount >= 1 &&
                err.diagnosticsSummary.length > 0,
            }),
          onSuccess: (report) =>
            !shouldFail &&
            report.verdict === expectedVerdict &&
            report.queriesProcessed === queriesProcessed &&
            report.errorCount === errorCount &&
            report.warningCount === warningCount,
        })
        expect(Exit.isFailure(exit)).toBe(shouldFail)
        expect(checkResult).toBe(true)
      }),
  )
})
