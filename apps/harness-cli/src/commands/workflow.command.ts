import { isAbsolute, join, resolve } from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  CompiledPlan,
  type DaemonProtocolMismatchError,
  EscalationDecision,
  MaxConcurrency,
  RunnerId,
  type StdinReadError,
  type UnitOutcome,
  UnitMode,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowLevel,
  WorkflowRunId,
  type WorkflowStoreUnavailableError,
  WorkspaceFilePath,
  toErrorReasonMessage,
} from "@harness/contract"
import { readFrictionEvents, resolveHarnessStateDir } from "@harness/gates"
import {
  abortWorkflowViaDaemon,
  type CompileWorkflowPlanError,
  compileWorkflowPlanFromRepo,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  nodeSyncHostIo,
  resumeWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
  type WorkflowDaemonRpcOptions,
} from "@harness/infra"
import {
  type CliEnv,
  type CliResult,
  type WorkflowCliDeps,
  findWorkspaceRoot,
  makeReadStdinEffect,
} from "./daemon-and-omnigraph.service.js"

export type { WorkflowCliDeps }

const WORKFLOW_ACTIONS = [
  "compile",
  "start",
  "status",
  "complete",
  "resume",
  "doctor",
  "abort",
] as const
type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number]
const WORKFLOW_USAGE =
  "usage: harness workflow <compile|start|status|complete|resume|doctor|abort> [options]"
const DEFAULT_WORKFLOW_DEPS = {
  compilePlan: compileWorkflowPlanFromRepo,
  validateRepoRoot: validateWorktreeRepoRoot,
  startWorkflow: startWorkflowViaDaemon,
  getWorkflowStatus: getWorkflowStatusViaDaemon,
  completeWorkflow: completeWorkflowViaDaemon,
  resumeWorkflow: resumeWorkflowViaDaemon,
  doctorWorkflow: doctorWorkflowViaDaemon,
  abortWorkflow: abortWorkflowViaDaemon,
} as const
type ResolvedWorkflowCliDeps = typeof DEFAULT_WORKFLOW_DEPS & {
  readonly daemonOptions: WorkflowDaemonRpcOptions | undefined
}

const VALUE_FLAG_LIST = [
  "level",
  "mode",
  "runner",
  "max-concurrency",
  "input",
  "plan",
  "run-id",
  "unit",
  "phase",
  "repo-root",
  "decision",
] as const
type ValueFlagName = (typeof VALUE_FLAG_LIST)[number]
const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(VALUE_FLAG_LIST)

interface ParsedWorkflowFlags {
  readonly values: Partial<Record<ValueFlagName, string>>
  readonly rebuildViews: boolean
  readonly json: boolean
}

class WorkflowCliValidationError extends Schema.TaggedError<WorkflowCliValidationError>()(
  "WorkflowCliValidationError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  },
) {}

type WorkflowCliError =
  | WorkflowCliValidationError
  | CompileWorkflowPlanError
  | DaemonProtocolMismatchError
  | WorkflowStoreUnavailableError
  | StdinReadError
  | Schema.SchemaError

const isWorkflowAction = (value: string): value is WorkflowAction =>
  (WORKFLOW_ACTIONS as readonly string[]).includes(value)

const isValueFlagName = (value: string): value is ValueFlagName => VALUE_FLAG_NAMES.has(value)

const validationFail = (
  message: string,
  extra?: {
    readonly code?: string | undefined
    readonly details?: Readonly<Record<string, unknown>> | undefined
  },
) =>
  new WorkflowCliValidationError({
    message,
    ...(extra?.code !== undefined ? { code: extra.code } : {}),
    ...(extra?.details !== undefined ? { extra: extra.details } : {}),
  })

const parseWorkflowCliArgs = (
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

const formatOutput = (payload: unknown, compactJson: boolean): string =>
  compactJson ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)

const okResult = (payload: unknown, compactJson: boolean): CliResult => ({
  exitCode: 0,
  stdout: formatOutput(payload, compactJson),
  stderr: "",
})

const formatErrorText = (err: unknown): string =>
  toErrorReasonMessage(err, "Workflow command failed")

const decodeWithLabel = <A, E, R>(
  schema: Schema.Codec<A, unknown, R, E>,
  value: unknown,
  label: string,
): Effect.Effect<A, WorkflowCliValidationError, R> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((err) => validationFail(`Invalid ${label}: ${formatErrorText(err)}`)),
  )

