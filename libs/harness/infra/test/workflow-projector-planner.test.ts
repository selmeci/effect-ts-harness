import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AttemptNumber,
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  MaxConcurrency,
  NxProjectName,
  OmnigraphBranchName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanJsonPayload,
  PlanSha256,
  RejectionJsonPayload,
  RunnerId,
  SliceBranchName,
  StubSymbolKey,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowTimestampMs,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { OmnigraphClient } from "@harness/graph"
import {
  type ExistingProjectedAttempt,
  type ExistingProjectedEdge,
  type ExistingProjectedRun,
  type ExistingProjectedUnit,
  type WorkflowProjectionPlan,
  type WorkflowProjectionTargetState,
  extractPackageDirPrefix,
  planWorkflowProjection,
  relPathsOverlap,
} from "../src/workflow/workflow-projector-planner.js"
import {
  WorkflowProjectorCallError,
  readTargetStateSnapshot,
} from "../src/workflow/workflow-projector-query.js"

const encodeCompiledPlan = Schema.encodeSync(Schema.fromJsonString(CompiledPlan))
const encodeRejection = Schema.encodeSync(Schema.fromJsonString(UnitRejection))

const BASE_SHA = GitCommitSha.make("a".repeat(40))
const PLAN_SHA = PlanSha256.make("b".repeat(64))
const STAMP_HASH = PackageStampHash.make("c".repeat(64))
const RUN_ID = WorkflowRunId.make("run-proj-planner-1")
const OTHER_RUN_ID = WorkflowRunId.make("run-proj-other-2")
const EXEC_ID = WorkflowExecutionId.make("exec-proj-planner-1")
const NOW_MS = WorkflowTimestampMs.make(1_700_000_000_000)

const emptyTargetState = (): WorkflowProjectionTargetState => ({
  existingRun: undefined,
  existingUnits: [],
  existingAttempts: [],
  existingEdges: [],
  effectFns: [],
  earsSpecs: [],
  traceabilityTuples: [],
  vitestCases: [],
})

const makeBaselineFixture = (
  unitName: string,
  ownedPath: string,
  state: ExistingProjectedRun["state"] = "completed",
) => {
  const unitId = WorkUnitId.make(unitName)
  const unitKey = makeWorkflowUnitKey(RUN_ID, unitId)
  const attemptKey = makeWorkflowAttemptKey(RUN_ID, unitId, AttemptNumber.make(1))
  const source = {
    run: {
      runId: RUN_ID,
      executionId: EXEC_ID,
      level: "slice" as const,
      planSha: PLAN_SHA,
      baseSha: BASE_SHA,
      state,
      updatedMs: NOW_MS,
    },
    units: [
      {
        unitKey,
        runId: RUN_ID,
        unitId,
        kind: "package" as const,
        waveIndex: WaveIndex.make(0),
        status: "completed" as const,
        ownedRelPaths: [OwnedRelPath.make(ownedPath)],
        updatedMs: NOW_MS,
      },
    ],
    attempts: [
      {
        attemptKey,
        runId: RUN_ID,
        unitId,
        attempt: AttemptNumber.make(1),
        verdict: "completed" as const,
        runner: RunnerId.make("claude-code"),
        packageStampHash: STAMP_HASH,
        updatedMs: NOW_MS,
      },
    ],
  }
  const existingRun: ExistingProjectedRun = {
    runId: RUN_ID,
    level: "slice",
    planSha: PLAN_SHA,
    baseSha: BASE_SHA,
    state,
  }
  const existingUnit: ExistingProjectedUnit = {
    unitKey,
    runId: RUN_ID,
    unitId,
    kind: "package",
    waveIndex: WaveIndex.make(0),
    status: "completed",
    ownedRelPaths: [OwnedRelPath.make(ownedPath)],
  }
  const existingAttempt: ExistingProjectedAttempt = {
    attemptKey,
    attempt: AttemptNumber.make(1),
    verdict: "completed",
    runner: RunnerId.make("claude-code"),
    rejection: null,
    packageStampHash: STAMP_HASH,
  }
  const existingEdges: ReadonlyArray<ExistingProjectedEdge> = [
    {
      edgeType: "PlaysRunUnitRole",
      from: RUN_ID,
      to: unitKey,
      role: "run-unit",
      archimateRelation: "Composition",
    },
    {
      edgeType: "PlaysUnitAttemptRole",
      from: unitKey,
      to: attemptKey,
      role: "unit-attempt",
      archimateRelation: "Composition",
    },
  ]
  return {
    unitId,
    unitKey,
    attemptKey,
    source,
    existingRun,
    existingUnit,
    existingAttempt,
    existingEdges,
  }
}

