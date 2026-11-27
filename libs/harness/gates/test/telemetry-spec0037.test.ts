import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  TelemetryReport,
  appendTelemetryEvent,
  buildSessionReport,
  collectTopGuardCommandPrefixes,
  decideTelemetryReport,
  detectHangOutlierRecommendations,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  type FrictionEvent,
  type TelemetryEvent,
  type ToolUsageMetric,
} from "../src/index.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const mkEvent = (
  overrides: Partial<TelemetryEvent> & Pick<TelemetryEvent, "toolName" | "outcome">,
): TelemetryEvent => ({
  timestamp: "2026-11-27T10:00:00.000Z",
  surface: "mcp",
  category: "gate",
  durationMs: 120,
  ...overrides,
})

const TelemetryPropEvent = Schema.Struct({
  timestamp: Schema.Literals(["2026-11-27T10:00:00.000Z"]),
  surface: Schema.Literals(["cli", "mcp", "hook"]),
  category: Schema.Literals(["gate", "graph_query", "ontology", "guard", "routing", "lifecycle"]),
  toolName: Schema.Literals([
    "harness_lsp_diagnostics",
    "verify",
    "gc",
    "guard",
    "harness_ontology_check",
  ]),
  outcome: Schema.Literals([
    "ok",
    "fail",
    "deny",
    "ask",
    "fallback",
    "diagnostics_found",
    "timeout",
    "tool_error",
  ]),
  durationMs: Schema.Literals([50, 500, 5200, 45_000]),
  detail: Schema.optional(
    Schema.Literals(["normal", "degraded=stale", "cmd=sed -n '1,20p' libs/foo.ts"]),
  ),
})