const decodeOptional = <A, E, R>(
  schema: Schema.Codec<A, unknown, R, E>,
  raw: string | undefined,
  label: string,
): Effect.Effect<A | undefined, WorkflowCliValidationError, R> =>
  raw !== undefined
    ? decodeWithLabel(schema, raw.trim(), label)
    : Effect.map(Effect.succeed(Option.none<A>()), Option.getOrUndefined)

const requireRunId = (rawRunId: string | undefined, action: string) =>
  rawRunId === undefined
    ? Effect.fail(validationFail(`workflow ${action} requires --run-id <id>`))
    : decodeWithLabel(WorkflowRunId, rawRunId.trim(), "--run-id")

const resolveOptionalAbsoluteRepoRoot = (
  rawFlag: string | undefined,
  options: CliEnv | undefined,
): Effect.Effect<AbsoluteRepoRoot, WorkflowCliValidationError> => {
  const baseCwd = options?.cwd ?? process.cwd()
  const candidate =
    rawFlag !== undefined
      ? resolve(baseCwd, rawFlag)
      : (options?.repoRoot ?? findWorkspaceRoot(baseCwd))
  return decodeWithLabel(AbsoluteRepoRoot, candidate, "--repo-root")
}

const resolveExplicitAbsoluteRepoRoot = (
  rawFlag: string | undefined,
): Effect.Effect<AbsoluteRepoRoot, WorkflowCliValidationError> => {
  if (rawFlag === undefined) {
    return Effect.fail(
      validationFail("workflow complete requires explicit absolute --repo-root <abs-path>"),
    )
  }
  const trimmed = rawFlag.trim()
  if (!isAbsolute(trimmed)) {
    return Effect.fail(
      validationFail(`--repo-root must be an explicit absolute path (got '${rawFlag}')`),
    )
  }
  return decodeWithLabel(AbsoluteRepoRoot, trimmed, "--repo-root")
}

const validateOptionalRepoRoot = (
  rawFlag: string | undefined,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
): Effect.Effect<AbsoluteRepoRoot, WorkflowCliValidationError | WorkflowStoreUnavailableError> =>
  resolveOptionalAbsoluteRepoRoot(rawFlag, options).pipe(
    Effect.flatMap((absRoot) => deps.validateRepoRoot(absRoot)),
    Effect.map((validated) => validated.worktreeRoot),
  )

