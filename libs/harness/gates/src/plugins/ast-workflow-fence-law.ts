import { ts } from "@harness/graph"
import { getCalleeTerminalName, unwrapExpr } from "./ast-gate-law-helpers.js"
import {
  LEASE_MANAGEMENT_QUERY_NAMES,
  getPropName,
  getStatementsFromContainer,
  inspectPayloadFlags,
  isDirectDaemonWorkflowInterruptCall,
  isUnguardedWorkflowStatusUpdateCall,
  isWorkflowStoreInvokeCall,
  resolvePayloadObjectLiteral,
  resolveScopedInitializer,
} from "./ast-workflow-status-law.js"

export {
  LEASE_MANAGEMENT_QUERY_NAMES,
  isDirectDaemonWorkflowInterruptCall,
  isUnguardedWorkflowStatusUpdateCall,
}

const isNullishExpr = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === "undefined")
}

const hasFencedSpreadOrObject = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return /fence|target/i.test(u.text)
  if (ts.isConditionalExpression(u)) {
    return hasFencedSpreadOrObject(u.whenTrue) && hasFencedSpreadOrObject(u.whenFalse)
  }
  return ts.isObjectLiteralExpression(u) && hasLeaseEpochProperty(u)
}

const hasLeaseEpochProperty = (obj: ts.ObjectLiteralExpression): boolean =>
  obj.properties.some((prop) => {
    if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text === "expectedLeaseEpoch"
    if (ts.isPropertyAssignment(prop)) {
      return getPropName(prop.name) === "expectedLeaseEpoch" && !isNullishExpr(prop.initializer)
    }
    return ts.isSpreadAssignment(prop) && hasFencedSpreadOrObject(prop.expression)
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
    if (
      ts.isCallExpression(n) &&
      getCalleeTerminalName(n.expression) === "verifyOfflineClusterAccess"
    ) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const hasPrecedingVerifyOfflineClusterAccess = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const callStart = node.getStart(sourceFile)
  for (let curr: ts.Node | undefined = node.parent; curr !== undefined; curr = curr.parent) {
    const stmts = getStatementsFromContainer(curr)
    if (stmts !== undefined) {
      for (const stmt of stmts) {
        if (stmt.getEnd() > callStart) break
        if (hasVerifyOfflineCallInNode(stmt)) return true
      }
    }
    if (ts.isFunctionLike(curr)) break
  }
  return false
}

const ENCLOSING_STORE_WRAPPERS: ReadonlySet<string> = new Set([
  "invokeWorkflowStoreQuery",
  "invokeWorkflowStoreQueryWithMeta",
])

const isInternalStoreWrapperForwardCall = (
  node: ts.CallExpression,
  arg0: ts.Expression,
  sourceFile: ts.SourceFile,
): boolean => {
  const normFile = sourceFile.fileName.replace(/\\/g, "/")
  if (
    normFile !== "libs/harness/infra/src/omnigraph-workflow-store.ts" &&
    !normFile.endsWith("/libs/harness/infra/src/omnigraph-workflow-store.ts")
  ) {
    return false
  }
  const callee = unwrapExpr(node.expression)
  const uArg = unwrapExpr(arg0)
  if (
    !ts.isIdentifier(callee) ||
    callee.text !== "invokeWorkflowStoreQueryOnce" ||
    !ts.isIdentifier(uArg) ||
    uArg.text !== "input" ||
    resolveScopedInitializer("input", node, sourceFile) !== undefined
  ) {
    return false
  }
  let hasInputParam = false
  for (let curr: ts.Node | undefined = node.parent; curr !== undefined; curr = curr.parent) {
    if (
      ts.isFunctionLike(curr) &&
      curr.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "input")
    ) {
      hasInputParam = true
    }
    if (
      ts.isVariableDeclaration(curr) &&
      ts.isIdentifier(curr.name) &&
      ENCLOSING_STORE_WRAPPERS.has(curr.name.text)
    ) {
      return hasInputParam
    }
  }
  return false
}

/**
 * Flags non-lease `expectMutation: true` Omnigraph workflow store calls in production `src/`
 * that fail to propagate `expectedLeaseEpoch` (`SPEC-0027 REQ-3.1`).
 */
export const isUnfencedOmnigraphMutationCall = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  const arg0 = node.arguments[0]
  if (!isWorkflowStoreInvokeCall(node) || arg0 === undefined) return false
  const obj = resolvePayloadObjectLiteral(arg0, node, sourceFile)
  if (obj === undefined) {
    return (
      !isInternalStoreWrapperForwardCall(node, arg0, sourceFile) &&
      !hasPrecedingVerifyOfflineClusterAccess(node, sourceFile)
    )
  }
  const { hasExpectMutationTrue, hasExpectMutationFalse, isExemptLeaseQuery, hasUnresolvedSpread } =
    inspectPayloadFlags(obj, sourceFile)
  if (isExemptLeaseQuery) return false
  if (!hasExpectMutationTrue && !(hasUnresolvedSpread && !hasExpectMutationFalse)) return false
  if (hasLeaseEpochProperty(obj)) return false
  return !hasPrecedingVerifyOfflineClusterAccess(node, sourceFile)
}

/** Evaluates all three workflow fence AST rules for `SelfDogfooding.decide`. */
export const findWorkflowFenceViolation = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normPath: string,
):
  | {
      readonly rule:
        | "omnigraph-fenced-mutation"
        | "direct-daemon-workflow-interrupt"
        | "unguarded-workflow-status-update"
      readonly message: string
    }
  | undefined => {
  if (isUnfencedOmnigraphMutationCall(node, sourceFile)) {
    return {
      rule: "omnigraph-fenced-mutation",
      message: `Non-lease Omnigraph mutation in '${normPath}' omits single-writer expectedLeaseEpoch fencing.`,
    }
  }
  if (isDirectDaemonWorkflowInterruptCall(node, sourceFile, normPath)) {
    return {
      rule: "direct-daemon-workflow-interrupt",
      message: `Direct Workflow.interrupt(...) in '${normPath}' must use an interruptAndSettle* helper.`,
    }
  }
  if (isUnguardedWorkflowStatusUpdateCall(node, sourceFile)) {
    return {
      rule: "unguarded-workflow-status-update",
      message: `Workflow status update in '${normPath}' lacks a preceding .status precondition guard.`,
    }
  }
  return undefined
}
