import {
  Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
  ts,
} from "ts-morph"
import { type BranchingViolation, type PackageTag } from "../model.js"
import { type SourceFileInput } from "./compiler-session.js"
import {
  findEnclosingSymbolName,
  isClosedFiniteUnionType,
  isDiscriminantPropertyOfUnion,
} from "./extractor-types-and-helpers.js"

const isLiteralNode = (n: Node): boolean =>
  Node.isStringLiteral(n) || Node.isNumericLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) ||
  n.getKind() === SyntaxKind.TrueKeyword || n.getKind() === SyntaxKind.FalseKeyword

export const checkPass0ZeroToleranceAst = (
  sourceFile: SourceFile,
  input: SourceFileInput,
  violations: Array<BranchingViolation>,
): void => {
  const checkNode = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      violations.push({
        rule: "unsafe-type-cast",
        message: `Explicit 'any' (as any, : any, <any>) is banned in '${input.filePath}' — use a concrete static type or decode via Effect Schema.`,
        path: [input.filePath],
        file: input.filePath,
        line: sourceFile.compilerNode.getLineAndCharacterOfPosition(node.getStart(sourceFile.compilerNode)).line + 1,
        enclosingSymbol: input.filePath,
      })
    }

    const unwrapTypeParen = (n: ts.TypeNode): ts.TypeNode => {
      let c = n; while (ts.isParenthesizedTypeNode(c)) c = c.type; return c
    }

    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
    ) {
      violations.push({
        rule: "unsafe-type-cast",
        message: `Unsafe 'as never' cast is banned in '${input.filePath}' — fix the type mismatch or use ts-pattern .exhaustive().`,
        path: [input.filePath],
        file: input.filePath,
        line: sourceFile.compilerNode.getLineAndCharacterOfPosition(node.getStart(sourceFile.compilerNode)).line + 1,
        enclosingSymbol: input.filePath,
      })
    }

    const unwrapExpr = (e: ts.Expression): ts.Expression => {
      let c = e; while (ts.isParenthesizedExpression(c) || ts.isSatisfiesExpression(c)) c = c.expression; return c
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const inner = unwrapExpr(node.expression)
      if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
        violations.push({
          rule: "unsafe-type-cast",
          message: `Double type assertion ('as unknown as T') is banned in '${input.filePath}' — decode with Effect Schema or type the boundary properly.`,
          path: [input.filePath],
          file: input.filePath,
          line: sourceFile.compilerNode.getLineAndCharacterOfPosition(node.getStart(sourceFile.compilerNode)).line + 1,
          enclosingSymbol: input.filePath,
        })
      }
    }

    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      node.type != null && unwrapTypeParen(node.type).kind === ts.SyntaxKind.NeverKeyword
    ) {
      violations.push({
        rule: "unsafe-type-cast",
        message: `Explicit ': never' annotation on parameter or variable is banned in '${input.filePath}'.`,
        path: [input.filePath],
        file: input.filePath,
        line: sourceFile.compilerNode.getLineAndCharacterOfPosition(node.getStart(sourceFile.compilerNode)).line + 1,
        enclosingSymbol: input.filePath,
      })
    }

    ts.forEachChild(node, checkNode)
  }

  checkNode(sourceFile.compilerNode)
}

export const checkNodeSqliteInInfra = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  if (filePkgTag !== "infra" && filePkgTag !== "app") return
  for (const imp of sourceFile.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue()
    if (modSpec === "node:sqlite" || modSpec === "sqlite" || modSpec === "better-sqlite3") {
      violations.push({
        rule: "node-sqlite-in-infra",
        message: `Do not import '${modSpec}' in '${relPath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
        file: relPath,
        line: imp.getStartLineNumber(),
        enclosingSymbol: relPath,
      })
    }
  }
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    const exprText = expr.getText()
    const isRequireOrImport =
      (Node.isIdentifier(expr) && exprText === "require") ||
      expr.getKind() === SyntaxKind.ImportKeyword ||
      exprText === "require" || exprText === "import"
    if (isRequireOrImport) {
      const args = callExpr.getArguments()
      if (args.length > 0) {
        const firstArg = args[0]
        const modSpec = firstArg != null && Node.isStringLiteral(firstArg)
          ? firstArg.getLiteralValue()
          : firstArg != null && Node.isNoSubstitutionTemplateLiteral(firstArg)
            ? firstArg.getLiteralValue()
            : undefined
        if (modSpec === "node:sqlite" || modSpec === "sqlite" || modSpec === "better-sqlite3") {
          violations.push({
            rule: "node-sqlite-in-infra",
            message: `Do not import '${modSpec}' in '${relPath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
            file: relPath,
            line: callExpr.getStartLineNumber(),
            enclosingSymbol: relPath,
          })
        }
      }
    }
  }
}

