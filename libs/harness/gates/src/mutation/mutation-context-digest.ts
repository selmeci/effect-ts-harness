import { join } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ContentSha256,
  PackageRelKey,
  RuntimeVersionTag,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"

export interface MutationContextDigests {
  readonly workspaceSrcDigest: ContentSha256
  readonly testSupportDigests: ReadonlyMap<PackageRelKey, ContentSha256>
  readonly runtimeVersion: RuntimeVersionTag
}

export type MutationContextDigestsResult =
  | { readonly _tag: "Ok"; readonly digests: MutationContextDigests }
  | { readonly _tag: "Disabled"; readonly reason: string }

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
  name.endsWith(".mjs") || name.endsWith(".ts") || name.endsWith(".js")
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
):
  | { readonly _tag: "Ok"; readonly sha256: ContentSha256 }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  const sorted = [...new Set(relPaths)].sort(compareCodeUnits)
  const pairs: Array<readonly [string, ContentSha256]> = []
  for (const relPath of sorted) {
    const fullPath = join(repoRoot, relPath)
    if (!isNonSymlink(fullPath, hostIo)) {
      return { _tag: "Disabled", reason: `symlink or unreadable file '${fullPath}'` }
    }
    const content = unwrapOption(readSafeText(fullPath, hostIo))
    if (content === undefined) return { _tag: "Disabled", reason: `unreadable file '${fullPath}'` }
    pairs.push([relPath, computeContentSha256(content)])
  }
  return { _tag: "Ok", sha256: computeContentSha256(JSON.stringify(pairs)) }
}

const PkgJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.optional(Schema.String),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

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

const resolveRuntimeVersionTag = (repoRoot: string, hostIo: SyncHostIo): RuntimeVersionTag => {
  const vitestPkg = readPkgJson(join(repoRoot, "node_modules", "vitest", "package.json"), hostIo)
  const rootPkg =
    vitestPkg === undefined ? readPkgJson(join(repoRoot, "package.json"), hostIo) : undefined
  const rawVer =
    vitestPkg?.version ?? rootPkg?.devDependencies?.["vitest"] ?? rootPkg?.dependencies?.["vitest"]
  const vitestVersion = typeof rawVer === "string" && rawVer.length > 0 ? rawVer : "unknown"
  return RuntimeVersionTag.make(`node:${process.version};vitest:${vitestVersion}`)
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

export const computeMutationContextDigestsChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): MutationContextDigestsResult => {
  const workspaceRelFiles: Array<string> = []
  const testSupportDigests = new Map<PackageRelKey, ContentSha256>()

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
    workspaceRelFiles.push(entry.name)
  }

  const optionalWalks: ReadonlyArray<
    readonly [string, string, ReadonlySet<string>, (name: string) => boolean]
  > = [
    ["agent-patterns", "agent-patterns", GENERAL_EXCLUDED_DIRS, isMarkdownFile],
    ["docs/adr", "docs/adr", GENERAL_EXCLUDED_DIRS, isMarkdownFile],
    ["docs/adrs", "docs/adrs", GENERAL_EXCLUDED_DIRS, isMarkdownFile],
    ["docs/scenarios", "docs/scenarios", GENERAL_EXCLUDED_DIRS, isMarkdownFile],
    ["docs/specs", "docs/specs", GENERAL_EXCLUDED_DIRS, isMarkdownFile],
    ["tools", "tools", GENERAL_EXCLUDED_DIRS, isToolScriptFile],
    ["adapters", "adapters", GENERAL_EXCLUDED_DIRS, () => true],
    ["libs", "libs", LIBS_EXCLUDED_DIRS, () => true],
  ]
  for (const [subPath, relPrefix, excluded, predicate] of optionalWalks) {
    const err = disabledErr(
      collectOptionalDir(
        join(repoRoot, subPath),
        relPrefix,
        excluded,
        predicate,
        hostIo,
        workspaceRelFiles,
      ),
    )
    if (err !== undefined) return err
  }

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
      const pkgs = unwrapOption(readdirSafe(scopeDir, hostIo))
      if (pkgs === undefined)
        return { _tag: "Disabled", reason: `unreadable directory '${scopeDir}'` }
      for (const pkg of [...pkgs].sort((a, b) => compareCodeUnits(a.name, b.name))) {
        if (!pkg.isDirectory || GENERAL_EXCLUDED_DIRS.has(pkg.name)) continue
        const pkgKey = PackageRelKey.make(`${scope.name}/${pkg.name}`)
        const pkgDir = join(scopeDir, pkg.name)
        const supportFiles: Array<string> = []
        const pkgEntries = unwrapOption(readdirSafe(pkgDir, hostIo))
        if (pkgEntries === undefined)
          return { _tag: "Disabled", reason: `unreadable directory '${pkgDir}'` }
        let hasVitestConfig = false
        for (const pe of [...pkgEntries].sort((a, b) => compareCodeUnits(a.name, b.name))) {
          if (pe.isFile && /^vitest\.config\..+$/.test(pe.name)) {
            const fullCfg = join(pkgDir, pe.name)
            if (!isNonSymlink(fullCfg, hostIo)) {
              return { _tag: "Disabled", reason: `symlink detected at '${fullCfg}'` }
            }
            supportFiles.push(`libs/${pkgKey}/${pe.name}`)
            hasVitestConfig = true
          }
        }
        const testDir = join(pkgDir, "test")
        const hasTestDir = checkExists(testDir, hostIo)
        if (hasTestDir === undefined)
          return { _tag: "Disabled", reason: `failed to stat '${testDir}'` }
        if (hasTestDir) {
          const testErr = disabledErr(
            collectDirFilesChecked(
              testDir,
              `libs/${pkgKey}/test`,
              GENERAL_EXCLUDED_DIRS,
              (name) => !isTestFile(name),
              hostIo,
              supportFiles,
            ),
          )
          if (testErr !== undefined) return testErr
          for (const sf of supportFiles) {
            if (sf.startsWith(`libs/${pkgKey}/test/`)) workspaceRelFiles.push(sf)
          }
        }
        if (hasVitestConfig || hasTestDir) {
          const supportErr = match(hashRelFilesChecked(repoRoot, supportFiles, hostIo))
            .with({ _tag: "Ok" }, ({ sha256 }) => {
              testSupportDigests.set(pkgKey, sha256)
              return undefined
            })
            .with({ _tag: "Disabled" }, (d) => d)
            .exhaustive()
          if (supportErr !== undefined) return supportErr
        }
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
          workspaceRelFiles,
        ),
      )
      if (appErr !== undefined) return appErr
    }
  }

  const runtimeVersion = resolveRuntimeVersionTag(repoRoot, hostIo)
  return match(hashRelFilesChecked(repoRoot, workspaceRelFiles, hostIo))
    .with({ _tag: "Disabled" }, (d) => d)
    .with({ _tag: "Ok" }, ({ sha256 }) => ({
      _tag: "Ok" as const,
      digests: { workspaceSrcDigest: sha256, testSupportDigests, runtimeVersion },
    }))
    .exhaustive()
}

export const computeMutationContextDigests = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Option.Option<MutationContextDigests> =>
  match(computeMutationContextDigestsChecked(repoRoot, hostIo))
    .with({ _tag: "Ok" }, ({ digests }) => Option.some(digests))
    .with({ _tag: "Disabled" }, () => Option.none())
    .exhaustive()
