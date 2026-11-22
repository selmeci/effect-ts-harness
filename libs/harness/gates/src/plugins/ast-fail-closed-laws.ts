import { ts } from "@harness/graph"
import { isMemberCall, unwrapExpr } from "./ast-gate-law-helpers.js"

const containsIdentifierText = (root: ts.Node, targetName: string): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && n.text === targetName) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const isEffectMethodCall = (call: ts.CallExpression, methodName: string): boolean => {
  const u = unwrapExpr(call.expression)
  return (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === "Effect" &&
    u.name.text === methodName
  )
}

/** Flags `Effect.catchCause(...)` handlers in production `src/` lacking `isPureInterruptCause`. */
export const isUntypedCatchCauseWithoutInterruptGuard = (node: ts.CallExpression): boolean => {
  if (!isEffectMethodCall(node, "catchCause")) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined) return true
  const unwrappedCb = unwrapExpr(cb)
  return !containsIdentifierText(unwrappedCb, "isPureInterruptCause")
}

const isSchemaDecodeOptionCallExpr = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  if (
    isMemberCall(u, "Schema", "decodeOption") ||
    isMemberCall(u, "Schema", "decodeUnknownOption")
  ) {
    return true
  }
  const inner = unwrapExpr(u.expression)
  return (
    ts.isCallExpression(inner) &&
    (isMemberCall(inner, "Schema", "decodeOption") ||
      isMemberCall(inner, "Schema", "decodeUnknownOption"))
  )
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

const SILENT_EMPTY_PRIMITIVE_TEXTS = new Set(["[]", '""', "''", "{}", "undefined", "null", "false"])

const isSilentSuccessEffectExpr = (expr: ts.Expression, sf: ts.SourceFile): boolean => {
  const u = unwrapExpr(expr)
  if (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === "Effect" &&
    u.name.text === "void"
  ) {
    return true
  }
  if (ts.isCallExpression(u) && isEffectMethodCall(u, "succeed") && u.arguments[0] !== undefined) {
    const arg = unwrapExpr(u.arguments[0])
    const argText = arg.getText(sf).trim()
    if (SILENT_EMPTY_PRIMITIVE_TEXTS.has(argText)) return true
    if (ts.isIdentifier(arg) && arg.text === "undefined") return true
    if (ts.isCallExpression(arg) && isMemberCall(arg, "Option", "none")) return true
  }
  return false
}

const hasFailOrDieEffect = (root: ts.Node): boolean => {
  let hasNonSilentFail = false
  const visit = (n: ts.Node): void => {
    if (hasNonSilentFail) return
    if (
      ts.isCallExpression(n) &&
      (isEffectMethodCall(n, "fail") ||
        isEffectMethodCall(n, "failCause") ||
        isEffectMethodCall(n, "die"))
    ) {
      hasNonSilentFail = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return hasNonSilentFail
}

const isSilentCatchTagCallback = (cb: ts.Expression, sf: ts.SourceFile): boolean => {
  const fn = unwrapExpr(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  if (hasFailOrDieEffect(fn)) return false
  if (!ts.isBlock(fn.body)) {
    return isSilentSuccessEffectExpr(fn.body, sf)
  }
  const returnedExprs: Array<ts.Expression> = []
  const collectReturns = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      returnedExprs.push(n.expression)
    }
    ts.forEachChild(n, collectReturns)
  }
  collectReturns(fn.body)
  return returnedExprs.length > 0 && returnedExprs.every((e) => isSilentSuccessEffectExpr(e, sf))
}

const BANNED_WORKFLOW_CATCH_TAGS = new Set([
  "WorkflowStoreUnavailableError",
  "WriterLeaseHeldError",
])

const matchesWorkflowStoreTagArg = (arg: ts.Expression): boolean => {
  const u = unwrapExpr(arg)
  return (
    (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) &&
    BANNED_WORKFLOW_CATCH_TAGS.has(u.text)
  )
}

/** Flags nullish/Option fallbacks on `Schema.decodeOption` or silent workflow-store `Effect.catchTag`. */
export const isSilentDecodeOrStoreFallback = (node: ts.Node, sf: ts.SourceFile): boolean => {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return isSchemaDecodeOptionCallExpr(node.left)
  }
  if (!ts.isCallExpression(node)) return false
  if (isMemberCall(node, "Option", "getOrElse")) {
    if (node.arguments.length >= 2 && node.arguments[0] !== undefined) {
      return isSchemaDecodeOptionCallExpr(node.arguments[0])
    }
    if (node.arguments.length === 1) {
      const subject = findPipeSubjectForCall(node)
      return subject !== undefined && isSchemaDecodeOptionCallExpr(subject)
    }
    return false
  }
  if (isEffectMethodCall(node, "catchTag")) {
    const tagArg = node.arguments.length >= 3 ? node.arguments[1] : node.arguments[0]
    const cbArg = node.arguments.length >= 3 ? node.arguments[2] : node.arguments[1]
    return (
      tagArg !== undefined &&
      cbArg !== undefined &&
      matchesWorkflowStoreTagArg(tagArg) &&
      isSilentCatchTagCallback(cbArg, sf)
    )
  }
  return false
}

const isEnclosingProvisionOrAcquire = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  let curr: ts.Node | undefined = node.parent
  let child: ts.Node = node
  while (curr !== undefined) {
    if (
      ts.isCallExpression(curr) &&
      isEffectMethodCall(curr, "acquireRelease") &&
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

const isPureLoggingCallExpr = (call: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const txt = unwrapExpr(call.expression).getText(sf)
  return (
    /^Effect\.log(?:Debug|Info|Warning|Error|Fatal|Trace)?$/.test(txt) ||
    txt === "process.stderr.write" ||
    txt === "console.warn" ||
    txt === "console.error"
  )
}

const isLogOnlyHandler = (cb: ts.Expression, sf: ts.SourceFile): boolean => {
  const fn = unwrapExpr(cb)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let foundNonLogCall = false
  let foundLogCall = false
  const visit = (n: ts.Node): void => {
    if (foundNonLogCall) return
    if (ts.isCallExpression(n)) {
      if (isPureLoggingCallExpr(n, sf)) {
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
  if (!isEffectMethodCall(node, "tapError")) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined || !isEnclosingProvisionOrAcquire(node, sf)) return false
  return !isLogOnlyHandler(cb, sf)
}
