import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CANONICAL_MCP_TOOL_NAMES,
  SPECIALIST_REVIEWER_IDS,
  SelfDogfoodingRuleId,
  TierTopologyRuleId,
} from "@harness/contract"
import { ADAPTER_SKILL_PARITY_CLAUSES, auditAdapterSkillParityPair } from "@harness/gates"

describe("Adapter skills, personas & parity", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")
  const pluginDir = resolve(repoRoot, "adapters/antigravity/plugins/effect-harness")

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

  const buildAdapterSkillExpectations = () => {
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
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(20)

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
          "workflow <compile|start|status|complete|resume|ship|doctor|abort>",
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

    return { registeredRules, canonicalTopologyRules, canonicalDogfoodRules, skillExpectations }
  }

  it("enforces 5-tier hexagonal architecture and canonical rule/tool registries across skills, references, and reviewer personas in both adapters", () => {
    const { registeredRules, canonicalTopologyRules, canonicalDogfoodRules, skillExpectations } =
      buildAdapterSkillExpectations()
    for (const ruleId of [...canonicalTopologyRules, ...canonicalDogfoodRules]) {
      expect(registeredRules.has(ruleId), `Rule ${ruleId} must exist in @harness/contract`).toBe(
        true,
      )
    }
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(20)
    expect(CANONICAL_MCP_TOOL_NAMES).toContain("harness_workflow_plan")
    expect(CANONICAL_MCP_TOOL_NAMES).toContain("harness_search_knowledge")
    expect(CANONICAL_MCP_TOOL_NAMES).toContain("harness_doc_tree")

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
      expect(readme).toContain("exposing 20 tools")
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
    expect(rootReadme).toContain("Exposes 20")
    expect(rootReadme).toContain(
      "workflow <compile\\|start\\|status\\|complete\\|resume\\|ship\\|doctor\\|abort>",
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

  it("bans Antigravity-only tool names including read_file across all adapters/claude-code/skills markdown files", () => {
    const claudeSkillsRoot = resolve(repoRoot, "adapters/claude-code/skills")
    const collectMarkdownFiles = (dir: string): Array<string> => {
      const files: Array<string> = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...collectMarkdownFiles(fullPath))
        } else if (entry.name.endsWith(".md")) {
          files.push(fullPath)
        }
      }
      return files
    }
    const markdownFiles = collectMarkdownFiles(claudeSkillsRoot)
    expect(markdownFiles.length).toBeGreaterThan(0)
    for (const filePath of markdownFiles) {
      const content = readFileSync(filePath, "utf8")
      for (const bannedTool of [
        "read_file",
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "grep_search",
        "invoke_subagent",
      ]) {
        expect(content, `${filePath} contains ${bannedTool}`).not.toContain(bannedTool)
      }
    }
  })

  it("SPEC-0030 REQ-2.1 / REQ-2.2: keeps Swarm Seam Checklist and Second-Pass Remediation Re-Audit synchronized across Antigravity and Claude Code", () => {
    for (const clause of ADAPTER_SKILL_PARITY_CLAUSES) {
      const agyContent = readFileSync(
        resolve(pluginDir, "skills", clause.skillName, "SKILL.md"),
        "utf8",
      )
      const claudeContent = readFileSync(
        resolve(repoRoot, "adapters/claude-code/skills", clause.skillName, "SKILL.md"),
        "utf8",
      )
      expect(
        auditAdapterSkillParityPair(clause, agyContent, claudeContent),
        `Adapter skill parity drifted for ${clause.skillName}`,
      ).toEqual([])
      const strippedClaude = claudeContent.replace(clause.heading, "### Removed Heading")
      expect(
        auditAdapterSkillParityPair(clause, agyContent, strippedClaude).some(
          (f) => f.kind === "adapter-skill-parity",
        ),
      ).toBe(true)
    }
  })

  it("SPEC-0032 REQ-3.2: AGENTS.md, adapter READMEs & skills cover ShipWorkflow & worker isolation", () => {
    const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8")
    const agents = read("AGENTS.md")
    expect(read("adapters/claude-code/rules/AGENTS.md")).toBe(agents)
    expect(read("adapters/antigravity/plugins/effect-harness/rules/AGENTS.md")).toBe(agents)
    const toks = ["pnpm harness workflow ship", "workflow complete --phase llm", "ShipWorkflow"]
    for (const t of toks) expect(agents).toContain(t)
    for (const d of [pluginDir, resolve(repoRoot, "adapters/claude-code")]) {
      for (const f of ["effect-lfg/SKILL.md", "effect-lfg/references/review-and-shipping.md"])
        for (const t of toks) expect(readFileSync(resolve(d, "skills", f), "utf8")).toContain(t)
      for (const p of ["README.md", "skills/effect-harness/SKILL.md"]) {
        const s = readFileSync(resolve(d, p), "utf8")
        expect(s).toContain("start|resume|ship|abort|doctor|complete --phase llm")
        expect(s).not.toContain("start|resume|abort|doctor|complete --phase llm")
      }
    }
  })
})
