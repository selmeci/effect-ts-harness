import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { decideSessionReport, type TelemetryEvent } from "../src/index.js"
import { GUARD_TIMEOUT_NEAR_BUDGET_MS } from "../src/telemetry-recommendations.js"

const GC_ONTOLOGY_REC =
  "Run 'harness gc --strict' and 'harness ontology check --strict' before 'harness verify' to reduce fix-up iterations."
const GUARD_TIMEOUT_REC =
  "Guard escalated to DecisionModel and timed out; allowlist safe command patterns or check local Ollama (clef-flash) latency."
const DEGRADED_MCP_REC =
  "Degraded MCP responses detected (corrupt/missing graph snapshot or stale workspace); refresh snapshot via 'pnpm harness gc --strict' or reload MCP server."

const makeEvent = (
  overrides: Partial<TelemetryEvent> & Pick<TelemetryEvent, "toolName" | "outcome">,
): TelemetryEvent => ({
  timestamp: "2026-11-24T10:00:00.000Z",
  surface: "cli",
  category: "gate",
  durationMs: 50,
  ...overrides,
})

const DomainVocabularyEvent = Schema.Struct({
  timestamp: Schema.Literals(["2026-11-24T10:00:00.000Z"]),
  surface: Schema.Literals(["cli", "mcp", "hook"]),
  category: Schema.Literals(["gate", "graph_query", "ontology", "guard", "routing", "lifecycle"]),
  toolName: Schema.Literals([
    "gc",
    "ontology:check",
    "harness_ontology_check",
    "verify",
    "harness_resolve",
    "ingest",
    "mutate",
    "guard",
  ]),
  outcome: Schema.Literals(["ok", "fail", "fallback", "ask", "deny"]),
  durationMs: Schema.Literals([
    20,
    100,
    GUARD_TIMEOUT_NEAR_BUDGET_MS - 1,
    GUARD_TIMEOUT_NEAR_BUDGET_MS,
    GUARD_TIMEOUT_NEAR_BUDGET_MS + 150,
  ]),
  detail: Schema.optional(
    Schema.Literals([
      "timeout-contention",
      "Test timed out in 5000ms.",
      "degraded=missing-snapshot",
      "fastpath=hit",
      "DecisionModel timed out after 2500ms",
      "normal",
    ]),
  ),
})

