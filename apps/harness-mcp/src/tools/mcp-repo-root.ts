import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { AbsoluteRepoRoot, type WorkflowStoreUnavailableError } from "@harness/contract"
import { isRelativeEscape, resolveCanonicalRepoRoot } from "@harness/graph"
import { nodeSyncHostIo, validateWorktreeRepoRoot } from "@harness/infra"

export class ProjectPathEscapeError extends Schema.TaggedError<ProjectPathEscapeError>()(
  "ProjectPathEscapeError",
  {
    projectPath: Schema.String,
    repoRoot: Schema.String,
    message: Schema.String,
  },
) {}

export interface RepoRootResolutionOptions {
  readonly repoRoot?: string | undefined
  readonly skipActiveWorkspaceLookup?: boolean | undefined
  readonly skipOmnigraphSpawn?: boolean | undefined
  readonly cwd?: string | undefined
}

export const findRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (nodeSyncHostIo.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

export const hasWorkspaceMarker = (dir: string): boolean =>
  nodeSyncHostIo.existsSync(path.join(dir, "pnpm-workspace.yaml"))

export const hasValidWorkspaceRootMarker = (dir: string): boolean => {
  if (dir.trim().length === 0) return false
  return Result.getOrElse(
    Result.try(
      () =>
        nodeSyncHostIo.existsSync(dir) &&
        nodeSyncHostIo.isDirectorySync(dir) &&
        hasWorkspaceMarker(dir) &&
        nodeSyncHostIo.existsSync(path.join(dir, ".git")),
    ),
    () => false,
  )
}

export const SERVER_REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

const CANONICAL_SERVER_REPO_ROOT = nodeSyncHostIo.existsSync(SERVER_REPO_ROOT)
  ? resolveCanonicalRepoRoot(SERVER_REPO_ROOT, nodeSyncHostIo)
  : SERVER_REPO_ROOT

export const isPathInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const logicalRoot = path.resolve(rootDir)
  if (!nodeSyncHostIo.existsSync(logicalRoot)) {
    return false
  }
  const logicalCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(logicalRoot, candidatePath)
  const rel = path.relative(logicalRoot, logicalCandidate)
  if (rel !== "" && isRelativeEscape(rel)) {
    return false
  }
  let checkPath = logicalCandidate
  while (!nodeSyncHostIo.existsSync(checkPath)) {
    const isSymlink = Result.getOrElse(
      Result.try(() => nodeSyncHostIo.isSymbolicLinkSync(checkPath)),
      () => false,
    )
    if (isSymlink) {
      return false
    }
    if (checkPath === logicalRoot) {
      break
    }
    const parent = path.dirname(checkPath)
    if (parent === checkPath) break
    checkPath = parent
  }
  if (nodeSyncHostIo.existsSync(checkPath)) {
    const checkRel = path.relative(logicalRoot, checkPath)
    if (!isRelativeEscape(checkRel)) {
      const contained = Result.getOrElse(
        Result.try(() => {
          const realRoot = nodeSyncHostIo.realpathSync(logicalRoot)
          const realCheck = nodeSyncHostIo.realpathSync(checkPath)
          const realRel = path.relative(realRoot, realCheck)
          return !(realRel !== "" && isRelativeEscape(realRel))
        }),
        () => false,
      )
      if (!contained) return false
    }
  }
  return true
}

/**
 * Returns true when any directory between `candidateRoot` (inclusive) and
 * `boundaryRoot` (exclusive) contains `.git` or `pnpm-workspace.yaml`.
 */
export const hasIntermediateRepoBoundary = (
  boundaryRoot: string,
  candidateRoot: string,
): boolean => {
  const resolvedBoundary = path.resolve(boundaryRoot)
  let curr = path.resolve(candidateRoot)
  const rel = path.relative(resolvedBoundary, curr)
  if (rel === "" || isRelativeEscape(rel)) {
    return false
  }
  while (curr !== resolvedBoundary) {
    if (
      nodeSyncHostIo.existsSync(path.join(curr, ".git")) ||
      nodeSyncHostIo.existsSync(path.join(curr, "pnpm-workspace.yaml"))
    ) {
      return true
    }
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return false
}

const decodeActiveWorkspace = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      repoRoot: Schema.String,
      updatedAt: Schema.optional(Schema.String),
    }),
  ),
)

