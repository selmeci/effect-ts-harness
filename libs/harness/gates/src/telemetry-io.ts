import { join } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type SessionReport,
  type TelemetryCategory,
  type TelemetryEngineSource,
  TelemetryEvent,
  type TelemetryOutcome,
  type TelemetrySurface,
} from "./telemetry.js"
import { resolveHarnessStateDir } from "./worktree.js"

/** Formats a `SessionReport` into the Markdown summary written to `.harness/session-report.md`. */
export const renderSessionReportMarkdown = (report: SessionReport): string => {
  const lines: Array<string> = []
  lines.push("# Harness Session Observability Report")
  lines.push("")
  lines.push(`**Health Score:** ${report.healthScore}/100 (Grade: ${report.grade})`)
  lines.push(
    `**Total Events:** ${report.totalEvents} | **Total Duration:** ${report.totalDurationMs} ms`,
  )
  lines.push("")
  lines.push("## Key Performance Indicators (KPIs)")
  lines.push("")
  lines.push("| KPI | Value | Description |")
  lines.push("|---|---|---|")
  lines.push(
    `| First-Pass Verification | ${report.kpis.firstPassVerify === null ? "N/A" : report.kpis.firstPassVerify ? "Passed" : "Failed"} | Green on first attempt |`,
  )
  lines.push(`| Verify Attempts | ${report.kpis.verifyAttempts} | Total verify runs |`)
  lines.push(`| Fix-Up Iterations | ${report.kpis.fixUpIterations} | Verify runs with failures |`)
  lines.push(
    `| Plan Before Verify | ${report.kpis.planBeforeVerify ? "Yes" : "No"} | Route/plan-check/graph queried first |`,
  )
  lines.push(
    `| Premature Done Attempts | ${report.kpis.prematureDoneAttempts} | Done invoked without valid stamp |`,
  )
  lines.push(
    `| Graph Discovery Calls | ${report.kpis.graphDiscoveryCalls} | Ontology & graph queries |`,
  )
  lines.push(
    `| Graph Discovery Ratio | ${report.kpis.graphDiscoveryRatio} | Discovery / non-hook calls |`,
  )
  lines.push(
    `| Omnigraph Live Ratio | ${report.kpis.omnigraphLiveRatio === null ? "N/A" : report.kpis.omnigraphLiveRatio} | Omnigraph vs fallback queries |`,
  )
  lines.push(
    `| Guard Interventions | ${report.kpis.guardInterventions} | Denied or asked actions |`,
  )
  lines.push(`| Friction Count | ${report.kpis.frictionCount} | Logged friction events |`)
  lines.push("")
  lines.push("## Tool Usage & Latency")
  lines.push("")
  if (report.toolMetrics.length === 0) {
    lines.push("*No tools recorded.*")
  } else {
    lines.push(
      "| Tool | Surface | Category | Calls | Success | Fail | Deny/Ask | Fallback | Success Rate | Mean (ms) | p50 (ms) | p95 (ms) | Max (ms) |",
    )
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (const m of report.toolMetrics) {
      lines.push(
        `| ${m.toolName} | ${m.surface} | ${m.category} | ${m.calls} | ${m.successCount} | ${m.failCount} | ${m.denyOrAskCount} | ${m.fallbackCount} | ${m.successRate} | ${m.meanDurationMs} | ${m.p50DurationMs} | ${m.p95DurationMs} | ${m.maxDurationMs} |`,
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

/** Appends one structured telemetry event line to `.harness/telemetry-log.jsonl`. */
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
  },
  hostIo: SyncHostIo,
): TelemetryEvent => {
  const record: TelemetryEvent = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    surface: input.surface,
    category: input.category,
    toolName: input.toolName,
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.engineSource !== undefined ? { engineSource: input.engineSource } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  }
  const harnessDir = resolveHarnessStateDir(repoRoot, hostIo.getEnv())
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  Result.getOrElse(
    Result.try(() => {
      if (!hostIo.existsSync(harnessDir)) {
        hostIo.mkdirRecursiveSync(harnessDir)
      }
      hostIo.appendTextSync(filePath, JSON.stringify(record) + "\n")
    }),
    () => undefined,
  )
  return record
}

/** Reads valid schema-decoded telemetry events from `.harness/telemetry-log.jsonl`. */
export const readTelemetryEvents = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<TelemetryEvent> => {
  const harnessDir = resolveHarnessStateDir(repoRoot, hostIo.getEnv())
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  if (!hostIo.existsSync(filePath)) {
    return []
  }
  const content = Result.getOrElse(
    Result.try(() => hostIo.readTextSync(filePath)),
    () => null,
  )
  if (content === null) {
    return []
  }
  const lines = content.split("\n")
  const events: Array<TelemetryEvent> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const decoded = decodeTelemetryEvent(trimmed)
    match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        events.push(value)
      })
      .with({ _tag: "None" }, () => {})
      .exhaustive()
  }
  return events
}

/** Truncates `.harness/telemetry-log.jsonl` cleanly for a fresh session window. */
export const clearTelemetryEvents = (repoRoot: string, hostIo: SyncHostIo): void => {
  const harnessDir = resolveHarnessStateDir(repoRoot, hostIo.getEnv())
  const filePath = join(harnessDir, "telemetry-log.jsonl")
  Result.getOrElse(
    Result.try(() => {
      if (!hostIo.existsSync(harnessDir)) {
        hostIo.mkdirRecursiveSync(harnessDir)
      }
      hostIo.writeTextSync(filePath, "")
    }),
    () => undefined,
  )
}

/** Persists `.harness/session-report.json` and `.harness/session-report.md`. */
export const writeSessionReportFiles = (
  repoRoot: string,
  report: SessionReport,
  hostIo: SyncHostIo,
): { readonly jsonPath: string; readonly markdownPath: string } => {
  const harnessDir = resolveHarnessStateDir(repoRoot, hostIo.getEnv())
  const jsonPath = join(harnessDir, "session-report.json")
  const markdownPath = join(harnessDir, "session-report.md")
  Result.getOrElse(
    Result.try(() => {
      if (!hostIo.existsSync(harnessDir)) {
        hostIo.mkdirRecursiveSync(harnessDir)
      }
      hostIo.writeTextSync(jsonPath, JSON.stringify(report, null, 2))
      hostIo.writeTextSync(markdownPath, renderSessionReportMarkdown(report))
    }),
    () => undefined,
  )
  return { jsonPath, markdownPath }
}
