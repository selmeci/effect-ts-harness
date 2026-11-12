import { Context, Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"

export const CliCommandName = Schema.NonEmptyString.pipe(Schema.brand("CliCommandName"))
export type CliCommandName = typeof CliCommandName.Type

export const CliCommandInput = Schema.String.pipe(Schema.brand("CliCommandInput"))
export type CliCommandInput = typeof CliCommandInput.Type

export class CliCommandNotFoundError extends Schema.TaggedError<CliCommandNotFoundError>()(
  "CliCommandNotFoundError",
  {
    command: CliCommandInput,
    availableCommands: Schema.Array(CliCommandName),
  },
) {}

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

export const CANONICAL_CLI_COMMAND_NAMES = [
  "guard",
  "route",
  "plan-check",
  "plan-synth",
  "repair",
  "verify",
  "done",
  "learn",
  "gc",
  "mutate",
  "bench",
  "ingest",
  "session",
  "doctor",
  "ontology",
  "report",
  "help",
] as const

export type CanonicalCliCommandName = (typeof CANONICAL_CLI_COMMAND_NAMES)[number]

export const makeHarnessCommandRegistryLayer = (
  commands: ReadonlyArray<CliCommandPluginDescriptor>,
): Layer.Layer<HarnessCommandRegistry> => {
  const byName = new Map<string, CliCommandPluginDescriptor>()
  for (const cmd of commands) {
    if (byName.has(cmd.name)) {
      Effect.runSync(Effect.die(new Error(`Duplicate CLI command registered: ${cmd.name}`)))
    }
    byName.set(cmd.name, cmd)
  }
  return Layer.succeed(HarnessCommandRegistry, {
    listCommands: Effect.succeed(commands),
    resolveCommand: (name) => Effect.succeed(Option.fromUndefinedOr(byName.get(name))),
  })
}

export type CliCommandHandler = (args: ReadonlyArray<string>) => Effect.Effect<CliCommandPluginResult>

const liveCommandHandlers = new Map<string, CliCommandHandler>()

export const registerLiveCliCommandHandlers = (
  handlers:
    | Record<string, CliCommandHandler>
    | ReadonlyMap<string, CliCommandHandler>
    | ReadonlyArray<CliCommandPluginDescriptor>,
): void => {
  if (Array.isArray(handlers)) {
    for (const h of handlers) {
      liveCommandHandlers.set(h.name, h.execute)
    }
  } else if (handlers instanceof Map) {
    for (const [name, handler] of handlers.entries()) {
      liveCommandHandlers.set(name, handler)
    }
  } else {
    for (const [name, handler] of Object.entries(handlers)) {
      liveCommandHandlers.set(name, handler)
    }
  }
}

const makeDefaultExecute =
  (cmdName: string): ((args: ReadonlyArray<string>) => Effect.Effect<CliCommandPluginResult>) =>
  (args) => {
    const liveHandler = liveCommandHandlers.get(cmdName)
    if (liveHandler !== undefined) {
      return liveHandler(args)
    }
    return Effect.succeed({
      exitCode: 1,
      stdout: "",
      stderr: `Command '${cmdName}' must be executed through makeLiveCliCommandRegistryLayer.`,
    })
  }

export const DEFAULT_CLI_COMMAND_DESCRIPTORS: ReadonlyArray<CliCommandPluginDescriptor> = [
  {
    name: CliCommandName.make("guard"),
    summary: "Evaluate deterministic command and file-write guard policies.",
    execute: makeDefaultExecute("guard"),
  },
  {
    name: CliCommandName.make("route"),
    summary: "Route a plan step to canonical agent-patterns/*.md documentation.",
    execute: makeDefaultExecute("route"),
  },
  {
    name: CliCommandName.make("plan-check"),
    summary: "Validate compilable stub<A,E,R>() skeletons and snapshot plan/current.",
    execute: makeDefaultExecute("plan-check"),
  },
  {
    name: CliCommandName.make("plan-synth"),
    summary: "Synthesize plan graph patches via Double-Pushout (DPO) rules.",
    execute: makeDefaultExecute("plan-synth"),
  },
  {
    name: CliCommandName.make("repair"),
    summary: "Repair architectural and code antipatterns via DPO rules.",
    execute: makeDefaultExecute("repair"),
  },
  {
    name: CliCommandName.make("verify"),
    summary: "Execute affected verify targets, check span budgets, and write verify-stamp.json.",
    execute: makeDefaultExecute("verify"),
  },
  {
    name: CliCommandName.make("done"),
    summary: "Verify stamp freshness, diff plan vs impl graph, and merge impl/current to main.",
    execute: makeDefaultExecute("done"),
  },
  {
    name: CliCommandName.make("learn"),
    summary: "Cluster friction-log.jsonl events and propose deterministic promotions.",
    execute: makeDefaultExecute("learn"),
  },
  {
    name: CliCommandName.make("gc"),
    summary: "Run zero-entropy graph garbage collection and governance lint.",
    execute: makeDefaultExecute("gc"),
  },
  {
    name: CliCommandName.make("mutate"),
    summary: "Run in-process Mutant Schemata and saturation verification over domain code.",
    execute: makeDefaultExecute("mutate"),
  },
  {
    name: CliCommandName.make("bench"),
    summary: "Measure harness stage latencies and enforce p50/p95 SLO budgets.",
    execute: makeDefaultExecute("bench"),
  },
  {
    name: CliCommandName.make("ingest"),
    summary: "Ingest runtime trace NDJSON events into Omnigraph.",
    execute: makeDefaultExecute("ingest"),
  },
  {
    name: CliCommandName.make("session"),
    summary: "Inspect active session handoff state and inject pending stubs.",
    execute: makeDefaultExecute("session"),
  },
  {
    name: CliCommandName.make("doctor"),
    summary: "Run workspace health diagnostics and session recovery checks.",
    execute: makeDefaultExecute("doctor"),
  },
  {
    name: CliCommandName.make("ontology"),
    summary: "Audit ArchiMate 3.2 cross-layer traceability and semantic conflicts.",
    execute: makeDefaultExecute("ontology"),
  },
  {
    name: CliCommandName.make("report"),
    summary: "Generate session telemetry and friction report.",
    execute: makeDefaultExecute("report"),
  },
  {
    name: CliCommandName.make("help"),
    summary: "Display CLI usage help and available commands.",
    execute: makeDefaultExecute("help"),
  },
]

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
