import { Cause, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AGENT_USAGE_STATUSES,
  ANTIGRAVITY_MODES,
  AbsoluteRepoRoot,
  AgentAuthRequiredError,
  AgentCostUsd,
  AgentDiagnosticDetail,
  AgentDurationMillis,
  AgentExitCode,
  AgentExitError,
  AgentFailureReason,
  AgentMaxTurns,
  AgentNoChangeError,
  AgentOutputParseError,
  AgentResultText,
  AgentRunRequest,
  AgentRunResult,
  AgentRunnerError,
  AgentSessionId,
  AgentTimeoutError,
  AgentTokenCount,
  AgentToolDeniedError,
  AgentTurnCount,
  AgentUsage,
  AgentUsageStatus,
  AntigravityMode,
  AttemptNumber,
  BriefPrompt,
  CompleteUnitInput,
  DenialNotice,
  EXECUTABLE_NAMES,
  ExecutableName,
  GateExitCode,
  GitCommitSha,
  MCP_FALLBACK_POLICIES,
  MCP_ISOLATION_LEVELS,
  McpFallbackPolicy,
  McpIsolationLevel,
  ModelName,
  OwnedRelPath,
  PackageVerifyCommand,
  PackageVerifyFailureKind,
  PermissionRule,
  RunnerConfigFilePath,
  RunnerId,
  RunnerProfile,
  TimeoutMillis,
  UnitAgentRequest,
  UnitBrief,
  UnitRejection,
  WorkUnitId,
  WorkflowRunId,
  toAgentDiagnosticDetail,
  toAgentFailureReason,
  toDenialNotice,
} from "../src/index.js"

const expectDecodeSuccess = <A, E>(schema: Schema.Codec<A, E, never, never>, input: unknown): A => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  return match(exit)
    .with({ _tag: "Success" }, (s) => s.value)
    .with({ _tag: "Failure" }, (f) => {
      return expect.unreachable(`Expected decode to succeed: ${Cause.pretty(f.cause)}`)
    })
    .exhaustive()
}

const expectDecodeFailure = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  input: unknown,
): void => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  match(exit)
    .with({ _tag: "Failure" }, (f) => {
      expect(Cause.pretty(f.cause).length).toBeGreaterThan(0)
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable(`Expected decode to fail for input: ${String(input)}`)
    })
    .exhaustive()
}

const expectCases = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  valid: ReadonlyArray<unknown>,
  invalid: ReadonlyArray<unknown>,
): void => {
  for (const input of valid) {
    expect(expectDecodeSuccess(schema, input)).toBe(input)
  }
  for (const input of invalid) {
    expectDecodeFailure(schema, input)
  }
}

const SHA_40 = "0123456789abcdef0123456789abcdef01234567"

