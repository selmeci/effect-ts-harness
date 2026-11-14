import { createRequire } from "node:module"
import * as path from "node:path"
import type { SyncHostIo } from "@harness/service"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { type Project, ts } from "ts-morph"
export { ts }
import {
  type BranchingViolation, EffectFnNode, type HarnessGraph, PackageTag, type PatternDocNode,
  SchemaDefNode, ServiceLayerNode, ServiceTagNode, TaggedErrorNode, ViolationRule,
} from "../model.js"
import {
  computeDynamicPaths, hasExportModifier, resolveContainedRelPath, resolveRepoRoot, sha256Hex,
} from "./extractor-types-and-helpers.js"

export interface SourceFileInput {
  readonly filePath: string
  readonly content: string
  readonly packageTag: PackageTag
}

export interface FileGraphFragment {
  readonly filePath: string
  readonly packageTag?: PackageTag | undefined
  readonly contentSha256: string
  readonly declHash: string
  readonly importedSpecs: ReadonlyArray<string>
  readonly fns: ReadonlyArray<EffectFnNode>
  readonly services?: ReadonlyArray<ServiceTagNode> | undefined
  readonly layers: ReadonlyArray<ServiceLayerNode>
  readonly errors?: ReadonlyArray<TaggedErrorNode> | undefined
  readonly schemas?: ReadonlyArray<SchemaDefNode> | undefined
  readonly requiresService: ReadonlyArray<{ readonly callerQualname: string; readonly tagId: string }>
  readonly failsWith: ReadonlyArray<{ readonly callerQualname: string; readonly errorTag: string }>
  readonly providesService: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>
  readonly layerRequires: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>
  readonly branchingViolations: ReadonlyArray<BranchingViolation>
}

export interface TypeScriptProgramSession {
  readonly repoRoot: string
  readonly hostIo?: SyncHostIo | undefined
  persistToDisk?: boolean | undefined
  oldProgram?: ts.Program | undefined
  project?: Project | undefined
  readonly sourceFileCache: Map<string, {
    readonly packageTag?: PackageTag | undefined
    readonly contentSha256: string
    readonly declHash: string
    readonly sourceFile?: ts.SourceFile | undefined
    readonly importedSpecs: ReadonlyArray<string>
  }>
  readonly fileFragmentCache: Map<string, FileGraphFragment>
  readonly reverseImportsByFile: Map<string, Set<string>>
  lastReextractedFiles: ReadonlyArray<string>
  signatureCleanCutoffCount: number
  warmHitCount: number
  lastWorkspaceSnapshot?: {
    readonly inputShaMap: ReadonlyMap<string, string>
    readonly testShaMap: ReadonlyMap<string, string>
    readonly govShaMap: ReadonlyMap<string, string>
    readonly patternShaMap: ReadonlyMap<string, string>
    readonly baseTopologyHash?: string | undefined
    readonly domainContractInputHash?: string | undefined
    readonly unassertedStateViolations?: ReadonlyArray<BranchingViolation> | undefined
    readonly nodeSqliteTestViolations?: ReadonlyArray<BranchingViolation> | undefined
    readonly graph: HarnessGraph
  } | undefined
}

export interface TypeExtractorOptions {
  readonly repoRoot?: string | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly patternDocs?: ReadonlyArray<PatternDocNode> | undefined
  readonly overlays?: Readonly<Record<string, string>> | undefined
  readonly previousProgram?: ts.Program | undefined
  readonly session?: TypeScriptProgramSession | undefined
}

