import { NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Layer, Logger, Option, Ref } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { Argument, Command as CliCommand, Flag } from "effect/cli"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { HookInfraLive, LocalDecisionModel } from "@harness/infra/hook-fastpath"
import {
  dispatchCliCommand,
  HarnessCommandRegistry,
  makeLiveCliCommandRegistryLayer,
  toLazyImportError,
} from "./command-registry.js"
import { COMMANDS, type CliEnv, type CliResult, isCommand } from "./daemon-and-omnigraph.service.js"
import {
  createHookStdinTracker,
  detectAntigravityHookPayload,
  hasAntigravityFormat,
  type HookStdinTracker,
  makeDoneBlockResult,
  makeGuardDenyResult,
} from "./hook-format.js"

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

export const makeHarnessRootCommand = (onResult: (result: CliResult) => Effect.Effect<void>) => {
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
      all: boolFlag("all"),
      diff: boolFlag("diff"),
      noCache: boolFlag("no-cache"),
      file: Flag.optional(Flag.String("file")),
      base: Flag.optional(Flag.String("base")),
      args: variadicArgs,
    },
    ({ scope, strict, all, diff, noCache, file, base, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "scope", scope)
      appendBoolFlag(raw, "strict", strict)
      appendBoolFlag(raw, "all", all)
      appendBoolFlag(raw, "diff", diff)
      appendBoolFlag(raw, "no-cache", noCache)
      appendStringFlag(raw, "file", file)
      appendStringFlag(raw, "base", base)
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
      deterministic: boolFlag("deterministic"),
      args: variadicArgs,
    },
    ({ format, scope, strict, deterministic, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      appendStringFlag(raw, "scope", scope)
      appendBoolFlag(raw, "strict", strict)
      appendBoolFlag(raw, "deterministic", deterministic)
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
      write: boolFlag("write"),
      module: Flag.optional(Flag.String("module")),
      out: Flag.optional(Flag.String("out")),
      args: variadicArgs,
    },
    ({ write, module, out, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "write", write)
      appendStringFlag(raw, "module", module)
      appendStringFlag(raw, "out", out)
      return runSubcommand("check-openapi", raw)
    },
  )

  const checkMigrationsCommand = CliCommand.make(
    "check-migrations",
    {
      packageName: Flag.optional(Flag.String("package")),
      dir: Flag.optional(Flag.String("dir")),
      args: variadicArgs,
    },
    ({ packageName, dir, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "package", packageName)
      appendStringFlag(raw, "dir", dir)
      return runSubcommand("check-migrations", raw)
    },
  )

  const checkEventSchemasCommand = CliCommand.make(
    "check-event-schemas",
    {
      module: Flag.optional(Flag.String("module")),
      snapshot: Flag.optional(Flag.String("snapshot")),
      out: Flag.optional(Flag.String("out")),
      update: boolFlag("update"),
      args: variadicArgs,
    },
    ({ module, snapshot, out, update, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "module", module)
      appendStringFlag(raw, "snapshot", snapshot)
      appendStringFlag(raw, "out", out)
      appendBoolFlag(raw, "update", update)
      return runSubcommand("check-event-schemas", raw)
    },
  )

  const scenarioCommand = CliCommand.make(
    "scenario",
    {
      filter: Flag.optional(Flag.String("filter")),
      conversation: Flag.optional(Flag.String("conversation")),
      transcript: Flag.optional(Flag.String("transcript")),
      args: variadicArgs,
    },
    ({ filter, conversation, transcript, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "filter", filter)
      appendStringFlag(raw, "conversation", conversation)
      appendStringFlag(raw, "transcript", transcript)
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

const makeFailClosedHookResult = (
  requested: "guard" | "done",
  argv: ReadonlyArray<string>,
  reason: string,
  extraStderr = "",
  rawStdin?: string,
  hookStdinTracker?: HookStdinTracker,
): CliResult => {
  const isAntigravity =
    hasAntigravityFormat(argv) ||
    (rawStdin !== undefined
      ? detectAntigravityHookPayload(rawStdin)
      : (hookStdinTracker?.isAntigravityDetected() ?? false))
  return requested === "guard"
    ? makeGuardDenyResult(isAntigravity, reason, extraStderr)
    : makeDoneBlockResult(isAntigravity, reason, extraStderr)
}

export const runDeclarativeCli = Effect.fn("HarnessCli.runDeclarativeCli")(function* (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.fn.Return<CliResult> {
  const hookStdinTracker = options?.hookStdinTracker ?? createHookStdinTracker()
  const requested = argv[0] ?? "help"
  if (argv.length === 1 && (requested === "--help" || requested === "-h")) {
    return {
      exitCode: 0,
      stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
      stderr: "",
    }
  }
  if (argv.length === 1 && (requested === "--version" || requested === "-v")) {
    return {
      exitCode: 0,
      stdout: "0.0.0",
      stderr: "",
    }
  }
  if (
    (requested === "guard" || requested === "done") &&
    (argv.includes("--help") || argv.includes("-h"))
  ) {
    return makeFailClosedHookResult(
      requested,
      argv,
      `${requested}: --help flag is not permitted on ${requested}`,
      "",
      options?.stdin,
    )
  }
  if (
    requested !== "guard" &&
    requested !== "done" &&
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

  const effectiveOptions: CliEnv = {
    ...options,
    ...(maybeDecisionLayer !== undefined ? { decisionLayer: maybeDecisionLayer } : {}),
    hookStdinTracker,
  }
  const decisionLayer = effectiveOptions.decisionLayer ?? LocalDecisionModel
  const liveCommandLayer = makeLiveCliCommandRegistryLayer(effectiveOptions)
  const resultRef = yield* Ref.make<Option.Option<CliResult>>(Option.none())
  const rootCmd = makeHarnessRootCommand((result) => Ref.set(resultRef, Option.some(result)))
  const stderrBuffer: Array<string> = []
  const formatConsoleArgs = (args: ReadonlyArray<unknown>): string =>
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")
  const pushStderrLine = (...args: ReadonlyArray<unknown>): void => {
    stderrBuffer.push(`${formatConsoleArgs(args)}\n`)
  }
  const hookConsole: Console.Console = {
    assert: (condition: boolean, ...args: ReadonlyArray<unknown>) => {
      if (!condition) pushStderrLine("Assertion failed:", ...args)
    },
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: pushStderrLine,
    dir: (item: unknown) => pushStderrLine(item),
    dirxml: pushStderrLine,
    error: pushStderrLine,
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: pushStderrLine,
    log: pushStderrLine,
    table: (tabularData: unknown) => pushStderrLine(tabularData),
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    trace: pushStderrLine,
    warn: pushStderrLine,
  }
  const isHookCommand = requested === "guard" || requested === "done" || hasAntigravityFormat(argv)
  const useHookFastpath =
    requested === "guard" ||
    requested === "route" ||
    (requested === "session" && hasAntigravityFormat(argv))
  const infraLayer = useHookFastpath
    ? HookInfraLive
    : yield* Effect.tryPromise({
        try: () => import("./mutate-and-bench.command.js"),
        catch: toLazyImportError,
      }).pipe(
        Effect.map((m) => m.HarnessInfraLive),
        Effect.catch((err) =>
          Effect.sync(
            () => (process.stderr.write(`[harness:cli] Warning: ${err.message}\n`), HookInfraLive),
          ),
        ),
      )
  const mainLayer = Layer.mergeAll(
    infraLayer,
    decisionLayer,
    liveCommandLayer,
    NodeServices.layer,
    Layer.succeed(Logger.LogToStderr, true),
    isHookCommand ? Layer.succeed(Console.Console, hookConsole) : Layer.empty,
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
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.interrupt
      }
      return Effect.succeed(`unexpected defect: ${Cause.pretty(cause)}`)
    }),
  )

  if (cliErr !== undefined) {
    if (requested === "guard" || requested === "done") {
      return makeFailClosedHookResult(
        requested,
        argv,
        `${requested}: CLI parse failure (${cliErr})`,
        stderrBuffer.join(""),
        effectiveOptions.stdin,
        hookStdinTracker,
      )
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
      if (requested === "guard" || requested === "done") {
        return makeFailClosedHookResult(
          requested,
          argv,
          `${requested}: subcommand handler did not execute`,
          stderrBuffer.join(""),
          effectiveOptions.stdin,
          hookStdinTracker,
        )
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "CLI command did not execute (invalid arguments or options).",
      }
    })
    .exhaustive()
})
