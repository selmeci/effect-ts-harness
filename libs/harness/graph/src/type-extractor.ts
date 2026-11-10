import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type CallExpression,
  type NewExpression,
  Node,
  type ParameterDeclaration,
  type ParenthesizedTypeNode,
  Project,
  type PropertyAccessExpression,
  SyntaxKind,
  ts,
  type Type,
  type TypeNode,
  type UnionTypeNode,
} from "ts-morph"
export { ts }
import { buildHarnessGraph } from "./graph-engine.js"
import {
  type AdrDocNode,
  type BranchingViolation,
  type EarsSpecNode,
  EffectFnNode,
  getNodeKey,
  type GovernanceDocStatus,
  type HarnessEdge,
  type HarnessGraph,
  type HarnessNode,
  type LayerKind,
  NodeKey,
  PackageTag,
  type PatternDocNode,
  RelationId,
  RoleName,
  SchemaDefNode,
  ServiceLayerNode,
  ServiceTagNode,
  TaggedErrorNode,
  type TraceabilityTupleRelation,
  type UnresolvedGraphReference,
  ViolationRule,
  type VitestCaseNode,
} from "./model.js"
import { loadPatternDocs } from "./pattern-index.js"

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
  readonly requiresService: ReadonlyArray<{
    readonly callerQualname: string
    readonly tagId: string
  }>
  readonly failsWith: ReadonlyArray<{ readonly callerQualname: string; readonly errorTag: string }>
  readonly providesService: ReadonlyArray<{
    readonly layerQualname: string
    readonly tagId: string
  }>
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

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const hasExportModifier = (node: ts.Node): boolean => {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods !== undefined && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
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
    const typeParams =
      fn.typeParameters !== undefined
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
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt)
    ) {
      parts.push(stmt.getText(sourceFile).trim())
      continue
    }
    if (!hasExportModifier(stmt)) {
      continue
    }
    if (
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
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
      const heritage =
        stmt.heritageClauses !== undefined
          ? stmt.heritageClauses.map((h) => h.getText(sourceFile)).join(" ")
          : ""
      const memberSigs: Array<string> = []
      for (const m of stmt.members) {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          const mName = m.name !== undefined ? m.name.getText(sourceFile) : "constructor"
          const params = m.parameters.map((p) => p.getText(sourceFile)).join(",")
          const ret =
            m.type !== undefined
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
          parts.push(
            `export const ${varName}${explicitType} = ${formatFnLikeSignature(init, hasVarType)}`,
          )
          continue
        }
        if (ts.isCallExpression(init)) {
          const outerCallee = init.expression
          if (ts.isCallExpression(outerCallee)) {
            const innerCalleeText = outerCallee.expression.getText(sourceFile)
            if (innerCalleeText === "Effect.fn" || innerCalleeText === "Effect.fnUntraced") {
              const spanArg = outerCallee.arguments[0]?.getText(sourceFile) ?? ""
              const fnArg = init.arguments[0]
              if (
                fnArg !== undefined &&
                (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))
              ) {
                parts.push(
                  `export const ${varName}${explicitType} = ${innerCalleeText}(${spanArg})${formatFnLikeSignature(fnArg, hasVarType)}`,
                )
                continue
              }
            }
          } else if (outerCallee.getText(sourceFile) === "Effect.fnUntraced") {
            const fnArg = init.arguments[0]
            if (
              fnArg !== undefined &&
              (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))
            ) {
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
  const sf =
    typeof sourceFileOrContent === "string"
      ? ts.createSourceFile("module.ts", sourceFileOrContent, ts.ScriptTarget.Latest, true)
      : sourceFileOrContent
  return sha256Hex(emitDeclarationSignatureText(sf))
}

const extractModuleSpecifiers = (sourceFile: ts.SourceFile): ReadonlyArray<string> => {
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
  requiresService: Schema.Array(
    Schema.Struct({ callerQualname: Schema.String, tagId: Schema.String }),
  ),
  failsWith: Schema.Array(
    Schema.Struct({ callerQualname: Schema.String, errorTag: Schema.String }),
  ),
  providesService: Schema.Array(
    Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String }),
  ),
  layerRequires: Schema.Array(
    Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String }),
  ),
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

