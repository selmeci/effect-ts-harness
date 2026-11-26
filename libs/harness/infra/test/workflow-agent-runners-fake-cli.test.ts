import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, type Exit, Logger, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type AgentExitFailureKind,
  type AgentRunResult,
  type AgentRunnerError,
  AttemptNumber,
  BriefPrompt,
  OwnedRelPath,
  RunnerConfigFilePath,
  type RunnerId,
  UnitBrief,
  WorkUnitId,
  WorkflowRunId,
} from "@harness/contract"
import { decideSpanBudgets } from "@harness/gates"
import { AgentRunnerPort } from "@harness/service"
import {
  makeAgentRunnerPortLayer,
  nodeSyncHostIo,
  runAgentRunnerImpl,
  runAntigravityImpl,
  runClaudeCodeImpl,
} from "../src/index.js"
import { resolveHarnessInstallationRoot } from "../src/workflow/runner-profiles.js"
import {
  initGitRepo,
  runWithTestTracer,
  withTempDir,
  writeExecutableScript,
} from "./helpers/workflow-verifier-fixture.js"

const CapturedCliInvocationSchema = Schema.fromJsonString(
  Schema.Struct({
    argv: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
    cwd: Schema.String,
    stdinBytes: Schema.Finite,
    hooksJson: Schema.optional(Schema.String),
    mcpJson: Schema.optional(Schema.String),
  }),
)

const HooksSettingsCheckSchema = Schema.fromJsonString(
  Schema.Struct({
    hooks: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          matcher: Schema.String,
          hooks: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              command: Schema.String,
              timeout: Schema.Finite,
            }),
          ),
        }),
      ),
    ),
  }),
)

const McpConfigCheckSchema = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

const makeFakeCliEnv = (
  binDir: string,
  homeDir: string,
  extra?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => ({
  PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: homeDir,
  CLOUDFLARE_API_TOKEN: "secret-cf-token",
  OMNIGRAPH_ADMIN_TOKEN: "secret-omni-token",
  HARNESS_OMNIGRAPH_SECRET: "secret-harness-omni",
  HARNESS_WORKTREE_ID: "parent-worktree-id",
  HARNESS_STATE_DIR: "/tmp/parent-state-dir",
  ANTIGRAVITY_CLI_ALIAS: "nested-agy",
  AGY_SESSION_ID: "nested-session",
  ...extra,
})

const makeBrief = (overrides?: {
  readonly promptText?: string
  readonly mcpConfigPath?: RunnerConfigFilePath
}): UnitBrief =>
  UnitBrief.make({
    unitId: WorkUnitId.make("pkg-alpha"),
    attempt: AttemptNumber.make(1),
    promptText: BriefPrompt.make(
      overrides?.promptText ?? "Implement SPEC-0036 REQ-1 in libs/alpha",
    ),
    ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
    ...(overrides?.mcpConfigPath !== undefined ? { mcpConfigPath: overrides.mcpConfigPath } : {}),
  })

const expectRunnerFailure = (exit: Exit.Exit<AgentRunResult, AgentRunnerError>): AgentRunnerError =>
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) =>
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => expect.unreachable("Expected typed AgentRunnerError"))
        .exhaustive(),
    )
    .with({ _tag: "Success" }, () => expect.unreachable("Expected failure, got success"))
    .exhaustive()

