import * as path from "node:path"
import { Effect, Option, Result, Schema, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  toBoundedReason,
  toErrorReasonMessage,
  type ValidatedWorktreeRoot,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import { nodeSyncHostIo, validateWorktreeRepoRoot } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"

const DEFAULT_LINKED_WORKTREE_CACHE_LIMIT = 32
const WORKTREE_SCOPE_OPERATION = WorkflowStoreOperation.make("WorkflowDaemonHelper.resolveWorktree")

export type WorktreeValidatorFn = (
  repoRoot: AbsoluteRepoRoot,
) => Effect.Effect<ValidatedWorktreeRoot, WorkflowStoreUnavailableError>

export type StartupWorktreeState =
  | { readonly _tag: "Valid"; readonly worktree: ValidatedWorktreeRoot }
  | { readonly _tag: "NonGit" }
  | { readonly _tag: "InvalidGit"; readonly reason: string }

export interface DaemonWorktreeScopeCacheStats {
  readonly cachedLinkedCount: number
  readonly cacheHits: number
  readonly cacheMisses: number
}

export interface DaemonRequestScopeAllowed {
  readonly _tag: "Allowed"
  readonly resolvedRoot: string
  readonly validatedWorktree: ValidatedWorktreeRoot | undefined
  readonly daemonWorktree: ValidatedWorktreeRoot | undefined
  readonly cacheHit?: boolean | undefined
}

export interface DaemonRequestScopeRejected {
  readonly _tag: "Rejected"
  readonly error: string
}

export type DaemonRequestScopeResult = DaemonRequestScopeAllowed | DaemonRequestScopeRejected

export interface DaemonWorktreeScopeCache {
  readonly baseRoot: string
  readonly startupState: StartupWorktreeState
  readonly resolveRequestScope: (
    requestedRepoRoot?: string,
  ) => Effect.Effect<DaemonRequestScopeResult>
  readonly getStats: () => DaemonWorktreeScopeCacheStats
}

type DotGitEntryState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Present" }
  | { readonly _tag: "StatError"; readonly reason: string }

const inspectDotGitEntry = (
  candidateRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): DotGitEntryState => {
  const dotGitPath = path.join(candidateRoot, ".git")
  const res = Result.try({
    try: () => hostIo.isSymbolicLinkSync(dotGitPath) || hostIo.existsSync(dotGitPath),
    catch: (err): DotGitEntryState => ({
      _tag: "StatError",
      reason: toErrorReasonMessage(err, `Failed to inspect ${dotGitPath}`),
    }),
  })
  return match(res)
    .with({ _tag: "Success" }, ({ success: exists }): DotGitEntryState =>
      exists ? { _tag: "Present" } : { _tag: "Absent" },
    )
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
}

/**
 * Resolves a directory's git worktree metadata if `.git` (file or directory) exists.
 * Returns `Option.none()` only when no `.git` entry exists; when `.git` is present and
 * validation fails, propagates `WorkflowStoreUnavailableError` fail-closed.
 */
export const resolveOptionalWorktree = (
  candidateRoot: string,
  validateWorktree: WorktreeValidatorFn = validateWorktreeRepoRoot,
): Effect.Effect<Option.Option<ValidatedWorktreeRoot>, WorkflowStoreUnavailableError> =>
  match(inspectDotGitEntry(candidateRoot))
    .with({ _tag: "Absent" }, () => Effect.succeedNone)
    .with({ _tag: "StatError" }, ({ reason }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: WORKTREE_SCOPE_OPERATION,
          reason: toBoundedReason(reason),
        }),
      ),
    )
    .with({ _tag: "Present" }, () =>
      match(Schema.decodeOption(AbsoluteRepoRoot)(candidateRoot))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation: WORKTREE_SCOPE_OPERATION,
              reason: toBoundedReason(`Invalid git repository root path '${candidateRoot}'`),
            }),
          ),
        )
        .with({ _tag: "Some" }, ({ value: absRoot }) =>
          validateWorktree(absRoot).pipe(Effect.asSome),
        )
        .exhaustive(),
    )
    .exhaustive()

const touchLruEntry = (
  cache: Map<string, ValidatedWorktreeRoot>,
  key: string,
  value: ValidatedWorktreeRoot,
  maxEntries: number,
): Map<string, ValidatedWorktreeRoot> => {
  const next = new Map(cache)
  if (next.has(key)) {
    next.delete(key)
    next.set(key, value)
    return next
  }
  if (next.size >= maxEntries) {
    const oldest = next.keys().next()
    if (!oldest.done) {
      next.delete(oldest.value)
    }
  }
  next.set(key, value)
  return next
}

/**
 * Creates a daemon-lifetime worktree scope cache that resolves the daemon's own
 * worktree once at startup and caches validated linked worktrees in a bounded LRU map.
 */