const checkFrictionLogCleared = (
  repoRoot: AbsoluteRepoRoot,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, WorkflowCliValidationError> =>
  Effect.gen(function* () {
    const candidateEnvs: Array<Readonly<Record<string, string | undefined>>> = [{}]
    if (
      (env["HARNESS_STATE_DIR"]?.trim().length ?? 0) > 0 ||
      (env["HARNESS_WORKTREE_ID"]?.trim().length ?? 0) > 0
    ) {
      candidateEnvs.push(env)
    }
    const checkedDirs = new Set<string>()
    for (const candidateEnv of candidateEnvs) {
      const stateDir = yield* Effect.try({
        try: () => resolveHarnessStateDir(repoRoot, candidateEnv),
        catch: (err) =>
          validationFail(`Failed to resolve harness state directory: ${formatErrorText(err)}`),
      })
      if (checkedDirs.has(stateDir)) continue
      checkedDirs.add(stateDir)
      const frictionPath = join(stateDir, "friction-log.jsonl")
      if (!nodeSyncHostIo.existsSync(frictionPath) || !nodeSyncHostIo.isFileSync(frictionPath)) {
        continue
      }
      const events = readFrictionEvents(repoRoot, { ...nodeSyncHostIo, getEnv: () => candidateEnv })
      const rawText = yield* Effect.try({
        try: () => nodeSyncHostIo.readTextSync(frictionPath),
        catch: (err) =>
          validationFail(`Failed to read friction log '${frictionPath}': ${formatErrorText(err)}`),
      })
      if (events.length > 0 || rawText.trim().length > 0) {
        const frictionCount =
          events.length > 0
            ? events.length
            : rawText.split(/\r?\n/).filter((line) => line.trim().length > 0).length
        return yield* validationFail(
          `Friction log is not cleared (${frictionCount} pending entries at '${frictionPath}'); run 'pnpm harness learn --clear' before completing LLM phase.`,
          { code: "DIRTY_FRICTION_LOG", details: { frictionCount, frictionPath } },
        )
      }
    }
  })

const formatUnitRejectionSummary = (
  outcome: Extract<UnitOutcome, { readonly _tag: "Rejected" }>,
): string =>
  match(outcome.rejection)
    .with(
      { _tag: "WriteSetViolation" },
      ({ offendingPaths }) =>
        `Unit '${outcome.unitId}' rejected (WriteSetViolation): ${offendingPaths.join(", ")}`,
    )
    .with(
      { _tag: "PackageVerifyFailed" },
      ({ exitCode }) =>
        `Unit '${outcome.unitId}' rejected (PackageVerifyFailed, exitCode=${exitCode})`,
    )
    .with({ _tag: "StampMissing" }, () => `Unit '${outcome.unitId}' rejected (StampMissing)`)
    .with(
      { _tag: "AgentFailed" },
      ({ reason }) => `Unit '${outcome.unitId}' rejected (AgentFailed): ${reason}`,
    )
    .exhaustive()

const buildCompileUnitMode = (
  values: ParsedWorkflowFlags["values"],
): Effect.Effect<UnitMode, WorkflowCliValidationError> =>
  Effect.gen(function* () {
    const modeStr = (values.mode ?? "manual").trim()
    if (modeStr !== "manual" && modeStr !== "automatic") {
      return yield* validationFail(`Invalid --mode '${modeStr}': expected 'manual' or 'automatic'`)
    }
    if (modeStr === "manual") {
      if (values.runner !== undefined || values["max-concurrency"] !== undefined) {
        return yield* validationFail("--runner and --max-concurrency require --mode automatic")
      }
      return yield* decodeWithLabel(UnitMode, { _tag: "Manual" }, "--mode")
    }
    if (values.runner === undefined) {
      return yield* validationFail("--mode automatic requires --runner <claude-code|antigravity>")
    }
    const runner = yield* decodeWithLabel(RunnerId, values.runner.trim(), "--runner")
    let maxConcurrency = MaxConcurrency.make(4)
    if (values["max-concurrency"] !== undefined) {
      const rawMax = values["max-concurrency"].trim()
      if (!/^\d+$/.test(rawMax)) {
        return yield* validationFail(`Invalid --max-concurrency '${rawMax}': expected integer 1..8`)
      }
      maxConcurrency = yield* decodeWithLabel(
        MaxConcurrency,
        Number.parseInt(rawMax, 10),
        "--max-concurrency",
      )
    }
    return yield* decodeWithLabel(UnitMode, { _tag: "Automatic", runner, maxConcurrency }, "--mode")
  })

const executeCompile = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
): Effect.Effect<CliResult, WorkflowCliError> =>
  Effect.gen(function* () {
    const { values } = flags
    const repoRoot = yield* resolveOptionalAbsoluteRepoRoot(values["repo-root"], options)
    const level = yield* decodeWithLabel(WorkflowLevel, (values.level ?? "slice").trim(), "--level")
    const mode = yield* buildCompileUnitMode(values)
    let inputJsonPath: WorkspaceFilePath | undefined
    if (values.input !== undefined) {
      const baseCwd = options?.cwd ?? process.cwd()
      const cwdCandidate = resolve(baseCwd, values.input)
      const effectiveInput =
        !isAbsolute(values.input) && nodeSyncHostIo.existsSync(cwdCandidate)
          ? cwdCandidate
          : values.input
      inputJsonPath = yield* decodeWithLabel(WorkspaceFilePath, effectiveInput, "--input")
    }
    const plan = yield* deps.compilePlan({
      repoRoot,
      level,
      mode,
      ...(inputJsonPath !== undefined ? { inputJsonPath } : {}),
    })
    return okResult(yield* Schema.encodeEffect(CompiledPlan)(plan), flags.json)
  })

const executeStart = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
): Effect.Effect<CliResult, WorkflowCliError> =>
  Effect.gen(function* () {
    const { values } = flags
    const baseCwd = options?.cwd ?? options?.repoRoot ?? process.cwd()
    const rawPlan =
      values.plan !== undefined
        ? yield* Effect.try({
            try: () => nodeSyncHostIo.readTextSync(resolve(baseCwd, values.plan!)),
            catch: (err) =>
              validationFail(`Failed to read plan file '${values.plan}': ${formatErrorText(err)}`),
          })
        : options?.stdin !== undefined
          ? options.stdin
          : yield* makeReadStdinEffect({
              timeoutMs: options?.stdinTimeoutMs,
              maxBytes: options?.stdinMaxBytes,
            })

    if (rawPlan.trim().length === 0) {
      return yield* validationFail(
        "workflow start requires --plan <path> or a CompiledPlan JSON payload on stdin",
      )
    }
    const plan = yield* decodeWithLabel(
      Schema.fromJsonString(CompiledPlan),
      rawPlan,
      "CompiledPlan JSON",
    )
    const repoRoot = yield* validateOptionalRepoRoot(values["repo-root"], options, deps)
    return okResult(yield* deps.startWorkflow({ repoRoot, plan }, deps.daemonOptions), flags.json)
  })

