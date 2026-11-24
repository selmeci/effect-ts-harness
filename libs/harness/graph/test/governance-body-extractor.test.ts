import { describe, expect, it } from "@effect/vitest"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { testHostIo } from "@harness/service/testing"
import {
  buildHarnessGraph,
  extractAdrSearchText,
  extractEarsRequirements,
  extractGovernanceSummary,
  loadPatternDocs,
  queryOntologyImpact,
  queryOntologyWhy,
} from "../src/index.js"
import { linkGovernanceDocsToGraph } from "../src/extractor/governance-body-extractor.js"
import {
  assembleTestAndGovernanceGraph,
  parseGovernanceDocFile,
} from "../src/extractor/test-and-governance-extractor.js"

describe("Governance body extractor & ArchiMate informed_by traversal (ADR-0025 / SPEC-0031)", () => {
  it("extracts informed_by ADRs and EARS table rows with backticked union types while ignoring fenced code", () => {
    const specMarkdown = `---
id: harness:SPEC-0099
title: Sample Semantic Spec
status: proposed
date: 2026-11-22
informed_by:
  - harness:ADR-0025
enforced_by:
  - libs/harness/gates/src/example.ts
spans:
  - Example.execute
---

# SPEC-0099: Sample Semantic Spec

This lead paragraph explains why three-tier retrieval separates code graphs from docs.

## 3. EARS Requirements

### Area A

| ID | EARS Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| \`REQ-1.1\` | Ubiquitous | The system shall return \`Effect<A, E, R> \\| TaggedError\` without panicking. | \`Example.execute\` | UnitTest |
| \`REQ-1.2\` | Event-driven | When cache mismatches, the system shall emit \`CacheRebuild\`. | \`Example.rebuild\` | GraphCheck |

\`\`\`markdown
| ID | EARS Pattern | Requirement | Effect Symbol | Verification |
| \`REQ-9.9\` | Ubiquitous | Fenced table row should be ignored. | \`Fake.fn\` | UnitTest |
\`\`\`

\`\`\`\`markdown
\`\`\`
# Nested inner fence
\`\`\`
| \`REQ-9.8\` | Ubiquitous | Outer 4-backtick fenced row should be ignored too. | \`Fake.fn\` | UnitTest |
\`\`\`\`
`
    const adrMarkdown = `---
id: harness:ADR-0025
title: Three-Tier Retrieval
status: accepted
date: 2026-11-22
---

# ADR-0025: Three-Tier Retrieval

## Context

Governance docs and requirements need semantic indexing alongside deterministic code graphs.

## Decision

Index PatternDoc, AdrDoc, and EarsRequirement with qwen3-embedding:8b.
`

    const specNode = parseGovernanceDocFile("libs/harness/docs/specs/0099.md", specMarkdown)
    const adrNode = parseGovernanceDocFile("libs/harness/docs/adr/0025.md", adrMarkdown)

    expect(specNode).not.toBeNull()
    expect(adrNode).not.toBeNull()

    if (specNode !== null) {
      match(specNode)
        .with({ _tag: "EarsSpec" }, (spec) => {
          expect(spec.informedByAdrs).toEqual(["harness:ADR-0025"])
          expect(spec.goalSummary).toContain("three-tier retrieval")
          expect(spec.requirements?.map((r) => r.requirementId)).toEqual(["REQ-1.1", "REQ-1.2"])
          expect(spec.requirements?.[0]?.clauseText).toContain("Effect<A, E, R>")
          expect(spec.requirements?.[0]?.effectSymbol).toBe("Example.execute")
        })
        .with({ _tag: "AdrDoc" }, () => {
          expect.unreachable("Expected EarsSpec node")
        })
        .exhaustive()
    }

    if (adrNode !== null) {
      match(adrNode)
        .with({ _tag: "AdrDoc" }, (adr) => {
          expect(adr.searchText).toContain("Governance docs and requirements")
          expect(adr.searchText).toContain("qwen3-embedding:8b")
          expect(adr.summary).toContain("Governance docs and requirements need semantic indexing")
        })
        .with({ _tag: "EarsSpec" }, () => {
          expect.unreachable("Expected AdrDoc node")
        })
        .exhaustive()
    }

    const reqRows = extractEarsRequirements(
      "harness:SPEC-0099",
      "libs/harness/docs/specs/0099.md",
      "proposed",
      specMarkdown,
    )
    expect(reqRows.map((r) => r.requirementId)).toEqual(["REQ-1.1", "REQ-1.2"])
    expect(extractAdrSearchText("Three-Tier Retrieval", adrMarkdown)).toContain("Context")
    expect(extractGovernanceSummary("EarsSpec", specMarkdown)).toContain("three-tier retrieval")
  })

  it("links EarsRequirement nodes and traverses ADR <-informed_by- EarsSpec -> EarsRequirement -> EffectFn", () => {
    const adrMarkdown = `---
id: harness:ADR-0090
title: Architecture Constraint
status: accepted
date: 2026-11-22
---

# ADR-0090

## Decision

Require deterministic synchronization boundaries.
`
    const specMarkdown = `---
id: harness:SPEC-0090
title: Sync Boundary Spec
status: accepted
date: 2026-11-22
informed_by:
  - harness:ADR-0090
enforced_by:
  - libs/harness/graph/src/sync.ts
spans:
  - Graph.syncBoundary
---

# SPEC-0090

| ID | EARS Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| \`REQ-1.1\` | Ubiquitous | The system shall validate sync boundaries deterministically. | \`Graph.syncBoundary\` | UnitTest |
`
    const adrNode = parseGovernanceDocFile("libs/harness/docs/adr/0090.md", adrMarkdown)
    const specNode = parseGovernanceDocFile("libs/harness/docs/specs/0090.md", specMarkdown)
    expect(adrNode).not.toBeNull()
    expect(specNode).not.toBeNull()

    const baseGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/harness/graph/src/sync.ts#syncBoundary",
          spanName: "Graph.syncBoundary",
          packageTag: "domain",
          file: "libs/harness/graph/src/sync.ts",
          line: 12,
          isStub: false,
        },
      ],
    })

    const mutable = Graph.beginMutation(baseGraph.graph)
    const nodeIndexByKey = new Map(baseGraph.nodeIndexByKey)
    const effectFns = [
      {
        _tag: "EffectFn" as const,
        qualname: "libs/harness/graph/src/sync.ts#syncBoundary",
        spanName: "Graph.syncBoundary",
        packageTag: "domain" as const,
        file: "libs/harness/graph/src/sync.ts",
        line: 12,
        isStub: false,
      },
    ]
    linkGovernanceDocsToGraph(mutable, [adrNode!, specNode!], effectFns, [], [], nodeIndexByKey, [])
    const hydrated = {
      ...baseGraph,
      graph: Graph.endMutation(mutable),
      nodeIndexByKey,
    }

    const why = queryOntologyWhy(hydrated, "Graph.syncBoundary")
    expect(why.justified).toBe(true)
    expect(why.realizingSpecs.map((s) => s.id)).toContain("harness:SPEC-0090")
    expect(why.realizingSpecs[0]?.requirementIds).toContain("REQ-1.1")
    expect(why.governingAdrs.map((a) => a.id)).toContain("harness:ADR-0090")

    const impact = queryOntologyImpact(hydrated, "harness:ADR-0090")
    expect(impact.affectedSpecs).toContain("harness:SPEC-0090")
    expect(impact.impactedSpans).toContain("Graph.syncBoundary")
  })

  it("extracts PatternDoc title, headings, summary, coveredSpans, and coveredTags", () => {
    const files = new Map<string, string>([
      [
        "/repo/agent-patterns/planning.md",
        `# Effect Planning Pattern

Define schemas and error models before writing implementations. Use \`DecisionModel.decide\` and \`@harness/gates\`.

\`\`\`ts
// # Fake Heading In Code Fence
\`\`\`

## EARS Mapping

Keep failures typed with \`DocTreePathError\`.
`,
      ],
    ])
    const fakeHostIo = {
      ...testHostIo,
      existsSync: (p: string) => p === "/repo/agent-patterns" || files.has(p),
      readdirSync: (p: string) =>
        p === "/repo/agent-patterns"
          ? [{ name: "planning.md", isFile: true, isDirectory: false }]
          : [],
      readTextSync: (p: string) => files.get(p) ?? "",
    }
    const docs = loadPatternDocs("/repo", fakeHostIo)
    expect(docs).toHaveLength(1)
    const pattern = docs[0]!
    expect(pattern.slug).toBe("planning")
    expect(pattern.title).toBe("Effect Planning Pattern")
    expect(pattern.headings).toEqual(["EARS Mapping"])
    expect(pattern.headings).not.toContain("Fake Heading In Code Fence")
    expect(pattern.summary).toContain("Define schemas and error models")
    expect(pattern.coveredSpans).toContain("DecisionModel.decide")
    expect(pattern.coveredTags).toContain("@harness/gates")
    expect(pattern.coveredTags).toContain("DocTreePathError")
  })

  it("wires EarsRequirement, TraceabilityTuple, and informedByAdrs via assembleTestAndGovernanceGraph", () => {
    const adrDoc = parseGovernanceDocFile(
      "libs/harness/docs/adr/0091.md",
      `---
id: harness:ADR-0091
title: Assembled Decision
status: accepted
date: 2026-11-22
---

## Decision Outcome

**Chosen option:** "Use Effect.fn spans", because traces link specs directly.
`,
    )
    const specDoc = parseGovernanceDocFile(
      "libs/harness/docs/specs/0091.md",
      `---
id: harness:SPEC-0091
title: Assembled Spec
status: accepted
date: 2026-11-22
informed_by:
  - harness:ADR-0091
spans:
  - Demo.assemble
---

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| \`REQ-1.1\` | Event-driven | When assembled, the graph shall link \`Demo.assemble\`. | \`Demo.assemble\` | UnitTest |
`,
    )
    expect(adrDoc).not.toBeNull()
    expect(specDoc).not.toBeNull()

    const baseGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/harness/graph/src/assemble.ts#run",
          spanName: "Demo.assemble",
          packageTag: "domain",
          file: "libs/harness/graph/src/assemble.ts",
          line: 8,
          isStub: false,
        },
      ],
    })
    const mutable = Graph.beginMutation(baseGraph.graph)
    const updatedNodeIndexByKey = new Map(baseGraph.nodeIndexByKey)
    const effectFns = [
      {
        _tag: "EffectFn" as const,
        qualname: "libs/harness/graph/src/assemble.ts#run",
        spanName: "Demo.assemble",
        packageTag: "domain" as const,
        file: "libs/harness/graph/src/assemble.ts",
        line: 8,
        isStub: false,
      },
    ]

    assembleTestAndGovernanceGraph(
      mutable,
      [],
      new Map(),
      [adrDoc!, specDoc!],
      effectFns,
      [],
      [],
      [],
      updatedNodeIndexByKey,
      [],
      "/repo",
      testHostIo,
    )

    const assembledGraph = {
      ...baseGraph,
      graph: Graph.endMutation(mutable),
      nodeIndexByKey: updatedNodeIndexByKey,
    }

    const reqNodeIdx = assembledGraph.nodeIndexByKey.get(
      "EarsRequirement:harness:SPEC-0091::REQ-1.1",
    )
    expect(reqNodeIdx).toBeDefined()
    const whyFromSymbol = queryOntologyWhy(assembledGraph, "Demo.assemble")
    expect(whyFromSymbol.realizingSpecs[0]?.requirementIds).toContain("REQ-1.1")
    expect(whyFromSymbol.governingAdrs.map((a) => a.id)).toContain("harness:ADR-0091")

    const whyFromReq = queryOntologyWhy(assembledGraph, "harness:SPEC-0091::REQ-1.1")
    expect(whyFromReq.realizingSpecs[0]?.requirementIds).toContain("REQ-1.1")
  })
})
