import { match } from "ts-pattern"
import { Node, type SourceFile, SyntaxKind } from "ts-morph"
import { type BranchingViolation, type PackageTag, type SchemaDefNode } from "../model.js"
import {
  type TaggedSchemaInfo,
  addViolation,
  findEnclosingSymbolName,
  isContractOrDomainTag,
} from "./extractor-types-and-helpers.js"

const LIFECYCLE_FLAG_REGEX =
  /^(is[A-Z]\w*|has[A-Z]\w*|checkedOut|created|completed|cancelled|canceled|deleted|archived|active|closed|opened|approved|rejected|verified|publish|published|expired)$/

const getObjectPropNames = (obj: Node | undefined): ReadonlyArray<string> =>
  obj && Node.isObjectLiteralExpression(obj)
    ? obj
        .getProperties()
        .filter(Node.isPropertyAssignment)
        .map((p) => p.getName())
        .filter((n) => n !== "_tag" && n !== "version")
    : []

export const extractSchemaDefinitions = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  schemas: Array<SchemaDefNode>,
  taggedSchemasByTag: Map<string, TaggedSchemaInfo>,
  taggedSchemasByName: Map<string, TaggedSchemaInfo>,
  unionSchemaTagsByName: Map<string, ReadonlyArray<string>>,
): void => {
  const registerTaggedSchemaByTag = (tag: string, schemaInfo: TaggedSchemaInfo): void => {
    const existing = taggedSchemasByTag.get(tag)
    if (existing === undefined) {
      taggedSchemasByTag.set(tag, schemaInfo)
    } else {
      const merged = Array.from(new Set([...existing.properties, ...schemaInfo.properties]))
      taggedSchemasByTag.set(tag, { ...schemaInfo, properties: merged })
    }
  }

  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue
    const extClause = cls.getExtends()
    if (!extClause) continue
    const extText = extClause.getText()

    if (extText.includes("TaggedClass")) {
      for (const c of extClause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const args = c.getArguments()
        if (
          args.length >= 2 &&
          Node.isStringLiteral(args[0]) &&
          Node.isObjectLiteralExpression(args[1])
        ) {
          const tag = args[0].getLiteralText()
          const schemaInfo: TaggedSchemaInfo = {
            tag,
            properties: getObjectPropNames(args[1]),
            file: relPath,
            line: c.getStartLineNumber(),
          }
          registerTaggedSchemaByTag(tag, schemaInfo)
          const clsName = cls.getName()
          if (clsName) {
            taggedSchemasByName.set(clsName, schemaInfo)
            unionSchemaTagsByName.set(clsName, [tag])
          }
          break
        }
      }
    }

    if (
      extText.includes("Schema.Class") ||
      extText.includes("Schema.TaggedClass") ||
      extText.includes("TaggedClass") ||
      extText.includes("Class<")
    ) {
      const clsName = cls.getName() ?? ""
      if (clsName && !schemas.some((s) => s.schemaName === clsName)) {
        schemas.push({
          _tag: "SchemaDef",
          schemaName: clsName,
          packageTag: filePkgTag,
          file: relPath,
          line: cls.getStartLineNumber(),
          isBranded: false,
          name: clsName,
          qualname: `${relPath}#${clsName}`,
        })
      }
    }
  }

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeText = callExpr.getExpression().getText()
    match(calleeText)
      .with("Schema.TaggedStruct", "S.TaggedStruct", () => {
        const args = callExpr.getArguments()
        if (
          args.length >= 2 &&
          Node.isStringLiteral(args[0]) &&
          Node.isObjectLiteralExpression(args[1])
        ) {
          const tag = args[0].getLiteralText()
          const schemaInfo: TaggedSchemaInfo = {
            tag,
            properties: getObjectPropNames(args[1]),
            file: relPath,
            line: callExpr.getStartLineNumber(),
          }
          registerTaggedSchemaByTag(tag, schemaInfo)
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar) {
            taggedSchemasByName.set(parentVar.getName(), schemaInfo)
            unionSchemaTagsByName.set(parentVar.getName(), [tag])
          }
        }
      })
      .with("Schema.TaggedUnion", "S.TaggedUnion", () => {
        const args = callExpr.getArguments()
        if (args.length >= 1 && Node.isObjectLiteralExpression(args[0])) {
          const memberTags: Array<string> = []
          for (const prop of args[0].getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              const tag = prop.getName().replace(/^["'`]|["'`]$/g, "")
              registerTaggedSchemaByTag(tag, {
                tag,
                properties: getObjectPropNames(prop.getInitializer()),
                file: relPath,
                line: prop.getStartLineNumber(),
              })
              memberTags.push(tag)
            }
          }
          const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
          if (parentVar && memberTags.length > 0)
            unionSchemaTagsByName.set(parentVar.getName(), memberTags)
        }
      })
      .with("Schema.Union", "S.Union", () => {
        const parentVar = callExpr.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
        if (parentVar && parentVar.getInitializer() === callExpr) {
          const memberNames: Array<string> = []
          for (const arg of callExpr.getArguments()) {
            if (Node.isArrayLiteralExpression(arg)) {
              for (const el of arg.getElements()) {
                if (Node.isIdentifier(el)) memberNames.push(el.getText())
              }
              continue
            }
            if (Node.isIdentifier(arg)) memberNames.push(arg.getText())
          }
          if (memberNames.length > 0) unionSchemaTagsByName.set(parentVar.getName(), memberNames)
        }
      })
      .otherwise(() => {})
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const aliasName = typeAlias.getName()
    if (unionSchemaTagsByName.has(aliasName)) continue
    const typeNode = typeAlias.getTypeNode()
    if (!typeNode) continue
    if (Node.isUnionTypeNode(typeNode)) {
      const members: Array<string> = []
      for (const part of typeNode.getTypeNodes()) {
        const text = part.getText().trim()
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) members.push(text)
      }
      if (members.length > 0) unionSchemaTagsByName.set(aliasName, members)
      continue
    }
    const text = typeNode.getText().trim()
    const matchTypeof = text.match(/^typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\.Type$/)
    const targetIdent =
      matchTypeof?.[1] ?? (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined)
    if (targetIdent && targetIdent !== aliasName)
      unionSchemaTagsByName.set(aliasName, [targetIdent])
  }

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    if (!varDecl.isExported()) continue
    const varName = varDecl.getName(),
      init = varDecl.getInitializer()
    if (!init) continue
    const initText = init.getText()
    const isSchemaDef =
      initText.includes("Schema.Struct") ||
      initText.includes("Schema.TaggedStruct") ||
      initText.includes("Schema.TaggedUnion") ||
      initText.includes("Schema.Union") ||
      initText.includes("Schema.Class") ||
      initText.includes("Schema.brand(") ||
      initText.includes(".pipe(Schema.brand") ||
      initText.includes("S.Struct") ||
      initText.includes("S.TaggedStruct") ||
      initText.includes("S.TaggedUnion") ||
      initText.includes("S.brand(")

    if (isSchemaDef && !schemas.some((s) => s.schemaName === varName)) {
      schemas.push({
        _tag: "SchemaDef",
        schemaName: varName,
        packageTag: filePkgTag,
        file: relPath,
        line: varDecl.getStartLineNumber(),
        isBranded: initText.includes("brand(") || initText.includes("Schema.brand"),
        name: varName,
        qualname: `${relPath}#${varName}`,
      })
    }
  }
}

