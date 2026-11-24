import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import * as Graph from "effect/Graph"
import { describe, expect, it } from "@effect/vitest"
import { match } from "ts-pattern"
import { testHostIo } from "./helpers/test-host-io.js"
import { buildHarnessGraph } from "../src/graph-engine.js"
import { checkEffectGraph, decideEffectGraphPolicy } from "../src/policy-check.js"
import {
  extractTypeAwareGraphFromSource,
  extractWorkspaceTypeAwareGraph,
} from "../src/type-extractor.js"

describe("effect-graph:check decider, state, and property matrix rules", () => {
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
          import { stub } from "@harness/contract"

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
      match<string>(edge.data.role)
        .with("fails-with", () => {
          failsWithErrors.add(edge.data.entityKey.replace(/^TaggedError:/, ""))
        })
        .with("requires-service", () => {
          requiredServices.add(edge.data.entityKey.replace(/^ServiceTag:/, ""))
        })
        .otherwise(() => {})
    }

    expect(failsWithErrors.has("CustomError")).toBe(true)
    expect(failsWithErrors.has("Err")).toBe(false)
    expect(requiredServices.has("SqlClient")).toBe(true)
    expect(requiredServices.has("ProjectionEnv")).toBe(false)

    for (const [, node] of Graph.nodes(graph.graph)) {
      match(node)
        .with({ _tag: "TaggedError" }, (n) => {
          expect(n.errorTag).not.toBe("Err")
        })
        .with({ _tag: "ServiceTag" }, (n) => {
          expect(n.tagId).not.toBe("ProjectionEnv")
        })
        .with(
          { _tag: "EffectFn" },
          { _tag: "ServiceLayer" },
          { _tag: "SchemaDef" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EarsRequirement" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          () => undefined,
        )
        .exhaustive()
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

        // F-8.2a: decideEffectGraphPolicy and checkEffectGraph return identical violations
        const f82aSyncResult = checkEffectGraph(graph, {
          includeLifecycleRules: spec.includeLifecycleRules,
          checkUnresolvedReferences: spec.checkUnresolvedReferences,
        })
        expect(f82aSyncResult.violations).toEqual(effectDecision.violations)
        expect(f82aSyncResult.ok).toBe(effectDecision.ok)
      }),
  )
})
