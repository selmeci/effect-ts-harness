import { describe, expect, it } from "@effect/vitest"
import { makeTestFnNode } from "./helpers/policy-check-fixture.js"
import { buildHarnessGraph } from "../src/graph-engine.js"
import { checkEffectGraph, isAggregateFnNode } from "../src/policy-check.js"
import { extractTypeAwareGraphFromSource } from "../src/type-extractor.js"

describe("isAggregateFnNode", () => {
  it("detects aggregate functions by span name prefixes and suffixes or file patterns", () => {
    expect(isAggregateFnNode(makeTestFnNode({ spanName: "Aggregate.handleCommand" }))).toBe(true)
    expect(isAggregateFnNode(makeTestFnNode({ spanName: "AggregateInfra.commit" }))).toBe(true)
    expect(isAggregateFnNode(makeTestFnNode({ spanName: "AggregateHttp.executeCommand" }))).toBe(
      true,
    )
    expect(isAggregateFnNode(makeTestFnNode({ spanName: "Order.handleCommand" }))).toBe(true)
    expect(isAggregateFnNode(makeTestFnNode({ spanName: "Order.executeCommand" }))).toBe(true)
    expect(
      isAggregateFnNode(
        makeTestFnNode({ file: "libs/es/infra/src/cart-aggregate.ts", spanName: "other" }),
      ),
    ).toBe(true)
    expect(
      isAggregateFnNode(
        makeTestFnNode({ file: "libs/es/infra/src/outbox.ts", spanName: "Outbox.relay" }),
      ),
    ).toBe(false)
  })
})

