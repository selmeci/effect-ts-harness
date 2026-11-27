/**
 * @module mcp-single-flight
 * Concurrency-clamped (`<= 2`) single-flight coalescer and content-hashed digest cache
 * for expensive read-only MCP governance tools (`harness_ontology_check`, `harness_review_route`).
 */
import * as path from "node:path"
import { Cause, Clock, Deferred, Effect, Result, Semaphore } from "effect"
import { match, P } from "ts-pattern"
import {
  compareCodeUnits,
  computeContentSha256,
  DEFAULT_MAX_INTERRUPT_RETRIES,
  isPureInterruptCause,
} from "@harness/contract"
import { execFileAsyncEffect, nodeSyncHostIo } from "@harness/infra"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { isPathInsideRoot } from "./mcp-repo-root.js"

const DEFAULT_MAX_CONCURRENCY = 2
const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_CACHE_TTL_MS = 60_000
const GIT_DIGEST_TIMEOUT_MS = 5_000
const UNCACHEABLE_KEY_PREFIX = "uncacheable:"
const VOLATILE_ARG_KEYS = new Set(["repoRoot", "timeoutMs", "requestId", "timestamp"])

/** Configuration options for {@link createMcpSingleFlightController}. */
export interface McpSingleFlightControllerOptions {
  readonly maxConcurrency?: number | undefined
  readonly maxEntries?: number | undefined
  readonly cacheTtlMs?: number | undefined
  readonly hostIo?: ExtendedHostIo | undefined
}

type SingleFlightOutcome<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E> }
  | { readonly _tag: "Interrupted" }

type GitReadResult =
  | { readonly _tag: "Ok"; readonly value: string }
  | { readonly _tag: "Uncacheable"; readonly reason: string }

interface CachedSingleFlightEntry {
  readonly value: unknown
  readonly cachedAtMs: number
}

/** Live runtime statistics for an {@link McpSingleFlightController} instance. */
export interface McpSingleFlightStats {
  readonly maxConcurrency: number
  readonly cacheSize: number
  readonly inFlightCount: number
}

/** Coalescing, bounded-concurrency, TTL-cached execution controller for MCP read tools. */
export interface McpSingleFlightController {
  readonly execute: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly computeDigestKey: (input: {
    readonly repoRoot: string
    readonly toolName: string
    readonly args: Readonly<Record<string, unknown>>
    readonly extraDigestParts?: ReadonlyArray<string> | undefined
  }) => Effect.Effect<string>
  readonly getStats: () => McpSingleFlightStats
  readonly clear: () => void
}

/** Returns true when a key carries the uncacheable sentinel prefix and must bypass memory caching. */
export const isUncacheableSingleFlightKey = (key: string): boolean =>
  key.startsWith(UNCACHEABLE_KEY_PREFIX)

/** Returns true when a tool payload represents a degraded fallback that must never be cached. */
export const isDegradedSingleFlightResult = (result: unknown): boolean => {
  if (typeof result !== "object" || result === null) {
    return false
  }
  if (Reflect.get(result, "degraded") === true) {
    return true
  }
  if (Reflect.get(result, "source") === "degraded-fallback") {
    return true
  }
  const plan = Reflect.get(result, "plan")
  if (typeof plan === "object" && plan !== null) {
    if (Reflect.get(plan, "source") === "degraded-fallback") {
      return true
    }
  }
  return false
}

const canonicalizeValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue)
  }
  const sorted: Record<string, unknown> = {}
  const keys = Object.keys(value).sort(compareCodeUnits)
  for (const key of keys) {
    const entryVal = Reflect.get(value, key)
    if (entryVal !== undefined) {
      sorted[key] = canonicalizeValue(entryVal)
    }
  }
  return sorted
}

/** Produces a deterministic JSON representation of tool arguments excluding volatile keys. */
export const canonicalizeSingleFlightArgs = (args: Readonly<Record<string, unknown>>): string => {
  const filtered: Record<string, unknown> = {}
  const keys = Object.keys(args).sort(compareCodeUnits)
  for (const key of keys) {
    if (VOLATILE_ARG_KEYS.has(key)) {
      continue
    }
    const val = args[key]
    if (val !== undefined) {
      filtered[key] = canonicalizeValue(val)
    }
  }
  return JSON.stringify(filtered)
}

