import { ts } from "@harness/graph"
import { checkMigrationSqlSafety } from "../migration-check.js"

export const SQLITE_MIGRATOR_KEY_REGEX = /^[1-9]\d*_[a-z0-9_]+$/

export interface SqliteMigratorSourceInput {
  readonly filePath: string
  readonly content: string
}

export interface SqliteMigratorKeyIssue {
  readonly filePath: string
  readonly line: number
  readonly key: string
  readonly message: string
}

export interface SqliteMigratorUnsafeSqlIssue {
  readonly filePath: string
  readonly line: number
  readonly key: string
  readonly kind: string
  readonly message: string
}

export interface SqliteMigratorAstAnalysis {
  readonly fromRecordCallCount: number
  readonly checkedKeyCount: number
  readonly keyIssues: ReadonlyArray<SqliteMigratorKeyIssue>
  readonly unsafeSqlIssues: ReadonlyArray<SqliteMigratorUnsafeSqlIssue>
}

const getLine = (sourceFile: ts.SourceFile, pos: number): number =>
  sourceFile.getLineAndCharacterOfPosition(Math.max(0, pos)).line + 1

const unwrapExpr = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isSatisfiesExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

const isMigratorModuleSpec = (spec: string): boolean =>
  spec.includes("SqliteMigrator") ||
  spec === "@effect/sql-sqlite-do" ||
  spec === "@effect/sql/Migrator" ||
  spec === "effect/unstable/sql/Migrator"

const isDirectMigratorModuleSpec = (spec: string): boolean =>
  spec.includes("SqliteMigrator") ||
  spec === "@effect/sql/Migrator" ||
  spec === "effect/unstable/sql/Migrator"

const collectMigratorAliases = (sourceFile: ts.SourceFile): {
  readonly sqliteMigratorAliases: ReadonlySet<string>
  readonly fromRecordAliases: ReadonlySet<string>
  readonly sqlDoNamespaceAliases: ReadonlySet<string>
} => {
  const sqliteMigratorAliases = new Set<string>(["SqliteMigrator"])
  const fromRecordAliases = new Set<string>()
  const sqlDoNamespaceAliases = new Set<string>()

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!isMigratorModuleSpec(spec)) continue

    const clause = stmt.importClause
    if (clause === undefined) continue
    if (clause.name !== undefined && isDirectMigratorModuleSpec(spec)) {
      sqliteMigratorAliases.add(clause.name.text)
    }
    const bindings = clause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      if (isDirectMigratorModuleSpec(spec)) {
        sqliteMigratorAliases.add(bindings.name.text)
      }
      if (!isDirectMigratorModuleSpec(spec) && spec === "@effect/sql-sqlite-do") {
        sqlDoNamespaceAliases.add(bindings.name.text)
      }
    }
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue
        const importedName = (el.propertyName ?? el.name).text
        if (importedName === "SqliteMigrator") {
          sqliteMigratorAliases.add(el.name.text)
        }
        if (importedName === "fromRecord" && isDirectMigratorModuleSpec(spec)) {
          fromRecordAliases.add(el.name.text)
        }
      }
    }
  }

  return { sqliteMigratorAliases, fromRecordAliases, sqlDoNamespaceAliases }
}

const collectLocalObjectLiterals = (
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.ObjectLiteralExpression> => {
  const map = new Map<string, ts.ObjectLiteralExpression>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const unwrapped = unwrapExpr(node.initializer)
      if (ts.isObjectLiteralExpression(unwrapped)) {
        map.set(node.name.text, unwrapped)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return map
}

const getMemberAccessName = (
  node: ts.Expression,
): { readonly receiver: ts.Expression; readonly name: string } | undefined => {
  if (ts.isPropertyAccessExpression(node)) {
    return { receiver: unwrapExpr(node.expression), name: node.name.text }
  }
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrapExpr(node.argumentExpression)
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return { receiver: unwrapExpr(node.expression), name: arg.text }
    }
  }
  return undefined
}

const isSqliteMigratorFromRecordCall = (
  node: ts.CallExpression,
  sqliteMigratorAliases: ReadonlySet<string>,
  fromRecordAliases: ReadonlySet<string>,
  sqlDoNamespaceAliases: ReadonlySet<string>,
): boolean => {
  const callee = unwrapExpr(node.expression)
  if (ts.isIdentifier(callee)) {
    return fromRecordAliases.has(callee.text)
  }
  const outer = getMemberAccessName(callee)
  if (outer === undefined || outer.name !== "fromRecord") {
    return false
  }
  if (ts.isIdentifier(outer.receiver) && sqliteMigratorAliases.has(outer.receiver.text)) {
    return true
  }
  const inner = getMemberAccessName(outer.receiver)
  return (
    inner !== undefined &&
    inner.name === "SqliteMigrator" &&
    ts.isIdentifier(inner.receiver) &&
    sqlDoNamespaceAliases.has(inner.receiver.text)
  )
}

