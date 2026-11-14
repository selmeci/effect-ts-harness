import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import * as Graph from "effect/Graph"
import { describe, expect, it } from "@effect/vitest"
import {
  buildHarnessGraph,
  checkEffectGraph,
  decideEffectGraphPolicy,
  extractTypeAwareGraphFromSource,
  extractWorkspaceTypeAwareGraph,
  isAggregateFnNode,
  type EffectFnNode,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const makeTestFnNode = (partial: {
  readonly spanName: string
  readonly file?: string | undefined
  readonly qualname?: string | undefined
}): EffectFnNode => ({
  _tag: "EffectFn",
  qualname: partial.qualname ?? `test#${partial.spanName}`,
  spanName: partial.spanName,
  file: partial.file ?? "libs/sample/domain/src/index.ts",
  line: 1,
  packageTag: "infra",
  successType: "void",
  isStub: false,
})

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
import { stub } from "@harness/gates"

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

  it("fails with discriminant-branching when an if statement or ternary narrows a union via a custom literal property", () => {
    const domainSource = `
import { Effect } from "effect"

export type PlanState =
  | { readonly tier: "free"; readonly limit: number }
  | { readonly tier: "pro"; readonly limit: number }

export const checkQuota = Effect.fn("Quota.check")((plan: PlanState, count: number) =>
  Effect.sync(() => {
    if (plan.tier === "free") {
      return count < 5
    }
    return count < 100
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "discriminant-branching")).toBe(true)
  })

  it("allows simple if-else when condition does not narrow a discriminated union", () => {
    const domainSource = `
import { Effect, Schema } from "effect"

const QuotaCount = Schema.Int.pipe(Schema.brand("QuotaCount"))
type QuotaCount = typeof QuotaCount.Type

export const checkCount = Effect.fn("Quota.checkCount")((count: QuotaCount) =>
  Effect.sync(() => {
    if (count <= 0) {
      return QuotaCount.make(0)
    } else {
      return count
    }
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
  })

  it("allows comparing discriminant against dynamic or generic variable without flagging discriminant-branching", () => {
    const domainSource = `
import { Effect } from "effect"

export type PlanState =
  | { readonly tier: "free"; readonly limit: number }
  | { readonly tier: "pro"; readonly limit: number }

export const hasTier = Effect.fn("Quota.hasTier")((plan: PlanState, expectedTier: PlanState["tier"]) =>
  Effect.sync(() => {
    if (plan.tier === expectedTier) {
      return true
    }
    return false
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
    expect(result.violations.some((v) => v.rule === "discriminant-branching")).toBe(false)
  })

  it("fails with non-exhaustive-union-match when match(union) terminates with .otherwise() instead of .exhaustive()", () => {
    const domainSource = `
import { Effect } from "effect"
import { match } from "ts-pattern"

export type PaymentResult =
  | { readonly kind: "Paid"; readonly receiptId: string }
  | { readonly kind: "Declined"; readonly reason: string }

export const formatPayment = Effect.fn("Payment.format")((res: PaymentResult) =>
  Effect.sync(() =>
    match(res)
      .with({ kind: "Paid" }, (r) => r.receiptId)
      .otherwise(() => "unknown")
  )
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "non-exhaustive-union-match")).toBe(true)
  })

  it("allows match(openPrimitive).otherwise() when matching on non-union open types like number or string", () => {
    const domainSource = `
import { type Brand, Effect } from "effect"
import { match, P } from "ts-pattern"

type HttpStatus = number & Brand.Brand<"HttpStatus">

export const classifyStatus = Effect.fn("Http.classifyStatus")((status: HttpStatus) =>
  Effect.sync(() =>
    match(status)
      .with(200, () => "ok" as const)
      .with(P.number.between(400, 499), () => "client-error" as const)
      .otherwise(() => "other" as const)
  )
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
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

  it("fails with discriminant-branching when array predicate filters by _tag === 'Fail'", () => {
    const domainSource = `
import { Effect } from "effect"

export type CauseReason =
  | { readonly _tag: "Fail"; readonly error: string }
  | { readonly _tag: "Die"; readonly defect: unknown }

export const inspectReasons = Effect.fn("Cause.inspect")((reasons: Array<CauseReason>) =>
  Effect.sync(() => {
    const fails = reasons.filter((r) => r._tag === "Fail")
    return fails.length
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("r._tag")
    expect(violation?.message).toContain(".filter()")
  })

  it("fails with discriminant-branching when aliasing a union discriminant in a local variable", () => {
    const domainSource = `
import { Effect } from "effect"

export type AppError =
  | { readonly _tag: "NotFound"; readonly id: string }
  | { readonly _tag: "Unauthorized"; readonly reason: string }

export const matchError = Effect.fn("Error.match")((err: AppError, expectedTag: string) =>
  Effect.sync(() => {
    const actualTag = err._tag
    if (actualTag !== expectedTag) {
      return false
    }
    return true
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("actualTag")
  })

  it("fails with schema-boolean-state when Schema.Struct in contract uses checkedOut or created boolean flags", () => {
    const contractSource = `
import { Schema } from "effect"

export const Cart = Schema.Struct({
  id: Schema.String,
  checkedOut: Schema.Boolean
})

export const Order = Schema.Struct({
  id: Schema.String,
  created: Schema.optional(Schema.Boolean)
})
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const booleanViolations = result.violations.filter((v) => v.rule === "schema-boolean-state")
    expect(booleanViolations).toHaveLength(2)
    expect(booleanViolations.some((v) => v.message.includes("checkedOut"))).toBe(true)
    expect(booleanViolations.some((v) => v.message.includes("created"))).toBe(true)
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

  it("fails with dead-event-payload when Schema.TaggedStruct defines fields never read in evolve", () => {
    const contractSource = `
import { Schema } from "effect"

export const ReservationConfirmed = Schema.TaggedStruct("ReservationConfirmed", {
  reservationId: Schema.String,
  qty: Schema.Number
})
`
    const domainSource = `
import { match } from "ts-pattern"
import { ReservationConfirmed } from "@harness/sample-contract"

export type InventoryState = {
  readonly reservations: ReadonlyArray<string>
}

export type InventoryEvent = typeof ReservationConfirmed.Type

export const evolveInventory = (state: InventoryState, event: InventoryEvent): InventoryState =>
  match(event)
    .with({ _tag: "ReservationConfirmed" }, (ev) => ({
      reservations: state.reservations.concat(ev.reservationId)
    }))
    .exhaustive()
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const deadPayload = result.violations.find((v) => v.rule === "dead-event-payload")
    expect(deadPayload).toBeDefined()
    expect(deadPayload?.message).toContain("ReservationConfirmed")
    expect(deadPayload?.message).toContain("qty")
  })

  it("fails with terminal-state-unhandled when reducer matches only on event while state has terminal variant", () => {
    const domainSource = `
import { match } from "ts-pattern"

export type CartState =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Open"; readonly items: ReadonlyArray<string> }
  | { readonly _tag: "CheckedOut" }

export type CartEvent =
  | { readonly _tag: "ItemAdded"; readonly item: string }
  | { readonly _tag: "CartCheckedOut" }

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "ItemAdded" }, (ev) => ({
      _tag: "Open",
      items: [ev.item]
    }))
    .with({ _tag: "CartCheckedOut" }, () => ({
      _tag: "CheckedOut"
    }))
    .exhaustive()
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const terminalViolation = result.violations.find((v) => v.rule === "terminal-state-unhandled")
    expect(terminalViolation).toBeDefined()
    expect(terminalViolation?.message).toContain("evolveCart")
    expect(terminalViolation?.message).toContain("CheckedOut")
  })

  it("does not flag event schema property 'version' as dead-event-payload when omitted in evolve", () => {
    const contractSource = `
import { Schema } from "effect"

export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
  itemId: Schema.String,
  version: Schema.Number
})
`
    const domainSource = `
import { match } from "ts-pattern"
import { ItemAdded } from "@harness/sample-contract"

export type CartState = {
  readonly items: ReadonlyArray<string>
}

export type CartEvent = typeof ItemAdded.Type

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "ItemAdded" }, (ev) => ({
      items: state.items.concat(ev.itemId)
    }))
    .exhaustive()
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    const deadPayloadViolations = result.violations.filter((v) => v.rule === "dead-event-payload")
    expect(deadPayloadViolations).toHaveLength(0)
  })

  it("does not flag Schema.TaggedClass property 'version' as dead-event-payload when omitted in evolve", () => {
    const contractSource = `
import { Schema } from "effect"

export class ItemAdded extends Schema.TaggedClass<ItemAdded>()("ItemAdded", {
  itemId: Schema.String,
  version: Schema.Number
}) {}
`
    const domainSource = `
import { match } from "ts-pattern"
import { ItemAdded } from "@harness/sample-contract"

export type CartState = {
  readonly items: ReadonlyArray<string>
}

export type CartEvent = ItemAdded

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "ItemAdded" }, (ev) => ({
      items: state.items.concat(ev.itemId)
    }))
    .exhaustive()
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    const deadPayloadViolations = result.violations.filter((v) => v.rule === "dead-event-payload")
    expect(deadPayloadViolations).toHaveLength(0)
  })

  it("fails with fallback-json-equality when comparing values with JSON.stringify fallback", () => {
    const domainSource1 = `
      import { Equal } from "effect"

      export const checkEquality = (a: unknown, b: unknown): boolean => {
        return Equal.equals(a, b) || JSON.stringify(a) === JSON.stringify(b)
      }
    `
    const graph1 = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/compare1.ts",
        content: domainSource1,
        packageTag: "domain",
      },
    ])
    const result1 = checkEffectGraph(graph1)
    expect(result1.ok).toBe(false)
    const violations1 = result1.violations.filter((v) => v.rule === "fallback-json-equality")
    expect(violations1.length).toBeGreaterThan(0)
    expect(violations1[0]?.message).toContain("JSON.stringify equality fallback")

    const domainSource2 = `
      export const checkEqualityDirect = (a: unknown, b: unknown): boolean => {
        return JSON.stringify(a) === JSON.stringify(b)
      }
    `
    const graph2 = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/compare2.ts",
        content: domainSource2,
        packageTag: "domain",
      },
    ])
    const result2 = checkEffectGraph(graph2)
    expect(result2.ok).toBe(false)
    const violations2 = result2.violations.filter((v) => v.rule === "fallback-json-equality")
    expect(violations2.length).toBeGreaterThan(0)
    expect(violations2[0]?.message).toContain("JSON.stringify equality fallback")
  })

  it("fails with vacuous-error-assertion for thenFails(expected?: E) and thenFails() with 0 params, while allowing thenFails(expected: E)", () => {
    const badSource = `
      export interface TestHarness<E> {
        thenFails(expected?: E): void
      }

      export const runner = {
        thenFails: () => {
          // 0 params
        }
      }
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/bad-assert.ts",
        content: badSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const vacuousViolations = badResult.violations.filter(
      (v) => v.rule === "vacuous-error-assertion",
    )
    expect(vacuousViolations).toHaveLength(2)

    const goodSource = `
      export interface TestHarness<E> {
        thenFails(expected: E): void
      }

      export const runner = {
        thenFails: (expected: Error) => {
          // 1 explicit param
        }
      }
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/good-assert.ts",
        content: goodSource,
        packageTag: "domain",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    const goodViolations = goodResult.violations.filter((v) => v.rule === "vacuous-error-assertion")
    expect(goodViolations).toHaveLength(0)
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

  it("fails with discriminant-branching when if branches on tag guard Exit.isSuccess(exit) in domain/core files", () => {
    const domainSource = `
      import { Exit } from "effect"

      export const handleExit = (exit: Exit.Exit<number, string>): number => {
        if (Exit.isSuccess(exit)) {
          return exit.value
        }
        return 0
      }
    `
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/handler.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])
    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("Exit.isSuccess")
  })

  it("fails with unbranded-schema-field when Schema.Struct, TaggedStruct, or TaggedClass uses unbranded Int or Number for quantity or version", () => {
    const badContract = `
      import { Schema } from "effect"

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: Schema.String,
        quantity: Schema.Int,
        expectedVersion: Schema.Number
      })

      export class CartUpdated extends Schema.TaggedClass<CartUpdated>()("CartUpdated", {
        cartId: Schema.String,
        streamVersion: Schema.Natural
      })

      export const LegacyPayload = Schema.Struct({
        quantity: Schema.Int.pipe(Schema.positive())
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/events.ts",
        content: badContract,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "unbranded-schema-field")
    expect(violations.length).toBe(4)
    expect(violations[0]?.message).toContain(
      "domain quantity and version fields must use a branded contract schema",
    )

    const goodContract = `
      import { Schema } from "effect"

      export const PositiveInt = Schema.Int.pipe(Schema.brand("PositiveInt"))
      export const StreamVersion = Schema.Int.pipe(Schema.brand("StreamVersion"))

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: Schema.String,
        quantity: PositiveInt,
        expectedVersion: StreamVersion
      })

      export class CartUpdated extends Schema.TaggedClass<CartUpdated>()("CartUpdated", {
        cartId: Schema.String,
        streamVersion: Schema.Natural.pipe(Schema.brand("NaturalVersion")),
        quantity: Schema.Int.pipe(Schema.positive(), Schema.brand("Quantity"))
      })
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/events.ts",
        content: goodContract,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-schema-field")).toHaveLength(0)
  })

  it("fails with schema-boolean-state on Schema.TaggedStruct and Schema.TaggedClass", () => {
    const badSource = `
      import { Schema } from "effect"

      export const CartTagged = Schema.TaggedStruct("CartTagged", {
        cartId: Schema.String,
        checkedOut: Schema.Boolean
      })

      export class CartClass extends Schema.TaggedClass<CartClass>()("CartClass", {
        cartId: Schema.String,
        isActive: Schema.Boolean
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/cart.ts",
        content: badSource,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const boolViolations = badResult.violations.filter((v) => v.rule === "schema-boolean-state")
    expect(boolViolations.length).toBe(2)
  })

  it("fails with handwritten-tagged-union when type alias is an inline union of _tag object literals, but allows Schema-derived unions", () => {
    const badSource = `
      export type CartState =
        | { readonly _tag: "EmptyCart" }
        | { readonly _tag: "ActiveCart"; readonly cartId: string; readonly items: ReadonlyArray<string> }
        | { readonly _tag: "CheckedOutCart"; readonly cartId: string }
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/state.ts",
        content: badSource,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "handwritten-tagged-union")
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain("CartState")
    expect(violations[0]?.message).toContain(
      "handwritten TypeScript union of '_tag' object literals",
    )

    const goodSource = `
      import { Schema } from "effect"

      export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
      export const ActiveCart = Schema.TaggedStruct("ActiveCart", { cartId: Schema.String })
      export const CartState = Schema.Union(EmptyCart, ActiveCart)
      export type CartState = typeof CartState.Type

      export type Identifier = string | number
      export type ItemList = ReadonlyArray<{ readonly id: string; readonly name: string }>
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/state.ts",
        content: goodSource,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "handwritten-tagged-union")).toHaveLength(
      0,
    )
  })

  it("fails with untraced-decider when Decider.make binds an untraced decide function or returns options unchanged in decider.ts", () => {
    const untracedSource = `
      import { Effect } from "effect"

      export const cartDecider = Decider.make({
        initialState: {},
        decide: (command: unknown, state: unknown) => Effect.succeed([]),
        evolve: (state: unknown, event: unknown) => state
      })

      export const methodDecider = Decider.make({
        initialState: {},
        decide(command: unknown, state: unknown) {
          return Effect.succeed([])
        },
        evolve: (state: unknown, event: unknown) => state
      })

      const untracedFn = (command: unknown, state: unknown) => Effect.succeed([])
      export const aliasDecider = Decider.make({
        initialState: {},
        decide: untracedFn,
        evolve: (state: unknown, event: unknown) => state
      })
    `
    const untracedGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: untracedSource,
        packageTag: "domain",
      },
    ])
    const untracedResult = checkEffectGraph(untracedGraph)
    const violations = untracedResult.violations.filter((v) => v.rule === "untraced-decider")
    expect(violations.length).toBe(3)
    expect(violations[0]?.message).toContain("binds an untraced 'decide' function")

    const passthroughDecider = `
      export const Decider = {
        make: (options: unknown) => options
      }
    `
    const deciderGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/decider.ts",
        content: passthroughDecider,
        packageTag: "domain",
      },
    ])
    const deciderResult = checkEffectGraph(deciderGraph)
    const deciderViolations = deciderResult.violations.filter((v) => v.rule === "untraced-decider")
    expect(deciderViolations.length).toBe(1)
    expect(deciderViolations[0]?.message).toContain(
      "returns options unchanged without enforcing or wrapping span tracing",
    )

    const tracedSource = `
      import { Effect } from "effect"

      export const decide = Effect.fn("Cart.decide")(function* (command: unknown, state: unknown) {
        return []
      })

      export const validDecider = Decider.make({
        initialState: {},
        decide,
        evolve: (state: unknown, event: unknown) => state
      })

      export const inlineDecider = Decider.make({
        initialState: {},
        decide: Effect.fn("Cart.decide")(function* (command: unknown, state: unknown) {
          return []
        }),
        evolve: (state: unknown, event: unknown) => state
      })
    `
    const tracedGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: tracedSource,
        packageTag: "domain",
      },
    ])
    const tracedResult = checkEffectGraph(tracedGraph)
    expect(tracedResult.violations.filter((v) => v.rule === "untraced-decider")).toHaveLength(0)

    const wrappedDecider = `
      import { Effect } from "effect"

      export const Decider = {
        make: (options: Record<string, (...args: Array<unknown>) => unknown>) => ({
          ...options,
          decide: (command: unknown, state: unknown) => Effect.withSpan(options.decide(command, state), "decider.span")
        })
      }
    `
    const wrappedGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/decider.ts",
        content: wrappedDecider,
        packageTag: "domain",
      },
    ])
    const wrappedResult = checkEffectGraph(wrappedGraph)
    expect(wrappedResult.violations.filter((v) => v.rule === "untraced-decider")).toHaveLength(0)
  })

  it("fails with missing-aggregate-id-guard when decide does not verify that command and state aggregate ID match", () => {
    const unguardedSource = `
      import { Effect, Schema } from "effect"

      export const AddItem = Schema.TaggedStruct("AddItem", {
        cartId: Schema.String,
        item: Schema.String
      })
      export type AddItem = typeof AddItem.Type

      export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
        cartId: Schema.String,
        items: Schema.Array(Schema.String)
      })
      export type ActiveCart = typeof ActiveCart.Type

      export const decide = Effect.fn("Cart.decide")(function* (command: AddItem, state: ActiveCart) {
        // Does not compare command.cartId with state.cartId!
        return [command]
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: unguardedSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "missing-aggregate-id-guard")
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain(
      "accepts command and state that both carry aggregate identifier 'cartId'",
    )

    const unionAndMultiAggregateSource = `
      import { Effect, Schema } from "effect"

      export const AddItem = Schema.TaggedStruct("AddItem", {
        cartId: Schema.String,
        itemId: Schema.String
      })
      export const Checkout = Schema.TaggedStruct("Checkout", {
        cartId: Schema.String,
        orderId: Schema.String
      })
      export const CartCommand = Schema.Union([AddItem, Checkout])
      export type CartCommand = typeof CartCommand.Type

      export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
      export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
        cartId: Schema.String
      })
      export const CheckedOutCart = Schema.TaggedStruct("CheckedOutCart", {
        cartId: Schema.String,
        orderId: Schema.String
      })
      export const CartState = Schema.Union([EmptyCart, ActiveCart, CheckedOutCart])
      export type CartState = typeof CartState.Type

      // Unrelated Command and State schemas in the same file must NOT zero out the cartId intersection
      export const CancelOrderCommand = Schema.TaggedStruct("CancelOrderCommand", {
        orderId: Schema.String
      })
      export const CancelledOrderState = Schema.TaggedStruct("CancelledOrderState", {
        orderId: Schema.String
      })

      export const decideCart = Effect.fn("Cart.decide")(function* (
        command: CartCommand,
        state: CartState
      ) {
        return [command]
      })
    `
    const unionBadGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: unionAndMultiAggregateSource,
        packageTag: "domain",
      },
    ])
    const unionBadResult = checkEffectGraph(unionBadGraph)
    const unionViolations = unionBadResult.violations.filter(
      (v) => v.rule === "missing-aggregate-id-guard",
    )
    expect(unionViolations.length).toBe(1)
    expect(unionViolations[0]?.message).toContain(
      "accepts command and state that both carry aggregate identifier 'cartId'",
    )

    const guardedSource = `
      import { Effect, Equal, Schema } from "effect"

      export const AddItem = Schema.TaggedStruct("AddItem", {
        cartId: Schema.String,
        item: Schema.String
      })
      export type AddItem = typeof AddItem.Type

      export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
        cartId: Schema.String,
        items: Schema.Array(Schema.String)
      })
      export type ActiveCart = typeof ActiveCart.Type

      export const decideA = Effect.fn("Cart.decide")(function* (command: AddItem, state: ActiveCart) {
        if (state.cartId !== command.cartId) {
          return yield* Effect.fail(new Error("CartId mismatch"))
        }
        return [command]
      })

      export const decideB = Effect.fn("Cart.decide")(function* (cmd: AddItem, s: ActiveCart) {
        if (!Equal.equals(s.cartId, cmd.cartId)) {
          return yield* Effect.fail(new Error("CartId mismatch"))
        }
        return [cmd]
      })
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: guardedSource,
        packageTag: "domain",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(
      goodResult.violations.filter((v) => v.rule === "missing-aggregate-id-guard"),
    ).toHaveLength(0)
  })

  it("fails with unasserted-state-field when evolve assigns state properties never read or asserted in scope tests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-unasserted-test-"))
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")

      const srcDir = path.join(tmpDir, "libs/sample/domain/src")
      const testDir = path.join(tmpDir, "libs/sample/domain/test")
      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(testDir, { recursive: true })

      fs.writeFileSync(
        path.join(srcDir, "cart.ts"),
        `
          export const evolve = (state: Record<string, unknown>, event: Record<string, unknown>) => {
            return {
              ...state,
              _tag: "ActiveCart",
              cartId: event.cartId,
              items: [...(Array.isArray(state.items) ? state.items : []), event.item],
              totalItems: (typeof state.totalItems === "number" ? state.totalItems : 0) + 1
            }
          }
        `,
      )

      // Test file only reads items, never reads or asserts totalItems!
      fs.writeFileSync(
        path.join(testDir, "cart.test.ts"),
        `
          import { describe, it, expect } from "vitest"
          describe("cart suite", () => {
            it("handles items correctly (mentioning totalItems in title only)", () => {
              const state = { items: ["apple"] }
              expect(state.items).toHaveLength(1)
            })
          })
        `,
      )

      const badGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir, testHostIo))
      const badResult = checkEffectGraph(badGraph)
      const violations = badResult.violations.filter((v) => v.rule === "unasserted-state-field")
      expect(violations.length).toBe(1)
      expect(violations[0]?.message).toContain("State property 'totalItems' computed in reducer")
      expect(violations[0]?.message).toContain(
        "is never read or asserted in any test file in scope 'libs/sample'",
      )

      // Update test file to assert totalItems
      fs.writeFileSync(
        path.join(testDir, "cart.test.ts"),
        `
          import { describe, it, expect } from "vitest"
          describe("cart suite", () => {
            it("handles items and totalItems", () => {
              const state = { items: ["apple"], totalItems: 1 }
              expect(state.items).toHaveLength(1)
              expect(state.totalItems).toBe(1)
            })
          })
        `,
      )

      const goodGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir, testHostIo))
      const goodResult = checkEffectGraph(goodGraph)
      expect(goodResult.violations.filter((v) => v.rule === "unasserted-state-field")).toHaveLength(
        0,
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("fails with unsafe-type-cast on 'as any', ': any', 'as never', 'as unknown as', and '(x: never) => x', while allowing Effect.Effect<number, never, never>", () => {
    // 1. as any
    const asAnySource = `
      export const value = ("test" as any)
    `
    const asAnyGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/as-any.ts",
        content: asAnySource,
        packageTag: "domain",
      },
    ])
    const asAnyResult = checkEffectGraph(asAnyGraph)
    expect(asAnyResult.ok).toBe(false)
    expect(asAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(asAnyResult.violations[0]?.message).toContain(
      "Explicit 'any' (as any, : any, <any>) is banned",
    )
    expect(asAnyResult.violations[0]?.path).toEqual(["libs/sample/domain/src/as-any.ts"])

    // 2. : any
    const colonAnySource = `
      export const badVar: any = 42
    `
    const colonAnyGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/colon-any.ts",
        content: colonAnySource,
        packageTag: "domain",
      },
    ])
    const colonAnyResult = checkEffectGraph(colonAnyGraph)
    expect(colonAnyResult.ok).toBe(false)
    expect(colonAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(colonAnyResult.violations[0]?.message).toContain(
      "Explicit 'any' (as any, : any, <any>) is banned",
    )

    // 3. as never
    const asNeverSource = `
      export const castNever = (val: unknown) => val as never
    `
    const asNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/as-never.ts",
        content: asNeverSource,
        packageTag: "domain",
      },
    ])
    const asNeverResult = checkEffectGraph(asNeverGraph)
    expect(asNeverResult.ok).toBe(false)
    expect(asNeverResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(asNeverResult.violations[0]?.message).toContain("Unsafe 'as never' cast is banned")

    // 4. as unknown as (double type assertion)
    const doubleCastSource = `
      export const doubleCast = (val: string) => val as unknown as number
    `
    const doubleCastGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/double-cast.ts",
        content: doubleCastSource,
        packageTag: "domain",
      },
    ])
    const doubleCastResult = checkEffectGraph(doubleCastGraph)
    expect(doubleCastResult.ok).toBe(false)
    expect(doubleCastResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(doubleCastResult.violations[0]?.message).toContain(
      "Double type assertion ('as unknown as T') is banned",
    )

    // 5. (x: never) => x parameter
    const neverParamSource = `
      export const neverParam = (x: never) => x
    `
    const neverParamGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/never-param.ts",
        content: neverParamSource,
        packageTag: "domain",
      },
    ])
    const neverParamResult = checkEffectGraph(neverParamGraph)
    expect(neverParamResult.ok).toBe(false)
    expect(neverParamResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(neverParamResult.violations[0]?.message).toContain(
      "Explicit ': never' annotation on parameter or variable is banned",
    )

    // 6. Allowing Effect.Effect<number, never, never>
    const safeNeverSource = `
      import { Effect } from "effect"
      export const safeEffect: Effect.Effect<number, never, never> = Effect.succeed(100)
    `
    const safeNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/safe-never.ts",
        content: safeNeverSource,
        packageTag: "domain",
      },
    ])
    const safeNeverResult = checkEffectGraph(safeNeverGraph)
    expect(safeNeverResult.violations.filter((v) => v.rule === "unsafe-type-cast")).toHaveLength(0)
  })

  it("fails with unbranded-contract-schema when contract/domain schemas, piped structs, unions, inline object type aliases, or any/unknown lack ~effect/Brand, and passes when branded", () => {
    const badContractSource = `
      import { Schema } from "effect"

      export type RawAlbumId = string
      export type ErasedId = any
      export type UnknownId = unknown
      export type InlineDto = { readonly id: string }
      export const PhotoId = Schema.Int

      const LocalUnbrandedId = Schema.Int
      export const PipedPhoto = Schema.Struct({
        id: LocalUnbrandedId,
        albumId: Schema.String
      }).pipe(Schema.brand("PipedPhoto"))

      export const EventUnion = Schema.TaggedUnion({
        Created: { itemId: Schema.String },
        Deleted: { itemId: Schema.String }
      })

      export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
        "PhotoNotFoundError",
        { id: Schema.Int }
      ) {}

      export const BrandA = Schema.Int.pipe(Schema.brand("DuplicateBrand"))
      export const BrandB = Schema.NumberFromString.pipe(Schema.brand("DuplicateBrand"))
    `
    const badDomainSchemaSource = `
      import { Schema } from "effect"

      export const InternalStruct = Schema.Struct({
        rawCount: Schema.Int
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: badContractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: badDomainSchemaSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const contractViolations = badResult.violations.filter(
      (v) => v.rule === "unbranded-contract-schema",
    )
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Exported type alias 'RawAlbumId'") && v.message.includes("'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) => v.message.includes("Exported type alias 'ErasedId'") && v.message.includes("'any'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Exported type alias 'UnknownId'") && v.message.includes("'unknown'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) => v.message.includes("Exported type alias 'InlineDto'")),
    ).toBe(true)
    expect(contractViolations.some((v) => v.message.includes("Contract schema 'PhotoId'"))).toBe(
      true,
    )
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'id' of contract schema 'PipedPhoto'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'albumId' of contract schema 'PipedPhoto'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'itemId' of contract schema 'EventUnion'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) => v.message.includes("Field 'id' of 'PhotoNotFoundError'")),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'rawCount' of contract schema 'InternalStruct'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Duplicate Schema.brand('DuplicateBrand')"),
      ),
    ).toBe(true)

    const goodContractSource = `
      import { Schema } from "effect"

      export const PhotoId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PhotoId"))
      export type PhotoId = typeof PhotoId.Type

      export const PhotoIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(PhotoId))
      export type PhotoIdFromString = typeof PhotoIdFromString.Type

      export const AlbumId = Schema.String.pipe(Schema.brand("AlbumId"))
      export type AlbumId = typeof AlbumId.Type

      export const Photo = Schema.Struct({
        id: PhotoId,
        albumId: AlbumId
      })
      export type Photo = typeof Photo.Type

      export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
        "PhotoNotFoundError",
        { id: PhotoId }
      ) {}
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: goodContractSource,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-contract-schema")).toEqual([])
  })

  it("fails with unbranded-primitive-boundary on raw primitive or inline object service/domain boundaries and 'as Brand' casts, and passes on compliant branded boundaries", () => {
    const badServiceSource = `
      import { type Brand, Context, type Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export class PhotoRepo extends Context.Service<PhotoRepo, {
        readonly findById: (id: number) => Effect.Effect<string>
        readonly createInline: (input: { readonly id: PhotoId }) => Effect.Effect<{ readonly ok: PhotoId }>
      }>()("PhotoRepo") {}
    `
    const badDomainSource = `
      import { type Brand, Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export const getPhoto = Effect.fn("Photo.get")(function* (
        rawId: number,
        inlineFilter: { readonly id: PhotoId }
      ) {
        const castId = rawId as PhotoId
        return yield* Effect.succeed(String(castId) + String(inlineFilter.id))
      })

      export const plainDecider = (input: { readonly current: PhotoId }): number =>
        input.current + 1
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        content: badServiceSource,
        packageTag: "service",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: badDomainSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const boundaryViolations = badResult.violations.filter(
      (v) => v.rule === "unbranded-primitive-boundary",
    )
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Service capability 'PhotoRepo.findById' parameter 'id'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Service capability 'PhotoRepo.findById' return type"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Service capability 'PhotoRepo.createInline' parameter 'input'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Service capability 'PhotoRepo.createInline' return type") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Domain function 'getPhoto' parameter 'rawId'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'getPhoto' parameter 'inlineFilter'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Domain function 'getPhoto' return success type"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'plainDecider' parameter 'input'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'plainDecider' return success type") &&
          v.message.includes("'number'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("casts an unbranded value directly to branded type"),
      ),
    ).toBe(true)

    const goodServiceSource = `
      import { type Brand, Context, type Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export class PhotoRepo extends Context.Service<PhotoRepo, {
        readonly findById: (id: PhotoId) => Effect.Effect<PhotoId>
      }>()("PhotoRepo") {}
    `
    const goodDomainSource = `
      import { type Brand, Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export const getPhoto = Effect.fn("Photo.get")(function* (id: PhotoId) {
        return yield* Effect.succeed(id)
      })
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        content: goodServiceSource,
        packageTag: "service",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: goodDomainSource,
        packageTag: "domain",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-primitive-boundary")).toEqual(
      [],
    )
  })

  it("hardens missing-aggregate-id-guard, dead-event-payload, terminal-state-unhandled, and unsafe-type-cast against adversarial evasions", () => {
    const evasionSource = `
      import { Effect, Schema } from "effect"
      import { match } from "ts-pattern"

      const CartId = Schema.NonEmptyString.pipe(Schema.brand("CartId"))
      const ItemCount = Schema.Natural.pipe(Schema.brand("ItemCount"))

      export const AddItem = Schema.TaggedStruct("AddItem", {
        cartId: CartId,
        quantity: ItemCount
      })
      export const CartCommand = Schema.Union([AddItem])
      export type CartCommand = typeof CartCommand.Type

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: CartId,
        quantity: ItemCount
      })
      export const CartEvent = Schema.Union([ItemAdded])
      export type CartEvent = typeof CartEvent.Type

      // EmptyCart has a non-_tag property (itemCount) without cartId, while ActiveCart has cartId
      export const EmptyCart = Schema.TaggedStruct("EmptyCart", {
        itemCount: ItemCount
      })
      export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
        cartId: CartId,
        itemCount: ItemCount
      })
      export const CheckedOut = Schema.TaggedStruct("CheckedOut", {
        cartId: CartId,
        itemCount: ItemCount
      })
      export const CartState = Schema.Union([EmptyCart, ActiveCart, CheckedOut])
      export type CartState = typeof CartState.Type

      export const decideEvasion = Effect.fn("Cart.decide")(function* (
        command: CartCommand,
        state: CartState
      ) {
        // Evasion 1: comment pretending to compare IDs: state.cartId === command.cartId
        // Evasion 2: self-comparison:
        if (command.cartId === command.cartId) {
          return yield* Effect.succeed([])
        }
        return yield* Effect.succeed([])
      })

      export const evolveWithUnusedKeyCollision = (state: CartState, event: CartEvent): CartState =>
        match(state)
          .with({ _tag: "CheckedOut" }, (s) => s)
          .with({ _tag: "EmptyCart" }, { _tag: "ActiveCart" }, () =>
            match(event)
              // Evasion 3: object literal key 'quantity' without reading event.quantity
              .with({ _tag: "ItemAdded" }, () => ({
                _tag: "ActiveCart" as const,
                cartId: event.cartId,
                itemCount: ItemCount.make(0),
                quantity: 0
              }))
              .exhaustive()
          )
          .exhaustive()

      export const doubleSatisfiesCast = (x: unknown): string =>
        (x as unknown satisfies unknown) as string

      export const parenNeverCast = (x: string) => x as (never)
    `
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/test/fixtures/evasion.ts",
        content: evasionSource,
        packageTag: "domain",
      },
    ])
    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    // 1. Self-comparison + comment + EmptyCart with non-_tag field must still trigger missing-aggregate-id-guard
    expect(result.violations.some((v) => v.rule === "missing-aggregate-id-guard")).toBe(true)
    // 2. Object literal key 'quantity: 0' must NOT mask unused event.quantity
    expect(
      result.violations.some(
        (v) => v.rule === "dead-event-payload" && v.message.includes("property 'quantity'"),
      ),
    ).toBe(true)
    // 3. Inner match(event) inside outer match(state) must NOT trigger terminal-state-unhandled false positive
    expect(result.violations.some((v) => v.rule === "terminal-state-unhandled")).toBe(false)
    // 4. Satisfies double cast and parenthesized never cast must trigger unsafe-type-cast
    const castViolations = result.violations.filter((v) => v.rule === "unsafe-type-cast")
    expect(castViolations.length).toBeGreaterThanOrEqual(2)
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

  it("verifies dead-event-payload when multiple schema versions share the same _tag", () => {
    const contractSource = `
