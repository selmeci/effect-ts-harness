import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as Result from "effect/Result"
import { match } from "ts-pattern"

export interface RealPathWalkOk {
  readonly _tag: "Ok"
  readonly paths: ReadonlyArray<string>
}

export interface RealPathWalkDeny {
  readonly _tag: "Deny"
  readonly reason: string
}

export type RealPathWithAncestorWalkResult = RealPathWalkOk | RealPathWalkDeny

const getErrnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined

const tryRealpath = (targetPath: string) => Result.try(() => realpathSync(targetPath))
const tryLstat = (targetPath: string) => Result.try(() => lstatSync(targetPath))

/**
 * Resolves `filePath` and its canonical realpath in hook fast-paths, walking up
 * to the nearest existing ancestor when leaf paths do not exist yet, and failing
 * closed (`_tag: "Deny"`) on symlink loops or unresolvable ancestors.
 */
const resolveRealPathWithAncestorWalkLite = (filePath: string): RealPathWithAncestorWalkResult => {
  if (filePath.trim() === "") {
    return { _tag: "Ok", paths: [filePath] }
  }
  const directResult: RealPathWithAncestorWalkResult | undefined = match(tryRealpath(filePath))
    .with({ _tag: "Success" }, ({ success }) => ({
      _tag: "Ok" as const,
      paths: success === filePath ? [filePath] : [filePath, success],
    }))
    .with({ _tag: "Failure" }, ({ failure }) => {
      const code = getErrnoCode(failure)
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          _tag: "Deny" as const,
          reason: `guard: failed to resolve path '${filePath}' safely (${code ?? "realpath-error"})`,
        }
      }
      return undefined
    })
    .exhaustive()
  if (directResult !== undefined) {
    return directResult
  }

  const trimmed = filePath.replace(/\/+$/, "") || "/"
  const remaining: Array<string> = []
  let curr = trimmed
  while (true) {
    const ancestorResult: RealPathWithAncestorWalkResult | undefined = match(tryLstat(curr))
      .with({ _tag: "Success" }, () =>
        match(tryRealpath(curr))
          .with({ _tag: "Success" }, ({ success }) => {
            const resolved =
              remaining.length === 0 ? success : join(success, ...remaining.reverse())
            return {
              _tag: "Ok" as const,
              paths: resolved === filePath ? [filePath] : [filePath, resolved],
            }
          })
          .with({ _tag: "Failure" }, ({ failure }) => ({
            _tag: "Deny" as const,
            reason: `guard: unresolvable path or symlink loop for '${filePath}' (${getErrnoCode(failure) ?? "realpath-error"})`,
          }))
          .exhaustive(),
      )
      .with({ _tag: "Failure" }, ({ failure }) => {
        const statCode = getErrnoCode(failure)
        if (statCode !== "ENOENT" && statCode !== "ENOTDIR") {
          return {
            _tag: "Deny" as const,
            reason: `guard: cannot stat ancestor of '${filePath}' (${statCode ?? "lstat-error"})`,
          }
        }
        const parent = dirname(curr)
        if (parent === curr) {
          return {
            _tag: "Deny" as const,
            reason: `guard: no resolvable existing ancestor for '${filePath}'`,
          }
        }
        remaining.push(basename(curr))
        curr = parent
        return undefined
      })
      .exhaustive()
    if (ancestorResult !== undefined) {
      return ancestorResult
    }
  }
}

export { resolveRealPathWithAncestorWalkLite }
