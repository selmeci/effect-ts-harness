import { createHash } from "node:crypto"
import { constants } from "node:os"
import { Effect, Layer, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AgentFailureReason,
  type CompleteSharedStepInput,
  type CompleteUnitInput,
  GateExitCode,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyFailureDetail,
  SHARED_STEP_UNIT_ID,
  UnitOutcome,
  UnitRejection,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowTimeoutMs,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  compareCodeUnits,
  parsePackageVerifyCommand,
  toErrorReasonMessage,
  toPackageVerifyCommandArgv,
} from "@harness/contract"
import { checkVerifyStamp, computeWorkspaceTreeHashChecked } from "@harness/gates"
import { UnitVerifier, type UnitVerifierShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { spawnVerifyCommand } from "./verify-child-process.js"

/** Optional host/command overrides injected into `UnitVerifierLive` for tests. */
export interface UnitVerifierOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly verifyTimeoutMs?: number | undefined
  readonly runVerifyCommand?:
    | ((
        cmd: string,
        args: ReadonlyArray<string>,
        opts: {
          readonly cwd: string
          readonly env: Readonly<Record<string, string | undefined>>
          readonly timeoutMs: number
        },
      ) => Effect.Effect<SyncHostExecResult, WorkspaceFsError>)
    | undefined
}

const DEFAULT_VERIFY_TIMEOUT_MS: WorkflowTimeoutMs = WORKFLOW_TIMEOUT_BUDGETS.unitVerifyMs

const HARNESS_STAMP_ARTIFACTS: ReadonlySet<string> = new Set([
  ".harness/verify-stamp.json",
  ".harness/mutate-stamp.json",
])

const decodeOwnedRelPathOption = Schema.decodeOption(OwnedRelPath)

const toFsError = (cwd: string, reason: unknown): WorkspaceFsError =>
  new WorkspaceFsError({
    filePath: WorkspaceFilePath.make(cwd),
    operation: WorkspaceFsOperation.make("read"),
    reason: toErrorReasonMessage(reason, "Unit verification filesystem error"),
  })

const normalizeRelPath = (raw: string): string => {
  let normalized = raw.trim().replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized
}

const normalizeForCompare = (relPath: string): string => relPath.normalize("NFC")

const isCoveredByOwner = (candidate: string, ownerPrefix: string): boolean => {
  const normCandidate = normalizeForCompare(candidate)
  const normOwner = normalizeForCompare(ownerPrefix)
  return normCandidate === normOwner || normCandidate.startsWith(`${normOwner}/`)
}

const makeEnvHostIo = (
  hostIo: ExtendedHostIo,
  env: Readonly<Record<string, string | undefined>>,
): SyncHostIo => ({
  ...hostIo,
  getEnv: () => env,
})

const withoutWorktreeEnv = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const nextEnv: Record<string, string | undefined> = { ...baseEnv }
  Reflect.deleteProperty(nextEnv, "HARNESS_WORKTREE_ID")
  Reflect.deleteProperty(nextEnv, "HARNESS_STATE_DIR")
  return nextEnv
}

