import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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

  it("F-6.1: createServer disposes runtime when transport closes", async () => {
    const server = createServer({
      graph: stubGraph,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      skipActiveWorkspaceLookup: true,
    })

    const mockTransport: Parameters<typeof server.connect>[0] = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => undefined,
    }

    await server.connect(mockTransport)
    expect(typeof mockTransport.onclose).toBe("function")
    mockTransport.onclose?.()
    await server.close()
  })

  it("F-20.1b: ServerOptions.skipOmnigraphSpawn controls memory-fallback vs live OMNIGRAPH_URL", async () => {
    const prevUrl = process.env["OMNIGRAPH_URL"]
    try {
      delete process.env["OMNIGRAPH_URL"]
      const skipped = (await Effect.runPromise(
        executeToolEffect(
          "harness_gq_query",
          { queryName: "resolve_effect_fn", params: { spanName: "Sample.helperFn" } },
          {
            graph: stubGraph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly source: string }
      expect(skipped.source).toBe("memory-fallback")

      process.env["OMNIGRAPH_URL"] = "http://127.0.0.1:1"
      const notSkipped = (await Effect.runPromise(
        executeToolEffect(
          "harness_gq_query",
          { queryName: "resolve_effect_fn", params: { spanName: "Sample.helperFn" } },
          {
            graph: stubGraph,
            skipOmnigraphSpawn: false,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
          },
        ),
      )) as { readonly source: string }
      expect(notSkipped.source).toBe("memory-fallback")
    } finally {
      if (prevUrl === undefined) {
        delete process.env["OMNIGRAPH_URL"]
      } else {
        process.env["OMNIGRAPH_URL"] = prevUrl
      }
    }
  })
})
