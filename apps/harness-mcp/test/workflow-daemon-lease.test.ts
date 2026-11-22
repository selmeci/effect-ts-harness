import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Scope } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  DaemonSocketPath,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import { OmnigraphClient } from "@harness/graph"
import {
  handshakeWorkflowDaemon,
  queryWorkflowDaemonCommand,
  resolveWorkflowRuntimePaths,
  UnixSocketDaemonLive,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { UnixSocketDaemonPort } from "@harness/service"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import { acquireWorkflowEngineInScope } from "../src/daemon/workflow-engine-daemon-helper.js"

interface InMemoryLeaseRow {
  readonly name: string
  readonly owner: string
  readonly leaseEpoch: number
  readonly heartbeatMs: number
}

interface FakeLeaseHarness {
  readonly client: InstanceType<typeof OmnigraphClient>
  readonly getRefreshCount: () => number
  readonly getRefreshFailureCount: () => number
  readonly setRefreshFailuresRemaining: (count: number) => void
  readonly supersedeLease: (owner: string, leaseEpoch: number) => void
}

const makeInMemoryWorkflowLeaseClient = (): FakeLeaseHarness => {
  let leaseRow: InMemoryLeaseRow | null = null
  let commitSeq = 1
  let refreshCount = 0
  let refreshFailureCount = 0
  let refreshFailuresRemaining = 0

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
        .with("wf_get_writer_lease", () => ({
          queryName,
          rowCount: leaseRow === null ? 0 : 1,
          rows: leaseRow === null ? [] : [{ ...leaseRow }],
          graphCommitId: `commit-${commitSeq}`,
          target: { branch: "main" },
        }))
        .with("wf_insert_writer_lease", () => {
          if (leaseRow !== null) {
            return { queryName, affectedNodes: 0, affectedEdges: 0, branch: "main", commit: null }
          }
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
          if (leaseRow === null || leaseRow.leaseEpoch !== Number(params.expectedEpoch)) {
            return { queryName, affectedNodes: 0, affectedEdges: 0, branch: "main", commit: null }
          }
          commitSeq += 1
          leaseRow = {
            name: leaseRow.name,
            owner: typeof params.owner === "string" ? params.owner : "",
            leaseEpoch: Number(params.nextEpoch ?? leaseRow.leaseEpoch + 1),
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
          if (refreshFailuresRemaining > 0) {
            refreshFailuresRemaining -= 1
            refreshFailureCount += 1
            return Promise.reject(new Error("Simulated transient Omnigraph store outage"))
          }
          refreshCount += 1
          const paramOwner = typeof params.owner === "string" ? params.owner : ""
          if (
            leaseRow === null ||
            leaseRow.leaseEpoch !== Number(params.expectedEpoch) ||
            leaseRow.owner !== paramOwner
          ) {
            return { queryName, affectedNodes: 0, affectedEdges: 0, branch: "main", commit: null }
          }
          commitSeq += 1
          leaseRow = {
            ...leaseRow,
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
        .with(
          "wf_dangling_processed_requests",
          "wf_unprocessed_candidate_messages",
          "wf_unprocessed_candidate_messages_for_addresses",
          "wf_orphan_entity_messages",
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

  const proxiedClient = new Proxy(baseClient, {
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

  return {
    client: proxiedClient,
    getRefreshCount: () => refreshCount,
    getRefreshFailureCount: () => refreshFailureCount,
    setRefreshFailuresRemaining: (count: number) => {
      refreshFailuresRemaining = count
    },
    supersedeLease: (owner: string, leaseEpoch: number) => {
      leaseRow = {
        name: "engine",
        owner,
        leaseEpoch,
        heartbeatMs: Date.now(),
      }
    },
  }
}

const initCanonicalGitRepo = (baseDir: string): string => {
  const repoDir = join(baseDir, "repo")
  mkdirSync(repoDir, { recursive: true })
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "lease@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "Lease Test"], {
    cwd: repoDir,
    stdio: "ignore",
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
    stdio: "ignore",
  })
  return repoDir
}

const findChildPidsHoldingFile = (targetPath: string): ReadonlyArray<number> => {
  const matched: Array<number> = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const commEnd = stat.lastIndexOf(")")
      if (commEnd < 0) continue
      const ppid = Number(
        stat
          .slice(commEnd + 1)
          .trim()
          .split(/\s+/)[1],
      )
      if (ppid !== process.pid) continue
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        try {
          if (readlinkSync(`/proc/${entry}/fd/${fd}`) === targetPath) {
            matched.push(Number(entry))
            break
          }
        } catch {
          // fd closed concurrently
        }
      }
    } catch {
      // process exited concurrently
    }
  }
  return matched
}

const pollUntil = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

describe("harness-mcp workflow daemon writer lease & lifecycle (F-1.1, F-20.4)", () => {
  it("F-1.1: acquires active writer lease, refreshes heartbeat, and shuts down cleanly on WriterLeaseHeldError", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hmcp-wl-hb-"))
    try {
      const repoDir = initCanonicalGitRepo(tmpDir)
      const fakeLease = makeInMemoryWorkflowLeaseClient()
      const leaseLostReasons: Array<string> = []

      const handle = await startHarnessDaemonServer(repoDir, {
        workflowEngine: {
          mode: "required",
          client: fakeLease.client,
          heartbeatIntervalMs: 35,
          onLeaseLost: (reason) => {
            leaseLostReasons.push(reason)
          },
        },
      })

      try {
        expect(handle.writerLeaseEpoch).toBe(1)
        expect(existsSync(handle.socketPath)).toBe(true)

        const validated = await Effect.runPromise(
          validateWorktreeRepoRoot(AbsoluteRepoRoot.make(repoDir)),
        )
        const socketPath = DaemonSocketPath.make(handle.socketPath)

        const handshake = await Effect.runPromise(
          handshakeWorkflowDaemon({
            socketPath,
            request: {
              protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
              repoRoot: validated.worktreeRoot,
              commonGitDir: validated.commonGitDir,
            },
            requiredCapabilities: [
              WorkflowDaemonCapability.make("workflow.handshake"),
              WorkflowDaemonCapability.make("workflow.status"),
            ],
          }).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(handshake.writerLeaseEpoch).toBe(1)

        const statusRes = await Effect.runPromise(
          queryWorkflowDaemonCommand({
            socketPath,
            command: "workflow.status",
          }).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(statusRes).toMatchObject({
          ok: true,
          status: "ready",
          writerLeaseEpoch: 1,
        })

        // Heartbeat fiber invokes refreshWriterLease repeatedly
        await pollUntil(() => fakeLease.getRefreshCount() >= 2)
        expect(existsSync(handle.socketPath)).toBe(true)

        // Supersede lease in Omnigraph -> next heartbeat observes WriterLeaseHeldError and closes daemon
        fakeLease.supersedeLease("rival-daemon#99999", 2)
        await pollUntil(() => leaseLostReasons.length >= 1 && !existsSync(handle.socketPath))
        expect(leaseLostReasons[0]).toContain("rival-daemon")
      } finally {
        await handle.close()
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("F-1.1: shuts down daemon immediately when OS flock child exits unexpectedly (SIGKILL)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hmcp-wl-flock-"))
    try {
      const repoDir = initCanonicalGitRepo(tmpDir)
      const validated = await Effect.runPromise(
        validateWorktreeRepoRoot(AbsoluteRepoRoot.make(repoDir)),
      )
      const lockFilePath = resolveWorkflowRuntimePaths(validated.commonGitDir).lockFilePath
      const fakeLease = makeInMemoryWorkflowLeaseClient()
      const leaseLostReasons: Array<string> = []

      const handle = await startHarnessDaemonServer(repoDir, {
        workflowEngine: {
          mode: "required",
          client: fakeLease.client,
          heartbeatIntervalMs: 60_000,
          onLeaseLost: (reason) => {
            leaseLostReasons.push(reason)
          },
        },
      })

      try {
        expect(existsSync(handle.socketPath)).toBe(true)
        const flockPids = findChildPidsHoldingFile(lockFilePath)
        expect(flockPids.length).toBeGreaterThan(0)

        for (const pid of flockPids) {
          process.kill(pid, "SIGKILL")
        }

        await pollUntil(() => leaseLostReasons.length >= 1 && !existsSync(handle.socketPath))
        expect(leaseLostReasons[0]).toContain("flock")
      } finally {
        await handle.close()
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("F-20.4: mode 'required' rejects with WriterLeaseHeldError when another daemon already holds daemon.sock, and fails closed on non-git", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hmcp-wl-req-"))
    try {
      const repoDir = initCanonicalGitRepo(tmpDir)
      const nonGitDir = join(tmpDir, "non-git")
      mkdirSync(nonGitDir, { recursive: true })
      const fakeLease = makeInMemoryWorkflowLeaseClient()

      let nonGitErr: unknown
      try {
        await startHarnessDaemonServer(nonGitDir, {
          workflowEngine: { mode: "required", client: fakeLease.client },
        })
      } catch (err) {
        nonGitErr = err
      }
      expect(nonGitErr).toBeInstanceOf(WorkflowStoreUnavailableError)
      if (nonGitErr instanceof WorkflowStoreUnavailableError) {
        expect(nonGitErr.operation).toBe(
          WorkflowStoreOperation.make("HarnessDaemon.workflowEngine"),
        )
        expect(nonGitErr.reason).toContain("valid git worktree root")
      }

      const validatedRepo = await Effect.runPromise(
        validateWorktreeRepoRoot(AbsoluteRepoRoot.make(repoDir)),
      )
      const runtimePaths = resolveWorkflowRuntimePaths(validatedRepo.commonGitDir)
      const metaPath = `${runtimePaths.lockFilePath}.meta.json`

      const primary = await startHarnessDaemonServer(repoDir, {
        workflowEngine: { mode: "required", client: fakeLease.client },
      })
      try {
        // 1. .meta.json present -> WriterLeaseHeldError carries exact parsed holderId, leaseEpoch, lockFilePath, holderPid
        let presentMetaErr: unknown
        try {
          await startHarnessDaemonServer(repoDir, {
            workflowEngine: { mode: "required", client: fakeLease.client },
          })
        } catch (err) {
          presentMetaErr = err
        }
        expect(presentMetaErr).toBeInstanceOf(WriterLeaseHeldError)
        if (presentMetaErr instanceof WriterLeaseHeldError) {
          expect(presentMetaErr.holderId).toContain(`harness-mcp-${process.pid}-`)
          expect(presentMetaErr.leaseEpoch).toBe(1)
          expect(presentMetaErr.lockFilePath).toBe(runtimePaths.lockFilePath)
          expect(presentMetaErr.holderPid).toBe(process.pid)
        }

        // 2. .meta.json missing -> fallback WriterLeaseHeldError ("existing-daemon", epoch undefined, lockFilePath, holderPid undefined)
        unlinkSync(metaPath)
        let missingMetaErr: unknown
        try {
          await startHarnessDaemonServer(repoDir, {
            workflowEngine: { mode: "required", client: fakeLease.client },
          })
        } catch (err) {
          missingMetaErr = err
        }
        expect(missingMetaErr).toBeInstanceOf(WriterLeaseHeldError)
        if (missingMetaErr instanceof WriterLeaseHeldError) {
          expect(missingMetaErr.holderId).toBe("existing-daemon")
          expect(missingMetaErr.leaseEpoch).toBeUndefined()
          expect(missingMetaErr.lockFilePath).toBe(runtimePaths.lockFilePath)
          expect(missingMetaErr.holderPid).toBeUndefined()
        }

        // 3. .meta.json symlink -> fallback WriterLeaseHeldError without following symlink
        symlinkSync("/etc/passwd", metaPath)
        let symlinkMetaErr: unknown
        try {
          await startHarnessDaemonServer(repoDir, {
            workflowEngine: { mode: "required", client: fakeLease.client },
          })
        } catch (err) {
          symlinkMetaErr = err
        }
        expect(symlinkMetaErr).toBeInstanceOf(WriterLeaseHeldError)
        if (symlinkMetaErr instanceof WriterLeaseHeldError) {
          expect(symlinkMetaErr.holderId).toBe("existing-daemon")
          expect(symlinkMetaErr.leaseEpoch).toBeUndefined()
          expect(symlinkMetaErr.lockFilePath).toBe(runtimePaths.lockFilePath)
          expect(symlinkMetaErr.holderPid).toBeUndefined()
        }

        const pingPrimary = await Effect.runPromise(
          queryWorkflowDaemonCommand({
            socketPath: DaemonSocketPath.make(primary.socketPath),
            command: "ping",
          }).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(pingPrimary).toMatchObject({ ok: true, status: "warm" })

        // Verify HarnessDaemon.acquireWorkflowEngineInScope span under runWithTestTracer
        const startupState = { _tag: "Valid" as const, worktree: validatedRepo }
        const emptyFnIndex = new Map<string, IndexedEffectFn>()
        const { spans: engineSpans } = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const unixSocketDaemon = yield* UnixSocketDaemonPort
              const scope = yield* Scope.Scope
              return yield* runWithTestTracer(
                "HarnessDaemon.acquireWorkflowEngineInScope::span",
                acquireWorkflowEngineInScope({
                  daemonScope: scope,
                  startupState,
                  workflowEngineOptions: { mode: "disabled" },
                  unixSocketDaemon,
                }),
                emptyFnIndex,
              )
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(
          engineSpans.some((s) => s.name === "HarnessDaemon.acquireWorkflowEngineInScope"),
        ).toBe(true)
      } finally {
        await primary.close()
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("F-1.1: mode 'auto' degrades cleanly on non-git dirs and unreachable Omnigraph, and attaches as secondary on already-alive", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hmcp-wl-auto-"))
    try {
      const nonGitDir = join(tmpDir, "non-git")
      mkdirSync(nonGitDir, { recursive: true })

      const nonGitDaemon = await startHarnessDaemonServer(nonGitDir, {
        workflowEngine: { mode: "auto" },
      })
      try {
        expect(nonGitDaemon.writerLeaseEpoch).toBeUndefined()
        const statusRes = await Effect.runPromise(
          queryWorkflowDaemonCommand({
            socketPath: DaemonSocketPath.make(nonGitDaemon.socketPath),
            command: "workflow.status",
          }).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(statusRes).toMatchObject({
          ok: true,
          status: "inactive",
          result: { _tag: "DaemonOffline", outcome: { _tag: "NotFound" } },
        })
        expect(statusRes.writerLeaseEpoch).toBeUndefined()
      } finally {
        await nonGitDaemon.close()
      }

      const repoDir = initCanonicalGitRepo(tmpDir)
      const primaryAuto = await startHarnessDaemonServer(repoDir, {
        workflowEngine: {
          mode: "auto",
          env: { OMNIGRAPH_URL: "http://127.0.0.1:1" },
        },
      })
      try {
        expect(primaryAuto.writerLeaseEpoch).toBeUndefined()
        const secondaryAuto = await startHarnessDaemonServer(repoDir, {
          workflowEngine: {
            mode: "auto",
            env: { OMNIGRAPH_URL: "http://127.0.0.1:1" },
          },
        })
        expect(secondaryAuto.socketPath).toBe(primaryAuto.socketPath)
        await secondaryAuto.close()
        expect(existsSync(primaryAuto.socketPath)).toBe(true)

        const statusRes = await Effect.runPromise(
          queryWorkflowDaemonCommand({
            socketPath: DaemonSocketPath.make(primaryAuto.socketPath),
            command: "workflow.status",
          }).pipe(Effect.provide(UnixSocketDaemonLive)),
        )
        expect(statusRes).toMatchObject({
          ok: true,
          status: "inactive",
          result: { _tag: "DaemonOffline", outcome: { _tag: "NotFound" } },
        })
        expect(statusRes.writerLeaseEpoch).toBeUndefined()
      } finally {
        await primaryAuto.close()
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("shuts down fail-closed after 3 consecutive WorkflowStoreUnavailableError heartbeat failures while resetting streak on recovery", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hmcp-wl-store-err-"))
    try {
      const repoDir = initCanonicalGitRepo(tmpDir)
      const fakeLease = makeInMemoryWorkflowLeaseClient()
      fakeLease.setRefreshFailuresRemaining(1)
      const leaseLostReasons: Array<string> = []

      const handle = await startHarnessDaemonServer(repoDir, {
        workflowEngine: {
          mode: "required",
          client: fakeLease.client,
          heartbeatIntervalMs: 30,
          onLeaseLost: (reason) => {
            leaseLostReasons.push(reason)
          },
        },
      })

      try {
        await pollUntil(
          () => fakeLease.getRefreshFailureCount() === 1 && fakeLease.getRefreshCount() >= 2,
        )
        expect(existsSync(handle.socketPath)).toBe(true)
        expect(leaseLostReasons).toEqual([])

        fakeLease.setRefreshFailuresRemaining(3)
        await pollUntil(() => leaseLostReasons.length >= 1 && !existsSync(handle.socketPath))
        expect(fakeLease.getRefreshFailureCount()).toBe(4)
        expect(leaseLostReasons[0]).toContain("Simulated transient Omnigraph store outage")
      } finally {
        await handle.close()
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
