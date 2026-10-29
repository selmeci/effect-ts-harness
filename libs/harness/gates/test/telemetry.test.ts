import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

const FastCheck = {
  assert: (prop: () => void, _options?: { readonly numRuns?: number }): void => {
    prop()
  },
  property: <T1, T2>(
    arb1: () => T1,
    arb2: () => T2,
    fn: (val1: T1, val2: T2) => void
  ): (() => void) => () => {
    for (let i = 0; i < 100; i++) {
      fn(arb1(), arb2())
    }
  },
  constantFrom: <T>(...values: ReadonlyArray<T>): (() => T) => () =>
    values[Math.floor(Math.random() * values.length)]!,
  constant: <T>(val: T): (() => T) => () => val,
  integer: ({ min, max }: { min: number; max: number }): (() => number) => () =>
    Math.floor(Math.random() * (max - min + 1)) + min,
  array: <T>(gen: () => T, { maxLength }: { maxLength: number }): (() => ReadonlyArray<T>) => () => {
    const len = Math.floor(Math.random() * (maxLength + 1))
    return Array.from({ length: len }, () => gen())
  },
  record: <T extends Record<string, unknown>>(shape: { [K in keyof T]: () => T[K] }): (() => T) => () => {
    const obj = {} as Record<string, unknown>
    for (const key of Object.keys(shape)) {
      obj[key] = shape[key as keyof T]!()
    }
    return obj as T
  }
}
import {
  appendTelemetryEvent,
  clearTelemetryEvents,
  decideSessionReport,
  type FrictionEvent,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  scopeSessionReportInput,
  type SessionReport,
  type TelemetryCategory,
  type TelemetryEngineSource,
  TelemetryEvent,
  type TelemetryOutcome,
  type TelemetrySurface,
  writeSessionReportFiles
} from "../src/index.js"

