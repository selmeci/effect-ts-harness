import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import { getStaticMemberName, unwrapExpr } from "./ast-gate-law-helpers.js"

/** Canonical single-writer lease bootstrap/CAS/refresh queries exempt from pre-write epoch fencing. */
export const LEASE_MANAGEMENT_QUERY_NAMES: ReadonlySet<string> = new Set([
  "wf_insert_writer_lease",
  "wf_cas_writer_lease",
  "wf_refresh_writer_lease",
])

const DIRECT_STORE_CALLEES = new Set([
  "invokeWorkflowStoreQuery",
  "invokeWorkflowStoreQueryWithMeta",
  "invokeWorkflowStoreQueryOnce",
])

export const isWorkflowStoreInvokeCall = (node: ts.CallExpression): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee)) return DIRECT_STORE_CALLEES.has(callee.text)
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
  const base = unwrapExpr(callee.expression)
  const member = getStaticMemberName(callee)
  return (
    ts.isIdentifier(base) &&
    base.text === "WorkflowStore" &&
    (member === "invoke" || member === "invokeWithMeta")
  )
}

export const getPropName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

export const getStatementsFromContainer = (
  container: ts.Node,
): ts.NodeArray<ts.Statement> | undefined =>
  ts.isBlock(container) ||
  ts.isSourceFile(container) ||
  ts.isModuleBlock(container) ||
  ts.isCaseClause(container) ||
  ts.isDefaultClause(container)
    ? container.statements
    : undefined

export const getBindingElementPropName = (el: ts.BindingElement): string | undefined => {
  const p = el.propertyName ?? el.name
  return ts.isIdentifier(p) || ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p)
    ? p.text
    : undefined
}

export const findEnclosingNamedFn = (
  node: ts.Node,
  matches: (name: string) => boolean,
): ts.Node | undefined => {
  for (let c: ts.Node | undefined = node.parent; c !== undefined; c = c.parent) {
    const fnName =
      (ts.isFunctionDeclaration(c) || ts.isMethodDeclaration(c)) &&
      c.name !== undefined &&
      ts.isIdentifier(c.name)
        ? c.name.text
        : ts.isVariableDeclaration(c) && ts.isIdentifier(c.name)
          ? c.name.text
          : undefined
    if (fnName !== undefined && matches(fnName)) return c
  }
  return undefined
}

export const resolveScopedBindingInitializer = (
  name: string,
  refNode: ts.Node,
  sf: ts.SourceFile,
):
  | {
      readonly expr: ts.Expression
      readonly propName?: string | undefined
      readonly isDestructured: boolean
    }
  | undefined => {
  const refStart = refNode.getStart(sf)
  for (let curr: ts.Node | undefined = refNode.parent; curr !== undefined; curr = curr.parent) {
    const stmts = getStatementsFromContainer(curr)
    if (stmts === undefined) continue
    for (let i = stmts.length - 1; i >= 0; i--) {
      const stmt = stmts[i]!
      if (stmt.getStart(sf) >= refStart || !ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer === undefined) continue
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          return { expr: unwrapExpr(decl.initializer), isDestructured: false }
        }
        if (ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) {
              return {
                expr: unwrapExpr(decl.initializer),
                propName: getBindingElementPropName(el),
                isDestructured: true,
              }
            }
          }
        }
      }
    }
  }
  return undefined
}

