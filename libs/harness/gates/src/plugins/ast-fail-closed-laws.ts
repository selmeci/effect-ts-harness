import { Result } from "effect"
import { ts } from "@harness/graph"
import { unwrapExpr } from "./ast-gate-law-helpers.js"

interface NamespaceAliasSet {
  readonly canonicalName: string
  readonly direct: ReadonlySet<string>
  readonly effectRoots: ReadonlySet<string>
}

const collectNamespaceAliases = (
  sf: ts.SourceFile | undefined,
  canonicalName: string,
  moduleSpecifiers: ReadonlySet<string>,
): NamespaceAliasSet => {
  const direct = new Set<string>([canonicalName])
  const effectRoots = new Set<string>()
  if (sf === undefined) return { canonicalName, direct, effectRoots }
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue
    const mod = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : ""
    if (!moduleSpecifiers.has(mod)) continue
    const nb = stmt.importClause?.namedBindings
    if (nb === undefined) continue
    if (ts.isNamespaceImport(nb)) {
      if (mod === "effect") {
        effectRoots.add(nb.name.text)
      } else {
        direct.add(nb.name.text)
      }
    }
    if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue
        if ((el.propertyName ?? el.name).text === canonicalName) {
          direct.add(el.name.text)
        }
      }
    }
  }
  return { canonicalName, direct, effectRoots }
}

const EFFECT_MODULE_SPECS = new Set(["effect", "effect/Effect"])
const OPTION_MODULE_SPECS = new Set(["effect", "effect/Option"])
const SCHEMA_MODULE_SPECS = new Set(["effect", "effect/Schema"])

const getPropName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

const containsPureInterruptCauseCall = (root: ts.Node): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpr(n.expression)
      if (
        (ts.isIdentifier(callee) && callee.text === "isPureInterruptCause") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "isPureInterruptCause")
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const matchesNamespaceRoot = (expr: ts.Expression, aliases: NamespaceAliasSet): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return aliases.direct.has(u.text)
  return (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    aliases.effectRoots.has(u.expression.text) &&
    u.name.text === aliases.canonicalName
  )
}

const isNamespaceMethodCall = (
  call: ts.CallExpression,
  aliases: NamespaceAliasSet,
  methodName: string,
): boolean => {
  const u = unwrapExpr(call.expression)
  return (
    ts.isPropertyAccessExpression(u) &&
    u.name.text === methodName &&
    matchesNamespaceRoot(u.expression, aliases)
  )
}

const isNamespacePropertyExpr = (
  expr: ts.Expression,
  aliases: NamespaceAliasSet,
  propName: string,
): boolean => {
  const u = unwrapExpr(expr)
  return (
    ts.isPropertyAccessExpression(u) &&
    u.name.text === propName &&
    matchesNamespaceRoot(u.expression, aliases)
  )
}

const isEffectMethodCall = (
  call: ts.CallExpression,
  methodName: string,
  effectAliases: NamespaceAliasSet,
): boolean => isNamespaceMethodCall(call, effectAliases, methodName)

/** Flags `Effect.catchCause(...)` handlers in production `src/` lacking `isPureInterruptCause(...)` call. */
export const isUntypedCatchCauseWithoutInterruptGuard = (
  node: ts.CallExpression,
  sf?: ts.SourceFile,
): boolean => {
  const resolvedSf = sf ?? Result.getOrUndefined(Result.try(() => node.getSourceFile()))
  const effectAliases = collectNamespaceAliases(resolvedSf, "Effect", EFFECT_MODULE_SPECS)
  if (!isEffectMethodCall(node, "catchCause", effectAliases)) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined) return true
  const unwrappedCb = unwrapExpr(cb)
  return !containsPureInterruptCauseCall(unwrappedCb)
}

const isSchemaDecodeOptionCallExpr = (
  expr: ts.Expression,
  schemaAliases: NamespaceAliasSet,
): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  if (
    isNamespaceMethodCall(u, schemaAliases, "decodeOption") ||
    isNamespaceMethodCall(u, schemaAliases, "decodeUnknownOption")
  ) {
    return true
  }
  const inner = unwrapExpr(u.expression)
  return (
    ts.isCallExpression(inner) &&
    (isNamespaceMethodCall(inner, schemaAliases, "decodeOption") ||
      isNamespaceMethodCall(inner, schemaAliases, "decodeUnknownOption"))
  )
}

const isOptionNullableUnwrapFn = (expr: ts.Expression, optionAliases: NamespaceAliasSet): boolean =>
  isNamespacePropertyExpr(expr, optionAliases, "getOrUndefined") ||
  isNamespacePropertyExpr(expr, optionAliases, "getOrNull")

