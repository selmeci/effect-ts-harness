import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

/**
 * Branded scenario identifier.
 */
export const ScenarioName = Schema.NonEmptyString.pipe(Schema.brand("ScenarioName"))
export type ScenarioName = typeof ScenarioName.Type

/**
 * Typed scenario step specification.
 */
export const ScenarioStepSpec = Schema.Struct({
  name: ScenarioName,
  command: Schema.NonEmptyString,
})
export type ScenarioStepSpec = typeof ScenarioStepSpec.Type

/**
 * Typed scenario evaluation summary.
 */
export const ScenarioEvalSummary = Schema.Struct({
  name: ScenarioName,
  passed: Schema.Boolean,
  detail: Schema.String,
})
export type ScenarioEvalSummary = typeof ScenarioEvalSummary.Type

/**
 * Evaluates a single typed scenario step in Effect.
 */
export const evaluateScenarioStep = (
  step: ScenarioStepSpec,
): Effect.Effect<ScenarioEvalSummary> =>
  Effect.sync(() => {
    const res = nodeSyncHostIo.execFileSync("/bin/bash", ["-lc", step.command])
    return {
      name: step.name,
      passed: res.exitCode === 0,
      detail: res.exitCode === 0 ? res.stdout.trim() || "ok" : res.stderr.trim() || `exit ${res.exitCode}`,
    }
  })

export const ScenarioMarkSchema = Schema.Struct({
  label: Schema.String,
  note: Schema.optional(Schema.String),
  timestamp: Schema.String,
})
export type ScenarioMark = typeof ScenarioMarkSchema.Type

export const ScenarioPreflightSchema = Schema.Struct({
  clefModel: Schema.Boolean,
  coldMs: Schema.optional(Schema.Finite),
  warmMs: Schema.optional(Schema.Finite),
  detail: Schema.String,
})
export type ScenarioPreflight = typeof ScenarioPreflightSchema.Type

export const ScenarioRunStateSchema = Schema.Struct({
  scenario: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  stateDir: Schema.String,
  preflight: ScenarioPreflightSchema,
  marks: Schema.Array(ScenarioMarkSchema),
  transcriptFile: Schema.optional(Schema.String),
})
export type ScenarioRunState = typeof ScenarioRunStateSchema.Type

export const ScenarioPointerSchema = Schema.Struct({
  runDir: Schema.String,
})

const CheckSelectorSchema = Schema.Struct({
  source: Schema.String,
  where: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  step: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
type CheckSelector = typeof CheckSelectorSchema.Type

export const ScenarioCheckSpecSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  why: Schema.optional(Schema.String),
  step: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  source: Schema.optional(Schema.String),
  where: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
  left: Schema.optional(CheckSelectorSchema),
  right: Schema.optional(CheckSelectorSchema),
  before: Schema.optional(CheckSelectorSchema),
  after: Schema.optional(CheckSelectorSchema),
})
export type ScenarioCheckSpec = typeof ScenarioCheckSpecSchema.Type

export const ScenarioExpectationsSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  requires: Schema.optional(Schema.Array(Schema.String)),
  setup: Schema.optional(Schema.Array(Schema.String)),
  teardown: Schema.optional(Schema.Array(Schema.String)),
  checks: Schema.Array(ScenarioCheckSpecSchema),
})
export type ScenarioExpectations = typeof ScenarioExpectationsSchema.Type

export interface NormalisedToolCall {
  readonly timestamp: string
  readonly tool: string
  readonly args: string
}

export interface ScenarioSources {
  readonly telemetry: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly friction: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly transcript: ReadonlyArray<NormalisedToolCall>
}

export interface ScenarioFlags {
  readonly conversation?: string | undefined
  readonly transcript?: string | undefined
  readonly filter?: string | undefined
}

const decodeJsonRecordOption = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeUnknownOption = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))
const decodeRunStateOption = Schema.decodeOption(Schema.fromJsonString(ScenarioRunStateSchema))
const decodePointerOption = Schema.decodeOption(Schema.fromJsonString(ScenarioPointerSchema))
const decodeExpectationsOption = Schema.decodeOption(
  Schema.fromJsonString(ScenarioExpectationsSchema),
)

