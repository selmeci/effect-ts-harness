import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, type Exit, Fiber, Layer } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  isPureInterruptCause,
  OmnigraphBranchName,
  toBoundedReason,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupTimestampMs,
  WorkflowProjectAllOutcome,
  WorkflowProjectionTargetBranch,
  type WorkflowProjectAllInput,
  type WorkflowProjectorInput,
} from "@harness/contract"
import {
  buildHarnessGraph,
  OmnigraphClient,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
} from "@harness/graph"
import { makeWorkflowGraphBackupLayer, nodeSyncHostIo } from "@harness/infra/omnigraph-session"
import { WorkflowProjector, type WorkflowProjectorShape } from "@harness/service"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import { reprojectWorkflowsBeforeMerge } from "../src/commands/done-workflow-projector.js"
import {
  evaluateClusterConfigDrift,
  extractSchemaEdgeKeys,
  hasBreakingSchemaEdgeKeyChange,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import {
  afterRebuildWorkflowBackup,
  resolveWorkflowBackupDir,
  runWorkflowRestoreAfterRebuild,
} from "../src/commands/omnigraph-workflow-backup.js"

const tempDirs: Array<string> = []

const makeTempWorkflowRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "harness", "graph", "queries"), { recursive: true })
  mkdirSync(join(dir, "libs", "harness", "graph", "workflow-queries"), { recursive: true })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "schema.pg"),
    [
      "node EffectFn { qualname: String @key }",
      "node EffectSignature { relationId: String @key }",
      "edge PlaysCallerRole: EffectSignature -> EffectFn @card(0..) {",
      "  @key(@src, @dst, role)",
      "  role: String @index",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "queries", "harness.gq"),
    "query q() { match { $n: EffectFn } return { $n.id as id } }\n",
    "utf8",
  )
  writeFileSync(join(dir, "libs", "harness", "graph", "graph.policy.yaml"), "version: 1\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "cluster.policy.yaml"),
    "version: 1\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflows.schema.pg"),
    "node WfMessage {\n  messageKey: String @key\n  seqKey: String @index\n}\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflow-queries", "workflows.gq"),
    "query wf_count_all() { match { $m: WfMessage } return { count($m) as totalMessages } }\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflows.policy.yaml"),
    "version: 1\nprotected_branches: [main]\n",
    "utf8",
  )
  return dir
}

const makeStubProjector = (options: {
  readonly onProjectAll: (
    input: WorkflowProjectAllInput,
  ) => Effect.Effect<WorkflowProjectAllOutcome>
}): WorkflowProjectorShape => ({
  project: (_input: WorkflowProjectorInput) => Effect.die(new Error("unexpected project() call")),
  projectAll: options.onProjectAll,
  getProjectionStatus: () => Effect.succeedNone,
})

const expectPureInterruptExit = <A, E>(exit: Exit.Exit<A, E>): void => {
  match(exit)
    .with({ _tag: "Success" }, () => expect.unreachable("expected pure interrupt Failure exit"))
    .with({ _tag: "Failure" }, ({ cause }) => {
      expect(isPureInterruptCause(cause)).toBe(true)
    })
    .exhaustive()
}

interface RecordedHttpRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

const sampleRunRow = {
  runId: "run-wf6-hook-1",
  executionId: "exec-wf6-hook-1",
  level: "slice",
  planSha: "b".repeat(64),
  baseSha: "a".repeat(40),
  state: "running",
  updatedMs: 1_700_000_000_000,
  seqKey: "00000000000000000001",
}

const sampleUnitRow = {
  unitKey: "run-wf6-hook-1/unit-alpha",
  runId: "run-wf6-hook-1",
  unitId: "unit-alpha",
  kind: "package",
  waveIndex: 0,
  status: "pending",
  ownedRelPaths: ["apps/harness-cli/src"],
  updatedMs: 1_700_000_000_000,
  seqKey: "00000000000000000002",
}

