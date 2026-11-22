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
    return hasFencedSpreadOrObject(u.whenTrue) || hasFencedSpreadOrObject(u.whenFalse)
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

const containsVerifyOfflineClusterAccess = (sf: ts.SourceFile): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && n.text === "verifyOfflineClusterAccess") {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
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
  const obj = unwrapExpr(arg0)
  if (!ts.isObjectLiteralExpression(obj)) {
    return false
  }

  let hasExpectMutationTrue = false
  let isExemptLeaseQuery = false
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    match(getPropName(prop.name))
      .with("expectMutation", () => {
        hasExpectMutationTrue = unwrapExpr(prop.initializer).kind === ts.SyntaxKind.TrueKeyword
      })
      .with("queryName", () => {
        const qInit = unwrapExpr(prop.initializer)
        if (ts.isStringLiteral(qInit) || ts.isNoSubstitutionTemplateLiteral(qInit)) {
          isExemptLeaseQuery = LEASE_MANAGEMENT_QUERY_NAMES.has(qInit.text)
        }
      })
      .otherwise(() => undefined)
  }

  if (!hasExpectMutationTrue || isExemptLeaseQuery) {
    return false
  }
  if (hasLeaseEpochProperty(obj)) {
    return false
  }
  return !containsVerifyOfflineClusterAccess(sourceFile)
}
