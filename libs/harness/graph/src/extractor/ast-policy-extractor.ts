import { match } from "ts-pattern"
import {
  type BinaryExpression,
  Node,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol as MorphSymbol,
  SyntaxKind,
  ts,
} from "ts-morph"
import { type BranchingViolation, type PackageTag } from "../model.js"
import { type SourceFileInput } from "./compiler-session.js"
import {
  addViolation,
  findEnclosingSymbolName,
  isClosedFiniteUnionType,
  isClosedStringLiteralUnionType,
  isDiscriminantPropertyOfUnion,
  isEqualityOpKind,
  isInfraOrAppTag,
  isLiteralNode,
  TAG_GUARD_CALLEES,
} from "./extractor-types-and-helpers.js"

export const checkPass0ZeroToleranceAst = (
  sourceFile: SourceFile,
  input: SourceFileInput,
  violations: Array<BranchingViolation>,
): void => {
  const lineOf = (n: ts.Node): number =>
    sourceFile.compilerNode.getLineAndCharacterOfPosition(n.getStart(sourceFile.compilerNode))
      .line + 1
  const pushCast = (n: ts.Node, message: string): void =>
    addViolation(
      violations,
      "unsafe-type-cast",
      message,
      input.filePath,
      lineOf(n),
      input.filePath,
      [input.filePath],
    )
  const unwrapTypeParen = (n: ts.TypeNode): ts.TypeNode => {
    let c = n
    while (ts.isParenthesizedTypeNode(c)) c = c.type
    return c
  }
  const unwrapExpr = (e: ts.Expression): ts.Expression => {
    let c = e
    while (ts.isParenthesizedExpression(c) || ts.isSatisfiesExpression(c)) c = c.expression
    return c
  }

  const checkNode = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      pushCast(
        node,
        `Explicit 'any' (as any, : any, <any>) is banned in '${input.filePath}' — use a concrete static type or decode via Effect Schema.`,
      )
    }

    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
    ) {
      pushCast(
        node,
        `Unsafe 'as never' cast is banned in '${input.filePath}' — fix the type mismatch or use ts-pattern .exhaustive().`,
      )
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const inner = unwrapExpr(node.expression)
      if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
        pushCast(
          node,
          `Double type assertion ('as unknown as T') is banned in '${input.filePath}' — decode with Effect Schema or type the boundary properly.`,
        )
      }
    }

    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      node.type != null &&
      unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
    ) {
      pushCast(
        node,
        `Explicit ': never' annotation on parameter or variable is banned in '${input.filePath}'.`,
      )
    }

    ts.forEachChild(node, checkNode)
  }

  checkNode(sourceFile.compilerNode)
}

const BANNED_SQLITE_MODULES = new Set(["node:sqlite", "sqlite", "better-sqlite3"])