export const resolveScopedInitializer = (
  name: string,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined => {
  const bound = resolveScopedBindingInitializer(name, refNode, sourceFile)
  return bound !== undefined && !bound.isDestructured ? bound.expr : undefined
}

export const resolvePayloadObjectLiteral = (
  arg0: ts.Expression,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined => {
  let curr = unwrapExpr(arg0)
  for (let hop = 0; hop < 4; hop++) {
    if (ts.isObjectLiteralExpression(curr)) return curr
    if (!ts.isIdentifier(curr)) return undefined
    const init = resolveScopedInitializer(curr.text, refNode, sourceFile)
    if (init === undefined) return undefined
    curr = unwrapExpr(init)
  }
  return ts.isObjectLiteralExpression(curr) ? curr : undefined
}

type ExpectMutationFlagKind = "true" | "false" | "dynamic"

const resolveExpectMutationFlag = (
  expr: ts.Expression,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
): ExpectMutationFlagKind => {
  let curr = unwrapExpr(expr)
  for (let hop = 0; hop < 4; hop++) {
    if (curr.kind === ts.SyntaxKind.TrueKeyword) return "true"
    if (curr.kind === ts.SyntaxKind.FalseKeyword) return "false"
    if (!ts.isIdentifier(curr)) return "dynamic"
    const init = resolveScopedInitializer(curr.text, refNode, sourceFile)
    if (init === undefined) return "dynamic"
    curr = unwrapExpr(init)
  }
  if (curr.kind === ts.SyntaxKind.TrueKeyword) return "true"
  if (curr.kind === ts.SyntaxKind.FalseKeyword) return "false"
  return "dynamic"
}

export interface PayloadFlagInspection {
  readonly hasExpectMutationTrue: boolean
  readonly hasExpectMutationFalse: boolean
  readonly hasQueryName: boolean
  readonly isExemptLeaseQuery: boolean
  readonly hasUnresolvedSpread: boolean
}

export const inspectPayloadFlags = (
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  depth = 0,
): PayloadFlagInspection => {
  let hasExpectMutationTrue = false
  let hasExpectMutationFalse = false
  let hasQueryName = false
  let isExemptLeaseQuery = false
  let hasUnresolvedSpread = false

  const applyExpectMutationExpr = (expr: ts.Expression, ref: ts.Node): void => {
    match(resolveExpectMutationFlag(expr, ref, sourceFile))
      .with("true", "dynamic", () => {
        hasExpectMutationTrue = true
        hasExpectMutationFalse = false
      })
      .with("false", () => {
        hasExpectMutationTrue = false
        hasExpectMutationFalse = true
      })
      .exhaustive()
  }
  const applyQueryNameExpr = (expr: ts.Expression | undefined): void => {
    hasQueryName = true
    const qInit = expr === undefined ? undefined : unwrapExpr(expr)
    isExemptLeaseQuery =
      qInit !== undefined &&
      (ts.isStringLiteral(qInit) || ts.isNoSubstitutionTemplateLiteral(qInit)) &&
      LEASE_MANAGEMENT_QUERY_NAMES.has(qInit.text)
  }

  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === "expectMutation") applyExpectMutationExpr(prop.name, prop)
      if (prop.name.text === "queryName") {
        applyQueryNameExpr(resolveScopedInitializer("queryName", prop, sourceFile))
      }
      continue
    }
    if (ts.isSpreadAssignment(prop)) {
      const spreadObj =
        depth < 3 ? resolvePayloadObjectLiteral(prop.expression, prop, sourceFile) : undefined
      if (spreadObj === undefined) {
        hasUnresolvedSpread = true
        hasExpectMutationFalse = false
        isExemptLeaseQuery = false
        continue
      }
      const nested = inspectPayloadFlags(spreadObj, sourceFile, depth + 1)
      if (nested.hasExpectMutationTrue) {
        hasExpectMutationTrue = true
        hasExpectMutationFalse = false
      }
      if (!nested.hasExpectMutationTrue && nested.hasExpectMutationFalse) {
        hasExpectMutationTrue = false
        hasExpectMutationFalse = true
      }
      if (nested.hasQueryName) {
        hasQueryName = true
        isExemptLeaseQuery = nested.isExemptLeaseQuery
      }
      if (nested.hasUnresolvedSpread) {
        hasUnresolvedSpread = true
        if (!nested.hasExpectMutationFalse) hasExpectMutationFalse = false
        if (!nested.isExemptLeaseQuery) isExemptLeaseQuery = false
      }
      continue
    }
    if (!ts.isPropertyAssignment(prop)) continue
    const key = getPropName(prop.name)
    if (key === "expectMutation") applyExpectMutationExpr(prop.initializer, prop)
    if (key === "queryName") applyQueryNameExpr(prop.initializer)
  }
  return {
    hasExpectMutationTrue,
    hasExpectMutationFalse,
    hasQueryName,
    isExemptLeaseQuery,
    hasUnresolvedSpread,
  }
}

const isDaemonPath = (normPath: string): boolean =>
  /(?:^|\/)apps\/harness-mcp\/src\/daemon\/.*\.ts$/.test(normPath) &&
  !/\.(?:test|spec)\.ts$/.test(normPath)

const hasSettleOrCancelCallAfter = (
  root: ts.Node,
  interruptCall: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  const interruptStart = interruptCall.getStart(sf)
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n) && n.getStart(sf) > interruptStart) {
      const c = unwrapExpr(n.expression)
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)
          ? getStaticMemberName(c)
          : undefined
      if (
        name !== undefined &&
        (name === "waitForWorkflowCompletion" ||
          name === "waitBoundedUntil" ||
          name === "cancelAndAwait" ||
          /poll/i.test(name))
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

const isInsideInterruptAndSettleHelper = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const fnNode = findEnclosingNamedFn(node, (name) => name.startsWith("interruptAndSettle"))
  return fnNode !== undefined && hasSettleOrCancelCallAfter(fnNode, node, sf)
}

