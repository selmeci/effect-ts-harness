import { describe, expect, it } from "@effect/vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Graph } from "effect"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  DatalogRuleId,
  loadGraphSnapshotEffect,
  NodeKey,
  ProofId,
  RelationId,
  saveGraphSnapshot,
} from "@harness/graph"
import {
  augmentReachabilityWithInference,
  buildGraphReachabilityContext,
  extractTopLevelObjectAnalysis,
  loadGovernanceDocsChecked,
} from "../src/plugins/gc/gc-helpers.js"
import {
  evaluateGateRuleDigestCheck,
  extractGateRuleIdsFromSources,
  GATE_RULE_SOURCE_FILES,
} from "../src/plugins/gc/gc-rule-digest.js"
import {
  decideGraphEntropy,
  diffPlanAndImplGraphs,
  findClosestMatch,
  levenshteinDistance,
  loadGovernanceDocsFromDisk,
  parseGovernanceDocFrontmatter,
  parseGovernanceDocFrontmatterChecked,
  type GcFinding,
  type GovernanceDocReference,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("Harness Gates: GC check, Session Handoff, Span Budget, and State Dir", () => {
  it.effect("diffs plan and impl snapshots and confirms 0 missing symbols", () =>
    Effect.gen(function* () {
      const tempDir = mkdtempSync(join(tmpdir(), "harness-gates-snap-"))
      try {
        const initialPlanGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#greet",
              spanName: "greet",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 1,
              successType: "string",
              isStub: true,
            },
          ],
        })
        const initialImplGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#greet",
              spanName: "greet",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 1,
              successType: "string",
              isStub: false,
            },
          ],
        })
        const planPath = join(tempDir, "plan-graph-snapshot.json")
        const implPath = join(tempDir, "graph-snapshot.json")
        saveGraphSnapshot(initialPlanGraph, planPath, testHostIo)
        saveGraphSnapshot(initialImplGraph, implPath, testHostIo)
        const planGraph = yield* loadGraphSnapshotEffect(planPath, testHostIo)
        const implGraph = yield* loadGraphSnapshotEffect(implPath, testHostIo)
        const diff = diffPlanAndImplGraphs(planGraph, implGraph)
        expect(diff.ok).toBe(true)
        expect(diff.reasons).toHaveLength(0)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }),
  )
  describe("decideGraphEntropy / scanGraphEntropy", () => {
    it.effect(
      "detects unused-service, unprovided-service, dead-tagged-error, and missing-pattern-doc",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            services: [
              {
                tagId: "UnusedAndUnprovided",
                name: "UnusedAndUnprovided",
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
              // Built-in framework services should be ignored
              {
                tagId: "DecisionModel",
                name: "DecisionModel",
                packageTag: "service",
                file: "libs/harness/decision/src/index.ts",
              },
              {
                tagId: "@harness/ingest/SpanRecorder",
                name: "SpanRecorder",
                packageTag: "service",
                file: "libs/harness/ingest/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag: "DeadCustomError",
                file: "libs/sample/contract/src/index.ts",
              },
              // Built-in framework errors should be ignored
              {
                errorTag: "OmnigraphLoadError",
                file: "libs/harness/graph/src/index.ts",
              },
              {
                errorTag: "SchemaError",
                file: "libs/harness/graph/src/index.ts",
              },
            ],
          })

          const report = yield* decideGraphEntropy({
            graph,
            expectedPatterns: ["planning", "httpapi", "review", "effect"],
          })

          expect(report.clean).toBe(false)

          const kinds = report.findings.map((f) => f.kind)
          expect(kinds).toContain("unused-service")
          expect(kinds).toContain("unprovided-service")
          expect(kinds).toContain("dead-tagged-error")
          expect(kinds).toContain("missing-pattern-doc")

          // Unused & unprovided for UnusedAndUnprovided
          const unused = report.findings.find(
            (f) => f.kind === "unused-service" && f.nodeId === "UnusedAndUnprovided",
          )
          expect(unused).toBeDefined()
          expect(unused?.message).toContain("has no consumers")
          expect(unused?.location).toBe("libs/sample/service/src/index.ts")
          expect(unused?.action).toContain("inject ServiceTag")

          const unprovided = report.findings.find(
            (f) => f.kind === "unprovided-service" && f.nodeId === "UnusedAndUnprovided",
          )
          expect(unprovided).toBeDefined()
          expect(unprovided?.message).toContain("has no providing ServiceLayer")
          expect(unprovided?.location).toBe("libs/sample/service/src/index.ts")
          expect(unprovided?.action).toContain("Provide a live layer")

          // Ignored services should NOT produce findings
          expect(
            report.findings.some(
              (f) => f.nodeId === "DecisionModel" || f.nodeId === "@harness/ingest/SpanRecorder",
            ),
          ).toBe(false)

          // Dead tagged error
          const deadErr = report.findings.find(
            (f) => f.kind === "dead-tagged-error" && f.nodeId === "DeadCustomError",
          )
          expect(deadErr).toBeDefined()
          expect(deadErr?.message).toContain("is never emitted in any E channel")
          expect(deadErr?.location).toBe("libs/sample/contract/src/index.ts")
          expect(deadErr?.action).toContain("Fail with this error")

          // Ignored errors should NOT produce findings
          expect(
            report.findings.some(
              (f) => f.nodeId === "OmnigraphLoadError" || f.nodeId === "SchemaError",
            ),
          ).toBe(false)

          // Missing pattern docs for planning and httpapi (review & effect excluded)
          const missingDocs = report.findings.filter((f) => f.kind === "missing-pattern-doc")
          expect(missingDocs.map((f) => f.nodeId)).toEqual(["Pattern:planning", "Pattern:httpapi"])
          expect(missingDocs[0]?.location).toBe("agent-patterns/planning.md")
          expect(missingDocs[0]?.action).toContain('Create "agent-patterns/planning.md"')
        }),
    )

    it.effect(
      "enriches findings with location, action and fuzzy match suggestions on typos in governance docs",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: "libs/sample/domain/src/index.ts#greet",
                spanName: "Sample.greet",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 12,
                successType: "string",
                isStub: false,
              },
            ],
          })

          const governanceDocs: ReadonlyArray<GovernanceDocReference> = [
            {
              docPath: "libs/sample/docs/adr/0001-sample.md",
              id: "sample:ADR-0001",
              status: "accepted",
              referencedSpans: ["Sample.greett"], // typo
            },
          ]

          const report = yield* decideGraphEntropy({
            graph,
            governanceDocs,
          })

          const stale = report.findings.find(
            (f) => f.kind === "stale-doc-reference" && f.nodeId === "sample:ADR-0001:Sample.greett",
          )
          expect(stale).toBeDefined()
          expect(stale?.location).toBe("libs/sample/docs/adr/0001-sample.md")
          expect(stale?.message).toContain('Did you mean "Sample.greet"?')
          expect(stale?.action).toContain(
            'Update reference in "libs/sample/docs/adr/0001-sample.md" to "Sample.greet"',
          )
        }),
    )

    it("calculates levenshtein distance and closest fuzzy match correctly", () => {
      expect(levenshteinDistance("kitten", "sitting")).toBe(3)
      expect(levenshteinDistance("Cart.addItem", "Cart.addItem")).toBe(0)
      expect(levenshteinDistance("Cart.addItem", "Cart.adItem")).toBe(1)

      const candidates = ["Cart.addItem", "Cart.checkout", "Cart.clear"]
      expect(findClosestMatch("Cart.adItem", candidates)).toBe("Cart.addItem")
      expect(findClosestMatch("Cart.checkot", candidates)).toBe("Cart.checkout")
      expect(findClosestMatch("CompletelyDifferent", candidates)).toBeUndefined()
    })

    it.effect(
      "passes clean: true via decideGraphEntropy when all elements are correctly wired",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: "libs/sample/domain/src/index.ts#greet",
                spanName: "Sample.greet",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 5,
                successType: "string",
                isStub: false,
              },
            ],
            services: [
              {
                tagId: "GreeterService",
                name: "GreeterService",
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
            ],
            layers: [
              {
                qualname: "libs/sample/infra/src/index.ts#GreeterLive",
                layerKind: "live",
                packageTag: "infra",
                file: "libs/sample/infra/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag: "GreeterError",
                file: "libs/sample/contract/src/index.ts",
              },
            ],
            patternDocs: [
              {
                slug: "planning",
                path: "agent-patterns/planning.md",
                summary: "Planning pattern",
              },
            ],
            requiresService: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                tagId: "GreeterService",
              },
            ],
            providesService: [
              {
                layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
                tagId: "GreeterService",
              },
            ],
            failsWith: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                errorTag: "GreeterError",
              },
            ],
          })

          const report = yield* decideGraphEntropy({
            graph,
            expectedPatterns: ["planning", "review", "effect"],
          })

          expect(report.clean).toBe(true)
          expect(report.findings).toHaveLength(0)
        }),
    )

    it.effect(
      "flags untested domain EffectFn when checkUntestedDomainFns: true, passes once tested",
      () =>
        Effect.gen(function* () {
          const fnNode = {
            qualname: "libs/sample/domain/src/index.ts#greet",
            spanName: "Sample.greet",
            packageTag: "domain" as const,
            file: "libs/sample/domain/src/index.ts",
            line: 9,
            successType: "string",
            isStub: false,
          }

          const graphWithoutTest = buildHarnessGraph({
            fns: [fnNode],
          })

          const reportUntested = yield* decideGraphEntropy({
            graph: graphWithoutTest,
            checkUntestedDomainFns: true,
          })

          expect(reportUntested.clean).toBe(false)
          const untested = reportUntested.findings.find((f) => f.kind === "untested-effect-fn")
          expect(untested).toBeDefined()
          expect(untested?.nodeId).toBe("Sample.greet")
          expect(untested?.message).toContain("has 0 reaching tests")

          // Now add a VitestCase and ExercisesSpan edge
          const graphWithTest = buildHarnessGraph({
            fns: [fnNode],
            tests: [
              {
                testId: "libs/sample/domain/test/index.test.ts::suite",
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
              },
            ],
            exercisesSpans: [
              {
                testId: "libs/sample/domain/test/index.test.ts::suite",
                calleeQualname: "libs/sample/domain/src/index.ts#greet",
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const reportTested = yield* decideGraphEntropy({
            graph: graphWithTest,
            checkUntestedDomainFns: true,
          })

          const untestedAfter = reportTested.findings.filter((f) => f.kind === "untested-effect-fn")
          expect(untestedAfter).toHaveLength(0)
          expect(reportTested.clean).toBe(true)
        }),
    )

    it.effect(
      "flags untested-effect-fn and missing-decider-property-test on packageTag: 'contract' functions",
      () =>
        Effect.gen(function* () {
          const contractDecider = {
            qualname: "libs/sample/contract/src/index.ts#Decider.run",
            spanName: "Decider.run",
            packageTag: "contract" as const,
            file: "libs/sample/contract/src/index.ts",
            line: 15,
            successType: "void",
            isStub: false,
          }
          const contractPureDecider = {
            qualname: "libs/sample/contract/src/index.ts#Item.decide",
            spanName: "Item.decide",
            packageTag: "contract" as const,
            file: "libs/sample/contract/src/index.ts",
            line: 30,
            successType: "boolean",
            isStub: false,
          }

          const graphWithoutTests = buildHarnessGraph({
            fns: [contractDecider, contractPureDecider],
          })

          const report = yield* decideGraphEntropy({
            graph: graphWithoutTests,
            checkUntestedDomainFns: true,
            checkDeciderPropertyTests: true,
          })

          expect(report.clean).toBe(false)
          const untestedDeciderRun = report.findings.find(
            (f) => f.kind === "untested-effect-fn" && f.nodeId === "Decider.run",
          )
          expect(untestedDeciderRun).toBeDefined()
          expect(untestedDeciderRun?.message).toContain("has 0 reaching tests")

          const missingProp = report.findings.find(
            (f) => f.kind === "missing-decider-property-test" && f.nodeId === "Item.decide",
          )
          expect(missingProp).toBeDefined()
          expect(missingProp?.message).toContain("0 Property-Based Tests")
        }),
    )

    it.effect(
      "decideGraphEntropy: detects unused-service, unprovided-service, and dead-tagged-error over PERA hypergraph relations",
      () =>
        Effect.gen(function* () {
          const fnQualname = "libs/sample/domain/src/index.ts#checkout"
          const providedService = "PaymentService"
          const unprovidedService = "UnprovidedService"
          const unusedService = "UnusedService"
          const usedError = "PaymentError"
          const deadError = "DeadPaymentError"

          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Checkout.run",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 10,
                successType: "void",
                isStub: false,
              },
            ],
            services: [
              {
                tagId: providedService,
                name: providedService,
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
              {
                tagId: unprovidedService,
                name: unprovidedService,
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
              {
                tagId: unusedService,
                name: unusedService,
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
            ],
            layers: [
              {
                qualname: "libs/sample/infra/src/index.ts#PaymentLive",
                layerKind: "live",
                packageTag: "infra",
                file: "libs/sample/infra/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag: usedError,
                file: "libs/sample/contract/src/index.ts",
              },
              {
                errorTag: deadError,
                file: "libs/sample/contract/src/index.ts",
              },
            ],
            tests: [
              {
                testId: "libs/sample/domain/test/checkout.test.ts::suite",
                testFile: "libs/sample/domain/test/checkout.test.ts",
                testName: "checkout suite",
                lastTreeHash: "workspace",
              },
            ],
            patternDocs: [
              {
                slug: "planning",
                path: "agent-patterns/planning.md",
                summary: "Planning pattern",
              },
            ],
            effectSignatures: [
              {
                relationId: RelationId.make(`EffectSignature:${fnQualname}`),
                callerQualname: fnQualname,
                requiredServices: [providedService, unprovidedService],
                emittedErrors: [usedError],
                calleeQualnames: [],
                payloadSchemas: [],
                file: "libs/sample/domain/src/index.ts",
                line: 10,
              },
            ],
            layerFlows: [
              {
                relationId: RelationId.make("LayerFlow:libs/sample/infra/src/index.ts#PaymentLive"),
                layerQualname: "libs/sample/infra/src/index.ts#PaymentLive",
                providesServices: [providedService],
                requiresServices: [],
                emittedErrors: [],
                file: "libs/sample/infra/src/index.ts",
                line: 1,
              },
            ],
            exercisesSpans: [
              {
                testId: "libs/sample/domain/test/checkout.test.ts::suite",
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const report = yield* decideGraphEntropy({
            graph,
            expectedPatterns: ["planning", "review", "effect"],
          })

          expect(report.clean).toBe(false)

          // Detection of an unused ServiceTag (unused-service-tag / unused-service)
          const unusedSvcFinding = report.findings.find(
            (f) => f.kind === "unused-service" && f.nodeId === unusedService,
          )
          expect(unusedSvcFinding).toBeDefined()
          expect(unusedSvcFinding?.message).toContain("has no consumers")

          // Detection of an unprovided ServiceTag (missing-layer-provider / unprovided-service)
          const unprovidedSvcFinding = report.findings.find(
            (f) => f.kind === "unprovided-service" && f.nodeId === unprovidedService,
          )
          expect(unprovidedSvcFinding).toBeDefined()
          expect(unprovidedSvcFinding?.message).toContain("has no providing ServiceLayer")

          // Detection of an unused TaggedError (unused-error-tag / dead-tagged-error)
          const deadErrFinding = report.findings.find(
            (f) => f.kind === "dead-tagged-error" && f.nodeId === deadError,
          )
          expect(deadErrFinding).toBeDefined()
          expect(deadErrFinding?.message).toContain("is never emitted in any E channel")

          // Provided service and emitted error should NOT be flagged
          expect(report.findings.some((f) => f.nodeId === providedService)).toBe(false)
          expect(report.findings.some((f) => f.nodeId === usedError)).toBe(false)
        }),
    )

    it.effect(
      "decideGraphEntropy: clean pass over PERA hypergraph when LayerFlow, EffectSignature, and TraceabilityTuple are fully wired",
      () =>
        Effect.gen(function* () {
          const fnQualname = "libs/sample/domain/src/index.ts#checkout"
          const serviceTagId = "PaymentService"
          const layerQualname = "libs/sample/infra/src/index.ts#PaymentLive"
          const errorTag = "PaymentError"
          const testId = "libs/sample/domain/test/checkout.test.ts::suite"

          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Checkout.run",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 10,
                successType: "void",
                isStub: false,
              },
            ],
            services: [
              {
                tagId: serviceTagId,
                name: serviceTagId,
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
            ],
            layers: [
              {
                qualname: layerQualname,
                layerKind: "live",
                packageTag: "infra",
                file: "libs/sample/infra/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag,
                file: "libs/sample/contract/src/index.ts",
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/checkout.test.ts",
                testName: "checkout suite",
                lastTreeHash: "workspace",
              },
            ],
            patternDocs: [
              {
                slug: "planning",
                path: "agent-patterns/planning.md",
                summary: "Planning pattern",
              },
            ],
            // 1. EffectSignature with requires-service and fails-with edges
            effectSignatures: [
              {
                relationId: RelationId.make(`EffectSignature:${fnQualname}`),
                callerQualname: fnQualname,
                requiredServices: [serviceTagId],
                emittedErrors: [errorTag],
                calleeQualnames: [],
                payloadSchemas: [],
                file: "libs/sample/domain/src/index.ts",
                line: 10,
              },
            ],
            // 2. LayerFlow with provider-layer and provided-service edges
            layerFlows: [
              {
                relationId: RelationId.make(`LayerFlow:${layerQualname}`),
                layerQualname,
                providesServices: [serviceTagId],
                requiresServices: [],
                emittedErrors: [],
                file: "libs/sample/infra/src/index.ts",
                line: 1,
              },
            ],
            // 3. TraceabilityTuple with exercising-test and exercised-span edges
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const report = yield* decideGraphEntropy({
            graph,
            checkUntestedDomainFns: true,
            expectedPatterns: ["planning", "review", "effect"],
          })

          expect(report.clean).toBe(true)
          expect(report.findings).toHaveLength(0)
        }),
    )

    it("parses ADR and EARS spec YAML frontmatter accurately", () => {
      const adrMarkdown = `---
id: ADR-0001
status: accepted
enforced_by:
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/test/gc-handoff-budget.test.ts
spans:
  - Sample.greet
services:
  - GreeterService
errors:
  - GreeterError
---
# ADR-0001
`
      const parsedAdr = parseGovernanceDocFrontmatter("docs/adr/0001-adr.md", adrMarkdown, (rel) =>
        rel.includes("gc-check.ts"),
      )
      expect(parsedAdr).not.toBeNull()
      expect(parsedAdr?.id).toBe("ADR-0001")
      expect(parsedAdr?.status).toBe("accepted")
      expect(parsedAdr?.docPath).toBe("docs/adr/0001-adr.md")
      expect(parsedAdr?.enforcedByFiles).toEqual([
        "libs/harness/gates/src/gc-check.ts",
        "libs/harness/gates/test/gc-handoff-budget.test.ts",
      ])
      expect(parsedAdr?.existingFiles).toEqual(["libs/harness/gates/src/gc-check.ts"])
      expect(parsedAdr?.referencedSpans).toEqual(["Sample.greet"])
      expect(parsedAdr?.referencedServices).toEqual(["GreeterService"])
      expect(parsedAdr?.referencedErrors).toEqual(["GreeterError"])

      // Test inline lists and proposed status
      const earsMarkdown = `---
id: "SPEC-0001"
status: proposed
enforced_by: ["libs/sample/domain/src/index.ts"]
spans: ["Sample.greet", 'Sample.farewell']
services: [GreeterService]
errors: []
---
# EARS Spec
`
      const parsedEars = parseGovernanceDocFrontmatter("docs/specs/0001-spec.md", earsMarkdown)
      expect(parsedEars).not.toBeNull()
      expect(parsedEars?.id).toBe("SPEC-0001")
      expect(parsedEars?.status).toBe("proposed")
      expect(parsedEars?.enforcedByFiles).toEqual(["libs/sample/domain/src/index.ts"])
      expect(parsedEars?.existingFiles).toEqual(["libs/sample/domain/src/index.ts"])
      expect(parsedEars?.referencedSpans).toEqual(["Sample.greet", "Sample.farewell"])
      expect(parsedEars?.referencedServices).toEqual(["GreeterService"])
      expect(parsedEars?.referencedErrors).toEqual([])

      // Missing or invalid frontmatter/id
      expect(parseGovernanceDocFrontmatter("docs/adr/no-fm.md", "# Just MD")).toBeNull()
      expect(
        parseGovernanceDocFrontmatter("docs/adr/no-id.md", "---\nstatus: accepted\n---"),
      ).toBeNull()
      expect(parseGovernanceDocFrontmatter("docs/adr/empty-id.md", "---\nid: ''\n---")).toBeNull()
    })

    it.effect(
      "returns clean: true when accepted ADR/Spec references valid files, spans, services, and errors",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: "libs/sample/domain/src/index.ts#greet",
                spanName: "Sample.greet",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 5,
                successType: "string",
                isStub: false,
              },
            ],
            services: [
              {
                tagId: "GreeterService",
                name: "GreeterService",
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
            ],
            layers: [
              {
                qualname: "libs/sample/infra/src/index.ts#GreeterLive",
                layerKind: "live",
                packageTag: "infra",
                file: "libs/sample/infra/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag: "GreeterError",
                file: "libs/sample/contract/src/index.ts",
              },
            ],
            patternDocs: [
              {
                slug: "planning",
                path: "agent-patterns/planning.md",
                summary: "Planning pattern",
              },
            ],
            requiresService: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                tagId: "GreeterService",
              },
            ],
            providesService: [
              {
                layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
                tagId: "GreeterService",
              },
            ],
            failsWith: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                errorTag: "GreeterError",
              },
            ],
          })

          const doc: GovernanceDocReference = {
            docPath: "docs/adr/0001-greeter.md",
            id: "ADR-0001",
            status: "accepted",
            enforcedByFiles: ["libs/sample/domain/src/index.ts"],
            existingFiles: ["libs/sample/domain/src/index.ts"],
            referencedSpans: ["Sample.greet"],
            referencedServices: ["GreeterService"],
            referencedErrors: ["GreeterError"],
          }

          const report = yield* decideGraphEntropy({
            graph,
            expectedPatterns: ["planning", "review", "effect"],
            governanceDocs: [doc],
          })

          expect(report.clean).toBe(true)
          expect(report.findings).toHaveLength(0)
        }),
    )

    it.effect(
      "flags stale-doc-reference when accepted doc references missing elements while ignoring proposed/superseded",
      () =>
        Effect.gen(function* () {
          const graph = buildHarnessGraph({
            fns: [
              {
                qualname: "libs/sample/domain/src/index.ts#greet",
                spanName: "Sample.greet",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 5,
                successType: "string",
                isStub: false,
              },
            ],
            services: [
              {
                tagId: "GreeterService",
                name: "GreeterService",
                packageTag: "service",
                file: "libs/sample/service/src/index.ts",
              },
            ],
            layers: [
              {
                qualname: "libs/sample/infra/src/index.ts#GreeterLive",
                layerKind: "live",
                packageTag: "infra",
                file: "libs/sample/infra/src/index.ts",
              },
            ],
            errors: [
              {
                errorTag: "GreeterError",
                file: "libs/sample/contract/src/index.ts",
              },
            ],
            patternDocs: [
              {
                slug: "planning",
                path: "agent-patterns/planning.md",
                summary: "Planning pattern",
              },
            ],
            requiresService: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                tagId: "GreeterService",
              },
            ],
            providesService: [
              {
                layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
                tagId: "GreeterService",
              },
            ],
            failsWith: [
              {
                callerQualname: "libs/sample/domain/src/index.ts#greet",
                errorTag: "GreeterError",
              },
            ],
          })

          const staleAcceptedDoc: GovernanceDocReference = {
            docPath: "docs/adr/0002-stale.md",
            id: "ADR-0002",
            status: "accepted",
            enforcedByFiles: ["libs/sample/deleted.ts"],
            existingFiles: [],
            referencedSpans: ["Missing.span"],
            referencedServices: ["MissingService"],
            referencedErrors: ["MissingError"],
          }

          const proposedDocWithBrokenRefs: GovernanceDocReference = {
            docPath: "docs/specs/0001-draft.md",
            id: "SPEC-0001",
            status: "proposed",
            enforcedByFiles: ["libs/sample/draft-nonexistent.ts"],
            existingFiles: [],
            referencedSpans: ["Draft.span"],
            referencedServices: ["DraftService"],
            referencedErrors: ["DraftError"],
          }

          const supersededDocWithBrokenRefs: GovernanceDocReference = {
            docPath: "docs/adr/0000-old.md",
            id: "ADR-0000",
            status: "superseded",
            enforcedByFiles: ["libs/sample/old-nonexistent.ts"],
            existingFiles: [],
            referencedSpans: ["Old.span"],
            referencedServices: ["OldService"],
            referencedErrors: ["OldError"],
          }

          const report = yield* decideGraphEntropy({
            graph,
            expectedPatterns: ["planning", "review", "effect"],
            governanceDocs: [
              staleAcceptedDoc,
              proposedDocWithBrokenRefs,
              supersededDocWithBrokenRefs,
            ],
          })

          expect(report.clean).toBe(false)
          const staleFindings = report.findings.filter((f) => f.kind === "stale-doc-reference")
          expect(staleFindings).toHaveLength(4)

          const fileFinding = staleFindings.find(
            (f) => f.nodeId === "ADR-0002:libs/sample/deleted.ts",
          )
          expect(fileFinding).toBeDefined()
          expect(fileFinding?.message).toContain(
            'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent enforced_by file "libs/sample/deleted.ts".',
          )

          const spanFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:Missing.span")
          expect(spanFinding).toBeDefined()
          expect(spanFinding?.message).toContain(
            'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent EffectFn span "Missing.span".',
          )

          const svcFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:MissingService")
          expect(svcFinding).toBeDefined()
          expect(svcFinding?.message).toContain(
            'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent ServiceTag "MissingService".',
          )

          const errFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:MissingError")
          expect(errFinding).toBeDefined()
          expect(errFinding?.message).toContain(
            'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent TaggedError "MissingError".',
          )

          // Neither proposed nor superseded doc should produce findings
          expect(staleFindings.some((f) => f.nodeId.startsWith("SPEC-0001"))).toBe(false)
          expect(staleFindings.some((f) => f.nodeId.startsWith("ADR-0000"))).toBe(false)
        }),
    )

    it("loads governance docs safely from disk even when folders do not exist", () => {
      const docs = loadGovernanceDocsFromDisk("/non/existent/repo/root", testHostIo)
      expect(Array.isArray(docs)).toBe(true)
      expect(docs).toHaveLength(0)

      const repoRoot = "/home/roan/WebstormProjects/effect-ts-harness"
      const repoDocs = loadGovernanceDocsFromDisk(repoRoot, testHostIo)
      expect(Array.isArray(repoDocs)).toBe(true)
    })

    it("discovers co-located and global governance docs while ignoring README.md and TEMPLATE.md", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "harness-gov-docs-"))
      try {
        mkdirSync(join(tempDir, "docs", "adr"), { recursive: true })
        mkdirSync(join(tempDir, "docs", "specs"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "es", "docs", "adr"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "es", "docs", "specs"), { recursive: true })

        writeFileSync(
          join(tempDir, "docs", "adr", "0001-monorepo-taxonomy.md"),
          `---
id: ADR-0001
status: accepted
---
# Monorepo Taxonomy
`,
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "adr", "0001-do-event-store.md"),
          `---
id: ADR-ES-0001
status: accepted
---
# DO Event Store
`,
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "specs", "2026-10-27-aggregate-root.md"),
          `---
id: SPEC-ES-0001
status: proposed
---
# Aggregate Root Spec
`,
        )

        writeFileSync(
          join(tempDir, "docs", "adr", "README.md"),
          `---
id: ADR-README
status: accepted
---
# README
`,
        )
        writeFileSync(
          join(tempDir, "docs", "adr", "TEMPLATE.md"),
          `---
id: ADR-TEMPLATE
status: accepted
---
# TEMPLATE
`,
        )
        writeFileSync(
          join(tempDir, "docs", "specs", "README.md"),
          `---
id: SPEC-README
status: accepted
---
# README
`,
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "adr", "README.md"),
          `---
id: LIB-ADR-README
status: accepted
---
# README
`,
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "specs", "TEMPLATE.md"),
          `---
id: LIB-SPEC-TEMPLATE
status: accepted
---
# TEMPLATE
`,
        )

        const docs = loadGovernanceDocsFromDisk(tempDir, testHostIo)
        expect(docs).toHaveLength(3)

        const paths = docs.map((d) => d.docPath)
        expect(paths).toEqual([
          "docs/adr/0001-monorepo-taxonomy.md",
          "libs/es/docs/adr/0001-do-event-store.md",
          "libs/es/docs/specs/2026-10-27-aggregate-root.md",
        ])

        const globalAdr = docs.find((d) => d.docPath === "docs/adr/0001-monorepo-taxonomy.md")
        expect(globalAdr).toBeDefined()
        expect(globalAdr?.id).toBe("ADR-0001")
        expect(globalAdr?.status).toBe("accepted")

        const colocatedAdr = docs.find(
          (d) => d.docPath === "libs/es/docs/adr/0001-do-event-store.md",
        )
        expect(colocatedAdr).toBeDefined()
        expect(colocatedAdr?.id).toBe("ADR-ES-0001")
        expect(colocatedAdr?.status).toBe("accepted")

        const colocatedSpec = docs.find(
          (d) => d.docPath === "libs/es/docs/specs/2026-10-27-aggregate-root.md",
        )
        expect(colocatedSpec).toBeDefined()
        expect(colocatedSpec?.id).toBe("SPEC-ES-0001")
        expect(colocatedSpec?.status).toBe("proposed")

        expect(paths.some((p) => p.endsWith("README.md"))).toBe(false)
        expect(paths.some((p) => p.endsWith("TEMPLATE.md"))).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  it("parseGovernanceDocFrontmatterChecked and loadGovernanceDocsChecked emit governance-doc-read-error on malformed frontmatter / invalid status", () => {
    const malformed = parseGovernanceDocFrontmatterChecked(
      "docs/specs/SPEC-9999.md",
      "no frontmatter",
    )
    expect(malformed._tag).toBe("Err")

    const invalidStatus = parseGovernanceDocFrontmatterChecked(
      "docs/specs/SPEC-9999.md",
      "---\nid: SPEC-9999\ntitle: Bad\nstatus: bogus-status\n---\n",
    )
    expect(invalidStatus._tag).toBe("Err")

    // Strict YAML frontmatter rejections & # preservation inside quotes
    expect(
      parseGovernanceDocFrontmatterChecked(
        "docs/specs/SPEC-9999.md",
        "---\nid: SPEC-9999\nstatus: proposed\n{{invalid}}\n---\n",
      )._tag,
    ).toBe("Err")
    expect(
      parseGovernanceDocFrontmatterChecked(
        "docs/specs/SPEC-9999.md",
        "---\nid: SPEC-9999\nstatus: proposed\nenforced_by: [foo\n---\n",
      )._tag,
    ).toBe("Err")
    expect(
      parseGovernanceDocFrontmatterChecked(
        "docs/specs/SPEC-9999.md",
        "---\nid: SPEC-9999\nstatus: proposed\nenforced_by: libs/a.ts\n---\n",
      )._tag,
    ).toBe("Err")
    expect(
      parseGovernanceDocFrontmatterChecked(
        "docs/specs/SPEC-9999.md",
        "---\nid: SPEC-9999\nstatus: proposed\nspans: foo\n---\n",
      )._tag,
    ).toBe("Err")
    expect(
      parseGovernanceDocFrontmatterChecked(
        "docs/specs/SPEC-9999.md",
        "---\nid: SPEC-9999\nstatus: proposed\n",
      )._tag,
    ).toBe("Err")

    const quotedHash = parseGovernanceDocFrontmatterChecked(
      "docs/specs/SPEC-9999.md",
      '---\nid: "SPEC#9999"\nstatus: proposed\n---\n',
    )
    match(quotedHash)
      .with({ _tag: "Ok" }, ({ doc }) => {
        expect(doc.id).toBe("SPEC#9999")
      })
      .with({ _tag: "Err" }, ({ reason }) => {
        expect.unreachable(`Expected Ok for quoted #, got: ${reason}`)
      })
      .exhaustive()

    const tempDir = mkdtempSync(join(tmpdir(), "gc-gov-doc-err-"))
    try {
      const specsDir = join(tempDir, "docs", "specs")
      mkdirSync(specsDir, { recursive: true })
      const badDoc = join(specsDir, "SPEC-0001.md")
      writeFileSync(
        badDoc,
        "---\nid: SPEC-0001\ntitle: Bad Status\nstatus: invalid_status\n---\n",
        "utf8",
      )
      const symDocPath = join(specsDir, "SPEC-0002.md")
      writeFileSync(symDocPath, "---\nid: SPEC-0002\nstatus: proposed\n---\n", "utf8")

      const symHostIo: typeof testHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === symDocPath ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      const loaded = loadGovernanceDocsChecked(tempDir, symHostIo)
      const err1 = loaded.findings.find(
        (f) => f.kind === "governance-doc-read-error" && f.location === "docs/specs/SPEC-0001.md",
      )
      expect(err1).toBeDefined()
      expect(err1?.message).toContain("invalid_status")

      const errSym = loaded.findings.find(
        (f) => f.kind === "governance-doc-read-error" && f.location === "docs/specs/SPEC-0002.md",
      )
      expect(errSym).toBeDefined()
      expect(errSym?.message).toContain("symlink")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }

    // gc-rule-digest: missing file in GATE_RULE_SOURCE_FILES fails closed
    const digestDir = mkdtempSync(join(tmpdir(), "gc-rule-digest-"))
    try {
      const firstRel = GATE_RULE_SOURCE_FILES[0]!
      mkdirSync(dirname(join(digestDir, firstRel)), { recursive: true })
      writeFileSync(join(digestDir, firstRel), "// partial\n", "utf8")
      const digestFindings: Array<GcFinding> = []
      evaluateGateRuleDigestCheck(digestDir, testHostIo, digestFindings)
      expect(digestFindings.length).toBeGreaterThan(0)
      expect(digestFindings.some((f) => f.kind === "stale-gate-rule-version")).toBe(true)
    } finally {
      rmSync(digestDir, { recursive: true, force: true })
    }

    // gc-rule-digest: extractGateRuleIdsFromSources extracts GateRuleId.make and [rule-id] from syntaxBansSource
    const ruleIds = extractGateRuleIdsFromSources(
      'GateRuleId.make("sample-gate-rule")',
      "",
      "",
      '"[sample-oxlint-rule] bad"',
    )
    expect(ruleIds).toContain("sample-gate-rule")
    expect(ruleIds).toContain("sample-oxlint-rule")
  })

  it("gc-helpers: buildGraphReachabilityContext, augmentReachabilityWithInference, findClosestMatch boundary, and extractTopLevelObjectAnalysis", () => {
    const graph = buildHarnessGraph({
      services: [
        { tagId: "SvcA", name: "SvcA", packageTag: "service", file: "libs/a/service/src/svc.ts" },
        { tagId: "SvcB", name: "SvcB", packageTag: "service", file: "libs/a/service/src/svc.ts" },
      ],
      errors: [
        {
          errorTag: "ErrA",
          file: "libs/a/contract/src/err.ts",
        },
      ],
      fns: [
        {
          qualname: "libs/a/domain/src/fn.ts#fnA",
          spanName: "A.fnA",
          packageTag: "domain",
          file: "libs/a/domain/src/fn.ts",
          line: 1,
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/a/domain/src/callee.ts#calleeOnlyFn",
          spanName: "A.calleeOnlyFn",
          packageTag: "domain",
          file: "libs/a/domain/src/callee.ts",
          line: 1,
          successType: "void",
          isStub: false,
        },
      ],
      tracedCalls: [
        {
          callerQualname: "libs/a/domain/src/fn.ts#fnA",
          calleeQualname: "libs/a/domain/src/callee.ts#calleeOnlyFn",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      layers: [
        {
          qualname: "LayerA",
          file: "libs/a/infra/src/layer.ts",
          packageTag: "infra",
        },
      ],
      layerFlows: [
        {
          relationId: RelationId.make("lf:LayerA"),
          layerQualname: "LayerA",
          providesServices: ["SvcA"],
          requiresServices: ["SvcB"],
          emittedErrors: ["ErrA"],
          file: "libs/a/infra/src/layer.ts",
          line: 1,
        },
      ],
      tests: [
        {
          testId: "test:prop1",
          testName: "prop1",
          testFile: "libs/a/domain/test/fn.test.ts",
          isPropertyTest: true,
          hasNonPrimitiveArbitrary: true,
        },
      ],
      exercisesSpans: [
        {
          testId: "test:prop1",
          calleeQualname: "libs/a/domain/src/fn.ts#fnA",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      httpEndpointTuples: [
        {
          relationId: RelationId.make("ep:Api.get"),
          endpointGroup: "Api",
          endpointName: "get",
          method: "GET",
          path: "/a",
          file: "libs/a/app/src/http.ts",
          line: 1,
          handlerQualname: "libs/a/domain/src/fn.ts#fnA",
          requestSchemaQualnames: [],
          responseSchemaQualnames: [],
          errorTags: ["ErrA"],
        },
      ],
    })

    const ctx = buildGraphReachabilityContext(graph)
    const nodes = [...Graph.nodes(graph.graph)]
    const fnIdx = nodes.find(
      ([, n]) => n._tag === "EffectFn" && n.qualname === "libs/a/domain/src/fn.ts#fnA",
    )![0]
    const calleeIdx = nodes.find(
      ([, n]) => n._tag === "EffectFn" && n.qualname === "libs/a/domain/src/callee.ts#calleeOnlyFn",
    )![0]
    const errIdx = nodes.find(([, n]) => n._tag === "TaggedError" && n.errorTag === "ErrA")![0]
    expect(ctx.incomingTestOrCall.get(fnIdx)).toBeGreaterThanOrEqual(2)
    expect(ctx.incomingTestOrCall.get(calleeIdx)).toBe(1)
    expect(ctx.incomingRichPropertyTests.get(fnIdx)).toBe(1)
    expect(ctx.incomingFailsWith.get(errIdx)).toBeGreaterThanOrEqual(2)

    // Pre-populate counts to 2 so augmentReachabilityWithInference must NOT clobber >=1 back to 1
    const svcAIdx = nodes.find(([, n]) => n._tag === "ServiceTag" && n.tagId === "SvcA")![0]
    const svcBIdx = nodes.find(([, n]) => n._tag === "ServiceTag" && n.tagId === "SvcB")![0]
    const keyFor = (targetIdx: number): NodeKey =>
      NodeKey.make([...graph.nodeIndexByKey.entries()].find(([, idx]) => idx === targetIdx)![0])
    const dummyProof = {
      proofId: ProofId.make("p1"),
      ruleId: DatalogRuleId.make("r1"),
      stratum: 0 as const,
      conclusion: "c",
      premises: [],
      bindings: {},
      parentProofIds: [],
    }
    const customInferred = {
      effectiveRequires: [
        {
          callerKey: NodeKey.make("libs/a/domain/src/fn.ts#fnA"),
          serviceKey: keyFor(svcAIdx),
          isDirect: true,
          path: [],
          proof: dummyProof,
        },
      ],
      effectiveFailsWith: [
        {
          callerKey: NodeKey.make("libs/a/domain/src/fn.ts#fnA"),
          errorKey: keyFor(errIdx),
          isDirect: true,
          path: [],
          proof: dummyProof,
        },
      ],
      effectiveLayerRequires: [],
      effectiveLayerDeps: [
        {
          layerKey: NodeKey.make("LayerA"),
          requiredServiceKey: keyFor(svcBIdx),
          isDirect: true,
          path: [],
          proof: dummyProof,
        },
      ],
      effectiveTestReach: [
        {
          testKey: NodeKey.make("test:prop1"),
          targetSpanKey: keyFor(calleeIdx),
          isPropertyTest: true,
          isDirect: true,
          path: [],
          proof: dummyProof,
        },
      ],
      antiPatterns: [],
      suggestedEdges: [],
      proofs: [],
    }
    ctx.incomingRequires.set(svcAIdx, 2)
    ctx.incomingFailsWith.set(errIdx, 2)
    ctx.incomingLayerRequires.set(svcBIdx, 2)
    ctx.incomingPropertyTests.set(calleeIdx, 2)
    augmentReachabilityWithInference(ctx, graph, customInferred)
    expect(ctx.incomingRequires.get(svcAIdx)).toBe(2)
    expect(ctx.incomingFailsWith.get(errIdx)).toBe(2)
    expect(ctx.incomingLayerRequires.get(svcBIdx)).toBe(2)
    expect(ctx.incomingPropertyTests.get(calleeIdx)).toBe(2)

    // Fresh counts 0 -> 1
    ctx.incomingRequires.set(svcAIdx, 0)
    ctx.incomingFailsWith.set(errIdx, 0)
    ctx.incomingLayerRequires.set(svcBIdx, 0)
    ctx.incomingPropertyTests.set(calleeIdx, 0)
    augmentReachabilityWithInference(ctx, graph, customInferred)
    expect(ctx.incomingRequires.get(svcAIdx)).toBe(1)
    expect(ctx.incomingFailsWith.get(errIdx)).toBe(1)
    expect(ctx.incomingLayerRequires.get(svcBIdx)).toBe(1)
    expect(ctx.incomingPropertyTests.get(calleeIdx)).toBe(1)

    // findClosestMatch exact threshold boundary (distance === threshold)
    expect(findClosestMatch("abc", ["axc", "zzz"], 1)).toBe("axc")

    // extractTopLevelObjectAnalysis with nested braces, brackets, parens before finalKey
    const objAnalysis = extractTopLevelObjectAnalysis(
      "a: f({ x: 1 }), b: g([1, 2]), c: h((1 + 2)), finalKey: true",
    )
    expect(objAnalysis.keys).toEqual(["a", "b", "c", "finalKey"])
  })
})
