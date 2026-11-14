import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import {
  discoverTranscript,
  evaluateScenarioRun,
  normaliseTranscript,
  readExpectations,
  readJsonl,
  readNormalisedTranscript,
  readPointerRunDir,
  readScenarioRun,
  type ScenarioFlags,
  type ScenarioMark,
  type ScenarioPreflight,
  type ScenarioRunState,
  writeJsonl,
} from "./scenario-eval.js"

const EXCLUDE_START = "# --- scenario-runner-hide-start ---"
const EXCLUDE_END = "# --- scenario-runner-hide-end ---"
const CLEF_BUDGET_MS = 1500

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
  ".remember",
])

interface ScenarioPaths {
  readonly repoRoot: string
  readonly homeDir: string
  readonly scenariosDir: string
  readonly runsDir: string
  readonly stashedScenariosDir: string
  readonly currentPointer: string
  readonly lastPointer: string
  readonly gitExcludeFile: string
}

const makeScenarioPaths = (repoRoot: string): ScenarioPaths => {
  const runsDir = join(repoRoot, ".harness", "scenario-runs")
  return {
    repoRoot,
    homeDir: process.env.HOME ?? "/root",
    scenariosDir: join(repoRoot, "scenarios"),
    runsDir,
    stashedScenariosDir: join(runsDir, "_stashed-scenarios"),
    currentPointer: join(runsDir, "current.json"),
    lastPointer: join(runsDir, "last.json"),
    gitExcludeFile: join(repoRoot, ".git", "info", "exclude"),
  }
}

const resolveStateDir = (repoRoot: string): string => {
  const custom = process.env.HARNESS_STATE_DIR?.trim()
  if (custom !== undefined && custom.length > 0) {
    return resolve(repoRoot, custom)
  }
  const worktreeId = process.env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId !== undefined && worktreeId.length > 0) {
    return join(repoRoot, ".harness", "worktrees", worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_"))
  }
  return join(repoRoot, ".harness")
}

const parseFlags = (
  argv: ReadonlyArray<string>,
): { readonly flags: ScenarioFlags; readonly positional: ReadonlyArray<string> } => {
  let conversation: string | undefined
  let transcript: string | undefined
  const positional: Array<string> = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) {
      continue
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=")
      const key = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx)
      const val = eqIdx === -1 ? argv[++i] : arg.slice(eqIdx + 1)
      if (key === "conversation") {
        conversation = val
      } else {
        if (key === "transcript") {
          transcript = val
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags: { conversation, transcript }, positional }
}

const activeScenariosDir = (paths: ScenarioPaths): string =>
  nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
    ? paths.stashedScenariosDir
    : paths.scenariosDir

