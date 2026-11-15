import { createHash } from "node:crypto"
import { Cause, Exit, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  ActiveMutantId,
  AstGateDecisionReport,
  AstGateEvaluationError,
  AstGateEvaluationReport,
  AstSourceContent,
  AstSourceFilePath,
  CompilerRepoRootPath,
  ContentSha256,
  DaemonServerError,
  DaemonServerErrorKind,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheStatsSnapshot,
  DecisionCacheTtlMillis,
  EnclosingSymbolName,
  ErrorReasonMessage,
  EvaluatorId,
  GateRuleId,
  GateViolationMessage,
  HARNESS_AST_GATE_CACHE_FILENAME,
  HARNESS_DECISION_CACHE_FILENAME,
  HARNESS_GATE_RULE_VERSION,
  HarnessSubprocessError,
  HarnessTierTopologyInput,
  HarnessTierTopologyReport,
  NonNegativeCount,
  NxScopeTag,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  PluginId,
  SelfDogfoodingMessage,
  SelfDogfoodingReport,
  SelfDogfoodingViolationError,
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
  computeContentSha256,
  inferAstGatePackageTagFromPath,
  isPureInterruptCause,
  makeAstGateDecisionReport,
  makeAstGateEvaluationReport,
  makeHarnessTierTopologyReport,
  makeSelfDogfoodingReport,
  makeVerdictReport,
  parseManifestTags,
  resolveDefaultAstGateCachePath,
  resolveDefaultDecisionCachePath,
  toErrorReasonMessage,
  validateSubprocessInput,
} from "../src/index.js"