describe("telemetry & session observability", () => {
  it.effect("computes correct KPIs and health score on a realistic multi-step workflow", () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<TelemetryEvent> = [
        {
          timestamp: "2026-10-27T10:00:00.000Z",
          surface: "mcp",
          category: "graph_query",
          toolName: "harness_resolve",
          outcome: "ok",
          durationMs: 12,
          engineSource: "local"
        },
        {
          timestamp: "2026-10-27T10:00:01.000Z",
          surface: "mcp",
          category: "graph_query",
          toolName: "harness_callers",
          outcome: "ok",
          durationMs: 18,
          engineSource: "local"
        },
        {
          timestamp: "2026-10-27T10:00:02.000Z",
          surface: "mcp",
          category: "ontology",
          toolName: "harness_ontology_check",
          outcome: "ok",
          durationMs: 25,
          engineSource: "decision-model"
        },
        {
          timestamp: "2026-10-27T10:00:03.000Z",
          surface: "mcp",
          category: "graph_query",
          toolName: "harness_gq_query",
          outcome: "ok",
          durationMs: 35,
          engineSource: "omnigraph"
        },
        {
          timestamp: "2026-10-27T10:00:04.000Z",
          surface: "cli",
          category: "gate",
          toolName: "plan-check",
          outcome: "ok",
          durationMs: 400
        },
        {
          timestamp: "2026-10-27T10:00:05.000Z",
          surface: "cli",
          category: "gate",
          toolName: "verify",
          outcome: "fail",
          durationMs: 800
        },
        {
          timestamp: "2026-10-27T10:00:06.000Z",
          surface: "cli",
          category: "gate",
          toolName: "gc",
          outcome: "ok",
          durationMs: 150
        },
        {
          timestamp: "2026-10-27T10:00:07.000Z",
          surface: "cli",
          category: "gate",
          toolName: "verify",
          outcome: "ok",
          durationMs: 750
        },
        {
          timestamp: "2026-10-27T10:00:08.000Z",
          surface: "cli",
          category: "lifecycle",
          toolName: "done",
          outcome: "ok",
          durationMs: 50
        }
      ]

      const report = yield* decideSessionReport({ events })

      expect(report.totalEvents).toBe(9)
      expect(report.totalDurationMs).toBe(2240)
      expect(report.bySurface.cli).toBe(5)
      expect(report.bySurface.mcp).toBe(4)
      expect(report.byCategory.graph_query).toBe(3)
      expect(report.byCategory.ontology).toBe(1)
      expect(report.byCategory.gate).toBe(4)
      expect(report.byCategory.lifecycle).toBe(1)

      // KPIs
      expect(report.kpis.firstPassVerify).toBe(false)
      expect(report.kpis.verifyAttempts).toBe(2)
      expect(report.kpis.fixUpIterations).toBe(1)
      expect(report.kpis.planBeforeVerify).toBe(true)
      expect(report.kpis.prematureDoneAttempts).toBe(0)
      expect(report.kpis.graphDiscoveryCalls).toBe(4)
      expect(report.kpis.graphDiscoveryRatio).toBe(0.44) // 4 / 9 = 0.44
      expect(report.kpis.omnigraphLiveRatio).toBe(1)
      expect(report.kpis.guardInterventions).toBe(0)
      expect(report.kpis.frictionCount).toBe(0)

      // Health score: 100 - (1 fixup * 15) = 85 (Grade B)
      expect(report.healthScore).toBe(85)
      expect(report.grade).toBe("B")

      // Tool metrics
      const verifyMetric = report.toolMetrics.find((m) => m.toolName === "verify")
      expect(verifyMetric).toBeDefined()
      expect(verifyMetric?.calls).toBe(2)
      expect(verifyMetric?.successCount).toBe(1)
      expect(verifyMetric?.failCount).toBe(1)
      expect(verifyMetric?.successRate).toBe(0.5)
      expect(verifyMetric?.p50DurationMs).toBe(750)
      expect(verifyMetric?.maxDurationMs).toBe(800)

      expect(report.recommendations).toContain(
        "Run 'harness gc --strict' and 'harness ontology check --strict' before 'harness verify' to reduce fix-up iterations."
      )

      const rendered = renderSessionReportMarkdown(report)
      expect(rendered).toContain("# Harness Session Observability Report")
      expect(rendered).toContain("Health Score")
    })
  )

  it.effect("penalizes premature done, unverified workflows, and guard escalations", () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<TelemetryEvent> = [
        {
          timestamp: "2026-10-27T11:00:00.000Z",
          surface: "hook",
          category: "guard",
          toolName: "guard",
          outcome: "deny",
          durationMs: 5
        },
        {
          timestamp: "2026-10-27T11:00:01.000Z",
          surface: "hook",
          category: "guard",
          toolName: "guard",
          outcome: "ask",
          durationMs: 8
        },
        {
          timestamp: "2026-10-27T11:00:02.000Z",
          surface: "cli",
          category: "lifecycle",
          toolName: "done",
          outcome: "fail",
          durationMs: 15
        },
        {
          timestamp: "2026-10-27T11:00:03.000Z",
          surface: "cli",
          category: "gate",
          toolName: "verify",
          outcome: "ok",
          durationMs: 300
        },
        {
          timestamp: "2026-10-27T11:00:04.000Z",
          surface: "cli",
          category: "lifecycle",
          toolName: "done",
          outcome: "ok",
          durationMs: 20
        }
      ]

      const frictionEvents = [
        {
          kind: "route_miss" as const,
          timestamp: "2026-10-27T11:00:01.500Z",
          summary: "test",
          detail: "route miss"
        }
      ]

      const report = yield* decideSessionReport({ events, frictionEvents })

      expect(report.kpis.planBeforeVerify).toBe(false)
      expect(report.kpis.prematureDoneAttempts).toBe(1)
      expect(report.kpis.guardInterventions).toBe(2)
      expect(report.kpis.frictionCount).toBe(1)
      expect(report.kpis.graphDiscoveryCalls).toBe(0)

      // Score: 100 - 15 (no plan) - 10 (premature done) - 5 (friction) = 70 (Grade C)
      expect(report.healthScore).toBe(70)
      expect(report.grade).toBe("C")

      expect(report.recommendations).toContain(
        "Execute planning/discovery tools ('harness route', 'harness ontology check', or 'harness plan-check') before running 'harness verify'."
      )
      expect(report.recommendations).toContain(
        "Avoid invoking 'harness done' before 'harness verify' produces a valid verify-stamp.json."
      )
      expect(report.recommendations).toContain(
        "Use semantic MCP graph & ontology tools ('harness_resolve', 'harness_callers', 'harness_ontology_why', 'harness_gq_query') to inspect topology before editing."
      )
    })
  )

  it.effect("handles fallback queries and zero-call empty sessions cleanly", () =>
    Effect.gen(function* () {
      const emptyReport = yield* decideSessionReport({ events: [] })
      expect(emptyReport.totalEvents).toBe(0)
      expect(emptyReport.totalDurationMs).toBe(0)
      expect(emptyReport.healthScore).toBe(100)
      expect(emptyReport.grade).toBe("A")
      expect(emptyReport.kpis.firstPassVerify).toBeNull()
      expect(emptyReport.kpis.omnigraphLiveRatio).toBeNull()

      const fallbackEvents: ReadonlyArray<TelemetryEvent> = [
        {
          timestamp: "2026-10-27T12:00:00.000Z",
          surface: "mcp",
          category: "graph_query",
          toolName: "harness_gq_query",
          outcome: "fallback",
          durationMs: 50,
          engineSource: "memory-fallback"
        }
      ]
      const fallbackReport = yield* decideSessionReport({ events: fallbackEvents })
      expect(fallbackReport.kpis.omnigraphLiveRatio).toBe(0)
      expect(fallbackReport.recommendations).toContain(
        "Queries used deterministic in-memory fallback ('memory-fallback'). Start Omnigraph server if persistent branch queries are needed."
      )
    })
  )

  it.effect("appends, reads, clears telemetry events and writes report files in state directory", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-telemetry-test-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        })
      )

      expect(readTelemetryEvents(tmpDir)).toEqual([])

      appendTelemetryEvent(tmpDir, {
        surface: "cli",
        category: "gate",
        toolName: "plan-check",
        outcome: "ok",
        durationMs: 120
      })

      appendTelemetryEvent(tmpDir, {
        surface: "mcp",
        category: "graph_query",
        toolName: "harness_resolve",
        outcome: "ok",
        durationMs: 15,
        engineSource: "local"
      })

      const readBack = readTelemetryEvents(tmpDir)
      expect(readBack.length).toBe(2)
      expect(readBack[0]?.toolName).toBe("plan-check")
      expect(readBack[1]?.toolName).toBe("harness_resolve")

      const report: SessionReport = yield* decideSessionReport({ events: readBack })
      const written = writeSessionReportFiles(tmpDir, report)
      expect(existsSync(written.jsonPath)).toBe(true)
      expect(existsSync(written.markdownPath)).toBe(true)

      const mdContent = readFileSync(written.markdownPath, "utf-8")
      expect(mdContent).toContain("# Harness Session Observability Report")
      expect(mdContent).toContain("plan-check")
      expect(mdContent).toContain("harness_resolve")

      clearTelemetryEvents(tmpDir)
      expect(readTelemetryEvents(tmpDir)).toEqual([])
    })
  )

  it("SessionReport.decide satisfies bounded score invariant under FastCheck", () => {

      const surfaceArb = FastCheck.constantFrom<TelemetrySurface>("cli", "mcp", "hook")
      const categoryArb = FastCheck.constantFrom<TelemetryCategory>(
        "gate",
        "graph_query",
        "ontology",
        "guard",
        "routing",
        "lifecycle"
      )
      const outcomeArb = FastCheck.constantFrom<TelemetryOutcome>(
        "ok",
        "fail",
        "deny",
        "ask",
        "fallback"
      )
      const engineSourceArb = FastCheck.constantFrom<TelemetryEngineSource | undefined>(
        undefined,
        "omnigraph",
        "memory-fallback",
        "local",
        "decision-model"
      )

      const eventArb = FastCheck.record<TelemetryEvent>({
        timestamp: FastCheck.constant("2026-10-27T12:00:00.000Z"),
        surface: surfaceArb,
        category: categoryArb,
        toolName: FastCheck.constantFrom(
          "verify",
          "plan-check",
          "route",
          "done",
          "harness_resolve",
          "harness_gq_query",
          "guard"
        ),
        outcome: outcomeArb,
        durationMs: FastCheck.integer({ min: 0, max: 5000 }),
        engineSource: engineSourceArb
      })

      FastCheck.assert(
        FastCheck.property(
          FastCheck.array(eventArb, { maxLength: 25 }),
          FastCheck.integer({ min: 0, max: 10 }),
          (events, frictionCount) => {
            const frictionEvents = Array.from({ length: frictionCount }, (_, i) => ({
              kind: "route_miss" as const,
              timestamp: "2026-10-27T12:00:00.000Z",
              summary: `friction-${i}`,
              detail: "detail"
            }))

            const report = Effect.runSync(
              decideSessionReport({ events, frictionEvents })
            )

            expect(report.totalEvents).toBeGreaterThanOrEqual(0)
            expect(report.totalEvents).toBeLessThanOrEqual(events.length)
            expect(report.healthScore).toBeGreaterThanOrEqual(0)
            expect(report.healthScore).toBeLessThanOrEqual(100)

            if (report.healthScore >= 90) {
              expect(report.grade).toBe("A")
            } else if (report.healthScore >= 75) {
              expect(report.grade).toBe("B")
            } else if (report.healthScore >= 60) {
              expect(report.grade).toBe("C")
            } else {
              expect(report.grade).toBe("D")
            }
          }
        ),
        { numRuns: 100 }
      )
  })

  it.effect.prop(
    "SessionReport.decide preserves event count across arbitrary input lists",
    [Schema.Array(TelemetryEvent)],
    ([events]) =>
      Effect.gen(function* () {
        const report = yield* decideSessionReport({ events, cumulative: true })
        expect(report.totalEvents).toBe(events.length)
        expect(report.healthScore).toBeGreaterThanOrEqual(0)
        expect(report.healthScore).toBeLessThanOrEqual(100)
      })
  )

  it.effect(
    "scopes multi-task telemetry and friction logs to the active task window while ignoring hook Stop turns in prematureDoneAttempts",
    () =>
      Effect.gen(function* () {
        const events: ReadonlyArray<TelemetryEvent> = [
          // Task 1 (completed earlier)
          {
            timestamp: "2026-10-27T09:00:00.000Z",
            surface: "cli",
            category: "gate",
            toolName: "verify",
            outcome: "fail",
            durationMs: 500
          },
          {
            timestamp: "2026-10-27T09:05:00.000Z",
            surface: "cli",
            category: "lifecycle",
            toolName: "done",
            outcome: "ok",
            durationMs: 20
          },
          // Task 2 (active/latest task)
          {
            timestamp: "2026-10-28T10:00:00.000Z",
            surface: "cli",
            category: "gate",
            toolName: "plan-check",
            outcome: "ok",
            durationMs: 300
          },
          // Automatic Antigravity Stop hook turn handoff after plan-check (should NOT penalize prematureDoneAttempts)
          {
            timestamp: "2026-10-28T10:01:00.000Z",
            surface: "hook",
            category: "lifecycle",
            toolName: "done",
            outcome: "fail",
            durationMs: 11
          },
          {
            timestamp: "2026-10-28T10:02:00.000Z",
            surface: "mcp",
            category: "ontology",
            toolName: "harness_ontology_check",
            outcome: "ok",
            durationMs: 40,
            engineSource: "local"
          },
          {
            timestamp: "2026-10-28T10:03:00.000Z",
            surface: "cli",
            category: "gate",
            toolName: "verify",
            outcome: "ok",
            durationMs: 450
          },
          {
            timestamp: "2026-10-28T10:04:00.000Z",
            surface: "cli",
            category: "lifecycle",
            toolName: "done",
            outcome: "ok",
            durationMs: 25
          }
        ]

        const frictionEvents = [
          // Stale friction from Task 1 (before 2026-10-28T10:00:00.000Z)
          {
            kind: "guard_escalation" as const,
            timestamp: "2026-10-27T09:01:00.000Z",
            summary: "old command",
            detail: "old friction"
          }
        ]

        const scopedReport = yield* decideSessionReport({ events, frictionEvents })
        expect(scopedReport.totalEvents).toBe(5)
        expect(scopedReport.kpis.verifyAttempts).toBe(1)
        expect(scopedReport.kpis.fixUpIterations).toBe(0)
        expect(scopedReport.kpis.prematureDoneAttempts).toBe(0)
        expect(scopedReport.kpis.frictionCount).toBe(0)
        expect(scopedReport.healthScore).toBe(100)
        expect(scopedReport.grade).toBe("A")

        const cumulativeReport = yield* decideSessionReport({
          events,
          frictionEvents,
          cumulative: true
        })
        expect(cumulativeReport.totalEvents).toBe(7)
        expect(cumulativeReport.kpis.fixUpIterations).toBe(1)
        expect(cumulativeReport.kpis.frictionCount).toBe(1)
      })
  )

  it.effect(
    "decideSessionReport does not deduct health score or increment frictionCount for verdict=allow guard_escalation but counts other friction",
    () =>
      Effect.gen(function* () {
        const events: ReadonlyArray<TelemetryEvent> = [
          {
            timestamp: "2026-10-27T10:00:00.000Z",
            surface: "cli",
            category: "gate",
            toolName: "plan-check",
            outcome: "ok",
            durationMs: 100
          },
          {
            timestamp: "2026-10-27T10:01:00.000Z",
            surface: "cli",
            category: "gate",
            toolName: "verify",
            outcome: "ok",
            durationMs: 200
          },
          {
            timestamp: "2026-10-27T10:02:00.000Z",
            surface: "cli",
            category: "lifecycle",
            toolName: "done",
            outcome: "ok",
            durationMs: 50
          }
        ]

        const allowedEscalation: FrictionEvent = {
          kind: "guard_escalation",
          timestamp: "2026-10-27T10:00:30.000Z",
          summary: "safe read command",
          detail: "verdict=allow; reason=read-only check"
        }

        const reportAllowed = yield* decideSessionReport({
          events,
          frictionEvents: [allowedEscalation]
        })

        // verdict=allow guard_escalation must not increment frictionCount or deduct points
        expect(reportAllowed.kpis.frictionCount).toBe(0)
        expect(reportAllowed.healthScore).toBe(100)

        const deniedEscalation: FrictionEvent = {
          kind: "guard_escalation",
          timestamp: "2026-10-27T10:00:35.000Z",
          summary: "unsafe command",
          detail: "verdict=deny; reason=destructive operation"
        }
        const routeMiss: FrictionEvent = {
          kind: "route_miss",
          timestamp: "2026-10-27T10:00:40.000Z",
          summary: "route miss summary",
          detail: "route target missing"
        }
        const verifyFailure: FrictionEvent = {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:00:45.000Z",
          summary: "verify failed",
          detail: "test assertion failed"
        }

        const reportMixed = yield* decideSessionReport({
          events,
          frictionEvents: [
            allowedEscalation,
            deniedEscalation,
            routeMiss,
            verifyFailure
          ]
        })

        // Exactly the 3 non-allowed events count: deniedEscalation, routeMiss, verifyFailure
        expect(reportMixed.kpis.frictionCount).toBe(3)
        // 100 - (3 * 5) = 85
        expect(reportMixed.healthScore).toBe(85)
      })
  )

  it("scopeSessionReportInput ignores intermediate done events and scopes to active task after completed done", () => {
    // 1. Ignores intermediate done with detail: "fullyIdle=false"
    const intermediateFullyIdleEvents: ReadonlyArray<TelemetryEvent> = [
      {
        timestamp: "2026-10-27T09:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "plan-check",
        outcome: "ok",
        durationMs: 100
      },
      {
        timestamp: "2026-10-27T09:01:00.000Z",
        surface: "cli",
        category: "lifecycle",
        toolName: "done",
        outcome: "ok",
        detail: "fullyIdle=false",
        durationMs: 15
      },
      {
        timestamp: "2026-10-27T09:02:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 200
      }
    ]
    const scopedIdle = scopeSessionReportInput({ events: intermediateFullyIdleEvents })
    expect(scopedIdle.events.length).toBe(3)

    // 2. Ignores hook done without detail: "completed" (and not preceded by omnigraph:merge-main)
    const intermediateHookDoneEvents: ReadonlyArray<TelemetryEvent> = [
      {
        timestamp: "2026-10-27T09:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "plan-check",
        outcome: "ok",
        durationMs: 100
      },
      {
        timestamp: "2026-10-27T09:01:00.000Z",
        surface: "hook",
        category: "lifecycle",
        toolName: "done",
        outcome: "ok",
        detail: "in-progress",
        durationMs: 15
      },
      {
        timestamp: "2026-10-27T09:02:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 200
      }
    ]
    const scopedHook = scopeSessionReportInput({ events: intermediateHookDoneEvents })
    expect(scopedHook.events.length).toBe(3)

    // 3. Properly scopes to active task after completed done with detail: "completed"
    const completedWithDetailEvents: ReadonlyArray<TelemetryEvent> = [
      {
        timestamp: "2026-10-27T09:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 300
      },
      {
        timestamp: "2026-10-27T09:01:00.000Z",
        surface: "hook",
        category: "lifecycle",
        toolName: "done",
        outcome: "ok",
        detail: "completed",
        durationMs: 20
      },
      // Active task window
      {
        timestamp: "2026-10-27T10:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "plan-check",
        outcome: "ok",
        durationMs: 150
      },
      {
        timestamp: "2026-10-27T10:01:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 250
      }
    ]
    const frictionEvents: ReadonlyArray<FrictionEvent> = [
      {
        kind: "route_miss",
        timestamp: "2026-10-27T08:59:00.000Z",
        summary: "stale friction",
        detail: "from previous task"
      },
      {
        kind: "verify_failure",
        timestamp: "2026-10-27T10:00:30.000Z",
        summary: "active friction",
        detail: "in current task"
      }
    ]

    const scopedWithDetail = scopeSessionReportInput({
      events: completedWithDetailEvents,
      frictionEvents
    })
    expect(scopedWithDetail.events.length).toBe(2)
    expect(scopedWithDetail.events[0]?.toolName).toBe("plan-check")
    expect(scopedWithDetail.events[1]?.toolName).toBe("verify")
    expect(scopedWithDetail.frictionEvents.length).toBe(1)
    expect(scopedWithDetail.frictionEvents[0]?.summary).toBe("active friction")

    // 4. Properly scopes to active task after done preceded by omnigraph:merge-main
    const completedPrecededByMergeEvents: ReadonlyArray<TelemetryEvent> = [
      {
        timestamp: "2026-10-27T09:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 300
      },
      {
        timestamp: "2026-10-27T09:01:00.000Z",
        surface: "cli",
        category: "lifecycle",
        toolName: "omnigraph:merge-main",
        outcome: "ok",
        durationMs: 100
      },
      {
        timestamp: "2026-10-27T09:02:00.000Z",
        surface: "hook",
        category: "lifecycle",
        toolName: "done",
        outcome: "ok",
        durationMs: 20
      },
      // Active task window
      {
        timestamp: "2026-10-27T10:00:00.000Z",
        surface: "cli",
        category: "gate",
        toolName: "verify",
        outcome: "ok",
        durationMs: 250
      }
    ]

    const scopedPreceded = scopeSessionReportInput({
      events: completedPrecededByMergeEvents,
      frictionEvents
    })
    expect(scopedPreceded.events.length).toBe(1)
    expect(scopedPreceded.events[0]?.toolName).toBe("verify")
    expect(scopedPreceded.frictionEvents.length).toBe(1)
    expect(scopedPreceded.frictionEvents[0]?.summary).toBe("active friction")
  })
})
