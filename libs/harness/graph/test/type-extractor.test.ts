import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  extractTypeAwareGraphFromSource,
  extractWorkspaceTypeAwareGraph,
  findCallees,
  findCallers,
  resolveNode,
  stripCommentsAndTestTitles
} from "../src/index.js"
import type { EffectFnNode, ServiceLayerNode } from "../src/model.js"

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
        `
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
        `
      }
    ])

    const callees = findCallees(graph, "Cart.checkout")
    expect(callees.map((c) => c.qualname).sort((a, b) => a.localeCompare(b))).toEqual([
      "InventoryRepo",
      "OutOfStockError",
      "PaymentError",
      "PaymentService"
    ])

    const fnNode = resolveNode(graph, "Cart.checkout") as EffectFnNode
    expect(fnNode).toBeDefined()
    expect(fnNode.isStub).toBe(true)
    expect(fnNode.packageTag).toBe("domain")

    const errorCallers = findCallers(graph, "OutOfStockError")
    expect(errorCallers).toEqual([
      expect.objectContaining({
        qualname: "libs/sample/domain/src/checkout.ts#checkoutSkeleton",
        edgeKind: "FailsWith"
      })
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
        `
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
        `
      }
    ])

    const callees = findCallees(graph, "Orders.getOrder")
    expect(callees.map((c) => c.qualname).sort((a, b) => a.localeCompare(b))).toEqual([
      "AuthError",
      "AuthService",
      "OrderNotFound",
      "OrderRepo"
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
        `
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
                findById: (id: string) => db.query("select * from users") as any
              }
            })
          )
        `
      }
    ])

    const layerNode = resolveNode(
      graph,
      "libs/sample/infra/src/user-repo-live.ts#UserRepoLive"
    ) as ServiceLayerNode
    expect(layerNode).toBeDefined()
    expect(layerNode._tag).toBe("ServiceLayer")
    expect(layerNode.layerKind).toBe("live")

    const callees = findCallees(graph, "libs/sample/infra/src/user-repo-live.ts#UserRepoLive")
    const provides = callees.filter((c) => c.edgeKind === "ProvidesService")
    const requires = callees.filter((c) => c.edgeKind === "LayerRequires")

    expect(provides.map((p) => p.tagId)).toEqual(["UserRepo"])
    expect(
      requires.map((r) => r.tagId ?? "").sort((a, b) => a.localeCompare(b))
    ).toEqual(["CacheService", "DatabaseService"])
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
        `
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
        `
      }
    ])

    const layerNode = resolveNode(
      graph,
      "libs/sample/infra/src/index.ts#InventoryLive"
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
        `
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
        `
      }
    ])

    const callees = findCallees(graph, "Sample.callCustom")
    expect(callees).toHaveLength(1)
    expect(callees[0]?.tagId).toBe("custom.service.tag")
  })

  it("extracts workspace type-aware graph from repoRoot", () => {
    const repoRoot = path.resolve(__dirname, "../../../..")
    const resultGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(repoRoot))

    // Sample greet function should be indexed
    const greetNode = resolveNode(resultGraph, "Sample.greet")
    expect(greetNode).toBeDefined()
    expect(greetNode?._tag).toBe("EffectFn")
  })

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
})