const isWorkflowTargetExpr = (
  expr: ts.Expression,
  refNode: ts.Node,
  sf: ts.SourceFile,
  depth = 0,
): boolean => {
  if (depth > 4) return false
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) {
    if (u.text.endsWith("Workflow")) return true
    const bound = resolveScopedBindingInitializer(u.text, refNode, sf)
    if (bound !== undefined && !bound.isDestructured) {
      return isWorkflowTargetExpr(bound.expr, bound.expr, sf, depth + 1)
    }
    if (bound !== undefined && bound.isDestructured && bound.propName !== undefined) {
      return bound.propName.endsWith("Workflow")
    }
    return false
  }
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    const member = getStaticMemberName(u)
    return member !== undefined && member.endsWith("Workflow")
  }
  return false
}

const isWorkflowInterruptCallee = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return (
      getStaticMemberName(callee) === "interrupt" &&
      isWorkflowTargetExpr(callee.expression, node, sf)
    )
  }
  if (ts.isIdentifier(callee)) {
    const bound = resolveScopedBindingInitializer(callee.text, node, sf)
    if (bound === undefined) return false
    if (bound.isDestructured) {
      return bound.propName === "interrupt" && isWorkflowTargetExpr(bound.expr, bound.expr, sf)
    }
    const init = unwrapExpr(bound.expr)
    if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
      return (
        getStaticMemberName(init) === "interrupt" && isWorkflowTargetExpr(init.expression, init, sf)
      )
    }
  }
  return false
}

/**
 * REQ-3.3: Flags direct `<Ident>Workflow.interrupt(...)` (including member chains, bracket access,
 * and aliased/destructured `*Workflow`) in `apps/harness-mcp/src/daemon/**`
 * outside centralized `interruptAndSettle*` helpers that await/poll/cancel settlement afterward.
 */
export const isDirectDaemonWorkflowInterruptCall = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normPath: string,
): boolean => {
  if (!isDaemonPath(normPath)) return false
  if (!isWorkflowInterruptCallee(node, sourceFile)) return false
  return !isInsideInterruptAndSettleHelper(node, sourceFile)
}

const getStringPropFromObj = (
  obj: ts.ObjectLiteralExpression,
  propName: string,
  sf: ts.SourceFile,
): string | undefined => {
  for (const prop of obj.properties) {
    const raw =
      ts.isPropertyAssignment(prop) && getPropName(prop.name) === propName
        ? unwrapExpr(prop.initializer)
        : ts.isShorthandPropertyAssignment(prop) && prop.name.text === propName
          ? resolveScopedInitializer(propName, prop, sf)
          : undefined
    if (raw !== undefined && (ts.isStringLiteral(raw) || ts.isNoSubstitutionTemplateLiteral(raw))) {
      return raw.text
    }
  }
  return undefined
}

const hasStatusParamInPayload = (obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean =>
  obj.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop) || getPropName(prop.name) !== "params") return false
    const pObj = resolvePayloadObjectLiteral(prop.initializer, prop, sf)
    return (
      pObj !== undefined &&
      pObj.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) && getPropName(p.name) === "status") ||
          (ts.isShorthandPropertyAssignment(p) && p.name.text === "status"),
      )
    )
  })

const isInsideUpdateStatusFn = (node: ts.Node): boolean =>
  findEnclosingNamedFn(node, (name) => /update.*status/i.test(name)) !== undefined

const TRANSPARENT_EFFECT_METHODS = new Set([
  "gen",
  "sync",
  "suspend",
  "uninterruptible",
  "uninterruptibleMask",
  "pipe",
  "andThen",
  "flatMap",
  "map",
  "tap",
  "ensuring",
  "with",
])

const isTransparentEffectCallback = (fn: ts.Node): boolean => {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let curr: ts.Node = fn
  while (curr.parent !== undefined && ts.isParenthesizedExpression(curr.parent)) curr = curr.parent
  const p = curr.parent
  if (p === undefined || !ts.isCallExpression(p)) return false
  const c = unwrapExpr(p.expression)
  if (ts.isIdentifier(c) && TRANSPARENT_EFFECT_METHODS.has(c.text)) {
    return true
  }
  if (ts.isPropertyAccessExpression(c)) {
    return (
      TRANSPARENT_EFFECT_METHODS.has(c.name.text) ||
      (ts.isIdentifier(c.expression) &&
        c.expression.text === "Effect" &&
        (c.name.text === "fn" || c.name.text === "fnUntraced"))
    )
  }
  if (ts.isCallExpression(c)) {
    const inner = unwrapExpr(c.expression)
    return (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "Effect" &&
      (inner.name.text === "fn" || inner.name.text === "fnUntraced")
    )
  }
  return false
}

