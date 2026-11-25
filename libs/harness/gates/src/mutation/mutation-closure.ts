import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type ContentSha256,
  PackageRelKey,
  type RuntimeVersionTag,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"

export interface MutationContextDigests {
  readonly workspaceSrcDigest: ContentSha256
  readonly rootRuntimeDigest: ContentSha256
  readonly allLibsSrcDigest: ContentSha256
  readonly docsDigest: ContentSha256
  readonly agentPatternsDigest: ContentSha256
  readonly adaptersDigest: ContentSha256
  readonly toolsDigest: ContentSha256
  readonly appsTestHelpersDigest: ContentSha256
  readonly packageSupportDigests: ReadonlyMap<PackageRelKey, ContentSha256>
  readonly testSupportDigests: ReadonlyMap<PackageRelKey, ContentSha256>
  readonly fileDigests: ReadonlyMap<string, ContentSha256>
  readonly workspacePackages: ReadonlyMap<string, string>
  readonly runtimeVersion: RuntimeVersionTag
}

export type MutationContextDigestsResult =
  | { readonly _tag: "Ok"; readonly digests: MutationContextDigests }
  | { readonly _tag: "Disabled"; readonly reason: string }

export interface ComputeFileMutationClosureDigestInput {
  readonly repoRoot: string
  readonly relFile: string
  readonly allReachingTests: ReadonlyArray<string>
  readonly digests: MutationContextDigests
  readonly hostIo: SyncHostIo
}

export type FileMutationClosureDigestResult =
  | {
      readonly _tag: "Ok"
      readonly closureDigest: ContentSha256
      readonly resolvedFiles: ReadonlyArray<string>
      readonly usedFallbackAllLibs: boolean
    }
  | { readonly _tag: "Disabled"; readonly reason: string }

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

const isNonSymlink = (targetPath: string, hostIo: SyncHostIo): boolean =>
  match(unwrapResult(Result.try(() => hostIo.isSymbolicLinkSync(targetPath))))
    .with({ _tag: "Some" }, ({ value }) => !value)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

const readSafeText = (filePath: string, hostIo: SyncHostIo): Option.Option<string> =>
  isNonSymlink(filePath, hostIo)
    ? unwrapResult(Result.try(() => hostIo.readTextSync(filePath)))
    : Option.none()

const checkExists = (targetPath: string, hostIo: SyncHostIo): boolean | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.existsSync(targetPath))))

const realpathOrUndefined = (targetPath: string, hostIo: SyncHostIo): string | undefined =>
  unwrapOption(unwrapResult(Result.try(() => hostIo.realpathSync(targetPath))))

const isPathContained = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const verifyClosurePathSafe = (
  repoRoot: string,
  repoReal: string,
  fullPath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const resolvedRoot = resolve(repoRoot)
  let cur = resolve(fullPath)
  while (true) {
    if (!isNonSymlink(cur, hostIo)) {
      return `symlink or unreadable path '${cur}'`
    }
    if (cur === resolvedRoot || cur === dirname(cur)) break
    cur = dirname(cur)
  }
  const targetReal = realpathOrUndefined(fullPath, hostIo)
  if (targetReal === undefined || !isPathContained(repoReal, targetReal)) {
    return `realpath escape detected for '${fullPath}'`
  }
  return undefined
}

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

interface AstClosureScan {
  readonly specifiers: ReadonlyArray<string>
  readonly hasNonLiteralDynamicImport: boolean
  readonly needsDocs: boolean
  readonly needsAgentPatterns: boolean
  readonly needsAdapters: boolean
  readonly needsTools: boolean
  readonly needsApps: boolean
  readonly referencesLibs: boolean
}

const matchesBucketText = (text: string, bucket: string): boolean =>
  text === bucket ||
  text.includes(`${bucket}/`) ||
  text.includes(`/${bucket}`) ||
  text.includes(`${bucket}\\`)

const isModuleSpecifierNode = (node: ts.Node): boolean =>
  node.parent !== undefined &&
  (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
  node.parent.moduleSpecifier === node

const isImportActualCall = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) &&
  (expr.name.text === "importActual" || expr.name.text === "importMock")

