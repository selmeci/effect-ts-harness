import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ConflictError,
  PreconditionFailedError,
  TooManyRequestsError,
} from "@modernrelay/omnigraph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WORKFLOW_GQ_QUERY_NAMES } from "@harness/contract"
import {
  HARNESS_OMNIGRAPH_GRAPH_ID,
  OmnigraphLoadError,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  resolveGitCommonDir,
  resolveOmnigraphGraphId,
  resolveWorkflowOmnigraphConfig,
} from "../src/index.js"
import { makeExtendedTestHostIo, testHostIo } from "./helpers/test-host-io.js"
import {
  graphConfigDir,
  omnigraphBin,
  requireRows,
  startWorkflowGraphServerHarness,
} from "./helpers/workflow-graph-server-fixture.js"

describe("Workflow graph assets, WF-3 entity lifecycles & client config", () => {
  const harness = startWorkflowGraphServerHarness("wf2-graph-assets-")
  const tempDirs = harness.tempDirs
  const createCliClient = () => harness.createCliClient()
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

  it("lints workflows.schema.pg and workflow-queries/workflows.gq with 0 errors and exact query parity", () => {
    const gqPath = join(graphConfigDir, "workflow-queries", "workflows.gq")
    const gqText = readFileSync(gqPath, "utf8")
    const declaredQueryNames = [...gqText.matchAll(/^query\s+([a-zA-Z0-9_]+)\s*\(/gm)].map(
      (match) => match[1] ?? "",
    )
    expect(declaredQueryNames).toEqual([...WORKFLOW_GQ_QUERY_NAMES])
    expect(declaredQueryNames).toHaveLength(55)

    const out = execFileSync(
      omnigraphBin,
      [
        "lint",
        "--schema",
        join(graphConfigDir, "workflows.schema.pg"),
        "--query",
        gqPath,
        "--json",
      ],
      { encoding: "utf8" },
    )
    const parsed = JSON.parse(out) as {
      readonly status: string
      readonly errors: number
      readonly queries_processed: number
      readonly results: ReadonlyArray<{ readonly name: string; readonly status: string }>
    }
    expect(parsed.status).toBe("ok")
    expect(parsed.errors).toBe(0)
    expect(parsed.queries_processed).toBe(declaredQueryNames.length)
    expect(parsed.results).toHaveLength(declaredQueryNames.length)
    expect(parsed.results.map((r) => r.name)).toEqual(declaredQueryNames)
    expect(parsed.results.every((r) => r.status === "ok")).toBe(true)
  })

  it("executes WfWriterLease insert, CAS takeover, refresh, and lookup", async () => {
    const og = createCliClient()
    await og.queries.invoke("wf_insert_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: { name: "engine", owner: "daemon-1", leaseEpoch: 1, heartbeatMs: 1000 },
    })
    await og.queries.invoke("wf_cas_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: {
        name: "engine",
        expectedEpoch: 1,
        owner: "daemon-2",
        nextEpoch: 2,
        heartbeatMs: 2000,
      },
    })
    await og.queries.invoke("wf_refresh_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: { name: "engine", owner: "daemon-2", expectedEpoch: 2, heartbeatMs: 3000 },
    })
    const leaseRows = requireRows(
      await og.queries.invoke("wf_get_writer_lease", {
        branch: "main",
        expectMutation: false,
        params: { name: "engine" },
      }),
    )
    expect(leaseRows[0]).toMatchObject({
      name: "engine",
      owner: "daemon-2",
      leaseEpoch: 2,
      heartbeatMs: 3000,
    })
  })

  it("returns empty rows for missing WF-3 read-model lookups", async () => {
    const og = createCliClient()
    expect(
      requireRows(
        await og.queries.invoke("wf_probe_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_list_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_unit", {
          branch: "main",
          expectMutation: false,
          params: { unitKey: "wf3-missing-run/unit-0" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_attempt", {
          branch: "main",
          expectMutation: false,
          params: { attemptKey: "wf3-missing-run/unit-0#1" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])
  })

  it("executes WfRun lifecycle (wf_insert_run, wf_get_run, wf_list_runs, wf_probe_runs, wf_update_run)", async () => {
    const og = createCliClient()
    const runId1 = "wf3-run-001"
    const runId2 = "wf3-run-002"
    const planJson1 = JSON.stringify({ runId: runId1, level: "epic" })

    await og.queries.invoke("wf_insert_run", {
      branch: "main",
      expectMutation: true,
      params: {
        runId: runId1,
        executionId: "exec-wf3-001",
        level: "epic",
        planSha: "1".repeat(64),
        baseSha: "a".repeat(40),
        state: "running",
        planJson: planJson1,
        updatedMs: 1_000,
      },
    })
    await og.queries.invoke("wf_insert_run", {
      branch: "main",
      expectMutation: true,
      params: {
        runId: runId2,
        executionId: "exec-wf3-002",
        level: "slice",
        planSha: "2".repeat(64),
        baseSha: "b".repeat(40),
        state: "waiting",
        planJson: null,
        updatedMs: 2_000,
      },
    })

    const gotRun1 = requireRows(
      await og.queries.invoke("wf_get_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId1 },
      }),
    )
    expect(gotRun1).toHaveLength(1)
    expect(gotRun1[0]).toMatchObject({
      runId: runId1,
      executionId: "exec-wf3-001",
      level: "epic",
      state: "running",
      planJson: planJson1,
      updatedMs: 1_000,
    })

    const gotRun2 = requireRows(
      await og.queries.invoke("wf_get_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId2 },
      }),
    )
    expect(gotRun2[0]?.planJson ?? null).toBeNull()

    const listedBefore = requireRows(
      await og.queries.invoke("wf_list_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(listedBefore.map((r) => r.runId)).toEqual([runId2, runId1])

    const probed = requireRows(
      await og.queries.invoke("wf_probe_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(probed).toHaveLength(1)
    expect(Object.keys(probed[0] ?? {})).toEqual(["runId"])

    await og.queries.invoke("wf_update_run", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId1, state: "completed", updatedMs: 3_000 },
    })
    const listedAfter = requireRows(
      await og.queries.invoke("wf_list_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(listedAfter.map((r) => r.runId)).toEqual([runId1, runId2])

    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId1 },
    })
    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId2 },
    })
  })

  it("executes WfUnit lifecycle (wf_insert_unit, wf_get_unit, wf_update_unit, wf_units_for_run)", async () => {
    const og = createCliClient()
    const runId = "wf3-unit-run-1"
    const unitKey1b = `${runId}/unit-b`
    const unitKey1a = `${runId}/unit-a`

    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey1b,
        runId,
        unitId: "unit-b",
        kind: "package",
        waveIndex: 1,
        status: "pending",
        ownedRelPaths: ["libs/harness/graph/src/index.ts", "libs/harness/graph/test"],
        updatedMs: 1_100,
      },
    })
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey1a,
        runId,
        unitId: "unit-a",
        kind: "slice",
        waveIndex: 0,
        status: "dispatched",
        ownedRelPaths: ["libs/harness/contract/src"],
        updatedMs: 1_200,
      },
    })

    const gotUnit1b = requireRows(
      await og.queries.invoke("wf_get_unit", {
        branch: "main",
        expectMutation: false,
        params: { unitKey: unitKey1b },
      }),
    )
    expect(gotUnit1b[0]).toMatchObject({
      unitKey: unitKey1b,
      kind: "package",
      waveIndex: 1,
      status: "pending",
      ownedRelPaths: ["libs/harness/graph/src/index.ts", "libs/harness/graph/test"],
    })

    await og.queries.invoke("wf_update_unit", {
      branch: "main",
      expectMutation: true,
      params: { unitKey: unitKey1a, status: "completed", updatedMs: 1_500 },
    })
    const unitsForRun = requireRows(
      await og.queries.invoke("wf_units_for_run", {
        branch: "main",
        expectMutation: false,
        params: { runId },
      }),
    )
    expect(unitsForRun.map((u) => u.unitKey)).toEqual([unitKey1a, unitKey1b])
    expect(unitsForRun[0]?.status).toBe("completed")

    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId },
    })
  })

  it("executes WfAttempt lifecycle (wf_insert_attempt, wf_get_attempt, wf_update_attempt, wf_attempts_for_run)", async () => {
    const og = createCliClient()
    const runId = "wf3-attempt-run-1"
    const stampHash = "c".repeat(64)
    const attemptKey1a1 = `${runId}/unit-a#1`
    const attemptKey1a2 = `${runId}/unit-a#2`

    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a2,
        runId,
        unitId: "unit-a",
        attempt: 2,
        verdict: "dispatched",
        runner: "antigravity",
        rejection: null,
        packageStampHash: null,
        updatedMs: 1_600,
      },
    })
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a1,
        runId,
        unitId: "unit-a",
        attempt: 1,
        verdict: "rejected",
        runner: "claude-code",
        rejection: JSON.stringify({ _tag: "StampMissing" }),
        packageStampHash: null,
        updatedMs: 1_300,
      },
    })

    const gotAttempt1 = requireRows(
      await og.queries.invoke("wf_get_attempt", {
        branch: "main",
        expectMutation: false,
        params: { attemptKey: attemptKey1a1 },
      }),
    )
    expect(gotAttempt1[0]).toMatchObject({
      attemptKey: attemptKey1a1,
      verdict: "rejected",
      runner: "claude-code",
      rejection: JSON.stringify({ _tag: "StampMissing" }),
    })
    expect(gotAttempt1[0]?.packageStampHash ?? null).toBeNull()

    await og.queries.invoke("wf_update_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a2,
        verdict: "completed",
        runner: "antigravity",
        rejection: null,
        packageStampHash: stampHash,
        updatedMs: 1_900,
      },
    })
    const attemptsForRun = requireRows(
      await og.queries.invoke("wf_attempts_for_run", {
        branch: "main",
        expectMutation: false,
        params: { runId },
      }),
    )
    expect(attemptsForRun.map((a) => a.attemptKey)).toEqual([attemptKey1a1, attemptKey1a2])
    expect(attemptsForRun[1]?.verdict).toBe("completed")
    expect(attemptsForRun[1]?.packageStampHash).toBe(stampHash)

    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId },
    })
  })

  it("executes WfShipAttempt lifecycle (wf_insert_ship_attempt, wf_get_ship_attempt, wf_update_ship_attempt, wf_ship_attempts_for_run)", async () => {
    const og = createCliClient()
    const runId = "wf4-ship-run-1"
    const shipKey1 = `${runId}#1`
    const shipKey2 = `${runId}#2`
    const treeHash1 = "d".repeat(64)
    const treeHash2 = "e".repeat(64)

    expect(
      requireRows(
        await og.queries.invoke("wf_get_ship_attempt", {
          branch: "main",
          expectMutation: false,
          params: { shipKey: shipKey1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_ship_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId },
        }),
      ),
    ).toEqual([])

    await og.queries.invoke("wf_insert_ship_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        shipKey: shipKey2,
        runId,
        attempt: 2,
        treeHash: treeHash2,
        status: "running",
        updatedMs: 2_600,
      },
    })
    const beforeAttempt1 = await og.queries.invoke("wf_get_ship_attempt", {
      branch: "main",
      expectMutation: false,
      params: { shipKey: shipKey1 },
    })
    expect(requireRows(beforeAttempt1)).toEqual([])
    const commitBeforeAttempt1 =
      "graphCommitId" in beforeAttempt1 && typeof beforeAttempt1.graphCommitId === "string"
        ? beforeAttempt1.graphCommitId
        : undefined
    if (commitBeforeAttempt1 === undefined) {
      expect.unreachable("Expected non-null graphCommitId before inserting attempt 1")
    }

    await og.queries.invoke(
      "wf_insert_ship_attempt",
      {
        branch: "main",
        expectMutation: true,
        params: {
          shipKey: shipKey1,
          runId,
          attempt: 1,
          treeHash: treeHash1,
          status: "failed",
          updatedMs: 2_300,
        },
      },
      { ifGraphCommit: commitBeforeAttempt1 },
    )

    await expect(
      og.queries.invoke(
        "wf_insert_ship_attempt",
        {
          branch: "main",
          expectMutation: true,
          params: {
            shipKey: shipKey1,
            runId,
            attempt: 1,
            treeHash: treeHash1,
            status: "running",
            updatedMs: 2_400,
          },
        },
        { ifGraphCommit: commitBeforeAttempt1 },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError)

    const gotShip1 = requireRows(
      await og.queries.invoke("wf_get_ship_attempt", {
        branch: "main",
        expectMutation: false,
        params: { shipKey: shipKey1 },
      }),
    )
    expect(gotShip1).toHaveLength(1)
    expect(gotShip1[0]).toMatchObject({
      shipKey: shipKey1,
      runId,
      attempt: 1,
      treeHash: treeHash1,
      status: "failed",
      updatedMs: 2_300,
    })

    await og.queries.invoke("wf_update_ship_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        shipKey: shipKey2,
        status: "passed",
        updatedMs: 2_900,
      },
    })

    const shipsForRun = requireRows(
      await og.queries.invoke("wf_ship_attempts_for_run", {
        branch: "main",
        expectMutation: false,
        params: { runId },
      }),
    )
    expect(shipsForRun.map((s) => s.shipKey)).toEqual([shipKey1, shipKey2])
    expect(shipsForRun.map((s) => s.attempt)).toEqual([1, 2])
    expect(shipsForRun[1]).toMatchObject({
      shipKey: shipKey2,
      runId,
      attempt: 2,
      treeHash: treeHash2,
      status: "passed",
      updatedMs: 2_900,
    })
  })

  it("deletes target run views via wf_delete_run_views while preserving sibling runs", async () => {
    const og = createCliClient()
    const runId1 = "wf3-del-run-1"
    const runId2 = "wf3-del-run-2"
    const unitKey2a = `${runId2}/unit-other`
    const attemptKey2a1 = `${runId2}/unit-other#1`

    for (const [runId, updatedMs] of [
      [runId1, 1_000],
      [runId2, 2_000],
    ] as const) {
      await og.queries.invoke("wf_insert_run", {
        branch: "main",
        expectMutation: true,
        params: {
          runId,
          executionId: `exec-${runId}`,
          level: "slice",
          planSha: "1".repeat(64),
          baseSha: "a".repeat(40),
          state: "running",
          planJson: null,
          updatedMs,
        },
      })
    }
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: `${runId1}/unit-a`,
        runId: runId1,
        unitId: "unit-a",
        kind: "slice",
        waveIndex: 0,
        status: "pending",
        ownedRelPaths: ["libs/a"],
        updatedMs: 1_100,
      },
    })
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey2a,
        runId: runId2,
        unitId: "unit-other",
        kind: "package",
        waveIndex: 0,
        status: "pending",
        ownedRelPaths: ["apps/harness-cli/src"],
        updatedMs: 2_100,
      },
    })
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: `${runId1}/unit-a#1`,
        runId: runId1,
        unitId: "unit-a",
        attempt: 1,
        verdict: "dispatched",
        runner: null,
        rejection: null,
        packageStampHash: null,
        updatedMs: 1_200,
      },
    })
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey2a1,
        runId: runId2,
        unitId: "unit-other",
        attempt: 1,
        verdict: "dispatched",
        runner: null,
        rejection: null,
        packageStampHash: null,
        updatedMs: 2_200,
      },
    })
    await og.queries.invoke("wf_insert_ship_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        shipKey: `${runId1}#1`,
        runId: runId1,
        attempt: 1,
        treeHash: "d".repeat(64),
        status: "running",
        updatedMs: 1_250,
      },
    })

    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId1 },
    })

    expect(
      requireRows(
        await og.queries.invoke("wf_get_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_ship_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ).map((s) => s.shipKey),
    ).toEqual([`${runId1}#1`])
    expect(
      requireRows(
        await og.queries.invoke("wf_list_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ).map((r) => r.runId),
    ).toEqual([runId2])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId2 },
        }),
      ).map((u) => u.unitKey),
    ).toEqual([unitKey2a])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId2 },
        }),
      ).map((a) => a.attemptKey),
    ).toEqual([attemptKey2a1])

    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId2 },
    })
  })

  it("exports resolveGitCommonDir across primary, linked, and invalid directories", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "wf2-git-common-"))
    tempDirs.push(tmpRoot)

    const nonGit = join(tmpRoot, "plain")
    mkdirSync(nonGit, { recursive: true })
    expect(resolveGitCommonDir(nonGit, testHostIo)).toBeNull()

    const primary = join(tmpRoot, "primary")
    mkdirSync(join(primary, ".git"), { recursive: true })
    expect(resolveGitCommonDir(primary, testHostIo)).toBe(join(primary, ".git"))

    const wtWithCommon = join(tmpRoot, "wt-common")
    const wtGitDir = join(primary, ".git", "worktrees", "wt-1")
    mkdirSync(wtWithCommon, { recursive: true })
    mkdirSync(wtGitDir, { recursive: true })
    writeFileSync(join(wtWithCommon, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")
    writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
    expect(resolveGitCommonDir(wtWithCommon, testHostIo)).toBe(join(primary, ".git"))

    const wtWithoutCommon = join(tmpRoot, "wt-no-common")
    const wtGitDir2 = join(primary, ".git", "worktrees", "wt-2")
    mkdirSync(wtWithoutCommon, { recursive: true })
    mkdirSync(wtGitDir2, { recursive: true })
    writeFileSync(join(wtWithoutCommon, ".git"), `gitdir: ${wtGitDir2}\n`, "utf8")
    expect(resolveGitCommonDir(wtWithoutCommon, testHostIo)).toBe(wtGitDir2)

    const throwingIo = makeExtendedTestHostIo({
      existsSync: () => {
        throw new Error("boom")
      },
    })
    expect(resolveGitCommonDir(primary, throwingIo)).toBeNull()
  })

  it("exports Omnigraph error classifiers and workflow client config resolvers", () => {
    const tooMany = new TooManyRequestsError({
      status: 429,
      message: "rate limited",
      request: { method: "POST", url: "http://127.0.0.1/query" },
    })
    const conflict = new ConflictError({
      status: 409,
      message: "conflict",
      request: { method: "POST", url: "http://127.0.0.1/mutate" },
    })
    const precondition = new PreconditionFailedError({
      status: 412,
      message: "stale",
      request: { method: "POST", url: "http://127.0.0.1/mutate" },
    })

    expect(isOmnigraphTooManyRequestsError(tooMany)).toBe(true)
    expect(isOmnigraphTooManyRequestsError({ status: 429 })).toBe(true)
    expect(isOmnigraphTooManyRequestsError(new OmnigraphLoadError({ cause: tooMany }))).toBe(true)
    expect(isOmnigraphTooManyRequestsError(conflict)).toBe(false)
    expect(isOmnigraphTooManyRequestsError(null)).toBe(false)

    const cyclic: Record<string, unknown> = {}
    cyclic.cause = cyclic
    expect(isOmnigraphTooManyRequestsError(cyclic)).toBe(false)

    expect(isOmnigraphPreconditionOrConflictError(precondition)).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError(conflict)).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError({ status: 412 })).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError({ status: 409 })).toBe(true)
    expect(
      isOmnigraphPreconditionOrConflictError(new OmnigraphLoadError({ cause: precondition })),
    ).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError(tooMany)).toBe(false)
    expect(isOmnigraphPreconditionOrConflictError("not-an-error")).toBe(false)

    expect(resolveOmnigraphGraphId(undefined, {})).toBe(HARNESS_OMNIGRAPH_GRAPH_ID)
    expect(resolveOmnigraphGraphId({ graphId: "custom" }, { OMNIGRAPH_GRAPH_ID: "env-g" })).toBe(
      "custom",
    )
    expect(resolveOmnigraphGraphId(undefined, { OMNIGRAPH_GRAPH_ID: "env-g" })).toBe("env-g")

    const cfg = resolveWorkflowOmnigraphConfig({ baseUrl: "http://127.0.0.1:19000", token: "tok" })
    expect(cfg).toEqual({
      baseUrl: "http://127.0.0.1:19000",
      graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
      token: "tok",
    })
  })
})
