import { dirname, isAbsolute, join, basename } from "node:path"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type CompiledPlan,
  type MergeSliceWaveInput,
  MergeSliceWaveOutcome,
  SliceBranchName,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  type WorktreeProvisionReceipt,
  type WorktreeUnitMapping,
  isPureInterruptCause,
  toErrorReasonMessage,
} from "@harness/contract"
import { WorkflowWorktreePort, type WorkflowWorktreePortShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { resolveWorkflowWorktreeDir, validateWorktreeRepoRoot } from "../worktree-repo-root.js"

/** Optional host I/O and repository root overrides for `WorkflowWorktreePortLive`. */
export interface WorkflowWorktreePortOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly repoRoot?: AbsoluteRepoRoot | undefined
}

const toWorktreeFsError = (
  filePath: string,
  operation: "read" | "write" | "stat",
  reason: unknown,
): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-worktree-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(reason, "Workflow worktree operation failed"),
  })
}

const sanitizeBranchSegment = (raw: string): string => {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unit"
}

const toFallbackSliceBranch = (runId: string, unitId: string): SliceBranchName =>
  SliceBranchName.make(`slice/${sanitizeBranchSegment(runId)}-${sanitizeBranchSegment(unitId)}`)

const runGitCommand = (
  hostIo: ExtendedHostIo,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<SyncHostExecResult, WorkspaceFsError> =>
  Effect.try({
    try: () => hostIo.execFileSync("git", args, { cwd }),
    catch: (cause) => toWorktreeFsError(cwd, "write", cause),
  })

const assertGitSuccess = (
  cwd: string,
  args: ReadonlyArray<string>,
  result: SyncHostExecResult,
): Effect.Effect<string, WorkspaceFsError> =>
  match(result)
    .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
      exitCode === 0
        ? Effect.succeed(stdout)
        : Effect.fail(
            toWorktreeFsError(
              cwd,
              "write",
              `git ${args.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
            ),
          ),
    )
    .with({ _tag: "TimedOut" }, ({ stderr }) =>
      Effect.fail(
        toWorktreeFsError(cwd, "write", `git ${args.join(" ")} timed out: ${stderr.trim()}`),
      ),
    )
    .with({ _tag: "Signaled" }, ({ signal }) =>
      Effect.fail(toWorktreeFsError(cwd, "write", `git ${args.join(" ")} signaled (${signal})`)),
    )
    .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
      Effect.fail(
        toWorktreeFsError(cwd, "write", `git ${args.join(" ")} spawn failed: ${spawnError}`),
      ),
    )
    .exhaustive()

const cleanupStaleWorktreeDir = (
  hostIo: ExtendedHostIo,
  canonicalRepoRoot: string,
  worktreeDir: string,
): Effect.Effect<void, WorkspaceFsError> =>
  Effect.gen(function* () {
    if (!hostIo.existsSync(worktreeDir)) {
      return
    }
    const removeArgs = ["worktree", "remove", "--force", "--", worktreeDir]
    const removeRes = yield* runGitCommand(hostIo, canonicalRepoRoot, removeArgs)
    yield* match(removeRes)
      .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
        if (exitCode === 0) {
          return Effect.void
        }
        const detail = stderr.trim() || stdout.trim()
        if (detail.includes("not a working tree")) {
          return Effect.void
        }
        return Effect.fail(
          toWorktreeFsError(
            worktreeDir,
            "write",
            `git ${removeArgs.join(" ")} exited with ${exitCode}: ${detail}`,
          ),
        )
      })
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.fail(
          toWorktreeFsError(
            worktreeDir,
            "write",
            `git ${removeArgs.join(" ")} timed out: ${stderr.trim()}`,
          ),
        ),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.fail(
          toWorktreeFsError(
            worktreeDir,
            "write",
            `git ${removeArgs.join(" ")} signaled (${signal})`,
          ),
        ),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.fail(
          toWorktreeFsError(
            worktreeDir,
            "write",
            `git ${removeArgs.join(" ")} spawn failed: ${spawnError}`,
          ),
        ),
      )
      .exhaustive()

    if (hostIo.existsSync(worktreeDir)) {
      yield* Effect.try({
        try: () => {
          hostIo.rmRecursiveSync(worktreeDir)
        },
        catch: (cause) => toWorktreeFsError(worktreeDir, "write", cause),
      })
    }
  })

const resolveWorktreeAddArgs = (
  hostIo: ExtendedHostIo,
  canonicalRepoRoot: string,
  branch: SliceBranchName,
  worktreeDir: string,
  baseSha: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceFsError> =>
  Effect.gen(function* () {
    const showRefArgs = ["show-ref", "--verify", "--quiet", "--", `refs/heads/${branch}`]
    const showRefRes = yield* runGitCommand(hostIo, canonicalRepoRoot, showRefArgs)
    const branchExists = yield* match(showRefRes)
      .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
        if (exitCode === 0) {
          return Effect.succeed(true)
        }
        if (exitCode === 1) {
          return Effect.succeed(false)
        }
        return Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${showRefArgs.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
      })
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${showRefArgs.join(" ")} timed out: ${stderr.trim()}`,
          ),
        ),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${showRefArgs.join(" ")} signaled (${signal})`,
          ),
        ),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${showRefArgs.join(" ")} spawn failed: ${spawnError}`,
          ),
        ),
      )
      .exhaustive()

    if (!branchExists) {
      return ["worktree", "add", "-b", branch, "--", worktreeDir, baseSha] as const
    }

    const ancestorArgs = ["merge-base", "--is-ancestor", "--end-of-options", baseSha, branch]
    const ancestorRes = yield* runGitCommand(hostIo, canonicalRepoRoot, ancestorArgs)
    return yield* match(ancestorRes)
      .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
        if (exitCode === 0) {
          return Effect.succeed(["worktree", "add", "--", worktreeDir, branch] as const)
        }
        if (exitCode === 1) {
          return Effect.fail(
            toWorktreeFsError(
              canonicalRepoRoot,
              "write",
              `Existing slice branch '${branch}' has diverged from baseSha '${baseSha}'`,
            ),
          )
        }
        return Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
      })
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} timed out: ${stderr.trim()}`,
          ),
        ),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} signaled (${signal})`,
          ),
        ),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.fail(
          toWorktreeFsError(
            canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} spawn failed: ${spawnError}`,
          ),
        ),
      )
      .exhaustive()
  })

/** Provisions L1 linked slice worktrees or L2 canonical mappings for a `CompiledPlan`. */
export const provisionWorkflowWorktreesImpl = Effect.fn("Harness.provisionWorkflowWorktrees")(
  function* (
    plan: CompiledPlan,
    options?: WorkflowWorktreePortOptions,
  ): Effect.fn.Return<WorktreeProvisionReceipt, WorkspaceFsError> {
    const hostIo = options?.hostIo ?? nodeSyncHostIo
    const rawCandidate = options?.repoRoot ?? process.cwd()
    const candidateRoot = yield* Schema.decodeEffect(AbsoluteRepoRoot)(rawCandidate).pipe(
      Effect.mapError((err) => toWorktreeFsError(rawCandidate, "stat", err)),
    )

    const validated = yield* validateWorktreeRepoRoot(candidateRoot).pipe(
      Effect.mapError((err) => toWorktreeFsError(candidateRoot, "stat", err.reason)),
    )

    const canonicalRepoRoot = match(validated.kind)
      .with("canonical", () => validated.worktreeRoot)
      .with("linked", () =>
        basename(validated.commonGitDir) === ".git"
          ? AbsoluteRepoRoot.make(dirname(validated.commonGitDir))
          : validated.worktreeRoot,
      )
      .exhaustive()

    return yield* match(plan.level)
      .with("slice", () =>
        Effect.succeed<WorktreeProvisionReceipt>({
          runId: plan.runId,
          canonicalRepoRoot,
          entries: plan.units.map((unit) => ({
            unitId: unit.unitId,
            cwd: canonicalRepoRoot,
            worktreeKind: "canonical" as const,
          })),
        }),
      )
      .with("epic", () => {
        const entries: Array<WorktreeUnitMapping> = []
        let activeWorktreeDir: string | undefined = undefined

        const rollbackProvisioned = (): Effect.Effect<void, WorkspaceFsError> =>
          Effect.gen(function* () {
            const parentDirs = new Set<string>()
            if (activeWorktreeDir !== undefined) {
              parentDirs.add(dirname(activeWorktreeDir))
              yield* cleanupStaleWorktreeDir(hostIo, canonicalRepoRoot, activeWorktreeDir)
              activeWorktreeDir = undefined
            }
            for (const entry of [...entries].reverse()) {
              if (entry.worktreeKind !== "linked") {
                continue
              }
              parentDirs.add(dirname(entry.cwd))
              if (hostIo.existsSync(entry.cwd)) {
                const removeArgs = ["worktree", "remove", "--force", "--", entry.cwd]
                const removeRes = yield* runGitCommand(hostIo, canonicalRepoRoot, removeArgs)
                yield* assertGitSuccess(canonicalRepoRoot, removeArgs, removeRes)
              }
            }
            for (const parentDir of parentDirs) {
              yield* Effect.try({
                try: () => {
                  if (
                    hostIo.existsSync(parentDir) &&
                    hostIo.isDirectorySync(parentDir) &&
                    hostIo.readdirSync(parentDir).length === 0
                  ) {
                    hostIo.rmRecursiveSync(parentDir)
                  }
                },
                catch: (cause) => toWorktreeFsError(parentDir, "write", cause),
              })
            }
          })

        return Effect.gen(function* () {
          const pruneArgs = ["worktree", "prune"]
          yield* runGitCommand(hostIo, canonicalRepoRoot, pruneArgs).pipe(
            Effect.flatMap((res) => assertGitSuccess(canonicalRepoRoot, pruneArgs, res)),
          )

          for (const unit of plan.units) {
            yield* Effect.yieldNow
            const branch = match(unit)
              .with({ _tag: "SliceUnit" }, (s) => s.branch)
              .with({ _tag: "PackageUnit" }, (p) => toFallbackSliceBranch(plan.runId, p.unitId))
              .exhaustive()

            const worktreeDir = resolveWorkflowWorktreeDir(
              canonicalRepoRoot,
              plan.runId,
              unit.unitId,
            )
            yield* cleanupStaleWorktreeDir(hostIo, canonicalRepoRoot, worktreeDir)
            activeWorktreeDir = worktreeDir
            yield* Effect.try({
              try: () => {
                hostIo.mkdirRecursiveSync(dirname(worktreeDir))
              },
              catch: (cause) => toWorktreeFsError(worktreeDir, "write", cause),
            })

            const addArgs = yield* resolveWorktreeAddArgs(
              hostIo,
              canonicalRepoRoot,
              branch,
              worktreeDir,
              plan.baseSha,
            )
            yield* runGitCommand(hostIo, canonicalRepoRoot, addArgs).pipe(
              Effect.flatMap((res) => assertGitSuccess(canonicalRepoRoot, addArgs, res)),
            )

            const cwd = yield* Effect.try({
              try: () => hostIo.realpathSync(worktreeDir),
              catch: (cause) => toWorktreeFsError(worktreeDir, "stat", cause),
            }).pipe(
              Effect.flatMap((resolvedPath) =>
                Schema.decodeEffect(AbsoluteRepoRoot)(resolvedPath).pipe(
                  Effect.mapError((err) => toWorktreeFsError(resolvedPath, "stat", err)),
                ),
              ),
            )

            entries.push({
              unitId: unit.unitId,
              cwd,
              worktreeKind: "linked" as const,
              branch,
            })
            activeWorktreeDir = undefined
          }

          return {
            runId: plan.runId,
            canonicalRepoRoot,
            entries,
          } satisfies WorktreeProvisionReceipt
        }).pipe(
          Effect.onExit((exit) =>
            match(exit)
              .with({ _tag: "Success" }, () => Effect.void)
              .with({ _tag: "Failure" }, () => rollbackProvisioned())
              .exhaustive(),
          ),
        )
      })
      .exhaustive()
  },
)

/** Removes linked worktree checkouts during compensation while preserving `slice/*` branches. */
export const removeWorktreeCheckoutsImpl = Effect.fn("Harness.removeWorktreeCheckouts")(function* (
  receipt: WorktreeProvisionReceipt,
  options?: WorkflowWorktreePortOptions,
): Effect.fn.Return<void> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  return yield* Effect.gen(function* () {
    const parentDirs = new Set<string>()
    for (const entry of receipt.entries) {
      yield* match(entry.worktreeKind)
        .with("canonical", () => Effect.void)
        .with("linked", () =>
          Effect.gen(function* () {
            parentDirs.add(dirname(entry.cwd))
            const removeRes = yield* Effect.try({
              try: () =>
                hostIo.execFileSync("git", ["worktree", "remove", "--force", "--", entry.cwd], {
                  cwd: receipt.canonicalRepoRoot,
                }),
              catch: (cause) => toErrorReasonMessage(cause),
            }).pipe(Effect.result)

            match(removeRes)
              .with({ _tag: "Failure" }, ({ failure }) => {
                process.stderr.write(
                  `[harness/infra] Warning: failed to remove worktree '${entry.cwd}': ${toErrorReasonMessage(failure)}\n`,
                )
              })
              .with({ _tag: "Success" }, ({ success: execRes }) => {
                match(execRes)
                  .with({ _tag: "Exited" }, ({ exitCode, stderr }) => {
                    if (exitCode !== 0) {
                      process.stderr.write(
                        `[harness/infra] Warning: git worktree remove '${entry.cwd}' exited with ${exitCode}: ${stderr.trim()}\n`,
                      )
                    }
                  })
                  .with(
                    { _tag: "TimedOut" },
                    { _tag: "Signaled" },
                    { _tag: "SpawnFailed" },
                    (err) => {
                      process.stderr.write(
                        `[harness/infra] Warning: git worktree remove '${entry.cwd}' failed (${err._tag})\n`,
                      )
                    },
                  )
                  .exhaustive()
              })
              .exhaustive()
          }),
        )
        .exhaustive()
    }

    for (const parentDir of parentDirs) {
      const cleanRes = yield* Effect.try({
        try: () => {
          if (
            hostIo.existsSync(parentDir) &&
            hostIo.isDirectorySync(parentDir) &&
            hostIo.readdirSync(parentDir).length === 0
          ) {
            hostIo.rmRecursiveSync(parentDir)
          }
        },
        catch: (cause) => toErrorReasonMessage(cause),
      }).pipe(Effect.result)
      match(cleanRes)
        .with({ _tag: "Success" }, () => undefined)
        .with({ _tag: "Failure" }, ({ failure }) => {
          process.stderr.write(
            `[harness/infra] Warning: failed to clean empty worktree parent '${parentDir}': ${failure}\n`,
          )
        })
        .exhaustive()
    }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !isPureInterruptCause(cause),
      (cause) =>
        Effect.sync(() => {
          process.stderr.write(
            `[harness/infra] Warning: removeWorktreeCheckouts failed for run '${receipt.runId}': ${Cause.pretty(cause)}\n`,
          )
        }),
    ),
  )
})