const loadFileGraphFragmentsFromDisk = (
  repoRoot: string,
  session: TypeScriptProgramSession,
): void => {
  const cachePath = resolveFileGraphCachePath(repoRoot)
  if (!fs.existsSync(cachePath)) {
    return
  }
  Effect.runSync(
    Effect.try({
      try: () => {
        const raw = fs.readFileSync(cachePath, "utf8")
        const decoded = decodeFileGraphCacheStore(raw)
        match(decoded)
          .with({ _tag: "Some" }, ({ value }) => {
            if (value.version !== FILE_GRAPH_CACHE_VERSION) {
              return
            }
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

const saveFileGraphFragmentsToDisk = (
  repoRoot: string,
  session: TypeScriptProgramSession,
): void => {
  if (session.persistToDisk !== true) {
    return
  }
  const cachePath = resolveFileGraphCachePath(repoRoot)
  Effect.runSync(
    Effect.try({
      try: () => {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        const fragments: Record<string, FileGraphFragment> = {}
        for (const [relPath, frag] of session.fileFragmentCache.entries()) {
          fragments[relPath] = frag
        }
        const tmpPath = `${cachePath}.${process.pid}.tmp`
        fs.writeFileSync(
          tmpPath,
          JSON.stringify({ version: FILE_GRAPH_CACHE_VERSION, fragments }),
          "utf8",
        )
        fs.renameSync(tmpPath, cachePath)
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

export interface TypeExtractorViolation {
  readonly rule:
    | "discriminant-branching"
    | "non-exhaustive-union-match"
    | "schema-boolean-state"
    | "dead-event-payload"
    | "terminal-state-unhandled"
    | "fallback-json-equality"
    | "vacuous-error-assertion"
    | "unscoped-effect-run"
    | "unbranded-schema-field"
    | "handwritten-tagged-union"
    | "untraced-decider"
    | "missing-aggregate-id-guard"
    | "unasserted-state-field"
    | "unsafe-type-cast"
    | "unbranded-contract-schema"
    | "unbranded-primitive-boundary"
    | "node-sqlite-in-infra"
  readonly message: string
  readonly path: ReadonlyArray<string>
  readonly file?: string | undefined
  readonly line?: number | undefined
  readonly enclosingSymbol?: string | undefined
}

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  nx: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const decodePackageJson = Schema.decodeOption(Schema.fromJsonString(PackageJsonSchema))

export const resolvePackageTag = (repoRoot: string, relFilePath: string): PackageTag => {
  if (relFilePath.startsWith("apps/") || relFilePath.includes("/apps/")) {
    return "app"
  }
  let currentDir = path.dirname(path.join(repoRoot, relFilePath))
  while (currentDir.length >= repoRoot.length) {
    const pkgPath = path.join(currentDir, "package.json")
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const opt = decodePackageJson(content)
      if (Option.isSome(opt) && opt.value.nx?.tags) {
        const tags = opt.value.nx.tags
        if (tags.includes("type:domain") || tags.includes("type:core")) return "domain"
        if (tags.includes("type:infra")) return "infra"
        if (tags.includes("type:app")) return "app"
        if (tags.includes("type:contract") && !tags.includes("type:service")) return "contract"
        if (tags.includes("type:service")) return "service"
        if (tags.includes("type:contract")) return "contract"
      }
      break
    }
    const parent = path.dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }
  if (relFilePath.includes("/domain/") || relFilePath.includes("/core/")) return "domain"
  if (relFilePath.includes("/infra/")) return "infra"
  if (relFilePath.includes("/contract/")) return "contract"
  if (relFilePath.includes("/service/")) return "service"
  return "service"
}

export const resolveRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

const cleanName = (raw: string): string => {
  let name = raw.replace(/import\([^)]+\)\./g, "").trim()
  if (name.startsWith("typeof ")) {
    name = name.slice(7).trim()
  }
  if (!name.includes("<") && name.includes(".")) {
    name = name.split(".").pop()?.trim() ?? name
  }
  return name
}

const decomposeTypeNode = (node: TypeNode): Array<string> => {
  if (node.getKind() === SyntaxKind.UnionType) {
    const unionNode = node as UnionTypeNode
    return unionNode.getTypeNodes().flatMap(decomposeTypeNode)
  }
  if (node.getKind() === SyntaxKind.ParenthesizedType) {
    const paren = node as ParenthesizedTypeNode
    return decomposeTypeNode(paren.getTypeNode())
  }
  const raw = cleanName(node.getText())
  if (
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  ) {
    return []
  }
  if (node.getType().isTypeParameter()) {
    return []
  }
  let ancestor: Node | undefined = node.getParent()
  while (ancestor !== undefined) {
    if (
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor) ||
      Node.isMethodSignature(ancestor) ||
      Node.isMethodDeclaration(ancestor) ||
      Node.isCallSignatureDeclaration(ancestor) ||
      Node.isFunctionTypeNode(ancestor) ||
      Node.isClassDeclaration(ancestor) ||
      Node.isInterfaceDeclaration(ancestor) ||
      Node.isTypeAliasDeclaration(ancestor)
    ) {
      if (ancestor.getTypeParameters().some((tp) => tp.getName() === raw)) {
        return []
      }
    }
    ancestor = ancestor.getParent()
  }
  return [raw]
}

const decomposeType = (type: Type): Array<string> => {
  if (type.isNever() || type.isUnknown() || type.isAny() || type.isTypeParameter()) {
    return []
  }
  if (type.isUnion()) {
    return type.getUnionTypes().flatMap(decomposeType)
  }
  const sym = type.getAliasSymbol() ?? type.getSymbol()
  const raw = cleanName(sym ? sym.getName() : type.getText())
  if (
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  ) {
    return []
  }
  return [raw]
}

const isDiscriminantPropertyOfUnion = (
  objType: Type,
  propName: string,
  locationNode: Node,
): boolean => {
  if (!objType.isUnion()) return false
  const members = objType.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
  if (members.length < 2) return false
  let literalCount = 0
  for (const member of members) {
    const propSym = member.getProperty(propName)
    if (!propSym) continue
    const propType = propSym.getTypeAtLocation(locationNode)
    if (propType.isLiteral() || propType.isBooleanLiteral()) {
      literalCount += 1
    }
  }
  return literalCount >= 2
}

const isClosedFiniteUnionType = (argType: Type, locationNode: Node): boolean => {
  if (!argType.isUnion()) return false
  const members = argType.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
  if (members.length < 2) return false
  return members.every((member) => {
    if (member.isLiteral() || member.isBooleanLiteral()) return true
    if (member.isObject()) {
      return member.getProperties().some((propSym) => {
        const propType = propSym.getTypeAtLocation(locationNode)
        return propType.isLiteral() || propType.isBooleanLiteral()
      })
    }
    return false
  })
}

const findEnclosingSymbolName = (node: Node, relPath: string): string => {
  let curr: Node | undefined = node
  while (curr !== undefined) {
    if (Node.isVariableDeclaration(curr)) {
      const name = curr.getName()
      if (name) return `${relPath}#${name}`
    }
    if (Node.isClassDeclaration(curr)) {
      const name = curr.getName()
      if (name) return `${relPath}#${name}`
    }
    if (Node.isFunctionDeclaration(curr) || Node.isMethodDeclaration(curr)) {
      const name = curr.getName()
      if (name) return `${relPath}#${name}`
    }
    curr = curr.getParent()
  }
  return relPath
}

const isTypeBranded = (type: Type): boolean => {
  if (type.getProperty("~effect/Brand") !== undefined) {
    return true
  }
  if (type.isIntersection()) {
    return type.getIntersectionTypes().some(isTypeBranded)
  }
  if (type.isUnion()) {
    const members = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    return members.length > 0 && members.every(isTypeBranded)
  }
  return false
}

const isExplicitOrSchemaAny = (type: Type, contextNode?: Node): boolean => {
  if (!type.isAny()) return false
  const intrinsicName = (type.compilerType as { readonly intrinsicName?: string }).intrinsicName
  if (intrinsicName === "error") return false
  if (!contextNode) return true
  if (
    contextNode.getKind() === SyntaxKind.AnyKeyword ||
    contextNode.getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0
  ) {
    return true
  }
  const text = contextNode.getText()
  if (/\b(?:Schema|S)\.Any\b/.test(text) || /\bany\b/.test(text)) {
    return true
  }
  return contextNode.getSourceFile().getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0
}

const isOpenUnbrandedPrimitiveType = (
  type: Type,
  contextNode?: Node,
): "string" | "number" | "any" | "unknown" | null => {
  if (isExplicitOrSchemaAny(type, contextNode)) {
    return "any"
  }
  if (type.isAny()) {
    return null
  }
  if (type.isUnknown()) {
    return "unknown"
  }
  if (
    type.isNever() ||
    type.isVoid() ||
    type.isUndefined() ||
    type.isNull() ||
    type.isLiteral() ||
    type.isBoolean() ||
    type.isBooleanLiteral()
  ) {
    return null
  }
  if (isTypeBranded(type)) {
    return null
  }
  if (type.isString()) {
    return "string"
  }
  if (type.isNumber()) {
    return "number"
  }
  if (type.isUnion()) {
    const nonNull = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    if (nonNull.some((u) => isExplicitOrSchemaAny(u, contextNode))) {
      return "any"
    }
    if (nonNull.some((u) => u.isUnknown())) {
      return "unknown"
    }
    if (nonNull.some((u) => u.isString() && !u.isLiteral() && !isTypeBranded(u))) {
      return "string"
    }
    if (nonNull.some((u) => u.isNumber() && !u.isLiteral() && !isTypeBranded(u))) {
      return "number"
    }
  }
  return null
}

const isScalarOrBrandedScalarType = (type: Type): boolean => {
  if (
    type.isString() ||
    type.isNumber() ||
    type.isBoolean() ||
    type.isBigInt() ||
    type.isLiteral() ||
    type.isBooleanLiteral()
  ) {
    return true
  }
  if (type.isIntersection()) {
    return type.getIntersectionTypes().some(isScalarOrBrandedScalarType)
  }
  if (type.isUnion()) {
    const nonNull = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    return nonNull.length > 0 && nonNull.every(isScalarOrBrandedScalarType)
  }
  return false
}

const collectUnbrandedObjectProperties = (
  type: Type,
  locationNode: Node,
): ReadonlyArray<{ readonly propName: string; readonly prim: string; readonly line: number }> => {
  if (
    isScalarOrBrandedScalarType(type) ||
    type.isArray() ||
    type.isTuple() ||
    type.isAny() ||
    type.isUnknown() ||
    type.isNever() ||
    type.isVoid()
  ) {
    return []
  }
  if (type.getCallSignatures().length > 0) {
    return []
  }

  const results: Array<{
    readonly propName: string
    readonly prim: string
    readonly line: number
  }> = []
  const seen = new Set<string>()

  const inspectSingleType = (target: Type): void => {
    if (
      isScalarOrBrandedScalarType(target) ||
      target.isArray() ||
      target.isTuple() ||
      target.isAny() ||
      target.isUnknown() ||
      target.isNever() ||
      target.isVoid()
    ) {
      return
    }
    if (
      target.getProperty("ast") !== undefined &&
      target.getProperty("Type") !== undefined &&
      target.getProperty("Encoded") !== undefined
    ) {
      return
    }
    for (const prop of target.getProperties()) {
      const propName = prop.getName()
      if (propName === "_tag" || propName === "~effect/Brand" || propName.startsWith("~")) {
        continue
      }
      const decls = prop.getDeclarations()
      if (
        decls.length > 0 &&
        decls.every((d) => d.getSourceFile().getFilePath().includes("typescript/lib/"))
      ) {
        continue
      }
      const propType = prop.getTypeAtLocation(locationNode)
      const prim = isOpenUnbrandedPrimitiveType(propType)
      if (prim !== null) {
        const key = `${propName}:${prim}`
        if (!seen.has(key)) {
          seen.add(key)
          const declLine =
            decls[0] && decls[0].getSourceFile() === locationNode.getSourceFile()
              ? decls[0].getStartLineNumber()
              : locationNode.getStartLineNumber()
          results.push({ propName, prim, line: declLine })
        }
      }
    }
  }

  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (!member.isUndefined() && !member.isNull()) {
        inspectSingleType(member)
      }
    }
  } else {
    inspectSingleType(type)
  }

  return results
}

const containsInlineObjectTypeAst = (typeNode: Node | undefined): boolean => {
  if (!typeNode) return false
  if (Node.isTypeLiteral(typeNode)) return true
  return typeNode.getDescendantsOfKind(SyntaxKind.TypeLiteral).length > 0
}

const getSchemaDecodedType = (schemaExpr: Node): Type | null => {
  const exprType = schemaExpr.getType()
  if (exprType.isAny() || exprType.isUnknown()) return null
  if (
    exprType.getProperty("~type.make") === undefined &&
    exprType.getProperty("ast") === undefined
  ) {
    return null
  }
  const typeProp = exprType.getProperty("Type")
  if (!typeProp) return null
  return typeProp.getTypeAtLocation(schemaExpr)
}

export const extractTypeAwareGraphFromSource = (
  files: ReadonlyArray<SourceFileInput>,
  options?: TypeExtractorOptions,
): HarnessGraph => {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot(process.cwd())
  const graphNodeModules = path.join(repoRoot, "libs/harness/graph/node_modules")

  const dynamicPaths: Record<string, Array<string>> = {
    effect: [path.join(graphNodeModules, "effect")],
    "effect/*": [path.join(graphNodeModules, "effect/*")],
    "ts-pattern": [path.join(repoRoot, "node_modules/ts-pattern")],
    "@harness/gates": [path.join(repoRoot, "libs/harness/gates/src/index.ts")],
    "@harness/graph": [path.join(repoRoot, "libs/harness/graph/src/index.ts")],
    "@harness/decision": [path.join(repoRoot, "libs/harness/decision/src/index.ts")],
    "@harness/ingest": [path.join(repoRoot, "libs/harness/ingest/src/index.ts")],
    "@harness/sample-contract": [path.join(repoRoot, "libs/sample/contract/src/index.ts")],
    "@harness/sample-service": [path.join(repoRoot, "libs/sample/service/src/index.ts")],
    "@harness/sample-domain": [path.join(repoRoot, "libs/sample/domain/src/index.ts")],
    "@harness/sample-infra": [path.join(repoRoot, "libs/sample/infra/src/index.ts")],
  }

  const libsDir = path.join(repoRoot, "libs")
  if (fs.existsSync(libsDir)) {
    for (const scopeEntry of fs.readdirSync(libsDir, { withFileTypes: true })) {
      if (!scopeEntry.isDirectory() || scopeEntry.name === "harness") continue
      const scopeDir = path.join(libsDir, scopeEntry.name)
      for (const tier of ["contract", "service", "domain", "core", "infra"]) {
        const entryFile = path.join(scopeDir, tier, "src", "index.ts")
        dynamicPaths[`@harness/${scopeEntry.name}-${tier}`] = [entryFile]
        dynamicPaths[`@effect-${scopeEntry.name}/${tier}`] = [entryFile]
        dynamicPaths[`@${scopeEntry.name}/${tier}`] = [entryFile]
      }
    }
  }

  const normalizedOverlays = new Map<string, string>()
  if (options?.overlays !== undefined) {
    for (const [k, v] of Object.entries(options.overlays)) {
      const rel = (path.isAbsolute(k) ? path.relative(repoRoot, k) : k).replace(/\\/g, "/")
      normalizedOverlays.set(rel, v)
    }
  }

  const effectiveFiles: Array<SourceFileInput> = files.map((f) => {
    const rel = (
      path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath
    ).replace(/\\/g, "/")
    const overlayContent = normalizedOverlays.get(rel) ?? normalizedOverlays.get(f.filePath)
    return overlayContent !== undefined ? { ...f, content: overlayContent } : f
  })

  for (const [overlayRel, overlayContent] of normalizedOverlays.entries()) {
    const alreadyPresent = effectiveFiles.some(
      (f) =>
        f.filePath.replace(/\\/g, "/") === overlayRel ||
        (path.isAbsolute(f.filePath)
          ? path.relative(repoRoot, f.filePath).replace(/\\/g, "/") === overlayRel
          : false),
    )
    if (!alreadyPresent) {
      effectiveFiles.push({
        filePath: overlayRel,
        content: overlayContent,
        packageTag: resolvePackageTag(repoRoot, overlayRel),
      })
    }
  }

  for (const f of effectiveFiles) {
    const rel = (
      path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath
    ).replace(/\\/g, "/")
    const m = rel.match(/^libs\/([^/]+)\/(contract|service|domain|core|infra)\/src\/index\.ts$/)
    if (m && m[1] && m[2]) {
      const scopeName = m[1]
      const tier = m[2]
      const entryAbs = path.resolve(repoRoot, rel)
      dynamicPaths[`@harness/${scopeName}-${tier}`] = [entryAbs]
      dynamicPaths[`@effect-${scopeName}/${tier}`] = [entryAbs]
      dynamicPaths[`@${scopeName}/${tier}`] = [entryAbs]
    }
  }

  const session = options?.session
  const project =
    session?.project ??
    new Project({
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        paths: dynamicPaths,
      },
    })
  if (session !== undefined) {
    session.project = project
  }

  const fileMap = new Map<string, SourceFileInput>()
  const currentShas = new Map<string, string>()
  const currentDeclHashes = new Map<string, string>()
  const currentSpecs = new Map<string, ReadonlyArray<string>>()
  const filesToReextract = new Set<string>()
  const declChangedFiles = new Set<string>()

  const resolveImportSpecToRelFile = (fromRelPath: string, spec: string): string | null => {
    if (spec.startsWith(".")) {
      const fromDir = path.dirname(path.join(repoRoot, fromRelPath))
      const resolvedAbs = path.resolve(fromDir, spec)
      const rel = path.relative(repoRoot, resolvedAbs).replace(/\\/g, "/")
      const candidates = [
        rel,
        rel.replace(/\.js$/, ".ts"),
        rel.replace(/\.jsx$/, ".tsx"),
        `${rel}.ts`,
        `${rel}/index.ts`,
      ]
      for (const c of candidates) {
        if (fileMap.has(c)) return c
      }
    }
    for (const [alias, targets] of Object.entries(dynamicPaths)) {
      if (spec === alias && targets[0] !== undefined) {
        const rel = path.relative(repoRoot, targets[0]).replace(/\\/g, "/")
        if (fileMap.has(rel)) return rel
      }
    }
    return null
  }

  for (const f of effectiveFiles) {
    const normalizedRelPath = (
      path.isAbsolute(f.filePath) ? path.relative(repoRoot, f.filePath) : f.filePath
    ).replace(/\\/g, "/")
    fileMap.set(normalizedRelPath, f)
  }

  for (const [normalizedRelPath, f] of fileMap.entries()) {
    const absPath = path.isAbsolute(f.filePath) ? f.filePath : path.resolve(repoRoot, f.filePath)
    const contentSha256 = sha256Hex(f.content)
    currentShas.set(normalizedRelPath, contentSha256)

    const prevEntry = session?.sourceFileCache.get(normalizedRelPath)
    const prevFragment = session?.fileFragmentCache.get(normalizedRelPath)

    if (
      session !== undefined &&
      prevEntry !== undefined &&
      prevFragment !== undefined &&
      prevEntry.contentSha256 === contentSha256 &&
      (prevEntry.packageTag ?? f.packageTag) === f.packageTag
    ) {
      session.warmHitCount += 1
      currentDeclHashes.set(normalizedRelPath, prevEntry.declHash)
      currentSpecs.set(normalizedRelPath, prevEntry.importedSpecs)
    } else {
      let sf = project.getSourceFile(absPath)
      if (sf !== undefined) {
        sf.replaceWithText(f.content)
      } else {
        sf = project.createSourceFile(absPath, f.content, { overwrite: true })
      }
      const compilerSf: ts.SourceFile = sf.compilerNode
      const newDeclHash = computeDeclHash(compilerSf)
      const specs = extractModuleSpecifiers(compilerSf)
      currentDeclHashes.set(normalizedRelPath, newDeclHash)
      currentSpecs.set(normalizedRelPath, specs)
      filesToReextract.add(normalizedRelPath)

      if (session !== undefined) {
        if (prevEntry !== undefined && (prevEntry.packageTag ?? f.packageTag) === f.packageTag) {
          if (prevEntry.declHash === newDeclHash) {
            session.signatureCleanCutoffCount += 1
          } else {
            declChangedFiles.add(normalizedRelPath)
          }
        } else {
          declChangedFiles.add(normalizedRelPath)
        }
        session.sourceFileCache.set(normalizedRelPath, {
          packageTag: f.packageTag,
          contentSha256,
          declHash: newDeclHash,
          sourceFile: compilerSf,
          importedSpecs: specs,
        })
      }
    }
  }

  if (session !== undefined) {
    for (const cachedRel of Array.from(session.sourceFileCache.keys())) {
      if (!fileMap.has(cachedRel)) {
        const oldDeps = session.reverseImportsByFile.get(cachedRel)
        if (oldDeps !== undefined) {
          for (const dep of oldDeps) {
            if (fileMap.has(dep)) {
              filesToReextract.add(dep)
              declChangedFiles.add(dep)
            }
          }
        }
        session.sourceFileCache.delete(cachedRel)
        session.fileFragmentCache.delete(cachedRel)
        const oldSf = project.getSourceFile(path.resolve(repoRoot, cachedRel))
        if (oldSf !== undefined) {
          project.removeSourceFile(oldSf)
        }
      }
    }

    session.reverseImportsByFile.clear()
    for (const [relPath, specs] of currentSpecs.entries()) {
      for (const spec of specs) {
        const targetRel = resolveImportSpecToRelFile(relPath, spec)
        if (targetRel !== null && targetRel !== relPath) {
          let revSet = session.reverseImportsByFile.get(targetRel)
          if (revSet === undefined) {
            revSet = new Set<string>()
            session.reverseImportsByFile.set(targetRel, revSet)
          }
          revSet.add(relPath)
        }
      }
    }

    if (declChangedFiles.size > 0) {
      const coneQueue = Array.from(declChangedFiles)
      const visitedCone = new Set<string>(declChangedFiles)
      while (coneQueue.length > 0) {
        const curr = coneQueue.shift()!
        const dependents = session.reverseImportsByFile.get(curr)
        if (dependents !== undefined) {
          for (const dep of dependents) {
            filesToReextract.add(dep)
            if (!visitedCone.has(dep)) {
              visitedCone.add(dep)
              coneQueue.push(dep)
            }
          }
        }
      }
    }

    for (const normalizedRelPath of fileMap.keys()) {
      if (
        !filesToReextract.has(normalizedRelPath) &&
        !session.fileFragmentCache.has(normalizedRelPath)
      ) {
        filesToReextract.add(normalizedRelPath)
      }
    }

    const neededProjectFiles = new Set<string>(filesToReextract)
    if (filesToReextract.size > 0) {
      const touchedScopes = new Set<string>()
      for (const rel of filesToReextract) {
        const m = rel.match(/^libs\/([^/]+)\//)
        if (m && m[1] && m[1] !== "harness") {
          touchedScopes.add(`libs/${m[1]}/`)
        }
      }
      if (touchedScopes.size > 0) {
        for (const rel of fileMap.keys()) {
          for (const prefix of touchedScopes) {
            if (rel.startsWith(prefix)) {
              neededProjectFiles.add(rel)
            }
          }
        }
      }
      const fwdQueue = Array.from(neededProjectFiles)
      while (fwdQueue.length > 0) {
        const curr = fwdQueue.shift()!
        for (const spec of currentSpecs.get(curr) ?? []) {
          const targetRel = resolveImportSpecToRelFile(curr, spec)
          if (targetRel !== null && !neededProjectFiles.has(targetRel)) {
            neededProjectFiles.add(targetRel)
            fwdQueue.push(targetRel)
          }
        }
      }
      for (const rel of neededProjectFiles) {
        const f = fileMap.get(rel)
        if (!f) continue
        const absPath = path.isAbsolute(f.filePath)
          ? f.filePath
          : path.resolve(repoRoot, f.filePath)
        if (project.getSourceFile(absPath) === undefined) {
          project.createSourceFile(absPath, f.content, { overwrite: true })
        }
      }
    }

    session.lastReextractedFiles = Array.from(filesToReextract)
  }

  const fns: Array<EffectFnNode> = []
  const services: Array<ServiceTagNode> = []
  const layers: Array<ServiceLayerNode> = []
  const errors: Array<TaggedErrorNode> = []
  const schemas: Array<SchemaDefNode> = []
  const requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }> = []
  const failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }> = []
  const providesService: Array<{ readonly layerQualname: string; readonly tagId: string }> = []
  const layerRequires: Array<{ readonly layerQualname: string; readonly tagId: string }> = []
  const branchingViolations: Array<BranchingViolation> = []

  const serviceMethodErrors = new Map<string, Map<string, Array<string>>>()
  const classNameToTagId = new Map<string, string>()
  const referencedServices = new Set<string>()
  const referencedErrors = new Set<string>()

  interface TaggedSchemaInfo {
    readonly tag: string
    readonly properties: ReadonlyArray<string>
    readonly file: string
    readonly line: number
  }
  const taggedSchemasByTag = new Map<string, TaggedSchemaInfo>()
  const taggedSchemasByName = new Map<string, TaggedSchemaInfo>()
  const unionSchemaTagsByName = new Map<string, ReadonlyArray<string>>()

  const registerTaggedSchemaByTag = (tag: string, schemaInfo: TaggedSchemaInfo): void => {
    const existing = taggedSchemasByTag.get(tag)
    if (existing === undefined) {
      taggedSchemasByTag.set(tag, schemaInfo)
    } else {
      const mergedProps = Array.from(new Set([...existing.properties, ...schemaInfo.properties]))
      taggedSchemasByTag.set(tag, {
        ...schemaInfo,
        properties: mergedProps,
      })
    }
  }

  const resolveSchemasForParameter = (
    param: ParameterDeclaration,
  ): ReadonlyArray<TaggedSchemaInfo> => {
    const typeTexts = [param.getTypeNode()?.getText() ?? "", param.getType().getText(param)].join(
      " ",
    )
    const rawTokens = new Set<string>()
    for (const m of typeTexts.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      const tok = m[1]
      if (tok && tok !== "typeof" && tok !== "Type" && tok !== "Schema" && tok !== "Readonly") {
        rawTokens.add(tok)
      }
    }
    const resolvedSchemas: Array<TaggedSchemaInfo> = []
    const seenSchemas = new Set<TaggedSchemaInfo>()
    const queue = [...rawTokens]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const curr = queue.shift()!
      if (visited.has(curr)) continue
      visited.add(curr)
      const schemaByName = taggedSchemasByName.get(curr)
      if (schemaByName) {
        if (!seenSchemas.has(schemaByName)) {
          seenSchemas.add(schemaByName)
          resolvedSchemas.push(schemaByName)
        }
        continue
      }
      const unionMembers = unionSchemaTagsByName.get(curr)
      if (unionMembers) {
        for (const member of unionMembers) {
          queue.push(member)
        }
        continue
      }
      const schemaByTag = taggedSchemasByTag.get(curr)
      if (schemaByTag && !seenSchemas.has(schemaByTag)) {
        seenSchemas.add(schemaByTag)
        resolvedSchemas.push(schemaByTag)
      }
    }
    return resolvedSchemas
  }

  const sortedSourceFiles = [...project.getSourceFiles()].sort((a, b) =>
    path
      .relative(repoRoot, a.getFilePath())
      .replace(/\\/g, "/")
      .localeCompare(path.relative(repoRoot, b.getFilePath()).replace(/\\/g, "/")),
  )

  // 0. Zero-tolerance AST type safety check
  for (const sourceFile of sortedSourceFiles) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    const input = fileMap.get(relPath)
    if (!input) continue
    if (session !== undefined && !filesToReextract.has(relPath)) continue

    const checkNode = (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        branchingViolations.push({
          rule: "unsafe-type-cast",
          message: `Explicit 'any' (as any, : any, <any>) is banned in '${input.filePath}' — use a concrete static type or decode via Effect Schema.`,
          path: [input.filePath],
          file: input.filePath,
          line:
            sourceFile.compilerNode.getLineAndCharacterOfPosition(
              node.getStart(sourceFile.compilerNode),
            ).line + 1,
          enclosingSymbol: input.filePath,
        })
      }

      const unwrapTypeParen = (typeNode: ts.TypeNode): ts.TypeNode => {
        let curr = typeNode
        while (ts.isParenthesizedTypeNode(curr)) {
          curr = curr.type
        }
        return curr
      }

      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
      ) {
        branchingViolations.push({
          rule: "unsafe-type-cast",
          message: `Unsafe 'as never' cast is banned in '${input.filePath}' — fix the type mismatch or use ts-pattern .exhaustive().`,
          path: [input.filePath],
          file: input.filePath,
          line:
            sourceFile.compilerNode.getLineAndCharacterOfPosition(
              node.getStart(sourceFile.compilerNode),
            ).line + 1,
          enclosingSymbol: input.filePath,
        })
      }

      const unwrapExpr = (expr: ts.Expression): ts.Expression => {
        let curr = expr
        while (ts.isParenthesizedExpression(curr) || ts.isSatisfiesExpression(curr)) {
          curr = curr.expression
        }
        return curr
      }

      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const inner = unwrapExpr(node.expression)
        if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
          branchingViolations.push({
            rule: "unsafe-type-cast",
            message: `Double type assertion ('as unknown as T') is banned in '${input.filePath}' — decode with Effect Schema or type the boundary properly.`,
            path: [input.filePath],
            file: input.filePath,
            line:
              sourceFile.compilerNode.getLineAndCharacterOfPosition(
                node.getStart(sourceFile.compilerNode),
              ).line + 1,
            enclosingSymbol: input.filePath,
          })
        }
      }

      if (
        (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        node.type != null &&
        unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
      ) {
        branchingViolations.push({
          rule: "unsafe-type-cast",
          message: `Explicit ': never' annotation on parameter or variable is banned in '${input.filePath}'.`,
          path: [input.filePath],
          file: input.filePath,
          line:
            sourceFile.compilerNode.getLineAndCharacterOfPosition(
              node.getStart(sourceFile.compilerNode),
            ).line + 1,
          enclosingSymbol: input.filePath,
        })
      }

      ts.forEachChild(node, checkNode)
    }

    checkNode(sourceFile.compilerNode)
  }

  const pass1ScopeFiles = new Set<string>(filesToReextract)
  if (session !== undefined && filesToReextract.size > 0) {
    for (const frag of session.fileFragmentCache.values()) {
      for (const s of frag.services ?? []) {
        classNameToTagId.set(s.name, s.tagId)
        classNameToTagId.set(s.tagId, s.tagId)
      }
    }
    for (const rel of filesToReextract) {
      const m = rel.match(/^libs\/([^/]+)\//)
      if (m && m[1] && m[1] !== "harness") {
        const prefix = `libs/${m[1]}/`
        for (const k of fileMap.keys()) {
          if (k.startsWith(prefix)) pass1ScopeFiles.add(k)
        }
      }
    }
    const pass1Queue = Array.from(pass1ScopeFiles)
    while (pass1Queue.length > 0) {
      const curr = pass1Queue.shift()!
      for (const spec of currentSpecs.get(curr) ?? []) {
        const targetRel = resolveImportSpecToRelFile(curr, spec)
        if (targetRel !== null && !pass1ScopeFiles.has(targetRel)) {
          pass1ScopeFiles.add(targetRel)
          pass1Queue.push(targetRel)
        }
      }
    }
  }

  // 1. First pass: Extract Services, Errors, and Tagged Schemas
  for (const sourceFile of sortedSourceFiles) {
    if (session !== undefined && filesToReextract.size === 0) break
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    if (!fileMap.has(relPath)) continue
    if (session !== undefined && !pass1ScopeFiles.has(relPath)) continue
    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const extClause = cls.getExtends()
      if (!extClause) continue
      const extText = extClause.getText()

      // ServiceTag check
      if (extText.includes("Context.Service") || extText.includes("Service<")) {
        const clsName = cls.getName() ?? ""
        let tagId = clsName
        const callExprs = extClause.getDescendantsOfKind(SyntaxKind.CallExpression)
        for (const c of callExprs) {
          const args = c.getArguments()
          if (args.length > 0 && args[0]?.getKind() === SyntaxKind.StringLiteral) {
            tagId = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            break
          }
        }

        classNameToTagId.set(clsName, tagId)
        classNameToTagId.set(tagId, tagId)

        services.push({
          _tag: "ServiceTag",
          tagId,
          name: clsName,
          packageTag: filePkgTag,
          file: relPath,
          line: cls.getStartLineNumber(),
        })

        // Record methods and errors from Shape literal if present
        const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
        if (typeLiteral) {
          const methodsMap = new Map<string, Array<string>>()
          for (const member of typeLiteral.getMembers()) {
            const memberName = Node.isPropertySignature(member)
              ? member.getName()
              : member.getFirstChildByKind(SyntaxKind.Identifier)?.getText()
            if (!memberName) continue
            const effectRef = member.getFirstDescendant(
              (node) =>
                node.getKind() === SyntaxKind.TypeReference && node.getText().includes("Effect"),
            )
            if (effectRef && Node.isTypeReference(effectRef)) {
              const typeArgs = effectRef.getTypeArguments()
              if (typeArgs.length >= 2 && typeArgs[1]) {
                const errs = decomposeTypeNode(typeArgs[1])
                methodsMap.set(memberName, errs)
              }
            }
          }
          serviceMethodErrors.set(clsName, methodsMap)
          if (tagId !== clsName) {
            serviceMethodErrors.set(tagId, methodsMap)
          }
        }
      }

      // TaggedError check
      if (
        extText.includes("Data.TaggedError") ||
        extText.includes("TaggedError(") ||
        extText.includes("TaggedError<") ||
        extText.includes("Schema.TaggedError") ||
        extText.includes("Schema.TaggedErrorClass") ||
        extText.includes("TaggedErrorClass(")
      ) {
        const clsName = cls.getName() ?? ""
        let errorTag = clsName
        const callExprs = extClause.getDescendantsOfKind(SyntaxKind.CallExpression)
        for (const c of callExprs) {
          const args = c.getArguments()
          if (
            args.length > 0 &&
            (args[0]?.getKind() === SyntaxKind.StringLiteral ||
              args[0]?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)
          ) {
            errorTag = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            break
          }
        }
        errors.push({
          _tag: "TaggedError",
          errorTag,
          file: relPath,
          line: cls.getStartLineNumber(),
        })
      }

      // TaggedClass check
      if (extText.includes("TaggedClass")) {
        for (const c of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const args = c.getArguments()
          if (
            args.length >= 2 &&
            Node.isStringLiteral(args[0]) &&
            Node.isObjectLiteralExpression(args[1])
          ) {
            const tag = args[0].getLiteralText()
            const props = args[1]
              .getProperties()
              .filter(Node.isPropertyAssignment)
              .map((p) => p.getName())
              .filter((n) => n !== "_tag" && n !== "version")
            const schemaInfo: TaggedSchemaInfo = {
              tag,
              properties: props,
              file: relPath,
              line: c.getStartLineNumber(),
            }
            registerTaggedSchemaByTag(tag, schemaInfo)
            const clsName = cls.getName()
            if (clsName) {
              taggedSchemasByName.set(clsName, schemaInfo)
              unionSchemaTagsByName.set(clsName, [tag])
            }
            break
          }
        }
      }

      // Schema.Class / Schema.TaggedClass check
      if (
        extText.includes("Schema.Class") ||
        extText.includes("Schema.TaggedClass") ||
        extText.includes("TaggedClass") ||
        extText.includes("Class<")
      ) {
        const clsName = cls.getName() ?? ""
        if (clsName && !schemas.some((s) => s.schemaName === clsName)) {
          schemas.push({
            _tag: "SchemaDef",
            schemaName: clsName,
            packageTag: filePkgTag,
            file: relPath,
            line: cls.getStartLineNumber(),
            isBranded: false,
            name: clsName,
            qualname: `${relPath}#${clsName}`,
          })
        }
      }
    }

    // Collect Schema.TaggedStruct, Schema.TaggedUnion, and Schema.Union definitions in sourceFile
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = callExpr.getExpression().getText()
      if (calleeText === "Schema.TaggedStruct" || calleeText === "S.TaggedStruct") {
        const args = callExpr.getArguments()
        if (
          args.length >= 2 &&
          Node.isStringLiteral(args[0]) &&
          Node.isObjectLiteralExpression(args[1])
        ) {
          const tag = args[0].getLiteralText()
          const props = args[1]
            .getProperties()
            .filter(Node.isPropertyAssignment)
            .map((p) => p.getName())
            .filter((n) => n !== "_tag" && n !== "version")
          const schemaInfo: TaggedSchemaInfo = {
            tag,
            properties: props,
            file: relPath,
            line: callExpr.getStartLineNumber(),
          }
          registerTaggedSchemaByTag(tag, schemaInfo)
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar) {
            taggedSchemasByName.set(parentVar.getName(), schemaInfo)
            unionSchemaTagsByName.set(parentVar.getName(), [tag])
          }
        }
      } else if (calleeText === "Schema.TaggedUnion" || calleeText === "S.TaggedUnion") {
        const args = callExpr.getArguments()
        if (args.length >= 1 && Node.isObjectLiteralExpression(args[0])) {
          const memberTags: Array<string> = []
          for (const prop of args[0].getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              const tag = prop.getName().replace(/^["'`]|["'`]$/g, "")
              const initObj = prop.getInitializer()
              const props =
                initObj && Node.isObjectLiteralExpression(initObj)
                  ? initObj
                      .getProperties()
                      .filter(Node.isPropertyAssignment)
                      .map((p) => p.getName())
                      .filter((n) => n !== "_tag" && n !== "version")
                  : []
              registerTaggedSchemaByTag(tag, {
                tag,
                properties: props,
                file: relPath,
                line: prop.getStartLineNumber(),
              })
              memberTags.push(tag)
            }
          }
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar && memberTags.length > 0) {
            unionSchemaTagsByName.set(parentVar.getName(), memberTags)
          }
        }
      } else if (calleeText === "Schema.Union" || calleeText === "S.Union") {
        const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
        if (parentVar && parentVar.getInitializer() === callExpr) {
          const memberNames: Array<string> = []
          for (const arg of callExpr.getArguments()) {
            if (Node.isArrayLiteralExpression(arg)) {
              for (const el of arg.getElements()) {
                if (Node.isIdentifier(el)) {
                  memberNames.push(el.getText())
                }
              }
            } else if (Node.isIdentifier(arg)) {
              memberNames.push(arg.getText())
            }
          }
          if (memberNames.length > 0) {
            unionSchemaTagsByName.set(parentVar.getName(), memberNames)
          }
        }
      }
    }

    for (const typeAlias of sourceFile.getTypeAliases()) {
      const aliasName = typeAlias.getName()
      if (!unionSchemaTagsByName.has(aliasName)) {
        const typeNode = typeAlias.getTypeNode()
        if (typeNode && Node.isUnionTypeNode(typeNode)) {
          const members: Array<string> = []
          for (const part of typeNode.getTypeNodes()) {
            const text = part.getText().trim()
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
              members.push(text)
            }
          }
          if (members.length > 0) {
            unionSchemaTagsByName.set(aliasName, members)
          }
        } else if (typeNode) {
          const text = typeNode.getText().trim()
          const matchTypeof = text.match(/^typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\.Type$/)
          const targetIdent =
            matchTypeof?.[1] ?? (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined)
          if (targetIdent && targetIdent !== aliasName) {
            unionSchemaTagsByName.set(aliasName, [targetIdent])
          }
        }
      }
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const varName = varDecl.getName()
      const init = varDecl.getInitializer()
      if (!init) continue
      const initText = init.getText()
      const isSchemaDef =
        initText.includes("Schema.Struct") ||
        initText.includes("Schema.TaggedStruct") ||
        initText.includes("Schema.TaggedUnion") ||
        initText.includes("Schema.Union") ||
        initText.includes("Schema.Class") ||
        initText.includes("Schema.brand(") ||
        initText.includes(".pipe(Schema.brand") ||
        initText.includes("S.Struct") ||
        initText.includes("S.TaggedStruct") ||
        initText.includes("S.TaggedUnion") ||
        initText.includes("S.brand(")

      if (isSchemaDef && !schemas.some((s) => s.schemaName === varName)) {
        schemas.push({
          _tag: "SchemaDef",
          schemaName: varName,
          packageTag: filePkgTag,
          file: relPath,
          line: varDecl.getStartLineNumber(),
          isBranded: initText.includes("brand(") || initText.includes("Schema.brand"),
          name: varName,
          qualname: `${relPath}#${varName}`,
        })
      }
    }
  }

  // 2. Second pass: Extract Layers and EffectFns
  for (const sourceFile of sortedSourceFiles) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    if (!fileMap.has(relPath)) continue
    if (session !== undefined && !filesToReextract.has(relPath)) continue
    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const varName = varDecl.getName()
      const typeNode = varDecl.getTypeNode()
      const init = varDecl.getInitializer()
      const typeText = typeNode?.getText() ?? ""
      const initText = init?.getText() ?? ""

      // Layer check
      const isLayer =
        typeText.includes("Layer") ||
        initText.startsWith("Layer.") ||
        (init && Node.isCallExpression(init) && init.getExpression().getText().startsWith("Layer."))

      if (isLayer) {
        const qualname = `${relPath}#${varName}`
        let layerKind: LayerKind = "live"
        if (/test/i.test(varName)) {
          layerKind = "test"
        } else if (/emulated/i.test(varName)) {
          layerKind = "emulated"
        } else if (/infra/i.test(varName)) {
          layerKind = "infra"
        } else {
          layerKind = "live"
        }

        layers.push({
          _tag: "ServiceLayer",
          qualname,
          layerKind,
          packageTag: filePkgTag,
          file: relPath,
          line: varDecl.getStartLineNumber(),
        })

        const rOutMembers = new Set<string>()
        const rInMembers = new Set<string>()

        // From TypeNode
        if (typeNode && Node.isTypeReference(typeNode)) {
          const typeArgs = typeNode.getTypeArguments()
          if (typeArgs.length >= 1 && typeArgs[0]) {
            for (const m of decomposeTypeNode(typeArgs[0])) {
              rOutMembers.add(m)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const m of decomposeTypeNode(typeArgs[2])) {
              rInMembers.add(m)
            }
          }
        }

        // From TypeChecker
        const type = varDecl.getType()
        const typeArgs = type.getTypeArguments()
        if (typeArgs.length >= 3) {
          if (typeArgs[0]) {
            for (const m of decomposeType(typeArgs[0])) {
              rOutMembers.add(m)
            }
          }
          if (typeArgs[2]) {
            for (const m of decomposeType(typeArgs[2])) {
              rInMembers.add(m)
            }
          }
        }

        // From AST initializer fallback
        if (
          rOutMembers.size === 0 &&
          rInMembers.size === 0 &&
          init &&
          Node.isCallExpression(init)
        ) {
          const args = init.getArguments()
          if (args.length > 0 && args[0]?.getKind() === SyntaxKind.Identifier) {
            rOutMembers.add(args[0].getText())
          }
          const yields = init.getDescendantsOfKind(SyntaxKind.YieldExpression)
          for (const y of yields) {
            const expr = y.getExpression()
            if (expr && expr.getKind() === SyntaxKind.Identifier) {
              rInMembers.add(expr.getText())
            }
          }
        }

        for (const rawROut of rOutMembers) {
          const rOut = classNameToTagId.get(rawROut) ?? rawROut
          providesService.push({ layerQualname: qualname, tagId: rOut })
          referencedServices.add(rOut)
        }
        for (const rawRIn of rInMembers) {
          const rIn = classNameToTagId.get(rawRIn) ?? rawRIn
          layerRequires.push({ layerQualname: qualname, tagId: rIn })
          referencedServices.add(rIn)
        }

        continue
      }

      // EffectFn check
      let isEffectFn = false
      let spanName = varName

      if (init && init.getKind() === SyntaxKind.CallExpression) {
        const outerCall = init as CallExpression
        const innerExpr = outerCall.getExpression()
        if (innerExpr.getKind() === SyntaxKind.CallExpression) {
          const innerCall = innerExpr as CallExpression
          const callee = innerCall.getExpression().getText()
          if (callee === "Effect.fn") {
            isEffectFn = true
            const args = innerCall.getArguments()
            if (args.length > 0 && args[0]?.getKind() === SyntaxKind.StringLiteral) {
              spanName = args[0].getText().replace(/^["'`]|["'`]$/g, "")
            }
          } else if (callee === "Effect.fnUntraced") {
            isEffectFn = true
            spanName = varName
          }
        } else if (innerExpr.getText() === "Effect.fnUntraced") {
          isEffectFn = true
          spanName = varName
        }
      }

      if (
        !isEffectFn &&
        (filePkgTag === "domain" || filePkgTag === "contract") &&
        init &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) &&
        init.getParameters().length === 2 &&
        /^(?:evolve[A-Z]\w*|reduce[A-Z]\w*|.*Reducer)$/.test(varName)
      ) {
        isEffectFn = true
        spanName =
          varName.startsWith("evolve") && varName.length > 6
            ? `${varName.slice(6)}.evolve`
            : varName
      }

      if (!isEffectFn || !init) continue

      const qualname = `${relPath}#${varName}`
      const line = varDecl.getStartLineNumber()
      let isStub = false
      let successType = "void"
      const errorTags = new Set<string>()
      const requiredServices = new Set<string>()
      let inputSchema: string | undefined
      let outputSchema: string | undefined

      // Inspect inner generator function when declared with Effect.fn("...")(function* (...) { ... })
      let innerFn: Node | undefined
      if (init && Node.isCallExpression(init)) {
        const outerArgs = init.getArguments()
        if (outerArgs.length > 0 && outerArgs[0]) {
          innerFn = outerArgs[0]
        }
      }

      if (innerFn && (Node.isFunctionExpression(innerFn) || Node.isArrowFunction(innerFn))) {
        const params = innerFn.getParameters()
        if (params.length > 0 && params[0]) {
          const firstParam = params[0]
          const paramTypeNode = firstParam.getTypeNode()
          if (paramTypeNode) {
            const rawParam = cleanName(paramTypeNode.getText())
              .replace(/typeof\s+/, "")
              .replace(/\.Type$/, "")
            if (
              rawParam &&
              rawParam !== "string" &&
              rawParam !== "number" &&
              rawParam !== "boolean" &&
              rawParam !== "unknown" &&
              rawParam !== "any"
            ) {
              inputSchema = rawParam
            }
          }
        }

        const fnRetNode = innerFn.getReturnTypeNode()
        if (fnRetNode) {
          const effectRef =
            Node.isTypeReference(fnRetNode) &&
            (fnRetNode.getText().includes("Effect") || fnRetNode.getText().includes("Return"))
              ? fnRetNode
              : fnRetNode.getFirstDescendant(
                  (n) =>
                    Node.isTypeReference(n) &&
                    (n.getText().includes("Effect") || n.getText().includes("Return")),
                )
          if (effectRef && Node.isTypeReference(effectRef)) {
            const typeArgs = effectRef.getTypeArguments()
            if (
              typeArgs.length >= 1 &&
              typeArgs[0] &&
              (successType === "void" || successType === "unknown" || !successType)
            ) {
              successType = cleanName(typeArgs[0].getText())
            }
            if (typeArgs.length >= 2 && typeArgs[1]) {
              for (const err of decomposeTypeNode(typeArgs[1])) {
                errorTags.add(err)
              }
            }
            if (typeArgs.length >= 3 && typeArgs[2]) {
              for (const svc of decomposeTypeNode(typeArgs[2])) {
                requiredServices.add(svc)
              }
            }
          }
        }
      }

      // Check stub calls
      const calls = init.getDescendantsOfKind(SyntaxKind.CallExpression)
      for (const c of calls) {
        const expr = c.getExpression()
        const exprText = expr.getText()
        if (exprText === "stub" || exprText.endsWith(".stub")) {
          isStub = true
          const typeArgs = c.getTypeArguments()
          if (typeArgs.length >= 1 && typeArgs[0]) {
            successType = typeArgs[0].getText()
          }
          if (typeArgs.length >= 2 && typeArgs[1]) {
            for (const err of decomposeTypeNode(typeArgs[1])) {
              errorTags.add(err)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const svc of decomposeTypeNode(typeArgs[2])) {
              requiredServices.add(svc)
            }
          }
        }
      }

      // Explicit type on variable declaration
      if (typeNode) {
        const effectRef = typeNode.getFirstDescendant(
          (node) => Node.isTypeReference(node) && node.getText().includes("Effect"),
        )
        if (effectRef && Node.isTypeReference(effectRef)) {
          const typeArgs = effectRef.getTypeArguments()
          if (
            typeArgs.length >= 1 &&
            typeArgs[0] &&
            (successType === "void" || successType === "unknown")
          ) {
            successType = typeArgs[0].getText()
          }
          if (typeArgs.length >= 2 && typeArgs[1]) {
            for (const err of decomposeTypeNode(typeArgs[1])) {
              errorTags.add(err)
            }
          }
          if (typeArgs.length >= 3 && typeArgs[2]) {
            for (const svc of decomposeTypeNode(typeArgs[2])) {
              requiredServices.add(svc)
            }
          }
        }
      }

      // TypeChecker signature return type
      const sigs = varDecl.getType().getCallSignatures()
      if (sigs.length > 0 && sigs[0]) {
        const retType = sigs[0].getReturnType()
        const typeArgs = retType.getTypeArguments()
        if (
          typeArgs.length >= 1 &&
          typeArgs[0] &&
          (successType === "void" || successType === "unknown") &&
          !typeArgs[0].isAny()
        ) {
          successType = typeArgs[0].getText()
        } else if (successType === "void" || successType === "unknown") {
          const retNode =
            Node.isArrowFunction(init) || Node.isFunctionExpression(init)
              ? init.getReturnTypeNode()?.getText()
              : undefined
          successType = retNode ?? (!retType.isAny() ? retType.getText() : "unknown")
        }
        if (
          typeArgs.length >= 2 &&
          typeArgs[1] &&
          !typeArgs[1].isNever() &&
          !typeArgs[1].isUnknown() &&
          !typeArgs[1].isAny()
        ) {
          for (const err of decomposeType(typeArgs[1])) {
            errorTags.add(err)
          }
        }
        if (
          typeArgs.length >= 3 &&
          typeArgs[2] &&
          !typeArgs[2].isNever() &&
          !typeArgs[2].isUnknown() &&
          !typeArgs[2].isAny()
        ) {
          for (const svc of decomposeType(typeArgs[2])) {
            requiredServices.add(svc)
          }
        }
      }

      // Derive outputSchema from successType if single type reference name
      if (successType) {
        const cleanedSuccess = cleanName(successType)
          .replace(/typeof\s+/, "")
          .replace(/\.Type$/, "")
        if (
          cleanedSuccess &&
          cleanedSuccess !== "void" &&
          cleanedSuccess !== "never" &&
          cleanedSuccess !== "unknown" &&
          cleanedSuccess !== "any" &&
          cleanedSuccess !== "string" &&
          cleanedSuccess !== "number" &&
          cleanedSuccess !== "boolean" &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleanedSuccess)
        ) {
          outputSchema = cleanedSuccess
        }
      }

      // AST yield traversal for real implementations
      const yields = init.getDescendantsOfKind(SyntaxKind.YieldExpression)
      const varToService = new Map<string, string>()
      const shouldExtractYieldedServices = requiredServices.size === 0

      for (const y of yields) {
        const expr = y.getExpression()
        if (!expr) continue

        if (expr.getKind() === SyntaxKind.Identifier) {
          const rawName = expr.getText()
          const isServiceCandidate =
            classNameToTagId.has(rawName) ||
            services.some((s) => s.tagId === rawName || s.name === rawName) ||
            /^[A-Z]/.test(rawName)

          if (shouldExtractYieldedServices && isServiceCandidate) {
            const svcName = classNameToTagId.get(rawName) ?? rawName
            requiredServices.add(svcName)
          }

          const parent = y.getParent()
          if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
            const id = parent.getFirstChildByKind(SyntaxKind.Identifier)
            if (id) {
              varToService.set(id.getText(), rawName)
            }
          }
        }

        if (expr.getKind() === SyntaxKind.NewExpression) {
          const newExpr = expr as NewExpression
          const errorId = newExpr.getExpression().getText()
          if (
            errorId.endsWith("Error") ||
            errors.some((e) => e.errorTag === errorId) ||
            referencedErrors.has(errorId)
          ) {
            errorTags.add(errorId)
          }
        }

        if (expr.getKind() === SyntaxKind.CallExpression) {
          const callExpr = expr as CallExpression
          const calleeText = callExpr.getExpression().getText()
          if (calleeText === "Effect.fail" || calleeText.endsWith(".fail")) {
            const args = callExpr.getArguments()
            if (args.length > 0 && args[0]) {
              const arg = args[0]
              if (arg.getKind() === SyntaxKind.NewExpression) {
                const newExpr = arg as NewExpression
                errorTags.add(newExpr.getExpression().getText())
              } else if (arg.getKind() === SyntaxKind.Identifier) {
                errorTags.add(arg.getText())
              }
            }
          } else if (calleeText.endsWith(".make")) {
            const errorId = calleeText.replace(/\.make$/, "")
            if (
              errorId.endsWith("Error") ||
              errors.some((e) => e.errorTag === errorId) ||
              referencedErrors.has(errorId)
            ) {
              errorTags.add(errorId)
            }
          }
        }
      }

      // Method calls on yielded services
      for (const c of calls) {
        const expr = c.getExpression()
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expr as PropertyAccessExpression
          const objText = propAccess.getExpression().getText()
          const methodName = propAccess.getName()
          const svcName = varToService.get(objText)
          if (svcName) {
            const methodErrors = serviceMethodErrors.get(svcName)?.get(methodName)
            if (methodErrors) {
              for (const err of methodErrors) {
                errorTags.add(err)
              }
            }
          }
        }
      }

      // Detect caught errors via Effect.catchTag and Effect.catchTags (F-34)
      const caughtErrors = new Set<string>()
      for (const c of calls) {
        const expr = c.getExpression()
        const exprText = expr.getText()
        if (exprText === "Effect.catchTag" || exprText.endsWith(".catchTag")) {
          const args = c.getArguments()
          if (args.length > 0 && args[0]) {
            const firstArg = args[0]
            if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) {
              caughtErrors.add(firstArg.getLiteralText())
            }
          }
        }
        if (exprText === "Effect.catchTags" || exprText.endsWith(".catchTags")) {
          const args = c.getArguments()
          if (args.length > 0 && args[0] && Node.isObjectLiteralExpression(args[0])) {
            for (const prop of args[0].getProperties()) {
              if (Node.isPropertyAssignment(prop)) {
                caughtErrors.add(prop.getName().replace(/^["'`]|["'`]$/g, ""))
              }
            }
          }
        }
      }

      fns.push({
        _tag: "EffectFn",
        qualname,
        spanName,
        packageTag: filePkgTag,
        file: relPath,
        line,
        successType,
        isStub,
        ...(inputSchema ? { inputSchema } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(inputSchema || outputSchema
          ? {
              payloadSchemas: Array.from(
                new Set([
                  ...(inputSchema ? [inputSchema] : []),
                  ...(outputSchema ? [outputSchema] : []),
                ]),
              ),
            }
          : {}),
        ...(caughtErrors.size > 0 ? { caughtErrors: Array.from(caughtErrors) } : {}),
      })

      for (const err of errorTags) {
        failsWith.push({ callerQualname: qualname, errorTag: err })
        referencedErrors.add(err)
      }
      for (const rawSvc of requiredServices) {
        const svc = classNameToTagId.get(rawSvc) ?? rawSvc
        requiresService.push({ callerQualname: qualname, tagId: svc })
        referencedServices.add(svc)
      }
    }

    if (filePkgTag === "domain" || filePkgTag === "contract") {
      for (const fnDecl of sourceFile.getFunctions()) {
        if (!fnDecl.isExported()) continue
        const fnName = fnDecl.getName()
        if (!fnName) continue
        if (
          /^(?:evolve[A-Z]\w*|reduce[A-Z]\w*|.*Reducer)$/.test(fnName) &&
          fnDecl.getParameters().length === 2
        ) {
          const qualname = `${relPath}#${fnName}`
          const spanName =
            fnName.startsWith("evolve") && fnName.length > 6 ? `${fnName.slice(6)}.evolve` : fnName
          fns.push({
            _tag: "EffectFn",
            qualname,
            spanName,
            packageTag: filePkgTag,
            file: relPath,
            line: fnDecl.getStartLineNumber(),
            successType: fnDecl.getReturnTypeNode()?.getText() ?? "unknown",
            isStub: false,
          })
        }
      }
    }
  }

  // 2b. Type-aware discriminant branching, array predicate branching, non-exhaustive match check, and schema boolean state check
  for (const sourceFile of sortedSourceFiles) {
    const relPath = path.relative(repoRoot, sourceFile.getFilePath()).replace(/\\/g, "/")
    if (
      !fileMap.has(relPath) ||
      relPath.startsWith("libs/harness/") ||
      relPath.startsWith("apps/harness-")
    ) {
      continue
    }
    if (session !== undefined && !filesToReextract.has(relPath)) {
      continue
    }

    const filePkgTag = fileMap.get(relPath)?.packageTag ?? resolvePackageTag(repoRoot, relPath)

    if (filePkgTag === "infra" || filePkgTag === "app") {
      for (const imp of sourceFile.getImportDeclarations()) {
        const modSpec = imp.getModuleSpecifierValue()
        if (modSpec === "node:sqlite" || modSpec === "sqlite" || modSpec === "better-sqlite3") {
          branchingViolations.push({
            rule: "node-sqlite-in-infra",
            message: `Do not import '${modSpec}' in '${relPath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
            file: relPath,
            line: imp.getStartLineNumber(),
            enclosingSymbol: relPath,
          })
        }
      }
      for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = callExpr.getExpression()
        const exprText = expr.getText()
        const isRequireOrImport =
          (Node.isIdentifier(expr) && exprText === "require") ||
          expr.getKind() === SyntaxKind.ImportKeyword ||
          exprText === "require" ||
          exprText === "import"
        if (isRequireOrImport) {
          const args = callExpr.getArguments()
          if (args.length > 0) {
            const firstArg = args[0]
            const modSpec =
              firstArg != null && Node.isStringLiteral(firstArg)
                ? firstArg.getLiteralValue()
                : firstArg != null && Node.isNoSubstitutionTemplateLiteral(firstArg)
                  ? firstArg.getLiteralValue()
                  : undefined
            if (modSpec === "node:sqlite" || modSpec === "sqlite" || modSpec === "better-sqlite3") {
              branchingViolations.push({
                rule: "node-sqlite-in-infra",
                message: `Do not import '${modSpec}' in '${relPath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
                file: relPath,
                line: callExpr.getStartLineNumber(),
                enclosingSymbol: relPath,
              })
            }
          }
        }
      }
    }

    // Track local variable declarations that alias a discriminant property of a union
    const discriminantAliasVars = new Set<string>()
    for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = varDecl.getInitializer()
      if (init && Node.isPropertyAccessExpression(init)) {
        const objExpr = init.getExpression()
        const propName = init.getName()
        const objType = objExpr.getType()
        if (isDiscriminantPropertyOfUnion(objType, propName, init)) {
          discriminantAliasVars.add(varDecl.getName())
        }
      } else if (init) {
        const nameNode = varDecl.getNameNode()
        if (Node.isObjectBindingPattern(nameNode)) {
          const objType = init.getType()
          for (const elem of nameNode.getElements()) {
            const propName = elem.getPropertyNameNode()?.getText() ?? elem.getName()
            if (isDiscriminantPropertyOfUnion(objType, propName, elem)) {
              discriminantAliasVars.add(elem.getName())
            }
          }
        }
      }
    }

    const checkConditionNode = (condExpr: Node, statementNode: Node): void => {
      const callNodes = [
        ...(Node.isCallExpression(condExpr) ? [condExpr] : []),
        ...condExpr.getDescendantsOfKind(SyntaxKind.CallExpression),
      ]
      for (const callNode of callNodes) {
        const calleeText = callNode.getExpression().getText()
        if (
          calleeText === "Exit.isSuccess" ||
          calleeText === "Exit.isFailure" ||
          calleeText === "Option.isSome" ||
          calleeText === "Option.isNone" ||
          calleeText === "Either.isRight" ||
          calleeText === "Either.isLeft" ||
          calleeText === "Result.isSuccess" ||
          calleeText === "Result.isFailure"
        ) {
          const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
          branchingViolations.push({
            rule: "discriminant-branching",
            message: `Condition in '${enclosingSymbol}' branches on tag guard '${calleeText}(...)' via if/ternary — enumerate all variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
            file: relPath,
            line: statementNode.getStartLineNumber(),
            enclosingSymbol,
          })
          return
        }
      }

      const binNodes = [
        ...(Node.isBinaryExpression(condExpr) ? [condExpr] : []),
        ...condExpr.getDescendantsOfKind(SyntaxKind.BinaryExpression),
      ]
      for (const bin of binNodes) {
        const opKind = bin.getOperatorToken().getKind()
        if (
          opKind !== SyntaxKind.EqualsEqualsEqualsToken &&
          opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
          opKind !== SyntaxKind.EqualsEqualsToken &&
          opKind !== SyntaxKind.ExclamationEqualsToken
        ) {
          continue
        }
        const candidatePairs = [
          { side: bin.getLeft(), other: bin.getRight() },
          { side: bin.getRight(), other: bin.getLeft() },
        ]
        for (const { side, other } of candidatePairs) {
          if (Node.isPropertyAccessExpression(side)) {
            const isOtherLiteral =
              Node.isStringLiteral(other) ||
              Node.isNumericLiteral(other) ||
              Node.isNoSubstitutionTemplateLiteral(other) ||
              other.getKind() === SyntaxKind.TrueKeyword ||
              other.getKind() === SyntaxKind.FalseKeyword
            if (!isOtherLiteral) {
              continue
            }
            const objExpr = side.getExpression()
            const propName = side.getName()
            const objType = objExpr.getType()
            if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
              const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
              branchingViolations.push({
                rule: "discriminant-branching",
                message: `Condition in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via if/ternary — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
                file: relPath,
                line: statementNode.getStartLineNumber(),
                enclosingSymbol,
              })
              return
            }
          } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
            const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
            branchingViolations.push({
              rule: "discriminant-branching",
              message: `Condition in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via if/ternary — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
              file: relPath,
              line: statementNode.getStartLineNumber(),
              enclosingSymbol,
            })
            return
          }
        }
      }
    }

    for (const ifStmt of sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement)) {
      checkConditionNode(ifStmt.getExpression(), ifStmt)
    }

    for (const condExpr of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
      checkConditionNode(condExpr.getCondition(), condExpr)
    }

    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = callExpr.getExpression()
      const calleeText = callee.getText()

      // unscoped-effect-run check
      if (
        calleeText === "Effect.runSync" ||
        calleeText === "Effect.runPromise" ||
        calleeText === "Effect.runFork" ||
        calleeText === "Runtime.runSync" ||
        calleeText === "Runtime.runPromise"
      ) {
        const isInsideDeciderMake = callExpr
          .getAncestors()
          .some(
            (a) =>
              Node.isCallExpression(a) &&
              /^(?:.*\.)?Decider\.make$/.test(a.getExpression().getText()),
          )
        const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
        const isDomainOrContract =
          (filePkgTag === "domain" || filePkgTag === "contract") && !relPath.endsWith("/testing.ts")
        const isReducerSymbol = /#(evolve\w*|reduce\w*|.*Reducer)$/i.test(enclosingSymbol)

        if (isDomainOrContract || isInsideDeciderMake || isReducerSymbol) {
          branchingViolations.push({
            rule: "unscoped-effect-run",
            message: `Call to '${calleeText}' in '${enclosingSymbol}' executes an Effect synchronously/imperatively inside domain/reducer logic — keep reducers pure '(state, event) => State' and yield Effects instead of calling Effect.run*.`,
            file: relPath,
            line: callExpr.getStartLineNumber(),
            enclosingSymbol,
          })
        }
      }

      // Array predicate callbacks: .filter(...), .find(...), .some(...), .every(...)
      if (Node.isPropertyAccessExpression(callee)) {
        const methodName = callee.getName()
        if (
          methodName === "filter" ||
          methodName === "find" ||
          methodName === "some" ||
          methodName === "every"
        ) {
          const args = callExpr.getArguments()
          if (args.length > 0 && args[0]) {
            const cb = args[0]
            if (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) {
              const binNodes = cb.getDescendantsOfKind(SyntaxKind.BinaryExpression)
              for (const bin of binNodes) {
                const opKind = bin.getOperatorToken().getKind()
                if (
                  opKind !== SyntaxKind.EqualsEqualsEqualsToken &&
                  opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
                  opKind !== SyntaxKind.EqualsEqualsToken &&
                  opKind !== SyntaxKind.ExclamationEqualsToken
                ) {
                  continue
                }
                const candidatePairs = [
                  { side: bin.getLeft(), other: bin.getRight() },
                  { side: bin.getRight(), other: bin.getLeft() },
                ]
                for (const { side, other } of candidatePairs) {
                  if (Node.isPropertyAccessExpression(side)) {
                    const isOtherLiteral =
                      Node.isStringLiteral(other) ||
                      Node.isNumericLiteral(other) ||
                      Node.isNoSubstitutionTemplateLiteral(other) ||
                      other.getKind() === SyntaxKind.TrueKeyword ||
                      other.getKind() === SyntaxKind.FalseKeyword
                    if (!isOtherLiteral) continue
                    const objExpr = side.getExpression()
                    const propName = side.getName()
                    const objType = objExpr.getType()
                    if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
                      const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                      branchingViolations.push({
                        rule: "discriminant-branching",
                        message: `Predicate callback in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via .${methodName}() — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
                        file: relPath,
                        line: bin.getStartLineNumber(),
                        enclosingSymbol,
                      })
                      break
                    }
                  } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
                    const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                    branchingViolations.push({
                      rule: "discriminant-branching",
                      message: `Predicate callback in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via .${methodName}() — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
                      file: relPath,
                      line: bin.getStartLineNumber(),
                      enclosingSymbol,
                    })
                    break
                  }
                }
              }
            }
          }
        }
      }

      // Check ts-pattern match(...).otherwise() on closed union
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "otherwise") {
        let curr: Node = callee.getExpression()
        while (Node.isCallExpression(curr)) {
          const innerCallee = curr.getExpression()
          if (
            Node.isPropertyAccessExpression(innerCallee) &&
            (innerCallee.getName() === "with" ||
              innerCallee.getName() === "when" ||
              innerCallee.getName() === "narrow" ||
              innerCallee.getName() === "returnType")
          ) {
            curr = innerCallee.getExpression()
          } else {
            break
          }
        }
        if (Node.isCallExpression(curr) && curr.getExpression().getText() === "match") {
          const matchArg = curr.getArguments()[0]
          if (matchArg) {
            const argType = matchArg.getType()
            if (isClosedFiniteUnionType(argType, matchArg)) {
              const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
              branchingViolations.push({
                rule: "non-exhaustive-union-match",
                message: `match(${matchArg.getText()}) in '${enclosingSymbol}' matches on a closed union type '${argType.getText(matchArg)}' but terminates with .otherwise() — enumerate every variant and terminate with .exhaustive().`,
                file: relPath,
                line: callExpr.getStartLineNumber(),
                enclosingSymbol,
              })
            }
          }
        }
      }
    }

    // fallback-json-equality check
    for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const opKind = bin.getOperatorToken().getKind()
      const isCaseA =
        (opKind === SyntaxKind.EqualsEqualsEqualsToken ||
          opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
          opKind === SyntaxKind.EqualsEqualsToken ||
          opKind === SyntaxKind.ExclamationEqualsToken) &&
        bin.getLeft().getText().trim().startsWith("JSON.stringify(") &&
        bin.getRight().getText().trim().startsWith("JSON.stringify(")
      const isCaseB =
        (opKind === SyntaxKind.BarBarToken || opKind === SyntaxKind.AmpersandAmpersandToken) &&
        bin.getLeft().getText().includes("Equal.equals(") &&
        bin.getRight().getText().includes("JSON.stringify(")

      if (isCaseA || isCaseB) {
        const enclosingSymbol = findEnclosingSymbolName(bin, relPath)
        branchingViolations.push({
          rule: "fallback-json-equality",
          message: `Comparison in '${enclosingSymbol}' uses JSON.stringify equality fallback — compare Effect Data/Schema values exclusively with Equal.equals(a, b).`,
          file: relPath,
          line: bin.getStartLineNumber(),
          enclosingSymbol,
        })
      }
    }

    // vacuous-error-assertion check
    const ASSERTION_NAME_REGEX = /^(?:thenFails|assertFails|expectError)$/
    const assertionCandidates = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodSignature),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
    ]
    for (const node of assertionCandidates) {
      const name = node.getName()
      if (!name || !ASSERTION_NAME_REGEX.test(name)) continue

      let params: ReadonlyArray<ParameterDeclaration> | undefined
      if (
        Node.isMethodSignature(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isFunctionDeclaration(node)
      ) {
        params = node.getParameters()
      } else if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) {
        const init = node.getInitializer()
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          params = init.getParameters()
        }
      }

      if (params !== undefined) {
        const isVacuous =
          params.length === 0 ||
          (params[0] !== undefined &&
            (params[0].hasQuestionToken() ||
              params[0].hasInitializer() ||
              /\bundefined\b/.test(params[0].getTypeNode()?.getText() ?? "")))

        if (isVacuous) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          branchingViolations.push({
            rule: "vacuous-error-assertion",
            message: `Assertion helper '${name}' in '${enclosingSymbol}' allows an optional or omitted expected error — require an explicit expected error instance or predicate so arbitrary failures are never silently swallowed.`,
            file: relPath,
            line: node.getStartLineNumber(),
            enclosingSymbol,
          })
        }
      }
    }

    // Schema.Struct, Schema.TaggedStruct, and Schema.TaggedClass check in type:contract and type:domain
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = callExpr.getExpression()
        const isStructCall =
          callee.getText() === "Schema.Struct" ||
          callee.getText() === "S.Struct" ||
          (Node.isPropertyAccessExpression(callee) &&
            callee.getName() === "Struct" &&
            (callee.getExpression().getText() === "Schema" ||
              callee.getExpression().getText() === "S"))

        const isTaggedStructCall =
          callee.getText() === "Schema.TaggedStruct" ||
          callee.getText() === "S.TaggedStruct" ||
          (Node.isPropertyAccessExpression(callee) &&
            callee.getName() === "TaggedStruct" &&
            (callee.getExpression().getText() === "Schema" ||
              callee.getExpression().getText() === "S"))

        const isTaggedClassCall = (() => {
          if (Node.isCallExpression(callee)) {
            const innerCallee = callee.getExpression()
            const innerText = innerCallee.getText()
            if (
              innerText === "Schema.TaggedClass" ||
              innerText === "S.TaggedClass" ||
              (Node.isPropertyAccessExpression(innerCallee) &&
                innerCallee.getName() === "TaggedClass" &&
                (innerCallee.getExpression().getText() === "Schema" ||
                  innerCallee.getExpression().getText() === "S"))
            ) {
              return true
            }
          }
          if (
            callee.getText() === "Schema.TaggedClass" ||
            callee.getText() === "S.TaggedClass" ||
            (Node.isPropertyAccessExpression(callee) &&
              callee.getName() === "TaggedClass" &&
              (callee.getExpression().getText() === "Schema" ||
                callee.getExpression().getText() === "S"))
          ) {
            return true
          }
          return false
        })()

        if (!isStructCall && !isTaggedStructCall && !isTaggedClassCall) continue

        const args = callExpr.getArguments()
        let objLit: Node | undefined = undefined
        if (isStructCall && args.length >= 1 && Node.isObjectLiteralExpression(args[0])) {
          objLit = args[0]
        } else if (
          (isTaggedStructCall || isTaggedClassCall) &&
          args.length >= 2 &&
          Node.isObjectLiteralExpression(args[1])
        ) {
          objLit = args[1]
        }

        if (!objLit || !Node.isObjectLiteralExpression(objLit)) continue

        const propAssignments: Array<{ name: string; node: Node; init: Node }> = []
        const propMap = new Map<string, { node: Node; init: Node }>()

        for (const p of objLit.getProperties()) {
          if (Node.isPropertyAssignment(p)) {
            const pName = p.getName()
            const pInit = p.getInitializer()
            if (pInit) {
              const entry = { name: pName, node: p, init: pInit }
              propAssignments.push(entry)
              propMap.set(pName, entry)
            }
          }
        }

        const isBooleanSchema = (node: Node): boolean => {
          const text = node.getText().replace(/\s+/g, "")
          if (text === "Schema.Boolean" || text === "S.Boolean") {
            return true
          }
          if (Node.isCallExpression(node)) {
            const calleeText = node.getExpression().getText().replace(/\s+/g, "")
            if (
              calleeText === "Schema.optional" ||
              calleeText === "S.optional" ||
              calleeText === "Schema.optionalWith" ||
              calleeText === "S.optionalWith"
            ) {
              const firstArg = node.getArguments()[0]
              if (firstArg) {
                return isBooleanSchema(firstArg)
              }
            }
          }
          return false
        }

        const isNullOrOrOption = (node: Node): boolean => {
          const text = node.getText()
          return (
            text.includes("NullOr") ||
            text.includes("Option") ||
            text.includes("Schema.NullOr") ||
            text.includes("Schema.Option") ||
            text.includes("S.NullOr") ||
            text.includes("S.Option")
          )
        }

        for (const { name, node, init } of propAssignments) {
          if (isBooleanSchema(init)) {
            const matchesRegex =
              /^(is[A-Z]|has[A-Z]|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/.test(
                name,
              ) ||
              /^(is[A-Z]\w*|has[A-Z]\w*|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/.test(
                name,
              )

            const hasCompanion = (() => {
              const candidates = [
                `${name}At`,
                `${name}By`,
                ...(name.startsWith("is") && name.length > 2
                  ? [
                      `${name[2]!.toLowerCase()}${name.slice(3)}At`,
                      `${name[2]!.toLowerCase()}${name.slice(3)}By`,
                    ]
                  : []),
                ...(name.startsWith("has") && name.length > 3
                  ? [
                      `${name[3]!.toLowerCase()}${name.slice(4)}At`,
                      `${name[3]!.toLowerCase()}${name.slice(4)}By`,
                    ]
                  : []),
              ]
              for (const cand of candidates) {
                const companion = propMap.get(cand)
                if (companion && isNullOrOrOption(companion.init)) {
                  return true
                }
              }
              return false
            })()

            if (matchesRegex || hasCompanion) {
              const enclosingSymbol = findEnclosingSymbolName(node, relPath)
              branchingViolations.push({
                rule: "schema-boolean-state",
                message: `Property '${name}' in '${enclosingSymbol}' uses boolean flag for lifecycle state in Schema.Struct — mutually exclusive lifecycle states must be modeled as a closed union (Schema.TaggedUnion / Schema.TaggedStruct) instead of boolean flags.`,
                file: relPath,
                line: node.getStartLineNumber(),
                enclosingSymbol,
              })
            }
          }

          // Rule A: unbranded-schema-field check
          if (/^(quantity|streamVersion|expectedVersion)$/.test(name)) {
            const initClean = init.getText().replace(/\s+/g, "")
            const startsWithUnbrandedNum =
              initClean.startsWith("Schema.Int") ||
              initClean.startsWith("S.Int") ||
              initClean.startsWith("Schema.Number") ||
              initClean.startsWith("S.Number") ||
              initClean.startsWith("Schema.Natural") ||
              initClean.startsWith("S.Natural")

            if (startsWithUnbrandedNum && !initClean.includes("brand(")) {
              const enclosingSymbol = findEnclosingSymbolName(node, relPath)
              branchingViolations.push({
                rule: "unbranded-schema-field",
                message: `Property '${name}' in '${enclosingSymbol}' uses unbranded '${init.getText()}' — domain quantity and version fields must use a branded contract schema (e.g. PositiveInt, StreamVersion, or .pipe(Schema.brand(...))) so invalid raw numbers cannot be passed at compile time.`,
                file: relPath,
                line: node.getStartLineNumber(),
                enclosingSymbol,
              })
            }
          }
        }
      }

      for (const iface of sourceFile.getInterfaces()) {
        if (!iface.isExported()) continue
        const ifaceName = iface.getName()
        for (const prop of iface.getProperties()) {
          const propName = prop.getName()
          const typeNodeText = prop.getTypeNode()?.getText() ?? ""
          if (
            /\bboolean\b/.test(typeNodeText) &&
            /^(is[A-Z]\w*|has[A-Z]\w*|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/.test(
              propName,
            )
          ) {
            branchingViolations.push({
              rule: "schema-boolean-state",
              message: `Interface property '${propName}' on '${ifaceName}' in '${relPath}' uses a boolean flag ('${typeNodeText}') — model configuration and lifecycle modes with a closed discriminated union (Schema.TaggedStruct / Schema.Union) instead of boolean flags.`,
              file: relPath,
              line: prop.getStartLineNumber(),
              enclosingSymbol: `${relPath}#${ifaceName}`,
            })
          }
        }
      }
    }

    // Rule B: handwritten-tagged-union check
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      for (const typeAlias of sourceFile.getTypeAliases()) {
        const typeNode = typeAlias.getTypeNode()
        if (typeNode && Node.isUnionTypeNode(typeNode)) {
          let tagMemberCount = 0
          for (const member of typeNode.getTypeNodes()) {
            if (Node.isTypeLiteral(member)) {
              if (member.getProperties().some((p) => p.getName() === "_tag")) {
                tagMemberCount++
              }
            }
          }
          if (tagMemberCount >= 2) {
            branchingViolations.push({
              rule: "handwritten-tagged-union",
              message: `Type alias '${typeAlias.getName()}' in '${relPath}' is a handwritten TypeScript union of '_tag' object literals — model domain states, commands, and events with Schema.Union / Schema.TaggedStruct / Schema.TaggedUnion and derive the type via 'typeof ${typeAlias.getName()}.Type'.`,
              file: relPath,
              line: typeAlias.getStartLineNumber(),
              enclosingSymbol: `${relPath}#${typeAlias.getName()}`,
            })
          }
        }
      }
    }

    // Rule C: untraced-decider check
    const isTracedWithEffectFn = (node: Node): boolean => {
      const text = node.getText()
      if (text.startsWith("Effect.fn(") || text.includes("Effect.fn(")) {
        return true
      }
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression()
        if (Node.isCallExpression(expr)) {
          const innerExpr = expr.getExpression()
          if (innerExpr.getText() === "Effect.fn") return true
        }
        if (expr.getText() === "Effect.fn") return true
      }
      return false
    }

    // 1. Decider.make call sites
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = callExpr.getExpression()
      const calleeText = callee.getText()
      if (calleeText === "Decider.make" || calleeText.endsWith(".Decider.make")) {
        const args = callExpr.getArguments()
        if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
          const objLit = args[0]
          const decideProp = objLit.getProperty("decide")
          if (decideProp) {
            let isUntraced = false
            if (Node.isMethodDeclaration(decideProp)) {
              isUntraced = true
            } else if (Node.isPropertyAssignment(decideProp)) {
              const init = decideProp.getInitializer()
              if (init) {
                if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
                  isUntraced = !isTracedWithEffectFn(init)
                } else if (Node.isIdentifier(init)) {
                  const idName = init.getText()
                  const decl =
                    sourceFile.getVariableDeclaration(idName) ?? sourceFile.getFunction(idName)
                  if (decl) {
                    if (Node.isVariableDeclaration(decl)) {
                      const declInit = decl.getInitializer()
                      if (!declInit || !isTracedWithEffectFn(declInit)) {
                        isUntraced = true
                      }
                    } else {
                      isUntraced = true
                    }
                  }
                } else if (!isTracedWithEffectFn(init)) {
                  isUntraced = true
                }
              }
            } else if (Node.isShorthandPropertyAssignment(decideProp)) {
              const idName = decideProp.getName()
              const decl =
                sourceFile.getVariableDeclaration(idName) ?? sourceFile.getFunction(idName)
              if (decl) {
                if (Node.isVariableDeclaration(decl)) {
                  const declInit = decl.getInitializer()
                  if (!declInit || !isTracedWithEffectFn(declInit)) {
                    isUntraced = true
                  }
                } else {
                  isUntraced = true
                }
              }
            }

            if (isUntraced) {
              const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
              branchingViolations.push({
                rule: "untraced-decider",
                message: `Decider.make in '${enclosingSymbol}' binds an untraced 'decide' function — 'decide' must be declared with Effect.fn("<Domain>.decide") for automatic span tracing.`,
                file: relPath,
                line: decideProp.getStartLineNumber(),
                enclosingSymbol,
              })
            }
          }
        }
      }
    }

    // 2. Decider.make definitions inside files ending with decider.ts
    if (relPath.endsWith("decider.ts") || relPath.endsWith("/decider.ts")) {
      const makeCandidates: Array<{ name: string; node: Node; getBodyText: () => string }> = []

      for (const varDecl of sourceFile.getVariableDeclarations()) {
        if (varDecl.getName() === "make") {
          const init = varDecl.getInitializer()
          if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            const body = init.getBody()
            makeCandidates.push({
              name: "make",
              node: varDecl,
              getBodyText: () => (body ? body.getText() : init.getText()),
            })
          }
        }
      }
      for (const fnDecl of sourceFile.getFunctions()) {
        if (fnDecl.getName() === "make") {
          const body = fnDecl.getBody()
          makeCandidates.push({
            name: "make",
            node: fnDecl,
            getBodyText: () => (body ? body.getText() : fnDecl.getText()),
          })
        }
      }
      for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        if (prop.getName() === "make") {
          const init = prop.getInitializer()
          if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            const body = init.getBody()
            makeCandidates.push({
              name: "make",
              node: prop,
              getBodyText: () => (body ? body.getText() : init.getText()),
            })
          }
        }
      }
      for (const method of sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
        if (method.getName() === "make") {
          const body = method.getBody()
          makeCandidates.push({
            name: "make",
            node: method,
            getBodyText: () => (body ? body.getText() : method.getText()),
          })
        }
      }

      for (const cand of makeCandidates) {
        const bodyText = cand.getBodyText()
        const cleanBody = bodyText.replace(/\s+/g, "")
        const hasTracing =
          bodyText.includes("Effect.fn") ||
          bodyText.includes("Effect.withSpan") ||
          bodyText.includes("withSpan")

        const returnsOptionsDirectly =
          cleanBody === "options" ||
          cleanBody === "{returnoptions;}" ||
          cleanBody === "{returnoptions}" ||
          /^\{?\s*return\s+options;?\s*\}?$/.test(bodyText.trim()) ||
          bodyText.trim() === "options"

        if (!hasTracing && returnsOptionsDirectly) {
          branchingViolations.push({
            rule: "untraced-decider",
            message: `Decider.make in '${relPath}' returns options unchanged without enforcing or wrapping span tracing — wrap or trace options.decide (e.g. Effect.withSpan / Effect.fn) in Decider.make.`,
            file: relPath,
            line: cand.node.getStartLineNumber(),
            enclosingSymbol: `${relPath}#make`,
          })
        }
      }
    }

    // Rule D: missing-aggregate-id-guard check
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      const deciderCalls: Array<{ callNode: Node; genFn: Node }> = []

      // Check VariableDeclarations initialized with Effect.fn("*.decide")(function* ...)
      for (const varDecl of sourceFile.getVariableDeclarations()) {
        const init = varDecl.getInitializer()
        if (init && Node.isCallExpression(init)) {
          const innerCall = init.getExpression()
          if (Node.isCallExpression(innerCall)) {
            const innerCallee = innerCall.getExpression()
            if (innerCallee.getText() === "Effect.fn") {
              const spanArg = innerCall.getArguments()[0]
              if (spanArg && Node.isStringLiteral(spanArg)) {
                const spanName = spanArg.getLiteralText()
                if (spanName.endsWith(".decide") || spanName === "decide") {
                  const args = init.getArguments()
                  if (
                    args.length > 0 &&
                    (Node.isFunctionExpression(args[0]!) || Node.isArrowFunction(args[0]!))
                  ) {
                    deciderCalls.push({ callNode: varDecl, genFn: args[0]! })
                  }
                }
              }
            }
          }
        }
      }

      // Also check any CallExpression of Effect.fn("*.decide")(function* ...) anywhere (e.g. inside Decider.make)
      for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const innerCall = callExpr.getExpression()
        if (Node.isCallExpression(innerCall)) {
          const innerCallee = innerCall.getExpression()
          if (innerCallee.getText() === "Effect.fn") {
            const spanArg = innerCall.getArguments()[0]
            if (spanArg && Node.isStringLiteral(spanArg)) {
              const spanName = spanArg.getLiteralText()
              if (spanName.endsWith(".decide") || spanName === "decide") {
                const args = callExpr.getArguments()
                if (
                  args.length > 0 &&
                  (Node.isFunctionExpression(args[0]!) || Node.isArrowFunction(args[0]!))
                ) {
                  if (!deciderCalls.some((c) => c.genFn === args[0]!)) {
                    deciderCalls.push({ callNode: callExpr, genFn: args[0]! })
                  }
                }
              }
            }
          }
        }
      }

      for (const { callNode, genFn } of deciderCalls) {
        let params: ReadonlyArray<ParameterDeclaration> = []
        if (Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn)) {
          params = genFn.getParameters()
        }
        if (params.length < 2) continue

        const cmdParam = params[0]!
        const stateParam = params[1]!

        // 1. Collect *Id properties present across ALL command variants
        const cmdIdProps = new Set<string>()
        const cmdType = cmdParam.getType()
        const cmdParts = cmdType.isUnion() ? cmdType.getUnionTypes() : [cmdType]
        if (cmdParts.length > 0) {
          const perPartIds = cmdParts.map((part) => {
            const set = new Set<string>()
            for (const p of part.getProperties()) {
              const pName = p.getName()
              if (pName.endsWith("Id") && pName !== "commandId" && pName !== "id") {
                set.add(pName)
              }
            }
            return set
          })
          const firstSet = perPartIds[0]!
          for (const idName of firstSet) {
            if (perPartIds.every((s) => s.has(idName))) {
              cmdIdProps.add(idName)
            }
          }
        }
        if (cmdIdProps.size === 0) {
          const matchingCmdSchemas = resolveSchemasForParameter(cmdParam)
          if (matchingCmdSchemas.length > 0) {
            const firstProps = matchingCmdSchemas[0]!.properties.filter(
              (p) => p.endsWith("Id") && p !== "commandId" && p !== "id",
            )
            for (const p of firstProps) {
              if (matchingCmdSchemas.every((s) => s.properties.includes(p))) {
                cmdIdProps.add(p)
              }
            }
          }
        }

        // 2. Collect *Id properties on stateParam constituents that carry aggregate IDs
        const stateIdProps = new Set<string>()
        const stateType = stateParam.getType()
        const stateParts = stateType.isUnion() ? stateType.getUnionTypes() : [stateType]
        const statePartsWithIds = stateParts
          .map((part) => {
            const set = new Set<string>()
            for (const p of part.getProperties()) {
              const pName = p.getName()
              if (pName.endsWith("Id") && pName !== "commandId" && pName !== "id") {
                set.add(pName)
              }
            }
            return set
          })
          .filter((set) => set.size > 0)
        if (statePartsWithIds.length > 0) {
          for (const idName of statePartsWithIds[0]!) {
            if (statePartsWithIds.every((s) => s.has(idName))) {
              stateIdProps.add(idName)
            }
          }
        }
        if (stateIdProps.size === 0) {
          const matchingStateSchemas = resolveSchemasForParameter(stateParam).filter((s) =>
            s.properties.some((p) => p.endsWith("Id") && p !== "commandId" && p !== "id"),
          )
          if (matchingStateSchemas.length > 0) {
            const firstProps = matchingStateSchemas[0]!.properties.filter(
              (p) => p.endsWith("Id") && p !== "commandId" && p !== "id",
            )
            for (const p of firstProps) {
              if (matchingStateSchemas.every((s) => s.properties.includes(p))) {
                stateIdProps.add(p)
              }
            }
          }
        }

        // 3. Find shared aggregate ID properties present on BOTH command and state
        const sharedIdProps = [...cmdIdProps].filter((id) => stateIdProps.has(id))

        if (sharedIdProps.length === 0) continue

        let bodyNode: Node | undefined = undefined
        if (Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn)) {
          bodyNode = genFn.getBody()
        }
        if (!bodyNode) continue

        const bodyText = stripCommentsAndTestTitles(bodyNode.getText())

        for (const idProp of sharedIdProps) {
          let hasIdComparison = false
          const receiverRegex = new RegExp(`([a-zA-Z0-9_$]+)\\.${idProp}\\b`)

          const hasDistinctReceivers = (aText: string, bText: string): boolean => {
            const mA = aText.match(receiverRegex)
            const mB = bText.match(receiverRegex)
            return Boolean(mA && mB && mA[1] !== mB[1])
          }

          // 1. BinaryExpression check
          for (const bin of bodyNode.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
            const opKind = bin.getOperatorToken().getKind()
            if (
              opKind === SyntaxKind.EqualsEqualsEqualsToken ||
              opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
              opKind === SyntaxKind.EqualsEqualsToken ||
              opKind === SyntaxKind.ExclamationEqualsToken
            ) {
              const leftText = bin.getLeft().getText()
              const rightText = bin.getRight().getText()
              if (hasDistinctReceivers(leftText, rightText)) {
                hasIdComparison = true
                break
              }
            }
          }

          // 2. Equal.equals check
          if (!hasIdComparison) {
            for (const call of bodyNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
              const calleeText = call.getExpression().getText()
              if (calleeText === "Equal.equals" || calleeText.endsWith(".Equal.equals")) {
                const cArgs = call.getArguments()
                if (
                  cArgs.length >= 2 &&
                  hasDistinctReceivers(cArgs[0]!.getText(), cArgs[1]!.getText())
                ) {
                  hasIdComparison = true
                  break
                }
              }
            }
          }

          // 3. Regex checks on comment-stripped bodyText with distinct receivers
          if (!hasIdComparison) {
            const compareRegex = new RegExp(
              `\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*(?:===|!==|==|!=)\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`,
            )
            const m = bodyText.match(compareRegex)
            if (m && m[1] !== m[2]) {
              hasIdComparison = true
            }
          }
          if (!hasIdComparison) {
            const equalsRegex = new RegExp(
              `Equal\\.equals\\(\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*,\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*\\)`,
            )
            const m = bodyText.match(equalsRegex)
            if (m && m[1] !== m[2]) {
              hasIdComparison = true
            }
          }
          if (!hasIdComparison) {
            const guardRegex = new RegExp(
              `(?:if|when)\\s*\\([^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b[^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`,
            )
            const m = bodyText.match(guardRegex)
            if (m && m[1] !== m[2]) {
              hasIdComparison = true
            }
          }

          if (!hasIdComparison) {
            const enclosingSymbol = findEnclosingSymbolName(callNode, relPath)
            branchingViolations.push({
              rule: "missing-aggregate-id-guard",
              message: `Decider '${enclosingSymbol}' accepts command and state that both carry aggregate identifier '${idProp}', but never verifies that command.${idProp} matches state.${idProp} on existing state variants.`,
              file: relPath,
              line: callNode.getStartLineNumber(),
              enclosingSymbol,
            })
          }
        }
      }
    }

    // Branded Type checks: unbranded-contract-schema and unbranded-primitive-boundary
    const extractBrandKeys = (type: Type): ReadonlyArray<string> => {
      const brandProp = type.getProperty("~effect/Brand")
      if (brandProp) {
        const brandType = brandProp.getValueDeclaration()?.getType() ?? brandProp.getDeclaredType()
        return brandType.getProperties().map((p) => p.getName())
      }
      if (type.isIntersection()) {
        return type.getIntersectionTypes().flatMap(extractBrandKeys)
      }
      return []
    }

    const castNodes = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression),
    ]
    for (const castNode of castNodes) {
      const targetType = castNode.getType()
      const exprType = castNode.getExpression().getType()
      if (isTypeBranded(targetType)) {
        const targetBrands = extractBrandKeys(targetType)
        const exprBrands = new Set(extractBrandKeys(exprType))
        const isExprBranded = isTypeBranded(exprType)
        const missingBrand = !isExprBranded || targetBrands.some((b) => !exprBrands.has(b))
        if (missingBrand) {
          const enclosingSymbol = findEnclosingSymbolName(castNode, relPath)
          const castKind = isExprBranded ? "a differently branded" : "an unbranded"
          branchingViolations.push({
            rule: "unbranded-primitive-boundary",
            message: `Type assertion '${castNode.getText()}' in '${enclosingSymbol}' casts ${castKind} value directly to branded type '${targetType.getText(castNode)}' — construct branded values via <Schema>.make(...) or Schema.decodeUnknownEffect(<Schema>)(...).`,
            file: relPath,
            line: castNode.getStartLineNumber(),
            enclosingSymbol,
          })
        }
      }
    }

    if (
      filePkgTag === "contract" ||
      (filePkgTag === "domain" && (relPath.includes("/domain/") || relPath.includes("/core/")))
    ) {
      if (filePkgTag === "contract") {
        for (const typeAlias of sourceFile.getTypeAliases()) {
          if (!typeAlias.isExported()) continue
          const aliasName = typeAlias.getName()
          const enclosingSymbol = `${relPath}#${aliasName}`
          const prim = isOpenUnbrandedPrimitiveType(typeAlias.getType(), typeAlias)
          if (prim !== null) {
            branchingViolations.push({
              rule: "unbranded-contract-schema",
              message: `Exported type alias '${aliasName}' in '${enclosingSymbol}' resolves to unbranded primitive '${prim}' without '~effect/Brand' — define a branded schema with Schema.brand("${aliasName}") in type:contract.`,
              file: relPath,
              line: typeAlias.getStartLineNumber(),
              enclosingSymbol,
            })
          } else if (
            containsInlineObjectTypeAst(typeAlias.getTypeNode()) &&
            !isTypeBranded(typeAlias.getType())
          ) {
            branchingViolations.push({
              rule: "unbranded-contract-schema",
              message: `Exported type alias '${aliasName}' in '${enclosingSymbol}' uses an inline object type literal without a runtime Schema — define a Schema.Struct or Schema.Class in type:contract with branded fields and derive 'export type ${aliasName} = typeof ${aliasName}.Type'.`,
              file: relPath,
              line: typeAlias.getStartLineNumber(),
              enclosingSymbol,
            })
          }
        }
      }

      const declaredBrandKeys = new Map<string, string>()
      for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const exprText = callExpr.getExpression().getText()
        if (exprText === "Schema.brand" || exprText === "S.brand") {
          const arg0 = callExpr.getArguments()[0]
          if (arg0 && Node.isStringLiteral(arg0)) {
            const brandKey = arg0.getLiteralValue()
            const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
            const firstSymbol = declaredBrandKeys.get(brandKey)
            if (firstSymbol && firstSymbol !== enclosingSymbol) {
              branchingViolations.push({
                rule: "unbranded-contract-schema",
                message: `Duplicate Schema.brand('${brandKey}') in '${enclosingSymbol}' (already declared in '${firstSymbol}') — each brand key must have a single canonical constructor schema; compose wire schemas using Schema.decodeTo(${brandKey}).`,
                file: relPath,
                line: callExpr.getStartLineNumber(),
                enclosingSymbol,
              })
            } else if (!firstSymbol) {
              declaredBrandKeys.set(brandKey, enclosingSymbol)
            }
          }
        }
      }

      for (const varDecl of sourceFile.getVariableDeclarations()) {
        if (!varDecl.isExported()) continue
        const varName = varDecl.getName()
        const init = varDecl.getInitializer()
        if (!init) continue
        const enclosingSymbol = `${relPath}#${varName}`
        const decodedType = getSchemaDecodedType(init)
        if (decodedType !== null) {
          const topPrim = isOpenUnbrandedPrimitiveType(decodedType, varDecl)
          if (topPrim !== null) {
            branchingViolations.push({
              rule: "unbranded-contract-schema",
              message: `Contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${topPrim}' without '~effect/Brand' — pipe the schema into Schema.brand("${varName}") so domain values carry nominal compile-time safety.`,
              file: relPath,
              line: varDecl.getStartLineNumber(),
              enclosingSymbol,
            })
          }

          // Inspect all decoded object/union-of-objects properties regardless of outer .pipe() / callee spelling
          const unbrandedProps = collectUnbrandedObjectProperties(decodedType, varDecl)
          for (const { propName, prim, line } of unbrandedProps) {
            branchingViolations.push({
              rule: "unbranded-contract-schema",
              message: `Property '${propName}' of contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${prim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for contract fields.`,
              file: relPath,
              line,
              enclosingSymbol,
            })
          }
        }
      }

      for (const cls of sourceFile.getClasses()) {
        if (!cls.isExported()) continue
        const clsName = cls.getName() ?? "AnonymousClass"
        const extClause = cls.getExtends()
        if (!extClause) continue
        const extText = extClause.getText()
        if (
          !extText.includes("Schema.TaggedError") &&
          !extText.includes("Schema.TaggedClass") &&
          !extText.includes("Schema.Class") &&
          !extText.includes("S.TaggedError") &&
          !extText.includes("S.TaggedClass") &&
          !extText.includes("S.Class")
        ) {
          continue
        }
        const enclosingSymbol = `${relPath}#${clsName}`
        for (const callExpr of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          for (const arg of callExpr.getArguments()) {
            if (!Node.isObjectLiteralExpression(arg)) continue
            for (const prop of arg.getProperties()) {
              if (!Node.isPropertyAssignment(prop)) continue
              const propName = prop.getName()
              if (propName === "_tag") continue
              const propInit = prop.getInitializer()
              if (!propInit) continue
              const propDecoded = getSchemaDecodedType(propInit)
              const propPrim = propDecoded ? isOpenUnbrandedPrimitiveType(propDecoded, prop) : null
              if (propPrim !== null) {
                branchingViolations.push({
                  rule: "unbranded-contract-schema",
                  message: `Field '${propName}' of '${clsName}' in '${enclosingSymbol}' decodes to unbranded primitive '${propPrim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for tagged error and class fields.`,
                  file: relPath,
                  line: prop.getStartLineNumber(),
                  enclosingSymbol,
                })
              }
            }
          }
        }
      }
    }

    if (filePkgTag === "service" && relPath.includes("/service/")) {
      for (const cls of sourceFile.getClasses()) {
        if (!cls.isExported()) continue
        const clsName = cls.getName() ?? "Service"
        const extClause = cls.getExtends()
        if (!extClause) continue
        const extText = extClause.getText()
        if (!extText.includes("Context.Service") && !extText.includes("Service<")) continue
        const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
        if (!typeLiteral) continue
        const enclosingSymbol = `${relPath}#${clsName}`

        for (const member of typeLiteral.getMembers()) {
          const memberName = Node.isPropertySignature(member)
            ? member.getName()
            : (member.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ?? "method")
          for (const param of member.getDescendantsOfKind(SyntaxKind.Parameter)) {
            const paramTypeNode = param.getTypeNode()
            if (containsInlineObjectTypeAst(paramTypeNode)) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Service capability '${clsName}.${memberName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
                file: relPath,
                line: param.getStartLineNumber(),
                enclosingSymbol,
              })
            }
            const paramType = param.getType()
            const paramPrim = isOpenUnbrandedPrimitiveType(paramType, param)
            if (paramPrim !== null) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Service capability '${clsName}.${memberName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses unbranded primitive '${paramPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                file: relPath,
                line: param.getStartLineNumber(),
                enclosingSymbol,
              })
            } else if (!paramType.isUnion()) {
              const unbrandedProps = collectUnbrandedObjectProperties(paramType, param)
              for (const { propName, prim, line } of unbrandedProps) {
                branchingViolations.push({
                  rule: "unbranded-primitive-boundary",
                  message: `Service capability '${clsName}.${memberName}' parameter property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                  file: relPath,
                  line,
                  enclosingSymbol,
                })
              }
            }
          }

          const effectRef = member.getFirstDescendant(
            (n) => Node.isTypeReference(n) && n.getText().includes("Effect"),
          )
          let returnTypeNode: Node | undefined
          let returnSuccessType: Type | undefined
          if (effectRef && Node.isTypeReference(effectRef)) {
            const typeArgs = effectRef.getTypeArguments()
            if (typeArgs.length >= 1 && typeArgs[0]) {
              returnTypeNode = typeArgs[0]
              returnSuccessType = typeArgs[0].getType()
            }
          } else {
            const fnType = member.getFirstDescendantByKind(SyntaxKind.FunctionType)
            if (fnType) {
              returnTypeNode = fnType.getReturnTypeNode()
              returnSuccessType = returnTypeNode?.getType()
            } else if (Node.isMethodSignature(member)) {
              returnTypeNode = member.getReturnTypeNode()
              returnSuccessType = returnTypeNode?.getType()
            }
          }

          if (containsInlineObjectTypeAst(returnTypeNode)) {
            branchingViolations.push({
              rule: "unbranded-primitive-boundary",
              message: `Service capability '${clsName}.${memberName}' return type in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
              file: relPath,
              line: member.getStartLineNumber(),
              enclosingSymbol,
            })
          }
          if (returnSuccessType) {
            const retPrim = isOpenUnbrandedPrimitiveType(
              returnSuccessType,
              returnTypeNode ?? member,
            )
            if (retPrim !== null) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Service capability '${clsName}.${memberName}' return type in '${enclosingSymbol}' resolves to unbranded primitive '${retPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                file: relPath,
                line: member.getStartLineNumber(),
                enclosingSymbol,
              })
            } else if (!returnSuccessType.isUnion()) {
              const unbrandedRetProps = collectUnbrandedObjectProperties(
                returnSuccessType,
                returnTypeNode ?? member,
              )
              for (const { propName, prim, line } of unbrandedRetProps) {
                branchingViolations.push({
                  rule: "unbranded-primitive-boundary",
                  message: `Service capability '${clsName}.${memberName}' return property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                  file: relPath,
                  line,
                  enclosingSymbol,
                })
              }
            }
          }
        }
      }
    }

    if (filePkgTag === "domain" && (relPath.includes("/domain/") || relPath.includes("/core/"))) {
      const checkExportedDomainFn = (
        fnName: string,
        fnNode: Node | undefined,
        declNode: Node,
      ): void => {
        const enclosingSymbol = `${relPath}#${fnName}`
        if (
          fnNode &&
          (Node.isFunctionExpression(fnNode) ||
            Node.isArrowFunction(fnNode) ||
            Node.isFunctionDeclaration(fnNode))
        ) {
          for (const param of fnNode.getParameters()) {
            const paramTypeNode = param.getTypeNode()
            if (containsInlineObjectTypeAst(paramTypeNode)) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Domain function '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
                file: relPath,
                line: param.getStartLineNumber(),
                enclosingSymbol,
              })
            }
            const paramType = param.getType()
            const paramPrim = isOpenUnbrandedPrimitiveType(paramType, param)
            if (paramPrim !== null) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Domain function '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses unbranded primitive '${paramPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                file: relPath,
                line: param.getStartLineNumber(),
                enclosingSymbol,
              })
            } else if (!paramType.isUnion()) {
              const unbrandedProps = collectUnbrandedObjectProperties(paramType, param)
              for (const { propName, prim, line } of unbrandedProps) {
                branchingViolations.push({
                  rule: "unbranded-primitive-boundary",
                  message: `Domain function '${fnName}' parameter property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                  file: relPath,
                  line,
                  enclosingSymbol,
                })
              }
            }
          }

          const explicitRetNode = fnNode.getReturnTypeNode()
          if (containsInlineObjectTypeAst(explicitRetNode)) {
            branchingViolations.push({
              rule: "unbranded-primitive-boundary",
              message: `Domain function '${fnName}' return type in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
              file: relPath,
              line: declNode.getStartLineNumber(),
              enclosingSymbol,
            })
          }
        }

        const sigs = declNode.getType().getCallSignatures()
        if (sigs.length > 0 && sigs[0]) {
          const fullRetType = sigs[0].getReturnType()
          const retTypeArgs = fullRetType.getTypeArguments()
          const retSuccessType =
            retTypeArgs.length >= 1 && retTypeArgs[0] ? retTypeArgs[0] : fullRetType
          const retPrim = isOpenUnbrandedPrimitiveType(retSuccessType, declNode)
          if (retPrim !== null) {
            branchingViolations.push({
              rule: "unbranded-primitive-boundary",
              message: `Domain function '${fnName}' return success type in '${enclosingSymbol}' resolves to unbranded primitive '${retPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
              file: relPath,
              line: declNode.getStartLineNumber(),
              enclosingSymbol,
            })
          } else if (!retSuccessType.isUnion()) {
            const unbrandedRetProps = collectUnbrandedObjectProperties(retSuccessType, declNode)
            for (const { propName, prim, line } of unbrandedRetProps) {
              branchingViolations.push({
                rule: "unbranded-primitive-boundary",
                message: `Domain function '${fnName}' return property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
                file: relPath,
                line,
                enclosingSymbol,
              })
            }
          }
        }
      }

      for (const varDecl of sourceFile.getVariableDeclarations()) {
        if (!varDecl.isExported()) continue
        const varName = varDecl.getName()
        const init = varDecl.getInitializer()
        if (!init) continue
        if (Node.isCallExpression(init)) {
          const innerExpr = init.getExpression()
          if (
            Node.isCallExpression(innerExpr) &&
            innerExpr.getExpression().getText() === "Effect.fn"
          ) {
            checkExportedDomainFn(varName, init.getArguments()[0], varDecl)
          } else if (innerExpr.getText() === "Effect.fnUntraced") {
            checkExportedDomainFn(varName, init.getArguments()[0], varDecl)
          }
        } else if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          checkExportedDomainFn(varName, init, varDecl)
        }
      }

      for (const fnDecl of sourceFile.getFunctions()) {
        if (!fnDecl.isExported()) continue
        const fnName = fnDecl.getName() ?? "anonymousFn"
        checkExportedDomainFn(fnName, fnDecl, fnDecl)
      }
    }

    // Event Sourcing Reducer checks: dead-event-payload and terminal-state-unhandled
    if (filePkgTag === "contract" || filePkgTag === "domain") {
      const isReducerName = (name: string): boolean => {
        const baseName = name.includes("#") ? name.split("#")[1]! : name
        return /^(evolve\w*|reduce\w*|.*Reducer)$/i.test(baseName)
      }

      const TERMINAL_VARIANT_REGEX =
        /^(CheckedOut|Cancelled|Canceled|Archived|Completed|Closed|Finished|Terminated)$/i

      const candidateFunctions = [
        ...sourceFile.getFunctions(),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
      ]

      const processedSymbols = new Set<string>()

      for (const fnNode of candidateFunctions) {
        const enclosingSymbol = findEnclosingSymbolName(fnNode, relPath)
        if (!isReducerName(enclosingSymbol)) continue
        if (processedSymbols.has(enclosingSymbol)) continue

        const params = fnNode.getParameters()
        if (params.length < 2) continue
        processedSymbols.add(enclosingSymbol)
        const stateParam = params[0]
        const eventParam = params[1]

        // 1. terminal-state-unhandled check
        if (stateParam && eventParam) {
          const stateType = stateParam.getType()
          let terminalVariantName: string | null = null

          if (stateType.isUnion()) {
            for (const unionPart of stateType.getUnionTypes()) {
              const tagProp = unionPart.getProperty("_tag")
              if (tagProp) {
                const tagType = tagProp.getTypeAtLocation(stateParam)
                const rawTag = tagType.getText().replace(/^["'`]|["'`]$/g, "")
                if (TERMINAL_VARIANT_REGEX.test(rawTag)) {
                  terminalVariantName = rawTag
                  break
                }
              } else {
                const typeText = unionPart.getText()
                const matchTag = typeText.match(TERMINAL_VARIANT_REGEX)
                if (matchTag) {
                  terminalVariantName = matchTag[0]
                  break
                }
              }
            }
          }
          if (terminalVariantName === null) {
            for (const stSchema of resolveSchemasForParameter(stateParam)) {
              if (TERMINAL_VARIANT_REGEX.test(stSchema.tag)) {
                terminalVariantName = stSchema.tag
                break
              }
            }
          }

          if (terminalVariantName !== null) {
            const stateParamName = stateParam.getName()
            const isMatchingOnState = (mArg: Node): boolean => {
              const text = mArg.getText()
              return new RegExp(`\\b${stateParamName}\\b`).test(text)
            }
            const findRootMatchCall = (node: Node): CallExpression | null => {
              let curr: Node = node
              while (Node.isCallExpression(curr)) {
                const callee = curr.getExpression()
                if (callee.getText() === "match") {
                  return curr
                }
                if (Node.isPropertyAccessExpression(callee)) {
                  curr = callee.getExpression()
                } else {
                  break
                }
              }
              return null
            }

            for (const callExpr of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
              if (callExpr.getExpression().getText() === "match") {
                const matchArg = callExpr.getArguments()[0]
                if (matchArg) {
                  const matchArgText = matchArg.getText()
                  const eventParamName = eventParam.getName()
                  if (
                    matchArgText === eventParamName ||
                    matchArgText === "event" ||
                    matchArgText === "ev"
                  ) {
                    const hasEnclosingStateMatch = callExpr.getAncestors().some((anc) => {
                      const rootMatch = findRootMatchCall(anc)
                      const arg0 = rootMatch?.getArguments()[0]
                      return arg0 !== undefined && isMatchingOnState(arg0)
                    })
                    if (!hasEnclosingStateMatch) {
                      branchingViolations.push({
                        rule: "terminal-state-unhandled",
                        message: `Reducer '${enclosingSymbol}' matches only on '${matchArgText}' without checking for terminal state '${terminalVariantName}' — terminal states must be matched on 'state' to preserve terminality during event folding.`,
                        file: relPath,
                        line: callExpr.getStartLineNumber(),
                        enclosingSymbol,
                      })
                    }
                  }
                }
              }
            }
          }
        }

        // 2. dead-event-payload check
        const stateTagSet = new Set<string>()
        const stateProps = new Set<string>()
        if (stateParam) {
          const stateType = stateParam.getType()
          const constituents = stateType.isUnion() ? stateType.getUnionTypes() : [stateType]
          for (const part of constituents) {
            const tagProp = part.getProperty("_tag")
            if (tagProp) {
              const tagType = tagProp.getTypeAtLocation(stateParam)
              const rawTag = tagType.getText().replace(/^["'`]|["'`]$/g, "")
              if (rawTag && rawTag !== "string") {
                stateTagSet.add(rawTag)
              }
            }
            for (const p of part.getProperties()) {
              stateProps.add(p.getName())
            }
          }
          const resolvedStateSchemas = resolveSchemasForParameter(stateParam)
          for (const stSchema of resolvedStateSchemas) {
            stateTagSet.add(stSchema.tag)
            for (const p of stSchema.properties) {
              stateProps.add(p)
            }
          }
          if (resolvedStateSchemas.length === 0) {
            for (const stateTag of stateTagSet) {
              const stSchema = taggedSchemasByTag.get(stateTag)
              if (stSchema) {
                for (const p of stSchema.properties) {
                  stateProps.add(p)
                }
              }
            }
          }
        }

        const eventTagSet = new Set<string>()
        const eventSchemasByTag = new Map<string, TaggedSchemaInfo>()
        const eventTypeText = eventParam ? eventParam.getType().getText() : ""
        if (eventParam) {
          const eventType = eventParam.getType()
          const constituents = eventType.isUnion() ? eventType.getUnionTypes() : [eventType]
          for (const part of constituents) {
            const tagProp = part.getProperty("_tag")
            if (tagProp) {
              const tagType = tagProp.getTypeAtLocation(eventParam)
              const rawTag = tagType.getText().replace(/^["'`]|["'`]$/g, "")
              if (rawTag && rawTag !== "string") {
                eventTagSet.add(rawTag)
              }
            }
          }
          for (const evSchema of resolveSchemasForParameter(eventParam)) {
            eventTagSet.add(evSchema.tag)
            eventSchemasByTag.set(evSchema.tag, evSchema)
          }
        }

        const isEventVariant = (tag: string): boolean => {
          if (eventTagSet.has(tag)) return true
          if (eventTypeText.includes(`"${tag}"`) || eventTypeText.includes(`'${tag}'`)) return true
          if (eventParam) {
            const typeNode = eventParam.getTypeNode()
            if (typeNode && new RegExp(`\\b${tag}\\b`).test(typeNode.getText())) return true
          }
          if (eventTagSet.size === 0 && !stateTagSet.has(tag)) {
            return true
          }
          return false
        }

        const handledTags = new Set<string>()
        const usedPropsPerTag = new Map<string, Set<string>>()

        for (const withCall of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = withCall.getExpression()
          if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "with") {
            continue
          }

          const args = withCall.getArguments()
          if (args.length < 2) continue

          const handler = args[args.length - 1]
          if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler))) {
            continue
          }

          const patternArgs = args.slice(0, args.length - 1)
          const matchedTagsInWith: Array<string> = []

          for (const patternArg of patternArgs) {
            for (const propAssign of patternArg.getDescendantsOfKind(
              SyntaxKind.PropertyAssignment,
            )) {
              if (propAssign.getName() === "_tag") {
                const init = propAssign.getInitializer()
                if (
                  init &&
                  (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))
                ) {
                  const tag = init.getLiteralText()
                  if (stateTagSet.has(tag) && !eventTagSet.has(tag)) {
                    continue
                  }
                  if (eventParam && eventTagSet.size > 0 && !isEventVariant(tag)) {
                    continue
                  }
                  if (taggedSchemasByTag.has(tag)) {
                    matchedTagsInWith.push(tag)
                    handledTags.add(tag)
                    if (!usedPropsPerTag.has(tag)) {
                      usedPropsPerTag.set(tag, new Set())
                    }
                  }
                }
              }
            }
          }

          if (matchedTagsInWith.length === 0) continue

          // Check parameter destructuring: ({ reservationId }) or ([state, { reservationId }])
          for (const param of handler.getParameters()) {
            for (const binding of param.getDescendantsOfKind(SyntaxKind.BindingElement)) {
              const name = binding.getName()
              for (const tag of matchedTagsInWith) {
                const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
                if (schema && schema.properties.includes(name)) {
                  usedPropsPerTag.get(tag)!.add(name)
                }
              }
            }
          }

          // Check property accesses in handler body: ev.reservationId
          for (const propAccess of handler.getDescendantsOfKind(
            SyntaxKind.PropertyAccessExpression,
          )) {
            const propName = propAccess.getName()
            for (const tag of matchedTagsInWith) {
              const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
              if (schema && schema.properties.includes(propName)) {
                usedPropsPerTag.get(tag)!.add(propName)
              }
            }
          }

          // Check identifiers in handler body (excluding PropertyAssignment property keys)
          for (const ident of handler.getDescendantsOfKind(SyntaxKind.Identifier)) {
            const parent = ident.getParent()
            if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === ident) {
              continue
            }
            const identText = ident.getText()
            for (const tag of matchedTagsInWith) {
              const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
              if (schema && schema.properties.includes(identText)) {
                usedPropsPerTag.get(tag)!.add(identText)
              }
            }
          }
        }

        // For each handled tag, verify all payload fields were used across reducer arms
        for (const tag of handledTags) {
          if (stateTagSet.has(tag) && !eventTagSet.has(tag)) continue
          if (eventParam && eventTagSet.size > 0 && !isEventVariant(tag)) continue

          const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
          if (!schema || schema.properties.length === 0) continue

          const usedProps = usedPropsPerTag.get(tag) ?? new Set()
          for (const prop of schema.properties) {
            if (prop === "_tag" || prop === "version") continue
            if (prop.endsWith("Id") && stateProps.has(prop)) {
              continue
            }
            if (!usedProps.has(prop)) {
              branchingViolations.push({
                rule: "dead-event-payload",
                message: `Event schema '${tag}' defines property '${prop}', but property '${prop}' is never read or applied in reducer '${enclosingSymbol}'. Superfluous event fields waste storage and mislead consumers.`,
                file: relPath,
                line: fnNode.getStartLineNumber(),
                enclosingSymbol,
              })
            }
          }
        }
      }
    }
  }

  if (session !== undefined) {
    for (const relPath of filesToReextract) {
      const f = fileMap.get(relPath)
      if (!f) continue
      const contentSha256 = currentShas.get(relPath) ?? sha256Hex(f.content)
      const declHash = currentDeclHashes.get(relPath) ?? computeDeclHash(f.content)
      const importedSpecs = currentSpecs.get(relPath) ?? []
      const fileQualPrefix = `${relPath}#`
      session.fileFragmentCache.set(relPath, {
        filePath: relPath,
        packageTag: f.packageTag,
        contentSha256,
        declHash,
        importedSpecs,
        fns: fns.filter((fn) => fn.file === relPath),
        services: services.filter((s) => s.file === relPath),
        layers: layers.filter((l) => l.file === relPath),
        errors: errors.filter((e) => e.file === relPath),
        schemas: schemas.filter((s) => s.file === relPath),
        requiresService: requiresService.filter((r) => r.callerQualname.startsWith(fileQualPrefix)),
        failsWith: failsWith.filter((fw) => fw.callerQualname.startsWith(fileQualPrefix)),
        providesService: providesService.filter((p) => p.layerQualname.startsWith(fileQualPrefix)),
        layerRequires: layerRequires.filter((lr) => lr.layerQualname.startsWith(fileQualPrefix)),
        branchingViolations: branchingViolations.filter((bv) => bv.file === relPath),
      })
    }

    fns.length = 0
    services.length = 0
    layers.length = 0
    errors.length = 0
    schemas.length = 0
    requiresService.length = 0
    failsWith.length = 0
    providesService.length = 0
    layerRequires.length = 0
    branchingViolations.length = 0
    referencedServices.clear()
    referencedErrors.clear()
    classNameToTagId.clear()

    const sortedRelPaths = Array.from(fileMap.keys()).sort((a, b) => a.localeCompare(b))
    const seenSchemaNames = new Set<string>()
    for (const relPath of sortedRelPaths) {
      const frag = session.fileFragmentCache.get(relPath)
      if (!frag) continue
      for (const s of frag.services ?? []) {
        classNameToTagId.set(s.name, s.tagId)
        classNameToTagId.set(s.tagId, s.tagId)
        services.push(s)
      }
      for (const e of frag.errors ?? []) {
        errors.push(e)
      }
      for (const sc of frag.schemas ?? []) {
        if (!seenSchemaNames.has(sc.schemaName)) {
          seenSchemaNames.add(sc.schemaName)
          schemas.push(sc)
        }
      }
    }

    for (const relPath of sortedRelPaths) {
      const frag = session.fileFragmentCache.get(relPath)
      if (!frag) continue
      fns.push(...frag.fns)
      layers.push(...frag.layers)
      for (const r of frag.requiresService) {
        const tagId = classNameToTagId.get(r.tagId) ?? r.tagId
        requiresService.push({ callerQualname: r.callerQualname, tagId })
        referencedServices.add(tagId)
      }
      for (const fw of frag.failsWith) {
        failsWith.push(fw)
        referencedErrors.add(fw.errorTag)
      }
      for (const p of frag.providesService) {
        const tagId = classNameToTagId.get(p.tagId) ?? p.tagId
        providesService.push({ layerQualname: p.layerQualname, tagId })
        referencedServices.add(tagId)
      }
      for (const lr of frag.layerRequires) {
        const tagId = classNameToTagId.get(lr.tagId) ?? lr.tagId
        layerRequires.push({ layerQualname: lr.layerQualname, tagId })
        referencedServices.add(tagId)
      }
      branchingViolations.push(...frag.branchingViolations)
    }

    if (
      filesToReextract.size > 0 &&
      (options?.overlays === undefined || Object.keys(options.overlays).length === 0)
    ) {
      saveFileGraphFragmentsToDisk(repoRoot, session)
    }
  }

  // 3. Auto-register referenced services
  const existingServiceTags = new Set(services.map((s) => s.tagId))
  for (const rawSvc of referencedServices) {
    const svc = classNameToTagId.get(rawSvc) ?? rawSvc
    if (!existingServiceTags.has(svc)) {
      existingServiceTags.add(svc)
      const isInfra =
        /^(Cloudflare|Alchemy|Drizzle|Provider|Binding|SqlClient|SqliteClient|SqlStorage)\b/.test(
          svc,
        )
      services.push({
        _tag: "ServiceTag",
        tagId: svc,
        name: svc,
        packageTag: isInfra ? "infra" : "service",
        file: "",
      })
    }
  }

  // 4. Auto-register referenced errors
  const existingErrors = new Set(errors.map((e) => e.errorTag))
  for (const err of referencedErrors) {
    if (!existingErrors.has(err)) {
      existingErrors.add(err)
      errors.push({
        _tag: "TaggedError",
        errorTag: err,
        file: "",
      })
    }
  }

  const inMemoryTests = effectiveFiles.filter((f) => f.filePath.includes(".test.ts"))
  if (inMemoryTests.length > 0) {
    const unasserted = checkUnassertedStateFieldsForInputs(
      effectiveFiles.filter((f) => !f.filePath.includes(".test.ts")),
      inMemoryTests.map((t) => ({ filePath: t.filePath, getContent: () => t.content })),
    )
    branchingViolations.push(...unasserted)
  }

  const baseGraph = buildHarnessGraph({
    fns,
    services,
    layers,
    errors,
    schemas,
    tests: [],
    patternDocs: options?.patternDocs ?? [],
    requiresService,
    failsWith,
    providesService,
    layerRequires,
    tracedCalls: [],
    exercisesSpans: [],
    branchingViolations,
  })

  return {
    ...baseGraph,
    unresolvedReferences: [],
  }
}

