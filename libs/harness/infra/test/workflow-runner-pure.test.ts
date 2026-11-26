import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AgentAuthRequiredError,
  AgentCostUsd,
  AgentDurationMillis,
  AgentExitCode,
  AgentExitError,
  AgentFailureReason,
  AgentMaxTurns,
  AgentNoChangeError,
  AgentOutputParseError,
  AgentSessionId,
  AgentTimeoutError,
  AgentTokenCount,
  AgentToolDeniedError,
  AgentTurnCount,
  AttemptNumber,
  CompiledWorkUnit,
  EarsRequirementKey,
  ExecutableName,
  GateExitCode,
  MaxConcurrency,
  ModelName,
  NxProjectName,
  OwnedRelPath,
  PackageVerifyCommand,
  PackageVerifyFailureDetail,
  PermissionRule,
  RunnerConfigFilePath,
  type RunnerId,
  RunnerProfile,
  SliceBranchName,
  StubSymbolKey,
  TimeoutMillis,
  UnitRejection,
  WORKFLOW_TIMEOUT_BUDGETS,
  WaveIndex,
  WorkUnitId,
  toAgentDiagnosticDetail,
  toDenialNotice,
} from "@harness/contract"
import { NodeKey, PageRankScoreMillis, type TypedHoleContextBundle } from "@harness/graph"
import {
  ANTIGRAVITY_RUNNER_PROFILE,
  CLAUDE_CODE_RUNNER_PROFILE,
  RUNNER_PROFILES,
  buildAntigravityArgv,
  buildClaudeCodeArgv,
  buildClaudeHooksSettingsJson,
  buildClaudeMcpConfigJson,
  buildRunnerEnv,
  buildUnitBrief,
  getRunnerProfile,
  isRetryableAntigravityStartupFailure,
  parseAntigravityOutput,
  parseClaudeCodeOutput,
  toOutcome,
  toUnitAgentDispatchResult,
} from "../src/index.js"
import { resolveHarnessInstallationRoot } from "../src/workflow/runner-profiles.js"

const HooksJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    hooks: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          matcher: Schema.String,
          hooks: Schema.Array(
            Schema.Struct({ type: Schema.String, command: Schema.String, timeout: Schema.Finite }),
          ),
        }),
      ),
    ),
  }),
)

const McpJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(
      Schema.String,
      Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) }),
    ),
  }),
)

const unwrapSuccess = <A, E>(result: Result.Result<A, E>): A =>
  match(result)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      throw new Error(`Expected Result.Success, got Failure: ${String(failure)}`)
    })
    .exhaustive()

const unwrapFailure = <A, E>(result: Result.Result<A, E>): E =>
  match(result)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => {
      throw new Error(`Expected Result.Failure, got Success: ${JSON.stringify(success)}`)
    })
    .exhaustive()

const authErr = (runner: RunnerId, detail: string) =>
  new AgentAuthRequiredError({ runner, detail: toAgentDiagnosticDetail(detail) })
const exitErr = (runner: RunnerId, exit: number, detail?: string) =>
  new AgentExitError({
    runner,
    exit: AgentExitCode.make(exit),
    ...(detail !== undefined ? { detail: toAgentDiagnosticDetail(detail) } : {}),
  })
const parseErr = (runner: RunnerId, detail: string) =>
  new AgentOutputParseError({ runner, detail: toAgentDiagnosticDetail(detail) })
const deniedErr = (runner: RunnerId, notice: string) =>
  new AgentToolDeniedError({ runner, notice: toDenialNotice(notice) })
const claudeOk = (body: Record<string, unknown>) =>
  unwrapSuccess(parseClaudeCodeOutput(0, JSON.stringify(body), ""))
const agyOk = (body: Record<string, unknown>) =>
  unwrapSuccess(parseAntigravityOutput(0, JSON.stringify(body), ""))
const mkProfile = (
  runner: RunnerId,
  extra: Partial<Omit<RunnerProfile, "runner" | "binary">> = {},
): RunnerProfile =>
  RunnerProfile.make({
    runner,
    binary: ExecutableName.make(runner === "claude-code" ? "claude" : "agy"),
    permissionRules: [],
    disallowedTools: [],
    maxConcurrency: MaxConcurrency.make(1),
    timeoutMillis: TimeoutMillis.make(1000),
    ...extra,
  })

