/**
 * @fileoverview Tag-based package classification, domain target discovery, and reaching test partitioning.
 */
import { basename, join, relative } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service/host-io"

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

const readPackageManifest = (
  pkgPath: string,
  hostIo: SyncHostIo,
): {
  readonly hasManifest: boolean
  readonly pkgName: string | undefined
  readonly tags: ReadonlyArray<string>
} => {
  const pkgJsonPath = join(pkgPath, "package.json")
  const projectJsonPath = join(pkgPath, "project.json")
  const hasPkgJson = hostIo.existsSync(pkgJsonPath)
  const hasProjectJson = hostIo.existsSync(projectJsonPath)

  const pkgData = hasPkgJson
    ? match(Result.try(() => hostIo.readTextSync(pkgJsonPath)))
        .with({ _tag: "Success" }, ({ success }) =>
          match(Schema.decodeOption(PackageJsonSchema)(success))
            .with({ _tag: "Some" }, ({ value }) => ({
              name: value.name,
              tags: value.nx?.tags ?? [],
            }))
            .with({ _tag: "None" }, () => ({ name: undefined, tags: [] as ReadonlyArray<string> }))
            .exhaustive(),
        )
        .with({ _tag: "Failure" }, () => ({ name: undefined, tags: [] as ReadonlyArray<string> }))
        .exhaustive()
    : { name: undefined, tags: [] as ReadonlyArray<string> }

  const projData = hasProjectJson
    ? match(Result.try(() => hostIo.readTextSync(projectJsonPath)))
        .with({ _tag: "Success" }, ({ success }) =>
          match(Schema.decodeOption(ProjectJsonSchema)(success))
            .with({ _tag: "Some" }, ({ value }) => ({ name: value.name, tags: value.tags ?? [] }))
            .with({ _tag: "None" }, () => ({ name: undefined, tags: [] as ReadonlyArray<string> }))
            .exhaustive(),
        )
        .with({ _tag: "Failure" }, () => ({ name: undefined, tags: [] as ReadonlyArray<string> }))
        .exhaustive()
    : { name: undefined, tags: [] as ReadonlyArray<string> }

  return {
    hasManifest: hasPkgJson || hasProjectJson,
    pkgName: pkgData.name ?? projData.name,
    tags: [...pkgData.tags, ...projData.tags],
  }
}

export const resolveLibPackageClassification = (
  pkgPath: string,
  pkgDir: string,
  hostIo: SyncHostIo,
): PackageTierClassification => {
  const { hasManifest, tags } = readPackageManifest(pkgPath, hostIo)
  if (!hasManifest) {
    return pkgDir === "domain" || pkgDir === "core" || pkgDir === "contract"
      ? pkgDir
      : "unclassified"
  }
  if (tags.includes("type:domain")) return "domain"
  if (tags.includes("type:core")) return "core"
  if (tags.includes("type:service") || tags.includes("type:infra") || tags.includes("type:app"))
    return "excluded"
  if (tags.includes("type:contract")) return "contract"
  return "unclassified"
}

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