export const checkDiscriminantAndPredicateBranching = (
  sourceFile: SourceFile,
  relPath: string,
  violations: Array<BranchingViolation>,
): void => {
  const discriminantAliasVars = new Set<string>()
  for (const varDecl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = varDecl.getInitializer()
    if (init && Node.isPropertyAccessExpression(init)) {
      const objExpr = init.getExpression()
      const propName = init.getName()
      const objType = objExpr.getType()
      if (isDiscriminantPropertyOfUnion(objType, propName, init)) {
        discriminantAliasVars.add(varDecl.getName())
      }
    } else if (init) {
      const nameNode = varDecl.getNameNode()
      if (Node.isObjectBindingPattern(nameNode)) {
        const objType = init.getType()
        for (const elem of nameNode.getElements()) {
          const propName = elem.getPropertyNameNode()?.getText() ?? elem.getName()
          if (isDiscriminantPropertyOfUnion(objType, propName, elem)) {
            discriminantAliasVars.add(elem.getName())
          }
        }
      }
    }
  }

  const checkConditionNode = (condExpr: Node, statementNode: Node): void => {
    const callNodes = [
      ...(Node.isCallExpression(condExpr) ? [condExpr] : []),
      ...condExpr.getDescendantsOfKind(SyntaxKind.CallExpression),
    ]
    for (const callNode of callNodes) {
      const calleeText = callNode.getExpression().getText()
      if (
        calleeText === "Exit.isSuccess" || calleeText === "Exit.isFailure" ||
        calleeText === "Option.isSome" || calleeText === "Option.isNone" ||
        calleeText === "Either.isRight" || calleeText === "Either.isLeft" ||
        calleeText === "Result.isSuccess" || calleeText === "Result.isFailure"
      ) {
        const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
        violations.push({
          rule: "discriminant-branching",
          message: `Condition in '${enclosingSymbol}' branches on tag guard '${calleeText}(...)' via if/ternary — enumerate all variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
          file: relPath,
          line: statementNode.getStartLineNumber(),
          enclosingSymbol,
        })
        return
      }
    }

    const binNodes = [
      ...(Node.isBinaryExpression(condExpr) ? [condExpr] : []),
      ...condExpr.getDescendantsOfKind(SyntaxKind.BinaryExpression),
    ]
    for (const bin of binNodes) {
      const opKind = bin.getOperatorToken().getKind()
      if (
        opKind !== SyntaxKind.EqualsEqualsEqualsToken && opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
        opKind !== SyntaxKind.EqualsEqualsToken && opKind !== SyntaxKind.ExclamationEqualsToken
      ) continue
      const candidatePairs = [
        { side: bin.getLeft(), other: bin.getRight() },
        { side: bin.getRight(), other: bin.getLeft() },
      ]
      for (const { side, other } of candidatePairs) {
        if (Node.isPropertyAccessExpression(side)) {
          if (!isLiteralNode(other)) continue
          const objExpr = side.getExpression()
          const propName = side.getName()
          const objType = objExpr.getType()
          if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
            const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
            violations.push({
              rule: "discriminant-branching",
              message: `Condition in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via if/ternary — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
              file: relPath,
              line: statementNode.getStartLineNumber(),
              enclosingSymbol,
            })
            return
          }
        } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
          const enclosingSymbol = findEnclosingSymbolName(statementNode, relPath)
          violations.push({
            rule: "discriminant-branching",
            message: `Condition in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via if/ternary — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
            file: relPath,
            line: statementNode.getStartLineNumber(),
            enclosingSymbol,
          })
          return
        }
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
    if (Node.isPropertyAccessExpression(callee)) {
      const methodName = callee.getName()
      if (methodName === "filter" || methodName === "find" || methodName === "some" || methodName === "every") {
        const args = callExpr.getArguments()
        if (args.length > 0 && args[0]) {
          const cb = args[0]
          if (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) {
            for (const bin of cb.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
              const opKind = bin.getOperatorToken().getKind()
              if (
                opKind !== SyntaxKind.EqualsEqualsEqualsToken && opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
                opKind !== SyntaxKind.EqualsEqualsToken && opKind !== SyntaxKind.ExclamationEqualsToken
              ) continue
              const candidatePairs = [
                { side: bin.getLeft(), other: bin.getRight() },
                { side: bin.getRight(), other: bin.getLeft() },
              ]
              for (const { side, other } of candidatePairs) {
                if (Node.isPropertyAccessExpression(side)) {
                  if (!isLiteralNode(other)) continue
                  const objExpr = side.getExpression()
                  const propName = side.getName()
                  const objType = objExpr.getType()
                  if (isDiscriminantPropertyOfUnion(objType, propName, side)) {
                    const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                    violations.push({
                      rule: "discriminant-branching",
                      message: `Predicate callback in '${enclosingSymbol}' branches on union discriminant '${objExpr.getText()}.${propName}' via .${methodName}() — enumerate all union variants explicitly with match(${objExpr.getText()}).with(...).exhaustive() from ts-pattern.`,
                      file: relPath,
                      line: bin.getStartLineNumber(),
                      enclosingSymbol,
                    })
                    break
                  }
                } else if (Node.isIdentifier(side) && discriminantAliasVars.has(side.getText())) {
                  const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
                  violations.push({
                    rule: "discriminant-branching",
                    message: `Predicate callback in '${enclosingSymbol}' branches on aliased union discriminant '${side.getText()}' via .${methodName}() — enumerate all union variants explicitly with match(...).with(...).exhaustive() from ts-pattern.`,
                    file: relPath,
                    line: bin.getStartLineNumber(),
                    enclosingSymbol,
                  })
                  break
                }
              }
            }
          }
        }
      }
    }
  }
}

export const checkUnscopedEffectRun = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = callExpr.getExpression()
    const calleeText = callee.getText()
    if (
      calleeText === "Effect.runSync" || calleeText === "Effect.runPromise" ||
      calleeText === "Effect.runFork" || calleeText === "Runtime.runSync" ||
      calleeText === "Runtime.runPromise"
    ) {
      const isInsideDeciderMake = callExpr
        .getAncestors()
        .some((a) => Node.isCallExpression(a) && /^(?:.*\.)?Decider\.make$/.test(a.getExpression().getText()))
      const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
      const isDomainOrContract =
        (filePkgTag === "domain" || filePkgTag === "contract") && !relPath.endsWith("/testing.ts")
      const isReducerSymbol = /#(evolve\w*|reduce\w*|.*Reducer)$/i.test(enclosingSymbol)

      if (isDomainOrContract || isInsideDeciderMake || isReducerSymbol) {
        violations.push({
          rule: "unscoped-effect-run",
          message: `Call to '${calleeText}' in '${enclosingSymbol}' executes an Effect synchronously/imperatively inside domain/reducer logic — keep reducers pure '(state, event) => State' and yield Effects instead of calling Effect.run*.`,
          file: relPath,
          line: callExpr.getStartLineNumber(),
          enclosingSymbol,
        })
      }
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
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "otherwise") {
      let curr: Node = callee.getExpression()
      while (Node.isCallExpression(curr)) {
        const innerCallee = curr.getExpression()
        if (
          Node.isPropertyAccessExpression(innerCallee) &&
          (innerCallee.getName() === "with" || innerCallee.getName() === "when" ||
            innerCallee.getName() === "narrow" || innerCallee.getName() === "returnType")
        ) {
          curr = innerCallee.getExpression()
        } else {
          break
        }
      }
      if (Node.isCallExpression(curr) && curr.getExpression().getText() === "match") {
        const matchArg = curr.getArguments()[0]
        if (matchArg) {
          const argType = matchArg.getType()
          if (isClosedFiniteUnionType(argType, matchArg)) {
            const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
            violations.push({
              rule: "non-exhaustive-union-match",
              message: `match(${matchArg.getText()}) in '${enclosingSymbol}' matches on a closed union type '${argType.getText(matchArg)}' but terminates with .otherwise() — enumerate every variant and terminate with .exhaustive().`,
              file: relPath,
              line: callExpr.getStartLineNumber(),
              enclosingSymbol,
            })
          }
        }
      }
    }
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
      (opKind === SyntaxKind.EqualsEqualsEqualsToken || opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
        opKind === SyntaxKind.EqualsEqualsToken || opKind === SyntaxKind.ExclamationEqualsToken) &&
      bin.getLeft().getText().trim().startsWith("JSON.stringify(") &&
      bin.getRight().getText().trim().startsWith("JSON.stringify(")
    const isCaseB =
      (opKind === SyntaxKind.BarBarToken || opKind === SyntaxKind.AmpersandAmpersandToken) &&
      bin.getLeft().getText().includes("Equal.equals(") &&
      bin.getRight().getText().includes("JSON.stringify(")

    if (isCaseA || isCaseB) {
      const enclosingSymbol = findEnclosingSymbolName(bin, relPath)
      violations.push({
        rule: "fallback-json-equality",
        message: `Comparison in '${enclosingSymbol}' uses JSON.stringify equality fallback — compare Effect Data/Schema values exclusively with Equal.equals(a, b).`,
        file: relPath,
        line: bin.getStartLineNumber(),
        enclosingSymbol,
      })
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

    let params: ReadonlyArray<ParameterDeclaration> | undefined
    if (Node.isMethodSignature(node) || Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node)) {
      params = node.getParameters()
    } else if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) {
      const init = node.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        params = init.getParameters()
      }
    }

    if (params !== undefined) {
      const isVacuous =
        params.length === 0 ||
        (params[0] !== undefined &&
          (params[0].hasQuestionToken() || params[0].hasInitializer() ||
            /\bundefined\b/.test(params[0].getTypeNode()?.getText() ?? "")))
      if (isVacuous) {
        const enclosingSymbol = findEnclosingSymbolName(node, relPath)
        violations.push({
          rule: "vacuous-error-assertion",
          message: `Assertion helper '${name}' in '${enclosingSymbol}' allows an optional or omitted expected error — require an explicit expected error instance or predicate so arbitrary failures are never silently swallowed.`,
          file: relPath, line: node.getStartLineNumber(), enclosingSymbol,
        })
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
