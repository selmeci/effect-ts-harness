import { join } from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as Schema from "effect/Schema"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { type TelemetryCategory, type TelemetrySurface } from "@harness/gates/hook-fastpath"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import { toLazyImportError } from "./command-registry.js"
import {
  CLI_REPO_ROOT,
  type CliEnv,
  type CliResult,
  findWorkspaceRoot,
  isCommand,
  recordTelemetry,
  resolveCommandTelemetryOutcome,
  shouldSuppressLiveRepoTestSideEffects,
} from "./daemon-and-omnigraph.service.js"
import { runDeclarativeCli } from "./declarative-cli.js"
import {
  createHookStdinTracker,
  hasAntigravityFormat,
  normalizeProcessArgv,
  resolveTeardownFailure,
} from "./hook-format.js"

const decodeJsonRecord = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const isParsedAntigravityStdin = (rawStdin: string): boolean =>
  match(decodeJsonRecord(rawStdin))
    .with(
      { _tag: "Some" },
      ({ value }) =>
        (value["toolCall"] !== undefined && value["toolCall"] !== null) ||
        "fullyIdle" in value ||
        "workspacePaths" in value ||
        "conversationId" in value,
    )
    .with({ _tag: "None" }, () => false)
    .exhaustive()

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
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(
              `[harness:cli] Warning: failed to persist active-workspace.json: ${msg}\n`,
            )
          }),
        ),
      )
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
        try: () => import("./mutate-and-bench.command.js"),
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

export const runCliProgram = (argv: ReadonlyArray<string>, extraOptions?: CliEnv): void => {
  const hookStdinTracker = createHookStdinTracker()
  if (extraOptions?.stdin !== undefined && isParsedAntigravityStdin(extraOptions.stdin)) {
    hookStdinTracker.markAntigravityDetected()
  }
  runCliEffect(argv, { hookStdinTracker, ...extraOptions }).pipe(
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
          argv,
          undefined,
          hookStdinTracker.isAntigravityDetected(),
        ),
    }),
  )
}