const isEnclosingParameter = (callNode: ts.CallExpression, identName: string): boolean => {
  let cur: ts.Node | undefined = callNode.parent
  while (cur !== undefined) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      if (cur.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === identName)) {
        return true
      }
    }
    cur = cur.parent
  }
  return false
}

const extractPropertyKey = (
  prop: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile,
): { readonly key: string; readonly isStatic: boolean } => {
  if (ts.isSpreadAssignment(prop)) {
    return { key: prop.getText(sourceFile), isStatic: false }
  }
  const name = prop.name
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return { key: name.text, isStatic: true }
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpr(name.expression)
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
      return { key: inner.text, isStatic: true }
    }
    return { key: name.getText(sourceFile), isStatic: false }
  }
  return { key: prop.getText(sourceFile), isStatic: false }
}

const collectSqlStringLiterals = (
  root: ts.Node,
  sourceFile: ts.SourceFile,
): ReadonlyArray<{ readonly sql: string; readonly line: number }> => {
  const literals: Array<{ readonly sql: string; readonly line: number }> = []
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push({ sql: node.text, line: getLine(sourceFile, node.getStart(sourceFile)) })
      return
    }
    if (ts.isTemplateExpression(node)) {
      const combined = `${node.head.text}${node.templateSpans.map((s) => ` ${s.literal.text}`).join("")}`
      literals.push({ sql: combined, line: getLine(sourceFile, node.getStart(sourceFile)) })
    }
    ts.forEachChild(node, walk)
  }
  walk(root)
  return literals
}

const resolveFromRecordObjectArg = (
  arg: ts.Expression,
  localObjects: ReadonlyMap<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | undefined => {
  const unwrapped = unwrapExpr(arg)
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped
  }
  if (ts.isIdentifier(unwrapped)) {
    return localObjects.get(unwrapped.text)
  }
  return undefined
}

