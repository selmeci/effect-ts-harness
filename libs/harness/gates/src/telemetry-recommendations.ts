import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import type { FrictionEvent } from "./friction-log.js"

export interface ToolDurationMetricInput {
  readonly toolName: string
  readonly maxDurationMs: number
  readonly p95DurationMs: number
}

export interface GuardTelemetryEventInput {
  readonly category: string
  readonly outcome: string
  readonly durationMs: number
  readonly detail?: string | undefined
}

const HANG_OUTLIER_MIN_MS = 30_000
const HANG_OUTLIER_P95_MULTIPLIER = 5

/**
 * Flags tools whose maximum duration exceeds both `30_000 ms` and `5 * p95DurationMs`
 * (`SPEC-0037 REQ-5.2`).
 */
export const detectHangOutlierRecommendations = (
  toolMetrics: ReadonlyArray<ToolDurationMetricInput>,
): ReadonlyArray<string> => {
  const recommendations: Array<string> = []
  for (const metric of toolMetrics) {
    if (
      metric.maxDurationMs > HANG_OUTLIER_MIN_MS &&
      metric.maxDurationMs > HANG_OUTLIER_P95_MULTIPLIER * metric.p95DurationMs
    ) {
      recommendations.push(
        `Hang outlier detected on '${metric.toolName}' (maxDurationMs=${metric.maxDurationMs} ms vs p95=${metric.p95DurationMs} ms); check watchdog timeouts and unbounded subprocesses.`,
      )
    }
  }
  return recommendations
}

const LEADING_ENV_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/
const DETAIL_CMD_RE = /(?:^|;\s*)(?:cmd|command)=([^;\r\n]+)/i

const normalizeTwoTokenPrefix = (rawCommand: string): string | undefined => {
  const stripped = rawCommand.trim().replace(LEADING_ENV_ASSIGN_RE, "").trim()
  if (stripped.length === 0) return undefined
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return undefined
  return tokens.slice(0, 2).join(" ")
}

const isGuardTimeoutOrAmbiguousEvent = (e: GuardTelemetryEventInput): boolean =>
  e.category === "guard" &&
  (e.outcome === "timeout" ||
    /timed out|timeout|ambiguous/i.test(e.detail ?? "") ||
    (e.outcome === "ask" &&
      e.durationMs >= 2450 &&
      !/fastpath=hit|DecisionModel unavailable|Worker isolation mode|requires human confirmation/i.test(
        e.detail ?? "",
      )))

/**
 * Groups `guard` timeout/ambiguous escalation events and `guard_escalation` friction events
 * by normalized 2-token command prefix, returning top recurring prefixes (`SPEC-0037 REQ-5.3`).
 */
export const collectTopGuardCommandPrefixes = (
  events: ReadonlyArray<GuardTelemetryEventInput>,
  frictionEvents: ReadonlyArray<FrictionEvent>,
  limit = 5,
): ReadonlyArray<{ readonly prefix: string; readonly count: number }> => {
  const counts = new Map<string, number>()
  const addPrefix = (rawCmd: string | undefined) => {
    if (rawCmd === undefined) return
    const prefix = normalizeTwoTokenPrefix(rawCmd)
    if (prefix === undefined) return
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }

  for (const e of events) {
    if (!isGuardTimeoutOrAmbiguousEvent(e)) continue
    const detail = e.detail ?? ""
    const m = DETAIL_CMD_RE.exec(detail)
    if (m?.[1] !== undefined) {
      addPrefix(m[1])
    }
  }

  for (const f of frictionEvents) {
    match(f.kind)
      .with("guard_escalation", () => {
        if (!f.detail.startsWith("verdict=allow")) {
          addPrefix(f.summary)
        }
      })
      .with("route_miss", "verify_failure", () => undefined)
      .exhaustive()
  }

  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : compareCodeUnits(a.prefix, b.prefix),
    )
    .slice(0, limit)
}
