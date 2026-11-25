import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { match } from "ts-pattern"
import { createTypeScriptProgramSession, type TypeScriptProgramSession } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostExecResult, SyncHostReader } from "@harness/service/host-io"
import {
  createServer,
  executeManagedMcpTool,
  executeToolEffect,
  makeMcpManagedRuntime,
  runDefaultLspDiagnostics,
} from "../src/server.js"
import { ProjectPathEscapeError } from "../src/tools/mcp-helpers.js"
import { createLspSessionCache, type LspTsgoExecutor } from "../src/tools/lsp-session-cache.js"

const createdTempDirs: Array<string> = []

const makeTempRepo = (files: Readonly<Record<string, string>>): string => {
  const dir = nodeSyncHostIo.mkdtempSync("harness-lsp-cache-")
  createdTempDirs.push(dir)
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath)
    nodeSyncHostIo.mkdirRecursiveSync(path.dirname(absPath))
    nodeSyncHostIo.writeTextSync(absPath, content)
  }
  return dir
}

const makeCleanTsgoExecutor = (onExec?: () => void): LspTsgoExecutor => {
  return () =>
    Effect.sync(() => {
      onExec?.()
      return {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          diagnostics: [],
          summary: {
            filesChecked: 1,
            filesWithoutPlugin: 0,
            totalFiles: 1,
            errors: 0,
            warnings: 0,
            messages: 0,
          },
        }),
        stderr: "",
      } satisfies SyncHostExecResult
    })
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop()
    if (dir !== undefined) {
      nodeSyncHostIo.rmRecursiveSync(dir)
    }
  }
})

