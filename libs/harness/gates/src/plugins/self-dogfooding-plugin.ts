import { Effect } from "effect"
import {
  computeWorkspaceFileLineCount,
  DEFAULT_MAX_PLUGIN_FILE_LINES,
  EnclosingSymbolName,
  makeSelfDogfoodingReport,
  SelfDogfoodingMessage,
  type SelfDogfoodingReport,
  SelfDogfoodingRuleId,
  type SelfDogfoodingViolation,
  SelfDogfoodingViolationError,
  SourceLineNumber,
} from "@harness/contract"
import { NonNegativeCount, ts } from "@harness/graph"
import {
  getLineNumber,
  getOrCreateCachedSourceFile,
  isCatchCauseInterruptsOnlyCall,
  isDummyEffectVoidYield,
  isIgnoredChmodPermissionCall,
  isSilentCatchDefectCall,
  resolveEnclosingSymbol,
  unwrapAstExpression,
} from "../ast-cache.js"
import {
  getMutatedStaticObjectName,
  isBannedNodeBuiltinSpecifier,
  isBannedParentConstructor,
  isBareCauseHasInterruptsNode,
  isDoubleWrappedEffectFn,
  isLiteralVitestKey,
  isMemberCall,
  isProcessEnvDestructuring,
  isProcessEnvExpression,
  isPureTierProcessEnvBannedPath,
} from "./ast-gate-law-helpers.js"
import { type SelfDogfoodingInput } from "./self-dogfooding-contract.js"

const isExcludedProductionPath = (normPath: string): boolean =>
  normPath.endsWith(".test.ts") ||
  normPath.endsWith(".test.tsx") ||
  normPath.endsWith(".spec.ts") ||
  normPath.endsWith(".spec.tsx") ||
  normPath.endsWith(".d.ts") ||
  normPath.endsWith(".d.tsx") ||
  normPath.endsWith(".config.ts") ||
  /(?:^|\/)(?:test|dist|node_modules|repos)\//.test(normPath)

export const isModularPluginPath = (filePath: string): boolean => {
  const norm = filePath.replace(/\\/g, "/")
  const repoMatch = /(?:^|\/)((?:libs|apps)\/.*\.tsx?)$/.exec(norm)
  if (repoMatch?.[1] !== undefined) {
    return !isExcludedProductionPath(repoMatch[1])
  }
  if (/(?:^|\/)(?:plugins|services|commands|tools|mutation)\/.*\.tsx?$/.test(norm)) {
    return !isExcludedProductionPath(norm)
  }
  return false
}

export const isGraphOrchestratorFacadePath = (filePath: string): boolean => {
  const norm = filePath.replace(/\\/g, "/")
  return /(?:^|\/)libs\/harness\/graph\/src\/(?:type-extractor|datalog-engine|graph-rewrite|graph-engine|graph-projector)\.ts$/.test(
    norm,
  )
}

const resolveTieredMaxLines = (norm: string): number | undefined => {
  if (
    isGraphOrchestratorFacadePath(norm) ||
    /(?:^|\/)apps\/(?:harness-cli\/src\/index|harness-mcp\/src\/server)\.tsx?$/.test(norm)
  ) {
    return 250
  }
  if (/(?:^|\/)libs\/harness\/graph\/src\/extractor\/compiler-session\.tsx?$/.test(norm)) {
    return 700
  }
  if (/(?:^|\/)libs\/harness\/graph\/src\/extractor\/.*\.tsx?$/.test(norm)) {
    return 499
  }
  if (
    /(?:^|\/)apps\/harness-cli\/src\/commands\/.*\.tsx?$/.test(norm) ||
    /(?:^|\/)apps\/harness-mcp\/src\/(?:tools|daemon)\/.*\.tsx?$/.test(norm) ||
    /(?:^|\/)libs\/es\/infra\/src\/.*\.tsx?$/.test(norm)
  ) {
    return 650
  }
  if (/(?:^|\/)libs\/harness\/graph\/src\/engine\/.*\.tsx?$/.test(norm)) {
    return 700
  }
  if (/(?:^|\/)libs\/harness\/graph\/src\/.*\.tsx?$/.test(norm)) {
    return 750
  }
  return undefined
}

