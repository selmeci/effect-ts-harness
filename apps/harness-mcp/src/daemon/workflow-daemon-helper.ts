import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type DaemonHandshakeRequest,
  type DaemonHandshakeResponse,
  DaemonProtocolMismatchDetail,
  DaemonProtocolMismatchError,
  type DaemonSocketPath,
  GitCommonDirPath,
  type LeaseEpoch,
  type ValidatedWorktreeRoot,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  WorkflowProtocolVersion,
} from "@harness/contract"
import { nodeSyncHostIo, resolveWorkflowRuntimePaths } from "@harness/infra"
import {
  type DaemonRequestScopeAllowed,
  type DaemonRequestScopeRejected,
  type DaemonRequestScopeResult,
  type DaemonWorktreeScopeCache,
  type DaemonWorktreeScopeCacheStats,
  makeDaemonWorktreeScopeCache,
  resolveDaemonRequestScope,
  resolveOptionalWorktree,
  type StartupWorktreeState,
  type WorktreeValidatorFn,
} from "./worktree-scope-cache.js"

export {
  type DaemonRequestScopeAllowed,
  type DaemonRequestScopeRejected,
  type DaemonRequestScopeResult,
  type DaemonWorktreeScopeCache,
  type DaemonWorktreeScopeCacheStats,
  makeDaemonWorktreeScopeCache,
  resolveDaemonRequestScope,
  resolveOptionalWorktree,
  type StartupWorktreeState,
  type WorktreeValidatorFn,
}

export const WORKFLOW_DAEMON_CAPABILITIES: ReadonlyArray<WorkflowDaemonCapability> = [
  WorkflowDaemonCapability.make("workflow.handshake"),
  WorkflowDaemonCapability.make("workflow.status"),
]

export interface WorkflowDaemonHandshakeContext {
  readonly repoRoot: AbsoluteRepoRoot
  readonly commonGitDir: GitCommonDirPath
  readonly validatedWorktree: ValidatedWorktreeRoot
  readonly writerLeaseEpoch: LeaseEpoch
  readonly request: DaemonHandshakeRequest
  readonly socketPath?: DaemonSocketPath | undefined
}

export interface WorkflowDaemonProtocolMetadata {
  readonly protocolVersion: WorkflowProtocolVersion
  readonly mismatchDetail?: DaemonProtocolMismatchDetail | undefined
}

export interface DaemonWorkflowHandshakeRequestInput {
  readonly requestId: string
  readonly scope: DaemonRequestScopeAllowed
  readonly writerLeaseEpoch: LeaseEpoch
  readonly protocolVersion?: string | undefined
  readonly commonGitDir?: string | undefined
  readonly requestedRepoRoot?: string | undefined
  readonly socketPath?: DaemonSocketPath | undefined
}

export interface DaemonWorkflowStatusRequestInput {
  readonly requestId: string
  readonly scope: DaemonRequestScopeAllowed
  readonly writerLeaseEpoch: LeaseEpoch
}

const toMismatchDetail = (raw: string): DaemonProtocolMismatchDetail => {
  const sanitized = raw.trim().slice(0, 1024).trim()
  return DaemonProtocolMismatchDetail.make(
    sanitized.length > 0 ? sanitized : "Daemon protocol handshake failed",
  )
}

/**
 * Validates an incoming `workflow.handshake` IPC request against the daemon's
 * protocol version, canonical repo/common-git-dir identity, and active `WfWriterLease` epoch.
 */
export const handleWorkflowDaemonHandshake = Effect.fn("WorkflowDaemonHelper.handshake")(function* (
  context: WorkflowDaemonHandshakeContext,
): Effect.fn.Return<DaemonHandshakeResponse, DaemonProtocolMismatchError> {
  const socketPath =
    context.socketPath ?? resolveWorkflowRuntimePaths(context.commonGitDir).socketPath

  if (context.request.protocolVersion !== WORKFLOW_DAEMON_PROTOCOL_VERSION) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      actualVersion: context.request.protocolVersion,
      socketPath,
      detail: toMismatchDetail(
        `Unsupported daemon protocol version: expected v${WORKFLOW_DAEMON_PROTOCOL_VERSION}, got v${context.request.protocolVersion}`,
      ),
    })
  }

  if (context.request.repoRoot !== context.validatedWorktree.worktreeRoot) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      actualVersion: context.request.protocolVersion,
      socketPath,
      detail: toMismatchDetail(
        `Worktree repoRoot mismatch: expected '${context.validatedWorktree.worktreeRoot}', got '${context.request.repoRoot}'`,
      ),
    })
  }

  if (context.validatedWorktree.commonGitDir !== context.commonGitDir) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      actualVersion: context.request.protocolVersion,
      socketPath,
      detail: toMismatchDetail(
        `Worktree commonGitDir mismatch: expected '${context.commonGitDir}', got '${context.validatedWorktree.commonGitDir}'`,
      ),
    })
  }

  if (
    context.request.commonGitDir !== undefined &&
    context.request.commonGitDir !== context.commonGitDir
  ) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      actualVersion: context.request.protocolVersion,
      socketPath,
      detail: toMismatchDetail(
        `Daemon commonGitDir mismatch: expected '${context.commonGitDir}', got '${context.request.commonGitDir}'`,
      ),
    })
  }

  return {
    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
    capabilities: [...WORKFLOW_DAEMON_CAPABILITIES],
    repoRoot: context.validatedWorktree.worktreeRoot,
    commonGitDir: context.commonGitDir,
    writerLeaseEpoch: context.writerLeaseEpoch,
  }
})

const handshakeErrorPayload = (
  requestId: string,
  detail: string,
  error?: string,
): Record<string, unknown> => ({
  id: requestId,
  ok: false,
  command: "workflow.handshake",
  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
  actualVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
  error: error ?? detail,
  detail,
})