const collectGovernanceDocMetadata = (
  repoRoot: string,
  hostIo: ExtendedHostIo,
): ReadonlyArray<readonly [path: string, mtimeMs: number | null, sizeBytes: number | null]> => {
  const resolvedRoot = path.resolve(repoRoot)
  if (!hostIo.existsSync(resolvedRoot) || !hostIo.isDirectorySync(resolvedRoot)) {
    return []
  }

  const docRoots: Array<string> = []
  const topDocsDir = path.join(resolvedRoot, "docs")
  if (hostIo.existsSync(topDocsDir) && hostIo.isDirectorySync(topDocsDir)) {
    docRoots.push(topDocsDir)
  }

  const collected: Array<
    readonly [path: string, mtimeMs: number | null, sizeBytes: number | null]
  > = []

  const libsDir = path.join(resolvedRoot, "libs")
  if (hostIo.existsSync(libsDir) && hostIo.isDirectorySync(libsDir)) {
    match(Result.try(() => hostIo.readdirSync(libsDir)))
      .with({ _tag: "Success" }, ({ success: libEntries }) => {
        for (const entry of libEntries) {
          if (!entry.isDirectory) continue
          const libDocsDir = path.join(libsDir, entry.name, "docs")
          if (hostIo.existsSync(libDocsDir) && hostIo.isDirectorySync(libDocsDir)) {
            docRoots.push(libDocsDir)
          }
        }
      })
      .with({ _tag: "Failure" }, ({ failure }) => {
        collected.push([
          `unreadable:libs:${failure instanceof Error ? failure.message : String(failure)}`,
          null,
          null,
        ])
      })
      .exhaustive()
  }

  const walkDir = (dir: string): void => {
    const isSymDir = Result.getOrElse(
      Result.try(() => hostIo.isSymbolicLinkSync(dir)),
      () => true,
    )
    if (isSymDir) return
    match(Result.try(() => hostIo.readdirSync(dir)))
      .with({ _tag: "Success" }, ({ success: entries }) => {
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory) {
            walkDir(fullPath)
            continue
          }
          if (!entry.isFile || !entry.name.endsWith(".md")) {
            continue
          }
          const isSymFile = Result.getOrElse(
            Result.try(() => hostIo.isSymbolicLinkSync(fullPath)),
            () => true,
          )
          if (isSymFile) continue
          const relPath = path.relative(resolvedRoot, fullPath).replaceAll("\\", "/")
          const mtimeMs = Result.getOrElse(
            Result.try(() => hostIo.statMtimeMsSync(fullPath) ?? null),
            () => null,
          )
          const sizeBytes = Result.getOrElse(
            Result.try(() => hostIo.readBytesSync(fullPath).byteLength),
            () => null,
          )
          collected.push([relPath, mtimeMs, sizeBytes])
        }
      })
      .with({ _tag: "Failure" }, ({ failure }) => {
        const relDir = path.relative(resolvedRoot, dir).replaceAll("\\", "/")
        collected.push([
          `unreadable:${relDir}:${failure instanceof Error ? failure.message : String(failure)}`,
          null,
          null,
        ])
      })
      .exhaustive()
  }

  for (const docRoot of docRoots) {
    walkDir(docRoot)
  }

  return collected.sort((a, b) => compareCodeUnits(a[0], b[0]))
}

const logGitDigestWarning = (
  repoRoot: string,
  gitArgs: ReadonlyArray<string>,
  reason: string,
): void => {
  const subcommand = gitArgs[0] ?? "git"
  process.stderr.write(
    `[harness-mcp] single-flight git '${subcommand}' failed in '${repoRoot}' (${reason}); bypassing cache\n`,
  )
}

