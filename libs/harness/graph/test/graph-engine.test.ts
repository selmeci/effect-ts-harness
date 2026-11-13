import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  deserializeGraphSnapshotEffect,
  diffHarnessGraphs,
  findCallees,
  findCallers,
  findTestsReaching,
  GraphSnapshotError,
  isHarnessGraph,
  loadGraphSnapshotEffect,
  NodeKey,
  OmnigraphSync,
  RelationId,
  renderMermaid,
  resolveNode,
  RoleName,
  saveGraphSnapshot,
  serializeGraphSnapshot,
  structuralSearch,
  toOmnigraphNdjson,
  type SerializedGraphSnapshot,
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

  it("roundtrips graph snapshot via saveGraphSnapshot and loadGraphSnapshotEffect", () => {
    const snapshotPath = path.join(process.cwd(), ".harness/test-snapshot.json")
    saveGraphSnapshot(sampleGraph, snapshotPath)
    expect(fs.existsSync(snapshotPath)).toBe(true)

    const loaded = Effect.runSync(loadGraphSnapshotEffect(snapshotPath))
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
    expect(
      lines.some(
        (l) =>
          l.includes('"edge":"PlaysRequiresServiceRole"') &&
          l.includes('"role":"requires-service"'),
      ),
    ).toBe(true)
    expect(
      lines.some(
        (l) => l.includes('"edge":"PlaysFailsWithRole"') && l.includes('"role":"fails-with"'),
      ),
    ).toBe(true)
    expect(
      lines.some(
        (l) =>
          l.includes('"edge":"PlaysProvidedServiceRole"') &&
          l.includes('"role":"provided-service"'),
      ),
    ).toBe(true)
    expect(
      lines.some(
        (l) =>
          l.includes('"edge":"PlaysRequiredServiceRole"') &&
          l.includes('"role":"required-service"'),
      ),
    ).toBe(true)
    expect(
      lines.some(
        (l) =>
          l.includes('"edge":"PlaysExercisingTestRole"') && l.includes('"role":"exercising-test"'),
      ),
    ).toBe(true)
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
    expect(match?.file).toContain("engine/hypergraph-store.ts")
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

  describe("F-1: Graph snapshot error handling and validation", () => {
    it("fails with GraphSnapshotError (reason: missing-file) on nonexistent path in loadGraphSnapshotEffect", () => {
      const missingPath = path.join(os.tmpdir(), `nonexistent-snap-${Date.now()}.json`)

      // Effect version returns typed GraphSnapshotError failure
      const exit = Effect.runSyncExit(loadGraphSnapshotEffect(missingPath))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const errorOpt = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(errorOpt)).toBe(true)
        if (Option.isSome(errorOpt)) {
          expect(errorOpt.value).toBeInstanceOf(GraphSnapshotError)
          expect(errorOpt.value.reason).toBe("missing-file")
        }
      }
    })

    it("fails with GraphSnapshotError (reason: invalid-json) on corrupt JSON or invalid snapshot schema", () => {
      const corruptPath = path.join(os.tmpdir(), `corrupt-snap-${Date.now()}.json`)
      fs.writeFileSync(corruptPath, "{ invalid json content: 123", "utf8")

      try {
        const exit = Effect.runSyncExit(loadGraphSnapshotEffect(corruptPath))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const errorOpt = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(errorOpt)).toBe(true)
          if (Option.isSome(errorOpt)) {
            expect(errorOpt.value.reason).toBe("invalid-json")
          }
        }
      } finally {
        if (fs.existsSync(corruptPath)) {
          fs.unlinkSync(corruptPath)
        }
      }
    })

    it("fails with GraphSnapshotError (reason: dangling-edge) when deserializing a snapshot with missing node keys", () => {
      const snapshotWithDanglingEdge: SerializedGraphSnapshot = {
        nodes: [
          {
            _tag: "EffectFn",
            qualname: "libs/sample/domain/src/index.ts#greet",
            spanName: "Sample.greet",
            file: "libs/sample/domain/src/index.ts",
            line: 4,
            packageTag: "domain",
            successType: "string",
            isStub: false,
          },
        ],
        edges: [
          {
            sourceKey: "EffectFn:libs/sample/domain/src/index.ts#greet",
            targetKey: "ServiceTag:NonexistentService",
            data: {
              _tag: "PlaysRole",
              relationId: RelationId.make("EffectSignature:greet"),
              entityKey: NodeKey.make("ServiceTag:NonexistentService"),
              role: RoleName.make("requires-service"),
            },
          },
        ],
      }

      // Effect version fails with GraphSnapshotError reason: dangling-edge
      const exit = Effect.runSyncExit(deserializeGraphSnapshotEffect(snapshotWithDanglingEdge))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const errorOpt = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(errorOpt)).toBe(true)
        if (Option.isSome(errorOpt)) {
          expect(errorOpt.value.reason).toBe("dangling-edge")
        }
      }
    })
  })

  describe("F-3, F-4, F-12, F-16, F-32: Graph construction, lattice role validation, and diffing", () => {
    it("records unresolvedReferences when requiresService or playsRole targets a nonexistent entity", () => {
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
        ],
        requiresService: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            tagId: "NonexistentDatabaseService",
          },
        ],
        playsRole: [
          {
            _tag: "PlaysRole" as const,
            relationId: RelationId.make("EffectSignature:libs/sample/domain/src/index.ts#greet"),
            entityKey: NodeKey.make("NonexistentEntityKey"),
            role: RoleName.make("caller"),
          },
        ],
      })

      expect(graph.unresolvedReferences).toBeDefined()
      expect(graph.unresolvedReferences?.length).toBeGreaterThanOrEqual(2)
      expect(
        graph.unresolvedReferences?.some((r) => r.targetKey === "NonexistentDatabaseService"),
      ).toBe(true)
      expect(graph.unresolvedReferences?.some((r) => r.targetKey === "NonexistentEntityKey")).toBe(
        true,
      )
    })

    it("records branchingViolations (invalid-graph-role) when a relation has an invalid role or invalid player kind against PERA ConceptLattice", () => {
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
        ],
        relations: [
          {
            _tag: "EffectSignature",
            relationId: RelationId.make("EffectSignature:libs/sample/domain/src/index.ts#greet"),
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            requiredServices: [],
            emittedErrors: [],
            calleeQualnames: [],
            payloadSchemas: [],
            file: "libs/sample/domain/src/index.ts",
            line: 4,
          },
        ],
        playsRole: [
          {
            _tag: "PlaysRole" as const,
            relationId: RelationId.make("EffectSignature:libs/sample/domain/src/index.ts#greet"),
            entityKey: NodeKey.make("EffectFn:libs/sample/domain/src/index.ts#greet"),
            role: RoleName.make("disallowed-lattice-role"),
          },
        ],
      })

      expect(graph.branchingViolations).toBeDefined()
      expect(graph.branchingViolations?.length).toBeGreaterThan(0)
      const roleViolation = graph.branchingViolations?.find((v) => v.rule === "invalid-graph-role")
      expect(roleViolation).toBeDefined()
      expect(roleViolation?.message).toContain("disallowed-lattice-role")
    })

    it("respects preferredKind in resolveTargetEntityKey when an EffectFn and ServiceTag share the same short name", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/order.ts#Order",
            spanName: "Order",
            file: "libs/sample/domain/src/order.ts",
            line: 1,
            packageTag: "domain",
            successType: "void",
            isStub: false,
          },
        ],
        services: [
          {
            tagId: "Order",
            name: "Order",
            packageTag: "service",
            file: "libs/sample/service/src/order.ts",
          },
        ],
        adrDocs: [
          {
            id: "ADR-001",
            title: "Order ADR",
            status: "accepted",
            path: "docs/adr/001.md",
            enforcedByFiles: [],
          },
          {
            id: "ADR-002",
            title: "Service ADR",
            status: "accepted",
            path: "docs/adr/002.md",
            enforcedByFiles: [],
          },
        ],
        governsSymbols: [
          {
            adrId: "ADR-001",
            targetKey: "Order",
            targetKind: "EffectFn",
          },
          {
            adrId: "ADR-002",
            targetKey: "Order",
            targetKind: "ServiceTag",
          },
        ],
      })

      const fnTargetNode = resolveNode(graph, "EffectFn:libs/sample/domain/src/order.ts#Order")
      const svcTargetNode = resolveNode(graph, "ServiceTag:Order")
      expect(fnTargetNode?._tag).toBe("EffectFn")
      expect(svcTargetNode?._tag).toBe("ServiceTag")

      const adr1Rel = resolveNode(
        graph,
        "TraceabilityTuple:governs:ADR-001->EffectFn:libs/sample/domain/src/order.ts#Order",
      )
      const adr2Rel = resolveNode(graph, "TraceabilityTuple:governs:ADR-002->ServiceTag:Order")
      expect(adr1Rel).toBeDefined()
      expect(adr2Rel).toBeDefined()
    })

    it("builds valid PlaysRole edges for HttpEndpointTuple and MigrationTuple relations", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/photos.ts#getPhoto",
            spanName: "Photo.get",
            file: "libs/sample/domain/src/photos.ts",
            line: 4,
            packageTag: "domain",
            successType: "Photo",
            isStub: false,
          },
        ],
        schemas: [
          {
            schemaName: "GetPhotoRequest",
            file: "libs/sample/contract/src/schemas.ts",
          },
          {
            schemaName: "PhotoResponse",
            file: "libs/sample/contract/src/schemas.ts",
          },
        ],
        errors: [
          {
            errorTag: "PhotoNotFoundError",
            file: "libs/sample/contract/src/errors.ts",
          },
        ],
        tests: [
          {
            testId: "libs/sample/infra/test/migrations.test.ts#mig test",
            testFile: "libs/sample/infra/test/migrations.test.ts",
            testName: "mig test",
          },
        ],
        httpEndpointTuples: [
          {
            relationId: RelationId.make("HttpEndpoint:GetPhoto"),
            endpointGroup: "Photos",
            endpointName: "getPhoto",
            method: "GET",
            path: "/photos/:id",
            handlerQualname: "libs/sample/domain/src/photos.ts#getPhoto",
            requestSchemaQualnames: ["GetPhotoRequest"],
            responseSchemaQualnames: ["PhotoResponse"],
            errorTags: ["PhotoNotFoundError"],
            file: "libs/sample/infra/src/http.ts",
            line: 10,
          },
        ],
        migrationTuples: [
          {
            relationId: RelationId.make("Migration:1_init_tables"),
            migrationId: "1_init_tables",
            engine: "SqliteMigrator",
            moduleFile: "libs/sample/infra/src/migrations.ts",
            isDestructive: false,
            verifyingTestQualnames: ["libs/sample/infra/test/migrations.test.ts#mig test"],
            line: 1,
          },
        ],
      })

      const epNode = resolveNode(graph, "HttpEndpoint:GetPhoto")
      expect(epNode?._tag).toBe("HttpEndpointTuple")

      const migNode = resolveNode(graph, "Migration:1_init_tables")
      expect(migNode?._tag).toBe("MigrationTuple")

      const ndjson = toOmnigraphNdjson(graph)
      expect(ndjson).toContain('"edge":"PlaysEndpointHandlerRole"')
      expect(ndjson).toContain('"edge":"PlaysRequestSchemaRole"')
      expect(ndjson).toContain('"edge":"PlaysResponseSchemaRole"')
      expect(ndjson).toContain('"edge":"PlaysEndpointErrorRole"')
      expect(ndjson).toContain('"edge":"PlaysMigrationVerifyingTestRole"')
    })

    it("diffHarnessGraphs reports missingLayers and missingErrors when plan contains unfulfilled layers or errors", () => {
      const planGraph = buildHarnessGraph({
        fns: [],
        layers: [
          {
            qualname: "PhotoRepoLive",
            layerKind: "live",
            packageTag: "infra",
            file: "libs/sample/infra/src/photo-repo-live.ts",
          },
        ],
        errors: [
          {
            errorTag: "PhotoAccessDeniedError",
            file: "libs/sample/contract/src/errors.ts",
          },
        ],
      })

      const implGraph = buildHarnessGraph({
        fns: [],
        layers: [],
        errors: [],
      })

      const diff = diffHarnessGraphs(implGraph, planGraph)
      expect(diff.isGreen).toBe(false)
      expect(diff.missingLayers).toEqual(["PhotoRepoLive"])
      expect(diff.missingErrors).toEqual(["PhotoAccessDeniedError"])
    })

    it("isHarnessGraph returns true for graphs built via buildHarnessGraph or deserializeGraphSnapshotEffect and false for plain objects", () => {
      expect(isHarnessGraph(sampleGraph)).toBe(true)

      const snapshot = serializeGraphSnapshot(sampleGraph)
      const restored = Effect.runSync(deserializeGraphSnapshotEffect(snapshot))
      expect(isHarnessGraph(restored)).toBe(true)

      expect(isHarnessGraph({ graph: {}, nodeIndexByKey: new Map() })).toBe(false)
      expect(isHarnessGraph(null)).toBe(false)
      expect(isHarnessGraph(undefined)).toBe(false)
      expect(isHarnessGraph("plain string")).toBe(false)
      expect(isHarnessGraph(12345)).toBe(false)
    })
  })
})
