import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ContentSha256,
  MUTATION_CACHE_SCHEMA_VERSION,
  type MutationCacheEntry,
  MutationCacheLookupDecision,
  type MutationCacheLookupInput,
  MutationCacheStore,
  NonNegativeCount,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"
import { isWorkspaceTsSourceFileName } from "../workspace-ts-scan.js"
import { resolveHarnessStateDir } from "../worktree.js"
import type { CodeMutant } from "./mutant-ast-generator.js"

export const MAX_MUTATION_CACHE_ENTRIES = 5000

const MUTATION_CACHE_FILENAME = "mutation-cache-v1.json"

export interface MutationContextDigests {
  readonly workspaceSrcDigest: ContentSha256
  readonly testSupportDigests: ReadonlyMap<string, ContentSha256>
}

export const emptyMutationCacheStore = (): MutationCacheStore => ({
  version: MUTATION_CACHE_SCHEMA_VERSION,
  entries: {},
})

export const partitionMutationCacheLookup = (
  input: MutationCacheLookupInput,
): MutationCacheLookupDecision => {
  const hitKeys: Array<ContentSha256> = []
  const missKeys: Array<ContentSha256> = []
  for (const candidateKey of input.candidateKeys) {
    const entry = Object.hasOwn(input.store.entries, candidateKey)
      ? input.store.entries[candidateKey]
      : undefined
    const isHit =
      entry !== undefined &&
      match(entry.status)
        .with("killed", () => entry.key === candidateKey)
        .exhaustive()
    if (isHit) {
      hitKeys.push(candidateKey)
    } else {
      missKeys.push(candidateKey)
    }
  }
  return {
    hitKeys,
    missKeys,
    hitCount: NonNegativeCount.make(hitKeys.length),
    missCount: NonNegativeCount.make(missKeys.length),
  }
}

export const decideMutationCacheLookup = Effect.fn("MutationCache.decide")(function* (
  input: MutationCacheLookupInput,
): Effect.fn.Return<MutationCacheLookupDecision> {
  return yield* Effect.succeed(partitionMutationCacheLookup(input))
})

export const MutationCache = {
  decide: decideMutationCacheLookup,
} as const

const unwrapResult = <A>(res: Result.Result<A, unknown>): Option.Option<A> =>
  match(res)
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()

const unwrapOption = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const checkExists = (targetPath: string, hostIo: SyncHostIo): boolean | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.existsSync(targetPath))))

const isFileSafe = (targetPath: string, hostIo: SyncHostIo): boolean =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.isFileSync(targetPath)))) ?? false

const isNonSymlink = (targetPath: string, hostIo: SyncHostIo): boolean =>
  match(unwrapResult(Result.try(() => hostIo.isSymbolicLinkSync(targetPath))))
    .with({ _tag: "Some" }, ({ value }) => !value)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

const realpathOrUndefined = (targetPath: string, hostIo: SyncHostIo): string | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.realpathSync(targetPath))))

const readSafeText = (filePath: string, hostIo: SyncHostIo): Option.Option<string> =>
  isNonSymlink(filePath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readTextSync(filePath)))
    : Option.none()

const readdirSafe = (
  dirPath: string,
  hostIo: SyncHostIo,
): Option.Option<ReadonlyArray<SyncHostDirEntry>> =>
  isNonSymlink(dirPath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readdirSync(dirPath)))
    : Option.none()

const collectDirFiles = (
  baseDir: string,
  relPrefix: string,
  excludedDirs: ReadonlySet<string>,
  includeFile: (name: string) => boolean,
  hostIo: SyncHostIo,
  outRelPaths: Array<string>,
): boolean => {
  const entries = match(readdirSafe(baseDir, hostIo))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (entries === undefined) return false
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const entry of sorted) {
    const childFull = join(baseDir, entry.name)
    const childRel = `${relPrefix}/${entry.name}`
    if (!isNonSymlink(childFull, hostIo)) return false
    const ok = match(entry)
      .with({ isDirectory: true }, () =>
        excludedDirs.has(entry.name)
          ? true
          : collectDirFiles(childFull, childRel, excludedDirs, includeFile, hostIo, outRelPaths),
      )
      .with({ isDirectory: false, isFile: true }, () => {
        if (includeFile(entry.name)) outRelPaths.push(childRel)
        return true
      })
      .with({ isDirectory: false, isFile: false }, () => false)
      .exhaustive()
    if (!ok) return false
  }
  return true
}

