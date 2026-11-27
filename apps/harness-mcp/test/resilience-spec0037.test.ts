import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
  LspDiagnosticsTimeoutError,
  ReviewDepth,
  ReviewRouteToolOutput,
  ReviewTimeoutMillis,
} from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents, TelemetryReport } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { runWithTestTracer, type IndexedEffectFn } from "@harness/ingest"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostExecResult } from "@harness/service/host-io"
import {
  createMcpSingleFlightController,
  executeToolEffect,
  extractTs2484CycleHint,
  LspDiagnostics,
  McpSingleFlight,
  recordMcpToolTelemetry,
  resolveLspWatchdogTimeoutMs,
} from "../src/server.js"
import type { LspTsgoExecutor } from "../src/tools/lsp-session-cache.js"

const tempDirs: Array<string> = []

const makeTempWorkspace = (files: Readonly<Record<string, string>>, withGit = true): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-spec0037-"))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf8")
  }
  if (withGit) {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    }
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe", env: gitEnv })
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe", env: gitEnv })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe", env: gitEnv })
  }
  return dir
}

const makeCountingDecisionLayer = (
  onDecide: () => void,
  reviewDepth: "skip" | "lite" | "focused" | "full" = "lite",
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const base = yield* DecisionModel.DecisionModel
      return DecisionModel.DecisionModel.of({
        ...base,
        decide: (definition, options) =>
          Effect.sync(onDecide).pipe(Effect.andThen(base.decide(definition, options))),
      })
    }),
  ).pipe(
    Layer.provide(
      makeMockDecisionModelLayer({
        reviewDepthLabel: ReviewDepth.make(reviewDepth),
      }),
    ),
  )

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("SPEC-0037 WF-3B: LSP Watchdog, Telemetry Classification & MCP Single-Flight", () => {
  it.effect(
    "REQ-1.1 / REQ-1.2: LspDiagnostics.run defaults to 45000 ms watchdog and fails with LspDiagnosticsTimeoutError + TS2484 cycle hint on TimedOut",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace(
          {
            "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
            "libs/pkg/src/index.ts": "export const x: number = 1\n",
          },
          false,
        )

        expect(resolveLspWatchdogTimeoutMs()).toBe(DEFAULT_LSP_WATCHDOG_TIMEOUT_MS)
        expect(resolveLspWatchdogTimeoutMs(undefined, { HARNESS_LSP_WATCHDOG_MS: "1234" })).toBe(
          1234,
        )

        let observedTimeoutMs: number | undefined
        const cleanExec: LspTsgoExecutor = (_bin, _args, opts) =>
          Effect.sync(() => {
            observedTimeoutMs = opts?.timeoutMs
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

        const emptyIndex = new Map<string, IndexedEffectFn>()
        const cleanTraced = yield* runWithTestTracer(
          "LspDiagnostics.run::clean",
          LspDiagnostics.run(repo, { file: "libs/pkg/src/index.ts" }, { execTsgo: cleanExec }),
          emptyIndex,
        )
        expect(cleanTraced.result.clean).toBe(true)
        expect(observedTimeoutMs).toBe(45_000)
        expect(
          cleanTraced.spans.some((s) => s.name === "LspDiagnostics.run" && s.exitTag === "Success"),
        ).toBe(true)

        const timedOutExec: LspTsgoExecutor = () =>
          Effect.succeed({
            _tag: "TimedOut",
            signal: "SIGTERM",
            stdout:
              "libs/pkg/src/index.ts(1,1): error TS2484: Export declaration conflicts with exported declaration in './a.js'.",
            stderr: "",
          } satisfies SyncHostExecResult)

        const timeoutExit = yield* Effect.exit(
          LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts", watchdogTimeoutMs: 750 },
            { execTsgo: timedOutExec },
          ),
        )
        match(timeoutExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            const errOpt = Cause.findErrorOption(cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(LspDiagnosticsTimeoutError)
                if (value instanceof LspDiagnosticsTimeoutError) {
                  expect(value.command).toBe("effect-tsgo")
                  expect(value.timeoutMs).toBe(750)
                  expect(value.cycleHint).toContain("TS2484")
                  expect(value.reason).toContain("750ms")
                }
              })
              .with({ _tag: "None" }, () =>
                expect.unreachable("Expected LspDiagnosticsTimeoutError"),
              )
              .exhaustive()
          })
          .with({ _tag: "Success" }, () =>
            expect.unreachable("Expected LspDiagnosticsTimeoutError failure"),
          )
          .exhaustive()

        // Deterministic TS2484 cycle hint fallback when TimedOut produces empty stdout/stderr
        expect(Option.isNone(extractTs2484CycleHint("", ""))).toBe(true)
        const silentTimeoutExit = yield* Effect.exit(
          LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              commandName: "tsgolint",
              execTsgo: () =>
                Effect.succeed({
                  _tag: "TimedOut",
                  signal: "SIGKILL",
                  stdout: "",
                  stderr: "",
                } satisfies SyncHostExecResult),
            },
          ),
        )
        match(silentTimeoutExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            const errOpt = Cause.findErrorOption(cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(LspDiagnosticsTimeoutError)
                if (value instanceof LspDiagnosticsTimeoutError) {
                  expect(value.command).toBe("tsgolint")
                  expect(value.cycleHint).toContain("TS2484")
                }
              })
              .with({ _tag: "None" }, () =>
                expect.unreachable("Expected LspDiagnosticsTimeoutError for silent timeout"),
              )
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.unreachable("Expected timeout failure"))
          .exhaustive()
      }),
  )

  it.effect(
    "REQ-1.2 / REQ-1.3: harness_lsp_diagnostics catches LspDiagnosticsTimeoutError at MCP boundary and telemetry classifies diagnostics_found vs timeout vs tool_error",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace({
          "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
          "libs/pkg/src/index.ts": "export const x: number = 1\n",
        })

        const timeoutToolResult = (yield* executeToolEffect(
          "harness_lsp_diagnostics",
          { repoRoot: repo, file: "libs/pkg/src/index.ts", watchdogTimeoutMs: 500 },
          {
            repoRoot: repo,
            lspTsgoExecutor: () =>
              Effect.succeed({
                _tag: "TimedOut",
                signal: "SIGTERM",
                stdout: "",
                stderr: "circular re-export detected in index.ts",
              } satisfies SyncHostExecResult),
          },
        )) as {
          readonly clean: boolean
          readonly timedOut?: boolean
          readonly errorTag?: string
          readonly timeoutMs?: number
          readonly cycleHint?: string
          readonly summary: { readonly errors: number }
        }
        expect(timeoutToolResult.clean).toBe(false)
        expect(timeoutToolResult.timedOut).toBe(true)
        expect(timeoutToolResult.errorTag).toBe("LspDiagnosticsTimeoutError")
        expect(timeoutToolResult.timeoutMs).toBe(500)
        expect(timeoutToolResult.cycleHint).toContain("TS2484")
        expect(timeoutToolResult.summary.errors).toBe(1)

        recordMcpToolTelemetry(
          "harness_lsp_diagnostics",
          { repoRoot: repo },
          {
            clean: false,
            diagnostics: [{ message: "Type string is not assignable to number" }],
            summary: {
              filesChecked: 1,
              filesWithoutPlugin: 0,
              totalFiles: 1,
              errors: 1,
              warnings: 0,
              messages: 1,
            },
          },
          20,
          { repoRoot: repo },
        )
        recordMcpToolTelemetry(
          "harness_lsp_diagnostics",
          { repoRoot: repo },
          {
            clean: false,
            toolError: true,
            diagnostics: ["[lsp-spawn-error] ENOENT"],
            summary: {
              filesChecked: 0,
              filesWithoutPlugin: 0,
              totalFiles: 0,
              errors: 1,
              warnings: 0,
              messages: 1,
            },
          },
          5,
          { repoRoot: repo },
        )
        recordMcpToolTelemetry(
          "harness_lsp_diagnostics",
          { repoRoot: repo },
          {
            clean: true,
            diagnostics: [],
            summary: {
              filesChecked: 1,
              filesWithoutPlugin: 0,
              totalFiles: 1,
              errors: 0,
              warnings: 0,
              messages: 0,
            },
          },
          10,
          { repoRoot: repo },
        )

        const events = readTelemetryEvents(repo, nodeSyncHostIo)
        expect(events.map((e) => e.outcome)).toEqual([
          "timeout",
          "diagnostics_found",
          "tool_error",
          "ok",
        ])

        const diagOnlyReport = yield* TelemetryReport.decide({
          events: [events[1]!],
          frictionEvents: [],
        })
        expect(diagOnlyReport.healthScore).toBe(100)
      }),
  )

  it.effect(
    "REQ-2.5: McpSingleFlight.run clamps concurrency <= 2 across distinct keys and skips degraded results",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace({
          "libs/pkg/docs/spec.md": "# Spec\n",
        })
        const controller = createMcpSingleFlightController({ maxConcurrency: 8, maxEntries: 16 })
        expect(controller.getStats().maxConcurrency).toBe(2)

        const gate = yield* Deferred.make<void>()
        let inFlightNow = 0
        let peakInFlight = 0
        let distinctExecs = 0

        const runDistinct = (idx: number) =>
          McpSingleFlight.run({
            controller,
            repoRoot: repo,
            toolName: "harness_ontology_check",
            args: { scope: `scope-${idx}` },
            effect: Effect.gen(function* () {
              distinctExecs += 1
              inFlightNow += 1
              peakInFlight = Math.max(peakInFlight, inFlightNow)
              yield* Deferred.await(gate)
              inFlightNow -= 1
              return { idx, degraded: false }
            }),
          })

        const fiber = yield* Effect.forkChild(
          Effect.all(
            [runDistinct(1), runDistinct(2), runDistinct(3), runDistinct(4), runDistinct(5)],
            {
              concurrency: "unbounded",
            },
          ),
        )
        // Allow queued fibers to hit the semaphore
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(peakInFlight).toBeLessThanOrEqual(2)
        yield* Deferred.succeed(gate, undefined)
        const results = yield* Fiber.join(fiber)
        expect(results).toHaveLength(5)
        expect(distinctExecs).toBe(5)
        expect(peakInFlight).toBe(2)

        // Degraded results must never be memoized
        let degradedCalls = 0
        const degradedRun = () =>
          McpSingleFlight.run({
            controller,
            repoRoot: repo,
            toolName: "harness_review_route",
            args: { changedFiles: ["a.ts"] },
            effect: Effect.sync(() => {
              degradedCalls += 1
              return {
                degraded: false,
                plan: { source: "degraded-fallback" },
              }
            }),
          })
        yield* degradedRun()
        yield* degradedRun()
        expect(degradedCalls).toBe(2)
        expect(controller.getStats().cacheSize).toBe(5)
      }),
  )

  it.effect(
    "REQ-2.5: harness_ontology_check and harness_review_route coalesce 6 parallel identical calls and invalidate on git tree or governance doc changes",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace({
          "libs/pkg/docs/specs/spec-a.md": [
            "---",
            "id: pkg:SPEC-1",
            "title: Alpha Spec",
            "status: accepted",
            "scope: pkg",
            "---",
            "## Requirements",
            "| ID | Pattern | Requirement | Effect Symbol | Verification |",
            "| --- | --- | --- | --- | --- |",
            "| REQ-1.1 | Event-driven | **When** alpha runs, alpha **shall** validate inputs. | Pkg.run | UnitTest |",
            "| REQ-1.2 | Event-driven | **When** alpha runs, alpha **shall** process inputs. | Pkg.run | UnitTest |",
            "",
          ].join("\n"),
          "libs/pkg/docs/specs/spec-b.md": [
            "---",
            "id: pkg:SPEC-2",
            "title: Beta Spec",
            "status: accepted",
            "scope: pkg",
            "---",
            "## Requirements",
            "| ID | Pattern | Requirement | Effect Symbol | Verification |",
            "| --- | --- | --- | --- | --- |",
            "| REQ-2.1 | Event-driven | **When** beta runs, beta **shall** check inputs. | Bar.run | UnitTest |",
            "",
          ].join("\n"),
          "libs/pkg/src/index.ts": "export const v = 1\n",
        })
        const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
        const controller = createMcpSingleFlightController()

        let ontDecisionCalls = 0
        const ontDecisionLayer = makeCountingDecisionLayer(() => {
          ontDecisionCalls += 1
        })
        const emptyIndex = new Map<string, IndexedEffectFn>()

        const parallelOnt = yield* runWithTestTracer(
          "McpSingleFlight.run::ontology",
          Effect.all(
            Array.from({ length: 6 }, () =>
              executeToolEffect(
                "harness_ontology_check",
                { scope: "pkg", repoRoot: repo },
                {
                  repoRoot: repo,
                  graph,
                  skipOmnigraphSpawn: true,
                  skipTelemetry: true,
                  skipActiveWorkspaceLookup: true,
                  singleFlightController: controller,
                  decisionLayer: ontDecisionLayer,
                },
              ),
            ),
            { concurrency: "unbounded" },
          ),
          emptyIndex,
        )
        expect(ontDecisionCalls).toBe(1)
        expect(
          parallelOnt.result.every(
            (r) => JSON.stringify(r) === JSON.stringify(parallelOnt.result[0]),
          ),
        ).toBe(true)
        expect(
          parallelOnt.spans.some(
            (s) => s.name === "McpSingleFlight.run" && s.exitTag === "Success",
          ),
        ).toBe(true)

        // Governance doc change invalidates cache
        fs.writeFileSync(
          path.join(repo, "libs/pkg/docs/specs/spec-a.md"),
          [
            "---",
            "id: pkg:SPEC-1",
            "title: Alpha Spec Updated",
            "status: accepted",
            "scope: pkg",
            "---",
            "## Requirements",
            "| ID | Pattern | Requirement | Effect Symbol | Verification |",
            "| --- | --- | --- | --- | --- |",
            "| REQ-1.1 | Event-driven | **When** alpha runs, alpha **shall** strictly validate inputs. | Pkg.run | UnitTest |",
            "| REQ-1.2 | Event-driven | **When** alpha runs, alpha **shall** process inputs. | Pkg.run | UnitTest |",
            "",
          ].join("\n"),
          "utf8",
        )
        yield* executeToolEffect(
          "harness_ontology_check",
          { scope: "pkg", repoRoot: repo },
          {
            repoRoot: repo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            singleFlightController: controller,
            decisionLayer: ontDecisionLayer,
          },
        )
        expect(ontDecisionCalls).toBe(2)

        // End-to-end 6 parallel harness_review_route calls coalesce into 1 execution
        let reviewDecisionCalls = 0
        const reviewCalls = yield* Effect.all(
          Array.from({ length: 6 }, (_, i) =>
            executeToolEffect(
              "harness_review_route",
              {
                changedFiles: ["libs/pkg/src/index.ts"],
                changedLineCount: 4,
                repoRoot: repo,
                timeoutMs: ReviewTimeoutMillis.make(1000 + i),
              },
              {
                repoRoot: repo,
                graph,
                skipOmnigraphSpawn: true,
                skipTelemetry: true,
                skipActiveWorkspaceLookup: true,
                singleFlightController: controller,
                decisionLayer: makeCountingDecisionLayer(() => {
                  reviewDecisionCalls += 1
                }, "lite"),
              },
            ),
          ),
          { concurrency: "unbounded" },
        )
        expect(reviewDecisionCalls).toBe(1)
        const firstOut = yield* Schema.decodeUnknownEffect(ReviewRouteToolOutput)(reviewCalls[0])
        expect(firstOut.degraded).toBe(false)
        for (const item of reviewCalls) {
          expect(item).toEqual(reviewCalls[0])
        }

        // Real git tree mutation invalidates the review_route cache entry
        fs.writeFileSync(
          path.join(repo, "libs/pkg/src/extra.ts"),
          "export const extra = 2\n",
          "utf8",
        )
        const afterGitChange = yield* executeToolEffect(
          "harness_review_route",
          {
            changedFiles: ["libs/pkg/src/index.ts"],
            changedLineCount: 4,
            repoRoot: repo,
          },
          {
            repoRoot: repo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            singleFlightController: controller,
            decisionLayer: makeCountingDecisionLayer(() => {
              reviewDecisionCalls += 1
            }, "focused"),
          },
        )
        expect(reviewDecisionCalls).toBe(2)
        const changedOut = yield* Schema.decodeUnknownEffect(ReviewRouteToolOutput)(afterGitChange)
        match(changedOut.plan)
          .with({ _tag: "ActiveReviewPlan" }, (plan) => {
            expect(plan.depth).toBe("focused")
          })
          .with({ _tag: "SkipReviewPlan" }, () => expect.unreachable("Expected ActiveReviewPlan"))
          .exhaustive()
      }),
  )
})
