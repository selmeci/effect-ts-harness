import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type ErrorReasonMessage,
  LeaseEpoch,
  type LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  toErrorReasonMessage,
  WriterLeaseHeldError,
} from "@harness/contract"

/** Active `WfWriterLease` row in Omnigraph (`leaseEpoch >= 1`, trimmed non-empty `owner`, non-negative `heartbeatMs`). */
export const WfWriterLeaseRowSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  owner: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  leaseEpoch: LeaseEpoch.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  heartbeatMs: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type WfWriterLeaseRow = typeof WfWriterLeaseRowSchema.Type

const decodeWriterLeaseRowResult = Schema.decodeUnknownResult(WfWriterLeaseRowSchema)
const decodeLeaseHolderIdResult = Schema.decodeUnknownResult(LeaseHolderId)
const decodeLeaseHolderPidResult = Schema.decodeUnknownResult(LeaseHolderPid)

export interface ParsedLeaseOwner {
  readonly holderId: LeaseHolderId
  readonly holderPid: LeaseHolderPid | undefined
  readonly holderStartTime: string | undefined
}

export interface LeaseTakeoverEvaluationInput {
  readonly flockHeld: boolean
  readonly metaState: "present" | "missing" | "corrupt"
  readonly metaCorruptReason?: string | undefined
  readonly rowValid: boolean
  readonly rowCorruptReason?: string | undefined
  readonly oldPid: LeaseHolderPid | undefined
  readonly pidAlive: boolean
  readonly samePidOrReused: boolean
  readonly staleByHeartbeat: boolean
}

export interface LeaseTakeoverAllow {
  readonly _tag: "Allow"
}

export interface LeaseTakeoverHeld {
  readonly _tag: "Held"
}

export interface LeaseTakeoverCorrupt {
  readonly _tag: "Corrupt"
  readonly reason: string
}

export type LeaseTakeoverDecision = LeaseTakeoverAllow | LeaseTakeoverHeld | LeaseTakeoverCorrupt

/**
 * Evaluates whether a contending writer may take over an existing `WfWriterLease` row.
 * Never allows takeover when `flockHeld` is true, when metadata/row state is corrupt,
 * or solely because the `.meta.json` sidecar is missing while a live process/fresh
 * heartbeat still protects the lease.
 */
const evaluateWriterLeaseTakeover = (
  input: LeaseTakeoverEvaluationInput,
): LeaseTakeoverDecision => {
  const isCorruptMeta = match(input.metaState)
    .with("corrupt", () => true)
    .with("present", "missing", () => false)
    .exhaustive()
  if (isCorruptMeta) {
    return {
      _tag: "Corrupt",
      reason: input.metaCorruptReason ?? "Corrupt writer lease metadata file",
    }
  }
  if (!input.rowValid) {
    return {
      _tag: "Corrupt",
      reason: input.rowCorruptReason ?? "Corrupt WfWriterLease graph row",
    }
  }
  if (input.flockHeld) {
    return { _tag: "Held" }
  }
  if (input.oldPid !== undefined) {
    return !input.pidAlive || input.samePidOrReused || input.staleByHeartbeat
      ? { _tag: "Allow" }
      : { _tag: "Held" }
  }
  return input.staleByHeartbeat ? { _tag: "Allow" } : { _tag: "Held" }
}

/**
 * Parses a formatted lease owner string (`<holderId>#<pid>[@<startTime>]` or bare `<holderId>`)
 * and validates its `LeaseHolderId` and optional `LeaseHolderPid` strictly.
 */
const parseOwnerIdentity = (owner: string): Result.Result<ParsedLeaseOwner, ErrorReasonMessage> => {
  const hashIdx = owner.lastIndexOf("#")
  if (hashIdx > 0) {
    const rawHolderId = owner.slice(0, hashIdx)
    const suffix = owner.slice(hashIdx + 1)
    const atIdx = suffix.indexOf("@")
    const pidPart = atIdx > 0 ? suffix.slice(0, atIdx) : suffix
    const startPart = atIdx > 0 ? suffix.slice(atIdx + 1) : undefined
    if (!/^[1-9]\d*$/.test(pidPart)) {
      return Result.fail(
        toErrorReasonMessage(`Invalid PID segment in WfWriterLease owner '${owner}'`),
      )
    }
    const parsedPidNum = Number(pidPart)
    const holderIdRes = decodeLeaseHolderIdResult(rawHolderId)
    const holderPidRes = decodeLeaseHolderPidResult(parsedPidNum)
    return Result.flatMap(holderIdRes, (holderId) =>
      Result.map(holderPidRes, (holderPid) => ({
        holderId,
        holderPid,
        holderStartTime: startPart && startPart.length > 0 ? startPart : undefined,
      })),
    ).pipe(
      Result.mapError((err) => toErrorReasonMessage(err, `Invalid WfWriterLease owner '${owner}'`)),
    )
  }
  return decodeLeaseHolderIdResult(owner).pipe(
    Result.map((holderId) => ({
      holderId,
      holderPid: undefined,
      holderStartTime: undefined,
    })),
    Result.mapError((err) => toErrorReasonMessage(err, `Invalid WfWriterLease owner '${owner}'`)),
  )
}

/** Validates and decodes an Omnigraph `WfWriterLease` row, failing closed on any corrupt field. */
const decodeWriterLeaseRow = (
  raw: unknown,
): Result.Result<
  { readonly row: WfWriterLeaseRow; readonly parsedOwner: ParsedLeaseOwner },
  ErrorReasonMessage
> =>
  decodeWriterLeaseRowResult(raw).pipe(
    Result.mapError((err) =>
      toErrorReasonMessage(err, "Corrupt WfWriterLease row returned by Omnigraph"),
    ),
    Result.flatMap((row) =>
      parseOwnerIdentity(row.owner).pipe(Result.map((parsedOwner) => ({ row, parsedOwner }))),
    ),
  )

/** Builds a typed `WriterLeaseHeldError` from validated lease identity fields. */
const makeHeldLeaseError = (
  holderId: LeaseHolderId,
  leaseEpoch: LeaseEpoch,
  lockFilePath: LeaseFilePath,
  holderPid: LeaseHolderPid | undefined,
): WriterLeaseHeldError =>
  new WriterLeaseHeldError({
    holderId,
    leaseEpoch,
    lockFilePath,
    ...(holderPid !== undefined ? { holderPid } : {}),
  })

/** Decodes a `WfWriterLease` graph row into a `WriterLeaseHeldError`, failing closed on corrupt rows. */
const writerLeaseRowToHeldError = (
  raw: unknown,
  lockFilePath: LeaseFilePath,
): Result.Result<WriterLeaseHeldError, ErrorReasonMessage> =>
  match(decodeWriterLeaseRow(raw))
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success }) =>
      Result.succeed(
        makeHeldLeaseError(
          success.parsedOwner.holderId,
          success.row.leaseEpoch,
          lockFilePath,
          success.parsedOwner.holderPid,
        ),
      ),
    )
    .exhaustive()

export {
  decodeWriterLeaseRow,
  evaluateWriterLeaseTakeover,
  makeHeldLeaseError,
  parseOwnerIdentity,
  writerLeaseRowToHeldError,
}