export const emitDeclarationSignatureText = (sourceFile: ts.SourceFile): string => {
  const parts: Array<string> = []

  const extractStubSignatures = (node: ts.Node): Array<string> => {
    const stubs: Array<string> = []
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sourceFile)
        if ((callee === "stub" || callee.endsWith(".stub")) && n.typeArguments !== undefined) {
          stubs.push(`stub<${n.typeArguments.map((t) => t.getText(sourceFile)).join(",")}>`)
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(node)
    return stubs
  }

  const formatFnLikeSignature = (
    fn: ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration,
    hasOuterExplicitType: boolean = false,
  ): string => {
    const typeParams = fn.typeParameters ? `<${fn.typeParameters.map((tp) => tp.getText(sourceFile)).join(",")}>` : ""
    const params = fn.parameters.map((p) => `${p.name.getText(sourceFile)}${p.questionToken ? "?" : ""}${p.type ? `: ${p.type.getText(sourceFile)}` : ""}`).join(",")
    const retType = fn.type ? `: ${fn.type.getText(sourceFile)}` : ""
    const stubs = fn.body ? extractStubSignatures(fn.body) : []
    const unannotatedBody = fn.type === undefined && !hasOuterExplicitType && stubs.length === 0 && fn.body
      ? [fn.body.getText(sourceFile).replace(/\s+/g, " ").trim()] : []
    const bodySig = [...stubs, ...unannotatedBody]
    return `(${typeParams}(${params})${retType}${bodySig.length > 0 ? `[${bodySig.join(";")}]` : ""})`
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
      parts.push(stmt.getText(sourceFile).trim())
      continue
    }
    if (!hasExportModifier(stmt)) continue
    if (
      ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)
    ) {
      parts.push(stmt.getText(sourceFile).trim())
      continue
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const fnName = stmt.name?.text ?? "default"
      parts.push(`export function ${fnName}${formatFnLikeSignature(stmt, false)}`)
      continue
    }
    if (ts.isClassDeclaration(stmt)) {
      const clsName = stmt.name?.text ?? "AnonymousClass"
      const heritage = stmt.heritageClauses ? stmt.heritageClauses.map((h) => h.getText(sourceFile)).join(" ") : ""
      const memberSigs = stmt.members.map((m) => {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          const mName = m.name ? m.name.getText(sourceFile) : "constructor"
          const params = m.parameters.map((p) => p.getText(sourceFile)).join(",")
          const ret = m.type ? `: ${m.type.getText(sourceFile)}` : m.body ? ` { ${m.body.getText(sourceFile).replace(/\s+/g, " ").trim()} }` : ""
          return `${mName}(${params})${ret}`
        }
        return m.getText(sourceFile).trim()
      })
      parts.push(`export class ${clsName} ${heritage} { ${memberSigs.join("; ")} }`)
      continue
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const varName = decl.name.getText(sourceFile)
        const hasVarType = decl.type !== undefined
        const explicitType = hasVarType ? `: ${decl.type.getText(sourceFile)}` : ""
        const init = decl.initializer
        if (!init) { parts.push(`export const ${varName}${explicitType}`); continue }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          parts.push(`export const ${varName}${explicitType} = ${formatFnLikeSignature(init, hasVarType)}`); continue
        }
        if (ts.isCallExpression(init)) {
          const outerCallee = init.expression
          if (ts.isCallExpression(outerCallee)) {
            const innerText = outerCallee.expression.getText(sourceFile)
            if (innerText === "Effect.fn" || innerText === "Effect.fnUntraced") {
              const spanArg = outerCallee.arguments[0]?.getText(sourceFile) ?? ""
              const fnArg = init.arguments[0]
              if (fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
                parts.push(`export const ${varName}${explicitType} = ${innerText}(${spanArg})${formatFnLikeSignature(fnArg, hasVarType)}`)
                continue
              }
            }
          }
          if (!ts.isCallExpression(outerCallee) && outerCallee.getText(sourceFile) === "Effect.fnUntraced") {
            const fnArg = init.arguments[0]
            if (fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
              parts.push(`export const ${varName}${explicitType} = Effect.fnUntraced${formatFnLikeSignature(fnArg, hasVarType)}`)
              continue
            }
          }
        }
        parts.push(`export const ${varName}${explicitType} = ${init.getText(sourceFile).trim()}`)
      }
    }
  }

  return parts.join("\n")
}

export const computeDeclHash = (sourceFileOrContent: ts.SourceFile | string): string => {
  const sf = typeof sourceFileOrContent === "string"
    ? ts.createSourceFile("module.ts", sourceFileOrContent, ts.ScriptTarget.Latest, true)
    : sourceFileOrContent
  return sha256Hex(emitDeclarationSignatureText(sf))
}

export const extractModuleSpecifiers = (sourceFile: ts.SourceFile): ReadonlyArray<string> => {
  const specs: Array<string> = []
  for (const stmt of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      specs.push(stmt.moduleSpecifier.text)
    }
  }
  return specs
}

const FILE_GRAPH_CACHE_VERSION = "file-graph-v1"

