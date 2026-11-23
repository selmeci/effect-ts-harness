import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  checkHookMatcherToolParity,
  evaluateHookMatcherToolParity,
  type HookMatcherParityInput,
} from "../src/plugins/gc/gc-hook-parity.js"
import { type GcFinding } from "../src/plugins/gc/gc-workspace-io.js"
import { testHostIo } from "./helpers/test-host-io.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")

const loadLiveParityInput = (): HookMatcherParityInput => ({
  payloadSource: readFileSync(
    join(REPO_ROOT, "apps/harness-cli/src/commands/hook-guard-payload.ts"),
    "utf8",
  ),
  claudeHooksJson: readFileSync(join(REPO_ROOT, "adapters/claude-code/hooks.json"), "utf8"),
  antigravityHooksJson: readFileSync(
    join(REPO_ROOT, "adapters/antigravity/plugins/effect-harness/hooks.json"),
    "utf8",
  ),
  claudeReadme: readFileSync(join(REPO_ROOT, "adapters/claude-code/README.md"), "utf8"),
  antigravityReadme: readFileSync(
    join(REPO_ROOT, "adapters/antigravity/plugins/effect-harness/README.md"),
    "utf8",
  ),
})

const writeParityRepoFixture = (dir: string, input: HookMatcherParityInput): void => {
  const files: ReadonlyArray<readonly [string, string]> = [
    ["apps/harness-cli/src/commands/hook-guard-payload.ts", input.payloadSource],
    ["adapters/claude-code/hooks.json", input.claudeHooksJson],
    ["adapters/antigravity/plugins/effect-harness/hooks.json", input.antigravityHooksJson],
    ["adapters/claude-code/README.md", input.claudeReadme],
    ["adapters/antigravity/plugins/effect-harness/README.md", input.antigravityReadme],
  ]
  for (const [rel, body] of files) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, "utf8")
  }
}

