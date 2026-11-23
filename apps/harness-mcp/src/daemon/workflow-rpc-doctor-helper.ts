import { Clock, Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  LeaseEpoch,
  LeaseHolderId,
  LeaseHolderPid,
  WorkflowDaemonCapability,
  WorkflowDoctorCheckItem,
  WorkflowDoctorCheckName,
  WorkflowDoctorRequest,
  type WorkflowDoctorResponse,
  WorkflowRebuiltRunCount,
  type WorkflowRpcEnvelope,
  WorkflowStoreOperation,
  toBoundedReason,
} from "@harness/contract"
import {
  WRITER_LEASE_HEARTBEAT_TTL_MS,
  invokeWorkflowStoreQueryWithMeta,
  rebuildWorkflowReadModelViews,
  resolveWorkflowRuntimePaths,
  withAdvisoryFlock,
} from "@harness/infra"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"
import {
  type WorkflowRpcHandlerInput,
  rpcError,
  rpcSuccess,
  validateRpcRepoRoot,
  withRebuildLock,
} from "./workflow-rpc-shared.js"

const DOCTOR_COMMAND = WorkflowDaemonCapability.make("workflow.doctor")
const DOCTOR_LEASE_OP = WorkflowStoreOperation.make("WorkflowDoctor.checkWriterLease")
const decodeWorkflowDoctorRequest = Schema.decodeUnknownEffect(WorkflowDoctorRequest)