describe("@harness/contract workflow-runners schemas & helpers (SPEC-0036)", () => {
  it("validates ExecutableName, PermissionRule, ModelName, TimeoutMillis, and DenialNotice", () => {
    expect(EXECUTABLE_NAMES).toEqual(["claude", "agy"])
    expectCases(ExecutableName, ["claude", "agy"], ["", "bash", "claude ", "CLAUDE", 123, null])

    expectCases(
      PermissionRule,
      ["Read", "Edit(libs/harness/**)", "Bash(pnpm *)", "x".repeat(256)],
      [
        "",
        "   ",
        " Read",
        "Read ",
        "x".repeat(257),
        "--dangerously-skip-permissions",
        "allow --dangerously-skip-permissions always",
        123,
      ],
    )

    expectCases(
      ModelName,
      ["claude-sonnet-4-5", "gemini-2.5-pro", "org/model:v1_0.2", `a${"b".repeat(127)}`],
      [
        "",
        "   ",
        " claude-sonnet",
        "claude-sonnet ",
        "-starts-with-dash",
        ".starts-with-dot",
        "has space",
        "has$symbol",
        `a${"b".repeat(128)}`,
        null,
      ],
    )

    expectCases(
      TimeoutMillis,
      [1, 5_000, 600_000],
      [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5000", null],
    )

    expectCases(
      DenialNotice,
      ["Bash tool denied by policy", "a".repeat(1024)],
      ["", "   ", " leading", "trailing ", "a".repeat(1025), 42],
    )
  })

  it("validates AgentExitCode, AgentResultText, BriefPrompt, RunnerConfigFilePath, and AgentDiagnosticDetail", () => {
    expectCases(AgentExitCode, [0, 1, 137, 255], [-1, 256, 1.5, Number.NaN, "0", null])

    expectCases(
      AgentResultText,
      ["", "Unit completed cleanly", "r".repeat(262_144)],
      ["r".repeat(262_145), 123, null],
    )

    expectCases(
      BriefPrompt,
      ["Implement unit A", "p".repeat(65_536)],
      ["", "   ", " padded", "padded ", "p".repeat(65_537), null],
    )

    expectCases(
      RunnerConfigFilePath,
      ["/tmp/mcp.json", "/var/folders/harness/wf5-mcp_1.json", `/${"a".repeat(1023)}`],
      [
        "",
        "/",
        "relative/mcp.json",
        "/tmp/../mcp.json",
        "/tmp/./mcp.json",
        "/tmp//mcp.json",
        "/tmp/mcp.json/",
        " /tmp/mcp.json",
        "/tmp/mcp.json ",
        "/tmp\\mcp.json",
        "/tmp/\u0000mcp.json",
        "/tmp/\u001fmcp.json",
        "/tmp/\u007fmcp.json",
        `/${"a".repeat(1024)}`,
        null,
      ],
    )

    expectCases(
      AgentDiagnosticDetail,
      ["Process exited with stderr: missing token", "d".repeat(1024)],
      ["", "   ", " padded", "padded ", "d".repeat(1025), 123],
    )
  })

  it("validates AgentTokenCount, AgentTurnCount, AgentMaxTurns, AgentCostUsd, AgentDurationMillis, and AgentSessionId", () => {
    expectCases(AgentTokenCount, [0, 1, 125_000], [-1, 1.5, Number.NaN, "10", null])
    expectCases(AgentTurnCount, [0, 1, 40], [-1, 2.25, Number.NaN, "1", null])
    expectCases(AgentMaxTurns, [1, 15, 200], [0, -1, 201, 1.5, "10", null])
    expectCases(
      AgentCostUsd,
      [0, 0.0042, 12.5],
      [-0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5", null],
    )
    expectCases(AgentDurationMillis, [0, 1, 45_000], [-1, 1.2, Number.NaN, "100", null])
    expectCases(
      AgentSessionId,
      ["sess-001", "s".repeat(256)],
      ["", "   ", " sess-001", "sess-001 ", "s".repeat(257), 99],
    )
  })

  it("validates AntigravityMode, McpIsolationLevel, McpFallbackPolicy, and AgentUsageStatus literal unions", () => {
    expect(ANTIGRAVITY_MODES).toEqual(["accept-edits", "auto", "plan"])
    expectCases(AntigravityMode, ANTIGRAVITY_MODES, ["", "manual", "AUTO", null])
    for (const mode of ANTIGRAVITY_MODES) {
      const decoded = expectDecodeSuccess(AntigravityMode, mode)
      const label = match(decoded)
        .with("accept-edits", () => "accept-edits")
        .with("auto", () => "auto")
        .with("plan", () => "plan")
        .exhaustive()
      expect(label).toBe(mode)
    }

    expect(MCP_ISOLATION_LEVELS).toEqual(["standard", "hard"])
    expectCases(McpIsolationLevel, MCP_ISOLATION_LEVELS, ["", "soft", "none", null])
    for (const level of MCP_ISOLATION_LEVELS) {
      const decoded = expectDecodeSuccess(McpIsolationLevel, level)
      const label = match(decoded)
        .with("standard", () => "standard")
        .with("hard", () => "hard")
        .exhaustive()
      expect(label).toBe(level)
    }

    expect(MCP_FALLBACK_POLICIES).toEqual(["reject", "fallback-claude"])
    expectCases(McpFallbackPolicy, MCP_FALLBACK_POLICIES, ["", "ignore", "fallback-agy", null])
    for (const policy of MCP_FALLBACK_POLICIES) {
      const decoded = expectDecodeSuccess(McpFallbackPolicy, policy)
      const label = match(decoded)
        .with("reject", () => "reject")
        .with("fallback-claude", () => "fallback-claude")
        .exhaustive()
      expect(label).toBe(policy)
    }

    expect(AGENT_USAGE_STATUSES).toEqual(["reported", "unavailable"])
    expectCases(AgentUsageStatus, AGENT_USAGE_STATUSES, ["", "partial", null])
    for (const status of AGENT_USAGE_STATUSES) {
      const decoded = expectDecodeSuccess(AgentUsageStatus, status)
      const label = match(decoded)
        .with("reported", () => "reported")
        .with("unavailable", () => "unavailable")
        .exhaustive()
      expect(label).toBe(status)
    }
  })

  it("validates AgentUsage, UnitBrief, RunnerProfile (with binary/runner refinement), AgentRunRequest, and AgentRunResult", () => {
    const unavailableUsage = expectDecodeSuccess(AgentUsage, { status: "unavailable" })
    expect(unavailableUsage).toEqual({ status: "unavailable" })
    expect(Schema.encodeSync(AgentUsage)(unavailableUsage)).toEqual({ status: "unavailable" })

    const fullUsage = expectDecodeSuccess(AgentUsage, {
      status: "reported",
      inputTokens: 1200,
      outputTokens: 350,
      thinkingTokens: 150,
      totalTokens: 1700,
      numTurns: 4,
      totalCostUsd: 0.042,
      durationMillis: 9200,
      sessionId: "sess-abc-123",
    })
    expect(fullUsage.totalTokens).toBe(1700)
    expect(Schema.decodeSync(AgentUsage)(Schema.encodeSync(AgentUsage)(fullUsage))).toEqual(
      fullUsage,
    )
    expectDecodeFailure(AgentUsage, { status: "reported", inputTokens: -1 })
    expectDecodeFailure(AgentUsage, { status: "reported", totalCostUsd: -0.5 })
    expectDecodeFailure(AgentUsage, { status: "unknown" })

    const minimalBrief = expectDecodeSuccess(UnitBrief, {
      unitId: "unit-a",
      attempt: 1,
      promptText: "Implement contract tests",
      ownedRelPaths: ["libs/harness/contract/test/workflow-runners.test.ts"],
    })
    expect(minimalBrief.unitId).toBe("unit-a")

    const fullBrief = expectDecodeSuccess(UnitBrief, {
      unitId: "unit-a",
      attempt: 2,
      promptText: "Fix failure and re-verify",
      ownedRelPaths: ["libs/harness/contract/test/workflow-runners.test.ts"],
      packageVerifyCommand: "nx run @harness/contract:verify",
      mcpConfigPath: "/tmp/wf5/mcp-strict.json",
    })
    expect(Schema.decodeSync(UnitBrief)(Schema.encodeSync(UnitBrief)(fullBrief))).toEqual(fullBrief)
    expectDecodeFailure(UnitBrief, {
      unitId: "unit-a",
      attempt: 4,
      promptText: "Invalid attempt",
      ownedRelPaths: [],
    })
    expectDecodeFailure(UnitBrief, {
      unitId: "unit-a",
      attempt: 1,
      promptText: "Invalid mcp config path",
      ownedRelPaths: [],
      mcpConfigPath: "relative/mcp.json",
    })

    const claudeProfile = expectDecodeSuccess(RunnerProfile, {
      runner: "claude-code",
      binary: "claude",
      permissionRules: ["Read", "Edit(libs/harness/**)", "Bash(pnpm *)"],
      disallowedTools: ["WebFetch"],
      maxConcurrency: 2,
      timeoutMillis: 600_000,
      maxTurns: 40,
      model: "claude-sonnet-4-5",
    })
    expect(claudeProfile.binary).toBe("claude")
    expect(
      Schema.decodeSync(RunnerProfile)(Schema.encodeSync(RunnerProfile)(claudeProfile)),
    ).toEqual(claudeProfile)

    const agyProfile = expectDecodeSuccess(RunnerProfile, {
      runner: "antigravity",
      binary: "agy",
      permissionRules: ["Read"],
      disallowedTools: [],
      maxConcurrency: 1,
      timeoutMillis: 600_000,
      model: "gemini-2.5-pro",
      antigravityMode: "accept-edits",
    })
    expect(agyProfile.binary).toBe("agy")
    expect(Schema.decodeSync(RunnerProfile)(Schema.encodeSync(RunnerProfile)(agyProfile))).toEqual(
      agyProfile,
    )

    // Binary / runner mismatch rejections
    expectDecodeFailure(RunnerProfile, {
      runner: "claude-code",
      binary: "agy",
      permissionRules: [],
      disallowedTools: [],
      maxConcurrency: 1,
      timeoutMillis: 60_000,
    })
    expectDecodeFailure(RunnerProfile, {
      runner: "antigravity",
      binary: "claude",
      permissionRules: [],
      disallowedTools: [],
      maxConcurrency: 1,
      timeoutMillis: 60_000,
    })
    // PermissionRule guard inside RunnerProfile
    expectDecodeFailure(RunnerProfile, {
      runner: "claude-code",
      binary: "claude",
      permissionRules: ["--dangerously-skip-permissions"],
      disallowedTools: [],
      maxConcurrency: 1,
      timeoutMillis: 60_000,
    })

    const minimalRequest = expectDecodeSuccess(AgentRunRequest, {
      runner: "claude-code",
      brief: minimalBrief,
      cwd: "/repo/worktrees/wf5",
    })
    expect(minimalRequest.runId).toBeUndefined()

    const fullRequest = expectDecodeSuccess(AgentRunRequest, {
      runId: "wf5-run-001",
      runner: "antigravity",
      brief: fullBrief,
      cwd: "/repo/worktrees/wf5",
      mcpIsolation: "hard",
      hardMcpFallback: "fallback-claude",
    })
    expect(
      Schema.decodeSync(AgentRunRequest)(Schema.encodeSync(AgentRunRequest)(fullRequest)),
    ).toEqual(fullRequest)
    expectDecodeFailure(AgentRunRequest, {
      runner: "claude-code",
      brief: minimalBrief,
      cwd: "relative/worktree",
    })

    const runResult = expectDecodeSuccess(AgentRunResult, {
      runner: "claude-code",
      exit: 0,
      resultText: "All checks passed",
      usage: fullUsage,
    })
    expect(Schema.decodeSync(AgentRunResult)(Schema.encodeSync(AgentRunResult)(runResult))).toEqual(
      runResult,
    )
    expectDecodeFailure(AgentRunResult, {
      runner: "claude-code",
      exit: 256,
      resultText: "Bad exit code",
      usage: unavailableUsage,
    })
  })

  it("formats bounded DenialNotice, AgentDiagnosticDetail, and AgentFailureReason with truncation and fallbacks", () => {
    expect(toDenialNotice("  Bash denied  ")).toBe(DenialNotice.make("Bash denied"))
    expect(toDenialNotice("")).toBe(DenialNotice.make("Agent tool permission denied"))
    expect(toDenialNotice("   \n\t  ")).toBe(DenialNotice.make("Agent tool permission denied"))
    expect(toDenialNotice("  ", "Custom denial fallback")).toBe(
      DenialNotice.make("Custom denial fallback"),
    )

    const longNoticeRaw = `HEAD_OMITTED_${"x".repeat(1500)}_DENIAL_TAIL`
    const boundedNotice = toDenialNotice(longNoticeRaw)
    expect(boundedNotice.length).toBeLessThanOrEqual(1024)
    expect(boundedNotice.endsWith("_DENIAL_TAIL")).toBe(true)
    expect(Schema.decodeSync(DenialNotice)(boundedNotice)).toBe(boundedNotice)

    expect(toAgentDiagnosticDetail("  stderr output  ")).toBe(
      AgentDiagnosticDetail.make("stderr output"),
    )
    expect(toAgentDiagnosticDetail("")).toBe(
      AgentDiagnosticDetail.make("Agent runner execution failed"),
    )
    expect(toAgentDiagnosticDetail("   ", "Custom diagnostic fallback")).toBe(
      AgentDiagnosticDetail.make("Custom diagnostic fallback"),
    )

    const longDetailRaw = `HEAD_OMITTED_${"y".repeat(1500)}_DIAG_TAIL`
    const boundedDetail = toAgentDiagnosticDetail(longDetailRaw)
    expect(boundedDetail.length).toBeLessThanOrEqual(1024)
    expect(boundedDetail.endsWith("_DIAG_TAIL")).toBe(true)
    expect(Schema.decodeSync(AgentDiagnosticDetail)(boundedDetail)).toBe(boundedDetail)

    expect(toAgentFailureReason("Runner failed")).toBe(AgentFailureReason.make("Runner failed"))
    expect(toAgentFailureReason("Runner failed", "   ")).toBe(
      AgentFailureReason.make("Runner failed"),
    )
    expect(toAgentFailureReason("Runner failed", "  exit 2  ")).toBe(
      AgentFailureReason.make("Runner failed: exit 2"),
    )
    expect(toAgentFailureReason("   ")).toBe(AgentFailureReason.make("Agent runner failed"))
    expect(toAgentFailureReason("   ", "   ")).toBe(AgentFailureReason.make("Agent runner failed"))

    const longReasonDetail = `HEAD_${"z".repeat(2500)}_REASON_TAIL`
    const boundedReason = toAgentFailureReason("Runner failed", longReasonDetail)
    expect(boundedReason.length).toBeLessThanOrEqual(2048)
    expect(boundedReason.startsWith("Runner failed: ")).toBe(true)
    expect(boundedReason.endsWith("_REASON_TAIL")).toBe(true)
    expect(Schema.decodeSync(AgentFailureReason)(boundedReason)).toBe(boundedReason)

    const longPrefix = `PREFIX_${"p".repeat(2500)}`
    const boundedPrefixReason = toAgentFailureReason(longPrefix)
    expect(boundedPrefixReason.length).toBe(2048)
    expect(boundedPrefixReason.startsWith("PREFIX_")).toBe(true)
    expect(Schema.decodeSync(AgentFailureReason)(boundedPrefixReason)).toBe(boundedPrefixReason)
  })

  it("constructs all 6 AgentRunnerError variants with expected .message getters and Schema round-trips", () => {
    const claude = RunnerId.make("claude-code")
    const antigravity = RunnerId.make("antigravity")

    const timeoutErr = new AgentTimeoutError({
      runner: claude,
      afterMillis: TimeoutMillis.make(5_000),
    })
    expect(timeoutErr.message).toBe("Runner 'claude-code' timed out after 5000ms")

    const deniedErr = new AgentToolDeniedError({
      runner: claude,
      notice: DenialNotice.make("Bash not allowed"),
    })
    expect(deniedErr.message).toBe("Runner 'claude-code' tool denied: Bash not allowed")

    const authNoDetailErr = new AgentAuthRequiredError({ runner: antigravity })
    expect(authNoDetailErr.message).toBe("Runner 'antigravity' requires authentication")

    const authWithDetailErr = new AgentAuthRequiredError({
      runner: antigravity,
      detail: AgentDiagnosticDetail.make("token expired"),
    })
    expect(authWithDetailErr.message).toBe(
      "Runner 'antigravity' requires authentication: token expired",
    )

    const exitNoDetailErr = new AgentExitError({
      runner: claude,
      exit: AgentExitCode.make(1),
    })
    expect(exitNoDetailErr.message).toBe("Runner 'claude-code' exited with code 1")

    const exitWithDetailErr = new AgentExitError({
      runner: claude,
      exit: AgentExitCode.make(2),
      detail: AgentDiagnosticDetail.make("crash"),
    })
    expect(exitWithDetailErr.message).toBe("Runner 'claude-code' exited with code 2: crash")

    const parseNoDetailErr = new AgentOutputParseError({ runner: claude })
    expect(parseNoDetailErr.message).toBe("Runner 'claude-code' produced invalid JSON output")

    const parseWithDetailErr = new AgentOutputParseError({
      runner: claude,
      detail: AgentDiagnosticDetail.make("unexpected EOF"),
    })
    expect(parseWithDetailErr.message).toBe(
      "Runner 'claude-code' produced invalid JSON output: unexpected EOF",
    )

    const noChangeErr = new AgentNoChangeError({ runner: antigravity })
    expect(noChangeErr.message).toBe(
      "Runner 'antigravity' produced no file changes in unit worktree",
    )

    const allErrors: ReadonlyArray<AgentRunnerError> = [
      timeoutErr,
      deniedErr,
      authNoDetailErr,
      authWithDetailErr,
      exitNoDetailErr,
      exitWithDetailErr,
      parseNoDetailErr,
      parseWithDetailErr,
      noChangeErr,
    ]

    for (const err of allErrors) {
      const encoded = Schema.encodeSync(AgentRunnerError)(err)
      const decoded = Schema.decodeSync(AgentRunnerError)(encoded)
      const tag = match(decoded)
        .with({ _tag: "AgentTimeoutError" }, (e) => e._tag)
        .with({ _tag: "AgentToolDeniedError" }, (e) => e._tag)
        .with({ _tag: "AgentAuthRequiredError" }, (e) => e._tag)
        .with({ _tag: "AgentExitError" }, (e) => e._tag)
        .with({ _tag: "AgentOutputParseError" }, (e) => e._tag)
        .with({ _tag: "AgentNoChangeError" }, (e) => e._tag)
        .exhaustive()
      expect(tag).toBe(err._tag)
      expect(decoded.message).toBe(err.message)
    }

    expectDecodeFailure(AgentRunnerError, { _tag: "UnknownRunnerError", runner: "claude-code" })
    expectDecodeFailure(AgentRunnerError, {
      _tag: "AgentTimeoutError",
      runner: "claude-code",
      afterMillis: 0,
    })
    expectDecodeFailure(AgentRunnerError, {
      _tag: "AgentExitError",
      runner: "claude-code",
      exit: 256,
    })
  })

  it("validates UnitAgentRequest with optional priorRejection and CompleteUnitInput with optional runner", () => {
    const unit = {
      _tag: "PackageUnit" as const,
      unitId: WorkUnitId.make("wf5-contract"),
      projectName: "@harness/contract",
      waveIndex: 0,
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/harness/contract/test/workflow-runners.test.ts")],
      stubKeys: [],
      earsKeys: [],
      packageVerifyCommand: PackageVerifyCommand.make("nx run @harness/contract:verify"),
    }

    const requestWithoutPrior = expectDecodeSuccess(UnitAgentRequest, {
      runId: WorkflowRunId.make("wf5-run-001"),
      unit,
      attempt: AttemptNumber.make(1),
      runner: RunnerId.make("claude-code"),
      cwd: AbsoluteRepoRoot.make("/repo/worktrees/wf5"),
    })
    expect(requestWithoutPrior.priorRejection).toBeUndefined()
    expect(
      Schema.decodeSync(UnitAgentRequest)(Schema.encodeSync(UnitAgentRequest)(requestWithoutPrior)),
    ).toEqual(requestWithoutPrior)

    const rejections: ReadonlyArray<UnitRejection> = [
      UnitRejection.cases.WriteSetViolation.make({
        offendingPaths: [OwnedRelPath.make("libs/harness/infra/src/foo.ts")],
      }),
      UnitRejection.cases.PackageVerifyFailed.make({
        exitCode: GateExitCode.make(1),
        failureKind: PackageVerifyFailureKind.make("non-zero-exit"),
      }),
      UnitRejection.cases.StampMissing.make({}),
      UnitRejection.cases.AgentFailed.make({
        reason: AgentFailureReason.make("Runner timed out"),
      }),
    ]

    for (const priorRejection of rejections) {
      const requestWithPrior = expectDecodeSuccess(UnitAgentRequest, {
        runId: WorkflowRunId.make("wf5-run-001"),
        unit,
        attempt: AttemptNumber.make(2),
        runner: RunnerId.make("antigravity"),
        cwd: AbsoluteRepoRoot.make("/repo/worktrees/wf5"),
        priorRejection,
      })
      expect(requestWithPrior.priorRejection).toEqual(priorRejection)
      expect(
        Schema.decodeSync(UnitAgentRequest)(Schema.encodeSync(UnitAgentRequest)(requestWithPrior)),
      ).toEqual(requestWithPrior)
    }

    const completeWithoutRunner = expectDecodeSuccess(CompleteUnitInput, {
      runId: WorkflowRunId.make("wf5-run-001"),
      level: "slice",
      baseSha: GitCommitSha.make(SHA_40),
      unit,
      attempt: AttemptNumber.make(1),
      cwd: AbsoluteRepoRoot.make("/repo/worktrees/wf5"),
      siblingInFlightOwnedPaths: [],
    })
    expect(completeWithoutRunner.runner).toBeUndefined()
    expect(
      Schema.decodeSync(CompleteUnitInput)(
        Schema.encodeSync(CompleteUnitInput)(completeWithoutRunner),
      ),
    ).toEqual(completeWithoutRunner)

    for (const runner of ["claude-code", "antigravity"] as const) {
      const completeWithRunner = expectDecodeSuccess(CompleteUnitInput, {
        runId: WorkflowRunId.make("wf5-run-001"),
        level: "slice",
        baseSha: GitCommitSha.make(SHA_40),
        unit,
        attempt: AttemptNumber.make(1),
        cwd: AbsoluteRepoRoot.make("/repo/worktrees/wf5"),
        siblingInFlightOwnedPaths: [],
        runner,
      })
      expect(completeWithRunner.runner).toBe(runner)
      expect(
        Schema.decodeSync(CompleteUnitInput)(
          Schema.encodeSync(CompleteUnitInput)(completeWithRunner),
        ),
      ).toEqual(completeWithRunner)
    }

    expectDecodeFailure(CompleteUnitInput, {
      runId: "wf5-run-001",
      level: "slice",
      baseSha: SHA_40,
      unit,
      attempt: 1,
      cwd: "/repo/worktrees/wf5",
      siblingInFlightOwnedPaths: [],
      runner: "unknown-runner",
    })
  })

  it("rejects '-' prefixed BriefPrompt values and guards blank custom fallbacks in bounded helpers", () => {
    expectDecodeFailure(BriefPrompt, "--dangerously-skip-permissions")
    expectDecodeFailure(BriefPrompt, "-p inject")
    expect(toDenialNotice("", "   ")).toBe(DenialNotice.make("Agent tool permission denied"))
    expect(toAgentDiagnosticDetail("   ", "\t\n")).toBe(
      AgentDiagnosticDetail.make("Agent runner execution failed"),
    )
  })
})
