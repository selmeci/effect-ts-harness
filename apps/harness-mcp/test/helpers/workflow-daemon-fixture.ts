import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import { expect } from "vitest"
import {
  AbsoluteRepoRoot,
  type CompiledPlan,
  type CompleteSharedStepInput,
  type CompleteUnitInput,
  EarsRequirementKey,
  GitCommitSha,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanSha256,
  ReviewDepth,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  SHARED_STEP_UNIT_ID,
  StubSymbolKey,
  UnitOutcome,
  WaveIndex,
  WorkUnitId,
  WorkflowRunId,
} from "@harness/contract"
import { OmnigraphClient, makeWorkflowOmnigraphClient } from "@harness/graph"
import { UnitVerifier, WorkflowReviewRouter, WorkflowWorktreePort } from "@harness/service"

export const graphConfigDir = resolve(import.meta.dirname, "../../../../libs/harness/graph")
export const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
export const omnigraphServerBin = join(
  process.env.HOME ?? "/root",
  ".local",
  "bin",
  "omnigraph-server",
)

export const allocateLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.on("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        server.close(() => rejectPort(new Error("failed to allocate ephemeral port")))
        return
      }
      const { port } = addr
      server.close((err) => {
        if (err) {
          rejectPort(err)
          return
        }
        resolvePort(port)
      })
    })
  })

export const unlockClusterIfLocked = (clusterDir: string, applyStdout: string): void => {
  const lockIds = new Set<string>()
  for (const m of applyStdout.matchAll(/Admission lock:\s*([A-Z0-9._-]+)/gi)) {
    if (m[1]) lockIds.add(m[1])
  }
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (existsSync(lockJsonPath)) {
    const parsed = Schema.decodeSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(readFileSync(lockJsonPath, "utf8"))
    for (const key of ["lock_id", "id", "lockId"]) {
      const val = parsed[key]
      if (typeof val === "string" && val.length > 0) lockIds.add(val)
    }
  }
  for (const lockId of lockIds) {
    execFileSync(
      omnigraphBin,
      ["cluster", "force-unlock", lockId, "--target", `file://${clusterDir}`],
      { encoding: "utf8" },
    )
  }
}

