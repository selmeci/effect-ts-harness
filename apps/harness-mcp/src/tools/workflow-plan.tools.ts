import * as path from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type WorkflowPlanToolOutput,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowStatusSummary,
} from "@harness/contract"
import {
  UnixSocketDaemonLive,
  getWorkflowStatusViaDaemon,
  nodeSyncHostIo,
  resolveWorkflowRuntimePaths,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { UnixSocketDaemonPort } from "@harness/service"
import {
  McpToolName,
  type McpToolExecutionError,
  type McpToolPluginDescriptor,
  ProjectPathEscapeError,
  type ServerOptions,
  isPathInsideRoot,
  resolveDefaultRepoRoot,
} from "./mcp-helpers.js"

const BoundedRepoRoot = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
)

/** Input schema for read-only MCP tool `harness_workflow_plan`. */
export const WorkflowPlanToolInputSchema = Schema.Struct({
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description:
        "Optional repository root or worktree path validated via validateWorktreeRepoRoot",
    }),
  ),
  runId: Schema.optional(
    WorkflowRunId.annotate({
      description: "Optional workflow runId (defaults to the latest recorded run)",
    }),
  ),
})
export type WorkflowPlanToolInput = typeof WorkflowPlanToolInputSchema.Type

const decodeWorkflowPlanInput = Schema.decodeUnknownEffect(WorkflowPlanToolInputSchema)
const decodeAbsoluteRepoRoot = Schema.decodeUnknownEffect(AbsoluteRepoRoot)