const checkUnassertedStateFieldsForInputs = (
  sourceInputs: ReadonlyArray<SourceFileInput>,
  testFiles: ReadonlyArray<{ filePath: string; getContent: () => string }>,
): ReadonlyArray<BranchingViolation> => {
  const violations: Array<BranchingViolation> = []

  for (const input of sourceInputs) {
    if (!/\bevolve\w*\b/.test(input.content)) continue

    const scope = getScopeDir(input.filePath)
    if (!scope) continue

    const scopeTestFiles = testFiles.filter(
      (relTestFile) =>
        getScopeDir(relTestFile.filePath) === scope &&
        !relTestFile.filePath.includes("/test/fixtures/"),
    )
    if (scopeTestFiles.length === 0) continue

    const sf = ts.createSourceFile(input.filePath, input.content, ts.ScriptTarget.Latest, true)
    const evolveFns: Array<ts.Node> = []

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && /^evolve/i.test(stmt.name.text)) {
        evolveFns.push(stmt)
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && /^evolve/i.test(decl.name.text) && decl.initializer) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
              evolveFns.push(decl.initializer)
            }
          }
        }
      }
    }

    const assignedFields = new Set<string>()
    const collectObjectProps = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const prop of node.properties) {
          let propName: string | null = null
          if (ts.isPropertyAssignment(prop) && prop.name) {
            propName = prop.name.getText(sf).replace(/^["'`]|["'`]$/g, "")
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            propName = prop.name.text
          }
          if (propName && propName !== "_tag" && !propName.endsWith("Id") && propName !== "id") {
            assignedFields.add(propName)
          }
        }
      }
      ts.forEachChild(node, collectObjectProps)
    }

    for (const fnNode of evolveFns) {
      collectObjectProps(fnNode)
    }

    if (assignedFields.size > 0) {
      let combinedTestContent = ""
      for (const t of scopeTestFiles) {
        combinedTestContent += " " + stripCommentsAndTestTitles(t.getContent())
      }

      for (const field of assignedFields) {
        const dotReadRegex = new RegExp("\\.\\s*" + field + "\\b")
        const assertionBlockRegex = new RegExp(
          `(?:expect|Equal\\.equals)\\s*\\([\\s\\S]{0,240}?\\b${field}\\b`,
        )
        if (
          !dotReadRegex.test(combinedTestContent) &&
          !assertionBlockRegex.test(combinedTestContent)
        ) {
          violations.push({
            rule: "unasserted-state-field",
            message: `State property '${field}' computed in reducer '${input.filePath}' is never read or asserted in any test file in scope '${scope}' — add fold assertions verifying '${field}' on folded states.`,
            file: input.filePath,
            line: 1,
            enclosingSymbol: `${input.filePath}#evolve`,
          })
        }
      }
    }
  }

  return violations
}