/**
 * Processes a JSON-RPC `workflow.handshake` request over the daemon Unix socket,
 * returning the canonical `{ id, ok: true, command: "workflow.handshake", handshake }` envelope.
 */
export const handleDaemonWorkflowHandshakeRequest = Effect.fn(
  "WorkflowDaemonHelper.handleHandshakeRequest",
)(function* (
  input: DaemonWorkflowHandshakeRequestInput,
): Effect.fn.Return<Record<string, unknown>> {
  const { scope } = input
  const validatedWorktree = scope.validatedWorktree
  if (validatedWorktree === undefined) {
    return handshakeErrorPayload(
      input.requestId,
      "Daemon is not running inside a registered git worktree",
      "Workflow daemon handshake requires a valid git worktree root",
    )
  }

  if (input.protocolVersion === undefined) {
    return handshakeErrorPayload(
      input.requestId,
      "Missing required protocolVersion for workflow.handshake",
    )
  }

  const decodedVersionRes = match(
    Schema.decodeOption(WorkflowProtocolVersion)(input.protocolVersion),
  )
    .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
    .with({ _tag: "None" }, () =>
      Result.fail(
        handshakeErrorPayload(
          input.requestId,
          `Invalid workflow protocolVersion '${input.protocolVersion}'`,
        ),
      ),
    )
    .exhaustive()

  const decodedCommonGitDirRes =
    input.commonGitDir !== undefined
      ? match(Schema.decodeOption(GitCommonDirPath)(input.commonGitDir))
          .with({ _tag: "Some" }, ({ value }) =>
            Result.succeed<GitCommonDirPath | undefined>(value),
          )
          .with({ _tag: "None" }, () =>
            Result.fail(
              handshakeErrorPayload(
                input.requestId,
                `Invalid commonGitDir '${input.commonGitDir}'`,
              ),
            ),
          )
          .exhaustive()
      : Result.succeed<GitCommonDirPath | undefined>(undefined)

  const requestedRepoRoot = input.requestedRepoRoot
  const decodedRepoRootRes =
    requestedRepoRoot !== undefined
      ? (() => {
          const canonicalRequested = match(
            Result.try(() => nodeSyncHostIo.realpathSync(requestedRepoRoot)),
          )
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, () => requestedRepoRoot)
            .exhaustive()
          return match(Schema.decodeOption(AbsoluteRepoRoot)(canonicalRequested))
            .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
            .with({ _tag: "None" }, () =>
              Result.fail(
                handshakeErrorPayload(input.requestId, `Invalid repoRoot '${requestedRepoRoot}'`),
              ),
            )
            .exhaustive()
        })()
      : Result.succeed(validatedWorktree.worktreeRoot)

  const parsedRequestRes = Result.flatMap(decodedVersionRes, (protocolVersion) =>
    Result.flatMap(decodedRepoRootRes, (repoRoot) =>
      Result.map(decodedCommonGitDirRes, (commonGitDir): DaemonHandshakeRequest => ({
        protocolVersion,
        repoRoot,
        ...(commonGitDir !== undefined ? { commonGitDir } : {}),
      })),
    ),
  )

  return yield* match(parsedRequestRes)
    .with({ _tag: "Failure" }, ({ failure: errPayload }) => Effect.succeed(errPayload))
    .with({ _tag: "Success" }, ({ success: request }) =>
      Effect.gen(function* () {
        const commonGitDir = scope.daemonWorktree?.commonGitDir ?? validatedWorktree.commonGitDir
        const handshakeResult = yield* handleWorkflowDaemonHandshake({
          repoRoot: validatedWorktree.worktreeRoot,
          commonGitDir,
          validatedWorktree,
          writerLeaseEpoch: input.writerLeaseEpoch,
          request,
          ...(input.socketPath !== undefined ? { socketPath: input.socketPath } : {}),
        }).pipe(Effect.result)

        return match(handshakeResult)
          .with({ _tag: "Success" }, ({ success: response }) => ({
            id: input.requestId,
            ok: true,
            command: "workflow.handshake",
            handshake: response,
          }))
          .with({ _tag: "Failure" }, ({ failure }) =>
            handshakeErrorPayload(input.requestId, failure.detail, failure.message),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})

/**
 * Processes a JSON-RPC `workflow.status` request over the daemon Unix socket.
 * Reports `status: "ready"` only when an active writer lease (`writerLeaseEpoch >= 1`)
 * and a validated git worktree are both present; otherwise reports `status: "inactive"`.
 */
export const handleDaemonWorkflowStatusRequest = (
  input: DaemonWorkflowStatusRequestInput,
): Record<string, unknown> => {
  const { scope } = input
  const status =
    input.writerLeaseEpoch >= 1 && scope.validatedWorktree !== undefined ? "ready" : "inactive"
  if (scope.validatedWorktree !== undefined) {
    return {
      id: input.requestId,
      ok: true,
      command: "workflow.status",
      status,
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      capabilities: [...WORKFLOW_DAEMON_CAPABILITIES],
      repoRoot: scope.validatedWorktree.worktreeRoot,
      commonGitDir: scope.validatedWorktree.commonGitDir,
      worktreeKind: scope.validatedWorktree.kind,
      writerLeaseEpoch: input.writerLeaseEpoch,
    }
  }
  return {
    id: input.requestId,
    ok: true,
    command: "workflow.status",
    status,
    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
    capabilities: [...WORKFLOW_DAEMON_CAPABILITIES],
    repoRoot: scope.resolvedRoot,
    writerLeaseEpoch: input.writerLeaseEpoch,
  }
}
