/**
 * @fileoverview Backup recovery and git-diff line extraction helpers for mutation-check.
 */
import { join, relative, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { parseGitDiffModifiedLines } from "./mutant-ast-generator.js"

export type GitDiffExtractionResult =
  | { readonly kind: "not-git" }
  | {
      readonly kind: "ok"
      readonly lines: ReadonlyMap<string, ReadonlySet<number>>
      readonly diffMode: "working-tree" | "branch-base"
    }
  | { readonly kind: "failed"; readonly reason: string }

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
    hostIo.execFileSync("git", ["rev-parse", "--is-inside-work-tree"], gitOpts),
  )
  const revParseStatus:
    | { readonly kind: "proceed" }
    | { readonly kind: "not-git" }
    | { readonly kind: "failed"; readonly reason: string } = match(revParseRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      kind: "failed" as const,
      reason: `git rev-parse --is-inside-work-tree threw: ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (res) => {
          if (res.exitCode === 0 && res.stdout.trim() === "true")
            return { kind: "proceed" as const }
          if (
            res.exitCode === 128 &&
            /not a git repository/i.test(`${res.stdout}\n${res.stderr}`)
          ) {
            return { kind: "not-git" as const }
          }
          const stderrPart = res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""
          return {
            kind: "failed" as const,
            reason: `git rev-parse --is-inside-work-tree failed (exitCode=${res.exitCode}${stderrPart})`,
          }
        })
        .with({ _tag: "TimedOut" }, (res) => ({
          kind: "failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (timedOut=true${res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""})`,
        }))
        .with({ _tag: "Signaled" }, (res) => ({
          kind: "failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (signal=${res.signal}${res.stderr.trim().length > 0 ? `, stderr=${res.stderr.trim()}` : ""})`,
        }))
        .with({ _tag: "SpawnFailed" }, (res) => ({
          kind: "failed" as const,
          reason: `git rev-parse --is-inside-work-tree failed (spawnError=${res.spawnError})`,
        }))
        .exhaustive(),
    )
    .exhaustive()

  const earlyExit = match(revParseStatus)
    .with({ kind: "proceed" }, () => undefined)
    .with({ kind: "not-git" }, () => ({ kind: "not-git" as const }))
    .with({ kind: "failed" }, ({ reason }) => ({ kind: "failed" as const, reason }))
    .exhaustive()
  if (earlyExit !== undefined) return earlyExit

  const runGit = (
    args: ReadonlyArray<string>,
  ):
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly reason: string } => {
    const res = Result.try(() => hostIo.execFileSync("git", args, gitOpts))
    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        ok: false as const,
        reason: `git ${args.join(" ")} threw: ${failure instanceof Error ? failure.message : String(failure)}`,
      }))
      .with({ _tag: "Success" }, ({ success }) =>
        match(success)
          .with({ _tag: "Exited" }, (r) => {
            if (r.exitCode === 0) return { ok: true as const, stdout: r.stdout }
            const stderrPart = r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""
            return {
              ok: false as const,
              reason: `git ${args.join(" ")} failed (exitCode=${r.exitCode}${stderrPart})`,
            }
          })
          .with({ _tag: "TimedOut" }, (r) => ({
            ok: false as const,
            reason: `git ${args.join(" ")} failed (timedOut=true${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
          }))
          .with({ _tag: "Signaled" }, (r) => ({
            ok: false as const,
            reason: `git ${args.join(" ")} failed (signal=${r.signal}${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
          }))
          .with({ _tag: "SpawnFailed" }, (r) => ({
            ok: false as const,
            reason: `git ${args.join(" ")} failed (spawnError=${r.spawnError}${r.stderr.trim().length > 0 ? `, stderr=${r.stderr.trim()}` : ""})`,
          }))
          .exhaustive(),
      )
      .exhaustive()
  }

  const diffFromMergeBase = (
    baseRef: string,
  ):
    | { readonly status: "ok"; readonly lines: ReadonlyMap<string, ReadonlySet<number>> }
    | { readonly status: "merge-base-failed"; readonly reason: string }
    | { readonly status: "diff-failed"; readonly reason: string } => {
    const mb = runGit(["merge-base", "HEAD", baseRef])
    if (!mb.ok) return { status: "merge-base-failed", reason: mb.reason }
    const mergeBase = mb.stdout.trim()
    if (mergeBase.length === 0) {
      return {
        status: "merge-base-failed",
        reason: `git merge-base HEAD ${baseRef} returned empty output`,
      }
    }
    const baseDiff = runGit(["diff", "-U0", `${mergeBase}...HEAD`, "--", "libs/"])
    if (!baseDiff.ok) return { status: "diff-failed", reason: baseDiff.reason }
    return { status: "ok", lines: parseGitDiffModifiedLines(baseDiff.stdout) }
  }

  if (options?.explicitBaseRef === true) {
    if (options.fallbackBaseRef === undefined) {
      return { kind: "failed", reason: "explicitBaseRef requires fallbackBaseRef" }
    }
    return match(diffFromMergeBase(options.fallbackBaseRef))
      .with({ status: "ok" }, ({ lines }) => ({
        kind: "ok" as const,
        lines,
        diffMode: "branch-base" as const,
      }))
      .with({ status: "merge-base-failed" }, ({ reason }) => ({ kind: "failed" as const, reason }))
      .with({ status: "diff-failed" }, ({ reason }) => ({ kind: "failed" as const, reason }))
      .exhaustive()
  }

  const primaryDiff = runGit(["diff", "-U0"])
  if (!primaryDiff.ok) return { kind: "failed", reason: primaryDiff.reason }

  const headDiff = runGit(["diff", "-U0", "HEAD"])
  if (!headDiff.ok) return { kind: "failed", reason: headDiff.reason }

  const mergedMap = new Map<string, Set<number>>()
  mergeLineMaps(mergedMap, parseGitDiffModifiedLines(primaryDiff.stdout))
  mergeLineMaps(mergedMap, parseGitDiffModifiedLines(headDiff.stdout))

  const untrackedRes = runGit(["ls-files", "--others", "--exclude-standard", "--", "libs/"])
  if (!untrackedRes.ok) return { kind: "failed", reason: untrackedRes.reason }

  for (const rawLine of untrackedRes.stdout.split(/\r?\n/)) {
    const relPath = rawLine.trim().replace(/\\/g, "/")
    if (
      relPath.length === 0 ||
      !(relPath.endsWith(".ts") || relPath.endsWith(".tsx")) ||
      relPath.endsWith(".d.ts")
    ) {
      continue
    }
    const absPath = join(repoRoot, relPath)
    if (!hostIo.existsSync(absPath)) continue
    const readRes = Result.try(() => hostIo.readTextSync(absPath))
    match(readRes)
      .with({ _tag: "Success" }, ({ success: content }) => {
        const lineCount = content.split(/\r?\n/).length
        let lineSet = mergedMap.get(relPath)
        if (lineSet === undefined) {
          lineSet = new Set<number>()
          mergedMap.set(relPath, lineSet)
        }
        for (let ln = 1; ln <= lineCount; ln++) lineSet.add(ln)
      })
      .with({ _tag: "Failure" }, () => {})
      .exhaustive()
  }

  const hasLibsDiff = Array.from(mergedMap.keys()).some((k) => k.startsWith("libs/"))
  if (!hasLibsDiff && options?.fallbackBaseRef !== undefined) {
    const handled = match(diffFromMergeBase(options.fallbackBaseRef))
      .with({ status: "ok" }, ({ lines }) => ({
        kind: "ok" as const,
        lines,
        diffMode: "branch-base" as const,
      }))
      .with({ status: "diff-failed" }, ({ reason }) => ({ kind: "failed" as const, reason }))
      .with({ status: "merge-base-failed" }, () => undefined)
      .exhaustive()
    if (handled !== undefined) return handled
  }

  return { kind: "ok", lines: mergedMap, diffMode: "working-tree" }
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

export const unlinkBackupChecked = (backupPath: string, hostIo: SyncHostIo): string | undefined => {
  if (!hostIo.existsSync(backupPath)) return undefined
  const unlinkRes = Result.try(() => {
    hostIo.unlinkSync(backupPath)
  })
  return match(unlinkRes)
    .with({ _tag: "Success" }, () => undefined)
    .with(
      { _tag: "Failure" },
      ({ failure }) =>
        `Failed to unlink '${backupPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
    )
    .exhaustive()
}

export const recoverStartupBackup = (
  repoRoot: string,
  backupPath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (!hostIo.existsSync(backupPath)) return undefined
  const backupReadRes = Result.try(() => hostIo.readTextSync(backupPath))
  const restoreFailureReason = match(backupReadRes)
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
          return match(Result.try(() => hostIo.readTextSync(resolvedTarget)))
            .with(
              { _tag: "Failure" },
              ({ failure }) =>
                `Failed to read target '${relTarget}': ${failure instanceof Error ? failure.message : String(failure)}`,
            )
            .with({ _tag: "Success" }, ({ success: currentContent }) => {
              const currentSha256 = computeContentSha256(currentContent)
              const originalSha256 = decoded.originalSha256 ?? computeContentSha256(content)
              if (decoded.mutatedSha256 !== undefined && currentSha256 === decoded.mutatedSha256) {
                const writeErr = match(
                  Result.try(() => {
                    hostIo.writeTextSync(resolvedTarget, content)
                  }),
                )
                  .with({ _tag: "Success" }, () => undefined)
                  .with({ _tag: "Failure" }, ({ failure }) =>
                    failure instanceof Error ? failure.message : String(failure),
                  )
                  .exhaustive()
                return writeErr !== undefined ? writeErr : unlinkBackupChecked(backupPath, hostIo)
              }
              if (currentSha256 === originalSha256) return unlinkBackupChecked(backupPath, hostIo)
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
  const res = Result.try(() => {
    if (!hostIo.existsSync(harnessDir)) hostIo.mkdirRecursiveSync(harnessDir)
    hostIo.writeTextSync(
      backupPath,
      JSON.stringify({
        filePath: targetPath,
        originalSha256: computeContentSha256(originalSource),
        mutatedSha256: computeContentSha256(mutatedSource),
        content: originalSource,
      }),
    )
  })
  return match(res)
    .with({ _tag: "Success" }, () => undefined)
    .with(
      { _tag: "Failure" },
      ({ failure }) =>
        `[mutation-check] Failed to write mutation backup '${backupPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
    )
    .exhaustive()
}
