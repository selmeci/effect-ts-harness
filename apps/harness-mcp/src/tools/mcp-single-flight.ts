import * as path from "node:path"
import { Cause, Deferred, Effect, Result, Semaphore } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits, computeContentSha256, isPureInterruptCause } from "@harness/contract"
import { execFileAsyncEffect, nodeSyncHostIo } from "@harness/infra"
import type { ExtendedHostIo } from "@harness/service/host-io"

const DEFAULT_MAX_CONCURRENCY = 2
const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_MAX_INTERRUPT_RETRIES = 4
const GIT_DIGEST_TIMEOUT_MS = 5_000
const VOLATILE_ARG_KEYS = new Set(["repoRoot", "timeoutMs", "requestId", "timestamp"])

export interface McpSingleFlightControllerOptions {
  readonly maxConcurrency?: number | undefined
  readonly maxEntries?: number | undefined
  readonly hostIo?: ExtendedHostIo | undefined
}

type SingleFlightOutcome<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E> }
  | { readonly _tag: "Interrupted" }

export interface McpSingleFlightStats {
  readonly maxConcurrency: number
  readonly cacheSize: number
  readonly inFlightCount: number
}

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

const runGitReadOnly = (repoRoot: string, gitArgs: ReadonlyArray<string>): Effect.Effect<string> =>
  execFileAsyncEffect("git", ["--no-optional-locks", "--literal-pathspecs", ...gitArgs], {
    cwd: repoRoot,
    timeoutMs: GIT_DIGEST_TIMEOUT_MS,
  }).pipe(
    Effect.map((proc) =>
      match(proc)
        .with({ _tag: "Exited" }, (p) =>
          p.exitCode === 0 ? p.stdout.trimEnd() : `exit:${p.exitCode}`,
        )
        .with({ _tag: "TimedOut" }, () => "git-timeout")
        .with({ _tag: "Signaled" }, (p) => `git-signal:${p.signal}`)
        .with({ _tag: "SpawnFailed" }, () => "git-unavailable")
        .exhaustive(),
    ),
    Effect.orElseSucceed(() => "git-unavailable"),
  )

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
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const semaphore = Semaphore.makeUnsafe(maxConcurrency)
  const cache = new Map<string, unknown>()
  const inFlight = new Map<string, Deferred.Deferred<SingleFlightOutcome<unknown, unknown>>>()

  const setCacheEntry = (key: string, value: unknown): void => {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }

  const getCachedEntry = <A>(key: string): A | undefined => {
    if (!cache.has(key)) return undefined
    const cached = cache.get(key)
    cache.delete(key)
    cache.set(key, cached)
    return cached as A
  }

  const executeInternal = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
    remainingInterruptRetries: number,
  ): Effect.Effect<A, E, R> => {
    const fastHit = getCachedEntry<A>(key)
    if (fastHit !== undefined) {
      return Effect.succeed(fastHit)
    }
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const recheckedHit = getCachedEntry<A>(key)
        if (recheckedHit !== undefined) {
          return recheckedHit
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

        const deferred = Deferred.makeUnsafe<SingleFlightOutcome<unknown, unknown>>()
        inFlight.set(key, deferred)

        return yield* restore(semaphore.withPermits(1)(effect)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (inFlight.get(key) === deferred) {
                inFlight.delete(key)
              }
              const outcome: SingleFlightOutcome<unknown, unknown> = match(exit)
                .with({ _tag: "Success" }, ({ value }) => {
                  if (!isDegradedSingleFlightResult(value)) {
                    setCacheEntry(key, value)
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
  }

  return {
    execute: (key, effect) => executeInternal(key, effect, DEFAULT_MAX_INTERRUPT_RETRIES),
    computeDigestKey: ({ repoRoot, toolName, args, extraDigestParts }) =>
      Effect.gen(function* () {
        const canonicalRoot = Result.getOrElse(
          Result.try(() => hostIo.realpathSync(path.resolve(repoRoot))),
          () => path.resolve(repoRoot),
        )
        const [gitHead, gitStatus, docMetadata] = yield* Effect.all(
          [
            runGitReadOnly(canonicalRoot, ["rev-parse", "HEAD"]),
            runGitReadOnly(canonicalRoot, ["status", "--porcelain"]),
            Effect.sync(() => collectGovernanceDocMetadata(canonicalRoot, hostIo)),
          ],
          { concurrency: 2 },
        )
        const canonicalArgs = canonicalizeSingleFlightArgs(args)
        const payload = JSON.stringify({
          toolName,
          canonicalRoot,
          gitHead,
          gitStatus,
          docMetadata,
          canonicalArgs,
          extraDigestParts: extraDigestParts ?? [],
        })
        return computeContentSha256(payload)
      }),
    getStats: () => ({
      maxConcurrency,
      cacheSize: cache.size,
      inFlightCount: inFlight.size,
    }),
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }
}

export interface McpSingleFlightRunInput<A, E, R> {
  readonly controller: McpSingleFlightController
  readonly repoRoot: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly extraDigestParts?: ReadonlyArray<string> | undefined
  readonly effect: Effect.Effect<A, E, R>
}

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

export const McpSingleFlight = {
  run: runMcpSingleFlight,
} as const
