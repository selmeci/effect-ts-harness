import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import type { SyncHostIo } from "@harness/service"
import { Effect, Option, Result, Schema } from "effect"

export interface GitHeadState {
  readonly gitBranch: string | null
  readonly headSha: string | null
}

const resolveGitDirs = (
  repoRoot: string,
  hostIo: SyncHostIo,
): { readonly gitDir: string; readonly commonGitDir: string } | null => {
  const absRoot = resolve(repoRoot)
  const dotGit = join(absRoot, ".git")
  if (!hostIo.existsSync(dotGit)) {
    return null
  }
  if (hostIo.isDirectorySync(dotGit)) {
    return { gitDir: dotGit, commonGitDir: dotGit }
  }
  if (hostIo.isFileSync(dotGit)) {
    const content = hostIo.readTextSync(dotGit).trim()
    if (content.startsWith("gitdir:")) {
      const rawGitDir = content.slice("gitdir:".length).trim()
      const gitDir = resolve(absRoot, rawGitDir)
      const commonDirFile = join(gitDir, "commondir")
      if (hostIo.existsSync(commonDirFile)) {
        const commondir = hostIo.readTextSync(commonDirFile).trim()
        const commonGitDir = resolve(gitDir, commondir)
        return { gitDir, commonGitDir }
      }
      return { gitDir, commonGitDir: gitDir }
    }
  }
  return null
}

const resolveRefSha = (
  gitDir: string,
  commonGitDir: string,
  refPath: string,
  hostIo: SyncHostIo,
): string | null => {
  const localRefFile = join(gitDir, refPath)
  if (hostIo.existsSync(localRefFile) && hostIo.isFileSync(localRefFile)) {
    const sha = hostIo.readTextSync(localRefFile).trim()
    if (sha.length > 0) return sha
  }
  const commonRefFile = join(commonGitDir, refPath)
  if (hostIo.existsSync(commonRefFile) && hostIo.isFileSync(commonRefFile)) {
    const sha = hostIo.readTextSync(commonRefFile).trim()
    if (sha.length > 0) return sha
  }
  const packedRefsFile = join(commonGitDir, "packed-refs")
  if (hostIo.existsSync(packedRefsFile) && hostIo.isFileSync(packedRefsFile)) {
    const lines = hostIo.readTextSync(packedRefsFile).split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("^")) {
        continue
      }
      const spaceIdx = trimmed.indexOf(" ")
      if (spaceIdx > 0) {
        const sha = trimmed.slice(0, spaceIdx).trim()
        const ref = trimmed.slice(spaceIdx + 1).trim()
        if (ref === refPath && sha.length > 0) {
          return sha
        }
      }
    }
  }
  return null
}

export const resolveGitHeadState = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: NodeJS.ProcessEnv = process.env,
): GitHeadState => {
  const envBranch = env.HARNESS_GIT_BRANCH?.trim()
  const envSha = env.HARNESS_GIT_HEAD_SHA?.trim()
  const fallback: GitHeadState = {
    gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
    headSha: envSha && envSha.length > 0 ? envSha : null,
  }
  return Result.getOrElse(
    Result.try((): GitHeadState => {
      const dirs = resolveGitDirs(repoRoot, hostIo)
      if (dirs === null) {
        return fallback
      }
      const headFile = join(dirs.gitDir, "HEAD")
      if (!hostIo.existsSync(headFile) || !hostIo.isFileSync(headFile)) {
        return fallback
      }
      const headContent = hostIo.readTextSync(headFile).trim()
      if (headContent.startsWith("ref:")) {
        const refPath = headContent.slice("ref:".length).trim()
        const detectedBranch = refPath.startsWith("refs/heads/")
          ? refPath.slice("refs/heads/".length)
          : null
        const detectedSha = resolveRefSha(dirs.gitDir, dirs.commonGitDir, refPath, hostIo)
        return {
          gitBranch: envBranch && envBranch.length > 0 ? envBranch : detectedBranch,
          headSha: envSha && envSha.length > 0 ? envSha : detectedSha,
        }
      }
      return {
        gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
        headSha:
          envSha && envSha.length > 0 ? envSha : headContent.length > 0 ? headContent : null,
      }
    }),
    () => fallback,
  )
}

export const GraphHeadMetaSchema = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type GraphHeadMeta = typeof GraphHeadMetaSchema.Type

const decodeGraphHeadMetaOption = Schema.decodeOption(Schema.fromJsonString(GraphHeadMetaSchema))

export const readGraphHeadMeta = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: NodeJS.ProcessEnv = process.env,
): GraphHeadMeta | null => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  const stateDir =
    customDir && customDir.length > 0
      ? resolve(repoRoot, customDir)
      : join(resolve(repoRoot), ".harness")
  const metaPath = join(stateDir, "graph-head.json")
  if (!hostIo.existsSync(metaPath)) {
    return null
  }
  const raw = Result.getOrElse(
    Result.try(() => hostIo.readTextSync(metaPath)),
    () => "",
  )
  return Option.getOrNull(decodeGraphHeadMetaOption(raw))
}

export const writeGraphHeadMeta = (
  repoRoot: string,
  hostIo: SyncHostIo,
  headState?: GitHeadState,
  env: NodeJS.ProcessEnv = process.env,
): GraphHeadMeta | null => {
  const resolved = headState ?? resolveGitHeadState(repoRoot, hostIo, env)
  if (resolved.headSha === null && resolved.gitBranch === null) {
    return null
  }
  const customDir = env.HARNESS_STATE_DIR?.trim()
  const stateDir =
    customDir && customDir.length > 0
      ? resolve(repoRoot, customDir)
      : join(resolve(repoRoot), ".harness")
  const meta: GraphHeadMeta = {
    headSha: resolved.headSha,
    gitBranch: resolved.gitBranch,
    updatedAt: new Date().toISOString(),
  }
  Result.try(() => {
    if (!hostIo.existsSync(stateDir)) {
      hostIo.mkdirRecursiveSync(stateDir)
    }
    hostIo.writeTextSync(join(stateDir, "graph-head.json"), JSON.stringify(meta, null, 2))
  })
  return meta
}

