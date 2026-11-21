import { Effect, Option, Result } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type AttemptNumber,
  type CompiledPlan,
  SHARED_STEP_UNIT_ID,
  type UnitOutcome,
  type WorkUnitId,
  type WorkflowStoreFailureReason,
  toBoundedReason,
} from "@harness/contract"
import { readFrictionEvents, resolveHarnessStateDir } from "@harness/gates"
import { resolveWorkflowWorktreeDir } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"

export const canonicalizePathOrRaw = (hostIo: SyncHostIo, rawPath: string): string =>
  match(Result.try(() => hostIo.realpathSync(rawPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => rawPath)
    .exhaustive()

export const hostIoWithEnv = (
  baseIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): SyncHostIo => ({ ...baseIo, getEnv: () => env })

export const assertFrictionLogCleared = (
  runtime: WorkflowDaemonRuntime,
): Effect.Effect<void, WorkflowStoreFailureReason> =>
  Effect.gen(function* () {
    const activeEnv = runtime.env ?? runtime.hostIo.getEnv()
    const candidateEnvs: Array<Readonly<Record<string, string | undefined>>> = [{}]
    if (
      (activeEnv["HARNESS_STATE_DIR"]?.trim().length ?? 0) > 0 ||
      (activeEnv["HARNESS_WORKTREE_ID"]?.trim().length ?? 0) > 0
    ) {
      candidateEnvs.push(activeEnv)
    }
    const checkedDirs = new Set<string>()
    for (const candidateEnv of candidateEnvs) {
      const stateDir = yield* Effect.try({
        try: () => resolveHarnessStateDir(runtime.canonicalRepoRoot, candidateEnv),
        catch: (err) => toBoundedReason(err, "Failed to resolve harness state directory"),
      })
      if (checkedDirs.has(stateDir)) {
        continue
      }
      checkedDirs.add(stateDir)
      const frictionPath = `${stateDir}/friction-log.jsonl`
      if (!runtime.hostIo.existsSync(frictionPath)) {
        continue
      }
      if (!runtime.hostIo.isFileSync(frictionPath)) {
        return yield* Effect.fail(
          toBoundedReason(`Friction log path '${frictionPath}' is not a regular file`),
        )
      }
      const events = readFrictionEvents(
        runtime.canonicalRepoRoot,
        hostIoWithEnv(runtime.hostIo, candidateEnv),
      )
      const rawText = yield* Effect.try({
        try: () => runtime.hostIo.readTextSync(frictionPath),
        catch: (err) => toBoundedReason(err, `Failed to read friction log '${frictionPath}'`),
      })
      const nonEmptyLines = rawText.split(/\r?\n/).filter((line) => line.trim().length > 0)
      if (events.length > 0 || nonEmptyLines.length > 0) {
        const count = events.length > 0 ? events.length : nonEmptyLines.length
        return yield* Effect.fail(
          toBoundedReason(
            `Cannot complete LLM phase: friction log contains ${count} pending/unparsed line(s) at '${frictionPath}'; clear friction-log.jsonl first`,
          ),
        )
      }
    }
  })

export const hasCompletedOutcome = (
  attemptOutcomes: ReadonlyArray<{
    readonly attempt: AttemptNumber
    readonly outcome: Option.Option<UnitOutcome>
  }>,
): boolean =>
  attemptOutcomes.some((item) =>
    match(item.outcome)
      .with({ _tag: "None" }, () => false)
      .with({ _tag: "Some" }, ({ value }) =>
        match(value)
          .with({ _tag: "Completed" }, () => true)
          .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => false)
          .exhaustive(),
      )
      .exhaustive(),
  )

/** Validates that `CompleteUnit` executes from the canonical checkout (slice / shared-step) or the unit's provisioned epic worktree. */
export const validateUnitCompletionCwd = (
  runtime: WorkflowDaemonRuntime,
  validatedCwd: AbsoluteRepoRoot,
  plan: CompiledPlan,
  unitId: WorkUnitId,
): Effect.Effect<void, WorkflowStoreFailureReason> => {
  const requiresCanonical =
    unitId === SHARED_STEP_UNIT_ID ||
    match(plan.level)
      .with("slice", () => true)
      .with("epic", () => false)
      .exhaustive()
  if (requiresCanonical) {
    const canonicalRoot = canonicalizePathOrRaw(runtime.hostIo, runtime.canonicalRepoRoot)
    return validatedCwd === canonicalRoot
      ? Effect.void
      : Effect.fail(
          toBoundedReason(
            `CompleteUnit for '${unitId}' requires canonical repoRoot '${canonicalRoot}', got '${validatedCwd}'`,
          ),
        )
  }
  const canonicalRepoRoot = AbsoluteRepoRoot.make(
    canonicalizePathOrRaw(runtime.hostIo, runtime.canonicalRepoRoot),
  )
  const expectedWorktree = resolveWorkflowWorktreeDir(canonicalRepoRoot, plan.runId, unitId)
  const resolvedExpected = Result.try(() => runtime.hostIo.realpathSync(expectedWorktree))
  return match(resolvedExpected)
    .with({ _tag: "Failure" }, () =>
      Effect.fail(
        toBoundedReason(
          `Provisioned epic worktree '${expectedWorktree}' for unit '${unitId}' does not exist`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success: canonicalExpected }) =>
      validatedCwd === canonicalExpected
        ? Effect.void
        : Effect.fail(
            toBoundedReason(
              `CompleteUnit for epic unit '${unitId}' requires provisioned worktree '${canonicalExpected}', got '${validatedCwd}'`,
            ),
          ),
    )
    .exhaustive()
}
