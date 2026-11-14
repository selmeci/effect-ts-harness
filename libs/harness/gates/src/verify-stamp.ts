import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service"
import { DstSeed } from "./dst-engine.js"
import { resolveHarnessStateDir } from "./worktree.js"

export const DstSeedsRunCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DstSeedsRunCount"),
)
export type DstSeedsRunCount = typeof DstSeedsRunCount.Type

export const VerifyStampSchema = Schema.Struct({
  treeHash: Schema.String,
  timestamp: Schema.String,
  taskBranch: Schema.String,
  dstSeed: Schema.optional(DstSeed),
  dstSeedsRun: Schema.optional(DstSeedsRunCount),
})

export type VerifyStamp = Schema.Schema.Type<typeof VerifyStampSchema>

export type CheckVerifyStampResult =
  | { readonly valid: true; readonly stamp: VerifyStamp }
  | { readonly valid: false; readonly reason: string }

const IGNORED_NAMES = new Set([
  ".git",
  ".harness",
  "node_modules",
  "dist",
  "coverage",
  ".nx",
  ".superpowers",
  "repos",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".alchemy",
  ".vite",
  ".remember",
  ".worktrees",
])

const collectFiles = (
  dir: string,
  baseDir: string,
  acc: Array<string>,
  harnessStateDir: string,
  hostIo: SyncHostIo,
): void => {
  if (!hostIo.existsSync(dir)) return
  const entries = hostIo.readdirSync(dir)
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name) || /^(?:temp-|__temp_)/.test(entry.name)) {
      continue
    }
    const fullPath = join(dir, entry.name)
    if (fullPath === harnessStateDir || fullPath.startsWith(harnessStateDir + "/")) {
      continue
    }
    match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
      .with({ isDirectory: true }, () => {
        collectFiles(fullPath, baseDir, acc, harnessStateDir, hostIo)
      })
      .with({ isDirectory: false, isFile: true }, () => {
        const rel = relative(baseDir, fullPath).replace(/\\/g, "/")
        acc.push(rel)
      })
      .with({ isDirectory: false, isFile: false }, () => {})
      .exhaustive()
  }
}

export const computeWorkspaceTreeHash = (repoRoot: string, hostIo: SyncHostIo): string => {
  const files: Array<string> = []
  const harnessStateDir = resolveHarnessStateDir(repoRoot)
  collectFiles(repoRoot, repoRoot, files, harnessStateDir, hostIo)
  files.sort()
  const hasher = createHash("sha256")
  for (const rel of files) {
    const fullPath = join(repoRoot, rel)
    if (!hostIo.existsSync(fullPath)) continue
    const content = Result.getOrElse(
      Result.try(() => hostIo.readBytesSync(fullPath)),
      () => undefined,
    )
    if (content === undefined) continue
    hasher.update(rel)
    hasher.update("\0")
    hasher.update(content)
  }
  return hasher.digest("hex")
}

const decodeDstSeedSync = Schema.decodeUnknownSync(DstSeed)

export const parseDstSeedEnv = (raw: string | undefined): DstSeed | undefined => {
  if (raw === undefined) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const numericValue = Number(trimmed)
  const candidate: unknown =
    /^\d+$/.test(trimmed) && Number.isSafeInteger(numericValue) ? numericValue : raw
  return decodeDstSeedSync(candidate)
}

export const writeVerifyStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
  taskBranch?: string,
  dstOptions?: { readonly dstSeed?: DstSeed | undefined; readonly dstSeedsRun?: number | undefined },
): VerifyStamp => {
  const treeHash = computeWorkspaceTreeHash(repoRoot, hostIo)
  const envSeed = parseDstSeedEnv(process.env["DST_SEED"])
  const resolvedSeed = dstOptions?.dstSeed ?? envSeed ?? DstSeed.make(0)
  const stamp: VerifyStamp = {
    treeHash,
    timestamp: new Date().toISOString(),
    taskBranch: taskBranch ?? "current",
    dstSeed: resolvedSeed,
    ...(dstOptions?.dstSeedsRun !== undefined
      ? { dstSeedsRun: DstSeedsRunCount.make(Math.max(0, Math.trunc(dstOptions.dstSeedsRun))) }
      : {}),
  }
  const harnessDir = resolveHarnessStateDir(repoRoot)
  if (!hostIo.existsSync(harnessDir)) {
    hostIo.mkdirRecursiveSync(harnessDir)
  }
  const stampPath = join(harnessDir, "verify-stamp.json")
  hostIo.writeTextSync(stampPath, JSON.stringify(stamp, null, 2) + "\n")
  return stamp
}

const decodeVerifyStamp = Schema.decodeOption(Schema.fromJsonString(VerifyStampSchema))

export const checkVerifyStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
): CheckVerifyStampResult => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const stampPath = join(harnessDir, "verify-stamp.json")
  if (!hostIo.existsSync(stampPath)) {
    return {
      valid: false,
      reason:
        "Missing .harness/verify-stamp.json. Run harness verify after your latest edits before finishing.",
    }
  }

  const content = hostIo.readTextSync(stampPath)
  const decoded = decodeVerifyStamp(content)
  return match(decoded)
    .with({ _tag: "None" }, () => ({
      valid: false as const,
      reason:
        "Invalid .harness/verify-stamp.json. Run harness verify after your latest edits before finishing.",
    }))
    .with({ _tag: "Some" }, ({ value: stamp }) => {
      const currentTreeHash = computeWorkspaceTreeHash(repoRoot, hostIo)
      if (stamp.treeHash !== currentTreeHash) {
        return {
          valid: false as const,
          reason:
            "Workspace files changed since last verify. Run harness verify after your latest edits before finishing.",
        }
      }

      return {
        valid: true as const,
        stamp,
      }
    })
    .exhaustive()
}
