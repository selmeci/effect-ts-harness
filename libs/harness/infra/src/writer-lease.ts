import { dirname, resolve } from "node:path"
import { Deferred, Effect, Schema, type Scope } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type GitCommonDirPath,
  LeaseEpoch,
  type LeaseFilePath,
  LeaseHolderId,
  type LeaseHolderPid,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  type WorkflowTimeoutMs,
  WriterLeaseHeldError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  invokeWorkflowStoreQuery,
  invokeWorkflowStoreQueryWithMeta,
  toWorkflowStoreUnavailableError,
} from "./omnigraph-workflow-store.js"
import {
  acquireOsFlock,
  type FlockChild,
  isLocalPidAlive,
  metaFilePathFor,
  prepareLockPathsAndModes,
  readLinuxProcStartTime,
  readLockMeta,
  stopFlockChild,
  unlinkLockMetaIfOwned,
  withAdvisoryFlock,
  writeLockMetaAtomic,
} from "./workflow/flock-lock.js"
import {
  decodeWriterLeaseRow,
  evaluateWriterLeaseTakeover,
  type LeaseTakeoverDecision,
  type LeaseTakeoverEvaluationInput,
  makeHeldLeaseError,
  writerLeaseRowToHeldError,
} from "./workflow/writer-lease-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Fallback heartbeat TTL (ms) when local PID liveness of a previous holder is indeterminate. */
export const WRITER_LEASE_HEARTBEAT_TTL_MS: WorkflowTimeoutMs =
  WORKFLOW_TIMEOUT_BUDGETS.writerLeaseHeartbeatTtlMs

export interface WriterLeaseAcquireInput {
  readonly commonGitDir: GitCommonDirPath
  readonly lockFilePath: LeaseFilePath
  readonly holderId: LeaseHolderId
  readonly holderPid: LeaseHolderPid
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly isPidAlive?: ((pid: number) => boolean) | undefined
  readonly readProcessStartTime?: ((pid: number) => string | undefined) | undefined
}

export interface ActiveWriterLease {
  readonly holderId: LeaseHolderId
  readonly holderPid: LeaseHolderPid
  readonly lockFilePath: LeaseFilePath
  readonly leaseEpoch: LeaseEpoch
  readonly owner: string
  /** Resolves immediately if the OS `flock` child exits or errors unexpectedly before intentional teardown. */
  readonly waitForFlockLoss: Effect.Effect<void>
}

export type WriterLeaseHandle = ActiveWriterLease

export interface WriterLeaseRefreshInput {
  readonly commonGitDir: GitCommonDirPath
  readonly holderId: LeaseHolderId
  readonly holderPid: LeaseHolderPid
  readonly lockFilePath: LeaseFilePath
  readonly leaseEpoch: LeaseEpoch
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly readProcessStartTime?: ((pid: number) => string | undefined) | undefined
}

const formatLeaseOwner = (
  holderId: LeaseHolderId,
  holderPid: LeaseHolderPid,
  startTime: string | undefined,
): string =>
  startTime !== undefined ? `${holderId}#${holderPid}@${startTime}` : `${holderId}#${holderPid}`

const deriveRepoRootFromCommonGitDir = (commonGitDir: GitCommonDirPath): AbsoluteRepoRoot => {
  const candidate = resolve(dirname(commonGitDir))
  return match(Schema.decodeOption(AbsoluteRepoRoot)(candidate))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => AbsoluteRepoRoot.make(resolve(commonGitDir)))
    .exhaustive()
}

interface AcquiredLeaseResource {
  readonly lease: ActiveWriterLease
  readonly flockChild: FlockChild
  readonly markIntentionalStop: () => void
}

/**
 * Acquires the single-writer workflow daemon lease via OS advisory `flock` on
 * `<git-common-dir>/harness/daemon.lock` and fenced `WfWriterLease` epoch takeover
 * in Omnigraph, returning a scoped `ActiveWriterLease` that releases flock and
 * lock metadata automatically when `Scope` closes.
 */