export const waitForServerReady = async (baseUrl: string, proc: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`omnigraph-server exited early with code ${proc.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/readyz`)
      if (res.ok) {
        const body = (await res.json()) as { readonly ready?: boolean }
        if (body.ready === true) return
      }
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for omnigraph-server readiness at ${baseUrl}`)
}

export const stopChildProcess = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL")
    }, 3_000)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolveStop()
    })
    proc.kill("SIGTERM")
  })
}

export const initTestGitRepo = (
  baseDir: string,
  name: string,
): {
  readonly canonicalDir: string
  readonly linkedDir: string
  readonly baseSha: GitCommitSha
} => {
  const canonicalDir = join(baseDir, name)
  const linkedDir = join(baseDir, `${name}-wt`)
  mkdirSync(canonicalDir, { recursive: true })
  execFileSync("git", ["init"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "wf3@example.com"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "WF3 Test"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  writeFileSync(join(canonicalDir, "README.md"), "# WF3\n", "utf8")
  execFileSync("git", ["add", "README.md"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: canonicalDir, stdio: "ignore" })
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: canonicalDir,
    encoding: "utf8",
  }).trim()
  execFileSync("git", ["worktree", "add", "-b", `slice/${name}-wt`, linkedDir, "HEAD"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  return {
    canonicalDir,
    linkedDir,
    baseSha: GitCommitSha.make(headSha),
  }
}

export const reviewStubLayer: Layer.Layer<WorkflowReviewRouter> = Layer.succeed(
  WorkflowReviewRouter,
  {
    routeReview: () =>
      Effect.succeed<ReviewRoutingPlan>({
        _tag: "SkipReviewPlan",
        depth: ReviewDepth.make("skip"),
        source: ReviewRoutingSource.make("deterministic"),
        reason: ReviewRoutingReason.make("WF3 daemon integration test"),
        selections: [],
      }),
  },
)

export const makeNoopWorktreeLayer = (
  canonicalRoot: AbsoluteRepoRoot,
): Layer.Layer<WorkflowWorktreePort> =>
  Layer.succeed(WorkflowWorktreePort, {
    provisionWorktrees: (plan) =>
      Effect.succeed({
        runId: plan.runId,
        canonicalRepoRoot: canonicalRoot,
        entries: plan.units.map((u) => ({
          unitId: u.unitId,
          cwd: canonicalRoot,
          worktreeKind: "canonical" as const,
        })),
      }),
    removeWorktreeCheckouts: () => Effect.void,
    mergeSliceWave: (input) =>
      Effect.succeed({
        _tag: "Merged" as const,
        mergedBranches: input.branches,
      }),
  })

export const makeCompletedVerifierLayer = (
  onCompleteUnit?: (input: CompleteUnitInput) => void,
  onCompleteShared?: (input: CompleteSharedStepInput) => void,
): Layer.Layer<UnitVerifier> =>
  Layer.succeed(UnitVerifier, {
    completeUnit: (input) =>
      Effect.sync(() => {
        onCompleteUnit?.(input)
        return UnitOutcome.cases.Completed.make({
          unitId: input.unit.unitId,
          attempt: input.attempt,
          changedPaths: [...input.unit.ownedRelPaths],
          packageStampHash: PackageStampHash.make("a".repeat(64)),
        })
      }),
    completeSharedStep: (input) =>
      Effect.sync(() => {
        onCompleteShared?.(input)
        return UnitOutcome.cases.Completed.make({
          unitId: SHARED_STEP_UNIT_ID,
          attempt: input.attempt,
          changedPaths: [...input.sharedStepPaths],
          packageStampHash: PackageStampHash.make("b".repeat(64)),
        })
      }),
  })

export const makeSingleUnitManualPlan = (
  runId: string,
  baseSha: GitCommitSha,
  options?: {
    readonly unitId?: string | undefined
    readonly planSha?: string | undefined
    readonly sharedStepPaths?: ReadonlyArray<string> | undefined
  },
): CompiledPlan => ({
  runId: WorkflowRunId.make(runId),
  level: "slice",
  planSha: PlanSha256.make(options?.planSha ?? "c".repeat(64)),
  baseSha,
  mode: { _tag: "Manual" },
  units: [
    {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make(options?.unitId ?? "unit-alpha"),
      projectName: NxProjectName.make("@harness/alpha"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
      stubKeys: [StubSymbolKey.make("Alpha.run")],
      earsKeys: [EarsRequirementKey.make("REQ-1.1")],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    },
  ],
  sharedStepPaths: (options?.sharedStepPaths ?? []).map((p) => OwnedRelPath.make(p)),
})

export const makeMockLeaseStoreClient = (overrides?: {
  readonly getLeaseRow?: () => Record<string, unknown> | null
  readonly onRunRow?: (runId: string) => Record<string, unknown> | null
  readonly forceCorruptJournal?: boolean
}) => {
  let leaseRow: Record<string, unknown> | null = null
  let commitSeq = 1
  const baseClient = new OmnigraphClient({
    baseUrl: "http://127.0.0.1:1",
    graphId: "harness-workflows",
  })

  const invokeMock = (
    queryName: string,
    input?: { readonly params?: Readonly<Record<string, unknown>> | undefined },
  ): Promise<unknown> => {
    const params = input?.params ?? {}
    return Promise.resolve(
      match(queryName)
        .with("wf_get_writer_lease", () => {
          const effectiveRow =
            overrides?.getLeaseRow !== undefined ? overrides.getLeaseRow() : leaseRow
          return {
            queryName,
            rowCount: effectiveRow === null ? 0 : 1,
            rows: effectiveRow === null ? [] : [{ ...effectiveRow }],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }
        })
        .with("wf_insert_writer_lease", () => {
          commitSeq += 1
          leaseRow = {
            name: typeof params.name === "string" ? params.name : "engine",
            owner: typeof params.owner === "string" ? params.owner : "",
            leaseEpoch: Number(params.leaseEpoch ?? 1),
            heartbeatMs: Number(params.heartbeatMs ?? Date.now()),
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_cas_writer_lease", () => {
          commitSeq += 1
          leaseRow = {
            name: "engine",
            owner: typeof params.owner === "string" ? params.owner : "",
            leaseEpoch: Number(params.nextEpoch ?? 2),
            heartbeatMs: Number(params.heartbeatMs ?? Date.now()),
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_refresh_writer_lease", () => {
          commitSeq += 1
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_get_run", () => {
          const runIdStr = typeof params.runId === "string" ? params.runId : ""
          const row = overrides?.onRunRow !== undefined ? overrides.onRunRow(runIdStr) : null
          return {
            queryName,
            rowCount: row === null ? 0 : 1,
            rows: row === null ? [] : [row],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }
        })
        .with("wf_all_entities", () => ({
          queryName,
          rowCount: overrides?.forceCorruptJournal ? 1 : 0,
          rows: overrides?.forceCorruptJournal
            ? [
                {
                  messageKey: "1",
                  seqKey: "0".repeat(20),
                  entityType: "Workflow/HarnessTaskWorkflow",
                },
              ]
            : [],
          graphCommitId: `commit-${commitSeq}`,
          target: { branch: "main" },
        }))
        .with(
          "wf_all_replies",
          "wf_dangling_processed_requests",
          "wf_unprocessed_candidate_messages",
          "wf_unprocessed_candidate_messages_for_addresses",
          "wf_orphan_entity_messages",
          "wf_probe_runs",
          "wf_list_runs",
          "wf_units_for_run",
          "wf_attempts_for_run",
          () => ({
            queryName,
            rowCount: 0,
            rows: [],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }),
        )
        .otherwise(() => ({
          queryName,
          rowCount: 0,
          rows: [],
          affectedNodes: 0,
          affectedEdges: 0,
          branch: "main",
          commit: null,
          graphCommitId: `commit-${commitSeq}`,
          target: { branch: "main" },
        })),
    )
  }

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return invokeMock
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export interface WorkflowDaemonServerHarness {
  readonly tempDirs: Array<string>
  readonly cliToken: string
  readonly createClient: () => ReturnType<typeof makeWorkflowOmnigraphClient>
  readonly createWorkRepo: (name: string) => ReturnType<typeof initTestGitRepo>
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
}

export const startWorkflowDaemonServerHarness = (prefix: string): WorkflowDaemonServerHarness => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  const cliToken = "wf3-rpc-daemon-token"

  return {
    tempDirs,
    cliToken,
    createClient: () => makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken }),
    createWorkRepo: (name: string) => {
      const workBase = mkdtempSync(join(tmpdir(), `wf3-${name}-`))
      tempDirs.push(workBase)
      return initTestGitRepo(workBase, name)
    },
    start: async () => {
      expect(existsSync(omnigraphBin)).toBe(true)
      expect(existsSync(omnigraphServerBin)).toBe(true)
      const tempRoot = mkdtempSync(join(tmpdir(), prefix))
      tempDirs.push(tempRoot)
      const clusterDir = join(tempRoot, "cluster")
      mkdirSync(clusterDir, { recursive: true })
      const applyOut = execFileSync(
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
      unlockClusterIfLocked(clusterDir, applyOut)
      const port = await allocateLoopbackPort()
      serverBaseUrl = `http://127.0.0.1:${port}`
      serverProc = spawn(
        omnigraphServerBin,
        ["--cluster", `file://${clusterDir}`, "--bind", `127.0.0.1:${port}`],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OMNIGRAPH_EMBEDDINGS_MOCK: "1",
            OMNIGRAPH_EMBEDDING_API_KEY: "mock",
            OMNIGRAPH_SERVER_BEARER_TOKENS_JSON: JSON.stringify({
              "harness-cli": cliToken,
              "agent-mcp": "wf3-rpc-mcp-token",
            }),
          },
        },
      )
      serverProc.stdout?.resume()
      serverProc.stderr?.resume()
      await waitForServerReady(serverBaseUrl, serverProc)
    },
    stop: async () => {
      await stopChildProcess(serverProc)
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    },
  }
}