const executeComplete = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
): Effect.Effect<CliResult, WorkflowCliError> =>
  Effect.gen(function* () {
    const { values } = flags
    const explicitRoot = yield* resolveExplicitAbsoluteRepoRoot(values["repo-root"])
    const validated = yield* deps.validateRepoRoot(explicitRoot)
    if (values.unit !== undefined && values.phase !== undefined) {
      return yield* validationFail(
        "workflow complete accepts either --unit <id> or --phase llm, not both",
      )
    }
    if (values.unit === undefined && values.phase === undefined) {
      return yield* validationFail("workflow complete requires either --unit <id> or --phase llm")
    }
    const runId = yield* decodeOptional(WorkflowRunId, values["run-id"], "--run-id")

    if (values.phase !== undefined) {
      if (values.phase.trim() !== "llm") {
        return yield* validationFail(`Invalid --phase '${values.phase}': expected 'llm'`)
      }
      yield* checkFrictionLogCleared(validated.worktreeRoot, { ...process.env, ...options?.env })
      return okResult(
        yield* deps.completeWorkflow(
          {
            _tag: "CompleteLlmPhase",
            repoRoot: validated.worktreeRoot,
            ...(runId !== undefined ? { runId } : {}),
          },
          deps.daemonOptions,
        ),
        flags.json,
      )
    }

    const unitId = yield* decodeWithLabel(WorkUnitId, values.unit!.trim(), "--unit")
    const res = yield* deps.completeWorkflow(
      {
        _tag: "CompleteUnit",
        repoRoot: validated.worktreeRoot,
        unitId,
        ...(runId !== undefined ? { runId } : {}),
      },
      deps.daemonOptions,
    )

    return match(res)
      .with({ _tag: "LlmPhaseCompleted" }, () => okResult(res, flags.json))
      .with({ _tag: "UnitCompleted" }, ({ outcome }) =>
        match(outcome)
          .with({ _tag: "Completed" }, () => okResult(res, flags.json))
          .with({ _tag: "Rejected" }, (rejected) => ({
            exitCode: 1,
            stdout: formatOutput(res, flags.json),
            stderr: `${formatUnitRejectionSummary(rejected)}\n`,
          }))
          .with({ _tag: "Escalated" }, (escalated) => ({
            exitCode: 1,
            stdout: formatOutput(res, flags.json),
            stderr: `Unit '${escalated.unitId}' escalated (${escalated.escalation._tag})\n`,
          }))
          .exhaustive(),
      )
      .exhaustive()
  })

const executeResume = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
): Effect.Effect<CliResult, WorkflowCliError> =>
  Effect.gen(function* () {
    const { values } = flags
    if ((values.unit !== undefined) !== (values.decision !== undefined)) {
      return yield* validationFail(
        "workflow resume requires both --unit <id> and --decision <retry|abort> together",
      )
    }
    const runId = yield* requireRunId(values["run-id"], "resume")
    const unitId = yield* decodeOptional(WorkUnitId, values.unit, "--unit")
    const decision = yield* decodeOptional(EscalationDecision, values.decision, "--decision")
    const repoRoot = yield* validateOptionalRepoRoot(values["repo-root"], options, deps)
    return okResult(
      yield* deps.resumeWorkflow(
        {
          repoRoot,
          runId,
          ...(unitId !== undefined ? { unitId } : {}),
          ...(decision !== undefined ? { decision } : {}),
        },
        deps.daemonOptions,
      ),
      flags.json,
    )
  })