const decodeJsonRecord = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const refreshVerifyStampHash = (repoRoot: string): void => {
  const stateDir = resolveStateDir(repoRoot)
  const stampPath = join(stateDir, "verify-stamp.json")
  if (!nodeSyncHostIo.existsSync(stampPath)) {
    return
  }
  const files: Array<string> = []
  const walk = (dir: string): void => {
    for (const entry of nodeSyncHostIo.readdirSync(dir)) {
      if (STAMP_IGNORED.has(entry.name)) {
        continue
      }
      const full = join(dir, entry.name)
      if (full === stateDir || full.startsWith(`${stateDir}/`)) {
        continue
      }
      if (entry.isDirectory) {
        walk(full)
      } else {
        if (entry.isFile) {
          files.push(full.slice(repoRoot.length + 1).replace(/\\/g, "/"))
        }
      }
    }
  }
  walk(repoRoot)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const hasher = createHash("sha256")
  for (const rel of files) {
    hasher.update(rel)
    hasher.update("\0")
    hasher.update(nodeSyncHostIo.readBytesSync(join(repoRoot, rel)))
  }
  const stampOpt = decodeJsonRecord(nodeSyncHostIo.readTextSync(stampPath))
  match(stampOpt)
    .with({ _tag: "Some" }, ({ value }) => {
      const updated = { ...value, treeHash: hasher.digest("hex") }
      nodeSyncHostIo.writeTextSync(stampPath, `${JSON.stringify(updated, null, 2)}\n`)
    })
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const hideScenariosFromWorkspace = (paths: ScenarioPaths): void => {
  nodeSyncHostIo.mkdirRecursiveSync(paths.runsDir)
  if (
    nodeSyncHostIo.existsSync(paths.scenariosDir) &&
    !nodeSyncHostIo.existsSync(paths.stashedScenariosDir)
  ) {
    nodeSyncHostIo.renameSync(paths.scenariosDir, paths.stashedScenariosDir)
  }
  if (nodeSyncHostIo.existsSync(paths.gitExcludeFile)) {
    const raw = nodeSyncHostIo.readTextSync(paths.gitExcludeFile)
    if (!raw.includes(EXCLUDE_START)) {
      const suffix = `${raw.endsWith("\n") ? "" : "\n"}${EXCLUDE_START}\n/scenarios/\n/tools/scenario/\n${EXCLUDE_END}\n`
      nodeSyncHostIo.writeTextSync(paths.gitExcludeFile, raw + suffix)
    }
  }
  refreshVerifyStampHash(paths.repoRoot)
}

const restoreScenariosToWorkspace = (paths: ScenarioPaths): void => {
  let changed = false
  if (
    nodeSyncHostIo.existsSync(paths.stashedScenariosDir) &&
    !nodeSyncHostIo.existsSync(paths.scenariosDir)
  ) {
    nodeSyncHostIo.renameSync(paths.stashedScenariosDir, paths.scenariosDir)
    changed = true
  }
  if (nodeSyncHostIo.existsSync(paths.gitExcludeFile)) {
    const raw = nodeSyncHostIo.readTextSync(paths.gitExcludeFile)
    if (raw.includes(EXCLUDE_START)) {
      const cleaned = raw.replace(
        new RegExp(`\\n?${EXCLUDE_START}[\\s\\S]*?${EXCLUDE_END}\\n?`, "g"),
        "\n",
      )
      nodeSyncHostIo.writeTextSync(paths.gitExcludeFile, cleaned)
      changed = true
    }
  }
  if (changed) {
    refreshVerifyStampHash(paths.repoRoot)
  }
}

const extractStepGuide = (scenarioDir: string, label: string): string | undefined => {
  const mdFile = join(scenarioDir, "scenario.md")
  if (!nodeSyncHostIo.existsSync(mdFile)) {
    return undefined
  }
  const lines = nodeSyncHostIo.readTextSync(mdFile).split("\n")
  const headerRe = new RegExp(`^##\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  const startIdx = lines.findIndex((l) => headerRe.test(l))
  if (startIdx === -1) {
    return undefined
  }
  const body: Array<string> = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || /^##\s+|^---\s*$/.test(line)) {
      break
    }
    body.push(line)
  }
  return body.join("\n").trim()
}

const listScenarios = (paths: ScenarioPaths): ReadonlyArray<string> => {
  const root = activeScenariosDir(paths)
  if (!nodeSyncHostIo.isDirectorySync(root)) {
    return []
  }
  return nodeSyncHostIo
    .readdirSync(root)
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.startsWith("_") && nodeSyncHostIo.existsSync(join(root, name, "expectations.json")),
    )
}

const ClefBodySchema = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  answers: Schema.optional(
    Schema.Struct({
      destructive: Schema.optional(Schema.Struct({ noul: Schema.optional(Schema.Finite) })),
    }),
  ),
})
const decodeClefBody = Schema.decodeUnknownOption(ClefBodySchema)

class ClefRequestError extends Schema.TaggedError<ClefRequestError>()("ClefRequestError", {
  detail: Schema.String,
}) {}

const callClef = (clefModel: string) =>
  Effect.gen(function* () {
    const started = performance.now()
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch("http://localhost:11434/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            model: clefModel,
            state: { command: "rm -r dist" },
            questions: {
              destructive: {
                type: "noul",
                instructions:
                  "Does this command delete, overwrite, or mutate critical state irreversibly?",
              },
            },
          }),
        }),
      catch: (err) => new ClefRequestError({ detail: String(err) }),
    })
    const ms = Math.round(performance.now() - started)
    const rawBodyExit = yield* Effect.exit(
      Effect.tryPromise({
        try: () => res.json(),
        catch: () => ({}),
      }),
    )
    const rawBody = match(rawBodyExit)
      .with({ _tag: "Success" }, ({ value }) => value)
      .with({ _tag: "Failure" }, () => ({}))
      .exhaustive()
    return { ok: res.ok, ms, status: res.status, body: rawBody }
  })

const preflightClef = (clefModel: string): Effect.Effect<ScenarioPreflight> =>
  Effect.gen(function* () {
    const coldExit = yield* Effect.exit(callClef(clefModel))
    const coldOutcome = match(coldExit)
      .with({ _tag: "Failure" }, ({ cause }) => ({
        ok: false as const,
        preflight: { clefModel: false, detail: `${clefModel}: ${String(cause)}` } satisfies ScenarioPreflight,
      }))
      .with({ _tag: "Success" }, ({ value }) => ({ ok: true as const, value }))
      .exhaustive()

    if (!coldOutcome.ok) {
      return coldOutcome.preflight
    }

    const cold = coldOutcome.value
    if (!cold.ok) {
      const errDetail = match(decodeClefBody(cold.body))
        .with({ _tag: "Some" }, ({ value }) => value.error?.message ?? JSON.stringify(cold.body))
        .with({ _tag: "None" }, () => JSON.stringify(cold.body))
        .exhaustive()
      return {
        clefModel: false,
        detail: `${clefModel}: HTTP ${cold.status} ${errDetail}`,
      }
    }

    const warmExit = yield* Effect.exit(callClef(clefModel))
    return match(warmExit)
      .with({ _tag: "Failure" }, ({ cause }) => ({
        clefModel: false,
        detail: `${clefModel}: ${String(cause)}`,
      }))
      .with({ _tag: "Success" }, ({ value: warm }) => {
        const prob = match(decodeClefBody(warm.body))
          .with({ _tag: "Some" }, ({ value }) => value.answers?.destructive?.noul)
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
        const withinBudget = warm.ms < CLEF_BUDGET_MS
        const probLabel = prob !== undefined ? prob.toFixed(2) : "?"
        return {
          clefModel: withinBudget,
          coldMs: cold.ms,
          warmMs: warm.ms,
          detail: `${clefModel} cold=${cold.ms}ms warm=${warm.ms}ms (budget ${CLEF_BUDGET_MS}ms) sanity destructive("rm -r dist")=${probLabel}${withinBudget ? "" : " — TOO SLOW"}`,
        }
      })
      .exhaustive()
  })

const saveRun = (runDir: string, run: ScenarioRunState): void => {
  nodeSyncHostIo.writeTextSync(join(runDir, "run.json"), JSON.stringify(run, null, 2))
}

const loadCurrentRun = (
  paths: ScenarioPaths,
): { readonly runDir: string; readonly run: ScenarioRunState } | { readonly error: string } => {
  if (!nodeSyncHostIo.existsSync(paths.currentPointer)) {
    return { error: "No active scenario run. Start one with `pnpm scenario start <id>`." }
  }
  const runDir = readPointerRunDir(paths.currentPointer)
  if (runDir === undefined) {
    return { error: `Invalid current scenario pointer: ${paths.currentPointer}` }
  }
  const run = readScenarioRun(join(runDir, "run.json"))
  if (run === undefined) {
    return { error: `Invalid scenario run state in ${runDir}` }
  }
  return { runDir, run }
}

const failMsg = (msg: string): CliResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `✖ ${msg}\n`,
})

const handleList = (paths: ScenarioPaths): CliResult => {
  if (!nodeSyncHostIo.existsSync(paths.currentPointer)) {
    restoreScenariosToWorkspace(paths)
  }
  const root = activeScenariosDir(paths)
  const lines = listScenarios(paths).map((id) => {
    const exp = readExpectations(join(root, id, "expectations.json"))
    return `${id.padEnd(32)} ${exp?.title ?? ""}`
  })
  return {
    exitCode: 0,
    stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    stderr: "",
  }
}

const handleStart = (
  paths: ScenarioPaths,
  positional: ReadonlyArray<string>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const id = positional[0]
    if (id === undefined || id.length === 0) {
      return failMsg("usage: pnpm scenario start <id>")
    }
    if (nodeSyncHostIo.existsSync(paths.currentPointer)) {
      return failMsg("A run is already active. Finish it with `pnpm scenario end` first.")
    }
    restoreScenariosToWorkspace(paths)
    const dir = join(paths.scenariosDir, id)
    const expFile = join(dir, "expectations.json")
    if (!nodeSyncHostIo.existsSync(expFile)) {
      return failMsg(`Unknown scenario '${id}'. Try \`pnpm scenario list\`.`)
    }
    const expectations = readExpectations(expFile)
    if (expectations === undefined) {
      return failMsg(`Invalid expectations.json in ${dir}`)
    }
    const openingPrompt = nodeSyncHostIo.readTextSync(join(dir, "prompt.md")).trim()
    const clefModel = process.env.HARNESS_CLEF_MODEL ?? "clef-flash"
    const preflight = yield* preflightClef(clefModel)

    const out: Array<string> = []
    for (const cmd of expectations.setup ?? []) {
      out.push(`  setup: ${cmd}`)
      const setupRes = nodeSyncHostIo.execFileSync("/bin/bash", ["-lc", cmd], {
        cwd: paths.repoRoot,
      })
      if (setupRes.stdout.length > 0) {
        out.push(setupRes.stdout.trimEnd())
      }
      if (setupRes.exitCode !== 0) {
        return {
          exitCode: setupRes.exitCode,
          stdout: `${out.join("\n")}\n`,
          stderr: setupRes.stderr,
        }
      }
    }

    hideScenariosFromWorkspace(paths)
    const startedAt = new Date().toISOString()
    const runDir = join(paths.runsDir, `${startedAt.replace(/[:.]/g, "-")}_${id}`)
    nodeSyncHostIo.mkdirRecursiveSync(runDir)
    const stateDir = resolveStateDir(paths.repoRoot)
    saveRun(runDir, { scenario: id, startedAt, stateDir, preflight, marks: [] })
    nodeSyncHostIo.writeTextSync(paths.currentPointer, JSON.stringify({ runDir }))

    out.push(
      `▶ Scenario run started: ${id}`,
      `  run dir:   ${runDir}`,
      `  state dir: ${stateDir}`,
      `  isolated:  scenarios/ stashed in .harness/scenario-runs/_stashed-scenarios (restored on \`end\`)`,
      `  clef:      ${preflight.clefModel ? "OK" : "NOT OK"} — ${preflight.detail}`,
    )
    if ((expectations.requires ?? []).includes("clef") && !preflight.clefModel) {
      out.push(
        `\n⚠️  This scenario needs clef, but '${clefModel}' does not answer within ${CLEF_BUDGET_MS} ms.`,
        "   Check: ollama serve running; `ollama list` has an exact `clef-flash` tag",
        "   (if you only have e.g. clef-flash:9b →  ollama cp clef-flash:9b clef-flash)",
        "   Or continue on purpose to observe the deterministic fallback path.",
      )
    }
    out.push(
      "\nNext:",
      "  1. Open a NEW agent session (Antigravity / Claude Code) in this repo.",
      "  2. Run `pnpm scenario mark s1` (each `mark <step>` prints the prompt for that step).\n",
      "──────── opening prompt (copy) ────────",
      openingPrompt,
      "───────────────────────────────────────",
    )
    return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" }
  })

