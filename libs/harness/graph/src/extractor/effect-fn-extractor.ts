import {
  type CallExpression,
  type NewExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph"
import {
  type EffectFnNode,
  type PackageTag,
  type ServiceTagNode,
  type TaggedErrorNode,
} from "../model.js"
import {
  cleanName,
  decomposeType,
  decomposeTypeNode,
} from "./extractor-types-and-helpers.js"

export const extractEffectFns = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  fns: Array<EffectFnNode>,
  failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }>,
  requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }>,
  classNameToTagId: Map<string, string>,
  serviceMethodErrors: Map<string, Map<string, Array<string>>>,
  referencedErrors: Set<string>,
  referencedServices: Set<string>,
  services: ReadonlyArray<ServiceTagNode>,
  errors: ReadonlyArray<TaggedErrorNode>,
): void => {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    if (!varDecl.isExported()) continue
    const varName = varDecl.getName()
    const typeNode = varDecl.getTypeNode()
    const init = varDecl.getInitializer()
    const typeText = typeNode?.getText() ?? ""
    const initText = init?.getText() ?? ""

    const isLayer =
      typeText.includes("Layer") ||
      initText.startsWith("Layer.") ||
      (init !== undefined && Node.isCallExpression(init) && init.getExpression().getText().startsWith("Layer."))
    if (isLayer) continue

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
