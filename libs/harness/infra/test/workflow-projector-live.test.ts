import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  OmnigraphBranchName,
  OwnedRelPath,
  PlanJsonPayload,
  RunnerId,
  WORKFLOW_TIMEOUT_BUDGETS,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowProjectionStatus,
  WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  isPureInterruptCause,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
  toBoundedReason,
} from "@harness/contract"
import { HARNESS_OMNIGRAPH_GRAPH_ID, makeOmnigraphClient } from "@harness/graph"
import {
  WorkflowProjector,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
} from "@harness/service"
import {
  WorkflowProjectorLive,
  computeProjectorRetryDelayMs,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowProjectorLayer,
  makeWorkflowReadModelQueryLayer,
  nodeSyncHostIo,
  projectAllWorkflowRunsImpl,
  projectWorkflowRunImpl,
} from "../src/index.js"
import { readTargetStateSnapshot } from "../src/workflow/workflow-projector-query.js"
import {
  BASE_SHA,
  NOW_MS,
  PLAN_SHA,
  STAMP_HASH,
  encodeCompiledPlan,
  expectStaleOutcome,
  makeAlphaPlan,
  makeHangingBranchesClient,
  makeRunRecord,
  makeSingleRunReadModelLayer,
  makeStubReadModelLayer,
  wrapHarnessClient,
} from "./helpers/workflow-projector-test-helpers.js"
import {
  runWithTestTracer,
  startWorkflowReadModelServerHarness,
} from "./helpers/workflow-read-model-fixture.js"

