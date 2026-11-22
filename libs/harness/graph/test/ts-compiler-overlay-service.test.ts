import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import {
  CompilerRepoRootPath,
  makeTsCompilerOverlayLayer,
  TsCompilerOverlay,
  TsCompilerOverlayError,
  TsCompilerOverlayService,
} from "../src/services/ts-compiler-overlay-service.js"
import { resolveNode } from "../src/graph-engine.js"
import { type HarnessGraph } from "../src/model.js"
import { type TypeScriptProgramSession } from "../src/type-extractor.js"
import { testHostIo } from "./helpers/test-host-io.js"

const TsCompilerOverlayServiceLive = makeTsCompilerOverlayLayer(testHostIo)

describe("TsCompilerOverlayService (harness:SPEC-0011 §3)", () => {
  it.effect(
    "REQ-3.1: yields TsCompilerOverlayService from TsCompilerOverlayServiceLive, extracts HarnessGraph with in-memory overlays, records span and satisfies span budget",
    () =>
      Effect.gen(function* () {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-ws-"))
        try {
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

          expect(session.repoRoot).toBe(path.resolve(tmpRoot))
          expect(session.sourceFileCache.size).toBeGreaterThanOrEqual(1)

          // Verify dot path resolves to the exact same warm session instance
          const dotSession = yield* svc.getSession(CompilerRepoRootPath.make(`${tmpRoot}/.`))
          expect(dotSession).toBe(session)
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(TsCompilerOverlayServiceLive)),
  )

  it.effect(
    "REQ-3.1: getSession returns identical session reference for canonical and dot/relative repo root paths",
    () =>
      Effect.gen(function* () {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-resolve-test-"))
        try {
          const sampleSrcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
          fs.mkdirSync(sampleSrcDir, { recursive: true })
          fs.writeFileSync(path.join(sampleSrcDir, "index.ts"), `export const x = 1\n`, "utf-8")

          const svc = yield* TsCompilerOverlayService
          const session1 = yield* svc.getSession(CompilerRepoRootPath.make(tmpRoot))
          const session2 = yield* svc.getSession(CompilerRepoRootPath.make(`${tmpRoot}/.`))

          expect(session2).toBe(session1)
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(TsCompilerOverlayServiceLive)),
  )

  it.effect(
    "REQ-3.1: closing TsCompilerOverlayServiceLive scope clears internally owned sessions but preserves caller-supplied external sessions",
    () =>
      Effect.gen(function* () {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-scope-test-"))
        try {
          const sampleSrcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
          fs.mkdirSync(sampleSrcDir, { recursive: true })
          fs.writeFileSync(
            path.join(sampleSrcDir, "index.ts"),
            `import { Effect } from "effect"\nexport const base = Effect.fn("Sample.base")(function* () { return yield* Effect.succeed(1) })\n`,
            "utf-8",
          )

          const externalSession: TypeScriptProgramSession = {
            repoRoot: tmpRoot,
            sourceFileCache: new Map([
              [
                "external-key",
                {
                  contentSha256: "abc",
                  declHash: "def",
                  importedSpecs: [],
                },
              ],
            ]),
            fileFragmentCache: new Map(),
            reverseImportsByFile: new Map(),
            lastReextractedFiles: [],
            signatureCleanCutoffCount: 0,
            warmHitCount: 0,
          }

          let internalSessionRef: TypeScriptProgramSession | undefined

          yield* Effect.scoped(
            Effect.gen(function* () {
              const svc = yield* TsCompilerOverlayService
              const session = yield* svc.getSession(CompilerRepoRootPath.make(tmpRoot))
              internalSessionRef = session
              session.sourceFileCache.set("internal-key", {
                contentSha256: "123",
                declHash: "456",
                importedSpecs: [],
              })

              yield* TsCompilerOverlay.extractGraph({
                repoRoot: tmpRoot,
                session: externalSession,
              })
            }).pipe(Effect.provide(TsCompilerOverlayServiceLive)),
          )

          expect(internalSessionRef?.sourceFileCache.size).toBe(0)
          expect(internalSessionRef?.oldProgram).toBeUndefined()
          expect(internalSessionRef?.project).toBeUndefined()
          expect(internalSessionRef?.lastWorkspaceSnapshot).toBeUndefined()
          expect(externalSession.sourceFileCache.size).toBeGreaterThanOrEqual(1)
          expect(externalSession.sourceFileCache.has("libs/sample/domain/src/index.ts")).toBe(true)

          // Verify activeHostIo validation & per-HostIo session isolation inside one Scope
          const virtualHostIo = {
            ...testHostIo,
            existsSync: (p: string) =>
              p === "/virtual-missing-root" ? false : testHostIo.existsSync(p),
            isDirectorySync: (p: string) =>
              p === "/virtual-missing-root" ? false : testHostIo.isDirectorySync(p),
          }
          const badVirtualExit = yield* Effect.scoped(
            TsCompilerOverlay.extractGraph({
              repoRoot: "/virtual-missing-root",
              hostIo: virtualHostIo,
            }).pipe(Effect.provide(TsCompilerOverlayServiceLive), Effect.exit),
          )
          match(badVirtualExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasFails(cause)).toBe(true)
              expect(Cause.hasDies(cause)).toBe(false)
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected TsCompilerOverlayError"))
            .exhaustive()
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
      }),
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
            }).pipe(Effect.provide(TsCompilerOverlayServiceLive), Effect.exit),
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

  it.effect(
    "F-20: maps > 4096-char repoRoot and > 8192-char thrown errors to typed TsCompilerOverlayError without SchemaError defects",
    () =>
      Effect.gen(function* () {
        const assertOverlayError = (
          exit:
            | ReturnType<typeof Effect.runSyncExit<HarnessGraph, TsCompilerOverlayError>>
            | ReturnType<
                typeof Effect.runSyncExit<TypeScriptProgramSession, TsCompilerOverlayError>
              >,
        ): TsCompilerOverlayError =>
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) =>
              match(Cause.findErrorOption(cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(TsCompilerOverlayError)
                  expect(value._tag).toBe("TsCompilerOverlayError")
                  return value
                })
                .with({ _tag: "None" }, () => {
                  expect.fail(
                    `Expected typed TsCompilerOverlayError, got defect/other cause: ${Cause.pretty(cause)}`,
                  )
                })
                .exhaustive(),
            )
            .with({ _tag: "Success" }, () => {
              expect.fail("Expected operation to fail with TsCompilerOverlayError")
            })
            .exhaustive()

        const oversizedRoot = `/${"a".repeat(5000)}`
        const extractLongRootExit = yield* TsCompilerOverlay.extractGraph({
          repoRoot: oversizedRoot,
        }).pipe(Effect.provide(TsCompilerOverlayServiceLive), Effect.exit)
        const extractLongRootErr = assertOverlayError(extractLongRootExit)
        expect(extractLongRootErr.repoRoot).toBe(oversizedRoot.slice(0, 4096))
        expect(extractLongRootErr.repoRoot.length).toBe(4096)
        expect(extractLongRootErr.reason.length).toBeLessThanOrEqual(8192)

        const sessionLongRootExit = yield* Effect.gen(function* () {
          const svc = yield* TsCompilerOverlayService
          return yield* svc.getSession(CompilerRepoRootPath.make(oversizedRoot))
        }).pipe(Effect.provide(TsCompilerOverlayServiceLive), Effect.exit)
        const sessionLongRootErr = assertOverlayError(sessionLongRootExit)
        expect(sessionLongRootErr.repoRoot).toBe(oversizedRoot.slice(0, 4096))
        expect(sessionLongRootErr.repoRoot.length).toBe(4096)

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-f20-"))
        try {
          fs.mkdirSync(path.join(tmpRoot, "libs", "sample", "domain", "src"), { recursive: true })
          const hugeErrorMsg = `boom-${"z".repeat(9000)}`
          const throwingExtractHostIo: typeof testHostIo = {
            ...testHostIo,
            readdirSync: () => {
              throw new Error(hugeErrorMsg)
            },
          }
          const extractHugeErrExit = yield* TsCompilerOverlay.extractGraph({
            repoRoot: tmpRoot,
            hostIo: throwingExtractHostIo,
          }).pipe(Effect.provide(TsCompilerOverlayServiceLive), Effect.exit)
          const extractHugeErr = assertOverlayError(extractHugeErrExit)
          expect(extractHugeErr.reason.length).toBe(8192)
          expect(extractHugeErr.reason).toContain("boom-")

          const throwingSessionLayer = makeTsCompilerOverlayLayer({
            ...testHostIo,
            realpathSync: () => {
              throw new Error(hugeErrorMsg)
            },
          })
          const sessionHugeErrExit = yield* Effect.gen(function* () {
            const svc = yield* TsCompilerOverlayService
            return yield* svc.getSession(CompilerRepoRootPath.make(tmpRoot))
          }).pipe(Effect.provide(throwingSessionLayer), Effect.exit)
          const sessionHugeErr = assertOverlayError(sessionHugeErrExit)
          expect(sessionHugeErr.reason.length).toBe(8192)
          expect(sessionHugeErr.reason.startsWith("boom-")).toBe(true)
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true })
        }
      }),
  )
})
