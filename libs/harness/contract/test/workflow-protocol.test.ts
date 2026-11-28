import { Arbitrary, Cause, Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AttemptNumber,
  EscalationOrdinal,
  MultiStageTimeoutBudgetInput,
  SHIP_STAGE_COUNT,
  SHIP_STAGES,
  ShipAttempt,
  ShipAttemptKey,
  ShipStage,
  WORKFLOW_ACTIVITY_DECODERS,
  WORKFLOW_DEFERRED_DECODERS,
  WORKFLOW_TIMEOUT_BUDGETS,
  WaveIndex,
  WorkUnitId,
  WorkflowActivityName,
  WorkflowActivityTag,
  WorkflowDeferredTag,
  WorkflowPollAttempts,
  WorkflowPollBudget,
  WorkflowRunAbortTarget,
  WorkflowRunId,
  WorkflowStageCount,
  WorkflowStageLabel,
  WorkflowTimeoutBudgets,
  WorkflowTimeoutMs,
  decodeShipAttemptKey,
  decodeWorkflowActivityName,
  decodeWorkflowDeferredName,
  encodeShipAttemptKey,
  encodeWorkflowActivityName,
  encodeWorkflowDeferredName,
  validateMultiStageTimeoutBudget,
  validateWorkflowTimeoutBudgets,
} from "../src/index.js"

const expectDecodedActivity = (raw: string, expected: WorkflowActivityTag): void => {
  const res = decodeWorkflowActivityName(raw)
  match(res)
    .with({ _tag: "Success" }, ({ success }) => expect(success).toEqual(expected))
    .with({ _tag: "Failure" }, ({ failure }) =>
      expect.unreachable(`Expected activity decode success for '${raw}': ${failure}`),
    )
    .exhaustive()
}

const expectDecodedDeferred = (raw: string, expected: WorkflowDeferredTag): void => {
  const res = decodeWorkflowDeferredName(raw)
  match(res)
    .with({ _tag: "Success" }, ({ success }) => expect(success).toEqual(expected))
    .with({ _tag: "Failure" }, ({ failure }) =>
      expect.unreachable(`Expected deferred decode success for '${raw}': ${failure}`),
    )
    .exhaustive()
}

const firstCharArb = Arbitrary.schema(Schema.Literals(["a", "b", "m", "u", "s", "0", "9"]))
const tailCharArb = Arbitrary.schema(Schema.Literals(["a", "z", "0", "-", "_", ".", ":"]))
const workUnitIdArb: Arbitrary.Arbitrary<WorkUnitId> = Arbitrary.map(
  Arbitrary.all({
    first: Arbitrary.schema(Schema.Literals(["merge", "a", "u", "s", "0"])),
    tail: Arbitrary.array(tailCharArb, { minLength: 0, maxLength: 10 }),
    useMergeLiteral: Arbitrary.schema(Schema.Literals([true, false])),
  }),
  ({ first, tail, useMergeLiteral }) =>
    WorkUnitId.make(
      useMergeLiteral ? "merge" : `${first === "merge" ? "m" : first}${tail.join("")}`,
    ),
)
void firstCharArb

const attemptArb: Arbitrary.Arbitrary<AttemptNumber> = Arbitrary.map(
  Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))),
  (n) => AttemptNumber.make(n),
)

const escalationArb: Arbitrary.Arbitrary<EscalationOrdinal> = Arbitrary.map(
  Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 })))),
  (n) => EscalationOrdinal.make(n),
)

const waveArb: Arbitrary.Arbitrary<WaveIndex> = Arbitrary.map(
  Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 12 })))),
  (n) => WaveIndex.make(n),
)

const abortTargetArb: Arbitrary.Arbitrary<WorkflowRunAbortTarget> = Arbitrary.map(
  Arbitrary.all({
    kind: Arbitrary.schema(Schema.Literals(["Unit", "Merge"])),
    unitId: workUnitIdArb,
    waveIndex: waveArb,
    escalationOrdinal: escalationArb,
  }),
  ({ kind, unitId, waveIndex, escalationOrdinal }) =>
    match(kind)
      .with("Unit", () => WorkflowRunAbortTarget.cases.Unit.make({ unitId, escalationOrdinal }))
      .with("Merge", () =>
        WorkflowRunAbortTarget.cases.Merge.make({ waveIndex, escalationOrdinal }),
      )
      .exhaustive(),
)

const shipStageArb: Arbitrary.Arbitrary<ShipStage> = Arbitrary.schema(ShipStage)