const hasActiveMergeHead = (
  hostIo: ExtendedHostIo,
  cwd: string,
): Effect.Effect<boolean, WorkspaceFsError> =>
  Effect.gen(function* () {
    const args = ["rev-parse", "--git-path", "MERGE_HEAD"]
    const res = yield* runGitCommand(hostIo, cwd, args)
    const stdout = yield* assertGitSuccess(cwd, args, res)
    const relOrAbs = stdout.trim()
    if (relOrAbs.length === 0) {
      return false
    }
    const targetPath = isAbsolute(relOrAbs) ? relOrAbs : join(cwd, relOrAbs)
    return hostIo.existsSync(targetPath)
  })

const hasUnmergedPaths = (
  hostIo: ExtendedHostIo,
  cwd: string,
): Effect.Effect<boolean, WorkspaceFsError> =>
  Effect.gen(function* () {
    const args = ["diff", "--name-only", "--diff-filter=U"]
    const res = yield* runGitCommand(hostIo, cwd, args)
    const stdout = yield* assertGitSuccess(cwd, args, res)
    return stdout.trim().length > 0
  })

const abortMergeStrict = (
  hostIo: ExtendedHostIo,
  cwd: string,
): Effect.Effect<void, WorkspaceFsError> =>
  Effect.gen(function* () {
    const args = ["merge", "--abort"]
    const res = yield* runGitCommand(hostIo, cwd, args)
    yield* assertGitSuccess(cwd, args, res)
  })

