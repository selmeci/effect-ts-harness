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
import {
  activeScenariosDir,
  extractStepGuide,
  hideScenariosFromWorkspace,
  listScenarios,
  makeScenarioPaths,
  resolveStateDir,
  restoreScenariosToWorkspace,
  type ScenarioPaths,
} from "./scenario-fs.js"

const CLEF_BUDGET_MS = 1500
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

const isValidSafeSegment = (value: string): boolean =>
  SAFE_SEGMENT_RE.test(value) && value !== "." && value !== ".."

const parseFlags = (
  argv: ReadonlyArray<string>,
): { readonly flags: ScenarioFlags; readonly positional: ReadonlyArray<string> } => {
  let conversation: string | undefined
  let transcript: string | undefined
  let filter: string | undefined
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
        } else {
          if (key === "filter") {
            filter = val
          }
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags: { conversation, transcript, filter }, positional }
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

const handleList = (paths: ScenarioPaths, flags: ScenarioFlags): CliResult => {
  if (!nodeSyncHostIo.existsSync(paths.currentPointer)) {
    restoreScenariosToWorkspace(paths)
  }
  const root = activeScenariosDir(paths)
  const filterLower = flags.filter?.trim().toLowerCase()
  const lines = listScenarios(paths)
    .map((id) => {
      const exp = readExpectations(join(root, id, "expectations.json"))
      return { id, title: exp?.title ?? "" }
    })
    .filter(({ id, title }) =>
      filterLower === undefined || filterLower.length === 0
        ? true
        : id.toLowerCase().includes(filterLower) || title.toLowerCase().includes(filterLower),
    )
    .map(({ id, title }) => `${id.padEnd(32)} ${title}`)
  return {
    exitCode: 0,
    stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    stderr: "",
  }
}

const handleStart = (
  paths: ScenarioPaths,
  positional: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const id = positional[0]
    if (id === undefined || id.length === 0) {
      return failMsg("usage: pnpm scenario start <id>")
    }
    if (!isValidSafeSegment(id)) {
      return failMsg(`Invalid scenario id '${id}'. Must match /^[A-Za-z0-9._-]+$/.`)
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
    const promptFile = join(dir, "prompt.md")
    if (!nodeSyncHostIo.existsSync(promptFile)) {
      return failMsg(`Missing prompt.md in ${dir}`)
    }
    const openingPrompt = nodeSyncHostIo.readTextSync(promptFile).trim()
    const clefModel = process.env.HARNESS_CLEF_MODEL ?? "clef-flash"
    const preflight: ScenarioPreflight =
      options?.skipBackgroundDaemons === true
        ? { clefModel: false, detail: `${clefModel}: skipped in test mode` }
        : yield* preflightClef(clefModel)

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

    const startedAt = new Date().toISOString()
    const runDir = join(paths.runsDir, `${startedAt.replace(/[:.]/g, "-")}_${id}`)
    nodeSyncHostIo.mkdirRecursiveSync(runDir)
    const stateDir = resolveStateDir(paths.repoRoot)
    saveRun(runDir, { scenario: id, startedAt, stateDir, preflight, marks: [] })
    nodeSyncHostIo.writeTextSync(paths.currentPointer, JSON.stringify({ runDir }))

    const hideExit = yield* Effect.exit(
      Effect.sync(() => hideScenariosFromWorkspace(paths)).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            restoreScenariosToWorkspace(paths)
            nodeSyncHostIo.rmRecursiveSync(paths.currentPointer)
          }),
        ),
      ),
    )
    const hideFailed = match(hideExit)
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ cause }) => {
        restoreScenariosToWorkspace(paths)
        nodeSyncHostIo.rmRecursiveSync(paths.currentPointer)
        return failMsg(`Failed to stash scenarios: ${String(cause)}`)
      })
      .exhaustive()
    if (hideFailed !== undefined) {
      return hideFailed
    }

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

const handleEnd = (paths: ScenarioPaths, flags: ScenarioFlags): Effect.Effect<CliResult> =>
  Effect.sync((): CliResult => {
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
  }).pipe(Effect.ensuring(Effect.sync(() => restoreScenariosToWorkspace(paths))))

const handleEval = (paths: ScenarioPaths, positional: ReadonlyArray<string>): CliResult => {
  const runDir =
    positional[0] !== undefined && positional[0].length > 0
      ? resolve(paths.repoRoot, positional[0])
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
  if (flags.conversation !== undefined && !isValidSafeSegment(flags.conversation)) {
    return failMsg(
      `Invalid conversation id '${flags.conversation}'. Must match /^[A-Za-z0-9._-]+$/.`,
    )
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const paths = makeScenarioPaths(repoRoot)

  return yield* match(cmd)
    .with("list", () => Effect.succeed(handleList(paths, flags)))
    .with("start", () => handleStart(paths, positional, options))
    .with("mark", () => Effect.succeed(handleMark(paths, positional)))
    .with("status", () => Effect.succeed(handleStatus(paths)))
    .with("end", () => handleEnd(paths, flags))
    .with("eval", () => Effect.succeed(handleEval(paths, positional)))
    .otherwise(() =>
      Effect.succeed(failMsg(`unknown command '${cmd}' (list|start|mark|status|end|eval)`)),
    )
})
