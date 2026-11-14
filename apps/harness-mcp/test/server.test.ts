import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Cause, Data, Effect, Layer, Option } from "effect"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  }
})
import * as DecisionModel from "effect/ai/DecisionModel"
import * as AiError from "effect/ai/AiError"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph, saveGraphSnapshot } from "@harness/graph"
import { readTelemetryEvents } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { match } from "ts-pattern"
import {
  createServer,
  dispatchMcpTool,
  executeTool,
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
import { resolveGraph } from "../src/tools/mcp-helpers.js"
import { McpToolInputName } from "../src/tools/tool-registry.js"

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
          Effect.fail(
            new DaemonClientError({ message: "Daemon socket closed before response" }),
          ),
        )
      })
    }),
  )

const sendDaemonPayload = (
  socketPath: string,
  payload: string,
): Promise<Record<string, unknown>> => sendDaemonRawPayload(socketPath, payload + "\n")

describe("harness-mcp tools", () => {
  const graph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        successType: "string",
        isStub: false,
      },
      {
        qualname: "libs/sample/service/src/index.ts#callGreet",
        spanName: "Sample.callGreet",
        file: "libs/sample/service/src/index.ts",
        line: 10,
        packageTag: "service",
        successType: "string",
        isStub: false,
      },
    ],
    services: [
      {
        tagId: "libs/sample/service/src/index.ts#Greeter",
        name: "Greeter",
        file: "libs/sample/service/src/index.ts",
        packageTag: "service",
      },
    ],
    layers: [],
    errors: [],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "hash1",
      },
    ],
    patternDocs: [],
    requiresService: [
      {
        callerQualname: "libs/sample/service/src/index.ts#callGreet",
        tagId: "libs/sample/service/src/index.ts#Greeter",
      },
    ],
    failsWith: [],
    providesService: [],
    layerRequires: [],
    tracedCalls: [
      {
        callerQualname: "libs/sample/service/src/index.ts#callGreet",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 2,
        receiverLayer: null,
      },
    ],
    exercisesSpans: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 1,
        receiverLayer: null,
      },
    ],
  })

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
      qualname: "libs/sample/domain/src/index.ts#greet",
      spanName: "Sample.greet",
    })

    const tests = await executeTool(
      "harness_tests_reaching",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(tests).toEqual([
      expect.objectContaining({
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
      }),
    ])
  })

  it("queries callers and callees correctly", async () => {
    const callers = await executeTool(
      "harness_callers",
      { symbolOrSpan: "Sample.greet" },
      { graph },
    )
    expect(callers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/service/src/index.ts#callGreet",
          edgeKind: "TracedCall",
        }),
        expect.objectContaining({
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          edgeKind: "ExercisesSpan",
        }),
      ]),
    )

    const callees = await executeTool(
      "harness_callees",
      { symbolOrSpan: "libs/sample/service/src/index.ts#callGreet" },
      { graph },
    )
    expect(callees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/domain/src/index.ts#greet",
          edgeKind: "TracedCall",
        }),
        expect.objectContaining({
          tagId: "libs/sample/service/src/index.ts#Greeter",
          edgeKind: "RequiresService",
        }),
      ]),
    )
  })

  it("executes structural search across workspace files", async () => {
    const results = (await executeTool(
      "harness_structural_search",
      { pattern: "export const greet = $$$" },
      { graph },
    )) as Array<{ file: string; text: string }>

    expect(Array.isArray(results)).toBe(true)
    expect(results.some((r) => r.file.includes("libs/sample/domain/src/index.ts"))).toBe(true)
  })

  it("executes structural search with filePath scoped to .ts file", async () => {
    const results = (await executeTool(
      "harness_structural_search",
      {
        pattern: "export const greet = $$$",
        filePath: "libs/sample/domain/src/index.ts",
      },
      { graph },
    )) as Array<{ file: string; line: number; text: string }>

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(1)
    expect(results[0]?.file).toBe("libs/sample/domain/src/index.ts")
    expect(results[0]?.line).toBe(14)
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
            if (decision._tag === "Probability") {
              answers[key] = {
                _tag: "Probability",
                probability: key === "fitsAny" ? outcome.fitsAny : 0.9,
              }
            } else if (decision._tag === "Classify") {
              const labels = Object.keys(decision.criteria)
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
            }
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
    expect(routed).toEqual({
      block: "services-and-layers",
      patternFile: "agent-patterns/services-and-layers.md",
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
    expect(routedEffect).toEqual({
      block: "effect",
      patternFile: null,
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
    expect(routedReview).toEqual({
      block: "review",
      patternFile: null,
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
    expect(routed).toEqual({
      block: "review",
      patternFile: null,
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
    expect(routed).toEqual({
      block: "event-sourcing",
      patternFile: "agent-patterns/event-sourcing.md",
    })
  })

  it("falls back gracefully when snapshot file does not exist (offline fallback)", async () => {
    const nonExistentPath = path.join(os.tmpdir(), `non-existent-${Date.now()}.json`)
    const resolved = await executeTool(
      "harness_resolve",
      { symbolOrSpan: "NonExistent" },
      { snapshotPath: nonExistentPath },
    )
    expect(resolved).toBeNull()

    const tests = await executeTool(
      "harness_tests_reaching",
      { symbolOrSpan: "NonExistent" },
      { snapshotPath: nonExistentPath },
    )
    expect(tests).toEqual([])
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
      expect(tests).toEqual([
        expect.objectContaining({
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
        }),
      ])
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
      expect(toolsList.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "harness_resolve",
          "harness_callers",
          "harness_callees",
          "harness_tests_reaching",
          "harness_structural_search",
          "harness_route",
          "harness_ontology_why",
          "harness_ontology_impact",
          "harness_ontology_check",
          "harness_gq_query",
          "harness_graph_infer",
          "harness_graph_complete",
          "harness_graph_rewrite",
          "harness_lsp_diagnostics",
          "harness_telemetry_report",
        ]),
      )
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
        spanName: "Sample.planFn",
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
        spanName: "Sample.planFn",
      })

      // 3. Case C: graph-snapshot.json is updated to be newer than plan-graph-snapshot.json
      const future = new Date(Date.now() + 100000)
      fs.utimesSync(verifyPath, future, future)

      const resNewerVerify = await executeTool("harness_resolve", {
        symbolOrSpan: "Sample.verifyFn",
        repoRoot: tmpDir,
      })
      expect(resNewerVerify).toMatchObject({
        spanName: "Sample.verifyFn",
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
        expect(resolved).toBeNull()

        const tests = await executeTool(
          "harness_tests_reaching",
          { symbolOrSpan: "Sample.greet" },
          { snapshotPath: corruptSnapshotPath },
        )
        expect(tests).toEqual([])

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
        expect(errorOpt._tag).toBe("Some")
        if (errorOpt._tag === "Some") {
          expect(errorOpt.value).toMatchObject({
            _tag: "GraphInferenceError",
            reason: "invalid-graph",
          })
        }
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
      expect(listed.tools).toHaveLength(15)
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

      const okRes = await client.callTool({
        name: "harness_resolve",
        arguments: { symbolOrSpan: "Sample.greet" },
      })
      expect(okRes.isError).not.toBe(true)
      const firstBlock = Array.isArray(okRes.content) ? okRes.content[0] : undefined
      expect(firstBlock?.type).toBe("text")
      if (firstBlock?.type === "text") {
        expect(JSON.parse(firstBlock.text)).toMatchObject({
          spanName: "Sample.greet",
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
        { name: "harness_gq_query", arguments: { queryName: "bogus" } },
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

  it("resolveGraph re-throws unexpected defects via Cause.hasDies while logging to stderr", async () => {
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
        const exit = await Effect.runPromiseExit(resolveGraph({ snapshotPath: tmpSnap }))
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(true)
            expect(stderrChunks.join("")).toContain(
              "[harness-mcp] Unexpected defect resolving graph: Simulated fs defect",
            )
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected resolveGraph to die on unexpected defect")
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
})
