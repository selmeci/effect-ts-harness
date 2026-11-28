import { afterAll, beforeAll, describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { match } from "ts-pattern"
import {
  OmnigraphBranchName,
  OwnedRelPath,
  PlanJsonPayload,
  WaveIndex,
  WorkUnitId,
  WorkflowRunId,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { HARNESS_OMNIGRAPH_GRAPH_ID, makeOmnigraphClient } from "@harness/graph"
import { WorkflowProjector } from "@harness/service"
import {
  makeWorkflowProjectorLayer,
  nodeSyncHostIo,
  projectAllWorkflowRunsImpl,
  projectWorkflowRunImpl,
} from "../src/index.js"
import { resolveWritableTargetBranch } from "../src/workflow/workflow-projector-runtime.js"
import {
  NOW_MS,
  expectStaleOutcome,
  makeSingleRunReadModelLayer,
  wrapHarnessClient,
} from "./helpers/workflow-projector-test-helpers.js"
import { startWorkflowReadModelServerHarness } from "./helpers/workflow-read-model-fixture.js"

describe("WF-6 WorkflowProjectorLive OCC, Commit, & Resolution Resilience", () => {
  const harness = startWorkflowReadModelServerHarness("wf6-resilience-")
  let serverBaseUrl = ""
  const createHarnessCliClient = () =>
    makeOmnigraphClient({
      baseUrl: serverBaseUrl,
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      actor: "harness-cli",
      token: harness.cliToken,
    })

  beforeAll(async () => {
    await harness.start()
    const wfClient = harness.createClient()
    const transport = Reflect.get(wfClient, "t") as { readonly baseUrl?: string } | undefined
    serverBaseUrl = transport?.baseUrl ?? ""
    expect(serverBaseUrl.startsWith("http://127.0.0.1:")).toBe(true)
  }, 30_000)

  afterAll(async () => {
    await harness.stop()
  })

  it("F-4.1, F-4.2, F-11.4: enforces unconditional ifGraphCommit, rejects missing/malformed commit.graphCommitId and InvalidPlanJson into Stale", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-commit-checks")
    const unitId = WorkUnitId.make("unit-checks")
    const branch = OmnigraphBranchName.make("impl/wf6-commit-checks")
    await ogHarness.branches.create({ name: branch, from: "main" })

    const readModelLayer = makeSingleRunReadModelLayer(runId, {
      units: [
        {
          unitKey: makeWorkflowUnitKey(runId, unitId),
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

    const observedIfGraphCommits: Array<string | undefined> = []
    const trackingClient = wrapHarnessClient(ogHarness, {
      onMutate: async (orig, input, opts) => {
        observedIfGraphCommits.push(opts?.ifGraphCommit)
        return orig(input, opts)
      },
    })
    const trackingLayer = makeWorkflowProjectorLayer({
      repoRoot: harness.getRepoRoot(),
      harnessClient: trackingClient,
    }).pipe(Layer.provide(readModelLayer))
    const okOut = await Effect.runPromise(
      Effect.gen(function* () {
        const projector = yield* WorkflowProjector
        return yield* projector.project({
          runId,
          targetBranch: { _tag: "Explicit", branch },
          trigger: "wave",
        })
      }).pipe(Effect.provide(trackingLayer)),
    )
    expect(okOut._tag).toBe("Projected")
    expect(observedIfGraphCommits.length).toBe(1)
    expect((observedIfGraphCommits[0] ?? "").trim().length).toBeGreaterThan(0)

    const missingCommitClient = wrapHarnessClient(ogHarness, {
      onQuery: async (orig, input, opts) => ({ ...(await orig(input, opts)), graphCommitId: null }),
    })
    const missingSnapOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "Explicit", branch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: missingCommitClient },
      ).pipe(Effect.provide(readModelLayer)),
    )
    expectStaleOutcome(missingSnapOut)

    const runBadMutate = WorkflowRunId.make("run-wf6-bad-mutate-commit")
    const badMutateClient = wrapHarnessClient(ogHarness, {
      onMutate: async (orig, input, opts) => {
        const res = await orig(input, opts)
        return {
          ...res,
          commit:
            res.commit !== undefined && res.commit !== null
              ? { ...res.commit, graphCommitId: "   " }
              : null,
        }
      },
    })
    const badCommitOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId: runBadMutate, targetBranch: { _tag: "Explicit", branch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: badMutateClient },
      ).pipe(Effect.provide(makeSingleRunReadModelLayer(runBadMutate))),
    )
    expectStaleOutcome(badCommitOut, "graphCommitId")

    const runBadPlan = WorkflowRunId.make("run-wf6-invalid-plan-json")
    const badPlanOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId: runBadPlan, targetBranch: { _tag: "Explicit", branch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: ogHarness },
      ).pipe(
        Effect.provide(
          makeSingleRunReadModelLayer(runBadPlan, {
            planJson: PlanJsonPayload.make("{not-valid-json"),
          }),
        ),
      ),
    )
    expectStaleOutcome(badPlanOut)
  })

  it("F-5.2 & F-11.1: catches branch/repo resolution errors into Stale without '/' fallback", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-resolve-err")
    const readModelLayer = makeSingleRunReadModelLayer(runId)

    const throwingHostIo = {
      ...nodeSyncHostIo,
      getEnv: () => {
        throw new Error("boom in hostIo.getEnv")
      },
    }
    const hostIoDefectOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "ActiveTaskImplBranch" }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: ogHarness, hostIo: throwingHostIo },
      ).pipe(Effect.provide(readModelLayer)),
    )
    expectStaleOutcome(hostIoDefectOut, "boom in hostIo.getEnv")

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("relative/invalid-cwd")
    try {
      const invalidCwdProjectOut = await Effect.runPromise(
        projectWorkflowRunImpl(
          {
            runId,
            targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("main") },
            trigger: "wave",
          },
          { harnessClient: ogHarness },
        ).pipe(Effect.provide(readModelLayer)),
      )
      expectStaleOutcome(invalidCwdProjectOut, "relative/invalid-cwd")

      const invalidCwdAllOut = await Effect.runPromise(
        projectAllWorkflowRunsImpl(
          {
            targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("main") },
            trigger: "post-rebuild",
          },
          { harnessClient: ogHarness },
        ).pipe(Effect.provide(readModelLayer)),
      )
      expectStaleOutcome(invalidCwdAllOut, "relative/invalid-cwd")
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it("F-7.1 & F-7.2: preserves 412 exhaustion details and re-queries branches.list after branches.create 409 conflict", async () => {
    const ogHarness = createHarnessCliClient()
    const runId = WorkflowRunId.make("run-wf6-occ-details")
    const readModelLayer = makeSingleRunReadModelLayer(runId)

    const always412DetailedClient = wrapHarnessClient(ogHarness, {
      onMutate: async () => {
        throw Object.assign(new Error("Precondition Failed: custom-412-head-mismatch"), {
          status: 412,
        })
      },
    })
    const out412 = await Effect.runPromise(
      projectWorkflowRunImpl(
        {
          runId,
          targetBranch: { _tag: "Explicit", branch: OmnigraphBranchName.make("main") },
          trigger: "wave",
        },
        { repoRoot: harness.getRepoRoot(), harnessClient: always412DetailedClient },
      ).pipe(Effect.provide(readModelLayer)),
    )
    expectStaleOutcome(out412, "custom-412-head-mismatch")
    expectStaleOutcome(out412, "exhausted")

    const raceBranch = OmnigraphBranchName.make("impl/wf6-create-race")
    const create409MissingClient = wrapHarnessClient(ogHarness, {
      onBranchesList: async () => ["main"],
      onBranchesCreate: async () => {
        throw Object.assign(new Error("Conflict creating branch"), { status: 409 })
      },
    })
    const raceMissingOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "Explicit", branch: raceBranch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: create409MissingClient },
      ).pipe(Effect.provide(readModelLayer)),
    )
    expectStaleOutcome(raceMissingOut)

    let listCalls = 0
    const create409PresentClient = wrapHarnessClient(ogHarness, {
      onBranchesList: async (orig, opts) => {
        listCalls += 1
        return listCalls === 1 ? ["main"] : orig(opts)
      },
      onBranchesCreate: async (orig, input, opts) => {
        await orig(input, opts)
        throw Object.assign(new Error("Conflict: created concurrently"), { status: 409 })
      },
    })
    const racePresentOut = await Effect.runPromise(
      projectWorkflowRunImpl(
        { runId, targetBranch: { _tag: "Explicit", branch: raceBranch }, trigger: "wave" },
        { repoRoot: harness.getRepoRoot(), harnessClient: create409PresentClient },
      ).pipe(Effect.provide(readModelLayer)),
    )
    match(racePresentOut)
      .with({ _tag: "Projected" }, (p) => expect(p.branch).toBe(raceBranch))
      .with({ _tag: "Skipped" }, { _tag: "Stale" }, () =>
        expect.unreachable("expected Projected when branch exists on re-list"),
      )
      .exhaustive()
  })

  it("resolveWritableTargetBranch enforces wave/post-rebuild/done-pre-merge branch creation rules", async () => {
    const ogClient = createHarnessCliClient()
    const mainOnlyClient = wrapHarnessClient(ogClient, {
      onBranchesList: async () => ["main"],
    })
    const activeSelector = { _tag: "ActiveTaskImplBranch" as const }
    const explicitSelector = {
      _tag: "Explicit" as const,
      branch: OmnigraphBranchName.make("impl/explicit-missing"),
    }

    const waveActiveRes = await Effect.runPromise(
      resolveWritableTargetBranch(
        mainOnlyClient,
        OmnigraphBranchName.make("impl/derived-missing"),
        activeSelector,
        "wave",
      ),
    )
    expect(waveActiveRes._tag).toBe("Missing")

    const rebuildActiveRes = await Effect.runPromise(
      resolveWritableTargetBranch(
        mainOnlyClient,
        OmnigraphBranchName.make("impl/derived-missing"),
        activeSelector,
        "post-rebuild",
      ),
    )
    expect(rebuildActiveRes).toEqual({
      _tag: "Resolved",
      branch: OmnigraphBranchName.make("main"),
    })

    const rebuildExplicitRes = await Effect.runPromise(
      resolveWritableTargetBranch(
        mainOnlyClient,
        explicitSelector.branch,
        explicitSelector,
        "post-rebuild",
      ),
    )
    expect(rebuildExplicitRes._tag).toBe("Missing")

    const doneMissingRes = await Effect.runPromise(
      resolveWritableTargetBranch(
        mainOnlyClient,
        explicitSelector.branch,
        explicitSelector,
        "done-pre-merge",
      ),
    )
    expect(doneMissingRes._tag).toBe("Missing")
  })
})