describe("LspSessionCache (SPEC-0033 REQ-2.1)", () => {
  it.effect(
    "reuses warm TypeScriptProgramSession across runDefaultLspDiagnostics and overlays calls",
    () =>
      Effect.gen(function* () {
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({
            compilerOptions: { strict: true, target: "ESNext", module: "NodeNext" },
          }),
          "src/a.ts": "export const a: number = 1\n",
        })
        let factoryCalls = 0
        const cache = createLspSessionCache({
          sessionFactory: (root: string, hostIo: SyncHostReader) => {
            factoryCalls += 1
            return createTypeScriptProgramSession(root, hostIo)
          },
        })
        const execTsgo = makeCleanTsgoExecutor()

        const first = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/a.ts" },
          { cache, execTsgo },
        )
        const second = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/a.ts" },
          { cache, execTsgo },
        )
        const overlayRes = yield* executeToolEffect(
          "harness_lsp_diagnostics",
          {
            repoRoot: repo,
            overlays: { "src/a.ts": "export const a: number = 2\n" },
          },
          { repoRoot: repo, lspSessionCache: cache, skipTelemetry: true },
        )

        expect(first.clean).toBe(true)
        expect(second.clean).toBe(true)
        expect(overlayRes).toMatchObject({ clean: true })
        expect(factoryCalls).toBe(1)
        expect(cache.getStats().sessionCount).toBe(1)
      }),
  )

  it("evicts oldest repoRoot when exceeding maxEntries=4 and refreshes recency on hit", () => {
    const repos = [1, 2, 3, 4, 5].map((i) =>
      makeTempRepo({
        "tsconfig.json": "{}",
        [`src/f${i}.ts`]: `export const v${i} = ${i}\n`,
      }),
    )
    let factoryCalls = 0
    const createdSessions = new Map<string, TypeScriptProgramSession>()
    const cache = createLspSessionCache({
      maxEntries: 4,
      sessionFactory: (root: string, hostIo: SyncHostReader) => {
        factoryCalls += 1
        const s = createTypeScriptProgramSession(root, hostIo)
        s.sourceFileCache.set("dummy", {
          contentSha256: "abc",
          declHash: "def",
          importedSpecs: [],
        })
        createdSessions.set(root, s)
        return s
      },
    })

    const r1 = repos[0]!
    const r2 = repos[1]!
    const r3 = repos[2]!
    const r4 = repos[3]!
    const r5 = repos[4]!

    cache.getSession(r1)
    const s2 = cache.getSession(r2)
    cache.getSession(r3)
    cache.getSession(r4)
    expect(cache.getStats().sessionCount).toBe(4)

    // Promote r1 to most-recently-used; r2 becomes oldest
    cache.getSession(r1)
    cache.getSession(r5)

    const stats = cache.getStats()
    expect(stats.sessionCount).toBe(4)
    expect(factoryCalls).toBe(5)
    expect(s2.oldProgram).toBeUndefined()
    expect(s2.sourceFileCache.size).toBe(0)

    // r1 is still warm; r2 was evicted and recreates on access
    cache.getSession(r1)
    expect(factoryCalls).toBe(5)
    cache.getSession(r2)
    expect(factoryCalls).toBe(6)
  })

  it("evicts and recreates TypeScriptProgramSession when tsconfig.json or tsconfig.base.json mtimeMs changes", async () => {
    const repo = makeTempRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/a.ts": "export const x = 1\n",
    })
    let factoryCalls = 0
    const cache = createLspSessionCache({
      sessionFactory: (root: string, hostIo: SyncHostReader) => {
        factoryCalls += 1
        return createTypeScriptProgramSession(root, hostIo)
      },
    })

    const s1 = cache.getSession(repo)
    const s2 = cache.getSession(repo)
    expect(s1).toBe(s2)
    expect(factoryCalls).toBe(1)

    await sleepMs(20)
    nodeSyncHostIo.writeTextSync(
      path.join(repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: true } }),
    )

    const s3 = cache.getSession(repo)
    expect(s3).not.toBe(s1)
    expect(factoryCalls).toBe(2)

    await sleepMs(20)
    nodeSyncHostIo.writeTextSync(
      path.join(repo, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { target: "ESNext" } }),
    )

    const s4 = cache.getSession(repo)
    expect(s4).not.toBe(s3)
    expect(factoryCalls).toBe(3)
  })

  it.effect(
    "invalidates cached overlay diagnostics when target file or dependency mtimeMs changes",
    () =>
      Effect.gen(function* () {
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({
            compilerOptions: { strict: true, target: "ESNext", module: "NodeNext" },
          }),
          "src/dep.ts": "export const val: number = 1\n",
          "src/main.ts": 'import { val } from "./dep.js"\nexport const out: number = val\n',
        })
        let factoryCalls = 0
        const cache = createLspSessionCache({
          sessionFactory: (root: string, hostIo: SyncHostReader) => {
            factoryCalls += 1
            return createTypeScriptProgramSession(root, hostIo)
          },
        })
        const execTsgo = makeCleanTsgoExecutor()

        const r1 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r1.clean).toBe(true)
        const programAfterR1 = cache.getSession(repo).oldProgram
        expect(programAfterR1).toBeDefined()

        // Warm hit with no file or dependency changes — oldProgram identity must be preserved
        const r2 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r2.clean).toBe(true)
        expect(cache.getSession(repo).oldProgram).toBe(programAfterR1)
        expect(factoryCalls).toBe(1)

        // Mutate imported dependency -> TS2322 in src/main.ts
        yield* Effect.promise(() => sleepMs(20))
        nodeSyncHostIo.writeTextSync(
          path.join(repo, "src/dep.ts"),
          'export const val: string = "oops"\n',
        )

        const r3 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r3.clean).toBe(false)
        expect(JSON.stringify(r3.diagnostics)).toContain("TS2322")

        // Fix target file to match string -> clean again
        yield* Effect.promise(() => sleepMs(20))
        nodeSyncHostIo.writeTextSync(
          path.join(repo, "src/main.ts"),
          'import { val } from "./dep.js"\nexport const out: string = val\n',
        )

        const r4 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r4.clean).toBe(true)
        expect(factoryCalls).toBe(1)
      }),
  )

  it.effect(
    "deduplicates concurrent identical effect-tsgo runs and recovers cleanly from leader interruption",
    () =>
      Effect.gen(function* () {
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
          "src/a.ts": "export const a: number = 1\n",
          "src/b.ts": "export const b: number = 2\n",
        })
        const cache = createLspSessionCache()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let execCount = 0

        const gatedExec: LspTsgoExecutor = () =>
          Effect.gen(function* () {
            execCount += 1
            if (execCount === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify({
                diagnostics: [],
                summary: {
                  filesChecked: 1,
                  filesWithoutPlugin: 0,
                  totalFiles: 1,
                  errors: 0,
                  warnings: 0,
                  messages: 0,
                },
              }),
              stderr: "",
            } satisfies SyncHostExecResult
          })

        const f1 = yield* Effect.forkChild(
          runDefaultLspDiagnostics(repo, { file: "src/a.ts" }, { cache, execTsgo: gatedExec }),
        )
        yield* Deferred.await(started)
        const f2 = yield* Effect.forkChild(
          runDefaultLspDiagnostics(repo, { file: "src/a.ts" }, { cache, execTsgo: gatedExec }),
        )
        const f3 = yield* Effect.forkChild(
          runDefaultLspDiagnostics(repo, { file: "src/a.ts" }, { cache, execTsgo: gatedExec }),
        )
        // Distinct file key runs independently
        const fOther = yield* Effect.forkChild(
          runDefaultLspDiagnostics(repo, { file: "src/b.ts" }, { cache, execTsgo: gatedExec }),
        )

        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        const [res1, res2, res3, resOther] = yield* Effect.all([
          Fiber.join(f1),
          Fiber.join(f2),
          Fiber.join(f3),
          Fiber.join(fOther),
        ])

        expect(execCount).toBe(2)
        expect(res1).toEqual(res2)
        expect(res2).toEqual(res3)
        expect(resOther.clean).toBe(true)
        expect(cache.getStats().inFlightCount).toBe(0)

        // Leader interruption: follower falls back and completes once without hanging
        const leaderStarted = yield* Deferred.make<void>()
        const neverRelease = yield* Deferred.make<void>()
        let interruptTestCalls = 0
        const interruptibleRun = () =>
          Effect.gen(function* () {
            interruptTestCalls += 1
            if (interruptTestCalls === 1) {
              yield* Deferred.succeed(leaderStarted, undefined)
              yield* Deferred.await(neverRelease)
            }
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "{}",
              stderr: "",
            } satisfies SyncHostExecResult
          })

        const leader = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("interrupt-key", interruptibleRun),
        )
        yield* Deferred.await(leaderStarted)
        const follower = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("interrupt-key", interruptibleRun),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(leader)

        const followerResult = yield* Fiber.join(follower)
        expect(followerResult._tag).toBe("Exited")
        expect(interruptTestCalls).toBe(2)
        expect(cache.getStats().inFlightCount).toBe(0)
      }),
  )

  it("clears warm sessions on server.close(), ManagedRuntime.dispose(), and cache.clear()", async () => {
    const repo = makeTempRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/a.ts": "export const a: number = 1\n",
    })
    const cache = createLspSessionCache()
    const session = cache.getSession(repo)
    session.sourceFileCache.set("src/a.ts", {
      contentSha256: "sha",
      declHash: "decl",
      importedSpecs: [],
    })
    expect(cache.getStats().sessionCount).toBe(1)

    cache.clear()
    expect(cache.getStats().sessionCount).toBe(0)
    expect(cache.getStats().inFlightCount).toBe(0)
    expect(session.oldProgram).toBeUndefined()
    expect(session.sourceFileCache.size).toBe(0)

    const observedSessions: Array<TypeScriptProgramSession> = []
    const optsWithFactory = {
      repoRoot: repo,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      lspSessionCacheOptions: {
        sessionFactory: (root: string, hostIo: SyncHostReader) => {
          const created = createTypeScriptProgramSession(root, hostIo)
          observedSessions.push(created)
          return created
        },
      },
    }

    const runtime = makeMcpManagedRuntime(optsWithFactory)
    const runtimeRes = await runtime.runPromise(
      executeManagedMcpTool(
        {
          toolName: "harness_lsp_diagnostics",
          args: {
            repoRoot: repo,
            file: "src/a.ts",
            overlays: { "src/a.ts": "export const a: number = 1\n" },
          },
        },
        optsWithFactory,
      ),
    )
    expect(runtimeRes).toMatchObject({ clean: true })
    expect(observedSessions).toHaveLength(1)
    expect(observedSessions[0]!.oldProgram).toBeDefined()

    await runtime.dispose()
    expect(observedSessions[0]!.oldProgram).toBeUndefined()
    expect(observedSessions[0]!.sourceFileCache.size).toBe(0)

    const server = createServer(optsWithFactory)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const callRes = await client.callTool({
      name: "harness_lsp_diagnostics",
      arguments: {
        repoRoot: repo,
        file: "src/a.ts",
        overlays: { "src/a.ts": "export const a: number = 1\n" },
      },
    })
    expect(callRes.isError).not.toBe(true)
    expect(observedSessions).toHaveLength(2)
    expect(observedSessions[1]!.oldProgram).toBeDefined()

    await server.close()
    await client.close()
    expect(observedSessions[1]!.oldProgram).toBeUndefined()
    expect(observedSessions[1]!.sourceFileCache.size).toBe(0)
  })

  it.effect("invalidates overlay cache on dependency edit when repoRoot is a symlink", () =>
    Effect.gen(function* () {
      const realRepo = makeTempRepo({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, target: "ESNext", module: "NodeNext" },
        }),
        "src/dep.ts": "export const val: number = 1\n",
        "src/main.ts": 'import { val } from "./dep.js"\nexport const out: number = val\n',
      })
      const linkParent = makeTempRepo({})
      const symlinkRepo = path.join(linkParent, "repo-link")
      fs.symlinkSync(realRepo, symlinkRepo, "dir")

      const cache = createLspSessionCache()
      const execTsgo = makeCleanTsgoExecutor()

      const r1 = yield* runDefaultLspDiagnostics(
        symlinkRepo,
        { file: "src/main.ts" },
        { cache, execTsgo },
      )
      expect(r1.clean).toBe(true)

      yield* Effect.promise(() => sleepMs(20))
      nodeSyncHostIo.writeTextSync(
        path.join(realRepo, "src/dep.ts"),
        'export const val: string = "broken"\n',
      )

      const r2 = yield* runDefaultLspDiagnostics(
        symlinkRepo,
        { file: "src/main.ts" },
        { cache, execTsgo },
      )
      expect(r2.clean).toBe(false)
      expect(r2.summary.errors).toBe(1)
      const firstDiag = r2.diagnostics[0]
      expect(
        typeof firstDiag === "object" && firstDiag !== null ? Reflect.get(firstDiag, "file") : "",
      ).toBe("src/main.ts")
      expect(JSON.stringify(r2.diagnostics)).toContain("TS2322")
    }),
  )

  it.effect(
    "does not cache TS2307 missing module diagnostics so creating the file clears the error immediately",
    () =>
      Effect.gen(function* () {
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({
            compilerOptions: { strict: true, target: "ESNext", module: "NodeNext" },
          }),
          "src/main.ts": 'import { val } from "./missing.js"\nexport const out: number = val\n',
        })
        const cache = createLspSessionCache()
        const execTsgo = makeCleanTsgoExecutor()

        const r1 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r1.clean).toBe(false)
        expect(JSON.stringify(r1.diagnostics)).toContain("TS2307")

        nodeSyncHostIo.writeTextSync(
          path.join(repo, "src/missing.ts"),
          "export const val: number = 42\n",
        )

        const r2 = yield* runDefaultLspDiagnostics(
          repo,
          { file: "src/main.ts" },
          { cache, execTsgo },
        )
        expect(r2.clean).toBe(true)
      }),
  )

  it.effect(
    "rejects auto-discovered symlinked tsconfig.json outside repoRoot with ProjectPathEscapeError",
    () =>
      Effect.gen(function* () {
        const outsideDir = makeTempRepo({
          "outside-tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
        })
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
          "packages/sub/src/a.ts": "export const a: number = 1\n",
        })
        fs.symlinkSync(
          path.join(outsideDir, "outside-tsconfig.json"),
          path.join(repo, "packages/sub/tsconfig.json"),
        )

        const exit = yield* Effect.exit(
          runDefaultLspDiagnostics(
            repo,
            { file: "packages/sub/src/a.ts" },
            { execTsgo: makeCleanTsgoExecutor() },
          ),
        )
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasFails(cause)).toBe(true)
            expect(Cause.squash(cause)).toBeInstanceOf(ProjectPathEscapeError)
          })
          .with({ _tag: "Success" }, () => expect.unreachable("expected ProjectPathEscapeError"))
          .exhaustive()
      }),
  )

  it("bounds overlayDiagnosticsCache with LRU maxOverlayEntries", () => {
    const repo = makeTempRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 2\n",
      "src/c.ts": "export const c = 3\n",
    })
    const cache = createLspSessionCache({ maxOverlayEntries: 2 })
    const session = cache.getSession(repo)
    const store = (filePath: string) =>
      cache.setCachedOverlayDiagnostics({
        repoRoot: repo,
        filePath,
        fileMtimeMs: 1,
        contentSha256: `sha-${filePath}`,
        session,
        diagnostics: [],
      })
    const lookup = (filePath: string) =>
      cache.getCachedOverlayDiagnostics({
        repoRoot: repo,
        filePath,
        fileMtimeMs: 1,
        contentSha256: `sha-${filePath}`,
      })

    store("src/a.ts")
    store("src/b.ts")
    // Refresh src/a.ts recency so src/b.ts becomes oldest
    expect(lookup("src/a.ts")).toEqual([])
    store("src/c.ts")

    expect(lookup("src/a.ts")).toEqual([])
    expect(lookup("src/b.ts")).toBeUndefined()
    expect(lookup("src/c.ts")).toEqual([])
  })

  it.effect(
    "cleans up inFlightRuns on synchronous throw, propagates Fail outcomes, deduplicates project runs, and survives 2x leader interrupts",
    () =>
      Effect.gen(function* () {
        const repo = makeTempRepo({
          "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
          "src/a.ts": "export const a: number = 1\n",
        })
        const cache = createLspSessionCache()

        // Synchronous throw in runEffect does not wedge inFlightRuns
        const syncThrowExit = yield* Effect.exit(
          cache.runSingleFlightTsgo("sync-throw-key", () => {
            throw new Error("sync boom")
          }),
        )
        match(syncThrowExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => expect.unreachable("expected die from sync throw"))
          .exhaustive()
        expect(cache.getStats().inFlightCount).toBe(0)

        const recovered = yield* cache.runSingleFlightTsgo("sync-throw-key", () =>
          Effect.succeed({
            _tag: "Exited",
            exitCode: 0,
            stdout: "{}",
            stderr: "",
          } satisfies SyncHostExecResult),
        )
        expect(recovered._tag).toBe("Exited")

        // Concurrent { _tag: "Fail" } propagation & { project: "tsconfig.json" } dedup
        const failStarted = yield* Deferred.make<void>()
        const failRelease = yield* Deferred.make<void>()
        const p1 = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("fail-key", () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(failStarted, undefined)
              yield* Deferred.await(failRelease)
              return yield* Effect.fail("tsgo-boom")
            }),
          ),
        )
        yield* Deferred.await(failStarted)
        const p2 = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("fail-key", () => Effect.fail("should-not-run")),
        )
        yield* Effect.yieldNow
        yield* Deferred.succeed(failRelease, undefined)
        const [e1, e2] = yield* Effect.all([
          Effect.exit(Fiber.join(p1)),
          Effect.exit(Fiber.join(p2)),
        ])
        for (const ex of [e1, e2]) {
          match(ex)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasFails(cause)).toBe(true)
              expect(Cause.squash(cause)).toBe("tsgo-boom")
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected tsgo-boom failure"))
            .exhaustive()
        }
        expect(cache.getStats().inFlightCount).toBe(0)

        const projStarted = yield* Deferred.make<void>()
        const projRelease = yield* Deferred.make<void>()
        let projCalls = 0
        const projExec: LspTsgoExecutor = () =>
          Effect.gen(function* () {
            projCalls += 1
            if (projCalls === 1) {
              yield* Deferred.succeed(projStarted, undefined)
              yield* Deferred.await(projRelease)
            }
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify({
                diagnostics: [],
                summary: {
                  filesChecked: 1,
                  filesWithoutPlugin: 0,
                  totalFiles: 1,
                  errors: 0,
                  warnings: 0,
                  messages: 0,
                },
              }),
              stderr: "",
            } satisfies SyncHostExecResult
          })
        const pf1 = yield* Effect.forkChild(
          runDefaultLspDiagnostics(
            repo,
            { project: "tsconfig.json" },
            { cache, execTsgo: projExec },
          ),
        )
        yield* Deferred.await(projStarted)
        const pf2 = yield* Effect.forkChild(
          runDefaultLspDiagnostics(
            repo,
            { project: "tsconfig.json" },
            { cache, execTsgo: projExec },
          ),
        )
        yield* Effect.yieldNow
        yield* Deferred.succeed(projRelease, undefined)
        const [pr1, pr2] = yield* Effect.all([Fiber.join(pf1), Fiber.join(pf2)])
        expect(projCalls).toBe(1)
        expect(pr1.clean).toBe(true)
        expect(pr2.clean).toBe(true)

        // 2x sequential leader interrupts let 3rd healthy follower succeed
        const l1Started = yield* Deferred.make<void>()
        const l2Started = yield* Deferred.make<void>()
        const neverDone = yield* Deferred.make<void>()
        let attempt = 0
        const multiInterruptRun = () =>
          Effect.gen(function* () {
            attempt += 1
            if (attempt === 1) {
              yield* Deferred.succeed(l1Started, undefined)
              yield* Deferred.await(neverDone)
            }
            if (attempt === 2) {
              yield* Deferred.succeed(l2Started, undefined)
              yield* Deferred.await(neverDone)
            }
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "{}",
              stderr: "",
            } satisfies SyncHostExecResult
          })

        const leader1 = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("multi-int-key", multiInterruptRun),
        )
        yield* Deferred.await(l1Started)
        const follower2 = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("multi-int-key", multiInterruptRun),
        )
        const follower3 = yield* Effect.forkChild(
          cache.runSingleFlightTsgo("multi-int-key", multiInterruptRun),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(leader1)
        yield* Deferred.await(l2Started)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(follower2)

        const thirdResult = yield* Fiber.join(follower3)
        expect(thirdResult._tag).toBe("Exited")
        expect(attempt).toBe(3)
        expect(cache.getStats().inFlightCount).toBe(0)
      }),
  )
})
