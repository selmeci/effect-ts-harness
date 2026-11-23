import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Result } from "effect"
import { match } from "ts-pattern"
import { resolveCanonicalRepoRoot } from "@harness/graph/cluster-resolver"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import type { SyncHostIo } from "@harness/service/host-io"

export const buildOmnigraphClusterKillArgs = (
  clusterRootDir: string,
): readonly [string, ReadonlyArray<string>] => {
  const escaped = clusterRootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return ["pkill", ["-f", `omnigraph-server.*--cluster file://${escaped}(\\s|$)`]]
}

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
export const resolveRepoPathChecked = (repoRoot: string, userPath: string): RepoPathResolution => {
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

const walkUpForPnpmWorkspace = (startDir: string): string | undefined => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (nodeSyncHostIo.existsSync(join(curr, "pnpm-workspace.yaml"))) return curr
    curr = dirname(curr)
  }
  return undefined
}

export const CLI_REPO_ROOT =
  walkUpForPnpmWorkspace(dirname(fileURLToPath(import.meta.url))) ?? process.cwd()

export const shouldSuppressLiveRepoTestSideEffects = (
  targetRepoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  (env["HARNESS_DISABLE_LIVE_TELEMETRY"] === "1" ||
    env["HARNESS_TEST_ISOLATION"] === "1" ||
    env["VITEST"] === "true" ||
    env["NODE_ENV"] === "test") &&
  (env["HARNESS_STATE_DIR"] === undefined || env["HARNESS_STATE_DIR"].trim() === "") &&
  isInsideRoot(CLI_REPO_ROOT, targetRepoRoot)

export const findWorkspaceRoot = (startDir: string = process.cwd()): string =>
  walkUpForPnpmWorkspace(startDir) ?? CLI_REPO_ROOT

export const resolveClusterRepoRoot = (repoRoot: string): string =>
  nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
    ? repoRoot
    : (walkUpForPnpmWorkspace(repoRoot) ?? resolve(repoRoot))

export const isIsolatedExternalWorkspace = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean => {
  if (hostIo.existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))) {
    return false
  }
  const explicitEnvUrl = process.env.OMNIGRAPH_URL?.trim()
  if (explicitEnvUrl && explicitEnvUrl !== "http://127.0.0.1:8080") {
    return false
  }
  return (
    resolveCanonicalRepoRoot(repoRoot, hostIo) !== resolveCanonicalRepoRoot(CLI_REPO_ROOT, hostIo)
  )
}

export type RequiredFlagValue =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "MissingValue" }
  | { readonly _tag: "Value"; readonly value: string }

export const extractRequiredFlagValue = (
  subArgs: ReadonlyArray<string>,
  flagName: string,
): RequiredFlagValue => {
  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i]
    if (arg === flagName) {
      if (i + 1 >= subArgs.length) {
        return { _tag: "MissingValue" }
      }
      const next = subArgs[i + 1]
      if (next === undefined || next.trim().length === 0 || next.startsWith("--")) {
        return { _tag: "MissingValue" }
      }
      return { _tag: "Value", value: next }
    }
    if (arg !== undefined && arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(flagName.length + 1)
      if (value.trim().length === 0) {
        return { _tag: "MissingValue" }
      }
      return { _tag: "Value", value }
    }
  }
  return { _tag: "Absent" }
}

export const extractFlag = (
  subArgs: ReadonlyArray<string>,
  flagName: string,
): string | undefined => {
  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i]
    if (arg === flagName && i + 1 < subArgs.length) {
      return subArgs[i + 1]
    }
    if (arg !== undefined && arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
  }
  return undefined
}

export const resolveRepoPathOrMessage = (
  repoRoot: string,
  userPath: string,
  label: string,
):
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly message: string } =>
  match(resolveRepoPathChecked(repoRoot, userPath))
    .with({ _tag: "Resolved" }, ({ resolvedPath }) => ({ ok: true as const, resolvedPath }))
    .with({ _tag: "EscapesRoot" }, () => ({
      ok: false as const,
      message: `${label} '${userPath}' escapes repository root`,
    }))
    .with({ _tag: "IoError" }, ({ code, message }) => ({
      ok: false as const,
      message: `Cannot resolve ${label} '${userPath}' (${code}: ${message})`,
    }))
    .exhaustive()
