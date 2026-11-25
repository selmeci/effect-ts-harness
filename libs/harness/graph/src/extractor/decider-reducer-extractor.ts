import { match } from "ts-pattern"
import { Node, type ParameterDeclaration, type SourceFile, SyntaxKind } from "ts-morph"
import { type BranchingViolation, type PackageTag } from "../model.js"
import {
  addViolation,
  findEnclosingSymbolName,
  isContractOrDomainTag,
  stripCommentsAndTestTitles,
  type TaggedSchemaInfo,
} from "./extractor-types-and-helpers.js"

export const resolveSchemasForParameter = (
  param: ParameterDeclaration,
  taggedSchemasByTag: ReadonlyMap<string, TaggedSchemaInfo>,
  taggedSchemasByName: ReadonlyMap<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<TaggedSchemaInfo> => {
  const typeTexts = [param.getTypeNode()?.getText() ?? "", param.getType().getText(param)].join(" ")
  const rawTokens = new Set<string>()
  for (const m of typeTexts.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    const tok = m[1]
    if (tok && tok !== "typeof" && tok !== "Type" && tok !== "Schema" && tok !== "Readonly")
      rawTokens.add(tok)
  }
  const resolved: Array<TaggedSchemaInfo> = [],
    seen = new Set<TaggedSchemaInfo>(),
    queue = [...rawTokens],
    visited = new Set<string>()
  while (queue.length > 0) {
    const curr = queue.shift()!
    if (visited.has(curr)) continue
    visited.add(curr)
    const schemaByName = taggedSchemasByName.get(curr)
    if (schemaByName) {
      if (!seen.has(schemaByName)) {
        seen.add(schemaByName)
        resolved.push(schemaByName)
      }
      continue
    }
    const unionMembers = unionSchemaTagsByName.get(curr)
    if (unionMembers) {
      for (const member of unionMembers) queue.push(member)
      continue
    }
    const schemaByTag = taggedSchemasByTag.get(curr)
    if (schemaByTag && !seen.has(schemaByTag)) {
      seen.add(schemaByTag)
      resolved.push(schemaByTag)
    }
  }
  return resolved
}

export const checkDeciderTracing = (
  sourceFile: SourceFile,
  relPath: string,
  _filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  const isTracedWithEffectFn = (node: Node): boolean => {
    const text = node.getText()
    if (text.startsWith("Effect.fn(") || text.includes("Effect.fn(")) return true
    if (!Node.isCallExpression(node)) return false
    const expr = node.getExpression()
    return (
      (Node.isCallExpression(expr) && expr.getExpression().getText() === "Effect.fn") ||
      expr.getText() === "Effect.fn"
    )
  }

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = callExpr.getExpression().getText()
    if (calleeText === "Decider.make" || calleeText.endsWith(".Decider.make")) {
      const args = callExpr.getArguments()
      if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
        const decideProp = args[0].getProperty("decide")
        if (decideProp) {
          const checkDecl = (name: string): boolean => {
            const decl = sourceFile.getVariableDeclaration(name) ?? sourceFile.getFunction(name)
            return (
              !decl ||
              !Node.isVariableDeclaration(decl) ||
              !decl.getInitializer() ||
              !isTracedWithEffectFn(decl.getInitializer()!)
            )
          }
          const isUntraced = match(decideProp)
            .when(Node.isMethodDeclaration, () => true)
            .when(Node.isPropertyAssignment, (p) => {
              const init = p.getInitializer()
              return init
                ? Node.isIdentifier(init)
                  ? checkDecl(init.getText())
                  : !isTracedWithEffectFn(init)
                : false
            })
            .when(Node.isShorthandPropertyAssignment, (p) => checkDecl(p.getName()))
            .otherwise(() => false)

          if (isUntraced) {
            const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
            addViolation(
              violations,
              "untraced-decider",
              `Decider.make in '${enclosingSymbol}' binds an untraced 'decide' function — 'decide' must be declared with Effect.fn("<Domain>.decide") for automatic span tracing.`,
              relPath,
              decideProp.getStartLineNumber(),
              enclosingSymbol,
            )
          }
        }
      }
    }
  }

  if (relPath.endsWith("decider.ts") || relPath.endsWith("/decider.ts")) {
    const makeCandidates: Array<{ node: Node; text: string }> = []
    const addMake = (node: Node, fnLike: Node | undefined) => {
      if (
        fnLike &&
        (Node.isArrowFunction(fnLike) ||
          Node.isFunctionExpression(fnLike) ||
          Node.isMethodDeclaration(fnLike))
      ) {
        makeCandidates.push({ node, text: fnLike.getBody()?.getText() ?? fnLike.getText() })
      }
    }
    for (const v of sourceFile.getVariableDeclarations())
      if (v.getName() === "make") addMake(v, v.getInitializer())
    for (const f of sourceFile.getFunctions()) if (f.getName() === "make") addMake(f, f)
    for (const p of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment))
      if (p.getName() === "make") addMake(p, p.getInitializer())
    for (const m of sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration))
      if (m.getName() === "make") addMake(m, m)

    for (const cand of makeCandidates) {
      const cleanBody = cand.text.replace(/\s+/g, "")
      const hasTracing =
        cand.text.includes("Effect.fn") ||
        cand.text.includes("Effect.withSpan") ||
        cand.text.includes("withSpan")
      const returnsOptions =
        cleanBody === "options" ||
        cleanBody === "{returnoptions;}" ||
        cleanBody === "{returnoptions}" ||
        /^\{?\s*return\s+options;?\s*\}?$/.test(cand.text.trim()) ||
        cand.text.trim() === "options"

      if (!hasTracing && returnsOptions) {
        addViolation(
          violations,
          "untraced-decider",
          `Decider.make in '${relPath}' returns options unchanged without enforcing or wrapping span tracing — wrap or trace options.decide (e.g. Effect.withSpan / Effect.fn) in Decider.make.`,
          relPath,
          cand.node.getStartLineNumber(),
          `${relPath}#make`,
        )
      }
    }
  }
}

