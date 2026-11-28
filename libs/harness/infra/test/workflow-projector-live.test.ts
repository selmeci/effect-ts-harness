import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
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
  RunnerId,
  StubSymbolKey,
  WORKFLOW_TIMEOUT_BUDGETS,
  WaveIndex,
  WorkUnitId,
  WorkflowAttemptRecord,
  WorkflowExecutionId,
  WorkflowProjectionStatus,
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkflowUnitRecord,
  isPureInterruptCause,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
  toBoundedReason,
} from "@harness/contract"
import { HARNESS_OMNIGRAPH_GRAPH_ID, OmnigraphClient, makeOmnigraphClient } from "@harness/graph"
import {
  WorkflowProjector,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
  type WorkflowReadModelQueryShape,
} from "@harness/service"
import {
  WorkflowProjectorLive,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowProjectorLayer,
  makeWorkflowReadModelQueryLayer,
  nodeSyncHostIo,
  projectAllWorkflowRunsImpl,
  projectWorkflowRunImpl,
} from "../src/index.js"
import { readTargetStateSnapshot } from "../src/workflow/workflow-projector-query.js"
import {
  type Omnigraph,
  runWithTestTracer,
  startWorkflowReadModelServerHarness,
} from "./helpers/workflow-read-model-fixture.js"

const encodeCompiledPlan = Schema.encodeSync(Schema.fromJsonString(CompiledPlan))

const BASE_SHA = GitCommitSha.make("a".repeat(40))
const PLAN_SHA = PlanSha256.make("b".repeat(64))
const STAMP_HASH = PackageStampHash.make("c".repeat(64))
const NOW_MS = WorkflowTimestampMs.make(1_700_000_000_000)

