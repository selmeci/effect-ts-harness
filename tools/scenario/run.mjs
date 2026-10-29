#!/usr/bin/env node
/**
 * Scenario session runner — observes a REAL agent session and evaluates what the
 * harness did (hooks, guard, clef, gates, MCP, skills) against hidden expectations.
 *
 * Nothing here drives the agent. The human drives the session by hand following
 * `scenarios/<id>/scenario.md`; this tool only brackets the session in time,
 * records step marks and afterwards slices telemetry / friction / transcript.
 *
 *   pnpm scenario list
 *   pnpm scenario start <id>          # preflight + prints the opening prompt
 *   pnpm scenario mark <label> [note] # call before each hidden-scenario step
 *   pnpm scenario status
 *   pnpm scenario end [--conversation <id>] [--transcript <path>]
 *
 * Results land in `.harness/scenario-runs/<run>/` (gitignored via `.harness/`).
 * See scenarios/README.md.
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const scenariosDir = join(repoRoot, "scenarios")
const runsDir = join(repoRoot, ".harness", "scenario-runs")
const stashedScenariosDir = join(runsDir, "_stashed-scenarios")
const currentPointer = join(runsDir, "current.json")
const gitExcludeFile = join(repoRoot, ".git", "info", "exclude")
const EXCLUDE_START = "# --- scenario-runner-hide-start ---"
const EXCLUDE_END = "# --- scenario-runner-hide-end ---"

// Mirrors libs/harness/gates/src/worktree.ts#resolveHarnessStateDir
const resolveStateDir = () => {
  const custom = process.env.HARNESS_STATE_DIR?.trim()
  if (custom) return resolve(repoRoot, custom)
  const worktreeId = process.env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId) {
    return join(repoRoot, ".harness", "worktrees", worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_"))
  }
  return join(repoRoot, ".harness")
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const readJsonl = (file) => {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const writeJsonl = (file, rows) =>
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

const parseFlags = (argv) => {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2)
      flags[key] = inline ?? argv[++i]
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

const die = (msg) => {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

const loadCurrentRun = () => {
  if (!existsSync(currentPointer)) die("No active scenario run. Start one with `pnpm scenario start <id>`.")
  const { runDir } = readJson(currentPointer)
  return { runDir, run: readJson(join(runDir, "run.json")) }
}

const saveRun = (runDir, run) => writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2))

/** Antigravity double-encodes tool args (`"\"value\""`); unwrap when possible. */
const unwrap = (value) => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// preflight: does clef answer the way the harness calls it?
// Mirrors libs/harness/decision/src/idiom-router.ts#LocalDecisionModel:
//   TypeSafeDecisionModel({ model: "clef-flash" }) → POST http://localhost:11434/v1/systemone
// A model that is merely *listed* is not enough (2026-10-28: only `clef-flash:9b`
// existed, `clef-flash` → 404, every decision silently fell back).
// ---------------------------------------------------------------------------

const CLEF_MODEL = process.env.HARNESS_CLEF_MODEL ?? "clef-flash"
const CLEF_BUDGET_MS = 1500

const callClef = async () => {
  const started = performance.now()
  const res = await fetch("http://localhost:11434/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model: CLEF_MODEL,
      state: { command: "rm -r dist" },
      questions: {
        destructive: { type: "noul", instructions: "Does this command delete, overwrite, or mutate critical state irreversibly?" }
      }
    })
  })
  const ms = Math.round(performance.now() - started)
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, ms, status: res.status, body }
}

const preflightClef = async () => {
  try {
    const cold = await callClef()
    if (!cold.ok) {
      return {
        clefModel: false,
        detail: `${CLEF_MODEL}: HTTP ${cold.status} ${JSON.stringify(cold.body?.error?.message ?? cold.body)}`
      }
    }
    const warm = await callClef()
    const p = warm.body?.answers?.destructive?.noul
    const withinBudget = warm.ms < CLEF_BUDGET_MS
    return {
      clefModel: withinBudget,
      coldMs: cold.ms,
      warmMs: warm.ms,
      detail: `${CLEF_MODEL} cold=${cold.ms}ms warm=${warm.ms}ms (budget ${CLEF_BUDGET_MS}ms) sanity destructive("rm -r dist")=${typeof p === "number" ? p.toFixed(2) : "?"}${withinBudget ? "" : " — TOO SLOW"}`
    }
  } catch (err) {
    return { clefModel: false, detail: `${CLEF_MODEL}: ${String(err?.message ?? err)}` }
  }
}

