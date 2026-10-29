import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import type { FrictionEvent } from "./friction-log.js"
import { resolveHarnessStateDir } from "./worktree.js"

export const TelemetrySurface = Schema.Literals(["cli", "mcp", "hook"])
export type TelemetrySurface = typeof TelemetrySurface.Type

export const TelemetryCategory = Schema.Literals([
  "gate",
  "graph_query",
  "ontology",
  "guard",
  "routing",
  "lifecycle"
])
export type TelemetryCategory = typeof TelemetryCategory.Type

export const TelemetryOutcome = Schema.Literals([
  "ok",
  "fail",
  "deny",
  "ask",
  "fallback"
])
export type TelemetryOutcome = typeof TelemetryOutcome.Type

export const TelemetryEngineSource = Schema.Literals([
  "omnigraph",
  "memory-fallback",
  "local",
  "decision-model"
])
export type TelemetryEngineSource = typeof TelemetryEngineSource.Type

export const TelemetryEvent = Schema.Struct({
  timestamp: Schema.String,
  surface: TelemetrySurface,
  category: TelemetryCategory,
  toolName: Schema.String,
  outcome: TelemetryOutcome,
  durationMs: Schema.Finite,
  engineSource: Schema.optional(TelemetryEngineSource),
  detail: Schema.optional(Schema.String)
})
export type TelemetryEvent = typeof TelemetryEvent.Type

export interface ToolUsageMetric {
  readonly toolName: string
  readonly surface: TelemetrySurface
  readonly category: TelemetryCategory
  readonly calls: number
  readonly successCount: number
  readonly failCount: number
  readonly denyOrAskCount: number
  readonly fallbackCount: number
  readonly successRate: number
  readonly meanDurationMs: number
  readonly p50DurationMs: number
  readonly p95DurationMs: number
  readonly maxDurationMs: number
}

export interface SessionKpis {
  readonly firstPassVerify: boolean | null
  readonly verifyAttempts: number
  readonly fixUpIterations: number
  readonly planBeforeVerify: boolean
  readonly prematureDoneAttempts: number
  readonly graphDiscoveryCalls: number
  readonly graphDiscoveryRatio: number
  readonly omnigraphLiveRatio: number | null
  readonly guardInterventions: number
  readonly frictionCount: number
}

export type HealthGrade = "A" | "B" | "C" | "D"

export interface SessionReportInput {
  readonly events: ReadonlyArray<TelemetryEvent>
  readonly frictionEvents?: ReadonlyArray<FrictionEvent> | undefined
  readonly stampValid?: boolean | undefined
  readonly cumulative?: boolean | undefined
}

const TASK_WORK_TOOLS = new Set([
  "plan-check",
  "ingest",
  "verify",
  "gc",
  "mutate"
])

export const scopeSessionReportInput = (
  input: SessionReportInput
): {
  readonly events: ReadonlyArray<TelemetryEvent>
  readonly frictionEvents: ReadonlyArray<FrictionEvent>
} => {
  const allEvents = input.events
  const allFriction = input.frictionEvents ?? []
  if (input.cumulative === true || allEvents.length === 0) {
    return { events: allEvents, frictionEvents: allFriction }
  }

  let boundaryIdx = -1
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const ev = allEvents[i]!
    const isCompletedDone =
      ev.toolName === "done" &&
      ev.outcome === "ok" &&
      ev.detail !== "fullyIdle=false" &&
      (ev.surface === "cli" ||
        ev.detail === "completed" ||
        allEvents[i - 1]?.toolName === "omnigraph:merge-main")
    if (isCompletedDone) {
      const hasSubsequentTaskWork = allEvents
        .slice(i + 1)
        .some((later) => TASK_WORK_TOOLS.has(later.toolName))
      if (hasSubsequentTaskWork) {
        boundaryIdx = i
        break
      }
    }
  }

  if (boundaryIdx === -1) {
    return { events: allEvents, frictionEvents: allFriction }
  }

  const scopedEvents = allEvents.slice(boundaryIdx + 1)
  const windowStartTimestamp = scopedEvents[0]?.timestamp
  const scopedFriction =
    windowStartTimestamp === undefined
      ? allFriction
      : allFriction.filter((f) => f.timestamp >= windowStartTimestamp)

  return {
    events: scopedEvents,
    frictionEvents: scopedFriction
  }
}

