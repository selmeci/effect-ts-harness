import { Schema } from "effect"

export const NonNegativeCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("NonNegativeCount"),
)
export type NonNegativeCount = typeof NonNegativeCount.Type

export const GateRuleVersion = Schema.NonEmptyString.pipe(Schema.brand("GateRuleVersion"))
export type GateRuleVersion = typeof GateRuleVersion.Type
export const HARNESS_GATE_RULE_VERSION: GateRuleVersion = GateRuleVersion.make("ast-gates-v11")

/**
 * Pure deterministic UTF-16 code-unit string comparator (`-1 | 0 | 1`).
 * Replaces locale-sensitive `String.prototype.localeCompare` in gate and compiler sorting.
 */
export const compareCodeUnits = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)

export const WorkspaceFilePath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0]+$/s)),
  Schema.brand("WorkspaceFilePath"),
)
export type WorkspaceFilePath = typeof WorkspaceFilePath.Type

export const AstSourceFilePath = WorkspaceFilePath.pipe(Schema.brand("AstSourceFilePath"))
export type AstSourceFilePath = typeof AstSourceFilePath.Type

export const ContentSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("ContentSha256"),
)
export type ContentSha256 = typeof ContentSha256.Type

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const rotr32 = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift))

const UTF8_ENCODER = new TextEncoder()

/**
 * Pure-TypeScript FIPS 180-4 UTF-8 SHA-256 digest returning a branded `ContentSha256`.
 * Keeps `@harness/contract` free of Node built-in imports (`effect`-only dependency).
 */
export const computeContentSha256 = (content: string): ContentSha256 => {
  const input = UTF8_ENCODER.encode(content)
  const bitLen = input.length * 8
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLen >>> 0, false)

  const h = new Uint32Array(SHA256_INIT)
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h[0]!
    let b = h[1]!
    let c = h[2]!
    let d = h[3]!
    let e = h[4]!
    let f = h[5]!
    let g = h[6]!
    let hh = h[7]!

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  let hex = ""
  for (let i = 0; i < 8; i += 1) {
    hex += h[i]!.toString(16).padStart(8, "0")
  }
  return ContentSha256.make(hex)
}

export const AstSourceContent = Schema.String.pipe(Schema.brand("AstSourceContent"))
export type AstSourceContent = typeof AstSourceContent.Type

export const GateCategory = Schema.Literals([
  "syntax-bans",
  "test-integrity",
  "migration-safety",
  "domain-purity",
  "effect-laws",
])
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

export const GateVerdict = Schema.Literals(["clean", "violated"])
export type GateVerdict = typeof GateVerdict.Type

export const AstGatePackageTag = Schema.Literals([
  "contract",
  "domain",
  "service",
  "infra",
  "app",
  "test",
])
export type AstGatePackageTag = typeof AstGatePackageTag.Type

export const inferAstGatePackageTagFromPath = (filePath: string): AstGatePackageTag => {
  if (filePath.includes("/contract/")) return AstGatePackageTag.make("contract")
  if (filePath.includes("/domain/") || filePath.includes("/core/"))
    return AstGatePackageTag.make("domain")
  if (filePath.includes("/service/")) return AstGatePackageTag.make("service")
  if (filePath.includes("/infra/")) return AstGatePackageTag.make("infra")
  return AstGatePackageTag.make("app")
}

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
  "test-env-branch-in-src",
  "silent-gate-fs-fallback",
  "bare-cause-has-interrupts",
  "process-env-outside-infra-or-app",
  "dynamic-harness-import",
  "process-exit-outside-app",
  "locale-dependent-sort",
  "unhandled-effect-promise",
])
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

export const makeVerdictReportSchema = <V extends Schema.Top, Extra extends Schema.Struct.Fields>(
  violationSchema: V,
  extraFields: Extra,
) =>
  Schema.Union([
    Schema.Struct({
      verdict: Schema.Literal("clean"),
      violations: Schema.Tuple([]),
      ...extraFields,
    }),
    Schema.Struct({
      verdict: Schema.Literal("violated"),
      violations: Schema.NonEmptyArray(violationSchema),
      ...extraFields,
    }),
  ])

export const makeVerdictReport = <
  V,
  Extra extends Record<string, unknown> & {
    readonly verdict?: never
    readonly violations?: never
  },
>(
  violations: ReadonlyArray<V>,
  extra: Extra,
):
  | ({ readonly verdict: "clean"; readonly violations: readonly [] } & Extra)
  | ({ readonly verdict: "violated"; readonly violations: readonly [V, ...Array<V>] } & Extra) => {
  const [first, ...rest] = violations
  if (first === undefined) {
    return {
      ...extra,
      verdict: "clean",
      violations: [],
    }
  }
  return {
    ...extra,
    verdict: "violated",
    violations: [first, ...rest],
  }
}

export const SelfDogfoodingReport = makeVerdictReportSchema(SelfDogfoodingViolation, {
  inspectedFileCount: NonNegativeCount,
})
export type SelfDogfoodingReport = typeof SelfDogfoodingReport.Type

export const makeSelfDogfoodingReport = (
  violations: ReadonlyArray<SelfDogfoodingViolation>,
  inspectedFileCount: NonNegativeCount,
): SelfDogfoodingReport => makeVerdictReport(violations, { inspectedFileCount })

export class SelfDogfoodingViolationError extends Schema.TaggedError<SelfDogfoodingViolationError>()(
  "SelfDogfoodingViolationError",
  {
    message: SelfDogfoodingMessage,
    violations: Schema.NonEmptyArray(SelfDogfoodingViolation),
  },
) {}
