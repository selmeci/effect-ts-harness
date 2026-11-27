import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { OllamaWarmupError } from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { handleGuard } from "../src/commands/guard-and-route.command.js"
import * as ollamaReadiness from "../src/commands/ollama-readiness.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import { handleDoctor } from "../src/commands/session-learn-report.command.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")
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
    `${JSON.stringify({ name: "temp-ollama-cli", type: "module" }, null, 2)}\n`,
    "utf8",
  )
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"))
  gitCommitAll(dir, "init")
  return dir
}

describe("SPEC-0037 W3A: CLI Ollama readiness & doctor hookRuntime reporting", () => {
  it.effect("ensureOllamaWarmWithResult surfaces typed OllamaWarmupError stage and reason", () =>
    Effect.gen(function* () {
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
