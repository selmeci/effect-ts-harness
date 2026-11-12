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

export const makeHarnessCommandRegistryLayer = (
  commands: ReadonlyArray<CliCommandPluginDescriptor>,
): Layer.Layer<HarnessCommandRegistry> => {
  const byName = new Map<string, CliCommandPluginDescriptor>()
  for (const cmd of commands) {
    byName.set(cmd.name, cmd)
  }
  return Layer.succeed(HarnessCommandRegistry, {
    listCommands: Effect.succeed(commands),
    resolveCommand: (name) => Effect.succeed(Option.fromUndefinedOr(byName.get(name))),
  })
}

export const DEFAULT_CLI_COMMAND_DESCRIPTORS: ReadonlyArray<CliCommandPluginDescriptor> = [
  {
    name: CliCommandName.make("guard"),
    summary: "Evaluate deterministic command and file-write guard policies.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "guard", stderr: "" }),
  },
  {
    name: CliCommandName.make("route"),
    summary: "Route a plan step to canonical agent-patterns/*.md documentation.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "route", stderr: "" }),
  },
  {
    name: CliCommandName.make("plan-check"),
    summary: "Validate compilable stub<A,E,R>() skeletons and snapshot plan/current.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "plan-check", stderr: "" }),
  },
  {
    name: CliCommandName.make("gc"),
    summary: "Run zero-entropy graph garbage collection and governance lint.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "gc", stderr: "" }),
  },
  {
    name: CliCommandName.make("verify"),
    summary: "Execute affected verify targets, check span budgets, and write verify-stamp.json.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "verify", stderr: "" }),
  },
  {
    name: CliCommandName.make("done"),
    summary: "Verify stamp freshness, diff plan vs impl graph, and merge impl/current to main.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "done", stderr: "" }),
  },
  {
    name: CliCommandName.make("learn"),
    summary: "Cluster friction-log.jsonl events and propose deterministic promotions.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "learn", stderr: "" }),
  },
  {
    name: CliCommandName.make("mutate"),
    summary: "Run in-process Mutant Schemata and saturation verification over domain code.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "mutate", stderr: "" }),
  },
  {
    name: CliCommandName.make("dst"),
    summary: "Run execution-guided deterministic simulation testing with ChaosLayer.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "dst", stderr: "" }),
  },
  {
    name: CliCommandName.make("bench"),
    summary: "Measure harness stage latencies and enforce p50/p95 SLO budgets.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "bench", stderr: "" }),
  },
  {
    name: CliCommandName.make("ontology"),
    summary: "Audit ArchiMate 3.2 cross-layer traceability and semantic conflicts.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "ontology", stderr: "" }),
  },
  {
    name: CliCommandName.make("rewrite"),
    summary: "Evaluate Double-Pushout (DPO) algebraic graph repair and planning rules.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "rewrite", stderr: "" }),
  },
  {
    name: CliCommandName.make("project"),
    summary: "Project graph deltas to TypeScript AST and verify shadow LSP overlays.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "project", stderr: "" }),
  },
  {
    name: CliCommandName.make("session"),
    summary: "Inspect active session handoff state and inject pending stubs.",
    execute: () => Effect.succeed({ exitCode: 0, stdout: "session", stderr: "" }),
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
