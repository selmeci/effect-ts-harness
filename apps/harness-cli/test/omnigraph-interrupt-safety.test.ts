import { createServer, type ServerResponse } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Deferred, Effect, type Exit, Fiber, Schema } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isPureInterruptCause } from "@harness/contract"
import {
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  CLUSTER_SCHEMA_EPOCH,
  evaluateClusterConfigDrift,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import {
  cleanupStalePlanSnapshotAfterDone,
  loadPlanEffectFnQualnames,
} from "../src/commands/omnigraph-safety-helpers.js"

let injectSnapshotInterrupt = false

vi.mock("@harness/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@harness/graph")>()
  return {
    ...actual,
    loadGraphSnapshotEffect: (
      snapshotPath: string,
      hostIo: Parameters<typeof actual.loadGraphSnapshotEffect>[1],
    ) =>
      injectSnapshotInterrupt
        ? Effect.interrupt
        : actual.loadGraphSnapshotEffect(snapshotPath, hostIo),
  }
})

const tempDirs: Array<string> = []

const makeTempRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "harness", "graph", "queries"), { recursive: true })
  mkdirSync(join(dir, ".harness"), { recursive: true })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "schema.pg"), "node EffectFn {}\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "queries", "harness.gq"),
    "query q() { match (n:EffectFn) return n }\n",
    "utf8",
  )
  return dir
}

const expectPureInterruptExit = <A, E>(exit: Exit.Exit<A, E>): void => {
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      expect(isPureInterruptCause(cause)).toBe(true)
      expect(Cause.hasFails(cause)).toBe(false)
      expect(Cause.hasDies(cause)).toBe(false)
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable("Expected pure interrupt failure exit")
    })
    .exhaustive()
}

