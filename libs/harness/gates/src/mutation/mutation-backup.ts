/**
 * @fileoverview Backup recovery and git-diff line extraction helpers for mutation-check.
 */
import { randomBytes } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { parseGitDiffModifiedLines } from "./mutant-ast-generator.js"

export type GitDiffExtractionResult =
  | { readonly _tag: "NotGit" }
  | {
      readonly _tag: "Ok"
      readonly lines: ReadonlyMap<string, ReadonlySet<number>>
      readonly diffMode: "working-tree" | "branch-base"
    }
  | { readonly _tag: "Failed"; readonly reason: string }

export type ExtractGitDiffResult = GitDiffExtractionResult

export interface GitDiffExtractionOptions {
  readonly fallbackBaseRef?: string | undefined
  readonly explicitBaseRef?: boolean | undefined
}

const mergeLineMaps = (
  target: Map<string, Set<number>>,
  source: ReadonlyMap<string, ReadonlySet<number>>,
): void => {
  for (const [file, lineSet] of source.entries()) {
    let dest = target.get(file)
    if (dest === undefined) {
      dest = new Set<number>()
      target.set(file, dest)
    }
    for (const line of lineSet) dest.add(line)
  }
}

export const extractGitDiffModifiedLinesChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
  options?: GitDiffExtractionOptions,
): GitDiffExtractionResult => {
  const gitOpts = { cwd: repoRoot, timeoutMs: 15_000 }
  const revParseRes = Result.try(() =>
    hostIo.execFileSync(
      "git",
      ["-c", "core.quotePath=false", "rev-parse", "--is-inside-work-tree"],
      gitOpts,
    ),
  )
  const revParseStatus:
    | { readonly _tag: "Proceed" }
    | { readonly _tag: "NotGit" }
    | { readonly _tag: "Failed"; readonly reason: string } = match(revParseRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Failed" as const,
      reason: `git rev-parse --is-inside-work-tree threw: ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (res) => {
          if (res.exitCode === 0 && res.stdout.trim() === "true")
            return { _tag: "Proceed" as const }
          if (
            res.exitCode === 128 &&
            /not a git repository/i.test(`${res.stdout}\n${res.stderr}`)
          ) {
            return { _tag: "NotGit" as const }
          }
          const stderrPart = res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""
          return {
            _tag: "Failed" as const,
            reason: `git rev-parse --is-inside-work-tree failed (exitCode=${res.exitCode}${stderrPart})`,
          }
        })
        .with({ _tag: "TimedOut" }, (res) => ({
          _tag: "Failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (timedOut=true${res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""})`,
        }))
        .with({ _tag: "Signaled" }, (res) => ({
          _tag: "Failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (signal=${res.signal}${res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""})`,
        }))
        .with({ _tag: "SpawnFailed" }, (res) => ({
          _tag: "Failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (spawnError=${res.spawnError})`,
        }))
        .exhaustive(),
    )
    .exhaustive()

  const earlyExit = match(revParseStatus)
    .with({ _tag: "Proceed" }, () => undefined)
    .with({ _tag: "NotGit" }, () => ({ _tag: "NotGit" as const }))
    .with({ _tag: "Failed" }, ({ reason }) => ({ _tag: "Failed" as const, reason }))
    .exhaustive()
  if (earlyExit !== undefined) return earlyExit

  const runGit = (args: ReadonlyArray<string>): Result.Result<string, string> => {
    const res = Result.try(() =>
      hostIo.execFileSync("git", ["-c", "core.quotePath=false", ...args], gitOpts),
    )
    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Result.fail(
          `git ${args.join(" ")} threw: ${failure instanceof Error ? failure.message : String(failure)}`,
        ),
      )
      .with({ _tag: "Success" }, ({ success }) =>
        match(success)
          .with({ _tag: "Exited" }, (r) => {
            if (r.exitCode === 0) return Result.succeed(r.stdout)
            const stderrPart = r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""
            return Result.fail(`git ${args.join(" ")} failed (exitCode=${r.exitCode}${stderrPart})`)
          })
          .with({ _tag: "TimedOut" }, (r) =>
            Result.fail(
              `git ${args.join(" ")} failed (timedOut=true${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
            ),
          )
          .with({ _tag: "Signaled" }, (r) =>
            Result.fail(
              `git ${args.join(" ")} failed (signal=${r.signal}${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
            ),
          )
          .with({ _tag: "SpawnFailed" }, (r) =>
            Result.fail(
              `git ${args.join(" ")} failed (spawnError=${r.spawnError}${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
            ),
          )
          .exhaustive(),
      )
      .exhaustive()
  }

  const collectUntrackedLibsFiles = (
    targetMap: Map<string, Set<number>>,
  ): Result.Result<void, string> =>
    Result.flatMap(
      runGit(["ls-files", "--others", "--exclude-standard", "--", "libs/", "apps/"]),
      (stdout) => {
        for (const rawLine of stdout.split(/\r?\n/)) {
          const relPath = rawLine.trim().replace(/\\/g, "/")
          if (
            relPath.length === 0 ||
            !(relPath.endsWith(".ts") || relPath.endsWith(".tsx")) ||
            relPath.endsWith(".d.ts")
          ) {
            continue
          }
          const absPath = join(repoRoot, relPath)
          const symRes = Result.try({
            try: () => hostIo.isSymbolicLinkSync(absPath),
            catch: (err) =>
              `Failed to check symlink status for untracked file '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
          })
          const symErr = match(symRes)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, ({ success: isSymlink }) =>
              isSymlink ? `Refusing symlink untracked file '${relPath}'` : undefined,
            )
            .exhaustive()
          if (symErr !== undefined) return Result.fail(symErr)

          const existsRes = Result.try({
            try: () => hostIo.existsSync(absPath),
            catch: (err) =>
              `Failed to stat untracked file '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
          })
          const existsErr = match(existsRes)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, ({ success: exists }) => {
              if (!exists) return undefined
              return match(Result.try(() => hostIo.readTextSync(absPath)))
                .with({ _tag: "Success" }, ({ success: content }) => {
                  const lineCount = content.split(/\r?\n/).length
                  let lineSet = targetMap.get(relPath)
                  if (lineSet === undefined) {
                    lineSet = new Set<number>()
                    targetMap.set(relPath, lineSet)
                  }
                  for (let ln = 1; ln <= lineCount; ln++) lineSet.add(ln)
                  return undefined
                })
                .with(
                  { _tag: "Failure" },
                  ({ failure }) =>
                    `Failed to read untracked file '${relPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
                )
                .exhaustive()
            })
            .exhaustive()
          if (existsErr !== undefined) return Result.fail(existsErr)
        }
        return Result.succeed(undefined)
      },
    )

  const diffFromMergeBase = (baseRef: string): Result.Result<Map<string, Set<number>>, string> => {
    if (baseRef.startsWith("-")) {
      return Result.fail(`Invalid baseRef '${baseRef}': must not start with '-'`)
    }
    return Result.flatMap(runGit(["rev-parse", "--verify", `${baseRef}^{commit}`]), () =>
      Result.flatMap(runGit(["merge-base", "HEAD", baseRef]), (mbStdout) => {
        const mergeBase = mbStdout.trim()
        if (mergeBase.length === 0) {
          return Result.fail(`git merge-base HEAD ${baseRef} returned empty output`)
        }
        return Result.flatMap(
          runGit(["diff", "-U0", mergeBase, "--", "libs/", "apps/"]),
          (diffStdout) => {
            const lineMap = new Map<string, Set<number>>()
            mergeLineMaps(lineMap, parseGitDiffModifiedLines(diffStdout))
            return Result.map(collectUntrackedLibsFiles(lineMap), () => lineMap)
          },
        )
      }),
    )
  }

  if (options?.explicitBaseRef === true) {
    if (options.fallbackBaseRef === undefined) {
      return { _tag: "Failed", reason: "explicitBaseRef requires fallbackBaseRef" }
    }
    return match(diffFromMergeBase(options.fallbackBaseRef))
      .with({ _tag: "Success" }, ({ success: lines }) => ({
        _tag: "Ok" as const,
        lines,
        diffMode: "branch-base" as const,
      }))
      .with({ _tag: "Failure" }, ({ failure: reason }) => ({ _tag: "Failed" as const, reason }))
      .exhaustive()
  }

  const workingTreeRes = Result.flatMap(runGit(["diff", "-U0"]), (primaryStdout) =>
    Result.flatMap(runGit(["diff", "-U0", "HEAD"]), (headStdout) => {
      const mergedMap = new Map<string, Set<number>>()
      mergeLineMaps(mergedMap, parseGitDiffModifiedLines(primaryStdout))
      mergeLineMaps(mergedMap, parseGitDiffModifiedLines(headStdout))
      return Result.map(collectUntrackedLibsFiles(mergedMap), () => mergedMap)
    }),
  )

  return match(workingTreeRes)
    .with({ _tag: "Failure" }, ({ failure: reason }) => ({ _tag: "Failed" as const, reason }))
    .with({ _tag: "Success" }, ({ success: mergedMap }) => {
      if (options?.fallbackBaseRef !== undefined) {
        return match(diffFromMergeBase(options.fallbackBaseRef))
          .with({ _tag: "Failure" }, ({ failure: reason }) => ({ _tag: "Failed" as const, reason }))
          .with({ _tag: "Success" }, ({ success: branchLines }) => {
            mergeLineMaps(branchLines, mergedMap)
            return {
              _tag: "Ok" as const,
              lines: branchLines,
              diffMode: "branch-base" as const,
            }
          })
          .exhaustive()
      }
      return { _tag: "Ok" as const, lines: mergedMap, diffMode: "working-tree" as const }
    })
    .exhaustive()
}

