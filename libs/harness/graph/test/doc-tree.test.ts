import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DocLineNumber,
  DocSectionId,
  DocTreeInput,
  DocTreePath,
  DocTreePathError,
  EarsAreaName,
  EarsClauseText,
  EarsEffectSymbol,
  EarsPatternName,
  EarsRequirementNodeId,
  EarsVerificationKind,
  ErrorReasonMessage,
  GovernanceDocIdentifier,
  RequirementId,
  WorkspaceFileContent,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { WorkspaceFs } from "@harness/service"
import {
  buildGovernanceCatalog,
  buildHarnessGraph,
  EarsRequirementNode,
  EarsSpecNode,
  inspectDocTree,
  parseMarkdownTree,
} from "../src/index.js"

const decodeDocTreeInput = Schema.decodeUnknownSync(DocTreeInput)

const makeMemoryWorkspaceFsLayer = (
  files: ReadonlyMap<string, string>,
  realPaths: ReadonlyMap<string, string> = new Map(),
): Layer.Layer<WorkspaceFs> =>
  Layer.succeed(
    WorkspaceFs,
    WorkspaceFs.of({
      exists: (filePath) => Effect.succeed(files.has(filePath) || realPaths.has(filePath)),
      realPath: (filePath) => {
        const resolved = realPaths.get(filePath) ?? filePath
        return files.has(resolved) || filePath === "/repo"
          ? Effect.succeed(WorkspaceFilePath.make(resolved))
          : Effect.succeed(filePath)
      },
      readTextFile: (filePath) => {
        const resolved = realPaths.get(filePath) ?? filePath
        const content = files.get(resolved)
        return content !== undefined
          ? Effect.succeed(WorkspaceFileContent.make(content))
          : Effect.fail(
              new WorkspaceFsError({
                filePath,
                operation: WorkspaceFsOperation.make("read"),
                reason: ErrorReasonMessage.make(`Missing file: ${filePath}`),
              }),
            )
      },
      writeTextFileAtomic: () => Effect.void,
    }),
  )

