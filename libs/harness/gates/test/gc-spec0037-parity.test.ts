import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { WORKFLOW_TIMEOUT_BUDGETS } from "@harness/contract"
import { buildHarnessGraph } from "@harness/graph"
import {
  ADAPTER_SKILL_PARITY_CLAUSES,
  auditAdapterSkillParityPair,
  evaluateDocTruthPlugin,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("SPEC-0037 REQ-2.4 & REQ-6.1..REQ-6.4: Hook Timeout Parity & Skill Loop Parity", () => {
  it("REQ-2.4 enforces PreToolUse command hook timeout strictly > WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-hook-budget-parity-"))
    try {
      const claudeHooks = join(tmpDir, "adapters/claude-code/hooks.json")
      const agyHooks = join(tmpDir, "adapters/antigravity/plugins/effect-harness/hooks.json")
      mkdirSync(dirname(claudeHooks), { recursive: true })
      mkdirSync(dirname(agyHooks), { recursive: true })

      writeFileSync(
        claudeHooks,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo ok", timeout: 5 }],
              },
            ],
            Stop: [{ hooks: [{ type: "command", command: "echo ok", timeout: 30 }] }],
          },
        }),
      )
      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            PreToolUse: [
              {
                matcher: "run_command",
                hooks: [{ type: "command", command: "echo ok", timeout: 6 }],
              },
            ],
            Stop: [{ type: "command", command: "echo ok", timeout: 30 }],
          },
        }),
      )

      const findings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tmpDir,
        hostIo: testHostIo,
      })
      const claudeTimeoutFinding = findings.find(
        (f) =>
          f.kind === "hook-timeout-parity" &&
          f.nodeId === "adapters/claude-code/hooks.json:PreToolUse:decision-model-budget",
      )
      expect(claudeTimeoutFinding).toBeDefined()
      expect(claudeTimeoutFinding?.message).toContain(
        String(WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs),
      )

      const agyTimeoutFinding = findings.find(
        (f) =>
          f.kind === "hook-timeout-parity" &&
          f.nodeId ===
            "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse:decision-model-budget",
      )
      expect(agyTimeoutFinding).toBeUndefined()

      writeFileSync(
        claudeHooks,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo ok" }] }],
          },
        }),
      )
      writeFileSync(
        agyHooks,
        JSON.stringify({
          "effect-harness": {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "echo ok", timeout: 0 },
                  { type: "command", command: "echo ok", timeout: 1 },
                ],
              },
            ],
          },
        }),
      )
      const zeroOrMissingFindings = evaluateDocTruthPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tmpDir,
        hostIo: testHostIo,
      })
      expect(
        zeroOrMissingFindings.filter(
          (f) =>
            f.kind === "hook-timeout-parity" && f.nodeId === "adapters/claude-code/hooks.json:Stop",
        ),
      ).toHaveLength(1)
      expect(
        zeroOrMissingFindings.filter(
          (f) =>
            f.kind === "hook-timeout-parity" &&
            f.nodeId === "adapters/antigravity/plugins/effect-harness/hooks.json:Stop",
        ),
      ).toHaveLength(1)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("REQ-6.1..REQ-6.4 enforces Review Loop Efficiency & Ceiling Headroom Discipline parity across Antigravity and Claude Code", () => {
    const clause = ADAPTER_SKILL_PARITY_CLAUSES.find(
      (c) =>
        c.skillName === "resolving-effect-review-feedback" &&
        c.heading === "### Review Loop Efficiency & Ceiling Headroom Discipline",
    )
    expect(clause).toBeDefined()
    expect(clause?.requiredMarkers).toEqual([
      "gc --strict",
      "second-pass specialist re-audit",
      "90%",
      "harness_ontology_check",
    ])

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    const repoFindings = evaluateDocTruthPlugin({
      graph: buildHarnessGraph({}),
      workspaceRoot: repoRoot,
      hostIo: testHostIo,
    })
    expect(repoFindings).toEqual([])

    const validSection = [
      "### Review Loop Efficiency & Ceiling Headroom Discipline",
      "- Run gc --strict after Phase 3.",
      "- Block mutate --strict before second-pass specialist re-audit completes.",
      "- Route files >= 90% of ceiling into companion modules.",
      "- Share one harness_ontology_check summary.",
    ].join("\n")

    expect(auditAdapterSkillParityPair(clause!, validSection, validSection)).toEqual([])
    expect(
      auditAdapterSkillParityPair(clause!, validSection, validSection.replace("90%", "85%")).some(
        (f) => f.kind === "adapter-skill-parity" && f.nodeId.includes(":missing:90%"),
      ),
    ).toBe(true)
    expect(
      auditAdapterSkillParityPair(clause!, validSection, validSection + "\n- extra line").some(
        (f) => f.kind === "adapter-skill-parity",
      ),
    ).toBe(true)
  })
})
