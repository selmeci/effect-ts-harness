import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  ActiveMutantId,
  AstGateEvaluationReport,
  AstSourceContent,
  AstSourceFilePath,
  CompilerRepoRootPath,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheStatsSnapshot,
  DecisionCacheTtlMillis,
  EnclosingSymbolName,
  ErrorReasonMessage,
  GateRuleId,
  GateVerdict,
  GateViolationMessage,
  HarnessTierTopologyInput,
  HarnessTierTopologyReport,
  NonNegativeCount,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  PluginId,
  SelfDogfoodingMessage,
  SelfDogfoodingReport,
  SourceLineNumber,
  StdinReadError,
  SubprocessArg,
  SubprocessCommand,
  TierTopologyMessage,
  TierTopologyRuleId,
  WorkspaceFilePath,
  WorkspaceFsOperation,
  makeAstGateEvaluationReport,
  makeHarnessTierTopologyReport,
  makeSelfDogfoodingReport,
  validateSubprocessInput,
} from "../src/index.js"

describe("@harness/contract schemas", () => {
  it("decodes branded AST, self-dogfooding, and workspace primitives and collapses path brands", () => {
    expect(Schema.decodeSync(PluginId)("plugin-1")).toBe("plugin-1")
    expect(Schema.decodeSync(NonNegativeCount)(0)).toBe(0)
    const wsPath = WorkspaceFilePath.make("libs/harness/contract/src/index.ts")
    const astPath: AstSourceFilePath = wsPath
    const repoPath: CompilerRepoRootPath = wsPath
    expect(astPath).toBe("libs/harness/contract/src/index.ts")
    expect(repoPath).toBe("libs/harness/contract/src/index.ts")
    expect(Schema.decodeSync(SubprocessCommand)("pnpm")).toBe("pnpm")
    expect(Schema.decodeSync(ActiveMutantId)("mutant-1")).toBe("mutant-1")

    const report = makeSelfDogfoodingReport([], NonNegativeCount.make(1))
    const label = match(report.verdict)
      .with("clean", () => "ok")
      .with("violated", () => "bad")
      .exhaustive()
    expect(label).toBe("ok")
  })

  it("supports exhaustive ts-pattern matching on unbranded literal unions", () => {
    const op = Schema.decodeSync(WorkspaceFsOperation)("read")
    const opName = match(op)
      .with("read", () => "r")
      .with("write", () => "w")
      .with("stat", () => "s")
      .with("readdir", () => "d")
      .exhaustive()
    expect(opName).toBe("r")

    const rule = Schema.decodeSync(TierTopologyRuleId)("forbidden-core-dependency")
    const ruleTag = match(rule)
      .with("dual-contract-tier-tag", () => 1)
      .with("forbidden-contract-dependency", () => 2)
      .with("forbidden-service-dependency", () => 3)
      .with("forbidden-core-dependency", () => 4)
      .with("impure-service-tier-import", () => 5)
      .exhaustive()
    expect(ruleTag).toBe(4)
  })

  it("enforces verdict and violations agreement across all gate reports", () => {
    expect(() =>
      Schema.decodeSync(SelfDogfoodingReport)({
        verdict: GateVerdict.make("clean"),
        violations: [
          {
            rule: "harness-switch-statement",
            message: SelfDogfoodingMessage.make("switch found"),
            file: WorkspaceFilePath.make("libs/a.ts"),
            line: SourceLineNumber.make(1),
            enclosingSymbol: EnclosingSymbolName.make("fn"),
          },
        ],
        inspectedFileCount: NonNegativeCount.make(1),
      }),
    ).toThrow(/verdict and violations length must agree/)

    expect(() =>
      Schema.decodeSync(HarnessTierTopologyReport)({
        verdict: "violated",
        violations: [],
        inspectedPackageCount: NonNegativeCount.make(1),
      }),
    ).toThrow(/verdict and violations length must agree/)

    const validTopo = makeHarnessTierTopologyReport(
      [
        {
          rule: "impure-service-tier-import",
          location: WorkspaceFilePath.make("libs/harness/service/src/index.ts"),
          message: TierTopologyMessage.make("impure import"),
        },
      ],
      NonNegativeCount.make(2),
    )
    expect(validTopo.verdict).toBe("violated")

    const validAst = makeAstGateEvaluationReport({
      violations: [
        {
          category: "syntax-bans",
          rule: GateRuleId.make("no-switch"),
          message: GateViolationMessage.make("banned"),
          file: WorkspaceFilePath.make("libs/x.ts"),
          line: SourceLineNumber.make(3),
          enclosingSymbol: EnclosingSymbolName.make("mod"),
        },
      ],
      inspectedFileCount: NonNegativeCount.make(1),
      cacheHitCount: NonNegativeCount.make(0),
    })
    expect(Schema.decodeSync(AstGateEvaluationReport)(validAst).verdict).toBe("violated")
  })

  it("rejects empty, whitespace-only, negative, NaN, null, and unknown literal inputs", () => {
    expect(() => Schema.decodeSync(WorkspaceFilePath)("")).toThrow()
    expect(() => Schema.decodeSync(WorkspaceFilePath)("   ")).toThrow()
    expect(() => Schema.decodeSync(PluginId)(" untrimmed ")).toThrow()
    expect(() => Schema.decodeSync(NonNegativeCount)(-1)).toThrow()
    expect(() => Schema.decodeSync(NonNegativeCount)(Number.NaN)).toThrow()
    expect(() => Schema.decodeSync(SourceLineNumber)(0)).toThrow()
    expect(() => Schema.decodeSync(DecisionCacheTtlMillis)(-5)).toThrow()
    expect(() => Schema.decodeSync(DecisionCacheKey)("")).toThrow()
    expect(() => Schema.decodeSync(DaemonSocketPath)("  ")).toThrow()
    const nullInput: unknown = null
    const badRuleInput: unknown = "unknown-rule"
    expect(() => Schema.decodeUnknownSync(WorkspaceFilePath)(nullInput)).toThrow()
    expect(() => Schema.decodeUnknownSync(TierTopologyRuleId)(badRuleInput)).toThrow()
  })

  it("validates subprocess null-byte invariants and StdinReadError contract", async () => {
    const badCmd = validateSubprocessInput({
      command: SubprocessCommand.make("node\0evil"),
      args: [],
    })
    expect(Option.isSome(badCmd)).toBe(true)

    const badArg = validateSubprocessInput({
      command: SubprocessCommand.make("node"),
      args: [SubprocessArg.make("ok"), SubprocessArg.make("bad\0arg")],
    })
    expect(Option.isSome(badArg)).toBe(true)

    const badCwd = validateSubprocessInput({
      command: SubprocessCommand.make("node"),
      args: [],
      cwd: WorkspaceFilePath.make("/tmp/bad\0cwd"),
    })
    expect(Option.isSome(badCwd)).toBe(true)

    const clean = validateSubprocessInput({
      command: SubprocessCommand.make("node"),
      args: [SubprocessArg.make("--version")],
      cwd: WorkspaceFilePath.make("/tmp"),
    })
    expect(Option.isNone(clean)).toBe(true)

    const stdinErr = await Effect.runPromise(
      Effect.flip(
        Effect.fail(new StdinReadError({ reason: ErrorReasonMessage.make("stdin timed out") })),
      ),
    )
    expect(stdinErr._tag).toBe("StdinReadError")

    const stats = Schema.decodeSync(DecisionCacheStatsSnapshot)({
      hits: NonNegativeCount.make(1),
      misses: NonNegativeCount.make(1),
      coalescedRequests: NonNegativeCount.make(2),
      size: NonNegativeCount.make(1),
    })
    expect(stats.coalescedRequests).toBe(2)
    expect(DecisionCachePayloadJson.make("{}")).toBe("{}")
  })

  it("decodes tier topology input schema", () => {
    const input = Schema.decodeSync(HarnessTierTopologyInput)({
      manifests: [
        {
          manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
          packageName: PackageManifestName.make("@harness/contract"),
          nxTags: [NxTierTag.make("type:contract")],
          dependencyNames: [PackageDependencyName.make("effect")],
        },
      ],
      serviceFiles: [
        {
          filePath: AstSourceFilePath.make("libs/harness/service/src/index.ts"),
          content: AstSourceContent.make("export const x = 1"),
        },
      ],
    })
    expect(input.manifests).toHaveLength(1)
    expect(input.serviceFiles).toHaveLength(1)
  })
})