export const OmnigraphReconcileReason = Schema.Literals([
  "up-to-date",
  "missing-snapshot",
  "head-sha-changed",
  "git-branch-changed",
])
export type OmnigraphReconcileReason = typeof OmnigraphReconcileReason.Type

export const OmnigraphReconcileInput = Schema.Struct({
  snapshotExists: Schema.Boolean,
  recordedHeadSha: Schema.NullOr(Schema.String),
  currentHeadSha: Schema.NullOr(Schema.String),
  recordedGitBranch: Schema.NullOr(Schema.String),
  currentGitBranch: Schema.NullOr(Schema.String),
})
export type OmnigraphReconcileInput = typeof OmnigraphReconcileInput.Type

export interface OmnigraphReconcileDecision {
  readonly needsReconcile: boolean
  readonly reason: OmnigraphReconcileReason
  readonly targetOmnigraphBranch: string
}

export const sanitizeOmnigraphBranchSlug = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9._-]/g, "_")

export const decideOmnigraphReconcile = Effect.fn("OmnigraphReconcile.decide")(function* (
  input: OmnigraphReconcileInput,
) {
  const branchTrimmed = input.currentGitBranch?.trim() ?? ""
  const isFeatureBranch =
    branchTrimmed.length > 0 && branchTrimmed !== "main" && branchTrimmed !== "master"
  const targetOmnigraphBranch = isFeatureBranch
    ? `impl/branch-${sanitizeOmnigraphBranchSlug(branchTrimmed)}`
    : "main"

  if (!input.snapshotExists) {
    return yield* Effect.succeed({
      needsReconcile: true,
      reason: "missing-snapshot" as const,
      targetOmnigraphBranch,
    } satisfies OmnigraphReconcileDecision)
  }

  if (
    input.currentHeadSha !== null &&
    input.currentHeadSha.length > 0 &&
    input.recordedHeadSha !== input.currentHeadSha
  ) {
    return yield* Effect.succeed({
      needsReconcile: true,
      reason: "head-sha-changed" as const,
      targetOmnigraphBranch,
    } satisfies OmnigraphReconcileDecision)
  }

  if (
    input.currentGitBranch !== null &&
    input.recordedGitBranch !== null &&
    input.recordedGitBranch !== input.currentGitBranch
  ) {
    return yield* Effect.succeed({
      needsReconcile: true,
      reason: "git-branch-changed" as const,
      targetOmnigraphBranch,
    } satisfies OmnigraphReconcileDecision)
  }

  return yield* Effect.succeed({
    needsReconcile: false,
    reason: "up-to-date" as const,
    targetOmnigraphBranch,
  } satisfies OmnigraphReconcileDecision)
})

export const resolveCanonicalRepoRoot = (repoRoot: string, hostIo: SyncHostIo): string => {
  const absRoot = resolve(repoRoot)
  return Result.getOrElse(
    Result.try(() => {
      const dotGit = join(absRoot, ".git")
      if (hostIo.existsSync(dotGit) && hostIo.isFileSync(dotGit)) {
        const content = hostIo.readTextSync(dotGit).trim()
        if (content.startsWith("gitdir:")) {
          const rawGitDir = content.slice("gitdir:".length).trim()
          const gitDir = resolve(absRoot, rawGitDir)
          const commonDirFile = join(gitDir, "commondir")
          if (hostIo.existsSync(commonDirFile)) {
            const commondir = hostIo.readTextSync(commonDirFile).trim()
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
    }),
    () => absRoot,
  )
}

export const resolveOmnigraphClusterDir = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  if (customDir && customDir.length > 0) {
    return join(resolve(repoRoot, customDir), "omnigraph-cluster")
  }
  const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, hostIo)
  return join(canonicalRoot, ".harness", "omnigraph-cluster")
}

export const deriveRepoOmnigraphPort = (repoRoot: string, hostIo: SyncHostIo): number => {
  const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, hostIo)
  const hash = createHash("sha256").update(canonicalRoot).digest()
  return 18080 + (hash.readUInt16BE(0) % 10000)
}

export const resolveOmnigraphTaskBranches = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly planBranch: string
  readonly implBranch: string
  readonly mainBranch: "main"
} => {
  const worktreeId = env.HARNESS_WORKTREE_ID?.trim()
  if (worktreeId && worktreeId.length > 0) {
    const slug = sanitizeOmnigraphBranchSlug(worktreeId)
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main",
    }
  }
  const absRoot = resolve(repoRoot)
  const canonicalRoot = resolveCanonicalRepoRoot(absRoot, hostIo)
  if (absRoot !== canonicalRoot) {
    const slug = sanitizeOmnigraphBranchSlug(basename(absRoot))
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main",
    }
  }
  const headState = resolveGitHeadState(absRoot, hostIo, env)
  const gitBranch = headState.gitBranch?.trim()
  if (gitBranch && gitBranch.length > 0 && gitBranch !== "main" && gitBranch !== "master") {
    const slug = sanitizeOmnigraphBranchSlug(gitBranch)
    return {
      planBranch: `plan/branch-${slug}`,
      implBranch: `impl/branch-${slug}`,
      mainBranch: "main",
    }
  }
  return {
    planBranch: "plan/current",
    implBranch: "impl/current",
    mainBranch: "main",
  }
}
