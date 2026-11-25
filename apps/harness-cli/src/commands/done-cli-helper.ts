import type { Layer } from "effect"
import { Effect, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { Command as CliCommand, Flag } from "effect/cli"
import { match } from "ts-pattern"
import type { checkPlanStepCoverage } from "@harness/decision"
import type { diffPlanAndImplGraphs } from "@harness/gates"
import type { HarnessCommandRegistry } from "./command-registry.js"
import type { CliEnv } from "./daemon-and-omnigraph.service.js"
import { appendBoolFlag, appendStringFlag } from "./declarative-cli-flags.js"
import type { runOmnigraphMaintenance, syncOmnigraphOnDone } from "./done-omnigraph-helpers.js"
import type { CliResult } from "./hook-format.js"
import type { finalizeDoneSuccess, loadSnapshotPair } from "./mutate-and-bench.command.js"

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecordOption = Schema.decodeUnknownOption(JsonRecordSchema)

const parseCliBoolValue = (raw: string): boolean | undefined =>
  match(raw.trim().toLowerCase())
    .with("true", "yes", "on", "1", () => true)
    .with("false", "no", "off", "0", () => false)
    .otherwise(() => undefined)

/**
 * Returns true when `--cli` is active in the `done` command `argv` (stopping at `--`),
 * handling `--cli=true|false|yes|no|on|off|1|0`, `--no-cli`, and `--cli <bool>`.
 */
export const hasDoneCliFlag = (argv: ReadonlyArray<string>): boolean => {
  let cliMode = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || arg === "--") {
      break
    }
    if (arg === "--format" && i + 1 < argv.length && argv[i + 1] !== "--") {
      i += 1
      continue
    }
    if (arg === "--no-cli") {
      cliMode = false
      continue
    }
    if (arg.startsWith("--cli=")) {
      const parsed = parseCliBoolValue(arg.slice("--cli=".length))
      if (parsed !== undefined) {
        cliMode = parsed
      }
      continue
    }
    if (arg === "--cli") {
      const next = argv[i + 1]
      const parsed = next !== undefined && next !== "--" ? parseCliBoolValue(next) : undefined
      if (parsed !== undefined) {
        cliMode = parsed
        i += 1
      } else {
        cliMode = true
      }
    }
  }
  return cliMode
}

/**
 * Normalizes a `handleDone` Stop-hook `CliResult` into standard CLI exit-code/stderr
 * semantics when `--cli` is active, leaving Stop-hook output untouched otherwise.
 */
export const normalizeDoneResultForCli = (result: CliResult, isCliMode: boolean): CliResult => {
  if (!isCliMode) return result
  return match(decodeJsonRecordOption(result.stdout))
    .with({ _tag: "None" }, () => result)
    .with({ _tag: "Some" }, ({ value }) =>
      match(value["decision"])
        .with("block", "continue", () => {
          const rawReason = value["reason"]
          const reason =
            typeof rawReason === "string" && rawReason.trim().length > 0
              ? rawReason
              : "done: blocked"
          return {
            ...result,
            exitCode: result.exitCode === 0 ? 1 : result.exitCode,
            stderr: result.stderr.trim().length > 0 ? result.stderr : reason,
          }
        })
        .otherwise(() => result),
    )
    .exhaustive()
}

/** Appends a corrupt-transcript diagnostic note to a `done` block reason when present. */
export const appendTranscriptNote = (
  reason: string,
  corruptTranscriptNote: string | undefined,
): string => (corruptTranscriptNote !== undefined ? `${reason} (${corruptTranscriptNote})` : reason)

/** Attaches transcript diagnostic stderr lines to a `CliResult` when non-empty. */
export const withTranscriptStderr = (res: CliResult, transcriptStderr: string): CliResult =>
  transcriptStderr.length === 0
    ? res
    : {
        ...res,
        stderr: res.stderr.length > 0 ? `${res.stderr}\n${transcriptStderr}` : transcriptStderr,
      }

