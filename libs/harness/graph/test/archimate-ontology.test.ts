import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  classifyOntologyEdge,
  classifyOntologyNode,
  NodeKey,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  RelationId,
  renderOntologyMermaid,
  RoleName,
} from "../src/index.js"

describe("ArchiMate Ontology Module", () => {
  it("classifyOntologyNode accurately classifies all 8 node types into ArchiMate layers and aspects", () => {
    // 1. AdrDoc
    const adrNode = {
      _tag: "AdrDoc" as const,
      id: "harness:ADR-0001",
      title: "Deterministic Gates",
      status: "accepted" as const,
      path: "libs/harness/docs/adr/0001.md",
      enforcedByFiles: [],
      referencedSpans: [],
      referencedServices: [],
      referencedErrors: [],
    }
    const adrClassified = classifyOntologyNode(adrNode)
    expect(adrClassified).toEqual({
      key: "harness:ADR-0001",
      label: "Deterministic Gates",
      nodeTag: "AdrDoc",
      layer: "Motivation",
      aspect: "Motivation",
      elementType: "DriverOrConstraint",
      file: "libs/harness/docs/adr/0001.md",
    })

    // 2. EarsSpec
    const specNode = {
      _tag: "EarsSpec" as const,
      id: "sample:SPEC-0001",
      title: "Photo Gallery",
      status: "accepted" as const,
      path: "libs/sample/docs/specs/0001.md",
      enforcedByFiles: [],
      referencedSpans: [],
      referencedServices: [],
      referencedErrors: [],
    }
    const specClassified = classifyOntologyNode(specNode)
    expect(specClassified).toEqual({
      key: "sample:SPEC-0001",
      label: "Photo Gallery",
      nodeTag: "EarsSpec",
      layer: "Motivation",
      aspect: "Motivation",
      elementType: "Requirement",
      file: "libs/sample/docs/specs/0001.md",
    })

    // 3a. EffectFn (domain rule: .decide)
    const ruleFn = {
      _tag: "EffectFn" as const,
      qualname: "libs/sample/domain/src/index.ts#Album.decide",
      spanName: "Album.decide",
      packageTag: "domain" as const,
      file: "libs/sample/domain/src/index.ts",
      line: 12,
      successType: "boolean",
      isStub: false,
    }
    expect(classifyOntologyNode(ruleFn)).toEqual({
      key: "libs/sample/domain/src/index.ts#Album.decide",
      label: "Album.decide",
      nodeTag: "EffectFn",
      layer: "Business",
      aspect: "Behavior",
      elementType: "BusinessRule",
      file: "libs/sample/domain/src/index.ts",
    })

    // 3b. EffectFn (domain process: uploadPhoto)
    const processFn = {
      _tag: "EffectFn" as const,
      qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
      spanName: "Sample.uploadPhoto",
      packageTag: "domain" as const,
      file: "libs/sample/domain/src/index.ts",
      line: 45,
      successType: "Photo",
      isStub: false,
    }
    expect(classifyOntologyNode(processFn)).toEqual({
      key: "libs/sample/domain/src/index.ts#uploadPhoto",
      label: "Sample.uploadPhoto",
      nodeTag: "EffectFn",
      layer: "Business",
      aspect: "Behavior",
      elementType: "BusinessProcess",
      file: "libs/sample/domain/src/index.ts",
    })

    // 3c. EffectFn (app function)
    const appFn = {
      _tag: "EffectFn" as const,
      qualname: "apps/sample/src/index.ts#main",
      spanName: "App.main",
      packageTag: "app" as const,
      file: "apps/sample/src/index.ts",
      line: 10,
      successType: "void",
      isStub: false,
    }
    expect(classifyOntologyNode(appFn)).toEqual({
      key: "apps/sample/src/index.ts#main",
      label: "App.main",
      nodeTag: "EffectFn",
      layer: "Application",
      aspect: "Behavior",
      elementType: "ApplicationFunction",
      file: "apps/sample/src/index.ts",
    })

    // 4. TaggedError
    const errorNode = {
      _tag: "TaggedError" as const,
      errorTag: "PhotoNotFoundError",
      file: "libs/sample/contract/src/index.ts",
    }
    expect(classifyOntologyNode(errorNode)).toEqual({
      key: "PhotoNotFoundError",
      label: "PhotoNotFoundError",
      nodeTag: "TaggedError",
      layer: "Business",
      aspect: "PassiveStructure",
      elementType: "BusinessEvent",
      file: "libs/sample/contract/src/index.ts",
    })

    // 5a. ServiceTag (Technology: Cloudflare binding)
    const cloudSvc = {
      _tag: "ServiceTag" as const,
      tagId: "Cloudflare.Env",
      name: "Cloudflare.Env",
      packageTag: "service" as const,
      file: "libs/infra/src/index.ts",
    }
    expect(classifyOntologyNode(cloudSvc)).toEqual({
      key: "Cloudflare.Env",
      label: "Cloudflare.Env",
      nodeTag: "ServiceTag",
      layer: "Technology",
      aspect: "ActiveStructure",
      elementType: "TechnologyService",
      file: "libs/infra/src/index.ts",
    })

    // 5b. ServiceTag (Application Service)
    const appSvc = {
      _tag: "ServiceTag" as const,
      tagId: "PhotoRepo",
      name: "PhotoRepo",
      packageTag: "service" as const,
      file: "libs/sample/service/src/index.ts",
    }
    expect(classifyOntologyNode(appSvc)).toEqual({
      key: "PhotoRepo",
      label: "PhotoRepo",
      nodeTag: "ServiceTag",
      layer: "Application",
      aspect: "Behavior",
      elementType: "ApplicationService",
      file: "libs/sample/service/src/index.ts",
    })

    // 6a. ServiceLayer (infra)
    const infraLayer = {
      _tag: "ServiceLayer" as const,
      qualname: "libs/sample/infra/src/index.ts#PhotoRepoLive",
      layerKind: "infra" as const,
      packageTag: "infra" as const,
      file: "libs/sample/infra/src/index.ts",
    }
    expect(classifyOntologyNode(infraLayer)).toEqual({
      key: "libs/sample/infra/src/index.ts#PhotoRepoLive",
      label: "PhotoRepoLive",
      nodeTag: "ServiceLayer",
      layer: "Technology",
      aspect: "ActiveStructure",
      elementType: "ApplicationComponent",
      file: "libs/sample/infra/src/index.ts",
    })

    // 6b. ServiceLayer (application live)
    const liveLayer = {
      _tag: "ServiceLayer" as const,
      qualname: "libs/sample/domain/src/index.ts#PhotoServiceLive",
      layerKind: "live" as const,
      packageTag: "domain" as const,
      file: "libs/sample/domain/src/index.ts",
    }
    expect(classifyOntologyNode(liveLayer)).toEqual({
      key: "libs/sample/domain/src/index.ts#PhotoServiceLive",
      label: "PhotoServiceLive",
      nodeTag: "ServiceLayer",
      layer: "Application",
      aspect: "ActiveStructure",
      elementType: "ApplicationComponent",
      file: "libs/sample/domain/src/index.ts",
    })

    // 7. PatternDoc
    const patNode = {
      _tag: "PatternDoc" as const,
      slug: "services-and-layers",
      path: "agent-patterns/services-and-layers.md",
      summary: "Layer patterns",
    }
    expect(classifyOntologyNode(patNode)).toEqual({
      key: "services-and-layers",
      label: "services-and-layers",
      nodeTag: "PatternDoc",
      layer: "Technology",
      aspect: "PassiveStructure",
      elementType: "AssessmentPattern",
      file: "agent-patterns/services-and-layers.md",
    })

    // 8. VitestCase
    const testNode = {
      _tag: "VitestCase" as const,
      testId: "libs/sample/test/photo.test.ts#upload",
      testFile: "libs/sample/test/photo.test.ts",
      testName: "upload photo should succeed",
      lastTreeHash: "workspace",
    }
    expect(classifyOntologyNode(testNode)).toEqual({
      key: "libs/sample/test/photo.test.ts#upload",
      label: "upload photo should succeed",
      nodeTag: "VitestCase",
      layer: "Implementation",
      aspect: "Behavior",
      elementType: "WorkPackageTest",
      file: "libs/sample/test/photo.test.ts",
    })
  })

  it("classifyOntologyEdge maps PERA PlaysRoleEdge roles to ArchiMate relations", () => {
    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("TraceabilityTuple:ADR-0001->Symbol"),
        entityKey: NodeKey.make("AdrDoc:ADR-0001"),
        role: RoleName.make("governing-adr"),
      }),
    ).toBe("Influence")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("TraceabilityTuple:SPEC-0001->Symbol"),
        entityKey: NodeKey.make("EarsSpec:SPEC-0001"),
        role: RoleName.make("specifying-ears"),
      }),
    ).toBe("Realization")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("LayerFlow:Layer"),
        entityKey: NodeKey.make("ServiceTag:Tag"),
        role: RoleName.make("provided-service"),
      }),
    ).toBe("Realization")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("EffectSignature:Caller"),
        entityKey: NodeKey.make("ServiceTag:Tag"),
        role: RoleName.make("requires-service"),
      }),
    ).toBe("Serving")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("LayerFlow:Layer"),
        entityKey: NodeKey.make("ServiceTag:Tag"),
        role: RoleName.make("required-service"),
      }),
    ).toBe("Serving")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("EffectSignature:Caller"),
        entityKey: NodeKey.make("TaggedError:Error"),
        role: RoleName.make("fails-with"),
      }),
    ).toBe("Triggering")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("EffectSignature:Caller"),
        entityKey: NodeKey.make("EffectFn:Callee"),
        role: RoleName.make("callee"),
        callCount: 1,
        receiverLayer: null,
      }),
    ).toBe("Triggering")

    expect(
      classifyOntologyEdge({
        _tag: "PlaysRole",
        relationId: RelationId.make("TraceabilityTuple:Test->Callee"),
        entityKey: NodeKey.make("VitestCase:Test"),
        role: RoleName.make("exercising-test"),
        callCount: 1,
        receiverLayer: null,
      }),
    ).toBe("Verification")
  })

  it("projectOntologyLayers groups nodes into all 5 layers and renders flowchart TB Mermaid", () => {
    const graph = buildHarnessGraph({
      adrDocs: [
        {
          id: "ADR-0001",
          title: "Deterministic Gates",
          status: "accepted",
          path: "adr/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      fns: [
        {
          qualname: "libs/domain/src/index.ts#decide",
          spanName: "decide",
          file: "libs/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "boolean",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "UserRepo",
          name: "UserRepo",
          packageTag: "service",
          file: "libs/service/src/index.ts",
        },
        {
          tagId: "Cloudflare.D1",
          name: "Cloudflare.D1",
          packageTag: "infra",
          file: "libs/infra/src/index.ts",
        },
      ],
      tests: [
        {
          testId: "test::decide",
          testFile: "libs/domain/test/decide.test.ts",
          testName: "decide test",
          lastTreeHash: "workspace",
        },
      ],
      governsSymbols: [
        {
          adrId: "ADR-0001",
          targetKey: "libs/domain/src/index.ts#decide",
          targetKind: "EffectFn",
        },
      ],
      exercisesSpans: [
        {
          testId: "test::decide",
          calleeQualname: "libs/domain/src/index.ts#decide",
          callCount: 1,
          receiverLayer: null,
        },
      ],
    })

    const projection = projectOntologyLayers(graph)
    expect(projection.layers.Motivation.length).toBe(1)
    expect(projection.layers.Business.length).toBe(1)
    expect(projection.layers.Application.length).toBe(1)
    expect(projection.layers.Technology.length).toBe(1)
    expect(projection.layers.Implementation.length).toBe(1)

    expect(projection.edges.length).toBe(4)
    expect(projection.mermaid).toContain("flowchart TB")
    expect(projection.mermaid).toContain("subgraph Motivation")
    expect(projection.mermaid).toContain("subgraph Business")
    expect(projection.mermaid).toContain("subgraph Application")
    expect(projection.mermaid).toContain("subgraph Technology")
    expect(projection.mermaid).toContain("subgraph Implementation")

    const directMermaid = renderOntologyMermaid(graph)
    expect(directMermaid).toBe(projection.mermaid)
  })

  it("queryOntologyWhy traces direct and transitive realization from AdrDoc/EarsSpec through ServiceTag to ServiceLayer", () => {
    const graph = buildHarnessGraph({
      adrDocs: [
        {
          id: "sample:ADR-0001",
          title: "D1 persistence boundaries",
          status: "accepted",
          path: "libs/sample/docs/adr/0001-persistence.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      earsSpecs: [
        {
          id: "sample:SPEC-0001",
          title: "Sample Gallery",
          status: "accepted",
          path: "libs/sample/docs/specs/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
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
          qualname: "libs/sample/infra/src/index.ts#PhotoRepoLive",
          layerKind: "infra",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts",
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
          targetKey: "PhotoRepo",
          targetKind: "ServiceTag",
        },
      ],
      providesService: [
        {
          layerQualname: "libs/sample/infra/src/index.ts#PhotoRepoLive",
          tagId: "PhotoRepo",
        },
      ],
    })

    // Query PhotoRepoLive (ServiceLayer)
    const whyLive = queryOntologyWhy(graph, "libs/sample/infra/src/index.ts#PhotoRepoLive")
    expect(whyLive.justified).toBe(true)
    expect(whyLive.target?.key).toBe("libs/sample/infra/src/index.ts#PhotoRepoLive")
    expect(whyLive.governingAdrs.length).toBe(1)
    expect(whyLive.governingAdrs[0]?.id).toBe("sample:ADR-0001")
    expect(whyLive.governingAdrs[0]?.via).toEqual([
      "sample:ADR-0001",
      "PhotoRepo",
      "libs/sample/infra/src/index.ts#PhotoRepoLive",
    ])

    expect(whyLive.realizingSpecs.length).toBe(1)
    expect(whyLive.realizingSpecs[0]?.id).toBe("sample:SPEC-0001")
    expect(whyLive.realizingSpecs[0]?.via).toEqual([
      "sample:SPEC-0001",
      "PhotoRepo",
      "libs/sample/infra/src/index.ts#PhotoRepoLive",
    ])
    expect(whyLive.upwardChain.length).toBeGreaterThanOrEqual(2)

    // Directly querying ADR returns self-justified
    const whyAdr = queryOntologyWhy(graph, "sample:ADR-0001")
    expect(whyAdr.justified).toBe(true)
    expect(whyAdr.governingAdrs[0]?.id).toBe("sample:ADR-0001")
    expect(whyAdr.governingAdrs[0]?.via).toEqual(["sample:ADR-0001"])

    // Query non-existent symbol
    const whyMissing = queryOntologyWhy(graph, "non-existent")
    expect(whyMissing.justified).toBe(false)
    expect(whyMissing.target).toBeNull()
  })

  it("queryOntologyImpact traverses both incoming and outgoing edges to collect affected specs, ADRs, and reaching tests", () => {
    const graph = buildHarnessGraph({
      adrDocs: [
        {
          id: "ADR-0001",
          title: "Deterministic Gates",
          status: "accepted",
          path: "adr/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      earsSpecs: [
        {
          id: "SPEC-0001",
          title: "Decider Spec",
          status: "accepted",
          path: "spec/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      fns: [
        {
          qualname: "libs/domain/src/index.ts#decide",
          spanName: "Domain.decide",
          file: "libs/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "boolean",
          isStub: false,
        },
      ],
      errors: [
        {
          errorTag: "DomainError",
          file: "libs/contract/src/index.ts",
        },
      ],
      tests: [
        {
          testId: "test::decide",
          testFile: "libs/domain/test/decide.test.ts",
          testName: "decide test",
          lastTreeHash: "workspace",
        },
      ],
      governsSymbols: [
        {
          adrId: "ADR-0001",
          targetKey: "libs/domain/src/index.ts#decide",
          targetKind: "EffectFn",
        },
      ],
      specifiesSymbols: [
        {
          specId: "SPEC-0001",
          targetKey: "libs/domain/src/index.ts#decide",
          targetKind: "EffectFn",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/domain/src/index.ts#decide",
          errorTag: "DomainError",
        },
      ],
      exercisesSpans: [
        {
          testId: "test::decide",
          calleeQualname: "libs/domain/src/index.ts#decide",
          callCount: 1,
          receiverLayer: null,
        },
      ],
    })

    const impact = queryOntologyImpact(graph, "Domain.decide")
    expect(impact.target?.key).toBe("libs/domain/src/index.ts#decide")
    expect(impact.affectedAdrs).toContain("ADR-0001")
    expect(impact.affectedSpecs).toContain("SPEC-0001")
    expect(impact.reachingTests).toContain("test::decide")
    expect(impact.impactByLayer.Business.some((n) => n.key === "DomainError")).toBe(true)

    // Non-existent symbol returns empty result
    const missing = queryOntologyImpact(graph, "non-existent")
    expect(missing.target).toBeNull()
    expect(missing.affectedSpecs).toEqual([])
  })
})
