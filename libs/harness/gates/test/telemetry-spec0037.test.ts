import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { SyncHostIo } from "@harness/service/host-io"
import { Effect, Schema } from "effect"
import {
  TelemetryReport,
  appendTelemetryEvent,
  buildSessionReport,
  clearTelemetryEvents,
  collectTopGuardCommandPrefixes,
  decideTelemetryReport,
  detectHangOutlierRecommendations,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  writeSessionReportFiles,
  type FrictionEvent,
  type TelemetryEvent,
  type ToolUsageMetric,
} from "../src/index.js"
import { GUARD_TIMEOUT_NEAR_BUDGET_MS } from "../src/telemetry-recommendations.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const captureStderr = <A>(fn: () => A): { readonly result: A; readonly stderrText: string } => {
  const chunks: Array<string> = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stderr.write
  try {
    const result = fn()
    return { result, stderrText: chunks.join("") }
  } finally {
    process.stderr.write = origWrite
  }
}

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
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS,
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

        // Duration threshold (GUARD_TIMEOUT_NEAR_BUDGET_MS - 1 vs GUARD_TIMEOUT_NEAR_BUDGET_MS) and limit=5 top-prefix truncation
        const truncatedPrefixes = collectTopGuardCommandPrefixes(
          [
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS - 1,
              detail: "cmd=ignored fastcmd",
            }),
            mkEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS,
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
    "TelemetryReport.decide satisfies algebraic, monotonicity, and structural invariants (S-3.2)",
    {
      events: Schema.Array(TelemetryPropEvent),
    },
    ({ events }) =>
      Effect.gen(function* () {
        const base = yield* TelemetryReport.decide({ events, cumulative: true })
        expect(base.healthScore).toBeGreaterThanOrEqual(0)
        expect(base.healthScore).toBeLessThanOrEqual(100)

        for (const m of base.toolMetrics) {
          expect(m.successCount + m.failCount + m.denyOrAskCount + m.fallbackCount).toBe(m.calls)
          expect(m.p50DurationMs).toBeLessThanOrEqual(m.p95DurationMs)
          expect(m.p95DurationMs).toBeLessThanOrEqual(m.maxDurationMs)
        }

        const verifyEvents = events.filter((e) => e.toolName === "verify")
        if (verifyEvents.length === 0) {
          expect(base.kpis.firstPassVerify).toBeNull()
        } else {
          expect(base.kpis.firstPassVerify).toBe(
            verifyEvents.length === 1 && verifyEvents[0]?.outcome === "ok",
          )
        }

        const withDiag = yield* TelemetryReport.decide({
          events: [
            ...events,
            mkEvent({
              toolName: "harness_lsp_diagnostics",
              outcome: "diagnostics_found",
              durationMs: 50,
            }),
          ],
          cumulative: true,
        })
        expect(withDiag.healthScore).toBeGreaterThanOrEqual(base.healthScore)
        const baseLspFails =
          base.toolMetrics.find(
            (m) => m.surface === "mcp" && m.toolName === "harness_lsp_diagnostics",
          )?.failCount ?? 0
        const withDiagLspFails =
          withDiag.toolMetrics.find(
            (m) => m.surface === "mcp" && m.toolName === "harness_lsp_diagnostics",
          )?.failCount ?? 0
        expect(withDiagLspFails).toBe(baseLspFails)
        const sumFails = (metrics: ReadonlyArray<ToolUsageMetric>) =>
          metrics.reduce((acc, m) => acc + m.failCount, 0)
        expect(sumFails(withDiag.toolMetrics)).toBe(sumFails(base.toolMetrics))

        const withOutlier = yield* TelemetryReport.decide({
          events: [
            ...events,
            mkEvent({ toolName: "outlier_probe", outcome: "ok", durationMs: 100 }),
            mkEvent({ toolName: "outlier_probe", outcome: "ok", durationMs: 30_001 }),
          ],
          cumulative: true,
        })
        expect(
          withOutlier.recommendations.some(
            (r) => r.startsWith("Hang outlier detected on 'outlier_probe'") && r.includes("30001"),
          ),
        ).toBe(true)
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

  it("F-5.1 & F-5.2: logs stderr warnings on I/O failures, returns written=false on report write failure, and warns on corrupt JSONL lines", () => {
    const dir = mkdtempSync(`${tmpdir()}/spec0037-telemetry-warn-`)
    try {
      const emptyReport = buildSessionReport({ events: [] })
      const okWrite = writeSessionReportFiles(dir, emptyReport, isolatedTestHostIo)
      expect(okWrite.written).toBe(true)
      expect(okWrite.error).toBeUndefined()

      const failingHostIo: SyncHostIo = {
        ...isolatedTestHostIo,
        appendTextSync: () => {
          throw new Error("disk full on append")
        },
        writeTextSync: () => {
          throw new Error("read-only filesystem")
        },
        readTextSync: () => {
          throw new Error("permission denied")
        },
      }

      const appendCap = captureStderr(() =>
        appendTelemetryEvent(
          dir,
          {
            surface: "cli",
            category: "gate",
            toolName: "verify",
            outcome: "ok",
            durationMs: 10,
          },
          failingHostIo,
        ),
      )
      expect(appendCap.result.toolName).toBe("verify")
      expect(appendCap.stderrText).toContain("disk full on append")

      const clearCap = captureStderr(() => clearTelemetryEvents(dir, failingHostIo))
      expect(clearCap.stderrText).toContain("read-only filesystem")

      const reportCap = captureStderr(() =>
        writeSessionReportFiles(dir, emptyReport, failingHostIo),
      )
      expect(reportCap.result.written).toBe(false)
      expect(reportCap.result.error).toBe("read-only filesystem")
      expect(reportCap.stderrText).toContain("read-only filesystem")

      const logPath = join(dir, ".harness", "telemetry-log.jsonl")
      const validLine = JSON.stringify(mkEvent({ toolName: "gc", outcome: "ok", durationMs: 15 }))
      writeFileSync(
        logPath,
        `${validLine}\n{corrupt json\n\n{"wrong":"shape"}\n${validLine}\n`,
        "utf8",
      )
      const corruptReadCap = captureStderr(() => readTelemetryEvents(dir, isolatedTestHostIo))
      expect(corruptReadCap.result).toHaveLength(2)
      expect(corruptReadCap.stderrText).toContain("2 malformed telemetry JSONL line(s)")

      const unreadableCap = captureStderr(() => readTelemetryEvents(dir, failingHostIo))
      expect(unreadableCap.result).toEqual([])
      expect(unreadableCap.stderrText).toContain("permission denied")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
