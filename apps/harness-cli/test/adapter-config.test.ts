import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CANONICAL_MCP_TOOL_NAMES,
  SPECIALIST_REVIEWER_IDS,
  SelfDogfoodingRuleId,
  TierTopologyRuleId,
} from "@harness/contract"
import { resolveHarnessStateDir } from "@harness/gates/hook-fastpath"
import {
  CLI_REPO_ROOT,
  recordTelemetry,
  shouldSuppressLiveRepoTestSideEffects,
} from "../src/commands/daemon-and-omnigraph.service.js"

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

    const postHook = hooks.hooks.PostToolUse[0]
    expect(postHook.matcher).toBe("Edit|Write|MultiEdit")
    expect(postHook.hooks[0].command).toBe(
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts ingest",
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
    expect(spec.PostToolUse[0].matcher).toBe(
      "replace_file_content|multi_replace_file_content|write_to_file",
    )
    expect(spec.PostToolUse[0].hooks[0].command).toContain(
      "hook-entry.ts ingest --format=antigravity",
    )
    expect(spec.Stop[0].command).toContain("index.ts done --format=antigravity")
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

  it("ships effect-lfg, specifying-ears-with-effect, planning-effect-skeletons, executing-effect-stubs, compounding-effect-learnings, and resolving-effect-review-feedback in both adapters", () => {
    const workflowSkills = [
      "effect-lfg",
      "effect-code-review",
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
      resolve(pluginDir, "skills/effect-code-review"),
      resolve(repoRoot, "adapters/claude-code/skills/effect-code-review"),
    ]) {
      expect(existsSync(resolve(base, "references/review-routing-and-lenses.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/report-contract-and-suppression.md"))).toBe(true)
    }

    const claudeReviewCommand = readFileSync(
      resolve(repoRoot, "adapters/claude-code/commands/effect-code-review.md"),
      "utf8",
    )
    expect(claudeReviewCommand).toContain("name: effect-code-review")
    expect(claudeReviewCommand).toContain("argument-hint:")

    for (const base of [
      resolve(pluginDir, "skills/resolving-effect-review-feedback"),
      resolve(repoRoot, "adapters/claude-code/skills/resolving-effect-review-feedback"),
    ]) {
      expect(existsSync(resolve(base, "references/evaluation-rubric.md"))).toBe(true)
      expect(existsSync(resolve(base, "references/effect-fixer-prompt.md"))).toBe(true)
    }
  })

  it("documents all workflow skills and SPECIALIST_REVIEWER_IDS in README.md and adapter READMEs", () => {
    const docPaths = [
      resolve(repoRoot, "README.md"),
      resolve(pluginDir, "README.md"),
      resolve(repoRoot, "adapters/claude-code/README.md"),
    ]
    const workflowSkills = [
      "effect-harness",
      "effect-lfg",
      "effect-code-review",
      "specifying-ears-with-effect",
      "planning-effect-skeletons",
      "executing-effect-stubs",
      "resolving-effect-review-feedback",
      "compounding-effect-learnings",
    ]

    for (const docPath of docPaths) {
      expect(existsSync(docPath), `Document file must exist: ${docPath}`).toBe(true)
      const content = readFileSync(docPath, "utf8")
      for (const skill of workflowSkills) {
        expect(content, `Expected ${docPath} to document workflow skill ${skill}`).toContain(skill)
      }
      for (const agent of SPECIALIST_REVIEWER_IDS) {
        expect(
          content,
          `Expected ${docPath} to document specialist reviewer subagent ${agent}`,
        ).toContain(agent)
      }
    }
  })

  it("enforces MCP tooling & navigation protocol and bans grep_search across all specialist reviewer agents in both adapters", () => {
    const adapterDirs = [
      resolve(pluginDir, "agents"),
      resolve(repoRoot, "adapters/claude-code/agents"),
    ]

    for (const dir of adapterDirs) {
      for (const name of SPECIALIST_REVIEWER_IDS) {
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
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(18)
    expect(CANONICAL_MCP_TOOL_NAMES).toContain("harness_workflow_plan")

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
        relPath: "executing-effect-stubs/references/personas/web-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/migration-contract-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "executing-effect-stubs/references/personas/architecture-reviewer.md",
        requiredTokens: ["## MCP Tooling & Navigation Protocol", "harness_structural_search"],
        bannedTokens: ["grep_search"],
      },
      {
        relPath: "effect-code-review/SKILL.md",
        requiredTokens: [
          "harness_review_route",
          "HarnessTierTopology.decide",
          "SelfDogfooding.decide",
          "8-Point Anti-Rubber-Stamp",
        ],
        bannedTokens: ["grep_search", "Layer.scoped", "Schema.TaggedErrorClass"],
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
          "workflow <compile|start|status|complete|resume|doctor|abort>",
          "HARNESS_UNIT_WORKER=1",
          "nondeterministic-workflow-body",
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

    const claudeDispatchReviewers = readFileSync(
      resolve(
        repoRoot,
        "adapters/claude-code/skills/executing-effect-stubs/references/dispatch-reviewers.md",
      ),
      "utf8",
    )
    const claudeCodeReviewSkill = readFileSync(
      resolve(repoRoot, "adapters/claude-code/skills/effect-code-review/SKILL.md"),
      "utf8",
    )
    for (const content of [claudeDispatchReviewers, claudeCodeReviewSkill]) {
      expect(content).not.toContain("invoke_subagent")
      expect(content).not.toContain("gemini-4-hydrogen-medium")
    }

    for (const skillsRoot of skillDirs) {
      const harnessSkill = readFileSync(resolve(skillsRoot, "effect-harness/SKILL.md"), "utf8")
      expect(harnessSkill).toMatch(/description:\s*(?:>-\s*\n\s*)?Use when /)
    }

    expect(failures).toEqual([])
  })

  it("enforces SPEC-0022 REQ-4.1 and REQ-4.2 swarm and review orchestration speedups across both adapters", () => {
    const adapterRoots = [
      { name: "antigravity", dir: resolve(pluginDir, "skills"), monitorToken: "swarm-monitor" },
      {
        name: "claude-code",
        dir: resolve(repoRoot, "adapters/claude-code/skills"),
        monitorToken: "monitoring workers",
      },
    ] as const

    for (const adapter of adapterRoots) {
      const codeReview = readFileSync(resolve(adapter.dir, "effect-code-review/SKILL.md"), "utf8")
      expect(codeReview, `${adapter.name} effect-code-review`).toContain("harness_git_diff")
      expect(codeReview, `${adapter.name} effect-code-review`).toContain("statOnly: true")
      expect(codeReview, `${adapter.name} effect-code-review`).toContain("baseRef")
      expect(codeReview, `${adapter.name} effect-code-review`).not.toContain("[P0\n")
      expect(codeReview, `${adapter.name} effect-code-review`).not.toMatch(/^\|[^\n]*`\[P0\s*\|/m)

      const dispatchReviewers = readFileSync(
        resolve(adapter.dir, "executing-effect-stubs/references/dispatch-reviewers.md"),
        "utf8",
      )
      expect(dispatchReviewers, `${adapter.name} dispatch-reviewers`).toContain("harness_git_diff")
      expect(dispatchReviewers, `${adapter.name} dispatch-reviewers`).toContain("statOnly: true")
      expect(dispatchReviewers, `${adapter.name} dispatch-reviewers`).toContain(
        "Domain-Owned Changed Files",
      )
      expect(dispatchReviewers, `${adapter.name} dispatch-reviewers`).toContain(
        "Base Ref: <baseRef>",
      )

      const resolvingFeedback = readFileSync(
        resolve(adapter.dir, "resolving-effect-review-feedback/SKILL.md"),
        "utf8",
      )
      for (const token of [
        "> 15",
        "2+",
        "df -ih /tmp",
        "NX_SOCKET_DIR",
        "pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test",
        "Sub-Bullet Verification Matrix",
        "block Phase 5",
        "swarm kill",
      ]) {
        expect(
          resolvingFeedback,
          `${adapter.name} resolving-effect-review-feedback missing ${token}`,
        ).toContain(token)
      }
      expect(resolvingFeedback).not.toContain("&& lint && test")
      expect(resolvingFeedback).not.toContain("NX_DAEMON=false` hangs")
      expect(resolvingFeedback).not.toContain("NX_DAEMON=false hangs")
      expect(resolvingFeedback).not.toContain("except targeted --file")
      if (adapter.name === "claude-code") {
        expect(resolvingFeedback).not.toContain("swarm workers")
        expect(resolvingFeedback).not.toContain("invoke_subagent")
      }

      const fixerPrompt = readFileSync(
        resolve(adapter.dir, "resolving-effect-review-feedback/references/effect-fixer-prompt.md"),
        "utf8",
      )
      expect(fixerPrompt).toContain(
        "pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test",
      )
      expect(fixerPrompt).not.toContain("&& lint && test")
      expect(fixerPrompt).not.toContain("NX_DAEMON=false` hangs")
      expect(fixerPrompt).not.toContain("NX_DAEMON=false hangs")

      for (const rel of ["effect-lfg/SKILL.md", "executing-effect-stubs/SKILL.md"] as const) {
        const content = readFileSync(resolve(adapter.dir, rel), "utf8")
        for (const token of [
          "df -ih /tmp",
          "NX_SOCKET_DIR",
          "pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test",
          "Sub-Bullet Verification Matrix",
          "swarm kill",
          adapter.monitorToken,
        ]) {
          expect(content, `${adapter.name} ${rel} missing ${token}`).toContain(token)
        }
        expect(content).not.toContain("&& lint && test")
        expect(content).not.toContain("NX_DAEMON=false` hangs")
        expect(content).not.toContain("NX_DAEMON=false hangs")
      }
    }
  })

  it("enforces Phase 5 Step 0 metric sync, stamp-safe ordering, and CANONICAL_MCP_TOOL_NAMES MCP catalog across README.md and adapter READMEs", () => {
    const rootReadme = readFileSync(resolve(repoRoot, "README.md"), "utf8")
    const agyReadme = readFileSync(resolve(pluginDir, "README.md"), "utf8")
    const claudeReadme = readFileSync(resolve(repoRoot, "adapters/claude-code/README.md"), "utf8")

    expect(rootReadme).toContain("Phase 5 Metric Sync Matrix")
    expect(rootReadme).toContain("harness ontology check --strict")
    expect(rootReadme).not.toContain("Schema.TaggedErrorClass")
    expect(rootReadme).not.toContain("Layer.scoped")
    expect(rootReadme).not.toContain("{ writeReport? }")

    for (const readme of [agyReadme, claudeReadme]) {
      expect(readme).toContain("exposing 18 tools")
      expect(readme).toContain("harness workflow")
      expect(readme).toContain("HARNESS_UNIT_WORKER=1")
      expect(readme).toContain("nondeterministic-workflow-body")
      for (const toolName of CANONICAL_MCP_TOOL_NAMES) {
        expect(readme).toContain(toolName)
      }
    }
    expect(rootReadme).toContain(
      "HARNESS_INFRA --> GATES & DECISION & GRAPH & HARNESS_SVC & HARNESS_CON",
    )
    expect(rootReadme).toContain("Exposes 18")
    expect(rootReadme).toContain(
      "workflow <compile\\|start\\|status\\|complete\\|resume\\|doctor\\|abort>",
    )
    expect(rootReadme).toContain("HARNESS_UNIT_WORKER=1")
    expect(rootReadme).toContain("nondeterministic-workflow-body")
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

  it("keeps specialist agent definitions and persona references in exact body parity across both adapters", () => {
    const marker = "## MCP Tooling & Navigation Protocol"
    const extractBodyFromProtocol = (filePath: string): string => {
      const content = readFileSync(filePath, "utf8")
      const idx = content.indexOf(marker)
      expect(idx, `Expected "${marker}" in ${filePath}`).toBeGreaterThanOrEqual(0)
      return content.slice(idx)
    }
    const normalizeAntigravityToClaude = (body: string): string =>
      body
        .replaceAll("effect-harness_harness-mcp", "harness-mcp")
        .replaceAll("effect-harness_omnigraph-mcp", "omnigraph-mcp")
        .replaceAll(
          "`read_file` with targeted `StartLine` and `EndLine`",
          "`Read` with targeted `offset` and `limit`",
        )
        .replaceAll("`read_file`", "`Read`")

    for (const reviewerId of SPECIALIST_REVIEWER_IDS) {
      const personaFile = `${reviewerId.replace(/^effect-/, "")}.md`
      const agyAgentBody = extractBodyFromProtocol(resolve(pluginDir, "agents", `${reviewerId}.md`))
      const agyPersonaBody = extractBodyFromProtocol(
        resolve(pluginDir, "skills/executing-effect-stubs/references/personas", personaFile),
      )
      expect(agyAgentBody, `Antigravity agent vs persona parity failed for ${reviewerId}`).toBe(
        agyPersonaBody,
      )

      const claudeAgentBody = extractBodyFromProtocol(
        resolve(repoRoot, "adapters/claude-code/agents", `${reviewerId}.md`),
      )
      const claudePersonaBody = extractBodyFromProtocol(
        resolve(
          repoRoot,
          "adapters/claude-code/skills/executing-effect-stubs/references/personas",
          personaFile,
        ),
      )
      expect(claudeAgentBody, `Claude Code agent vs persona parity failed for ${reviewerId}`).toBe(
        claudePersonaBody,
      )

      expect(
        normalizeAntigravityToClaude(agyAgentBody),
        `Cross-adapter normalized agent body parity failed for ${reviewerId}`,
      ).toBe(claudeAgentBody)
    }
  })

  it("bans view_file across both adapters and bans Antigravity-prefixed MCP server names in adapters/claude-code", () => {
    const collectFiles = (dir: string): ReadonlyArray<string> => {
      const out: Array<string> = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          out.push(...collectFiles(full))
        } else {
          out.push(full)
        }
      }
      return out
    }

    const adapterFiles = [
      ...collectFiles(resolve(pluginDir, "agents")),
      ...collectFiles(resolve(pluginDir, "skills")),
      ...collectFiles(resolve(repoRoot, "adapters/claude-code")),
    ]
    for (const filePath of adapterFiles) {
      const content = readFileSync(filePath, "utf8")
      expect(content, `Banned "view_file" found in ${filePath}`).not.toContain("view_file")
    }

    const claudeFiles = collectFiles(resolve(repoRoot, "adapters/claude-code"))
    expect(claudeFiles.length).toBeGreaterThan(0)
    for (const filePath of claudeFiles) {
      const content = readFileSync(filePath, "utf8")
      expect(
        content,
        `Banned Antigravity MCP server name "effect-harness_harness-mcp" found in ${filePath}`,
      ).not.toContain("effect-harness_harness-mcp")
      expect(
        content,
        `Banned Antigravity MCP server name "effect-harness_omnigraph-mcp" found in ${filePath}`,
      ).not.toContain("effect-harness_omnigraph-mcp")
      expect(
        content,
        `Banned Antigravity worktree directive 'Workspace: "share"' found in ${filePath}`,
      ).not.toContain('Workspace: "share"')
      expect(
        content,
        `Banned Antigravity model directive 'model: "flash"' found in ${filePath}`,
      ).not.toContain('model: "flash"')
      expect(
        content,
        `Banned Antigravity subagent model '\`flash\`' found in ${filePath}`,
      ).not.toContain("`flash`")
    }
  })

  it("never loads typescript on guard --format=antigravity cold start", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "harness-guard-cold-state-"))
    try {
      const res = spawnSync(
        process.execPath,
        [
          "--import",
          "./tools/node-ts-resolver.mjs",
          "apps/harness-cli/src/index.ts",
          "guard",
          "--format=antigravity",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HARNESS_STATE_DIR: stateDir,
            NODE_DEBUG: "module",
          },
          input: JSON.stringify({
            toolCall: { name: "run_command", args: { CommandLine: "git status" } },
          }),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({ decision: "allow" })
      expect(res.stderr).not.toContain("node_modules/typescript")
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("shouldSuppressLiveRepoTestSideEffects protects CLI_REPO_ROOT while preserving temp repoRoot telemetry writes", async () => {
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_DISABLE_LIVE_TELEMETRY: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_TEST_ISOLATION: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_DISABLE_LIVE_TELEMETRY: "1",
        HARNESS_STATE_DIR: "/tmp/custom-state",
      }),
    ).toBe(false)

    const tempRepo = mkdtempSync(join(tmpdir(), "harness-telemetry-isolation-"))
    try {
      expect(
        shouldSuppressLiveRepoTestSideEffects(tempRepo, { HARNESS_DISABLE_LIVE_TELEMETRY: "1" }),
      ).toBe(false)
      recordTelemetry(
        { repoRoot: tempRepo },
        {
          surface: "cli",
          category: "guard",
          toolName: "guard",
          outcome: "ok",
          durationMs: 1,
        },
      )
      const { recordFriction } = await import("../src/commands/daemon-and-omnigraph.service.js")
      const liveFrictionPath = join(CLI_REPO_ROOT, ".harness", "friction-log.jsonl")
      const beforeLiveFriction = existsSync(liveFrictionPath)
        ? readFileSync(liveFrictionPath, "utf8")
        : undefined
      const prevDisable = process.env.HARNESS_DISABLE_LIVE_TELEMETRY
      const prevStateDir = process.env.HARNESS_STATE_DIR
      process.env.HARNESS_DISABLE_LIVE_TELEMETRY = "1"
      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      try {
        recordFriction(
          { repoRoot: CLI_REPO_ROOT },
          { kind: "route_miss", summary: "suppressed-test", detail: "should-not-write" },
        )
        const afterLiveFriction = existsSync(liveFrictionPath)
          ? readFileSync(liveFrictionPath, "utf8")
          : undefined
        expect(afterLiveFriction).toBe(beforeLiveFriction)
      } finally {
        if (prevDisable === undefined)
          Reflect.deleteProperty(process.env, "HARNESS_DISABLE_LIVE_TELEMETRY")
        else process.env.HARNESS_DISABLE_LIVE_TELEMETRY = prevDisable
        if (prevStateDir !== undefined) process.env.HARNESS_STATE_DIR = prevStateDir
      }

      recordFriction(
        { repoRoot: tempRepo },
        {
          kind: "route_miss",
          summary: "temp-friction",
          detail: "should-write",
        },
      )
      expect(
        existsSync(join(resolveHarnessStateDir(tempRepo, process.env), "telemetry-log.jsonl")),
      ).toBe(true)
      expect(
        existsSync(join(resolveHarnessStateDir(tempRepo, process.env), "friction-log.jsonl")),
      ).toBe(true)
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it("S-7.2b: HARNESS_TEST_ISOLATION=1 suppresses CLI_REPO_ROOT side effects unless HARNESS_STATE_DIR is set or repoRoot is temp", () => {
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_TEST_ISOLATION: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_TEST_ISOLATION: "1",
        HARNESS_STATE_DIR: "",
      }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_TEST_ISOLATION: "1",
        HARNESS_STATE_DIR: "/tmp/custom-state",
      }),
    ).toBe(false)
    expect(shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {})).toBe(false)

    const tempRepo = mkdtempSync(join(tmpdir(), "harness-test-isolation-"))
    try {
      expect(shouldSuppressLiveRepoTestSideEffects(tempRepo, { HARNESS_TEST_ISOLATION: "1" })).toBe(
        false,
      )
      expect(
        shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
          HARNESS_TEST_ISOLATION: "1",
          HARNESS_STATE_DIR: "   ",
        }),
      ).toBe(true)
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it("REQ-4.1: writeDoneSessionReport, tryCachePreInvocationResult, and handleReport suppress writes to CLI_REPO_ROOT and invalid HARNESS_STATE_DIR does not throw", async () => {
    const { Effect } = await import("effect")
    const { writeDoneSessionReport } = await import("../src/commands/mutate-and-bench.command.js")
    const { tryCachePreInvocationResult } = await import("../src/commands/session-fastpath.js")
    const { handleReport, handleSession } =
      await import("../src/commands/session-learn-report.command.js")

    const liveHarnessDir = join(CLI_REPO_ROOT, ".harness")
    const watchedFiles = [
      join(liveHarnessDir, "session-report.json"),
      join(liveHarnessDir, "session-report.md"),
      join(liveHarnessDir, "session-preinvocation-cache.json"),
      join(liveHarnessDir, "last-done.json"),
    ]
    const beforeContents = watchedFiles.map((p) =>
      existsSync(p) ? readFileSync(p, "utf8") : undefined,
    )

    const prevDisable = process.env.HARNESS_DISABLE_LIVE_TELEMETRY
    const prevStateDir = process.env.HARNESS_STATE_DIR
    process.env.HARNESS_DISABLE_LIVE_TELEMETRY = "1"
    Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
    try {
      writeDoneSessionReport(CLI_REPO_ROOT)
      tryCachePreInvocationResult(CLI_REPO_ROOT, liveHarnessDir, true, false, [], "", {
        repoRoot: CLI_REPO_ROOT,
        skipBackgroundDaemons: true,
      })
      const reportRes = await Effect.runPromise(
        handleReport(["--format=json"], { repoRoot: CLI_REPO_ROOT }),
      )
      expect(reportRes.exitCode).toBe(0)

      watchedFiles.forEach((p, idx) => {
        const after = existsSync(p) ? readFileSync(p, "utf8") : undefined
        expect(after).toBe(beforeContents[idx])
      })

      // Invalid HARNESS_STATE_DIR ("." and whitespace) must never crash session/report handlers
      const tempRepo = mkdtempSync(join(tmpdir(), "harness-invalid-state-dir-"))
      try {
        writeFileSync(join(tempRepo, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
        for (const badStateDir of [".", "   "]) {
          process.env.HARNESS_STATE_DIR = badStateDir
          const sessionRes = await Effect.runPromise(
            handleSession(["--format=antigravity"], {
              repoRoot: tempRepo,
              skipBackgroundDaemons: true,
            }),
          )
          expect(sessionRes.exitCode).toBe(0)
          const rptRes = await Effect.runPromise(
            handleReport(["--format=json"], { repoRoot: tempRepo }),
          )
          expect(rptRes.exitCode).toBe(0)
        }
      } finally {
        rmSync(tempRepo, { recursive: true, force: true })
      }
    } finally {
      if (prevDisable === undefined)
        Reflect.deleteProperty(process.env, "HARNESS_DISABLE_LIVE_TELEMETRY")
      else process.env.HARNESS_DISABLE_LIVE_TELEMETRY = prevDisable
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env.HARNESS_STATE_DIR = prevStateDir
    }

    // Importing @harness/infra/hook-fastpath with whitespace HARNESS_STATE_DIR must not throw at module load
    const hookLoadOut = execFileSync(
      process.execPath,
      [
        "--import",
        join(CLI_REPO_ROOT, "tools/node-ts-resolver.mjs"),
        "--input-type=module",
        "-e",
        'await import("@harness/infra/hook-fastpath"); process.stdout.write("INFRA_HOOK_OK");',
      ],
      {
        cwd: CLI_REPO_ROOT,
        env: { ...process.env, HARNESS_STATE_DIR: "   " },
        encoding: "utf8",
      },
    )
    expect(hookLoadOut).toContain("INFRA_HOOK_OK")
  })
})
