import { match } from "ts-pattern"
import {
  Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
  type Type,
} from "ts-morph"
import {
  type BranchingViolation,
  type PackageTag,
  type SchemaDefNode,
} from "../model.js"
import {
  type TaggedSchemaInfo,
  addViolation,
  collectUnbrandedObjectProperties,
  containsInlineObjectTypeAst,
  findEnclosingSymbolName,
  getSchemaDecodedType,
  isOpenUnbrandedPrimitiveType,
  isTypeBranded,
} from "./extractor-types-and-helpers.js"

const LIFECYCLE_FLAG_REGEX =
  /^(is[A-Z]\w*|has[A-Z]\w*|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/

const getObjectPropNames = (obj: Node | undefined): ReadonlyArray<string> =>
  obj && Node.isObjectLiteralExpression(obj)
    ? obj.getProperties().filter(Node.isPropertyAssignment).map((p) => p.getName()).filter((n) => n !== "_tag" && n !== "version")
    : []

export const extractSchemaDefinitions = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  schemas: Array<SchemaDefNode>,
  taggedSchemasByTag: Map<string, TaggedSchemaInfo>,
  taggedSchemasByName: Map<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: Map<string, ReadonlyArray<string>>,
): void => {
  const registerTaggedSchemaByTag = (tag: string, schemaInfo: TaggedSchemaInfo): void => {
    const existing = taggedSchemasByTag.get(tag)
    if (existing === undefined) {
      taggedSchemasByTag.set(tag, schemaInfo)
    } else {
      const merged = Array.from(new Set([...existing.properties, ...schemaInfo.properties]))
      taggedSchemasByTag.set(tag, { ...schemaInfo, properties: merged })
    }
  }

  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue
    const extClause = cls.getExtends()
    if (!extClause) continue
    const extText = extClause.getText()

    if (extText.includes("TaggedClass")) {
      for (const c of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const args = c.getArguments()
        if (args.length >= 2 && Node.isStringLiteral(args[0]) && Node.isObjectLiteralExpression(args[1])) {
          const tag = args[0].getLiteralText()
          const schemaInfo: TaggedSchemaInfo = { tag, properties: getObjectPropNames(args[1]), file: relPath, line: c.getStartLineNumber() }
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

    if (
      extText.includes("Schema.Class") || extText.includes("Schema.TaggedClass") ||
      extText.includes("TaggedClass") || extText.includes("Class<")
    ) {
      const clsName = cls.getName() ?? ""
      if (clsName && !schemas.some((s) => s.schemaName === clsName)) {
        schemas.push({
          _tag: "SchemaDef", schemaName: clsName, packageTag: filePkgTag,
          file: relPath, line: cls.getStartLineNumber(), isBranded: false,
          name: clsName, qualname: `${relPath}#${clsName}`,
        })
      }
    }
  }

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = callExpr.getExpression().getText()
    match(calleeText)
      .with("Schema.TaggedStruct", "S.TaggedStruct", () => {
        const args = callExpr.getArguments()
        if (args.length >= 2 && Node.isStringLiteral(args[0]) && Node.isObjectLiteralExpression(args[1])) {
          const tag = args[0].getLiteralText()
          const schemaInfo: TaggedSchemaInfo = { tag, properties: getObjectPropNames(args[1]), file: relPath, line: callExpr.getStartLineNumber() }
          registerTaggedSchemaByTag(tag, schemaInfo)
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar) { taggedSchemasByName.set(parentVar.getName(), schemaInfo); unionSchemaTagsByName.set(parentVar.getName(), [tag]) }
        }
      })
      .with("Schema.TaggedUnion", "S.TaggedUnion", () => {
        const args = callExpr.getArguments()
        if (args.length >= 1 && Node.isObjectLiteralExpression(args[0])) {
          const memberTags: Array<string> = []
          for (const prop of args[0].getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              const tag = prop.getName().replace(/^["'`]|["'`]$/g, "")
              registerTaggedSchemaByTag(tag, { tag, properties: getObjectPropNames(prop.getInitializer()), file: relPath, line: prop.getStartLineNumber() })
              memberTags.push(tag)
            }
          }
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar && memberTags.length > 0) unionSchemaTagsByName.set(parentVar.getName(), memberTags)
        }
      })
      .with("Schema.Union", "S.Union", () => {
        const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
        if (parentVar && parentVar.getInitializer() === callExpr) {
          const memberNames: Array<string> = []
          for (const arg of callExpr.getArguments()) {
            if (Node.isArrayLiteralExpression(arg)) {
              for (const el of arg.getElements()) { if (Node.isIdentifier(el)) memberNames.push(el.getText()) }
              continue
            }
            if (Node.isIdentifier(arg)) memberNames.push(arg.getText())
          }
          if (memberNames.length > 0) unionSchemaTagsByName.set(parentVar.getName(), memberNames)
        }
      })
      .otherwise(() => {})
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const aliasName = typeAlias.getName()
    if (unionSchemaTagsByName.has(aliasName)) continue
    const typeNode = typeAlias.getTypeNode()
    if (!typeNode) continue
    if (Node.isUnionTypeNode(typeNode)) {
      const members: Array<string> = []
      for (const part of typeNode.getTypeNodes()) {
        const text = part.getText().trim()
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) members.push(text)
      }
      if (members.length > 0) unionSchemaTagsByName.set(aliasName, members)
      continue
    }
    const text = typeNode.getText().trim()
    const matchTypeof = text.match(/^typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\.Type$/)
    const targetIdent = matchTypeof?.[1] ?? (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined)
    if (targetIdent && targetIdent !== aliasName) unionSchemaTagsByName.set(aliasName, [targetIdent])
  }

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    if (!varDecl.isExported()) continue
    const varName = varDecl.getName(), init = varDecl.getInitializer()
    if (!init) continue
    const initText = init.getText()
    const isSchemaDef =
      initText.includes("Schema.Struct") || initText.includes("Schema.TaggedStruct") ||
      initText.includes("Schema.TaggedUnion") || initText.includes("Schema.Union") ||
      initText.includes("Schema.Class") || initText.includes("Schema.brand(") ||
      initText.includes(".pipe(Schema.brand") || initText.includes("S.Struct") ||
      initText.includes("S.TaggedStruct") || initText.includes("S.TaggedUnion") ||
      initText.includes("S.brand(")

    if (isSchemaDef && !schemas.some((s) => s.schemaName === varName)) {
      schemas.push({
        _tag: "SchemaDef", schemaName: varName, packageTag: filePkgTag,
        file: relPath, line: varDecl.getStartLineNumber(),
        isBranded: initText.includes("brand(") || initText.includes("Schema.brand"),
        name: varName, qualname: `${relPath}#${varName}`,
      })
    }
  }
}