const findWorkspaceSrcFiles = (repoRoot: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const subDirs = ["libs", "apps"]

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === ".nx" ||
        e.name === "repos" ||
        e.name === ".git" ||
        e.name === ".harness"
      ) {
        continue
      }
      if (e.name === "test") {
        const fixturesDir = path.join(current, "test", "fixtures")
        if (fs.existsSync(fixturesDir)) {
          walk(fixturesDir)
        }
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (
        e.isFile() &&
        (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
        !e.name.endsWith(".d.ts") &&
        !e.name.endsWith(".config.ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".spec.ts")
      ) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (
          rel.includes("/src/") ||
          rel.includes("/test/fixtures/") ||
          rel.endsWith("alchemy.run.ts")
        ) {
          results.push(rel)
        }
      }
    }
  }

  for (const sub of subDirs) {
    walk(path.join(repoRoot, sub))
  }

  return results
}

const findWorkspaceTestFiles = (repoRoot: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const subDirs = ["libs", "apps"]

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === ".nx" ||
        e.name === "repos" ||
        e.name === ".git" ||
        e.name === ".harness"
      ) {
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && (e.name.endsWith(".test.ts") || e.name.endsWith(".spec.ts"))) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (rel.includes("/test/") || e.name.endsWith(".spec.ts")) {
          results.push(rel)
        }
      }
    }
  }

  for (const sub of subDirs) {
    walk(path.join(repoRoot, sub))
  }

  return results
}

