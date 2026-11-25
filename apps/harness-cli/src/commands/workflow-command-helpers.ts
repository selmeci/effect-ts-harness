import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type DaemonProtocolMismatchError,
  MaxConcurrency,
  RunnerId,
  type ShipStreamProgressEvent,
  type StdinReadError,
  type UnitMode,
  UnitMode as UnitModeSchema,
  type UnitOutcome,
  WorkflowRunId,
  WorkflowShipResponse,
  type WorkflowStoreUnavailableError,
  toErrorReasonMessage,
} from "@harness/contract"
import type { CompileWorkflowPlanError } from "@harness/infra"
import type { CliResult } from "./daemon-and-omnigraph.service.js"

export const WORKFLOW_ACTIONS = [
  "compile",
  "start",
  "status",
  "complete",
  "resume",
  "ship",
  "doctor",
  "abort",
] as const
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number]

export const WORKFLOW_USAGE =
  "usage: harness workflow <compile|start|status|complete|resume|ship|doctor|abort> [options]"

export const VALUE_FLAG_LIST = [
  "level",
  "mode",
  "runner",
  "max-concurrency",
  "input",
  "plan",
  "run",
  "run-id",
  "unit",
  "phase",
  "repo-root",
  "decision",
] as const
export type ValueFlagName = (typeof VALUE_FLAG_LIST)[number]
const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(VALUE_FLAG_LIST)

export interface ParsedWorkflowFlags {
  readonly values: Partial<Record<ValueFlagName, string>>
  readonly rebuildViews: boolean
  readonly json: boolean
}

export interface WorkflowCliValidationError {
  readonly _tag: "WorkflowCliValidationError"
  readonly message: string
  readonly code?: string | undefined
  readonly extra?: Readonly<Record<string, unknown>> | undefined
}

export const isWorkflowCliValidationError = (err: unknown): err is WorkflowCliValidationError =>
  typeof err === "object" &&
  err !== null &&
  Reflect.get(err, "_tag") === "WorkflowCliValidationError" &&
  typeof Reflect.get(err, "message") === "string"

export type WorkflowCliError =
  | WorkflowCliValidationError
  | CompileWorkflowPlanError
  | DaemonProtocolMismatchError
  | WorkflowStoreUnavailableError
  | StdinReadError
  | Schema.SchemaError

const isWorkflowAction = (value: string): value is WorkflowAction =>
  (WORKFLOW_ACTIONS as readonly string[]).includes(value)

const isValueFlagName = (value: string): value is ValueFlagName => VALUE_FLAG_NAMES.has(value)

export const validationFail = (
  message: string,
  extra?: {
    readonly code?: string | undefined
    readonly details?: Readonly<Record<string, unknown>> | undefined
  },
): WorkflowCliValidationError => ({
  _tag: "WorkflowCliValidationError",
  message,
  ...(extra?.code !== undefined ? { code: extra.code } : {}),
  ...(extra?.details !== undefined ? { extra: extra.details } : {}),
})

export const parseWorkflowCliArgs = (
  args: ReadonlyArray<string>,
): Result.Result<
  { readonly action: WorkflowAction; readonly flags: ParsedWorkflowFlags },
  WorkflowCliValidationError
> => {
  const subArgs = args[0] === "workflow" ? args.slice(1) : args
  const values: Partial<Record<ValueFlagName, string>> = {}
  let rebuildViews = false
  let json = false
  const positional: Array<string> = []

  for (let i = 0; i < subArgs.length; i += 1) {
    const arg = subArgs[i]!
    if (arg === "--rebuild-views") {
      rebuildViews = true
      continue
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=")
      const flagName = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx)
      if (!isValueFlagName(flagName)) {
        return Result.fail(
          validationFail(`Unrecognized workflow flag '--${flagName}'.\n${WORKFLOW_USAGE}`),
        )
      }
      const flagVal = eqIdx === -1 ? subArgs[++i] : arg.slice(eqIdx + 1)
      if (
        flagVal === undefined ||
        flagVal.trim().length === 0 ||
        (eqIdx === -1 && flagVal.startsWith("--"))
      ) {
        return Result.fail(
          validationFail(`Missing or empty value for '--${flagName}'.\n${WORKFLOW_USAGE}`),
        )
      }
      values[flagName] = flagVal
      continue
    }
    if (arg.startsWith("-")) {
      return Result.fail(validationFail(`Unrecognized workflow flag '${arg}'.\n${WORKFLOW_USAGE}`))
    }
    positional.push(arg)
  }

  const actionRaw = positional[0]
  if (actionRaw === undefined) {
    return Result.fail(validationFail(`Missing workflow subcommand.\n${WORKFLOW_USAGE}`))
  }
  if (!isWorkflowAction(actionRaw)) {
    return Result.fail(
      validationFail(`Unknown workflow subcommand '${actionRaw}'.\n${WORKFLOW_USAGE}`),
    )
  }
  if (positional.length > 1) {
    return Result.fail(
      validationFail(`Unexpected positional argument '${positional[1]}'.\n${WORKFLOW_USAGE}`),
    )
  }
  return Result.succeed({ action: actionRaw, flags: { values, rebuildViews, json } })
}