const OmnigraphWriterLeaseRowSchema = Schema.Struct({
  owner: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  leaseEpoch: LeaseEpoch,
  heartbeatMs: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
const decodeOmnigraphLeaseRowOption = Schema.decodeUnknownOption(OmnigraphWriterLeaseRowSchema)

const LockMetaFileSchema = Schema.fromJsonString(
  Schema.Struct({
    holderId: LeaseHolderId,
    holderPid: LeaseHolderPid,
    leaseEpoch: LeaseEpoch,
  }),
)
const decodeLockMetaFileOption = Schema.decodeUnknownOption(LockMetaFileSchema)

const makeWriterLeaseCheck = (
  status: "ok" | "warn" | "fail",
  detail: string,
): WorkflowDoctorCheckItem =>
  WorkflowDoctorCheckItem.make({
    name: WorkflowDoctorCheckName.make("writer-lease"),
    status,
    detail: toBoundedReason(detail),
  })

/**
 * Inspects live Omnigraph `wf_get_writer_lease` state (epoch parity, owner parity,
 * heartbeat TTL staleness) and OS `daemon.lock` / `daemon.lock.meta.json` state.
 */
export const checkWriterLeaseDoctorHealth = (
  runtime: WorkflowDaemonRuntime,
  daemonLeaseEpoch: LeaseEpoch | undefined,
): Effect.Effect<WorkflowDoctorCheckItem> =>
  Effect.gen(function* () {
    if (daemonLeaseEpoch === undefined) {
      return makeWriterLeaseCheck("fail", "Daemon has no active writer lease epoch")
    }
    if (
      runtime.leaseFence.expectedLeaseEpoch !== undefined &&
      runtime.leaseFence.expectedLeaseEpoch !== daemonLeaseEpoch
    ) {
      return makeWriterLeaseCheck(
        "fail",
        `Daemon leaseFence epoch (${runtime.leaseFence.expectedLeaseEpoch}) mismatches active epoch (${daemonLeaseEpoch})`,
      )
    }

    const leaseQueryRes = yield* invokeWorkflowStoreQueryWithMeta({
      repoRoot: runtime.canonicalRepoRoot,
      operation: DOCTOR_LEASE_OP,
      queryName: "wf_get_writer_lease",
      params: { name: "engine" },
      expectMutation: false,
      client: runtime.client,
      hostIo: runtime.hostIo,
      env: runtime.env,
    }).pipe(Effect.result)

    const leaseRowOutcome = match(leaseQueryRes)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "Fail" as const,
        detail: `Failed to query live wf_get_writer_lease row: ${failure.message}`,
      }))
      .with({ _tag: "Success" }, ({ success }) => {
        const firstRow = success.rows[0]
        if (firstRow === undefined) {
          return {
            _tag: "Fail" as const,
            detail: "Omnigraph wf_get_writer_lease row for 'engine' is missing",
          }
        }
        return match(decodeOmnigraphLeaseRowOption(firstRow))
          .with({ _tag: "None" }, () => ({
            _tag: "Fail" as const,
            detail: "Omnigraph wf_get_writer_lease row is malformed",
          }))
          .with({ _tag: "Some" }, ({ value: row }) => ({
            _tag: "Row" as const,
            row,
          }))
          .exhaustive()
      })
      .exhaustive()

    return yield* match(leaseRowOutcome)
      .with({ _tag: "Fail" }, ({ detail }) => Effect.succeed(makeWriterLeaseCheck("fail", detail)))
      .with({ _tag: "Row" }, ({ row }) =>
        Effect.gen(function* () {
          if (row.leaseEpoch !== daemonLeaseEpoch) {
            return makeWriterLeaseCheck(
              "fail",
              `Omnigraph wf_get_writer_lease epoch (${row.leaseEpoch}) mismatches daemon epoch (${daemonLeaseEpoch})`,
            )
          }
          if (
            runtime.leaseFence.expectedLeaseOwner !== undefined &&
            row.owner !== runtime.leaseFence.expectedLeaseOwner
          ) {
            return makeWriterLeaseCheck(
              "fail",
              `Omnigraph wf_get_writer_lease owner '${row.owner}' mismatches daemon owner '${runtime.leaseFence.expectedLeaseOwner}'`,
            )
          }

          const warnings: Array<string> = []
          const nowMs = yield* Clock.currentTimeMillis
          const heartbeatAgeMs = nowMs - row.heartbeatMs
          if (heartbeatAgeMs >= WRITER_LEASE_HEARTBEAT_TTL_MS) {
            warnings.push(
              `Omnigraph writer lease heartbeat is stale (${heartbeatAgeMs}ms >= ${WRITER_LEASE_HEARTBEAT_TTL_MS}ms TTL)`,
            )
          }

          const lockFilePath =
            runtime.leaseFence.lockFilePath ??
            resolveWorkflowRuntimePaths(runtime.commonGitDir).lockFilePath
          const metaPath = `${lockFilePath}.meta.json`

          if (runtime.hostIo.isSymbolicLinkSync(lockFilePath)) {
            return makeWriterLeaseCheck("fail", `Refusing symlink OS lock file '${lockFilePath}'`)
          }
          if (!runtime.hostIo.existsSync(lockFilePath)) {
            return makeWriterLeaseCheck(
              "fail",
              `OS lock file '${lockFilePath}' is missing (unlocked)`,
            )
          }

          const flockProbe = yield* withAdvisoryFlock(
            lockFilePath,
            Effect.void,
            runtime.hostIo,
          ).pipe(Effect.result)
          const flockFailureDetail = match(flockProbe)
            .with({ _tag: "Success" }, () => `OS flock on '${lockFilePath}' is unlocked`)
            .with({ _tag: "Failure" }, ({ failure }) =>
              match(failure)
                .with({ _tag: "WriterLeaseHeldError" }, () => undefined)
                .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
                  warnings.push(`OS flock probe unavailable for '${lockFilePath}': ${err.reason}`)
                  return undefined
                })
                .exhaustive(),
            )
            .exhaustive()

          if (flockFailureDetail !== undefined) {
            return makeWriterLeaseCheck("fail", flockFailureDetail)
          }

          if (runtime.hostIo.isSymbolicLinkSync(metaPath)) {
            return makeWriterLeaseCheck("fail", `Refusing symlink lock metadata file '${metaPath}'`)
          }
          if (!runtime.hostIo.existsSync(metaPath)) {
            warnings.push(`Lock metadata file '${metaPath}' is missing`)
          } else {
            const rawMetaRes = Result.try(() => runtime.hostIo.readTextSync(metaPath))
            const metaCheckErr = match(rawMetaRes)
              .with({ _tag: "Failure" }, () => `Lock metadata file '${metaPath}' is unreadable`)
              .with({ _tag: "Success" }, ({ success: rawMeta }) =>
                match(decodeLockMetaFileOption(rawMeta))
                  .with({ _tag: "None" }, () => `Lock metadata file '${metaPath}' is corrupt`)
                  .with({ _tag: "Some" }, ({ value: meta }) => {
                    if (meta.leaseEpoch !== daemonLeaseEpoch) {
                      return `Lock metadata epoch (${meta.leaseEpoch}) mismatches daemon epoch (${daemonLeaseEpoch})`
                    }
                    if (
                      runtime.leaseFence.ownerId !== undefined &&
                      meta.holderId !== runtime.leaseFence.ownerId
                    ) {
                      return `Lock metadata holder '${meta.holderId}' mismatches daemon holder '${runtime.leaseFence.ownerId}'`
                    }
                    return undefined
                  })
                  .exhaustive(),
              )
              .exhaustive()
            if (metaCheckErr !== undefined) {
              return makeWriterLeaseCheck("fail", metaCheckErr)
            }
          }

          if (warnings.length > 0) {
            return makeWriterLeaseCheck("warn", warnings.join("; "))
          }

          return makeWriterLeaseCheck(
            "ok",
            `Active writer lease epoch ${daemonLeaseEpoch} verified against wf_get_writer_lease and OS daemon.lock`,
          )
        }),
      )
      .exhaustive()
  })