export const checkMissingAggregateIdGuard = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  taggedSchemasByTag: ReadonlyMap<string, TaggedSchemaInfo>,
  taggedSchemasByName: ReadonlyMap<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: ReadonlyMap<string, ReadonlyArray<string>>,
  violations: Array<BranchingViolation>,
): void => {
  if (!isContractOrDomainTag(filePkgTag)) return

  const deciderCalls: Array<{ callNode: Node; genFn: Node }> = []

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const innerCall = callExpr.getExpression()
    if (!Node.isCallExpression(innerCall) || innerCall.getExpression().getText() !== "Effect.fn")
      continue
    const spanArg = innerCall.getArguments()[0]
    if (!spanArg || !Node.isStringLiteral(spanArg)) continue
    const spanName = spanArg.getLiteralText()
    if (!spanName.endsWith(".decide") && spanName !== "decide") continue
    const arg0 = callExpr.getArguments()[0]
    if (
      arg0 &&
      (Node.isFunctionExpression(arg0) || Node.isArrowFunction(arg0)) &&
      !deciderCalls.some((c) => c.genFn === arg0)
    ) {
      const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
      deciderCalls.push({ callNode: parentVar ?? callExpr, genFn: arg0 })
    }
  }

  for (const { callNode, genFn } of deciderCalls) {
    const params =
      Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn) ? genFn.getParameters() : []
    if (params.length < 2) continue
    const cmdParam = params[0]!,
      stateParam = params[1]!

    const collectIdProps = (param: ParameterDeclaration): Set<string> => {
      const parts = param.getType().isUnion() ? param.getType().getUnionTypes() : [param.getType()]
      const set = new Set<string>()
      const perPart = parts
        .map(
          (part) =>
            new Set(
              part
                .getProperties()
                .map((p) => p.getName())
                .filter((n) => n.endsWith("Id") && n !== "commandId" && n !== "id"),
            ),
        )
        .filter((s) => s.size > 0)
      if (perPart.length > 0) {
        for (const id of perPart[0]!) {
          if (perPart.every((s) => s.has(id))) set.add(id)
        }
      }
      if (set.size === 0) {
        const schemas = resolveSchemasForParameter(
          param,
          taggedSchemasByTag,
          taggedSchemasByName,
          unionSchemaTagsByName,
        ).filter((s) =>
          s.properties.some((p) => p.endsWith("Id") && p !== "commandId" && p !== "id"),
        )
        if (schemas.length > 0) {
          for (const p of schemas[0]!.properties.filter(
            (x) => x.endsWith("Id") && x !== "commandId" && x !== "id",
          )) {
            if (schemas.every((s) => s.properties.includes(p))) set.add(p)
          }
        }
      }
      return set
    }

    const cmdIdProps = collectIdProps(cmdParam),
      stateIdProps = collectIdProps(stateParam)
    const sharedIdProps = [...cmdIdProps].filter((id) => stateIdProps.has(id))
    if (sharedIdProps.length === 0) continue

    const bodyNode =
      Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn) ? genFn.getBody() : undefined
    if (!bodyNode) continue

    const bodyText = stripCommentsAndTestTitles(bodyNode.getText())

    for (const idProp of sharedIdProps) {
      const rx = new RegExp(`([a-zA-Z0-9_$]+)\\.${idProp}\\b`)
      const distinct = (a: string, b: string): boolean => {
        const mA = a.match(rx),
          mB = b.match(rx)
        return Boolean(mA && mB && mA[1] !== mB[1])
      }
      const testMatch = (r: RegExp) => {
        const m = bodyText.match(r)
        return Boolean(m && m[1] !== m[2])
      }
      const hasIdComparison =
        bodyNode.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((bin) => {
          const op = bin.getOperatorToken().getKind()
          const isEq =
            op === SyntaxKind.EqualsEqualsEqualsToken ||
            op === SyntaxKind.ExclamationEqualsEqualsToken ||
            op === SyntaxKind.EqualsEqualsToken ||
            op === SyntaxKind.ExclamationEqualsToken
          return isEq && distinct(bin.getLeft().getText(), bin.getRight().getText())
        }) ||
        bodyNode.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => {
          const t = c.getExpression().getText()
          return (
            (t === "Equal.equals" || t.endsWith(".Equal.equals")) &&
            c.getArguments().length >= 2 &&
            distinct(c.getArguments()[0]!.getText(), c.getArguments()[1]!.getText())
          )
        }) ||
        testMatch(
          new RegExp(
            `\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*(?:===|!==|==|!=)\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`,
          ),
        ) ||
        testMatch(
          new RegExp(
            `Equal\\.equals\\(\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*,\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*\\)`,
          ),
        ) ||
        testMatch(
          new RegExp(
            `(?:if|when)\\s*\\([^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b[^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`,
          ),
        )

      if (!hasIdComparison) {
        const enclosingSymbol = findEnclosingSymbolName(callNode, relPath)
        addViolation(
          violations,
          "missing-aggregate-id-guard",
          `Decider '${enclosingSymbol}' accepts command and state that both carry aggregate identifier '${idProp}', but never verifies that command.${idProp} matches state.${idProp} on existing state variants.`,
          relPath,
          callNode.getStartLineNumber(),
          enclosingSymbol,
        )
      }
    }
  }
}
