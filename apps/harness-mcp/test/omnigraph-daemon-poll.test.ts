import { createServer } from "node:http"
import { connect } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DatalogSession, type DatalogSessionShape, GraphInferenceError } from "@harness/graph"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"

const tempDirs: Array<string> = []

const sendDaemonLine = (socketPath: string, payload: Record<string, unknown>): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath)
    let buf = ""
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl >= 0) {
        const line = buf.slice(0, nl)
        socket.end()
        resolvePromise(line)
      }
    })
    socket.on("error", reject)
  })

const makeMockRepo = (): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-rfc0009-daemon-"))
  tempDirs.push(repoRoot)
  mkdirSync(join(repoRoot, "libs", "harness", "graph"), { recursive: true })
  mkdirSync(join(repoRoot, "src"), { recursive: true })
  mkdirSync(join(repoRoot, ".harness", "omnigraph-cluster"), { recursive: true })
  writeFileSync(join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(
    join(repoRoot, "src", "index.ts"),
    'import { Effect } from "effect"\nexport const demo = Effect.fn("Demo.run")(function* () { return 1 })\n',
    "utf8",
  )
  writeFileSync(
    join(repoRoot, ".harness", "graph-head.json"),
    JSON.stringify({ headSha: "abc123", gitBranch: "main", updatedAt: new Date().toISOString() }),
    "utf8",
  )
  return repoRoot
}