const assertRunnerFailure = (
  exit: Exit.Exit<AgentRunResult, AgentRunnerError>,
  expected: {
    readonly _tag: AgentRunnerError["_tag"]
    readonly runner: RunnerId
    readonly exit?: number
    readonly kind?: AgentExitFailureKind
    readonly afterMillis?: number
    readonly noticePart?: string
    readonly detailPart?: string
    readonly messagePart?: string
  },
): void => {
  const err = expectRunnerFailure(exit)
  expect(err._tag).toBe(expected._tag)
  expect(err.runner).toBe(expected.runner)
  if (expected.messagePart !== undefined) {
    expect(err.message).toContain(expected.messagePart)
  }
  match(err)
    .with({ _tag: "AgentTimeoutError" }, (e) => {
      if (expected.afterMillis !== undefined) expect(e.afterMillis).toBe(expected.afterMillis)
    })
    .with({ _tag: "AgentToolDeniedError" }, (e) => {
      if (expected.noticePart !== undefined) expect(e.notice).toContain(expected.noticePart)
    })
    .with({ _tag: "AgentAuthRequiredError" }, (e) => {
      if (expected.detailPart !== undefined) expect(e.detail).toContain(expected.detailPart)
    })
    .with({ _tag: "AgentExitError" }, (e) => {
      if (expected.exit !== undefined) expect(e.exit).toBe(expected.exit)
      if (expected.kind !== undefined) expect(e.kind).toBe(expected.kind)
      if (expected.detailPart !== undefined) expect(e.detail).toContain(expected.detailPart)
    })
    .with({ _tag: "AgentOutputParseError" }, (e) => {
      expect(e.detail).toBeDefined()
      if (expected.detailPart !== undefined) expect(e.detail).toContain(expected.detailPart)
    })
    .with({ _tag: "AgentNoChangeError" }, () => undefined)
    .exhaustive()
}

type ExpectedFailure = Parameters<typeof assertRunnerFailure>[1]

const runClaudeFail = (
  cwd: AbsoluteRepoRoot,
  env: Readonly<Record<string, string | undefined>>,
  expected: ExpectedFailure,
  options?: {
    readonly brief?: UnitBrief
    readonly hostIo?: typeof nodeSyncHostIo
  },
) =>
  Effect.exit(
    runClaudeCodeImpl(
      {
        runId: WorkflowRunId.make("run-claude-fail-1"),
        runner: "claude-code",
        brief: options?.brief ?? makeBrief(),
        cwd,
      },
      { env, ...(options?.hostIo !== undefined ? { hostIo: options.hostIo } : {}) },
    ),
  ).pipe(Effect.map((exit) => assertRunnerFailure(exit, expected)))

const runAgyFail = (
  cwd: AbsoluteRepoRoot,
  env: Readonly<Record<string, string | undefined>>,
  expected: ExpectedFailure,
  extra?: {
    readonly mcpIsolation?: "standard" | "hard"
    readonly hardMcpFallback?: "reject" | "fallback-claude"
    readonly startupRetryMaxAttempts?: number
    readonly startupRetryBackoffMs?: number
  },
) =>
  Effect.exit(
    runAntigravityImpl(
      {
        runId: WorkflowRunId.make("run-agy-fail-1"),
        runner: "antigravity",
        brief: makeBrief(),
        cwd,
        ...(extra?.mcpIsolation !== undefined ? { mcpIsolation: extra.mcpIsolation } : {}),
        ...(extra?.hardMcpFallback !== undefined ? { hardMcpFallback: extra.hardMcpFallback } : {}),
      },
      {
        env,
        ...(extra?.startupRetryMaxAttempts !== undefined
          ? { startupRetryMaxAttempts: extra.startupRetryMaxAttempts }
          : {}),
        ...(extra?.startupRetryBackoffMs !== undefined
          ? { startupRetryBackoffMs: extra.startupRetryBackoffMs }
          : {}),
      },
    ),
  ).pipe(Effect.map((exit) => assertRunnerFailure(exit, expected)))

