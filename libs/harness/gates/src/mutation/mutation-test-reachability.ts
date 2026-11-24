/**
 * @fileoverview Static reverse-import test reachability index per package for narrowing mutation target test suites.
 */
import { basename, isAbsolute, join, posix, relative } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"

const HEAVY_META_TEST_BASENAMES: ReadonlySet<string> = new Set([
  "mutation-check.test.ts",
  "mutation-speedup.test.ts",
  "self-dogfooding-capability-plugins.test.ts",
  "self-dogfooding-plugin-harness.test.ts",
  "milestone5-dst-ears-mutation-dpo.test.ts",
  "policy-check.test.ts",
  "type-extractor.test.ts",
  "graph-projector.test.ts",
  "structural-search.test.ts",
  "workflow-graph-assets.test.ts",
  "ts-compiler-overlay-service.test.ts",
])

export interface PackageReachabilityIndex {
  readonly pkgDirRel: string
  readonly barrelRel: string
  readonly revNoBarrel: ReadonlyMap<string, ReadonlySet<string>>
  readonly revFull: ReadonlyMap<string, ReadonlySet<string>>
  readonly testSourceByAbsPath: ReadonlyMap<string, string>
  readonly testLineCountByAbsPath: ReadonlyMap<string, number>
  readonly absByRelPath: ReadonlyMap<string, string>
}

export type BuildReachabilityIndexResult =
  | { readonly _tag: "Ok"; readonly index: PackageReachabilityIndex }
  | { readonly _tag: "Error"; readonly reason: string }

export interface ReverseImportReachability {
  readonly nonBarrelTests: ReadonlyArray<string>
  readonly allStaticImporterTests: ReadonlyArray<string>
}

const formatErr = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const collectTsFilesInDirChecked = (
  repoRoot: string,
  dir: string,
  hostIo: SyncHostIo,
  outRelToAbs: Map<string, string>,
): Result.Result<void, string> => {
  const existsRes = Result.try({
    try: () => hostIo.existsSync(dir),
    catch: (err) => `Failed to stat '${dir}': ${formatErr(err)}`,
  })
  return Result.flatMap(existsRes, (exists) => {
    if (!exists) return Result.succeed(undefined)
    const walk = (curDir: string): Result.Result<void, string> =>
      Result.flatMap(
        Result.try({
          try: () => hostIo.isSymbolicLinkSync(curDir),
          catch: (err) => `Failed to check symlink '${curDir}': ${formatErr(err)}`,
        }),
        (isSym) => {
          if (isSym) return Result.fail(`Refusing symlink directory '${curDir}'`)
          return Result.flatMap(
            Result.try({
              try: () => hostIo.readdirSync(curDir),
              catch: (err) => `Failed to read directory '${curDir}': ${formatErr(err)}`,
            }),
            (rawEntries: ReadonlyArray<SyncHostDirEntry>) => {
              const sorted = [...rawEntries].sort((a, b) => compareCodeUnits(a.name, b.name))
              for (const entry of sorted) {
                if (entry.name === "node_modules" || entry.name === "dist") continue
                const full = join(curDir, entry.name)
                const entrySymErr = match(
                  Result.try({
                    try: () => hostIo.isSymbolicLinkSync(full),
                    catch: (err) => `Failed to check symlink '${full}': ${formatErr(err)}`,
                  }),
                )
                  .with({ _tag: "Failure" }, ({ failure }) => failure)
                  .with({ _tag: "Success" }, ({ success }) =>
                    success ? `Refusing symlink entry '${full}'` : undefined,
                  )
                  .exhaustive()
                if (entrySymErr !== undefined) return Result.fail(entrySymErr)

                const stepErr = match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
                  .with({ isDirectory: true }, () =>
                    match(walk(full))
                      .with({ _tag: "Success" }, () => undefined)
                      .with({ _tag: "Failure" }, ({ failure }) => failure)
                      .exhaustive(),
                  )
                  .with({ isDirectory: false, isFile: true }, () => {
                    if (
                      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
                      !entry.name.endsWith(".d.ts")
                    ) {
                      const rel = relative(repoRoot, full).replace(/\\/g, "/")
                      outRelToAbs.set(rel, full)
                    }
                    return undefined
                  })
                  .with({ isDirectory: false, isFile: false }, () => undefined)
                  .exhaustive()
                if (stepErr !== undefined) return Result.fail(stepErr)
              }
              return Result.succeed(undefined)
            },
          )
        },
      )
    return walk(dir)
  })
}