export const findDomainFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  scope?: string,
  targetFiles?: ReadonlyArray<string>,
): ReadonlyArray<DomainFile> => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return results

  const targetSet =
    targetFiles !== undefined ? new Set(targetFiles.map(normalizeTargetPath)) : undefined
  const scopeDirs = [...hostIo.readdirSync(libsDir)]
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))

  for (const sDir of scopeDirs) {
    const scopePath = join(libsDir, sDir)
    const pkgDirs = [...hostIo.readdirSync(scopePath)]
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))

    for (const pkgDir of pkgDirs) {
      const pkgPath = join(scopePath, pkgDir)
      const classification = resolveLibPackageClassification(pkgPath, pkgDir, hostIo)
      if (classification === "excluded" || classification === "unclassified") continue

      const { pkgName } = readPackageManifest(pkgPath, hostIo)
      if (scope !== undefined && !matchesScopeFilter(scope, sDir, pkgDir, pkgName)) continue

      const scanRoots: ReadonlyArray<string> =
        classification === "contract"
          ? [join(pkgPath, "src")]
          : [join(pkgPath, "src"), join(pkgPath, "test", "fixtures")]

      for (const dir of scanRoots) {
        if (!hostIo.existsSync(dir)) continue
        const walk = (d: string): void => {
          const entries = [...hostIo.readdirSync(d)].sort((a, b) => a.name.localeCompare(b.name))
          for (const entry of entries) {
            const full = join(d, entry.name)
            match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
              .with({ isDirectory: true }, () => {
                walk(full)
              })
              .with({ isDirectory: false, isFile: true }, () => {
                if (
                  (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
                  !entry.name.endsWith(".d.ts")
                ) {
                  const relFile = normalizeTargetPath(relative(repoRoot, full))
                  if (targetSet !== undefined && !targetSet.has(relFile)) return
                  results.push({
                    scope: sDir,
                    pkgDir,
                    pkgName,
                    tier: classification,
                    fullPath: full,
                    relFile,
                  })
                }
              })
              .with({ isDirectory: false, isFile: false }, () => {})
              .exhaustive()
          }
        }
        walk(dir)
      }
    }
  }
  return results
}

export const findUnclassifiedModifiedLibFiles = (
  repoRoot: string,
  diffLinesMap: ReadonlyMap<string, ReadonlySet<number>>,
  discoveredFiles: ReadonlyArray<DomainFile>,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  const discoveredSet = new Set(discoveredFiles.map((f) => f.relFile))
  const unclassified: Array<string> = []

  for (const rawPath of diffLinesMap.keys()) {
    const norm = normalizeTargetPath(rawPath)
    const libMatch = /^libs\/([^/]+)\/([^/]+)\/src\/.*\.(ts|tsx)$/.exec(norm)
    if (libMatch === null || norm.endsWith(".d.ts") || discoveredSet.has(norm)) continue
    if (!hostIo.existsSync(join(repoRoot, norm))) continue
    const pkgPath = join(repoRoot, "libs", libMatch[1]!, libMatch[2]!)
    if (resolveLibPackageClassification(pkgPath, libMatch[2]!, hostIo) !== "excluded") {
      unclassified.push(norm)
    }
  }
  return unclassified.sort((a, b) => a.localeCompare(b))
}

export const findReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  const testDir = join(repoRoot, "libs", file.scope, file.pkgDir, "test")
  if (!hostIo.existsSync(testDir)) return []
  const reaching: Array<string> = []
  const walk = (dir: string): void => {
    const entries = [...hostIo.readdirSync(dir)].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
        .with({ isDirectory: true }, () => {
          walk(full)
        })
        .with({ isDirectory: false, isFile: true }, () => {
          if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))
            reaching.push(full)
        })
        .with({ isDirectory: false, isFile: false }, () => {})
        .exhaustive()
    }
  }
  walk(testDir)
  return reaching.sort((a, b) => a.localeCompare(b))
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

export const partitionReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  sourceContent: string,
  hostIo: SyncHostIo,
): TestPartition => {
  const allTests = findReachingTestFiles(repoRoot, file, hostIo)
  const stem = basename(file.relFile).replace(/\.(tsx?)$/, "")
  const eligibleTests = allTests.filter(
    (t) =>
      basename(t) !== "self-dogfooding-plugin-harness.test.ts" || stem === "self-dogfooding-plugin",
  )
  if (eligibleTests.length <= 2) return { primaryTests: eligibleTests, fallbackTests: [] }

  const symbolRegexes = extractExportedRuntimeSymbols(sourceContent).map(
    (sym) => new RegExp(`\\b${sym}\\b`),
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
    const content = hostIo.readTextSync(testPath)
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
      primaryTests: directStemTests,
      fallbackTests: [...symbolMatchedTests, ...remainingOther],
    }
  }
  if (symbolMatchedTests.length > 0) {
    return { primaryTests: symbolMatchedTests, fallbackTests: remainingOther }
  }
  return { primaryTests: eligibleTests, fallbackTests: [] }
}
