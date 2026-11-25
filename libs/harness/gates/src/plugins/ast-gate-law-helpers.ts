import { ts } from "@harness/graph"

export const unwrapExpr = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isSatisfiesExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

export const ALLOWED_PURE_NODE_SUBPATHS = new Set(
  "path path/posix path/win32 crypto url".split(" "),
)

export const BANNED_BARE_NODE_BUILTINS = new Set(
  "fs fs/promises child_process net os http https http2 tls dgram dns dns/promises cluster worker_threads sqlite module vm readline readline/promises inspector inspector/promises v8 perf_hooks process repl tty wasi zlib stream stream/promises stream/web stream/consumers timers timers/promises async_hooks diagnostics_channel events buffer util util/types assert assert/strict querystring string_decoder punycode trace_events domain constants sys".split(
    " ",
  ),
)

export const isBannedNodeBuiltinSpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim()
  return trimmed.startsWith("node:")
    ? !ALLOWED_PURE_NODE_SUBPATHS.has(trimmed.slice("node:".length))
    : BANNED_BARE_NODE_BUILTINS.has(trimmed)
}

export const isSilentFsFallbackCheckedPath = (normPath: string): boolean =>
  !/(?:^|\/)libs\/harness\/graph\/src\/extractor\/compiler-session\.ts$/.test(normPath) &&
  /(?:^|\/)(?:libs\/harness\/(?:gates|graph|infra)\/src|apps\/harness-(?:cli|mcp)\/src)\//.test(
    normPath,
  )

const FS_READ_SYNC_NAMES = new Set(["readTextSync", "readdirSync", "readBytesSync"])

const isProcExemptFsArg = (arg: ts.Expression | undefined): boolean => {
  if (arg === undefined) return false
  const u = unwrapExpr(arg)
  if (ts.isIdentifier(u) && u.text === "procCmdlinePath") return true
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u))
    return u.text.includes("/proc/")
  return (
    ts.isTemplateExpression(u) &&
    (u.head.text.includes("/proc/") ||
      u.templateSpans.some((s) => s.literal.text.includes("/proc/")))
  )
}

export const hasResultTryFsReadText = (text: string): boolean => {
  if (!text.includes("Result.try") || !/(?:readTextSync|readdirSync|readBytesSync)/.test(text)) {
    return false
  }
  const sf = ts.createSourceFile("expr.ts", text, ts.ScriptTarget.Latest, true)
  let hasResultTry = false
  let hasNonExemptFsRead = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isMemberCall(node, "Result", "try")) hasResultTry = true
      const callee = unwrapExpr(node.expression)
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      if (
        name !== undefined &&
        FS_READ_SYNC_NAMES.has(name) &&
        !isProcExemptFsArg(node.arguments[0])
      ) {
        hasNonExemptFsRead = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hasResultTry && hasNonExemptFsRead
}

export const isPureTierProcessEnvBannedPath = (normPath: string): boolean => {
  const m = /(?:^|\/)(libs\/[^/]+\/[^/]+\/src\/.*)$/.exec(normPath)
  return m?.[1] !== undefined && !/^libs\/[^/]+\/infra\/src\//.test(m[1])
}

const isCauseMemberCallWithArg = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  methodName: string,
  expectedArgText: string,
): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u) || !isMemberCall(u, "Cause", methodName)) return false
  const arg = u.arguments[0]
  return arg !== undefined && unwrapExpr(arg).getText(sf) === expectedArgText
}

const collectAndTerms = (expr: ts.Expression, out: Array<ts.Expression>): void => {
  const u = unwrapExpr(expr)
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    collectAndTerms(u.left, out)
    collectAndTerms(u.right, out)
    return
  }
  out.push(u)
}

const isCalleeOfCallExpression = (node: ts.PropertyAccessExpression): boolean => {
  let curr: ts.Node = node
  let parent: ts.Node | undefined = node.parent
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    curr = parent
    parent = parent.parent
  }
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === curr
}

