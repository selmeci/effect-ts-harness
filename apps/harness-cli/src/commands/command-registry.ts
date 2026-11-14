import { Context, Effect, Layer, Option } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  CliCommandInput,
  CliCommandName,
  CliCommandNotFoundError,
} from "@harness/contract"
import { LocalDecisionModel } from "@harness/decision"
import {
  COMMANDS,
  type CliEnv,
  type CliResult,
} from "./daemon-and-omnigraph.service.js"
import { handleGc, handleOntology } from "./gc-and-ontology.command.js"
import { handleGuard, handleRoute } from "./guard-and-route.command.js"
import { handleBench, handleMutate } from "./mutate-and-bench.command.js"
import {
  handlePlanCheck,
  handlePlanSynth,
  handleRepair,
} from "./plan-and-repair.command.js"
import {
  runBenchmarkCompare,
  runCheckEventSchemas,
  runCheckMigrations,
  runCheckOpenApi,
} from "./repo-checks.command.js"
import { runScenarioCommand } from "./scenario.command.js"
import {
  handleDoctorOrSession,
  handleIngest,
  handleLearn,
  handleReport,
} from "./session-learn-report.command.js"
import { handleDone, handleVerify } from "./verify-and-done.command.js"

export { CliCommandInput, CliCommandName, CliCommandNotFoundError }

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

export const CANONICAL_CLI_COMMAND_NAMES = COMMANDS

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

export const makeLiveCliCommandDescriptors = (
  options?: CliEnv,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel> = LocalDecisionModel,
): ReadonlyArray<CliCommandPluginDescriptor> => [
  {
    name: CliCommandName.make("guard"),
    summary: "Evaluate deterministic command and file-write guard policies.",
    execute: (args) => handleGuard(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("route"),
    summary: "Route a plan step to canonical agent-patterns/*.md documentation.",
    execute: (args) => handleRoute(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("plan-check"),
    summary: "Validate compilable stub<A,E,R>() skeletons and snapshot plan/current.",
    execute: (args) => handlePlanCheck(args, options),
  },
  {
    name: CliCommandName.make("plan-synth"),
    summary: "Synthesize plan graph patches via Double-Pushout (DPO) rules.",
    execute: (args) => handlePlanSynth(args, options),
  },
  {
    name: CliCommandName.make("repair"),
    summary: "Repair architectural and code antipatterns via DPO rules.",
    execute: (args) => handleRepair(args, options),
  },
  {
    name: CliCommandName.make("verify"),
    summary: "Execute affected verify targets, check span budgets, and write verify-stamp.json.",
    execute: () => handleVerify(options, decisionLayer),
  },
  {
    name: CliCommandName.make("done"),
    summary: "Verify stamp freshness, diff plan vs impl graph, and merge impl/current to main.",
    execute: (args) => handleDone(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("learn"),
    summary: "Cluster friction-log.jsonl events and propose deterministic promotions.",
    execute: (args) => handleLearn(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("gc"),
    summary: "Run zero-entropy graph garbage collection and governance lint.",
    execute: (args) => handleGc(args, options),
  },
  {
    name: CliCommandName.make("mutate"),
    summary: "Run in-process Mutant Schemata and saturation verification over domain code.",
    execute: (args) => handleMutate(args, options),
  },
  {
    name: CliCommandName.make("bench"),
    summary: "Measure harness stage latencies and enforce p50/p95 SLO budgets.",
    execute: (args) => handleBench(args, options),
  },
  {
    name: CliCommandName.make("benchmark"),
    summary: "Compare canonical harness benchmark runs against acceptance criteria.",
    execute: (args) => runBenchmarkCompare(args, options),
  },
  {
    name: CliCommandName.make("ingest"),
    summary: "Ingest runtime trace NDJSON events into Omnigraph.",
    execute: (args) => handleIngest(args, options),
  },
  {
    name: CliCommandName.make("session"),
    summary: "Inspect active session handoff state and inject pending stubs.",
    execute: (args) => handleDoctorOrSession(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("doctor"),
    summary: "Run workspace health diagnostics and session recovery checks.",
    execute: (args) => handleDoctorOrSession(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("ontology"),
    summary: "Audit ArchiMate 3.2 cross-layer traceability and semantic conflicts.",
    execute: (args) => handleOntology(args, options, decisionLayer),
  },
  {
    name: CliCommandName.make("report"),
    summary: "Generate session telemetry and friction report.",
    execute: (args) => handleReport(args, options),
  },
  {
    name: CliCommandName.make("check-openapi"),
    summary: "Validate OpenAPI contract specifications.",
    execute: (args) => runCheckOpenApi(args, options),
  },
  {
    name: CliCommandName.make("check-migrations"),
    summary: "Validate database schema migrations for safety.",
    execute: (args) => runCheckMigrations(args, options),
  },
  {
    name: CliCommandName.make("check-event-schemas"),
    summary: "Validate event-sourcing schema evolution compatibility.",
    execute: (args) => runCheckEventSchemas(args, options),
  },
  {
    name: CliCommandName.make("scenario"),
    summary: "List or execute harness evaluation scenarios.",
    execute: (args) => runScenarioCommand(args, options),
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
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel> = LocalDecisionModel,
): Layer.Layer<HarnessCommandRegistry> =>
  makeHarnessCommandRegistryLayer(makeLiveCliCommandDescriptors(options, decisionLayer))

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
