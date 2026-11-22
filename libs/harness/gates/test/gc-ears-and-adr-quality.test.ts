import { describe, expect, it } from "@effect/vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import {
  decideAdrDocQuality,
  decideEarsSpecQuality,
  decideGraphEntropy,
  evaluatePackageAndMigrationPlugin,
  type GovernanceDocReference,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("Harness Gates: EARS Spec Quality and ADR Doc Quality", () => {
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
          expect(proposedReport.findings.some((f) => f.kind === "stale-temporal-context")).toBe(
            false,
          )
        }),
    )
  })

  describe("decideAdrDocQuality / lintAdrDocMarkdown", () => {
    const validCanonicalAdr = `---
id: test:ADR-0001
title: Deterministic ADR Linting
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Deterministic ADR Linting

## Context and Problem Statement

ADR documents need to follow canonical MADR format to ensure architectural integrity.
1. Documents drift without linter.
2. Unfilled placeholders slip into production.

We need automated mechanical gating.

## Decision Drivers

* Guarantee canonical 6-section MADR structure across all ADRs.
* Deterministically verify frontmatter, chosen options, and rejected alternatives.

## Considered Options

* **Option 1:** Pure TypeScript AST & Markdown Decider.
* **Option 2:** Unstructured Markdown without Linting.

## Decision Outcome

**Chosen option:** "Option 1" because deterministic gates provide instant mechanical feedback.

## Rejected Alternatives

### 1 · Unstructured Markdown without Linting
- **Why rejected:** Causes documentation drift and broken references across repos.

## Consequences and Enforcement

### Positive Consequences
- ADRs remain consistently structured and parseable.

### Negative Consequences and Trade-offs
- Authors must adhere to strict markdown sections.

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Canonical MADR | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`

    it.effect("accepts valid canonical ADR documents", () =>
      Effect.gen(function* () {
        const report = yield* decideAdrDocQuality({
          docPath: "docs/adr/test.md",
          markdown: validCanonicalAdr,
        })
        expect(report.clean).toBe(true)
        expect(report.findings).toHaveLength(0)

        let root = process.cwd()
        while (root !== dirname(root)) {
          if (existsSync(join(root, "pnpm-workspace.yaml"))) {
            break
          }
          root = dirname(root)
        }

        const harnessAdr = readFileSync(
          join(root, "libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md"),
          "utf8",
        )
        const harnessReport = yield* decideAdrDocQuality({
          docPath: "libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md",
          markdown: harnessAdr,
        })
        expect(harnessReport.clean).toBe(true)
        expect(harnessReport.findings).toHaveLength(0)

        const sampleAdr = readFileSync(
          join(
            root,
            "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
          ),
          "utf8",
        )
        const sampleReport = yield* decideAdrDocQuality({
          docPath:
            "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
          markdown: sampleAdr,
        })
        expect(sampleReport.clean).toBe(true)
        expect(sampleReport.findings).toHaveLength(0)
      }),
    )

    it.effect(
      "rejects invalid frontmatter (missing enforced_by, missing symbols, superseded without superseded_by)",
      () =>
        Effect.gen(function* () {
          // 1. Missing frontmatter entirely
          const noFmReport = yield* decideAdrDocQuality({
            docPath: "test.md",
            markdown: "# No Frontmatter",
          })
          expect(noFmReport.clean).toBe(false)
          expect(noFmReport.findings.some((f) => f.kind === "adr-frontmatter-invalid")).toBe(true)

          // 2. Missing enforced_by
          const noEnforcedMd = `---
id: test:ADR-0001
title: Test
status: accepted
date: 2026-10-27
spans:
  - AdrDocLint.decide
---
`
          const noEnforcedReport = yield* decideAdrDocQuality({
            docPath: "test.md",
            markdown: noEnforcedMd,
          })
          expect(noEnforcedReport.clean).toBe(false)
          expect(
            noEnforcedReport.findings.some(
              (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("enforced_by"),
            ),
          ).toBe(true)

          // 3. Missing governed symbols
          const noSymbolsMd = `---
id: test:ADR-0001
title: Test
status: accepted
date: 2026-10-27
enforced_by:
  - some/file.ts
---
`
          const noSymbolsReport = yield* decideAdrDocQuality({
            docPath: "test.md",
            markdown: noSymbolsMd,
          })
          expect(noSymbolsReport.clean).toBe(false)
          expect(
            noSymbolsReport.findings.some(
              (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("govern"),
            ),
          ).toBe(true)

          // 4. Superseded without superseded_by
          const supersededMd = `---
id: test:ADR-0001
title: Test
status: superseded
date: 2026-10-27
enforced_by:
  - some/file.ts
spans:
  - AdrDocLint.decide
---
`
          const supersededReport = yield* decideAdrDocQuality({
            docPath: "test.md",
            markdown: supersededMd,
          })
          expect(supersededReport.clean).toBe(false)
          expect(
            supersededReport.findings.some(
              (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("superseded_by"),
            ),
          ).toBe(true)
        }),
    )

    it.effect("rejects missing or out-of-order canonical sections", () =>
      Effect.gen(function* () {
        // Missing section
        const missingSectionMd = validCanonicalAdr.replace(
          "## Decision Drivers\n\n* Guarantee canonical 6-section MADR structure across all ADRs.\n* Deterministically verify frontmatter, chosen options, and rejected alternatives.",
          "",
        )
        const missingReport = yield* decideAdrDocQuality({
          docPath: "test.md",
          markdown: missingSectionMd,
        })
        expect(missingReport.clean).toBe(false)
        expect(
          missingReport.findings.some(
            (f) => f.kind === "adr-section-structure" && f.message.includes("Decision Drivers"),
          ),
        ).toBe(true)

        // Out of order sections
        const outOfOrderMd = validCanonicalAdr
          .replace("## Decision Drivers", "## TEMP_MARKER")
          .replace("## Considered Options", "## Decision Drivers")
          .replace("## TEMP_MARKER", "## Considered Options")
        const outOfOrderReport = yield* decideAdrDocQuality({
          docPath: "test.md",
          markdown: outOfOrderMd,
        })
        expect(outOfOrderReport.clean).toBe(false)
        expect(
          outOfOrderReport.findings.some(
            (f) => f.kind === "adr-section-structure" && f.message.includes("out of order"),
          ),
        ).toBe(true)
      }),
    )

    it.effect("rejects missing chosen option in Decision Outcome", () =>
      Effect.gen(function* () {
        const noChosenMd = validCanonicalAdr.replace(
          '**Chosen option:** "Option 1" because deterministic gates provide instant mechanical feedback.',
          "We chose Option 1 after careful evaluation.",
        )
        const report = yield* decideAdrDocQuality({ docPath: "test.md", markdown: noChosenMd })
        expect(report.clean).toBe(false)
        expect(report.findings.some((f) => f.kind === "adr-missing-chosen-option")).toBe(true)
      }),
    )

    it.effect(
      "rejects malformed rejected alternatives (missing ### 1 · or missing **Why rejected:**)",
      () =>
        Effect.gen(function* () {
          // Missing ### 1 · subsection
          const noSubMd = validCanonicalAdr.replace(
            "### 1 · Unstructured Markdown without Linting\n- **Why rejected:** Causes documentation drift and broken references across repos.",
            "We considered unstructured markdown but didn't write it up.",
          )
          const noSubReport = yield* decideAdrDocQuality({ docPath: "test.md", markdown: noSubMd })
          expect(noSubReport.clean).toBe(false)
          expect(
            noSubReport.findings.some((f) => f.kind === "adr-rejected-alternative-structure"),
          ).toBe(true)

          // Missing **Why rejected:**
          const noWhyMd = validCanonicalAdr.replace("**Why rejected:**", "Reason for rejection:")
          const noWhyReport = yield* decideAdrDocQuality({ docPath: "test.md", markdown: noWhyMd })
          expect(noWhyReport.clean).toBe(false)
          expect(
            noWhyReport.findings.some(
              (f) =>
                f.kind === "adr-rejected-alternative-structure" &&
                f.message.includes("Why rejected"),
            ),
          ).toBe(true)
        }),
    )

    it.effect("rejects missing enforcement table under Consequences and Enforcement", () =>
      Effect.gen(function* () {
        const noTableMd = validCanonicalAdr.replace(
          /\| Rule \|[\s\S]*\| `AdrDocLint\.decide` \|/,
          "Enforcement is handled through code review.",
        )
        const report = yield* decideAdrDocQuality({ docPath: "test.md", markdown: noTableMd })
        expect(report.clean).toBe(false)
        expect(report.findings.some((f) => f.kind === "adr-missing-enforcement-table")).toBe(true)
      }),
    )

    it.effect(
      "flags adr-doc-lint in decideGraphEntropy when governance doc has ADR violations",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({})
          const report = yield* decideGraphEntropy({
            graph,
            governanceDocs: [
              {
                docPath: "libs/sample/docs/adr/0002-broken.md",
                id: "sample:ADR-0002",
                status: "accepted",
                markdown: "# Broken ADR\n\nNo frontmatter here.",
              },
            ],
          })
          expect(report.clean).toBe(false)
          const finding = report.findings.find((f) => f.kind === "adr-doc-lint")
          expect(finding).toBeDefined()
          expect(finding?.nodeId).toBe("sample:ADR-0002")
          expect(finding?.message).toContain("adr-frontmatter-invalid")
        }),
    )

    it.effect.prop(
      "AdrDocLint.decide: validates canonical ADR with N rejected alternatives and M drivers cleanly",
      {
        rejectedCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        driverCount: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
      },
      ({ rejectedCount, driverCount }) =>
        Effect.gen(function* () {
          const drivers = Array.from(
            { length: driverCount },
            (_, i) => `* Driver requirement ${i + 1} for architectural compliance`,
          ).join("\n")

          const options = Array.from(
            { length: rejectedCount + 1 },
            (_, i) => `* **Option ${i + 1}:** Approach ${i + 1}`,
          ).join("\n")

          const rejectedAlternatives = Array.from(
            { length: rejectedCount },
            (_, i) =>
              `### ${i + 1} · Option ${i + 2}\n- **Why rejected:** Reasons for rejecting option ${i + 2}.`,
          ).join("\n\n")

          const md = `---
id: test:ADR-0001
title: Test Architectural Decision Record
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test Architectural Decision Record

## Context and Problem Statement

Context and problem statement details here.

## Decision Drivers

${drivers}

## Considered Options

${options}

## Decision Outcome

**Chosen option:** "Option 1" because it satisfies all drivers.

## Rejected Alternatives

${rejectedAlternatives}

## Consequences and Enforcement

### Positive Consequences
- Positive outcome 1

### Negative Consequences and Trade-offs
- Trade-off 1

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Lint ADRs | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`

          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test-0001.md",
            markdown: md,
          })

          expect(report.clean).toBe(true)
          expect(report.findings).toHaveLength(0)
        }),
    )

    it.effect(
      "flags adr-enforcement-mismatch when Governed Symbols entry is not declared in frontmatter or cell is empty",
      () =>
        Effect.gen(function* () {
          const adrWithUndeclaredSymbol = `---
id: test:ADR-0001
title: Test ADR
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test ADR

## Context and Problem Statement
Context description here.

## Decision Drivers
* Driver 1

## Considered Options
* Option 1

## Decision Outcome
**Chosen option:** "Option 1"

## Rejected Alternatives
### 1 · Option 2
- **Why rejected:** Reasons

## Consequences and Enforcement
### Positive Consequences
- Good things

### Negative Consequences and Trade-offs
- Tradeoffs

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Check Rule | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`UndeclaredSymbol\` |
`
          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrWithUndeclaredSymbol,
          })
          expect(report.clean).toBe(false)
          const mismatch = report.findings.find((f) => f.kind === "adr-enforcement-mismatch")
          expect(mismatch).toBeDefined()
          expect(mismatch?.message).toContain("UndeclaredSymbol")

          const adrWithPlaceholderCell = adrWithUndeclaredSymbol.replace(
            "| Check Rule | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | `UndeclaredSymbol` |",
            "| Check Rule | - | AdrDocLint.decide | `AdrDocLint.decide` |",
          )
          const placeholderReport = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrWithPlaceholderCell,
          })
          expect(placeholderReport.clean).toBe(false)
          const placeholderMismatch = placeholderReport.findings.find(
            (f) => f.kind === "adr-enforcement-mismatch",
          )
          expect(placeholderMismatch).toBeDefined()
          expect(placeholderMismatch?.message).toContain("empty or placeholder cell")
        }),
    )

    it.effect(
      "flags adr-enforcement-mismatch when Enforced By path is not declared in frontmatter enforced_by",
      () =>
        Effect.gen(function* () {
          const adrWithUndeclaredFile = `---
id: test:ADR-0001
title: Test ADR
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/contract/src/stub.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test ADR

## Context and Problem Statement
Context description here.

## Decision Drivers
* Driver 1
* Driver 2

## Considered Options
* Option 1
* Option 2

## Decision Outcome
**Chosen option:** "Option 1"

## Rejected Alternatives
### 1 · Option 2
- **Why rejected:** Reasons

## Consequences and Enforcement
### Positive Consequences
- Good things

### Negative Consequences and Trade-offs
- Tradeoffs

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Check Rule | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`
          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrWithUndeclaredFile,
          })
          expect(report.clean).toBe(false)
          const mismatch = report.findings.find(
            (f) =>
              f.kind === "adr-enforcement-mismatch" &&
              f.message.includes("is not declared in ADR frontmatter 'enforced_by'"),
          )
          expect(mismatch).toBeDefined()
          expect(mismatch?.message).toContain("libs/harness/gates/src/adr-lint.ts")
        }),
    )

    it.effect(
      "flags adr-enforcement-mismatch when Decision Outcome references unconfigured Nx tag scope:fixture as a rule",
      () =>
        Effect.gen(function* () {
          const adrWithScopeFixture = `---
id: test:ADR-0001
title: Test ADR
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test ADR

## Context and Problem Statement
Context description here.

## Decision Drivers
* Driver 1
* Driver 2

## Considered Options
* Option 1
* Option 2

## Decision Outcome
**Chosen option:** "Option 1"

Every domain fixture must have the scope:fixture tag applied in project.json.

## Rejected Alternatives
### 1 · Option 2
- **Why rejected:** Reasons

## Consequences and Enforcement
### Positive Consequences
- Good things

### Negative Consequences and Trade-offs
- Tradeoffs

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Check Rule | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`
          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrWithScopeFixture,
          })
          expect(report.clean).toBe(false)
          const fixtureMismatch = report.findings.find(
            (f) => f.kind === "adr-enforcement-mismatch" && f.message.includes("scope:fixture"),
          )
          expect(fixtureMismatch).toBeDefined()
          expect(fixtureMismatch?.message).toContain(
            "references unconfigured Nx tag 'scope:fixture' as a rule — 'scope:fixture' is not configured in nx.json.",
          )
        }),
    )

    it.effect(
      "flags adr-enforcement-mismatch when frontmatter enforced_by file is missing from Deterministic Enforcement table",
      () =>
        Effect.gen(function* () {
          const adrMissingFromTable = `---
id: test:ADR-0001
title: Test ADR
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
  - libs/harness/gates/src/adr-enforcement-table-lint.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/queries/harness.gq
  - libs/harness/graph/cluster.yaml
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test ADR

## Context and Problem Statement
Context description here.

## Decision Drivers
* Driver 1
* Driver 2

## Considered Options
* Option 1
* Option 2

## Decision Outcome
**Chosen option:** "Option 1"

## Rejected Alternatives
### 1 · Option 2
- **Why rejected:** Reasons

## Consequences and Enforcement
### Positive Consequences
- Good things

### Negative Consequences and Trade-offs
- Tradeoffs

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Check $O(\\|T\\| + \\|F\\|)$ Rule | \`libs/harness/gates/src/adr-lint.ts\`, \`libs/harness/graph/schema.pg\` | AdrDocLint.decide | \`AdrDocLint.decide\` |
`
          const failReport = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrMissingFromTable,
          })
          expect(failReport.clean).toBe(false)
          const missingMessages = failReport.findings
            .filter((f) => f.kind === "adr-enforcement-mismatch")
            .map((f) => f.message)
          expect(
            missingMessages.some((m) =>
              m.includes("libs/harness/gates/src/adr-enforcement-table-lint.ts"),
            ),
          ).toBe(true)
          expect(
            missingMessages.some((m) => m.includes("libs/harness/graph/queries/harness.gq")),
          ).toBe(true)
          expect(missingMessages.some((m) => m.includes("libs/harness/graph/cluster.yaml"))).toBe(
            true,
          )

          const completeAdr = adrMissingFromTable.replace(
            "`libs/harness/gates/src/adr-lint.ts`, `libs/harness/graph/schema.pg`",
            "`libs/harness/gates/src/adr-lint.ts`, `libs/harness/gates/src/adr-enforcement-table-lint.ts`, `libs/harness/graph/schema.pg`, `libs/harness/graph/queries/harness.gq`, `libs/harness/graph/cluster.yaml`",
          )
          const okReport = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: completeAdr,
          })
          expect(okReport.clean).toBe(true)
          expect(okReport.findings).toHaveLength(0)
        }),
    )

    it.effect.prop(
      "enforces bidirectional equality between enforced_by frontmatter and Deterministic Enforcement table",
      {
        scenario: Schema.Struct({
          extraInFrontmatter: Schema.Boolean,
          extraInTable: Schema.Boolean,
        }),
      },
      ({ scenario: { extraInFrontmatter, extraInTable } }) =>
        Effect.gen(function* () {
          const f1 = "libs/harness/gates/src/adr-lint.ts"
          const f2 = "libs/harness/gates/src/adr-enforcement-table-lint.ts"
          const f3 = "libs/harness/graph/schema.pg"
          const fmFiles = [f1, ...(extraInFrontmatter ? [f2] : [])]
          const tblFiles = [f1, ...(extraInTable ? [f3] : [])]
          const md = `---
id: test:ADR-0001
title: Bidirectional Check
status: accepted
date: 2026-10-27
enforced_by:
${fmFiles.map((p) => `  - ${p}`).join("\n")}
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Bidirectional Check

## Context and Problem Statement
Context description here.

## Decision Drivers
* Driver 1
* Driver 2

## Considered Options
* Option 1
* Option 2

## Decision Outcome
**Chosen option:** "Option 1"

## Rejected Alternatives
### 1 · Option 2
- **Why rejected:** Reasons

## Consequences and Enforcement
### Positive Consequences
- Good things

### Negative Consequences and Trade-offs
- Tradeoffs

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Bidirectional Parity | ${tblFiles.map((p) => `\`${p}\``).join(", ")} | AdrDocLint.decide | \`AdrDocLint.decide\` |
`
          const report = yield* decideAdrDocQuality({ docPath: "docs/adr/prop.md", markdown: md })
          expect(report.clean).toBe(!extraInFrontmatter && !extraInTable)
        }),
    )

    it.effect(
      "flags adr-overstated-proof-claim outside fenced code blocks while ignoring negations",
      () =>
        Effect.gen(function* () {
          const adrWithOverclaim = validCanonicalAdr.replace(
            "## Context and Problem Statement",
            "## Context and Problem Statement\n\nUnit tests prove this invariant holds.\nTests do not prove absence of bugs.\n\n```\nUnit tests prove code inside fences is ignored.\n```",
          )

          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test.md",
            markdown: adrWithOverclaim,
          })
          expect(report.clean).toBe(false)
          const proofFindings = report.findings.filter(
            (f) => f.kind === "adr-overstated-proof-claim",
          )
          expect(proofFindings).toHaveLength(1)
          expect(proofFindings[0]?.message).toContain("verify")
        }),
    )

    it.effect(
      "flags shallow-decider-property-test when decider property test only has scalar/primitive arbitraries",
      () =>
        Effect.gen(function* () {
          const fnQualname = "libs/sample/domain/src/index.ts#Album.decide"
          const testId = "libs/sample/domain/test/index.test.ts#test1"

          const graphWithShallowProp = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Album.decide",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 14,
                successType: "number",
                isStub: false,
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
                isPropertyTest: true,
                hasNonPrimitiveArbitrary: false,
              },
            ],
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const report = yield* decideGraphEntropy({
            graph: graphWithShallowProp,
            checkDeciderPropertyTests: true,
          })

          expect(report.clean).toBe(false)
          const shallowFinding = report.findings.find(
            (f) => f.kind === "shallow-decider-property-test",
          )
          expect(shallowFinding).toBeDefined()
          expect(shallowFinding?.nodeId).toBe("Album.decide")
          expect(shallowFinding?.message).toContain(
            "only exercised by scalar/primitive property tests",
          )
        }),
    )

    it.effect(
      "flags stale-doc-reference when an accepted spec Mermaid diagram references non-existent TaggedError",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            errors: [
              {
                errorTag: "KnownDomainError",
                file: "libs/sample/contract/src/index.ts",
              },
            ],
          })

          const doc: GovernanceDocReference = {
            id: "sample:SPEC-0004",
            docPath: "libs/sample/docs/specs/0004.md",
            status: "accepted",
            markdown: `---
id: sample:SPEC-0004
title: Decider Spec
status: accepted
---

# Architecture Diagram

\`\`\`mermaid
flowchart TD
  Decider --> DeciderInvariantError
  Decider --> KnownDomainError
\`\`\`
`,
          }

          const report = yield* decideGraphEntropy({
            graph,
            governanceDocs: [doc],
          })

          expect(report.clean).toBe(false)
          const staleErrorFinding = report.findings.find(
            (f) =>
              f.kind === "stale-doc-reference" &&
              f.nodeId === "sample:SPEC-0004:DeciderInvariantError",
          )
          expect(staleErrorFinding).toBeDefined()
          expect(staleErrorFinding?.message).toContain(
            'references non-existent TaggedError "DeciderInvariantError" in a Mermaid diagram',
          )

          const knownFinding = report.findings.find(
            (f) => f.kind === "stale-doc-reference" && f.nodeId.includes("KnownDomainError"),
          )
          expect(knownFinding).toBeUndefined()
        }),
    )

    it.effect(
      "flags stale-doc-reference when accepted ADR enforcement table attributes a mechanism not present in enforced_by files",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({})
          const doc: GovernanceDocReference = {
            id: "sample:ADR-0002",
            docPath: "libs/sample/docs/adr/0002.md",
            status: "accepted",
            enforcedByFiles: ["libs/sample/domain/src/index.ts"],
            existingFiles: ["libs/sample/domain/src/index.ts"],
            enforcedByFileContents: {
              "libs/sample/domain/src/index.ts": "export const foo = 1;\n",
            },
            markdown: `---
id: sample:ADR-0002
title: Stale Table Test
status: accepted
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Foo.decide
---

# sample:ADR-0002: Stale Table Test

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Quality Gate | libs/sample/domain/src/index.ts | \`vacuous-error-assertion\` | \`Foo.decide\` |
`,
          }

          const report = yield* decideGraphEntropy({
            graph,
            governanceDocs: [doc],
          })

          expect(report.clean).toBe(false)
          const finding = report.findings.find(
            (f) =>
              f.kind === "stale-doc-reference" &&
              f.nodeId === "sample:ADR-0002:vacuous-error-assertion",
          )
          expect(finding).toBeDefined()
          expect(finding?.message).toContain(
            'enforcement table attributes "vacuous-error-assertion" to "libs/sample/domain/src/index.ts", but none of those files define or reference "vacuous-error-assertion".',
          )
        }),
    )

    describe("evaluatePackageAndMigrationPlugin", () => {
      it.effect(
        "detects empty-source-module and unused-package-dependency with evaluatePackageAndMigrationPlugin",
        () =>
          Effect.gen(function* () {
            const tempDir = mkdtempSync(join(tmpdir(), "harness-hygiene-test-"))
            try {
              const domainPkgDir = join(tempDir, "libs", "sample", "domain")
              const srcDir = join(domainPkgDir, "src")
              mkdirSync(srcDir, { recursive: true })

              writeFileSync(
                join(domainPkgDir, "package.json"),
                JSON.stringify(
                  {
                    name: "@sample/domain",
                    dependencies: {
                      "unimported-dependency": "1.0.0",
                      effect: "4.0.0",
                    },
                  },
                  null,
                  2,
                ),
              )

              writeFileSync(
                join(srcDir, "errors.ts"),
                `// Empty error placeholder module
/* Block comment */
export {};
`,
              )

              writeFileSync(join(srcDir, "index.ts"), `export const value = 42\n`)

              const findings = yield* evaluatePackageAndMigrationPlugin({
                graph: buildHarnessGraph({}),
                workspaceRoot: tempDir,
                hostIo: testHostIo,
              })

              const emptyModuleFinding = findings.find(
                (f) =>
                  f.kind === "empty-source-module" &&
                  f.nodeId === "libs/sample/domain/src/errors.ts",
              )
              expect(emptyModuleFinding).toBeDefined()
              expect(emptyModuleFinding?.message).toContain(
                "contains only an empty export ('export {}')",
              )

              const unusedDepFinding = findings.find(
                (f) =>
                  f.kind === "unused-package-dependency" &&
                  f.nodeId === "@sample/domain:unimported-dependency",
              )
              expect(unusedDepFinding).toBeDefined()
              expect(unusedDepFinding?.message).toContain(
                'Package "@sample/domain" declares dependency "unimported-dependency" in package.json, but no file in src/ imports it.',
              )
            } finally {
              rmSync(tempDir, { recursive: true, force: true })
            }
          }),
      )

      it.effect("detects unused-contract-export with evaluatePackageAndMigrationPlugin", () =>
        Effect.gen(function* () {
          const tempDir = mkdtempSync(join(tmpdir(), "harness-contract-test-"))
          try {
            const contractSrcDir = join(tempDir, "libs", "sample", "contract", "src")
            const domainSrcDir = join(tempDir, "libs", "sample", "domain", "src")
            mkdirSync(contractSrcDir, { recursive: true })
            mkdirSync(domainSrcDir, { recursive: true })

            writeFileSync(
              join(contractSrcDir, "index.ts"),
              `export const UsedContract = 123;\nexport const DeadContractSymbol = 456;\nexport class DeadContractClass {}\nexport function deadContractFn() {}\n`,
            )

            writeFileSync(
              join(domainSrcDir, "index.ts"),
              `import {UsedContract} from "../contract/src/index.js";\nconsole.log(UsedContract);\n`,
            )

            const findings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })

            const unusedFindings = findings.filter((f) => f.kind === "unused-contract-export")
            expect(unusedFindings.length).toBe(3)
            expect(
              unusedFindings.some((f) => f.nodeId === "sample/contract:DeadContractSymbol"),
            ).toBe(true)
            expect(
              unusedFindings.some((f) => f.nodeId === "sample/contract:DeadContractClass"),
            ).toBe(true)
            expect(unusedFindings.some((f) => f.nodeId === "sample/contract:deadContractFn")).toBe(
              true,
            )
            expect(unusedFindings[0]?.message).toContain(
              'is never imported or used by any downstream package or fixture in scope "sample".',
            )
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }
        }),
      )

      it.effect(
        "detects dead-tagged-error when a contract Schema.TaggedError is referenced only in type positions and never constructed at runtime",
        () =>
          Effect.gen(function* () {
            const tempDir = mkdtempSync(join(tmpdir(), "harness-dead-error-test-"))
            try {
              const contractSrcDir = join(tempDir, "libs", "sample", "contract", "src")
              const domainSrcDir = join(tempDir, "libs", "sample", "domain", "src")
              mkdirSync(contractSrcDir, { recursive: true })
              mkdirSync(domainSrcDir, { recursive: true })

              writeFileSync(
                join(contractSrcDir, "index.ts"),
                `import {Schema} from "effect";\nexport class ConstructedError extends Schema.TaggedError<ConstructedError>()("ConstructedError", {}) {}\nexport class PhantomError extends Schema.TaggedError<PhantomError>()("PhantomError", {}) {}\n`,
              )

              writeFileSync(
                join(domainSrcDir, "index.ts"),
                `import {Effect} from "effect";\nimport {ConstructedError, type PhantomError} from "../contract/src/index.js";\nexport const run = (): Effect.Effect<void, ConstructedError | PhantomError> => Effect.fail(new ConstructedError({}));\n`,
              )

              const findings = yield* evaluatePackageAndMigrationPlugin({
                graph: buildHarnessGraph({}),
                workspaceRoot: tempDir,
                hostIo: testHostIo,
              })
              const deadErrorFindings = findings.filter((f) => f.kind === "dead-tagged-error")
              expect(deadErrorFindings).toHaveLength(1)
              expect(deadErrorFindings[0]?.nodeId).toBe("sample/contract:PhantomError")
              expect(deadErrorFindings[0]?.message).toContain(
                'Contract TaggedError "PhantomError" in "libs/sample/contract/src/index.ts" is never constructed (new PhantomError(...))',
              )
            } finally {
              rmSync(tempDir, { recursive: true, force: true })
            }
          }),
      )

      it.effect("enforces SQL migration hygiene and safety across libs/*/infra packages", () =>
        Effect.gen(function* () {
          const tempDir = mkdtempSync(join(tmpdir(), "harness-sql-hygiene-test-"))
          try {
            const infraSrcDir = join(tempDir, "libs", "sample", "infra", "src")
            mkdirSync(infraSrcDir, { recursive: true })

            // 1. bad-ddl.ts: runs sql`CREATE TABLE foo (id INT)` without SqliteMigrator
            writeFileSync(
              join(infraSrcDir, "bad-ddl.ts"),
              `import {sql} from "@effect/sql";\nexport const makeTable = sql\`CREATE TABLE foo (id INT);\`;\n`,
            )

            // 2. bad-key.ts: passes "init_Without_Number" and duplicate "1_first" / "1_second" to SqliteMigrator.fromRecord
            writeFileSync(
              join(infraSrcDir, "bad-key.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nexport const badMigrations = SqliteMigrator.fromRecord({\n  "init_Without_Number": sql\`CREATE TABLE IF NOT EXISTS a (id INT);\`,\n  "1_first": sql\`CREATE TABLE IF NOT EXISTS b (id INT);\`,\n  "1_second": sql\`CREATE TABLE IF NOT EXISTS c (id INT);\`,\n});\n`,
            )

            // 3. drop.ts: contains sql`DROP TABLE foo`
            writeFileSync(
              join(infraSrcDir, "drop.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nexport const dropMigrations = SqliteMigrator.fromRecord({\n  "1_drop_table": sql\`DROP TABLE foo;\`,\n});\n`,
            )

            // 4. multiline-gen.ts: multi-line Effect.gen block with nested object followed by second invalid key "2_InvalidCamel"
            writeFileSync(
              join(infraSrcDir, "multiline-gen.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nimport {Effect} from "effect";\nexport const complexMigrations = SqliteMigrator.fromRecord({\n  "1_init": Effect.gen(function* () {\n    const nested = { a: 1 };\n    yield* sql\`CREATE TABLE IF NOT EXISTS complex (id INT);\`;\n  }),\n  "2_InvalidCamel": sql\`CREATE TABLE IF NOT EXISTS camel (id INT);\`,\n});\n`,
            )

            // 5. spread-migrations.ts: spread record with duplicate numeric id "1"
            writeFileSync(
              join(infraSrcDir, "spread-migrations.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nconst aggregateCoreMigrations = {\n  "1_init": sql\`CREATE TABLE IF NOT EXISTS core (id INT);\`,\n};\nexport const migrations = SqliteMigrator.fromRecord({\n  ...aggregateCoreMigrations,\n  "1_second": sql\`CREATE TABLE IF NOT EXISTS duplicate_id (id INT);\`,\n});\n`,
            )

            // 6. stray-ddl.ts: file imports SqliteMigrator, has valid fromRecord, but also has stray CREATE TABLE outside migration record
            writeFileSync(
              join(infraSrcDir, "stray-ddl.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nexport const managedMigrations = SqliteMigrator.fromRecord({\n  "1_init_managed": sql\`CREATE TABLE IF NOT EXISTS managed (id INT);\`,\n});\nexport const strayTable = sql\`CREATE TABLE stray_table (id INT);\`;\n`,
            )

            // 7. .sql file with destructive DROP TABLE in migrations/
            const migrationsDir = join(tempDir, "libs", "sample", "infra", "migrations")
            mkdirSync(migrationsDir, { recursive: true })
            writeFileSync(join(migrationsDir, "0002_drop.sql"), "DROP TABLE old_table;\n")

            const findings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })

            // Check unmanaged-sql-ddl
            const unmanagedFindings = findings.filter(
              (f) =>
                f.kind === "unmanaged-sql-ddl" && f.nodeId === "libs/sample/infra/src/bad-ddl.ts",
            )
            expect(unmanagedFindings).toHaveLength(1)
            expect(unmanagedFindings[0]?.message).toContain(
              'Infrastructure module "libs/sample/infra/src/bad-ddl.ts" executes raw SQL DDL without SqliteMigrator',
            )

            // Check stray CREATE TABLE outside fromRecord in a file importing SqliteMigrator
            const strayDdlFinding = findings.find(
              (f) =>
                f.kind === "unmanaged-sql-ddl" && f.nodeId === "libs/sample/infra/src/stray-ddl.ts",
            )
            expect(strayDdlFinding).toBeDefined()
            expect(strayDdlFinding?.message).toContain(
              'Infrastructure module "libs/sample/infra/src/stray-ddl.ts" executes raw SQL DDL without SqliteMigrator',
            )

            // Check invalid-migrator-record-key (invalid format and duplicate id)
            const invalidKeyFinding = findings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/bad-key.ts:init_Without_Number",
            )
            expect(invalidKeyFinding).toBeDefined()
            expect(invalidKeyFinding?.message).toContain(
              'Invalid SqliteMigrator.fromRecord migration key "init_Without_Number"',
            )

            const duplicateKeyFinding = findings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/bad-key.ts:1_second",
            )
            expect(duplicateKeyFinding).toBeDefined()
            expect(duplicateKeyFinding?.message).toContain(
              "Duplicate migration version prefix '1_' in SqliteMigrator.fromRecord",
            )

            // Check multiline Effect.gen second key invalid format
            const camelKeyFinding = findings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/multiline-gen.ts:2_InvalidCamel",
            )
            expect(camelKeyFinding).toBeDefined()
            expect(camelKeyFinding?.message).toContain(
              'Invalid SqliteMigrator.fromRecord migration key "2_InvalidCamel"',
            )

            // Check spread record duplicate id detection
            const spreadDuplicateFinding = findings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/spread-migrations.ts:1_second",
            )
            expect(spreadDuplicateFinding).toBeDefined()
            expect(spreadDuplicateFinding?.message).toContain(
              "Duplicate migration version prefix '1_' in SqliteMigrator.fromRecord",
            )

            // Check unsafe-sql-migration from TS file
            const unsafeFindings = findings.filter(
              (f) =>
                f.kind === "unsafe-sql-migration" &&
                f.nodeId === "libs/sample/infra/src/drop.ts:drop-statement",
            )
            expect(unsafeFindings).toHaveLength(1)
            expect(unsafeFindings[0]?.message).toContain(
              'Destructive DROP statement in "libs/sample/infra/src/drop.ts" requires human approval (ESCALATE).',
            )

            // Check unsafe-sql-migration from .sql file in migrations/
            const unsafeSqlFileFinding = findings.find(
              (f) =>
                f.kind === "unsafe-sql-migration" &&
                f.nodeId === "libs/sample/infra/migrations/0002_drop.sql:drop-statement",
            )
            expect(unsafeSqlFileFinding).toBeDefined()
            expect(unsafeSqlFileFinding?.message).toContain(
              'Destructive DROP statement in "libs/sample/infra/migrations/0002_drop.sql" requires human approval (ESCALATE).',
            )
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }

          // 8. Reports 0 findings when SqliteMigrator.fromRecord({ ...aggregateCoreMigrations, "2_init_bar": ... }) is used with additive CREATE TABLE IF NOT EXISTS
          const cleanTempDir = mkdtempSync(join(tmpdir(), "harness-sql-clean-test-"))
          try {
            const cleanInfraSrcDir = join(cleanTempDir, "libs", "sample", "infra", "src")
            mkdirSync(cleanInfraSrcDir, { recursive: true })

            writeFileSync(
              join(cleanInfraSrcDir, "clean.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nconst aggregateCoreMigrations = {\n  "1_init_foo": sql\`CREATE TABLE IF NOT EXISTS foo (id INT);\`,\n};\nexport const cleanMigrations = SqliteMigrator.fromRecord({\n  ...aggregateCoreMigrations,\n  "2_init_bar": sql\`CREATE TABLE IF NOT EXISTS bar (id INT);\`,\n});\nexport const runAggregateMigrations = SqliteMigrator.run({ loader: cleanMigrations });\nexport const projectorCoreMigrations = {\n  "1_init_projector": sql\`CREATE TABLE IF NOT EXISTS proj (id INT);\`,\n};\nexport const runProjectorMigrations = SqliteMigrator.run({\n  loader: SqliteMigrator.fromRecord(projectorCoreMigrations),\n  table: "es_projector_sql_migrations",\n});\n`,
            )

            const cleanFindings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: cleanTempDir,
              hostIo: testHostIo,
            })
            expect(cleanFindings).toHaveLength(0)
          } finally {
            rmSync(cleanTempDir, { recursive: true, force: true })
          }

          // 9. Detects non-1-based migration sequence, non-contiguous sequence, shared default migration table, and untrusted-row-brand-make
          const collisionTempDir = mkdtempSync(join(tmpdir(), "harness-sql-collision-test-"))
          try {
            const collisionInfraSrcDir = join(collisionTempDir, "libs", "sample", "infra", "src")
            mkdirSync(collisionInfraSrcDir, { recursive: true })

            writeFileSync(
              join(collisionInfraSrcDir, "aggregate.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nexport const aggregateCoreMigrations = {\n  "1_init_agg": sql\`CREATE TABLE IF NOT EXISTS agg (id INT);\`,\n  "3_skip_two": sql\`CREATE TABLE IF NOT EXISTS agg2 (id INT);\`,\n};\nexport const runAgg = SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(aggregateCoreMigrations) });\n`,
            )

            writeFileSync(
              join(collisionInfraSrcDir, "projector.ts"),
              `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {sql} from "@effect/sql";\nexport const projectorCoreMigrations = {\n  "2_init_projector": sql\`CREATE TABLE IF NOT EXISTS proj (id INT);\`,\n};\nexport const runProj = SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(projectorCoreMigrations) });\nexport const decodeRow = (row: { readonly stream_version: number }) => StreamVersion.make(Math.max(0, row.stream_version));\n`,
            )

            const collisionFindings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: collisionTempDir,
              hostIo: testHostIo,
            })

            const startAtTwoFinding = collisionFindings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/projector.ts:sequence-start-2",
            )
            expect(startAtTwoFinding).toBeDefined()
            expect(startAtTwoFinding?.message).toContain('starts at id "2" instead of "1"')

            const gapFinding = collisionFindings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId === "libs/sample/infra/src/aggregate.ts:sequence-gap-1-3",
            )
            expect(gapFinding).toBeDefined()
            expect(gapFinding?.message).toContain('jumps from "1" to "3"')

            const sharedTableFinding = collisionFindings.find(
              (f) =>
                f.kind === "invalid-migrator-record-key" &&
                f.nodeId ===
                  "libs/sample/infra/src/projector.ts:shared-default-migrations-table:projectorCoreMigrations",
            )
            expect(sharedTableFinding).toBeDefined()
            expect(sharedTableFinding?.message).toContain(
              'Multiple distinct SqliteMigrator loaders (aggregateCoreMigrations, projectorCoreMigrations) in "sample/infra" use the default "effect_sql_migrations" table without a custom "table" option',
            )

            const brandMakeFinding = collisionFindings.find(
              (f) =>
                f.kind === "untrusted-row-brand-make" &&
                f.nodeId ===
                  "libs/sample/infra/src/projector.ts:StreamVersion.make(row.stream_version)",
            )
            expect(brandMakeFinding).toBeDefined()
            expect(brandMakeFinding?.message).toContain(
              'Unvalidated "StreamVersion.make(...row.stream_version...)" on SQLite row column',
            )
          } finally {
            rmSync(collisionTempDir, { recursive: true, force: true })
          }
        }),
      )
    })
  })
})
