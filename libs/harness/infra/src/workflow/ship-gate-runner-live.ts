import { join } from "node:path"
import { Cause, Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type CircuitBreakerStatus,
  GateDurationMs,
  GateExitCode,
  MutationRestoreError,
  ShipFailureMessage,
  ShipGateFailedError,
  type ShipRecoverBackupInput,
  type ShipStage,
  type ShipStageCommandInput,
  ShipStagePassed,
  ShipStreamProgressEvent,
  type ShipTreeHashInput,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkspaceTreeHash,
  isPureInterruptCause,
  toErrorReasonMessage,
} from "@harness/contract"
import {
  appendFrictionEvent,
  computeWorkspaceTreeHashChecked,
  decideLoopThrashing,
  readFrictionEvents,
  recoverStartupBackup,
} from "@harness/gates"
import { ShipGateRunner, type ShipGateRunnerShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  resolveShipFormatCheckFiles,
  resolveSignaledExitCode,
  toGateExitCode,
  toGateStderrSummary,
} from "./ship-format-files.js"
import { spawnVerifyCommand } from "./verify-child-process.js"

/** Controller coordinating cancellation and completion waiting for active `ShipWorkflow` gates. */
export interface ShipActiveGateController {
  readonly cancelAndAwait: (key: string) => Effect.Effect<void>
  readonly clear: (key: string) => void
  readonly register: (key: string, cancel: () => void, done: Deferred.Deferred<void>) => boolean
  readonly unregister: (key: string, done: Deferred.Deferred<void>) => void
}

interface ActiveGateEntry {
  cancelled: boolean
  cancel: (() => void) | undefined
  done: Deferred.Deferred<void> | undefined
}

/** Creates a closure-scoped `ShipActiveGateController` with no module-global mutable state. */
const createShipActiveGateController = (): ShipActiveGateController => {
  const entries = new Map<string, ActiveGateEntry>()

  const register = (key: string, cancel: () => void, done: Deferred.Deferred<void>): boolean => {
    const existing = entries.get(key)
    if (existing?.cancelled === true) {
      Deferred.doneUnsafe(done, Effect.void)
      return false
    }
    entries.set(key, { cancelled: false, cancel, done })
    return true
  }

  const unregister = (key: string, done: Deferred.Deferred<void>): void => {
    const existing = entries.get(key)
    if (existing === undefined || existing.done !== done) {
      return
    }
    if (existing.cancelled) {
      existing.cancel = undefined
      existing.done = undefined
    } else {
      entries.delete(key)
    }
  }

  const cancelAndAwait = (key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const existing = entries.get(key)
      if (existing === undefined) {
        entries.set(key, { cancelled: true, cancel: undefined, done: undefined })
        return
      }
      existing.cancelled = true
      const cancel = existing.cancel
      const done = existing.done
      if (cancel !== undefined) {
        cancel()
      }
      if (done !== undefined) {
        yield* Deferred.await(done)
      }
    })

  const clear = (key: string): void => {
    entries.delete(key)
  }

  return {
    cancelAndAwait,
    clear,
    register,
    unregister,
  }
}

/** Optional overrides injected into `makeShipGateRunnerLayer`. */
export interface ShipGateRunnerOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly gateTimeoutMs?: number | undefined
  readonly onProgress?: ((event: ShipStreamProgressEvent) => void) | undefined
  readonly activeGateController?: ShipActiveGateController | undefined
  readonly runCommand?:
    | ((
        cmd: string,
        args: ReadonlyArray<string>,
        opts: {
          readonly cwd: string
          readonly env: Readonly<Record<string, string | undefined>>
          readonly timeoutMs: number
        },
      ) => Effect.Effect<SyncHostExecResult, Error>)
    | undefined
}

/** Resolved subprocess command and argument vector for one `ShipStage`. */
export interface ResolvedShipGateCommand {
  readonly cmd: string
  readonly args: ReadonlyArray<string>
}

const MAX_FAILURE_MESSAGE_CHARS = 2048

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecordOption = Schema.decodeUnknownOption(JsonRecordSchema)

const makeEnvHostIo = (
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): SyncHostIo => ({ ...hostIo, getEnv: () => env })