const BranchingViolationSchema = Schema.Struct({
  rule: ViolationRule, message: Schema.String, file: Schema.String,
  line: Schema.Int, enclosingSymbol: Schema.String, path: Schema.optional(Schema.Array(Schema.String)),
})

const FileGraphFragmentSchema = Schema.Struct({
  filePath: Schema.String, packageTag: Schema.optional(PackageTag), contentSha256: Schema.String, declHash: Schema.String,
  importedSpecs: Schema.Array(Schema.String), fns: Schema.Array(EffectFnNode), services: Schema.optional(Schema.Array(ServiceTagNode)),
  layers: Schema.Array(ServiceLayerNode), errors: Schema.optional(Schema.Array(TaggedErrorNode)), schemas: Schema.optional(Schema.Array(SchemaDefNode)),
  requiresService: Schema.Array(Schema.Struct({ callerQualname: Schema.String, tagId: Schema.String })),
  failsWith: Schema.Array(Schema.Struct({ callerQualname: Schema.String, errorTag: Schema.String })),
  providesService: Schema.Array(Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String })),
  layerRequires: Schema.Array(Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String })),
  branchingViolations: Schema.Array(BranchingViolationSchema),
})

const FileGraphCacheStoreSchema = Schema.Struct({
  version: Schema.String,
  fragments: Schema.Record(Schema.String, FileGraphFragmentSchema),
})

const decodeFileGraphCacheStore = Schema.decodeOption(
  Schema.fromJsonString(FileGraphCacheStoreSchema),
)

const resolveFileGraphCachePath = (repoRoot: string): string =>
  path.join(repoRoot, ".harness", "cache", "file-graph-v1.json")

export const loadFileGraphFragmentsFromDisk = (
  repoRoot: string,
  session: TypeScriptProgramSession,
  hostIo: SyncHostIo | undefined = session.hostIo,
): void => {
  if (hostIo === undefined) return
  const cachePath = resolveFileGraphCachePath(repoRoot)
  if (!hostIo.existsSync(cachePath)) return
  Result.try(() => {
    const raw = hostIo.readTextSync(cachePath)
    const decoded = decodeFileGraphCacheStore(raw)
    match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        if (value.version !== FILE_GRAPH_CACHE_VERSION) return
        for (const [relPath, frag] of Object.entries(value.fragments)) {
          session.fileFragmentCache.set(relPath, frag)
          session.sourceFileCache.set(relPath, {
            packageTag: frag.packageTag,
            contentSha256: frag.contentSha256,
            declHash: frag.declHash,
            importedSpecs: frag.importedSpecs,
          })
        }
      })
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
  })
}

export const saveFileGraphFragmentsToDisk = (
  repoRoot: string,
  session: TypeScriptProgramSession,
  hostIo: SyncHostIo | undefined = session.hostIo,
): void => {
  if (session.persistToDisk !== true || hostIo === undefined) return
  const cachePath = resolveFileGraphCachePath(repoRoot)
  Result.try(() => {
    hostIo.mkdirRecursiveSync(path.dirname(cachePath))
    const fragments: Record<string, FileGraphFragment> = {}
    for (const [relPath, frag] of session.fileFragmentCache.entries()) {
      fragments[relPath] = frag
    }
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    Result.try(() => {
      hostIo.writeTextSync(tmpPath, JSON.stringify({ version: FILE_GRAPH_CACHE_VERSION, fragments }))
      hostIo.renameSync(tmpPath, cachePath)
    })
    if (hostIo.existsSync(tmpPath)) {
      Result.try(() => hostIo.unlinkSync(tmpPath))
    }
  })
}

export const createTypeScriptProgramSession = (
  repoRoot: string = process.cwd(),
  hostIo?: SyncHostIo,
): TypeScriptProgramSession => {
  const root = path.resolve(repoRoot)
  const realRepoRoot = hostIo !== undefined && hostIo.existsSync(root) ? hostIo.realpathSync(root) : root
  return {
    repoRoot: realRepoRoot,
    ...(hostIo !== undefined ? { hostIo } : {}),
    sourceFileCache: new Map(),
    fileFragmentCache: new Map(),
    reverseImportsByFile: new Map(),
    lastReextractedFiles: [],
    signatureCleanCutoffCount: 0,
    warmHitCount: 0,
  }
}

