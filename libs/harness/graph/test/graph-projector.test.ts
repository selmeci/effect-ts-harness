import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  createTypeScriptProgramSession,
  decideGraphProjection,
  decideGraphRewrite,
  type EntityNode,
  type GraphMeasure,
  type GraphPatch,
  GraphProjector,
  type HarnessGraph,
  isolateFirstOffendingPatchIndex,
  NodeKey,
  NonNegativeCount,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
  type RewritePhase,
  RewriteRuleId,
  RoleName,
  verifyProjectedSubset,
  verifySubgraphMonomorphism,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const zeroMeasure: GraphMeasure = {
  archViolations: NonNegativeCount.make(0),
  unmappedSpecSymbols: NonNegativeCount.make(0),
  codeHygieneViolations: NonNegativeCount.make(0),
  missingLayerProviders: NonNegativeCount.make(0),
  untestedDomainSpans: NonNegativeCount.make(0),
  unresolvedSuggestedEdges: NonNegativeCount.make(0),
}

const makePatch = (params: {
  readonly ruleId: RewriteRuleId
  readonly phase?: RewritePhase | undefined
  readonly description?: string | undefined
  readonly primaryNodeKey: NodeKey
  readonly insertedEntityNodes?: ReadonlyArray<EntityNode> | undefined
  readonly insertedRelationNodes?: ReadonlyArray<RelationNode> | undefined
  readonly insertedRoleEdges?: ReadonlyArray<PlaysRoleEdge> | undefined
  readonly deletedEntityKeys?: ReadonlyArray<NodeKey> | undefined
}): GraphPatch => ({
  ruleId: params.ruleId,
  phase: params.phase ?? "REPAIR_CODE",
  ruleCategory: "auto-repair",
  description: params.description ?? `Patch for ${params.ruleId}`,
  primaryNodeKey: params.primaryNodeKey,
  preservedInterfaceKeys: [],
  deletedEntityKeys: params.deletedEntityKeys !== undefined ? [...params.deletedEntityKeys] : [],
  deletedRelationIds: [],
  deletedRoleEdges: [],
  insertedEntityNodes: params.insertedEntityNodes !== undefined ? [...params.insertedEntityNodes] : [],
  insertedRelationNodes:
    params.insertedRelationNodes !== undefined ? [...params.insertedRelationNodes] : [],
  insertedRoleEdges: params.insertedRoleEdges !== undefined ? [...params.insertedRoleEdges] : [],
  beforeMeasure: zeroMeasure,
  afterMeasure: zeroMeasure,
})

const emptyGraph: HarnessGraph = buildHarnessGraph({
  fns: [],
  schemas: [],
  services: [],
  layers: [],
  errors: [],
  tests: [],
  patternDocs: [],
  requiresService: [],
  failsWith: [],
  providesService: [],
  layerRequires: [],
  tracedCalls: [],
  exercisesSpans: [],
})

