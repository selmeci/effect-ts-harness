import { randomUUID } from "node:crypto"
import * as net from "node:net"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DaemonProtocolMismatchDetail,
  DaemonProtocolMismatchError,
  type DaemonSocketPath,
  ShipStreamProgressEvent,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowDaemonCapability,
  WorkflowShipRequest,
  WorkflowShipResponse,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorkflowTimeoutMs,
  toBoundedReason,
} from "@harness/contract"
import type { UnixSocketQueryReason } from "../unix-socket-daemon-live.js"
import { resolveWorkflowRuntimePaths, validateWorktreeRepoRoot } from "../worktree-repo-root.js"
import { type WorkflowDaemonRpcOptions, handshakeWorkflowDaemon } from "./daemon-client.js"

/** Streaming RPC options for `shipWorkflowViaDaemon`. */
export interface WorkflowShipRpcOptions extends WorkflowDaemonRpcOptions {
  readonly onProgress?: ((event: ShipStreamProgressEvent) => void) | undefined
}

/** Dedicated streaming IPC timeout for `workflow.ship`. */
export const SHIP_WORKFLOW_IPC_TIMEOUT_MS: WorkflowTimeoutMs =
  WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowIpcMs

const MAX_SHIP_IPC_BUFFER_BYTES = 1_048_576
const NEWLINE_BYTE = 0x0a
const SHIP_WORKFLOW_OPERATION = WorkflowStoreOperation.make("HarnessDaemonClient.shipWorkflow")

const decodeJsonRecordOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodePlainRecordOption = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown),
)
const decodeProgressEventOption = Schema.decodeUnknownOption(ShipStreamProgressEvent)

const toMismatchDetail = (raw: string): DaemonProtocolMismatchDetail => {
  const sanitized = raw.trim().slice(0, 1024).trim()
  return DaemonProtocolMismatchDetail.make(
    sanitized.length > 0 ? sanitized : "Daemon protocol mismatch",
  )
}

const extractStringField = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const candidate = record[key]
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined
}

const formatShipSocketReason = (
  reason: UnixSocketQueryReason,
  detail: string | undefined,
  socketPath: DaemonSocketPath,
): string => {
  const base = match(reason)
    .with("missing-or-refused", () => `Daemon socket unavailable at '${socketPath}'`)
    .with("timeout", () => `Daemon IPC timed out at '${socketPath}'`)
    .with("overflow", () => `Daemon IPC response exceeded buffer limit at '${socketPath}'`)
    .with("closed", () => `Daemon closed IPC connection prematurely at '${socketPath}'`)
    .with("socket-error", () => `Daemon IPC socket error at '${socketPath}'`)
    .exhaustive()
  const detailTrimmed = detail?.trim()
  return detailTrimmed !== undefined && detailTrimmed.length > 0
    ? `${base}: ${detailTrimmed}`
    : base
}

interface ShipStreamEnvelope {
  readonly _tag: "Envelope"
  readonly record: Readonly<Record<string, unknown>>
}
interface ShipStreamInvalidJson {
  readonly _tag: "InvalidJson"
  readonly rawLine: string
}
interface ShipStreamProtocolMismatch {
  readonly _tag: "ProtocolMismatch"
  readonly detail: string
}
interface ShipStreamUnavailable {
  readonly _tag: "Unavailable"
  readonly reason: UnixSocketQueryReason
  readonly detail?: string | undefined
}
type StreamSocketOutcome =
  | ShipStreamEnvelope
  | ShipStreamInvalidJson
  | ShipStreamProtocolMismatch
  | ShipStreamUnavailable

const formatFrameId = (rawId: unknown): string =>
  rawId === undefined ? "missing" : typeof rawId === "string" ? `'${rawId}'` : JSON.stringify(rawId)