const parseGovernanceDocFile = (
  relDocPath: string,
  content: string,
): AdrDocNode | EarsSpecNode | null => {
  const normalized = content.replace(/^\uFEFF/, "")
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match || match[1] === undefined) {
    return null
  }

  const yamlContent = match[1]
  const lines = yamlContent.split(/\r?\n/)

  const scalars = new Map<string, string>()
  const lists = new Map<string, Array<string>>()

  let currentListKey: string | null = null

  const stripQuotes = (val: string): string => {
    let trimmed = val.trim()
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim()
    }
    const hashIdx = trimmed.indexOf("#")
    if (hashIdx !== -1) {
      trimmed = trimmed.slice(0, hashIdx).trim()
    }
    return trimmed
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) {
        const list = lists.get(currentListKey)
        if (list) {
          list.push(item)
        }
      }
      continue
    }

    currentListKey = null

    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim()
      const rest = keyValMatch[2]!.trim()

      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        const items =
          inner.length === 0
            ? []
            : inner
                .split(",")
                .map(stripQuotes)
                .filter((s) => s.length > 0)
        lists.set(key, items)
      } else if (rest === "") {
        lists.set(key, [])
        currentListKey = key
      } else {
        scalars.set(key, stripQuotes(rest))
      }
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") {
    return null
  }

  let title = scalars.get("title")
  if (!title || title.trim() === "") {
    const titleMatch = normalized.match(/^#\s+(.+)$/m)
    title = titleMatch ? titleMatch[1]!.trim() : id
  }

  const rawStatus = scalars.get("status")
  const status: GovernanceDocStatus =
    rawStatus === "accepted" ||
    rawStatus === "proposed" ||
    rawStatus === "superseded" ||
    rawStatus === "deprecated"
      ? rawStatus
      : "proposed"

  const enforcedByFiles = lists.get("enforced_by") ?? []
  const referencedSpans = lists.get("spans") ?? []
  const referencedServices = lists.get("services") ?? []
  const referencedErrors = lists.get("errors") ?? []

  if (relDocPath.includes("/adr/")) {
    return {
      _tag: "AdrDoc",
      id,
      title,
      status,
      path: relDocPath,
      enforcedByFiles,
      referencedSpans,
      referencedServices,
      referencedErrors,
    }
  }

  if (relDocPath.includes("/specs/")) {
    return {
      _tag: "EarsSpec",
      id,
      title,
      status,
      path: relDocPath,
      enforcedByFiles,
      referencedSpans,
      referencedServices,
      referencedErrors,
    }
  }

  return null
}

