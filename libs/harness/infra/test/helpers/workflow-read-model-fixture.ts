import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import { expect } from "vitest"
import {
  AbsoluteRepoRoot,
  MessageKey,
  ReplyKey,
  type SeqKey,
  WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  encodeSeqKey,
} from "@harness/contract"
import { type SpanSample } from "@harness/gates"
import { makeWorkflowOmnigraphClient, type OmnigraphClient } from "@harness/graph"
import { invokeWorkflowStoreQuery } from "../../src/index.js"

export const runWithTestTracer = <A, E, R>(
  testId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly result: A; readonly spans: ReadonlyArray<SpanSample> }, E, R> =>
  Effect.gen(function* () {
    const recorded = new Map<string, SpanSample>()
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        const parentSpanId = Option.match(options.parent, {
          onNone: () => null,
          onSome: (p) => p.spanId,
        })
        const startTimeMs =
          typeof span.status.startTime === "bigint"
            ? Number(span.status.startTime) / 1_000_000
            : undefined
        recorded.set(span.spanId, {
          spanId: span.spanId,
          name: span.name,
          parentSpanId,
          ...(startTimeMs !== undefined ? { startTimeMs } : {}),
        })
        const origEnd = span.end.bind(span)
        span.end = (endTime, exit) => {
          const durationMs =
            typeof endTime === "bigint" && typeof span.status.startTime === "bigint"
              ? Number(endTime - span.status.startTime) / 1_000_000
              : undefined
          const endTimeMs = typeof endTime === "bigint" ? Number(endTime) / 1_000_000 : undefined
          const exitMeta = match(exit)
            .with({ _tag: "Success" }, () => ({ exitTag: "Success" as const, errorTag: null }))
            .with({ _tag: "Failure" }, ({ cause }) =>
              Option.match(Cause.findErrorOption(cause), {
                onSome: (err) => ({
                  exitTag: "Failure" as const,
                  errorTag: err instanceof Error ? err.name : null,
                }),
                onNone: () => ({ exitTag: "Defect" as const, errorTag: null }),
              }),
            )
            .exhaustive()
          recorded.set(span.spanId, {
            spanId: span.spanId,
            name: span.name,
            parentSpanId,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(startTimeMs !== undefined ? { startTimeMs } : {}),
            ...(endTimeMs !== undefined ? { endTimeMs } : {}),
            exitTag: exitMeta.exitTag,
            errorTag: exitMeta.errorTag,
          })
          origEnd(endTime, exit)
        }
        return span
      },
    })
    const result = yield* effect.pipe(
      Effect.withSpan(`Test:${testId}`),
      Effect.provideService(Tracer.Tracer, tracer),
    )
    return { result, spans: Array.from(recorded.values()) }
  })

export const graphConfigDir = resolve(import.meta.dirname, "../../../graph")
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

export const unwrapSeqKey = (value: bigint): SeqKey =>
  match(encodeSeqKey(value))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      throw new Error(failure)
    })
    .exhaustive()

export type Omnigraph = InstanceType<typeof OmnigraphClient>
export type InvokeQueryResult = Awaited<ReturnType<Omnigraph["queries"]["invoke"]>>

export const fakeReadResult = (
  queryName: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  graphCommitId: string | null = "cmt-mock-1",
): InvokeQueryResult => ({
  queryName,
  rowCount: rows.length,
  rows: [...rows],
  graphCommitId,
  target: { branch: "main" },
})

export const wrapQueriesInvoke = (
  client: Omnigraph,
  onInvoke: (
    name: string,
    orig: typeof client.queries.invoke,
    input?: Parameters<typeof client.queries.invoke>[1],
    opts?: Parameters<typeof client.queries.invoke>[2],
  ) => ReturnType<typeof client.queries.invoke>,
): Omnigraph =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return (
                name: string,
                input?: Parameters<typeof target.queries.invoke>[1],
                opts?: Parameters<typeof target.queries.invoke>[2],
              ) => onInvoke(name, qTarget.invoke.bind(qTarget), input, opts)
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })

