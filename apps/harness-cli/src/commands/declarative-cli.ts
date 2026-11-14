import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option, Ref } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { Argument, Command as CliCommand, Flag } from "effect/cli"
import { match } from "ts-pattern"
import { LocalDecisionModel } from "@harness/decision"
import { HarnessInfraLive } from "@harness/infra"
import {
  dispatchCliCommand,
  HarnessCommandRegistry,
  makeLiveCliCommandRegistryLayer,
} from "./command-registry.js"
import {
  COMMANDS,
  type CliEnv,
  type CliResult,
  isCommand,
} from "./daemon-and-omnigraph.service.js"

const variadicArgs = Argument.String("args").pipe(Argument.variadic())
const boolFlag = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false))

const appendStringFlag = (
  out: Array<string>,
  flagName: string,
  opt: Option.Option<string>,
): void => {
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => {
      out.push(`--${flagName}=${value}`)
    })
    .with({ _tag: "None" }, () => {})
    .exhaustive()
}

const appendNumberFlag = (
  out: Array<string>,
  flagName: string,
  opt: Option.Option<number>,
): void => {
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => {
      out.push(`--${flagName}=${value}`)
    })
    .with({ _tag: "None" }, () => {})
    .exhaustive()
}

const appendBoolFlag = (out: Array<string>, flagName: string, enabled: boolean): void => {
  if (enabled) {
    out.push(`--${flagName}`)
  }
}

