import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { Cause, Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents } from "@harness/gates"
import { ShadowFileOverlay } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
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
import { tryQueryWarmDaemonSocket } from "../src/index.js"
import { runCli } from "./run-cli-helper.js"

describe("harness-cli v2 plan-check & verify", () => {
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

    it("succeeds with clean workspace, writes plan snapshot, outputs compact JSON by default, and renders mermaid with --mermaid", async () => {
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
        expect(res.stdout).not.toContain("flowchart TD")
        expect(res.stdout.length).toBeLessThan(1024)
        expect(JSON.parse(res.stdout)).toMatchObject({
          valid: true,
          snapshotReused: false,
          mermaidOmitted: true,
        })

        const mermaidRes = await runCli(["plan-check", "--mermaid"], { repoRoot: dir })
        expect(mermaidRes.exitCode).toBe(0)
        expect(mermaidRes.stdout).toContain("flowchart TD")
        expect(mermaidRes.stdout).toContain("Sample.fnA")

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

    it("extracts workspace HarnessGraph, runs checkEffectGraph, outputs mermaid diagram with --mermaid, and exits 0 on clean workspace with --graph-only", async () => {
      const res = await runCli(["plan-check", "--graph-only", "--mermaid"])
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("flowchart TD")
      expect(res.stdout).toContain("Album.decide")
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

        const res = await runCli(["plan-check", "--graph-only", "--mermaid"], { repoRoot: dir })
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
          `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const fnStub = Effect.fn("Sample.stubbed")(function* () { return yield* stub<number, never, never>() })\n`,
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
})

describe("harness-cli stop hooks, bench, span trace & mutate", () => {
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
      const events = readTelemetryEvents(dir, nodeSyncHostIo)
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
      const eventsAfterReadOnly = readTelemetryEvents(dir, nodeSyncHostIo)
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
      const passRes = await runCli(["bench", "--iterations=1", "--budget-ms=5000"], {
        repoRoot: dir,
      })
      expect(passRes.exitCode).toBe(0)
      const passJson = JSON.parse(passRes.stdout) as {
        readonly overallStatus: string
        readonly measurements: ReadonlyArray<{
          readonly stage: string
          readonly sampleCount: number
        }>
      }
      expect(passJson.overallStatus).toBe("passed")
      expect(passJson.measurements).toHaveLength(5)
      expect(passJson.measurements.some((m) => m.stage === "PlanWorkflowCompiler.decide")).toBe(
        true,
      )
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
      match(parseExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasFails(cause)).toBe(true)
          const errOpt = Cause.findErrorOption(cause)
          match(errOpt)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(SpanTraceReadError)
              expect(value.reason).toBe("ParseError")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected errOpt to be Some")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected parseExit to fail")
        })
        .exhaustive()

      const verifyCorruptRes = await runCli(["verify"], {
        repoRoot: dir,
        skipSubprocessVerify: true,
      })
      expect(verifyCorruptRes.exitCode).toBe(1)
      expect(verifyCorruptRes.stderr).toContain("[GATE FAILURE] verify:span-budget")

      writeFileSync(spanPath, JSON.stringify({ wrong: 1 }), "utf-8")
      const shapeExit = await Effect.runPromiseExit(readRecordedSpans(dir))
      match(shapeExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasFails(cause)).toBe(true)
          const errOpt = Cause.findErrorOption(cause)
          match(errOpt)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(SpanTraceReadError)
              expect(value.reason).toBe("InvalidShapeError")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected errOpt to be Some")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected shapeExit to fail")
        })
        .exhaustive()

      rmSync(spanPath, { force: true })
      mkdirSync(spanPath)
      const readExit = await Effect.runPromiseExit(readRecordedSpans(dir))
      match(readExit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasFails(cause)).toBe(true)
          const errOpt = Cause.findErrorOption(cause)
          match(errOpt)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(SpanTraceReadError)
              expect(value.reason).toBe("ReadError")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected errOpt to be Some")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected readExit to fail")
        })
        .exhaustive()
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
      match(badRes)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value.exitCode).toBe(1)
          expect(value.stderr).toContain("[GATE FAILURE] verify:ast-gates")
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected badRes to be Some")
        })
        .exhaustive()

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
        match(res)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.exitCode).toBe(1)
            expect(value.stderr).toContain("[GATE FAILURE] verify:ast-gates")
            expect(value.stderr).toContain(`[${tc.rule}]`)
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable(`Expected res for ${tc.rel} to be Some`)
          })
          .exhaustive()
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
      symlinkSync(
        join(resolve(import.meta.dirname, "../../.."), "node_modules"),
        join(dir, "node_modules"),
      )
      const domainDir = join(dir, "libs", "demo", "domain", "src")
      const testDir = join(dir, "libs", "demo", "domain", "test")
      mkdirSync(domainDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(
        join(domainDir, "decider.ts"),
        `export const decideCount = (count: number): boolean => {\n  if (count >= 1) {\n    return true\n  }\n  return false\n}\n`,
        "utf-8",
      )
      writeFileSync(
        join(testDir, "decider.test.ts"),
        `import { expect, it } from "vitest"\nit("noop", () => { expect(1).toBe(1) })\n`,
        "utf-8",
      )
      const res = await runCli(["mutate", "--strict", "--scope=demo"], { repoRoot: dir })
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
})
