import { randomUUID } from "node:crypto"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonProtocolMismatchDetail,
  DaemonProtocolMismatchError,
  type DaemonSocketPath,
  type GitCommonDirPath,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowAbortRequest,
  WorkflowAbortResponse,
  WorkflowCompleteRequest,
  WorkflowCompleteResponse,
  WorkflowDaemonCapability,
  WorkflowDoctorRequest,
  WorkflowDoctorResponse,
  WorkflowProtocolVersion,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  WorkflowStartRequest,
  WorkflowStartResponse,
  WorkflowStatusRequest,
  WorkflowStatusSummary,
  type WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  toBoundedReason,
} from "@harness/contract"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  type UnixSocketQueryReason,
  queryUnixSocketLineDetailed,
} from "../unix-socket-daemon-live.js"
import { resolveWorkflowRuntimePaths, validateWorktreeRepoRoot } from "../worktree-repo-root.js"

const canonicalPathOrRaw = (filePath: string): string =>
  match(Result.try(() => nodeSyncHostIo.realpathSync(filePath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => filePath)
    .exhaustive()

/** Dedicated workflow daemon IPC timeout (decoupled from the 5 s LSP query socket timeout). */
export const WORKFLOW_DAEMON_IPC_TIMEOUT_MS = 30_000

const HANDSHAKE_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.handshake")
const QUERY_COMMAND_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.queryCommand")

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecordOption = Schema.decodeUnknownOption(JsonRecordSchema)
const decodeHandshakeResponseOption = Schema.decodeUnknownOption(DaemonHandshakeResponse)
const decodeProtocolVersionOption = Schema.decodeUnknownOption(WorkflowProtocolVersion)

const CanonicalHandshakeEnvelopeSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  ok: Schema.Literal(true),
  handshake: Schema.Record(Schema.String, Schema.Unknown),
})
const decodeCanonicalHandshakeEnvelopeOption = Schema.decodeUnknownOption(
  CanonicalHandshakeEnvelopeSchema,
)

const toStoreFailureReason = (raw: string): WorkflowStoreFailureReason =>
  toBoundedReason(raw, "Workflow daemon IPC transport unavailable")

const toMismatchDetail = (raw: string): DaemonProtocolMismatchDetail => {
  const sanitized = raw.trim().slice(0, 1024).trim()
  return DaemonProtocolMismatchDetail.make(
    sanitized.length > 0 ? sanitized : "Daemon protocol handshake failed",
  )
}

const formatUnavailableReason = (
  reason: UnixSocketQueryReason,
  detail: string | undefined,
  socketPath: DaemonSocketPath,
): WorkflowStoreFailureReason => {
  const base = match(reason)
    .with("missing-or-refused", () => `Daemon socket unavailable at '${socketPath}'`)
    .with("timeout", () => `Daemon IPC timed out at '${socketPath}'`)
    .with("overflow", () => `Daemon IPC response exceeded buffer limit at '${socketPath}'`)
    .with("closed", () => `Daemon closed IPC connection prematurely at '${socketPath}'`)
    .with("socket-error", () => `Daemon IPC socket error at '${socketPath}'`)
    .exhaustive()
  const detailTrimmed = detail?.trim()
  return toStoreFailureReason(
    detailTrimmed !== undefined && detailTrimmed.length > 0 ? `${base}: ${detailTrimmed}` : base,
  )
}

const extractOptionalProtocolVersion = (value: unknown): WorkflowProtocolVersion | undefined =>
  match(decodeProtocolVersionOption(value))
    .with({ _tag: "Some" }, ({ value: version }) => version)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const extractStringField = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const candidate = record[key]
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined
}

export interface WorkflowDaemonHandshakeInput {
  readonly socketPath: DaemonSocketPath
  readonly request: DaemonHandshakeRequest
  readonly requiredCapabilities: ReadonlyArray<WorkflowDaemonCapability>
  readonly requireActiveLease?: boolean | undefined
}