export const checkNodeSqliteInInfra = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  if (!isInfraOrAppTag(filePkgTag)) return
  const pushSqlite = (modSpec: string, node: Node): void =>
    addViolation(
      violations,
      "node-sqlite-in-infra",
      `Do not import '${modSpec}' in '${relPath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
      relPath,
      node.getStartLineNumber(),
      relPath,
    )
  for (const imp of sourceFile.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue()
    if (BANNED_SQLITE_MODULES.has(modSpec)) pushSqlite(modSpec, imp)
  }
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    const exprText = expr.getText()
    const isDynamic =
      expr.getKind() === SyntaxKind.ImportKeyword || exprText === "require" || exprText === "import"
    if (!isDynamic) continue
    const firstArg = callExpr.getArguments()[0]
    if (
      firstArg != null &&
      (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) &&
      BANNED_SQLITE_MODULES.has(firstArg.getLiteralValue())
    ) {
      pushSqlite(firstArg.getLiteralValue(), callExpr)
    }
  }
}

const unwrapMorphExpr = (node: Node): Node => {
  let curr = node
  while (
    Node.isParenthesizedExpression(curr) ||
    Node.isAsExpression(curr) ||
    Node.isSatisfiesExpression(curr) ||
    Node.isTypeAssertion(curr) ||
    Node.isNonNullExpression(curr)
  ) {
    curr = curr.getExpression()
  }
  return curr
}

export const checkDiscriminantAndPredicateBranching = (
  sourceFile: SourceFile,
  relPath: string,
  violations: Array<BranchingViolation>,
): void => {
  const discriminantAliasVars = new Set<string>()
  const typeofAliasSymbols = new Set<MorphSymbol>()
  const isTypeofAliasSymbol = (node: Node): boolean => {
    if (!Node.isIdentifier(node)) return false
    const sym = node.getSymbol()
    return sym !== undefined && typeofAliasSymbols.has(sym)
  }

  for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = varDecl.getInitializer()
    if (!init) continue
    const uInit = unwrapMorphExpr(init)
    if (Node.isTypeOfExpression(uInit) || isTypeofAliasSymbol(uInit)) {
      const nameNode = varDecl.getNameNode()
      if (Node.isIdentifier(nameNode)) {
        const sym = varDecl.getSymbol() ?? nameNode.getSymbol()
        if (sym !== undefined) typeofAliasSymbols.add(sym)
      }
      continue
    }
    if (Node.isPropertyAccessExpression(uInit)) {
      const objExpr = uInit.getExpression()
      const propName = uInit.getName()
      const objType = objExpr.getType()
      if (isDiscriminantPropertyOfUnion(objType, propName, uInit)) {
        discriminantAliasVars.add(varDecl.getName())
      }
      continue
    }
    const nameNode = varDecl.getNameNode()
    if (Node.isObjectBindingPattern(nameNode)) {
      const objType = uInit.getType()
      for (const elem of nameNode.getElements()) {
        const propName = elem.getPropertyNameNode()?.getText() ?? elem.getName()
        if (isDiscriminantPropertyOfUnion(objType, propName, elem)) {
          discriminantAliasVars.add(elem.getName())
        }
      }
    }
  }

  const pushDiscriminant = (locNode: Node, lineNode: Node, detail: string): void => {
    const sym = findEnclosingSymbolName(locNode, relPath)
    addViolation(
      violations,
      "discriminant-branching",
      detail.replace("{sym}", sym),
      relPath,
      lineNode.getStartLineNumber(),
      sym,
    )
  }

  const checkEqualityBinary = (
    bin: BinaryExpression,
    locNode: Node,
    lineNode: Node,
    leadLabel: string,
    viaLabel: string,
  ): boolean => {
    if (!isEqualityOpKind(bin.getOperatorToken().getKind())) return false
    const candidatePairs = [
      { side: bin.getLeft(), other: bin.getRight() },
      { side: bin.getRight(), other: bin.getLeft() },
    ]
    for (const { side, other } of candidatePairs) {
      const uSide = unwrapMorphExpr(side)
      const uOther = unwrapMorphExpr(other)
      if (Node.isPropertyAccessExpression(uSide)) {
        if (!isLiteralNode(uOther)) continue
        const objExpr = uSide.getExpression()
        const propName = uSide.getName()
        if (isDiscriminantPropertyOfUnion(objExpr.getType(), propName, uSide)) {
          pushDiscriminant(
            locNode,
            lineNode,
            `${leadLabel} in '{sym}' branches on union discriminant '${objExpr.getText()}.${propName}' via ${viaLabel} — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
          )
          return true
        }
      }
      if (Node.isIdentifier(uSide) && discriminantAliasVars.has(uSide.getText())) {
        pushDiscriminant(
          locNode,
          lineNode,
          `${leadLabel} in '{sym}' branches on aliased union discriminant '${uSide.getText()}' via ${viaLabel} — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
        )
        return true
      }
      if (
        (Node.isStringLiteral(uOther) || Node.isNoSubstitutionTemplateLiteral(uOther)) &&
        !Node.isTypeOfExpression(uSide) &&
        !isTypeofAliasSymbol(uSide) &&
        isClosedStringLiteralUnionType(side.getType())
      ) {
        pushDiscriminant(
          locNode,
          lineNode,
          `${leadLabel} in '{sym}' branches on closed string literal union '${uSide.getText()}' via ${viaLabel} — enumerate all variants explicitly with match(${uSide.getText()}).with(...).exhaustive() from ts-pattern.`,
        )
        return true
      }
    }
    return false
  }

  const checkConditionNode = (condExpr: Node, statementNode: Node): void => {
    const callNodes = [
      ...(Node.isCallExpression(condExpr) ? [condExpr] : []),
      ...condExpr.getDescendantsOfKind(SyntaxKind.CallExpression),
    ]
    for (const callNode of callNodes) {
      const calleeText = callNode.getExpression().getText()
      if (TAG_GUARD_CALLEES.has(calleeText)) {
        pushDiscriminant(
          statementNode,
          statementNode,
          `Condition in '{sym}' branches on tag guard '${calleeText}(...)' via if/ternary — enumerate all variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
        )
        return
      }
    }

    const binNodes = [
      ...(Node.isBinaryExpression(condExpr) ? [condExpr] : []),
      ...condExpr.getDescendantsOfKind(SyntaxKind.BinaryExpression),
    ]
    for (const bin of binNodes) {
      if (checkEqualityBinary(bin, statementNode, statementNode, "Condition", "if/ternary")) {
        return
      }
    }
  }

  for (const ifStmt of sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    checkConditionNode(ifStmt.getExpression(), ifStmt)
  }
  for (const condExpr of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    checkConditionNode(condExpr.getCondition(), condExpr)
  }

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = callExpr.getExpression()
    if (!Node.isPropertyAccessExpression(callee)) continue
    const methodName = callee.getName()
    if (
      methodName !== "filter" &&
      methodName !== "find" &&
      methodName !== "some" &&
      methodName !== "every"
    ) {
      continue
    }
    const cb = callExpr.getArguments()[0]
    if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
      for (const bin of cb.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        checkEqualityBinary(bin, callExpr, bin, "Predicate callback", `.${methodName}()`)
      }
    }
  }
}

