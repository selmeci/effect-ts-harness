import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  TelemetryReport,
  collectTopGuardCommandPrefixes,
  decideTelemetryReport,
  detectHangOutlierRecommendations,
  type FrictionEvent,
  type TelemetryEvent,
  type ToolUsageMetric,
} from "../src/index.js"

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
          const isOutlier = m.maxDurationMs > 30_000 && m.maxDurationMs > 5 * m.p95DurationMs
          const hasOutlierRec = report.recommendations.some(
            (r) => r.includes(m.toolName) && r.includes(String(m.maxDurationMs)),
          )
          expect(hasOutlierRec).toBe(isOutlier)
        }

        if (events.every((e) => e.outcome === "diagnostics_found")) {
          expect(report.toolMetrics.every((m) => m.failCount === 0)).toBe(true)
          if (report.kpis.verifyAttempts === 0) {
            expect(report.healthScore).toBe(100)
          }
        }
      }),
  )
})
