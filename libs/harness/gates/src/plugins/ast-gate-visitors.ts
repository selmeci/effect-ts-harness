/**
 * @file ast-gate-visitors.ts
 * Single-pass AST visitor and leaf gate schema definitions across syntax-bans,
 * test-integrity, migration-safety, domain-purity, and effect-laws.
 */

import { Schema } from "effect"
import { match } from "ts-pattern"
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
import {
  DOT_HARNESS_WRITE_CALLEES,
  getCalleeTerminalName,
  hasUnisolatedDotHarnessArgExpr,
  isAllOptionalSchemaStructCall,
  isBareCauseHasInterruptsNode,
  isCatchCauseInterruptsOnlyCall,
  isConditionalPortBindBailout,
  isDiscardedPersistenceCallStatement,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isProcessCwdDotHarnessJoinOrResolve,
  isSilentCatchDefectCall,
  isSilentFsFallbackCheckedPath,
  isSilentGateFsFallbackCall,
  isVacuousLengthNonNegativeAssertion,
} from "./ast-gate-law-helpers.js"
import { analyzeSqliteMigratorFromRecordAst } from "./sqlite-migrator-ast.js"
import { collectWorkflowBodyViolations } from "./workflow-body-ast.js"
import {
  isSilentDecodeOrStoreFallback,
  isUntypedCatchCauseWithoutInterruptGuard,
} from "./ast-fail-closed-laws.js"
import {
  collectContractShapeViolations,
  collectMaxTestCaseLineViolations,
  collectMaxTestFileLineViolations,
  collectMaxTestsPerFileViolations,
  collectWorkflowNameAccessViolations,
} from "./ast-contract-and-test-hygiene.js"

export {
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isSilentCatchDefectCall,
}

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

const CLEF_MSG =
  "[invalid-clef-endpoint] System One models (clef-flash) only expose POST /v1/systemone (and GET /v1/models or GET /api/tags). Never call /api/generate, /api/chat, or /v1/chat/completions — use DecisionModel.decide (@effect/ai-typesafe) per agent-patterns/decision-model.md."

const isBadClefUrl = (text: string): boolean =>
  /11434\/(?:api\/(?:generate|chat)|v1\/(?:chat\/completions|completions))\b/i.test(text) ||
  (/(?:11434|\bclef(?:-flash)?\b)/i.test(text) && /\/api\/(?:generate|chat)\b/i.test(text))

export const SCHEMA_CTORS = new Set(
  "Struct Class TaggedClass TaggedStruct TaggedUnion Union Record Array Tuple String Number Boolean Int Natural NonEmptyString FiniteFromString".split(
    " ",
  ),
)

export const IMPURE_DOMAIN_MODULES = new Set(
  "node:fs fs node:http http node:https https node:net net node:child_process child_process drizzle-orm drizzle-kit alchemy".split(
    " ",
  ),
)

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

export const getLineNumber = (sf: ts.SourceFile, pos: number): SourceLineNumber =>
  SourceLineNumber.make(sf.getLineAndCharacterOfPosition(Math.max(0, pos)).line + 1)

export const resolveEnclosingSymbol = (node: ts.Node, filePath: string): EnclosingSymbolName => {
  for (let c: ts.Node | undefined = node; c !== undefined; c = c.parent) {
    if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name))
      return EnclosingSymbolName.make(`${filePath}#${c.name.text}`)
    if ((ts.isFunctionDeclaration(c) || ts.isClassDeclaration(c)) && c.name !== undefined)
      return EnclosingSymbolName.make(`${filePath}#${c.name.text}`)
  }
  return EnclosingSymbolName.make(filePath)
}

export const unwrapAstExpression = (expr: ts.Expression): ts.Expression => {
  let c = expr
  while (
    ts.isParenthesizedExpression(c) ||
    ts.isAsExpression(c) ||
    ts.isTypeAssertionExpression(c) ||
    ts.isSatisfiesExpression(c) ||
    ts.isNonNullExpression(c)
  ) {
    c = c.expression
  }
  return c
}

