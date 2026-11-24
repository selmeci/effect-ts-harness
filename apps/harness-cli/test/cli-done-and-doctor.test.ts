import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents, writeVerifyStamp } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isReadOnlyStopTurn,
  isSubagentStopContext,
} from "../src/commands/stop-hook-and-transcript.js"
import { runCli } from "./run-cli-helper.js"
import { syntaxBans, testIntegrity } from "./helpers/syntax-bans-fixture.js"

describe("harness-cli v2 done, doctor & session", () => {
  describe("done", () => {
    it("done outputs Stop hook block JSON when verify-stamp.json is missing or stale", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-done-"))
      try {
        writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
        const missing = await runCli(["done"], { repoRoot: dir, stdin: "{}" })
        expect(missing.exitCode).toBe(0)
        expect(JSON.parse(missing.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("Run harness verify"),
        })

        writeVerifyStamp(dir, nodeSyncHostIo, "impl/current")
        const green = await runCli(["done"], {
          repoRoot: dir,
          stdin: "{}",
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
        const stale = await runCli(["done"], { repoRoot: dir, stdin: "{}" })
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
        writeVerifyStamp(dir, nodeSyncHostIo, "impl/current")

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
          stdin: "{}",
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
        writeVerifyStamp(dir, nodeSyncHostIo, "impl/current")

        const failingCovLayer = makeMockDecisionModelLayer({
          implementedProb: 0.3,
          noOutOfScopeProb: 0.9,
        })

        const res = await runCli(["done"], {
          repoRoot: dir,
          stdin: "{}",
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
        const events = readTelemetryEvents(dir, nodeSyncHostIo)
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

    it("SPEC-0024 REQ-1.3/1.4: does not misclassify Antigravity worktrees or explicit CLI done as subagents, and reads Path arg in transcripts", async () => {
      expect(isSubagentStopContext("/home/roan/.gemini/antigravity/worktrees/repo/feat")).toBe(
        false,
      )
      expect(
        isSubagentStopContext("/repo", {
          workspacePaths: ["/home/roan/.gemini/antigravity/worktrees/repo/feat"],
        }),
      ).toBe(false)

      const dir = mkdtempSync(join(tmpdir(), "harness-cli-subagent-test-explicit-"))
      try {
        const cliSubagentDir = join(dir, "subagent-explicit-cli")
        mkdirSync(cliSubagentDir, { recursive: true })
        const explicitRes = await runCli(["done"], { repoRoot: cliSubagentDir })
        expect(explicitRes.telemetryDetail).not.toBe("subagent=true")
        expect(JSON.parse(explicitRes.stdout).decision).toBe("block")

        const brainTranscript = join(dir, "brain-only.jsonl")
        writeFileSync(
          brainTranscript,
          `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "plan" })}\n${JSON.stringify({ step_index: 1, source: "PLANNER_RESPONSE", tool_calls: [{ name: "write_file", args: { Path: "/home/user/.gemini/antigravity/brain/conv-1/task.md" } }] })}\n`,
        )
        expect(isReadOnlyStopTurn({ transcriptPath: brainTranscript })).toBe(true)

        const codeTranscript = join(dir, "code-edit.jsonl")
        writeFileSync(
          codeTranscript,
          `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "edit" })}\n${JSON.stringify({ step_index: 1, source: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: "libs/sample/src/index.ts" } }] })}\n`,
        )
        expect(isReadOnlyStopTurn({ transcriptPath: codeTranscript })).toBe(false)
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
})

describe("syntax-bans & test-integrity oxlint rules: assertions, brands & boundaries", () => {
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
  })

  it("flags raw primitive parameters at exported domain boundaries and unsafe brand casts", () => {
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
        sourceCode: { text: "export const x = 1" },
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
  })

  it("flags duplicate Schema.brand keys and unbranded quantity/TaggedUnion contract schemas", () => {
    // F-1: Duplicate Schema.brand('<Key>') across multiple schemas in same file
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        sourceCode: { text: "export const x = 1" },
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
        sourceCode: { text: "export const x = 1" },
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
  })

  it("flags inline object type aliases, inline object/primitive domain boundaries, and Schema.Int quantity schemas", () => {
    // F-7 & User Request: Inline object type alias ban and inline object parameter/return ban on service & domain boundaries
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        sourceCode: { text: "export const x = 1" },
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
})