describe("telemetry Wave 1 (SPEC-0033 REQ-1.4, REQ-1.5, REQ-1.9)", () => {
  it.effect(
    "stateful gc/ontology freshness kills telemetry.ts:348 mutants across fail, ontology:check, harness_ontology_check, ingest, mutate, and stale second verify",
    () =>
      Effect.gen(function* () {
        // 1. [gc(ok), verify(fail)] -> missing ontology check -> recommendation emitted
        const gcOnly = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(gcOnly.recommendations).toContain(GC_ONTOLOGY_REC)

        // 2. [gc(ok), ontology:check(fail), verify(fail)] -> failing ontology:check -> recommendation emitted
        const ontFail = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "ontology:check", category: "ontology", outcome: "fail" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(ontFail.recommendations).toContain(GC_ONTOLOGY_REC)

        // 3. [gc(ok), ontology:check(ok), verify(fail)] -> both ok -> suppressed
        const ontCliOk = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "ontology:check", category: "ontology", outcome: "ok" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(ontCliOk.recommendations).not.toContain(GC_ONTOLOGY_REC)

        // 4. [gc(ok), harness_ontology_check(ok), verify(fail)] -> both ok -> suppressed
        const ontMcpOk = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({
              toolName: "harness_ontology_check",
              surface: "mcp",
              category: "ontology",
              outcome: "ok",
            }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(ontMcpOk.recommendations).not.toContain(GC_ONTOLOGY_REC)

        // 5. [gc(ok), ontology:check(ok), verify(fail), verify(fail)] -> stale after first verify(fail) -> emitted
        const staleSecondVerify = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "ontology:check", category: "ontology", outcome: "ok" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(staleSecondVerify.recommendations).toContain(GC_ONTOLOGY_REC)

        // 6. ingest or mutate invalidates prior gc/ontology freshness
        const invalidatedByIngest = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "ontology:check", category: "ontology", outcome: "ok" }),
            makeEvent({ toolName: "ingest", outcome: "ok" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(invalidatedByIngest.recommendations).toContain(GC_ONTOLOGY_REC)

        const invalidatedByMutate = yield* decideSessionReport({
          events: [
            makeEvent({ toolName: "gc", outcome: "ok" }),
            makeEvent({ toolName: "harness_ontology_check", category: "ontology", outcome: "ok" }),
            makeEvent({ toolName: "mutate", outcome: "ok" }),
            makeEvent({ toolName: "verify", outcome: "fail" }),
          ],
        })
        expect(invalidatedByMutate.recommendations).toContain(GC_ONTOLOGY_REC)
      }),
  )

  it.effect(
    "detects GuardV1 timeouts at GUARD_TIMEOUT_NEAR_BUDGET_MS boundary while excluding non-timeout ask reasons, plus verifyTimeoutFailures and degraded MCP calls",
    () =>
      Effect.gen(function* () {
        const belowThreshold = yield* decideSessionReport({
          events: [
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS - 1,
              detail: "normal-escalation",
            }),
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS + 150,
              detail: "fastpath=hit; requires human confirmation",
            }),
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS + 150,
              detail: "Ambiguous risk",
            }),
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS + 150,
              detail: "DecisionModel unavailable",
            }),
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS + 150,
              detail: "Worker isolation mode",
            }),
          ],
        })
        expect(belowThreshold.healthScore).toBe(100)
        expect(belowThreshold.recommendations).not.toContain(GUARD_TIMEOUT_REC)

        const atBoundaryAndExplicit = yield* decideSessionReport({
          events: [
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ask",
              durationMs: GUARD_TIMEOUT_NEAR_BUDGET_MS,
              detail: "boundary-ask-timeout",
            }),
            makeEvent({
              toolName: "guard",
              surface: "hook",
              category: "guard",
              outcome: "ok",
              durationMs: 200,
              detail: "DecisionModel timed out after 2500ms; falling back",
            }),
          ],
        })
        // 2 guardTimeouts -> -10
        expect(atBoundaryAndExplicit.healthScore).toBe(90)
        expect(atBoundaryAndExplicit.recommendations).toContain(GUARD_TIMEOUT_REC)

        // verifyTimeoutFailures
        const verifyContention = yield* decideSessionReport({
          events: [
            makeEvent({
              toolName: "verify",
              outcome: "fail",
              durationMs: 5000,
              detail: "timeout-contention in test suite",
            }),
            makeEvent({
              toolName: "verify",
              outcome: "fail",
              durationMs: 5000,
              detail: "Test timed out in 5000ms",
            }),
          ],
        })
        expect(
          verifyContention.recommendations.some((r) => r.includes("HARNESS_VERIFY_PARALLEL")),
        ).toBe(true)

        const verifyOkContention = yield* decideSessionReport({
          events: [
            makeEvent({
              toolName: "verify",
              outcome: "ok",
              durationMs: 100,
              detail: "timeout-contention",
            }),
          ],
        })
        expect(
          verifyOkContention.recommendations.some((r) => r.includes("HARNESS_VERIFY_PARALLEL")),
        ).toBe(false)

        // Degraded MCP
        const degraded = yield* decideSessionReport({
          events: [
            makeEvent({
              toolName: "harness_resolve",
              surface: "mcp",
              category: "graph_query",
              outcome: "fallback",
              detail: "degraded=missing-snapshot",
            }),
          ],
        })
        expect(degraded.healthScore).toBe(95)
        expect(degraded.recommendations).toContain(DEGRADED_MCP_REC)
      }),
  )

  it.effect.prop(
    "REQ-1.5 property: constrained domain-vocabulary telemetry satisfies stateful gc/ontology freshness, verify contention, and degraded MCP invariants",
    {
      events: Schema.Array(DomainVocabularyEvent),
    },
    ({ events }) =>
      Effect.gen(function* () {
        const report = yield* decideSessionReport({ events, cumulative: true })
        expect(report.healthScore).toBeGreaterThanOrEqual(0)
        expect(report.healthScore).toBeLessThanOrEqual(100)

        const hasDegradedMcp = events.some(
          (e) =>
            e.surface === "mcp" &&
            e.outcome === "fallback" &&
            (e.detail?.startsWith("degraded=") ?? false),
        )
        expect(report.recommendations.includes(DEGRADED_MCP_REC)).toBe(hasDegradedMcp)

        const hasVerifyTimeoutFailure = events.some(
          (e) =>
            e.toolName === "verify" &&
            e.outcome === "fail" &&
            ((e.detail?.includes("timeout-contention") ?? false) ||
              /Test timed out in \d+\s*ms/i.test(e.detail ?? "")),
        )
        expect(report.recommendations.some((r) => r.includes("HARNESS_VERIFY_PARALLEL"))).toBe(
          hasVerifyTimeoutFailure,
        )

        let gcOk = false
        let ontOk = false
        let allPreceded = true
        let hasVerify = false
        for (const e of events) {
          if (e.toolName === "gc") {
            gcOk = e.outcome === "ok"
          } else if (e.toolName === "ontology:check" || e.toolName === "harness_ontology_check") {
            ontOk = e.outcome === "ok"
          } else if (e.toolName === "ingest" || e.toolName === "mutate") {
            gcOk = false
            ontOk = false
          } else if (e.toolName === "verify") {
            hasVerify = true
            if (!gcOk || !ontOk) allPreceded = false
            if (e.outcome === "fail") {
              gcOk = false
              ontOk = false
            }
          }
        }
        const allVerifyFresh = hasVerify && allPreceded
        expect(report.recommendations.includes(GC_ONTOLOGY_REC)).toBe(
          report.kpis.fixUpIterations > 0 && !allVerifyFresh,
        )
      }),
  )
})