export const isBareCauseHasInterruptsNode = (
  node: ts.Node,
  sf: ts.SourceFile,
  normalizedFilePath: string,
): boolean => {
  if (/(?:^|\/)libs\/harness\/contract\/src\/workspace-and-process\.ts$/.test(normalizedFilePath))
    return false
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Cause" &&
    (node.name.text === "hasInterrupts" || node.name.text === "hasInterruptsOnly")
  ) {
    return !isCalleeOfCallExpression(node)
  }
  if (!ts.isCallExpression(node)) return false
  const expr = unwrapExpr(node.expression)
  if (
    !ts.isPropertyAccessExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "Cause" ||
    (expr.name.text !== "hasInterrupts" && expr.name.text !== "hasInterruptsOnly")
  ) {
    return false
  }
  if (expr.name.text === "hasInterruptsOnly" || node.arguments[0] === undefined) return true
  const argText = unwrapExpr(node.arguments[0]).getText(sf)
  let root: ts.Expression = node
  let curr: ts.Node | undefined = node.parent
  while (
    curr !== undefined &&
    (ts.isParenthesizedExpression(curr) ||
      (ts.isBinaryExpression(curr) &&
        curr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken))
  ) {
    root = curr
    curr = curr.parent
  }
  const terms: Array<ts.Expression> = []
  collectAndTerms(root, terms)
  let hasNegFails = false
  let hasNegDies = false
  for (const t of terms) {
    if (ts.isPrefixUnaryExpression(t) && t.operator === ts.SyntaxKind.ExclamationToken) {
      if (isCauseMemberCallWithArg(t.operand, sf, "hasFails", argText)) hasNegFails = true
      if (isCauseMemberCallWithArg(t.operand, sf, "hasDies", argText)) hasNegDies = true
    }
  }
  return !(hasNegFails && hasNegDies)
}

export const isBareCauseHasInterruptsCall = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
  normalizedFilePath: string,
): boolean => isBareCauseHasInterruptsNode(node, sf, normalizedFilePath)

const isStaticStringLiteralText = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
}

export const isProcessTargetExpression = (expr: ts.Expression): boolean => {
  const target = unwrapExpr(expr)
  if (ts.isIdentifier(target) && target.text === "process") return true
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    const memberName = getStaticMemberName(target)
    return (
      memberName === "process" &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === "globalThis"
    )
  }
  return false
}

export const isProcessEnvExpression = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  return (
    (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) &&
    getStaticMemberName(u) === "env" &&
    isProcessTargetExpression(u.expression)
  )
}

export const isProcessEnvDestructuring = (node: ts.Node): boolean => {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    node.initializer === undefined ||
    !isProcessTargetExpression(node.initializer)
  ) {
    return false
  }
  return node.name.elements.some((el) => {
    const propName = el.propertyName ?? el.name
    if (ts.isIdentifier(propName) || ts.isStringLiteral(propName)) return propName.text === "env"
    return (
      ts.isComputedPropertyName(propName) &&
      isStaticStringLiteralText(propName.expression) === "env"
    )
  })
}

export const isLiteralVitestKey = (expr: ts.Expression): boolean =>
  isStaticStringLiteralText(expr) === "VITEST"

export const isMemberCall = (
  callExpr: ts.CallExpression,
  objName: string,
  methodName: string,
): boolean => {
  const callee = unwrapExpr(callExpr.expression)
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === objName &&
    callee.name.text === methodName
  )
}

const isEffectGenBody = (body: ts.ConciseBody): boolean => {
  let exprNode: ts.Expression = unwrapExpr(
    ts.isBlock(body)
      ? body.statements.length === 1 &&
        body.statements[0] !== undefined &&
        ts.isReturnStatement(body.statements[0]) &&
        body.statements[0].expression !== undefined
        ? body.statements[0].expression
        : (ts.factory.createIdentifier("none") as ts.Expression)
      : body,
  )
  return ts.isCallExpression(exprNode) && isMemberCall(exprNode, "Effect", "gen")
}

