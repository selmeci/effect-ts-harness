import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AstSourceContent, AstSourceFilePath } from "@harness/contract"
import { decideAstGateCache } from "../src/ast-cache.js"

describe("AstGateCache Drizzle interpolated template specifier ban", () => {
  it.effect("bans interpolated template specifiers in dynamic import and require across src/ and test/", () =>
    Effect.gen(function* () {
      const report = yield* decideAstGateCache({
        files: [
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/src/dynamic-drizzle.ts"),
            content: AstSourceContent.make(
              [
                'const driver = "pg"',
                "export const load = async () => await import(`drizzle-orm/${driver}`)",
                "export const loadKit = () => require(`drizzle-kit/${driver}`)",
              ].join("\n"),
            ),
          },
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/test/dynamic-drizzle.test.ts"),
            content: AstSourceContent.make(
              [
                'const driver = "sqlite"',
                "export const loadTest = async () => await import(`drizzle-orm/${driver}`)",
                "export const loadKitTest = () => require(`drizzle-kit/${driver}`)",
              ].join("\n"),
            ),
          },
        ],
      })

      expect(report.verdict).toBe("violated")
      const drizzleViolations = report.violations.filter((v) => v.rule === "banned-drizzle-import")
      expect(drizzleViolations.length).toBe(4)
      expect(
        drizzleViolations.filter(
          (v) => v.file === "libs/sample/infra/src/dynamic-drizzle.ts" && v.category === "syntax-bans",
        ).length,
      ).toBe(2)
      expect(
        drizzleViolations.filter(
          (v) => v.file === "libs/sample/infra/test/dynamic-drizzle.test.ts" && v.category === "test-integrity",
        ).length,
      ).toBe(2)
    }),
  )

  it.effect("flags invalid generative/chat clef endpoints in src/ files", () =>
    Effect.gen(function* () {
      const report = yield* decideAstGateCache({
        files: [
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/src/bad-clef.ts"),
            content: AstSourceContent.make(
              'export const badUrl = "http://localhost:11434/api/generate"\n',
            ),
          },
        ],
      })

      expect(report.verdict).toBe("violated")
      const clefViolations = report.violations.filter((v) => v.rule === "invalid-clef-endpoint")
      expect(clefViolations.length).toBe(1)
      expect(clefViolations[0]?.message).toContain("[invalid-clef-endpoint]")
    }),
  )
})