export interface WorkflowDaemonExpectedProtocol {
  readonly version: WorkflowProtocolVersion
  readonly mismatchDetail?: DaemonProtocolMismatchDetail | undefined
}

export interface WorkflowDaemonCommandInput {
  readonly socketPath: DaemonSocketPath
  readonly command: string
  readonly payload?: Readonly<Record<string, unknown>> | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * Sends a single-line JSON workflow command over the canonical Unix daemon socket
 * using `WORKFLOW_DAEMON_IPC_TIMEOUT_MS` by default.
 */
export const queryWorkflowDaemonCommand = Effect.fn("HarnessDaemonClient.queryCommand")(function* (
  input: WorkflowDaemonCommandInput,
): Effect.fn.Return<Readonly<Record<string, unknown>>, WorkflowStoreUnavailableError> {
  const requestPayload = {
    ...input.payload,
    id: randomUUID(),
    command: input.command,
  }
  const queryResult = yield* queryUnixSocketLineDetailed(
    input.socketPath,
    JSON.stringify(requestPayload),
    { timeoutMs: input.timeoutMs ?? WORKFLOW_DAEMON_IPC_TIMEOUT_MS },
  )

  return yield* match(queryResult)
    .with({ _tag: "Unavailable" }, ({ reason, detail }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: QUERY_COMMAND_OPERATION,
          reason: formatUnavailableReason(reason, detail, input.socketPath),
        }),
      ),
    )
    .with({ _tag: "Reply" }, ({ line }) =>
      match(decodeJsonRecordOption(line))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation: QUERY_COMMAND_OPERATION,
              reason: toStoreFailureReason(
                `Daemon returned invalid JSON reply for '${input.command}'`,
              ),
            }),
          ),
        )
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .exhaustive(),
    )
    .exhaustive()
})

/**
 * Connects to `<git-common-dir>/harness/daemon.sock`, runs the `workflow.handshake`
 * RPC with `WORKFLOW_DAEMON_IPC_TIMEOUT_MS`, and fails explicitly with
 * `DaemonProtocolMismatchError` if the running daemon is stale or lacks required handlers.
 */