const makeSamplePlan = (): CompiledPlan => ({
  runId: RUN_ID,
  level: "slice",
  planSha: PLAN_SHA,
  baseSha: BASE_SHA,
  mode: {
    _tag: "Automatic",
    runner: RunnerId.make("claude-code"),
    maxConcurrency: MaxConcurrency.make(2),
  },
  units: [
    {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make("unit-alpha"),
      projectName: NxProjectName.make("@harness/alpha"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
      stubKeys: [
        StubSymbolKey.make("libs/alpha/src/index.ts#alphaRun"),
        StubSymbolKey.make("Alpha.helper"),
      ],
      earsKeys: [
        EarsRequirementKey.make("harness:SPEC-0001::REQ-1.1"),
        EarsRequirementKey.make("harness:SPEC-0002"),
      ],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    },
    {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make("unit-beta"),
      projectName: NxProjectName.make("@harness/beta"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/beta/src")],
      stubKeys: [],
      earsKeys: [],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/beta:verify"),
    },
  ],
  sharedStepPaths: [],
})

const makeFullInsertFixture = (rejection: UnitRejection) => {
  const plan = makeSamplePlan()
  const unitAlphaKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-alpha"))
  const unitBetaKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-beta"))
  const attempt1Key = makeWorkflowAttemptKey(
    RUN_ID,
    WorkUnitId.make("unit-alpha"),
    AttemptNumber.make(1),
  )
  const attempt2Key = makeWorkflowAttemptKey(
    RUN_ID,
    WorkUnitId.make("unit-alpha"),
    AttemptNumber.make(2),
  )
  const attempt3Key = makeWorkflowAttemptKey(
    RUN_ID,
    WorkUnitId.make("unit-beta"),
    AttemptNumber.make(1),
  )
  const orphanAttemptKey = makeWorkflowAttemptKey(
    RUN_ID,
    WorkUnitId.make("missing-unit"),
    AttemptNumber.make(1),
  )

  const source = {
    run: {
      runId: RUN_ID,
      executionId: EXEC_ID,
      level: "slice" as const,
      planSha: PLAN_SHA,
      baseSha: BASE_SHA,
      state: "running" as const,
      planJson: PlanJsonPayload.make(encodeCompiledPlan(plan)),
      updatedMs: NOW_MS,
    },
    units: [
      {
        unitKey: unitAlphaKey,
        runId: RUN_ID,
        unitId: WorkUnitId.make("unit-alpha"),
        kind: "package" as const,
        waveIndex: WaveIndex.make(0),
        status: "completed" as const,
        ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
        updatedMs: NOW_MS,
      },
      {
        unitKey: unitBetaKey,
        runId: RUN_ID,
        unitId: WorkUnitId.make("unit-beta"),
        kind: "package" as const,
        waveIndex: WaveIndex.make(0),
        status: "dispatched" as const,
        ownedRelPaths: [OwnedRelPath.make("libs/beta/src")],
        updatedMs: NOW_MS,
      },
      {
        unitKey: makeWorkflowUnitKey(OTHER_RUN_ID, WorkUnitId.make("unit-other")),
        runId: OTHER_RUN_ID,
        unitId: WorkUnitId.make("unit-other"),
        kind: "package" as const,
        waveIndex: WaveIndex.make(0),
        status: "pending" as const,
        ownedRelPaths: [OwnedRelPath.make("libs/other/src")],
        updatedMs: NOW_MS,
      },
    ],
    attempts: [
      {
        attemptKey: attempt1Key,
        runId: RUN_ID,
        unitId: WorkUnitId.make("unit-alpha"),
        attempt: AttemptNumber.make(1),
        verdict: "rejected" as const,
        runner: RunnerId.make("claude-code"),
        rejection,
        updatedMs: NOW_MS,
      },
      {
        attemptKey: attempt2Key,
        runId: RUN_ID,
        unitId: WorkUnitId.make("unit-alpha"),
        attempt: AttemptNumber.make(2),
        verdict: "completed" as const,
        packageStampHash: STAMP_HASH,
        updatedMs: NOW_MS,
      },
      {
        attemptKey: attempt3Key,
        runId: RUN_ID,
        unitId: WorkUnitId.make("unit-beta"),
        attempt: AttemptNumber.make(1),
        verdict: "dispatched" as const,
        updatedMs: NOW_MS,
      },
      {
        attemptKey: orphanAttemptKey,
        runId: RUN_ID,
        unitId: WorkUnitId.make("missing-unit"),
        attempt: AttemptNumber.make(1),
        verdict: "dispatched" as const,
        updatedMs: NOW_MS,
      },
    ],
  }

  const targetState: WorkflowProjectionTargetState = {
    ...emptyTargetState(),
    effectFns: [
      {
        qualname: "libs/alpha/src/index.ts#alphaRun",
        spanName: "Alpha.run",
        file: "libs/alpha/src/index.ts",
        isStub: false,
        exercisingTestIds: [
          "libs/external/test/e2e.test.ts::exercises alpha",
          "libs/missing/test/dangling.test.ts::missing",
        ],
      },
      {
        qualname: "libs/shared/src/helper.ts#alphaHelper",
        spanName: "Alpha.helper",
        file: "libs/shared/src/helper.ts",
        isStub: false,
      },
      {
        qualname: "libs/beta/src/index.ts#betaStub",
        spanName: "Beta.stub",
        file: "libs/beta/src/index.ts",
        isStub: true,
      },
      {
        qualname: "libs/beta/src/index.ts#betaImpl",
        spanName: "Beta.impl",
        file: "libs/beta/src/index.ts",
        isStub: false,
      },
    ],
    earsSpecs: [
      { id: "harness:SPEC-0001", enforcedByFiles: [] },
      { id: "harness:SPEC-00010", enforcedByFiles: [] },
      { id: "harness:SPEC-0002", enforcedByFiles: [] },
      { id: "harness:SPEC-0003", enforcedByFiles: ["libs/beta/src/index.ts"] },
    ],
    traceabilityTuples: [
      {
        relationId: "tt-spec-1",
        earsSpecId: "harness:SPEC-0001",
        targetSymbolQualname: "libs/unrelated.ts#x",
      },
      {
        relationId: "tt-fn-alpha",
        earsSpecId: null,
        targetSymbolQualname: "libs/shared/src/helper.ts#alphaHelper",
      },
      {
        relationId: "tt-spec-3",
        earsSpecId: "harness:SPEC-0003",
        targetSymbolQualname: "libs/unrelated.ts#y",
      },
      {
        relationId: "tt-unrelated",
        earsSpecId: "harness:SPEC-9999",
        targetSymbolQualname: "libs/unrelated.ts#z",
      },
    ],
    vitestCases: [
      {
        testId: "libs/alpha/test/alpha.test.ts::alpha unit",
        testFile: "libs/alpha/test/alpha.test.ts",
      },
      {
        testId: "libs/external/test/e2e.test.ts::exercises alpha",
        testFile: "libs/external/test/e2e.test.ts",
      },
      {
        testId: "libs/beta/src/beta.test.ts::beta inline",
        testFile: "libs/beta/src/beta.test.ts",
      },
      {
        testId: "libs/gamma/test/gamma.test.ts::gamma",
        testFile: "libs/gamma/test/gamma.test.ts",
      },
    ],
  }

  return { source, targetState }
}

describe("workflow-projector-planner (pure)", () => {
  it("relPathsOverlap enforces exact, NFC/case-folded, ./ normalized, and segment-boundary containment", () => {
    expect(relPathsOverlap("./libs/Alpha/src/index.ts", "libs/alpha/src/index.ts")).toBe(true)
    expect(relPathsOverlap("libs/alpha", "libs/alpha/src/index.ts")).toBe(true)
    expect(relPathsOverlap("libs/alpha/src/index.ts", "libs/alpha")).toBe(true)
    expect(relPathsOverlap("libs/alpha", "libs/alpha-two/src/index.ts")).toBe(false)
    expect(relPathsOverlap("", "libs/alpha")).toBe(false)
    expect(relPathsOverlap("libs/alpha", "   ")).toBe(false)
  })

  it("extractPackageDirPrefix resolves 2-segment and 3-segment package roots without matching top-level roots", () => {
    expect(extractPackageDirPrefix("./libs/alpha/src/index.ts")).toBe("libs/alpha")
    expect(extractPackageDirPrefix("libs/harness/infra/test/projector.test.ts")).toBe(
      "libs/harness/infra",
    )
    expect(extractPackageDirPrefix("libs/harness/infra/tests/a.test.ts")).toBe("libs/harness/infra")
    expect(extractPackageDirPrefix("libs/harness/infra/__tests__/a.test.ts")).toBe(
      "libs/harness/infra",
    )
    expect(extractPackageDirPrefix("libs/alpha/package.json")).toBe("libs/alpha")
    expect(extractPackageDirPrefix("libs/alpha")).toBe("libs/alpha")
    expect(extractPackageDirPrefix("libs/foo.ts")).toBeUndefined()
    expect(extractPackageDirPrefix("src/index.ts")).toBeUndefined()
    expect(extractPackageDirPrefix("README.md")).toBeUndefined()
    expect(extractPackageDirPrefix("")).toBeUndefined()
  })

  it("plans full insert of WorkflowRun, WorkUnit, UnitAttempt, and all 6 non-dangling Plays*Role edges with parameterized GQ 2.1", () => {
    const rejection: UnitRejection = { _tag: "StampMissing" }
    const { source, targetState } = makeFullInsertFixture(rejection)
    const result = planWorkflowProjection(source, targetState)

    match(result)
      .with({ _tag: "Mutate" }, (mut) => {
        expect(mut.counts.runsUpserted).toBe(1)
        expect(mut.counts.unitsUpserted).toBe(2)
        expect(mut.counts.attemptsUpserted).toBe(4)
        // unit-alpha has an exercisingTestId so sibling alpha.test.ts is NOT linked (17 vs 19)
        expect(mut.counts.edgesUpserted).toBe(17)

        expect(mut.query).toContain("query project_workflow_run(")
        expect(mut.query).toContain("insert WorkflowRun")
        expect(mut.query).toContain("insert WorkUnit")
        expect(mut.query).toContain("insert UnitAttempt")
        expect(mut.query).toContain("insert PlaysRunUnitRole")
        expect(mut.query).toContain("insert PlaysUnitAttemptRole")
        expect(mut.query).toContain("insert PlaysUnitStubRole")
        expect(mut.query).toContain("insert PlaysUnitEarsRole")
        expect(mut.query).toContain("insert PlaysUnitTraceabilityRole")
        expect(mut.query).toContain("insert PlaysAttemptTestRole")
        expect(mut.query).toContain(": String?")
        expect(mut.query).toContain(": I32")
        expect(mut.query).toContain(": [String]")
        expect(mut.query).not.toContain(RUN_ID)
        expect(mut.query).not.toContain(PLAN_SHA)
        expect(mut.query).not.toContain("libs/missing/test/dangling.test.ts::missing")
        expect(Object.values(mut.params)).toContain(encodeRejection(rejection))
        expect(Object.values(mut.params)).toContain(null)
        expect(Object.values(mut.params)).not.toContain("libs/alpha/test/alpha.test.ts::alpha unit")
      })
      .with({ _tag: "NoOp" }, { _tag: "InvalidPlanJson" }, () =>
        expect.unreachable("expected Mutate plan"),
      )
      .exhaustive()
  })

  it("handles SliceUnit planJson, missing planJson, and fails closed with InvalidPlanJson on corrupt planJson", () => {
    const slicePlan: CompiledPlan = {
      runId: RUN_ID,
      level: "epic",
      planSha: PLAN_SHA,
      baseSha: BASE_SHA,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId: WorkUnitId.make("slice-alpha"),
          branch: SliceBranchName.make("slice/wf6-alpha"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          earsKeys: [EarsRequirementKey.make("harness:SPEC-0038::REQ-1.1")],
        },
      ],
      sharedStepPaths: [],
    }
    const unitKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("slice-alpha"))
    const baseUnit = {
      unitKey,
      runId: RUN_ID,
      unitId: WorkUnitId.make("slice-alpha"),
      kind: "slice" as const,
      waveIndex: WaveIndex.make(0),
      status: "pending" as const,
      ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
      updatedMs: NOW_MS,
    }

    const withSlicePlan = planWorkflowProjection(
      {
        run: {
          runId: RUN_ID,
          executionId: EXEC_ID,
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "running",
          planJson: PlanJsonPayload.make(encodeCompiledPlan(slicePlan)),
          updatedMs: NOW_MS,
        },
        units: [baseUnit],
        attempts: [],
      },
      {
        ...emptyTargetState(),
        earsSpecs: [{ id: "harness:SPEC-0038", enforcedByFiles: [] }],
      },
    )
    match(withSlicePlan)
      .with({ _tag: "Mutate" }, (mut) => {
        expect(mut.counts.edgesUpserted).toBe(2) // PlaysRunUnitRole + PlaysUnitEarsRole
      })
      .with({ _tag: "NoOp" }, { _tag: "InvalidPlanJson" }, () =>
        expect.unreachable("expected Mutate for valid SliceUnit planJson"),
      )
      .exhaustive()

    const withMissingPlan = planWorkflowProjection(
      {
        run: {
          runId: RUN_ID,
          executionId: EXEC_ID,
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "running",
          updatedMs: NOW_MS,
        },
        units: [baseUnit],
        attempts: [],
      },
      {
        ...emptyTargetState(),
        earsSpecs: [{ id: "harness:SPEC-0038", enforcedByFiles: [] }],
      },
    )
    match(withMissingPlan)
      .with({ _tag: "Mutate" }, (mut) => {
        expect(mut.counts.edgesUpserted).toBe(1) // Only PlaysRunUnitRole
      })
      .with({ _tag: "NoOp" }, { _tag: "InvalidPlanJson" }, () =>
        expect.unreachable("expected Mutate when planJson is omitted"),
      )
      .exhaustive()

    const withCorruptPlan = planWorkflowProjection(
      {
        run: {
          runId: RUN_ID,
          executionId: EXEC_ID,
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "running",
          planJson: PlanJsonPayload.make("{not valid compiled plan"),
          updatedMs: NOW_MS,
        },
        units: [baseUnit],
        attempts: [],
      },
      {
        ...emptyTargetState(),
        earsSpecs: [{ id: "harness:SPEC-0038", enforcedByFiles: [] }],
      },
    )
    match(withCorruptPlan)
      .with({ _tag: "InvalidPlanJson" }, ({ reason }) => {
        expect(reason.length).toBeGreaterThan(0)
        expect(reason).toContain("CompiledPlan")
      })
      .with({ _tag: "NoOp" }, { _tag: "Mutate" }, () =>
        expect.unreachable("expected InvalidPlanJson for corrupt planJson"),
      )
      .exhaustive()
  })

  const expectMutatePlan = (plan: WorkflowProjectionPlan) =>
    match(plan)
      .with({ _tag: "Mutate" }, (mut) => mut)
      .with({ _tag: "NoOp" }, { _tag: "InvalidPlanJson" }, () =>
        expect.unreachable(`expected Mutate plan, got ${plan._tag}`),
      )
      .exhaustive()

  it("produces NoOp when existing state matches and emits targeted updates when individual fields drift", () => {
    const { source, existingRun, existingUnit, existingAttempt, existingEdges } =
      makeBaselineFixture("unit-alpha", "libs/alpha")

    const noOpPlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [existingUnit],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    match(noOpPlan)
      .with({ _tag: "NoOp" }, (noOp) => {
        expect(noOp).toEqual({
          _tag: "NoOp",
          counts: {
            runsUpserted: 0,
            unitsUpserted: 0,
            attemptsUpserted: 0,
            edgesUpserted: 0,
          },
        })
      })
      .with({ _tag: "Mutate" }, { _tag: "InvalidPlanJson" }, () =>
        expect.unreachable("expected NoOp"),
      )
      .exhaustive()

    // Drift on run.state only
    const runUpdatePlan = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun: { ...existingRun, state: "running" },
        existingUnits: [existingUnit],
        existingAttempts: [existingAttempt],
        existingEdges,
      }),
    )
    expect(runUpdatePlan.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 0,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
    expect(runUpdatePlan.query).toContain("update WorkflowRun set")
    expect(runUpdatePlan.query).not.toContain("insert WorkflowRun")

    // Drift on unit.ownedRelPaths (same length, different value)
    const unitUpdatePlan = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun,
        existingUnits: [{ ...existingUnit, ownedRelPaths: [OwnedRelPath.make("libs/beta")] }],
        existingAttempts: [existingAttempt],
        existingEdges,
      }),
    )
    expect(unitUpdatePlan.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 1,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
    expect(unitUpdatePlan.query).toContain("update WorkUnit set")

    // Drift on attempt.packageStampHash
    const attemptUpdatePlan = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun,
        existingUnits: [existingUnit],
        existingAttempts: [{ ...existingAttempt, packageStampHash: null }],
        existingEdges,
      }),
    )
    expect(attemptUpdatePlan.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 0,
      attemptsUpserted: 1,
      edgesUpserted: 0,
    })
    expect(attemptUpdatePlan.query).toContain("update UnitAttempt set")

    // Drift on run.level, unit.waveIndex, attempt.runner, and partial missing edge
    const multiDriftPlan = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun: { ...existingRun, level: "epic" },
        existingUnits: [{ ...existingUnit, waveIndex: WaveIndex.make(1) }],
        existingAttempts: [{ ...existingAttempt, runner: null }],
        existingEdges: [existingEdges[0]!],
      }),
    )
    expect(multiDriftPlan.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 1,
      attemptsUpserted: 1,
      edgesUpserted: 1,
    })
  })

  it("emits targeted updates when unit.status, attempt.verdict/rejection, or run SHAs drift in isolation", () => {
    const { source, existingRun, existingUnit, existingAttempt, existingEdges } =
      makeBaselineFixture("unit-alpha", "libs/alpha")

    const unitStatusDrift = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun,
        existingUnits: [{ ...existingUnit, status: "dispatched" }],
        existingAttempts: [existingAttempt],
        existingEdges,
      }),
    )
    expect(unitStatusDrift.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 1,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })

    const attemptVerdictDrift = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun,
        existingUnits: [existingUnit],
        existingAttempts: [
          {
            ...existingAttempt,
            verdict: "rejected",
            rejection: RejectionJsonPayload.make(encodeRejection({ _tag: "StampMissing" })),
          },
        ],
        existingEdges,
      }),
    )
    expect(attemptVerdictDrift.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 0,
      attemptsUpserted: 1,
      edgesUpserted: 0,
    })

    const runShaDrift = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun: {
          ...existingRun,
          planSha: PlanSha256.make("f".repeat(64)),
          baseSha: GitCommitSha.make("e".repeat(40)),
        },
        existingUnits: [existingUnit],
        existingAttempts: [existingAttempt],
        existingEdges,
      }),
    )
    expect(runShaDrift.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 0,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
  })

  it("preserves stale or extra existing edges untouched during upsert-only wave projection", () => {
    const {
      unitKey,
      attemptKey,
      source,
      existingRun,
      existingUnit,
      existingAttempt,
      existingEdges,
    } = makeBaselineFixture("unit-alpha", "libs/alpha", "running")

    const staleEdges: ReadonlyArray<ExistingProjectedEdge> = [
      ...existingEdges,
      {
        edgeType: "PlaysUnitStubRole",
        from: unitKey,
        to: "libs/alpha/src/removed-stub.ts#oldStub",
        role: "unit-stub",
        archimateRelation: "Realization",
      },
      {
        edgeType: "PlaysAttemptTestRole",
        from: attemptKey,
        to: "libs/alpha/test/removed.test.ts::old test",
        role: "attempt-test",
        archimateRelation: "Association",
      },
    ]

    const planWithStaleEdges = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [existingUnit],
      existingAttempts: [existingAttempt],
      existingEdges: staleEdges,
    })

    // All desired nodes/edges already exist -> NoOp; stale extra edges are not deleted
    expect(planWithStaleEdges._tag).toBe("NoOp")

    // When a new edge IS needed alongside stale existing edges, only inserts are emitted (never delete)
    const mutateWithStaleEdges = expectMutatePlan(
      planWorkflowProjection(source, {
        ...emptyTargetState(),
        existingRun,
        existingUnits: [existingUnit],
        existingAttempts: [existingAttempt],
        existingEdges: staleEdges,
        earsSpecs: [{ id: "harness:SPEC-9001", enforcedByFiles: ["libs/alpha/src/index.ts"] }],
      }),
    )
    expect(mutateWithStaleEdges.query).not.toMatch(/\bdelete\b/i)
    expect(mutateWithStaleEdges.counts.edgesUpserted).toBe(1)
  })

  it("links exercisingTestIds and directly owned relPathsOverlap tests first, using sharesPackageDirPrefix only as fallback", () => {
    const unitExercisedId = WorkUnitId.make("unit-exercised")
    const unitDirectId = WorkUnitId.make("unit-direct")
    const unitFallbackId = WorkUnitId.make("unit-fallback")

    const attemptExercised = makeWorkflowAttemptKey(RUN_ID, unitExercisedId, AttemptNumber.make(1))
    const attemptDirect = makeWorkflowAttemptKey(RUN_ID, unitDirectId, AttemptNumber.make(1))
    const attemptFallback = makeWorkflowAttemptKey(RUN_ID, unitFallbackId, AttemptNumber.make(1))

    const plan: CompiledPlan = {
      runId: RUN_ID,
      level: "slice",
      planSha: PLAN_SHA,
      baseSha: BASE_SHA,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId: unitExercisedId,
          projectName: NxProjectName.make("@harness/alpha"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha/src/feature.ts")],
          stubKeys: [StubSymbolKey.make("libs/alpha/src/feature.ts#runFeature")],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
        },
        {
          _tag: "PackageUnit",
          unitId: unitDirectId,
          projectName: NxProjectName.make("@harness/beta"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/beta/src")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/beta:verify"),
        },
        {
          _tag: "PackageUnit",
          unitId: unitFallbackId,
          projectName: NxProjectName.make("@harness/gamma"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/gamma/src")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/gamma:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    const result = expectMutatePlan(
      planWorkflowProjection(
        {
          run: {
            runId: RUN_ID,
            executionId: EXEC_ID,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "running",
            planJson: PlanJsonPayload.make(encodeCompiledPlan(plan)),
            updatedMs: NOW_MS,
          },
          units: [
            {
              unitKey: makeWorkflowUnitKey(RUN_ID, unitExercisedId),
              runId: RUN_ID,
              unitId: unitExercisedId,
              kind: "package",
              waveIndex: WaveIndex.make(0),
              status: "completed",
              ownedRelPaths: [OwnedRelPath.make("libs/alpha/src/feature.ts")],
              updatedMs: NOW_MS,
            },
            {
              unitKey: makeWorkflowUnitKey(RUN_ID, unitDirectId),
              runId: RUN_ID,
              unitId: unitDirectId,
              kind: "package",
              waveIndex: WaveIndex.make(0),
              status: "completed",
              ownedRelPaths: [OwnedRelPath.make("libs/beta/src")],
              updatedMs: NOW_MS,
            },
            {
              unitKey: makeWorkflowUnitKey(RUN_ID, unitFallbackId),
              runId: RUN_ID,
              unitId: unitFallbackId,
              kind: "package",
              waveIndex: WaveIndex.make(0),
              status: "completed",
              ownedRelPaths: [OwnedRelPath.make("libs/gamma/src")],
              updatedMs: NOW_MS,
            },
          ],
          attempts: [
            {
              attemptKey: attemptExercised,
              runId: RUN_ID,
              unitId: unitExercisedId,
              attempt: AttemptNumber.make(1),
              verdict: "completed",
              updatedMs: NOW_MS,
            },
            {
              attemptKey: attemptDirect,
              runId: RUN_ID,
              unitId: unitDirectId,
              attempt: AttemptNumber.make(1),
              verdict: "completed",
              updatedMs: NOW_MS,
            },
            {
              attemptKey: attemptFallback,
              runId: RUN_ID,
              unitId: unitFallbackId,
              attempt: AttemptNumber.make(1),
              verdict: "completed",
              updatedMs: NOW_MS,
            },
          ],
        },
        {
          ...emptyTargetState(),
          effectFns: [
            {
              qualname: "libs/alpha/src/feature.ts#runFeature",
              spanName: "Alpha.runFeature",
              file: "libs/alpha/src/feature.ts",
              isStub: false,
              exercisingTestIds: ["libs/alpha/test/feature.test.ts::exercised"],
            },
          ],
          vitestCases: [
            {
              testId: "libs/alpha/test/feature.test.ts::exercised",
              testFile: "libs/alpha/test/feature.test.ts",
            },
            {
              testId: "libs/alpha/test/unrelated-sibling.test.ts::sibling",
              testFile: "libs/alpha/test/unrelated-sibling.test.ts",
            },
            {
              testId: "libs/beta/src/inline.test.ts::direct",
              testFile: "libs/beta/src/inline.test.ts",
            },
            {
              testId: "libs/beta/test/unrelated-sibling.test.ts::sibling",
              testFile: "libs/beta/test/unrelated-sibling.test.ts",
            },
            {
              testId: "libs/gamma/test/fallback.test.ts::fallback",
              testFile: "libs/gamma/test/fallback.test.ts",
            },
          ],
        },
      ),
    )

    const paramValues = Object.values(result.params)
    // Exercised & direct matches included; unrelated siblings in same package excluded; fallback included
    expect(paramValues).toContain("libs/alpha/test/feature.test.ts::exercised")
    expect(paramValues).not.toContain("libs/alpha/test/unrelated-sibling.test.ts::sibling")
    expect(paramValues).toContain("libs/beta/src/inline.test.ts::direct")
    expect(paramValues).not.toContain("libs/beta/test/unrelated-sibling.test.ts::sibling")
    expect(paramValues).toContain("libs/gamma/test/fallback.test.ts::fallback")
    // Edges: 3 RunUnit + 1 UnitStub + 3 UnitAttempt + 3 AttemptTest = 10
    expect(result.counts.edgesUpserted).toBe(10)
  })

  it("property: relPathsOverlap is reflexive, symmetric, case-insensitive, and boundary-safe including sibling prefixes", () => {
    const Seg = Schema.Literals(["libs", "apps", "alpha", "Alpha", "beta", "src", "index.ts"])
    const Pair = Schema.Struct({
      a: Schema.Tuple([Seg, Seg, Seg]),
      b: Schema.Tuple([Seg, Seg]),
      leadingDotSlash: Schema.Boolean,
    })
    const arb = Arbitrary.schema(Pair)
    const check = Effect.runSync(
      Arbitrary.checkEffect(
        arb,
        ({ a, b, leadingDotSlash }) => {
          const left = `${leadingDotSlash ? "./" : ""}${a.join("/")}`
          const right = b.join("/")
          const prefix = b.join("/")
          const selfMatch = relPathsOverlap(left, left)
          const sym = relPathsOverlap(left, right) === relPathsOverlap(right, left)
          const caseSym =
            relPathsOverlap(left.toUpperCase(), right.toLowerCase()) ===
            relPathsOverlap(left.toLowerCase(), right.toLowerCase())
          const siblingCollisionFree =
            relPathsOverlap(prefix, `${prefix}2`) === false &&
            relPathsOverlap(`${prefix}2`, prefix) === false &&
            relPathsOverlap(prefix, `${prefix}-two/src/index.ts`) === false
          return selfMatch && sym && caseSym && siblingCollisionFree
        },
        { runs: 60, seed: 3802 },
      ),
    )
    expect(check._tag).toBe("Passed")
  })

  const PropProjectionInput = Schema.Struct({
    runState: Schema.Literals(["running", "waiting", "completed", "aborted"]),
    unitStatus: Schema.Literals(["pending", "dispatched", "completed", "escalated"]),
    verdict: Schema.Literals(["dispatched", "completed", "rejected"]),
    hasStub: Schema.Boolean,
    hasSpec: Schema.Boolean,
  })

  it.prop(
    "property: fresh projection always emits balanced $pN declarations and converges to NoOp when existing state matches",
    [PropProjectionInput],
    ([spec]) => {
      const unitKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-prop"))
      const attemptKey = makeWorkflowAttemptKey(
        RUN_ID,
        WorkUnitId.make("unit-prop"),
        AttemptNumber.make(1),
      )
      const rejection: UnitRejection = { _tag: "StampMissing" }
      const attemptRecord = match(spec.verdict)
        .with("rejected", () => ({
          attemptKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-prop"),
          attempt: AttemptNumber.make(1),
          verdict: "rejected" as const,
          rejection,
          updatedMs: NOW_MS,
        }))
        .with("dispatched", "completed", (verdict) => ({
          attemptKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-prop"),
          attempt: AttemptNumber.make(1),
          verdict,
          updatedMs: NOW_MS,
        }))
        .exhaustive()

      const source = {
        run: {
          runId: RUN_ID,
          executionId: EXEC_ID,
          level: "slice" as const,
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: spec.runState,
          updatedMs: NOW_MS,
        },
        units: [
          {
            unitKey,
            runId: RUN_ID,
            unitId: WorkUnitId.make("unit-prop"),
            kind: "package" as const,
            waveIndex: WaveIndex.make(0),
            status: spec.unitStatus,
            ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
            updatedMs: NOW_MS,
          },
        ],
        attempts: [attemptRecord],
      }

      const targetEntities = {
        effectFns: spec.hasStub
          ? [
              {
                qualname: "libs/alpha/src/index.ts#fn",
                spanName: "Alpha.fn",
                file: "libs/alpha/src/index.ts",
                isStub: true,
              },
            ]
          : [],
        earsSpecs: spec.hasSpec
          ? [{ id: "harness:SPEC-0038", enforcedByFiles: ["libs/alpha/src/index.ts"] }]
          : [],
        traceabilityTuples: [],
        vitestCases: [],
      }

      const first = expectMutatePlan(
        planWorkflowProjection(source, {
          ...emptyTargetState(),
          ...targetEntities,
        }),
      )
      expect(first.counts.runsUpserted).toBe(1)
      expect(first.counts.unitsUpserted).toBe(1)
      expect(first.counts.attemptsUpserted).toBe(1)
      expect(first.counts.edgesUpserted).toBe(2 + (spec.hasStub ? 1 : 0) + (spec.hasSpec ? 1 : 0))

      const declaredParamCount = (first.query.match(/\$p\d+:/g) ?? []).length
      expect(declaredParamCount).toBe(Object.keys(first.params).length)

      const existingEdges: Array<ExistingProjectedEdge> = [
        {
          edgeType: "PlaysRunUnitRole",
          from: RUN_ID,
          to: unitKey,
          role: "run-unit",
          archimateRelation: "Composition",
        },
        {
          edgeType: "PlaysUnitAttemptRole",
          from: unitKey,
          to: attemptKey,
          role: "unit-attempt",
          archimateRelation: "Composition",
        },
      ]
      if (spec.hasStub) {
        existingEdges.push({
          edgeType: "PlaysUnitStubRole",
          from: unitKey,
          to: "libs/alpha/src/index.ts#fn",
          role: "unit-stub",
          archimateRelation: "Realization",
        })
      }
      if (spec.hasSpec) {
        existingEdges.push({
          edgeType: "PlaysUnitEarsRole",
          from: unitKey,
          to: "harness:SPEC-0038",
          role: "unit-ears",
          archimateRelation: "Realization",
        })
      }

      const second = planWorkflowProjection(source, {
        ...emptyTargetState(),
        ...targetEntities,
        existingRun: {
          runId: RUN_ID,
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: spec.runState,
        },
        existingUnits: [
          {
            unitKey,
            runId: RUN_ID,
            unitId: WorkUnitId.make("unit-prop"),
            kind: "package",
            waveIndex: WaveIndex.make(0),
            status: spec.unitStatus,
            ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
          },
        ],
        existingAttempts: [
          {
            attemptKey,
            attempt: AttemptNumber.make(1),
            verdict: spec.verdict,
            runner: null,
            rejection: match(spec.verdict)
              .with("rejected", () => RejectionJsonPayload.make(encodeRejection(rejection)))
              .with("dispatched", "completed", () => null)
              .exhaustive(),
            packageStampHash: null,
          },
        ],
        existingEdges,
      })
      match(second)
        .with({ _tag: "NoOp" }, (noOp) => {
          expect(noOp.counts).toEqual({
            runsUpserted: 0,
            unitsUpserted: 0,
            attemptsUpserted: 0,
            edgesUpserted: 0,
          })
        })
        .with({ _tag: "Mutate" }, { _tag: "InvalidPlanJson" }, () =>
          expect.unreachable("expected NoOp on second projection"),
        )
        .exhaustive()
    },
  )
})