export const readJsonl = (filePath: string): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!nodeSyncHostIo.existsSync(filePath)) {
    return []
  }
  const rows: Array<Readonly<Record<string, unknown>>> = []
  for (const line of nodeSyncHostIo.readTextSync(filePath).split("\n")) {
    if (line.trim() === "") {
      continue
    }
    match(decodeJsonRecordOption(line))
      .with({ _tag: "Some" }, ({ value }) => {
        rows.push(value)
      })
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
  }
  return rows
}

export const writeJsonl = (filePath: string, rows: ReadonlyArray<unknown>): void => {
  const body = rows.map((row) => JSON.stringify(row)).join("\n")
  nodeSyncHostIo.writeTextSync(filePath, rows.length > 0 ? `${body}\n` : "")
}

export const readNormalisedTranscript = (filePath: string): ReadonlyArray<NormalisedToolCall> =>
  readJsonl(filePath).map((row) => ({
    timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
    tool: typeof row.tool === "string" ? row.tool : "",
    args: typeof row.args === "string" ? row.args : JSON.stringify(row.args ?? {}),
  }))

export const readScenarioRun = (filePath: string): ScenarioRunState | undefined => {
  if (!nodeSyncHostIo.existsSync(filePath)) {
    return undefined
  }
  return match(decodeRunStateOption(nodeSyncHostIo.readTextSync(filePath)))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

export const readPointerRunDir = (filePath: string): string | undefined => {
  if (!nodeSyncHostIo.existsSync(filePath)) {
    return undefined
  }
  return match(decodePointerOption(nodeSyncHostIo.readTextSync(filePath)))
    .with({ _tag: "Some" }, ({ value }) => value.runDir)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

export const readExpectations = (filePath: string): ScenarioExpectations | undefined => {
  if (!nodeSyncHostIo.existsSync(filePath)) {
    return undefined
  }
  return match(decodeExpectationsOption(nodeSyncHostIo.readTextSync(filePath)))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const unwrapJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value
  }
  return match(decodeUnknownOption(value))
    .with({ _tag: "Some" }, ({ value: parsed }) => parsed)
    .with({ _tag: "None" }, () => value)
    .exhaustive()
}

const firstTimestamp = (filePath: string): string | undefined => {
  const rows = readJsonl(filePath)
  for (const row of rows) {
    const ts = row.created_at ?? row.timestamp
    if (typeof ts === "string" && ts.length > 0) {
      return ts
    }
  }
  return undefined
}

const toIsoStringSafe = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return undefined
  }
  const ms = Date.parse(String(raw))
  if (Number.isNaN(ms)) {
    return undefined
  }
  return new Date(ms).toISOString()
}

export const discoverTranscript = (
  repoRoot: string,
  homeDir: string,
  run: ScenarioRunState,
  flags: ScenarioFlags,
): { readonly file?: string | undefined; readonly error?: string | undefined } => {
  if (flags.transcript !== undefined && flags.transcript.length > 0) {
    const file = resolve(flags.transcript)
    if (!nodeSyncHostIo.existsSync(file)) {
      return { error: `Transcript not found: ${file}` }
    }
    return { file }
  }
  const antigravityBrain = join(homeDir, ".gemini", "antigravity", "brain")
  if (flags.conversation !== undefined && flags.conversation.length > 0) {
    const file = join(
      antigravityBrain,
      flags.conversation,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    )
    if (!nodeSyncHostIo.existsSync(file)) {
      return { error: `Transcript not found: ${file}` }
    }
    return { file }
  }

  const candidates: Array<string> = []
  if (nodeSyncHostIo.isDirectorySync(antigravityBrain)) {
    for (const entry of nodeSyncHostIo.readdirSync(antigravityBrain)) {
      const file = join(antigravityBrain, entry.name, ".system_generated", "logs", "transcript.jsonl")
      if (nodeSyncHostIo.existsSync(file)) {
        candidates.push(file)
      }
    }
  }

  const claudeDir = join(homeDir, ".claude", "projects", repoRoot.replace(/[/.]/g, "-"))
  if (nodeSyncHostIo.isDirectorySync(claudeDir)) {
    for (const entry of nodeSyncHostIo.readdirSync(claudeDir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        candidates.push(join(claudeDir, entry.name))
      }
    }
  }

  const started = run.startedAt
  const validCandidates: Array<{ readonly file: string; readonly first: string }> = []
  for (const file of candidates) {
    const mtimeMs = nodeSyncHostIo.statMtimeMsSync(file)
    if (mtimeMs === undefined || new Date(mtimeMs).toISOString() < started) {
      continue
    }
    const first = firstTimestamp(file)
    const firstIso = toIsoStringSafe(first)
    if (firstIso !== undefined && firstIso >= started) {
      validCandidates.push({ file, first: firstIso })
    }
  }
  validCandidates.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
  return { file: validCandidates[0]?.file }
}