const candidateTargetsForBase = (baseRel: string): ReadonlyArray<string> => {
  const clean = baseRel === "." || baseRel === "" ? "." : baseRel.replace(/\/+$/, "")
  const jsMatch = /\.(js|jsx|mjs|cjs)$/.exec(clean)
  if (jsMatch !== null) {
    const stem = clean.slice(0, -jsMatch[0].length)
    return [`${stem}.ts`, `${stem}.tsx`, clean, `${stem}/index.ts`, `${stem}/index.tsx`]
  }
  if (/\.(ts|tsx)$/.test(clean)) return [clean]
  const prefix = clean === "." ? "" : `${clean}/`
  return [`${clean}.ts`, `${clean}.tsx`, `${prefix}index.ts`, `${prefix}index.tsx`]
}

const resolvePackageImport = (
  fromRel: string,
  spec: string,
  pkgDirRel: string,
  pkgName: string | undefined,
  knownFiles: ReadonlyMap<string, string>,
): string | undefined => {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const base = posix.normalize(posix.join(posix.dirname(fromRel), spec))
    for (const cand of candidateTargetsForBase(base)) {
      if (knownFiles.has(cand)) return cand
    }
    return undefined
  }
  if (pkgName !== undefined && (spec === pkgName || spec.startsWith(`${pkgName}/`))) {
    const sub = spec === pkgName ? "index" : spec.slice(pkgName.length + 1)
    const base = `${pkgDirRel}/src/${sub}`
    for (const cand of candidateTargetsForBase(posix.normalize(base))) {
      if (knownFiles.has(cand)) return cand
    }
  }
  return undefined
}

const addReverseEdge = (
  graph: Map<string, Set<string>>,
  targetRel: string,
  importerRel: string,
): void => {
  let set = graph.get(targetRel)
  if (set === undefined) {
    set = new Set<string>()
    graph.set(targetRel, set)
  }
  set.add(importerRel)
}

/**
 * Builds an immutable intra-package static reverse-import index across `src/` and `test/` modules.
 */