const streamWorkflowShipOverSocket = (config: {
  readonly socketPath: DaemonSocketPath
  readonly requestId: string
  readonly linePayload: string
  readonly timeoutMs: number
  readonly onProgress?: ((event: ShipStreamProgressEvent) => void) | undefined
}): Effect.Effect<StreamSocketOutcome> =>
  Effect.callback<StreamSocketOutcome>((resume) => {
    const socket = net.createConnection(config.socketPath)
    let settled = false
    let buffer: Buffer = Buffer.alloc(0)

    const finish = (outcome: StreamSocketOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      socket.removeAllListeners()
      socket.destroy()
      resume(Effect.succeed(outcome))
    }

    const deadlineTimer = setTimeout(() => {
      finish({ _tag: "Unavailable", reason: "timeout" })
    }, config.timeoutMs)

    const processLine = (trimmedLine: string): boolean => {
      if (trimmedLine.length === 0) return false
      return match(decodeJsonRecordOption(trimmedLine))
        .with({ _tag: "None" }, () => {
          finish({ _tag: "InvalidJson", rawLine: trimmedLine })
          return true
        })
        .with({ _tag: "Some" }, ({ value: record }) => {
          if (record.id !== config.requestId) {
            finish({
              _tag: "ProtocolMismatch",
              detail: `Daemon workflow.ship frame id mismatch: expected '${config.requestId}', got ${formatFrameId(record.id)}`,
            })
            return true
          }
          return match(record.kind)
            .with("progress", () =>
              match(decodeProgressEventOption(record.event))
                .with({ _tag: "Some" }, ({ value }) => {
                  Result.try(() => config.onProgress?.(value))
                  return false
                })
                .with({ _tag: "None" }, () => {
                  finish({
                    _tag: "ProtocolMismatch",
                    detail: "Daemon returned malformed workflow.ship progress event",
                  })
                  return true
                })
                .exhaustive(),
            )
            .otherwise(() => {
              finish({ _tag: "Envelope", record })
              return true
            })
        })
        .exhaustive()
    }

    socket.setTimeout(config.timeoutMs, () => finish({ _tag: "Unavailable", reason: "timeout" }))
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const reason: UnixSocketQueryReason =
        err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "missing-or-refused" : "socket-error"
      finish({ _tag: "Unavailable", reason, detail: err.message })
    })
    socket.on("connect", () => {
      socket.write(
        config.linePayload.endsWith("\n") ? config.linePayload : `${config.linePayload}\n`,
      )
    })
    socket.on("data", (chunk) => {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
      if (buffer.length + nextChunk.length > MAX_SHIP_IPC_BUFFER_BYTES) {
        buffer = Buffer.alloc(0)
        finish({ _tag: "Unavailable", reason: "overflow" })
        return
      }
      buffer = buffer.length === 0 ? nextChunk : Buffer.concat([buffer, nextChunk])
      while (!settled) {
        const newlineIdx = buffer.indexOf(NEWLINE_BYTE)
        if (newlineIdx === -1) break
        const line = buffer.subarray(0, newlineIdx).toString("utf8").trim()
        buffer = buffer.subarray(newlineIdx + 1)
        if (processLine(line)) return
      }
      if (buffer.length > 0) {
        buffer = Buffer.from(buffer)
      }
    })
    socket.on("end", () => {
      if (buffer.length > 0) {
        const trailing = buffer.toString("utf8").trim()
        buffer = Buffer.alloc(0)
        if (trailing.length > 0 && processLine(trailing)) return
      }
      finish({ _tag: "Unavailable", reason: "closed" })
    })
    socket.on("close", () => finish({ _tag: "Unavailable", reason: "closed" }))

    return Effect.sync(() => {
      settled = true
      clearTimeout(deadlineTimer)
      socket.removeAllListeners()
      socket.destroy()
    })
  })

/**
 * Executes `workflow.ship` over the canonical `<git-common-dir>/harness/daemon.sock` IPC
 * channel, streaming per-stage `ShipStreamProgressEvent` frames before returning `WorkflowShipResponse`.
 */