import { Schema } from "effect"

const CartId = Schema.String.pipe(Schema.brand("CartId"))
const OrderId = Schema.String.pipe(Schema.brand("OrderId"))
const Channel = Schema.String.pipe(Schema.brand("Channel"))

export const CartCheckedOut = Schema.TaggedStruct("CartCheckedOut", {
  cartId: CartId,
  orderId: OrderId,
  version: Schema.Literal(1)
})
export const CartEvent = Schema.Union([CartCheckedOut])
export type CartEvent = typeof CartEvent.Type

export const CartCheckedOutV2 = Schema.TaggedStruct("CartCheckedOut", {
  cartId: CartId,
  orderId: OrderId,
  channel: Channel,
  version: Schema.Literal(2)
})
export const CartEventV2 = Schema.Union([CartCheckedOutV2])
export type CartEventV2 = typeof CartEventV2.Type
`

    const domainSource = `
import { match } from "ts-pattern"
import { CartEvent, CartEventV2 } from "@harness/sample-contract"

export type CartState = {
  readonly items: ReadonlyArray<string>
}

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "CartCheckedOut" }, (ev) => ({
      items: state.items.concat(ev.cartId, ev.orderId)
    }))
    .exhaustive()

export const evolveCartV2 = (state: CartState, event: CartEventV2): CartState =>
  match(event)
    .with({ _tag: "CartCheckedOut" }, (ev) => ({
      items: state.items.concat(ev.cartId, ev.orderId)
    }))
    .exhaustive()
