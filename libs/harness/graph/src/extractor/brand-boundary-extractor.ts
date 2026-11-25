import { match } from "ts-pattern"
import { Node, type ParameterDeclaration, type SourceFile, SyntaxKind, type Type } from "ts-morph"
import type { BranchingViolation, PackageTag } from "../model.js"
import {
  addViolation,
  collectUnbrandedObjectProperties,
  containsInlineObjectTypeAst,
  findEnclosingSymbolName,
  getSchemaDecodedType,
  isOpenUnbrandedPrimitiveType,
  isTypeBranded,
} from "./extractor-types-and-helpers.js"

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
      addViolation(
        violations,
        "unbranded-primitive-boundary",
        `${symbolCategory} '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
        relPath,
        param.getStartLineNumber(),
        enclosingSymbol,
      )
    }
    const paramType = param.getType()
    const paramPrim = isOpenUnbrandedPrimitiveType(paramType, param)
    if (paramPrim !== null) {
      addViolation(
        violations,
        "unbranded-primitive-boundary",
        `${symbolCategory} '${fnName}' parameter '${param.getName()}' in '${enclosingSymbol}' uses unbranded primitive '${paramPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
        relPath,
        param.getStartLineNumber(),
        enclosingSymbol,
      )
      continue
    }
    if (!paramType.isUnion()) {
      for (const { propName, prim, line } of collectUnbrandedObjectProperties(paramType, param)) {
        addViolation(
          violations,
          "unbranded-primitive-boundary",
          `${symbolCategory} '${fnName}' parameter property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
          relPath,
          line,
          enclosingSymbol,
        )
      }
    }
  }

  if (containsInlineObjectTypeAst(explicitRetNode)) {
    addViolation(
      violations,
      "unbranded-primitive-boundary",
      `${symbolCategory} '${fnName}' return type in '${enclosingSymbol}' uses an inline object type literal — define a named Schema.Struct or Schema.Class in type:contract with branded fields and reference its derived type.`,
      relPath,
      declLine,
      enclosingSymbol,
    )
  }

  if (fullRetType) {
    const retTypeArgs = fullRetType.getTypeArguments()
    const retSuccess = retTypeArgs[0] ?? fullRetType
    const retLocNode = explicitRetNode ?? declNode
    const retPrim = isOpenUnbrandedPrimitiveType(retSuccess, retLocNode)
    if (retPrim !== null) {
      const retLabel = match(symbolCategory)
        .with("Domain function", () => "success ")
        .with("Service capability", () => "")
        .exhaustive()
      addViolation(
        violations,
        "unbranded-primitive-boundary",
        `${symbolCategory} '${fnName}' return ${retLabel}type in '${enclosingSymbol}' resolves to unbranded primitive '${retPrim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
        relPath,
        declLine,
        enclosingSymbol,
      )
    }
    if (retPrim === null && !retSuccess.isUnion()) {
      for (const { propName, prim, line } of collectUnbrandedObjectProperties(
        retSuccess,
        explicitRetNode ?? params[0] ?? declNode,
      )) {
        addViolation(
          violations,
          "unbranded-primitive-boundary",
          `${symbolCategory} '${fnName}' return property '${propName}' in '${enclosingSymbol}' uses unbranded primitive '${prim}' without '~effect/Brand' — use a branded domain type from type:contract.`,
          relPath,
          line,
          enclosingSymbol,
        )
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
    if (brandProp)
      return (brandProp.getValueDeclaration()?.getType() ?? brandProp.getDeclaredType())
        .getProperties()
        .map((p) => p.getName())
    return type.isIntersection() ? type.getIntersectionTypes().flatMap(extractBrandKeys) : []
  }

  for (const castNode of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression),
  ]) {
    const targetType = castNode.getType(),
      exprType = castNode.getExpression().getType()
    if (isTypeBranded(targetType)) {
      const targetBrands = extractBrandKeys(targetType),
        exprBrands = new Set(extractBrandKeys(exprType))
      if (!isTypeBranded(exprType) || targetBrands.some((b) => !exprBrands.has(b))) {
        const enclosingSymbol = findEnclosingSymbolName(castNode, relPath)
        addViolation(
          violations,
          "unbranded-primitive-boundary",
          `Type assertion '${castNode.getText()}' in '${enclosingSymbol}' casts ${isTypeBranded(exprType) ? "a differently branded" : "an unbranded"} value directly to branded type '${targetType.getText(castNode)}' — construct branded values via <Schema>.make(...) or Schema.decodeUnknownEffect(<Schema>)(...).`,
          relPath,
          castNode.getStartLineNumber(),
          enclosingSymbol,
        )
      }
    }
  }

  const { isContract, isDomainCore, isServicePkg } = match(filePkgTag)
    .with("contract", () => ({ isContract: true, isDomainCore: false, isServicePkg: false }))
    .with("domain", () => ({
      isContract: false,
      isDomainCore: relPath.includes("/domain/") || relPath.includes("/core/"),
      isServicePkg: false,
    }))
    .with("service", () => ({
      isContract: false,
      isDomainCore: false,
      isServicePkg: relPath.includes("/service/"),
    }))
    .with("infra", "app", "unknown", () => ({
      isContract: false,
      isDomainCore: false,
      isServicePkg: false,
    }))
    .exhaustive()

  if (isContract || isDomainCore) {
    if (isContract) {
      for (const typeAlias of sourceFile.getTypeAliases()) {
        if (!typeAlias.isExported()) continue
        const aliasName = typeAlias.getName(),
          enclosingSymbol = `${relPath}#${aliasName}`
        const prim = isOpenUnbrandedPrimitiveType(typeAlias.getType(), typeAlias)
        if (prim !== null) {
          addViolation(
            violations,
            "unbranded-contract-schema",
            `Exported type alias '${aliasName}' in '${enclosingSymbol}' resolves to unbranded primitive '${prim}' without '~effect/Brand' — define a branded schema with Schema.brand("${aliasName}") in type:contract.`,
            relPath,
            typeAlias.getStartLineNumber(),
            enclosingSymbol,
          )
          continue
        }
        if (
          containsInlineObjectTypeAst(typeAlias.getTypeNode()) &&
          !isTypeBranded(typeAlias.getType())
        ) {
          addViolation(
            violations,
            "unbranded-contract-schema",
            `Exported type alias '${aliasName}' in '${enclosingSymbol}' uses an inline object type literal without a runtime Schema — define a Schema.Struct or Schema.Class in type:contract with branded fields and derive 'export type ${aliasName} = typeof ${aliasName}.Type'.`,
            relPath,
            typeAlias.getStartLineNumber(),
            enclosingSymbol,
          )
        }
      }
    }

    const declaredBrandKeys = new Map<string, string>()
    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const exprText = callExpr.getExpression().getText()
      if (exprText === "Schema.brand" || exprText === "S.brand") {
        const arg0 = callExpr.getArguments()[0]
        if (arg0 && Node.isStringLiteral(arg0)) {
          const brandKey = arg0.getLiteralValue(),
            enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
          const firstSymbol = declaredBrandKeys.get(brandKey)
          if (firstSymbol) {
            if (firstSymbol !== enclosingSymbol) {
              addViolation(
                violations,
                "unbranded-contract-schema",
                `Duplicate Schema.brand('${brandKey}') in '${enclosingSymbol}' (already declared in '${firstSymbol}') — each brand key must have a single canonical constructor schema; compose wire schemas using Schema.decodeTo(${brandKey}).`,
                relPath,
                callExpr.getStartLineNumber(),
                enclosingSymbol,
              )
            }
          } else {
            declaredBrandKeys.set(brandKey, enclosingSymbol)
          }
        }
      }
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      if (!varDecl.isExported()) continue
      const varName = varDecl.getName(),
        init = varDecl.getInitializer()
      if (!init) continue
      const enclosingSymbol = `${relPath}#${varName}`,
        decodedType = getSchemaDecodedType(init)
      if (decodedType !== null) {
        const topPrim = isOpenUnbrandedPrimitiveType(decodedType, varDecl)
        if (topPrim !== null) {
          addViolation(
            violations,
            "unbranded-contract-schema",
            `Contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${topPrim}' without '~effect/Brand' — pipe the schema into Schema.brand("${varName}") so domain values carry nominal compile-time safety.`,
            relPath,
            varDecl.getStartLineNumber(),
            enclosingSymbol,
          )
        }
        for (const { propName, prim, line } of collectUnbrandedObjectProperties(
          decodedType,
          varDecl,
        )) {
          addViolation(
            violations,
            "unbranded-contract-schema",
            `Property '${propName}' of contract schema '${varName}' in '${enclosingSymbol}' decodes to unbranded primitive '${prim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for contract fields.`,
            relPath,
            line,
            enclosingSymbol,
          )
        }
      }
    }

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const clsName = cls.getName() ?? "AnonymousClass",
        extClause = cls.getExtends()
      if (!extClause) continue
      const extText = extClause.getText()
      if (
        !extText.includes("TaggedError") &&
        !extText.includes("TaggedClass") &&
        !extText.includes("Class")
      )
        continue
      const enclosingSymbol = `${relPath}#${clsName}`
      for (const callExpr of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        for (const arg of callExpr.getArguments()) {
          if (!Node.isObjectLiteralExpression(arg)) continue
          for (const prop of arg.getProperties()) {
            if (!Node.isPropertyAssignment(prop) || prop.getName() === "_tag") continue
            const propInit = prop.getInitializer()
            if (!propInit) continue
            const propDecoded = getSchemaDecodedType(propInit)
            if (!propDecoded) continue
            const propPrim = isOpenUnbrandedPrimitiveType(propDecoded, prop)
            if (propPrim !== null) {
              addViolation(
                violations,
                "unbranded-contract-schema",
                `Field '${prop.getName()}' of '${clsName}' in '${enclosingSymbol}' decodes to unbranded primitive '${propPrim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for tagged error and class fields.`,
                relPath,
                prop.getStartLineNumber(),
                enclosingSymbol,
              )
              continue
            }
            for (const { propName, prim, line } of collectUnbrandedObjectProperties(
              propDecoded,
              prop,
              0,
              new Set(),
              prop.getName(),
            )) {
              addViolation(
                violations,
                "unbranded-contract-schema",
                `Field '${propName}' of '${clsName}' in '${enclosingSymbol}' decodes to unbranded primitive '${prim}' without '~effect/Brand' — use a branded schema (Schema.brand("<BrandName>")) for tagged error and class fields.`,
                relPath,
                line,
                enclosingSymbol,
              )
            }
          }
        }
      }
    }
  }

  if (isServicePkg) {
    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue
      const clsName = cls.getName() ?? "Service",
        extClause = cls.getExtends()
      if (!extClause) continue
      if (
        !extClause.getText().includes("Context.Service") &&
        !extClause.getText().includes("Service<")
      )
        continue
      const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
      if (!typeLiteral) continue
      const enclosingSymbol = `${relPath}#${clsName}`

      for (const member of typeLiteral.getMembers()) {
        const memberName = Node.isPropertySignature(member)
          ? member.getName()
          : (member.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ?? "method")
        const params = member.getDescendantsOfKind(SyntaxKind.Parameter)
        const effectRef = member.getFirstDescendant(
          (n) => Node.isTypeReference(n) && n.getText().includes("Effect"),
        )
        const returnTypeNode =
          effectRef && Node.isTypeReference(effectRef)
            ? effectRef.getTypeArguments()[0]
            : (member.getFirstDescendantByKind(SyntaxKind.FunctionType)?.getReturnTypeNode() ??
              (Node.isMethodSignature(member) ? member.getReturnTypeNode() : undefined))
        const returnSuccessType = returnTypeNode?.getType()
        checkBoundaryParamsAndReturn(
          `${clsName}.${memberName}`,
          params,
          returnTypeNode,
          returnSuccessType,
          enclosingSymbol,
          relPath,
          "Service capability",
          member,
          member.getStartLineNumber(),
          violations,
        )
      }
    }
  }

  if (isDomainCore) {
    const checkExportedDomainFn = (
      fnName: string,
      fnNode: Node | undefined,
      declNode: Node,
    ): void => {
      const enclosingSymbol = `${relPath}#${fnName}`
      const isFn =
        fnNode &&
        (Node.isFunctionExpression(fnNode) ||
          Node.isArrowFunction(fnNode) ||
          Node.isFunctionDeclaration(fnNode))
      const params = isFn ? fnNode.getParameters() : []
      const explicitRetNode = isFn ? fnNode.getReturnTypeNode() : undefined
      const sigs = declNode.getType().getCallSignatures()
      const fullRetType = sigs[0]?.getReturnType()
      checkBoundaryParamsAndReturn(
        fnName,
        params,
        explicitRetNode,
        fullRetType,
        enclosingSymbol,
        relPath,
        "Domain function",
        declNode,
        declNode.getStartLineNumber(),
        violations,
      )
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
      if (fnDecl.isExported())
        checkExportedDomainFn(fnDecl.getName() ?? "anonymousFn", fnDecl, fnDecl)
    }
  }
}
