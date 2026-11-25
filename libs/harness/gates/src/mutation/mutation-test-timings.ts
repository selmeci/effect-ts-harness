/**
 * @fileoverview Non-authoritative adaptive test-duration timing cache and Vitest baseline parser (`REQ-3.1..REQ-3.3`).
 */
import { randomBytes } from "node:crypto"
import { isAbsolute, join, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AstSourceFilePath,
  type ContentSha256,
  MUTATION_HEAVY_TEST_THRESHOLD_MS,
  MUTATION_TEST_TIMING_EMA_ALPHA,
  MUTATION_TEST_TIMINGS_FILENAME,
  MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
  MutationCacheTimestamp,
  type MutationTestTimingEntry,
  MutationTestTimingKey,
  MutationTestTimingsStore,
  type MutationTestTimingsVersion,
  PackageRelKey,
  TestTimingDurationMs,
  TestTimingSampleCount,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { resolveHarnessStateDir } from "../worktree.js"
import {
  resolveLinkedWorktreeCommonRepoRoot,
  validateHarnessCacheFileSafety,
} from "./mutation-cache.js"
import {
  checkExists,
  isNonSymlink,
  readSafeText,
  unwrapOption,
  unwrapResult,
} from "./mutation-context-digest.js"
import {
  matchNormalizedTestCandidate,
  normalizeRepoRelTestPath,
  stripAnsi,
} from "./mutation-witness.js"

const MAX_TIMINGS_FILE_BYTES = 8 * 1024 * 1024
const MAX_TIMINGS_ENTRIES = 4096
const TIMINGS_VERSION: MutationTestTimingsVersion = MUTATION_TEST_TIMINGS_SCHEMA_VERSION
const HEAVY_META_TEST_BASENAMES: ReadonlySet<string> = new Set(
  (
    "mutation-check.test.ts,mutation-speedup.test.ts,mutation-cache.test.ts," +
    "mutation-cache-hardening.test.ts,mutation-scoped-fallback.test.ts," +
    "self-dogfooding-capability-plugins.test.ts,self-dogfooding-governance-plugins.test.ts," +
    "self-dogfooding-plugin-harness.test.ts,milestone5-dst-ears-mutation-dpo.test.ts," +
    "policy-check.test.ts,policy-check-architecture-and-layers.test.ts," +
    "policy-check-patterns-and-types.test.ts,type-extractor.test.ts,governance-nodes.test.ts," +
    "graph-projector.test.ts,structural-search.test.ts,workflow-graph-assets.test.ts," +
    "workflow-graph-assets-sync.test.ts,ts-compiler-overlay-service.test.ts"
  ).split(","),
)

export const isHeavyMetaTestAbsPath = (testAbsPath: string): boolean =>
  HEAVY_META_TEST_BASENAMES.has(testAbsPath.split(/[/\\]/).pop() ?? testAbsPath)

export const lookupMeasuredTestDurationMs = (
  testAbsPath: string,
  measuredDurationMsByAbsPath?: ReadonlyMap<string, number>,
): number | undefined =>
  measuredDurationMsByAbsPath === undefined || measuredDurationMsByAbsPath.size === 0
    ? undefined
    : (measuredDurationMsByAbsPath.get(testAbsPath) ??
      measuredDurationMsByAbsPath.get(resolve(testAbsPath)))

export const isHeavyTestByTimingOrStatic = (
  testAbsPath: string,
  measuredDurationMsByAbsPath?: ReadonlyMap<string, number>,
): boolean => {
  const measured = lookupMeasuredTestDurationMs(testAbsPath, measuredDurationMsByAbsPath)
  return measured !== undefined
    ? measured >= MUTATION_HEAVY_TEST_THRESHOLD_MS
    : isHeavyMetaTestAbsPath(testAbsPath)
}

export const emptyMutationTestTimingsStore = (): MutationTestTimingsStore => ({
  version: TIMINGS_VERSION,
  entries: {},
})

export const buildTimingEntryKey = (
  pkgKey: PackageRelKey,
  relTestFile: AstSourceFilePath,
): MutationTestTimingKey => MutationTestTimingKey.make(`${pkgKey}::${relTestFile}`)

export const computeNextEmaDurationMs = (
  prevMs: number | undefined,
  observedMs: number,
  alpha = MUTATION_TEST_TIMING_EMA_ALPHA,
): TestTimingDurationMs => {
  const clampedObs = Number.isFinite(observedMs) ? Math.max(0, observedMs) : 0
  const a = Number.isFinite(alpha)
    ? Math.min(1, Math.max(0, alpha))
    : MUTATION_TEST_TIMING_EMA_ALPHA
  return TestTimingDurationMs.make(
    prevMs === undefined || !Number.isFinite(prevMs)
      ? clampedObs
      : Math.max(0, prevMs) * (1 - a) + clampedObs * a,
  )
}

const tryOr = <A>(fn: () => A): A | undefined => unwrapOption(unwrapResult(Result.try(fn)))
const isSymlinkKnown = (p: string, hostIo: SyncHostIo): boolean =>
  tryOr(() => hostIo.isSymbolicLinkSync(p)) === true

const resolveSafeTimingsPaths = (repoRoot: string, hostIo: SyncHostIo) => {
  const stateDir = tryOr(() => resolveHarnessStateDir(repoRoot, hostIo.getEnv()))
  if (stateDir === undefined) return undefined
  const cacheDir = join(stateDir, "cache")
  const timingsFile = join(cacheDir, MUTATION_TEST_TIMINGS_FILENAME)
  if (
    isSymlinkKnown(timingsFile, hostIo) ||
    validateHarnessCacheFileSafety(repoRoot, timingsFile, false, hostIo) !== undefined
  ) {
    return undefined
  }
  return { cacheDir, timingsFile }
}

type ReadTimingsOutcome =
  | { readonly _tag: "Loaded"; readonly store: MutationTestTimingsStore }
  | { readonly _tag: "MissingSafe" }
  | { readonly _tag: "Rejected" }

const readLocalTimingsStore = (repoRoot: string, hostIo: SyncHostIo): ReadTimingsOutcome => {
  const paths = resolveSafeTimingsPaths(repoRoot, hostIo)
  if (paths === undefined) return { _tag: "Rejected" }
  const exists = checkExists(paths.timingsFile, hostIo)
  if (exists === undefined) return { _tag: "Rejected" }
  if (!exists) return { _tag: "MissingSafe" }
  if (validateHarnessCacheFileSafety(repoRoot, paths.timingsFile, true, hostIo) !== undefined) {
    return { _tag: "Rejected" }
  }
  const raw = unwrapOption(readSafeText(paths.timingsFile, hostIo))
  if (raw === undefined || Buffer.byteLength(raw, "utf8") > MAX_TIMINGS_FILE_BYTES) {
    return { _tag: "Rejected" }
  }
  return match(Schema.decodeExit(Schema.fromJsonString(MutationTestTimingsStore))(raw))
    .with({ _tag: "Success" }, ({ value }) => ({ _tag: "Loaded" as const, store: value }))
    .with({ _tag: "Failure" }, () => ({ _tag: "Rejected" as const }))
    .exhaustive()
}

export const loadMutationTestTimings = (
  repoRoot: string,
  hostIo: SyncHostIo,
): MutationTestTimingsStore =>
  match(readLocalTimingsStore(repoRoot, hostIo))
    .with({ _tag: "Loaded" }, ({ store }) => store)
    .with({ _tag: "Rejected" }, () => emptyMutationTestTimingsStore())
    .with({ _tag: "MissingSafe" }, () => {
      const commonRoot = resolveLinkedWorktreeCommonRepoRoot(repoRoot, hostIo)
      if (commonRoot === undefined) return emptyMutationTestTimingsStore()
      return match(readLocalTimingsStore(commonRoot, { ...hostIo, getEnv: () => ({}) }))
        .with({ _tag: "Loaded" }, ({ store }) => store)
        .with({ _tag: "MissingSafe" }, { _tag: "Rejected" }, () => emptyMutationTestTimingsStore())
        .exhaustive()
    })
    .exhaustive()

const mergeAndCapTimingsStore = (
  diskStore: MutationTestTimingsStore,
  incomingStore: MutationTestTimingsStore,
): MutationTestTimingsStore => {
  const merged: Record<MutationTestTimingKey, MutationTestTimingEntry> = { ...diskStore.entries }
  for (const [rawKey, incoming] of Object.entries(incomingStore.entries)) {
    const key = MutationTestTimingKey.make(rawKey)
    const cur = Object.hasOwn(merged, key) ? merged[key] : undefined
    const incMs = Date.parse(incoming.updatedAt)
    const curMs = cur === undefined ? Number.NEGATIVE_INFINITY : Date.parse(cur.updatedAt)
    if (
      cur === undefined ||
      incMs > curMs ||
      (incMs === curMs && incoming.sampleCount >= cur.sampleCount)
    ) {
      merged[key] = incoming
    }
  }
  const sorted = Object.entries(merged).sort(([aKey, a], [bKey, b]) => {
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    return byTime !== 0 ? byTime : compareCodeUnits(aKey, bKey)
  })
  const entries: Record<MutationTestTimingKey, MutationTestTimingEntry> = {}
  for (const [k, v] of sorted.slice(0, MAX_TIMINGS_ENTRIES))
    entries[MutationTestTimingKey.make(k)] = v
  return { version: TIMINGS_VERSION, entries }
}

export const saveMutationTestTimingsAtomic = (
  repoRoot: string,
  store: MutationTestTimingsStore,
  hostIo: SyncHostIo,
): boolean => {
  const paths = resolveSafeTimingsPaths(repoRoot, hostIo)
  if (
    paths === undefined ||
    tryOr(() => {
      hostIo.mkdirRecursiveSync(paths.cacheDir)
      return true
    }) !== true ||
    tryOr(() => hostIo.isDirectorySync(paths.cacheDir)) !== true
  )
    return false
  const exists = checkExists(paths.timingsFile, hostIo)
  if (
    exists === undefined ||
    isSymlinkKnown(paths.timingsFile, hostIo) ||
    validateHarnessCacheFileSafety(repoRoot, paths.timingsFile, exists, hostIo) !== undefined
  )
    return false
  const diskStore = match(readLocalTimingsStore(repoRoot, hostIo))
    .with({ _tag: "Loaded" }, ({ store: s }) => s)
    .with({ _tag: "MissingSafe" }, { _tag: "Rejected" }, () => emptyMutationTestTimingsStore())
    .exhaustive()
  const encoded = tryOr(() =>
    Schema.encodeSync(Schema.fromJsonString(MutationTestTimingsStore))(
      mergeAndCapTimingsStore(diskStore, store),
    ),
  )
  if (encoded === undefined) return false
  const tmpPath = join(
    paths.cacheDir,
    `.mutation-test-timings-v1.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  )
  const ok = tryOr(() => {
    hostIo.writeTextSync(tmpPath, encoded)
    hostIo.renameSync(tmpPath, paths.timingsFile)
    return true
  })
  if (ok === true) return true
  tryOr(() => {
    if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
  })
  return false
}

const decodePkgKey = (pkgKey: string): PackageRelKey | undefined =>
  match(Schema.decodeExit(PackageRelKey)(pkgKey))
    .with({ _tag: "Success" }, ({ value }) => value)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()

const hashVerifiedTestFile = (
  absPath: string,
  hostIo: SyncHostIo,
  shaCache?: Map<string, ContentSha256>,
): ContentSha256 | undefined => {
  if (!isNonSymlink(absPath, hostIo) || tryOr(() => hostIo.isFileSync(absPath)) !== true)
    return undefined
  const cached = shaCache?.get(absPath)
  if (cached !== undefined) return cached
  const content = unwrapOption(readSafeText(absPath, hostIo))
  if (content === undefined) return undefined
  const sha = computeContentSha256(content)
  shaCache?.set(absPath, sha)
  return sha
}

export const buildVerifiedTestTimingLookup = (
  input: {
    readonly repoRoot: string
    readonly pkgKey: string
    readonly testAbsPaths: ReadonlyArray<string>
    readonly store: MutationTestTimingsStore
    readonly hostIo: SyncHostIo
  },
  shaCache?: Map<string, ContentSha256>,
): ReadonlyMap<string, number> => {
  const out = new Map<string, number>()
  const validPkgKey = decodePkgKey(input.pkgKey)
  if (validPkgKey === undefined) return out
  const resolvedRoot = resolve(input.repoRoot)
  for (const rawAbs of input.testAbsPaths) {
    const absPath = isAbsolute(rawAbs) ? resolve(rawAbs) : resolve(resolvedRoot, rawAbs)
    const relTestFile = unwrapOption(normalizeRepoRelTestPath(resolvedRoot, absPath))
    if (relTestFile === undefined) continue
    const key = buildTimingEntryKey(validPkgKey, relTestFile)
    const entry = Object.hasOwn(input.store.entries, key) ? input.store.entries[key] : undefined
    if (entry === undefined || entry.pkgKey !== validPkgKey || entry.relTestFile !== relTestFile)
      continue
    const sha = hashVerifiedTestFile(absPath, input.hostIo, shaCache)
    if (sha !== undefined && sha === entry.contentSha256) out.set(absPath, entry.emaDurationMs)
  }
  return out
}

export const recordObservedTestTimings = (
  input: {
    readonly repoRoot: string
    readonly pkgKey: string
    readonly observedByRelOrAbs: ReadonlyMap<string, number> | Readonly<Record<string, number>>
    readonly store: MutationTestTimingsStore
    readonly nowMs: number
    readonly hostIo: SyncHostIo
  },
  shaCache?: Map<string, ContentSha256>,
): { readonly store: MutationTestTimingsStore; readonly dirty: boolean } => {
  const validPkgKey = decodePkgKey(input.pkgKey)
  const updatedAt =
    Number.isFinite(input.nowMs) && input.nowMs >= 0
      ? tryOr(() => Schema.decodeSync(MutationCacheTimestamp)(new Date(input.nowMs).toISOString()))
      : undefined
  if (validPkgKey === undefined || updatedAt === undefined)
    return { store: input.store, dirty: false }
  const pairs: ReadonlyArray<readonly [string, number]> =
    input.observedByRelOrAbs instanceof Map
      ? Array.from(input.observedByRelOrAbs.entries())
      : Object.entries(input.observedByRelOrAbs)
  const nextEntries: Record<MutationTestTimingKey, MutationTestTimingEntry> = {
    ...input.store.entries,
  }
  let dirty = false
  for (const [rawPath, observedMs] of pairs) {
    if (typeof observedMs !== "number" || !Number.isFinite(observedMs) || observedMs < 0) continue
    const relTestFile = unwrapOption(normalizeRepoRelTestPath(input.repoRoot, rawPath))
    if (relTestFile === undefined) continue
    const sha = hashVerifiedTestFile(resolve(input.repoRoot, relTestFile), input.hostIo, shaCache)
    if (sha === undefined) continue
    const key = buildTimingEntryKey(validPkgKey, relTestFile)
    const prev = Object.hasOwn(nextEntries, key) ? nextEntries[key] : undefined
    const keepEma =
      prev !== undefined &&
      prev.pkgKey === validPkgKey &&
      prev.relTestFile === relTestFile &&
      prev.contentSha256 === sha
    nextEntries[key] = {
      pkgKey: validPkgKey,
      relTestFile,
      contentSha256: sha,
      emaDurationMs: computeNextEmaDurationMs(keepEma ? prev.emaDurationMs : undefined, observedMs),
      sampleCount: TestTimingSampleCount.make(keepEma ? prev.sampleCount + 1 : 1),
      updatedAt,
    }
    dirty = true
  }
  return { store: dirty ? { version: TIMINGS_VERSION, entries: nextEntries } : input.store, dirty }
}

export const createSuiteTimingsTracker = (repoRoot: string, hostIo: SyncHostIo) => {
  let store: MutationTestTimingsStore | undefined = undefined
  let dirty = false
  const shaCache = new Map<string, ContentSha256>()
  const ensureStore = (): MutationTestTimingsStore =>
    (store ??= loadMutationTestTimings(repoRoot, hostIo))
  return {
    lookupForPackage: (
      pkgKey: string,
      testAbsPaths: ReadonlyArray<string>,
    ): ReadonlyMap<string, number> =>
      buildVerifiedTestTimingLookup(
        { repoRoot, pkgKey, testAbsPaths, store: ensureStore(), hostIo },
        shaCache,
      ),
    recordObserved: (
      pkgKey: string,
      observed: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
      nowMs = Date.now(),
    ): void => {
      const res = recordObservedTestTimings(
        { repoRoot, pkgKey, observedByRelOrAbs: observed, store: ensureStore(), nowMs, hostIo },
        shaCache,
      )
      if (res.dirty) {
        store = res.store
        dirty = true
      }
    },
    flushIfDirty: (): void => {
      if (dirty && store !== undefined && saveMutationTestTimingsAtomic(repoRoot, store, hostIo))
        dirty = false
    },
  }
}

const VITEST_DURATION_LINE_RE =
  /^\s*[✓✔]\s+(?:\|[^|]+\|\s+)?(.+?)(?:\s+\([^)]*\))?\s+(\d+(?:\.\d+)?)(ms|s)(?:\s+\d+\s+MB heap used)?\s*$/

export const parseVitestBaselineTestDurations = (
  stdout: string,
  repoRoot: string,
  testFiles: ReadonlyArray<string>,
  fallbackElapsedMs?: number,
): ReadonlyMap<string, number> => {
  const targetRelList: Array<AstSourceFilePath> = []
  const targetRelSet = new Set<AstSourceFilePath>()
  for (const raw of testFiles) {
    const norm = unwrapOption(normalizeRepoRelTestPath(repoRoot, raw))
    if (norm !== undefined && !targetRelSet.has(norm)) {
      targetRelSet.add(norm)
      targetRelList.push(norm)
    }
  }
  const out = new Map<string, number>()
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const m = VITEST_DURATION_LINE_RE.exec(line)
    if (m === null) continue
    const cand = unwrapOption(normalizeRepoRelTestPath(repoRoot, m[1] ?? ""))
    if (cand === undefined) continue
    const hit = matchNormalizedTestCandidate(cand, targetRelSet, targetRelList)
    if (hit === undefined) continue
    const ms = m[3] === "s" ? Number(m[2]) * 1000 : Number(m[2])
    if (Number.isFinite(ms) && ms >= 0) out.set(hit, ms)
  }
  if (
    out.size === 0 &&
    targetRelList.length === 1 &&
    fallbackElapsedMs !== undefined &&
    Number.isFinite(fallbackElapsedMs) &&
    fallbackElapsedMs >= 0
  ) {
    out.set(targetRelList[0]!, fallbackElapsedMs)
  }
  return out
}