const CLAUDE_CAPTURE_SCRIPT = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const outPath = process.env.FAKE_CAPTURE_PATH || (process.cwd() + "/claude-capture.json");
const mcpIdx = argv.indexOf("--mcp-config");
const settingsIdx = argv.indexOf("--settings");
const hooksJson = settingsIdx >= 0 ? fs.readFileSync(argv[settingsIdx + 1], "utf8") : undefined;
const mcpJson = mcpIdx >= 0 ? fs.readFileSync(argv[mcpIdx + 1], "utf8") : undefined;
const stdinBuf = fs.readFileSync(0);
const capture = {
  argv,
  env: process.env,
  cwd: process.cwd(),
  stdinBytes: stdinBuf.length,
  ...(hooksJson !== undefined ? { hooksJson } : {}),
  ...(mcpJson !== undefined ? { mcpJson } : {}),
};
fs.writeFileSync(outPath, JSON.stringify(capture), "utf8");
process.stdout.write(JSON.stringify({
  result: "Implemented alpha",
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.04,
  duration_ms: 120,
  session_id: "sess-claude-1",
  usage: { input_tokens: 100, output_tokens: 50 },
}));
`

describe("SPEC-0036 WF-5 Agent Runners (Fake CLI, Argv/Env Isolation & Error Classification)", () => {
  it.live(
    "SPEC-0036 REQ-1.1..1.3 / REQ-2.1..2.2: ClaudeCodeRunnerLive isolates argv, PreToolUse-only hooks, env, stdio, and cleans temp dir",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)

          const env = makeFakeCliEnv(binDir, homeDir)
          const { result, spans } = yield* runWithTestTracer(
            "claude-isolation",
            runAgentRunnerImpl(
              {
                runId: WorkflowRunId.make("run-claude-1"),
                runner: "claude-code",
                brief: makeBrief(),
                cwd: repoRoot,
              },
              { env },
            ),
          )

          expect(result.runner).toBe("claude-code")
          expect(result.exit).toBe(0)
          expect(result.resultText).toContain("Implemented alpha")
          expect(result.usage).toMatchObject({
            _tag: "Reported",
            inputTokens: 100,
            outputTokens: 50,
          })

          const captureRaw = readFileSync(join(repoRoot, "claude-capture.json"), "utf8")
          const captured = yield* Schema.decodeEffect(CapturedCliInvocationSchema)(captureRaw)

          expect(captured.cwd).toBe(repoRoot)
          expect(captured.stdinBytes).toBe(0)
          expect(captured.argv).not.toContain("--dangerously-skip-permissions")
          expect(captured.argv).toContain("-p")
          expect(captured.argv).toContain("--strict-mcp-config")
          expect(captured.argv).toContain("--setting-sources")
          const settingSourcesIdx = captured.argv.indexOf("--setting-sources")
          expect(captured.argv[settingSourcesIdx + 1]).toBe("")
          expect(captured.argv).toContain("--permission-mode")
          expect(captured.argv).toContain("dontAsk")

          const settingsIdx = captured.argv.indexOf("--settings")
          const hooksPath = captured.argv[settingsIdx + 1]!
          const mcpIdx = captured.argv.indexOf("--mcp-config")
          const mcpPath = captured.argv[mcpIdx + 1]!
          expect(existsSync(hooksPath)).toBe(false)
          expect(existsSync(mcpPath)).toBe(false)

          const parsedHooks = yield* Schema.decodeEffect(HooksSettingsCheckSchema)(
            captured.hooksJson!,
          )
          expect(Object.keys(parsedHooks.hooks)).toEqual(["PreToolUse"])
          const preToolHooks = parsedHooks.hooks["PreToolUse"]!
          expect(preToolHooks.length).toBeGreaterThan(0)
          const expectedHarnessRoot = resolveHarnessInstallationRoot()
          for (const entry of preToolHooks) {
            expect(entry.hooks[0]?.command).toContain(expectedHarnessRoot)
            expect(entry.hooks[0]?.command).not.toContain(repoRoot)
          }
          const parsedMcp = yield* Schema.decodeEffect(McpConfigCheckSchema)(captured.mcpJson!)
          expect(parsedMcp.mcpServers).toEqual({})

          expect(captured.env["HARNESS_UNIT_WORKER"]).toBe("1")
          expect(captured.env["CLOUDFLARE_API_TOKEN"]).toBeUndefined()
          expect(captured.env["OMNIGRAPH_ADMIN_TOKEN"]).toBeUndefined()
          expect(captured.env["HARNESS_OMNIGRAPH_SECRET"]).toBeUndefined()
          expect(captured.env["HARNESS_WORKTREE_ID"]).toBeUndefined()
          expect(captured.env["HARNESS_STATE_DIR"]).toBeUndefined()
          expect(captured.env["ANTIGRAVITY_CLI_ALIAS"]).toBeUndefined()
          expect(captured.env["AGY_SESSION_ID"]).toBeUndefined()

          expect(spans.some((s) => s.name === "AgentRunner.run")).toBe(true)
          expect(spans.some((s) => s.name === "ClaudeCodeRunner.run")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-2.1..2.2 / S-3.5 / S-3.6: ClaudeCodeRunner validates mcpConfigPath (missing, symlink, ancestor symlink, realpathSync error, >65536 bytes limit, invalid JSON, valid scoped copy)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const emptyBinDir = join(dir, "empty-bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          mkdirSync(emptyBinDir, { recursive: true })
          const spawnEnv = makeFakeCliEnv(binDir, homeDir)
          const env = { ...spawnEnv, PATH: emptyBinDir }

          const realMcpDir = join(dir, "real-mcp-dir")
          mkdirSync(realMcpDir, { recursive: true })
          const realMcp = join(realMcpDir, "real-mcp.json")
          writeFileSync(realMcp, '{"mcpServers":{"custom":{"command":"echo"}}}', "utf8")
          const symlinkMcp = join(dir, "sym-mcp.json")
          symlinkSync(realMcp, symlinkMcp)
          const symParentDir = join(dir, "sym-parent")
          symlinkSync(realMcpDir, symParentDir)

          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "Invalid or missing mcpConfigPath",
            },
            { brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(symlinkMcp) }) },
          )
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "Invalid or missing mcpConfigPath",
            },
            {
              brief: makeBrief({
                mcpConfigPath: RunnerConfigFilePath.make(join(dir, "missing-mcp.json")),
              }),
            },
          )
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "non-canonical mcpConfigPath",
            },
            {
              brief: makeBrief({
                mcpConfigPath: RunnerConfigFilePath.make(join(symParentDir, "real-mcp.json")),
              }),
            },
          )

          // S-3.5: realpathSync throw preserves underlying EACCES detail
          const realpathThrowHostIo = {
            ...nodeSyncHostIo,
            realpathSync: (p: string) => {
              if (p === realMcp) {
                throw new Error("EACCES: permission denied canonicalizing mcp.json")
              }
              return nodeSyncHostIo.realpathSync(p)
            },
          }
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "EACCES: permission denied canonicalizing mcp.json",
            },
            {
              brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(realMcp) }),
              hostIo: realpathThrowHostIo,
            },
          )

          // S-3.6: >65536 bytes reports explicit size limit error rather than "Invalid JSON"
          const oversizedMcp = join(dir, "oversized-mcp.json")
          writeFileSync(
            oversizedMcp,
            JSON.stringify({ mcpServers: { big: { command: "x".repeat(70_000) } } }),
            "utf8",
          )
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "exceeds 65536 bytes limit",
            },
            { brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(oversizedMcp) }) },
          )

          const invalidJsonMcp = join(dir, "invalid-mcp.json")
          writeFileSync(invalidJsonMcp, "{not-valid-json", "utf8")
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              detailPart: "Invalid JSON in mcpConfigPath",
            },
            { brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(invalidJsonMcp) }) },
          )

          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          const explicitRes = yield* runClaudeCodeImpl(
            {
              runId: WorkflowRunId.make("run-claude-mcp-ok"),
              runner: "claude-code",
              brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(realMcp) }),
              cwd: repoRoot,
            },
            { env: spawnEnv },
          )
          expect(explicitRes.exit).toBe(0)
          const explicitCaptured = yield* Schema.decodeEffect(CapturedCliInvocationSchema)(
            readFileSync(join(repoRoot, "claude-capture.json"), "utf8"),
          )
          const explicitMcpIdx = explicitCaptured.argv.indexOf("--mcp-config")
          const scopedMcpPath = explicitCaptured.argv[explicitMcpIdx + 1]!
          expect(scopedMcpPath).not.toBe(realMcp)
          expect(existsSync(scopedMcpPath)).toBe(false)
          const parsedExplicitMcp = yield* Schema.decodeEffect(McpConfigCheckSchema)(
            explicitCaptured.mcpJson!,
          )
          expect(parsedExplicitMcp.mcpServers).toEqual({ custom: { command: "echo" } })
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-2.3: ClaudeCodeRunner handles >80 KiB stdout and rejects >1 MiB overflow",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const largeText = "x".repeat(90_000)
          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(largeText)}, is_error: false }));`,
          )
          const largeRes = yield* runClaudeCodeImpl(
            {
              runId: WorkflowRunId.make("run-claude-large"),
              runner: "claude-code",
              brief: makeBrief(),
              cwd: repoRoot,
            },
            { env },
          )
          expect(largeRes.resultText).toBe(largeText)

          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write("{" + "a".repeat(1024 * 1024 + 512) + "}");`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentOutputParseError",
            runner: "claude-code",
            detailPart: "exceeded 1048576 bytes",
          })
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-2.3 / F-7.1: ClaudeCodeRunner maps denial, auth, parse, exit, spawn-failed (kind='spawn-failed'), and signal",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf /" } }] }));`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentToolDeniedError",
            runner: "claude-code",
            noticePart: "Bash",
          })

          writeExecutableScript(
            binDir,
            "claude",
            `process.stderr.write("Authentication required: please run /login\\n"); process.exit(1);`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentAuthRequiredError",
            runner: "claude-code",
            detailPart: "Authentication required",
          })

          writeExecutableScript(binDir, "claude", `process.stdout.write("{bad-json");`)
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentOutputParseError",
            runner: "claude-code",
          })

          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ result: "boom", is_error: true })); process.exit(2);`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentExitError",
            runner: "claude-code",
            exit: 2,
            detailPart: "boom",
          })

          // F-7.1: Missing binary maps to kind === "spawn-failed" with PATH + workflow doctor guidance
          yield* runClaudeFail(
            repoRoot,
            { ...env, PATH: join(dir, "empty-bin") },
            {
              _tag: "AgentExitError",
              runner: "claude-code",
              exit: 1,
              kind: "spawn-failed",
              detailPart: "workflow doctor",
            },
          )

          writeExecutableScript(binDir, "claude", `process.kill(process.pid, "SIGKILL");`)
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentExitError",
            runner: "claude-code",
            exit: 1,
            kind: "signal",
            detailPart: "SIGKILL",
          })
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-3.1..3.2 / F-14.5: AntigravityRunner strips env, passes killGraceMs to --print-timeout, and retries exit 3",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const attemptCounterPath = join(dir, "agy-attempts.txt")
          writeExecutableScript(
            binDir,
            "agy",
            `