export interface WorkflowReadModelServerHarness {
  readonly cliToken: string
  readonly createClient: () => ReturnType<typeof makeWorkflowOmnigraphClient>
  readonly getRepoRoot: () => AbsoluteRepoRoot
  readonly nextMsgKey: () => { readonly key: MessageKey; readonly seqKey: SeqKey }
  readonly nextReplyKey: () => { readonly key: ReplyKey; readonly seqKey: SeqKey }
  readonly insertJournalMessage: (
    client: Omnigraph,
    params: {
      readonly shardId: string
      readonly entityId: string
      readonly tag: string
      readonly payload: string
    },
  ) => Effect.Effect<MessageKey, WorkflowStoreUnavailableError>
  readonly insertJournalReplyExit: (
    client: Omnigraph,
    requestId: MessageKey,
    payload: unknown,
  ) => Effect.Effect<unknown, WorkflowStoreUnavailableError>
  readonly cleanupRunsAndJournal: (
    client: Omnigraph,
    runIds: ReadonlyArray<WorkflowRunId>,
    extraEntityIds?: ReadonlyArray<string>,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError>
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
}

export const startWorkflowReadModelServerHarness = (
  prefix: string,
): WorkflowReadModelServerHarness => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  let repoRoot: AbsoluteRepoRoot
  const cliToken = "wf3-readmodel-cli-token"
  let nextMsgId = 300000000000000001n
  let nextReplyId = 400000000000000001n

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

  const nextMsgKey = () => {
    const id = nextMsgId
    nextMsgId += 1n
    return { key: MessageKey.make(id.toString()), seqKey: unwrapSeqKey(id) }
  }

  const nextReplyKey = () => {
    const id = nextReplyId
    nextReplyId += 1n
    return { key: ReplyKey.make(id.toString()), seqKey: unwrapSeqKey(id) }
  }

  const insertJournalMessage = (
    client: Omnigraph,
    params: {
      readonly shardId: string
      readonly entityId: string
      readonly tag: string
      readonly payload: string
    },
  ) => {
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.insertMsg")
    const { key, seqKey } = nextMsgKey()
    return invokeWorkflowStoreQuery({
      repoRoot,
      client,
      operation: op,
      queryName: "wf_insert_request_message",
      expectMutation: true,
      params: {
        messageKey: key,
        seqKey,
        primaryKeyHash: null,
        shardId: params.shardId,
        entityType: "Workflow/HarnessTaskWorkflow",
        entityId: params.entityId,
        tag: params.tag,
        payload: params.payload,
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: key,
        deliverAtMs: null,
      },
    }).pipe(Effect.as(key))
  }

  const insertJournalReplyExit = (client: Omnigraph, requestId: MessageKey, payload: unknown) => {
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.insertReply")
    const { key, seqKey } = nextReplyKey()
    return invokeWorkflowStoreQuery({
      repoRoot,
      client,
      operation: op,
      queryName: "wf_save_reply_exit",
      expectMutation: true,
      params: {
        replyKey: key,
        seqKey,
        requestId,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    })
  }

  const cleanupRunsAndJournal = (
    client: Omnigraph,
    runIds: ReadonlyArray<WorkflowRunId>,
    extraEntityIds: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      const op = WorkflowStoreOperation.make("WorkflowReadModelTest.cleanup")
      for (const runId of runIds) {
        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_delete_run_views",
          params: { runId },
          expectMutation: true,
        })
      }
      for (const entityId of [...runIds, ...extraEntityIds]) {
        const rows = yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_message_keys_for_address",
          params: { entityType: "Workflow/HarnessTaskWorkflow", entityId },
          expectMutation: false,
        })
        const reqIds = Array.from(
          new Set(
            rows.flatMap((r) => {
              const parsed = Schema.decodeUnknownOption(MessageKey)(r.requestId)
              return match(parsed)
                .with({ _tag: "Some" }, ({ value }) => [value])
                .with({ _tag: "None" }, () => [])
                .exhaustive()
            }),
          ),
        )
        if (rows.length > 0) {
          yield* invokeWorkflowStoreQuery({
            repoRoot,
            client,
            operation: op,
            queryName: "wf_clear_address",
            params: {
              requestIds: reqIds,
              entityType: "Workflow/HarnessTaskWorkflow",
              entityId,
            },
            expectMutation: true,
          })
        }
      }
    })

  return {
    cliToken,
    createClient,
    getRepoRoot: () => repoRoot,
    nextMsgKey,
    nextReplyKey,
    insertJournalMessage,
    insertJournalReplyExit,
    cleanupRunsAndJournal,
    start: async () => {
      expect(existsSync(omnigraphBin)).toBe(true)
      expect(existsSync(omnigraphServerBin)).toBe(true)
      const tempRoot = mkdtempSync(join(tmpdir(), prefix))
      tempDirs.push(tempRoot)
      repoRoot = AbsoluteRepoRoot.make(tempRoot)
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
              "agent-mcp": "wf3-readmodel-mcp-token",
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
