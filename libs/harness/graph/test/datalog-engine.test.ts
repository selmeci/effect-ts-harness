import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  ConfidenceMillis,
  DatalogRuleId,
  NodeKey,
  PageRankScoreMillis,
  ProofHeight,
  ProofId,
  RelationId,
  RoleName,
  STANDARD_DATALOG_RULES,
  buildHarnessGraph,
  decideGraphInference,
  flixConfidenceReducer,
  minHeightReducer,
} from "../src/index.js"

const CallChainHopSpec = Schema.Struct({
  callerIdx: Schema.Literals([0, 1, 2]),
  calleeIdx: Schema.Literals([1, 2, 3]),
  serviceSuffix: Schema.Literals(["RepoA", "RepoB", "ClockSvc"]),
  errorSuffix: Schema.Literals(["NotFoundError", "ValidationError"]),
})

const CallChainSpecArray = Schema.Array(CallChainHopSpec)

describe("GraphInfer.decide (4-Stratum @electric-sql/d2ts Stratified Datalog Engine)", () => {
  it("validates ConfidenceMillis and NodeKey contract schema boundaries and rejects malformed inputs", () => {
    expect(Schema.decodeSync(ConfidenceMillis)(0)).toBe(0)
    expect(Schema.decodeSync(ConfidenceMillis)(1000)).toBe(1000)
    expect(() => Schema.decodeSync(ConfidenceMillis)(-1)).toThrow()
    expect(() => Schema.decodeSync(ConfidenceMillis)(1001)).toThrow()
    expect(() => Schema.decodeSync(ConfidenceMillis)(100.5)).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfidenceMillis)("500")).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfidenceMillis)(null)).toThrow()
    expect(() => Schema.decodeSync(ConfidenceMillis)(Number.NaN)).toThrow()
    expect(() => Schema.decodeSync(NodeKey)("")).toThrow()
  })

  it("reduces Soufflé min-height provenance annotations and Flix confidence lattice elements deterministically", () => {
    expect(minHeightReducer([])).toEqual([])
    const reducedHeight = minHeightReducer([
      [
        {
          proofHeight: ProofHeight.make(3),
          ruleId: DatalogRuleId.make("INF-01"),
          viaIntermediateKey: NodeKey.make("EffectFn:b"),
        },
        1,
      ],
      [
        {
          proofHeight: ProofHeight.make(1),
          ruleId: DatalogRuleId.make("INF-01"),
          witnessRelationId: RelationId.make("EffectSignature:a"),
          viaIntermediateKey: NodeKey.make("EffectFn:a"),
        },
        1,
      ],
      [
        {
          proofHeight: ProofHeight.make(1),
          ruleId: DatalogRuleId.make("INF-01"),
          witnessRelationId: RelationId.make("EffectSignature:0"),
          viaIntermediateKey: NodeKey.make("EffectFn:0"),
        },
        -1,
      ],
    ])
    expect(reducedHeight).toHaveLength(1)
    expect(reducedHeight[0]?.[0].proofHeight).toBe(1)
    expect(reducedHeight[0]?.[0].viaIntermediateKey).toBe(NodeKey.make("EffectFn:a"))

    expect(flixConfidenceReducer([])).toEqual([])
    const reducedFlix = flixConfidenceReducer([
      [
        {
          confidenceMillis: ConfidenceMillis.make(850),
          parentProofIds: [ProofId.make("proof:2"), ProofId.make("proof:1")],
        },
        1,
      ],
      [
        {
          confidenceMillis: ConfidenceMillis.make(960),
          parentProofIds: [ProofId.make("proof:1"), ProofId.make("proof:3")],
        },
        1,
      ],
    ])
    expect(reducedFlix).toHaveLength(1)
    expect(reducedFlix[0]?.[0].confidenceMillis).toBe(ConfidenceMillis.make(960))
    expect(reducedFlix[0]?.[0].parentProofIds).toEqual([
      ProofId.make("proof:1"),
      ProofId.make("proof:2"),
      ProofId.make("proof:3"),
    ])
  })

  it.effect(
    "converges on cyclic call graphs in Stratum S_1 and derives transitive EffectiveRequires (INF-01), EffectiveFailsWith (INF-02), EffectiveLayerDeps, and EffectiveTestReach (INF-03)",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/a.ts#fnA",
              spanName: "Sample.fnA",
              file: "libs/sample/domain/src/a.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/b.ts#fnB",
              spanName: "Sample.fnB",
              file: "libs/sample/domain/src/b.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/c.ts#fnC",
              spanName: "Sample.fnC",
              file: "libs/sample/domain/src/c.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "SampleRepo",
              name: "SampleRepo",
              packageTag: "service",
              file: "libs/sample/service/src/repo.ts",
            },
            {
              tagId: "ServiceB",
              name: "ServiceB",
              packageTag: "service",
              file: "libs/sample/service/src/b.ts",
            },
            {
              tagId: "ServiceC",
              name: "ServiceC",
              packageTag: "service",
              file: "libs/sample/service/src/c.ts",
            },
          ],
          layers: [
            {
              qualname: "libs/sample/infra/src/layerA.ts#LayerA",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layerA.ts",
            },
            {
              qualname: "libs/sample/infra/src/layerB.ts#LayerB",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layerB.ts",
            },
            {
              qualname: "libs/sample/infra/src/layerC.ts#LayerC",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layerC.ts",
            },
          ],
          errors: [
            {
              errorTag: "SampleNotFoundError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          tests: [
            {
              testId: "libs/sample/domain/test/a.test.ts#exercises fnA",
              testFile: "libs/sample/domain/test/a.test.ts",
              testName: "exercises fnA",
              isPropertyTest: true,
            },
          ],
          // Cyclic call graph: fnA -> fnB -> fnA, and fnB -> fnC
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/a.ts#fnA",
              calleeQualname: "libs/sample/domain/src/b.ts#fnB",
              callCount: 1,
              receiverLayer: null,
            },
            {
              callerQualname: "libs/sample/domain/src/b.ts#fnB",
              calleeQualname: "libs/sample/domain/src/a.ts#fnA",
              callCount: 1,
              receiverLayer: null,
            },
            {
              callerQualname: "libs/sample/domain/src/b.ts#fnB",
              calleeQualname: "libs/sample/domain/src/c.ts#fnC",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/c.ts#fnC",
              tagId: "SampleRepo",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/c.ts#fnC",
              errorTag: "SampleNotFoundError",
            },
          ],
          providesService: [
            {
              layerQualname: "libs/sample/infra/src/layerB.ts#LayerB",
              tagId: "ServiceB",
            },
            {
              layerQualname: "libs/sample/infra/src/layerC.ts#LayerC",
              tagId: "ServiceC",
            },
          ],
          layerRequires: [
            {
              layerQualname: "libs/sample/infra/src/layerA.ts#LayerA",
              tagId: "ServiceB",
            },
            {
              layerQualname: "libs/sample/infra/src/layerB.ts#LayerB",
              tagId: "ServiceC",
            },
          ],
          exercisesSpans: [
            {
              testId: "libs/sample/domain/test/a.test.ts#exercises fnA",
              calleeQualname: "libs/sample/domain/src/a.ts#fnA",
              callCount: 1,
              receiverLayer: null,
            },
          ],
        })

        expect(STANDARD_DATALOG_RULES.length).toBe(15)

        const res = yield* decideGraphInference(graph)

        // fnA transitively requires SampleRepo via fnB -> fnC
        const fnAReq = res.effectiveRequires.find(
          (r) =>
            r.callerKey === NodeKey.make("EffectFn:libs/sample/domain/src/a.ts#fnA") &&
            r.serviceKey === NodeKey.make("ServiceTag:SampleRepo"),
        )
        expect(fnAReq).toBeDefined()
        expect(fnAReq?.isDirect).toBe(false)
        expect(fnAReq?.path).toEqual([
          "libs/sample/domain/src/a.ts#fnA",
          "libs/sample/domain/src/b.ts#fnB",
          "libs/sample/domain/src/c.ts#fnC",
          "SampleRepo",
        ])

        // fnA transitively fails with SampleNotFoundError via fnB -> fnC
        const fnAFail = res.effectiveFailsWith.find(
          (f) =>
            f.callerKey === NodeKey.make("EffectFn:libs/sample/domain/src/a.ts#fnA") &&
            f.errorKey === NodeKey.make("TaggedError:SampleNotFoundError"),
        )
        expect(fnAFail).toBeDefined()
        expect(fnAFail?.isDirect).toBe(false)
        expect(fnAFail?.path).toEqual([
          "libs/sample/domain/src/a.ts#fnA",
          "libs/sample/domain/src/b.ts#fnB",
          "libs/sample/domain/src/c.ts#fnC",
          "SampleNotFoundError",
        ])

        // LayerA transitively depends on ServiceC via LayerB -> LayerC
        const layerDep = res.effectiveLayerDeps.find(
          (d) =>
            d.layerKey === NodeKey.make("ServiceLayer:libs/sample/infra/src/layerA.ts#LayerA") &&
            d.requiredServiceKey === NodeKey.make("ServiceTag:ServiceC"),
        )
        expect(layerDep).toBeDefined()
        expect(layerDep?.isDirect).toBe(false)
        expect(layerDep?.providerLayerKey).toBe(
          NodeKey.make("ServiceLayer:libs/sample/infra/src/layerC.ts#LayerC"),
        )
        expect(layerDep?.proof.ruleId).toBe(DatalogRuleId.make("INF-03"))

        // Test on fnA transitively reaches fnA, fnB, and fnC -> zero untested-domain-span antipatterns
        expect(res.effectiveTestReach).toHaveLength(3)
        expect(res.antiPatterns.filter((a) => a.ruleId === "untested-domain-span")).toHaveLength(0)
      }),
  )

  it.effect(
    "derives Stratum S_2 antipatterns (INF-04..09) and Stratum S_3 normative missing-edge completions (COMP-01..05) with DerivationProof lineage",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 10,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decide",
              spanName: "Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 25,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#aggregateHandle",
              spanName: "Aggregate.handleCommand",
              file: "libs/sample/domain/src/order.ts",
              line: 40,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "OrderRepository",
              name: "OrderRepository",
              packageTag: "service",
              file: "libs/sample/service/src/order-repo.ts",
            },
            {
              tagId: "AuditService",
              name: "AuditService",
              packageTag: "service",
              file: "libs/sample/service/src/audit.ts",
            },
            {
              tagId: "SqlClient",
              name: "SqlClient",
              packageTag: "infra",
              file: "libs/sample/infra/src/sql.ts",
            },
            {
              tagId: "EventBus",
              name: "EventBus",
              packageTag: "infra",
              file: "libs/sample/infra/src/bus.ts",
            },
            {
              tagId: "CycleSvcA",
              name: "CycleSvcA",
              packageTag: "service",
              file: "libs/sample/service/src/cycle.ts",
            },
            {
              tagId: "CycleSvcB",
              name: "CycleSvcB",
              packageTag: "service",
              file: "libs/sample/service/src/cycle.ts",
            },
          ],
          layers: [
            {
              qualname: "libs/sample/infra/src/layer.ts#OrderLive",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layer.ts",
            },
            {
              qualname: "libs/sample/infra/src/layer.ts#CycleLayerA",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layer.ts",
            },
            {
              qualname: "libs/sample/infra/src/layer.ts#CycleLayerB",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/layer.ts",
            },
          ],
          errors: [
            {
              errorTag: "OrderDeclinedError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          adrDocs: [
            {
              id: "sample:ADR-0001",
              title: "Order Governance",
              status: "accepted",
              path: "libs/sample/docs/adr/0001.md",
              enforcedByFiles: ["libs/sample/domain/src/order.ts"],
              referencedSpans: ["Order.checkout"],
              referencedServices: ["OrderRepository"],
              referencedErrors: ["OrderDeclinedError"],
            },
          ],
          earsSpecs: [
            {
              id: "sample:SPEC-0001",
              title: "Order Checkout Spec",
              status: "accepted",
              path: "libs/sample/docs/specs/0001.md",
              enforcedByFiles: ["libs/sample/domain/src/order.ts"],
              referencedSpans: ["Order.checkout", "Order.missingSpan"],
              referencedServices: ["OrderRepository", "AuditService"],
              referencedErrors: ["OrderDeclinedError"],
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "OrderRepository",
            },
            {
              fnQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "SqlClient",
            },
            {
              fnQualname: "libs/sample/domain/src/order.ts#decide",
              tagId: "OrderRepository",
            },
            {
              fnQualname: "libs/sample/domain/src/order.ts#aggregateHandle",
              tagId: "EventBus",
            },
          ],
          providesService: [
            {
              layerQualname: "libs/sample/infra/src/layer.ts#CycleLayerA",
              tagId: "CycleSvcA",
            },
            {
              layerQualname: "libs/sample/infra/src/layer.ts#CycleLayerB",
              tagId: "CycleSvcB",
            },
          ],
          layerRequires: [
            {
              layerQualname: "libs/sample/infra/src/layer.ts#OrderLive",
              tagId: "OrderRepository",
            },
            {
              layerQualname: "libs/sample/infra/src/layer.ts#CycleLayerA",
              tagId: "CycleSvcB",
            },
            {
              layerQualname: "libs/sample/infra/src/layer.ts#CycleLayerB",
              tagId: "CycleSvcA",
            },
          ],
          specifiesSymbols: [
            {
              specId: "sample:SPEC-0001",
              targetKey: "libs/sample/domain/src/order.ts#checkout",
              targetKind: "span",
            },
          ],
          migrationTuples: [
            {
              relationId: RelationId.make("MigrationTuple:1_drop_legacy"),
              migrationId: "1_drop_legacy",
              engine: "SqliteMigrator",
              moduleFile: "libs/sample/infra/src/migrations.ts",
              isDestructive: true,
              verifyingTestQualnames: [],
              line: 15,
            },
          ],
        })

        const res = yield* decideGraphInference(graph)

        // Stratum S_2 antipatterns (INF-04..09) with DerivationProof DAG verification:
        const domInfraAp = res.antiPatterns.find((a) => a.ruleId === "domain-requires-infra")
        expect(domInfraAp).toBeDefined()
        expect(domInfraAp?.datalogRuleId).toBe(DatalogRuleId.make("INF-04"))
        expect(domInfraAp?.proof.stratum).toBe(2)
        expect(domInfraAp?.proof.parentProofIds.length).toBeGreaterThan(0)

        const impureDeciderAp = res.antiPatterns.find((a) => a.ruleId === "impure-decider")
        expect(impureDeciderAp).toBeDefined()
        expect(impureDeciderAp?.datalogRuleId).toBe(DatalogRuleId.make("INF-05"))
        expect(impureDeciderAp?.proof.stratum).toBe(2)
        expect(impureDeciderAp?.proof.parentProofIds.length).toBeGreaterThan(0)

        const layerCycleAp = res.antiPatterns.find((a) => a.ruleId === "layer-cycle")
        expect(layerCycleAp).toBeDefined()
        expect(layerCycleAp?.datalogRuleId).toBe(DatalogRuleId.make("INF-06"))
        expect(layerCycleAp?.proof.stratum).toBe(2)

        const aggBusAp = res.antiPatterns.find((a) => a.ruleId === "aggregate-direct-bus-publish")
        expect(aggBusAp).toBeDefined()
        expect(aggBusAp?.datalogRuleId).toBe(DatalogRuleId.make("INF-08"))
        expect(aggBusAp?.proof.stratum).toBe(2)

        expect(res.antiPatterns.some((a) => a.ruleId === "missing-layer-provider")).toBe(true)
        expect(
          res.antiPatterns.some(
            (a) => a.ruleId === "unmapped-spec-symbol" && a.path.includes("Order.missingSpan"),
          ),
        ).toBe(true)
        expect(res.antiPatterns.some((a) => a.ruleId === "untested-domain-span")).toBe(true)
        expect(res.antiPatterns.some((a) => a.ruleId === "unverified-migration")).toBe(true)

        // Stratum S_3 normative missing-edge completions:
        const comp01 = res.suggestedEdges.find(
          (s) => s.ruleId === "COMP-01" && s.role === RoleName.make("fails-with"),
        )
        const comp02 = res.suggestedEdges.find(
          (s) => s.ruleId === "COMP-02" && s.role === RoleName.make("requires-service"),
        )
        const comp03 = res.suggestedEdges.find(
          (s) =>
            s.ruleId === "COMP-03" &&
            s.role === RoleName.make("provided-service") &&
            s.targetEntityKey === NodeKey.make("ServiceTag:OrderRepository"),
        )
        const comp04 = res.suggestedEdges.find(
          (s) =>
            s.ruleId === "COMP-04" &&
            s.role === RoleName.make("verifying-test") &&
            s.targetEntityKey ===
              NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
        )
        const comp05 = res.suggestedEdges.find(
          (s) => s.ruleId === "COMP-05" && s.role === RoleName.make("governing-adr"),
        )

        expect(comp01).toBeDefined()
        expect(comp01?.targetEntityKey).toBe(NodeKey.make("TaggedError:OrderDeclinedError"))
        expect(comp01?.confidenceMillis).toBeGreaterThanOrEqual(900)

        expect(comp02).toBeDefined()
        expect(comp02?.targetEntityKey).toBe(NodeKey.make("ServiceTag:AuditService"))
        expect(comp02?.confidenceMillis).toBeGreaterThanOrEqual(850)

        expect(comp03).toBeDefined()
        expect(comp03?.targetEntityKey).toBe(NodeKey.make("ServiceTag:OrderRepository"))
        expect(comp03?.confidenceMillis).toBeGreaterThanOrEqual(800)

        expect(comp04).toBeDefined()
        expect(comp04?.targetEntityKey).toBe(
          NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
        )
        expect(comp04?.confidenceMillis).toBeGreaterThanOrEqual(850)
        expect(comp04?.proof.parentProofIds.length).toBeGreaterThan(0)

        expect(comp05).toBeDefined()
        expect(comp05?.targetEntityKey).toBe(NodeKey.make("AdrDoc:sample:ADR-0001"))
        expect(comp05?.confidenceMillis).toBeGreaterThanOrEqual(900)

        // Proofs are sorted by stratum and every parentProofId exists in proofs
        const proofIdSet = new Set(res.proofs.map((p) => p.proofId))
        for (const p of res.proofs) {
          for (const parentId of p.parentProofIds) {
            expect(proofIdSet.has(parentId)).toBe(true)
          }
        }
      }),
  )

  it.effect.prop(
    "maintains deterministic fixed-point closures and proof integrity across arbitrary call-chain graphs",
    [CallChainSpecArray],
    ([hops]) =>
      Effect.gen(function* () {
        const fns = [0, 1, 2, 3].map((idx) => ({
          qualname: `libs/sample/domain/src/fn${idx}.ts#fn${idx}`,
          spanName: `Sample.fn${idx}`,
          file: `libs/sample/domain/src/fn${idx}.ts`,
          line: 1,
          packageTag: "domain" as const,
          successType: "void",
          isStub: true,
        }))

        const services = ["RepoA", "RepoB", "ClockSvc"].map((tagId) => ({
          tagId,
          name: tagId,
          packageTag: "service" as const,
          file: "libs/sample/service/src/index.ts",
        }))

        const errors = ["NotFoundError", "ValidationError"].map((errorTag) => ({
          errorTag,
          file: "libs/sample/contract/src/index.ts",
        }))

        const tracedCalls = hops.map((h) => ({
          callerQualname: `libs/sample/domain/src/fn${h.callerIdx}.ts#fn${h.callerIdx}`,
          calleeQualname: `libs/sample/domain/src/fn${h.calleeIdx}.ts#fn${h.calleeIdx}`,
          callCount: 1,
          receiverLayer: null,
        }))

        const requiresService = hops.map((h) => ({
          fnQualname: `libs/sample/domain/src/fn${h.calleeIdx}.ts#fn${h.calleeIdx}`,
          tagId: h.serviceSuffix,
        }))

        const failsWith = hops.map((h) => ({
          callerQualname: `libs/sample/domain/src/fn${h.calleeIdx}.ts#fn${h.calleeIdx}`,
          errorTag: h.errorSuffix,
        }))

        const graph = buildHarnessGraph({
          fns,
          services,
          errors,
          tracedCalls,
          requiresService,
          failsWith,
        })

        const first = yield* decideGraphInference(graph)
        const second = yield* decideGraphInference(graph)

        // Deterministic idempotence
        expect(first).toEqual(second)

        // Every direct hop's caller must transitively require the callee's service and fail with callee's error
        for (const h of hops) {
          const callerKey = NodeKey.make(
            `EffectFn:libs/sample/domain/src/fn${h.callerIdx}.ts#fn${h.callerIdx}`,
          )
          const svcKey = NodeKey.make(`ServiceTag:${h.serviceSuffix}`)
          const errKey = NodeKey.make(`TaggedError:${h.errorSuffix}`)

          expect(
            first.effectiveRequires.some(
              (r) => r.callerKey === callerKey && r.serviceKey === svcKey,
            ),
          ).toBe(true)
          expect(
            first.effectiveFailsWith.some(
              (f) => f.callerKey === callerKey && f.errorKey === errKey,
            ),
          ).toBe(true)
        }

        // F-17 Soundness Assertion: Every derived effective requirement or error propagation
        // must correspond to a valid directed call path starting at the caller in hops.
        const directCalls = new Map<number, Set<number>>()
        const directReqs = new Map<number, Set<string>>()
        const directFails = new Map<number, Set<string>>()

        for (const h of hops) {
          if (!directCalls.has(h.callerIdx)) {
            directCalls.set(h.callerIdx, new Set())
          }
          directCalls.get(h.callerIdx)!.add(h.calleeIdx)

          if (!directReqs.has(h.calleeIdx)) {
            directReqs.set(h.calleeIdx, new Set())
          }
          directReqs.get(h.calleeIdx)!.add(h.serviceSuffix)

          if (!directFails.has(h.calleeIdx)) {
            directFails.set(h.calleeIdx, new Set())
          }
          directFails.get(h.calleeIdx)!.add(h.errorSuffix)
        }

        const reachableFrom = (startIdx: number): Set<number> => {
          const visited = new Set<number>()
          const queue = [startIdx]
          while (queue.length > 0) {
            const curr = queue.shift()!
            const targets = directCalls.get(curr)
            if (targets !== undefined) {
              for (const next of targets) {
                if (!visited.has(next)) {
                  visited.add(next)
                  queue.push(next)
                }
              }
            }
          }
          return visited
        }

        for (const req of first.effectiveRequires) {
          const matchCaller = req.callerKey.match(/#fn(\d+)$/)
          const matchSvc = req.serviceKey.match(/^ServiceTag:(.+)$/)
          expect(matchCaller).not.toBeNull()
          expect(matchSvc).not.toBeNull()
          const callerIdx = Number(matchCaller![1])
          const svcTag = matchSvc![1]
          expect(svcTag).toBeDefined()
          if (svcTag !== undefined) {
            const reachable = reachableFrom(callerIdx)
            const isValidPath =
              (directReqs.get(callerIdx)?.has(svcTag) ?? false) ||
              Array.from(reachable).some((c) => directReqs.get(c)?.has(svcTag) ?? false)
            expect(isValidPath).toBe(true)
          }
        }

        for (const fail of first.effectiveFailsWith) {
          const matchCaller = fail.callerKey.match(/#fn(\d+)$/)
          const matchErr = fail.errorKey.match(/^TaggedError:(.+)$/)
          expect(matchCaller).not.toBeNull()
          expect(matchErr).not.toBeNull()
          const callerIdx = Number(matchCaller![1])
          const errTag = matchErr![1]
          expect(errTag).toBeDefined()
          if (errTag !== undefined) {
            const reachable = reachableFrom(callerIdx)
            const isValidPath =
              (directFails.get(callerIdx)?.has(errTag) ?? false) ||
              Array.from(reachable).some((c) => directFails.get(c)?.has(errTag) ?? false)
            expect(isValidPath).toBe(true)
          }
        }
      }),
  )

  it.effect(
    "computes COMP-06 TypedHoleContextBundles via 10-iteration Personalized PageRank and merges SemanticEdgePriors overrides",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/cart.ts#addItem",
              spanName: "Cart.addItem",
              file: "libs/sample/domain/src/cart.ts",
              line: 10,
              packageTag: "domain",
              successType: "CartUpdated",
              isStub: true,
            },
            {
              qualname: "libs/sample/domain/src/cart.ts#decide",
              spanName: "Cart.decide",
              file: "libs/sample/domain/src/cart.ts",
              line: 25,
              packageTag: "domain",
              successType: "CartEvent",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "CartRepo",
              name: "CartRepo",
              packageTag: "service",
              file: "libs/sample/service/src/cart-repo.ts",
            },
          ],
          errors: [
            {
              errorTag: "CartLimitExceededError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          schemas: [
            {
              schemaName: "CartItemId",
              file: "libs/sample/contract/src/schemas.ts",
              isBranded: true,
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/cart.ts#addItem",
              tagId: "CartRepo",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/cart.ts#addItem",
              errorTag: "CartLimitExceededError",
            },
          ],
        })

        const res = yield* decideGraphInference(graph, {
          edgeConfidenceOverrides: {
            "ServiceTag:CartRepo": ConfidenceMillis.make(990),
          },
          holeTeleportationWeights: {
            [NodeKey.make("EffectFn:libs/sample/domain/src/cart.ts#decide")]:
              PageRankScoreMillis.make(980),
          },
        })

        const bundles = res.typedHoleBundles ?? []
        expect(bundles).toHaveLength(1)
        const bundle = bundles[0]!
        expect(bundle.holeQualname).toBe("libs/sample/domain/src/cart.ts#addItem")
        expect(bundle.spanName).toBe("Cart.addItem")
        expect(bundle.allowedErrorConstructors).toContain("CartLimitExceededError")
        expect(bundle.requiredServiceCapabilities).toContain("CartRepo")
        expect(bundle.estimatedTokens).toBeLessThanOrEqual(1500)
        expect(
          bundle.inhabitingCandidates.some(
            (c) =>
              c.symbolKey === NodeKey.make("EffectFn:libs/sample/domain/src/cart.ts#decide") &&
              c.inhabitsChannel === "decider-delegate" &&
              c.pprScore >= PageRankScoreMillis.make(980),
          ),
        ).toBe(true)

        const comp03 = res.suggestedEdges.find(
          (e) =>
            e.ruleId === DatalogRuleId.make("COMP-03") &&
            e.targetEntityKey === NodeKey.make("ServiceTag:CartRepo"),
        )
        expect(comp03?.confidenceMillis).toBe(ConfidenceMillis.make(990))
      }),
  )

  it.effect(
    "F-17: empty graph produces 0 antipatterns, 0 suggested edges, and iterations === 0",
    () =>
      Effect.gen(function* () {
        const emptyGraph = buildHarnessGraph({})
        const res = yield* decideGraphInference(emptyGraph)
        expect(res.antiPatterns).toHaveLength(0)
        expect(res.suggestedEdges).toHaveLength(0)
        expect(res.effectiveRequires).toHaveLength(0)
        expect(res.effectiveFailsWith).toHaveLength(0)
        expect(res.effectiveLayerDeps).toHaveLength(0)
        expect(res.effectiveTestReach).toHaveLength(0)
        expect(res.iterations).toBe(0)
      }),
  )

  it.effect(
    "detects impure-reducer (Order.evolve requiring a service) as INF-05 and domain-requires-cloud-binding (Order.checkout requiring CloudflareKV) as INF-04",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#evolve",
              spanName: "Order.evolve",
              file: "libs/sample/domain/src/order.ts",
              line: 10,
              packageTag: "domain",
              successType: "OrderState",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 30,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "OrderRepo",
              name: "OrderRepo",
              packageTag: "service",
              file: "libs/sample/service/src/order-repo.ts",
            },
            {
              tagId: "CloudflareKV",
              name: "CloudflareKV",
              packageTag: "service",
              file: "libs/sample/service/src/kv.ts",
            },
          ],
          requiresService: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#evolve",
              tagId: "OrderRepo",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "CloudflareKV",
            },
          ],
        })

        const res = yield* decideGraphInference(graph)

        const impureReducer = res.antiPatterns.find(
          (ap) =>
            ap.ruleId === "impure-reducer" &&
            ap.nodeKey === NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#evolve"),
        )
        expect(impureReducer).toBeDefined()
        expect(impureReducer?.datalogRuleId).toBe(DatalogRuleId.make("INF-05"))
        expect(impureReducer?.targetKey).toBe(NodeKey.make("ServiceTag:OrderRepo"))
        expect(impureReducer?.message).toContain("reducer (.evolve/.fold)")

        const domainCloudBinding = res.antiPatterns.find(
          (ap) =>
            ap.ruleId === "domain-requires-cloud-binding" &&
            ap.nodeKey === NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
        )
        expect(domainCloudBinding).toBeDefined()
        expect(domainCloudBinding?.datalogRuleId).toBe(DatalogRuleId.make("INF-04"))
        expect(domainCloudBinding?.targetKey).toBe(NodeKey.make("ServiceTag:CloudflareKV"))
        expect(domainCloudBinding?.message).toContain("cloud binding")
      }),
  )

  it.effect(
    "F-34: caughtErrors on EffectFnNode suppresses transitive EffectiveFailsWith (INF-02) and COMP-01 suggestions",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#caller",
              spanName: "Order.caller",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              caughtErrors: ["HandledError"],
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#callee",
              spanName: "Order.callee",
              file: "libs/sample/domain/src/order.ts",
              line: 20,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          errors: [
            {
              errorTag: "HandledError",
              file: "libs/sample/contract/src/errors.ts",
            },
            {
              errorTag: "UnhandledError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#caller",
              calleeQualname: "libs/sample/domain/src/order.ts#callee",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#callee",
              errorTag: "HandledError",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#callee",
              errorTag: "UnhandledError",
            },
          ],
        })

        const res = yield* decideGraphInference(graph)

        const callerKey = NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#caller")
        const handledKey = NodeKey.make("TaggedError:HandledError")
        const unhandledKey = NodeKey.make("TaggedError:UnhandledError")

        const hasHandled = res.effectiveFailsWith.some(
          (f) => f.callerKey === callerKey && f.errorKey === handledKey,
        )
        const hasUnhandled = res.effectiveFailsWith.some(
          (f) => f.callerKey === callerKey && f.errorKey === unhandledKey,
        )
        expect(hasHandled).toBe(false)
        expect(hasUnhandled).toBe(true)

        const comp01ForHandled = res.suggestedEdges.some(
          (e) =>
            e.ruleId === DatalogRuleId.make("COMP-01") &&
            e.sourceEntityKey === callerKey &&
            e.targetEntityKey === handledKey,
        )
        expect(comp01ForHandled).toBe(false)

        const comp01ForUnhandled = res.suggestedEdges.some(
          (e) =>
            e.ruleId === DatalogRuleId.make("COMP-01") &&
            e.sourceEntityKey === callerKey &&
            e.targetEntityKey === unhandledKey,
        )
        expect(comp01ForUnhandled).toBe(true)
      }),
  )

  it("F-20: Z-set negative weight retraction removes tuples with net multiplicity <= 0 in minHeightReducer and flixConfidenceReducer", () => {
    const itemA = {
      proofHeight: ProofHeight.make(2),
      ruleId: DatalogRuleId.make("INF-01"),
      viaIntermediateKey: NodeKey.make("EffectFn:a"),
    }
    const itemB = {
      proofHeight: ProofHeight.make(3),
      ruleId: DatalogRuleId.make("INF-01"),
      viaIntermediateKey: NodeKey.make("EffectFn:b"),
    }

    // Net multiplicity = 0 -> retracted
    expect(minHeightReducer([[itemA, 1], [itemA, -1]])).toEqual([])

    // Net multiplicity < 0 -> retracted
    expect(minHeightReducer([[itemA, 1], [itemA, -2]])).toEqual([])

    // Net multiplicity = 0 on one item while other has net > 0 -> only positive item retained
    const mixedHeight = minHeightReducer([
      [itemA, 1],
      [itemA, -1],
      [itemB, 1],
    ])
    expect(mixedHeight).toHaveLength(1)
    expect(mixedHeight[0]?.[0].viaIntermediateKey).toBe(NodeKey.make("EffectFn:b"))

    const flixItem1 = {
      confidenceMillis: ConfidenceMillis.make(800),
      parentProofIds: [ProofId.make("proof:1")],
    }
    const flixItem2 = {
      confidenceMillis: ConfidenceMillis.make(900),
      parentProofIds: [ProofId.make("proof:2")],
    }

    // Flix net <= 0 retraction
    expect(flixConfidenceReducer([[flixItem1, 1], [flixItem1, -1]])).toEqual([])
    expect(flixConfidenceReducer([[flixItem1, 1], [flixItem1, -3]])).toEqual([])

    // Flix mixed retraction
    const mixedFlix = flixConfidenceReducer([
      [flixItem1, 1],
      [flixItem1, -1],
      [flixItem2, 1],
    ])
    expect(mixedFlix).toHaveLength(1)
    expect(mixedFlix[0]?.[0].confidenceMillis).toBe(ConfidenceMillis.make(900))
    expect(mixedFlix[0]?.[0].parentProofIds).toEqual([ProofId.make("proof:2")])
  })

  it.effect(
    "F-28: every emitted proof.ruleId and proof.stratum matches its canonical entry in STANDARD_DATALOG_RULES",
    () =>
      Effect.gen(function* () {
        const ruleMap = new Map<string, { stratum: number; headPredicate: string }>()
        for (const rule of STANDARD_DATALOG_RULES) {
          ruleMap.set(rule.id, {
            stratum: rule.stratum,
            headPredicate: rule.headPredicate,
          })
        }

        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decide",
              spanName: "Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 20,
              packageTag: "domain",
              successType: "void",
              isStub: true,
            },
          ],
          services: [
            {
              tagId: "OrderRepo",
              name: "OrderRepo",
              packageTag: "service",
              file: "libs/sample/service/src/order-repo.ts",
            },
            {
              tagId: "CloudflareKV",
              name: "CloudflareKV",
              packageTag: "infra",
              file: "libs/sample/infra/src/kv.ts",
            },
          ],
          errors: [
            {
              errorTag: "CheckoutFailed",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          tests: [
            {
              testId: "libs/sample/domain/test/order.test.ts#checks out",
              testFile: "libs/sample/domain/test/order.test.ts",
              testName: "checks out",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              calleeQualname: "libs/sample/domain/src/order.ts#decide",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          requiresService: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#decide",
              tagId: "OrderRepo",
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "CloudflareKV",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#decide",
              errorTag: "CheckoutFailed",
            },
          ],
          exercisesSpans: [
            {
              testId: "libs/sample/domain/test/order.test.ts#checks out",
              calleeQualname: "libs/sample/domain/src/order.ts#checkout",
              callCount: 1,
              receiverLayer: null,
            },
          ],
        })

        const res = yield* decideGraphInference(graph)
        expect(res.proofs.length).toBeGreaterThan(0)

        for (const proof of res.proofs) {
          const canonical = ruleMap.get(proof.ruleId)
          expect(canonical).toBeDefined()
          expect(proof.stratum).toBe(canonical!.stratum)
        }
      }),
  )
})

