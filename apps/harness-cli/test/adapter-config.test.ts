import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("Claude Code adapter & Omnigraph Cedar policy", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")

  it("wires SessionStart, PreToolUse, PostToolUse, and Stop hooks to harness-cli", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/hooks.json"), "utf8"),
    )
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "PreToolUse", "PostToolUse", "Stop"])

    const sessionHook = hooks.hooks.SessionStart[0].hooks[0]
    expect(sessionHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts session",
    )

    const preHook = hooks.hooks.PreToolUse[0]
    expect(preHook.matcher).toBe("Bash")
    expect(preHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard || exit 2",
    )

    const readPreHook = hooks.hooks.PreToolUse[2]
    expect(readPreHook.matcher).toBe("Read|Grep|Glob|LS|Find")
    expect(readPreHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard || exit 2",
    )
    expect(readPreHook.hooks[0].timeout).toBe(15)

    const postHook = hooks.hooks.PostToolUse[0]
    expect(postHook.matcher).toBe("Edit|Write|MultiEdit")
    expect(postHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts ingest",
    )

    const stopHook = hooks.hooks.Stop[0].hooks[0]
    expect(stopHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts done || exit 2",
    )
  })

  it("F-14.1: Claude Code & Antigravity hooks.json shell wrappers fail closed on pre-runMain SyntaxError (exit 1 -> exit 2 + JSON)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-f14-1-"))
    try {
      const brokenEntry = join(tmpDir, "broken-index.mjs")
      writeFileSync(brokenEntry, "const broken = (; // SyntaxError\n", "utf8")

      const claudeHooks = JSON.parse(
        readFileSync(resolve(repoRoot, "adapters/claude-code/hooks.json"), "utf8"),
      )
      const agyHooks = JSON.parse(
        readFileSync(
          resolve(repoRoot, "adapters/antigravity/plugins/effect-harness/hooks.json"),
          "utf8",
        ),
      )

      const claudeGuardCmd = (claudeHooks.hooks.PreToolUse[0].hooks[0].command as string).replace(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts",
        `node ${JSON.stringify(brokenEntry)}`,
      )
      const claudeGuardRes = spawnSync("/bin/sh", ["-c", claudeGuardCmd], { encoding: "utf8" })
      expect(claudeGuardRes.status).toBe(2)

      const claudeDoneCmd = (claudeHooks.hooks.Stop[0].hooks[0].command as string).replace(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts",
        `node ${JSON.stringify(brokenEntry)}`,
      )
      const claudeDoneRes = spawnSync("/bin/sh", ["-c", claudeDoneCmd], { encoding: "utf8" })
      expect(claudeDoneRes.status).toBe(2)

      const agyGuardCmd = (
        agyHooks["effect-harness"].PreToolUse[0].hooks[0].command as string
      ).replace(
        "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/hook-entry.ts",
        `node ${JSON.stringify(brokenEntry)}`,
      )
      const agyGuardRes = spawnSync("/bin/sh", ["-c", agyGuardCmd], { encoding: "utf8" })
      expect(agyGuardRes.status).toBe(2)
      expect(JSON.parse(agyGuardRes.stdout.trim())).toEqual({
        decision: "deny",
        reason: "guard: runtime bootstrap failed",
      })

      const agyDoneCmd = (agyHooks["effect-harness"].Stop[0].command as string).replace(
        "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/hook-entry.ts",
        `node ${JSON.stringify(brokenEntry)}`,
      )
      const agyDoneRes = spawnSync("/bin/sh", ["-c", agyDoneCmd], { encoding: "utf8" })
      expect(agyDoneRes.status).toBe(2)
      expect(JSON.parse(agyDoneRes.stdout.trim())).toEqual({
        decision: "continue",
        reason: "done: runtime bootstrap failed",
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("configures harness-mcp, omnigraph-mcp, and nx-mcp in .mcp.json", () => {
    const mcp = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/.mcp.json"), "utf8"),
    )
    expect(Object.keys(mcp.mcpServers)).toEqual(["harness-mcp", "omnigraph-mcp", "nx-mcp"])
    expect(mcp.mcpServers["harness-mcp"]).toEqual({
      command: "node",
      args: ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-mcp/src/server.ts"],
    })
    expect(mcp.mcpServers["omnigraph-mcp"]).toEqual({
      command: "node",
      args: ["./tools/omnigraph-mcp-launcher.mjs"],
      env: {
        OMNIGRAPH_GRAPH_ID: "harness",
        OMNIGRAPH_SUBJECT: "agent-mcp",
      },
    })
    expect(mcp.mcpServers["nx-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "nx-mcp"],
    })
  })

  it("executes harness-cli guard end-to-end under Node with node-ts-resolver.mjs", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "harness-adapter-state-"))
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
        {
          cwd: repoRoot,
          env: { ...process.env, HARNESS_STATE_DIR: stateDir },
          input: JSON.stringify({ tool_input: { command: "alchemy deploy" } }),
          encoding: "utf8",
        },
      )
      const result = JSON.parse(stdout.trim())
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Command requires human confirmation: alchemy deploy",
        },
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("forbids agent-mcp from mutating Omnigraph branches in policies.cedar and policy YAML files", () => {
    const cedar = readFileSync(resolve(repoRoot, "libs/harness/graph/policies.cedar"), "utf8")
    expect(cedar).toContain('Omnigraph::Subject::"agent-mcp"')
    expect(cedar).toContain('Omnigraph::Action::"read"')
    expect(cedar).toContain('"main"')
    expect(cedar).toContain('"plan/*"')
    expect(cedar).toContain('Omnigraph::Subject::"harness-cli"')
    expect(cedar).toContain('Omnigraph::Action::"branch_create"')
    expect(cedar).toContain('Omnigraph::Action::"branch_merge"')
    expect(existsSync(resolve(repoRoot, "libs/harness/graph/graph.policy.yaml"))).toBe(true)
    expect(existsSync(resolve(repoRoot, "libs/harness/graph/cluster.policy.yaml"))).toBe(true)
    expect(existsSync(resolve(repoRoot, "libs/harness/graph/policy-tests.yaml"))).toBe(true)
  })

  it("provides comprehensive instructions in effect-harness skill", () => {
    const skill = readFileSync(
      resolve(repoRoot, "adapters/claude-code/skills/effect-harness/SKILL.md"),
      "utf8",
    )
    expect(skill).toContain("name: effect-harness")
    expect(skill).toContain("harness plan-check")
    expect(skill).toContain("harness verify")
    expect(skill).toContain("harness done")
    expect(skill).toContain("stub<A, E, R>")
    expect(skill).toContain("harness_resolve")
    expect(skill).toContain("harness_callers")
    expect(skill).toContain("harness_callees")
    expect(skill).toContain("harness_tests_reaching")
    expect(skill).toContain("harness_structural_search")
    expect(skill).toContain("harness_route")
    expect(skill).toContain("@modernrelay/omnigraph-mcp")
    expect(skill).toContain("repos/effect/LLMS.md")
  })
})