const isTestFile = (name: string): boolean =>
  name.endsWith(".test.ts") ||
  name.endsWith(".spec.ts") ||
  name.endsWith(".test.tsx") ||
  name.endsWith(".spec.tsx")

const hashRelFiles = (
  repoRoot: string,
  relPaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
): Option.Option<ContentSha256> => {
  const sorted = [...relPaths].sort(compareCodeUnits)
  const pairs: Array<readonly [string, ContentSha256]> = []
  for (const relPath of sorted) {
    const content = match(readSafeText(join(repoRoot, relPath), hostIo))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (content === undefined) return Option.none()
    pairs.push([relPath, computeContentSha256(content)])
  }
  return Option.some(computeContentSha256(JSON.stringify(pairs)))
}

const SRC_EXCLUDED_DIRS = new Set(["test", "dist", "node_modules"])
const TEST_EXCLUDED_DIRS = new Set(["dist", "node_modules"])
const ROOT_CONTEXT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "vitest.config.ts",
  "tools/parallel-vitest-batch.mjs",
  "tools/node-ts-resolver.mjs",
] as const
const PKG_CONFIG_FILES = ["package.json", "tsconfig.json", "tsconfig.lib.json", "vitest.config.ts"]

export const computeMutationContextDigests = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Option.Option<MutationContextDigests> => {
  const workspaceRelFiles: Array<string> = []
  const testSupportDigests = new Map<string, ContentSha256>()

  for (const topFile of ROOT_CONTEXT_FILES) {
    const exists = checkExists(join(repoRoot, topFile), hostIo)
    if (exists === undefined) return Option.none()
    if (exists) workspaceRelFiles.push(topFile)
  }

  const oxlintDir = join(repoRoot, "tools", "oxlint")
  const hasOxlint = checkExists(oxlintDir, hostIo)
  if (hasOxlint === undefined) return Option.none()
  if (
    hasOxlint &&
    !collectDirFiles(
      oxlintDir,
      "tools/oxlint",
      TEST_EXCLUDED_DIRS,
      () => true,
      hostIo,
      workspaceRelFiles,
    )
  ) {
    return Option.none()
  }

  const libsDir = join(repoRoot, "libs")
  const libsExists = checkExists(libsDir, hostIo)
  if (libsExists === undefined) return Option.none()

  if (libsExists) {
    const scopes = match(readdirSafe(libsDir, hostIo))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (scopes === undefined) return Option.none()
    for (const scope of [...scopes].sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (!scope.isDirectory || scope.name === "node_modules") continue
      const scopeDir = join(libsDir, scope.name)
      const pkgs = match(readdirSafe(scopeDir, hostIo))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (pkgs === undefined) return Option.none()
      for (const pkg of [...pkgs].sort((a, b) => compareCodeUnits(a.name, b.name))) {
        if (!pkg.isDirectory || pkg.name === "node_modules") continue
        const pkgKey = `${scope.name}/${pkg.name}`
        const pkgDir = join(scopeDir, pkg.name)

        for (const cfgFile of PKG_CONFIG_FILES) {
          const hasCfg = checkExists(join(pkgDir, cfgFile), hostIo)
          if (hasCfg === undefined) return Option.none()
          if (hasCfg) workspaceRelFiles.push(`libs/${pkgKey}/${cfgFile}`)
        }

        const srcDir = join(pkgDir, "src")
        const hasSrc = checkExists(srcDir, hostIo)
        if (hasSrc === undefined) return Option.none()
        if (
          hasSrc &&
          !collectDirFiles(
            srcDir,
            `libs/${pkgKey}/src`,
            SRC_EXCLUDED_DIRS,
            isWorkspaceTsSourceFileName,
            hostIo,
            workspaceRelFiles,
          )
        ) {
          return Option.none()
        }

        const supportFiles: Array<string> = []
        const hasVitestConfig = checkExists(join(pkgDir, "vitest.config.ts"), hostIo)
        if (hasVitestConfig === undefined) return Option.none()
        if (hasVitestConfig) supportFiles.push(`libs/${pkgKey}/vitest.config.ts`)

        const testDir = join(pkgDir, "test")
        const hasTestDir = checkExists(testDir, hostIo)
        if (hasTestDir === undefined) return Option.none()
        if (
          hasTestDir &&
          !collectDirFiles(
            testDir,
            `libs/${pkgKey}/test`,
            TEST_EXCLUDED_DIRS,
            (name) => !isTestFile(name),
            hostIo,
            supportFiles,
          )
        ) {
          return Option.none()
        }
        for (const sf of supportFiles) {
          if (sf !== `libs/${pkgKey}/vitest.config.ts`) workspaceRelFiles.push(sf)
        }
        if (hasVitestConfig || hasTestDir) {
          const supportDigest = match(hashRelFiles(repoRoot, supportFiles, hostIo))
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
          if (supportDigest === undefined) return Option.none()
          testSupportDigests.set(pkgKey, supportDigest)
        }
      }
    }
  }

  const wsDigest = match(hashRelFiles(repoRoot, workspaceRelFiles, hostIo))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (wsDigest === undefined) return Option.none()
  return Option.some({ workspaceSrcDigest: wsDigest, testSupportDigests })
}

