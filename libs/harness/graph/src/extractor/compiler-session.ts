import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { type Project, ts } from "ts-morph"
export { ts }
import {
  type BranchingViolation,
  EffectFnNode,
  type HarnessGraph,
  PackageTag,
  type PatternDocNode,
  SchemaDefNode,
  ServiceLayerNode,
  ServiceTagNode,
  TaggedErrorNode,
  ViolationRule,
} from "../model.js"
import {
  computeDynamicPaths,
  hasExportModifier,
  resolveContainedRelPath,
  resolveRepoRoot,
  sha256Hex,
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
  persistToDisk?: boolean | undefined
  oldProgram?: ts.Program | undefined
  project?: Project | undefined
  readonly sourceFileCache: Map<
    string,
    {
      readonly packageTag?: PackageTag | undefined
      readonly contentSha256: string
      readonly declHash: string
      readonly sourceFile?: ts.SourceFile | undefined
      readonly importedSpecs: ReadonlyArray<string>
    }
  >
  readonly fileFragmentCache: Map<string, FileGraphFragment>
  readonly reverseImportsByFile: Map<string, Set<string>>
  lastReextractedFiles: ReadonlyArray<string>
  signatureCleanCutoffCount: number
  warmHitCount: number
  lastWorkspaceSnapshot?:
    | {
        readonly inputShaMap: ReadonlyMap<string, string>
        readonly testShaMap: ReadonlyMap<string, string>
        readonly govShaMap: ReadonlyMap<string, string>
        readonly patternShaMap: ReadonlyMap<string, string>
        readonly baseTopologyHash?: string | undefined
        readonly domainContractInputHash?: string | undefined
        readonly unassertedStateViolations?: ReadonlyArray<BranchingViolation> | undefined
        readonly nodeSqliteTestViolations?: ReadonlyArray<BranchingViolation> | undefined
        readonly graph: HarnessGraph
      }
    | undefined
}

