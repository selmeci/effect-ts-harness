import { dirname, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type GitCommonDirPath,
  LeaseEpoch,
  type LeaseFilePath,
  type LeaseHolderId,
  type LeaseHolderPid,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  type WriterLeaseHeldError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  invokeWorkflowStoreQuery,
  invokeWorkflowStoreQueryWithMeta,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "./omnigraph-workflow-store.js"
import {
  acquireOsFlock,
  isLocalPidAlive,
  makeHeldLeaseError,
  metaFilePathFor,
  prepareLockPathsAndModes,
  readLinuxProcStartTime,
  readLockMeta,
  safeDecodeLeaseEpoch,
  stopFlockChild,
  unlinkLockMetaIfOwned,
  withAdvisoryFlock,
  writeLockMetaAtomic,
} from "./workflow/flock-lock.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Fallback heartbeat TTL (ms) when local PID liveness of a previous holder is indeterminate. */
export const WRITER_LEASE_HEARTBEAT_TTL_MS = 45_000

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

export interface WriterLeaseHandle {
  readonly holderId: LeaseHolderId
  readonly holderPid: LeaseHolderPid
  readonly lockFilePath: LeaseFilePath
  readonly leaseEpoch: LeaseEpoch
  readonly release: Effect.Effect<void>
}

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

const parseOwnerIdentity = (
  owner: string,
): {
  readonly holderId: string
  readonly holderPid: number | undefined
  readonly holderStartTime: string | undefined
} => {
  const hashIdx = owner.lastIndexOf("#")
  if (hashIdx > 0) {
    const suffix = owner.slice(hashIdx + 1)
    const atIdx = suffix.indexOf("@")
    const pidPart = atIdx > 0 ? suffix.slice(0, atIdx) : suffix
    const startPart = atIdx > 0 ? suffix.slice(atIdx + 1) : undefined
    if (/^[1-9]\d*$/.test(pidPart)) {
      const parsedPid = Number(pidPart)
      if (Number.isSafeInteger(parsedPid) && parsedPid >= 1) {
        return {
          holderId: owner.slice(0, hashIdx),
          holderPid: parsedPid,
          holderStartTime: startPart && startPart.length > 0 ? startPart : undefined,
        }
      }
    }
  }
  return { holderId: owner, holderPid: undefined, holderStartTime: undefined }
}

const deriveRepoRootFromCommonGitDir = (commonGitDir: GitCommonDirPath): AbsoluteRepoRoot => {
  const candidate = resolve(dirname(commonGitDir))
  return match(Schema.decodeOption(AbsoluteRepoRoot)(candidate))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => AbsoluteRepoRoot.make(resolve(commonGitDir)))
    .exhaustive()
}

/**
 * Acquires the single-writer workflow daemon lease via OS advisory `flock` on
 * `<git-common-dir>/harness/daemon.lock` and fenced `WfWriterLease` epoch takeover
 * in Omnigraph, failing with `WriterLeaseHeldError` when another live daemon owns it.
 */