export const BackupSchema = Schema.fromJsonString(
  Schema.Struct({
    filePath: Schema.optional(Schema.String),
    originalSha256: Schema.optional(Schema.String),
    mutatedSha256: Schema.optional(Schema.String),
    content: Schema.optional(Schema.String),
    originalSource: Schema.optional(Schema.String),
  }),
)

const checkNonSymlinkIfPresent = (
  targetPath: string,
  label: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const symRes = Result.try(() => hostIo.isSymbolicLinkSync(targetPath))
  return match(symRes)
    .with(
      { _tag: "Failure" },
      ({ failure }) =>
        `Failed to inspect ${label} '${targetPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
    )
    .with({ _tag: "Success" }, ({ success: isSym }) =>
      isSym ? `Refusing symlink ${label} '${targetPath}'` : undefined,
    )
    .exhaustive()
}

const existsSyncChecked = (
  targetPath: string,
  hostIo: SyncHostIo,
): Result.Result<boolean, string> =>
  Result.try({
    try: () => hostIo.existsSync(targetPath),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })

const bestEffortUnlinkTemp = (tmpPath: string, hostIo: SyncHostIo): string | undefined => {
  const existsRes = existsSyncChecked(tmpPath, hostIo)
  return match(existsRes)
    .with({ _tag: "Failure" }, ({ failure }) => ` (cleanup exists check failed: ${failure})`)
    .with({ _tag: "Success" }, ({ success: exists }) =>
      !exists
        ? undefined
        : match(
            Result.try({
              try: () => {
                hostIo.unlinkSync(tmpPath)
              },
              catch: (err) => (err instanceof Error ? err.message : String(err)),
            }),
          )
            .with({ _tag: "Success" }, () => undefined)
            .with({ _tag: "Failure" }, ({ failure }) => ` (cleanup unlink failed: ${failure})`)
            .exhaustive(),
    )
    .exhaustive()
}

const atomicWriteTextSync = (
  targetPath: string,
  content: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  const tmpSymErr = checkNonSymlinkIfPresent(tmpPath, "temporary file", hostIo)
  if (tmpSymErr !== undefined) return tmpSymErr
  return match(
    Result.try({
      try: () => {
        hostIo.writeTextSync(tmpPath, content)
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }),
  )
    .with({ _tag: "Failure" }, ({ failure }) => {
      const cleanupErr = bestEffortUnlinkTemp(tmpPath, hostIo) ?? ""
      return `${failure}${cleanupErr}`
    })
    .with({ _tag: "Success" }, () =>
      match(
        Result.try({
          try: () => {
            hostIo.renameSync(tmpPath, targetPath)
          },
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }),
      )
        .with({ _tag: "Success" }, () => undefined)
        .with({ _tag: "Failure" }, ({ failure }) => {
          const cleanupErr = bestEffortUnlinkTemp(tmpPath, hostIo) ?? ""
          return `${failure}${cleanupErr}`
        })
        .exhaustive(),
    )
    .exhaustive()
}

export const unlinkBackupChecked = (backupPath: string, hostIo: SyncHostIo): string | undefined => {
  const symErr = checkNonSymlinkIfPresent(backupPath, "backup file", hostIo)
  if (symErr !== undefined) return symErr
  return match(existsSyncChecked(backupPath, hostIo))
    .with({ _tag: "Failure" }, ({ failure }) => `Failed to stat '${backupPath}': ${failure}`)
    .with({ _tag: "Success" }, ({ success: exists }) =>
      !exists
        ? undefined
        : match(
            Result.try(() => {
              hostIo.unlinkSync(backupPath)
            }),
          )
            .with({ _tag: "Success" }, () => undefined)
            .with(
              { _tag: "Failure" },
              ({ failure }) =>
                `Failed to unlink '${backupPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
            )
            .exhaustive(),
    )
    .exhaustive()
}