export const checkSchemaBooleanStateAndBrandedFields = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  if (filePkgTag !== "contract" && filePkgTag !== "domain") return

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = callExpr.getExpression(), calleeText = callee.getText()
    const isStruct = calleeText === "Schema.Struct" || calleeText === "S.Struct" || (Node.isPropertyAccessExpression(callee) && callee.getName() === "Struct")
    const isTaggedStruct = calleeText === "Schema.TaggedStruct" || calleeText === "S.TaggedStruct" || (Node.isPropertyAccessExpression(callee) && callee.getName() === "TaggedStruct")
    const isTaggedClass = calleeText.includes("TaggedClass")
    if (!isStruct && !isTaggedStruct && !isTaggedClass) continue

    const args = callExpr.getArguments()
    const objLit: Node | undefined =
      isStruct && args.length >= 1 && Node.isObjectLiteralExpression(args[0]) ? args[0]
        : (isTaggedStruct || isTaggedClass) && args.length >= 2 && Node.isObjectLiteralExpression(args[1]) ? args[1]
          : undefined
    if (!objLit || !Node.isObjectLiteralExpression(objLit)) continue

    const propAssignments: Array<{ name: string; node: Node; init: Node }> = []
    const propMap = new Map<string, { node: Node; init: Node }>()
    for (const p of objLit.getProperties()) {
      if (Node.isPropertyAssignment(p)) {
        const pName = p.getName(), pInit = p.getInitializer()
        if (pInit) {
          const entry = { name: pName, node: p, init: pInit }
          propAssignments.push(entry)
          propMap.set(pName, entry)
        }
      }
    }

    const isBooleanSchema = (node: Node): boolean => {
      const text = node.getText().replace(/\s+/g, "")
      if (text === "Schema.Boolean" || text === "S.Boolean") return true
      if (!Node.isCallExpression(node)) return false
      const cText = node.getExpression().getText().replace(/\s+/g, "")
      const isOpt = cText === "Schema.optional" || cText === "S.optional" || cText === "Schema.optionalWith" || cText === "S.optionalWith"
      const firstArg = node.getArguments()[0]
      return isOpt && firstArg !== undefined ? isBooleanSchema(firstArg) : false
    }

    for (const { name, node, init } of propAssignments) {
      if (isBooleanSchema(init)) {
        const hasCompanion = [
          `${name}At`, `${name}By`,
          ...(name.startsWith("is") && name.length > 2 ? [`${name[2]!.toLowerCase()}${name.slice(3)}At`, `${name[2]!.toLowerCase()}${name.slice(3)}By`] : []),
          ...(name.startsWith("has") && name.length > 3 ? [`${name[3]!.toLowerCase()}${name.slice(4)}At`, `${name[3]!.toLowerCase()}${name.slice(4)}By`] : []),
        ].some((c) => {
          const comp = propMap.get(c)
          const text = comp ? comp.init.getText() : ""
          return text.includes("NullOr") || text.includes("Option")
        })

        if (LIFECYCLE_FLAG_REGEX.test(name) || hasCompanion) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          addViolation(violations, "schema-boolean-state", `Property '${name}' in '${enclosingSymbol}' uses boolean flag for lifecycle state in Schema.Struct — mutually exclusive lifecycle states must be modeled as a closed union (Schema.TaggedUnion / Schema.TaggedStruct) instead of boolean flags.`, relPath, node.getStartLineNumber(), enclosingSymbol)
        }
      }

      if (/^(quantity|streamVersion|expectedVersion)$/.test(name)) {
        const initClean = init.getText().replace(/\s+/g, "")
        const startsWithUnbrandedNum =
          initClean.startsWith("Schema.Int") || initClean.startsWith("S.Int") ||
          initClean.startsWith("Schema.Number") || initClean.startsWith("S.Number") ||
          initClean.startsWith("Schema.Natural") || initClean.startsWith("S.Natural")
        if (startsWithUnbrandedNum && !initClean.includes("brand(")) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          addViolation(violations, "unbranded-schema-field", `Property '${name}' in '${enclosingSymbol}' uses unbranded '${init.getText()}' — domain quantity and version fields must use a branded contract schema (e.g. PositiveInt, StreamVersion, or .pipe(Schema.brand(...))) so invalid raw numbers cannot be passed at compile time.`, relPath, node.getStartLineNumber(), enclosingSymbol)
        }
      }
    }
  }

  for (const iface of sourceFile.getInterfaces()) {
    if (!iface.isExported()) continue
    for (const prop of iface.getProperties()) {
      const propName = prop.getName(), typeNodeText = prop.getTypeNode()?.getText() ?? ""
      if (/\bboolean\b/.test(typeNodeText) && LIFECYCLE_FLAG_REGEX.test(propName)) {
        addViolation(violations, "schema-boolean-state", `Interface property '${propName}' on '${iface.getName()}' in '${relPath}' uses a boolean flag ('${typeNodeText}') — model configuration and lifecycle modes with a closed discriminated union (Schema.TaggedStruct / Schema.Union) instead of boolean flags.`, relPath, prop.getStartLineNumber(), `${relPath}#${iface.getName()}`)
      }
    }
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const typeNode = typeAlias.getTypeNode()
    if (typeNode && Node.isUnionTypeNode(typeNode)) {
      let tagMemberCount = 0
      for (const member of typeNode.getTypeNodes()) {
        if (Node.isTypeLiteral(member) && member.getProperties().some((p) => p.getName() === "_tag")) tagMemberCount++
      }
      if (tagMemberCount >= 2) {
        addViolation(violations, "handwritten-tagged-union", `Type alias '${typeAlias.getName()}' in '${relPath}' is a handwritten TypeScript union of '_tag' object literals — model domain states, commands, and events with Schema.Union / Schema.TaggedStruct / Schema.TaggedUnion and derive the type via 'typeof ${typeAlias.getName()}.Type'.`, relPath, typeAlias.getStartLineNumber(), `${relPath}#${typeAlias.getName()}`)
      }
    }
  }
}

