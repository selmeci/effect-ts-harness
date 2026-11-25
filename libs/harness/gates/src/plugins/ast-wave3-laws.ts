import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import { unwrapExpr } from "./ast-gate-law-helpers.js"
import {
  type NamespaceAliasSet,
  type Wave3AstViolation,
  asMemberExpr,
  collectNamespaceAliases,
  EFFECT_MODULE_SPECS,
  getNamespaceCallMethodName,
  getNamespaceMemberName,
  isEffectMethodCall,
  isFnExpr,
  isNamespacePropertyExpr,
  isPureLoggingOrTelemetryCall,
  isTestOrHelperPath,
  unwrapPipeCall,
} from "./ast-fail-closed-laws.js"
import {
  CANONICAL_CLOSED_LITERAL_TYPES,
  collectClosedLiteralComparisonViolations,
} from "./ast-literal-branch-law.js"

export type { Wave3AstViolation }
export { CANONICAL_CLOSED_LITERAL_TYPES, collectClosedLiteralComparisonViolations }

const isCorePackageSrcPath = (normPath: string): boolean =>
  /(?:^|\/)libs\/(?:[^/]+\/core|harness\/(?:gates|graph|decision|ingest))\/src\//.test(normPath)

const isEffectWrapperCallee = (expr: ts.Expression, eff: NamespaceAliasSet): boolean => {
  const m = getNamespaceMemberName(expr, eff)
  return m === "sync" || m === "try" || m === "suspend" || m === "tap"
}

const isSideEffectSyntaxNode = (n: ts.Node): boolean =>
  ts.isDeleteExpression(n) ||
  ts.isThrowStatement(n) ||
  ts.isPostfixUnaryExpression(n) ||
  ts.isNewExpression(n) ||
  (ts.isPrefixUnaryExpression(n) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) ||
  (ts.isBinaryExpression(n) &&
    n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)

