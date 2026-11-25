import {
  Node,
  type ParenthesizedTypeNode,
  SyntaxKind,
  ts,
  type Type,
  type TypeNode,
  type UnionTypeNode,
} from "ts-morph"
import { match } from "ts-pattern"
import type { BranchingViolation, PackageTag } from "../model.js"

export {
  computeDynamicPaths,
  decodePackageJson,
  PackageJsonSchema,
  resolveContainedRelPath,
  resolveImportSpecToRelFile,
  resolvePackageTag,
  resolveRepoRoot,
  sha256Hex,
  stripCommentsAndTestTitles,
  WORKSPACE_PACKAGE_TAG_MAP,
} from "./extractor-path-and-text-helpers.js"

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
    | "domain-effect-ignore"
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

export const hasExportModifier = (node: ts.Node): boolean => {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods !== undefined && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

export const addViolation = (
  violations: Array<BranchingViolation>,
  rule: BranchingViolation["rule"],
  message: string,
  file: string,
  line: number,
  enclosingSymbol: string,
  path?: ReadonlyArray<string>,
): void => {
  violations.push({
    rule,
    message,
    file,
    line,
    enclosingSymbol,
    ...(path !== undefined ? { path } : {}),
  })
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
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  )
    return []
  if (node.getType().isTypeParameter()) return []
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
    raw === "never" ||
    raw === "unknown" ||
    raw === "any" ||
    raw === "void" ||
    raw === "undefined" ||
    raw === ""
  )
    return []
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

const isStringLiteralOrBrandedStringLiteral = (member: Type): boolean => {
  if (member.isStringLiteral()) return true
  if (member.isIntersection()) {
    return member.getIntersectionTypes().some((part) => part.isStringLiteral())
  }
  return false
}

export const isClosedStringLiteralUnionType = (type: Type): boolean => {
  if (!type.isUnion()) return false
  const members = type.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull())
  if (members.length < 2) return false
  return members.every(isStringLiteralOrBrandedStringLiteral)
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
  )
    return true
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
    type.isNever() ||
    type.isVoid() ||
    type.isUndefined() ||
    type.isNull() ||
    type.isLiteral() ||
    type.isBoolean() ||
    type.isBooleanLiteral()
  )
    return null
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
    type.isString() ||
    type.isNumber() ||
    type.isBoolean() ||
    type.isBigInt() ||
    type.isLiteral() ||
    type.isBooleanLiteral()
  )
    return true
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
  depth = 0,
  visited: Set<object> = new Set(),
  fallbackPropName?: string,
): ReadonlyArray<{ readonly propName: string; readonly prim: string; readonly line: number }> => {
  if (depth > 4 || visited.has(type.compilerType)) return []
  visited.add(type.compilerType)
  if (fallbackPropName !== undefined) {
    const prim = isOpenUnbrandedPrimitiveType(type)
    if (prim !== null) {
      return [{ propName: fallbackPropName, prim, line: locationNode.getStartLineNumber() }]
    }
  }
  if (
    isScalarOrBrandedScalarType(type) ||
    type.isAny() ||
    type.isUnknown() ||
    type.isNever() ||
    type.isVoid()
  )
    return []
  if (type.getCallSignatures().length > 0) return []
  if (type.isArray()) {
    const elemType = type.getArrayElementType()
    return elemType !== undefined
      ? collectUnbrandedObjectProperties(
          elemType,
          locationNode,
          depth + 1,
          visited,
          fallbackPropName ?? "<element>",
        )
      : []
  }
  if (type.isTuple()) {
    return type
      .getTupleElements()
      .flatMap((el) =>
        collectUnbrandedObjectProperties(
          el,
          locationNode,
          depth + 1,
          visited,
          fallbackPropName ?? "<element>",
        ),
      )
  }
  const results: Array<{
    readonly propName: string
    readonly prim: string
    readonly line: number
  }> = []
  const seen = new Set<string>()
  const pushUnique = (entry: {
    readonly propName: string
    readonly prim: string
    readonly line: number
  }): void => {
    const key = `${entry.propName}:${entry.prim}`
    if (!seen.has(key)) {
      seen.add(key)
      results.push(entry)
    }
  }
  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (!member.isUndefined() && !member.isNull()) {
        for (const entry of collectUnbrandedObjectProperties(
          member,
          locationNode,
          depth,
          visited,
          fallbackPropName,
        ))
          pushUnique(entry)
      }
    }
    return results
  }
  if (
    type.getProperty("ast") !== undefined &&
    type.getProperty("Type") !== undefined &&
    type.getProperty("Encoded") !== undefined
  )
    return []
  for (const prop of type.getProperties()) {
    const propName = prop.getName()
    if (
      propName === "_tag" ||
      propName === "~effect/Brand" ||
      propName.startsWith("~") ||
      propName.startsWith("__@")
    )
      continue
    const decls = prop.getDeclarations()
    if (
      decls.length > 0 &&
      decls.every((d) => d.getSourceFile().getFilePath().includes("typescript/lib/"))
    )
      continue
    const propType = prop.getTypeAtLocation(locationNode)
    const prim = isOpenUnbrandedPrimitiveType(propType)
    if (prim !== null) {
      const declLine =
        decls[0] && decls[0].getSourceFile() === locationNode.getSourceFile()
          ? decls[0].getStartLineNumber()
          : locationNode.getStartLineNumber()
      pushUnique({ propName, prim, line: declLine })
      continue
    }
    if (propType.getCallSignatures().length > 0) continue
    if (
      propType.isArray() ||
      propType.isTuple() ||
      propType.isUnion() ||
      (propType.isObject() && !isTypeBranded(propType))
    ) {
      for (const entry of collectUnbrandedObjectProperties(
        propType,
        locationNode,
        depth + 1,
        visited,
        propName,
      ))
        pushUnique(entry)
    }
  }
  return results
}

export const containsInlineObjectTypeAst = (typeNode: Node | undefined): boolean => {
  if (!typeNode) return false
  if (Node.isTypeLiteral(typeNode)) return true
  return typeNode.getDescendantsOfKind(SyntaxKind.TypeLiteral).length > 0
}

export const TAG_GUARD_CALLEES = new Set([
  "Exit.isSuccess",
  "Exit.isFailure",
  "Option.isSome",
  "Option.isNone",
  "Either.isRight",
  "Either.isLeft",
  "Result.isSuccess",
  "Result.isFailure",
])

export const isEqualityOpKind = (opKind: SyntaxKind): boolean =>
  opKind === SyntaxKind.EqualsEqualsEqualsToken ||
  opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
  opKind === SyntaxKind.EqualsEqualsToken ||
  opKind === SyntaxKind.ExclamationEqualsToken

export const isLiteralNode = (n: Node): boolean =>
  Node.isStringLiteral(n) ||
  Node.isNumericLiteral(n) ||
  Node.isNoSubstitutionTemplateLiteral(n) ||
  n.getKind() === SyntaxKind.TrueKeyword ||
  n.getKind() === SyntaxKind.FalseKeyword

export const isContractOrDomainTag = (tag: PackageTag): boolean =>
  match(tag)
    .with("contract", "domain", () => true)
    .with("service", "infra", "app", "unknown", () => false)
    .exhaustive()

export const isInfraOrAppTag = (tag: PackageTag): boolean =>
  match(tag)
    .with("infra", "app", () => true)
    .with("contract", "domain", "service", "unknown", () => false)
    .exhaustive()

export const getSchemaDecodedType = (schemaExpr: Node): Type | null => {
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