`

    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    const deadViolations = result.violations.filter((v) => v.rule === "dead-event-payload")

    // evolveCart (v1) should NOT be flagged for channel
    const v1ChannelViolation = deadViolations.find(
      (v) =>
        v.path.some((p) => p.endsWith("#evolveCart") || p === "evolveCart") &&
        v.message.includes("channel"),
    )
    expect(v1ChannelViolation).toBeUndefined()

    // evolveCartV2 (v2) IS flagged for channel
    const v2ChannelViolation = deadViolations.find(
      (v) =>
        v.path.some((p) => p.endsWith("#evolveCartV2") || p === "evolveCartV2") &&
        v.message.includes("channel"),
    )
    expect(v2ChannelViolation).toBeDefined()
    expect(v2ChannelViolation?.message).toContain("CartCheckedOut")
    expect(v2ChannelViolation?.message).toContain("channel")
  })

  it("does not emit type parameters from generic Effect.fn using stub as fake errors or services", () => {
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/generic.ts",
        packageTag: "domain",
        content: `
          import { Context, Data, Effect } from "effect"
          import { stub } from "@harness/gates"

          export class CustomError extends Data.TaggedError("CustomError")<{ readonly message: string }> {}
          export class SqlClient extends Context.Service<SqlClient, {}>()("SqlClient") {}

          export const runGeneric = Effect.fn("Generic.run")(function* <Err, ProjectionEnv>() {
            return yield* stub<void, Err | CustomError, SqlClient | ProjectionEnv>()
          })
        `,
      },
    ])

    const failsWithErrors = new Set<string>()
    const requiredServices = new Set<string>()
    for (const [, edge] of Graph.edges(graph.graph)) {
      if (edge.data.role === "fails-with") {
        failsWithErrors.add(edge.data.entityKey.replace(/^TaggedError:/, ""))
      } else if (edge.data.role === "requires-service") {
        requiredServices.add(edge.data.entityKey.replace(/^ServiceTag:/, ""))
      }
    }

    expect(failsWithErrors.has("CustomError")).toBe(true)
    expect(failsWithErrors.has("Err")).toBe(false)
    expect(requiredServices.has("SqlClient")).toBe(true)
    expect(requiredServices.has("ProjectionEnv")).toBe(false)

    for (const [, node] of Graph.nodes(graph.graph)) {
      if (node._tag === "TaggedError") {
        expect(node.errorTag).not.toBe("Err")
      }
      if (node._tag === "ServiceTag") {
        expect(node.tagId).not.toBe("ProjectionEnv")
      }
    }
  })

  const PolicyCheckArbitrarySpec = Schema.Struct({
    hasDomainInfraViolation: Schema.Boolean,
    hasDeciderViolation: Schema.Boolean,
    hasUnresolvedRef: Schema.Boolean,
    hasUntestedDomainSpan: Schema.Boolean,
    includeLifecycleRules: Schema.Boolean,
    checkUnresolvedReferences: Schema.Boolean,
  })

  it.effect.prop(
    "decideEffectGraphPolicy and checkEffectGraph satisfy policy contracts and equivalence across arbitrary inputs",
    [PolicyCheckArbitrarySpec],
    ([spec]) =>
      Effect.gen(function* () {
        const fns = [
          {
            qualname: "libs/sample/domain/src/order.ts#checkout",
            spanName: "Order.checkout",
            file: "libs/sample/domain/src/order.ts",
            line: 1,
            packageTag: "domain" as const,
            successType: "void",
            isStub: false,
          },
          ...(spec.hasDeciderViolation
            ? [
                {
                  qualname: "libs/sample/domain/src/order.ts#decide",
                  spanName: "Order.decide",
                  file: "libs/sample/domain/src/order.ts",
                  line: 20,
                  packageTag: "domain" as const,
                  successType: "void",
                  isStub: false,
                },
              ]
            : []),
          ...(spec.hasUntestedDomainSpan
            ? [
                {
                  qualname: "libs/sample/domain/src/order.ts#untested",
                  spanName: "Order.untested",
                  file: "libs/sample/domain/src/order.ts",
                  line: 40,
                  packageTag: "domain" as const,
                  successType: "void",
                  isStub: false,
                },
              ]
            : []),
        ]

        const services = [
          ...(spec.hasDomainInfraViolation
            ? [
                {
                  tagId: "PhotoRepoLive",
                  name: "PhotoRepoLive",
                  packageTag: "infra" as const,
                  file: "libs/sample/infra/src/photo-repo.ts",
                },
              ]
            : []),
          ...(spec.hasDeciderViolation
            ? [
                {
                  tagId: "OrderRepo",
                  name: "OrderRepo",
                  packageTag: "service" as const,
                  file: "libs/sample/service/src/order-repo.ts",
                },
              ]
            : []),
        ]

        const requiresService = [
          ...(spec.hasDomainInfraViolation
            ? [
                {
                  callerQualname: "libs/sample/domain/src/order.ts#checkout",
                  tagId: "PhotoRepoLive",
                },
              ]
            : []),
          ...(spec.hasDeciderViolation
            ? [
                {
                  callerQualname: "libs/sample/domain/src/order.ts#decide",
                  tagId: "OrderRepo",
                },
              ]
            : []),
          ...(spec.hasUnresolvedRef
            ? [
                {
                  callerQualname: "libs/sample/domain/src/order.ts#checkout",
                  tagId: "NonexistentRequiredService",
                },
              ]
            : []),
        ]

        const tests = [
          {
            testId: "libs/sample/domain/test/order.test.ts#checks out",
            testFile: "libs/sample/domain/test/order.test.ts",
            testName: "checks out",
          },
        ]

        const exercisesSpans = [
          {
            testId: "libs/sample/domain/test/order.test.ts#checks out",
            calleeQualname: "libs/sample/domain/src/order.ts#checkout",
            callCount: 1,
            receiverLayer: null,
          },
          ...(spec.hasDeciderViolation
            ? [
                {
                  testId: "libs/sample/domain/test/order.test.ts#checks out",
                  calleeQualname: "libs/sample/domain/src/order.ts#decide",
                  callCount: 1,
                  receiverLayer: null,
                },
              ]
            : []),
        ]

        const graph = buildHarnessGraph({
          fns,
          services,
          requiresService,
          tests,
          exercisesSpans,
        })

        const options = {
          includeLifecycleRules: spec.includeLifecycleRules,
          checkUnresolvedReferences: spec.checkUnresolvedReferences,
        }

        const effectDecision = yield* decideEffectGraphPolicy(graph, options)
        const syncResult = checkEffectGraph(graph, options)

        // Equivalence between pure Effect decider and synchronous wrapper
        expect(syncResult.ok).toBe(effectDecision.ok)
        expect(syncResult.violations).toEqual(effectDecision.violations)
        expect(syncResult.mermaid).toBe(effectDecision.mermaid)

        // Invariant: ok is true iff violations is empty
        expect(effectDecision.ok).toBe(effectDecision.violations.length === 0)

        // Invariant: mermaid is a valid non-empty flowchart
        expect(effectDecision.mermaid.length).toBeGreaterThan(0)
        expect(effectDecision.mermaid).toContain("flowchart")

        // Domain requires infra gating
        const hasDomainInfra = effectDecision.violations.some(
          (v) => v.rule === "domain-requires-infra",
        )
        expect(hasDomainInfra).toBe(spec.hasDomainInfraViolation)

        // Impure decider gating
        const hasImpureDecider = effectDecision.violations.some((v) => v.rule === "impure-decider")
        expect(hasImpureDecider).toBe(spec.hasDeciderViolation)

        // Unresolved references gating
        const hasUnresolved = effectDecision.violations.some(
          (v) => v.rule === "unresolved-graph-reference",
        )
        expect(hasUnresolved).toBe(spec.hasUnresolvedRef && spec.checkUnresolvedReferences)

        // Lifecycle rules gating (untested domain span)
        const hasUntested = effectDecision.violations.some((v) => v.rule === "untested-domain-span")
        expect(hasUntested).toBe(spec.hasUntestedDomainSpan && spec.includeLifecycleRules)
      }),
  )
})