const isSwallowedTargetPureLoggingOnly = (
  target: ts.Expression,
  sf: ts.SourceFile,
  eff: NamespaceAliasSet,
): boolean => {
  let hasLogCall = false
  let hasUnsafe = false
  const visit = (n: ts.Node): void => {
    if (hasUnsafe) return
    if (isSideEffectSyntaxNode(n)) {
      hasUnsafe = true
      return
    }
    if (ts.isCallExpression(n)) {
      if (isPureLoggingOrTelemetryCall(n, sf, eff)) {
        hasLogCall = true
      } else {
        const isValidWrapper =
          isEffectWrapperCallee(n.expression, eff) &&
          n.arguments[0] !== undefined &&
          isFnExpr(unwrapExpr(n.arguments[0]))
        if (!isValidWrapper) {
          hasUnsafe = true
          return
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(target)
  return hasLogCall && !hasUnsafe
}

type FinalizerKind = "arg0" | "arg1" | "arg2" | "none"

const isFinalizerOrCompensationCallee = (
  callee: ts.Expression,
  eff: NamespaceAliasSet,
  scopeAliases: NamespaceAliasSet,
): FinalizerKind => {
  const effMethod = getNamespaceMemberName(callee, eff)
  if (effMethod === "addFinalizer") return "arg0"
  if (
    effMethod === "onExit" ||
    effMethod === "ensuring" ||
    effMethod === "onInterrupt" ||
    effMethod === "acquireRelease"
  ) {
    return "arg1"
  }
  if (effMethod === "acquireUseRelease") return "arg2"
  if (getNamespaceMemberName(callee, scopeAliases) === "addFinalizer") return "arg1"
  const u = unwrapExpr(callee)
  const name = ts.isIdentifier(u) ? u.text : asMemberExpr(u)?.name
  return name === "withCompensation" ? "arg1" : "none"
}

const isInsideFinalizerOrCompensation = (
  node: ts.Node,
  eff: NamespaceAliasSet,
  scopeAliases: NamespaceAliasSet,
): boolean => {
  let curr: ts.Node | undefined = node.parent
  let child: ts.Node = node
  while (curr !== undefined) {
    if (ts.isCallExpression(curr)) {
      const kind = isFinalizerOrCompensationCallee(curr.expression, eff, scopeAliases)
      const args = curr.arguments
      const inFinalizerArg = match(kind)
        .with("arg0", () => args[0] === child)
        .with(
          "arg1",
          () => (args.length === 1 && args[0] === child) || (args.length >= 2 && args[1] === child),
        )
        .with("arg2", () => args.length >= 3 && args[2] === child)
        .with("none", () => false)
        .exhaustive()
      if (inFinalizerArg) return true
    }
    if (
      (ts.isFunctionDeclaration(curr) ||
        ts.isMethodDeclaration(curr) ||
        ts.isVariableDeclaration(curr)) &&
      curr.name !== undefined &&
      ts.isIdentifier(curr.name) &&
      /compensat/i.test(curr.name.text)
    ) {
      return true
    }
    child = curr
    curr = curr.parent
  }
  return false
}

const getPipeStagesBeforeOperator = (opNode: ts.Node): ReadonlyArray<ts.Expression> | undefined => {
  const parent = opNode.parent
  if (parent === undefined || !ts.isCallExpression(parent)) return undefined
  const piped = unwrapPipeCall(parent)
  if (piped === undefined) return undefined
  const uOp = unwrapExpr(opNode as ts.Expression)
  const idx = piped.ops.findIndex((o) => o === opNode || unwrapExpr(o) === uOp)
  if (idx === -1) return undefined
  return [piped.subject, ...piped.ops.slice(0, idx)]
}

const areAllTargetStagesPureLogging = (
  stages: ReadonlyArray<ts.Expression> | undefined,
  sf: ts.SourceFile,
  eff: NamespaceAliasSet,
): boolean =>
  stages !== undefined &&
  stages.length > 0 &&
  stages.every((stage) => isSwallowedTargetPureLoggingOnly(stage, sf, eff))

const isEmptyOrVoidExpr = (expr: ts.Expression): boolean => {
  const u = unwrapExpr(expr)
  if (u.kind === ts.SyntaxKind.NullKeyword || u.kind === ts.SyntaxKind.VoidExpression) return true
  return ts.isIdentifier(u) && u.text === "undefined"
}

const collectBlockLocalVars = (block: ts.Block): ReadonlyMap<string, ts.Expression> => {
  const out = new Map<string, ts.Expression>()
  for (const stmt of block.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
        out.set(decl.name.text, decl.initializer)
      }
    }
  }
  return out
}

const resolveLocalExpr = (
  expr: ts.Expression,
  locals: ReadonlyMap<string, ts.Expression>,
  depth = 0,
): ts.Expression => {
  const u = unwrapExpr(expr)
  if (depth >= 4 || !ts.isIdentifier(u)) return u
  const next = locals.get(u.text)
  return next !== undefined ? resolveLocalExpr(next, locals, depth + 1) : u
}

const isEmptyOrVoidCallback = (expr: ts.Expression): boolean => {
  const fn = unwrapExpr(expr)
  if (!isFnExpr(fn)) return false
  if (!ts.isBlock(fn.body)) return isEmptyOrVoidExpr(fn.body)
  const locals = collectBlockLocalVars(fn.body)
  let sawReturn = false
  let nonEmpty = false
  const visit = (n: ts.Node): void => {
    if (nonEmpty || (n !== fn && ts.isFunctionLike(n))) return
    if (ts.isReturnStatement(n)) {
      sawReturn = true
      if (
        n.expression !== undefined &&
        !isEmptyOrVoidExpr(resolveLocalExpr(n.expression, locals))
      ) {
        nonEmpty = true
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return (
    !nonEmpty &&
    (sawReturn ||
      fn.body.statements.every((s) => ts.isVariableStatement(s) || ts.isEmptyStatement(s)))
  )
}

const hasLoggingOrFailInNode = (
  root: ts.Node,
  sf: ts.SourceFile,
  eff: NamespaceAliasSet,
): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (n !== root && ts.isFunctionLike(n)) return
    if (
      ts.isCallExpression(n) &&
      (isPureLoggingOrTelemetryCall(n, sf, eff) ||
        isEffectMethodCall(n, "fail", eff) ||
        isEffectMethodCall(n, "failCause", eff) ||
        isEffectMethodCall(n, "die", eff))
    ) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const isSilentEffectResult = (
  expr: ts.Expression,
  sf: ts.SourceFile,
  eff: NamespaceAliasSet,
  locals: ReadonlyMap<string, ts.Expression>,
): boolean => {
  const u = resolveLocalExpr(expr, locals)
  if (ts.isYieldExpression(u) && u.expression !== undefined) {
    return isSilentEffectResult(u.expression, sf, eff, locals)
  }
  if (ts.isConditionalExpression(u)) {
    return (
      isSilentEffectResult(u.whenTrue, sf, eff, locals) ||
      isSilentEffectResult(u.whenFalse, sf, eff, locals)
    )
  }
  if (isEmptyOrVoidExpr(u) || isNamespacePropertyExpr(u, eff, "void")) return true
  if (!ts.isCallExpression(u)) return false
  const m = getNamespaceCallMethodName(u, eff)
  if (m === "succeed") {
    return (
      u.arguments[0] === undefined || isEmptyOrVoidExpr(resolveLocalExpr(u.arguments[0], locals))
    )
  }
  if (m === "sync") return u.arguments[0] !== undefined && isEmptyOrVoidCallback(u.arguments[0])
  if (m === "gen") {
    const genFn = u.arguments[0] !== undefined ? unwrapExpr(u.arguments[0]) : undefined
    return genFn !== undefined && isFnExpr(genFn) && isSilentCatchCallback(genFn, sf, eff)
  }
  if (m === "asVoid") {
    const inner =
      u.arguments[0] !== undefined ? resolveLocalExpr(u.arguments[0], locals) : undefined
    if (inner === undefined) return false
    const innerMethod = ts.isCallExpression(inner)
      ? getNamespaceCallMethodName(inner, eff)
      : undefined
    return (
      isSilentEffectResult(inner, sf, eff, locals) ||
      innerMethod === "succeed" ||
      innerMethod === "sync"
    )
  }
  const piped = unwrapPipeCall(u)
  if (
    piped !== undefined &&
    piped.ops.some(
      (op) =>
        isNamespacePropertyExpr(op, eff, "asVoid") ||
        (ts.isCallExpression(op) && isNamespacePropertyExpr(op.expression, eff, "asVoid")),
    )
  ) {
    const subj = resolveLocalExpr(piped.subject, locals)
    const subjMethod = ts.isCallExpression(subj) ? getNamespaceCallMethodName(subj, eff) : undefined
    return (
      isSilentEffectResult(subj, sf, eff, locals) ||
      subjMethod === "succeed" ||
      subjMethod === "sync"
    )
  }
  return false
}

const isSilentCatchCallback = (
  cbOrMethod: ts.Expression | ts.MethodDeclaration,
  sf: ts.SourceFile,
  eff: NamespaceAliasSet,
): boolean => {
  const fn = ts.isMethodDeclaration(cbOrMethod) ? cbOrMethod : unwrapExpr(cbOrMethod)
  if ((!isFnExpr(fn) && !ts.isMethodDeclaration(fn)) || fn.body === undefined) return false
  if (!ts.isBlock(fn.body)) {
    return ts.isExpression(fn.body) && isSilentEffectResult(fn.body, sf, eff, new Map())
  }
  const locals = collectBlockLocalVars(fn.body)
  let unconditionalLogOrFail = false
  let sawReturn = false

  const stmtHasSilentReturnWithoutPriorLog = (stmt: ts.Statement): boolean => {
    let found = false
    const scan = (n: ts.Node): void => {
      if (found || (n !== stmt && ts.isFunctionLike(n))) return
      if (ts.isReturnStatement(n)) {
        sawReturn = true
        if (!unconditionalLogOrFail) {
          if (n.expression === undefined || isSilentEffectResult(n.expression, sf, eff, locals)) {
            found = true
            return
          }
        }
      }
      ts.forEachChild(n, scan)
    }
    scan(stmt)
    return found
  }

  for (const stmt of fn.body.statements) {
    if (stmtHasSilentReturnWithoutPriorLog(stmt)) return true
    if (
      !ts.isIfStatement(stmt) &&
      !ts.isSwitchStatement(stmt) &&
      hasLoggingOrFailInNode(stmt, sf, eff)
    ) {
      unconditionalLogOrFail = true
    }
  }
  return (
    !unconditionalLogOrFail &&
    !sawReturn &&
    fn.body.statements.every((s) => ts.isVariableStatement(s) || ts.isEmptyStatement(s))
  )
}

const isIgnoreDeclOrKey = (node: ts.Node): boolean => {
  const p = node.parent
  if (ts.isImportSpecifier(p) || ts.isBindingElement(p)) return p.name === node
  if (ts.isPropertyAssignment(p)) return p.name === node
  if (ts.isVariableDeclaration(p)) return p.name === node || p.initializer === node
  return false
}

/**
 * REQ-3.1: Bans `Effect.ignore`, `Effect.ignoreCause`, silent `Effect.orElseSucceed`/`orElse`,
 * and silent `Effect.catch*` in `type:core` packages and inside finalizers/compensations.
 */
export const collectSilentEffectSwallowViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<Wave3AstViolation> => {
  if (isTestOrHelperPath(normPath) || !/(?:^|\/)src\//.test(normPath)) return []
  const eff = collectNamespaceAliases(sourceFile, "Effect", EFFECT_MODULE_SPECS)
  const scopeAliases = collectNamespaceAliases(
    sourceFile,
    "Scope",
    new Set(["effect", "effect/Scope"]),
  )
  const isCore = isCorePackageSrcPath(normPath)
  const violations: Array<Wave3AstViolation> = []
  const reported = new Set<ts.Node>()

  const pushOnce = (node: ts.Node, message: string): void => {
    if (reported.has(node)) return
    reported.add(node)
    violations.push({ rule: "silent-error-swallow", message, node })
  }

  const SILENT_CATCH_METHODS = new Set([
    "catch",
    "catchAll",
    "catchCause",
    "catchAllCause",
    "orElse",
  ])

  const walk = (node: ts.Node): void => {
    if (ts.isExpression(node) && !isIgnoreDeclOrKey(node)) {
      const m = getNamespaceMemberName(node, eff)
      if (m === "ignore" || m === "ignoreCause") {
        const parentCall =
          node.parent !== undefined &&
          ts.isCallExpression(node.parent) &&
          unwrapExpr(node.parent.expression) === node
            ? node.parent
            : undefined
        const opNode: ts.Node = parentCall ?? node
        const stages =
          parentCall !== undefined && parentCall.arguments.length >= 1
            ? [parentCall.arguments[0]!]
            : getPipeStagesBeforeOperator(opNode)
        if (
          (isCore || isInsideFinalizerOrCompensation(opNode, eff, scopeAliases)) &&
          !areAllTargetStagesPureLogging(stages, sourceFile, eff)
        ) {
          pushOnce(
            opNode,
            `Swallowing errors with Effect.${m} in '${normPath}' is banned outside pure logging/telemetry.`,
          )
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const m = getNamespaceCallMethodName(node, eff)
      if (m !== undefined && (isCore || isInsideFinalizerOrCompensation(node, eff, scopeAliases))) {
        const pipeStages = getPipeStagesBeforeOperator(node)
        const isPiped = pipeStages !== undefined
        const resolveCatchPair = (
          dataLastArgs: number,
          cbIdxLast: number,
        ): {
          readonly cb: ts.Expression | undefined
          readonly stages: ReadonlyArray<ts.Expression> | undefined
        } => {
          if (isPiped || node.arguments.length === dataLastArgs) {
            return { cb: node.arguments[cbIdxLast], stages: pipeStages }
          }
          const target = node.arguments[0]
          return target === undefined
            ? { cb: undefined, stages: undefined }
            : { cb: node.arguments[cbIdxLast + 1], stages: [target] }
        }
        if (m === "orElseSucceed") {
          const { cb, stages } = resolveCatchPair(1, 0)
          if (
            cb !== undefined &&
            isEmptyOrVoidCallback(cb) &&
            !areAllTargetStagesPureLogging(stages, sourceFile, eff)
          ) {
            pushOnce(
              node,
              `Silent Effect.orElseSucceed(() => void/undefined) in '${normPath}' is banned — return a typed fallback or log/propagate the error.`,
            )
          }
        }
        if (SILENT_CATCH_METHODS.has(m) || m === "catchTag" || m === "catchIf") {
          const isTwoArgOp = m === "catchTag" || m === "catchIf"
          const { cb, stages } = resolveCatchPair(isTwoArgOp ? 2 : 1, isTwoArgOp ? 1 : 0)
          if (
            cb !== undefined &&
            isSilentCatchCallback(cb, sourceFile, eff) &&
            !areAllTargetStagesPureLogging(stages, sourceFile, eff)
          ) {
            pushOnce(
              node,
              `Silent Effect.${m} returning void/undefined without logging or re-failing in '${normPath}' is banned.`,
            )
          }
        }
        if (m === "catchTags") {
          const a0 = node.arguments[0]
          if (a0 !== undefined) {
            const isObjFirst = ts.isObjectLiteralExpression(unwrapExpr(a0))
            const isDataLast = isPiped || isObjFirst || node.arguments.length === 1
            const objExpr = isDataLast ? a0 : node.arguments[1]
            const stages = isDataLast ? pipeStages : [a0]
            const obj = objExpr !== undefined ? unwrapExpr(objExpr) : undefined
            if (
              obj !== undefined &&
              ts.isObjectLiteralExpression(obj) &&
              !areAllTargetStagesPureLogging(stages, sourceFile, eff) &&
              obj.properties.some((p) => {
                if (ts.isPropertyAssignment(p))
                  return isSilentCatchCallback(p.initializer, sourceFile, eff)
                if (ts.isMethodDeclaration(p)) return isSilentCatchCallback(p, sourceFile, eff)
                return false
              })
            ) {
              pushOnce(
                node,
                `Silent Effect.catchTags handler returning void/undefined without logging or re-failing in '${normPath}' is banned.`,
              )
            }
          }
        }
      }
    }

    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return violations
}
