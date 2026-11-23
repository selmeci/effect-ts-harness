import { Context, Effect, Layer, Option } from "effect"
import { match } from "ts-pattern"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandInput,
  CliCommandName,
  CliCommandNotFoundError,
} from "@harness/contract"
import { COMMANDS, type CliEnv, type CliResult } from "./daemon-and-omnigraph.service.js"
import { handleGuard, handleRoute } from "./guard-and-route.command.js"
import { tryFastPathIngest } from "./ingest-fastpath.js"
import { tryReadPreInvocationSessionCache } from "./session-fastpath.js"

export { CANONICAL_CLI_COMMAND_NAMES, CliCommandInput, CliCommandName, CliCommandNotFoundError }

export interface CliCommandPluginResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly telemetryDetail?: string | undefined
}

export interface CliCommandPluginDescriptor {
  readonly name: CliCommandName
  readonly summary: string
  readonly execute: (args: ReadonlyArray<string>) => Effect.Effect<CliCommandPluginResult>
}

export interface HarnessCommandRegistryShape {
  readonly listCommands: Effect.Effect<ReadonlyArray<CliCommandPluginDescriptor>>
  readonly resolveCommand: (
    name: string,
  ) => Effect.Effect<Option.Option<CliCommandPluginDescriptor>>
}

export class HarnessCommandRegistry extends Context.Service<
  HarnessCommandRegistry,
  HarnessCommandRegistryShape
>()("harness-cli/HarnessCommandRegistry") {}

export type CanonicalCliCommandName = (typeof CANONICAL_CLI_COMMAND_NAMES)[number]

export const makeHarnessCommandRegistryLayer = (
  commands: ReadonlyArray<CliCommandPluginDescriptor>,
): Layer.Layer<HarnessCommandRegistry> =>
  Layer.effect(
    HarnessCommandRegistry,
    Effect.gen(function* () {
      const commandMap = new Map<string, CliCommandPluginDescriptor>()
      for (const cmd of commands) {
        if (commandMap.has(cmd.name)) {
          return yield* Effect.die(new Error(`Duplicate CLI command registered: ${cmd.name}`))
        }
        commandMap.set(cmd.name, cmd)
      }
      return HarnessCommandRegistry.of({
        listCommands: Effect.succeed(commands),
        resolveCommand: (name) => Effect.succeed(Option.fromUndefinedOr(commandMap.get(name))),
      })
    }),
  )

export type CliCommandHandler = (args: ReadonlyArray<string>) => Effect.Effect<CliResult>

export interface LazyImportFailure {
  readonly _tag: "LazyImportFailure"
  readonly message: string
}

export const toLazyImportError = (err: unknown): LazyImportFailure => ({
  _tag: "LazyImportFailure",
  message: err instanceof Error ? err.message : String(err),
})

export const lazyImportCliHandler = <M>(
  commandName: string,
  load: () => Promise<M>,
  run: (mod: M) => Effect.Effect<CliResult>,
): Effect.Effect<CliResult> =>
  Effect.tryPromise({
    try: load,
    catch: toLazyImportError,
  }).pipe(
    Effect.flatMap(run),
    Effect.catch((err) => {
      const msg = `Failed to load CLI command '${commandName}': ${err.message}`
      return Effect.succeed({
        exitCode: 1,
        stdout: JSON.stringify({ error: msg }),
        stderr: `${msg}\n`,
      })
    }),
  )