describe("F-25: CLI omnigraph safety helpers preserve pure fiber interruption", () => {
  afterEach(() => {
    injectSnapshotInterrupt = false
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("F-7.1: loadPlanEffectFnQualnames returns Corrupt on corrupt snapshot and re-fails on pure interrupt", async () => {
    const repoRoot = makeTempRepo("harness-f25-plan-qualnames-")
    const snapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
    writeFileSync(snapshotPath, "{corrupt-snapshot-json", "utf8")

    injectSnapshotInterrupt = false
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const corruptRes = await Effect.runPromise(
      loadPlanEffectFnQualnames(snapshotPath, nodeSyncHostIo),
    )
    match(corruptRes)
      .with({ _tag: "Corrupt" }, ({ reason }) => {
        expect(reason).toContain("Failed to decode plan snapshot")
      })
      .with({ _tag: "Ok" }, () => {
        expect.unreachable("Expected Corrupt result for corrupt plan snapshot")
      })
      .exhaustive()
    expect(errSpy).toHaveBeenCalled()

    injectSnapshotInterrupt = true
    const interruptExit = await Effect.runPromiseExit(
      loadPlanEffectFnQualnames(snapshotPath, nodeSyncHostIo),
    )
    expectPureInterruptExit(interruptExit)
  })

  it("F-7.1: syncOmnigraphOnDone fails closed on corrupt plan-graph-snapshot.json before inspecting deleted EffectFns", async () => {
    const repoRoot = makeTempRepo("harness-f71-done-corrupt-plan-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH, "utf8")
    writeFileSync(
      join(repoRoot, ".harness", "plan-graph-snapshot.json"),
      "{corrupt-plan-snapshot",
      "utf8",
    )

    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    let dryRunMergeCalled = false

    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            serverRef: "srv-1",
            from_commit_id: "c1",
            to_commit_id: "c2",
            changes: [
              {
                id: "libs/sample/domain/src/index.ts#deletedFn",
                kind: "node",
                op: "delete",
                type: { id: "t1", name: "EffectFn" },
                before: { properties: { isStub: false, spanName: "Sample.deletedFn" } },
                after: null,
              },
            ],
            netNodeCount: -1,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/branches/merge")) {
        dryRunMergeCalled = true
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: [taskBranches.mainBranch, taskBranches.planBranch, taskBranches.implBranch],
          serverRef: "srv-1",
        }),
      )
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const addr = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address())
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    try {
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      const doneRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(errSpy).toHaveBeenCalled()
      expect(doneRes).toBeDefined()
      expect(doneRes?.exitCode).toBe(1)
      expect(doneRes?.stderr).toContain("[GATE FAILURE] done:omnigraph-plan-snapshot")
      expect(dryRunMergeCalled).toBe(false)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-8.1: cleanupStalePlanSnapshotAfterDone does not treat EACCES containing 'ENOENT' as silent ENOENT success", () => {
    const repoRoot = makeTempRepo("harness-f81-enoent-code-")
    const planSnapPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
    writeFileSync(planSnapPath, "{}", "utf8")

    const makeUnlinkThrowIo = (err: unknown): SyncHostIo => ({
      ...nodeSyncHostIo,
      isSymbolicLinkSync: () => false,
      unlinkSync: () => {
        throw err
      },
    })

    // 1. Structured EACCES error whose path/message contains "ENOENT" must fail (never return undefined)
    const eaccesWithEnoentPath = Object.assign(
      new Error("EACCES: permission denied, unlink '/tmp/ENOENT/plan-graph-snapshot.json'"),
      { code: "EACCES" },
    )
    const directRes = cleanupStalePlanSnapshotAfterDone(
      repoRoot,
      makeUnlinkThrowIo(eaccesWithEnoentPath),
    )
    expect(directRes).toBeDefined()
    expect(directRes).toContain("EACCES")

    // 2. Nested cause (depth 1 and depth 2) with structured code: "EACCES" and "ENOENT" in message must fail
    const wrappedEacces = new Error("outer wrapper ENOENT", {
      cause: Object.assign(new Error("EACCES: ENOENT"), { code: "EACCES" }),
    })
    const nestedRes = cleanupStalePlanSnapshotAfterDone(repoRoot, makeUnlinkThrowIo(wrappedEacces))
    expect(nestedRes).toBeDefined()
    expect(nestedRes).toContain("EACCES")

    const doubleWrappedEacces = new Error("ENOENT: outer wrapper", {
      cause: new Error("ENOENT: middle wrapper", {
        cause: Object.assign(new Error("EACCES: inner permission denied"), { code: "EACCES" }),
      }),
    })
    const doubleNestedRes = cleanupStalePlanSnapshotAfterDone(
      repoRoot,
      makeUnlinkThrowIo(doubleWrappedEacces),
    )
    expect(doubleNestedRes).toBe("ENOENT: middle wrapper")

    // 3. Uncoded message containing "ENOENT" in the middle must fail (requires anchored /^ENOENT(?::|\s|$)/)
    const uncodedEacces = new Error("EACCES: cannot unlink /tmp/ENOENT/file")
    const uncodedRes = cleanupStalePlanSnapshotAfterDone(repoRoot, makeUnlinkThrowIo(uncodedEacces))
    expect(uncodedRes).toBeDefined()
    expect(uncodedRes).toContain("EACCES")

    // 4. Real ENOENT (structured code or anchored ENOENT message) cleanly returns undefined
    const realEnoent = Object.assign(new Error("no such file"), { code: "ENOENT" })
    expect(
      cleanupStalePlanSnapshotAfterDone(repoRoot, makeUnlinkThrowIo(realEnoent)),
    ).toBeUndefined()
    expect(
      cleanupStalePlanSnapshotAfterDone(
        repoRoot,
        makeUnlinkThrowIo(new Error("ENOENT: no such file or directory")),
      ),
    ).toBeUndefined()
  })

  it("syncOmnigraphOnDone re-fails on pure interrupt during snapshot load and branch merge instead of returning CliResult", async () => {
    const repoRoot = makeTempRepo("harness-f25-done-sync-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH, "utf8")

    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    const pendingMergeResponses: Array<ServerResponse> = []
    const mergeStarted = Deferred.makeUnsafe<void>()

    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            serverRef: "srv-1",
            from_commit_id: "c1",
            to_commit_id: "c2",
            changes: [],
            netNodeCount: 0,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (chunk) => {
          body += String(chunk)
        })
        req.on("end", () => {
          const isDryRun = body.includes('"dry_run":true')
          if (isDryRun) {
            res.writeHead(200, headers)
            res.end(
              JSON.stringify({
                outcome: "already_up_to_date",
                source: taskBranches.implBranch,
                target: taskBranches.mainBranch,
                dry_run: true,
                commit: null,
                serverRef: "srv-1",
              }),
            )
            return
          }
          // Hold real merge response open so fiber interruption hits mergeOmnigraphBranch mid-flight.
          pendingMergeResponses.push(res)
          Deferred.doneUnsafe(mergeStarted, Effect.void)
        })
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: [taskBranches.mainBranch, taskBranches.planBranch, taskBranches.implBranch],
          serverRef: "srv-1",
        }),
      )
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const addr = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address())

    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    try {
      // 1. Interrupt during loadGraphSnapshotEffect on .harness/graph-snapshot.json
      const snapshotPath = join(repoRoot, ".harness", "graph-snapshot.json")
      writeFileSync(snapshotPath, "{}", "utf8")
      injectSnapshotInterrupt = true
      const snapInterruptExit = await Effect.runPromiseExit(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expectPureInterruptExit(snapInterruptExit)

      // 2. Interrupt mid-flight during mergeOmnigraphBranch
      injectSnapshotInterrupt = false
      rmSync(snapshotPath, { force: true })
      const mergeInterruptExit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block").pipe(
            Effect.forkChild,
          )
          yield* Deferred.await(mergeStarted)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      )
      expectPureInterruptExit(mergeInterruptExit)
    } finally {
      for (const pending of pendingMergeResponses) {
        pending.destroy()
      }
      server.closeAllConnections()
      server.close()
    }
  })
})
