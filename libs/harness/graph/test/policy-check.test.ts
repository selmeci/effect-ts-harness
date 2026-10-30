import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildHarnessGraph,
  checkEffectGraph,
  extractTypeAwareGraphFromSource,
  extractWorkspaceTypeAwareGraph
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

      export const evolveCart = (s: unknown, e: unknown): unknown => {
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
        evolve: (s: unknown, e: unknown) => Effect.runSync(Effect.succeed(s))
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
        packageTag: "contract"
      }
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "unbranded-schema-field")
    expect(violations.length).toBe(4)
    expect(violations[0]?.message).toContain("domain quantity and version fields must use a branded contract schema")

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
        packageTag: "contract"
      }
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
        packageTag: "contract"
      }
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
        packageTag: "contract"
      }
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "handwritten-tagged-union")
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain("CartState")
    expect(violations[0]?.message).toContain("handwritten TypeScript union of '_tag' object literals")

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
        packageTag: "contract"
      }
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "handwritten-tagged-union")).toHaveLength(0)
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])
    const deciderResult = checkEffectGraph(deciderGraph)
    const deciderViolations = deciderResult.violations.filter((v) => v.rule === "untraced-decider")
    expect(deciderViolations.length).toBe(1)
    expect(deciderViolations[0]?.message).toContain("returns options unchanged without enforcing or wrapping span tracing")

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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "missing-aggregate-id-guard")
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain("accepts command and state that both carry aggregate identifier 'cartId'")

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
        packageTag: "domain"
      }
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "missing-aggregate-id-guard")).toHaveLength(0)
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
        `
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
        `
      )

      const badGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir))
      const badResult = checkEffectGraph(badGraph)
      const violations = badResult.violations.filter((v) => v.rule === "unasserted-state-field")
      expect(violations.length).toBe(1)
      expect(violations[0]?.message).toContain("State property 'totalItems' computed in reducer")
      expect(violations[0]?.message).toContain("is never read or asserted in any test file in scope 'libs/sample'")

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
        `
      )

      const goodGraph = Effect.runSync(extractWorkspaceTypeAwareGraph(tmpDir))
      const goodResult = checkEffectGraph(goodGraph)
      expect(goodResult.violations.filter((v) => v.rule === "unasserted-state-field")).toHaveLength(0)
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
        packageTag: "domain"
      }
    ])
    const asAnyResult = checkEffectGraph(asAnyGraph)
    expect(asAnyResult.ok).toBe(false)
    expect(asAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(asAnyResult.violations[0]?.message).toContain("Explicit 'any' (as any, : any, <any>) is banned")
    expect(asAnyResult.violations[0]?.path).toEqual(["libs/sample/domain/src/as-any.ts"])

    // 2. : any
    const colonAnySource = `
      export const badVar: any = 42
    `
    const colonAnyGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/colon-any.ts",
        content: colonAnySource,
        packageTag: "domain"
      }
    ])
    const colonAnyResult = checkEffectGraph(colonAnyGraph)
    expect(colonAnyResult.ok).toBe(false)
    expect(colonAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(colonAnyResult.violations[0]?.message).toContain("Explicit 'any' (as any, : any, <any>) is banned")

    // 3. as never
    const asNeverSource = `
      export const castNever = (val: unknown) => val as never
    `
    const asNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/as-never.ts",
        content: asNeverSource,
        packageTag: "domain"
      }
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
        packageTag: "domain"
      }
    ])
    const doubleCastResult = checkEffectGraph(doubleCastGraph)
    expect(doubleCastResult.ok).toBe(false)
    expect(doubleCastResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(doubleCastResult.violations[0]?.message).toContain("Double type assertion ('as unknown as T') is banned")

    // 5. (x: never) => x parameter
    const neverParamSource = `
      export const neverParam = (x: never) => x
    `
    const neverParamGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/never-param.ts",
        content: neverParamSource,
        packageTag: "domain"
      }
    ])
    const neverParamResult = checkEffectGraph(neverParamGraph)
    expect(neverParamResult.ok).toBe(false)
    expect(neverParamResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(neverParamResult.violations[0]?.message).toContain("Explicit ': never' annotation on parameter or variable is banned")

    // 6. Allowing Effect.Effect<number, never, never>
    const safeNeverSource = `
      import { Effect } from "effect"
      export const safeEffect: Effect.Effect<number, never, never> = Effect.succeed(100)
    `
    const safeNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/safe-never.ts",
        content: safeNeverSource,
        packageTag: "domain"
      }
    ])
    const safeNeverResult = checkEffectGraph(safeNeverGraph)
    expect(safeNeverResult.violations.filter((v) => v.rule === "unsafe-type-cast")).toHaveLength(0)
  })
})


