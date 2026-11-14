import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { LocalDecisionModel } from "@harness/decision"
import {
  buildSessionReport,
  readFrictionEvents,
  readTelemetryEvents,
  type TelemetryCategory,
  type TelemetryOutcome,
  type TelemetrySurface,
  writeSessionReportFiles,
} from "@harness/gates"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandName,
  CliCommandNotFoundError,
  type CliCommandPluginDescriptor,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
} from "./commands/command-registry.js"
import {
  buildOmnigraphClusterKillArgs,
  checkOllamaServerReady,
  cleanSubprocessError,
  CLI_REPO_ROOT,
  type CliEnv,
  type CliResult,
  COMMANDS,
  type Command,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  formatSubprocessError,
  isCommand,
  type OllamaReadinessOptions,
  recordTelemetry,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
} from "./commands/daemon-and-omnigraph.service.js"
import { handleIngest } from "./commands/session-learn-report.command.js"

export {
  buildOmnigraphClusterKillArgs,
  CANONICAL_CLI_COMMAND_NAMES,
  checkOllamaServerReady,
  cleanSubprocessError,
  CliCommandName,
  CliCommandNotFoundError,
  type CliCommandPluginDescriptor,
  type CliEnv,
  type CliResult,
  COMMANDS,
  type Command,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  formatSubprocessError,
  handleIngest,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  isCommand,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
  type OllamaReadinessOptions,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
}

export const runCliEffect = (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const requested = argv[0] ?? "help"
    const effectiveOptions =
      maybeDecisionLayer !== undefined ? { ...options, decisionLayer: maybeDecisionLayer } : options
    const decisionLayer = effectiveOptions?.decisionLayer ?? LocalDecisionModel
    const repoRoot = effectiveOptions?.repoRoot ?? findWorkspaceRoot()

    if (effectiveOptions?.repoRoot === undefined && process.env.VITEST === undefined) {
      yield* Effect.try(() => {
        const harnessDir = join(CLI_REPO_ROOT, ".harness")
        mkdirSync(harnessDir, { recursive: true })
        writeFileSync(
          join(harnessDir, "active-workspace.json"),
          JSON.stringify({ repoRoot, updatedAt: new Date().toISOString() }, null, 2),
        )
      }).pipe(Effect.ignore)
    }

    if (requested === "--help" || requested === "-h") {
      return {
        exitCode: 0,
        stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
        stderr: "",
      }
    }

    if ((argv.includes("--help") || argv.includes("-h")) && isCommand(requested)) {
      return {
        exitCode: 0,
        stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
        stderr: "",
      }
    }

    const liveCommandLayer = makeLiveCliCommandRegistryLayer(effectiveOptions, decisionLayer)
    const startTime = performance.now()
    const res: CliResult = yield* dispatchCliCommand({
      command: requested,
      args: argv,
    }).pipe(
      Effect.provide(liveCommandLayer),
      Effect.catchTag("CliCommandNotFoundError", (e) =>
        Effect.succeed<CliResult>({
          exitCode: 1,
          stdout: "",
          stderr: `unknown command: ${e.command}\nusage: harness <${COMMANDS.join("|")}>`,
        }),
      ),
    )
    const durationMs = Math.max(0, Math.round(performance.now() - startTime))

    const surface: TelemetrySurface =
      argv.includes("--format=antigravity") || effectiveOptions?.stdin !== undefined ? "hook" : "cli"

    const category: TelemetryCategory = match(requested)
      .with("guard", () => "guard" as const)
      .with("route", () => "routing" as const)
      .with("ontology", () => "ontology" as const)
      .with("plan-check", "verify", "gc", "mutate", "bench", () => "gate" as const)
      .otherwise(() => "lifecycle" as const)

    const outcome: TelemetryOutcome = match(requested)
      .with("guard", () => {
        if (res.exitCode !== 0 || res.stdout.includes('"decision":"deny"')) {
          return "deny" as const
        }
        if (
          res.stdout.includes('"decision":"ask"') ||
          res.stdout.includes('"permissionDecision":"ask"')
        ) {
          return "ask" as const
        }
        return "ok" as const
      })
      .with("done", () =>
        res.stdout.includes('"decision":"continue"') || res.stdout.includes('"decision":"block"')
          ? ("fail" as const)
          : ("ok" as const),
      )
      .with("route", () => (res.stdout === "review" ? ("fallback" as const) : ("ok" as const)))
      .otherwise(() => (res.exitCode === 0 ? ("ok" as const) : ("fail" as const)))

    recordTelemetry(options, {
      surface,
      category,
      toolName: requested === "ontology" ? `ontology:${argv[1] ?? "layers"}` : requested,
      outcome,
      durationMs,
      ...(res.telemetryDetail !== undefined ? { detail: res.telemetryDetail } : {}),
    })

    if (
      requested === "done" &&
      outcome === "ok" &&
      res.telemetryDetail !== "fullyIdle=false" &&
      res.telemetryDetail !== "subagent=true" &&
      res.telemetryDetail !== "readOnly=true" &&
      (options?.repoRoot !== undefined || process.env.VITEST === undefined)
    ) {
      const finalEvents = readTelemetryEvents(repoRoot)
      const finalFriction = readFrictionEvents(repoRoot)
      const finalReport = buildSessionReport({
        events: finalEvents,
        frictionEvents: finalFriction,
        stampValid: true,
      })
      writeSessionReportFiles(repoRoot, finalReport)
    }

    return res
  }).pipe(Effect.provideService(Logger.LogToStderr, true))

export const runCli = (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Promise<CliResult> => Effect.runPromise(runCliEffect(argv, options, maybeDecisionLayer))

export const run = (argv: ReadonlyArray<string>): number => {
  const requested = argv[0] ?? "help"
  if (!isCommand(requested)) {
    console.error(`unknown command: ${requested}`)
    console.error(`usage: harness <${COMMANDS.join("|")}>`)
    return 1
  }
  console.log(`harness ${requested}`)
  return 0
}

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("index.ts"))
) {
  void Effect.runPromise(runCliEffect(process.argv.slice(2)))
    .then((res) => {
      if (res.stdout) {
        process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : res.stdout + "\n")
      }
      if (res.stderr) {
        process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : res.stderr + "\n")
      }
      process.exit(res.exitCode)
    })
    .catch((err: unknown) => {
      console.error(String(err))
      process.exit(1)
    })
}
