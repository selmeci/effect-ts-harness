import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Graph, Option, Schema } from "effect"
import {
  GraphMeasure,
  NodeKey,
  NonNegativeCount,
  RelationId,
  RewriteRuleId,
  RoleName,
  STANDARD_DPO_RULES,
  SystemOneScoreMillis,
  buildHarnessGraph,
  computeGraphMeasure,
  decideGraphInference,
  decideGraphRewrite,
  isEqualMeasure,
  isStrictlyDecreasingMeasure,
  isZeroMeasure,
  verifyDpoGluingCondition,
} from "../src/index.js"

const MeasureTupleSchema = Schema.Tuple([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
])

const toGraphMeasure = (
  tuple: readonly [number, number, number, number, number, number],
): GraphMeasure => ({
  archViolations: NonNegativeCount.make(tuple[0]),
  unmappedSpecSymbols: NonNegativeCount.make(tuple[1]),
  codeHygieneViolations: NonNegativeCount.make(tuple[2]),
  missingLayerProviders: NonNegativeCount.make(tuple[3]),
  untestedDomainSpans: NonNegativeCount.make(tuple[4]),
  unresolvedSuggestedEdges: NonNegativeCount.make(tuple[5]),
})

describe("GraphRewrite.decide (Double-Pushout Algebraic Graph Rewriting Engine — RFC-0003)", () => {
  it("registers the complete 16-rule DPO catalog (PLAN-01..04 and REP-01..11) across 4 stratified phases", () => {
    expect(STANDARD_DPO_RULES).toHaveLength(16)
    const ruleIds = STANDARD_DPO_RULES.map((r) => r.id)
    expect(ruleIds).toEqual([
      RewriteRuleId.make("PLAN-01"),
      RewriteRuleId.make("PLAN-02"),
      RewriteRuleId.make("PLAN-03"),
      RewriteRuleId.make("PLAN-04"),
      RewriteRuleId.make("REP-01"),
      RewriteRuleId.make("REP-02"),
      RewriteRuleId.make("REP-03"),
      RewriteRuleId.make("REP-04a"),
      RewriteRuleId.make("REP-04b"),
      RewriteRuleId.make("REP-05"),
      RewriteRuleId.make("REP-06"),
      RewriteRuleId.make("REP-07"),
      RewriteRuleId.make("REP-08"),
      RewriteRuleId.make("REP-09"),
      RewriteRuleId.make("REP-10"),
      RewriteRuleId.make("REP-11"),
    ])
  })

  it.effect(
    "REQ-2.1 & REQ-2.3: enforces the Bipartite Levi Relation Preservation Law (V_R in K) and Dangling Condition (Dangling(m) = empty)",
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
              inputSchema: "CheckoutInput",
              outputSchema: "CheckoutResult",
              successType: "CheckoutResult",
              isStub: false,
            },
          ],
          schemas: [
            {
              schemaName: "CheckoutInput",
              file: "libs/sample/contract/src/schemas.ts",
              isBranded: true,
            },
            {
              schemaName: "CheckoutResult",
              file: "libs/sample/contract/src/schemas.ts",
              isBranded: true,
            },
          ],
          services: [
            {
              tagId: "SqlClient",
              name: "SqlClient",
              packageTag: "infra",
              file: "libs/sample/infra/src/sql.ts",
            },
          ],
          errors: [
            {
              errorTag: "OrderDeclinedError",
              file: "libs/sample/contract/src/errors.ts",
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/order.ts#checkout",
              tagId: "SqlClient",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#checkout",
              errorTag: "OrderDeclinedError",
            },
          ],
        })

        // 1. Valid DPO rewrite (REP-01) preserves EffectSignature in K and keeps input-schema, output-schema, fails-with intact
        const outcome = yield* decideGraphRewrite(graph, "auto-repair")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const rep01Patch = rec.patches.find((p) => p.ruleId === RewriteRuleId.make("REP-01"))
        expect(rep01Patch).toBeDefined()
        const sigKey = NodeKey.make("EffectSignature:libs/sample/domain/src/order.ts#checkout")
        expect(rep01Patch?.preservedInterfaceKeys).toContain(sigKey)
        expect(rep01Patch?.deletedRelationIds).not.toContain(RelationId.make(sigKey))

        // Check that input-schema, output-schema, and fails-with edges remain attached to EffectSignature in targetGraph
        const sigIdx = outcome.targetGraph.nodeIndexByKey.get(sigKey)
        expect(sigIdx).toBeDefined()
        const remainingRoles = new Set<string>()
        for (const [, edge] of Graph.edges(outcome.targetGraph.graph)) {
          if (edge.source === sigIdx) {
            remainingRoles.add(`${edge.data.role}->${edge.data.entityKey}`)
          }
        }
        expect(remainingRoles.has("input-schema->SchemaDef:CheckoutInput")).toBe(true)
        expect(remainingRoles.has("output-schema->SchemaDef:CheckoutResult")).toBe(true)
        expect(remainingRoles.has("fails-with->TaggedError:OrderDeclinedError")).toBe(true)
        expect(remainingRoles.has("requires-service->ServiceTag:SqlClientPort")).toBe(true)
        expect(remainingRoles.has("requires-service->ServiceTag:SqlClient")).toBe(false)

        // 2. Attempting to delete a relation node that still has undeleted incident role edges fails with bipartite-relation-deleted
        const illegalRelationDeleteExit = yield* Effect.exit(
          verifyDpoGluingCondition(graph, {
            ruleId: RewriteRuleId.make("REP-01"),
            phase: "REPAIR_ARCH",
            ruleCategory: "auto-repair",
            primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
            description: "Illegal deletion of EffectSignature",
            preservedInterfaceKeys: [
              NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
            ],
            deletedEntityKeys: [],
            deletedRelationIds: [RelationId.make(sigKey)],
            deletedRoleEdges: [],
            insertedEntityNodes: [],
            insertedRelationNodes: [],
            insertedRoleEdges: [],
          }),
        )
        expect(Exit.isFailure(illegalRelationDeleteExit)).toBe(true)
        if (Exit.isFailure(illegalRelationDeleteExit)) {
          const failure = Exit.findErrorOption(illegalRelationDeleteExit)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value.reason).toBe("bipartite-relation-deleted")
          }
        }

        // 3. Attempting to delete an entity node while leaving an incident PlaysRoleEdge fails with dangling-edge
        const illegalEntityDeleteExit = yield* Effect.exit(
          verifyDpoGluingCondition(graph, {
            ruleId: RewriteRuleId.make("REP-11"),
            phase: "CLEANUP",
            ruleCategory: "cleanup",
            primaryNodeKey: NodeKey.make("ServiceTag:SqlClient"),
            description: "Illegal deletion of ServiceTag without deleting incident edge",
            preservedInterfaceKeys: [sigKey],
            deletedEntityKeys: [NodeKey.make("ServiceTag:SqlClient")],
            deletedRelationIds: [],
            deletedRoleEdges: [],
            insertedEntityNodes: [],
            insertedRelationNodes: [],
            insertedRoleEdges: [],
          }),
        )
        expect(Exit.isFailure(illegalEntityDeleteExit)).toBe(true)
        if (Exit.isFailure(illegalEntityDeleteExit)) {
          const failure = Exit.findErrorOption(illegalEntityDeleteExit)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value.reason).toBe("dangling-edge")
          }
        }

        // 4. Attempting to delete a PlaysRoleEdge without keeping its source relation in K fails with bipartite-relation-deleted
        const missingFromKExit = yield* Effect.exit(
          verifyDpoGluingCondition(graph, {
            ruleId: RewriteRuleId.make("REP-01"),
            phase: "REPAIR_ARCH",
            ruleCategory: "auto-repair",
            primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
            description: "Missing relation in K",
            preservedInterfaceKeys: [
              NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
            ],
            deletedEntityKeys: [],
            deletedRelationIds: [],
            deletedRoleEdges: [
              {
                _tag: "PlaysRole",
                role: RoleName.make("requires-service"),
                relationId: RelationId.make(sigKey),
                entityKey: NodeKey.make("ServiceTag:SqlClient"),
              },
            ],
            insertedEntityNodes: [],
            insertedRelationNodes: [],
            insertedRoleEdges: [],
          }),
        )
        expect(Exit.isFailure(missingFromKExit)).toBe(true)
        if (Exit.isFailure(missingFromKExit)) {
          const failure = Exit.findErrorOption(missingFromKExit)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value._tag).toBe("GraphRewriteError")
            expect(failure.value.reason).toBe("bipartite-relation-deleted")
          }
        }
      }),
  )

  it.effect(
    "Synthesizes full plan skeletons via PLAN-01..04 in auto-plan mode from a proposed EarsSpec",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "cart:SPEC-0001",
              title: "Shopping Cart Checkout Spec",
              status: "proposed",
              path: "libs/cart/docs/specs/0001-checkout.md",
              enforcedByFiles: ["libs/cart/domain/src/checkout.ts"],
              referencedSpans: ["Cart.checkout", "Cart.decide"],
              referencedServices: ["CartRepository"],
              referencedErrors: ["CartEmptyError"],
            },
          ],
        })

        const initialInf = yield* decideGraphInference(graph)
        const initialMeasure = computeGraphMeasure(graph, initialInf)
        expect(initialMeasure.unmappedSpecSymbols).toBeGreaterThan(0)

        const outcome = yield* decideGraphRewrite(graph, "auto-plan")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const appliedRuleIds = new Set(rec.patches.map((p) => p.ruleId))

        expect(appliedRuleIds.has(RewriteRuleId.make("PLAN-01"))).toBe(true)
        expect(appliedRuleIds.has(RewriteRuleId.make("PLAN-02"))).toBe(true)
        expect(appliedRuleIds.has(RewriteRuleId.make("PLAN-03"))).toBe(true)
        expect(appliedRuleIds.has(RewriteRuleId.make("PLAN-04"))).toBe(true)

        expect(isStrictlyDecreasingMeasure(outcome.result.initialMeasure, rec.finalMeasure)).toBe(
          true,
        )
        expect(rec.finalMeasure.unmappedSpecSymbols).toBe(0)

        // Verify synthesized nodes exist in targetGraph:
        const keys = outcome.targetGraph.nodeIndexByKey
        expect(
          keys.has(NodeKey.make("EffectFn:libs/domain/src/cart_checkout.ts#Cart_checkout")),
        ).toBe(true)
        expect(keys.has(NodeKey.make("EffectFn:libs/domain/src/cart.ts#decideCart"))).toBe(true)
        expect(keys.has(NodeKey.make("EffectFn:libs/domain/src/cart.ts#evolveCart"))).toBe(true)
        expect(keys.has(NodeKey.make("TaggedError:CartEmptyError"))).toBe(true)
        expect(keys.has(NodeKey.make("ServiceTag:CartRepository"))).toBe(true)
      }),
  )

  it.effect(
    "Repairs architectural and code-hygiene violations via REP-01, REP-02, REP-03, REP-05, REP-06, REP-07, REP-08, REP-09, REP-10 in auto-repair mode",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#decide",
              spanName: "Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 10,
              packageTag: "domain",
              successType: "OrderEvent",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decideUntraced",
              spanName: "untraced",
              file: "libs/sample/domain/src/order.ts",
              line: 20,
              packageTag: "domain",
              successType: "OrderEvent",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#aggregatePublish",
              spanName: "Aggregate.publish",
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
              tagId: "EventBus",
              name: "EventBus",
              packageTag: "infra",
              file: "libs/sample/infra/src/bus.ts",
            },
          ],
          schemas: [
            {
              schemaName: "RawOrderId",
              file: "libs/sample/contract/src/schemas.ts",
              packageTag: "contract",
              isBranded: false,
            },
          ],
          earsSpecs: [
            {
              id: "sample:SPEC-0002",
              title: "Order Spec",
              status: "accepted",
              path: "libs/sample/docs/specs/0002.md",
              enforcedByFiles: ["libs/sample/domain/src/order.ts"],
              referencedSpans: ["Order.missingUseCase"],
              referencedServices: ["OrderRepo"],
              referencedErrors: [],
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/order.ts#decide",
              tagId: "OrderRepo",
            },
            {
              fnQualname: "libs/sample/domain/src/order.ts#aggregatePublish",
              tagId: "EventBus",
            },
          ],
          branchingViolations: [
            {
              rule: "discriminant-branching",
              message: "switch on discriminant _tag",
              file: "libs/sample/domain/src/order.ts",
              line: 15,
              enclosingSymbol: "libs/sample/domain/src/order.ts#decide",
            },
            {
              rule: "unbranded-primitive-boundary",
              message: "unbranded primitive boundary on Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 16,
              enclosingSymbol: "libs/sample/domain/src/order.ts#decide",
            },
            {
              rule: "unmanaged-sql-ddl",
              message: "CREATE TABLE outside SqliteMigrator.fromRecord",
              file: "libs/sample/infra/src/db.ts",
              line: 42,
              enclosingSymbol: "libs/sample/infra/src/db.ts#init",
            },
          ],
        })

        const outcome = yield* decideGraphRewrite(graph, "auto-repair")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const appliedRules = new Set(rec.patches.map((p) => p.ruleId))

        // REP-02 repairs impure-decider on Order.decide
        expect(appliedRules.has(RewriteRuleId.make("REP-02"))).toBe(true)
        // REP-03 repairs aggregate-direct-bus-publish on Aggregate.publish
        expect(appliedRules.has(RewriteRuleId.make("REP-03"))).toBe(true)
        // REP-10 repairs unmapped-spec-symbol Order.missingUseCase
        expect(appliedRules.has(RewriteRuleId.make("REP-10"))).toBe(true)
        // REP-05..09 repair code hygiene violations
        expect(appliedRules.has(RewriteRuleId.make("REP-05"))).toBe(true)
        expect(appliedRules.has(RewriteRuleId.make("REP-06"))).toBe(true)
        expect(appliedRules.has(RewriteRuleId.make("REP-07"))).toBe(true)
        expect(appliedRules.has(RewriteRuleId.make("REP-08"))).toBe(true)
        expect(appliedRules.has(RewriteRuleId.make("REP-09"))).toBe(true)

        expect(rec.finalMeasure.archViolations).toBe(0)
        expect(rec.finalMeasure.unmappedSpecSymbols).toBe(0)
        expect(rec.finalMeasure.codeHygieneViolations).toBe(0)
        expect(isStrictlyDecreasingMeasure(outcome.result.initialMeasure, rec.finalMeasure)).toBe(
          true,
        )

        // Verify mutated targetGraph state: branchingViolations cleared, RawOrderId branded, and OutboxStore added
        expect(outcome.targetGraph.branchingViolations).toHaveLength(0)
        expect(
          outcome.targetGraph.nodeIndexByKey.has(NodeKey.make("ServiceTag:OutboxStore")),
        ).toBe(true)

        // Verify every applied patch strictly decreases the measure in N^6
        for (const patch of rec.patches) {
          expect(isStrictlyDecreasingMeasure(patch.beforeMeasure, patch.afterMeasure)).toBe(true)
        }
      }),
  )

  it.effect(
    "REQ-3.2: Multi-candidate branching (REP-04a vs REP-04b) emits both recommendedCandidate and alternativeCandidates and respects DpoCandidatePriors tie-breaking",
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
              errorTag: "PaymentGatewayError",
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
              errorTag: "PaymentGatewayError",
            },
          ],
        })

        // 1. Default priors: REP-04a (propagate in E) wins over REP-04b (catchTag at boundary)
        const defaultOutcome = yield* decideGraphRewrite(graph, "auto-repair")
        expect(Option.isSome(defaultOutcome.result.recommendedCandidate)).toBe(true)
        const defaultRec = Option.getOrThrow(defaultOutcome.result.recommendedCandidate)
        expect(defaultRec.patches[0]?.ruleId).toBe(RewriteRuleId.make("REP-04a"))
        expect(defaultOutcome.result.alternativeCandidates.length).toBeGreaterThanOrEqual(1)
        const alt0 = defaultOutcome.result.alternativeCandidates[0]!
        expect(alt0.patches[0]?.ruleId).toBe(RewriteRuleId.make("REP-04b"))

        // Both candidates achieve the exact same afterMeasure in N^6!
        expect(
          isEqualMeasure(defaultRec.patches[0]!.afterMeasure, alt0.patches[0]!.afterMeasure),
        ).toBe(true)

        // 2. With System One DpoCandidatePriors favoring REP-04b (950 vs 300), REP-04b becomes recommendedCandidate!
        const callerKey = "EffectFn:libs/sample/domain/src/order.ts#caller"
        const customPriorsOutcome = yield* decideGraphRewrite(graph, "auto-repair", {
          [`${callerKey}::REP-04a`]: SystemOneScoreMillis.make(300),
          [`${callerKey}::REP-04b`]: SystemOneScoreMillis.make(950),
        })

        const customRec = Option.getOrThrow(customPriorsOutcome.result.recommendedCandidate)
        expect(customRec.patches[0]?.ruleId).toBe(RewriteRuleId.make("REP-04b"))
        expect(customRec.systemOneTieBreaker).toBe(SystemOneScoreMillis.make(950))
        expect(customPriorsOutcome.result.alternativeCandidates[0]?.patches[0]?.ruleId).toBe(
          RewriteRuleId.make("REP-04a"),
        )
      }),
  )

  it.effect(
    "4-Phase Stratification & NAC_spec: REP-11 prunes truly orphan ServiceTags in Phase 4 (CLEANUP) but never prunes services referenced by an EarsSpec, AdrDoc, or active stub",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#stubFn",
              spanName: "Order.stubFn",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "void",
              isStub: true,
            },
          ],
          services: [
            {
              tagId: "OrphanLegacyService",
              name: "OrphanLegacyService",
              packageTag: "infra",
              file: "libs/sample/infra/src/orphan.ts",
            },
            {
              tagId: "SpecProtectedService",
              name: "SpecProtectedService",
              packageTag: "service",
              file: "libs/sample/service/src/protected.ts",
            },
            {
              tagId: "StubSiblingService",
              name: "StubSiblingService",
              packageTag: "domain",
              file: "libs/sample/domain/src/sibling.ts",
            },
            {
              tagId: "AdrProtectedService",
              name: "AdrProtectedService",
              packageTag: "service",
              file: "libs/sample/service/src/adr-protected.ts",
            },
          ],
          earsSpecs: [
            {
              id: "sample:SPEC-0009",
              title: "Protected Spec",
              status: "accepted",
              path: "libs/sample/docs/specs/0009.md",
              enforcedByFiles: ["libs/sample/domain/src/order.ts"],
              referencedSpans: ["Order.stubFn"],
              referencedServices: ["SpecProtectedService"],
              referencedErrors: [],
            },
          ],
          adrDocs: [
            {
              id: "sample:ADR-0009",
              title: "Protected ADR Service",
              status: "accepted",
              path: "libs/sample/docs/adr/0009.md",
              enforcedByFiles: ["libs/sample/service/src/adr-protected.ts"],
              referencedSpans: [],
              referencedServices: ["AdrProtectedService"],
              referencedErrors: [],
            },
          ],
          specifiesSymbols: [
            {
              specId: "sample:SPEC-0009",
              targetKey: "libs/sample/domain/src/order.ts#stubFn",
              targetKind: "span",
            },
          ],
        })

        const outcome = yield* decideGraphRewrite(graph, "cleanup")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const rep11Patches = rec.patches.filter(
          (p) => p.ruleId === RewriteRuleId.make("REP-11"),
        )
        expect(rep11Patches).toHaveLength(1)
        expect(rep11Patches[0]?.deletedEntityKeys).toEqual([
          NodeKey.make("ServiceTag:OrphanLegacyService"),
        ])

        // SpecProtectedService, AdrProtectedService, and StubSiblingService remain in the graph
        expect(
          outcome.targetGraph.nodeIndexByKey.has(NodeKey.make("ServiceTag:SpecProtectedService")),
        ).toBe(true)
        expect(
          outcome.targetGraph.nodeIndexByKey.has(NodeKey.make("ServiceTag:AdrProtectedService")),
        ).toBe(true)
        expect(
          outcome.targetGraph.nodeIndexByKey.has(NodeKey.make("ServiceTag:StubSiblingService")),
        ).toBe(true)
      }),
  )

  it.effect(
    "REP-02 preserves pure helper callee edges sorted before impure service edges and handles transitive impurity",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#validateHelper",
              spanName: "Order.validateHelper",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              successType: "boolean",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decide",
              spanName: "Order.decide",
              file: "libs/sample/domain/src/order.ts",
              line: 10,
              packageTag: "domain",
              successType: "OrderEvent",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#placeOrder",
              spanName: "Order.placeOrder",
              file: "libs/sample/domain/src/order.ts",
              line: 25,
              packageTag: "domain",
              successType: "OrderEvent",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "OrderRepo",
              name: "OrderRepo",
              packageTag: "service",
              file: "libs/sample/service/src/repo.ts",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/sample/domain/src/order.ts#decide",
              calleeQualname: "libs/sample/domain/src/order.ts#validateHelper",
              callCount: 1,
              receiverLayer: null,
            },
            {
              callerQualname: "libs/sample/domain/src/order.ts#placeOrder",
              calleeQualname: "libs/sample/domain/src/order.ts#decide",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/order.ts#decide",
              tagId: "OrderRepo",
            },
          ],
        })

        const outcome = yield* decideGraphRewrite(graph, "auto-repair")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const rep02 = rec.patches.find((p) => p.ruleId === RewriteRuleId.make("REP-02"))
        expect(rep02).toBeDefined()
        expect(rep02?.deletedRoleEdges.map((e) => ({
          relationId: e.relationId,
          entityKey: e.entityKey,
          role: e.role,
        }))).toEqual([
          {
            relationId: RelationId.make(
              "EffectSignature:libs/sample/domain/src/order.ts#decide",
            ),
            entityKey: NodeKey.make("ServiceTag:OrderRepo"),
            role: RoleName.make("requires-service"),
          },
        ])
        expect(rep02?.insertedRoleEdges.map((e) => ({
          relationId: e.relationId,
          entityKey: e.entityKey,
          role: e.role,
        }))).toEqual(
          expect.arrayContaining([
            {
              relationId: RelationId.make(
                "EffectSignature:sig:libs/sample/domain/src/order.ts#executeOrder",
              ),
              entityKey: NodeKey.make("ServiceTag:OrderRepo"),
              role: RoleName.make("requires-service"),
            },
          ]),
        )
      }),
  )

  it.effect(
    "REP-05 and REP-06 match target symbols accurately without clobbering sibling traced functions or substring schema names",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/order.ts#validate",
              spanName: "Order.validate",
              file: "libs/sample/domain/src/order.ts",
              line: 5,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/sample/domain/src/order.ts#decideOrder",
              spanName: "untraced",
              file: "libs/sample/domain/src/order.ts",
              line: 15,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          schemas: [
            {
              schemaName: "OrderId",
              file: "libs/sample/contract/src/order.ts",
              packageTag: "contract",
              isBranded: true,
            },
            {
              schemaName: "OrderIdInput",
              file: "libs/sample/contract/src/order.ts",
              packageTag: "contract",
              isBranded: false,
            },
          ],
          branchingViolations: [
            {
              rule: "untraced-decider",
              message: "Decider decideOrder is untraced",
              file: "libs/sample/domain/src/order.ts",
              line: 15,
              enclosingSymbol: "",
            },
            {
              rule: "unbranded-contract-schema",
              message: "OrderIdInput is unbranded",
              file: "libs/sample/contract/src/order.ts",
              line: 10,
              enclosingSymbol: "OrderIdInput",
            },
          ],
        })

        const outcome = yield* decideGraphRewrite(graph, "auto-repair")
        expect(Option.isSome(outcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(outcome.result.recommendedCandidate)
        const rep05 = rec.patches.find((p) => p.ruleId === RewriteRuleId.make("REP-05"))
        expect(rep05).toBeDefined()
        expect(rep05?.primaryNodeKey).toBe(
          NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#decideOrder"),
        )

        const rep06 = rec.patches.find((p) => p.ruleId === RewriteRuleId.make("REP-06"))
        expect(rep06).toBeDefined()
        expect(rep06?.primaryNodeKey).toBe(
          NodeKey.make("SchemaDef:OrderIdInput"),
        )
      }),
  )

  it.effect(
    "executes all 4 phases (PLAN -> REPAIR_ARCH -> REPAIR_CODE -> CLEANUP) in full mode and returns Option.none() on an already clean graph",
    () =>
      Effect.gen(function* () {
        const cleanGraph = buildHarnessGraph({})
        const cleanOutcome = yield* decideGraphRewrite(cleanGraph, "full")
        expect(Option.isNone(cleanOutcome.result.recommendedCandidate)).toBe(true)
        expect(isZeroMeasure(cleanOutcome.result.initialMeasure)).toBe(true)

        const fullGraph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "full:SPEC-0001",
              title: "Full Pipeline Spec",
              status: "proposed",
              path: "libs/full/docs/specs/0001.md",
              enforcedByFiles: ["libs/full/domain/src/order.ts"],
              referencedSpans: ["Order.create"],
              referencedServices: [],
              referencedErrors: [],
            },
          ],
          services: [
            {
              tagId: "UnusedInfraService",
              name: "UnusedInfraService",
              packageTag: "infra",
              file: "libs/other/infra/src/unused.ts",
            },
          ],
        })

        const fullOutcome = yield* decideGraphRewrite(fullGraph, "full")
        expect(Option.isSome(fullOutcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(fullOutcome.result.recommendedCandidate)
        const phases = rec.patches.map((p) => p.phase)
        expect(phases).toContain("PLAN")
        expect(phases).toContain("CLEANUP")
        expect(rec.isPolicyClean).toBe(true)
        expect(
          fullOutcome.targetGraph.nodeIndexByKey.has(NodeKey.make("ServiceTag:UnusedInfraService")),
        ).toBe(false)
      }),
  )

  it.effect.prop(
    "REQ-2.2: Lexicographical termination measure isStrictlyDecreasingMeasure forms a strict total order on N^6 (irreflexive, asymmetric, transitive)",
    [MeasureTupleSchema, MeasureTupleSchema, MeasureTupleSchema],
    ([t1, t2, t3]) =>
      Effect.sync(() => {
        const m1 = toGraphMeasure(t1)
        const m2 = toGraphMeasure(t2)
        const m3 = toGraphMeasure(t3)

        // Irreflexivity: !(m1 > m1)
        expect(isStrictlyDecreasingMeasure(m1, m1)).toBe(false)
        expect(isEqualMeasure(m1, m1)).toBe(true)

        // Asymmetry: if m1 > m2 then !(m2 > m1)
        if (isStrictlyDecreasingMeasure(m1, m2)) {
          expect(isStrictlyDecreasingMeasure(m2, m1)).toBe(false)
          expect(isEqualMeasure(m1, m2)).toBe(false)
        }

        // Transitivity: if m1 > m2 and m2 > m3 then m1 > m3
        if (isStrictlyDecreasingMeasure(m1, m2) && isStrictlyDecreasingMeasure(m2, m3)) {
          expect(isStrictlyDecreasingMeasure(m1, m3)).toBe(true)
        }

        // Zero measure check
        const zero = toGraphMeasure([0, 0, 0, 0, 0, 0])
        expect(isZeroMeasure(zero)).toBe(true)
        if (!isEqualMeasure(m1, zero)) {
          expect(isStrictlyDecreasingMeasure(m1, zero)).toBe(true)
        }
      }),
  )
})