const setupDoneProjectorTestHarness = async () => {
  const repoRoot = makeTempWorkflowRepo("harness-wf6-done-order-")
  const configDir = join(repoRoot, "libs", "harness", "graph")
  const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
  mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
  mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
  const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
  writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
  const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
  const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

  const requests: Array<RecordedHttpRequest> = []
  let mutateMode: "ok" | "error500" | "conflict412" = "ok"
  const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
  const server = createServer((req, res) => {
    const url = req.url ?? ""
    const method = req.method ?? "GET"
    let body = ""
    req.on("data", (chunk) => {
      body += String(chunk)
    })
    req.on("end", () => {
      requests.push({ method, url, body })
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }))
        return
      }
      if (method === "PUT" && url.includes("/graphs/harness/") && url.includes("/blob")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "written",
            sha256: "abc",
            size: 10,
            etag: '"e1"',
            serverRef: "srv-1",
          }),
        )
        return
      }
      if (method === "HEAD" && url.includes("/graphs/harness/") && url.includes("/blob")) {
        res.writeHead(200, {
          "Content-Length": "10",
          ETag: '"e1"',
          "Content-Type": "application/octet-stream",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end()
        return
      }
      if (url.includes("/graphs/harness/load")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "loaded",
            commit_id: "c-load-1",
            nodes_loaded: 1,
            edges_loaded: 0,
          }),
        )
        return
      }
      if (url.includes("/graphs/harness-workflows/queries/wf_list_runs")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [sampleRunRow], graphCommitId: "wf-c1" }))
        return
      }
      if (url.includes("/graphs/harness-workflows/queries/wf_get_run")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [sampleRunRow], graphCommitId: "wf-c1" }))
        return
      }
      if (url.includes("/graphs/harness-workflows/queries/wf_units_for_run")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [sampleUnitRow], graphCommitId: "wf-c1" }))
        return
      }
      if (url.includes("/graphs/harness-workflows/queries/wf_attempts_for_run")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [], graphCommitId: "wf-c1" }))
        return
      }
      if (url === "/graphs/harness/branches") {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            branches: [taskBranches.mainBranch, taskBranches.implBranch],
          }),
        )
        return
      }
      if (url === "/graphs/harness/query") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [], graphCommitId: "h-snap-1" }))
        return
      }
      if (url.startsWith("/graphs/harness/mutate")) {
        if (mutateMode === "error500") {
          res.writeHead(500, headers)
          res.end(JSON.stringify({ error: "projector-500" }))
          return
        }
        if (mutateMode === "conflict412") {
          res.writeHead(412, headers)
          res.end(JSON.stringify({ error: "precondition failed" }))
          return
        }
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            affectedNodes: 2,
            affectedEdges: 1,
            commit: { graphCommitId: "h-proj-1" },
          }),
        )
        return
      }
      if (url.includes("/graphs/harness/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            from_commit_id: "c0",
            to_commit_id: "h-proj-1",
            changes: [],
            netNodeCount: 0,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/graphs/harness/branches/merge")) {
        const isDryRun = body.includes('"dry_run":true')
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "already_up_to_date",
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
            ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
            commit: null,
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end(JSON.stringify({ error: `unexpected: ${method} ${url}` }))
    })
  })
  await new Promise<void>((resPromise, rejPromise) => {
    server.once("error", rejPromise)
    server.listen(0, "127.0.0.1", () => resPromise())
  })
  const port = (server.address() as AddressInfo).port
  writeFileSync(
    join(clusterDir, "server.json"),
    JSON.stringify({
      pid: process.pid,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      canonicalRepoRoot: canonicalRoot,
      updatedAt: null,
    }),
    "utf8",
  )
  mkdirSync(join(repoRoot, ".harness"), { recursive: true })
  writeFileSync(join(repoRoot, ".harness", "spans.jsonl"), '{"span":"wf6-done-test"}\n', "utf8")
  const g = buildHarnessGraph({
    tests: [
      {
        testId: "tc-wf6-done-1",
        testFile: "test/demo.test.ts",
        testName: "demo",
        line: 1,
        isPropertyTest: false,
      },
    ],
  })
  saveGraphSnapshot(g, join(repoRoot, ".harness", "graph-snapshot.json"), nodeSyncHostIo)
  return {
    repoRoot,
    requests,
    setMutateMode: (mode: "ok" | "error500" | "conflict412") => {
      mutateMode = mode
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

describe("WF-6 CLI schema drift, done pre-merge projection, and post-rebuild restore hooks", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("classifies pre-WF-6 -> WF-6 schema.pg additive edges as LiveClusterApply and existing edge @key edits as RequiresCleanRebuild", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf6-drift-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })

    const realSchemaPath = join(process.cwd(), "libs", "harness", "graph", "schema.pg")
    const fullWf6Schema = existsSync(realSchemaPath)
      ? readFileSync(realSchemaPath, "utf8")
      : [
          readFileSync(join(configDir, "schema.pg"), "utf8"),
          "node WorkflowRun { runId: String @key }",
          "node WorkUnit { unitKey: String @key }",
          "node UnitAttempt { attemptKey: String @key }",
          "edge PlaysRunUnitRole: WorkflowRun -> WorkUnit @card(0..) { @key(@src, @dst, role) role: String }",
          "edge PlaysUnitAttemptRole: WorkUnit -> UnitAttempt @card(0..) { @key(@src, @dst, role) role: String }",
          "edge PlaysUnitStubRole: WorkUnit -> EffectFn @card(0..) { @key(@src, @dst, role) role: String }",
          "edge PlaysUnitEarsRole: WorkUnit -> EarsSpec @card(0..) { @key(@src, @dst, role) role: String }",
          "edge PlaysUnitTraceabilityRole: WorkUnit -> TraceabilityTuple @card(0..) { @key(@src, @dst, role) role: String }",
          "edge PlaysAttemptTestRole: UnitAttempt -> VitestCase @card(0..) { @key(@src, @dst, role) role: String }",
          "",
        ].join("\n")

    const wf6Edges = [
      "PlaysRunUnitRole",
      "PlaysUnitAttemptRole",
      "PlaysUnitStubRole",
      "PlaysUnitEarsRole",
      "PlaysUnitTraceabilityRole",
      "PlaysAttemptTestRole",
    ]
    const firstWf6Idx = fullWf6Schema.indexOf("node WorkflowRun")
    const preWf6Schema =
      firstWf6Idx >= 0
        ? fullWf6Schema.slice(0, firstWf6Idx)
        : readFileSync(join(configDir, "schema.pg"), "utf8")

    const preKeys = extractSchemaEdgeKeys(preWf6Schema)
    const wf6Keys = extractSchemaEdgeKeys(fullWf6Schema)
    expect(hasBreakingSchemaEdgeKeyChange(preKeys, wf6Keys)).toBe(false)
    for (const edgeName of wf6Edges) {
      expect(wf6Keys[edgeName]).toBe("@key(@src, @dst, role)")
      expect(preKeys[edgeName]).toBeUndefined()
    }

    writeFileSync(join(configDir, "schema.pg"), preWf6Schema, "utf8")
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

    writeFileSync(join(configDir, "schema.pg"), fullWf6Schema, "utf8")
    const additiveDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(additiveDrift.action._tag).toBe("LiveClusterApply")
    writeClusterDriftReceipts(clusterDir, additiveDrift.expectedStamp, configDir)

    const modifiedKeySchema = fullWf6Schema.replace("@key(@src, @dst, role)", "@key(@src, @dst)")
    expect(hasBreakingSchemaEdgeKeyChange(wf6Keys, extractSchemaEdgeKeys(modifiedKeySchema))).toBe(
      true,
    )

    // Simulate legacy pre-WF-6 .config-digests.json (lacking "schema.pg@edgeKeys", with ".config-stamp" present)
    const legacyDigestsPath = join(clusterDir, ".config-digests.json")
    const legacyDigests = JSON.parse(readFileSync(legacyDigestsPath, "utf8")) as Record<
      string,
      unknown
    >
    delete legacyDigests["schema.pg@edgeKeys"]
    delete legacyDigests["workflows.schema.pg@edgeKeys"]
    writeFileSync(join(configDir, "schema.pg"), preWf6Schema, "utf8")
    const preStampDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeFileSync(join(clusterDir, ".config-stamp"), preStampDrift.expectedStamp, "utf8")
    legacyDigests["schema.pg"] = preStampDrift.digests["schema.pg"]
    legacyDigests["schema.pg@keys"] = preStampDrift.digests["schema.pg@keys"]
    writeFileSync(legacyDigestsPath, JSON.stringify(legacyDigests, null, 2), "utf8")

    writeFileSync(join(configDir, "schema.pg"), fullWf6Schema, "utf8")
    const legacyUpgradeDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(legacyUpgradeDrift.action._tag).toBe("LiveClusterApply")

    writeFileSync(join(configDir, "schema.pg"), modifiedKeySchema, "utf8")
    const breakingDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(breakingDrift.action._tag).toBe("RequiresCleanRebuild")

    expect(
      hasBreakingSchemaEdgeKeyChange(
        { PlaysCallerRole: "@key(@src, @dst, role)", PlaysRunUnitRole: "@key(@src, @dst, role)" },
        { PlaysCallerRole: "@key(@src, @dst, role)" },
      ),
    ).toBe(true)
  })

  it("syncOmnigraphOnDone re-projects strictly after /load + span blob upload and before branches/diff + merge, keeping harness-workflows read-only", async () => {
    const harness = await setupDoneProjectorTestHarness()
    try {
      const doneRes = await Effect.runPromise(
        syncOmnigraphOnDone(harness.repoRoot, { repoRoot: harness.repoRoot }, false, "block"),
      )
      expect(doneRes).toBeUndefined()

      const idxLoad = harness.requests.findIndex((r) => r.url.includes("/graphs/harness/load"))
      const idxBlobPut = harness.requests.findIndex(
        (r) => r.method === "PUT" && r.url.includes("/graphs/harness/") && r.url.includes("/blob"),
      )
      const idxBlobHead = harness.requests.findIndex(
        (r) => r.method === "HEAD" && r.url.includes("/graphs/harness/") && r.url.includes("/blob"),
      )
      const idxProjectMutate = harness.requests.findIndex((r) =>
        r.url.startsWith("/graphs/harness/mutate"),
      )
      const idxDiff = harness.requests.findIndex((r) =>
        r.url.includes("/graphs/harness/branches/diff"),
      )
      const idxMerge = harness.requests.findIndex((r) =>
        r.url.includes("/graphs/harness/branches/merge"),
      )

      expect(idxLoad).toBeGreaterThanOrEqual(0)
      expect(idxBlobPut).toBeGreaterThan(idxLoad)
      expect(idxBlobHead).toBeGreaterThan(idxBlobPut)
      expect(idxProjectMutate).toBeGreaterThan(idxBlobHead)
      expect(idxDiff).toBeGreaterThan(idxProjectMutate)
      expect(idxMerge).toBeGreaterThan(idxDiff)
      expect(harness.requests[idxProjectMutate]?.body).toContain(sampleRunRow.runId)

      const wfRequests = harness.requests.filter((r) => r.url.includes("harness-workflows"))
      expect(wfRequests.length).toBeGreaterThanOrEqual(3)
      for (const req of wfRequests) {
        expect(req.url).toMatch(
          /\/graphs\/harness-workflows\/queries\/wf_(list_runs|get_run|units_for_run|attempts_for_run)/,
        )
      }
    } finally {
      harness.close()
    }
  })

  it("syncOmnigraphOnDone continues to branches/merge when WorkflowProjector fails with HTTP 500 or 412", async () => {
    const harness = await setupDoneProjectorTestHarness()
    try {
      harness.setMutateMode("error500")
      const res500 = await Effect.runPromise(
        syncOmnigraphOnDone(harness.repoRoot, { repoRoot: harness.repoRoot }, false, "block"),
      )
      expect(res500).toBeUndefined()
      expect(harness.requests.some((r) => r.url.startsWith("/graphs/harness/mutate"))).toBe(true)
      expect(harness.requests.some((r) => r.url.includes("/graphs/harness/branches/merge"))).toBe(
        true,
      )

      harness.requests.length = 0
      harness.setMutateMode("conflict412")
      const res412 = await Effect.runPromise(
        syncOmnigraphOnDone(harness.repoRoot, { repoRoot: harness.repoRoot }, false, "block"),
      )
      expect(res412).toBeUndefined()
      expect(harness.requests.some((r) => r.url.startsWith("/graphs/harness/mutate"))).toBe(true)
      expect(harness.requests.some((r) => r.url.includes("/graphs/harness/branches/merge"))).toBe(
        true,
      )
    } finally {
      harness.close()
    }
  }, 15_000)

  it("reprojectWorkflowsBeforeMerge propagates pure fiber interrupts and absorbs Stale/defect failures", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf6-done-interrupt-")
    const started = Deferred.makeUnsafe<void>()

    const interruptProjector = makeStubProjector({
      onProjectAll: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0)
          return yield* Effect.never
        }),
    })

    const interruptExit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* reprojectWorkflowsBeforeMerge({
          repoRoot,
          clusterRepoRoot: repoRoot,
          implBranch: "impl/wf6",
          workflowProjector: interruptProjector,
        }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expectPureInterruptExit(interruptExit)

    const defectProjector = makeStubProjector({
      onProjectAll: () => Effect.die(new Error("boom-defect")),
    })
    await expect(
      Effect.runPromise(
        reprojectWorkflowsBeforeMerge({
          repoRoot,
          clusterRepoRoot: repoRoot,
          implBranch: "impl/wf6",
          workflowProjector: defectProjector,
        }),
      ),
    ).resolves.toBeUndefined()

    const staleProjector = makeStubProjector({
      onProjectAll: () =>
        Effect.succeed(
          WorkflowProjectAllOutcome.cases.Stale.make({
            branch: OmnigraphBranchName.make("impl/wf6"),
            projectionStatus: "stale",
            outcomes: [],
            reason: toBoundedReason("stale-test"),
          }),
        ),
    })
    await expect(
      Effect.runPromise(
        reprojectWorkflowsBeforeMerge({
          repoRoot,
          clusterRepoRoot: repoRoot,
          implBranch: "impl/wf6",
          workflowProjector: staleProjector,
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("afterRebuildWorkflowBackup triggers post-rebuild WorkflowProjector non-fatally and propagates pure interrupts", async () => {
    const dir = makeTempWorkflowRepo("harness-wf6-after-rebuild-")
    const backupDir = BackupDirPath.make(join(dir, "backups"))
    mkdirSync(backupDir, { recursive: true })
    const rowJson = JSON.stringify({
      type: "WfMessage",
      id: "m-rebuild-1",
      data: { messageKey: "m-rebuild-1", seqKey: "00000000000000000001" },
    })
    const sha = createHash("sha256").update(`${rowJson}\n`, "utf8").digest("hex")
    const backupFile = WorkflowBackupFilePath.make(join(backupDir, "backup.ndjson"))
    writeFileSync(backupFile, `${rowJson}\n`, "utf8")

    const server = createServer((req, res) => {
      const url = req.url ?? ""
      const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "loaded", commit_id: "c1", totalEntities: 1 }))
        return
      }
      if (url.includes("/queries/wf_count_all")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c1" }))
        return
      }
      if (url.includes("/queries/wf_count_replies")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c1" }))
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resPromise) => server.listen(0, "127.0.0.1", () => resPromise()))
    const port = (server.address() as AddressInfo).port
    const wfClient = new OmnigraphClient({
      baseUrl: `http://127.0.0.1:${port}`,
      graphId: "harness-workflows",
    })
    const absRepoRoot = AbsoluteRepoRoot.make(dir)
    const backupLayer = makeWorkflowGraphBackupLayer({ repoRoot: absRepoRoot, client: wfClient })

    try {
      const calls: Array<WorkflowProjectAllInput> = []
      const failingProjector = Layer.succeed(
        WorkflowProjector,
        makeStubProjector({
          onProjectAll: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }).pipe(Effect.andThen(Effect.die(new Error("harness unreachable")))),
        }),
      )

      const summary = await Effect.runPromise(
        afterRebuildWorkflowBackup({
          backupFile,
          mode: "merge",
          expectedSha256: BackupFileHash.make(sha),
        }).pipe(Effect.provide(Layer.merge(backupLayer, failingProjector))),
      )
      expect(summary.restoredEntityCount).toBe(WorkflowBackupCount.make(1))
      expect(calls).toHaveLength(1)
      expect(calls[0]?.trigger).toBe("post-rebuild")
      expect(calls[0]?.targetBranch).toEqual(
        WorkflowProjectionTargetBranch.cases.Explicit.make({
          branch: OmnigraphBranchName.make("main"),
        }),
      )

      const started = Deferred.makeUnsafe<void>()
      const interruptingProjector = Layer.succeed(
        WorkflowProjector,
        makeStubProjector({
          onProjectAll: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0)
              return yield* Effect.never
            }),
        }),
      )
      const interruptExit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* afterRebuildWorkflowBackup({
            backupFile,
            mode: "merge",
            expectedSha256: BackupFileHash.make(sha),
          }).pipe(Effect.provide(Layer.merge(backupLayer, interruptingProjector)), Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      )
      expectPureInterruptExit(interruptExit)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("runWorkflowRestoreAfterRebuild re-projects restored workflow runs into harness and succeeds when harness is absent", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf6-restore-e2e-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })

    const backupDir = resolveWorkflowBackupDir(repoRoot)
    mkdirSync(backupDir, { recursive: true })
    const rowJson = JSON.stringify({
      type: "WfMessage",
      id: "m-restore-1",
      data: { messageKey: "m-restore-1", seqKey: "00000000000000000001" },
    })
    const content = `${rowJson}\n`
    const sha256 = BackupFileHash.make(createHash("sha256").update(content, "utf8").digest("hex"))
    const backupFile = WorkflowBackupFilePath.make(join(backupDir, "wf-restore.ndjson"))
    writeFileSync(backupFile, content, "utf8")

    let harnessAvailable = true
    const requests: Array<RecordedHttpRequest> = []
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      const method = req.method ?? "GET"
      let body = ""
      req.on("data", (chunk) => {
        body += String(chunk)
      })
      req.on("end", () => {
        requests.push({ method, url, body })
        if (url === "/healthz") {
          res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
          res.end()
          return
        }
        if (url.includes("/graphs/harness-workflows/load")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ outcome: "loaded", commit_id: "wf-c1", totalEntities: 1 }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_count_all")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "wf-c1" }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_count_replies")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "wf-c1" }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_list_runs")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [sampleRunRow], graphCommitId: "wf-c1" }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_get_run")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [sampleRunRow], graphCommitId: "wf-c1" }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_units_for_run")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [sampleUnitRow], graphCommitId: "wf-c1" }))
          return
        }
        if (url.includes("/graphs/harness-workflows/queries/wf_attempts_for_run")) {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [], graphCommitId: "wf-c1" }))
          return
        }
        if (!harnessAvailable) {
          res.writeHead(404, headers)
          res.end(JSON.stringify({ error: "harness graph absent" }))
          return
        }
        if (url === "/graphs/harness/branches") {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ outcome: "ok", branches: ["main"] }))
          return
        }
        if (url === "/graphs/harness/query") {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ rows: [], graphCommitId: "h-c1" }))
          return
        }
        if (url.startsWith("/graphs/harness/mutate")) {
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              affectedNodes: 2,
              affectedEdges: 1,
              commit: { graphCommitId: "h-c2" },
            }),
          )
          return
        }
        res.writeHead(404, headers)
        res.end()
      })
    })
    await new Promise<void>((resPromise) => server.listen(0, "127.0.0.1", () => resPromise()))
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`
    const backup = {
      _tag: "BackedUp" as const,
      backupFile,
      timestampMs: WorkflowBackupTimestampMs.make(1000),
      sha256,
      entityCount: WorkflowBackupCount.make(1),
    }

    try {
      const okWithHarness = await Effect.runPromise(
        runWorkflowRestoreAfterRebuild({
          clusterRepoRoot: repoRoot,
          clusterRootDir: clusterDir,
          baseUrl,
          backup,
        }),
      )
      expect(okWithHarness).toBe(true)
      const mutateReq = requests.find((r) => r.url.startsWith("/graphs/harness/mutate"))
      expect(mutateReq).toBeDefined()
      expect(mutateReq?.body).toContain(sampleRunRow.runId)

      requests.length = 0
      harnessAvailable = false
      const okWithoutHarness = await Effect.runPromise(
        runWorkflowRestoreAfterRebuild({
          clusterRepoRoot: repoRoot,
          clusterRootDir: clusterDir,
          baseUrl,
          backup,
        }),
      )
      expect(okWithoutHarness).toBe(true)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
