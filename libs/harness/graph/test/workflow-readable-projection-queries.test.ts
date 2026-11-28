import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ForbiddenError, Omnigraph, PreconditionFailedError } from "@modernrelay/omnigraph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HARNESS_GQ_QUERY_NAMES, HARNESS_OMNIGRAPH_GRAPH_ID } from "../src/index.js"
import {
  graphConfigDir,
  omnigraphBin,
  requireRows,
  startWorkflowGraphServerHarness,
  unlockClusterIfLocked,
} from "./helpers/workflow-graph-server-fixture.js"

const createPreWf6ConfigDir = (rootDir: string): string => {
  const preConfigDir = join(rootDir, "pre-wf6-config")
  const preQueriesDir = join(preConfigDir, "queries")
  const preWorkflowQueriesDir = join(preConfigDir, "workflow-queries")
  mkdirSync(preQueriesDir, { recursive: true })
  mkdirSync(preWorkflowQueriesDir, { recursive: true })

  for (const file of [
    "cluster.yaml",
    "cluster.policy.yaml",
    "graph.policy.yaml",
    "policies.cedar",
    "workflows.policy.yaml",
    "workflows.schema.pg",
  ]) {
    copyFileSync(join(graphConfigDir, file), join(preConfigDir, file))
  }
  copyFileSync(
    join(graphConfigDir, "workflow-queries", "workflows.gq"),
    join(preWorkflowQueriesDir, "workflows.gq"),
  )

  const fullSchema = readFileSync(join(graphConfigDir, "schema.pg"), "utf8")
  const wf6NodeIdx = fullSchema.indexOf("node WorkflowRun")
  const wf6EdgeIdx = fullSchema.indexOf("edge PlaysRunUnitRole")
  expect(wf6NodeIdx).toBeGreaterThan(0)
  expect(wf6EdgeIdx).toBeGreaterThan(wf6NodeIdx)
  const preSchema =
    fullSchema.slice(0, wf6NodeIdx).trimEnd() +
    "\n\n" +
    fullSchema.slice(fullSchema.indexOf("edge PlaysCallerRole"), wf6EdgeIdx).trimEnd() +
    "\n"
  writeFileSync(join(preConfigDir, "schema.pg"), preSchema)

  const fullQueries = readFileSync(join(graphConfigDir, "queries", "harness.gq"), "utf8")
  const wf6QueryIdx = fullQueries.indexOf("query workflow_pending_units")
  expect(wf6QueryIdx).toBeGreaterThan(0)
  writeFileSync(
    join(preQueriesDir, "harness.gq"),
    fullQueries.slice(0, wf6QueryIdx).trimEnd() + "\n",
  )

  return preConfigDir
}

const getBranchGraphCommitId = async (og: Omnigraph, branch: string): Promise<string> => {
  const probe = await og.query({
    branch,
    query: "query probe_commit() { match { $r: WorkflowRun } return { $r.runId } limit 1 }",
  })
  const commitId = probe.graphCommitId
  if (typeof commitId !== "string" || commitId.length === 0) {
    return expect.unreachable("Expected Omnigraph query envelope to expose graphCommitId")
  }
  return commitId
}

