import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { CANONICAL_CLI_COMMAND_NAMES, CANONICAL_MCP_TOOL_NAMES } from "@harness/contract"
import { buildHarnessGraph } from "@harness/graph"
import { AST_GATE_RULE_SOURCE_FILES } from "../src/ast-cache.js"
import {
  ADAPTER_SKILL_PARITY_CLAUSES,
  auditAdapterSkillParityPair,
  auditCatalogDocTruthInContent,
  evaluateDocTruthPlugin,
} from "../src/plugins/gc/gc-doc-truth.plugin.js"
import { extractMarkdownSubsection } from "../src/plugins/gc/gc-adapter-skill-parity.js"
import { evaluatePackageAndMigrationPlugin } from "../src/plugins/gc/gc-package-and-migration.plugin.js"
import {
  checkAstGateRuleClosure,
  extractGateRuleIdsFromSources,
} from "../src/plugins/gc/gc-rule-ids.js"
import { checkChainedEqualityTernaries } from "../src/plugins/gc/gc-topology-entropy.plugin.js"
import { type GcFinding } from "../src/plugins/gc/gc-workspace-io.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("evaluateDocTruthPlugin (SPEC / S-4.4)", () => {
  it("[Ears-P1.4] evaluateDocTruthPlugin returns 0 findings on the real repository", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    const findings = evaluateDocTruthPlugin({
      graph: buildHarnessGraph({}),
      workspaceRoot: repoRoot,
      hostIo: testHostIo,
    })
    expect(findings).toEqual([])
  })

  it("[Ears-P1.4] emits hook-timeout-parity when Stop is missing or lacks a positive timeout in antigravity or claude-code hooks.json", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-hooks-"))
    try {
      const antigravityHooksPath = join(
        tempDir,
        "adapters/antigravity/plugins/effect-harness/hooks.json",
      )
      mkdirSync(dirname(antigravityHooksPath), { recursive: true })
      writeFileSync(
        antigravityHooksPath,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [{ type: "command", timeout: 15 }],
            Stop: [{ type: "command" }],
          },
        }),
      )

      const claudeHooksPath = join(tempDir, "adapters/claude-code/hooks.json")
      mkdirSync(dirname(claudeHooksPath), { recursive: true })
      writeFileSync(
        claudeHooksPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", timeout: 15 }] }],
          },
        }),
      )

      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) =>
            f.kind === "hook-timeout-parity" &&
            f.location === "adapters/antigravity/plugins/effect-harness/hooks.json",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "hook-timeout-parity" && f.nodeId === "adapters/claude-code/hooks.json:Stop",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("[Ears-P1.4] emits doc-unknown-rule-id when a markdown Rule ID table cites an unknown rule like no-drizzle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-rule-table-"))
    try {
      writeFileSync(
        join(tempDir, "README.md"),
        [
          "# Rules",
          "",
          "| Rule ID | Enforced Invariant |",
          "| :--- | :--- |",
          "| `no-drizzle` | Drizzle is banned |",
          "",
        ].join("\n"),
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) => f.kind === "doc-unknown-rule-id" && f.nodeId === "README.md:no-drizzle",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("F-5.1: emits skill-tier-table-drift when adapters/**/SKILL.md tier table allows forbidden tier imports", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-skill-tier-"))
    try {
      const skillPath = join(tempDir, "adapters/claude-code/skills/sample/SKILL.md")
      mkdirSync(dirname(skillPath), { recursive: true })
      writeFileSync(
        skillPath,
        [
          "# Sample Skill",
          "",
          "| Tier | May Import | Forbidden |",
          "| :--- | :--- | :--- |",
          "| `type:service` | `type:contract`, `type:domain` | `type:infra` |",
          "| `type:contract` | `effect` | `type:service` |",
          "",
          "| Tag | Purpose | Allowed Imports |",
          "| :--- | :--- | :--- |",
          "| `type:core` | Pure engines | `contract`, `service` (NEVER `domain`; forbidden: `infra`, `app`) |",
          "| `scope:web` | Frontend UI | `contract`, `domain` |",
          "| `type:infra` | Live adapters | `contract`, `app` |",
          "",
        ].join("\n"),
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) =>
            f.kind === "skill-tier-table-drift" &&
            f.nodeId === "adapters/claude-code/skills/sample/SKILL.md:type:service",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "skill-tier-table-drift" &&
            f.nodeId === "adapters/claude-code/skills/sample/SKILL.md:type:core",
        ),
      ).toBe(false)
      expect(
        findings.some(
          (f) =>
            f.kind === "skill-tier-table-drift" &&
            f.nodeId === "adapters/claude-code/skills/sample/SKILL.md:scope:web",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "skill-tier-table-drift" &&
            f.nodeId === "adapters/claude-code/skills/sample/SKILL.md:type:infra",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("F-5.3: emits mermaid-dependency-drift when Mermaid flowchart edge contradicts package.json dependencies", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-mermaid-"))
    try {
      const svcPkg = join(tempDir, "libs/harness/service/package.json")
      const infraPkg = join(tempDir, "libs/harness/infra/package.json")
      mkdirSync(dirname(svcPkg), { recursive: true })
      mkdirSync(dirname(infraPkg), { recursive: true })
      writeFileSync(
        svcPkg,
        JSON.stringify({ name: "@harness/service", dependencies: { effect: "4.0.0" } }),
      )
      writeFileSync(
        infraPkg,
        JSON.stringify({
          name: "@harness/infra",
          dependencies: { "@harness/service": "workspace:*" },
        }),
      )
      writeFileSync(
        join(tempDir, "README.md"),
        [
          "# Architecture",
          "",
          "```mermaid",
          "flowchart TD",
          '  SVC["@harness/service"]',
          '  INFRA["@harness/infra"]',
          "  SVC --> INFRA",
          "```",
          "",
          "```mermaid",
          "graph TD",
          '  S["libs/harness/service"]',
          '  I["libs/harness/infra"]',
          "  S --> I;",
          "```",
          "",
        ].join("\n"),
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.filter(
          (f) =>
            f.kind === "mermaid-dependency-drift" &&
            f.nodeId === "README.md:@harness/service->@harness/infra",
        ),
      ).toHaveLength(2)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("F-14.1: emits hook-bootstrap-fail-closed when guard/done hooks lack || exit 2 or use fail-open antigravity fallback", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-bootstrap-"))
    try {
      const claudeHooks = join(tempDir, "adapters/claude-code/hooks.json")
      const agyHooks = join(tempDir, "adapters/antigravity/plugins/effect-harness/hooks.json")
      mkdirSync(dirname(claudeHooks), { recursive: true })
      mkdirSync(dirname(agyHooks), { recursive: true })
      writeFileSync(
        claudeHooks,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard",
                    timeout: 15,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done || exit 2",
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
      )
      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [
              {
                type: "command",
                command: "node apps/harness-cli/src/index.ts guard --format=antigravity || exit 2",
                timeout: 15,
              },
            ],
            Stop: [
              {
                type: "command",
                command:
                  'node apps/harness-cli/src/index.ts done --format=antigravity || { printf \'{"decision":"continue"}\'; exit 2; }',
                timeout: 30,
              },
            ],
          },
        }),
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/claude-code/hooks.json:PreToolUse",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/claude-code/hooks.json:Stop",
        ),
      ).toBe(false)

      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [
              {
                type: "command",
                command:
                  'node apps/harness-cli/src/index.ts guard --format=antigravity || { printf \'{"decision":"allow"}\'; exit 2; }',
                timeout: 15,
              },
            ],
            Stop: [
              {
                type: "command",
                command:
                  'node apps/harness-cli/src/index.ts done --format=antigravity || { printf \'{"decision":"stop"}\'; exit 2; }',
                timeout: 30,
              },
            ],
          },
        }),
      )
      const failOpenFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        failOpenFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse",
        ),
      ).toBe(true)
      expect(
        failOpenFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:Stop",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("F-14.1: enforces fail-closed fallback on hook-entry.ts and flag-before-subcommand forms, plus Claude terminology isolation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-hookentry-"))
    try {
      const claudeHooks = join(tempDir, "adapters/claude-code/hooks.json")
      const agyHooks = join(tempDir, "adapters/antigravity/plugins/effect-harness/hooks.json")
      mkdirSync(dirname(claudeHooks), { recursive: true })
      mkdirSync(dirname(agyHooks), { recursive: true })
      writeFileSync(
        claudeHooks,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard",
                    timeout: 15,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts done || exit 2",
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
      )
      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [
              {
                type: "command",
                command:
                  "node apps/harness-cli/src/hook-entry.ts guard --format=antigravity || exit 2",
                timeout: 15,
              },
            ],
            Stop: [
              {
                type: "command",
                command:
                  'node apps/harness-cli/src/hook-entry.ts done --format=antigravity || { printf \'{"decision":"continue"}\'; exit 2; }',
                timeout: 30,
              },
            ],
          },
        }),
      )
      const hookEntryFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        hookEntryFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/claude-code/hooks.json:PreToolUse",
        ),
      ).toBe(true)
      expect(
        hookEntryFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse",
        ),
      ).toBe(true)
      expect(
        hookEntryFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:Stop",
        ),
      ).toBe(false)

      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [
              {
                type: "command",
                command:
                  "node apps/harness-cli/src/hook-entry.ts --format=antigravity guard || exit 2",
                timeout: 15,
              },
            ],
            Stop: [
              {
                type: "command",
                command:
                  'node apps/harness-cli/src/hook-entry.ts --format=antigravity done || { printf \'{"decision":"continue"}\'; exit 2; }',
                timeout: 30,
              },
            ],
          },
        }),
      )
      const flagBeforeSubFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        flagBeforeSubFindings.some(
          (f) =>
            f.kind === "hook-bootstrap-fail-closed" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse",
        ),
      ).toBe(true)

      const claudeReviewSkill = join(
        tempDir,
        "adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md",
      )
      mkdirSync(dirname(claudeReviewSkill), { recursive: true })
      writeFileSync(
        claudeReviewSkill,
        "# Review Feedback\nDispatch fixes to warm swarm workers in parallel.\n",
      )
      const claudeLeakFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        claudeLeakFindings.some(
          (f) =>
            f.kind === "doc-banned-or-phantom-tech" &&
            f.nodeId ===
              "adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md:claude-antigravity-terminology",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("F-20.1: emits doc-banned-or-phantom-tech for unnegated oxc-parser/sqlite-vec/FTS5 or un-superseded Drizzle mentions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-phantom-"))
    try {
      mkdirSync(join(tempDir, "docs"), { recursive: true })
      writeFileSync(join(tempDir, "README.md"), "# Stack\nWe use oxc-parser for ASTs.\n")
      writeFileSync(join(tempDir, "docs/guide.md"), "# DB\nUse drizzle-orm for D1.\n")
      writeFileSync(
        join(tempDir, "docs/superseded.md"),
        "# DB\ndrizzle-orm is banned (ADR-0008).\n",
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) => f.kind === "doc-banned-or-phantom-tech" && f.nodeId === "README.md:oxc-parser",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) => f.kind === "doc-banned-or-phantom-tech" && f.nodeId === "docs/guide.md:drizzle",
        ),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "doc-banned-or-phantom-tech" && f.nodeId === "docs/superseded.md:drizzle",
        ),
      ).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('PR-32: emits doc-banned-or-phantom-tech for Layer.scoped, Schema.TaggedErrorClass, and Claude Code model: "flash", and emits contract-test-effect-vitest-import for @effect/vitest in type:contract tests', () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-pr32-"))
    try {
      mkdirSync(join(tempDir, "agent-patterns"), { recursive: true })
      mkdirSync(
        join(tempDir, "adapters/claude-code/skills/resolving-effect-review-feedback/references"),
        { recursive: true },
      )
      writeFileSync(
        join(tempDir, "agent-patterns/services-and-layers.md"),
        "# Layers\nexport const PoolLive = Layer.scoped(Pool, Effect.void)\n",
      )
      writeFileSync(
        join(tempDir, "agent-patterns/errors.md"),
        "# Errors\n> Schema.TaggedErrorClass was removed in Effect v4.\nexport class Bad extends Schema.TaggedErrorClass {}\n",
      )
      writeFileSync(
        join(
          tempDir,
          "adapters/claude-code/skills/resolving-effect-review-feedback/references/effect-fixer-prompt.md",
        ),
        '# Fixer\nDispatch via Agent tool with model: "flash".\n',
      )

      const docFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        docFindings.some(
          (f) =>
            f.kind === "doc-banned-or-phantom-tech" &&
            f.nodeId === "agent-patterns/services-and-layers.md:Layer.scoped",
        ),
      ).toBe(true)
      expect(
        docFindings.some(
          (f) =>
            f.kind === "doc-banned-or-phantom-tech" &&
            f.nodeId === "agent-patterns/errors.md:Schema.TaggedErrorClass",
        ),
      ).toBe(true)
      expect(
        docFindings.some(
          (f) =>
            f.kind === "doc-banned-or-phantom-tech" &&
            f.nodeId ===
              "adapters/claude-code/skills/resolving-effect-review-feedback/references/effect-fixer-prompt.md:claude-agent-model-flash",
        ),
      ).toBe(true)

      const contractTestDir = join(tempDir, "libs/sample/contract/test")
      const contractSrcDir = join(tempDir, "libs/sample/contract/src")
      mkdirSync(contractTestDir, { recursive: true })
      mkdirSync(contractSrcDir, { recursive: true })
      writeFileSync(
        join(tempDir, "libs/sample/contract/package.json"),
        JSON.stringify({
          name: "@harness/sample-contract",
          dependencies: { effect: "4.0.0" },
          nx: { tags: ["type:contract"] },
        }),
      )
      writeFileSync(join(contractSrcDir, "index.ts"), "export const X = 1\n")
      writeFileSync(
        join(contractTestDir, "index.test.ts"),
        'import { describe, expect, it } from "@effect/vitest"\ndescribe("x", () => { it("y", () => { expect(1).toBe(1) }) })\n',
      )

      const pkgFindings = Effect.runSync(
        evaluatePackageAndMigrationPlugin({
          graph: buildHarnessGraph({}),
          workspaceRoot: tempDir,
          hostIo: testHostIo,
        }),
      )
      expect(
        pkgFindings.some(
          (f) =>
            f.kind === "contract-test-effect-vitest-import" &&
            f.nodeId === "libs/sample/contract/test/index.test.ts:@effect/vitest",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("checkChainedEqualityTernaries: detects direct, parenthesized, reversed, ||/&&-compound, trivia-evaded, and !=/whenTrue chains while ignoring distinct targets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-chained-ternary-"))
    try {
      const srcDir = join(tempDir, "libs/sample/domain/src")
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(
        join(srcDir, "cases.ts"),
        [
          'export const direct = (x: string) => (x === "a" ? 1 : x === "b" ? 2 : 3)',
          'export const paren = (x: string) => ((x === "a") ? 1 : ((x === "b") ? 2 : 3))',
          'export const reversed = (x: string) => ("a" === x ? 1 : "b" === x ? 2 : 3)',
          'export const compound = (x: string) => (x === "a" || x === "b" ? 1 : x === "c" ? 2 : 3)',
          'export const trivia = (a: { b: string }) => (a /* comment */ . b === "x" ? 1 : a.b === "y" ? 2 : 3)',
          'export const negated = (x: string) => (x !== "a" ? (x !== "b" ? 3 : 2) : 1)',
          'export const mixedNeg = (x: string) => (x === "a" ? 1 : x !== "b" ? 3 : 2)',
          "export const distinct = (a: number, b: number) => (a === 1 ? 10 : b === 2 ? 20 : 30)",
        ].join("\n"),
      )

      const findings = checkChainedEqualityTernaries(tempDir, testHostIo)
      expect(findings).toHaveLength(7)
      expect(findings.every((f) => f.kind === "chained-equality-ternary")).toBe(true)
      expect(findings.map((f) => f.location)).toEqual([
        "libs/sample/domain/src/cases.ts:1",
        "libs/sample/domain/src/cases.ts:2",
        "libs/sample/domain/src/cases.ts:3",
        "libs/sample/domain/src/cases.ts:4",
        "libs/sample/domain/src/cases.ts:5",
        "libs/sample/domain/src/cases.ts:6",
        "libs/sample/domain/src/cases.ts:7",
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("extractGateRuleIdsFromSources extracts GcFindingKind literals from gcWorkspaceIoSource and sorts via compareCodeUnits without unknown-rule false positives", () => {
    const gcWorkspaceIoSample = [
      "export const GcFindingKind = Schema.Literals([",
      '  "z-gc-finding",',
      '  "a-gc-finding",',
      '  "unused-service",',
      "])",
    ].join("\n")

    const ids = extractGateRuleIdsFromSources(
      'pushViolation(acc, "zeta-ast-rule")\nGateRuleId.make("alpha-ast-rule")',
      'SelfDogfoodingRuleId.make("beta-dogfood-rule")',
      'TierTopologyRuleId.make("gamma-tier-rule")',
      '"[delta-oxlint-rule] msg"',
      gcWorkspaceIoSample,
    )

    expect(ids).toEqual([
      "a-gc-finding",
      "alpha-ast-rule",
      "beta-dogfood-rule",
      "delta-oxlint-rule",
      "gamma-tier-rule",
      "unused-service",
      "z-gc-finding",
      "zeta-ast-rule",
    ])

    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-gc-finding-id-"))
    try {
      const astVisitorsDir = join(tempDir, "libs/harness/gates/src/plugins/gc")
      mkdirSync(astVisitorsDir, { recursive: true })
      writeFileSync(
        join(astVisitorsDir, "gc-workspace-io.ts"),
        'export const GcFindingKind = Schema.Literals(["custom-gc-finding"])\n',
      )
      writeFileSync(
        join(tempDir, "README.md"),
        [
          "# GC Rules",
          "",
          "| Rule ID | Meaning |",
          "| :--- | :--- |",
          "| `custom-gc-finding` | Recognized from GcFindingKind |",
          "",
        ].join("\n"),
      )
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(findings.some((f) => f.kind === "doc-unknown-rule-id")).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("checkAstGateRuleClosure verifies every AST_GATE_RULE_SOURCE_FILES entry exists and catches missing or unlisted runtime imports", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    expect(
      AST_GATE_RULE_SOURCE_FILES.every((rel) => testHostIo.existsSync(join(repoRoot, rel))),
    ).toBe(true)

    const realFindings: Array<GcFinding> = []
    checkAstGateRuleClosure(repoRoot, testHostIo, realFindings)
    expect(realFindings).toEqual([])

    const secondRel = AST_GATE_RULE_SOURCE_FILES[1]
    if (secondRel === undefined) {
      throw new Error("Expected at least 2 AST_GATE_RULE_SOURCE_FILES entries")
    }

    const tempDir = mkdtempSync(join(tmpdir(), "harness-ast-closure-"))
    try {
      for (const rel of AST_GATE_RULE_SOURCE_FILES) {
        if (rel === secondRel) continue
        const abs = join(tempDir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, "export const ok = true\n", "utf8")
      }
      const missingFindings: Array<GcFinding> = []
      checkAstGateRuleClosure(tempDir, testHostIo, missingFindings)
      expect(
        missingFindings.some(
          (f) => f.kind === "architecture-policy-violation" && f.location === secondRel,
        ),
      ).toBe(true)

      const secondAbs = join(tempDir, secondRel)
      mkdirSync(dirname(secondAbs), { recursive: true })
      writeFileSync(secondAbs, "export const ok = true\n", "utf8")

      const typeOnlyAbs = join(tempDir, "libs/harness/gates/src/type-only-helper.ts")
      writeFileSync(typeOnlyAbs, "export type HelperType = string\n", "utf8")
      const unlistedRuntimeAbs = join(tempDir, "libs/harness/gates/src/unlisted-runtime-helper.ts")
      writeFileSync(unlistedRuntimeAbs, "export const helperFn = () => 1\n", "utf8")

      const astCacheAbs = join(tempDir, "libs/harness/gates/src/ast-cache.ts")
      writeFileSync(
        astCacheAbs,
        [
          'import type { HelperType } from "./type-only-helper.js"',
          'import { helperFn } from "./unlisted-runtime-helper.js"',
          "export const runHelper = (): HelperType => String(helperFn())",
          "",
        ].join("\n"),
        "utf8",
      )

      const closureFindings: Array<GcFinding> = []
      checkAstGateRuleClosure(tempDir, testHostIo, closureFindings)
      expect(closureFindings.map((f) => f.location)).toEqual([
        "libs/harness/gates/src/unlisted-runtime-helper.ts",
      ])
      expect(closureFindings[0]?.kind).toBe("architecture-policy-violation")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("SPEC-0029 REQ-1.1/REQ-1.2: validates MCP tool counts, unknown harness_* backticks, mermaid blocks, and headings", () => {
    const validCount = CANONICAL_MCP_TOOL_NAMES.length
    const validDoc = [
      "### 8.4 MCP Tools",
      "```mermaid",
      `flowchart LR\n  MCP["harness-mcp (${validCount} tools)"]`,
      "```",
      `Exposes ${validCount} MCP tools including \`${CANONICAL_MCP_TOOL_NAMES[0]}\`.`,
      "```ts",
      "// inside code fence: 99 MCP tools and `harness_fake_in_code` are ignored",
      "```",
      "",
    ].join("\n")
    expect(auditCatalogDocTruthInContent("README.md", validDoc)).toEqual([])

    const wrongCount = validCount - 1
    const driftedDoc = [
      "```mermaid",
      `MCP["harness-mcp (${wrongCount} MCP tools)"]`,
      "```",
      `harness-mcp exposes ${wrongCount} tools and \`harness_nonexistent_tool\` twice \`harness_nonexistent_tool\`.`,
      "```ts",
      "`harness_ignored_inside_ts`",
      "```",
      `Trailing ${wrongCount} MCP tools after closed fence.`,
    ].join("\n")
    const findings = auditCatalogDocTruthInContent("README.md", driftedDoc)
    expect(findings.every((f) => f.kind === "doc-mcp-tool-count-truth")).toBe(true)
    expect(findings.filter((f) => f.nodeId.includes(":mcp-count:"))).toHaveLength(3)
    expect(findings.some((f) => f.location === "README.md:2")).toBe(true)
    expect(findings.some((f) => f.location === "README.md:8")).toBe(true)
    expect(
      findings.filter((f) => f.nodeId === "README.md:mcp:harness_nonexistent_tool"),
    ).toHaveLength(1)
    expect(findings.some((f) => f.nodeId.includes("harness_ignored_inside_ts"))).toBe(false)
  })

  it("SPEC-0029 REQ-2.1/REQ-2.2: validates CLI subcommands in prose and bash fences plus CLI counts", () => {
    const validCount = CANONICAL_CLI_COMMAND_NAMES.length
    const validDoc = [
      `Uses ${validCount} CLI commands on harness-cli:`,
      "```bash",
      "pnpm harness verify",
      "pnpm harness <cmd>",
      "pnpm harness --help",
      "```",
    ].join("\n")
    expect(auditCatalogDocTruthInContent("README.md", validDoc)).toEqual([])

    const wrongCount = validCount - 2
    const driftedDoc = [
      `Uses ${wrongCount} CLI commands while harness-cli exposes ${wrongCount} subcommands.`,
      "```bash",
      "pnpm harness bogus-cmd",
      "```",
      "Repeat `pnpm harness bogus-cmd` and also `pnpm harness another-fake`.",
    ].join("\n")
    const findings = auditCatalogDocTruthInContent("AGENTS.md", driftedDoc)
    expect(findings.every((f) => f.kind === "doc-cli-command-truth")).toBe(true)
    expect(findings.filter((f) => f.nodeId.includes(":cli-count:"))).toHaveLength(1)
    expect(findings.filter((f) => f.nodeId === "AGENTS.md:cli:bogus-cmd")).toHaveLength(1)
    expect(findings.filter((f) => f.nodeId === "AGENTS.md:cli:another-fake")).toHaveLength(1)
  })

  it("SPEC-0029 REQ-1.1/REQ-2.1/REQ-4.2: scans live catalog docs, ignores docs/plans, and exempts draft specs from doc-missing-file-path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-catalog-draft-"))
    try {
      mkdirSync(join(tempDir, "libs/harness/docs/specs"), { recursive: true })
      mkdirSync(join(tempDir, "adapters/claude-code"), { recursive: true })
      mkdirSync(join(tempDir, "docs/plans"), { recursive: true })
      writeFileSync(
        join(tempDir, "README.md"),
        "Using `harness_bogus_mcp` and `pnpm harness unknown-subcmd`.\n",
      )
      writeFileSync(
        join(tempDir, "adapters/claude-code/README.md"),
        "Exposes `harness_other_fake` tool.\n",
      )
      writeFileSync(
        join(tempDir, "docs/plans/historical.md"),
        "Historical 17 MCP tools and `harness_historical_tool` and pnpm harness old-cmd.\n",
      )
      writeFileSync(
        join(tempDir, "libs/harness/docs/specs/2026-11-22-draft-future.md"),
        "---\nid: harness:SPEC-9991\ntitle: Draft\nstatus: draft\nspans:\n  - Future.decide\n---\n\nSee `libs/harness/gates/src/nonexistent-draft-module.ts`.\n",
      )
      writeFileSync(
        join(tempDir, "libs/harness/docs/specs/2026-11-22-proposed-missing.md"),
        "---\nid: harness:SPEC-9992\ntitle: Proposed\nstatus: proposed\nspans:\n  - Future.decide\n---\n\nSee `libs/harness/gates/src/nonexistent-proposed-module.ts`.\n",
      )

      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some((f) => f.kind === "doc-mcp-tool-count-truth" && f.location === "README.md:1"),
      ).toBe(true)
      expect(
        findings.some(
          (f) =>
            f.kind === "doc-mcp-tool-count-truth" &&
            f.location === "adapters/claude-code/README.md:1",
        ),
      ).toBe(true)
      expect(findings.some((f) => f.kind === "doc-cli-command-truth")).toBe(true)
      expect(findings.some((f) => f.location?.startsWith("docs/plans/historical.md"))).toBe(false)
      expect(
        findings.some(
          (f) =>
            f.kind === "doc-missing-file-path" &&
            f.location === "libs/harness/docs/specs/2026-11-22-draft-future.md",
        ),
      ).toBe(false)
      expect(
        findings.some(
          (f) =>
            f.kind === "doc-missing-file-path" &&
            f.location === "libs/harness/docs/specs/2026-11-22-proposed-missing.md",
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it.effect.prop(
    "SPEC-0029 property: wrong MCP/CLI counts and fabricated catalog names always emit exact findings",
    {
      delta: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })),
      suffix: Schema.Literals(["alpha", "beta", "gamma"]),
    },
    ({ delta, suffix }) =>
      Effect.sync(() => {
        const badMcpCount = CANONICAL_MCP_TOOL_NAMES.length + delta
        const badCliCount = CANONICAL_CLI_COMMAND_NAMES.length + delta
        const doc = [
          `Exposes ${badMcpCount} MCP tools (\`harness_fake_${suffix}\`).`,
          `Runs ${badCliCount} CLI commands (\`pnpm harness fake-${suffix}\`).`,
        ].join("\n")
        const findings = auditCatalogDocTruthInContent("README.md", doc)
        expect(findings.some((f) => f.kind === "doc-mcp-tool-count-truth")).toBe(true)
        expect(findings.some((f) => f.kind === "doc-cli-command-truth")).toBe(true)
      }),
  )

  it("SPEC-0030 REQ-2.2: auditAdapterSkillParityPair validates symmetric headings, required tokens, and cross-adapter equality", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    for (const clause of ADAPTER_SKILL_PARITY_CLAUSES) {
      const agy = testHostIo.readTextSync(
        join(
          repoRoot,
          `adapters/antigravity/plugins/effect-harness/skills/${clause.skillName}/SKILL.md`,
        ),
      )
      const claude = testHostIo.readTextSync(
        join(repoRoot, `adapters/claude-code/skills/${clause.skillName}/SKILL.md`),
      )
      expect(auditAdapterSkillParityPair(clause, agy, claude)).toEqual([])
      expect(extractMarkdownSubsection(agy, clause.heading)).toBeDefined()
    }
    expect(extractMarkdownSubsection("### Heading\nBody", "### Heading")).toBe("### Heading\nBody")

    const seamClause = ADAPTER_SKILL_PARITY_CLAUSES[0]!
    const validDoc = [
      "## Overview",
      seamClause.heading,
      seamClause.requiredMarkers.join(" "),
      "---",
      "### After",
    ].join("\n")

    expect(
      auditAdapterSkillParityPair(seamClause, "No heading\n", validDoc).map((f) => f.nodeId),
    ).toEqual([
      `adapters/antigravity/plugins/effect-harness/skills/${seamClause.skillName}/SKILL.md:missing-heading`,
    ])
    expect(
      auditAdapterSkillParityPair(seamClause, validDoc, "No heading\n").map((f) => f.nodeId),
    ).toEqual([`adapters/claude-code/skills/${seamClause.skillName}/SKILL.md:missing-heading`])

    const missingMarkerDoc = `${seamClause.heading}\nIncomplete text\n`
    const agyMissing = auditAdapterSkillParityPair(seamClause, missingMarkerDoc, validDoc)
    expect(
      agyMissing.some((f) => f.kind === "adapter-skill-parity" && f.nodeId.includes(":missing:")),
    ).toBe(true)
    const claudeMissing = auditAdapterSkillParityPair(seamClause, validDoc, missingMarkerDoc)
    expect(
      claudeMissing.some(
        (f) => f.kind === "adapter-skill-parity" && f.nodeId.includes(":missing:"),
      ),
    ).toBe(true)

    const driftedDoc = `${validDoc.replace("---", "\nExtra drifted note\n---")}`
    const driftFindings = auditAdapterSkillParityPair(seamClause, validDoc, driftedDoc)
    expect(driftFindings).toEqual([
      expect.objectContaining({
        kind: "adapter-skill-parity",
        nodeId: `adapter-skill-parity:${seamClause.skillName}`,
      }),
    ])
  })

  it("SPEC-0030 REQ-2.2: evaluateDocTruthPlugin detects missing adapter skill counterparts and skips unrelated repos", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-adapter-skill-parity-"))
    try {
      const agySkill = join(
        tempDir,
        "adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md",
      )
      mkdirSync(dirname(agySkill), { recursive: true })
      writeFileSync(agySkill, "### Swarm Seam Checklist (Pre-Review)\nWORKFLOW_TIMEOUT_BUDGETS\n")

      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        findings.some(
          (f) =>
            f.kind === "adapter-skill-parity" &&
            f.nodeId === "adapters/claude-code/skills/effect-lfg/SKILL.md:missing-counterpart",
        ),
      ).toBe(true)

      const claudeOnlySkill = join(
        tempDir,
        "adapters/claude-code/skills/effect-code-review/SKILL.md",
      )
      mkdirSync(dirname(claudeOnlySkill), { recursive: true })
      writeFileSync(
        claudeOnlySkill,
        "### Mandatory Second-Pass Remediation Re-Audit\nremediationContext\n",
      )
      const secondFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        secondFindings.some(
          (f) =>
            f.kind === "adapter-skill-parity" &&
            f.nodeId ===
              "adapters/antigravity/plugins/effect-harness/skills/effect-code-review/SKILL.md:missing-counterpart",
        ),
      ).toBe(true)

      const agyExec = join(
        tempDir,
        "adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/SKILL.md",
      )
      const claudeExec = join(
        tempDir,
        "adapters/claude-code/skills/executing-effect-stubs/SKILL.md",
      )
      mkdirSync(dirname(agyExec), { recursive: true })
      mkdirSync(dirname(claudeExec), { recursive: true })
      writeFileSync(agyExec, "### Swarm Seam Checklist (Pre-Review)\nWORKFLOW_TIMEOUT_BUDGETS\n")
      writeFileSync(claudeExec, "### Swarm Seam Checklist (Pre-Review)\nWORKFLOW_TIMEOUT_BUDGETS\n")
      const readablePairFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(
        readablePairFindings.some(
          (f) =>
            f.kind === "adapter-skill-parity" &&
            f.location === "adapters/claude-code/skills/executing-effect-stubs/SKILL.md",
        ),
      ).toBe(true)
      const failClaudeReadIo = {
        ...testHostIo,
        readTextSync: (target: string): string => {
          if (target.endsWith("claude-code/skills/executing-effect-stubs/SKILL.md")) {
            throw new Error("EACCES: permission denied")
          }
          return testHostIo.readTextSync(target)
        },
      }
      const unreadableFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: failClaudeReadIo,
      })
      expect(unreadableFindings.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