const IGNORED_STATUS_RECEIVERS = new Set([
  "http",
  "res",
  "response",
  "reply",
  "fetchRes",
  "input",
  "request",
  "req",
  "params",
  "payload",
  "expected",
  "desired",
  "next",
  "target",
  "env",
  "args",
  "opts",
  "options",
])

const isNonPersistedStatusReceiver = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return IGNORED_STATUS_RECEIVERS.has(u.text)
  if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
    const member = getStaticMemberName(u)
    if (member !== undefined && IGNORED_STATUS_RECEIVERS.has(member)) return true
    return isNonPersistedStatusReceiver(u.expression)
  }
  return false
}

const collectStatusAliasesFromPattern = (
  pattern: ts.ObjectBindingPattern,
  aliases: Set<string>,
): void => {
  for (const el of pattern.elements) {
    if (getBindingElementPropName(el) === "status" && ts.isIdentifier(el.name)) {
      aliases.add(el.name.text)
    }
  }
}

const collectWorkflowStatusAliases = (anchor: ts.Node, sf: ts.SourceFile): ReadonlySet<string> => {
  const aliases = new Set<string>()
  const anchorStart = anchor.getStart(sf)
  for (let curr: ts.Node | undefined = anchor.parent; curr !== undefined; curr = curr.parent) {
    if (ts.isFunctionLike(curr)) {
      for (const p of curr.parameters) {
        if (ts.isObjectBindingPattern(p.name)) collectStatusAliasesFromPattern(p.name, aliases)
      }
      if (!isTransparentEffectCallback(curr)) break
      continue
    }
    if (ts.isSourceFile(curr)) break
    const stmts = getStatementsFromContainer(curr)
    if (stmts !== undefined) {
      for (const stmt of stmts) {
        if (stmt.getEnd() > anchorStart || !ts.isVariableStatement(stmt)) continue
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer === undefined) continue
          const init = unwrapExpr(decl.initializer)
          if (isNonPersistedStatusReceiver(init)) continue
          if (ts.isObjectBindingPattern(decl.name)) {
            collectStatusAliasesFromPattern(decl.name, aliases)
            continue
          }
          if (
            ts.isIdentifier(decl.name) &&
            (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) &&
            getStaticMemberName(init) === "status" &&
            !isNonPersistedStatusReceiver(init.expression)
          ) {
            aliases.add(decl.name.text)
          }
        }
      }
    }
  }
  return aliases
}

const isWorkflowStatusTargetExpr = (
  expr: ts.Expression,
  statusAliases: ReadonlySet<string>,
): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return statusAliases.has(u.text)
  return (
    (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) &&
    getStaticMemberName(u) === "status" &&
    !isNonPersistedStatusReceiver(u.expression)
  )
}

const isEqualityOp = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsToken

