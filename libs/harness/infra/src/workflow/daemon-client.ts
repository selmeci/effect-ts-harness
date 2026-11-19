import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonProtocolMismatchDetail,
  DaemonProtocolMismatchError,
  type DaemonSocketPath,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  type WorkflowDaemonCapability,
  WorkflowProtocolVersion,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import {
  queryUnixSocketLineDetailed,
  type UnixSocketQueryReason,
} from "../unix-socket-daemon-live.js"

/** Dedicated workflow daemon IPC timeout (decoupled from the 5 s LSP query socket timeout). */
export const WORKFLOW_DAEMON_IPC_TIMEOUT_MS = 30_000

const HANDSHAKE_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.handshake")
const QUERY_COMMAND_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.queryCommand")

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecordOption = Schema.decodeUnknownOption(JsonRecordSchema)
const decodeHandshakeResponseOption = Schema.decodeUnknownOption(DaemonHandshakeResponse)
const decodeProtocolVersionOption = Schema.decodeUnknownOption(WorkflowProtocolVersion)

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toStoreFailureReason = (raw: string): WorkflowStoreFailureReason => {
  const sanitized = raw.trim().slice(0, 1024).trim()
  return WorkflowStoreFailureReason.make(
    sanitized.length > 0 ? sanitized : "Workflow daemon IPC transport unavailable",
  )
}

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
  const expectedVersion = input.request.protocolVersion ?? WORKFLOW_DAEMON_PROTOCOL_VERSION
  const requestPayload = {
    id: randomUUID(),
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

  const candidate = isPlainRecord(record.handshake)
    ? record.handshake
    : isPlainRecord(record.result)
      ? record.result
      : record

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

  return response
})
