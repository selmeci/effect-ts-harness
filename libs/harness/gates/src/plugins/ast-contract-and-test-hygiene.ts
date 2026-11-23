import { ts } from "@harness/graph"
import { match } from "ts-pattern"
import { unwrapExpr } from "./ast-gate-law-helpers.js"

/** Maximum permitted inclusive line span (`endLine - startLine + 1`) for a Vitest test callback. */
export const MAX_TEST_CASE_LINES = 200

export type AstHygieneRuleId =
  | "contract-shape-hardening"
  | "workflow-name-instead-of-tag"
  | "max-test-case-lines"

export interface AstHygieneFinding {
  readonly rule: AstHygieneRuleId
  readonly message: string
  readonly node: ts.Node
}

const SCHEMA_CHAIN_METHODS = new Set(["pipe", "check", "annotate"])
const STRING_BOUND_CALLS = new Set(["isTrimmed", "isPattern", "isMaxLength"])
const VITEST_BASE_IDENTIFIERS = new Set(["it", "test"])
const VITEST_CURRIED_METHODS = new Set(["each", "for", "skipIf", "runIf"])

const isContractSourcePath = (normPath: string): boolean =>
  !isTestPath(normPath) && /(?:^|\/)libs\/[^/]+\/contract\/src\/.*\.ts$/.test(normPath)

const isWireAdapterContractPath = (normPath: string): boolean =>
  /(?:^|\/)wire-(?:adapter|envelope)\.ts$/.test(normPath)

const isTestPath = (normPath: string): boolean => /\.(?:test|spec)\.tsx?$/.test(normPath)

const staticStringExpr = (expr: ts.Expression): string | undefined => {
  const u = unwrapExpr(expr)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
}

const isMemberExprText = (expr: ts.Expression, objName: string, propName: string): boolean => {
  const u = unwrapExpr(expr)
  return (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === objName &&
    u.name.text === propName
  )
}

const isSchemaBrandCall = (node: ts.CallExpression): boolean =>
  isMemberExprText(node.expression, "Schema", "brand") &&
  node.arguments[0] !== undefined &&
  staticStringExpr(node.arguments[0]) !== undefined

const isPipeCallParent = (expr: ts.Node): ts.CallExpression | undefined => {
  let currNode: ts.Node = expr
  while (
    currNode.parent !== undefined &&
    (ts.isParenthesizedExpression(currNode.parent) ||
      ts.isAsExpression(currNode.parent) ||
      ts.isSatisfiesExpression(currNode.parent) ||
      ts.isTypeAssertionExpression(currNode.parent) ||
      ts.isNonNullExpression(currNode.parent))
  ) {
    currNode = currNode.parent
  }
  const p = currNode.parent
  if (p === undefined) return undefined
  if (
    ts.isPropertyAccessExpression(p) &&
    p.expression === currNode &&
    SCHEMA_CHAIN_METHODS.has(p.name.text)
  ) {
    const pp = p.parent
    if (pp !== undefined && ts.isCallExpression(pp) && pp.expression === p) {
      return pp
    }
    return undefined
  }
  if (!ts.isCallExpression(p)) return undefined
  const callee = unwrapExpr(p.expression)
  if (ts.isPropertyAccessExpression(callee) && SCHEMA_CHAIN_METHODS.has(callee.name.text)) {
    return p
  }
  if (ts.isIdentifier(callee) && callee.text === "pipe") {
    return p
  }
  return undefined
}

const findOutermostSchemaChain = (brandCall: ts.CallExpression): ts.CallExpression | undefined => {
  let curr: ts.CallExpression | undefined = undefined
  let probe: ts.Node = brandCall
  while (
    probe.parent !== undefined &&
    (ts.isParenthesizedExpression(probe.parent) ||
      ts.isAsExpression(probe.parent) ||
      ts.isSatisfiesExpression(probe.parent) ||
      ts.isTypeAssertionExpression(probe.parent) ||
      ts.isNonNullExpression(probe.parent))
  ) {
    probe = probe.parent
  }
  if (
    probe.parent !== undefined &&
    ts.isCallExpression(probe.parent) &&
    unwrapExpr(probe.parent.expression) === brandCall
  ) {
    curr = probe.parent
    probe = probe.parent
  }
  while (true) {
    const parentCall = isPipeCallParent(probe)
    if (parentCall === undefined) break
    const pCallee = unwrapExpr(parentCall.expression)
    const isMethodOnCurr =
      (ts.isPropertyAccessExpression(pCallee) && unwrapExpr(pCallee.expression) === brandCall) ||
      (ts.isPropertyAccessExpression(pCallee) &&
        curr !== undefined &&
        unwrapExpr(pCallee.expression) === curr)
    const isPipeArg =
      (ts.isIdentifier(pCallee) && pCallee.text === "pipe") ||
      (curr === undefined && ts.isPropertyAccessExpression(pCallee))
    if (!isMethodOnCurr && !isPipeArg) break
    curr = parentCall
    probe = parentCall
  }
  return curr
}

