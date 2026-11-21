import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  AbsoluteRepoRoot,
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
  PackageUnitDraft,
  PackageVerifyCommand,
  PlanSha256,
  RUNNER_IDS,
  ReviewDepth,
  ReviewRoutingReason,
  ReviewRoutingSource,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SHIP_STAGES,
  ShipAttempt,
  ShipReceipt,
  ShipStage,
  SliceBranchName,
  SliceUnitDraft,
  StubSymbolKey,
  TaskRunReceipt,
  UnitDependency,
  UnitMode,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitDraft,
  WorkUnitId,
  WorkflowLevel,
  WorkflowRunId,
  WorkspaceTreeHash,
  compareCodeUnits,
  pathsOverlap,
  wavesOf,
} from "@harness/contract"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { match } from "ts-pattern"
import {
  DEFAULT_STAGE_LATENCY_BUDGETS,
  HarnessBench,
  PlanWorkflowCompiler,
  type SpanSample,
  assertDisjointWave,
  buildStageLatencyMeasurement,
  compileWorkflowWaves,
  decideSpanBudgets,
} from "../src/index.js"

const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

const makeSliceUnit = (id: string, ownedRelPaths: ReadonlyArray<string>): WorkUnitDraft => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make(id),
  branch: SliceBranchName.make(`slice/${id.replace(/[^a-z0-9-]/g, "a")}-unit`),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-2.4")],
})

const makePackageUnit = (id: string, ownedRelPaths: ReadonlyArray<string>): WorkUnitDraft => ({
  _tag: "PackageUnit",
  unitId: WorkUnitId.make(id),
  projectName: NxProjectName.make(`@harness/${id}`),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  stubKeys: [StubSymbolKey.make("PlanWorkflowCompiler.decide")],
  earsKeys: [EarsRequirementKey.make("REQ-2.4")],
  packageVerifyCommand: PackageVerifyCommand.make(`pnpm nx run @harness/${id}:verify`),
})

const makeCompiledSliceUnit = (
  id: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex = 0,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make(id),
  branch: SliceBranchName.make(`slice/${id.replace(/[^a-z0-9-]/g, "a")}-unit`),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-2.4")],
})

const makeCompiledPackageUnit = (
  id: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex = 0,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "PackageUnit",
  unitId: WorkUnitId.make(id),
  projectName: NxProjectName.make(`@harness/${id}`),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  stubKeys: [StubSymbolKey.make("PlanWorkflowCompiler.decide")],
  earsKeys: [EarsRequirementKey.make("REQ-2.4")],
  packageVerifyCommand: PackageVerifyCommand.make(`pnpm nx run @harness/${id}:verify`),
})

const makeDep = (from: string, to: string): UnitDependency => ({
  from: WorkUnitId.make(from),
  to: WorkUnitId.make(to),
})

const extractTypedError = <E>(exit: Exit.Exit<unknown, E>): E =>
  match(exit)
    .with({ _tag: "Success" }, () => {
      expect.unreachable("Expected Failure exit, got Success")
    })
    .with({ _tag: "Failure" }, ({ cause }) => {
      expect(Cause.hasDies(cause)).toBe(false)
      return match(Cause.findErrorOption(cause))
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected typed error in Cause")
        })
        .with({ _tag: "Some" }, ({ value }) => value)
        .exhaustive()
    })
    .exhaustive()