export const formatOutput = (payload: unknown, compactJson: boolean): string =>
  compactJson ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)

export const okResult = (payload: unknown, compactJson: boolean): CliResult => ({
  exitCode: 0,
  stdout: formatOutput(payload, compactJson),
  stderr: "",
})

export const formatErrorText = (err: unknown): string =>
  toErrorReasonMessage(err, "Workflow command failed")

export const decodeWithLabel = <A, E, R>(
  schema: Schema.Codec<A, unknown, R, E>,
  value: unknown,
  label: string,
): Effect.Effect<A, WorkflowCliValidationError, R> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((err) => validationFail(`Invalid ${label}: ${formatErrorText(err)}`)),
  )

export const decodeOptional = <A, E, R>(
  schema: Schema.Codec<A, unknown, R, E>,
  raw: string | undefined,
  label: string,
): Effect.Effect<A | undefined, WorkflowCliValidationError, R> =>
  raw !== undefined
    ? decodeWithLabel(schema, raw.trim(), label)
    : Effect.map(Effect.succeed(Option.none<A>()), Option.getOrUndefined)

export const requireRunId = (rawRunId: string | undefined, action: string) =>
  rawRunId === undefined
    ? Effect.fail(validationFail(`workflow ${action} requires --run-id <id>`))
    : decodeWithLabel(WorkflowRunId, rawRunId.trim(), "--run-id")

/** Resolves an optional `--run` or `--run-id` flag, rejecting conflicting values. */
export const resolveOptionalRunId = (
  values: ParsedWorkflowFlags["values"],
): Effect.Effect<WorkflowRunId | undefined, WorkflowCliValidationError> => {
  const rawRun = values.run?.trim()
  const rawRunId = values["run-id"]?.trim()
  if (rawRun !== undefined && rawRunId !== undefined) {
    if (rawRun !== rawRunId) {
      return Effect.fail(
        validationFail(
          `Conflicting --run ('${rawRun}') and --run-id ('${rawRunId}') values; specify only one or ensure both match`,
        ),
      )
    }
    return decodeWithLabel(WorkflowRunId, rawRun, "--run")
  }
  if (rawRun !== undefined) {
    return decodeWithLabel(WorkflowRunId, rawRun, "--run")
  }
  if (rawRunId !== undefined) {
    return decodeWithLabel(WorkflowRunId, rawRunId, "--run-id")
  }
  return Effect.map(Effect.succeed(Option.none<WorkflowRunId>()), Option.getOrUndefined)
}

/** Formats a single-line human status for streaming `workflow.ship` progress to stderr. */
export const formatWorkflowShipProgressLine = (event: ShipStreamProgressEvent): string =>
  match(event)
    .with(
      { _tag: "StageStarted" },
      ({ runId, attempt, stage }) =>
        `[workflow:ship] ${runId} attempt=${attempt} stage=${stage} started`,
    )
    .with({ _tag: "StageFinished" }, ({ runId, attempt, progress }) =>
      match(progress)
        .with(
          { _tag: "Passed" },
          ({ stage, durationMs }) =>
            `[workflow:ship] ${runId} attempt=${attempt} stage=${stage} passed (${durationMs}ms)`,
        )
        .with(
          { _tag: "Failed" },
          ({ stage, durationMs, errorTag, detail }) =>
            `[workflow:ship] ${runId} attempt=${attempt} stage=${stage} failed (${durationMs}ms, ${errorTag}): ${detail}`,
        )
        .exhaustive(),
    )
    .exhaustive()