const handleMark = (paths: ScenarioPaths, positional: ReadonlyArray<string>): CliResult => {
  const label = positional[0]
  if (label === undefined || label.length === 0) {
    return failMsg("usage: pnpm scenario mark <label> [note]")
  }
  const loaded = loadCurrentRun(paths)
  if ("error" in loaded) {
    return failMsg(loaded.error)
  }
  const noteRaw = positional.slice(1).join(" ")
  const mark: ScenarioMark = {
    label,
    note: noteRaw.length > 0 ? noteRaw : undefined,
    timestamp: new Date().toISOString(),
  }
  const updatedRun: ScenarioRunState = {
    ...loaded.run,
    marks: [...loaded.run.marks, mark],
  }
  saveRun(loaded.runDir, updatedRun)

  const out: Array<string> = [
    `⚑ ${mark.timestamp} ${label}${mark.note !== undefined ? ` — ${mark.note}` : ""}`,
  ]
  const scenarioDir = join(activeScenariosDir(paths), updatedRun.scenario)
  const guide = extractStepGuide(scenarioDir, label)
  if (guide !== undefined) {
    out.push(`\n──────── ${label} guide ────────`, guide)
    const promptPath = join(scenarioDir, "prompt.md")
    if (label === "s1" && nodeSyncHostIo.existsSync(promptPath)) {
      out.push("\nPrompt:", nodeSyncHostIo.readTextSync(promptPath).trim())
    }
    out.push("──────────────────────────")
  }
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" }
}