export const acquireWriterLease = Effect.fn("WfWriterLease.acquire")(function* (
  input: WriterLeaseAcquireInput,
): Effect.fn.Return<
  ActiveWriterLease,
  WriterLeaseHeldError | WorkflowStoreUnavailableError,
  Scope.Scope
> {
  const hostIo = input.hostIo ?? nodeSyncHostIo
  const operation = WorkflowStoreOperation.make("WfWriterLease.acquire")
  const metaPath = metaFilePathFor(input.lockFilePath)
  const repoRoot = input.repoRoot ?? deriveRepoRootFromCommonGitDir(input.commonGitDir)
  const nowMsFn = input.nowMs ?? (() => Date.now())
  const pidAliveFn = input.isPidAlive ?? isLocalPidAlive
  const readStartTimeFn =
    input.readProcessStartTime ?? ((pid: number) => readLinuxProcStartTime(pid, hostIo))

  const acquireOmnigraphLease = (
    holderStartTime: string | undefined,
    owner: string,
    isFlockLost: () => boolean,
  ): Effect.Effect<LeaseEpoch, WriterLeaseHeldError | WorkflowStoreUnavailableError> =>
    Effect.gen(function* () {
      const nowMs = nowMsFn()
      const existingRows = yield* invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("WfWriterLease.get"),
        queryName: "wf_get_writer_lease",
        params: { name: "engine" },
        expectMutation: false,
        client: input.client,
        hostIo,
        env: input.env,
      })

      let leaseEpoch: LeaseEpoch
      const firstRow = existingRows[0]
      if (firstRow === undefined) {
        const metaCheck = readLockMeta(metaPath, hostIo)
        yield* match(metaCheck)
          .with({ _tag: "Corrupt" }, ({ reason }) =>
            Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(reason))),
          )
          .with({ _tag: "Missing" }, { _tag: "Valid" }, () => Effect.void)
          .exhaustive()

        const initialEpoch = LeaseEpoch.make(1)
        const insertRes = yield* invokeWorkflowStoreQueryWithMeta({
          repoRoot,
          operation: WorkflowStoreOperation.make("WfWriterLease.insert"),
          queryName: "wf_insert_writer_lease",
          params: { name: "engine", owner, leaseEpoch: initialEpoch, heartbeatMs: nowMs },
          expectMutation: true,
          client: input.client,
          hostIo,
          env: input.env,
        })
        if (insertRes.affectedNodes < 1) {
          return yield* toWorkflowStoreUnavailableError(
            operation,
            new Error(
              `wf_insert_writer_lease affected ${insertRes.affectedNodes} nodes (expected >= 1)`,
            ),
          )
        }
        leaseEpoch = initialEpoch
      } else {
        const decodedRow = yield* match(decodeWriterLeaseRow(firstRow))
          .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(failure))),
          )
          .exhaustive()

        const metaRes = readLockMeta(metaPath, hostIo)
        const metaInfo = match(metaRes)
          .with({ _tag: "Valid" }, ({ meta }) => ({
            metaState: "present" as const,
            metaCorruptReason: undefined,
            metaPid: meta.holderPid as LeaseHolderPid | undefined,
            metaStartTime: meta.holderStartTime,
          }))
          .with({ _tag: "Missing" }, () => ({
            metaState: "missing" as const,
            metaCorruptReason: undefined,
            metaPid: undefined,
            metaStartTime: undefined,
          }))
          .with({ _tag: "Corrupt" }, ({ reason }) => ({
            metaState: "corrupt" as const,
            metaCorruptReason: reason,
            metaPid: undefined,
            metaStartTime: undefined,
          }))
          .exhaustive()

        const oldPid = decodedRow.parsedOwner.holderPid ?? metaInfo.metaPid
        const oldStartTime = decodedRow.parsedOwner.holderStartTime ?? metaInfo.metaStartTime
        const currentOldPidStartTime = oldPid !== undefined ? readStartTimeFn(oldPid) : undefined
        const pidReusedOrSamePid =
          oldPid !== undefined &&
          (oldPid === input.holderPid ||
            (oldStartTime !== undefined &&
              currentOldPidStartTime !== undefined &&
              oldStartTime !== currentOldPidStartTime))
        const staleByHeartbeat = nowMs - decodedRow.row.heartbeatMs >= WRITER_LEASE_HEARTBEAT_TTL_MS
        const pidAlive = oldPid !== undefined ? pidAliveFn(oldPid) : false

        const decision = evaluateWriterLeaseTakeover({
          flockHeld: false,
          metaState: metaInfo.metaState,
          metaCorruptReason: metaInfo.metaCorruptReason,
          rowValid: true,
          oldPid,
          pidAlive,
          samePidOrReused: pidReusedOrSamePid,
          staleByHeartbeat,
        })

        yield* match(decision)
          .with({ _tag: "Allow" }, () => Effect.void)
          .with({ _tag: "Held" }, () =>
            Effect.fail(
              makeHeldLeaseError(
                decodedRow.parsedOwner.holderId,
                decodedRow.row.leaseEpoch,
                input.lockFilePath,
                decodedRow.parsedOwner.holderPid,
              ),
            ),
          )
          .with({ _tag: "Corrupt" }, ({ reason }) =>
            Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(reason))),
          )
          .exhaustive()

        const nextEpoch = LeaseEpoch.make(decodedRow.row.leaseEpoch + 1)
        const casRes = yield* invokeWorkflowStoreQueryWithMeta({
          repoRoot,
          operation: WorkflowStoreOperation.make("WfWriterLease.cas"),
          queryName: "wf_cas_writer_lease",
          params: {
            name: "engine",
            expectedEpoch: decodedRow.row.leaseEpoch,
            owner,
            nextEpoch,
            heartbeatMs: nowMs,
          },
          expectMutation: true,
          client: input.client,
          hostIo,
          env: input.env,
        })

        if (casRes.affectedNodes === 0) {
          const latestRows = yield* invokeWorkflowStoreQuery({
            repoRoot,
            operation: WorkflowStoreOperation.make("WfWriterLease.get"),
            queryName: "wf_get_writer_lease",
            params: { name: "engine" },
            expectMutation: false,
            client: input.client,
            hostIo,
            env: input.env,
          })
          const latestRow = latestRows[0]
          if (latestRow !== undefined) {
            const heldFromLatest = yield* match(
              writerLeaseRowToHeldError(latestRow, input.lockFilePath),
            )
              .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
              .with({ _tag: "Failure" }, ({ failure }) =>
                Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(failure))),
              )
              .exhaustive()
            return yield* heldFromLatest
          }
          return yield* makeHeldLeaseError(
            decodedRow.parsedOwner.holderId,
            decodedRow.row.leaseEpoch,
            input.lockFilePath,
            decodedRow.parsedOwner.holderPid,
          )
        }
        leaseEpoch = nextEpoch
      }

      if (isFlockLost()) {
        return yield* toWorkflowStoreUnavailableError(
          operation,
          new Error("OS flock child exited during writer lease acquisition"),
        )
      }

      yield* match(
        writeLockMetaAtomic(
          metaPath,
          {
            holderId: input.holderId,
            holderPid: input.holderPid,
            leaseEpoch,
            acquiredAtMs: nowMs,
            ...(holderStartTime !== undefined ? { holderStartTime } : {}),
          },
          hostIo,
        ),
      )
        .with({ _tag: "Success" }, () => Effect.void)
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.fail(toWorkflowStoreUnavailableError(operation, failure)),
        )
        .exhaustive()

      return leaseEpoch
    })

  const acquireResource: Effect.Effect<
    AcquiredLeaseResource,
    WriterLeaseHeldError | WorkflowStoreUnavailableError
  > = Effect.gen(function* () {
    yield* match(prepareLockPathsAndModes(input.lockFilePath, metaPath, hostIo))
      .with({ _tag: "Success" }, () => Effect.void)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkflowStoreUnavailableError(operation, failure)),
      )
      .exhaustive()

    const holderStartTime = readStartTimeFn(input.holderPid)
    const owner = formatLeaseOwner(input.holderId, input.holderPid, holderStartTime)
    const flockLossDeferred = yield* Deferred.make<void>()
    let intentionalStop = false
    const markIntentionalStop = (): void => {
      intentionalStop = true
    }

    const flockChild = yield* acquireOsFlock(input.lockFilePath, metaPath, hostIo, {
      onUnexpectedLoss: () => {
        if (!intentionalStop) {
          Deferred.doneUnsafe(flockLossDeferred, Effect.void)
        }
      },
    })
    const leaseEpoch = yield* acquireOmnigraphLease(holderStartTime, owner, () =>
      Deferred.isDoneUnsafe(flockLossDeferred),
    ).pipe(
      Effect.onExit((exit) =>
        match(exit)
          .with({ _tag: "Failure" }, () =>
            Effect.sync(markIntentionalStop).pipe(Effect.andThen(stopFlockChild(flockChild))),
          )
          .with({ _tag: "Success" }, () => Effect.void)
          .exhaustive(),
      ),
    )

    if (Deferred.isDoneUnsafe(flockLossDeferred)) {
      markIntentionalStop()
      yield* stopFlockChild(flockChild)
      return yield* toWorkflowStoreUnavailableError(
        operation,
        new Error("OS flock child exited during writer lease acquisition"),
      )
    }

    return {
      lease: {
        holderId: input.holderId,
        holderPid: input.holderPid,
        lockFilePath: input.lockFilePath,
        leaseEpoch,
        owner,
        waitForFlockLoss: Deferred.await(flockLossDeferred),
      },
      flockChild,
      markIntentionalStop,
    }
  })

  const releaseResource = (acquired: AcquiredLeaseResource): Effect.Effect<void> =>
    Effect.sync(acquired.markIntentionalStop).pipe(
      Effect.andThen(
        match(unlinkLockMetaIfOwned(metaPath, input.holderId, input.holderPid, hostIo))
          .with({ _tag: "Success" }, () => Effect.void)
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.logWarning(`Failed to unlink writer lock metadata at ${metaPath}: ${failure}`),
          )
          .exhaustive(),
      ),
      Effect.ensuring(stopFlockChild(acquired.flockChild)),
    )

  const acquired = yield* Effect.acquireRelease(acquireResource, releaseResource)
  return acquired.lease
})