describe("WF-5 pure runner profiles, env/argv builders, outcome parsers, and brief builder", () => {
  const repoRoot = AbsoluteRepoRoot.make("/workspace/repo")
  const pkgUnit = Schema.decodeSync(CompiledWorkUnit)({
    _tag: "PackageUnit",
    unitId: WorkUnitId.make("pkg-infra"),
    projectName: NxProjectName.make("harness-infra"),
    waveIndex: WaveIndex.make(0),
    dependsOn: [],
    ownedRelPaths: [OwnedRelPath.make("libs/harness/infra/src/workflow/runner-profiles.ts")],
    stubKeys: [StubSymbolKey.make("buildUnitBrief")],
    earsKeys: [EarsRequirementKey.make("harness:SPEC-0036/REQ-4.1")],
    packageVerifyCommand: PackageVerifyCommand.make("nx run harness-infra:verify"),
  })
  const sliceUnit = Schema.decodeSync(CompiledWorkUnit)({
    _tag: "SliceUnit",
    unitId: WorkUnitId.make("slice-wf5"),
    branch: SliceBranchName.make("slice/wf5-runners"),
    waveIndex: WaveIndex.make(1),
    dependsOn: [WorkUnitId.make("pkg-infra")],
    ownedRelPaths: [],
    earsKeys: [],
  })

  describe("runner-profiles", () => {
    it("exposes validated TCB profiles and resolves getRunnerProfile exhaustively", () => {
      expect(CLAUDE_CODE_RUNNER_PROFILE).toMatchObject({
        runner: "claude-code",
        binary: "claude",
        maxConcurrency: 4,
        timeoutMillis: WORKFLOW_TIMEOUT_BUDGETS.agentRunClaudeMs,
        maxTurns: 40,
        model: "claude-sonnet-4-6",
      })
      expect(CLAUDE_CODE_RUNNER_PROFILE.disallowedTools).toEqual([
        "Bash(pnpm harness done*)",
        "Bash(pnpm harness workflow start*)",
        "Bash(pnpm harness workflow resume*)",
        "Bash(pnpm harness workflow ship*)",
        "Bash(pnpm harness workflow abort*)",
        "Bash(pnpm harness workflow doctor*)",
        "Bash(alchemy deploy*)",
        "Bash(alchemy destroy*)",
        "Bash(rm -rf*)",
      ])
      expect(ANTIGRAVITY_RUNNER_PROFILE).toMatchObject({
        runner: "antigravity",
        binary: "agy",
        permissionRules: [PermissionRule.make("accept-edits")],
        disallowedTools: [],
        maxConcurrency: 2,
        timeoutMillis: WORKFLOW_TIMEOUT_BUDGETS.agentRunAntigravityMs,
        model: "gemini-4-hydrogen-high",
        antigravityMode: "accept-edits",
      })
      expect(getRunnerProfile("claude-code")).toBe(CLAUDE_CODE_RUNNER_PROFILE)
      expect(getRunnerProfile("antigravity")).toBe(ANTIGRAVITY_RUNNER_PROFILE)
      expect(RUNNER_PROFILES).toEqual({
        "claude-code": CLAUDE_CODE_RUNNER_PROFILE,
        antigravity: ANTIGRAVITY_RUNNER_PROFILE,
      })
    })

    it("builds claude-code and antigravity argv without --dangerously-skip-permissions", () => {
      const fullArgv = buildClaudeCodeArgv({
        profile: CLAUDE_CODE_RUNNER_PROFILE,
        promptText: "Implement unit",
        mcpConfigPath: "/tmp/mcp.json",
        hooksSettingsPath: "/tmp/hooks.json",
      })
      expect(fullArgv).toEqual([
        "-p",
        "Implement unit",
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/mcp.json",
        "--setting-sources",
        "",
        "--settings",
        "/tmp/hooks.json",
        "--allowedTools",
        "Read,Edit,Write,MultiEdit,Glob,Grep,Bash",
        "--disallowedTools",
        CLAUDE_CODE_RUNNER_PROFILE.disallowedTools.join(","),
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        "40",
        "--model",
        "claude-sonnet-4-6",
      ])
      expect(fullArgv).not.toContain("--dangerously-skip-permissions")

      const minimalArgv = buildClaudeCodeArgv({
        profile: mkProfile("claude-code"),
        promptText: "Minimal",
        mcpConfigPath: "/tmp/m.json",
        hooksSettingsPath: "/tmp/h.json",
      })
      expect(minimalArgv).toEqual([
        "-p",
        "Minimal",
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/m.json",
        "--setting-sources",
        "",
        "--settings",
        "/tmp/h.json",
        "--permission-mode",
        "dontAsk",
      ])
      expect(minimalArgv).not.toContain("--dangerously-skip-permissions")

      const agyFull = buildAntigravityArgv({
        profile: ANTIGRAVITY_RUNNER_PROFILE,
        promptText: "Solve unit",
      })
      expect(agyFull).toEqual([
        "-p",
        "Solve unit",
        "--output-format",
        "json",
        "--print-timeout",
        "600s",
        "--model",
        "gemini-4-hydrogen-high",
        "--mode",
        "accept-edits",
      ])
      expect(agyFull).not.toContain("--dangerously-skip-permissions")

      expect(
        buildAntigravityArgv({
          profile: mkProfile("antigravity", { timeoutMillis: TimeoutMillis.make(500) }),
          promptText: "Fast",
        }),
      ).toEqual(["-p", "Fast", "--output-format", "json", "--print-timeout", "1s"])
      expect(
        buildAntigravityArgv({
          profile: mkProfile("antigravity", { timeoutMillis: TimeoutMillis.make(1500) }),
          promptText: "TwoSec",
        }),
      ).toEqual(["-p", "TwoSec", "--output-format", "json", "--print-timeout", "2s"])
    })

    it("builds Claude PreToolUse-only hooks settings with POSIX single-quoting and scoped MCP config JSON", () => {
      const hooksRaw = buildClaudeHooksSettingsJson("/repo/worktree")
      const hooksParsed = Schema.decodeSync(HooksJsonSchema)(hooksRaw)
      expect(Object.keys(hooksParsed.hooks)).toEqual(["PreToolUse"])
      const preToolUse = hooksParsed.hooks["PreToolUse"]!
      expect(preToolUse.map((entry) => entry.matcher)).toEqual([
        "Bash",
        "Edit|Write|MultiEdit",
        "Read|Grep|Glob|LS|Find",
      ])
      for (const entry of preToolUse) {
        expect(entry.hooks).toEqual([
          {
            type: "command",
            command:
              "node --import '/repo/worktree/tools/node-ts-resolver.mjs' '/repo/worktree/apps/harness-cli/src/hook-entry.ts' guard || exit 2",
            timeout: 15,
          },
        ])
      }

      const specialHooks = Schema.decodeSync(HooksJsonSchema)(
        buildClaudeHooksSettingsJson("/tmp/roan's repo/work tree"),
      )
      expect(specialHooks.hooks["PreToolUse"]![0]!.hooks[0]!.command).toBe(
        "node --import '/tmp/roan'\\''s repo/work tree/tools/node-ts-resolver.mjs' '/tmp/roan'\\''s repo/work tree/apps/harness-cli/src/hook-entry.ts' guard || exit 2",
      )

      const installedRoot = resolveHarnessInstallationRoot()
      const defaultHooks = Schema.decodeSync(HooksJsonSchema)(buildClaudeHooksSettingsJson())
      expect(defaultHooks.hooks["PreToolUse"]![0]!.hooks[0]!.command).toBe(
        `node --import '${installedRoot}/tools/node-ts-resolver.mjs' '${installedRoot}/apps/harness-cli/src/hook-entry.ts' guard || exit 2`,
      )

      const emptyMcp = Schema.decodeSync(McpJsonSchema)(buildClaudeMcpConfigJson())
      expect(emptyMcp).toEqual({ mcpServers: {} })

      const blankMcp = Schema.decodeSync(McpJsonSchema)(buildClaudeMcpConfigJson("   "))
      expect(blankMcp).toEqual({ mcpServers: {} })

      const withHarnessMcp = Schema.decodeSync(McpJsonSchema)(
        buildClaudeMcpConfigJson("/repo/apps/harness-mcp/src/server.ts", "/custom/harness-root"),
      )
      expect(withHarnessMcp).toEqual({
        mcpServers: {
          "harness-mcp": {
            command: "node",
            args: [
              "--import",
              "/custom/harness-root/tools/node-ts-resolver.mjs",
              "/repo/apps/harness-mcp/src/server.ts",
            ],
          },
        },
      })

      const defaultRootMcp = Schema.decodeSync(McpJsonSchema)(
        buildClaudeMcpConfigJson("/repo/apps/harness-mcp/src/server.ts"),
      )
      expect(defaultRootMcp.mcpServers["harness-mcp"]!.args[1]).toBe(
        `${installedRoot}/tools/node-ts-resolver.mjs`,
      )
    })

    it("builds allow-listed runner env forwarding all 24 base keys and stripping nested/secret vars", () => {
      const baseKeys24 =
        "PATH HOME USER LOGNAME SHELL TERM LANG LC_ALL LC_CTYPE TZ TMPDIR XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME NODE_OPTIONS PNPM_HOME COREPACK_HOME GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL NO_COLOR CI".split(
          " ",
        )
      expect(baseKeys24).toHaveLength(24)
      const baseAllowlist24 = Object.fromEntries(baseKeys24.map((k) => [k, `val-${k}`]))
      const parentEnv: Readonly<Record<string, string | undefined>> = {
        ...baseAllowlist24,
        ANTHROPIC_API_KEY: "sk-ant-secret",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "0",
        ANTIGRAVITY_SESSION_ID: "nested-session",
        AGY_TOKEN: "agy-secret",
        CLOUDFLARE_API_TOKEN: "cf-secret",
        CLOUDFLARE_ACCOUNT_ID: "cf-acct",
        OMNIGRAPH_TOKEN: "og-secret",
        HARNESS_OMNIGRAPH_AUTH_TOKEN: "og-auth",
        HARNESS_WORKTREE_ID: "wt-1",
        HARNESS_STATE_DIR: "/tmp/state",
        HARNESS_UNIT_WORKER: "0",
      }

      expect(buildRunnerEnv("claude-code", parentEnv)).toEqual({
        ...baseAllowlist24,
        ANTHROPIC_API_KEY: "sk-ant-secret",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "0",
        HARNESS_UNIT_WORKER: "1",
      })
      const agyEnv = buildRunnerEnv("antigravity", parentEnv)
      expect(agyEnv).toEqual({ ...baseAllowlist24, HARNESS_UNIT_WORKER: "1" })
      expect("ANTHROPIC_API_KEY" in agyEnv).toBe(false)
      expect("ANTIGRAVITY_SESSION_ID" in agyEnv).toBe(false)
      expect("AGY_TOKEN" in agyEnv).toBe(false)
      expect("LOGNAME" in buildRunnerEnv("antigravity", { LOGNAME: undefined })).toBe(false)
    })
  })

  describe("agent-runner-outcome", () => {
    const unitId = WorkUnitId.make("unit-pure")
    const attempt = AttemptNumber.make(2)

    it("maps all 6 AgentRunnerError variants exhaustively via toOutcome and toUnitAgentDispatchResult", () => {
      const authErr = new AgentAuthRequiredError({
        runner: "claude-code",
        detail: toAgentDiagnosticDetail("Run /login"),
      })
      expect(toOutcome(unitId, attempt, authErr)).toEqual({
        _tag: "Escalated",
        unitId,
        escalation: { _tag: "AuthRequired", runner: "claude-code" },
      })
      expect(toUnitAgentDispatchResult(authErr)).toEqual({
        _tag: "AuthRequired",
        runner: "claude-code",
      })

      const nonAuthErrors = [
        new AgentTimeoutError({ runner: "claude-code", afterMillis: TimeoutMillis.make(5000) }),
        deniedErr("antigravity", "Bash denied"),
        exitErr("claude-code", 2, "boom"),
        parseErr("antigravity", "bad json"),
        new AgentNoChangeError({ runner: "claude-code" }),
      ] as const

      for (const err of nonAuthErrors) {
        const reason = AgentFailureReason.make(`${err._tag}: ${err.message}`)
        expect(toOutcome(unitId, attempt, err)).toEqual({
          _tag: "Rejected",
          unitId,
          attempt,
          rejection: { _tag: "AgentFailed", reason },
        })
        expect(toUnitAgentDispatchResult(err)).toEqual({ _tag: "Failed", reason })
      }
    })

    it("parses Claude Code JSON envelopes, usage telemetry, denials, auth prompts, and error exits", () => {
      const okStdout = JSON.stringify({
        result: "Done!",
        is_error: false,
        num_turns: 4,
        total_cost_usd: 0.0125,
        duration_ms: 3420,
        session_id: "sess-123",
        permission_denials: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 25,
        },
      })
      expect(unwrapSuccess(parseClaudeCodeOutput(0, okStdout, ""))).toEqual({
        runner: "claude-code",
        exit: AgentExitCode.make(0),
        resultText: "Done!",
        usage: {
          status: "reported",
          inputTokens: AgentTokenCount.make(100),
          outputTokens: AgentTokenCount.make(50),
          totalTokens: AgentTokenCount.make(375),
          numTurns: AgentTurnCount.make(4),
          totalCostUsd: AgentCostUsd.make(0.0125),
          durationMillis: AgentDurationMillis.make(3420),
          sessionId: AgentSessionId.make("sess-123"),
        },
      })

      expect(unwrapSuccess(parseClaudeCodeOutput(0, "{}", ""))).toEqual({
        runner: "claude-code",
        exit: AgentExitCode.make(0),
        resultText: "",
        usage: { status: "unavailable" },
      })

      const overlongResult = "x".repeat(262_150)
      const overlongSession = "s".repeat(270)
      const bounded = unwrapSuccess(
        parseClaudeCodeOutput(
          0,
          JSON.stringify({ result: overlongResult, session_id: overlongSession }),
          "",
        ),
      )
      expect(bounded.resultText.length).toBe(262_144)
      expect(bounded.usage.sessionId?.length).toBe(256)

      // Individual telemetry fields report status: "reported"
      expect(claudeOk({ usage: { cache_read_input_tokens: 15 } }).usage.totalTokens).toBe(15)
      expect(claudeOk({ usage: { cache_creation_input_tokens: 20 } }).usage.totalTokens).toBe(20)
      for (const env of [
        { usage: { input_tokens: 10 } },
        { usage: { output_tokens: 12 } },
        { usage: { cache_read_input_tokens: 15 } },
        { usage: { cache_creation_input_tokens: 20 } },
        { num_turns: 2 },
        { total_cost_usd: 0.5 },
        { duration_ms: 100 },
        { session_id: "only-sess" },
      ]) {
        expect(claudeOk(env).usage.status).toBe("reported")
      }
      expect(claudeOk({ session_id: "   " }).usage).toEqual({ status: "unavailable" })

      // Permission denials (string, {tool_name, message}, {tool_name}, {message}, other)
      const claudeDenied = unwrapFailure(
        parseClaudeCodeOutput(
          0,
          JSON.stringify({
            permission_denials: [
              "Bash(rm -rf)",
              { tool_name: "Write", message: "outside worktree" },
              { tool_name: "Edit" },
              { message: "blocked by hook" },
              { code: 42 },
              null,
            ],
          }),
          "",
        ),
      )
      match(claudeDenied)
        .with({ _tag: "AgentToolDeniedError" }, (e) => {
          for (const snippet of [
            "Bash(rm -rf)",
            "Write: outside worktree",
            "Edit",
            "blocked by hook",
            '{"code":42}',
            "null",
          ]) {
            expect(e.notice).toContain(snippet)
          }
        })
        .with(
          { _tag: "AgentTimeoutError" },
          { _tag: "AgentAuthRequiredError" },
          { _tag: "AgentExitError" },
          { _tag: "AgentOutputParseError" },
          { _tag: "AgentNoChangeError" },
          (e) => expect.unreachable(`Expected AgentToolDeniedError, got ${e._tag}`),
        )
        .exhaustive()

      // Clean success with auth prose in result must NOT trigger AgentAuthRequiredError
      expect(
        claudeOk({ is_error: false, result: "401 Unauthorized /login invalid api key" }),
      ).toEqual({
        runner: "claude-code",
        exit: AgentExitCode.make(0),
        resultText: "401 Unauthorized /login invalid api key",
        usage: { status: "unavailable" },
      })

      // Negative, fractional, and zero telemetry clamping
      expect(
        claudeOk({
          num_turns: 0,
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: -5 },
        }).usage,
      ).toEqual({
        status: "reported",
        inputTokens: AgentTokenCount.make(0),
        outputTokens: AgentTokenCount.make(0),
        totalTokens: AgentTokenCount.make(0),
        numTurns: AgentTurnCount.make(0),
        totalCostUsd: AgentCostUsd.make(0),
        durationMillis: AgentDurationMillis.make(0),
      })
      expect(
        claudeOk({ num_turns: 2.9, duration_ms: 12.6, usage: { input_tokens: 10.7 } }).usage,
      ).toEqual({
        status: "reported",
        inputTokens: AgentTokenCount.make(10),
        totalTokens: AgentTokenCount.make(10),
        numTurns: AgentTurnCount.make(2),
        durationMillis: AgentDurationMillis.make(13),
      })

      const j = JSON.stringify
      const claudeFailures = [
        [0, j({ result: "ok" }), "Please run /login", authErr("claude-code", "Please run /login")],
        [
          1,
          j({ is_error: true, result: "Invalid API key · Please run /login" }),
          "",
          authErr("claude-code", "Invalid API key · Please run /login"),
        ],
        [
          0,
          j({ is_error: true, result: "401 Unauthorized /login invalid api key" }),
          "",
          authErr("claude-code", "401 Unauthorized /login invalid api key"),
        ],
        [1, "", "Authentication required", authErr("claude-code", "Authentication required")],
        [1, "Please log in", "", authErr("claude-code", "Please log in")],
        [0, j({ is_error: true, result: "failed" }), "", exitErr("claude-code", 1, "failed")],
        [300, j({ is_error: false }), "", exitErr("claude-code", 255)],
        [-2, "bad json", "", exitErr("claude-code", 1, "bad json")],
        [1, "", "", exitErr("claude-code", 1)],
        [0, "", "", parseErr("claude-code", "Empty JSON output from claude")],
        [0, "{not-json", "parse stderr", parseErr("claude-code", "parse stderr")],
      ] as const
      for (const [code, stdout, stderr, expected] of claudeFailures) {
        expect(unwrapFailure(parseClaudeCodeOutput(code, stdout, stderr))).toEqual(expected)
      }
    })

    it("parses Antigravity JSON envelopes, stderr soft denials, auth errors, non-SUCCESS statuses, and exit 3 startup retries", () => {
      const okAgy = JSON.stringify({
        conversation_id: "conv-abc",
        status: "SUCCESS",
        response: "WF0_PLAN_JSON_OK\n",
        duration_seconds: 15.16,
        num_turns: 2,
        usage: { input_tokens: 32225, output_tokens: 42, thinking_tokens: 30, total_tokens: 32267 },
      })
      expect(unwrapSuccess(parseAntigravityOutput(0, okAgy, ""))).toEqual({
        runner: "antigravity",
        exit: AgentExitCode.make(0),
        resultText: "WF0_PLAN_JSON_OK\n",
        usage: {
          status: "reported",
          inputTokens: AgentTokenCount.make(32225),
          outputTokens: AgentTokenCount.make(42),
          thinkingTokens: AgentTokenCount.make(30),
          totalTokens: AgentTokenCount.make(32267),
          numTurns: AgentTurnCount.make(2),
          durationMillis: AgentDurationMillis.make(15160),
          sessionId: AgentSessionId.make("conv-abc"),
        },
      })
      expect(agyOk({ response: "ok" })).toEqual({
        runner: "antigravity",
        exit: AgentExitCode.make(0),
        resultText: "ok",
        usage: { status: "unavailable" },
      })
      expect(
        agyOk({ status: "SUCCESS", response: "401 Unauthorized /login invalid api key" }),
      ).toEqual({
        runner: "antigravity",
        exit: AgentExitCode.make(0),
        resultText: "401 Unauthorized /login invalid api key",
        usage: { status: "unavailable" },
      })
      expect(agyOk({ status: "SUCCESS", response: "ok", duration_seconds: 1e307 }).usage).toEqual({
        status: "unavailable",
      })
      expect(
        agyOk({
          status: "SUCCESS",
          duration_seconds: 0,
          num_turns: 0,
          usage: { input_tokens: 0, thinking_tokens: -3 },
        }).usage,
      ).toEqual({
        status: "reported",
        inputTokens: AgentTokenCount.make(0),
        thinkingTokens: AgentTokenCount.make(0),
        numTurns: AgentTurnCount.make(0),
        durationMillis: AgentDurationMillis.make(0),
      })
      expect(
        agyOk({
          status: "SUCCESS",
          duration_seconds: 1.5004,
          num_turns: 3.8,
          usage: { input_tokens: 7.9 },
        }).usage,
      ).toEqual({
        status: "reported",
        inputTokens: AgentTokenCount.make(7),
        numTurns: AgentTurnCount.make(3),
        durationMillis: AgentDurationMillis.make(1500),
      })
      for (const env of [
        { status: "SUCCESS", usage: { thinking_tokens: 5 } },
        { status: "SUCCESS", usage: { total_tokens: 9 } },
        { status: "SUCCESS", duration_seconds: 1.5 },
        { status: "SUCCESS", conversation_id: "c-1" },
      ]) {
        expect(agyOk(env).usage.status).toBe("reported")
      }

      const j = JSON.stringify
      const agyFailures = [
        [
          0,
          okAgy,
          "Warning: tool call denied by policy",
          deniedErr("antigravity", "Warning: tool call denied by policy"),
        ],
        [1, "", "Authentication expired", authErr("antigravity", "Authentication expired")],
        [
          0,
          j({ status: "FAILED", response: "Not logged in" }),
          "",
          authErr("antigravity", "Not logged in"),
        ],
        [
          1,
          j({ status: "SUCCESS", response: "401 Unauthorized /login invalid api key" }),
          "",
          authErr("antigravity", "401 Unauthorized /login invalid api key"),
        ],
        [
          1,
          j({ status: "ERROR", response: "resp err" }),
          "stderr err",
          exitErr("antigravity", 1, "resp err"),
        ],
        [
          1,
          j({ status: "ERROR", response: "" }),
          "stderr err",
          exitErr("antigravity", 1, "stderr err"),
        ],
        [0, j({ status: "ERROR" }), "", exitErr("antigravity", 1, "Antigravity status: ERROR")],
        [2, j({ status: "SUCCESS" }), "", exitErr("antigravity", 2, "Antigravity status: SUCCESS")],
        [2, "{}", "", exitErr("antigravity", 2)],
        [0, "", "", parseErr("antigravity", "Empty JSON output from agy")],
        [4, "not-json", "", exitErr("antigravity", 4, "not-json")],
      ] as const
      for (const [code, stdout, stderr, expected] of agyFailures) {
        expect(unwrapFailure(parseAntigravityOutput(code, stdout, stderr))).toEqual(expected)
      }
      match(unwrapFailure(parseAntigravityOutput(0, "invalid", "")))
        .with({ _tag: "AgentOutputParseError" }, (e) => {
          expect(e.runner).toBe("antigravity")
          expect(e.detail?.length ?? 0).toBeGreaterThan(0)
        })
        .with(
          { _tag: "AgentTimeoutError" },
          { _tag: "AgentToolDeniedError" },
          { _tag: "AgentAuthRequiredError" },
          { _tag: "AgentExitError" },
          { _tag: "AgentNoChangeError" },
          (e) => expect.unreachable(`Expected AgentOutputParseError, got ${e._tag}`),
        )
        .exhaustive()

      expect(isRetryableAntigravityStartupFailure(3, "", "schema error")).toBe(true)
      expect(isRetryableAntigravityStartupFailure(3, "  \n\t", "schema error")).toBe(true)
      expect(isRetryableAntigravityStartupFailure(3, "{}", "schema error")).toBe(false)
      expect(isRetryableAntigravityStartupFailure(1, "", "other error")).toBe(false)
      expect(isRetryableAntigravityStartupFailure(3, "", "Please run /login")).toBe(false)
      expect(isRetryableAntigravityStartupFailure(3, "", "tool call denied by policy")).toBe(false)
    })
  })

  describe("unit-brief-builder", () => {
    const makeBundle = (
      holeQualname: string,
      estimatedTokens: number,
      withCandidate: boolean,
    ): TypedHoleContextBundle => ({
      holeQualname,
      spanName: "AgentRunner.run",
      successTypeSignature: "AgentRunResult",
      allowedErrorConstructors: ["AgentExitError"],
      requiredServiceCapabilities: ["AgentRunnerPort"],
      inhabitingCandidates: withCandidate
        ? [
            {
              symbolKey: NodeKey.make("sym:runner"),
              inhabitsChannel: "A",
              signatureSummary: "AgentRunResult",
              pprScore: PageRankScoreMillis.make(850),
            },
          ]
        : [],
      estimatedTokens,
    })

    it("builds deterministic PackageUnit briefs with bounded <= 1500-token holeBundles and mcpConfigPath", () => {
      const mcpConfigPath = RunnerConfigFilePath.make("/tmp/scoped-mcp.json")
      const brief = buildUnitBrief({
        unit: pkgUnit,
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
        mcpConfigPath,
        holeBundles: [
          makeBundle("holeA", 1000, true),
          makeBundle("holeB", 500, false),
          makeBundle("holeC", 1, false),
        ],
      })

      expect(brief.unitId).toBe(pkgUnit.unitId)
      expect(brief.attempt).toBe(1)
      expect(brief.ownedRelPaths).toEqual(pkgUnit.ownedRelPaths)
      expect(brief.packageVerifyCommand).toBe("nx run harness-infra:verify")
      expect(brief.mcpConfigPath).toBe(mcpConfigPath)
      expect(brief.promptText).toContain(`REPO_ROOT=${repoRoot}`)
      expect(brief.promptText).toContain("UNIT_KIND=PackageUnit")
      expect(brief.promptText).toContain("nx run harness-infra:verify")
      expect(brief.promptText).toContain("Stub symbols: buildUnitBrief")
      expect(brief.promptText).toContain("EARS requirements: harness:SPEC-0036/REQ-4.1")
      expect(brief.promptText).toContain("HARNESS_UNIT_WORKER=1")
      expect(brief.promptText).toContain("holeA")
      expect(brief.promptText).toContain("<typed-hole-context>")
      expect(brief.promptText).toContain("</typed-hole-context>")
      expect(brief.promptText).toContain("sym:runner (A, ppr=850)")
      expect(brief.promptText).toContain("holeB")
      expect(brief.promptText).not.toContain("holeC")
    })

    it("builds SliceUnit briefs and formats all 4 priorRejection variants exhaustively", () => {
      const rejections: ReadonlyArray<readonly [UnitRejection, string]> = [
        [
          UnitRejection.cases.WriteSetViolation.make({
            offendingPaths: [OwnedRelPath.make("apps/harness-cli/src/index.ts")],
          }),
          "WriteSetViolation: Modified paths outside ownedRelPaths",
        ],
        [
          UnitRejection.cases.PackageVerifyFailed.make({
            exitCode: GateExitCode.make(1),
            failureKind: "non-zero-exit",
            detail: PackageVerifyFailureDetail.make("lint error"),
          }),
          "PackageVerifyFailed: Command failed (non-zero-exit, exit 1) (lint error)",
        ],
        [
          UnitRejection.cases.PackageVerifyFailed.make({
            exitCode: GateExitCode.make(2),
            failureKind: "timed-out",
          }),
          "PackageVerifyFailed: Command failed (timed-out, exit 2).",
        ],
        [
          UnitRejection.cases.StampMissing.make({}),
          "StampMissing: Verification stamp was not recorded.",
        ],
        [
          UnitRejection.cases.AgentFailed.make({
            reason: AgentFailureReason.make("AgentTimeoutError: timed out"),
          }),
          "AgentFailed: Previous runner attempt failed (AgentTimeoutError: timed out)",
        ],
      ]

      for (const [priorRejection, expectedSnippet] of rejections) {
        const brief = buildUnitBrief({
          unit: sliceUnit,
          attempt: AttemptNumber.make(2),
          cwd: repoRoot,
          priorRejection,
          holeBundles: [],
        })
        expect(brief.packageVerifyCommand).toBeUndefined()
        expect(brief.mcpConfigPath).toBeUndefined()
        for (const snippet of [
          "UNIT_KIND=SliceUnit",
          "SLICE_BRANCH=slice/wf5-runners",
          "CI=true pnpm harness verify",
          "- (none)",
          "EARS requirements: (none)",
          "<prior-rejection>",
          "</prior-rejection>",
          expectedSnippet,
        ]) {
          expect(brief.promptText).toContain(snippet)
        }
        expect(brief.promptText).not.toContain("Typed hole context")
      }
    })

    it("sanitizes control chars, handles negative estimatedTokens, and hits exact 65_536 bound preserving Workspace rules", () => {
      const sanitizedBrief = buildUnitBrief({
        unit: sliceUnit,
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.AgentFailed.make({
          reason: AgentFailureReason.make("bad\x00\x07\x1bline1\r\nline2"),
        }),
        holeBundles: [
          makeBundle("holeNeg", -500, false),
          makeBundle("holeFit\x00\r\nok", 1000, false),
          makeBundle("holeOver", 501, false),
        ],
      })
      expect(sanitizedBrief.promptText).toContain("bad   line1\nline2")
      expect(sanitizedBrief.promptText).toContain("holeNeg")
      expect(sanitizedBrief.promptText).toContain("holeFit \nok")
      expect(sanitizedBrief.promptText).not.toContain("holeOver")
      expect(sanitizedBrief.promptText).toContain("<typed-hole-context>")
      expect(sanitizedBrief.promptText).toContain("<prior-rejection>")

      const oversizedRejBrief = buildUnitBrief({
        unit: sliceUnit,
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.AgentFailed.make({
          reason: AgentFailureReason.make("R".repeat(70_000)),
        }),
      })
      const oversizedHoleBrief = buildUnitBrief({
        unit: sliceUnit,
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
        holeBundles: [makeBundle("H".repeat(70_000), 100, false)],
      })
      for (const [brief, tag] of [
        [oversizedRejBrief, "prior-rejection"],
        [oversizedHoleBrief, "typed-hole-context"],
      ] as const) {
        expect(brief.promptText.length).toBe(65_536)
        expect(brief.promptText).toContain(`<${tag}>`)
        expect(brief.promptText).toContain(`</${tag}>`)
        expect(brief.promptText).toContain("Workspace rules (HARNESS_UNIT_WORKER=1):")
      }

      const manyPaths = Array.from({ length: 200 }, (_, i) =>
        OwnedRelPath.make(`libs/pkg-${i}/${"segment/".repeat(40)}file-${i}.ts`),
      )
      const hugeUnit = Schema.decodeSync(CompiledWorkUnit)({
        _tag: "SliceUnit",
        unitId: WorkUnitId.make("slice-huge"),
        branch: SliceBranchName.make("slice/wf5-huge"),
        waveIndex: WaveIndex.make(0),
        dependsOn: [],
        ownedRelPaths: manyPaths,
        earsKeys: [],
      })
      const brief = buildUnitBrief({
        unit: hugeUnit,
        attempt: AttemptNumber.make(1),
        cwd: repoRoot,
      })
      expect(brief.promptText.length).toBeLessThanOrEqual(65_536)
      expect(brief.promptText.length).toBeGreaterThan(60_000)
      expect(brief.promptText).toContain("Workspace rules (HARNESS_UNIT_WORKER=1):")
    })
  })

  describe("property-based checks", () => {
    const promptArb = Arbitrary.map(
      Arbitrary.array(Arbitrary.schema(Schema.Literals(["a", "b", " ", "1", "-"])), {
        minLength: 1,
        maxLength: 30,
      }),
      (chars) => `prompt_${chars.join("")}`,
    )

    it("satisfies argv, env isolation, and unit brief invariants across arbitrary inputs", () => {
      const boolArb = Arbitrary.schema(Schema.Boolean)
      const claudeArgvCheck = Effect.runSync(
        Arbitrary.checkEffect(
          Arbitrary.all({
            promptText: promptArb,
            includeRules: boolArb,
            includeModel: boolArb,
            turns: Arbitrary.schema(
              Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
            ),
          }),
          ({ promptText, includeRules, includeModel, turns }) => {
            const argv = buildClaudeCodeArgv({
              profile: mkProfile("claude-code", {
                permissionRules: includeRules ? [PermissionRule.make("Read")] : [],
                maxTurns: AgentMaxTurns.make(turns),
                ...(includeModel ? { model: ModelName.make("claude-sonnet-4-6") } : {}),
              }),
              promptText,
              mcpConfigPath: "/tmp/mcp.json",
              hooksSettingsPath: "/tmp/hooks.json",
            })
            return (
              argv[0] === "-p" &&
              argv[1] === promptText &&
              argv.includes("--strict-mcp-config") &&
              argv.includes("dontAsk") &&
              !argv.includes("--dangerously-skip-permissions")
            )
          },
          { runs: 40, seed: 27 },
        ),
      )
      expect(claudeArgvCheck._tag).toBe("Passed")

      const agyArgvCheck = Effect.runSync(
        Arbitrary.checkEffect(
          Arbitrary.all({
            promptText: promptArb,
            timeoutMs: Arbitrary.schema(
              Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
            ),
            includeMode: boolArb,
          }),
          ({ promptText, timeoutMs, includeMode }) => {
            const argv = buildAntigravityArgv({
              profile: mkProfile("antigravity", {
                timeoutMillis: TimeoutMillis.make(timeoutMs),
                ...(includeMode ? { antigravityMode: "accept-edits" as const } : {}),
              }),
              promptText,
            })
            return (
              argv[0] === "-p" &&
              argv[1] === promptText &&
              /^[1-9]\d*s$/.test(argv[5] ?? "") &&
              !argv.includes("--dangerously-skip-permissions")
            )
          },
          { runs: 40, seed: 27 },
        ),
      )
      expect(agyArgvCheck._tag).toBe("Passed")

      const envCheck = Effect.runSync(
        Arbitrary.checkEffect(
          Arbitrary.all({
            runner: Arbitrary.schema(Schema.Literals(["claude-code", "antigravity"])),
            hasPath: boolArb,
            hasAnthropic: boolArb,
            hasSecret: boolArb,
          }),
          ({ runner, hasPath, hasAnthropic, hasSecret }) => {
            const env = buildRunnerEnv(runner, {
              ...(hasPath ? { PATH: "/bin" } : {}),
              ...(hasAnthropic ? { ANTHROPIC_API_KEY: "sk-1" } : {}),
              ...(hasSecret
                ? {
                    CLOUDFLARE_API_TOKEN: "cf",
                    ANTIGRAVITY_SESSION: "agy",
                    AGY_KEY: "k",
                    OMNIGRAPH_TOKEN: "og",
                    HARNESS_WORKTREE_ID: "wt",
                  }
                : {}),
            })
            return (
              env["HARNESS_UNIT_WORKER"] === "1" &&
              env["CLOUDFLARE_API_TOKEN"] === undefined &&
              env["ANTIGRAVITY_SESSION"] === undefined &&
              env["AGY_KEY"] === undefined &&
              env["OMNIGRAPH_TOKEN"] === undefined &&
              env["HARNESS_WORKTREE_ID"] === undefined &&
              (runner === "claude-code" || env["ANTHROPIC_API_KEY"] === undefined)
            )
          },
          { runs: 40, seed: 27 },
        ),
      )
      expect(envCheck._tag).toBe("Passed")

      const briefCheck = Effect.runSync(
        Arbitrary.checkEffect(
          Arbitrary.all({
            isPkg: boolArb,
            attempt: Arbitrary.schema(
              Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
            ),
            hasRejection: boolArb,
            tokens: Arbitrary.schema(
              Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -500, maximum: 2000 }))),
            ),
          }),
          ({ isPkg, attempt, hasRejection, tokens }) => {
            const brief = buildUnitBrief({
              unit: isPkg ? pkgUnit : sliceUnit,
              attempt: AttemptNumber.make(attempt),
              cwd: repoRoot,
              ...(hasRejection
                ? { priorRejection: UnitRejection.cases.StampMissing.make({}) }
                : {}),
              holeBundles: [
                {
                  holeQualname: "h\x00\x1b",
                  spanName: "span",
                  successTypeSignature: "A",
                  allowedErrorConstructors: [],
                  requiredServiceCapabilities: [],
                  inhabitingCandidates: [],
                  estimatedTokens: tokens,
                },
              ],
            })
            const hasBadCtrl = Array.from(brief.promptText).some(
              (ch) => ch.charCodeAt(0) <= 0x1f && ch.charCodeAt(0) !== 0x0a,
            )
            return (
              brief.promptText.length <= 65_536 &&
              !brief.promptText.startsWith("-") &&
              brief.promptText.includes(`REPO_ROOT=${repoRoot}`) &&
              brief.promptText.includes("Workspace rules (HARNESS_UNIT_WORKER=1):") &&
              !hasBadCtrl
            )
          },
          { runs: 40, seed: 27 },
        ),
      )
      expect(briefCheck._tag).toBe("Passed")
    })

    it("kills remaining boundary/control-char/output_tokens mutants (output_tokens-only, 0x1f, bodyBudget=0, and exact 65_536 budget)", () => {
      const outputOnlyUsage = parseClaudeCodeOutput(
        0,
        JSON.stringify({
          result: "ok",
          usage: { output_tokens: 7 },
        }),
        "",
      )
      match(outputOnlyUsage)
        .with({ _tag: "Success" }, ({ success }) => {
          expect(success.usage.status).toBe("reported")
          expect(success.usage.outputTokens).toBe(AgentTokenCount.make(7))
          expect(success.usage.totalTokens).toBe(AgentTokenCount.make(7))
        })
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect.unreachable(`Expected Success, got ${failure._tag}`)
        })
        .exhaustive()

      const repoRoot = AbsoluteRepoRoot.make("/workspace/repo")
      const makeBasePkg = (relPaths: ReadonlyArray<OwnedRelPath>) =>
        Schema.decodeSync(CompiledWorkUnit)({
          _tag: "PackageUnit",
          unitId: WorkUnitId.make("unit-budget-edge"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          projectName: NxProjectName.make("harness-infra"),
          ownedRelPaths: relPaths,
          earsKeys: [EarsRequirementKey.make("SPEC-0036:REQ-4.4")],
          stubKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm --filter harness-infra verify"),
        })

      const ctrlBrief = buildUnitBrief({
        unit: makeBasePkg([OwnedRelPath.make("libs/a.ts")]),
        attempt: AttemptNumber.make(2),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.PackageVerifyFailed.make({
          exitCode: GateExitCode.make(1),
          failureKind: "non-zero-exit",
          detail: PackageVerifyFailureDetail.make("bad\x1fctrl"),
        }),
        holeBundles: [
          {
            holeQualname: "Hole\x1fName",
            spanName: "span",
            successTypeSignature: "Effect<void, never, never>",
            allowedErrorConstructors: [],
            requiredServiceCapabilities: [],
            inhabitingCandidates: [],
            estimatedTokens: 10,
          },
        ],
      })
      expect(ctrlBrief.promptText).not.toContain("\x1f")
      expect(ctrlBrief.promptText).toContain("Hole Name")
      expect(ctrlBrief.promptText).toContain("bad ctrl")

      const fillerPaths = Array.from({ length: 195 }, (_, i) =>
        OwnedRelPath.make(`libs/p-${i.toString().padStart(3, "0")}/${"x".repeat(314)}.ts`),
      )
      const nearBaseline = buildUnitBrief({
        unit: makeBasePkg(fillerPaths),
        attempt: AttemptNumber.make(2),
        cwd: repoRoot,
      }).promptText.length

      // Exact bodyBudget === 0 for StampMissing (<prior-rejection> wrapper is 73 + 19 = 92 chars, + 2 separator = 94)
      const zeroBodyPadLen = 65_536 - 94 - nearBaseline - 11
      const zeroBodyBrief = buildUnitBrief({
        unit: makeBasePkg([
          ...fillerPaths,
          OwnedRelPath.make(`libs/${"z".repeat(zeroBodyPadLen)}.ts`),
        ]),
        attempt: AttemptNumber.make(2),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.StampMissing.make({}),
      })
      expect(zeroBodyBrief.promptText).not.toContain("<prior-rejection>")
      expect(zeroBodyBrief.promptText).toContain("Workspace rules (HARNESS_UNIT_WORKER=1):")

      const oneBodyBrief = buildUnitBrief({
        unit: makeBasePkg([
          ...fillerPaths,
          OwnedRelPath.make(`libs/${"z".repeat(zeroBodyPadLen - 1)}.ts`),
        ]),
        attempt: AttemptNumber.make(2),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.StampMissing.make({}),
      })
      expect(oneBodyBrief.promptText).toContain("<prior-rejection>\n- S\n</prior-rejection>")

      // Exact remaining === 0 keeps complete header and workspace rules without exceeding 65_536
      const exactBudgetPadLen = 65_536 - nearBaseline - 11
      const exactBudgetBrief = buildUnitBrief({
        unit: makeBasePkg([
          ...fillerPaths,
          OwnedRelPath.make(`libs/${"y".repeat(exactBudgetPadLen)}.ts`),
        ]),
        attempt: AttemptNumber.make(2),
        cwd: repoRoot,
        priorRejection: UnitRejection.cases.StampMissing.make({}),
      })
      expect(exactBudgetBrief.promptText.length).toBe(65_536)
      expect(exactBudgetBrief.promptText).toContain("Workspace rules (HARNESS_UNIT_WORKER=1):")
    })
  })
})
