import { Cause, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  AgentFailureReason,
  AttemptNumber,
  CompileInput,
  CompiledPlan,
  CompiledWave,
  CompiledWaves,
  CompiledWorkUnit,
  CyclicPlanWorkflowError,
  DisjointOwnershipViolationError,
  EarsRequirementKey,
  FrictionLogState,
  GateExitCode,
  GitCommitSha,
  InvalidPlanWorkflowGraphError,
  LlmPhaseReceipt,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanGraphIssue,
  PlanSha256,
  RUNNER_IDS,
  ReviewDepth,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewerId,
  ReviewerSelection,
  RunnerId,
  SHIP_STAGES,
  ShipAttempt,
  ShipReceipt,
  ShipStage,
  SliceBranchName,
  StubSymbolKey,
  TaskRunReceipt,
  type UnitCompletedOutcome,
  UnitDependency,
  UnitEscalation,
  UnitMode,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowCompileReason,
  WorkflowLevel,
  WorkflowRunId,
  WorkspaceTreeHash,
  wavesOf,
} from "../src/index.js"

const expectDecodeSuccess = <A, E>(schema: Schema.Codec<A, E, never, never>, input: unknown): A => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  return match(exit)
    .with({ _tag: "Success" }, (s) => s.value)
    .with({ _tag: "Failure" }, (f) => {
      return expect.unreachable(`Expected decode to succeed: ${Cause.pretty(f.cause)}`)
    })
    .exhaustive()
}

const expectDecodeFailure = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  input: unknown,
): void => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  match(exit)
    .with({ _tag: "Failure" }, (f) => {
      expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable(`Expected decode to fail for input: ${String(input)}`)
    })
    .exhaustive()
}

const expectCases = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  valid: ReadonlyArray<unknown>,
  invalid: ReadonlyArray<unknown>,
): void => {
  for (const input of valid) {
    expect(expectDecodeSuccess(schema, input)).toBe(input)
  }
  for (const input of invalid) {
    expectDecodeFailure(schema, input)
  }
}

const SHA_40 = "0123456789abcdef0123456789abcdef01234567"
const SHA_64_A = "a".repeat(64)
const SHA_64_B = "b".repeat(64)
const SHA_64_C = "c".repeat(64)