export const analyzeSqliteMigratorFromRecordAst = (
  input: SqliteMigratorSourceInput,
): SqliteMigratorAstAnalysis => {
  const sourceFile = ts.createSourceFile(
    input.filePath,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    input.filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const { sqliteMigratorAliases, fromRecordAliases, sqlDoNamespaceAliases } =
    collectMigratorAliases(sourceFile)
  const localObjects = collectLocalObjectLiterals(sourceFile)

  let fromRecordCallCount = 0
  let checkedKeyCount = 0
  const keyIssues: Array<SqliteMigratorKeyIssue> = []
  const unsafeSqlIssues: Array<SqliteMigratorUnsafeSqlIssue> = []

  const inspectFromRecordCall = (node: ts.CallExpression): void => {
    fromRecordCallCount += 1
    const callLine = getLine(sourceFile, node.getStart(sourceFile))
    const firstArg = node.arguments[0]
    if (firstArg === undefined) {
      keyIssues.push({
        filePath: input.filePath,
        line: callLine,
        key: "<missing>",
        message: `SqliteMigrator.fromRecord() in '${input.filePath}' is missing its migration record argument (invalid-migrator-record-key).`,
      })
      return
    }
    const obj = resolveFromRecordObjectArg(firstArg, localObjects)
    if (obj === undefined) {
      keyIssues.push({
        filePath: input.filePath,
        line: callLine,
        key: firstArg.getText(sourceFile),
        message: `SqliteMigrator.fromRecord(${firstArg.getText(sourceFile)}) in '${input.filePath}' uses a non-static or unresolvable record argument (invalid-migrator-record-key) — pass an object literal with '<positive_int>_<snake_case>' keys.`,
      })
      return
    }
    if (obj.properties.length === 0) {
      keyIssues.push({
        filePath: input.filePath,
        line: getLine(sourceFile, obj.getStart(sourceFile)),
        key: "{}",
        message: `SqliteMigrator.fromRecord({}) in '${input.filePath}' has an empty migration record (invalid-migrator-record-key) — define at least one '<positive_int>_<snake_case>' migration.`,
      })
      return
    }
    const unresolvedSpreads: Array<{
      readonly line: number
      readonly identName: string
      readonly isParam: boolean
    }> = []

    const flattenObjectProperties = (
      targetObj: ts.ObjectLiteralExpression,
      visited: Set<ts.ObjectLiteralExpression>,
    ): ReadonlyArray<ts.ObjectLiteralElementLike> => {
      if (visited.has(targetObj)) return []
      visited.add(targetObj)
      const props: Array<ts.ObjectLiteralElementLike> = []
      for (const prop of targetObj.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const spreadTarget = resolveFromRecordObjectArg(prop.expression, localObjects)
          if (spreadTarget !== undefined) {
            props.push(...flattenObjectProperties(spreadTarget, visited))
            continue
          }
          const spreadExpr = unwrapExpr(prop.expression)
          const identName = ts.isIdentifier(spreadExpr)
            ? spreadExpr.text
            : spreadExpr.getText(sourceFile)
          const isParam = ts.isIdentifier(spreadExpr) && isEnclosingParameter(node, identName)
          unresolvedSpreads.push({
            line: getLine(sourceFile, prop.getStart(sourceFile)),
            identName,
            isParam,
          })
          continue
        }
        props.push(prop)
      }
      return props
    }

    const resolvedProps = flattenObjectProperties(obj, new Set())
    let staticResolvedCount = 0
    const seenPrefixes = new Map<number, string>()
    const validPrefixes: Array<{ readonly prefix: number; readonly key: string; readonly line: number }> = []

    for (const prop of resolvedProps) {
      const propLine = getLine(sourceFile, prop.getStart(sourceFile))
      const { key, isStatic } = extractPropertyKey(prop, sourceFile)
      if (isStatic) {
        staticResolvedCount += 1
      }
      checkedKeyCount += 1
      if (!isStatic || !SQLITE_MIGRATOR_KEY_REGEX.test(key)) {
        keyIssues.push({
          filePath: input.filePath,
          line: propLine,
          key,
          message: `Invalid SqliteMigrator.fromRecord migration key "${key}" in '${input.filePath}' (invalid-migrator-record-key) — keys must match '<positive_int>_<lowercase_snake_case>' (e.g. '1_init_tables').`,
        })
      } else {
        const prefix = Number(key.slice(0, key.indexOf("_")))
        const prevKey = seenPrefixes.get(prefix)
        if (prevKey !== undefined) {
          keyIssues.push({
            filePath: input.filePath,
            line: propLine,
            key,
            message: `Duplicate migration version prefix '${prefix}_' in SqliteMigrator.fromRecord(...) in '${input.filePath}' (key '${key}', previously '${prevKey}') (invalid-migrator-record-key).`,
          })
        } else {
          seenPrefixes.set(prefix, key)
          validPrefixes.push({ prefix, key, line: propLine })
        }
      }
      const sqlLiterals = collectSqlStringLiterals(prop, sourceFile)
      for (const lit of sqlLiterals) {
        const safety = checkMigrationSqlSafety([
          { file: `${input.filePath}#${key}`, sql: lit.sql },
        ])
        for (const v of safety.violations) {
          unsafeSqlIssues.push({
            filePath: input.filePath,
            line: lit.line,
            key,
            kind: v.kind,
            message: v.message,
          })
        }
      }
    }

    for (const spread of unresolvedSpreads) {
      if (spread.isParam && staticResolvedCount > 0) {
        continue
      }
      checkedKeyCount += 1
      keyIssues.push({
        filePath: input.filePath,
        line: spread.line,
        key: `...${spread.identName}`,
        message: `Unresolved spread '...${spread.identName}' in SqliteMigrator.fromRecord(...) in '${input.filePath}' (invalid-migrator-record-key) — define migration record keys locally as '<positive_int>_<lowercase_snake_case>' properties.`,
      })
    }

    if (validPrefixes.length > 0) {
      const sortedPrefixes = [...validPrefixes].sort((a, b) => a.prefix - b.prefix)
      const first = sortedPrefixes[0]!
      if (first.prefix !== 1) {
        keyIssues.push({
          filePath: input.filePath,
          line: first.line,
          key: first.key,
          message: `Non-contiguous migration version sequence in SqliteMigrator.fromRecord(...) in '${input.filePath}' — expected sequential prefixes starting at 1_ (got '${first.key}') (invalid-migrator-record-key).`,
        })
      } else {
        for (let i = 1; i < sortedPrefixes.length; i += 1) {
          const prev = sortedPrefixes[i - 1]!
          const curr = sortedPrefixes[i]!
          if (curr.prefix !== prev.prefix + 1) {
            keyIssues.push({
              filePath: input.filePath,
              line: curr.line,
              key: curr.key,
              message: `Non-contiguous migration version sequence in SqliteMigrator.fromRecord(...) in '${input.filePath}' — expected sequential prefixes starting at 1_ (jumped from '${prev.prefix}_' to '${curr.prefix}_') (invalid-migrator-record-key).`,
            })
            break
          }
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isSqliteMigratorFromRecordCall(node, sqliteMigratorAliases, fromRecordAliases, sqlDoNamespaceAliases)
    ) {
      inspectFromRecordCall(node)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return {
    fromRecordCallCount,
    checkedKeyCount,
    keyIssues,
    unsafeSqlIssues,
  }
}
