import { Effect } from "effect"
import { NonNegativeCount, ts } from "@harness/graph"
import {
  EnclosingSymbolName,
  getLineNumber,
  getOrCreateCachedSourceFile,
  isDummyEffectVoidYield,
  resolveEnclosingSymbol,
  SourceLineNumber,
  unwrapAstExpression,
} from "../ast-cache.js"
import {
  computeWorkspaceFileLineCount,
  DEFAULT_MAX_PLUGIN_FILE_LINES,
  makeSelfDogfoodingReport,
  type SelfDogfoodingInput,
  SelfDogfoodingMessage,
  type SelfDogfoodingReport,
  SelfDogfoodingRuleId,
  type SelfDogfoodingViolation,
  SelfDogfoodingViolationError,
} from "./self-dogfooding-contract.js"

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

const EFFECT_CONSTRUCTORS = new Set([
  "fn",
  "fnUntraced",
  "gen",
  "sync",
  "suspend",
  "try",
  "tryPromise",
  "promise",
])
const LAYER_CONSTRUCTORS = new Set(["effect", "succeed", "sync"])

const isBannedParentConstructor = (callExpr: ts.CallExpression): boolean => {
  let callee = unwrapAstExpression(callExpr.expression)
  if (ts.isCallExpression(callee)) {
    callee = unwrapAstExpression(callee.expression)
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const objName = callee.expression.text
    const propName = callee.name.text
    if (objName === "Effect" && EFFECT_CONSTRUCTORS.has(propName)) {
      return true
    }
    if (objName === "Layer" && LAYER_CONSTRUCTORS.has(propName)) {
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

    if (isGraphOrchestratorFacadePath(file.filePath)) {
      for (const stmt of sourceFile.statements) {
        if (ts.isExportDeclaration(stmt) && stmt.exportClause === undefined) {
          violations.push({
            rule: SelfDogfoodingRuleId.make("facade-star-reexport"),
            message: SelfDogfoodingMessage.make(
              `Wildcard 'export *' re-export in '${file.filePath}' is banned — decomposed @harness/graph orchestrator facades must use explicit named re-exports (export { ... } from "./...") instead of export * from so internal submodule helpers do not leak into the public API.`,
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

  if (input.failOnViolation === true && violations.length > 0) {
    return yield* new SelfDogfoodingViolationError({
      message: SelfDogfoodingMessage.make(
        `SelfDogfooding.decide found ${violations.length} violation(s).`,
      ),
      violations,
    })
  }

  return report
})

export const SelfDogfooding = {
  decide: decideSelfDogfooding,
} as const
