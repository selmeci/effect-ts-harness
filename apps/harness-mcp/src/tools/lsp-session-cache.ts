import * as path from "node:path"
import { Cause, Deferred, Effect, Result } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  computeContentSha256,
  DEFAULT_MAX_INTERRUPT_RETRIES,
  isPureInterruptCause,
} from "@harness/contract"
import {
  createTypeScriptProgramSession,
  type OverlayDiagnosticItem,
  type TypeScriptProgramSession,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type {
  ExtendedHostIo,
  SyncHostExecOptions,
  SyncHostExecResult,
  SyncHostReader,
} from "@harness/service/host-io"
import { isPathInsideRoot } from "./mcp-repo-root.js"

export type LspTsgoExecutor = (
  binPath: string,
  cliArgs: ReadonlyArray<string>,
  options?: SyncHostExecOptions,
) => Effect.Effect<SyncHostExecResult>

export interface LspSessionCacheOptions {
  readonly maxEntries?: number | undefined
  readonly maxOverlayEntries?: number | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly sessionFactory?:
    | ((canonicalRoot: string, hostIo: SyncHostReader) => TypeScriptProgramSession)
    | undefined
}

export interface OverlayCacheLookup {
  readonly repoRoot: string
  readonly cacheKey?: string | undefined
  readonly filePath: string
  readonly fileMtimeMs: number | undefined
  readonly contentSha256: string
  readonly projectTsconfigPath?: string | undefined
}

export interface OverlayCacheStore extends OverlayCacheLookup {
  readonly session: TypeScriptProgramSession
  readonly diagnostics: ReadonlyArray<OverlayDiagnosticItem>
}

interface FileSnapshot {
  readonly mtimeMs: number | undefined
  readonly contentSha256: string | undefined
}

interface CachedOverlayDiagnostics {
  readonly fileMtimeMs: number | undefined
  readonly contentSha256: string
  readonly dependencySnapshot: ReadonlyMap<string, FileSnapshot>
  readonly diagnostics: ReadonlyArray<OverlayDiagnosticItem>
}

interface RepoLspCacheEntry {
  readonly canonicalRoot: string
  readonly session: TypeScriptProgramSession
  readonly tsconfigMtimes: Map<string, FileSnapshot | undefined>
  readonly overlayDiagnosticsCache: Map<string, CachedOverlayDiagnostics>
}

type SingleFlightTsgoOutcome =
  | { readonly _tag: "Ok"; readonly proc: SyncHostExecResult }
  | { readonly _tag: "Fail"; readonly message: string }
  | { readonly _tag: "Interrupted" }

export interface LspSessionCache {
  readonly getSession: (repoRoot: string, projectTsconfigPath?: string) => TypeScriptProgramSession
  readonly getTsconfigMtimeKey: (repoRoot: string, projectTsconfigPath?: string) => string
  readonly getCachedOverlayDiagnostics: (
    input: OverlayCacheLookup,
  ) => ReadonlyArray<OverlayDiagnosticItem> | undefined
  readonly setCachedOverlayDiagnostics: (input: OverlayCacheStore) => void
  readonly runSingleFlightTsgo: (
    key: string,
    runEffect: () => Effect.Effect<SyncHostExecResult, string>,
  ) => Effect.Effect<SyncHostExecResult, string>
  readonly getStats: () => {
    readonly sessionCount: number
    readonly inFlightCount: number
    readonly repoRoots: ReadonlyArray<string>
  }
  readonly clear: () => void
}

const DEFAULT_MAX_ENTRIES = 4
const DEFAULT_MAX_OVERLAY_ENTRIES = 64

export const safeStatMtimeMs = (filePath: string, hostIo: ExtendedHostIo): number | undefined =>
  Result.getOrElse(
    Result.try(() => hostIo.statMtimeMsSync(filePath)),
    () => undefined,
  )

export type NearestTsconfigResult =
  | { readonly _tag: "Found"; readonly path: string }
  | { readonly _tag: "Escaped"; readonly path: string }
  | { readonly _tag: "None" }

export const findNearestContainedTsconfig = (
  repoRoot: string,
  resolvedFile: string,
  hostIo: ExtendedHostIo,
): NearestTsconfigResult => {
  const normalizedRepoRoot = path.resolve(repoRoot)
  let curr = path.dirname(resolvedFile)
  while (isPathInsideRoot(normalizedRepoRoot, curr) && curr !== normalizedRepoRoot) {
    const candidate = path.join(curr, "tsconfig.json")
    if (hostIo.existsSync(candidate)) {
      return isPathInsideRoot(normalizedRepoRoot, candidate)
        ? { _tag: "Found", path: candidate }
        : { _tag: "Escaped", path: candidate }
    }
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return { _tag: "None" }
}

export const canonicalizePath = (targetPath: string, hostIo: ExtendedHostIo): string => {
  const resolved = path.resolve(targetPath)
  return hostIo.existsSync(resolved)
    ? Result.getOrElse(
        Result.try(() => hostIo.realpathSync(resolved)),
        () => resolved,
      )
    : resolved
}

export const tryCanonicalizeExistingRoot = (
  targetPath: string,
  hostIo: ExtendedHostIo,
): Result.Result<string, string> => {
  const resolved = path.resolve(targetPath)
  if (!hostIo.existsSync(resolved)) {
    return Result.fail(`Repository root '${targetPath}' does not exist`)
  }
  return Result.try({
    try: () => hostIo.realpathSync(resolved),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
}

export const buildOverlayCacheKey = (
  canonicalRoot: string,
  filePath: string,
  projectTsconfigPath: string | undefined,
  hostIo: ExtendedHostIo,
): string => {
  const resolvedFile = canonicalizePath(
    path.isAbsolute(filePath) ? filePath : path.resolve(canonicalRoot, filePath),
    hostIo,
  )
  const resolvedProject =
    projectTsconfigPath !== undefined && projectTsconfigPath.trim().length > 0
      ? canonicalizePath(
          path.isAbsolute(projectTsconfigPath)
            ? projectTsconfigPath
            : path.resolve(canonicalRoot, projectTsconfigPath),
          hostIo,
        )
      : ""
  return `${resolvedFile}::${resolvedProject}`
}

const readFileSnapshot = (filePath: string, hostIo: ExtendedHostIo): FileSnapshot | undefined => {
  if (!hostIo.existsSync(filePath)) return undefined
  return Result.getOrElse(
    Result.try(() => ({
      mtimeMs: safeStatMtimeMs(filePath, hostIo),
      contentSha256: computeContentSha256(hostIo.readTextSync(filePath)),
    })),
    () => undefined,
  )
}

const snapshotsEqual = (a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean => {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.mtimeMs === b.mtimeMs && a.contentSha256 === b.contentSha256
}

const clearSessionRefs = (session: TypeScriptProgramSession): void => {
  session.oldProgram = undefined
  session.project = undefined
  session.lastWorkspaceSnapshot = undefined
  session.sourceFileCache.clear()
  session.fileFragmentCache.clear()
  session.reverseImportsByFile.clear()
}

const collectTsconfigPaths = (
  canonicalRoot: string,
  hostIo: ExtendedHostIo,
  projectTsconfigPath?: string,
  existingTracked?: ReadonlyMap<string, FileSnapshot | undefined>,
): ReadonlyArray<string> => {
  const paths = new Set<string>()
  const addIfContained = (candidate: string): void => {
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(canonicalRoot, candidate)
    const canonical = canonicalizePath(resolved, hostIo)
    if (isPathInsideRoot(canonicalRoot, canonical)) {
      paths.add(canonical)
    }
  }
  addIfContained(path.join(canonicalRoot, "tsconfig.base.json"))
  addIfContained(path.join(canonicalRoot, "tsconfig.json"))
  if (projectTsconfigPath !== undefined && projectTsconfigPath.trim().length > 0) {
    addIfContained(projectTsconfigPath)
  }
  if (existingTracked !== undefined) {
    for (const tracked of existingTracked.keys()) {
      if (isPathInsideRoot(canonicalRoot, tracked)) {
        paths.add(tracked)
      }
    }
  }
  return [...paths].sort(compareCodeUnits)
}

export const createLspSessionCache = (options?: LspSessionCacheOptions): LspSessionCache => {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const maxOverlayEntries = Math.max(1, options?.maxOverlayEntries ?? DEFAULT_MAX_OVERLAY_ENTRIES)
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const sessionFactory = options?.sessionFactory ?? createTypeScriptProgramSession
  const sessions = new Map<string, RepoLspCacheEntry>()
  const inFlightRuns = new Map<string, Deferred.Deferred<SingleFlightTsgoOutcome>>()
  const evictEntry = (entry: RepoLspCacheEntry): void => {
    clearSessionRefs(entry.session)
    entry.overlayDiagnosticsCache.clear()
    sessions.delete(entry.canonicalRoot)
  }
  const dropSourceCache = (
    session: TypeScriptProgramSession,
    canonicalRoot: string,
    filePath: string,
  ): void => {
    const canonicalFile = canonicalizePath(filePath, hostIo)
    for (const candidate of [filePath, canonicalFile]) {
      session.sourceFileCache.delete(candidate)
      session.sourceFileCache.delete(path.relative(canonicalRoot, candidate).replace(/\\/g, "/"))
    }
  }
  const getOrCreateEntry = (repoRoot: string, projectTsconfigPath?: string): RepoLspCacheEntry => {
    const canonicalRoot = canonicalizePath(repoRoot, hostIo)
    const existing = sessions.get(canonicalRoot)
    const tsconfigPaths = collectTsconfigPaths(
      canonicalRoot,
      hostIo,
      projectTsconfigPath,
      existing?.tsconfigMtimes,
    )
    if (existing !== undefined) {
      const changed = tsconfigPaths.some((p) => {
        const currentSnapshot = readFileSnapshot(p, hostIo)
        if (existing.tsconfigMtimes.has(p)) {
          return !snapshotsEqual(currentSnapshot, existing.tsconfigMtimes.get(p))
        }
        return currentSnapshot !== undefined
      })
      if (!changed) {
        for (const p of tsconfigPaths) {
          if (!existing.tsconfigMtimes.has(p)) {
            existing.tsconfigMtimes.set(p, readFileSnapshot(p, hostIo))
          }
        }
        sessions.delete(canonicalRoot)
        sessions.set(canonicalRoot, existing)
        return existing
      }
      evictEntry(existing)
    }
    const tsconfigMtimes = new Map<string, FileSnapshot | undefined>()
    for (const p of tsconfigPaths) tsconfigMtimes.set(p, readFileSnapshot(p, hostIo))
    const created: RepoLspCacheEntry = {
      canonicalRoot,
      session: sessionFactory(canonicalRoot, hostIo),
      tsconfigMtimes,
      overlayDiagnosticsCache: new Map(),
    }
    sessions.set(canonicalRoot, created)
    while (sessions.size > maxEntries) {
      const oldestKey = sessions.keys().next().value
      if (oldestKey === undefined) break
      const oldest = sessions.get(oldestKey)
      if (oldest !== undefined) evictEntry(oldest)
      else sessions.delete(oldestKey)
    }
    return created
  }
  const runSingleFlightInternal = (
    key: string,
    runEffect: () => Effect.Effect<SyncHostExecResult, string>,
    remainingInterruptRetries: number,
  ): Effect.Effect<SyncHostExecResult, string> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const existing = inFlightRuns.get(key)
        if (existing !== undefined) {
          return yield* match(yield* restore(Deferred.await(existing)))
            .with({ _tag: "Ok" }, ({ proc }) => Effect.succeed(proc))
            .with({ _tag: "Fail" }, ({ message }) => Effect.fail(message))
            .with({ _tag: "Interrupted" }, () =>
              remainingInterruptRetries > 0
                ? restore(runSingleFlightInternal(key, runEffect, remainingInterruptRetries - 1))
                : Effect.fail("effect-tsgo execution was interrupted"),
            )
            .exhaustive()
        }
        const deferred = Deferred.makeUnsafe<SingleFlightTsgoOutcome>()
        inFlightRuns.set(key, deferred)
        return yield* restore(Effect.suspend(runEffect)).pipe(
          Effect.onExit((runExit) =>
            Effect.gen(function* () {
              if (inFlightRuns.get(key) === deferred) inFlightRuns.delete(key)
              const outcome: SingleFlightTsgoOutcome = match(runExit)
                .with({ _tag: "Success" }, ({ value }) => ({ _tag: "Ok" as const, proc: value }))
                .with({ _tag: "Failure" }, ({ cause }) => {
                  if (isPureInterruptCause(cause)) {
                    return { _tag: "Interrupted" as const }
                  }
                  const squashed = Cause.squash(cause)
                  return {
                    _tag: "Fail" as const,
                    message: squashed instanceof Error ? squashed.message : String(squashed),
                  }
                })
                .exhaustive()
              yield* Deferred.succeed(deferred, outcome)
            }),
          ),
        )
      }),
    )
  return {
    getSession: (repoRoot, projectTsconfigPath) =>
      getOrCreateEntry(repoRoot, projectTsconfigPath).session,
    getTsconfigMtimeKey: (repoRoot, projectTsconfigPath) => {
      const canonicalRoot = canonicalizePath(repoRoot, hostIo)
      const paths = collectTsconfigPaths(
        canonicalRoot,
        hostIo,
        projectTsconfigPath,
        sessions.get(canonicalRoot)?.tsconfigMtimes,
      )
      return JSON.stringify(
        paths.map((p) => {
          const snap = readFileSnapshot(p, hostIo)
          return [p, snap?.mtimeMs ?? null, snap?.contentSha256 ?? null]
        }),
      )
    },
    getCachedOverlayDiagnostics: (input) => {
      const entry = getOrCreateEntry(input.repoRoot, input.projectTsconfigPath)
      const cacheKey = buildOverlayCacheKey(
        entry.canonicalRoot,
        input.filePath,
        input.projectTsconfigPath,
        hostIo,
      )
      const cached = entry.overlayDiagnosticsCache.get(cacheKey)
      if (cached === undefined) return undefined
      if (
        cached.fileMtimeMs === undefined ||
        input.fileMtimeMs === undefined ||
        cached.fileMtimeMs !== input.fileMtimeMs ||
        cached.contentSha256 !== input.contentSha256
      ) {
        entry.overlayDiagnosticsCache.delete(cacheKey)
        dropSourceCache(entry.session, entry.canonicalRoot, input.filePath)
        return undefined
      }
      for (const [depPath, prevSnap] of cached.dependencySnapshot) {
        const currSnap = readFileSnapshot(depPath, hostIo)
        if (currSnap === undefined || !snapshotsEqual(currSnap, prevSnap)) {
          entry.overlayDiagnosticsCache.delete(cacheKey)
          dropSourceCache(entry.session, entry.canonicalRoot, input.filePath)
          dropSourceCache(entry.session, entry.canonicalRoot, depPath)
          return undefined
        }
      }
      entry.overlayDiagnosticsCache.delete(cacheKey)
      entry.overlayDiagnosticsCache.set(cacheKey, cached)
      return cached.diagnostics
    },
    setCachedOverlayDiagnostics: (input) => {
      const entry = getOrCreateEntry(input.repoRoot, input.projectTsconfigPath)
      if (entry.session !== input.session) return
      const cacheKey = buildOverlayCacheKey(
        entry.canonicalRoot,
        input.filePath,
        input.projectTsconfigPath,
        hostIo,
      )
      if (input.diagnostics.some((d) => d.code === "TS2307" || d.code === "TS2792")) {
        entry.overlayDiagnosticsCache.delete(cacheKey)
        return
      }
      const dependencySnapshot = new Map<string, FileSnapshot>()
      for (const sf of input.session.oldProgram?.getSourceFiles() ?? []) {
        const rawSfPath = path.resolve(sf.fileName)
        const canonicalSfPath = canonicalizePath(rawSfPath, hostIo)
        const norm = canonicalSfPath.replace(/\\/g, "/")
        if (
          isPathInsideRoot(entry.canonicalRoot, canonicalSfPath) &&
          !norm.includes("/node_modules/") &&
          !norm.includes("/typescript/lib/") &&
          !norm.includes("/.harness/__virtual_types__/")
        ) {
          const isSymlink = Result.getOrElse(
            Result.try(
              () =>
                hostIo.isSymbolicLinkSync(rawSfPath) || hostIo.isSymbolicLinkSync(canonicalSfPath),
            ),
            () => true,
          )
          if (isSymlink) continue
          const snap = readFileSnapshot(canonicalSfPath, hostIo)
          if (snap !== undefined) {
            dependencySnapshot.set(canonicalSfPath, snap)
          }
        }
      }
      entry.overlayDiagnosticsCache.delete(cacheKey)
      entry.overlayDiagnosticsCache.set(cacheKey, {
        fileMtimeMs: input.fileMtimeMs,
        contentSha256: input.contentSha256,
        dependencySnapshot,
        diagnostics: input.diagnostics,
      })
      while (entry.overlayDiagnosticsCache.size > maxOverlayEntries) {
        const oldestKey = entry.overlayDiagnosticsCache.keys().next().value
        if (oldestKey === undefined) break
        entry.overlayDiagnosticsCache.delete(oldestKey)
      }
    },
    runSingleFlightTsgo: (key, runEffect) =>
      runSingleFlightInternal(key, runEffect, DEFAULT_MAX_INTERRUPT_RETRIES),
    getStats: () => ({
      sessionCount: sessions.size,
      inFlightCount: inFlightRuns.size,
      repoRoots: [...sessions.keys()],
    }),
    clear: () => {
      for (const entry of sessions.values()) evictEntry(entry)
      inFlightRuns.clear()
    },
  }
}