const SEED_WF6_PROJECTION_MUTATION = `query seed_wf6_projection(
  $runAlpha: String,
  $runBeta: String,
  $planSha: String,
  $baseSha: String,
  $stampHash: String,
  $rejection: String?
) {
  insert WorkflowRun {
    runId: $runAlpha,
    level: "slice",
    planSha: $planSha,
    baseSha: $baseSha,
    state: "running"
  }
  insert WorkflowRun {
    runId: $runBeta,
    level: "epic",
    planSha: $planSha,
    baseSha: $baseSha,
    state: "completed"
  }
  insert WorkUnit {
    unitKey: "wf6-run-alpha/unit-done",
    runId: $runAlpha,
    unitId: "unit-done",
    kind: "package",
    waveIndex: 0,
    status: "completed",
    ownedRelPaths: ["libs/harness/contract/src/workflow-projection.ts"]
  }
  insert WorkUnit {
    unitKey: "wf6-run-alpha/unit-pending",
    runId: $runAlpha,
    unitId: "unit-pending",
    kind: "package",
    waveIndex: 1,
    status: "pending",
    ownedRelPaths: ["libs/harness/graph/schema.pg"]
  }
  insert WorkUnit {
    unitKey: "wf6-run-alpha/unit-dispatched",
    runId: $runAlpha,
    unitId: "unit-dispatched",
    kind: "slice",
    waveIndex: 2,
    status: "dispatched",
    ownedRelPaths: ["libs/harness/infra/src/workflow/workflow-projector-live.ts"]
  }
  insert WorkUnit {
    unitKey: "wf6-run-beta/unit-beta-done",
    runId: $runBeta,
    unitId: "unit-beta-done",
    kind: "slice",
    waveIndex: 0,
    status: "completed",
    ownedRelPaths: ["libs/harness/graph/queries/harness.gq"]
  }
  insert UnitAttempt {
    attemptKey: "wf6-run-alpha/unit-done#1",
    attempt: 1,
    verdict: "completed",
    runner: "claude-code",
    rejection: $rejection,
    packageStampHash: $stampHash
  }
  insert EffectFn {
    qualname: "libs/harness/infra/src/workflow/workflow-projector-live.ts#WorkflowProjector.project",
    spanName: "WorkflowProjector.project",
    packageTag: "infra",
    file: "libs/harness/infra/src/workflow/workflow-projector-live.ts",
    line: 42,
    isStub: true
  }
  insert EarsSpec {
    id: "harness:SPEC-COVERED",
    qualname: "harness:SPEC-COVERED",
    title: "Covered Spec",
    status: "accepted",
    path: "libs/harness/docs/specs/covered.md",
    enforcedByFiles: ["libs/harness/contract/src/workflow-projection.ts"]
  }
  insert EarsSpec {
    id: "harness:SPEC-UNCOVERED",
    qualname: "harness:SPEC-UNCOVERED",
    title: "Uncovered Spec",
    status: "proposed",
    path: "libs/harness/docs/specs/uncovered.md",
    enforcedByFiles: ["libs/harness/graph/schema.pg"]
  }
  insert EarsSpec {
    id: "harness:SPEC-UNRELATED",
    qualname: "harness:SPEC-UNRELATED",
    title: "Unrelated Spec",
    status: "accepted",
    path: "libs/harness/docs/specs/unrelated.md",
    enforcedByFiles: ["libs/harness/contract/src/index.ts"]
  }
  insert TraceabilityTuple {
    relationId: "tt-wf6-1",
    qualname: "tt-wf6-1",
    earsSpecId: "harness:SPEC-UNCOVERED",
    requirementId: "REQ-1.1",
    targetSymbolQualname: "libs/harness/infra/src/workflow/workflow-projector-live.ts#WorkflowProjector.project"
  }
  insert VitestCase {
    testId: "libs/harness/graph/test/workflow-readable-projection-queries.test.ts::wf6",
    qualname: "libs/harness/graph/test/workflow-readable-projection-queries.test.ts::wf6",
    testFile: "libs/harness/graph/test/workflow-readable-projection-queries.test.ts",
    testName: "wf6"
  }
  insert PlaysRunUnitRole { from: $runAlpha, to: "wf6-run-alpha/unit-done", role: "run-unit", archimateRelation: "Composition" }
  insert PlaysRunUnitRole { from: $runAlpha, to: "wf6-run-alpha/unit-pending", role: "run-unit", archimateRelation: "Composition" }
  insert PlaysRunUnitRole { from: $runAlpha, to: "wf6-run-alpha/unit-dispatched", role: "run-unit", archimateRelation: "Composition" }
  insert PlaysRunUnitRole { from: $runBeta, to: "wf6-run-beta/unit-beta-done", role: "run-unit", archimateRelation: "Composition" }
  insert PlaysUnitAttemptRole { from: "wf6-run-alpha/unit-done", to: "wf6-run-alpha/unit-done#1", role: "unit-attempt", archimateRelation: "Composition" }
  insert PlaysUnitStubRole { from: "wf6-run-alpha/unit-pending", to: "libs/harness/infra/src/workflow/workflow-projector-live.ts#WorkflowProjector.project", role: "unit-stub", archimateRelation: "Realization" }
  insert PlaysUnitEarsRole { from: "wf6-run-alpha/unit-done", to: "harness:SPEC-COVERED", role: "unit-ears", archimateRelation: "Realization" }
  insert PlaysUnitEarsRole { from: "wf6-run-alpha/unit-dispatched", to: "harness:SPEC-COVERED", role: "unit-ears", archimateRelation: "Realization" }
  insert PlaysUnitEarsRole { from: "wf6-run-alpha/unit-pending", to: "harness:SPEC-UNCOVERED", role: "unit-ears", archimateRelation: "Realization" }
  insert PlaysUnitEarsRole { from: "wf6-run-beta/unit-beta-done", to: "harness:SPEC-UNCOVERED", role: "unit-ears", archimateRelation: "Realization" }
  insert PlaysUnitTraceabilityRole { from: "wf6-run-alpha/unit-pending", to: "tt-wf6-1", role: "unit-traceability", archimateRelation: "Association" }
  insert PlaysAttemptTestRole { from: "wf6-run-alpha/unit-done#1", to: "libs/harness/graph/test/workflow-readable-projection-queries.test.ts::wf6", role: "attempt-test", archimateRelation: "Serving" }
}`

