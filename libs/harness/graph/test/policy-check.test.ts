import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  checkEffectGraph,
  extractTypeAwareGraphFromSource
} from "../src/index.js"

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
          isStub: true
        }
      ],
      services: [
        {
          tagId: "Cloudflare.R2.BucketBinding",
          name: "BucketBinding",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts"
        }
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#badUseCase",
          tagId: "Cloudflare.R2.BucketBinding"
        }
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: []
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe("domain-requires-infra")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/domain/src/index.ts#badUseCase",
      "Cloudflare.R2.BucketBinding"
    ])
  })

  it("fails when ServiceLayers form a dependency cycle via Graph.findCycle", () => {
    const graph = buildHarnessGraph({
      fns: [],
      services: [
        { tagId: "SvcA", name: "SvcA", packageTag: "service", file: "a.ts" },
        { tagId: "SvcB", name: "SvcB", packageTag: "service", file: "b.ts" }
      ],
      layers: [
        { qualname: "LayerA", layerKind: "live", packageTag: "infra", file: "a.ts" },
        { qualname: "LayerB", layerKind: "live", packageTag: "infra", file: "b.ts" }
      ],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [
        { layerQualname: "LayerA", tagId: "SvcA" },
        { layerQualname: "LayerB", tagId: "SvcB" }
      ],
      layerRequires: [
        { layerQualname: "LayerA", tagId: "SvcB" },
        { layerQualname: "LayerB", tagId: "SvcA" }
      ],
      tracedCalls: [],
      exercisesSpans: []
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
          isStub: false
        }
      ],
      services: [
        {
          tagId: "Provider<Database>",
          name: "Provider<Database>",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts"
        }
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#orderUseCase",
          tagId: "Provider<Database>"
        }
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: []
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe("domain-requires-cloud-binding")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/domain/src/index.ts#orderUseCase",
      "Provider<Database>"
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
          isStub: false
        }
      ],
      services: [
        {
          tagId: "OrderRepository",
          name: "OrderRepository",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts"
        }
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#decide",
          tagId: "OrderRepository"
        }
      ],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: []
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const impureViolation = result.violations.find((v) => v.rule === "impure-decider")
    expect(impureViolation).toBeDefined()
    expect(impureViolation?.path).toEqual([
      "libs/sample/domain/src/index.ts#decide",
      "OrderRepository"
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
        packageTag: "domain"
      },
      {
        filePath: "libs/sample/infra/src/index.ts",
        content: infraSource,
        packageTag: "infra"
      }
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(
      result.violations.some(
        (v) => v.rule === "domain-requires-infra" || v.rule === "domain-requires-cloud-binding"
      )
    ).toBe(true)
  })

  it("end-to-end: passes on clean type-aware graph with valid architecture and returns mermaid", () => {
    const contractSource = `
import { Data } from "effect"

export class OrderNotFoundError extends Data.TaggedError("OrderNotFoundError")<{
  readonly orderId: string
}> {}
`
    const serviceSource = `
import { Context, Effect } from "effect"
import type { OrderNotFoundError } from "./contract.js"

export class OrderRepo extends Context.Service<OrderRepo, {
  readonly get: (id: string) => Effect.Effect<string, OrderNotFoundError>
}>()("OrderRepo") {}
`
    const domainSource = `
import { Effect } from "effect"
import { OrderRepo } from "./service.js"

export const getOrder = Effect.fn("Order.get")((id: string) =>
  Effect.gen(function* () {
    const repo = yield* OrderRepo
    return yield* repo.get(id)
  })
)

export const pureDecider = Effect.fn("Order.decide")((cmd: string) =>
  Effect.succeed(cmd)
)
`
    const infraSource = `
import { Layer, Effect } from "effect"
import { OrderRepo } from "./service.js"

export const OrderRepoLive: Layer.Layer<OrderRepo> = Layer.succeed(OrderRepo, {
  get: (id: string) => Effect.succeed(id)
})
`

    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract"
      },
      {
        filePath: "libs/sample/service/src/index.ts",
        content: serviceSource,
        packageTag: "service"
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain"
      },
      {
        filePath: "libs/sample/infra/src/index.ts",
        content: infraSource,
        packageTag: "infra"
      }
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
        packageTag: "domain"
      }
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "discriminant-branching")).toBe(true)
  })

  it("allows simple if-else when condition does not narrow a discriminated union", () => {
    const domainSource = `
import { Effect } from "effect"

export const checkCount = Effect.fn("Quota.checkCount")((count: number) =>
  Effect.sync(() => {
    if (count <= 0) {
      return 0
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "non-exhaustive-union-match")).toBe(true)
  })

  it("allows match(openPrimitive).otherwise() when matching on non-union open types like number or string", () => {
    const domainSource = `
import { Effect } from "effect"
import { match, P } from "ts-pattern"

export const classifyStatus = Effect.fn("Http.classifyStatus")((status: number) =>
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
        packageTag: "domain"
      }
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
          isStub: false
        }
      ],
      services: [
        {
          tagId: "OrderRepo",
          name: "OrderRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts"
        }
      ],
      requiresService: [
        {
          fnQualname: "libs/sample/contract/src/index.ts#contractDecider",
          tagId: "OrderRepo"
        }
      ]
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.rule).toBe("impure-decider")
    expect(result.violations[0]?.path).toEqual([
      "libs/sample/contract/src/index.ts#contractDecider",
      "OrderRepo"
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "contract"
      }
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
          isStub: false
        }
      ],
      services: [
        {
          tagId: "DatabasePort",
          name: "DatabasePort",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts"
        }
      ],
      layers: [],
      errors: [
        {
          errorTag: "CartError",
          file: "libs/sample/contract/src/index.ts"
        }
      ],
      tests: [],
      patternDocs: [],
      requiresService: [
        {
          fnQualname: "libs/sample/domain/src/index.ts#evolveCart",
          tagId: "DatabasePort"
        }
      ],
      failsWith: [
        {
          callerQualname: "libs/sample/domain/src/index.ts#evolveCart",
          errorTag: "CartError"
        }
      ],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: []
    })

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const reducerViolations = result.violations.filter((v) => v.rule === "impure-reducer")
    expect(reducerViolations).toHaveLength(2)
    expect(reducerViolations.some((v) => v.message.includes("pure and cannot require service"))).toBe(true)
    expect(reducerViolations.some((v) => v.message.includes("infallible and cannot fail"))).toBe(true)
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
        packageTag: "contract"
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "contract"
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain"
      }
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
        packageTag: "contract"
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const vacuousViolations = badResult.violations.filter((v) => v.rule === "vacuous-error-assertion")
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
        packageTag: "domain"
      }
    ])
    const goodResult = checkEffectGraph(goodGraph)
    const goodViolations = goodResult.violations.filter((v) => v.rule === "vacuous-error-assertion")
    expect(goodViolations).toHaveLength(0)
  })

  it("fails with unscoped-effect-run for Effect.runSync inside Decider.make or domain, while allowing Effect.runPromise in testing.ts outside Decider.make", () => {
    const domainSource = `
      import { Effect } from "effect"

      export const evolveCart = (s: any, e: any): any => {
        return Effect.runSync(Effect.succeed(s))
      }
    `
    const domainGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/cart.ts",
        content: domainSource,
        packageTag: "domain"
      }
    ])
    const domainResult = checkEffectGraph(domainGraph)
    expect(domainResult.violations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

    const deciderSource = `
      import { Effect } from "effect"

      export const cartDecider = Decider.make({
        initialState: {},
        decide: () => Effect.succeed([]),
        evolve: (s: any, e: any) => Effect.runSync(Effect.succeed(s))
      })
    `
    const deciderGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/es/core/src/decider.ts",
        content: deciderSource,
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])
    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("Exit.isSuccess")
  })
})

