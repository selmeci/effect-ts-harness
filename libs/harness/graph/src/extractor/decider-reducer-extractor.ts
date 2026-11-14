import { match } from "ts-pattern"
import {
  type CallExpression,
  Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
} from "ts-morph"
import {
  type BranchingViolation,
  type PackageTag,
} from "../model.js"
import {
  addViolation,
  findEnclosingSymbolName,
  stripCommentsAndTestTitles,
  type TaggedSchemaInfo,
} from "./extractor-types-and-helpers.js"

const resolveSchemasForParameter = (
  param: ParameterDeclaration,
  taggedSchemasByTag: ReadonlyMap<string, TaggedSchemaInfo>,
  taggedSchemasByName: ReadonlyMap<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<TaggedSchemaInfo> => {
  const typeTexts = [param.getTypeNode()?.getText() ?? "", param.getType().getText(param)].join(" ")
  const rawTokens = new Set<string>()
  for (const m of typeTexts.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    const tok = m[1]
    if (tok && tok !== "typeof" && tok !== "Type" && tok !== "Schema" && tok !== "Readonly") rawTokens.add(tok)
  }
  const resolved: Array<TaggedSchemaInfo> = [], seen = new Set<TaggedSchemaInfo>(), queue = [...rawTokens], visited = new Set<string>()
  while (queue.length > 0) {
    const curr = queue.shift()!
    if (visited.has(curr)) continue
    visited.add(curr)
    const schemaByName = taggedSchemasByName.get(curr)
    if (schemaByName) {
      if (!seen.has(schemaByName)) { seen.add(schemaByName); resolved.push(schemaByName) }
      continue
    }
    const unionMembers = unionSchemaTagsByName.get(curr)
    if (unionMembers) { for (const member of unionMembers) queue.push(member); continue }
    const schemaByTag = taggedSchemasByTag.get(curr)
    if (schemaByTag && !seen.has(schemaByTag)) { seen.add(schemaByTag); resolved.push(schemaByTag) }
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
    return (Node.isCallExpression(expr) && expr.getExpression().getText() === "Effect.fn") || expr.getText() === "Effect.fn"
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
            return !decl || !Node.isVariableDeclaration(decl) || !decl.getInitializer() || !isTracedWithEffectFn(decl.getInitializer()!)
          }
          const isUntraced = match(decideProp)
            .when(Node.isMethodDeclaration, () => true)
            .when(Node.isPropertyAssignment, (p) => { const init = p.getInitializer(); return init ? (Node.isIdentifier(init) ? checkDecl(init.getText()) : !isTracedWithEffectFn(init)) : false })
            .when(Node.isShorthandPropertyAssignment, (p) => checkDecl(p.getName()))
            .otherwise(() => false)

          if (isUntraced) {
            const enclosingSymbol = findEnclosingSymbolName(callExpr, relPath)
            addViolation(violations, "untraced-decider",
              `Decider.make in '${enclosingSymbol}' binds an untraced 'decide' function — 'decide' must be declared with Effect.fn("<Domain>.decide") for automatic span tracing.`,
              relPath, decideProp.getStartLineNumber(), enclosingSymbol)
          }
        }
      }
    }
  }

  if (relPath.endsWith("decider.ts") || relPath.endsWith("/decider.ts")) {
    const makeCandidates: Array<{ node: Node; text: string }> = []
    const addMake = (node: Node, fnLike: Node | undefined) => {
      if (fnLike && (Node.isArrowFunction(fnLike) || Node.isFunctionExpression(fnLike) || Node.isMethodDeclaration(fnLike))) {
        makeCandidates.push({ node, text: fnLike.getBody()?.getText() ?? fnLike.getText() })
      }
    }
    for (const v of sourceFile.getVariableDeclarations()) if (v.getName() === "make") addMake(v, v.getInitializer())
    for (const f of sourceFile.getFunctions()) if (f.getName() === "make") addMake(f, f)
    for (const p of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) if (p.getName() === "make") addMake(p, p.getInitializer())
    for (const m of sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) if (m.getName() === "make") addMake(m, m)

    for (const cand of makeCandidates) {
      const cleanBody = cand.text.replace(/\s+/g, "")
      const hasTracing = cand.text.includes("Effect.fn") || cand.text.includes("Effect.withSpan") || cand.text.includes("withSpan")
      const returnsOptions =
        cleanBody === "options" || cleanBody === "{returnoptions;}" || cleanBody === "{returnoptions}" ||
        /^\{?\s*return\s+options;?\s*\}?$/.test(cand.text.trim()) || cand.text.trim() === "options"

      if (!hasTracing && returnsOptions) {
        addViolation(violations, "untraced-decider",
          `Decider.make in '${relPath}' returns options unchanged without enforcing or wrapping span tracing — wrap or trace options.decide (e.g. Effect.withSpan / Effect.fn) in Decider.make.`,
          relPath, cand.node.getStartLineNumber(), `${relPath}#make`)
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
  if (filePkgTag !== "contract" && filePkgTag !== "domain") return

  const deciderCalls: Array<{ callNode: Node; genFn: Node }> = []

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const innerCall = callExpr.getExpression()
    if (!Node.isCallExpression(innerCall) || innerCall.getExpression().getText() !== "Effect.fn") continue
    const spanArg = innerCall.getArguments()[0]
    if (!spanArg || !Node.isStringLiteral(spanArg)) continue
    const spanName = spanArg.getLiteralText()
    if (!spanName.endsWith(".decide") && spanName !== "decide") continue
    const arg0 = callExpr.getArguments()[0]
    if (arg0 && (Node.isFunctionExpression(arg0) || Node.isArrowFunction(arg0)) && !deciderCalls.some((c) => c.genFn === arg0)) {
      const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
      deciderCalls.push({ callNode: parentVar ?? callExpr, genFn: arg0 })
    }
  }

  for (const { callNode, genFn } of deciderCalls) {
    const params = (Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn)) ? genFn.getParameters() : []
    if (params.length < 2) continue
    const cmdParam = params[0]!, stateParam = params[1]!

    const collectIdProps = (param: ParameterDeclaration): Set<string> => {
      const parts = param.getType().isUnion() ? param.getType().getUnionTypes() : [param.getType()]
      const set = new Set<string>()
      const perPart = parts.map((part) => new Set(part.getProperties().map((p) => p.getName()).filter((n) => n.endsWith("Id") && n !== "commandId" && n !== "id"))).filter((s) => s.size > 0)
      if (perPart.length > 0) {
        for (const id of perPart[0]!) { if (perPart.every((s) => s.has(id))) set.add(id) }
      }
      if (set.size === 0) {
        const schemas = resolveSchemasForParameter(param, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)
          .filter((s) => s.properties.some((p) => p.endsWith("Id") && p !== "commandId" && p !== "id"))
        if (schemas.length > 0) {
          for (const p of schemas[0]!.properties.filter((x) => x.endsWith("Id") && x !== "commandId" && x !== "id")) {
            if (schemas.every((s) => s.properties.includes(p))) set.add(p)
          }
        }
      }
      return set
    }

    const cmdIdProps = collectIdProps(cmdParam), stateIdProps = collectIdProps(stateParam)
    const sharedIdProps = [...cmdIdProps].filter((id) => stateIdProps.has(id))
    if (sharedIdProps.length === 0) continue

    const bodyNode = (Node.isFunctionExpression(genFn) || Node.isArrowFunction(genFn)) ? genFn.getBody() : undefined
    if (!bodyNode) continue

    const bodyText = stripCommentsAndTestTitles(bodyNode.getText())

    for (const idProp of sharedIdProps) {
      const rx = new RegExp(`([a-zA-Z0-9_$]+)\\.${idProp}\\b`)
      const distinct = (a: string, b: string): boolean => {
        const mA = a.match(rx), mB = b.match(rx)
        return Boolean(mA && mB && mA[1] !== mB[1])
      }
      const testMatch = (r: RegExp) => { const m = bodyText.match(r); return Boolean(m && m[1] !== m[2]) }
      const hasIdComparison = bodyNode.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((bin) => {
        const op = bin.getOperatorToken().getKind()
        const isEq = op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsEqualsToken || op === SyntaxKind.EqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken
        return isEq && distinct(bin.getLeft().getText(), bin.getRight().getText())
      }) || bodyNode.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => {
        const t = c.getExpression().getText()
        return (t === "Equal.equals" || t.endsWith(".Equal.equals")) && c.getArguments().length >= 2 && distinct(c.getArguments()[0]!.getText(), c.getArguments()[1]!.getText())
      }) || testMatch(new RegExp(`\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*(?:===|!==|==|!=)\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`))
         || testMatch(new RegExp(`Equal\\.equals\\(\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*,\\s*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b\\s*\\)`))
         || testMatch(new RegExp(`(?:if|when)\\s*\\([^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b[^)]*\\b([a-zA-Z0-9_$]+)\\.${idProp}\\b`))

      if (!hasIdComparison) {
        const enclosingSymbol = findEnclosingSymbolName(callNode, relPath)
        addViolation(violations, "missing-aggregate-id-guard",
          `Decider '${enclosingSymbol}' accepts command and state that both carry aggregate identifier '${idProp}', but never verifies that command.${idProp} matches state.${idProp} on existing state variants.`,
          relPath, callNode.getStartLineNumber(), enclosingSymbol)
      }
    }
  }
}