/** Processes `workflow.doctor` (`check-only` or `rebuild`) over daemon Unix socket IPC. */
export const handleDaemonWorkflowDoctorRequest = Effect.fn("WorkflowRpcDaemon.handleDoctorRequest")(
  function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        input.requestId,
        DOCTOR_COMMAND,
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }

    const res = yield* decodeWorkflowDoctorRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.doctor request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          const validated = yield* validateRpcRepoRoot(req.repoRoot, input.scope)
          const writerLeaseCheck = yield* checkWriterLeaseDoctorHealth(
            runtime,
            input.writerLeaseEpoch,
          )
          const checks: Array<WorkflowDoctorCheckItem> = [
            WorkflowDoctorCheckItem.make({
              name: WorkflowDoctorCheckName.make("worktree-binding"),
              status: "ok",
              detail: toBoundedReason(
                `Validated ${validated.kind} worktree at '${validated.worktreeRoot}'`,
              ),
            }),
            writerLeaseCheck,
          ]

          const storeAvailability = yield* runtime.readModelQuery.probeAvailability
          checks.push(
            WorkflowDoctorCheckItem.make({
              name: WorkflowDoctorCheckName.make("omnigraph-read-model"),
              status: match(storeAvailability)
                .with("ready", () => "ok" as const)
                .with("paused", () => "warn" as const)
                .with("inactive", () => "fail" as const)
                .exhaustive(),
              detail: toBoundedReason(`Workflow read-model store status: ${storeAvailability}`),
            }),
          )

          const rebuiltRunCount = yield* match(req.mode)
            .with("check-only", () => Effect.succeed(WorkflowRebuiltRunCount.make(0)))
            .with("rebuild", () =>
              match(writerLeaseCheck.status)
                .with("fail", () =>
                  Effect.fail(
                    toBoundedReason(
                      `Refusing read-model rebuild while writer-lease check failed: ${writerLeaseCheck.detail}`,
                    ),
                  ),
                )
                .with("ok", "warn", () =>
                  withRebuildLock(
                    runtime,
                    rebuildWorkflowReadModelViews(runtime.canonicalRepoRoot, {
                      ...(runtime.client !== undefined ? { client: runtime.client } : {}),
                      hostIo: runtime.hostIo,
                      ...(runtime.env !== undefined ? { env: runtime.env } : {}),
                      ...runtime.leaseFence,
                    }),
                  ).pipe(
                    Effect.mapError((err) =>
                      toBoundedReason(err.message, "Failed to rebuild workflow read-model views"),
                    ),
                    Effect.tap((count) =>
                      Effect.sync(() => {
                        checks.push(
                          WorkflowDoctorCheckItem.make({
                            name: WorkflowDoctorCheckName.make("read-model-rebuild"),
                            status: "ok",
                            detail: toBoundedReason(
                              `Rebuilt ${count} run view bundle(s) from authoritative journal`,
                            ),
                          }),
                        )
                      }),
                    ),
                  ),
                )
                .exhaustive(),
            )
            .exhaustive()

          return {
            repoRoot: validated.worktreeRoot,
            commonGitDir: validated.commonGitDir,
            ...(input.writerLeaseEpoch !== undefined
              ? { writerLeaseEpoch: input.writerLeaseEpoch }
              : {}),
            rebuiltRunCount,
            checks,
          } satisfies WorkflowDoctorResponse
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) =>
        rpcError(input.requestId, DOCTOR_COMMAND, failure),
      )
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(input.requestId, DOCTOR_COMMAND, response),
      )
      .exhaustive()
  },
)
