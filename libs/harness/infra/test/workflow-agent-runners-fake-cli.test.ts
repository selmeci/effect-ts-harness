import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, type Exit, Fiber, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AgentAuthRequiredError,
  AgentDiagnosticDetail,
  AgentExitCode,
  AgentExitError,
  AgentNoChangeError,
  AgentOutputParseError,
  type AgentRunResult,
  type AgentRunnerError,
  AgentTimeoutError,
  AgentToolDeniedError,
  AttemptNumber,
  BriefPrompt,
  DenialNotice,
  OwnedRelPath,
  RunnerConfigFilePath,
  RunnerId,
  TimeoutMillis,
  UnitBrief,
  UnitRejection,
  WorkUnitId,
  WorkflowRunId,
} from "@harness/contract"
import { decideSpanBudgets } from "@harness/gates"
import { AgentRunnerPort, UnitAgentDispatcher, UnitVerifier } from "@harness/service"
import {
  UnitAgentDispatcherLiveFromPort,
  UnitVerifierLive,
  inspectWorkflowRunnerDoctorChecks,
  makeAgentRunnerPortLayer,
  makeAntigravityRunnerLayer,
  makeClaudeCodeRunnerLayer,
  reapOrphanAttemptProcessGroup,
  runAgentRunnerImpl,
  runAntigravityImpl,
  runClaudeCodeImpl,
  toOutcome,
} from "../src/index.js"
import { resolveHarnessInstallationRoot } from "../src/workflow/runner-profiles.js"
import { isProcessGroupAlive } from "../src/workflow/verify-child-process.js"
import {
  initGitRepo,
  makePackageUnit,
  runWithTestTracer,
  waitForFilesExist,
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

const readLinuxProcStartTimeForTest = (pid: number): string | undefined => {
  if (process.platform !== "linux") {
    return undefined
  }
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
  const commEnd = raw.lastIndexOf(")")
  return raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/)[19]
}

const makeFakeCliEnv = (
  binDir: string,
  homeDir: string,
  extra?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => ({
  PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
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
    promptText: BriefPrompt.make(overrides?.promptText ?? "Implement REQ-1 in libs/alpha"),
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
      if (expected.afterMillis !== undefined) {
        expect(e.afterMillis).toBe(expected.afterMillis)
      }
    })
    .with({ _tag: "AgentToolDeniedError" }, (e) => {
      if (expected.noticePart !== undefined) {
        expect(e.notice).toContain(expected.noticePart)
      }
    })
    .with({ _tag: "AgentAuthRequiredError" }, (e) => {
      if (expected.detailPart !== undefined) {
        expect(e.detail).toContain(expected.detailPart)
      }
    })
    .with({ _tag: "AgentExitError" }, (e) => {
      if (expected.exit !== undefined) {
        expect(e.exit).toBe(expected.exit)
      }
      if (expected.detailPart !== undefined) {
        expect(e.detail).toContain(expected.detailPart)
      }
    })
    .with({ _tag: "AgentOutputParseError" }, (e) => {
      expect(e.detail).toBeDefined()
      if (expected.detailPart !== undefined) {
        expect(e.detail).toContain(expected.detailPart)
      }
    })
    .with({ _tag: "AgentNoChangeError" }, () => undefined)
    .exhaustive()
}

type ExpectedFailure = Parameters<typeof assertRunnerFailure>[1]

