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
  | { readonly kind: "ok"; readonly lines: ReadonlyMap<string, ReadonlySet<number>> }
  | { readonly kind: "failed"; readonly reason: string }

export const extractGitDiffModifiedLinesChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
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
          if (res.exitCode === 0 && res.stdout.trim() === "true") {
            return { kind: "proceed" as const }
          }
          if (res.exitCode === 128 && /not a git repository/i.test(`${res.stdout}\n${res.stderr}`)) {
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

  const runGitDiff = (
    args: ReadonlyArray<string>,
  ): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string } => {
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
            return { ok: false as const, reason: `git ${args.join(" ")} failed (exitCode=${r.exitCode}${stderrPart})` }
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

  const primaryDiff = runGitDiff(["diff", "-U0"])
  if (!primaryDiff.ok) return { kind: "failed", reason: primaryDiff.reason }

  const headDiff = runGitDiff(["diff", "-U0", "HEAD"])
  if (!headDiff.ok) return { kind: "failed", reason: headDiff.reason }

  const diffOut = headDiff.stdout.length > 0 ? `${primaryDiff.stdout}\n${headDiff.stdout}` : primaryDiff.stdout
  return { kind: "ok", lines: parseGitDiffModifiedLines(diffOut) }
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
    .with({ _tag: "Failure" }, ({ failure }) =>
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
    .with({ _tag: "Success" }, ({ success: rawBackup }) => {
      const decodedBackupOpt = Schema.decodeOption(BackupSchema)(rawBackup)
      return match(decodedBackupOpt)
        .with({ _tag: "Some" }, ({ value: decoded }) => {
          const content = decoded.content ?? decoded.originalSource
          if (decoded.filePath === undefined || content === undefined) {
            return "Backup JSON missing filePath or content"
          }
          const resolvedTarget = resolve(repoRoot, decoded.filePath)
          const relTarget = relative(resolve(repoRoot), resolvedTarget).replace(/\\/g, "/")
          if (
            relTarget.startsWith("..") ||
            relTarget.startsWith("/") ||
            (!relTarget.startsWith("libs/") && !relTarget.startsWith("apps/"))
          ) {
            return `Backup target path '${decoded.filePath}' escapes workspace bounds`
          }
          const currentReadRes = Result.try(() => hostIo.readTextSync(resolvedTarget))
          return match(currentReadRes)
            .with({ _tag: "Failure" }, ({ failure }) =>
              `Failed to read target '${relTarget}': ${failure instanceof Error ? failure.message : String(failure)}`,
            )
            .with({ _tag: "Success" }, ({ success: currentContent }) => {
              const currentSha256 = computeContentSha256(currentContent)
              const originalSha256 = decoded.originalSha256 ?? computeContentSha256(content)
              if (decoded.mutatedSha256 !== undefined && currentSha256 === decoded.mutatedSha256) {
                const writeRes = Result.try(() => {
                  hostIo.writeTextSync(resolvedTarget, content)
                })
                const writeErr = match(writeRes)
                  .with({ _tag: "Success" }, () => undefined)
                  .with({ _tag: "Failure" }, ({ failure }) =>
                    failure instanceof Error ? failure.message : String(failure),
                  )
                  .exhaustive()
                if (writeErr !== undefined) return writeErr
                return unlinkBackupChecked(backupPath, hostIo)
              }
              if (currentSha256 === originalSha256) {
                return unlinkBackupChecked(backupPath, hostIo)
              }
              return `Target '${relTarget}' was modified on disk (sha256=${currentSha256}) and matches neither originalSha256 (${originalSha256}) nor mutatedSha256 (${decoded.mutatedSha256 ?? "none"}); refusing to overwrite user edits. Inspect and remove '${backupPath}' manually.`
            })
            .exhaustive()
        })
        .with({ _tag: "None" }, () => "Backup JSON failed schema decoding")
        .exhaustive()
    })
    .with({ _tag: "Failure" }, ({ failure }) =>
      failure instanceof Error ? failure.message : String(failure),
    )
    .exhaustive()

  if (restoreFailureReason !== undefined) {
    return `[mutation-check] CRITICAL: Failed to restore startup backup '${backupPath}' (${restoreFailureReason}); aborting without deleting backup.`
  }
  return undefined
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
    .with({ _tag: "Failure" }, ({ failure }) =>
      `[mutation-check] Failed to write mutation backup '${backupPath}': ${failure instanceof Error ? failure.message : String(failure)}`,
    )
    .exhaustive()
}
