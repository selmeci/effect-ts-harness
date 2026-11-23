import { isAbsolute, join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  CompiledPlan,
  EscalationDecision,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowLevel,
  WorkflowRunId,
  WorkflowStatusSummary,
  type WorkflowStoreUnavailableError,
  WorkspaceFilePath,
} from "@harness/contract"
import { readFrictionEvents, resolveHarnessStateDir } from "@harness/gates"
import {
  UnitAgentDispatcherLive,
  abortWorkflowViaDaemon,
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
import { UnitAgentDispatcher } from "@harness/service"
import {
  type CliEnv,
  type CliResult,
  type WorkflowCliDeps,
  findWorkspaceRoot,
  makeReadStdinEffect,
} from "./daemon-and-omnigraph.service.js"
import {
  type ParsedWorkflowFlags,
  type WorkflowCliError,
  type WorkflowCliValidationError,
  assertAutomaticRunnerSupported,
  buildOptionalCompileUnitMode,
  decodeOptional,
  decodeWithLabel,
  formatErrorText,
  formatOutput,
  formatUnitRejectionSummary,
  isWorkflowCliValidationError,
  okResult,
  parseWorkflowCliArgs,
  requireRunId,
  validationFail,
} from "./workflow-command-helpers.js"

export type { WorkflowCliDeps }

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

const resolveActiveRunnerKind = (): Effect.Effect<"live" | "placeholder"> =>
  Effect.serviceOption(UnitAgentDispatcher).pipe(
    Effect.flatMap((opt) =>
      match(opt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value.runnerKind))
        .with({ _tag: "None" }, () =>
          UnitAgentDispatcher.pipe(
            Effect.map((d) => d.runnerKind),
            Effect.provide(UnitAgentDispatcherLive),
          ),
        )
        .exhaustive(),
    ),
  )

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
        return yield* Effect.fail(
          validationFail(
            `Friction log is not cleared (${frictionCount} pending entries at '${frictionPath}'); run 'pnpm harness learn --clear' before completing LLM phase.`,
            { code: "DIRTY_FRICTION_LOG", details: { frictionCount, frictionPath } },
          ),
        )
      }
    }
  })

const executeCompile = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
  runnerKind: "live" | "placeholder",
): Effect.Effect<CliResult, WorkflowCliError> =>
  Effect.gen(function* () {
    const { values } = flags
    const repoRoot = yield* resolveOptionalAbsoluteRepoRoot(values["repo-root"], options)
    const level =
      values.level !== undefined
        ? yield* decodeWithLabel(WorkflowLevel, values.level.trim(), "--level")
        : undefined
    const mode = yield* buildOptionalCompileUnitMode(values)
    if (mode !== undefined) {
      yield* assertAutomaticRunnerSupported(mode, runnerKind)
    }

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
      ...(level !== undefined ? { level } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(inputJsonPath !== undefined ? { inputJsonPath } : {}),
    })
    yield* assertAutomaticRunnerSupported(plan.mode, runnerKind)
    return okResult(yield* Schema.encodeEffect(CompiledPlan)(plan), flags.json)
  })

const executeStart = (
  flags: ParsedWorkflowFlags,
  options: CliEnv | undefined,
  deps: ResolvedWorkflowCliDeps,
  runnerKind: "live" | "placeholder",
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
      return yield* Effect.fail(
        validationFail(
          "workflow start requires --plan <path> or a CompiledPlan JSON payload on stdin",
        ),
      )
    }
    const plan = yield* decodeWithLabel(
      Schema.fromJsonString(CompiledPlan),
      rawPlan,
      "CompiledPlan JSON",
    )
    yield* assertAutomaticRunnerSupported(plan.mode, runnerKind)
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
      return yield* Effect.fail(
        validationFail("workflow complete accepts either --unit <id> or --phase llm, not both"),
      )
    }
    if (values.unit === undefined && values.phase === undefined) {
      return yield* Effect.fail(
        validationFail("workflow complete requires either --unit <id> or --phase llm"),
      )
    }
    const runId = yield* decodeOptional(WorkflowRunId, values["run-id"], "--run-id")

    if (values.phase !== undefined) {
      if (values.phase.trim() !== "llm") {
        return yield* Effect.fail(
          validationFail(`Invalid --phase '${values.phase}': expected 'llm'`),
        )
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
      return yield* Effect.fail(
        validationFail(
          "workflow resume requires both --unit <id> and --decision <retry|abort> together",
        ),
      )
    }
    const runId = yield* requireRunId(values["run-id"], "resume")
    const unitId = yield* decodeOptional(WorkUnitId, values.unit, "--unit")
    const decision = yield* decodeOptional(EscalationDecision, values.decision, "--decision")
    const repoRoot = yield* validateOptionalRepoRoot(values["repo-root"], options, deps)
    const resumeRequest =
      unitId !== undefined && decision !== undefined
        ? ({
            _tag: "ResolveEscalation",
            repoRoot,
            runId,
            unitId,
            decision,
          } as const)
        : ({
            _tag: "ResumeRun",
            repoRoot,
            runId,
          } as const)
    return okResult(yield* deps.resumeWorkflow(resumeRequest, deps.daemonOptions), flags.json)
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
    .with({ _tag: "Success" }, ({ success: parsed }) =>
      Effect.gen(function* () {
        const resolvedDeps = resolveWorkflowDeps(deps ?? options?.workflowDeps)
        const runnerKind = yield* resolveActiveRunnerKind()
        const { flags } = parsed
        const validateRepo = () =>
          validateOptionalRepoRoot(flags.values["repo-root"], options, resolvedDeps)
        const actionEffect: Effect.Effect<CliResult, WorkflowCliError> = match(parsed.action)
          .with("compile", () => executeCompile(flags, options, resolvedDeps, runnerKind))
          .with("start", () => executeStart(flags, options, resolvedDeps, runnerKind))
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
              Effect.flatMap((res) => Schema.encodeEffect(WorkflowStatusSummary)(res)),
              Effect.map((encoded) => okResult(encoded, flags.json)),
            ),
          )
          .with("complete", () => executeComplete(flags, options, resolvedDeps))
          .with("resume", () => executeResume(flags, options, resolvedDeps))
          .with("doctor", () =>
            Effect.gen(function* () {
              const rawMode = flags.values.mode?.trim()
              if (rawMode !== undefined && rawMode !== "rebuild" && rawMode !== "check-only") {
                return yield* Effect.fail(
                  validationFail(`Invalid --mode '${rawMode}': expected 'check-only' or 'rebuild'`),
                )
              }
              if (flags.rebuildViews && rawMode === "check-only") {
                return yield* Effect.fail(
                  validationFail("--rebuild-views cannot be combined with --mode=check-only"),
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

        return yield* actionEffect.pipe(
          Effect.catch((err) => {
            const message = formatErrorText(err)
            const extra = isWorkflowCliValidationError(err)
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
      }),
    )
    .exhaustive()
})
