import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  StructuralSearch,
  StructuralSearchFilePath,
  StructuralSearchPattern,
  StructuralSearchSubDir,
} from "../src/index.js"

const StructuralSearchInputArb = Schema.Struct({
  pattern: Schema.Union([
    StructuralSearchPattern,
    Schema.Literal("export const $NAME = $$$"),
    Schema.Literal("decideStructuralSearch"),
    Schema.Literal("StructuralSearchPattern"),
    Schema.Literal("Sample.greet"),
  ]),
  filePath: Schema.optional(
    Schema.Union([
      StructuralSearchFilePath,
      Schema.Literal("libs/harness/graph/src/structural-search.ts"),
      Schema.Literal("libs/sample/domain/src/index.ts"),
      Schema.Literal(
        "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
      ),
    ]),
  ),
  paths: Schema.optional(
    Schema.Array(
      Schema.Union([
        StructuralSearchFilePath,
        Schema.Literal("libs/sample/domain/src"),
        Schema.Literal("libs/harness/graph/src"),
      ]),
    ),
  ),
  subDirs: Schema.optional(
    Schema.Array(
      Schema.Union([
        StructuralSearchSubDir,
        Schema.Literal("libs/sample"),
        Schema.Literal("libs/harness"),
      ]),
    ),
  ),
})

describe("StructuralSearch.decide", () => {
  it.effect("finds TypeScript AST patterns across workspace TypeScript files", () =>
    Effect.gen(function* () {
      const results = yield* StructuralSearch.decide({
        pattern: "export const greet = $$$",
      })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.some((r) => r.file.includes("libs/sample/domain/src/index.ts"))).toBe(true)

      const first = results[0]!
      expect(first.line).toBeGreaterThanOrEqual(1)
      expect(first.column).toBeGreaterThanOrEqual(1)
      expect(first.range.start.line).toBeGreaterThanOrEqual(1)
      expect(first.range.start.column).toBeGreaterThanOrEqual(1)
      expect(first.range.end.line).toBeGreaterThanOrEqual(1)
      expect(first.range.end.column).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("scopes search to a single .ts file for AST patterns and fallback line-locator", () =>
    Effect.gen(function* () {
      // 1. AST pattern in single .ts file
      const astResults = yield* StructuralSearch.decide({
        pattern: "export const greet = $$$",
        filePath: "libs/sample/domain/src/index.ts",
      })
      expect(astResults.length).toBe(1)
      expect(astResults[0]?.file).toBe("libs/sample/domain/src/index.ts")
      expect(astResults[0]?.line).toBe(14)

      // 2. Fallback line-locator in .ts file (comments/strings without ast metavariables)
      const lineResults = yield* StructuralSearch.decide({
        pattern: "Hello,",
        filePath: "libs/sample/domain/src/index.ts",
      })
      expect(lineResults.length).toBe(1)
      expect(lineResults[0]?.file).toBe("libs/sample/domain/src/index.ts")
      expect(lineResults[0]?.line).toBe(16)
      expect(lineResults[0]?.column).toBeGreaterThanOrEqual(1)
      expect(lineResults[0]?.text).toContain("Hello,")
    }),
  )

  it.effect("scopes search to a single markdown .md file using line-locator", () =>
    Effect.gen(function* () {
      const mdResults = yield* StructuralSearch.decide({
        pattern: "ADR-0001",
        filePath: "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
      })
      expect(mdResults.length).toBeGreaterThan(0)
      expect(
        mdResults.every(
          (r) =>
            r.file ===
            "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
        ),
      ).toBe(true)
      for (const item of mdResults) {
        expect(item.line).toBeGreaterThanOrEqual(1)
        expect(item.column).toBeGreaterThanOrEqual(1)
        expect(item.text).toContain("ADR-0001")
      }
    }),
  )

  it.effect("scopes search by paths array and subDirs filtering", () =>
    Effect.gen(function* () {
      const scopedPathsResults = yield* StructuralSearch.decide({
        pattern: "greet",
        paths: ["libs/sample/domain/src"],
      })
      expect(scopedPathsResults.length).toBeGreaterThan(0)
      expect(scopedPathsResults.every((r) => r.file.startsWith("libs/sample/domain/src"))).toBe(
        true,
      )

      const scopedSubDirsResults = yield* StructuralSearch.decide({
        pattern: "greet",
        subDirs: ["libs/sample"],
      })
      expect(scopedSubDirsResults.length).toBeGreaterThan(0)
      expect(scopedSubDirsResults.every((r) => r.file.startsWith("libs/sample"))).toBe(true)
    }),
  )

  it.effect("rejects path traversal escaping repoRoot and returns empty array", () =>
    Effect.gen(function* () {
      const escapingFilePath = yield* StructuralSearch.decide({
        pattern: "export const",
        filePath: "../outside.ts",
      })
      expect(escapingFilePath).toEqual([])

      const escapingPaths = yield* StructuralSearch.decide({
        pattern: "export const",
        paths: ["../../outside.ts"],
      })
      expect(escapingPaths).toEqual([])

      const escapingSubDirs = yield* StructuralSearch.decide({
        pattern: "export const",
        subDirs: ["../../outside"],
      })
      expect(escapingSubDirs).toEqual([])

      const whitespacePattern = yield* StructuralSearch.decide({
        pattern: "   ",
        filePath: "libs/sample/domain/src/index.ts",
      })
      expect(whitespacePattern).toEqual([])
    }),
  )

  it.effect.prop(
    "property: decide is deterministic, respects repo root containment, and emits valid line numbers",
    [StructuralSearchInputArb],
    ([input]) =>
      Effect.gen(function* () {
        const repoRoot = path.resolve(process.cwd())
        const run1 = yield* StructuralSearch.decide({
          ...input,
          repoRoot,
        })
        const run2 = yield* StructuralSearch.decide({
          ...input,
          repoRoot,
        })

        expect(run1).toEqual(run2)

        for (const item of run1) {
          expect(item.file.startsWith("..")).toBe(false)
          expect(path.isAbsolute(item.file)).toBe(false)
          expect(item.line).toBeGreaterThanOrEqual(1)
          expect(item.column).toBeGreaterThanOrEqual(1)
          expect(item.range.start.line).toBeGreaterThanOrEqual(1)
          expect(item.range.start.column).toBeGreaterThanOrEqual(1)
          expect(item.range.end.line).toBeGreaterThanOrEqual(1)
          expect(item.range.end.column).toBeGreaterThanOrEqual(1)
          expect(item.range.start.index).toBeGreaterThanOrEqual(0)
          expect(item.range.end.index).toBeGreaterThanOrEqual(0)
        }
      }),
  )
})