describe("Antigravity adapter & plugin configuration", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")
  const pluginDir = resolve(repoRoot, "adapters/antigravity/plugins/effect-harness")

  it("registers adapters/antigravity/plugins in .agents/plugins.json and declares plugin.json", () => {
    const pluginsJson = JSON.parse(readFileSync(resolve(repoRoot, ".agents/plugins.json"), "utf8"))
    expect(pluginsJson.entries).toEqual([{ path: "adapters/antigravity/plugins" }])

    const pluginManifest = JSON.parse(readFileSync(resolve(pluginDir, "plugin.json"), "utf8"))
    expect(pluginManifest).toEqual({ name: "effect-harness" })
  })

  it("configures harness-mcp, omnigraph-mcp, and nx-mcp in mcp_config.json", () => {
    const mcp = JSON.parse(readFileSync(resolve(pluginDir, "mcp_config.json"), "utf8"))
    expect(Object.keys(mcp.mcpServers)).toEqual(["harness-mcp", "omnigraph-mcp", "nx-mcp"])
    expect(mcp.mcpServers["harness-mcp"]).toEqual({
      command: "node",
      args: [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-mcp/src/server.ts",
      ],
    })
    expect(mcp.mcpServers["omnigraph-mcp"]).toEqual({
      command: "node",
      args: ["../../../../tools/omnigraph-mcp-launcher.mjs"],
      env: {
        OMNIGRAPH_GRAPH_ID: "harness",
        OMNIGRAPH_SUBJECT: "agent-mcp",
      },
    })
  })

  it("wires PreInvocation, PreToolUse, PostToolUse, and Stop hooks in Antigravity hooks.json", () => {
    const hooks = JSON.parse(readFileSync(resolve(pluginDir, "hooks.json"), "utf8"))
    const spec = hooks["effect-harness"]
    expect(Object.keys(spec)).toEqual(["PreInvocation", "PreToolUse", "PostToolUse", "Stop"])
    expect(spec.PreInvocation[0].command).toContain("hook-entry.ts session --format=antigravity")
    expect(spec.PreToolUse[0].matcher).toBe("run_command")
    expect(spec.PreToolUse[0].hooks[0].command).toContain(
      "hook-entry.ts guard --format=antigravity",
    )
    expect(spec.PreToolUse[1].matcher).toBe(
      "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file",
    )
    expect(spec.PreToolUse[2].matcher).toBe(
      "view_file|view_file_outline|view_code_item|read_file|grep_search|find_by_name|list_dir",
    )
    expect(spec.PreToolUse[2].hooks[0].command).toContain(
      "hook-entry.ts guard --format=antigravity",
    )
    expect(spec.PreToolUse[2].hooks[0].timeout).toBe(15)
    expect(spec.PostToolUse[0].matcher).toBe(
      "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file",
    )
    expect(spec.PostToolUse[0].hooks[0].command).toContain(
      "hook-entry.ts ingest --format=antigravity",
    )
    expect(spec.Stop[0].command).toContain("hook-entry.ts done --format=antigravity")
  })

  it("executes Antigravity PreToolUse guard hook from plugin directory with toolCall stdin", () => {
    const askStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity",
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "alchemy deploy" },
          },
        }),
        encoding: "utf8",
      },
    )
    expect(JSON.parse(askStdout.trim())).toEqual({
      decision: "ask",
      reason: "Command requires human confirmation: alchemy deploy",
    })

    const denyStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity",
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "git push --force" },
          },
        }),
        encoding: "utf8",
      },
    )
    expect(JSON.parse(denyStdout.trim())).toEqual({
      decision: "deny",
      reason:
        "Blocked by harness guard: git push --force (Command contains banned token 'push --force' (force push).)",
    })

    const allowStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity",
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm test" },
          },
        }),
        encoding: "utf8",
      },
    )
    expect(JSON.parse(allowStdout.trim())).toEqual({
      decision: "allow",
    })
  })

  it("enforces controlled write-surface guard for file write operations in Antigravity", () => {
    const runGuardForFile = (targetFile: string) => {
      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          "../../../../tools/node-ts-resolver.mjs",
          "../../../../apps/harness-cli/src/index.ts",
          "guard",
          "--format=antigravity",
        ],
        {
          cwd: pluginDir,
          input: JSON.stringify({
            toolCall: {
              name: "write_to_file",
              args: { TargetFile: targetFile },
            },
          }),
          encoding: "utf8",
        },
      )
      return JSON.parse(stdout.trim())
    }

    const stampRes = runGuardForFile(".harness/verify-stamp.json")
    expect(stampRes.decision).toBe("deny")
    expect(stampRes.reason).toContain("Direct modification of verify-stamp.json is forbidden")

    const reposRes = runGuardForFile("repos/effect/index.ts")
    expect(reposRes.decision).toBe("deny")
    expect(reposRes.reason).toContain("Protected read-only subtree cannot be modified")

    const oxlintRes = runGuardForFile(".oxlintrc.json")
    expect(oxlintRes.decision).toBe("ask")
    expect(oxlintRes.reason).toContain(
      "Modifying harness governance/linter policy requires human confirmation",
    )

    const allowRes = runGuardForFile("libs/sample/domain/src/index.ts")
    expect(allowRes.decision).toBe("allow")
  })

  it("enforces controlled write-surface guard for file write operations in Claude Code format", () => {
    let denied = false
    let errOutput = ""
    try {
      execFileSync(
        process.execPath,
        ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
        {
          cwd: repoRoot,
          input: JSON.stringify({ tool_input: { file_path: ".harness/verify-stamp.json" } }),
          encoding: "utf8",
        },
      )
    } catch (err: unknown) {
      denied = true
      const rec =
        typeof err === "object" && err !== null ? (err as { stderr?: string; stdout?: string }) : {}
      errOutput = (rec.stderr ?? "") + (rec.stdout ?? "")
    }
    expect(denied).toBe(true)
    expect(errOutput).toContain("Direct modification of verify-stamp.json is forbidden")

    const askStdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
        input: JSON.stringify({ tool_input: { file_path: ".oxlintrc.json" } }),
        encoding: "utf8",
      },
    )
    const askResult = JSON.parse(askStdout.trim())
    expect(askResult.hookSpecificOutput?.permissionDecision).toBe("ask")

    const allowStdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
        input: JSON.stringify({ tool_input: { file_path: "libs/sample/domain/src/index.ts" } }),
        encoding: "utf8",
      },
    )
    expect(allowStdout.trim()).toBe("")
  })
})
