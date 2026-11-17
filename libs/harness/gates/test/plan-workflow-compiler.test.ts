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
  GitCommitSha,
  InvalidPlanWorkflowGraphError,
  LlmPhaseReceipt,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanSha256,
  RUNNER_IDS,
  ReviewDepth,
  ReviewRoutingReason,
  ReviewRoutingSource,
  RunnerId,
  SHIP_STAGES,
  ShipAttempt,
  ShipReceipt,
  ShipStage,
  SliceBranchName,
  StubSymbolKey,
  TaskRunReceipt,
  UnitDependency,
  UnitMode,
  UnitOutcome,
  WaveIndex,
  WorkUnitId,
  WorkflowLevel,
  WorkflowRunId,
  WorkspaceTreeHash,
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

const makeSliceUnit = (
  id: string,
  ownedRelPaths: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make(id),
  branch: SliceBranchName.make(`slice/${id.replace(/[^a-z0-9-]/g, "a")}-unit`),
  waveIndex: WaveIndex.make(0),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-2.4")],
})

const makePackageUnit = (
  id: string,
  ownedRelPaths: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "PackageUnit",
  unitId: WorkUnitId.make(id),
  projectName: NxProjectName.make(`@harness/${id}`),
  waveIndex: WaveIndex.make(0),
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
      attempt: ShipAttempt.make(1),
      verifiedTreeHash: treeHash,
    }

    expect(outcome._tag).toBe("Completed")
    expect(taskReceipt.completedUnits).toEqual([WorkUnitId.make("unit-a")])
    expect(shipReceipt.attempt).toBe(1)

    const unitZ: CompiledWorkUnit = {
      ...makeSliceUnit("unit-z", ["libs/a/z.ts"]),
      waveIndex: WaveIndex.make(1),
    }
    const unitA: CompiledWorkUnit = {
      ...makePackageUnit("unit-a", ["libs/a/a.ts"]),
      waveIndex: WaveIndex.make(1),
    }
    const unitRoot: CompiledWorkUnit = {
      ...makeSliceUnit("unit-0", ["libs/a/root.ts"]),
      waveIndex: WaveIndex.make(0),
    }

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
      waves: grouped,
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
      expect(emptyResult.waves).toEqual([])

      const singleUnit = makeSliceUnit("solo", ["libs/solo/a.ts"])
      const singleResult = yield* PlanWorkflowCompiler.decide({
        units: [singleUnit],
        dependencies: [],
      })
      expect(singleResult.waves).toHaveLength(1)
      expect(singleResult.waves[0]?.waveIndex).toBe(0)
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

      expect(result.waves).toHaveLength(3)
      expect(result.waves[0]?.units.map((u) => u.unitId)).toEqual(["a"])
      expect(result.waves[1]?.units.map((u) => u.unitId)).toEqual(["b", "c"])
      expect(result.waves[2]?.units.map((u) => u.unitId)).toEqual(["d"])
      expect(PlanWorkflowCompiler.wavesOf(result)).toEqual(result.waves)

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
        expect(compiled.waves.map((w) => w.units.map((u) => u.unitId))).toEqual([
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
          units: [makeSliceUnit("dup-self", ["libs/x/a.ts", "libs/x/a.ts"])],
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
          match(danglingFromErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.missingUnitId).toBe("missing-from")
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
          match(danglingToErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.missingUnitId).toBe("missing-to")
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
                makeSliceUnit("u1", ["libs/z.ts", "libs/a.ts"]),
                makeSliceUnit("u2", ["libs/a.ts", "libs/z.ts"]),
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
    "REQ-2.2 / REQ-2.3 / REQ-2.4: converges unit.dependsOn with dependencies and catches dangling/cyclic unit.dependsOn",
    () =>
      Effect.gen(function* () {
        const compiled = yield* PlanWorkflowCompiler.decide({
          units: [
            makeSliceUnit("a", ["libs/a.ts"]),
            makePackageUnit("b", ["libs/b.ts"], ["a"]),
            makeSliceUnit("c", ["libs/c.ts"], ["b", "a", "b"]),
          ],
          dependencies: [],
        })

        expect(compiled.waves.map((w) => w.units.map((u) => u.unitId))).toEqual([
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
            units: [makeSliceUnit("u1", ["libs/u1.ts"], ["missing-dep"])],
            dependencies: [],
          }),
        )
        const danglingErr = extractTypedError(danglingExit)
        expect(danglingErr).toBeInstanceOf(InvalidPlanWorkflowGraphError)
        if (danglingErr instanceof InvalidPlanWorkflowGraphError) {
          match(danglingErr.issue)
            .with({ _tag: "DanglingUnitDependency" }, (issue) => {
              expect(issue.from).toBe("missing-dep")
              expect(issue.to).toBe("u1")
              expect(issue.missingUnitId).toBe("missing-dep")
            })
            .with({ _tag: "DuplicateWorkUnitId" }, () => {
              expect.unreachable("Expected DanglingUnitDependency")
            })
            .exhaustive()
        }

        const cyclicExit = yield* Effect.exit(
          PlanWorkflowCompiler.decide({
            units: [
              makeSliceUnit("x", ["libs/x.ts"], ["y"]),
              makeSliceUnit("y", ["libs/y.ts"], ["x"]),
            ],
            dependencies: [],
          }),
        )
        const cyclicErr = extractTypedError(cyclicExit)
        expect(cyclicErr).toBeInstanceOf(CyclicPlanWorkflowError)
        if (cyclicErr instanceof CyclicPlanWorkflowError) {
          expect(cyclicErr.cycleUnits).toEqual(["x", "y"])
        }
      }),
  )

  it.effect.prop(
    "REQ-1.3 property: wavesOf groups arbitrary unsorted CompiledWorkUnit[] by ascending waveIndex and lexicographic unitId",
    {
      units: Schema.Array(CompiledWorkUnit),
    },
    ({ units }) =>
      Effect.sync(() => {
        const grouped = wavesOf({ units, waves: [] })
        const totalUnits = grouped.reduce((sum, w) => sum + w.units.length, 0)
        expect(totalUnits).toBe(units.length)

        for (let i = 0; i < grouped.length; i++) {
          const wave = grouped[i]!
          if (i > 0) {
            expect(wave.waveIndex).toBeGreaterThan(grouped[i - 1]!.waveIndex)
          }
          const ids = wave.units.map((u) => u.unitId)
          expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
          for (const unit of wave.units) {
            expect(unit.waveIndex).toBe(wave.waveIndex)
          }
        }
      }),
  )

  it.effect.prop(
    "REQ-2.4 property: guaranteed-acyclic CompileInput with shared paths satisfies monotonicity, dependsOn sync, disjointness, and determinism",
    {
      units: Schema.Array(CompiledWorkUnit),
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
        const dagUnits: Array<CompiledWorkUnit> = []
        const candidateEdges: Array<{ readonly from: WorkUnitId; readonly to: WorkUnitId }> = []

        for (const u of units) {
          if (indexById.has(u.unitId)) continue
          const nodeIdx = dagUnits.length
          indexById.set(u.unitId, nodeIdx)
          const projectedPaths = u.ownedRelPaths.map((p, pIdx) =>
            pIdx % 2 === 0 ? sharedPool[(nodeIdx + pIdx) % sharedPool.length]! : p,
          )
          for (const depFrom of u.dependsOn) {
            candidateEdges.push({ from: depFrom, to: u.unitId })
          }
          dagUnits.push(
            match(u)
              .with({ _tag: "SliceUnit" }, (s) => ({
                ...s,
                dependsOn: [],
                ownedRelPaths: projectedPaths,
              }))
              .with({ _tag: "PackageUnit" }, (p) => ({
                ...p,
                dependsOn: [],
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
          const sortedExpected = [...(expectedPreds.get(u.unitId) ?? new Set())].sort((a, b) =>
            a.localeCompare(b),
          )
          expect(u.dependsOn).toEqual(sortedExpected)
        }

        for (const wave of compiled.waves) {
          yield* assertDisjointWave(wave)
        }

        expect(wavesOf(compiled)).toEqual(compiled.waves)
      }),
  )

  it.effect("REQ-2.6 (PERF-09): 50-unit 200-edge DAG compiles within latency SLO budgets", () =>
    Effect.gen(function* () {
      const units: Array<CompiledWorkUnit> = []
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

      for (let w = 0; w < 5; w++) {
        yield* PlanWorkflowCompiler.decide(input)
      }

      const samples: Array<number> = []
      for (let r = 0; r < 25; r++) {
        const start = performance.now()
        yield* PlanWorkflowCompiler.decide(input)
        samples.push(performance.now() - start)
      }

      const measurement = buildStageLatencyMeasurement("PlanWorkflowCompiler.decide", samples)
      const benchReport = yield* HarnessBench.decide({
        measurements: [measurement],
        budgets: DEFAULT_STAGE_LATENCY_BUDGETS,
      })

      expect(benchReport.status).toBe("pass")
      expect(measurement.p50Ms).toBeLessThanOrEqual(2)
      expect(measurement.p95Ms).toBeLessThanOrEqual(6)
    }),
  )
})