export const makeLiveCliCommandDescriptors = (
  options?: CliEnv,
): ReadonlyArray<CliCommandPluginDescriptor> => [
  {
    name: CliCommandName.make("guard"),
    summary: "Evaluate deterministic command and file-write guard policies.",
    execute: (args) => handleGuard(args, options),
  },
  {
    name: CliCommandName.make("route"),
    summary: "Route a plan step to canonical agent-patterns/*.md documentation.",
    execute: (args) => handleRoute(args, options),
  },
  {
    name: CliCommandName.make("plan-check"),
    summary: "Validate compilable stub<A,E,R>() skeletons and snapshot plan/current.",
    execute: (args) =>
      lazyImportCliHandler(
        "plan-check",
        () => import("./plan-and-repair.command.js"),
        (m) => m.handlePlanCheck(args, options),
      ),
  },
  {
    name: CliCommandName.make("plan-synth"),
    summary: "Synthesize plan graph patches via Double-Pushout (DPO) rules.",
    execute: (args) =>
      lazyImportCliHandler(
        "plan-synth",
        () => import("./plan-and-repair.command.js"),
        (m) => m.handlePlanSynth(args, options),
      ),
  },
  {
    name: CliCommandName.make("repair"),
    summary: "Repair architectural and code antipatterns via DPO rules.",
    execute: (args) =>
      lazyImportCliHandler(
        "repair",
        () => import("./plan-and-repair.command.js"),
        (m) => m.handleRepair(args, options),
      ),
  },
  {
    name: CliCommandName.make("verify"),
    summary: "Execute affected verify targets, check span budgets, and write verify-stamp.json.",
    execute: () =>
      lazyImportCliHandler(
        "verify",
        () => import("./verify-and-done.command.js"),
        (m) => m.handleVerify(options),
      ),
  },
  {
    name: CliCommandName.make("done"),
    summary: "Verify stamp freshness, diff plan vs impl graph, and merge impl/current to main.",
    execute: (args) =>
      lazyImportCliHandler(
        "done",
        () => import("./verify-and-done.command.js"),
        (m) => m.handleDone(args, options),
      ),
  },
  {
    name: CliCommandName.make("learn"),
    summary: "Cluster friction-log.jsonl events and propose deterministic promotions.",
    execute: (args) =>
      lazyImportCliHandler(
        "learn",
        () => import("./session-learn-report.command.js"),
        (m) => m.handleLearn(args, options),
      ),
  },
  {
    name: CliCommandName.make("gc"),
    summary: "Run zero-entropy graph garbage collection and governance lint.",
    execute: (args) =>
      lazyImportCliHandler(
        "gc",
        () => import("./gc-and-ontology.command.js"),
        (m) => m.handleGc(args, options),
      ),
  },
  {
    name: CliCommandName.make("mutate"),
    summary: "Run in-process Mutant Schemata and saturation verification over domain code.",
    execute: (args) =>
      lazyImportCliHandler(
        "mutate",
        () => import("./mutate-and-bench.command.js"),
        (m) => m.handleMutate(args, options),
      ),
  },
  {
    name: CliCommandName.make("bench"),
    summary: "Measure harness stage latencies and enforce p50/p95 SLO budgets.",
    execute: (args) =>
      lazyImportCliHandler(
        "bench",
        () => import("./mutate-and-bench.command.js"),
        (m) => m.handleBench(args, options),
      ),
  },
  {
    name: CliCommandName.make("benchmark"),
    summary: "Compare canonical harness benchmark runs against acceptance criteria.",
    execute: (args) =>
      lazyImportCliHandler(
        "benchmark",
        () => import("./repo-checks.command.js"),
        (m) => m.runBenchmarkCompare(args, options),
      ),
  },
  {
    name: CliCommandName.make("ingest"),
    summary: "Ingest runtime trace NDJSON events into Omnigraph.",
    execute: (args) =>
      match(tryFastPathIngest(args, options))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          lazyImportCliHandler(
            "ingest",
            () => import("./session-learn-report.command.js"),
            (m) => m.handleIngest(args, options),
          ),
        )
        .exhaustive(),
  },
  {
    name: CliCommandName.make("session"),
    summary: "Inspect active session handoff state and inject pending stubs.",
    execute: (args) =>
      match(tryReadPreInvocationSessionCache(args, options))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          lazyImportCliHandler(
            "session",
            () => import("./session-learn-report.command.js"),
            (m) => m.handleDoctorOrSession(args, options),
          ),
        )
        .exhaustive(),
  },
  {
    name: CliCommandName.make("doctor"),
    summary: "Run workspace health diagnostics and session recovery checks.",
    execute: (args) =>
      lazyImportCliHandler(
        "doctor",
        () => import("./session-learn-report.command.js"),
        (m) => m.handleDoctorOrSession(args, options),
      ),
  },
  {
    name: CliCommandName.make("ontology"),
    summary: "Audit ArchiMate 3.2 cross-layer traceability and semantic conflicts.",
    execute: (args) =>
      lazyImportCliHandler(
        "ontology",
        () => import("./gc-and-ontology.command.js"),
        (m) => m.handleOntology(args, options),
      ),
  },
  {
    name: CliCommandName.make("report"),
    summary: "Generate session telemetry and friction report.",
    execute: (args) =>
      lazyImportCliHandler(
        "report",
        () => import("./session-learn-report.command.js"),
        (m) => m.handleReport(args, options),
      ),
  },
  {
    name: CliCommandName.make("check-openapi"),
    summary: "Validate OpenAPI contract specifications.",
    execute: (args) =>
      lazyImportCliHandler(
        "check-openapi",
        () => import("./repo-checks.command.js"),
        (m) => m.runCheckOpenApi(args, options),
      ),
  },
  {
    name: CliCommandName.make("check-migrations"),
    summary: "Validate database schema migrations for safety.",
    execute: (args) =>
      lazyImportCliHandler(
        "check-migrations",
        () => import("./repo-checks.command.js"),
        (m) => m.runCheckMigrations(args, options),
      ),
  },
  {
    name: CliCommandName.make("check-event-schemas"),
    summary: "Validate event-sourcing schema evolution compatibility.",
    execute: (args) =>
      lazyImportCliHandler(
        "check-event-schemas",
        () => import("./repo-checks.command.js"),
        (m) => m.runCheckEventSchemas(args, options),
      ),
  },
  {
    name: CliCommandName.make("scenario"),
    summary: "List or execute harness evaluation scenarios.",
    execute: (args) =>
      lazyImportCliHandler(
        "scenario",
        () => import("./scenario.command.js"),
        (m) => m.runScenarioCommand(args, options),
      ),
  },
  {
    name: CliCommandName.make("workflow"),
    summary: "Compile, run, inspect, complete, and recover durable HarnessTaskWorkflow runs.",
    execute: (args) =>
      lazyImportCliHandler(
        "workflow",
        () => import("./workflow.command.js"),
        (m) => m.handleWorkflow(args, options),
      ),
  },
  {
    name: CliCommandName.make("help"),
    summary: "Display CLI usage help and available commands.",
    execute: () =>
      Effect.succeed({
        exitCode: 0,
        stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
        stderr: "",
      }),
  },
]

