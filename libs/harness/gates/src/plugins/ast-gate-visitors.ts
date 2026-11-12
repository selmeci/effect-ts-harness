/**
 * @file ast-gate-visitors.ts
 * Single-pass AST visitor and leaf gate schema definitions for Effect-TS Engineering Harness.
 *
 * Traverses TypeScript ASTs once to enforce architectural invariants across 5 gate categories:
 * 1. syntax-bans:
 *    - node-sqlite-in-infra: Bans node:sqlite, sqlite, better-sqlite3 in infra/app code
 *    - discriminant-branching: Bans switch statements (use ts-pattern match(...).exhaustive())
 *    - unsafe-type-cast: Bans 'as any', 'as never', and double assertions 'as unknown as T'
 *    - ast-grep-tsx-grammar: Bans hardcoded Lang.TypeScript parser on .tsx files
 * 2. test-integrity:
 *    - node-sqlite-in-infra: Bans node:sqlite mocks in test files
 *    - vacuous-error-assertion: Bans unverified Exit.isFailure checks lacking cause inspection
 *    - fallback-json-equality: Bans JSON.stringify equality comparisons in tests
 * 3. migration-safety:
 *    - unmanaged-sql-ddl: Bans raw SQL DDL outside SqliteMigrator.fromRecord in infra
 *    - unsafe-sql-migration: Flags destructive SQL statements (DROP, table rebuilds, un-defaulted NOT NULL)
 * 4. domain-purity:
 *    - impure-domain-import: Bans node I/O, Drizzle, SQL, and Alchemy imports in domain/contract packages
 *    - domain-effect-ignore: Bans Effect.ignore in domain logic swallowing typed errors
 *    - unscoped-effect-run: Bans Effect.runSync/runPromise/runFork outside app edge runtime
 * 5. effect-laws:
 *    - effect-fn-dummy-void: Bans dummy 'yield* Effect.void' in generator functions
 *    - discriminant-branching: Bans if/ternary discriminant or Option/Either/Exit/Result guard inspection
 *    - non-exhaustive-union-match: Bans match(...).run() in favor of .exhaustive()
 */

import { Schema } from "effect"
import { ts } from "@harness/graph"
import { checkMigrationSqlSafety } from "../migration-check.js"

export const GateRuleVersion = Schema.NonEmptyString.pipe(Schema.brand("GateRuleVersion"))
export type GateRuleVersion = typeof GateRuleVersion.Type
export const AstRuleVersion = GateRuleVersion
export type AstRuleVersion = typeof AstRuleVersion.Type
export const HARNESS_GATE_RULE_VERSION: GateRuleVersion = GateRuleVersion.make("ast-gates-v2")

export const AstSourceFilePath = Schema.NonEmptyString.pipe(Schema.brand("AstSourceFilePath"))
export type AstSourceFilePath = typeof AstSourceFilePath.Type

export const ContentSha256 = Schema.NonEmptyString.pipe(Schema.brand("ContentSha256"))
export type ContentSha256 = typeof ContentSha256.Type
export const AstContentSha256 = ContentSha256
export type AstContentSha256 = typeof AstContentSha256.Type

export const AstSourceContent = Schema.String.pipe(Schema.brand("AstSourceContent"))
export type AstSourceContent = typeof AstSourceContent.Type

export const GateCategory = Schema.Literals([
  "syntax-bans", "test-integrity", "migration-safety", "domain-purity", "effect-laws",
]).pipe(Schema.brand("GateCategory"))
export type GateCategory = typeof GateCategory.Type
export const AstGateCategory = GateCategory
export type AstGateCategory = typeof AstGateCategory.Type
export const GateViolationCategory = GateCategory
export type GateViolationCategory = typeof GateViolationCategory.Type

export const GateRuleId = Schema.NonEmptyString.pipe(Schema.brand("GateRuleId"))
export type GateRuleId = typeof GateRuleId.Type

export const GateViolationMessage = Schema.NonEmptyString.pipe(Schema.brand("GateViolationMessage"))
export type GateViolationMessage = typeof GateViolationMessage.Type

