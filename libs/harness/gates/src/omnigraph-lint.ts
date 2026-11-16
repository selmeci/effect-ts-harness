import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  type OmnigraphLintDiagnostic,
  OmnigraphLintError,
  type OmnigraphLintInput,
  type OmnigraphLintReport,
  type OmnigraphLintViolation,
  makeVerdictReport,
} from "@harness/contract"

export const decideOmnigraphLint = Effect.fn("OmnigraphLint.decide")(function* (
  input: OmnigraphLintInput,
): Effect.fn.Return<OmnigraphLintReport, OmnigraphLintError, never> {
  const violations: Array<OmnigraphLintViolation> = []
  const blockingDiags: Array<OmnigraphLintDiagnostic> = []

  if (!input.statusOk) {
    violations.push({
      _tag: "LintStatusNotOkViolation",
      ruleId: "omnigraph-lint-status-not-ok",
      message: ErrorReasonMessage.make("Omnigraph lint reported non-ok status."),
    })
  }

  const denyWarnings = match(input.policy)
    .with("deny-warnings", () => true)
    .with("fail-on-error", "report-only", () => false)
    .exhaustive()

  for (const diag of input.diagnostics) {
    const isBlocking = match(diag.severity)
      .with("error", () => true)
      .with("warning", () => denyWarnings)
      .with("info", () => false)
      .exhaustive()

    if (isBlocking) {
      blockingDiags.push(diag)
      violations.push({
        _tag: "LintDiagnosticViolation",
        ruleId: "omnigraph-lint-error",
        message: ErrorReasonMessage.make(
          `[${diag.code}]${diag.targetName === null ? "" : ` (${diag.targetName})`} ${diag.message}`,
        ),
        diagnostic: diag,
      })
    }
  }

  if (input.errorCount > 0 && blockingDiags.length === 0) {
    violations.push({
      _tag: "LintDiagnosticViolation",
      ruleId: "omnigraph-lint-error",
      message: ErrorReasonMessage.make(
        `Omnigraph lint reported ${input.errorCount} error(s) without structured diagnostics.`,
      ),
      diagnostic: null,
    })
  }

  if (denyWarnings && input.warningCount > 0 && blockingDiags.length === 0) {
    violations.push({
      _tag: "LintDiagnosticViolation",
      ruleId: "omnigraph-lint-error",
      message: ErrorReasonMessage.make(
        `Omnigraph lint reported ${input.warningCount} warning(s) under deny-warnings policy.`,
      ),
      diagnostic: null,
    })
  }

  const hasBlockingErrors =
    input.errorCount > 0 ||
    blockingDiags.length > 0 ||
    !input.statusOk ||
    (denyWarnings && input.warningCount > 0)

  const shouldFail = match(input.policy)
    .with("fail-on-error", "deny-warnings", () => hasBlockingErrors)
    .with("report-only", () => false)
    .exhaustive()

  if (shouldFail) {
    const summary =
      violations.map((v) => v.message).join("; ") || "Omnigraph lint reported blocking errors."
    return yield* new OmnigraphLintError({
      errorCount: NonNegativeCount.make(
        Math.max(1, input.errorCount, blockingDiags.length),
      ),
      diagnosticsSummary: ErrorReasonMessage.make(summary),
    })
  }

  return makeVerdictReport(violations, {
    queriesProcessed: input.queriesProcessed,
    errorCount: input.errorCount,
    warningCount: input.warningCount,
  })
})
