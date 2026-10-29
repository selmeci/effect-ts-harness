import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Effect } from "effect"

export const resolveCanonicalRepoRoot = (repoRoot: string): string => {
  const absRoot = resolve(repoRoot)
  return Effect.runSync(
    Effect.try({
      try: () => {
        const dotGit = join(absRoot, ".git")
        if (existsSync(dotGit) && statSync(dotGit).isFile()) {
          const content = readFileSync(dotGit, "utf8").trim()
          if (content.startsWith("gitdir:")) {
            const rawGitDir = content.slice("gitdir:".length).trim()
            const gitDir = resolve(absRoot, rawGitDir)
            const commonDirFile = join(gitDir, "commondir")
            if (existsSync(commonDirFile)) {
              const commondir = readFileSync(commonDirFile, "utf8").trim()
              const commonGitDir = resolve(gitDir, commondir)
              if (basename(commonGitDir) === ".git") {
                return dirname(commonGitDir)
              }
            }
            const match = gitDir.match(/^(.*?)[/\\]\.git[/\\]worktrees([/\\]|$)/)
            if (match && match[1]) {
              return match[1]
            }
          }
        }
        return absRoot
      },
      catch: () => absRoot
    }).pipe(Effect.orElseSucceed(() => absRoot))
  )
}

export const resolveOmnigraphClusterDir = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  if (customDir && customDir.length > 0) {
    return join(resolve(repoRoot, customDir), "omnigraph-cluster")
  }
  const canonicalRoot = resolveCanonicalRepoRoot(repoRoot)
  return join(canonicalRoot, ".harness", "omnigraph-cluster")
}

export const deriveRepoOmnigraphPort = (repoRoot: string): number => {
  const canonicalRoot = resolveCanonicalRepoRoot(repoRoot)
  const hash = createHash("sha256").update(canonicalRoot).digest()
  return 18080 + (hash.readUInt16BE(0) % 10000)
}

export const resolveOmnigraphTaskBranches = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): {
  readonly planBranch: string
  readonly implBranch: string
  readonly mainBranch: "main"
} => {
  const worktreeId = env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId && worktreeId.length > 0) {
    const slug = worktreeId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main"
    }
  }
  const absRoot = resolve(repoRoot)
  const canonicalRoot = resolveCanonicalRepoRoot(absRoot)
  if (absRoot !== canonicalRoot) {
    const slug = basename(absRoot).replace(/[^a-zA-Z0-9._-]/g, "_")
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main"
    }
  }
  return {
    planBranch: "plan/current",
    implBranch: "impl/current",
    mainBranch: "main"
  }
}
