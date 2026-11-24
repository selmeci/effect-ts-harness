import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Omnigraph } from "@modernrelay/omnigraph"
import { expect } from "vitest"
import { makeWorkflowOmnigraphClient } from "../../src/index.js"

export const graphConfigDir = resolve(import.meta.dirname, "../..")

export const isRowsEnvelope = (
  value: unknown,
): value is { readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> } =>
  typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)

export const requireRows = (res: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!isRowsEnvelope(res)) {
    return expect.unreachable("Expected Omnigraph query result envelope with a rows array")
  }
  return res.rows
}
export const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
export const omnigraphServerBin = join(
  process.env.HOME ?? "/root",
  ".local",
  "bin",
  "omnigraph-server",
)

export const padSeqKey = (snowflake: string): string => snowflake.padStart(20, "0")

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
  for (const m of applyStdout.matchAll(/Admission lock:\s*([A-Z0-9]+)/gi)) {
    if (m[1]) {
      lockIds.add(m[1])
    }
  }
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (existsSync(lockJsonPath)) {
    const parsed = JSON.parse(readFileSync(lockJsonPath, "utf8")) as Record<string, unknown>
    for (const key of ["lock_id", "id", "lockId"]) {
      const val = parsed[key]
      if (typeof val === "string" && val.length > 0) {
        lockIds.add(val)
      }
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
        if (body.ready === true) {
          return
        }
      }
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for omnigraph-server readiness at ${baseUrl}`)
}

export const stopChildProcess = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) {
    return
  }
  await new Promise<void>((resolveStop) => {
    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL")
      }
    }, 3_000)
    proc.once("exit", () => {
      clearTimeout(forceKillTimer)
      resolveStop()
    })
    proc.kill("SIGTERM")
  })
}

export const clearAddressRows = async (
  og: InstanceType<typeof Omnigraph>,
  entityType: string,
  entityId: string,
): Promise<void> => {
  const keysRows = requireRows(
    await og.queries.invoke("wf_message_keys_for_address", {
      branch: "main",
      expectMutation: false,
      params: { entityType, entityId },
    }),
  )
  const reqIds = Array.from(new Set(keysRows.map((r) => String(r.requestId))))
  if (keysRows.length > 0) {
    await og.queries.invoke("wf_clear_address", {
      branch: "main",
      expectMutation: true,
      params: { requestIds: reqIds, entityType, entityId },
    })
  }
}

export interface WorkflowGraphServerHarness {
  readonly tempDirs: Array<string>
  readonly cliToken: string
  readonly mcpToken: string
  readonly createCliClient: () => ReturnType<typeof makeWorkflowOmnigraphClient>
  readonly getServerBaseUrl: () => string
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
}

export const startWorkflowGraphServerHarness = (prefix: string): WorkflowGraphServerHarness => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  const cliToken = "wf2-test-cli-token"
  const mcpToken = "wf2-test-mcp-token"
  return {
    tempDirs,
    cliToken,
    mcpToken,
    createCliClient: () => makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken }),
    getServerBaseUrl: () => serverBaseUrl,
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
              "agent-mcp": mcpToken,
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