const asDisplayString = (value: unknown, fallback = ""): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : fallback

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normaliseTranscript = (filePath: string): ReadonlyArray<NormalisedToolCall> => {
  const out: Array<NormalisedToolCall> = []
  for (const row of readJsonl(filePath)) {
    if (Array.isArray(row.tool_calls)) {
      const ts = toIsoStringSafe(row.created_at) ?? ""
      for (const call of row.tool_calls) {
        if (!isRecord(call)) {
          continue
        }
        const rawArgs = isRecord(call.args) ? call.args : {}
        const unwrappedArgs: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(rawArgs)) {
          unwrappedArgs[k] = unwrapJsonValue(v)
        }
        const rawName = typeof call.name === "string" ? call.name : "unknown"
        const tool =
          rawName === "call_mcp_tool"
            ? `mcp:${asDisplayString(unwrappedArgs.ServerName, "?")}/${asDisplayString(unwrappedArgs.ToolName, "?")}`
            : rawName
        out.push({
          timestamp: ts,
          tool,
          args: JSON.stringify(unwrappedArgs),
        })
      }
    }

    const message = isRecord(row.message) ? row.message : undefined
    const content = message !== undefined && Array.isArray(message.content) ? message.content : undefined
    if (row.type === "assistant" && content !== undefined) {
      const ts = toIsoStringSafe(row.timestamp) ?? ""
      for (const part of content) {
        if (isRecord(part) && part.type === "tool_use") {
          out.push({
            timestamp: ts,
            tool: typeof part.name === "string" ? part.name : "unknown",
            args: JSON.stringify(part.input ?? {}),
          })
        }
      }
    }
  }
  return out
}

const matchesRecord = (
  record: Readonly<Record<string, unknown>>,
  where: Readonly<Record<string, unknown>> = {},
): boolean =>
  Object.entries(where).every(([key, expected]) => {
    const isRegex = key.endsWith("~")
    const field = isRegex ? key.slice(0, -1) : key
    const value = record[field]
    if (value === undefined || value === null) {
      return false
    }
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return isRegex ? new RegExp(String(expected), "i").test(text) : text === String(expected)
  })

interface TimeWindow {
  readonly from: string
  readonly to: string
}

const buildStepWindows = (run: ScenarioRunState): Readonly<Record<string, TimeWindow>> => {
  const marks = run.marks
  const grace = (iso: string): string => new Date(new Date(iso).getTime() - 1000).toISOString()
  const out: Record<string, TimeWindow> = {}
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark === undefined) {
      continue
    }
    const nextMark = marks[i + 1]
    out[mark.label] = {
      from: grace(mark.timestamp),
      to: nextMark?.timestamp ?? run.endedAt ?? new Date().toISOString(),
    }
  }
  return out
}

const inWindows = (
  timestamp: string,
  steps: string | ReadonlyArray<string> | undefined,
  windows: Readonly<Record<string, TimeWindow>>,
): boolean => {
  if (steps === undefined) {
    return true
  }
  const list = typeof steps === "string" ? [steps] : steps
  return list.some((label) => {
    const w = windows[label]
    return w !== undefined && timestamp >= w.from && timestamp <= w.to
  })
}

