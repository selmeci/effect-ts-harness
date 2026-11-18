import { join } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"

const EXCLUDED_SCAN_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  ".nx",
  ".harness",
  "coverage",
  "repos",
  "build",
  "out",
  ".turbo",
])

export type ScanWorkspaceTsFilesResult =
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Error"; readonly reason: string }

export const isWorkspaceTsSourceFileName = (name: string): boolean =>
  (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts")

const walkDir = (dir: string, hostIo: SyncHostIo, sink: Array<string>): string | undefined => {
  const entriesRes = Result.try({
    try: () => hostIo.readdirSync(dir),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  const entries = match(entriesRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (typeof entries === "string") {
    return `Failed to read directory '${dir}': ${entries}`
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (hostIo.isSymbolicLinkSync(fullPath)) {
      return `Refusing symlink while scanning workspace directory: '${fullPath}'`
    }
    if (entry.isDirectory) {
      if (!EXCLUDED_SCAN_DIRS.has(entry.name)) {
        const subErr = walkDir(fullPath, hostIo, sink)
        if (subErr !== undefined) return subErr
      }
      continue
    }
    if (entry.isFile && isWorkspaceTsSourceFileName(entry.name)) {
      sink.push(fullPath)
    }
  }
  return undefined
}

export const scanWorkspaceTsFilesChecked = (
  dir: string,
  hostIo: SyncHostIo,
): ScanWorkspaceTsFilesResult => {
  if (!hostIo.existsSync(dir)) {
    return { _tag: "Ok", files: [] }
  }
  if (hostIo.isSymbolicLinkSync(dir)) {
    return { _tag: "Error", reason: `Refusing symlinked scan root '${dir}'` }
  }
  const files: Array<string> = []
  const err = walkDir(dir, hostIo, files)
  if (err !== undefined) {
    return { _tag: "Error", reason: err }
  }
  return { _tag: "Ok", files: [...files].sort(compareCodeUnits) }
}