const REPO_FS_IO_IDENTIFIERS: ReadonlySet<string> = new Set([
  "readFileSync",
  "readdirSync",
  "readTextSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "hostIo",
  "REPO_ROOT",
  "REAL_REPO_ROOT",
])

const scanSourceAst = (source: string): AstClosureScan => {
  const pre = ts.preProcessFile(source, true, true)
  const specifiers: Array<string> = pre.importedFiles.map((f) => f.fileName)
  let hasNonLiteralDynamicImport = false
  let needsDocs = false
  let needsAgentPatterns = false
  let needsAdapters = false
  let needsTools = false
  let needsApps = false
  let referencesLibs = false
  let hasRepoFsIo = false

  const recordText = (text: string) => {
    if (matchesBucketText(text, "docs")) needsDocs = true
    if (matchesBucketText(text, "agent-patterns")) needsAgentPatterns = true
    if (matchesBucketText(text, "adapters")) needsAdapters = true
    if (matchesBucketText(text, "tools")) needsTools = true
    if (matchesBucketText(text, "apps")) needsApps = true
    if (matchesBucketText(text, "libs")) referencesLibs = true
  }

  const sf = ts.createSourceFile("closure.ts", source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && REPO_FS_IO_IDENTIFIERS.has(node.text)) {
      hasRepoFsIo = true
    }
    if (ts.isCallExpression(node)) {
      const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      const isViImportActual = isImportActualCall(node.expression)
      if (isDynImport || isRequire || isViImportActual) {
        const arg0 = node.arguments[0]
        if (arg0 !== undefined && ts.isStringLiteralLike(arg0)) {
          specifiers.push(arg0.text)
        } else {
          hasNonLiteralDynamicImport = true
        }
      }
    }
    if (ts.isStringLiteralLike(node) && !isModuleSpecifierNode(node)) {
      recordText(node.text)
    }
    if (ts.isTemplateExpression(node)) {
      recordText(node.head.text)
      for (const span of node.templateSpans) {
        recordText(span.literal.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return {
    specifiers,
    hasNonLiteralDynamicImport,
    needsDocs,
    needsAgentPatterns,
    needsAdapters,
    needsTools,
    needsApps,
    referencesLibs: referencesLibs && hasRepoFsIo,
  }
}

const normalizeRepoRelPath = (repoRoot: string, rawPath: string): string => {
  const rel = isAbsolute(rawPath) ? relative(repoRoot, rawPath) : rawPath
  return rel.replace(/\\/g, "/").replace(/^\.\//, "")
}

const candidateFilesForBase = (baseRel: string): ReadonlyArray<string> => {
  const cleanBase = baseRel === "." || baseRel === "" ? "." : baseRel.replace(/\/+$/, "")
  const extMatch = /\.(js|jsx|mjs|cjs)$/.exec(cleanBase)
  if (extMatch !== null) {
    const stem = cleanBase.slice(0, -extMatch[0].length)
    return [
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.mts`,
      `${stem}.cts`,
      cleanBase,
      `${stem}/index.ts`,
      `${stem}/index.tsx`,
      `${stem}/index.mts`,
      `${stem}/index.js`,
    ]
  }
  if (/\.(ts|tsx|mts|cts)$/.test(cleanBase)) {
    return [cleanBase]
  }
  const hasOtherExt = /\/[^/]+\.[^/]+$/.test(cleanBase) || /^[^/]+\.[^/]+$/.test(cleanBase)
  const indexPrefix = cleanBase === "." ? "" : `${cleanBase}/`
  return [
    ...(hasOtherExt ? [cleanBase] : []),
    ...TS_JS_EXTENSIONS.map((ext) => `${cleanBase}${ext}`),
    `${indexPrefix}index.ts`,
    `${indexPrefix}index.tsx`,
    `${indexPrefix}index.mts`,
    `${indexPrefix}index.js`,
  ]
}

const resolveExistingCandidate = (
  repoRoot: string,
  candidates: ReadonlyArray<string>,
  fileDigests: ReadonlyMap<string, ContentSha256>,
  hostIo: SyncHostIo,
):
  | { readonly _tag: "Found"; readonly relPath: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Disabled"; readonly reason: string } => {
  for (const cand of candidates) {
    if (cand.startsWith("..") || cand.length === 0) continue
    if (fileDigests.has(cand)) return { _tag: "Found", relPath: cand }
    const full = join(repoRoot, cand)
    const exists = checkExists(full, hostIo)
    if (exists === undefined) {
      return { _tag: "Disabled", reason: `failed to stat '${full}'` }
    }
    if (exists) {
      const isFile = unwrapOption(unwrapResult(Result.try(() => hostIo.isFileSync(full))))
      if (isFile === true) return { _tag: "Found", relPath: cand }
      if (!isNonSymlink(full, hostIo)) {
        return { _tag: "Disabled", reason: `symlink detected at '${full}'` }
      }
    }
  }
  return { _tag: "Missing" }
}

const PackageExportsSchema = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

const extractExportTargetString = (val: unknown): string | undefined => {
  if (typeof val === "string") return val
  return match(Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown))(val))
    .with({ _tag: "Success" }, ({ value: rec }) => {
      for (const key of ["import", "default", "types", "node"]) {
        if (key in rec) {
          const nested = extractExportTargetString(rec[key])
          if (nested !== undefined) return nested
        }
      }
      return undefined
    })
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
}

const expandExportTargetCandidates = (
  pkgRelDir: string,
  targetStr: string,
): ReadonlyArray<string> => {
  const normalizedTarget = posix.normalize(posix.join(pkgRelDir, targetStr))
  const candidates = [...candidateFilesForBase(normalizedTarget)]
  const distConverted = targetStr.replace(/^\.\/dist\//, "./src/").replace(/\/dist\//, "/src/")
  if (distConverted !== targetStr) {
    const normSrc = posix.normalize(posix.join(pkgRelDir, distConverted))
    candidates.push(...candidateFilesForBase(normSrc))
  }
  return candidates
}

const matchWildcardExport = (
  exportsMap: Record<string, unknown>,
  exportKey: string,
): string | undefined => {
  for (const [pattern, rawTarget] of Object.entries(exportsMap)) {
    const starIdx = pattern.indexOf("*")
    if (starIdx === -1) continue
    const prefix = pattern.slice(0, starIdx)
    const suffix = pattern.slice(starIdx + 1)
    if (
      exportKey.length >= prefix.length + suffix.length &&
      exportKey.startsWith(prefix) &&
      exportKey.endsWith(suffix)
    ) {
      const captured = exportKey.slice(prefix.length, exportKey.length - suffix.length)
      const targetStr = extractExportTargetString(rawTarget)
      if (targetStr !== undefined) {
        return targetStr.replace(/\*/g, captured)
      }
    }
  }
  return undefined
}

const resolveWorkspacePackageImport = (
  repoRoot: string,
  spec: string,
  digests: MutationContextDigests,
  pkgExportsCache: Map<string, Record<string, unknown> | null>,
  hostIo: SyncHostIo,
) => {
  const pkgMatch = /^(@([^/]+)\/([^/]+))(?:\/(.+))?$/.exec(spec)
  if (pkgMatch === null) return { _tag: "External" as const }
  const pkgName = pkgMatch[1]!
  const scope = pkgMatch[2]!
  const pkg = pkgMatch[3]!
  const subpath = pkgMatch[4]
  const mappedDir = digests.workspacePackages.get(pkgName)
  const isWorkspaceSpec = mappedDir !== undefined || scope === "harness"
  const pkgRelDir = mappedDir ?? `libs/${scope}/${pkg}`
  const pkgJsonPath = join(repoRoot, pkgRelDir, "package.json")

  let exportsMap = pkgExportsCache.get(pkgRelDir)
  if (exportsMap === undefined) {
    const raw = unwrapOption(readSafeText(pkgJsonPath, hostIo))
    const parsed =
      raw !== undefined
        ? match(Schema.decodeExit(PackageExportsSchema)(raw))
            .with({ _tag: "Success" }, ({ value }) => value.exports ?? null)
            .with({ _tag: "Failure" }, () => null)
            .exhaustive()
        : null
    exportsMap = parsed
    pkgExportsCache.set(pkgRelDir, exportsMap)
  }

  if (exportsMap !== null) {
    const exportKey = subpath === undefined ? "." : `./${subpath}`
    const targetStr =
      extractExportTargetString(exportsMap[exportKey]) ?? matchWildcardExport(exportsMap, exportKey)
    if (targetStr !== undefined) {
      const res = resolveExistingCandidate(
        repoRoot,
        expandExportTargetCandidates(pkgRelDir, targetStr),
        digests.fileDigests,
        hostIo,
      )
      return match(res)
        .with({ _tag: "Found" }, { _tag: "Disabled" }, (r) => r)
        .with({ _tag: "Missing" }, () =>
          isWorkspaceSpec
            ? ({ _tag: "UnresolvedWorkspace", specifier: spec } as const)
            : ({ _tag: "External" } as const),
        )
        .exhaustive()
    }
  }

  const fallbackBase =
    subpath === undefined ? `${pkgRelDir}/src/index` : `${pkgRelDir}/src/${subpath}`
  const fallbackRes = resolveExistingCandidate(
    repoRoot,
    candidateFilesForBase(posix.normalize(fallbackBase)),
    digests.fileDigests,
    hostIo,
  )
  return match(fallbackRes)
    .with({ _tag: "Found" }, { _tag: "Disabled" }, (r) => r)
    .with({ _tag: "Missing" }, () =>
      isWorkspaceSpec
        ? ({ _tag: "UnresolvedWorkspace", specifier: spec } as const)
        : ({ _tag: "External" } as const),
    )
    .exhaustive()
}

const extractPackageKey = (relPath: string): string | undefined => {
  const libMatch = /^libs\/([^/]+)\/([^/]+)\//.exec(relPath)
  if (libMatch !== null) return `${libMatch[1]!}/${libMatch[2]!}`
  const appMatch = /^apps\/([^/]+)\//.exec(relPath)
  return appMatch !== null ? `apps/${appMatch[1]!}` : undefined
}

const formatDigestPresence = (digest: ContentSha256 | undefined): string =>
  digest !== undefined ? `present:${digest}` : "absent"

/**
 * Computes a per-file transitive TS/JS import-closure digest starting from `relFile` and
 * `allReachingTests`, binding `rootRuntimeDigest`, resolved file digests, touched package and
 * test-support digests (`present:<sha>` / `absent`), conditional asset bucket digests, and
 * `allLibsSrcDigest` fallback plus unresolved import specifiers when dynamic/unresolved imports occur.
 */
export const computeFileMutationClosureDigest = (
  input: ComputeFileMutationClosureDigestInput,
): FileMutationClosureDigestResult => {
  const repoReal = realpathOrUndefined(input.repoRoot, input.hostIo)
  if (repoReal === undefined) {
    return { _tag: "Disabled", reason: `unreadable repoRoot '${input.repoRoot}'` }
  }

  const queue: Array<string> = []
  const visited = new Set<string>()
  const touchedPackages = new Set<string>()
  const filePairs: Array<readonly [string, ContentSha256]> = []
  const unresolvedRelativeImports: Array<string> = []
  const unresolvedWorkspaceImports: Array<string> = []
  const pkgExportsCache = new Map<string, Record<string, unknown> | null>()

  const enqueue = (relPath: string) => {
    if (relPath.length === 0 || relPath.startsWith("..") || visited.has(relPath)) return
    visited.add(relPath)
    queue.push(relPath)
  }

  enqueue(normalizeRepoRelPath(input.repoRoot, input.relFile))
  for (const testFile of input.allReachingTests) {
    enqueue(normalizeRepoRelPath(input.repoRoot, testFile))
  }

  let needsDocs = false
  let needsAgentPatterns = false
  let needsAdapters = false
  let needsTools = false
  let needsApps = false
  let usedFallbackAllLibs = false

  while (queue.length > 0) {
    const relPath = queue.shift()!
    const pkgKey = extractPackageKey(relPath)
    if (pkgKey !== undefined) touchedPackages.add(pkgKey)

    const fullPath = join(input.repoRoot, relPath)
    const pathErr = verifyClosurePathSafe(input.repoRoot, repoReal, fullPath, input.hostIo)
    if (pathErr !== undefined) {
      return { _tag: "Disabled", reason: pathErr }
    }
    const content = unwrapOption(readSafeText(fullPath, input.hostIo))
    if (content === undefined) {
      return { _tag: "Disabled", reason: `unreadable file '${fullPath}'` }
    }
    const fileSha = input.digests.fileDigests.get(relPath) ?? computeContentSha256(content)
    filePairs.push([relPath, fileSha])

    const scan = scanSourceAst(content)
    if (scan.needsDocs) needsDocs = true
    if (scan.needsAgentPatterns) needsAgentPatterns = true
    if (scan.needsAdapters) needsAdapters = true
    if (scan.needsTools) needsTools = true
    if (scan.needsApps) needsApps = true
    if (scan.referencesLibs || scan.hasNonLiteralDynamicImport) usedFallbackAllLibs = true

    for (const spec of scan.specifiers) {
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
        const baseRel = posix.normalize(posix.join(posix.dirname(relPath), spec))
        const resolved = resolveExistingCandidate(
          input.repoRoot,
          candidateFilesForBase(baseRel),
          input.digests.fileDigests,
          input.hostIo,
        )
        const disabledReason = match(resolved)
          .with({ _tag: "Found" }, ({ relPath: r }) => {
            enqueue(r)
            return undefined
          })
          .with({ _tag: "Missing" }, () => {
            unresolvedRelativeImports.push(`${relPath} -> ${spec}`)
            usedFallbackAllLibs = true
            return undefined
          })
          .with({ _tag: "Disabled" }, ({ reason }) => reason)
          .exhaustive()
        if (disabledReason !== undefined) return { _tag: "Disabled", reason: disabledReason }
        continue
      }
      if (spec.startsWith("@")) {
        const resolved = resolveWorkspacePackageImport(
          input.repoRoot,
          spec,
          input.digests,
          pkgExportsCache,
          input.hostIo,
        )
        const disabledReason = match(resolved)
          .with({ _tag: "Found" }, ({ relPath: r }) => {
            enqueue(r)
            return undefined
          })
          .with({ _tag: "UnresolvedWorkspace" }, ({ specifier }) => {
            unresolvedWorkspaceImports.push(`${relPath} -> ${specifier}`)
            usedFallbackAllLibs = true
            return undefined
          })
          .with({ _tag: "External" }, () => undefined)
          .with({ _tag: "Disabled" }, ({ reason }) => reason)
          .exhaustive()
        if (disabledReason !== undefined) return { _tag: "Disabled", reason: disabledReason }
      }
    }
  }

  filePairs.sort((a, b) => compareCodeUnits(a[0], b[0]))
  const packageDigests = [...touchedPackages].sort(compareCodeUnits).map((pkgKey) => {
    const k = PackageRelKey.make(pkgKey)
    return [
      pkgKey,
      formatDigestPresence(input.digests.packageSupportDigests.get(k)),
      formatDigestPresence(input.digests.testSupportDigests.get(k)),
    ]
  })

  const closureDigest = computeContentSha256(
    JSON.stringify({
      rootRuntimeDigest: input.digests.rootRuntimeDigest,
      files: filePairs,
      packages: packageDigests,
      docs: needsDocs ? input.digests.docsDigest : "",
      agentPatterns: needsAgentPatterns ? input.digests.agentPatternsDigest : "",
      adapters: needsAdapters ? input.digests.adaptersDigest : "",
      tools: needsTools ? input.digests.toolsDigest : "",
      apps: needsApps ? input.digests.appsTestHelpersDigest : "",
      allLibs: usedFallbackAllLibs ? input.digests.allLibsSrcDigest : "",
      unresolvedRelativeImports: unresolvedRelativeImports.sort(compareCodeUnits),
      unresolvedWorkspaceImports: unresolvedWorkspaceImports.sort(compareCodeUnits),
    }),
  )

  return {
    _tag: "Ok",
    closureDigest,
    resolvedFiles: [...visited].sort(compareCodeUnits),
    usedFallbackAllLibs,
  }
}