export interface SessionReport {
  readonly totalEvents: number
  readonly totalDurationMs: number
  readonly healthScore: number
  readonly grade: HealthGrade
  readonly bySurface: Readonly<Record<TelemetrySurface, number>>
  readonly byCategory: Readonly<Record<TelemetryCategory, number>>
  readonly kpis: SessionKpis
  readonly toolMetrics: ReadonlyArray<ToolUsageMetric>
  readonly recommendations: ReadonlyArray<string>
}

export const decideSessionReport = Effect.fn("SessionReport.decide")(function* (
  rawInput: SessionReportInput
) {
  yield* Effect.void

  const scoped = scopeSessionReportInput(rawInput)
  const input: SessionReportInput = {
    ...rawInput,
    events: scoped.events,
    frictionEvents: scoped.frictionEvents
  }

  const bySurface: Record<TelemetrySurface, number> = {
    cli: 0,
    mcp: 0,
    hook: 0
  }

  const byCategory: Record<TelemetryCategory, number> = {
    gate: 0,
    graph_query: 0,
    ontology: 0,
    guard: 0,
    routing: 0,
    lifecycle: 0
  }

  let totalDurationMsSum = 0
  for (const event of input.events) {
    bySurface[event.surface] = (bySurface[event.surface] ?? 0) + 1
    byCategory[event.category] = (byCategory[event.category] ?? 0) + 1
    totalDurationMsSum += event.durationMs
  }
  const totalDurationMs = Math.round(totalDurationMsSum * 100) / 100

  const groups = new Map<string, Array<TelemetryEvent>>()
  for (const event of input.events) {
    const key = `${event.surface}::${event.toolName}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, [event])
    } else {
      existing.push(event)
    }
  }

  const toolMetrics: Array<ToolUsageMetric> = []
  for (const [, groupEvents] of groups) {
    const first = groupEvents[0]!
    const calls = groupEvents.length
    let successCount = 0
    let failCount = 0
    let denyOrAskCount = 0
    let fallbackCount = 0
    let durationSum = 0
    const durations: Array<number> = []

    for (const e of groupEvents) {
      if (e.outcome === "ok") {
        successCount += 1
      } else if (e.outcome === "fail") {
        failCount += 1
      } else if (e.outcome === "deny" || e.outcome === "ask") {
        denyOrAskCount += 1
      } else if (e.outcome === "fallback") {
        fallbackCount += 1
      }
      durations.push(e.durationMs)
      durationSum += e.durationMs
    }

    durations.sort((a, b) => a - b)
    const successRate = calls === 0 ? 0 : Number((successCount / calls).toFixed(2))
    const meanDurationMs = calls === 0 ? 0 : Number((durationSum / calls).toFixed(2))

    const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
      if (sorted.length === 0) return 0
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
      )
      return sorted[idx] ?? 0
    }

    const p50DurationMs = percentile(durations, 50)
    const p95DurationMs = percentile(durations, 95)
    const maxDurationMs = durations.length === 0 ? 0 : (durations[durations.length - 1] ?? 0)

    toolMetrics.push({
      toolName: first.toolName,
      surface: first.surface,
      category: first.category,
      calls,
      successCount,
      failCount,
      denyOrAskCount,
      fallbackCount,
      successRate,
      meanDurationMs,
      p50DurationMs,
      p95DurationMs,
      maxDurationMs
    })
  }

  toolMetrics.sort((a, b) => {
    if (b.calls !== a.calls) {
      return b.calls - a.calls
    }
    return a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0
  })

  const verifyEvents = input.events.filter((e) => e.toolName === "verify")
  const verifyAttempts = verifyEvents.length
  const fixUpIterations = verifyEvents.filter((e) => e.outcome === "fail").length
  const firstPassVerify =
    verifyEvents.length === 0 ? null : (verifyEvents[0]?.outcome === "ok")

  const firstVerifyIdx = input.events.findIndex((e) => e.toolName === "verify")
  let planBeforeVerify = true
  if (firstVerifyIdx !== -1) {
    planBeforeVerify = input.events
      .slice(0, firstVerifyIdx)
      .some(
        (e) =>
          e.toolName === "plan-check" ||
          e.toolName === "route" ||
          e.toolName === "harness_route" ||
          e.category === "ontology" ||
          e.category === "graph_query"
      )
  }

  const prematureDoneAttempts = input.events.filter(
    (e) =>
      e.toolName === "done" &&
      e.surface !== "hook" &&
      (e.outcome === "fail" || e.outcome === "deny")
  ).length

  const graphDiscoveryCalls = input.events.filter(
    (e) => e.category === "graph_query" || e.category === "ontology"
  ).length

  const nonHookCalls = input.events.filter((e) => e.surface !== "hook").length
  const graphDiscoveryRatio =
    nonHookCalls === 0 ? 0 : Number((graphDiscoveryCalls / nonHookCalls).toFixed(2))

  const omnigraphCalls = input.events.filter((e) => e.engineSource === "omnigraph").length
  const fallbackCalls = input.events.filter(
    (e) => e.engineSource === "memory-fallback" || e.outcome === "fallback"
  ).length
  const omnigraphLiveRatio =
    omnigraphCalls + fallbackCalls === 0
      ? null
      : Number((omnigraphCalls / (omnigraphCalls + fallbackCalls)).toFixed(2))

  const guardInterventions = input.events.filter(
    (e) => e.category === "guard" && (e.outcome === "deny" || e.outcome === "ask")
  ).length

  const isActionableFriction = (f: FrictionEvent): boolean =>
    !(f.kind === "guard_escalation" && f.detail.startsWith("verdict=allow"))
  const actionableFriction = (input.frictionEvents ?? []).filter(isActionableFriction)
  const frictionCount = actionableFriction.length

  let healthScore = 100
  healthScore -= Math.min(45, fixUpIterations * 15)
  if (!planBeforeVerify && verifyAttempts > 0) {
    healthScore -= 15
  }
  healthScore -= Math.min(20, prematureDoneAttempts * 10)
  healthScore -= Math.min(20, frictionCount * 5)
  if (graphDiscoveryCalls > 0 && firstPassVerify === true) {
    healthScore += 5
  }
  healthScore = Math.max(0, Math.min(100, healthScore))

  const grade: HealthGrade =
    healthScore >= 90 ? "A" : healthScore >= 75 ? "B" : healthScore >= 60 ? "C" : "D"

  const recommendations: Array<string> = []
  if (fixUpIterations > 0) {
    recommendations.push(
      "Run 'harness gc --strict' and 'harness ontology check --strict' before 'harness verify' to reduce fix-up iterations."
    )
  }
  if (!planBeforeVerify && verifyAttempts > 0) {
    recommendations.push(
      "Execute planning/discovery tools ('harness route', 'harness ontology check', or 'harness plan-check') before running 'harness verify'."
    )
  }
  if (graphDiscoveryCalls === 0 && nonHookCalls >= 3) {
    recommendations.push(
      "Use semantic MCP graph & ontology tools ('harness_resolve', 'harness_callers', 'harness_ontology_why', 'harness_gq_query') to inspect topology before editing."
    )
  }
  if (omnigraphLiveRatio !== null && omnigraphLiveRatio < 1) {
    recommendations.push(
      "Queries used deterministic in-memory fallback ('memory-fallback'). Start Omnigraph server if persistent branch queries are needed."
    )
  }
  if (prematureDoneAttempts > 0) {
    recommendations.push(
      "Avoid invoking 'harness done' before 'harness verify' produces a valid verify-stamp.json."
    )
  }

  const report: SessionReport = {
    totalEvents: input.events.length,
    totalDurationMs,
    healthScore,
    grade,
    bySurface,
    byCategory,
    kpis: {
      firstPassVerify,
      verifyAttempts,
      fixUpIterations,
      planBeforeVerify,
      prematureDoneAttempts,
      graphDiscoveryCalls,
      graphDiscoveryRatio,
      omnigraphLiveRatio,
      guardInterventions,
      frictionCount
    },
    toolMetrics,
    recommendations
  }

  return report
})

export const buildSessionReport = (input: SessionReportInput): SessionReport =>
  Effect.runSync(decideSessionReport(input))

export const renderSessionReportMarkdown = (report: SessionReport): string => {
  const lines: Array<string> = []
  lines.push("# Harness Session Observability Report")
  lines.push("")
  lines.push(`**Health Score:** ${report.healthScore}/100 (Grade: ${report.grade})`)
  lines.push(
    `**Total Events:** ${report.totalEvents} | **Total Duration:** ${report.totalDurationMs} ms`
  )
  lines.push("")
  lines.push("## Key Performance Indicators (KPIs)")
  lines.push("")
  lines.push("| KPI | Value | Description |")
  lines.push("|---|---|---|")
  lines.push(
    `| First-Pass Verification | ${report.kpis.firstPassVerify === null ? "N/A" : report.kpis.firstPassVerify ? "Passed" : "Failed"} | Green on first attempt |`
  )
  lines.push(`| Verify Attempts | ${report.kpis.verifyAttempts} | Total verify runs |`)
  lines.push(`| Fix-Up Iterations | ${report.kpis.fixUpIterations} | Verify runs with failures |`)
  lines.push(
    `| Plan Before Verify | ${report.kpis.planBeforeVerify ? "Yes" : "No"} | Route/plan-check/graph queried first |`
  )
  lines.push(
    `| Premature Done Attempts | ${report.kpis.prematureDoneAttempts} | Done invoked without valid stamp |`
  )
  lines.push(`| Graph Discovery Calls | ${report.kpis.graphDiscoveryCalls} | Ontology & graph queries |`)
  lines.push(`| Graph Discovery Ratio | ${report.kpis.graphDiscoveryRatio} | Discovery / non-hook calls |`)
  lines.push(
    `| Omnigraph Live Ratio | ${report.kpis.omnigraphLiveRatio === null ? "N/A" : report.kpis.omnigraphLiveRatio} | Omnigraph vs fallback queries |`
  )
  lines.push(`| Guard Interventions | ${report.kpis.guardInterventions} | Denied or asked actions |`)
  lines.push(`| Friction Count | ${report.kpis.frictionCount} | Logged friction events |`)
  lines.push("")
  lines.push("## Tool Usage & Latency")
  lines.push("")
  if (report.toolMetrics.length === 0) {
    lines.push("*No tools recorded.*")
  } else {
    lines.push(
      "| Tool | Surface | Category | Calls | Success | Fail | Deny/Ask | Fallback | Success Rate | Mean (ms) | p50 (ms) | p95 (ms) | Max (ms) |"
    )
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (const m of report.toolMetrics) {
      lines.push(
        `| ${m.toolName} | ${m.surface} | ${m.category} | ${m.calls} | ${m.successCount} | ${m.failCount} | ${m.denyOrAskCount} | ${m.fallbackCount} | ${m.successRate} | ${m.meanDurationMs} | ${m.p50DurationMs} | ${m.p95DurationMs} | ${m.maxDurationMs} |`
      )
    }
  }
  lines.push("")
  lines.push("## Recommendations")
  lines.push("")
  if (report.recommendations.length === 0) {
    lines.push("- No recommendations — session executed cleanly.")
  } else {
    for (const r of report.recommendations) {
      lines.push(`- ${r}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

const decodeTelemetryEvent = Schema.decodeOption(Schema.fromJsonString(TelemetryEvent))

export const appendTelemetryEvent = (
  repoRoot: string,
  input: {
    readonly surface: TelemetrySurface
    readonly category: TelemetryCategory
    readonly toolName: string
    readonly outcome: TelemetryOutcome
    readonly durationMs: number
    readonly engineSource?: TelemetryEngineSource | undefined
    readonly detail?: string | undefined
    readonly timestamp?: string | undefined
  }
): TelemetryEvent => {
  const record: TelemetryEvent = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    surface: input.surface,
    category: input.category,
    toolName: input.toolName,
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.engineSource !== undefined ? { engineSource: input.engineSource } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {})
  }
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(harnessDir)) {
        mkdirSync(harnessDir, { recursive: true })
      }
      appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8")
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
  return record
}

