import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Cause, Data, Effect, Layer, Schema } from "effect"
import {
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  ErrorReasonMessage,
  isPureInterruptCause,
} from "@harness/contract"
import { buildHarnessGraph } from "@harness/graph"
import { readTelemetryEvents } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { EmbeddingClient } from "@harness/service"
import { match } from "ts-pattern"
import {
  createServer,
  dispatchMcpTool,
  isPathInsideRoot,
  makeLiveMcpToolRegistryLayer,
  normalizeProjectPath,
  ProjectPathEscapeError,
  recordMcpToolTelemetry,
  resolveDaemonSocketPath,
  resolveDefaultRepoRoot,
  runDefaultLspDiagnostics,
  startHarnessDaemonServer,
} from "../src/server.js"
import { executeTool } from "./execute-tool-helper.js"
import { resolveGraphWithStatus } from "../src/tools/mcp-helpers.js"
import {
  GqQueryInputSchema,
  OntologyCheckInputSchema,
  OntologyImpactInputSchema,
  OntologyWhyInputSchema,
} from "../src/tools/ontology-and-gq.tools.js"
import { McpToolInputName } from "../src/tools/tool-registry.js"
import { sampleMcpGraph } from "./helpers/server-fixture.js"
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  }
})

class DaemonClientError extends Data.TaggedError("DaemonClientError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const sendDaemonRawPayload = (
  socketPath: string,
  rawPayload: string,
): Promise<Record<string, unknown>> =>
  Effect.runPromise(
    Effect.callback<Record<string, unknown>, DaemonClientError>((resume) => {
      const client = net.createConnection(socketPath)
      let buf = ""
      let settled = false
      const settle = (eff: Effect.Effect<Record<string, unknown>, DaemonClientError>) => {
        if (settled) return
        settled = true
        resume(eff)
      }
      client.on("connect", () => {
        client.write(rawPayload)
      })
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        const idx = buf.indexOf("\n")
        if (idx !== -1) {
          client.end()
          settle(
            Effect.try({
              try: () => JSON.parse(buf.slice(0, idx)) as Record<string, unknown>,
              catch: (err) =>
                new DaemonClientError({
                  message: err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
            }),
          )
        }
      })
      client.on("error", (err) => {
        settle(Effect.fail(new DaemonClientError({ message: err.message, cause: err })))
      })
      client.on("close", () => {
        settle(
          Effect.fail(new DaemonClientError({ message: "Daemon socket closed before response" })),
        )
      })
    }),
  )

const sendDaemonPayload = (socketPath: string, payload: string): Promise<Record<string, unknown>> =>
  sendDaemonRawPayload(socketPath, payload + "\n")