const testContainsWorkflowStatusCheck = (
  testExpr: ts.Expression,
  statusAliases: ReadonlySet<string>,
): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    const u = ts.isExpression(n) ? unwrapExpr(n) : n
    if (ts.isBinaryExpression(u) && isEqualityOp(u.operatorToken.kind)) {
      const [l, r] = [unwrapExpr(u.left), unwrapExpr(u.right)]
      if (
        (isWorkflowStatusTargetExpr(l, statusAliases) && !ts.isNumericLiteral(r)) ||
        (isWorkflowStatusTargetExpr(r, statusAliases) && !ts.isNumericLiteral(l))
      ) {
        found = true
        return
      }
    }
    if (ts.isCallExpression(u)) {
      const c = unwrapExpr(u.expression)
      if (
        (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) &&
        getStaticMemberName(c) === "has" &&
        u.arguments[0] !== undefined &&
        isWorkflowStatusTargetExpr(u.arguments[0], statusAliases)
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(testExpr)
  return found
}

const branchHasTerminatingOrFailingAction = (root: ts.Node): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      found = true
      return
    }
    if (ts.isCallExpression(n)) {
      const c = unwrapExpr(n.expression)
      if (
        ts.isPropertyAccessExpression(c) &&
        ts.isIdentifier(c.expression) &&
        c.expression.text === "Effect" &&
        (c.name.text === "fail" || c.name.text === "failCause" || c.name.text === "die")
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

const getRootMatchSubject = (call: ts.CallExpression): ts.Expression | undefined => {
  let curr: ts.Expression = unwrapExpr(call)
  while (ts.isCallExpression(curr)) {
    const callee = unwrapExpr(curr.expression)
    if (ts.isIdentifier(callee) && callee.text === "match") return curr.arguments[0]
    if (!ts.isPropertyAccessExpression(callee)) break
    curr = unwrapExpr(callee.expression)
  }
  return undefined
}

const stmtContainsControlFlowStatusGuard = (
  root: ts.Node,
  statusAliases: ReadonlySet<string>,
): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found || (n !== root && ts.isFunctionLike(n))) return
    if (
      ts.isIfStatement(n) &&
      testContainsWorkflowStatusCheck(n.expression, statusAliases) &&
      branchHasTerminatingOrFailingAction(n.thenStatement)
    ) {
      found = true
      return
    }
    if (ts.isCallExpression(n)) {
      const subj = getRootMatchSubject(n)
      if (
        subj !== undefined &&
        isWorkflowStatusTargetExpr(subj, statusAliases) &&
        branchHasTerminatingOrFailingAction(n)
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

const hasControlFlowOrPrecedingStatusGuard = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
): boolean => {
  const statusAliases = collectWorkflowStatusAliases(node, sf)
  const callStart = node.getStart(sf)
  let child: ts.Node = node
  for (
    let curr: ts.Node | undefined = node.parent;
    curr !== undefined;
    child = curr, curr = curr.parent
  ) {
    if (
      (ts.isIfStatement(curr) &&
        curr.expression !== child &&
        testContainsWorkflowStatusCheck(curr.expression, statusAliases)) ||
      (ts.isConditionalExpression(curr) &&
        curr.condition !== child &&
        testContainsWorkflowStatusCheck(curr.condition, statusAliases))
    ) {
      return true
    }
    if (ts.isCallExpression(curr)) {
      const matchSubject = getRootMatchSubject(curr)
      if (matchSubject !== undefined && isWorkflowStatusTargetExpr(matchSubject, statusAliases)) {
        return true
      }
    }
    const stmts = getStatementsFromContainer(curr)
    if (stmts !== undefined) {
      for (const stmt of stmts) {
        if (stmt.getEnd() > callStart) break
        if (stmtContainsControlFlowStatusGuard(stmt, statusAliases)) return true
      }
    }
    if (ts.isSourceFile(curr) || ts.isFunctionDeclaration(curr) || ts.isMethodDeclaration(curr)) {
      break
    }
    if (ts.isFunctionLike(curr) && !isTransparentEffectCallback(curr)) break
  }
  return false
}

/**
 * REQ-3.3: Flags `WorkflowStore` `expectMutation: true` status-transition updates
 * (`wf_update_ship_attempt`, `wf_update_*status`, or `wf_update_*` / opaque calls inside `update*Status`)
 * that are not guarded by terminating conditional control flow or `match(...)` on workflow `.status`.
 */
export const isUnguardedWorkflowStatusUpdateCall = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const arg0 = node.arguments[0]
  if (!isWorkflowStoreInvokeCall(node) || arg0 === undefined) return false
  const normFile = sourceFile.fileName.replace(/\\/g, "/")
  if (normFile.endsWith("/libs/harness/infra/src/omnigraph-workflow-store.ts")) return false
  const obj = resolvePayloadObjectLiteral(arg0, node, sourceFile)
  if (obj === undefined) {
    return isInsideUpdateStatusFn(node) && !hasControlFlowOrPrecedingStatusGuard(node, sourceFile)
  }
  const { hasExpectMutationTrue } = inspectPayloadFlags(obj, sourceFile)
  if (!hasExpectMutationTrue) return false
  const queryName = getStringPropFromObj(obj, "queryName", sourceFile)
  if (queryName === undefined) return false
  const isStatusTransitionQuery =
    queryName === "wf_update_ship_attempt" ||
    /^wf_update_.*status$/.test(queryName) ||
    (queryName.startsWith("wf_update_") &&
      isInsideUpdateStatusFn(node) &&
      hasStatusParamInPayload(obj, sourceFile))
  if (!isStatusTransitionQuery) return false
  return !hasControlFlowOrPrecedingStatusGuard(node, sourceFile)
}
