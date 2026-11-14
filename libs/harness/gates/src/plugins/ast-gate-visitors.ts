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
import { match, P } from "ts-pattern"
import {
  AstGatePackageTag,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateViolationMessage,
  SourceLineNumber,
} from "@harness/contract"
import { ts } from "@harness/graph"
import { checkMigrationSqlSafety } from "../migration-check.js"

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

const CATCH_DEFECT_REPORTING_TOKENS = [
  "stderr.write", "logWarning", "logError", "Effect.log", "console.error",
  "console.warn", "Effect.fail", "Effect.die", "makeLspExceptionReport", "ExceptionReport",
] as const

const isCatchCauseOrExitRunCallee = (c: string): boolean =>
  c === "Effect.catchCause" || c.endsWith(".catchCause") || c === "catchCause" ||
  c === "Effect.runPromiseExit" || c.endsWith(".runPromiseExit") ||
  c === "Effect.runSyncExit" || c.endsWith(".runSyncExit")

const callOrReceiverMatchesExitOrCatch = (call: ts.CallExpression, sf: ts.SourceFile): boolean => {
  let curr: ts.CallExpression | undefined = call
  while (curr !== undefined) {
    const callee = curr.expression.getText(sf)
    if (isCatchCauseOrExitRunCallee(callee)) return true
    if (callee === "match" && curr.arguments.some((a) => ts.isCallExpression(a) && isCatchCauseOrExitRunCallee(a.expression.getText(sf)))) return true
    curr = ts.isPropertyAccessExpression(curr.expression) && ts.isCallExpression(curr.expression.expression) ? curr.expression.expression : undefined
  }
  return false
}

export const isCatchCauseInterruptsOnlyCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  if (node.expression.getText(sf) !== "Cause.hasInterruptsOnly") return false
  let anc: ts.Node | undefined = node.parent
  let crossedFn = false
  const nodeStart = node.getStart(sf)
  while (anc !== undefined) {
    if (ts.isCallExpression(anc) && callOrReceiverMatchesExitOrCatch(anc, sf)) return true
    if (!crossedFn && (ts.isBlock(anc) || ts.isSourceFile(anc))) {
      for (const stmt of anc.statements) {
        if (stmt.getStart(sf) >= nodeStart) break
        if (/\b(?:Effect\.)?(?:runSyncExit|runPromiseExit)\s*\(/.test(stmt.getText(sf))) return true
      }
    }
    if (ts.isFunctionLike(anc)) crossedFn = true
    anc = anc.parent
  }
  return false
}

export const isSilentCatchDefectCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = node.expression.getText(sf)
  if (callee !== "Effect.catchDefect" && !callee.endsWith(".catchDefect")) return false
  const cb = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0]
  if (cb === undefined) return false
  const cbText = cb.getText(sf)
  return !CATCH_DEFECT_REPORTING_TOKENS.some((tok) => cbText.includes(tok))
}

export const isIgnoredChmodPermissionCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = node.expression.getText(sf)
  if (callee !== "chmodSync" && !callee.endsWith(".chmodSync") && callee !== "fchmodSync" && !callee.endsWith(".fchmodSync")) return false
  let anc: ts.Node | undefined = node.parent
  let callDepth = 0
  while (anc !== undefined && callDepth < 6) {
    if (ts.isFunctionDeclaration(anc) || ts.isMethodDeclaration(anc)) break
    if (ts.isCallExpression(anc)) {
      callDepth += 1
      const ancCallee = anc.expression.getText(sf)
      if (ancCallee === "Effect.ignore" || ancCallee === "Effect.orElseSucceed" || ancCallee.endsWith(".ignore") || ancCallee.endsWith(".orElseSucceed")) return true
      if (ancCallee.endsWith(".pipe") && anc.arguments.some((a) => { const t = a.getText(sf); return t.includes("Effect.ignore") || t.includes("Effect.orElseSucceed") })) return true
    }
    anc = anc.parent
  }
  return false
}