export const recoverStartupBackup = (
  repoRoot: string,
  backupPath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const backupSymErr =
    checkNonSymlinkIfPresent(dirname(backupPath), "backup directory", hostIo) ??
    checkNonSymlinkIfPresent(backupPath, "backup file", hostIo)
  if (backupSymErr !== undefined) {
    return `[mutation-check] CRITICAL: Failed to restore startup backup '${backupPath}' (${backupSymErr}); aborting without deleting backup.`
  }
  const backupExistsRes = existsSyncChecked(backupPath, hostIo)
  const backupAbsentOrErr = match(backupExistsRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "ReadBackup" as const,
      stopReason: failure,
    }))
    .with({ _tag: "Success" }, ({ success: exists }) =>
      exists ? ({ _tag: "Continue" as const } as const) : ({ _tag: "Absent" as const } as const),
    )
    .exhaustive()
  const restoreFailureReason = match(backupAbsentOrErr)
    .with({ _tag: "Absent" }, () => undefined)
    .with({ _tag: "ReadBackup" }, ({ stopReason }) => stopReason)
    .with({ _tag: "Continue" }, () => {
      const backupReadRes = Result.try(() => hostIo.readTextSync(backupPath))
      return match(backupReadRes)
        .with({ _tag: "Success" }, ({ success: rawBackup }) =>
          match(Schema.decodeOption(BackupSchema)(rawBackup))
            .with({ _tag: "Some" }, ({ value: decoded }) => {
              const content = decoded.content ?? decoded.originalSource
              if (decoded.filePath === undefined || content === undefined)
                return "Backup JSON missing filePath or content"
              const resolvedTarget = resolve(repoRoot, decoded.filePath)
              const relTarget = relative(resolve(repoRoot), resolvedTarget).replace(/\\/g, "/")
              if (
                relTarget.startsWith("..") ||
                relTarget.startsWith("/") ||
                (!relTarget.startsWith("libs/") && !relTarget.startsWith("apps/"))
              ) {
                return `Backup target path '${decoded.filePath}' escapes workspace bounds`
              }
              const targetSymErr = checkNonSymlinkIfPresent(
                resolvedTarget,
                "restore target",
                hostIo,
              )
              if (targetSymErr !== undefined) return targetSymErr
              const realCheck = Result.try(() => {
                const canonicalRoot = hostIo.realpathSync(repoRoot)
                const canonicalTarget = hostIo.realpathSync(resolvedTarget)
                const canonicalRel = relative(canonicalRoot, canonicalTarget).replace(/\\/g, "/")
                return (
                  canonicalRel.startsWith("..") ||
                  canonicalRel.startsWith("/") ||
                  (!canonicalRel.startsWith("libs/") && !canonicalRel.startsWith("apps/"))
                )
              })
              const escapeErr = match(realCheck)
                .with(
                  { _tag: "Failure" },
                  ({ failure }) =>
                    `Failed to canonicalize target '${relTarget}': ${failure instanceof Error ? failure.message : String(failure)}`,
                )
                .with({ _tag: "Success" }, ({ success: escaped }) =>
                  escaped
                    ? `Canonical target for '${decoded.filePath}' escapes libs/apps bounds`
                    : undefined,
                )
                .exhaustive()
              if (escapeErr !== undefined) return escapeErr
              return match(Result.try(() => hostIo.readTextSync(resolvedTarget)))
                .with(
                  { _tag: "Failure" },
                  ({ failure }) =>
                    `Failed to read target '${relTarget}': ${failure instanceof Error ? failure.message : String(failure)}`,
                )
                .with({ _tag: "Success" }, ({ success: currentContent }) => {
                  const currentSha256 = computeContentSha256(currentContent)
                  const originalSha256 = decoded.originalSha256 ?? computeContentSha256(content)
                  if (
                    decoded.mutatedSha256 !== undefined &&
                    currentSha256 === decoded.mutatedSha256
                  ) {
                    const writeErr = atomicWriteTextSync(resolvedTarget, content, hostIo)
                    return writeErr !== undefined
                      ? writeErr
                      : unlinkBackupChecked(backupPath, hostIo)
                  }
                  if (currentSha256 === originalSha256)
                    return unlinkBackupChecked(backupPath, hostIo)
                  return `Target '${relTarget}' was modified on disk (sha256=${currentSha256}) and matches neither originalSha256 (${originalSha256}) nor mutatedSha256 (${decoded.mutatedSha256 ?? "none"}); refusing to overwrite user edits. Inspect and remove '${backupPath}' manually.`
                })
                .exhaustive()
            })
            .with({ _tag: "None" }, () => "Backup JSON failed schema decoding")
            .exhaustive(),
        )
        .with({ _tag: "Failure" }, ({ failure }) =>
          failure instanceof Error ? failure.message : String(failure),
        )
        .exhaustive()
    })
    .exhaustive()

  return restoreFailureReason !== undefined
    ? `[mutation-check] CRITICAL: Failed to restore startup backup '${backupPath}' (${restoreFailureReason}); aborting without deleting backup.`
    : undefined
}

