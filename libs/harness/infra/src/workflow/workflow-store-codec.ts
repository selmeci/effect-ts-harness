import { randomInt } from "node:crypto"
import { Result, Schema } from "effect"
import { match, P } from "ts-pattern"
import {
  ErrorReasonMessage,
  ReplyKey,
  type WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  toBoundedReason,
  toErrorReasonMessage,
} from "@harness/contract"

/** Internal raw attempt failure carrier preserved across workflow store retries. */
export interface WorkflowStoreAttemptFailure {
  readonly _tag: "WorkflowStoreAttemptFailure"
  readonly operation: WorkflowStoreOperation
  readonly cause: unknown
}

/** Normalizes any caught cause into a bounded `WorkflowStoreUnavailableError`. */
const toWorkflowStoreUnavailableError = (
  operation: WorkflowStoreOperation,
  cause: unknown,
): WorkflowStoreUnavailableError => {
  if (cause instanceof WorkflowStoreUnavailableError) {
    return cause
  }
  return new WorkflowStoreUnavailableError({
    operation,
    reason: toBoundedReason(cause, "Workflow store request failed"),
  })
}

/**
 * Safely decodes a JSON string against an Effect `Schema` without throwing,
 * returning a `Result` so individual corrupt storage rows can be isolated without
 * throwing raw `SchemaError` defects.
 */
const decodeJsonFieldSafely = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  raw: string,
  schema: S,
): Result.Result<S["Type"], ErrorReasonMessage> => {
  const jsonSchema = Schema.fromJsonString(schema)
  const res = Schema.decodeResult(jsonSchema)(raw)
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => Result.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(ErrorReasonMessage.make(toErrorReasonMessage(failure, "Invalid JSON field"))),
    )
    .exhaustive()
}

/** Parses either a finite number or numeric string, returning `undefined` on non-finite values. */
const parseFiniteNumberOrString = (raw: unknown): number | undefined =>
  match(raw)
    .with(P.number, (num) => (Number.isFinite(num) ? num : undefined))
    .with(P.string, (str) => {
      const trimmed = str.trim()
      if (trimmed.length === 0) {
        return undefined
      }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : undefined
    })
    .otherwise(() => undefined)

/**
 * Creates a strictly monotonic 64-bit decimal `ReplyKey` minter without module-level
 * mutable state, mixing in a per-instance random salt to prevent intra-millisecond collisions.
 */
const makeMintReplyKey = (): (() => ReplyKey) => {
  let lastMs = 0n
  let lastSeq = 0n
  const randomSalt = BigInt(randomInt(0, 1000))
  return (): ReplyKey => {
    const nowMs = BigInt(Date.now())
    if (nowMs > lastMs) {
      lastMs = nowMs
      lastSeq = 0n
    } else {
      lastSeq += 1n
      if (lastSeq >= 1000n) {
        lastMs += 1n
        lastSeq = 0n
      }
    }
    return ReplyKey.make(((lastMs * 1000n + lastSeq) * 1000n + randomSalt).toString())
  }
}

export {
  decodeJsonFieldSafely,
  makeMintReplyKey,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
}