export const checkSchemaBooleanStateAndBrandedFields = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  violations: Array<BranchingViolation>,
): void => {
  if (!isContractOrDomainTag(filePkgTag)) return

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = callExpr.getExpression(),
      calleeText = callee.getText()
    const isStruct = Node.isPropertyAccessExpression(callee) && callee.getName() === "Struct"
    const isTaggedStruct =
      Node.isPropertyAccessExpression(callee) && callee.getName() === "TaggedStruct"
    const isTaggedClass = calleeText.includes("TaggedClass")
    if (!isStruct && !isTaggedStruct && !isTaggedClass) continue

    const args = callExpr.getArguments()
    const objLit: Node | undefined =
      isStruct && args.length >= 1 && Node.isObjectLiteralExpression(args[0])
        ? args[0]
        : (isTaggedStruct || isTaggedClass) &&
            args.length >= 2 &&
            Node.isObjectLiteralExpression(args[1])
          ? args[1]
          : undefined
    if (!objLit || !Node.isObjectLiteralExpression(objLit)) continue

    const propAssignments: Array<{ name: string; node: Node; init: Node }> = []
    const propMap = new Map<string, { node: Node; init: Node }>()
    for (const p of objLit.getProperties()) {
      if (Node.isPropertyAssignment(p)) {
        const pName = p.getName(),
          pInit = p.getInitializer()
        if (pInit) {
          const entry = { name: pName, node: p, init: pInit }
          propAssignments.push(entry)
          propMap.set(pName, entry)
        }
      }
    }

    const isBooleanSchema = (node: Node): boolean => {
      const text = node.getText().replace(/\s+/g, "")
      if (text === "Schema.Boolean" || text === "S.Boolean") return true
      if (!Node.isCallExpression(node)) return false
      const cText = node.getExpression().getText().replace(/\s+/g, "")
      const isOpt =
        cText === "Schema.optional" ||
        cText === "S.optional" ||
        cText === "Schema.optionalWith" ||
        cText === "S.optionalWith"
      const firstArg = node.getArguments()[0]
      return isOpt && firstArg !== undefined ? isBooleanSchema(firstArg) : false
    }

    for (const { name, node, init } of propAssignments) {
      if (isBooleanSchema(init)) {
        const hasCompanion = [
          `${name}At`,
          `${name}By`,
          ...(name.startsWith("is") && name.length > 2
            ? [
                `${name[2]!.toLowerCase()}${name.slice(3)}At`,
                `${name[2]!.toLowerCase()}${name.slice(3)}By`,
              ]
            : []),
          ...(name.startsWith("has") && name.length > 3
            ? [
                `${name[3]!.toLowerCase()}${name.slice(4)}At`,
                `${name[3]!.toLowerCase()}${name.slice(4)}By`,
              ]
            : []),
        ].some((c) => {
          const comp = propMap.get(c)
          const text = comp ? comp.init.getText() : ""
          return text.includes("NullOr") || text.includes("Option")
        })

        if (LIFECYCLE_FLAG_REGEX.test(name) || hasCompanion) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          addViolation(
            violations,
            "schema-boolean-state",
            `Property '${name}' in '${enclosingSymbol}' uses boolean flag for lifecycle state in Schema.Struct — mutually exclusive lifecycle states must be modeled as a closed union (Schema.TaggedUnion / Schema.TaggedStruct) instead of boolean flags.`,
            relPath,
            node.getStartLineNumber(),
            enclosingSymbol,
          )
        }
      }

      if (/^(quantity|streamVersion|expectedVersion)$/.test(name)) {
        const initClean = init.getText().replace(/\s+/g, "")
        const startsWithUnbrandedNum =
          initClean.startsWith("Schema.Int") ||
          initClean.startsWith("S.Int") ||
          initClean.startsWith("Schema.Number") ||
          initClean.startsWith("S.Number") ||
          initClean.startsWith("Schema.Natural") ||
          initClean.startsWith("S.Natural")
        if (startsWithUnbrandedNum && !initClean.includes("brand(")) {
          const enclosingSymbol = findEnclosingSymbolName(node, relPath)
          addViolation(
            violations,
            "unbranded-schema-field",
            `Property '${name}' in '${enclosingSymbol}' uses unbranded '${init.getText()}' — domain quantity and version fields must use a branded contract schema (e.g. PositiveInt, StreamVersion, or .pipe(Schema.brand(...))) so invalid raw numbers cannot be passed at compile time.`,
            relPath,
            node.getStartLineNumber(),
            enclosingSymbol,
          )
        }
      }
    }
  }

  for (const iface of sourceFile.getInterfaces()) {
    if (!iface.isExported()) continue
    for (const prop of iface.getProperties()) {
      const propName = prop.getName(),
        typeNodeText = prop.getTypeNode()?.getText() ?? ""
      if (/\bboolean\b/.test(typeNodeText) && LIFECYCLE_FLAG_REGEX.test(propName)) {
        addViolation(
          violations,
          "schema-boolean-state",
          `Interface property '${propName}' on '${iface.getName()}' in '${relPath}' uses a boolean flag ('${typeNodeText}') — model configuration and lifecycle modes with a closed discriminated union (Schema.TaggedStruct / Schema.Union) instead of boolean flags.`,
          relPath,
          prop.getStartLineNumber(),
          `${relPath}#${iface.getName()}`,
        )
      }
    }
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const typeNode = typeAlias.getTypeNode()
    if (typeNode && Node.isUnionTypeNode(typeNode)) {
      let tagMemberCount = 0
      for (const member of typeNode.getTypeNodes()) {
        if (
          Node.isTypeLiteral(member) &&
          member.getProperties().some((p) => p.getName() === "_tag")
        )
          tagMemberCount++
      }
      if (tagMemberCount >= 2) {
        addViolation(
          violations,
          "handwritten-tagged-union",
          `Type alias '${typeAlias.getName()}' in '${relPath}' is a handwritten TypeScript union of '_tag' object literals — model domain states, commands, and events with Schema.Union / Schema.TaggedStruct / Schema.TaggedUnion and derive the type via 'typeof ${typeAlias.getName()}.Type'.`,
          relPath,
          typeAlias.getStartLineNumber(),
          `${relPath}#${typeAlias.getName()}`,
        )
      }
    }
  }
}

export { checkBrandedDomainTypesAndPrimitiveBoundaries } from "./brand-boundary-extractor.js"
