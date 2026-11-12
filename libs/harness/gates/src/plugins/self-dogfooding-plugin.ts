import { Effect } from "effect"
import { NonNegativeCount, ts } from "@harness/graph"
import {
  EnclosingSymbolName,
  GateVerdict,
  getLineNumber,
  getOrCreateCachedSourceFile,
  resolveEnclosingSymbol,
  SourceLineNumber,
} from "../ast-cache.js"
import {
  DEFAULT_MAX_PLUGIN_FILE_LINES,
  type SelfDogfoodingInput,
  SelfDogfoodingMessage,
  type SelfDogfoodingReport,
  SelfDogfoodingRuleId,
  type SelfDogfoodingViolation,
  SelfDogfoodingViolationError,
} from "./self-dogfooding-contract.js"

const unwrapExpression = (expr: ts.Expression): ts.Expression => {
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

export const decideSelfDogfooding = Effect.fn("SelfDogfooding.decide")(function* (
  input: SelfDogfoodingInput,
): Effect.fn.Return<SelfDogfoodingReport, SelfDogfoodingViolationError, never> {
  const maxLines = input.maxPluginFileLines ?? DEFAULT_MAX_PLUGIN_FILE_LINES
  const violations: Array<SelfDogfoodingViolation> = []

  for (const file of input.files) {
    const isTestFile = file.filePath.endsWith(".test.ts") || file.filePath.endsWith(".spec.ts")
    if (isTestFile) {
      continue
    }

    const lineCount = file.content.length === 0 ? 0 : file.content.split(/\r?\n/).length
    const shouldCheckLineBudget =
      file.isModularPluginFile !== false || input.maxPluginFileLines !== undefined

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
        if (node.expression !== undefined) {
          const inner = unwrapExpression(node.expression)
          const text = inner.getText(sourceFile).trim()
          if (
            text === "Effect.void" ||
            text.startsWith("Effect.void.") ||
            text.startsWith("Effect.asVoid(")
          ) {
            violations.push({
              rule: SelfDogfoodingRuleId.make("effect-fn-dummy-void"),
              message: SelfDogfoodingMessage.make(
                `Dummy 'yield* Effect.void' in '${file.filePath}' is banned — use Effect.succeed or a real Effect yield.`,
              ),
              file: file.filePath,
              line: getLineNumber(sourceFile, node.getStart(sourceFile)),
              enclosingSymbol: resolveEnclosingSymbol(node, file.filePath),
            })
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const unwrappedNodeExpr = unwrapExpression(node.expression)
        const calleeText = unwrappedNodeExpr.getText(sourceFile).trim()
        if (calleeText === "Effect.runSync" || calleeText === "Effect.runPromise") {
          let curr: ts.Node | undefined = node.parent
          let isNested = false
          while (curr !== undefined) {
            if (ts.isCallExpression(curr)) {
              const unwrappedParentExpr = unwrapExpression(curr.expression)
              const parentExprText = unwrappedParentExpr.getText(sourceFile).trim()
              const prefixes = [
                "Effect.fn",
                "Effect.gen",
                "Effect.sync",
                "Effect.suspend",
                "Effect.try",
                "Effect.tryPromise",
                "Effect.promise",
                "Layer.effect",
                "Layer.scoped",
                "Layer.succeed",
                "Layer.sync",
              ]
              if (prefixes.some((p) => parentExprText.startsWith(p))) {
                isNested = true
                break
              }
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

  const report: SelfDogfoodingReport = {
    verdict: GateVerdict.make(violations.length === 0 ? "clean" : "violated"),
    violations,
    inspectedFileCount: NonNegativeCount.make(input.files.length),
  }

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
