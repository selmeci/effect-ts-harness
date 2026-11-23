import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  buildSessionHandoff,
  decideLoopThrashing,
  decideSessionHandoff,
  decideSpanBudgets,
  type FrictionCluster,
  type SpanSample,
} from "../src/index.js"

const FrictionClusterArb = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["route_miss", "verify_failure", "guard_escalation"]),
  summary: Schema.String,
  detail: Schema.String,
  occurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  lastSeen: Schema.String,
})

describe("Harness Gates: Session Handoff & Span Budget", () => {
  describe("decideSessionHandoff / buildSessionHandoff", () => {
    it("returns handoffMessage: null when clean with no active tasks", () => {
      const summary = buildSessionHandoff({
        stampValid: true,
        activeStubs: [],
        missingPlannedFns: [],
        frictionClusters: [],
      })

      expect(summary.hasActiveTask).toBe(false)
      expect(summary.stampValid).toBe(true)
      expect(summary.recentFrictionCount).toBe(0)
      expect(summary.topFrictionSummary).toHaveLength(0)
      expect(summary.handoffMessage).toBeNull()
    })

    it.effect("builds a structured handoff message when tasks or friction exist", () =>
      Effect.gen(function* () {
        const clusters: ReadonlyArray<FrictionCluster> = [
          {
            key: "verify_failure::typecheck",
            kind: "verify_failure",
            summary: "tsc error in domain",
            detail: "detail 1",
            occurrences: 3,
            lastSeen: "2026-10-26T12:00:00.000Z",
          },
          {
            key: "route_miss::d1",
            kind: "route_miss",
            summary: "missing d1 route",
            detail: "detail 2",
            occurrences: 2,
            lastSeen: "2026-10-26T12:05:00.000Z",
          },
        ]

        const summary = yield* decideSessionHandoff({
          stampValid: false,
          stampReason: "Workspace files modified",
          activeStubs: ["libs/sample/domain/src/index.ts#greet"],
          missingPlannedFns: ["libs/sample/domain/src/index.ts#cancel"],
          frictionClusters: clusters,
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.recentFrictionCount).toBe(5)
        expect(summary.topFrictionSummary).toEqual([
          "[verify_failure x3] tsc error in domain",
          "[route_miss x2] missing d1 route",
        ])

        expect(summary.handoffMessage).not.toBeNull()
        const msg = summary.handoffMessage!
        expect(msg).toContain("[Harness Context Handoff]")
        expect(msg).toContain(
          "Active stub() skeletons remaining: libs/sample/domain/src/index.ts#greet",
        )
        expect(msg).toContain(
          "Missing planned functions from plan-graph-snapshot: libs/sample/domain/src/index.ts#cancel",
        )
        expect(msg).toContain("Verify stamp status: INVALID (Workspace files modified)")
        expect(msg).toContain(
          "Recent friction events: [verify_failure x3] tsc error in domain; [route_miss x2] missing d1 route",
        )
      }),
    )

    it.effect("surfaces stuck loop escalation and marks hasActiveTask when loop is thrashing", () =>
      Effect.gen(function* () {
        const thrashing = yield* decideLoopThrashing([
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "tsc error",
            detail: "error detail 1",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "tsc error",
            detail: "error detail 2",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: "tsc error",
            detail: "error detail 3",
          },
        ])

        const summary = yield* decideSessionHandoff({
          stampValid: true,
          activeStubs: [],
          missingPlannedFns: [],
          frictionClusters: [],
          loopThrashing: thrashing,
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.stuckLoopEscalation).not.toBeNull()
        expect(summary.stuckLoopEscalation).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(summary.handoffMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
      }),
    )

    it("compacts multi-line >120 char friction summaries and caps rendered stub/missing lists at 8 entries", () => {
      const exact120 = "x".repeat(120)
      const multiLine121 = `line one\n  line two\t${"y".repeat(120)}`
      const summary = buildSessionHandoff({
        stampValid: true,
        activeStubs: Array.from({ length: 8 }, (_, i) => `stub-${i}`),
        missingPlannedFns: Array.from({ length: 10 }, (_, i) => `fn-${i}`),
        frictionClusters: [
          {
            key: "verify_failure::exact120",
            kind: "verify_failure",
            summary: `  ${exact120}  `,
            detail: "d1",
            occurrences: 1,
            lastSeen: "2026-11-20T12:00:00.000Z",
          },
          {
            key: "route_miss::long",
            kind: "route_miss",
            summary: multiLine121,
            detail: "d2",
            occurrences: 2,
            lastSeen: "2026-11-20T12:01:00.000Z",
          },
        ],
      })

      expect(summary.topFrictionSummary[0]).toBe(`[verify_failure x1] ${exact120}`)
      expect(summary.topFrictionSummary[1]).toHaveLength(`[route_miss x2] `.length + 120)
      expect(summary.topFrictionSummary[1]?.endsWith("...")).toBe(true)
      expect(summary.topFrictionSummary[1]).toContain("line one line two ")

      expect(summary.handoffMessage).toContain(
        "Active stub() skeletons remaining: stub-0, stub-1, stub-2, stub-3, stub-4, stub-5, stub-6, stub-7",
      )
      expect(summary.handoffMessage).not.toContain("(+0 more)")
      expect(summary.handoffMessage).toContain(
        "Missing planned functions from plan-graph-snapshot: fn-0, fn-1, fn-2, fn-3, fn-4, fn-5, fn-6, fn-7 (+2 more)",
      )
    })

    it.effect.prop(
      "SessionHandoff.decide: total friction count, top-3 summary compaction, and active handoff invariants hold across arbitrary cluster inputs",
      [
        Schema.Boolean,
        Schema.Array(Schema.String),
        Schema.Array(Schema.String),
        Schema.Array(FrictionClusterArb),
      ],
      ([stampValid, activeStubs, missingPlannedFns, frictionClusters]) =>
        Effect.gen(function* () {
          const summary = yield* decideSessionHandoff({
            stampValid,
            activeStubs,
            missingPlannedFns,
            frictionClusters,
          })

          const expectedFrictionCount = frictionClusters.reduce((acc, c) => acc + c.occurrences, 0)
          const expectedActive =
            !stampValid ||
            activeStubs.length > 0 ||
            missingPlannedFns.length > 0 ||
            frictionClusters.length > 0

          expect(summary.recentFrictionCount).toBe(expectedFrictionCount)
          expect(summary.topFrictionSummary).toHaveLength(Math.min(frictionClusters.length, 3))
          expect(summary.hasActiveTask).toBe(expectedActive)
          expect(summary.handoffMessage !== null).toBe(expectedActive)
          for (const entry of summary.topFrictionSummary) {
            expect(entry.startsWith("[")).toBe(true)
            const splitIdx = entry.indexOf("] ")
            expect(splitIdx).toBeGreaterThan(1)
            expect(entry.slice(splitIdx + 2).length).toBeLessThanOrEqual(120)
          }
        }),
    )
  })

  describe("decideSpanBudgets", () => {
    it.effect("detects n-plus-one-call violations when child span count exceeds budget", () =>
      Effect.gen(function* () {
        const parent: SpanSample = {
          spanId: "parent-1",
          name: "Order.checkout",
          parentSpanId: null,
        }
        const children: Array<SpanSample> = Array.from({ length: 6 }, (_, i) => ({
          spanId: `child-${i}`,
          name: "Db.query",
          parentSpanId: "parent-1",
        }))

        const violations = yield* decideSpanBudgets({
          spans: [parent, ...children],
          maxRepeatedChildCalls: 5,
        })

        expect(violations).toHaveLength(1)
        const v = violations[0]!
        expect(v.kind).toBe("n-plus-one-call")
        expect(v.parentSpan).toBe("Order.checkout")
        expect(v.targetSpan).toBe("Db.query")
        expect(v.count).toBe(6)
        expect(v.maxAllowed).toBe(5)
        expect(v.message).toContain("N+1 span repetition detected")
      }),
    )

    it.effect("detects span-duration-exceeded violations", () =>
      Effect.gen(function* () {
        const spans: ReadonlyArray<SpanSample> = [
          {
            spanId: "s1",
            name: "SlowOperation",
            parentSpanId: null,
            durationMs: 250.7,
          },
          {
            spanId: "s2",
            name: "FastOperation",
            parentSpanId: null,
            durationMs: 45.2,
          },
        ]

        const violations = yield* decideSpanBudgets({
          spans,
          maxSpanDurationMs: 100,
        })

        expect(violations).toHaveLength(1)
        const v = violations[0]!
        expect(v.kind).toBe("span-duration-exceeded")
        expect(v.parentSpan).toBe("root")
        expect(v.targetSpan).toBe("SlowOperation")
        expect(v.count).toBe(251)
        expect(v.maxAllowed).toBe(100)
        expect(v.message).toContain("Span duration budget exceeded")
      }),
    )
  })
})
