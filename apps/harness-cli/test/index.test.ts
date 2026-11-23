import { describe, expect, it } from "vitest"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import {
  buildOmnigraphClusterKillArgs,
  cleanSubprocessError,
  COMMANDS,
  stripAnsiCodes,
} from "../src/index.js"
import { runCli } from "./run-cli-helper.js"
import {
  syntaxBans,
  testIntegrity,
  runDiscriminantRuleChecks,
} from "./helpers/syntax-bans-fixture.js"

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
      "benchmark",
      "ingest",
      "session",
      "doctor",
      "ontology",
      "report",
      "check-openapi",
      "check-migrations",
      "check-event-schemas",
      "scenario",
      "workflow",
      "help",
    ])
  })

  it("builds repo-scoped omnigraph kill args to prevent killing other clusters", () => {
    const [bin, args] = buildOmnigraphClusterKillArgs("/tmp/test-repo/.harness/omnigraph-cluster")
    expect(bin).toBe("pkill")
    expect(args).toEqual([
      "-f",
      "omnigraph-server.*--cluster file:///tmp/test-repo/\\.harness/omnigraph-cluster(\\s|$)",
    ])
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

describe("harness-cli v2 guard & route", () => {
  describe("guard", () => {
    it("guard blocks rm -rf (exit 2), allows pnpm test (exit 0), and outputs PreToolUse ask JSON for alchemy deploy", async () => {
      const deny = await runCli(["guard", "rm -rf /tmp/outside"])
      expect(deny.exitCode).toBe(2)
      expect(deny.stderr).toContain("Blocked by harness guard")
      expect(deny.telemetryDetail).toContain("static;verdict=deny;reason=")

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
      expect(deny.telemetryDetail).toContain("escalated;verdict=deny;reason=")
      expect(allow.telemetryDetail).toBe("escalated;verdict=allow")
      expect(fallbackAsk.telemetryDetail).toContain("escalated;verdict=ask;reason=")
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
})

describe("syntax-bans & test-integrity oxlint rules: discriminant & struct flags", () => {
  it("flags indirect discriminant branching with aliased tags and collection callbacks", () => {
    // 1a. Aliased tag in if statement: const actualTag = err._tag; if (actualTag !== expectedTag)
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        sourceCode: { text: "export const x = 1" },
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

  it("F-6.7 (part 1): flags embeddingsMode and retrievalMode discriminant branching across dot, optional chaining, computed bracket, destructuring, and nullish fallback", () => {
    // 1. Plain dot access: meta.retrievalMode === "bm25-only"
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "meta" },
            property: { type: "Identifier", name: "retrievalMode" },
          },
          right: { type: "Literal", value: "bm25-only" },
        },
      })
    })

    // 2. Optional chaining: serverMeta?.embeddingsMode === "live"
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "ChainExpression",
            expression: {
              type: "MemberExpression",
              computed: false,
              optional: true,
              object: { type: "Identifier", name: "serverMeta" },
              property: { type: "Identifier", name: "embeddingsMode" },
            },
          },
          right: { type: "Literal", value: "live" },
        },
      })
    })

    // 3. Computed bracket access: meta["embeddingsMode"] === "mock"
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.ConditionalExpression?.({
        type: "ConditionalExpression",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "MemberExpression",
            computed: true,
            object: { type: "Identifier", name: "meta" },
            property: { type: "Literal", value: "embeddingsMode" },
          },
          right: { type: "Literal", value: "mock" },
        },
      })
    })

    // 4. Nested destructured alias with default + inline nullish fallback
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: {
          type: "ObjectPattern",
          properties: [
            {
              type: "Property",
              computed: false,
              key: { type: "Identifier", name: "meta" },
              value: {
                type: "AssignmentPattern",
                left: {
                  type: "ObjectPattern",
                  properties: [
                    {
                      type: "Property",
                      computed: false,
                      key: { type: "Identifier", name: "embeddingsMode" },
                      value: {
                        type: "AssignmentPattern",
                        left: { type: "Identifier", name: "mode" },
                        right: { type: "Literal", value: "mock" },
                      },
                    },
                  ],
                },
                right: { type: "ObjectExpression", properties: [] },
              },
            },
          ],
        },
        init: { type: "Identifier", name: "response" },
      })
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: { type: "Identifier", name: "mode" },
          right: { type: "Literal", value: "live" },
        },
      })
    })

    // 5. Nullish fallback alias & reassignment: const raw = meta?.embeddingsMode ?? "mock"; if (raw === "live")
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: { type: "Identifier", name: "rawMode" },
        init: {
          type: "LogicalExpression",
          operator: "??",
          left: {
            type: "ChainExpression",
            expression: {
              type: "MemberExpression",
              computed: false,
              optional: true,
              object: { type: "Identifier", name: "serverMeta" },
              property: { type: "Identifier", name: "embeddingsMode" },
            },
          },
          right: { type: "Literal", value: "mock" },
        },
      })
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: { type: "Identifier", name: "rawMode" },
          right: { type: "Literal", value: "live" },
        },
      })
    })
  })

  it("F-6.7 (part 2): flags embeddingsMode and retrievalMode in collection callbacks while preserving lexical scope and ignoring 'source'", () => {
    // 6. Collection callback variants (destructured param, block pre-order alias, optional/computed callee, Effect data-first Array.filter)
    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "results" },
          property: { type: "Identifier", name: "filter" },
        },
        arguments: [
          {
            type: "ArrowFunctionExpression",
            params: [
              {
                type: "ObjectPattern",
                properties: [
                  {
                    type: "Property",
                    computed: false,
                    key: { type: "Identifier", name: "retrievalMode" },
                    value: { type: "Identifier", name: "retrievalMode" },
                  },
                ],
              },
            ],
            body: {
              type: "BinaryExpression",
              operator: "===",
              left: { type: "Identifier", name: "retrievalMode" },
              right: { type: "Literal", value: "bm25-only" },
            },
          },
        ],
      })
    })

    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "ChainExpression",
          expression: {
            type: "MemberExpression",
            computed: true,
            optional: true,
            object: { type: "Identifier", name: "results" },
            property: { type: "Literal", value: "some" },
          },
        },
        arguments: [
          {
            type: "ArrowFunctionExpression",
            params: [{ type: "Identifier", name: "r" }],
            body: {
              type: "BlockStatement",
              body: [
                {
                  type: "VariableDeclaration",
                  declarations: [
                    {
                      type: "VariableDeclarator",
                      id: { type: "Identifier", name: "localMode" },
                      init: {
                        type: "MemberExpression",
                        computed: true,
                        object: { type: "Identifier", name: "r" },
                        property: { type: "Literal", value: "embeddingsMode" },
                      },
                    },
                  ],
                },
                {
                  type: "ReturnStatement",
                  argument: {
                    type: "BinaryExpression",
                    operator: "===",
                    left: { type: "Identifier", name: "localMode" },
                    right: { type: "Literal", value: "live" },
                  },
                },
              ],
            },
          },
        ],
      })
    })

    runDiscriminantRuleChecks(1, (visitor) => {
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Array" },
          property: { type: "Identifier", name: "filter" },
        },
        arguments: [
          { type: "Identifier", name: "results" },
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
                property: { type: "Identifier", name: "retrievalMode" },
              },
              right: { type: "Literal", value: "bm25-only" },
            },
          },
        ],
      })
    })

    // 7. Lexical scope isolation and non-discriminant 'source' property must NOT be flagged
    runDiscriminantRuleChecks(0, (visitor) => {
      visitor.ArrowFunctionExpression?.({
        type: "ArrowFunctionExpression",
        params: [
          {
            type: "ObjectPattern",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Identifier", name: "embeddingsMode" },
                value: { type: "Identifier", name: "mode" },
              },
            ],
          },
        ],
        body: { type: "BlockStatement", body: [] },
      })
      visitor["ArrowFunctionExpression:exit"]?.()
      visitor.IfStatement?.({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: { type: "Identifier", name: "mode" },
          right: { type: "Literal", value: 0 },
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
            object: { type: "Identifier", name: "res" },
            property: { type: "Identifier", name: "source" },
          },
          right: { type: "Literal", value: "omnigraph" },
        },
      })
    })
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
      sourceCode: { text: "export const x = 1" },
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
})