const getSourceRows = (
  sources: ScenarioSources,
  sourceName: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  match(sourceName)
    .with("telemetry", () => sources.telemetry)
    .with("friction", () => sources.friction)
    .with("transcript", () =>
      sources.transcript.map((item) => ({
        timestamp: item.timestamp,
        tool: item.tool,
        args: item.args,
      })),
    )
    .otherwise(() => [])

const selectRecords = (
  sources: ScenarioSources,
  spec: CheckSelector,
  windows: Readonly<Record<string, TimeWindow>>,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  getSourceRows(sources, spec.source).filter((record) => {
    const ts = typeof record.timestamp === "string" ? record.timestamp : ""
    return matchesRecord(record, spec.where) && inWindows(ts, spec.step, windows)
  })

interface EvaluatedCheck {
  readonly spec: ScenarioCheckSpec
  readonly severity: string
  readonly passed: boolean
  readonly observed: string
}

const evaluateCheck = (
  check: ScenarioCheckSpec,
  sources: ScenarioSources,
  windows: Readonly<Record<string, TimeWindow>>,
): EvaluatedCheck => {
  const severity = check.severity ?? "fail"
  if (check.type === "compare" && check.left !== undefined && check.right !== undefined) {
    const left = selectRecords(sources, { ...check.left, step: check.step ?? check.left.step }, windows).length
    const right = selectRecords(sources, { ...check.right, step: check.step ?? check.right.step }, windows).length
    return { spec: check, severity, passed: left >= right, observed: `left=${left} ≥ right=${right}?` }
  }
  if (check.type === "order" && check.before !== undefined && check.after !== undefined) {
    const first = selectRecords(sources, check.before, windows)[0]
    const second = selectRecords(sources, check.after, windows)[0]
    const firstTs = typeof first?.timestamp === "string" ? first.timestamp : undefined
    const secondTs = typeof second?.timestamp === "string" ? second.timestamp : undefined
    const passed = firstTs !== undefined && secondTs !== undefined && firstTs <= secondTs
    const observed =
      firstTs === undefined || secondTs === undefined
        ? `before=${firstTs !== undefined ? "seen" : "missing"}, after=${secondTs !== undefined ? "seen" : "missing"}`
        : `${firstTs} → ${secondTs}`
    return { spec: check, severity, passed, observed }
  }
  const hits = selectRecords(
    sources,
    { source: check.source ?? "telemetry", where: check.where, step: check.step },
    windows,
  )
  const min = check.min ?? (check.max === undefined ? 1 : 0)
  const max = check.max ?? Number.POSITIVE_INFINITY
  const passed = hits.length >= min && hits.length <= max
  const range = check.max === undefined ? `≥${min}` : `${min}..${check.max}`
  return { spec: check, severity, passed, observed: `${hits.length} (expected ${range})` }
}

const countBy = <T>(
  rows: ReadonlyArray<T>,
  keyFn: (row: T) => string,
): ReadonlyArray<readonly [string, number]> => {
  const map = new Map<string, number>()
  for (const row of rows) {
    const key = keyFn(row)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

const statusIcon = (result: EvaluatedCheck): string =>
  result.passed ? "✅" : result.severity === "warn" ? "⚠️" : "❌"

const renderReport = (input: {
  readonly run: ScenarioRunState
  readonly results: ReadonlyArray<EvaluatedCheck>
  readonly sources: ScenarioSources
  readonly transcriptFile: string | undefined
  readonly contamination: ReadonlyArray<NormalisedToolCall>
}): { readonly markdown: string; readonly verdict: string; readonly fails: number } => {
  const fails = input.results.filter((r) => !r.passed && r.severity === "fail").length
  const warns = input.results.filter((r) => !r.passed && r.severity === "warn").length
  const verdict =
    input.contamination.length > 0
      ? "CONTAMINATED"
      : fails > 0
        ? "FAIL"
        : warns > 0
          ? "PASS (with warnings)"
          : "PASS"

  const lines: Array<string> = [
    `# Scenario run: ${input.run.scenario}`,
    "",
    `**Verdict:** ${verdict} — ${fails} fail, ${warns} warn, ${input.results.length} checks`,
    `**Window:** ${input.run.startedAt} → ${input.run.endedAt ?? ""}`,
    `**Clef preflight:** ${input.run.preflight.clefModel ? "OK" : "NOT OK"} — ${input.run.preflight.detail}`,
    `**Transcript:** ${input.transcriptFile ?? "not found (transcript checks skipped / failed)"}`,
    "",
  ]

  if (input.contamination.length > 0) {
    lines.push(
      "> [!CAUTION]",
      "> The agent touched `scenarios/` or `tools/scenario/` — it may have seen the hidden script. Results are not trustworthy.",
      ...input.contamination.map((c) => `> - ${c.timestamp} \`${c.tool}\` ${c.args.slice(0, 160)}`),
      "",
    )
  }

  lines.push(
    "## Checks",
    "",
    "| | Check | Step | Observed | Why it matters |",
    "|---|---|---|---|---|",
  )
  for (const r of input.results) {
    const step =
      r.spec.step === undefined
        ? "all"
        : typeof r.spec.step === "string"
          ? r.spec.step
          : r.spec.step.join(", ")
    lines.push(
      `| ${statusIcon(r)} | \`${r.spec.id}\` | ${step} | ${r.observed} | ${(r.spec.why ?? "").replace(/\|/g, "\\|")} |`,
    )
  }

  lines.push("", "## Step timeline", "")
  for (const m of input.run.marks) {
    lines.push(`- \`${m.timestamp}\` **${m.label}**${m.note ? ` — ${m.note}` : ""}`)
  }

  lines.push(
    "",
    "## Telemetry (toolName · outcome · engineSource)",
    "",
    "| Count | Event |",
    "|---|---|",
  )
  for (const [k, n] of countBy(
    input.sources.telemetry,
    (e) =>
      `${asDisplayString(e.surface)}/${asDisplayString(e.toolName)} · ${asDisplayString(e.outcome)}${typeof e.engineSource === "string" && e.engineSource.length > 0 ? ` · ${e.engineSource}` : ""}`,
  )) {
    lines.push(`| ${n} | ${k} |`)
  }

  lines.push("", "## Friction", "", "| Count | Kind · verdict |", "|---|---|")
  for (const [k, n] of countBy(
    input.sources.friction,
    (f) => `${asDisplayString(f.kind)} · ${asDisplayString(f.detail).split(";")[0] ?? ""}`,
  )) {
    lines.push(`| ${n} | ${k} |`)
  }

  lines.push("", "## Agent tool usage (transcript)", "", "| Count | Tool |", "|---|---|")
  for (const [k, n] of countBy(input.sources.transcript, (t) => t.tool)) {
    lines.push(`| ${n} | ${k} |`)
  }

  lines.push(
    "",
    "## Human notes",
    "",
    "_What felt wrong during the session? Which step needed a nudge?_",
    "",
  )
  return { markdown: lines.join("\n"), verdict, fails }
}

export const evaluateScenarioRun = (
  runDir: string,
  run: ScenarioRunState,
  sources: ScenarioSources,
  expectations: ScenarioExpectations,
): { readonly exitCode: number; readonly stdout: string } => {
  const contamination = sources.transcript.filter((t) =>
    /scenarios\/|tools\/scenario|_stashed-scenarios|scenario-runs/.test(t.args),
  )
  const windows = buildStepWindows(run)
  const results = expectations.checks.map((c) => evaluateCheck(c, sources, windows))
  const transcriptFile = run.transcriptFile
  nodeSyncHostIo.writeTextSync(
    join(runDir, "results.json"),
    JSON.stringify({ run, transcriptFile, results, contamination }, null, 2),
  )
  const { markdown, verdict, fails } = renderReport({
    run,
    results,
    sources,
    transcriptFile,
    contamination,
  })
  nodeSyncHostIo.writeTextSync(join(runDir, "report.md"), markdown)

  const outLines = results.map((r) => `${statusIcon(r)} ${r.spec.id.padEnd(40)} ${r.observed}`)
  outLines.push("", `${verdict}  →  ${join(runDir, "report.md")}`)
  if (transcriptFile === undefined) {
    outLines.push("⚠️  No transcript found — pass --conversation <id> or --transcript <path>.")
  }
  return {
    exitCode: fails > 0 || contamination.length > 0 ? 1 : 0,
    stdout: `${outLines.join("\n")}\n`,
  }
}
