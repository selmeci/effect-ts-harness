import { ts } from "@harness/graph"

const unwrapExpr = (expr: ts.Expression): ts.Expression => {
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

export const ALLOWED_PURE_NODE_SUBPATHS = new Set([
  "path",
  "path/posix",
  "path/win32",
  "crypto",
  "url",
])

export const BANNED_BARE_NODE_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "os",
  "http",
  "https",
  "http2",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "cluster",
  "worker_threads",
  "sqlite",
  "module",
  "vm",
  "readline",
  "readline/promises",
  "inspector",
  "inspector/promises",
  "v8",
  "perf_hooks",
  "process",
  "repl",
  "tty",
  "wasi",
  "zlib",
  "stream",
  "stream/promises",
  "stream/web",
  "stream/consumers",
  "timers",
  "timers/promises",
  "async_hooks",
  "diagnostics_channel",
  "events",
  "buffer",
  "util",
  "util/types",
  "assert",
  "assert/strict",
  "querystring",
  "string_decoder",
  "punycode",
  "trace_events",
  "domain",
  "constants",
  "sys",
])

export const isBannedNodeBuiltinSpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim()
  if (trimmed.startsWith("node:")) {
    return !ALLOWED_PURE_NODE_SUBPATHS.has(trimmed.slice("node:".length))
  }
  return BANNED_BARE_NODE_BUILTINS.has(trimmed)
}

export const isSilentFsFallbackCheckedPath = (normPath: string): boolean => {
  if (/(?:^|\/)libs\/harness\/graph\/src\/extractor\/compiler-session\.ts$/.test(normPath)) {
    return false
  }
  return /(?:^|\/)(?:libs\/harness\/(?:gates|graph)\/src|apps\/harness-(?:cli|mcp)\/src)\//.test(
    normPath,
  )
}

const FS_READ_SYNC_NAMES = new Set(["readTextSync", "readdirSync", "readBytesSync"])

const isProcExemptFsArg = (arg: ts.Expression | undefined): boolean => {
  if (arg === undefined) return false
  const u = unwrapExpr(arg)
  if (ts.isIdentifier(u) && u.text === "procCmdlinePath") return true
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) {
    return u.text.includes("/proc/")
  }
  if (ts.isTemplateExpression(u)) {
    return (
      u.head.text.includes("/proc/") ||
      u.templateSpans.some((s) => s.literal.text.includes("/proc/"))
    )
  }
  return false
}

const getFsReadSyncCall = (call: ts.CallExpression): boolean => {
  const callee = unwrapExpr(call.expression)
  if (ts.isIdentifier(callee)) return FS_READ_SYNC_NAMES.has(callee.text)
  if (ts.isPropertyAccessExpression(callee)) return FS_READ_SYNC_NAMES.has(callee.name.text)
  return false
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
      if (isMemberCall(node, "Result", "try")) {
        hasResultTry = true
      }
      if (getFsReadSyncCall(node) && !isProcExemptFsArg(node.arguments[0])) {
        hasNonExemptFsRead = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hasResultTry && hasNonExemptFsRead
}

export const isPureTierProcessEnvBannedPath = (normPath: string): boolean => {
  const libsMatch = /(?:^|\/)(libs\/[^/]+\/[^/]+\/src\/.*)$/.exec(normPath)
  if (libsMatch === null) return false
  const relLibsPath = libsMatch[1]
  if (relLibsPath === undefined) return false
  return !/^libs\/[^/]+\/infra\/src\//.test(relLibsPath)
}

const isCauseMemberCallWithArg = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  methodName: string,
  expectedArgText: string,
): boolean => {
  const unwrapped = unwrapExpr(expr)
  if (!ts.isCallExpression(unwrapped)) return false
  if (!isMemberCall(unwrapped, "Cause", methodName)) return false
  const arg = unwrapped.arguments[0]
  return arg !== undefined && unwrapExpr(arg).getText(sf) === expectedArgText
}

