import { createServer } from "node:http"
import { connect } from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
})