const withoutWorktreeEnv = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const nextEnv: Record<string, string | undefined> = { ...baseEnv }
  Reflect.deleteProperty(nextEnv, "HARNESS_WORKTREE_ID")
  Reflect.deleteProperty(nextEnv, "HARNESS_STATE_DIR")
  return nextEnv
}

const withoutWorktreeEnvPlusCi = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => ({
  ...withoutWorktreeEnv(baseEnv),
  CI: "true",
})

/** Resolves the canonical CLI command for one `ShipStage`, or `undefined` when `format-check` has 0 files. */
const resolveShipGateCommand = (
  stage: ShipStage,
  formatFiles: ReadonlyArray<string>,
): ResolvedShipGateCommand | undefined =>
  match(stage)
    .with("format-check", () =>
      formatFiles.length > 0
        ? { cmd: "pnpm", args: ["exec", "oxfmt", "--check", "--", ...formatFiles] }
        : undefined,
    )
    .with("gc-strict", () => ({ cmd: "pnpm", args: ["harness", "gc", "--strict"] }))
    .with("ontology-check-strict", () => ({
      cmd: "pnpm",
      args: ["harness", "ontology", "check", "--strict"],
    }))
    .with("mutate-strict", () => ({ cmd: "pnpm", args: ["harness", "mutate", "--strict"] }))
    .with("verify", () => ({ cmd: "pnpm", args: ["harness", "verify"] }))
    .with("done", () => ({ cmd: "pnpm", args: ["harness", "done", "--cli"] }))
    .exhaustive()

/** Parses `harness done --cli` stdout JSON and extracts a trimmed block reason if `decision` is `"block"` or `"continue"`. */
const extractDoneStdoutBlockReason = (stdout: string): string | undefined => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const directOpt = decodeJsonRecordOption(trimmed)
  const parsedOpt = match(directOpt)
    .with({ _tag: "Some" }, (some) => some)
    .with({ _tag: "None" }, () => {
      const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const lastLine = lines[lines.length - 1]
      return lastLine !== undefined ? decodeJsonRecordOption(lastLine) : directOpt
    })
    .exhaustive()

  return match(parsedOpt)
    .with({ _tag: "None" }, () => undefined)
    .with({ _tag: "Some" }, ({ value }) => {
      if (value.decision !== "block" && value.decision !== "continue") {
        return undefined
      }
      if (typeof value.reason === "string" && value.reason.trim().length > 0) {
        return value.reason.trim()
      }
      return `harness done reported decision '${value.decision}'`
    })
    .exhaustive()
}

const toShipFailureMessageText = (
  raw: string,
  fallback = "Ship gate execution failed",
): ShipFailureMessage => {
  const trimmed = raw.trim()
  const bounded = (
    trimmed.length <= MAX_FAILURE_MESSAGE_CHARS
      ? trimmed
      : trimmed.slice(-MAX_FAILURE_MESSAGE_CHARS)
  ).trim()
  return ShipFailureMessage.make(bounded.length > 0 ? bounded : fallback)
}

const toGateDurationMs = (rawMs: number): GateDurationMs =>
  GateDurationMs.make(Number.isFinite(rawMs) ? Math.max(0, Math.round(rawMs)) : 0)

const extractRunCommandFailureDiagnostic = (
  failure: unknown,
  cmd: ResolvedShipGateCommand,
): string => {
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message.trim()
  }
  if (typeof failure === "object" && failure !== null) {
    const reasonProp: unknown = Reflect.get(failure, "reason")
    if (typeof reasonProp === "string" && reasonProp.trim().length > 0) {
      return reasonProp.trim()
    }
  }
  return toErrorReasonMessage(failure, `Command '${cmd.cmd} ${cmd.args.join(" ")}' failed`)
}