describe("GraphProjector.decide (harness:SPEC-0008 Section 4)", () => {
  it.effect(
    "REQ-4.1: Projects PLAN-01..04 RewriteCandidate into AstProjectionResult with complete stratum overlays",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "order:SPEC-0001",
              title: "Order Placement Spec",
              status: "proposed",
              path: "libs/order/docs/specs/0001-order.md",
              enforcedByFiles: ["libs/order/domain/src/order.ts"],
              referencedSpans: ["Order.placeOrder"],
              referencedServices: ["OrderService"],
              referencedErrors: ["OrderRejectedError"],
            },
          ],
        })

        const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-plan")
        expect(Option.isSome(rewriteOutcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(rewriteOutcome.result.recommendedCandidate)

        const result = yield* decideGraphProjection({
          initialGraph: graph,
          targetGraph: rewriteOutcome.targetGraph,
          patches: rec.patches,
          verifyRoundTrip: false,
        }).pipe(Effect.withSpan("Test.trace"))

        expect(result.overlays.length).toBeGreaterThan(0)
        expect(result.operations.length).toBeGreaterThan(0)

        const overlayMap = new Map(result.overlays.map((o) => [String(o.targetFile), String(o.content)]))
        const allOverlayContent = Array.from(overlayMap.values()).join("\n")

        // 1. schemas.ts contains Schema.brand
        expect(allOverlayContent).toContain("Schema.brand")

        // 2. errors.ts contains Schema.TaggedError
        expect(allOverlayContent).toContain("Schema.TaggedError")

        // 3. ports.ts contains Context.Service
        expect(allOverlayContent).toContain("Context.Service")

        // 4. domain decider contains stub helper
        expect(allOverlayContent).toContain("stub<")

        // 5. infra layer contains Layer.effect
        expect(allOverlayContent).toContain("Layer.effect")

        // 6. unit test contains it.effect.prop or it.effect
        const hasTestRunner =
          allOverlayContent.includes("it.effect.prop") || allOverlayContent.includes("it.effect")
        expect(hasTestRunner).toBe(true)

        // 7. Operations record ts-morph engine in PLAN-01..04 synthesis
        const hasTsMorph = result.operations.some((op) => op.engine === "ts-morph")
        expect(hasTsMorph).toBe(true)

        // Also assert GraphProjector export object convenience
        const directDecideResult = yield* GraphProjector.decide({
          initialGraph: graph,
          targetGraph: rewriteOutcome.targetGraph,
          patches: rec.patches,
          verifyRoundTrip: false,
        })
        expect(directDecideResult.overlays.length).toBe(result.overlays.length)
      }),
  )

  it.effect(
    "REQ-4.1: Projects REP-05, REP-06, REP-07, REP-08, REP-09, and REP-11 repairs using existingFiles",
    () =>
      Effect.gen(function* () {
        // REP-05: wrapping Effect.fnUntraced into Effect.fn
        const rep05Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-05"),
          primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#checkout"),
          insertedEntityNodes: [
            {
              _tag: "EffectFn",
              qualname: "libs/sample/domain/src/order.ts#checkout",
              spanName: "Order.checkout",
              file: "libs/sample/domain/src/order.ts",
              line: 1,
              packageTag: "domain",
              isStub: false,
            },
          ],
        })

        const rep05Result = yield* decideGraphProjection({
          targetGraph: emptyGraph,
          patches: [rep05Patch],
          existingFiles: {
            "libs/sample/domain/src/order.ts":
              'export const checkout = Effect.fnUntraced(() => Effect.succeed(1))\n',
          },
          verifyRoundTrip: false,
        })
        const rep05Overlay = rep05Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/domain/src/order.ts",
        )
        expect(rep05Overlay).toBeDefined()
        expect(String(rep05Overlay?.content)).toContain('Effect.fn("Order.checkout")')
        expect(rep05Result.operations.some((op) => op.engine === "ast-grep")).toBe(true)

        // REP-06: adding .pipe(Schema.brand(...)) to unbranded schema
        const rep06Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-06"),
          primaryNodeKey: NodeKey.make("SchemaDef:OrderId"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "OrderId",
              file: "libs/sample/contract/src/schemas.ts",
              line: 1,
              packageTag: "contract",
              isBranded: true,
            },
          ],
        })

        const rep06Result = yield* decideGraphProjection({
          targetGraph: emptyGraph,
          patches: [rep06Patch],
          existingFiles: {
            "libs/sample/contract/src/schemas.ts": "export const OrderId = Schema.NonEmptyString\n",
          },
          verifyRoundTrip: false,
        })
        const rep06Overlay = rep06Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/contract/src/schemas.ts",
        )
        expect(rep06Overlay).toBeDefined()
        expect(String(rep06Overlay?.content)).toContain('.pipe(Schema.brand("OrderId"))')

        // REP-07: rewriting if (event._tag === "Created") into match(event).with({ _tag: "Created" }, ...).exhaustive()
        const rep07Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-07"),
          primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#handleEvent"),
        })

        const rep07Result = yield* decideGraphProjection({
          targetGraph: emptyGraph,
          patches: [rep07Patch],
          existingFiles: {
            "libs/sample/domain/src/order.ts":
              'export const handleEvent = (event: any) => {\n  if (event._tag === "Created") { return true } else { return false }\n}\n',
          },
          verifyRoundTrip: false,
        })
        const rep07Overlay = rep07Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/domain/src/order.ts",
        )
        expect(rep07Overlay).toBeDefined()
        expect(String(rep07Overlay?.content)).toContain('match(event).with({ _tag: "Created" }')

        // REP-08: rewriting .make(row.id) into Schema.decodeUnknownEffect(...)
        const rep08Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-08"),
          primaryNodeKey: NodeKey.make("EffectFn:libs/sample/infra/src/order-repo.ts#parseRow"),
        })

        const rep08Result = yield* decideGraphProjection({
          targetGraph: emptyGraph,
          patches: [rep08Patch],
          existingFiles: {
            "libs/sample/infra/src/order-repo.ts":
              "export const parseRow = (row: any) => OrderId.make(row.id)\n",
          },
          verifyRoundTrip: false,
        })
        const rep08Overlay = rep08Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/infra/src/order-repo.ts",
        )
        expect(rep08Overlay).toBeDefined()
        expect(String(rep08Overlay?.content)).toContain("Schema.decodeUnknownEffect")

        // REP-09: wrapping unmanaged CREATE TABLE DDL into SqliteMigrator.fromRecord
        const rep09Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-09"),
          primaryNodeKey: NodeKey.make("MigrationTuple:0001_orders"),
          insertedRelationNodes: [
            {
              _tag: "MigrationTuple",
              relationId: RelationId.make("MigrationTuple:0001_orders"),
              migrationId: "0001_orders",
              engine: "SqliteMigrator",
              moduleFile: "libs/sample/infra/src/migrations.ts",
              isDestructive: false,
              verifyingTestQualnames: [],
              line: 1,
            },
          ],
        })

        const rep09Result = yield* decideGraphProjection({
          targetGraph: emptyGraph,
          patches: [rep09Patch],
          existingFiles: {
            "libs/sample/infra/src/migrations.ts":
              'const createTable = sql`CREATE TABLE orders (id TEXT PRIMARY KEY)`\n',
          },
          verifyRoundTrip: false,
        })
        const rep09Overlay = rep09Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/infra/src/migrations.ts",
        )
        expect(rep09Overlay).toBeDefined()
        expect(String(rep09Overlay?.content)).toContain("SqliteMigrator.fromRecord")

        // REP-11: removing unused ServiceTag
        const initialGraphWithUnusedService = buildHarnessGraph({
          services: [
            {
              tagId: "UnusedService",
              name: "UnusedService",
              packageTag: "service",
              file: "libs/sample/service/src/ports.ts",
            },
          ],
        })

        const rep11Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-11"),
          phase: "CLEANUP",
          primaryNodeKey: NodeKey.make("ServiceTag:UnusedService"),
          deletedEntityKeys: [NodeKey.make("ServiceTag:UnusedService")],
        })

        const rep11Result = yield* decideGraphProjection({
          initialGraph: initialGraphWithUnusedService,
          targetGraph: emptyGraph,
          patches: [rep11Patch],
          existingFiles: {
            "libs/sample/service/src/ports.ts":
              'export class UnusedService extends Context.Tag("UnusedService")<UnusedService, {}>() {}\n',
          },
          verifyRoundTrip: false,
        })
        const rep11Overlay = rep11Result.overlays.find(
          (o) => String(o.targetFile) === "libs/sample/service/src/ports.ts",
        )
        expect(rep11Overlay).toBeDefined()
        expect(String(rep11Overlay?.content)).not.toContain("class UnusedService")
      }),
  )

  const ScopeLiteralSchema = Schema.Literals(["alpha", "beta", "gamma"])
  const EntityKindSchema = Schema.Literals([
    "SchemaDef",
    "TaggedError",
    "ServiceTag",
    "EffectFn",
    "ServiceLayer",
  ])

  it.effect.prop(
    "REQ-4.2: Mandatory Nx barrel co-projection for arbitrary scopes and entity kinds",
    [ScopeLiteralSchema, EntityKindSchema],
    ([scope, kind]) =>
      Effect.gen(function* () {
        const symbol = `${scope.toUpperCase()}_Item`
        const node: EntityNode = match(kind)
          .with("SchemaDef", () => ({
            _tag: "SchemaDef" as const,
            schemaName: symbol,
            file: `libs/${scope}/contract/src/schemas.ts`,
            line: 1,
            packageTag: "contract" as const,
            isBranded: true,
          }))
          .with("TaggedError", () => ({
            _tag: "TaggedError" as const,
            errorTag: symbol,
            file: `libs/${scope}/contract/src/errors.ts`,
            line: 1,
            packageTag: "contract" as const,
          }))
          .with("ServiceTag", () => ({
            _tag: "ServiceTag" as const,
            tagId: symbol,
            name: symbol,
            file: `libs/${scope}/service/src/ports.ts`,
            packageTag: "service" as const,
          }))
          .with("EffectFn", () => ({
            _tag: "EffectFn" as const,
            qualname: `libs/${scope}/domain/src/order.ts#${symbol}`,
            spanName: `${scope}.${symbol}`,
            file: `libs/${scope}/domain/src/order.ts`,
            line: 1,
            packageTag: "domain" as const,
            isStub: false,
          }))
          .with("ServiceLayer", () => ({
            _tag: "ServiceLayer" as const,
            qualname: `libs/${scope}/infra/src/repo-live.ts#${symbol}`,
            layerKind: "live" as const,
            file: `libs/${scope}/infra/src/repo-live.ts`,
            packageTag: "infra" as const,
          }))
          .exhaustive()

        const patch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          phase: "PLAN",
          primaryNodeKey: NodeKey.make(`${kind}:${symbol}`),
          insertedEntityNodes: [node],
        })

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [patch],
          verifyRoundTrip: false,
        })

        const pkgTag = "packageTag" in node && node.packageTag !== undefined ? node.packageTag : "contract"
        const barrelFile = `libs/${scope}/${pkgTag}/src/index.ts`
        const barrelOverlay = result.overlays.find((o) => String(o.targetFile) === barrelFile)
        expect(barrelOverlay?.targetFile).toBe(barrelFile)
        const barrelContent = String(barrelOverlay?.content)
        expect(barrelContent).toContain(symbol)
      }),
  )

  it.effect(
    "REQ-4.2: Preserves existing exports in src/index.ts when co-projecting barrel",
    () =>
      Effect.gen(function* () {
        const patch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          phase: "PLAN",
          primaryNodeKey: NodeKey.make("SchemaDef:PaymentId"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "PaymentId",
              file: "libs/payments/contract/src/schemas.ts",
              line: 1,
              packageTag: "contract",
              isBranded: true,
            },
          ],
        })

        const existingBarrel = "export const PRE_EXISTING_CONSTANT = 999\n"
        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [patch],
          existingFiles: {
            "libs/payments/contract/src/index.ts": existingBarrel,
          },
          verifyRoundTrip: false,
        })

        const barrelOverlay = result.overlays.find(
          (o) => String(o.targetFile) === "libs/payments/contract/src/index.ts",
        )
        expect(barrelOverlay).toBeDefined()
        const content = String(barrelOverlay?.content)
        expect(content).toContain("PRE_EXISTING_CONSTANT")
        expect(content).toContain("PaymentId")
      }),
  )

  it.effect(
    "REQ-4.3: Stratum-Boundary Batch Shadow LSP Verification succeeds on clean patch batches",
    () =>
      Effect.gen(function* () {
        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [],
          verifyRoundTrip: true,
        })
        expect(result.roundTripVerified).toBe(true)
        expect(result.skippedRuleIds).toHaveLength(0)
        expect(result.bisectionProbes).toBe(0)
      }),
  )

  it.effect(
    "REQ-4.3: Stratum-Boundary Batch Shadow LSP Verification succeeds on real non-empty PLAN-01..04 patch batch",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "order:SPEC-0001",
              title: "Order Placement Spec",
              status: "proposed",
              path: "libs/order/docs/specs/0001-order.md",
              enforcedByFiles: ["libs/order/domain/src/order.ts"],
              referencedSpans: ["Order.placeOrder"],
              referencedServices: ["OrderService"],
              referencedErrors: ["OrderRejectedError"],
            },
          ],
        })

        const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-plan")
        expect(Option.isSome(rewriteOutcome.result.recommendedCandidate)).toBe(true)
        const rec = Option.getOrThrow(rewriteOutcome.result.recommendedCandidate)

        const result = yield* decideGraphProjection({
          initialGraph: graph,
          targetGraph: rewriteOutcome.targetGraph,
          patches: rec.patches,
          verifyRoundTrip: true,
        })

        expect(result.verificationStatus).toBe("Verified")
        expect(result.roundTripVerified).toBe(true)
        expect(result.compilerDiagnostics).toEqual([])
        expect(result.overlays.length).toBeGreaterThan(0)
        expect(result.skippedRuleIds).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.3: O(log k) binary-search bisection fault-isolates forced rule failure in 5-patch batch",
    () =>
      Effect.gen(function* () {
        const targetFile = "libs/sample/domain/src/fn.ts"
        const patch1 = makePatch({
          ruleId: RewriteRuleId.make("REP-05"),
          primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#fn1`),
        })
        const patch2 = makePatch({
          ruleId: RewriteRuleId.make("REP-06"),
          primaryNodeKey: NodeKey.make("SchemaDef:sc1"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "sc1",
              file: targetFile,
              line: 1,
              packageTag: "domain",
              isBranded: true,
            },
          ],
        })
        const patch3 = makePatch({
          ruleId: RewriteRuleId.make("REP-07"),
          primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#fn2`),
        })
        const patch4 = makePatch({
          ruleId: RewriteRuleId.make("REP-08"),
          primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#fn3`),
        })
        const patch5 = makePatch({
          ruleId: RewriteRuleId.make("REP-10"),
          primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#fn4`),
        })

        const fivePatches = [patch1, patch2, patch3, patch4, patch5]

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: fivePatches,
          existingFiles: {
            [targetFile]: 'import { Schema } from "effect"\nexport const sc1 = Schema.NonEmptyString\n',
          },
          verifyRoundTrip: true,
          forceFailRuleIds: [RewriteRuleId.make("REP-06")],
        })

        expect(result.skippedRuleIds).toContain(RewriteRuleId.make("REP-06"))
        expect(result.verificationStatus).toBe("Partial")
        expect(result.roundTripVerified).toBe(false)
        expect(result.bisectionProbes).toBeGreaterThan(0)
        expect(result.bisectionProbes).toBeLessThanOrEqual(Math.ceil(Math.log2(5)) + 1)
      }),
  )

  it.effect(
    "REQ-4.3: Real round-trip verification failure (without forceFailRuleIds) skips un-projected graph entity patch",
    () =>
      Effect.gen(function* () {
        const targetFile = "libs/sample/contract/src/schemas.ts"
        const validPatch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          phase: "PLAN",
          primaryNodeKey: NodeKey.make("SchemaDef:ValidItemId"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "ValidItemId",
              file: targetFile,
              line: 1,
              packageTag: "contract",
              isBranded: true,
            },
          ],
        })
        // Second patch uses REP-11 (which never projects SchemaDef nodes) while claiming SchemaDef:PhantomSchema in H
        const unextractablePatch = makePatch({
          ruleId: RewriteRuleId.make("REP-11"),
          phase: "PLAN",
          primaryNodeKey: NodeKey.make("SchemaDef:PhantomSchema"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "PhantomSchema",
              file: targetFile,
              line: 1,
              packageTag: "contract",
              isBranded: true,
            },
          ],
        })

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [validPatch, unextractablePatch],
          verifyRoundTrip: true,
        })

        expect(result.skippedRuleIds).toContain(RewriteRuleId.make("REP-11"))
        expect(result.verificationStatus).toBe("Partial")
        expect(result.roundTripVerified).toBe(false)
      }),
  )

  it.effect(
    "REQ-4.1: verifyRoundTrip: false sets verificationStatus to Unverified and roundTripVerified to false",
    () =>
      Effect.gen(function* () {
        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [],
          verifyRoundTrip: false,
        })
        expect(result.verificationStatus).toBe("Unverified")
        expect(result.roundTripVerified).toBe(false)
      }),
  )

  it.effect(
    "REQ-4.1: Preserves existing user function and Layer bodies during REP-01..04 repairs (never overwrites with placeholders)",
    () =>
      Effect.gen(function* () {
        const domainFile = "libs/sample/domain/src/order.ts"
        const infraFile = "libs/sample/infra/src/order-live.ts"
        const existingDomainCode = [
          'import { Effect } from "effect"',
          'export const placeOrder = Effect.fn("Order.placeOrder")(function* (input: OrderId) {',
          "  const customCalculation = 40 + 2",
          "  return customCalculation",
          "})",
          "",
        ].join("\n")

        const existingInfraCode = [
          'import { Effect, Layer } from "effect"',
          "export const OrderServiceLive = Layer.effect(",
          "  OrderService,",
          "  Effect.gen(function* () {",
          "    const dbConn = yield* SqlClient",
          "    return { execute: (cmd) => dbConn.run(cmd) }",
          "  }),",
          ")",
          "",
        ].join("\n")

        const rep02Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-02"),
          phase: "REPAIR_ARCH",
          primaryNodeKey: NodeKey.make(`EffectFn:${domainFile}#placeOrder`),
          insertedEntityNodes: [
            {
              _tag: "EffectFn",
              qualname: `${domainFile}#placeOrder`,
              spanName: "Order.placeOrder",
              file: domainFile,
              line: 2,
              packageTag: "domain",
              isStub: false,
            },
            {
              _tag: "ServiceTag",
              tagId: "AuditService",
              name: "AuditService",
              file: "libs/sample/service/src/ports.ts",
              packageTag: "service",
            },
          ],
          insertedRelationNodes: [
            {
              _tag: "EffectSignature",
              relationId: RelationId.make(`EffectSignature:${domainFile}#placeOrder`),
              callerQualname: `${domainFile}#placeOrder`,
              requiredServices: ["AuditService"],
              emittedErrors: [],
              calleeQualnames: [],
              payloadSchemas: [],
              file: domainFile,
              line: 2,
            },
          ],
          insertedRoleEdges: [
            {
              _tag: "PlaysRole",
              relationId: RelationId.make(`EffectSignature:${domainFile}#placeOrder`),
              entityKey: NodeKey.make(`EffectFn:${domainFile}#placeOrder`),
              role: RoleName.make("caller"),
            },
            {
              _tag: "PlaysRole",
              relationId: RelationId.make(`EffectSignature:${domainFile}#placeOrder`),
              entityKey: NodeKey.make("ServiceTag:AuditService"),
              role: RoleName.make("requires-service"),
            },
          ],
        })

        const rep04Patch = makePatch({
          ruleId: RewriteRuleId.make("REP-04a"),
          phase: "REPAIR_ARCH",
          primaryNodeKey: NodeKey.make(`ServiceLayer:${infraFile}#OrderServiceLive`),
          insertedEntityNodes: [
            {
              _tag: "ServiceLayer",
              qualname: `${infraFile}#OrderServiceLive`,
              layerKind: "live",
              file: infraFile,
              packageTag: "infra",
            },
          ],
        })

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [rep02Patch, rep04Patch],
          existingFiles: {
            [domainFile]: existingDomainCode,
            [infraFile]: existingInfraCode,
          },
          verifyRoundTrip: false,
        })

        const domainOverlay = result.overlays.find((o) => String(o.targetFile) === domainFile)
        expect(domainOverlay).toBeDefined()
        expect(String(domainOverlay?.content)).toContain("const customCalculation = 40 + 2")
        expect(String(domainOverlay?.content)).toContain("yield* AuditService")
        expect(String(domainOverlay?.content)).not.toContain("return input")

        const infraOverlay = result.overlays.find((o) => String(o.targetFile) === infraFile)
        expect(infraOverlay).toBeDefined()
        expect(String(infraOverlay?.content)).toContain("const dbConn = yield* SqlClient")
        expect(String(infraOverlay?.content)).not.toContain("execute: () => Effect.void")
      }),
  )

  it.effect(
    "REQ-4.1: No-op REP-05, REP-07, and REP-08 repairs emit 0 operations, add no unused imports, and leave non-match .otherwise() untouched",
    () =>
      Effect.gen(function* () {
        const targetFile = "libs/sample/domain/src/clean.ts"
        const cleanCode = [
          "export const compute = (x: number) => {",
          "  const fallback = someBuilder.otherwise(() => 0)",
          "  if (x > 10) { return fallback }",
          "  return x",
          "}",
          "",
        ].join("\n")

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: [
            makePatch({
              ruleId: RewriteRuleId.make("REP-05"),
              primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#compute`),
            }),
            makePatch({
              ruleId: RewriteRuleId.make("REP-07"),
              primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#compute`),
            }),
            makePatch({
              ruleId: RewriteRuleId.make("REP-08"),
              primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#compute`),
            }),
          ],
          existingFiles: {
            [targetFile]: cleanCode,
          },
          verifyRoundTrip: false,
        })

        expect(result.operations).toHaveLength(0)
        expect(result.overlays).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.4: Fails closed with GraphProjectorError on malformed GraphPatch with empty file path, path traversal, or missing repair target file",
    () =>
      Effect.gen(function* () {
        const malformedPatch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          primaryNodeKey: NodeKey.make("SchemaDef:Malformed"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "Malformed",
              file: "",
              line: 1,
              packageTag: "contract",
              isBranded: false,
            },
          ],
        })

        const emptyPathError = yield* Effect.flip(
          decideGraphProjection({
            targetGraph: emptyGraph,
            patches: [malformedPatch],
            verifyRoundTrip: false,
          }),
        )

        match(emptyPathError)
          .with({ _tag: "GraphProjectorError" }, (projErr) => {
            expect(projErr.reason).toBe("invalid-patch-target")
          })
          .exhaustive()

        // Path traversal outside repoRoot
        const traversalPatch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          primaryNodeKey: NodeKey.make("SchemaDef:Traversal"),
          insertedEntityNodes: [
            {
              _tag: "SchemaDef",
              schemaName: "Traversal",
              file: "../../outside-repo.ts",
              line: 1,
              packageTag: "contract",
              isBranded: true,
            },
          ],
        })

        const traversalError = yield* Effect.flip(
          decideGraphProjection({
            targetGraph: emptyGraph,
            patches: [traversalPatch],
            verifyRoundTrip: false,
          }),
        )
        expect(traversalError.reason).toBe("invalid-patch-target")

        // Missing target file on code repair rule
        const missingRepairTargetPatch = makePatch({
          ruleId: RewriteRuleId.make("REP-07"),
          primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/does-not-exist.ts#fn"),
        })

        const missingFileError = yield* Effect.flip(
          decideGraphProjection({
            targetGraph: emptyGraph,
            patches: [missingRepairTargetPatch],
            verifyRoundTrip: false,
          }),
        )
        expect(missingFileError.reason).toBe("missing-target-file")
      }),
  )

  it("REQ-4.3: verifySubgraphMonomorphism enforces injectivity on entity nodes, relation nodes, and relation-preserving role edges", () => {
    const fnAlpha = {
      qualname: "libs/alpha/domain/src/index.ts#decide",
      spanName: "Alpha.decide",
      file: "libs/alpha/domain/src/index.ts",
      line: 1,
      packageTag: "domain" as const,
      isStub: false,
    }
    const fnBeta = {
      qualname: "libs/beta/domain/src/index.ts#decide",
      spanName: "Beta.decide",
      file: "libs/beta/domain/src/index.ts",
      line: 1,
      packageTag: "domain" as const,
      isStub: false,
    }
    const svc = {
      tagId: "OrderService",
      name: "OrderService",
      file: "libs/alpha/service/src/ports.ts",
      packageTag: "service" as const,
    }

    // 1. Target graph has 2 distinct #decide functions (Alpha and Beta), extracted graph only has Alpha
    const targetTwoFns = buildHarnessGraph({ fns: [fnAlpha, fnBeta] })
    const extractedOneFn = buildHarnessGraph({ fns: [fnAlpha] })
    const nonInjectiveRes = verifySubgraphMonomorphism(extractedOneFn, targetTwoFns)
    expect(nonInjectiveRes.isMonomorphic).toBe(false)
    expect(nonInjectiveRes.missingEntities).toEqual([
      NodeKey.make("EffectFn:libs/beta/domain/src/index.ts#decide"),
    ])

    // 2. Target graph has RequiresService (EffectSignature relation + requires-service PlaysRoleEdge), extracted graph omits relation
    const targetWithSig = buildHarnessGraph({
      fns: [fnAlpha],
      services: [svc],
      requiresService: [
        { callerQualname: "libs/alpha/domain/src/index.ts#decide", tagId: "OrderService" },
      ],
    })
    const extractedWithoutSig = buildHarnessGraph({
      fns: [fnAlpha],
      services: [svc],
    })
    const missingRelRes = verifySubgraphMonomorphism(extractedWithoutSig, targetWithSig)
    expect(missingRelRes.isMonomorphic).toBe(false)
    expect(missingRelRes.missingRelations).toEqual([
      RelationId.make("EffectSignature:libs/alpha/domain/src/index.ts#decide"),
    ])
    expect(missingRelRes.missingRoleEdges).toEqual([
      {
        _tag: "PlaysRole",
        relationId: RelationId.make("EffectSignature:libs/alpha/domain/src/index.ts#decide"),
        entityKey: NodeKey.make("EffectFn:libs/alpha/domain/src/index.ts#decide"),
        role: RoleName.make("caller"),
        archimateRelation: "Triggering",
      },
      {
        _tag: "PlaysRole",
        relationId: RelationId.make("EffectSignature:libs/alpha/domain/src/index.ts#decide"),
        entityKey: NodeKey.make("ServiceTag:OrderService"),
        role: RoleName.make("requires-service"),
        archimateRelation: "Serving",
      },
    ])

    // 3. Positive monomorphism when all entities, relations, and role edges are preserved
    const validRes = verifySubgraphMonomorphism(targetWithSig, targetWithSig)
    expect(validRes.isMonomorphic).toBe(true)
    expect(validRes.missingEntities).toEqual([])
    expect(validRes.missingRelations).toEqual([])
    expect(validRes.missingRoleEdges).toEqual([])
  })

  it.effect(
    "REQ-4.3: isolateFirstOffendingPatchIndex isolates offending index across multi-probe bisection (F-16)",
    () =>
      Effect.gen(function* () {
        const targetFile = "libs/sample/domain/src/multi-probe.ts"
        const existingFiles = {
          [targetFile]: 'import { Effect } from "effect"\nexport const base = 1\n',
        }

        const patches = [
          makePatch({
            ruleId: RewriteRuleId.make("REP-05"),
            primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#p0`),
          }),
          makePatch({
            ruleId: RewriteRuleId.make("REP-06"),
            primaryNodeKey: NodeKey.make(`SchemaDef:p1`),
          }),
          makePatch({
            ruleId: RewriteRuleId.make("REP-07"),
            primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#p2`),
          }),
          makePatch({
            ruleId: RewriteRuleId.make("REP-08"),
            primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#p3`),
          }),
          makePatch({
            ruleId: RewriteRuleId.make("REP-10"),
            primaryNodeKey: NodeKey.make(`EffectFn:${targetFile}#p4`),
          }),
        ]

        // Test A: Fault at index 1 (REP-06)
        const outcomeA = yield* isolateFirstOffendingPatchIndex(
          process.cwd(),
          emptyGraph,
          emptyGraph,
          [],
          patches,
          existingFiles,
          new Set(["REP-06"]),
        )
        expect(outcomeA.offendingIndex).toBe(1)
        expect(outcomeA.probes).toBeGreaterThanOrEqual(2)
        expect(outcomeA.probes).toBeLessThanOrEqual(Math.ceil(Math.log2(5)) + 1)

        // Test B: Fault at index 3 (REP-08)
        const outcomeB = yield* isolateFirstOffendingPatchIndex(
          process.cwd(),
          emptyGraph,
          emptyGraph,
          [],
          patches,
          existingFiles,
          new Set(["REP-08"]),
        )
        expect(outcomeB.offendingIndex).toBe(3)
        expect(outcomeB.probes).toBeGreaterThanOrEqual(2)
        expect(outcomeB.probes).toBeLessThanOrEqual(Math.ceil(Math.log2(5)) + 1)
      }),
  )

  it.effect(
    "REQ-4.3: verifyProjectedSubset preserves interruption under Fiber.interrupt (F-16)",
    () =>
      Effect.gen(function* () {
        const patch = makePatch({
          ruleId: RewriteRuleId.make("PLAN-01"),
          primaryNodeKey: NodeKey.make("SchemaDef:InterruptedTarget"),
        })
        const fiber = yield* Effect.forkChild(
          verifyProjectedSubset(
            process.cwd(),
            emptyGraph,
            emptyGraph,
            [patch],
            {},
          ),
        )
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            expect(Cause.hasInterrupts(f.cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("expected interrupted exit")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "REQ-4.3: isolateFirstOffendingPatchIndex preserves interruption under Fiber.interrupt (F-16)",
    () =>
      Effect.gen(function* () {
        const patches = [
          makePatch({
            ruleId: RewriteRuleId.make("REP-05"),
            primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/fn.ts#fn1"),
          }),
          makePatch({
            ruleId: RewriteRuleId.make("REP-06"),
            primaryNodeKey: NodeKey.make("SchemaDef:sc1"),
          }),
        ]
        const fiber = yield* Effect.forkChild(
          isolateFirstOffendingPatchIndex(
            process.cwd(),
            emptyGraph,
            emptyGraph,
            [],
            patches,
            undefined,
            new Set(["REP-06"]),
          ),
        )
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            expect(Cause.hasInterrupts(f.cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("expected interrupted exit")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "decideGraphProjection round-trip probe does not mutate or wipe warm session fileFragmentCache",
    () =>
      Effect.gen(function* () {
        const repoRoot = process.cwd()
        const warmSession = createTypeScriptProgramSession(repoRoot, testHostIo)
        const sentinelKey = "__sentinel__/preserve-cache.ts"
        const hadSentinelBefore = warmSession.fileFragmentCache.has(sentinelKey)
        warmSession.fileFragmentCache.set(sentinelKey, {
          filePath: sentinelKey,
          packageTag: "domain",
          contentSha256: "0".repeat(64),
          declHash: "1".repeat(64),
          importedSpecs: [],
          fns: [],
          services: [],
          layers: [],
          errors: [],
          schemas: [],
          requiresService: [],
          failsWith: [],
          providesService: [],
          layerRequires: [],
          branchingViolations: [],
        })
        try {
          const specGraph = buildHarnessGraph({
            earsSpecs: [
              {
                id: "sample:SPEC-0001",
                title: "Probe isolation spec",
                status: "proposed",
                path: "libs/sample/docs/specs/probe.md",
                enforcedByFiles: ["libs/sample/domain/src/probe.ts"],
                referencedSpans: ["Sample.probe"],
                referencedServices: ["ProbeService"],
                referencedErrors: ["ProbeError"],
              },
            ],
          })
          const rewrite = yield* decideGraphRewrite(specGraph, "auto-plan")
          const rec = Option.getOrThrow(rewrite.result.recommendedCandidate)
          const res = yield* decideGraphProjection({
            workspaceRoot: repoRoot,
            initialGraph: specGraph,
            targetGraph: rewrite.targetGraph,
            patches: rec.patches,
            verifyRoundTrip: true,
          })
          expect(res.verificationStatus).toBe("Verified")
          expect(res.operations.length).toBeGreaterThan(0)
          expect(warmSession.fileFragmentCache.has(sentinelKey)).toBe(true)
        } finally {
          if (!hadSentinelBefore) {
            warmSession.fileFragmentCache.delete(sentinelKey)
          }
        }
      }),
  )
})
