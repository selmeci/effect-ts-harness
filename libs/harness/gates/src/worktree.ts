import { join, resolve } from "node:path"

export {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches
} from "@harness/graph"

export const resolveHarnessStateDir = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  if (customDir && customDir.length > 0) {
    return resolve(repoRoot, customDir)
  }
  const worktreeId = env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId && worktreeId.length > 0) {
    const sanitized = worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return join(repoRoot, ".harness", "worktrees", sanitized)
  }
  return join(repoRoot, ".harness")
}