const runClaudeFail = (
  cwd: AbsoluteRepoRoot,
  env: Readonly<Record<string, string | undefined>>,
  expected: ExpectedFailure,
  brief?: UnitBrief,
) =>
  Effect.exit(
    runClaudeCodeImpl(
      { runner: RunnerId.make("claude-code"), brief: brief ?? makeBrief(), cwd },
      { env },
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
        runner: RunnerId.make("antigravity"),
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

describe("SPEC-0036 WF-5 Agent Runners (Fake CLI & Supervision)", () => {
  it.live(
    "REQ-1.1..1.3 / REQ-2.1..2.2: ClaudeCodeRunnerLive isolates argv, PreToolUse-only hooks, env, stdio, and cleans temp dir",
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
                runner: RunnerId.make("claude-code"),
                brief: makeBrief(),
                cwd: repoRoot,
              },
              { env },
            ),
          )

          expect(result.runner).toBe("claude-code")
          expect(result.exit).toBe(0)
          expect(result.resultText).toContain("Implemented alpha")
          expect(result.usage.status).toBe("reported")
          expect(result.usage.inputTokens).toBe(100)
          expect(result.usage.outputTokens).toBe(50)

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
    "REQ-2.1..2.2: ClaudeCodeRunner validates mcpConfigPath (symlink, missing, ancestor symlink, invalid JSON, valid scoped copy)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

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
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "Invalid or missing mcpConfigPath",
            },
            makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(symlinkMcp) }),
          )
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "Invalid or missing mcpConfigPath",
            },
            makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(join(dir, "missing-mcp.json")) }),
          )
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "non-canonical mcpConfigPath",
            },
            makeBrief({
              mcpConfigPath: RunnerConfigFilePath.make(join(symParentDir, "real-mcp.json")),
            }),
          )

          const invalidJsonMcp = join(dir, "invalid-mcp.json")
          writeFileSync(invalidJsonMcp, "{not-valid-json", "utf8")
          yield* runClaudeFail(
            repoRoot,
            env,
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "Invalid JSON in mcpConfigPath",
            },
            makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(invalidJsonMcp) }),
          )

          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          const explicitRes = yield* runClaudeCodeImpl(
            {
              runner: RunnerId.make("claude-code"),
              brief: makeBrief({ mcpConfigPath: RunnerConfigFilePath.make(realMcp) }),
              cwd: repoRoot,
            },
            { env },
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
    "REQ-2.3: ClaudeCodeRunner handles >80 KiB stdout, rejects >1 MiB overflow, and maps denial/auth/parse/exit/spawn/signal errors",
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
            { runner: RunnerId.make("claude-code"), brief: makeBrief(), cwd: repoRoot },
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
            runner: RunnerId.make("claude-code"),
            detailPart: "exceeded 1048576 bytes",
          })

          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf /" } }] }));`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentToolDeniedError",
            runner: RunnerId.make("claude-code"),
            noticePart: "Bash",
          })

          writeExecutableScript(
            binDir,
            "claude",
            `process.stderr.write("Authentication required: please run /login\\n"); process.exit(1);`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentAuthRequiredError",
            runner: RunnerId.make("claude-code"),
            detailPart: "Authentication required",
          })

          writeExecutableScript(binDir, "claude", `process.stdout.write("{bad-json");`)
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentOutputParseError",
            runner: RunnerId.make("claude-code"),
          })

          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ result: "boom", is_error: true })); process.exit(2);`,
          )
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentExitError",
            runner: RunnerId.make("claude-code"),
            exit: 2,
            detailPart: "boom",
          })

          yield* runClaudeFail(
            repoRoot,
            { ...env, PATH: join(dir, "empty-bin") },
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "ENOENT",
            },
          )

          writeExecutableScript(binDir, "claude", `process.kill(process.pid, "SIGKILL");`)
          yield* runClaudeFail(repoRoot, env, {
            _tag: "AgentExitError",
            runner: RunnerId.make("claude-code"),
            exit: 1,
            detailPart: "SIGKILL",
          })
        }),
      ),
  )

  it.live(
    "REQ-3.1..3.2: AntigravityRunner strips env via runAgentRunnerImpl, retries exit 3, and handles hard MCP isolation",
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
                runner: RunnerId.make("antigravity"),
                brief: makeBrief(),
                cwd: repoRoot,
              },
              {
                env,
                antigravityOptions: {
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
          expect(agyCaptured.argv).toContain("--print-timeout")
          expect(agyCaptured.argv).toContain("--mode")
          expect(agyCaptured.argv).toContain("accept-edits")
          expect(agyCaptured.env["HARNESS_UNIT_WORKER"]).toBe("1")
          expect(agyCaptured.env["ANTIGRAVITY_CLI_ALIAS"]).toBeUndefined()
          expect(agyCaptured.env["AGY_SESSION_ID"]).toBeUndefined()
          expect(agyCaptured.env["CLOUDFLARE_API_TOKEN"]).toBeUndefined()

          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentToolDeniedError",
              runner: RunnerId.make("antigravity"),
              noticePart: "hard MCP isolation",
            },
            { mcpIsolation: "hard" },
          )
          yield* runAgyFail(
            repoRoot,
            env,
            {
              _tag: "AgentToolDeniedError",
              runner: RunnerId.make("antigravity"),
              noticePart: "hard MCP isolation",
            },
            { mcpIsolation: "hard", hardMcpFallback: "reject" },
          )

          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          const fallbackRes = yield* runAntigravityImpl(
            {
              runner: RunnerId.make("antigravity"),
              brief: makeBrief(),
              cwd: repoRoot,
              mcpIsolation: "hard",
              hardMcpFallback: "fallback-claude",
            },
            { env },
          )
          expect(fallbackRes.runner).toBe("claude-code")
        }),
      ),
  )

  it.live(
    "REQ-3.3..3.4: AntigravityRunner clamps Infinity retries, skips retry on non-empty exit 3, and classifies errors",
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
              runner: RunnerId.make("antigravity"),
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
              runner: RunnerId.make("antigravity"),
              exit: 3,
              detailPart: "non-empty-failure",
            },
            { startupRetryMaxAttempts: 3, startupRetryBackoffMs: 5 },
          )
          expect(readFileSync(nonEmptyCounter, "utf8")).toBe("1")

          writeExecutableScript(
            binDir,
            "agy",
            `process.stderr.write("Permission denied by policy\\n"); process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "ok" }));`,
          )
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentToolDeniedError",
            runner: RunnerId.make("antigravity"),
            noticePart: "Permission denied by policy",
          })

          writeExecutableScript(
            binDir,
            "agy",
            `process.stderr.write("Authentication required: agy login\\n"); process.exit(1);`,
          )
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentAuthRequiredError",
            runner: RunnerId.make("antigravity"),
            detailPart: "Authentication required",
          })

          writeExecutableScript(binDir, "agy", `process.stdout.write("not-json");`)
          yield* runAgyFail(repoRoot, env, {
            _tag: "AgentOutputParseError",
            runner: RunnerId.make("antigravity"),
          })
        }),
      ),
  )

  it.live(
    "REQ-1.4: Process-group timeout and fiber interruption reap SIGTERM-ignoring grandchild and clean gitCommonDir pgid record",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const grandchildPidPath = join(dir, "grandchild.pid")
          writeExecutableScript(
            binDir,
            "claude",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid), "utf8");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          )

          const runId = WorkflowRunId.make("run-timeout-pgid")
          assertRunnerFailure(
            yield* Effect.exit(
              runClaudeCodeImpl(
                {
                  runId,
                  runner: RunnerId.make("claude-code"),
                  brief: makeBrief(),
                  cwd: repoRoot,
                },
                { env, timeoutMs: 200, killGraceMs: 80 },
              ),
            ),
            {
              _tag: "AgentTimeoutError",
              runner: RunnerId.make("claude-code"),
              afterMillis: 200,
            },
          )

          const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8").trim())
          expect(grandchildPid).toBeGreaterThan(0)
          expect(isProcessGroupAlive(grandchildPid)).toBe(false)
          expect(
            existsSync(
              join(repoRoot, ".git", "harness", "runner-pgids", `${runId}-pkg-alpha-1.json`),
            ),
          ).toBe(false)
          expect(existsSync(join(repoRoot, ".harness", "runner-pgids"))).toBe(false)

          const interruptPidPath = join(dir, "interrupt-child.pid")
          writeExecutableScript(
            binDir,
            "claude",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(interruptPidPath)}, String(child.pid), "utf8");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          )
          const interruptRunId = WorkflowRunId.make("run-interrupt-1")
          const interruptFiber = yield* Effect.forkChild(
            runClaudeCodeImpl(
              {
                runId: interruptRunId,
                runner: RunnerId.make("claude-code"),
                brief: makeBrief(),
                cwd: repoRoot,
              },
              { env, timeoutMs: 10_000, killGraceMs: 80 },
            ),
          )
          expect(yield* waitForFilesExist([interruptPidPath])).toBe(true)
          const expectedInterruptPgidPath = join(
            repoRoot,
            ".git",
            "harness",
            "runner-pgids",
            `${interruptRunId}-pkg-alpha-1.json`,
          )
          expect(existsSync(expectedInterruptPgidPath)).toBe(true)
          expect(existsSync(join(repoRoot, ".harness", "runner-pgids"))).toBe(false)
          yield* Fiber.interrupt(interruptFiber)
          const interruptChildPid = Number(readFileSync(interruptPidPath, "utf8").trim())
          expect(interruptChildPid).toBeGreaterThan(0)
          expect(isProcessGroupAlive(interruptChildPid)).toBe(false)
          expect(existsSync(expectedInterruptPgidPath)).toBe(false)
        }),
      ),
  )

  it.live(
    "REQ-1.4: reapOrphanAttemptProcessGroup enforces procStartTime, symlink, corrupt, and non-git tmpdir isolation",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const orphanReadyPath = join(dir, "orphan.ready")
          const orphanProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(orphanReadyPath)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const orphanPid = orphanProc.pid!
          orphanProc.unref()
          expect(yield* waitForFilesExist([orphanReadyPath])).toBe(true)
          expect(isProcessGroupAlive(orphanPid)).toBe(true)

          const gitPgidDir = join(repoRoot, ".git", "harness", "runner-pgids")
          mkdirSync(gitPgidDir, { recursive: true })
          const orphanRunId = WorkflowRunId.make("run-orphan-1")
          const orphanRecordPath = join(gitPgidDir, `${orphanRunId}-pkg-alpha-1.json`)
          const orphanStartTime = readLinuxProcStartTimeForTest(orphanPid)
          writeFileSync(
            orphanRecordPath,
            JSON.stringify({
              pgid: orphanPid,
              ...(orphanStartTime !== undefined ? { procStartTime: orphanStartTime } : {}),
            }),
            "utf8",
          )

          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          const recoveredRes = yield* runClaudeCodeImpl(
            {
              runId: orphanRunId,
              runner: RunnerId.make("claude-code"),
              brief: makeBrief(),
              cwd: repoRoot,
            },
            { env },
          )
          expect(recoveredRes.exit).toBe(0)
          expect(isProcessGroupAlive(orphanPid)).toBe(false)
          expect(existsSync(orphanRecordPath)).toBe(false)

          const nonGitCwd = join(dir, "non-git-cwd")
          mkdirSync(nonGitCwd, { recursive: true })
          const nonGitRunId = WorkflowRunId.make("run-non-git-1")
          const nonGitRes = yield* runClaudeCodeImpl(
            {
              runId: nonGitRunId,
              runner: RunnerId.make("claude-code"),
              brief: makeBrief(),
              cwd: AbsoluteRepoRoot.make(nonGitCwd),
            },
            { env },
          )
          expect(nonGitRes.exit).toBe(0)
          expect(existsSync(join(nonGitCwd, ".harness"))).toBe(false)
          expect(
            existsSync(join(tmpdir(), "harness-runner-pgids", `${nonGitRunId}-pkg-alpha-1.json`)),
          ).toBe(false)

          const corruptPgidPath = join(dir, "corrupt-pgid.json")
          writeFileSync(corruptPgidPath, "{bad-pgid", "utf8")
          yield* reapOrphanAttemptProcessGroup(corruptPgidPath)
          expect(existsSync(corruptPgidPath)).toBe(false)

          const symTargetPgidPath = join(dir, "sym-target-pgid.json")
          writeFileSync(symTargetPgidPath, JSON.stringify({ pgid: 999999 }), "utf8")
          const symPgidPath = join(dir, "sym-pgid.json")
          symlinkSync(symTargetPgidPath, symPgidPath)
          yield* reapOrphanAttemptProcessGroup(symPgidPath)
          expect(existsSync(symTargetPgidPath)).toBe(true)

          const liveGuardReady = join(dir, "guard.ready")
          const liveGuardProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(liveGuardReady)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const liveGuardPid = liveGuardProc.pid!
          liveGuardProc.unref()
          expect(yield* waitForFilesExist([liveGuardReady])).toBe(true)

          if (process.platform === "linux") {
            const missingStartPath = join(dir, "missing-start-pgid.json")
            writeFileSync(missingStartPath, JSON.stringify({ pgid: liveGuardPid }), "utf8")
            yield* reapOrphanAttemptProcessGroup(missingStartPath)
            expect(isProcessGroupAlive(liveGuardPid)).toBe(true)
            expect(existsSync(missingStartPath)).toBe(false)
          }

          const reuseRecordPath = join(dir, "reuse-pgid.json")
          writeFileSync(
            reuseRecordPath,
            JSON.stringify({ pgid: liveGuardPid, procStartTime: "999999999999" }),
            "utf8",
          )
          yield* reapOrphanAttemptProcessGroup(reuseRecordPath)
          if (process.platform === "linux") {
            expect(isProcessGroupAlive(liveGuardPid)).toBe(true)
          }
          expect(existsSync(reuseRecordPath)).toBe(false)
          if (isProcessGroupAlive(liveGuardPid)) {
            process.kill(-liveGuardPid, "SIGKILL")
          }
        }),
      ),
  )

  it.live(
    "REQ-4.1..4.4: All 6 AgentRunnerError variants map via toOutcome, UnitVerifierLive emits AgentNoChangeError, and dispatcher spans satisfy SpanBudget",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const unitId = WorkUnitId.make("pkg-alpha")
          const attempt = AttemptNumber.make(1)

          const authOutcome = toOutcome(
            unitId,
            attempt,
            new AgentAuthRequiredError({ runner: RunnerId.make("claude-code") }),
          )
          expect(authOutcome._tag).toBe("Escalated")

          const rejectedErrors: ReadonlyArray<AgentRunnerError> = [
            new AgentTimeoutError({
              runner: RunnerId.make("claude-code"),
              afterMillis: TimeoutMillis.make(1000),
            }),
            new AgentToolDeniedError({
              runner: RunnerId.make("claude-code"),
              notice: DenialNotice.make("denied"),
            }),
            new AgentExitError({
              runner: RunnerId.make("antigravity"),
              exit: AgentExitCode.make(2),
            }),
            new AgentOutputParseError({
              runner: RunnerId.make("antigravity"),
              detail: AgentDiagnosticDetail.make("bad json"),
            }),
            new AgentNoChangeError({ runner: RunnerId.make("claude-code") }),
          ]
          for (const err of rejectedErrors) {
            const outcome = toOutcome(unitId, attempt, err)
            match(outcome)
              .with({ _tag: "Rejected" }, ({ rejection }) => {
                match(rejection)
                  .with({ _tag: "AgentFailed" }, ({ reason }) => {
                    expect(reason).toContain(err._tag)
                  })
                  .with(
                    { _tag: "WriteSetViolation" },
                    { _tag: "PackageVerifyFailed" },
                    { _tag: "StampMissing" },
                    () => {
                      expect.unreachable(`Expected AgentFailed for ${err._tag}`)
                    },
                  )
                  .exhaustive()
              })
              .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
                expect.unreachable(`Expected Rejected for ${err._tag}`)
              })
              .exhaustive()
          }

          // UnitVerifierLive ignores .harness/runner-pgids/* artifacts and still emits AgentNoChangeError
          mkdirSync(join(repoRoot, ".harness", "runner-pgids"), { recursive: true })
          writeFileSync(
            join(repoRoot, ".harness", "runner-pgids", "stale-pgid.json"),
            '{"pgid":1}',
            "utf8",
          )
          const autoEmptyOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-empty-auto"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt,
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
              runner: RunnerId.make("claude-code"),
            })
          }).pipe(Effect.provide(UnitVerifierLive))
          match(autoEmptyOutcome)
            .with({ _tag: "Rejected" }, ({ rejection }) => {
              match(rejection)
                .with({ _tag: "AgentFailed" }, ({ reason }) => {
                  expect(reason).toContain("AgentNoChangeError")
                })
                .with(
                  { _tag: "WriteSetViolation" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected AgentFailed for empty automatic diff")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected for empty automatic diff")
            })
            .exhaustive()

          const manualEmptyOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-empty-manual"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt,
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            })
          }).pipe(Effect.provide(UnitVerifierLive))
          expect(manualEmptyOutcome).toMatchObject({
            _tag: "Rejected",
            rejection: {
              _tag: "AgentFailed",
              reason: "No changed files detected for unit completion",
            },
          })
        }),
      ),
  )

  it.live(
    "REQ-4.1..4.3: UnitAgentDispatcherLiveFromPort satisfies SpanBudget and dedicated runner layers fail closed on mismatch",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          writeExecutableScript(binDir, "claude", CLAUDE_CAPTURE_SCRIPT)
          writeExecutableScript(
            binDir,
            "agy",
            `process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "Layer agy ok" }));`,
          )
          const env = makeFakeCliEnv(binDir, homeDir)

          const { result: dispatched, spans } = yield* runWithTestTracer(
            "dispatcher-live-fake",
            Effect.gen(function* () {
              const dispatcher = yield* UnitAgentDispatcher
              return yield* dispatcher.dispatchUnit({
                runId: WorkflowRunId.make("run-dispatch-span"),
                unit: makePackageUnit(),
                attempt: AttemptNumber.make(2),
                runner: RunnerId.make("claude-code"),
                cwd: repoRoot,
                priorRejection: UnitRejection.cases.StampMissing.make({}),
              })
            }).pipe(
              Effect.provide(
                UnitAgentDispatcherLiveFromPort.pipe(
                  Layer.provide(makeAgentRunnerPortLayer({ env })),
                ),
              ),
            ),
          )
          expect(dispatched._tag).toBe("Completed")
          expect(spans.some((s) => s.name === "UnitAgentDispatcher.dispatchUnit")).toBe(true)
          expect(spans.some((s) => s.name === "AgentRunner.run")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])

          const claudeLayerOk = yield* Effect.gen(function* () {
            const port = yield* AgentRunnerPort
            return yield* port.run({
              runner: RunnerId.make("claude-code"),
              brief: makeBrief(),
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeClaudeCodeRunnerLayer({ env })))
          expect(claudeLayerOk.runner).toBe("claude-code")
          expect(claudeLayerOk.exit).toBe(0)

          const agyLayerOk = yield* Effect.gen(function* () {
            const port = yield* AgentRunnerPort
            return yield* port.run({
              runner: RunnerId.make("antigravity"),
              brief: makeBrief(),
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeAntigravityRunnerLayer({ env })))
          expect(agyLayerOk.runner).toBe("antigravity")
          expect(agyLayerOk.resultText).toBe("Layer agy ok")

          assertRunnerFailure(
            yield* Effect.exit(
              Effect.gen(function* () {
                const port = yield* AgentRunnerPort
                return yield* port.run({
                  runner: RunnerId.make("antigravity"),
                  brief: makeBrief(),
                  cwd: repoRoot,
                })
              }).pipe(Effect.provide(makeClaudeCodeRunnerLayer({ env }))),
            ),
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("antigravity"),
              exit: 1,
              detailPart: "ClaudeCodeRunner cannot execute",
            },
          )

          assertRunnerFailure(
            yield* Effect.exit(
              Effect.gen(function* () {
                const port = yield* AgentRunnerPort
                return yield* port.run({
                  runner: RunnerId.make("claude-code"),
                  brief: makeBrief(),
                  cwd: repoRoot,
                })
              }).pipe(Effect.provide(makeAntigravityRunnerLayer({ env }))),
            ),
            {
              _tag: "AgentExitError",
              runner: RunnerId.make("claude-code"),
              exit: 1,
              detailPart: "AntigravityRunner cannot execute",
            },
          )
        }),
      ),
  )

  it.live(
    "REQ-4.6: inspectWorkflowRunnerDoctorChecks reports dispatcher, claude, and agy readiness",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(binDir, { recursive: true })
          mkdirSync(homeDir, { recursive: true })

          const missingChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "placeholder",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(missingChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "warn"],
            ["runner-claude-code", "warn"],
            ["runner-antigravity", "warn"],
          ])

          writeExecutableScript(binDir, "claude", "process.exit(0);")
          writeExecutableScript(binDir, "agy", "process.exit(0);")
          const agySettingsDir = join(homeDir, ".gemini", "antigravity-cli")
          mkdirSync(agySettingsDir, { recursive: true })
          const agySettingsPath = join(agySettingsDir, "settings.json")
          writeFileSync(agySettingsPath, JSON.stringify({ mode: "accept-edits" }), "utf8")

          const readyChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(readyChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "ok"],
            ["runner-claude-code", "ok"],
            ["runner-antigravity", "ok"],
          ])

          // Non-executable claude + invalid settings.json -> warn
          chmodSync(join(binDir, "claude"), 0o644)
          writeFileSync(agySettingsPath, "{corrupt-json", "utf8")
          const degradedChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(degradedChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "ok"],
            ["runner-claude-code", "warn"],
            ["runner-antigravity", "warn"],
          ])

          // Symlink settings.json -> runner-antigravity warn
          const realTarget = join(dir, "real-agy-settings.json")
          writeFileSync(realTarget, JSON.stringify({ mode: "accept-edits" }), "utf8")
          const symHome = join(dir, "sym-home")
          const symSettingsDir = join(symHome, ".gemini", "antigravity-cli")
          mkdirSync(symSettingsDir, { recursive: true })
          symlinkSync(realTarget, join(symSettingsDir, "settings.json"))
          const symChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: symHome },
          })
          expect(symChecks[2]?.name).toBe("runner-antigravity")
          expect(symChecks[2]?.status).toBe("warn")
        }),
      ),
  )
})