const evaluateGateExecOutcome = (
  stage: ShipStage,
  cmd: ResolvedShipGateCommand,
  execRes: SyncHostExecResult,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: GateExitCode; readonly diagnostic: string } =>
  match(execRes)
    .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
      if (exitCode !== 0) {
        return {
          ok: false as const,
          exitCode: toGateExitCode(exitCode),
          diagnostic:
            stderr.trim() ||
            stdout.trim() ||
            `Command '${cmd.cmd} ${cmd.args.join(" ")}' exited with code ${exitCode}`,
        }
      }
      return match(stage)
        .with("done", () => {
          const blockReason = extractDoneStdoutBlockReason(stdout)
          if (blockReason !== undefined) {
            return { ok: false as const, exitCode: GateExitCode.make(1), diagnostic: blockReason }
          }
          return { ok: true as const }
        })
        .with(
          "format-check",
          "gc-strict",
          "ontology-check-strict",
          "mutate-strict",
          "verify",
          () => ({
            ok: true as const,
          }),
        )
        .exhaustive()
    })
    .with({ _tag: "TimedOut" }, ({ stdout, stderr }) => ({
      ok: false as const,
      exitCode: GateExitCode.make(1),
      diagnostic:
        stderr.trim() || stdout.trim() || `Command '${cmd.cmd} ${cmd.args.join(" ")}' timed out`,
    }))
    .with({ _tag: "Signaled" }, ({ signal, stdout, stderr }) => ({
      ok: false as const,
      exitCode: resolveSignaledExitCode(signal),
      diagnostic:
        stderr.trim() ||
        stdout.trim() ||
        `Command '${cmd.cmd} ${cmd.args.join(" ")}' terminated by signal ${signal}`,
    }))
    .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) => ({
      ok: false as const,
      exitCode: GateExitCode.make(1),
      diagnostic:
        spawnError.trim() ||
        stderr.trim() ||
        `Command '${cmd.cmd} ${cmd.args.join(" ")}' failed to spawn`,
    }))
    .exhaustive()

/** Computes the canonical `WorkspaceTreeHash` for a `ShipWorkflow` stage pre/post check. */
export const computeTreeHashImpl = Effect.fn("ShipGateRunner.computeTreeHash")(function* (
  input: ShipTreeHashInput,
  options?: ShipGateRunnerOptions,
): Effect.fn.Return<WorkspaceTreeHash, ShipGateFailedError> {
  const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const baseEnv = options?.env ?? hostIo.getEnv()
  const envHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))

  return yield* match(computeWorkspaceTreeHashChecked(effectiveRoot, envHostIo))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        new ShipGateFailedError({
          stage: input.stage,
          exitCode: GateExitCode.make(1),
          stderrSummary: toGateStderrSummary(failure),
          circuitBreakerStatus: "clear",
        }),
      ),
    )
    .exhaustive()
})

/** Restores any dangling mutation backup before `mutate --strict`, failing closed with `MutationRestoreError`. */
export const recoverMutationBackupImpl = Effect.fn("ShipGateRunner.recoverMutationBackup")(
  function* (
    input: ShipRecoverBackupInput,
    options?: ShipGateRunnerOptions,
  ): Effect.fn.Return<void, MutationRestoreError> {
    const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
    const hostIo = options?.hostIo ?? nodeSyncHostIo
    const baseEnv = options?.env ?? hostIo.getEnv()
    const envHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))
    const backupPath = join(effectiveRoot, ".harness", "mutation-backup.json")

    const diagnostic = recoverStartupBackup(effectiveRoot, backupPath, envHostIo)
    if (diagnostic !== undefined) {
      return yield* match(computeWorkspaceTreeHashChecked(effectiveRoot, envHostIo))
        .with(
          { _tag: "Success" },
          ({ success }) =>
            new MutationRestoreError({
              expected: input.expectedTreeHash,
              actual: success,
              detail: toShipFailureMessageText(diagnostic, "Mutation backup restore failed"),
            }),
        )
        .with(
          { _tag: "Failure" },
          ({ failure }) =>
            new MutationRestoreError({
              expected: input.expectedTreeHash,
              detail: toShipFailureMessageText(
                `Post-recovery tree hash failed (${failure}); ${diagnostic}`,
                "Mutation backup restore failed",
              ),
            }),
        )
        .exhaustive()
    }
  },
)

/** Streams a `ShipStreamProgressEvent` to the configured `onProgress` listener. */
export const reportStageProgressImpl = Effect.fn("ShipGateRunner.reportStageProgress")(function* (
  event: ShipStreamProgressEvent,
  options?: ShipGateRunnerOptions,
): Effect.fn.Return<void> {
  return yield* Effect.sync(() => {
    options?.onProgress?.(event)
  })
})