describe("DocTree Tier-3 PageIndex-lite (ADR-0025 / SPEC-0031)", () => {
  it.effect(
    "parses nested headings with accurate 1-based line ranges while ignoring frontmatter and fenced headings",
    () =>
      Effect.gen(function* () {
        const sampleDoc = WorkspaceFileContent.make(`---
id: harness:ADR-0025
title: Three-Tier Retrieval
status: accepted
---

# ADR-0025: Three-Tier Retrieval

Summary intro line.

## 1. Context

\`\`\`bash
# Fenced comment that is NOT a heading
## Sub comment inside fence
\`\`\`

First real context sentence.

### 1.1 Constraints

Constraint details here.

## 2. Decision

Final decision line.
`)
        const sections = yield* parseMarkdownTree(sampleDoc)
        expect(sections.map((s) => `${s.sectionId}:${s.level}:${s.title}`)).toEqual([
          "h1-1:1:ADR-0025: Three-Tier Retrieval",
          "h2-2:2:1. Context",
          "h3-3:3:1.1 Constraints",
          "h2-4:2:2. Decision",
        ])
        expect(sections[1]?.startLine).toBe(11)
        expect(sections[1]?.endLine).toBe(23)
        expect(sections[1]?.preview).toContain("First real context sentence.")
        expect(sections[2]?.startLine).toBe(20)
        expect(sections[2]?.endLine).toBe(23)
        expect(sections[3]?.startLine).toBe(24)
        expect(sections[3]?.endLine).toBe(27)
      }),
  )

  it.effect("inspects catalog, tree, and bounded section slices via WorkspaceFs", () =>
    Effect.gen(function* () {
      const docPath = "libs/sample/docs/adr/0002.md"
      const docContent = `# Sample ADR

Lead overview line.

## Decision

We choose bounded section slicing.

## Consequences

Faster context reads.
`
      const graph = buildHarnessGraph({
        adrDocs: [
          {
            id: "sample:ADR-0002",
            title: "Sample ADR",
            status: "accepted",
            path: docPath,
            enforcedByFiles: [],
            summary: "Sample ADR summary",
          },
          {
            id: "harness:ADR-0025",
            title: "Three-Tier Retrieval",
            status: "accepted",
            path: "libs/harness/docs/adr/0025.md",
            enforcedByFiles: [],
            summary: "Harness ADR summary",
          },
        ],
        earsSpecs: [
          {
            id: "harness:SPEC-0031",
            title: "Three-Tier Retrieval Spec",
            status: "proposed",
            path: "libs/harness/docs/specs/0031.md",
            enforcedByFiles: [],
            informedByAdrs: ["harness:ADR-0025"],
            goalSummary: "Spec goal summary",
            requirements: [
              {
                _tag: "EarsRequirement",
                id: EarsRequirementNodeId.make("harness:SPEC-0031::REQ-1.1"),
                specId: GovernanceDocIdentifier.make("harness:SPEC-0031"),
                requirementId: RequirementId.make("REQ-1.1"),
                area: EarsAreaName.make("Extraction"),
                pattern: EarsPatternName.make("Event-driven"),
                clauseText: EarsClauseText.make(
                  "When parsing specs, extractor shall extract REQ rows.",
                ),
                effectSymbol: EarsEffectSymbol.make(""),
                verification: EarsVerificationKind.make("UnitTest"),
                path: DocTreePath.make("libs/harness/docs/specs/0031.md"),
                line: DocLineNumber.make(42),
                status: "proposed",
              },
            ],
          },
        ],
      })

      const fullCatalog = yield* buildGovernanceCatalog(graph)
      expect(fullCatalog.map((e) => e.id)).toEqual([
        "harness:ADR-0025",
        "harness:SPEC-0031",
        "sample:ADR-0002",
      ])
      expect(fullCatalog[1]?.informedByAdrs).toEqual(["harness:ADR-0025"])
      expect(fullCatalog[1]?.requirementCount).toBe(1)

      const fsLayer = makeMemoryWorkspaceFsLayer(new Map([[`/repo/${docPath}`, docContent]]))
      const scoped = yield* inspectDocTree({
        repoRoot: WorkspaceFilePath.make("/repo"),
        input: decodeDocTreeInput({ mode: "catalog", scope: "sample" }),
        graph,
      }).pipe(Effect.provide(fsLayer))

      match(scoped)
        .with({ _tag: "GovernanceCatalog" }, (cat) => {
          expect(cat.totalDocs).toBe(1)
          expect(cat.entries.map((e) => e.id)).toEqual(["sample:ADR-0002"])
        })
        .with({ _tag: "DocumentTree" }, { _tag: "SectionContent" }, () => {
          expect.unreachable("Expected GovernanceCatalog")
        })
        .exhaustive()

      const treeRes = yield* inspectDocTree({
        repoRoot: WorkspaceFilePath.make("/repo"),
        input: { mode: "tree", path: DocTreePath.make(docPath) },
        graph,
      }).pipe(Effect.provide(fsLayer))

      match(treeRes)
        .with({ _tag: "DocumentTree" }, (tree) => {
          expect(tree.sections.map((s) => s.sectionId)).toEqual(["h1-1", "h2-2", "h2-3"])
        })
        .with({ _tag: "GovernanceCatalog" }, { _tag: "SectionContent" }, () => {
          expect.unreachable("Expected DocumentTree")
        })
        .exhaustive()

      const sectionRes = yield* inspectDocTree({
        repoRoot: WorkspaceFilePath.make("/repo"),
        input: {
          mode: "section",
          path: DocTreePath.make(docPath),
          sectionId: DocSectionId.make("h2-2"),
        },
        graph,
      }).pipe(Effect.provide(fsLayer))

      match(sectionRes)
        .with({ _tag: "SectionContent" }, (sec) => {
          expect(sec.content).toContain("We choose bounded section slicing.")
          expect(sec.content).not.toContain("Faster context reads.")
        })
        .with({ _tag: "GovernanceCatalog" }, { _tag: "DocumentTree" }, () => {
          expect.unreachable("Expected SectionContent")
        })
        .exhaustive()
    }),
  )

  it.effect(
    "fails with DocTreePathError on traversal escape, external path, unsupported extension, missing file, and unknown sectionId",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({})
        const fsLayer = makeMemoryWorkspaceFsLayer(
          new Map([["/repo/docs/valid.md", "# Title\n\nBody\n"]]),
        )

        const expectPathFailure = (input: DocTreeInput, expectedSubstr: string) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              inspectDocTree({
                repoRoot: WorkspaceFilePath.make("/repo"),
                input,
                graph,
              }).pipe(Effect.provide(fsLayer)),
            )
            match(exit)
              .with({ _tag: "Failure" }, ({ cause }) => {
                match(Cause.findErrorOption(cause))
                  .with({ _tag: "Some" }, ({ value }) => {
                    expect(value).toBeInstanceOf(DocTreePathError)
                    expect(value.reason).toContain(expectedSubstr)
                  })
                  .with({ _tag: "None" }, () => {
                    expect.unreachable("Expected DocTreePathError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "Success" }, () => {
                expect.unreachable("Expected path inspection to fail")
              })
              .exhaustive()
          })

        yield* expectPathFailure(
          { mode: "tree", path: DocTreePath.make("../../etc/passwd") },
          "escapes repository root",
        )
        yield* expectPathFailure(
          { mode: "tree", path: DocTreePath.make("/outside/repo/secret.md") },
          "escapes repository root",
        )
        yield* expectPathFailure(
          { mode: "tree", path: DocTreePath.make("src/index.ts") },
          "Unsupported documentation file extension",
        )
        yield* expectPathFailure(
          { mode: "tree", path: DocTreePath.make("docs/missing.md") },
          "does not exist",
        )
        yield* expectPathFailure(
          {
            mode: "section",
            path: DocTreePath.make("docs/valid.md"),
            sectionId: DocSectionId.make("h2-999"),
          },
          "Unknown sectionId",
        )
      }),
  )

  it.effect(
    "rejects symlink escapes outside repoRoot and symlink extension bypasses while respecting outer 4-backtick fences",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({})
        const fsLayer = makeMemoryWorkspaceFsLayer(
          new Map([
            ["/outside/etc/secret.md", "# Secret\n"],
            ["/repo/.env.json", '{"secret":true}'],
          ]),
          new Map([
            ["/repo/docs/escape-link.md", "/outside/etc/secret.md"],
            ["/repo/docs/env-link.md", "/repo/.env.json"],
          ]),
        )

        const symlinkEscapeExit = yield* Effect.exit(
          inspectDocTree({
            repoRoot: WorkspaceFilePath.make("/repo"),
            input: { mode: "tree", path: DocTreePath.make("docs/escape-link.md") },
            graph,
          }).pipe(Effect.provide(fsLayer)),
        )
        match(symlinkEscapeExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value.reason).toContain("Resolved symlink target escapes repository root")
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected DocTreePathError on symlink escape")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected symlink escape to fail")
          })
          .exhaustive()

        const extBypassExit = yield* Effect.exit(
          inspectDocTree({
            repoRoot: WorkspaceFilePath.make("/repo"),
            input: { mode: "tree", path: DocTreePath.make("docs/env-link.md") },
            graph,
          }).pipe(Effect.provide(fsLayer)),
        )
        match(extBypassExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value.reason).toContain("Unsupported resolved documentation file extension")
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected DocTreePathError on extension bypass")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected extension bypass to fail")
          })
          .exhaustive()

        const nestedFenceDoc = WorkspaceFileContent.make(`# Outer Title

\`\`\`\`markdown
\`\`\`bash
# Inner Fenced Heading After Triple Close
\`\`\`
# Still Inside 4-Backtick Fence
\`\`\`\`

## Real Following Section

Body after nested fence.
`)
        const parsedNested = yield* parseMarkdownTree(nestedFenceDoc)
        expect(parsedNested.map((s) => s.title)).toEqual(["Outer Title", "Real Following Section"])
      }),
  )

  it.effect(
    "enforces 250-line caps, CRLF+BOM, tilde fences, dotdot filenames, forbidden .git/node_modules segments, anchored scopes, and EARS/DocTree invariants",
    () =>
      Effect.gen(function* () {
        const crlfBomContent = `\uFEFF# CRLF Title\r\n\r\n~~~markdown\r\n# Fenced Tilde Heading\r\n~~~\r\n\r\n## Long Section\r\n${Array.from({ length: 280 }, (_, idx) => `Line ${idx + 1}`).join("\r\n")}\r\n`
        const parsedCrlf = yield* parseMarkdownTree(WorkspaceFileContent.make(crlfBomContent))
        expect(parsedCrlf.map((s) => s.title)).toEqual(["CRLF Title", "Long Section"])

        const validDotDotPath = "..foo.md"
        const graph = buildHarnessGraph({
          adrDocs: [
            {
              id: "sample:ADR-0002",
              title: "Sample ADR",
              status: "accepted",
              path: "libs/sample/docs/adr/0002.md",
              enforcedByFiles: [],
              summary: "   ",
              searchText: "   ",
            },
            {
              id: "other:ADR-0009",
              title: "External Nested Docs",
              status: "accepted",
              path: "docs/external/libs/sample/docs/adr/0009.md",
              enforcedByFiles: [],
              summary: "Should not match sample scope by substring",
            },
          ],
          earsSpecs: [
            {
              id: "sample:SPEC-0001",
              title: "Spec Without Nested Requirements Array",
              status: "accepted",
              path: "libs/sample/docs/specs/0001.md",
              enforcedByFiles: [],
              goalSummary: "   ",
            },
          ],
          earsRequirements: [
            {
              id: EarsRequirementNodeId.make("sample:SPEC-0001::REQ-1.1"),
              specId: GovernanceDocIdentifier.make("sample:SPEC-0001"),
              requirementId: RequirementId.make("REQ-1.1"),
              area: EarsAreaName.make("Core"),
              pattern: EarsPatternName.make("Ubiquitous"),
              clauseText: EarsClauseText.make("The system shall count top-level requirements."),
              effectSymbol: EarsEffectSymbol.make(""),
              verification: EarsVerificationKind.make("UnitTest"),
              path: DocTreePath.make("libs/sample/docs/specs/0001.md"),
              line: DocLineNumber.make(10),
              status: "accepted",
            },
          ],
        })

        const catalog = yield* buildGovernanceCatalog(graph)
        const adrEntry = catalog.find((e) => e.id === "sample:ADR-0002")
        const specEntry = catalog.find((e) => e.id === "sample:SPEC-0001")
        expect(adrEntry?.summary).toBe("Sample ADR")
        expect(specEntry?.summary).toBe("Spec Without Nested Requirements Array")
        expect(specEntry?.requirementCount).toBe(1)

        const fsLayer = makeMemoryWorkspaceFsLayer(
          new Map([
            [`/repo/${validDotDotPath}`, "# DotDot File\n\nValid filename.\n"],
            ["/repo/docs/long.md", crlfBomContent],
            ["/repo/.git/HEAD.md", "# Secret git doc\n"],
            ["/repo/node_modules/pkg/readme.md", "# Dependency readme\n"],
          ]),
          new Map([["/repo/docs/sym-node-modules.md", "/repo/node_modules/pkg/readme.md"]]),
        )

        const scopedRes = yield* inspectDocTree({
          repoRoot: WorkspaceFilePath.make("/repo"),
          input: decodeDocTreeInput({ mode: "catalog", scope: "sample" }),
          graph,
        }).pipe(Effect.provide(fsLayer))
        match(scopedRes)
          .with({ _tag: "GovernanceCatalog" }, (cat) => {
            expect(cat.entries.map((e) => e.id)).toEqual(["sample:ADR-0002", "sample:SPEC-0001"])
          })
          .with({ _tag: "DocumentTree" }, { _tag: "SectionContent" }, () => {
            expect.unreachable("Expected GovernanceCatalog")
          })
          .exhaustive()

        const dotDotTree = yield* inspectDocTree({
          repoRoot: WorkspaceFilePath.make("/repo"),
          input: { mode: "tree", path: DocTreePath.make(validDotDotPath) },
          graph,
        }).pipe(Effect.provide(fsLayer))
        match(dotDotTree)
          .with({ _tag: "DocumentTree" }, (t) => {
            expect(t.path).toBe("..foo.md")
            expect(t.sections.map((s) => s.title)).toEqual(["DotDot File"])
          })
          .with({ _tag: "GovernanceCatalog" }, { _tag: "SectionContent" }, () => {
            expect.unreachable("Expected DocumentTree")
          })
          .exhaustive()

        const cappedSlice = yield* inspectDocTree({
          repoRoot: WorkspaceFilePath.make("/repo"),
          input: {
            mode: "section",
            path: DocTreePath.make("docs/long.md"),
            sectionId: DocSectionId.make("h2-2"),
          },
          graph,
        }).pipe(Effect.provide(fsLayer))
        match(cappedSlice)
          .with({ _tag: "SectionContent" }, (sec) => {
            expect(sec.content.split("\n")).toHaveLength(250)
          })
          .with({ _tag: "GovernanceCatalog" }, { _tag: "DocumentTree" }, () => {
            expect.unreachable("Expected SectionContent")
          })
          .exhaustive()

        for (const forbiddenPath of [
          ".git/HEAD.md",
          "node_modules/pkg/readme.md",
          "docs/sym-node-modules.md",
        ]) {
          const exit = yield* Effect.exit(
            inspectDocTree({
              repoRoot: WorkspaceFilePath.make("/repo"),
              input: { mode: "tree", path: DocTreePath.make(forbiddenPath) },
              graph,
            }).pipe(Effect.provide(fsLayer)),
          )
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              const err = Cause.findErrorOption(cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value.reason).toContain("forbidden directory segment")
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable(`Expected DocTreePathError for ${forbiddenPath}`)
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable(`Expected failure for ${forbiddenPath}`)
            })
            .exhaustive()
        }

        expect(Schema.decodeUnknownOption(DocTreeInput)({ mode: "tree" })._tag).toBe("None")
        expect(
          Schema.decodeUnknownOption(DocTreeInput)({
            mode: "section",
            path: "docs/long.md",
          })._tag,
        ).toBe("None")

        expect(
          Schema.decodeOption(EarsRequirementNode)({
            _tag: "EarsRequirement",
            id: EarsRequirementNodeId.make("wrong:SPEC::REQ-1.1"),
            specId: GovernanceDocIdentifier.make("sample:SPEC-0001"),
            requirementId: RequirementId.make("REQ-1.1"),
            area: EarsAreaName.make("Core"),
            pattern: EarsPatternName.make("Ubiquitous"),
            clauseText: EarsClauseText.make("Clause."),
            effectSymbol: EarsEffectSymbol.make(""),
            verification: EarsVerificationKind.make("UnitTest"),
            path: DocTreePath.make("docs/specs/0001.md"),
            line: DocLineNumber.make(1),
            status: "accepted",
          })._tag,
        ).toBe("None")

        expect(
          Schema.decodeOption(EarsSpecNode)({
            _tag: "EarsSpec",
            id: "sample:SPEC-0001",
            title: "Spec",
            status: "accepted",
            path: "docs/specs/0001.md",
            enforcedByFiles: [],
            requirements: [
              {
                _tag: "EarsRequirement",
                id: EarsRequirementNodeId.make("other:SPEC::REQ-1.1"),
                specId: GovernanceDocIdentifier.make("other:SPEC"),
                requirementId: RequirementId.make("REQ-1.1"),
                area: EarsAreaName.make("Core"),
                pattern: EarsPatternName.make("Ubiquitous"),
                clauseText: EarsClauseText.make("Mismatched specId."),
                effectSymbol: EarsEffectSymbol.make(""),
                verification: EarsVerificationKind.make("UnitTest"),
                path: DocTreePath.make("docs/specs/0001.md"),
                line: DocLineNumber.make(2),
                status: "accepted",
              },
            ],
          })._tag,
        ).toBe("None")
      }),
  )
})
