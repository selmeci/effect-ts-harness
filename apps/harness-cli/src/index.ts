import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"
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
import { harnessRootCommand, runDeclarativeCli } from "./commands/declarative-cli.js"
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
  harnessRootCommand,
  isCommand,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
  type OllamaReadinessOptions,
  runDeclarativeCli,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
}

export const resolveCommandTelemetryOutcome = (
  command: string,
  res: CliResult,
): TelemetryOutcome =>
  match(command)
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
      res.exitCode !== 0 ||
      res.stdout.includes('"decision":"continue"') ||
      res.stdout.includes('"decision":"block"')
        ? ("fail" as const)
        : ("ok" as const),
    )
    .with("route", () => (res.stdout === "review" ? ("fallback" as const) : ("ok" as const)))
    .otherwise(() => (res.exitCode === 0 ? ("ok" as const) : ("fail" as const)))

export const teardownCliMain = (
  exit: Exit.Exit<unknown, unknown>,
  onExit: (code: number) => void,
  writeStderr: (s: string) => void = (s) => {
    process.stderr.write(s)
  },
): void => {
  match(exit)
    .with({ _tag: "Success" }, () => {
      onExit(0)
    })
    .with({ _tag: "Failure" }, ({ cause }) => {
      if (Cause.hasFails(cause) || Cause.hasDies(cause)) {
        writeStderr(`${Cause.pretty(cause)}\n`)
      }
      process.exitCode = 1
      onExit(0)
    })
    .exhaustive()
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
    const repoRoot = effectiveOptions?.repoRoot ?? findWorkspaceRoot()

    if (
      effectiveOptions?.repoRoot === undefined &&
      effectiveOptions?.skipBackgroundDaemons !== true
    ) {
      yield* Effect.try(() => {
        const harnessDir = join(CLI_REPO_ROOT, ".harness")
        nodeSyncHostIo.mkdirRecursiveSync(harnessDir)
        nodeSyncHostIo.writeTextSync(
          join(harnessDir, "active-workspace.json"),
          JSON.stringify({ repoRoot, updatedAt: new Date().toISOString() }, null, 2),
        )
      }).pipe(Effect.ignore)
    }

    const startTime = performance.now()
    const res: CliResult = yield* runDeclarativeCli(argv, effectiveOptions, maybeDecisionLayer)
    const durationMs = Math.max(0, Math.round(performance.now() - startTime))

    const surface: TelemetrySurface =
      argv.includes("--format=antigravity") || effectiveOptions?.stdin !== undefined ? "hook" : "cli"

    const category: TelemetryCategory = match(requested)
      .with("guard", () => "guard" as const)
      .with("route", () => "routing" as const)
      .with("ontology", () => "ontology" as const)
      .with("plan-check", "verify", "gc", "mutate", "bench", "benchmark", () => "gate" as const)
      .otherwise(() => "lifecycle" as const)

    const outcome = resolveCommandTelemetryOutcome(requested, res)

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
      (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true)
    ) {
      const finalEvents = readTelemetryEvents(repoRoot, nodeSyncHostIo)
      const finalFriction = readFrictionEvents(repoRoot, nodeSyncHostIo)
      const finalReport = buildSessionReport({
        events: finalEvents,
        frictionEvents: finalFriction,
        stampValid: true,
      })
      writeSessionReportFiles(repoRoot, finalReport, nodeSyncHostIo)
    }

    return res
  }).pipe(Effect.provideService(Logger.LogToStderr, true))

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("index.ts"))
) {
  runCliEffect(process.argv.slice(2)).pipe(
    Effect.tap((res) =>
      Effect.sync(() => {
        if (res.stdout) {
          process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`)
        }
        if (res.stderr) {
          process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`)
        }
        process.exitCode = res.exitCode
      }),
    ),
    NodeRuntime.runMain({
      disableErrorReporting: true,
      teardown: (exit, onExit) => teardownCliMain(exit, onExit),
    }),
  )
}