/** Executes one canonical `ShipStage` CLI command, supporting cooperative cancellation and recording friction telemetry on failure. */
export const executeStageCommandImpl = Effect.fn("ShipGateRunner.executeStageCommand")(function* (
  input: ShipStageCommandInput,
  options?: ShipGateRunnerOptions,
): Effect.fn.Return<ShipStagePassed, ShipGateFailedError> {
  const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const baseEnv = options?.env ?? hostIo.getEnv()
  const cleanEnv = withoutWorktreeEnv(baseEnv)
  const envHostIo = makeEnvHostIo(hostIo, cleanEnv)
  const nowMs = options?.nowMs ?? (() => Date.now())
  const startedMs = nowMs()
  const controller = options?.activeGateController
  const gateKey = `${input.runId}:${input.attempt}`
  const beforeFriction = readFrictionEvents(effectiveRoot, envHostIo)

  const failStage = (
    exitCode: GateExitCode,
    diagnostic: string,
    durationMs: GateDurationMs,
  ): Effect.Effect<never, ShipGateFailedError> =>
    Effect.gen(function* () {
      const stderrSummary = toGateStderrSummary(diagnostic)
      const afterFriction = readFrictionEvents(effectiveRoot, envHostIo)
      const isVerifyStage = match(input.stage)
        .with("verify", () => true)
        .with(
          "format-check",
          "gc-strict",
          "ontology-check-strict",
          "mutate-strict",
          "done",
          () => false,
        )
        .exhaustive()
      const alreadyRecordedVerify =
        isVerifyStage &&
        afterFriction.length > beforeFriction.length &&
        afterFriction[afterFriction.length - 1]?.kind === "verify_failure"
      const latestEvents = alreadyRecordedVerify
        ? afterFriction
        : (() => {
            appendFrictionEvent(
              effectiveRoot,
              {
                kind: "verify_failure",
                summary: `ship:${input.stage}`,
                detail: stderrSummary,
                timestamp: new Date(nowMs()).toISOString(),
              },
              envHostIo,
            )
            return readFrictionEvents(effectiveRoot, envHostIo)
          })()

      const thrashing = yield* decideLoopThrashing(latestEvents)
      const circuitBreakerStatus: CircuitBreakerStatus = thrashing.stuck ? "tripped" : "clear"
      const escalationMessage =
        thrashing.escalationMessage !== null
          ? toShipFailureMessageText(thrashing.escalationMessage)
          : undefined

      return yield* new ShipGateFailedError({
        stage: input.stage,
        exitCode,
        stderrSummary,
        circuitBreakerStatus,
        durationMs,
        ...(escalationMessage !== undefined ? { escalationMessage } : {}),
      })
    })

  const runCommand =
    options?.runCommand ??
    ((
      cmd: string,
      args: ReadonlyArray<string>,
      opts: {
        readonly cwd: string
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
      },
    ) => spawnVerifyCommand(cmd, args, opts))

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const gateDone = yield* Deferred.make<void>()
      const cancelSignal = yield* Deferred.make<void>()
      let cancelledByController = false

      const triggerCancel = (): void => {
        cancelledByController = true
        Deferred.doneUnsafe(cancelSignal, Effect.void)
      }

      if (controller !== undefined && !controller.register(gateKey, triggerCancel, gateDone)) {
        return yield* failStage(
          GateExitCode.make(1),
          `Ship gate '${input.stage}' cancelled before starting`,
          toGateDurationMs(nowMs() - startedMs),
        )
      }

      return yield* Effect.gen(function* () {
        const formatFiles = yield* match(
          match(input.stage)
            .with("format-check", () =>
              resolveShipFormatCheckFiles(effectiveRoot, envHostIo, cleanEnv),
            )
            .with("gc-strict", "ontology-check-strict", "mutate-strict", "verify", "done", () =>
              Result.succeed<ReadonlyArray<string>>([]),
            )
            .exhaustive(),
        )
          .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
          .with({ _tag: "Failure" }, ({ failure }) =>
            failStage(
              failure.exitCode,
              failure.stderrSummary,
              toGateDurationMs(nowMs() - startedMs),
            ),
          )
          .exhaustive()

        if (cancelledByController) {
          return yield* failStage(
            GateExitCode.make(1),
            `Ship gate '${input.stage}' cancelled`,
            toGateDurationMs(nowMs() - startedMs),
          )
        }

        const resolvedCmd = resolveShipGateCommand(input.stage, formatFiles)
        if (resolvedCmd === undefined) {
          return ShipStagePassed.make({
            stage: input.stage,
            durationMs: toGateDurationMs(nowMs() - startedMs),
          })
        }

        const cmdFiber = yield* restore(
          runCommand(resolvedCmd.cmd, resolvedCmd.args, {
            cwd: effectiveRoot,
            env: withoutWorktreeEnvPlusCi(baseEnv),
            timeoutMs: options?.gateTimeoutMs ?? WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs,
          }),
        ).pipe(Effect.forkChild)

        const cancelWatcher = yield* Deferred.await(cancelSignal).pipe(
          Effect.andThen(Fiber.interrupt(cmdFiber)),
          Effect.forkChild,
        )

        const cmdExit = yield* restore(Fiber.await(cmdFiber)).pipe(
          Effect.onInterrupt(() =>
            Effect.all([Fiber.interrupt(cancelWatcher), Fiber.interrupt(cmdFiber)], {
              concurrency: "unbounded",
            }).pipe(Effect.ignore),
          ),
          Effect.ensuring(Fiber.interrupt(cancelWatcher).pipe(Effect.ignore)),
        )

        const durationMs = toGateDurationMs(nowMs() - startedMs)
        const outcome = yield* match(cmdExit)
          .with({ _tag: "Success" }, ({ value: execRes }) =>
            cancelledByController
              ? Effect.succeed({
                  ok: false as const,
                  exitCode: GateExitCode.make(1),
                  diagnostic: `Ship gate '${input.stage}' cancelled`,
                })
              : Effect.succeed(evaluateGateExecOutcome(input.stage, resolvedCmd, execRes)),
          )
          .with({ _tag: "Failure" }, ({ cause }) => {
            if (cancelledByController) {
              return Effect.succeed({
                ok: false as const,
                exitCode: GateExitCode.make(1),
                diagnostic: `Ship gate '${input.stage}' cancelled`,
              })
            }
            if (isPureInterruptCause(cause)) {
              return Effect.interrupt
            }
            const diagnostic = match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) =>
                extractRunCommandFailureDiagnostic(value, resolvedCmd),
              )
              .with({ _tag: "None" }, () => Cause.pretty(cause))
              .exhaustive()
            return Effect.succeed({
              ok: false as const,
              exitCode: GateExitCode.make(1),
              diagnostic,
            })
          })
          .exhaustive()

        return yield* match(outcome)
          .with({ ok: true }, () =>
            Effect.succeed(ShipStagePassed.make({ stage: input.stage, durationMs })),
          )
          .with({ ok: false }, ({ exitCode, diagnostic }) =>
            failStage(exitCode, diagnostic, durationMs),
          )
          .exhaustive()
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            controller?.unregister(gateKey, gateDone)
            Deferred.doneUnsafe(gateDone, Effect.void)
          }),
        ),
      )
    }),
  )
})

/** Constructs a live `ShipGateRunner` layer for `ShipWorkflow`. */
const makeShipGateRunnerLayer = (options?: ShipGateRunnerOptions): Layer.Layer<ShipGateRunner> =>
  Layer.succeed(ShipGateRunner, {
    computeTreeHash: (input) => computeTreeHashImpl(input, options),
    recoverMutationBackup: (input) => recoverMutationBackupImpl(input, options),
    executeStageCommand: (input) => executeStageCommandImpl(input, options),
    reportStageProgress: (event) => reportStageProgressImpl(event, options),
  } satisfies ShipGateRunnerShape)

export {
  createShipActiveGateController,
  extractDoneStdoutBlockReason,
  makeShipGateRunnerLayer,
  resolveShipFormatCheckFiles,
  resolveShipGateCommand,
}

/** Default live `ShipGateRunner` layer using Node host I/O. */
export const ShipGateRunnerLive: Layer.Layer<ShipGateRunner> = makeShipGateRunnerLayer()