export const computeMutantCacheKey = (
  repoRoot: string,
  pkgKey: string,
  relFile: string,
  originalContentSha256: ContentSha256,
  compiledSchemaSha256: ContentSha256,
  mutant: CodeMutant,
  reachingTests: ReadonlyArray<string>,
  digests: MutationContextDigests,
  hostIo: SyncHostIo,
): Option.Option<ContentSha256> => {
  const sortedTests = [...reachingTests].sort(compareCodeUnits)
  const hashedReachingTests: Array<readonly [string, ContentSha256]> = []
  for (const testPath of sortedTests) {
    const fullPath = isAbsolute(testPath) ? testPath : join(repoRoot, testPath)
    const relTestPath = relative(repoRoot, fullPath).replace(/\\/g, "/")
    const content = match(readSafeText(fullPath, hostIo))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (content === undefined) return Option.none()
    hashedReachingTests.push([relTestPath, computeContentSha256(content)])
  }
  const payload = JSON.stringify({
    v: MUTATION_CACHE_SCHEMA_VERSION,
    relFile,
    originalContentSha256,
    compiledSchemaSha256,
    id: mutant.id,
    line: mutant.line,
    category: mutant.category,
    original: mutant.original,
    replacement: mutant.replacement,
    ws: digests.workspaceSrcDigest,
    ts: digests.testSupportDigests.get(pkgKey) ?? "",
    tests: hashedReachingTests,
  })
  return Option.some(computeContentSha256(payload))
}

const isPathContained = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const checkCacheAncestors = (
  repoRoot: string,
  stateDir: string,
  cacheDir: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (!isNonSymlink(repoRoot, hostIo)) return undefined
  const resolvedRoot = resolve(repoRoot)
  const stateInRepo = isPathContained(resolvedRoot, resolve(stateDir))
  let cur = resolve(cacheDir)
  let deepestExisting: string | undefined = undefined
  while (true) {
    const exists = checkExists(cur, hostIo)
    if (exists === undefined) return undefined
    if (exists) {
      if (!isNonSymlink(cur, hostIo)) return undefined
      if (deepestExisting === undefined) deepestExisting = cur
    }
    if (
      cur === resolvedRoot ||
      (!stateInRepo && cur === resolve(stateDir)) ||
      cur === dirname(cur)
    ) {
      break
    }
    cur = dirname(cur)
  }
  if (deepestExisting === undefined) return undefined
  if (stateInRepo) {
    const rootReal = realpathOrUndefined(repoRoot, hostIo)
    const deepReal = realpathOrUndefined(deepestExisting, hostIo)
    if (rootReal === undefined || deepReal === undefined || !isPathContained(rootReal, deepReal)) {
      return undefined
    }
  }
  return deepestExisting
}

