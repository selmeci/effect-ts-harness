import { join, resolve } from "node:path"
import { Schema } from "effect"
import {
  normalizeNonRootWorkspacePath,
  sanitizeWorktreeIdSegment,
  WorkspaceFilePath,
} from "@harness/contract"

export const resolveHarnessStateDir = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const validRoot = normalizeNonRootWorkspacePath(
    resolve(normalizeNonRootWorkspacePath(workspaceRoot)),
  )
  const rawCustomDir = env.HARNESS_STATE_DIR
  if (rawCustomDir !== undefined && rawCustomDir.length > 0) {
    const decodedCustom = Schema.decodeSync(WorkspaceFilePath)(rawCustomDir)
    return normalizeNonRootWorkspacePath(resolve(validRoot, decodedCustom))
  }
  const rawWorktreeId = env.HARNESS_WORKTREE_ID
  if (rawWorktreeId !== undefined && rawWorktreeId.length > 0) {
    return join(validRoot, ".harness", "worktrees", sanitizeWorktreeIdSegment(rawWorktreeId))
  }
  return join(validRoot, ".harness")
}
