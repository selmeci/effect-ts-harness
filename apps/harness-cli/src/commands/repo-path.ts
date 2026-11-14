import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

export const isInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const rel = relative(resolve(rootDir), resolve(candidatePath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Resolves the nearest existing ancestor's realpath, rejecting any dangling
 * symlink encountered while walking up non-existent path segments.
 */
export const resolveNearestRealpath = (targetPath: string): string | undefined => {
  let current = resolve(targetPath)
  const suffix: Array<string> = []
  while (!nodeSyncHostIo.existsSync(current)) {
    if (nodeSyncHostIo.isSymbolicLinkSync(current)) {
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    suffix.unshift(basename(current))
    current = parent
  }
  const realRes = Result.try(() => nodeSyncHostIo.realpathSync(current))
  return match(realRes)
    .with({ _tag: "Success" }, ({ success: realBase }) =>
      suffix.length > 0 ? join(realBase, ...suffix) : realBase,
    )
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
}

/**
 * Resolves `targetPath` relative to `repoRoot` and returns its canonical path
 * only when it stays strictly inside the canonical `repoRoot`.
 */
export const resolveRepoPath = (repoRoot: string, targetPath: string): string | undefined => {
  const trimmed = targetPath.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const canonicalRoot = resolveNearestRealpath(repoRoot)
  const canonicalTarget = resolveNearestRealpath(resolve(repoRoot, trimmed))
  if (canonicalRoot === undefined || canonicalTarget === undefined) {
    return undefined
  }
  return isInsideRoot(canonicalRoot, canonicalTarget) ? canonicalTarget : undefined
}