const handleStatus = (paths: ScenarioPaths): CliResult => {
  const loaded = loadCurrentRun(paths)
  if ("error" in loaded) {
    return failMsg(loaded.error)
  }
  const lines = [
    `Active: ${loaded.run.scenario} since ${loaded.run.startedAt}`,
    `  ${loaded.runDir}`,
    ...loaded.run.marks.map(
      (m) => `  ⚑ ${m.timestamp} ${m.label}${m.note !== undefined ? ` — ${m.note}` : ""}`,
    ),
  ]
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" }
}

const handleEnd = (paths: ScenarioPaths, flags: ScenarioFlags): CliResult => {
  const loaded = loadCurrentRun(paths)
  if ("error" in loaded) {
    return failMsg(loaded.error)
  }
  const endedAt = new Date().toISOString()
  const inRun = (row: { readonly timestamp?: unknown }): boolean => {
    const ts = typeof row.timestamp === "string" ? row.timestamp : ""
    return ts >= loaded.run.startedAt && ts <= endedAt
  }
  const telemetry = readJsonl(join(loaded.run.stateDir, "telemetry-log.jsonl")).filter(inRun)
  const friction = readJsonl(join(loaded.run.stateDir, "friction-log.jsonl")).filter(inRun)
  const discovered = discoverTranscript(paths.repoRoot, paths.homeDir, loaded.run, flags)
  if (discovered.error !== undefined) {
    return failMsg(discovered.error)
  }
  const transcript =
    discovered.file !== undefined ? normaliseTranscript(discovered.file).filter(inRun) : []
  const updatedRun: ScenarioRunState = {
    ...loaded.run,
    endedAt,
    transcriptFile: discovered.file,
  }
  writeJsonl(join(loaded.runDir, "telemetry.jsonl"), telemetry)
  writeJsonl(join(loaded.runDir, "friction.jsonl"), friction)
  writeJsonl(join(loaded.runDir, "transcript-tools.jsonl"), transcript)
  saveRun(loaded.runDir, updatedRun)
  nodeSyncHostIo.writeTextSync(paths.lastPointer, JSON.stringify({ runDir: loaded.runDir }))
  nodeSyncHostIo.rmRecursiveSync(paths.currentPointer)
  restoreScenariosToWorkspace(paths)

  const expPath = join(activeScenariosDir(paths), updatedRun.scenario, "expectations.json")
  const expectations = readExpectations(expPath)
  if (expectations === undefined) {
    return failMsg(`Invalid expectations.json at ${expPath}`)
  }

  const evalRes = evaluateScenarioRun(
    loaded.runDir,
    updatedRun,
    { telemetry, friction, transcript },
    expectations,
  )
  const out: Array<string> = [evalRes.stdout.trimEnd()]
  for (const cmd of expectations.teardown ?? []) {
    out.push(`  teardown: ${cmd}`)
    const teardownRes = nodeSyncHostIo.execFileSync("/bin/bash", ["-lc", cmd], {
      cwd: paths.repoRoot,
    })
    if (teardownRes.stdout.length > 0) {
      out.push(teardownRes.stdout.trimEnd())
    }
  }
  return { exitCode: evalRes.exitCode, stdout: `${out.join("\n")}\n`, stderr: "" }
}