describe("effect-graph:check policy rules", () => {
  it("fails when a type:domain Effect.fn requires an infra ServiceTag or cloud binding in R", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#badUseCase",
          spanName: "Sample.badUseCase",
          file: "libs/sample/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: true,
        },
      ],
      services: [
        {
          tagId: "Cloudflare.R2.BucketBinding",
          name: "BucketBinding",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#badUseCase",
          tagId: "Cloudflare.R2.BucketBinding",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe("domain-requires-infra")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/domain/src/index.ts#badUseCase",
      "Cloudflare.R2.BucketBinding",
    ])
  })

  it("fails when ServiceLayers form a dependency cycle via Graph.findCycle", () => {
    const graph = buildHarnessGraph({
      fns: [],
      services: [
        { tagId: "SvcA", name: "SvcA", packageTag: "service", file: "a.ts" },
        { tagId: "SvcB", name: "SvcB", packageTag: "service", file: "b.ts" },
      ],
      layers: [
        { qualname: "LayerA", layerKind: "live", packageTag: "infra", file: "a.ts" },
        { qualname: "LayerB", layerKind: "live", packageTag: "infra", file: "b.ts" },
      ],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [
        { layerQualname: "LayerA", tagId: "SvcA" },
        { layerQualname: "LayerB", tagId: "SvcB" },
      ],
      layerRequires: [
        { layerQualname: "LayerA", tagId: "SvcB" },
        { layerQualname: "LayerB", tagId: "SvcA" },
      ],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "layer-cycle")).toBe(true)
  })

  it("fails when a type:domain Effect.fn requires a cloud binding or provider tagged as service", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#orderUseCase",
          spanName: "Order.checkout",
          file: "libs/sample/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "Provider<Database>",
          name: "Provider<Database>",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#orderUseCase",
          tagId: "Provider<Database>",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe("domain-requires-cloud-binding")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/domain/src/index.ts#orderUseCase",
      "Provider<Database>",
    ])
  })

  it("fails when a type:domain decider Effect.fn requires services (impure-decider)", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#decide",
          spanName: "Order.decide",
          file: "libs/sample/domain/src/index.ts",
          line: 10,
          packageTag: "domain",
          successType: "OrderEvent",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "OrderRepository",
          name: "OrderRepository",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#decide",
          tagId: "OrderRepository",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const impureViolation = result.violations.find((v) => v.rule === "impure-decider")
    expect(impureViolation).toBeDefined()
    expect(impureViolation?.path).toEqual([
      "libs/sample/domain/src/index.ts#decide",
      "OrderRepository",
    ])
  })

  it("end-to-end: extracts from source skeleton with forbidden infra dependency and reports violation", () => {
    const domainSource = `
import { Effect } from "effect"
import { stub } from "@harness/contract"

export class R2BucketBinding {
  static readonly _tag = "ServiceTag"
}

export const badDomainFn = Effect.fn("BadDomain.run")(() =>
  stub<void, never, R2BucketBinding>()
)
`
    const infraSource = `
import { Context } from "effect"

export class R2BucketBinding extends Context.Service<R2BucketBinding, { readonly bucket: string }>()(
  "Cloudflare.R2.BucketBinding"
) {}
`

    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
      {
        filePath: "libs/sample/infra/src/index.ts",
        content: infraSource,
        packageTag: "infra",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(
      result.violations.some(
        (v) => v.rule === "domain-requires-infra" || v.rule === "domain-requires-cloud-binding",
      ),
    ).toBe(true)
  })

  it("end-to-end: passes on clean type-aware graph with valid architecture and returns mermaid", () => {
    const contractSource = `
import { Data, Schema } from "effect"

export const OrderId = Schema.String.pipe(Schema.brand("OrderId"))
export type OrderId = typeof OrderId.Type

export class OrderNotFoundError extends Data.TaggedError("OrderNotFoundError")<{
  readonly orderId: OrderId
}> {}
`
    const serviceSource = `
import { type Brand, Context, Effect } from "effect"
import type { OrderNotFoundError } from "./contract.js"

type OrderId = string & Brand.Brand<"OrderId">

export class OrderRepo extends Context.Service<OrderRepo, {
  readonly get: (id: OrderId) => Effect.Effect<OrderId, OrderNotFoundError>
}>()("OrderRepo") {}
`
    const domainSource = `
import { type Brand, Effect } from "effect"
import { OrderRepo } from "./service.js"

type OrderId = string & Brand.Brand<"OrderId">

export const getOrder = Effect.fn("Order.get")((id: OrderId) =>
  Effect.gen(function* () {
    const repo = yield* OrderRepo
    return yield* repo.get(id)
  })
)

export const pureDecider = Effect.fn("Order.decide")((cmd: OrderId) =>
  Effect.succeed(cmd)
)
`
    const infraSource = `
import { type Brand, Layer, Effect } from "effect"
import { OrderRepo } from "./service.js"

type OrderId = string & Brand.Brand<"OrderId">

export const OrderRepoLive: Layer.Layer<OrderRepo> = Layer.succeed(OrderRepo, {
  get: (id: OrderId) => Effect.succeed(id)
})
`

    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/service/src/index.ts",
        content: serviceSource,
        packageTag: "service",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
      {
        filePath: "libs/sample/infra/src/index.ts",
        content: infraSource,
        packageTag: "infra",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.mermaid).toContain("flowchart")
  })

  it("fails when a contract decider EffectFn requires services (impure-decider)", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/contract/src/index.ts#contractDecider",
          spanName: "Order.decide",
          file: "libs/sample/contract/src/index.ts",
          line: 10,
          packageTag: "contract",
          successType: "OrderEvent",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "OrderRepo",
          name: "OrderRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/contract/src/index.ts#contractDecider",
          tagId: "OrderRepo",
        },
      ],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.rule).toBe("impure-decider")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/contract/src/index.ts#contractDecider",
      "OrderRepo",
    ])
  })

  it("fails with impure-reducer when a reducer EffectFn requires services or fails with an error", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#evolveCart",
          spanName: "Cart.evolve",
          file: "libs/sample/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "CartState",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "DatabasePort",
          name: "DatabasePort",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [],
      errors: [
        {
          errorTag: "CartError",
          file: "libs/sample/contract/src/index.ts",
        },
      ],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#evolveCart",
          tagId: "DatabasePort",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#evolveCart",
          errorTag: "CartError",
        },
      ],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const reducerViolations = result.violations.filter((v) => v.rule === "impure-reducer")
    expect(reducerViolations).toHaveLength(2)
    expect(
      reducerViolations.some((v) => v.message.includes("pure and cannot require service")),
    ).toBe(true)
    expect(reducerViolations.some((v) => v.message.includes("infallible and cannot fail"))).toBe(
      true,
    )
  })

  it("fails with unscoped-effect-run for Effect.runSync inside Decider.make or domain, while allowing Effect.runPromise in testing.ts outside Decider.make", () => {
    const domainSource = `
      import { Effect } from "effect"

      export const evolveCart = (s: unknown, e: unknown): unknown => {
        return Effect.runSync(Effect.succeed(s))
      }
    `
    const domainGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])
    const domainResult = checkEffectGraph(domainGraph)
    expect(domainResult.violations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

    const deciderSource = `
      import { Effect } from "effect"

      export const cartDecider = Decider.make({
        initialState: {},
        decide: () => Effect.succeed([]),
        evolve: (s: unknown, e: unknown) => Effect.runSync(Effect.succeed(s))
      })
    `
    const deciderGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/decider.ts",
        content: deciderSource,
        packageTag: "domain",
      },
    ])
    const deciderResult = checkEffectGraph(deciderGraph)
    expect(deciderResult.violations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

    const testingSource = `
      import { Effect } from "effect"

      export const runScenario = async () => {
        return await Effect.runPromise(Effect.succeed(true))
      }
    `
    const testingGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/testing.ts",
        content: testingSource,
        packageTag: "domain",
      },
    ])
    const testingResult = checkEffectGraph(testingGraph)
    expect(testingResult.violations.filter((v) => v.rule === "unscoped-effect-run")).toHaveLength(0)
  })

  it("fails with domain-requires-infra when domain/core requires SqlClient and schema-boolean-state when exported interface uses publish?: boolean", () => {
    const badCoreSource = `
      import { Effect } from "effect"
      import { SqlClient } from "effect/sql/SqlClient"

      export interface EngineConfig {
        readonly publish?: boolean | undefined
      }

      export const runInCore = Effect.fn("Core.run")(function* (cfg: EngineConfig) {
        const sql = yield* SqlClient
        return yield* sql\`SELECT 1\`
      })
    `
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/engine.ts",
        content: badCoreSource,
        packageTag: "domain",
      },
    ])
    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(
      result.violations.some(
        (v) => v.rule === "domain-requires-infra" && v.message.includes("SqlClient"),
      ),
    ).toBe(true)
    expect(
      result.violations.some(
        (v) =>
          v.rule === "schema-boolean-state" &&
          v.message.includes("Interface property 'publish' on 'EngineConfig'"),
      ),
    ).toBe(true)
  })

  it("fails with aggregate-direct-bus-publish when an Aggregate function has a RequiresService edge to EventBus", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          spanName: "Aggregate.handleCommand",
          file: "libs/sample/infra/src/aggregate.ts",
          line: 10,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "EventBus",
          name: "EventBus",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          tagId: "EventBus",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "aggregate-direct-bus-publish")
    expect(violation).toBeDefined()
    expect(violation?.rule).toBe("aggregate-direct-bus-publish")
    expect(violation?.path).toEqual([
      "libs/sample/infra/src/aggregate.ts#handleCommand",
      "EventBus",
    ])
  })

  it("passes when Aggregate.handleCommand requires only SqlClient and Outbox.drain requires EventBus", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          spanName: "Aggregate.handleCommand",
          file: "libs/sample/infra/src/aggregate.ts",
          line: 10,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/sample/infra/src/outbox.ts#drain",
          spanName: "Outbox.drain",
          file: "libs/sample/infra/src/outbox.ts",
          line: 20,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "SqlClient",
          name: "SqlClient",
          packageTag: "infra",
          file: "libs/sample/infra/src/sql.ts",
        },
        {
          tagId: "EventBus",
          name: "EventBus",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          tagId: "SqlClient",
        },
        {
          fnQualname: "libs/sample/infra/src/outbox.ts#drain",
          tagId: "EventBus",
        },
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it("fails with aggregate-direct-bus-publish when Aggregate.handleCommand has a tracedCalls edge to Outbox.drain", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          spanName: "Aggregate.handleCommand",
          file: "libs/sample/infra/src/aggregate.ts",
          line: 10,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/sample/infra/src/outbox.ts#drain",
          spanName: "Outbox.drain",
          file: "libs/sample/infra/src/outbox.ts",
          line: 20,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [
        {
          callerQualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          calleeQualname: "libs/sample/infra/src/outbox.ts#drain",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "aggregate-direct-bus-publish")
    expect(violation).toBeDefined()
    expect(violation?.rule).toBe("aggregate-direct-bus-publish")
    expect(violation?.path[0]).toBe("libs/sample/infra/src/aggregate.ts#handleCommand")
    expect(["libs/sample/infra/src/outbox.ts#drain", "Outbox.drain"]).toContain(violation?.path[1])
  })

  it("fails with aggregate-direct-bus-publish when Aggregate.handleCommand has a tracedCalls edge to EventBus.publish", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          spanName: "Aggregate.handleCommand",
          file: "libs/sample/infra/src/aggregate.ts",
          line: 10,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/sample/infra/src/bus.ts#publish",
          spanName: "EventBus.publish",
          file: "libs/sample/infra/src/bus.ts",
          line: 15,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [
        {
          callerQualname: "libs/sample/infra/src/aggregate.ts#handleCommand",
          calleeQualname: "libs/sample/infra/src/bus.ts#publish",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "aggregate-direct-bus-publish")
    expect(violation).toBeDefined()
    expect(violation?.rule).toBe("aggregate-direct-bus-publish")
    expect(violation?.path[0]).toBe("libs/sample/infra/src/aggregate.ts#handleCommand")
    expect(["libs/sample/infra/src/bus.ts#publish", "EventBus.publish"]).toContain(
      violation?.path[1],
    )
  })

  it("fails with aggregate-direct-bus-publish on transitive call chain from AggregateHttp.executeCommand via helper to Outbox.drain", () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/es/infra/src/http.ts#executeAggregateCommandAndSync",
          spanName: "AggregateHttp.executeCommand",
          file: "libs/es/infra/src/http.ts",
          line: 10,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/es/infra/src/http.ts#syncHelper",
          spanName: "Http.syncHelper",
          file: "libs/es/infra/src/http.ts",
          line: 25,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/es/infra/src/outbox.ts#drainAggregateOutbox",
          spanName: "Outbox.drain",
          file: "libs/es/infra/src/outbox.ts",
          line: 40,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [
        {
          callerQualname: "libs/es/infra/src/http.ts#executeAggregateCommandAndSync",
          calleeQualname: "libs/es/infra/src/http.ts#syncHelper",
          callCount: 1,
          receiverLayer: null,
        },
        {
          callerQualname: "libs/es/infra/src/http.ts#syncHelper",
          calleeQualname: "libs/es/infra/src/outbox.ts#drainAggregateOutbox",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      exercisesSpans: [],
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "aggregate-direct-bus-publish")
    expect(violation).toBeDefined()
    expect(violation?.rule).toBe("aggregate-direct-bus-publish")
    expect(violation?.path).toEqual([
      "libs/es/infra/src/http.ts#executeAggregateCommandAndSync",
      "libs/es/infra/src/http.ts#syncHelper",
      "Outbox.drain",
    ])
  })
})
