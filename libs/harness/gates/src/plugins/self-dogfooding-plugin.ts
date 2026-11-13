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

export const isModularPluginPath = (filePath: string): boolean => {
  const norm = filePath.replace(/\\/g, "/")
  return (
    /(?:^|\/)libs\/harness\/gates\/src\/.*\.ts$/.test(norm) ||
    /(?:^|\/)libs\/harness\/graph\/src\/.*\.ts$/.test(norm) ||
    /(?:^|\/)(?:plugins|services|commands|tools|mutation)\//.test(norm)
  )
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
  const maxLines = input.maxPluginFileLines ?? DEFAULT_MAX_PLUGIN_FILE_LINES
  const violations: Array<SelfDogfoodingViolation> = []
  let inspectedCount = 0

  for (const file of input.files) {
    const isTestFile = file.filePath.endsWith(".test.ts") || file.filePath.endsWith(".spec.ts")
    if (isTestFile) {
      continue
    }

    inspectedCount += 1

    const lineCount = computeWorkspaceFileLineCount(file.content)
    const shouldCheckLineBudget =
      file.isModularPluginFile === true ||
      isModularPluginPath(file.filePath) ||
      (file.isModularPluginFile === undefined && input.maxPluginFileLines !== undefined)

    if (shouldCheckLineBudget && lineCount > maxLines) {
      violations.push({
        rule: SelfDogfoodingRuleId.make("file-line-budget-exceeded"),
        message: SelfDogfoodingMessage.make(
          `File '${file.filePath}' has ${lineCount} lines, exceeding maxPluginFileLines budget of ${maxLines}.`,
        ),
        file: file.filePath,
        line: SourceLineNumber.make(Math.max(1, lineCount)),
        enclosingSymbol: EnclosingSymbolName.make(file.filePath),
      })
    }

    const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)

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
