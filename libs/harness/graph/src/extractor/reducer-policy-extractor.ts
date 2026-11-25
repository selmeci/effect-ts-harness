import { type CallExpression, Node, type SourceFile, SyntaxKind } from "ts-morph"
import type { BranchingViolation, PackageTag } from "../model.js"
import { resolveSchemasForParameter } from "./decider-reducer-extractor.js"
import {
  addViolation,
  findEnclosingSymbolName,
  isContractOrDomainTag,
  type TaggedSchemaInfo,
} from "./extractor-types-and-helpers.js"

export const checkEventSourcingReducers = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  taggedSchemasByTag: ReadonlyMap<string, TaggedSchemaInfo>,
  taggedSchemasByName: ReadonlyMap<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: ReadonlyMap<string, ReadonlyArray<string>>,
  violations: Array<BranchingViolation>,
): void => {
  if (!isContractOrDomainTag(filePkgTag)) return

  const isReducerName = (name: string): boolean => {
    const baseName = name.includes("#") ? name.split("#")[1]! : name
    return /^(evolve\w*|reduce\w*|.*Reducer)$/i.test(baseName)
  }

  const TERMINAL_VARIANT_REGEX =
    /^(CheckedOut|Cancelled|Canceled|Archived|Completed|Closed|Finished|Terminated)$/i

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
    const stateParam = params[0],
      eventParam = params[1]

    if (stateParam && eventParam) {
      const stateType = stateParam.getType()
      let terminalVariantName: string | null = null

      if (stateType.isUnion()) {
        for (const unionPart of stateType.getUnionTypes()) {
          const tagProp = unionPart.getProperty("_tag")
          if (tagProp) {
            const rawTag = tagProp
              .getTypeAtLocation(stateParam)
              .getText()
              .replace(/^["'`]|["'`]$/g, "")
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
        for (const stSchema of resolveSchemasForParameter(
          stateParam,
          taggedSchemasByTag,
          taggedSchemasByName,
          unionSchemaTagsByName,
        )) {
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
              addViolation(
                violations,
                "terminal-state-unhandled",
                `Reducer '${enclosingSymbol}' matches only on '${mText}' without checking for terminal state '${terminalVariantName}' — terminal states must be matched on 'state' to preserve terminality during event folding.`,
                relPath,
                callExpr.getStartLineNumber(),
                enclosingSymbol,
              )
            }
          }
        }
      }
    }

    const stateTagSet = new Set<string>(),
      stateProps = new Set<string>()
    if (stateParam) {
      const stateType = stateParam.getType()
      const constituents = stateType.isUnion() ? stateType.getUnionTypes() : [stateType]
      for (const part of constituents) {
        const tagProp = part.getProperty("_tag")
        if (tagProp) {
          const rawTag = tagProp
            .getTypeAtLocation(stateParam)
            .getText()
            .replace(/^["'`]|["'`]$/g, "")
          if (rawTag && rawTag !== "string") stateTagSet.add(rawTag)
        }
        for (const p of part.getProperties()) stateProps.add(p.getName())
      }
      const resolvedStateSchemas = resolveSchemasForParameter(
        stateParam,
        taggedSchemasByTag,
        taggedSchemasByName,
        unionSchemaTagsByName,
      )
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
    if (eventParam) {
      const eventType = eventParam.getType()
      const constituents = eventType.isUnion() ? eventType.getUnionTypes() : [eventType]
      for (const part of constituents) {
        const tagProp = part.getProperty("_tag")
        if (tagProp) {
          const rawTag = tagProp
            .getTypeAtLocation(eventParam)
            .getText()
            .replace(/^["'`]|["'`]$/g, "")
          if (rawTag && rawTag !== "string") eventTagSet.add(rawTag)
        }
      }
      for (const evSchema of resolveSchemasForParameter(
        eventParam,
        taggedSchemasByTag,
        taggedSchemasByName,
        unionSchemaTagsByName,
      )) {
        eventTagSet.add(evSchema.tag)
        eventSchemasByTag.set(evSchema.tag, evSchema)
      }
    }

    const handledTags = new Set<string>()
    const usedPropsPerTag = new Map<string, Set<string>>()

    for (const withCall of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = withCall.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "with") continue
      const args = withCall.getArguments()
      if (args.length < 2) continue
      const handler = args[args.length - 1]
      if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)))
        continue

      const patternArgs = args.slice(0, args.length - 1)
      const matchedTagsInWith: Array<string> = []

      for (const patternArg of patternArgs) {
        for (const propAssign of patternArg.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
          if (propAssign.getName() === "_tag") {
            const init = propAssign.getInitializer()
            if (
              init &&
              (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))
            ) {
              const tag = init.getLiteralText()
              if (stateTagSet.has(tag) && !eventTagSet.has(tag)) continue
              if (eventParam && eventTagSet.size > 0 && !eventTagSet.has(tag)) continue
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
      for (const p of handler.getParameters())
        for (const b of p.getDescendantsOfKind(SyntaxKind.BindingElement))
          recordUsedProp(b.getName())
      for (const pa of handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression))
        recordUsedProp(pa.getName())
      for (const id of handler.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const p = id.getParent()
        if (!p || !Node.isPropertyAssignment(p) || p.getNameNode() !== id)
          recordUsedProp(id.getText())
      }
    }

    for (const tag of handledTags) {
      const schema = eventSchemasByTag.get(tag) ?? taggedSchemasByTag.get(tag)
      if (!schema || schema.properties.length === 0) continue

      const usedProps = usedPropsPerTag.get(tag) ?? new Set()
      for (const prop of schema.properties) {
        if (prop === "_tag" || prop === "version") continue
        if (prop.endsWith("Id") && stateProps.has(prop)) continue
        if (!usedProps.has(prop)) {
          addViolation(
            violations,
            "dead-event-payload",
            `Event schema '${tag}' defines property '${prop}', but property '${prop}' is never read or applied in reducer '${enclosingSymbol}'. Superfluous event fields waste storage and mislead consumers.`,
            relPath,
            fnNode.getStartLineNumber(),
            enclosingSymbol,
          )
        }
      }
    }
  }
}
