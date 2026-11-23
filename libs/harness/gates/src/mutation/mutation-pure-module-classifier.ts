import { dirname, join, relative, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  analyzeModulePurityAst,
  classifyMutationModulePurity,
  isPureMutationCandidate,
  type PureModuleClassification,
} from "./mutation-pure-ast.js"

export { classifyMutationModulePurity, isPureMutationCandidate, type PureModuleClassification }

export interface PureDiscoveredFile {
  readonly scope: string
  readonly pkgDir: string
  readonly pkgName?: string | undefined
  readonly tier: "infra-pure" | "app-pure"
  readonly fullPath: string
  readonly relFile: string
}

const checkNonSymlinkEntry = (path: string, hostIo: SyncHostIo): string | undefined =>
  match(
    Result.try({
      try: () => hostIo.isSymbolicLinkSync(path),
      catch: (err) =>
        `Failed to check symlink '${path}': ${err instanceof Error ? err.message : String(err)}`,
    }),
  )
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success: isSym }) =>
      isSym ? `Refusing symlink entry '${path}'` : undefined,
    )
    .exhaustive()

interface ScannedPackageModule {
  readonly fullPath: string
  readonly relFile: string
  readonly analysis: {
    readonly classification: PureModuleClassification
    readonly relativeValueImports: ReadonlyArray<string>
  }
}

