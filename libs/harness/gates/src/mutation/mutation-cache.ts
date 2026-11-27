import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Cause, Effect, Redacted, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  ContentSha256,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  type MutationCacheAuth,
  MutationCacheEntry,
  MutationCacheLookupDecision,
  type MutationCacheLookupInput,
  MutationCacheMac,
  MutationCacheStore,
  MutationMaxAgeMillis,
  type PackageRelKey,
  type RedactedMutationCacheHmacSecret,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { resolveHarnessStateDir } from "../worktree.js"
import type { CodeMutant } from "./mutant-ast-generator.js"
import {
  type ComputeFileMutationClosureDigestInput,
  type FileMutationClosureDigestResult,
  type MutationContextDigests,
  type MutationContextDigestsResult,
  checkExists,
  computeFileMutationClosureDigest,
  computeMutationContextDigests,
  computeMutationContextDigestsChecked,
  isNonSymlink,
  readSafeText,
  unwrapOption,
  unwrapResult,
} from "./mutation-context-digest.js"

export {
  type ComputeFileMutationClosureDigestInput,
  type FileMutationClosureDigestResult,
  type MutationContextDigests,
  type MutationContextDigestsResult,
  computeFileMutationClosureDigest,
  computeMutationContextDigests,
  computeMutationContextDigestsChecked,
}
export const MAX_MUTATION_CACHE_ENTRIES = 5000
export const MAX_MUTATION_CACHE_AGE_MS = 12 * 60 * 60 * 1000

export type ComputeMutationEntryMacInput = Omit<MutationCacheEntry, "mac">

export interface ComputeMutantCacheKeyInput {
  readonly pkgKey: PackageRelKey
  readonly relFile: AstSourceFilePath
  readonly originalContentSha256: ContentSha256
  readonly compiledSchemaSha256: ContentSha256
  readonly mutant: CodeMutant
  readonly digests: MutationContextDigests
}

export type SaveMutationCacheResult =
  | { readonly _tag: "Saved" }
  | { readonly _tag: "Skipped"; readonly reason: string }
  | { readonly _tag: "Failed"; readonly reason: string }

export type LoadMutationCacheResult =
  | {
      readonly _tag: "Loaded"
      readonly store: MutationCacheStore
      readonly droppedEntryCount: number
    }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Corrupt"
      readonly reason: string
      readonly quarantinedPath?: string | undefined
    }
  | { readonly _tag: "Unsafe"; readonly reason: string }

export const emptyMutationCacheStore = (): MutationCacheStore => ({
  version: MUTATION_CACHE_SCHEMA_VERSION,
  entries: {},
})

export const isAppendOnlyWitnessDigestsPreserved = (
  recordedDigests: ReadonlyArray<ContentSha256>,
  currentDigests: ReadonlyArray<ContentSha256>,
): boolean => {
  if (recordedDigests.length === 0) return false
  const currentSet = new Set<ContentSha256>(currentDigests)
  return recordedDigests.every((digest) => currentSet.has(digest))
}