const toCanonicalPathOrRaw = (rawPath: string): string =>
  match(Result.try(() => nodeSyncHostIo.realpathSync(rawPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => rawPath)
    .exhaustive()

const makeOfflineWorkflowSummary = (): WorkflowStatusSummary =>
  WorkflowStatusSummary.cases.DaemonOffline.make({
    outcome: WorkflowRunOutcome.cases.NotFound.make({}),
  })

const isSocketTransportUnavailableReason = (reason: string): boolean =>
  reason.startsWith("Daemon socket unavailable") ||
  reason.startsWith("Daemon closed IPC connection") ||
  reason.startsWith("Daemon IPC socket error")

const resolveCandidateRepoRoot = (
  inputRepoRoot: string | undefined,
  options?: ServerOptions,
): Effect.Effect<AbsoluteRepoRoot, ProjectPathEscapeError> =>
  Effect.gen(function* () {
    if (inputRepoRoot === undefined) {
      const fallbackRaw = options?.repoRoot ?? resolveDefaultRepoRoot(undefined, options)
      const canonical = toCanonicalPathOrRaw(fallbackRaw)
      return yield* decodeAbsoluteRepoRoot(canonical).pipe(
        Effect.mapError(
          () =>
            new ProjectPathEscapeError({
              projectPath: fallbackRaw,
              repoRoot: fallbackRaw,
              message: `Resolved repository root '${fallbackRaw}' is not a valid absolute path.`,
            }),
        ),
      )
    }

    if (inputRepoRoot.includes("\0")) {
      return yield* new ProjectPathEscapeError({
        projectPath: inputRepoRoot,
        repoRoot: options?.repoRoot ?? process.cwd(),
        message: `Repository root '${inputRepoRoot}' contains invalid NUL bytes.`,
      })
    }

    const baseForRelative = options?.repoRoot ?? process.cwd()
    if (!path.isAbsolute(inputRepoRoot)) {
      const resolvedRel = path.resolve(baseForRelative, inputRepoRoot)
      if (!isPathInsideRoot(baseForRelative, resolvedRel)) {
        return yield* new ProjectPathEscapeError({
          projectPath: inputRepoRoot,
          repoRoot: baseForRelative,
          message: `Repository path '${inputRepoRoot}' escapes repository root '${baseForRelative}'.`,
        })
      }
      const canonicalRel = toCanonicalPathOrRaw(resolvedRel)
      return yield* decodeAbsoluteRepoRoot(canonicalRel).pipe(
        Effect.mapError(
          () =>
            new ProjectPathEscapeError({
              projectPath: inputRepoRoot,
              repoRoot: baseForRelative,
              message: `Repository path '${inputRepoRoot}' is not a valid absolute repository root.`,
            }),
        ),
      )
    }

    const canonicalAbs = toCanonicalPathOrRaw(path.resolve(inputRepoRoot))
    return yield* decodeAbsoluteRepoRoot(canonicalAbs).pipe(
      Effect.mapError(
        () =>
          new ProjectPathEscapeError({
            projectPath: inputRepoRoot,
            repoRoot: options?.repoRoot ?? inputRepoRoot,
            message: `Repository path '${inputRepoRoot}' is not a valid absolute repository root.`,
          }),
      ),
    )
  })

/** Executes read-only `harness_workflow_plan` status lookup against daemon IPC without mutating state. */
export const executeWorkflowPlanTool = Effect.fn("HarnessMcp.workflowPlan")(function* (
  input: WorkflowPlanToolInput,
  options?: ServerOptions,
): Effect.fn.Return<WorkflowPlanToolOutput, McpToolExecutionError> {
  const candidateRoot = yield* resolveCandidateRepoRoot(input.repoRoot, options)
  const validated = yield* validateWorktreeRepoRoot(candidateRoot)

  if (options?.repoRoot !== undefined && input.repoRoot !== undefined) {
    const baseCanonical = toCanonicalPathOrRaw(options.repoRoot)
    const baseAbs = yield* decodeAbsoluteRepoRoot(baseCanonical).pipe(
      Effect.mapError(
        () =>
          new ProjectPathEscapeError({
            projectPath: input.repoRoot!,
            repoRoot: options.repoRoot!,
            message: `Configured base repoRoot '${options.repoRoot}' is invalid.`,
          }),
      ),
    )
    const baseValidated = yield* validateWorktreeRepoRoot(baseAbs)
    if (validated.commonGitDir !== baseValidated.commonGitDir) {
      return yield* new ProjectPathEscapeError({
        projectPath: input.repoRoot,
        repoRoot: options.repoRoot,
        message: `Worktree '${validated.worktreeRoot}' escapes repository '${baseValidated.worktreeRoot}'.`,
      })
    }
  }

  const runtimePaths = resolveWorkflowRuntimePaths(validated.commonGitDir)
  const isAlive = yield* Effect.gen(function* () {
    const daemon = yield* UnixSocketDaemonPort
    return yield* daemon.isSocketAlive(runtimePaths.socketPath)
  }).pipe(Effect.provide(UnixSocketDaemonLive))

  if (!isAlive) {
    return {
      resolvedRepoRoot: validated.worktreeRoot,
      commonGitDir: validated.commonGitDir,
      status: makeOfflineWorkflowSummary(),
    } satisfies WorkflowPlanToolOutput
  }

  const statusResult = yield* getWorkflowStatusViaDaemon(
    {
      repoRoot: validated.worktreeRoot,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    },
    {
      socketPath: runtimePaths.socketPath,
      commonGitDir: validated.commonGitDir,
      requireActiveLease: false,
    },
  ).pipe(
    Effect.catchTag("WorkflowStoreUnavailableError", (err) =>
      isSocketTransportUnavailableReason(err.reason)
        ? Effect.succeed(makeOfflineWorkflowSummary())
        : Effect.fail(err),
    ),
  )

  return {
    resolvedRepoRoot: validated.worktreeRoot,
    commonGitDir: validated.commonGitDir,
    status: statusResult,
  } satisfies WorkflowPlanToolOutput
})

/** Descriptor factory for `harness_workflow_plan`. */
export const buildWorkflowPlanToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_workflow_plan"),
    description:
      "Read-only status inspection of the active or latest HarnessTaskWorkflow run, units, pending DurableDeferreds, and worktree/commonGitDir binding.",
    inputSchema: WorkflowPlanToolInputSchema,
    execute: (args) =>
      decodeWorkflowPlanInput(args).pipe(
        Effect.flatMap((decoded) => executeWorkflowPlanTool(decoded, options)),
      ),
  },
]