export const writeMutationBackup = (
  repoRoot: string,
  backupPath: string,
  targetPath: string,
  originalSource: string,
  mutatedSource: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const harnessDir = join(repoRoot, ".harness")
  const backupDir = dirname(backupPath)
  const symErr =
    checkNonSymlinkIfPresent(harnessDir, "harness dir", hostIo) ??
    checkNonSymlinkIfPresent(backupDir, "backup dir", hostIo) ??
    checkNonSymlinkIfPresent(backupPath, "backup file", hostIo)
  if (symErr !== undefined) {
    return `[mutation-check] Failed to write mutation backup '${backupPath}': ${symErr}`
  }
  const mkdirErr = match(existsSyncChecked(backupDir, hostIo))
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success: exists }) =>
      exists
        ? undefined
        : match(
            Result.try({
              try: () => {
                hostIo.mkdirRecursiveSync(backupDir)
              },
              catch: (err) => (err instanceof Error ? err.message : String(err)),
            }),
          )
            .with({ _tag: "Success" }, () => undefined)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .exhaustive(),
    )
    .exhaustive()
  if (mkdirErr !== undefined) {
    return `[mutation-check] Failed to write mutation backup '${backupPath}': ${mkdirErr}`
  }
  const writeErr = atomicWriteTextSync(
    backupPath,
    JSON.stringify({
      filePath: targetPath,
      originalSha256: computeContentSha256(originalSource),
      mutatedSha256: computeContentSha256(mutatedSource),
      content: originalSource,
    }),
    hostIo,
  )
  return writeErr !== undefined
    ? `[mutation-check] Failed to write mutation backup '${backupPath}': ${writeErr}`
    : undefined
}