export const computeMutationEntryMac = (
  hmacSecret: RedactedMutationCacheHmacSecret,
  p: ComputeMutationEntryMacInput,
): MutationCacheMac => {
  const fields = [
    p.key,
    p.file,
    p.mutantId,
    p.status,
    p.recordedAt,
    p.witnessTestFile,
    p.witnessClosureSha256,
    ...(p.sourceClosureSha256 !== undefined ? [`src:${p.sourceClosureSha256}`] : []),
    ...(p.witnessSupportSha256 !== undefined ? [`sup:${p.witnessSupportSha256}`] : []),
    ...(p.witnessTestAstDigests !== undefined ? [`ast:${p.witnessTestAstDigests.join(",")}`] : []),
  ]
  const payload = fields.map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`).join("\0")
  return MutationCacheMac.make(
    createHmac("sha256", Redacted.value(hmacSecret)).update(payload).digest("hex"),
  )
}

export const verifyMutationEntryMac = (
  hmacSecret: RedactedMutationCacheHmacSecret,
  entry: MutationCacheEntry,
): boolean => {
  const expectedBuf = Buffer.from(computeMutationEntryMac(hmacSecret, entry), "utf8")
  const actualBuf = Buffer.from(entry.mac, "utf8")
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)
}

const matchesEntrySourceClosure = (
  entry: MutationCacheEntry,
  sourceClosureDigests: Readonly<Record<AstSourceFilePath, ContentSha256>> | undefined,
): boolean => {
  if (entry.sourceClosureSha256 === undefined || sourceClosureDigests === undefined) return false
  const candidate = Object.hasOwn(sourceClosureDigests, entry.file)
    ? sourceClosureDigests[entry.file]
    : Object.hasOwn(sourceClosureDigests, entry.witnessTestFile)
      ? sourceClosureDigests[entry.witnessTestFile]
      : undefined
  return candidate === entry.sourceClosureSha256
}

const matchesEntryWitnessSupport = (
  entry: MutationCacheEntry,
  witnessSupportDigests: Readonly<Record<AstSourceFilePath, ContentSha256>> | undefined,
): boolean => {
  if (entry.witnessSupportSha256 === undefined || witnessSupportDigests === undefined) return false
  return Object.hasOwn(witnessSupportDigests, entry.witnessTestFile)
    ? witnessSupportDigests[entry.witnessTestFile] === entry.witnessSupportSha256
    : false
}

export const partitionMutationCacheLookup = (
  input: MutationCacheLookupInput,
): MutationCacheLookupDecision =>
  match(input.auth)
    .with({ _tag: "Disabled" }, () => ({ hitKeys: [], missKeys: [...input.candidateKeys] }))
    .with({ _tag: "Enabled" }, ({ hmacSecret }) => {
      const nowMs = input.nowMs
      const maxAgeMs = input.maxAgeMs ?? MutationMaxAgeMillis.make(MAX_MUTATION_CACHE_AGE_MS)
      const reachingSet = new Set<AstSourceFilePath>(input.reachingTests)
      const hitKeys: Array<ContentSha256> = []
      const missKeys: Array<ContentSha256> = []
      for (const candidateKey of input.candidateKeys) {
        const entry = Object.hasOwn(input.store.entries, candidateKey)
          ? input.store.entries[candidateKey]
          : undefined
        const ageMs = entry !== undefined ? nowMs - Date.parse(entry.recordedAt) : Number.NaN
        const baseValid =
          entry !== undefined &&
          match(entry.status)
            .with("killed", () => entry.key === candidateKey)
            .exhaustive() &&
          verifyMutationEntryMac(hmacSecret, entry) &&
          Number.isFinite(ageMs) &&
          ageMs >= 0 &&
          ageMs <= maxAgeMs &&
          reachingSet.has(entry.witnessTestFile)
        const exactWitnessMatch =
          baseValid &&
          Object.hasOwn(input.witnessClosureDigests, entry.witnessTestFile) &&
          input.witnessClosureDigests[entry.witnessTestFile] === entry.witnessClosureSha256
        const twoTierWitnessMatch =
          baseValid &&
          !exactWitnessMatch &&
          entry.witnessTestAstDigests !== undefined &&
          input.witnessTestAstDigests !== undefined &&
          Object.hasOwn(input.witnessTestAstDigests, entry.witnessTestFile) &&
          matchesEntrySourceClosure(entry, input.sourceClosureDigests) &&
          matchesEntryWitnessSupport(entry, input.witnessSupportDigests) &&
          isAppendOnlyWitnessDigestsPreserved(
            entry.witnessTestAstDigests,
            input.witnessTestAstDigests[entry.witnessTestFile]!,
          )
        if (exactWitnessMatch || twoTierWitnessMatch) hitKeys.push(candidateKey)
        else missKeys.push(candidateKey)
      }
      return { hitKeys, missKeys }
    })
    .exhaustive()

export const decideMutationCacheLookup = Effect.fn("MutationCache.decide")(function* (
  input: MutationCacheLookupInput,
): Effect.fn.Return<MutationCacheLookupDecision> {
  return yield* Effect.succeed(partitionMutationCacheLookup(input))
})

export const MutationCache = { decide: decideMutationCacheLookup } as const

export const computeMutantCacheKey = (input: ComputeMutantCacheKeyInput): ContentSha256 =>
  computeContentSha256(
    JSON.stringify({
      v: MUTATION_CACHE_SCHEMA_VERSION,
      runtimeVersion: input.digests.runtimeVersion,
      pkgKey: input.pkgKey,
      relFile: input.relFile,
      originalContentSha256: input.originalContentSha256,
      compiledSchemaSha256: input.compiledSchemaSha256,
      id: input.mutant.id,
      line: input.mutant.line,
      category: input.mutant.category,
      original: input.mutant.original,
      replacement: input.mutant.replacement,
    }),
  )

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const tryOrErr = <A>(
  fn: () => A,
  prefix: string,
): { readonly ok: true; readonly v: A } | { readonly ok: false; readonly err: string } =>
  match(Result.try(fn))
    .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, v: success }))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      ok: false as const,
      err: `${prefix}: ${errMsg(failure)}`,
    }))
    .exhaustive()
const isFileSafe = (p: string, hostIo: SyncHostIo): boolean =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.isFileSync(p)))) ?? false
export const realpathOrUndefined = (p: string, hostIo: SyncHostIo): string | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.realpathSync(p))))
export const isPathContained = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const resolveCachePaths = (repoRoot: string, hostIo: SyncHostIo) =>
  match(Result.try(() => resolveHarnessStateDir(repoRoot, hostIo.getEnv())))
    .with({ _tag: "Success" }, ({ success: stateDir }) => {
      const cacheDir = join(stateDir, "cache")
      return {
        _tag: "Ok" as const,
        stateDir,
        cacheDir,
        cacheFile: join(cacheDir, MUTATION_CACHE_FILENAME),
      }
    })
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Unsafe" as const,
      reason: `invalid harness state dir: ${errMsg(failure)}`,
    }))
    .exhaustive()

type AncestorPathState = "safe-exists" | "absent" | "unsafe"

const inspectPathSymlinkState = (
  targetPath: string,
  hostIo: SyncHostIo,
): "not-symlink" | "unsafe" => {
  const symRes = Result.try(() => hostIo.isSymbolicLinkSync(targetPath))
  return match(symRes)
    .with({ _tag: "Success" }, ({ success: isSymlink }) =>
      isSymlink ? ("unsafe" as const) : ("not-symlink" as const),
    )
    .with({ _tag: "Failure" }, ({ failure }) => {
      const code =
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        typeof failure.code === "string"
          ? failure.code
          : undefined
      return code === "ENOENT" || code === undefined
        ? ("not-symlink" as const)
        : ("unsafe" as const)
    })
    .exhaustive()
}

export const isUnsafeSymlinkPath = (targetPath: string, hostIo: SyncHostIo): boolean =>
  match(inspectPathSymlinkState(targetPath, hostIo))
    .with("unsafe", () => true)
    .with("not-symlink", () => false)
    .exhaustive()

const inspectAncestorPath = (targetPath: string, hostIo: SyncHostIo): AncestorPathState => {
  if (isUnsafeSymlinkPath(targetPath, hostIo)) return "unsafe"
  const exists = checkExists(targetPath, hostIo)
  if (exists === undefined) return "unsafe"
  return exists ? "safe-exists" : "absent"
}

const checkCacheAncestors = (
  repoRoot: string,
  stateDir: string,
  cacheDir: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (!isNonSymlink(repoRoot, hostIo)) return undefined
  const resolvedRoot = resolve(repoRoot)
  const resolvedState = resolve(stateDir)
  const stateInRepo = isPathContained(resolvedRoot, resolvedState)
  let cur = resolve(cacheDir)
  let deepest: string | undefined = undefined
  let passedStateDir = false
  while (true) {
    const ancestorState = inspectAncestorPath(cur, hostIo)
    const stepAction = match(ancestorState)
      .with("unsafe", () => ({ aborted: true, shouldBreak: true }))
      .with("safe-exists", () => {
        if (deepest === undefined) deepest = cur
        return { aborted: false, shouldBreak: !stateInRepo && passedStateDir }
      })
      .with("absent", () => ({ aborted: false, shouldBreak: false }))
      .exhaustive()
    if (stepAction.aborted) return undefined
    if (stepAction.shouldBreak) break
    if (cur === resolvedState) passedStateDir = true
    if (
      cur === resolvedRoot ||
      (!stateInRepo && passedStateDir && deepest !== undefined) ||
      cur === dirname(cur)
    ) {
      break
    }
    cur = dirname(cur)
  }
  if (deepest === undefined) return undefined
  if (stateInRepo) {
    const rootReal = realpathOrUndefined(repoRoot, hostIo)
    const deepReal = realpathOrUndefined(deepest, hostIo)
    if (rootReal === undefined || deepReal === undefined || !isPathContained(rootReal, deepReal))
      return undefined
  }
  return deepest
}

const TopLevelCacheEnvelopeSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Unknown, entries: Schema.Record(Schema.String, Schema.Unknown) }),
)

const tryQuarantineCorruptCache = (
  cacheDir: string,
  cacheFile: string,
  reason: string,
  hostIo: SyncHostIo,
): LoadMutationCacheResult => {
  const canQuarantine =
    isNonSymlink(cacheDir, hostIo) &&
    isNonSymlink(cacheFile, hostIo) &&
    isFileSafe(cacheFile, hostIo)
  const corruptPath = `${cacheFile}.corrupt`
  const quarantinedPath = canQuarantine
    ? unwrapOption(
        unwrapResult(
          Result.try(() => {
            hostIo.renameSync(cacheFile, corruptPath)
            return corruptPath
          }),
        ),
      )
    : undefined
  return { _tag: "Corrupt", reason, ...(quarantinedPath !== undefined ? { quarantinedPath } : {}) }
}

const validateCachePathSafety = (
  repoRoot: string,
  stateDir: string,
  cacheDir: string,
  cacheFile: string,
  checkFile: boolean,
  hostIo: SyncHostIo,
): string | undefined => {
  if (checkCacheAncestors(repoRoot, stateDir, cacheDir, hostIo) === undefined)
    return `unsafe cache ancestor path for '${cacheDir}'`
  if (isUnsafeSymlinkPath(cacheFile, hostIo)) {
    return `symlink or unsafe path detected at '${cacheFile}'`
  }
  if (
    !isNonSymlink(stateDir, hostIo) ||
    !isNonSymlink(cacheDir, hostIo) ||
    (checkFile && (!isNonSymlink(cacheFile, hostIo) || !isFileSafe(cacheFile, hostIo)))
  ) {
    return `symlink or non-file detected at '${cacheFile}'`
  }
  const stateReal = realpathOrUndefined(stateDir, hostIo)
  const targetReal = realpathOrUndefined(checkFile ? cacheFile : cacheDir, hostIo)
  if (
    stateReal === undefined ||
    targetReal === undefined ||
    !isPathContained(stateReal, targetReal)
  ) {
    return `realpath escape detected for '${cacheFile}'`
  }
  return undefined
}

/**
 * Validates that a cache file path under the active harness state cache directory is free of
 * symlinks, non-files, and realpath escapes outside `stateDir` / `repoRoot`.
 */
export const validateHarnessCacheFileSafety = (
  repoRoot: string,
  filePath: string,
  checkFileExists: boolean,
  hostIo: SyncHostIo,
): string | undefined =>
  match(resolveCachePaths(repoRoot, hostIo))
    .with({ _tag: "Unsafe" }, ({ reason }) => reason)
    .with({ _tag: "Ok" }, ({ stateDir, cacheDir }) => {
      if (!isPathContained(resolve(cacheDir), resolve(filePath))) {
        return `cache file '${filePath}' escapes '${cacheDir}'`
      }
      if (isUnsafeSymlinkPath(filePath, hostIo)) {
        return `symlink or unsafe path detected at '${filePath}'`
      }
      if (checkCacheAncestors(repoRoot, stateDir, cacheDir, hostIo) === undefined) {
        return `unsafe cache ancestor path for '${cacheDir}'`
      }
      if (checkFileExists || checkExists(cacheDir, hostIo) === true) {
        const unsafeReason = validateCachePathSafety(
          repoRoot,
          stateDir,
          cacheDir,
          filePath,
          checkFileExists,
          hostIo,
        )
        if (unsafeReason !== undefined) return unsafeReason
        if (isPathContained(resolve(repoRoot), resolve(stateDir))) {
          const repoReal = realpathOrUndefined(repoRoot, hostIo)
          const dirReal = realpathOrUndefined(cacheDir, hostIo)
          if (
            repoReal === undefined ||
            dirReal === undefined ||
            !isPathContained(repoReal, dirReal)
          ) {
            return `cache dir escapes repoRoot '${repoRoot}'`
          }
        }
      }
      return undefined
    })
    .exhaustive()

const resolveCacheAuth = (
  cacheAuth: MutationCacheAuth | undefined,
):
  | { readonly _tag: "Ok"; readonly hmacSecret: RedactedMutationCacheHmacSecret }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  if (cacheAuth === undefined) {
    return { _tag: "Disabled", reason: "missing HMAC secret" }
  }
  return match(cacheAuth)
    .with({ _tag: "Enabled" }, ({ hmacSecret }) => ({ _tag: "Ok" as const, hmacSecret }))
    .with({ _tag: "Disabled" }, ({ reason }) => ({ _tag: "Disabled" as const, reason }))
    .exhaustive()
}

export const loadMutationCacheWithStatus = (
  repoRoot: string,
  hostIo: SyncHostIo,
  cacheAuth?: MutationCacheAuth,
): LoadMutationCacheResult =>
  match(resolveCacheAuth(cacheAuth))
    .with({ _tag: "Disabled" }, ({ reason }) => ({ _tag: "Unsafe" as const, reason }))
    .with({ _tag: "Ok" }, ({ hmacSecret }) =>
      match(resolveCachePaths(repoRoot, hostIo))
        .with({ _tag: "Unsafe" }, (u) => u)
        .with({ _tag: "Ok" }, ({ stateDir, cacheDir, cacheFile }) => {
          if (isUnsafeSymlinkPath(cacheFile, hostIo)) {
            return {
              _tag: "Unsafe" as const,
              reason: `symlink or unsafe path detected at '${cacheFile}'`,
            }
          }
          const exists = checkExists(cacheFile, hostIo)
          if (exists === undefined)
            return { _tag: "Unsafe" as const, reason: `failed to stat cache file '${cacheFile}'` }
          if (!exists) return { _tag: "Missing" as const }
          const unsafeReason = validateCachePathSafety(
            repoRoot,
            stateDir,
            cacheDir,
            cacheFile,
            true,
            hostIo,
          )
          if (unsafeReason !== undefined) return { _tag: "Unsafe" as const, reason: unsafeReason }
          const raw = unwrapOption(readSafeText(cacheFile, hostIo))
          if (raw === undefined)
            return { _tag: "Unsafe" as const, reason: `unreadable cache file '${cacheFile}'` }
          return match(Schema.decodeExit(TopLevelCacheEnvelopeSchema)(raw))
            .with({ _tag: "Failure" }, ({ cause }) =>
              tryQuarantineCorruptCache(
                cacheDir,
                cacheFile,
                `invalid cache JSON structure: ${Cause.pretty(cause).slice(0, 160)}`,
                hostIo,
              ),
            )
            .with({ _tag: "Success" }, ({ value: envelope }) => {
              if (envelope.version !== MUTATION_CACHE_SCHEMA_VERSION) {
                return tryQuarantineCorruptCache(
                  cacheDir,
                  cacheFile,
                  `unexpected cache version '${String(envelope.version)}'`,
                  hostIo,
                )
              }
              const validEntries: Record<ContentSha256, MutationCacheEntry> = {}
              let droppedEntryCount = 0
              for (const [k, rawEntry] of Object.entries(envelope.entries)) {
                const validEntry = match(Schema.decodeUnknownExit(MutationCacheEntry)(rawEntry))
                  .with({ _tag: "Failure" }, () => undefined)
                  .with({ _tag: "Success" }, ({ value: entry }) =>
                    entry.key === k && verifyMutationEntryMac(hmacSecret, entry)
                      ? entry
                      : undefined,
                  )
                  .exhaustive()
                if (validEntry === undefined) droppedEntryCount += 1
                else validEntries[validEntry.key] = validEntry
              }
              return {
                _tag: "Loaded" as const,
                store: { version: MUTATION_CACHE_SCHEMA_VERSION, entries: validEntries },
                droppedEntryCount,
              }
            })
            .exhaustive()
        })
        .exhaustive(),
    )
    .exhaustive()

const isDirSafe = (p: string, hostIo: SyncHostIo): boolean =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.isDirectorySync(p)))) ?? false

export const resolveLinkedWorktreeCommonRepoRoot = (
  repoRoot: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (!isNonSymlink(repoRoot, hostIo)) return undefined
  const dotGit = join(repoRoot, ".git")
  if (
    checkExists(dotGit, hostIo) !== true ||
    !isNonSymlink(dotGit, hostIo) ||
    !isFileSafe(dotGit, hostIo)
  ) {
    return undefined
  }
  const dotGitRaw = unwrapOption(readSafeText(dotGit, hostIo))
  if (dotGitRaw === undefined) return undefined
  const gitDirMatch = /^gitdir:\s*(.+)$/m.exec(dotGitRaw)
  if (gitDirMatch === null) return undefined
  const gitDir = resolve(repoRoot, gitDirMatch[1]!.trim())
  if (!isNonSymlink(gitDir, hostIo) || !isDirSafe(gitDir, hostIo)) return undefined

  const commonDirFile = join(gitDir, "commondir")
  if (
    checkExists(commonDirFile, hostIo) !== true ||
    !isNonSymlink(commonDirFile, hostIo) ||
    !isFileSafe(commonDirFile, hostIo)
  ) {
    return undefined
  }
  const commonDirRaw = unwrapOption(readSafeText(commonDirFile, hostIo))
  if (commonDirRaw === undefined || commonDirRaw.trim().length === 0) return undefined
  const commonGitDir = resolve(gitDir, commonDirRaw.trim())
  if (!isNonSymlink(commonGitDir, hostIo) || !isDirSafe(commonGitDir, hostIo)) return undefined

  const commonRepoRoot = dirname(commonGitDir)
  if (!isNonSymlink(commonRepoRoot, hostIo) || !isDirSafe(commonRepoRoot, hostIo)) return undefined
  const repoReal = realpathOrUndefined(repoRoot, hostIo)
  const commonReal = realpathOrUndefined(commonRepoRoot, hostIo)
  if (repoReal === undefined || commonReal === undefined || repoReal === commonReal) {
    return undefined
  }
  return commonRepoRoot
}

const loadReadOnlySharedCacheEntries = (
  commonRepoRoot: string,
  hostIo: SyncHostIo,
  hmacSecret: RedactedMutationCacheHmacSecret,
): Record<ContentSha256, MutationCacheEntry> => {
  const cleanHostIo: SyncHostIo = { ...hostIo, getEnv: () => ({}) }
  return match(resolveCachePaths(commonRepoRoot, cleanHostIo))
    .with({ _tag: "Unsafe" }, () => ({}))
    .with({ _tag: "Ok" }, ({ stateDir, cacheDir, cacheFile }) => {
      if (checkExists(cacheFile, cleanHostIo) !== true) return {}
      if (
        validateCachePathSafety(
          commonRepoRoot,
          stateDir,
          cacheDir,
          cacheFile,
          true,
          cleanHostIo,
        ) !== undefined
      ) {
        return {}
      }
      const raw = unwrapOption(readSafeText(cacheFile, cleanHostIo))
      if (raw === undefined) return {}
      return match(Schema.decodeExit(TopLevelCacheEnvelopeSchema)(raw))
        .with({ _tag: "Failure" }, () => ({}))
        .with({ _tag: "Success" }, ({ value: envelope }) => {
          if (envelope.version !== MUTATION_CACHE_SCHEMA_VERSION) return {}
          const validEntries: Record<ContentSha256, MutationCacheEntry> = {}
          for (const [k, rawEntry] of Object.entries(envelope.entries)) {
            const validEntry = match(Schema.decodeUnknownExit(MutationCacheEntry)(rawEntry))
              .with({ _tag: "Failure" }, () => undefined)
              .with({ _tag: "Success" }, ({ value: entry }) =>
                entry.key === k && verifyMutationEntryMac(hmacSecret, entry) ? entry : undefined,
              )
              .exhaustive()
            if (validEntry !== undefined) validEntries[validEntry.key] = validEntry
          }
          return validEntries
        })
        .exhaustive()
    })
    .exhaustive()
}

export const loadMutationCache = (
  repoRoot: string,
  hostIo: SyncHostIo,
  cacheAuth?: MutationCacheAuth,
): MutationCacheStore => {
  const localOutcome = match(loadMutationCacheWithStatus(repoRoot, hostIo, cacheAuth))
    .with({ _tag: "Loaded" }, ({ store, droppedEntryCount }) => {
      if (droppedEntryCount > 0)
        process.stderr.write(
          `[mutation-cache] Warning: Dropped ${droppedEntryCount} invalid/tampered cache entry(ies).\n`,
        )
      return { allowShared: true, store }
    })
    .with({ _tag: "Missing" }, () => ({ allowShared: true, store: emptyMutationCacheStore() }))
    .with({ _tag: "Corrupt" }, ({ reason, quarantinedPath }) => {
      process.stderr.write(
        `[mutation-cache] Warning: Corrupt cache (${reason})${quarantinedPath !== undefined ? ` (quarantined to ${quarantinedPath})` : ""}.\n`,
      )
      return { allowShared: true, store: emptyMutationCacheStore() }
    })
    .with({ _tag: "Unsafe" }, ({ reason }) => {
      process.stderr.write(`[mutation-cache] Warning: Unsafe cache path (${reason}).\n`)
      return { allowShared: false, store: emptyMutationCacheStore() }
    })
    .exhaustive()

  if (!localOutcome.allowShared) return localOutcome.store
  const hmacSecret = match(resolveCacheAuth(cacheAuth))
    .with({ _tag: "Ok" }, ({ hmacSecret: secret }) => secret)
    .with({ _tag: "Disabled" }, () => undefined)
    .exhaustive()
  if (hmacSecret === undefined) return localOutcome.store
  const commonRepoRoot = resolveLinkedWorktreeCommonRepoRoot(repoRoot, hostIo)
  if (commonRepoRoot === undefined) return localOutcome.store
  const sharedEntries = loadReadOnlySharedCacheEntries(commonRepoRoot, hostIo, hmacSecret)
  return {
    version: MUTATION_CACHE_SCHEMA_VERSION,
    entries: { ...sharedEntries, ...localOutcome.store.entries },
  }
}

const pruneCacheStore = (store: MutationCacheStore): MutationCacheStore => {
  const entriesList = Object.entries(store.entries)
  if (entriesList.length <= MAX_MUTATION_CACHE_ENTRIES) return store
  entriesList.sort((a, b) => {
    const byTime = compareCodeUnits(
      b[1].lastAccessedAt ?? b[1].recordedAt,
      a[1].lastAccessedAt ?? a[1].recordedAt,
    )
    return byTime !== 0 ? byTime : compareCodeUnits(a[0], b[0])
  })
  const prunedEntries: Record<ContentSha256, MutationCacheEntry> = {}
  for (const [, v] of entriesList.slice(0, MAX_MUTATION_CACHE_ENTRIES)) prunedEntries[v.key] = v
  return { version: MUTATION_CACHE_SCHEMA_VERSION, entries: prunedEntries }
}

export const saveMutationCacheAtomic = (
  repoRoot: string,
  store: MutationCacheStore,
  hostIo: SyncHostIo,
  cacheAuth?: MutationCacheAuth,
): SaveMutationCacheResult =>
  match(resolveCacheAuth(cacheAuth))
    .with({ _tag: "Disabled" }, ({ reason }) => ({ _tag: "Skipped" as const, reason }))
    .with({ _tag: "Ok" }, () =>
      match(resolveCachePaths(repoRoot, hostIo))
        .with({ _tag: "Unsafe" }, ({ reason }) => ({ _tag: "Skipped" as const, reason }))
        .with({ _tag: "Ok" }, ({ stateDir, cacheDir, cacheFile }) => {
          if (checkCacheAncestors(repoRoot, stateDir, cacheDir, hostIo) === undefined) {
            return {
              _tag: "Skipped" as const,
              reason: `unsafe cache ancestor path for '${cacheDir}'`,
            }
          }
          const mkdirRes = tryOrErr(
            () => hostIo.mkdirRecursiveSync(cacheDir),
            `mkdir failed for '${cacheDir}'`,
          )
          if (!mkdirRes.ok) return { _tag: "Failed" as const, reason: mkdirRes.err }
          const cacheFileExists = checkExists(cacheFile, hostIo)
          if (cacheFileExists === undefined)
            return { _tag: "Skipped" as const, reason: `failed to stat '${cacheFile}'` }
          const unsafeReason = validateCachePathSafety(
            repoRoot,
            stateDir,
            cacheDir,
            cacheFile,
            cacheFileExists,
            hostIo,
          )
          if (unsafeReason !== undefined) return { _tag: "Skipped" as const, reason: unsafeReason }
          if (isPathContained(resolve(repoRoot), resolve(stateDir))) {
            const repoReal = realpathOrUndefined(repoRoot, hostIo)
            const dirReal = realpathOrUndefined(cacheDir, hostIo)
            if (
              repoReal === undefined ||
              dirReal === undefined ||
              !isPathContained(repoReal, dirReal)
            ) {
              return {
                _tag: "Skipped" as const,
                reason: `cache dir escapes repoRoot '${repoRoot}'`,
              }
            }
          }
          const encRes = tryOrErr(
            () =>
              Schema.encodeSync(Schema.fromJsonString(MutationCacheStore))(pruneCacheStore(store)),
            "encode failed",
          )
          if (!encRes.ok) return { _tag: "Failed" as const, reason: encRes.err }
          const tmpPath = join(
            cacheDir,
            `.mutation-cache-v3.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
          )
          const writeRes = tryOrErr(() => {
            hostIo.writeTextSync(tmpPath, encRes.v)
            hostIo.renameSync(tmpPath, cacheFile)
          }, "atomic write failed")
          if (!writeRes.ok) {
            Result.try(() => {
              if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
            })
            return { _tag: "Failed" as const, reason: writeRes.err }
          }
          return { _tag: "Saved" as const }
        })
        .exhaustive(),
    )
    .exhaustive()