export const isDoubleWrappedEffectFn = (callExpr: ts.CallExpression): boolean => {
  const unwrappedExpr = unwrapExpr(callExpr.expression)
  const isWrappedFn =
    (ts.isCallExpression(unwrappedExpr) && isMemberCall(unwrappedExpr, "Effect", "fn")) ||
    isMemberCall(callExpr, "Effect", "fnUntraced")
  if (!isWrappedFn) return false
  const fnArg = callExpr.arguments[0]
  if (fnArg === undefined) return false
  const unwrappedArg = unwrapExpr(fnArg)
  return (
    (ts.isArrowFunction(unwrappedArg) || ts.isFunctionExpression(unwrappedArg)) &&
    isEffectGenBody(unwrappedArg.body)
  )
}

const EFFECT_CONSTRUCTORS = new Set(
  "fn fnUntraced gen sync suspend try tryPromise promise".split(" "),
)
const LAYER_CONSTRUCTORS = new Set(["effect", "succeed", "sync"])

export const isBannedParentConstructor = (callExpr: ts.CallExpression): boolean => {
  let callee = unwrapExpr(callExpr.expression)
  if (ts.isCallExpression(callee)) callee = unwrapExpr(callee.expression)
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const objName = callee.expression.text
    const propName = callee.name.text
    return (
      (objName === "Effect" && EFFECT_CONSTRUCTORS.has(propName)) ||
      (objName === "Layer" && LAYER_CONSTRUCTORS.has(propName))
    )
  }
  return false
}

export const getRootStaticObjectIdentifier = (
  expr: ts.Expression,
  staticObjectNames: ReadonlySet<string>,
): ts.Identifier | undefined => {
  let base = unwrapExpr(expr)
  if (!ts.isPropertyAccessExpression(base) && !ts.isElementAccessExpression(base)) return undefined
  while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
    base = unwrapExpr(base.expression)
  }
  return ts.isIdentifier(base) && staticObjectNames.has(base.text) ? base : undefined
}

export const getMutatedStaticObjectName = (
  node: ts.Node,
  staticObjectNames: ReadonlySet<string>,
): string | undefined => {
  if (staticObjectNames.size === 0) return undefined
  const mutatedTarget =
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ? unwrapExpr(node.left)
      : ts.isDeleteExpression(node)
        ? unwrapExpr(node.expression)
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
              node.operator === ts.SyntaxKind.MinusMinusToken)
          ? unwrapExpr(node.operand)
          : undefined
  return mutatedTarget !== undefined
    ? getRootStaticObjectIdentifier(mutatedTarget, staticObjectNames)?.text
    : undefined
}

export const isAllOptionalSchemaStructCall = (node: ts.Node): boolean => {
  if (!ts.isCallExpression(node) || !isMemberCall(node, "Schema", "Struct")) return false
  const firstArg = node.arguments[0]
  if (firstArg === undefined) return false
  const obj = unwrapExpr(firstArg)
  if (!ts.isObjectLiteralExpression(obj) || obj.properties.length === 0) return false
  return obj.properties.every((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false
    const val = unwrapExpr(prop.initializer)
    return ts.isCallExpression(val) && isMemberCall(val, "Schema", "optional")
  })
}

export const isConditionalPortBindBailout = (node: ts.Node): boolean => {
  if (!ts.isIfStatement(node) || node.elseStatement !== undefined) return false
  const test = unwrapExpr(node.expression)
  if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) {
    return false
  }
  const operand = unwrapExpr(test.operand)
  if (!ts.isIdentifier(operand) || !/bound/i.test(operand.text)) return false
  if (ts.isReturnStatement(node.thenStatement)) return true
  return (
    ts.isBlock(node.thenStatement) &&
    node.thenStatement.statements.length === 1 &&
    node.thenStatement.statements[0] !== undefined &&
    ts.isReturnStatement(node.thenStatement.statements[0])
  )
}