describe("SPEC-0037 REQ-5.1..REQ-5.4: TelemetryReport.decide accuracy & actionable diagnostics", () => {
  it.effect(
    "REQ-5.1 excludes diagnostics_found from failCount and healthScore penalties while penalizing tool_error, timeout, and degraded fallback",
    () =>
      Effect.gen(function* () {
        const diagOnly = yield* TelemetryReport.decide({
          events: [
            mkEvent({ toolName: "harness_lsp_diagnostics", outcome: "diagnostics_found" }),
            mkEvent({ toolName: "harness_lsp_diagnostics", outcome: "diagnostics_found" }),
            mkEvent({ toolName: "harness_lsp_diagnostics", outcome: "ok" }),
          ],
        })
        expect(diagOnly.healthScore).toBe(100)
        const lspMetric = diagOnly.toolMetrics.find((m) => m.toolName === "harness_lsp_diagnostics")
        expect(lspMetric?.failCount).toBe(0)
        expect(lspMetric?.successCount).toBe(3)

        const realErrors = yield* decideTelemetryReport({
          events: [
            mkEvent({ toolName: "harness_lsp_diagnostics", outcome: "tool_error" }),
            mkEvent({
              toolName: "harness_lsp_diagnostics",
              outcome: "timeout",
              durationMs: 45_000,
            }),
            mkEvent({
              toolName: "harness_ontology_check",
              category: "ontology",
              outcome: "fallback",
              detail: "degraded=ollama-busy",
            }),
          ],
        })
        // 2 tool_error/timeout (-10) + 1 degraded mcp fallback (-5) = 85
        expect(realErrors.healthScore).toBe(85)
        const errMetric = realErrors.toolMetrics.find(
          (m) => m.toolName === "harness_lsp_diagnostics",
        )
        expect(errMetric?.failCount).toBe(2)
      }),
  )

  it.effect(
    "REQ-5.2 emits hang-outlier recommendation when maxDurationMs > 30000 and maxDurationMs > 5 * p95DurationMs",
    () =>
      Effect.gen(function* () {
        const fastSamples = Array.from({ length: 25 }, () =>
          mkEvent({ toolName: "harness_lsp_diagnostics", outcome: "ok", durationMs: 100 }),
        )
        const withHang = yield* TelemetryReport.decide({
          events: [
            ...fastSamples,
            mkEvent({
              toolName: "harness_lsp_diagnostics",
              outcome: "timeout",
              durationMs: 120_000,
            }),
          ],
        })
        const outlierRec = withHang.recommendations.find(
          (r) => r.includes("harness_lsp_diagnostics") && r.includes("120000"),
        )
        expect(outlierRec).toBeDefined()

        // Uniformly slow without 5x p95 ratio should not trigger hang-outlier recommendation
        const uniformMetric: ToolUsageMetric = {
          toolName: "verify",
          surface: "cli",
          category: "gate",
          calls: 1,
          successCount: 1,
          failCount: 0,
          denyOrAskCount: 0,
          fallbackCount: 0,
          successRate: 1,
          meanDurationMs: 45_000,
          p50DurationMs: 45_000,
          p95DurationMs: 45_000,
          maxDurationMs: 45_000,
        }
        const uniformSlow = detectHangOutlierRecommendations([uniformMetric])
        expect(uniformSlow).toEqual([])

        // Boundary tests: exact 30_000ms and 5 * p95 thresholds + N <= 20 p50 baseline
        expect(
          detectHangOutlierRecommendations([
            {
              toolName: "t-eq-min",
              calls: 30,
              p50DurationMs: 100,
              p95DurationMs: 100,
              maxDurationMs: 30_000,
            },
            {
              toolName: "t-eq-mult",
              calls: 30,
              p50DurationMs: 100,
              p95DurationMs: 10_000,
              maxDurationMs: 50_000,
            },
          ]),
        ).toEqual([])
        const boundaryHits = detectHangOutlierRecommendations([
          {
            toolName: "t-over-min",
            calls: 30,
            p50DurationMs: 100,
            p95DurationMs: 100,
            maxDurationMs: 30_001,
          },
          {
            toolName: "t-over-mult",
            calls: 30,
            p50DurationMs: 100,
            p95DurationMs: 10_000,
            maxDurationMs: 50_001,
          },
          {
            toolName: "t-small-n",
            calls: 5,
            p50DurationMs: 100,
            p95DurationMs: 120_000,
            maxDurationMs: 120_000,
          },
        ])
        expect(boundaryHits).toHaveLength(3)
        expect(boundaryHits[2]).toContain("t-small-n")
      }),
  )

  it.effect(
    "REQ-5.3 groups guard timeouts and escalations by normalized 2-token command prefix in recommendations",
    () =>
      Effect.gen(function* () {
        const frictionEvents: ReadonlyArray<FrictionEvent> = [
          {
            timestamp: "2026-11-27T10:00:00.000Z",
            kind: "guard_escalation",
            summary: "CI=true sed -n '1,20p' libs/a.ts",
            detail: "verdict=ask; reason=DecisionModel timed out",
          },
          {
            timestamp: "2026-11-27T10:00:01.000Z",
            kind: "guard_escalation",
            summary: "sed -n '21,40p' libs/b.ts",
            detail: "verdict=ask; reason=DecisionModel timed out",
          },
          {
            timestamp: "2026-11-27T10:00:02.000Z",
            kind: "guard_escalation",
            summary: "pnpm --dir libs/gates test",
            detail: "verdict=allow; fastpath=hit",
          },
        ]
        const prefixes = collectTopGuardCommandPrefixes(
          [
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5005,
              detail: "cmd=pnpm --dir libs/foo lint",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: 2450,
              detail: "cmd=git status --short",
            }),
          ],
          frictionEvents,
        )
        expect(prefixes).toEqual([
          { prefix: "sed -n", count: 2 },
          { prefix: "git status", count: 1 },
          { prefix: "pnpm --dir", count: 1 },
        ])

        const report = yield* TelemetryReport.decide({
          events: [
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5005,
              detail: "cmd=sed -n '1,5p' libs/a.ts",
            }),
          ],
          frictionEvents,
        })
        const prefixRec = report.recommendations.find((r) => r.includes("sed -n"))
        expect(prefixRec).toBeDefined()
        expect(report.healthScore).toBeLessThan(100)

        // Duration threshold (2449 vs 2450) and limit=5 top-prefix truncation
        const truncatedPrefixes = collectTopGuardCommandPrefixes(
          [
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: 2449,
              detail: "cmd=ignored fastcmd",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: 2450,
              detail: "cmd=git status",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5000,
              detail: "cmd=wc -l a",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5000,
              detail: "cmd=rg foo a",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5000,
              detail: "cmd=sed -n a",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5000,
              detail: "cmd=pnpm --dir a",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "timeout",
              durationMs: 5000,
              detail: "cmd=df -ih",
            }),
          ],
          [],
        )
        expect(truncatedPrefixes).toHaveLength(5)
        expect(truncatedPrefixes.some((p) => p.prefix === "ignored fastcmd")).toBe(false)
      }),
  )

  it.effect(
    "REQ-5.4 computes firstPassVerify strictly from active window verifyAttempts === 1 && fixUpIterations === 0",
    () =>
      Effect.gen(function* () {
        const empty = yield* TelemetryReport.decide({ events: [] })
        expect(empty.kpis.firstPassVerify).toBeNull()

        const singleGreen = yield* TelemetryReport.decide({
          events: [mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" })],
        })
        expect(singleGreen.kpis.verifyAttempts).toBe(1)
        expect(singleGreen.kpis.fixUpIterations).toBe(0)
        expect(singleGreen.kpis.firstPassVerify).toBe(true)

        const twoGreens = yield* TelemetryReport.decide({
          events: [
            mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" }),
            mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" }),
          ],
        })
        expect(twoGreens.kpis.verifyAttempts).toBe(2)
        expect(twoGreens.kpis.fixUpIterations).toBe(0)
        expect(twoGreens.kpis.firstPassVerify).toBe(false)

        const failThenGreen = yield* TelemetryReport.decide({
          events: [
            mkEvent({ surface: "cli", toolName: "verify", outcome: "fail" }),
            mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" }),
          ],
        })
        expect(failThenGreen.kpis.verifyAttempts).toBe(2)
        expect(failThenGreen.kpis.fixUpIterations).toBe(1)
        expect(failThenGreen.kpis.firstPassVerify).toBe(false)

        // Two consecutive clean CLI verify -> done tasks must scope to the latest task window
        const twoCleanTasks = yield* TelemetryReport.decide({
          events: [
            mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" }),
            mkEvent({ surface: "cli", toolName: "done", category: "lifecycle", outcome: "ok" }),
            mkEvent({ surface: "mcp", toolName: "harness_lsp_diagnostics", outcome: "ok" }),
            mkEvent({ surface: "cli", toolName: "verify", outcome: "ok" }),
            mkEvent({ surface: "cli", toolName: "done", category: "lifecycle", outcome: "ok" }),
          ],
        })
        expect(twoCleanTasks.kpis.verifyAttempts).toBe(1)
        expect(twoCleanTasks.kpis.firstPassVerify).toBe(true)
      }),
  )

  it.effect.prop(
    "TelemetryReport.decide preserves KPI consistency, hang-outlier detection, and diagnostics_found zero-penalty invariants",
    {
      events: Schema.Array(TelemetryPropEvent),
    },
    ({ events }) =>
      Effect.gen(function* () {
        const report = yield* TelemetryReport.decide({ events, cumulative: true })
        expect(report.healthScore).toBeGreaterThanOrEqual(0)
        expect(report.healthScore).toBeLessThanOrEqual(100)

        const expectedFirstPass =
          report.kpis.verifyAttempts === 0
            ? null
            : report.kpis.verifyAttempts === 1 &&
              report.kpis.fixUpIterations === 0 &&
              events.find((e) => e.toolName === "verify")?.outcome === "ok"
        expect(report.kpis.firstPassVerify).toBe(expectedFirstPass)

        for (const m of report.toolMetrics) {
          const baseline = m.calls <= 20 ? m.p50DurationMs : m.p95DurationMs
          const isAnySurfaceOutlier = report.toolMetrics.some((other) => {
            const otherBaseline = other.calls <= 20 ? other.p50DurationMs : other.p95DurationMs
            return (
              other.toolName === m.toolName &&
              other.maxDurationMs === m.maxDurationMs &&
              other.maxDurationMs > 30_000 &&
              other.maxDurationMs > 5 * otherBaseline
            )
          })
          const hasOutlierRec = report.recommendations.some(
            (r) =>
              r.startsWith(`Hang outlier detected on '${m.toolName}'`) &&
              r.includes(`maxDurationMs=${m.maxDurationMs} ms`),
          )
          expect(hasOutlierRec).toBe(
            isAnySurfaceOutlier || (m.maxDurationMs > 30_000 && m.maxDurationMs > 5 * baseline),
          )
        }

        if (events.every((e) => e.outcome === "diagnostics_found")) {
          expect(report.toolMetrics.every((m) => m.failCount === 0)).toBe(true)
          if (report.kpis.verifyAttempts === 0) {
            expect(report.healthScore).toBe(100)
          }
        }
      }),
  )

  it("REQ-5.2 & REQ-5.1: uses p50 baseline at calls === 20 boundary and persists optional engineSource/detail fields accurately", () => {
    const exactBoundaryOutliers = detectHangOutlierRecommendations([
      {
        toolName: "t20",
        calls: 20,
        p50DurationMs: 100,
        p95DurationMs: 60_000,
        maxDurationMs: 60_000,
      },
    ])
    expect(exactBoundaryOutliers).toHaveLength(1)
    expect(exactBoundaryOutliers[0]).toContain("p50=100 ms")

    const dir = mkdtempSync(`${tmpdir()}/spec0037-telemetry-io-`)
    try {
      const withOptional = appendTelemetryEvent(
        dir,
        {
          surface: "cli",
          category: "gate",
          toolName: "verify",
          outcome: "ok",
          durationMs: 12,
          engineSource: "local",
          detail: "clean",
        },
        isolatedTestHostIo,
      )
      expect(withOptional.engineSource).toBe("local")
      expect(withOptional.detail).toBe("clean")

      const withoutOptional = appendTelemetryEvent(
        dir,
        {
          surface: "cli",
          category: "gate",
          toolName: "gc",
          outcome: "ok",
          durationMs: 5,
        },
        isolatedTestHostIo,
      )
      expect("engineSource" in withoutOptional).toBe(false)
      expect("detail" in withoutOptional).toBe(false)

      const loaded = readTelemetryEvents(dir, isolatedTestHostIo)
      expect(loaded).toHaveLength(2)
      expect(loaded[0]?.engineSource).toBe("local")
      expect(loaded[0]?.detail).toBe("clean")
      expect("engineSource" in (loaded[1] ?? {})).toBe(false)
      expect("detail" in (loaded[1] ?? {})).toBe(false)

      const emptyReport = buildSessionReport({ events: [] })
      expect(renderSessionReportMarkdown(emptyReport)).toContain(
        "- No recommendations — session executed cleanly.",
      )
      const nonEmptyMd = renderSessionReportMarkdown({
        ...emptyReport,
        recommendations: ["Check watchdog timeout"],
      })
      expect(nonEmptyMd).toContain("- Check watchdog timeout")
      expect(nonEmptyMd).not.toContain("No recommendations — session executed cleanly.")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
