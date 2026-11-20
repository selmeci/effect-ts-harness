import { execFile } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  DaemonSocketPath,
  GitCommonDirPath,
  LeaseFilePath,
  toBoundedReason,
  ValidatedWorktreeRoot,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorktreePathKind,
} from "@harness/contract"
import { resolveGitCommonDir } from "@harness/graph/cluster-resolver"
import { nodeSyncHostIo } from "./node-host-io.js"

const GIT_WORKTREE_LIST_TIMEOUT_MS = 5000
const WORKTREE_VALIDATE_OPERATION = WorkflowStoreOperation.make("WorktreeRepoRoot.validate")

const makeWorktreeUnavailableError = (reason: unknown): WorkflowStoreUnavailableError =>
  new WorkflowStoreUnavailableError({
    operation: WORKTREE_VALIDATE_OPERATION,
    reason: toBoundedReason(reason, "Unknown worktree validation failure"),
  })

const execFileAsync = promisify(execFile)

const execGitWorktreeList = (cwd: string): Effect.Effect<string, WorkflowStoreUnavailableError> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd,
        encoding: "utf8",
        timeout: GIT_WORKTREE_LIST_TIMEOUT_MS,
        windowsHide: true,
      }),
    catch: (err) =>
      makeWorktreeUnavailableError(
        err instanceof Error
          ? `git worktree list failed at '${cwd}': ${err.message}`
          : `git worktree list failed at '${cwd}'`,
      ),
  }).pipe(Effect.map((result) => result.stdout))

interface ActiveWorktreeEntry {
  readonly stanzaIndex: number
  readonly resolvedPath: string
}

const parseActiveWorktrees = (porcelainOutput: string): ReadonlyArray<ActiveWorktreeEntry> => {
  const lines = porcelainOutput.split(/\r?\n/)
  const active: Array<ActiveWorktreeEntry> = []
  let stanzaIndex = 0
  let currentPath: string | undefined
  let isPrunable = false
  let isBare = false

  const flushStanza = (): void => {
    const pathToResolve = currentPath
    if (pathToResolve !== undefined) {
      if (!isPrunable && !isBare) {
        const resolved = Result.try(() => realpathSync.native(pathToResolve))
        match(resolved)
          .with({ _tag: "Success" }, ({ success: resolvedPath }) => {
            active.push({ stanzaIndex, resolvedPath })
          })
          .with({ _tag: "Failure" }, () => undefined)
          .exhaustive()
      }
      stanzaIndex += 1
    }
    currentPath = undefined
    isPrunable = false
    isBare = false
  }

  for (const line of lines) {
    if (line.length === 0) {
      flushStanza()
      continue
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length)
      continue
    }
    if (line === "prunable" || line.startsWith("prunable ")) {
      isPrunable = true
      continue
    }
    if (line === "bare") {
      isBare = true
    }
  }
  flushStanza()
  return active
}

export type ResolvedWorktreeKind = WorktreePathKind

export interface WorkflowRuntimePaths {
  readonly socketPath: DaemonSocketPath
  readonly lockFilePath: LeaseFilePath
  readonly backupDirPath: BackupDirPath
}

/**
 * Derives canonical workflow daemon runtime paths inside `<git-common-dir>/harness/`
 * so all linked worktrees share one socket (`daemon.sock`), writer lock (`daemon.lock`),
 * and pre-rebuild backup directory (`workflow-backups`).
 */
const resolveWorkflowRuntimePaths = (commonGitDir: GitCommonDirPath): WorkflowRuntimePaths => ({
  socketPath: DaemonSocketPath.make(join(commonGitDir, "harness", "daemon.sock")),
  lockFilePath: LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock")),
  backupDirPath: BackupDirPath.make(join(commonGitDir, "harness", "workflow-backups")),
})

export { resolveWorkflowRuntimePaths }

const decodeAbsoluteRepoRoot = Schema.decodeUnknownEffect(AbsoluteRepoRoot)
const decodeGitCommonDirPath = Schema.decodeUnknownEffect(GitCommonDirPath)
const decodeValidatedWorktreeRoot = Schema.decodeUnknownEffect(ValidatedWorktreeRoot)

/**
 * Validates an explicit `repoRoot` against `git worktree list` and resolves its
 * canonical shared git common directory and worktree kind (`canonical` | `linked`).
 */
export const validateWorktreeRepoRoot = Effect.fn("WorktreeRepoRoot.validate")(function* (
  repoRoot: AbsoluteRepoRoot,
): Effect.fn.Return<ValidatedWorktreeRoot, WorkflowStoreUnavailableError> {
  const realRoot = yield* Effect.try({
    try: () => {
      const resolved = realpathSync.native(repoRoot)
      const st = statSync(resolved)
      if (!st.isDirectory()) {
        // oxlint-disable-next-line -- caught immediately by Effect.try catch mapper
        throw new Error(`Worktree path '${resolved}' is not a directory`)
      }
      return resolved
    },
    catch: (err) =>
      makeWorktreeUnavailableError(
        err instanceof Error
          ? `Failed to resolve repoRoot '${repoRoot}': ${err.message}`
          : `Failed to resolve repoRoot '${repoRoot}'`,
      ),
  })

  const porcelainOutput = yield* execGitWorktreeList(realRoot)

  const activeWorktrees = parseActiveWorktrees(porcelainOutput)
  const matched = activeWorktrees.find((entry) => entry.resolvedPath === realRoot)
  if (matched === undefined) {
    return yield* makeWorktreeUnavailableError(
      `Path '${realRoot}' is not an active registered git worktree`,
    )
  }

  const rawCommonGitDir = resolveGitCommonDir(realRoot, nodeSyncHostIo)
  if (rawCommonGitDir === null) {
    return yield* makeWorktreeUnavailableError(
      `Unable to resolve shared git common directory for '${realRoot}'`,
    )
  }

  const realCommonGitDir = yield* Effect.try({
    try: () => realpathSync.native(rawCommonGitDir),
    catch: (err) =>
      makeWorktreeUnavailableError(
        err instanceof Error
          ? `Failed to resolve git common directory '${rawCommonGitDir}': ${err.message}`
          : `Failed to resolve git common directory '${rawCommonGitDir}'`,
      ),
  })

  const worktreeRoot = yield* decodeAbsoluteRepoRoot(realRoot).pipe(
    Effect.mapError((err) =>
      makeWorktreeUnavailableError(`Invalid canonical worktreeRoot '${realRoot}': ${err.message}`),
    ),
  )
  const commonGitDir = yield* decodeGitCommonDirPath(realCommonGitDir).pipe(
    Effect.mapError((err) =>
      makeWorktreeUnavailableError(
        `Invalid canonical commonGitDir '${realCommonGitDir}': ${err.message}`,
      ),
    ),
  )

  const kind: WorktreePathKind =
    realCommonGitDir === join(realRoot, ".git") ? "canonical" : "linked"

  return yield* decodeValidatedWorktreeRoot({
    worktreeRoot,
    commonGitDir,
    kind,
  }).pipe(
    Effect.mapError((err) =>
      makeWorktreeUnavailableError(
        `Invalid ValidatedWorktreeRoot for '${realRoot}': ${err.message}`,
      ),
    ),
  )
})