export const isVacuousLengthNonNegativeAssertion = (node: ts.Node): boolean => {
  if (!ts.isCallExpression(node)) return false
  const callee = unwrapExpr(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "toBeGreaterThanOrEqual") {
    return false
  }
  if (node.arguments.length !== 1 || node.arguments[0] === undefined) return false
  const arg0 = unwrapExpr(node.arguments[0])
  if (!ts.isNumericLiteral(arg0) || arg0.text !== "0") return false
  const expectCall = unwrapExpr(callee.expression)
  if (
    !ts.isCallExpression(expectCall) ||
    expectCall.arguments.length !== 1 ||
    expectCall.arguments[0] === undefined
  ) {
    return false
  }
  const expectCallee = unwrapExpr(expectCall.expression)
  if (!ts.isIdentifier(expectCallee) || expectCallee.text !== "expect") return false
  const expectArg = unwrapExpr(expectCall.arguments[0])
  return ts.isPropertyAccessExpression(expectArg) && expectArg.name.text === "length"
}

const PERSISTENCE_RESULT_CALLEES = new Set([
  "writeGraphHeadMeta",
  "updateGraphHeadCursor",
  "writeServerMetaAtomic",
])

const isPersistenceResultCallExpr = (expr: ts.Expression): boolean => {
  const unwrapped = unwrapExpr(expr)
  if (ts.isVoidExpression(unwrapped)) return isPersistenceResultCallExpr(unwrapped.expression)
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return (
      isPersistenceResultCallExpr(unwrapped.left) || isPersistenceResultCallExpr(unwrapped.right)
    )
  }
  if (!ts.isCallExpression(unwrapped)) return false
  const name = getCalleeTerminalName(unwrapped.expression)
  return name !== undefined && PERSISTENCE_RESULT_CALLEES.has(name)
}

export const isDiscardedPersistenceCallStatement = (node: ts.Node): boolean =>
  ts.isExpressionStatement(node) && isPersistenceResultCallExpr(node.expression)

const isProcessRootExpr = (expr: ts.Expression, processAliases?: ReadonlySet<string>): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return u.text === "process" || (processAliases?.has(u.text) ?? false)
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    const memberName = getStaticMemberName(u)
    const base = unwrapExpr(u.expression)
    return memberName === "process" && ts.isIdentifier(base) && base.text === "globalThis"
  }
  return false
}

export const getStaticMemberName = (node: ts.Expression): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return ts.isElementAccessExpression(node)
    ? isStaticStringLiteralText(node.argumentExpression)
    : undefined
}

const isProcessExitReference = (
  expr: ts.Expression,
  processAliases?: ReadonlySet<string>,
  exitAliases?: ReadonlySet<string>,
): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u) && (exitAliases?.has(u.text) ?? false)) return true
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    const memberName = getStaticMemberName(u)
    return (
      (memberName === "exit" || memberName === "reallyExit") &&
      isProcessRootExpr(u.expression, processAliases)
    )
  }
  return false
}

export const collectProcessExitAliases = (
  sourceFile: ts.SourceFile,
): { readonly processAliases: Set<string>; readonly exitAliases: Set<string> } => {
  const processAliases = new Set<string>()
  const exitAliases = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (isProcessRootExpr(node.initializer, processAliases)) {
        if (ts.isIdentifier(node.name)) processAliases.add(node.name.text)
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const p = el.propertyName ?? el.name
            const name = ts.isIdentifier(p) || ts.isStringLiteral(p) ? p.text : undefined
            if ((name === "exit" || name === "reallyExit") && ts.isIdentifier(el.name)) {
              exitAliases.add(el.name.text)
            }
          }
        }
        return
      }
      if (
        ts.isIdentifier(node.name) &&
        isProcessExitReference(node.initializer, processAliases, exitAliases)
      ) {
        exitAliases.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { processAliases, exitAliases }
}