const activityTagArb: Arbitrary.Arbitrary<WorkflowActivityTag> = Arbitrary.map(
  Arbitrary.all({
    kind: Arbitrary.schema(
      Schema.Literals([
        "ProvisionWorktrees",
        "ProjectRunStarted",
        "ProjectRunWaitingLlmPhase",
        "ProjectRunCompleted",
        "ProjectWaveToHarness",
        "RouteReview",
        "RunGate",
        "ProjectRunAborted",
        "MergeSliceWave",
        "ProjectWaveMergeEscalated",
        "ProjectWaveMergeRetried",
        "ProjectUnitDispatched",
        "ProjectUnitCompleted",
        "ProjectUnitRejected",
        "ProjectUnitAttemptEscalated",
        "DispatchUnitAgent",
        "VerifyUnit",
        "ProjectUnitEscalated",
        "ProjectUnitEscalationRetried",
        "VerifySharedStep",
      ]),
    ),
    abortTarget: abortTargetArb,
    shipStage: shipStageArb,
    unitId: workUnitIdArb,
    attempt: attemptArb,
    escalationOrdinal: escalationArb,
    waveIndex: waveArb,
  }),
  ({ kind, abortTarget, shipStage, unitId, attempt, escalationOrdinal, waveIndex }) =>
    match(kind)
      .with("ProvisionWorktrees", () => WorkflowActivityTag.cases.ProvisionWorktrees.make({}))
      .with("ProjectRunStarted", () => WorkflowActivityTag.cases.ProjectRunStarted.make({}))
      .with("ProjectRunWaitingLlmPhase", () =>
        WorkflowActivityTag.cases.ProjectRunWaitingLlmPhase.make({}),
      )
      .with("ProjectRunCompleted", () => WorkflowActivityTag.cases.ProjectRunCompleted.make({}))
      .with("ProjectWaveToHarness", () =>
        WorkflowActivityTag.cases.ProjectWaveToHarness.make({ waveIndex }),
      )
      .with("RouteReview", () => WorkflowActivityTag.cases.RouteReview.make({}))
      .with("RunGate", () => WorkflowActivityTag.cases.RunGate.make({ stage: shipStage }))
      .with("ProjectRunAborted", () =>
        WorkflowActivityTag.cases.ProjectRunAborted.make({ target: abortTarget }),
      )
      .with("MergeSliceWave", () =>
        WorkflowActivityTag.cases.MergeSliceWave.make({ waveIndex, escalationOrdinal }),
      )
      .with("ProjectWaveMergeEscalated", () =>
        WorkflowActivityTag.cases.ProjectWaveMergeEscalated.make({
          waveIndex,
          escalationOrdinal,
        }),
      )
      .with("ProjectWaveMergeRetried", () =>
        WorkflowActivityTag.cases.ProjectWaveMergeRetried.make({ waveIndex, escalationOrdinal }),
      )
      .with("ProjectUnitDispatched", () =>
        WorkflowActivityTag.cases.ProjectUnitDispatched.make({
          unitId,
          attempt,
          escalationOrdinal,
        }),
      )
      .with("ProjectUnitCompleted", () =>
        WorkflowActivityTag.cases.ProjectUnitCompleted.make({
          unitId,
          attempt,
          escalationOrdinal,
        }),
      )
      .with("ProjectUnitRejected", () =>
        WorkflowActivityTag.cases.ProjectUnitRejected.make({
          unitId,
          attempt,
          escalationOrdinal,
        }),
      )
      .with("ProjectUnitAttemptEscalated", () =>
        WorkflowActivityTag.cases.ProjectUnitAttemptEscalated.make({
          unitId,
          attempt,
          escalationOrdinal,
        }),
      )
      .with("DispatchUnitAgent", () =>
        WorkflowActivityTag.cases.DispatchUnitAgent.make({
          unitId,
          attempt,
          escalationOrdinal,
        }),
      )
      .with("VerifyUnit", () =>
        WorkflowActivityTag.cases.VerifyUnit.make({ unitId, attempt, escalationOrdinal }),
      )
      .with("ProjectUnitEscalated", () =>
        WorkflowActivityTag.cases.ProjectUnitEscalated.make({ unitId, escalationOrdinal }),
      )
      .with("ProjectUnitEscalationRetried", () =>
        WorkflowActivityTag.cases.ProjectUnitEscalationRetried.make({
          unitId,
          escalationOrdinal,
        }),
      )
      .with("VerifySharedStep", () =>
        WorkflowActivityTag.cases.VerifySharedStep.make({ attempt, escalationOrdinal }),
      )
      .exhaustive(),
)

const deferredTagArb: Arbitrary.Arbitrary<WorkflowDeferredTag> = Arbitrary.map(
  Arbitrary.all({
    kind: Arbitrary.schema(
      Schema.Literals(["LlmPhaseDone", "InterruptSignal", "UnitCompletion", "UnitEscalation"]),
    ),
    unitId: workUnitIdArb,
    attempt: attemptArb,
    escalationOrdinal: escalationArb,
  }),
  ({ kind, unitId, attempt, escalationOrdinal }) =>
    match(kind)
      .with("LlmPhaseDone", () => WorkflowDeferredTag.cases.LlmPhaseDone.make({}))
      .with("InterruptSignal", () => WorkflowDeferredTag.cases.InterruptSignal.make({}))
      .with("UnitCompletion", () =>
        WorkflowDeferredTag.cases.UnitCompletion.make({ unitId, attempt, escalationOrdinal }),
      )
      .with("UnitEscalation", () =>
        WorkflowDeferredTag.cases.UnitEscalation.make({ unitId, escalationOrdinal }),
      )
      .exhaustive(),
)