const fs = require("node:fs");
const countPath = ${JSON.stringify(attemptCounterPath)};
const prev = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
const next = prev + 1;
fs.writeFileSync(countPath, String(next), "utf8");
if (next < 3) {
  process.exit(3);
}
fs.writeFileSync(${JSON.stringify(join(repoRoot, "agy-capture.json"))}, JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdinBytes: fs.readFileSync(0).length,
}), "utf8");
process.stdout.write(JSON.stringify({
  conversation_id: "conv-agy-1",
  status: "SUCCESS",
  response: "Antigravity completed",
  num_turns: 2,
  duration_seconds: 1.5,
  usage: { input_tokens: 40, output_tokens: 20, thinking_tokens: 5, total_tokens: 65 },
}));
`,
          )

          const { result: agyResult, spans } = yield* runWithTestTracer(
            "agy-retry-success",
            runAgentRunnerImpl(
              {
                runId: WorkflowRunId.make("run-agy-retry"),
                runner: "antigravity",
                brief: makeBrief(),
                cwd: repoRoot,
              },
              {
                env,
                antigravityOptions: {
                  timeoutMs: 2_000,
                  killGraceMs: 4_000,
                  startupRetryMaxAttempts: 3,
                  startupRetryBackoffMs: 5,
                },
              },
            ),
          )
          expect(agyResult.runner).toBe("antigravity")
          expect(agyResult.resultText).toContain("Antigravity completed")
          expect(readFileSync(attemptCounterPath, "utf8")).toBe("3")
          expect(spans.some((s) => s.name === "AgentRunner.run")).toBe(true)
          expect(spans.some((s) => s.name === "AntigravityRunner.run")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])

          const agyCaptured = yield* Schema.decodeEffect(CapturedCliInvocationSchema)(
            readFileSync(join(repoRoot, "agy-capture.json"), "utf8"),
          )
          expect(agyCaptured.cwd).toBe(repoRoot)
          expect(agyCaptured.stdinBytes).toBe(0)
          expect(agyCaptured.argv).not.toContain("--dangerously-skip-permissions")
          expect(agyCaptured.argv).toContain("--output-format")
          expect(agyCaptured.argv).toContain("json")
          const ptIdx = agyCaptured.argv.indexOf("--print-timeout")
          expect(ptIdx).toBeGreaterThan(-1)
          expect(agyCaptured.argv[ptIdx + 1]).toBe("6s")
          expect(agyCaptured.argv).toContain("--mode")
          expect(agyCaptured.argv).toContain("accept-edits")
          expect(agyCaptured.env["HARNESS_UNIT_WORKER"]).toBe("1")
          expect(capturedIsStripped(agyCaptured.env)).toBe(true)
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-3.2 / S-3.2: AntigravityRunner rejects hard MCP isolation by default and logs/annotates span on fallback-claude",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const emptyBinDir = join(dir, "empty-bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          mkdirSync(emptyBinDir, { recursive: true })
          const spawnEnv = makeFakeCliEnv(binDir, homeDir)
          const env = { ...spawnEnv, PATH: emptyBinDir }

          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentToolDeniedError",
              runner: "antigravity",
              noticePart: "hard MCP isolation",
            },
            { mcpIsolation: "hard" },
          )
          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentToolDeniedError",
              runner: "antigravity",
              noticePart: "hard MCP isolation",
            },
            { mcpIsolation: "hard", hardMcpFallback: "reject" },
          )

          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          const loggedWarnings: Array<string> = []
          const captureLogger = Logger.make(({ message }) => {
            loggedWarnings.push(String(message))
          })
          const fallbackRes = yield* runAntigravityImpl(
            {
              runId: WorkflowRunId.make("run-agy-fallback"),
              runner: "antigravity",
              brief: makeBrief(),
              cwd: repoRoot,
              mcpIsolation: "hard",
              hardMcpFallback: "fallback-claude",
            },
            { env: spawnEnv, startupRetryMaxAttempts: 5, startupRetryBackoffMs: 10 },
          ).pipe(Effect.provide(Logger.layer([captureLogger])))
          expect(fallbackRes.runner).toBe("claude-code")
          expect(loggedWarnings.some((m) => m.includes("falling back to 'claude-code'"))).toBe(true)
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-3.3..3.4 / F-2.2: AntigravityRunner clamps Infinity retries, ignores benign stderr on exit-0 SUCCESS, and classifies failures",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const infCounter = join(dir, "agy-inf-attempts.txt")
          writeExecutableScript(
            binDir,
            "agy",
            `const fs = require("node:fs"); const p = ${JSON.stringify(infCounter)}; fs.writeFileSync(p, String((fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1)); process.exit(3);`,
          )
          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "antigravity",
              exit: 3,
              messagePart: "exited with code 3",
            },
            { startupRetryMaxAttempts: Number.POSITIVE_INFINITY, startupRetryBackoffMs: 1 },
          )
          expect(readFileSync(infCounter, "utf8")).toBe("3")

          const nonEmptyCounter = join(dir, "agy-nonempty-attempts.txt")
          writeExecutableScript(
            binDir,
            "agy",
            `const fs = require("node:fs"); const p = ${JSON.stringify(nonEmptyCounter)}; fs.writeFileSync(p, String((fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1)); process.stdout.write("non-empty-failure"); process.exit(3);`,
          )
          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: "antigravity",
              exit: 3,
              detailPart: "non-empty-failure",
            },
            { startupRetryMaxAttempts: 3, startupRetryBackoffMs: 5 },
          )
          expect(readFileSync(nonEmptyCounter, "utf8")).toBe("1")

          // F-2.2: exit 0 + status: "SUCCESS" succeeds cleanly even when stderr mentions permission denied
          writeExecutableScript(
            binDir,
            "agy",
            `process.stderr.write("Permission denied by policy\\n"); process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "ok" }));`,
          )
          const benignStderrOk = yield* runAntigravityImpl(
            {
              runId: WorkflowRunId.make("run-agy-benign-stderr"),
              runner: "antigravity",
              brief: makeBrief(),
              cwd: repoRoot,
            },
            { env },
          )
          expect(benignStderrOk.exit).toBe(0)
          expect(benignStderrOk.resultText).toBe("ok")

          // F-2.2: status: "FAILED" (or non-zero exit) + stderr soft-denial maps to AgentToolDeniedError
          writeExecutableScript(
            binDir,
            "agy",
            `process.stderr.write("Permission denied by policy\\n"); process.stdout.write(JSON.stringify({ status: "FAILED", response: "denied" })); process.exit(1);`,
          )
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentToolDeniedError",
            runner: "antigravity",
            noticePart: "Permission denied by policy",
          })

          writeExecutableScript(
            binDir,
            "agy",
            `process.stderr.write("Authentication required: agy login\\n"); process.exit(1);`,
          )
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentAuthRequiredError",
            runner: "antigravity",
            detailPart: "Authentication required",
          })

          writeExecutableScript(binDir, "agy", `process.stdout.write("not-json");`)
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentOutputParseError",
            runner: "antigravity",
          })

          // F-7.1: Missing agy binary maps to kind === "spawn-failed"
          yield* runAgyFail(
            repoRoot,
            { ...env, PATH: join(dir, "empty-bin") },
            {
              _tag: "AgentExitError",
              runner: "antigravity",
              exit: 1,
              kind: "spawn-failed",
              detailPart: "workflow doctor",
            },
          )
        }),
      ),
  )

  it.live(
    "S-2.1: AgentRunnerPort enforces profile.maxConcurrency per runner without module-global state",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const activeDir = join(dir, "active-slots")
          const peakFile = join(dir, "peak.txt")
          mkdirSync(activeDir, { recursive: true })
          writeFileSync(peakFile, "0", "utf8")

          writeExecutableScript(
            binDir,
            "agy",
            `
