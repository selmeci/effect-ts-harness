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
import {
  buildHookRuntimeSnapshot,
  HarnessHookRuntime,
} from "../src/commands/hook-runtime-loader.js"
import { handleMutate } from "../src/commands/mutate-and-bench.command.js"
import { parseMutateCliFlags } from "../src/commands/mutate-flags.js"
import { ensureOllamaWarmWithResult } from "../src/commands/ollama-readiness.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import { finalizeVerifyPostChecks } from "../src/commands/verify-preflight.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const RESOLVER_PATH = join(REAL_REPO_ROOT, "tools", "node-ts-resolver.mjs")

const tempDirs: Array<string> = []

afterEach(() => {
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
          expect(stubOutcome.stderr).toContain("stub")
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
        expect(initialLoad.result._tag).toBe("SourceFallback")
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
        expect(loadedSnap._tag).toBe("Snapshot")

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
        expect(liveRun.status).not.toBe(0)

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
          ensureOllamaWarmWithResult({
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
})
