import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { describe, expect, it } from "vitest"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  computeBaseTopologyHash,
  computeDeclHash,
  createTypeScriptProgramSession,
  diffHarnessGraphs,
  emitDeclarationSignatureText,
  evaluateOverlayDiagnostics,
  extractTypeAwareGraphFromSource,
  extractTypeGraph,
  extractWorkspaceTypeAwareGraph,
  findCallees,
  findCallers,
  findTestsReaching,
  isInfraOrCloudIdentifier,
  resolveNode,
  stripCommentsAndTestTitles,
} from "../src/index.js"
import { loadFileGraphFragmentsFromDisk } from "../src/extractor/compiler-session.js"
import { testHostIo } from "./helpers/test-host-io.js"
import {
  type EffectFnNode,
  getEdgeKey,
  getNodeKey,
  type ServiceLayerNode,
  type VitestCaseNode,
} from "../src/model.js"

describe("Type-aware Effect<A, E, R> and Layer<ROut, E, RIn> extractor", () => {
  it("extracts union E and R channels from both stub<A, E, R> skeletons and Effect.fn implementations", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Data, Effect } from "effect"
          export class OutOfStockError extends Data.TaggedError("OutOfStockError")<{ readonly sku: string }> {}
          export class PaymentError extends Data.TaggedError("PaymentError")<{ readonly reason: string }> {}
          export class InventoryRepo extends Context.Service<InventoryRepo, {
            readonly reserve: (sku: string) => Effect.Effect<void, OutOfStockError>
          }>()("InventoryRepo") {}
          export class PaymentService extends Context.Service<PaymentService, {
            readonly charge: (cents: number) => Effect.Effect<void, PaymentError>
          }>()("PaymentService") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/checkout.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { stub } from "@harness/gates"
          import { InventoryRepo, OutOfStockError, PaymentError, PaymentService } from "../../service/src/index.js"

          export const checkoutSkeleton = Effect.fn("Cart.checkout")(function* (sku: string) {
            return yield* stub<{ readonly orderId: string }, OutOfStockError | PaymentError, InventoryRepo | PaymentService>(sku)
          })
        `,
      },
    ])

    const callees = findCallees(graph, "Cart.checkout")
    expect(callees.map((c) => c.qualname).sort((a, b) => a.localeCompare(b))).toEqual([
      "InventoryRepo",
      "OutOfStockError",
      "PaymentError",
      "PaymentService",
    ])

    const fnNode = resolveNode(graph, "Cart.checkout") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode.isStub).toBe(true)
    expect(fnNode.packageTag).toBe("domain")

    const errorCallers = findCallers(graph, "OutOfStockError")
    expect(errorCallers).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/domain/src/checkout.ts#checkoutSkeleton",
        edgeKind: "FailsWith",
      }),
    ])
  })

  it("extracts non-stub Effect.fn implementation with decomposed union E and R channels", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Data, Effect } from "effect"
          export class OrderNotFound extends Data.TaggedError("OrderNotFound")<{ readonly orderId: string }> {}
          export class AuthError extends Data.TaggedError("AuthError")<{ readonly message: string }> {}
          export class OrderRepo extends Context.Service<OrderRepo, {
            readonly find: (id: string) => Effect.Effect<string, OrderNotFound>
          }>()("OrderRepo") {}
          export class AuthService extends Context.Service<AuthService, {
            readonly check: () => Effect.Effect<void, AuthError>
          }>()("AuthService") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/orders.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { OrderRepo, AuthService, OrderNotFound, AuthError } from "../../service/src/index.js"

          export const getOrder = Effect.fn("Orders.getOrder")(function* (orderId: string) {
            const auth = yield* AuthService
            yield* auth.check()
            const repo = yield* OrderRepo
            return yield* repo.find(orderId)
          })
        `,
      },
    ])

    const callees = findCallees(graph, "Orders.getOrder")
    expect(callees.map((c) => c.qualname).sort((a, b) => a.localeCompare(b))).toEqual([
      "AuthError",
      "AuthService",
      "OrderNotFound",
      "OrderRepo",
    ])

    const fnNode = resolveNode(graph, "Orders.getOrder") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode.isStub).toBe(false)
    expect(fnNode.packageTag).toBe("domain")
  })

  it("extracts Layer<ROut, E, RIn> with ProvidesService and LayerRequires edges", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Effect } from "effect"
          export class DatabaseService extends Context.Service<DatabaseService, {
            readonly query: (sql: string) => Effect.Effect<unknown>
          }>()("DatabaseService") {}
          export class CacheService extends Context.Service<CacheService, {
            readonly get: (key: string) => Effect.Effect<string | null>
          }>()("CacheService") {}
          export class UserRepo extends Context.Service<UserRepo, {
            readonly findById: (id: string) => Effect.Effect<string>
          }>()("UserRepo") {}
        `,
      },
      {
        filePath: "libs/sample/infra/src/user-repo-live.ts",
        packageTag: "infra",
        content: `
          import { Layer, Effect } from "effect"
          import { DatabaseService, CacheService, UserRepo } from "../../service/src/index.js"

          export const UserRepoLive: Layer.Layer<UserRepo, never, DatabaseService | CacheService> = Layer.effect(
            UserRepo,
            Effect.gen(function* () {
              const db = yield* DatabaseService
              const cache = yield* CacheService
              return {
                findById: (id: string) => Effect.succeed("user")
              }
            })
          )
        `,
      },
    ])

    const layerNode = resolveNode(
      graph,
      "libs/sample/infra/src/user-repo-live.ts#UserRepoLive",
    ) as ServiceLayerNode
    expect(layerNode).toBeDefined()
    expect(layerNode._tag).toBe("ServiceLayer")
    expect(layerNode.layerKind).toBe("live")

    const callees = findCallees(graph, "libs/sample/infra/src/user-repo-live.ts#UserRepoLive")
    const provides = callees.filter((c) => c.edgeKind === "ProvidesService")
    const requires = callees.filter((c) => c.edgeKind === "LayerRequires")

    expect(provides.map((p) => p.tagId)).toEqual(["UserRepo"])
    expect(requires.map((r) => r.tagId ?? "").sort((a, b) => a.localeCompare(b))).toEqual([
      "CacheService",
      "DatabaseService",
    ])
  })

  it("assigns layerKind: 'live' for InventoryLive defined in type:infra", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Effect } from "effect"
          export class InventoryRepo extends Context.Service<InventoryRepo, {
            readonly reserve: (sku: string) => Effect.Effect<void>
          }>()("InventoryRepo") {}
        `,
      },
      {
        filePath: "libs/sample/infra/src/index.ts",
        packageTag: "infra",
        content: `
          import { Layer, Effect } from "effect"
          import { InventoryRepo } from "../../service/src/index.js"

          export const InventoryLive: Layer.Layer<InventoryRepo> = Layer.succeed(InventoryRepo, {
            reserve: () => Effect.void
          })
        `,
      },
    ])

    const layerNode = resolveNode(
      graph,
      "libs/sample/infra/src/index.ts#InventoryLive",
    ) as ServiceLayerNode
    expect(layerNode).toBeDefined()
    expect(layerNode._tag).toBe("ServiceLayer")
    expect(layerNode.layerKind).toBe("live")
  })

  it("normalizes custom tagIds via classNameToTagId so no duplicate nodes are registered", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Effect } from "effect"
          export class CustomServiceClass extends Context.Service<CustomServiceClass, {
            readonly ping: () => Effect.Effect<string>
          }>()("custom.service.tag") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { stub } from "@harness/gates"
          import { CustomServiceClass } from "../../service/src/index.js"

          export const callCustom = Effect.fn("Sample.callCustom")(function* () {
            return yield* stub<string, never, CustomServiceClass>()
          })
        `,
      },
    ])

    const callees = findCallees(graph, "Sample.callCustom")
    expect(callees).toHaveLength(1)
    expect(callees[0]?.tagId).toBe("custom.service.tag")
  })

  it("extracts workspace type-aware graph from repoRoot", () => {
    const repoRoot = path.resolve(__dirname, "../../../..")
    const resultGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(repoRoot, testHostIo))

    // Sample greet function should be indexed
    const greetNode = resolveNode(resultGraph, "Sample.greet")
    expect(greetNode).toBeDefined()
    expect(greetNode?._tag).toBe("EffectFn")
  }, 15_000)

  it("stripCommentsAndTestTitles strips comments and describe/it/test titles", () => {
    const raw = `
      // calls Decider.run in line comment
      /* calls Decider.run in block comment */
      describe("Decider.run suite", () => {
        it('tests Decider.run behavior', () => {
          expect(1).toBe(1)
        })
        test(\`Decider.run template\`, () => {
          const run = "hello"
        })
      })
    `
    const stripped = stripCommentsAndTestTitles(raw)
    expect(stripped).not.toContain("Decider.run suite")
    expect(stripped).not.toContain("tests Decider.run behavior")
    expect(stripped).not.toContain("Decider.run template")
    expect(stripped).not.toContain("calls Decider.run")
    expect(stripped).toContain('describe("",')
    expect(stripped).toContain('it("",')
    expect(stripped).toContain('test("",')
  })

  it("extracts Schema.TaggedError<MyError>()('MyError', ...) as a TaggedError node", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/errors.ts",
        packageTag: "contract",
        content: `
          import { Schema } from "effect"
          export class MyError extends Schema.TaggedError<MyError>()("MyError", {
            message: Schema.String
          }) {}
        `,
      },
    ])

    const errorNode = resolveNode(graph, "MyError")
    expect(errorNode?._tag).toBe("TaggedError")
    if (errorNode === undefined) {
      expect.unreachable("Expected TaggedError node")
      return
    }
    match(errorNode)
      .with({ _tag: "TaggedError" }, (n) => {
        expect(n.errorTag).toBe("MyError")
        expect(n.file).toBe("libs/sample/contract/src/errors.ts")
      })
      .with(
        { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" },
        { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
        { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
        { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => expect.unreachable("Expected TaggedError node"),
      )
      .exhaustive()
  })

  it("extracts synchronous reducer evolveCart in domain as an EffectFn node with spanName Cart.evolve", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        packageTag: "domain",
        content: `
          export type CartState = { readonly items: ReadonlyArray<string> }
          export type CartEvent = { readonly _tag: "ItemAdded"; readonly itemId: string; readonly version: number }

          export const evolveCart = (state: CartState, event: CartEvent): CartState => {
            return state
          }
        `,
      },
    ])

    const fnNode = resolveNode(graph, "Cart.evolve") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode._tag).toBe("EffectFn")
    expect(fnNode.spanName).toBe("Cart.evolve")
    expect(fnNode.packageTag).toBe("domain")
    expect(fnNode.isStub).toBe(false)
  })

  it("extracts synchronous reducer exported function declaration in domain as an EffectFn node", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        packageTag: "domain",
        content: `
          export type CartState = { readonly items: ReadonlyArray<string> }
          export type CartEvent = { readonly _tag: "ItemAdded"; readonly itemId: string; readonly version: number }

          export function evolveCart(state: CartState, event: CartEvent): CartState {
            return state
          }
        `,
      },
    ])

    const fnNode = resolveNode(graph, "Cart.evolve") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode._tag).toBe("EffectFn")
    expect(fnNode.spanName).toBe("Cart.evolve")
    expect(fnNode.packageTag).toBe("domain")
    expect(fnNode.isStub).toBe(false)
  })

  it("propagates ExercisesSpan edges from a test referencing cartDecider to both decideCart and evolveCart", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-workspace-test-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")

      const domainSrcDir = path.join(tmpDir, "libs/sample/domain/src")
      fs.mkdirSync(domainSrcDir, { recursive: true })
      fs.writeFileSync(
        path.join(domainSrcDir, "cart.ts"),
        `
          import { Effect } from "effect"

          export type CartState = { readonly items: ReadonlyArray<string> }
          export type CartCommand = { readonly _tag: "AddItem"; readonly itemId: string }
          export type CartEvent = { readonly _tag: "ItemAdded"; readonly itemId: string; readonly version: number }

          export const decideCart = Effect.fn("Cart.decide")((cmd: CartCommand, state: CartState) =>
            Effect.succeed([])
          )

          export const evolveCart = (state: CartState, event: CartEvent): CartState => state

          export const cartDecider = Decider.make({
            initialState: { items: [] },
            decide: decideCart,
            evolve: evolveCart
          })
        `,
      )

      const domainTestDir = path.join(tmpDir, "libs/sample/domain/test")
      fs.mkdirSync(domainTestDir, { recursive: true })
      fs.writeFileSync(
        path.join(domainTestDir, "cart.test.ts"),
        `
          import { describe, it, expect } from "vitest"
          import { cartDecider } from "../src/cart.js"

          describe("cartDecider tests", () => {
            it("runs decider", () => {
              expect(cartDecider).toBeDefined()
            })
          })
        `,
      )

      const resultGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir, testHostIo))

      const decideNode = resolveNode(resultGraph, "Cart.decide")
      const evolveNode = resolveNode(resultGraph, "Cart.evolve")
      expect(decideNode).toBeDefined()
      expect(evolveNode).toBeDefined()

      const reachingDecide = findTestsReaching(resultGraph, "Cart.decide")
      const reachingEvolve = findTestsReaching(resultGraph, "Cart.evolve")

      expect(reachingDecide.some((t) => t.testFile.includes("cart.test.ts"))).toBe(true)
      expect(reachingEvolve.some((t) => t.testFile.includes("cart.test.ts"))).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("sets hasNonPrimitiveArbitrary: false for primitive scalar arbitraries and true for non-primitive arbitraries in prop tests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-prop-test-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")

      const testDir = path.join(tmpDir, "libs/sample/domain/test")
      fs.mkdirSync(testDir, { recursive: true })

      fs.writeFileSync(
        path.join(testDir, "primitive.test.ts"),
        `
          import { describe, it } from "vitest"
          describe("primitive suite", () => {
            it.effect.prop("test", [PositiveInt, Schema.String], () => {
              // property test with scalar primitives
            })
          })
        `,
      )

      fs.writeFileSync(
        path.join(testDir, "non-primitive.test.ts"),
        `
          import { describe, it } from "vitest"
          describe("non-primitive suite", () => {
            it.effect.prop("test", [Schema.Array(CartEvent)], () => {
              // property test with non-primitive arbitrary
            })
          })
        `,
      )

      const resultGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir, testHostIo))

      const primitiveNode = resolveNode(
        resultGraph,
        "libs/sample/domain/test/primitive.test.ts::suite",
      ) as VitestCaseNode
      expect(primitiveNode).toBeDefined()
      expect(primitiveNode.isPropertyTest).toBe(true)
      expect(primitiveNode.hasNonPrimitiveArbitrary).toBe(false)

      const nonPrimitiveNode = resolveNode(
        resultGraph,
        "libs/sample/domain/test/non-primitive.test.ts::suite",
      ) as VitestCaseNode
      expect(nonPrimitiveNode).toBeDefined()
      expect(nonPrimitiveNode.isPropertyTest).toBe(true)
      expect(nonPrimitiveNode.hasNonPrimitiveArbitrary).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not flag Schema.TaggedStruct state variants or aggregate *Id fields present on state as dead-event-payload", () => {
    const contractSource = `
      import { Schema } from "effect"

      export const EmptyCart = Schema.TaggedStruct("EmptyCart", {
        cartId: Schema.String
      })

      export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
        cartId: Schema.String,
        items: Schema.Array(Schema.String)
      })

      export const CheckedOutCart = Schema.TaggedStruct("CheckedOutCart", {
        cartId: Schema.String
      })

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: Schema.String,
        itemId: Schema.String
      })

      export const CartCheckedOut = Schema.TaggedStruct("CartCheckedOut", {
        cartId: Schema.String
      })
    `

    const domainSource = `
      import { match, P } from "ts-pattern"
      import { EmptyCart, ActiveCart, CheckedOutCart, ItemAdded, CartCheckedOut } from "../../contract/src/index.js"

      export type CartState =
        | typeof EmptyCart.Type
        | typeof ActiveCart.Type
        | typeof CheckedOutCart.Type

      export type CartEvent =
        | typeof ItemAdded.Type
        | typeof CartCheckedOut.Type

      export const evolve = (state: CartState, event: CartEvent): CartState =>
        match([state, event])
          .with([{ _tag: "CheckedOutCart" }, P._], () => state)
          .with([{ _tag: "EmptyCart" }, { _tag: "ItemAdded" }], ([, ev]) => ({
            _tag: "ActiveCart",
            cartId: state.cartId,
            items: [ev.itemId]
          }))
          .with([{ _tag: "ActiveCart" }, { _tag: "ItemAdded" }], ([s, ev]) => ({
            ...s,
            items: [...s.items, ev.itemId]
          }))
          .with([{ _tag: "ActiveCart" }, { _tag: "CartCheckedOut" }], ([s]) => ({
            _tag: "CheckedOutCart",
            cartId: s.cartId
          }))
          .otherwise(() => state)
    `

    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const violations = graph.branchingViolations ?? []
    const deadPayloadViolations = violations.filter((v) => v.rule === "dead-event-payload")
    expect(deadPayloadViolations).toEqual([])
  })

  it("shallow-decider-property-test catches object-syntax scalar-only arbitraries in it.effect.prop", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-prop-obj-test-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")

      const testDir = path.join(tmpDir, "libs/sample/domain/test")
      fs.mkdirSync(testDir, { recursive: true })

      fs.writeFileSync(
        path.join(testDir, "scalar-obj.test.ts"),
        `
          import { describe, it } from "vitest"
          describe("scalar object suite", () => {
            it.effect.prop("test", { cartId: Schema.String }, () => {
              // property test with scalar object syntax
            })
          })
        `,
      )

      fs.writeFileSync(
        path.join(testDir, "complex-obj.test.ts"),
        `
          import { describe, it } from "vitest"
          describe("complex object suite", () => {
            it.effect.prop("test", { cartId: Schema.String, events: Schema.Array(CartEvent) }, () => {
              // property test with non-primitive object syntax
            })
          })
        `,
      )

      const resultGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir, testHostIo))

      const scalarNode = resolveNode(
        resultGraph,
        "libs/sample/domain/test/scalar-obj.test.ts::suite",
      ) as VitestCaseNode
      expect(scalarNode).toBeDefined()
      expect(scalarNode.isPropertyTest).toBe(true)
      expect(scalarNode.hasNonPrimitiveArbitrary).toBe(false)

      const complexNode = resolveNode(
        resultGraph,
        "libs/sample/domain/test/complex-obj.test.ts::suite",
      ) as VitestCaseNode
      expect(complexNode).toBeDefined()
      expect(complexNode.isPropertyTest).toBe(true)
      expect(complexNode.hasNonPrimitiveArbitrary).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("diffHarnessGraphs succeeds when a stub variable is renamed while preserving spanName and file", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/decider.ts#thenEventsStub",
          spanName: "DeciderScenario.thenEvents",
          file: "libs/sample/domain/src/decider.ts",
          line: 10,
          packageTag: "domain",
          successType: "void",
          isStub: true,
        },
      ],
      services: [
        {
          tagId: "EventStore",
          name: "EventStore",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      errors: [
        {
          errorTag: "DeciderConflict",
          file: "libs/sample/contract/src/errors.ts",
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/sample/domain/src/decider.ts#thenEventsStub",
          tagId: "EventStore",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/decider.ts#thenEventsStub",
          errorTag: "DeciderConflict",
        },
      ],
    })

    const implGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/decider.ts#thenEventsLive",
          spanName: "DeciderScenario.thenEvents",
          file: "libs/sample/domain/src/decider.ts",
          line: 10,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "EventStore",
          name: "EventStore",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      errors: [
        {
          errorTag: "DeciderConflict",
          file: "libs/sample/contract/src/errors.ts",
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/sample/domain/src/decider.ts#thenEventsLive",
          tagId: "EventStore",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/decider.ts#thenEventsLive",
          errorTag: "DeciderConflict",
        },
      ],
    })

    const diff = diffHarnessGraphs(implGraph, planGraph)
    expect(diff.missingFns).toEqual([])
    expect(diff.missingServices).toEqual([])
    expect(diff.remainingStubs).toEqual([])
    expect(diff.missingEdges).toEqual([])
    expect(diff.isGreen).toBe(true)
  })

  it("flags node-sqlite-in-infra when type:infra source or test imports node:sqlite", () => {
    const hg = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/infra/src/memory.ts",
        packageTag: "infra",
        content: `
          import { DatabaseSync } from "node:sqlite"
          export const makeMock = () => new DatabaseSync(":memory:")
        `,
      },
    ])

    expect(hg.branchingViolations?.some((v) => v.rule === "node-sqlite-in-infra")).toBe(true)
  })

  it("extracts failsWith, requiresServices, inputSchema, and outputSchema from Effect.fn with generator return type and yield* new Error", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Data, Effect, Schema } from "effect"
          export class CustomTaggedError extends Data.TaggedError("CustomTaggedError")<{ readonly message: string }> {}
          export class MyService extends Context.Service<MyService, {
            readonly doWork: () => Effect.Effect<void>
          }>()("MyService") {}
          export const MyInputSchema = Schema.Struct({ readonly id: Schema.String })
          export type MyInputSchema = typeof MyInputSchema.Type
          export const MyResult = Schema.Struct({ readonly success: Schema.Boolean })
          export type MyResult = typeof MyResult.Type
        `,
      },
      {
        filePath: "libs/sample/domain/src/operation.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { CustomTaggedError, MyInputSchema, MyResult, MyService } from "../../service/src/index.js"

          export const performOp = Effect.fn("Domain.performOp")(
            function* (input: MyInputSchema): Effect.Effect<MyResult, CustomTaggedError, MyService> {
              const svc = yield* MyService
              if (!input.id) {
                return yield* new CustomTaggedError({ message: "missing id" })
              }
              return { success: true }
            }
          )
        `,
      },
    ])

    const fnNode = resolveNode(graph, "Domain.performOp") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode.inputSchema).toBe("MyInputSchema")
    expect(fnNode.outputSchema).toBe("MyResult")

    const callees = findCallees(graph, "Domain.performOp")
    const calleeNames = callees.map((c) => c.qualname)
    expect(calleeNames).toContain("CustomTaggedError")
    expect(calleeNames).toContain("MyService")

    const errorCallers = findCallers(graph, "CustomTaggedError")
    expect(errorCallers).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/domain/src/operation.ts#performOp",
        edgeKind: "FailsWith",
      }),
    ])
  })

  it("populates caughtErrors on EffectFnNode when Effect.catchTag is used (F-34)", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Data, Effect } from "effect"
          export class CustomTaggedError extends Data.TaggedError("CustomTaggedError")<{ readonly message: string }> {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/safe-op.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { CustomTaggedError } from "../../service/src/index.js"

          export const safeOp = Effect.fn("Domain.safeOp")(function* () {
            return yield* Effect.succeed(1).pipe(
              Effect.catchTag("CustomTaggedError", () => Effect.succeed(0))
            )
          })
        `,
      },
    ])

    const fnNode = resolveNode(graph, "Domain.safeOp") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode.caughtErrors).toEqual(["CustomTaggedError"])
  })

  it("isInfraOrCloudIdentifier returns false for contract schemas and true for infra/cloud identifiers (F-31)", () => {
    expect(isInfraOrCloudIdentifier("KVStoreSchema", "libs/sample/contract/src/index.ts")).toBe(
      false,
    )
    expect(isInfraOrCloudIdentifier("KVStoreSchema", "")).toBe(false)
    expect(isInfraOrCloudIdentifier("R2D2Validator", "libs/sample/contract/src/index.ts")).toBe(
      false,
    )
    expect(isInfraOrCloudIdentifier("R2D2Validator", "")).toBe(false)

    expect(isInfraOrCloudIdentifier("CloudflareKV", "libs/sample/infra/src/index.ts")).toBe(true)
    expect(isInfraOrCloudIdentifier("CloudflareKV", "")).toBe(true)
    expect(isInfraOrCloudIdentifier("R2Bucket", "libs/sample/infra/src/index.ts")).toBe(true)
    expect(isInfraOrCloudIdentifier("R2Bucket", "")).toBe(true)
  })

  it("PERF-01: warm TypeScriptProgramSession reuses unchanged SourceFiles and applies declHash early cut-off on body-only edits", async () => {
    const session = createTypeScriptProgramSession(process.cwd(), testHostIo)

    const baseFiles = [
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service" as const,
        content: `
          import { Context, Data, Effect } from "effect"
          export class OrderError extends Data.TaggedError("OrderError")<{ readonly code: number }> {}
          export class OrderPort extends Context.Service<OrderPort, {
            readonly save: (id: string) => Effect.Effect<number, OrderError>
          }>()("OrderPort") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/helper.ts",
        packageTag: "domain" as const,
        content: `
          import { Effect } from "effect"
          import { OrderPort, OrderError } from "../../service/src/index.js"
          export const runHelper = Effect.fn("Sample.runHelper")(function* (id: string): Effect.fn.Return<number, OrderError, OrderPort> {
            const port = yield* OrderPort
            const base = 10
            return yield* port.save(id + String(base))
          })
        `,
      },
      {
        filePath: "libs/sample/domain/src/caller.ts",
        packageTag: "domain" as const,
        content: `
          import { Effect } from "effect"
          import { OrderPort, OrderError } from "../../service/src/index.js"
          import { runHelper } from "./helper.js"
          export const runCaller = Effect.fn("Sample.runCaller")(function* (id: string): Effect.fn.Return<number, OrderError, OrderPort> {
            return yield* runHelper(id)
          })
        `,
      },
    ]

    // Cold pass extracts all 3 files
    const g1 = extractTypeAwareGraphFromSource(baseFiles, { session })
    expect(session.lastReextractedFiles).toHaveLength(3)
    expect(resolveNode(g1, "Sample.runCaller")).toBeDefined()

    // Warm identical pass reuses all 3 files from cache (0 re-extractions)
    const tWarmStart = performance.now()
    const g2 = extractTypeAwareGraphFromSource(baseFiles, { session })
    const warmElapsedMs = performance.now() - tWarmStart
    expect(session.lastReextractedFiles).toHaveLength(0)
    expect(session.warmHitCount).toBeGreaterThanOrEqual(3)
    expect(warmElapsedMs).toBeLessThan(50)
    expect(resolveNode(g2, "Sample.runCaller")).toBeDefined()

    // Body-only edit to helper.ts: declHash is unchanged -> signatureCleanCutoffCount increments and caller.ts is NOT re-extracted
    const bodyEditedHelper = `
          import { Effect } from "effect"
          import { OrderPort, OrderError } from "../../service/src/index.js"
          export const runHelper = Effect.fn("Sample.runHelper")(function* (id: string): Effect.fn.Return<number, OrderError, OrderPort> {
            const port = yield* OrderPort
            const base = 999
            return yield* port.save(id + String(base))
          })
        `
    expect(computeDeclHash(baseFiles[1]!.content)).toBe(computeDeclHash(bodyEditedHelper))

    const g3 = extractTypeAwareGraphFromSource(baseFiles, {
      session,
      overlays: {
        "libs/sample/domain/src/helper.ts": bodyEditedHelper,
      },
    })
    expect(session.signatureCleanCutoffCount).toBe(1)
    expect(session.lastReextractedFiles).toEqual(["libs/sample/domain/src/helper.ts"])
    expect(resolveNode(g3, "Sample.runCaller")).toBeDefined()

    // Exported signature edit to helper.ts: declHash changes -> re-extracts helper.ts AND its 1-hop reverse importer caller.ts
    const sigEditedHelper = `
          import { Effect } from "effect"
          import { OrderPort, OrderError } from "../../service/src/index.js"
          export const runHelper = Effect.fn("Sample.runHelper")(function* (id: string, extraFlag?: boolean): Effect.fn.Return<number, OrderError, OrderPort> {
            const port = yield* OrderPort
            return yield* port.save(extraFlag ? id : "default")
          })
        `
    expect(computeDeclHash(bodyEditedHelper)).not.toBe(computeDeclHash(sigEditedHelper))

    extractTypeAwareGraphFromSource(baseFiles, {
      session,
      overlays: {
        "libs/sample/domain/src/helper.ts": sigEditedHelper,
      },
    })
    expect([...session.lastReextractedFiles].sort()).toEqual([
      "libs/sample/domain/src/caller.ts",
      "libs/sample/domain/src/helper.ts",
    ])

    // Verify extractTypeGraph Effect.fn("TypeExtractor.extractWorkspace") over a temp mini-workspace
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-warm-ws-"))
    try {
      const sampleSrcDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
      fs.mkdirSync(sampleSrcDir, { recursive: true })
      fs.writeFileSync(
        path.join(sampleSrcDir, "index.ts"),
        `import { Effect } from "effect"\nexport const ping = Effect.fn("Sample.ping")(function* () { return yield* Effect.succeed(1) })\n`,
        "utf-8",
      )
      const wsSession = createTypeScriptProgramSession(tmpRoot, testHostIo)
      wsSession.persistToDisk = true
      const wsGraph1 = await Effect.runPromise(
        extractTypeGraph({ repoRoot: tmpRoot, hostIo: testHostIo, session: wsSession }),
      )
      expect(resolveNode(wsGraph1, "Sample.ping")?._tag).toBe("EffectFn")

      const wsGraph2 = await Effect.runPromise(
        extractTypeGraph({ repoRoot: tmpRoot, hostIo: testHostIo, session: wsSession }),
      )
      expect(wsSession.lastReextractedFiles).toEqual([])
      expect(resolveNode(wsGraph2, "Sample.ping")?._tag).toBe("EffectFn")
      const firstSf = wsSession.sourceFileCache.values().next().value?.sourceFile
      expect(firstSf).toBeDefined()
      if (firstSf !== undefined) {
        expect(emitDeclarationSignatureText(firstSf)).toContain("Effect.fn")
      }

      // Verify persistent .harness/cache/file-graph-v1.json reload across cold process sessions (F-9)
      const reloadedSession = createTypeScriptProgramSession(tmpRoot, testHostIo)
      reloadedSession.persistToDisk = true
      loadFileGraphFragmentsFromDisk(tmpRoot, reloadedSession, testHostIo)
      const wsGraphReloaded = await Effect.runPromise(
        extractTypeGraph({ repoRoot: tmpRoot, hostIo: testHostIo, session: reloadedSession }),
      )
      expect(reloadedSession.lastReextractedFiles).toEqual([])
      const reloadedNodeKeys = Array.from(Graph.nodes(wsGraphReloaded.graph))
        .map(([, n]) => getNodeKey(n))
        .sort()
      const origNodeKeys = Array.from(Graph.nodes(wsGraph1.graph))
        .map(([, n]) => getNodeKey(n))
        .sort()
      expect(reloadedNodeKeys).toEqual(origNodeKeys)
      const reloadedEdgeKeys = Array.from(Graph.edges(wsGraphReloaded.graph))
        .map(([, e]) => getEdgeKey(e.data))
        .sort()
      const origEdgeKeys = Array.from(Graph.edges(wsGraph1.graph))
        .map(([, e]) => getEdgeKey(e.data))
        .sort()
      expect(reloadedEdgeKeys).toEqual(origEdgeKeys)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("maintains strict warm-vs-cold graph equality across unannotated inferred-return edits, 2-hop cones, file add/delete, and packageTag changes (F-4, F-5, F-13)", () => {
    const session = createTypeScriptProgramSession("/virtual-eq-repo")

    const assertWarmEqualsCold = (
      inputs: Parameters<typeof extractTypeAwareGraphFromSource>[0],
      overlays?: Readonly<Record<string, string>>,
    ) => {
      const warm = extractTypeAwareGraphFromSource(inputs, {
        repoRoot: "/virtual-eq-repo",
        session,
        ...(overlays !== undefined ? { overlays } : {}),
      })
      const cold = extractTypeAwareGraphFromSource(inputs, {
        repoRoot: "/virtual-eq-repo",
        ...(overlays !== undefined ? { overlays } : {}),
      })
      const warmNodes = Array.from(Graph.nodes(warm.graph))
        .map(([, n]) => [getNodeKey(n), n] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      const coldNodes = Array.from(Graph.nodes(cold.graph))
        .map(([, n]) => [getNodeKey(n), n] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      expect(warmNodes).toEqual(coldNodes)

      const warmEdges = Array.from(Graph.edges(warm.graph))
        .map(([, e]) => [getEdgeKey(e.data), e.data] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      const coldEdges = Array.from(Graph.edges(cold.graph))
        .map(([, e]) => [getEdgeKey(e.data), e.data] as const)
        .sort(([a], [b]) => a.localeCompare(b))
      expect(warmEdges).toEqual(coldEdges)
      expect(warm.branchingViolations).toEqual(cold.branchingViolations)
      return warm
    }

    const baseFiles: Parameters<typeof extractTypeAwareGraphFromSource>[0] = [
      {
        filePath: "libs/sample/service/src/index.ts",
        packageTag: "service",
        content: `
          import { Context, Data, Effect } from "effect"
          export class OrderError extends Data.TaggedError("OrderError")<{ readonly message: string }> {}
          export class ExtraError extends Data.TaggedError("ExtraError")<{ readonly reason: string }> {}
          export class OrderPort extends Context.Service<OrderPort, {
            readonly save: (id: string) => Effect.Effect<number, OrderError>
          }>()("Sample/OrderPort") {}
        `,
      },
      {
        filePath: "libs/sample/domain/src/helper.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { OrderPort, OrderError, ExtraError } from "../../service/src/index.js"
          export const runUnannotatedHelper = Effect.fn("Sample.runUnannotatedHelper")(function* (id: string) {
            return yield* Effect.succeed(id.length)
          })
        `,
      },
      {
        filePath: "libs/sample/domain/src/caller.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          import { runUnannotatedHelper } from "./helper.js"
          export const runCaller = Effect.fn("Sample.runCaller")(function* (id: string) {
            return yield* runUnannotatedHelper(id)
          })
        `,
      },
    ]

    // 1. Initial warm population matches cold
    assertWarmEqualsCold(baseFiles)

    // 2. Unannotated inferred-return edit in helper.ts (adds OrderPort + ExtraError without explicit return annotation) (F-4)
    const inferredReturnEditedHelper = `
          import { Effect } from "effect"
          import { OrderPort, OrderError, ExtraError } from "../../service/src/index.js"
          export const runUnannotatedHelper = Effect.fn("Sample.runUnannotatedHelper")(function* (id: string) {
            const port = yield* OrderPort
            if (id.length === 0) {
              return yield* Effect.fail(new ExtraError({ reason: "empty" }))
            }
            return yield* port.save(id)
          })
        `
    expect(computeDeclHash(baseFiles[1]!.content)).not.toBe(
      computeDeclHash(inferredReturnEditedHelper),
    )
    assertWarmEqualsCold(baseFiles, {
      "libs/sample/domain/src/helper.ts": inferredReturnEditedHelper,
    })
    expect([...session.lastReextractedFiles].sort()).toEqual([
      "libs/sample/domain/src/caller.ts",
      "libs/sample/domain/src/helper.ts",
    ])

    // 3. 2-hop cone invalidation: editing service/src/index.ts invalidates helper.ts AND caller.ts
    const editedService = `
          import { Context, Data, Effect } from "effect"
          export class OrderError extends Data.TaggedError("OrderError")<{ readonly message: string; readonly code?: number }> {}
          export class ExtraError extends Data.TaggedError("ExtraError")<{ readonly reason: string }> {}
          export class OrderPort extends Context.Service<OrderPort, {
            readonly save: (id: string) => Effect.Effect<number, OrderError>
          }>()("Sample/OrderPort") {}
        `
    assertWarmEqualsCold(baseFiles, {
      "libs/sample/service/src/index.ts": editedService,
      "libs/sample/domain/src/helper.ts": inferredReturnEditedHelper,
    })
    expect([...session.lastReextractedFiles].sort()).toEqual([
      "libs/sample/domain/src/caller.ts",
      "libs/sample/domain/src/helper.ts",
      "libs/sample/service/src/index.ts",
    ])

    // 4. Adding a new file and then deleting a file matches cold extraction
    const withAddedFile: Parameters<typeof extractTypeAwareGraphFromSource>[0] = [
      ...baseFiles,
      {
        filePath: "libs/sample/domain/src/extra.ts",
        packageTag: "domain",
        content: `
          import { Effect } from "effect"
          export const runExtra = Effect.fn("Sample.runExtra")(function* () {
            return yield* Effect.succeed("ok")
          })
        `,
      },
    ]
    const warmAdded = assertWarmEqualsCold(withAddedFile)
    expect(resolveNode(warmAdded, "Sample.runExtra")).toBeDefined()

    const warmAfterDelete = assertWarmEqualsCold(baseFiles)
    expect(resolveNode(warmAfterDelete, "Sample.runExtra")).toBeUndefined()

    // 5. Changing packageTag on unchanged file content invalidates warm cache and matches cold (F-13)
    const retaggedFiles: Parameters<typeof extractTypeAwareGraphFromSource>[0] = [
      baseFiles[0]!,
      {
        ...baseFiles[1]!,
        packageTag: "infra",
      },
      baseFiles[2]!,
    ]
    assertWarmEqualsCold(retaggedFiles)
    expect(session.lastReextractedFiles).toContain("libs/sample/domain/src/helper.ts")
  })

  it("evicts stale overlay SourceFile when removed from session and matches computeBaseTopologyHash", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-overlay-cache-"))
    try {
      const domainDir = path.join(tmpRoot, "libs", "sample", "domain", "src")
      fs.mkdirSync(domainDir, { recursive: true })
      fs.writeFileSync(path.join(domainDir, "index.ts"), "export const okValue: number = 1\n", "utf-8")

      const session = createTypeScriptProgramSession(tmpRoot, testHostIo)
      const brokenDiags = evaluateOverlayDiagnostics(
        tmpRoot,
        { "libs/sample/domain/src/index.ts": 'export const okValue: number = "broken"\n' },
        session,
      )
      expect(brokenDiags.some((d) => d.severity === "error")).toBe(true)

      // Subsequent check with another file (removing index.ts overlay) must read disk index.ts, not stale overlay AST
      const cleanDiags = evaluateOverlayDiagnostics(
        tmpRoot,
        { "libs/sample/domain/src/extra.ts": 'import { okValue } from "./index.js"\nexport const doubled: number = okValue * 2\n' },
        session,
      )
      expect(cleanDiags.filter((d) => d.severity === "error")).toEqual([])

      const g1 = await Effect.runPromise(extractWorkspaceTypeAwareGraph(tmpRoot, testHostIo, { session }))
      expect(session.lastWorkspaceSnapshot?.baseTopologyHash).toBe(computeBaseTopologyHash(session))
      expect(g1.nodeIndexByKey).toBeInstanceOf(Map)
      expect(g1.branchingViolations).toEqual([])
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("rejects symlink escaping repoRoot and never incorporates external symbols into extracted HarnessGraph (F-5)", async () => {
    const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-outside-escape-"))
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-escape-"))
    try {
      fs.writeFileSync(path.join(tmpRepo, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      const domainDir = path.join(tmpRepo, "libs", "sample", "domain", "src")
      fs.mkdirSync(domainDir, { recursive: true })

      // Internal valid domain file
      fs.writeFileSync(
        path.join(domainDir, "valid.ts"),
        `import { Effect } from "effect"\nexport const validFn = Effect.fn("Sample.validFn")(function* () { return yield* Effect.succeed(42) })\n`,
        "utf-8",
      )

      // External escaped file located entirely outside repoRoot
      const externalFile = path.join(tmpOutside, "escaped.ts")
      fs.writeFileSync(
        externalFile,
        `import { Effect } from "effect"\nexport const secretFn = Effect.fn("Sample.secretFn")(function* () { return yield* Effect.succeed("leak") })\n`,
        "utf-8",
      )

      // Symlink pointing to external file inside domain src
      const symlinkPath = path.join(domainDir, "escaped-link.ts")
      fs.symlinkSync(externalFile, symlinkPath)

      // 1. Direct workspace extraction ignores symlink escaping repoRoot
      const graph = await Effect.runPromise(extractWorkspaceTypeAwareGraph(tmpRepo, testHostIo))
      expect(graph.nodeIndexByKey).toBeInstanceOf(Map)
      expect(resolveNode(graph, "Sample.validFn")?._tag).toBe("EffectFn")
      expect(resolveNode(graph, "Sample.secretFn")).toBeUndefined()

      // 2. Overlay normalization also rejects symlink escaping repoRoot
      const overlayResult = await Effect.runPromise(
        extractWorkspaceTypeAwareGraph(tmpRepo, testHostIo, {
          overlays: {
            "libs/sample/domain/src/escaped-link.ts": `import { Effect } from "effect"\nexport const secretFn = Effect.fn("Sample.secretFn")(function* () { return yield* Effect.succeed("overlay-leak") })\n`,
            "../../outside-escape.ts": `import { Effect } from "effect"\nexport const secretFn = Effect.fn("Sample.secretFn")(function* () { return yield* Effect.succeed("overlay-leak2") })\n`,
          },
        }),
      )
      expect(overlayResult.nodeIndexByKey).toBeInstanceOf(Map)
      expect(resolveNode(overlayResult, "Sample.secretFn")).toBeUndefined()
      expect(resolveNode(overlayResult, "Sample.validFn")?._tag).toBe("EffectFn")
    } finally {
      fs.rmSync(tmpOutside, { recursive: true, force: true })
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