/**
 * Resolves the effective maximum line budget for a file path.
 * `fallbackMaxLines` serves as an upper-bound cap via `Math.min(tieredMax, fallback)`
 * so strict callers cannot raise tiered budgets.
 */
export const resolvePathSpecificMaxLines = (
  filePath: string,
  fallbackMaxLines?: number,
): number => {
  const norm = filePath.replace(/\\/g, "/")
  const tieredMax = resolveTieredMaxLines(norm)
  const fallback = fallbackMaxLines ?? DEFAULT_MAX_PLUGIN_FILE_LINES
  return tieredMax !== undefined ? Math.min(tieredMax, fallback) : fallback
}

const COLLECTION_MUTATORS = new Set(["set", "add", "delete", "clear"])

const extractSpecifierText = (node: ts.Expression): string | undefined => {
  const unwrapped = unwrapAstExpression(node)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text
  }
  if (ts.isTemplateExpression(unwrapped)) {
    if (unwrapped.head.text.startsWith("node:")) {
      return unwrapped.head.text
    }
    return `${unwrapped.head.text}${unwrapped.templateSpans.map((s) => s.literal.text).join("")}`
  }
  return undefined
}

const extractCtorIdentifierName = (expr: ts.LeftHandSideExpression): string | undefined => {
  const unwrapped = unwrapAstExpression(expr)
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "globalThis"
  ) {
    return unwrapped.name.text
  }
  return undefined
}

const hasConstAssertion = (expr: ts.Expression): boolean => {
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return ts.isTypeReferenceNode(expr.type) && expr.type.typeName.getText() === "const"
  }
  return false
}

const hasResultTryFsRead = (text: string): boolean =>
  text.includes("Result.try") && /(?:readTextSync|readdirSync|readBytesSync)/.test(text)

const isSilentEmptyFallbackFn = (
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  allowExtendedEmptyLiterals: boolean,
): boolean => {
  const fn = unwrapAstExpression(expr)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let bodyText = fn.body.getText(sourceFile).trim()
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return false
    const only = fn.body.statements[0]
    if (only === undefined || !ts.isReturnStatement(only) || only.expression === undefined) {
      return false
    }
    bodyText = only.expression.getText(sourceFile).trim()
  }
  if (bodyText === '""' || bodyText === "''" || bodyText === "[]") return true
  if (!allowExtendedEmptyLiterals) return false
  return bodyText === "{}" || bodyText === "undefined" || bodyText === "false"
}

const hasFailureTagPattern = (expr: ts.Expression): boolean => {
  const obj = unwrapAstExpression(expr)
  if (!ts.isObjectLiteralExpression(obj)) return false
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const propName =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
    if (propName !== "_tag") continue
    const val = unwrapAstExpression(prop.initializer)
    if (
      (ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) &&
      val.text === "Failure"
    ) {
      return true
    }
  }
  return false
}