export interface TypeExtractorOptions {
  readonly repoRoot?: string | undefined
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
    const typeParams = fn.typeParameters !== undefined
      ? `<${fn.typeParameters.map((tp) => tp.getText(sourceFile)).join(",")}>`
      : ""
    const params = fn.parameters
      .map((p) => {
        const name = p.name.getText(sourceFile)
        const opt = p.questionToken !== undefined ? "?" : ""
        const typeText = p.type !== undefined ? `: ${p.type.getText(sourceFile)}` : ""
        return `${name}${opt}${typeText}`
      })
      .join(",")
    const retType = fn.type !== undefined ? `: ${fn.type.getText(sourceFile)}` : ""
    const stubs = fn.body !== undefined ? extractStubSignatures(fn.body) : []
    const unannotatedBody =
      fn.type === undefined && !hasOuterExplicitType && stubs.length === 0 && fn.body !== undefined
        ? [fn.body.getText(sourceFile).replace(/\s+/g, " ").trim()]
        : []
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
      const heritage = stmt.heritageClauses !== undefined
        ? stmt.heritageClauses.map((h) => h.getText(sourceFile)).join(" ")
        : ""
      const memberSigs: Array<string> = []
      for (const m of stmt.members) {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          const mName = m.name !== undefined ? m.name.getText(sourceFile) : "constructor"
          const params = m.parameters.map((p) => p.getText(sourceFile)).join(",")
          const ret = m.type !== undefined
            ? `: ${m.type.getText(sourceFile)}`
            : m.body !== undefined
              ? ` { ${m.body.getText(sourceFile).replace(/\s+/g, " ").trim()} }`
              : ""
          memberSigs.push(`${mName}(${params})${ret}`)
        } else {
          memberSigs.push(m.getText(sourceFile).trim())
        }
      }
      parts.push(`export class ${clsName} ${heritage} { ${memberSigs.join("; ")} }`)
      continue
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const varName = decl.name.getText(sourceFile)
        const hasVarType = decl.type !== undefined
        const explicitType = hasVarType ? `: ${decl.type.getText(sourceFile)}` : ""
        const init = decl.initializer
        if (init === undefined) {
          parts.push(`export const ${varName}${explicitType}`)
          continue
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          parts.push(`export const ${varName}${explicitType} = ${formatFnLikeSignature(init, hasVarType)}`)
          continue
        }
        if (ts.isCallExpression(init)) {
          const outerCallee = init.expression
          if (ts.isCallExpression(outerCallee)) {
            const innerCalleeText = outerCallee.expression.getText(sourceFile)
            if (innerCalleeText === "Effect.fn" || innerCalleeText === "Effect.fnUntraced") {
              const spanArg = outerCallee.arguments[0]?.getText(sourceFile) ?? ""
              const fnArg = init.arguments[0]
              if (fnArg !== undefined && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
                parts.push(
                  `export const ${varName}${explicitType} = ${innerCalleeText}(${spanArg})${formatFnLikeSignature(fnArg, hasVarType)}`,
                )
                continue
              }
            }
          } else if (outerCallee.getText(sourceFile) === "Effect.fnUntraced") {
            const fnArg = init.arguments[0]
            if (fnArg !== undefined && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
              parts.push(
                `export const ${varName}${explicitType} = Effect.fnUntraced${formatFnLikeSignature(fnArg, hasVarType)}`,
              )
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
  rule: ViolationRule,
  message: Schema.String,
  file: Schema.String,
  line: Schema.Int,
  enclosingSymbol: Schema.String,
  path: Schema.optional(Schema.Array(Schema.String)),
})

const FileGraphFragmentSchema = Schema.Struct({
  filePath: Schema.String,
  packageTag: Schema.optional(PackageTag),
  contentSha256: Schema.String,
  declHash: Schema.String,
  importedSpecs: Schema.Array(Schema.String),
  fns: Schema.Array(EffectFnNode),
  services: Schema.optional(Schema.Array(ServiceTagNode)),
  layers: Schema.Array(ServiceLayerNode),
  errors: Schema.optional(Schema.Array(TaggedErrorNode)),
  schemas: Schema.optional(Schema.Array(SchemaDefNode)),
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
): void => {
  const cachePath = resolveFileGraphCachePath(repoRoot)
  if (!existsSync(cachePath)) return
  Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync(cachePath, "utf8")
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
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  )
}

export const saveFileGraphFragmentsToDisk = (
  repoRoot: string,
  session: TypeScriptProgramSession,
): void => {
  if (session.persistToDisk !== true) return
  const cachePath = resolveFileGraphCachePath(repoRoot)
  Effect.runSync(
    Effect.try({
      try: () => {
        mkdirSync(path.dirname(cachePath), { recursive: true })
        const fragments: Record<string, FileGraphFragment> = {}
        for (const [relPath, frag] of session.fileFragmentCache.entries()) {
          fragments[relPath] = frag
        }
        const tmpPath = `${cachePath}.${process.pid}.tmp`
        writeFileSync(tmpPath, JSON.stringify({ version: FILE_GRAPH_CACHE_VERSION, fragments }), "utf8")
        renameSync(tmpPath, cachePath)
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  )
}

const warmSessionsByRoot = new Map<string, TypeScriptProgramSession>()

export const createTypeScriptProgramSession = (
  repoRoot: string = process.cwd(),
): TypeScriptProgramSession => ({
  repoRoot: path.resolve(repoRoot),
  sourceFileCache: new Map(),
  fileFragmentCache: new Map(),
  reverseImportsByFile: new Map(),
  lastReextractedFiles: [],
  signatureCleanCutoffCount: 0,
  warmHitCount: 0,
})

export const getOrCreateWarmProgramSession = (repoRoot: string): TypeScriptProgramSession => {
  const resolved = path.resolve(repoRoot)
  let session = warmSessionsByRoot.get(resolved)
  if (session === undefined) {
    session = createTypeScriptProgramSession(resolved)
    session.persistToDisk = true
    loadFileGraphFragmentsFromDisk(resolved, session)
    warmSessionsByRoot.set(resolved, session)
  }
  return session
}

export const clearWarmProgramSessions = (): void => {
  warmSessionsByRoot.clear()
}

const walkWorkspaceFiles = (
  repoRoot: string,
  filterFile: (rel: string, name: string) => boolean,
  skipTestDir = false,
): ReadonlyArray<string> => {
  const results: Array<string> = []
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const e of readdirSync(current, { withFileTypes: true })) {
      if (
        e.name === "node_modules" || e.name === "dist" || e.name === ".nx" ||
        e.name === "repos" || e.name === ".git" || e.name === ".harness"
      ) continue
      if (skipTestDir && e.name === "test") {
        const fixturesDir = path.join(current, "test", "fixtures")
        if (existsSync(fixturesDir)) walk(fixturesDir)
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (filterFile(rel, e.name)) results.push(rel)
      }
    }
  }
  for (const sub of ["libs", "apps"]) walk(path.join(repoRoot, sub))
  return results
}

export const findWorkspaceSrcFiles = (repoRoot: string): ReadonlyArray<string> =>
  walkWorkspaceFiles(repoRoot, (rel, name) =>
    (name.endsWith(".ts") || name.endsWith(".tsx")) &&
    !name.endsWith(".d.ts") && !name.endsWith(".config.ts") &&
    !name.endsWith(".test.ts") && !name.endsWith(".spec.ts") &&
    (rel.includes("/src/") || rel.includes("/test/fixtures/") || rel.endsWith("alchemy.run.ts")),
    true,
  )

export const findWorkspaceTestFiles = (repoRoot: string): ReadonlyArray<string> =>
  walkWorkspaceFiles(repoRoot, (rel, name) =>
    (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) &&
    (rel.includes("/test/") || name.endsWith(".spec.ts")),
    false,
  )

export interface ExtractTypeGraphOptions {
  readonly repoRoot: string
  readonly overlays?: Readonly<Record<string, string>> | undefined
  readonly previousProgram?: ts.Program | undefined
  readonly session?: TypeScriptProgramSession | undefined
}

export const resolveTsLibDir = (root: string): string | undefined => {
  const workspaceRoot = resolveRepoRoot(import.meta.dirname)
  const dynamicResolved = Effect.runSync(
    Effect.try({
      try: () => {
        const req = createRequire(path.join(workspaceRoot, "package.json"))
        const tsEntry = req.resolve("typescript")
        return path.dirname(tsEntry)
      },
      catch: () => undefined,
    }),
  )
  const candidates = [
    ...(dynamicResolved !== undefined ? [dynamicResolved] : []),
    path.join(root, "node_modules/typescript/lib"),
    path.join(workspaceRoot, "node_modules/typescript/lib"),
  ]
  for (const c of candidates) {
    if (existsSync(path.join(c, "lib.es2023.full.d.ts"))) return c
  }
  for (const baseRoot of [root, workspaceRoot]) {
    const pnpmDir = path.join(baseRoot, "node_modules/.pnpm")
    if (existsSync(pnpmDir)) {
      const entries = Effect.runSync(
        Effect.try({ try: () => readdirSync(pnpmDir), catch: () => [] as Array<string> }),
      )
      for (const entry of entries) {
        if (entry.startsWith("typescript@") || entry.startsWith("@typescript+typescript")) {
          const subPkg = entry.startsWith("@typescript+")
            ? entry.slice(0, entry.lastIndexOf("@")).replace("+", "/")
            : "typescript"
          const potential = path.join(pnpmDir, entry, "node_modules", subPkg, "lib")
          if (existsSync(path.join(potential, "lib.es2023.full.d.ts"))) return potential
        }
      }
    }
  }
  return undefined
}

export const createOverlayCompilerHost = (
  options: ts.CompilerOptions,
  overlays: Readonly<Record<string, string>>,
  oldProgram?: ts.Program,
  repoRoot: string = process.cwd(),
): ts.CompilerHost => {
  const root = resolveRepoRoot(repoRoot)
  const normalizedOverlays = new Map<string, string>(), overlayDirectories = new Set<string>()
  for (const [k, v] of Object.entries(overlays)) {
    const rel = resolveContainedRelPath(root, k)
    if (rel === null) continue
    const abs = path.resolve(root, rel).replace(/\\/g, "/")
    normalizedOverlays.set(abs, v); normalizedOverlays.set(rel, v)
    let d = path.dirname(abs)
    while (d && d !== path.dirname(d)) { overlayDirectories.add(d); d = path.dirname(d) }
  }

  const findOverlay = (fileName: string): string | undefined => {
    const norm = fileName.replace(/\\/g, "/"), direct = normalizedOverlays.get(norm)
    if (direct !== undefined) return direct
    const rel = resolveContainedRelPath(root, fileName)
    if (rel === null) return undefined
    const abs = path.resolve(root, rel).replace(/\\/g, "/")
    return normalizedOverlays.get(abs) ?? normalizedOverlays.get(rel)
  }

  const tsLibDir = resolveTsLibDir(root)
  const baseHost = ts.createCompilerHost(options, true)
  const isTsLibFile = (fileName: string): boolean =>
    tsLibDir !== undefined && path.basename(fileName).startsWith("lib.") && existsSync(path.join(tsLibDir, path.basename(fileName)))
  return {
    ...baseHost,
    ...(tsLibDir !== undefined ? { getDefaultLibLocation: () => tsLibDir } : {}),
    directoryExists: (dirName) => {
      const norm = dirName.replace(/\\/g, "/"), abs = path.resolve(root, norm).replace(/\\/g, "/")
      return overlayDirectories.has(abs) || overlayDirectories.has(norm) || (baseHost.directoryExists?.(dirName) ?? false)
    },
    fileExists: (fileName) => findOverlay(fileName) !== undefined || isTsLibFile(fileName) || baseHost.fileExists(fileName),
    readFile: (fileName) => {
      const ov = findOverlay(fileName)
      if (ov !== undefined) return ov
      if (isTsLibFile(fileName) && tsLibDir !== undefined) return readFileSync(path.join(tsLibDir, path.basename(fileName)), "utf8")
      return baseHost.readFile(fileName)
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const overlayContent = findOverlay(fileName)
      if (overlayContent !== undefined) return ts.createSourceFile(fileName, overlayContent, languageVersion, true)
      if (isTsLibFile(fileName) && tsLibDir !== undefined) {
        const existingLib = oldProgram?.getSourceFile(fileName)
        if (existingLib !== undefined && !shouldCreateNewSourceFile) return existingLib
        return ts.createSourceFile(fileName, readFileSync(path.join(tsLibDir, path.basename(fileName)), "utf8"), languageVersion, true)
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
): ReadonlyArray<OverlayDiagnosticItem> => {
  const root = resolveRepoRoot(repoRoot)
  const activeSession = session ?? getOrCreateWarmProgramSession(root)
  const overlayEntries = Object.entries(overlays)
  if (overlayEntries.length === 0) return []

  const virtualVitestPath = path.join(root, ".harness/__virtual_types__/@effect/vitest/index.d.ts")
  const virtualSqliteDoPath = path.join(root, ".harness/__virtual_types__/@effect/sql-sqlite-do/index.d.ts")
  const workspaceRoot = existsSync(path.join(root, "libs/harness/graph/node_modules")) ? root : resolveRepoRoot(import.meta.dirname)
  const dynamicPaths = computeDynamicPaths(root, workspaceRoot)
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
    ...(existsSync(rootPkgJsonPath) ? {} : { [rootPkgJsonPath]: JSON.stringify({ name: "overlay-workspace", type: "module" }) }),
    [virtualVitestPath]: VIRTUAL_EFFECT_VITEST_DTS,
    [virtualSqliteDoPath]: VIRTUAL_EFFECT_SQL_SQLITE_DO_DTS,
    ...overlays,
  }

  const host = createOverlayCompilerHost(compilerOptions, overlaysWithVirtualTypes, activeSession.oldProgram, root)
  const rootNames = overlayEntries
    .map(([k]) => path.resolve(root, k).replace(/\\/g, "/"))
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts"))

  if (rootNames.length === 0) return []

  const program = ts.createProgram(rootNames, compilerOptions, host, activeSession.oldProgram)
  activeSession.oldProgram = program

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