const isDecodeOrUnwrappedOptionExpr = (
  expr: ts.Expression,
  optionAliases: NamespaceAliasSet,
  schemaAliases: NamespaceAliasSet,
): boolean => {
  if (isSchemaDecodeOptionCallExpr(expr, schemaAliases)) return true
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  if (
    (isNamespaceMethodCall(u, optionAliases, "getOrUndefined") ||
      isNamespaceMethodCall(u, optionAliases, "getOrNull")) &&
    u.arguments[0] !== undefined
  ) {
    return isDecodeOrUnwrappedOptionExpr(u.arguments[0], optionAliases, schemaAliases)
  }
  const callee = unwrapExpr(u.expression)
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "pipe" &&
    u.arguments.some((a) => isOptionNullableUnwrapFn(a, optionAliases))
  ) {
    return isDecodeOrUnwrappedOptionExpr(callee.expression, optionAliases, schemaAliases)
  }
  if (
    ts.isIdentifier(callee) &&
    callee.text === "pipe" &&
    u.arguments.length >= 2 &&
    u.arguments[0] !== undefined &&
    u.arguments.slice(1).some((a) => isOptionNullableUnwrapFn(a, optionAliases))
  ) {
    return isDecodeOrUnwrappedOptionExpr(u.arguments[0], optionAliases, schemaAliases)
  }
  return false
}

const findPipeSubjectForCall = (call: ts.CallExpression): ts.Expression | undefined => {
  const parent = call.parent
  if (parent === undefined || !ts.isCallExpression(parent)) return undefined
  const callee = unwrapExpr(parent.expression)
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pipe") {
    return callee.expression
  }
  if (ts.isIdentifier(callee) && callee.text === "pipe" && parent.arguments[0] !== undefined) {
    return parent.arguments[0]
  }
  return undefined
}

const SILENT_EMPTY_PRIMITIVE_TEXTS = new Set([
  "[]",
  '""',
  "''",
  "{}",
  "undefined",
  "null",
  "false",
  "void 0",
])

const isSilentValueExpr = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  optionAliases: NamespaceAliasSet,
): boolean => {
  const arg = unwrapExpr(expr)
  const argText = arg.getText(sf).trim()
  if (SILENT_EMPTY_PRIMITIVE_TEXTS.has(argText)) return true
  if (ts.isIdentifier(arg) && arg.text === "undefined") return true
  if (ts.isCallExpression(arg) && isNamespaceMethodCall(arg, optionAliases, "none")) return true
  return false
}

const hasFailOrDieEffect = (root: ts.Node, effectAliases: NamespaceAliasSet): boolean => {
  let hasNonSilentFail = false
  const visit = (n: ts.Node): void => {
    if (hasNonSilentFail) return
    if (
      ts.isCallExpression(n) &&
      (isEffectMethodCall(n, "fail", effectAliases) ||
        isEffectMethodCall(n, "failCause", effectAliases) ||
        isEffectMethodCall(n, "die", effectAliases))
    ) {
      hasNonSilentFail = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return hasNonSilentFail
}

const collectDirectReturns = (fn: ts.FunctionLikeDeclaration): ReadonlyArray<ts.Expression> => {
  if (fn.body === undefined || !ts.isBlock(fn.body)) return []
  const returnedExprs: Array<ts.Expression> = []
  const collect = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      returnedExprs.push(n.expression)
    }
    ts.forEachChild(n, collect)
  }
  collect(fn.body)
  return returnedExprs
}