const staticText = (expr: ts.Expression): string | undefined => {
  const u = unwrapAstExpression(expr)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
}

const modPrefixOrStr = (expr: ts.Expression): string | undefined => {
  const s = staticText(expr)
  if (s !== undefined) return s
  const u = unwrapAstExpression(expr)
  return ts.isTemplateExpression(u) ? u.head.text : undefined
}

const isEffectRunSyncOfDie = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  isEffNs: (expr: ts.Expression) => boolean,
): boolean => {
  const name = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : staticText(node.argumentExpression)
  const p = node.parent
  if (name !== "runSync" || p === undefined || !ts.isCallExpression(p)) return false
  if (p.expression !== node || p.arguments[0] === undefined) return false
  const u = unwrapAstExpression(p.arguments[0])
  return (
    ts.isCallExpression(u) &&
    ts.isPropertyAccessExpression(u.expression) &&
    isEffNs(u.expression.expression) &&
    u.expression.name.text === "die"
  )
}

const isInsideMigrationsRecord = (node: ts.Node, sf: ts.SourceFile): boolean => {
  for (let c: ts.Node | undefined = node.parent; c !== undefined; c = c.parent) {
    if (ts.isCallExpression(c) && c.expression.getText(sf).endsWith("fromRecord")) return true
    if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && /migrations/i.test(c.name.text))
      return true
  }
  return false
}