describe("WF-6 WorkflowProjectorLive & OCC projection", () => {
  const harness = startWorkflowReadModelServerHarness("wf6-projector-")
  const cliToken = harness.cliToken
  let serverBaseUrl = ""
  const createWorkflowClient = () => harness.createClient()
  const createHarnessCliClient = () =>
    makeOmnigraphClient({
      baseUrl: serverBaseUrl,
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      actor: "harness-cli",
      token: cliToken,
    })

  beforeAll(async () => {
    await harness.start()
    const wfClient = createWorkflowClient()
    const branchList = await wfClient.branches.list()
    expect(branchList).toContain("main")
    const transport = Reflect.get(wfClient, "t") as { readonly baseUrl?: string } | undefined
    serverBaseUrl = transport?.baseUrl ?? ""
    expect(serverBaseUrl.startsWith("http://127.0.0.1:")).toBe(true)
  }, 30_000)

  afterAll(async () => {
    await harness.stop()
  })

  it("projects run/units/attempts and all 6 Plays*Role edges idempotently into real omnigraph-server (second run is no-op)", async () => {
    const wfClient = createWorkflowClient()
    const ogHarness = createHarnessCliClient()
    const repoRoot = harness.getRepoRoot()
    const runId = WorkflowRunId.make("run-wf6-e2e-01")
    const execId = WorkflowExecutionId.make("exec-wf6-e2e-01")
    const unitId = WorkUnitId.make("unit-alpha")
    const unitKey = makeWorkflowUnitKey(runId, unitId)
    const attemptKey = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(1))
    const targetBranch = OmnigraphBranchName.make("impl/wf6-e2e-01")
    const plan = makeAlphaPlan(runId, unitId)

    // Seed analytical entities on target branch in `harness`
    await ogHarness.branches.create({ name: targetBranch, from: "main" })
    await ogHarness.mutate({
      branch: targetBranch,
      query: `query seed() {
        insert EffectFn {
          qualname: "libs/alpha/src/index.ts#alphaFn",
          spanName: "Alpha.fn",
          packageTag: "domain",
          file: "libs/alpha/src/index.ts",
          line: 10,
          isStub: true
        }
        insert EarsSpec {
          id: "harness:SPEC-0038",
          qualname: "harness:SPEC-0038",
          title: "Readable Projection",
          status: "accepted",
          path: "libs/harness/docs/specs/2026-11-28-workflow-readable-projection.md",
          enforcedByFiles: ["libs/alpha/src/index.ts"]
        }
        insert TraceabilityTuple {
          relationId: "tt-wf6-1",
          qualname: "tt-wf6-1",
          earsSpecId: "harness:SPEC-0038",
          targetSymbolQualname: "libs/alpha/src/index.ts#alphaFn"
        }
        insert VitestCase {
          testId: "libs/alpha/test/alpha.test.ts::alpha works",
          qualname: "libs/alpha/test/alpha.test.ts::alpha works",
          testFile: "libs/alpha/test/alpha.test.ts",
          testName: "alpha works"
        }
      }`,
    })

    const writerLayer = makeWorkflowProjectionWriterLayer({ repoRoot, client: wfClient })
    const readModelLayer = makeWorkflowReadModelQueryLayer({ repoRoot, client: wfClient })
    const projectorLayer = makeWorkflowProjectorLayer({
      repoRoot,
      harnessClient: ogHarness,
    }).pipe(Layer.provide(readModelLayer))

    const fullLayer = Layer.mergeAll(writerLayer, readModelLayer, projectorLayer)

    const { result, spans } = await Effect.runPromise(
      runWithTestTracer(
        "wf6.e2e.idempotent",
        Effect.gen(function* () {
          const writer = yield* WorkflowProjectionWriter
          const projector = yield* WorkflowProjector

          yield* writer.upsertRun({
            runId,
            executionId: execId,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "running",
            planJson: PlanJsonPayload.make(encodeCompiledPlan(plan)),
            updatedMs: NOW_MS,
          })
          yield* writer.upsertUnit({
            unitKey,
            runId,
            unitId,
            kind: "package",
            waveIndex: WaveIndex.make(0),
            status: "pending",
            ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
            updatedMs: NOW_MS,
          })
          yield* writer.upsertAttempt({
            attemptKey,
            runId,
            unitId,
            attempt: AttemptNumber.make(1),
            verdict: "completed",
            runner: RunnerId.make("claude-code"),
            packageStampHash: STAMP_HASH,
            updatedMs: NOW_MS,
          })

          const firstOutcome = yield* projector.project({
            runId,
            targetBranch: { _tag: "Explicit", branch: targetBranch },
            trigger: "wave",
            repoRoot,
          })
          const statusAfterFirst = yield* projector.getProjectionStatus(runId)
          const secondOutcome = yield* projector.project({
            runId,
            targetBranch: { _tag: "Explicit", branch: targetBranch },
            trigger: "wave",
            repoRoot,
          })
          return { firstOutcome, statusAfterFirst, secondOutcome }
        }).pipe(Effect.provide(fullLayer)),
      ),
    )

    expect(result.firstOutcome._tag).toBe("Projected")
    match(result.firstOutcome)
      .with({ _tag: "Projected" }, (p) => {
        expect(p.projectionStatus).toBe("fresh")
        expect(p.branch).toBe(targetBranch)
        expect(p.commitId).not.toBeNull()
        expect(p.counts).toEqual({
          runsUpserted: 1,
          unitsUpserted: 1,
          attemptsUpserted: 1,
          edgesUpserted: 6,
        })
      })
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () => expect.unreachable("expected Projected"))
      .exhaustive()

    expect(Option.getOrUndefined(result.statusAfterFirst)).toBe("fresh")

    // Second projection must be a complete no-op with commitId: null and 0 counts
    match(result.secondOutcome)
      .with({ _tag: "Projected" }, (p) => {
        expect(p.projectionStatus).toBe("fresh")
        expect(p.commitId).toBeNull()
        expect(p.counts).toEqual({
          runsUpserted: 0,
          unitsUpserted: 0,
          attemptsUpserted: 0,
          edgesUpserted: 0,
        })
      })
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected Projected no-op"),
      )
      .exhaustive()

    // Verify stored GQ presets return exact expected rows before completion
    const pendingRes = await ogHarness.queries.invoke("workflow_pending_units", {
      branch: targetBranch,
      params: { runId },
    })
    const pendingRows =
      "rows" in pendingRes && Array.isArray(pendingRes.rows) ? pendingRes.rows : []
    expect(pendingRows).toEqual([{ unitId: "unit-alpha", waveIndex: 0, kind: "package" }])

    const uncoveredEarsRes = await ogHarness.queries.invoke("ears_without_completed_unit", {
      branch: targetBranch,
      params: { runId },
    })
    const uncoveredRows =
      "rows" in uncoveredEarsRes && Array.isArray(uncoveredEarsRes.rows)
        ? uncoveredEarsRes.rows
        : []
    expect(uncoveredRows).toEqual([
      {
        specId: "harness:SPEC-0038",
        path: "libs/harness/docs/specs/2026-11-28-workflow-readable-projection.md",
      },
    ])

    // Verify SPEC-0038 span names
    const spanNames = spans.map((s) => s.name)
    expect(spanNames).toContain("WorkflowProjector.project")
    expect(spanNames).toContain("WorkflowProjector.getProjectionStatus")
  })

  it("applies 3rd-pass completion update with 0 new edges and resolves pending GQ rows (1 -> 0)", async () => {
    const wfClient = createWorkflowClient()
    const ogHarness = createHarnessCliClient()
    const repoRoot = harness.getRepoRoot()
    const runId = WorkflowRunId.make("run-wf6-e2e-01")
    const execId = WorkflowExecutionId.make("exec-wf6-e2e-01")
    const unitId = WorkUnitId.make("unit-alpha")
    const unitKey = makeWorkflowUnitKey(runId, unitId)
    const attemptKey = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(1))
    const targetBranch = OmnigraphBranchName.make("impl/wf6-e2e-01")
    const plan = makeAlphaPlan(runId, unitId)
    const writerLayer = makeWorkflowProjectionWriterLayer({ repoRoot, client: wfClient })
    const readModelLayer = makeWorkflowReadModelQueryLayer({ repoRoot, client: wfClient })
    const projectorLayer = makeWorkflowProjectorLayer({
      repoRoot,
      harnessClient: ogHarness,
    }).pipe(Layer.provide(readModelLayer))
    const fullLayer = Layer.mergeAll(writerLayer, readModelLayer, projectorLayer)

    // 3rd-pass update: mark run/unit/attempt completed -> targeted updates only (0 new edges),
    // and both workflow_pending_units and ears_without_completed_unit drop from 1 -> 0 rows.
    const thirdOutcome = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const projector = yield* WorkflowProjector
        yield* writer.upsertRun({
          runId,
          executionId: execId,
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "completed",
          planJson: PlanJsonPayload.make(encodeCompiledPlan(plan)),
          updatedMs: WorkflowTimestampMs.make(NOW_MS + 1_000),
        })
        yield* writer.upsertUnit({
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "completed",
          ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
          updatedMs: WorkflowTimestampMs.make(NOW_MS + 1_000),
        })
        yield* writer.upsertAttempt({
          attemptKey,
          runId,
          unitId,
          attempt: AttemptNumber.make(1),
          verdict: "completed",
          runner: RunnerId.make("antigravity"),
          packageStampHash: STAMP_HASH,
          updatedMs: WorkflowTimestampMs.make(NOW_MS + 1_000),
        })
        return yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: targetBranch },
          trigger: "done-pre-merge",
          repoRoot,
        })
      }).pipe(Effect.provide(fullLayer)),
    )

    match(thirdOutcome)
      .with({ _tag: "Projected" }, (p) => {
        expect(p.projectionStatus).toBe("fresh")
        expect(p.commitId).not.toBeNull()
        expect(p.counts).toEqual({
          runsUpserted: 1,
          unitsUpserted: 1,
          attemptsUpserted: 1,
          edgesUpserted: 0,
        })
      })
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected 3rd-pass Projected update"),
      )
      .exhaustive()

    const pendingAfter = await ogHarness.queries.invoke("workflow_pending_units", {
      branch: targetBranch,
      params: { runId },
    })
    expect(
      "rows" in pendingAfter && Array.isArray(pendingAfter.rows) ? pendingAfter.rows : [],
    ).toEqual([])

    const uncoveredAfter = await ogHarness.queries.invoke("ears_without_completed_unit", {
      branch: targetBranch,
      params: { runId },
    })
    expect(
      "rows" in uncoveredAfter && Array.isArray(uncoveredAfter.rows) ? uncoveredAfter.rows : [],
    ).toEqual([])

    await Effect.runPromise(harness.cleanupRunsAndJournal(wfClient, [runId]))
  })

  it("auto-creates missing Explicit branch on 'wave', skips absent ActiveTaskImplBranch on 'wave', falls back to 'main' only for ActiveTaskImplBranch on 'post-rebuild', and skips on 'done-pre-merge'", async () => {
    const wfClient = createWorkflowClient()
    const ogHarness = createHarnessCliClient()
    const repoRoot = harness.getRepoRoot()
    const runId = WorkflowRunId.make("run-wf6-branch-02")
    const execId = WorkflowExecutionId.make("exec-wf6-branch-02")
    const unitId = WorkUnitId.make("unit-branch")
    const unitKey = makeWorkflowUnitKey(runId, unitId)

    const writerLayer = makeWorkflowProjectionWriterLayer({ repoRoot, client: wfClient })
    const readModelLayer = makeWorkflowReadModelQueryLayer({ repoRoot, client: wfClient })
    const projectorLayer = makeWorkflowProjectorLayer({
      repoRoot,
      harnessClient: ogHarness,
      env: { HARNESS_GIT_BRANCH: "feat/missing-task-branch" },
    }).pipe(Layer.provide(readModelLayer))
    const fullLayer = Layer.mergeAll(writerLayer, readModelLayer, projectorLayer)

    const missingDoneBranch = OmnigraphBranchName.make("impl/wf6-missing-done")
    const missingWaveBranch = OmnigraphBranchName.make("impl/wf6-created-wave")
    const missingRebuildBranch = OmnigraphBranchName.make("impl/wf6-missing-rebuild")

    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const projector = yield* WorkflowProjector
        yield* writer.upsertRun({
          runId,
          executionId: execId,
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "running",
          updatedMs: NOW_MS,
        })
        yield* writer.upsertUnit({
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "pending",
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: NOW_MS,
        })

        const skippedDone = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: missingDoneBranch },
          trigger: "done-pre-merge",
          repoRoot,
        })
        const skippedAbsentActiveWave = yield* projector.project({
          runId,
          targetBranch: { _tag: "ActiveTaskImplBranch" },
          trigger: "wave",
          repoRoot,
        })
        const createdWave = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: missingWaveBranch },
          trigger: "wave",
          repoRoot,
        })
        const skippedExplicitRebuild = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: missingRebuildBranch },
          trigger: "post-rebuild",
          repoRoot,
        })
        const fallbackActiveMain = yield* projector.project({
          runId,
          targetBranch: { _tag: "ActiveTaskImplBranch" },
          trigger: "post-rebuild",
          repoRoot,
        })
        return {
          skippedDone,
          skippedAbsentActiveWave,
          createdWave,
          skippedExplicitRebuild,
          fallbackActiveMain,
        }
      }).pipe(Effect.provide(fullLayer)),
    )

    expect(outcomes.skippedDone._tag).toBe("Skipped")
    expect(outcomes.skippedAbsentActiveWave._tag).toBe("Skipped")
    expect(outcomes.skippedExplicitRebuild._tag).toBe("Skipped")
    const postBranches = await ogHarness.branches.list()
    expect(postBranches).not.toContain("impl/branch-feat_missing-task-branch")
    match(outcomes.createdWave)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe(missingWaveBranch))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected wave create"),
      )
      .exhaustive()
    match(outcomes.fallbackActiveMain)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe("main"))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected post-rebuild fallback to main for ActiveTaskImplBranch"),
      )
      .exhaustive()

    await Effect.runPromise(harness.cleanupRunsAndJournal(wfClient, [runId]))
  })

  it("retries on 412/409 OCC conflicts with fresh graphCommitId re-read and succeeds on retry 2", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-occ-03")
    const unitId = WorkUnitId.make("unit-occ")
    const unitKey = makeWorkflowUnitKey(runId, unitId)
    const branch = OmnigraphBranchName.make("impl/wf6-occ-03")
    await ogHarness.branches.create({ name: branch, from: "main" })

    const seenIfGraphCommits: Array<string | undefined> = []
    let mutateCalls = 0

    const proxiedClient = wrapHarnessClient(ogHarness, {
      onQuery: async (orig, input, opts) => {
        const round = mutateCalls + 1
        const res = await orig(input, opts)
        return {
          ...res,
          graphCommitId: `cmt-occ-round-${round}`,
        }
      },
      onMutate: async (orig, input, opts) => {
        mutateCalls += 1
        seenIfGraphCommits.push(opts?.ifGraphCommit)
        if (mutateCalls === 1) {
          const conflict = Object.assign(new Error("Precondition Failed"), { status: 412 })
          throw conflict
        }
        // Strip synthetic ifGraphCommit before hitting real server on retry 2
        return orig(input, opts?.signal !== undefined ? { signal: opts.signal } : undefined)
      },
    })

    const readModelLayer = makeSingleRunReadModelLayer(runId, {
      units: [
        {
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "pending",
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: NOW_MS,
        },
      ],
    })

    const projectorLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: proxiedClient,
    }).pipe(Layer.provide(readModelLayer))

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
        })
      }).pipe(Effect.provide(projectorLayer)),
    )

    expect(mutateCalls).toBe(2)
    expect(seenIfGraphCommits).toEqual(["cmt-occ-round-1", "cmt-occ-round-2"])
    expect(outcome._tag).toBe("Projected")

    // Also verify 409 Conflict + 429 TooManyRequests (on query & mutate) + mid-snapshot skew retry
    let retryPhaseCalls = 0
    let skewInjected = false
    let query429Injected = false
    const multiRetryClient = wrapHarnessClient(ogHarness, {
      onQuery: async (orig, input, opts) => {
        if (skewInjected && !query429Injected && input.query.includes("q_run(")) {
          query429Injected = true
          throw Object.assign(new Error("Query Rate Limited"), {
            status: 429,
            retryAfter: "0.01",
          })
        }
        const res = await orig(input, opts)
        if (!skewInjected && input.query.includes("q_units(")) {
          skewInjected = true
          return { ...res, graphCommitId: "cmt-skew-b" }
        }
        return { ...res, graphCommitId: "cmt-consistent" }
      },
      onMutate: async (orig, input, opts) => {
        retryPhaseCalls += 1
        if (retryPhaseCalls === 1) {
          throw Object.assign(new Error("Conflict"), { status: 409 })
        }
        if (retryPhaseCalls === 2) {
          throw Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter: "0.01" })
        }
        return orig(input, opts?.signal !== undefined ? { signal: opts.signal } : undefined)
      },
    })
    const altBranch = OmnigraphBranchName.make("impl/wf6-occ-03b")
    await ogHarness.branches.create({ name: altBranch, from: "main" })
    const multiRetryLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: multiRetryClient,
    }).pipe(Layer.provide(readModelLayer))
    const retryOutcome = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: altBranch },
          trigger: "wave",
        })
      }).pipe(Effect.provide(multiRetryLayer)),
    )
    expect(skewInjected).toBe(true)
    expect(query429Injected).toBe(true)
    expect(retryPhaseCalls).toBe(3)
    expect(retryOutcome._tag).toBe("Projected")
  })

  it("records 'stale' and returns Stale without failing on exhausted OCC or unreachable server, and propagates pure interrupts", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-stale-04")
    const branch = OmnigraphBranchName.make("main")
    const readModelLayer = makeSingleRunReadModelLayer(runId)

    // 1. Exhausted OCC (412 every attempt)
    let occMutateCount = 0
    const always412Client = wrapHarnessClient(ogHarness, {
      onMutate: async () => {
        occMutateCount += 1
        throw Object.assign(new Error("Precondition Failed"), { status: 412 })
      },
    })
    const occLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: always412Client,
    }).pipe(Layer.provide(readModelLayer))

    const occRes = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        const outcome = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
        })
        const status = yield* projector.getProjectionStatus(runId)
        return { outcome, status }
      }).pipe(Effect.provide(occLayer)),
    )

    expect(occMutateCount).toBe(WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts)
    expect(occRes.outcome._tag).toBe("Stale")
    match(occRes.outcome)
      .with({ _tag: "Stale" }, (s) => {
        expect(s.projectionStatus).toBe("stale")
        expect(s.reason.length).toBeGreaterThan(0)
      })
      .with({ _tag: "Projected" }, { _tag: "Skipped" }, () => expect.unreachable("expected Stale"))
      .exhaustive()
    expect(Option.getOrUndefined(occRes.status)).toBe("stale")

    // 1b. Non-retryable HTTP 500 stops after 1 attempt and records 'stale'
    let server500MutateCount = 0
    const server500Client = wrapHarnessClient(ogHarness, {
      onMutate: async () => {
        server500MutateCount += 1
        throw Object.assign(new Error("Internal Server Error"), { status: 500 })
      },
    })
    const server500Layer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: server500Client,
    }).pipe(Layer.provide(readModelLayer))
    const server500Outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
        })
      }).pipe(Effect.provide(server500Layer)),
    )
    expect(server500MutateCount).toBe(1)
    match(server500Outcome)
      .with({ _tag: "Stale" }, (s) => {
        expect(s.projectionStatus).toBe("stale")
        expect(s.reason).toContain("Internal Server Error")
      })
      .with({ _tag: "Projected" }, { _tag: "Skipped" }, () => expect.unreachable("expected Stale"))
      .exhaustive()

    // 2. Unreachable server
    const unreachableClient = makeOmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      actor: "harness-cli",
      token: cliToken,
    })
    const unreachableLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: unreachableClient,
    }).pipe(Layer.provide(readModelLayer))

    const unreachableRes = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        const outcome = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
        })
        const allOutcome = yield* projector.projectAll({
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
        })
        const status = yield* projector.getProjectionStatus(runId)
        return { outcome, allOutcome, status }
      }).pipe(Effect.provide(unreachableLayer)),
    )

    expect(unreachableRes.outcome._tag).toBe("Stale")
    expect(unreachableRes.allOutcome._tag).toBe("Stale")
    expect(Option.getOrUndefined(unreachableRes.status)).toBe("stale")

    // 3. projectAll when readModel.listRuns fails is still non-fatal Stale
    const failingReadModelLayer = makeStubReadModelLayer({
      runs: new Map(),
      unitsByRun: new Map(),
      attemptsByRun: new Map(),
      failOnGetRun: new WorkflowStoreUnavailableError({
        operation: WorkflowStoreOperation.make("Test.fail"),
        reason: toBoundedReason("store offline"),
      }),
    })
    const failingProjectorLayer = WorkflowProjectorLive.pipe(Layer.provide(failingReadModelLayer))
    const failingAllRes = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.projectAll({
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
        })
      }).pipe(Effect.provide(failingProjectorLayer)),
    )
    expect(failingAllRes._tag).toBe("Stale")

    // 4. Pure fiber interrupt propagation (must not be swallowed into Stale)
    const hangingClient = wrapHarnessClient(ogHarness, {
      onBranchesList: (_orig, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"))
          })
        }),
    })
    const statusRef = Ref.makeUnsafe<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>>(
      new Map(),
    )
    const interruptExit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* projectWorkflowRunImpl(
          {
            runId,
            targetBranch: { _tag: "Explicit", branch },
            trigger: "wave",
          },
          {
            repoRoot: harness.getRepoRoot(),
            harnessClient: hangingClient,
            statusRef,
          },
        ).pipe(Effect.provide(readModelLayer), Effect.forkChild)
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )

    match(interruptExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(isPureInterruptCause(cause)).toBe(true)
        expect(Cause.hasFails(cause)).toBe(false)
      })
      .with({ _tag: "Success" }, () => expect.unreachable("expected pure interrupt failure"))
      .exhaustive()
    const statusMap = Ref.getUnsafe(statusRef)
    expect(statusMap.get(runId)).toBeUndefined()
  })

  it("uses harness-cli actor token (never agent-mcp) from cluster auth-tokens.json when harnessClient is omitted", async () => {
    const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "wf6-actor-auth-")))
    try {
      const repoDir = join(tmpRoot, "repo")
      const clusterDir = join(repoDir, ".harness", "omnigraph-cluster")
      mkdirSync(clusterDir, { recursive: true })
      const authPath = join(clusterDir, "auth-tokens.json")
      writeFileSync(
        authPath,
        JSON.stringify({
          schemaVersion: 1,
          cliToken: "expected-cli-secret",
          mcpToken: "forbidden-mcp-secret",
        }),
        "utf8",
      )
      chmodSync(authPath, 0o600)

      let capturedAuthHeader: string | null = null
      let capturedUrl = ""
      const server = createServer((req, res) => {
        capturedUrl = req.url ?? ""
        if (capturedUrl.endsWith("/healthz")) {
          res.writeHead(200, {
            "content-type": "application/json",
            "Omnigraph-Http-Api": "0.14",
          })
          res.end(JSON.stringify({ status: "ok" }))
          return
        }
        capturedAuthHeader = req.headers.authorization ?? null
        if (capturedUrl.endsWith("/branches")) {
          res.writeHead(200, {
            "content-type": "application/json",
            "Omnigraph-Http-Api": "0.14",
          })
          res.end(JSON.stringify({ branches: ["main"] }))
          return
        }
        if (capturedUrl.endsWith("/mutate") || capturedUrl.endsWith("/mutate/if-graph-commit")) {
          res.writeHead(200, {
            "content-type": "application/json",
            "Omnigraph-Http-Api": "0.14",
          })
          res.end(
            JSON.stringify({
              branch: "main",
              affected_nodes: 1,
              affected_edges: 0,
              query_name: "project_workflow_run",
              commit: {
                graph_commit_id: "cmt-2",
                created_at: 1000,
                graph_manifest_version: 1,
                kind: "published",
              },
            }),
          )
          return
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(
          JSON.stringify({
            query_name: "q",
            row_count: 0,
            rows: [],
            graph_commit_id: "cmt-1",
            target: { branch: "main" },
          }),
        )
      })
      const capturePort = await new Promise<number>((resolveListen, rejectListen) => {
        server.on("error", rejectListen)
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address()
          if (addr === null || typeof addr === "string") {
            rejectListen(new Error("expected TCP address"))
            return
          }
          resolveListen(addr.port)
        })
      })
      try {
        writeFileSync(
          join(clusterDir, "server.json"),
          JSON.stringify({
            pid: process.pid,
            port: capturePort,
            baseUrl: `http://127.0.0.1:${capturePort}`,
            canonicalRepoRoot: repoDir,
            updatedAt: new Date().toISOString(),
          }),
          "utf8",
        )
        const runId = WorkflowRunId.make("run-wf6-actor-05")
        const readModelLayer = makeStubReadModelLayer({
          runs: new Map([
            [
              runId,
              {
                runId,
                executionId: WorkflowExecutionId.make("exec-wf6-actor-05"),
                level: "slice",
                planSha: PLAN_SHA,
                baseSha: BASE_SHA,
                state: "running",
                updatedMs: NOW_MS,
              },
            ],
          ]),
          unitsByRun: new Map(),
          attemptsByRun: new Map(),
        })
        const envHostIo = {
          ...nodeSyncHostIo,
          getEnv: () => ({}),
        }
        const layer = makeWorkflowProjectorLayer({
          repoRoot: AbsoluteRepoRoot.make(repoDir),
          hostIo: envHostIo,
          env: {},
        }).pipe(Layer.provide(readModelLayer))

        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const projector = yield* WorkflowProjector
            return yield* projector.project({
              runId,
              targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("main") },
              trigger: "post-rebuild",
            })
          }).pipe(Effect.provide(layer)),
        )

        expect(outcome._tag).toBe("Projected")
        expect(capturedAuthHeader).toBe("Bearer expected-cli-secret")
        expect(capturedUrl).toContain(`/graphs/${HARNESS_OMNIGRAPH_GRAPH_ID}/`)
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("exercises WorkflowProjector.projectAll and WorkflowProjector.readTargetState directly with trace spans", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-direct-06")
    const unitId = WorkUnitId.make("unit-direct")
    const unitKey = makeWorkflowUnitKey(runId, unitId)
    const branch = OmnigraphBranchName.make("impl/wf6-direct-06")
    await ogHarness.branches.create({ name: branch, from: "main" })
    await ogHarness.mutate({
      branch,
      query: `query seed_direct() {
        insert EffectFn {
          qualname: "libs/direct/src/index.ts#stubFn",
          spanName: "Direct.stubFn",
          packageTag: "domain",
          file: "libs/direct/src/index.ts",
          line: 10,
          isStub: true
        }
        insert EffectFn {
          qualname: "libs/direct/src/index.ts#liveFn",
          spanName: "Direct.liveFn",
          packageTag: "domain",
          file: "libs/direct/src/index.ts",
          line: 20,
          isStub: false
        }
        insert VitestCase {
          testId: "libs/ext/test/a.test.ts::t1",
          qualname: "libs/ext/test/a.test.ts::t1",
          testFile: "libs/ext/test/a.test.ts",
          testName: "t1"
        }
        insert VitestCase {
          testId: "libs/ext/test/b.test.ts::t2",
          qualname: "libs/ext/test/b.test.ts::t2",
          testFile: "libs/ext/test/b.test.ts",
          testName: "t2"
        }
        insert TraceabilityTuple {
          relationId: "tt-direct-1",
          qualname: "tt-direct-1",
          targetSymbolQualname: "libs/direct/src/index.ts#stubFn"
        }
        insert TraceabilityTuple {
          relationId: "tt-direct-2",
          qualname: "tt-direct-2",
          targetSymbolQualname: "libs/direct/src/index.ts#stubFn"
        }
        insert PlaysExercisingTestRole {
          from: "tt-direct-1",
          to: "libs/ext/test/a.test.ts::t1",
          role: "exercising-test",
          archimateRelation: "Association"
        }
        insert PlaysExercisingTestRole {
          from: "tt-direct-2",
          to: "libs/ext/test/b.test.ts::t2",
          role: "exercising-test",
          archimateRelation: "Association"
        }
        insert PlaysExercisedSpanRole {
          from: "tt-direct-1",
          to: "libs/direct/src/index.ts#stubFn",
          role: "exercised-span",
          archimateRelation: "Association"
        }
        insert PlaysExercisedSpanRole {
          from: "tt-direct-2",
          to: "libs/direct/src/index.ts#stubFn",
          role: "exercised-span",
          archimateRelation: "Association"
        }
      }`,
    })

    const readModelLayer = makeSingleRunReadModelLayer(runId, {
      units: [
        {
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "pending",
          ownedRelPaths: [OwnedRelPath.make("libs/direct")],
          updatedMs: NOW_MS,
        },
      ],
    })

    const tracedAll = await Effect.runPromise(
      runWithTestTracer(
        "workflow-projector-live.test.ts::projectAll-and-readTargetState",
        projectAllWorkflowRunsImpl(
          {
            targetBranch: { _tag: "Explicit", branch },
            trigger: "post-rebuild",
            repoRoot: harness.getRepoRoot(),
          },
          {
            repoRoot: harness.getRepoRoot(),
            harnessClient: ogHarness,
          },
        ).pipe(Effect.provide(readModelLayer)),
      ),
    )

    expect(tracedAll.result._tag).toBe("Projected")
    expect(tracedAll.spans.some((s) => s.name === "WorkflowProjector.projectAll")).toBe(true)
    expect(tracedAll.spans.some((s) => s.name === "WorkflowProjector.readTargetState")).toBe(true)

    const tracedRead = await Effect.runPromise(
      runWithTestTracer(
        "workflow-projector-live.test.ts::readTargetState",
        readTargetStateSnapshot(ogHarness, branch, runId, []),
      ),
    )
    expect(tracedRead.result.targetState.existingRun?.runId).toBe(runId)
    expect(tracedRead.spans.some((s) => s.name === "WorkflowProjector.readTargetState")).toBe(true)

    const stubFn = tracedRead.result.targetState.effectFns.find(
      (f) => f.qualname === "libs/direct/src/index.ts#stubFn",
    )
    const liveFn = tracedRead.result.targetState.effectFns.find(
      (f) => f.qualname === "libs/direct/src/index.ts#liveFn",
    )
    expect(stubFn?.isStub).toBe(true)
    expect(liveFn?.isStub).toBe(false)
    expect([...(stubFn?.exercisingTestIds ?? [])].sort()).toEqual([
      "libs/ext/test/a.test.ts::t1",
      "libs/ext/test/b.test.ts::t2",
    ])

    const skewReadClient = wrapHarnessClient(ogHarness, {
      onQuery: async (orig, input, opts) => {
        const res = await orig(input, opts)
        return {
          ...res,
          graphCommitId: input.query.includes("q_run(") ? "cmt-skew-1" : "cmt-skew-2",
        }
      },
    })
    const skewExit = await Effect.runPromiseExit(
      readTargetStateSnapshot(skewReadClient, branch, runId, []),
    )
    match(skewExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasFails(cause)).toBe(true)
        expect(Cause.hasDies(cause)).toBe(false)
      })
      .with({ _tag: "Success" }, () => expect.unreachable("expected Failure on commit skew"))
      .exhaustive()
  })

  it("handles missing runId, absent 'main' fallback, empty/mixed projectAll, and listRuns->branches failure statusRef tracking", async () => {
    const ogHarness = createHarnessCliClient()
    const runOk = WorkflowRunId.make("run-wf6-edge-ok")
    const runFail = WorkflowRunId.make("run-wf6-edge-fail")
    const missingRun = WorkflowRunId.make("run-wf6-edge-missing")
    const branch = OmnigraphBranchName.make("impl/wf6-edge-07")
    await ogHarness.branches.create({ name: branch, from: "main" })

    const emptyReadModel = makeStubReadModelLayer({
      runs: new Map(),
      unitsByRun: new Map(),
      attemptsByRun: new Map(),
    })
    const emptyLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: ogHarness,
    }).pipe(Layer.provide(emptyReadModel))

    const emptyAll = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        const singleMissing = yield* projector.project({
          runId: missingRun,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
        })
        const allEmpty = yield* projector.projectAll({
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
        })
        return { singleMissing, allEmpty }
      }).pipe(Effect.provide(emptyLayer)),
    )
    expect(emptyAll.singleMissing._tag).toBe("Skipped")
    match(emptyAll.allEmpty)
      .with({ _tag: "Projected" }, (p) => {
        expect(p.projectionStatus).toBe("fresh")
        expect(p.outcomes).toEqual([])
      })
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected 0-run Projected"),
      )
      .exhaustive()

    // !hasMain for wave & post-rebuild and missing branch in projectAll -> Skipped
    const noMainClient = wrapHarnessClient(ogHarness, {
      onBranchesList: async () => ["other-branch"],
    })
    const oneRunReadModel = makeSingleRunReadModelLayer(runOk)
    const noMainLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: noMainClient,
    }).pipe(Layer.provide(oneRunReadModel))

    const noMainRes = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        const waveSkip = yield* projector.project({
          runId: runOk,
          targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("impl/absent-1") },
          trigger: "wave",
        })
        const rebuildSkip = yield* projector.project({
          runId: runOk,
          targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("impl/absent-2") },
          trigger: "post-rebuild",
        })
        const allSkip = yield* projector.projectAll({
          targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("impl/absent-3") },
          trigger: "done-pre-merge",
        })
        return { waveSkip, rebuildSkip, allSkip }
      }).pipe(Effect.provide(noMainLayer)),
    )
    expect(noMainRes.waveSkip._tag).toBe("Skipped")
    expect(noMainRes.rebuildSkip._tag).toBe("Skipped")
    expect(noMainRes.allSkip._tag).toBe("Skipped")

    // Mixed Projected + Stale in projectAll
    const twoRunReadModel = makeStubReadModelLayer({
      runs: new Map([
        [runOk, makeRunRecord(runOk)],
        [runFail, makeRunRecord(runFail)],
      ]),
      unitsByRun: new Map(),
      attemptsByRun: new Map(),
    })
    const failSecondMutateClient = wrapHarnessClient(ogHarness, {
      onMutate: async (orig, input, opts) => {
        const values = Object.values(input.params ?? {})
        if (values.includes(runFail)) {
          throw Object.assign(new Error("Injected failure on runFail"), { status: 500 })
        }
        return orig(input, opts)
      },
    })
    const mixedLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: failSecondMutateClient,
    }).pipe(Layer.provide(twoRunReadModel))
    const mixedAll = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.projectAll({
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
        })
      }).pipe(Effect.provide(mixedLayer)),
    )
    match(mixedAll)
      .with({ _tag: "Stale" }, (s) => {
        expect(s.outcomes.map((o) => o._tag)).toEqual(["Projected", "Stale"])
      })
      .with({ _tag: "Projected" }, { _tag: "Skipped" }, () =>
        expect.unreachable("expected mixed Stale"),
      )
      .exhaustive()

    // projectAll failing in branches.list after listRuns records 'stale' on all known runs in statusRef
    const statusRef = Ref.makeUnsafe<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>>(
      new Map(),
    )
    const failingBranchesClient = wrapHarnessClient(ogHarness, {
      onBranchesList: async () => {
        throw new Error("branches endpoint unavailable")
      },
    })
    const allFailOutcome = await Effect.runPromise(
      projectAllWorkflowRunsImpl(
        {
          targetBranch: { _tag: "Explicit", branch },
          trigger: "post-rebuild",
          repoRoot: harness.getRepoRoot(),
        },
        {
          repoRoot: harness.getRepoRoot(),
          harnessClient: failingBranchesClient,
          statusRef,
        },
      ).pipe(Effect.provide(twoRunReadModel)),
    )
    expect(allFailOutcome._tag).toBe("Stale")
    expect(Ref.getUnsafe(statusRef).get(runOk)).toBe("stale")
    expect(Ref.getUnsafe(statusRef).get(runFail)).toBe("stale")
  })

  it("F-3.1 & F-3.2: fresh WorkflowProjector instance reads persisted fresh/not-projected/stale across restarts and Skipped updates memory + disk", async () => {
    const ogHarness = createHarnessCliClient()
    const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "wf6-restart-status-")))
    try {
      const repoRoot = AbsoluteRepoRoot.make(tmpRoot)
      const runFresh = WorkflowRunId.make("run-restart-fresh")
      const runMissing = WorkflowRunId.make("run-restart-missing")
      const runSkipBranch = WorkflowRunId.make("run-restart-skip-branch")
      const runStale = WorkflowRunId.make("run-restart-stale")
      const readModelLayer = makeStubReadModelLayer({
        runs: new Map([
          [runFresh, makeRunRecord(runFresh)],
          [runSkipBranch, makeRunRecord(runSkipBranch)],
          [runStale, makeRunRecord(runStale)],
        ]),
        unitsByRun: new Map(),
        attemptsByRun: new Map(),
      })
      const failStaleClient = wrapHarnessClient(ogHarness, {
        onMutate: async (orig, input, opts) => {
          if (Object.values(input.params ?? {}).includes(runStale)) {
            throw Object.assign(new Error("Restart stale error"), { status: 500 })
          }
          return orig(input, opts)
        },
      })
      const memRef = Ref.makeUnsafe<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>>(new Map())
      const writerLayer = makeWorkflowProjectorLayer({
        repoRoot,
        harnessClient: failStaleClient,
        statusRef: memRef,
      }).pipe(Layer.provide(readModelLayer))

      const mainTarget = { _tag: "Explicit", branch: OmnigraphBranchName.make("main") } as const
      const absentTarget = {
        _tag: "Explicit",
        branch: OmnigraphBranchName.make("impl/absent-skip-restart"),
      } as const
      await Effect.runPromise(
        Effect.gen(function* () {
          const p = yield* WorkflowProjector
          const outFresh = yield* p.project({
            runId: runFresh,
            targetBranch: mainTarget,
            trigger: "wave",
          })
          const outMiss = yield* p.project({
            runId: runMissing,
            targetBranch: mainTarget,
            trigger: "wave",
          })
          const outSkip = yield* p.project({
            runId: runSkipBranch,
            targetBranch: absentTarget,
            trigger: "done-pre-merge",
          })
          const outStale = yield* p.project({
            runId: runStale,
            targetBranch: mainTarget,
            trigger: "wave",
          })
          expect(outFresh._tag).toBe("Projected")
          expect(outMiss._tag).toBe("Skipped")
          expect(outSkip._tag).toBe("Skipped")
          expect(outStale._tag).toBe("Stale")
        }).pipe(Effect.provide(writerLayer)),
      )
      expect(Ref.getUnsafe(memRef).get(runMissing)).toBe("not-projected")
      expect(Ref.getUnsafe(memRef).get(runSkipBranch)).toBe("not-projected")

      const restartedLayer = makeWorkflowProjectorLayer({
        repoRoot,
        harnessClient: ogHarness,
      }).pipe(Layer.provide(readModelLayer))
      const statuses = await Effect.runPromise(
        Effect.gen(function* () {
          const p = yield* WorkflowProjector
          return {
            fresh: yield* p.getProjectionStatus(runFresh),
            missing: yield* p.getProjectionStatus(runMissing),
            skipBranch: yield* p.getProjectionStatus(runSkipBranch),
            stale: yield* p.getProjectionStatus(runStale),
          }
        }).pipe(Effect.provide(restartedLayer)),
      )
      expect(Option.getOrUndefined(statuses.fresh)).toBe("fresh")
      expect(Option.getOrUndefined(statuses.missing)).toBe("not-projected")
      expect(Option.getOrUndefined(statuses.skipBranch)).toBe("not-projected")
      expect(Option.getOrUndefined(statuses.stale)).toBe("stale")
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("F-8.1, F-12.1, F-12.3, F-12.4: covers ActiveTaskImplBranch, branchOverride, malformed rows, retry delay bounds, and 429 exhaustion", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-12x")
    const readModelLayer = makeSingleRunReadModelLayer(runId)

    const activeBranch = OmnigraphBranchName.make("impl/branch-feat_12-1")
    const overrideBranch = OmnigraphBranchName.make("impl/wf6-override-12-1")
    await ogHarness.branches.create({ name: activeBranch, from: "main" })
    await ogHarness.branches.create({ name: overrideBranch, from: "main" })

    const activeOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "ActiveTaskImplBranch" }, trigger: "wave" },
        {
          repoRoot: harness.getRepoRoot(),
          harnessClient: ogHarness,
          env: { HARNESS_GIT_BRANCH: "feat/12-1" },
        },
      ).pipe(Effect.provide(readModelLayer)),
    )
    match(activeOut)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe(activeBranch))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () => expect.unreachable("expected Projected"))
      .exhaustive()

    const overrideOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "ActiveTaskImplBranch" }, trigger: "wave" },
        {
          repoRoot: harness.getRepoRoot(),
          harnessClient: ogHarness,
          branchOverride: overrideBranch,
        },
      ).pipe(Effect.provide(readModelLayer)),
    )
    match(overrideOut)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe(overrideBranch))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () => expect.unreachable("expected Projected"))
      .exhaustive()

    const malformedClient = wrapHarnessClient(ogHarness, {
      onQuery: async (orig, input, opts) => {
        const res = await orig(input, opts)
        return input.query.includes("q_units(")
          ? { ...res, rows: [{ unitKey: 123, waveIndex: "bad" }] }
          : res
      },
    })
    const malformedOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "Explicit", branch: overrideBranch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: malformedClient },
      ).pipe(Effect.provide(readModelLayer)),
    )
    expectStaleOutcome(malformedOut)

    expect(computeProjectorRetryDelayMs(0, { retryAfter: "60" }, 100)).toBe(
      WORKFLOW_TIMEOUT_BUDGETS.projectorRetryAfterCapMs,
    )
    expect(computeProjectorRetryDelayMs(0, { retryAfter: "0.001" }, 100)).toBe(5)
    expect(computeProjectorRetryDelayMs(0, { retryAfter: "0.25" }, 100)).toBe(250)
    const expDelay = computeProjectorRetryDelayMs(2, new Error("429"), 100)
    expect(expDelay).toBeGreaterThanOrEqual(200)
    expect(expDelay).toBeLessThanOrEqual(400)
    expect(computeProjectorRetryDelayMs(0, new Error("429"), 1)).toBe(5)

    const run429 = WorkflowRunId.make("run-wf6-429-exhaust")
    const client429 = wrapHarnessClient(ogHarness, {
      onMutate: async () => {
        throw Object.assign(new Error("Too Many Requests: custom-429-detail"), {
          status: 429,
          retryAfter: "0.001",
        })
      },
    })
    const out429 = await Effect.runPromise(
      projectWorkflowRunImpl(
        {
          runId: run429,
          targetBranch: { _tag: "Explicit", branch: overrideBranch },
          trigger: "wave",
        },
        { repoRoot: harness.getRepoRoot(), harnessClient: client429 },
      ).pipe(Effect.provide(makeSingleRunReadModelLayer(run429))),
    )
    expectStaleOutcome(out429, "custom-429-detail")
    expectStaleOutcome(out429, "exhausted")
  })

  it("F-12.5: projectAll returns Projected with mixed Projected+Skipped children and propagates pure Fiber.interrupt", async () => {
    const ogHarness = createHarnessCliClient()
    const runOk = WorkflowRunId.make("run-wf6-mixed-ok")
    const runVanished = WorkflowRunId.make("run-wf6-mixed-vanished")
    const branch = OmnigraphBranchName.make("main")
    const okRecord = makeRunRecord(runOk)
    const mixedReadModelLayer = Layer.succeed(WorkflowReadModelQuery, {
      getRun: (id) => Effect.succeed(id === runOk ? Option.some(okRecord) : Option.none()),
      listRuns: Effect.succeed([okRecord, makeRunRecord(runVanished)]),
      listUnits: () => Effect.succeed([]),
      listAttempts: () => Effect.succeed([]),
      probeAvailability: Effect.succeed("ready" as const),
    })
    const mixedOutcome = await Effect.runPromise(
      projectAllWorkflowRunsImpl(
        {
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
          repoRoot: harness.getRepoRoot(),
        },
        { repoRoot: harness.getRepoRoot(), harnessClient: ogHarness },
      ).pipe(Effect.provide(mixedReadModelLayer)),
    )
    match(mixedOutcome)
      .with({ _tag: "Projected" }, (p) => {
        expect(p.projectionStatus).toBe("fresh")
        expect(p.outcomes.map((o) => o._tag)).toEqual(["Projected", "Skipped"])
      })
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () => expect.unreachable("expected Projected"))
      .exhaustive()

    const hangingClient = makeHangingBranchesClient(ogHarness)
    const interruptExit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* projectAllWorkflowRunsImpl(
          {
            targetBranch: { _tag: "Explicit", branch },
            trigger: "post-rebuild",
            repoRoot: harness.getRepoRoot(),
          },
          { repoRoot: harness.getRepoRoot(), harnessClient: hangingClient },
        ).pipe(Effect.provide(mixedReadModelLayer), Effect.forkChild)
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    match(interruptExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(isPureInterruptCause(cause)).toBe(true)
        expect(Cause.hasFails(cause)).toBe(false)
      })
      .with({ _tag: "Success" }, () => expect.unreachable("expected pure interrupt"))
      .exhaustive()
  })

  it.effect(
    "F-12.2: TestClock verifies workflowIpcMs on project() and workflowCompleteIpcMs on projectAll() return Stale",
    () =>
      Effect.gen(function* () {
        const ogHarness = createHarnessCliClient()
        const runId = WorkflowRunId.make("run-wf6-testclock-timeout")
        const branch = OmnigraphBranchName.make("main")
        const readModelLayer = makeSingleRunReadModelLayer(runId)
        const hangingClient = makeHangingBranchesClient(ogHarness)

        const projectFiber = yield* projectWorkflowRunImpl(
          {
            runId,
            targetBranch: { _tag: "Explicit", branch },
            trigger: "wave",
            repoRoot: harness.getRepoRoot(),
          },
          { repoRoot: harness.getRepoRoot(), harnessClient: hangingClient },
        ).pipe(Effect.provide(readModelLayer), Effect.forkChild)
        yield* TestClock.adjust("1 millis")
        yield* TestClock.adjust(`${WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs} millis`)
        expectStaleOutcome(yield* Fiber.join(projectFiber), "aggregate timeout")

        const projectAllFiber = yield* projectAllWorkflowRunsImpl(
          {
            targetBranch: { _tag: "Explicit", branch },
            trigger: "post-rebuild",
            repoRoot: harness.getRepoRoot(),
          },
          { repoRoot: harness.getRepoRoot(), harnessClient: hangingClient },
        ).pipe(Effect.provide(readModelLayer), Effect.forkChild)
        yield* TestClock.adjust("1 millis")
        yield* TestClock.adjust(`${WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs} millis`)
        expectStaleOutcome(yield* Fiber.join(projectAllFiber), "aggregate timeout")
      }),
  )
})
