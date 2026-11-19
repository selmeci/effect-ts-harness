import { createHash, randomBytes } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import {
  normalizeNonRootWorkspacePath,
  OmnigraphChangeCursor,
  OmnigraphCommitId,
  sanitizeWorktreeIdSegment,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"

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
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
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
        headSha: envSha && envSha.length > 0 ? envSha : headContent.length > 0 ? headContent : null,
      }
    }),
    () => fallback,
  )
}

export const GraphHeadMetaSchema = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  omnigraphCommitId: Schema.optional(Schema.NullOr(OmnigraphCommitId)),
  changeFeedCursor: Schema.optional(Schema.NullOr(OmnigraphChangeCursor)),
})
export type GraphHeadMeta = typeof GraphHeadMetaSchema.Type

export interface GraphHeadMetaExtra {
  readonly omnigraphCommitId?: OmnigraphCommitId | null | undefined
  readonly changeFeedCursor?: OmnigraphChangeCursor | null | undefined
}

const decodeGraphHeadMetaOption = Schema.decodeOption(Schema.fromJsonString(GraphHeadMetaSchema))

const resolveGraphMetaStateDir = (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const validRoot = normalizeNonRootWorkspacePath(resolve(normalizeNonRootWorkspacePath(repoRoot)))
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

export type GraphHeadMetaReadState =
  | { readonly _tag: "Present"; readonly meta: GraphHeadMeta }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Corrupt"; readonly path: string; readonly reason: string }

export const readGraphHeadMetaState = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): GraphHeadMetaReadState =>
  match(Result.try(() => resolveGraphMetaStateDir(repoRoot, env)))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Corrupt" as const,
      path: repoRoot,
      reason: toErrorReasonMessage(failure),
    }))
    .with({ _tag: "Success" }, ({ success: stateDir }) => {
      const metaPath = join(stateDir, "graph-head.json")
      if (!hostIo.existsSync(metaPath)) {
        return { _tag: "Missing" as const }
      }
      const readRes = Result.try(() => hostIo.readTextSync(metaPath))
      return match(readRes)
        .with({ _tag: "Failure" }, ({ failure }) => ({
          _tag: "Corrupt" as const,
          path: metaPath,
          reason: toErrorReasonMessage(failure),
        }))
        .with({ _tag: "Success" }, ({ success: raw }) =>
          match(decodeGraphHeadMetaOption(raw))
            .with({ _tag: "Some" }, ({ value }) => ({
              _tag: "Present" as const,
              meta: value,
            }))
            .with({ _tag: "None" }, () => ({
              _tag: "Corrupt" as const,
              path: metaPath,
              reason: "failed to decode as GraphHeadMeta",
            }))
            .exhaustive(),
        )
        .exhaustive()
    })
    .exhaustive()

export const readGraphHeadMeta = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): GraphHeadMeta | null =>
  match(readGraphHeadMetaState(repoRoot, hostIo, env))
    .with({ _tag: "Present" }, ({ meta }) => meta)
    .with({ _tag: "Missing" }, () => null)
    .with({ _tag: "Corrupt" }, ({ path, reason }) => {
      process.stderr.write(
        `[harness/graph] Warning: failed to decode ${path} as GraphHeadMeta (${reason})\n`,
      )
      return null
    })
    .exhaustive()

const GRAPH_HEAD_LOCK_STALE_MS = 5000

const LockPayloadSchema = Schema.Struct({
  ts: Schema.Finite,
})
const decodeLockPayloadOption = Schema.decodeOption(Schema.fromJsonString(LockPayloadSchema))

type GraphHeadLockHostIo = SyncHostIo & Pick<ExtendedHostIo, "tryWriteExclusiveTextSync">

const hasTryWriteExclusiveTextSync = (hostIo: SyncHostIo): hostIo is GraphHeadLockHostIo =>
  "tryWriteExclusiveTextSync" in hostIo && typeof hostIo.tryWriteExclusiveTextSync === "function"

