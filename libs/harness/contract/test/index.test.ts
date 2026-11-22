import { createHash } from "node:crypto"
import { Cause, Exit, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  ActiveMutantId,
  AstGateDecisionReport,
  AstGateEvaluationError,
  AstGateEvaluationReport,
  AstGatePackageTag,
  AstGateViolationContract,
  AstSourceContent,
  AstSourceFilePath,
  AttemptNumber,
  CANONICAL_MCP_TOOL_NAMES,
  CompiledPlan,
  CompiledWaves,
  type CompiledWorkUnit,
  CompilerRepoRootPath,
  CompilerVersionTag,
  CompleteSharedStepInput,
  CompletedWorkflowAttemptRecord,
  ContentSha256,
  CyclicPlanWorkflowError,
  DaemonServerError,
  DaemonServerErrorKind,
  DaemonSocketPath,
  DEFAULT_REVIEW_ROUTE_TIMEOUT_MS,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheStatsSnapshot,
  DecisionCacheTtlMillis,
  DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
  DisjointOwnershipViolationError,
  DispatchedWorkflowAttemptRecord,
  EarsRequirementKey,
  EnclosingSymbolName,
  ErrorReasonMessage,
  EscalationDecision,
  EscalationOrdinal,
  EvaluatorId,
  FrictionLogState,
  GateCategory,
  GateExitCode,
  GateRuleId,
  GateRuleSourceSnapshot,
  GateRuleVersion,
  GateViolationMessage,
  GitCommonDirPath,
  GitCommitSha,
  GitDiffErrorReason,
  GitDiffExecutionError,
  HARNESS_AST_GATE_CACHE_FILENAME,
  HARNESS_DECISION_CACHE_FILENAME,
  HarnessSubprocessError,
  HarnessTierTopologyInput,
  HarnessTierTopologyReport,
  InvalidPlanWorkflowGraphError,
  InvalidReviewRouteInputError,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  McpToolName,
  NonNegativeCount,
  NxScopeTag,
  NxTierTag,
  OwnedRelPath,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  PackageStampHash,
  PackageUnitDraft,
  PackageVerifyFailureKind,
  PendingDeferredName,
  PersistedAstCacheEntry,
  PersistedAstCacheKey,
  PersistedAstCacheStore,
  PlanJsonPayload,
  PlanSha256,
  PluginId,
  REVIEW_DEPTH_LEVELS,
  REVIEW_DEPTH_RANK,
  RejectedWorkflowAttemptRecord,
  RejectionJsonPayload,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewSignalPath,
  ReviewTimeoutMillis,
  ReviewerId,
  ReviewerSelection,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SPECIALIST_REVIEWER_IDS,
  SelfDogfoodingMessage,
  SelfDogfoodingReport,
  SelfDogfoodingRuleId,
  SelfDogfoodingViolationError,
  SliceBranchName,
  SliceUnitDraft,
  SourceLineNumber,
  StdinReadError,
  SubprocessArg,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessMaxBufferBytes,
  SubprocessOutput,
  TaskRunAbortedError,
  TierTopologyMessage,
  TierTopologyRuleId,
  UnitEscalation,
  UnitOutcome,
  WORKFLOW_GQ_QUERY_NAMES,
  WaveIndex,
  WorkUnitDraft,
  WorkUnitId,
  WorkflowAttemptKey,
  WorkflowAttemptVerdict,
  WorkflowCompileReason,
  WorkflowCompleteRequest,
  WorkflowCompleteResponse,
  WorkflowExecutionId,
  WorkflowGqQueryName,
  WorkflowLevel,
  WorkflowPlanToolOutput,
  WorkflowProjectionStatus,
  WorkflowRebuiltRunCount,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  WorkflowRpcEnvelope,
  WorkflowRpcErrorEnvelope,
  WorkflowRpcRequestId,
  WorkflowRpcSuccessEnvelope,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowRunState,
  WorkflowStartRequest,
  WorkflowStatusSummary,
  WorkflowStoreAvailabilityState,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowTerminalError,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  WorkflowUnitKind,
  WorkflowUnitStatus,
  WorkspaceFilePath,
  WorkspaceFsOperation,
  WorkspaceTreeHash,
  compareCodeUnits,
  computeContentSha256,
  computeGateRuleVersionFromSources,
  getReviewDepthRank,
  inferAstGatePackageTagFromPath,
  isPureInterruptCause,
  makeAstGateDecisionReport,
  makeAstGateEvaluationReport,
  makeHarnessTierTopologyReport,
  makePersistedAstCacheKey,
  makeSelfDogfoodingReport,
  makeVerdictReport,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
  normalizeNonRootWorkspacePath,
  parseManifestTags,
  pathsOverlap,
  resolveDefaultAstGateCachePath,
  resolveDefaultDecisionCachePath,
  sanitizeWorktreeIdSegment,
  selectActivePersistedAstCacheEntries,
  toCompilerOverlayErrorReason,
  toCompilerRepoRootInput,
  toErrorReasonMessage,
  toMcpToolInputName,
  validateSubprocessInput,
  wavesOf,
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
      reasonKind: "Timeout",
    })
    match(validStdinExit)
      .with({ _tag: "Success" }, (s) => {
        expect(s.value._tag).toBe("StdinReadError")
        expect(s.value.reason).toBe(ErrorReasonMessage.make("stdin timed out"))
        expect(s.value.reasonKind).toBe("Timeout")
      })
      .with({ _tag: "Failure" }, (f) => {
        expect.unreachable(`Expected StdinReadError decode to succeed: ${Cause.pretty(f.cause)}`)
      })
      .exhaustive()

    const missingReasonKindStdinExit = Schema.decodeUnknownExit(StdinReadError)({
      _tag: "StdinReadError",
      reason: "stdin timed out",
    })
    match(missingReasonKindStdinExit)
      .with({ _tag: "Failure" }, (f) => {
        expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected StdinReadError without reasonKind to fail decode")
      })
      .exhaustive()

    for (const invalidReason of ["", "   ", " untrimmed "]) {
      const invalidStdinExit = Schema.decodeExit(StdinReadError)({
        _tag: "StdinReadError",
        reason: invalidReason,
        reasonKind: "ReadFailed",
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
        expect.unreachable(
          `Expected HarnessSubprocessError with signal to succeed: ${Cause.pretty(f.cause)}`,
        )
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

  it("decodes tier topology input schema with required nonRuntimeDependencyNames, scopeTags, and workspaceSourceFiles", () => {
    const input = Schema.decodeSync(HarnessTierTopologyInput)({
      manifests: [
        {
          manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
          packageName: PackageManifestName.make("@harness/contract"),
          nxTags: [NxTierTag.make("type:contract")],
          scopeTags: [],
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

    const missingScopeTagsExit = Schema.decodeUnknownExit(HarnessTierTopologyInput)({
      manifests: [
        {
          manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
          packageName: PackageManifestName.make("@harness/contract"),
          nxTags: [NxTierTag.make("type:contract")],
          dependencyNames: [PackageDependencyName.make("effect")],
          nonRuntimeDependencyNames: [],
        },
      ],
      serviceFiles: [],
      workspaceSourceFiles: [],
    })
    match(missingScopeTagsExit)
      .with({ _tag: "Failure" }, (f) => {
        expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected PackageTierManifestInput without scopeTags to fail decode")
      })
      .exhaustive()
  })

  it("computes SHA-256 identically to node:crypto across empty, ASCII, multi-block, and multi-byte UTF-8 inputs", () => {
    expect(DEFAULT_IN_MEMORY_GATE_RULE_VERSION).toBe("ast-gates-in-memory")

    const unwrapVersion = (
      res: Result.Result<GateRuleVersion, ErrorReasonMessage>,
    ): GateRuleVersion =>
      match(res)
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(failure))
        .exhaustive()
    const snap = (filePath: string, content: string): GateRuleSourceSnapshot =>
      Schema.decodeSync(GateRuleSourceSnapshot)({ filePath, content })

    match(computeGateRuleVersionFromSources([]))
      .with({ _tag: "Success" }, () => expect.unreachable("Expected empty rule snapshots to fail"))
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("empty")
      })
      .exhaustive()

    const vSingleEmpty = unwrapVersion(computeGateRuleVersionFromSources([snap("a.ts", "")]))
    expect(vSingleEmpty).toMatch(/^ast-gates-[0-9a-f]{64}$/)
    expect(vSingleEmpty).not.toBe(DEFAULT_IN_MEMORY_GATE_RULE_VERSION)

    const v1 = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "a"), snap("b.ts", "b")]),
    )
    const vReordered = unwrapVersion(
      computeGateRuleVersionFromSources([snap("b.ts", "b"), snap("a.ts", "a")]),
    )
    const vChanged = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "a"), snap("b.ts", "c")]),
    )
    const vPathSwapped = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "b"), snap("b.ts", "a")]),
    )
    const vDelimiterCollision = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "a,b")]),
    )
    const expectedV1 = `ast-gates-${computeContentSha256(
      JSON.stringify({
        domain: "ast-gate-rules-v1",
        files: [
          ["a.ts", computeContentSha256("a")],
          ["b.ts", computeContentSha256("b")],
        ],
      }),
    )}`
    expect(v1).toBe(expectedV1)
    expect(vReordered).toBe(v1)
    expect(v1).not.toBe(vChanged)
    expect(v1).not.toBe(vPathSwapped)
    expect(v1).not.toBe(vDelimiterCollision)

    const vWithTs1 = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "a")], CompilerVersionTag.make("7.0.2")),
    )
    const vWithTs2 = unwrapVersion(
      computeGateRuleVersionFromSources([snap("a.ts", "a")], CompilerVersionTag.make("7.0.3")),
    )
    const vWithoutTs = unwrapVersion(computeGateRuleVersionFromSources([snap("a.ts", "a")]))
    expect(vWithTs1).not.toBe(vWithTs2)
    expect(vWithTs1).not.toBe(vWithoutTs)

    expect(compareCodeUnits("a", "b")).toBe(-1)
    expect(compareCodeUnits("b", "a")).toBe(1)
    expect(compareCodeUnits("a", "a")).toBe(0)
    expect(Schema.decodeSync(SelfDogfoodingRuleId)("process-exit-outside-app")).toBe(
      "process-exit-outside-app",
    )
    expect(Schema.decodeSync(SelfDogfoodingRuleId)("locale-dependent-sort")).toBe(
      "locale-dependent-sort",
    )
    expect(Schema.decodeSync(SelfDogfoodingRuleId)("unhandled-effect-promise")).toBe(
      "unhandled-effect-promise",
    )
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

  it("enforces GateRuleVersion / PersistedAstCache* negative matrices and evicts stale/mismatched entries", () => {
    for (const badVersion of [
      "",
      "  leading",
      "trailing ",
      "bad\0nul",
      "bad\nline",
      "x".repeat(257),
      null,
      undefined,
      123,
      Number.NaN,
    ]) {
      expect(() => Schema.decodeUnknownSync(GateRuleVersion)(badVersion)).toThrow()
      expect(() => Schema.decodeUnknownSync(CompilerVersionTag)(badVersion)).toThrow()
    }
    for (const badKey of [
      "",
      null,
      undefined,
      123,
      Number.NaN,
      "__proto__",
      "only-two\0parts",
      "a.ts\0invalid-tier\0v1\0default",
      "a.ts\0domain\0v1\0",
      `${"a".repeat(4090)}\0domain\0v1\0default`,
    ]) {
      expect(() => Schema.decodeUnknownSync(PersistedAstCacheKey)(badKey)).toThrow()
    }
    for (const badEntry of [
      "",
      null,
      undefined,
      Number.NaN,
      { contentSha256: "not-64-hex", ruleVersion: "v1", violations: [] },
      { contentSha256: "A".repeat(64), ruleVersion: "v1", violations: [] },
      { contentSha256: "a".repeat(64), ruleVersion: "", violations: [] },
      { contentSha256: "a".repeat(64), ruleVersion: "v1", violations: [{ bad: true }] },
    ]) {
      expect(() => Schema.decodeUnknownSync(PersistedAstCacheEntry)(badEntry)).toThrow()
    }
    for (const badStore of [
      "",
      null,
      undefined,
      Number.NaN,
      { version: "bad\0ver", entries: {} },
      { version: "v1", entries: "not-an-object" },
      {
        version: "v1",
        entries: {
          "a.ts\0domain\0v1\0default": {
            contentSha256: "not-hex",
            ruleVersion: "v1",
            violations: [],
          },
        },
      },
    ]) {
      expect(() => Schema.decodeUnknownSync(PersistedAstCacheStore)(badStore)).toThrow()
    }
    // Effect Schema.Record filters own keys by PersistedAstCacheKey, excluding invalid "" keys
    const filteredStore = Schema.decodeSync(PersistedAstCacheStore)({
      version: "v1",
      entries: { "": { contentSha256: "a".repeat(64), ruleVersion: "v1", violations: [] } },
    })
    expect(filteredStore.entries).toEqual({})

    const activeRuleVersion = GateRuleVersion.make("ast-gates-active")
    const staleRuleVersion = GateRuleVersion.make("ast-gates-stale")
    const evalId = EvaluatorId.make("default")
    const activeKey = makePersistedAstCacheKey(
      AstSourceFilePath.make("libs/a.ts"),
      AstGatePackageTag.make("domain"),
      activeRuleVersion,
      evalId,
    )
    const staleEntryKey = makePersistedAstCacheKey(
      AstSourceFilePath.make("libs/b.ts"),
      AstGatePackageTag.make("domain"),
      staleRuleVersion,
      evalId,
    )
    const keyMismatchKey = makePersistedAstCacheKey(
      AstSourceFilePath.make("libs/c.ts"),
      AstGatePackageTag.make("domain"),
      staleRuleVersion,
      evalId,
    )
    const sampleViolation = Schema.decodeSync(AstGateViolationContract)({
      category: GateCategory.make("syntax-bans"),
      rule: GateRuleId.make("unsafe-type-cast"),
      message: GateViolationMessage.make("Avoid unsafe type assertion"),
      file: AstSourceFilePath.make("libs/a.ts"),
      line: SourceLineNumber.make(12),
      enclosingSymbol: EnclosingSymbolName.make("evaluate"),
    })
    const activeEntry: PersistedAstCacheEntry = {
      contentSha256: ContentSha256.make("a".repeat(64)),
      ruleVersion: activeRuleVersion,
      violations: [sampleViolation],
    }
    const staleEntry: PersistedAstCacheEntry = {
      contentSha256: ContentSha256.make("b".repeat(64)),
      ruleVersion: staleRuleVersion,
      violations: [],
    }
    const mismatchedKeyEntry: PersistedAstCacheEntry = {
      contentSha256: ContentSha256.make("c".repeat(64)),
      ruleVersion: activeRuleVersion,
      violations: [],
    }

    const emptyStore = Schema.decodeSync(PersistedAstCacheStore)({
      version: activeRuleVersion,
      entries: {},
    })
    expect(selectActivePersistedAstCacheEntries(emptyStore, activeRuleVersion).size).toBe(0)

    const matchingStore = Schema.decodeSync(PersistedAstCacheStore)({
      version: activeRuleVersion,
      entries: {
        [activeKey]: activeEntry,
        [staleEntryKey]: staleEntry,
        [keyMismatchKey]: mismatchedKeyEntry,
      },
    })
    const selectedFromMatching = selectActivePersistedAstCacheEntries(
      matchingStore,
      activeRuleVersion,
    )
    expect(selectedFromMatching.size).toBe(1)
    expect(selectedFromMatching.get(activeKey)).toEqual(activeEntry)
    expect(selectedFromMatching.get(activeKey)?.violations).toEqual([sampleViolation])
    expect(selectedFromMatching.has(staleEntryKey)).toBe(false)
    expect(selectedFromMatching.has(keyMismatchKey)).toBe(false)

    const allStaleStore = Schema.decodeSync(PersistedAstCacheStore)({
      version: activeRuleVersion,
      entries: {
        [staleEntryKey]: staleEntry,
        [keyMismatchKey]: mismatchedKeyEntry,
      },
    })
    expect(selectActivePersistedAstCacheEntries(allStaleStore, activeRuleVersion).size).toBe(0)

    const mismatchedStore = Schema.decodeSync(PersistedAstCacheStore)({
      version: staleRuleVersion,
      entries: {
        [activeKey]: activeEntry,
      },
    })
    expect(selectActivePersistedAstCacheEntries(mismatchedStore, activeRuleVersion).size).toBe(0)
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
    expect(() =>
      Schema.decodeUnknownSync(SelfDogfoodingViolationError)(emptyDogfoodingErr),
    ).toThrow()

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

    expect(Schema.is(SubprocessMaxBufferBytes)(1024)).toBe(true)
    expect(Schema.is(SubprocessMaxBufferBytes)(16_777_216)).toBe(true)
    expect(Schema.is(SubprocessMaxBufferBytes)(16_777_217)).toBe(false)
    expect(toMcpToolInputName("t".repeat(300))).toHaveLength(256)
    expect(toCompilerRepoRootInput("/".repeat(5000))).toHaveLength(4096)
    expect(toCompilerOverlayErrorReason("e".repeat(9000))).toHaveLength(8192)
    expect(toCompilerOverlayErrorReason("", "fallback")).toBe("fallback")

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
    expect(resolveDefaultAstGateCachePath("/repo/")).toBe(
      "/repo/.harness/cache/ast-gate-cache-v1.json",
    )
    expect(resolveDefaultDecisionCachePath("/repo")).toBe(
      "/repo/.harness/cache/decision-cache-v1.json",
    )
    for (const invalidRoot of [
      "",
      "   ",
      "/",
      "///",
      "/.",
      "/..",
      "/tmp/..",
      ".",
      "..",
      "./.",
      "a/..",
      "../..",
      "C:\\.",
      "C:\\a\\..",
      "/repo\0",
    ]) {
      expect(() => resolveDefaultAstGateCachePath(invalidRoot)).toThrow()
      expect(() => resolveDefaultDecisionCachePath(invalidRoot)).toThrow()
      expect(() => normalizeNonRootWorkspacePath(invalidRoot)).toThrow()
    }
    expect(normalizeNonRootWorkspacePath("/repo/sub/../dir/")).toBe("/repo/dir")
    expect(normalizeNonRootWorkspacePath("C:\\repo\\sub\\..")).toBe("C:/repo")
    expect(normalizeNonRootWorkspacePath("../sibling")).toBe("../sibling")
    for (const invalidWorktreeId of ["", "   ", ".", "..", "...", "wt\0id"]) {
      expect(() => sanitizeWorktreeIdSegment(invalidWorktreeId)).toThrow()
    }
    expect(sanitizeWorktreeIdSegment("feat/nested#branch")).toBe("feat_nested_branch")

    const parsed = parseManifestTags(["type:contract", "scope:web", "custom:tag", "type:infra"])
    expect(parsed.nxTags).toEqual([NxTierTag.make("type:contract"), NxTierTag.make("type:infra")])
    expect(parsed.scopeTags).toEqual([NxScopeTag.make("scope:web")])
    expect(parsed.unknownTags).toEqual(["custom:tag"])
    expect(() => Schema.decodeUnknownSync(NxTierTag)("type:unknown")).toThrow()
  })

  it("validates review routing contracts, branded literals, and 18 canonical MCP tool names", () => {
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(18)
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_review_route"))
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_git_diff"))
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_workflow_plan"))
    const gitDiffErr = new GitDiffExecutionError({
      reason: GitDiffErrorReason.make("Invalid base ref"),
    })
    expect(gitDiffErr._tag).toBe("GitDiffExecutionError")
    expect(gitDiffErr.reason).toBe(GitDiffErrorReason.make("Invalid base ref"))

    expect(SPECIALIST_REVIEWER_IDS).toHaveLength(7)
    for (const id of SPECIALIST_REVIEWER_IDS) {
      expect(Schema.decodeSync(ReviewerId)(id)).toBe(id)
    }
    expect(() => Schema.decodeUnknownSync(ReviewerId)("unknown-reviewer")).toThrow()

    for (const depth of ["skip", "lite", "focused", "full"] as const) {
      expect(Schema.decodeSync(ReviewDepth)(depth)).toBe(depth)
    }
    expect(() => Schema.decodeUnknownSync(ReviewDepth)("deep")).toThrow()

    const skipPlan = Schema.decodeUnknownSync(ReviewRoutingPlan)({
      _tag: "SkipReviewPlan",
      depth: "skip",
      source: "deterministic",
      reason: "Doc-only edit under 40 lines",
      selections: [],
    })
    expect(
      match(skipPlan)
        .with({ _tag: "SkipReviewPlan" }, (p) => p.depth)
        .with({ _tag: "ActiveReviewPlan" }, (p) => p.depth)
        .exhaustive(),
    ).toBe(ReviewDepth.make("skip"))

    expect(() =>
      Schema.decodeUnknownSync(ReviewRoutingPlan)({
        _tag: "SkipReviewPlan",
        depth: "skip",
        source: "deterministic",
        reason: "Invalid non-empty selections",
        selections: [
          {
            reviewer: "effect-ears-test-reviewer",
            reason: "Should fail",
            mandatory: true,
          },
        ],
      }),
    ).toThrow()

    const activePlan = Schema.decodeSync(ReviewRoutingPlan)({
      _tag: "ActiveReviewPlan",
      depth: ReviewDepth.make("focused"),
      source: ReviewRoutingSource.make("deterministic"),
      selections: [
        ReviewerSelection.make({
          reviewer: ReviewerId.make("effect-web-reviewer"),
          reason: ReviewRoutingReason.make("scope:web touched"),
          mandatory: true,
        }),
      ],
    })
    expect(activePlan._tag).toBe("ActiveReviewPlan")

    expect(() =>
      Schema.decodeUnknownSync(ReviewRoutingPlan)({
        _tag: "ActiveReviewPlan",
        depth: "skip",
        source: "deterministic",
        selections: [
          {
            reviewer: "effect-web-reviewer",
            reason: "Invalid depth skip",
            mandatory: true,
          },
        ],
      }),
    ).toThrow()

    const err = new InvalidReviewRouteInputError({
      offendingPath: ReviewRawFileInput.make("../secret.ts"),
      reason: ErrorReasonMessage.make("Path traversal is not allowed"),
    })
    expect(err._tag).toBe("InvalidReviewRouteInputError")

    for (const invalidCount of [-1, 1.5, "0", Number.NaN, null, undefined]) {
      expect(() => Schema.decodeUnknownSync(ReviewChangedLines)(invalidCount)).toThrow()
    }
    for (const invalidPath of [
      "",
      "  ",
      " libs/a.ts ",
      "../../etc/passwd",
      "../secret.ts",
      "a/../b.ts",
      "./libs/a.ts",
      "a/./b.ts",
      "/etc/passwd",
      "C:/repo/a.ts",
      "C:secret.ts",
      "libs\\a.ts",
      "libs//a.ts",
      "libs/a.ts/",
      "libs/ a.ts",
      "libs/a\0b.ts",
      "a".repeat(513),
      null,
    ]) {
      expect(() => Schema.decodeUnknownSync(ReviewSignalPath)(invalidPath)).toThrow()
      if (typeof invalidPath === "string") {
        expect(() => ReviewSignalPath.make(invalidPath)).toThrow()
      }
    }
    expect(ReviewSignalPath.make(".oxlintrc.json")).toBe(".oxlintrc.json")
    expect(ReviewSignalPath.make("a".repeat(512))).toHaveLength(512)
    expect(() => ReviewRawFileInput.make("a".repeat(513))).toThrow()
    expect(ReviewRawFileInput.make("a".repeat(512))).toHaveLength(512)

    expect(getReviewDepthRank(ReviewDepth.make("skip"))).toBe(REVIEW_DEPTH_RANK.skip)
    expect(getReviewDepthRank(ReviewDepth.make("lite"))).toBe(1)
    expect(getReviewDepthRank(ReviewDepth.make("focused"))).toBe(2)
    expect(getReviewDepthRank(ReviewDepth.make("full"))).toBe(3)
    const ranks = REVIEW_DEPTH_LEVELS.map((d) => getReviewDepthRank(ReviewDepth.make(d)))
    expect(ranks).toEqual([0, 1, 2, 3])
    expect(Object.keys(REVIEW_DEPTH_RANK)).toEqual([...REVIEW_DEPTH_LEVELS])
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!)
    }
    expect(DEFAULT_REVIEW_ROUTE_TIMEOUT_MS).toBe(1500)
    expect(() => ReviewTimeoutMillis.make(99)).toThrow()
    expect(() => ReviewTimeoutMillis.make(30001)).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(ReviewRoutingPlan)({
        _tag: "ActiveReviewPlan",
        depth: "lite",
        source: "deterministic",
        selections: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(ReviewRawDiffInput)({
        changedFiles: [],
        diffSummary: "",
        changedLineCount: 0,
        touchedTiers: [],
        touchedScopes: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(ReviewRawDiffInput)({
        changedFiles: Array.from({ length: 201 }, (_, i) => `libs/file-${i}.ts`),
        diffSummary: "",
        changedLineCount: 0,
        touchedTiers: [],
        touchedScopes: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReviewRawDiffInput)({
        changedFiles: ["libs/a.ts"],
        diffSummary: "",
        changedLineCount: 1,
        touchedTiers: Array.from({ length: 17 }, () => "type:contract"),
        touchedScopes: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReviewRawDiffInput)({
        changedFiles: ["libs/a.ts"],
        diffSummary: "",
        changedLineCount: 1,
        touchedTiers: [],
        touchedScopes: Array.from({ length: 17 }, () => "scope:web"),
      }),
    ).toThrow()
  })

  it("exports all WF-1 root barrel symbols and exercises wavesOf sorting + GitCommitSha decode", () => {
    expect(AbsoluteRepoRoot).toBeDefined()
    expect(GitCommitSha).toBeDefined()
    expect(WorkflowRunId).toBeDefined()
    expect(WorkUnitId).toBeDefined()
    expect(OwnedRelPath).toBeDefined()
    expect(CompiledPlan).toBeDefined()
    expect(CompiledWaves).toBeDefined()
    expect(CyclicPlanWorkflowError).toBeDefined()
    expect(DisjointOwnershipViolationError).toBeDefined()
    expect(InvalidPlanWorkflowGraphError).toBeDefined()
    expect(SliceUnitDraft).toBeDefined()
    expect(PackageUnitDraft).toBeDefined()
    expect(WorkUnitDraft).toBeDefined()
    expect(pathsOverlap).toBeTypeOf("function")
    expect(compareCodeUnits).toBeTypeOf("function")
    expect(wavesOf).toBeTypeOf("function")

    const validSha = "0123456789abcdef0123456789abcdef01234567"
    expect(Schema.decodeSync(GitCommitSha)(validSha)).toBe(validSha)
    expect(() => Schema.decodeSync(GitCommitSha)("not-a-sha")).toThrow()

    expect(Schema.decodeSync(AbsoluteRepoRoot)("/workspace/repo")).toBe("/workspace/repo")
    const runId = Schema.decodeSync(WorkflowRunId)("run-barrel-01")
    const relPathA = Schema.decodeSync(OwnedRelPath)("libs/a.ts")
    const relPathB = Schema.decodeSync(OwnedRelPath)("libs/b.ts")
    const unitZ: CompiledWorkUnit = {
      _tag: "SliceUnit",
      unitId: WorkUnitId.make("unit-z"),
      branch: SliceBranchName.make("slice/epic-z"),
      waveIndex: WaveIndex.make(1),
      dependsOn: [],
      ownedRelPaths: [relPathB],
      earsKeys: [EarsRequirementKey.make("REQ-1.3")],
    }
    const unitA: CompiledWorkUnit = {
      _tag: "SliceUnit",
      unitId: WorkUnitId.make("unit-a"),
      branch: SliceBranchName.make("slice/epic-a"),
      waveIndex: WaveIndex.make(1),
      dependsOn: [],
      ownedRelPaths: [relPathA],
      earsKeys: [EarsRequirementKey.make("REQ-1.3")],
    }
    const unitRoot: CompiledWorkUnit = {
      _tag: "SliceUnit",
      unitId: WorkUnitId.make("unit-0"),
      branch: SliceBranchName.make("slice/epic-0"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/root.ts")],
      earsKeys: [EarsRequirementKey.make("REQ-1.3")],
    }

    const plan = Schema.decodeSync(CompiledPlan)({
      runId,
      level: WorkflowLevel.make("epic"),
      planSha: PlanSha256.make("a".repeat(64)),
      baseSha: validSha,
      mode: { _tag: "Manual" },
      units: [unitZ, unitA, unitRoot],
      sharedStepPaths: [],
    })
    const sortedWaves = wavesOf(plan)
    expect(sortedWaves.map((w) => w.waveIndex)).toEqual([0, 1])
    expect(sortedWaves[0]?.units.map((u) => u.unitId)).toEqual(["unit-0"])
    expect(sortedWaves[1]?.units.map((u) => u.unitId)).toEqual(["unit-a", "unit-z"])

    const wrappedWaves = Schema.decodeSync(CompiledWaves)({
      units: [unitZ, unitA, unitRoot],
    })
    expect(wavesOf(wrappedWaves)).toEqual(sortedWaves)

    const cyclicErr = new CyclicPlanWorkflowError({
      cycleUnits: [WorkUnitId.make("unit-a"), WorkUnitId.make("unit-z")],
      reason: WorkflowCompileReason.make("cycle"),
    })
    const disjointErr = new DisjointOwnershipViolationError({
      waveIndex: WaveIndex.make(1),
      overlappingPaths: [relPathA],
    })
    const invalidErr = new InvalidPlanWorkflowGraphError({
      issue: { _tag: "DuplicateWorkUnitId", unitId: WorkUnitId.make("unit-a") },
    })
    expect(cyclicErr._tag).toBe("CyclicPlanWorkflowError")
    expect(disjointErr._tag).toBe("DisjointOwnershipViolationError")
    expect(invalidErr._tag).toBe("InvalidPlanWorkflowGraphError")
    expect(invalidErr.message).toContain("unit-a")
  })

  const makeWf3Fixtures = () => {
    const runId = WorkflowRunId.make("run-wf3-001")
    const execId = WorkflowExecutionId.make("exec-wf3-001")
    const unitId = WorkUnitId.make("unit-wf3-1")
    const planSha = PlanSha256.make("a".repeat(64))
    const baseSha = GitCommitSha.make("0123456789abcdef0123456789abcdef01234567")
    const treeHash = WorkspaceTreeHash.make("b".repeat(64))
    const stampHash = PackageStampHash.make("c".repeat(64))
    const repoRoot = AbsoluteRepoRoot.make("/workspace/repo")
    const commonGitDir = GitCommonDirPath.make("/workspace/repo/.git")
    const expectedUnitKey = makeWorkflowUnitKey(runId, unitId)
    const expectedAttemptKey = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(1))
    const dispatchedAttempt = Schema.decodeSync(DispatchedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "dispatched",
      runner: RunnerId.make("antigravity"),
      updatedMs: WorkflowTimestampMs.make(1_150),
    })
    const completedAttempt = Schema.decodeSync(CompletedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "completed",
      packageStampHash: stampHash,
      updatedMs: WorkflowTimestampMs.make(1_180),
    })
    const rejectedAttempt = Schema.decodeSync(RejectedWorkflowAttemptRecord)({
      attemptKey: expectedAttemptKey,
      runId,
      unitId,
      attempt: AttemptNumber.make(1),
      verdict: "rejected",
      runner: RunnerId.make("antigravity"),
      rejection: { _tag: "StampMissing" },
      packageStampHash: stampHash,
      updatedMs: WorkflowTimestampMs.make(1_200),
    })
    const pendingDeferreds = [
      {
        _tag: "UnitCompletion" as const,
        unitId,
        attempt: AttemptNumber.make(1),
        deferredName: PendingDeferredName.make(`unit/${unitId}/1`),
      },
      {
        _tag: "Escalation" as const,
        unitId,
        deferredName: PendingDeferredName.make(`escalation/${unitId}/1`),
        escalation: { _tag: "AuthRequired" as const, runner: RunnerId.make("claude-code") },
      },
      {
        _tag: "LlmPhase" as const,
        deferredName: PendingDeferredName.make("llm-phase-done"),
      },
    ]
    const skipReview = {
      _tag: "SkipReviewPlan" as const,
      depth: ReviewDepth.make("skip"),
      source: ReviewRoutingSource.make("deterministic"),
      reason: ReviewRoutingReason.make("doc-only"),
      selections: [] as const,
    }
    const runRecord = {
      runId,
      executionId: execId,
      level: WorkflowLevel.make("slice"),
      planSha,
      baseSha,
      state: WorkflowRunState.make("waiting"),
      planJson: PlanJsonPayload.make("{}"),
      updatedMs: WorkflowTimestampMs.make(1_000),
    }
    const unitRecord = {
      unitKey: WorkflowUnitKey.make(expectedUnitKey),
      runId,
      unitId,
      kind: WorkflowUnitKind.make("slice"),
      waveIndex: WaveIndex.make(0),
      status: WorkflowUnitStatus.make("escalated"),
      ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src")],
      updatedMs: WorkflowTimestampMs.make(1_100),
    }
    return {
      runId,
      execId,
      unitId,
      planSha,
      baseSha,
      treeHash,
      stampHash,
      repoRoot,
      commonGitDir,
      expectedUnitKey,
      expectedAttemptKey,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
      pendingDeferreds,
      skipReview,
      runRecord,
      unitRecord,
    }
  }

  it("validates WF-3 IDs, TaskRunAbortedError, 14 GQ query names, and CompleteSharedStepInput", () => {
    const { runId, baseSha, repoRoot } = makeWf3Fixtures()
    expect(SHARED_STEP_UNIT_ID).toBe("shared-step")
    expect(Schema.decodeSync(WorkUnitId)(SHARED_STEP_UNIT_ID)).toBe("shared-step")

    expect(Schema.decodeSync(WorkflowExecutionId)("exec-wf3-01")).toBe("exec-wf3-01")
    for (const badExecId of ["", "   ", " untrimmed ", "x".repeat(257)]) {
      expect(() => Schema.decodeSync(WorkflowExecutionId)(badExecId)).toThrow()
    }

    expect(Schema.decodeSync(EscalationOrdinal)(1)).toBe(1)
    expect(Schema.decodeSync(EscalationOrdinal)(3)).toBe(3)
    for (const badOrdinal of [0, -1, 1.5, Number.NaN, "1", null]) {
      expect(() => Schema.decodeUnknownSync(EscalationOrdinal)(badOrdinal)).toThrow()
    }

    expect(Schema.decodeSync(WorkflowRebuiltRunCount)(0)).toBe(0)
    expect(Schema.decodeSync(WorkflowRebuiltRunCount)(4)).toBe(4)
    for (const badRebuiltCount of [-1, 1.5, Number.NaN, "2", null]) {
      expect(() => Schema.decodeUnknownSync(WorkflowRebuiltRunCount)(badRebuiltCount)).toThrow()
    }

    const authAbort = new TaskRunAbortedError({
      runId,
      escalation: { _tag: "AuthRequired", runner: RunnerId.make("claude-code") },
    })
    expect(authAbort._tag).toBe("TaskRunAbortedError")
    expect(authAbort.message).toContain("claude-code")

    const retryAbort = new TaskRunAbortedError({
      runId,
      escalation: {
        _tag: "RetryBudgetExhausted",
        lastRejection: {
          _tag: "PackageVerifyFailed",
          exitCode: GateExitCode.make(1),
          failureKind: PackageVerifyFailureKind.make("non-zero-exit"),
        },
      },
    })
    expect(retryAbort.message).toContain("PackageVerifyFailed")

    const conflictAbort = new TaskRunAbortedError({
      runId,
      escalation: { _tag: "MergeConflict", branch: SliceBranchName.make("slice/wf3-a") },
    })
    expect(conflictAbort.message).toContain("slice/wf3-a")

    expect(
      Schema.decodeSync(TaskRunAbortedError)({
        _tag: "TaskRunAbortedError",
        runId,
        escalation: { _tag: "AuthRequired", runner: "antigravity" },
      }).escalation._tag,
    ).toBe("AuthRequired")
    expect(() =>
      Schema.decodeUnknownSync(TaskRunAbortedError)({
        _tag: "TaskRunAbortedError",
        runId: "bad",
        escalation: { _tag: "AuthRequired", runner: "unknown-runner" },
      }),
    ).toThrow()

    const wf3QueryNames = [
      "wf_get_run",
      "wf_list_runs",
      "wf_insert_run",
      "wf_update_run",
      "wf_units_for_run",
      "wf_get_unit",
      "wf_insert_unit",
      "wf_update_unit",
      "wf_attempts_for_run",
      "wf_get_attempt",
      "wf_insert_attempt",
      "wf_update_attempt",
      "wf_delete_run_views",
      "wf_probe_runs",
    ] as const
    for (const qName of wf3QueryNames) {
      expect(WORKFLOW_GQ_QUERY_NAMES).toContain(qName)
      expect(Schema.decodeSync(WorkflowGqQueryName)(qName)).toBe(qName)
    }
    expect(() => Schema.decodeUnknownSync(WorkflowGqQueryName)("wf_nonexistent_query")).toThrow()

    const sharedStepInput = Schema.decodeSync(CompleteSharedStepInput)({
      runId,
      baseSha,
      sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
      priorUnitOwnedPaths: [OwnedRelPath.make("libs/harness/contract/src")],
      attempt: AttemptNumber.make(1),
      cwd: repoRoot,
    })
    expect(sharedStepInput.priorUnitOwnedPaths).toEqual(["libs/harness/contract/src"])
    expect(() =>
      Schema.decodeUnknownSync(CompleteSharedStepInput)({
        runId,
        baseSha,
        sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(CompleteSharedStepInput)({
        runId,
        baseSha,
        sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        priorUnitOwnedPaths: [".harness/secret"],
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
      }),
    ).toThrow()
  })

  it("validates WF-3 start, complete, resume requests and workflow attempt record schemas", () => {
    const {
      runId,
      unitId,
      planSha,
      baseSha,
      repoRoot,
      expectedAttemptKey,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
    } = makeWf3Fixtures()

    const plan = Schema.decodeSync(CompiledPlan)({
      runId,
      level: WorkflowLevel.make("slice"),
      planSha,
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId,
          branch: SliceBranchName.make("slice/wf3-unit"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/src")],
          earsKeys: [EarsRequirementKey.make("REQ-3.1")],
        },
      ],
      sharedStepPaths: [],
    })

    const startReq = Schema.decodeSync(WorkflowStartRequest)({ repoRoot, plan })
    expect(startReq.plan.runId).toBe(runId)
    expect(() => Schema.decodeSync(WorkflowStartRequest)({ repoRoot: "/", plan })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStartRequest)({ repoRoot, plan: { invalid: true } }),
    ).toThrow()

    const completeUnitReq = Schema.decodeSync(WorkflowCompleteRequest)({
      _tag: "CompleteUnit",
      repoRoot,
      unitId,
      runId,
    })
    const completeLlmReq = Schema.decodeSync(WorkflowCompleteRequest)({
      _tag: "CompleteLlmPhase",
      repoRoot,
    })
    expect(
      match(completeUnitReq)
        .with({ _tag: "CompleteUnit" }, (req) => req.unitId)
        .with({ _tag: "CompleteLlmPhase" }, () => "llm")
        .exhaustive(),
    ).toBe(unitId)
    expect(completeLlmReq._tag).toBe("CompleteLlmPhase")
    expect(() =>
      Schema.decodeSync(WorkflowCompleteRequest)({
        _tag: "CompleteUnit",
        repoRoot,
        unitId: "INVALID_UNIT",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCompleteRequest)({ _tag: "CompleteUnknown", repoRoot }),
    ).toThrow()

    const resumeEscalationReq = Schema.decodeSync(WorkflowResumeRequest)({
      _tag: "ResolveEscalation",
      repoRoot,
      runId,
      unitId,
      decision: EscalationDecision.make("retry"),
    })
    const resumeRunReq = Schema.decodeSync(WorkflowResumeRequest)({
      _tag: "ResumeRun",
      repoRoot,
      runId,
    })
    expect(
      match(resumeEscalationReq)
        .with({ _tag: "ResolveEscalation" }, (r) => r.decision)
        .with({ _tag: "ResumeRun" }, () => "run")
        .exhaustive(),
    ).toBe("retry")
    expect(resumeRunReq._tag).toBe("ResumeRun")
    expect(() =>
      Schema.decodeUnknownSync(WorkflowResumeRequest)({
        _tag: "ResolveEscalation",
        repoRoot,
        runId,
        unitId,
        decision: "skip",
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(WorkflowResumeRequest)({ repoRoot, runId })).toThrow()

    const retryEscalationAttemptKey = makeWorkflowAttemptKey(
      runId,
      unitId,
      AttemptNumber.make(1),
      EscalationOrdinal.make(2),
    )
    expect(retryEscalationAttemptKey).toBe(`${runId}/${unitId}#1/r2`)
    expect(Schema.decodeSync(WorkflowAttemptKey)(expectedAttemptKey)).toBe(expectedAttemptKey)
    expect(Schema.decodeSync(WorkflowAttemptVerdict)("rejected")).toBe("rejected")
    expect(dispatchedAttempt.verdict).toBe("dispatched")
    expect(completedAttempt.verdict).toBe("completed")
    expect(rejectedAttempt.rejection._tag).toBe("StampMissing")
    expect(Schema.decodeSync(RejectionJsonPayload)('{"_tag":"StampMissing"}')).toContain(
      "StampMissing",
    )
    expect(Schema.decodeSync(WorkflowStoreAvailabilityState)("ready")).toBe("ready")
    expect(() =>
      Schema.decodeUnknownSync(RejectedWorkflowAttemptRecord)({
        attemptKey: expectedAttemptKey,
        runId,
        unitId,
        attempt: AttemptNumber.make(1),
        verdict: "rejected",
        updatedMs: WorkflowTimestampMs.make(1_200),
      }),
    ).toThrow()
  })

  it("validates WF-3 outcomes, WorkflowStatusSummary, RPC envelopes, and WorkflowPlanToolOutput", () => {
    const {
      runId,
      unitId,
      planSha,
      treeHash,
      repoRoot,
      commonGitDir,
      dispatchedAttempt,
      completedAttempt,
      rejectedAttempt,
      pendingDeferreds,
      skipReview,
      runRecord,
      unitRecord,
    } = makeWf3Fixtures()

    const failedOutcome = Schema.decodeSync(WorkflowRunOutcome)({
      _tag: "Failed",
      run: runRecord,
      units: [unitRecord],
      attempts: [rejectedAttempt],
      pendingDeferreds,
      terminalError: {
        _tag: "StoreUnavailable",
        operation: WorkflowStoreOperation.make("WorkflowRun.status"),
        reason: WorkflowStoreFailureReason.make("daemon stopped"),
      },
      projectionStatus: WorkflowProjectionStatus.make("fresh"),
    })
    expect(failedOutcome._tag).toBe("Failed")
    expect(
      Schema.decodeSync(WorkflowTerminalError)({
        _tag: "LeaseHeld",
        holderId: "daemon-1",
        lockFilePath: "/repo/.git/harness/daemon.lock",
      })._tag,
    ).toBe("LeaseHeld")

    const completedOutcome = Schema.decodeSync(WorkflowRunOutcome)({
      _tag: "Completed",
      run: { ...runRecord, state: WorkflowRunState.make("completed") },
      units: [unitRecord],
      attempts: [completedAttempt],
      pendingDeferreds: [],
      review: skipReview,
      terminalReceipt: {
        runId,
        planSha,
        review: skipReview,
        completedUnits: [unitId],
        llmPhase: { workspaceHash: treeHash, frictionLogCleared: FrictionLogState.make("cleared") },
      },
      projectionStatus: WorkflowProjectionStatus.make("fresh"),
    })
    expect(completedOutcome._tag).toBe("Completed")

    const offlineStatus = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "DaemonOffline",
      outcome: { _tag: "NotFound" },
    })
    expect(offlineStatus._tag).toBe("DaemonOffline")

    const pausedStatus = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "StorePaused",
      writerLeaseEpoch: LeaseEpoch.make(2),
      outcome: {
        _tag: "Active",
        run: runRecord,
        units: [unitRecord],
        attempts: [dispatchedAttempt],
        pendingDeferreds,
        projectionStatus: WorkflowProjectionStatus.make("stale"),
      },
    })
    expect(pausedStatus._tag).toBe("StorePaused")

    const statusSummary = Schema.decodeSync(WorkflowStatusSummary)({
      _tag: "Ready",
      writerLeaseEpoch: LeaseEpoch.make(1),
      outcome: failedOutcome,
    })
    expect(statusSummary._tag).toBe("Ready")
    expect(statusSummary.outcome._tag).toBe("Failed")
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStatusSummary)({
        _tag: "Offline",
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowStatusSummary)({
        _tag: "Ready",
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(WorkflowStatusSummary)({
        _tag: "Ready",
        writerLeaseEpoch: 0,
        outcome: { _tag: "NotFound" },
      }),
    ).toThrow()

    const rpcSuccess = Schema.decodeSync(WorkflowRpcSuccessEnvelope)({
      id: WorkflowRpcRequestId.make("req-1"),
      ok: true,
      command: "workflow.status",
      result: statusSummary,
    })
    const rpcErr = Schema.decodeSync(WorkflowRpcErrorEnvelope)({
      id: WorkflowRpcRequestId.make("req-2"),
      ok: false,
      command: "workflow.start",
      error: WorkflowStoreFailureReason.make("WorkflowDaemonError"),
      detail: WorkflowStoreFailureReason.make("failed"),
    })
    expect(Schema.decodeSync(WorkflowRpcEnvelope)(rpcSuccess).ok).toBe(true)
    expect(Schema.decodeSync(WorkflowRpcEnvelope)(rpcErr).ok).toBe(false)

    const toolOutput = Schema.decodeSync(WorkflowPlanToolOutput)({
      resolvedRepoRoot: repoRoot,
      commonGitDir,
      status: statusSummary,
    })
    expect(toolOutput.resolvedRepoRoot).toBe(repoRoot)
    expect(toolOutput.commonGitDir).toBe(commonGitDir)
    expect(() =>
      Schema.decodeSync(WorkflowPlanToolOutput)({
        resolvedRepoRoot: repoRoot,
        commonGitDir: "relative/.git",
        status: statusSummary,
      }),
    ).toThrow()
  })

  it("round-trips all closed WorkflowTerminalError, WorkflowCompleteResponse, and WorkflowResumeResponse variants", () => {
    const { runId, treeHash, runRecord } = makeWf3Fixtures()
    const executionId = runRecord.executionId
    const unitId = WorkUnitId.make("unit-a")
    const roundtrip = <A, E>(schema: Schema.Codec<A, E, never, never>, value: A): A => {
      const encoded = Schema.encodeSync(schema)(value)
      const decoded = Schema.decodeSync(schema)(encoded)
      expect(decoded).toEqual(value)
      return decoded
    }

    const terminalVariants: ReadonlyArray<WorkflowTerminalError> = [
      WorkflowTerminalError.cases.Aborted.make({
        runId,
        escalation: UnitEscalation.cases.AuthRequired.make({
          runner: RunnerId.make("claude-code"),
        }),
      }),
      WorkflowTerminalError.cases.OperatorAborted.make({
        runId,
        reason: WorkflowStoreFailureReason.make("cancelled by operator"),
      }),
      WorkflowTerminalError.cases.WorkspaceFs.make({
        operation: WorkspaceFsOperation.make("read"),
        reason: WorkflowStoreFailureReason.make("unreadable snapshot"),
      }),
      WorkflowTerminalError.cases.StoreUnavailable.make({
        operation: WorkflowStoreOperation.make("rebuild"),
        reason: WorkflowStoreFailureReason.make("daemon store offline"),
      }),
      WorkflowTerminalError.cases.LeaseHeld.make({
        holderId: LeaseHolderId.make("worker-1"),
        lockFilePath: LeaseFilePath.make("/tmp/repo/.git/harness/daemon.lock"),
      }),
      WorkflowTerminalError.cases.LeaseHeld.make({
        holderId: LeaseHolderId.make("worker-2"),
        leaseEpoch: LeaseEpoch.make(7),
        lockFilePath: LeaseFilePath.make("/tmp/repo/.git/harness/daemon.lock"),
      }),
      WorkflowTerminalError.cases.Interrupted.make({
        reason: WorkflowStoreFailureReason.make("fiber interrupted"),
      }),
      WorkflowTerminalError.cases.Defect.make({
        reason: WorkflowStoreFailureReason.make("unexpected fiber defect"),
      }),
    ]
    for (const variant of terminalVariants) {
      expect(roundtrip(WorkflowTerminalError, variant)._tag).toBe(variant._tag)
    }

    const completeVariants: ReadonlyArray<WorkflowCompleteResponse> = [
      WorkflowCompleteResponse.cases.UnitCompleted.make({
        runId,
        executionId,
        outcome: UnitOutcome.cases.Completed.make({
          unitId,
          attempt: AttemptNumber.make(1),
          changedPaths: [],
          packageStampHash: PackageStampHash.make("b".repeat(64)),
        }),
      }),
      WorkflowCompleteResponse.cases.LlmPhaseCompleted.make({
        runId,
        executionId,
        receipt: { workspaceHash: treeHash, frictionLogCleared: FrictionLogState.make("cleared") },
      }),
    ]
    for (const variant of completeVariants) {
      expect(roundtrip(WorkflowCompleteResponse, variant)._tag).toBe(variant._tag)
    }

    const resumeVariants: ReadonlyArray<WorkflowResumeResponse> = [
      WorkflowResumeResponse.cases.WorkflowResumed.make({ runId, executionId }),
      WorkflowResumeResponse.cases.EscalationResolved.make({
        runId,
        executionId,
        unitId,
        decision: EscalationDecision.make("retry"),
      }),
    ]
    for (const variant of resumeVariants) {
      expect(roundtrip(WorkflowResumeResponse, variant)._tag).toBe(variant._tag)
    }
  })
})
