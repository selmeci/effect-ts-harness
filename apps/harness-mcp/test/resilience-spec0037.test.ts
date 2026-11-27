import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
  LspCommandName,
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
import { launchBackgroundOllamaWarmup } from "../src/managed-runtime.js"
import { toLspTimeoutDiagnosticsReport } from "../src/tools/lsp-watchdog.js"
import type { LspTsgoExecutor } from "../src/tools/lsp-session-cache.js"

const LspTimeoutToolResultSchema = Schema.Struct({
  clean: Schema.Boolean,
  timedOut: Schema.optional(Schema.Boolean),
  errorTag: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Finite),
  cycleHint: Schema.optional(Schema.String),
  summary: Schema.Struct({
    errors: Schema.Finite,
  }),
})

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

        const { result: timeoutExit, spans } = yield* runWithTestTracer(
          "lsp-timeout-span",
          Effect.exit(
            LspDiagnostics.run(
              repo,
              { file: "libs/pkg/src/index.ts", watchdogTimeoutMs: 750 },
              { execTsgo: timedOutExec },
            ),
          ),
          emptyIndex,
        )
        expect(spans.some((s) => s.name === "LspDiagnostics.run")).toBe(true)
        match(timeoutExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            const errOpt = Cause.findErrorOption(cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(LspDiagnosticsTimeoutError)
                if (value instanceof LspDiagnosticsTimeoutError) {
                  expect(value.command).toBe("effect-tsgo")
                  expect(value.timeoutMs).toBe(750)
                  expect(value.targetPath).toBe(path.join(repo, "libs/pkg/src/index.ts"))
                  expect(value.cycleHint).toContain("TS2484: Export declaration conflicts")
                  expect(value.reason).toContain("effect-tsgo timed out after 750ms (SIGTERM)")
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

        // Silent TimedOut leaves cycleHint undefined and emits LSP_TIMEOUT code rather than TS2484
        expect(Option.isNone(extractTs2484CycleHint("", ""))).toBe(true)
        const silentTimeoutExit = yield* Effect.exit(
          LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              commandName: LspCommandName.make("tsgolint"),
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
                  expect(value.cycleHint).toBeUndefined()
                  expect(value.reason).toContain("tsgolint timed out after 45000ms (SIGKILL)")
                  const report = toLspTimeoutDiagnosticsReport(value, "libs/pkg/src/index.ts")
                  expect(report.clean).toBe(false)
                  expect(report.timedOut).toBe(true)
                  expect(report.toolError).toBeUndefined()
                  expect(report.errorTag).toBe("LspDiagnosticsTimeoutError")
                  expect(report.summary.errors).toBe(1)
                  expect(report.diagnostics[0]).toMatchObject({
                    code: "LSP_TIMEOUT",
                    severity: "error",
                    rule: "lsp-watchdog-timeout",
                  })
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

        const rawTimeoutResult = yield* executeToolEffect(
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
        )
        const timeoutToolResult = yield* Schema.decodeUnknownEffect(LspTimeoutToolResultSchema)(
          rawTimeoutResult,
        )
        expect(timeoutToolResult.clean).toBe(false)
        expect(timeoutToolResult.timedOut).toBe(true)
        expect(timeoutToolResult.errorTag).toBe("LspDiagnosticsTimeoutError")
        expect(timeoutToolResult.timeoutMs).toBe(500)
        expect(timeoutToolResult.cycleHint).toContain("TS2484: circular re-export detected")
        expect(timeoutToolResult.summary.errors).toBe(1)
        expect(Reflect.get(timeoutToolResult, "toolError")).toBeUndefined()

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
        expect(diagOnlyReport.totalEvents).toBe(1)
        expect(diagOnlyReport.grade).toBe("A")
        expect(diagOnlyReport.healthScore).toBe(100)
      }),
  )

  it.effect(
    "F-8.1: Signaled, SpawnFailed, or silent non-zero Exited with 0-error JSON returns clean:false and toolError:true",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace(
          {
            "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
            "libs/pkg/src/index.ts": "export const x: number = 1\n",
          },
          false,
        )
        const zeroErrorPayload = JSON.stringify({
          diagnostics: [],
          summary: {
            filesChecked: 1,
            filesWithoutPlugin: 0,
            totalFiles: 1,
            errors: 0,
            warnings: 0,
            messages: 0,
          },
        })

        const stderrChunks: Array<string> = []
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          return true
        })

        try {
          const signaledReport = yield* LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              execTsgo: () =>
                Effect.succeed({
                  _tag: "Signaled",
                  signal: "SIGKILL",
                  stdout: zeroErrorPayload,
                  stderr: "",
                } satisfies SyncHostExecResult),
            },
          )
          expect(signaledReport.clean).toBe(false)
          expect(signaledReport.toolError).toBe(true)
          expect(signaledReport.summary.errors).toBe(1)
          expect(signaledReport.summary.messages).toBe(1)
          expect(signaledReport.diagnostics[0]).toMatchObject({
            code: "LSP_SIGNAL_SIGKILL",
            severity: "error",
            rule: "lsp-process-failure",
          })

          const spawnFailedReport = yield* LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              execTsgo: () =>
                Effect.succeed({
                  _tag: "SpawnFailed",
                  spawnError: "ENOENT",
                  stdout: zeroErrorPayload,
                  stderr: "",
                } satisfies SyncHostExecResult),
            },
          )
          expect(spawnFailedReport.clean).toBe(false)
          expect(spawnFailedReport.toolError).toBe(true)
          expect(spawnFailedReport.summary.errors).toBe(1)
          expect(spawnFailedReport.diagnostics[0]).toMatchObject({
            code: "LSP_SPAWN_ERROR",
            severity: "error",
            rule: "lsp-process-failure",
          })

          const nonZeroSilentReport = yield* LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              execTsgo: () =>
                Effect.succeed({
                  _tag: "Exited",
                  exitCode: 137,
                  stdout: zeroErrorPayload,
                  stderr: "",
                } satisfies SyncHostExecResult),
            },
          )
          expect(nonZeroSilentReport.clean).toBe(false)
          expect(nonZeroSilentReport.toolError).toBe(true)
          expect(nonZeroSilentReport.summary.errors).toBe(1)
          expect(nonZeroSilentReport.diagnostics[0]).toMatchObject({
            code: "LSP_EXIT_137",
            severity: "error",
            rule: "lsp-process-failure",
          })

          // Non-zero exit WITH reported diagnostics remains a regular findings report (toolError undefined)
          const findingsReport = yield* LspDiagnostics.run(
            repo,
            { file: "libs/pkg/src/index.ts" },
            {
              execTsgo: () =>
                Effect.succeed({
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: JSON.stringify({
                    diagnostics: [
                      {
                        file: "libs/pkg/src/index.ts",
                        line: 1,
                        column: 14,
                        code: "TS2322",
                        severity: "error",
                        message: "Type 'string' is not assignable to type 'number'.",
                      },
                    ],
                    summary: {
                      filesChecked: 1,
                      filesWithoutPlugin: 0,
                      totalFiles: 1,
                      errors: 1,
                      warnings: 0,
                      messages: 1,
                    },
                  }),
                  stderr: "",
                } satisfies SyncHostExecResult),
            },
          )
          expect(findingsReport.clean).toBe(false)
          expect(findingsReport.toolError).toBeUndefined()
          expect(findingsReport.summary.errors).toBe(1)

          const stderrText = stderrChunks.join("")
          expect(stderrText).toContain("[lsp-signal-SIGKILL]")
          expect(stderrText).toContain("[lsp-spawn-error]")
          expect(stderrText).toContain("[lsp-exit-137]")
        } finally {
          stderrSpy.mockRestore()
        }
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
        const twoStarted = yield* Deferred.make<void>()
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
              if (inFlightNow === 2) {
                yield* Deferred.succeed(twoStarted, undefined)
              }
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
        // Wait deterministically until 2 fibers are holding the semaphore
        yield* Deferred.await(twoStarted)
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
        for (const r of parallelOnt.result) {
          expect(r).toEqual(parallelOnt.result[0])
        }
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

  it.effect(
    "REQ-2.1: launchBackgroundOllamaWarmup honors HARNESS_SKIP_OLLAMA_WARMUP=1 without running runtime",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const prevSkip = process.env["HARNESS_SKIP_OLLAMA_WARMUP"]
          const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skip-warmup-"))
          tempDirs.push(externalDir)
          const runtime = ManagedRuntime.make(Layer.empty)
          const spy = vi.spyOn(runtime, "runPromiseExit")
          process.env["HARNESS_SKIP_OLLAMA_WARMUP"] = "1"
          return { prevSkip, externalDir, runtime, spy }
        }),
        ({ externalDir, runtime, spy }) =>
          Effect.sync(() => {
            launchBackgroundOllamaWarmup(runtime, externalDir)
            expect(spy).not.toHaveBeenCalled()
          }),
        ({ prevSkip, runtime, spy }) =>
          Effect.promise(async () => {
            spy.mockRestore()
            if (prevSkip === undefined) {
              Reflect.deleteProperty(process.env, "HARNESS_SKIP_OLLAMA_WARMUP")
            } else {
              process.env["HARNESS_SKIP_OLLAMA_WARMUP"] = prevSkip
            }
            await runtime.dispose()
          }),
      ),
  )
})