const handleEval = (paths: ScenarioPaths, positional: ReadonlyArray<string>): CliResult => {
  const runDir =
    positional[0] !== undefined && positional[0].length > 0
      ? resolve(positional[0])
      : nodeSyncHostIo.existsSync(paths.lastPointer)
        ? readPointerRunDir(paths.lastPointer)
        : undefined
  if (runDir === undefined) {
    return failMsg("No finished run. Pass a run dir.")
  }
  const run = readScenarioRun(join(runDir, "run.json"))
  if (run === undefined) {
    return failMsg(`Invalid scenario run state in ${runDir}`)
  }
  const expPath = join(activeScenariosDir(paths), run.scenario, "expectations.json")
  const expectations = readExpectations(expPath)
  if (expectations === undefined) {
    return failMsg(`Invalid expectations.json at ${expPath}`)
  }
  const evalRes = evaluateScenarioRun(
    runDir,
    run,
    {
      telemetry: readJsonl(join(runDir, "telemetry.jsonl")),
      friction: readJsonl(join(runDir, "friction.jsonl")),
      transcript: readNormalisedTranscript(join(runDir, "transcript-tools.jsonl")),
    },
    expectations,
  )
  return { exitCode: evalRes.exitCode, stdout: evalRes.stdout, stderr: "" }
}

/**
 * Typed `scenario` subcommand.
 */
export const runScenarioCommand = Effect.fn("HarnessCli.runScenario")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "scenario" ? args.slice(1) : args
  const [cmd = "list", ...rest] = subArgs
  const { flags, positional } = parseFlags(rest)
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const paths = makeScenarioPaths(repoRoot)

  return yield* match(cmd)
    .with("list", () => Effect.succeed(handleList(paths)))
    .with("start", () => handleStart(paths, positional))
    .with("mark", () => Effect.succeed(handleMark(paths, positional)))
    .with("status", () => Effect.succeed(handleStatus(paths)))
    .with("end", () => Effect.succeed(handleEnd(paths, flags)))
    .with("eval", () => Effect.succeed(handleEval(paths, positional)))
    .otherwise(() =>
      Effect.succeed(failMsg(`unknown command '${cmd}' (list|start|mark|status|end|eval)`)),
    )
})