const isLockPayloadStale = (lockPath: string, hostIo: SyncHostIo): boolean => {
  const readRes = Result.try(() => hostIo.readTextSync(lockPath))
  return match(readRes)
    .with({ _tag: "Failure" }, () => !hostIo.existsSync(lockPath))
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeLockPayloadOption(raw))
        .with({ _tag: "None" }, () => true)
        .with({ _tag: "Some" }, ({ value }) => Date.now() - value.ts > GRAPH_HEAD_LOCK_STALE_MS)
        .exhaustive(),
    )
    .exhaustive()
}

export const withGraphHeadLock = <A>(
  repoRoot: string,
  hostIo: SyncHostIo,
  fn: () => A,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): A => {
  if (!hasTryWriteExclusiveTextSync(hostIo)) {
    return fn()
  }
  const stateDir = match(Result.try(() => resolveGraphMetaStateDir(repoRoot, env)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (stateDir === undefined) {
    return fn()
  }
  const lockPath = join(stateDir, ".graph-head.json.lock")
  const dirReady = Result.isSuccess(
    Result.try(() => {
      if (!hostIo.existsSync(stateDir)) {
        hostIo.mkdirRecursiveSync(stateDir)
      }
    }),
  )
  if (!dirReady) {
    return fn()
  }

  const writeLockOnce = () =>
    hostIo.tryWriteExclusiveTextSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      0o600,
    )

  const acquired = match(writeLockOnce())
    .with({ _tag: "Written" }, () => true)
    .with({ _tag: "Failed" }, () => false)
    .with({ _tag: "Exists" }, () => {
      if (!isLockPayloadStale(lockPath, hostIo)) {
        return false
      }
      Result.try(() => {
        if (hostIo.existsSync(lockPath)) {
          hostIo.unlinkSync(lockPath)
        }
      })
      return match(writeLockOnce())
        .with({ _tag: "Written" }, () => true)
        .with({ _tag: "Exists" }, { _tag: "Failed" }, () => false)
        .exhaustive()
    })
    .exhaustive()

  if (!acquired) {
    return fn()
  }

  const fnResult = Result.try({
    try: () => fn(),
    catch: (cause) => cause,
  })
  Result.try(() => {
    if (hostIo.existsSync(lockPath)) {
      hostIo.unlinkSync(lockPath)
    }
  })
  return match(fnResult)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      // oxlint-disable-next-line -- synchronous lock boundary rethrowing callback error
      throw failure
    })
    .exhaustive()
}

const persistGraphHeadMeta = (
  repoRoot: string,
  hostIo: SyncHostIo,
  meta: GraphHeadMeta,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): GraphHeadMeta | null =>
  match(Result.try(() => resolveGraphMetaStateDir(repoRoot, env)))
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness/graph] Warning: invalid HARNESS_STATE_DIR (${toErrorReasonMessage(failure)})\n`,
      )
      return null
    })
    .with({ _tag: "Success" }, ({ success: stateDir }) => {
      const targetPath = join(stateDir, "graph-head.json")
      const tmpPath = join(
        stateDir,
        `.graph-head.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      )
      const writeResult = Result.try(() => {
        if (!hostIo.existsSync(stateDir)) {
          hostIo.mkdirRecursiveSync(stateDir)
        }
        hostIo.writeTextSync(tmpPath, JSON.stringify(meta, null, 2))
        hostIo.renameSync(tmpPath, targetPath)
      })
      return match(writeResult)
        .with({ _tag: "Failure" }, ({ failure }) => {
          process.stderr.write(
            `[harness/graph] Error: failed to persist ${targetPath}: ${String(failure)}\n`,
          )
          Result.try(() => {
            if (hostIo.existsSync(tmpPath)) {
              hostIo.unlinkSync(tmpPath)
            }
          })
          return null
        })
        .with({ _tag: "Success" }, () => meta)
        .exhaustive()
    })
    .exhaustive()