export const isProcessExitCall = (
  node: ts.CallExpression,
  processAliases?: ReadonlySet<string>,
  exitAliases?: ReadonlySet<string>,
): boolean => {
  if (isProcessExitReference(node.expression, processAliases, exitAliases)) return true
  const callee = unwrapExpr(node.expression)
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    getStaticMemberName(callee) === "apply"
  ) {
    const baseCallee = unwrapExpr(callee.expression)
    return (
      ts.isIdentifier(baseCallee) &&
      baseCallee.text === "Reflect" &&
      node.arguments[0] !== undefined &&
      isProcessExitReference(node.arguments[0], processAliases, exitAliases)
    )
  }
  return false
}

const isSilentEmptyFallbackFn = (
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  allowExtendedEmptyLiterals: boolean,
): boolean => {
  const fn = unwrapExpr(expr)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let bodyText = fn.body.getText(sourceFile).trim()
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return false
    const only = fn.body.statements[0]
    if (only === undefined || !ts.isReturnStatement(only) || only.expression === undefined) {
      return false
    }
    bodyText = only.expression.getText(sourceFile).trim()
  }
  if (bodyText === '""' || bodyText === "''" || bodyText === "[]") return true
  return (
    allowExtendedEmptyLiterals &&
    (bodyText === "{}" || bodyText === "undefined" || bodyText === "false")
  )
}

const hasFailureTagPattern = (expr: ts.Expression): boolean => {
  const obj = unwrapExpr(expr)
  if (!ts.isObjectLiteralExpression(obj)) return false
  return obj.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false
    const propName =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
    return propName === "_tag" && isStaticStringLiteralText(prop.initializer) === "Failure"
  })
}

const findRootMatchArgText = (
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string | undefined => {
  let curr: ts.Expression = unwrapExpr(callExpr.expression)
  while (ts.isPropertyAccessExpression(curr) && ts.isCallExpression(curr.expression)) {
    const innerCall = curr.expression
    const innerCallee = unwrapExpr(innerCall.expression)
    if (ts.isIdentifier(innerCallee) && innerCallee.text === "match") {
      return innerCall.arguments[0]?.getText(sourceFile)
    }
    curr = innerCallee
  }
  return undefined
}

const isPipeGetOrElseArg = (arg: ts.Expression, sf: ts.SourceFile): boolean =>
  ts.isCallExpression(arg) &&
  unwrapExpr(arg.expression).getText(sf) === "Result.getOrElse" &&
  arg.arguments.length === 1 &&
  arg.arguments[0] !== undefined &&
  isSilentEmptyFallbackFn(arg.arguments[0], sf, true)

export const isSilentGateFsFallbackCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee) && callee.text === "safeFs") return true
  const calleeText = callee.getText(sf)
  if (
    calleeText === "Result.getOrElse" &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sf)) &&
    isSilentEmptyFallbackFn(node.arguments[1], sf, false)
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "pipe" &&
    hasResultTryFsReadText(callee.expression.getText(sf)) &&
    node.arguments.some((a) => isPipeGetOrElseArg(a, sf))
  ) {
    return true
  }
  if (
    ts.isIdentifier(callee) &&
    callee.text === "pipe" &&
    node.arguments[0] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sf)) &&
    node.arguments.slice(1).some((a) => isPipeGetOrElseArg(a, sf))
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "with" &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasFailureTagPattern(node.arguments[0]) &&
    isSilentEmptyFallbackFn(node.arguments[1], sf, true)
  ) {
    const matchArgText = findRootMatchArgText(node, sf)
    return matchArgText !== undefined && hasResultTryFsReadText(matchArgText)
  }
  return false
}