describe("workflow-protocol & workflow-timeouts", () => {
  it("encodes and decodes all 20 WorkflowActivityTag variants including 'merge' WorkUnitId disambiguation", () => {
    const unitId = WorkUnitId.make("unit-a")
    const mergeNamedUnit = WorkUnitId.make("merge")
    const a1 = AttemptNumber.make(1)
    const a3 = AttemptNumber.make(3)
    const o1 = EscalationOrdinal.make(1)
    const o2 = EscalationOrdinal.make(2)
    const w0 = WaveIndex.make(0)
    const w2 = WaveIndex.make(2)

    const cases: ReadonlyArray<readonly [WorkflowActivityTag, string]> = [
      [WorkflowActivityTag.cases.ProvisionWorktrees.make({}), "ProvisionWorktrees"],
      [WorkflowActivityTag.cases.ProjectRunStarted.make({}), "ProjectRunStarted"],
      [WorkflowActivityTag.cases.ProjectRunWaitingLlmPhase.make({}), "ProjectRunWaitingLlmPhase"],
      [WorkflowActivityTag.cases.ProjectRunCompleted.make({}), "ProjectRunCompleted"],
      [
        WorkflowActivityTag.cases.ProjectWaveToHarness.make({ waveIndex: w0 }),
        "ProjectWaveToHarness/0",
      ],
      [
        WorkflowActivityTag.cases.ProjectWaveToHarness.make({ waveIndex: w2 }),
        "ProjectWaveToHarness/2",
      ],
      [WorkflowActivityTag.cases.RouteReview.make({}), "RouteReview"],
      ...SHIP_STAGES.map(
        (stage) => [WorkflowActivityTag.cases.RunGate.make({ stage }), `RunGate/${stage}`] as const,
      ),
      [
        WorkflowActivityTag.cases.ProjectRunAborted.make({
          target: WorkflowRunAbortTarget.cases.Unit.make({ unitId, escalationOrdinal: o1 }),
        }),
        "ProjectRunAborted/unit-a/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectRunAborted.make({
          target: WorkflowRunAbortTarget.cases.Unit.make({
            unitId: mergeNamedUnit,
            escalationOrdinal: o1,
          }),
        }),
        "ProjectRunAborted/merge/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectRunAborted.make({
          target: WorkflowRunAbortTarget.cases.Merge.make({
            waveIndex: w0,
            escalationOrdinal: o2,
          }),
        }),
        "ProjectRunAborted/merge/0/2",
      ],
      [
        WorkflowActivityTag.cases.MergeSliceWave.make({ waveIndex: w0, escalationOrdinal: o1 }),
        "MergeSliceWave/0",
      ],
      [
        WorkflowActivityTag.cases.MergeSliceWave.make({ waveIndex: w2, escalationOrdinal: o2 }),
        "MergeSliceWave/2/r2",
      ],
      [
        WorkflowActivityTag.cases.ProjectWaveMergeEscalated.make({
          waveIndex: w0,
          escalationOrdinal: o1,
        }),
        "ProjectWaveMergeEscalated/0/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectWaveMergeRetried.make({
          waveIndex: w2,
          escalationOrdinal: o2,
        }),
        "ProjectWaveMergeRetried/2/2",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitDispatched.make({
          unitId,
          attempt: a1,
          escalationOrdinal: o1,
        }),
        "ProjectUnitDispatched/unit-a/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitCompleted.make({
          unitId,
          attempt: a1,
          escalationOrdinal: o1,
        }),
        "ProjectUnitCompleted/unit-a/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitRejected.make({
          unitId,
          attempt: a3,
          escalationOrdinal: o2,
        }),
        "ProjectUnitRejected/unit-a/3/r2",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitAttemptEscalated.make({
          unitId,
          attempt: a3,
          escalationOrdinal: o1,
        }),
        "ProjectUnitAttemptEscalated/unit-a/3",
      ],
      [
        WorkflowActivityTag.cases.DispatchUnitAgent.make({
          unitId,
          attempt: a1,
          escalationOrdinal: o1,
        }),
        "DispatchUnitAgent/unit-a/1",
      ],
      [
        WorkflowActivityTag.cases.VerifyUnit.make({ unitId, attempt: a3, escalationOrdinal: o2 }),
        "VerifyUnit/unit-a/3/r2",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitEscalated.make({ unitId, escalationOrdinal: o1 }),
        "ProjectUnitEscalated/unit-a/1",
      ],
      [
        WorkflowActivityTag.cases.ProjectUnitEscalationRetried.make({
          unitId,
          escalationOrdinal: o2,
        }),
        "ProjectUnitEscalationRetried/unit-a/2",
      ],
      [
        WorkflowActivityTag.cases.VerifySharedStep.make({ attempt: a1, escalationOrdinal: o1 }),
        "VerifySharedStep/1",
      ],
      [
        WorkflowActivityTag.cases.VerifySharedStep.make({ attempt: a3, escalationOrdinal: o2 }),
        "VerifySharedStep/3/r2",
      ],
    ]

    for (const [tag, wire] of cases) {
      const encoded = encodeWorkflowActivityName(tag)
      expect(encoded).toBe(WorkflowActivityName.make(wire))
      expectDecodedActivity(wire, tag)
    }
  })

  it("encodes and decodes all 4 WorkflowDeferredTag variants", () => {
    const unitId = WorkUnitId.make("unit-a")
    const a2 = AttemptNumber.make(2)
    const o1 = EscalationOrdinal.make(1)
    const o3 = EscalationOrdinal.make(3)

    const cases: ReadonlyArray<readonly [WorkflowDeferredTag, string]> = [
      [WorkflowDeferredTag.cases.LlmPhaseDone.make({}), "llm-phase-done"],
      [WorkflowDeferredTag.cases.InterruptSignal.make({}), "Workflow/InterruptSignal"],
      [
        WorkflowDeferredTag.cases.UnitCompletion.make({
          unitId,
          attempt: a2,
          escalationOrdinal: o1,
        }),
        "unit/unit-a/2",
      ],
      [
        WorkflowDeferredTag.cases.UnitCompletion.make({
          unitId,
          attempt: a2,
          escalationOrdinal: o3,
        }),
        "unit/unit-a/2/r3",
      ],
      [
        WorkflowDeferredTag.cases.UnitEscalation.make({ unitId, escalationOrdinal: o3 }),
        "escalation/unit-a/3",
      ],
    ]

    for (const [tag, wire] of cases) {
      expect(encodeWorkflowDeferredName(tag)).toBe(wire)
      expectDecodedDeferred(wire, tag)
    }
  })

  it("rejects malformed, prototype-named, out-of-range, and non-canonical activity/deferred names", () => {
    const badActivities = [
      "",
      "toString",
      "constructor",
      "__proto__",
      "NoopTick/0",
      "ProvisionWorktrees/extra",
      "RouteReview/",
      "RunGate",
      "RunGate/",
      "RunGate/bogus",
      "RunGate/verify/extra",
      "ProjectRunAborted",
      "ProjectRunAborted/u1",
      "ProjectRunAborted/u1/0",
      "ProjectRunAborted/u1/01",
      "ProjectRunAborted/BAD_ID/1",
      "ProjectRunAborted/foo/0/1",
      "ProjectRunAborted/merge/bad/1",
      "ProjectRunAborted/merge/0/0",
      "ProjectRunAborted/merge/0/1/extra",
      "ProjectWaveToHarness",
      "ProjectWaveToHarness/",
      "ProjectWaveToHarness/-1",
      "ProjectWaveToHarness/01",
      "ProjectWaveToHarness/abc",
      "ProjectWaveToHarness/0/extra",
      "ProjectWaveToHarness/9007199254740992",
      "MergeSliceWave",
      "MergeSliceWave/-1",
      "MergeSliceWave/01",
      "MergeSliceWave/0/r1",
      "MergeSliceWave/0/r0",
      "MergeSliceWave/0/r02",
      "MergeSliceWave/0/x2",
      "MergeSliceWave/0/r2/extra",
      "MergeSliceWave/9007199254740992",
      "VerifySharedStep",
      "VerifySharedStep/0",
      "VerifySharedStep/4",
      "VerifySharedStep/1/r1",
      "VerifySharedStep/1/r2/extra",
      "ProjectWaveMergeEscalated",
      "ProjectWaveMergeEscalated/0",
      "ProjectWaveMergeEscalated/0/0",
      "ProjectWaveMergeEscalated/0/1/extra",
      "ProjectWaveMergeEscalated/-1/1",
      "ProjectWaveMergeRetried/01/1",
      "VerifyUnit",
      "VerifyUnit/u1",
      "VerifyUnit/u1/0",
      "VerifyUnit/u1/4",
      "VerifyUnit/BAD_ID/1",
      "VerifyUnit/u1/1/r1",
      "VerifyUnit/u1/1/r2/extra",
      "VerifyUnit/u1/1/r9007199254740992",
      "ProjectUnitEscalated",
      "ProjectUnitEscalated/u1",
      "ProjectUnitEscalated/u1/0",
      "ProjectUnitEscalated/BAD_ID/1",
      "ProjectUnitEscalated/u1/1/extra",
      "ProjectUnitEscalationRetried/u1/9007199254740992",
    ]
    for (const bad of badActivities) {
      const res = decodeWorkflowActivityName(bad)
      expect(Result.isFailure(res)).toBe(true)
    }

    const badDeferreds = [
      "",
      "unknown",
      "toString",
      "llm-phase-done/extra",
      "Workflow/InterruptSignal/extra",
      "unit",
      "unit/u1",
      "unit/u1/0",
      "unit/u1/4",
      "unit/BAD_ID/1",
      "unit/u1/1/r1",
      "unit/u1/1/r2/extra",
      "escalation",
      "escalation/u1",
      "escalation/u1/0",
      "escalation/BAD_ID/1",
      "escalation/u1/1/extra",
    ]
    for (const bad of badDeferreds) {
      const res = decodeWorkflowDeferredName(bad)
      expect(Result.isFailure(res)).toBe(true)
    }
  })

  it("satisfies lossless round-trip across arbitrary WorkflowActivityTag and WorkflowDeferredTag values", () => {
    const activityTagEquivalence = Schema.toEquivalence(WorkflowActivityTag)
    const deferredTagEquivalence = Schema.toEquivalence(WorkflowDeferredTag)

    const activityCheck = Effect.runSync(
      Arbitrary.checkEffect(
        activityTagArb,
        (tag) => {
          const encoded = encodeWorkflowActivityName(tag)
          const decoded = decodeWorkflowActivityName(encoded)
          return match(decoded)
            .with({ _tag: "Failure" }, () => false)
            .with(
              { _tag: "Success" },
              ({ success }) =>
                activityTagEquivalence(success, tag) &&
                encodeWorkflowActivityName(success) === encoded,
            )
            .exhaustive()
        },
        { runs: 150, seed: 27 },
      ),
    )
    expect(activityCheck._tag).toBe("Passed")

    const deferredCheck = Effect.runSync(
      Arbitrary.checkEffect(
        deferredTagArb,
        (tag) => {
          const encoded = encodeWorkflowDeferredName(tag)
          const decoded = decodeWorkflowDeferredName(encoded)
          return match(decoded)
            .with({ _tag: "Failure" }, () => false)
            .with(
              { _tag: "Success" },
              ({ success }) =>
                deferredTagEquivalence(success, tag) &&
                encodeWorkflowDeferredName(success) === encoded,
            )
            .exhaustive()
        },
        { runs: 100, seed: 27 },
      ),
    )
    expect(deferredCheck._tag).toBe("Passed")
  })

  it("ties WORKFLOW_ACTIVITY_DECODERS and WORKFLOW_DEFERRED_DECODERS exhaustively to union variants", () => {
    expect(Object.keys(WORKFLOW_ACTIVITY_DECODERS).sort()).toEqual(
      Object.keys(WorkflowActivityTag.cases).sort(),
    )
    expect(Object.keys(WORKFLOW_DEFERRED_DECODERS).sort()).toEqual(
      Object.keys(WorkflowDeferredTag.cases).sort(),
    )
  })

  it("validates WORKFLOW_TIMEOUT_BUDGETS schema defaults and strict default inequalities", () => {
    expect(Schema.decodeSync(WorkflowTimeoutBudgets)(WORKFLOW_TIMEOUT_BUDGETS)).toEqual(
      WORKFLOW_TIMEOUT_BUDGETS,
    )
    const pollBudget: WorkflowPollBudget = Schema.decodeSync(WorkflowPollBudget)({
      maxAttempts: WORKFLOW_TIMEOUT_BUDGETS.pollSettleMaxAttempts,
      intervalMs: WORKFLOW_TIMEOUT_BUDGETS.pollSettleIntervalMs,
    })
    expect(pollBudget.maxAttempts).toBe(80)
    expect(pollBudget.intervalMs).toBe(25)

    const validRes = validateWorkflowTimeoutBudgets(WORKFLOW_TIMEOUT_BUDGETS)
    match(validRes)
      .with({ _tag: "Success" }, ({ success }) => expect(success).toBe(WORKFLOW_TIMEOUT_BUDGETS))
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.unreachable(`Expected default WORKFLOW_TIMEOUT_BUDGETS to pass: ${failure}`),
      )
      .exhaustive()
  })

  it("rejects inverted server socket and workflowCompleteIpcMs timeout layers", () => {
    // Inequality 1: workflowServerSocketMs > workflowCompleteIpcMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowServerSocketMs: WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowServerSocketMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs + 1,
          ),
        }),
      ),
    ).toBe(true)

    // Inequality 2: workflowCompleteIpcMs > unitVerifyMs + pollSettleMaxAttempts * pollSettleIntervalMs
    const exactPollBudget =
      WORKFLOW_TIMEOUT_BUDGETS.unitVerifyMs +
      WORKFLOW_TIMEOUT_BUDGETS.pollSettleMaxAttempts * WORKFLOW_TIMEOUT_BUDGETS.pollSettleIntervalMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowCompleteIpcMs: WorkflowTimeoutMs.make(exactPollBudget),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowCompleteIpcMs: WorkflowTimeoutMs.make(exactPollBudget + 1),
        }),
      ),
    ).toBe(true)
    const scaledPollBudget = {
      ...WORKFLOW_TIMEOUT_BUDGETS,
      pollSettleMaxAttempts: WorkflowPollAttempts.make(80),
      pollSettleIntervalMs: WorkflowTimeoutMs.make(100),
    }
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...scaledPollBudget,
          workflowCompleteIpcMs: WorkflowTimeoutMs.make(128_000),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...scaledPollBudget,
          workflowCompleteIpcMs: WorkflowTimeoutMs.make(128_001),
        }),
      ),
    ).toBe(true)
  })

  it("rejects inverted default server socket and abort settle timeout layers", () => {
    // Inequality 3: defaultServerSocketMs > workflowIpcMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          defaultServerSocketMs: WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          defaultServerSocketMs: WorkflowTimeoutMs.make(WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs + 1),
        }),
      ),
    ).toBe(true)

    // Inequality 4: workflowIpcMs > abortSettleMaxAttempts * abortSettleIntervalMs
    const exactAbortBudget =
      WORKFLOW_TIMEOUT_BUDGETS.abortSettleMaxAttempts *
      WORKFLOW_TIMEOUT_BUDGETS.abortSettleIntervalMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowIpcMs: WorkflowTimeoutMs.make(exactAbortBudget),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowIpcMs: WorkflowTimeoutMs.make(exactAbortBudget + 1),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          abortSettleMaxAttempts: WorkflowPollAttempts.make(100),
          abortSettleIntervalMs: WorkflowTimeoutMs.make(200),
          workflowIpcMs: WorkflowTimeoutMs.make(20_000),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          abortSettleMaxAttempts: WorkflowPollAttempts.make(100),
          abortSettleIntervalMs: WorkflowTimeoutMs.make(200),
          workflowIpcMs: WorkflowTimeoutMs.make(20_001),
        }),
      ),
    ).toBe(true)
  })

  it("rejects inverted ship timeout layers (shipServerSocketMs > shipWorkflowIpcMs > shipWorkflowSettleMs > SHIP_STAGES.length * shipGateCommandMs > workflowServerSocketMs)", () => {
    const exactShipStageBudget = SHIP_STAGES.length * WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs
    expect(WORKFLOW_TIMEOUT_BUDGETS.shipServerSocketMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowIpcMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowIpcMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs).toBeGreaterThan(exactShipStageBudget)
    expect(WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.workflowServerSocketMs,
    )

    // Inequality 5: shipServerSocketMs > shipWorkflowIpcMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipServerSocketMs: WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowIpcMs,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipServerSocketMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowIpcMs + 1,
          ),
        }),
      ),
    ).toBe(true)

    // Inequality 6: shipWorkflowIpcMs > shipWorkflowSettleMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipWorkflowIpcMs: WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipWorkflowIpcMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs + 1,
          ),
        }),
      ),
    ).toBe(true)

    // Inequality 7: shipWorkflowSettleMs > SHIP_STAGES.length * shipGateCommandMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipWorkflowSettleMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs + 1,
          ),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipWorkflowSettleMs: WorkflowTimeoutMs.make(exactShipStageBudget),
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipWorkflowSettleMs: WorkflowTimeoutMs.make(exactShipStageBudget + 1),
        }),
      ),
    ).toBe(true)

    // Inequality 8: shipGateCommandMs > workflowServerSocketMs
    expect(
      Result.isFailure(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipGateCommandMs: WORKFLOW_TIMEOUT_BUDGETS.workflowServerSocketMs,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          shipGateCommandMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.workflowServerSocketMs + 1,
          ),
        }),
      ),
    ).toBe(true)
  })

  it("rejects inverted runner timeout layers (agentRunClaudeMs, agentRunAntigravityMs, agentKillGraceMs, agentStartupRetryMaxAttempts, agentStartupRetryBackoffMs)", () => {
    expect(WORKFLOW_TIMEOUT_BUDGETS.agentRunClaudeMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.agentRunAntigravityMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.agentRunAntigravityMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryMaxAttempts *
        WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryBackoffMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.claimTimeoutMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.agentRunClaudeMs + WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.claimTimeoutMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.agentRunAntigravityMs + WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    )

    // Inequality 9: agentRunClaudeMs > agentKillGraceMs
    const claudeGraceFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentRunClaudeMs: WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    })
    match(claudeGraceFail)
      .with({ _tag: "Failure" }, ({ failure }) => expect(failure).toContain("agentRunClaudeMs"))
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected agentRunClaudeMs == agentKillGraceMs to fail"),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          agentRunClaudeMs: WorkflowTimeoutMs.make(WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs + 1),
        }),
      ),
    ).toBe(true)

    // Inequality 10: agentRunAntigravityMs > agentKillGraceMs
    const agyGraceFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentRunAntigravityMs: WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    })
    match(agyGraceFail)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect(failure).toContain("agentRunAntigravityMs"),
      )
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected agentRunAntigravityMs == agentKillGraceMs to fail"),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          agentRunAntigravityMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs + 1,
          ),
        }),
      ),
    ).toBe(true)

    // Inequality 11: agentRunAntigravityMs > agentStartupRetryMaxAttempts * agentStartupRetryBackoffMs
    const startupRetryFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentStartupRetryMaxAttempts: WorkflowPollAttempts.make(6),
      agentStartupRetryBackoffMs: WorkflowTimeoutMs.make(1_000),
      agentRunAntigravityMs: WorkflowTimeoutMs.make(6_000),
    })
    match(startupRetryFail)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect(failure).toContain("agentStartupRetryMaxAttempts * agentStartupRetryBackoffMs"),
      )
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected agentRunAntigravityMs == startupRetryBudgetMs to fail"),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          agentStartupRetryMaxAttempts: WorkflowPollAttempts.make(6),
          agentStartupRetryBackoffMs: WorkflowTimeoutMs.make(1_000),
          agentRunAntigravityMs: WorkflowTimeoutMs.make(6_001),
        }),
      ),
    ).toBe(true)

    // Inequality 12: claimTimeoutMs > agentRunClaudeMs + agentKillGraceMs
    const largeClaudeRunMs = WorkflowTimeoutMs.make(
      WORKFLOW_TIMEOUT_BUDGETS.claimTimeoutMs - WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs - 1,
    )
    const exactClaudeClaimBudget = largeClaudeRunMs + WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs
    const claudeClaimFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentRunClaudeMs: largeClaudeRunMs,
      claimTimeoutMs: WorkflowTimeoutMs.make(exactClaudeClaimBudget),
    })
    match(claudeClaimFail)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect(failure).toContain("agentRunClaudeMs + agentKillGraceMs"),
      )
      .with({ _tag: "Success" }, () =>
        expect.unreachable(
          "Expected claimTimeoutMs == agentRunClaudeMs + agentKillGraceMs to fail",
        ),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          agentRunClaudeMs: largeClaudeRunMs,
          claimTimeoutMs: WorkflowTimeoutMs.make(exactClaudeClaimBudget + 1),
        }),
      ),
    ).toBe(true)

    // Inequality 13: claimTimeoutMs > worst-case antigravity startup retry budget
    const agyRunMs = WorkflowTimeoutMs.make(WORKFLOW_TIMEOUT_BUDGETS.agentRunClaudeMs + 100_000)
    const exactAgyClaimBudget =
      WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryMaxAttempts *
        (agyRunMs + WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs) +
      Math.max(0, WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryMaxAttempts - 1) *
        WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryBackoffMs
    const agyClaimFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentRunAntigravityMs: agyRunMs,
      claimTimeoutMs: WorkflowTimeoutMs.make(exactAgyClaimBudget),
    })
    match(agyClaimFail)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect(failure).toContain("worst-case antigravity retry budget"),
      )
      .with({ _tag: "Success" }, () =>
        expect.unreachable(
          "Expected claimTimeoutMs == worst-case antigravity retry budget to fail",
        ),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          agentRunAntigravityMs: agyRunMs,
          claimTimeoutMs: WorkflowTimeoutMs.make(exactAgyClaimBudget + 1),
        }),
      ),
    ).toBe(true)

    // Schema-level WorkflowTimeoutBudgets enforcement + 32-bit timer cap (2_147_483_647 ms)
    const maxSafeTimeout = Schema.decodeSync(WorkflowTimeoutMs)(2_147_483_647)
    expect(maxSafeTimeout).toBe(2_147_483_647)
    const overflowExit = Schema.decodeExit(WorkflowTimeoutMs)(2_147_483_648)
    match(overflowExit)
      .with({ _tag: "Failure" }, ({ cause }) => expect(Cause.hasFails(cause)).toBe(true))
      .with({ _tag: "Success" }, () => expect.unreachable("Expected 2_147_483_648 to fail"))
      .exhaustive()
    expect(Schema.decodeSync(WorkflowTimeoutBudgets)(WORKFLOW_TIMEOUT_BUDGETS)).toEqual(
      WORKFLOW_TIMEOUT_BUDGETS,
    )
    const badBudgetsExit = Schema.decodeExit(WorkflowTimeoutBudgets)({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      agentRunClaudeMs: WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs,
    })
    match(badBudgetsExit)
      .with({ _tag: "Failure" }, ({ cause }) => expect(Cause.hasFails(cause)).toBe(true))
      .with({ _tag: "Success" }, () => expect.unreachable("Expected monotonic budget failure"))
      .exhaustive()
  })

  it("encodes, decodes, and validates ShipAttemptKey round-trips and malformed rejections", () => {
    const runId = WorkflowRunId.make("ship-run-001")
    const attempt1 = ShipAttempt.make(1)
    const attempt42 = ShipAttempt.make(42)

    const encoded1 = encodeShipAttemptKey(runId, attempt1)
    expect(encoded1).toBe(ShipAttemptKey.make("ship-run-001#1"))
    expect(Schema.decodeSync(ShipAttemptKey)(encoded1)).toBe(encoded1)

    const encoded42 = encodeShipAttemptKey(runId, attempt42)
    expect(encoded42).toBe(ShipAttemptKey.make("ship-run-001#42"))

    for (const [key, expectedRunId, expectedAttempt] of [
      [encoded1, runId, attempt1],
      [encoded42, runId, attempt42],
    ] as const) {
      const decoded = decodeShipAttemptKey(key)
      match(decoded)
        .with({ _tag: "Success" }, ({ success }) => {
          expect(success.runId).toBe(expectedRunId)
          expect(success.attempt).toBe(expectedAttempt)
          expect(encodeShipAttemptKey(success.runId, success.attempt)).toBe(key)
        })
        .with({ _tag: "Failure" }, ({ failure }) =>
          expect.unreachable(`Expected ShipAttemptKey decode success for '${key}': ${failure}`),
        )
        .exhaustive()
    }

    const badShipKeys = [
      "",
      "ship-run-001",
      "#1",
      "ship-run-001#",
      "ship-run-001#0",
      "ship-run-001#-1",
      "ship-run-001#01",
      "ship-run-001#abc",
      "ship-run-001#1#2",
      "ship-run-001#9007199254740992",
      "short#1",
      "SHIP-RUN-001#1",
      "ship_run_001#1",
      `${"a".repeat(65)}#1`,
    ]
    for (const bad of badShipKeys) {
      expect(Result.isFailure(decodeShipAttemptKey(bad))).toBe(true)
    }
  })

  it("validates MultiStageTimeoutBudgetInput and enforces settleMs > stageCount * perStageCommandMs", () => {
    const stageCount = WorkflowStageCount.make(4)
    const perStageCommandMs = WorkflowTimeoutMs.make(1_000)
    const workflowLabel = WorkflowStageLabel.make("CustomPipeline")

    const equalRes = validateMultiStageTimeoutBudget(
      MultiStageTimeoutBudgetInput.make({
        stageCount,
        perStageCommandMs,
        settleMs: WorkflowTimeoutMs.make(4_000),
        workflowLabel,
      }),
    )
    match(equalRes)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("CustomPipeline")
        expect(failure).toContain("4000")
        expect(failure).toContain("4")
        expect(failure).toContain("1000")
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected equal settleMs to fail validateMultiStageTimeoutBudget"),
      )
      .exhaustive()

    const belowRes = validateMultiStageTimeoutBudget(
      MultiStageTimeoutBudgetInput.make({
        stageCount,
        perStageCommandMs,
        settleMs: WorkflowTimeoutMs.make(3_999),
        workflowLabel,
      }),
    )
    match(belowRes)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain(
          "settleMs (3999) must exceed stageCount (4) * perStageCommandMs (1000) = 4000",
        )
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected below-limit settleMs to fail validateMultiStageTimeoutBudget"),
      )
      .exhaustive()

    const aboveRes = validateMultiStageTimeoutBudget(
      MultiStageTimeoutBudgetInput.make({
        stageCount,
        perStageCommandMs,
        settleMs: WorkflowTimeoutMs.make(4_001),
        workflowLabel,
      }),
    )
    match(aboveRes)
      .with({ _tag: "Success" }, ({ success }) => expect(success).toBe(4_001))
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.unreachable(`Expected 4001ms to pass validateMultiStageTimeoutBudget: ${failure}`),
      )
      .exhaustive()

    const invalidNumericInputs: ReadonlyArray<unknown> = ["4", null, undefined, Number.NaN, 1.5, -1]
    for (const invalidValue of invalidNumericInputs) {
      match(Schema.decodeUnknownResult(WorkflowStageCount)(invalidValue))
        .with({ _tag: "Failure" }, () => undefined)
        .with({ _tag: "Success" }, () =>
          expect.unreachable(
            `Expected WorkflowStageCount decode failure for ${String(invalidValue)}`,
          ),
        )
        .exhaustive()
      match(Schema.decodeUnknownResult(MultiStageTimeoutBudgetInput)(invalidValue))
        .with({ _tag: "Failure" }, () => undefined)
        .with({ _tag: "Success" }, () =>
          expect.unreachable(
            `Expected MultiStageTimeoutBudgetInput decode failure for top-level ${String(invalidValue)}`,
          ),
        )
        .exhaustive()
      match(
        Schema.decodeUnknownResult(MultiStageTimeoutBudgetInput)({
          stageCount: invalidValue,
          perStageCommandMs: 1_000,
          settleMs: 5_000,
          workflowLabel: "CustomPipeline",
        }),
      )
        .with({ _tag: "Failure" }, () => undefined)
        .with({ _tag: "Success" }, () =>
          expect.unreachable(
            `Expected MultiStageTimeoutBudgetInput decode failure for stageCount=${String(invalidValue)}`,
          ),
        )
        .exhaustive()
    }

    expect(Result.isFailure(Schema.decodeResult(WorkflowStageCount)(0))).toBe(true)
    expect(Result.isFailure(Schema.decodeResult(WorkflowStageLabel)(""))).toBe(true)
    expect(Result.isFailure(Schema.decodeResult(WorkflowStageLabel)("  padded "))).toBe(true)
    expect(Result.isFailure(Schema.decodeResult(WorkflowStageLabel)("a".repeat(129)))).toBe(true)
  })

  it("enforces settleMs > stageCount * perStageCommandMs across bounded stageCount and perStageCommandMs boundaries", () => {
    const stageCountArb = Arbitrary.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
    )
    const perStageCommandMsArb = Arbitrary.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
    )
    const pairArb = Arbitrary.all({
      stageCount: stageCountArb,
      perStageCommandMs: perStageCommandMsArb,
    })
    const workflowLabel = WorkflowStageLabel.make("PropPipeline")

    const propCheck = Effect.runSync(
      Arbitrary.checkEffect(
        pairArb,
        ({ stageCount: rawStageCount, perStageCommandMs: rawPerStageMs }) => {
          const stageCount = WorkflowStageCount.make(rawStageCount)
          const perStageCommandMs = WorkflowTimeoutMs.make(rawPerStageMs)
          const limit = stageCount * perStageCommandMs

          const atLimitOk = match(
            validateMultiStageTimeoutBudget(
              MultiStageTimeoutBudgetInput.make({
                stageCount,
                perStageCommandMs,
                settleMs: WorkflowTimeoutMs.make(limit),
                workflowLabel,
              }),
            ),
          )
            .with({ _tag: "Failure" }, ({ failure }) =>
              failure.includes(
                `settleMs (${limit}) must exceed stageCount (${stageCount}) * perStageCommandMs (${perStageCommandMs}) = ${limit}`,
              ),
            )
            .with({ _tag: "Success" }, () => false)
            .exhaustive()

          const belowLimitOk =
            limit > 1
              ? match(
                  validateMultiStageTimeoutBudget(
                    MultiStageTimeoutBudgetInput.make({
                      stageCount,
                      perStageCommandMs,
                      settleMs: WorkflowTimeoutMs.make(limit - 1),
                      workflowLabel,
                    }),
                  ),
                )
                  .with({ _tag: "Failure" }, ({ failure }) =>
                    failure.includes(
                      `settleMs (${limit - 1}) must exceed stageCount (${stageCount}) * perStageCommandMs (${perStageCommandMs}) = ${limit}`,
                    ),
                  )
                  .with({ _tag: "Success" }, () => false)
                  .exhaustive()
              : match(
                  Schema.decodeResult(MultiStageTimeoutBudgetInput)({
                    stageCount,
                    perStageCommandMs,
                    settleMs: limit - 1,
                    workflowLabel,
                  }),
                )
                  .with({ _tag: "Failure" }, () => true)
                  .with({ _tag: "Success" }, () => false)
                  .exhaustive()

          const aboveLimitOk = match(
            validateMultiStageTimeoutBudget(
              MultiStageTimeoutBudgetInput.make({
                stageCount,
                perStageCommandMs,
                settleMs: WorkflowTimeoutMs.make(limit + 1),
                workflowLabel,
              }),
            ),
          )
            .with({ _tag: "Success" }, ({ success }) => success === limit + 1)
            .with({ _tag: "Failure" }, () => false)
            .exhaustive()

          return atLimitOk && belowLimitOk && aboveLimitOk
        },
        { runs: 150, seed: 27 },
      ),
    )
    expect(SHIP_STAGE_COUNT).toBe(SHIP_STAGES.length)
    expect(WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs).toBeGreaterThan(
      SHIP_STAGES.length * WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs,
    )
    expect(propCheck._tag).toBe("Passed")
  })

  it("validates projector timeout and OCC monotonicity invariants (projectorHttpTimeoutMs, projectorOccMaxAttempts, projectorOccRetryBackoffMs)", () => {
    expect(WORKFLOW_TIMEOUT_BUDGETS.projectorHttpTimeoutMs).toBe(10_000)
    expect(WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts).toBe(6)
    expect(WORKFLOW_TIMEOUT_BUDGETS.projectorOccRetryBackoffMs).toBe(100)

    const exactOccBudget =
      WORKFLOW_TIMEOUT_BUDGETS.projectorOccRetryBackoffMs *
      (2 ** Math.max(0, WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts - 1) - 1)
    expect(WORKFLOW_TIMEOUT_BUDGETS.projectorHttpTimeoutMs).toBeGreaterThan(exactOccBudget)
    expect(WORKFLOW_TIMEOUT_BUDGETS.projectorHttpTimeoutMs).toBeLessThanOrEqual(
      WORKFLOW_TIMEOUT_BUDGETS.httpRequestTimeoutMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.projectorHttpTimeoutMs,
    )

    // projectorHttpTimeoutMs > worst-case exponential OCC retry backoff sum
    const occEqualFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      projectorHttpTimeoutMs: WorkflowTimeoutMs.make(exactOccBudget),
    })
    match(occEqualFail)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("projectorHttpTimeoutMs")
        expect(failure).toContain("worst-case exponential OCC retry backoff sum")
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected projectorHttpTimeoutMs == occRetryBudgetMs to fail"),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          projectorHttpTimeoutMs: WorkflowTimeoutMs.make(exactOccBudget + 1),
        }),
      ),
    ).toBe(true)

    // projectorHttpTimeoutMs <= httpRequestTimeoutMs
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          projectorHttpTimeoutMs: WORKFLOW_TIMEOUT_BUDGETS.httpRequestTimeoutMs,
        }),
      ),
    ).toBe(true)
    const httpExceedFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      projectorHttpTimeoutMs: WorkflowTimeoutMs.make(
        WORKFLOW_TIMEOUT_BUDGETS.httpRequestTimeoutMs + 1,
      ),
    })
    match(httpExceedFail)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("projectorHttpTimeoutMs")
        expect(failure).toContain("httpRequestTimeoutMs")
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected projectorHttpTimeoutMs > httpRequestTimeoutMs to fail"),
      )
      .exhaustive()

    // workflowIpcMs > projectorHttpTimeoutMs
    const equalIpcAndProjector = WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs
    const ipcEqualFail = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      httpRequestTimeoutMs: equalIpcAndProjector,
      projectorHttpTimeoutMs: equalIpcAndProjector,
    })
    match(ipcEqualFail)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("workflowIpcMs")
        expect(failure).toContain("projectorHttpTimeoutMs")
      })
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected workflowIpcMs == projectorHttpTimeoutMs to fail"),
      )
      .exhaustive()
    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          httpRequestTimeoutMs: equalIpcAndProjector,
          projectorHttpTimeoutMs: WorkflowTimeoutMs.make(equalIpcAndProjector - 1),
        }),
      ),
    ).toBe(true)

    // Schema-level decode enforcement
    const badProjectorSchemaExit = Schema.decodeExit(WorkflowTimeoutBudgets)({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      projectorHttpTimeoutMs: WorkflowTimeoutMs.make(exactOccBudget),
    })
    match(badProjectorSchemaExit)
      .with({ _tag: "Failure" }, ({ cause }) => expect(Cause.hasFails(cause)).toBe(true))
      .with({ _tag: "Success" }, () =>
        expect.unreachable(
          "Expected Schema WorkflowTimeoutBudgets to reject inverted projector budget",
        ),
      )
      .exhaustive()
  })
})
