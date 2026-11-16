import { createServer } from "node:http"
import { connect } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
    // Create a directory at graph-head.json so renameSync fails with EISDIR
    mkdirSync(join(repoRoot, ".harness", "graph-head.json"), { recursive: true })

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

  it("S-2.2: non-.ts change blocks refresh DatalogSession baseline and corrupt graph-head.json emits stderr warning", async () => {
    const repoRoot = makeMockRepo()
    writeFileSync(join(repoRoot, ".harness", "graph-head.json"), "{corrupt-json", "utf8")
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write

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
      expect(stderrChunks.join("")).toContain("failed to decode")
    } finally {
      process.stderr.write = origWrite
      await handle.close()
      server.closeAllConnections()
      server.close()
    }
  })
})