export const acquireWriterLease = Effect.fn("WfWriterLease.acquire")(function* (
  input: WriterLeaseAcquireInput,
): Effect.fn.Return<WriterLeaseHandle, WriterLeaseHeldError | WorkflowStoreUnavailableError> {
  const hostIo = input.hostIo ?? nodeSyncHostIo
  const operation = WorkflowStoreOperation.make("WfWriterLease.acquire")
  const metaPath = metaFilePathFor(input.lockFilePath)
  const repoRoot = input.repoRoot ?? deriveRepoRootFromCommonGitDir(input.commonGitDir)
  const nowMsFn = input.nowMs ?? (() => Date.now())
  const pidAliveFn = input.isPidAlive ?? isLocalPidAlive
  const readStartTimeFn =
    input.readProcessStartTime ?? ((pid: number) => readLinuxProcStartTime(pid, hostIo))

  const acquireOmnigraphLease = Effect.gen(function* () {
    const holderStartTime = readStartTimeFn(input.holderPid)
    const owner = formatLeaseOwner(input.holderId, input.holderPid, holderStartTime)
    const nowMs = nowMsFn()

    const existingRows = yield* invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("WfWriterLease.get"),
      queryName: WorkflowStoreOperation.make("wf_get_writer_lease"),
      params: { name: "engine" },
      expectMutation: false,
      client: input.client,
      hostIo,
      env: input.env,
    })

    let leaseEpoch: LeaseEpoch
    const firstRow = existingRows[0]
    if (firstRow === undefined) {
      yield* invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("WfWriterLease.insert"),
        queryName: WorkflowStoreOperation.make("wf_insert_writer_lease"),
        params: { name: "engine", owner, leaseEpoch: 1, heartbeatMs: nowMs },
        expectMutation: true,
        client: input.client,
        hostIo,
        env: input.env,
      })
      leaseEpoch = LeaseEpoch.make(1)
    } else {
      const oldOwnerRaw = typeof firstRow.owner === "string" ? firstRow.owner : "unknown-holder"
      const oldEpoch = safeDecodeLeaseEpoch(firstRow.leaseEpoch)
      const oldHeartbeatMs = parseFiniteNumberOrString(firstRow.heartbeatMs) ?? 0
      const parsedOwner = parseOwnerIdentity(oldOwnerRaw)
      const metaOpt = readLockMeta(metaPath, hostIo)
      const metaPresent = match(metaOpt)
        .with({ _tag: "Some" }, () => true)
        .with({ _tag: "None" }, () => false)
        .exhaustive()
      const oldPid =
        parsedOwner.holderPid ??
        match(metaOpt)
          .with({ _tag: "Some" }, ({ value }) => value.holderPid)
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      const oldStartTime =
        parsedOwner.holderStartTime ??
        match(metaOpt)
          .with({ _tag: "Some" }, ({ value }) => value.holderStartTime)
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()

      const currentOldPidStartTime = oldPid !== undefined ? readStartTimeFn(oldPid) : undefined
      const pidReusedOrSamePid =
        oldPid !== undefined &&
        (oldPid === input.holderPid ||
          (oldStartTime !== undefined &&
            currentOldPidStartTime !== undefined &&
            oldStartTime !== currentOldPidStartTime))
      const staleByHeartbeat =
        !Number.isFinite(oldHeartbeatMs) || nowMs - oldHeartbeatMs >= WRITER_LEASE_HEARTBEAT_TTL_MS

      const canTakeOver =
        oldPid !== undefined
          ? !pidAliveFn(oldPid) || pidReusedOrSamePid || !metaPresent || staleByHeartbeat
          : !metaPresent || staleByHeartbeat

      if (!canTakeOver) {
        return yield* makeHeldLeaseError(parsedOwner.holderId, oldEpoch, input.lockFilePath, oldPid)
      }

      const nextEpoch = oldEpoch + 1
      const casRes = yield* invokeWorkflowStoreQueryWithMeta({
        repoRoot,
        operation: WorkflowStoreOperation.make("WfWriterLease.cas"),
        queryName: WorkflowStoreOperation.make("wf_cas_writer_lease"),
        params: {
          name: "engine",
          expectedEpoch: oldEpoch,
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
        return yield* makeHeldLeaseError(parsedOwner.holderId, oldEpoch, input.lockFilePath, oldPid)
      }
      leaseEpoch = LeaseEpoch.make(nextEpoch)
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

  const { flockChild, leaseEpoch } = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* match(prepareLockPathsAndModes(input.lockFilePath, metaPath, hostIo))
        .with({ _tag: "Success" }, () => Effect.void)
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.fail(toWorkflowStoreUnavailableError(operation, failure)),
        )
        .exhaustive()
      const child = yield* restore(acquireOsFlock(input.lockFilePath, metaPath, hostIo))
      const epoch = yield* restore(acquireOmnigraphLease).pipe(
        Effect.onExit((exit) =>
          match(exit)
            .with({ _tag: "Failure" }, () => stopFlockChild(child))
            .with({ _tag: "Success" }, () => Effect.void)
            .exhaustive(),
        ),
      )
      return { flockChild: child, leaseEpoch: epoch }
    }),
  )

  const release: Effect.Effect<void> = Effect.sync(() => {
    Result.try(() => {
      unlinkLockMetaIfOwned(metaPath, input.holderId, input.holderPid, hostIo)
    })
  }).pipe(Effect.ensuring(stopFlockChild(flockChild)))

  return {
    holderId: input.holderId,
    holderPid: input.holderPid,
    lockFilePath: input.lockFilePath,
    leaseEpoch,
    release,
  }
})

/**
 * Refreshes the active `WfWriterLease` heartbeat in Omnigraph under epoch fencing,
 * failing with `WriterLeaseHeldError` if the epoch was superseded by another writer.
 */
export const refreshWriterLease = Effect.fn("WfWriterLease.refresh")(function* (
  input: WriterLeaseRefreshInput,
): Effect.fn.Return<void, WriterLeaseHeldError | WorkflowStoreUnavailableError> {
  const hostIo = input.hostIo ?? nodeSyncHostIo
  const repoRoot = input.repoRoot ?? deriveRepoRootFromCommonGitDir(input.commonGitDir)
  const nowMs = (input.nowMs ?? (() => Date.now()))()
  const startTime = (input.readProcessStartTime ?? ((pid) => readLinuxProcStartTime(pid, hostIo)))(
    input.holderPid,
  )
  const owner = formatLeaseOwner(input.holderId, input.holderPid, startTime)

  const res = yield* invokeWorkflowStoreQueryWithMeta({
    repoRoot,
    operation: WorkflowStoreOperation.make("WfWriterLease.refresh"),
    queryName: WorkflowStoreOperation.make("wf_refresh_writer_lease"),
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
      queryName: WorkflowStoreOperation.make("wf_get_writer_lease"),
      params: { name: "engine" },
      expectMutation: false,
      client: input.client,
      hostIo,
      env: input.env,
    })
    const currentRow = rows[0]
    const currentOwner =
      typeof currentRow?.owner === "string"
        ? parseOwnerIdentity(currentRow.owner)
        : { holderId: "unknown-holder", holderPid: undefined, holderStartTime: undefined }
    return yield* makeHeldLeaseError(
      currentOwner.holderId,
      safeDecodeLeaseEpoch(currentRow?.leaseEpoch),
      input.lockFilePath,
      currentOwner.holderPid,
    )
  }
})

export { isLocalPidAlive, stopFlockChild, withAdvisoryFlock }