const resolveRelativeSiblingRel = (
  fromFullPath: string,
  specifier: string,
  repoRoot: string,
  byRel: ReadonlyMap<string, ScannedPackageModule>,
): string | undefined => {
  const rawTarget = resolve(dirname(fromFullPath), specifier)
  const stem = rawTarget.replace(/\.(?:[cm]?[jt]sx?)$/, "")
  const candidates = [
    rawTarget,
    `${stem}.ts`,
    `${stem}.tsx`,
    join(rawTarget, "index.ts"),
    join(rawTarget, "index.tsx"),
  ]
  for (const cand of candidates) {
    const rel = relative(repoRoot, cand).replace(/\\/g, "/").replace(/^\.\//, "")
    if (byRel.has(rel)) return rel
  }
  return undefined
}

const collectAllPackageTsFilesChecked = (
  dir: string,
  repoRoot: string,
  hostIo: SyncHostIo,
  out: Array<ScannedPackageModule>,
): string | undefined => {
  const dirExistsRes = Result.try({
    try: () => hostIo.existsSync(dir),
    catch: (err) => `Failed to stat '${dir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const existsErr = match(dirExistsRes)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => (success ? undefined : null))
    .exhaustive()
  if (existsErr === null) return undefined
  if (existsErr !== undefined) return existsErr

  const dirSymErr = checkNonSymlinkEntry(dir, hostIo)
  if (dirSymErr !== undefined) return dirSymErr

  const entriesRes = Result.try({
    try: () => hostIo.readdirSync(dir),
    catch: (err) =>
      `Failed to read directory '${dir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const rawEntries = match(entriesRes)
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  if (rawEntries === undefined) {
    return match(entriesRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
  }

  const entries = [...rawEntries].sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const symErr = checkNonSymlinkEntry(full, hostIo)
    if (symErr !== undefined) return symErr

    if (entry.isDirectory) {
      const subErr = collectAllPackageTsFilesChecked(full, repoRoot, hostIo, out)
      if (subErr !== undefined) return subErr
      continue
    }
    if (
      !entry.isFile ||
      !(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ||
      entry.name.endsWith(".d.ts")
    ) {
      continue
    }

    const relFile = relative(repoRoot, full).replace(/\\/g, "/").replace(/^\.\//, "")
    const readRes = Result.try({
      try: () => hostIo.readTextSync(full),
      catch: (err) =>
        `Failed to read '${full}': ${err instanceof Error ? err.message : String(err)}`,
    })
    const content = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (content === undefined) {
      return match(readRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive()
    }
    out.push({
      fullPath: full,
      relFile,
      analysis: analyzeModulePurityAst(relFile, content),
    })
  }
  return undefined
}

/** Walks `srcDir`, collects TypeScript files that pass transitive pure-module classification, and appends them to `results`. */
export const collectPureCandidateFilesChecked = (input: {
  readonly dir: string
  readonly repoRoot: string
  readonly scope: string
  readonly pkgDir: string
  readonly pkgName: string | undefined
  readonly tier: "infra-pure" | "app-pure"
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const scanned: Array<ScannedPackageModule> = []
  const scanErr = collectAllPackageTsFilesChecked(input.dir, input.repoRoot, input.hostIo, scanned)
  if (scanErr !== undefined) return scanErr

  const byRel = new Map<string, ScannedPackageModule>()
  const effectiveStatus = new Map<string, PureModuleClassification>()
  for (const mod of scanned) {
    byRel.set(mod.relFile, mod)
    effectiveStatus.set(mod.relFile, mod.analysis.classification)
  }

  // Fixed-point propagation: if a pure module value-imports/re-exports any excluded relative module, mark it Excluded.
  let changed = true
  for (let pass = 0; pass < scanned.length && changed; pass += 1) {
    changed = false
    for (const mod of scanned) {
      const curr = effectiveStatus.get(mod.relFile)!
      const isPure = match(curr)
        .with({ _tag: "Pure" }, () => true)
        .with({ _tag: "Excluded" }, () => false)
        .exhaustive()
      if (!isPure) {
        continue
      }
      for (const spec of mod.analysis.relativeValueImports) {
        const targetRel = resolveRelativeSiblingRel(mod.fullPath, spec, input.repoRoot, byRel)
        if (targetRel === undefined) continue
        const targetClass = effectiveStatus.get(targetRel)
        if (targetClass === undefined) continue
        const targetExcludedReason = match(targetClass)
          .with({ _tag: "Pure" }, () => undefined)
          .with({ _tag: "Excluded" }, ({ reason }) => reason)
          .exhaustive()
        if (targetExcludedReason !== undefined) {
          effectiveStatus.set(mod.relFile, {
            _tag: "Excluded",
            reason: `transitively imports excluded module '${spec}' (${targetExcludedReason})`,
          })
          changed = true
          break
        }
      }
    }
  }

  for (const mod of scanned) {
    if (input.targetSet !== undefined && !input.targetSet.has(mod.relFile)) continue
    match(effectiveStatus.get(mod.relFile))
      .with({ _tag: "Pure" }, () => {
        input.results.push({
          scope: input.scope,
          pkgDir: input.pkgDir,
          pkgName: input.pkgName,
          tier: input.tier,
          fullPath: mod.fullPath,
          relFile: mod.relFile,
        })
      })
      .with({ _tag: "Excluded" }, undefined, () => undefined)
      .exhaustive()
  }
  return undefined
}

export type AppManifestReadResult =
  | {
      readonly _tag: "Ok"
      readonly manifest: {
        readonly pkgName: string | undefined
        readonly tags: ReadonlyArray<string>
      }
    }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "CorruptManifest"
      readonly packageJsonPath: string
      readonly reason: string
    }

/** Scans top-level non-web/non-fixture packages under `apps/` for pure zero-I/O source modules. */
export const discoverAppPureFilesChecked = (input: {
  readonly repoRoot: string
  readonly scope: string | undefined
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly readPackageManifest: (pkgPath: string, hostIo: SyncHostIo) => AppManifestReadResult
  readonly matchesScopeFilter: (
    scope: string,
    sDir: string,
    pkgDir: string,
    pkgName: string | undefined,
  ) => boolean
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const appsDir = join(input.repoRoot, "apps")
  const existsRes = Result.try({
    try: () => input.hostIo.existsSync(appsDir),
    catch: (err) =>
      `Failed to stat '${appsDir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const existsErr = match(existsRes)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => (success ? undefined : null))
    .exhaustive()
  if (existsErr === null) return undefined
  if (existsErr !== undefined) return existsErr

  const symErr = checkNonSymlinkEntry(appsDir, input.hostIo)
  if (symErr !== undefined) return symErr

  const dirRes = Result.try({
    try: () => input.hostIo.readdirSync(appsDir),
    catch: (err) =>
      `Failed to read directory '${appsDir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const rawEntries = match(dirRes)
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  if (rawEntries === undefined) {
    return match(dirRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
  }

  const appDirs = [...rawEntries]
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort(compareCodeUnits)

  for (const appDir of appDirs) {
    const appPath = join(appsDir, appDir)
    const appErr = match(input.readPackageManifest(appPath, input.hostIo))
      .with({ _tag: "CorruptManifest" }, ({ reason }) => reason)
      .with({ _tag: "Missing" }, () => undefined)
      .with({ _tag: "Ok" }, ({ manifest }) => {
        if (
          manifest.tags.includes("scope:web") ||
          manifest.tags.includes("scope:fixture") ||
          !manifest.tags.includes("type:app")
        ) {
          return undefined
        }
        if (
          input.scope !== undefined &&
          !input.matchesScopeFilter(input.scope, "apps", appDir, manifest.pkgName)
        ) {
          return undefined
        }
        return collectPureCandidateFilesChecked({
          dir: join(appPath, "src"),
          repoRoot: input.repoRoot,
          scope: "apps",
          pkgDir: appDir,
          pkgName: manifest.pkgName,
          tier: "app-pure",
          targetSet: input.targetSet,
          hostIo: input.hostIo,
          results: input.results,
        })
      })
      .exhaustive()
    if (appErr !== undefined) return appErr
  }
  return undefined
}

/** Scans a single `type:infra` or non-web `type:app` library package for pure zero-I/O source files. */
export const collectExcludedLibPureFilesChecked = (input: {
  readonly pkgPath: string
  readonly repoRoot: string
  readonly sDir: string
  readonly pkgDir: string
  readonly pkgName: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly scope: string | undefined
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly matchesScopeFilter: (
    scope: string,
    sDir: string,
    pkgDir: string,
    pkgName: string | undefined,
  ) => boolean
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const pureTier: PureDiscoveredFile["tier"] | undefined =
    input.tags.includes("type:infra") && !input.tags.includes("scope:fixture")
      ? "infra-pure"
      : input.tags.includes("type:app") &&
          !input.tags.includes("scope:web") &&
          !input.tags.includes("scope:fixture")
        ? "app-pure"
        : undefined
  if (pureTier === undefined) return undefined
  if (
    input.scope !== undefined &&
    !input.matchesScopeFilter(input.scope, input.sDir, input.pkgDir, input.pkgName)
  ) {
    return undefined
  }
  return collectPureCandidateFilesChecked({
    dir: join(input.pkgPath, "src"),
    repoRoot: input.repoRoot,
    scope: input.sDir,
    pkgDir: input.pkgDir,
    pkgName: input.pkgName,
    tier: pureTier,
    targetSet: input.targetSet,
    hostIo: input.hostIo,
    results: input.results,
  })
}
