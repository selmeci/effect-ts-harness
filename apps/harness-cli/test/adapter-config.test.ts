import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CANONICAL_MCP_TOOL_NAMES,
  SelfDogfoodingRuleId,
  TierTopologyRuleId,
} from "@harness/contract"

describe("Claude Code adapter & Omnigraph Cedar policy", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")

  it("wires SessionStart, PreToolUse, PostToolUse, and Stop hooks to harness-cli", () => {
    const hooks = JSON.parse(
      readFileSync(resolve(repoRoot, "adapters/claude-code/hooks.json"), "utf8"),
    )
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "PreToolUse", "PostToolUse", "Stop"])

    const sessionHook = hooks.hooks.SessionStart[0].hooks[0]
    expect(sessionHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts session",
    )

    const preHook = hooks.hooks.PreToolUse[0]
    expect(preHook.matcher).toBe("Bash")
    expect(preHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard || exit 2",
    )

    const postHook = hooks.hooks.PostToolUse[0]
    expect(postHook.matcher).toBe("Edit|Write|MultiEdit")
    expect(postHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ingest",
    )

    const stopHook = hooks.hooks.Stop[0].hooks[0]
    expect(stopHook.command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done || exit 2",
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
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts",
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
        "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts",
        `node ${JSON.stringify(brokenEntry)}`,
      )
      const agyGuardRes = spawnSync("/bin/sh", ["-c", agyGuardCmd], { encoding: "utf8" })
      expect(agyGuardRes.status).toBe(2)
      expect(JSON.parse(agyGuardRes.stdout.trim())).toEqual({
        decision: "deny",
        reason: "guard: runtime bootstrap failed",
      })

      const agyDoneCmd = (agyHooks["effect-harness"].Stop[0].command as string).replace(
        "node --import ../../../../tools/node-ts-resolver.mjs ../../../../apps/harness-cli/src/index.ts",
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
    const stdout = execFileSync(
      process.execPath,
      ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
      {
        cwd: repoRoot,
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
    expect(spec).toBeDefined()
    expect(spec.PreInvocation[0].command).toContain("session --format=antigravity")
    expect(spec.PreToolUse[0].matcher).toBe("run_command")
    expect(spec.PreToolUse[0].hooks[0].command).toContain("guard --format=antigravity")
    expect(spec.PostToolUse[0].matcher).toBe(
      "replace_file_content|multi_replace_file_content|write_to_file",
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
      reason: "Blocked by harness guard: git push --force",
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

  it("ships effect-lfg, specifying-ears-with-effect, planning-effect-skeletons, executing-effect-stubs, compounding-effect-learnings, and resolving-effect-review-feedback in both adapters", () => {
    const workflowSkills = [
      "effect-lfg",
      "specifying-ears-with-effect",
      "planning-effect-skeletons",
      "executing-effect-stubs",
      "compounding-effect-learnings",
      "resolving-effect-review-feedback",
    ]
    for (const skillName of workflowSkills) {
      const agySkill = readFileSync(resolve(pluginDir, "skills", skillName, "SKILL.md"), "utf8")
      const claudeSkill = readFileSync(
        resolve(repoRoot, "adapters/claude-code/skills", skillName, "SKILL.md"),
        "utf8",
      )
      for (const content of [agySkill, claudeSkill]) {
        expect(content).toContain(`name: ${skillName}`)
        expect(content).toMatch(/description:\s*Use when /)
        expect(content).toContain("## Rationalization Table")
        expect(content).toContain("## Red Flags")
      }
    }

    for (const base of [
      resolve(pluginDir, "skills/effect-lfg"),
      resolve(repoRoot, "adapters/claude-code/skills/effect-lfg"),
    ]) {
      expect(existsSync(resolve(base, "references/autonomous-intake-and-ears.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/multi-slice-worktree-execution.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/review-and-shipping.md"))).toBe(true)
    }

    const claudeCommand = readFileSync(
      resolve(repoRoot, "adapters/claude-code/commands/effect-lfg.md"),
      "utf8",
    )
    expect(claudeCommand).toContain("name: effect-lfg")
    expect(claudeCommand).toContain("argument-hint:")

    for (const base of [
      resolve(pluginDir, "skills/resolving-effect-review-feedback"),
      resolve(repoRoot, "adapters/claude-code/skills/resolving-effect-review-feedback"),
    ]) {
      expect(existsSync(resolve(base, "references/evaluation-rubric.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/effect-fixer-prompt.md"))).toBe(true)
    }
  })

  it("documents all 7 workflow skills and all 4 specialist reviewer subagents in README.md and adapter READMEs", () => {
    const docPaths = [
      resolve(repoRoot, "README.md"),
      resolve(pluginDir, "README.md"),
      resolve(repoRoot, "adapters/claude-code/README.md"),
    ]
    const workflowSkills = [
      "effect-harness",
      "effect-lfg",
      "specifying-ears-with-effect",
      "planning-effect-skeletons",
      "executing-effect-stubs",
      "resolving-effect-review-feedback",
      "compounding-effect-learnings",
    ]
    const specialistSubagents = [
      "effect-ears-test-reviewer",
      "effect-security-reviewer",
      "effect-reliability-reviewer",
      "effect-adversarial-reviewer",
    ]

    for (const docPath of docPaths) {
      expect(existsSync(docPath), `Document file must exist: ${docPath}`).toBe(true)
      const content = readFileSync(docPath, "utf8")
      for (const skill of workflowSkills) {
        expect(content, `Expected ${docPath} to document workflow skill ${skill}`).toContain(skill)
      }
      for (const agent of specialistSubagents) {
        expect(
          content,
          `Expected ${docPath} to document specialist reviewer subagent ${agent}`,
        ).toContain(agent)
      }
    }
  })

  it("enforces MCP tooling & navigation protocol and bans grep_search across all specialist reviewer agents in both adapters", () => {
    const reviewerNames = [
      "effect-ears-test-reviewer",
      "effect-security-reviewer",
      "effect-reliability-reviewer",
      "effect-adversarial-reviewer",
    ]
    const adapterDirs = [
      resolve(pluginDir, "agents"),
      resolve(repoRoot, "adapters/claude-code/agents"),
    ]

    for (const dir of adapterDirs) {
      for (const name of reviewerNames) {
        const filePath = resolve(dir, `${name}.md`)
        expect(existsSync(filePath), `Reviewer file must exist: ${filePath}`).toBe(true)
        const content = readFileSync(filePath, "utf8")
        expect(content, `Expected ${filePath} to contain protocol header`).toContain(
          "## MCP Tooling & Navigation Protocol",
        )
        expect(content, `Expected ${filePath} to reference harness_structural_search`).toContain(
          "harness_structural_search",
        )
        expect(content, `Expected ${filePath} to forbid chrome-devtools-mcp`).toContain(
          "chrome-devtools-mcp",
        )
        expect(
          content,
          `Expected ${filePath} not to reference nonexistent grep_search`,
        ).not.toContain("grep_search")
      }
    }
  })

  it("enforces 5-tier hexagonal architecture and canonical rule/tool registries across skills, references, and reviewer personas in both adapters", () => {
    const registeredRules = new Set<string>([
      ...SelfDogfoodingRuleId.literals,
      ...TierTopologyRuleId.literals,
    ])
    const canonicalTopologyRules = [
      "dual-contract-tier-tag",
      "impure-service-tier-import",
      "forbidden-contract-dependency",
      "forbidden-service-dependency",
      "undeclared-workspace-dependency",
    ] as const
    const canonicalDogfoodRules = [
      "no-node-builtins-outside-infra",
      "no-global-mutable-cache",
      "process-env-outside-infra-or-app",
      "facade-star-reexport",
      "bare-cause-has-interrupts",
      "catch-cause-interrupts-only",
      "no-layer-build-in-layer-effect",
      "no-double-wrapped-effect-fn",
      "dynamic-harness-import",
    ] as const
    for (const ruleId of [...canonicalTopologyRules, ...canonicalDogfoodRules]) {
      expect(registeredRules.has(ruleId), `Rule ${ruleId} must exist in @harness/contract`).toBe(
        true,
      )
    }
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(15)

    const skillExpectations: ReadonlyArray<{
      readonly relPath: string
      readonly requiredTokens: ReadonlyArray<string>
      readonly bannedTokens: ReadonlyArray<string>
    }> = [
      {
        relPath: "specifying-ears-with-effect/SKILL.md",
        requiredTokens: ["libs/<scope>/core/src/index.ts", "5 hexagonal Nx tiers"],
        bannedTokens: ["across 4 Nx tiers", "Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "specifying-ears-with-effect/references/ears-patterns.md",
        requiredTokens: ["`type:domain` / `type:core`"],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "planning-effect-skeletons/SKILL.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "dual-contract-tier-tag",
          "impure-service-tier-import",
          "no-node-builtins-outside-infra",
          "no-global-mutable-cache",
          "process-env-outside-infra-or-app",
          "facade-star-reexport",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "planning-effect-skeletons/references/adr-guidelines.md",
        requiredTokens: ["`type:core` / `type:domain`"],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "planning-effect-skeletons/references/adversarial-plan-lens.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "`type:core`, `type:domain`, and `type:infra`",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "executing-effect-stubs/SKILL.md",
        requiredTokens: [
          "8-Point Anti-Rubber-Stamp",
          "5 hexagonal",
          "no-node-builtins-outside-infra",
          "no-global-mutable-cache",
          "facade-star-reexport",
        ],
        bannedTokens: ["7-Point Anti-Rubber-Stamp", "all 4 layers", "Layer.scoped"],
      },
      {
        relPath: "executing-effect-stubs/references/dispatch-reviewers.md",
        requiredTokens: [
          "8-Point Anti-Rubber-Stamp",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
        ],
        bannedTokens: ["7-Point Anti-Rubber-Stamp", "Layer.scoped"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/ears-test-reviewer.md",
        requiredTokens: [
          "## MCP Tooling & Navigation Protocol",
          "harness_structural_search",
          "8-Point Anti-Rubber-Stamp Deep Audit",
          "`type:infra` Guard-Deletion Falsification",
        ],
        bannedTokens: ["grep_search", "7-Point Anti-Rubber-Stamp Deep Audit"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/adversarial-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/security-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/reliability-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "effect-lfg/SKILL.md",
        requiredTokens: ["HarnessTierTopology.decide", "SelfDogfooding.decide"],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "effect-lfg/references/review-and-shipping.md",
        requiredTokens: [
          "8-Point Anti-Rubber-Stamp Deep Audit",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "ontology check --strict",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "effect-harness/SKILL.md",
        requiredTokens: [
          "### 2.1 MCP-First Tooling Preference",
          "during development only",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "{path, path/posix, path/win32, crypto, url}",
          "Phase 5 Step 0",
          "ontology check --strict",
          ...CANONICAL_MCP_TOOL_NAMES,
        ],
        bannedTokens: [
          "### 1.3 MCP-First Tooling Preference",
          "Layer.scoped",
          "Schema.TaggedErrorClass",
        ],
      },
      {
        relPath: "resolving-effect-review-feedback/SKILL.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "8-Point Anti-Rubber-Stamp",
          ".harness/verify-stamp.json",
          "Phase 5 Metric Sync Matrix",
          "PHASE_5_STEP_0_WC_L",
          "ontology check --strict",
          "impure-service-tier-import",
          "facade-star-reexport",
          "bare-cause-has-interrupts",
          "unbranded-contract-schema",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass", "7-Point Anti-Rubber-Stamp"],
      },
      {
        relPath: "resolving-effect-review-feedback/references/evaluation-rubric.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          ...canonicalTopologyRules,
          ...canonicalDogfoodRules,
          "isPureInterruptCause",
          "unbranded-contract-schema",
          "contract-test-effect-vitest-import",
          "PHASE_5_STEP_0_WC_L",
        ],
        bannedTokens: [
          "Layer.scoped",
          "Schema.TaggedErrorClass",
          "!Cause.hasDies(cause)` or `Cause.hasInterruptsOnly(cause)`",
        ],
      },
      {
        relPath: "resolving-effect-review-feedback/references/effect-fixer-prompt.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "impure-service-tier-import",
          "no-node-builtins-outside-infra",
          "no-global-mutable-cache",
          "facade-star-reexport",
          "bare-cause-has-interrupts",
          "isPureInterruptCause",
          "unbranded-contract-schema",
          "contract-test-effect-vitest-import",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        relPath: "compounding-effect-learnings/SKILL.md",
        requiredTokens: [
          "@harness/contract",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          ".harness/verify-stamp.json",
          "facade-star-reexport",
          "ontology check --strict",
        ],
        bannedTokens: ["Layer.scoped", "Schema.TaggedErrorClass"],
      },
    ]

    const skillDirs = [
      resolve(pluginDir, "skills"),
      resolve(repoRoot, "adapters/claude-code/skills"),
    ]

    const failures: Array<string> = []
    for (const skillsRoot of skillDirs) {
      for (const spec of skillExpectations) {
        const fullPath = resolve(skillsRoot, spec.relPath)
        const content = readFileSync(fullPath, "utf8")
        for (const req of spec.requiredTokens) {
          if (!content.includes(req)) {
            failures.push(`Missing required token "${req}" in ${fullPath}`)
          }
        }
        for (const banned of spec.bannedTokens) {
          if (content.includes(banned)) {
            failures.push(`Found banned stale token "${banned}" in ${fullPath}`)
          }
        }
      }
    }

    const claudeResolvingSkill = readFileSync(
      resolve(repoRoot, "adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md"),
      "utf8",
    )
    const claudeFixerPrompt = readFileSync(
      resolve(
        repoRoot,
        "adapters/claude-code/skills/resolving-effect-review-feedback/references/effect-fixer-prompt.md",
      ),
      "utf8",
    )
    expect(claudeResolvingSkill).not.toContain('model: "flash"')
    expect(claudeFixerPrompt).not.toContain('model: "flash"')
    expect(failures).toEqual([])
  })

  it("enforces Phase 5 Step 0 metric sync, stamp-safe ordering, and 15-tool MCP catalog across README.md and adapter READMEs", () => {
    const rootReadme = readFileSync(resolve(repoRoot, "README.md"), "utf8")
    const agyReadme = readFileSync(resolve(pluginDir, "README.md"), "utf8")
    const claudeReadme = readFileSync(resolve(repoRoot, "adapters/claude-code/README.md"), "utf8")

    expect(rootReadme).toContain("Phase 5 Metric Sync Matrix")
    expect(rootReadme).toContain("harness ontology check --strict")
    expect(rootReadme).not.toContain("Schema.TaggedErrorClass")
    expect(rootReadme).not.toContain("Layer.scoped")
    expect(rootReadme).not.toContain("{ writeReport? }")

    for (const readme of [agyReadme, claudeReadme]) {
      expect(readme).toContain("exposing 15 tools")
      for (const toolName of CANONICAL_MCP_TOOL_NAMES) {
        expect(readme).toContain(toolName)
      }
    }
    for (const toolName of CANONICAL_MCP_TOOL_NAMES) {
      expect(rootReadme).toContain(toolName)
    }
  })

  it("enforces Effect v4 and 5-tier hexagonal purity across agent-patterns/*.md recipes and bans removed Effect v3 APIs", () => {
    const patternExpectations: ReadonlyArray<{
      readonly file: string
      readonly requiredTokens: ReadonlyArray<string>
      readonly bannedTokens: ReadonlyArray<string>
    }> = [
      {
        file: "agent-patterns/planning.md",
        requiredTokens: [
          "`type:infra` & `type:core`",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "impure-service-tier-import",
          "facade-star-reexport",
        ],
        bannedTokens: ["`type:infra` / `type:service`", "Layer.scoped", "Schema.TaggedErrorClass"],
      },
      {
        file: "agent-patterns/services-and-layers.md",
        requiredTokens: [
          "HarnessTierTopology.decide",
          "impure-service-tier-import",
          "no-layer-build-in-layer-effect",
          "DatabaseLive",
          "SqlQueryText",
        ],
        bannedTokens: [
          "static readonly Live = Layer",
          "Database.Live",
          "Config.Live",
          "Cache.Live",
          "export const ManagedPoolLive = Layer.scoped",
        ],
      },
      {
        file: "agent-patterns/errors.md",
        requiredTokens: [
          "unbranded-contract-schema",
          'Schema.brand("UserId")',
          "Schema.TaggedError",
        ],
        bannedTokens: ["Schema.TaggedErrorClass"],
      },
      {
        file: "agent-patterns/resources-scope.md",
        requiredTokens: [
          "bare-cause-has-interrupts",
          "catch-cause-interrupts-only",
          "isPureInterruptCause",
          "no-node-builtins-outside-infra",
          "SqlQueryText",
          "Result.try",
        ],
        bannedTokens: [
          "export const ConnectionPoolLive = Layer.scoped",
          "execute: (query: string)",
          "try {\n            fs.unlinkSync",
        ],
      },
      {
        file: "agent-patterns/pattern-matching.md",
        requiredTokens: ["Schema.TaggedError"],
        bannedTokens: ["Schema.TaggedErrorClass"],
      },
      {
        file: "agent-patterns/README.md",
        requiredTokens: ["Schema.TaggedError", "Layer.effect"],
        bannedTokens: ["Schema.TaggedErrorClass", "Layer.scoped"],
      },
    ]

    const failures: Array<string> = []
    for (const spec of patternExpectations) {
      const fullPath = resolve(repoRoot, spec.file)
      const content = readFileSync(fullPath, "utf8")
      for (const req of spec.requiredTokens) {
        if (!content.includes(req)) {
          failures.push(`Missing required token "${req}" in ${spec.file}`)
        }
      }
      for (const banned of spec.bannedTokens) {
        if (content.includes(banned)) {
          failures.push(`Found banned stale token "${banned}" in ${spec.file}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})