describe("PlanWorkflowCompiler & workflow contracts (RFC-0013 WF-1)", () => {
  it("REQ-1.1 / REQ-1.2 / REQ-1.3: validates contract schemas, receipts, and wavesOf", () => {
    const root = AbsoluteRepoRoot.make("/workspace/effect-ts-harness")
    const sha = GitCommitSha.make("0123456789abcdef0123456789abcdef01234567")
    const runId = WorkflowRunId.make("run-2026-11-17-abc")
    const treeHash = WorkspaceTreeHash.make("a".repeat(64))
    const stampHash = PackageStampHash.make("b".repeat(64))
    const planSha = PlanSha256.make("c".repeat(64))

    expect(root).toBe("/workspace/effect-ts-harness")
    expect(sha).toHaveLength(40)
    expect(SHIP_STAGES).toContain("verify")
    expect(ShipStage.make("verify")).toBe("verify")
    expect(RUNNER_IDS).toContain("antigravity")

    const mode: UnitMode = {
      _tag: "Automatic",
      runner: RunnerId.make("antigravity"),
      maxConcurrency: MaxConcurrency.make(2),
    }
    const outcome: UnitOutcome = {
      _tag: "Completed",
      unitId: WorkUnitId.make("unit-a"),
      attempt: AttemptNumber.make(1),
      changedPaths: [OwnedRelPath.make("libs/harness/gates/src/plan-workflow-compiler.ts")],
      packageStampHash: stampHash,
    }
    const llmPhase: LlmPhaseReceipt = {
      workspaceHash: treeHash,
      frictionLogCleared: FrictionLogState.make("cleared"),
    }
    const taskReceipt: TaskRunReceipt = {
      runId,
      planSha,
      review: {
        _tag: "SkipReviewPlan",
        depth: ReviewDepth.make("skip"),
        source: ReviewRoutingSource.make("deterministic"),
        reason: ReviewRoutingReason.make("No diff"),
        selections: [],
      },
      completedUnits: [WorkUnitId.make("unit-a")],
      llmPhase,
    }
    const shipReceipt: ShipReceipt = {
      runId,
      planSha,
      attempt: ShipAttempt.make(1),
      verifiedTreeHash: treeHash,
    }

    expect(outcome._tag).toBe("Completed")
    expect(taskReceipt.completedUnits).toEqual([WorkUnitId.make("unit-a")])
    expect(shipReceipt.attempt).toBe(1)

    const unitZ = makeCompiledSliceUnit("unit-z", ["libs/a/z.ts"], 1)
    const unitA = makeCompiledPackageUnit("unit-a", ["libs/a/a.ts"], 1)
    const unitRoot = makeCompiledSliceUnit("unit-0", ["libs/a/root.ts"], 0)

    const compiledPlan: CompiledPlan = {
      runId,
      level: WorkflowLevel.make("slice"),
      planSha,
      baseSha: sha,
      mode,
      units: [unitZ, unitA, unitRoot],
      sharedStepPaths: [OwnedRelPath.make("libs/harness/contract/src/workflow.ts")],
    }

    const grouped = wavesOf(compiledPlan)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]?.waveIndex).toBe(0)
    expect(grouped[0]?.units.map((u) => u.unitId)).toEqual(["unit-0"])
    expect(grouped[1]?.waveIndex).toBe(1)
    expect(grouped[1]?.units.map((u) => u.unitId)).toEqual(["unit-a", "unit-z"])

    const wavesWrapper: CompiledWaves = {
      units: [unitZ, unitA, unitRoot],
    }
    expect(wavesOf(wavesWrapper)).toEqual(grouped)

    expect(() => Schema.decodeSync(OwnedRelPath)("../escape.ts")).toThrow()
    expect(() => Schema.decodeSync(OwnedRelPath)("C:\\win\\path.ts")).toThrow()
    expect(() => Schema.decodeSync(OwnedRelPath)("  padded.ts  ")).toThrow()
  })

  it.effect("REQ-2.4: handles empty input, single unit, diamond DAG, and mixed unit types", () =>
    Effect.gen(function* () {
      const emptyResult = yield* compileWorkflowWaves({ units: [], dependencies: [] })
      expect(emptyResult.units).toEqual([])
      expect(wavesOf(emptyResult)).toEqual([])

      const singleUnit = makeSliceUnit("solo", ["libs/solo/a.ts"])
      const singleResult = yield* PlanWorkflowCompiler.decide({
        units: [singleUnit],
        dependencies: [],
      })
      const singleWaves = wavesOf(singleResult)
      expect(singleWaves).toHaveLength(1)
      expect(singleWaves[0]?.waveIndex).toBe(0)
      expect(singleResult.units[0]?.waveIndex).toBe(0)

      const diamondUnits = [
        makeSliceUnit("d", ["libs/d/index.ts"]),
        makePackageUnit("c", ["libs/c/index.ts"]),
        makePackageUnit("b", ["libs/b/index.ts"]),
        makeSliceUnit("a", ["libs/a/index.ts"]),
      ]
      const diamondDeps = [
        makeDep("a", "b"),
        makeDep("a", "c"),
        makeDep("b", "d"),
        makeDep("c", "d"),
        makeDep("a", "b"), // duplicate edge handled cleanly
      ]

      const { result, spans } = yield* runWithTestTracer(
        "PlanWorkflowCompiler.diamond",
        PlanWorkflowCompiler.decide({ units: diamondUnits, dependencies: diamondDeps }),
        emptyFnIndex,
      )

      const diamondWaves = wavesOf(result)
      expect(diamondWaves).toHaveLength(3)
      expect(diamondWaves[0]?.units.map((u) => u.unitId)).toEqual(["a"])
      expect(diamondWaves[1]?.units.map((u) => u.unitId)).toEqual(["b", "c"])
      expect(diamondWaves[2]?.units.map((u) => u.unitId)).toEqual(["d"])
      expect(PlanWorkflowCompiler.wavesOf(result)).toEqual(diamondWaves)

      const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
        spanId: s.spanId,
        name: s.name,
        parentSpanId: s.parentSpanId,
        durationMs: s.durationMs,
        startTimeMs: s.startTimeMs,
        endTimeMs: s.endTimeMs,
        exitTag: match(s.exitTag)
          .with("Success", () => "Success" as const)
          .with("Failure", () => "Failure" as const)
          .with("Defect", () => "Defect" as const)
          .with("Interrupt", () => "Failure" as const)
          .with(undefined, () => undefined)
          .exhaustive(),
        errorTag: s.errorTag,
      }))
      const budgetViolations = yield* decideSpanBudgets({ spans: spanSamples })
      expect(budgetViolations).toEqual([])
      expect(spans.some((s) => s.name === "PlanWorkflowCompiler.decide")).toBe(true)
      expect(spans.some((s) => s.name === "PlanWorkflowCompiler.assertDisjoint")).toBe(true)
    }),
  )

  it.effect(
    "REQ-2.4 / REQ-2.5: splits write-conflicting units at same level and preserves dependency monotonicity",
    () =>
      Effect.gen(function* () {
        const units = [
          makeSliceUnit("a", ["libs/shared/a.ts"]),
          makeSliceUnit("b", ["libs/shared/conflict.ts", "libs/shared/conflict.ts"]),
          makeSliceUnit("c", ["libs/shared/conflict.ts"]),
          makeSliceUnit("d", ["libs/shared/other.ts"]),
          makePackageUnit("e", ["libs/shared/e.ts"]),
        ]
        const dependencies = [
          makeDep("a", "b"),
          makeDep("a", "c"),
          makeDep("a", "d"),
          makeDep("b", "e"),
        ]

        const compiled = yield* PlanWorkflowCompiler.decide({ units, dependencies })

        // Level 0: [a] -> wave 0
        // Level 1: b (conflict.ts), c (conflict.ts), d (other.ts)
        // Sorted by unitId: b, c, d -> b & d fit in wave 1, c goes to wave 2
        // Level 2: [e] -> wave 3
        expect(wavesOf(compiled).map((w) => w.units.map((u) => u.unitId))).toEqual([
          ["a"],
          ["b", "d"],
          ["c"],
          ["e"],
        ])

        const waveByUnit = new Map(compiled.units.map((u) => [u.unitId, u.waveIndex]))
        for (const dep of dependencies) {
          expect(waveByUnit.get(dep.from)!).toBeLessThan(waveByUnit.get(dep.to)!)
        }

        // Single unit with duplicate ownedRelPaths passes assertDisjointWave
        const singleDupWave: CompiledWave = {
          waveIndex: WaveIndex.make(0),
          units: [makeCompiledSliceUnit("dup-self", ["libs/x/a.ts", "libs/x/a.ts"])],
        }
        const checked = yield* assertDisjointWave(singleDupWave)
        expect(checked.waveIndex).toBe(0)
      }),
  )

  it.effect(
    "REQ-2.1 / REQ-2.2 / REQ-2.3 / REQ-2.5 (SAT-01): captures all typed failure modes on traced spans",
    () =>
      Effect.gen(function* () {
        // 1. DuplicateWorkUnitId
        const { result: dupExit, spans: dupSpans } = yield* runWithTestTracer(
          "PlanWorkflowCompiler.dupId",
          Effect.exit(
            PlanWorkflowCompiler.decide({
              units: [makeSliceUnit("u1", ["libs/a.ts"]), makeSliceUnit("u1", ["libs/b.ts"])],
              dependencies: [],
            }),
          ),
          emptyFnIndex,
        )
        const dupErr = extractTypedError(dupExit)
        expect(dupErr).toBeInstanceOf(InvalidPlanWorkflowGraphError)
        if (dupErr instanceof InvalidPlanWorkflowGraphError) {
          match(dupErr.issue)
            .with({ _tag: "DuplicateWorkUnitId" }, (issue) => {
              expect(issue.unitId).toBe("u1")
            })
            .with({ _tag: "DanglingUnitDependency" }, () => {
              expect.unreachable("Expected DuplicateWorkUnitId")
            })
            .exhaustive()
        }
        expect(
          dupSpans.some(
            (s) =>
              s.name === "PlanWorkflowCompiler.decide" &&
              s.exitTag === "Failure" &&
              s.errorTag === "InvalidPlanWorkflowGraphError",
          ),
        ).toBe(true)

        // 2. DanglingUnitDependency (missing from and missing to)
        const danglingFromExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [makeSliceUnit("u1", ["libs/a.ts"])],
            dependencies: [makeDep("missing-from", "u1")],
          }),
        )
        const danglingFromErr = extractTypedError(danglingFromExit)
        expect(danglingFromErr).toBeInstanceOf(InvalidPlanWorkflowGraphError)
        if (danglingFromErr instanceof InvalidPlanWorkflowGraphError) {
          expect(danglingFromErr.message).toContain("missing-from")
          match(danglingFromErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.missingUnitIds).toEqual([WorkUnitId.make("missing-from")])
            })
            .with({ _tag: "DuplicateWorkUnitId" }, () => {
              expect.unreachable("Expected DanglingUnitDependency")
            })
            .exhaustive()
        }

        const danglingToExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [makeSliceUnit("u1", ["libs/a.ts"])],
            dependencies: [makeDep("u1", "missing-to")],
          }),
        )
        const danglingToErr = extractTypedError(danglingToExit)
        expect(danglingToErr).toBeInstanceOf(InvalidPlanWorkflowGraphError)
        if (danglingToErr instanceof InvalidPlanWorkflowGraphError) {
          expect(danglingToErr.message).toContain("missing-to")
          match(danglingToErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.missingUnitIds).toEqual([WorkUnitId.make("missing-to")])
            })
            .with({ _tag: "DuplicateWorkUnitId" }, () => {
              expect.unreachable("Expected DanglingUnitDependency")
            })
            .exhaustive()
        }

        // 3. Self-loop cycle
        const { result: selfLoopExit, spans: selfLoopSpans } = yield* runWithTestTracer(
          "PlanWorkflowCompiler.selfLoop",
          Effect.exit(
            PlanWorkflowCompiler.decide({
              units: [makeSliceUnit("self", ["libs/self.ts"])],
              dependencies: [makeDep("self", "self")],
            }),
          ),
          emptyFnIndex,
        )
        const selfLoopErr = extractTypedError(selfLoopExit)
        expect(selfLoopErr).toBeInstanceOf(CyclicPlanWorkflowError)
        if (selfLoopErr instanceof CyclicPlanWorkflowError) {
          expect(selfLoopErr.cycleUnits).toEqual(["self"])
        }
        expect(
          selfLoopSpans.some(
            (s) =>
              s.name === "PlanWorkflowCompiler.decide" &&
              s.exitTag === "Failure" &&
              s.errorTag === "CyclicPlanWorkflowError",
          ),
        ).toBe(true)

        // 3b. Healthy u1 + self-loop u2 -> cycleUnits must be ["u2"] (not units[0])
        const twoUnitSelfLoopExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [makeSliceUnit("u1", ["libs/u1.ts"]), makeSliceUnit("u2", ["libs/u2.ts"])],
            dependencies: [makeDep("u2", "u2")],
          }),
        )
        const twoUnitSelfLoopErr = extractTypedError(twoUnitSelfLoopExit)
        expect(twoUnitSelfLoopErr).toBeInstanceOf(CyclicPlanWorkflowError)
        if (twoUnitSelfLoopErr instanceof CyclicPlanWorkflowError) {
          expect(twoUnitSelfLoopErr.cycleUnits).toEqual(["u2"])
        }

        // 4. 3-node cycle with acyclic lead-in and tail, plus disconnected second SCC
        const cycleExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [
              makeSliceUnit("lead", ["libs/lead.ts"]),
              makeSliceUnit("c1", ["libs/c1.ts"]),
              makeSliceUnit("c2", ["libs/c2.ts"]),
              makeSliceUnit("c3", ["libs/c3.ts"]),
              makeSliceUnit("tail", ["libs/tail.ts"]),
              makeSliceUnit("d1", ["libs/d1.ts"]),
              makeSliceUnit("d2", ["libs/d2.ts"]),
            ],
            dependencies: [
              makeDep("lead", "c1"),
              makeDep("c1", "c2"),
              makeDep("c2", "c3"),
              makeDep("c3", "c1"),
              makeDep("c3", "tail"),
              makeDep("d1", "d2"),
              makeDep("d2", "d1"),
            ],
          }),
        )
        const cycleErr = extractTypedError(cycleExit)
        expect(cycleErr).toBeInstanceOf(CyclicPlanWorkflowError)
        if (cycleErr instanceof CyclicPlanWorkflowError) {
          expect(cycleErr.cycleUnits).toEqual(["c1", "c2", "c3", "d1", "d2"])
        }

        // 5. DisjointOwnershipViolationError on assertDisjoint
        const { result: disjointExit, spans: disjointSpans } = yield* runWithTestTracer(
          "PlanWorkflowCompiler.assertDisjointFail",
          Effect.exit(
            PlanWorkflowCompiler.assertDisjoint({
              waveIndex: WaveIndex.make(2),
              units: [
                makeCompiledSliceUnit("u1", ["libs/z.ts", "libs/a.ts"], 2),
                makeCompiledSliceUnit("u2", ["libs/a.ts", "libs/z.ts"], 2),
              ],
            }),
          ),
          emptyFnIndex,
        )
        const disjointErr = extractTypedError(disjointExit)
        expect(disjointErr).toBeInstanceOf(DisjointOwnershipViolationError)
        if (disjointErr instanceof DisjointOwnershipViolationError) {
          expect(disjointErr.waveIndex).toBe(2)
          expect(disjointErr.overlappingPaths).toEqual(["libs/a.ts", "libs/z.ts"])
        }
        expect(
          disjointSpans.some(
            (s) =>
              s.name === "PlanWorkflowCompiler.assertDisjoint" &&
              s.exitTag === "Failure" &&
              s.errorTag === "DisjointOwnershipViolationError",
          ),
        ).toBe(true)
      }),
  )

  it.effect(
    "REQ-2.2 / REQ-2.3 / REQ-2.4: deduplicates and sorts dependencies into compiled dependsOn and catches dangling/cyclic deps",
    () =>
      Effect.gen(function* () {
        const compiled = yield* PlanWorkflowCompiler.decide({
          units: [
            makeSliceUnit("a", ["libs/a.ts"]),
            makePackageUnit("b", ["libs/b.ts"]),
            makeSliceUnit("c", ["libs/c.ts"]),
          ],
          dependencies: [
            makeDep("a", "b"),
            makeDep("b", "c"),
            makeDep("a", "c"),
            makeDep("b", "c"),
          ],
        })

        expect(wavesOf(compiled).map((w) => w.units.map((u) => u.unitId))).toEqual([
          ["a"],
          ["b"],
          ["c"],
        ])
        const byId = new Map(compiled.units.map((u) => [u.unitId, u]))
        expect(byId.get(WorkUnitId.make("a"))?.dependsOn).toEqual([])
        expect(byId.get(WorkUnitId.make("b"))?.dependsOn).toEqual(["a"])
        expect(byId.get(WorkUnitId.make("c"))?.dependsOn).toEqual(["a", "b"])

        const danglingExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [makeSliceUnit("u1", ["libs/u1.ts"])],
            dependencies: [makeDep("missing-dep", "u1")],
          }),
        )
        const danglingErr = extractTypedError(danglingExit)
        expect(danglingErr).toBeInstanceOf(InvalidPlanWorkflowGraphError)
        if (danglingErr instanceof InvalidPlanWorkflowGraphError) {
          expect(danglingErr.message).toContain("missing-dep")
          match(danglingErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.from).toBe("missing-dep")
              expect(issue.to).toBe("u1")
              expect(issue.missingUnitIds).toEqual([WorkUnitId.make("missing-dep")])
            })
            .with({ _tag: "DuplicateWorkUnitId" }, () => {
              expect.unreachable("Expected DanglingUnitDependency")
            })
            .exhaustive()
        }

        const cyclicExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [makeSliceUnit("x", ["libs/x.ts"]), makeSliceUnit("y", ["libs/y.ts"])],
            dependencies: [makeDep("x", "y"), makeDep("y", "x")],
          }),
        )
        const cyclicErr = extractTypedError(cyclicExit)
        expect(cyclicErr).toBeInstanceOf(CyclicPlanWorkflowError)
        if (cyclicErr instanceof CyclicPlanWorkflowError) {
          expect(cyclicErr.cycleUnits).toEqual(["x", "y"])
        }
      }),
  )

  it.effect(
    "REQ-2.3: isolates 2-node cycle (a <-> b) and excludes upstream (c -> a) and downstream (b -> d) acyclic nodes",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [
              makeSliceUnit("c", ["libs/c.ts"]),
              makeSliceUnit("a", ["libs/a.ts"]),
              makeSliceUnit("b", ["libs/b.ts"]),
              makeSliceUnit("d", ["libs/d.ts"]),
            ],
            dependencies: [
              makeDep("c", "a"),
              makeDep("a", "b"),
              makeDep("b", "a"),
              makeDep("b", "d"),
            ],
          }),
        )
        const err = extractTypedError(exit)
        expect(err).toBeInstanceOf(CyclicPlanWorkflowError)
        match(err)
          .with({ _tag: "CyclicPlanWorkflowError" }, (cycleErr) => {
            expect(cycleErr.cycleUnits).toEqual([WorkUnitId.make("a"), WorkUnitId.make("b")])
          })
          .with({ _tag: "InvalidPlanWorkflowGraphError" }, () => {
            expect.unreachable("Expected CyclicPlanWorkflowError")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "REQ-2.2: reports DanglingUnitDependency with exact from/to/missingUnitIds for missing dep.from, dep.to, and both",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly label: string
          readonly input: CompileInput
          readonly expectedFrom: string
          readonly expectedTo: string
          readonly expectedMissing: ReadonlyArray<string>
        }> = [
          {
            label: "input.dependencies missing dep.from",
            input: {
              units: [makeSliceUnit("u1", ["libs/u1.ts"])],
              dependencies: [makeDep("ghost-from", "u1")],
            },
            expectedFrom: "ghost-from",
            expectedTo: "u1",
            expectedMissing: ["ghost-from"],
          },
          {
            label: "input.dependencies missing dep.to",
            input: {
              units: [makeSliceUnit("u1", ["libs/u1.ts"])],
              dependencies: [makeDep("u1", "ghost-to")],
            },
            expectedFrom: "u1",
            expectedTo: "ghost-to",
            expectedMissing: ["ghost-to"],
          },
          {
            label: "input.dependencies missing both dep.from and dep.to",
            input: {
              units: [makeSliceUnit("u1", ["libs/u1.ts"])],
              dependencies: [makeDep("ghost-from", "ghost-to")],
            },
            expectedFrom: "ghost-from",
            expectedTo: "ghost-to",
            expectedMissing: ["ghost-from", "ghost-to"],
          },
        ]

        for (const testCase of cases) {
          const exit = yield* Effect.exit(PlanWorkflowCompiler.decide(testCase.input))
          const err = extractTypedError(exit)
          expect(err, testCase.label).toBeInstanceOf(InvalidPlanWorkflowGraphError)
          match(err)
            .with({ _tag: "InvalidPlanWorkflowGraphError" }, (invalidErr) =>
              match(invalidErr.issue)
                .with({ _tag: "DanglingUnitDependency" }, (issue) => {
                  expect(issue.from, testCase.label).toBe(WorkUnitId.make(testCase.expectedFrom))
                  expect(issue.to, testCase.label).toBe(WorkUnitId.make(testCase.expectedTo))
                  expect(issue.missingUnitIds, testCase.label).toEqual(
                    testCase.expectedMissing.map((m) => WorkUnitId.make(m)),
                  )
                })
                .with({ _tag: "DuplicateWorkUnitId" }, () => {
                  expect.unreachable(`Expected DanglingUnitDependency for ${testCase.label}`)
                })
                .exhaustive(),
            )
            .with({ _tag: "CyclicPlanWorkflowError" }, () => {
              expect.unreachable(`Expected InvalidPlanWorkflowGraphError for ${testCase.label}`)
            })
            .exhaustive()
        }
      }),
  )

  it.effect.prop(
    "REQ-1.1 property: AbsoluteRepoRoot rejects arbitrary strings with ASCII 0x00..0x1f / 0x7f control chars and accepts valid multi-segment POSIX paths <= 1024 chars",
    {
      raw: Schema.String,
      ctrlIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 32 }))),
      segments: Schema.Array(
        Schema.NonEmptyString.pipe(
          Schema.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,15}$/)),
        ),
      ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))),
    },
    ({ raw, ctrlIdx, segments }) =>
      Effect.sync(() => {
        const ctrlCode = ctrlIdx === 32 ? 0x7f : ctrlIdx
        const ctrlChar = String.fromCharCode(ctrlCode)
        const injected = `/repo${ctrlChar}${raw}sub`
        const rejectedExit = Schema.decodeExit(AbsoluteRepoRoot)(injected)
        match(rejectedExit)
          .with({ _tag: "Failure" }, () => undefined)
          .with({ _tag: "Success" }, () => {
            expect.unreachable(
              `Expected AbsoluteRepoRoot to reject control char 0x${ctrlCode.toString(16)}`,
            )
          })
          .exhaustive()

        const validPosix = `/${segments.join("/")}`
        expect(validPosix.length).toBeLessThanOrEqual(1024)
        const acceptedExit = Schema.decodeExit(AbsoluteRepoRoot)(validPosix)
        match(acceptedExit)
          .with({ _tag: "Success" }, ({ value }) => {
            expect(value).toBe(validPosix)
          })
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect.unreachable(
              `Expected valid POSIX path '${validPosix}' to decode: ${Cause.pretty(cause)}`,
            )
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "REQ-1.2 property: CompiledWorkUnit and UnitOutcome roundtrip via Schema.encodeSync / Schema.decodeUnknownSync",
    {
      unit: CompiledWorkUnit,
      outcome: UnitOutcome,
    },
    ({ unit, outcome }) =>
      Effect.gen(function* () {
        const encodedUnit: unknown = yield* Schema.encodeEffect(CompiledWorkUnit)(unit)
        const decodedUnit = yield* Schema.decodeUnknownEffect(CompiledWorkUnit)(encodedUnit)
        expect(decodedUnit).toEqual(unit)

        const encodedOutcome: unknown = yield* Schema.encodeEffect(UnitOutcome)(outcome)
        const decodedOutcome = yield* Schema.decodeUnknownEffect(UnitOutcome)(encodedOutcome)
        expect(decodedOutcome).toEqual(outcome)
      }),
  )

  it.effect.prop(
    "REQ-1.3 property: wavesOf groups arbitrary unsorted CompiledWorkUnit[] by ascending waveIndex and lexicographic unitId",
    {
      units: Schema.Array(CompiledWorkUnit),
    },
    ({ units }) =>
      Effect.sync(() => {
        const grouped = wavesOf({ units })
        const totalUnits = grouped.reduce((sum, w) => sum + w.units.length, 0)
        expect(totalUnits).toBe(units.length)

        for (let i = 0; i < grouped.length; i++) {
          const wave = grouped[i]!
          if (i > 0) {
            expect(wave.waveIndex).toBeGreaterThan(grouped[i - 1]!.waveIndex)
          }
          const ids = wave.units.map((u) => u.unitId)
          expect(ids).toEqual([...ids].sort(compareCodeUnits))
          for (const unit of wave.units) {
            expect(unit.waveIndex).toBe(wave.waveIndex)
          }
        }
      }),
  )

  it.effect.prop(
    "REQ-2.4 property: guaranteed-acyclic CompileInput with shared paths satisfies monotonicity, dependsOn sync, disjointness, and determinism",
    {
      units: Schema.Array(WorkUnitDraft),
      dependencies: Schema.Array(UnitDependency),
    },
    ({ units, dependencies }) =>
      Effect.gen(function* () {
        // 1. Raw arbitrary CompileInput must never defect
        const rawInput: CompileInput = { units, dependencies }
        const rawExit = yield* Effect.exit(PlanWorkflowCompiler.decide(rawInput))
        match(rawExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
          })
          .with({ _tag: "Success" }, () => undefined)
          .exhaustive()

        // 2. Guaranteed-acyclic DAG projection with shared write-set pool
        const sharedPool = [
          OwnedRelPath.make("libs/shared/p0.ts"),
          OwnedRelPath.make("libs/shared/p1.ts"),
          OwnedRelPath.make("libs/shared/p2.ts"),
        ]
        const indexById = new Map<WorkUnitId, number>()
        const dagUnits: Array<WorkUnitDraft> = []
        const candidateEdges: Array<{ readonly from: WorkUnitId; readonly to: WorkUnitId }> = []

        for (const u of units) {
          if (indexById.has(u.unitId)) continue
          const nodeIdx = dagUnits.length
          indexById.set(u.unitId, nodeIdx)
          const projectedPaths = u.ownedRelPaths.map((p, pIdx) =>
            pIdx % 2 === 0 ? sharedPool[(nodeIdx + pIdx) % sharedPool.length]! : p,
          )
          dagUnits.push(
            match(u)
              .with({ _tag: "SliceUnit" }, (s) => ({
                ...s,
                ownedRelPaths: projectedPaths,
              }))
              .with({ _tag: "PackageUnit" }, (p) => ({
                ...p,
                ownedRelPaths: projectedPaths,
              }))
              .exhaustive(),
          )
        }

        for (const d of dependencies) {
          candidateEdges.push(d)
        }

        const dagDeps: Array<UnitDependency> = []
        if (dagUnits.length >= 2) {
          for (let eIdx = 0; eIdx < candidateEdges.length; eIdx++) {
            const edge = candidateEdges[eIdx]!
            const i = indexById.get(edge.from) ?? eIdx % dagUnits.length
            const j = indexById.get(edge.to) ?? (eIdx + 1) % dagUnits.length
            if (i === j) continue
            const lo = Math.min(i, j)
            const hi = Math.max(i, j)
            dagDeps.push({ from: dagUnits[lo]!.unitId, to: dagUnits[hi]!.unitId })
          }
        }

        const exit1 = yield* Effect.exit(
          PlanWorkflowCompiler.decide({ units: dagUnits, dependencies: dagDeps }),
        )
        const exit2 = yield* Effect.exit(
          PlanWorkflowCompiler.decide({ units: dagUnits, dependencies: dagDeps }),
        )

        const compiled = match(exit1)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect.unreachable(`Guaranteed-acyclic DAG failed: ${Cause.pretty(cause)}`)
          })
          .with({ _tag: "Success" }, ({ value }) => value)
          .exhaustive()

        match(exit2)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect.unreachable(`Second DAG run failed: ${Cause.pretty(cause)}`)
          })
          .with({ _tag: "Success" }, ({ value: compiled2 }) => {
            expect(compiled).toEqual(compiled2)
          })
          .exhaustive()

        expect(compiled.units).toHaveLength(dagUnits.length)
        expect(new Set(compiled.units.map((u) => u.unitId))).toEqual(new Set(indexById.keys()))

        const expectedPreds = new Map<WorkUnitId, Set<WorkUnitId>>()
        for (const u of dagUnits) {
          expectedPreds.set(u.unitId, new Set())
        }
        for (const dep of dagDeps) {
          expectedPreds.get(dep.to)?.add(dep.from)
        }

        const waveByUnit = new Map(compiled.units.map((u) => [u.unitId, u.waveIndex]))
        for (const dep of dagDeps) {
          expect(waveByUnit.get(dep.from)!).toBeLessThan(waveByUnit.get(dep.to)!)
        }

        for (const u of compiled.units) {
          const sortedExpected = [...(expectedPreds.get(u.unitId) ?? new Set())].sort(
            compareCodeUnits,
          )
          expect(u.dependsOn).toEqual(sortedExpected)
        }

        const compiledWaves = wavesOf(compiled)
        for (const wave of compiledWaves) {
          yield* assertDisjointWave(wave)
        }
      }),
  )

  it.effect("REQ-2.6 (PERF-09): 50-unit 200-edge DAG compiles within latency SLO budgets", () =>
    Effect.gen(function* () {
      const units: Array<WorkUnitDraft> = []
      for (let layer = 0; layer < 5; layer++) {
        for (let col = 0; col < 10; col++) {
          const idx = layer * 10 + col
          units.push(
            makeSliceUnit(`u-${String(idx).padStart(2, "0")}`, [`libs/mod-${idx}/index.ts`]),
          )
        }
      }

      // 4 layer transitions * 50 edges per transition = 200 deterministic edges
      const dependencies: Array<UnitDependency> = []
      for (let layer = 0; layer < 4; layer++) {
        for (let fromCol = 0; fromCol < 10; fromCol++) {
          for (let offset = 0; offset < 5; offset++) {
            const toCol = (fromCol + offset) % 10
            const fromIdx = layer * 10 + fromCol
            const toIdx = (layer + 1) * 10 + toCol
            dependencies.push(
              makeDep(
                `u-${String(fromIdx).padStart(2, "0")}`,
                `u-${String(toIdx).padStart(2, "0")}`,
              ),
            )
          }
        }
      }
      expect(dependencies).toHaveLength(200)

      const input: CompileInput = { units, dependencies }

      const { result: compiled, spans } = yield* runWithTestTracer(
        "PlanWorkflowCompiler.perf09",
        PlanWorkflowCompiler.decide(input),
        emptyFnIndex,
      )
      expect(compiled.units).toHaveLength(50)
      expect(wavesOf(compiled)).toHaveLength(5)

      const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
        spanId: s.spanId,
        name: s.name,
        parentSpanId: s.parentSpanId,
        durationMs: s.durationMs,
        startTimeMs: s.startTimeMs,
        endTimeMs: s.endTimeMs,
        exitTag: match(s.exitTag)
          .with("Success", () => "Success" as const)
          .with("Failure", () => "Failure" as const)
          .with("Defect", () => "Defect" as const)
          .with("Interrupt", () => "Failure" as const)
          .with(undefined, () => undefined)
          .exhaustive(),
        errorTag: s.errorTag,
      }))
      const spanViolations = yield* decideSpanBudgets({ spans: spanSamples })
      expect(spanViolations).toEqual([])

      const passMeasurement = buildStageLatencyMeasurement(
        "PlanWorkflowCompiler.decide",
        [0.4, 0.5, 0.6, 0.7, 0.8],
      )
      const benchReport = yield* HarnessBench.decide({
        measurements: [passMeasurement],
        budgets: DEFAULT_STAGE_LATENCY_BUDGETS,
      })
      expect(benchReport.status).toBe("pass")

      const failMeasurement = buildStageLatencyMeasurement(
        "PlanWorkflowCompiler.decide",
        [500, 600, 700, 800, 900],
      )
      const sloErr = yield* Effect.flip(
        HarnessBench.decide({
          measurements: [failMeasurement],
          budgets: DEFAULT_STAGE_LATENCY_BUDGETS,
        }),
      )
      expect(sloErr._tag).toBe("LatencySloViolationError")
    }),
  )

  it.effect(
    "REQ-2.5: prefix ownership overlap prevents same-wave execution while sibling prefixes remain parallel",
    () =>
      Effect.gen(function* () {
        expect(pathsOverlap(OwnedRelPath.make("libs/a"), OwnedRelPath.make("libs/a/sub.ts"))).toBe(
          true,
        )
        expect(pathsOverlap(OwnedRelPath.make("libs/a"), OwnedRelPath.make("libs/ab"))).toBe(false)

        const compiled = yield* PlanWorkflowCompiler.decide({
          units: [
            makeSliceUnit("u-dir", ["libs/a"]),
            makeSliceUnit("u-sub", ["libs/a/sub.ts"]),
            makeSliceUnit("u-sib", ["libs/ab"]),
          ],
          dependencies: [],
        })
        expect(wavesOf(compiled).map((w) => w.units.map((u) => u.unitId))).toEqual([
          ["u-dir", "u-sib"],
          ["u-sub"],
        ])
      }),
  )

  it.effect(
    "REQ-2.4: compilation is deterministic under input unit and dependency permutation",
    () =>
      Effect.gen(function* () {
        const units: ReadonlyArray<WorkUnitDraft> = [
          makeSliceUnit("u1", ["libs/u1.ts"]),
          makePackageUnit("u2", ["libs/u2.ts"]),
          makeSliceUnit("u3", ["libs/shared.ts"]),
          makeSliceUnit("u4", ["libs/shared.ts"]),
          makePackageUnit("u5", ["libs/u5.ts"]),
        ]
        const deps: ReadonlyArray<UnitDependency> = [
          makeDep("u1", "u3"),
          makeDep("u1", "u4"),
          makeDep("u2", "u5"),
          makeDep("u3", "u5"),
        ]
        const baseline = yield* PlanWorkflowCompiler.decide({ units, dependencies: deps })
        const permuted = yield* PlanWorkflowCompiler.decide({
          units: [units[4]!, units[2]!, units[0]!, units[3]!, units[1]!],
          dependencies: [deps[3]!, deps[1]!, deps[0]!, deps[2]!],
        })
        expect(JSON.stringify(permuted)).toBe(JSON.stringify(baseline))
        expect(JSON.stringify(wavesOf(permuted))).toBe(JSON.stringify(wavesOf(baseline)))
      }),
  )

  it("REQ-1.2: rejects invalid WriteSetViolation, PackageVerifyCommand, and GateExitCode payloads", () => {
    const validRej = Schema.decodeSync(UnitRejection)({
      _tag: "WriteSetViolation",
      offendingPaths: [OwnedRelPath.make("libs/a/x.ts")],
    })
    expect(validRej._tag).toBe("WriteSetViolation")

    const assertDecodeFailure = (exit: Exit.Exit<unknown, unknown>, label: string): void => {
      match(exit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasDies(cause), label).toBe(false)
          expect(Cause.hasFails(cause), label).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable(`Expected decode failure for ${label}`)
        })
        .exhaustive()
    }

    assertDecodeFailure(
      Schema.decodeUnknownExit(UnitRejection)({
        _tag: "WriteSetViolation",
        offendingPaths: [],
      }),
      "empty WriteSetViolation.offendingPaths",
    )
    assertDecodeFailure(Schema.decodeExit(PackageVerifyCommand)(""), "empty PackageVerifyCommand")
    assertDecodeFailure(Schema.decodeExit(GateExitCode)(0), "GateExitCode 0")
    assertDecodeFailure(Schema.decodeExit(GateExitCode)(256), "GateExitCode 256")
  })

  it.effect(
    "S-5.1: rejects reserved SHARED_STEP_UNIT_ID ('shared-step') in draft schemas and PlanWorkflowCompiler.decide",
    () =>
      Effect.gen(function* () {
        const reservedSlice = makeSliceUnit(SHARED_STEP_UNIT_ID, ["libs/shared/a.ts"])
        const reservedPackage = makePackageUnit(SHARED_STEP_UNIT_ID, ["libs/shared/b.ts"])

        const sliceDecodeExit = Schema.decodeUnknownExit(SliceUnitDraft)(reservedSlice)
        match(sliceDecodeExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            expect(Cause.hasFails(cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected SliceUnitDraft to reject reserved shared-step unitId")
          })
          .exhaustive()

        const pkgDecodeExit = Schema.decodeUnknownExit(PackageUnitDraft)(reservedPackage)
        match(pkgDecodeExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            expect(Cause.hasFails(cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected PackageUnitDraft to reject reserved shared-step unitId")
          })
          .exhaustive()

        for (const reservedUnit of [reservedSlice, reservedPackage]) {
          const exit = yield* Effect.exit(
            PlanWorkflowCompiler.decide({
              units: [reservedUnit],
              dependencies: [],
            }),
          )
          const err = extractTypedError(exit)
          expect(err).toBeInstanceOf(InvalidPlanWorkflowGraphError)
          if (err instanceof InvalidPlanWorkflowGraphError) {
            match(err.issue)
              .with({ _tag: "DuplicateWorkUnitId" }, (issue) => {
                expect(issue.unitId).toBe(SHARED_STEP_UNIT_ID)
              })
              .with({ _tag: "DanglingUnitDependency" }, () => {
                expect.unreachable("Expected DuplicateWorkUnitId for reserved shared-step unitId")
              })
              .exhaustive()
          }
        }
      }),
  )
})