const resolveChainRootSchema = (chainRoot: ts.CallExpression): ts.Expression => {
  let curr: ts.Expression = chainRoot
  while (ts.isCallExpression(curr)) {
    const callee = unwrapExpr(curr.expression)
    if (
      ts.isCallExpression(callee) &&
      isSchemaBrandCall(callee) &&
      curr.arguments[0] !== undefined
    ) {
      curr = unwrapExpr(curr.arguments[0])
      continue
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      SCHEMA_CHAIN_METHODS.has(callee.name.text) &&
      callee.expression !== undefined
    ) {
      curr = unwrapExpr(callee.expression)
      continue
    }
    if (ts.isIdentifier(callee) && callee.text === "pipe" && curr.arguments[0] !== undefined) {
      curr = unwrapExpr(curr.arguments[0])
      continue
    }
    break
  }
  return curr
}

const isUnboundedRootStringSchema = (rootExpr: ts.Expression): boolean =>
  isMemberExprText(rootExpr, "Schema", "String") ||
  isMemberExprText(rootExpr, "Schema", "NonEmptyString")

const containsStringBoundCall = (root: ts.Node): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpr(n.expression)
      if (ts.isIdentifier(callee) && STRING_BOUND_CALLS.has(callee.text)) {
        found = true
        return
      }
      if (ts.isPropertyAccessExpression(callee) && STRING_BOUND_CALLS.has(callee.name.text)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const getRecordKeyValueArgs = (
  node: ts.CallExpression,
): { readonly key: ts.Expression; readonly value: ts.Expression } | undefined => {
  if (!isMemberExprText(node.expression, "Schema", "Record")) return undefined
  if (node.arguments.length >= 2 && node.arguments[0] && node.arguments[1]) {
    return { key: node.arguments[0], value: node.arguments[1] }
  }
  if (node.arguments.length === 1 && node.arguments[0] !== undefined) {
    const argObj = unwrapExpr(node.arguments[0])
    if (!ts.isObjectLiteralExpression(argObj)) return undefined
    let keyExpr: ts.Expression | undefined
    let valueExpr: ts.Expression | undefined
    for (const prop of argObj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
      match(prop.name.text)
        .with("key", () => {
          keyExpr = prop.initializer
        })
        .with("value", () => {
          valueExpr = prop.initializer
        })
        .otherwise(() => undefined)
    }
    if (keyExpr !== undefined && valueExpr !== undefined) {
      return { key: keyExpr, value: valueExpr }
    }
  }
  return undefined
}

/**
 * Flags unbounded branded string schemas (`Schema.String` / `Schema.NonEmptyString`
 * without `isTrimmed`, `isPattern`, or `isMaxLength`) and unguarded
 * `Schema.Record(Schema.String, Schema.Unknown)` bags in `type:contract` (`SPEC-0028 REQ-1.1`).
 */
export const collectContractShapeViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<AstHygieneFinding> => {
  if (!isContractSourcePath(normPath)) return []
  const findings: Array<AstHygieneFinding> = []
  const allowUnknownRecord = isWireAdapterContractPath(normPath)
  const visitedChains = new Set<ts.CallExpression>()

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isSchemaBrandCall(node)) {
        const chainRoot = findOutermostSchemaChain(node)
        if (chainRoot !== undefined && !visitedChains.has(chainRoot)) {
          visitedChains.add(chainRoot)
          const rootSchema = resolveChainRootSchema(chainRoot)
          if (isUnboundedRootStringSchema(rootSchema) && !containsStringBoundCall(chainRoot)) {
            findings.push({
              rule: "contract-shape-hardening",
              message: `[contract-shape-hardening] Branded string schema in '${normPath}' must constrain bounds with Schema.isTrimmed(), Schema.isPattern(...), or Schema.isMaxLength(...).`,
              node,
            })
          }
        }
      }
      if (!allowUnknownRecord) {
        const recordArgs = getRecordKeyValueArgs(node)
        if (
          recordArgs !== undefined &&
          isMemberExprText(recordArgs.key, "Schema", "String") &&
          isMemberExprText(recordArgs.value, "Schema", "Unknown")
        ) {
          findings.push({
            rule: "contract-shape-hardening",
            message: `[contract-shape-hardening] Unguarded Schema.Record(Schema.String, Schema.Unknown) in '${normPath}' is banned outside wire-adapter modules — use a named typed Struct or Schema.Record with branded keys and value schemas.`,
            node,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

const isWorkflowMakeCall = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (!ts.isCallExpression(u)) return false
  const callee = unwrapExpr(u.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "make") return false
  const recv = unwrapExpr(callee.expression)
  return (
    (ts.isIdentifier(recv) && recv.text === "Workflow") ||
    (ts.isPropertyAccessExpression(recv) && recv.name.text === "Workflow")
  )
}

const WORKFLOW_SYMBOL_NAME_RE = /^[A-Z][A-Za-z0-9_]*Workflow$/

/**
 * Flags `.name` / `["name"]` property reads on `Workflow.make(...)` definitions
 * across workspace source and test files (`SPEC-0028 REQ-1.2`), guiding callers to `._tag`.
 */
export const collectWorkflowNameAccessViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<AstHygieneFinding> => {
  const workflowDefNames = new Set<string>()
  const workflowNamespaceImports = new Set<string>()

  const collectImportsAndDecls = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const nb = node.importClause?.namedBindings
      const mod = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ""
      const isWorkspaceOrRelative = mod.startsWith("@harness/") || mod.startsWith(".")
      if (isWorkspaceOrRelative && nb !== undefined && ts.isNamespaceImport(nb)) {
        workflowNamespaceImports.add(nb.name.text)
      }
      if (isWorkspaceOrRelative && nb !== undefined && ts.isNamedImports(nb)) {
        for (const spec of nb.elements) {
          if (spec.isTypeOnly) continue
          const importedName = (spec.propertyName ?? spec.name).text
          if (importedName !== "Workflow" && WORKFLOW_SYMBOL_NAME_RE.test(importedName)) {
            workflowDefNames.add(spec.name.text)
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = unwrapExpr(node.initializer)
      if (isWorkflowMakeCall(init) || (ts.isIdentifier(init) && workflowDefNames.has(init.text))) {
        workflowDefNames.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectImportsAndDecls)
  }
  collectImportsAndDecls(sourceFile)

  const isWorkflowTarget = (expr: ts.Expression): boolean => {
    const u = unwrapExpr(expr)
    if (ts.isIdentifier(u)) return workflowDefNames.has(u.text)
    if (isWorkflowMakeCall(u)) return true
    return (
      ts.isPropertyAccessExpression(u) &&
      ts.isIdentifier(u.expression) &&
      workflowNamespaceImports.has(u.expression.text) &&
      u.name.text !== "Workflow" &&
      WORKFLOW_SYMBOL_NAME_RE.test(u.name.text)
    )
  }

  const findings: Array<AstHygieneFinding> = []
  const checkAccess = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "name" &&
      isWorkflowTarget(node.expression)
    ) {
      findings.push({
        rule: "workflow-name-instead-of-tag",
        message: `[workflow-name-instead-of-tag] Do not read '.name' on a Workflow.make(...) definition in '${normPath}' (evaluates to Function.prototype.name 'Workflow') — use '._tag' instead.`,
        node,
      })
    }
    if (
      ts.isElementAccessExpression(node) &&
      staticStringExpr(node.argumentExpression) === "name" &&
      isWorkflowTarget(node.expression)
    ) {
      findings.push({
        rule: "workflow-name-instead-of-tag",
        message: `[workflow-name-instead-of-tag] Do not read '["name"]' on a Workflow.make(...) definition in '${normPath}' (evaluates to Function.prototype.name 'Workflow') — use '._tag' instead.`,
        node,
      })
    }
    ts.forEachChild(node, checkAccess)
  }
  checkAccess(sourceFile)
  return findings
}

const isVitestTestChain = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (ts.isIdentifier(u)) return VITEST_BASE_IDENTIFIERS.has(u.text)
  if (ts.isPropertyAccessExpression(u)) return isVitestTestChain(u.expression)
  if (ts.isCallExpression(u)) {
    const inner = unwrapExpr(u.expression)
    if (
      ts.isPropertyAccessExpression(inner) &&
      VITEST_CURRIED_METHODS.has(inner.name.text) &&
      isVitestTestChain(inner.expression)
    ) {
      return true
    }
  }
  return false
}

/**
 * Flags Vitest `it` / `test` callbacks whose inclusive line span exceeds
 * `MAX_TEST_CASE_LINES` (`200`) (`SPEC-0028 REQ-3.1`).
 */
export const collectMaxTestCaseLineViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<AstHygieneFinding> => {
  if (!isTestPath(normPath)) return []
  const findings: Array<AstHygieneFinding> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isVitestTestChain(node.expression)) {
      for (const arg of node.arguments) {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue
        const startLine =
          sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile)).line + 1
        const endLine = sourceFile.getLineAndCharacterOfPosition(arg.getEnd()).line + 1
        const lineSpan = endLine - startLine + 1
        if (lineSpan > MAX_TEST_CASE_LINES) {
          findings.push({
            rule: "max-test-case-lines",
            message: `[max-test-case-lines] Test callback in '${normPath}' spans ${lineSpan} lines (max ${MAX_TEST_CASE_LINES}) — split into focused helpers or separate it(...) blocks.`,
            node,
          })
          break
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}