export const checkEventSourcingReducers = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  taggedSchemasByTag: ReadonlyMap<string, TaggedSchemaInfo>,
  taggedSchemasByName: ReadonlyMap<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: ReadonlyMap<string, ReadonlyArray<string>>,
  violations: Array<BranchingViolation>,
): void => {
  if (filePkgTag !== "contract" && filePkgTag !== "domain") return

  const isReducerName = (name: string): boolean => {
    const baseName = name.includes("#") ? name.split("#")[1]! : name
    return /^(evolve\w*|reduce\w*|.*Reducer)$/i.test(baseName)
  }

  const TERMINAL_VARIANT_REGEX = /^(CheckedOut|Cancelled|Canceled|Archived|Completed|Closed|Finished|Terminated)$/i

  const candidateFunctions = [
    ...sourceFile.getFunctions(),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ]

  const processedSymbols = new Set<string>()

  for (const fnNode of candidateFunctions) {
    const enclosingSymbol = findEnclosingSymbolName(fnNode, relPath)
    if (!isReducerName(enclosingSymbol) || processedSymbols.has(enclosingSymbol)) continue

    const params = fnNode.getParameters()
    if (params.length < 2) continue
    processedSymbols.add(enclosingSymbol)
    const stateParam = params[0], eventParam = params[1]

    if (stateParam && eventParam) {
      const stateType = stateParam.getType()
      let terminalVariantName: string | null = null

      if (stateType.isUnion()) {
        for (const unionPart of stateType.getUnionTypes()) {
          const tagProp = unionPart.getProperty("_tag")
          if (tagProp) {
            const rawTag = tagProp.getTypeAtLocation(stateParam).getText().replace(/^["'`]|["'`]$/g, "")
            if (TERMINAL_VARIANT_REGEX.test(rawTag)) {
              terminalVariantName = rawTag
              break
            }
          } else {
            const matchTag = unionPart.getText().match(TERMINAL_VARIANT_REGEX)
            if (matchTag) {
              terminalVariantName = matchTag[0]
              break
            }
          }
        }
      }
      if (terminalVariantName === null) {
        for (const stSchema of resolveSchemasForParameter(stateParam, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)) {
          if (TERMINAL_VARIANT_REGEX.test(stSchema.tag)) {
            terminalVariantName = stSchema.tag
            break
          }
        }
      }

      if (terminalVariantName !== null) {
        const stateParamName = stateParam.getName()
        const findRootMatch = (node: Node): CallExpression | null => {
          let curr: Node = node
          while (Node.isCallExpression(curr)) {
            const callee = curr.getExpression()
            if (callee.getText() === "match") return curr
            if (Node.isPropertyAccessExpression(callee)) curr = callee.getExpression()
            else break
          }
          return null
        }

        for (const callExpr of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          if (callExpr.getExpression().getText() !== "match") continue
          const mText = callExpr.getArguments()[0]?.getText()
          if (mText === eventParam.getName() || mText === "event" || mText === "ev") {
            const hasEnclosing = callExpr.getAncestors().some((anc) => {
              const root = findRootMatch(anc)
              const a0 = root?.getArguments()[0]
              return a0 !== undefined && new RegExp(`\\b${stateParamName}\\b`).test(a0.getText())
            })
            if (!hasEnclosing) {
              addViolation(violations, "terminal-state-unhandled",
                `Reducer '${enclosingSymbol}' matches only on '${mText}' without checking for terminal state '${terminalVariantName}' — terminal states must be matched on 'state' to preserve terminality during event folding.`,
                relPath, callExpr.getStartLineNumber(), enclosingSymbol)
            }
          }
        }
      }
    }

    const stateTagSet = new Set<string>(), stateProps = new Set<string>()
    if (stateParam) {
      const stateType = stateParam.getType()
      const constituents = stateType.isUnion() ? stateType.getUnionTypes() : [stateType]
      for (const part of constituents) {
        const tagProp = part.getProperty("_tag")
        if (tagProp) {
          const rawTag = tagProp.getTypeAtLocation(stateParam).getText().replace(/^["'`]|["'`]$/g, "")
          if (rawTag && rawTag !== "string") stateTagSet.add(rawTag)
        }
        for (const p of part.getProperties()) stateProps.add(p.getName())
      }
      const resolvedStateSchemas = resolveSchemasForParameter(stateParam, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)
      for (const stSchema of resolvedStateSchemas) {
        stateTagSet.add(stSchema.tag)
        for (const p of stSchema.properties) stateProps.add(p)
      }
      if (resolvedStateSchemas.length === 0) {
        for (const stateTag of stateTagSet) {
          const stSchema = taggedSchemasByTag.get(stateTag)
          if (stSchema) {
            for (const p of stSchema.properties) stateProps.add(p)
          }
        }
      }
    }

    const eventTagSet = new Set<string>()
    const eventSchemasByTag = new Map<string, TaggedSchemaInfo>()
    const eventTypeText = eventParam ? eventParam.getType().getText() : ""
    if (eventParam) {
      const eventType = eventParam.getType()
      const constituents = eventType.isUnion() ? eventType.getUnionTypes() : [eventType]
      for (const part of constituents) {
        const tagProp = part.getProperty("_tag")
        if (tagProp) {
          const rawTag = tagProp.getTypeAtLocation(eventParam).getText().replace(/^["'`]|["'`]$/g, "")
          if (rawTag && rawTag !== "string") eventTagSet.add(rawTag)
        }
      }
      for (const evSchema of resolveSchemasForParameter(eventParam, taggedSchemasByTag, taggedSchemasByName, unionSchemaTagsByName)) {
        eventTagSet.add(evSchema.tag)
        eventSchemasByTag.set(evSchema.tag, evSchema)
      }
    }

    const isEventVariant = (tag: string): boolean => {
      if (eventTagSet.has(tag)) return true
      if (eventTypeText.includes(`"${tag}"`) || eventTypeText.includes(`'${tag}'`)) return true
      if (eventParam) {
        const typeNode = eventParam.getTypeNode()
        if (typeNode && new RegExp(`\\b${tag}\\b`).test(typeNode.getText())) return true
      }
      return eventTagSet.size === 0 && !stateTagSet.has(tag)
    }

    const handledTags = new Set<string>()
    const usedPropsPerTag = new Map<string, Set<string>>()

    for (const withCall of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = withCall.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "with") continue
      const args = withCall.getArguments()
      if (args.length < 2) continue
      const handler = args[args.length - 1]
      if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler))) continue

      const patternArgs = args.slice(0, args.length - 1)
      const matchedTagsInWith: Array<string> = []

      for (const patternArg of patternArgs) {
        for (const propAssign of patternArg.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
          if (propAssign.getName() === "_tag") {
            const init = propAssign.getInitializer()
            if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
              const tag = init.getLiteralText()
              if (stateTagSet.has(tag) && !eventTagSet.has(tag)) continue
              if (eventParam && eventTagSet.size > 0 && !isEventVariant(tag)) continue
              if (taggedSchemasByTag.has(tag)) {
                matchedTagsInWith.push(tag)
                handledTags.add(tag)
                if (!usedPropsPerTag.has(tag)) usedPropsPerTag.set(tag, new Set())
              }
            }
          }
        }
      }

      if (matchedTagsInWith.length === 0) continue

      const recordUsedProp = (prop: string) => {
        for (const tag of matchedTagsInWith) {
          const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
          if (schema && schema.properties.includes(prop)) usedPropsPerTag.get(tag)!.add(prop)
        }
      }
      for (const p of handler.getParameters()) for (const b of p.getDescendantsOfKind(SyntaxKind.BindingElement)) recordUsedProp(b.getName())
      for (const pa of handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) recordUsedProp(pa.getName())
      for (const id of handler.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const p = id.getParent()
        if (!p || !Node.isPropertyAssignment(p) || p.getNameNode() !== id) recordUsedProp(id.getText())
      }
    }

    for (const tag of handledTags) {
      if (stateTagSet.has(tag) && !eventTagSet.has(tag)) continue
      if (eventParam && eventTagSet.size > 0 && !isEventVariant(tag)) continue

      const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
      if (!schema || schema.properties.length === 0) continue

      const usedProps = usedPropsPerTag.get(tag) ?? new Set()
      for (const prop of schema.properties) {
        if (prop === "_tag" || prop === "version") continue
        if (prop.endsWith("Id") && stateProps.has(prop)) continue
        if (!usedProps.has(prop)) {
          addViolation(violations, "dead-event-payload",
            `Event schema '${tag}' defines property '${prop}', but property '${prop}' is never read or applied in reducer '${enclosingSymbol}'. Superfluous event fields waste storage and mislead consumers.`,
            relPath, fnNode.getStartLineNumber(), enclosingSymbol)
        }
      }
    }
  }
}