export const buildPackageReachabilityIndexChecked = (
  repoRoot: string,
  pkgDirRel: string,
  pkgName: string | undefined,
  extraTestAbsPaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
): BuildReachabilityIndexResult => {
  const relToAbs = new Map<string, string>()
  for (const sub of ["src", "test"] as const) {
    const res = collectTsFilesInDirChecked(
      repoRoot,
      join(repoRoot, pkgDirRel, sub),
      hostIo,
      relToAbs,
    )
    const err = match(res)
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .exhaustive()
    if (err !== undefined) return { _tag: "Error", reason: err }
  }
  for (const rawAbs of extraTestAbsPaths) {
    const abs = isAbsolute(rawAbs) ? rawAbs : join(repoRoot, rawAbs)
    const rel = relative(repoRoot, abs).replace(/\\/g, "/")
    if (!relToAbs.has(rel)) relToAbs.set(rel, abs)
  }

  const barrelRel = `${pkgDirRel}/src/index.ts`
  const revNoBarrel = new Map<string, Set<string>>()
  const revFull = new Map<string, Set<string>>()
  const testSourceByAbsPath = new Map<string, string>()
  const testLineCountByAbsPath = new Map<string, number>()

  for (const [relPath, absPath] of relToAbs.entries()) {
    const symErr = match(
      Result.try({
        try: () => hostIo.isSymbolicLinkSync(absPath),
        catch: (err) => `Failed to check symlink '${absPath}': ${formatErr(err)}`,
      }),
    )
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, ({ success }) =>
        success ? `Refusing symlink file '${absPath}'` : undefined,
      )
      .exhaustive()
    if (symErr !== undefined) return { _tag: "Error", reason: symErr }

    const readRes = Result.try({
      try: () => hostIo.readTextSync(absPath),
      catch: (err) => `Failed to read '${absPath}': ${formatErr(err)}`,
    })
    const content = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (content === undefined) {
      const reason = match(readRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive()
      return { _tag: "Error", reason }
    }

    if (/\.(?:test|spec)\.tsx?$/.test(relPath)) {
      testSourceByAbsPath.set(absPath, content)
      testLineCountByAbsPath.set(absPath, content.split(/\r?\n/).length)
    }

    const pre = ts.preProcessFile(content, true, true)
    for (const imp of pre.importedFiles) {
      const targetRel = resolvePackageImport(relPath, imp.fileName, pkgDirRel, pkgName, relToAbs)
      if (targetRel === undefined) continue
      addReverseEdge(revFull, targetRel, relPath)
      if (relPath !== barrelRel) {
        addReverseEdge(revNoBarrel, targetRel, relPath)
      }
    }
  }

  return {
    _tag: "Ok",
    index: {
      pkgDirRel,
      barrelRel,
      revNoBarrel,
      revFull,
      testSourceByAbsPath,
      testLineCountByAbsPath,
      absByRelPath: relToAbs,
    },
  }
}

export const getOrBuildPackageReachabilityIndexChecked = (
  repoRoot: string,
  pkgDirRel: string,
  pkgName: string | undefined,
  extraTestAbsPaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
  cache?: Map<string, PackageReachabilityIndex>,
): BuildReachabilityIndexResult => {
  const existing = cache?.get(pkgDirRel)
  if (existing !== undefined) return { _tag: "Ok", index: existing }
  const built = buildPackageReachabilityIndexChecked(
    repoRoot,
    pkgDirRel,
    pkgName,
    extraTestAbsPaths,
    hostIo,
  )
  return match(built)
    .with({ _tag: "Error" }, (err) => err)
    .with({ _tag: "Ok" }, ({ index }) => {
      cache?.set(pkgDirRel, index)
      return { _tag: "Ok" as const, index }
    })
    .exhaustive()
}

export const isHeavyMetaTestAbsPath = (testAbsPath: string): boolean => {
  const base = testAbsPath.split(/[/\\]/).pop() ?? testAbsPath
  return HEAVY_META_TEST_BASENAMES.has(base)
}

export const sortTestAbsPathsBySpeed = (
  paths: ReadonlyArray<string>,
  index: PackageReachabilityIndex,
  prioritySet?: ReadonlySet<string>,
): Array<string> =>
  [...paths].sort((a, b) => {
    const heavyDiff = Number(isHeavyMetaTestAbsPath(a)) - Number(isHeavyMetaTestAbsPath(b))
    if (heavyDiff !== 0) return heavyDiff
    if (prioritySet !== undefined) {
      const priDiff = Number(!prioritySet.has(a)) - Number(!prioritySet.has(b))
      if (priDiff !== 0) return priDiff
    }
    const linesA = index.testLineCountByAbsPath.get(a) ?? Number.MAX_SAFE_INTEGER
    const linesB = index.testLineCountByAbsPath.get(b) ?? Number.MAX_SAFE_INTEGER
    if (linesA !== linesB) return linesA - linesB
    return compareCodeUnits(a, b)
  })

