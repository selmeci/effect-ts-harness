import { Effect, Option } from "effect"
import { Argument, Command as CliCommand, Flag } from "effect/cli"
import { match } from "ts-pattern"
import type { HarnessCommandRegistry } from "./command-registry.js"

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

/** Builds the `harness workflow` declarative CLI subcommand (`effect/cli`). */
export const makeWorkflowSubcommand = (
  runSubcommand: (
    name: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, never, HarnessCommandRegistry>,
) =>
  CliCommand.make(
    "workflow",
    {
      level: Flag.optional(Flag.String("level")),
      mode: Flag.optional(Flag.String("mode")),
      runner: Flag.optional(Flag.String("runner")),
      maxConcurrency: Flag.optional(Flag.Int("max-concurrency")),
      input: Flag.optional(Flag.String("input")),
      plan: Flag.optional(Flag.String("plan")),
      runId: Flag.optional(Flag.String("run-id")),
      unit: Flag.optional(Flag.String("unit")),
      phase: Flag.optional(Flag.String("phase")),
      repoRoot: Flag.optional(Flag.String("repo-root")),
      decision: Flag.optional(Flag.String("decision")),
      rebuildViews: Flag.Boolean("rebuild-views").pipe(Flag.withDefault(false)),
      json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
      args: Argument.String("args").pipe(Argument.variadic()),
    },
    (flags) => {
      const raw: Array<string> = [...flags.args]
      appendStringFlag(raw, "level", flags.level)
      appendStringFlag(raw, "mode", flags.mode)
      appendStringFlag(raw, "runner", flags.runner)
      appendNumberFlag(raw, "max-concurrency", flags.maxConcurrency)
      appendStringFlag(raw, "input", flags.input)
      appendStringFlag(raw, "plan", flags.plan)
      appendStringFlag(raw, "run-id", flags.runId)
      appendStringFlag(raw, "unit", flags.unit)
      appendStringFlag(raw, "phase", flags.phase)
      appendStringFlag(raw, "repo-root", flags.repoRoot)
      appendStringFlag(raw, "decision", flags.decision)
      appendBoolFlag(raw, "rebuild-views", flags.rebuildViews)
      appendBoolFlag(raw, "json", flags.json)
      return runSubcommand("workflow", raw)
    },
  )
