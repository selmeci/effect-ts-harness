import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Cause, Effect, Layer, Option } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as AiError from "effect/ai/AiError"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph, saveGraphSnapshot } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { match } from "ts-pattern"
import {
  CANONICAL_MCP_TOOL_NAMES,
  createServer,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
} from "../src/server.js"
import { executeTool } from "./execute-tool-helper.js"
import { McpToolInputName } from "../src/tools/tool-registry.js"
import { sampleMcpGraph } from "./helpers/server-fixture.js"

describe("harness-mcp core tools, search, routing & snapshot loading", () => {
  const graph = sampleMcpGraph

  it("resolves EffectFn node and tests_reaching from the graph snapshot", async () => {
    const srv = createServer({ graph })
    expect(typeof srv.connect).toBe("function")
    expect(typeof srv.close).toBe("function")
    const resolved = await executeTool(
      "harness_resolve",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(resolved).toMatchObject({
      degraded: false,
      node: {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
      },
    })

    const tests = await executeTool(
      "harness_tests_reaching",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(tests).toMatchObject({
      degraded: false,
      tests: [
        expect.objectContaining({
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
        }),
      ],
    })
  })

  it("queries callers and callees correctly", async () => {
    const callers = await executeTool(
      "harness_callers",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(callers).toMatchObject({
      degraded: false,
      callers: expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/service/src/index.ts#callGreet",
          edgeKind: "TracedCall",
        }),
        expect.objectContaining({
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          edgeKind: "ExercisesSpan",
        }),
      ]),
    })

    const callees = await executeTool(
      "harness_callees",
      { symbolOrSpan: "libs/sample/service/src/index.ts#callGreet" },
      { graph },
    )
    expect(callees).toMatchObject({
      degraded: false,
      callees: expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/domain/src/index.ts#greet",
          edgeKind: "TracedCall",
        }),
        expect.objectContaining({
          tagId: "libs/sample/service/src/index.ts#Greeter",
          edgeKind: "RequiresService",
        }),
      ]),
    })
  })

  it("executes structural search across workspace files", async () => {
    const results = (await executeTool(
      "harness_structural_search",
      { pattern: "export const decideAlbumQuota = $$$" },
      { graph },
    )) as Array<{ file: string; text: string }>

    expect(Array.isArray(results)).toBe(true)
    expect(results.some((r) => r.file.includes("libs/sample/domain/src/index.ts"))).toBe(true)
  })

  it("executes structural search with filePath scoped to .ts file", async () => {
    const results = (await executeTool(
      "harness_structural_search",
      {
        pattern: "export const decideAlbumQuota = $$$",
        filePath: "libs/sample/domain/src/index.ts",
      },
      { graph },
    )) as Array<{ file: string; line: number; text: string }>

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(1)
    expect(results[0]?.file).toBe("libs/sample/domain/src/index.ts")
    expect(results[0]?.line).toBe(13)
  })

  it("executes structural search with filePath scoped to .md file", async () => {
    const results = (await executeTool(
      "harness_structural_search",
      {
        pattern: "ADR-0001",
        filePath: "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
      },
      { graph },
    )) as Array<{ file: string; line: number; text: string }>

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
    expect(
      results.every(
        (r) =>
          r.file ===
          "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
      ),
    ).toBe(true)
    expect(results[0]?.text).toContain("ADR-0001")
  })

  it("rejects path-traversal search and returns empty array", async () => {
    const filePathResults = (await executeTool(
      "harness_structural_search",
      {
        pattern: "export const",
        filePath: "../outside.ts",
      },
      { graph },
    )) as Array<unknown>

    expect(filePathResults).toEqual([])

    const pathsResults = (await executeTool(
      "harness_structural_search",
      {
        pattern: "export const",
        paths: ["../../outside.ts"],
      },
      { graph },
    )) as Array<unknown>

    expect(pathsResults).toEqual([])

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-outside-"))
    const outsideFile = path.join(outsideDir, "profiles.json")
    fs.writeFileSync(outsideFile, '{"secret":"CLOUDFLARE_TOKEN"}\n', "utf-8")
    try {
      const externalAbsResults = (await executeTool(
        "harness_structural_search",
        {
          pattern: "CLOUDFLARE_TOKEN",
          filePath: outsideFile,
        },
        { graph },
      )) as Array<unknown>
      expect(externalAbsResults).toEqual([])
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  const makeMockDecisionModel = (
    outcome:
      | { readonly fitsAny: number; readonly block: string }
      | { readonly error: AiError.AiError },
  ): DecisionModel.DecisionModel =>
    Effect.runSync(
      DecisionModel.make({
        decide: (options) => {
          if ("error" in outcome) {
            return Effect.fail(outcome.error)
          }
          const answers: Record<string, DecisionModel.ProviderAnswer> = {}
          for (const [key, decision] of Object.entries(options.decisions)) {
            match(decision)
              .with({ _tag: "Probability" }, () => {
                answers[key] = {
                  _tag: "Probability",
                  probability: key === "fitsAny" ? outcome.fitsAny : 0.9,
                }
              })
              .with({ _tag: "Classify" }, (d) => {
                const labels = Object.keys(d.criteria)
                const chosen = key === "block" ? outcome.block : (labels[0] ?? "")
                const probabilities: Record<string, number> = {}
                for (const l of labels) {
                  probabilities[l] = l === chosen ? 1 : 0
                }
                answers[key] = {
                  _tag: "Classify",
                  label: chosen,
                  probabilities,
                }
              })
              .with({ _tag: "Rate" }, () => {
                throw new Error("Unexpected Rate decision")
              })
              .exhaustive()
          }
          return Effect.succeed({
            answers,
            usage: { inputTokens: 5, outputTokens: 5 },
          })
        },
      }),
    )

  it("routes plan step with mock decisionLayer", async () => {
    const mockModel = makeMockDecisionModel({
      fitsAny: 0.95,
      block: "services-and-layers",
    })
    const decisionLayer = Layer.succeed(DecisionModel.DecisionModel, mockModel)

    const routed = await executeTool(
      "harness_route",
      { planStep: "Define a Greeter service" },
      { decisionLayer },
    )
    expect(routed).toMatchObject({
      block: "services-and-layers",
      patternFile: "agent-patterns/services-and-layers.md",
      source: "model",
    })
  })

  it("routes plan step to null patternFile for effect or review", async () => {
    const effectModel = makeMockDecisionModel({
      fitsAny: 0.95,
      block: "effect",
    })
    const effectLayer = Layer.succeed(DecisionModel.DecisionModel, effectModel)

    const routedEffect = await executeTool(
      "harness_route",
      { planStep: "Simple effect calculation" },
      { decisionLayer: effectLayer },
    )
    expect(routedEffect).toMatchObject({
      block: "effect",
      patternFile: null,
      source: "model",
    })

    const reviewModel = makeMockDecisionModel({
      fitsAny: 0.4,
      block: "services-and-layers",
    })
    const reviewLayer = Layer.succeed(DecisionModel.DecisionModel, reviewModel)

    const routedReview = await executeTool(
      "harness_route",
      { planStep: "Ambiguous vague task" },
      { decisionLayer: reviewLayer },
    )
    expect(routedReview).toMatchObject({
      block: "review",
      patternFile: null,
      source: "model",
    })
  })

  it("handles offline or failing decisionLayer gracefully", async () => {
    const failingModel = makeMockDecisionModel({
      error: AiError.make({
        module: "DecisionModel",
        method: "decide",
        reason: new AiError.UnknownError({ description: "Connection refused to Ollama" }),
      }),
    })
    const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)

    const routed = await executeTool(
      "harness_route",
      { planStep: "Any step" },
      { decisionLayer: failingLayer },
    )
    expect(routed).toMatchObject({
      block: "review",
      patternFile: null,
      source: "degraded-fallback",
    })
  })

  it("dynamically falls back to agent-patterns files when routed to review", async () => {
    const failingModel = makeMockDecisionModel({
      error: AiError.make({
        module: "DecisionModel",
        method: "decide",
        reason: new AiError.UnknownError({ description: "Connection refused to Ollama" }),
      }),
    })
    const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)

    const routed = await executeTool(
      "harness_route",
      { planStep: "event sourcing decider core" },
      { decisionLayer: failingLayer },
    )
    expect(routed).toMatchObject({
      block: "event-sourcing",
      patternFile: "agent-patterns/event-sourcing.md",
      source: "deterministic",
    })
  })

  it("falls back gracefully when snapshot file does not exist (offline fallback)", async () => {
    const nonExistentPath = path.join(os.tmpdir(), `non-existent-${Date.now()}.json`)
    const resolved = await executeTool(
      "harness_resolve",
      { symbolOrSpan: "NonExistent" },
      { snapshotPath: nonExistentPath },
    )
    expect(resolved).toMatchObject({
      node: null,
      degraded: true,
      degradedReason: "missing-graph-snapshot",
    })

    const tests = await executeTool(
      "harness_tests_reaching",
      { symbolOrSpan: "NonExistent" },
      { snapshotPath: nonExistentPath },
    )
    expect(tests).toMatchObject({
      tests: [],
      degraded: true,
      degradedReason: "missing-graph-snapshot",
    })
  })

  it("resolves reaching tests from disk snapshot when snapshotPath is provided", async () => {
    const tempSnapshotPath = path.join(os.tmpdir(), `test-snapshot-${Date.now()}.json`)
    try {
      saveGraphSnapshot(graph, tempSnapshotPath, nodeSyncHostIo)
      const tests = await executeTool(
        "harness_tests_reaching",
        { symbolOrSpan: "Sample.greet" },
        { snapshotPath: tempSnapshotPath },
      )
      expect(tests).toMatchObject({
        degraded: false,
        tests: [
          expect.objectContaining({
            testId: "libs/sample/domain/test/index.test.ts::greets by name",
          }),
        ],
      })
    } finally {
      if (fs.existsSync(tempSnapshotPath)) {
        fs.unlinkSync(tempSnapshotPath)
      }
    }
  })

  it("rejects unknown tools", async () => {
    const exit = await Effect.runPromiseExit(
      dispatchMcpTool({
        toolName: McpToolInputName.make("unknown_tool"),
        args: {},
      }).pipe(Effect.provide(makeLiveMcpToolRegistryLayer(undefined))),
    )
    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(false)
        expect(Cause.hasFails(cause)).toBe(true)
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
        expect(failure).toMatchObject({
          _tag: "UnknownToolError",
          toolName: "unknown_tool",
        })
      })
      .with({ _tag: "Success" }, () => {
        throw new Error("Expected dispatchMcpTool('unknown_tool') to fail")
      })
      .exhaustive()
  })

  it("completes MCP stdio handshake and lists registered tools when spawned from Antigravity plugin directory", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
    const repoRoot = path.resolve(import.meta.dirname, "../../..")
    const pluginDir = path.join(repoRoot, "adapters/antigravity/plugins/effect-harness")
    const mcpConfig = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "mcp_config.json"), "utf8"),
    ) as {
      readonly mcpServers: {
        readonly "harness-mcp": { readonly command: string; readonly args: Array<string> }
      }
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: mcpConfig.mcpServers["harness-mcp"].args,
      cwd: pluginDir,
    })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    try {
      await client.connect(transport)
      const toolsList = await client.listTools()
      expect(toolsList.tools.map((t) => t.name)).toEqual([...CANONICAL_MCP_TOOL_NAMES])
    } finally {
      await client.close()
    }
  })

  it("executes harness_graph_infer and harness_graph_complete over the PERA hypergraph", async () => {
    const inferRes = (await executeTool(
      "harness_graph_infer",
      { symbolOrSpan: "Sample.callGreet" },
      { graph },
    )) as {
      readonly effectiveRequires: ReadonlyArray<{
        readonly callerKey: string
        readonly serviceKey: string
      }>
      readonly proofs: ReadonlyArray<{ readonly ruleId: string }>
    }
    expect(inferRes).toMatchObject({
      effectiveRequires: expect.arrayContaining([
        expect.objectContaining({
          callerKey: "EffectFn:libs/sample/service/src/index.ts#callGreet",
          serviceKey: "ServiceTag:libs/sample/service/src/index.ts#Greeter",
        }),
      ]),
    })
    expect(inferRes.proofs.length).toBeGreaterThan(0)
    expect(inferRes.proofs.some((p) => p.ruleId === "INF-01")).toBe(true)

    const completeRes = (await executeTool(
      "harness_graph_complete",
      { minConfidenceMillis: 800, ruleId: "COMP-03" },
      { graph },
    )) as {
      readonly suggestedEdges: ReadonlyArray<{
        readonly ruleId: string
        readonly role: string
        readonly targetEntityKey: string
      }>
      readonly proofs: ReadonlyArray<{ readonly ruleId: string }>
    }
    expect(completeRes).toMatchObject({
      suggestedEdges: expect.arrayContaining([
        expect.objectContaining({
          ruleId: "COMP-03",
          role: "provided-service",
          targetEntityKey: "ServiceTag:libs/sample/service/src/index.ts#Greeter",
        }),
      ]),
    })
    expect(completeRes.suggestedEdges.every((e) => e.ruleId === "COMP-03")).toBe(true)
    expect(completeRes.proofs.every((p) => p.ruleId === "COMP-03")).toBe(true)

    const filteredOutRes = (await executeTool(
      "harness_graph_complete",
      { minConfidenceMillis: 950, ruleId: "COMP-03" },
      { graph },
    )) as {
      readonly suggestedEdges: ReadonlyArray<unknown>
    }
    expect(filteredOutRes.suggestedEdges).toHaveLength(0)
  })

  it("executes harness_graph_complete with useDecisionPriors: true to evaluate priors and return suggestedEdges and typedHoleBundles", async () => {
    const graphWithHole = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/cart.ts#addItem",
          spanName: "Cart.addItem",
          file: "libs/sample/domain/src/cart.ts",
          line: 10,
          packageTag: "domain",
          successType: "CartUpdated",
          isStub: true,
        },
        {
          qualname: "libs/sample/domain/src/cart.ts#decide",
          spanName: "Cart.decide",
          file: "libs/sample/domain/src/cart.ts",
          line: 25,
          packageTag: "domain",
          successType: "CartEvent",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "libs/sample/service/src/cart-repo.ts#CartRepo",
          name: "CartRepo",
          packageTag: "service",
          file: "libs/sample/service/src/cart-repo.ts",
        },
      ],
      errors: [
        {
          errorTag: "CartLimitExceededError",
          file: "libs/sample/contract/src/errors.ts",
        },
      ],
      schemas: [
        {
          schemaName: "CartItemId",
          file: "libs/sample/contract/src/schemas.ts",
          isBranded: true,
        },
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/cart.ts#addItem",
          tagId: "libs/sample/service/src/cart-repo.ts#CartRepo",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/cart.ts#addItem",
          errorTag: "CartLimitExceededError",
        },
      ],
    })

    const completeWithPriorsRes = (await executeTool(
      "harness_graph_complete",
      { useDecisionPriors: true },
      {
        graph: graphWithHole,
        decisionLayer: makeMockDecisionModelLayer({
          edgeConfidenceProb: 0.95,
          candidateRelevanceLabel: "essential",
        }),
      },
    )) as {
      readonly suggestedEdges: ReadonlyArray<{
        readonly ruleId: string
        readonly targetEntityKey: string
      }>
      readonly typedHoleBundles: ReadonlyArray<{
        readonly holeQualname: string
        readonly spanName: string
        readonly requiredServiceCapabilities: ReadonlyArray<string>
      }>
    }

    expect(completeWithPriorsRes).toBeDefined()
    expect(Array.isArray(completeWithPriorsRes.suggestedEdges)).toBe(true)
    expect(Array.isArray(completeWithPriorsRes.typedHoleBundles)).toBe(true)
    expect(completeWithPriorsRes.typedHoleBundles.length).toBeGreaterThan(0)
    expect(completeWithPriorsRes.typedHoleBundles[0]?.spanName).toBe("Cart.addItem")
    expect(
      completeWithPriorsRes.typedHoleBundles[0]?.requiredServiceCapabilities.some((s) =>
        s.includes("CartRepo"),
      ),
    ).toBe(true)
  })

  it("automatically loads plan-graph-snapshot.json when graph-snapshot.json is absent or older, and honours args.repoRoot", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-plan-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "")
      const harnessDir = path.join(tmpDir, ".harness")
      fs.mkdirSync(harnessDir, { recursive: true })

      const planGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#planFn",
            spanName: "Sample.planFn",
            file: "libs/sample/domain/src/index.ts",
            line: 1,
            packageTag: "domain",
            successType: "string",
            isStub: false,
          },
        ],
      })
      const verifyGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#verifyFn",
            spanName: "Sample.verifyFn",
            file: "libs/sample/domain/src/index.ts",
            line: 1,
            packageTag: "domain",
            successType: "string",
            isStub: false,
          },
        ],
      })

      const planPath = path.join(harnessDir, "plan-graph-snapshot.json")
      const verifyPath = path.join(harnessDir, "graph-snapshot.json")

      // 1. Case A: graph-snapshot.json is absent, plan-graph-snapshot.json is present
      saveGraphSnapshot(planGraph, planPath, nodeSyncHostIo)
      const resPlanOnly = await executeTool("harness_resolve", {
        symbolOrSpan: "Sample.planFn",
        repoRoot: tmpDir,
      })
      expect(resPlanOnly).toMatchObject({
        degraded: false,
        node: {
          spanName: "Sample.planFn",
        },
      })

      // 2. Case B: graph-snapshot.json exists, but plan-graph-snapshot.json is newer
      saveGraphSnapshot(verifyGraph, verifyPath, nodeSyncHostIo)
      const past = new Date(Date.now() - 100000)
      const now = new Date()
      fs.utimesSync(verifyPath, past, past)
      fs.utimesSync(planPath, now, now)

      const resNewerPlan = await executeTool("harness_resolve", {
        symbolOrSpan: "Sample.planFn",
        repoRoot: tmpDir,
      })
      expect(resNewerPlan).toMatchObject({
        degraded: false,
        node: {
          spanName: "Sample.planFn",
        },
      })

      // 3. Case C: graph-snapshot.json is updated to be newer than plan-graph-snapshot.json
      const future = new Date(Date.now() + 100000)
      fs.utimesSync(verifyPath, future, future)

      const resNewerVerify = await executeTool("harness_resolve", {
        symbolOrSpan: "Sample.verifyFn",
        repoRoot: tmpDir,
      })
      expect(resNewerVerify).toMatchObject({
        degraded: false,
        node: {
          spanName: "Sample.verifyFn",
        },
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("executes harness_gq_query with custom repoRoot parameter", async () => {
    const res = await executeTool(
      "harness_gq_query",
      {
        queryName: "resolve_effect_fn",
        params: { spanOrQualname: "Sample.greet" },
        repoRoot: "/tmp/custom-repo",
      },
      { graph },
    )
    expect(res).toMatchObject({
      source: "memory-fallback",
      rows: expect.arrayContaining([
        expect.objectContaining({
          spanName: "Sample.greet",
        }),
      ]),
    })
  })

  it("handles corrupt snapshot gracefully with warning to stderr (not stdout) and falls back to empty graph", async () => {
    const corruptSnapshotPath = path.join(os.tmpdir(), `corrupt-snap-${Date.now()}.json`)
    const stderrChunks: Array<string> = []
    const stdoutChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    await Effect.runPromise(
      Effect.promise(async () => {
        fs.writeFileSync(corruptSnapshotPath, "{ invalid json content: true", "utf-8")
        const resolved = await executeTool(
          "harness_resolve",
          { symbolOrSpan: "Sample.greet" },
          { snapshotPath: corruptSnapshotPath },
        )
        expect(resolved).toMatchObject({
          node: null,
          degraded: true,
          degradedReason: "corrupt-graph-snapshot",
        })

        const tests = await executeTool(
          "harness_tests_reaching",
          { symbolOrSpan: "Sample.greet" },
          { snapshotPath: corruptSnapshotPath },
        )
        expect(tests).toMatchObject({
          tests: [],
          degraded: true,
          degradedReason: "corrupt-graph-snapshot",
        })

        const stderrOutput = stderrChunks.join("")
        const stdoutOutput = stdoutChunks.join("")
        expect(stderrOutput).toContain(
          `[harness-mcp] Failed to load graph snapshot from '${corruptSnapshotPath}'`,
        )
        expect(stdoutOutput).not.toContain("Failed to load graph snapshot")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stderrSpy.mockRestore()
            stdoutSpy.mockRestore()
            if (fs.existsSync(corruptSnapshotPath)) {
              fs.unlinkSync(corruptSnapshotPath)
            }
          }),
        ),
      ),
    )
  })
})