const cleanupActiveMergeStrict = (
  hostIo: ExtendedHostIo,
  cwd: string,
): Effect.Effect<void, WorkspaceFsError> =>
  Effect.gen(function* () {
    if (yield* hasActiveMergeHead(hostIo, cwd)) {
      yield* abortMergeStrict(hostIo, cwd)
    }
    if (yield* hasUnmergedPaths(hostIo, cwd)) {
      return yield* toWorktreeFsError(
        cwd,
        "write",
        "Repository index contains unmerged paths without an active MERGE_HEAD",
      )
    }
  })

/** Performs an idempotent `git merge --no-ff` wave merge for L1 slice branches. */
export const mergeSliceWaveImpl = Effect.fn("Harness.mergeSliceWave")(function* (
  input: MergeSliceWaveInput,
  options?: WorkflowWorktreePortOptions,
): Effect.fn.Return<MergeSliceWaveOutcome, WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  yield* cleanupActiveMergeStrict(hostIo, input.canonicalRepoRoot)

  const mergedBranches: Array<SliceBranchName> = []

  for (const branch of input.branches) {
    const ancestorArgs = ["merge-base", "--is-ancestor", "--end-of-options", branch, "HEAD"]
    const ancestorRes = yield* runGitCommand(hostIo, input.canonicalRepoRoot, ancestorArgs)
    const isAlreadyMerged = yield* match(ancestorRes)
      .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
        if (exitCode === 0) {
          return Effect.succeed(true)
        }
        if (exitCode === 1) {
          return Effect.succeed(false)
        }
        return Effect.fail(
          toWorktreeFsError(
            input.canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
      })
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.fail(
          toWorktreeFsError(
            input.canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} timed out: ${stderr.trim()}`,
          ),
        ),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.fail(
          toWorktreeFsError(
            input.canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} signaled (${signal})`,
          ),
        ),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.fail(
          toWorktreeFsError(
            input.canonicalRepoRoot,
            "read",
            `git ${ancestorArgs.join(" ")} spawn failed: ${spawnError}`,
          ),
        ),
      )
      .exhaustive()

    if (isAlreadyMerged) {
      mergedBranches.push(branch)
      continue
    }

    const mergeArgs = ["merge", "--no-ff", "--no-edit", "--end-of-options", branch]
    const mergeRes = yield* runGitCommand(hostIo, input.canonicalRepoRoot, mergeArgs)
    const mergeOutcome = yield* match(mergeRes)
      .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
        if (exitCode === 0) {
          return Effect.succeed<"ok">("ok")
        }
        return Effect.gen(function* () {
          const mergeHeadActive = yield* hasActiveMergeHead(hostIo, input.canonicalRepoRoot)
          const unmergedActive = yield* hasUnmergedPaths(hostIo, input.canonicalRepoRoot)
          if (mergeHeadActive) {
            yield* abortMergeStrict(hostIo, input.canonicalRepoRoot)
            if (yield* hasUnmergedPaths(hostIo, input.canonicalRepoRoot)) {
              return yield* toWorktreeFsError(
                input.canonicalRepoRoot,
                "write",
                `git merge --abort left unmerged paths in '${input.canonicalRepoRoot}'`,
              )
            }
            return "conflict" as const
          }
          if (unmergedActive) {
            return yield* toWorktreeFsError(
              input.canonicalRepoRoot,
              "write",
              `git ${mergeArgs.join(" ")} left unmerged index entries without MERGE_HEAD`,
            )
          }
          return yield* toWorktreeFsError(
            input.canonicalRepoRoot,
            "write",
            `git ${mergeArgs.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          )
        })
      })
      .with({ _tag: "TimedOut" }, ({ stderr }) =>
        Effect.gen(function* () {
          yield* cleanupActiveMergeStrict(hostIo, input.canonicalRepoRoot)
          return yield* toWorktreeFsError(
            input.canonicalRepoRoot,
            "write",
            `git ${mergeArgs.join(" ")} timed out: ${stderr.trim()}`,
          )
        }),
      )
      .with({ _tag: "Signaled" }, ({ signal }) =>
        Effect.gen(function* () {
          yield* cleanupActiveMergeStrict(hostIo, input.canonicalRepoRoot)
          return yield* toWorktreeFsError(
            input.canonicalRepoRoot,
            "write",
            `git ${mergeArgs.join(" ")} signaled (${signal})`,
          )
        }),
      )
      .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
        Effect.gen(function* () {
          yield* cleanupActiveMergeStrict(hostIo, input.canonicalRepoRoot)
          return yield* toWorktreeFsError(
            input.canonicalRepoRoot,
            "write",
            `git ${mergeArgs.join(" ")} spawn failed: ${spawnError}`,
          )
        }),
      )
      .exhaustive()

    if (mergeOutcome === "conflict") {
      return MergeSliceWaveOutcome.cases.Conflict.make({ branch })
    }
    mergedBranches.push(branch)
  }

  return MergeSliceWaveOutcome.cases.Merged.make({ mergedBranches })
})

/** Constructs a `WorkflowWorktreePort` layer. */
const makeWorkflowWorktreePortLayer = (
  options?: WorkflowWorktreePortOptions,
): Layer.Layer<WorkflowWorktreePort> =>
  Layer.succeed(WorkflowWorktreePort, {
    provisionWorktrees: (plan) => provisionWorkflowWorktreesImpl(plan, options),
    removeWorktreeCheckouts: (receipt) => removeWorktreeCheckoutsImpl(receipt, options),
    mergeSliceWave: (input) => mergeSliceWaveImpl(input, options),
  } satisfies WorkflowWorktreePortShape)

/** Production `WorkflowWorktreePort` layer backed by `git worktree` and `git merge --no-ff`. */
export const WorkflowWorktreePortLive: Layer.Layer<WorkflowWorktreePort> =
  makeWorkflowWorktreePortLayer()

export { makeWorkflowWorktreePortLayer }
