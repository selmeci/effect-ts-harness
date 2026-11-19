import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type ContentSha256,
  PackageRelKey,
  RuntimeVersionTag,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"
import {
  type ComputeFileMutationClosureDigestInput,
  type FileMutationClosureDigestResult,
  type MutationContextDigests,
  type MutationContextDigestsResult,
  computeFileMutationClosureDigest,
} from "./mutation-closure.js"

export {
  type ComputeFileMutationClosureDigestInput,
  type FileMutationClosureDigestResult,
  type MutationContextDigests,
  type MutationContextDigestsResult,
  computeFileMutationClosureDigest,
}

export const unwrapResult = <A>(res: Result.Result<A, unknown>): Option.Option<A> =>
  match(res)
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()

export const unwrapOption = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

export const checkExists = (targetPath: string, hostIo: SyncHostIo): boolean | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.existsSync(targetPath))))

export const isNonSymlink = (targetPath: string, hostIo: SyncHostIo): boolean =>
  match(unwrapResult(Result.try(() => hostIo.isSymbolicLinkSync(targetPath))))
    .with({ _tag: "Some" }, ({ value }) => !value)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

export const readSafeText = (filePath: string, hostIo: SyncHostIo): Option.Option<string> =>
  isNonSymlink(filePath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readTextSync(filePath)))
    : Option.none()

export const readdirSafe = (
  dirPath: string,
  hostIo: SyncHostIo,
): Option.Option<ReadonlyArray<SyncHostDirEntry>> =>
  isNonSymlink(dirPath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readdirSync(dirPath)))
    : Option.none()

const disabledErr = (
  res: { readonly _tag: "Ok" } | { readonly _tag: "Disabled"; readonly reason: string },
) =>
  match(res)
    .with({ _tag: "Ok" }, () => undefined)
    .with({ _tag: "Disabled" }, (d) => d)
    .exhaustive()

const collectDirFilesChecked = (
  baseDir: string,
  relPrefix: string,
  excludedDirs: ReadonlySet<string>,
  includeFile: (name: string) => boolean,
  hostIo: SyncHostIo,
  outRelPaths: Array<string>,
): { readonly _tag: "Ok" } | { readonly _tag: "Disabled"; readonly reason: string } => {
  if (!isNonSymlink(baseDir, hostIo)) {
    return { _tag: "Disabled", reason: `symlink or unreadable directory '${baseDir}'` }
  }
  const entries = unwrapOption(readdirSafe(baseDir, hostIo))
  if (entries === undefined)
    return { _tag: "Disabled", reason: `unreadable directory '${baseDir}'` }
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const entry of sorted) {
    if (entry.isDirectory && excludedDirs.has(entry.name)) continue
    const childFull = join(baseDir, entry.name)
    const childRel = `${relPrefix}/${entry.name}`
    if (!isNonSymlink(childFull, hostIo)) {
      return { _tag: "Disabled", reason: `symlink detected at '${childFull}'` }
    }
    const err = match(entry)
      .with({ isDirectory: true }, () =>
        disabledErr(
          collectDirFilesChecked(
            childFull,
            childRel,
            excludedDirs,
            includeFile,
            hostIo,
            outRelPaths,
          ),
        ),
      )
      .with({ isDirectory: false, isFile: true }, () => {
        if (includeFile(entry.name)) outRelPaths.push(childRel)
        return undefined
      })
      .with({ isDirectory: false, isFile: false }, () => ({
        _tag: "Disabled" as const,
        reason: `unsupported filesystem entry at '${childFull}'`,
      }))
      .exhaustive()
    if (err !== undefined) return err
  }
  return { _tag: "Ok" }
}

const isTestFile = (name: string): boolean => /\.(?:test|spec)\.[^.]+$/.test(name)
const isToolScriptFile = (name: string): boolean =>
  name.endsWith(".mjs") ||
  name.endsWith(".ts") ||
  name.endsWith(".js") ||
  name.endsWith(".json") ||
  name.endsWith(".cjs")
const isTsJsFile = (name: string): boolean => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)
const isMarkdownFile = (name: string): boolean => name.endsWith(".md")
const isRootConfigFile = (name: string): boolean =>
  name === "package.json" ||
  name === "pnpm-lock.yaml" ||
  name === "nx.json" ||
  name === ".oxlintrc.json" ||
  /^tsconfig.*\.json$/.test(name) ||
  /^vitest\.config\..+$/.test(name) ||
  /^\.oxfmtrc(?:\..+)?$/.test(name)