describe("hook-matcher-tool-parity (SPEC-0025 REQ-1.1..REQ-1.3)", () => {
  it("passes with zero findings on live repository adapter configs and READMEs", () => {
    const findings: Array<GcFinding> = []
    checkHookMatcherToolParity(REPO_ROOT, testHostIo, findings)
    expect(findings).toEqual([])

    const directFindings = evaluateHookMatcherToolParity(loadLiveParityInput())
    expect(directFindings).toEqual([])
  })

  it("emits hook-matcher-tool-parity when any PreToolUse read, write, or command tool is omitted from hooks.json", () => {
    const base = loadLiveParityInput()
    const drifted = evaluateHookMatcherToolParity({
      ...base,
      antigravityHooksJson: base.antigravityHooksJson.replace("|read_file|", "|"),
      claudeHooksJson: base.claudeHooksJson.replace("|LS|", "|").replace('"Bash"', '"Noop"'),
    })
    const ids = drifted.map((f) => f.nodeId)
    expect(drifted.every((f) => f.kind === "hook-matcher-tool-parity")).toBe(true)
    expect(ids).toContain(
      "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse:read_file",
    )
    expect(ids).toContain("adapters/claude-code/hooks.json:PreToolUse:LS")
    expect(ids).toContain("adapters/claude-code/hooks.json:PreToolUse:Bash")
  })

  it("emits hook-matcher-tool-parity when PostToolUse matcher omits a write tool", () => {
    const base = loadLiveParityInput()
    const postRegex = /("PostToolUse":[\s\S]*?"matcher":\s*")([^"]+)(")/
    const drifted = evaluateHookMatcherToolParity({
      ...base,
      antigravityHooksJson: base.antigravityHooksJson.replace(postRegex, "$1edit_file$3"),
      claudeHooksJson: base.claudeHooksJson.replace(postRegex, "$1Edit|MultiEdit$3"),
    })
    const ids = drifted.map((f) => f.nodeId)
    expect(ids).toContain(
      "adapters/antigravity/plugins/effect-harness/hooks.json:PostToolUse:write_file",
    )
    expect(ids).toContain("adapters/claude-code/hooks.json:PostToolUse:Write")
  })

  it("fails closed on malformed hooks.json, missing container, invalid regex, or missing canonical arrays", () => {
    const base = loadLiveParityInput()
    const badJson = evaluateHookMatcherToolParity({
      ...base,
      claudeHooksJson: "{not-json",
      antigravityHooksJson: JSON.stringify({ other: {} }),
    })
    expect(badJson.map((f) => f.nodeId)).toEqual([
      "adapters/claude-code/hooks.json",
      "adapters/antigravity/plugins/effect-harness/hooks.json",
    ])

    const badRegex = evaluateHookMatcherToolParity({
      ...base,
      claudeHooksJson: base.claudeHooksJson.replace('"Bash"', '"[unclosed"'),
    })
    expect(
      badRegex.some(
        (f) =>
          f.kind === "hook-matcher-tool-parity" &&
          f.nodeId === "adapters/claude-code/hooks.json:PreToolUse:[unclosed",
      ),
    ).toBe(true)

    const missingConst = evaluateHookMatcherToolParity({
      ...base,
      payloadSource: base.payloadSource.replace(
        "export const ANTIGRAVITY_COMMAND_TOOL_NAMES",
        "export const OTHER_TOOL_NAMES",
      ),
    })
    expect(missingConst).toHaveLength(1)
    expect(missingConst[0]?.nodeId).toBe(
      "apps/harness-cli/src/commands/hook-guard-payload.ts:ANTIGRAVITY_COMMAND_TOOL_NAMES",
    )

    const wrongCmd = evaluateHookMatcherToolParity({
      ...base,
      claudeHooksJson: base.claudeHooksJson.replace(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard || exit 2",
        "echo noop",
      ),
      antigravityHooksJson: base.antigravityHooksJson.replace(
        "ingest --format=antigravity",
        "echo noop",
      ),
    })
    expect(wrongCmd.some((f) => f.nodeId.includes(":hook-command:"))).toBe(true)
    expect(
      wrongCmd.some(
        (f) =>
          f.nodeId.startsWith("adapters/claude-code/hooks.json:PreToolUse:") &&
          f.nodeId.includes(":hook-command:"),
      ),
    ).toBe(true)
    expect(
      wrongCmd.some(
        (f) =>
          f.nodeId.startsWith(
            "adapters/antigravity/plugins/effect-harness/hooks.json:PostToolUse:",
          ) && f.nodeId.includes(":hook-command:"),
      ),
    ).toBe(true)

    const nonCmdAndUnanchored = evaluateHookMatcherToolParity({
      ...base,
      claudeHooksJson: base.claudeHooksJson.replace(
        '"type": "command",\n            "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard || exit 2"',
        '"type": "prompt",\n            "command": "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard || exit 2"',
      ),
      antigravityHooksJson: base.antigravityHooksJson.replace(
        "apps/harness-cli/src/hook-entry.ts guard",
        "echo guard",
      ),
    })
    expect(
      nonCmdAndUnanchored.some(
        (f) =>
          f.nodeId.startsWith("adapters/claude-code/hooks.json:PreToolUse:") &&
          f.nodeId.includes(":hook-command:"),
      ),
    ).toBe(true)
    expect(
      nonCmdAndUnanchored.some(
        (f) =>
          f.nodeId.startsWith(
            "adapters/antigravity/plugins/effect-harness/hooks.json:PreToolUse:",
          ) && f.nodeId.includes(":hook-command:"),
      ),
    ).toBe(true)
  })

  it("detects adapter README PreToolUse / PostToolUse matcher and inline tool list drift", () => {
    const base = loadLiveParityInput()
    const drifted = evaluateHookMatcherToolParity({
      ...base,
      antigravityReadme: base.antigravityReadme
        .replace("`read_file`, ", "`phantom_tool`, ")
        .replace("`view_code_item`, ", ""),
      claudeReadme: base.claudeReadme
        .replace("Matcher `Read|Grep|Glob|LS|Find`", "Matcher `Read|Grep|Glob`")
        .replace(/3\. \*\*`PostToolUse`[\s\S]*?4\. \*\*`Stop`/, "4. **`Stop`"),
    })
    const ids = drifted.map((f) => f.nodeId)
    expect(ids).toContain(
      "adapters/antigravity/plugins/effect-harness/README.md:PreToolUse:tool:read_file",
    )
    expect(ids).toContain(
      "adapters/antigravity/plugins/effect-harness/README.md:PreToolUse:tool:view_code_item",
    )
    expect(ids).toContain(
      "adapters/antigravity/plugins/effect-harness/README.md:PreToolUse:extra-tool:phantom_tool",
    )
    expect(ids).toContain("adapters/claude-code/README.md:PreToolUse:matcher:Read|Grep|Glob")
    expect(ids).toContain(
      "adapters/claude-code/README.md:PreToolUse:missing-matcher:Read|Grep|Glob|LS|Find",
    )
    expect(ids).toContain("adapters/claude-code/README.md:PostToolUse")

    const missingMatcherDocs = evaluateHookMatcherToolParity({
      ...base,
      antigravityReadme: base.antigravityReadme.replace(
        "Intercepts tool calls (",
        "Intercepts calls without matcher (",
      ),
      claudeReadme: base.claudeReadme.replaceAll("Matcher `", "Matches `"),
    })
    expect(
      missingMatcherDocs.some(
        (f) =>
          f.nodeId ===
          "adapters/antigravity/plugins/effect-harness/README.md:PreToolUse:missing-matcher-doc",
      ),
    ).toBe(true)
    expect(
      missingMatcherDocs.some(
        (f) => f.nodeId === "adapters/claude-code/README.md:PreToolUse:missing-matcher-doc",
      ),
    ).toBe(true)
  })

  it("checkHookMatcherToolParity handles filesystem fixtures and fails closed if an adapter file disappears", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-hook-parity-"))
    try {
      const base = loadLiveParityInput()
      writeParityRepoFixture(dir, base)
      const okFindings: Array<GcFinding> = []
      checkHookMatcherToolParity(dir, testHostIo, okFindings)
      expect(okFindings).toEqual([])

      rmSync(join(dir, "adapters/claude-code/README.md"))
      const missingFindings: Array<GcFinding> = []
      checkHookMatcherToolParity(dir, testHostIo, missingFindings)
      expect(missingFindings.some((f) => f.nodeId === "adapters/claude-code/README.md")).toBe(true)

      // F-5.1: removing hook-guard-payload.ts when harness hook/CLI artifacts exist emits hook-matcher-tool-parity
      rmSync(join(dir, "apps/harness-cli/src/commands/hook-guard-payload.ts"))
      const missingPayloadFindings: Array<GcFinding> = []
      checkHookMatcherToolParity(dir, testHostIo, missingPayloadFindings)
      expect(missingPayloadFindings).toEqual([
        expect.objectContaining({
          kind: "hook-matcher-tool-parity",
          nodeId: "apps/harness-cli/src/commands/hook-guard-payload.ts",
          location: "apps/harness-cli/src/commands/hook-guard-payload.ts",
        }),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // F-5.1: unrelated non-harness workspace without hook/CLI artifacts returns cleanly
    const nonHarnessDir = mkdtempSync(join(tmpdir(), "non-harness-hook-parity-"))
    try {
      writeFileSync(join(nonHarnessDir, "README.md"), "# Sample\n", "utf8")
      const unrelatedFindings: Array<GcFinding> = []
      checkHookMatcherToolParity(nonHarnessDir, testHostIo, unrelatedFindings)
      expect(unrelatedFindings).toEqual([])

      // Adding apps/harness-cli/package.json activates fail-closed payload check
      mkdirSync(join(nonHarnessDir, "apps/harness-cli"), { recursive: true })
      writeFileSync(join(nonHarnessDir, "apps/harness-cli/package.json"), "{}\n", "utf8")
      const cliOnlyFindings: Array<GcFinding> = []
      checkHookMatcherToolParity(nonHarnessDir, testHostIo, cliOnlyFindings)
      expect(cliOnlyFindings).toEqual([
        expect.objectContaining({
          kind: "hook-matcher-tool-parity",
          nodeId: "apps/harness-cli/src/commands/hook-guard-payload.ts",
        }),
      ])
    } finally {
      rmSync(nonHarnessDir, { recursive: true, force: true })
    }
  })

  it.prop(
    "property check: removing any subset of read-only tools from hooks.json matchers emits matching findings",
    {
      droppedTools: Schema.Array(Schema.Literals(["Read", "Glob", "Grep", "LS", "Find"])).pipe(
        Schema.check(Schema.isBetweenLength(1, 3)),
      ),
    },
    ({ droppedTools }) => {
      const tools = ["Read", "Glob", "Grep", "LS", "Find"] as const
      const dropped = new Set<string>(droppedTools)
      const remaining = tools.filter((t) => !dropped.has(t)).join("|")
      const base = loadLiveParityInput()
      const findings = evaluateHookMatcherToolParity({
        ...base,
        claudeHooksJson: base.claudeHooksJson.replace("Read|Grep|Glob|LS|Find", remaining),
      })
      for (const missingTool of dropped) {
        expect(
          findings.some(
            (f) =>
              f.kind === "hook-matcher-tool-parity" &&
              f.nodeId === `adapters/claude-code/hooks.json:PreToolUse:${missingTool}`,
          ),
        ).toBe(true)
      }
    },
  )
})
