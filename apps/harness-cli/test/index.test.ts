import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as http from "node:http"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents, writeVerifyStamp } from "@harness/gates"
import { buildHarnessGraph, ShadowFileOverlay } from "@harness/graph"
// oxlint-disable-next-line @nx/enforce-module-boundaries
import syntaxBansPlugin from "../../../tools/oxlint/syntax-bans.js"
import {
  formatProjectionError,
  matchesExactSpecToken,
  persistVerifiedOverlays,
} from "../src/commands/plan-ears-and-overlays.js"
import {
  readRecordedSpans,
  runDeltaAstAndPluginGates,
  SpanTraceReadError,
} from "../src/commands/verify-delta-gates.js"
import {
  buildOmnigraphClusterKillArgs,
  cleanSubprocessError,
  COMMANDS,
  ensureLocalOmnigraphReady,
  run,
  runCli,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
} from "../src/index.js"

describe("harness cli baseline", () => {
  it("registers all MVP v2 commands including plan-check and doctor", () => {
    expect(COMMANDS).toEqual([
      "guard",
      "route",
      "plan-check",
      "plan-synth",
      "repair",
      "verify",
      "done",
      "learn",
      "gc",
      "mutate",
      "bench",
      "ingest",
      "session",
      "doctor",
      "ontology",
      "report",
      "help",
    ])
    for (const command of COMMANDS) {
      expect(run([command])).toBe(0)
    }
  })

  it("builds repo-scoped omnigraph kill args to prevent killing other clusters", () => {
    const [bin, args] = buildOmnigraphClusterKillArgs("/tmp/test-repo/.harness/omnigraph-cluster")
    expect(bin).toBe("pkill")
    expect(args).toEqual([
      "-f",
      "omnigraph-server.*--cluster file:///tmp/test-repo/\\.harness/omnigraph-cluster",
    ])
  })

  it("rejects unknown commands with exit code 1", () => {
    expect(run(["nonsense"])).toBe(1)
  })

  it("prints usage on the help command", async () => {
    const res = await runCli(["help"])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("harness help")
  })

  it("rejects unknown commands even when --help or -h is passed", async () => {
    const longHelp = await runCli(["nonexistent-cmd", "--help"])
    expect(longHelp.exitCode).toBe(1)
    expect(longHelp.stderr).toContain("unknown command: nonexistent-cmd")

    const shortHelp = await runCli(["nonexistent-cmd", "-h"])
    expect(shortHelp.exitCode).toBe(1)
    expect(shortHelp.stderr).toContain("unknown command: nonexistent-cmd")
  })

  it("strips ANSI color codes and cleans noisy Nx caching lines", () => {
    const noisyOutput =
      "\u001b[36m✔\u001b[39m nx run @harness/graph:verify [existing outputs match the cache, left as is]\n" +
      "> nx run sample:verify\n" +
      "\u001b[91merror TS377012: Syntax error\u001b[0m\n" +
      "Run duration: 1.2s\n" +
      "Cache: 1/2 hit"

    const cleaned = cleanSubprocessError(noisyOutput)
    expect(cleaned).not.toContain("\u001b")
    expect(cleaned).not.toContain("[existing outputs match the cache, left as is]")
    expect(cleaned).toContain("> nx run sample:verify")
    expect(cleaned).toContain("error TS377012: Syntax error")
    expect(stripAnsiCodes("\u001b[1m\u001b[31mFAIL\u001b[39m\u001b[22m")).toBe("FAIL")
  })
})

