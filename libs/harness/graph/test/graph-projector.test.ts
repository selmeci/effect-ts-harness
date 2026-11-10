import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  decideGraphProjection,
  decideGraphRewrite,
  type EntityNode,
  type GraphMeasure,
  type GraphPatch,
  GraphProjector,
  type HarnessGraph,
  NodeKey,
  NonNegativeCount,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
  type RewritePhase,
  RewriteRuleId,
} from "../src/index.js"

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
        expect(barrelOverlay).toBeDefined()
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
        const patch1 = makePatch({
          ruleId: RewriteRuleId.make("REP-05"),
          primaryNodeKey: NodeKey.make("EffectFn:fn1"),
        })
        const patch2 = makePatch({
          ruleId: RewriteRuleId.make("REP-06"),
          primaryNodeKey: NodeKey.make("SchemaDef:sc1"),
        })
        const patch3 = makePatch({
          ruleId: RewriteRuleId.make("REP-07"),
          primaryNodeKey: NodeKey.make("EffectFn:fn2"),
        })
        const patch4 = makePatch({
          ruleId: RewriteRuleId.make("REP-08"),
          primaryNodeKey: NodeKey.make("EffectFn:fn3"),
        })
        const patch5 = makePatch({
          ruleId: RewriteRuleId.make("REP-10"),
          primaryNodeKey: NodeKey.make("EffectFn:fn4"),
        })

        const fivePatches = [patch1, patch2, patch3, patch4, patch5]

        const result = yield* decideGraphProjection({
          initialGraph: emptyGraph,
          targetGraph: emptyGraph,
          patches: fivePatches,
          verifyRoundTrip: true,
          forceFailRuleIds: [RewriteRuleId.make("REP-06")],
        })

        expect(result.skippedRuleIds).toContain(RewriteRuleId.make("REP-06"))
        expect(result.roundTripVerified).toBe(false)
        expect(result.bisectionProbes).toBeGreaterThan(0)
        expect(result.bisectionProbes).toBeLessThanOrEqual(Math.ceil(Math.log2(5)) + 2)
      }),
  )

  it.effect(
    "REQ-4.4: Fails closed with GraphProjectorError on malformed GraphPatch with empty file path",
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

        const error = yield* Effect.flip(
          decideGraphProjection({
            targetGraph: emptyGraph,
            patches: [malformedPatch],
            verifyRoundTrip: false,
          }),
        )

        match(error)
          .with({ _tag: "GraphProjectorError" }, (projErr) => {
            expect(projErr._tag).toBe("GraphProjectorError")
            expect(projErr.reason).toBe("invalid-patch-target")
          })
          .exhaustive()
      }),
  )
})