const collectAndTerms = (expr: ts.Expression, out: Array<ts.Expression>): void => {
  const unwrapped = unwrapExpr(expr)
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    collectAndTerms(unwrapped.left, out)
    collectAndTerms(unwrapped.right, out)
    return
  }
  out.push(unwrapped)
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
  if (/(?:^|\/)libs\/harness\/contract\/src\/workspace-and-process\.ts$/.test(normalizedFilePath)) {
    return false
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Cause" &&
    (node.name.text === "hasInterrupts" || node.name.text === "hasInterruptsOnly")
  ) {
    return !isCalleeOfCallExpression(node)
  }
  if (!ts.isCallExpression(node)) {
    return false
  }
  const expr = unwrapExpr(node.expression)
  if (
    !ts.isPropertyAccessExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "Cause" ||
    (expr.name.text !== "hasInterrupts" && expr.name.text !== "hasInterruptsOnly")
  ) {
    return false
  }
  if (expr.name.text === "hasInterruptsOnly") {
    return true
  }
  const firstArg = node.arguments[0]
  if (firstArg === undefined) return true
  const argText = unwrapExpr(firstArg).getText(sf)
  let root: ts.Expression = node
  let curr: ts.Node | undefined = node.parent
  while (curr !== undefined) {
    if (ts.isParenthesizedExpression(curr)) {
      root = curr
      curr = curr.parent
      continue
    }
    if (
      ts.isBinaryExpression(curr) &&
      curr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      root = curr
      curr = curr.parent
      continue
    }
    break
  }
  const terms: Array<ts.Expression> = []
  collectAndTerms(root, terms)
  let hasNegatedFails = false
  let hasNegatedDies = false
  for (const term of terms) {
    if (ts.isPrefixUnaryExpression(term) && term.operator === ts.SyntaxKind.ExclamationToken) {
      if (isCauseMemberCallWithArg(term.operand, sf, "hasFails", argText)) {
        hasNegatedFails = true
      }
      if (isCauseMemberCallWithArg(term.operand, sf, "hasDies", argText)) {
        hasNegatedDies = true
      }
    }
  }
  return !(hasNegatedFails && hasNegatedDies)
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
  if (ts.isIdentifier(target) && target.text === "process") {
    return true
  }
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "globalThis" &&
    target.name.text === "process"
  ) {
    return true
  }
  return (
    ts.isElementAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "globalThis" &&
    isStaticStringLiteralText(target.argumentExpression) === "process"
  )
}

export const isProcessEnvExpression = (expr: ts.Expression): boolean => {
  const unwrapped = unwrapExpr(expr)
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "env") {
    return isProcessTargetExpression(unwrapped.expression)
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    isStaticStringLiteralText(unwrapped.argumentExpression) === "env"
  ) {
    return isProcessTargetExpression(unwrapped.expression)
  }
  return false
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
    if (ts.isIdentifier(propName) || ts.isStringLiteral(propName)) {
      return propName.text === "env"
    }
    if (ts.isComputedPropertyName(propName)) {
      return isStaticStringLiteralText(propName.expression) === "env"
    }
    return false
  })
}

export const isLiteralVitestKey = (expr: ts.Expression): boolean => {
  const unwrapped = unwrapExpr(expr)
  return (
    (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) &&
    unwrapped.text === "VITEST"
  )
}

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
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return false
    const onlyStmt = body.statements[0]
    if (
      onlyStmt === undefined ||
      !ts.isReturnStatement(onlyStmt) ||
      onlyStmt.expression === undefined
    ) {
      return false
    }
    const returnedExpr = unwrapExpr(onlyStmt.expression)
    return ts.isCallExpression(returnedExpr) && isMemberCall(returnedExpr, "Effect", "gen")
  }
  const bodyExpr = unwrapExpr(body)
  return ts.isCallExpression(bodyExpr) && isMemberCall(bodyExpr, "Effect", "gen")
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
  if (!ts.isArrowFunction(unwrappedArg) && !ts.isFunctionExpression(unwrappedArg)) return false
  return isEffectGenBody(unwrappedArg.body)
}

const EFFECT_CONSTRUCTORS = new Set([
  "fn",
  "fnUntraced",
  "gen",
  "sync",
  "suspend",
  "try",
  "tryPromise",
  "promise",
])
const LAYER_CONSTRUCTORS = new Set(["effect", "succeed", "sync"])

export const isBannedParentConstructor = (callExpr: ts.CallExpression): boolean => {
  let callee = unwrapExpr(callExpr.expression)
  if (ts.isCallExpression(callee)) {
    callee = unwrapExpr(callee.expression)
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const objName = callee.expression.text
    const propName = callee.name.text
    if (objName === "Effect" && EFFECT_CONSTRUCTORS.has(propName)) return true
    if (objName === "Layer" && LAYER_CONSTRUCTORS.has(propName)) return true
  }
  return false
}

export const getRootStaticObjectIdentifier = (
  expr: ts.Expression,
  staticObjectNames: ReadonlySet<string>,
): ts.Identifier | undefined => {
  let base = unwrapExpr(expr)
  if (!ts.isPropertyAccessExpression(base) && !ts.isElementAccessExpression(base)) {
    return undefined
  }
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
  if (mutatedTarget === undefined) return undefined
  return getRootStaticObjectIdentifier(mutatedTarget, staticObjectNames)?.text
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
  if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken)
    return false
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
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "toBeGreaterThanOrEqual")
    return false
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
  if (ts.isVoidExpression(unwrapped)) {
    return isPersistenceResultCallExpr(unwrapped.expression)
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return (
      isPersistenceResultCallExpr(unwrapped.left) || isPersistenceResultCallExpr(unwrapped.right)
    )
  }
  if (!ts.isCallExpression(unwrapped)) return false
  const callee = unwrapExpr(unwrapped.expression)
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined
  return name !== undefined && PERSISTENCE_RESULT_CALLEES.has(name)
}

