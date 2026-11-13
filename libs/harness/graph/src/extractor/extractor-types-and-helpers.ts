import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import { match } from "ts-pattern"
import {
  Node,
  type ParenthesizedTypeNode,
  SyntaxKind,
  ts,
  type Type,
  type TypeNode,
  type UnionTypeNode,
} from "ts-morph"
import { PackageTag } from "../model.js"

export interface TypeExtractorViolation {
  readonly rule:
    | "discriminant-branching" | "non-exhaustive-union-match" | "schema-boolean-state"
    | "dead-event-payload" | "terminal-state-unhandled" | "fallback-json-equality"
    | "vacuous-error-assertion" | "unscoped-effect-run" | "unbranded-schema-field"
    | "handwritten-tagged-union" | "untraced-decider" | "missing-aggregate-id-guard"
    | "unasserted-state-field" | "unsafe-type-cast" | "unbranded-contract-schema"
    | "unbranded-primitive-boundary" | "node-sqlite-in-infra" | "domain-effect-ignore"
  readonly message: string
  readonly path: ReadonlyArray<string>
  readonly file?: string | undefined
  readonly line?: number | undefined
  readonly enclosingSymbol?: string | undefined
}

export interface TaggedSchemaInfo {
  readonly tag: string
  readonly properties: ReadonlyArray<string>
  readonly file: string
  readonly line: number
}

export const WORKSPACE_PACKAGE_TAG_MAP: Readonly<Record<string, PackageTag>> = {
  contract: PackageTag.make("contract"), domain: PackageTag.make("domain"),
  core: PackageTag.make("domain"), service: PackageTag.make("service"),
  infra: PackageTag.make("infra"), app: PackageTag.make("app"),
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

export const hasExportModifier = (node: ts.Node): boolean => {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods !== undefined && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  nx: Schema.optional(Schema.Struct({ tags: Schema.optional(Schema.Array(Schema.String)) })),
})

const decodePackageJson = Schema.decodeOption(Schema.fromJsonString(PackageJsonSchema))

export const resolvePackageTag = (repoRoot: string, relFilePath: string): PackageTag => {
  if (relFilePath.startsWith("apps/") || relFilePath.includes("/apps/")) return "app"
  let currentDir = path.dirname(path.join(repoRoot, relFilePath))
  while (currentDir.length >= repoRoot.length) {
    const pkgPath = path.join(currentDir, "package.json")
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const opt = decodePackageJson(content)
      const tags = match(opt)
        .with({ _tag: "Some" }, ({ value }) => value.nx?.tags ?? [])
        .with({ _tag: "None" }, () => [] as ReadonlyArray<string>)
        .exhaustive()
      if (tags.length > 0) {
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
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) return curr
    curr = path.dirname(curr)
  }
  return startDir
}

export const cleanName = (raw: string): string => {
  let name = raw.replace(/import\([^)]+\)\./g, "").trim()
  if (name.startsWith("typeof ")) name = name.slice(7).trim()
  if (!name.includes("<") && name.includes(".")) {
    name = name.split(".").pop()?.trim() ?? name
  }
  return name
}

export const decomposeTypeNode = (node: TypeNode): Array<string> => {
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
    raw === "never" || raw === "unknown" || raw === "any" ||
    raw === "void" || raw === "undefined" || raw === ""
  ) return []
  if (node.getType().isTypeParameter()) return []
  let ancestor: Node | undefined = node.getParent()
  while (ancestor !== undefined) {
    if (
      Node.isFunctionDeclaration(ancestor) || Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor) || Node.isMethodSignature(ancestor) ||
      Node.isMethodDeclaration(ancestor) || Node.isCallSignatureDeclaration(ancestor) ||
      Node.isFunctionTypeNode(ancestor) || Node.isClassDeclaration(ancestor) ||
      Node.isInterfaceDeclaration(ancestor) || Node.isTypeAliasDeclaration(ancestor)
    ) {
      if (ancestor.getTypeParameters().some((tp) => tp.getName() === raw)) return []
    }
    ancestor = ancestor.getParent()
  }
  return [raw]
}

export const decomposeType = (type: Type): Array<string> => {
  if (type.isNever() || type.isUnknown() || type.isAny() || type.isTypeParameter()) return []
  if (type.isUnion()) return type.getUnionTypes().flatMap(decomposeType)
  const sym = type.getAliasSymbol() ?? type.getSymbol()
  const raw = cleanName(sym ? sym.getName() : type.getText())
  if (
    raw === "never" || raw === "unknown" || raw === "any" ||
    raw === "void" || raw === "undefined" || raw === ""
  ) return []
  return [raw]
}