export const readTelemetryEvents = (repoRoot: string): ReadonlyArray<TelemetryEvent> => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  if (!existsSync(filePath)) {
    return []
  }
  const contentOption = Effect.runSync(
    Effect.try(() => readFileSync(filePath, "utf-8")).pipe(Effect.option)
  )
  if (Option.isNone(contentOption)) {
    return []
  }
  const lines = contentOption.value.split("\n")
  const events: Array<TelemetryEvent> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const decoded = decodeTelemetryEvent(trimmed)
    if (Option.isSome(decoded)) {
      events.push(decoded.value)
    }
  }
  return events
}

export const clearTelemetryEvents = (repoRoot: string): void => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(harnessDir)) {
        mkdirSync(harnessDir, { recursive: true })
      }
      writeFileSync(filePath, "", "utf-8")
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
}

export const writeSessionReportFiles = (
  repoRoot: string,
  report: SessionReport
): { readonly jsonPath: string; readonly markdownPath: string } => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const jsonPath = join(harnessDir, "session-report.json")
  const markdownPath = join(harnessDir, "session-report.md")
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(harnessDir)) {
        mkdirSync(harnessDir, { recursive: true })
      }
      writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8")
      writeFileSync(markdownPath, renderSessionReportMarkdown(report), "utf-8")
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
  return { jsonPath, markdownPath }
}