const checkBoundaryParamsAndReturn = (
  fnName: string,
  params: ReadonlyArray<ParameterDeclaration>,
  explicitRetNode: Node | undefined,
  fullRetType: Type | undefined,
  enclosingSymbol: string,
  relPath: string,
  symbolCategory: "Service capability" | "Domain function",
  declNode: Node,
  declLine: number,
  violations: Array<BranchingViolation>,
): void => {
  for (const param of params) {
    const paramTypeNode = param.getTypeNode()
    if (containsInlineObjectTypeAst(paramTypeNode)) {
      addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`, relPath, param.getStartLineNumber(), enclosingSymbol)
    }
    const paramType = param.getType()
    const paramPrim = isOpenUnbrandedPrimitiveType(paramType, param)
    if (paramPrim !== null) {
      addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses unbranded primitive '${paramPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`, relPath, param.getStartLineNumber(), enclosingSymbol)
      continue
    }
    if (!paramType.isUnion()) {
      for (const { propName, prim, line } of collectUnbrandedObjectProperties(paramType, param)) {
        addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' parameter property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`, relPath, line, enclosingSymbol)
      }
    }
  }

  if (containsInlineObjectTypeAst(explicitRetNode)) {
    addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' return type in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`, relPath, declLine, enclosingSymbol)
  }

  if (fullRetType) {
    const retTypeArgs = fullRetType.getTypeArguments()
    const retSuccess = retTypeArgs[0] ?? fullRetType
    const retLocNode = explicitRetNode ?? declNode
    const retPrim = isOpenUnbrandedPrimitiveType(retSuccess, retLocNode)
    if (retPrim !== null) {
      addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' return ${symbolCategory === "Domain function" ? "success " : ""}type in '${enclosingSymbol}' resolves to unbranded primitive '${retPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`, relPath, declLine, enclosingSymbol)
    }
    if (retPrim === null && !retSuccess.isUnion()) {
      for (const { propName, prim, line } of collectUnbrandedObjectProperties(retSuccess, explicitRetNode ?? params[0] ?? declNode)) {
        addViolation(violations, "unbranded-primitive-boundary", `${symbolCategory} '${fnName}' return property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`, relPath, line, enclosingSymbol)
      }
    }
  }
}

export const checkBrandedDomainTypesAndPrimitiveBoundaries = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  const extractBrandKeys = (type: Type): ReadonlyArray<string> => {
    const brandProp = type.getProperty("~effect/Brand")
    if (brandProp) return (brandProp.getValueDeclaration()?.getType() ?? brandProp.getDeclaredType()).getProperties().map((p) => p.getName())
    return type.isIntersection() ? type.getIntersectionTypes().flatMap(extractBrandKeys) : []
  }

  for (const castNode of [...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression), ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression)]) {
    const targetType = castNode.getType(), exprType = castNode.getExpression().getType()
    if (isTypeBranded(targetType)) {
      const targetBrands = extractBrandKeys(targetType), exprBrands = new Set(extractBrandKeys(exprType))
      if (!isTypeBranded(exprType) || targetBrands.some((b) => !exprBrands.has(b))) {
        const enclosingSymbol = findEnclosingSymbolName(castNode, relPath)
        addViolation(violations, "unbranded-primitive-boundary", `Type assertion '${castNode.getText()}' in '${enclosingSymbol}' casts ${isTypeBranded(exprType) ? "a differently branded" : "an unbranded"} value directly to branded type '${targetType.getText(castNode)}' — construct branded values via <Schema>.make(...) or Schema.decodeUnknownEffect(<Schema>)(...).`, relPath, castNode.getStartLineNumber(), enclosingSymbol)
      }
    }
  }

  if (filePkgTag === "contract" || (filePkgTag === "domain" && (relPath.includes("/domain/") || relPath.includes("/core/")))) {
    if (filePkgTag === "contract") {
      for (const typeAlias of sourceFile.getTypeAliases()) {
        if (!typeAlias.isExported()) continue
        const aliasName = typeAlias.getName(), enclosingSymbol = `${relPath}#${aliasName}`
        const prim = isOpenUnbrandedPrimitiveType(typeAlias.getType(), typeAlias)
        if (prim !== null) {
          addViolation(violations, "unbranded-contract-schema", `Exported type alias '${aliasName}' in '${enclosingSymbol}' resolves to unbranded primitive '${prim}' without '~effect/Brand' — define a branded schema with Schema.brand("${aliasName}") in type:contract.`, relPath, typeAlias.getStartLineNumber(), enclosingSymbol)
          continue
        }
        if (containsInlineObjectTypeAst(typeAlias.getTypeNode()) && !isTypeBranded(typeAlias.getType())) {
          addViolation(violations, "unbranded-contract-schema", `Exported type alias '${aliasName}' in '${enclosingSymbol}' uses an inline object type literal without a runtime Schema — define a Schema.Struct or Schema.Class in type:contract with branded fields and derive 'export type ${aliasName} = typeof ${aliasName}.Type'.`, relPath, typeAlias.getStartLineNumber(), enclosingSymbol)
        }
      }
    }

    const declaredBrandKeys = new Map<string, string>()
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const exprText = callExpr.getExpression().getText()
      if (exprText === "Schema.brand" || exprText === "S.brand") {
        const arg0 = callExpr.getArguments()[0]
        if (arg0 && Node.isStringLiteral(arg0)) {
          const brandKey = arg0.getLiteralValue(), enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
          const firstSymbol = declaredBrandKeys.get(brandKey)
          if (firstSymbol) {
            if (firstSymbol !== enclosingSymbol) {
              addViolation(violations, "unbranded-contract-schema", `Duplicate Schema.brand('${brandKey}') in '${enclosingSymbol}' (already declared in '${firstSymbol}') — each brand key must have a single canonical constructor schema; compose wire schemas using Schema.decodeTo(${brandKey}).`, relPath, callExpr.getStartLineNumber(), enclosingSymbol)
            }
          } else {
            declaredBrandKeys.set(brandKey, enclosingSymbol)
          }
        }
      }
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const varName = varDecl.getName(), init = varDecl.getInitializer()
      if (!init) continue
      const enclosingSymbol = `${relPath}#${varName}`, decodedType = getSchemaDecodedType(init)
      if (decodedType !== null) {
        const topPrim = isOpenUnbrandedPrimitiveType(decodedType, varDecl)
        if (topPrim !== null) {
          addViolation(violations, "unbranded-contract-schema", `Contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${topPrim}' without '~effect/Brand' — pipe the schema into Schema.brand("${varName}") so domain values carry nominal compile-time safety.`, relPath, varDecl.getStartLineNumber(), enclosingSymbol)
        }
        for (const { propName, prim, line } of collectUnbrandedObjectProperties(decodedType, varDecl)) {
          addViolation(violations, "unbranded-contract-schema", `Property '${propName}' of contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${prim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for contract fields.`, relPath, line, enclosingSymbol)
        }
      }
    }

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const clsName = cls.getName() ?? "AnonymousClass", extClause = cls.getExtends()
      if (!extClause) continue
      const extText = extClause.getText()
      if (!extText.includes("TaggedError") && !extText.includes("TaggedClass") && !extText.includes("Class")) continue
      const enclosingSymbol = `${relPath}#${clsName}`
      for (const callExpr of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        for (const arg of callExpr.getArguments()) {
          if (!Node.isObjectLiteralExpression(arg)) continue
          for (const prop of arg.getProperties()) {
            if (!Node.isPropertyAssignment(prop) || prop.getName() === "_tag") continue
            const propInit = prop.getInitializer()
            if (!propInit) continue
            const propDecoded = getSchemaDecodedType(propInit)
            const propPrim = propDecoded ? isOpenUnbrandedPrimitiveType(propDecoded, prop) : null
            if (propPrim !== null) {
              addViolation(violations, "unbranded-contract-schema", `Field '${prop.getName()}' of '${clsName}' in '${enclosingSymbol}' decodes to unbranded primitive '${propPrim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for tagged error and class fields.`, relPath, prop.getStartLineNumber(), enclosingSymbol)
            }
          }
        }
      }
    }
  }

  if (filePkgTag === "service" && relPath.includes("/service/")) {
    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const clsName = cls.getName() ?? "Service", extClause = cls.getExtends()
      if (!extClause) continue
      if (!extClause.getText().includes("Context.Service") && !extClause.getText().includes("Service<")) continue
      const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
      if (!typeLiteral) continue
      const enclosingSymbol = `${relPath}#${clsName}`

      for (const member of typeLiteral.getMembers()) {
        const memberName = Node.isPropertySignature(member)
          ? member.getName()
          : (member.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ?? "method")
        const params = member.getDescendantsOfKind(SyntaxKind.Parameter)
        const effectRef = member.getFirstDescendant((n) => Node.isTypeReference(n) && n.getText().includes("Effect"))
        const returnTypeNode = effectRef && Node.isTypeReference(effectRef)
          ? effectRef.getTypeArguments()[0]
          : member.getFirstDescendantByKind(SyntaxKind.FunctionType)?.getReturnTypeNode() ?? (Node.isMethodSignature(member) ? member.getReturnTypeNode() : undefined)
        const returnSuccessType = returnTypeNode?.getType()
        checkBoundaryParamsAndReturn(
          `${clsName}.${memberName}`, params, returnTypeNode, returnSuccessType,
          enclosingSymbol, relPath, "Service capability", member, member.getStartLineNumber(), violations,
        )
      }
    }
  }

  if (filePkgTag === "domain" && (relPath.includes("/domain/") || relPath.includes("/core/"))) {
    const checkExportedDomainFn = (fnName: string, fnNode: Node | undefined, declNode: Node): void => {
      const enclosingSymbol = `${relPath}#${fnName}`
      const isFn = fnNode && (Node.isFunctionExpression(fnNode) || Node.isArrowFunction(fnNode) || Node.isFunctionDeclaration(fnNode))
      const params = isFn ? fnNode.getParameters() : []
      const explicitRetNode = isFn ? fnNode.getReturnTypeNode() : undefined
      const sigs = declNode.getType().getCallSignatures()
      const fullRetType = sigs[0]?.getReturnType()
      checkBoundaryParamsAndReturn(fnName, params, explicitRetNode, fullRetType, enclosingSymbol, relPath, "Domain function", declNode, declNode.getStartLineNumber(), violations)
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const init = varDecl.getInitializer()
      if (!init) continue
      if (Node.isCallExpression(init)) {
        const inner = init.getExpression()
        if (
          (Node.isCallExpression(inner) && inner.getExpression().getText() === "Effect.fn") ||
          inner.getText() === "Effect.fnUntraced"
        ) {
          checkExportedDomainFn(varDecl.getName(), init.getArguments()[0], varDecl)
        }
        continue
      }
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        checkExportedDomainFn(varDecl.getName(), init, varDecl)
      }
    }

    for (const fnDecl of sourceFile.getFunctions()) {
      if (fnDecl.isExported()) checkExportedDomainFn(fnDecl.getName() ?? "anonymousFn", fnDecl, fnDecl)
    }
  }
}