const UNSCOPED_RUN_CALLEES = new Set([
  "Effect.runSync",
  "Effect.runPromise",
  "Effect.runFork",
  "Runtime.runSync",
  "Runtime.runPromise",
])
const MATCH_CHAIN_METHODS = new Set(["with", "when", "narrow", "returnType"])

export const checkUnscopedEffectRun = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = callExpr.getExpression().getText()
    if (!UNSCOPED_RUN_CALLEES.has(calleeText)) continue
    const isInsideDeciderMake = callExpr
      .getAncestors()
      .some(
        (a) =>
          Node.isCallExpression(a) && /^(?:.*\.)?Decider\.make$/.test(a.getExpression().getText()),
      )
    const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
    const isDomainOrContract =
      (filePkgTag === "domain" || filePkgTag === "contract") && !relPath.endsWith("/testing.ts")
    const isReducerSymbol = /#(evolve\w*|reduce\w*|.*Reducer)$/i.test(enclosingSymbol)
    if (isDomainOrContract || isInsideDeciderMake || isReducerSymbol) {
      addViolation(
        violations,
        "unscoped-effect-run",
        `Call to '${calleeText}' in '${enclosingSymbol}' executes an Effect synchronously/imperatively inside domain/reducer logic — keep reducers pure '(state, event) => State' and yield Effects instead of calling Effect.run*.`,
        relPath,
        callExpr.getStartLineNumber(),
        enclosingSymbol,
      )
    }
  }
}

