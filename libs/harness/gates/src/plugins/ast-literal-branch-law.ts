import { ts } from "@harness/graph"
import { unwrapExpr } from "./ast-gate-law-helpers.js"
import {
  type Wave3AstViolation,
  asMemberExpr,
  findAstMatch,
  getStaticStr,
  isFnExpr,
  isTestOrHelperPath,
} from "./ast-fail-closed-laws.js"

export const CANONICAL_CLOSED_LITERAL_TYPES: ReadonlySet<string> = new Set(
  [
    "AdrStatus AntiPatternRuleId AstGatePackageTag CanonicalCliCommandName CanonicalMcpToolName CascadeStageName",
    "CircuitBreakerStatus CodeModActionKind CodeModEngineKind ConceptKind ConceptLatticeErrorReason DaemonServerErrorKind",
    "DstExecutionTier DstHazardRiskLevel EarsClauseOutcomeKind EarsClausePatternKind EarsClausePolarity EarsConsistencyRuleId",
    "EarsConsistencyViolationKind EarsGuardPairRelation EarsPatternKind EarsStatus EmbeddingCacheErrorKind",
    "EmbeddingCacheOperation EmbeddingNodeKind EmbeddingUnavailableCause EntityNodeTag EscalationDecision FrictionEventKind",
    "FrictionLogState GateCategory GateVerdict GcFindingKind GovernanceDocKind GovernanceDocLifecycleStatus GovernanceDocStatus",
    "GraphRewriteErrorReason HttpMethod LatencyExceededDimension LayerKind MigrationEngineKind MutantCategory MutateDiffMode",
    "MutateEnforcementMode NxAffectedTargetFlag NxScopeTag NxTierTag OmnigraphChangeOp OmnigraphConfigDriftKind",
    "OmnigraphConflictKind OmnigraphDiagnosticSeverity OmnigraphEntityKind OmnigraphLintPolicy OmnigraphLintStatus",
    "OmnigraphReconcileReason PackageTag PackageVerifyExecutable PackageVerifyFailureKind PackageVerifyTarget RelationTag",
    "RemediationFindingSeverity ReviewDepth ReviewRoutingSource ReviewerId RewriteMode RewritePhase RewriteRuleCategory",
    "RuleSynthesisFailureStage RunnerId SelfDogfoodingRuleId ShipAttemptStatus ShipErrorTag ShipRunOrigin ShipStage",
    "SpanBudgetRuleId SpanBudgetViolationKind StageLatencyStatus StandardRoleName StdinReadErrorKind SubprocessFailureKind",
    "TelemetryCategory TelemetryEngineSource TelemetryOutcome TelemetrySurface TierTopologyRuleId VerificationStatus",
    "ViolationRule WorkflowAttemptVerdict WorkflowBackupMode WorkflowDoctorCheckStatus WorkflowDoctorMode WorkflowGqQueryName",
    "WorkflowLevel WorkflowProjectionStatus WorkflowProjectorTrigger WorkflowRunState WorkflowStartOutcome WorkflowStoreAvailabilityState",
    "WorkflowUnitKind WorkflowUnitStatus WorkspaceFsOperation WorktreePathKind",
  ]
    .join(" ")
    .split(" "),
)

interface VarTypeInfo {
  readonly isClosed: boolean
  readonly typeName?: string
  readonly inlineProps?: ReadonlyMap<string, VarTypeInfo>
}

const CLOSED_INFO: VarTypeInfo = { isClosed: true }
const OPEN_INFO: VarTypeInfo = { isClosed: false }

const unwrapNullishTypeParts = (typeNode: ts.TypeNode): ReadonlyArray<ts.TypeNode> => {
  if (ts.isParenthesizedTypeNode(typeNode)) return unwrapNullishTypeParts(typeNode.type)
  if (!ts.isUnionTypeNode(typeNode)) return [typeNode]
  return typeNode.types.filter(
    (t) =>
      t.kind !== ts.SyntaxKind.UndefinedKeyword &&
      t.kind !== ts.SyntaxKind.NullKeyword &&
      !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
  )
}