export interface DoneGraphAndStepCheckDeps {
  readonly loadSnapshotPair: typeof loadSnapshotPair
  readonly diffPlanAndImplGraphs: typeof diffPlanAndImplGraphs
  readonly checkPlanStepCoverage: typeof checkPlanStepCoverage
  readonly syncOmnigraphOnDone: typeof syncOmnigraphOnDone
  readonly finalizeDoneSuccess: typeof finalizeDoneSuccess
  readonly runOmnigraphMaintenance: typeof runOmnigraphMaintenance
}

export interface ExecuteDoneGraphAndStepChecksInput {
  readonly repoRoot: string
  readonly treeHash: string
  readonly isAntigravity: boolean
  readonly blockDecision: string
  readonly corruptTranscriptNote: string | undefined
  readonly transcriptStderr: string
  readonly options: CliEnv | undefined
  readonly decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
  readonly deps: DoneGraphAndStepCheckDeps
}

/** Runs post-stamp plan/impl graph diff, plan step coverage, and omnigraph sync checks for `done`. */
export const executeDoneGraphAndStepChecks = ({
  repoRoot,
  treeHash,
  isAntigravity,
  blockDecision,
  corruptTranscriptNote,
  transcriptStderr,
  options,
  decisionLayer,
  deps,
}: ExecuteDoneGraphAndStepChecksInput): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const snapshotOutcome = yield* deps.loadSnapshotPair(
      repoRoot,
      options?.planGraph,
      options?.implGraph,
      isAntigravity,
    )

    return yield* match(snapshotOutcome)
      .with({ _tag: "Done" }, ({ result }) =>
        Effect.succeed(withTranscriptStderr(result, transcriptStderr)),
      )
      .with({ _tag: "Graphs" }, ({ planGraph, implGraph }) =>
        Effect.gen(function* () {
          if (planGraph && implGraph) {
            const diff = deps.diffPlanAndImplGraphs(planGraph, implGraph)
            if (!diff.ok) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  decision: blockDecision,
                  reason: appendTranscriptNote(diff.reasons.join("; "), corruptTranscriptNote),
                }),
                stderr: transcriptStderr,
              }
            }
          }
          if (options?.planSteps && options.planSteps.length > 0) {
            for (const step of options.planSteps) {
              const stepRes = yield* deps
                .checkPlanStepCoverage(step)
                .pipe(Effect.provide(decisionLayer))
              if (!stepRes.covered) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    decision: blockDecision,
                    reason: appendTranscriptNote(stepRes.reason, corruptTranscriptNote),
                  }),
                  stderr: transcriptStderr,
                }
              }
            }
          }
          const omnigraphFailure = yield* deps.syncOmnigraphOnDone(
            repoRoot,
            options,
            isAntigravity,
            blockDecision,
          )
          if (omnigraphFailure !== undefined) {
            return withTranscriptStderr(omnigraphFailure, transcriptStderr)
          }

          deps.finalizeDoneSuccess(repoRoot, treeHash, options)
          deps.runOmnigraphMaintenance(repoRoot, { includeCleanup: true })
          return {
            exitCode: 0,
            stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
            stderr: transcriptStderr,
            telemetryDetail: "completed",
          }
        }),
      )
      .exhaustive()
  })

/** Builds the declarative `harness done` subcommand supporting `--format` and `--cli`. */
export const makeDoneDeclarativeCommand = (
  runSubcommand: (
    name: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, never, HarnessCommandRegistry>,
) =>
  CliCommand.make(
    "done",
    {
      format: Flag.optional(Flag.String("format")),
      cli: Flag.Boolean("cli").pipe(Flag.withDefault(false)),
    },
    ({ format, cli }) => {
      const raw: Array<string> = []
      appendStringFlag(raw, "format", format)
      appendBoolFlag(raw, "cli", cli)
      return runSubcommand("done", raw)
    },
  )
