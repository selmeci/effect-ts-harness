import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import {
  CompilerRepoRootPath,
  TsCompilerOverlay,
  TsCompilerOverlayError,
  TsCompilerOverlayService,
  TsCompilerOverlayServiceLive,
} from "../src/services/ts-compiler-overlay-service.js"
import { resolveNode } from "../src/graph-engine.js"

describe("TsCompilerOverlayService (harness:SPEC-0011 §3)", () => {
  it.effect(
    "REQ-3.1: yields TsCompilerOverlayService from TsCompilerOverlayServiceLive, extracts HarnessGraph with in-memory overlays, records span and satisfies span budget",
    () =>
      Effect.gen(function* () {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-ws-"))
        const sampleSrcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
        fs.mkdirSync(sampleSrcDir, { recursive: true })
        fs.writeFileSync(
          path.join(sampleSrcDir, "index.ts"),
          `import { Effect } from "effect"\nexport const base = Effect.fn("Sample.base")(function* () { return yield* Effect.succeed(1) })\n`,
          "utf-8",
        )

        const fnIndex = new Map<string, IndexedEffectFn>([
          [
            "TsCompilerOverlay.extractGraph",
            {
              spanName: "TsCompilerOverlay.extractGraph",
              exportName: "extractGraphViaCompilerOverlay",
              qualname:
                "libs/harness/graph/src/services/ts-compiler-overlay-service.ts#extractGraphViaCompilerOverlay",
              file: "libs/harness/graph/src/services/ts-compiler-overlay-service.ts",
              packageTag: "service",
              line: 91,
              isStub: false,
            },
          ],
        ])

        const overlayContent = `import { Effect } from "effect"\nexport const ping = Effect.fn("Sample.ping")(function* () { return yield* Effect.succeed(2) })\n`

        const { result: graph, spans } = yield* runWithTestTracer(
          "libs/harness/graph/test/ts-compiler-overlay-service.test.ts::REQ-3.1",
          TsCompilerOverlay.extractGraph({
            repoRoot: tmpRoot,
            overlays: {
              "libs/sample/domain/src/index.ts": overlayContent,
            },
          }),
          fnIndex,
        )

        const resolvedPing = resolveNode(graph, "Sample.ping")
        expect(resolvedPing?._tag).toBe("EffectFn")
        if (resolvedPing?._tag === "EffectFn") {
          expect(resolvedPing.qualname).toContain("ping")
        }

        const overlaySpans = spans.filter((s) => s.name === "TsCompilerOverlay.extractGraph")
        expect(overlaySpans.length).toBeGreaterThanOrEqual(1)
        expect(overlaySpans.length).toBeLessThanOrEqual(3)
        expect(overlaySpans[0]?.exitTag).toBe("Success")

        // Also verify getSession returns a warm TypeScriptProgramSession for a valid CompilerRepoRootPath
        const svc = yield* TsCompilerOverlayService
        const validRoot = CompilerRepoRootPath.make(tmpRoot)
        const session = yield* svc.getSession(validRoot)

        expect(session.repoRoot).toBe(tmpRoot)
        expect(session.sourceFileCache.size).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(TsCompilerOverlayServiceLive)),
  )

  it.effect(
    "REQ-3.2: fails with TsCompilerOverlayError when repoRoot is empty ('' or '   ') or does not exist",
    () =>
      Effect.gen(function* () {
        const fnIndex = new Map<string, IndexedEffectFn>([
          [
            "TsCompilerOverlay.extractGraph",
            {
              spanName: "TsCompilerOverlay.extractGraph",
              exportName: "extractGraphViaCompilerOverlay",
              qualname:
                "libs/harness/graph/src/services/ts-compiler-overlay-service.ts#extractGraphViaCompilerOverlay",
              file: "libs/harness/graph/src/services/ts-compiler-overlay-service.ts",
              packageTag: "service",
              line: 91,
              isStub: false,
            },
          ],
        ])

        const testCases: ReadonlyArray<{
          readonly repoRoot: string
          readonly expectedReason: string
        }> = [
          {
            repoRoot: "",
            expectedReason: "Repository root path must be non-empty.",
          },
          {
            repoRoot: "   ",
            expectedReason: "Repository root path must be non-empty.",
          },
          {
            repoRoot: "/tmp/nonexistent-harness-repo-root-404",
            expectedReason:
              "Repository root path does not exist or is not a directory: /tmp/nonexistent-harness-repo-root-404",
          },
        ]

        for (const { repoRoot, expectedReason } of testCases) {
          const testId = `REQ-3.2::negative::${repoRoot.trim().length === 0 ? "empty" : "nonexistent"}`
          const { result: exit, spans } = yield* runWithTestTracer(
            testId,
            TsCompilerOverlay.extractGraph({
              repoRoot,
            }).pipe(
              Effect.provide(TsCompilerOverlayServiceLive),
              Effect.exit,
            ),
            fnIndex,
          )

          const overlaySpans = spans.filter((s) => s.name === "TsCompilerOverlay.extractGraph")
          expect(overlaySpans.length).toBeGreaterThanOrEqual(1)
          expect(overlaySpans.length).toBeLessThanOrEqual(3)
          expect(overlaySpans[0]?.exitTag).toBe("Failure")

          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              const errorOpt = Cause.findErrorOption(cause)
              match(errorOpt)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(TsCompilerOverlayError)
                  expect(value._tag).toBe("TsCompilerOverlayError")
                  expect(value.repoRoot).toBe(repoRoot)
                  expect(value.reason).toBe(expectedReason)
                })
                .with({ _tag: "None" }, () => {
                  expect.fail("Expected TsCompilerOverlayError in failure cause")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.fail("Expected extractGraph to fail for invalid repoRoot")
            })
            .exhaustive()
        }
      }),
  )
})