export const handshakeWorkflowDaemon = Effect.fn("HarnessDaemonClient.handshake")(function* (
  input: WorkflowDaemonHandshakeInput,
): Effect.fn.Return<
  DaemonHandshakeResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  const requestId = randomUUID()
  const expectedVersion = input.request.protocolVersion ?? WORKFLOW_DAEMON_PROTOCOL_VERSION
  const requireActiveLease = input.requireActiveLease ?? true
  const requestPayload = {
    id: requestId,
    command: "workflow.handshake",
    repoRoot: input.request.repoRoot,
    protocolVersion: expectedVersion,
    ...(input.request.commonGitDir !== undefined
      ? { commonGitDir: input.request.commonGitDir }
      : {}),
  }

  const queryResult = yield* queryUnixSocketLineDetailed(
    input.socketPath,
    JSON.stringify(requestPayload),
    { timeoutMs: WORKFLOW_DAEMON_IPC_TIMEOUT_MS },
  )

  const replyLine = yield* match(queryResult)
    .with({ _tag: "Unavailable" }, ({ reason, detail }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: HANDSHAKE_OPERATION,
          reason: formatUnavailableReason(reason, detail, input.socketPath),
        }),
      ),
    )
    .with({ _tag: "Reply" }, ({ line }) => Effect.succeed(line))
    .exhaustive()

  const record = yield* match(decodeJsonRecordOption(replyLine))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new DaemonProtocolMismatchError({
          expectedVersion,
          socketPath: input.socketPath,
          detail: toMismatchDetail("Daemon returned invalid JSON response to workflow.handshake"),
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .exhaustive()

  const errorMessage = extractStringField(record, "error")
  if (record.ok === false || errorMessage !== undefined) {
    const actualVersion =
      extractOptionalProtocolVersion(record.actualVersion) ??
      extractOptionalProtocolVersion(record.protocolVersion)
    const detailText =
      extractStringField(record, "detail") ?? errorMessage ?? "Daemon rejected workflow.handshake"
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      ...(actualVersion !== undefined ? { actualVersion } : {}),
      socketPath: input.socketPath,
      detail: toMismatchDetail(detailText),
    })
  }

  const envelope = yield* match(decodeCanonicalHandshakeEnvelopeOption(record))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new DaemonProtocolMismatchError({
          expectedVersion,
          socketPath: input.socketPath,
          detail: toMismatchDetail(
            "Daemon response missing canonical { id, ok: true, handshake } envelope",
          ),
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .exhaustive()

  if (envelope.id !== requestId) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Daemon handshake response id mismatch: expected '${requestId}', got '${envelope.id}'`,
      ),
    })
  }

  const candidate = envelope.handshake

  const actualVersion = extractOptionalProtocolVersion(candidate.protocolVersion)
  if (actualVersion === undefined) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        "Daemon response missing valid protocolVersion for workflow.handshake",
      ),
    })
  }

  if (actualVersion !== expectedVersion) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      actualVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Protocol version mismatch: expected v${expectedVersion}, got v${actualVersion}`,
      ),
    })
  }

  const response = yield* match(decodeHandshakeResponseOption(candidate))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new DaemonProtocolMismatchError({
          expectedVersion,
          actualVersion,
          socketPath: input.socketPath,
          detail: toMismatchDetail("Daemon returned malformed workflow.handshake payload"),
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .exhaustive()

  if (
    response.repoRoot !== input.request.repoRoot &&
    canonicalPathOrRaw(response.repoRoot) !== canonicalPathOrRaw(input.request.repoRoot)
  ) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      actualVersion: response.protocolVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Daemon repoRoot mismatch: expected '${input.request.repoRoot}', got '${response.repoRoot}'`,
      ),
    })
  }

  if (
    input.request.commonGitDir !== undefined &&
    response.commonGitDir !== input.request.commonGitDir
  ) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      actualVersion: response.protocolVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Daemon commonGitDir mismatch: expected '${input.request.commonGitDir}', got '${response.commonGitDir}'`,
      ),
    })
  }

  const advertisedCapabilities = new Set(response.capabilities)
  const missingCapabilities = input.requiredCapabilities.filter(
    (capability) => !advertisedCapabilities.has(capability),
  )
  if (missingCapabilities.length > 0) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      actualVersion: response.protocolVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Daemon missing required workflow capabilities: ${missingCapabilities.join(", ")}`,
      ),
    })
  }

  if (requireActiveLease && response.writerLeaseEpoch < 1) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion,
      actualVersion: response.protocolVersion,
      socketPath: input.socketPath,
      detail: toMismatchDetail(
        `Daemon has no active writer lease (writerLeaseEpoch=${response.writerLeaseEpoch}, expected >= 1)`,
      ),
    })
  }

  return response
})

/** Optional IPC overrides for high-level typed workflow daemon RPC client calls. */
export interface WorkflowDaemonRpcOptions {
  readonly socketPath?: DaemonSocketPath | undefined
  readonly commonGitDir?: GitCommonDirPath | undefined
  readonly requireActiveLease?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

const PlainRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodePlainRecordOption = Schema.decodeUnknownOption(PlainRecordSchema)

const extractRpcResponseCandidate = (
  reply: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const resultOpt = decodePlainRecordOption(reply.result)
  const fromResult = match(resultOpt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (fromResult !== undefined) {
    return fromResult
  }
  const responseOpt = decodePlainRecordOption(reply.response)
  const fromResponse = match(responseOpt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  return fromResponse ?? reply
}

const invokeWorkflowDaemonRpc = <
  TReq extends { readonly repoRoot: AbsoluteRepoRoot },
  TReqEncoded,
  TRes,
>(config: {
  readonly command: string
  readonly operation: WorkflowStoreOperation
  readonly request: TReq
  readonly requestSchema: Schema.Codec<TReq, TReqEncoded>
  readonly responseSchema: Schema.Codec<TRes, unknown>
  readonly defaultRequireActiveLease: boolean
  readonly options?: WorkflowDaemonRpcOptions | undefined
}): Effect.Effect<TRes, DaemonProtocolMismatchError | WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const resolvedTarget =
      config.options?.socketPath !== undefined
        ? {
            socketPath: config.options.socketPath,
            commonGitDir: config.options.commonGitDir,
          }
        : yield* validateWorktreeRepoRoot(config.request.repoRoot).pipe(
            Effect.map((validated) => ({
              socketPath: resolveWorkflowRuntimePaths(validated.commonGitDir).socketPath,
              commonGitDir: config.options?.commonGitDir ?? validated.commonGitDir,
            })),
          )

    yield* handshakeWorkflowDaemon({
      socketPath: resolvedTarget.socketPath,
      request: {
        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
        repoRoot: config.request.repoRoot,
        ...(resolvedTarget.commonGitDir !== undefined
          ? { commonGitDir: resolvedTarget.commonGitDir }
          : {}),
      },
      requiredCapabilities: [WorkflowDaemonCapability.make(config.command)],
      requireActiveLease: config.options?.requireActiveLease ?? config.defaultRequireActiveLease,
    })

    const encodedPayload = yield* Schema.encodeUnknownEffect(config.requestSchema)(
      config.request,
    ).pipe(
      Effect.mapError(
        (err) =>
          new WorkflowStoreUnavailableError({
            operation: config.operation,
            reason: toBoundedReason(err, `Failed to encode '${config.command}' request`),
          }),
      ),
    )

    const payloadRecord = yield* match(decodePlainRecordOption(encodedPayload))
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.fail(
          new WorkflowStoreUnavailableError({
            operation: config.operation,
            reason: toBoundedReason(`Encoded '${config.command}' request was not an object`),
          }),
        ),
      )
      .exhaustive()

    const reply = yield* queryWorkflowDaemonCommand({
      socketPath: resolvedTarget.socketPath,
      command: config.command,
      payload: payloadRecord,
      ...(config.options?.timeoutMs !== undefined ? { timeoutMs: config.options.timeoutMs } : {}),
    })

    const errorText = extractStringField(reply, "error")
    if (reply.ok === false || errorText !== undefined) {
      const detailText =
        extractStringField(reply, "detail") ??
        errorText ??
        `Daemon rejected '${config.command}' request`
      return yield* new WorkflowStoreUnavailableError({
        operation: config.operation,
        reason: toStoreFailureReason(detailText),
      })
    }

    const candidate = extractRpcResponseCandidate(reply)
    return yield* Schema.decodeEffect(config.responseSchema)(candidate).pipe(
      Effect.mapError(
        (err) =>
          new WorkflowStoreUnavailableError({
            operation: config.operation,
            reason: toBoundedReason(err, `Daemon returned malformed '${config.command}' response`),
          }),
      ),
    )
  })

const START_WORKFLOW_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.startWorkflow")
const STATUS_WORKFLOW_OPERATION = WorkflowStoreOperation.make(
  "HarnessDaemonClient.getWorkflowStatus",
)
const COMPLETE_WORKFLOW_OPERATION = WorkflowStoreOperation.make(
  "HarnessDaemonClient.completeWorkflow",
)
const RESUME_WORKFLOW_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.resumeWorkflow")
const ABORT_WORKFLOW_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.abortWorkflow")
const DOCTOR_WORKFLOW_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.doctorWorkflow")

/** Starts or attaches to a `HarnessTaskWorkflow` run over daemon Unix socket IPC. */
export const startWorkflowViaDaemon = Effect.fn("HarnessDaemonClient.startWorkflow")(function* (
  request: WorkflowStartRequest,
  options?: WorkflowDaemonRpcOptions,
): Effect.fn.Return<
  WorkflowStartResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  return yield* invokeWorkflowDaemonRpc({
    command: "workflow.start",
    operation: START_WORKFLOW_OPERATION,
    request,
    requestSchema: WorkflowStartRequest,
    responseSchema: WorkflowStartResponse,
    defaultRequireActiveLease: true,
    options,
  })
})

/** Queries workflow status summary over daemon Unix socket IPC. */
export const getWorkflowStatusViaDaemon = Effect.fn("HarnessDaemonClient.getWorkflowStatus")(
  function* (
    request: WorkflowStatusRequest,
    options?: WorkflowDaemonRpcOptions,
  ): Effect.fn.Return<
    WorkflowStatusSummary,
    DaemonProtocolMismatchError | WorkflowStoreUnavailableError
  > {
    return yield* invokeWorkflowDaemonRpc({
      command: "workflow.status",
      operation: STATUS_WORKFLOW_OPERATION,
      request,
      requestSchema: WorkflowStatusRequest,
      responseSchema: WorkflowStatusSummary,
      defaultRequireActiveLease: false,
      options,
    })
  },
)

/** Completes a manual unit or LLM phase over daemon Unix socket IPC. */
export const completeWorkflowViaDaemon = Effect.fn("HarnessDaemonClient.completeWorkflow")(
  function* (
    request: WorkflowCompleteRequest,
    options?: WorkflowDaemonRpcOptions,
  ): Effect.fn.Return<
    WorkflowCompleteResponse,
    DaemonProtocolMismatchError | WorkflowStoreUnavailableError
  > {
    return yield* invokeWorkflowDaemonRpc({
      command: "workflow.complete",
      operation: COMPLETE_WORKFLOW_OPERATION,
      request,
      requestSchema: WorkflowCompleteRequest,
      responseSchema: WorkflowCompleteResponse,
      defaultRequireActiveLease: true,
      options,
    })
  },
)

/** Resumes a workflow run or resolves an escalation over daemon Unix socket IPC. */
export const resumeWorkflowViaDaemon = Effect.fn("HarnessDaemonClient.resumeWorkflow")(function* (
  request: WorkflowResumeRequest,
  options?: WorkflowDaemonRpcOptions,
): Effect.fn.Return<
  WorkflowResumeResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  return yield* invokeWorkflowDaemonRpc({
    command: "workflow.resume",
    operation: RESUME_WORKFLOW_OPERATION,
    request,
    requestSchema: WorkflowResumeRequest,
    responseSchema: WorkflowResumeResponse,
    defaultRequireActiveLease: true,
    options,
  })
})

/** Aborts an active workflow run over daemon Unix socket IPC. */
export const abortWorkflowViaDaemon = Effect.fn("HarnessDaemonClient.abortWorkflow")(function* (
  request: WorkflowAbortRequest,
  options?: WorkflowDaemonRpcOptions,
): Effect.fn.Return<
  WorkflowAbortResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  return yield* invokeWorkflowDaemonRpc({
    command: "workflow.abort",
    operation: ABORT_WORKFLOW_OPERATION,
    request,
    requestSchema: WorkflowAbortRequest,
    responseSchema: WorkflowAbortResponse,
    defaultRequireActiveLease: true,
    options,
  })
})

/** Runs workflow diagnostics and optional view rebuild over daemon Unix socket IPC. */
export const doctorWorkflowViaDaemon = Effect.fn("HarnessDaemonClient.doctorWorkflow")(function* (
  request: WorkflowDoctorRequest,
  options?: WorkflowDaemonRpcOptions,
): Effect.fn.Return<
  WorkflowDoctorResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  return yield* invokeWorkflowDaemonRpc({
    command: "workflow.doctor",
    operation: DOCTOR_WORKFLOW_OPERATION,
    request,
    requestSchema: WorkflowDoctorRequest,
    responseSchema: WorkflowDoctorResponse,
    defaultRequireActiveLease: false,
    options,
  })
})
