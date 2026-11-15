import { join, resolve } from "node:path"
import {
  ErrorReasonMessage,
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
  const message =
    err instanceof Error && err.message.trim().length > 0 ? err.message.trim() : defaultMessage
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("read"),
    reason: ErrorReasonMessage.make(message),
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
  const message =
    err instanceof Error && err.message.trim().length > 0 ? err.message.trim() : defaultMessage
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make("write"),
    reason: ErrorReasonMessage.make(message),
  })
}

const resolveHarnessStateDir = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  if (customDir && customDir.length > 0) {
    return resolve(workspaceRoot, customDir)
  }
  const worktreeId = env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId && worktreeId.length > 0) {
    const sanitized = worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return join(workspaceRoot, ".harness", "worktrees", sanitized)
  }
  return join(workspaceRoot, ".harness")
}

const resolveAstGateCachePath = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFilePath =>
  WorkspaceFilePath.make(
    join(resolveHarnessStateDir(workspaceRoot, env), "cache", "ast-gates-v1.json"),
  )

const resolveDecisionCachePath = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFilePath =>
  WorkspaceFilePath.make(
    join(resolveHarnessStateDir(workspaceRoot, env), "cache", "decision-cache-v1.json"),
  )

export {
  resolveAstGateCachePath,
  resolveDecisionCachePath,
  resolveHarnessStateDir,
  toReadError,
  toWriteError,
}