describe("harness-cli v2 commands", () => {
  describe("guard", () => {
    it("guard blocks rm -rf (exit 2), allows pnpm test (exit 0), and outputs PreToolUse ask JSON for alchemy deploy", async () => {
      const deny = await runCli(["guard", "rm -rf /tmp/outside"])
      expect(deny.exitCode).toBe(2)
      expect(deny.stderr).toContain("Blocked by harness guard")

      const allow = await runCli(["guard", "pnpm test"])
      expect(allow.exitCode).toBe(0)
      expect(allow.stdout).toBe("")

      const ask = await runCli(["guard", "alchemy deploy"])
      expect(ask.exitCode).toBe(0)
      expect(JSON.parse(ask.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      })

      const cdDeny = await runCli(["guard", "cd libs/sample/domain"])
      expect(cdDeny.exitCode).toBe(2)
      expect(cdDeny.stderr).toContain("Cwd")

      const cdAntigravity = await runCli(["guard", "--format=antigravity", "cd libs/sample/domain"])
      expect(cdAntigravity.exitCode).toBe(0)
      expect(JSON.parse(cdAntigravity.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("Cwd"),
      })
    })

    it("extracts command from Claude Code PreToolUse stdin JSON", async () => {
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf /sensitive",
        },
      })
      const deny = await runCli(["guard"], { stdin })
      expect(deny.exitCode).toBe(2)

      const askStdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command: "alchemy destroy",
        },
      })
      const ask = await runCli(["guard"], { stdin: askStdin })
      expect(ask.exitCode).toBe(0)
      expect(JSON.parse(ask.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      })
    })

    it("escalates ambiguous commands to decision model and handles allow, deny, ask/timeout", async () => {
      const denyLayer = makeMockDecisionModelLayer({
        destructiveProb: 0.85,
        secretAccessProb: 0.1,
        exfiltrationProb: 0.1,
      })
      const deny = await runCli(["guard", "custom-script --mutate-all"], {
        decisionLayer: denyLayer,
      })
      expect(deny.exitCode).toBe(2)

      const allowLayer = makeMockDecisionModelLayer({
        destructiveProb: 0.05,
        secretAccessProb: 0.05,
        exfiltrationProb: 0.05,
      })
      const allow = await runCli(["guard", "custom-script --dry-run"], {
        decisionLayer: allowLayer,
      })
      expect(allow.exitCode).toBe(0)

      const failingLayer = makeFailingDecisionModelLayer()
      const fallbackAsk = await runCli(["guard", "custom-script --unknown"], {
        decisionLayer: failingLayer,
      })
      expect(fallbackAsk.exitCode).toBe(0)
      expect(JSON.parse(fallbackAsk.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: expect.stringContaining("requires human confirmation"),
        },
      })
    })
  })

  describe("route", () => {
    it("routes plan steps to pattern docs, review, or effect", async () => {
      const schemaLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "schema",
      })
      const schemaRoute = await runCli(["route", "Parse incoming HTTP payload with Schema"], {
        decisionLayer: schemaLayer,
      })
      expect(schemaRoute.exitCode).toBe(0)
      expect(schemaRoute.stdout).toBe("agent-patterns/schema.md")

      const reviewLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.4,
        blockLabel: "review",
      })
      const reviewRoute = await runCli(["route", "Unclear vague requirement"], {
        decisionLayer: reviewLayer,
      })
      expect(reviewRoute.exitCode).toBe(0)
      expect(reviewRoute.stdout).toBe("review")

      const effectLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "effect",
      })
      const effectRoute = await runCli(["route", "Simple sequential effect step"], {
        decisionLayer: effectLayer,
      })
      expect(effectRoute.exitCode).toBe(0)
      expect(effectRoute.stdout).toBe("effect")
    })
  })

  describe("plan-check", () => {
    it("fails when duplicate span names exist in workspace", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-dup-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.duplicate")(function* () { return 1 })\n`,
        )
        writeFileSync(
          join(srcDir, "b.ts"),
          `import { Effect } from "effect"\nexport const fnB = Effect.fn("Sample.duplicate")(function* () { return 2 })\n`,
        )

        const res = await runCli(["plan-check"], { repoRoot: dir })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("Duplicate span names found: Sample.duplicate")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("succeeds with clean workspace, writes plan snapshot, and renders mermaid", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-clean-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`,
        )

        const res = await runCli(["plan-check"], { repoRoot: dir })
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toContain("flowchart TD")
        expect(res.stdout).toContain("Sample.fnA")

        const snapshotPath = join(dir, ".harness", "plan-graph-snapshot.json")
        const snapshotContent = readFileSync(snapshotPath, "utf-8")
        expect(snapshotContent).toContain("Sample.fnA")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("captures subprocess failure error output when package.json exists", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-fail-"))
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fail-pkg" }))
        const res = await runCli(["plan-check"], { repoRoot: dir })
        expect(res.exitCode).toBe(1)
        expect(res.stderr.length).toBeGreaterThan(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("extracts workspace HarnessGraph, runs checkEffectGraph, outputs mermaid diagram, and exits 0 on clean workspace with --graph-only", async () => {
      const res = await runCli(["plan-check", "--graph-only"])
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("flowchart TD")
      expect(res.stdout).toContain("Sample.greet")
      expect(res.stderr).toBe("")
    }, 20_000)

    it("skips writing plan-graph-snapshot.json when --graph-only is specified", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-graph-only-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`,
        )

        const res = await runCli(["plan-check", "--graph-only"], { repoRoot: dir })
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toContain("flowchart TD")
        expect(res.stdout).toContain("Sample.fnA")

        const snapshotPath = join(dir, ".harness", "plan-graph-snapshot.json")
        expect(existsSync(snapshotPath)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("fails plan-check with exit 1 and prints violation rule and path on stderr when GraphPolicyViolation exists", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-violation-"))
      try {
        const infraDir = join(dir, "libs", "sample", "infra", "src")
        const domainDir = join(dir, "libs", "sample", "domain", "src")
        mkdirSync(infraDir, { recursive: true })
        mkdirSync(domainDir, { recursive: true })

        writeFileSync(
          join(infraDir, "index.ts"),
          `import { Context, Effect } from "effect"\nexport class BucketService extends Context.Service<BucketService, {\n  readonly get: () => Effect.Effect<string>\n}>()("Cloudflare.R2.BucketBinding") {}\n`,
        )
        writeFileSync(
          join(domainDir, "index.ts"),
          `import { Effect } from "effect"\nimport { BucketService } from "../../infra/src/index.js"\nexport const badUseCase = Effect.fn("Sample.badUseCase")(function* () {\n  const bucket = yield* BucketService\n  return yield* bucket.get()\n})\n`,
        )

        const res = await runCli(["plan-check", "--graph-only"], { repoRoot: dir })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("domain-requires-")
        expect(res.stderr).toContain("Cloudflare.R2.BucketBinding")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("rejects an active spec/ADR that declares a referencedErrors TaggedError with 0 FailsWith edges when the graph has at least one EffectFn", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-dead-err-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`,
        )

        const governanceDocs = [
          {
            docPath: "docs/spec.md",
            id: "spec-001",
            status: "accepted" as const,
            referencedErrors: ["OrderNotFoundError"],
          },
        ]

        const res = await runCli(["plan-check", "--graph-only"], {
          repoRoot: dir,
          governanceDocs,
        })
        expect(res.exitCode).toBe(1)
        const payload = JSON.parse(res.stdout)
        expect(payload).toEqual({
          step: "type-graph-policy",
          valid: false,
          violations: [
            "[dead-tagged-error] Governance doc 'spec-001' declares TaggedError 'OrderNotFoundError', which has 0 FailsWith edges in the plan graph",
          ],
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("verify", () => {
    it("fails when any indexed EffectFn contains an active stub", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-verify-stub-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nimport { stub } from "@harness/gates"\nexport const fnStub = Effect.fn("Sample.stubbed")(function* () { return yield* stub<number, never, never>() })\n`,
        )

        const res = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("stub")
        expect(res.stderr).toContain("Sample.stubbed")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("captures subprocess failure error output and runs TriageV1 when package.json exists", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-verify-fail-"))
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fail-pkg" }))
        const res = await runCli(["verify"], {
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({ triageKind: "semantic" }),
        })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("[triage:semantic]")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("succeeds when clean, writes graph snapshot and verify stamp", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-verify-clean-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnReal = Effect.fn("Sample.real")(function* () { return 42 })\n`,
        )

        const res = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
        expect(res.exitCode).toBe(0)

        const stamp = JSON.parse(res.stdout)
        expect(stamp).toMatchObject({
          treeHash: expect.any(String),
          taskBranch: "impl/current",
          timestamp: expect.any(String),
        })

        const snapshotPath = join(dir, ".harness", "graph-snapshot.json")
        expect(readFileSync(snapshotPath, "utf-8")).toContain("Sample.real")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("fails verify with exit 1 and prints violation rule and path on stderr when GraphPolicyViolation exists", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-verify-violation-"))
      try {
        const infraDir = join(dir, "libs", "sample", "infra", "src")
        const domainDir = join(dir, "libs", "sample", "domain", "src")
        mkdirSync(infraDir, { recursive: true })
        mkdirSync(domainDir, { recursive: true })

        writeFileSync(
          join(infraDir, "index.ts"),
          `import { Context, Effect } from "effect"\nexport class BucketService extends Context.Service<BucketService, {\n  readonly get: () => Effect.Effect<string>\n}>()("Cloudflare.R2.BucketBinding") {}\n`,
        )
        writeFileSync(
          join(domainDir, "index.ts"),
          `import { Effect } from "effect"\nimport { BucketService } from "../../infra/src/index.js"\nexport const badUseCase = Effect.fn("Sample.badUseCase")(function* () {\n  const bucket = yield* BucketService\n  return yield* bucket.get()\n})\n`,
        )

        const res = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("domain-requires-")
        expect(res.stderr).toContain("Cloudflare.R2.BucketBinding")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("fails verify with exit 1 when ontology invariants are broken", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-verify-ontology-fail-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnReal = Effect.fn("Sample.real")(function* () { return 42 })\n`,
        )

        const brokenSpecMarkdown = `---
id: SPEC-001
title: Broken Spec
status: accepted
enforced_by:
  - libs/sample/src/a.ts
---

### Area 1: Cart

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | State-driven | While cart is open, the engine shall calculate total. | Sample.real | test |
`

        const res = await runCli(["verify"], {
          repoRoot: dir,
          skipSubprocessVerify: true,
          governanceDocs: [
            {
              id: "SPEC-001",
              status: "accepted",
              docPath: "libs/sample/docs/specs/spec-1.md",
              markdown: brokenSpecMarkdown,
              enforcedByFiles: ["libs/sample/src/a.ts"],
              referencedSpans: ["Sample.real"],
              referencedServices: [],
              referencedErrors: [],
            },
          ],
        })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("Verification failed: ontology invariants broken")
        expect(res.stderr).toContain("ontology-while-decider-mismatch")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("done", () => {
    it("done outputs Stop hook block JSON when verify-stamp.json is missing or stale", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-"))
      try {
        writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
        const missing = await runCli(["done"], { repoRoot: dir })
        expect(missing.exitCode).toBe(0)
        expect(JSON.parse(missing.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Run harness verify"),
        })

        writeVerifyStamp(dir, "impl/current")
        const green = await runCli(["done"], {
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({
            implementedProb: 0.95,
            noOutOfScopeProb: 0.95,
          }),
        })
        expect(green.exitCode).toBe(0)
        expect(green.stdout).toBe("")
        expect(existsSync(join(dir, ".harness", "session-report.json"))).toBe(true)
        expect(existsSync(join(dir, ".harness", "session-report.md"))).toBe(true)

        // Mutate a file to make stamp stale
        writeFileSync(join(dir, "a.ts"), "export const a = 2\n")
        const stale = await runCli(["done"], { repoRoot: dir })
        expect(stale.exitCode).toBe(0)
        expect(JSON.parse(stale.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Workspace files changed since last verify"),
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("blocks when planGraph vs implGraph diff detects missing functions or remaining stubs", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-diff-"))
      try {
        writeVerifyStamp(dir, "impl/current")

        const planGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "src/fn.ts#greet",
              spanName: "Sample.greet",
              packageTag: "domain",
              file: "src/fn.ts",
              line: 1,
              successType: "string",
              isStub: true,
            },
          ],
        })
        const implGraph = buildHarnessGraph({
          fns: [], // missing greet!
        })

        const res = await runCli(["done"], {
          repoRoot: dir,
          planGraph,
          implGraph,
        })
        expect(res.exitCode).toBe(0)
        expect(JSON.parse(res.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Missing planned EffectFn: src/fn.ts#greet"),
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("blocks when plan step coverage check fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-cov-"))
      try {
        writeVerifyStamp(dir, "impl/current")

        const failingCovLayer = makeMockDecisionModelLayer({
          implementedProb: 0.3,
          noOutOfScopeProb: 0.9,
        })

        const res = await runCli(["done"], {
          repoRoot: dir,
          decisionLayer: failingCovLayer,
          planSteps: [
            {
              stepId: "step-1",
              planStep: "Implement User schema",
              stepDiff: "+ export const User = Schema.Struct({})",
            },
          ],
        })
        expect(res.exitCode).toBe(0)
        expect(JSON.parse(res.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Plan step step-1 failed coverage check"),
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("handleDone with fullyIdle: false records detail fullyIdle=false in telemetry and does not write session-report.json", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-idle-"))
      try {
        const res = await runCli(["done", "--format=antigravity"], {
          repoRoot: dir,
          stdin: JSON.stringify({ fullyIdle: false }),
        })
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toBe("")
        const events = readTelemetryEvents(dir)
        expect(events).toHaveLength(1)
        expect(events[0]?.detail).toBe("fullyIdle=false")
        expect(existsSync(join(dir, ".harness", "session-report.json"))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("classifies subagent stop context correctly even when transcript mentions USER_EXPLICIT in subsequent lines", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-subagent-user-exp-"))
      try {
        const transcriptPath = join(dir, "transcript.jsonl")
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({ step_index: 0, source: "SYSTEM", content: "<SYSTEM_MESSAGE>\n[Message]\nSubagent task" })}\n${JSON.stringify({ step_index: 1, source: "TOOL", content: 'viewed file containing "source":"USER_EXPLICIT"' })}\n`,
        )
        const res = await runCli(["done", "--format=antigravity"], {
          repoRoot: dir,
          stdin: JSON.stringify({ fullyIdle: true, transcriptPath }),
        })
        expect(res.exitCode).toBe(0)
        expect(res.stdout === "" || res.stdout === JSON.stringify({ decision: "stop" })).toBe(true)
        expect(
          res.telemetryDetail === "subagent-skip" || res.telemetryDetail === "subagent=true",
        ).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("does not skip as subagent when transcript contains top-level USER_EXPLICIT line", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-user-explicit-"))
      try {
        const transcriptPath = join(dir, "transcript.jsonl")
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({ step_index: 0, source: "SYSTEM", content: "<SYSTEM_MESSAGE>\n[Message]\nSystem init" })}\n${JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", content: "user prompt" })}\n${JSON.stringify({ step_index: 2, source: "PLANNER_RESPONSE", tool_calls: [{ name: "write_to_file", args: { TargetFile: "src/index.ts" } }] })}\n`,
        )
        const res = await runCli(["done", "--format=antigravity"], {
          repoRoot: dir,
          stdin: JSON.stringify({ fullyIdle: true, transcriptPath }),
        })
        expect(res.exitCode).toBe(0)
        expect(res.telemetryDetail).not.toBe("subagent=true")
        expect(res.telemetryDetail).not.toBe("subagent-skip")
        const payload = JSON.parse(res.stdout)
        expect(payload.decision).toBe("continue")
        expect(payload.reason).toContain("verify")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("doctor and session", () => {
    it("reports node version, effectLspOk, and model warm status", async () => {
      const warmLayer = makeMockDecisionModelLayer({ fitsAnyProb: 0.9, blockLabel: "effect" })
      const doc = await runCli(["doctor"], { decisionLayer: warmLayer })
      expect(doc.exitCode).toBe(0)
      const docPayload = JSON.parse(doc.stdout)
      expect(docPayload).toMatchObject({
        nodeVersion: process.versions.node,
        nodeOk: true,
        snapshotDirOk: true,
        effectLspOk: true,
        omnigraphInitialized: expect.any(Boolean),
        modelWarm: true,
      })

      const failLayer = makeFailingDecisionModelLayer()
      const sess = await runCli(["session"], { decisionLayer: failLayer })
      expect(sess.exitCode).toBe(0)
      const sessPayload = JSON.parse(sess.stdout)
      expect(sessPayload).toMatchObject({
        nodeVersion: process.versions.node,
        nodeOk: true,
        snapshotDirOk: true,
        effectLspOk: true,
        omnigraphInitialized: expect.any(Boolean),
        modelWarm: false,
      })
    })

    it("session --format=antigravity fast-path does not invoke DecisionModel.decide", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-antigravity-fast-"))
      try {
        let decideCalls = 0
        const baseLayer = makeMockDecisionModelLayer()
        const countingLayer = Layer.effect(
          DecisionModel.DecisionModel,
          Effect.gen(function* () {
            const model = yield* Effect.provide(DecisionModel.DecisionModel, baseLayer)
            const countingModel: DecisionModel.DecisionModel = {
              ...model,
              decide: (definition, options) =>
                Effect.sync(() => {
                  decideCalls++
                }).pipe(Effect.andThen(model.decide(definition, options))),
            }
            return countingModel
          }),
        )

        const res = await runCli(
          ["session", "--format=antigravity"],
          { repoRoot: tmpDir },
          countingLayer,
        )
        expect(res.exitCode).toBe(0)
        const payload = JSON.parse(res.stdout)
        expect(payload).toHaveProperty("injectSteps")
        expect(Array.isArray(payload.injectSteps)).toBe(true)
        expect(decideCalls).toBe(0)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it("ingest writes graph-snapshot.json and graph-head.json, and session reconciles when HEAD SHA advances", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-ingest-reconcile-"))
      try {
        const gitRefsDir = join(tmpDir, ".git", "refs", "heads")
        const srcDir = join(tmpDir, "libs", "sample", "domain", "src")
        mkdirSync(gitRefsDir, { recursive: true })
        mkdirSync(srcDir, { recursive: true })

        const sha1 = "1111111111111111111111111111111111111111"
        const sha2 = "2222222222222222222222222222222222222222"
        writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n")
        writeFileSync(join(gitRefsDir, "main"), `${sha1}\n`)
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Effect } from "effect"\nexport const fnV1 = Effect.fn("Sample.fnV1")(function* () { return 1 })\n`,
        )

        const ingestRes = await runCli(["ingest"], { repoRoot: tmpDir })
        expect(ingestRes.exitCode).toBe(0)
        const ingestPayload = JSON.parse(ingestRes.stdout)
        expect(ingestPayload.reconcileReason).toBe("missing-snapshot")
        expect(ingestPayload.branch).toBe("main")
        expect(ingestPayload.headSha).toBe(sha1)
        expect(ingestPayload.indexedFns).toBe(1)

        // Advance git HEAD SHA and add a second function (simulating git pull after PR merge)
        writeFileSync(join(gitRefsDir, "main"), `${sha2}\n`)
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Effect } from "effect"\nexport const fnV1 = Effect.fn("Sample.fnV1")(function* () { return 1 })\nexport const fnV2 = Effect.fn("Sample.fnV2")(function* () { return 2 })\n`,
        )

        const sessRes = await runCli(["session", "--format=antigravity"], {
          repoRoot: tmpDir,
        })
        expect(sessRes.exitCode).toBe(0)
        const headMetaRaw = JSON.parse(
          readFileSync(join(tmpDir, ".harness", "graph-head.json"), "utf-8"),
        ) as { readonly headSha: string; readonly gitBranch: string }
        expect(headMetaRaw.headSha).toBe(sha2)
        expect(headMetaRaw.gitBranch).toBe("main")
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe("learn", () => {
    it("records friction events from route misses and guard escalations, proposes actions via LearnProposalV1, and clears with --clear", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-learn-"))
      try {
        const reviewLayer = makeMockDecisionModelLayer({
          fitsAnyProb: 0.3,
          blockLabel: "review",
          learnActionableProb: 0.92,
          learnTargetLabel: "agent-pattern",
        })

        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        await runCli(["guard", "node custom-migration-check.mjs"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })

        const learnRes = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(learnRes.exitCode).toBe(0)
        const payload = JSON.parse(learnRes.stdout)
        expect(payload.totalEvents).toBe(3)
        expect(payload.cleared).toBe(false)
        expect(payload.proposals).toHaveLength(2)
        expect(payload.proposals[0]).toMatchObject({
          kind: "route_miss",
          summary: "Stream large R2 CSV with Effect Stream",
          occurrences: 2,
          target: "agent-pattern",
          actionable: true,
        })

        const clearRes = await runCli(["learn", "--clear"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(clearRes.exitCode).toBe(0)
        expect(JSON.parse(clearRes.stdout).cleared).toBe(true)

        const afterClear = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(JSON.parse(afterClear.stdout)).toEqual({
          totalEvents: 0,
          proposals: [],
          cleared: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("gc and session handoff", () => {
    it("gc reports clean: true on workspace and detects dead TaggedError in temp repo with --strict", async () => {
      const workspaceGc = await runCli(["gc"])
      expect(workspaceGc.exitCode).toBe(0)
      expect(JSON.parse(workspaceGc.stdout)).toEqual({
        clean: true,
        findings: [],
      })

      const dir = mkdtempSync(join(tmpdir(), "harness-cli-gc-"))
      try {
        const srcDir = join(dir, "libs", "sample", "contract", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Schema } from "effect"\nexport class UnusedError extends Schema.TaggedErrorClass<UnusedError>()("UnusedError", {}) {}\n`,
        )

        const strictGc = await runCli(["gc", "--strict"], { repoRoot: dir })
        expect(strictGc.exitCode).toBe(1)
        const report = JSON.parse(strictGc.stdout)
        expect(report.clean).toBe(false)
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "dead-tagged-error",
              nodeId: "UnusedError",
            }),
          ]),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("session --format=antigravity injects Context Handoff when active stubs exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-handoff-"))
      try {
        const srcDir = join(dir, "libs", "sample", "domain", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Effect } from "effect"\nimport { stub } from "@harness/gates"\nexport const pendingFn = Effect.fn("Sample.pendingFn")(function* () { return yield* stub<number, never, never>() })\n`,
        )

        const sess = await runCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          decisionLayer: makeFailingDecisionModelLayer(),
        })
        expect(sess.exitCode).toBe(0)
        const payload = JSON.parse(sess.stdout)
        expect(payload.injectSteps).toHaveLength(1)
        expect(payload.injectSteps[0]).toContain("[Harness Context Handoff]")
        expect(payload.injectSteps[0]).toContain("Sample.pendingFn")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("report", () => {
    it("generates session report JSON, writes markdown and json files, and respects --clear", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-report-"))
      try {
        await runCli(["guard", "pnpm test"], { repoRoot: dir })
        await runCli(["route", "Add schema"], {
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({ fitsAnyProb: 0.9, blockLabel: "effect" }),
        })

        const res = await runCli(["report"], { repoRoot: dir })
        expect(res.exitCode).toBe(0)
        const report = JSON.parse(res.stdout)
        expect(report.totalEvents).toBe(2)
        expect(report.healthScore).toBe(100)
        expect(report.grade).toBe("A")
        expect(report.kpis).toMatchObject({
          firstPassVerify: null,
          verifyAttempts: 0,
          fixUpIterations: 0,
          planBeforeVerify: true,
          prematureDoneAttempts: 0,
          graphDiscoveryCalls: 0,
          graphDiscoveryRatio: 0,
          omnigraphLiveRatio: null,
          guardInterventions: 0,
          frictionCount: 0,
        })
        expect(existsSync(join(dir, ".harness", "session-report.json"))).toBe(true)
        expect(existsSync(join(dir, ".harness", "session-report.md"))).toBe(true)

        const mdRes = await runCli(["report", "--format=markdown"], { repoRoot: dir })
        expect(mdRes.exitCode).toBe(0)
        expect(mdRes.stdout).toContain("# Harness Session Observability Report")
        expect(mdRes.stdout).toContain("Key Performance Indicators")

        const clearRes = await runCli(["report", "--clear"], { repoRoot: dir })
        expect(clearRes.exitCode).toBe(0)
        const clearedReport = JSON.parse(clearRes.stdout)
        expect(clearedReport.totalEvents).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe("syntax-bans and test-integrity oxlint rules (effect-es#2 discovery)", () => {
  const syntaxBans = syntaxBansPlugin.rules["syntax-bans"]
  const testIntegrity = syntaxBansPlugin.rules["test-integrity"]

  it("flags indirect discriminant branching with aliased tags and collection callbacks", () => {
    // 1a. Aliased tag in if statement: const actualTag = err._tag; if (actualTag !== expectedTag)
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({})
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: { type: "Identifier", name: "actualTag" },
        init: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "err" },
          property: { type: "Identifier", name: "_tag" },
        },
      })
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "!==",
          left: { type: "Identifier", name: "actualTag" },
          right: { type: "Identifier", name: "expectedTag" },
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions",
      )
    }

    // 1b. Collection callback: reasons.filter((r) => r._tag === "Fail")
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "reasons" },
          property: { type: "Identifier", name: "filter" },
        },
        arguments: [
          {
            type: "ArrowFunctionExpression",
            params: [{ type: "Identifier", name: "r" }],
            body: {
              type: "BinaryExpression",
              operator: "===",
              left: {
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "r" },
                property: { type: "Identifier", name: "_tag" },
              },
              right: { type: "Literal", value: "Fail" },
            },
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions",
      )
    }
  })

  it("flags boolean state flags in Schema.Struct (checkedOut: Schema.Boolean)", () => {
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/sample/domain/src/index.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      },
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Schema" },
        property: { type: "Identifier", name: "Struct" },
      },
      arguments: [
        {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              computed: false,
              key: { type: "Identifier", name: "checkedOut" },
              value: {
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "Schema" },
                property: { type: "Identifier", name: "Boolean" },
              },
            },
          ],
        },
      ],
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Do not use Schema.Boolean for lifecycle or mutually exclusive state flags in Schema.Struct",
    )
  })

  it("flags discriminant if statements and tautological fold vs .reduce(evolve, ...) in .test.ts under libs/sample/domain/test/", () => {
    // 3a. if (exit._tag === "Success") in test file
    {
      const reports: Array<{ message: string }> = []
      const visitor = testIntegrity.create({
        filename: "/repo/libs/sample/domain/test/cart.test.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "exit" },
            property: { type: "Identifier", name: "_tag" },
          },
          right: { type: "Literal", value: "Success" },
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions",
      )
    }

    // 3b. Tautological fold vs .reduce(evolve, ...)
    {
      const reports: Array<{ message: string }> = []
      const callbackCode = `([events]) => {
        const folded = fold(events)
        const reduced = events.reduce(evolve, initial)
        expect(folded).toEqual(reduced)
      }`
      const visitor = testIntegrity.create({
        filename: "/repo/libs/sample/domain/test/cart.test.ts",
        sourceCode: {
          text: `it.prop("fold matches reduce", [eventsArb], ${callbackCode})`,
          getText: () => callbackCode,
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "it" },
          property: { type: "Identifier", name: "prop" },
        },
        arguments: [
          { type: "Literal", value: "fold matches reduce" },
          { type: "ArrayExpression", elements: [{ type: "Identifier", name: "eventsArb" }] },
          {
            type: "ArrowFunctionExpression",
            rawSource: callbackCode,
            range: [44, 44 + callbackCode.length],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Tautological property test: do not assert fold(events) against events.reduce(evolve, ...)",
      )
    }
  })

  it("applies ExportNamedDeclaration linting across all non-harness library scopes", () => {
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/billing/domain/src/index.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      },
    })
    visitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "VariableDeclaration",
        declarations: [
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: "untraced" },
            init: {
              type: "ArrowFunctionExpression",
              params: [],
              body: { type: "BlockStatement", body: [] },
            },
          },
        ],
      },
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Exported domain functions must use Effect.fn('LiteralName')",
    )

    // Internal harness file is spared
    const harnessReports: Array<{ message: string }> = []
    const harnessVisitor = syntaxBans.create({
      filename: "/repo/libs/harness/graph/src/index.ts",
      report: (r: { message: string }) => {
        harnessReports.push(r)
      },
    })
    harnessVisitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: "someFn" },
      },
    })
    expect(harnessReports).toHaveLength(0)
  })

  it("flags loose integer types for quantity and streamVersion fields in Schema.Struct", () => {
    // 1. availableQty: Schema.Int should be flagged
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Struct" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "availableQty" },
                value: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Schema" },
                  property: { type: "Identifier", name: "Int" },
                },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use Schema.Int for quantity, version, or count field 'availableQty' in Schema.Struct — use Schema.Natural (non-negative) or Schema.PositiveInt",
      )
    }

    // 2. availableQty: unbranded Schema.Natural is flagged as unbranded scalar field, while Schema.Natural.pipe(Schema.brand("Quantity")) is allowed
    {
      const unbrandedReports: Array<{ message: string }> = []
      const unbrandedVisitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          unbrandedReports.push(r)
        },
      })
      unbrandedVisitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Struct" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "availableQty" },
                value: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Schema" },
                  property: { type: "Identifier", name: "Natural" },
                },
              },
            ],
          },
        ],
      })
      expect(unbrandedReports).toHaveLength(1)
      expect(unbrandedReports[0]?.message).toContain(
        "Do not use unbranded Schema.Natural for field 'availableQty'",
      )

      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Struct" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "availableQty" },
                value: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "MemberExpression",
                      computed: false,
                      object: { type: "Identifier", name: "Schema" },
                      property: { type: "Identifier", name: "Natural" },
                    },
                    property: { type: "Identifier", name: "pipe" },
                  },
                  arguments: [
                    {
                      type: "CallExpression",
                      callee: {
                        type: "MemberExpression",
                        computed: false,
                        object: { type: "Identifier", name: "Schema" },
                        property: { type: "Identifier", name: "brand" },
                      },
                      arguments: [{ type: "Literal", value: "Quantity" }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("flags loose handwritten TypeScript types/interfaces shadowing Schema declarations", () => {
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/es/contract/src/index.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      },
    })
    visitor.Program?.({
      type: "Program",
      body: [
        {
          type: "ExportNamedDeclaration",
          declaration: {
            type: "VariableDeclaration",
            declarations: [
              {
                type: "VariableDeclarator",
                id: { type: "Identifier", name: "makeCommandResultSchema" },
                init: { type: "Identifier", name: "dummy" },
              },
            ],
          },
        },
      ],
    })
    visitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "TSTypeAliasDeclaration",
        id: { type: "Identifier", name: "CommandResult" },
        typeAnnotation: {
          type: "TSTypeLiteral",
          members: [],
        },
      },
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Do not declare loose handwritten TypeScript type/interface 'CommandResult' alongside 'makeCommandResultSchema' — derive the type directly via Schema.Schema.Type",
    )
  })

  it("flags vacuous assertions (toBeDefined, toBeTruthy) in property tests", () => {
    const reports: Array<{ message: string }> = []
    const visitor = testIntegrity.create({
      filename: "/repo/libs/sample/domain/test/cart.test.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      },
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "it" },
        property: { type: "Identifier", name: "prop" },
      },
      arguments: [
        { type: "Literal", value: "deterministic replay" },
        { type: "ArrayExpression", elements: [] },
        {
          type: "ArrowFunctionExpression",
          params: [],
          body: {
            type: "BlockStatement",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "CallExpression",
                      callee: { type: "Identifier", name: "expect" },
                      arguments: [{ type: "Identifier", name: "cartId" }],
                    },
                    property: { type: "Identifier", name: "toBeDefined" },
                  },
                  arguments: [],
                },
              },
            ],
          },
        },
      ],
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Vacuous assertion in property test: do not use toBeDefined(), toBeUndefined(), toBeTruthy(), toBeFalsy(), or existence checks",
    )
  })

  it("flags imprecise Exit.Failure assertions in test-integrity", () => {
    // 1. expect(exit._tag).toBe("Failure")
    {
      const reports: Array<{ message: string }> = []
      const visitor = testIntegrity.create({
        filename: "/repo/libs/sample/domain/test/cart.test.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "CallExpression",
            callee: { type: "Identifier", name: "expect" },
            arguments: [
              {
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "exit" },
                property: { type: "Identifier", name: "_tag" },
              },
            ],
          },
          property: { type: "Identifier", name: "toBe" },
        },
        arguments: [{ type: "Literal", value: "Failure" }],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Imprecise Exit.Failure assertion: checking only exit._tag === 'Failure' masks assertion crashes and unexpected defects (Die)",
      )
    }

    // 2. expect(Exit.isFailure(exit)).toBe(true)
    {
      const reports: Array<{ message: string }> = []
      const visitor = testIntegrity.create({
        filename: "/repo/libs/sample/domain/test/cart.test.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "CallExpression",
            callee: { type: "Identifier", name: "expect" },
            arguments: [
              {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Exit" },
                  property: { type: "Identifier", name: "isFailure" },
                },
                arguments: [{ type: "Identifier", name: "exit" }],
              },
            ],
          },
          property: { type: "Identifier", name: "toBe" },
        },
        arguments: [{ type: "Literal", value: true }],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Imprecise Exit.Failure assertion: checking only exit._tag === 'Failure' masks assertion crashes and unexpected defects (Die)",
      )
    }
  })

  it("flags shallow tag-only assertions in property tests unless payload fields are also asserted", () => {
    // 1. Only finalState._tag is asserted -> flagged
    {
      const reports: Array<{ message: string }> = []
      const visitor = testIntegrity.create({
        filename: "/repo/libs/es/core/test/properties.test.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "it" },
          property: { type: "Identifier", name: "prop" },
        },
        arguments: [
          { type: "Literal", value: "terminal state immutability" },
          { type: "ArrayExpression", elements: [] },
          {
            type: "ArrowFunctionExpression",
            params: [],
            body: {
              type: "BlockStatement",
              body: [
                {
                  type: "ExpressionStatement",
                  expression: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: {
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "expect" },
                        arguments: [
                          {
                            type: "MemberExpression",
                            computed: false,
                            object: { type: "Identifier", name: "finalState" },
                            property: { type: "Identifier", name: "_tag" },
                          },
                        ],
                      },
                      property: { type: "Identifier", name: "toBe" },
                    },
                    arguments: [{ type: "Literal", value: "CheckedOutCart" }],
                  },
                },
              ],
            },
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("Vacuous assertion in property test")
    }

    // 2. Both err._tag and err.albumId are accessed -> allowed
    {
      const reports: Array<{ message: string }> = []
      const visitor = testIntegrity.create({
        filename: "/repo/libs/sample/domain/test/index.test.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "it" },
          property: { type: "Identifier", name: "prop" },
        },
        arguments: [
          { type: "Literal", value: "quota exceeded" },
          { type: "ArrayExpression", elements: [] },
          {
            type: "ArrowFunctionExpression",
            params: [],
            body: {
              type: "BlockStatement",
              body: [
                {
                  type: "ExpressionStatement",
                  expression: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: {
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "expect" },
                        arguments: [
                          {
                            type: "MemberExpression",
                            computed: false,
                            object: { type: "Identifier", name: "err" },
                            property: { type: "Identifier", name: "_tag" },
                          },
                        ],
                      },
                      property: { type: "Identifier", name: "toBe" },
                    },
                    arguments: [{ type: "Literal", value: "AlbumQuotaExceededError" }],
                  },
                },
                {
                  type: "ExpressionStatement",
                  expression: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: {
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "expect" },
                        arguments: [
                          {
                            type: "MemberExpression",
                            computed: false,
                            object: { type: "Identifier", name: "err" },
                            property: { type: "Identifier", name: "albumId" },
                          },
                        ],
                      },
                      property: { type: "Identifier", name: "toBe" },
                    },
                    arguments: [{ type: "Identifier", name: "albumId" }],
                  },
                },
              ],
            },
          },
        ],
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("flags raw primitive type aliases, unbranded contract schemas, unbranded struct fields, raw primitive boundary annotations, and unsafe brand casts", () => {
    // REQ-2.1: Raw primitive type alias (type UserId = string)
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.TSTypeAliasDeclaration?.({
        type: "TSTypeAliasDeclaration",
        id: { type: "Identifier", name: "UserId" },
        typeAnnotation: { type: "TSStringKeyword" },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not declare raw primitive type alias 'UserId = string'",
      )
    }

    // REQ-2.2: Unbranded scalar schema exported from type:contract vs branded schema
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration?.({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "UserId" },
              init: {
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "Schema" },
                property: { type: "Identifier", name: "NonEmptyString" },
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not export unbranded primitive schema 'UserId' from type:contract",
      )
    }

    // REQ-2.3: Unbranded scalar field inside Schema.Struct in type:contract
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Struct" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "albumId" },
                value: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Schema" },
                  property: { type: "Identifier", name: "NonEmptyString" },
                },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use unbranded Schema.NonEmptyString for field 'albumId' in Schema.Struct",
      )
    }

    // REQ-2.4: Raw primitive parameter in exported Effect.fn in type:domain
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration?.({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "findUser" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Effect" },
                    property: { type: "Identifier", name: "fn" },
                  },
                  arguments: [{ type: "Literal", value: "Sample.findUser" }],
                },
                arguments: [
                  {
                    type: "FunctionExpression",
                    generator: true,
                    params: [
                      {
                        type: "Identifier",
                        name: "id",
                        typeAnnotation: {
                          type: "TSTypeAnnotation",
                          typeAnnotation: { type: "TSStringKeyword" },
                        },
                      },
                    ],
                    body: { type: "BlockStatement", body: [] },
                  },
                ],
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use raw primitive type 'string' at exported domain boundary 'findUser'",
      )
    }

    // REQ-2.5: Unsafe `as BrandedType` assertion in production source (including imported brand)
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({
        type: "Program",
        body: [
          {
            type: "ImportDeclaration",
            source: { type: "Literal", value: "@harness/sample-contract" },
            specifiers: [
              {
                type: "ImportSpecifier",
                local: { type: "Identifier", name: "CustomToken" },
              },
            ],
          },
        ],
      })
      visitor.TSAsExpression?.({
        type: "TSAsExpression",
        expression: { type: "Literal", value: "u-1" },
        typeAnnotation: {
          type: "TSTypeReference",
          typeName: { type: "Identifier", name: "CustomToken" },
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not bypass brand validation with 'as' type assertion",
      )
      expect(reports[0]?.message).toContain("Brand.make")
      expect(reports[0]?.message).not.toContain("Brand.refined")
    }

    // F-1: Duplicate Schema.brand('<Key>') across multiple schemas in same file
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({ type: "Program", body: [] })
      const makeBrandCall = () => ({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "brand" },
        },
        arguments: [{ type: "Literal", value: "PhotoId" }],
      })
      visitor.CallExpression?.(makeBrandCall())
      visitor.CallExpression?.(makeBrandCall())
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not declare duplicate Schema.brand('PhotoId') across multiple schemas",
      )
      expect(reports[0]?.message).toContain("Schema.decodeTo")
    }

    // F-2 & F-3 & F-8: Quantity field with unbranded Schema.Natural / Schema.String, local unbranded scalar ref, TaggedStruct, and TaggedUnion
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({
        type: "Program",
        body: [
          {
            type: "VariableDeclaration",
            declarations: [
              {
                type: "VariableDeclarator",
                id: { type: "Identifier", name: "LocalId" },
                init: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Schema" },
                  property: { type: "Identifier", name: "Int" },
                },
              },
            ],
          },
        ],
      })
      // 1) Schema.Struct with local unbranded identifier LocalId and unbranded quantity Schema.Natural
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Struct" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "id" },
                value: { type: "Identifier", name: "LocalId" },
              },
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "qty" },
                value: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Schema" },
                  property: { type: "Identifier", name: "Natural" },
                },
              },
            ],
          },
        ],
      })
      // 2) Schema.TaggedUnion with unbranded Schema.String
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "TaggedUnion" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "Created" },
                value: {
                  type: "ObjectExpression",
                  properties: [
                    {
                      type: "Property",
                      computed: false,
                      key: { type: "Identifier", name: "itemId" },
                      value: {
                        type: "MemberExpression",
                        computed: false,
                        object: { type: "Identifier", name: "Schema" },
                        property: { type: "Identifier", name: "String" },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(3)
      expect(reports[0]?.message).toContain(
        "Do not use unbranded Schema.Int for field 'id' in Schema.Struct",
      )
      expect(reports[1]?.message).toContain(
        "Do not use unbranded Schema.Natural for field 'qty' in Schema.Struct",
      )
      expect(reports[2]?.message).toContain(
        "Do not use unbranded Schema.String for field 'itemId' in Schema.TaggedUnion",
      )
    }

    // F-7 & User Request: Inline object type alias ban and inline object parameter/return ban on service & domain boundaries
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({ type: "Program", body: [] })
      visitor.TSTypeAliasDeclaration?.({
        type: "TSTypeAliasDeclaration",
        id: { type: "Identifier", name: "InlineInput" },
        typeAnnotation: {
          type: "TSTypeLiteral",
          members: [],
        },
      })
      visitor.ExportNamedDeclaration?.({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "decideQuota" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Effect" },
                    property: { type: "Identifier", name: "fn" },
                  },
                  arguments: [{ type: "Literal", value: "Album.decide" }],
                },
                arguments: [
                  {
                    type: "FunctionExpression",
                    generator: true,
                    params: [
                      {
                        type: "Identifier",
                        name: "input",
                        typeAnnotation: {
                          type: "TSTypeAnnotation",
                          typeAnnotation: {
                            type: "TSTypeLiteral",
                            members: [],
                          },
                        },
                      },
                    ],
                    returnType: {
                      type: "TSTypeAnnotation",
                      typeAnnotation: { type: "TSBooleanKeyword" },
                    },
                    body: { type: "BlockStatement", body: [] },
                  },
                ],
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(3)
      expect(reports[0]?.message).toContain("Do not declare inline object type alias 'InlineInput'")
      expect(reports[1]?.message).toContain(
        "Do not use inline object type for parameter at exported domain boundary 'decideQuota'",
      )
      expect(reports[2]?.message).toContain(
        "Do not use raw primitive return type 'boolean' at exported domain boundary 'decideQuota'",
      )
    }

    // 9. Standalone count/quantity schema using Schema.Int.pipe(Schema.brand("AlbumPhotoCount")) without .check() or Schema.Natural
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration?.({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "AlbumPhotoCount" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Schema" },
                    property: { type: "Identifier", name: "Int" },
                  },
                  property: { type: "Identifier", name: "pipe" },
                },
                arguments: [
                  {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: { type: "Identifier", name: "Schema" },
                      property: { type: "Identifier", name: "brand" },
                    },
                    arguments: [{ type: "Literal", value: "AlbumPhotoCount" }],
                  },
                ],
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use Schema.Int for quantity, version, or count schema 'AlbumPhotoCount' — use Schema.Natural",
      )
    }
  })

  it("enforces transactional SQLite migrations via SqliteMigrator and validates migration record keys in type:infra", () => {
    // 1. Raw sql`CREATE TABLE ...` in libs/sample/infra/src/repo.ts without importing SqliteMigrator is flagged with unmanaged-sql-ddl
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.TaggedTemplateExpression?.({
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE raw_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE raw_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("unmanaged-sql-ddl")
    }

    // 2. When ImportDeclaration for @effect/sql-sqlite-do/SqliteMigrator is present, a sql`CREATE TABLE ...` INSIDE SqliteMigrator.fromRecord({ "1_init_tables": sql`CREATE TABLE ...` }) produces 0 reports, whereas a second stray sql`CREATE TABLE stray ...` node OUTSIDE fromRecord in the same file IS flagged with unmanaged-sql-ddl
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ImportDeclaration?.({
        type: "ImportDeclaration",
        source: { type: "Literal", value: "@effect/sql-sqlite-do/SqliteMigrator" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "SqliteMigrator" },
            local: { type: "Identifier", name: "SqliteMigrator" },
          },
        ],
      })
      const insideDdlNode = {
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE managed_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE managed_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      }
      const strayDdlNode = {
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE stray_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE stray_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      }
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_init_tables" },
                value: insideDdlNode,
              },
            ],
          },
        ],
      })
      // Inside DDL produces 0 reports
      visitor.TaggedTemplateExpression?.(insideDdlNode)
      expect(reports).toHaveLength(0)

      // Stray DDL produces unmanaged-sql-ddl
      visitor.TaggedTemplateExpression?.(strayDdlNode)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("unmanaged-sql-ddl")
    }

    // 3. Named migration variable + spread: const aggregateCoreMigrations = { "1_init_tables": eff1, "bad_key_after": eff2 } followed by SqliteMigrator.fromRecord({ ...aggregateCoreMigrations }) flags "bad_key_after" with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ImportDeclaration?.({
        type: "ImportDeclaration",
        source: { type: "Literal", value: "@effect/sql-sqlite-do/SqliteMigrator" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "SqliteMigrator" },
            local: { type: "Identifier", name: "SqliteMigrator" },
          },
        ],
      })
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: { type: "Identifier", name: "aggregateCoreMigrations" },
        init: {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              computed: false,
              key: { type: "Literal", value: "1_init_tables" },
              value: { type: "Identifier", name: "eff1" },
            },
            {
              type: "Property",
              computed: false,
              key: { type: "Literal", value: "bad_key_after" },
              value: { type: "Identifier", name: "eff2" },
            },
          ],
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "SpreadElement",
                argument: { type: "Identifier", name: "aggregateCoreMigrations" },
              },
            ],
          },
        ],
      })
      expect(reports.some((r) => r.message.includes("invalid-migrator-record-key"))).toBe(true)
      expect(reports.some((r) => r.message.includes("bad_key_after"))).toBe(true)
    }

    // 4. Uppercase non-snake_case key "1_InitTables" is flagged with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_InitTables" },
                value: { type: "Identifier", name: "effect" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("invalid-migrator-record-key")
      expect(reports[0]?.message).toContain("1_InitTables")
    }

    // 5. Duplicate numeric IDs "1_first" and "1_duplicate" are flagged with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_first" },
                value: { type: "Identifier", name: "effect1" },
              },
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_duplicate" },
                value: { type: "Identifier", name: "effect2" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("invalid-migrator-record-key")
      expect(reports[0]?.message).toContain(
        "Duplicate SqliteMigrator.fromRecord migration numeric id '1'",
      )
    }

    // 6. Valid keys "1_init_tables" and "2_add_index" produce 0 reports
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_init_tables" },
                value: { type: "Identifier", name: "effect1" },
              },
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "2_add_index" },
                value: { type: "Identifier", name: "effect2" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("flags silent-catch-defect, ignored-chmod-permission, and catch-cause-interrupts-only in runPromiseExit while allowing safe forms", () => {
    // 1. silent-catch-defect: Effect.catchDefect(() => Effect.void) is flagged; reporting/re-fail is allowed
    {
      const reports: Array<{ message: string }> = []
      const silentArg = {
        type: "ArrowFunctionExpression",
        rawSource: "() => Effect.void",
      }
      const visitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/server.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "catchDefect" },
        },
        arguments: [silentArg],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("silently swallows runtime defects")

      const validReports: Array<{ message: string }> = []
      const validVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/server.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          validReports.push(r)
        },
      })
      for (const safeText of [
        "(d) => Effect.logWarning(String(d))",
        "(d) => { process.stderr.write(String(d)); return Effect.void }",
        "(d) => Effect.fail(new DefectError(d))",
        "(d) => Effect.succeed(makeLspExceptionReport(d))",
      ]) {
        validVisitor.CallExpression?.({
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Effect" },
            property: { type: "Identifier", name: "catchDefect" },
          },
          arguments: [{ type: "ArrowFunctionExpression", rawSource: safeText }],
        })
      }
      expect(validReports).toHaveLength(0)
    }

    // 2. ignored-chmod-permission: chmodSync/fchmodSync inside .pipe(Effect.ignore / Effect.orElseSucceed) is flagged; fail-closed is allowed
    {
      const reports: Array<{ message: string }> = []
      const pipeParent: Record<string, unknown> = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "eff" },
          property: { type: "Identifier", name: "pipe" },
        },
        rawSource: "Effect.try(() => fs.chmodSync(sock, 0o600)).pipe(Effect.ignore)",
      }
      const tryCall = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "try" },
        },
        parent: pipeParent,
      }
      const chmodNode = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "fs" },
          property: { type: "Identifier", name: "chmodSync" },
        },
        parent: tryCall,
      }
      const visitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.(chmodNode)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("Ignoring chmodSync/fchmodSync failure")

      const directIgnoreReports: Array<{ message: string }> = []
      const directIgnoreVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          directIgnoreReports.push(r)
        },
      })
      const orElseParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "orElseSucceed" },
        },
      }
      directIgnoreVisitor.CallExpression?.({
        type: "CallExpression",
        callee: { type: "Identifier", name: "fchmodSync" },
        parent: orElseParent,
      })
      expect(directIgnoreReports).toHaveLength(1)
      expect(directIgnoreReports[0]?.message).toContain("Ignoring chmodSync/fchmodSync failure")

      // Fail-closed chmodSync inside Effect.try().pipe(Effect.catch(...)) produces 0 reports
      const safeReports: Array<{ message: string }> = []
      const safeVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          safeReports.push(r)
        },
      })
      const safePipeParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "eff" },
          property: { type: "Identifier", name: "pipe" },
        },
        rawSource: "Effect.try(() => fs.chmodSync(sock, 0o600)).pipe(Effect.catch(handleErr))",
      }
      safeVisitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "fs" },
          property: { type: "Identifier", name: "chmodSync" },
        },
        parent: safePipeParent,
      })
      expect(safeReports).toHaveLength(0)
    }

    // 3. catch-cause-interrupts-only inside Effect.runPromiseExit / Effect.runSyncExit is flagged; test files and Cause.hasInterrupts are allowed
    {
      const reports: Array<{ message: string }> = []
      const runPromiseExitParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "runPromiseExit" },
        },
      }
      const visitor = syntaxBans.create({
        filename: "/repo/libs/harness/gates/src/runner.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Cause" },
          property: { type: "Identifier", name: "hasInterruptsOnly" },
        },
        parent: runPromiseExitParent,
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("Cause.hasInterrupts(cause)")

      const testReports: Array<{ message: string }> = []
      const testVisitor = syntaxBans.create({
        filename: "/repo/libs/harness/gates/test/runner.test.ts",
        report: (r: { message: string }) => {
          testReports.push(r)
        },
      })
      testVisitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Cause" },
          property: { type: "Identifier", name: "hasInterruptsOnly" },
        },
        parent: runPromiseExitParent,
      })
      expect(testReports).toHaveLength(0)
    }
  })

  it("halts execution with [CRITICAL HARNESS BLOCKER] when Ollama is required and unavailable", async () => {
    const prevRequire = process.env["HARNESS_REQUIRE_OLLAMA"]
    const prevUrl = process.env["HARNESS_OLLAMA_URL"]
    process.env["HARNESS_REQUIRE_OLLAMA"] = "1"
    process.env["HARNESS_OLLAMA_URL"] = "http://127.0.0.1:1"
    try {
      const verifyRes = await runCli(["verify"])
      expect(verifyRes.exitCode).toBe(1)
      expect(verifyRes.stderr).toContain(
        "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
      )

      const docRes = await runCli(["doctor"])
      expect(docRes.exitCode).toBe(1)
      expect(JSON.parse(docRes.stdout).ollamaReady).toBe(false)
    } finally {
      if (prevRequire === undefined) delete process.env["HARNESS_REQUIRE_OLLAMA"]
      else process.env["HARNESS_REQUIRE_OLLAMA"] = prevRequire
      if (prevUrl === undefined) delete process.env["HARNESS_OLLAMA_URL"]
      else process.env["HARNESS_OLLAMA_URL"] = prevUrl
    }
  }, 15_000)

  it("allows subagent Stop hook to complete cleanly without verify-stamp.json and handles --help without executing verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-subagent-done-"))
    try {
      const transcriptFile = join(dir, "transcript.jsonl")
      writeFileSync(
        transcriptFile,
        `${JSON.stringify({ step_index: 0, source: "SYSTEM", content: "[Message]\nSender ID: parent\nContent: Run tests" })}\n`,
      )
      const doneRes = await runCli(["done", "--format=antigravity"], {
        repoRoot: dir,
        stdin: JSON.stringify({
          fullyIdle: true,
          transcriptPath: transcriptFile,
          workspacePaths: [dir],
        }),
      })
      expect(doneRes.exitCode).toBe(0)
      expect(JSON.parse(doneRes.stdout)).toEqual({ decision: "stop" })
      const events = readTelemetryEvents(dir)
      expect(events).toHaveLength(1)
      expect(events[0]?.detail).toBe("subagent=true")

      const helpRes = await runCli(["verify", "--help"], { repoRoot: dir })
      expect(helpRes.exitCode).toBe(0)
      expect(helpRes.stdout).toContain("usage: harness")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("allows read-only Q&A Stop hook turn to complete without verify-stamp.json while blocking mutating turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-readonly-done-"))
    try {
      const readOnlyTranscript = join(dir, "readonly-transcript.jsonl")
      writeFileSync(
        readOnlyTranscript,
        [
          JSON.stringify({
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            content: "Explain TypeDB vs Omnigraph",
          }),
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            tool_calls: [
              { name: "view_file", args: { AbsolutePath: "/repo/README.md" } },
              { name: "search_web", args: { query: "TypeDB 3.0" } },
              { name: "run_command", args: { CommandLine: "rg --files libs/harness" } },
              {
                name: "invoke_subagent",
                args: {
                  Subagents: JSON.stringify([
                    {
                      TypeName: "research",
                      Role: "Literature Researcher",
                      Prompt: "Search papers",
                    },
                  ]),
                },
              },
            ],
          }),
        ].join("\n") + "\n",
      )

      const readOnlyRes = await runCli(["done", "--format=antigravity"], {
        repoRoot: dir,
        stdin: JSON.stringify({
          fullyIdle: true,
          transcriptPath: readOnlyTranscript,
          workspacePaths: [dir],
        }),
      })
      expect(readOnlyRes.exitCode).toBe(0)
      expect(JSON.parse(readOnlyRes.stdout)).toEqual({ decision: "stop" })
      const eventsAfterReadOnly = readTelemetryEvents(dir)
      expect(eventsAfterReadOnly.at(-1)?.detail).toBe("readOnly=true")

      const mutatingTranscript = join(dir, "mutating-transcript.jsonl")
      writeFileSync(
        mutatingTranscript,
        [
          JSON.stringify({
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            content: "Fix the bug",
          }),
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            tool_calls: [
              {
                name: "replace_file_content",
                args: { TargetFile: "/repo/apps/harness-cli/src/index.ts" },
              },
            ],
          }),
        ].join("\n") + "\n",
      )

      const mutatingRes = await runCli(["done", "--format=antigravity"], {
        repoRoot: dir,
        stdin: JSON.stringify({
          fullyIdle: true,
          transcriptPath: mutatingTranscript,
          workspacePaths: [dir],
        }),
      })
      expect(mutatingRes.exitCode).toBe(0)
      const mutatingPayload = JSON.parse(mutatingRes.stdout) as {
        readonly decision: string
        readonly reason?: string
      }
      expect(mutatingPayload.decision).toBe("continue")
      expect(mutatingPayload.reason).toContain("Missing .harness/verify-stamp.json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("executes harness bench end-to-end (exit 0 within SLO and exit 1 on LatencySloViolationError) and queries warm daemon socket (F-1, F-2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-bench-e2e-"))
    try {
      const sampleDir = join(dir, "libs", "sample", "domain", "src")
      mkdirSync(sampleDir, { recursive: true })
      writeFileSync(
        join(sampleDir, "index.ts"),
        `import { Effect } from "effect"\nexport const ping = Effect.fn("Sample.ping")(function* () {\n  return yield* Effect.succeed("pong")\n})\n`,
        "utf-8",
      )

      // 1. No daemon socket present -> tryQueryWarmDaemonSocket returns Option.none()
      const noSockOpt = await Effect.runPromise(tryQueryWarmDaemonSocket(dir, "ping"))
      expect(Option.isNone(noSockOpt)).toBe(true)

      // 2. Start a lightweight Unix domain socket server on .harness/daemon.sock and verify round-trip
      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      const sockPath = join(harnessDir, "daemon.sock")
      const mockServer = net.createServer((socket) => {
        socket.on("data", () => {
          socket.write(JSON.stringify({ id: "ping-1", ok: true, status: "warm" }) + "\n")
          socket.end()
        })
      })
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          mockServer.listen(sockPath, () => resume(Effect.void))
        }),
      )
      const warmSockOpt = await Effect.runPromise(tryQueryWarmDaemonSocket(dir, "ping"))
      expect(Option.isSome(warmSockOpt)).toBe(true)
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          mockServer.close(() => resume(Effect.void))
        }),
      )

      // 3. runCli(["bench", "--iterations=1"]) passes (exit 0)
      const passRes = await runCli(["bench", "--iterations=1"], { repoRoot: dir })
      expect(passRes.exitCode).toBe(0)
      const passJson = JSON.parse(passRes.stdout) as {
        readonly overallStatus: string
        readonly measurements: ReadonlyArray<{
          readonly stage: string
          readonly sampleCount: number
        }>
      }
      expect(passJson.overallStatus).toBe("passed")
      expect(passJson.measurements).toHaveLength(4)
      expect(passJson.measurements.every((m) => m.sampleCount === 1)).toBe(true)

      // 4. runCli(["bench", "--iterations=1", "--budget-ms=0.0001"]) fails closed (exit 1) with LatencySloViolationError
      const failRes = await runCli(["bench", "--iterations=1", "--budget-ms=0.0001"], {
        repoRoot: dir,
      })
      expect(failRes.exitCode).toBe(1)
      expect(failRes.stderr).toContain("[LatencySloViolationError]")
      const failJson = JSON.parse(failRes.stdout) as {
        readonly overallStatus: string
        readonly violations: ReadonlyArray<{ readonly stage: string }>
      }
      expect(failJson.overallStatus).toBe("failed")
      expect(failJson.violations.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads recorded spans and fails closed on corrupt, unreadable, or malformed span-trace.json (F-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-spans-"))
    try {
      expect(await Effect.runPromise(readRecordedSpans(dir))).toEqual([])

      const harnessDir = join(dir, ".harness")
      mkdirSync(harnessDir, { recursive: true })
      const spanPath = join(harnessDir, "span-trace.json")

      writeFileSync(spanPath, "   \n", "utf-8")
      expect(await Effect.runPromise(readRecordedSpans(dir))).toEqual([])

      writeFileSync(spanPath, "{not-valid-json", "utf-8")
      const parseExit = await Effect.runPromiseExit(readRecordedSpans(dir))
      expect(Exit.isFailure(parseExit)).toBe(true)
      if (Exit.isFailure(parseExit)) {
        const errOpt = Cause.findErrorOption(parseExit.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value).toBeInstanceOf(SpanTraceReadError)
          expect(errOpt.value.reason).toBe("ParseError")
        }
      }

      const verifyCorruptRes = await runCli(["verify"], {
        repoRoot: dir,
        skipSubprocessVerify: true,
      })
      expect(verifyCorruptRes.exitCode).toBe(1)
      expect(verifyCorruptRes.stderr).toContain("[GATE FAILURE] verify:span-budget")

      writeFileSync(spanPath, JSON.stringify({ wrong: 1 }), "utf-8")
      const shapeExit = await Effect.runPromiseExit(readRecordedSpans(dir))
      expect(Exit.isFailure(shapeExit)).toBe(true)
      if (Exit.isFailure(shapeExit)) {
        const errOpt = Cause.findErrorOption(shapeExit.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value).toBeInstanceOf(SpanTraceReadError)
          expect(errOpt.value.reason).toBe("InvalidShapeError")
        }
      }

      rmSync(spanPath, { force: true })
      mkdirSync(spanPath)
      const readExit = await Effect.runPromiseExit(readRecordedSpans(dir))
      expect(Exit.isFailure(readExit)).toBe(true)
      if (Exit.isFailure(readExit)) {
        const errOpt = Cause.findErrorOption(readExit.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value).toBeInstanceOf(SpanTraceReadError)
          expect(errOpt.value.reason).toBe("ReadError")
        }
      }
      rmSync(spanPath, { recursive: true, force: true })

      const sampleSpans = [{ spanId: "s1", name: "Sample.fn", durationMs: 1 }]
      writeFileSync(spanPath, JSON.stringify(sampleSpans), "utf-8")
      expect(await Effect.runPromise(readRecordedSpans(dir))).toEqual(sampleSpans)

      writeFileSync(spanPath, JSON.stringify({ spans: sampleSpans }), "utf-8")
      expect(await Effect.runPromise(readRecordedSpans(dir))).toEqual(sampleSpans)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs delta AST and plugin gates on empty, clean, and all repo-wide violating deltas (F-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-delta-gates-"))
    try {
      const emptyRes = await Effect.runPromise(runDeltaAstAndPluginGates(dir, []))
      expect(Option.isNone(emptyRes)).toBe(true)

      const domainDir = join(dir, "libs", "sample", "domain", "src")
      mkdirSync(domainDir, { recursive: true })
      const cleanRel = "libs/sample/domain/src/clean.ts"
      writeFileSync(
        join(dir, cleanRel),
        `import { Effect } from "effect"\nexport const ok = Effect.fn("Sample.ok")(function* () {\n  return 1\n})\n`,
        "utf-8",
      )
      const cleanRes = await Effect.runPromise(runDeltaAstAndPluginGates(dir, [cleanRel]))
      expect(Option.isNone(cleanRes)).toBe(true)

      const badRel = "libs/sample/domain/src/bad.ts"
      writeFileSync(
        join(dir, badRel),
        `export const bad = (x: number): string => {\n  switch (x) {\n    default:\n      return "x"\n  }\n}\n`,
        "utf-8",
      )
      const badRes = await Effect.runPromise(runDeltaAstAndPluginGates(dir, [badRel]))
      expect(Option.isSome(badRes)).toBe(true)
      if (Option.isSome(badRes)) {
        expect(badRes.value.exitCode).toBe(1)
        expect(badRes.value.stderr).toContain("[GATE FAILURE] verify:ast-gates")
      }

      const harnessGatesSrc = join(dir, "libs", "harness", "gates", "src")
      const harnessGatesTest = join(dir, "libs", "harness", "gates", "test")
      const harnessCliSrc = join(dir, "apps", "harness-cli", "src")
      mkdirSync(harnessGatesSrc, { recursive: true })
      mkdirSync(harnessGatesTest, { recursive: true })
      mkdirSync(harnessCliSrc, { recursive: true })

      const dotHarnessTarget = [".har", "ness/bad.json"].join("")
      const repoWideCases: ReadonlyArray<{
        readonly rel: string
        readonly content: string
        readonly rule: string
      }> = [
        {
          rel: "libs/harness/gates/src/catch-cause.ts",
          content: `import { Cause, Effect } from "effect"\nexport const bad = Effect.void.pipe(Effect.catchCause((c) => (Cause.hasInterruptsOnly(c) ? Effect.void : Effect.fail("err"))))\n`,
          rule: "catch-cause-interrupts-only",
        },
        {
          rel: "libs/harness/gates/test/unisolated.test.ts",
          content: `import { writeFileSync } from "node:fs"\nwriteFileSync("${dotHarnessTarget}", "{}")\n`,
          rule: "unisolated-dot-harness-test-write",
        },
        {
          rel: "libs/harness/gates/src/unsafe-cast.ts",
          content: `export const bad = (x: unknown): number => x as ${"any"}\n`,
          rule: "unsafe-type-cast",
        },
        {
          rel: "libs/harness/gates/src/tsx-parse.ts",
          content: `const ext = ".tsx"\nexport const bad = (src: string, parse: (lang: unknown, s: string) => unknown, Lang: { TypeScript: unknown }) => parse(Lang.TypeScript, src + ext)\n`,
          rule: "ast-grep-tsx-grammar",
        },
        {
          rel: "apps/harness-cli/src/sqlite-bad.ts",
          content: `import { DatabaseSync } from "node:sqlite"\nexport const db = DatabaseSync\n`,
          rule: "node-sqlite-in-infra",
        },
      ]

      for (const tc of repoWideCases) {
        writeFileSync(join(dir, tc.rel), tc.content, "utf-8")
        const res = await Effect.runPromise(runDeltaAstAndPluginGates(dir, [tc.rel]))
        expect(Option.isSome(res)).toBe(true)
        if (Option.isSome(res)) {
          expect(res.value.exitCode).toBe(1)
          expect(res.value.stderr).toContain("[GATE FAILURE] verify:ast-gates")
          expect(res.value.stderr).toContain(`[${tc.rule}]`)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("matches exact spec tokens, formats projection errors, and rejects out-of-root overlay writes (F-10)", async () => {
    expect(matchesExactSpecToken("implements SPEC-0001 in domain", "SPEC-0001")).toBe(true)
    expect(matchesExactSpecToken("SPEC-0001", "SPEC-0001")).toBe(true)
    expect(matchesExactSpecToken("SPEC-0001: title", "SPEC-0001")).toBe(true)
    expect(matchesExactSpecToken("SPEC-00010", "SPEC-0001")).toBe(false)
    expect(matchesExactSpecToken("MY-SPEC-0001", "SPEC-0001")).toBe(false)
    expect(matchesExactSpecToken("SPEC-0001_v2", "SPEC-0001")).toBe(false)

    expect(
      formatProjectionError({
        _tag: "GraphProjectorError",
        reason: "RoundTripMismatch",
        message: "differs",
      }),
    ).toBe("GraphProjectorError (RoundTripMismatch): differs")
    expect(formatProjectionError({ _tag: "GraphProjectorError", reason: "InvalidTarget" })).toBe(
      "GraphProjectorError (InvalidTarget)",
    )
    expect(formatProjectionError(new Error("plain error"))).toBe("plain error")
    expect(formatProjectionError("raw string")).toBe("raw string")

    const dir = mkdtempSync(join(tmpdir(), "harness-cli-overlays-"))
    const outsideDir = mkdtempSync(join(tmpdir(), "harness-cli-outside-"))
    try {
      const decodeOverlay = Schema.decodeUnknownSync(ShadowFileOverlay)
      const traversalRes = await Effect.runPromise(
        persistVerifiedOverlays(dir, [
          decodeOverlay({ targetFile: "../escape.ts", content: "export const x = 1\n" }),
        ]),
      )
      expect(traversalRes.ok).toBe(false)
      expect(traversalRes.writtenFiles).toEqual([])
      expect(traversalRes.rejectedFiles[0]?.reason).toContain("escapes workspace root")

      const linkPath = join(dir, "libs", "escape-link")
      mkdirSync(join(dir, "libs"), { recursive: true })
      symlinkSync(outsideDir, linkPath)
      const symlinkRes = await Effect.runPromise(
        persistVerifiedOverlays(dir, [
          decodeOverlay({
            targetFile: "libs/escape-link/leak.ts",
            content: "export const leak = 1\n",
          }),
        ]),
      )
      expect(symlinkRes.ok).toBe(false)
      expect(symlinkRes.writtenFiles).toEqual([])
      expect(symlinkRes.rejectedFiles[0]?.reason).toContain("symlink escapes workspace root")

      const validRel = "libs/sample/domain/src/overlay.ts"
      const validRes = await Effect.runPromise(
        persistVerifiedOverlays(dir, [
          decodeOverlay({ targetFile: validRel, content: "export const clean = 1\n" }),
        ]),
      )
      expect(validRes.ok).toBe(true)
      expect(validRes.writtenFiles).toEqual([validRel])
      expect(readFileSync(join(dir, validRel), "utf-8")).toBe("export const clean = 1\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it("runs handleMutate cleanly with --scope=nonexistent-scope returning totalMutants: 0 (F-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-mutate-"))
    try {
      const res = await runCli(["mutate", "--scope=nonexistent-scope"], { repoRoot: dir })
      expect(res.exitCode).toBe(0)
      const payload = JSON.parse(res.stdout) as { readonly totalMutants: number }
      expect(payload.totalMutants).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs handleMutate on a non-empty domain scope and fails when mutants survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-mutate-demo-"))
    try {
      const domainDir = join(dir, "libs", "demo", "domain", "src")
      mkdirSync(domainDir, { recursive: true })
      writeFileSync(
        join(domainDir, "decider.ts"),
        `export const decideCount = (count: number): boolean => {\n  if (count >= 1) {\n    return true\n  }\n  return false\n}\n`,
        "utf-8",
      )
      const res = await runCli(["mutate", "--scope=demo"], { repoRoot: dir })
      expect(res.exitCode).toBe(1)
      const payload = JSON.parse(res.stdout) as {
        readonly passed: boolean
        readonly totalMutants: number
        readonly survivedCount: number
      }
      expect(payload.passed).toBe(false)
      expect(payload.totalMutants).toBeGreaterThan(0)
      expect(payload.survivedCount).toBe(payload.totalMutants)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls through to /readyz readiness poll when omnigraph setup throws before spawn (F-2, F-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-omnigraph-readyz-"))
    const homeDir = mkdtempSync(join(tmpdir(), "harness-cli-home-"))
    let readyzCalls = 0
    const server = http.createServer((req, res) => {
      if (req.url === "/readyz") {
        readyzCalls += 1
        if (readyzCalls === 1) {
          res.writeHead(503)
          res.end()
          return
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(JSON.stringify({ ready: true, ready_graph_count: 1 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const prevHome = process.env["HOME"]
    const prevUrl = process.env["OMNIGRAPH_URL"]
    try {
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void))
        }),
      )
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      expect(port).toBeGreaterThan(0)

      const configDir = join(dir, "libs", "harness", "graph")
      mkdirSync(join(configDir, "queries"), { recursive: true })
      writeFileSync(join(configDir, "cluster.yaml"), "name: test\n", "utf-8")
      writeFileSync(join(configDir, "schema.pg"), "", "utf-8")
      writeFileSync(join(configDir, "queries", "harness.gq"), "", "utf-8")

      const clusterRootDir = join(dir, ".harness", "omnigraph-cluster")
      mkdirSync(clusterRootDir, { recursive: true })
      writeFileSync(join(clusterRootDir, ".config-stamp"), "name: test\n\n---\n\n---\n", "utf-8")

      const localBinDir = join(homeDir, ".local", "bin")
      mkdirSync(localBinDir, { recursive: true })
      const omnigraphStub = join(localBinDir, "omnigraph")
      const omnigraphServerStub = join(localBinDir, "omnigraph-server")
      writeFileSync(omnigraphStub, "#!/usr/bin/env bash\nexit 1\n", "utf-8")
      writeFileSync(omnigraphServerStub, "#!/usr/bin/env bash\nexit 0\n", "utf-8")
      chmodSync(omnigraphStub, 0o755)
      chmodSync(omnigraphServerStub, 0o755)

      process.env["HOME"] = homeDir
      process.env["OMNIGRAPH_URL"] = `http://127.0.0.1:${port}`

      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(dir))
      expect(ready).toBe(true)
      expect(readyzCalls).toBeGreaterThanOrEqual(2)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      if (prevUrl === undefined) delete process.env["OMNIGRAPH_URL"]
      else process.env["OMNIGRAPH_URL"] = prevUrl
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
      )
      rmSync(dir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