const TAG_GUARD_RE =
  /\b(?:Option\.isSome|Option\.isNone|Either\.isRight|Either\.isLeft|Result\.isSuccess|Result\.isFailure|Exit\.isSuccess|Exit\.isFailure|Cause\.isFailType|Cause\.isDieType|Cause\.isInterruptType|Cause\.isEmptyType|Predicate\.isTagged)\s*\(/
const DISC_RE = /\.(?:_tag|kind|status)\s*(?:===|!==|==|!=)\s*["'`]/
const isTagGuard = (c: ts.Expression, sf: ts.SourceFile): boolean =>
  TAG_GUARD_RE.test(c.getText(sf))
const isDiscCond = (c: ts.Expression, sf: ts.SourceFile): boolean =>
  isTagGuard(c, sf) || DISC_RE.test(c.getText(sf))

const catSyntax = GateCategory.make("syntax-bans")
const catTest = GateCategory.make("test-integrity")
const catMig = GateCategory.make("migration-safety")
const catDom = GateCategory.make("domain-purity")
const catEff = GateCategory.make("effect-laws")
const BANNED_RUN = new Set(
  "runSync runSyncExit runSyncWith runCallback runCallbackWith runPromise runPromiseWith".split(
    " ",
  ),
)

export const visitSourceFileSinglePass = (
  sourceFile: ts.SourceFile,
  filePathOrRelPath: string | AstSourceFilePath,
  packageTagParam?: AstGatePackageTag,
): ReadonlyArray<GateViolation> => {
  const fp = AstSourceFilePath.make(String(filePathOrRelPath))
  const norm = fp.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")
  const pkg = packageTagParam ?? inferAstGatePackageTagFromPath(norm)
  const violations: Array<GateViolation> = []
  const isTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(norm)
  const isTestOrHelper = isTest || /(?:^|\/)test\/(?!fixtures\/)/.test(norm)
  const isGatesSrc = !isTest && isSilentFsFallbackCheckedPath(norm)
  const isContractSrc = !isTest && /(?:^|\/)libs\/[^/]+\/contract\/src\//.test(norm)
  const isClefSrc =
    !isTest &&
    /(?:^|\/)src\//.test(norm) &&
    !/(?:^|\/)(?:triage-decision|policy|ast-gate-visitors)\.ts$/.test(norm)
  const isMemBridge = /(?:^|\/)libs\/es\/infra\/src\/memory\.ts$/.test(norm)
  const isMcpBoundary =
    /(?:^|\/)apps\/harness-mcp\/src\/(?:server|daemon\/unix-socket-daemon)\.ts$/.test(norm)
  const isProdSrc = !isTestOrHelper && /(?:^|\/)src\//.test(norm)

  const hasMigrator = sourceFile.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      (/(?:Sqlite)?Migrator/.test(s.moduleSpecifier.text) ||
        /\b(?:SqliteMigrator|Migrator)\b/.test(s.importClause?.getText(sourceFile) ?? "")),
  )

  const pushViolation = (cat: GateCategory, rule: string, msg: string, node: ts.Node): void => {
    violations.push({
      category: cat,
      rule: GateRuleId.make(rule),
      message: GateViolationMessage.make(msg),
      file: fp,
      line: getLineNumber(sourceFile, node.getStart(sourceFile)),
      enclosingSymbol: resolveEnclosingSymbol(node, fp),
    })
  }
  const mUnscoped = (l: string): string => `Unscoped '${l}' in '${fp}' (${pkg}) — run at edge.`
  const mCause = (l: string): string => `${l} in src/ misclassifies composite Interrupts.`
  const mDriz = (s: string): string => `Drizzle '${s}' in '${fp}' is banned — use @effect/sql.`
  const mImp = (s: string): string => `Module '${fp}' (${pkg}) imports impure '${s}'.`
  const mDisc = (k: string): string => `${k} in '${fp}' inspects tag — use match().exhaustive().`
  const mSq = (s: string): string => `Do not import '${s}' in '${fp}' — use workerd storage.`

  const hasTsx = sourceFile.text.includes('".tsx"') || sourceFile.text.includes("'.tsx'")
  const hasLangTsx = sourceFile.text.includes("Lang.Tsx")
  const effModNs = new Set<string>()
  const effNs = new Set<string>(["Effect"])
  const runAliases = new Map<string, string>()

  const isEffNs = (expr: ts.Expression): boolean => {
    const u = unwrapAstExpression(expr)
    if (ts.isIdentifier(u)) return effNs.has(u.text)
    const isAcc = ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)
    if (!isAcc) return false
    const mem = ts.isPropertyAccessExpression(u) ? u.name.text : staticText(u.argumentExpression)
    if (mem !== "Effect") return false
    const inner = unwrapAstExpression(u.expression)
    return ts.isIdentifier(inner) && effModNs.has(inner.text)
  }

  const propNameOf = (el: ts.BindingElement): string | undefined => {
    const pn = el.propertyName
    if (pn === undefined) return ts.isIdentifier(el.name) ? el.name.text : undefined
    if (ts.isIdentifier(pn) || ts.isStringLiteral(pn) || ts.isNoSubstitutionTemplateLiteral(pn))
      return pn.text
    return ts.isComputedPropertyName(pn) ? staticText(pn.expression) : undefined
  }

  const isBannedRun = (m: string): boolean =>
    BANNED_RUN.has(m) ||
    (m === "runPromiseExit" && !isMcpBoundary) ||
    ((m === "runFork" || m === "runForkWith") && pkg !== "app")

  const reportDrizzle = (spec: string | undefined, node: ts.Node): void => {
    if (spec === undefined || !isDrizzleSpecifier(spec)) return
    if (pkg === "domain" && !isTest) {
      pushViolation(catDom, "impure-domain-import", mImp(spec), node)
      return
    }
    const c = isTest ? catTest : catSyntax
    pushViolation(c, "banned-drizzle-import", mDriz(spec), node)
  }

  const recAliases = (pat: ts.ObjectBindingPattern): void => {
    for (const el of pat.elements) {
      const p = propNameOf(el)
      if (p !== undefined && isBannedRun(p) && ts.isIdentifier(el.name))
        runAliases.set(el.name.text, p)
    }
  }

  const checkImport = (node: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return
    const spec = node.moduleSpecifier.text
    if (!node.importClause?.isTypeOnly && (spec === "effect" || spec === "effect/Effect")) {
      const b = node.importClause?.namedBindings
      if (b !== undefined && ts.isNamespaceImport(b)) {
        ;(spec === "effect" ? effModNs : effNs).add(b.name.text)
      }
      if (b !== undefined && ts.isNamedImports(b)) {
        for (const el of b.elements) {
          if (el.isTypeOnly) continue
          const imp = (el.propertyName ?? el.name).text
          if (spec === "effect" && imp === "Effect") effNs.add(el.name.text)
          if (spec === "effect/Effect" && !isTestOrHelper && isBannedRun(imp)) {
            const m = mUnscoped(`Effect.${imp}`)
            pushViolation(catDom, "unscoped-effect-run", m, node)
          }
        }
      }
    }
    const isSq = spec === "node:sqlite" || spec === "sqlite" || spec === "better-sqlite3"
    if (isSq && (pkg === "infra" || pkg === "app")) {
      pushViolation(isTest ? catTest : catSyntax, "node-sqlite-in-infra", mSq(spec), node)
    }
    reportDrizzle(spec, node)
    const impDom = (pkg === "domain" || pkg === "contract") && isImpureDomainSpecifier(spec)
    if (!isTest && !isDrizzleSpecifier(spec) && impDom) {
      pushViolation(catDom, "impure-domain-import", mImp(spec), node)
    }
  }

  const checkVar = (node: ts.VariableDeclaration): void => {
    if (isTestOrHelper || node.initializer === undefined) return
    const init = unwrapAstExpression(node.initializer)
    if (isEffNs(init)) {
      if (ts.isIdentifier(node.name)) effNs.add(node.name.text)
      if (ts.isObjectBindingPattern(node.name)) recAliases(node.name)
      return
    }
    if (ts.isIdentifier(init) && effModNs.has(init.text) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        if (propNameOf(el) !== "Effect") continue
        if (ts.isIdentifier(el.name)) effNs.add(el.name.text)
        if (ts.isObjectBindingPattern(el.name)) recAliases(el.name)
      }
    }
  }

  const checkCall = (node: ts.CallExpression): void => {
    const expr = node.expression
    const isDyn = expr.kind === ts.SyntaxKind.ImportKeyword
    const isReq =
      (ts.isIdentifier(expr) && expr.text === "require") ||
      (ts.isPropertyAccessExpression(expr) && expr.name.text === "require")
    if ((isDyn || isReq) && node.arguments[0] !== undefined) {
      reportDrizzle(modPrefixOrStr(node.arguments[0]), node)
    }
    const ct = expr.getText(sourceFile)
    const a0 = node.arguments[0]
    if (
      !isTest &&
      ct === "parse" &&
      a0?.getText(sourceFile) === "Lang.TypeScript" &&
      hasTsx &&
      !hasLangTsx
    ) {
      const m = `Hardcoded parse(Lang.TypeScript) in '${fp}' with .tsx — use Lang.Tsx.`
      pushViolation(catSyntax, "ast-grep-tsx-grammar", m, node)
    }
    const ue = unwrapAstExpression(expr)
    if (
      !isTest &&
      ts.isPropertyAccessExpression(ue) &&
      ue.name.text === "run" &&
      /\bmatch\s*\(/.test(ue.expression.getText(sourceFile))
    ) {
      const m = `match(...).run() in '${fp}' is banned — use .exhaustive().`
      pushViolation(catEff, "non-exhaustive-union-match", m, node)
    }
    const catchOnly = !isTest && isCatchCauseInterruptsOnlyCall(node, sourceFile)
    if (catchOnly) {
      const m = "Cause.hasInterruptsOnly swallows Fail+Interrupt — use isPureInterruptCause."
      pushViolation(catEff, "catch-cause-interrupts-only", m, node)
    }
    if (!catchOnly && isProdSrc && isBareCauseHasInterruptsNode(node, sourceFile, norm)) {
      const m = mCause("Bare Cause.hasInterrupts/hasInterruptsOnly")
      pushViolation(catEff, "bare-cause-has-interrupts", m, node)
    }
    if (!isTest && isSilentCatchDefectCall(node, sourceFile)) {
      const m = `Silent Effect.catchDefect in '${fp}' — log or re-fail.`
      pushViolation(catEff, "silent-catch-defect", m, node)
    }
    if (isProdSrc && isUntypedCatchCauseWithoutInterruptGuard(node, sourceFile)) {
      const m = `Effect.catchCause in '${fp}' must guard isPureInterruptCause(cause).`
      pushViolation(catEff, "untyped-catch-cause-interrupt-leak", m, node)
    }
    if (isProdSrc && isSilentDecodeOrStoreFallback(node, sourceFile)) {
      const m = `Silent decode/workflow-store fallback in '${fp}' is banned — propagate typed failure.`
      pushViolation(catEff, "silent-decode-fallback", m, node)
    }
    if (!isTest && isIgnoredChmodPermissionCall(node, sourceFile)) {
      const m = `Ignoring chmodSync/fchmodSync failure in '${fp}' is banned.`
      pushViolation(catSyntax, "ignored-chmod-permission", m, node)
    }
    if (isGatesSrc && isSilentGateFsFallbackCall(node, sourceFile)) {
      const m = `Silent fs fallback in '${fp}' — emit unreadable-workspace-file.`
      pushViolation(catSyntax, "silent-gate-fs-fallback", m, node)
    }
    if (isContractSrc && isAllOptionalSchemaStructCall(node)) {
      const m = `All-optional Schema.Struct in '${fp}' is banned.`
      pushViolation(catSyntax, "all-optional-contract-struct", m, node)
    }
    if (isTest && isVacuousLengthNonNegativeAssertion(node)) {
      const m = `Vacuous length >= 0 assertion in '${fp}'.`
      pushViolation(catTest, "vacuous-length-nonnegative-assertion", m, node)
    }
    const tn = getCalleeTerminalName(expr)
    const badHarness =
      (tn !== undefined &&
        DOT_HARNESS_WRITE_CALLEES.has(tn) &&
        node.arguments.some((a) => hasUnisolatedDotHarnessArgExpr(a, sourceFile))) ||
      isProcessCwdDotHarnessJoinOrResolve(node, sourceFile)
    if (isTest && badHarness) {
      const m = "Tests must not write to live .harness/ paths — use os.tmpdir()."
      pushViolation(catTest, "unisolated-dot-harness-test-write", m, node)
    }
    const vacErr =
      isTest &&
      /expect\s*\(\s*Exit\.isFailure\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\)/.test(ct) &&
      !sourceFile.text.includes("Cause.findErrorOption") &&
      !sourceFile.text.includes(".cause")
    if (vacErr) {
      const m = `Vacuous Exit.isFailure assertion in '${fp}' without error inspection.`
      pushViolation(catTest, "vacuous-error-assertion", m, node)
    }
  }

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) checkImport(node)
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      reportDrizzle(node.moduleSpecifier.text, node)
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      reportDrizzle(node.moduleReference.expression.text, node)
    }
    if (ts.isSwitchStatement(node) && !isTest) {
      const m = `Switch in '${fp}' is banned — use match(...).exhaustive().`
      pushViolation(catSyntax, "discriminant-branching", m, node)
    }
    if (
      ts.isYieldExpression(node) &&
      !isTest &&
      node.expression &&
      isDummyEffectVoidYield(node.expression, sourceFile)
    ) {
      const m = `Dummy 'yield* Effect.void' in '${fp}' is banned.`
      pushViolation(catEff, "effect-fn-dummy-void", m, node)
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      let inner: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression
      match(node.type.kind)
        .with(ts.SyntaxKind.AnyKeyword, () =>
          pushViolation(catSyntax, "unsafe-type-cast", `Unsafe 'as any' in '${fp}'.`, node),
        )
        .with(ts.SyntaxKind.NeverKeyword, () =>
          pushViolation(catSyntax, "unsafe-type-cast", `Unsafe 'as never' in '${fp}'.`, node),
        )
        .otherwise(() => {
          const isDbl =
            (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
            inner.type.kind === ts.SyntaxKind.UnknownKeyword
          if (isDbl) pushViolation(catSyntax, "unsafe-type-cast", `Double cast in '${fp}'.`, node)
        })
    }
    if (ts.isIfStatement(node) && !isTest && isDiscCond(node.expression, sourceFile)) {
      pushViolation(catEff, "discriminant-branching", mDisc("If statement"), node)
    }
    if (
      ts.isConditionalExpression(node) &&
      !isTest &&
      (isTagGuard(node.condition, sourceFile) || isDiscCond(node.condition, sourceFile))
    ) {
      pushViolation(catEff, "discriminant-branching", mDisc("Ternary expression"), node)
    }
    if (ts.isVariableDeclaration(node)) checkVar(node)
    if (ts.isPropertyAccessExpression(node) && !isTest) {
      if (pkg === "domain" && isEffNs(node.expression) && node.name.text === "ignore") {
        const m = `Swallowing typed errors with Effect.ignore in '${fp}' is banned.`
        pushViolation(catDom, "domain-effect-ignore", m, node)
      }
      const runDie = isMemBridge && isEffectRunSyncOfDie(node, isEffNs)
      if (!isTestOrHelper && !runDie && isEffNs(node.expression) && isBannedRun(node.name.text)) {
        const m = mUnscoped(`${node.expression.getText(sourceFile)}.${node.name.text}`)
        pushViolation(catDom, "unscoped-effect-run", m, node)
      }
      if (isProdSrc && isBareCauseHasInterruptsNode(node, sourceFile, norm)) {
        const m = mCause("Point-free Cause.hasInterrupts/hasInterruptsOnly")
        pushViolation(catEff, "bare-cause-has-interrupts", m, node)
      }
    }
    if (ts.isElementAccessExpression(node) && !isTestOrHelper) {
      const mName = staticText(node.argumentExpression)
      const runDie = isMemBridge && isEffectRunSyncOfDie(node, isEffNs)
      if (mName !== undefined && isBannedRun(mName) && !runDie) {
        const m = mUnscoped(`${node.expression.getText(sourceFile)}["${mName}"]`)
        pushViolation(catDom, "unscoped-effect-run", m, node)
      }
    }
    const isAliasRef =
      ts.isIdentifier(node) &&
      !isTestOrHelper &&
      runAliases.has(node.text) &&
      !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    if (isAliasRef) {
      const m = mUnscoped(`Effect.${runAliases.get(node.text)!} alias '${node.text}'`)
      pushViolation(catDom, "unscoped-effect-run", m, node)
    }
    if (ts.isCallExpression(node)) checkCall(node)
    if (
      isProdSrc &&
      ts.isBinaryExpression(node) &&
      isSilentDecodeOrStoreFallback(node, sourceFile)
    ) {
      const m = `Nullish fallback on Schema.decodeOption in '${fp}' is banned — match Option explicitly.`
      pushViolation(catEff, "silent-decode-fallback", m, node)
    }
    const isEq =
      ts.isBinaryExpression(node) &&
      isTest &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    if (
      isEq &&
      node.left.getText(sourceFile).startsWith("JSON.stringify(") &&
      node.right.getText(sourceFile).startsWith("JSON.stringify(")
    ) {
      const m = `Fallback JSON.stringify equality in '${fp}' — use Equal.equals.`
      pushViolation(catTest, "fallback-json-equality", m, node)
    }
    if (!isTestOrHelper && ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(sourceFile)
      if (tag === "sql" || tag.endsWith(".sql")) {
        const sql = node.template.getText(sourceFile).slice(1, -1)
        if (SUSPICIOUS_SQL_DDL_REGEX.test(sql)) {
          if (pkg === "infra" && (!hasMigrator || !isInsideMigrationsRecord(node, sourceFile))) {
            const m = `Raw SQL DDL in '${fp}' outside SqliteMigrator.fromRecord.`
            pushViolation(catMig, "unmanaged-sql-ddl", m, node)
          }
          for (const v of checkMigrationSqlSafety([{ file: fp, sql }]).violations) {
            pushViolation(catMig, "unsafe-sql-migration", v.message, node)
          }
        }
      }
    }
    if (
      isClefSrc &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node))
    ) {
      const lit = ts.isTemplateExpression(node)
        ? `${node.head.text}${node.templateSpans.map((s) => s.literal.text).join("")}`
        : node.text
      if (isBadClefUrl(lit)) pushViolation(catSyntax, "invalid-clef-endpoint", CLEF_MSG, node)
    }
    if (isTest && isConditionalPortBindBailout(node)) {
      const m = `Conditional port-bind bailout in '${fp}' silently skips assertions.`
      pushViolation(catTest, "conditional-port-bind-bailout", m, node)
    }
    if (
      !isTestOrHelper &&
      /(?:^|\/)(?:libs|apps)\/.*\/src\//.test(norm) &&
      isDiscardedPersistenceCallStatement(node)
    ) {
      const m = `Discarded persistence result in '${fp}' is banned.`
      pushViolation(catSyntax, "discarded-persistence-result", m, node)
    }
    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  if (isContractSrc) {
    for (const v of collectContractShapeViolations(sourceFile, norm)) {
      pushViolation(catSyntax, "contract-shape-hardening", v.message, v.node)
    }
  }
  for (const v of collectWorkflowNameAccessViolations(sourceFile, norm)) {
    pushViolation(catSyntax, "workflow-name-instead-of-tag", v.message, v.node)
  }
  if (isTest) {
    for (const v of collectMaxTestCaseLineViolations(sourceFile, norm)) {
      pushViolation(catTest, "max-test-case-lines", v.message, v.node)
    }
    for (const v of collectMaxTestFileLineViolations(sourceFile, norm)) {
      pushViolation(catTest, "max-test-file-lines", v.message, v.node)
    }
    for (const v of collectMaxTestsPerFileViolations(sourceFile, norm)) {
      pushViolation(catTest, "max-tests-per-file", v.message, v.node)
    }
  }
  if (!isTestOrHelper && /(?:^|\/)(?:libs|apps)\/.*\/src\//.test(norm)) {
    for (const v of collectWorkflowBodyViolations(sourceFile, norm)) {
      pushViolation(catSyntax, "nondeterministic-workflow-body", v.message, v.node)
    }
  }
  if (sourceFile.text.includes("fromRecord")) {
    const migrator = analyzeSqliteMigratorFromRecordAst({
      filePath: norm,
      content: sourceFile.text,
    })
    const pushMig = (
      rule: string,
      issue: { readonly line: number; readonly message: string },
    ): void => {
      violations.push({
        category: catMig,
        rule: GateRuleId.make(rule),
        message: GateViolationMessage.make(issue.message),
        file: fp,
        line: SourceLineNumber.make(issue.line),
        enclosingSymbol: EnclosingSymbolName.make(fp),
      })
    }
    for (const issue of migrator.keyIssues) pushMig("invalid-migrator-record-key", issue)
    const seen = new Set(
      violations.filter((v) => v.rule === "unsafe-sql-migration").map((v) => v.line),
    )
    for (const issue of migrator.unsafeSqlIssues) {
      const ln = SourceLineNumber.make(issue.line)
      if (!seen.has(ln)) {
        seen.add(ln)
        pushMig("unsafe-sql-migration", issue)
      }
    }
  }
  return violations
}