export const isDummyEffectVoidYield = (expr: ts.Expression, sf: ts.SourceFile): boolean => {
  const inner = unwrapExpr(expr)
  return (
    (ts.isPropertyAccessExpression(inner) &&
      inner.expression.getText(sf).trim() === "Effect" &&
      inner.name.text === "void") ||
    (ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.expression.getText(sf).trim() === "Effect" &&
      inner.expression.name.text === "asVoid")
  )
}

const CATCH_DEFECT_REPORTING_TOKENS =
  "stderr.write logWarning logError Effect.log console.error console.warn Effect.fail Effect.die makeLspExceptionReport ExceptionReport".split(
    " ",
  )

const isCatchCauseOrExitRunCallee = (c: string): boolean =>
  /(?:^|\.)(?:catchCause|runPromiseExit|runSyncExit)$/.test(c)

const callOrReceiverMatchesExitOrCatch = (call: ts.CallExpression, sf: ts.SourceFile): boolean => {
  let curr: ts.CallExpression | undefined = call
  while (curr !== undefined) {
    const callee = curr.expression.getText(sf)
    if (isCatchCauseOrExitRunCallee(callee)) return true
    if (
      callee === "match" &&
      curr.arguments.some(
        (a) => ts.isCallExpression(a) && isCatchCauseOrExitRunCallee(a.expression.getText(sf)),
      )
    ) {
      return true
    }
    curr =
      ts.isPropertyAccessExpression(curr.expression) &&
      ts.isCallExpression(curr.expression.expression)
        ? curr.expression.expression
        : undefined
  }
  return false
}

export const isCatchCauseInterruptsOnlyCall = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  if (node.expression.getText(sf) !== "Cause.hasInterruptsOnly") return false
  let crossedFn = false
  const nodeStart = node.getStart(sf)
  for (let anc: ts.Node | undefined = node.parent; anc !== undefined; anc = anc.parent) {
    if (ts.isCallExpression(anc) && callOrReceiverMatchesExitOrCatch(anc, sf)) return true
    if (!crossedFn && (ts.isBlock(anc) || ts.isSourceFile(anc))) {
      for (const stmt of anc.statements) {
        if (stmt.getStart(sf) >= nodeStart) break
        if (/\b(?:Effect\.)?(?:runSyncExit|runPromiseExit)\s*\(/.test(stmt.getText(sf))) return true
      }
    }
    if (ts.isFunctionLike(anc)) crossedFn = true
  }
  return false
}

export const isSilentCatchDefectCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = node.expression.getText(sf)
  if (callee !== "Effect.catchDefect" && !callee.endsWith(".catchDefect")) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  return cb !== undefined && !CATCH_DEFECT_REPORTING_TOKENS.some((t) => cb.getText(sf).includes(t))
}

export const isIgnoredChmodPermissionCall = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  if (!/(?:^|\.)(?:chmodSync|fchmodSync)$/.test(node.expression.getText(sf))) return false
  let depth = 0
  for (
    let anc: ts.Node | undefined = node.parent;
    anc !== undefined && depth < 6;
    anc = anc.parent
  ) {
    if (ts.isFunctionDeclaration(anc) || ts.isMethodDeclaration(anc)) break
    if (!ts.isCallExpression(anc)) continue
    depth += 1
    const c = anc.expression.getText(sf)
    if (/(?:^|\.)(?:ignore|orElseSucceed)$/.test(c)) return true
    if (
      c.endsWith(".pipe") &&
      anc.arguments.some((a) => /Effect\.(?:ignore|orElseSucceed)/.test(a.getText(sf)))
    ) {
      return true
    }
  }
  return false
}

export const DOT_HARNESS_WRITE_CALLEES = new Set(
  "saveGraphSnapshot saveGraphSnapshotEffect syncToOmnigraphAndSnapshot writeFileSync writeTextSync appendFileSync appendTextSync writeTextWithModeSync".split(
    " ",
  ),
)