export const shipWorkflowViaDaemon = Effect.fn("DaemonClient.shipWorkflow")(function* (
  request: WorkflowShipRequest,
  options?: WorkflowShipRpcOptions,
): Effect.fn.Return<
  WorkflowShipResponse,
  DaemonProtocolMismatchError | WorkflowStoreUnavailableError
> {
  const resolvedTarget =
    options?.socketPath !== undefined
      ? { socketPath: options.socketPath, commonGitDir: options.commonGitDir }
      : yield* validateWorktreeRepoRoot(request.repoRoot).pipe(
          Effect.map((validated) => ({
            socketPath: resolveWorkflowRuntimePaths(validated.commonGitDir).socketPath,
            commonGitDir: options?.commonGitDir ?? validated.commonGitDir,
          })),
        )

  yield* handshakeWorkflowDaemon({
    socketPath: resolvedTarget.socketPath,
    request: {
      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      repoRoot: request.repoRoot,
      ...(resolvedTarget.commonGitDir !== undefined
        ? { commonGitDir: resolvedTarget.commonGitDir }
        : {}),
    },
    requiredCapabilities: [WorkflowDaemonCapability.make("workflow.ship")],
    requireActiveLease: options?.requireActiveLease ?? true,
  })

  const encodedPayload = yield* Schema.encodeUnknownEffect(WorkflowShipRequest)(request).pipe(
    Effect.mapError(
      (err) =>
        new WorkflowStoreUnavailableError({
          operation: SHIP_WORKFLOW_OPERATION,
          reason: toBoundedReason(err, "Failed to encode 'workflow.ship' request"),
        }),
    ),
  )

  const payloadRecord = yield* match(decodePlainRecordOption(encodedPayload))
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: SHIP_WORKFLOW_OPERATION,
          reason: toBoundedReason("Encoded 'workflow.ship' request was not an object"),
        }),
      ),
    )
    .exhaustive()

  const requestId = randomUUID()
  const outcome = yield* streamWorkflowShipOverSocket({
    socketPath: resolvedTarget.socketPath,
    requestId,
    linePayload: JSON.stringify({ ...payloadRecord, id: requestId, command: "workflow.ship" }),
    timeoutMs: options?.timeoutMs ?? SHIP_WORKFLOW_IPC_TIMEOUT_MS,
    onProgress: options?.onProgress,
  })

  const reply = yield* match(outcome)
    .with({ _tag: "Unavailable" }, ({ reason, detail }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: SHIP_WORKFLOW_OPERATION,
          reason: toBoundedReason(
            formatShipSocketReason(reason, detail, resolvedTarget.socketPath),
          ),
        }),
      ),
    )
    .with({ _tag: "InvalidJson" }, () =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: SHIP_WORKFLOW_OPERATION,
          reason: toBoundedReason("Daemon returned invalid JSON frame for 'workflow.ship'"),
        }),
      ),
    )
    .with({ _tag: "ProtocolMismatch" }, ({ detail }) =>
      Effect.fail(
        new DaemonProtocolMismatchError({
          expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
          socketPath: resolvedTarget.socketPath,
          detail: toMismatchDetail(detail),
        }),
      ),
    )
    .with({ _tag: "Envelope" }, ({ record }) => Effect.succeed(record))
    .exhaustive()

  if (reply.id !== requestId) {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      socketPath: resolvedTarget.socketPath,
      detail: toMismatchDetail(
        `Daemon workflow.ship response id mismatch: expected '${requestId}', got ${formatFrameId(reply.id)}`,
      ),
    })
  }

  const errorText = extractStringField(reply, "error")
  if (reply.ok === false || errorText !== undefined) {
    return yield* new WorkflowStoreUnavailableError({
      operation: SHIP_WORKFLOW_OPERATION,
      reason: toBoundedReason(
        extractStringField(reply, "detail") ??
          errorText ??
          "Daemon rejected 'workflow.ship' request",
      ),
    })
  }

  if (reply.ok !== true || reply.command !== "workflow.ship") {
    return yield* new DaemonProtocolMismatchError({
      expectedVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
      socketPath: resolvedTarget.socketPath,
      detail: toMismatchDetail(
        `Daemon workflow.ship response protocol mismatch: expected ok=true and command='workflow.ship', got ok=${JSON.stringify(reply.ok)} command=${JSON.stringify(reply.command)}`,
      ),
    })
  }

  return yield* Schema.decodeUnknownEffect(WorkflowShipResponse)(reply.result).pipe(
    Effect.mapError(
      (err) =>
        new WorkflowStoreUnavailableError({
          operation: SHIP_WORKFLOW_OPERATION,
          reason: toBoundedReason(err, "Daemon returned malformed 'workflow.ship' response"),
        }),
    ),
  )
})
