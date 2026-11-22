import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Graph, Option } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import { computePreInvocationFingerprintLite } from "@harness/infra/hook-io"
import { tryFastPathIngest } from "../src/commands/ingest-fastpath.js"
import { computePreInvocationFingerprint } from "../src/commands/session-fastpath.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")
const RESOLVER_PATH = join(REPO_ROOT, "tools", "node-ts-resolver.mjs")
const HOOK_ENTRY_PATH = join(REPO_ROOT, "apps", "harness-cli", "src", "hook-entry.ts")
const INDEX_PATH = join(REPO_ROOT, "apps", "harness-cli", "src", "index.ts")

const FORBIDDEN_FASTPATH_MODULES = [
  "@effect/platform-node",
  "@effect/ai-typesafe",
  "libs/harness/contract",
  "libs/harness/graph",
  "libs/harness/ingest",
  "node_modules/typescript",
  "effect/dist/index.js",
  "hook-fallback.ts",
  "apps/harness-cli/src/index.ts",
]

const tempDirs: Array<string> = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const createTempGitRepo = (prefix: string): { readonly dir: string; readonly headSha: string } => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(
    join(dir, "tsconfig.base.json"),
    JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
    "utf8",
  )
  mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
  writeFileSync(
    join(dir, "node_modules", "@effect", "tsgo", "package.json"),
    JSON.stringify({ name: "@effect/tsgo", version: "0.0.0" }),
    "utf8",
  )
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8")
  execFileSync("git", ["add", "pnpm-workspace.yaml", "tsconfig.base.json", "README.md"], {
    cwd: dir,
    encoding: "utf8",
  })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" })
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim()
  return { dir, headSha }
}

const buildChildEnv = (extra?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_TEST_ISOLATION: "1",
    ...extra,
  }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete env[key]
    }
  }
  return env
}

const runEntry = (
  entryPath: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
) =>
  spawnSync(process.execPath, ["--import", RESOLVER_PATH, entryPath, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    input: options?.input,
    encoding: "utf8",
    timeout: 15_000,
    env: buildChildEnv(options?.env),
  })

const runHookEntry = (
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
) => runEntry(HOOK_ENTRY_PATH, args, options)

const inspectLoadedModulesForEntry = (
  entryPath: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
): {
  readonly status: number | null
  readonly stdout: string
  readonly loadedUrls: ReadonlyArray<string>
} => {
  const outDir = mkdtempSync(join(tmpdir(), "harness-mod-inspect-"))
  tempDirs.push(outDir)
  const outFile = join(outDir, "loaded-urls.json")
  const script = `
    import { writeFileSync } from "node:fs";
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    const loaded = [];
    registerHooks({
      load(url, context, nextLoad) {
        loaded.push(url);
        return nextLoad(url, context);
      },
    });
    const entry = process.env.HARNESS_TEST_HOOK_ENTRY;
    const rawArgs = JSON.parse(process.env.HARNESS_TEST_HOOK_ARGS);
    const outPath = process.env.HARNESS_TEST_MOD_OUT;
    process.argv = [process.execPath, entry, ...rawArgs];
    process.on("exit", () => {
      writeFileSync(outPath, JSON.stringify(loaded), "utf8");
    });
    await import(pathToFileURL(entry).href);
  `
  const res = spawnSync(
    process.execPath,
    ["--import", RESOLVER_PATH, "--input-type=module", "-e", script],
    {
      cwd: options?.cwd ?? REPO_ROOT,
      input: options?.input,
      encoding: "utf8",
      timeout: 15_000,
      env: buildChildEnv({
        HARNESS_TEST_HOOK_ENTRY: entryPath,
        HARNESS_TEST_HOOK_ARGS: JSON.stringify(args),
        HARNESS_TEST_MOD_OUT: outFile,
        ...options?.env,
      }),
    },
  )
  const loadedUrls = JSON.parse(readFileSync(outFile, "utf8")) as Array<string>
  return {
    status: res.status,
    stdout: res.stdout,
    loadedUrls,
  }
}

const inspectLoadedModulesForHookEntry = (
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
) => inspectLoadedModulesForEntry(HOOK_ENTRY_PATH, args, options)

const assertNoHeavyModulesLoaded = (loadedUrls: ReadonlyArray<string>): void => {
  for (const forbidden of FORBIDDEN_FASTPATH_MODULES) {
    const matched = loadedUrls.find((u) => u.includes(forbidden))
    expect(
      matched,
      `Expected fast-path not to load ${forbidden}, but loaded ${matched}`,
    ).toBeUndefined()
  }
}