export const updateGraphHeadCursor = (
  repoRoot: string,
  hostIo: SyncHostIo,
  cursor: OmnigraphChangeCursor | null,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): GraphHeadMeta | null =>
  withGraphHeadLock(
    repoRoot,
    hostIo,
    () => {
      const state = readGraphHeadMetaState(repoRoot, hostIo, env)
      const existingOrErr = match(state)
        .with({ _tag: "Present" }, ({ meta }) => ({ ok: true as const, meta }))
        .with({ _tag: "Missing" }, () => ({ ok: true as const, meta: null }))
        .with({ _tag: "Corrupt" }, ({ path, reason }) => {
          process.stderr.write(
            `[harness/graph] Error: refusing cursor update on corrupt ${path} (${reason}); run full graph sync to rebuild\n`,
          )
          return { ok: false as const }
        })
        .exhaustive()
      if (!existingOrErr.ok) {
        return null
      }
      const existing = existingOrErr.meta
      const meta: GraphHeadMeta = {
        headSha: existing?.headSha ?? null,
        gitBranch: existing?.gitBranch ?? null,
        updatedAt: new Date().toISOString(),
        ...(existing?.omnigraphCommitId !== undefined
          ? { omnigraphCommitId: existing.omnigraphCommitId }
          : {}),
        changeFeedCursor: cursor,
      }
      return persistGraphHeadMeta(repoRoot, hostIo, meta, env)
    },
    env,
  )

export const writeGraphHeadMeta = (
  repoRoot: string,
  hostIo: SyncHostIo,
  headState?: GitHeadState & GraphHeadMetaExtra,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
  extra?: GraphHeadMetaExtra,
): GraphHeadMeta | null =>
  withGraphHeadLock(
    repoRoot,
    hostIo,
    () => {
      const resolved = headState ?? resolveGitHeadState(repoRoot, hostIo, env)
      const hasExplicitOmnigraphExtra =
        extra?.omnigraphCommitId !== undefined ||
        extra?.changeFeedCursor !== undefined ||
        headState?.omnigraphCommitId !== undefined ||
        headState?.changeFeedCursor !== undefined
      if (resolved.headSha === null && resolved.gitBranch === null && !hasExplicitOmnigraphExtra) {
        return null
      }
      const existing = readGraphHeadMeta(repoRoot, hostIo, env)
      const omnigraphCommitId =
        extra?.omnigraphCommitId !== undefined
          ? extra.omnigraphCommitId
          : headState?.omnigraphCommitId !== undefined
            ? headState.omnigraphCommitId
            : existing?.omnigraphCommitId
      const changeFeedCursor =
        extra?.changeFeedCursor !== undefined
          ? extra.changeFeedCursor
          : headState?.changeFeedCursor !== undefined
            ? headState.changeFeedCursor
            : existing?.changeFeedCursor
      const meta: GraphHeadMeta = {
        headSha: resolved.headSha,
        gitBranch: resolved.gitBranch,
        updatedAt: new Date().toISOString(),
        ...(omnigraphCommitId !== undefined ? { omnigraphCommitId } : {}),
        ...(changeFeedCursor !== undefined ? { changeFeedCursor } : {}),
      }
      return persistGraphHeadMeta(repoRoot, hostIo, meta, env)
    },
    env,
  )

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
  worktreeSlug: Schema.optional(Schema.NullOr(Schema.String)),
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
  const worktreeTrimmed = input.worktreeSlug?.trim() ?? ""
  const branchTrimmed = input.currentGitBranch?.trim() ?? ""
  const isFeatureBranch =
    branchTrimmed.length > 0 && branchTrimmed !== "main" && branchTrimmed !== "master"
  const targetOmnigraphBranch =
    worktreeTrimmed.length > 0
      ? `impl/wt-${sanitizeOmnigraphBranchSlug(worktreeTrimmed)}`
      : isFeatureBranch
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
          const backPtrFile = join(gitDir, "gitdir")
          if (hostIo.existsSync(backPtrFile) && hostIo.isFileSync(backPtrFile)) {
            const rawBackPtr = hostIo.readTextSync(backPtrFile).trim()
            const resolvedBackPtr = resolve(gitDir, rawBackPtr)
            if (resolvedBackPtr !== dotGit) {
              return absRoot
            }
          }
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
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): string => {
  const rawCustomDir = env.HARNESS_STATE_DIR
  if (rawCustomDir !== undefined && rawCustomDir.length > 0) {
    const customStateDir = normalizeNonRootWorkspacePath(
      resolve(repoRoot, Schema.decodeSync(WorkspaceFilePath)(rawCustomDir)),
    )
    return join(customStateDir, "omnigraph-cluster")
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
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
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