export const loadWorkspaceGovernanceDocs = (
  repoRoot: string,
): ReadonlyArray<AdrDocNode | EarsSpecNode> => {
  const root = resolveRepoRoot(repoRoot)
  const candidateRelDirs: Array<string> = ["docs/adr", "docs/specs"]

  const listSubdirectories = (parentRel: string): ReadonlyArray<string> => {
    const parentPath = path.join(root, parentRel)
    if (!fs.existsSync(parentPath)) {
      return []
    }
    return fs
      .readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  const libScopes = listSubdirectories("libs")
  for (const scope of libScopes) {
    candidateRelDirs.push(`libs/${scope}/docs/adr`)
    candidateRelDirs.push(`libs/${scope}/docs/specs`)
  }

  const appNames = listSubdirectories("apps")
  for (const app of appNames) {
    candidateRelDirs.push(`apps/${app}/docs/adr`)
    candidateRelDirs.push(`apps/${app}/docs/specs`)
  }

  const results: Array<AdrDocNode | EarsSpecNode> = []

  for (const relDir of candidateRelDirs) {
    const fullDir = path.join(root, relDir)
    if (!fs.existsSync(fullDir)) {
      continue
    }

    const entries = fs.readdirSync(fullDir, { withFileTypes: true })
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "README.md" &&
          entry.name !== "TEMPLATE.md",
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const fullPath = path.join(root, relDocPath)
      const content = fs.readFileSync(fullPath, "utf-8")
      const parsed = parseGovernanceDocFile(relDocPath, content)
      if (parsed !== null) {
        results.push(parsed)
      }
    }
  }

  return results
}