describe("hook-entry.ts fast-path", () => {
  describe("guard --format=antigravity", () => {
    it("allows safe commands and file writes without loading heavy modules", () => {
      const cmdInspect = inspectLoadedModulesForHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
      })
      expect(cmdInspect.status).toBe(0)
      expect(JSON.parse(cmdInspect.stdout.trim())).toEqual({ decision: "allow" })
      assertNoHeavyModulesLoaded(cmdInspect.loadedUrls)

      const fileRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "write_to_file", args: { TargetFile: "src/ok.ts" } },
        }),
      })
      expect(fileRes.status).toBe(0)
      expect(JSON.parse(fileRes.stdout.trim())).toEqual({ decision: "allow" })

      for (const editTool of ["edit_file", "write_file"] as const) {
        const allowEdit = runHookEntry(["guard", "--format=antigravity"], {
          input: JSON.stringify({
            toolCall: { name: editTool, args: { Path: "libs/sample/src/ok.ts" } },
          }),
        })
        expect(allowEdit.status).toBe(0)
        expect(JSON.parse(allowEdit.stdout.trim())).toEqual({ decision: "allow" })

        const denyEdit = runHookEntry(["guard", "--format=antigravity"], {
          input: JSON.stringify({
            toolCall: { name: editTool, args: { Path: ".harness/verify-stamp.json" } },
          }),
        })
        expect(denyEdit.status).toBe(0)
        expect(JSON.parse(denyEdit.stdout.trim()).decision).toBe("deny")
      }
    })

    it.each([
      {
        label: "rm -rf /",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } },
        }),
        reasonPart: "rm -rf",
      },
      {
        label: "protected .harness/verify-stamp.json",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "write_to_file", args: { TargetFile: ".harness/verify-stamp.json" } },
        }),
        reasonPart: ".harness",
      },
      {
        label: "secret .env",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "write_to_file", args: { TargetFile: ".env" } },
        }),
        reasonPart: ".env",
      },
      {
        label: "--help flag",
        args: ["guard", "--format=antigravity", "--help"],
        input: "",
        reasonPart: "CLI parse failure",
      },
      {
        label: "--unknown-flag",
        args: ["guard", "--format=antigravity", "--unknown-flag"],
        input: "",
        reasonPart: "Unrecognized flag",
      },
      {
        label: "missing --format value",
        args: ["guard", "--format=antigravity", "--format"],
        input: "",
        reasonPart: "Missing value for --format",
      },
      {
        label: "empty stdin",
        args: ["guard", "--format=antigravity"],
        input: "   ",
        reasonPart: "empty hook stdin payload",
      },
      {
        label: "malformed JSON",
        args: ["guard", "--format=antigravity"],
        input: "{not valid json",
        reasonPart: "malformed or unrecognized hook stdin JSON payload",
      },
      {
        label: "unrecognized JSON",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({ unexpected: true }),
        reasonPart: "missing command or file path",
      },
    ])("denies $label", ({ args, input, reasonPart }) => {
      const res = runHookEntry(args, { input })
      expect(res.status).toBe(0)
      const parsed = JSON.parse(res.stdout.trim()) as { decision: string; reason: string }
      expect(parsed.decision).toBe("deny")
      expect(parsed.reason).toContain(reasonPart)
    })

    it("asks for alchemy deploy without loading heavy modules", () => {
      const res = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "alchemy deploy" } },
        }),
      })
      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({
        decision: "ask",
        reason: "Command requires human confirmation: alchemy deploy",
      })
    })

    it("dynamically loads CLI fallback on escalation commands (echo $(whoami))", () => {
      const inspect = inspectLoadedModulesForHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "echo $(whoami)" } },
        }),
        env: {
          HARNESS_OLLAMA_URL: "http://127.0.0.1:1",
          OLLAMA_HOST: "http://127.0.0.1:1",
        },
      })
      expect(inspect.status).toBe(0)
      expect(JSON.parse(inspect.stdout.trim())).toEqual({
        decision: "ask",
        reason: expect.stringContaining("DecisionModel unavailable"),
      })
      expect(inspect.loadedUrls.some((u) => u.includes("hook-fallback.ts"))).toBe(true)
    })

    it("enforces Claude Code exit 2 fail-closed when command spoofs Antigravity keys", () => {
      const res = runHookEntry(["guard"], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: 'rm -rf / # "conversationId":1' },
        }),
      })
      expect(res.status).toBe(2)
      expect(res.stdout.trim()).toBe("")
    })

    it("enforces Claude Code output shapes for allow and ask", () => {
      const allowRes = runHookEntry(["guard"], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        }),
      })
      expect(allowRes.status).toBe(0)
      expect(allowRes.stdout).toBe("")

      const askRes = runHookEntry(["guard"], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "alchemy deploy" },
        }),
      })
      expect(askRes.status).toBe(0)
      const parsed = JSON.parse(askRes.stdout.trim()) as {
        hookSpecificOutput: {
          hookEventName: string
          permissionDecision: string
          permissionDecisionReason: string
        }
      }
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse")
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask")
      expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)
    })

    it("denies mixed/masked fields, whitespace-only file_path, and dual/combined risky fields", () => {
      const mixedRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          tool_name: "Read",
          toolCall: {},
          tool_input: { command: "rm -rf /" },
        }),
      })
      expect(mixedRes.status).toBe(0)
      expect((JSON.parse(mixedRes.stdout.trim()) as { decision: string }).decision).toBe("deny")

      const wsPathRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: "   " },
        }),
      })
      expect(wsPathRes.status).toBe(0)
      expect((JSON.parse(wsPathRes.stdout.trim()) as { decision: string }).decision).toBe("deny")

      const emptyCmdLineRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "", command: "rm -rf /" } },
        }),
      })
      expect(emptyCmdLineRes.status).toBe(0)
      expect((JSON.parse(emptyCmdLineRes.stdout.trim()) as { decision: string }).decision).toBe(
        "deny",
      )

      const dualPathRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: {
            name: "write_to_file",
            args: { TargetFile: "safe.ts", AbsolutePath: ".env" },
          },
        }),
      })
      expect(dualPathRes.status).toBe(0)
      expect((JSON.parse(dualPathRes.stdout.trim()) as { decision: string }).decision).toBe("deny")

      const combinedRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm test", TargetFile: ".env" },
          },
        }),
      })
      expect(combinedRes.status).toBe(0)
      expect((JSON.parse(combinedRes.stdout.trim()) as { decision: string }).decision).toBe("deny")
    })

    it("allows Antigravity and Claude Code read-only tools without loading heavy modules", () => {
      const readOnlyInspect = inspectLoadedModulesForHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({ toolCall: { name: "read_file", args: {} } }),
      })
      expect(readOnlyInspect.status).toBe(0)
      expect(JSON.parse(readOnlyInspect.stdout.trim())).toEqual({ decision: "allow" })
      assertNoHeavyModulesLoaded(readOnlyInspect.loadedUrls)

      const ccReadRes = runHookEntry(["guard"], {
        input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
      })
      expect(ccReadRes.status).toBe(0)
      expect(ccReadRes.stdout).toBe("")
    })

    it("asks for HARNESS_ALLOW_SKIP_NX_CACHE=1 override and .oxlintrc.json writes", () => {
      const skipNxRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx test --skip-nx-cache" },
          },
        }),
      })
      expect(skipNxRes.status).toBe(0)
      expect((JSON.parse(skipNxRes.stdout.trim()) as { decision: string }).decision).toBe("ask")

      const oxlintRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "write_to_file", args: { TargetFile: ".oxlintrc.json" } },
        }),
      })
      expect(oxlintRes.status).toBe(0)
      expect((JSON.parse(oxlintRes.stdout.trim()) as { decision: string }).decision).toBe("ask")
    })

    it("fails closed when stdin exceeds 2 MiB maxBytes limit", () => {
      const oversized = "x".repeat(2 * 1024 * 1024 + 1024)

      const agRes = runHookEntry(["guard", "--format=antigravity"], { input: oversized })
      expect(agRes.status).toBe(0)
      const agParsed = JSON.parse(agRes.stdout.trim()) as { decision: string; reason: string }
      expect(agParsed.decision).toBe("deny")
      expect(agParsed.reason).toContain("exceeded")

      const ccRes = runHookEntry(["guard"], { input: oversized })
      expect(ccRes.status).toBe(2)
      expect(ccRes.stdout).toBe("")
      expect(ccRes.stderr).toContain("exceeded")
    })

    it("writes valid JSONL telemetry entry to .harness/telemetry-log.jsonl when HARNESS_TEST_ISOLATION is unset", () => {
      const { dir } = createTempGitRepo("harness-hook-guard-telemetry-")
      const res = runHookEntry(["guard", "--format=antigravity"], {
        cwd: dir,
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
        env: { HARNESS_TEST_ISOLATION: undefined },
      })
      expect(res.status).toBe(0)
      const logPath = join(dir, ".harness", "telemetry-log.jsonl")
      expect(existsSync(logPath)).toBe(true)
      const lines = readFileSync(logPath, "utf8").trim().split("\n")
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const entry = JSON.parse(lines[lines.length - 1]!) as {
        surface: string
        category: string
        toolName: string
        outcome: string
      }
      expect(entry.surface).toBe("hook")
      expect(entry.category).toBe("guard")
      expect(entry.toolName).toBe("guard")
      expect(entry.outcome).toBe("ok")
    })

    it("fails closed with exit 2 and deny JSON when dynamic fallback import fails", () => {
      const script = `
        import { registerHooks } from "node:module";
        import { pathToFileURL } from "node:url";
        registerHooks({
          load(url, context, nextLoad) {
            if (url.includes("hook-fallback.ts")) {
              throw new Error("simulated fallback load failure");
            }
            return nextLoad(url, context);
          },
        });
        const entry = process.env.HARNESS_TEST_HOOK_ENTRY;
        process.argv = [process.execPath, entry, "guard", "--format=antigravity"];
        await import(pathToFileURL(entry).href);
      `
      const res = spawnSync(
        process.execPath,
        ["--import", RESOLVER_PATH, "--input-type=module", "-e", script],
        {
          cwd: REPO_ROOT,
          input: JSON.stringify({
            toolCall: { name: "run_command", args: { CommandLine: "echo $(whoami)" } },
          }),
          encoding: "utf8",
          timeout: 15_000,
          env: buildChildEnv({ HARNESS_TEST_HOOK_ENTRY: HOOK_ENTRY_PATH }),
        },
      )
      expect(res.status).toBe(2)
      const parsed = JSON.parse(res.stdout.trim()) as { decision: string; reason: string }
      expect(parsed.decision).toBe("deny")
      expect(parsed.reason).toContain("failed to load CLI fallback")
    })

    it("loads substantially fewer modules than legacy index.ts", () => {
      const stdinPayload = JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
      })

      const t0 = performance.now()
      const fastInspect = inspectLoadedModulesForEntry(
        HOOK_ENTRY_PATH,
        ["guard", "--format=antigravity"],
        { input: stdinPayload },
      )
      const fastMs = performance.now() - t0
      expect(fastInspect.status).toBe(0)

      const t1 = performance.now()
      const legacyInspect = inspectLoadedModulesForEntry(
        INDEX_PATH,
        ["guard", "--format=antigravity"],
        { input: stdinPayload },
      )
      const legacyMs = performance.now() - t1
      expect(legacyInspect.status).toBe(0)

      console.info(
        `[bench] hook-entry guard fast-path: ${Math.round(fastMs)}ms (${fastInspect.loadedUrls.length} modules) vs index.ts: ${Math.round(legacyMs)}ms (${legacyInspect.loadedUrls.length} modules)`,
      )
      expect(fastInspect.loadedUrls.length).toBeLessThan(legacyInspect.loadedUrls.length)
    })
  })

  describe("fast-path vs full-path guard parity matrix", () => {
    it.each([
      {
        label: "--format antigravity (space form) allow",
        args: ["guard", "--format", "antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
        expectedDecision: "allow",
      },
      {
        label: "--format=antigravity allow",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
        }),
        expectedDecision: "allow",
      },
      {
        label: "--format=antigravity deny",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } },
        }),
        expectedDecision: "deny",
      },
      {
        label: "--format=antigravity ask",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "alchemy deploy" } },
        }),
        expectedDecision: "ask",
      },
      {
        label: "--format=antigravity escalate",
        args: ["guard", "--format=antigravity"],
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "echo $(whoami)" } },
        }),
        expectedDecision: "ask",
      },
      {
        label: "Claude Code mode allow",
        args: ["guard"],
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        }),
        expectedDecision: undefined,
      },
      {
        label: "Claude Code mode deny",
        args: ["guard"],
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
        expectedDecision: undefined,
      },
      {
        label: "malformed JSON",
        args: ["guard", "--format=antigravity"],
        input: "{not valid json",
        expectedDecision: "deny",
      },
      {
        label: "empty stdin",
        args: ["guard", "--format=antigravity"],
        input: "   ",
        expectedDecision: "deny",
      },
    ])("$label matches between hook-entry.ts and index.ts", ({ args, input, expectedDecision }) => {
      const env = {
        HARNESS_OLLAMA_URL: "http://127.0.0.1:1",
        OLLAMA_HOST: "http://127.0.0.1:1",
      }
      const fastRes = runEntry(HOOK_ENTRY_PATH, args, { input, env })
      const fullRes = runEntry(INDEX_PATH, args, { input, env })
      expect(fastRes.status).toBe(fullRes.status)
      expect(fastRes.stdout.trim()).toBe(fullRes.stdout.trim())
      if (expectedDecision !== undefined) {
        expect((JSON.parse(fastRes.stdout.trim()) as { decision: string }).decision).toBe(
          expectedDecision,
        )
      }
    })
  })

  describe("ingest --format=antigravity", () => {
    it("tryFastPathIngest unit behavior covers hit, non-antigravity miss, corrupt snapshot miss, and planGraph override miss", () => {
      const { dir, headSha } = createTempGitRepo("harness-tryfastpath-ingest-")
      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      writeFileSync(
        join(harnessDir, "graph-snapshot.json"),
        JSON.stringify({ nodes: [], edges: [] }),
        "utf8",
      )
      writeFileSync(
        join(harnessDir, "graph-head.json"),
        JSON.stringify({ headSha, gitBranch: "main" }),
        "utf8",
      )

      const hit = tryFastPathIngest(["ingest", "--format=antigravity"], { repoRoot: dir })
      expect(Option.isSome(hit)).toBe(true)

      const nonAg = tryFastPathIngest(["ingest"], { repoRoot: dir })
      expect(Option.isNone(nonAg)).toBe(true)

      const planOverride = tryFastPathIngest(["ingest", "--format=antigravity"], {
        repoRoot: dir,
        planGraph: { graph: Graph.directed(), nodeIndexByKey: new Map() },
      })
      expect(Option.isNone(planOverride)).toBe(true)

      writeFileSync(join(harnessDir, "graph-snapshot.json"), "{corrupt json", "utf8")
      const corruptSnap = tryFastPathIngest(["ingest", "--format=antigravity"], { repoRoot: dir })
      expect(Option.isNone(corruptSnap)).toBe(true)
    })

    it("returns {} quickly without heavy modules when snapshot and head match", () => {
      const { dir, headSha } = createTempGitRepo("harness-hook-ingest-hit-")
      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      writeFileSync(
        join(harnessDir, "graph-snapshot.json"),
        JSON.stringify({ nodes: [], edges: [] }),
        "utf8",
      )
      writeFileSync(
        join(harnessDir, "graph-head.json"),
        JSON.stringify({ headSha, gitBranch: "main" }),
        "utf8",
      )

      const inspect = inspectLoadedModulesForHookEntry(["ingest", "--format=antigravity"], {
        cwd: dir,
      })
      expect(inspect.status).toBe(0)
      expect(JSON.parse(inspect.stdout.trim())).toEqual({})
      assertNoHeavyModulesLoaded(inspect.loadedUrls)
    })

    it("falls back to full handleIngest when graph-head.json is missing or stale", () => {
      const { dir, headSha } = createTempGitRepo("harness-hook-ingest-miss-")
      const res = runHookEntry(["ingest", "--format=antigravity"], {
        cwd: dir,
        env: { HARNESS_TEST_ISOLATION: undefined },
      })
      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({})
      expect(existsSync(join(dir, ".harness", "graph-snapshot.json"))).toBe(true)
      const headMeta = JSON.parse(
        readFileSync(join(dir, ".harness", "graph-head.json"), "utf8"),
      ) as {
        headSha: string
      }
      expect(headMeta.headSha).toBe(headSha)
    })

    it("delegates non-Antigravity ingest to fallback even when snapshot and head match", () => {
      const { dir, headSha } = createTempGitRepo("harness-hook-ingest-cc-")
      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      writeFileSync(
        join(harnessDir, "graph-snapshot.json"),
        JSON.stringify({ nodes: [], edges: [] }),
        "utf8",
      )
      writeFileSync(
        join(harnessDir, "graph-head.json"),
        JSON.stringify({ headSha, gitBranch: "main" }),
        "utf8",
      )

      const inspect = inspectLoadedModulesForHookEntry(["ingest"], {
        cwd: dir,
        input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "README.md" } }),
        env: { HARNESS_TEST_ISOLATION: undefined },
      })
      expect(inspect.status).toBe(0)
      expect(inspect.loadedUrls.some((u) => u.includes("hook-fallback.ts"))).toBe(true)
      const parsed = JSON.parse(inspect.stdout.trim()) as { indexedFns: number }
      expect(typeof parsed.indexedFns).toBe("number")
    })
  })

  describe("session --format=antigravity", () => {
    it("computePreInvocationFingerprint matches computePreInvocationFingerprintLite across repo states", () => {
      const { dir } = createTempGitRepo("harness-fp-parity-")
      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      writeFileSync(join(dir, ".gitignore"), ".nx/\nlibs/demo/src/\n", "utf8")
      mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
      writeFileSync(join(dir, "src-tracked.ts"), "export const v = 1\n", "utf8")
      execFileSync("git", ["add", ".gitignore", "src-tracked.ts"], { cwd: dir, encoding: "utf8" })
      execFileSync("git", ["commit", "-m", "add tracked"], { cwd: dir, encoding: "utf8" })

      const assertParity = (label: string): string => {
        const fullOpt = computePreInvocationFingerprint(dir, harnessDir, nodeSyncHostIo)
        const liteOpt = computePreInvocationFingerprintLite(dir, REPO_ROOT, harnessDir, process.env)
        expect(Option.isSome(fullOpt), `${label} full`).toBe(true)
        expect(Option.isSome(liteOpt), `${label} lite`).toBe(true)
        const fullVal = match(fullOpt)
          .with({ _tag: "Some" }, ({ value }) => value)
          .with({ _tag: "None" }, () => expect.unreachable())
          .exhaustive()
        const liteVal = match(liteOpt)
          .with({ _tag: "Some" }, ({ value }) => value)
          .with({ _tag: "None" }, () => expect.unreachable())
          .exhaustive()
        expect(fullVal, label).toBe(liteVal)
        return fullVal
      }

      const fpClean = assertParity("clean repo")

      writeFileSync(join(dir, "src-tracked.ts"), "export const v = 2\n", "utf8")
      const fpEdited = assertParity("tracked edit")
      expect(fpEdited).not.toBe(fpClean)

      execFileSync("git", ["mv", "src-tracked.ts", "src-renamed.ts"], {
        cwd: dir,
        encoding: "utf8",
      })
      const fpRenamed = assertParity("renamed file")
      expect(fpRenamed).not.toBe(fpEdited)

      writeFileSync(join(dir, "untracked.ts"), "export const u = 1\n", "utf8")
      const fpUntracked = assertParity("untracked file")
      expect(fpUntracked).not.toBe(fpRenamed)

      mkdirSync(join(dir, ".nx"), { recursive: true })
      writeFileSync(join(dir, ".nx", "cache.bin"), "ignored-nx", "utf8")
      const fpNxIgnored = assertParity(".nx/ ignored file")
      expect(fpNxIgnored).toBe(fpUntracked)

      writeFileSync(join(dir, "libs", "demo", "src", "ignored.ts"), "export const i = 1\n", "utf8")
      const fpDemoIgnored = assertParity("libs/demo/src/ ignored file")
      expect(fpDemoIgnored).not.toBe(fpNxIgnored)

      writeFileSync(join(harnessDir, "verify-stamp.json"), JSON.stringify({ ok: true }), "utf8")
      const fpStateUpdated = assertParity(".harness/ state-file update")
      expect(fpStateUpdated).not.toBe(fpDemoIgnored)

      mkdirSync(join(dir, "libs", "demo", "src", "nested"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "src", "nested", "deep.ts"),
        "export const d = 1\n",
        "utf8",
      )
      const fpNestedIgnored = assertParity("nested ignored dir file")
      expect(fpNestedIgnored).not.toBe(fpStateUpdated)
    })

    it("miss avoids @effect/ai-typesafe and warm hit loads fewer modules without fallback", () => {
      const { dir } = createTempGitRepo("harness-hook-session-")
      const env = {
        HARNESS_TEST_ISOLATION: undefined,
        HARNESS_REQUIRE_OLLAMA: "0",
        HARNESS_OLLAMA_URL: "http://127.0.0.1:1",
      }

      const tMiss0 = performance.now()
      const missInspect = inspectLoadedModulesForHookEntry(["session", "--format=antigravity"], {
        cwd: dir,
        env,
      })
      const missMs = performance.now() - tMiss0
      expect(missInspect.status).toBe(0)
      const missPayload = JSON.parse(missInspect.stdout.trim()) as { injectSteps: Array<string> }
      expect(Array.isArray(missPayload.injectSteps)).toBe(true)
      expect(missInspect.loadedUrls.find((u) => u.includes("@effect/ai-typesafe"))).toBeUndefined()

      const cachePath = join(dir, ".harness", "session-preinvocation-cache.json")
      expect(existsSync(cachePath)).toBe(true)

      const tHit0 = performance.now()
      const hitInspect = inspectLoadedModulesForHookEntry(["session", "--format=antigravity"], {
        cwd: dir,
        env,
      })
      const hitMs = performance.now() - tHit0
      expect(hitInspect.status).toBe(0)
      const hitPayload = JSON.parse(hitInspect.stdout.trim()) as { injectSteps: Array<string> }
      expect(hitPayload).toEqual(missPayload)
      assertNoHeavyModulesLoaded(hitInspect.loadedUrls)
      console.info(
        `[bench] session warm hit: ${Math.round(hitMs)}ms (${hitInspect.loadedUrls.length} modules) vs cold miss: ${Math.round(missMs)}ms (${missInspect.loadedUrls.length} modules)`,
      )
      expect(hitInspect.loadedUrls.length).toBeLessThan(missInspect.loadedUrls.length)
    })
  })

  describe("HARNESS_UNIT_WORKER=1 worker isolation fast-path and parity", () => {
    it.each([
      {
        label: "workflow start",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow start --plan plan.json" },
          },
        }),
      },
      {
        label: "workflow resume",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow resume --run-id wf-test-0001" },
          },
        }),
      },
      {
        label: "workflow abort",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow abort --run-id wf-test-0001" },
          },
        }),
      },
      {
        label: "workflow done",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow done" },
          },
        }),
      },
      {
        label: "harness done",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness done" },
          },
        }),
      },
      {
        label: "cat daemon.sock",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "cat .git/harness/daemon.sock" },
          },
        }),
      },
      {
        label: "view_file daemon.sock",
        input: JSON.stringify({
          toolCall: {
            name: "view_file",
            args: { AbsolutePath: "/repo/.git/harness/daemon.sock" },
          },
        }),
      },
      {
        label: "grep_search auth-tokens.json",
        input: JSON.stringify({
          toolCall: {
            name: "grep_search",
            args: { SearchPath: "/repo/.harness/omnigraph-cluster/auth-tokens.json" },
          },
        }),
      },
      {
        label: "list_dir daemon.sock",
        input: JSON.stringify({
          toolCall: {
            name: "list_dir",
            args: { DirectoryPath: "/repo/.git/harness/daemon.sock" },
          },
        }),
      },
      {
        label: "read_file Path auth-tokens.json",
        input: JSON.stringify({
          toolCall: {
            name: "read_file",
            args: { Path: "/repo/.harness/omnigraph-cluster/auth-tokens.json" },
          },
        }),
      },
      {
        label: "read_file Path daemon.sock",
        input: JSON.stringify({
          toolCall: {
            name: "read_file",
            args: { Path: "/repo/.git/harness/daemon.sock" },
          },
        }),
      },
      {
        label: "pnpm --filter harness-cli start workflow start",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm --filter harness-cli start workflow start" },
          },
        }),
      },
      {
        label: "cat auth-tokens.*",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "cat .harness/omnigraph-cluster/auth-tokens.*" },
          },
        }),
      },
      {
        label: "rg -u . .harness/omnigraph-cluster",
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "rg -u . .harness/omnigraph-cluster" },
          },
        }),
      },
    ])(
      "blocks $label under HARNESS_UNIT_WORKER=1 without loading heavy modules and matches index.ts",
      ({ input }) => {
        const env = { HARNESS_UNIT_WORKER: "1" }
        const inspect = inspectLoadedModulesForHookEntry(["guard", "--format=antigravity"], {
          input,
          env,
        })
        expect(inspect.status).toBe(0)
        const parsed = JSON.parse(inspect.stdout.trim()) as { decision: string; reason: string }
        expect(parsed.decision).toBe("deny")
        expect(parsed.reason).toContain("HARNESS_UNIT_WORKER=1")
        assertNoHeavyModulesLoaded(inspect.loadedUrls)

        const fullRes = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], { input, env })
        expect(fullRes.status).toBe(inspect.status)
        expect(fullRes.stdout.trim()).toBe(inspect.stdout.trim())
      },
    )

    it("enforces Claude Code exit 2 parity for Read/Glob/Grep auth-tokens.json and workflow start under HARNESS_UNIT_WORKER=1", () => {
      const env = { HARNESS_UNIT_WORKER: "1" }
      for (const input of [
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: ".harness/omnigraph-cluster/auth-tokens.json" },
        }),
        JSON.stringify({
          tool_name: "Glob",
          tool_input: { pattern: "**/*auth-tokens*" },
        }),
        JSON.stringify({
          tool_name: "Grep",
          tool_input: { pattern: ".", glob: "**/auth-tokens.json" },
        }),
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "pnpm harness workflow start --plan plan.json" },
        }),
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "pnpm --filter harness-cli start workflow start" },
        }),
      ]) {
        const fastRes = runHookEntry(["guard"], { input, env })
        const fullRes = runEntry(INDEX_PATH, ["guard"], { input, env })
        expect(fastRes.status).toBe(2)
        expect(fullRes.status).toBe(2)
        expect(fastRes.stdout.trim()).toBe(fullRes.stdout.trim())
        expect(fastRes.stderr).toContain("HARNESS_UNIT_WORKER=1")
      }
    })

    it("resolves symlinks pointing to .harness/omnigraph-cluster/auth-tokens.json and denies with fast-path parity", () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-worker-symlink-"))
      tempDirs.push(dir)
      const clusterDir = join(dir, ".harness", "omnigraph-cluster")
      mkdirSync(clusterDir, { recursive: true })
      const targetTokens = join(clusterDir, "auth-tokens.json")
      writeFileSync(targetTokens, JSON.stringify({ token: "secret" }), "utf8")
      const symlinkPath = join(dir, "benign-alias.json")
      symlinkSync(targetTokens, symlinkPath)

      const env = { HARNESS_UNIT_WORKER: "1" }
      const agyInput = JSON.stringify({
        toolCall: { name: "read_file", args: { Path: symlinkPath } },
      })
      const fastAgy = runHookEntry(["guard", "--format=antigravity"], { input: agyInput, env })
      const fullAgy = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], {
        input: agyInput,
        env,
      })
      expect(fastAgy.status).toBe(0)
      expect(fullAgy.status).toBe(0)
      expect(JSON.parse(fastAgy.stdout.trim())).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
      })
      expect(fullAgy.stdout.trim()).toBe(fastAgy.stdout.trim())

      const ccInput = JSON.stringify({ tool_name: "Read", tool_input: { file_path: symlinkPath } })
      const fastCc = runHookEntry(["guard"], { input: ccInput, env })
      const fullCc = runEntry(INDEX_PATH, ["guard"], { input: ccInput, env })
      expect(fastCc.status).toBe(2)
      expect(fullCc.status).toBe(2)
      expect(fastCc.stderr).toContain("HARNESS_UNIT_WORKER=1")
    })

    it("allows workflow complete, workflow status, nx run verify, and normal file reads under HARNESS_UNIT_WORKER=1", () => {
      const env = { HARNESS_UNIT_WORKER: "1" }
      for (const input of [
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow complete --unit u1 --repo-root /tmp/repo" },
          },
        }),
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow status --json" },
          },
        }),
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "nx run @harness/contract:verify" },
          },
        }),
        JSON.stringify({
          toolCall: {
            name: "view_file",
            args: { AbsolutePath: "/repo/libs/harness/contract/src/workflow.ts" },
          },
        }),
      ]) {
        const fastRes = runHookEntry(["guard", "--format=antigravity"], { input, env })
        const fullRes = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], { input, env })
        expect(fastRes.status).toBe(0)
        expect(JSON.parse(fastRes.stdout.trim())).toEqual({ decision: "allow" })
        expect(fullRes.stdout.trim()).toBe(fastRes.stdout.trim())
      }
    })

    it("F-4.1: denies Read .env and <commonGitDir>/harness/** reads in non-worker mode with fast-path parity", () => {
      const env = { HARNESS_UNIT_WORKER: "0" }
      for (const input of [
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".env" } }),
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: ".git/harness/daemon.sock" },
        }),
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: ".git/harness/daemon.lock" },
        }),
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: ".git/harness/workflow-backups/2026-11-20.ndjson" },
        }),
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: ".git/harness/auth-tokens.json" },
        }),
      ]) {
        const fastRes = runHookEntry(["guard"], { input, env })
        const fullRes = runEntry(INDEX_PATH, ["guard"], { input, env })
        expect(fastRes.status, input).toBe(2)
        expect(fullRes.status, input).toBe(2)
      }

      const agyEnvRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({ toolCall: { name: "view_file", args: { AbsolutePath: ".env" } } }),
        env,
      })
      expect(agyEnvRes.status).toBe(0)
      expect(JSON.parse(agyEnvRes.stdout.trim())).toMatchObject({ decision: "deny" })
    })

    it("F-3.6: walks ancestors to resolve non-existent files under symlinked dirs and fails closed on symlink loops", () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-f36-ancestor-"))
      tempDirs.push(dir)
      const harnessDir = join(dir, ".git", "harness")
      mkdirSync(harnessDir, { recursive: true })
      const symDir = join(dir, "alias-harness")
      symlinkSync(harnessDir, symDir)

      const nonExistentWrite = JSON.stringify({
        toolCall: { name: "write_to_file", args: { TargetFile: join(symDir, "new-daemon.sock") } },
      })
      const writeFast = runHookEntry(["guard", "--format=antigravity"], { input: nonExistentWrite })
      const writeFull = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], {
        input: nonExistentWrite,
      })
      expect(writeFast.status).toBe(0)
      expect(JSON.parse(writeFast.stdout.trim())).toMatchObject({ decision: "deny" })
      expect(writeFull.stdout.trim()).toBe(writeFast.stdout.trim())

      const loopA = join(dir, "loop-a")
      const loopB = join(dir, "loop-b")
      symlinkSync(loopB, loopA)
      symlinkSync(loopA, loopB)
      const loopRead = JSON.stringify({
        toolCall: { name: "read_file", args: { Path: join(loopA, "secret.txt") } },
      })
      const loopFast = runHookEntry(["guard", "--format=antigravity"], { input: loopRead })
      expect(loopFast.status).toBe(0)
      expect(JSON.parse(loopFast.stdout.trim())).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("ELOOP"),
      })
    })

    it("F-16.1 & F-16.2: denies depth > 8 read payloads, allows Grep/grep_search regexes like process\\.env, and denies Glob/SearchPath secret targets", () => {
      let deepObj: Record<string, unknown> = { secret: ".env" }
      for (let i = 0; i < 10; i++) {
        deepObj = { nested: deepObj }
      }
      const deepRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "libs/a.ts", extra: deepObj },
        }),
      })
      expect(deepRes.status).toBe(0)
      expect(JSON.parse(deepRes.stdout.trim())).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("maximum inspection depth"),
      })

      for (const allowedInput of [
        JSON.stringify({
          tool_name: "Grep",
          tool_input: { pattern: "process\\.env", path: "libs/" },
        }),
        JSON.stringify({
          tool_name: "Grep",
          tool_input: { pattern: "process\\.env" },
        }),
        JSON.stringify({
          toolCall: {
            name: "grep_search",
            args: { Query: "process.env", TargetContent: ".env", SearchPath: "libs/" },
          },
        }),
      ]) {
        const res = runHookEntry(["guard", "--format=antigravity"], { input: allowedInput })
        expect(res.status, allowedInput).toBe(0)
        expect(JSON.parse(res.stdout.trim()), allowedInput).toEqual({ decision: "allow" })
      }

      for (const deniedInput of [
        JSON.stringify({
          tool_name: "Glob",
          tool_input: { pattern: "**/.env*" },
        }),
        JSON.stringify({
          tool_name: "Grep",
          tool_input: { pattern: ".", path: ".git", glob: "harness/**" },
        }),
        JSON.stringify({
          tool_name: "Glob",
          tool_input: { path: ".harness", pattern: "omnigraph-cluster/**" },
        }),
        JSON.stringify({
          toolCall: {
            name: "grep_search",
            args: { Query: ".", SearchPath: ".harness", Includes: ["omnigraph-cluster/**"] },
          },
        }),
        JSON.stringify({
          toolCall: {
            name: "grep_search",
            args: { Query: "foo", SearchPath: ".git/harness/daemon.sock" },
          },
        }),
        JSON.stringify({
          toolCall: {
            name: "read_file",
            args: { file_path: ".harness/omnigraph-cluster/auth-tokens.json" },
          },
        }),
      ]) {
        const res = runHookEntry(["guard", "--format=antigravity"], {
          input: deniedInput,
          env: { HARNESS_UNIT_WORKER: "1" },
        })
        expect(res.status, deniedInput).toBe(0)
        expect(JSON.parse(res.stdout.trim()), deniedInput).toMatchObject({ decision: "deny" })
        const fullRes = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], {
          input: deniedInput,
          env: { HARNESS_UNIT_WORKER: "1" },
        })
        expect(fullRes.status, deniedInput).toBe(0)
        expect(JSON.parse(fullRes.stdout.trim()), deniedInput).toMatchObject({ decision: "deny" })
      }
    })
  })

  describe("done --format=antigravity fast-path", () => {
    it("exits fast on fullyIdle=false without loading heavy modules and delegates fullyIdle=true", () => {
      const { dir } = createTempGitRepo("harness-done-fastpath-")
      const idleInspect = inspectLoadedModulesForHookEntry(["done", "--format=antigravity"], {
        cwd: dir,
        input: JSON.stringify({ fullyIdle: false }),
        env: { HARNESS_TEST_ISOLATION: undefined },
      })
      expect(idleInspect.status).toBe(0)
      expect(idleInspect.stdout).toBe("")
      assertNoHeavyModulesLoaded(idleInspect.loadedUrls)
      const telemetryLines = readFileSync(join(dir, ".harness", "telemetry-log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { toolName: string; detail?: string })
      expect(telemetryLines.at(-1)).toMatchObject({ toolName: "done", detail: "fullyIdle=false" })

      const fullInspect = inspectLoadedModulesForHookEntry(["done", "--format=antigravity"], {
        cwd: dir,
        input: JSON.stringify({ fullyIdle: true }),
      })
      expect(fullInspect.status).toBe(0)
      expect(JSON.parse(fullInspect.stdout.trim())).toMatchObject({ decision: "continue" })
      expect(fullInspect.loadedUrls.some((u) => u.includes("hook-fallback.ts"))).toBe(true)
    })

    it("F-12: fails closed on glob-combination-overflow across both fast-path and index entry", () => {
      const manyGlobs = JSON.stringify({
        tool_name: "Glob",
        tool_input: {
          path: "/repo/{a,b,c,d}/{e,f,g,h}/{i,j,k,l}/{m,n,o,p}",
          pattern: "*.ts",
        },
      })
      const fastRes = runHookEntry(["guard", "--format=antigravity"], { input: manyGlobs })
      const fullRes = runEntry(INDEX_PATH, ["guard", "--format=antigravity"], { input: manyGlobs })
      expect(fastRes.status).toBe(0)
      expect(fullRes.status).toBe(0)
      expect(JSON.parse(fastRes.stdout.trim())).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("Glob"),
      })
      expect(fullRes.stdout.trim()).toBe(fastRes.stdout.trim())
    })
  })
})