export const getCalleeTerminalName = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  return ts.isIdentifier(u) ? u.text : ts.isPropertyAccessExpression(u) ? u.name.text : undefined
}

const isDotHarnessRelativeLiteralText = (text: string): boolean =>
  /^(?:\.[\\/])?\.harness(?:[\\/]|$)/.test(text)

const getJoinOrResolveBaseArg = (node: ts.CallExpression): ts.Expression | undefined => {
  const name = getCalleeTerminalName(node.expression)
  return (name === "join" || name === "resolve") && node.arguments.length >= 2
    ? node.arguments[0]
    : undefined
}

const isProcessCwdCall = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u) || u.arguments.length > 0) return false
  const callee = unwrapExpr(u.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "cwd") return false
  const recv = unwrapExpr(callee.expression)
  return ts.isIdentifier(recv) && recv.text === "process"
}

export const isProcessCwdDotHarnessJoinOrResolve = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  const baseArg = getJoinOrResolveBaseArg(node)
  return (
    baseArg !== undefined &&
    isProcessCwdCall(baseArg) &&
    node.arguments
      .slice(1)
      .some((arg) => /(?:^|["'`\\/])\.harness(?:[\\/"'`]|$)/.test(arg.getText(sf)))
  )
}

const isNonCwdJoinOrResolveCall = (node: ts.CallExpression): boolean => {
  const baseArg = getJoinOrResolveBaseArg(node)
  if (baseArg === undefined || isProcessCwdCall(baseArg)) return false
  const baseStr = isStaticStringLiteralText(baseArg)
  return (
    baseStr === undefined ||
    (!isDotHarnessRelativeLiteralText(baseStr) &&
      baseStr !== "." &&
      baseStr !== "./" &&
      baseStr !== "")
  )
}

export const hasUnisolatedDotHarnessArgExpr = (expr: ts.Expression, sf: ts.SourceFile): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u))
    return isDotHarnessRelativeLiteralText(u.text)
  if (ts.isTemplateExpression(u)) return isDotHarnessRelativeLiteralText(u.head.text)
  if (ts.isObjectLiteralExpression(u)) {
    return u.properties.some((p) =>
      ts.isPropertyAssignment(p)
        ? hasUnisolatedDotHarnessArgExpr(p.initializer, sf)
        : ts.isSpreadAssignment(p) && hasUnisolatedDotHarnessArgExpr(p.expression, sf),
    )
  }
  if (ts.isArrayLiteralExpression(u)) {
    return u.elements.some((el) =>
      hasUnisolatedDotHarnessArgExpr(ts.isSpreadElement(el) ? el.expression : el, sf),
    )
  }
  if (ts.isConditionalExpression(u)) {
    return (
      hasUnisolatedDotHarnessArgExpr(u.whenTrue, sf) ||
      hasUnisolatedDotHarnessArgExpr(u.whenFalse, sf)
    )
  }
  if (ts.isBinaryExpression(u)) {
    if (hasUnisolatedDotHarnessArgExpr(u.left, sf)) return true
    if (u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const leftTxt = isStaticStringLiteralText(u.left)
      return (
        (leftTxt === "" || leftTxt === "." || leftTxt === "./") &&
        hasUnisolatedDotHarnessArgExpr(u.right, sf)
      )
    }
    return hasUnisolatedDotHarnessArgExpr(u.right, sf)
  }
  if (ts.isCallExpression(u)) {
    if (isProcessCwdDotHarnessJoinOrResolve(u, sf) || isNonCwdJoinOrResolveCall(u)) return false
    return u.arguments.some((a) => hasUnisolatedDotHarnessArgExpr(a, sf))
  }
  return false
}

export {
  collectEffectPromiseAliases,
  type EffectPromiseAliases,
  isUnhandledEffectPromiseCall,
} from "./ast-effect-promise-law.js"