const fs = require("node:fs");
const path = require("node:path");
const activeDir = ${JSON.stringify(activeDir)};
const peakFile = ${JSON.stringify(peakFile)};
const slotPath = path.join(activeDir, String(process.pid) + "-" + Date.now() + "-" + Math.random());
fs.writeFileSync(slotPath, "1", "utf8");
const current = fs.readdirSync(activeDir).length;
const prevPeak = Number(fs.readFileSync(peakFile, "utf8"));
if (current > prevPeak) fs.writeFileSync(peakFile, String(current), "utf8");
setTimeout(() => {
  fs.unlinkSync(slotPath);
  process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "concurrent ok" }));
}, 140);
`,
          )

          const env = makeFakeCliEnv(binDir, homeDir)
          const results = yield* Effect.gen(function* () {
            const port = yield* AgentRunnerPort
            return yield* Effect.forEach(
              [1, 2, 3, 4],
              (idx) =>
                port.run({
                  runId: WorkflowRunId.make(`run-conc-${idx}`),
                  runner: "antigravity",
                  brief: makeBrief(),
                  cwd: repoRoot,
                }),
              { concurrency: "unbounded" },
            )
          }).pipe(Effect.provide(makeAgentRunnerPortLayer({ env })))

          expect(results).toHaveLength(4)
          const peakObserved = Number(readFileSync(peakFile, "utf8").trim())
          expect(peakObserved).toBeGreaterThanOrEqual(1)
          expect(peakObserved).toBeLessThanOrEqual(2)
        }),
      ),
  )
})

const capturedIsStripped = (env: Readonly<Record<string, string>>): boolean =>
  env["ANTIGRAVITY_CLI_ALIAS"] === undefined &&
  env["AGY_SESSION_ID"] === undefined &&
  env["CLOUDFLARE_API_TOKEN"] === undefined