const runGitNullDelimitedPaths = (
  hostIo: ExtendedHostIo,
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ReadonlyArray<string>, WorkspaceFsError> =>
  Effect.gen(function* () {
    const res: SyncHostExecResult = yield* Effect.try({
      try: () => hostIo.execFileSync("git", args, { cwd, env }),
      catch: (cause) => toFsError(cwd, cause),
    })
    return yield* match(res)
      .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
        exitCode === 0
          ? Effect.succeed(
              stdout
                .split("\0")
                .map(normalizeRelPath)
                .filter((line) => line.length > 0),
            )
          : Effect.fail(
              toFsError(
                cwd,
                `git ${args.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
              ),
            ),
      )
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.fail(toFsError(cwd, `git ${args.join(" ")} timed out: ${stderr.trim()}`)),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.fail(toFsError(cwd, `git ${args.join(" ")} signaled (${signal})`)),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.fail(toFsError(cwd, `git ${args.join(" ")} spawn failed: ${spawnError}`)),
      )
      .exhaustive()
  })

interface GatheredChangedPaths {
  readonly all: ReadonlyArray<string>
  readonly dirty: ReadonlyArray<string>
}

const gatherChangedPaths = Effect.fnUntraced(function* (
  hostIo: ExtendedHostIo,
  cwd: string,
  baseSha: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<GatheredChangedPaths, WorkspaceFsError> {
  const committed = yield* runGitNullDelimitedPaths(
    hostIo,
    cwd,
    ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", `${baseSha}..HEAD`],
    env,
  )
  const unstaged = yield* runGitNullDelimitedPaths(
    hostIo,
    cwd,
    ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", "HEAD"],
    env,
  )
  const staged = yield* runGitNullDelimitedPaths(
    hostIo,
    cwd,
    ["-c", "core.quotePath=false", "diff", "--no-renames", "--cached", "--name-only", "-z"],
    env,
  )
  const untracked = yield* runGitNullDelimitedPaths(
    hostIo,
    cwd,
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    env,
  )

  const uniqueAll = new Set<string>()
  const uniqueDirty = new Set<string>()
  for (const rel of committed) {
    if (!HARNESS_STAMP_ARTIFACTS.has(rel)) {
      uniqueAll.add(rel)
    }
  }
  for (const rel of [...unstaged, ...staged, ...untracked]) {
    if (!HARNESS_STAMP_ARTIFACTS.has(rel)) {
      uniqueAll.add(rel)
      uniqueDirty.add(rel)
    }
  }
  return {
    all: Array.from(uniqueAll).sort(compareCodeUnits),
    dirty: Array.from(uniqueDirty).sort(compareCodeUnits),
  }
})

const MAX_VERIFY_DETAIL_CHARS = 2048

const toPackageVerifyFailureDetail = (stderr: string): PackageVerifyFailureDetail | undefined => {
  const trimmed = stderr.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const tail =
    trimmed.length <= MAX_VERIFY_DETAIL_CHARS
      ? trimmed
      : trimmed.slice(-MAX_VERIFY_DETAIL_CHARS).trim()
  if (tail.length === 0) {
    return undefined
  }
  return match(Schema.decodeOption(PackageVerifyFailureDetail)(tail))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const resolveSignaledExitCode = (signal: string): GateExitCode => {
  const signalNumber = Reflect.get(constants.signals, signal)
  if (typeof signalNumber === "number" && Number.isInteger(signalNumber) && signalNumber >= 1) {
    return GateExitCode.make(Math.min(255, 128 + signalNumber))
  }
  return GateExitCode.make(1)
}

const decodeChangedPaths = (
  rawPaths: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<OwnedRelPath>, string> => {
  const paths: Array<OwnedRelPath> = []
  for (const raw of rawPaths) {
    const decoded = decodeOwnedRelPathOption(raw)
    const rejectedPath = match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        paths.push(value)
        return undefined
      })
      .with({ _tag: "None" }, () => raw)
      .exhaustive()
    if (rejectedPath !== undefined) {
      return Result.fail(rejectedPath)
    }
  }
  return Result.succeed(paths)
}

const findOffendingPaths = (
  changedPaths: ReadonlyArray<OwnedRelPath>,
  allowedOwners: ReadonlyArray<OwnedRelPath>,
): ReadonlyArray<OwnedRelPath> =>
  changedPaths.filter((changed) => !allowedOwners.some((owner) => isCoveredByOwner(changed, owner)))

const computePackageStampHash = (
  unitId: string,
  commandOrTag: string,
  changedPaths: ReadonlyArray<OwnedRelPath>,
  treeHash: string,
): PackageStampHash => {
  const hasher = createHash("sha256")
  hasher.update(
    JSON.stringify({
      unitId,
      commandOrTag,
      changedPaths: [...changedPaths].sort(compareCodeUnits),
      treeHash,
    }),
  )
  return PackageStampHash.make(hasher.digest("hex"))
}

/** Verifies unit write-set ownership and verification stamps/commands for manual & automatic modes. */
export const completeUnitImpl = Effect.fn("Harness.completeUnit")(function* (
  input: CompleteUnitInput,
  options?: UnitVerifierOptions,
): Effect.fn.Return<UnitOutcome, WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const injectedHostIo = options?.hostIo
  const baseEnv = options?.env ?? hostIo.getEnv()

  const gathered = yield* gatherChangedPaths(hostIo, input.cwd, input.baseSha, baseEnv)
  const filteredRaw =
    input.level === "slice"
      ? gathered.all.filter(
          (changed) =>
            !input.siblingInFlightOwnedPaths.some((sib) => isCoveredByOwner(changed, sib)),
        )
      : gathered.all

  if (filteredRaw.length === 0) {
    return UnitOutcome.cases.Rejected.make({
      unitId: input.unit.unitId,
      attempt: input.attempt,
      rejection: UnitRejection.cases.AgentFailed.make({
        reason: AgentFailureReason.make("No changed files detected for unit completion"),
      }),
    })
  }

  return yield* match(decodeChangedPaths(filteredRaw))
    .with({ _tag: "Failure" }, ({ failure: offendingPath }) =>
      Effect.succeed(
        UnitOutcome.cases.Rejected.make({
          unitId: input.unit.unitId,
          attempt: input.attempt,
          rejection: UnitRejection.cases.AgentFailed.make({
            reason: AgentFailureReason.make(
              `Changed path '${offendingPath}' violates protected path rules`,
            ),
          }),
        }),
      ),
    )
    .with({ _tag: "Success" }, ({ success: changedPaths }) => {
      const offendingPaths = findOffendingPaths(changedPaths, input.unit.ownedRelPaths)
      const [firstOffending, ...restOffending] = offendingPaths
      if (firstOffending !== undefined) {
        return Effect.succeed(
          UnitOutcome.cases.Rejected.make({
            unitId: input.unit.unitId,
            attempt: input.attempt,
            rejection: UnitRejection.cases.WriteSetViolation.make({
              offendingPaths: [firstOffending, ...restOffending],
            }),
          }),
        )
      }

      return match(input.level)
        .with("slice", () =>
          match(input.unit)
            .with({ _tag: "PackageUnit" }, (pkgUnit) =>
              Effect.gen(function* () {
                const parsedCmd = match(parsePackageVerifyCommand(pkgUnit.packageVerifyCommand))
                  .with({ _tag: "Some" }, ({ value }) => toPackageVerifyCommandArgv(value))
                  .with({ _tag: "None" }, () => undefined)
                  .exhaustive()
                if (parsedCmd === undefined) {
                  return yield* toFsError(
                    input.cwd,
                    `Invalid or empty packageVerifyCommand: '${pkgUnit.packageVerifyCommand}'`,
                  )
                }

                const verifyTimeoutMs = options?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
                const verifyEnv: Readonly<Record<string, string | undefined>> = {
                  ...withoutWorktreeEnv(baseEnv),
                  HARNESS_WORKTREE_ID: pkgUnit.unitId,
                }
                const execRes = yield* options?.runVerifyCommand !== undefined
                  ? options.runVerifyCommand(parsedCmd.executable, parsedCmd.args, {
                      cwd: input.cwd,
                      env: verifyEnv,
                      timeoutMs: verifyTimeoutMs,
                    })
                  : injectedHostIo !== undefined
                    ? Effect.try({
                        try: () =>
                          injectedHostIo.execFileSync(parsedCmd.executable, parsedCmd.args, {
                            cwd: input.cwd,
                            env: verifyEnv,
                            timeoutMs: verifyTimeoutMs,
                          }),
                        catch: (cause) => toFsError(input.cwd, cause),
                      })
                    : spawnVerifyCommand(parsedCmd.executable, parsedCmd.args, {
                        cwd: input.cwd,
                        env: verifyEnv,
                        timeoutMs: verifyTimeoutMs,
                      })

                return yield* match(execRes)
                  .with({ _tag: "Exited" }, ({ exitCode, stderr }) => {
                    if (exitCode !== 0) {
                      const detail = toPackageVerifyFailureDetail(stderr)
                      return Effect.succeed(
                        UnitOutcome.cases.Rejected.make({
                          unitId: pkgUnit.unitId,
                          attempt: input.attempt,
                          rejection: UnitRejection.cases.PackageVerifyFailed.make({
                            exitCode: GateExitCode.make(Math.min(255, Math.max(1, exitCode))),
                            failureKind: "non-zero-exit",
                            ...(detail !== undefined ? { detail } : {}),
                          }),
                        }),
                      )
                    }
                    const treeHashRes = computeWorkspaceTreeHashChecked(
                      input.cwd,
                      makeEnvHostIo(hostIo, verifyEnv),
                    )
                    return match(treeHashRes)
                      .with({ _tag: "Failure" }, ({ failure }) =>
                        Effect.fail(toFsError(input.cwd, failure)),
                      )
                      .with({ _tag: "Success" }, ({ success: treeHash }) =>
                        Effect.succeed(
                          UnitOutcome.cases.Completed.make({
                            unitId: pkgUnit.unitId,
                            attempt: input.attempt,
                            changedPaths: [...changedPaths],
                            packageStampHash: computePackageStampHash(
                              pkgUnit.unitId,
                              pkgUnit.packageVerifyCommand,
                              changedPaths,
                              treeHash,
                            ),
                          }),
                        ),
                      )
                      .exhaustive()
                  })
                  .with({ _tag: "TimedOut" }, ({ stderr }) => {
                    const detail = toPackageVerifyFailureDetail(stderr)
                    return Effect.succeed(
                      UnitOutcome.cases.Rejected.make({
                        unitId: pkgUnit.unitId,
                        attempt: input.attempt,
                        rejection: UnitRejection.cases.PackageVerifyFailed.make({
                          exitCode: GateExitCode.make(1),
                          failureKind: "timed-out",
                          ...(detail !== undefined ? { detail } : {}),
                        }),
                      }),
                    )
                  })
                  .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
                    const detail = toPackageVerifyFailureDetail(stderr)
                    return Effect.succeed(
                      UnitOutcome.cases.Rejected.make({
                        unitId: pkgUnit.unitId,
                        attempt: input.attempt,
                        rejection: UnitRejection.cases.PackageVerifyFailed.make({
                          exitCode: resolveSignaledExitCode(signal),
                          failureKind: "signaled",
                          ...(detail !== undefined ? { detail } : {}),
                        }),
                      }),
                    )
                  })
                  .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
                    Effect.fail(
                      toFsError(
                        input.cwd,
                        `Package verify command '${pkgUnit.packageVerifyCommand}' failed to spawn: ${spawnError}`,
                      ),
                    ),
                  )
                  .exhaustive()
              }),
            )
            .with({ _tag: "SliceUnit" }, (sliceUnit) =>
              Effect.sync(() => {
                const stampHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))
                const stampResult = checkVerifyStamp(input.cwd, stampHostIo)
                return stampResult.valid
                  ? UnitOutcome.cases.Completed.make({
                      unitId: sliceUnit.unitId,
                      attempt: input.attempt,
                      changedPaths: [...changedPaths],
                      packageStampHash: PackageStampHash.make(stampResult.stamp.treeHash),
                    })
                  : UnitOutcome.cases.Rejected.make({
                      unitId: sliceUnit.unitId,
                      attempt: input.attempt,
                      rejection: UnitRejection.cases.StampMissing.make({}),
                    })
              }),
            )
            .exhaustive(),
        )
        .with("epic", () =>
          Effect.sync(() => {
            if (gathered.dirty.length > 0) {
              return UnitOutcome.cases.Rejected.make({
                unitId: input.unit.unitId,
                attempt: input.attempt,
                rejection: UnitRejection.cases.AgentFailed.make({
                  reason: AgentFailureReason.make(
                    `L1 epic completion requires all changes committed on slice branch (uncommitted: ${gathered.dirty.slice(0, 5).join(", ")})`,
                  ),
                }),
              })
            }
            const stampHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))
            const stampResult = checkVerifyStamp(input.cwd, stampHostIo)
            return stampResult.valid
              ? UnitOutcome.cases.Completed.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  changedPaths: [...changedPaths],
                  packageStampHash: PackageStampHash.make(stampResult.stamp.treeHash),
                })
              : UnitOutcome.cases.Rejected.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  rejection: UnitRejection.cases.StampMissing.make({}),
                })
          }),
        )
        .exhaustive()
    })
    .exhaustive()
})

/** Verifies sequential `sharedStepPaths` changes on canonical checkout (`SPEC-0023 REQ-2.1` / `RFC-0013 REQ-1.4`). */
export const completeSharedStepImpl = Effect.fn("Harness.completeSharedStep")(function* (
  input: CompleteSharedStepInput,
  options?: UnitVerifierOptions,
): Effect.fn.Return<UnitOutcome, WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const baseEnv = options?.env ?? hostIo.getEnv()

  const gathered = yield* gatherChangedPaths(hostIo, input.cwd, input.baseSha, baseEnv)
  const filteredRaw = gathered.all.filter(
    (changed) =>
      !input.priorUnitOwnedPaths.some((priorOwner) => isCoveredByOwner(changed, priorOwner)),
  )
  if (filteredRaw.length === 0) {
    return UnitOutcome.cases.Rejected.make({
      unitId: SHARED_STEP_UNIT_ID,
      attempt: input.attempt,
      rejection: UnitRejection.cases.AgentFailed.make({
        reason: AgentFailureReason.make("No changed files detected for shared step completion"),
      }),
    })
  }

  return yield* match(decodeChangedPaths(filteredRaw))
    .with({ _tag: "Failure" }, ({ failure: offendingPath }) =>
      Effect.succeed(
        UnitOutcome.cases.Rejected.make({
          unitId: SHARED_STEP_UNIT_ID,
          attempt: input.attempt,
          rejection: UnitRejection.cases.AgentFailed.make({
            reason: AgentFailureReason.make(
              `Changed path '${offendingPath}' violates protected path rules`,
            ),
          }),
        }),
      ),
    )
    .with({ _tag: "Success" }, ({ success: changedPaths }) => {
      const offendingPaths = findOffendingPaths(changedPaths, input.sharedStepPaths)
      const [firstOffending, ...restOffending] = offendingPaths
      if (firstOffending !== undefined) {
        return Effect.succeed(
          UnitOutcome.cases.Rejected.make({
            unitId: SHARED_STEP_UNIT_ID,
            attempt: input.attempt,
            rejection: UnitRejection.cases.WriteSetViolation.make({
              offendingPaths: [firstOffending, ...restOffending],
            }),
          }),
        )
      }

      const treeHashRes = computeWorkspaceTreeHashChecked(
        input.cwd,
        makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv)),
      )
      return match(treeHashRes)
        .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(toFsError(input.cwd, failure)))
        .with({ _tag: "Success" }, ({ success: treeHash }) =>
          Effect.succeed(
            UnitOutcome.cases.Completed.make({
              unitId: SHARED_STEP_UNIT_ID,
              attempt: input.attempt,
              changedPaths: [...changedPaths],
              packageStampHash: computePackageStampHash(
                SHARED_STEP_UNIT_ID,
                "shared-step",
                changedPaths,
                treeHash,
              ),
            }),
          ),
        )
        .exhaustive()
    })
    .exhaustive()
})

/** Builds a `UnitVerifier` layer using optional host I/O overrides. */
const makeUnitVerifierLayer = (options?: UnitVerifierOptions): Layer.Layer<UnitVerifier> =>
  Layer.succeed(UnitVerifier, {
    completeUnit: (input) => completeUnitImpl(input, options),
    completeSharedStep: (input) => completeSharedStepImpl(input, options),
  } satisfies UnitVerifierShape)

/** Production `UnitVerifier` layer backed by real git diffing and package verification subprocesses. */
export const UnitVerifierLive: Layer.Layer<UnitVerifier> = makeUnitVerifierLayer()

export { makeUnitVerifierLayer }