const hashRelFilesChecked = (
  repoRoot: string,
  relPaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
  fileShaCache?: Map<string, ContentSha256>,
  extraTag?: string,
):
  | { readonly _tag: "Ok"; readonly sha256: ContentSha256 }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  const sorted = [...new Set(relPaths)].sort(compareCodeUnits)
  const pairs: Array<readonly [string, ContentSha256]> = []
  for (const relPath of sorted) {
    const cached = fileShaCache?.get(relPath)
    if (cached !== undefined) {
      pairs.push([relPath, cached])
      continue
    }
    const fullPath = join(repoRoot, relPath)
    if (!isNonSymlink(fullPath, hostIo)) {
      return { _tag: "Disabled", reason: `symlink or unreadable file '${fullPath}'` }
    }
    const content = unwrapOption(readSafeText(fullPath, hostIo))
    if (content === undefined) return { _tag: "Disabled", reason: `unreadable file '${fullPath}'` }
    const sha = computeContentSha256(content)
    fileShaCache?.set(relPath, sha)
    pairs.push([relPath, sha])
  }
  const payload =
    extraTag !== undefined ? JSON.stringify({ extraTag, pairs }) : JSON.stringify(pairs)
  return { _tag: "Ok", sha256: computeContentSha256(payload) }
}

const PkgJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

const TsConfigPathsSchema = Schema.fromJsonString(
  Schema.Struct({
    compilerOptions: Schema.optional(
      Schema.Struct({
        paths: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
      }),
    ),
  }),
)

const registerTsConfigWorkspacePaths = (
  repoRoot: string,
  configName: string,
  hostIo: SyncHostIo,
  workspacePackages: Map<string, string>,
): void => {
  const raw = unwrapOption(readSafeText(join(repoRoot, configName), hostIo))
  if (raw === undefined) return
  match(Schema.decodeExit(TsConfigPathsSchema)(raw))
    .with({ _tag: "Success" }, ({ value }) => {
      const paths = value.compilerOptions?.paths
      if (paths === undefined) return
      for (const [alias, targets] of Object.entries(paths)) {
        const pkgName = alias.replace(/\/\*$/, "")
        if (workspacePackages.has(pkgName)) continue
        for (const t of targets) {
          const norm = t.replace(/\\/g, "/").replace(/^\.\//, "")
          const m = /^(libs\/[^/]+\/[^/]+)\//.exec(norm)
          if (m !== null) {
            workspacePackages.set(pkgName, m[1]!)
            break
          }
        }
      }
    })
    .with({ _tag: "Failure" }, () => {})
    .exhaustive()
}

const readPkgJson = (filePath: string, hostIo: SyncHostIo) => {
  const raw =
    checkExists(filePath, hostIo) === true
      ? unwrapOption(readSafeText(filePath, hostIo))
      : undefined
  if (raw === undefined) return undefined
  return match(Schema.decodeExit(PkgJsonSchema)(raw))
    .with({ _tag: "Success" }, ({ value }) => value)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
}

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const isExactSemver = (v: unknown): v is string => typeof v === "string" && EXACT_SEMVER_RE.test(v)

const extractVitestVersionFromLockfile = (lockfileContent: string): string | undefined => {
  const importerMatch =
    /^\s+vitest:\s*\r?\n(?:\s+specifier:[^\r\n]*\r?\n)?\s+version:\s*['"]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\(|['"\s]|$)/m.exec(
      lockfileContent,
    )
  if (importerMatch !== null && isExactSemver(importerMatch[1])) return importerMatch[1]

  const pkgSectionMatch =
    /^\s+['"]?(?:\/)?vitest[@/](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)['":(\s]/m.exec(
      lockfileContent,
    )
  if (pkgSectionMatch !== null && isExactSemver(pkgSectionMatch[1])) return pkgSectionMatch[1]

  const peerMatch = /\(vitest@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)[()]/.exec(
    lockfileContent,
  )
  if (peerMatch !== null && isExactSemver(peerMatch[1])) return peerMatch[1]

  return undefined
}

const resolveRuntimeVersionTag = (
  repoRoot: string,
  hostIo: SyncHostIo,
):
  | { readonly _tag: "Ok"; readonly tag: RuntimeVersionTag }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  const localPkg = readPkgJson(join(repoRoot, "node_modules", "vitest", "package.json"), hostIo)
  if (isExactSemver(localPkg?.version)) {
    return {
      _tag: "Ok",
      tag: RuntimeVersionTag.make(`node:${process.version};vitest:${localPkg.version}`),
    }
  }

  const lockPath = join(repoRoot, "pnpm-lock.yaml")
  const lockRaw =
    checkExists(lockPath, hostIo) === true
      ? unwrapOption(readSafeText(lockPath, hostIo))
      : undefined
  if (lockRaw !== undefined) {
    const lockVer = extractVitestVersionFromLockfile(lockRaw)
    if (lockVer !== undefined) {
      return {
        _tag: "Ok",
        tag: RuntimeVersionTag.make(`node:${process.version};vitest:${lockVer}`),
      }
    }
  }

  let curDir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const ancestorPkg = readPkgJson(join(curDir, "node_modules", "vitest", "package.json"), hostIo)
    if (isExactSemver(ancestorPkg?.version)) {
      return {
        _tag: "Ok",
        tag: RuntimeVersionTag.make(`node:${process.version};vitest:${ancestorPkg.version}`),
      }
    }
    const parent = dirname(curDir)
    if (parent === curDir) break
    curDir = parent
  }

  return { _tag: "Disabled", reason: "unable to resolve exact installed vitest version" }
}

