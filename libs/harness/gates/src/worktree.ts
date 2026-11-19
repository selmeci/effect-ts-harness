import { join, resolve } from "node:path"
import { Result, Schema } from "effect"
import {
  normalizeNonRootWorkspacePath,
  sanitizeWorktreeIdSegment,
  WorkspaceFilePath,
} from "@harness/contract"

export const ROOT_ONLY_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".superpowers",
  "repos",
  ".idea",
  ".vscode",
  ".alchemy",
  ".remember",
  ".worktrees",
])

export const BUILD_ARTIFACT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".harness",
  ".nx",
  "node_modules",
  "dist",
  "coverage",
  ".DS_Store",
  ".vite",
])

/**
 * Pure path-segment filter shared by `computeWorkspaceTreeHashChecked` and
 * `isWorkspaceRelPathIncludedInStamp`: skips root-level ignored/temp entries and
 * `BUILD_ARTIFACT_IGNORED_NAMES` outside `src/` or `test/` subdirectories.
 */
export const shouldIgnoreStampEntry = (
  isRootLevel: boolean,
  relDir: string,
  name: string,
): boolean => {
  if (isRootLevel && (ROOT_ONLY_IGNORED_NAMES.has(name) || /^(?:temp-|__temp_)/.test(name))) {
    return true
  }
  const insideSrcOrTest = /(?:^|\/)(?:src|test)(?:\/|$)/.test(relDir)
  return !insideSrcOrTest && BUILD_ARTIFACT_IGNORED_NAMES.has(name)
}

/**
 * Returns true iff a repo-relative POSIX file path is included in `verify-stamp.json`'s `treeHash`.
 */
export const isWorkspaceRelPathIncludedInStamp = (relPath: string): boolean => {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (norm.length === 0) return false
  const parts = norm.split("/")
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i]!
    const relDir = i === 0 ? "" : parts.slice(0, i).join("/")
    if (shouldIgnoreStampEntry(i === 0, relDir, seg)) {
      return false
    }
  }
  return true
}

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