const wrapHarnessClient = (
  client: Omnigraph,
  overrides: {
    readonly onMutate?: (
      orig: typeof client.mutate,
      input: Parameters<typeof client.mutate>[0],
      opts?: Parameters<typeof client.mutate>[1],
    ) => ReturnType<typeof client.mutate>
    readonly onQuery?: (
      orig: typeof client.query,
      input: Parameters<typeof client.query>[0],
      opts?: Parameters<typeof client.query>[1],
    ) => ReturnType<typeof client.query>
    readonly onBranchesList?: (
      orig: typeof client.branches.list,
      opts?: Parameters<typeof client.branches.list>[0],
    ) => ReturnType<typeof client.branches.list>
  },
): Omnigraph =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "mutate" && overrides.onMutate !== undefined) {
        const fn = overrides.onMutate
        return (
          input: Parameters<typeof target.mutate>[0],
          opts?: Parameters<typeof target.mutate>[1],
        ) => fn(target.mutate.bind(target), input, opts)
      }
      if (prop === "query" && overrides.onQuery !== undefined) {
        const fn = overrides.onQuery
        return (
          input: Parameters<typeof target.query>[0],
          opts?: Parameters<typeof target.query>[1],
        ) => fn(target.query.bind(target), input, opts)
      }
      if (prop === "branches" && overrides.onBranchesList !== undefined) {
        const fn = overrides.onBranchesList
        return new Proxy(target.branches, {
          get(bTarget, bProp, bReceiver) {
            if (bProp === "list") {
              return (opts?: Parameters<typeof target.branches.list>[0]) =>
                fn(bTarget.list.bind(bTarget), opts)
            }
            return Reflect.get(bTarget, bProp, bReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })

const makeStubReadModelLayer = (data: {
  readonly runs: ReadonlyMap<WorkflowRunId, WorkflowRunRecord>
  readonly unitsByRun: ReadonlyMap<WorkflowRunId, ReadonlyArray<WorkflowUnitRecord>>
  readonly attemptsByRun: ReadonlyMap<WorkflowRunId, ReadonlyArray<WorkflowAttemptRecord>>
  readonly failOnGetRun?: WorkflowStoreUnavailableError | undefined
}): Layer.Layer<WorkflowReadModelQuery> => {
  const shape: WorkflowReadModelQueryShape = {
    getRun: (runId) =>
      data.failOnGetRun !== undefined
        ? Effect.fail(data.failOnGetRun)
        : Effect.succeed(Option.fromUndefinedOr(data.runs.get(runId))),
    listRuns:
      data.failOnGetRun !== undefined
        ? Effect.fail(data.failOnGetRun)
        : Effect.succeed(Array.from(data.runs.values())),
    listUnits: (runId) => Effect.succeed(data.unitsByRun.get(runId) ?? []),
    listAttempts: (runId) => Effect.succeed(data.attemptsByRun.get(runId) ?? []),
    probeAvailability: Effect.succeed("ready" as const),
  }
  return Layer.succeed(WorkflowReadModelQuery, shape)
}

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
    // Extract baseUrl from workflow client transport by probing via a small helper branch op or reading server via repoRoot
    // Actually makeWorkflowOmnigraphClient sets baseUrl from serverBaseUrl inside harness; capture it from a fetch hook:
    const wfClient = createWorkflowClient()
    const baseClient = new OmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
    })
    void baseClient
    // Inspect resolved url via fetch proxy on wfClient? Simpler: startWorkflowReadModelServerHarness doesn't expose baseUrl directly,
    // so read it from a quick Request passed to fetch or pass custom fetch? Even simpler:
    const branchList = await wfClient.branches.list()
    expect(branchList).toContain("main")
    // Read baseUrl from wfClient's transport via Reflect (internal property on Transport) or add nothing outside infra/test:
    const transport = Reflect.get(wfClient, "t") as { readonly baseUrl?: string } | undefined
    serverBaseUrl = transport?.baseUrl ?? ""
    expect(serverBaseUrl.startsWith("http://127.0.0.1:")).toBe(true)
  }, 30_000)

  afterAll(async () => {
    await harness.stop()
  })

  const makeAlphaPlan = (runId: WorkflowRunId, unitId: WorkUnitId): CompiledPlan => ({
    runId,
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
        unitId,
        projectName: NxProjectName.make("@harness/alpha"),
        waveIndex: WaveIndex.make(0),
        dependsOn: [],
        ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
        stubKeys: [StubSymbolKey.make("libs/alpha/src/index.ts#alphaFn")],
        earsKeys: [EarsRequirementKey.make("harness:SPEC-0038::REQ-3.1")],
        packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
      },
    ],
    sharedStepPaths: [],
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

  it("auto-creates missing branch on 'wave', falls back to 'main' on 'post-rebuild', and skips on 'done-pre-merge'", async () => {
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
        const createdWave = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: missingWaveBranch },
          trigger: "wave",
          repoRoot,
        })
        const fallbackMain = yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch: missingRebuildBranch },
          trigger: "post-rebuild",
          repoRoot,
        })
        return { skippedDone, createdWave, fallbackMain }
      }).pipe(Effect.provide(fullLayer)),
    )

    expect(outcomes.skippedDone._tag).toBe("Skipped")
    match(outcomes.createdWave)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe(missingWaveBranch))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected wave create"),
      )
      .exhaustive()
    match(outcomes.fallbackMain)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe("main"))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected post-rebuild fallback to main"),
      )
      .exhaustive()

    await Effect.runPromise(harness.cleanupRunsAndJournal(wfClient, [runId]))
  })

  it("retries on 412/409 OCC conflicts with fresh graphCommitId re-read and succeeds on retry 2", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-occ-03")
    const execId = WorkflowExecutionId.make("exec-wf6-occ-03")
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

    const readModelLayer = makeStubReadModelLayer({
      runs: new Map([
        [
          runId,
          {
            runId,
            executionId: execId,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "running",
            updatedMs: NOW_MS,
          },
        ],
      ]),
      unitsByRun: new Map([
        [
          runId,
          [
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
        ],
      ]),
      attemptsByRun: new Map(),
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
    const execId = WorkflowExecutionId.make("exec-wf6-stale-04")
    const branch = OmnigraphBranchName.make("main")

    const runs = new Map<WorkflowRunId, WorkflowRunRecord>([
      [
        runId,
        {
          runId,
          executionId: execId,
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          state: "running",
          updatedMs: NOW_MS,
        },
      ],
    ])
    const readModelLayer = makeStubReadModelLayer({
      runs,
      unitsByRun: new Map(),
      attemptsByRun: new Map(),
    })

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
        if (capturedUrl.endsWith("/mutate")) {
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
    const execId = WorkflowExecutionId.make("exec-wf6-direct-06")
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

    const readModelLayer = makeStubReadModelLayer({
      runs: new Map([
        [
          runId,
          {
            runId,
            executionId: execId,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "running",
            updatedMs: NOW_MS,
          },
        ],
      ]),
      unitsByRun: new Map([
        [
          runId,
          [
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
        ],
      ]),
      attemptsByRun: new Map(),
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
    const execOk = WorkflowExecutionId.make("exec-wf6-edge-ok")
    const execFail = WorkflowExecutionId.make("exec-wf6-edge-fail")
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
    const oneRunReadModel = makeStubReadModelLayer({
      runs: new Map([
        [
          runOk,
          {
            runId: runOk,
            executionId: execOk,
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
        [
          runOk,
          {
            runId: runOk,
            executionId: execOk,
            level: "slice",
            planSha: PLAN_SHA,
            baseSha: BASE_SHA,
            state: "running",
            updatedMs: NOW_MS,
          },
        ],
        [
          runFail,
          {
            runId: runFail,
            executionId: execFail,
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
})