const resolveWorkflowDeps = (deps?: WorkflowCliDeps): ResolvedWorkflowCliDeps => ({
  daemonOptions: deps?.daemonOptions,
  compilePlan: deps?.compilePlan ?? DEFAULT_WORKFLOW_DEPS.compilePlan,
  validateRepoRoot: deps?.validateRepoRoot ?? DEFAULT_WORKFLOW_DEPS.validateRepoRoot,
  startWorkflow: deps?.startWorkflow ?? DEFAULT_WORKFLOW_DEPS.startWorkflow,
  getWorkflowStatus: deps?.getWorkflowStatus ?? DEFAULT_WORKFLOW_DEPS.getWorkflowStatus,
  completeWorkflow: deps?.completeWorkflow ?? DEFAULT_WORKFLOW_DEPS.completeWorkflow,
  resumeWorkflow: deps?.resumeWorkflow ?? DEFAULT_WORKFLOW_DEPS.resumeWorkflow,
  doctorWorkflow: deps?.doctorWorkflow ?? DEFAULT_WORKFLOW_DEPS.doctorWorkflow,
  abortWorkflow: deps?.abortWorkflow ?? DEFAULT_WORKFLOW_DEPS.abortWorkflow,
})

/** Executes `harness workflow <compile|start|status|complete|resume|doctor|abort>`. */
export const handleWorkflow = Effect.fn("HarnessCli.workflow")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
  deps?: WorkflowCliDeps,
): Effect.fn.Return<CliResult> {
  const parsedRes = parseWorkflowCliArgs(args)
  return yield* match(parsedRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: args.includes("--json")
          ? JSON.stringify({ ok: false, error: failure.message })
          : "",
        stderr: `${failure.message}\n`,
      }),
    )
    .with({ _tag: "Success" }, ({ success: parsed }) => {
      const resolvedDeps = resolveWorkflowDeps(deps ?? options?.workflowDeps)
      const { flags } = parsed
      const validateRepo = () =>
        validateOptionalRepoRoot(flags.values["repo-root"], options, resolvedDeps)
      const actionEffect: Effect.Effect<CliResult, WorkflowCliError> = match(parsed.action)
        .with("compile", () => executeCompile(flags, options, resolvedDeps))
        .with("start", () => executeStart(flags, options, resolvedDeps))
        .with("status", () =>
          validateRepo().pipe(
            Effect.flatMap((repoRoot) =>
              decodeOptional(WorkflowRunId, flags.values["run-id"], "--run-id").pipe(
                Effect.flatMap((runId) =>
                  resolvedDeps.getWorkflowStatus(
                    { repoRoot, ...(runId !== undefined ? { runId } : {}) },
                    resolvedDeps.daemonOptions,
                  ),
                ),
              ),
            ),
            Effect.map((res) => okResult(res, flags.json)),
          ),
        )
        .with("complete", () => executeComplete(flags, options, resolvedDeps))
        .with("resume", () => executeResume(flags, options, resolvedDeps))
        .with("doctor", () =>
          Effect.gen(function* () {
            const rawMode = flags.values.mode?.trim()
            if (rawMode !== undefined && rawMode !== "rebuild" && rawMode !== "check-only") {
              return yield* validationFail(
                `Invalid --mode '${rawMode}': expected 'check-only' or 'rebuild'`,
              )
            }
            if (flags.rebuildViews && rawMode === "check-only") {
              return yield* validationFail(
                "--rebuild-views cannot be combined with --mode=check-only",
              )
            }
            const mode = WorkflowDoctorMode.make(
              flags.rebuildViews || rawMode === "rebuild" ? "rebuild" : "check-only",
            )
            const repoRoot = yield* validateRepo()
            return okResult(
              yield* resolvedDeps.doctorWorkflow({ repoRoot, mode }, resolvedDeps.daemonOptions),
              flags.json,
            )
          }),
        )
        .with("abort", () =>
          requireRunId(flags.values["run-id"], "abort").pipe(
            Effect.flatMap((runId) =>
              validateRepo().pipe(
                Effect.flatMap((repoRoot) =>
                  resolvedDeps.abortWorkflow({ repoRoot, runId }, resolvedDeps.daemonOptions),
                ),
              ),
            ),
            Effect.map((res) => okResult(res, flags.json)),
          ),
        )
        .exhaustive()

      return actionEffect.pipe(
        Effect.catch((err) => {
          const message = formatErrorText(err)
          const extra =
            err instanceof WorkflowCliValidationError
              ? { ...(err.code !== undefined ? { code: err.code } : {}), ...err.extra }
              : {}
          const hasStructured =
            flags.json || parsed.action === "complete" || Object.keys(extra).length > 0
          return Effect.succeed<CliResult>({
            exitCode: 1,
            stdout: hasStructured
              ? formatOutput({ ok: false, error: message, ...extra }, flags.json)
              : "",
            stderr: `${message}\n`,
          })
        }),
      )
    })
    .exhaustive()
})
