import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("Claude Code adapter & Omnigraph Cedar policy", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")

  it("wires SessionStart, PreToolUse, PostToolUse, and Stop hooks to harness-cli", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/hooks.json"), "utf8")
    )
    expect(Object.keys(hooks.hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop"
    ])

    const sessionHook = hooks.hooks.SessionStart[0].hooks[0]
    expect(sessionHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts session"
    )

    const preHook = hooks.hooks.PreToolUse[0]
    expect(preHook.matcher).toBe("Bash")
    expect(preHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard"
    )

    const postHook = hooks.hooks.PostToolUse[0]
    expect(postHook.matcher).toBe("Edit|Write")
    expect(postHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ingest"
    )

    const stopHook = hooks.hooks.Stop[0].hooks[0]
    expect(stopHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done"
    )
  })

  it("configures harness-mcp, omnigraph-mcp, and nx-mcp in .mcp.json", () => {
    const mcp = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/.mcp.json"), "utf8")
    )
    expect(Object.keys(mcp.mcpServers)).toEqual([
      "harness-mcp",
      "omnigraph-mcp",
      "nx-mcp"
    ])
    expect(mcp.mcpServers["harness-mcp"]).toEqual({
      command: "node",
      args: ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-mcp/src/server.ts"]
    })
    expect(mcp.mcpServers["omnigraph-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "@modernrelay/omnigraph-mcp@0.14.0"],
      env: {
        OMNIGRAPH_BASE_URL: "http://127.0.0.1:8080",
        OMNIGRAPH_URL: "http://127.0.0.1:8080",
        OMNIGRAPH_GRAPH_ID: "harness",
        OMNIGRAPH_SUBJECT: "agent-mcp"
      }
    })
    expect(mcp.mcpServers["nx-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "nx-mcp"]
    })
  })

  it("executes harness-cli guard end-to-end under Node with node-ts-resolver.mjs", () => {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
        input: JSON.stringify({ tool_input: { command: "alchemy deploy" } }),
        encoding: "utf8"
      }
    )
    const result = JSON.parse(stdout.trim())
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Command requires human confirmation: alchemy deploy"
      }
    })
  })

  it("forbids agent-mcp from mutating Omnigraph branches in policies.cedar", () => {
    const cedar = readFileSync(
      resolve(repoRoot, "libs/harness/graph/policies.cedar"),
      "utf8"
    )
    expect(cedar).toContain('Omnigraph::Subject::"agent-mcp"')
    expect(cedar).toContain('Omnigraph::Action::"read"')
    expect(cedar).toContain('"main"')
    expect(cedar).toContain('"plan/*"')
    expect(cedar).toContain('Omnigraph::Subject::"harness-cli"')
    expect(cedar).toContain('Omnigraph::Action::"branch_create"')
    expect(cedar).toContain('Omnigraph::Action::"branch_merge"')
  })

  it("provides comprehensive instructions in effect-harness skill", () => {
    const skill = readFileSync(
      resolve(repoRoot, "adapters/claude-code/skills/effect-harness/SKILL.md"),
      "utf8"
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
    const pluginsJson = JSON.parse(
      readFileSync(resolve(repoRoot, ".agents/plugins.json"), "utf8")
    )
    expect(pluginsJson.entries).toEqual([{ path: "adapters/antigravity/plugins" }])

    const pluginManifest = JSON.parse(
      readFileSync(resolve(pluginDir, "plugin.json"), "utf8")
    )
    expect(pluginManifest).toEqual({ name: "effect-harness" })
  })

  it("configures harness-mcp, omnigraph-mcp, and nx-mcp in mcp_config.json", () => {
    const mcp = JSON.parse(
      readFileSync(resolve(pluginDir, "mcp_config.json"), "utf8")
    )
    expect(Object.keys(mcp.mcpServers)).toEqual([
      "harness-mcp",
      "omnigraph-mcp",
      "nx-mcp"
    ])
    expect(mcp.mcpServers["harness-mcp"]).toEqual({
      command: "node",
      args: [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-mcp/src/server.ts"
      ]
    })
    expect(mcp.mcpServers["omnigraph-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "@modernrelay/omnigraph-mcp@0.14.0"],
      env: {
        OMNIGRAPH_BASE_URL: "http://127.0.0.1:8080",
        OMNIGRAPH_URL: "http://127.0.0.1:8080",
        OMNIGRAPH_GRAPH_ID: "harness",
        OMNIGRAPH_SUBJECT: "agent-mcp"
      }
    })
  })

  it("wires PreInvocation, PreToolUse, PostToolUse, and Stop hooks in Antigravity hooks.json", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(pluginDir, "hooks.json"), "utf8")
    )
    const spec = hooks["effect-harness"]
    expect(spec).toBeDefined()
    expect(spec.PreInvocation[0].command).toContain("session --format=antigravity")
    expect(spec.PreToolUse[0].matcher).toBe("run_command")
    expect(spec.PreToolUse[0].hooks[0].command).toContain("guard --format=antigravity")
    expect(spec.PostToolUse[0].matcher).toBe(
      "replace_file_content|multi_replace_file_content|write_to_file"
    )
    expect(spec.PostToolUse[0].hooks[0].command).toContain("ingest --format=antigravity")
    expect(spec.Stop[0].command).toContain("done --format=antigravity")
  })

  it("executes Antigravity PreToolUse guard hook from plugin directory with toolCall stdin", () => {
    const askStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity"
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "alchemy deploy" }
          }
        }),
        encoding: "utf8"
      }
    )
    expect(JSON.parse(askStdout.trim())).toEqual({
      decision: "ask",
      reason: "Command requires human confirmation: alchemy deploy"
    })

    const denyStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity"
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "git push --force" }
          }
        }),
        encoding: "utf8"
      }
    )
    expect(JSON.parse(denyStdout.trim())).toEqual({
      decision: "deny",
      reason: "Blocked by harness guard: git push --force"
    })

    const allowStdout = execFileSync(
      process.execPath,
      [
        "--import",
        "../../../../tools/node-ts-resolver.mjs",
        "../../../../apps/harness-cli/src/index.ts",
        "guard",
        "--format=antigravity"
      ],
      {
        cwd: pluginDir,
        input: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm test" }
          }
        }),
        encoding: "utf8"
      }
    )
    expect(JSON.parse(allowStdout.trim())).toEqual({
      decision: "allow"
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
          "--format=antigravity"
        ],
        {
          cwd: pluginDir,
          input: JSON.stringify({
            toolCall: {
              name: "write_to_file",
              args: { TargetFile: targetFile }
            }
          }),
          encoding: "utf8"
        }
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
      "Modifying harness governance/linter policy requires human confirmation"
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
          encoding: "utf8"
        }
      )
    } catch (err: any) {
      denied = true
      errOutput = (err.stderr ?? "") + (err.stdout ?? "")
    }
    expect(denied).toBe(true)
    expect(errOutput).toContain("Direct modification of verify-stamp.json is forbidden")

    const askStdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
        input: JSON.stringify({ tool_input: { file_path: ".oxlintrc.json" } }),
        encoding: "utf8"
      }
    )
    const askResult = JSON.parse(askStdout.trim())
    expect(askResult.hookSpecificOutput?.permissionDecision).toBe("ask")

    const allowStdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
        input: JSON.stringify({ tool_input: { file_path: "libs/sample/domain/src/index.ts" } }),
        encoding: "utf8"
      }
    )
    expect(allowStdout.trim()).toBe("")
  })

  it("ships specifying-ears-with-effect, planning-effect-skeletons, executing-effect-stubs, compounding-effect-learnings, and resolving-effect-review-feedback in both adapters", () => {
    const workflowSkills = [
      "specifying-ears-with-effect",
      "planning-effect-skeletons",
      "executing-effect-stubs",
      "compounding-effect-learnings",
      "resolving-effect-review-feedback"
    ]
    for (const skillName of workflowSkills) {
      const agySkill = readFileSync(
        resolve(pluginDir, "skills", skillName, "SKILL.md"),
        "utf8"
      )
      const claudeSkill = readFileSync(
        resolve(repoRoot, "adapters/claude-code/skills", skillName, "SKILL.md"),
        "utf8"
      )
      for (const content of [agySkill, claudeSkill]) {
        expect(content).toContain(`name: ${skillName}`)
        expect(content).toMatch(/description:\s*Use when /)
        expect(content).toContain("## Rationalization Table")
        expect(content).toContain("## Red Flags")
      }
    }

    for (const base of [
      resolve(pluginDir, "skills/resolving-effect-review-feedback"),
      resolve(repoRoot, "adapters/claude-code/skills/resolving-effect-review-feedback")
    ]) {
      expect(existsSync(resolve(base, "references/evaluation-rubric.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/effect-fixer-prompt.md"))).toBe(true)
    }
  })

  it("documents all 6 workflow skills and all 4 specialist reviewer subagents in README.md and adapter READMEs", () => {
    const docPaths = [
      resolve(repoRoot, "README.md"),
      resolve(pluginDir, "README.md"),
      resolve(repoRoot, "adapters/claude-code/README.md")
    ]
    const workflowSkills = [
      "effect-harness",
      "specifying-ears-with-effect",
      "planning-effect-skeletons",
      "executing-effect-stubs",
      "resolving-effect-review-feedback",
      "compounding-effect-learnings"
    ]
    const specialistSubagents = [
      "effect-ears-test-reviewer",
      "effect-security-reviewer",
      "effect-reliability-reviewer",
      "effect-adversarial-reviewer"
    ]

    for (const docPath of docPaths) {
      expect(existsSync(docPath), `Document file must exist: ${docPath}`).toBe(true)
      const content = readFileSync(docPath, "utf8")
      for (const skill of workflowSkills) {
        expect(
          content,
          `Expected ${docPath} to document workflow skill ${skill}`
        ).toContain(skill)
      }
      for (const agent of specialistSubagents) {
        expect(
          content,
          `Expected ${docPath} to document specialist reviewer subagent ${agent}`
        ).toContain(agent)
      }
    }
  })
})



