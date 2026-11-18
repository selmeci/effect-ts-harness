/**
 * @fileoverview Tag-based package classification, domain target discovery, and reaching test partitioning.
 */
import { basename, join, relative } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"

export interface DomainFile {
  readonly scope: string
  readonly pkgDir: string
  readonly pkgName?: string | undefined
  readonly tier: "domain" | "core" | "contract"
  readonly fullPath: string
  readonly relFile: string
}

export type PackageTierClassification = "domain" | "core" | "contract" | "excluded" | "unclassified"

export interface TestPartition {
  readonly primaryTests: ReadonlyArray<string>
  readonly fallbackTests: ReadonlyArray<string>
}

export interface PackageManifestInfo {
  readonly pkgName: string | undefined
  readonly tags: ReadonlyArray<string>
}

export type ReadPackageManifestResult =
  | { readonly _tag: "Ok"; readonly manifest: PackageManifestInfo }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "CorruptManifest"
      readonly packageJsonPath: string
      readonly reason: string
    }

const PackageJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    nx: Schema.optional(Schema.Struct({ tags: Schema.optional(Schema.Array(Schema.String)) })),
  }),
)

const ProjectJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
)

const formatErr = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const existsGuarded = (filePath: string, hostIo: SyncHostIo): Result.Result<boolean, string> =>
  Result.try({
    try: () => hostIo.existsSync(filePath),
    catch: (err) => `Failed to stat '${filePath}': ${formatErr(err)}`,
  })

const isSymlinkGuarded = (filePath: string, hostIo: SyncHostIo): Result.Result<boolean, string> =>
  Result.try({
    try: () => hostIo.isSymbolicLinkSync(filePath),
    catch: (err) => `Failed to check symlink '${filePath}': ${formatErr(err)}`,
  })

const readTextGuarded = (filePath: string, hostIo: SyncHostIo): Result.Result<string, string> =>
  Result.try({
    try: () => hostIo.readTextSync(filePath),
    catch: (err) => `Failed to read '${filePath}': ${formatErr(err)}`,
  })

const readdirGuarded = (
  dirPath: string,
  hostIo: SyncHostIo,
): Result.Result<ReadonlyArray<SyncHostDirEntry>, string> =>
  Result.try({
    try: () => hostIo.readdirSync(dirPath),
    catch: (err) => `Failed to read directory '${dirPath}': ${formatErr(err)}`,
  })