describe("harness-mcp daemon, LSP, ontology & knowledge tools", () => {
  const graph = sampleMcpGraph

  it("runDefaultLspDiagnostics resolves project when walking up parent directory with tsconfig.json", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..")
    const testFile = path.join(repoRoot, "libs/sample/domain/src/index.ts")
    const effect = runDefaultLspDiagnostics(repoRoot, { file: testFile })
    const res = await Effect.runPromise(effect)
    expect(res.clean).toBe(true)
    expect(res.summary.filesChecked).toBeGreaterThanOrEqual(1)
    expect(res.summary.errors).toBe(0)
    expect(res.diagnostics).toEqual([])
  })

  it("isPathInsideRoot correctly identifies child, self, and sibling prefix paths", () => {
    expect(isPathInsideRoot("/tmp/repo", "/tmp/repo/libs/a")).toBe(true)
    expect(isPathInsideRoot("/tmp/repo", "/tmp/repo")).toBe(true)
    expect(isPathInsideRoot("/tmp/repo", "/tmp/repo-other/libs/a")).toBe(false)
  })

  it("runDefaultLspDiagnostics fails cleanly on non-existent repo root", async () => {
    const effect = runDefaultLspDiagnostics("/tmp/non-existent-repo-for-lsp-test", {})
    const res = await Effect.runPromise(effect)
    expect(res.clean).toBe(false)
    expect(res.summary.errors).toBe(1)
    expect(res.diagnostics.length).toBeGreaterThanOrEqual(1)
    const firstDiag = String(res.diagnostics[0])
    expect(
      firstDiag.includes("[lsp-spawn-error]") ||
        firstDiag.includes("[lsp-exit-") ||
        firstDiag.includes("[lsp-exception]"),
    ).toBe(true)
  })

  it("startHarnessDaemonServer handles ping, ast-gates, and rejects path traversal outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-"))
    const sampleDir = path.join(tmpDir, "libs", "sample", "domain", "src")
    fs.mkdirSync(sampleDir, { recursive: true })
    fs.writeFileSync(path.join(sampleDir, "index.ts"), "export const x = 1\n", "utf-8")

    const daemon = await startHarnessDaemonServer(tmpDir)

    try {
      const pingRes = await sendDaemonPayload(
        daemon.socketPath,
        JSON.stringify({ id: "p1", command: "ping", repoRoot: tmpDir }),
      )
      expect(pingRes).toMatchObject({ id: "p1", ok: true, status: "warm" })

      const astRes = await sendDaemonPayload(
        daemon.socketPath,
        JSON.stringify({
          id: "a1",
          command: "ast-gates",
          repoRoot: tmpDir,
          files: ["libs/sample/domain/src/index.ts"],
        }),
      )
      expect(astRes).toMatchObject({ id: "a1", ok: true })

      const traversalRes = await sendDaemonPayload(
        daemon.socketPath,
        JSON.stringify({
          id: "t1",
          command: "ast-gates",
          repoRoot: tmpDir,
          files: ["../../../etc/passwd"],
        }),
      )
      expect(traversalRes).toMatchObject({
        id: "t1",
        ok: false,
      })
      expect(String(traversalRes.error)).toContain(
        "Path traversal outside workspace root is forbidden",
      )
    } finally {
      await daemon.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("executes harness_graph_rewrite in auto-plan and auto-repair modes", async () => {
    const planGraph = buildHarnessGraph({
      earsSpecs: [
        {
          id: "order:SPEC-0001",
          title: "Order Placement Spec",
          status: "proposed",
          path: "libs/order/docs/specs/0001-order.md",
          enforcedByFiles: ["libs/order/domain/src/order.ts"],
          referencedSpans: ["Order.placeOrder"],
          referencedServices: ["OrderService"],
          referencedErrors: ["OrderRejectedError"],
        },
      ],
    })

    const planRes = (await executeTool(
      "harness_graph_rewrite",
      { mode: "auto-plan", candidateRank: 1 },
      { graph: planGraph },
    )) as {
      readonly mode: string
      readonly selectedRank: number
      readonly priorsApplied: boolean
      readonly candidates: ReadonlyArray<unknown>
      readonly projection: {
        readonly overlays: ReadonlyArray<unknown>
        readonly verificationStatus: string
        readonly roundTripVerified: boolean
      }
    }

    expect(planRes.mode).toBe("auto-plan")
    expect(planRes.selectedRank).toBe(1)
    expect(planRes.priorsApplied).toBe(false)
    expect(planRes.candidates.length).toBeGreaterThan(0)
    expect(planRes.projection).toBeDefined()
    expect(planRes.projection.overlays.length).toBeGreaterThan(0)
    expect(planRes.projection.verificationStatus).toBe("Unverified")
    expect(planRes.projection.roundTripVerified).toBe(false)

    const repairGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/order.ts#decide",
          spanName: "Order.decide",
          file: "libs/sample/domain/src/order.ts",
          line: 10,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
    })

    const repairRes = (await executeTool(
      "harness_graph_rewrite",
      { mode: "auto-repair" },
      { graph: repairGraph },
    )) as { readonly mode: string; readonly candidates: ReadonlyArray<unknown> }

    expect(repairRes.mode).toBe("auto-repair")
    expect(Array.isArray(repairRes.candidates)).toBe(true)
  })

  it("executes harness_lsp_diagnostics with in-memory overlays and rejects non-compilable or invalid overlays", async () => {
    const lspRes = (await executeTool(
      "harness_lsp_diagnostics",
      {
        overlays: {
          "libs/sample/domain/src/index.ts": "export const valid = 42\n",
        },
      },
      { repoRoot: process.cwd() },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
    }

    expect(lspRes).toBeDefined()
    expect(lspRes.clean).toBe(true)
    expect(lspRes.summary.filesChecked).toBe(1)
    expect(lspRes.summary.errors).toBe(0)

    // Non-compilable overlay (.md) reports filesChecked: 0 and clean: false
    const nonCompilableRes = (await executeTool(
      "harness_lsp_diagnostics",
      {
        overlays: {
          "README.md": "# Documentation\n",
        },
      },
      { repoRoot: process.cwd() },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
    }
    expect(nonCompilableRes.clean).toBe(false)
    expect(nonCompilableRes.summary.filesChecked).toBe(0)

    // Invalid TypeScript type error reports clean: false and errors > 0
    const invalidTsRes = (await executeTool(
      "harness_lsp_diagnostics",
      {
        overlays: {
          "libs/sample/domain/src/index.ts": 'export const broken: number = "not-a-number"\n',
        },
      },
      { repoRoot: process.cwd() },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
    }
    expect(invalidTsRes.clean).toBe(false)
    expect(invalidTsRes.summary.filesChecked).toBe(1)
    expect(invalidTsRes.summary.errors).toBeGreaterThan(0)

    const escapedOverlayRes = (await executeTool(
      "harness_lsp_diagnostics",
      {
        overlays: {
          "../outside-secret.ts": "export const leak = 1\n",
        },
      },
      { repoRoot: process.cwd() },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
      readonly diagnostics: ReadonlyArray<{ readonly code?: string; readonly message?: string }>
    }
    expect(escapedOverlayRes.clean).toBe(false)
    expect(escapedOverlayRes.summary.errors).toBe(1)
    expect(escapedOverlayRes.diagnostics[0]?.code).toBe("PATH_TRAVERSAL")
    expect(escapedOverlayRes.diagnostics[0]?.message).toContain("escapes repository root")

    await expect(
      executeTool(
        "harness_lsp_diagnostics",
        {
          file: "../outside-file.ts",
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toMatchObject({
      _tag: "ProjectPathEscapeError",
      projectPath: "../outside-file.ts",
    })

    await expect(
      executeTool(
        "harness_lsp_diagnostics",
        {
          project: "../outside-tsconfig.json",
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toMatchObject({
      _tag: "ProjectPathEscapeError",
      projectPath: "../outside-tsconfig.json",
    })
  })

  it("rejects escaping file/project alongside overlays and broken overlays with non-matching file", async () => {
    const escapedWithOverlay = (await executeTool(
      "harness_lsp_diagnostics",
      {
        file: "../outside-file.ts",
        project: "../outside-tsconfig.json",
        overlays: {
          "libs/sample/domain/src/index.ts": "export const ok = 1\n",
        },
      },
      { repoRoot: process.cwd() },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
      readonly diagnostics: ReadonlyArray<{ readonly code?: string; readonly message?: string }>
    }
    expect(escapedWithOverlay.clean).toBe(false)
    expect(escapedWithOverlay.summary.errors).toBe(2)
    expect(escapedWithOverlay.diagnostics.every((d) => d.code === "PATH_TRAVERSAL")).toBe(true)

    const repoRoot = path.resolve(import.meta.dirname, "../../..")
    const brokenOverlayNonMatchingFile = (await executeTool(
      "harness_lsp_diagnostics",
      {
        file: "libs/sample/infra/src/index.ts",
        overlays: {
          "libs/sample/domain/src/index.ts": 'export const broken: number = "not-a-number"\n',
        },
      },
      { repoRoot },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
    }
    expect(brokenOverlayNonMatchingFile.clean).toBe(false)
    expect(brokenOverlayNonMatchingFile.summary.filesChecked).toBe(0)

    const brokenOverlayAbsFile = (await executeTool(
      "harness_lsp_diagnostics",
      {
        file: path.join(repoRoot, "libs/sample/domain/src/index.ts"),
        overlays: {
          "libs/sample/domain/src/index.ts": 'export const broken: number = "not-a-number"\n',
        },
      },
      { repoRoot },
    )) as {
      readonly clean: boolean
      readonly summary: { readonly filesChecked: number; readonly errors: number }
    }
    expect(brokenOverlayAbsFile.clean).toBe(false)
    expect(brokenOverlayAbsFile.summary.filesChecked).toBe(1)
    expect(brokenOverlayAbsFile.summary.errors).toBeGreaterThan(0)
  })

  it("validates raw priors in harness_graph_complete with Schema instead of unsafe cast", async () => {
    const exit = await Effect.runPromiseExit(
      dispatchMcpTool({
        toolName: McpToolInputName.make("harness_graph_complete"),
        args: {
          priors: {
            edgeConfidenceOverrides: {
              a: -1,
            },
          },
        },
      }).pipe(Effect.provide(makeLiveMcpToolRegistryLayer({ graph }))),
    )
    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(false)
        const errorOpt = Cause.findErrorOption(cause)
        match(errorOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toMatchObject({
              _tag: "GraphInferenceError",
              reason: "invalid-graph",
            })
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected errorOpt to be Some")
          })
          .exhaustive()
      })
      .with({ _tag: "Success" }, () => {
        throw new Error("Expected invalid priors in harness_graph_complete to fail Schema decode")
      })
      .exhaustive()
  })

  it("exposes effect/Schema JSON schemas on ListTools and validates CallTool arguments via Schema", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const { ErrorCode } = await import("@modelcontextprotocol/sdk/types.js")

    const srv = createServer({ graph })
    const client = new Client({ name: "in-memory-test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await srv.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.listTools()
      expect(listed.tools).toHaveLength(20)
      for (const tool of listed.tools) {
        expect(tool.description?.length).toBeGreaterThan(0)
        expect(tool.inputSchema.type).toBe("object")
        expect(tool.inputSchema.properties).toBeDefined()
      }

      const byName = new Map(listed.tools.map((t) => [t.name, t.inputSchema]))
      expect(byName.get("harness_resolve")?.properties).toMatchObject({
        symbolOrSpan: { type: "string" },
        repoRoot: {},
      })
      expect(byName.get("harness_graph_complete")?.properties).toMatchObject({
        minConfidenceMillis: {},
        priors: {},
        repoRoot: {},
      })
      expect(byName.get("harness_git_diff")?.properties).toMatchObject({
        repoRoot: {},
        baseRef: {},
        paths: {},
        statOnly: {},
        maxPatchChars: {},
      })
      expect(byName.get("harness_workflow_plan")?.properties).toMatchObject({
        repoRoot: {},
        runId: {},
      })

      const wfPlanRes = await client.callTool({
        name: "harness_workflow_plan",
        arguments: {},
      })
      expect(wfPlanRes.isError).not.toBe(true)
      const wfPlanBlock = Array.isArray(wfPlanRes.content) ? wfPlanRes.content[0] : undefined
      expect(wfPlanBlock?.type).toBe("text")
      if (wfPlanBlock?.type === "text") {
        expect(JSON.parse(wfPlanBlock.text)).toMatchObject({
          resolvedRepoRoot: expect.any(String),
          commonGitDir: expect.any(String),
          status: {
            _tag: "DaemonOffline",
            outcome: {
              _tag: "NotFound",
            },
          },
        })
      }

      const okRes = await client.callTool({
        name: "harness_resolve",
        arguments: { symbolOrSpan: "Sample.greet" },
      })
      expect(okRes.isError).not.toBe(true)
      const firstBlock = Array.isArray(okRes.content) ? okRes.content[0] : undefined
      expect(firstBlock?.type).toBe("text")
      if (firstBlock?.type === "text") {
        expect(JSON.parse(firstBlock.text)).toMatchObject({
          degraded: false,
          node: {
            spanName: "Sample.greet",
          },
        })
      }

      const nullOptRes = await client.callTool({
        name: "harness_graph_complete",
        arguments: { symbolOrSpan: null, minConfidenceMillis: null },
      })
      expect(nullOptRes.isError).not.toBe(true)

      const priorsRes = await client.callTool({
        name: "harness_graph_complete",
        arguments: { priors: { edgeConfidenceOverrides: { a: -1 } } },
      })
      expect(priorsRes.isError).toBe(true)
      const errBlock = Array.isArray(priorsRes.content) ? priorsRes.content[0] : undefined
      if (errBlock?.type === "text") {
        expect(errBlock.text).toContain("edge confidence prior")
      }

      for (const invalidCall of [
        { name: "harness_resolve", arguments: {} },
        { name: "harness_graph_complete", arguments: { minConfidenceMillis: 1001 } },
        { name: "harness_graph_complete", arguments: { minConfidenceMillis: -1 } },
        { name: "harness_graph_complete", arguments: { minConfidenceMillis: 1.5 } },
        { name: "harness_graph_rewrite", arguments: { candidateRank: 0 } },
        { name: "harness_graph_rewrite", arguments: { candidateRank: 6 } },
        { name: "harness_graph_rewrite", arguments: { mode: "bogus" } },
        { name: "harness_ontology_why", arguments: { symbolOrSpan: "   " } },
        { name: "harness_ontology_why", arguments: { symbolOrSpan: " Sample.greet" } },
        { name: "harness_workflow_plan", arguments: { runId: "BAD ID" } },
        { name: "harness_workflow_plan", arguments: { repoRoot: "   " } },
        { name: "harness_ontology_impact", arguments: { symbolOrSpan: "x".repeat(513) } },
        { name: "harness_ontology_check", arguments: { scope: "x".repeat(129) } },
        { name: "harness_gq_query", arguments: { queryName: "bogus" } },
        {
          name: "harness_gq_query",
          arguments: { queryName: "resolve_effect_fn", branch: " main" },
        },
        {
          name: "harness_gq_query",
          arguments: { queryName: "resolve_effect_fn", params: { " badKey": "v" } },
        },
      ]) {
        await expect(client.callTool(invalidCall)).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
        })
      }

      await expect(
        client.callTool({
          name: "nonexistent_tool",
          arguments: {},
        }),
      ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound })
    } finally {
      await client.close()
      await srv.close()
    }
  })

  it("daemon rejects repoRoot escape, >1MB payloads, malformed JSON, and returns fallbackToInProcess", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-sec-"))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-outside-"))
    const daemon = await startHarnessDaemonServer(tmpDir)

    await Effect.runPromise(
      Effect.promise(async () => {
        const escapeRes = await sendDaemonRawPayload(
          daemon.socketPath,
          JSON.stringify({ id: "esc-1", command: "ping", repoRoot: outsideRoot }) + "\n",
        )
        expect(escapeRes).toMatchObject({ id: "esc-1", ok: false })
        expect(String(escapeRes.error)).toContain("escapes daemon root")

        const relEscapeRes = await sendDaemonRawPayload(
          daemon.socketPath,
          JSON.stringify({ id: "esc-rel", command: "ping", repoRoot: "../outside" }) + "\n",
        )
        expect(relEscapeRes).toMatchObject({ id: "esc-rel", ok: false })
        expect(String(relEscapeRes.error)).toContain("escapes daemon root")

        const oversizedRes = await sendDaemonRawPayload(
          daemon.socketPath,
          "x".repeat(1_048_577) + "\n",
        )
        expect(oversizedRes).toMatchObject({ ok: false })
        expect(String(oversizedRes.error)).toContain("exceeds 1MB limit")

        const malformedRes = await sendDaemonRawPayload(daemon.socketPath, "{ bad json\n")
        expect(malformedRes).toMatchObject({ ok: false })
        expect(String(malformedRes.error)).toContain("Invalid daemon request payload")

        const fallbackRes = await sendDaemonRawPayload(
          daemon.socketPath,
          JSON.stringify({ id: "fb-1", command: "verify" }) + "\n",
        )
        expect(fallbackRes).toMatchObject({
          id: "fb-1",
          ok: false,
          fallbackToInProcess: true,
        })
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await daemon.close()
            fs.rmSync(tmpDir, { recursive: true, force: true })
            fs.rmSync(outsideRoot, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it("daemon cleans up real stale Unix domain socket and unlinks socket on close", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-stale-"))
    const socketPath = resolveDaemonSocketPath(tmpDir)
    const staleTmpSock = path.join(path.dirname(socketPath), "stale-origin.sock")
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })

    const staleServer = net.createServer()
    await new Promise<void>((resolve) => {
      staleServer.listen(staleTmpSock, () => resolve())
    })
    fs.renameSync(staleTmpSock, socketPath)
    await new Promise<void>((resolve) => {
      staleServer.close(() => resolve())
    })
    expect(fs.statSync(socketPath).isSocket()).toBe(true)

    const daemon = await startHarnessDaemonServer(tmpDir)
    await Effect.runPromise(
      Effect.promise(async () => {
        const pingRes = await sendDaemonPayload(
          daemon.socketPath,
          JSON.stringify({ id: "p-stale-sock", command: "ping" }),
        )
        expect(pingRes).toMatchObject({ id: "p-stale-sock", ok: true, status: "warm" })
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await daemon.close()
            expect(fs.existsSync(daemon.socketPath)).toBe(false)
            fs.rmSync(tmpDir, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it("daemon returns no-op handle on alreadyAlive and leaves primary socket alive on close", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-alive-"))
    const primary = await startHarnessDaemonServer(tmpDir)
    const secondary = await startHarnessDaemonServer(tmpDir)

    await Effect.runPromise(
      Effect.promise(async () => {
        expect(secondary.socketPath).toBe(primary.socketPath)
        await secondary.close()
        expect(fs.existsSync(primary.socketPath)).toBe(true)

        const pingRes = await sendDaemonPayload(
          primary.socketPath,
          JSON.stringify({ id: "p-alive", command: "ping" }),
        )
        expect(pingRes).toMatchObject({ id: "p-alive", ok: true, status: "warm" })
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await primary.close()
            expect(fs.existsSync(primary.socketPath)).toBe(false)
            fs.rmSync(tmpDir, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it("daemon fails closed with DaemonServerError and unlinks socket when chmodSync fails", async () => {
    if (process.platform === "win32") {
      return
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-chmod-"))
    const socketPath = resolveDaemonSocketPath(tmpDir)
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      const err = Object.assign(new Error("EPERM: operation not permitted, chmod"), {
        code: "EPERM",
      })
      throw err
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await Effect.runPromise(
      Effect.promise(async () => {
        await expect(startHarnessDaemonServer(tmpDir)).rejects.toMatchObject({
          _tag: "DaemonServerError",
          socketPath,
        })
        expect(fs.existsSync(socketPath)).toBe(false)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            chmodSpy.mockRestore()
            stderrSpy.mockRestore()
            fs.rmSync(tmpDir, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it("runDefaultLspDiagnostics fails with ProjectPathEscapeError on escaping file/project and fails MCP callTool with isError: true", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..")
    for (const badInput of [
      { file: "../outside-file.ts" },
      { project: "../outside-tsconfig.json" },
    ]) {
      const exit = await Effect.runPromiseExit(runDefaultLspDiagnostics(repoRoot, badInput))
      match(exit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasDies(cause)).toBe(false)
          expect(Cause.hasFails(cause)).toBe(true)
          const errorOpt = Cause.findErrorOption(cause)
          match(errorOpt)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(ProjectPathEscapeError)
              expect(value._tag).toBe("ProjectPathEscapeError")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected ProjectPathEscapeError in cause")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected runDefaultLspDiagnostics to fail on path escape")
        })
        .exhaustive()
    }

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const srv = createServer({ repoRoot })
    const client = new Client({ name: "escape-test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await srv.connect(serverTransport)
    await client.connect(clientTransport)
    await Effect.runPromise(
      Effect.promise(async () => {
        const res = await client.callTool({
          name: "harness_lsp_diagnostics",
          arguments: { file: "../outside-file.ts" },
        })
        expect(res.isError).toBe(true)
        const firstBlock = Array.isArray(res.content) ? res.content[0] : undefined
        expect(firstBlock?.type).toBe("text")
        if (firstBlock?.type === "text") {
          expect(firstBlock.text).toContain("escapes repository root")
        }
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await client.close()
            await srv.close()
          }),
        ),
      ),
    )
  })

  it("resolveGraphWithStatus re-throws unexpected defects via Cause.hasDies while logging to stderr", async () => {
    const tmpSnap = path.join(os.tmpdir(), `defect-snap-${Date.now()}.json`)
    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
      if (target === tmpSnap) {
        throw new Error("Simulated fs defect")
      }
      return false
    })

    await Effect.runPromise(
      Effect.promise(async () => {
        const exit = await Effect.runPromiseExit(resolveGraphWithStatus({ snapshotPath: tmpSnap }))
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(true)
            expect(stderrChunks.join("")).toContain(
              "[harness-mcp] Unexpected defect resolving graph: Simulated fs defect",
            )
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected resolveGraphWithStatus to die on unexpected defect")
          })
          .exhaustive()
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            existsSpy.mockRestore()
            stderrSpy.mockRestore()
          }),
        ),
      ),
    )
  })

  it("normalizeProjectPath fails with typed ProjectPathEscapeError without dying", async () => {
    const repoRoot = "/tmp/harness-mcp-normalize-root"
    const exit = await Effect.runPromiseExit(
      normalizeProjectPath(repoRoot, "../outside/tsconfig.json"),
    )
    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(false)
        expect(Cause.hasFails(cause)).toBe(true)
        const errorOpt = Cause.findErrorOption(cause)
        match(errorOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(ProjectPathEscapeError)
            expect(value).toMatchObject({
              _tag: "ProjectPathEscapeError",
              projectPath: "../outside/tsconfig.json",
              repoRoot,
            })
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected ProjectPathEscapeError in cause")
          })
          .exhaustive()
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected normalizeProjectPath to fail with ProjectPathEscapeError")
      })
      .exhaustive()
  })

  it("resolveDefaultRepoRoot honors args.repoRoot, args.file, args.project and recordMcpToolTelemetry handles ok outcome and write failures", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-telemetry-"))
    const readOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-telemetry-ro-"))
    Effect.runSync(
      Effect.sync(() => {
        fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "")
        const nestedDir = path.join(tmpDir, "libs", "nested")
        fs.mkdirSync(nestedDir, { recursive: true })
        const nestedFile = path.join(nestedDir, "index.ts")
        const nestedTsconfig = path.join(nestedDir, "tsconfig.json")
        fs.writeFileSync(nestedFile, "export const n = 1\n", "utf-8")
        fs.writeFileSync(nestedTsconfig, "{}\n", "utf-8")

        expect(resolveDefaultRepoRoot({ repoRoot: nestedDir })).toBe(tmpDir)
        expect(resolveDefaultRepoRoot({ file: nestedFile })).toBe(tmpDir)
        expect(resolveDefaultRepoRoot({ project: nestedTsconfig })).toBe(tmpDir)

        recordMcpToolTelemetry(
          "harness_lsp_diagnostics",
          { repoRoot: tmpDir },
          { clean: false },
          15,
          { repoRoot: tmpDir },
        )
        recordMcpToolTelemetry(
          "harness_resolve",
          { repoRoot: tmpDir },
          { spanName: "Sample.greet" },
          7,
          { repoRoot: tmpDir },
        )

        const events = readTelemetryEvents(tmpDir, nodeSyncHostIo)
        expect(events).toHaveLength(2)
        expect(events[0]).toMatchObject({
          surface: "mcp",
          category: "gate",
          toolName: "harness_lsp_diagnostics",
          outcome: "fail",
          durationMs: 15,
          engineSource: "local",
        })
        expect(events[1]).toMatchObject({
          surface: "mcp",
          category: "graph_query",
          toolName: "harness_resolve",
          outcome: "ok",
          durationMs: 7,
          engineSource: "local",
        })

        // Write-failure resilience: .harness is a regular file so mkdir/append fails safely
        fs.writeFileSync(path.join(readOnlyRoot, ".harness"), "blocker-file", "utf-8")
        expect(() =>
          recordMcpToolTelemetry(
            "harness_resolve",
            { repoRoot: readOnlyRoot },
            { spanName: "Sample.greet" },
            4,
            { repoRoot: readOnlyRoot },
          ),
        ).not.toThrow()
        expect(readTelemetryEvents(readOnlyRoot, nodeSyncHostIo)).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true })
            fs.rmSync(readOnlyRoot, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it("harness_lsp_diagnostics logs to stderr and returns [lsp-exception] when lspDiagnosticsRunner throws or runDefaultLspDiagnostics hits a defect", async () => {
    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })

    await Effect.runPromise(
      Effect.promise(async () => {
        const res = (await executeTool(
          "harness_lsp_diagnostics",
          { file: "libs/sample/domain/src/index.ts" },
          {
            repoRoot: process.cwd(),
            lspDiagnosticsRunner: () => {
              throw new Error("Simulated LSP runner throw")
            },
          },
        )) as {
          readonly clean: boolean
          readonly diagnostics: ReadonlyArray<unknown>
          readonly summary: { readonly errors: number; readonly messages: number }
        }
        expect(res.clean).toBe(false)
        expect(res.summary.errors).toBe(1)
        expect(res.summary.messages).toBe(1)
        expect(String(res.diagnostics[0])).toContain("[lsp-exception]")
        expect(String(res.diagnostics[0])).toContain("Simulated LSP runner throw")
        expect(stderrChunks.join("")).toContain(
          "[harness-mcp] LSP diagnostics error: Simulated LSP runner throw",
        )

        const repoRoot = path.resolve(import.meta.dirname, "../../..")
        const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
          throw new Error("Simulated stat defect")
        })
        await Effect.runPromise(
          Effect.promise(async () => {
            const defectRes = await Effect.runPromise(
              runDefaultLspDiagnostics(repoRoot, { project: "tsconfig.base.json" }),
            )
            expect(defectRes.clean).toBe(false)
            expect(defectRes.summary.errors).toBe(1)
            expect(String(defectRes.diagnostics[0])).toContain("[lsp-exception]")
            expect(String(defectRes.diagnostics[0])).toContain("Simulated stat defect")
            expect(stderrChunks.join("")).toContain(
              "[harness-mcp] LSP diagnostics defect: Simulated stat defect",
            )
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                statSpy.mockRestore()
              }),
            ),
          ),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stderrSpy.mockRestore()
          }),
        ),
      ),
    )
  })

  it("daemon rejects non-socket file with DaemonServerError reasonKind not-a-socket", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-daemon-nonsocket-"))
    const socketPath = resolveDaemonSocketPath(tmpDir)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    fs.writeFileSync(socketPath, "not-a-socket", "utf8")

    try {
      await expect(startHarnessDaemonServer(tmpDir)).rejects.toMatchObject({
        _tag: "DaemonServerError",
        reasonKind: "not-a-socket",
        socketPath,
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("F-8.1 / F-12.1: harness_graph_infer surfaces degraded status on missing snapshot and isPureInterruptCause preserves composite causes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-degraded-"))
    try {
      const inferRes = (await executeTool(
        "harness_graph_infer",
        { repoRoot: tmpDir },
        { repoRoot: tmpDir },
      )) as { readonly degraded: boolean; readonly degradedReason?: string }
      expect(inferRes.degraded).toBe(true)
      expect(inferRes.degradedReason).toBe("missing-graph-snapshot")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    expect(isPureInterruptCause(Cause.interrupt(1))).toBe(true)
    expect(
      isPureInterruptCause(Cause.combine(Cause.fail(new Error("err")), Cause.interrupt(1))),
    ).toBe(false)
  })

  it.each([
    { toolName: "harness_resolve", args: { symbolOrSpan: "Sample.greet" } },
    { toolName: "harness_callers", args: { symbolOrSpan: "Sample.greet" } },
    { toolName: "harness_callees", args: { symbolOrSpan: "Sample.greet" } },
    { toolName: "harness_tests_reaching", args: { symbolOrSpan: "Sample.greet" } },
    { toolName: "harness_ontology_why", args: { symbolOrSpan: "Sample.greet" } },
    { toolName: "harness_ontology_impact", args: { symbolOrSpan: "Sample.greet" } },
    {
      toolName: "harness_gq_query",
      args: { queryName: "resolve_effect_fn", params: { spanOrQualname: "Sample.greet" } },
    },
  ])(
    "I-7a: $toolName surfaces degraded=true and non-empty degradedReason when Omnigraph is unreachable and no fallback snapshot exists",
    async ({ toolName, args }) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-nav-degraded-"))
      try {
        const parsed = (await executeTool(
          toolName,
          { ...args, repoRoot: tmpDir },
          { repoRoot: tmpDir, skipOmnigraphSpawn: true },
        )) as { readonly degraded?: unknown; readonly degradedReason?: unknown }
        expect(parsed.degraded).toBe(true)
        expect(typeof parsed.degradedReason).toBe("string")
        expect((parsed.degradedReason as string).length).toBeGreaterThan(0)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  it("enforces bounded trimmed inputs on ontology and gq input schemas", () => {
    const decodeWhy = Schema.decodeUnknownSync(OntologyWhyInputSchema)
    const decodeImpact = Schema.decodeUnknownSync(OntologyImpactInputSchema)
    const decodeCheck = Schema.decodeUnknownSync(OntologyCheckInputSchema)
    const decodeGq = Schema.decodeUnknownSync(GqQueryInputSchema)

    expect(decodeWhy({ symbolOrSpan: "Sample.greet" })).toEqual({ symbolOrSpan: "Sample.greet" })
    expect(decodeWhy({ symbolOrSpan: "a".repeat(512), repoRoot: "b".repeat(1024) })).toEqual({
      symbolOrSpan: "a".repeat(512),
      repoRoot: "b".repeat(1024),
    })

    expect(decodeImpact({ symbolOrSpan: "Sample.greet", repoRoot: "/tmp/repo" })).toEqual({
      symbolOrSpan: "Sample.greet",
      repoRoot: "/tmp/repo",
    })

    expect(decodeCheck({})).toEqual({})
    expect(decodeCheck({ scope: "s".repeat(128), repoRoot: "r".repeat(1024) })).toEqual({
      scope: "s".repeat(128),
      repoRoot: "r".repeat(1024),
    })

    const maxParams: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`k${i}`, i]),
    )
    expect(
      decodeGq({
        queryName: "resolve_effect_fn",
        params: maxParams,
        branch: "b".repeat(256),
        repoRoot: "r".repeat(1024),
      }),
    ).toEqual({
      queryName: "resolve_effect_fn",
      params: maxParams,
      branch: "b".repeat(256),
      repoRoot: "r".repeat(1024),
    })

    for (const invalidTarget of [
      { symbolOrSpan: "" },
      { symbolOrSpan: "   " },
      { symbolOrSpan: " Sample.greet" },
      { symbolOrSpan: "Sample.greet " },
      { symbolOrSpan: "a".repeat(513) },
      { symbolOrSpan: "Sample.greet", repoRoot: "" },
      { symbolOrSpan: "Sample.greet", repoRoot: "   " },
      { symbolOrSpan: "Sample.greet", repoRoot: " /tmp/repo" },
      { symbolOrSpan: "Sample.greet", repoRoot: "/tmp/repo " },
      { symbolOrSpan: "Sample.greet", repoRoot: "r".repeat(1025) },
    ]) {
      expect(() => decodeWhy(invalidTarget)).toThrow()
      expect(() => decodeImpact(invalidTarget)).toThrow()
    }

    for (const invalidCheck of [
      { scope: "" },
      { scope: "   " },
      { scope: " sample" },
      { scope: "sample " },
      { scope: "s".repeat(129) },
      { repoRoot: "" },
      { repoRoot: "   " },
      { repoRoot: " /tmp/repo" },
      { repoRoot: "r".repeat(1025) },
    ]) {
      expect(() => decodeCheck(invalidCheck)).toThrow()
    }

    const tooManyParams: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`k${i}`, i]),
    )
    for (const invalidGq of [
      { queryName: "" },
      { queryName: "   " },
      { queryName: " resolve_effect_fn" },
      { queryName: "q".repeat(16_385) },
      { queryName: "resolve_effect_fn", branch: "" },
      { queryName: "resolve_effect_fn", branch: "   " },
      { queryName: "resolve_effect_fn", branch: " main" },
      { queryName: "resolve_effect_fn", branch: "main " },
      { queryName: "resolve_effect_fn", branch: "b".repeat(257) },
      { queryName: "resolve_effect_fn", repoRoot: "" },
      { queryName: "resolve_effect_fn", repoRoot: "   " },
      { queryName: "resolve_effect_fn", repoRoot: " /tmp/repo" },
      { queryName: "resolve_effect_fn", repoRoot: "r".repeat(1025) },
      { queryName: "resolve_effect_fn", params: tooManyParams },
      { queryName: "resolve_effect_fn", params: { "": "v" } },
      { queryName: "resolve_effect_fn", params: { "   ": "v" } },
      { queryName: "resolve_effect_fn", params: { " key": "v" } },
      { queryName: "resolve_effect_fn", params: { "key ": "v" } },
      { queryName: "resolve_effect_fn", params: { ["k".repeat(129)]: "v" } },
    ]) {
      expect(() => decodeGq(invalidGq)).toThrow()
    }
  })

  it("exposes harness_search_knowledge and harness_doc_tree over InMemoryTransport wire protocol", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")

    const graph = buildHarnessGraph({
      adrDocs: [
        {
          id: "harness:ADR-0025",
          title: "Three-Tier Retrieval",
          status: "accepted",
          path: "libs/harness/docs/adr/0025-three-tier-retrieval-embeddings-and-pageindex-lite.md",
          enforcedByFiles: [],
          searchText: "Selective embeddings and PageIndex-lite tree inspection",
          summary: "Selective embeddings and PageIndex-lite",
        },
      ],
    })
    const unavailableEmbedLayer = Layer.succeed(
      EmbeddingClient,
      EmbeddingClient.of({
        config: {
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:1/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
        },
        checkAvailability: Effect.succeed({
          _tag: "Unavailable" as const,
          cause: "network-error" as const,
          reason: ErrorReasonMessage.make("Ollama offline in test"),
        }),
        embedBatch: () => Effect.succeed([]),
        embedQuery: () => Effect.die("unused"),
      }),
    )

    const srv = createServer({
      repoRoot: path.resolve(import.meta.dirname, "../../.."),
      graph,
      skipTelemetry: true,
      skipOmnigraphSpawn: true,
      embeddingClientLayer: unavailableEmbedLayer,
    })
    const client = new Client({ name: "retrieval-wire-test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await srv.connect(serverTransport)
    await client.connect(clientTransport)
    await Effect.runPromise(
      Effect.promise(async () => {
        const listed = await client.listTools()
        const names = listed.tools.map((t) => t.name)
        expect(names).toContain("harness_search_knowledge")
        expect(names).toContain("harness_doc_tree")

        const searchCall = await client.callTool({
          name: "harness_search_knowledge",
          arguments: { query: "PageIndex-lite", limit: 3 },
        })
        expect(searchCall.isError).not.toBe(true)
        const searchBlock = Array.isArray(searchCall.content) ? searchCall.content[0] : undefined
        expect(searchBlock?.type).toBe("text")
        if (searchBlock?.type === "text") {
          const parsed = JSON.parse(searchBlock.text) as {
            readonly retrievalMode: string
            readonly hits: ReadonlyArray<{ readonly nodeKey: string }>
          }
          expect(parsed.retrievalMode).toBe("lexical-fallback")
          expect(parsed.hits.map((h) => h.nodeKey)).toContain("AdrDoc:harness:ADR-0025")
        }

        const docTreeCall = await client.callTool({
          name: "harness_doc_tree",
          arguments: {
            mode: "tree",
            path: "libs/harness/docs/adr/0025-three-tier-retrieval-embeddings-and-pageindex-lite.md",
          },
        })
        expect(docTreeCall.isError).not.toBe(true)
        const treeBlock = Array.isArray(docTreeCall.content) ? docTreeCall.content[0] : undefined
        expect(treeBlock?.type).toBe("text")
        if (treeBlock?.type === "text") {
          const parsedTree = JSON.parse(treeBlock.text) as {
            readonly _tag: string
            readonly sections: ReadonlyArray<{ readonly sectionId: string }>
          }
          expect(parsedTree._tag).toBe("DocumentTree")
          expect(parsedTree.sections.length).toBeGreaterThan(0)
        }

        const escapeCall = await client.callTool({
          name: "harness_doc_tree",
          arguments: { mode: "catalog", repoRoot: "/outside/root" },
        })
        expect(escapeCall.isError).toBe(true)
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await client.close()
            await srv.close()
          }),
        ),
      ),
    )
  })
})