const hasNonLogYieldExpr = (
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
): boolean => {
  if (fn.body === undefined) return false
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (n !== fn && ts.isFunctionLike(n)) return
    if (ts.isYieldExpression(n) && n.expression !== undefined) {
      const yielded = unwrapExpr(n.expression)
      if (!ts.isCallExpression(yielded) || !isPureLoggingCallExpr(yielded, sf, effectAliases)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return found
}

const isSilentSuccessEffectExpr = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
  optionAliases: NamespaceAliasSet,
): boolean => {
  const u = unwrapExpr(expr)
  if (isNamespacePropertyExpr(u, effectAliases, "void")) {
    return true
  }
  if (ts.isCallExpression(u) && isPureLoggingCallExpr(u, sf, effectAliases)) {
    return true
  }
  if (
    ts.isCallExpression(u) &&
    isEffectMethodCall(u, "succeed", effectAliases) &&
    u.arguments[0] !== undefined
  ) {
    return isSilentValueExpr(u.arguments[0], sf, optionAliases)
  }
  if (
    ts.isCallExpression(u) &&
    isEffectMethodCall(u, "sync", effectAliases) &&
    u.arguments[0] !== undefined
  ) {
    const syncFn = unwrapExpr(u.arguments[0])
    if (
      (ts.isArrowFunction(syncFn) || ts.isFunctionExpression(syncFn)) &&
      !hasFailOrDieEffect(syncFn, effectAliases)
    ) {
      if (!ts.isBlock(syncFn.body)) {
        return isSilentValueExpr(syncFn.body, sf, optionAliases)
      }
      const returns = collectDirectReturns(syncFn)
      return returns.every((e) => isSilentValueExpr(e, sf, optionAliases))
    }
  }
  if (
    ts.isCallExpression(u) &&
    isEffectMethodCall(u, "gen", effectAliases) &&
    u.arguments[0] !== undefined
  ) {
    const genFn = unwrapExpr(u.arguments[0])
    if (
      (ts.isArrowFunction(genFn) || ts.isFunctionExpression(genFn)) &&
      !hasFailOrDieEffect(genFn, effectAliases)
    ) {
      const returns = collectDirectReturns(genFn)
      if (returns.length > 0) {
        return returns.every((e) => {
          const uRet = unwrapExpr(e)
          return ts.isYieldExpression(uRet) && uRet.expression !== undefined
            ? isSilentSuccessEffectExpr(uRet.expression, sf, effectAliases, optionAliases)
            : isSilentValueExpr(e, sf, optionAliases)
        })
      }
      return !hasNonLogYieldExpr(genFn, sf, effectAliases)
    }
  }
  return false
}

const isSilentCatchTagCallback = (
  cb: ts.Expression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
  optionAliases: NamespaceAliasSet,
): boolean => {
  const fn = unwrapExpr(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  if (hasFailOrDieEffect(fn, effectAliases)) return false
  if (!ts.isBlock(fn.body)) {
    return isSilentSuccessEffectExpr(fn.body, sf, effectAliases, optionAliases)
  }
  const returnedExprs = collectDirectReturns(fn)
  return (
    returnedExprs.length > 0 &&
    returnedExprs.every((e) => isSilentSuccessEffectExpr(e, sf, effectAliases, optionAliases))
  )
}

const BANNED_WORKFLOW_CATCH_TAGS = new Set([
  "WorkflowStoreUnavailableError",
  "WriterLeaseHeldError",
])

const matchesWorkflowStoreTagArg = (arg: ts.Expression): boolean => {
  const u = unwrapExpr(arg)
  if (
    (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) &&
    BANNED_WORKFLOW_CATCH_TAGS.has(u.text)
  ) {
    return true
  }
  if (ts.isArrayLiteralExpression(u)) {
    return u.elements.some((el) => {
      const item = unwrapExpr(el)
      return (
        (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)) &&
        BANNED_WORKFLOW_CATCH_TAGS.has(item.text)
      )
    })
  }
  return false
}

const hasSilentCatchTagsHandler = (
  objExpr: ts.Expression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
  optionAliases: NamespaceAliasSet,
): boolean => {
  const obj = unwrapExpr(objExpr)
  if (!ts.isObjectLiteralExpression(obj)) return false
  return obj.properties.some((prop) => {
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropName(prop.name)
      return (
        key !== undefined &&
        BANNED_WORKFLOW_CATCH_TAGS.has(key) &&
        isSilentCatchTagCallback(prop.initializer, sf, effectAliases, optionAliases)
      )
    }
    if (ts.isMethodDeclaration(prop)) {
      const key = getPropName(prop.name)
      if (key === undefined || !BANNED_WORKFLOW_CATCH_TAGS.has(key) || prop.body === undefined) {
        return false
      }
      if (hasFailOrDieEffect(prop, effectAliases)) return false
      const returnedExprs = collectDirectReturns(prop)
      return (
        returnedExprs.length > 0 &&
        returnedExprs.every((e) => isSilentSuccessEffectExpr(e, sf, effectAliases, optionAliases))
      )
    }
    return false
  })
}