const runGitReadOnly = (
  repoRoot: string,
  gitArgs: ReadonlyArray<string>,
  trimTrailing = true,
): Effect.Effect<GitReadResult> =>
  execFileAsyncEffect("git", ["--no-optional-locks", "--literal-pathspecs", ...gitArgs], {
    cwd: repoRoot,
    timeoutMs: GIT_DIGEST_TIMEOUT_MS,
  }).pipe(
    Effect.map((proc): GitReadResult =>
      match(proc)
        .with({ _tag: "Exited" }, (p) => {
          if (p.exitCode === 0) {
            return { _tag: "Ok" as const, value: trimTrailing ? p.stdout.trimEnd() : p.stdout }
          }
          const stderr = p.stderr.trim()
          const reason = stderr.length > 0 ? `exit:${p.exitCode}:${stderr}` : `exit:${p.exitCode}`
          logGitDigestWarning(repoRoot, gitArgs, reason)
          return { _tag: "Uncacheable" as const, reason: `exit:${p.exitCode}` }
        })
        .with({ _tag: "TimedOut" }, () => {
          logGitDigestWarning(repoRoot, gitArgs, "git-timeout")
          return { _tag: "Uncacheable" as const, reason: "git-timeout" }
        })
        .with({ _tag: "Signaled" }, (p) => {
          const reason = `git-signal:${p.signal}`
          logGitDigestWarning(repoRoot, gitArgs, reason)
          return { _tag: "Uncacheable" as const, reason }
        })
        .with({ _tag: "SpawnFailed" }, (p) => {
          logGitDigestWarning(repoRoot, gitArgs, `git-spawn-failed:${p.spawnError}`)
          return { _tag: "Uncacheable" as const, reason: "git-unavailable" }
        })
        .exhaustive(),
    ),
    Effect.catchDefect((err) => {
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `[harness-mcp] single-flight git '${gitArgs[0] ?? "git"}' defect in '${repoRoot}' (${reason}); bypassing cache\n`,
      )
      return Effect.succeed<GitReadResult>({
        _tag: "Uncacheable",
        reason: "git-unavailable",
      })
    }),
  )

const extractUntrackedPathsFromPorcelainZ = (porcelainZ: string): ReadonlyArray<string> => {
  if (porcelainZ.length === 0) {
    return []
  }
  const tokens = porcelainZ.split("\0")
  const untracked: Array<string> = []
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]
    if (entry === undefined || entry.length < 4) {
      continue
    }
    const statusCode = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      i += 1
      continue
    }
    if (statusCode === "??" && filePath.length > 0) {
      untracked.push(filePath)
    }
  }
  return untracked.sort(compareCodeUnits)
}

const hashUntrackedFiles = (
  canonicalRoot: string,
  porcelainZ: string,
  hostIo: ExtendedHostIo,
): Result.Result<ReadonlyArray<readonly [path: string, digest: string]>, string> => {
  const untrackedPaths = extractUntrackedPathsFromPorcelainZ(porcelainZ)
  const hashes: Array<readonly [path: string, digest: string]> = []
  for (const relPath of untrackedPaths) {
    const absPath = path.resolve(canonicalRoot, relPath)
    if (!isPathInsideRoot(canonicalRoot, absPath)) {
      return Result.fail(`untracked-escape:${relPath}`)
    }
    const readRes = Result.try({
      try: () => {
        if (!hostIo.existsSync(absPath)) {
          return { _tag: "Missing" as const }
        }
        if (hostIo.isSymbolicLinkSync(absPath)) {
          return { _tag: "Hash" as const, digest: "symlink" }
        }
        if (hostIo.isDirectorySync(absPath)) {
          return { _tag: "Hash" as const, digest: "dir" }
        }
        const bytes = hostIo.readBytesSync(absPath)
        return {
          _tag: "Hash" as const,
          digest: computeContentSha256(Buffer.from(bytes).toString("base64")),
        }
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })
    const resolved = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "Error" as const,
        message: failure,
      }))
      .exhaustive()
    const untrackedFailure = match(resolved)
      .with({ _tag: "Missing" }, () => `untracked-missing:${relPath}`)
      .with({ _tag: "Error" }, ({ message }) => `untracked-read-failed:${relPath}:${message}`)
      .with({ _tag: "Hash" }, ({ digest }) => {
        hashes.push([relPath, digest])
        return undefined
      })
      .exhaustive()
    if (untrackedFailure !== undefined) {
      return Result.fail(untrackedFailure)
    }
  }
  return Result.succeed(hashes)
}

/**
 * Creates a bounded-concurrency single-flight controller with TTL cache eviction,
 * content-aware git/workspace digest invalidation, and generation-guarded `clear()`.
 */