export const readPackageManifest = (
  pkgPath: string,
  hostIo: SyncHostIo,
): ReadPackageManifestResult => {
  const pkgJsonPath = join(pkgPath, "package.json")
  const projectJsonPath = join(pkgPath, "project.json")
  const hasPkgRes = existsGuarded(pkgJsonPath, hostIo)
  const hasPkgJson = match(hasPkgRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (hasPkgJson === undefined) {
    const reason = match(hasPkgRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
    return { _tag: "CorruptManifest", packageJsonPath: pkgJsonPath, reason }
  }

  const hasProjRes = existsGuarded(projectJsonPath, hostIo)
  const hasProjectJson = match(hasProjRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (hasProjectJson === undefined) {
    const reason = match(hasProjRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
    return { _tag: "CorruptManifest", packageJsonPath: projectJsonPath, reason }
  }

  if (!hasPkgJson && !hasProjectJson) return { _tag: "Missing" }

  let pkgName: string | undefined = undefined
  const tags: Array<string> = []

  if (hasPkgJson) {
    const readRes = readTextGuarded(pkgJsonPath, hostIo)
    const err = match(readRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, ({ success }) =>
        match(Schema.decodeOption(PackageJsonSchema)(success))
          .with({ _tag: "Some" }, ({ value }) => {
            pkgName = value.name
            if (value.nx?.tags !== undefined) tags.push(...value.nx.tags)
            return undefined
          })
          .with({ _tag: "None" }, () => `Malformed JSON or schema mismatch in '${pkgJsonPath}'`)
          .exhaustive(),
      )
      .exhaustive()
    if (err !== undefined) {
      return { _tag: "CorruptManifest", packageJsonPath: pkgJsonPath, reason: err }
    }
  }

  if (hasProjectJson) {
    const readRes = readTextGuarded(projectJsonPath, hostIo)
    const err = match(readRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, ({ success }) =>
        match(Schema.decodeOption(ProjectJsonSchema)(success))
          .with({ _tag: "Some" }, ({ value }) => {
            if (pkgName === undefined) pkgName = value.name
            if (value.tags !== undefined) tags.push(...value.tags)
            return undefined
          })
          .with({ _tag: "None" }, () => `Malformed JSON or schema mismatch in '${projectJsonPath}'`)
          .exhaustive(),
      )
      .exhaustive()
    if (err !== undefined) {
      return { _tag: "CorruptManifest", packageJsonPath: projectJsonPath, reason: err }
    }
  }

  return { _tag: "Ok", manifest: { pkgName, tags } }
}

const classifyFromTags = (
  tags: ReadonlyArray<string>,
  pkgPath: string,
):
  | { readonly _tag: "Ok"; readonly classification: PackageTierClassification }
  | {
      readonly _tag: "CorruptManifest"
      readonly packageJsonPath: string
      readonly reason: string
    } => {
  const hasContract = tags.includes("type:contract")
  const hasExcluded =
    tags.includes("type:service") || tags.includes("type:infra") || tags.includes("type:app")
  if (hasContract && hasExcluded) {
    return {
      _tag: "CorruptManifest",
      packageJsonPath: join(pkgPath, "package.json"),
      reason: `Conflicting Nx tier tags in '${pkgPath}': 'type:contract' cannot be combined with type:service/type:infra/type:app`,
    }
  }
  if (tags.includes("type:domain")) return { _tag: "Ok", classification: "domain" }
  if (tags.includes("type:core")) return { _tag: "Ok", classification: "core" }
  if (hasExcluded) return { _tag: "Ok", classification: "excluded" }
  if (hasContract) return { _tag: "Ok", classification: "contract" }
  return { _tag: "Ok", classification: "unclassified" }
}

export const resolveLibPackageClassificationChecked = (
  pkgPath: string,
  pkgDir: string,
  hostIo: SyncHostIo,
):
  | {
      readonly _tag: "Ok"
      readonly classification: PackageTierClassification
      readonly pkgName: string | undefined
    }
  | {
      readonly _tag: "CorruptManifest"
      readonly packageJsonPath: string
      readonly reason: string
    } =>
  match(readPackageManifest(pkgPath, hostIo))
    .with({ _tag: "CorruptManifest" }, (err) => err)
    .with({ _tag: "Missing" }, () => ({
      _tag: "Ok" as const,
      classification: match(pkgDir)
        .with("domain", "core", "contract", (t) => t)
        .otherwise(() => "unclassified" as const),
      pkgName: undefined,
    }))
    .with({ _tag: "Ok" }, ({ manifest }) =>
      match(classifyFromTags(manifest.tags, pkgPath))
        .with({ _tag: "CorruptManifest" }, (err) => err)
        .with({ _tag: "Ok" }, ({ classification }) => ({
          _tag: "Ok" as const,
          classification,
          pkgName: manifest.pkgName,
        }))
        .exhaustive(),
    )
    .exhaustive()

export const resolveLibPackageClassification = (
  pkgPath: string,
  pkgDir: string,
  hostIo: SyncHostIo,
): PackageTierClassification =>
  Result.getOrThrowWith(
    match(resolveLibPackageClassificationChecked(pkgPath, pkgDir, hostIo))
      .with({ _tag: "Ok" }, ({ classification }) => Result.succeed(classification))
      .with({ _tag: "CorruptManifest" }, ({ reason }) => Result.fail(reason))
      .exhaustive(),
    (reason) => new Error(reason),
  )

const matchesScopeFilter = (
  scope: string,
  sDir: string,
  pkgDir: string,
  pkgName: string | undefined,
): boolean => {
  const normalized = scope
    .replace(/^@harness\//, "")
    .replace(/-(domain|core|contract|gates|graph|decision|ingest)$/, "")
  return (
    scope === sDir ||
    scope === pkgDir ||
    scope === `${sDir}/${pkgDir}` ||
    scope === `${sDir}-${pkgDir}` ||
    (pkgName !== undefined && scope === pkgName) ||
    normalized === sDir ||
    normalized === pkgDir ||
    normalized === `${sDir}-${pkgDir}`
  )
}

const normalizeTargetPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "")

const walkTsFilesChecked = (
  dir: string,
  repoRoot: string,
  sDir: string,
  pkgDir: string,
  pkgName: string | undefined,
  tier: DomainFile["tier"],
  targetSet: ReadonlySet<string> | undefined,
  hostIo: SyncHostIo,
  results: Array<DomainFile>,
): Result.Result<void, string> =>
  Result.flatMap(isSymlinkGuarded(dir, hostIo), (dirSym) => {
    if (dirSym) return Result.fail(`Refusing symlink directory '${dir}'`)
    return Result.flatMap(readdirGuarded(dir, hostIo), (rawEntries) => {
      const entries = [...rawEntries].sort((a, b) => compareCodeUnits(a.name, b.name))
      for (const entry of entries) {
        const full = join(dir, entry.name)
        const symErr = match(isSymlinkGuarded(full, hostIo))
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .with({ _tag: "Success" }, ({ success: isSym }) =>
            isSym ? `Refusing symlink entry '${full}'` : undefined,
          )
          .exhaustive()
        if (symErr !== undefined) return Result.fail(symErr)

        const stepRes = match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
          .with({ isDirectory: true }, () =>
            walkTsFilesChecked(
              full,
              repoRoot,
              sDir,
              pkgDir,
              pkgName,
              tier,
              targetSet,
              hostIo,
              results,
            ),
          )
          .with({ isDirectory: false, isFile: true }, () => {
            if (
              (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
              !entry.name.endsWith(".d.ts")
            ) {
              const relFile = normalizeTargetPath(relative(repoRoot, full))
              if (targetSet === undefined || targetSet.has(relFile)) {
                results.push({ scope: sDir, pkgDir, pkgName, tier, fullPath: full, relFile })
              }
            }
            return Result.succeed(undefined)
          })
          .with({ isDirectory: false, isFile: false }, () => Result.succeed(undefined))
          .exhaustive()
        const stepErr = match(stepRes)
          .with({ _tag: "Success" }, () => undefined)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .exhaustive()
        if (stepErr !== undefined) return Result.fail(stepErr)
      }
      return Result.succeed(undefined)
    })
  })

export const findDomainFilesChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
  scope?: string,
  targetFiles?: ReadonlyArray<string>,
):
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<DomainFile> }
  | { readonly _tag: "Error"; readonly reason: string } => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  const libsExistsRes = existsGuarded(libsDir, hostIo)
  const libsExists = match(libsExistsRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (libsExists === undefined) {
    return {
      _tag: "Error",
      reason: match(libsExistsRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive(),
    }
  }
  if (!libsExists) return { _tag: "Ok", files: results }

  const targetSet =
    targetFiles !== undefined ? new Set(targetFiles.map(normalizeTargetPath)) : undefined
  const libsDirRes = readdirGuarded(libsDir, hostIo)
  const libsEntries = match(libsDirRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (libsEntries === undefined) {
    return {
      _tag: "Error",
      reason: match(libsDirRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive(),
    }
  }
  const scopeDirs = [...libsEntries]
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort(compareCodeUnits)

  for (const sDir of scopeDirs) {
    const scopePath = join(libsDir, sDir)
    const scopeDirRes = readdirGuarded(scopePath, hostIo)
    const scopeEntries = match(scopeDirRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (scopeEntries === undefined) {
      return {
        _tag: "Error",
        reason: match(scopeDirRes)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .with({ _tag: "Success" }, () => "")
          .exhaustive(),
      }
    }
    const pkgDirs = [...scopeEntries]
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort(compareCodeUnits)

    for (const pkgDir of pkgDirs) {
      const pkgPath = join(scopePath, pkgDir)
      const classRes = resolveLibPackageClassificationChecked(pkgPath, pkgDir, hostIo)
      const pkgError = match(classRes)
        .with({ _tag: "CorruptManifest" }, ({ reason }) => reason)
        .with({ _tag: "Ok" }, ({ classification, pkgName }) =>
          match(classification)
            .with("excluded", "unclassified", () => undefined)
            .with("domain", "core", "contract", (tier) => {
              if (scope !== undefined && !matchesScopeFilter(scope, sDir, pkgDir, pkgName)) {
                return undefined
              }
              const scanRoots: ReadonlyArray<string> = match(tier)
                .with("contract", () => [join(pkgPath, "src")])
                .with("domain", "core", () => [
                  join(pkgPath, "src"),
                  join(pkgPath, "test", "fixtures"),
                ])
                .exhaustive()
              for (const dir of scanRoots) {
                const existsErr = match(existsGuarded(dir, hostIo))
                  .with({ _tag: "Failure" }, ({ failure }) => failure)
                  .with({ _tag: "Success" }, ({ success: exists }) => {
                    if (!exists) return undefined
                    return match(
                      walkTsFilesChecked(
                        dir,
                        repoRoot,
                        sDir,
                        pkgDir,
                        pkgName,
                        tier,
                        targetSet,
                        hostIo,
                        results,
                      ),
                    )
                      .with({ _tag: "Success" }, () => undefined)
                      .with({ _tag: "Failure" }, ({ failure }) => failure)
                      .exhaustive()
                  })
                  .exhaustive()
                if (existsErr !== undefined) return existsErr
              }
              return undefined
            })
            .exhaustive(),
        )
        .exhaustive()
      if (pkgError !== undefined) return { _tag: "Error", reason: pkgError }
    }
  }
  return { _tag: "Ok", files: results }
}

export const findDomainFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  scope?: string,
  targetFiles?: ReadonlyArray<string>,
): ReadonlyArray<DomainFile> =>
  Result.getOrThrowWith(
    match(findDomainFilesChecked(repoRoot, hostIo, scope, targetFiles))
      .with({ _tag: "Ok" }, ({ files }) => Result.succeed(files))
      .with({ _tag: "Error" }, ({ reason }) => Result.fail(reason))
      .exhaustive(),
    (reason) => new Error(reason),
  )

const isNonTestLibSourcePath = (norm: string): boolean => {
  if (!norm.startsWith("libs/")) return false
  if (!(norm.endsWith(".ts") || norm.endsWith(".tsx")) || norm.endsWith(".d.ts")) return false
  if (/(?:^|\/)(?:dist|node_modules)\//.test(norm)) return false
  if (/\.(?:test|spec)\.tsx?$/.test(norm)) return false
  if (/\/test\//.test(norm) && !/\/test\/fixtures\//.test(norm)) return false
  return true
}

export const findUnclassifiedModifiedLibFilesChecked = (
  repoRoot: string,
  diffLinesMap: ReadonlyMap<string, ReadonlySet<number>>,
  discoveredFiles: ReadonlyArray<DomainFile>,
  hostIo: SyncHostIo,
):
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Error"; readonly reason: string } => {
  const discoveredSet = new Set(discoveredFiles.map((f) => f.relFile))
  const unclassified: Array<string> = []

  for (const rawPath of diffLinesMap.keys()) {
    const norm = normalizeTargetPath(rawPath)
    if (!isNonTestLibSourcePath(norm) || discoveredSet.has(norm)) continue
    const absPath = join(repoRoot, norm)
    const existsRes = existsGuarded(absPath, hostIo)
    const fileExists = match(existsRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (fileExists === undefined) {
      return {
        _tag: "Error",
        reason: match(existsRes)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .with({ _tag: "Success" }, () => "")
          .exhaustive(),
      }
    }
    if (!fileExists) continue

    const twoSegMatch = /^libs\/([^/]+)\/([^/]+)\//.exec(norm)
    if (twoSegMatch === null) {
      unclassified.push(norm)
      continue
    }
    const pkgPath = join(repoRoot, "libs", twoSegMatch[1]!, twoSegMatch[2]!)
    const err = match(resolveLibPackageClassificationChecked(pkgPath, twoSegMatch[2]!, hostIo))
      .with({ _tag: "CorruptManifest" }, ({ reason }) => reason)
      .with({ _tag: "Ok" }, ({ classification }) =>
        match(classification)
          .with("excluded", () => undefined)
          .with("domain", "core", "contract", "unclassified", () => {
            unclassified.push(norm)
            return undefined
          })
          .exhaustive(),
      )
      .exhaustive()
    if (err !== undefined) return { _tag: "Error", reason: err }
  }
  return { _tag: "Ok", files: unclassified.sort(compareCodeUnits) }
}

export const findUnclassifiedModifiedLibFiles = (
  repoRoot: string,
  diffLinesMap: ReadonlyMap<string, ReadonlySet<number>>,
  discoveredFiles: ReadonlyArray<DomainFile>,
  hostIo: SyncHostIo,
): ReadonlyArray<string> =>
  Result.getOrThrowWith(
    match(findUnclassifiedModifiedLibFilesChecked(repoRoot, diffLinesMap, discoveredFiles, hostIo))
      .with({ _tag: "Ok" }, ({ files }) => Result.succeed(files))
      .with({ _tag: "Error" }, ({ reason }) => Result.fail(reason))
      .exhaustive(),
    (reason) => new Error(reason),
  )

export const findReachingTestFilesChecked = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
):
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Error"; readonly reason: string } => {
  const testDir = join(repoRoot, "libs", file.scope, file.pkgDir, "test")
  const existsRes = existsGuarded(testDir, hostIo)
  const testDirExists = match(existsRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (testDirExists === undefined) {
    return {
      _tag: "Error",
      reason: match(existsRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive(),
    }
  }
  if (!testDirExists) return { _tag: "Ok", files: [] }

  const reaching: Array<string> = []
  const walk = (dir: string): Result.Result<void, string> =>
    Result.flatMap(isSymlinkGuarded(dir, hostIo), (dirSym) => {
      if (dirSym) return Result.fail(`Refusing symlink test directory '${dir}'`)
      return Result.flatMap(readdirGuarded(dir, hostIo), (rawEntries) => {
        const entries = [...rawEntries].sort((a, b) => compareCodeUnits(a.name, b.name))
        for (const entry of entries) {
          const full = join(dir, entry.name)
          const symErr = match(isSymlinkGuarded(full, hostIo))
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, ({ success: isSym }) =>
              isSym ? `Refusing symlink test entry '${full}'` : undefined,
            )
            .exhaustive()
          if (symErr !== undefined) return Result.fail(symErr)

          const stepRes = match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
            .with({ isDirectory: true }, () => walk(full))
            .with({ isDirectory: false, isFile: true }, () => {
              if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
                reaching.push(full)
              }
              return Result.succeed(undefined)
            })
            .with({ isDirectory: false, isFile: false }, () => Result.succeed(undefined))
            .exhaustive()
          const stepErr = match(stepRes)
            .with({ _tag: "Success" }, () => undefined)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .exhaustive()
          if (stepErr !== undefined) return Result.fail(stepErr)
        }
        return Result.succeed(undefined)
      })
    })

  return match(walk(testDir))
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Error" as const, reason: failure }))
    .with({ _tag: "Success" }, () => ({
      _tag: "Ok" as const,
      files: reaching.sort(compareCodeUnits),
    }))
    .exhaustive()
}

export const findReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): ReadonlyArray<string> =>
  Result.getOrThrowWith(
    match(findReachingTestFilesChecked(repoRoot, file, hostIo))
      .with({ _tag: "Ok" }, ({ files }) => Result.succeed(files))
      .with({ _tag: "Error" }, ({ reason }) => Result.fail(reason))
      .exhaustive(),
    (reason) => new Error(reason),
  )

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

export const partitionReachingTestFilesChecked = (
  repoRoot: string,
  file: DomainFile,
  sourceContent: string,
  hostIo: SyncHostIo,
):
  | { readonly _tag: "Ok"; readonly partition: TestPartition }
  | { readonly _tag: "Error"; readonly reason: string } =>
  match(findReachingTestFilesChecked(repoRoot, file, hostIo))
    .with({ _tag: "Error" }, (err) => err)
    .with({ _tag: "Ok" }, ({ files: allTests }) => {
      const stem = basename(file.relFile).replace(/\.(tsx?)$/, "")
      const eligibleTests = allTests.filter(
        (t) =>
          basename(t) !== "self-dogfooding-plugin-harness.test.ts" ||
          stem === "self-dogfooding-plugin",
      )
      if (eligibleTests.length <= 2) {
        return {
          _tag: "Ok" as const,
          partition: { primaryTests: eligibleTests, fallbackTests: [] },
        }
      }

      const symbolRegexes = extractExportedRuntimeSymbols(sourceContent).map(
        (sym) => new RegExp(`\\b${escapeRegex(sym)}\\b`),
      )
      const directStemTests: Array<string> = []
      const symbolMatchedTests: Array<string> = []
      const remainingOther: Array<string> = []

      for (const testPath of eligibleTests) {
        const testBase = basename(testPath)
        if (testBase.startsWith(`${stem}.`)) {
          directStemTests.push(testPath)
          continue
        }
        const readRes = readTextGuarded(testPath, hostIo)
        const content = match(readRes)
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, () => undefined)
          .exhaustive()
        if (content === undefined) {
          return {
            _tag: "Error" as const,
            reason: match(readRes)
              .with({ _tag: "Failure" }, ({ failure }) => failure)
              .with({ _tag: "Success" }, () => "")
              .exhaustive(),
          }
        }
        if (content.includes(stem)) {
          directStemTests.push(testPath)
          continue
        }
        if (symbolRegexes.some((re) => re.test(content))) {
          symbolMatchedTests.push(testPath)
          continue
        }
        remainingOther.push(testPath)
      }

      if (directStemTests.length > 0) {
        return {
          _tag: "Ok" as const,
          partition: {
            primaryTests: directStemTests,
            fallbackTests: [...symbolMatchedTests, ...remainingOther],
          },
        }
      }
      if (symbolMatchedTests.length > 0) {
        return {
          _tag: "Ok" as const,
          partition: { primaryTests: symbolMatchedTests, fallbackTests: remainingOther },
        }
      }
      return {
        _tag: "Ok" as const,
        partition: { primaryTests: eligibleTests, fallbackTests: [] },
      }
    })
    .exhaustive()

export const partitionReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  sourceContent: string,
  hostIo: SyncHostIo,
): TestPartition =>
  Result.getOrThrowWith(
    match(partitionReachingTestFilesChecked(repoRoot, file, sourceContent, hostIo))
      .with({ _tag: "Ok" }, ({ partition }) => Result.succeed(partition))
      .with({ _tag: "Error" }, ({ reason }) => Result.fail(reason))
      .exhaustive(),
    (reason) => new Error(reason),
  )
