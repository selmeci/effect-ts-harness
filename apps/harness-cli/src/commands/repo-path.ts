import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

export const isInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const rel = relative(resolve(rootDir), resolve(candidatePath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export type RepoPathResolution =
  | { readonly _tag: "Resolved"; readonly resolvedPath: string }
  | { readonly _tag: "EscapesRoot"; readonly candidatePath: string }
  | {
      readonly _tag: "IoError"
      readonly candidatePath: string
      readonly code: string
      readonly message: string
    }

const extractErrnoDetails = (err: unknown): { readonly code: string; readonly message: string } => {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "EIO"
  const message = err instanceof Error ? err.message : String(err)
  return { code, message }
}

/**
 * Resolves the nearest existing ancestor's realpath, distinguishing ENOENT/dangling-symlink
 * from OS I/O errors (`ELOOP`, `EACCES`, `ENOTDIR`, etc.).
 */
export const resolveNearestRealpathChecked = (targetPath: string): RepoPathResolution => {
  let current = resolve(targetPath)
  const suffix: Array<string> = []
  while (true) {
    const realRes = Result.try(() => nodeSyncHostIo.realpathSync(current))
    const outcome = match(realRes)
      .with({ _tag: "Success" }, ({ success: realBase }) => ({
        done: true as const,
        result: {
          _tag: "Resolved" as const,
          resolvedPath: suffix.length > 0 ? join(realBase, ...suffix) : realBase,
        },
      }))
      .with({ _tag: "Failure" }, ({ failure }) => {
        const { code, message } = extractErrnoDetails(failure)
        if (code !== "ENOENT") {
          return {
            done: true as const,
            result: { _tag: "IoError" as const, candidatePath: current, code, message },
          }
        }
        if (nodeSyncHostIo.isSymbolicLinkSync(current)) {
          return {
            done: true as const,
            result: { _tag: "EscapesRoot" as const, candidatePath: current },
          }
        }
        const parent = dirname(current)
        if (parent === current) {
          return {
            done: true as const,
            result: { _tag: "EscapesRoot" as const, candidatePath: current },
          }
        }
        suffix.unshift(basename(current))
        current = parent
        return { done: false as const }
      })
      .exhaustive()
    if (outcome.done) {
      return outcome.result
    }
  }
}

/**
 * Resolves `targetPath` relative to `repoRoot` and returns a discriminated union
 * distinguishing `Resolved`, `EscapesRoot`, and `IoError`.
 */
export const resolveRepoPathChecked = (
  repoRoot: string,
  userPath: string,
): RepoPathResolution => {
  const trimmed = userPath.trim()
  if (trimmed.length === 0) {
    return { _tag: "EscapesRoot", candidatePath: repoRoot }
  }
  return match(resolveNearestRealpathChecked(repoRoot))
    .with({ _tag: "EscapesRoot" }, { _tag: "IoError" }, (err) => err)
    .with({ _tag: "Resolved" }, ({ resolvedPath: rootPath }) =>
      match(resolveNearestRealpathChecked(resolve(repoRoot, trimmed)))
        .with({ _tag: "EscapesRoot" }, { _tag: "IoError" }, (err) => err)
        .with({ _tag: "Resolved" }, (targetRes) =>
          isInsideRoot(rootPath, targetRes.resolvedPath)
            ? targetRes
            : ({ _tag: "EscapesRoot", candidatePath: targetRes.resolvedPath } as const),
        )
        .exhaustive(),
    )
    .exhaustive()
}

/**
 * Resolves the nearest existing ancestor's realpath, rejecting any dangling
 * symlink encountered while walking up non-existent path segments.
 */
export const resolveNearestRealpath = (targetPath: string): string | undefined =>
  match(resolveNearestRealpathChecked(targetPath))
    .with({ _tag: "Resolved" }, ({ resolvedPath }) => resolvedPath)
    .with({ _tag: "EscapesRoot" }, { _tag: "IoError" }, () => undefined)
    .exhaustive()

/**
 * Resolves `targetPath` relative to `repoRoot` and returns its canonical path
 * only when it stays strictly inside the canonical `repoRoot`.
 */
export const resolveRepoPath = (repoRoot: string, targetPath: string): string | undefined =>
  match(resolveRepoPathChecked(repoRoot, targetPath))
    .with({ _tag: "Resolved" }, ({ resolvedPath }) => resolvedPath)
    .with({ _tag: "EscapesRoot" }, { _tag: "IoError" }, () => undefined)
    .exhaustive()
