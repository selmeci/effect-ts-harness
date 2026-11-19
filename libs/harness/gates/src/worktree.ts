import { join, resolve } from "node:path"
import { Result, Schema } from "effect"
import {
  normalizeNonRootWorkspacePath,
  sanitizeWorktreeIdSegment,
  WorkspaceFilePath,
} from "@harness/contract"

export const resolveHarnessStateDir = (
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>> = {},
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
