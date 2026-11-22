import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import { isMemberCall, unwrapExpr } from "./ast-gate-law-helpers.js"

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

const isWorkflowStoreInvokeCall = (node: ts.CallExpression): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee)) {
    return DIRECT_STORE_CALLEES.has(callee.text)
  }
  return (
    isMemberCall(node, "WorkflowStore", "invoke") ||
    isMemberCall(node, "WorkflowStore", "invokeWithMeta")
  )
}

const getPropName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

const isNullishExpr = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === "undefined")
}

const hasFencedSpreadOrObject = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) {
    return /fence|target/i.test(u.text)
  }
  if (ts.isConditionalExpression(u)) {
    return hasFencedSpreadOrObject(u.whenTrue) && hasFencedSpreadOrObject(u.whenFalse)
  }
  if (ts.isObjectLiteralExpression(u)) {
    return hasLeaseEpochProperty(u)
  }
  return false
}

const hasLeaseEpochProperty = (obj: ts.ObjectLiteralExpression): boolean =>
  obj.properties.some((prop) => {
    if (ts.isShorthandPropertyAssignment(prop)) {
      return prop.name.text === "expectedLeaseEpoch"
    }
    if (ts.isPropertyAssignment(prop)) {
      return getPropName(prop.name) === "expectedLeaseEpoch" && !isNullishExpr(prop.initializer)
    }
    if (ts.isSpreadAssignment(prop)) {
      return hasFencedSpreadOrObject(prop.expression)
    }
    return false
  })

const hasVerifyOfflineCallInNode = (root: ts.Node): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (
      n !== root &&
      (ts.isFunctionLike(n) ||
        ts.isIfStatement(n) ||
        ts.isConditionalExpression(n) ||
        ts.isSwitchStatement(n))
    ) {
      return
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpr(n.expression)
      if (
        (ts.isIdentifier(callee) && callee.text === "verifyOfflineClusterAccess") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "verifyOfflineClusterAccess")
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

const getStatementsFromContainer = (container: ts.Node): ts.NodeArray<ts.Statement> | undefined => {
  if (
    ts.isBlock(container) ||
    ts.isSourceFile(container) ||
    ts.isModuleBlock(container) ||
    ts.isCaseClause(container) ||
    ts.isDefaultClause(container)
  ) {
    return container.statements
  }
  return undefined
}

const hasPrecedingVerifyOfflineClusterAccess = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const callStart = node.getStart(sourceFile)
  let curr: ts.Node | undefined = node.parent
  while (curr !== undefined) {
    const stmts = getStatementsFromContainer(curr)
    if (stmts !== undefined) {
      for (const stmt of stmts) {
        if (stmt.getEnd() > callStart) break
        if (hasVerifyOfflineCallInNode(stmt)) {
          return true
        }
      }
    }
    if (ts.isFunctionLike(curr)) {
      break
    }
    curr = curr.parent
  }
  return false
}

const resolveScopedInitializer = (
  name: string,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined => {
  const refStart = refNode.getStart(sourceFile)
  let curr: ts.Node | undefined = refNode.parent
  while (curr !== undefined) {
    const stmts = getStatementsFromContainer(curr)
    if (stmts !== undefined) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const stmt = stmts[i]!
        if (stmt.getStart(sourceFile) >= refStart) continue
        if (!ts.isVariableStatement(stmt)) continue
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === name &&
            decl.initializer !== undefined
          ) {
            return unwrapExpr(decl.initializer)
          }
        }
      }
    }
    curr = curr.parent
  }
  return undefined
}

const resolvePayloadObjectLiteral = (
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

const isTrueFlagExpr = (
  expr: ts.Expression,
  refNode: ts.Node,
  sourceFile: ts.SourceFile,
): boolean => {
  let curr = unwrapExpr(expr)
  for (let hop = 0; hop < 4; hop++) {
    if (curr.kind === ts.SyntaxKind.TrueKeyword) return true
    if (curr.kind === ts.SyntaxKind.FalseKeyword) return false
    if (!ts.isIdentifier(curr)) return false
    const init = resolveScopedInitializer(curr.text, refNode, sourceFile)
    if (init === undefined) return false
    curr = unwrapExpr(init)
  }
  return curr.kind === ts.SyntaxKind.TrueKeyword
}

const inspectPayloadFlags = (
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  depth = 0,
): { readonly hasExpectMutationTrue: boolean; readonly isExemptLeaseQuery: boolean } => {
  let hasExpectMutationTrue = false
  let isExemptLeaseQuery = false
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === "expectMutation") {
        const init = resolveScopedInitializer("expectMutation", prop, sourceFile)
        hasExpectMutationTrue = init === undefined || init.kind !== ts.SyntaxKind.FalseKeyword
      }
      continue
    }
    if (ts.isSpreadAssignment(prop) && depth < 3) {
      const spreadObj = resolvePayloadObjectLiteral(prop.expression, prop, sourceFile)
      if (spreadObj !== undefined) {
        const nested = inspectPayloadFlags(spreadObj, sourceFile, depth + 1)
        if (nested.hasExpectMutationTrue) hasExpectMutationTrue = true
        if (nested.isExemptLeaseQuery) isExemptLeaseQuery = true
      }
      continue
    }
    if (!ts.isPropertyAssignment(prop)) continue
    match(getPropName(prop.name))
      .with("expectMutation", () => {
        hasExpectMutationTrue = isTrueFlagExpr(prop.initializer, prop, sourceFile)
      })
      .with("queryName", () => {
        const qInit = unwrapExpr(prop.initializer)
        if (ts.isStringLiteral(qInit) || ts.isNoSubstitutionTemplateLiteral(qInit)) {
          isExemptLeaseQuery = LEASE_MANAGEMENT_QUERY_NAMES.has(qInit.text)
        }
      })
      .otherwise(() => undefined)
  }
  return { hasExpectMutationTrue, isExemptLeaseQuery }
}

/**
 * Flags non-lease `expectMutation: true` Omnigraph workflow store calls in production `src/`
 * that fail to propagate `expectedLeaseEpoch` (`REQ-3.1`).
 */
export const isUnfencedOmnigraphMutationCall = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const arg0 = node.arguments[0]
  if (!isWorkflowStoreInvokeCall(node) || arg0 === undefined) {
    return false
  }
  const obj = resolvePayloadObjectLiteral(arg0, node, sourceFile)
  if (obj === undefined) {
    return false
  }

  const { hasExpectMutationTrue, isExemptLeaseQuery } = inspectPayloadFlags(obj, sourceFile)

  if (!hasExpectMutationTrue || isExemptLeaseQuery) {
    return false
  }
  if (hasLeaseEpochProperty(obj)) {
    return false
  }
  return !hasPrecedingVerifyOfflineClusterAccess(node, sourceFile)
}