/** Flags nullish/Option fallbacks on `Schema.decodeOption` or silent workflow-store `Effect.catchTag`/`catchTags`. */
export const isSilentDecodeOrStoreFallback = (node: ts.Node, sf: ts.SourceFile): boolean => {
  const effectAliases = collectNamespaceAliases(sf, "Effect", EFFECT_MODULE_SPECS)
  const optionAliases = collectNamespaceAliases(sf, "Option", OPTION_MODULE_SPECS)
  const schemaAliases = collectNamespaceAliases(sf, "Schema", SCHEMA_MODULE_SPECS)
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return isDecodeOrUnwrappedOptionExpr(node.left, optionAliases, schemaAliases)
  }
  if (!ts.isCallExpression(node)) return false
  if (isNamespaceMethodCall(node, optionAliases, "getOrElse")) {
    if (node.arguments.length >= 2 && node.arguments[0] !== undefined) {
      return isSchemaDecodeOptionCallExpr(node.arguments[0], schemaAliases)
    }
    if (node.arguments.length === 1) {
      const subject = findPipeSubjectForCall(node)
      return subject !== undefined && isSchemaDecodeOptionCallExpr(subject, schemaAliases)
    }
    return false
  }
  if (isEffectMethodCall(node, "catchTag", effectAliases)) {
    const isDataLast =
      node.arguments[0] !== undefined && matchesWorkflowStoreTagArg(node.arguments[0])
    const tagArg = isDataLast ? node.arguments[0] : node.arguments[1]
    const cbArg = isDataLast ? node.arguments[1] : node.arguments[2]
    return (
      tagArg !== undefined &&
      cbArg !== undefined &&
      matchesWorkflowStoreTagArg(tagArg) &&
      isSilentCatchTagCallback(cbArg, sf, effectAliases, optionAliases)
    )
  }
  if (isEffectMethodCall(node, "catchTags", effectAliases)) {
    const firstArg = node.arguments[0]
    const isDataLast = firstArg !== undefined && ts.isObjectLiteralExpression(unwrapExpr(firstArg))
    const handlersArg = node.arguments.length >= 2 && !isDataLast ? node.arguments[1] : firstArg
    return (
      handlersArg !== undefined &&
      hasSilentCatchTagsHandler(handlersArg, sf, effectAliases, optionAliases)
    )
  }
  return false
}

const isEnclosingProvisionOrAcquire = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
): boolean => {
  let curr: ts.Node | undefined = node.parent
  let child: ts.Node = node
  while (curr !== undefined) {
    if (
      ts.isCallExpression(curr) &&
      isEffectMethodCall(curr, "acquireRelease", effectAliases) &&
      curr.arguments[0] === child
    ) {
      return true
    }
    if (
      (ts.isFunctionDeclaration(curr) || ts.isMethodDeclaration(curr)) &&
      curr.name !== undefined &&
      /provision/i.test(curr.name.getText(sf))
    ) {
      return true
    }
    if (
      ts.isVariableDeclaration(curr) &&
      ts.isIdentifier(curr.name) &&
      /provision/i.test(curr.name.text)
    ) {
      return true
    }
    child = curr
    curr = curr.parent
  }
  return false
}

const LOG_METHOD_RE = /^log(?:Debug|Info|Warning|Error|Fatal|Trace)?$/

const isPureLoggingCallExpr = (
  call: ts.CallExpression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
): boolean => {
  const callee = unwrapExpr(call.expression)
  if (
    ts.isPropertyAccessExpression(callee) &&
    matchesNamespaceRoot(callee.expression, effectAliases) &&
    LOG_METHOD_RE.test(callee.name.text)
  ) {
    return true
  }
  const txt = callee.getText(sf)
  return txt === "process.stderr.write" || txt === "console.warn" || txt === "console.error"
}

const isLogOnlyHandler = (
  cb: ts.Expression,
  sf: ts.SourceFile,
  effectAliases: NamespaceAliasSet,
): boolean => {
  const fn = unwrapExpr(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let foundNonLogCall = false
  let foundLogCall = false
  const visit = (n: ts.Node): void => {
    if (foundNonLogCall) return
    if (ts.isCallExpression(n)) {
      if (isPureLoggingCallExpr(n, sf, effectAliases)) {
        foundLogCall = true
      } else {
        foundNonLogCall = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return foundLogCall && !foundNonLogCall
}

/** Flags `Effect.tapError(...)` rollback cleanup inside `provision*` or `Effect.acquireRelease` acquire blocks. */
export const isProvisionTapErrorRollback = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  const effectAliases = collectNamespaceAliases(sf, "Effect", EFFECT_MODULE_SPECS)
  if (!isEffectMethodCall(node, "tapError", effectAliases)) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined || !isEnclosingProvisionOrAcquire(node, sf, effectAliases)) return false
  return !isLogOnlyHandler(cb, sf, effectAliases)
}
