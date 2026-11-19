import { join, resolve } from "node:path"
import { Result, Schema } from "effect"
import {
  HARNESS_AST_GATE_CACHE_FILENAME,
  HARNESS_DECISION_CACHE_FILENAME,
  normalizeNonRootWorkspacePath,
  resolveDefaultAstGateCachePath,
  resolveDefaultDecisionCachePath,
  sanitizeWorktreeIdSegment,
  toErrorReasonMessage,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"

const toReadError = (
  filePath: WorkspaceFilePath,
  err: unknown,
  defaultMessage: string = "Failed to read cache file",
): WorkspaceFsError => {
  if (err instanceof WorkspaceFsError) {
    return err
  }
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("read"),
    reason: toErrorReasonMessage(err, defaultMessage),
  })
}

const toWriteError = (
  filePath: WorkspaceFilePath,
  err: unknown,
  defaultMessage: string = "Failed to persist cache file",
): WorkspaceFsError => {
  if (err instanceof WorkspaceFsError) {
    return err
  }
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("write"),
    reason: toErrorReasonMessage(err, defaultMessage),
  })
}

const resolveHarnessStateDir = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const validRoot = normalizeNonRootWorkspacePath(
    resolve(normalizeNonRootWorkspacePath(workspaceRoot)),
  )
  const rawCustomDir = env.HARNESS_STATE_DIR
  if (rawCustomDir !== undefined && rawCustomDir.length > 0) {
    const decodedCustom = Schema.decodeSync(WorkspaceFilePath)(rawCustomDir)
    const resolved = normalizeNonRootWorkspacePath(resolve(validRoot, decodedCustom))
    if (resolved === validRoot) {
      return Result.getOrThrowWith(
        Result.fail(
          `HARNESS_STATE_DIR ('${rawCustomDir}') must not resolve to workspaceRoot ('${validRoot}').`,
        ),
        (msg) => new Error(msg),
      )
    }
    return resolved
  }
  const rawWorktreeId = env.HARNESS_WORKTREE_ID
  if (rawWorktreeId !== undefined && rawWorktreeId.length > 0) {
    return join(validRoot, ".harness", "worktrees", sanitizeWorktreeIdSegment(rawWorktreeId))
  }
  return join(validRoot, ".harness")
}

const resolveAstGateCachePath = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFilePath =>
  !env.HARNESS_STATE_DIR && !env.HARNESS_WORKTREE_ID
    ? resolveDefaultAstGateCachePath(resolve(normalizeNonRootWorkspacePath(workspaceRoot)))
    : WorkspaceFilePath.make(
        join(resolveHarnessStateDir(workspaceRoot, env), "cache", HARNESS_AST_GATE_CACHE_FILENAME),
      )

const resolveDecisionCachePath = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFilePath =>
  !env.HARNESS_STATE_DIR && !env.HARNESS_WORKTREE_ID
    ? resolveDefaultDecisionCachePath(resolve(normalizeNonRootWorkspacePath(workspaceRoot)))
    : WorkspaceFilePath.make(
        join(resolveHarnessStateDir(workspaceRoot, env), "cache", HARNESS_DECISION_CACHE_FILENAME),
      )

export {
  resolveAstGateCachePath,
  resolveDecisionCachePath,
  resolveHarnessStateDir,
  toReadError,
  toWriteError,
}
