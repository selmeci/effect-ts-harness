import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { OllamaWarmupError } from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { runWithTestTracer } from "@harness/ingest"
import { handleGuard } from "../src/commands/guard-and-route.command.js"
import {
  buildHookRuntimeSnapshot,
  HarnessHookRuntime,
} from "../src/commands/hook-runtime-loader.js"
import { handleMutate } from "../src/commands/mutate-and-bench.command.js"
import { parseMutateCliFlags } from "../src/commands/mutate-flags.js"
import * as ollamaReadiness from "../src/commands/ollama-readiness.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import { handleDoctor } from "../src/commands/session-learn-report.command.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import {
  finalizeVerifyPostChecks,
  runVerifyFormatPreFlight,
} from "../src/commands/verify-preflight.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const RESOLVER_PATH = join(REAL_REPO_ROOT, "tools", "node-ts-resolver.mjs")

const tempDirs: Array<string> = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const gitCommitAll = (cwd: string, message: string): void => {
  git(cwd, ["add", "-A"])
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message])
}

const initTempGitRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  git(dir, ["init", "-b", "main"])
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.harness\n", "utf8")
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "temp-spec0037", type: "module" }, null, 2)}\n`,
    "utf8",
  )
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"))
  gitCommitAll(dir, "init")
  return dir
}

const writeFormattedDemoPkg = (dir: string, engineSource: string, testSource: string): void => {
  const pkgDir = join(dir, "libs", "demo", "gates")
  mkdirSync(join(pkgDir, "src"), { recursive: true })
  mkdirSync(join(pkgDir, "test"), { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify({ name: "@demo/gates", nx: { tags: ["type:core"] } }, null, 2)}\n`,
    "utf8",
  )
  writeFileSync(join(pkgDir, "src", "engine.ts"), engineSource, "utf8")
  writeFileSync(join(pkgDir, "test", "engine.test.ts"), testSource, "utf8")
}