const walkWorkspaceFiles = (
  repoRoot: string,
  filterFile: (rel: string, name: string) => boolean,
  skipTestDir: boolean,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  const results: Array<string> = []
  const walk = (current: string): void => {
    if (!hostIo.existsSync(current)) return
    for (const e of hostIo.readdirSync(current)) {
      if (
        e.name === "node_modules" || e.name === "dist" || e.name === ".nx" ||
        e.name === "repos" || e.name === ".git" || e.name === ".harness"
      ) continue
      if (skipTestDir && e.name === "test") {
        const fixturesDir = path.join(current, "test", "fixtures")
        if (hostIo.existsSync(fixturesDir)) walk(fixturesDir)
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory) { walk(full); continue }
      if (e.isFile) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (filterFile(rel, e.name)) results.push(rel)
      }
    }
  }
  for (const sub of ["libs", "apps"]) walk(path.join(repoRoot, sub))
  return results
}

export const findWorkspaceSrcFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<string> =>
  walkWorkspaceFiles(repoRoot, (rel, name) =>
    (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts") &&
    !name.endsWith(".config.ts") && !name.endsWith(".test.ts") && !name.endsWith(".spec.ts") &&
    (rel.includes("/src/") || rel.includes("/test/fixtures/") || rel.endsWith("alchemy.run.ts")), true, hostIo)

export const findWorkspaceTestFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<string> =>
  walkWorkspaceFiles(repoRoot, (rel, name) =>
    (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) &&
    (rel.includes("/test/") || name.endsWith(".spec.ts")), false, hostIo)

export interface ExtractTypeGraphOptions {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly overlays?: Readonly<Record<string, string>> | undefined
  readonly previousProgram?: ts.Program | undefined
  readonly session?: TypeScriptProgramSession | undefined
}

export const resolveTsLibDir = (root: string, hostIo?: SyncHostIo): string | undefined => {
  const workspaceRoot = resolveRepoRoot(import.meta.dirname, hostIo)
  const fileExists = (p: string) => (hostIo !== undefined ? hostIo.existsSync(p) : ts.sys.fileExists(p))
  const dirExists = (p: string) => (hostIo !== undefined ? hostIo.existsSync(p) : ts.sys.directoryExists(p))
  const readDirNames = (p: string): ReadonlyArray<string> =>
    hostIo !== undefined
      ? Result.getOrElse(Result.try(() => hostIo.readdirSync(p).map((e) => e.name)), () => [])
      : ts.sys.getDirectories(p)
  const dynamicResolved = Result.getOrElse(
    Result.try(() => {
      const req = createRequire(path.join(workspaceRoot, "package.json"))
      const tsEntry = req.resolve("typescript")
      return path.dirname(tsEntry)
    }),
    () => undefined,
  )
  const candidates = [
    ...(dynamicResolved !== undefined ? [dynamicResolved] : []),
    path.join(root, "node_modules/typescript/lib"),
    path.join(workspaceRoot, "node_modules/typescript/lib"),
  ]
  for (const c of candidates) {
    if (fileExists(path.join(c, "lib.es2023.full.d.ts"))) return c
  }
  for (const baseRoot of [root, workspaceRoot]) {
    const pnpmDir = path.join(baseRoot, "node_modules/.pnpm")
    if (dirExists(pnpmDir)) {
      for (const entry of readDirNames(pnpmDir)) {
        if (entry.startsWith("typescript@") || entry.startsWith("@typescript+typescript")) {
          const subPkg = entry.startsWith("@typescript+")
            ? entry.slice(0, entry.lastIndexOf("@")).replace("+", "/")
            : "typescript"
          const potential = path.join(pnpmDir, entry, "node_modules", subPkg, "lib")
          if (fileExists(path.join(potential, "lib.es2023.full.d.ts"))) return potential
        }
      }
    }
  }
  return undefined
}

const resolveCanonicalPath = (root: string, candidate: string, hostIo?: SyncHostIo): string | null => {
  const abs = path.resolve(root, candidate)
  const pathExists = (p: string) => hostIo !== undefined ? hostIo.existsSync(p) : ts.sys.fileExists(p) || ts.sys.directoryExists(p)
  const realPath = (p: string) => hostIo !== undefined ? hostIo.realpathSync(p) : (ts.sys.realpath?.(p) ?? p)
  return Result.getOrElse(Result.try(() => {
    if (pathExists(abs)) return realPath(abs)
    let cur = abs
    const suffixParts: Array<string> = []
    while (!pathExists(cur)) {
      const parent = path.dirname(cur)
      if (parent === cur) break
      suffixParts.unshift(path.basename(cur))
      cur = parent
    }
    return pathExists(cur) ? path.join(realPath(cur), ...suffixParts) : abs
  }), () => null)
}

const isPathWithinRealRoot = (
  realRepoRoot: string,
  canonicalPath: string,
  allowExternalDeps = false,
  realTsLibDir?: string,
  realWorkspaceRoot?: string,
  realWorkspaceNodeModules?: string,
): boolean => {
  const normRoot = realRepoRoot.replace(/\\/g, "/"), normPath = canonicalPath.replace(/\\/g, "/")
  if (normPath === normRoot || normPath.startsWith(normRoot + "/")) return true
  if (!allowExternalDeps) return false
  if (normPath === `${normRoot}/node_modules` || normPath.startsWith(`${normRoot}/node_modules/`)) return true
  if (realWorkspaceNodeModules !== undefined && (normPath === realWorkspaceNodeModules || normPath.startsWith(`${realWorkspaceNodeModules}/`))) return true
  if (realWorkspaceRoot !== undefined) {
    const normWs = realWorkspaceRoot.replace(/\\/g, "/")
    if (normPath === `${normWs}/package.json` || normPath === `${normWs}/node_modules` || normPath.startsWith(`${normWs}/node_modules/`) || normPath.startsWith(`${normWs}/libs/harness/`)) return true
  }
  return realTsLibDir !== undefined && (normPath === realTsLibDir || normPath.startsWith(`${realTsLibDir}/`))
}

export const createOverlayCompilerHost = (
  options: ts.CompilerOptions,
  overlays: Readonly<Record<string, string>>,
  oldProgram?: ts.Program,
  repoRoot: string = process.cwd(),
  hostIo?: SyncHostIo,
): ts.CompilerHost => {
  const root = resolveRepoRoot(repoRoot, hostIo)
  const pathExists = (p: string) =>
    hostIo !== undefined ? hostIo.existsSync(p) : ts.sys.fileExists(p) || ts.sys.directoryExists(p)
  const realPath = (p: string) =>
    hostIo !== undefined ? hostIo.realpathSync(p) : (ts.sys.realpath?.(p) ?? p)
  const readText = (p: string) =>
    hostIo !== undefined ? hostIo.readTextSync(p) : (ts.sys.readFile(p) ?? "")
  const realRepoRoot = pathExists(root) ? realPath(root) : path.resolve(root)
  const workspaceRoot = resolveRepoRoot(import.meta.dirname, hostIo)
  const realWorkspaceRoot = pathExists(workspaceRoot) ? realPath(workspaceRoot) : path.resolve(workspaceRoot)
  const wsNodeModules = path.join(realWorkspaceRoot, "node_modules")
  const realWorkspaceNodeModules = pathExists(wsNodeModules) ? realPath(wsNodeModules).replace(/\\/g, "/") : undefined
  const tsLibDir = resolveTsLibDir(root, hostIo)
  const realTsLibDir = tsLibDir && pathExists(tsLibDir) ? realPath(tsLibDir).replace(/\\/g, "/") : tsLibDir?.replace(/\\/g, "/")
  const isTsLibFile = (fileName: string): boolean =>
    tsLibDir !== undefined && path.basename(fileName).startsWith("lib.") && pathExists(path.join(tsLibDir, path.basename(fileName)))

  const normalizedOverlays = new Map<string, string>(), overlayDirectories = new Set<string>()
  for (const [k, v] of Object.entries(overlays)) {
    const rel = resolveContainedRelPath(root, k, hostIo)
    if (rel === null) continue
    const canonical = resolveCanonicalPath(root, k, hostIo)
    if (canonical === null || !isPathWithinRealRoot(realRepoRoot, canonical, false)) continue
    const abs = path.resolve(root, rel).replace(/\\/g, "/")
    normalizedOverlays.set(abs, v); normalizedOverlays.set(rel, v)
    let d = path.dirname(abs)
    while (d && d !== path.dirname(d)) { overlayDirectories.add(d); d = path.dirname(d) }
  }

  const isHostPathAllowed = (candidate: string): boolean => {
    const canonical = resolveCanonicalPath(root, candidate, hostIo)
    return canonical !== null && isPathWithinRealRoot(realRepoRoot, canonical, true, realTsLibDir, realWorkspaceRoot, realWorkspaceNodeModules)
  }

  const findOverlay = (fileName: string): string | undefined => {
    if (!isHostPathAllowed(fileName)) return undefined
    const norm = fileName.replace(/\\/g, "/"), direct = normalizedOverlays.get(norm)
    if (direct !== undefined) return direct
    const rel = resolveContainedRelPath(root, fileName, hostIo)
    if (rel === null) return undefined
    const abs = path.resolve(root, rel).replace(/\\/g, "/")
    return normalizedOverlays.get(abs) ?? normalizedOverlays.get(rel)
  }

  const baseHost = ts.createCompilerHost(options, true)
  return {
    ...baseHost,
    ...(tsLibDir !== undefined ? { getDefaultLibLocation: () => tsLibDir } : {}),
    getDirectories: (dirName) => isHostPathAllowed(dirName) ? (baseHost.getDirectories?.(dirName) ?? []).filter((e) => isHostPathAllowed(path.join(dirName, e))) : [],
    realpath: (p) => (isHostPathAllowed(p) && baseHost.realpath ? baseHost.realpath(p) : p),
    directoryExists: (dirName) => {
      if (!isHostPathAllowed(dirName)) return false
      const norm = dirName.replace(/\\/g, "/"), abs = path.resolve(root, norm).replace(/\\/g, "/")
      return overlayDirectories.has(abs) || overlayDirectories.has(norm) || (baseHost.directoryExists?.(dirName) ?? false)
    },
    fileExists: (fileName) => {
      if (!isHostPathAllowed(fileName)) return false
      return findOverlay(fileName) !== undefined || isTsLibFile(fileName) || baseHost.fileExists(fileName)
    },
    readFile: (fileName) => {
      if (!isHostPathAllowed(fileName)) return undefined
      const ov = findOverlay(fileName)
      if (ov !== undefined) return ov
      if (isTsLibFile(fileName) && tsLibDir !== undefined) return readText(path.join(tsLibDir, path.basename(fileName)))
      return baseHost.readFile(fileName)
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (!isHostPathAllowed(fileName)) return undefined
      const overlayContent = findOverlay(fileName)
      if (overlayContent !== undefined) return ts.createSourceFile(fileName, overlayContent, languageVersion, true)
      if (isTsLibFile(fileName) && tsLibDir !== undefined) {
        const existingLib = oldProgram?.getSourceFile(fileName)
        if (existingLib !== undefined && !shouldCreateNewSourceFile) return existingLib
        return ts.createSourceFile(fileName, readText(path.join(tsLibDir, path.basename(fileName))), languageVersion, true)
      }
      const existing = oldProgram?.getSourceFile(fileName)
      if (existing !== undefined && !shouldCreateNewSourceFile) {
        const diskText = baseHost.readFile(fileName)
        if (diskText !== undefined && existing.text === diskText) return existing
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }
}

export interface OverlayDiagnosticItem {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly code: string
  readonly severity: "error" | "warning"
  readonly message: string
}

const VIRTUAL_EFFECT_VITEST_DTS = `import type { Effect } from "effect"
export declare const describe: (name: string, fn: () => void) => void
export declare const expect: (actual: unknown) => { readonly toBe: (e: unknown) => void; readonly toEqual: (e: unknown) => void; readonly toBeGreaterThan: (e: number) => void; readonly toBeDefined: () => void }
export declare const it: { (name: string, fn: () => unknown): void; readonly effect: { <A, E>(name: string, fn: () => Effect.Effect<A, E, never>): void; readonly prop: <S extends Record<string, unknown>, A, E>(name: string, schemas: S, fn: (args: { readonly [K in keyof S]: string }) => Effect.Effect<A, E, never>) => void } }
`

const VIRTUAL_EFFECT_SQL_SQLITE_DO_DTS = `import type { Context, Effect } from "effect"
export declare namespace SqliteClient { export interface SqliteClientService { <A = unknown>(strings: TemplateStringsArray, ...args: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<A>> }; export const SqliteClient: Context.Service<SqliteClientService, SqliteClientService> }
export declare namespace SqliteMigrator { export const fromRecord: (migrations: Readonly<Record<string, Effect.Effect<unknown, unknown, unknown>>>) => unknown }
`

export const evaluateOverlayDiagnostics = (
  repoRoot: string,
  overlays: Readonly<Record<string, string>>,
  session?: TypeScriptProgramSession,
  hostIo?: SyncHostIo,
): ReadonlyArray<OverlayDiagnosticItem> => {
  const effectiveHostIo = hostIo ?? session?.hostIo
  const root = resolveRepoRoot(repoRoot, effectiveHostIo)
  const overlayEntries = Object.entries(overlays)
  if (overlayEntries.length === 0) return []

  const virtualVitestPath = path.join(root, ".harness/__virtual_types__/@effect/vitest/index.d.ts")
  const virtualSqliteDoPath = path.join(root, ".harness/__virtual_types__/@effect/sql-sqlite-do/index.d.ts")
  const pathExists = (p: string) =>
    effectiveHostIo !== undefined ? effectiveHostIo.existsSync(p) : ts.sys.fileExists(p) || ts.sys.directoryExists(p)
  const workspaceRoot = pathExists(path.join(root, "libs/harness/graph/node_modules"))
    ? root
    : resolveRepoRoot(import.meta.dirname, effectiveHostIo)
  const dynamicPaths = computeDynamicPaths(root, workspaceRoot, effectiveHostIo)
  dynamicPaths["@effect/vitest"] = [path.join(root, "node_modules/@effect/vitest"), path.join(workspaceRoot, "node_modules/@effect/vitest"), virtualVitestPath]
  dynamicPaths["@effect/sql-sqlite-do"] = [path.join(root, "node_modules/@effect/sql-sqlite-do"), path.join(workspaceRoot, "node_modules/@effect/sql-sqlite-do"), virtualSqliteDoPath]
  dynamicPaths["@effect/sql-sqlite-do/SqliteMigrator"] = [path.join(root, "node_modules/@effect/sql-sqlite-do/SqliteMigrator"), path.join(workspaceRoot, "node_modules/@effect/sql-sqlite-do/SqliteMigrator"), virtualSqliteDoPath]

  for (const [k] of overlayEntries) {
    const rel = (path.isAbsolute(k) ? path.relative(root, k) : k).replace(/\\/g, "/")
    const m = rel.match(/^libs\/([^/]+)\/(contract|service|domain|core|infra)\/src\/index\.ts$/)
    if (m && m[1] && m[2]) {
      const entryAbs = path.resolve(root, rel)
      dynamicPaths[`@harness/${m[1]}-${m[2]}`] = [entryAbs]
      dynamicPaths[`@effect-${m[1]}/${m[2]}`] = [entryAbs]
      dynamicPaths[`@${m[1]}/${m[2]}`] = [entryAbs]
    }
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: root,
    paths: dynamicPaths,
  }

  const rootPkgJsonPath = path.join(root, "package.json")
  const overlaysWithVirtualTypes: Record<string, string> = {
    ...(pathExists(rootPkgJsonPath)
      ? {}
      : { [rootPkgJsonPath]: JSON.stringify({ name: "overlay-workspace", type: "module" }) }),
    [virtualVitestPath]: VIRTUAL_EFFECT_VITEST_DTS,
    [virtualSqliteDoPath]: VIRTUAL_EFFECT_SQL_SQLITE_DO_DTS,
    ...overlays,
  }

  const host = createOverlayCompilerHost(compilerOptions, overlaysWithVirtualTypes, session?.oldProgram, root, effectiveHostIo)
  const rootNames = overlayEntries
    .map(([k]) => path.resolve(root, k).replace(/\\/g, "/"))
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts"))

  if (rootNames.length === 0) return []

  const program = ts.createProgram(rootNames, compilerOptions, host, session?.oldProgram)
  if (session !== undefined) {
    session.oldProgram = program
  }

  const diagnostics: Array<OverlayDiagnosticItem> = []
  for (const fileName of rootNames) {
    const sf = program.getSourceFile(fileName)
    if (sf === undefined) continue
    const allDiags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
    for (const d of allDiags) {
      const pos = d.file !== undefined && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : { line: 0, character: 0 }
      const rel = path.relative(root, fileName).replace(/\\/g, "/")
      diagnostics.push({
        file: rel.startsWith("..") ? fileName : rel,
        line: pos.line + 1, column: pos.character + 1, code: `TS${d.code}`,
        severity: d.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      })
    }
  }
  return diagnostics
}

export const checkWorkspaceSnapshotMatch = (
  session: TypeScriptProgramSession,
  testShaMap: ReadonlyMap<string, string>,
  govShaMap: ReadonlyMap<string, string>,
  patternShaMap: ReadonlyMap<string, string>,
  inputShaMap: ReadonlyMap<string, string>,
): HarnessGraph | null => {
  const prev = session.lastWorkspaceSnapshot
  if (!prev || prev.testShaMap.size !== testShaMap.size || prev.govShaMap.size !== govShaMap.size || prev.patternShaMap.size !== patternShaMap.size || prev.inputShaMap.size !== inputShaMap.size) return null
  for (const [k, v] of testShaMap) if (prev.testShaMap.get(k) !== v) return null
  for (const [k, v] of govShaMap) if (prev.govShaMap.get(k) !== v) return null
  for (const [k, v] of patternShaMap) if (prev.patternShaMap.get(k) !== v) return null
  for (const [k, v] of inputShaMap) if (prev.inputShaMap.get(k) !== v) return null
  session.warmHitCount += inputShaMap.size
  session.lastReextractedFiles = []
  return prev.graph
}

export const computeBaseTopologyHash = (session: TypeScriptProgramSession): string =>
  sha256Hex(JSON.stringify(Array.from(session.fileFragmentCache.keys()).sort((a, b) => a.localeCompare(b)).map((k) => {
    const f = session.fileFragmentCache.get(k)
    return f === undefined ? null : { filePath: f.filePath, packageTag: f.packageTag, fns: f.fns, services: f.services, layers: f.layers, errors: f.errors, schemas: f.schemas, requiresService: f.requiresService, failsWith: f.failsWith, providesService: f.providesService, layerRequires: f.layerRequires }
  })))

export const checkTopologySnapshotMatch = (
  session: TypeScriptProgramSession,
  baseGraph: HarnessGraph,
  inputShaMap: ReadonlyMap<string, string>,
  testShaMap: ReadonlyMap<string, string>,
  govShaMap: ReadonlyMap<string, string>,
  patternShaMap: ReadonlyMap<string, string>,
  inputs: ReadonlyArray<SourceFileInput>,
): HarnessGraph | null => {
  const prev = session.lastWorkspaceSnapshot
  if (!prev || prev.unassertedStateViolations === undefined || prev.nodeSqliteTestViolations === undefined) return null
  for (const [k, v] of testShaMap) if (prev.testShaMap.get(k) !== v) return null
  for (const [k, v] of govShaMap) if (prev.govShaMap.get(k) !== v) return null
  for (const [k, v] of patternShaMap) if (prev.patternShaMap.get(k) !== v) return null

  const baseTopologyHash = computeBaseTopologyHash(session)
  if (prev.baseTopologyHash !== baseTopologyHash) return null

  const domainContractInputHash = sha256Hex(inputs.filter((inp) => inp.packageTag === "contract" || inp.packageTag === "domain").map((inp) => `${inp.filePath}:${inputShaMap.get(inp.filePath) ?? ""}`).join("|"))
  if (prev.domainContractInputHash !== domainContractInputHash) return null

  const fastGraph: HarnessGraph = {
    graph: prev.graph.graph, nodeIndexByKey: prev.graph.nodeIndexByKey,
    branchingViolations: [...(baseGraph.branchingViolations ?? []), ...prev.unassertedStateViolations, ...prev.nodeSqliteTestViolations],
    unresolvedReferences: prev.graph.unresolvedReferences,
  }
  session.lastWorkspaceSnapshot = {
    inputShaMap: new Map(inputShaMap), testShaMap: new Map(testShaMap), govShaMap: new Map(govShaMap), patternShaMap: new Map(patternShaMap),
    baseTopologyHash, domainContractInputHash, unassertedStateViolations: prev.unassertedStateViolations, nodeSqliteTestViolations: prev.nodeSqliteTestViolations, graph: fastGraph,
  }
  return fastGraph
}
