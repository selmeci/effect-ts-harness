import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

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

const runHookEntry = (
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
) =>
  spawnSync(process.execPath, ["--import", RESOLVER_PATH, HOOK_ENTRY_PATH, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    input: options?.input,
    encoding: "utf8",
    timeout: 15_000,
    env: buildChildEnv(options?.env),
  })

const inspectLoadedModulesForHookEntry = (
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
        HARNESS_TEST_HOOK_ENTRY: HOOK_ENTRY_PATH,
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
    })

    it("denies destructive commands, protected state files, secrets, flags, and bad stdin", () => {
      const denyCases: ReadonlyArray<{
        readonly label: string
        readonly args: ReadonlyArray<string>
        readonly input?: string
        readonly reasonPart: string
      }> = [
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
      ]

      for (const tc of denyCases) {
        const res = runHookEntry(tc.args, { input: tc.input })
        expect(res.status, tc.label).toBe(0)
        const parsed = JSON.parse(res.stdout.trim()) as { decision: string; reason: string }
        expect(parsed.decision, tc.label).toBe("deny")
        expect(parsed.reason, tc.label).toContain(tc.reasonPart)
      }
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
        reason: "DecisionModel unavailable or timed out; requires human confirmation.",
      })
      expect(inspect.loadedUrls.some((u) => u.includes("hook-fallback.ts"))).toBe(true)
    })

    it("enforces Claude Code exit 2 fail-closed, mixed/masked fields, read-only tools, and override ask", () => {
      const ccSpoofRes = runHookEntry(["guard"], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: 'rm -rf / # "conversationId":1' },
        }),
      })
      expect(ccSpoofRes.status).toBe(2)
      expect(ccSpoofRes.stdout.trim()).toBe("")

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

      const oxlintRes = runHookEntry(["guard", "--format=antigravity"], {
        input: JSON.stringify({
          toolCall: { name: "write_to_file", args: { TargetFile: ".oxlintrc.json" } },
        }),
      })
      expect(oxlintRes.status).toBe(0)
      expect((JSON.parse(oxlintRes.stdout.trim()) as { decision: string }).decision).toBe("ask")

      const missingFlagRes = runHookEntry(["guard", "--format=antigravity", "--format"], {
        input: "",
      })
      expect(missingFlagRes.status).toBe(0)
      expect((JSON.parse(missingFlagRes.stdout.trim()) as { decision: string }).decision).toBe(
        "deny",
      )
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

    it("cold-start latency is substantially faster than legacy index.ts", () => {
      const stdinPayload = JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
      })

      const t0 = performance.now()
      const fastRes = runHookEntry(["guard", "--format=antigravity"], { input: stdinPayload })
      const fastMs = performance.now() - t0
      expect(fastRes.status).toBe(0)

      const t1 = performance.now()
      const legacyRes = spawnSync(
        process.execPath,
        ["--import", RESOLVER_PATH, INDEX_PATH, "guard", "--format=antigravity"],
        {
          cwd: REPO_ROOT,
          input: stdinPayload,
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, HARNESS_TEST_ISOLATION: "1" },
        },
      )
      const legacyMs = performance.now() - t1
      expect(legacyRes.status).toBe(0)

      console.info(
        `[bench] hook-entry guard fast-path: ${Math.round(fastMs)}ms vs index.ts: ${Math.round(legacyMs)}ms`,
      )
      expect(fastMs).toBeLessThan(legacyMs)
    })
  })

  describe("ingest --format=antigravity", () => {
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
    it("miss avoids @effect/ai-typesafe and warm hit avoids fallback with lower latency", () => {
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
        `[bench] session warm hit: ${Math.round(hitMs)}ms vs cold miss: ${Math.round(missMs)}ms`,
      )
      expect(hitMs).toBeLessThan(missMs)
    })
  })
})