export const visitSourceFileSinglePass = (
  sourceFile: ts.SourceFile,
  filePathOrRelPath: string | AstSourceFilePath,
  packageTagParam?: AstGatePackageTag,
): ReadonlyArray<GateViolation> => {
  const filePath = AstSourceFilePath.make(String(filePathOrRelPath))
  const normalizedFilePath = filePath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")
  const packageTag = packageTagParam ?? inferPackageTagFromPath(normalizedFilePath)

  const violations: Array<GateViolation> = []
  const isTestFile =
    normalizedFilePath.endsWith(".test.ts") ||
    normalizedFilePath.endsWith(".test.tsx") ||
    normalizedFilePath.endsWith(".spec.ts") ||
    normalizedFilePath.endsWith(".spec.tsx")
  let hasMigratorImport = false

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const modText = stmt.moduleSpecifier.text
      const clauseText = stmt.importClause?.getText(sourceFile) ?? ""
      if (
        modText.includes("SqliteMigrator") ||
        modText.includes("Migrator") ||
        /\b(?:SqliteMigrator|Migrator)\b/.test(clauseText)
      ) {
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
  const effectNamespaceNames = new Set<string>(["Effect"])
  const isTestOrHelperFile = isTestFile || /(?:^|\/)test\/(?!fixtures\/)/.test(normalizedFilePath)
  const isMemoryWorkerdBridge = /(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(normalizedFilePath)
  const isHarnessMcpSdkBoundary = /(?:^|\/)apps\/harness-mcp\/src\//.test(normalizedFilePath)
  const isBannedEffectRunMethod = (methodName: string): boolean => {
    if (methodName === "runSync" || methodName === "runSyncExit") return true
    if (methodName === "runPromise" || methodName === "runPromiseExit") return !isHarnessMcpSdkBoundary
    if (methodName === "runFork") return packageTag !== "app"
    return false
  }

  const walk = (node: ts.Node): void => {
    // 1. Import declarations (domain-purity + syntax-bans + test-integrity)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (!node.importClause?.isTypeOnly && (spec === "effect" || spec === "effect/Effect")) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          effectNamespaceNames.add(bindings.name.text)
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue
            const importedName = (el.propertyName ?? el.name).text
            if (spec === "effect" && importedName === "Effect") {
              effectNamespaceNames.add(el.name.text)
            }
            if (
              spec === "effect/Effect" &&
              !isTestOrHelperFile &&
              !isMemoryWorkerdBridge &&
              isBannedEffectRunMethod(importedName)
            ) {
              pushViolation(
                catDomainPurity,
                "unscoped-effect-run",
                `Unscoped 'Effect.${importedName}' import in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
                node,
              )
            }
          }
        }
      }
      if (
        (spec === "node:sqlite" || spec === "sqlite" || spec === "better-sqlite3") &&
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
      match(typeNode.kind)
        .with(ts.SyntaxKind.AnyKeyword, () => {
          pushViolation(
            catSyntaxBans,
            "unsafe-type-cast",
            `Unsafe type assertion 'as any' in '${filePath}' is banned.`,
            node,
          )
        })
        .with(ts.SyntaxKind.NeverKeyword, () => {
          pushViolation(
            catSyntaxBans,
            "unsafe-type-cast",
            `Unsafe type assertion 'as never' in '${filePath}' is banned.`,
            node,
          )
        })
        .otherwise(() => {
          if (
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
        })
    }

    // 4. IfStatement & ConditionalExpression (effect-laws: discriminant-branching)
    if (ts.isIfStatement(node) && !isTestFile) {
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
        isDiscriminantCondition(node.condition, sourceFile)
      ) {
        pushViolation(
          catEffectLaws,
          "discriminant-branching",
          `Ternary expression in '${filePath}' inspects union discriminant or Option/Either/Result/Exit/Cause guard — use match(...).exhaustive().`,
          node,
        )
      }
    }

    // 4b. PropertyAccessExpression: Effect.ignore in domain & unscoped Effect.run*
    if (ts.isPropertyAccessExpression(node) && !isTestFile) {
      if (
        packageTag === "domain" &&
        ts.isIdentifier(node.expression) &&
        effectNamespaceNames.has(node.expression.text) &&
        node.name.text === "ignore"
      ) {
        pushViolation(
          catDomainPurity,
          "domain-effect-ignore",
          `Swallowing typed errors with Effect.ignore in '${filePath}' (domain) is banned — surface failures in the E channel or handle them explicitly.`,
          node,
        )
      }
      if (
        !isTestOrHelperFile &&
        !isMemoryWorkerdBridge &&
        ts.isIdentifier(node.expression) &&
        effectNamespaceNames.has(node.expression.text) &&
        isBannedEffectRunMethod(node.name.text)
      ) {
        pushViolation(
          catDomainPurity,
          "unscoped-effect-run",
          `Unscoped '${node.expression.text}.${node.name.text}' in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`,
          node,
        )
      }
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

      if (!isTestFile && isCatchCauseInterruptsOnlyCall(node, sourceFile)) {
        pushViolation(
          catEffectLaws,
          "catch-cause-interrupts-only",
          "Cause.hasInterruptsOnly(cause) inside Effect.catchCause / Exit inspection swallows fiber interruption on composite causes (Fail + Interrupt). Use Cause.hasInterrupts(cause) instead.",
          node,
        )
      }

      if (!isTestFile && isSilentCatchDefectCall(node, sourceFile)) {
        pushViolation(
          catEffectLaws,
          "silent-catch-defect",
          `Effect.catchDefect handler in '${filePath}' silently swallows runtime defects without logging or reporting — log via Effect.logWarning / process.stderr.write or re-fail.`,
          node,
        )
      }

      if (!isTestFile && isIgnoredChmodPermissionCall(node, sourceFile)) {
        pushViolation(
          catSyntaxBans,
          "ignored-chmod-permission",
          `Ignoring chmodSync/fchmodSync failure with Effect.ignore or Effect.orElseSucceed in '${filePath}' is banned — permission hardening must fail closed on error.`,
          node,
        )
      }

      if (
        isTestFile &&
        (calleeText === "saveGraphSnapshot" ||
          calleeText === "saveGraphSnapshotEffect" ||
          calleeText === "writeFileSync" ||
          calleeText === "fs.writeFileSync")
      ) {
        let hasLiveDotHarnessArg = false
        for (const arg of node.arguments) {
          if (/["'`]\.harness\//.test(arg.getText(sourceFile))) {
            hasLiveDotHarnessArg = true
            break
          }
        }
        if (hasLiveDotHarnessArg) {
          pushViolation(
            catTestIntegrity,
            "unisolated-dot-harness-test-write",
            "Test files must not write directly to live .harness/ paths — use os.tmpdir() / fs.mkdtempSync for isolated snapshot and file tests.",
            node,
          )
        }
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
      match(node.operatorToken.kind)
        .with(P.union(ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken), () => {
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
        })
        .otherwise(() => {})
    }

    // 7. TaggedTemplateExpression: sql`...` migration safety & unmanaged DDL
    if (ts.isTaggedTemplateExpression(node)) {
      const tagText = node.tag.getText(sourceFile)
      if (tagText === "sql" || tagText.endsWith(".sql")) {
        const templateText = node.template.getText(sourceFile).slice(1, -1)
        if (SUSPICIOUS_SQL_DDL_REGEX.test(templateText)) {
          if (
            packageTag === "infra" &&
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