export const makeDaemonWorktreeScopeCache = Effect.fn("WorkflowDaemonHelper.makeScopeCache")(
  function* (
    baseRoot: string,
    options?: {
      readonly maxEntries?: number | undefined
      readonly validateWorktree?: WorktreeValidatorFn | undefined
    },
  ): Effect.fn.Return<DaemonWorktreeScopeCache> {
    const normalizedBaseRoot = path.resolve(baseRoot)
    const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_LINKED_WORKTREE_CACHE_LIMIT)
    const validateWorktree = options?.validateWorktree ?? validateWorktreeRepoRoot

    const startupResult = yield* resolveOptionalWorktree(normalizedBaseRoot, validateWorktree).pipe(
      Effect.result,
    )
    const startupState: StartupWorktreeState = match(startupResult)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "InvalidGit" as const,
        reason: failure.reason,
      }))
      .with({ _tag: "Success" }, ({ success: opt }) =>
        match(opt)
          .with({ _tag: "Some" }, ({ value: worktree }) => ({
            _tag: "Valid" as const,
            worktree,
          }))
          .with({ _tag: "None" }, () => ({ _tag: "NonGit" as const }))
          .exhaustive(),
      )
      .exhaustive()

    const linkedCacheRef = yield* SynchronizedRef.make<Map<string, ValidatedWorktreeRoot>>(
      new Map(),
    )
    let cachedLinkedCount = 0
    let cacheHits = 0
    let cacheMisses = 0

    const matchesCanonicalRootOnDisk = (
      logicalPath: string,
      expectedCanonicalRoot: string,
    ): boolean =>
      match(Result.try(() => nodeSyncHostIo.realpathSync(logicalPath)))
        .with({ _tag: "Success" }, ({ success }) => success === expectedCanonicalRoot)
        .with({ _tag: "Failure" }, () => false)
        .exhaustive()

    const resolveRequestScope = (
      requestedRepoRoot?: string,
    ): Effect.Effect<DaemonRequestScopeResult> => {
      if (requestedRepoRoot !== undefined && requestedRepoRoot.trim().length === 0) {
        return Effect.succeed<DaemonRequestScopeResult>({
          _tag: "Rejected",
          error: `Requested repoRoot '${requestedRepoRoot}' escapes daemon root (empty repoRoot)`,
        })
      }

      const logicalResolvedRoot =
        requestedRepoRoot !== undefined
          ? path.isAbsolute(requestedRepoRoot)
            ? path.resolve(requestedRepoRoot)
            : path.resolve(normalizedBaseRoot, requestedRepoRoot)
          : normalizedBaseRoot

      return match(startupState)
        .with({ _tag: "InvalidGit" }, ({ reason }) =>
          Effect.succeed<DaemonRequestScopeResult>({
            _tag: "Rejected",
            error: `Daemon root '${normalizedBaseRoot}' failed git worktree validation: ${reason}`,
          }),
        )
        .with({ _tag: "NonGit" }, () => {
          if (
            requestedRepoRoot !== undefined &&
            !isPathInsideRoot(normalizedBaseRoot, logicalResolvedRoot)
          ) {
            return Effect.succeed<DaemonRequestScopeResult>({
              _tag: "Rejected",
              error: `Requested repoRoot '${requestedRepoRoot}' escapes daemon root`,
            })
          }
          const isBaseHit =
            requestedRepoRoot === undefined || logicalResolvedRoot === normalizedBaseRoot
          if (isBaseHit) {
            cacheHits += 1
          }
          return Effect.succeed<DaemonRequestScopeResult>({
            _tag: "Allowed",
            resolvedRoot: logicalResolvedRoot,
            validatedWorktree: undefined,
            daemonWorktree: undefined,
            cacheHit: isBaseHit,
          })
        })
        .with({ _tag: "Valid" }, ({ worktree: daemonWorktree }) => {
          if (requestedRepoRoot === undefined) {
            if (
              !matchesCanonicalRootOnDisk(daemonWorktree.worktreeRoot, daemonWorktree.worktreeRoot)
            ) {
              return Effect.succeed<DaemonRequestScopeResult>({
                _tag: "Rejected",
                error: `Daemon base worktree root is no longer valid on disk: ${daemonWorktree.worktreeRoot}`,
              })
            }
            cacheHits += 1
            return Effect.succeed<DaemonRequestScopeResult>({
              _tag: "Allowed",
              resolvedRoot: daemonWorktree.worktreeRoot,
              validatedWorktree: daemonWorktree,
              daemonWorktree,
              cacheHit: true,
            })
          }
          if (
            (logicalResolvedRoot === normalizedBaseRoot ||
              logicalResolvedRoot === daemonWorktree.worktreeRoot) &&
            matchesCanonicalRootOnDisk(logicalResolvedRoot, daemonWorktree.worktreeRoot)
          ) {
            cacheHits += 1
            return Effect.succeed<DaemonRequestScopeResult>({
              _tag: "Allowed",
              resolvedRoot: daemonWorktree.worktreeRoot,
              validatedWorktree: daemonWorktree,
              daemonWorktree,
              cacheHit: true,
            })
          }

          return SynchronizedRef.modifyEffect(
            linkedCacheRef,
            (
              cache,
            ): Effect.Effect<
              readonly [DaemonRequestScopeResult, Map<string, ValidatedWorktreeRoot>]
            > => {
              const existing = cache.get(logicalResolvedRoot)
              let baseCache: Map<string, ValidatedWorktreeRoot> = cache
              if (existing !== undefined) {
                if (matchesCanonicalRootOnDisk(logicalResolvedRoot, existing.worktreeRoot)) {
                  const updated = touchLruEntry(cache, logicalResolvedRoot, existing, maxEntries)
                  cachedLinkedCount = updated.size
                  cacheHits += 1
                  return Effect.succeed([
                    {
                      _tag: "Allowed",
                      resolvedRoot: existing.worktreeRoot,
                      validatedWorktree: existing,
                      daemonWorktree,
                      cacheHit: true,
                    },
                    updated,
                  ])
                }
                const evicted = new Map(cache)
                evicted.delete(logicalResolvedRoot)
                cachedLinkedCount = evicted.size
                baseCache = evicted
              }

              return match(Schema.decodeOption(AbsoluteRepoRoot)(logicalResolvedRoot))
                .with({ _tag: "None" }, () =>
                  Effect.succeed([
                    {
                      _tag: "Rejected",
                      error: `Requested repoRoot '${requestedRepoRoot}' escapes daemon root`,
                    } satisfies DaemonRequestScopeResult,
                    new Map(baseCache),
                  ] as const),
                )
                .with({ _tag: "Some" }, ({ value: absRequested }) =>
                  validateWorktree(absRequested).pipe(
                    Effect.map(
                      (
                        validated,
                      ): readonly [
                        DaemonRequestScopeResult,
                        Map<string, ValidatedWorktreeRoot>,
                      ] => {
                        if (validated.commonGitDir !== daemonWorktree.commonGitDir) {
                          return [
                            {
                              _tag: "Rejected",
                              error: `Requested repoRoot '${requestedRepoRoot}' escapes daemon root: commonGitDir mismatch`,
                            },
                            new Map(baseCache),
                          ]
                        }
                        const updated = touchLruEntry(
                          baseCache,
                          logicalResolvedRoot,
                          validated,
                          maxEntries,
                        )
                        cachedLinkedCount = updated.size
                        cacheMisses += 1
                        return [
                          {
                            _tag: "Allowed",
                            resolvedRoot: validated.worktreeRoot,
                            validatedWorktree: validated,
                            daemonWorktree,
                            cacheHit: false,
                          },
                          updated,
                        ]
                      },
                    ),
                    Effect.catchTag("WorkflowStoreUnavailableError", (err) =>
                      Effect.succeed([
                        {
                          _tag: "Rejected",
                          error: `Requested repoRoot '${requestedRepoRoot}' escapes daemon root: ${err.reason}`,
                        } satisfies DaemonRequestScopeResult,
                        new Map(baseCache),
                      ] as const),
                    ),
                  ),
                )
                .exhaustive()
            },
          )
        })
        .exhaustive()
    }

    return {
      baseRoot: normalizedBaseRoot,
      startupState,
      resolveRequestScope,
      getStats: () => ({
        cachedLinkedCount,
        cacheHits,
        cacheMisses,
      }),
    }
  },
)

/**
 * Resolves and validates an incoming daemon request's `repoRoot`.
 * When `scopeCache` is provided, reuses the cached startup worktree and bounded linked-worktree
 * LRU cache instead of spawning `git worktree` on every request.
 */
export const resolveDaemonRequestScope = Effect.fn("WorkflowDaemonHelper.resolveRequestScope")(
  function* (
    baseRoot: string,
    requestedRepoRoot?: string,
    options?: {
      readonly scopeCache?: DaemonWorktreeScopeCache | undefined
      readonly validateWorktree?: WorktreeValidatorFn | undefined
    },
  ): Effect.fn.Return<DaemonRequestScopeResult> {
    if (options?.scopeCache !== undefined) {
      return yield* options.scopeCache.resolveRequestScope(requestedRepoRoot)
    }
    const ephemeralCache = yield* makeDaemonWorktreeScopeCache(baseRoot, {
      validateWorktree: options?.validateWorktree,
    })
    return yield* ephemeralCache.resolveRequestScope(requestedRepoRoot)
  },
)
