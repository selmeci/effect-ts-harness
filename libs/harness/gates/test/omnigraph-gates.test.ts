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
  type OmnigraphMergeConflictDetail,
  OmnigraphSchemaEvolutionInput,
  OmnigraphSpanName,
  OmnigraphTargetName,
  OmnigraphTypeName,
} from "@harness/contract"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
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
          diffChanges: [
            {
              entityKind: OmnigraphEntityKind.make("node"),
              typeName: OmnigraphTypeName.make("EffectFn"),
              entityId: OmnigraphEntityId.make("fn:Orders.create"),
              op: OmnigraphChangeOp.make("update"),
              wasStubBefore: true,
              stubAfter: false,
              spanName: OmnigraphSpanName.make("Orders.create"),
            },
          ],
          dryRunConflicts: [],
          implEffectFnCount: NonNegativeCount.make(1),
          remainingStubCount: NonNegativeCount.make(0),
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
        expect(spans.some((s) => s.name === "OmnigraphBranchVerify.decide")).toBe(true)
      }),
  )

  it.effect(
    "REQ-3.1: decideOmnigraphBranchVerify flags conflicts, dropped EffectFns, remaining stubs, and missing-merge-base, while allowing moved EffectFns and non-EffectFn deletes",
    () =>
      Effect.gen(function* () {
        const movedClean = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/move"),
          implBranch: OmnigraphBranchName.make("impl/move"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffChanges: [
            {
              entityKind: OmnigraphEntityKind.make("node"),
              typeName: OmnigraphTypeName.make("EffectFn"),
              entityId: OmnigraphEntityId.make("fn:old-file:Orders.create"),
              op: OmnigraphChangeOp.make("delete"),
              wasStubBefore: true,
              stubAfter: false,
              spanName: OmnigraphSpanName.make("Orders.create"),
            },
            {
              entityKind: OmnigraphEntityKind.make("node"),
              typeName: OmnigraphTypeName.make("EffectFn"),
              entityId: OmnigraphEntityId.make("fn:new-file:Orders.create"),
              op: OmnigraphChangeOp.make("insert"),
              wasStubBefore: false,
              stubAfter: false,
              spanName: OmnigraphSpanName.make("Orders.create"),
            },
            {
              entityKind: OmnigraphEntityKind.make("node"),
              typeName: OmnigraphTypeName.make("ServiceTag"),
              entityId: OmnigraphEntityId.make("svc:DeprecatedService"),
              op: OmnigraphChangeOp.make("delete"),
              wasStubBefore: false,
              stubAfter: false,
            },
          ],
          dryRunConflicts: [],
          implEffectFnCount: NonNegativeCount.make(1),
          remainingStubCount: NonNegativeCount.make(0),
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
          entityKind: OmnigraphEntityKind.make("node"),
          typeName: OmnigraphTypeName.make("EffectFn"),
          entityId: OmnigraphEntityId.make("fn:Cart.reserve"),
          op: OmnigraphChangeOp.make("delete"),
          wasStubBefore: true,
          stubAfter: false,
        }

        const stillStubFn: OmnigraphDiffChangeSummary = {
          entityKind: OmnigraphEntityKind.make("node"),
          typeName: OmnigraphTypeName.make("EffectFn"),
          entityId: OmnigraphEntityId.make("fn:Cart.refund"),
          op: OmnigraphChangeOp.make("insert"),
          wasStubBefore: false,
          stubAfter: true,
        }

        const report = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/task-2"),
          implBranch: OmnigraphBranchName.make("impl/task-2"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffChanges: [droppedFn, stillStubFn],
          dryRunConflicts: [conflict],
          implEffectFnCount: NonNegativeCount.make(1),
          remainingStubCount: NonNegativeCount.make(1),
          missingMergeBase: true,
        })

        expect(report.verdict).toBe("violated")
        const ruleIds = new Set(report.violations.map((v) => v.ruleId))
        expect(ruleIds).toEqual(
          new Set([
            "missing-merge-base",
            "dry-run-merge-conflict",
            "planned-effect-fn-dropped",
            "unimplemented-stub-remaining",
          ]),
        )
        expect(report.conflictCount).toBe(1)
      }),
  )

  it.effect.prop(
    "REQ-3.1 property: mixed-type diffChanges and conflicts produce exact violation ruleId sets",
    {
      rawChanges: Schema.Array(OmnigraphDiffChangeSummary),
      typeKinds: Schema.Array(Schema.Literals(["EffectFn", "ServiceTag", "SchemaDef"])),
      conflictCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      remainingStubCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      missingMergeBase: Schema.Boolean,
    },
    ({ rawChanges, typeKinds, conflictCount, remainingStubCount, missingMergeBase }) =>
      Effect.gen(function* () {
        const diffChanges: Array<OmnigraphDiffChangeSummary> = rawChanges.map((ch, idx) => ({
          ...ch,
          typeName: OmnigraphTypeName.make(typeKinds[idx % Math.max(1, typeKinds.length)] ?? "EffectFn"),
        }))

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

        const report = yield* decideOmnigraphBranchVerify({
          planBranch: OmnigraphBranchName.make("plan/prop"),
          implBranch: OmnigraphBranchName.make("impl/prop"),
          mainBranch: OmnigraphBranchName.make("main"),
          diffChanges,
          dryRunConflicts,
          implEffectFnCount: NonNegativeCount.make(1),
          remainingStubCount: NonNegativeCount.make(remainingStubCount),
          missingMergeBase,
        })

        const activeSpanNames = new Set(
          diffChanges
            .filter(
              (ch) =>
                String(ch.typeName) === "EffectFn" &&
                ch.op !== "delete" &&
                ch.spanName !== undefined,
            )
            .map((ch) => ch.spanName),
        )

        const expectedRules = new Set<string>()
        if (missingMergeBase) expectedRules.add("missing-merge-base")
        if (conflictCount > 0) expectedRules.add("dry-run-merge-conflict")
        for (const ch of diffChanges) {
          if (String(ch.typeName) === "EffectFn") {
            if (ch.op === "delete") {
              if (ch.spanName === undefined || !activeSpanNames.has(ch.spanName)) {
                expectedRules.add("planned-effect-fn-dropped")
              }
            } else if (ch.stubAfter) {
              expectedRules.add("unimplemented-stub-remaining")
            }
          }
        }
        if (remainingStubCount > 0) expectedRules.add("unimplemented-stub-remaining")

        const actualRules = new Set(report.violations.map((v) => v.ruleId))
        expect(actualRules).toEqual(expectedRules)
        expect(report.verdict).toBe(expectedRules.size > 0 ? "violated" : "clean")
        expect(report.verifiedChangeCount).toBe(diffChanges.length)
        expect(report.conflictCount).toBe(conflictCount)
      }),
  )

  it.effect(
    "REQ-7.2: decideOmnigraphSchemaEvolution emits LiveClusterApply, RequiresCleanRebuild, or NoOp with span",
    () =>
      Effect.gen(function* () {
        const { result: initAction, spans } = yield* runWithTestTracer(
          "OmnigraphSchemaEvolution.decide::init",
          decideOmnigraphSchemaEvolution({
            clusterExists: false,
            queriesChanged: false,
            schemaAdditiveChanged: false,
            policyBundleOrEdgeKeyChanged: false,
            serverAlive: false,
          }),
          emptyFnIndex,
        )
        expect(initAction).toEqual({ _tag: "LiveClusterApply", requiresUnlock: true })
        expect(spans.some((s) => s.name === "OmnigraphSchemaEvolution.decide")).toBe(true)

        const rebuildAction = yield* decideOmnigraphSchemaEvolution({
          clusterExists: true,
          queriesChanged: true,
          schemaAdditiveChanged: true,
          policyBundleOrEdgeKeyChanged: true,
          serverAlive: true,
        })
        expect(rebuildAction._tag).toBe("RequiresCleanRebuild")

        const noopAction = yield* decideOmnigraphSchemaEvolution({
          clusterExists: true,
          queriesChanged: false,
          schemaAdditiveChanged: false,
          policyBundleOrEdgeKeyChanged: false,
          serverAlive: true,
        })
        expect(noopAction).toEqual({ _tag: "NoOp" })
      }),
  )

  it.effect.prop(
    "REQ-7.2 property: schema evolution decision is total and deterministic",
    {
      input: OmnigraphSchemaEvolutionInput,
    },
    ({ input }) =>
      Effect.gen(function* () {
        const action = yield* decideOmnigraphSchemaEvolution(input)

        if (!input.clusterExists) {
          expect(action).toEqual({ _tag: "LiveClusterApply", requiresUnlock: true })
          expect(Object.keys(action).sort()).toEqual(["_tag", "requiresUnlock"])
        } else if (input.policyBundleOrEdgeKeyChanged) {
          expect(action).toEqual({
            _tag: "RequiresCleanRebuild",
            reason: ErrorReasonMessage.make(
              "Applied policy bundle edits or edge @key changes cannot be applied in-place (Omnigraph deployment_scope / edge-key rule); rebuild cluster from workspace extract.",
            ),
          })
          expect(Object.keys(action).sort()).toEqual(["_tag", "reason"])
        } else if (input.schemaAdditiveChanged || input.queriesChanged) {
          expect(action).toEqual({ _tag: "LiveClusterApply", requiresUnlock: !input.serverAlive })
          expect(Object.keys(action).sort()).toEqual(["_tag", "requiresUnlock"])
        } else {
          expect(action).toEqual({ _tag: "NoOp" })
          expect(Object.keys(action)).toEqual(["_tag"])
        }
      }),
  )

  it.effect(
    "REQ-7.1: decideOmnigraphLint returns clean on ok/warning-only input and fails closed with OmnigraphLintError on blocking diagnostics",
    () =>
      Effect.gen(function* () {
        const cleanInput: OmnigraphLintInput = {
          statusOk: true,
          errorCount: NonNegativeCount.make(0),
          warningCount: NonNegativeCount.make(1),
          queriesProcessed: NonNegativeCount.make(14),
          diagnostics: [
            {
              code: OmnigraphDiagnosticCode.make("GQ-W01"),
              message: ErrorReasonMessage.make("Unused index hint"),
              targetName: null,
              severity: "warning",
            },
          ],
        }

        const { result: cleanReport, spans } = yield* runWithTestTracer(
          "OmnigraphLint.decide::clean-with-warning",
          decideOmnigraphLint(cleanInput),
          emptyFnIndex,
        )
        expect(cleanReport.verdict).toBe("clean")
        expect(cleanReport.violations).toHaveLength(0)
        expect(cleanReport.queriesProcessed).toBe(14)
        expect(spans.some((s) => s.name === "OmnigraphLint.decide")).toBe(true)

        const errorDiagEvenWithZeroCountExit = yield* Effect.exit(
          decideOmnigraphLint({
            statusOk: true,
            errorCount: NonNegativeCount.make(0),
            warningCount: NonNegativeCount.make(0),
            queriesProcessed: NonNegativeCount.make(14),
            diagnostics: [
              {
                code: OmnigraphDiagnosticCode.make("GQ-T37"),
                message: ErrorReasonMessage.make("rrf cannot be projected"),
                targetName: OmnigraphTargetName.make("rank_patterns_hybrid"),
                severity: "error",
              },
            ],
          }),
        )

        const exitOk = Exit.match(errorDiagEvenWithZeroCountExit, {
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
    "REQ-7.1 property: severity, denyWarnings, and failOnError govern blocking violations and OmnigraphLintError",
    {
      statusOk: Schema.Boolean,
      diagnostics: Schema.Array(OmnigraphLintDiagnostic),
      errorCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      failOnError: Schema.UndefinedOr(Schema.Boolean),
      denyWarnings: Schema.Boolean,
      queriesProcessed: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    },
    ({ statusOk, diagnostics, errorCount, failOnError, denyWarnings, queriesProcessed }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decideOmnigraphLint({
            statusOk,
            errorCount: NonNegativeCount.make(errorCount),
            warningCount: NonNegativeCount.make(0),
            queriesProcessed: NonNegativeCount.make(queriesProcessed),
            diagnostics,
            ...(failOnError !== undefined ? { failOnError } : {}),
            denyWarnings,
          }),
        )

        const blockingCount = diagnostics.filter((d) => {
          const sev = d.severity ?? "error"
          return sev === "error" || (sev === "warning" && denyWarnings)
        }).length
        const hasBlockingErrors = errorCount > 0 || blockingCount > 0 || !statusOk
        const shouldFail = (failOnError ?? true) && hasBlockingErrors
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
            report.queriesProcessed === queriesProcessed,
        })
        expect(Exit.isFailure(exit)).toBe(shouldFail)
        expect(checkResult).toBe(true)
      }),
  )
})