const findRootMatchArgText = (
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string | undefined => {
  let curr: ts.Expression = unwrapAstExpression(callExpr.expression)
  while (ts.isPropertyAccessExpression(curr) && ts.isCallExpression(curr.expression)) {
    const innerCall = curr.expression
    const innerCallee = unwrapAstExpression(innerCall.expression)
    if (ts.isIdentifier(innerCallee) && innerCallee.text === "match") {
      return innerCall.arguments[0]?.getText(sourceFile)
    }
    curr = innerCallee
  }
  return undefined
}

const isSilentGateFsFallbackCall = (node: ts.CallExpression, sourceFile: ts.SourceFile): boolean => {
  const unwrappedCallee = unwrapAstExpression(node.expression)
  if (ts.isIdentifier(unwrappedCallee) && unwrappedCallee.text === "safeFs") {
    return true
  }
  const calleeText = unwrappedCallee.getText(sourceFile)
  if (
    calleeText === "Result.getOrElse" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasResultTryFsRead(node.arguments[0].getText(sourceFile)) &&
    isSilentEmptyFallbackFn(node.arguments[1], sourceFile, false)
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(unwrappedCallee) &&
    unwrappedCallee.name.text === "pipe" &&
    hasResultTryFsRead(unwrappedCallee.expression.getText(sourceFile)) &&
    node.arguments.some(
      (arg) =>
        ts.isCallExpression(arg) &&
        unwrapAstExpression(arg.expression).getText(sourceFile) === "Result.getOrElse" &&
        arg.arguments.length === 1 &&
        arg.arguments[0] !== undefined &&
        isSilentEmptyFallbackFn(arg.arguments[0], sourceFile, true),
    )
  ) {
    return true
  }
  if (
    ts.isIdentifier(unwrappedCallee) &&
    unwrappedCallee.text === "pipe" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    hasResultTryFsRead(node.arguments[0].getText(sourceFile)) &&
    node.arguments.slice(1).some(
      (arg) =>
        ts.isCallExpression(arg) &&
        unwrapAstExpression(arg.expression).getText(sourceFile) === "Result.getOrElse" &&
        arg.arguments.length === 1 &&
        arg.arguments[0] !== undefined &&
        isSilentEmptyFallbackFn(arg.arguments[0], sourceFile, true),
    )
  ) {
    return true
  }
  if (
    ts.isPropertyAccessExpression(unwrappedCallee) &&
    unwrappedCallee.name.text === "with" &&
    node.arguments.length >= 2 &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    hasFailureTagPattern(node.arguments[0]) &&
    isSilentEmptyFallbackFn(node.arguments[1], sourceFile, true)
  ) {
    const matchArgText = findRootMatchArgText(node, sourceFile)
    if (matchArgText !== undefined && hasResultTryFsRead(matchArgText)) {
      return true
    }
  }
  return false
}

export const decideSelfDogfooding = Effect.fn("SelfDogfooding.decide")(function* (
  input: SelfDogfoodingInput,
): Effect.fn.Return<SelfDogfoodingReport, SelfDogfoodingViolationError, never> {
  const violations: Array<SelfDogfoodingViolation> = []
  let inspectedCount = 0

  for (const file of input.files) {
    const isTestFile =
      file.filePath.endsWith(".test.ts") ||
      file.filePath.endsWith(".test.tsx") ||
      file.filePath.endsWith(".spec.ts") ||
      file.filePath.endsWith(".spec.tsx")
    if (isTestFile) {
      continue
    }

    inspectedCount += 1

    const lineCount = computeWorkspaceFileLineCount(file.content)
    const fileMaxLines = resolvePathSpecificMaxLines(file.filePath, input.maxPluginFileLines)
    const shouldCheckLineBudget =
      file.isModularPluginFile === true ||
      isModularPluginPath(file.filePath) ||
      (file.isModularPluginFile === undefined && input.maxPluginFileLines !== undefined)

    if (shouldCheckLineBudget && lineCount > fileMaxLines) {
      violations.push({
        rule: SelfDogfoodingRuleId.make("file-line-budget-exceeded"),
        message: SelfDogfoodingMessage.make(
          `File '${file.filePath}' has ${lineCount} lines, exceeding maxPluginFileLines budget of ${fileMaxLines}.`,
        ),
        file: file.filePath,
        line: SourceLineNumber.make(Math.max(1, lineCount)),
        enclosingSymbol: EnclosingSymbolName.make(file.filePath),
      })
    }

    const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)
    const normPath = file.filePath.replace(/\\/g, "/")
    const isInfraSrc = /\/infra\/src\//.test(normPath)
    const isPureProcessEnvBanned = isPureTierProcessEnvBannedPath(normPath)
    const staticCollectionNames = new Set<string>()
    const staticObjectNames = new Set<string>()
    const envAliasNames = new Set<string>()

    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        const isConstOrUsing =
          (stmt.declarationList.flags &
            (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !==
          0
        if (!isConstOrUsing) {
          const declKeyword = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var"
          violations.push({
            rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
            message: SelfDogfoodingMessage.make(
              `Module-level '${declKeyword}' declaration in '${file.filePath}' is banned — avoid global mutable state.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, stmt.getStart(sourceFile)),
            enclosingSymbol: EnclosingSymbolName.make(file.filePath),
          })
        }
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer !== undefined) {
            const init = unwrapAstExpression(decl.initializer)
            if (
              ((ts.isObjectLiteralExpression(init) && init.properties.length === 0) ||
                (ts.isArrayLiteralExpression(init) && init.elements.length === 0)) &&
              !hasConstAssertion(decl.initializer)
            ) {
              violations.push({
                rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
                message: SelfDogfoodingMessage.make(
                  `Empty module-level literal '${ts.isArrayLiteralExpression(init) ? "[]" : "{}"}' in '${file.filePath}' is banned — avoid global mutable caches.`,
                ),
                file: file.filePath,
                line: getLineNumber(sourceFile, decl.getStart(sourceFile)),
                enclosingSymbol: EnclosingSymbolName.make(file.filePath),
              })
            }
            if (
              ts.isObjectLiteralExpression(init) &&
              !hasConstAssertion(decl.initializer) &&
              ts.isIdentifier(decl.name)
            ) {
              staticObjectNames.add(decl.name.text)
            }
            if (ts.isNewExpression(init)) {
              const ctorName = extractCtorIdentifierName(init.expression)
              if (ctorName === "WeakMap" || ctorName === "WeakSet") {
                violations.push({
                  rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
                  message: SelfDogfoodingMessage.make(
                    `Module-level 'new ${ctorName}(...)' in '${file.filePath}' is banned — avoid global mutable caches.`,
                  ),
                  file: file.filePath,
                  line: getLineNumber(sourceFile, decl.getStart(sourceFile)),
                  enclosingSymbol: EnclosingSymbolName.make(file.filePath),
                })
              }
              if (ctorName === "Map" || ctorName === "Set") {
                const argCount = init.arguments?.length ?? 0
                if (argCount === 0) {
                  violations.push({
                    rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
                    message: SelfDogfoodingMessage.make(
                      `Empty module-level 'new ${ctorName}()' in '${file.filePath}' is banned — avoid global mutable caches.`,
                    ),
                    file: file.filePath,
                    line: getLineNumber(sourceFile, decl.getStart(sourceFile)),
                    enclosingSymbol: EnclosingSymbolName.make(file.filePath),
                  })
                }
                if (argCount > 0 && ts.isIdentifier(decl.name)) {
                  staticCollectionNames.add(decl.name.text)
                }
              }
            }
          }
        }
      }

      if (
        !isInfraSrc &&
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        isBannedNodeBuiltinSpecifier(stmt.moduleSpecifier.text)
      ) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("no-node-builtins-outside-infra"),
          message: SelfDogfoodingMessage.make(
            `Node builtin '${stmt.moduleSpecifier.text}' imported/exported in '${file.filePath}' outside infra/src — push I/O behind a service port and implement it in infra.`,
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, stmt.getStart(sourceFile)),
          enclosingSymbol: EnclosingSymbolName.make(file.filePath),
        })
      }
    }

    if (isGraphOrchestratorFacadePath(file.filePath) || /(?:^|\/)(?:libs|apps)\/.*\/src\/index\.ts$/.test(normPath)) {
      for (const stmt of sourceFile.statements) {
        if (ts.isExportDeclaration(stmt) && stmt.exportClause === undefined) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("facade-star-reexport"),
            message: SelfDogfoodingMessage.make(
              `Wildcard 'export *' re-export in '${file.filePath}' is banned — orchestrator facades and package src/index.ts barrels must use explicit named re-exports (export { ... } from "./...") instead of export * from.`,
            ),
            file: file.filePath,
            line: SourceLineNumber.make(
              sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
            ),
            enclosingSymbol: EnclosingSymbolName.make(file.filePath),
          })
        }
      }
    }

    const walk = (node: ts.Node): void => {
      if (ts.isYieldExpression(node)) {
        if (node.expression !== undefined && isDummyEffectVoidYield(node.expression, sourceFile)) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("effect-fn-dummy-void"),
            message: SelfDogfoodingMessage.make(
              `Dummy 'yield* Effect.void' in '${file.filePath}' is banned — use a pure function or Effect.sync(() => ...) instead of a dummy yield.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }
      }

      if (ts.isCallExpression(node)) {
        if (node.arguments.length > 0 && node.arguments[0] !== undefined) {
          const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
          const isRequireCall =
            (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
            (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
          if (isDynamicImport || isRequireCall) {
            const spec = extractSpecifierText(node.arguments[0])
            if (
              spec !== undefined &&
              spec.startsWith("@harness/") &&
              /(?:^|\/)(?:libs|apps)\/.*\/(?:src|test)\//.test(normPath)
            ) {
              violations.push({
                rule: SelfDogfoodingRuleId.make("dynamic-harness-import"),
                message: SelfDogfoodingMessage.make(
                  `Dynamic import/require('${spec}') in '${file.filePath}' is banned because @nx/eslint-plugin enforce-module-boundaries crashes under TS7 when dynamic import("@harness/...") is mixed with static imports — use a top-level static import instead.`,
                ),
                file: file.filePath,
                line: getLineNumber(sourceFile, node.getStart(sourceFile)),
                enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
              })
            }
            if (!isInfraSrc && spec !== undefined && isBannedNodeBuiltinSpecifier(spec)) {
              violations.push({
                rule: SelfDogfoodingRuleId.make("no-node-builtins-outside-infra"),
                message: SelfDogfoodingMessage.make(
                  `Node builtin '${spec}' dynamically imported/required in '${file.filePath}' outside infra/src — push I/O behind a service port and implement it in infra.`,
                ),
                file: file.filePath,
                line: getLineNumber(sourceFile, node.getStart(sourceFile)),
                enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
              })
            }
          }
        }
        const unwrappedNodeExpr = unwrapAstExpression(node.expression)
        if (
          ts.isPropertyAccessExpression(unwrappedNodeExpr) &&
          ts.isIdentifier(unwrappedNodeExpr.expression) &&
          unwrappedNodeExpr.expression.text === "Effect" &&
          (unwrappedNodeExpr.name.text === "runSync" || unwrappedNodeExpr.name.text === "runPromise")
        ) {
          const calleeText = `Effect.${unwrappedNodeExpr.name.text}`
          let curr: ts.Node | undefined = node.parent
          let isNested = false
          while (curr !== undefined) {
            if (ts.isCallExpression(curr) && isBannedParentConstructor(curr)) {
              isNested = true
              break
            }
            curr = curr.parent
          }
          if (isNested) {
            violations.push({
              rule: SelfDogfoodingRuleId.make("nested-effect-run-sync"),
              message: SelfDogfoodingMessage.make(
                `Nested '${calleeText}' inside Effect constructor in '${file.filePath}' is banned — compose Effects directly.`,
              ),
              file: file.filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
            })
          }
        }

        if (
          ts.isPropertyAccessExpression(unwrappedNodeExpr) &&
          unwrappedNodeExpr.name.text === "run" &&
          /\bmatch\s*\(/.test(unwrappedNodeExpr.expression.getText(sourceFile))
        ) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("match-run-statement"),
            message: SelfDogfoodingMessage.make(
              `match(...).run() in '${file.filePath}' is banned — use .exhaustive() instead.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        const isCatchCauseOnly = isCatchCauseInterruptsOnlyCall(node, sourceFile)
        if (isCatchCauseOnly) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("catch-cause-interrupts-only"),
            message: SelfDogfoodingMessage.make(
              "Cause.hasInterruptsOnly(cause) inside Effect.catchCause / Exit inspection swallows fiber interruption on composite causes (Fail + Interrupt). Use isPureInterruptCause(cause) or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause) instead.",
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (
          !isCatchCauseOnly &&
          /(?:^|\/)src\//.test(normPath) &&
          isBareCauseHasInterruptsNode(node, sourceFile, normPath)
        ) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("bare-cause-has-interrupts"),
            message: SelfDogfoodingMessage.make(
              "Bare Cause.hasInterrupts(cause) or Cause.hasInterruptsOnly(cause) in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause(cause) from @harness/contract (or Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)).",
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (isSilentCatchDefectCall(node, sourceFile)) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("silent-catch-defect"),
            message: SelfDogfoodingMessage.make(
              `Effect.catchDefect handler in '${file.filePath}' silently swallows runtime defects without logging or reporting — log via Effect.logWarning / process.stderr.write or re-fail.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (isIgnoredChmodPermissionCall(node, sourceFile)) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("ignored-chmod-permission"),
            message: SelfDogfoodingMessage.make(
              `Ignoring chmodSync/fchmodSync failure with Effect.ignore or Effect.orElseSucceed in '${file.filePath}' is banned — permission hardening must fail closed on error.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (
          staticCollectionNames.size > 0 &&
          ts.isPropertyAccessExpression(unwrappedNodeExpr) &&
          ts.isIdentifier(unwrappedNodeExpr.expression) &&
          staticCollectionNames.has(unwrappedNodeExpr.expression.text) &&
          COLLECTION_MUTATORS.has(unwrappedNodeExpr.name.text)
        ) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
            message: SelfDogfoodingMessage.make(
              `Mutating module-level collection '${unwrappedNodeExpr.expression.text}.${unwrappedNodeExpr.name.text}(...)' in '${file.filePath}' is banned — avoid global mutable caches.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (
          staticObjectNames.size > 0 &&
          (isMemberCall(node, "Object", "assign") || isMemberCall(node, "Reflect", "set")) &&
          node.arguments.length >= 1 &&
          node.arguments[0] !== undefined
        ) {
          let targetExpr = unwrapAstExpression(node.arguments[0])
          while (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
            targetExpr = unwrapAstExpression(targetExpr.expression)
          }
          if (ts.isIdentifier(targetExpr) && staticObjectNames.has(targetExpr.text)) {
            violations.push({
              rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
              message: SelfDogfoodingMessage.make(
                `Mutating module-level object '${targetExpr.text}' via '${unwrappedNodeExpr.getText(sourceFile)}' in '${file.filePath}' is banned — avoid global mutable caches.`,
              ),
              file: file.filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
            })
          }
        }

        if (isMemberCall(node, "Layer", "build")) {
          let curr: ts.Node | undefined = node.parent
          let insideLayerEffect = false
          while (curr !== undefined) {
            if (ts.isCallExpression(curr) && isMemberCall(curr, "Layer", "effect")) {
              insideLayerEffect = true
              break
            }
            curr = curr.parent
          }
          if (insideLayerEffect) {
            violations.push({
              rule: SelfDogfoodingRuleId.make("no-layer-build-in-layer-effect"),
              message: SelfDogfoodingMessage.make(
                `Calling 'Layer.build(...)' inside 'Layer.effect(...)' in '${file.filePath}' is banned — compose Layers declaratively instead.`,
              ),
              file: file.filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
            })
          }
        }

        if (isDoubleWrappedEffectFn(node)) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("no-double-wrapped-effect-fn"),
            message: SelfDogfoodingMessage.make(
              `Double-wrapped 'Effect.fn(...)(() => Effect.gen(...))' / 'Effect.fnUntraced(() => Effect.gen(...))' in '${file.filePath}' is banned — pass the generator directly to Effect.fn.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }

        if (
          /(?:^|\/)libs\/harness\/gates\/src\//.test(file.filePath.replace(/\\/g, "/")) &&
          isSilentGateFsFallbackCall(node, sourceFile)
        ) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("silent-gate-fs-fallback"),
            message: SelfDogfoodingMessage.make(
              `Silent filesystem fallback in '${file.filePath}' is banned — emit an explicit 'unreadable-workspace-file' finding instead of returning "", [], {}, undefined, or false.`,
            ),
            file: file.filePath,
            line: getLineNumber(sourceFile, node.getStart(sourceFile)),
            enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
          })
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isProcessEnvExpression(node.initializer)
      ) {
        envAliasNames.add(node.name.text)
      }
      const isEnvTarget = (expr: ts.Expression): boolean => {
        const u = unwrapAstExpression(expr)
        return isProcessEnvExpression(u) || (ts.isIdentifier(u) && envAliasNames.has(u.text))
      }
      const isVitestEnvAccess =
        (ts.isPropertyAccessExpression(node) && node.name.text === "VITEST" && isEnvTarget(node.expression)) ||
        (ts.isElementAccessExpression(node) && isLiteralVitestKey(node.argumentExpression) && isEnvTarget(node.expression)) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
          isLiteralVitestKey(node.left) &&
          isEnvTarget(node.right)) ||
        (ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer !== undefined &&
          isEnvTarget(node.initializer) &&
          node.name.elements.some((el) => {
            const propName = el.propertyName ?? el.name
            return (
              ((ts.isIdentifier(propName) || ts.isStringLiteral(propName)) && propName.text === "VITEST") ||
              (ts.isComputedPropertyName(propName) && isLiteralVitestKey(propName.expression))
            )
          }))

      if (isVitestEnvAccess) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("test-env-branch-in-src"),
          message: SelfDogfoodingMessage.make(
            `Test environment branch referencing 'process.env.VITEST' in '${file.filePath}' is banned in production src/ — pass explicit options instead.`,
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
        })
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        /(?:^|\/)src\//.test(normPath) &&
        isBareCauseHasInterruptsNode(node, sourceFile, normPath)
      ) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("bare-cause-has-interrupts"),
          message: SelfDogfoodingMessage.make(
            "Point-free Cause.hasInterrupts or Cause.hasInterruptsOnly in production src/ can misclassify composite Fail+Interrupt causes — use isPureInterruptCause from @harness/contract instead.",
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
        })
      }

      if (
        isPureProcessEnvBanned &&
        ((ts.isExpression(node) && isProcessEnvExpression(node)) || isProcessEnvDestructuring(node))
      ) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("process-env-outside-infra-or-app"),
          message: SelfDogfoodingMessage.make(
            `Direct 'process.env' access in '${file.filePath}' is banned outside type:infra and type:app — inject Config or read environment variables in @harness/infra or apps/*.`,
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
        })
      }

      const mutatedObjectName = getMutatedStaticObjectName(node, staticObjectNames)
      if (mutatedObjectName !== undefined) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("no-global-mutable-cache"),
          message: SelfDogfoodingMessage.make(
            `Mutating module-level object '${mutatedObjectName}' in '${file.filePath}' is banned — avoid global mutable caches.`,
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
        })
      }

      if (ts.isSwitchStatement(node)) {
        violations.push({
          rule: SelfDogfoodingRuleId.make("harness-switch-statement"),
          message: SelfDogfoodingMessage.make(
            `Switch statement in '${file.filePath}' is banned — use match(value).with(...).exhaustive() from ts-pattern.`,
          ),
          file: file.filePath,
          line: getLineNumber(sourceFile, node.getStart(sourceFile)),
          enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
        })
      }

      ts.forEachChild(node, walk)
    }

    walk(sourceFile)
  }

  const report = makeSelfDogfoodingReport(violations, NonNegativeCount.make(inspectedCount))

  const [firstViolation, ...restViolations] = violations
  if (input.failOnViolation === true && firstViolation !== undefined) {
    return yield* new SelfDogfoodingViolationError({
      message: SelfDogfoodingMessage.make(
        `SelfDogfooding.decide found ${violations.length} violation(s).`,
      ),
      violations: [firstViolation, ...restViolations],
    })
  }

  return report
})

export const SelfDogfooding = {
  decide: decideSelfDogfooding,
} as const
