/**
 * @file ast-gate-visitors.ts
 * Single-pass AST visitor and leaf gate schema definitions for Effect-TS Engineering Harness.
 *
 * Traverses TypeScript ASTs once to enforce architectural invariants across 5 gate categories:
 * 1. syntax-bans:
 *    - node-sqlite-in-infra: Bans node:sqlite, sqlite, better-sqlite3 in infra/app code
 *    - banned-drizzle-import: Bans drizzle-orm / drizzle-kit imports in non-test code
 *    - discriminant-branching: Bans switch statements (use ts-pattern match(...).exhaustive())
 *    - unsafe-type-cast: Bans 'as any', 'as never', and double assertions 'as unknown as T'
 *    - ast-grep-tsx-grammar: Bans hardcoded Lang.TypeScript parser on .tsx files
 *    - ignored-chmod-permission: Bans Effect.ignore / Effect.orElseSucceed on chmodSync/fchmodSync
 *    - silent-gate-fs-fallback: Bans silent fs fallbacks in gates
 *    - invalid-clef-endpoint: Bans non-SystemOne /api/generate or /api/chat calls against clef-flash
 * 2. test-integrity:
 *    - node-sqlite-in-infra: Bans node:sqlite mocks in test files
 *    - banned-drizzle-import: Bans drizzle-orm / drizzle-kit imports in test files
 *    - unisolated-dot-harness-test-write: Bans test writes directly to live .harness/ paths
 *    - vacuous-error-assertion: Bans unverified Exit.isFailure checks lacking cause inspection
 *    - fallback-json-equality: Bans JSON.stringify equality comparisons in tests
 * 3. migration-safety:
 *    - unmanaged-sql-ddl: Bans raw SQL DDL outside SqliteMigrator.fromRecord in infra
 *    - unsafe-sql-migration: Flags destructive SQL statements (DROP, table rebuilds, un-defaulted NOT NULL)
 * 4. domain-purity:
 *    - impure-domain-import: Bans node I/O, Drizzle, SQL, and Alchemy imports in domain/contract packages
 *    - domain-effect-ignore: Bans Effect.ignore in domain logic swallowing typed errors
 *    - unscoped-effect-run: Bans unscoped Effect.runSync/runPromise/runFork/runCallback in workspace tier and app files (retaining only the narrow single-file libs/es/infra/src/memory.ts exemption for synchronous workerd SqlStorage callbacks)
 * 5. effect-laws:
 *    - effect-fn-dummy-void: Bans dummy 'yield* Effect.void' in generator functions
 *    - discriminant-branching: Bans if/ternary discriminant or Option/Either/Exit/Result guard inspection
 *    - non-exhaustive-union-match: Bans match(...).run() in favor of .exhaustive()
 *    - catch-cause-interrupts-only: Bans Cause.hasInterruptsOnly inside Effect.catchCause / Exit inspection
 *    - bare-cause-has-interrupts: Bans bare Cause.hasInterrupts(cause) (without !Cause.hasFails && !Cause.hasDies) and Cause.hasInterruptsOnly(cause) in production src/
 *    - silent-catch-defect: Bans Effect.catchDefect handlers that swallow defects without logging or re-failing
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
  inferAstGatePackageTagFromPath,
  SourceLineNumber,
} from "@harness/contract"
import { ts } from "@harness/graph"
import { checkMigrationSqlSafety } from "../migration-check.js"
import { hasResultTryFsReadText, isAllOptionalSchemaStructCall, isBareCauseHasInterruptsNode, isConditionalPortBindBailout, isDiscardedPersistenceCallStatement, isSilentFsFallbackCheckedPath, isVacuousLengthNonNegativeAssertion } from "./ast-gate-law-helpers.js"
import { analyzeSqliteMigratorFromRecordAst } from "./sqlite-migrator-ast.js"

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

const INVALID_CLEF_ENDPOINT_MESSAGE =
  "[invalid-clef-endpoint] System One models (clef-flash) only expose POST /v1/systemone (and GET /v1/models or GET /api/tags). Never call /api/generate, /api/chat, or /v1/chat/completions — use DecisionModel.decide (@effect/ai-typesafe) per agent-patterns/decision-model.md."

const isInvalidClefEndpointUrlText = (text: string): boolean =>
  /11434\/(?:api\/(?:generate|chat)|v1\/(?:chat\/completions|completions))\b/i.test(text) ||
  (/(?:11434|\bclef(?:-flash)?\b)/i.test(text) && /\/api\/(?:generate|chat)\b/i.test(text))

export const SCHEMA_CTORS = new Set([
  "Struct", "Class", "TaggedClass", "TaggedStruct", "TaggedUnion", "Union",
  "Record", "Array", "Tuple", "String", "Number", "Boolean", "Int",
  "Natural", "NonEmptyString", "FiniteFromString",
])

export const IMPURE_DOMAIN_MODULES = new Set([
  "node:fs", "fs", "node:http", "http", "node:https", "https",
  "node:net", "net", "node:child_process", "child_process", "drizzle-orm", "drizzle-kit", "alchemy",
])

export const isDrizzleSpecifier = (spec: string): boolean =>
  spec === "drizzle-orm" ||
  spec.startsWith("drizzle-orm/") ||
  spec === "drizzle-kit" ||
  spec.startsWith("drizzle-kit/")

export const isImpureDomainSpecifier = (spec: string): boolean =>
  IMPURE_DOMAIN_MODULES.has(spec) ||
  isDrizzleSpecifier(spec) ||
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
    ts.isSatisfiesExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

const extractStringOrNoSubTemplateText = (expr: ts.Expression): string | undefined => {
  const unwrapped = unwrapAstExpression(expr)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text
  }
  return undefined
}

const getModulePrefixOrStaticString = (expr: ts.Expression): string | undefined => {
  const staticStr = extractStringOrNoSubTemplateText(expr)
  if (staticStr !== undefined) return staticStr
  const unwrapped = unwrapAstExpression(expr)
  if (ts.isTemplateExpression(unwrapped)) {
    return unwrapped.head.text
  }
  return undefined
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

export { inferAstGatePackageTagFromPath as inferPackageTagFromPath }

const isEffectRunSyncOfDie = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  isEffectNs: (expr: ts.Expression) => boolean,
): boolean => {
  const methodName = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : extractStringOrNoSubTemplateText(node.argumentExpression)
  if (methodName !== "runSync") return false
  if (node.parent === undefined || !ts.isCallExpression(node.parent) || node.parent.expression !== node) {
    return false
  }
  const firstArg = node.parent.arguments[0]
  if (firstArg === undefined) return false
  const unwrapped = unwrapAstExpression(firstArg)
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    isEffectNs(unwrapped.expression.expression) &&
    unwrapped.expression.name.text === "die"
  )
}

const isSilentFallbackFn = (expr: ts.Expression, sf: ts.SourceFile, extended: boolean): boolean => {
  const fn = unwrapAstExpression(expr)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let body = fn.body.getText(sf).trim()
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return false
    const s = fn.body.statements[0]
    if (s === undefined || !ts.isReturnStatement(s) || s.expression === undefined) return false
    body = s.expression.getText(sf).trim()
  }
  if (body === '""' || body === "''" || body === "[]") return true
  return extended && (body === "{}" || body === "undefined" || body === "false")
}

const isSilentGateFsFallbackAstCall = (node: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const callee = unwrapAstExpression(node.expression)
  if (ts.isIdentifier(callee) && callee.text === "safeFs") return true
  const calleeText = callee.getText(sf)
  if (
    calleeText === "Result.getOrElse" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sf)) &&
    isSilentFallbackFn(node.arguments[1], sf, false)
  ) {
    return true
  }
  const isPipeGetOrElse = (arg: ts.Expression): boolean =>
    ts.isCallExpression(arg) &&
    unwrapAstExpression(arg.expression).getText(sf) === "Result.getOrElse" &&
    arg.arguments.length === 1 &&
    arg.arguments[0] !== undefined &&
    isSilentFallbackFn(arg.arguments[0], sf, true)
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "pipe" &&
    hasResultTryFsReadText(callee.expression.getText(sf)) &&
    node.arguments.some(isPipeGetOrElse)
  ) {
    return true
  }
  if (
    ts.isIdentifier(callee) &&
    callee.text === "pipe" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    hasResultTryFsReadText(node.arguments[0].getText(sf)) &&
    node.arguments.slice(1).some(isPipeGetOrElse)
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "with" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    isSilentFallbackFn(node.arguments[1], sf, true)
  ) {
    const pat = unwrapAstExpression(node.arguments[0])
    const isFailurePat =
      ts.isObjectLiteralExpression(pat) &&
      pat.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === "_tag" &&
          extractStringOrNoSubTemplateText(p.initializer) === "Failure",
      )
    if (!isFailurePat) return false
    let curr: ts.Expression = callee
    while (ts.isPropertyAccessExpression(curr) && ts.isCallExpression(curr.expression)) {
      const innerCall = curr.expression
      const innerCallee = unwrapAstExpression(innerCall.expression)
      if (ts.isIdentifier(innerCallee) && innerCallee.text === "match") {
        const arg0 = innerCall.arguments[0]
        return arg0 !== undefined && hasResultTryFsReadText(arg0.getText(sf))
      }
      curr = innerCallee
    }
  }
  return false
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
  const packageTag = packageTagParam ?? inferAstGatePackageTagFromPath(normalizedFilePath)

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

  const handlesTsxExtensions = sourceFile.text.includes('".tsx"') || sourceFile.text.includes("'.tsx'")
  const referencesLangTsx = sourceFile.text.includes("Lang.Tsx")
  const effectModuleNamespaceNames = new Set<string>()
  const effectNamespaceNames = new Set<string>(["Effect"])
  const bannedRunAliases = new Map<string, string>()
  const isEffectNsExpr = (expr: ts.Expression): boolean => {
    const u = unwrapAstExpression(expr)
    if (ts.isIdentifier(u)) return effectNamespaceNames.has(u.text)
    if (ts.isPropertyAccessExpression(u) && u.name.text === "Effect") {
      const inner = unwrapAstExpression(u.expression)
      return ts.isIdentifier(inner) && effectModuleNamespaceNames.has(inner.text)
    }
    if (ts.isElementAccessExpression(u) && extractStringOrNoSubTemplateText(u.argumentExpression) === "Effect") {
      const inner = unwrapAstExpression(u.expression)
      return ts.isIdentifier(inner) && effectModuleNamespaceNames.has(inner.text)
    }
    return false
  }
  const getBindingPropName = (el: ts.BindingElement): string | undefined => {
    const pn = el.propertyName
    if (pn === undefined) return ts.isIdentifier(el.name) ? el.name.text : undefined
    if (ts.isIdentifier(pn) || ts.isStringLiteral(pn) || ts.isNoSubstitutionTemplateLiteral(pn)) return pn.text
    if (ts.isComputedPropertyName(pn)) return extractStringOrNoSubTemplateText(pn.expression)
    return undefined
  }
  const isTestOrHelperFile = isTestFile || /(?:^|\/)test\/(?!fixtures\/)/.test(normalizedFilePath)
  const isGatesSrcFile = !isTestFile && isSilentFsFallbackCheckedPath(normalizedFilePath)
  const isContractSrcFile = !isTestFile && /(?:^|\/)libs\/[^/]+\/contract\/src\//.test(normalizedFilePath)
  const isClefEndpointCheckedSrcFile =
    !isTestFile &&
    /(?:^|\/)src\//.test(normalizedFilePath) &&
    !/(?:^|\/)(?:triage-decision|policy|ast-gate-visitors)\.ts$/.test(normalizedFilePath)
  const isMemoryWorkerdBridge = /(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(normalizedFilePath)
  const isHarnessMcpRunPromiseExitBoundary =
    /(?:^|\/)apps\/harness-mcp\/src\/(?:server|daemon\/unix-socket-daemon)\.ts$/.test(normalizedFilePath)
  const isBannedEffectRunMethod = (methodName: string): boolean => {
    if (
      methodName === "runSync" ||
      methodName === "runSyncExit" ||
      methodName === "runSyncWith" ||
      methodName === "runCallback" ||
      methodName === "runCallbackWith" ||
      methodName === "runPromise" ||
      methodName === "runPromiseWith"
    ) {
      return true
    }
    if (methodName === "runPromiseExit") return !isHarnessMcpRunPromiseExitBoundary
    if (methodName === "runFork" || methodName === "runForkWith") return packageTag !== "app"
    return false
  }

  const reportDrizzleIfBanned = (spec: string | undefined, node: ts.Node): void => {
    if (spec === undefined || !isDrizzleSpecifier(spec)) return
    if (packageTag === "domain" && !isTestFile) {
      pushViolation(catDomainPurity, "impure-domain-import", `Module '${filePath}' (${packageTag}) imports impure infrastructure dependency '${spec}'.`, node)
    } else {
      pushViolation(isTestFile ? catTestIntegrity : catSyntaxBans, "banned-drizzle-import", `Drizzle import '${spec}' in '${filePath}' is banned across the workspace — use native Effect v4 SQL (@effect/sql-d1, @effect/sql-sqlite-do, SqlClient, SqliteMigrator).`, node)
    }
  }

  const walk = (node: ts.Node): void => {
    // 1. Import declarations (domain-purity + syntax-bans + test-integrity)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (!node.importClause?.isTypeOnly && (spec === "effect" || spec === "effect/Effect")) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          if (spec === "effect") effectModuleNamespaceNames.add(bindings.name.text)
          else effectNamespaceNames.add(bindings.name.text)
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue
            const importedName = (el.propertyName ?? el.name).text
            if (spec === "effect" && importedName === "Effect") effectNamespaceNames.add(el.name.text)
            if (spec === "effect/Effect" && !isTestOrHelperFile && isBannedEffectRunMethod(importedName)) {
              pushViolation(catDomainPurity, "unscoped-effect-run", `Unscoped 'Effect.${importedName}' import in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`, node)
            }
          }
        }
      }
      if ((spec === "node:sqlite" || spec === "sqlite" || spec === "better-sqlite3") && (packageTag === "infra" || packageTag === "app")) {
        pushViolation(isTestFile ? catTestIntegrity : catSyntaxBans, "node-sqlite-in-infra", `Do not import '${spec}' in '${filePath}' — use @alchemy.run/cloudflare-runtime workerd storage instead of node:sqlite mocks.`, node)
      }
      reportDrizzleIfBanned(spec, node)
      if (!isTestFile && !isDrizzleSpecifier(spec) && (packageTag === "domain" || packageTag === "contract") && isImpureDomainSpecifier(spec)) {
        pushViolation(catDomainPurity, "impure-domain-import", `Module '${filePath}' (${packageTag}) imports impure infrastructure dependency '${spec}'.`, node)
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      reportDrizzleIfBanned(node.moduleSpecifier.text, node)
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      reportDrizzleIfBanned(node.moduleReference.expression.text, node)
    }

    // 2. Switch statements (syntax-bans)
    if (ts.isSwitchStatement(node) && !isTestFile) {
      pushViolation(catSyntaxBans, "discriminant-branching", `Switch statement in '${filePath}' is banned — use match(value).with(...).exhaustive() from ts-pattern.`, node)
    }

    // 2b. Dummy yield* Effect.void (effect-laws: effect-fn-dummy-void)
    if (ts.isYieldExpression(node) && !isTestFile) {
      if (node.expression !== undefined && isDummyEffectVoidYield(node.expression, sourceFile)) {
        pushViolation(catEffectLaws, "effect-fn-dummy-void", `Dummy 'yield* Effect.void' in '${filePath}' is banned — use a pure function or Effect.sync(() => ...) instead of a dummy yield.`, node)
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

    // 4a. VariableDeclaration: track Effect/runSync aliases & destructuring
    if (ts.isVariableDeclaration(node) && !isTestOrHelperFile && node.initializer !== undefined) {
      const init = unwrapAstExpression(node.initializer)
      if (isEffectNsExpr(init)) {
        if (ts.isIdentifier(node.name)) effectNamespaceNames.add(node.name.text)
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = getBindingPropName(el)
            if (prop !== undefined && isBannedEffectRunMethod(prop) && ts.isIdentifier(el.name)) {
              bannedRunAliases.set(el.name.text, prop)
            }
          }
        }
      }
      if (!isEffectNsExpr(init) && ts.isIdentifier(init) && effectModuleNamespaceNames.has(init.text) && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (getBindingPropName(el) !== "Effect") continue
          if (ts.isIdentifier(el.name)) effectNamespaceNames.add(el.name.text)
          if (ts.isObjectBindingPattern(el.name)) {
            for (const nested of el.name.elements) {
              const prop = getBindingPropName(nested)
              if (prop !== undefined && isBannedEffectRunMethod(prop) && ts.isIdentifier(nested.name)) {
                bannedRunAliases.set(nested.name.text, prop)
              }
            }
          }
        }
      }
    }

    // 4b. PropertyAccessExpression / ElementAccessExpression / Identifier: Effect.ignore & unscoped Effect.run*
    if (ts.isPropertyAccessExpression(node) && !isTestFile) {
      if (packageTag === "domain" && isEffectNsExpr(node.expression) && node.name.text === "ignore") {
        pushViolation(catDomainPurity, "domain-effect-ignore", `Swallowing typed errors with Effect.ignore in '${filePath}' (domain) is banned — surface failures in the E channel or handle them explicitly.`, node)
      }
      if (
        !isTestOrHelperFile &&
        !(isMemoryWorkerdBridge && isEffectRunSyncOfDie(node, isEffectNsExpr)) &&
        isEffectNsExpr(node.expression) &&
        isBannedEffectRunMethod(node.name.text)
      ) {
        pushViolation(catDomainPurity, "unscoped-effect-run", `Unscoped '${node.expression.getText(sourceFile)}.${node.name.text}' in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`, node)
      }
    }
    if (ts.isElementAccessExpression(node) && !isTestOrHelperFile) {
      const methodName = extractStringOrNoSubTemplateText(node.argumentExpression)
      if (
        methodName !== undefined &&
        isBannedEffectRunMethod(methodName) &&
        !(isMemoryWorkerdBridge && isEffectRunSyncOfDie(node, isEffectNsExpr))
      ) {
        pushViolation(catDomainPurity, "unscoped-effect-run", `Unscoped computed '${node.expression.getText(sourceFile)}["${methodName}"]' in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`, node)
      }
    }
    if (
      ts.isIdentifier(node) &&
      !isTestOrHelperFile &&
      bannedRunAliases.has(node.text) &&
      !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    ) {
      const orig = bannedRunAliases.get(node.text)!
      pushViolation(catDomainPurity, "unscoped-effect-run", `Unscoped destructured 'Effect.${orig}' alias '${node.text}' in '${filePath}' (${packageTag}) — compose Effects and run via NodeRuntime.runMain or ManagedRuntime at the app edge.`, node)
    }

    // 5. CallExpressions (effect-laws, domain-purity, test-integrity, syntax-bans)
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequireCall =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
      if ((isDynamicImport || isRequireCall) && node.arguments.length > 0 && node.arguments[0] !== undefined) {
        reportDrizzleIfBanned(getModulePrefixOrStaticString(node.arguments[0]), node)
      }

      const calleeText = node.expression.getText(sourceFile)

      if (!isTestFile && calleeText === "parse" && node.arguments.length >= 2 && node.arguments[0]?.getText(sourceFile) === "Lang.TypeScript" && handlesTsxExtensions && !referencesLangTsx) {
        pushViolation(catSyntaxBans, "ast-grep-tsx-grammar", `Hardcoded parse(Lang.TypeScript, ...) in '${filePath}' which handles .tsx files — select Lang.Tsx for .tsx files so JSX syntax parses cleanly.`, node)
      }

      const unwrappedExpr = unwrapAstExpression(node.expression)
      if (!isTestFile && ts.isPropertyAccessExpression(unwrappedExpr) && unwrappedExpr.name.text === "run" && /\bmatch\s*\(/.test(unwrappedExpr.expression.getText(sourceFile))) {
        pushViolation(catEffectLaws, "non-exhaustive-union-match", `match(...).run() in '${filePath}' is banned — use .exhaustive() instead.`, node)
      }

      const isCatchCauseOnly = !isTestFile && isCatchCauseInterruptsOnlyCall(node, sourceFile)
      if (isCatchCauseOnly) {
        pushViolation(
          catEffectLaws,
          "catch-cause-interrupts-only",
          "Cause.hasInterruptsOnly(cause) inside Effect.catchCause / Exit inspection swallows fiber interruption on composite causes (Fail + Interrupt). Use isPureInterruptCause(cause) or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause) instead.",
          node,
        )
      }

      if (
        !isCatchCauseOnly &&
        !isTestOrHelperFile &&
        /(?:^|\/)src\//.test(normalizedFilePath) &&
        isBareCauseHasInterruptsNode(node, sourceFile, normalizedFilePath)
      ) {
        pushViolation(
          catEffectLaws,
          "bare-cause-has-interrupts",
          "Bare Cause.hasInterrupts(cause) or Cause.hasInterruptsOnly(cause) in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause(cause) from @harness/contract (or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)).",
          node,
        )
      }

      if (!isTestFile && isSilentCatchDefectCall(node, sourceFile)) {
        pushViolation(catEffectLaws, "silent-catch-defect", `Effect.catchDefect handler in '${filePath}' silently swallows runtime defects without logging or reporting — log via Effect.logWarning / process.stderr.write or re-fail.`, node)
      }

      if (!isTestFile && isIgnoredChmodPermissionCall(node, sourceFile)) {
        pushViolation(catSyntaxBans, "ignored-chmod-permission", `Ignoring chmodSync/fchmodSync failure with Effect.ignore or Effect.orElseSucceed in '${filePath}' is banned — permission hardening must fail closed on error.`, node)
      }

      if (isGatesSrcFile && isSilentGateFsFallbackAstCall(node, sourceFile)) pushViolation(catSyntaxBans, "silent-gate-fs-fallback", `Silent filesystem fallback in '${filePath}' is banned — emit an explicit 'unreadable-workspace-file' finding instead of returning "", [], {}, undefined, or false.`, node)
      if (isContractSrcFile && isAllOptionalSchemaStructCall(node)) pushViolation(catSyntaxBans, "all-optional-contract-struct", `Schema.Struct with all Schema.optional(...) fields in '${filePath}' is banned — require canonical non-optional contract fields.`, node)
      if (isTestFile && isVacuousLengthNonNegativeAssertion(node)) pushViolation(catTestIntegrity, "vacuous-length-nonnegative-assertion", `Vacuous 'expect(...length).toBeGreaterThanOrEqual(0)' assertion in '${filePath}' is always true — assert exact length or element contents.`, node)

      if (isTestFile && (calleeText === "saveGraphSnapshot" || calleeText === "saveGraphSnapshotEffect" || calleeText === "writeFileSync" || calleeText === "fs.writeFileSync")) {
        if (node.arguments.some((arg) => /["'`]\.harness\//.test(arg.getText(sourceFile)))) {
          pushViolation(catTestIntegrity, "unisolated-dot-harness-test-write", "Test files must not write directly to live .harness/ paths — use os.tmpdir() / fs.mkdtempSync for isolated snapshot and file tests.", node)
        }
      }

      if (isTestFile && calleeText.startsWith("expect(") && /expect\s*\(\s*Exit\.isFailure\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\)/.test(node.expression.getText(sourceFile))) {
        const fullSourceText = sourceFile.text
        if (!fullSourceText.includes("Cause.findErrorOption") && !fullSourceText.includes(".cause")) {
          pushViolation(catTestIntegrity, "vacuous-error-assertion", `Vacuous Exit.isFailure assertion in '${filePath}' without inspecting Cause.findErrorOption or error fields.`, node)
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      !isTestOrHelperFile &&
      /(?:^|\/)src\//.test(normalizedFilePath) &&
      isBareCauseHasInterruptsNode(node, sourceFile, normalizedFilePath)
    ) {
      pushViolation(
        catEffectLaws,
        "bare-cause-has-interrupts",
        "Point-free Cause.hasInterrupts or Cause.hasInterruptsOnly in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause from @harness/contract instead.",
        node,
      )
    }

    // 6. BinaryExpression: JSON.stringify(a) === JSON.stringify(b) in tests
    if (ts.isBinaryExpression(node) && isTestFile) {
      match(node.operatorToken.kind)
        .with(P.union(ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken), () => {
          const leftText = node.left.getText(sourceFile)
          const rightText = node.right.getText(sourceFile)
          if (leftText.startsWith("JSON.stringify(") && rightText.startsWith("JSON.stringify(")) {
            pushViolation(catTestIntegrity, "fallback-json-equality", `Fallback JSON.stringify equality comparison in '${filePath}' — use structured equality or Equal.equals.`, node)
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
          if (packageTag === "infra" && (!hasMigratorImport || !isInsideMigrationsRecord(node, sourceFile))) {
            pushViolation(catMigrationSafety, "unmanaged-sql-ddl", `Raw SQL DDL in '${filePath}' outside SqliteMigrator.fromRecord migration record.`, node)
          }
          const safety = checkMigrationSqlSafety([{ file: filePath, sql: templateText }])
          for (const v of safety.violations) {
            pushViolation(catMigrationSafety, "unsafe-sql-migration", v.message, node)
          }
        }
      }
    }

    if (isClefEndpointCheckedSrcFile && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
      const literalText = ts.isTemplateExpression(node) ? `${node.head.text}${node.templateSpans.map((s) => s.literal.text).join("")}` : node.text
      if (isInvalidClefEndpointUrlText(literalText)) {
        pushViolation(catSyntaxBans, "invalid-clef-endpoint", INVALID_CLEF_ENDPOINT_MESSAGE, node)
      }
    }

    if (isTestFile && isConditionalPortBindBailout(node)) pushViolation(catTestIntegrity, "conditional-port-bind-bailout", `Conditional port-bind bailout ('if (!bound) return') in '${filePath}' silently skips test assertions.`, node)
    if (!isTestOrHelperFile && /(?:^|\/)(?:libs|apps)\/.*\/src\//.test(normalizedFilePath) && isDiscardedPersistenceCallStatement(node)) pushViolation(catSyntaxBans, "discarded-persistence-result", `Discarded persistence call result in '${filePath}' is banned — inspect or propagate the returned Result/Effect.`, node)
    ts.forEachChild(node, walk)
  }

  walk(sourceFile)

  if (sourceFile.text.includes("fromRecord")) {
    const migratorAnalysis = analyzeSqliteMigratorFromRecordAst({ filePath: normalizedFilePath, content: sourceFile.text })
    for (const issue of migratorAnalysis.keyIssues) {
      violations.push({ category: catMigrationSafety, rule: GateRuleId.make("invalid-migrator-record-key"), message: GateViolationMessage.make(issue.message), file: filePath, line: SourceLineNumber.make(issue.line), enclosingSymbol: EnclosingSymbolName.make(filePath) })
    }
    const existingUnsafeLines = new Set(violations.filter((v) => v.rule === "unsafe-sql-migration").map((v) => v.line))
    for (const issue of migratorAnalysis.unsafeSqlIssues) {
      const lineNum = SourceLineNumber.make(issue.line)
      if (!existingUnsafeLines.has(lineNum)) {
        existingUnsafeLines.add(lineNum)
        violations.push({ category: catMigrationSafety, rule: GateRuleId.make("unsafe-sql-migration"), message: GateViolationMessage.make(issue.message), file: filePath, line: lineNum, enclosingSymbol: EnclosingSymbolName.make(filePath) })
      }
    }
  }

  return violations
}