const isStringLiteralUnionTypeNode = (
  typeNode: ts.TypeNode,
  closedTypeNames: ReadonlySet<string>,
): boolean => {
  if (ts.isParenthesizedTypeNode(typeNode))
    return isStringLiteralUnionTypeNode(typeNode.type, closedTypeNames)
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return closedTypeNames.has(typeNode.typeName.text)
  }
  if (
    ts.isTypeQueryNode(typeNode) &&
    ts.isQualifiedName(typeNode.exprName) &&
    ts.isIdentifier(typeNode.exprName.left) &&
    typeNode.exprName.right.text === "Type"
  ) {
    return closedTypeNames.has(typeNode.exprName.left.text)
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullish = unwrapNullishTypeParts(typeNode)
    if (nonNullish.length === 1)
      return isStringLiteralUnionTypeNode(nonNullish[0]!, closedTypeNames)
    return (
      nonNullish.length >= 2 &&
      nonNullish.every((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
    )
  }
  return false
}

const isSchemaLiteralsCall = (expr: ts.Expression): boolean => {
  let u = unwrapExpr(expr)
  while (ts.isCallExpression(u)) {
    const c = unwrapExpr(u.expression)
    if (!ts.isPropertyAccessExpression(c) || c.name.text !== "pipe") break
    u = unwrapExpr(c.expression)
  }
  if (!ts.isCallExpression(u)) return false
  const c = unwrapExpr(u.expression)
  if (
    !ts.isPropertyAccessExpression(c) ||
    !ts.isIdentifier(c.expression) ||
    c.expression.text !== "Schema" ||
    c.name.text !== "Literals"
  ) {
    return false
  }
  const arg0 = u.arguments[0] !== undefined ? unwrapExpr(u.arguments[0]) : undefined
  if (arg0 === undefined || !ts.isArrayLiteralExpression(arg0)) return false
  return arg0.elements.filter((el) => getStaticStr(el) !== undefined).length >= 2
}

const resolveTypeNodeInfo = (
  typeNode: ts.TypeNode | undefined,
  closedTypeNames: ReadonlySet<string>,
  closedPropsByType: ReadonlyMap<string, ReadonlyMap<string, VarTypeInfo>>,
): VarTypeInfo => {
  if (typeNode === undefined) return OPEN_INFO
  if (isStringLiteralUnionTypeNode(typeNode, closedTypeNames)) return CLOSED_INFO
  const parts = unwrapNullishTypeParts(typeNode)
  if (parts.length !== 1) return OPEN_INFO
  const single = ts.isParenthesizedTypeNode(parts[0]!) ? parts[0]!.type : parts[0]!
  if (ts.isTypeReferenceNode(single) && ts.isIdentifier(single.typeName)) {
    const tn = single.typeName.text
    if (
      tn === "Readonly" &&
      single.typeArguments !== undefined &&
      single.typeArguments[0] !== undefined
    ) {
      return resolveTypeNodeInfo(single.typeArguments[0], closedTypeNames, closedPropsByType)
    }
    if (closedPropsByType.has(tn)) return { isClosed: false, typeName: tn }
  }
  if (ts.isTypeLiteralNode(single)) {
    const inlineProps = new Map<string, VarTypeInfo>()
    for (const mem of single.members) {
      if (ts.isPropertySignature(mem) && ts.isIdentifier(mem.name)) {
        const info = resolveTypeNodeInfo(mem.type, closedTypeNames, closedPropsByType)
        if (info !== OPEN_INFO) {
          inlineProps.set(mem.name.text, info)
        }
      }
    }
    if (inlineProps.size > 0) return { isClosed: false, inlineProps }
  }
  return OPEN_INFO
}

/**
 * REQ-3.2: Flags imperative `if` or ternary equality checks against string literals
 * on expressions typed as closed `Schema.Literals` or string-literal unions of >= 2 variants.
 */
export const collectClosedLiteralComparisonViolations = (
  sourceFile: ts.SourceFile,
  normPath: string,
): ReadonlyArray<Wave3AstViolation> => {
  if (isTestOrHelperPath(normPath) || !/(?:^|\/)src\//.test(normPath)) return []
  const closedTypeNames = new Set<string>(CANONICAL_CLOSED_LITERAL_TYPES)
  const closedPropsByType = new Map<string, Map<string, VarTypeInfo>>()
  const fnReturnTypes = new Map<string, VarTypeInfo>()

  const collectDecls = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      isStringLiteralUnionTypeNode(node.type, closedTypeNames)
    ) {
      closedTypeNames.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isSchemaLiteralsCall(node.initializer)
    ) {
      closedTypeNames.add(node.name.text)
    }
    ts.forEachChild(node, collectDecls)
  }
  collectDecls(sourceFile)

  const recordTypeMembers = (typeName: string, members: ts.NodeArray<ts.TypeElement>): void => {
    const propMap = closedPropsByType.get(typeName) ?? new Map<string, VarTypeInfo>()
    for (const mem of members) {
      if (ts.isPropertySignature(mem) && ts.isIdentifier(mem.name)) {
        const info = resolveTypeNodeInfo(mem.type, closedTypeNames, closedPropsByType)
        if (info !== OPEN_INFO) {
          propMap.set(mem.name.text, info)
        }
      }
    }
    if (propMap.size > 0) closedPropsByType.set(typeName, propMap)
  }

  for (let pass = 0; pass < 2; pass++) {
    const collectInterfaces = (n: ts.Node): void => {
      if (ts.isInterfaceDeclaration(n)) recordTypeMembers(n.name.text, n.members)
      if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type))
        recordTypeMembers(n.name.text, n.type.members)
      ts.forEachChild(n, collectInterfaces)
    }
    collectInterfaces(sourceFile)
  }

  const recordFnReturn = (name: string, retType: ts.TypeNode | undefined): void => {
    if (retType === undefined) return
    const retInfo = resolveTypeNodeInfo(retType, closedTypeNames, closedPropsByType)
    fnReturnTypes.set(name, retInfo)
  }

  const collectFnDecls = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
      recordFnReturn(n.name.text, n.type)
    }
    ts.forEachChild(n, collectFnDecls)
  }
  collectFnDecls(sourceFile)

  const varScopes: Array<{
    readonly isFnBoundary: boolean
    readonly vars: Map<string, VarTypeInfo>
  }> = [{ isFnBoundary: true, vars: new Map() }]

  const lookupVar = (name: string): VarTypeInfo | undefined => {
    for (let i = varScopes.length - 1; i >= 0; i--) {
      const val = varScopes[i]!.vars.get(name)
      if (val !== undefined) return val
    }
    return undefined
  }

  const setVar = (name: string, info: VarTypeInfo, hoistToFn = false): void => {
    if (!hoistToFn) {
      varScopes[varScopes.length - 1]!.vars.set(name, info)
      return
    }
    for (let i = varScopes.length - 1; i >= 0; i--) {
      if (varScopes[i]!.isFnBoundary) {
        varScopes[i]!.vars.set(name, info)
        return
      }
    }
  }

  const resolveExprInfo = (expr: ts.Expression): VarTypeInfo => {
    const u = unwrapExpr(expr)
    if (ts.isTypeOfExpression(u)) return OPEN_INFO
    if (ts.isIdentifier(u)) return lookupVar(u.text) ?? OPEN_INFO
    if (ts.isCallExpression(u)) {
      const c = unwrapExpr(u.expression)
      if (ts.isIdentifier(c)) return fnReturnTypes.get(c.text) ?? OPEN_INFO
    }
    const mem = asMemberExpr(u)
    if (mem !== undefined) {
      const recv = resolveExprInfo(mem.obj)
      if (recv.inlineProps !== undefined) return recv.inlineProps.get(mem.name) ?? OPEN_INFO
      if (recv.typeName !== undefined)
        return closedPropsByType.get(recv.typeName)?.get(mem.name) ?? OPEN_INFO
    }
    return OPEN_INFO
  }

  const bindPattern = (pat: ts.BindingName, info: VarTypeInfo, hoist: boolean): void => {
    if (ts.isIdentifier(pat)) {
      setVar(pat.text, info, hoist)
      return
    }
    if (ts.isObjectBindingPattern(pat)) {
      for (const el of pat.elements) {
        const keyName =
          el.propertyName !== undefined &&
          (ts.isIdentifier(el.propertyName) ||
            ts.isStringLiteral(el.propertyName) ||
            ts.isNoSubstitutionTemplateLiteral(el.propertyName))
            ? el.propertyName.text
            : ts.isIdentifier(el.name)
              ? el.name.text
              : undefined
        const propInfo =
          keyName === undefined
            ? OPEN_INFO
            : (info.inlineProps?.get(keyName) ??
              (info.typeName !== undefined
                ? closedPropsByType.get(info.typeName)?.get(keyName)
                : undefined) ??
              OPEN_INFO)
        bindPattern(el.name, propInfo, hoist)
      }
    }
  }

  const precollectVarsInContainer = (container: ts.Node): void => {
    const scan = (n: ts.Node): void => {
      if (n !== container && ts.isFunctionLike(n)) return
      if (ts.isVariableStatement(n) && (n.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
        for (const decl of n.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
            const initFn = unwrapExpr(decl.initializer)
            if (isFnExpr(initFn)) recordFnReturn(decl.name.text, initFn.type)
          }
          const info =
            decl.type !== undefined
              ? resolveTypeNodeInfo(decl.type, closedTypeNames, closedPropsByType)
              : decl.initializer !== undefined
                ? resolveExprInfo(decl.initializer)
                : OPEN_INFO
          bindPattern(decl.name, info, true)
        }
      }
      ts.forEachChild(n, scan)
    }
    scan(container)
  }

  const CMP_TOKENS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ])

  const hasClosedLiteralComparison = (cond: ts.Expression): boolean =>
    findAstMatch(cond, (n) => {
      const u = ts.isExpression(n) ? unwrapExpr(n) : n
      if (!ts.isBinaryExpression(u) || !CMP_TOKENS.has(u.operatorToken.kind)) return false
      const [l, r] = [unwrapExpr(u.left), unwrapExpr(u.right)]
      const lLit = ts.isStringLiteral(l) || ts.isNoSubstitutionTemplateLiteral(l)
      const rLit = ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)
      return (
        (lLit && !rLit && resolveExprInfo(r).isClosed) ||
        (rLit && !lLit && resolveExprInfo(l).isClosed)
      )
    })

  precollectVarsInContainer(sourceFile)
  const violations: Array<Wave3AstViolation> = []
  const walk = (node: ts.Node): void => {
    const isFn = ts.isFunctionLike(node)
    const pushesScope =
      isFn ||
      ts.isBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isCatchClause(node)
    if (pushesScope) varScopes.push({ isFnBoundary: isFn, vars: new Map() })
    if (isFn) {
      precollectVarsInContainer(node)
      for (const p of node.parameters) {
        bindPattern(p.name, resolveTypeNodeInfo(p.type, closedTypeNames, closedPropsByType), false)
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const isVar =
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
      if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const initFn = unwrapExpr(node.initializer)
        if (isFnExpr(initFn)) recordFnReturn(node.name.text, initFn.type)
      }
      const info =
        node.type !== undefined
          ? resolveTypeNodeInfo(node.type, closedTypeNames, closedPropsByType)
          : node.initializer !== undefined
            ? resolveExprInfo(node.initializer)
            : OPEN_INFO
      bindPattern(node.name, info, isVar)
    }
    if (ts.isIfStatement(node) && hasClosedLiteralComparison(node.expression)) {
      violations.push({
        rule: "discriminant-branching",
        message: `If statement in '${normPath}' compares closed literal union — use match(...).exhaustive().`,
        node,
      })
    }
    if (ts.isConditionalExpression(node) && hasClosedLiteralComparison(node.condition)) {
      violations.push({
        rule: "discriminant-branching",
        message: `Ternary expression in '${normPath}' compares closed literal union — use match(...).exhaustive().`,
        node,
      })
    }
    ts.forEachChild(node, walk)
    if (pushesScope) varScopes.pop()
  }
  walk(sourceFile)
  return violations
}
