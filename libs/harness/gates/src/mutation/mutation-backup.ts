/**
 * @fileoverview Backup recovery and git-diff line extraction helpers for mutation-check.
 */
import { createHash } from "node:crypto"
import { join, relative, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service/host-io"
import { parseGitDiffModifiedLines } from "./mutant-ast-generator.js"

export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

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
  const isGit = match(revParseRes)
    .with({ _tag: "Success" }, ({ success }) =>
      success.spawnError == null &&
      success.timedOut !== true &&
      success.signal == null &&
      success.exitCode === 0 &&
      success.stdout.trim() === "true",
    )
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (!isGit) return { kind: "not-git" }

  const runGitDiff = (
    args: ReadonlyArray<string>,
  ): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string } => {
    const res = Result.try(() => hostIo.execFileSync("git", args, gitOpts))
    return match(res)
      .with({ _tag: "Success" }, ({ success }) => {
        if (
          success.spawnError != null ||
          success.timedOut === true ||
          success.signal != null ||
          success.exitCode !== 0
        ) {
          const reasons: Array<string> = []
          if (success.spawnError != null) reasons.push(`spawnError=${success.spawnError}`)
          if (success.timedOut === true) reasons.push("timedOut=true")
          if (success.signal != null) reasons.push(`signal=${success.signal}`)
          if (success.exitCode !== 0) reasons.push(`exitCode=${success.exitCode}`)
          if (success.stderr.trim().length > 0) reasons.push(`stderr=${success.stderr.trim()}`)
          return { ok: false as const, reason: `git ${args.join(" ")} failed (${reasons.join(", ")})` }
        }
        return { ok: true as const, stdout: success.stdout }
      })
      .with({ _tag: "Failure" }, ({ failure }) => ({
        ok: false as const,
        reason: `git ${args.join(" ")} threw: ${failure instanceof Error ? failure.message : String(failure)}`,
      }))
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
              const currentSha256 = sha256Hex(currentContent)
              const originalSha256 = decoded.originalSha256 ?? sha256Hex(content)
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
        originalSha256: sha256Hex(originalSource),
        mutatedSha256: sha256Hex(mutatedSource),
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
