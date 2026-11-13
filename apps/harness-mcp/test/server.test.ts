import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as AiError from "effect/ai/AiError"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph, saveGraphSnapshot } from "@harness/graph"
import {
  createServer,
  executeTool,
  isPathInsideRoot,
  runDefaultLspDiagnostics,
  startHarnessDaemonServer,
} from "../src/server.js"

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
    expect(createServer({ graph })).toBeDefined()
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
      saveGraphSnapshot(graph, tempSnapshotPath)
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
    await expect(executeTool("unknown_tool", {})).rejects.toThrow()
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
      saveGraphSnapshot(planGraph, planPath)
      const resPlanOnly = await executeTool("harness_resolve", {
        symbolOrSpan: "Sample.planFn",
        repoRoot: tmpDir,
      })
      expect(resPlanOnly).toMatchObject({
        spanName: "Sample.planFn",
      })

      // 2. Case B: graph-snapshot.json exists, but plan-graph-snapshot.json is newer
      saveGraphSnapshot(verifyGraph, verifyPath)
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
    const repoRoot = process.cwd()
    const testFile = path.join(repoRoot, "libs/sample/domain/src/index.ts")
    const effect = runDefaultLspDiagnostics(repoRoot, { file: testFile })
    const res = await Effect.runPromise(effect)
    expect(res).toBeDefined()
    expect(typeof res.clean).toBe("boolean")
    expect(Array.isArray(res.diagnostics)).toBe(true)
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
    const sendDaemonPayload = (payload: string): Promise<Record<string, unknown>> =>
      Effect.runPromise(
        Effect.callback<Record<string, unknown>>((resume) => {
          const client = net.createConnection(daemon.socketPath)
          let buf = ""
          client.on("connect", () => {
            client.write(payload + "\n")
          })
          client.on("data", (chunk) => {
            buf += chunk.toString("utf8")
            const idx = buf.indexOf("\n")
            if (idx !== -1) {
              client.end()
              resume(Effect.succeed(JSON.parse(buf.slice(0, idx)) as Record<string, unknown>))
            }
          })
        }),
      )

    try {
      const pingRes = await sendDaemonPayload(
        JSON.stringify({ id: "p1", command: "ping", repoRoot: tmpDir }),
      )
      expect(pingRes).toMatchObject({ id: "p1", ok: true, status: "warm" })

      const astRes = await sendDaemonPayload(
        JSON.stringify({
          id: "a1",
          command: "ast-gates",
          repoRoot: tmpDir,
          files: ["libs/sample/domain/src/index.ts"],
        }),
      )
      expect(astRes).toMatchObject({ id: "a1", ok: true })

      const traversalRes = await sendDaemonPayload(
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
      readonly diagnostics: ReadonlyArray<{ readonly code?: string }>
    }
    expect(escapedOverlayRes.clean).toBe(false)
    expect(escapedOverlayRes.summary.errors).toBe(1)
    expect(escapedOverlayRes.diagnostics[0]?.code).toBe("PATH_TRAVERSAL")
  })
})