const copyHookRuntimeSourcesToTemp = (dir: string): void => {
  const packages: ReadonlyArray<string> = [
    "libs/harness/contract",
    "libs/harness/service",
    "libs/harness/gates",
    "libs/harness/decision",
    "libs/harness/infra",
    "libs/harness/graph",
    "libs/harness/ingest",
    "apps/harness-cli",
  ]
  for (const pkgRel of packages) {
    const srcFrom = join(REAL_REPO_ROOT, pkgRel, "src")
    const srcTo = join(dir, pkgRel, "src")
    mkdirSync(join(dir, pkgRel), { recursive: true })
    nodeSyncHostIo.execFileSync("cp", ["-r", srcFrom, srcTo])
    const pkgJsonFrom = join(REAL_REPO_ROOT, pkgRel, "package.json")
    if (existsSync(pkgJsonFrom)) {
      nodeSyncHostIo.execFileSync("cp", [pkgJsonFrom, join(dir, pkgRel, "package.json")])
    }
  }
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/**'\n  - 'apps/*'\n")
  const clusterYamlFrom = join(REAL_REPO_ROOT, "libs/harness/graph/cluster.yaml")
  if (existsSync(clusterYamlFrom)) {
    nodeSyncHostIo.execFileSync("cp", [
      clusterYamlFrom,
      join(dir, "libs/harness/graph/cluster.yaml"),
    ])
  }
}

describe("SPEC-0037 W3A: fail-fast verify, hook runtime isolation, and targeted mutate CLI", () => {
  it.effect(
    "REQ-4.1 & REQ-4.2: HarnessVerify.run fails fast on missing mutate stamp without spawning Nx",
    () =>
      Effect.gen(function* () {
        const dir = initTempGitRepo("spec0037-verify-stamp-")
        git(dir, ["checkout", "-b", "feat/fail-fast-stamp"])
        writeFormattedDemoPkg(
          dir,
          "export const isPositive = (n: number): boolean => n >= 1\n",
          [
            'import { expect, it } from "vitest"',
            'import { isPositive } from "../src/engine.js"',
            "",
            'it("kills >=", () => {',
            "  expect(isPositive(1)).toBe(true)",
            "  expect(isPositive(0)).toBe(false)",
            "})",
            "",
          ].join("\n"),
        )
        gitCommitAll(dir, "add formatted domain pkg")

        const origExec = nodeSyncHostIo.execFileSync.bind(nodeSyncHostIo)
        let nxCalls = 0
        const execSpy = vi
          .spyOn(nodeSyncHostIo, "execFileSync")
          .mockImplementation((cmd, args, opts) => {
            if (cmd === "pnpm" && args.includes("nx")) {
              nxCalls += 1
            }
            return origExec(cmd, args, opts)
          })

        try {
          const { result, spans } = yield* runWithTestTracer(
            "spec0037-verify-stamp",
            handleVerify({
              repoRoot: dir,
              skipBackgroundDaemons: true,
              skipAutoSessionReport: true,
              mutateStampPolicy: "enforce",
              decisionLayer: makeMockDecisionModelLayer(),
            }),
            new Map(),
          )
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain("verify:mutate-stamp")
          expect(nxCalls).toBe(0)
          expect(spans.some((s) => s.name === "HarnessVerify.run")).toBe(true)
        } finally {
          execSpy.mockRestore()
        }
      }),
  )

  it.effect(
    "REQ-4.1 & REQ-4.2: HarnessVerify.run fails fast on stubs, format failure, and AST line-count ceiling without spawning Nx",
    () =>
      Effect.gen(function* () {
        const dir = initTempGitRepo("spec0037-verify-fmt-ast-")
        git(dir, ["checkout", "-b", "feat/fail-fast-fmt-ast"])
        writeFormattedDemoPkg(
          dir,
          "export const   badlyFormatted   =   (n:number):boolean=>{return n>0}\n",
          [
            'import { expect, it } from "vitest"',
            'import { badlyFormatted } from "../src/engine.js"',
            "",
            'it("works", () => {',
            "  expect(badlyFormatted(1)).toBe(true)",
            "})",
            "",
          ].join("\n"),
        )
        gitCommitAll(dir, "add unformatted file")

        const origExec = nodeSyncHostIo.execFileSync.bind(nodeSyncHostIo)
        let nxCalls = 0
        const execSpy = vi
          .spyOn(nodeSyncHostIo, "execFileSync")
          .mockImplementation((cmd, args, opts) => {
            if (cmd === "pnpm" && args.includes("nx")) {
              nxCalls += 1
            }
            return origExec(cmd, args, opts)
          })

        try {
          // 1) Format failure before Nx
          const fmtOutcome = yield* runWithTestTracer(
            "spec0037-verify-format",
            handleVerify({
              repoRoot: dir,
              skipBackgroundDaemons: true,
              skipAutoSessionReport: true,
              mutateStampPolicy: "skip",
              decisionLayer: makeMockDecisionModelLayer(),
            }),
            new Map(),
          )
          expect(fmtOutcome.result.exitCode).toBe(1)
          expect(fmtOutcome.result.stderr).toContain("verify:format")
          expect(nxCalls).toBe(0)
          expect(fmtOutcome.spans.some((s) => s.name === "HarnessVerify.run")).toBe(true)

          // 2) Active stub() check before Nx
          writeFileSync(
            join(dir, "libs", "demo", "gates", "src", "engine.ts"),
            [
              'import { Effect } from "effect"',
              'import { stub } from "@harness/contract"',
              "",
              'export const stubbed = Effect.fn("Demo.stubbed")(function* () {',
              '  return yield* stub<string, never, never>("todo")',
              "})",
              "",
            ].join("\n"),
            "utf8",
          )
          gitCommitAll(dir, "add active stub")
          const stubOutcome = yield* handleVerify({
            repoRoot: dir,
            skipBackgroundDaemons: true,
            skipAutoSessionReport: true,
            mutateStampPolicy: "skip",
            decisionLayer: makeMockDecisionModelLayer(),
          })
          expect(stubOutcome.exitCode).toBe(1)
          expect(stubOutcome.stderr).toContain(
            "Verification failed: active stub() found in Demo.stubbed",
          )
          expect(nxCalls).toBe(0)

          // 3) AST line-count ceiling before Nx
          const lines = Array.from(
            { length: 660 },
            (_, i) => `export const lineValue${i} = ${i}`,
          ).join("\n")
          const cmdDir = join(dir, "apps", "harness-cli", "src", "commands")
          mkdirSync(cmdDir, { recursive: true })
          writeFileSync(join(cmdDir, "oversized.ts"), `${lines}\n`, "utf8")
          writeFileSync(
            join(dir, "libs", "demo", "gates", "src", "engine.ts"),
            "export const badlyFormatted = (n: number): boolean => n > 0\n",
            "utf8",
          )
          gitCommitAll(dir, "add oversized command file")

          const astOutcome = yield* runWithTestTracer(
            "spec0037-verify-ast-ceiling",
            handleVerify({
              repoRoot: dir,
              skipBackgroundDaemons: true,
              skipAutoSessionReport: true,
              mutateStampPolicy: "skip",
              decisionLayer: makeMockDecisionModelLayer(),
            }),
            new Map(),
          )
          expect(astOutcome.result.exitCode).toBe(1)
          expect(astOutcome.result.stderr).toContain("file-line-budget-exceeded")
          expect(nxCalls).toBe(0)
        } finally {
          execSpy.mockRestore()
        }
      }),
  )

  it.effect(
    "REQ-4.3: HarnessHookRuntime builds snapshot, rejects tampered file hashes, executes hook-entry.ts guard despite live contract syntax error, and supports SourceFallback",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "spec0037-hook-runtime-"))
        tempDirs.push(dir)
        copyHookRuntimeSourcesToTemp(dir)

        // 1. Before snapshot exists, load returns SourceFallback
        const initialLoad = yield* runWithTestTracer(
          "spec0037-hook-load-missing",
          HarnessHookRuntime.load(dir),
          new Map(),
        )
        expect(initialLoad.result).toEqual({
          _tag: "SourceFallback",
          reason: "snapshot-absent-or-unsafe",
        })
        expect(initialLoad.spans.some((s) => s.name === "HarnessHookRuntime.load")).toBe(true)

        // 2. Build snapshot (also via finalizeVerifyPostChecks path)
        const postCheckResult = yield* finalizeVerifyPostChecks({
          repoRoot: dir,
          graph: buildHarnessGraph({}),
          implBranch: "main",
          options: undefined,
        })
        expect(postCheckResult.exitCode).toBe(0)
        expect(existsSync(join(dir, ".harness", "hook-runtime", "current", "manifest.json"))).toBe(
          true,
        )

        const built = buildHookRuntimeSnapshot(dir)
        expect(built._tag).toBe("Built")
        match(built)
          .with({ _tag: "Built" }, ({ fileCount, manifestPath, manifest }) => {
            expect(fileCount).toBeGreaterThan(10)
            expect(existsSync(manifestPath)).toBe(true)
            expect(Object.keys(manifest.fileHashes).length).toBe(fileCount)
          })
          .with({ _tag: "Failed" }, ({ reason }) => {
            throw new Error(`Expected snapshot build to succeed, got: ${reason}`)
          })
          .exhaustive()

        const loadedSnap = yield* HarnessHookRuntime.load(dir)
        match(loadedSnap)
          .with({ _tag: "Snapshot" }, ({ snapshotDir, entryPath, packageMap }) => {
            expect(snapshotDir).toContain(join(".harness", "hook-runtime", "current"))
            expect(entryPath).toContain("hook-entry.js")
            expect(Object.keys(packageMap).length).toBeGreaterThan(0)
          })
          .with({ _tag: "SourceFallback" }, ({ reason }) =>
            expect.unreachable(`Expected Snapshot, got SourceFallback: ${reason}`),
          )
          .exhaustive()

        const overrideLoad = yield* HarnessHookRuntime.load(dir, { forceSource: true })
        expect(overrideLoad).toEqual({ _tag: "SourceFallback", reason: "force-source-override" })

        const prevSourceEnv = process.env["HARNESS_HOOK_RUNTIME_SOURCE"]
        process.env["HARNESS_HOOK_RUNTIME_SOURCE"] = "1"
        try {
          const envOverride = yield* HarnessHookRuntime.load(dir)
          expect(envOverride).toEqual({ _tag: "SourceFallback", reason: "force-source-override" })
        } finally {
          if (prevSourceEnv === undefined)
            Reflect.deleteProperty(process.env, "HARNESS_HOOK_RUNTIME_SOURCE")
          else process.env["HARNESS_HOOK_RUNTIME_SOURCE"] = prevSourceEnv
        }

        // 3. Inject syntax error into live libs/harness/contract/src/index.ts & hook-entry.ts
        writeFileSync(
          join(dir, "libs", "harness", "contract", "src", "index.ts"),
          "export const BROKEN_SYNTAX = {{{;\n",
          "utf8",
        )
        writeFileSync(
          join(dir, "apps", "harness-cli", "src", "commands", "hook-fastpath-core.ts"),
          "export const BROKEN_HOOK = {{{;\n",
          "utf8",
        )

        // 4. Execute hook-entry.ts guard using snapshot -> MUST succeed cleanly!
        const snapRun = spawnSync(
          process.execPath,
          [
            "--import",
            RESOLVER_PATH,
            join(dir, "apps", "harness-cli", "src", "hook-entry.ts"),
            "guard",
            "--format=antigravity",
          ],
          {
            cwd: dir,
            encoding: "utf8",
            input: JSON.stringify({
              tool_name: "run_command",
              tool_input: { CommandLine: "git status" },
            }),
            env: { ...process.env, HARNESS_TEST_ISOLATION: "1" },
          },
        )
        expect(snapRun.status).toBe(0)
        const GuardDecisionSchema = Schema.fromJsonString(
          Schema.Struct({ decision: Schema.String }),
        )
        const decodedGuard = yield* Schema.decodeEffect(GuardDecisionSchema)(snapRun.stdout)
        expect(decodedGuard).toEqual({
          decision: "allow",
        })

        // 5. With HARNESS_HOOK_RUNTIME_SOURCE=1 -> falls back to live broken source and fails
        const liveRun = spawnSync(
          process.execPath,
          [
            "--import",
            RESOLVER_PATH,
            join(dir, "apps", "harness-cli", "src", "hook-entry.ts"),
            "guard",
            "--format=antigravity",
          ],
          {
            cwd: dir,
            encoding: "utf8",
            input: JSON.stringify({
              tool_name: "run_command",
              tool_input: { CommandLine: "git status" },
            }),
            env: {
              ...process.env,
              HARNESS_TEST_ISOLATION: "1",
              HARNESS_HOOK_RUNTIME_SOURCE: "1",
            },
          },
        )
        expect(liveRun.status).toBe(1)
        expect(liveRun.stderr).toMatch(/SyntaxError|Unexpected token/)

        // 6. Tamper a snapshot .js file -> integrity hash mismatch triggers SourceFallback
        const policySnapPath = join(
          dir,
          ".harness",
          "hook-runtime",
          "current",
          "libs",
          "harness",
          "gates",
          "src",
          "policy.js",
        )
        const origPolicyJs = readFileSync(policySnapPath, "utf8")
        writeFileSync(policySnapPath, `${origPolicyJs}\n// tampered\n`, "utf8")
        const tamperedLoad = yield* HarnessHookRuntime.load(dir)
        expect(tamperedLoad).toEqual({
          _tag: "SourceFallback",
          reason: "integrity-mismatch:libs/harness/gates/src/policy.js",
        })
      }),
  )

  it.effect(
    "REQ-3.3, REQ-3.4 & REQ-2.1: harness mutate --survivors-only/--files omit mutate-stamp.json and ensureOllamaWarmWithResult surfaces OllamaWarmupError",
    () =>
      Effect.gen(function* () {
        expect(parseMutateCliFlags(["mutate", "--file=a.ts", "--files=b.ts"])._tag).toBe("Invalid")
        const parsedFiles = parseMutateCliFlags([
          "mutate",
          "--strict",
          "--survivors-only",
          "--files=a.ts",
        ])
        expect(parsedFiles).toMatchObject({
          _tag: "Ok",
          parsed: {
            isStrict: true,
            survivorsOnly: true,
            targetFiles: ["a.ts"],
          },
        })

        const dir = initTempGitRepo("spec0037-mutate-targeted-")
        git(dir, ["checkout", "-b", "feat/targeted-mutate"])
        writeFormattedDemoPkg(
          dir,
          "export const isPositive = (n: number): boolean => n >= 1\n",
          [
            'import { expect, it } from "vitest"',
            'import { isPositive } from "../src/engine.js"',
            'it("kills", () => { expect(isPositive(1)).toBe(true); expect(isPositive(0)).toBe(false) })',
          ].join("\n"),
        )
        gitCommitAll(dir, "add strong demo pkg")

        const stampPath = join(dir, ".harness", "mutate-stamp.json")
        const survivorsRes = yield* runWithTestTracer(
          "spec0037-mutate-survivors-only",
          handleMutate(["mutate", "--strict", "--survivors-only"], { repoRoot: dir }),
          new Map(),
        )
        expect(survivorsRes.result.exitCode).toBe(0)
        expect(survivorsRes.result.stderr).toContain("--survivors-only")
        expect(existsSync(stampPath)).toBe(false)
        expect(survivorsRes.spans.some((s) => s.name === "MutationCheck.run")).toBe(true)

        const filesRes = yield* handleMutate(
          ["mutate", "--strict", "--files=libs/demo/gates/src/engine.ts"],
          { repoRoot: dir },
        )
        expect(filesRes.exitCode).toBe(0)
        expect(filesRes.stderr).toContain("--files")
        expect(existsSync(stampPath)).toBe(false)

        const warmupExit = yield* Effect.exit(
          ollamaReadiness.ensureOllamaWarmWithResult({
            maxRetries: 0,
            retryDelayMs: 10,
            fetch: () => Promise.reject(new Error("ECONNREFUSED")),
            spawnOllama: () => {
              throw new Error("spawn disabled in test")
            },
          }),
        )
        match(warmupExit)
          .with({ _tag: "Failure" }, ({ cause }) =>
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OllamaWarmupError)
                if (value instanceof OllamaWarmupError) {
                  expect(value.stage).toBe("server-start")
                  expect(value.reason).toContain("spawn disabled in test")
                }
              })
              .with({ _tag: "None" }, () => expect.unreachable("Expected OllamaWarmupError"))
              .exhaustive(),
          )
          .with({ _tag: "Success" }, () => expect.unreachable("Expected warmup error"))
          .exhaustive()
      }),
  )

  it.effect(
    "F-13.1: HarnessVerify.run invokes pnpm nx when pre-flight checks pass and skipSubprocessVerify is omitted",
    () =>
      Effect.gen(function* () {
        const dir = initTempGitRepo("spec0037-verify-nx-positive-")
        git(dir, ["checkout", "-b", "feat/positive-nx"])
        writeFormattedDemoPkg(
          dir,
          "export const isPositive = (n: number): boolean => n >= 1\n",
          [
            'import { expect, it } from "vitest"',
            'import { isPositive } from "../src/engine.js"',
            "",
            'it("kills >=", () => {',
            "  expect(isPositive(1)).toBe(true)",
            "  expect(isPositive(0)).toBe(false)",
            "})",
            "",
          ].join("\n"),
        )
        gitCommitAll(dir, "add formatted pkg")

        const mutateRes = yield* handleMutate(["mutate", "--strict"], { repoRoot: dir })
        expect(mutateRes.exitCode).toBe(0)
        expect(existsSync(join(dir, ".harness", "mutate-stamp.json"))).toBe(true)

        const origExec = nodeSyncHostIo.execFileSync.bind(nodeSyncHostIo)
        let nxCalls = 0
        vi.spyOn(nodeSyncHostIo, "execFileSync").mockImplementation((cmd, args, opts) => {
          if (cmd === "pnpm" && args.includes("nx")) {
            nxCalls += 1
            return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
          }
          return origExec(cmd, args, opts)
        })

        const verifyRes = yield* handleVerify({
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipAutoSessionReport: true,
          mutateStampPolicy: "enforce",
          governanceDocs: [],
          decisionLayer: makeMockDecisionModelLayer(),
        })
        expect(verifyRes.exitCode).toBe(0)
        expect(nxCalls).toBe(1)
      }),
  )

  it.effect(
    "F-6.1: runVerifyFormatPreFlight and handleVerify fail closed with exitCode 1 when oxfmt binary is missing",
    () =>
      Effect.gen(function* () {
        const dir = initTempGitRepo("spec0037-missing-oxfmt-")
        git(dir, ["checkout", "-b", "feat/missing-oxfmt"])
        writeFormattedDemoPkg(
          dir,
          "export const isPositive = (n: number): boolean => n >= 1\n",
          'import { expect, it } from "vitest"\nimport { isPositive } from "../src/engine.js"\nit("ok", () => expect(isPositive(1)).toBe(true))\n',
        )
        gitCommitAll(dir, "add formatted pkg")

        const origExists = nodeSyncHostIo.existsSync.bind(nodeSyncHostIo)
        vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((targetPath) => {
          if (targetPath.endsWith("oxfmt")) {
            return false
          }
          return origExists(targetPath)
        })

        const preflightOpt = runVerifyFormatPreFlight(
          dir,
          ["libs/demo/gates/src/engine.ts"],
          undefined,
        )
        match(preflightOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.exitCode).toBe(1)
            expect(value.stderr).toContain("[GATE FAILURE] verify:format")
            expect(value.stderr).toContain("oxfmt binary not found")
          })
          .with({ _tag: "None" }, () => expect.unreachable("Expected fail-closed format gate"))
          .exhaustive()

        const verifyRes = yield* handleVerify({
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipAutoSessionReport: true,
          mutateStampPolicy: "skip",
          decisionLayer: makeMockDecisionModelLayer(),
        })
        expect(verifyRes.exitCode).toBe(1)
        expect(verifyRes.stderr).toContain("verify:format")
        expect(verifyRes.stderr).toContain("oxfmt binary not found")
      }),
  )

  it.effect(
    "F-3.1, F-10.5 & F-14.3: ensureLocalOllamaReadyDetailed preserves stage/reason, CLI callers set includeEmbeddings appropriately, and doctor reports hookRuntime",
    () =>
      Effect.gen(function* () {
        const requestedPaths: Array<string> = []
        const mockFetch = ((input: Parameters<typeof globalThis.fetch>[0]) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          requestedPaths.push(new URL(url).pathname)
          if (url.endsWith("/api/tags")) {
            return Promise.resolve(
              new Response(JSON.stringify({ models: [{ name: "clef-flash:latest" }] }), {
                status: 200,
              }),
            )
          }
          if (url.endsWith("/v1/systemone")) {
            return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
          }
          return Promise.resolve(new Response("unexpected embeddings call", { status: 500 }))
        }) as typeof globalThis.fetch

        const readyNoEmbed = yield* ollamaReadiness.ensureLocalOllamaReadyDetailed({
          baseUrl: "http://127.0.0.1:11434",
          includeEmbeddings: false,
          force: true,
          fetch: mockFetch,
        })
        expect(readyNoEmbed).toEqual({ ready: true })
        expect(requestedPaths).toContain("/api/tags")
        expect(requestedPaths).toContain("/v1/systemone")
        expect(requestedPaths).not.toContain("/v1/embeddings")

        const detailedFail = yield* ollamaReadiness.ensureLocalOllamaReadyDetailed({
          maxRetries: 0,
          retryDelayMs: 10,
          includeEmbeddings: false,
          force: true,
          fetch: () => Promise.reject(new Error("ECONNREFUSED")),
          spawnOllama: () => {
            throw new Error("spawn disabled in detailed test")
          },
        })
        expect(detailedFail).toMatchObject({
          ready: false,
          stage: "server-start",
          reason: expect.stringContaining("spawn disabled in detailed test"),
        })

        const dir = initTempGitRepo("spec0037-ollama-cli-callers-")
        const recordedOpts: Array<ollamaReadiness.OllamaReadinessOptions | undefined> = []
        vi.spyOn(ollamaReadiness, "ensureLocalOllamaReadyDetailed").mockImplementation((opts) => {
          recordedOpts.push(opts)
          return Effect.succeed({
            ready: false,
            stage: "systemone-probe",
            reason: "clef-flash probe failed (HTTP 503)",
            model: "clef-flash",
            endpoint: "http://127.0.0.1:11434",
          })
        })

        const guardRes = yield* handleGuard(["guard", "--format=antigravity"], {
          repoRoot: dir,
          stdin: JSON.stringify({
            toolCall: {
              name: "run_command",
              args: { CommandLine: "npm run custom-unknown-script" },
            },
          }),
        })
        expect(guardRes.exitCode).toBe(0)
        expect(guardRes.stdout).toContain("stage=systemone-probe")
        expect(guardRes.stdout).toContain("clef-flash probe failed (HTTP 503)")

        const prevRequireOllama = process.env["HARNESS_REQUIRE_OLLAMA"]
        process.env["HARNESS_REQUIRE_OLLAMA"] = "1"
        try {
          const verifyFail = yield* handleVerify({
            repoRoot: dir,
            skipBackgroundDaemons: true,
            skipAutoSessionReport: true,
          })
          expect(verifyFail.exitCode).toBe(1)
          expect(verifyFail.stderr).toContain("[CRITICAL HARNESS BLOCKER]")
          expect(verifyFail.stderr).toContain("stage=systemone-probe")
          expect(verifyFail.stderr).toContain("clef-flash probe failed (HTTP 503)")

          const planFail = yield* handlePlanCheck(["plan-check"], {
            repoRoot: dir,
            governanceDocs: [],
            skipBackgroundDaemons: true,
          })
          expect(planFail.exitCode).toBe(1)
          expect(planFail.stderr).toContain("[CRITICAL HARNESS BLOCKER]")
          expect(planFail.stderr).toContain("stage=systemone-probe")
          expect(planFail.stderr).toContain("clef-flash probe failed (HTTP 503)")

          const doctorFail = yield* handleDoctor(["doctor"], {
            repoRoot: dir,
            skipBackgroundDaemons: true,
          })
          expect(doctorFail.exitCode).toBe(1)
          const doctorFailJson = JSON.parse(doctorFail.stdout) as {
            readonly ollamaReady: boolean
            readonly ollamaError?: { readonly stage: string; readonly reason: string }
            readonly hookRuntime?: { readonly mode: string; readonly reason?: string }
          }
          expect(doctorFailJson.ollamaReady).toBe(false)
          expect(doctorFailJson.ollamaError).toEqual({
            stage: "systemone-probe",
            reason: "clef-flash probe failed (HTTP 503)",
          })
          expect(doctorFailJson.hookRuntime).toEqual({
            mode: "SourceFallback",
            reason: "snapshot-absent-or-unsafe",
          })
          expect(doctorFail.stderr).toContain("ollamaStage=systemone-probe")
          expect(doctorFail.stderr).toContain("clef-flash probe failed (HTTP 503)")
        } finally {
          if (prevRequireOllama === undefined) {
            Reflect.deleteProperty(process.env, "HARNESS_REQUIRE_OLLAMA")
          } else {
            process.env["HARNESS_REQUIRE_OLLAMA"] = prevRequireOllama
          }
        }

        expect(recordedOpts.map((o) => o?.includeEmbeddings)).toEqual([false, false, false, true])

        // Positive doctor hookRuntime check on fresh checkout (SourceFallback without failing doctor)
        const doctorFresh = yield* handleDoctor(["doctor"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          decisionLayer: makeMockDecisionModelLayer(),
        })
        expect(doctorFresh.exitCode).toBe(0)
        expect(JSON.parse(doctorFresh.stdout).hookRuntime).toEqual({
          mode: "SourceFallback",
          reason: "snapshot-absent-or-unsafe",
        })
      }),
  )
})