const collectReachingFromRevMap = (
  startRel: string,
  revMap: ReadonlyMap<string, ReadonlySet<string>>,
  eligibleByRel: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const visited = new Set<string>([startRel])
  const queue: Array<string> = [startRel]
  const matchedAbs: Array<string> = []
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const importerRel of revMap.get(cur) ?? []) {
      if (visited.has(importerRel)) continue
      visited.add(importerRel)
      const eligibleAbs = eligibleByRel.get(importerRel)
      if (eligibleAbs !== undefined) {
        matchedAbs.push(eligibleAbs)
      } else {
        queue.push(importerRel)
      }
    }
  }
  return matchedAbs
}

/**
 * Traverses the reverse-import graph from `targetRelFile` to classify direct (non-barrel) and total static reaching tests.
 */
export const queryReverseImportReachability = (
  index: PackageReachabilityIndex,
  targetRelFile: string,
  eligibleTests: ReadonlyArray<string>,
): ReverseImportReachability => {
  const eligibleByRel = new Map<string, string>()
  for (const [rel, abs] of index.absByRelPath.entries()) {
    if (eligibleTests.includes(abs)) eligibleByRel.set(rel, abs)
  }
  const nonBarrel = collectReachingFromRevMap(targetRelFile, index.revNoBarrel, eligibleByRel)
  const full = collectReachingFromRevMap(targetRelFile, index.revFull, eligibleByRel)
  return {
    nonBarrelTests: sortTestAbsPathsBySpeed(nonBarrel, index),
    allStaticImporterTests: sortTestAbsPathsBySpeed(full, index),
  }
}

export const selectReachabilityPartition = (input: {
  readonly index: PackageReachabilityIndex
  readonly targetRelFile: string
  readonly eligibleTests: ReadonlyArray<string>
  readonly directStemTests: ReadonlyArray<string>
  readonly symbolMatchedTests: ReadonlyArray<string>
}): {
  readonly primaryTests: ReadonlyArray<string>
  readonly fallbackTests: ReadonlyArray<string>
} => {
  const { nonBarrelTests, allStaticImporterTests } = queryReverseImportReachability(
    input.index,
    input.targetRelFile,
    input.eligibleTests,
  )
  const staticSet = new Set(allStaticImporterTests)
  const remainingFrom = (primary: ReadonlyArray<string>): ReadonlyArray<string> => {
    const primarySet = new Set(primary)
    return sortTestAbsPathsBySpeed(
      input.eligibleTests.filter((t) => !primarySet.has(t)),
      input.index,
      staticSet,
    )
  }
  const dedupPreserve = (items: ReadonlyArray<string>): ReadonlyArray<string> => {
    const seen = new Set<string>()
    const out: Array<string> = []
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item)
        out.push(item)
      }
    }
    return out
  }

  if (input.directStemTests.length > 0) {
    const primaryTests = dedupPreserve([...input.directStemTests, ...nonBarrelTests])
    return { primaryTests, fallbackTests: remainingFrom(primaryTests) }
  }
  if (input.symbolMatchedTests.length > 0) {
    const primaryTests = dedupPreserve([...input.symbolMatchedTests, ...nonBarrelTests])
    return { primaryTests, fallbackTests: remainingFrom(primaryTests) }
  }
  if (nonBarrelTests.length > 0) {
    return { primaryTests: nonBarrelTests, fallbackTests: remainingFrom(nonBarrelTests) }
  }
  if (
    allStaticImporterTests.length > 0 &&
    allStaticImporterTests.length < input.eligibleTests.length
  ) {
    return {
      primaryTests: allStaticImporterTests,
      fallbackTests: remainingFrom(allStaticImporterTests),
    }
  }
  return {
    primaryTests: sortTestAbsPathsBySpeed(input.eligibleTests, input.index, staticSet),
    fallbackTests: [],
  }
}

