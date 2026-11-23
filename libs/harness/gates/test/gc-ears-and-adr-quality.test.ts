import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { buildHarnessGraph, extractTypeAwareGraphFromSource } from "@harness/graph"
import {
  decideEarsConsistency,
  decideEarsSpecQuality,
  decideGraphEntropy,
  type EarsConsistencyError,
  type EarsConsistencyInput,
  type EarsConsistencyReport,
} from "../src/index.js"

describe("decideEarsSpecQuality (EarsSpecLint.decide)", () => {
  it.effect(
    "accepts a valid EARS spec with sequential areas, **Source:**, and valid REQ rows",
    () =>
      Effect.gen(function* () {
        const validMarkdown = `## Requirements

### 1 · Photo Gallery Core
**Source (API contract):** Defined in contract package.

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Ubiquitous | The Photo schema **shall** validate all photo identifiers. | Photo | test |
| REQ-1.2 | Event-driven | **When** a user requests a photo by ID, The PhotoService **shall** query the repository. | PhotoService.getPhoto | test |
| REQ-1.3 | Unwanted behaviour | **If** photo is missing, **then** The PhotoService **shall** fail with NotFoundError. | NotFoundError | test |
`
        const report = yield* decideEarsSpecQuality({
          docPath: "docs/specs/valid.md",
          markdown: validMarkdown,
        })
        expect(report.clean).toBe(true)
        expect(report.requirementCount).toBe(3)
        expect(report.findings).toHaveLength(0)
      }),
  )

  it.effect(
    "rejects generic subject, weak modal, compound obligation, pattern mismatch, numbering gap, and forbidden column",
    () =>
      Effect.gen(function* () {
        // 1. Generic subject
        const genericSubjMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The system **shall** validate input. | test |\n`
        const genericReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: genericSubjMd,
        })
        expect(genericReport.clean).toBe(false)
        expect(genericReport.findings.some((f) => f.kind === "generic-subject")).toBe(true)

        // 2. Weak modal
        const weakModalMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService should validate input. | test |\n`
        const weakReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: weakModalMd,
        })
        expect(weakReport.clean).toBe(false)
        expect(weakReport.findings.some((f) => f.kind === "weak-modal")).toBe(true)

        // 3. Compound obligation
        const compoundMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService **shall** save the record **and shall** notify subscribers. | test |\n`
        const compoundReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: compoundMd,
        })
        expect(compoundReport.clean).toBe(false)
        expect(compoundReport.findings.some((f) => f.kind === "compound-obligation")).toBe(true)

        // 4. Pattern mismatch
        const patternMismatchMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Event-driven | The PhotoService **shall** save the record immediately. | test |\n`
        const mismatchReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: patternMismatchMd,
        })
        expect(mismatchReport.clean).toBe(false)
        expect(mismatchReport.findings.some((f) => f.kind === "pattern-keyword-mismatch")).toBe(
          true,
        )

        // 5. Numbering gap
        const gapMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService **shall** step 1. | test |\n| REQ-1.3 | Ubiquitous | The PhotoService **shall** step 3. | test |\n`
        const gapReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: gapMd,
        })
        expect(gapReport.clean).toBe(false)
        expect(gapReport.findings.some((f) => f.kind === "numbering-gap")).toBe(true)

        // 6. Forbidden column
        const forbiddenMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Status | Pattern | Requirement | Verification |\n|---|---|---|---|---|\n| REQ-1.1 | Done | Ubiquitous | The PhotoService **shall** step 1. | test |\n`
        const forbiddenReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: forbiddenMd,
        })
        expect(forbiddenReport.clean).toBe(false)
        expect(forbiddenReport.findings.some((f) => f.kind === "forbidden-column")).toBe(true)
      }),
  )

  it.effect(
    "flags ears-spec-lint in decideGraphEntropy when governance doc has EARS violations",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({})
        const report = yield* decideGraphEntropy({
          graph,
          governanceDocs: [
            {
              docPath: "libs/sample/docs/specs/2026-10-27-broken.md",
              id: "sample:SPEC-BROKEN",
              status: "accepted",
              markdown: "No requirements table in this file.",
            },
          ],
        })
        expect(report.clean).toBe(false)
        const finding = report.findings.find((f) => f.kind === "ears-spec-lint")
        expect(finding).toBeDefined()
        expect(finding?.nodeId).toBe("sample:SPEC-BROKEN")
        expect(finding?.message).toContain("no-requirements-table")
      }),
  )

  it.effect.prop(
    "EarsSpecLint.decide: validates N generated requirements cleanly",
    {
      requirementCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
    },
    ({ requirementCount }) =>
      Effect.gen(function* () {
        const rows = Array.from(
          { length: requirementCount },
          (_, i) =>
            `| REQ-1.${i + 1} | Ubiquitous | The Service${i + 1} **shall** execute step ${i + 1}. | test |`,
        ).join("\n")

        const md = `## Requirements\n\n### 1 · Area\n**Source:** test source\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n${rows}\n`

        const report = yield* decideEarsSpecQuality({
          docPath: "docs/specs/generated.md",
          markdown: md,
        })

        expect(report.clean).toBe(true)
        expect(report.requirementCount).toBe(requirementCount)
        expect(report.requirements).toHaveLength(requirementCount)
        expect(report.findings).toHaveLength(0)
      }),
  )

  it.effect("rejects legacy Effect v3 ParseError in requirement prose", () =>
    Effect.gen(function* () {
      const md = `## Requirements

### 1 · Area
**Source:** test source

| ID | Pattern | Requirement | Verification |
|---|---|---|---|
| REQ-1.1 | Unwanted behaviour | **If** input is invalid, **then** the decoder **shall** fail with ParseError. | test |
`
      const report = yield* decideEarsSpecQuality({
        docPath: "docs/specs/test.md",
        markdown: md,
      })
      expect(report.clean).toBe(false)
      const finding = report.findings.find((f) => f.kind === "legacy-effect-v3-symbol")
      expect(finding).toBeDefined()
      expect(finding?.message).toBe(
        "Requirement REQ-1.1 references legacy Effect v3 symbol (use Effect v4 Schema.SchemaError / Context.Service instead).",
      )
    }),
  )

  it.effect(
    "flags defect-polarity-inversion when requirement specifies without dying on unexpected defects",
    () =>
      Effect.gen(function* () {
        const md = `## Requirements

### 1 · Area
**Source:** test source

| ID | Pattern | Requirement | Verification |
|---|---|---|---|
| REQ-1.1 | Unwanted behaviour | **If** invalid input occurs, **then** the harness **shall** fail without dying on unexpected defects. | test |
`
        const report = yield* decideEarsSpecQuality({
          docPath: "docs/specs/test.md",
          markdown: md,
        })
        expect(report.clean).toBe(false)
        const finding = report.findings.find((f) => f.kind === "defect-polarity-inversion")
        expect(finding).toBeDefined()
        expect(finding?.message).toContain(
          "REQ-1.1 inverts defect safety polarity ('without dying on ... defects')",
        )
      }),
  )

  it.effect(
    "flags stale-temporal-context in status: accepted EARS specs, ignoring status: proposed and fenced code blocks",
    () =>
      Effect.gen(function* () {
        const acceptedMd = `---
id: SPEC-0099
status: accepted
---

## Context
Today, the router lacks deterministic fallback handling.

\`\`\`ts
// Currently, this is inside a fenced code block
\`\`\`

\`\`\`markdown
Currently, this is inside a fenced code block and must be ignored.
\`\`\`

## Requirements

### 1 · Area
**Source:** test source

| ID | Pattern | Requirement | Verification |
|---|---|---|---|
| REQ-1.1 | Ubiquitous | The harness **shall** route deterministically. | test |
`
        const acceptedReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/accepted.md",
          markdown: acceptedMd,
        })
        expect(acceptedReport.clean).toBe(false)
        const temporalFindings = acceptedReport.findings.filter(
          (f) => f.kind === "stale-temporal-context",
        )
        expect(temporalFindings).toHaveLength(1)
        expect(temporalFindings[0]?.line).toBe(7)

        const proposedMd = acceptedMd.replace("status: accepted", "status: proposed")
        const proposedReport = yield* decideEarsSpecQuality({
          docPath: "docs/specs/proposed.md",
          markdown: proposedMd,
        })
        expect(proposedReport.findings.some((f) => f.kind === "stale-temporal-context")).toBe(false)
      }),
  )

  it.effect(
    "SPEC-0029 REQ-3.1/REQ-3.2/REQ-4.2/REQ-4.3: enforces Effect Symbol frontmatter ownership and fails closed on invalid status",
    () =>
      Effect.gen(function* () {
        const validDraft = `---
id: harness:SPEC-9991
title: Owned Draft
status: draft
spans: [Alpha.decide]
services:
  - "@harness/graph/OmnigraphSync"
errors:
  - AlphaFailedError
---

## Requirements

### 1 · Ownership
**Source:** Verified ownership.

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Event-driven | **When** Alpha runs, Alpha.decide **shall** complete. | \`Alpha.decide\` | UnitTest |
| REQ-1.2 | Ubiquitous | OmnigraphSync **shall** persist schemas. | OmnigraphSync | UnitTest |
| REQ-1.3 | Unwanted behaviour | **If** Alpha breaks, **then** Alpha.decide **shall** fail with AlphaFailedError. | AlphaFailedError | UnitTest |
| REQ-1.4 | Ubiquitous | Schema types **shall** validate inputs. | — | UnitTest |
`
        const validReport = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/valid-draft.md",
          markdown: validDraft,
        })
        expect(validReport.clean).toBe(true)

        const unownedMd = validDraft.replace("| `Alpha.decide` |", "| Ghost.decide |")
        const unownedReport = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/unowned.md",
          markdown: unownedMd,
        })
        expect(unownedReport.clean).toBe(false)
        const ownershipFinding = unownedReport.findings.find(
          (f) => f.kind === "spec-source-symbol-ownership",
        )
        expect(ownershipFinding).toBeDefined()
        expect(ownershipFinding?.message).toContain("REQ-1.1")
        expect(ownershipFinding?.message).toContain("Ghost.decide")

        const badStatusMd = validDraft.replace("status: draft", "status: bogus_status")
        const badStatusReport = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/bad-status.md",
          markdown: badStatusMd,
        })
        expect(badStatusReport.clean).toBe(false)
        expect(
          badStatusReport.findings.some(
            (f) => f.kind === "invalid-frontmatter-status" && f.line === 4,
          ),
        ).toBe(true)

        const emptyQuotedStatusReport = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/empty-status.md",
          markdown: validDraft.replace("status: draft", 'status: ""'),
        })
        expect(
          emptyQuotedStatusReport.findings.some(
            (f) => f.kind === "invalid-frontmatter-status" && f.message.includes("'<missing>'"),
          ),
        ).toBe(true)

        const draftGenericMd = validDraft.replace(
          "Alpha.decide **shall** complete",
          "the system **shall** complete",
        )
        const draftGenericReport = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/draft-generic.md",
          markdown: draftGenericMd,
        })
        expect(draftGenericReport.findings.some((f) => f.kind === "generic-subject")).toBe(true)
      }),
  )

  it.effect.prop(
    "SPEC-0029 REQ-3.1/REQ-3.2 property: undeclared Effect Symbol triggers spec-source-symbol-ownership",
    { suffix: Schema.Literals(["One", "Two", "Three"]) },
    ({ suffix }) =>
      Effect.gen(function* () {
        const md = `---
id: harness:SPEC-9992
title: Prop
status: proposed
spans:
  - Owned.fn${suffix}
---

## Requirements

### 1 · Area
**Source:** test source

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Ubiquitous | The Owned.fn${suffix} handler **shall** run. | Unowned.fn${suffix} | UnitTest |
`
        const report = yield* decideEarsSpecQuality({
          docPath: "libs/harness/docs/specs/prop.md",
          markdown: md,
        })
        expect(
          report.findings.some(
            (f) =>
              f.kind === "spec-source-symbol-ownership" &&
              f.message.includes(`Unowned.fn${suffix}`),
          ),
        ).toBe(true)
      }),
  )

  it.effect("SPEC-0029 REQ-3.3: EarsConsistency.decide preserves R = never purity", () =>
    Effect.sync(() => {
      const checkPurity: (
        input: EarsConsistencyInput,
      ) => Effect.Effect<EarsConsistencyReport, EarsConsistencyError, never> = decideEarsConsistency
      expect(typeof checkPurity).toBe("function")

      let root = process.cwd()
      while (root !== dirname(root)) {
        if (existsSync(join(root, "pnpm-workspace.yaml"))) break
        root = dirname(root)
      }
      const sourcePath = "libs/harness/gates/src/ears-consistency.ts"
      const graph = extractTypeAwareGraphFromSource([
        {
          filePath: sourcePath,
          content: readFileSync(join(root, sourcePath), "utf8"),
          packageTag: "domain",
        },
      ])
      let foundSpan = false
      let requiredServicesCount = -1
      for (const [, node] of Graph.nodes(graph.graph)) {
        match(node)
          .with({ _tag: "EffectFn" }, (fnNode) => {
            if (fnNode.spanName === "EarsConsistency.decide") {
              foundSpan = true
            }
          })
          .with({ _tag: "EffectSignature" }, (sigNode) => {
            if (sigNode.callerQualname.endsWith("#decideEarsConsistency")) {
              requiredServicesCount = sigNode.requiredServices.length
            }
          })
          .with(
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      expect(foundSpan).toBe(true)
      expect(requiredServicesCount).toBe(0)
    }),
  )
})