// ---------------------------------------------------------------------------
// transcript discovery + normalisation (Antigravity + Claude Code)
// ---------------------------------------------------------------------------

const antigravityBrain = join(homedir(), ".gemini", "antigravity", "brain")

const firstTimestamp = (file) => {
  const rows = readJsonl(file)
  const row = rows.find((r) => r.created_at || r.timestamp)
  return row ? (row.created_at ?? row.timestamp) : undefined
}

const discoverTranscript = (run, flags) => {
  if (flags.transcript) return resolve(flags.transcript)
  if (flags.conversation) {
    const file = join(antigravityBrain, flags.conversation, ".system_generated", "logs", "transcript.jsonl")
    if (!existsSync(file)) die(`Transcript not found: ${file}`)
    return file
  }
  const candidates = []
  // Antigravity
  if (existsSync(antigravityBrain)) {
    for (const id of readdirSync(antigravityBrain)) {
      const file = join(antigravityBrain, id, ".system_generated", "logs", "transcript.jsonl")
      if (existsSync(file)) candidates.push(file)
    }
  }
  // Claude Code: ~/.claude/projects/<repo path with / -> ->/<session>.jsonl
  const claudeDir = join(homedir(), ".claude", "projects", repoRoot.replace(/[/.]/g, "-"))
  if (existsSync(claudeDir)) {
    for (const f of readdirSync(claudeDir)) if (f.endsWith(".jsonl")) candidates.push(join(claudeDir, f))
  }
  // The scenario session is the conversation that STARTED after `scenario start`
  // and was still being written to; pick the earliest such start.
  const started = run.startedAt
  const picked = candidates
    .filter((f) => statSync(f).mtime.toISOString() >= started)
    .map((f) => ({ f, first: firstTimestamp(f) }))
    .filter((c) => c.first !== undefined && new Date(c.first).toISOString() >= started)
    .sort((a, b) => (a.first < b.first ? -1 : 1))[0]
  return picked?.f
}