export const isDiscardedPersistenceCallStatement = (node: ts.Node): boolean =>
  ts.isExpressionStatement(node) && isPersistenceResultCallExpr(node.expression)

const isProcessRootExpr = (expr: ts.Expression, processAliases?: ReadonlySet<string>): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) {
    return u.text === "process" || (processAliases?.has(u.text) ?? false)
  }
  if (ts.isPropertyAccessExpression(u) && u.name.text === "process") {
    const base = unwrapExpr(u.expression)
    return ts.isIdentifier(base) && base.text === "globalThis"
  }
  if (ts.isElementAccessExpression(u)) {
    const arg = unwrapExpr(u.argumentExpression)
    const base = unwrapExpr(u.expression)
    return (
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
      arg.text === "process" &&
      ts.isIdentifier(base) &&
      base.text === "globalThis"
    )
  }
  return false
}

export const getStaticMemberName = (node: ts.Expression): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrapExpr(node.argumentExpression)
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  }
  return undefined
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
        if (ts.isIdentifier(node.name)) {
          processAliases.add(node.name.text)
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = el.propertyName ?? el.name
            const propName =
              ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : undefined
            if ((propName === "exit" || propName === "reallyExit") && ts.isIdentifier(el.name)) {
              exitAliases.add(el.name.text)
            }
          }
        }
      }
      if (
        !isProcessRootExpr(node.initializer, processAliases) &&
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
    if (
      ts.isIdentifier(baseCallee) &&
      baseCallee.text === "Reflect" &&
      node.arguments[0] !== undefined &&
      isProcessExitReference(node.arguments[0], processAliases, exitAliases)
    ) {
      return true
    }
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
  if (!allowExtendedEmptyLiterals) return false
  return bodyText === "{}" || bodyText === "undefined" || bodyText === "false"
}

const hasFailureTagPattern = (expr: ts.Expression): boolean => {
  const obj = unwrapExpr(expr)
  if (!ts.isObjectLiteralExpression(obj)) return false
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const propName =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
    if (propName !== "_tag") continue
    const val = unwrapExpr(prop.initializer)
    if (
      (ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) &&
      val.text === "Failure"
    ) {
      return true
    }
  }
  return false
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

export const isSilentGateFsFallbackCall = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const unwrappedCallee = unwrapExpr(node.expression)
  if (ts.isIdentifier(unwrappedCallee) && unwrappedCallee.text === "safeFs") {
    return true
  }
  const calleeText = unwrappedCallee.getText(sourceFile)
  if (
    calleeText === "Result.getOrElse" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sourceFile)) &&
    isSilentEmptyFallbackFn(node.arguments[1], sourceFile, false)
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(unwrappedCallee) &&
    unwrappedCallee.name.text === "pipe" &&
    hasResultTryFsReadText(unwrappedCallee.expression.getText(sourceFile)) &&
    node.arguments.some(
      (arg) =>
        ts.isCallExpression(arg) &&
        unwrapExpr(arg.expression).getText(sourceFile) === "Result.getOrElse" &&
        arg.arguments.length === 1 &&
        arg.arguments[0] !== undefined &&
        isSilentEmptyFallbackFn(arg.arguments[0], sourceFile, true),
    )
  ) {
    return true
  }
  if (
    ts.isIdentifier(unwrappedCallee) &&
    unwrappedCallee.text === "pipe" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sourceFile)) &&
    node.arguments
      .slice(1)
      .some(
        (arg) =>
          ts.isCallExpression(arg) &&
          unwrapExpr(arg.expression).getText(sourceFile) === "Result.getOrElse" &&
          arg.arguments.length === 1 &&
          arg.arguments[0] !== undefined &&
          isSilentEmptyFallbackFn(arg.arguments[0], sourceFile, true),
      )
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(unwrappedCallee) &&
    unwrappedCallee.name.text === "with" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasFailureTagPattern(node.arguments[0]) &&
    isSilentEmptyFallbackFn(node.arguments[1], sourceFile, true)
  ) {
    const matchArgText = findRootMatchArgText(node, sourceFile)
    if (matchArgText !== undefined && hasResultTryFsReadText(matchArgText)) {
      return true
    }
  }
  return false
}

export {
  collectEffectPromiseAliases,
  type EffectPromiseAliases,
  isUnhandledEffectPromiseCall,
} from "./ast-effect-promise-law.js"