export const makeHarnessRootCommand = (
  onResult: (result: CliResult) => Effect.Effect<void>,
) => {
  const runSubcommand = (
    name: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<void, never, HarnessCommandRegistry> =>
    Effect.gen(function* () {
      const res = yield* dispatchCliCommand({
        command: name,
        args: [name, ...args],
      }).pipe(
        Effect.catchTag("CliCommandNotFoundError", (e) =>
          Effect.succeed<CliResult>({
            exitCode: 1,
            stdout: "",
            stderr: `unknown command: ${e.command}\nusage: harness <${COMMANDS.join("|")}>`,
          }),
        ),
      )
      yield* onResult(res)
    })

  const guardCommand = CliCommand.make(
    "guard",
    {
      format: Flag.optional(Flag.String("format")),
      file: Flag.optional(Flag.String("file")),
      args: variadicArgs,
    },
    ({ format, file, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      appendStringFlag(raw, "file", file)
      return runSubcommand("guard", raw)
    },
  )

  const routeCommand = CliCommand.make(
    "route",
    {
      format: Flag.optional(Flag.String("format")),
      args: variadicArgs,
    },
    ({ format, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      return runSubcommand("route", raw)
    },
  )

  const planCheckCommand = CliCommand.make(
    "plan-check",
    {
      graphOnly: boolFlag("graph-only"),
      verify: boolFlag("verify"),
      args: variadicArgs,
    },
    ({ graphOnly, verify, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "graph-only", graphOnly)
      appendBoolFlag(raw, "verify", verify)
      return runSubcommand("plan-check", raw)
    },
  )

  const planSynthCommand = CliCommand.make(
    "plan-synth",
    {
      write: boolFlag("write"),
      verify: boolFlag("verify"),
      args: variadicArgs,
    },
    ({ write, verify, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "write", write)
      appendBoolFlag(raw, "verify", verify)
      return runSubcommand("plan-synth", raw)
    },
  )

  const repairCommand = CliCommand.make(
    "repair",
    {
      rule: Flag.optional(Flag.String("rule")),
      write: boolFlag("write"),
      verify: boolFlag("verify"),
      args: variadicArgs,
    },
    ({ rule, write, verify, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "rule", rule)
      appendBoolFlag(raw, "write", write)
      appendBoolFlag(raw, "verify", verify)
      return runSubcommand("repair", raw)
    },
  )

  const verifyCommand = CliCommand.make(
    "verify",
    {
      format: Flag.optional(Flag.String("format")),
      args: variadicArgs,
    },
    ({ format, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      return runSubcommand("verify", raw)
    },
  )

  const doneCommand = CliCommand.make(
    "done",
    {
      format: Flag.optional(Flag.String("format")),
      args: variadicArgs,
    },
    ({ format, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      return runSubcommand("done", raw)
    },
  )

  const learnCommand = CliCommand.make(
    "learn",
    {
      clear: boolFlag("clear"),
      reset: boolFlag("reset"),
      deterministic: boolFlag("deterministic"),
      args: variadicArgs,
    },
    ({ clear, reset, deterministic, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "clear", clear)
      appendBoolFlag(raw, "reset", reset)
      appendBoolFlag(raw, "deterministic", deterministic)
      return runSubcommand("learn", raw)
    },
  )

  const gcCommand = CliCommand.make(
    "gc",
    {
      strict: boolFlag("strict"),
      args: variadicArgs,
    },
    ({ strict, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "strict", strict)
      return runSubcommand("gc", raw)
    },
  )

  const mutateCommand = CliCommand.make(
    "mutate",
    {
      scope: Flag.optional(Flag.String("scope")),
      strict: boolFlag("strict"),
      args: variadicArgs,
    },
    ({ scope, strict, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "scope", scope)
      appendBoolFlag(raw, "strict", strict)
      return runSubcommand("mutate", raw)
    },
  )

  const makeBenchSubcommand = (name: "bench" | "benchmark") =>
    CliCommand.make(
      name,
      {
        iterations: Flag.optional(Flag.Int("iterations")),
        budgetMs: Flag.optional(Flag.Finite("budget-ms")),
        compare: boolFlag("compare"),
        baseline: Flag.optional(Flag.String("baseline")),
        out: Flag.optional(Flag.String("out")),
        args: variadicArgs,
      },
      ({ iterations, budgetMs, compare, baseline, out, args }) => {
        const raw: Array<string> = [...args]
        appendNumberFlag(raw, "iterations", iterations)
        appendNumberFlag(raw, "budget-ms", budgetMs)
        appendBoolFlag(raw, "compare", compare)
        appendStringFlag(raw, "baseline", baseline)
        appendStringFlag(raw, "out", out)
        return runSubcommand(name, raw)
      },
    )

  const ingestCommand = CliCommand.make(
    "ingest",
    {
      format: Flag.optional(Flag.String("format")),
      args: variadicArgs,
    },
    ({ format, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      return runSubcommand("ingest", raw)
    },
  )

  const makeSessionSubcommand = (name: "session" | "doctor") =>
    CliCommand.make(
      name,
      {
        format: Flag.optional(Flag.String("format")),
        args: variadicArgs,
      },
      ({ format, args }) => {
        const raw: Array<string> = [...args]
        appendStringFlag(raw, "format", format)
        return runSubcommand(name, raw)
      },
    )

  const ontologyCommand = CliCommand.make(
    "ontology",
    {
      format: Flag.optional(Flag.String("format")),
      scope: Flag.optional(Flag.String("scope")),
      strict: boolFlag("strict"),
      args: variadicArgs,
    },
    ({ format, scope, strict, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      appendStringFlag(raw, "scope", scope)
      appendBoolFlag(raw, "strict", strict)
      return runSubcommand("ontology", raw)
    },
  )

  const reportCommand = CliCommand.make(
    "report",
    {
      format: Flag.optional(Flag.String("format")),
      clear: boolFlag("clear"),
      reset: boolFlag("reset"),
      all: boolFlag("all"),
      args: variadicArgs,
    },
    ({ format, clear, reset, all, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      appendBoolFlag(raw, "clear", clear)
      appendBoolFlag(raw, "reset", reset)
      appendBoolFlag(raw, "all", all)
      return runSubcommand("report", raw)
    },
  )

  const checkOpenApiCommand = CliCommand.make(
    "check-openapi",
    {
      baseline: Flag.optional(Flag.String("baseline")),
      write: boolFlag("write"),
      schema: Flag.optional(Flag.String("schema")),
      module: Flag.optional(Flag.String("module")),
      out: Flag.optional(Flag.String("out")),
      update: boolFlag("update"),
      args: variadicArgs,
    },
    ({ baseline, write, schema, module, out, update, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "baseline", baseline)
      appendBoolFlag(raw, "write", write)
      appendStringFlag(raw, "schema", schema)
      appendStringFlag(raw, "module", module)
      appendStringFlag(raw, "out", out)
      appendBoolFlag(raw, "update", update)
      return runSubcommand("check-openapi", raw)
    },
  )

  const checkMigrationsCommand = CliCommand.make(
    "check-migrations",
    {
      dialect: Flag.optional(Flag.String("dialect")),
      dir: Flag.optional(Flag.String("dir")),
      args: variadicArgs,
    },
    ({ dialect, dir, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "dialect", dialect)
      appendStringFlag(raw, "dir", dir)
      return runSubcommand("check-migrations", raw)
    },
  )

  const checkEventSchemasCommand = CliCommand.make(
    "check-event-schemas",
    {
      name: Flag.optional(Flag.String("name")),
      version: Flag.optional(Flag.String("version")),
      module: Flag.optional(Flag.String("module")),
      snapshot: Flag.optional(Flag.String("snapshot")),
      update: boolFlag("update"),
      args: variadicArgs,
    },
    ({ name, version, module, snapshot, update, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "name", name)
      appendStringFlag(raw, "version", version)
      appendStringFlag(raw, "module", module)
      appendStringFlag(raw, "snapshot", snapshot)
      appendBoolFlag(raw, "update", update)
      return runSubcommand("check-event-schemas", raw)
    },
  )

  const scenarioCommand = CliCommand.make(
    "scenario",
    {
      id: Flag.optional(Flag.String("id")),
      step: Flag.optional(Flag.String("step")),
      filter: Flag.optional(Flag.String("filter")),
      conversation: Flag.optional(Flag.String("conversation")),
      transcript: Flag.optional(Flag.String("transcript")),
      out: Flag.optional(Flag.String("out")),
      keepHidden: boolFlag("keep-hidden"),
      args: variadicArgs,
    },
    ({ id, step, filter, conversation, transcript, out, keepHidden, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "id", id)
      appendStringFlag(raw, "step", step)
      appendStringFlag(raw, "filter", filter)
      appendStringFlag(raw, "conversation", conversation)
      appendStringFlag(raw, "transcript", transcript)
      appendStringFlag(raw, "out", out)
      appendBoolFlag(raw, "keep-hidden", keepHidden)
      return runSubcommand("scenario", raw)
    },
  )

  const helpCommand = CliCommand.make(
    "help",
    {
      format: Flag.optional(Flag.String("format")),
      args: variadicArgs,
    },
    ({ format, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      return runSubcommand("help", raw)
    },
  )

  return CliCommand.make("harness").pipe(
    CliCommand.withSubcommands([
      guardCommand,
      routeCommand,
      planCheckCommand,
      planSynthCommand,
      repairCommand,
      verifyCommand,
      doneCommand,
      learnCommand,
      gcCommand,
      mutateCommand,
      makeBenchSubcommand("bench"),
      makeBenchSubcommand("benchmark"),
      ingestCommand,
      makeSessionSubcommand("session"),
      makeSessionSubcommand("doctor"),
      ontologyCommand,
      reportCommand,
      checkOpenApiCommand,
      checkMigrationsCommand,
      checkEventSchemasCommand,
      scenarioCommand,
      helpCommand,
    ]),
  )
}

export const harnessRootCommand = makeHarnessRootCommand(() => Effect.void)

export const runDeclarativeCli = Effect.fn("HarnessCli.runDeclarativeCli")(function* (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.fn.Return<CliResult> {
  const requested = argv[0] ?? "help"
  if (requested === "--help" || requested === "-h") {
    return {
      exitCode: 0,
      stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
      stderr: "",
    }
  }
  if (requested === "guard" && (argv.includes("--help") || argv.includes("-h"))) {
    const isAntigravity = argv.includes("--format=antigravity")
    const reason = "guard: --help flag is not permitted on guard"
    return isAntigravity
      ? {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "deny", reason }),
          stderr: "",
        }
      : {
          exitCode: 2,
          stdout: "",
          stderr: reason,
        }
  }
  if (
    requested !== "guard" &&
    (argv.includes("--help") || argv.includes("-h")) &&
    isCommand(requested)
  ) {
    return {
      exitCode: 0,
      stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
      stderr: "",
    }
  }
  if (!isCommand(requested)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `unknown command: ${requested}\nusage: harness <${COMMANDS.join("|")}>`,
    }
  }

  const effectiveOptions =
    maybeDecisionLayer !== undefined ? { ...options, decisionLayer: maybeDecisionLayer } : options
  const decisionLayer = effectiveOptions?.decisionLayer ?? LocalDecisionModel
  const liveCommandLayer = makeLiveCliCommandRegistryLayer(effectiveOptions, decisionLayer)
  const resultRef = yield* Ref.make<Option.Option<CliResult>>(Option.none())
  const rootCmd = makeHarnessRootCommand((result) => Ref.set(resultRef, Option.some(result)))
  const mainLayer = Layer.mergeAll(
    HarnessInfraLive,
    decisionLayer,
    liveCommandLayer,
    NodeServices.layer,
  )

  const normalizedArgv = argv.length === 0 ? ["help"] : argv
  const cliErr = yield* CliCommand.runWith(rootCmd, {
    version: "0.0.0",
    renderErrors: false,
  })(normalizedArgv).pipe(
    Effect.provide(mainLayer),
    Effect.as<string | undefined>(undefined),
    Effect.catch((err) =>
      Effect.succeed(
        match(err)
          .with(
            { _tag: "ShowHelp" },
            (e) => e.errors.map((sub) => sub.message).join("; ") || e.message,
          )
          .with(
            { _tag: "UnrecognizedOption" },
            { _tag: "DuplicateOption" },
            { _tag: "MissingOption" },
            { _tag: "MissingArgument" },
            { _tag: "UnexpectedArgument" },
            { _tag: "InvalidValue" },
            { _tag: "UnknownSubcommand" },
            { _tag: "UserError" },
            (e) => e.message,
          )
          .exhaustive(),
      ),
    ),
  )

  if (cliErr !== undefined) {
    if (requested === "guard") {
      const isAntigravity = argv.includes("--format=antigravity")
      const reason = `guard: CLI parse failure (${cliErr})`
      return isAntigravity
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "deny", reason }),
            stderr: "",
          }
        : {
            exitCode: 2,
            stdout: "",
            stderr: reason,
          }
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: cliErr,
    }
  }

  const maybeResult = yield* Ref.get(resultRef)
  return match(maybeResult)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => {
      if (requested === "guard") {
        const isAntigravity = argv.includes("--format=antigravity")
        const reason = "guard: subcommand handler did not execute"
        return isAntigravity
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ decision: "deny", reason }),
              stderr: "",
            }
          : {
              exitCode: 2,
              stdout: "",
              stderr: reason,
            }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    })
    .exhaustive()
})