/** -> [{ timestamp, tool, args, raw }] where args is a searchable string. */
const normaliseTranscript = (file) => {
  const out = []
  for (const row of readJsonl(file)) {
    // Antigravity: { created_at, tool_calls: [{ name, args }] }
    if (Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([k, v]) => [k, unwrap(v)]))
        const tool =
          call.name === "call_mcp_tool" ? `mcp:${args.ServerName ?? "?"}/${args.ToolName ?? "?"}` : call.name
        out.push({ timestamp: new Date(row.created_at).toISOString(), tool, args: JSON.stringify(args) })
      }
    }
    // Claude Code: { type: "assistant", timestamp, message: { content: [{ type: "tool_use", name, input }] } }
    const content = row?.message?.content
    if (row.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_use") {
          out.push({
            timestamp: new Date(row.timestamp).toISOString(),
            tool: part.name,
            args: JSON.stringify(part.input ?? {})
          })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

const matches = (record, where = {}) =>
  Object.entries(where).every(([key, expected]) => {
    const isRegex = key.endsWith("~")
    const field = isRegex ? key.slice(0, -1) : key
    const value = record[field]
    if (value === undefined || value === null) return false
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return isRegex ? new RegExp(expected, "i").test(text) : text === String(expected)
  })

/** Step windows: a mark opens a window that lasts until the next mark (or run end).
 *  Window start gets a 1 s grace because Antigravity transcript timestamps are whole seconds. */
const stepWindows = (run) => {
  const marks = run.marks ?? []
  const grace = (iso) => new Date(new Date(iso).getTime() - 1000).toISOString()
  return Object.fromEntries(
    marks.map((m, i) => [m.label, { from: grace(m.timestamp), to: marks[i + 1]?.timestamp ?? run.endedAt }])
  )
}

const inWindows = (record, steps, windows) => {
  if (steps === undefined) return true
  const list = Array.isArray(steps) ? steps : [steps]
  return list.some((label) => {
    const w = windows[label]
    return w !== undefined && record.timestamp >= w.from && record.timestamp <= w.to
  })
}

const select = (sources, spec, windows) =>
  (sources[spec.source] ?? []).filter((r) => matches(r, spec.where) && inWindows(r, spec.step, windows))

const evaluateCheck = (check, sources, windows) => {
  const severity = check.severity ?? "fail"
  if (check.type === "compare") {
    const left = select(sources, { step: check.step, ...check.left }, windows).length
    const right = select(sources, { step: check.step, ...check.right }, windows).length
    return { ...check, severity, passed: left >= right, observed: `left=${left} ≥ right=${right}?` }
  }
  if (check.type === "order") {
    const a = select(sources, check.before, windows)[0]
    const b = select(sources, check.after, windows)[0]
    const passed = a !== undefined && b !== undefined && a.timestamp <= b.timestamp
    const observed =
      a === undefined || b === undefined
        ? `before=${a ? "seen" : "missing"}, after=${b ? "seen" : "missing"}`
        : `${a.timestamp} → ${b.timestamp}`
    return { ...check, severity, passed, observed }
  }
  const hits = select(sources, check, windows)
  const min = check.min ?? (check.max === undefined ? 1 : 0)
  const max = check.max ?? Number.POSITIVE_INFINITY
  const passed = hits.length >= min && hits.length <= max
  const range = check.max === undefined ? `≥${min}` : `${min}..${check.max}`
  return { ...check, severity, passed, observed: `${hits.length} (expected ${range})` }
}

const countBy = (rows, keyFn) => {
  const map = new Map()
  for (const r of rows) map.set(keyFn(r), (map.get(keyFn(r)) ?? 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

const icon = (r) => (r.passed ? "✅" : r.severity === "warn" ? "⚠️" : "❌")

const renderReport = ({ run, results, sources, transcriptFile, contamination }) => {
  const fails = results.filter((r) => !r.passed && r.severity === "fail").length
  const warns = results.filter((r) => !r.passed && r.severity === "warn").length
  const verdict = contamination.length > 0 ? "CONTAMINATED" : fails > 0 ? "FAIL" : warns > 0 ? "PASS (with warnings)" : "PASS"
  const lines = [
    `# Scenario run: ${run.scenario}`,
    "",
    `**Verdict:** ${verdict} — ${fails} fail, ${warns} warn, ${results.length} checks`,
    `**Window:** ${run.startedAt} → ${run.endedAt}`,
    `**Clef preflight:** ${run.preflight.clefModel ? "OK" : "NOT OK"} — ${run.preflight.detail}`,
    `**Transcript:** ${transcriptFile ?? "not found (transcript checks skipped / failed)"}`,
    ""
  ]
  if (contamination.length > 0) {
    lines.push(
      "> [!CAUTION]",
      "> The agent touched `scenarios/` or `tools/scenario/` — it may have seen the hidden script. Results are not trustworthy.",
      ...contamination.map((c) => `> - ${c.timestamp} \`${c.tool}\` ${c.args.slice(0, 160)}`),
      ""
    )
  }
  lines.push("## Checks", "", "| | Check | Step | Observed | Why it matters |", "|---|---|---|---|---|")
  for (const r of results) {
    const step = r.step === undefined ? "all" : [].concat(r.step).join(", ")
    lines.push(`| ${icon(r)} | \`${r.id}\` | ${step} | ${r.observed} | ${(r.why ?? "").replace(/\|/g, "\\|")} |`)
  }
  lines.push("", "## Step timeline", "")
  for (const m of run.marks ?? []) lines.push(`- \`${m.timestamp}\` **${m.label}**${m.note ? ` — ${m.note}` : ""}`)
  lines.push("", "## Telemetry (toolName · outcome · engineSource)", "", "| Count | Event |", "|---|---|")
  for (const [k, n] of countBy(sources.telemetry, (e) => `${e.surface}/${e.toolName} · ${e.outcome}${e.engineSource ? ` · ${e.engineSource}` : ""}`))
    lines.push(`| ${n} | ${k} |`)
  lines.push("", "## Friction", "", "| Count | Kind · verdict |", "|---|---|")
  for (const [k, n] of countBy(sources.friction, (f) => `${f.kind} · ${(f.detail ?? "").split(";")[0]}`))
    lines.push(`| ${n} | ${k} |`)
  lines.push("", "## Agent tool usage (transcript)", "", "| Count | Tool |", "|---|---|")
  for (const [k, n] of countBy(sources.transcript, (t) => t.tool)) lines.push(`| ${n} | ${k} |`)
  lines.push("", "## Human notes", "", "_What felt wrong during the session? Which step needed a nudge?_", "")
  return { markdown: lines.join("\n"), verdict, fails }
}

// ---------------------------------------------------------------------------
// workspace isolation (hide scenarios/ during active runs so the tested agent
// cannot discover or read expectations via `find .`, `git status`, or `view_file`)
// ---------------------------------------------------------------------------

const activeScenariosDir = () => (existsSync(stashedScenariosDir) ? stashedScenariosDir : scenariosDir)

const STAMP_IGNORED = new Set([
  ".git",
  ".harness",
  "node_modules",
  "dist",
  "coverage",
  ".nx",
  ".superpowers",
  "repos",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".alchemy",
  ".vite",
  ".remember"
])

// Mirrors libs/harness/gates/src/verify-stamp.ts#computeWorkspaceTreeHash so that
// stashing/restoring `scenarios/` does not invalidate `.harness/verify-stamp.json`
// for the `Stop` hook (`harness done`) during read-only scenario sessions.
const refreshVerifyStampHash = () => {
  const stateDir = resolveStateDir()
  const stampPath = join(stateDir, "verify-stamp.json")
  if (!existsSync(stampPath)) return
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (STAMP_IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (full === stateDir || full.startsWith(stateDir + "/")) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full.slice(repoRoot.length + 1).replace(/\\/g, "/"))
    }
  }
  walk(repoRoot)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const hasher = createHash("sha256")
  for (const rel of files) {
    hasher.update(rel)
    hasher.update("\0")
    hasher.update(readFileSync(join(repoRoot, rel)))
  }
  const stamp = readJson(stampPath)
  stamp.treeHash = hasher.digest("hex")
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n")
}

const hideScenariosFromWorkspace = () => {
  mkdirSync(runsDir, { recursive: true })
  if (existsSync(scenariosDir) && !existsSync(stashedScenariosDir)) {
    renameSync(scenariosDir, stashedScenariosDir)
  }
  if (existsSync(gitExcludeFile)) {
    const raw = readFileSync(gitExcludeFile, "utf8")
    if (!raw.includes(EXCLUDE_START)) {
      const suffix = `${raw.endsWith("\n") ? "" : "\n"}${EXCLUDE_START}\n/scenarios/\n/tools/scenario/\n${EXCLUDE_END}\n`
      writeFileSync(gitExcludeFile, raw + suffix)
    }
  }
  refreshVerifyStampHash()
}

const restoreScenariosToWorkspace = () => {
  let changed = false
  if (existsSync(stashedScenariosDir) && !existsSync(scenariosDir)) {
    renameSync(stashedScenariosDir, scenariosDir)
    changed = true
  }
  if (existsSync(gitExcludeFile)) {
    const raw = readFileSync(gitExcludeFile, "utf8")
    if (raw.includes(EXCLUDE_START)) {
      const cleaned = raw.replace(new RegExp(`\\n?${EXCLUDE_START}[\\s\\S]*?${EXCLUDE_END}\\n?`, "g"), "\n")
      writeFileSync(gitExcludeFile, cleaned)
      changed = true
    }
  }
  if (changed) refreshVerifyStampHash()
}

const extractStepGuide = (scenarioDir, label) => {
  const mdFile = join(scenarioDir, "scenario.md")
  if (!existsSync(mdFile)) return undefined
  const lines = readFileSync(mdFile, "utf8").split("\n")
  const headerRe = new RegExp(`^##\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  const startIdx = lines.findIndex((l) => headerRe.test(l))
  if (startIdx === -1) return undefined
  const body = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+|^---\s*$/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join("\n").trim()
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const listScenarios = () => {
  const root = activeScenariosDir()
  return existsSync(root)
    ? readdirSync(root).filter(
        (d) => !d.startsWith("_") && existsSync(join(root, d, "expectations.json"))
      )
    : []
}

const commands = {
  list: () => {
    if (!existsSync(currentPointer)) restoreScenariosToWorkspace()
    const root = activeScenariosDir()
    for (const id of listScenarios()) {
      const exp = readJson(join(root, id, "expectations.json"))
      console.log(`${id.padEnd(32)} ${exp.title ?? ""}`)
    }
  },

  start: async ({ positional }) => {
    const id = positional[0] ?? die("usage: pnpm scenario start <id>")
    if (existsSync(currentPointer)) die("A run is already active. Finish it with `pnpm scenario end` first.")
    restoreScenariosToWorkspace()
    const dir = join(scenariosDir, id)
    if (!existsSync(join(dir, "expectations.json"))) die(`Unknown scenario '${id}'. Try \`pnpm scenario list\`.`)
    const expectations = readJson(join(dir, "expectations.json"))
    const openingPrompt = readFileSync(join(dir, "prompt.md"), "utf8").trim()
    const preflight = await preflightClef()
    // Preconditions the scenario relies on (e.g. build artefacts for a clean-up step).
    // Runs BEFORE the window opens so its own hook/telemetry noise is excluded.
    for (const cmd of expectations.setup ?? []) {
      console.log(`  setup: ${cmd}`)
      execSync(cmd, { cwd: repoRoot, stdio: "inherit", shell: "/bin/bash" })
    }
    // Stash scenarios/ inside .harness/scenario-runs/_stashed-scenarios so the agent
    // cannot find or read the answer key during the run.
    hideScenariosFromWorkspace()
    const startedAt = new Date().toISOString()
    const runDir = join(runsDir, `${startedAt.replace(/[:.]/g, "-")}_${id}`)
    mkdirSync(runDir, { recursive: true })
    saveRun(runDir, { scenario: id, startedAt, stateDir: resolveStateDir(), preflight, marks: [] })
    writeFileSync(currentPointer, JSON.stringify({ runDir }))

    console.log(`▶ Scenario run started: ${id}`)
    console.log(`  run dir:   ${runDir}`)
    console.log(`  state dir: ${resolveStateDir()}`)
    console.log(`  isolated:  scenarios/ stashed in .harness/scenario-runs/_stashed-scenarios (restored on \`end\`)`)
    console.log(`  clef:      ${preflight.clefModel ? "OK" : "NOT OK"} — ${preflight.detail}`)
    if ((expectations.requires ?? []).includes("clef") && !preflight.clefModel) {
      console.log(`\n⚠️  This scenario needs clef, but '${CLEF_MODEL}' does not answer within ${CLEF_BUDGET_MS} ms.`)
      console.log("   Check: ollama serve running; `ollama list` has an exact `clef-flash` tag")
      console.log("   (if you only have e.g. clef-flash:9b →  ollama cp clef-flash:9b clef-flash)")
      console.log("   Or continue on purpose to observe the deterministic fallback path.")
    }
    console.log("\nNext:")
    console.log("  1. Open a NEW agent session (Antigravity / Claude Code) in this repo.")
    console.log("  2. Run `pnpm scenario mark s1` (each `mark <step>` prints the prompt for that step).\n")
    console.log("──────── opening prompt (copy) ────────")
    console.log(openingPrompt)
    console.log("───────────────────────────────────────")
  },

  mark: ({ positional }) => {
    const label = positional[0] ?? die("usage: pnpm scenario mark <label> [note]")
    const { runDir, run } = loadCurrentRun()
    const mark = { label, note: positional.slice(1).join(" ") || undefined, timestamp: new Date().toISOString() }
    run.marks.push(mark)
    saveRun(runDir, run)
    console.log(`⚑ ${mark.timestamp} ${label}${mark.note ? ` — ${mark.note}` : ""}`)
    const scenarioDir = join(activeScenariosDir(), run.scenario)
    const guide = extractStepGuide(scenarioDir, label)
    if (guide) {
      console.log(`\n──────── ${label} guide ────────`)
      console.log(guide)
      if (label === "s1" && existsSync(join(scenarioDir, "prompt.md"))) {
        console.log("\nPrompt:")
        console.log(readFileSync(join(scenarioDir, "prompt.md"), "utf8").trim())
      }
      console.log("──────────────────────────")
    }
  },

  status: () => {
    const { runDir, run } = loadCurrentRun()
    console.log(`Active: ${run.scenario} since ${run.startedAt}\n  ${runDir}`)
    for (const m of run.marks) console.log(`  ⚑ ${m.timestamp} ${m.label}${m.note ? ` — ${m.note}` : ""}`)
  },

  end: ({ flags }) => {
    const { runDir, run } = loadCurrentRun()
    run.endedAt = new Date().toISOString()
    const inRun = (r) => r.timestamp >= run.startedAt && r.timestamp <= run.endedAt
    const telemetry = readJsonl(join(run.stateDir, "telemetry-log.jsonl")).filter(inRun)
    const friction = readJsonl(join(run.stateDir, "friction-log.jsonl")).filter(inRun)
    run.transcriptFile = discoverTranscript(run, flags)
    const transcript = run.transcriptFile ? normaliseTranscript(run.transcriptFile).filter(inRun) : []
    writeJsonl(join(runDir, "telemetry.jsonl"), telemetry)
    writeJsonl(join(runDir, "friction.jsonl"), friction)
    writeJsonl(join(runDir, "transcript-tools.jsonl"), transcript)
    saveRun(runDir, run)
    writeFileSync(join(runsDir, "last.json"), JSON.stringify({ runDir }))
    rmSync(currentPointer, { force: true })
    restoreScenariosToWorkspace()

    const expectations = evaluateRun(runDir, run, { telemetry, friction, transcript })
    for (const cmd of expectations.teardown ?? []) {
      console.log(`  teardown: ${cmd}`)
      execSync(cmd, { cwd: repoRoot, stdio: "inherit", shell: "/bin/bash" })
    }
  },

  /** Re-score a finished run (default: last) after editing expectations.json. */
  eval: ({ positional }) => {
    const runDir = positional[0]
      ? resolve(positional[0])
      : existsSync(join(runsDir, "last.json"))
        ? readJson(join(runsDir, "last.json")).runDir
        : die("No finished run. Pass a run dir.")
    const run = readJson(join(runDir, "run.json"))
    evaluateRun(runDir, run, {
      telemetry: readJsonl(join(runDir, "telemetry.jsonl")),
      friction: readJsonl(join(runDir, "friction.jsonl")),
      transcript: readJsonl(join(runDir, "transcript-tools.jsonl"))
    })
  }
}

function evaluateRun(runDir, run, sources) {
  const contamination = sources.transcript.filter((t) =>
    /scenarios\/|tools\/scenario|_stashed-scenarios|scenario-runs/.test(t.args)
  )
  const expectations = readJson(join(activeScenariosDir(), run.scenario, "expectations.json"))
  const results = expectations.checks.map((c) => evaluateCheck(c, sources, stepWindows(run)))
  const transcriptFile = run.transcriptFile
  writeFileSync(join(runDir, "results.json"), JSON.stringify({ run, transcriptFile, results, contamination }, null, 2))
  const { markdown, verdict, fails } = renderReport({ run, results, sources, transcriptFile, contamination })
  writeFileSync(join(runDir, "report.md"), markdown)

  for (const r of results) console.log(`${icon(r)} ${r.id.padEnd(40)} ${r.observed}`)
  console.log(`\n${verdict}  →  ${join(runDir, "report.md")}`)
  if (!transcriptFile) console.log("⚠️  No transcript found — pass --conversation <id> or --transcript <path>.")
  process.exitCode = fails > 0 || contamination.length > 0 ? 1 : 0
  return expectations
}

const [cmd = "list", ...rest] = process.argv.slice(2)
const handler = commands[cmd] ?? (() => die(`unknown command '${cmd}' (list|start|mark|status|end|eval)`))
await handler(parseFlags(rest))