describe("@harness/contract schemas", () => {
  it("decodes branded AST, self-dogfooding, and workspace primitives and enforces distinct path sub-brands", () => {
    expect(Schema.decodeSync(PluginId)("plugin-1")).toBe("plugin-1")
    expect(Schema.decodeSync(NonNegativeCount)(0)).toBe(0)
    const wsPath = WorkspaceFilePath.make("libs/harness/contract/src/index.ts")
    const astPath = AstSourceFilePath.make("libs/harness/contract/src/index.ts")
    const repoPath = CompilerRepoRootPath.make("/repo")
    const astAsWs: WorkspaceFilePath = astPath
    const repoAsWs: WorkspaceFilePath = repoPath
    // @ts-expect-error bare WorkspaceFilePath cannot be assigned to AstSourceFilePath
    const badAstFromWs: AstSourceFilePath = wsPath
    // @ts-expect-error bare WorkspaceFilePath cannot be assigned to CompilerRepoRootPath
    const badRepoFromWs: CompilerRepoRootPath = wsPath
    // @ts-expect-error AstSourceFilePath and CompilerRepoRootPath are distinct brands
    const badSwap: AstSourceFilePath = repoPath
    expect(astAsWs).toBe("libs/harness/contract/src/index.ts")
    expect(repoAsWs).toBe("/repo")
    expect(badAstFromWs).toBe(wsPath)
    expect(badRepoFromWs).toBe(wsPath)
    expect(badSwap).toBe(repoPath)
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
      .with("impure-core-tier-import", () => 5)
      .with("impure-service-tier-import", () => 6)
      .with("undeclared-workspace-dependency", () => 7)
      .with("banned-workspace-dependency", () => 8)
      .with("forbidden-domain-dependency", () => 9)
      .with("forbidden-infra-dependency", () => 10)
      .with("forbidden-web-app-dependency", () => 11)
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
      file: AstSourceFilePath.make("libs/a.ts"),
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
      file: AstSourceFilePath.make("libs/x.ts"),
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
    expect(() => Schema.decodeSync(WorkspaceFilePath)("/tmp/bad\0path")).toThrow()
    expect(() => Schema.decodeSync(PluginId)(" untrimmed ")).toThrow()
    expect(() => Schema.decodeSync(NonNegativeCount)(-1)).toThrow()
    expect(() => Schema.decodeSync(NonNegativeCount)(Number.NaN)).toThrow()
    expect(() => Schema.decodeSync(SourceLineNumber)(0)).toThrow()
    expect(() => Schema.decodeSync(DecisionCacheTtlMillis)(0)).toThrow()
    expect(() => Schema.decodeSync(DecisionCacheTtlMillis)(-5)).toThrow()
    expect(Schema.decodeSync(DecisionCacheTtlMillis)(1)).toBe(1)
    expect(() => Schema.decodeSync(DecisionCacheKey)("")).toThrow()
    expect(() => Schema.decodeSync(DecisionCacheKey)("key\0bad")).toThrow()
    expect(() => Schema.decodeSync(EvaluatorId)("")).toThrow()
    expect(() => Schema.decodeSync(EvaluatorId)(" untrimmed ")).toThrow()
    expect(() => Schema.decodeSync(EvaluatorId)("eval\0id")).toThrow()
    expect(Schema.decodeSync(EvaluatorId)("eval-1")).toBe("eval-1")
    expect(() => Schema.decodeSync(ContentSha256)("not-a-sha")).toThrow()
    expect(() => Schema.decodeSync(ContentSha256)("A".repeat(64))).toThrow()
    expect(Schema.decodeSync(ContentSha256)("0".repeat(64))).toBe("0".repeat(64))
    expect(() => Schema.decodeSync(DaemonSocketPath)("  ")).toThrow()
    const nullInput: unknown = null
    const badRuleInput: unknown = "unknown-rule"
    expect(() => Schema.decodeUnknownSync(WorkspaceFilePath)(nullInput)).toThrow()
    expect(() => Schema.decodeUnknownSync(TierTopologyRuleId)(badRuleInput)).toThrow()
  })

  it("validates subprocess null-byte invariants, StdinReadError, and HarnessSubprocessError schema decode", () => {
    expect(() => Schema.decodeSync(SubprocessCommand)("node\0evil")).toThrow()
    expect(() => Schema.decodeSync(SubprocessArg)("bad\0arg")).toThrow()
    expect(() => Schema.decodeSync(WorkspaceFilePath)("/tmp/bad\0cwd")).toThrow()

    const clean = validateSubprocessInput({
      command: SubprocessCommand.make("node"),
      args: [SubprocessArg.make("--version")],
      cwd: WorkspaceFilePath.make("/tmp"),
    })
    expect(clean._tag).toBe("None")

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

  it("decodes tier topology input schema with required nonRuntimeDependencyNames and workspaceSourceFiles", () => {
    const input = Schema.decodeSync(HarnessTierTopologyInput)({
      manifests: [
        {
          manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
          packageName: PackageManifestName.make("@harness/contract"),
          nxTags: [NxTierTag.make("type:contract")],
          dependencyNames: [PackageDependencyName.make("effect")],
          nonRuntimeDependencyNames: [],
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

  it("computes SHA-256 identically to node:crypto across empty, ASCII, multi-block, and multi-byte UTF-8 inputs", () => {
    expect(HARNESS_GATE_RULE_VERSION).toBe("ast-gates-v7")
    const samples = [
      "",
      "abc",
      "The quick brown fox jumps over the lazy dog",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "x".repeat(200),
      "🚀 Effect-TS 中文 café naïve — ∀x∈ℝ",
    ]
    for (const sample of samples) {
      const expected = createHash("sha256").update(sample, "utf8").digest("hex")
      expect(computeContentSha256(sample)).toBe(expected)
    }
  })

  it("enforces non-negative SubprocessExitCode, optional exitCode, non-empty SelfDogfoodingViolationError, AstGateDecisionReport, and DaemonServerErrorKind", () => {
    expect(() => Schema.decodeSync(SubprocessExitCode)(-1)).toThrow()
    expect(Schema.decodeSync(SubprocessExitCode)(0)).toBe(0)
    expect(Schema.decodeSync(SubprocessExitCode)(127)).toBe(127)

    const emptyDogfoodingErr: unknown = {
      _tag: "SelfDogfoodingViolationError",
      message: SelfDogfoodingMessage.make("failed"),
      violations: [],
    }
    expect(() => Schema.decodeUnknownSync(SelfDogfoodingViolationError)(emptyDogfoodingErr)).toThrow()

    const evalErr = new AstGateEvaluationError({
      filePath: AstSourceFilePath.make("libs/a.ts"),
      reason: ErrorReasonMessage.make("parse failed"),
    })
    expect(evalErr._tag).toBe("AstGateEvaluationError")

    const decisionReport = makeAstGateDecisionReport({
      violations: [],
      cacheHitCount: NonNegativeCount.make(1),
      parsedFileCount: NonNegativeCount.make(2),
    })
    expect(Schema.decodeSync(AstGateDecisionReport)(decisionReport).verdict).toBe("clean")

    const kind = Schema.decodeSync(DaemonServerErrorKind)("not-a-socket")
    const daemonErr = new DaemonServerError({
      socketPath: DaemonSocketPath.make("/tmp/d.sock"),
      reasonKind: kind,
      reason: ErrorReasonMessage.make("not a socket"),
    })
    expect(daemonErr.reasonKind).toBe("not-a-socket")
  })

  it("provides pure interrupt cause detection, total error reason formatting, verdict protection, cache paths, and manifest tag parsing", () => {
    expect(isPureInterruptCause(Cause.interrupt(0))).toBe(true)
    expect(isPureInterruptCause(Cause.fail("err"))).toBe(false)
    expect(isPureInterruptCause(Cause.die(new Error("boom")))).toBe(false)
    expect(
      isPureInterruptCause(Cause.combine(Cause.die(new Error("boom")), Cause.interrupt(0))),
    ).toBe(false)

    expect(toErrorReasonMessage(new Error("  spaced error  "))).toBe("spaced error")
    expect(toErrorReasonMessage({ message: "   " }, "  fallback msg  ")).toBe("fallback msg")
    expect(toErrorReasonMessage("", "   ")).toBe("Unknown error")
    expect(toErrorReasonMessage(Object.create(null), "null-proto")).toBe("null-proto")

    const report = makeVerdictReport([], {
      inspectedFileCount: NonNegativeCount.make(3),
    })
    expect(report.verdict).toBe("clean")
    expect(report.violations).toEqual([])
    expect(report.inspectedFileCount).toBe(3)

    // @ts-expect-error extra cannot supply verdict or violations
    makeVerdictReport([], { inspectedFileCount: NonNegativeCount.make(1), verdict: "violated" })

    const spoofedExtra = JSON.parse(
      '{"inspectedFileCount":3,"verdict":"clean","violations":[]}',
    ) as { readonly inspectedFileCount: NonNegativeCount }
    const spoofedReport = makeVerdictReport(["v1"], spoofedExtra)
    expect(spoofedReport.verdict).toBe("violated")
    expect(spoofedReport.violations).toEqual(["v1"])
    expect(spoofedReport.inspectedFileCount).toBe(3)

    expect(HARNESS_AST_GATE_CACHE_FILENAME).toBe("ast-gate-cache-v1.json")
    expect(HARNESS_DECISION_CACHE_FILENAME).toBe("decision-cache-v1.json")
    expect(resolveDefaultAstGateCachePath("/repo/")).toBe("/repo/.harness/cache/ast-gate-cache-v1.json")
    expect(resolveDefaultDecisionCachePath("/repo")).toBe("/repo/.harness/cache/decision-cache-v1.json")

    const parsed = parseManifestTags(["type:contract", "scope:web", "custom:tag", "type:infra"])
    expect(parsed.nxTags).toEqual([NxTierTag.make("type:contract"), NxTierTag.make("type:infra")])
    expect(parsed.scopeTags).toEqual([NxScopeTag.make("scope:web")])
    expect(parsed.unknownTags).toEqual(["custom:tag"])
    expect(() => Schema.decodeUnknownSync(NxTierTag)("type:unknown")).toThrow()
  })
})
