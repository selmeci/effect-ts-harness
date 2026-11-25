import { createHash } from "node:crypto"
import { Cause, Exit, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  AstGateEvaluationReport,
  AstGatePackageTag,
  AstGateViolationContract,
  AstSourceFilePath,
  CompiledPlan,
  CompiledWaves,
  type CompiledWorkUnit,
  CompilerVersionTag,
  ContentSha256,
  CyclicPlanWorkflowError,
  DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
  DisjointOwnershipViolationError,
  EarsRequirementKey,
  EnclosingSymbolName,
  ErrorReasonMessage,
  EvaluatorId,
  GateCategory,
  GateRuleId,
  GateRuleSourceSnapshot,
  GateRuleVersion,
  GateViolationMessage,
  GitCommitSha,
  HARNESS_AST_GATE_CACHE_FILENAME,
  HARNESS_DECISION_CACHE_FILENAME,
  HarnessTierTopologyReport,
  InvalidPlanWorkflowGraphError,
  NonNegativeCount,
  NxScopeTag,
  NxTierTag,
  OwnedRelPath,
  PackageUnitDraft,
  PersistedAstCacheEntry,
  PersistedAstCacheKey,
  PersistedAstCacheStore,
  PlanSha256,
  SelfDogfoodingMessage,
  SelfDogfoodingReport,
  SelfDogfoodingRuleId,
  SliceBranchName,
  SliceUnitDraft,
  SourceLineNumber,
  SubprocessMaxBufferBytes,
  TierTopologyMessage,
  WaveIndex,
  WorkUnitDraft,
  WorkUnitId,
  WorkflowCompileReason,
  WorkflowLevel,
  WorkflowRunId,
  WorkspaceFilePath,
  compareCodeUnits,
  computeContentSha256,
  computeGateRuleVersionFromSources,
  isPureInterruptCause,
  makeAstGateEvaluationReport,
  makeHarnessTierTopologyReport,
  makePersistedAstCacheKey,
  makeVerdictReport,
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
  wavesOf,
} from "../src/index.js"

describe("@harness/contract AST, SHA-256 & gate primitives", () => {
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
    expect(toMcpToolInputName("t".repeat(256))).toBe("t".repeat(256))
    expect(toMcpToolInputName("t".repeat(257))).toHaveLength(256)
    expect(toMcpToolInputName("t".repeat(300))).toHaveLength(256)
    expect(toCompilerRepoRootInput("/".repeat(4096))).toBe("/".repeat(4096))
    expect(toCompilerRepoRootInput("/".repeat(4097))).toHaveLength(4096)
    expect(toCompilerRepoRootInput("/".repeat(5000))).toHaveLength(4096)
    const mcpLongA = toMcpToolInputName(`${"t".repeat(299)}a`)
    const mcpLongB = toMcpToolInputName(`${"t".repeat(299)}b`)
    expect(mcpLongA).not.toBe(mcpLongB)
    expect(mcpLongA).toContain("…[len=300,h=")
    const mcpSurrogateLowBound = toMcpToolInputName(
      `${"x".repeat(226)}\uD800\uDC00${"y".repeat(60)}`,
    )
    expect(mcpSurrogateLowBound).toHaveLength(255)
    expect(() => encodeURIComponent(mcpSurrogateLowBound)).not.toThrow()
    const mcpSurrogateHighBound = toMcpToolInputName(
      `${"x".repeat(226)}\uDBFF\uDFFF${"y".repeat(60)}`,
    )
    expect(mcpSurrogateHighBound).toHaveLength(255)
    expect(() => encodeURIComponent(mcpSurrogateHighBound)).not.toThrow()
    const mcpNonSurrogate = toMcpToolInputName(`${"x".repeat(226)}\uD7FF${"y".repeat(60)}`)
    expect(mcpNonSurrogate).toHaveLength(256)
    const mcpAllSurrogates = toMcpToolInputName("😀".repeat(150))
    expect(mcpAllSurrogates.length).toBeLessThanOrEqual(256)
    expect(() => encodeURIComponent(mcpAllSurrogates)).not.toThrow()
    const rootLongA = toCompilerRepoRootInput(`${"/".repeat(4999)}a`)
    const rootLongB = toCompilerRepoRootInput(`${"/".repeat(4999)}b`)
    expect(rootLongA).not.toBe(rootLongB)
    expect(rootLongA).toContain("…[len=5000,h=")
    const rootSurrogateSplit = toCompilerRepoRootInput(
      `${"/".repeat(4065)}\u{1F680}${"z".repeat(80)}`,
    )
    expect(rootSurrogateSplit).toHaveLength(4095)
    expect(() => encodeURIComponent(rootSurrogateSplit)).not.toThrow()
    expect(toCompilerOverlayErrorReason("e".repeat(9000))).toHaveLength(8192)
    const boomOverlayReason = toCompilerOverlayErrorReason(`boom-${"z".repeat(9000)}`)
    expect(boomOverlayReason).toHaveLength(8192)
    expect(boomOverlayReason.startsWith("boom-")).toBe(true)
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
})