describe("@harness/contract workflow & repo-identity schemas", () => {
  it("validates AbsoluteRepoRoot and GitCommitSha (REQ-1.1)", () => {
    expectCases(
      AbsoluteRepoRoot,
      ["/repo", "/a/b c", "/.gemini/worktree"],
      [
        "",
        "/",
        "rel/path",
        "C:/win",
        "/bad\0",
        "/../etc/passwd",
        "/./foo",
        "/repo/..",
        "/repo/.",
        "/repo\n",
        "/repo\t",
        "/repo ",
        " /repo",
        "/a//b",
        "/a\\b",
        null,
        42,
      ],
    )
    expectCases(
      GitCommitSha,
      [SHA_40, "0".repeat(40)],
      ["", "0".repeat(39), "0".repeat(41), "A".repeat(40), "g".repeat(40), null],
    )
  })

  it("validates all workflow scalar, bounded-int, and literal schemas", () => {
    expectCases(
      WorkflowRunId,
      ["run-0001", "a".repeat(64)],
      ["", "run-001", "a".repeat(65), "-run-0001", "Run-0001", "run_0001"],
    )
    expectCases(
      WorkUnitId,
      ["a", "unit-1_a.b:c", "a".repeat(64)],
      ["", "-unit", "Unit-1", "unit/1", "a".repeat(65)],
    )
    expectCases(AttemptNumber, [1, 2, 3], [0, 4, -1, 1.5, "1"])
    expectCases(ShipAttempt, [1, 2, 42], [0, -1, 1.5, "1"])
    expectCases(WaveIndex, [0, 1, 10], [-1, 1.5, "0"])
    expectCases(MaxConcurrency, [1, 4, 8], [0, 9, -1, 1.5, "1"])
    expectCases(GateExitCode, [0, 1, -1, 127], [1.5, Number.NaN, "0"])
    expectCases(NxProjectName, ["@harness/contract", "app"], ["", "   ", " app", "app "])
    expectCases(
      WorkspaceTreeHash,
      [SHA_64_A, "01234567".repeat(8)],
      ["", "0".repeat(63), "0".repeat(65), "A".repeat(64), "g".repeat(64)],
    )
    expectCases(
      PackageStampHash,
      [SHA_64_B],
      ["", "f".repeat(63), "f".repeat(65), "F".repeat(64), "g".repeat(64)],
    )
    expectCases(
      PlanSha256,
      [SHA_64_C],
      ["", "1".repeat(63), "1".repeat(65), "A".repeat(64), "z".repeat(64)],
    )
    expectCases(StubSymbolKey, ["PlanWorkflowCompiler.decide"], ["", "  ", " a", "a "])
    expectCases(EarsRequirementKey, ["REQ-1.1"], ["", "  ", " REQ-1.1", "REQ-1.1 "])
    expectCases(
      PackageVerifyCommand,
      ["pnpm nx run @harness/contract:verify"],
      ["", "  ", " cmd", "cmd "],
    )
    expectCases(AgentFailureReason, ["timeout"], ["", "  ", " timeout", "timeout "])
    expectCases(WorkflowCompileReason, ["cycle detected"], ["", "  ", " reason", "reason "])
    expectCases(
      SliceBranchName,
      ["slice/epic-unit1", "slice/rfc0013-wf-1"],
      ["", "main", "slice/-a-b", "slice/Upper-a", "slice/a-", "slice/single"],
    )
    expectCases(WorkflowLevel, ["epic", "slice"], ["", "unit", "EPIC"])
    expectCases(ShipStage, [...SHIP_STAGES], ["", "plan-check", "lint"])
    expectCases(RunnerId, [...RUNNER_IDS], ["", "codex"])
    expectCases(FrictionLogState, ["cleared"], ["", "dirty", "pending"])
  })

  it("validates OwnedRelPath against empty, padded, absolute, drive, backslash, and traversal paths (REQ-1.2)", () => {
    expectCases(
      OwnedRelPath,
      ["a.ts", "libs/harness/contract/src/workflow.ts", "a b/c.ts", "a".repeat(512)],
      [
        "",
        "   ",
        " a.ts",
        "a.ts ",
        "/abs/path",
        "C:/win/path",
        "C:rel",
        "a\\b.ts",
        "a//b.ts",
        "a/",
        ".",
        "..",
        "./a.ts",
        "../a.ts",
        "a/./b.ts",
        "a/../b.ts",
        "a/.",
        "a/..",
        "a\0b",
        "a\nb.ts",
        "a\rb.ts",
        "a\tb.ts",
        "a\x7fb.ts",
        "file:etc/passwd",
        "http:a.ts",
        "https://evil.com/a.ts",
        "a".repeat(513),
        null,
      ],
    )
  })

  it("roundtrips closed TaggedUnion and Struct schemas with exhaustive matching", () => {
    const roundtrip = <A, E>(schema: Schema.Codec<A, E, never, never>, value: A): A => {
      const encoded = Schema.encodeSync(schema)(value)
      const decoded = expectDecodeSuccess(schema, encoded)
      expect(decoded).toEqual(value)
      return decoded
    }

    const modes: ReadonlyArray<UnitMode> = [
      {
        _tag: "Automatic",
        runner: RunnerId.make("claude-code"),
        maxConcurrency: MaxConcurrency.make(4),
      },
      { _tag: "Manual" },
    ]
    for (const mode of modes) {
      const decoded = roundtrip(UnitMode, mode)
      const label = match(decoded)
        .with({ _tag: "Automatic" }, (m) => `${m.runner}:${m.maxConcurrency}`)
        .with({ _tag: "Manual" }, () => "manual")
        .exhaustive()
      expect(label.length).toBeGreaterThan(0)
    }

    const sliceUnit: CompiledWorkUnit = {
      _tag: "SliceUnit",
      unitId: WorkUnitId.make("unit-slice-1"),
      branch: SliceBranchName.make("slice/epic-unit1"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src/workflow.ts")],
      earsKeys: [EarsRequirementKey.make("REQ-1.1")],
    }
    const pkgUnit: CompiledWorkUnit = {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make("unit-pkg-1"),
      projectName: NxProjectName.make("@harness/contract"),
      waveIndex: WaveIndex.make(1),
      dependsOn: [WorkUnitId.make("unit-slice-1")],
      ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/test/workflow.test.ts")],
      stubKeys: [StubSymbolKey.make("PlanWorkflowCompiler.decide")],
      earsKeys: [EarsRequirementKey.make("REQ-1.2")],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/contract:verify"),
    }
    for (const unit of [sliceUnit, pkgUnit]) {
      const decoded = roundtrip(CompiledWorkUnit, unit)
      const tag = match(decoded)
        .with({ _tag: "SliceUnit" }, (u) => u.branch)
        .with({ _tag: "PackageUnit" }, (u) => u.projectName)
        .exhaustive()
      expect(tag.length).toBeGreaterThan(0)
    }

    const dep = roundtrip(UnitDependency, {
      from: WorkUnitId.make("unit-slice-1"),
      to: WorkUnitId.make("unit-pkg-1"),
    })
    roundtrip(CompileInput, { units: [sliceUnit, pkgUnit], dependencies: [dep] })

    const wave0 = roundtrip(CompiledWave, { waveIndex: WaveIndex.make(0), units: [sliceUnit] })
    const wave1 = roundtrip(CompiledWave, { waveIndex: WaveIndex.make(1), units: [pkgUnit] })
    roundtrip(CompiledWaves, { units: [sliceUnit, pkgUnit], waves: [wave0, wave1] })

    roundtrip(CompiledPlan, {
      runId: WorkflowRunId.make("run-0001"),
      level: WorkflowLevel.make("epic"),
      planSha: PlanSha256.make(SHA_64_C),
      baseSha: GitCommitSha.make(SHA_40),
      mode: modes[0]!,
      units: [sliceUnit, pkgUnit],
      sharedStepPaths: [OwnedRelPath.make("libs/harness/contract/src/index.ts")],
    })

    const rejections: ReadonlyArray<UnitRejection> = [
      {
        _tag: "WriteSetViolation",
        offendingPaths: [OwnedRelPath.make("libs/harness/contract/src/index.ts")],
      },
      { _tag: "PackageVerifyFailed", exitCode: GateExitCode.make(1) },
      { _tag: "StampMissing" },
      { _tag: "AgentFailed", reason: AgentFailureReason.make("crashed") },
    ]
    for (const rejection of rejections) {
      const decoded = roundtrip(UnitRejection, rejection)
      const code = match(decoded)
        .with({ _tag: "WriteSetViolation" }, (r) => r.offendingPaths.length)
        .with({ _tag: "PackageVerifyFailed" }, (r) => r.exitCode)
        .with({ _tag: "StampMissing" }, () => 0)
        .with({ _tag: "AgentFailed" }, (r) => r.reason.length)
        .exhaustive()
      expect(code).toBeGreaterThanOrEqual(0)
    }

    const escalations: ReadonlyArray<UnitEscalation> = [
      { _tag: "AuthRequired", runner: RunnerId.make("antigravity") },
      { _tag: "RetryBudgetExhausted", lastRejection: rejections[2]! },
      { _tag: "MergeConflict", branch: SliceBranchName.make("slice/epic-unit1") },
    ]
    for (const escalation of escalations) {
      const decoded = roundtrip(UnitEscalation, escalation)
      const desc = match(decoded)
        .with({ _tag: "AuthRequired" }, (e) => e.runner)
        .with({ _tag: "RetryBudgetExhausted" }, (e) => e.lastRejection._tag)
        .with({ _tag: "MergeConflict" }, (e) => e.branch)
        .exhaustive()
      expect(desc.length).toBeGreaterThan(0)
    }

    const completedOutcome: UnitCompletedOutcome = {
      _tag: "Completed",
      unitId: WorkUnitId.make("unit-slice-1"),
      attempt: AttemptNumber.make(1),
      changedPaths: [OwnedRelPath.make("libs/harness/contract/src/workflow.ts")],
      packageStampHash: PackageStampHash.make(SHA_64_B),
    }
    const outcomes: ReadonlyArray<UnitOutcome> = [
      completedOutcome,
      {
        _tag: "Rejected",
        unitId: WorkUnitId.make("unit-pkg-1"),
        attempt: AttemptNumber.make(2),
        rejection: rejections[1]!,
      },
      {
        _tag: "Escalated",
        unitId: WorkUnitId.make("unit-pkg-1"),
        escalation: escalations[0]!,
      },
    ]
    for (const outcome of outcomes) {
      const decoded = roundtrip(UnitOutcome, outcome)
      const summary = match(decoded)
        .with({ _tag: "Completed" }, (o) => o.packageStampHash)
        .with({ _tag: "Rejected" }, (o) => o.rejection._tag)
        .with({ _tag: "Escalated" }, (o) => o.escalation._tag)
        .exhaustive()
      expect(summary.length).toBeGreaterThan(0)
    }

    const llmPhase = roundtrip(LlmPhaseReceipt, {
      workspaceHash: WorkspaceTreeHash.make(SHA_64_A),
      frictionLogCleared: FrictionLogState.make("cleared"),
    })
    roundtrip(TaskRunReceipt, {
      runId: WorkflowRunId.make("run-0001"),
      review: {
        _tag: "ActiveReviewPlan",
        depth: ReviewDepth.make("focused"),
        source: ReviewRoutingSource.make("deterministic"),
        selections: [
          ReviewerSelection.make({
            reviewer: ReviewerId.make("effect-architecture-reviewer"),
            reason: ReviewRoutingReason.make("contract touched"),
            mandatory: true,
          }),
        ],
      },
      completedUnits: [WorkUnitId.make("unit-slice-1")],
      llmPhase,
    })
    roundtrip(ShipReceipt, {
      runId: WorkflowRunId.make("run-0001"),
      attempt: ShipAttempt.make(1),
      verifiedTreeHash: WorkspaceTreeHash.make(SHA_64_A),
    })

    const issues: ReadonlyArray<PlanGraphIssue> = [
      { _tag: "DuplicateWorkUnitId", unitId: WorkUnitId.make("unit-slice-1") },
      {
        _tag: "DanglingUnitDependency",
        from: WorkUnitId.make("unit-slice-1"),
        to: WorkUnitId.make("unit-missing"),
        missingUnitId: WorkUnitId.make("unit-missing"),
      },
    ]
    for (const issue of issues) {
      const decoded = roundtrip(PlanGraphIssue, issue)
      const msg = match(decoded)
        .with({ _tag: "DuplicateWorkUnitId" }, (i) => i.unitId)
        .with({ _tag: "DanglingUnitDependency" }, (i) => i.missingUnitId)
        .exhaustive()
      expect(msg.length).toBeGreaterThan(0)
    }
  })

  it("constructs TaggedErrors with expected _tag and payloads", () => {
    const cycleErr = new CyclicPlanWorkflowError({
      cycleUnits: [WorkUnitId.make("u1"), WorkUnitId.make("u2")],
      reason: WorkflowCompileReason.make("cycle in graph"),
    })
    expect(cycleErr._tag).toBe("CyclicPlanWorkflowError")
    expect(cycleErr.cycleUnits).toEqual([WorkUnitId.make("u1"), WorkUnitId.make("u2")])
    expect(cycleErr.reason).toBe("cycle in graph")

    const disjointErr = new DisjointOwnershipViolationError({
      waveIndex: WaveIndex.make(2),
      overlappingPaths: [OwnedRelPath.make("libs/a.ts")],
    })
    expect(disjointErr._tag).toBe("DisjointOwnershipViolationError")
    expect(disjointErr.waveIndex).toBe(2)
    expect(disjointErr.overlappingPaths).toEqual([OwnedRelPath.make("libs/a.ts")])

    const invalidGraphErr = new InvalidPlanWorkflowGraphError({
      issue: { _tag: "DuplicateWorkUnitId", unitId: WorkUnitId.make("dup") },
      reason: WorkflowCompileReason.make("duplicate id"),
    })
    expect(invalidGraphErr._tag).toBe("InvalidPlanWorkflowGraphError")
    expect(invalidGraphErr.issue._tag).toBe("DuplicateWorkUnitId")
    expect(invalidGraphErr.reason).toBe("duplicate id")
  })

  it("sorts waves ascending by waveIndex and units lexicographically by unitId via wavesOf (REQ-1.3)", () => {
    const makeUnit = (id: string, wave: number): CompiledWorkUnit => ({
      _tag: "PackageUnit",
      unitId: WorkUnitId.make(id),
      projectName: NxProjectName.make("@harness/contract"),
      waveIndex: WaveIndex.make(wave),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make(`libs/${id}.ts`)],
      stubKeys: [],
      earsKeys: [],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/contract:verify"),
    })

    const unsortedUnits: ReadonlyArray<CompiledWorkUnit> = [
      makeUnit("z-w2", 2),
      makeUnit("m-w0", 0),
      makeUnit("a-w2", 2),
      makeUnit("b-w1", 1),
      makeUnit("a-w0", 0),
    ]

    const compiledWaves: CompiledWaves = {
      units: unsortedUnits,
      waves: [],
    }
    const fromWaves = wavesOf(compiledWaves)
    expect(fromWaves.map((w) => w.waveIndex)).toEqual([0, 1, 2])
    expect(fromWaves[0]!.units.map((u) => u.unitId)).toEqual(["a-w0", "m-w0"])
    expect(fromWaves[1]!.units.map((u) => u.unitId)).toEqual(["b-w1"])
    expect(fromWaves[2]!.units.map((u) => u.unitId)).toEqual(["a-w2", "z-w2"])

    const compiledPlan: CompiledPlan = {
      runId: WorkflowRunId.make("run-0001"),
      level: WorkflowLevel.make("slice"),
      planSha: PlanSha256.make(SHA_64_C),
      baseSha: GitCommitSha.make(SHA_40),
      mode: { _tag: "Manual" },
      units: unsortedUnits,
      sharedStepPaths: [],
    }
    const fromPlan = wavesOf(compiledPlan)
    expect(fromPlan).toEqual(fromWaves)

    expect(wavesOf({ units: [], waves: [] })).toEqual([])
  })

  it("enforces distinct compile-time brands for hashes and workflow IDs", () => {
    const treeHash = WorkspaceTreeHash.make(SHA_64_A)
    const stampHash = PackageStampHash.make(SHA_64_B)
    const planSha = PlanSha256.make(SHA_64_C)
    const runId = WorkflowRunId.make("run-0001")
    const unitId = WorkUnitId.make("unit-001")

    // @ts-expect-error WorkspaceTreeHash cannot be assigned to PackageStampHash
    const badStampFromTree: PackageStampHash = treeHash
    // @ts-expect-error PackageStampHash cannot be assigned to PlanSha256
    const badPlanFromStamp: PlanSha256 = stampHash
    // @ts-expect-error PlanSha256 cannot be assigned to WorkspaceTreeHash
    const badTreeFromPlan: WorkspaceTreeHash = planSha
    // @ts-expect-error WorkflowRunId cannot be assigned to WorkUnitId
    const badUnitFromRun: WorkUnitId = runId
    // @ts-expect-error WorkUnitId cannot be assigned to WorkflowRunId
    const badRunFromUnit: WorkflowRunId = unitId

    expect(badStampFromTree).toBe(treeHash)
    expect(badPlanFromStamp).toBe(stampHash)
    expect(badTreeFromPlan).toBe(planSha)
    expect(badUnitFromRun).toBe(runId)
    expect(badRunFromUnit).toBe(unitId)
  })
})