export const DEFAULT_CLI_COMMAND_DESCRIPTORS: ReadonlyArray<CliCommandPluginDescriptor> =
  makeLiveCliCommandDescriptors()

export const makeLiveCliCommandRegistryLayer = (
  options?: CliEnv,
): Layer.Layer<HarnessCommandRegistry> =>
  makeHarnessCommandRegistryLayer(makeLiveCliCommandDescriptors(options))

export const HarnessCommandRegistryLive: Layer.Layer<HarnessCommandRegistry> =
  makeHarnessCommandRegistryLayer(DEFAULT_CLI_COMMAND_DESCRIPTORS)

export interface DispatchCliCommandInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export const dispatchCliCommand = Effect.fn("HarnessCli.dispatchCommand")(function* (
  input: DispatchCliCommandInput,
): Effect.fn.Return<CliCommandPluginResult, CliCommandNotFoundError, HarnessCommandRegistry> {
  const registry = yield* HarnessCommandRegistry
  const resolved = yield* registry.resolveCommand(input.command)
  return yield* match(resolved)
    .with({ _tag: "Some" }, ({ value }) => value.execute(input.args))
    .with({ _tag: "None" }, () =>
      Effect.gen(function* () {
        const cmds = yield* registry.listCommands
        return yield* new CliCommandNotFoundError({
          command: CliCommandInput.make(input.command),
          availableCommands: cmds.map((c) => c.name),
        })
      }),
    )
    .exhaustive()
})
