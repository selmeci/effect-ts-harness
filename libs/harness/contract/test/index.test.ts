import { Cause, Exit, Option, Schema } from "effect"
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
  GateViolationMessage,
  HarnessSubprocessError,
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
  SubprocessExitCode,
  SubprocessOutput,
  TierTopologyMessage,
  TierTopologyRuleId,
  WorkspaceFilePath,
  WorkspaceFsOperation,
  inferAstGatePackageTagFromPath,
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
      .with("undeclared-workspace-dependency", () => 6)
      .exhaustive()
    expect(ruleTag).toBe(4)

    expect(inferAstGatePackageTagFromPath("libs/harness/contract/src/index.ts")).toBe("contract")
    expect(inferAstGatePackageTagFromPath("libs/es/core/src/index.ts")).toBe("domain")
    expect(inferAstGatePackageTagFromPath("libs/harness/service/src/index.ts")).toBe("service")
    expect(inferAstGatePackageTagFromPath("libs/harness/infra/src/index.ts")).toBe("infra")
    expect(inferAstGatePackageTagFromPath("apps/harness-cli/src/index.ts")).toBe("app")
  })

  it("enforces verdict and violations agreement at compile-time and decode-time across all gate reports", () => {
    const assertDecodeFails = <A, E>(exit: Exit.Exit<A, E>): void => {
      match(exit)
        .with({ _tag: "Failure" }, (failure) => {
          expect(Cause.pretty(failure.cause).length).toBeGreaterThan(0)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected Schema.decodeUnknownExit to fail")
        })
        .exhaustive()
    }

    const sampleDogfoodingViolation = {
      rule: "harness-switch-statement" as const,
      message: SelfDogfoodingMessage.make("switch found"),
      file: WorkspaceFilePath.make("libs/a.ts"),
      line: SourceLineNumber.make(1),
      enclosingSymbol: EnclosingSymbolName.make("fn"),
    }

    // @ts-expect-error clean SelfDogfoodingReport cannot carry violations
    const badDogfoodingClean: SelfDogfoodingReport = {
      verdict: "clean",
      violations: [sampleDogfoodingViolation],
      inspectedFileCount: NonNegativeCount.make(1),
    }
    const badDogfoodingCleanUnknown: unknown = badDogfoodingClean
    assertDecodeFails(Schema.decodeUnknownExit(SelfDogfoodingReport)(badDogfoodingCleanUnknown))

    // @ts-expect-error violated SelfDogfoodingReport requires non-empty violations
    const badDogfoodingViolated: SelfDogfoodingReport = {
      verdict: "violated",
      violations: [],
      inspectedFileCount: NonNegativeCount.make(1),
    }
    const badDogfoodingViolatedUnknown: unknown = badDogfoodingViolated
    assertDecodeFails(Schema.decodeUnknownExit(SelfDogfoodingReport)(badDogfoodingViolatedUnknown))

    const sampleTopoViolation = {
      rule: "impure-service-tier-import" as const,
      location: WorkspaceFilePath.make("libs/harness/service/src/index.ts"),
      message: TierTopologyMessage.make("impure import"),
    }

    // @ts-expect-error clean HarnessTierTopologyReport cannot carry violations
    const badTopoClean: HarnessTierTopologyReport = {
      verdict: "clean",
      violations: [sampleTopoViolation],
      inspectedPackageCount: NonNegativeCount.make(1),
    }
    const badTopoCleanUnknown: unknown = badTopoClean
    assertDecodeFails(Schema.decodeUnknownExit(HarnessTierTopologyReport)(badTopoCleanUnknown))

    // @ts-expect-error violated HarnessTierTopologyReport requires non-empty violations
    const badTopoViolated: HarnessTierTopologyReport = {
      verdict: "violated",
      violations: [],
      inspectedPackageCount: NonNegativeCount.make(1),
    }
    const badTopoViolatedUnknown: unknown = badTopoViolated
    assertDecodeFails(Schema.decodeUnknownExit(HarnessTierTopologyReport)(badTopoViolatedUnknown))

    const validTopo = makeHarnessTierTopologyReport([sampleTopoViolation], NonNegativeCount.make(2))
    expect(validTopo.verdict).toBe("violated")

    const sampleAstViolation = {
      category: "syntax-bans" as const,
      rule: GateRuleId.make("no-switch"),
      message: GateViolationMessage.make("banned"),
      file: WorkspaceFilePath.make("libs/x.ts"),
      line: SourceLineNumber.make(3),
      enclosingSymbol: EnclosingSymbolName.make("mod"),
    }

    // @ts-expect-error clean AstGateEvaluationReport cannot carry violations
    const badAstClean: AstGateEvaluationReport = {
      verdict: "clean",
      violations: [sampleAstViolation],
      inspectedFileCount: NonNegativeCount.make(1),
      cacheHitCount: NonNegativeCount.make(0),
    }
    const badAstCleanUnknown: unknown = badAstClean
    assertDecodeFails(Schema.decodeUnknownExit(AstGateEvaluationReport)(badAstCleanUnknown))

    // @ts-expect-error violated AstGateEvaluationReport requires non-empty violations
    const badAstViolated: AstGateEvaluationReport = {
      verdict: "violated",
      violations: [],
      inspectedFileCount: NonNegativeCount.make(1),
      cacheHitCount: NonNegativeCount.make(0),
    }
    const badAstViolatedUnknown: unknown = badAstViolated
    assertDecodeFails(Schema.decodeUnknownExit(AstGateEvaluationReport)(badAstViolatedUnknown))

    const validAst = makeAstGateEvaluationReport({
      violations: [sampleAstViolation],
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

  it("validates subprocess null-byte invariants, StdinReadError, and HarnessSubprocessError schema decode", () => {
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

    const validStdinExit = Schema.decodeExit(StdinReadError)({
      _tag: "StdinReadError",
      reason: "stdin timed out",
    })
    match(validStdinExit)
      .with({ _tag: "Success" }, (s) => {
        expect(s.value._tag).toBe("StdinReadError")
        expect(s.value.reason).toBe(ErrorReasonMessage.make("stdin timed out"))
      })
      .with({ _tag: "Failure" }, (f) => {
        expect.unreachable(`Expected StdinReadError decode to succeed: ${Cause.pretty(f.cause)}`)
      })
      .exhaustive()

    for (const invalidReason of ["", "   ", " untrimmed "]) {
      const invalidStdinExit = Schema.decodeExit(StdinReadError)({
        _tag: "StdinReadError",
        reason: invalidReason,
      })
      match(invalidStdinExit)
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable(`Expected StdinReadError decode to fail for '${invalidReason}'`)
        })
        .exhaustive()
    }

    const missingFailureKindExit = Schema.decodeUnknownExit(HarnessSubprocessError)({
      _tag: "HarnessSubprocessError",
      command: SubprocessCommand.make("node"),
      exitCode: SubprocessExitCode.make(1),
      stderr: SubprocessOutput.make("killed"),
      reason: ErrorReasonMessage.make("terminated"),
    })
    match(missingFailureKindExit)
      .with({ _tag: "Failure" }, (f) => {
        expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected HarnessSubprocessError without failureKind to fail decode")
      })
      .exhaustive()

    const signalSubprocessExit = Schema.decodeExit(HarnessSubprocessError)({
      _tag: "HarnessSubprocessError",
      command: SubprocessCommand.make("node"),
      exitCode: SubprocessExitCode.make(-1),
      stderr: SubprocessOutput.make(""),
      reason: ErrorReasonMessage.make("received SIGTERM"),
      failureKind: "signal",
    })
    match(signalSubprocessExit)
      .with({ _tag: "Success" }, (s) => {
        expect(s.value.failureKind).toBe("signal")
      })
      .with({ _tag: "Failure" }, (f) => {
        expect.unreachable(`Expected HarnessSubprocessError with signal to succeed: ${Cause.pretty(f.cause)}`)
      })
      .exhaustive()

    const stats = Schema.decodeSync(DecisionCacheStatsSnapshot)({
      hits: NonNegativeCount.make(1),
      misses: NonNegativeCount.make(1),
      coalescedRequests: NonNegativeCount.make(2),
      size: NonNegativeCount.make(1),
    })
    expect(stats.coalescedRequests).toBe(2)
    expect(DecisionCachePayloadJson.make("{}")).toBe("{}")
  })

  it("decodes tier topology input schema with optional workspaceSourceFiles", () => {
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
      workspaceSourceFiles: [
        {
          filePath: AstSourceFilePath.make("libs/harness/contract/src/index.ts"),
          content: AstSourceContent.make("export const y = 2"),
        },
      ],
    })
    expect(input.manifests).toHaveLength(1)
    expect(input.serviceFiles).toHaveLength(1)
    expect(input.workspaceSourceFiles).toHaveLength(1)
  })
})