/** Formats a terminal `WorkflowShipResponse` into a `CliResult` with exit codes 0 (Passed), 2 (circuit breaker tripped), or 1 (other failure). */
export const formatWorkflowShipOutcome = (
  response: WorkflowShipResponse,
  compactJson: boolean,
  encodedPayload?: typeof WorkflowShipResponse.Encoded,
): CliResult => {
  const stdout = formatOutput(
    encodedPayload ?? Schema.encodeSync(WorkflowShipResponse)(response),
    compactJson,
  )
  return match(response.outcome)
    .with({ _tag: "Passed" }, () => ({
      exitCode: 0,
      stdout,
      stderr: "",
    }))
    .with({ _tag: "Failed" }, ({ error }) =>
      match(error)
        .with({ _tag: "ShipGateFailedError", circuitBreakerStatus: "tripped" }, (gateErr) => ({
          exitCode: 2,
          stdout,
          stderr: `${gateErr.escalationMessage ?? gateErr.message}\n`,
        }))
        .with(
          { _tag: "ShipGateFailedError", circuitBreakerStatus: "clear" },
          { _tag: "ShipTreeMismatchError" },
          { _tag: "MutationRestoreError" },
          { _tag: "ShipTreeDriftError" },
          (err) => ({
            exitCode: 1,
            stdout,
            stderr: `${err.message}\n`,
          }),
        )
        .exhaustive(),
    )
    .exhaustive()
}

export const formatUnitRejectionSummary = (
  outcome: Extract<UnitOutcome, { readonly _tag: "Rejected" }>,
): string =>
  match(outcome.rejection)
    .with(
      { _tag: "WriteSetViolation" },
      ({ offendingPaths }) =>
        `Unit '${outcome.unitId}' rejected (WriteSetViolation): ${offendingPaths.join(", ")}`,
    )
    .with({ _tag: "PackageVerifyFailed" }, ({ exitCode, failureKind, detail }) => {
      const boundedDetail = detail !== undefined ? `: ${detail.slice(0, 240)}` : ""
      return `Unit '${outcome.unitId}' rejected (PackageVerifyFailed, failureKind=${failureKind}, exitCode=${exitCode})${boundedDetail}`
    })
    .with({ _tag: "StampMissing" }, () => `Unit '${outcome.unitId}' rejected (StampMissing)`)
    .with(
      { _tag: "AgentFailed" },
      ({ reason }) => `Unit '${outcome.unitId}' rejected (AgentFailed): ${reason}`,
    )
    .exhaustive()

/** Parses explicit CLI `--mode` / `--runner` / `--max-concurrency` flags, returning `undefined` when omitted so `--input` JSON can supply `mode`. */
export const buildOptionalCompileUnitMode = (
  values: ParsedWorkflowFlags["values"],
): Effect.Effect<UnitMode | undefined, WorkflowCliValidationError> =>
  Effect.gen(function* () {
    if (values.mode === undefined) {
      if (values.runner !== undefined || values["max-concurrency"] !== undefined) {
        return yield* Effect.fail(
          validationFail("--runner and --max-concurrency require --mode automatic"),
        )
      }
      return undefined
    }
    const modeStr = values.mode.trim()
    if (modeStr !== "manual" && modeStr !== "automatic") {
      return yield* Effect.fail(
        validationFail(`Invalid --mode '${modeStr}': expected 'manual' or 'automatic'`),
      )
    }
    if (modeStr === "manual") {
      if (values.runner !== undefined || values["max-concurrency"] !== undefined) {
        return yield* Effect.fail(
          validationFail("--runner and --max-concurrency require --mode automatic"),
        )
      }
      return yield* decodeWithLabel(UnitModeSchema, { _tag: "Manual" }, "--mode")
    }
    if (values.runner === undefined) {
      return yield* Effect.fail(
        validationFail("--mode automatic requires --runner <claude-code|antigravity>"),
      )
    }
    const runner = yield* decodeWithLabel(RunnerId, values.runner.trim(), "--runner")
    let maxConcurrency = MaxConcurrency.make(4)
    if (values["max-concurrency"] !== undefined) {
      const rawMax = values["max-concurrency"].trim()
      if (!/^\d+$/.test(rawMax)) {
        return yield* Effect.fail(
          validationFail(`Invalid --max-concurrency '${rawMax}': expected integer 1..8`),
        )
      }
      maxConcurrency = yield* decodeWithLabel(
        MaxConcurrency,
        Number.parseInt(rawMax, 10),
        "--max-concurrency",
      )
    }
    return yield* decodeWithLabel(
      UnitModeSchema,
      { _tag: "Automatic", runner, maxConcurrency },
      "--mode",
    )
  })

export const assertAutomaticRunnerSupported = (
  mode: UnitMode,
  runnerKind: "live" | "placeholder",
): Effect.Effect<void, WorkflowCliValidationError> =>
  match(mode)
    .with({ _tag: "Manual" }, () => Effect.void)
    .with({ _tag: "Automatic" }, () =>
      match(runnerKind)
        .with("placeholder", () =>
          Effect.fail(
            validationFail(
              "Automatic workflow mode is unavailable: WF-5 live agent runners are not yet available (manual mode only in WF-3)",
            ),
          ),
        )
        .with("live", () => Effect.void)
        .exhaustive(),
    )
    .exhaustive()
