import { Schema } from "effect"

export const NonNegativeCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("NonNegativeCount"),
)
export type NonNegativeCount = typeof NonNegativeCount.Type

export const GateRuleVersion = Schema.NonEmptyString.pipe(Schema.brand("GateRuleVersion"))
export type GateRuleVersion = typeof GateRuleVersion.Type
export const HARNESS_GATE_RULE_VERSION: GateRuleVersion = GateRuleVersion.make("ast-gates-v4")

export const AstSourceFilePath = Schema.NonEmptyString.pipe(Schema.brand("AstSourceFilePath"))
export type AstSourceFilePath = typeof AstSourceFilePath.Type

export const ContentSha256 = Schema.NonEmptyString.pipe(Schema.brand("ContentSha256"))
export type ContentSha256 = typeof ContentSha256.Type

export const AstSourceContent = Schema.String.pipe(Schema.brand("AstSourceContent"))
export type AstSourceContent = typeof AstSourceContent.Type

export const GateCategory = Schema.Literals([
  "syntax-bans", "test-integrity", "migration-safety", "domain-purity", "effect-laws",
]).pipe(Schema.brand("GateCategory"))
export type GateCategory = typeof GateCategory.Type

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

export const PluginId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PluginId"),
)
export type PluginId = typeof PluginId.Type

export const PluginFileLineCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("PluginFileLineCount"),
)
export type PluginFileLineCount = typeof PluginFileLineCount.Type

export const computeWorkspaceFileLineCount = (content: string): PluginFileLineCount =>
  PluginFileLineCount.make(content.length === 0 ? 0 : content.split(/\r?\n/).length)

export const MaxPluginFileLines = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("MaxPluginFileLines"),
)
export type MaxPluginFileLines = typeof MaxPluginFileLines.Type

export const DEFAULT_MAX_PLUGIN_FILE_LINES: MaxPluginFileLines = MaxPluginFileLines.make(800)

export const SelfDogfoodingRuleId = Schema.Literals([
  "effect-fn-dummy-void",
  "nested-effect-run-sync",
  "harness-switch-statement",
  "match-run-statement",
  "file-line-budget-exceeded",
  "facade-star-reexport",
  "catch-cause-interrupts-only",
  "silent-catch-defect",
  "ignored-chmod-permission",
  "no-global-mutable-cache",
  "no-node-builtins-outside-infra",
  "no-layer-build-in-layer-effect",
  "no-double-wrapped-effect-fn",
]).pipe(Schema.brand("SelfDogfoodingRuleId"))
export type SelfDogfoodingRuleId = typeof SelfDogfoodingRuleId.Type

export const SelfDogfoodingMessage = Schema.NonEmptyString.pipe(
  Schema.brand("SelfDogfoodingMessage"),
)
export type SelfDogfoodingMessage = typeof SelfDogfoodingMessage.Type

export const SelfDogfoodingViolation = Schema.Struct({
  rule: SelfDogfoodingRuleId,
  message: SelfDogfoodingMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type SelfDogfoodingViolation = typeof SelfDogfoodingViolation.Type

export const SelfDogfoodingReport = Schema.Struct({
  verdict: GateVerdict,
  violations: Schema.Array(SelfDogfoodingViolation),
  inspectedFileCount: NonNegativeCount,
})
export type SelfDogfoodingReport = typeof SelfDogfoodingReport.Type

export const makeSelfDogfoodingReport = (
  violations: ReadonlyArray<SelfDogfoodingViolation>,
  inspectedFileCount: NonNegativeCount,
): SelfDogfoodingReport => ({
  verdict: GateVerdict.make(violations.length === 0 ? "clean" : "violated"),
  violations: [...violations],
  inspectedFileCount,
})

export class SelfDogfoodingViolationError extends Schema.TaggedError<SelfDogfoodingViolationError>()(
  "SelfDogfoodingViolationError",
  {
    message: SelfDogfoodingMessage,
    violations: Schema.Array(SelfDogfoodingViolation),
  },
) {}
