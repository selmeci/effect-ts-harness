import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import {
  evaluateDocTruthPlugin,
  GATE_RULE_SOURCE_FILES,
} from "../src/plugins/gc/gc-doc-truth.plugin.js"
import { evaluatePackageAndMigrationPlugin } from "../src/plugins/gc/gc-package-and-migration.plugin.js"
import { checkChainedEqualityTernaries } from "../src/plugins/gc/gc-topology-entropy.plugin.js"
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

  it("[Ears-P1.4] emits stale-gate-rule-version when any of the 5 gate rule files changes without updating EXPECTED_GATE_RULE_VERSION_DIGEST", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    const tempDir = mkdtempSync(join(tmpdir(), "harness-doc-truth-digest-"))
    try {
      for (const rel of GATE_RULE_SOURCE_FILES) {
        const dest = join(tempDir, rel)
        mkdirSync(dirname(dest), { recursive: true })
        const content = readFileSync(join(repoRoot, rel), "utf8")
        const updated =
          rel === "tools/oxlint/syntax-bans.js"
            ? `${content}\n// synthetic visitor edit\n`
            : content
        writeFileSync(dest, updated)
      }
      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tempDir,
        hostIo: testHostIo,
      })
      expect(findings.some((f) => f.kind === "stale-gate-rule-version")).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
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

  it("F-14.1: emits hook-bootstrap-fail-closed when guard/done hooks lack || exit 2 or antigravity decision JSON fallback", () => {
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

      // Fail-open decisions ("allow" on guard, "stop" on done) must also be rejected
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
})
