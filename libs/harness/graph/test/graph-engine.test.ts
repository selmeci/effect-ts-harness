import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  diffHarnessGraphs,
  findCallees,
  findCallers,
  findTestsReaching,
  loadGraphSnapshot,
  OmnigraphSync,
  renderMermaid,
  resolveNode,
  saveGraphSnapshot,
  structuralSearch,
  toOmnigraphNdjson,
} from "../src/index.js"

describe("HarnessGraph (effect/Graph + Omnigraph NDJSON)", () => {
  const sampleGraph = buildHarnessGraph({
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
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        spanName: "PhotoRepo.insert",
        file: "libs/sample/infra/src/index.ts",
        line: 10,
        packageTag: "infra",
        successType: "Photo",
        isStub: false,
      },
    ],
    services: [],
    layers: [],
    errors: [],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "abc123",
      },
    ],
    patternDocs: [],
    requiresService: [],
    failsWith: [],
    providesService: [],
    layerRequires: [],
    tracedCalls: [
      {
        callerQualname: "libs/sample/domain/src/index.ts#greet",
        calleeQualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        callCount: 1,
        receiverLayer: "PhotoRepoLive",
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

  it("resolves tests_reaching transitively from leaf and downstream spans", () => {
    const direct = findTestsReaching(sampleGraph, "Sample.greet")
    expect(direct.map((t) => t.testId)).toEqual([
      "libs/sample/domain/test/index.test.ts::greets by name",
    ])

    const transitive = findTestsReaching(sampleGraph, "PhotoRepo.insert")
    expect(transitive.map((t) => t.testId)).toEqual([
      "libs/sample/domain/test/index.test.ts::greets by name",
    ])
  })

  it("resolves callees and callers with receiverLayer metadata", () => {
    expect(findCallees(sampleGraph, "Sample.greet")).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        receiverLayer: "PhotoRepoLive",
      }),
    ])
    expect(findCallers(sampleGraph, "PhotoRepo.insert")).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/domain/src/index.ts#greet",
      }),
    ])
  })

  it("renders a Mermaid diagram via Graph.toMermaid and exports Omnigraph NDJSON", () => {
    const mermaid = renderMermaid(sampleGraph)
    expect(mermaid).toContain("flowchart")
    const ndjson = toOmnigraphNdjson(sampleGraph)
    expect(ndjson.split("\n").length).toBeGreaterThanOrEqual(5)
  })

  it("roundtrips graph snapshot via saveGraphSnapshot and loadGraphSnapshot", () => {
    const snapshotPath = path.join(process.cwd(), ".harness/test-snapshot.json")
    saveGraphSnapshot(sampleGraph, snapshotPath)
    expect(fs.existsSync(snapshotPath)).toBe(true)

    const loaded = loadGraphSnapshot(snapshotPath)
    expect(findTestsReaching(loaded, "PhotoRepo.insert").map((t) => t.testId)).toEqual([
      "libs/sample/domain/test/index.test.ts::greets by name",
    ])
    expect(findCallees(loaded, "Sample.greet")).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/infra/src/index.ts#PhotoRepo.insert",
        receiverLayer: "PhotoRepoLive",
      }),
    ])

    fs.unlinkSync(snapshotPath)
  })

  it("serializes all 6 node types and 6 edge types in toOmnigraphNdjson matching schema.pg", () => {
    const fullGraph = buildHarnessGraph({
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
      ],
      services: [
        {
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [
        {
          qualname: "PhotoRepoLive",
          layerKind: "live",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts",
        },
      ],
      errors: [
        {
          errorTag: "PhotoNotFound",
          file: "libs/sample/domain/src/errors.ts",
        },
      ],
      tests: [
        {
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          testFile: "libs/sample/domain/test/index.test.ts",
          testName: "greets by name",
          lastTreeHash: "abc123",
        },
      ],
      patternDocs: [
        {
          slug: "planning",
          path: "agent-patterns/planning.md",
          summary: "Plan-as-Code markdown template with stub skeleton pattern.",
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#greet",
          tagId: "PhotoRepo",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#greet",
          errorTag: "PhotoNotFound",
        },
      ],
      providesService: [
        {
          layerQualname: "PhotoRepoLive",
          tagId: "PhotoRepo",
        },
      ],
      layerRequires: [
        {
          layerQualname: "PhotoRepoLive",
          tagId: "PhotoRepo",
        },
      ],
      tracedCalls: [],
      exercisesSpans: [
        {
          testId: "libs/sample/domain/test/index.test.ts::greets by name",
          calleeQualname: "libs/sample/domain/src/index.ts#greet",
          callCount: 1,
          receiverLayer: null,
        },
      ],
    })

    const ndjson = toOmnigraphNdjson(fullGraph)
    const lines = ndjson.split("\n")
    expect(lines.length).toBe(17) // 6 EntityNodes + 3 RelationNodes + 8 PlaysRole edges

    expect(lines.some((l) => l.includes('"type":"EffectFn"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"ServiceTag"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"ServiceLayer"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"TaggedError"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"VitestCase"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"PatternDoc"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"EffectSignature"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"LayerFlow"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"TraceabilityTuple"'))).toBe(true)
    expect(lines.some((l) => l.includes('"edge":"PlaysRole"') && l.includes('"role":"requires-service"'))).toBe(true)
    expect(lines.some((l) => l.includes('"edge":"PlaysRole"') && l.includes('"role":"fails-with"'))).toBe(true)
    expect(lines.some((l) => l.includes('"edge":"PlaysRole"') && l.includes('"role":"provided-service"'))).toBe(true)
    expect(lines.some((l) => l.includes('"edge":"PlaysRole"') && l.includes('"role":"required-service"'))).toBe(true)
    expect(lines.some((l) => l.includes('"edge":"PlaysRole"') && l.includes('"role":"exercising-test"'))).toBe(true)
  })

  it("resolves nodes across different identifier types via resolveNode", () => {
    expect(resolveNode(sampleGraph, "Sample.greet")?._tag).toBe("EffectFn")
    expect(resolveNode(sampleGraph, "libs/sample/domain/src/index.ts#greet")?._tag).toBe("EffectFn")
    expect(resolveNode(sampleGraph, "greet")?._tag).toBe("EffectFn")
    expect(
      resolveNode(sampleGraph, "libs/sample/domain/test/index.test.ts::greets by name")?._tag,
    ).toBe("VitestCase")
    expect(resolveNode(sampleGraph, "nonexistent")).toBeUndefined()
  })

  it("diffs plan graph and implementation graph via diffHarnessGraphs", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: true,
        },
      ],
      services: [
        {
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#greet",
          tagId: "PhotoRepo",
        },
      ],
    })

    // 1. Incomplete impl with remaining stub
    const incompleteImpl = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: true,
        },
      ],
      services: [],
    })

    const diff1 = diffHarnessGraphs(incompleteImpl, planGraph)
    expect(diff1.isGreen).toBe(false)
    expect(diff1.missingServices).toEqual(["PhotoRepo"])
    expect(diff1.remainingStubs).toEqual(["libs/sample/domain/src/index.ts#greet"])
    expect(diff1.missingEdges).toHaveLength(1)

    // 2. Green complete impl
    const completeImpl = buildHarnessGraph({
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
      ],
      services: [
        {
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#greet",
          tagId: "PhotoRepo",
        },
      ],
    })

    const diff2 = diffHarnessGraphs(completeImpl, planGraph)
    expect(diff2.isGreen).toBe(true)
    expect(diff2.missingFns).toHaveLength(0)
    expect(diff2.missingServices).toHaveLength(0)
    expect(diff2.remainingStubs).toHaveLength(0)
    expect(diff2.missingEdges).toHaveLength(0)
  })

  it("finds TypeScript ast-grep matches via structuralSearch", () => {
    const results = structuralSearch({
      pattern: "export const $NAME = $_",
      subDirs: ["libs/harness/graph/src"],
    })
    expect(results.length).toBeGreaterThan(0)
    const match = results.find((r) => r.text.includes("buildHarnessGraph"))
    expect(match).toBeDefined()
    expect(match?.file).toContain("graph-engine.ts")
    expect(match?.line).toBeGreaterThan(0)
  })

  it("writes snapshot and handles offline server gracefully via OmnigraphSync", async () => {
    const testSnapshotPath = path.join(process.cwd(), ".harness/sync-test-snapshot.json")
    const program = Effect.gen(function* () {
      const syncService = yield* OmnigraphSync
      return yield* syncService.sync(sampleGraph, {
        snapshotPath: testSnapshotPath,
        baseUrl: "http://127.0.0.1:9999", // Unreachable port
      })
    }).pipe(Effect.provide(OmnigraphSync.Live))

    const result = await Effect.runPromise(program)
    expect(result.snapshotPath).toBe(testSnapshotPath)
    expect(result.syncedToOmnigraph).toBe(false)
    expect(fs.existsSync(testSnapshotPath)).toBe(true)

    fs.unlinkSync(testSnapshotPath)
  })
})