export const checkNonExhaustiveUnionMatch = (
  sourceFile: SourceFile,
  relPath: string,
  violations: Array<BranchingViolation>,
): void => {
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = callExpr.getExpression()
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "otherwise") continue
    let curr: Node = callee.getExpression()
    while (Node.isCallExpression(curr)) {
      const innerCallee = curr.getExpression()
      if (!Node.isPropertyAccessExpression(innerCallee)) break
      if (!MATCH_CHAIN_METHODS.has(innerCallee.getName())) break
      curr = innerCallee.getExpression()
    }
    if (!Node.isCallExpression(curr) || curr.getExpression().getText() !== "match") continue
    const matchArg = curr.getArguments()[0]
    if (!matchArg) continue
    const argType = matchArg.getType()
    if (!isClosedFiniteUnionType(argType, matchArg)) continue
    const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
    addViolation(
      violations,
      "non-exhaustive-union-match",
      `match(${matchArg.getText()}) in '${enclosingSymbol}' matches on a closed union type '${argType.getText(matchArg)}' but terminates with .otherwise() — enumerate every variant and terminate with .exhaustive().`,
      relPath,
      callExpr.getStartLineNumber(),
      enclosingSymbol,
    )
  }
}

export const checkFallbackJsonEquality = (
  sourceFile: SourceFile,
  relPath: string,
  violations: Array<BranchingViolation>,
): void => {
  for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const opKind = bin.getOperatorToken().getKind()
    const isCaseA =
      isEqualityOpKind(opKind) &&
      bin.getLeft().getText().trim().startsWith("JSON.stringify(") &&
      bin.getRight().getText().trim().startsWith("JSON.stringify(")
    const isCaseB =
      (opKind === SyntaxKind.BarBarToken || opKind === SyntaxKind.AmpersandAmpersandToken) &&
      bin.getLeft().getText().includes("Equal.equals(") &&
      bin.getRight().getText().includes("JSON.stringify(")

    if (isCaseA || isCaseB) {
      const enclosingSymbol = findEnclosingSymbolName(bin, relPath)
      addViolation(
        violations,
        "fallback-json-equality",
        `Comparison in '${enclosingSymbol}' uses JSON.stringify equality fallback — compare Effect Data/Schema values exclusively with Equal.equals(a, b).`,
        relPath,
        bin.getStartLineNumber(),
        enclosingSymbol,
      )
    }
  }
}

export const checkVacuousErrorAssertion = (
  sourceFile: SourceFile,
  relPath: string,
  violations: Array<BranchingViolation>,
): void => {
  const ASSERTION_NAME_REGEX = /^(?:thenFails|assertFails|expectError)$/
  const assertionCandidates = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodSignature),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
  ]
  for (const node of assertionCandidates) {
    const name = node.getName()
    if (!name || !ASSERTION_NAME_REGEX.test(name)) continue

    const params: ReadonlyArray<ParameterDeclaration> | undefined = match(node)
      .when(
        (n) =>
          Node.isMethodSignature(n) || Node.isMethodDeclaration(n) || Node.isFunctionDeclaration(n),
        (n) => n.getParameters(),
      )
      .when(
        (n) => Node.isVariableDeclaration(n) || Node.isPropertyAssignment(n),
        (n) => {
          const init = n.getInitializer()
          return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
            ? init.getParameters()
            : undefined
        },
      )
      .otherwise(() => undefined)

    if (params !== undefined) {
      const isVacuous =
        params.length === 0 ||
        (params[0] !== undefined &&
          (params[0].hasQuestionToken() ||
            params[0].hasInitializer() ||
            /\bundefined\b/.test(params[0].getTypeNode()?.getText() ?? "")))
      if (isVacuous) {
        const enclosingSymbol = findEnclosingSymbolName(node, relPath)
        addViolation(
          violations,
          "vacuous-error-assertion",
          `Assertion helper '${name}' in '${enclosingSymbol}' allows an optional or omitted expected error — require an explicit expected error instance or predicate so arbitrary failures are never silently swallowed.`,
          relPath,
          node.getStartLineNumber(),
          enclosingSymbol,
        )
      }
    }
  }
}

export const runAstPolicyChecks = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  checkNodeSqliteInInfra(sourceFile, relPath, filePkgTag, violations)
  checkDiscriminantAndPredicateBranching(sourceFile, relPath, violations)
  checkUnscopedEffectRun(sourceFile, relPath, filePkgTag, violations)
  checkNonExhaustiveUnionMatch(sourceFile, relPath, violations)
  checkFallbackJsonEquality(sourceFile, relPath, violations)
  checkVacuousErrorAssertion(sourceFile, relPath, violations)
}