describe("workflow-projector-query (readTargetStateSnapshot)", () => {
  type Omnigraph = InstanceType<typeof OmnigraphClient>
  type QueryInput = Parameters<Omnigraph["query"]>[0]
  type QueryResult = Awaited<ReturnType<Omnigraph["query"]>>

  const BRANCH = OmnigraphBranchName.make("impl/wf6-query-unit")

  type MockQueryResponse = Readonly<Record<string, unknown>> & {
    readonly rows: ReadonlyArray<unknown>
    readonly graphCommitId?: string | null
  }

  const makeMockClient = (respond: (input: QueryInput) => MockQueryResponse): Omnigraph => {
    const baseClient = new OmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      graphId: "harness",
    })
    return new Proxy(baseClient, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return async (input: QueryInput): Promise<QueryResult> => {
            const raw = respond(input)
            return {
              queryName: input.name ?? "q_mock",
              rowCount: raw.rows.length,
              target: { branch: BRANCH },
              ...raw,
            }
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  const runReadExpectError = async (
    client: Omnigraph,
    attemptKeys: ReadonlyArray<string> = [],
  ): Promise<WorkflowProjectorCallError> => {
    const exit = await Effect.runPromiseExit(
      readTargetStateSnapshot(client, BRANCH, RUN_ID, attemptKeys),
    )
    return match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        const errOpt = Cause.findErrorOption(cause)
        return match(errOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(WorkflowProjectorCallError)
            return value
          })
          .with({ _tag: "None" }, () =>
            expect.unreachable(`expected WorkflowProjectorCallError, got ${Cause.pretty(cause)}`),
          )
          .exhaustive()
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("expected readTargetStateSnapshot to fail closed"),
      )
      .exhaustive()
  }

  it("decodes valid snapshot rows and requires valid OmnigraphCommitId", async () => {
    const unitKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-alpha"))
    const attemptKey = makeWorkflowAttemptKey(
      RUN_ID,
      WorkUnitId.make("unit-alpha"),
      AttemptNumber.make(1),
    )
    const client = makeMockClient((input) => {
      if (input.query.includes("q_run(")) {
        return {
          graphCommitId: "cmt-valid-1",
          truncated: false,
          hasMore: false,
          nextCursor: null,
          rows: [
            {
              runId: RUN_ID,
              level: "slice",
              planSha: PLAN_SHA,
              baseSha: BASE_SHA,
              state: "running",
            },
          ],
        }
      }
      if (input.query.includes("q_units(")) {
        return {
          graphCommitId: "cmt-valid-1",
          rows: [
            {
              unitKey,
              runId: RUN_ID,
              unitId: "unit-alpha",
              kind: "package",
              waveIndex: "0",
              status: "completed",
              ownedRelPaths: ["libs/alpha/src"],
            },
          ],
        }
      }
      if (input.query.includes("q_attempts(")) {
        return {
          graphCommitId: "cmt-valid-1",
          rows: [
            {
              attemptKey,
              attempt: 1,
              verdict: "completed",
              runner: "claude-code",
              rejection: null,
              packageStampHash: STAMP_HASH,
            },
          ],
        }
      }
      return {
        graphCommitId: "cmt-valid-1",
        rows: [],
      }
    })

    const snap = await Effect.runPromise(
      readTargetStateSnapshot(client, BRANCH, RUN_ID, [attemptKey]),
    )
    expect(snap.graphCommitId).toBe("cmt-valid-1")
    expect(snap.targetState.existingRun?.state).toBe("running")
    expect(snap.targetState.existingUnits[0]?.waveIndex).toBe(0)
    expect(snap.targetState.existingAttempts[0]?.verdict).toBe("completed")
  })

  it("fails closed with WorkflowProjectorCallError naming entity kind and dropped count on malformed existing/target rows", async () => {
    const attemptKey = makeWorkflowAttemptKey(
      RUN_ID,
      WorkUnitId.make("unit-alpha"),
      AttemptNumber.make(1),
    )
    const cases: ReadonlyArray<{
      readonly label: string
      readonly queryMatch: string
      readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
      readonly expectedKind: string
      readonly expectedCount: string
      readonly attemptKeys?: ReadonlyArray<string>
    }> = [
      {
        label: "invalid WorkflowRun state enum",
        queryMatch: "q_run(",
        rows: [
          {
            runId: RUN_ID,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "bogus",
          },
        ],
        expectedKind: "WorkflowRun",
        expectedCount: "1",
      },
      {
        label: "invalid WorkUnit kind enum",
        queryMatch: "q_units(",
        rows: [
          {
            unitKey: makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-alpha")),
            runId: RUN_ID,
            unitId: "unit-alpha",
            kind: "bogus",
            waveIndex: 0,
            status: "pending",
            ownedRelPaths: ["libs/alpha"],
          },
          {
            unitKey: "bad",
            runId: RUN_ID,
            unitId: "unit-beta",
            kind: "package",
            waveIndex: 0,
            status: "bogus",
            ownedRelPaths: ["libs/beta"],
          },
        ],
        expectedKind: "WorkUnit",
        expectedCount: "2",
      },
      {
        label: "invalid UnitAttempt verdict enum",
        queryMatch: "q_attempts(",
        rows: [
          {
            attemptKey,
            attempt: 1,
            verdict: "bogus",
            runner: null,
            rejection: null,
            packageStampHash: null,
          },
        ],
        expectedKind: "UnitAttempt",
        expectedCount: "1",
        attemptKeys: [attemptKey],
      },
      {
        label: "malformed PlaysRunUnitRole edge",
        queryMatch: "q_run_unit_edges(",
        rows: [{ from: RUN_ID, to: "u1", role: "bogus-role", archimateRelation: "Composition" }],
        expectedKind: "PlaysRunUnitRole",
        expectedCount: "1",
      },
      {
        label: "malformed EffectFn target row",
        queryMatch: "q_effect_fns(",
        rows: [{ qualname: "a#b", spanName: "a.b" }],
        expectedKind: "EffectFn",
        expectedCount: "1",
      },
      {
        label: "malformed EarsSpec target row",
        queryMatch: "q_ears_specs(",
        rows: [{ id: "harness:SPEC-1", enforcedByFiles: "not-an-array" }],
        expectedKind: "EarsSpec",
        expectedCount: "1",
      },
      {
        label: "malformed VitestCase target row",
        queryMatch: "q_vitest_cases(",
        rows: [{ testId: "", testFile: "libs/a/test/a.test.ts" }],
        expectedKind: "VitestCase",
        expectedCount: "1",
      },
    ]

    for (const c of cases) {
      const client = makeMockClient((input) => ({
        graphCommitId: "cmt-malformed-1",
        rows: input.query.includes(c.queryMatch) ? c.rows : [],
      }))
      const err = await runReadExpectError(client, c.attemptKeys ?? [])
      const msg = err.cause instanceof Error ? err.cause.message : String(err.cause)
      expect(msg, c.label).toContain(c.expectedKind)
      expect(msg, c.label).toContain(c.expectedCount)
    }
  })

  it("fails closed with WorkflowProjectorCallError when truncated, hasMore, or nextCursor is present", async () => {
    const truncatedPayloads: ReadonlyArray<MockQueryResponse> = [
      { graphCommitId: "cmt-1", rows: [], truncated: true },
      { graphCommitId: "cmt-1", rows: [], hasMore: true },
      { graphCommitId: "cmt-1", rows: [], nextCursor: "cursor-2" },
      { graphCommitId: "cmt-1", rows: [], nextCursor: "" },
    ]
    for (const payload of truncatedPayloads) {
      const client = makeMockClient((input) =>
        input.query.includes("q_vitest_cases(") ? payload : { graphCommitId: "cmt-1", rows: [] },
      )
      const err = await runReadExpectError(client)
      const msg = err.cause instanceof Error ? err.cause.message : String(err.cause)
      expect(msg.toLowerCase()).toContain("truncated")
    }
  })

  it("fails closed with WorkflowProjectorCallError when graphCommitId is missing or malformed", async () => {
    const badCommits: ReadonlyArray<string | null | undefined> = [undefined, null, "", "   "]
    for (const badCommit of badCommits) {
      const client = makeMockClient(() => ({
        rows: [],
        ...(badCommit !== undefined ? { graphCommitId: badCommit } : {}),
      }))
      const err = await runReadExpectError(client)
      const msg = err.cause instanceof Error ? err.cause.message : String(err.cause)
      expect(msg).toContain("graphCommitId")
    }
  })
})