const warnActiveWorkspace = (msg: string): undefined => {
  process.stderr.write(`[harness-mcp] Warning: ${msg}\n`)
  return undefined
}

const readActiveWorkspaceCandidate = (
  activeWorkspacePath: string,
): { readonly repoRoot: string; readonly updatedAtMs: number } | undefined => {
  if (!nodeSyncHostIo.existsSync(activeWorkspacePath)) return undefined
  return match(Result.try(() => nodeSyncHostIo.readTextSync(activeWorkspacePath)))
    .with({ _tag: "Failure" }, ({ failure }) =>
      warnActiveWorkspace(
        `failed to read ${activeWorkspacePath}: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
    )
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeActiveWorkspace(raw))
        .with({ _tag: "None" }, () =>
          warnActiveWorkspace(`failed to decode ${activeWorkspacePath} as active-workspace.json`),
        )
        .with({ _tag: "Some" }, ({ value: parsed }) =>
          match(
            Result.try(
              () =>
                nodeSyncHostIo.existsSync(parsed.repoRoot) &&
                nodeSyncHostIo.isDirectorySync(parsed.repoRoot) &&
                hasWorkspaceMarker(parsed.repoRoot),
            ),
          )
            .with({ _tag: "Success" }, ({ success }) => {
              if (!success) return undefined
              const parsedTime = parsed.updatedAt !== undefined ? Date.parse(parsed.updatedAt) : 0
              return {
                repoRoot: parsed.repoRoot,
                updatedAtMs: Number.isFinite(parsedTime) ? parsedTime : 0,
              }
            })
            .with({ _tag: "Failure" }, ({ failure }) =>
              warnActiveWorkspace(
                `failed to verify active workspace '${parsed.repoRoot}': ${failure instanceof Error ? failure.message : String(failure)}`,
              ),
            )
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
}

export const resolveDefaultRepoRoot = (
  args?: Readonly<Record<string, unknown>>,
  options?: Pick<
    RepoRootResolutionOptions,
    "skipActiveWorkspaceLookup" | "skipOmnigraphSpawn" | "cwd"
  >,
): string => {
  const rawRepoRoot = args?.["repoRoot"]
  if (typeof rawRepoRoot === "string" && rawRepoRoot.trim().length > 0) {
    const candidateRoot = findRepoRoot(rawRepoRoot)
    if (
      nodeSyncHostIo.existsSync(candidateRoot) &&
      nodeSyncHostIo.isDirectorySync(candidateRoot) &&
      hasWorkspaceMarker(candidateRoot)
    ) {
      return candidateRoot
    }
  }
  const rawFile = args?.["file"]
  const rawFilePath = args?.["filePath"]
  const rawPaths = args?.["paths"]
  const rawFileCandidate =
    typeof rawFile === "string"
      ? rawFile
      : typeof rawFilePath === "string"
        ? rawFilePath
        : Array.isArray(rawPaths) && typeof rawPaths[0] === "string"
          ? rawPaths[0]
          : undefined
  const rawProject = args?.["project"]
  const candidate =
    typeof rawFileCandidate === "string" && path.isAbsolute(rawFileCandidate)
      ? rawFileCandidate
      : typeof rawProject === "string" && path.isAbsolute(rawProject)
        ? rawProject
        : undefined
  if (candidate !== undefined) {
    const candidateRoot = findRepoRoot(path.dirname(candidate))
    if (hasWorkspaceMarker(candidateRoot)) return candidateRoot
  }
  const cwdRoot = findRepoRoot(options?.cwd ?? process.cwd())
  if (
    cwdRoot !== SERVER_REPO_ROOT &&
    nodeSyncHostIo.existsSync(cwdRoot) &&
    nodeSyncHostIo.isDirectorySync(cwdRoot) &&
    hasWorkspaceMarker(cwdRoot)
  ) {
    return cwdRoot
  }
  if (options?.skipActiveWorkspaceLookup !== true && options?.skipOmnigraphSpawn !== true) {
    const candidatePaths = [path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")]
    if (nodeSyncHostIo.existsSync(SERVER_REPO_ROOT)) {
      const canonicalRoot = resolveCanonicalRepoRoot(SERVER_REPO_ROOT, nodeSyncHostIo)
      if (canonicalRoot !== SERVER_REPO_ROOT) {
        candidatePaths.push(path.join(canonicalRoot, ".harness", "active-workspace.json"))
      }
    }
    let best: { readonly repoRoot: string; readonly updatedAtMs: number } | undefined
    for (const activeWorkspacePath of candidatePaths) {
      const entry = readActiveWorkspaceCandidate(activeWorkspacePath)
      if (entry !== undefined && (best === undefined || entry.updatedAtMs > best.updatedAtMs)) {
        best = entry
      }
    }
    if (best !== undefined) return best.repoRoot
  }
  if (hasValidWorkspaceRootMarker(SERVER_REPO_ROOT) || hasWorkspaceMarker(SERVER_REPO_ROOT)) {
    return SERVER_REPO_ROOT
  }
  const canonicalRoot = nodeSyncHostIo.existsSync(SERVER_REPO_ROOT)
    ? resolveCanonicalRepoRoot(SERVER_REPO_ROOT, nodeSyncHostIo)
    : CANONICAL_SERVER_REPO_ROOT
  if (hasValidWorkspaceRootMarker(canonicalRoot) || hasWorkspaceMarker(canonicalRoot)) {
    return canonicalRoot
  }
  if (
    hasValidWorkspaceRootMarker(CANONICAL_SERVER_REPO_ROOT) ||
    hasWorkspaceMarker(CANONICAL_SERVER_REPO_ROOT)
  ) {
    return CANONICAL_SERVER_REPO_ROOT
  }
  return SERVER_REPO_ROOT
}

export const resolveDaemonStartupRepoRoot = (cwd: string = process.cwd()): string => {
  const cwdRoot = findRepoRoot(cwd)
  if (hasValidWorkspaceRootMarker(cwdRoot)) {
    return cwdRoot
  }
  const defaultRoot = resolveDefaultRepoRoot(undefined, { cwd })
  if (hasValidWorkspaceRootMarker(defaultRoot)) {
    return defaultRoot
  }
  if (hasValidWorkspaceRootMarker(SERVER_REPO_ROOT)) {
    return SERVER_REPO_ROOT
  }
  const canonicalRoot = nodeSyncHostIo.existsSync(SERVER_REPO_ROOT)
    ? resolveCanonicalRepoRoot(SERVER_REPO_ROOT, nodeSyncHostIo)
    : CANONICAL_SERVER_REPO_ROOT
  if (hasValidWorkspaceRootMarker(canonicalRoot)) {
    return canonicalRoot
  }
  if (hasValidWorkspaceRootMarker(CANONICAL_SERVER_REPO_ROOT)) {
    return CANONICAL_SERVER_REPO_ROOT
  }
  return hasWorkspaceMarker(SERVER_REPO_ROOT) ? SERVER_REPO_ROOT : defaultRoot
}

const decodeAbsoluteRepoRoot = Schema.decodeUnknownEffect(AbsoluteRepoRoot)

const makeRepoRootEscapeError = (projectPath: string, repoRoot: string): ProjectPathEscapeError =>
  new ProjectPathEscapeError({
    projectPath,
    repoRoot,
    message: "repoRoot escapes configured workspace root",
  })

const NON_WORKTREE_REASON_PATTERN =
  /not a git|not an active(?:\s+registered)? git worktree|unable to resolve shared git common directory|does not exist|not a directory|symlink|invalid|not found|ENOENT|ENOTDIR/i

const mapWorktreeValidationError =
  (rawRepoRoot: string, boundaryRoot: string) =>
  (err: WorkflowStoreUnavailableError): ProjectPathEscapeError | WorkflowStoreUnavailableError =>
    NON_WORKTREE_REASON_PATTERN.test(err.reason)
      ? makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
      : err

const hasGitEntry = (dir: string): boolean =>
  Result.getOrElse(
    Result.try(
      () =>
        nodeSyncHostIo.existsSync(dir) &&
        nodeSyncHostIo.isDirectorySync(dir) &&
        nodeSyncHostIo.existsSync(path.join(dir, ".git")),
    ),
    () => false,
  )

const resolveIfExistingCanonical = (dir: string): string =>
  nodeSyncHostIo.existsSync(dir) ? resolveCanonicalRepoRoot(dir, nodeSyncHostIo) : dir

const pickAnchorRoot = (boundaryRoot: string, options?: RepoRootResolutionOptions): string => {
  if (options?.repoRoot !== undefined) {
    return options.repoRoot
  }
  const canonicalServerRoot = resolveIfExistingCanonical(SERVER_REPO_ROOT)
  const effectiveCwd = options?.cwd ?? process.cwd()
  const boundaryWorkspace = findRepoRoot(boundaryRoot)
  const cwdWorkspace = findRepoRoot(effectiveCwd)
  const candidates = [
    resolveIfExistingCanonical(boundaryRoot),
    boundaryRoot,
    resolveIfExistingCanonical(boundaryWorkspace),
    boundaryWorkspace,
    resolveIfExistingCanonical(effectiveCwd),
    effectiveCwd,
    resolveIfExistingCanonical(cwdWorkspace),
    cwdWorkspace,
    canonicalServerRoot,
    SERVER_REPO_ROOT,
    CANONICAL_SERVER_REPO_ROOT,
  ]
  for (const candidate of candidates) {
    if (hasValidWorkspaceRootMarker(candidate) || hasGitEntry(candidate)) {
      return candidate
    }
  }
  return boundaryRoot
}

export const resolveContainedRepoRoot = Effect.fn("HarnessMcp.resolveContainedRepoRoot")(function* (
  rawRepoRoot: string | undefined,
  options?: RepoRootResolutionOptions,
): Effect.fn.Return<string, ProjectPathEscapeError | WorkflowStoreUnavailableError> {
  const boundaryRoot = options?.repoRoot ?? resolveDefaultRepoRoot(undefined, options)
  if (rawRepoRoot === undefined) {
    return boundaryRoot
  }
  if (rawRepoRoot.includes("\0")) {
    return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
  }
  const trimmed = rawRepoRoot.trim()
  if (trimmed.length === 0) {
    return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
  }
  const resolvedBoundary = path.resolve(boundaryRoot)
  const resolvedCandidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedBoundary, trimmed)
  const isLeafSymlink = match(
    Result.try(() => nodeSyncHostIo.isSymbolicLinkSync(resolvedCandidate)),
  )
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (options?.repoRoot !== undefined && resolvedCandidate === resolvedBoundary) {
    if (
      isLeafSymlink ||
      (nodeSyncHostIo.existsSync(resolvedCandidate) &&
        !nodeSyncHostIo.isDirectorySync(resolvedCandidate))
    ) {
      return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
    }
    return resolvedBoundary
  }
  if (isPathInsideRoot(boundaryRoot, trimmed)) {
    if (
      nodeSyncHostIo.existsSync(resolvedCandidate) &&
      !nodeSyncHostIo.isDirectorySync(resolvedCandidate)
    ) {
      return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
    }
    return resolvedCandidate
  }
  if (!path.isAbsolute(trimmed)) {
    return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
  }
  if (isLeafSymlink) {
    return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
  }
  const candidateAbs = yield* decodeAbsoluteRepoRoot(resolvedCandidate).pipe(
    Effect.mapError(() => makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)),
  )
  const candidateValidated = yield* validateWorktreeRepoRoot(candidateAbs).pipe(
    Effect.mapError(mapWorktreeValidationError(rawRepoRoot, boundaryRoot)),
  )
  const anchorRoot = pickAnchorRoot(boundaryRoot, options)
  const boundaryAbs = yield* decodeAbsoluteRepoRoot(path.resolve(anchorRoot)).pipe(
    Effect.mapError(() => makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)),
  )
  const boundaryValidated = yield* validateWorktreeRepoRoot(boundaryAbs).pipe(
    Effect.mapError(mapWorktreeValidationError(rawRepoRoot, boundaryRoot)),
  )
  if (candidateValidated.commonGitDir === boundaryValidated.commonGitDir) {
    return candidateValidated.worktreeRoot
  }
  return yield* makeRepoRootEscapeError(rawRepoRoot, boundaryRoot)
})
