import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { type TelemetryCategory, type TelemetrySurface } from "@harness/gates/hook-fastpath"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandName,
  CliCommandNotFoundError,
  type CliCommandPluginDescriptor,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  lazyImportCliHandler,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
  toLazyImportError,
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
  resolveCommandTelemetryOutcome,
  shouldSuppressLiveRepoTestSideEffects,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
} from "./commands/daemon-and-omnigraph.service.js"
import { harnessRootCommand, runDeclarativeCli } from "./commands/declarative-cli.js"
import {
  createHookStdinTracker,
  hasAntigravityFormat,
  normalizeProcessArgv,
  resolveTeardownFailure,
} from "./commands/hook-format.js"

export const handleIngest = (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.Effect<CliResult> =>
  lazyImportCliHandler(
    "ingest",
    () => import("./commands/session-learn-report.command.js"),
    (m) => m.handleIngest(args, options),
  )

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
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  harnessRootCommand,
  isCommand,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
  type OllamaReadinessOptions,
  resolveCommandTelemetryOutcome,
  runDeclarativeCli,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
}

export const teardownCliMain = (
  exit: Exit.Exit<unknown, unknown>,
  onExit: (code: number) => void,
  writeStderr: (s: string) => void = (s) => {
    process.stderr.write(s)
  },
  argv: ReadonlyArray<string> = process.argv,
  writeStdout: (s: string) => void = (s) => {
    process.stdout.write(s)
  },
  isAntigravityStdinDetected = false,
): void => {
  match(exit)
    .with({ _tag: "Success" }, () => {
      const code = typeof process.exitCode === "number" ? process.exitCode : 0
      onExit(code)
    })
    .with({ _tag: "Failure" }, ({ cause }) => {
      const isInt = isPureInterruptCause(cause)
      const out = resolveTeardownFailure(
        normalizeProcessArgv(argv, isCommand),
        isInt,
        isInt ? "interrupted by signal" : Cause.pretty(cause),
        isAntigravityStdinDetected,
      )
      if (out.stderr) writeStderr(out.stderr)
      if (out.stdout) writeStdout(out.stdout)
      process.exitCode = out.exitCode
      onExit(out.exitCode)
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
      effectiveOptions?.skipBackgroundDaemons !== true &&
      !shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT)
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
      hasAntigravityFormat(argv) || effectiveOptions?.stdin !== undefined ? "hook" : "cli"

    const category: TelemetryCategory = match(requested)
      .with("guard", () => "guard" as const)
      .with("route", () => "routing" as const)
      .with("ontology", () => "ontology" as const)
      .with("plan-check", "verify", "gc", "mutate", "bench", "benchmark", () => "gate" as const)
      .otherwise(() => "lifecycle" as const)

    const outcome = resolveCommandTelemetryOutcome(requested, res)

    yield* Effect.try(() => {
      recordTelemetry(options, {
        surface,
        category,
        toolName: requested === "ontology" ? `ontology:${argv[1] ?? "layers"}` : requested,
        outcome,
        durationMs,
        ...(res.telemetryDetail !== undefined ? { detail: res.telemetryDetail } : {}),
      })
    }).pipe(Effect.ignore)

    if (
      requested === "done" &&
      outcome === "ok" &&
      res.telemetryDetail !== "fullyIdle=false" &&
      res.telemetryDetail !== "subagent=true" &&
      res.telemetryDetail !== "readOnly=true" &&
      (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true) &&
      !shouldSuppressLiveRepoTestSideEffects(repoRoot)
    ) {
      yield* Effect.tryPromise({
        try: () => import("./commands/mutate-and-bench.command.js"),
        catch: toLazyImportError,
      }).pipe(
        Effect.flatMap((m) =>
          Effect.try({ try: () => m.writeDoneSessionReport(repoRoot), catch: toLazyImportError }),
        ),
        Effect.catch((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `[harness:done] Warning: failed to write session report: ${err.message}\n`,
            )
          }),
        ),
      )
    }

    return res
  }).pipe(Effect.provideService(Logger.LogToStderr, true))

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("index.ts"))
) {
  const hookStdinTracker = createHookStdinTracker()
  runCliEffect(process.argv.slice(2), { hookStdinTracker }).pipe(
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
      teardown: (exit, onExit) =>
        teardownCliMain(
          exit,
          onExit,
          undefined,
          process.argv,
          undefined,
          hookStdinTracker.isAntigravityDetected(),
        ),
    }),
  )
}