const LIBS_EXCLUDED_DIRS = new Set(["test", "dist", "node_modules", ".git", "coverage"])
const GENERAL_EXCLUDED_DIRS = new Set(["dist", "node_modules", ".git", "coverage"])

const collectOptionalDir = (
  baseDir: string,
  relPrefix: string,
  excludedDirs: ReadonlySet<string>,
  includeFile: (name: string) => boolean,
  hostIo: SyncHostIo,
  outRelPaths: Array<string>,
) => {
  const exists = checkExists(baseDir, hostIo)
  if (exists === undefined) {
    return { _tag: "Disabled" as const, reason: `failed to stat '${baseDir}'` }
  }
  if (!exists) return { _tag: "Ok" as const }
  return collectDirFilesChecked(baseDir, relPrefix, excludedDirs, includeFile, hostIo, outRelPaths)
}

const hashCheckedOrErr = (
  repoRoot: string,
  relPaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
  fileShaCache: Map<string, ContentSha256>,
  extraTag?: string,
) => hashRelFilesChecked(repoRoot, relPaths, hostIo, fileShaCache, extraTag)

export const computeMutationContextDigestsChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): MutationContextDigestsResult => {
  const fileShaCache = new Map<string, ContentSha256>()
  const workspaceRelFiles: Array<string> = []
  const rootRuntimeFiles: Array<string> = []
  const docsFiles: Array<string> = []
  const agentPatternsFiles: Array<string> = []
  const adaptersFiles: Array<string> = []
  const toolsFiles: Array<string> = []
  const appsTestHelpersFiles: Array<string> = []
  const allLibsSrcFiles: Array<string> = []
  const testSupportDigests = new Map<PackageRelKey, ContentSha256>()
  const packageSupportDigests = new Map<PackageRelKey, ContentSha256>()
  const fileDigests = new Map<string, ContentSha256>()
  const workspacePackages = new Map<string, string>()

  const rootEntries = unwrapOption(readdirSafe(repoRoot, hostIo))
  if (rootEntries === undefined) {
    return { _tag: "Disabled", reason: `unreadable or symlinked repoRoot '${repoRoot}'` }
  }
  for (const entry of [...rootEntries].sort((a, b) => compareCodeUnits(a.name, b.name))) {
    if (!entry.isFile || !isRootConfigFile(entry.name)) continue
    const full = join(repoRoot, entry.name)
    if (!isNonSymlink(full, hostIo)) {
      return { _tag: "Disabled", reason: `symlink detected at root config '${full}'` }
    }
    rootRuntimeFiles.push(entry.name)
    workspaceRelFiles.push(entry.name)
    if (/^tsconfig.*\.json$/.test(entry.name)) {
      registerTsConfigWorkspacePaths(repoRoot, entry.name, hostIo, workspacePackages)
    }
  }

  for (const runtimeTool of ["tools/node-ts-resolver.mjs", "tools/parallel-vitest-batch.mjs"]) {
    const fullTool = join(repoRoot, runtimeTool)
    const exists = checkExists(fullTool, hostIo)
    if (exists === undefined) {
      return { _tag: "Disabled", reason: `failed to stat '${fullTool}'` }
    }
    if (exists) {
      if (!isNonSymlink(fullTool, hostIo)) {
        return { _tag: "Disabled", reason: `symlink detected at '${fullTool}'` }
      }
      rootRuntimeFiles.push(runtimeTool)
    }
  }

  const bucketWalks: ReadonlyArray<
    readonly [string, string, ReadonlySet<string>, (name: string) => boolean, Array<string>]
  > = [
    ["agent-patterns", "agent-patterns", GENERAL_EXCLUDED_DIRS, isMarkdownFile, agentPatternsFiles],
    ["docs/adr", "docs/adr", GENERAL_EXCLUDED_DIRS, isMarkdownFile, docsFiles],
    ["docs/adrs", "docs/adrs", GENERAL_EXCLUDED_DIRS, isMarkdownFile, docsFiles],
    ["docs/scenarios", "docs/scenarios", GENERAL_EXCLUDED_DIRS, isMarkdownFile, docsFiles],
    ["docs/specs", "docs/specs", GENERAL_EXCLUDED_DIRS, isMarkdownFile, docsFiles],
    ["tools", "tools", GENERAL_EXCLUDED_DIRS, isToolScriptFile, toolsFiles],
    ["adapters", "adapters", GENERAL_EXCLUDED_DIRS, () => true, adaptersFiles],
    ["libs", "libs", LIBS_EXCLUDED_DIRS, () => true, allLibsSrcFiles],
  ]
  for (const [subPath, relPrefix, excluded, predicate, bucket] of bucketWalks) {
    const err = disabledErr(
      collectOptionalDir(join(repoRoot, subPath), relPrefix, excluded, predicate, hostIo, bucket),
    )
    if (err !== undefined) return err
  }
  workspaceRelFiles.push(
    ...agentPatternsFiles,
    ...docsFiles,
    ...toolsFiles,
    ...adaptersFiles,
    ...allLibsSrcFiles,
  )

  const libsDir = join(repoRoot, "libs")
  const libsExists = checkExists(libsDir, hostIo)
  if (libsExists === undefined) return { _tag: "Disabled", reason: `failed to stat '${libsDir}'` }
  if (libsExists) {
    const scopes = unwrapOption(readdirSafe(libsDir, hostIo))
    if (scopes === undefined)
      return { _tag: "Disabled", reason: `unreadable directory '${libsDir}'` }
    for (const scope of [...scopes].sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (!scope.isDirectory || GENERAL_EXCLUDED_DIRS.has(scope.name)) continue
      const scopeDir = join(libsDir, scope.name)
      const scopeDocsErr = disabledErr(
        collectOptionalDir(
          join(scopeDir, "docs"),
          `libs/${scope.name}/docs`,
          GENERAL_EXCLUDED_DIRS,
          () => true,
          hostIo,
          docsFiles,
        ),
      )
      if (scopeDocsErr !== undefined) return scopeDocsErr

      const pkgs = unwrapOption(readdirSafe(scopeDir, hostIo))
      if (pkgs === undefined)
        return { _tag: "Disabled", reason: `unreadable directory '${scopeDir}'` }
      for (const pkg of [...pkgs].sort((a, b) => compareCodeUnits(a.name, b.name))) {
        if (!pkg.isDirectory || GENERAL_EXCLUDED_DIRS.has(pkg.name)) continue
        const pkgKey = PackageRelKey.make(`${scope.name}/${pkg.name}`)
        const pkgDir = join(scopeDir, pkg.name)
        const pkgJsonMeta = readPkgJson(join(pkgDir, "package.json"), hostIo)
        if (pkgJsonMeta?.name !== undefined && pkgJsonMeta.name.length > 0) {
          workspacePackages.set(pkgJsonMeta.name, `libs/${pkgKey}`)
        }
        const supportFiles: Array<string> = []
        const pkgSupportFiles: Array<string> = []
        const pkgEntries = unwrapOption(readdirSafe(pkgDir, hostIo))
        if (pkgEntries === undefined)
          return { _tag: "Disabled", reason: `unreadable directory '${pkgDir}'` }
        let hasVitestConfig = false
        for (const pe of [...pkgEntries].sort((a, b) => compareCodeUnits(a.name, b.name))) {
          if (!pe.isFile) continue
          const relEntry = `libs/${pkgKey}/${pe.name}`
          if (/^vitest\.config\..+$/.test(pe.name)) {
            const fullCfg = join(pkgDir, pe.name)
            if (!isNonSymlink(fullCfg, hostIo)) {
              return { _tag: "Disabled", reason: `symlink detected at '${fullCfg}'` }
            }
            supportFiles.push(relEntry)
            pkgSupportFiles.push(relEntry)
            hasVitestConfig = true
          }
        }
        const pkgPrefix = `libs/${pkgKey}/`
        for (const libFile of allLibsSrcFiles) {
          if (libFile.startsWith(pkgPrefix) && !isTsJsFile(libFile)) {
            pkgSupportFiles.push(libFile)
          }
        }
        const testDir = join(pkgDir, "test")
        const hasTestDir = checkExists(testDir, hostIo)
        if (hasTestDir === undefined)
          return { _tag: "Disabled", reason: `failed to stat '${testDir}'` }
        if (hasTestDir) {
          const allPkgTestFiles: Array<string> = []
          const testErr = disabledErr(
            collectDirFilesChecked(
              testDir,
              `libs/${pkgKey}/test`,
              GENERAL_EXCLUDED_DIRS,
              () => true,
              hostIo,
              allPkgTestFiles,
            ),
          )
          if (testErr !== undefined) return testErr
          for (const tf of allPkgTestFiles) {
            if (!isTestFile(tf)) {
              supportFiles.push(tf)
              pkgSupportFiles.push(tf)
              workspaceRelFiles.push(tf)
            }
            if (isTsJsFile(tf)) {
              const res = hashCheckedOrErr(repoRoot, [tf], hostIo, fileShaCache)
              const err = match(res)
                .with({ _tag: "Ok" }, () => undefined)
                .with({ _tag: "Disabled" }, (d) => d)
                .exhaustive()
              if (err !== undefined) return err
            }
          }
        }
        if (hasVitestConfig || hasTestDir) {
          const supportErr = match(hashCheckedOrErr(repoRoot, supportFiles, hostIo, fileShaCache))
            .with({ _tag: "Ok" }, ({ sha256 }) => {
              testSupportDigests.set(pkgKey, sha256)
              return undefined
            })
            .with({ _tag: "Disabled" }, (d) => d)
            .exhaustive()
          if (supportErr !== undefined) return supportErr
        }
        const pkgSupportErr = match(
          hashCheckedOrErr(repoRoot, pkgSupportFiles, hostIo, fileShaCache),
        )
          .with({ _tag: "Ok" }, ({ sha256 }) => {
            packageSupportDigests.set(pkgKey, sha256)
            return undefined
          })
          .with({ _tag: "Disabled" }, (d) => d)
          .exhaustive()
        if (pkgSupportErr !== undefined) return pkgSupportErr
      }
    }
  }

  const appsDir = join(repoRoot, "apps")
  const appsExists = checkExists(appsDir, hostIo)
  if (appsExists === undefined) return { _tag: "Disabled", reason: `failed to stat '${appsDir}'` }
  if (appsExists) {
    const apps = unwrapOption(readdirSafe(appsDir, hostIo))
    if (apps === undefined) return { _tag: "Disabled", reason: `unreadable directory '${appsDir}'` }
    for (const app of [...apps].sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (!app.isDirectory || GENERAL_EXCLUDED_DIRS.has(app.name)) continue
      const appErr = disabledErr(
        collectOptionalDir(
          join(appsDir, app.name, "test"),
          `apps/${app.name}/test`,
          GENERAL_EXCLUDED_DIRS,
          (name) => !isTestFile(name),
          hostIo,
          appsTestHelpersFiles,
        ),
      )
      if (appErr !== undefined) return appErr
      const appSrcErr = disabledErr(
        collectOptionalDir(
          join(appsDir, app.name, "src"),
          `apps/${app.name}/src`,
          GENERAL_EXCLUDED_DIRS,
          (name) => !isTestFile(name),
          hostIo,
          appsTestHelpersFiles,
        ),
      )
      if (appSrcErr !== undefined) return appSrcErr
      const appDocsErr = disabledErr(
        collectOptionalDir(
          join(appsDir, app.name, "docs"),
          `apps/${app.name}/docs`,
          GENERAL_EXCLUDED_DIRS,
          () => true,
          hostIo,
          docsFiles,
        ),
      )
      if (appDocsErr !== undefined) return appDocsErr
    }
  }
  workspaceRelFiles.push(...appsTestHelpersFiles)

  const unwrapShaOrErr = (
    res:
      | { readonly _tag: "Ok"; readonly sha256: ContentSha256 }
      | { readonly _tag: "Disabled"; readonly reason: string },
  ) =>
    match(res)
      .with({ _tag: "Ok" }, ({ sha256 }) => sha256)
      .with({ _tag: "Disabled" }, (d) => d)
      .exhaustive()

  const runtimeVersionOrErr = match(resolveRuntimeVersionTag(repoRoot, hostIo))
    .with({ _tag: "Ok" }, ({ tag }) => tag)
    .with({ _tag: "Disabled" }, (d) => d)
    .exhaustive()
  if (typeof runtimeVersionOrErr !== "string") return runtimeVersionOrErr
  const runtimeVersion = runtimeVersionOrErr
  const rootSha = unwrapShaOrErr(
    hashCheckedOrErr(repoRoot, rootRuntimeFiles, hostIo, fileShaCache, runtimeVersion),
  )
  if (typeof rootSha !== "string") return rootSha
  const docsSha = unwrapShaOrErr(hashCheckedOrErr(repoRoot, docsFiles, hostIo, fileShaCache))
  if (typeof docsSha !== "string") return docsSha
  const agentSha = unwrapShaOrErr(
    hashCheckedOrErr(repoRoot, agentPatternsFiles, hostIo, fileShaCache),
  )
  if (typeof agentSha !== "string") return agentSha
  const adaptersSha = unwrapShaOrErr(
    hashCheckedOrErr(repoRoot, adaptersFiles, hostIo, fileShaCache),
  )
  if (typeof adaptersSha !== "string") return adaptersSha
  const toolsSha = unwrapShaOrErr(hashCheckedOrErr(repoRoot, toolsFiles, hostIo, fileShaCache))
  if (typeof toolsSha !== "string") return toolsSha
  const appsSha = unwrapShaOrErr(
    hashCheckedOrErr(repoRoot, appsTestHelpersFiles, hostIo, fileShaCache),
  )
  if (typeof appsSha !== "string") return appsSha
  const allLibsSha = unwrapShaOrErr(
    hashCheckedOrErr(repoRoot, allLibsSrcFiles, hostIo, fileShaCache),
  )
  if (typeof allLibsSha !== "string") return allLibsSha
  const wsSha = unwrapShaOrErr(hashCheckedOrErr(repoRoot, workspaceRelFiles, hostIo, fileShaCache))
  if (typeof wsSha !== "string") return wsSha

  for (const [relPath, sha] of fileShaCache.entries()) {
    if (relPath.startsWith("libs/") && isTsJsFile(relPath)) {
      fileDigests.set(relPath, sha)
    }
  }

  return {
    _tag: "Ok",
    digests: {
      workspaceSrcDigest: wsSha,
      rootRuntimeDigest: rootSha,
      allLibsSrcDigest: allLibsSha,
      docsDigest: docsSha,
      agentPatternsDigest: agentSha,
      adaptersDigest: adaptersSha,
      toolsDigest: toolsSha,
      appsTestHelpersDigest: appsSha,
      packageSupportDigests,
      testSupportDigests,
      fileDigests,
      workspacePackages,
      runtimeVersion,
    },
  }
}

export const computeMutationContextDigests = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Option.Option<MutationContextDigests> =>
  match(computeMutationContextDigestsChecked(repoRoot, hostIo))
    .with({ _tag: "Ok" }, ({ digests }) => Option.some(digests))
    .with({ _tag: "Disabled" }, () => Option.none())
    .exhaustive()
