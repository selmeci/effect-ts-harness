import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer
} from "@harness/decision"
import { writeVerifyStamp } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
// oxlint-disable-next-line @nx/enforce-module-boundaries
import syntaxBansPlugin from "../../../tools/oxlint/syntax-bans.js"
import { COMMANDS, run, runCli } from "../src/index.js"

describe("harness cli baseline", () => {
  it("registers all MVP v2 commands including plan-check and doctor", () => {
    expect(COMMANDS).toEqual([
      "guard",
      "route",
      "plan-check",
      "verify",
      "done",
      "learn",
      "gc",
      "mutate",
      "ingest",
      "session",
      "doctor",
      "ontology",
      "report",
      "help"
    ])
    for (const command of COMMANDS) {
      expect(run([command])).toBe(0)
    }
  })

  it("rejects unknown commands with exit code 1", () => {
    expect(run(["nonsense"])).toBe(1)
  })

  it("prints usage on the help command", async () => {
    const res = await runCli(["help"])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("harness help")
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
          permissionDecision: "ask"
        }
      })
    })

    it("extracts command from Claude Code PreToolUse stdin JSON", async () => {
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf /sensitive"
        }
      })
      const deny = await runCli(["guard"], { stdin })
      expect(deny.exitCode).toBe(2)

      const askStdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command: "alchemy destroy"
        }
      })
      const ask = await runCli(["guard"], { stdin: askStdin })
      expect(ask.exitCode).toBe(0)
      expect(JSON.parse(ask.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask"
        }
      })
    })

    it("escalates ambiguous commands to decision model and handles allow, deny, ask/timeout", async () => {
      const denyLayer = makeMockDecisionModelLayer({
        destructiveProb: 0.85,
        secretAccessProb: 0.1,
        exfiltrationProb: 0.1
      })
      const deny = await runCli(["guard", "custom-script --mutate-all"], {
        decisionLayer: denyLayer
      })
      expect(deny.exitCode).toBe(2)

      const allowLayer = makeMockDecisionModelLayer({
        destructiveProb: 0.05,
        secretAccessProb: 0.05,
        exfiltrationProb: 0.05
      })
      const allow = await runCli(["guard", "custom-script --dry-run"], {
        decisionLayer: allowLayer
      })
      expect(allow.exitCode).toBe(0)

      const failingLayer = makeFailingDecisionModelLayer()
      const fallbackAsk = await runCli(["guard", "custom-script --unknown"], {
        decisionLayer: failingLayer
      })
      expect(fallbackAsk.exitCode).toBe(0)
      expect(JSON.parse(fallbackAsk.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: expect.stringContaining("requires human confirmation")
        }
      })
    })
  })

  describe("route", () => {
    it("routes plan steps to pattern docs, review, or effect", async () => {
      const schemaLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "schema"
      })
      const schemaRoute = await runCli(["route", "Parse incoming HTTP payload with Schema"], {
        decisionLayer: schemaLayer
      })
      expect(schemaRoute.exitCode).toBe(0)
      expect(schemaRoute.stdout).toBe("agent-patterns/schema.md")

      const reviewLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.4,
        blockLabel: "review"
      })
      const reviewRoute = await runCli(["route", "Unclear vague requirement"], {
        decisionLayer: reviewLayer
      })
      expect(reviewRoute.exitCode).toBe(0)
      expect(reviewRoute.stdout).toBe("review")

      const effectLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "effect"
      })
      const effectRoute = await runCli(["route", "Simple sequential effect step"], {
        decisionLayer: effectLayer
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
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.duplicate")(function* () { return 1 })\n`
        )
        writeFileSync(
          join(srcDir, "b.ts"),
          `import { Effect } from "effect"\nexport const fnB = Effect.fn("Sample.duplicate")(function* () { return 2 })\n`
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
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`
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
    })

    it("skips writing plan-graph-snapshot.json when --graph-only is specified", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-graph-only-"))
      try {
        const srcDir = join(dir, "libs", "sample", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "a.ts"),
          `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`
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
          `import { Context, Effect } from "effect"\nexport class BucketService extends Context.Service<BucketService, {\n  readonly get: () => Effect.Effect<string>\n}>()("Cloudflare.R2.BucketBinding") {}\n`
        )
        writeFileSync(
          join(domainDir, "index.ts"),
          `import { Effect } from "effect"\nimport { BucketService } from "../../infra/src/index.js"\nexport const badUseCase = Effect.fn("Sample.badUseCase")(function* () {\n  const bucket = yield* BucketService\n  return yield* bucket.get()\n})\n`
        )

        const res = await runCli(["plan-check", "--graph-only"], { repoRoot: dir })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("domain-requires-")
        expect(res.stderr).toContain("Cloudflare.R2.BucketBinding")
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
          `import { Effect } from "effect"\nimport { stub } from "@harness/gates"\nexport const fnStub = Effect.fn("Sample.stubbed")(function* () { return yield* stub<number, never, never>() })\n`
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
          decisionLayer: makeMockDecisionModelLayer({ triageKind: "semantic" })
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
          `import { Effect } from "effect"\nexport const fnReal = Effect.fn("Sample.real")(function* () { return 42 })\n`
        )

        const res = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
        expect(res.exitCode).toBe(0)

        const stamp = JSON.parse(res.stdout)
        expect(stamp).toMatchObject({
          treeHash: expect.any(String),
          taskBranch: "impl/current",
          timestamp: expect.any(String)
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
          `import { Context, Effect } from "effect"\nexport class BucketService extends Context.Service<BucketService, {\n  readonly get: () => Effect.Effect<string>\n}>()("Cloudflare.R2.BucketBinding") {}\n`
        )
        writeFileSync(
          join(domainDir, "index.ts"),
          `import { Effect } from "effect"\nimport { BucketService } from "../../infra/src/index.js"\nexport const badUseCase = Effect.fn("Sample.badUseCase")(function* () {\n  const bucket = yield* BucketService\n  return yield* bucket.get()\n})\n`
        )

        const res = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain("domain-requires-")
        expect(res.stderr).toContain("Cloudflare.R2.BucketBinding")
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
          reason: expect.stringContaining("Run harness verify")
        })

        writeVerifyStamp(dir, "impl/current")
        const green = await runCli(["done"], {
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({ implementedProb: 0.95, noOutOfScopeProb: 0.95 })
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
          reason: expect.stringContaining("Workspace files changed since last verify")
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
              isStub: true
            }
          ]
        })
        const implGraph = buildHarnessGraph({
          fns: [] // missing greet!
        })

        const res = await runCli(["done"], {
          repoRoot: dir,
          planGraph,
          implGraph
        })
        expect(res.exitCode).toBe(0)
        expect(JSON.parse(res.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Missing planned EffectFn: src/fn.ts#greet")
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
          noOutOfScopeProb: 0.9
        })

        const res = await runCli(["done"], {
          repoRoot: dir,
          decisionLayer: failingCovLayer,
          planSteps: [
            {
              stepId: "step-1",
              planStep: "Implement User schema",
              stepDiff: "+ export const User = Schema.Struct({})"
            }
          ]
        })
        expect(res.exitCode).toBe(0)
        expect(JSON.parse(res.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Plan step step-1 failed coverage check")
        })
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
        modelWarm: true
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
        modelWarm: false
      })
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
          learnTargetLabel: "agent-pattern"
        })

        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
        })
        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
        })
        await runCli(["guard", "node custom-migration-check.mjs"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
        })

        const learnRes = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
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
          actionable: true
        })

        const clearRes = await runCli(["learn", "--clear"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
        })
        expect(clearRes.exitCode).toBe(0)
        expect(JSON.parse(clearRes.stdout).cleared).toBe(true)

        const afterClear = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer
        })
        expect(JSON.parse(afterClear.stdout)).toEqual({
          totalEvents: 0,
          proposals: [],
          cleared: false
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
        findings: []
      })

      const dir = mkdtempSync(join(tmpdir(), "harness-cli-gc-"))
      try {
        const srcDir = join(dir, "libs", "sample", "contract", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Schema } from "effect"\nexport class UnusedError extends Schema.TaggedErrorClass<UnusedError>()("UnusedError", {}) {}\n`
        )

        const strictGc = await runCli(["gc", "--strict"], { repoRoot: dir })
        expect(strictGc.exitCode).toBe(1)
        const report = JSON.parse(strictGc.stdout)
        expect(report.clean).toBe(false)
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "dead-tagged-error",
              nodeId: "UnusedError"
            })
          ])
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
          `import { Effect } from "effect"\nimport { stub } from "@harness/gates"\nexport const pendingFn = Effect.fn("Sample.pendingFn")(function* () { return yield* stub<number, never, never>() })\n`
        )

        const sess = await runCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          decisionLayer: makeFailingDecisionModelLayer()
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
          decisionLayer: makeMockDecisionModelLayer({ fitsAnyProb: 0.9, blockLabel: "effect" })
        })

        const res = await runCli(["report"], { repoRoot: dir })
        expect(res.exitCode).toBe(0)
        const report = JSON.parse(res.stdout)
        expect(report.totalEvents).toBeGreaterThanOrEqual(2)
        expect(report.healthScore).toBeGreaterThanOrEqual(0)
        expect(report.healthScore).toBeLessThanOrEqual(100)
        expect(["A", "B", "C", "D"]).toContain(report.grade)
        expect(report.kpis).toBeDefined()
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
        }
      })
      visitor.Program?.({})
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: { type: "Identifier", name: "actualTag" },
        init: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "err" },
          property: { type: "Identifier", name: "_tag" }
        }
      })
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "!==",
          left: { type: "Identifier", name: "actualTag" },
          right: { type: "Identifier", name: "expectedTag" }
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions"
      )
    }

    // 1b. Collection callback: reasons.filter((r) => r._tag === "Fail")
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "reasons" },
          property: { type: "Identifier", name: "filter" }
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
                property: { type: "Identifier", name: "_tag" }
              },
              right: { type: "Literal", value: "Fail" }
            }
          }
        ]
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions"
      )
    }
  })

  it("flags boolean state flags in Schema.Struct (checkedOut: Schema.Boolean)", () => {
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/sample/domain/src/index.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      }
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Schema" },
        property: { type: "Identifier", name: "Struct" }
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
                property: { type: "Identifier", name: "Boolean" }
              }
            }
          ]
        }
      ]
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Do not use Schema.Boolean for lifecycle or mutually exclusive state flags in Schema.Struct"
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
        }
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
            property: { type: "Identifier", name: "_tag" }
          },
          right: { type: "Literal", value: "Success" }
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions"
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
          getText: () => callbackCode
        },
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "it" },
          property: { type: "Identifier", name: "prop" }
        },
        arguments: [
          { type: "Literal", value: "fold matches reduce" },
          { type: "ArrayExpression", elements: [{ type: "Identifier", name: "eventsArb" }] },
          {
            type: "ArrowFunctionExpression",
            rawSource: callbackCode,
            range: [44, 44 + callbackCode.length]
          }
        ]
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(
        "Tautological property test: do not assert fold(events) against events.reduce(evolve, ...)"
      )
    }
  })

  it("applies ExportNamedDeclaration linting across all non-harness library scopes", () => {
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/billing/domain/src/index.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      }
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
              body: { type: "BlockStatement", body: [] }
            }
          }
        ]
      }
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.message).toContain(
      "Exported domain functions must use Effect.fn('LiteralName')"
    )

    // Internal harness file is spared
    const harnessReports: Array<{ message: string }> = []
    const harnessVisitor = syntaxBans.create({
      filename: "/repo/libs/harness/graph/src/index.ts",
      report: (r: { message: string }) => {
        harnessReports.push(r)
      }
    })
    harnessVisitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: "someFn" }
      }
    })
    expect(harnessReports).toHaveLength(0)
  })
})
