import type { Effect } from "effect"
import { Argument, Command as CliCommand, Flag } from "effect/cli"
import type { HarnessCommandRegistry } from "./command-registry.js"
import { appendBoolFlag, appendStringFlag } from "./declarative-cli-flags.js"

const variadicArgs = Argument.String("args").pipe(Argument.variadic())
const boolFlag = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false))

type RunSubcommand = (
  name: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, never, HarnessCommandRegistry>

/** Builds the `harness review-route` declarative CLI subcommand (`effect/cli`). */
export const makeReviewRouteSubcommand = (runSubcommand: RunSubcommand) =>
  CliCommand.make(
    "review-route",
    {
      base: Flag.optional(Flag.String("base")),
      files: Flag.String("files").pipe(Flag.atLeast(0)),
      file: Flag.String("file").pipe(Flag.atLeast(0)),
      format: Flag.optional(Flag.String("format")),
      json: boolFlag("json"),
      args: variadicArgs,
    },
    ({ base, files, file, format, json, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "base", base)
      for (const f of files) {
        raw.push(`--files=${f}`)
      }
      for (const f of file) {
        raw.push(`--file=${f}`)
      }
      appendStringFlag(raw, "format", format)
      appendBoolFlag(raw, "json", json)
      return runSubcommand("review-route", raw)
    },
  )

/** Builds the `harness plan-check` declarative CLI subcommand (`effect/cli`). */
export const makePlanCheckSubcommand = (runSubcommand: RunSubcommand) =>
  CliCommand.make(
    "plan-check",
    {
      graphOnly: boolFlag("graph-only"),
      verify: boolFlag("verify"),
      mermaid: boolFlag("mermaid"),
      args: variadicArgs,
    },
    ({ graphOnly, verify, mermaid, args }) => {
      const raw: Array<string> = [...args]
      appendBoolFlag(raw, "graph-only", graphOnly)
      appendBoolFlag(raw, "verify", verify)
      appendBoolFlag(raw, "mermaid", mermaid)
      return runSubcommand("plan-check", raw)
    },
  )

/** Builds the `harness report` declarative CLI subcommand (`effect/cli`). */
export const makeReportSubcommand = (runSubcommand: RunSubcommand) =>
  CliCommand.make(
    "report",
    {
      format: Flag.optional(Flag.String("format")),
      json: boolFlag("json"),
      clear: boolFlag("clear"),
      reset: boolFlag("reset"),
      all: boolFlag("all"),
      args: variadicArgs,
    },
    ({ format, json, clear, reset, all, args }) => {
      const raw: Array<string> = [...args]
      appendStringFlag(raw, "format", format)
      appendBoolFlag(raw, "json", json)
      appendBoolFlag(raw, "clear", clear)
      appendBoolFlag(raw, "reset", reset)
      appendBoolFlag(raw, "all", all)
      return runSubcommand("report", raw)
    },
  )

/** Formats the compact default JSON summary for `harness plan-check`. */
export const formatPlanCheckCompactSummary = (input: {
  readonly snapshotReused: boolean
  readonly nodeCount: number
  readonly edgeCount: number
  readonly stubCount: number
  readonly mermaid: string
}): string =>
  JSON.stringify({
    valid: true,
    snapshotReused: input.snapshotReused,
    nodeCount: input.nodeCount,
    edgeCount: input.edgeCount,
    stubCount: input.stubCount,
    mermaidLines: input.mermaid.length === 0 ? 0 : input.mermaid.split("\n").length,
    mermaidOmitted: true,
    tip: "Pass --mermaid to print the full flowchart.",
  })