export const loadMutationCache = (repoRoot: string, hostIo: SyncHostIo): MutationCacheStore => {
  const stateDir = resolveHarnessStateDir(repoRoot)
  const cacheDir = join(stateDir, "cache")
  const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)
  if (checkExists(cacheFile, hostIo) !== true) return emptyMutationCacheStore()
  if (checkCacheAncestors(repoRoot, stateDir, cacheDir, hostIo) === undefined) {
    return emptyMutationCacheStore()
  }
  if (
    !isNonSymlink(stateDir, hostIo) ||
    !isNonSymlink(cacheDir, hostIo) ||
    !isNonSymlink(cacheFile, hostIo) ||
    !isFileSafe(cacheFile, hostIo)
  ) {
    return emptyMutationCacheStore()
  }
  const stateReal = realpathOrUndefined(stateDir, hostIo)
  const fileReal = realpathOrUndefined(cacheFile, hostIo)
  if (stateReal === undefined || fileReal === undefined || !isPathContained(stateReal, fileReal)) {
    return emptyMutationCacheStore()
  }
  const raw = match(readSafeText(cacheFile, hostIo))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (raw === undefined) return emptyMutationCacheStore()
  return match(Schema.decodeOption(Schema.fromJsonString(MutationCacheStore))(raw))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => emptyMutationCacheStore())
    .exhaustive()
}

const pruneCacheStore = (store: MutationCacheStore): MutationCacheStore => {
  const entriesList = Object.entries(store.entries)
  if (entriesList.length <= MAX_MUTATION_CACHE_ENTRIES) return store
  entriesList.sort((a, b) => {
    const byTime = compareCodeUnits(b[1].recordedAt, a[1].recordedAt)
    return byTime !== 0 ? byTime : compareCodeUnits(a[0], b[0])
  })
  const prunedEntries: Record<ContentSha256, MutationCacheEntry> = {}
  for (const [, v] of entriesList.slice(0, MAX_MUTATION_CACHE_ENTRIES)) {
    prunedEntries[v.key] = v
  }
  return { version: MUTATION_CACHE_SCHEMA_VERSION, entries: prunedEntries }
}

export const saveMutationCacheAtomic = (
  repoRoot: string,
  store: MutationCacheStore,
  hostIo: SyncHostIo,
): void => {
  const res = Result.try(() => {
    const stateDir = resolveHarnessStateDir(repoRoot)
    const cacheDir = join(stateDir, "cache")
    const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)
    if (checkCacheAncestors(repoRoot, stateDir, cacheDir, hostIo) === undefined) return
    hostIo.mkdirRecursiveSync(cacheDir)
    if (!isNonSymlink(stateDir, hostIo) || !isNonSymlink(cacheDir, hostIo)) return
    const cacheFileExists = checkExists(cacheFile, hostIo)
    if (cacheFileExists === undefined) return
    if (cacheFileExists && (!isNonSymlink(cacheFile, hostIo) || !isFileSafe(cacheFile, hostIo))) {
      return
    }
    const stateReal = hostIo.realpathSync(stateDir)
    const cacheDirReal = hostIo.realpathSync(cacheDir)
    if (!isPathContained(stateReal, cacheDirReal)) return
    if (isPathContained(resolve(repoRoot), resolve(stateDir))) {
      if (!isPathContained(hostIo.realpathSync(repoRoot), cacheDirReal)) return
    }

    const pruned = pruneCacheStore(store)
    const encoded = Schema.encodeSync(Schema.fromJsonString(MutationCacheStore))(pruned)
    const tmpPath = join(
      cacheDir,
      `.mutation-cache-v1.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    )
    const writeRes = Result.try(() => {
      hostIo.writeTextSync(tmpPath, encoded)
      hostIo.renameSync(tmpPath, cacheFile)
    })
    match(writeRes)
      .with({ _tag: "Success" }, () => {})
      .with({ _tag: "Failure" }, () => {
        Result.try(() => {
          if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
        })
      })
      .exhaustive()
  })
  match(res)
    .with({ _tag: "Success" }, () => {})
    .with({ _tag: "Failure" }, () => {})
    .exhaustive()
}
