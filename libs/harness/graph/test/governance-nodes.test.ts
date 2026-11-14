import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  checkEffectGraph,
  diffHarnessGraphs,
  extractWorkspaceTypeAwareGraph,
  findCallees,
  findCallers,
  loadWorkspaceGovernanceDocs,
  renderMermaid,
  resolveNode,
  toOmnigraphNdjson,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("AdrDocNode, EarsSpecNode, GovernsSymbol, and SpecifiesSymbol", () => {
  it("buildHarnessGraph creates doc nodes and governance edges, serializes to NDJSON, and resolves via resolveNode/findCallers/findCallees", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
          spanName: "Sample.uploadPhoto",
          file: "libs/sample/domain/src/index.ts",
          line: 10,
          packageTag: "domain",
          successType: "Photo",
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
      errors: [
        {
          errorTag: "PhotoNotFoundError",
          file: "libs/sample/contract/src/index.ts",
        },
      ],
      adrDocs: [
        {
          id: "sample:ADR-0001",
          title: "D1 and DO persistence boundaries",
          status: "accepted",
          path: "libs/sample/docs/adr/0001-persistence.md",
          enforcedByFiles: ["libs/sample/infra/src/index.ts"],
          referencedSpans: ["Sample.uploadPhoto"],
          referencedServices: ["PhotoRepo"],
          referencedErrors: ["PhotoNotFoundError"],
        },
      ],
      earsSpecs: [
        {
          id: "sample:SPEC-0001",
          title: "Sample Photo Gallery",
          status: "accepted",
          path: "libs/sample/docs/specs/spec-photo.md",
          enforcedByFiles: ["libs/sample/domain/src/index.ts"],
          referencedSpans: ["Sample.uploadPhoto"],
          referencedServices: ["PhotoRepo"],
          referencedErrors: ["PhotoNotFoundError"],
        },
      ],
      governsSymbols: [
        {
          adrId: "sample:ADR-0001",
          targetKey: "libs/sample/domain/src/index.ts#uploadPhoto",
          targetKind: "EffectFn",
        },
        {
          adrId: "sample:ADR-0001",
          targetKey: "PhotoRepo",
          targetKind: "ServiceTag",
        },
        {
          adrId: "sample:ADR-0001",
          targetKey: "PhotoNotFoundError",
          targetKind: "TaggedError",
        },
      ],
      specifiesSymbols: [
        {
          specId: "sample:SPEC-0001",
          targetKey: "libs/sample/domain/src/index.ts#uploadPhoto",
          targetKind: "EffectFn",
        },
        {
          specId: "sample:SPEC-0001",
          targetKey: "PhotoRepo",
          targetKind: "ServiceTag",
        },
        {
          specId: "sample:SPEC-0001",
          targetKey: "PhotoNotFoundError",
          targetKind: "TaggedError",
        },
      ],
    })

    // 1. resolveNode
    const adrById = resolveNode(graph, "sample:ADR-0001")
    expect(adrById?._tag).toBe("AdrDoc")
    expect(adrById && "title" in adrById ? adrById.title : "").toBe(
      "D1 and DO persistence boundaries",
    )

    const adrByPath = resolveNode(graph, "libs/sample/docs/adr/0001-persistence.md")
    expect(adrByPath?._tag).toBe("AdrDoc")

    const adrBySuffix = resolveNode(graph, "0001-persistence.md")
    expect(adrBySuffix?._tag).toBe("AdrDoc")

    const specById = resolveNode(graph, "sample:SPEC-0001")
    expect(specById?._tag).toBe("EarsSpec")
    expect(specById && "title" in specById ? specById.title : "").toBe("Sample Photo Gallery")

    const specBySuffix = resolveNode(graph, "spec-photo")
    expect(specBySuffix?._tag).toBe("EarsSpec")

    // 2. findCallees
    const adrCallees = findCallees(graph, "sample:ADR-0001")
    expect(adrCallees).toHaveLength(3)
    expect(adrCallees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
          spanName: "Sample.uploadPhoto",
          edgeKind: "GovernsSymbol",
        }),
        expect.objectContaining({
          qualname: "PhotoRepo",
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          edgeKind: "GovernsSymbol",
        }),
        expect.objectContaining({
          qualname: "PhotoNotFoundError",
          spanName: "PhotoNotFoundError",
          edgeKind: "GovernsSymbol",
        }),
      ]),
    )

    const specCallees = findCallees(graph, "sample:SPEC-0001")
    expect(specCallees).toHaveLength(3)
    expect(specCallees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
          spanName: "Sample.uploadPhoto",
          edgeKind: "SpecifiesSymbol",
        }),
        expect.objectContaining({
          qualname: "PhotoRepo",
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          edgeKind: "SpecifiesSymbol",
        }),
        expect.objectContaining({
          qualname: "PhotoNotFoundError",
          spanName: "PhotoNotFoundError",
          edgeKind: "SpecifiesSymbol",
        }),
      ]),
    )

    // 3. findCallers
    const fnCallers = findCallers(graph, "libs/sample/domain/src/index.ts#uploadPhoto")
    expect(fnCallers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "sample:ADR-0001",
          spanName: "D1 and DO persistence boundaries",
          edgeKind: "GovernsSymbol",
        }),
        expect.objectContaining({
          qualname: "sample:SPEC-0001",
          spanName: "Sample Photo Gallery",
          edgeKind: "SpecifiesSymbol",
        }),
      ]),
    )

    const svcCallers = findCallers(graph, "PhotoRepo")
    expect(svcCallers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "sample:ADR-0001",
          spanName: "D1 and DO persistence boundaries",
          edgeKind: "GovernsSymbol",
        }),
        expect.objectContaining({
          qualname: "sample:SPEC-0001",
          spanName: "Sample Photo Gallery",
          edgeKind: "SpecifiesSymbol",
        }),
      ]),
    )

    const errCallers = findCallers(graph, "PhotoNotFoundError")
    expect(errCallers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualname: "sample:ADR-0001",
          spanName: "D1 and DO persistence boundaries",
          edgeKind: "GovernsSymbol",
        }),
        expect.objectContaining({
          qualname: "sample:SPEC-0001",
          spanName: "Sample Photo Gallery",
          edgeKind: "SpecifiesSymbol",
        }),
      ]),
    )

    // 4. renderMermaid
    const mermaid = renderMermaid(graph)
    expect(mermaid).toContain("ADR:sample:ADR-0001")
    expect(mermaid).toContain("Spec:sample:SPEC-0001")
    expect(mermaid).toContain("governing-adr")
    expect(mermaid).toContain("specifying-ears")

    // 5. toOmnigraphNdjson
    const ndjson = toOmnigraphNdjson(graph)
    const lines = ndjson.split("\n").filter((l) => l.trim().length > 0)
    const objects = lines.map((l) => decodeJson(l) as Record<string, unknown>)

    const adrJson = objects.find((o) => o.type === "AdrDoc")
    expect(adrJson).toMatchObject({
      type: "AdrDoc",
      key: "sample:ADR-0001",
      properties: {
        id: "sample:ADR-0001",
        title: "D1 and DO persistence boundaries",
        status: "accepted",
        path: "libs/sample/docs/adr/0001-persistence.md",
      },
    })

    const specJson = objects.find((o) => o.type === "EarsSpec")
    expect(specJson).toMatchObject({
      type: "EarsSpec",
      key: "sample:SPEC-0001",
      properties: {
        id: "sample:SPEC-0001",
        title: "Sample Photo Gallery",
        status: "accepted",
        path: "libs/sample/docs/specs/spec-photo.md",
      },
    })

    const governsEdgeJson = objects.find(
      (o) =>
        o.edge === "PlaysGoverningAdrRole" &&
        o.from === "TraceabilityTuple:governs:sample:ADR-0001->ServiceTag:PhotoRepo" &&
        o.to === "sample:ADR-0001",
    )
    expect(governsEdgeJson).toMatchObject({
      edge: "PlaysGoverningAdrRole",
      from: "TraceabilityTuple:governs:sample:ADR-0001->ServiceTag:PhotoRepo",
      to: "sample:ADR-0001",
      properties: { role: "governing-adr" },
    })

    const specifiesEdgeJson = objects.find(
      (o) =>
        o.edge === "PlaysSpecifyingEarsRole" &&
        o.from === "TraceabilityTuple:specifies:sample:SPEC-0001->TaggedError:PhotoNotFoundError" &&
        o.to === "sample:SPEC-0001",
    )
    expect(specifiesEdgeJson).toMatchObject({
      edge: "PlaysSpecifyingEarsRole",
      from: "TraceabilityTuple:specifies:sample:SPEC-0001->TaggedError:PhotoNotFoundError",
      to: "sample:SPEC-0001",
      properties: { role: "specifying-ears" },
    })
  })

  describe("checkEffectGraph rule: unmapped-spec-symbol", () => {
    it("passes when all declared spans, services, and errors in EarsSpecNode exist in graph", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#getPhoto",
            spanName: "Sample.getPhoto",
            file: "libs/sample/domain/src/index.ts",
            line: 5,
            packageTag: "domain",
            successType: "Photo",
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
        errors: [
          {
            errorTag: "PhotoNotFoundError",
            file: "libs/sample/contract/src/index.ts",
          },
        ],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Spec",
            status: "proposed",
            path: "docs/specs/photo.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.getPhoto"],
            referencedServices: ["PhotoRepo"],
            referencedErrors: ["PhotoNotFoundError"],
          },
        ],
      })

      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(true)
      expect(res.violations).toHaveLength(0)
    })

    it("fails with unmapped-spec-symbol when referenced EffectFn span is missing", () => {
      const graph = buildHarnessGraph({
        fns: [],
        services: [
          {
            tagId: "PhotoRepo",
            name: "PhotoRepo",
            packageTag: "service",
            file: "libs/sample/service/src/index.ts",
          },
        ],
        errors: [
          {
            errorTag: "PhotoNotFoundError",
            file: "libs/sample/contract/src/index.ts",
          },
        ],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Spec",
            status: "accepted",
            path: "docs/specs/photo.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.missingSpan"],
            referencedServices: ["PhotoRepo"],
            referencedErrors: ["PhotoNotFoundError"],
          },
        ],
      })

      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(false)
      const violation = res.violations.find((v) => v.rule === "unmapped-spec-symbol")
      expect(violation).toBeDefined()
      expect(violation?.message).toBe(
        "EARS Spec 'sample:SPEC-0001' (docs/specs/photo.md) declares EffectFn span 'Sample.missingSpan', which is missing from the graph",
      )
      expect(violation?.path).toEqual(["sample:SPEC-0001", "Sample.missingSpan"])
    })

    it("fails with unmapped-spec-symbol when referenced ServiceTag is missing", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#getPhoto",
            spanName: "Sample.getPhoto",
            file: "libs/sample/domain/src/index.ts",
            line: 5,
            packageTag: "domain",
            successType: "Photo",
            isStub: false,
          },
        ],
        services: [],
        errors: [],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Spec",
            status: "proposed",
            path: "docs/specs/photo.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.getPhoto"],
            referencedServices: ["MissingService"],
            referencedErrors: [],
          },
        ],
      })

      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(false)
      const violation = res.violations.find((v) => v.rule === "unmapped-spec-symbol")
      expect(violation).toBeDefined()
      expect(violation?.message).toBe(
        "EARS Spec 'sample:SPEC-0001' (docs/specs/photo.md) declares ServiceTag 'MissingService', which is missing from the graph",
      )
      expect(violation?.path).toEqual(["sample:SPEC-0001", "MissingService"])
    })

    it("fails with unmapped-spec-symbol when referenced TaggedError is missing", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#getPhoto",
            spanName: "Sample.getPhoto",
            file: "libs/sample/domain/src/index.ts",
            line: 5,
            packageTag: "domain",
            successType: "Photo",
            isStub: false,
          },
        ],
        services: [],
        errors: [],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Spec",
            status: "accepted",
            path: "docs/specs/photo.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.getPhoto"],
            referencedServices: [],
            referencedErrors: ["MissingError"],
          },
        ],
      })

      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(false)
      const violation = res.violations.find((v) => v.rule === "unmapped-spec-symbol")
      expect(violation).toBeDefined()
      expect(violation?.message).toBe(
        "EARS Spec 'sample:SPEC-0001' (docs/specs/photo.md) declares TaggedError 'MissingError', which is missing from the graph",
      )
      expect(violation?.path).toEqual(["sample:SPEC-0001", "MissingError"])
    })

    it("ignores missing symbols when EarsSpec status is deprecated or superseded", () => {
      const graph = buildHarnessGraph({
        fns: [],
        services: [],
        errors: [],
        earsSpecs: [
          {
            id: "sample:SPEC-OLD",
            title: "Old Spec",
            status: "deprecated",
            path: "docs/specs/old.md",
            enforcedByFiles: [],
            referencedSpans: ["Old.span"],
            referencedServices: ["OldService"],
            referencedErrors: ["OldError"],
          },
          {
            id: "sample:SPEC-SUPERSEDED",
            title: "Superseded Spec",
            status: "superseded",
            path: "docs/specs/superseded.md",
            enforcedByFiles: [],
            referencedSpans: ["Super.span"],
            referencedServices: ["SuperService"],
            referencedErrors: ["SuperError"],
          },
        ],
      })

      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(true)
      expect(res.violations).toHaveLength(0)
    })
  })

  describe("diffHarnessGraphs and diffPlanAndImplGraphs with governance edges", () => {
    it("diffHarnessGraphs detects missing planned SpecifiesSymbol and GovernsSymbol edges", () => {
      const planGraph = buildHarnessGraph({
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
        adrDocs: [
          {
            id: "sample:ADR-0001",
            title: "ADR Title",
            status: "accepted",
            path: "docs/adr/0001.md",
            enforcedByFiles: [],
            referencedSpans: [],
            referencedServices: ["PhotoRepo"],
            referencedErrors: [],
          },
        ],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Spec Title",
            status: "accepted",
            path: "docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.greet"],
            referencedServices: [],
            referencedErrors: [],
          },
        ],
        governsSymbols: [
          {
            adrId: "sample:ADR-0001",
            targetKey: "PhotoRepo",
            targetKind: "ServiceTag",
          },
        ],
        specifiesSymbols: [
          {
            specId: "sample:SPEC-0001",
            targetKey: "libs/sample/domain/src/index.ts#greet",
            targetKind: "EffectFn",
          },
        ],
      })

      // Impl graph has the nodes but is missing the edges
      const implGraph = buildHarnessGraph({
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
        adrDocs: [
          {
            id: "sample:ADR-0001",
            title: "ADR Title",
            status: "accepted",
            path: "docs/adr/0001.md",
            enforcedByFiles: [],
            referencedSpans: [],
            referencedServices: ["PhotoRepo"],
            referencedErrors: [],
          },
        ],
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Spec Title",
            status: "accepted",
            path: "docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.greet"],
            referencedServices: [],
            referencedErrors: [],
          },
        ],
        governsSymbols: [],
        specifiesSymbols: [],
      })

      const diff = diffHarnessGraphs(implGraph, planGraph)
      expect(diff.isGreen).toBe(false)
      expect(diff.missingEdges).toHaveLength(2)
      expect(diff.missingEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _tag: "PlaysRole",
            entityKey: "AdrDoc:sample:ADR-0001",
            relationId: "TraceabilityTuple:governs:sample:ADR-0001->ServiceTag:PhotoRepo",
            role: "governing-adr",
          }),
          expect.objectContaining({
            _tag: "PlaysRole",
            entityKey: "EarsSpec:sample:SPEC-0001",
            relationId:
              "TraceabilityTuple:specifies:sample:SPEC-0001->EffectFn:libs/sample/domain/src/index.ts#greet",
            role: "specifying-ears",
          }),
        ]),
      )
    })
  })

  describe("loadWorkspaceGovernanceDocs and extractWorkspaceTypeAwareGraph", () => {
    it("scans workspace docs and extracts AdrDoc and EarsSpec nodes", () => {
      const repoRoot = process.cwd()
      const docs = loadWorkspaceGovernanceDocs(repoRoot, testHostIo)
      expect(docs.length).toBeGreaterThan(0)

      const sampleAdr = docs.find((d) => d.id === "sample:ADR-0001")
      expect(sampleAdr).toBeDefined()
      expect(sampleAdr?._tag).toBe("AdrDoc")
      expect(sampleAdr?.status).toBe("accepted")
      expect(sampleAdr?.referencedServices).toContain("PhotoRepo")

      const sampleSpec = docs.find((d) => d.id === "sample:SPEC-0001")
      expect(sampleSpec).toBeDefined()
      expect(sampleSpec?._tag).toBe("EarsSpec")
      expect(sampleSpec?.referencedSpans).toContain("Sample.uploadPhoto")
      expect(sampleSpec?.referencedErrors).toContain("PhotoNotFoundError")
    })

    it("extractWorkspaceTypeAwareGraph includes governance docs and edges in the mutated graph", () => {
      const repoRoot = process.cwd()
      const graph = Effect.runSync(extractWorkspaceTypeAwareGraph(repoRoot, testHostIo))
      expect(graph.graph).toBeDefined()
      const adrNode = resolveNode(graph, "sample:ADR-0001")
      expect(adrNode).toBeDefined()
      expect(adrNode?._tag).toBe("AdrDoc")

      const specNode = resolveNode(graph, "sample:SPEC-0001")
      expect(specNode).toBeDefined()
      expect(specNode?._tag).toBe("EarsSpec")
    })
  })
})
