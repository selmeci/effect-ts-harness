import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it, vi } from "vitest"
import { Cause, Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { buildHarnessGraph } from "@harness/graph"
import { createServer, executeToolEffect, isPathInsideRoot } from "../src/server.js"

describe("PR #28 harness-mcp fixes (F-6.1, F-20.1b)", () => {
  const stubGraph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#pendingFn",
        spanName: "Sample.pendingFn",
        file: "libs/sample/domain/src/index.ts",
        line: 5,
        packageTag: "domain",
        successType: "string",
        isStub: true,
      },
      {
        qualname: "libs/sample/domain/src/index.ts#helperFn",
        spanName: "Sample.helperFn",
        file: "libs/sample/domain/src/index.ts",
        line: 12,
        packageTag: "domain",
        successType: "string",
        isStub: false,
      },
    ],
    services: [
      {
        tagId: "SampleService",
        name: "SampleService",
        packageTag: "service",
        file: "libs/sample/service/src/index.ts",
      },
    ],
  })

  it("F-6.1: harness_route and harness_impact_stub log defect cause to stderr and propagate fiber interrupts", async () => {
    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })

    try {
      const dyingDecisionLayer = Layer.effect(
        DecisionModel.DecisionModel,
        Effect.die(new Error("boom-decision-defect")),
      )

      const routeResult = (await Effect.runPromise(
        executeToolEffect(
          "harness_route",
          { planStep: "some arbitrary step" },
          {
            graph: stubGraph,
            decisionLayer: dyingDecisionLayer,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly block: string }
      expect(routeResult.block).toBe("review")
      expect(
        stderrChunks.some((line) => line.includes("[harness-mcp] decision fallback:")),
      ).toBe(true)

      stderrChunks.length = 0
      const completeResult = (await Effect.runPromise(
        executeToolEffect(
          "harness_graph_complete",
          { symbolOrSpan: "Sample.pendingFn", useDecisionPriors: true },
          {
            graph: stubGraph,
            decisionLayer: dyingDecisionLayer,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly suggestedEdges: ReadonlyArray<unknown> }
      expect(Array.isArray(completeResult.suggestedEdges)).toBe(true)
      expect(
        stderrChunks.some((line) => line.includes("[harness-mcp] decision fallback:")),
      ).toBe(true)

      const interruptDecisionLayer = Layer.effect(
        DecisionModel.DecisionModel,
        Effect.interrupt,
      )

      const routeExit = await Effect.runPromiseExit(
        executeToolEffect(
          "harness_route",
          { planStep: "interrupt step" },
          {
            graph: stubGraph,
            decisionLayer: interruptDecisionLayer,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )
      match(routeExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasInterrupts(cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected routeExit to be interrupted")
        })
        .exhaustive()

      const completeExit = await Effect.runPromiseExit(
        executeToolEffect(
          "harness_graph_complete",
          { symbolOrSpan: "Sample.pendingFn", useDecisionPriors: true },
          {
            graph: stubGraph,
            decisionLayer: interruptDecisionLayer,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )
      match(completeExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasInterrupts(cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected completeExit to be interrupted")
        })
        .exhaustive()
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("F-6.1: isPathInsideRoot blocks non-existent child paths under symlinks and dangling symlinks pointing outside repoRoot", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-root-"))
    const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-outside-"))
    try {
      const symlinkDir = path.join(tmpRoot, "escape-dir")
      fs.symlinkSync(tmpOutside, symlinkDir, "dir")
      expect(isPathInsideRoot(tmpRoot, path.join(symlinkDir, "nonexistent-child.ts"))).toBe(false)

      const danglingLink = path.join(tmpRoot, "dangling-link")
      fs.symlinkSync(path.join(tmpOutside, "does-not-exist"), danglingLink)
      expect(isPathInsideRoot(tmpRoot, danglingLink)).toBe(false)
      expect(isPathInsideRoot(tmpRoot, path.join(danglingLink, "nested.ts"))).toBe(false)

      const safeDir = path.join(tmpRoot, "safe-dir")
      fs.mkdirSync(safeDir, { recursive: true })
      expect(isPathInsideRoot(tmpRoot, path.join(safeDir, "future-file.ts"))).toBe(true)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      fs.rmSync(tmpOutside, { recursive: true, force: true })
    }
  })

  it("T-2: createServer disposes ManagedRuntime and runs scoped finalizers on close, rejecting subsequent calls", async () => {
    let finalizerRan = false
    const probeLayer = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalizerRan = true
        }),
      ),
    )

    const server = createServer({
      graph: stubGraph,
      extraLayer: probeLayer,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      skipActiveWorkspaceLookup: true,
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const beforeClose = await client.callTool({
      name: "harness_route",
      arguments: { planStep: "test" },
    })
    expect(beforeClose.isError).not.toBe(true)
    expect(finalizerRan).toBe(false)

    await server.close()
    await client.close()
    expect(finalizerRan).toBe(true)

    await expect(
      client.callTool({
        name: "harness_route",
        arguments: { planStep: "after-close" },
      }),
    ).rejects.toThrow()
  })

  it("T-1: ServerOptions.skipOmnigraphSpawn: true makes 0 HTTP requests while false queries local Omnigraph", async () => {
    const prevUrl = process.env["OMNIGRAPH_URL"]
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-t1-"))
    let requestCount = 0
    const fakeOmnigraph = http.createServer((_req, res) => {
      requestCount += 1
      res.statusCode = 503
      res.end("unavailable")
    })
    await new Promise<void>((resolveListen) => {
      fakeOmnigraph.listen(0, "127.0.0.1", () => resolveListen())
    })
    const addr = fakeOmnigraph.address()
    const port = typeof addr === "object" && addr !== null ? addr.port : 0
    try {
      delete process.env["OMNIGRAPH_URL"]
      const clusterDir = path.join(tmpRepo, ".harness", "omnigraph-cluster")
      fs.mkdirSync(clusterDir, { recursive: true })
      fs.writeFileSync(
        path.join(clusterDir, "server.json"),
        JSON.stringify({
          pid: process.pid,
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          canonicalRepoRoot: tmpRepo,
          updatedAt: null,
        }),
        "utf8",
      )

      const skipped = (await Effect.runPromise(
        executeToolEffect(
          "harness_gq_query",
          { queryName: "resolve_effect_fn", params: { spanName: "Sample.helperFn" } },
          {
            repoRoot: tmpRepo,
            graph: stubGraph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly source: string }
      expect(skipped.source).toBe("memory-fallback")
      expect(requestCount).toBe(0)

      const notSkipped = (await Effect.runPromise(
        executeToolEffect(
          "harness_gq_query",
          { queryName: "resolve_effect_fn", params: { spanName: "Sample.helperFn" } },
          {
            repoRoot: tmpRepo,
            graph: stubGraph,
            skipOmnigraphSpawn: false,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly source: string }
      expect(notSkipped.source).toBe("memory-fallback")
      expect(requestCount).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true })
      await new Promise<void>((resolveClose) => {
        fakeOmnigraph.close(() => resolveClose())
      })
      if (prevUrl === undefined) {
        delete process.env["OMNIGRAPH_URL"]
      } else {
        process.env["OMNIGRAPH_URL"] = prevUrl
      }
    }
  })
})