export const stripCommentsAndTestTitles = (code: string): string => {
  let stripped = code.replace(/\/\*[\s\S]*?\*\//g, " ")
  stripped = stripped.replace(/\/\/[^\r\n]*/g, " ")
  stripped = stripped.replace(
    /\b(?:describe|it|test)(?:\.[a-zA-Z0-9_$]+)*\s*\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[\s\S]*?`)/g,
    (match) => match.replace(/(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[\s\S]*?`)$/, '""'),
  )
  stripped = stripped.replace(/`[\s\S]*?`/g, '""')
  return stripped
}

const splitTopLevelCommas = (input: string): Array<string> => {
  const items: Array<string> = []
  let depth = 0
  let current = ""
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === "(" || char === "[" || char === "{") {
      depth++
      current += char
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth--
      current += char
    } else if (char === "," && depth === 0) {
      items.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    items.push(current)
  }
  return items
}

const PRIMITIVE_SCALAR_REGEX =
  /^(?:(?:Schema|S)\.(?:String|Number|Boolean|Int|Natural|Positive|Negative|NonNegative|NonPositive|NonEmptyString)(?:\.[A-Za-z0-9_($. )]+)*|PositiveInt|NonEmptyString|StreamVersion|fc\.(?:integer|nat|string|boolean|float|double)\s*\([^)]*\))$/

const isAllPrimitiveArbitraryBlock = (rawBlock: string): boolean => {
  const block = rawBlock.trim()
  if (block.startsWith("[") && block.endsWith("]")) {
    const interior = block.slice(1, -1)
    const rawItems = splitTopLevelCommas(interior)
    const items = rawItems.map((s) => s.trim()).filter((s) => s.length > 0)
    if (items.length === 0) return true
    return items.every((item) => PRIMITIVE_SCALAR_REGEX.test(item))
  }
  if (block.startsWith("{") && block.endsWith("}")) {
    const interior = block.slice(1, -1)
    const rawItems = splitTopLevelCommas(interior)
    const items = rawItems.map((s) => s.trim()).filter((s) => s.length > 0)
    if (items.length === 0) return true
    return items.every((entry) => {
      const parts = entry.split(":")
      if (parts.length < 2) return false
      const val = parts.slice(1).join(":").trim()
      return val.length > 0 && PRIMITIVE_SCALAR_REGEX.test(val)
    })
  }
  return false
}

const getScopeDir = (relPath: string): string | null => {
  const norm = relPath.replace(/\\/g, "/")
  const match = norm.match(/^(libs\/[^/]+|apps\/[^/]+)/)
  return match ? match[1]! : null
}

const packageJsonCache = new Map<string, { name?: string | undefined; dir: string }>()

const findPackageForRelFile = (
  root: string,
  relFile: string,
): { name?: string | undefined; dir: string } | null => {
  let curr = path.dirname(path.join(root, relFile))
  const rootResolved = path.resolve(root)
  while (curr.startsWith(rootResolved)) {
    if (packageJsonCache.has(curr)) {
      return packageJsonCache.get(curr)!
    }
    const pkgPath = path.join(curr, "package.json")
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const opt = decodePackageJson(content)
      const relDir = path.relative(rootResolved, curr).replace(/\\/g, "/")
      const entry = {
        name: match(opt)
          .with({ _tag: "Some" }, ({ value }) => value.name)
          .with({ _tag: "None" }, () => undefined)
          .exhaustive(),
        dir: relDir,
      }
      packageJsonCache.set(curr, entry)
      return entry
    }
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return null
}

const testImportsFn = (
  root: string,
  testRelPath: string,
  testContent: string,
  fnFile: string,
): boolean => {
  const fnPkg = findPackageForRelFile(root, fnFile)
  if (fnPkg?.name) {
    if (
      testContent.includes(`"${fnPkg.name}"`) ||
      testContent.includes(`'${fnPkg.name}'`) ||
      testContent.includes(`"${fnPkg.name}/`) ||
      testContent.includes(`'${fnPkg.name}/`)
    ) {
      return true
    }
  }

  const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/g
  const testFullDir = path.dirname(path.join(root, testRelPath))
  const fnFullFile = path.join(root, fnFile)
  const fnFullDir = path.dirname(fnFullFile)
  const fnPkgFullDir = fnPkg ? path.join(root, fnPkg.dir) : null

  for (const match of testContent.matchAll(importRegex)) {
    const spec = match[1]
    if (!spec) continue
    if (spec.startsWith(".")) {
      const resolved = path.resolve(testFullDir, spec)
      if (
        resolved === fnFullFile ||
        resolved === fnFullFile.replace(/\.tsx?$/, ".js") ||
        resolved.replace(/\.js$/, "") === fnFullFile.replace(/\.tsx?$/, "") ||
        resolved.startsWith(fnFullDir) ||
        (fnPkgFullDir && resolved.startsWith(fnPkgFullDir))
      ) {
        return true
      }
    } else if (fnPkg?.dir && spec.includes(fnPkg.dir)) {
      return true
    }
  }

  return false
}

export interface ExtractTypeGraphOptions {
  readonly repoRoot: string
  readonly overlays?: Readonly<Record<string, string>> | undefined
  readonly previousProgram?: ts.Program | undefined
  readonly session?: TypeScriptProgramSession | undefined
}

