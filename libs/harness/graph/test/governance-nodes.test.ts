import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  checkEffectGraph,
  createTypeScriptProgramSession,
  decideEffectGraphPolicy,
  diffHarnessGraphs,
  extractWorkspaceTypeAwareGraph,
  findCallees,
  findCallers,
  type HarnessGraph,
  loadWorkspaceGovernanceDocs,
  loadWorkspaceGovernanceDocsWithViolations,
  parseGovernanceDocFile,
  parseGovernanceDocFileChecked,
  renderMermaid,
  resolveNode,
  toOmnigraphNdjson,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("AdrDocNode, EarsSpecNode, GovernsSymbol, and SpecifiesSymbol", () => {
  const makeGovernanceRoundtripGraph = () =>
    buildHarnessGraph({
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

  it("buildHarnessGraph creates doc nodes and governance edges and resolves via resolveNode/findCallers/findCallees", () => {
    const graph = makeGovernanceRoundtripGraph()

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
  })

  it("buildHarnessGraph renders Mermaid and serializes governance nodes and edges to NDJSON", () => {
    const graph = makeGovernanceRoundtripGraph()

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

    it("SPEC-0029 REQ-4.1: ignores unmapped symbols for status: draft EARS specs", () => {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "harness:SPEC-DRAFT",
            title: "Draft Spec",
            status: "draft",
            path: "libs/harness/docs/specs/draft.md",
            enforcedByFiles: [],
            referencedSpans: ["Future.span"],
            referencedServices: ["FutureService"],
            referencedErrors: ["FutureError"],
          },
        ],
      })
      const res = checkEffectGraph(graph)
      expect(res.ok).toBe(true)
      expect(res.violations).toHaveLength(0)
    })

    it("SPEC-0029 REQ-4.3: fails closed on unrecognized spec/adr status via parseGovernanceDocFileChecked and GraphPolicy.decide", () => {
      const okDraft = parseGovernanceDocFileChecked(
        "libs/harness/docs/specs/draft.md",
        "---\nid: harness:SPEC-1\nstatus: draft\n---\n",
      )
      expect(okDraft._tag).toBe("Ok")

      const badAdrDraft = parseGovernanceDocFileChecked(
        "libs/harness/docs/adr/0001.md",
        "---\nid: harness:ADR-1\nstatus: draft\n---\n",
      )
      expect(badAdrDraft._tag).toBe("InvalidStatus")

      const badSpecStatus = parseGovernanceDocFileChecked(
        "libs/harness/docs/specs/bogus.md",
        "---\nid: harness:SPEC-2\nstatus: bogus\n---\n",
      )
      expect(badSpecStatus._tag).toBe("InvalidStatus")

      const tempDir = mkdtempSync(join(tmpdir(), "harness-gov-status-failclosed-"))
      try {
        mkdirSync(join(tempDir, "libs/harness/docs/specs"), { recursive: true })
        writeFileSync(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/**'\n")
        writeFileSync(
          join(tempDir, "libs/harness/docs/specs/2026-11-22-bogus.md"),
          "---\nid: harness:SPEC-9999\ntitle: Bogus\nstatus: bogus\n---\n",
        )
        const loaded = loadWorkspaceGovernanceDocsWithViolations(tempDir, testHostIo)
        expect(loaded.docs).toHaveLength(0)
        expect(loaded.violations).toHaveLength(1)
        const extracted = Effect.runSync(extractWorkspaceTypeAwareGraph(tempDir, testHostIo))
        const policyRes = Effect.runSync(decideEffectGraphPolicy(extracted))
        expect(policyRes.ok).toBe(false)
        expect(
          policyRes.violations.some(
            (v) => v.rule === "unmapped-spec-symbol" && v.message.includes("bogus"),
          ),
        ).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("SPEC-0029: exercises governance-doc-parser Skip, AdrDoc, quoted frontmatter, heading title fallback, and null compatibility wrapper", () => {
      expect(parseGovernanceDocFileChecked("docs/notes.md", "---\nid: x\n---\n")._tag).toBe("Skip")
      expect(parseGovernanceDocFileChecked("libs/harness/docs/specs/a.md", "no fm")._tag).toBe(
        "Skip",
      )
      expect(
        parseGovernanceDocFileChecked("libs/harness/docs/specs/a.md", "---\ntitle: NoId\n---\n")
          ._tag,
      ).toBe("Skip")
      expect(
        parseGovernanceDocFileChecked(
          "libs/harness/docs/specs/missing-status.md",
          "---\nid: harness:SPEC-1\n---\n",
        )._tag,
      ).toBe("InvalidStatus")
      expect(
        parseGovernanceDocFileChecked(
          "libs/harness/docs/adr/bad-adr.md",
          "---\nid: harness:ADR-9\nstatus: bogus\n---\n",
        )._tag,
      ).toBe("InvalidStatus")

      const validAdr = parseGovernanceDocFileChecked(
        "libs/harness/docs/adr/0009.md",
        '\uFEFF---\n# comment\nid: "harness:ADR-9"\nstatus: \'accepted\'\nenforced_by: [libs/a.ts]\nspans: []\nservices:\n  - "SvcTag"\nerrors:\n  - ErrA # inline\n---\n# Heading Fallback Title\n',
      )
      match(validAdr)
        .with({ _tag: "Ok" }, ({ node }) => {
          expect(node._tag).toBe("AdrDoc")
          expect(node.id).toBe("harness:ADR-9")
          expect(node.title).toBe("Heading Fallback Title")
          expect(node.enforcedByFiles).toEqual(["libs/a.ts"])
          expect(node.referencedSpans).toEqual([])
          expect(node.referencedServices).toEqual(["SvcTag"])
          expect(node.referencedErrors).toEqual(["ErrA"])
        })
        .with({ _tag: "Skip" }, { _tag: "InvalidStatus" }, () => {
          expect.unreachable("Expected Ok for valid ADR")
        })
        .exhaustive()
      expect(
        parseGovernanceDocFile(
          "libs/harness/docs/specs/a.md",
          "---\nid: harness:SPEC-1\nstatus: bogus\n---\n",
        ),
      ).toBeNull()
      expect(
        parseGovernanceDocFile(
          "libs/harness/docs/specs/a.md",
          "---\nid: harness:SPEC-1\nstatus: draft\n---\n# Title\n",
        )?.id,
      ).toBe("harness:SPEC-1")

      const explicitTitleAdr = parseGovernanceDocFileChecked(
        "libs/harness/docs/adr/0010.md",
        "---\nid: harness:ADR-10\ntitle: Explicit FM Title\nstatus: accepted\n---\n# Body Heading\n",
      )
      match(explicitTitleAdr)
        .with({ _tag: "Ok" }, ({ node }) => {
          expect(node.title).toBe("Explicit FM Title")
        })
        .with({ _tag: "Skip" }, { _tag: "InvalidStatus" }, () => {
          expect.unreachable("Expected Ok for explicit title ADR")
        })
        .exhaustive()
    })

    it("F-07: preserves quoted '#' qualnames in frontmatter while stripping unquoted inline comments", () => {
      const parsed = parseGovernanceDocFileChecked(
        "libs/sample/docs/specs/quoted-hash.md",
        [
          "---",
          'id: "sample:SPEC-HASH"',
          'title: "Quoted # Title"',
          "status: accepted # unquoted inline comment",
          "enforced_by: [\"libs/sample/domain/src/index.ts#uploadPhoto\", 'libs/sample/domain/src/other.ts#savePhoto']",
          "spans:",
          '  - "libs/sample/domain/src/index.ts#uploadPhoto"',
          "  - 'libs/sample/domain/src/other.ts#savePhoto'",
          "  - Sample.cleanSpan # trailing unquoted comment",
          "services:",
          "  - PhotoRepo # inline service comment",
          "errors:",
          '  - "Photo#CustomError"',
          "---",
        ].join("\n"),
      )

      match(parsed)
        .with({ _tag: "Ok" }, ({ node }) => {
          expect(node._tag).toBe("EarsSpec")
          expect(node.id).toBe("sample:SPEC-HASH")
          expect(node.title).toBe("Quoted # Title")
          expect(node.status).toBe("accepted")
          expect(node.enforcedByFiles).toEqual([
            "libs/sample/domain/src/index.ts#uploadPhoto",
            "libs/sample/domain/src/other.ts#savePhoto",
          ])
          expect(node.referencedSpans).toEqual([
            "libs/sample/domain/src/index.ts#uploadPhoto",
            "libs/sample/domain/src/other.ts#savePhoto",
            "Sample.cleanSpan",
          ])
          expect(node.referencedServices).toEqual(["PhotoRepo"])
          expect(node.referencedErrors).toEqual(["Photo#CustomError"])
        })
        .with({ _tag: "Skip" }, { _tag: "InvalidStatus" }, () => {
          expect.unreachable("Expected Ok when parsing quoted '#' qualnames")
        })
        .exhaustive()
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
      // 15s budget: cold full-workspace TypeScript compiler extraction & governance graph assembly across process.cwd()
    }, 15_000)

    it("F-06: preserves governance status violations across topology snapshot hit and invalidates when test, pattern, or gov map size shrinks", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "harness-f06-warm-session-"))
      try {
        mkdirSync(join(tempDir, "libs/sample/infra/src"), { recursive: true })
        mkdirSync(join(tempDir, "libs/sample/infra/test"), { recursive: true })
        mkdirSync(join(tempDir, "libs/sample/docs/specs"), { recursive: true })
        mkdirSync(join(tempDir, "libs/sample/docs/adr"), { recursive: true })
        mkdirSync(join(tempDir, "agent-patterns"), { recursive: true })
        writeFileSync(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/**'\n")
        writeFileSync(
          join(tempDir, "libs/sample/infra/src/index.ts"),
          "export const infraValue = 1\n",
        )
        writeFileSync(
          join(tempDir, "libs/sample/infra/test/sample.test.ts"),
          'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
        )
        writeFileSync(
          join(tempDir, "libs/sample/docs/specs/2026-11-22-bogus.md"),
          "---\nid: harness:SPEC-9999\ntitle: Bogus\nstatus: bogus\n---\n",
        )
        writeFileSync(
          join(tempDir, "libs/sample/docs/adr/0001-valid.md"),
          "---\nid: sample:ADR-0001\ntitle: Valid ADR\nstatus: accepted\n---\n",
        )
        writeFileSync(
          join(tempDir, "agent-patterns/sample-pattern.md"),
          "# Sample Pattern\nPattern summary.\n",
        )

        const session = createTypeScriptProgramSession(tempDir, testHostIo)
        const hasBogusStatusViolation = (graph: HarnessGraph) =>
          (graph.branchingViolations ?? []).some(
            (v) =>
              v.rule === "unmapped-spec-symbol" &&
              v.enclosingSymbol === "harness:SPEC-9999" &&
              v.message.includes("bogus"),
          )

        const run1 = Effect.runSync(
          extractWorkspaceTypeAwareGraph(tempDir, testHostIo, { session }),
        )
        expect(hasBogusStatusViolation(run1)).toBe(true)
        expect(resolveNode(run1, "sample-pattern")?._tag).toBe("PatternDoc")
        expect(resolveNode(run1, "libs/sample/infra/test/sample.test.ts::suite")?._tag).toBe(
          "VitestCase",
        )
        expect(resolveNode(run1, "sample:ADR-0001")?._tag).toBe("AdrDoc")

        // (a) Edit non-governance infra .ts comment via overlay -> checkWorkspaceSnapshotMatch misses, checkTopologySnapshotMatch hits
        const commentOverlay = {
          "libs/sample/infra/src/index.ts": "export const infraValue = 1\n// comment-only edit\n",
        }
        const run2 = Effect.runSync(
          extractWorkspaceTypeAwareGraph(tempDir, testHostIo, {
            session,
            overlays: commentOverlay,
          }),
        )
        expect(run2.graph).toBe(run1.graph)
        expect(hasBogusStatusViolation(run2)).toBe(true)
        const policy2 = Effect.runSync(decideEffectGraphPolicy(run2))
        expect(policy2.ok).toBe(false)
        expect(
          policy2.violations.some(
            (v) => v.rule === "unmapped-spec-symbol" && v.message.includes("bogus"),
          ),
        ).toBe(true)

        // (b.1) Delete pattern doc -> patternShaMap.size shrinks -> topology snapshot invalidates
        rmSync(join(tempDir, "agent-patterns/sample-pattern.md"))
        const run3 = Effect.runSync(
          extractWorkspaceTypeAwareGraph(tempDir, testHostIo, {
            session,
            overlays: commentOverlay,
          }),
        )
        expect(run3.graph).not.toBe(run2.graph)
        expect(resolveNode(run3, "sample-pattern")).toBeUndefined()
        expect(hasBogusStatusViolation(run3)).toBe(true)

        // (b.2) Delete test file -> testShaMap.size shrinks -> topology snapshot invalidates
        rmSync(join(tempDir, "libs/sample/infra/test/sample.test.ts"))
        const run4 = Effect.runSync(
          extractWorkspaceTypeAwareGraph(tempDir, testHostIo, {
            session,
            overlays: commentOverlay,
          }),
        )
        expect(run4.graph).not.toBe(run3.graph)
        expect(resolveNode(run4, "libs/sample/infra/test/sample.test.ts::suite")).toBeUndefined()
        expect(hasBogusStatusViolation(run4)).toBe(true)

        // (b.3) Delete valid governance doc -> govShaMap.size shrinks -> topology snapshot invalidates
        rmSync(join(tempDir, "libs/sample/docs/adr/0001-valid.md"))
        const run5 = Effect.runSync(
          extractWorkspaceTypeAwareGraph(tempDir, testHostIo, {
            session,
            overlays: commentOverlay,
          }),
        )
        expect(run5.graph).not.toBe(run4.graph)
        expect(resolveNode(run5, "sample:ADR-0001")).toBeUndefined()
        expect(hasBogusStatusViolation(run5)).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("stripFmQuotes strips empty quoted frontmatter items (length === 2)", () => {
      const res = parseGovernanceDocFileChecked(
        "libs/sample/docs/specs/2026-11-22-empty-quotes.md",
        [
          "---",
          "id: sample:SPEC-9001",
          'title: "Empty Quotes Spec"',
          "status: accepted",
          'spans: ["Sample.validSpan", "", \'\']',
          "services:",
          '  - ""',
          "  - ''",
          "  - PhotoRepo",
          "---",
          "# Empty Quotes Spec",
        ].join("\n"),
      )
      match(res)
        .with({ _tag: "Ok" }, ({ node }) => {
          expect(node.referencedSpans).toEqual(["Sample.validSpan"])
          expect(node.referencedServices).toEqual(["PhotoRepo"])
        })
        .with({ _tag: "Skip" }, { _tag: "InvalidStatus" }, () => {
          expect.unreachable("Expected Ok governance doc result")
        })
        .exhaustive()
    })
  })
})