export const SourceLineNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("SourceLineNumber"),
)
export type SourceLineNumber = typeof SourceLineNumber.Type

export const EnclosingSymbolName = Schema.NonEmptyString.pipe(Schema.brand("EnclosingSymbolName"))
export type EnclosingSymbolName = typeof EnclosingSymbolName.Type

export const GateVerdict = Schema.Literals(["clean", "violated"]).pipe(Schema.brand("GateVerdict"))
export type GateVerdict = typeof GateVerdict.Type

export const AstGatePackageTag = Schema.Literals([
  "contract", "domain", "service", "infra", "app", "test",
]).pipe(Schema.brand("AstGatePackageTag"))
export type AstGatePackageTag = typeof AstGatePackageTag.Type

export const GateViolation = Schema.Struct({
  category: GateCategory,
  rule: GateRuleId,
  message: GateViolationMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type GateViolation = typeof GateViolation.Type

export const SUSPICIOUS_SQL_DDL_REGEX =
  /\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/i

export const MIGRATOR_KEY_REGEX = /^[1-9]\d*_[a-z0-9_]+$/

export const SCHEMA_CTORS = new Set([
  "Struct", "Class", "TaggedClass", "TaggedStruct", "TaggedUnion", "Union",
  "Record", "Array", "Tuple", "String", "Number", "Boolean", "Int",
  "Natural", "NonEmptyString", "FiniteFromString",
])

export const IMPURE_DOMAIN_MODULES = new Set([
  "node:fs", "fs", "node:http", "http", "node:https", "https",
  "node:net", "net", "node:child_process", "child_process", "drizzle-orm", "alchemy",
])

export const isImpureDomainSpecifier = (spec: string): boolean =>
  IMPURE_DOMAIN_MODULES.has(spec) ||
  spec.startsWith("drizzle-orm/") ||
  spec.startsWith("@effect/sql") ||
  spec.startsWith("alchemy/") ||
  /^@harness\/[a-z0-9-]+-infra$/.test(spec)

export const getLineNumber = (sourceFile: ts.SourceFile, pos: number): SourceLineNumber => {
  const { line } = sourceFile.getLineAndCharacterOfPosition(Math.max(0, pos))
  return SourceLineNumber.make(line + 1)
}

export const resolveEnclosingSymbol = (node: ts.Node, filePath: string): EnclosingSymbolName => {
  let curr: ts.Node | undefined = node
  while (curr !== undefined) {
    if (ts.isVariableDeclaration(curr) && ts.isIdentifier(curr.name)) return EnclosingSymbolName.make(`${filePath}#${curr.name.text}`)
    if ((ts.isFunctionDeclaration(curr) || ts.isClassDeclaration(curr)) && curr.name !== undefined) return EnclosingSymbolName.make(`${filePath}#${curr.name.text}`)
    curr = curr.parent
  }
  return EnclosingSymbolName.make(filePath)
}

export const unwrapAstExpression = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isTypeAssertionExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

export const isDummyEffectVoidYield = (
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): boolean => {
  const inner = unwrapAstExpression(expr)
  return (
    (ts.isPropertyAccessExpression(inner) &&
      inner.expression.getText(sourceFile).trim() === "Effect" &&
      inner.name.text === "void") ||
    (ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.expression.getText(sourceFile).trim() === "Effect" &&
      inner.expression.name.text === "asVoid")
  )
}

const isAstGatePackageTag = (val: string): val is AstGatePackageTag =>
  val === "contract" || val === "domain" || val === "service" ||
  val === "infra" || val === "app" || val === "test"

export const inferPackageTagFromPath = (filePath: string): AstGatePackageTag => {
  if (filePath.includes("/contract/")) return AstGatePackageTag.make("contract")
  if (filePath.includes("/domain/") || filePath.includes("/core/")) return AstGatePackageTag.make("domain")
  if (filePath.includes("/service/")) return AstGatePackageTag.make("service")
  if (filePath.includes("/infra/")) return AstGatePackageTag.make("infra")
  return AstGatePackageTag.make("app")
}

const isInsideMigrationsRecord = (node: ts.Node, sourceFile: ts.SourceFile): boolean => {
  let curr: ts.Node | undefined = node.parent
  while (curr !== undefined) {
    if (ts.isCallExpression(curr) && curr.expression.getText(sourceFile).endsWith("fromRecord")) return true
    if (ts.isVariableDeclaration(curr) && ts.isIdentifier(curr.name) && /migrations/i.test(curr.name.text)) return true
    curr = curr.parent
  }
  return false
}

const isTagGuardCondition = (cond: ts.Expression, sourceFile: ts.SourceFile): boolean =>
  /\b(?:Option\.isSome|Option\.isNone|Either\.isRight|Either\.isLeft|Result\.isSuccess|Result\.isFailure|Exit\.isSuccess|Exit\.isFailure|Cause\.isFailType|Cause\.isDieType|Cause\.isInterruptType|Cause\.isEmptyType|Predicate\.isTagged)\s*\(/.test(
    cond.getText(sourceFile),
  )

const isDiscriminantCondition = (cond: ts.Expression, sourceFile: ts.SourceFile): boolean => {
  if (isTagGuardCondition(cond, sourceFile)) return true
  return /\.(?:_tag|kind|status)\s*(?:===|!==|==|!=)\s*["'`]/.test(cond.getText(sourceFile))
}

export const visitSourceFileSinglePass = (
  sourceFile: ts.SourceFile,
  filePathOrRelPath: string | AstSourceFilePath,
  packageTagOrContent?: AstGatePackageTag | string,
  _contentOrPackageTag?: string | AstGatePackageTag,
): ReadonlyArray<GateViolation> => {
  const filePath = AstSourceFilePath.make(String(filePathOrRelPath))
  const packageTag =
    packageTagOrContent !== undefined && isAstGatePackageTag(packageTagOrContent)
      ? AstGatePackageTag.make(packageTagOrContent)
      : _contentOrPackageTag !== undefined && isAstGatePackageTag(_contentOrPackageTag)
        ? AstGatePackageTag.make(_contentOrPackageTag)
        : inferPackageTagFromPath(filePath)

  const violations: Array<GateViolation> = []
  const normalizedFilePath = filePath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")
  const hasParentTraversal = normalizedFilePath.split("/").includes("..")
  const isTestFile = filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")
  const isHarnessInternal =
    !hasParentTraversal &&
    (normalizedFilePath.startsWith("libs/harness/") ||
      normalizedFilePath.startsWith("apps/harness-"))
  let hasMigratorImport = false

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const modText = stmt.moduleSpecifier.text
      if (modText.includes("SqliteMigrator") || modText.includes("Migrator")) {
        hasMigratorImport = true
      }
    }
  }

  const catSyntaxBans = GateCategory.make("syntax-bans")
  const catTestIntegrity = GateCategory.make("test-integrity")
  const catMigrationSafety = GateCategory.make("migration-safety")
  const catDomainPurity = GateCategory.make("domain-purity")
  const catEffectLaws = GateCategory.make("effect-laws")

  const pushViolation = (
    category: GateCategory,
    rule: string,
    message: string,
    node: ts.Node,
  ): void => {
    violations.push({
      category,
      rule: GateRuleId.make(rule),
      message: GateViolationMessage.make(message),
      file: filePath,
      line: getLineNumber(sourceFile, node.getStart(sourceFile)),
      enclosingSymbol: resolveEnclosingSymbol(node, filePath),
    })
  }

  const handlesTsxExtensions =
    sourceFile.text.includes('".tsx"') || sourceFile.text.includes("'.tsx'")
  const referencesLangTsx = sourceFile.text.includes("Lang.Tsx")

  const walk = (node: ts.Node): void => {
    // 1. Import declarations (domain-purity + syntax-bans + test-integrity)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (
        (spec === "node:sqlite" || spec === "sqlite" || spec === "better-sqlite3") &&
        !isHarnessInternal &&
        (packageTag === "infra" || packageTag === "app")
      ) {
        pushViolation(
          isTestFile ? catTestIntegrity : catSyntaxBans,
          "node-sqlite-in-infra",
          `Do not import '${spec}' in '${filePath}' — use @alchemy.run/cloudflare-runtime workerd storage instead of node:sqlite mocks.`,
          node,
        )
      }
      if (
        !isTestFile &&
        !isHarnessInternal &&
        (packageTag === "domain" || packageTag === "contract") &&
        isImpureDomainSpecifier(spec)
      ) {
        pushViolation(
          catDomainPurity,
          "impure-domain-import",
          `Module '${filePath}' (${packageTag}) imports impure infrastructure dependency '${spec}'.`,
          node,
        )
      }
    }

    // 2. Switch statements (syntax-bans)
    if (ts.isSwitchStatement(node) && !isTestFile) {
      pushViolation(
        catSyntaxBans,
        "discriminant-branching",
        `Switch statement in '${filePath}' is banned — use match(value).with(...).exhaustive() from ts-pattern.`,
        node,
      )
    }

    // 2b. Dummy yield* Effect.void (effect-laws: effect-fn-dummy-void)
    if (ts.isYieldExpression(node) && !isTestFile) {
      if (node.expression !== undefined && isDummyEffectVoidYield(node.expression, sourceFile)) {
        pushViolation(
          catEffectLaws,
          "effect-fn-dummy-void",
          `Dummy 'yield* Effect.void' in '${filePath}' is banned — use a pure function or Effect.sync(() => ...) instead of a dummy yield.`,
          node,
        )
      }
    }

    // 3. AsExpression / TypeAssertionExpression (syntax-bans: unsafe-type-cast)
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const typeNode = node.type
      let innerExpr: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(innerExpr)) {
        innerExpr = innerExpr.expression
      }
      if (
        typeNode.kind === ts.SyntaxKind.AnyKeyword ||
        typeNode.kind === ts.SyntaxKind.NeverKeyword
      ) {
        const keyword = typeNode.kind === ts.SyntaxKind.AnyKeyword ? "any" : "never"
        pushViolation(
          catSyntaxBans,
          "unsafe-type-cast",
          `Unsafe type assertion 'as ${keyword}' in '${filePath}' is banned.`,
          node,
        )
      } else if (
        (ts.isAsExpression(innerExpr) || ts.isTypeAssertionExpression(innerExpr)) &&
        innerExpr.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        pushViolation(
          catSyntaxBans,
          "unsafe-type-cast",
          `Double type assertion 'as unknown as T' in '${filePath}' is banned.`,
          node,
        )
      }
    }

    // 4. IfStatement & ConditionalExpression (effect-laws: discriminant-branching)
    if (ts.isIfStatement(node) && !isTestFile && !isHarnessInternal) {
      if (isDiscriminantCondition(node.expression, sourceFile)) {
        pushViolation(
          catEffectLaws,
          "discriminant-branching",
          `If statement in '${filePath}' inspects union discriminant or Option/Either/Result/Exit/Cause guard — use match(...).exhaustive().`,
          node,
        )
      }
    }
    if (ts.isConditionalExpression(node) && !isTestFile) {
      if (
        isTagGuardCondition(node.condition, sourceFile) ||
        (!isHarnessInternal && isDiscriminantCondition(node.condition, sourceFile))
      ) {
        pushViolation(
          catEffectLaws,
          "discriminant-branching",
          `Ternary expression in '${filePath}' inspects union discriminant or Option/Either/Result/Exit/Cause guard — use match(...).exhaustive().`,
          node,
        )
      }
    }

    // 4b. PropertyAccessExpression: Effect.ignore in domain (domain-purity: domain-effect-ignore)
    if (
      ts.isPropertyAccessExpression(node) &&
      !isTestFile &&
      !isHarnessInternal &&
      packageTag === "domain" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Effect" &&
      node.name.text === "ignore"
    ) {
      pushViolation(
        catDomainPurity,
        "domain-effect-ignore",
        `Swallowing typed errors with Effect.ignore in '${filePath}' (domain) is banned — surface failures in the E channel or handle them explicitly.`,
        node,
      )
    }

    // 5. CallExpressions (effect-laws, domain-purity, test-integrity, syntax-bans)
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sourceFile)

      if (
        !isTestFile &&
        calleeText === "parse" &&
        node.arguments.length >= 2 &&
        node.arguments[0]?.getText(sourceFile) === "Lang.TypeScript" &&
        handlesTsxExtensions &&
        !referencesLangTsx
      ) {
        pushViolation(
          catSyntaxBans,
          "ast-grep-tsx-grammar",
          `Hardcoded parse(Lang.TypeScript, ...) in '${filePath}' which handles .tsx files — select Lang.Tsx for .tsx files so JSX syntax parses cleanly.`,
          node,
        )
      }

      const unwrappedExpr = unwrapAstExpression(node.expression)
      if (
        !isTestFile &&
        ts.isPropertyAccessExpression(unwrappedExpr) &&
        unwrappedExpr.name.text === "run" &&
        /\bmatch\s*\(/.test(unwrappedExpr.expression.getText(sourceFile))
      ) {
        pushViolation(
          catEffectLaws,
          "non-exhaustive-union-match",
          `match(...).run() in '${filePath}' is banned — use .exhaustive() instead.`,
          node,
        )
      }

      if (
        !isTestFile &&
        !isHarnessInternal &&
        packageTag !== "app" &&
        (calleeText === "Effect.runSync" ||
          calleeText === "Effect.runPromise" ||
          calleeText === "Effect.runFork")
      ) {
        pushViolation(
          catDomainPurity,
          "unscoped-effect-run",
          `Unscoped '${calleeText}' in '${filePath}' (${packageTag}) — compose Effects and run at the app edge.`,
          node,
        )
      }

      if (
        isTestFile &&
        calleeText.startsWith("expect(") &&
        /expect\s*\(\s*Exit\.isFailure\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\)/.test(
          node.expression.getText(sourceFile),
        )
      ) {
        const fullSourceText = sourceFile.text
        if (
          !fullSourceText.includes("Cause.findErrorOption") &&
          !fullSourceText.includes(".cause")
        ) {
          pushViolation(
            catTestIntegrity,
            "vacuous-error-assertion",
            `Vacuous Exit.isFailure assertion in '${filePath}' without inspecting Cause.findErrorOption or error fields.`,
            node,
          )
        }
      }
    }

    // 6. BinaryExpression: JSON.stringify(a) === JSON.stringify(b) in tests
    if (ts.isBinaryExpression(node) && isTestFile) {
      const op = node.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        const leftText = node.left.getText(sourceFile)
        const rightText = node.right.getText(sourceFile)
        if (leftText.startsWith("JSON.stringify(") && rightText.startsWith("JSON.stringify(")) {
          pushViolation(
            catTestIntegrity,
            "fallback-json-equality",
            `Fallback JSON.stringify equality comparison in '${filePath}' — use structured equality or Equal.equals.`,
            node,
          )
        }
      }
    }

    // 7. TaggedTemplateExpression: sql`...` migration safety & unmanaged DDL
    if (ts.isTaggedTemplateExpression(node)) {
      const tagText = node.tag.getText(sourceFile)
      if (tagText === "sql" || tagText.endsWith(".sql")) {
        const templateText = node.template.getText(sourceFile).slice(1, -1)
        if (SUSPICIOUS_SQL_DDL_REGEX.test(templateText)) {
          if (
            packageTag === "infra" &&
            !isHarnessInternal &&
            (!hasMigratorImport || !isInsideMigrationsRecord(node, sourceFile))
          ) {
            pushViolation(
              catMigrationSafety,
              "unmanaged-sql-ddl",
              `Raw SQL DDL in '${filePath}' outside SqliteMigrator.fromRecord migration record.`,
              node,
            )
          }
          const safety = checkMigrationSqlSafety([{ file: filePath, sql: templateText }])
          for (const v of safety.violations) {
            pushViolation(catMigrationSafety, "unsafe-sql-migration", v.message, node)
          }
        }
      }
    }

    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return violations
}