/**
 * Refreshes the active `WfWriterLease` heartbeat in Omnigraph under epoch fencing,
 * failing with `WriterLeaseHeldError` if the epoch was superseded by another writer
 * and failing closed on corrupt/missing lease rows.
 */
export const refreshWriterLease = Effect.fn("WfWriterLease.refresh")(function* (
  input: WriterLeaseRefreshInput,
): Effect.fn.Return<void, WriterLeaseHeldError | WorkflowStoreUnavailableError> {
  const hostIo = input.hostIo ?? nodeSyncHostIo
  const operation = WorkflowStoreOperation.make("WfWriterLease.refresh")
  const repoRoot = input.repoRoot ?? deriveRepoRootFromCommonGitDir(input.commonGitDir)
  const nowMs = (input.nowMs ?? (() => Date.now()))()
  const startTime = (input.readProcessStartTime ?? ((pid) => readLinuxProcStartTime(pid, hostIo)))(
    input.holderPid,
  )
  const owner = formatLeaseOwner(input.holderId, input.holderPid, startTime)

  const res = yield* invokeWorkflowStoreQueryWithMeta({
    repoRoot,
    operation,
    queryName: "wf_refresh_writer_lease",
    params: {
      name: "engine",
      owner,
      expectedEpoch: input.leaseEpoch,
      heartbeatMs: nowMs,
    },
    expectMutation: true,
    client: input.client,
    hostIo,
    env: input.env,
  })

  if (res.affectedNodes === 0) {
    const rows = yield* invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("WfWriterLease.get"),
      queryName: "wf_get_writer_lease",
      params: { name: "engine" },
      expectMutation: false,
      client: input.client,
      hostIo,
      env: input.env,
    })
    const currentRow = rows[0]
    if (currentRow === undefined) {
      return yield* new WriterLeaseHeldError({
        holderId: LeaseHolderId.make("no-active-lease"),
        lockFilePath: input.lockFilePath,
      })
    }
    const heldErr = yield* match(writerLeaseRowToHeldError(currentRow, input.lockFilePath))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(failure))),
      )
      .exhaustive()
    return yield* heldErr
  }
})

export {
  evaluateWriterLeaseTakeover,
  isLocalPidAlive,
  stopFlockChild,
  withAdvisoryFlock,
  type LeaseTakeoverDecision,
  type LeaseTakeoverEvaluationInput,
}