export const createMcpSingleFlightController = (
  options?: McpSingleFlightControllerOptions,
): McpSingleFlightController => {
  const rawMaxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxConcurrency = Math.min(
    DEFAULT_MAX_CONCURRENCY,
    Math.max(1, Math.floor(Number.isFinite(rawMaxConcurrency) ? rawMaxConcurrency : 2)),
  )
  const rawMaxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxEntries = Math.max(
    1,
    Math.floor(Number.isFinite(rawMaxEntries) ? rawMaxEntries : DEFAULT_MAX_ENTRIES),
  )
  const rawCacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const cacheTtlMs = Math.max(
    0,
    Math.floor(Number.isFinite(rawCacheTtlMs) ? rawCacheTtlMs : DEFAULT_CACHE_TTL_MS),
  )
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const semaphore = Semaphore.makeUnsafe(maxConcurrency)
  const cache = new Map<string, CachedSingleFlightEntry>()
  const inFlight = new Map<string, Deferred.Deferred<SingleFlightOutcome<unknown, unknown>>>()
  let generation = 0
  let uncacheableSeq = 0

  const makeUncacheableKey = (reason: string): string => {
    uncacheableSeq += 1
    return `${UNCACHEABLE_KEY_PREFIX}${uncacheableSeq}:${reason}`
  }

  const setCacheEntry = (key: string, value: unknown, cachedAtMs: number): void => {
    if (isUncacheableSingleFlightKey(key) || cacheTtlMs === 0) {
      return
    }
    cache.delete(key)
    cache.set(key, { value, cachedAtMs })
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }

  const getCachedEntry = <A>(key: string, nowMs: number): A | undefined => {
    if (isUncacheableSingleFlightKey(key)) {
      return undefined
    }
    const cached = cache.get(key)
    if (cached === undefined) {
      return undefined
    }
    if (nowMs - cached.cachedAtMs >= cacheTtlMs) {
      cache.delete(key)
      return undefined
    }
    cache.delete(key)
    cache.set(key, cached)
    return cached.value as A
  }

  const executeInternal = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
    remainingInterruptRetries: number,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const cachedHit = getCachedEntry<A>(key, nowMs)
        if (cachedHit !== undefined) {
          return cachedHit
        }
        const existing = inFlight.get(key)
        if (existing !== undefined) {
          const awaited = yield* restore(Deferred.await(existing))
          return yield* match(awaited)
            .with({ _tag: "Success" }, ({ value }) => Effect.succeed(value as A))
            .with({ _tag: "Failure" }, ({ cause }) => Effect.failCause(cause as Cause.Cause<E>))
            .with({ _tag: "Interrupted" }, () =>
              remainingInterruptRetries > 0
                ? restore(executeInternal(key, effect, remainingInterruptRetries - 1))
                : Effect.interrupt,
            )
            .exhaustive()
        }

        const leaderGeneration = generation
        const deferred = Deferred.makeUnsafe<SingleFlightOutcome<unknown, unknown>>()
        inFlight.set(key, deferred)

        return yield* restore(semaphore.withPermits(1)(effect)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (inFlight.get(key) === deferred) {
                inFlight.delete(key)
              }
              const completedAtMs = yield* Clock.currentTimeMillis
              const outcome: SingleFlightOutcome<unknown, unknown> = match(exit)
                .with({ _tag: "Success" }, ({ value }) => {
                  if (
                    !isUncacheableSingleFlightKey(key) &&
                    leaderGeneration === generation &&
                    !isDegradedSingleFlightResult(value)
                  ) {
                    setCacheEntry(key, value, completedAtMs)
                  }
                  return { _tag: "Success" as const, value }
                })
                .with({ _tag: "Failure" }, ({ cause }) =>
                  isPureInterruptCause(cause)
                    ? ({ _tag: "Interrupted" as const } as const)
                    : ({ _tag: "Failure" as const, cause } as const),
                )
                .exhaustive()
              yield* Deferred.succeed(deferred, outcome)
            }),
          ),
        )
      }),
    )

  return {
    execute: (key, effect) => executeInternal(key, effect, DEFAULT_MAX_INTERRUPT_RETRIES),
    computeDigestKey: ({ repoRoot, toolName, args, extraDigestParts }) =>
      Effect.gen(function* () {
        const canonicalRoot = Result.getOrElse(
          Result.try(() => hostIo.realpathSync(path.resolve(repoRoot))),
          () => path.resolve(repoRoot),
        )
        const [gitHead, gitStatus, gitDiffHead, gitDiffCached, docMetadata] = yield* Effect.all(
          [
            runGitReadOnly(canonicalRoot, ["rev-parse", "HEAD"]),
            runGitReadOnly(canonicalRoot, ["status", "--porcelain", "-uall", "-z"], false),
            runGitReadOnly(canonicalRoot, ["diff", "HEAD"], false),
            runGitReadOnly(canonicalRoot, ["diff", "--cached"], false),
            Effect.sync(() => collectGovernanceDocMetadata(canonicalRoot, hostIo)),
          ],
          { concurrency: 2 },
        )

        const gitCombined = match([gitHead, gitStatus, gitDiffHead, gitDiffCached] as const)
          .with(
            [{ _tag: "Ok" }, { _tag: "Ok" }, { _tag: "Ok" }, { _tag: "Ok" }],
            ([head, status, diffHead, diffCached]) => ({
              _tag: "Ok" as const,
              head: head.value,
              status: status.value,
              diffHead: diffHead.value,
              diffCached: diffCached.value,
            }),
          )
          .with([{ _tag: "Uncacheable" }, P._, P._, P._], ([failed]) => failed)
          .with([P._, { _tag: "Uncacheable" }, P._, P._], ([, failed]) => failed)
          .with([P._, P._, { _tag: "Uncacheable" }, P._], ([, , failed]) => failed)
          .with([P._, P._, P._, { _tag: "Uncacheable" }], ([, , , failed]) => failed)
          .exhaustive()

        return match(gitCombined)
          .with({ _tag: "Uncacheable" }, ({ reason }) => makeUncacheableKey(reason))
          .with({ _tag: "Ok" }, ({ head, status, diffHead, diffCached }) =>
            match(hashUntrackedFiles(canonicalRoot, status, hostIo))
              .with({ _tag: "Failure" }, ({ failure }) => {
                process.stderr.write(
                  `[harness-mcp] single-flight untracked file hash failed in '${canonicalRoot}' (${failure}); bypassing cache\n`,
                )
                return makeUncacheableKey(failure)
              })
              .with({ _tag: "Success" }, ({ success: untrackedHashes }) => {
                const canonicalArgs = canonicalizeSingleFlightArgs(args)
                const payload = JSON.stringify({
                  toolName,
                  canonicalRoot,
                  gitHead: head,
                  gitStatus: status,
                  gitDiffHead: diffHead,
                  gitDiffCached: diffCached,
                  untrackedHashes,
                  docMetadata,
                  canonicalArgs,
                  extraDigestParts: extraDigestParts ?? [],
                })
                return computeContentSha256(payload)
              })
              .exhaustive(),
          )
          .exhaustive()
      }),
    getStats: () => ({
      maxConcurrency,
      cacheSize: cache.size,
      inFlightCount: inFlight.size,
    }),
    clear: () => {
      generation += 1
      cache.clear()
      inFlight.clear()
    },
  }
}

/** Input parameters for {@link runMcpSingleFlight}. */
export interface McpSingleFlightRunInput<A, E, R> {
  readonly controller: McpSingleFlightController
  readonly repoRoot: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly extraDigestParts?: ReadonlyArray<string> | undefined
  readonly effect: Effect.Effect<A, E, R>
}

/** Computes a content-hashed digest key and runs `input.effect` through the single-flight controller. */
export const runMcpSingleFlight = Effect.fn("McpSingleFlight.run")(function* <A, E, R>(
  input: McpSingleFlightRunInput<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const digestKey = yield* input.controller.computeDigestKey({
    repoRoot: input.repoRoot,
    toolName: input.toolName,
    args: input.args,
    extraDigestParts: input.extraDigestParts,
  })
  return yield* input.controller.execute(digestKey, input.effect)
})

/** Namespace entrypoint for single-flight MCP tool execution. */
export const McpSingleFlight = {
  run: runMcpSingleFlight,
} as const