const extractExportedRuntimeSymbols = (sourceContent: string): ReadonlyArray<string> => {
  const symbols = new Set<string>()
  const declRe =
    /\bexport\s+(?:async\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/g
  for (const m of sourceContent.matchAll(declRe)) {
    const sym = m[1]
    if (sym && sym.length >= 2) symbols.add(sym)
  }
  const listRe = /\bexport\s*\{([^}]+)\}/g
  for (const lm of sourceContent.matchAll(listRe)) {
    for (const part of (lm[1] ?? "").split(",")) {
      const cleaned = part.trim()
      if (cleaned.length === 0 || cleaned.startsWith("type ")) continue
      const aliasParts = cleaned.split(/\s+as\s+/)
      const sym = (aliasParts[1] ?? aliasParts[0] ?? "").trim()
      if (/^[A-Za-z_$][\w$]*$/.test(sym) && sym.length >= 2) symbols.add(sym)
    }
  }
  return Array.from(symbols)
}

const escapeRegex = (raw: string): string => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Partitions discovered reaching tests into `primaryTests` and `fallbackTests` using stem/symbol heuristics plus static reverse-import reachability.
 */
export const partitionEligibleTestsChecked = (input: {
  readonly repoRoot: string
  readonly pkgDirRel: string
  readonly pkgName: string | undefined
  readonly relFile: string
  readonly sourceContent: string
  readonly allTests: ReadonlyArray<string>
  readonly hostIo: SyncHostIo
  readonly reachabilityCache?: Map<string, PackageReachabilityIndex> | undefined
}):
  | {
      readonly _tag: "Ok"
      readonly partition: {
        readonly primaryTests: ReadonlyArray<string>
        readonly fallbackTests: ReadonlyArray<string>
      }
    }
  | { readonly _tag: "Error"; readonly reason: string } => {
  const stem = basename(input.relFile).replace(/\.(tsx?)$/, "")
  const eligibleTests = input.allTests.filter(
    (t) =>
      basename(t) !== "self-dogfooding-plugin-harness.test.ts" || stem === "self-dogfooding-plugin",
  )
  if (eligibleTests.length <= 2) {
    return {
      _tag: "Ok",
      partition: { primaryTests: eligibleTests, fallbackTests: [] },
    }
  }

  const reachIndex = match(
    getOrBuildPackageReachabilityIndexChecked(
      input.repoRoot,
      input.pkgDirRel,
      input.pkgName,
      eligibleTests,
      input.hostIo,
      input.reachabilityCache,
    ),
  )
    .with({ _tag: "Error" }, ({ reason }) => reason)
    .with({ _tag: "Ok" }, ({ index }) => index)
    .exhaustive()
  if (typeof reachIndex === "string") {
    return { _tag: "Error", reason: reachIndex }
  }

  const symbolRegexes = extractExportedRuntimeSymbols(input.sourceContent).map(
    (sym) => new RegExp(`\\b${escapeRegex(sym)}\\b`),
  )
  const directStemTests: Array<string> = []
  const symbolMatchedTests: Array<string> = []

  for (const testPath of eligibleTests) {
    const testBase = basename(testPath)
    if (testBase.startsWith(`${stem}.`)) {
      directStemTests.push(testPath)
      continue
    }
    const cachedContent = reachIndex.testSourceByAbsPath.get(testPath)
    const content =
      cachedContent !== undefined
        ? cachedContent
        : match(
            Result.try({
              try: () => input.hostIo.readTextSync(testPath),
              catch: (err) => `Failed to read '${testPath}': ${formatErr(err)}`,
            }),
          )
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, ({ failure }) => ({ readErr: failure }))
            .exhaustive()
    if (typeof content !== "string") {
      return { _tag: "Error", reason: content.readErr }
    }
    if (content.includes(stem)) {
      directStemTests.push(testPath)
      continue
    }
    if (symbolRegexes.some((re) => re.test(content))) {
      symbolMatchedTests.push(testPath)
    }
  }

  return {
    _tag: "Ok",
    partition: selectReachabilityPartition({
      index: reachIndex,
      targetRelFile: input.relFile,
      eligibleTests,
      directStemTests,
      symbolMatchedTests,
    }),
  }
}