const resolveTsLibDir = (root: string): string | undefined => {
  const candidates = [
    path.join(
      root,
      "node_modules/.pnpm/@typescript+typescript-linux-x64@7.0.2/node_modules/@typescript/typescript-linux-x64/lib",
    ),
    path.join(root, "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib"),
    path.join(root, "node_modules/typescript/lib"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "lib.es2023.full.d.ts"))) return c
  }
  const pnpmDir = path.join(root, "node_modules/.pnpm")
  if (fs.existsSync(pnpmDir)) {
    const entries = Effect.runSync(
      Effect.try({
        try: () => fs.readdirSync(pnpmDir),
        catch: () => [] as Array<string>,
      }),
    )
    for (const entry of entries) {
      if (entry.startsWith("typescript@") || entry.startsWith("@typescript+typescript")) {
        const potential = path.join(
          pnpmDir,
          entry,
          "node_modules",
          entry.startsWith("@typescript")
            ? "@typescript/typescript-linux-x64/lib"
            : "typescript/lib",
        )
        if (fs.existsSync(path.join(potential, "lib.es2023.full.d.ts"))) return potential
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
  const normalizedOverlays = new Map<string, string>()
  const overlayDirectories = new Set<string>()
  for (const [k, v] of Object.entries(overlays)) {
    const abs = path.resolve(root, k).replace(/\\/g, "/")
    const rel = path.relative(root, abs).replace(/\\/g, "/")
    normalizedOverlays.set(abs, v)
    normalizedOverlays.set(rel, v)
    let d = path.dirname(abs)
    while (d && d !== path.dirname(d)) {
      overlayDirectories.add(d)
      d = path.dirname(d)
    }
  }

  const findOverlay = (fileName: string): string | undefined => {
    const norm = fileName.replace(/\\/g, "/")
    const direct = normalizedOverlays.get(norm)
    if (direct !== undefined) return direct
    const abs = path.resolve(root, fileName).replace(/\\/g, "/")
    const byAbs = normalizedOverlays.get(abs)
    if (byAbs !== undefined) return byAbs
    const rel = path.relative(root, abs).replace(/\\/g, "/")
    return normalizedOverlays.get(rel)
  }

  const tsLibDir = resolveTsLibDir(root)
  const baseHost = ts.createCompilerHost(options, true)
  return {
    ...baseHost,
    ...(tsLibDir !== undefined ? { getDefaultLibLocation: () => tsLibDir } : {}),
    directoryExists: (dirName) => {
      const norm = dirName.replace(/\\/g, "/")
      const abs = path.resolve(root, norm).replace(/\\/g, "/")
      return (
        overlayDirectories.has(abs) ||
        overlayDirectories.has(norm) ||
        (baseHost.directoryExists?.(dirName) ?? false)
      )
    },
    fileExists: (fileName) =>
      findOverlay(fileName) !== undefined ||
      (tsLibDir !== undefined &&
        path.basename(fileName).startsWith("lib.") &&
        fs.existsSync(path.join(tsLibDir, path.basename(fileName)))) ||
      baseHost.fileExists(fileName),
    readFile: (fileName) => {
      const ov = findOverlay(fileName)
      if (ov !== undefined) return ov
      if (
        tsLibDir !== undefined &&
        path.basename(fileName).startsWith("lib.") &&
        fs.existsSync(path.join(tsLibDir, path.basename(fileName)))
      ) {
        return fs.readFileSync(path.join(tsLibDir, path.basename(fileName)), "utf8")
      }
      return baseHost.readFile(fileName)
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const overlayContent = findOverlay(fileName)
      if (overlayContent !== undefined) {
        return ts.createSourceFile(fileName, overlayContent, languageVersion, true)
      }
      if (
        tsLibDir !== undefined &&
        path.basename(fileName).startsWith("lib.") &&
        fs.existsSync(path.join(tsLibDir, path.basename(fileName)))
      ) {
        return ts.createSourceFile(
          fileName,
          fs.readFileSync(path.join(tsLibDir, path.basename(fileName)), "utf8"),
          languageVersion,
          true,
        )
      }
      const existing = oldProgram?.getSourceFile(fileName)
      if (existing !== undefined && !shouldCreateNewSourceFile) {
        return existing
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

export const evaluateOverlayDiagnostics = (
  repoRoot: string,
  overlays: Readonly<Record<string, string>>,
  session?: TypeScriptProgramSession,
): ReadonlyArray<OverlayDiagnosticItem> => {
  const root = resolveRepoRoot(repoRoot)
  const _activeSession = session ?? getOrCreateWarmProgramSession(root)
  const overlayEntries = Object.entries(overlays)
  if (overlayEntries.length === 0) {
    return []
  }

  const graphNodeModules = path.join(root, "libs/harness/graph/node_modules")
  const dynamicPaths: Record<string, Array<string>> = {
    effect: [
      path.join(graphNodeModules, "effect/dist/index.d.ts"),
      path.join(graphNodeModules, "effect"),
    ],
    "effect/*": [
      path.join(graphNodeModules, "effect/dist/*.d.ts"),
      path.join(graphNodeModules, "effect/*"),
    ],
    "ts-pattern": [path.join(root, "node_modules/ts-pattern")],
    "@harness/gates": [path.join(root, "libs/harness/gates/src/index.ts")],
    "@harness/graph": [path.join(root, "libs/harness/graph/src/index.ts")],
    "@harness/decision": [path.join(root, "libs/harness/decision/src/index.ts")],
    "@harness/ingest": [path.join(root, "libs/harness/ingest/src/index.ts")],
  }
  const libsDir = path.join(root, "libs")
  if (fs.existsSync(libsDir)) {
    for (const scopeEntry of fs.readdirSync(libsDir, { withFileTypes: true })) {
      if (!scopeEntry.isDirectory() || scopeEntry.name === "harness") continue
      const scopeDir = path.join(libsDir, scopeEntry.name)
      for (const tier of ["contract", "service", "domain", "core", "infra"]) {
        const entryFile = path.join(scopeDir, tier, "src", "index.ts")
        dynamicPaths[`@harness/${scopeEntry.name}-${tier}`] = [entryFile]
        dynamicPaths[`@effect-${scopeEntry.name}/${tier}`] = [entryFile]
        dynamicPaths[`@${scopeEntry.name}/${tier}`] = [entryFile]
      }
    }
  }
  for (const [k] of overlayEntries) {
    const rel = (path.isAbsolute(k) ? path.relative(root, k) : k).replace(/\\/g, "/")
    const m = rel.match(/^libs\/([^/]+)\/(contract|service|domain|core|infra)\/src\/index\.ts$/)
    if (m && m[1] && m[2]) {
      const scopeName = m[1]
      const tier = m[2]
      const entryAbs = path.resolve(root, rel)
      dynamicPaths[`@harness/${scopeName}-${tier}`] = [entryAbs]
      dynamicPaths[`@effect-${scopeName}/${tier}`] = [entryAbs]
      dynamicPaths[`@${scopeName}/${tier}`] = [entryAbs]
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

  const host = createOverlayCompilerHost(compilerOptions, overlays, undefined, root)
  const rootNames = overlayEntries
    .map(([k]) => path.resolve(root, k).replace(/\\/g, "/"))
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts"))

  if (rootNames.length === 0) {
    return []
  }

  const program = ts.createProgram(rootNames, compilerOptions, host, undefined)

  const diagnostics: Array<OverlayDiagnosticItem> = []
  for (const fileName of rootNames) {
    const sf = program.getSourceFile(fileName)
    if (sf === undefined) continue
    const allDiags = [
      ...program.getSyntacticDiagnostics(sf),
      ...program.getSemanticDiagnostics(sf),
    ]
    for (const d of allDiags) {
      // Ignore unresolved module errors for synthetic standalone snippets without disk node_modules
      if (d.code === 2307) {
        const msgText = ts.flattenDiagnosticMessageText(d.messageText, "\n")
        if (
          msgText.includes("@effect/sql-sqlite-do") ||
          msgText.includes("@effect/vitest")
        ) {
          continue
        }
      }
      const pos =
        d.file !== undefined && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start)
          : { line: 0, character: 0 }
      const rel = path.relative(root, fileName).replace(/\\/g, "/")
      diagnostics.push({
        file: rel.startsWith("..") ? fileName : rel,
        line: pos.line + 1,
        column: pos.character + 1,
        code: `TS${d.code}`,
        severity: d.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      })
    }
  }
  return diagnostics
}

export const extractTypeGraph = Effect.fn("TypeExtractor.extractWorkspace")(function* (
  options: ExtractTypeGraphOptions,
): Effect.fn.Return<HarnessGraph> {
  return yield* extractWorkspaceTypeAwareGraph(options.repoRoot, options)
})

export const extractWorkspaceTypeAwareGraph = (
  repoRoot: string,
  options?: Omit<ExtractTypeGraphOptions, "repoRoot">,
): Effect.Effect<HarnessGraph> =>
  Effect.sync(() => {
    const root = resolveRepoRoot(repoRoot)
    const session = options?.session ?? getOrCreateWarmProgramSession(root)
    if (options?.previousProgram !== undefined) {
      session.oldProgram = options.previousProgram
    }

    const normalizedOverlays = new Map<string, string>()
    if (options?.overlays !== undefined) {
      for (const [k, v] of Object.entries(options.overlays)) {
        const rel = (path.isAbsolute(k) ? path.relative(root, k) : k).replace(/\\/g, "/")
        normalizedOverlays.set(rel, v)
      }
    }

    const relFileSet = new Set<string>(findWorkspaceSrcFiles(root))
    const testFileSet = new Set<string>(findWorkspaceTestFiles(root))
    for (const overlayRel of normalizedOverlays.keys()) {
      if (
        (overlayRel.endsWith(".test.ts") ||
          overlayRel.endsWith(".spec.ts") ||
          overlayRel.includes("/test/")) &&
        !overlayRel.endsWith(".d.ts")
      ) {
        testFileSet.add(overlayRel)
      } else if (
        (overlayRel.endsWith(".ts") || overlayRel.endsWith(".tsx")) &&
        !overlayRel.endsWith(".d.ts")
      ) {
        relFileSet.add(overlayRel)
      }
    }
    const relFiles = Array.from(relFileSet).sort()
    const inputs: Array<SourceFileInput> = []
    const inputShaMap = new Map<string, string>()

    for (const file of relFiles) {
      const fullPath = path.join(root, file)
      const overlayContent = normalizedOverlays.get(file)
      if (overlayContent === undefined && !fs.existsSync(fullPath)) continue
      const content = overlayContent ?? fs.readFileSync(fullPath, "utf-8")
      const packageTag = resolvePackageTag(root, file)
      inputShaMap.set(file, sha256Hex(`${packageTag}\0${content}`))
      inputs.push({
        filePath: file,
        content,
        packageTag,
      })
    }

    const testFiles = Array.from(testFileSet).sort()
    const testContentMap = new Map<string, string>()
    const testShaMap = new Map<string, string>()
    for (const relTestFile of testFiles) {
      const fullPath = path.join(root, relTestFile)
      const overlayContent = normalizedOverlays.get(relTestFile)
      if (overlayContent === undefined && !fs.existsSync(fullPath)) continue
      const content = overlayContent ?? fs.readFileSync(fullPath, "utf-8")
      testContentMap.set(relTestFile, content)
      testShaMap.set(relTestFile, sha256Hex(content))
    }

    const governanceDocs = loadWorkspaceGovernanceDocs(root)
    const govShaMap = new Map<string, string>()
    for (const doc of governanceDocs) {
      govShaMap.set(
        doc.path,
        sha256Hex(
          `${doc.id}:${doc.status}:${(doc.referencedSpans ?? []).join(",")}:${(doc.referencedServices ?? []).join(",")}:${(doc.referencedErrors ?? []).join(",")}`,
        ),
      )
    }

    const patternDocs = loadPatternDocs(root)
    const patternShaMap = new Map<string, string>()
    for (const pDoc of patternDocs) {
      patternShaMap.set(
        pDoc.path,
        sha256Hex(
          `${pDoc.slug}:${pDoc.summary}:${(pDoc.coveredSpans ?? []).join(",")}:${(pDoc.coveredTags ?? []).join(",")}`,
        ),
      )
    }

    const prevSnap = session.lastWorkspaceSnapshot
    let testsGovPatternsMatch =
      prevSnap !== undefined &&
      prevSnap.testShaMap.size === testShaMap.size &&
      prevSnap.govShaMap.size === govShaMap.size &&
      prevSnap.patternShaMap.size === patternShaMap.size

    if (testsGovPatternsMatch && prevSnap !== undefined) {
      for (const [k, sha] of testShaMap.entries()) {
        if (prevSnap.testShaMap.get(k) !== sha) {
          testsGovPatternsMatch = false
          break
        }
      }
      if (testsGovPatternsMatch) {
        for (const [k, sha] of govShaMap.entries()) {
          if (prevSnap.govShaMap.get(k) !== sha) {
            testsGovPatternsMatch = false
            break
          }
        }
      }
      if (testsGovPatternsMatch) {
        for (const [k, sha] of patternShaMap.entries()) {
          if (prevSnap.patternShaMap.get(k) !== sha) {
            testsGovPatternsMatch = false
            break
          }
        }
      }
    }

    if (
      testsGovPatternsMatch &&
      prevSnap !== undefined &&
      prevSnap.inputShaMap.size === inputShaMap.size
    ) {
      let inputsMatch = true
      for (const [k, sha] of inputShaMap.entries()) {
        if (prevSnap.inputShaMap.get(k) !== sha) {
          inputsMatch = false
          break
        }
      }
      if (inputsMatch) {
        session.warmHitCount += inputShaMap.size
        session.lastReextractedFiles = []
        return prevSnap.graph
      }
    }

    const baseGraph = extractTypeAwareGraphFromSource(inputs, {
      repoRoot: root,
      patternDocs,
      session,
      ...(options?.overlays !== undefined ? { overlays: options.overlays } : {}),
      ...(options?.previousProgram !== undefined
        ? { previousProgram: options.previousProgram }
        : {}),
    })

    const baseTopologyHash = sha256Hex(
      JSON.stringify(
        Array.from(session.fileFragmentCache.keys())
          .sort((a, b) => a.localeCompare(b))
          .map((k) => {
            const frag = session.fileFragmentCache.get(k)
            return frag === undefined
              ? null
              : {
                  filePath: frag.filePath,
                  packageTag: frag.packageTag,
                  fns: frag.fns,
                  services: frag.services,
                  layers: frag.layers,
                  errors: frag.errors,
                  schemas: frag.schemas,
                  requiresService: frag.requiresService,
                  failsWith: frag.failsWith,
                  providesService: frag.providesService,
                  layerRequires: frag.layerRequires,
                }
          }),
      ),
    )

    const domainContractInputHash = sha256Hex(
      inputs
        .filter((inp) => inp.packageTag === "contract" || inp.packageTag === "domain")
        .map((inp) => `${inp.filePath}:${inputShaMap.get(inp.filePath) ?? ""}`)
        .join("|"),
    )

    if (
      testsGovPatternsMatch &&
      prevSnap !== undefined &&
      prevSnap.baseTopologyHash === baseTopologyHash &&
      prevSnap.domainContractInputHash === domainContractInputHash &&
      prevSnap.unassertedStateViolations !== undefined &&
      prevSnap.nodeSqliteTestViolations !== undefined
    ) {
      const fastGraph: HarnessGraph = {
        graph: prevSnap.graph.graph,
        nodeIndexByKey: prevSnap.graph.nodeIndexByKey,
        branchingViolations: [
          ...(baseGraph.branchingViolations ?? []),
          ...prevSnap.unassertedStateViolations,
          ...prevSnap.nodeSqliteTestViolations,
        ],
        unresolvedReferences: prevSnap.graph.unresolvedReferences,
      }
      session.lastWorkspaceSnapshot = {
        inputShaMap,
        testShaMap,
        govShaMap,
        patternShaMap,
        baseTopologyHash,
        domainContractInputHash,
        unassertedStateViolations: prevSnap.unassertedStateViolations,
        nodeSqliteTestViolations: prevSnap.nodeSqliteTestViolations,
        graph: fastGraph,
      }
      return fastGraph
    }

    const effectFns: Array<EffectFnNode> = []
    const serviceTags: Array<ServiceTagNode> = []
    const taggedErrors: Array<TaggedErrorNode> = []
    for (const [, node] of Graph.nodes(baseGraph.graph)) {
      if (node._tag === "EffectFn") {
        effectFns.push(node)
      } else if (node._tag === "ServiceTag") {
        serviceTags.push(node)
      } else if (node._tag === "TaggedError") {
        taggedErrors.push(node)
      }
    }

    const updatedNodeIndexByKey = new Map<string, Graph.NodeIndex>(baseGraph.nodeIndexByKey)

    const deciderAliasesByFnName = new Map<string, Set<string>>()
    const deciderRegex =
      /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:Decider\.)?make\s*(?:<[\s\S]*?>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g
    for (const input of inputs) {
      const deciderMatches = input.content.matchAll(deciderRegex)
      for (const m of deciderMatches) {
        const deciderVarName = m[1]
        const body = m[2]
        if (!deciderVarName || !body) continue

        const decideMatch = body.match(/decide\s*:\s*([A-Za-z0-9_$]+)/)
        const decideFn = decideMatch ? decideMatch[1] : /\bdecide\b/.test(body) ? "decide" : null

        const evolveMatch = body.match(/evolve\s*:\s*([A-Za-z0-9_$]+)/)
        const evolveFn = evolveMatch ? evolveMatch[1] : /\bevolve\b/.test(body) ? "evolve" : null

        for (const fn of [decideFn, evolveFn]) {
          if (!fn) continue
          let set = deciderAliasesByFnName.get(fn)
          if (!set) {
            set = new Set<string>()
            deciderAliasesByFnName.set(fn, set)
          }
          set.add(deciderVarName)
        }
      }
    }

    // Rule E: unasserted-state-field check
    const testFilesWithContent = testFiles.map((relTestFile) => ({
      filePath: relTestFile,
      getContent: () => testContentMap.get(relTestFile) ?? "",
    }))
    const unassertedStateViolations = checkUnassertedStateFieldsForInputs(
      inputs,
      testFilesWithContent,
    )
    const nodeSqliteTestViolations: Array<BranchingViolation> = []
    for (const relTestFile of testFiles) {
      if (relTestFile.startsWith("libs/harness/") || relTestFile.startsWith("apps/harness-")) {
        continue
      }
      if (!/(?:^libs\/[^/]+\/infra\/|^apps\/)/.test(relTestFile)) {
        continue
      }
      const content = testContentMap.get(relTestFile)
      if (content === undefined) continue
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ""
        const importMatch = line.match(
          /\b(?:import\s*\(\s*|require\s*\(\s*|(?:import|from)\s+)["'](node:sqlite|sqlite|better-sqlite3)["']/,
        )
        if (importMatch && importMatch[1]) {
          nodeSqliteTestViolations.push({
            rule: "node-sqlite-in-infra",
            message: `Do not import '${importMatch[1]}' in '${relTestFile}' — Cloudflare Durable Object SQLite and D1 tests in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
            file: relTestFile,
            line: i + 1,
            enclosingSymbol: relTestFile,
          })
        }
      }
    }
    const unresolvedReferences: Array<UnresolvedGraphReference> = []

    const augmentedGraph = Graph.mutate<HarnessNode, HarnessEdge>(baseGraph.graph, (mutable) => {
      for (const relTestFile of testFiles) {
        const content = testContentMap.get(relTestFile)
        if (content === undefined) continue
        if (
          !content.includes("describe(") &&
          !content.includes("it(") &&
          !content.includes("it.effect(") &&
          !content.includes("it.prop(") &&
          !content.includes("it.effect.prop(")
        ) {
          continue
        }

        const hasPropTest =
          /\b(?:it|test)(?:\.effect)?\.prop\s*\(/.test(content) || /\bfc\.assert\s*\(/.test(content)

        const strippedContent = stripCommentsAndTestTitles(content)

        let hasNonPrimitiveArbitrary: boolean | undefined = undefined
        if (hasPropTest) {
          const propCallRegex =
            /\b(?:it|test)(?:\.effect)?\.prop\s*\(\s*(?:""|''|``)\s*,\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*,/g
          const matches = [...strippedContent.matchAll(propCallRegex)]
          hasNonPrimitiveArbitrary =
            matches.length > 0 && matches.every((m) => !isAllPrimitiveArbitraryBlock(m[1]!))
        }

        const testNode: VitestCaseNode = {
          _tag: "VitestCase",
          testId: `${relTestFile}::suite`,
          testFile: relTestFile,
          testName: relTestFile,
          lastTreeHash: "workspace",
          isPropertyTest: hasPropTest,
          ...(hasNonPrimitiveArbitrary !== undefined ? { hasNonPrimitiveArbitrary } : {}),
        }
        const testKey = getNodeKey(testNode)
        const testIdx = Graph.addNode(mutable, testNode)
        updatedNodeIndexByKey.set(testKey, testIdx)

        const usesTestTracer = strippedContent.includes("runWithTestTracer")

        // Single-pass O(|T|) token extraction for O(1) EffectFn lookup
        const identTokens = new Set<string>()
        for (const m of strippedContent.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
          if (m[1]) identTokens.add(m[1])
        }
        const callOrArgTokens = new Set<string>()
        for (const m of strippedContent.matchAll(
          /(?:\b|\$)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\(|\)|,)/g,
        )) {
          if (m[1]) callOrArgTokens.add(m[1])
        }
        const dottedCallTokens = new Set<string>()
        for (const m of strippedContent.matchAll(
          /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\s*\(/g,
        )) {
          if (m[1]) dottedCallTokens.add(m[1])
        }

        const testScope = getScopeDir(relTestFile)
        const importCheckedByFnFile = new Map<string, boolean>()

        for (const fnNode of effectFns) {
          const fnScope = fnNode.file ? getScopeDir(fnNode.file) : null
          if (testScope && fnScope && testScope !== fnScope && fnNode.file) {
            let importsFn = importCheckedByFnFile.get(fnNode.file)
            if (importsFn === undefined) {
              importsFn = testImportsFn(root, relTestFile, content, fnNode.file)
              importCheckedByFnFile.set(fnNode.file, importsFn)
            }
            if (!importsFn) {
              continue
            }
          }
          const fnName = fnNode.qualname.split("#")[1] ?? ""

          const fnCallMatches = fnName.length > 0 && callOrArgTokens.has(fnName)
          const spanCallMatches =
            fnNode.spanName.length > 0 &&
            (dottedCallTokens.has(fnNode.spanName) || callOrArgTokens.has(fnNode.spanName))

          const testTracerMatches =
            usesTestTracer &&
            ((fnName.length > 0 && strippedContent.includes(fnName)) ||
              (fnNode.spanName.length > 0 && strippedContent.includes(fnNode.spanName)))

          const deciderAliases = deciderAliasesByFnName.get(fnName)
          let deciderAliasMatches = false
          if (deciderAliases) {
            for (const alias of deciderAliases) {
              if (identTokens.has(alias)) {
                deciderAliasMatches = true
                break
              }
            }
          }

          const matches =
            fnCallMatches || spanCallMatches || testTracerMatches || deciderAliasMatches

          if (matches) {
            const fnKey = getNodeKey(fnNode)
            const calleeIdx = updatedNodeIndexByKey.get(fnKey)
            if (calleeIdx !== undefined) {
              const relId = RelationId.make(
                `TraceabilityTuple:exercise:${testNode.testId}->${fnNode.qualname}`,
              )
              if (!updatedNodeIndexByKey.has(relId)) {
                const relNode: TraceabilityTupleRelation = {
                  _tag: "TraceabilityTuple",
                  relationId: relId,
                  targetSymbolQualname: fnNode.qualname,
                  verifyingTestQualnames: [testNode.testId],
                }
                const relIdx = Graph.addNode(mutable, relNode)
                updatedNodeIndexByKey.set(relId, relIdx)
                Graph.addEdge(mutable, relIdx, testIdx, {
                  _tag: "PlaysRole",
                  relationId: relId,
                  entityKey: NodeKey.make(testKey),
                  role: RoleName.make("exercising-test"),
                  archimateRelation: "Triggering",
                })
                Graph.addEdge(mutable, relIdx, calleeIdx, {
                  _tag: "PlaysRole",
                  relationId: relId,
                  entityKey: NodeKey.make(fnKey),
                  role: RoleName.make("exercised-span"),
                  archimateRelation: "Realization",
                })
              }
            }
          }
        }
      }

      for (const docNode of governanceDocs) {
        const docKey = getNodeKey(docNode)
        const docIdx = Graph.addNode(mutable, docNode)
        updatedNodeIndexByKey.set(docKey, docIdx)

        const kindPrefix = docNode._tag === "AdrDoc" ? "governs" : "specifies"
        const addGovernanceTraceability = (targetKey: string, targetIdx: Graph.NodeIndex) => {
          const docRole = docNode._tag === "AdrDoc" ? "governing-adr" : "specifying-ears"
          const docArchimate =
            docNode._tag === "AdrDoc" ? ("Influence" as const) : ("Realization" as const)
          const relId = RelationId.make(
            `TraceabilityTuple:${kindPrefix}:${docNode.id}->${targetKey}`,
          )
          if (!updatedNodeIndexByKey.has(relId)) {
            const relNode: TraceabilityTupleRelation = {
              _tag: "TraceabilityTuple",
              relationId: relId,
              ...(docNode._tag === "AdrDoc" ? { adrId: docNode.id } : { earsSpecId: docNode.id }),
              targetSymbolQualname: targetKey,
              verifyingTestQualnames: [],
            }
            const relIdx = Graph.addNode(mutable, relNode)
            updatedNodeIndexByKey.set(relId, relIdx)
            Graph.addEdge(mutable, relIdx, docIdx, {
              _tag: "PlaysRole",
              relationId: relId,
              entityKey: NodeKey.make(docKey),
              role: RoleName.make(docRole),
              archimateRelation: docArchimate,
            })
            Graph.addEdge(mutable, relIdx, targetIdx, {
              _tag: "PlaysRole",
              relationId: relId,
              entityKey: NodeKey.make(targetKey),
              role: RoleName.make("realizing-symbol"),
              archimateRelation: "Realization",
            })
          }
        }

        // 1. Spans -> EffectFn
        const addedFnTargets = new Set<string>()
        for (const span of docNode.referencedSpans ?? []) {
          let found = false
          for (const fnNode of effectFns) {
            if (
              fnNode.spanName === span ||
              fnNode.qualname === span ||
              fnNode.qualname.endsWith(`#${span}`)
            ) {
              found = true
              const targetKey = getNodeKey(fnNode)
              if (addedFnTargets.has(targetKey)) continue
              addedFnTargets.add(targetKey)
              const targetIdx = updatedNodeIndexByKey.get(targetKey)
              if (targetIdx !== undefined) {
                addGovernanceTraceability(targetKey, targetIdx)
              }
            }
          }
          if (!found) {
            unresolvedReferences.push({
              relationId: `TraceabilityTuple:${kindPrefix}:${docNode.id}->${span}`,
              role: "realizing-symbol",
              targetKey: span,
              file: docNode.path,
            })
          }
        }

        // 2. Services -> ServiceTag
        const addedSvcTargets = new Set<string>()
        for (const svc of docNode.referencedServices ?? []) {
          let found = false
          for (const sNode of serviceTags) {
            if (sNode.tagId === svc || sNode.name === svc || sNode.tagId.endsWith(`#${svc}`)) {
              found = true
              const targetKey = getNodeKey(sNode)
              if (addedSvcTargets.has(targetKey)) continue
              addedSvcTargets.add(targetKey)
              const targetIdx = updatedNodeIndexByKey.get(targetKey)
              if (targetIdx !== undefined) {
                addGovernanceTraceability(targetKey, targetIdx)
              }
            }
          }
          if (!found) {
            unresolvedReferences.push({
              relationId: `TraceabilityTuple:${kindPrefix}:${docNode.id}->${svc}`,
              role: "realizing-symbol",
              targetKey: svc,
              file: docNode.path,
            })
          }
        }

        // 3. Errors -> TaggedError
        const addedErrTargets = new Set<string>()
        for (const err of docNode.referencedErrors ?? []) {
          let found = false
          for (const eNode of taggedErrors) {
            if (eNode.errorTag === err) {
              found = true
              const targetKey = getNodeKey(eNode)
              if (addedErrTargets.has(targetKey)) continue
              addedErrTargets.add(targetKey)
              const targetIdx = updatedNodeIndexByKey.get(targetKey)
              if (targetIdx !== undefined) {
                addGovernanceTraceability(targetKey, targetIdx)
              }
            }
          }
          if (!found) {
            unresolvedReferences.push({
              relationId: `TraceabilityTuple:${kindPrefix}:${docNode.id}->${err}`,
              role: "realizing-symbol",
              targetKey: err,
              file: docNode.path,
            })
          }
        }
      }
    })

    const combinedViolations = [
      ...(baseGraph.branchingViolations ?? []),
      ...unassertedStateViolations,
      ...nodeSqliteTestViolations,
    ]

    const resultGraph: HarnessGraph = {
      graph: augmentedGraph,
      nodeIndexByKey: updatedNodeIndexByKey,
      branchingViolations: combinedViolations,
      unresolvedReferences: [...(baseGraph.unresolvedReferences ?? []), ...unresolvedReferences],
    }

    session.lastWorkspaceSnapshot = {
      inputShaMap,
      testShaMap,
      govShaMap,
      patternShaMap,
      baseTopologyHash,
      domainContractInputHash,
      unassertedStateViolations,
      nodeSqliteTestViolations,
      graph: resultGraph,
    }

    return resultGraph
  })