describe("RFC-0009 unix-socket-daemon poll-changes", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("steps DatalogSession on normal change-feed delta and persists changeFeedCursor", async () => {
    const repoRoot = makeMockRepo()
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes/poll") || url.includes("/changes")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            cursor: "cur-2",
            caught_up: true,
            next_page_token: null,
            blocks: [
              {
                cause: {
                  authored_at: 1000,
                  authored_branch: "main",
                  graph_commit_id: "cmt-2",
                },
                changes: [
                  {
                    id: "fn-1",
                    kind: "node",
                    op: "insert",
                    type: { id: "t1", name: "EffectFn" },
                    before: null,
                    after: { properties: { file: "src/index.ts", spanName: "Demo.run" } },
                  },
                ],
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end(JSON.stringify({ error: "not found" }))
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-delta-1",
        command: "poll-changes",
        repoRoot,
      })
      const parsed = JSON.parse(raw) as {
        readonly id?: string
        readonly ok?: boolean
        readonly cursor?: string | null
        readonly requiresBaseline?: boolean
        readonly updatedFiles?: ReadonlyArray<string>
      }
      expect(parsed.id).toBe("poll-delta-1")
      expect(parsed.ok).toBe(true)
      expect(parsed.cursor).toBe("cur-2")
      expect(parsed.requiresBaseline).toBe(false)
      expect(parsed.updatedFiles).toEqual(["src/index.ts"])

      const headMeta = JSON.parse(
        readFileSync(join(repoRoot, ".harness", "graph-head.json"), "utf8"),
      ) as { readonly changeFeedCursor?: string }
      expect(headMeta.changeFeedCursor).toBe("cur-2")
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("recovers via baseline handshake on HTTP 410 ChangeFeedGap and updates changeFeedCursor", async () => {
    const repoRoot = makeMockRepo()
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes/baseline")) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(
          `${JSON.stringify({ baseline: { resume_cursor: "cur-base-1", snapshot_commit_id: "cmt-base-1" } })}\n`,
        )
        return
      }
      if (url.includes("/changes")) {
        res.writeHead(410, headers)
        res.end(
          JSON.stringify({
            code: "change_feed_gap",
            message: "cursor expired",
            change_feed_gap: {
              cursor: "cur-old",
              first_unreadable_commit_id: "cmt-0",
            },
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end(JSON.stringify({ error: "not found" }))
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-410-1",
        command: "poll-changes",
        repoRoot,
        cursor: "cur-old",
      })
      const parsed = JSON.parse(raw) as {
        readonly id?: string
        readonly ok?: boolean
        readonly cursor?: string | null
        readonly requiresBaseline?: boolean
      }
      expect(parsed.id).toBe("poll-410-1")
      expect(parsed.ok).toBe(true)
      expect(parsed.requiresBaseline).toBe(true)
      expect(parsed.cursor).toBe("cur-base-1")

      const headMeta = JSON.parse(
        readFileSync(join(repoRoot, ".harness", "graph-head.json"), "utf8"),
      ) as { readonly changeFeedCursor?: string }
      expect(headMeta.changeFeedCursor).toBe("cur-base-1")
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-1.1b: poll-changes persists changeFeedCursor while leaving headSha and gitBranch untouched", async () => {
    const repoRoot = makeMockRepo()
    rmSync(join(repoRoot, ".harness", "graph-head.json"))
    mkdirSync(join(repoRoot, ".git", "refs", "heads"), { recursive: true })
    writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/feat/wip\n", "utf8")
    writeFileSync(join(repoRoot, ".git", "refs", "heads", "feat"), "unused", "utf8")

    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            cursor: "cur-preserved-1",
            caught_up: true,
            next_page_token: null,
            blocks: [],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-preserve-1",
        command: "poll-changes",
        repoRoot,
      })
      const parsed = JSON.parse(raw) as { readonly ok?: boolean; readonly cursor?: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.cursor).toBe("cur-preserved-1")

      const headMeta = JSON.parse(
        readFileSync(join(repoRoot, ".harness", "graph-head.json"), "utf8"),
      ) as {
        readonly headSha: string | null
        readonly gitBranch: string | null
        readonly changeFeedCursor?: string | null
      }
      expect(headMeta.headSha).toBeNull()
      expect(headMeta.gitBranch).toBeNull()
      expect(headMeta.changeFeedCursor).toBe("cur-preserved-1")
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-7.1: poll-changes rejects path traversal outside workspace root", async () => {
    const repoRoot = makeMockRepo()
    rmSync(join(repoRoot, ".harness", "graph-head.json"))
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            cursor: "cur-evil",
            caught_up: true,
            next_page_token: null,
            blocks: [
              {
                cause: { authored_at: 1000, authored_branch: "main", graph_commit_id: "cmt-evil" },
                changes: [
                  {
                    id: "fn-evil",
                    kind: "node",
                    op: "insert",
                    type: { id: "t1", name: "EffectFn" },
                    before: null,
                    after: { properties: { file: "../../etc/passwd.ts" } },
                  },
                ],
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-traversal-1",
        command: "poll-changes",
        repoRoot,
      })
      const parsed = JSON.parse(raw) as { readonly ok?: boolean; readonly error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("escapes workspace root")
      expect(existsSync(join(repoRoot, ".harness", "graph-head.json"))).toBe(false)
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-4.1: poll-changes returns ok:false when graph-head.json persistence fails", async () => {
    const repoRoot = makeMockRepo()
    rmSync(join(repoRoot, ".harness", "graph-head.json"))

    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        // Create a directory at graph-head.json after initial Missing check so renameSync fails with EISDIR
        mkdirSync(join(repoRoot, ".harness", "graph-head.json"), { recursive: true })
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            cursor: "cur-fail-persist",
            caught_up: true,
            next_page_token: null,
            blocks: [],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-persist-fail",
        command: "poll-changes",
        repoRoot,
      })
      const parsed = JSON.parse(raw) as { readonly ok?: boolean; readonly error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toBe("Failed to persist graph-head.json")
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("S-2.2: non-.ts change blocks refresh DatalogSession baseline", async () => {
    const repoRoot = makeMockRepo()
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            cursor: "cur-nonts-1",
            caught_up: true,
            next_page_token: null,
            blocks: [
              {
                cause: { authored_at: 1000, authored_branch: "main", graph_commit_id: "cmt-doc-1" },
                changes: [
                  {
                    id: "adr-1",
                    kind: "node",
                    op: "insert",
                    type: { id: "t2", name: "AdrDoc" },
                    before: null,
                    after: { properties: { file: "docs/adr/0001-test.md" } },
                  },
                ],
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw = await sendDaemonLine(handle.socketPath, {
        id: "poll-nonts-1",
        command: "poll-changes",
        repoRoot,
      })
      const parsed = JSON.parse(raw) as {
        readonly ok?: boolean
        readonly cursor?: string
        readonly blockCount?: number
        readonly updatedFiles?: ReadonlyArray<string>
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.cursor).toBe("cur-nonts-1")
      expect(parsed.blockCount).toBe(1)
      expect(parsed.updatedFiles).toEqual([])
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("R2-P3 & R2-I10: poll-changes fails closed on corrupt graph-head.json and rejects empty/whitespace branch or cursor", async () => {
    const repoRoot = makeMockRepo()
    writeFileSync(join(repoRoot, ".harness", "graph-head.json"), "{corrupt-json", "utf8")

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const corruptRaw = await sendDaemonLine(handle.socketPath, {
        id: "poll-corrupt-1",
        command: "poll-changes",
        repoRoot,
      })
      const corruptParsed = JSON.parse(corruptRaw) as {
        readonly ok?: boolean
        readonly error?: string
      }
      expect(corruptParsed.ok).toBe(false)
      expect(corruptParsed.error).toContain("Corrupt graph-head.json")
      expect(readFileSync(join(repoRoot, ".harness", "graph-head.json"), "utf8")).toBe(
        "{corrupt-json",
      )

      rmSync(join(repoRoot, ".harness", "graph-head.json"))

      for (const badBranch of ["", "   "]) {
        const badBranchRaw = await sendDaemonLine(handle.socketPath, {
          id: `poll-bad-branch-${badBranch.length}`,
          command: "poll-changes",
          repoRoot,
          branch: badBranch,
        })
        const badBranchParsed = JSON.parse(badBranchRaw) as {
          readonly ok?: boolean
          readonly error?: string
        }
        expect(badBranchParsed.ok).toBe(false)
        expect(badBranchParsed.error).toContain("Invalid branch name")
      }

      for (const badCursor of ["", "   "]) {
        const badCursorRaw = await sendDaemonLine(handle.socketPath, {
          id: `poll-bad-cursor-${badCursor.length}`,
          command: "poll-changes",
          repoRoot,
          cursor: badCursor,
        })
        const badCursorParsed = JSON.parse(badCursorRaw) as {
          readonly ok?: boolean
          readonly error?: string
        }
        expect(badCursorParsed.ok).toBe(false)
        expect(badCursorParsed.error).toContain("Invalid change cursor")
      }
    } finally {
      await handle.close()
    }
  })

  it("F-5.1: mixed TS and non-TS change feed triggers full DatalogSession rebuild and advances cursor", async () => {
    const repoRoot = makeMockRepo()
    const createdSessions: Array<DatalogSessionShape> = []
    const stepSpies: Array<ReturnType<typeof vi.spyOn>> = []
    const origMake = DatalogSession.make.bind(DatalogSession)
    vi.spyOn(DatalogSession, "make").mockImplementation((graph, priors) =>
      origMake(graph, priors).pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            createdSessions.push(session)
            stepSpies.push(vi.spyOn(session, "stepFileDelta"))
          }),
        ),
      ),
    )

    let pollCount = 0
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        pollCount += 1
        res.writeHead(200, headers)
        if (pollCount === 1) {
          res.end(
            JSON.stringify({
              cursor: "cur-mixed-1",
              caught_up: true,
              next_page_token: null,
              blocks: [
                {
                  cause: { authored_at: 1000, authored_branch: "main", graph_commit_id: "cmt-1" },
                  changes: [
                    {
                      id: "fn-1",
                      kind: "node",
                      op: "insert",
                      type: { id: "t1", name: "EffectFn" },
                      before: null,
                      after: { properties: { file: "src/index.ts", spanName: "Demo.run" } },
                    },
                  ],
                },
              ],
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            cursor: "cur-mixed-2",
            caught_up: true,
            next_page_token: null,
            blocks: [
              {
                cause: { authored_at: 2000, authored_branch: "main", graph_commit_id: "cmt-2" },
                changes: [
                  {
                    id: "fn-2",
                    kind: "node",
                    op: "insert",
                    type: { id: "t1", name: "EffectFn" },
                    before: null,
                    after: { properties: { file: "libs/demo/src/extra.ts", spanName: "Extra.run" } },
                  },
                  {
                    id: "adr-1",
                    kind: "node",
                    op: "insert",
                    type: { id: "t2", name: "AdrDoc" },
                    before: null,
                    after: { properties: { file: "docs/adr/0001-mixed.md" } },
                  },
                ],
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      const raw1 = await sendDaemonLine(handle.socketPath, {
        id: "poll-mixed-init",
        command: "poll-changes",
        repoRoot,
      })
      const parsed1 = JSON.parse(raw1) as { readonly ok?: boolean; readonly cursor?: string }
      expect(parsed1.ok).toBe(true)
      expect(parsed1.cursor).toBe("cur-mixed-1")
      expect(createdSessions).toHaveLength(1)
      expect(stepSpies[0]).toHaveBeenCalledTimes(1)

      mkdirSync(join(repoRoot, "libs", "demo", "src"), { recursive: true })
      writeFileSync(
        join(repoRoot, "libs", "demo", "package.json"),
        JSON.stringify({ name: "@demo/pkg" }),
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "demo", "src", "extra.ts"),
        'import { Effect } from "effect"\nexport const extra = Effect.fn("Extra.run")(function* () { return 2 })\n',
        "utf8",
      )
      mkdirSync(join(repoRoot, "docs", "adr"), { recursive: true })
      writeFileSync(
        join(repoRoot, "docs", "adr", "0001-mixed.md"),
        "# ADR-0001: Mixed Change Feed\n",
        "utf8",
      )

      const raw2 = await sendDaemonLine(handle.socketPath, {
        id: "poll-mixed-both",
        command: "poll-changes",
        repoRoot,
      })
      const parsed2 = JSON.parse(raw2) as {
        readonly ok?: boolean
        readonly cursor?: string
        readonly updatedFiles?: ReadonlyArray<string>
      }
      expect(parsed2.ok).toBe(true)
      expect(parsed2.cursor).toBe("cur-mixed-2")
      expect(parsed2.updatedFiles).toEqual(["libs/demo/src/extra.ts"])

      // Full rebuild was triggered instead of stepping the cached session
      expect(createdSessions).toHaveLength(2)
      expect(stepSpies[0]).toHaveBeenCalledTimes(1)
      expect(stepSpies[1]).toHaveBeenCalledTimes(0)

      const rebuiltSnapshot = await Effect.runPromise(createdSessions[1]!.snapshot)
      expect(rebuiltSnapshot.epoch).toBe(1)
      const fnNames = Array.from(Graph.values(Graph.nodes(rebuiltSnapshot.graph.graph)))
        .filter((node) => node._tag === "EffectFn")
        .map((node) => node.spanName)
      expect(fnNames).toContain("Extra.run")

      const headMeta = JSON.parse(
        readFileSync(join(repoRoot, ".harness", "graph-head.json"), "utf8"),
      ) as { readonly changeFeedCursor?: string }
      expect(headMeta.changeFeedCursor).toBe("cur-mixed-2")
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-6.1: failed DatalogSession.make rebuild evicts cached DatalogSession so subsequent polls do not use stale state", async () => {
    const repoRoot = makeMockRepo()
    const createdSessions: Array<DatalogSessionShape> = []
    const stepSpies: Array<ReturnType<typeof vi.spyOn>> = []
    const origMake = DatalogSession.make.bind(DatalogSession)
    let makeAttempt = 0
    vi.spyOn(DatalogSession, "make").mockImplementation((graph, priors) => {
      makeAttempt += 1
      if (makeAttempt === 2) {
        return Effect.fail(
          new GraphInferenceError({
            reason: "rebuild-failed",
            message: "simulated rebuild failure",
          }),
        )
      }
      return origMake(graph, priors).pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            createdSessions.push(session)
            stepSpies.push(vi.spyOn(session, "stepFileDelta"))
          }),
        ),
      )
    })

    let pollCount = 0
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/changes")) {
        pollCount += 1
        res.writeHead(200, headers)
        if (pollCount === 1) {
          res.end(
            JSON.stringify({
              cursor: "cur-evict-1",
              caught_up: true,
              next_page_token: null,
              blocks: [
                {
                  cause: { authored_at: 1000, authored_branch: "main", graph_commit_id: "cmt-1" },
                  changes: [
                    {
                      id: "fn-1",
                      kind: "node",
                      op: "insert",
                      type: { id: "t1", name: "EffectFn" },
                      before: null,
                      after: { properties: { file: "src/index.ts", spanName: "Demo.run" } },
                    },
                  ],
                },
              ],
            }),
          )
          return
        }
        if (pollCount === 2) {
          res.end(
            JSON.stringify({
              cursor: "cur-evict-2",
              caught_up: true,
              next_page_token: null,
              blocks: [
                {
                  cause: { authored_at: 2000, authored_branch: "main", graph_commit_id: "cmt-2" },
                  changes: [
                    {
                      id: "adr-2",
                      kind: "node",
                      op: "insert",
                      type: { id: "t2", name: "AdrDoc" },
                      before: null,
                      after: { properties: { file: "docs/adr/0002-evict.md" } },
                    },
                  ],
                },
              ],
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            cursor: "cur-evict-3",
            caught_up: true,
            next_page_token: null,
            blocks: [
              {
                cause: { authored_at: 3000, authored_branch: "main", graph_commit_id: "cmt-3" },
                changes: [
                  {
                    id: "fn-3",
                    kind: "node",
                    op: "insert",
                    type: { id: "t1", name: "EffectFn" },
                    before: null,
                    after: { properties: { file: "src/index.ts", spanName: "Demo.run" } },
                  },
                ],
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
    const addr = server.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    writeFileSync(
      join(repoRoot, ".harness", "omnigraph-cluster", "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: repoRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const handle = await startHarnessDaemonServer(repoRoot)
    try {
      // 1. Initial TS-only poll caches session 0
      const raw1 = await sendDaemonLine(handle.socketPath, {
        id: "poll-evict-1",
        command: "poll-changes",
        repoRoot,
      })
      const parsed1 = JSON.parse(raw1) as { readonly ok?: boolean; readonly cursor?: string }
      expect(parsed1.ok).toBe(true)
      expect(parsed1.cursor).toBe("cur-evict-1")
      expect(createdSessions).toHaveLength(1)
      expect(stepSpies[0]).toHaveBeenCalledTimes(1)

      // 2. Non-TS poll triggers rebuild which fails -> must evict cached session 0
      const raw2 = await sendDaemonLine(handle.socketPath, {
        id: "poll-evict-2",
        command: "poll-changes",
        repoRoot,
      })
      const parsed2 = JSON.parse(raw2) as { readonly ok?: boolean; readonly error?: string }
      expect(parsed2.ok).toBe(false)
      expect(parsed2.error).toContain("simulated rebuild failure")

      // 3. Subsequent TS-only poll must NOT reuse stale session 0; it must construct a fresh session
      const raw3 = await sendDaemonLine(handle.socketPath, {
        id: "poll-evict-3",
        command: "poll-changes",
        repoRoot,
      })
      const parsed3 = JSON.parse(raw3) as { readonly ok?: boolean; readonly cursor?: string }
      expect(parsed3.ok).toBe(true)
      expect(parsed3.cursor).toBe("cur-evict-3")

      expect(makeAttempt).toBe(3)
      expect(createdSessions).toHaveLength(2)
      expect(stepSpies[0]).toHaveBeenCalledTimes(1)
      expect(stepSpies[1]).toHaveBeenCalledTimes(1)
    } finally {
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })
})
