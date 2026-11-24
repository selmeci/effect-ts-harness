import { join, relative } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { scanWorkspaceTsFilesChecked } from "@harness/gates/hook-fastpath"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import type { SyncHostIo } from "@harness/service/host-io"

export type TryGitDiffRangeResult =
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "RefMissing" }
  | { readonly _tag: "GitFailed"; readonly reason: string }

export type ResolveModifiedFilesResult =
  | { readonly _tag: "Resolved"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "GitFailed"; readonly reason: string }

const UNKNOWN_REVISION_RE =
  /unknown revision|bad revision|ambiguous argument|Needed a single revision|no merge base/i

export const collectAllWorkspaceSourceAndTestFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ResolveModifiedFilesResult => {
  const collected: Array<string> = []
  for (const rootDir of ["libs", "apps"] as const) {
    const absDir = join(repoRoot, rootDir)
    if (hostIo.existsSync(absDir)) {
      const scanRes = scanWorkspaceTsFilesChecked(absDir, hostIo)
      const err = match(scanRes)
        .with({ _tag: "Ok" }, ({ files }) => {
          for (const absFile of files) {
            collected.push(relative(repoRoot, absFile).replace(/\\/g, "/"))
          }
          return undefined
        })
        .with({ _tag: "Error" }, ({ reason }) => reason)
        .exhaustive()
      if (err !== undefined) {
        return { _tag: "GitFailed", reason: err }
      }
    }
  }
  return { _tag: "Resolved", files: collected }
}

export const tryGitDiffRange = (
  repoRoot: string,
  range: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): TryGitDiffRangeResult =>
  Result.getOrElse(
    Result.try({
      try: (): TryGitDiffRangeResult => {
        const res = hostIo.execFileSync("git", ["diff", "--name-only", range], {
          cwd: repoRoot,
        })
        return match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
            if (exitCode === 0) {
              return {
                _tag: "Ok" as const,
                files: stdout
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0),
              }
            }
            if (UNKNOWN_REVISION_RE.test(stderr)) {
              return { _tag: "RefMissing" as const }
            }
            return {
              _tag: "GitFailed" as const,
              reason: `git diff ${range} failed (${stderr.trim() || `exit code ${exitCode}`})`,
            }
          })
          .with({ _tag: "TimedOut" }, () => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} timed out`,
          }))
          .with({ _tag: "Signaled" }, ({ signal }) => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} killed by signal ${signal}`,
          }))
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} spawn failed: ${spawnError}`,
          }))
          .exhaustive()
      },
      catch: (err): TryGitDiffRangeResult => ({
        _tag: "GitFailed",
        reason: err instanceof Error ? err.message : String(err),
      }),
    }),
    (): TryGitDiffRangeResult => ({
      _tag: "GitFailed",
      reason: `git diff ${range} failed unexpectedly`,
    }),
  )

export const readGitBranchDiffFiles = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ResolveModifiedFilesResult => {
  let sawOkEmpty = false
  for (const range of ["main...HEAD", "origin/main...HEAD", "HEAD~1...HEAD"]) {
    const res = tryGitDiffRange(repoRoot, range, hostIo)
    const outcome = match(res)
      .with({ _tag: "GitFailed" }, (failed) => failed)
      .with({ _tag: "Ok" }, ({ files }) => {
        if (files.length > 0) {
          return { _tag: "Resolved" as const, files }
        }
        sawOkEmpty = true
        return undefined
      })
      .with({ _tag: "RefMissing" }, () => undefined)
      .exhaustive()
    if (outcome !== undefined) {
      return outcome
    }
  }
  if (sawOkEmpty) {
    return { _tag: "Resolved", files: [] }
  }
  process.stderr.write(
    `[harness:verify] Warning: git branch diff refs unavailable in ${repoRoot}; falling back to scanning all workspace .ts/.tsx files.\n`,
  )
  return collectAllWorkspaceSourceAndTestFiles(repoRoot, hostIo)
}

export const resolveModifiedFilesSinceStampOrHead = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ResolveModifiedFilesResult =>
  Result.getOrElse(
    Result.try({
      try: (): ResolveModifiedFilesResult => {
        if (!hostIo.existsSync(join(repoRoot, ".git"))) {
          return collectAllWorkspaceSourceAndTestFiles(repoRoot, hostIo)
        }
        const files = new Set<string>()
        const res = hostIo.execFileSync("git", ["status", "--porcelain", "-uall"], {
          cwd: repoRoot,
        })
        const statusFailure = match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
            if (exitCode !== 0) {
              const detail = stderr.trim() || `exit code ${exitCode}`
              return `git status failed (${detail})`
            }
            for (const line of stdout.split(/\r?\n/)) {
              const trimmed = line.trim()
              if (trimmed.length < 4) continue
              const relPath = trimmed
                .slice(2)
                .trim()
                .replace(/^.*->\s*/, "")
                .replace(/^"|"$/g, "")
              if (relPath.length > 0) {
                files.add(relPath.replace(/\\/g, "/"))
              }
            }
            return undefined
          })
          .with({ _tag: "TimedOut" }, () => "git status timed out")
          .with({ _tag: "Signaled" }, ({ signal }) => `git status killed by signal ${signal}`)
          .with(
            { _tag: "SpawnFailed" },
            ({ spawnError }) => `git status spawn failed: ${spawnError}`,
          )
          .exhaustive()
        if (statusFailure !== undefined) {
          return { _tag: "GitFailed", reason: statusFailure }
        }
        const branchDiffResult = readGitBranchDiffFiles(repoRoot, hostIo)
        return match(branchDiffResult)
          .with({ _tag: "GitFailed" }, (failed) => failed)
          .with({ _tag: "Resolved" }, ({ files: diffFiles }) => {
            for (const diffFile of diffFiles) {
              files.add(diffFile.replace(/\\/g, "/"))
            }
            return { _tag: "Resolved" as const, files: Array.from(files) }
          })
          .exhaustive()
      },
      catch: (err): ResolveModifiedFilesResult => ({
        _tag: "GitFailed",
        reason: err instanceof Error ? err.message : String(err),
      }),
    }),
    (): ResolveModifiedFilesResult => ({
      _tag: "GitFailed",
      reason: "git status failed unexpectedly",
    }),
  )

export const isRootConfigOrSharedCoreChange = (modifiedFiles: ReadonlyArray<string>): boolean =>
  modifiedFiles.length === 0 ||
  modifiedFiles.some(
    (f) =>
      !f.includes("/") ||
      f.startsWith("libs/harness/") ||
      f.startsWith("apps/harness-") ||
      f.startsWith("tools/") ||
      f.endsWith("package.json") ||
      f.endsWith("tsconfig.json") ||
      f.endsWith("tsconfig.base.json"),
  )