describe("WF-6 analytical readable projection schema, GQ 2.1 presets & Cedar policy", () => {
  const harness = startWorkflowGraphServerHarness("wf6-readable-proj-")
  const tempDirs = harness.tempDirs
  const createHarnessCliClient = () =>
    new Omnigraph({
      baseUrl: harness.getServerBaseUrl(),
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      token: harness.cliToken,
    })
  const createAgentMcpClient = () =>
    new Omnigraph({
      baseUrl: harness.getServerBaseUrl(),
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      token: harness.mcpToken,
    })

  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

  it("lints schema.pg and queries/harness.gq with 0 errors and exact 22-query parity", () => {
    const gqPath = join(graphConfigDir, "queries", "harness.gq")
    const gqText = readFileSync(gqPath, "utf8")
    const declaredNames = [...gqText.matchAll(/^query\s+([a-zA-Z0-9_]+)\s*\(/gm)].map(
      (m) => m[1] ?? "",
    )
    expect(declaredNames).toEqual([...HARNESS_GQ_QUERY_NAMES])
    expect(declaredNames).toHaveLength(22)

    const out = execFileSync(
      omnigraphBin,
      ["lint", "--schema", join(graphConfigDir, "schema.pg"), "--query", gqPath, "--json"],
      { encoding: "utf8" },
    )
    const parsed = JSON.parse(out) as {
      readonly status: string
      readonly errors: number
      readonly warnings: number
      readonly queries_processed: number
      readonly results: ReadonlyArray<{ readonly name: string; readonly status: string }>
    }
    expect(parsed.status).toBe("ok")
    expect(parsed.errors).toBe(0)
    expect(parsed.warnings).toBe(0)
    expect(parsed.queries_processed).toBe(22)
    expect(parsed.results.map((r) => r.name)).toEqual(declaredNames)
    expect(parsed.results.every((r) => r.status === "ok")).toBe(true)
  })

  it("applies WF-6 schema additively via omnigraph cluster apply on a pre-WF-6 cluster without rebuild", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf6-additive-apply-"))
    tempDirs.push(tempRoot)
    const clusterDir = join(tempRoot, "cluster")
    mkdirSync(clusterDir, { recursive: true })
    const preConfigDir = createPreWf6ConfigDir(tempRoot)

    const initialOut = execFileSync(
      omnigraphBin,
      [
        "cluster",
        "apply",
        "--target",
        `file://${clusterDir}`,
        "--config",
        preConfigDir,
        "--as",
        "harness-cli",
        "--json",
      ],
      { encoding: "utf8" },
    )
    unlockClusterIfLocked(clusterDir, initialOut)

    const upgradeOut = execFileSync(
      omnigraphBin,
      [
        "cluster",
        "apply",
        "--target",
        `file://${clusterDir}`,
        "--config",
        graphConfigDir,
        "--as",
        "harness-cli",
        "--json",
      ],
      { encoding: "utf8" },
    )
    unlockClusterIfLocked(clusterDir, upgradeOut)
    const upgradeJson = JSON.parse(upgradeOut) as { readonly status?: string }
    expect(upgradeJson.status).toBe("complete")
  })

  it("mutates WF-6 nodes and all 6 Plays*Role edges with ifGraphCommit and executes GQ 2.1 presets across multiple runs", async () => {
    const cliOg = createHarnessCliClient()
    const mcpOg = createAgentMcpClient()

    const initialCommitId = await getBranchGraphCommitId(cliOg, "main")

    const mutationResult = await cliOg.mutate(
      {
        branch: "main",
        query: SEED_WF6_PROJECTION_MUTATION,
        params: {
          runAlpha: "wf6-run-alpha",
          runBeta: "wf6-run-beta",
          planSha: "a".repeat(64),
          baseSha: "b".repeat(40),
          stampHash: "c".repeat(64),
          rejection: null,
        },
      },
      { ifGraphCommit: initialCommitId },
    )
    expect(mutationResult.commit?.graphCommitId).toBeTruthy()
    expect(mutationResult.commit?.graphCommitId).not.toBe(initialCommitId)

    // Stale ifGraphCommit precondition must fail with 412 PreconditionFailedError
    await expect(
      cliOg.mutate(
        {
          branch: "main",
          query: `query stale_attempt($runId: String, $planSha: String, $baseSha: String) {
            insert WorkflowRun {
              runId: $runId,
              level: "slice",
              planSha: $planSha,
              baseSha: $baseSha,
              state: "running"
            }
          }`,
          params: {
            runId: "wf6-run-stale",
            planSha: "d".repeat(64),
            baseSha: "e".repeat(40),
          },
        },
        { ifGraphCommit: initialCommitId },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError)

    for (const actorClient of [cliOg, mcpOg]) {
      const pendingAlpha = requireRows(
        await actorClient.queries.invoke("workflow_pending_units", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf6-run-alpha" },
        }),
      )
      expect(pendingAlpha).toEqual([{ unitId: "unit-pending", waveIndex: 1, kind: "package" }])

      const pendingBeta = requireRows(
        await actorClient.queries.invoke("workflow_pending_units", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf6-run-beta" },
        }),
      )
      expect(pendingBeta).toEqual([])

      // Positive $memberUnit binding excludes spec-unrelated; negation excludes spec-covered
      // (completed in alpha via unit-done); $run scoping keeps spec-uncovered in alpha despite
      // unit-beta-done being completed in beta.
      const uncoveredAlpha = requireRows(
        await actorClient.queries.invoke("ears_without_completed_unit", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf6-run-alpha" },
        }),
      )
      expect(uncoveredAlpha).toEqual([
        { specId: "harness:SPEC-UNCOVERED", path: "libs/harness/docs/specs/uncovered.md" },
      ])

      const uncoveredBeta = requireRows(
        await actorClient.queries.invoke("ears_without_completed_unit", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf6-run-beta" },
        }),
      )
      expect(uncoveredBeta).toEqual([])
    }
  })

  it("enforces Cedar policy: agent-mcp denied ForbiddenError on mutate/load targeting WorkflowRun/WorkUnit while allowed on read and invoke_query", async () => {
    const mcpOg = createAgentMcpClient()

    const snap = await mcpOg.snapshot({ branch: "main" })
    expect(snap.graphBranch).toBe("main")

    const readQuery = await mcpOg.query({
      branch: "main",
      query: "query read_runs() { match { $r: WorkflowRun } return { $r.runId } }",
    })
    expect(Array.isArray(readQuery.rows)).toBe(true)

    const invoked = await mcpOg.queries.invoke("workflow_pending_units", {
      branch: "main",
      expectMutation: false,
      params: { runId: "wf6-run-alpha" },
    })
    expect("rows" in invoked).toBe(true)

    await expect(
      mcpOg.mutate({
        branch: "main",
        query: `query mcp_mutate_run($runId: String, $planSha: String, $baseSha: String) {
          insert WorkflowRun {
            runId: $runId,
            level: "slice",
            planSha: $planSha,
            baseSha: $baseSha,
            state: "running"
          }
        }`,
        params: {
          runId: "wf6-mcp-forbidden",
          planSha: "f".repeat(64),
          baseSha: "1".repeat(40),
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    await expect(
      mcpOg.mutate({
        branch: "main",
        query: `query mcp_mutate_unit($unitKey: String, $runId: String) {
          insert WorkUnit {
            unitKey: $unitKey,
            runId: $runId,
            unitId: "unit-forbidden",
            kind: "package",
            waveIndex: 0,
            status: "pending",
            ownedRelPaths: ["libs/harness/graph/schema.pg"]
          }
        }`,
        params: {
          unitKey: "wf6-mcp-forbidden/unit-forbidden",
          runId: "wf6-mcp-forbidden",
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    await expect(
      mcpOg.load({
        branch: "main",
        mode: "merge",
        data: JSON.stringify({
          type: "WorkflowRun",
          data: {
            runId: "wf6-mcp-load-forbidden",
            level: "slice",
            planSha: "f".repeat(64),
            baseSha: "1".repeat(40),
            state: "running",
          },
        }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    await expect(
      mcpOg.branches.create({ name: "impl/wf6-mcp-forbidden", from: "main" }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(mcpOg.branches.merge({ source: "main", target: "main" })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(mcpOg.branches.delete("main")).rejects.toBeInstanceOf(ForbiddenError)
  })
})
