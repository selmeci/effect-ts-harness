import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Effect, Option, Schema } from "effect"

export interface GitHeadState {
  readonly gitBranch: string | null
  readonly headSha: string | null
}

const resolveGitDirs = (
  repoRoot: string
): { readonly gitDir: string; readonly commonGitDir: string } | null => {
  const absRoot = resolve(repoRoot)
  const dotGit = join(absRoot, ".git")
  if (!existsSync(dotGit)) {
    return null
  }
  const st = statSync(dotGit)
  if (st.isDirectory()) {
    return { gitDir: dotGit, commonGitDir: dotGit }
  }
  if (st.isFile()) {
    const content = readFileSync(dotGit, "utf8").trim()
    if (content.startsWith("gitdir:")) {
      const rawGitDir = content.slice("gitdir:".length).trim()
      const gitDir = resolve(absRoot, rawGitDir)
      const commonDirFile = join(gitDir, "commondir")
      if (existsSync(commonDirFile)) {
        const commondir = readFileSync(commonDirFile, "utf8").trim()
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
  refPath: string
): string | null => {
  const localRefFile = join(gitDir, refPath)
  if (existsSync(localRefFile) && statSync(localRefFile).isFile()) {
    const sha = readFileSync(localRefFile, "utf8").trim()
    if (sha.length > 0) return sha
  }
  const commonRefFile = join(commonGitDir, refPath)
  if (existsSync(commonRefFile) && statSync(commonRefFile).isFile()) {
    const sha = readFileSync(commonRefFile, "utf8").trim()
    if (sha.length > 0) return sha
  }
  const packedRefsFile = join(commonGitDir, "packed-refs")
  if (existsSync(packedRefsFile) && statSync(packedRefsFile).isFile()) {
    const lines = readFileSync(packedRefsFile, "utf8").split(/\r?\n/)
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
  env: NodeJS.ProcessEnv = process.env
): GitHeadState => {
  const envBranch = env.HARNESS_GIT_BRANCH?.trim()
  const envSha = env.HARNESS_GIT_HEAD_SHA?.trim()
  return Effect.runSync(
    Effect.try({
      try: (): GitHeadState => {
        const dirs = resolveGitDirs(repoRoot)
        if (dirs === null) {
          return {
            gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
            headSha: envSha && envSha.length > 0 ? envSha : null
          }
        }
        const headFile = join(dirs.gitDir, "HEAD")
        if (!existsSync(headFile) || !statSync(headFile).isFile()) {
          return {
            gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
            headSha: envSha && envSha.length > 0 ? envSha : null
          }
        }
        const headContent = readFileSync(headFile, "utf8").trim()
        if (headContent.startsWith("ref:")) {
          const refPath = headContent.slice("ref:".length).trim()
          const detectedBranch = refPath.startsWith("refs/heads/")
            ? refPath.slice("refs/heads/".length)
            : null
          const detectedSha = resolveRefSha(dirs.gitDir, dirs.commonGitDir, refPath)
          return {
            gitBranch: envBranch && envBranch.length > 0 ? envBranch : detectedBranch,
            headSha: envSha && envSha.length > 0 ? envSha : detectedSha
          }
        }
        return {
          gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
          headSha:
            envSha && envSha.length > 0
              ? envSha
              : headContent.length > 0
                ? headContent
                : null
        }
      },
      catch: (): GitHeadState => ({
        gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
        headSha: envSha && envSha.length > 0 ? envSha : null
      })
    }).pipe(
      Effect.orElseSucceed(
        (): GitHeadState => ({
          gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
          headSha: envSha && envSha.length > 0 ? envSha : null
        })
      )
    )
  )
}

export const GraphHeadMetaSchema = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String
})
export type GraphHeadMeta = typeof GraphHeadMetaSchema.Type

const decodeGraphHeadMetaOption = Schema.decodeOption(
  Schema.fromJsonString(GraphHeadMetaSchema)
)

export const readGraphHeadMeta = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): GraphHeadMeta | null => {
  const customDir = env.HARNESS_STATE_DIR?.trim()
  const stateDir =
    customDir && customDir.length > 0
      ? resolve(repoRoot, customDir)
      : join(resolve(repoRoot), ".harness")
  const metaPath = join(stateDir, "graph-head.json")
  if (!existsSync(metaPath)) {
    return null
  }
  return Effect.runSync(
    Effect.try({
      try: () => readFileSync(metaPath, "utf8"),
      catch: () => ""
    }).pipe(
      Effect.flatMap((raw) => Effect.fromOption(decodeGraphHeadMetaOption(raw))),
      Effect.option,
      Effect.map((opt) => Option.getOrNull(opt))
    )
  )
}

export const writeGraphHeadMeta = (
  repoRoot: string,
  headState?: GitHeadState,
  env: NodeJS.ProcessEnv = process.env
): GraphHeadMeta | null => {
  const resolved = headState ?? resolveGitHeadState(repoRoot, env)
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
    updatedAt: new Date().toISOString()
  }
  Effect.runSync(
    Effect.try({
      try: () => {
        if (!existsSync(stateDir)) {
          mkdirSync(stateDir, { recursive: true })
        }
        writeFileSync(join(stateDir, "graph-head.json"), JSON.stringify(meta, null, 2), "utf8")
      },
      catch: () => undefined
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
  return meta
}

export const OmnigraphReconcileReason = Schema.Literals([
  "up-to-date",
  "missing-snapshot",
  "head-sha-changed",
  "git-branch-changed"
])
export type OmnigraphReconcileReason = typeof OmnigraphReconcileReason.Type

export const OmnigraphReconcileInput = Schema.Struct({
  snapshotExists: Schema.Boolean,
  recordedHeadSha: Schema.NullOr(Schema.String),
  currentHeadSha: Schema.NullOr(Schema.String),
  recordedGitBranch: Schema.NullOr(Schema.String),
  currentGitBranch: Schema.NullOr(Schema.String)
})
export type OmnigraphReconcileInput = typeof OmnigraphReconcileInput.Type

export interface OmnigraphReconcileDecision {
  readonly needsReconcile: boolean
  readonly reason: OmnigraphReconcileReason
  readonly targetOmnigraphBranch: string
}

export const sanitizeOmnigraphBranchSlug = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9._-]/g, "_")

export const decideOmnigraphReconcile = Effect.fn("OmnigraphReconcile.decide")(
  function* (input: OmnigraphReconcileInput) {
    yield* Effect.void
    const branchTrimmed = input.currentGitBranch?.trim() ?? ""
    const isFeatureBranch =
      branchTrimmed.length > 0 &&
      branchTrimmed !== "main" &&
      branchTrimmed !== "master"
    const targetOmnigraphBranch = isFeatureBranch
      ? `impl/branch-${sanitizeOmnigraphBranchSlug(branchTrimmed)}`
      : "main"

    if (!input.snapshotExists) {
      return {
        needsReconcile: true,
        reason: "missing-snapshot" as const,
        targetOmnigraphBranch
      } satisfies OmnigraphReconcileDecision
    }

    if (
      input.currentHeadSha !== null &&
      input.currentHeadSha.length > 0 &&
      input.recordedHeadSha !== input.currentHeadSha
    ) {
      return {
        needsReconcile: true,
        reason: "head-sha-changed" as const,
        targetOmnigraphBranch
      } satisfies OmnigraphReconcileDecision
    }

    if (
      input.currentGitBranch !== null &&
      input.recordedGitBranch !== null &&
      input.recordedGitBranch !== input.currentGitBranch
    ) {
      return {
        needsReconcile: true,
        reason: "git-branch-changed" as const,
        targetOmnigraphBranch
      } satisfies OmnigraphReconcileDecision
    }

    return {
      needsReconcile: false,
      reason: "up-to-date" as const,
      targetOmnigraphBranch
    } satisfies OmnigraphReconcileDecision
  }
)

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
    const slug = sanitizeOmnigraphBranchSlug(worktreeId)
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main"
    }
  }
  const absRoot = resolve(repoRoot)
  const canonicalRoot = resolveCanonicalRepoRoot(absRoot)
  if (absRoot !== canonicalRoot) {
    const slug = sanitizeOmnigraphBranchSlug(basename(absRoot))
    return {
      planBranch: `plan/wt-${slug}`,
      implBranch: `impl/wt-${slug}`,
      mainBranch: "main"
    }
  }
  const headState = resolveGitHeadState(absRoot, env)
  const gitBranch = headState.gitBranch?.trim()
  if (gitBranch && gitBranch.length > 0 && gitBranch !== "main" && gitBranch !== "master") {
    const slug = sanitizeOmnigraphBranchSlug(gitBranch)
    return {
      planBranch: `plan/branch-${slug}`,
      implBranch: `impl/branch-${slug}`,
      mainBranch: "main"
    }
  }
  return {
    planBranch: "plan/current",
    implBranch: "impl/current",
    mainBranch: "main"
  }
}
