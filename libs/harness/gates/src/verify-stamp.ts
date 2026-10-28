import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Option, Schema } from "effect"
import { resolveHarnessStateDir } from "./worktree.js"

export const VerifyStampSchema = Schema.Struct({
  treeHash: Schema.String,
  timestamp: Schema.String,
  taskBranch: Schema.String
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
  ".remember"
])

const collectFiles = (
  dir: string,
  baseDir: string,
  acc: Array<string>,
  harnessStateDir: string
): void => {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue
    }
    const fullPath = join(dir, entry.name)
    if (fullPath === harnessStateDir || fullPath.startsWith(harnessStateDir + "/")) {
      continue
    }
    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, acc, harnessStateDir)
    } else if (entry.isFile()) {
      const rel = relative(baseDir, fullPath).replace(/\\/g, "/")
      acc.push(rel)
    }
  }
}

export const computeWorkspaceTreeHash = (repoRoot: string): string => {
  const files: Array<string> = []
  const harnessStateDir = resolveHarnessStateDir(repoRoot)
  collectFiles(repoRoot, repoRoot, files, harnessStateDir)
  files.sort()
  const hasher = createHash("sha256")
  for (const rel of files) {
    const content = readFileSync(join(repoRoot, rel))
    hasher.update(rel)
    hasher.update("\0")
    hasher.update(content)
  }
  return hasher.digest("hex")
}

export const writeVerifyStamp = (
  repoRoot: string,
  taskBranch?: string
): VerifyStamp => {
  const treeHash = computeWorkspaceTreeHash(repoRoot)
  const stamp: VerifyStamp = {
    treeHash,
    timestamp: new Date().toISOString(),
    taskBranch: taskBranch ?? "current"
  }
  const harnessDir = resolveHarnessStateDir(repoRoot)
  if (!existsSync(harnessDir)) {
    mkdirSync(harnessDir, { recursive: true })
  }
  const stampPath = join(harnessDir, "verify-stamp.json")
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n", "utf-8")
  return stamp
}

const decodeVerifyStamp = Schema.decodeOption(
  Schema.fromJsonString(VerifyStampSchema)
)

export const checkVerifyStamp = (repoRoot: string): CheckVerifyStampResult => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const stampPath = join(harnessDir, "verify-stamp.json")
  if (!existsSync(stampPath)) {
    return {
      valid: false,
      reason:
        "Missing .harness/verify-stamp.json. Run harness verify after your latest edits before finishing."
    }
  }

  const content = readFileSync(stampPath, "utf-8")
  const decoded = decodeVerifyStamp(content)
  if (Option.isNone(decoded)) {
    return {
      valid: false,
      reason:
        "Invalid .harness/verify-stamp.json. Run harness verify after your latest edits before finishing."
    }
  }

  const currentTreeHash = computeWorkspaceTreeHash(repoRoot)
  if (decoded.value.treeHash !== currentTreeHash) {
    return {
      valid: false,
      reason:
        "Workspace files changed since last verify. Run harness verify after your latest edits before finishing."
    }
  }

  return {
    valid: true,
    stamp: decoded.value
  }
}
