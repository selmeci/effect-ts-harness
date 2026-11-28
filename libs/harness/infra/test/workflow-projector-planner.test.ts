import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AttemptNumber,
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanJsonPayload,
  PlanSha256,
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
import {
  type ExistingProjectedAttempt,
  type ExistingProjectedEdge,
  type ExistingProjectedRun,
  type ExistingProjectedUnit,
  type WorkflowProjectionTargetState,
  extractPackageDirPrefix,
  planWorkflowProjection,
  relPathsOverlap,
} from "../src/workflow/workflow-projector-planner.js"

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

    expect(result.noOp).toBe(false)
    expect(result.counts.runsUpserted).toBe(1)
    expect(result.counts.unitsUpserted).toBe(2)
    expect(result.counts.attemptsUpserted).toBe(4)
    expect(result.counts.edgesUpserted).toBe(19)

    expect(result.query).toContain("query project_workflow_run(")
    expect(result.query).toContain("insert WorkflowRun")
    expect(result.query).toContain("insert WorkUnit")
    expect(result.query).toContain("insert UnitAttempt")
    expect(result.query).toContain("insert PlaysRunUnitRole")
    expect(result.query).toContain("insert PlaysUnitAttemptRole")
    expect(result.query).toContain("insert PlaysUnitStubRole")
    expect(result.query).toContain("insert PlaysUnitEarsRole")
    expect(result.query).toContain("insert PlaysUnitTraceabilityRole")
    expect(result.query).toContain("insert PlaysAttemptTestRole")
    expect(result.query).toContain(": String?")
    expect(result.query).toContain(": I32")
    expect(result.query).toContain(": [String]")
    expect(result.query).not.toContain(RUN_ID)
    expect(result.query).not.toContain(PLAN_SHA)
    expect(result.query).not.toContain("libs/missing/test/dangling.test.ts::missing")
    expect(Object.values(result.params)).toContain(encodeRejection(rejection))
    expect(Object.values(result.params)).toContain(null)
  })

  it("handles SliceUnit planJson, missing planJson, and corrupt planJson without throwing", () => {
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
    expect(withSlicePlan.counts.edgesUpserted).toBe(2) // PlaysRunUnitRole + PlaysUnitEarsRole

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
    expect(withMissingPlan.counts.edgesUpserted).toBe(1) // Only PlaysRunUnitRole

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
    expect(withCorruptPlan.counts.edgesUpserted).toBe(1)
  })

  it("produces noOp: true when existing state matches and emits targeted updates when individual fields drift", () => {
    const unitKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-alpha"))
    const attemptKey = makeWorkflowAttemptKey(
      RUN_ID,
      WorkUnitId.make("unit-alpha"),
      AttemptNumber.make(1),
    )
    const source = {
      run: {
        runId: RUN_ID,
        executionId: EXEC_ID,
        level: "slice" as const,
        planSha: PLAN_SHA,
        baseSha: BASE_SHA,
        state: "completed" as const,
        updatedMs: NOW_MS,
      },
      units: [
        {
          unitKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-alpha"),
          kind: "package" as const,
          waveIndex: WaveIndex.make(0),
          status: "completed" as const,
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: NOW_MS,
        },
      ],
      attempts: [
        {
          attemptKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-alpha"),
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
      state: "completed",
    }
    const existingUnit: ExistingProjectedUnit = {
      unitKey,
      runId: RUN_ID,
      unitId: "unit-alpha",
      kind: "package",
      waveIndex: 0,
      status: "completed",
      ownedRelPaths: ["libs/alpha"],
    }
    const existingAttempt: ExistingProjectedAttempt = {
      attemptKey,
      attempt: 1,
      verdict: "completed",
      runner: "claude-code",
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

    const noOpPlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [existingUnit],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    expect(noOpPlan).toEqual({
      noOp: true,
      query: "",
      params: {},
      counts: {
        runsUpserted: 0,
        unitsUpserted: 0,
        attemptsUpserted: 0,
        edgesUpserted: 0,
      },
    })

    // Drift on run.state only
    const runUpdatePlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun: { ...existingRun, state: "running" },
      existingUnits: [existingUnit],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    expect(runUpdatePlan.noOp).toBe(false)
    expect(runUpdatePlan.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 0,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
    expect(runUpdatePlan.query).toContain("update WorkflowRun set")
    expect(runUpdatePlan.query).not.toContain("insert WorkflowRun")

    // Drift on unit.ownedRelPaths (same length, different value)
    const unitUpdatePlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [{ ...existingUnit, ownedRelPaths: ["libs/beta"] }],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    expect(unitUpdatePlan.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 1,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
    expect(unitUpdatePlan.query).toContain("update WorkUnit set")

    // Drift on attempt.packageStampHash
    const attemptUpdatePlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [existingUnit],
      existingAttempts: [{ ...existingAttempt, packageStampHash: null }],
      existingEdges,
    })
    expect(attemptUpdatePlan.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 0,
      attemptsUpserted: 1,
      edgesUpserted: 0,
    })
    expect(attemptUpdatePlan.query).toContain("update UnitAttempt set")

    // Drift on run.level, unit.waveIndex, attempt.runner, and partial missing edge
    const multiDriftPlan = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun: { ...existingRun, level: "epic" },
      existingUnits: [{ ...existingUnit, waveIndex: 1 }],
      existingAttempts: [{ ...existingAttempt, runner: null }],
      existingEdges: [existingEdges[0]!],
    })
    expect(multiDriftPlan.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 1,
      attemptsUpserted: 1,
      edgesUpserted: 1,
    })
  })

  it("emits targeted updates when unit.status, attempt.verdict/rejection, or run SHAs drift in isolation", () => {
    const unitKey = makeWorkflowUnitKey(RUN_ID, WorkUnitId.make("unit-alpha"))
    const attemptKey = makeWorkflowAttemptKey(
      RUN_ID,
      WorkUnitId.make("unit-alpha"),
      AttemptNumber.make(1),
    )
    const source = {
      run: {
        runId: RUN_ID,
        executionId: EXEC_ID,
        level: "slice" as const,
        planSha: PLAN_SHA,
        baseSha: BASE_SHA,
        state: "completed" as const,
        updatedMs: NOW_MS,
      },
      units: [
        {
          unitKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-alpha"),
          kind: "package" as const,
          waveIndex: WaveIndex.make(0),
          status: "completed" as const,
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: NOW_MS,
        },
      ],
      attempts: [
        {
          attemptKey,
          runId: RUN_ID,
          unitId: WorkUnitId.make("unit-alpha"),
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
      state: "completed",
    }
    const existingUnit: ExistingProjectedUnit = {
      unitKey,
      runId: RUN_ID,
      unitId: "unit-alpha",
      kind: "package",
      waveIndex: 0,
      status: "completed",
      ownedRelPaths: ["libs/alpha"],
    }
    const existingAttempt: ExistingProjectedAttempt = {
      attemptKey,
      attempt: 1,
      verdict: "completed",
      runner: "claude-code",
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

    const unitStatusDrift = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [{ ...existingUnit, status: "dispatched" }],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    expect(unitStatusDrift.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 1,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })

    const attemptVerdictDrift = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun,
      existingUnits: [existingUnit],
      existingAttempts: [
        {
          ...existingAttempt,
          verdict: "rejected",
          rejection: encodeRejection({ _tag: "StampMissing" }),
        },
      ],
      existingEdges,
    })
    expect(attemptVerdictDrift.counts).toEqual({
      runsUpserted: 0,
      unitsUpserted: 0,
      attemptsUpserted: 1,
      edgesUpserted: 0,
    })

    const runShaDrift = planWorkflowProjection(source, {
      ...emptyTargetState(),
      existingRun: {
        ...existingRun,
        planSha: "f".repeat(64),
        baseSha: "e".repeat(40),
      },
      existingUnits: [existingUnit],
      existingAttempts: [existingAttempt],
      existingEdges,
    })
    expect(runShaDrift.counts).toEqual({
      runsUpserted: 1,
      unitsUpserted: 0,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
  })

  it("property: relPathsOverlap is reflexive, symmetric, case-insensitive, and boundary-safe", () => {
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
          const selfMatch = relPathsOverlap(left, left)
          const sym = relPathsOverlap(left, right) === relPathsOverlap(right, left)
          const caseSym =
            relPathsOverlap(left.toUpperCase(), right.toLowerCase()) ===
            relPathsOverlap(left.toLowerCase(), right.toLowerCase())
          return selfMatch && sym && caseSym
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
    "property: fresh projection always emits balanced $pN declarations and converges to noOp when existing state matches",
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

      const first = planWorkflowProjection(source, {
        ...emptyTargetState(),
        ...targetEntities,
      })
      expect(first.noOp).toBe(false)
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
            unitId: "unit-prop",
            kind: "package",
            waveIndex: 0,
            status: spec.unitStatus,
            ownedRelPaths: ["libs/alpha/src"],
          },
        ],
        existingAttempts: [
          {
            attemptKey,
            attempt: 1,
            verdict: spec.verdict,
            runner: null,
            rejection: match(spec.verdict)
              .with("rejected", () => encodeRejection(rejection))
              .with("dispatched", "completed", () => null)
              .exhaustive(),
            packageStampHash: null,
          },
        ],
        existingEdges,
      })
      expect(second.noOp).toBe(true)
      expect(second.counts).toEqual({
        runsUpserted: 0,
        unitsUpserted: 0,
        attemptsUpserted: 0,
        edgesUpserted: 0,
      })
    },
  )
})