export const isDiscriminantPropertyOfUnion = (
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
    if (propType.isLiteral() || propType.isBooleanLiteral()) literalCount += 1
  }
  return literalCount >= 2
}

export const isClosedFiniteUnionType = (argType: Type, locationNode: Node): boolean => {
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

export const findEnclosingSymbolName = (node: Node, relPath: string): string => {
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

export const isTypeBranded = (type: Type): boolean => {
  if (type.getProperty("~effect/Brand") !== undefined) return true
  if (type.isIntersection()) return type.getIntersectionTypes().some(isTypeBranded)
  if (type.isUnion()) {
    const members = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    return members.length > 0 && members.every(isTypeBranded)
  }
  return false
}

export const isExplicitOrSchemaAny = (type: Type, contextNode?: Node): boolean => {
  if (!type.isAny()) return false
  const intrinsicName = Reflect.get(type.compilerType, "intrinsicName") as string | undefined
  if (intrinsicName === "error") return false
  if (!contextNode) return true
  if (
    contextNode.getKind() === SyntaxKind.AnyKeyword ||
    contextNode.getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0
  ) return true
  const text = contextNode.getText()
  if (/\b(?:Schema|S)\.Any\b/.test(text) || /\bany\b/.test(text)) return true
  return contextNode.getSourceFile().getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0
}

export const isOpenUnbrandedPrimitiveType = (
  type: Type,
  contextNode?: Node,
): "string" | "number" | "any" | "unknown" | null => {
  if (isExplicitOrSchemaAny(type, contextNode)) return "any"
  if (type.isAny()) return null
  if (type.isUnknown()) return "unknown"
  if (
    type.isNever() || type.isVoid() || type.isUndefined() || type.isNull() ||
    type.isLiteral() || type.isBoolean() || type.isBooleanLiteral()
  ) return null
  if (isTypeBranded(type)) return null
  if (type.isString()) return "string"
  if (type.isNumber()) return "number"
  if (type.isUnion()) {
    const nonNull = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    if (nonNull.some((u) => isExplicitOrSchemaAny(u, contextNode))) return "any"
    if (nonNull.some((u) => u.isUnknown())) return "unknown"
    if (nonNull.some((u) => u.isString() && !u.isLiteral() && !isTypeBranded(u))) return "string"
    if (nonNull.some((u) => u.isNumber() && !u.isLiteral() && !isTypeBranded(u))) return "number"
  }
  return null
}

export const isScalarOrBrandedScalarType = (type: Type): boolean => {
  if (
    type.isString() || type.isNumber() || type.isBoolean() ||
    type.isBigInt() || type.isLiteral() || type.isBooleanLiteral()
  ) return true
  if (type.isIntersection()) return type.getIntersectionTypes().some(isScalarOrBrandedScalarType)
  if (type.isUnion()) {
    const nonNull = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
    return nonNull.length > 0 && nonNull.every(isScalarOrBrandedScalarType)
  }
  return false
}

export const collectUnbrandedObjectProperties = (
  type: Type,
  locationNode: Node,
): ReadonlyArray<{ readonly propName: string; readonly prim: string; readonly line: number }> => {
  if (
    isScalarOrBrandedScalarType(type) || type.isArray() || type.isTuple() ||
    type.isAny() || type.isUnknown() || type.isNever() || type.isVoid()
  ) return []
  if (type.getCallSignatures().length > 0) return []

  const results: Array<{ readonly propName: string; readonly prim: string; readonly line: number }> = []
  const seen = new Set<string>()

  const inspectSingleType = (target: Type): void => {
    if (
      isScalarOrBrandedScalarType(target) || target.isArray() || target.isTuple() ||
      target.isAny() || target.isUnknown() || target.isNever() || target.isVoid()
    ) return
    if (
      target.getProperty("ast") !== undefined &&
      target.getProperty("Type") !== undefined &&
      target.getProperty("Encoded") !== undefined
    ) return
    for (const prop of target.getProperties()) {
      const propName = prop.getName()
      if (propName === "_tag" || propName === "~effect/Brand" || propName.startsWith("~")) continue
      const decls = prop.getDeclarations()
      if (decls.length > 0 && decls.every((d) => d.getSourceFile().getFilePath().includes("typescript/lib/"))) {
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
      if (!member.isUndefined() && !member.isNull()) inspectSingleType(member)
    }
  } else {
    inspectSingleType(type)
  }

  return results
}

export const containsInlineObjectTypeAst = (typeNode: Node | undefined): boolean => {
  if (!typeNode) return false
  if (Node.isTypeLiteral(typeNode)) return true
  return typeNode.getDescendantsOfKind(SyntaxKind.TypeLiteral).length > 0
}

export const getSchemaDecodedType = (schemaExpr: Node): Type | null => {
  const exprType = schemaExpr.getType()
  if (exprType.isAny() || exprType.isUnknown()) return null
  if (exprType.getProperty("~type.make") === undefined && exprType.getProperty("ast") === undefined) {
    return null
  }
  const typeProp = exprType.getProperty("Type")
  if (!typeProp) return null
  return typeProp.getTypeAtLocation(schemaExpr)
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

export const computeDynamicPaths = (
  repoRoot: string,
  workspaceRoot: string,
): Record<string, Array<string>> => {
  const graphNodeModules = path.join(workspaceRoot, "libs/harness/graph/node_modules")
  const paths: Record<string, Array<string>> = {
    effect: [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/index.d.ts"),
      path.join(graphNodeModules, "effect/dist/index.d.ts"),
      path.join(repoRoot, "libs/harness/graph/node_modules/effect"),
      path.join(graphNodeModules, "effect"),
    ],
    "effect/*": [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/*.d.ts"),
      path.join(graphNodeModules, "effect/dist/*.d.ts"),
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/*"),
      path.join(graphNodeModules, "effect/*"),
    ],
    "ts-pattern": [
      path.join(repoRoot, "node_modules/ts-pattern"),
      path.join(workspaceRoot, "node_modules/ts-pattern"),
    ],
    "@harness/gates": [
      path.join(repoRoot, "libs/harness/gates/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/gates/src/index.ts"),
    ],
    "@harness/graph": [
      path.join(repoRoot, "libs/harness/graph/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/graph/src/index.ts"),
    ],
    "@harness/decision": [
      path.join(repoRoot, "libs/harness/decision/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/decision/src/index.ts"),
    ],
    "@harness/ingest": [
      path.join(repoRoot, "libs/harness/ingest/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/ingest/src/index.ts"),
    ],
    "@harness/sample-contract": [path.join(repoRoot, "libs/sample/contract/src/index.ts")],
    "@harness/sample-service": [path.join(repoRoot, "libs/sample/service/src/index.ts")],
    "@harness/sample-domain": [path.join(repoRoot, "libs/sample/domain/src/index.ts")],
    "@harness/sample-infra": [path.join(repoRoot, "libs/sample/infra/src/index.ts")],
  }
  const libsDir = path.join(repoRoot, "libs")
  if (fs.existsSync(libsDir)) {
    for (const s of fs.readdirSync(libsDir, { withFileTypes: true })) {
      if (!s.isDirectory() || s.name === "harness") continue
      for (const tier of ["contract", "service", "domain", "core", "infra"]) {
        const entry = path.join(libsDir, s.name, tier, "src", "index.ts")
        paths[`@harness/${s.name}-${tier}`] = [entry]
        paths[`@effect-${s.name}/${tier}`] = [entry]
        paths[`@${s.name}/${tier}`] = [entry]
      }
    }
  }
  return paths
}

export const resolveImportSpecToRelFile = (
  fromRelPath: string,
  spec: string,
  repoRoot: string,
  fileMap: ReadonlyMap<string, unknown>,
  dynamicPaths: Record<string, Array<string>>,
): string | null => {
  if (spec.startsWith(".")) {
    const fromDir = path.dirname(path.join(repoRoot, fromRelPath))
    const rel = path.relative(repoRoot, path.resolve(fromDir, spec)).replace(/\\/g, "/")
    for (const c of [rel, rel.replace(/\.js$/, ".ts"), rel.replace(/\.jsx$/, ".tsx"), `${rel}.ts`, `${rel}/index.ts`]) {
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

export const resolveContainedRelPath = (repoRoot: string, rawPath: string): string | null => {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) return null
  const logicalRoot = path.resolve(repoRoot)
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(logicalRoot, trimmed)
  const rel = path.relative(logicalRoot, abs).replace(/\\/g, "/")
  if (rel.length === 0 || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null
  let checkDir = abs
  while (!fs.existsSync(checkDir) && checkDir !== logicalRoot) {
    const parent = path.dirname(checkDir)
    if (parent === checkDir) break
    checkDir = parent
  }
  if (fs.existsSync(repoRoot) && fs.existsSync(checkDir)) {
    const checkRel = path.relative(logicalRoot, checkDir).replace(/\\/g, "/")
    if (!checkRel.startsWith("..") && !path.isAbsolute(checkRel)) {
      const realRoot = fs.realpathSync.native(logicalRoot)
      const realAncestor = fs.realpathSync.native(checkDir)
      const realRel = path.relative(realRoot, realAncestor).replace(/\\/g, "/")
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null
    }
  }
  return rel
}


