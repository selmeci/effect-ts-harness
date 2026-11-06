import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import {
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventUpcasterLink,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
  JsonSchemaText,
  MissingEventUpcasterError,
  PositiveInt,
} from "@harness/es-contract"
import { match } from "ts-pattern"
import {
  decideEventSchemaEvolution,
  prepareUpdatedEventSnapshots,
  toEventVersionSnapshot,
  verifyCommittedSnapshotParity,
  verifyEventSchemaEvolution,
} from "../src/evolution.js"
import { makeDeciderTestHarness } from "../src/testing.js"

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b))
    const sortedObj: Record<string, unknown> = {}
    for (const [key, val] of entries) {
      Object.defineProperty(sortedObj, key, {
        value: canonicalizeJsonValue(val),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return sortedObj
  }
  return value
}
import {
  AddItem,
  CartAlreadyCheckedOutError,
  CartCheckedOut,
  CartCheckedOutV2,
  cartCheckedOutV1ToV2,
  CartCreated,
  cartDeciderV2,
  CartEventV2Codec,
  CartId,
  CartIdMismatchError,
  cartRegisteredUpcasters,
  CheckoutChannel,
  CheckoutV2,
  computeCartEventSnapshots,
  DEFAULT_CHECKOUT_CHANNEL,
  EmptyCartCheckoutError,
  initialCartStateV2,
  ItemAdded,
  ItemId,
  OrderId,
} from "./fixtures/cart.js"

describe("EventSchemaEvolution & Upcasting", () => {
  describe("compareCodeUnits & canonicalizeJsonValue", () => {
    it("orders UTF-16 code units independently of locale", () => {
      expect(compareCodeUnits("B", "a")).toBe(-1)
      expect(compareCodeUnits("a", "B")).toBe(1)
      expect(compareCodeUnits("a", "a")).toBe(0)
    })

    it("canonicalizeJsonValue orders object keys in deterministic UTF-16 code-unit order", () => {
      const res = canonicalizeJsonValue({ a: 1, B: 2, _tag: "X" })
      if (typeof res === "object" && res !== null) {
        expect(Object.keys(res)).toEqual(["B", "_tag", "a"])
      } else {
        expect.unreachable("expected object from canonicalizeJsonValue")
      }
    })

    it("canonicalizeJsonValue preserves __proto__ as an own enumerable data property without polluting Object.prototype", () => {
      const input: unknown = JSON.parse('{"z":1,"__proto__":{"a":2}}')
      const res = canonicalizeJsonValue(input)
      if (typeof res === "object" && res !== null) {
        expect(Object.prototype.hasOwnProperty.call(res, "__proto__")).toBe(true)
      } else {
        expect.unreachable("expected object from canonicalizeJsonValue")
      }
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, "a")).toBe(false)
      const emptyObj: Record<string, unknown> = {}
      expect(emptyObj["a"]).toBeUndefined()
    })
  })

  describe("toEventVersionSnapshot", () => {
    it.effect("fails with typed FrozenEventSchemaViolationError on unsupported schema", () =>
      Effect.gen(function* () {
        const UnsupportedEventSchema = Schema.Struct({
          [Symbol.for("unsupported")]: Schema.String,
        })
        const exit = yield* Effect.exit(
          toEventVersionSnapshot(
            EventType.make("UnsupportedEvent"),
            EventSchemaVersion.make(1),
            UnsupportedEventSchema,
          ),
        )
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            expect(Cause.hasDies(f.cause)).toBe(false)
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value instanceof FrozenEventSchemaViolationError).toBe(true)
                match(value)
                  .with({ _tag: "FrozenEventSchemaViolationError" }, (v) => {
                    expect(v.eventType).toBe("UnsupportedEvent")
                    expect(v.version).toBe(1)
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("produces deterministic JSON Schema snapshots across repeated calls", () =>
      Effect.gen(function* () {
        const snap1 = yield* toEventVersionSnapshot(
          EventType.make("CartCreated"),
          EventSchemaVersion.make(1),
          CartCreated,
        )
        const snap2 = yield* toEventVersionSnapshot(
          EventType.make("CartCreated"),
          EventSchemaVersion.make(1),
          CartCreated,
        )

        expect(snap1.jsonSchema).toBe(snap2.jsonSchema)
        expect(snap1.eventType).toBe("CartCreated")
        expect(snap1.version).toBe(1)
      }),
    )

    it.effect("canonicalizes nested schema structures deterministically", () =>
      Effect.gen(function* () {
        const NestedSchema = Schema.Struct({
          b: Schema.Struct({ y: Schema.String, x: Schema.Int, z: Schema.Null }),
          a: Schema.Array(Schema.Struct({ d: Schema.Boolean, c: Schema.String })),
        })
        const snap1 = yield* toEventVersionSnapshot(
          EventType.make("NestedEvent"),
          EventSchemaVersion.make(1),
          NestedSchema,
        )
        const snap2 = yield* toEventVersionSnapshot(
          EventType.make("NestedEvent"),
          EventSchemaVersion.make(1),
          NestedSchema,
        )
        expect(snap1.jsonSchema).toBe(snap2.jsonSchema)
        expect(snap1.eventType).toBe("NestedEvent")
        expect(snap1.version).toBe(1)
        expect(snap1.jsonSchema.indexOf('"definitions"')).toBeLessThan(
          snap1.jsonSchema.indexOf('"dialect"'),
        )
        expect(snap1.jsonSchema.indexOf('"dialect"')).toBeLessThan(
          snap1.jsonSchema.indexOf('"schema"'),
        )
        expect(snap1.jsonSchema.indexOf('"a"')).toBeLessThan(snap1.jsonSchema.indexOf('"b"'))
        expect(snap1.jsonSchema.indexOf('"c"')).toBeLessThan(snap1.jsonSchema.indexOf('"d"'))
        expect(snap1.jsonSchema.indexOf('"x"')).toBeLessThan(snap1.jsonSchema.indexOf('"y"'))
      }),
    )

    it.effect("enforces onExcessProperty: error resulting in additionalProperties: false", () =>
      Effect.gen(function* () {
        const snap = yield* toEventVersionSnapshot(
          EventType.make("CartCreated"),
          EventSchemaVersion.make(1),
          CartCreated,
        )
        const parsed = JSON.parse(snap.jsonSchema) as {
          schema: { additionalProperties?: boolean }
        }
        expect(parsed.schema.additionalProperties).toBe(false)
      }),
    )
  })

  describe("CartCheckedOut v1 -> v2 Upcasting & CartEventV2Codec", () => {
    it("decodes stored v1 payload into CartCheckedOutV2 with default channel", () => {
      const v1Payload = {
        _tag: "CartCheckedOut" as const,
        cartId: "cart-42",
        orderId: "order-99",
        version: 1 as const,
      }

      const decoded = Schema.decodeSync(CartEventV2Codec)(v1Payload)
      expect(decoded._tag).toBe("CartCheckedOut")
      expect(decoded.version).toBe(2)
      match(decoded)
        .with({ _tag: "CartCheckedOut" }, (e) => {
          expect(e.cartId).toBe("cart-42")
          expect(e.orderId).toBe("order-99")
          expect(e.channel).toBe(DEFAULT_CHECKOUT_CHANNEL)
        })
        .with({ _tag: "CartCreated" }, () => {
          expect.unreachable("Expected CartCheckedOut")
        })
        .with({ _tag: "ItemAdded" }, () => {
          expect.unreachable("Expected CartCheckedOut")
        })
        .exhaustive()
    })

    it("encodes and decodes CartCheckedOutV2 with custom channel preserving version: 2", () => {
      const v2Payload = {
        _tag: "CartCheckedOut" as const,
        cartId: CartId.make("cart-77"),
        orderId: OrderId.make("order-101"),
        channel: CheckoutChannel.make("mobile-app"),
        version: 2 as const,
      }

      const encoded = Schema.encodeSync(CartCheckedOutV2)(v2Payload)
      expect(encoded._tag).toBe("CartCheckedOut")
      expect(encoded.version).toBe(2)
      expect(encoded.channel).toBe("mobile-app")

      const roundTripped = Schema.decodeSync(CartEventV2Codec)(encoded)
      expect(roundTripped.version).toBe(2)
      match(roundTripped)
        .with({ _tag: "CartCheckedOut" }, (e) => {
          expect(e.channel).toBe("mobile-app")
        })
        .with({ _tag: "CartCreated" }, () => {
          expect.unreachable("Expected CartCheckedOut")
        })
        .with({ _tag: "ItemAdded" }, () => {
          expect.unreachable("Expected CartCheckedOut")
        })
        .exhaustive()
    })

    it.effect("cartDeciderV2 evolves and decides over CartEventV2 and CartCommandV2", () =>
      Effect.gen(function* () {
        const cartId = CartId.make("cart-v2-1")
        const itemId = ItemId.make("item-abc")
        const orderId = OrderId.make("order-xyz")
        const channel = CheckoutChannel.make("kiosk")

        // 1. AddItem on EmptyCart
        const addCmd = AddItem.make({
          cartId,
          itemId,
          quantity: PositiveInt.make(2),
        })
        const events1 = yield* cartDeciderV2.decide(addCmd, initialCartStateV2)
        expect(events1.length).toBe(2)
        expect(events1[0]?._tag).toBe("CartCreated")
        expect(events1[1]?._tag).toBe("ItemAdded")

        const state1 = events1.reduce(cartDeciderV2.evolve, initialCartStateV2)
        match(state1)
          .with({ _tag: "ActiveCart" }, (s) => {
            expect(s.cartId).toBe(cartId)
            expect(s.itemCount).toBe(2)
            expect(s.items).toEqual([{ itemId, quantity: PositiveInt.make(2) }])
          })
          .with({ _tag: "EmptyCart" }, () => {
            expect.unreachable("Expected ActiveCart")
          })
          .with({ _tag: "CheckedOutCart" }, () => {
            expect.unreachable("Expected ActiveCart")
          })
          .exhaustive()

        // 2. CheckoutV2 on ActiveCart
        const checkoutCmd = CheckoutV2.make({
          cartId,
          orderId,
          channel,
        })
        const events2 = yield* cartDeciderV2.decide(checkoutCmd, state1)
        expect(events2.length).toBe(1)
        expect(events2[0]?._tag).toBe("CartCheckedOut")
        expect(events2[0]?.version).toBe(2)

        const state2 = events2.reduce(cartDeciderV2.evolve, state1)
        match(state2)
          .with({ _tag: "CheckedOutCart" }, (s) => {
            expect(s.cartId).toBe(cartId)
            expect(s.orderId).toBe(orderId)
            expect(s.channel).toBe(channel)
            expect(s.totalItems).toBe(2)
          })
          .with({ _tag: "ActiveCart" }, () => {
            expect.unreachable("Expected CheckedOutCart")
          })
          .with({ _tag: "EmptyCart" }, () => {
            expect.unreachable("Expected CheckedOutCart")
          })
          .exhaustive()

        // 2b. Verify evolveCartV2 preserves state on no-op/mismatched/terminal transitions
        expect(cartDeciderV2.evolve(state1, { _tag: "CartCreated", cartId, version: 1 })).toEqual(
          state1,
        )
        expect(cartDeciderV2.evolve(state2, { _tag: "CartCreated", cartId, version: 1 })).toEqual(
          state2,
        )
        expect(
          cartDeciderV2.evolve(state1, {
            _tag: "ItemAdded",
            cartId: CartId.make("other-cart"),
            itemId,
            quantity: PositiveInt.make(1),
            version: 1,
          }),
        ).toEqual(state1)
        expect(
          cartDeciderV2.evolve(initialCartStateV2, {
            _tag: "ItemAdded",
            cartId,
            itemId,
            quantity: PositiveInt.make(1),
            version: 1,
          }),
        ).toEqual(initialCartStateV2)
        expect(
          cartDeciderV2.evolve(state2, {
            _tag: "ItemAdded",
            cartId,
            itemId,
            quantity: PositiveInt.make(1),
            version: 1,
          }),
        ).toEqual(state2)
        expect(
          cartDeciderV2.evolve(state1, {
            _tag: "CartCheckedOut",
            cartId: CartId.make("other-cart"),
            orderId,
            channel,
            version: 2,
          }),
        ).toEqual(state1)
        expect(
          cartDeciderV2.evolve(initialCartStateV2, {
            _tag: "CartCheckedOut",
            cartId,
            orderId,
            channel,
            version: 2,
          }),
        ).toEqual(initialCartStateV2)
        expect(
          cartDeciderV2.evolve(state2, {
            _tag: "CartCheckedOut",
            cartId,
            orderId,
            channel,
            version: 2,
          }),
        ).toEqual(state2)

        // 3. CartIdMismatchError on AddItem and CheckoutV2
        const wrongCartAdd = AddItem.make({
          cartId: CartId.make("wrong-cart"),
          itemId,
          quantity: PositiveInt.make(1),
        })
        const addMismatchExit = yield* Effect.exit(cartDeciderV2.decide(wrongCartAdd, state1))
        match(addMismatchExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartIdMismatchError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        const wrongCartCheckout = CheckoutV2.make({
          cartId: CartId.make("wrong-cart"),
          orderId,
          channel,
        })
        const checkoutMismatchExit = yield* Effect.exit(
          cartDeciderV2.decide(wrongCartCheckout, state1),
        )
        match(checkoutMismatchExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartIdMismatchError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        // 4. EmptyCartCheckoutError on EmptyCart and on ActiveCart with zero items
        const emptyCheckoutExit = yield* Effect.exit(
          cartDeciderV2.decide(checkoutCmd, initialCartStateV2),
        )
        match(emptyCheckoutExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof EmptyCartCheckoutError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        const zeroItemsActiveState = cartDeciderV2.evolve(initialCartStateV2, {
          _tag: "CartCreated",
          cartId,
          version: 1,
        })
        const zeroItemsCheckoutExit = yield* Effect.exit(
          cartDeciderV2.decide(checkoutCmd, zeroItemsActiveState),
        )
        match(zeroItemsCheckoutExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof EmptyCartCheckoutError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        // 5. CartAlreadyCheckedOutError when already checked out
        const checkoutAgainExit = yield* Effect.exit(cartDeciderV2.decide(checkoutCmd, state2))
        match(checkoutAgainExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartAlreadyCheckedOutError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        const addAfterCheckoutExit = yield* Effect.exit(cartDeciderV2.decide(addCmd, state2))
        match(addAfterCheckoutExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartAlreadyCheckedOutError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        // 6. Error precedence: CartIdMismatchError beats EmptyCartCheckoutError (on zero-item ActiveCart) and CartAlreadyCheckedOutError (on CheckedOutCart)
        const mismatchOnZeroItemsExit = yield* Effect.exit(
          cartDeciderV2.decide(wrongCartCheckout, zeroItemsActiveState),
        )
        match(mismatchOnZeroItemsExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartIdMismatchError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()

        const mismatchOnCheckedOutExit = yield* Effect.exit(
          cartDeciderV2.decide(wrongCartCheckout, state2),
        )
        match(mismatchOnCheckedOutExit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof CartIdMismatchError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed error")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )
  })

  describe("decideEventSchemaEvolution & verifyEventSchemaEvolution", () => {
    const makeSnapshots = Effect.gen(function* () {
      const snap1 = yield* toEventVersionSnapshot(
        EventType.make("CartCreated"),
        EventSchemaVersion.make(1),
        CartCreated,
      )
      const snap2 = yield* toEventVersionSnapshot(
        EventType.make("ItemAdded"),
        EventSchemaVersion.make(1),
        ItemAdded,
      )
      const snap3 = yield* toEventVersionSnapshot(
        EventType.make("CartCheckedOut"),
        EventSchemaVersion.make(1),
        CartCheckedOut,
      )
      const snap4 = yield* toEventVersionSnapshot(
        EventType.make("CartCheckedOut"),
        EventSchemaVersion.make(2),
        CartCheckedOutV2,
      )
      return [snap1, snap2, snap3, snap4]
    })

    it.effect("valid evolution succeeds in decide and verify", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        const input = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: snapshots,
          registeredUpcasters: [cartCheckedOutV1ToV2.link],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "SchemaEvolutionValid" }, (d) => {
            expect(d.checkedEventCount).toBe(4)
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected SchemaEvolutionValid")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected SchemaEvolutionValid")
          })
          .exhaustive()

        const verified = yield* verifyEventSchemaEvolution(input)
        expect(verified._tag).toBe("SchemaEvolutionValid")
        expect(verified.checkedEventCount).toBe(4)
      }),
    )

    it.effect(
      "real version-bump superset case: committed v1 snapshots and current v1+v2 snapshots pass decide and verify",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* makeSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[2]!],
            currentSnapshots: snapshots,
            registeredUpcasters: [cartCheckedOutV1ToV2.link],
          })

          const decision = yield* decideEventSchemaEvolution(input)
          match(decision)
            .with({ _tag: "SchemaEvolutionValid" }, (d) => {
              expect(d.checkedEventCount).toBe(4)
            })
            .with({ _tag: "FrozenEventVersionDrifted" }, () => {
              expect.unreachable("Expected SchemaEvolutionValid")
            })
            .with({ _tag: "UnmappedEventVersionJump" }, () => {
              expect.unreachable("Expected SchemaEvolutionValid")
            })
            .exhaustive()

          const verified = yield* verifyEventSchemaEvolution(input)
          match(verified)
            .with({ _tag: "SchemaEvolutionValid" }, (v) => {
              expect(v.checkedEventCount).toBe(4)
            })
            .exhaustive()
        }),
    )

    it.effect(
      "unsorted snapshot versions in currentSnapshots are sorted and pass decideEventSchemaEvolution",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* makeSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[2]!],
            currentSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[3]!, snapshots[2]!],
            registeredUpcasters: [cartCheckedOutV1ToV2.link],
          })

          const decision = yield* decideEventSchemaEvolution(input)
          match(decision)
            .with({ _tag: "SchemaEvolutionValid" }, (d) => {
              expect(d.checkedEventCount).toBe(4)
            })
            .with({ _tag: "FrozenEventVersionDrifted" }, () => {
              expect.unreachable("Expected SchemaEvolutionValid")
            })
            .with({ _tag: "UnmappedEventVersionJump" }, () => {
              expect.unreachable("Expected SchemaEvolutionValid")
            })
            .exhaustive()
        }),
    )

    it.effect(
      "upcaster whose eventType does not match any snapshot returns UnmappedEventVersionJump",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* makeSnapshots
          const unknownTypeLink = new EventUpcasterLink({
            eventType: EventType.make("UnknownEvent"),
            fromVersion: EventSchemaVersion.make(1),
            toVersion: EventSchemaVersion.make(2),
          })
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: snapshots,
            currentSnapshots: snapshots,
            registeredUpcasters: [cartCheckedOutV1ToV2.link, unknownTypeLink],
          })

          const decision = yield* decideEventSchemaEvolution(input)
          match(decision)
            .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
              expect(d.eventType).toBe("UnknownEvent")
              expect(d.fromVersion).toBe(1)
              expect(d.toVersion).toBe(2)
              expect(d.reason).toContain(
                "Upcaster links to version not present in currentSnapshots",
              )
            })
            .with({ _tag: "SchemaEvolutionValid" }, () => {
              expect.unreachable("Expected UnmappedEventVersionJump")
            })
            .with({ _tag: "FrozenEventVersionDrifted" }, () => {
              expect.unreachable("Expected UnmappedEventVersionJump")
            })
            .exhaustive()
        }),
    )

    it.effect("drifted v1 schema causes FrozenEventSchemaViolationError", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        const driftedSnapshot = new EventVersionSnapshotEntry({
          eventType: EventType.make("CartCreated"),
          version: EventSchemaVersion.make(1),
          jsonSchema: JsonSchemaText.make('{"tampered":true}'),
        })
        const committed = [driftedSnapshot, snapshots[1]!, snapshots[2]!, snapshots[3]!]

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: committed,
          currentSnapshots: snapshots,
          registeredUpcasters: [cartCheckedOutV1ToV2.link],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
            expect(d.eventType).toBe("CartCreated")
            expect(d.version).toBe(1)
            expect(d.reason).toBe("Committed event version JSON Schema has drifted")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof FrozenEventSchemaViolationError).toBe(true)
                match(s.value)
                  .with({ _tag: "FrozenEventSchemaViolationError" }, (v) => {
                    expect(v.eventType).toBe("CartCreated")
                    expect(v.version).toBe(1)
                  })
                  .with({ _tag: "MissingEventUpcasterError" }, () => {
                    expect.unreachable("Expected FrozenEventSchemaViolationError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("deleted v1 snapshot causes FrozenEventSchemaViolationError", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        const deletedSnapshot = new EventVersionSnapshotEntry({
          eventType: EventType.make("LegacyEvent"),
          version: EventSchemaVersion.make(1),
          jsonSchema: JsonSchemaText.make("{}"),
        })
        const committed = [...snapshots, deletedSnapshot]

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: committed,
          currentSnapshots: snapshots,
          registeredUpcasters: [cartCheckedOutV1ToV2.link],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
            expect(d.eventType).toBe("LegacyEvent")
            expect(d.version).toBe(1)
            expect(d.reason).toBe("Committed event version is missing from currentSnapshots")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof FrozenEventSchemaViolationError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("duplicate snapshot causes FrozenEventSchemaViolationError", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        const duplicatedCurrent = [...snapshots, snapshots[0]!]

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: duplicatedCurrent,
          registeredUpcasters: [cartCheckedOutV1ToV2.link],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
            expect(d.eventType).toBe("CartCreated")
            expect(d.version).toBe(1)
            expect(d.reason).toContain("Duplicate event version snapshot in currentSnapshots")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof FrozenEventSchemaViolationError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("version not starting at 1 causes MissingEventUpcasterError", () =>
      Effect.gen(function* () {
        const snapV2Only = new EventVersionSnapshotEntry({
          eventType: EventType.make("BrandNewEvent"),
          version: EventSchemaVersion.make(2),
          jsonSchema: JsonSchemaText.make("{}"),
        })

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: [snapV2Only],
          currentSnapshots: [snapV2Only],
          registeredUpcasters: [],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.eventType).toBe("BrandNewEvent")
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(2)
            expect(d.reason).toBe("Event version history must start at version 1")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof MissingEventUpcasterError).toBe(true)
                match(s.value)
                  .with({ _tag: "MissingEventUpcasterError" }, (v) => {
                    expect(v.eventType).toBe("BrandNewEvent")
                    expect(v.fromVersion).toBe(1)
                    expect(v.toVersion).toBe(2)
                  })
                  .with({ _tag: "FrozenEventSchemaViolationError" }, () => {
                    expect.unreachable("Expected MissingEventUpcasterError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("version gap v1 -> v3 causes MissingEventUpcasterError", () =>
      Effect.gen(function* () {
        const snapV1 = new EventVersionSnapshotEntry({
          eventType: EventType.make("GappedEvent"),
          version: EventSchemaVersion.make(1),
          jsonSchema: JsonSchemaText.make("{}"),
        })
        const snapV3 = new EventVersionSnapshotEntry({
          eventType: EventType.make("GappedEvent"),
          version: EventSchemaVersion.make(3),
          jsonSchema: JsonSchemaText.make("{}"),
        })

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: [snapV1, snapV3],
          currentSnapshots: [snapV1, snapV3],
          registeredUpcasters: [],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.eventType).toBe("GappedEvent")
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(3)
            expect(d.reason).toBe("Non-contiguous event version gap")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof MissingEventUpcasterError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("v2 added without upcaster causes MissingEventUpcasterError", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        // No upcasters registered!
        const input = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: snapshots,
          registeredUpcasters: [],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.eventType).toBe("CartCheckedOut")
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(2)
            expect(d.reason).toBe("Missing upcaster for event version transition")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof MissingEventUpcasterError).toBe(true)
                match(s.value)
                  .with({ _tag: "MissingEventUpcasterError" }, (v) => {
                    expect(v.eventType).toBe("CartCheckedOut")
                    expect(v.fromVersion).toBe(1)
                    expect(v.toVersion).toBe(2)
                  })
                  .with({ _tag: "FrozenEventSchemaViolationError" }, () => {
                    expect.unreachable("Expected MissingEventUpcasterError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect("duplicate registeredUpcasters link causes MissingEventUpcasterError", () =>
      Effect.gen(function* () {
        const snapshots = yield* makeSnapshots
        const input = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: snapshots,
          registeredUpcasters: [cartCheckedOutV1ToV2.link, cartCheckedOutV1ToV2.link],
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.eventType).toBe("CartCheckedOut")
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(2)
            expect(d.reason).toContain("Duplicate upcaster link registered")
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .exhaustive()

        const exit = yield* Effect.exit(verifyEventSchemaEvolution(input))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const err = Cause.findErrorOption(f.cause)
            match(err)
              .with({ _tag: "Some" }, (s) => {
                expect(s.value instanceof MissingEventUpcasterError).toBe(true)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected typed failure")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected failure")
          })
          .exhaustive()
      }),
    )

    it.effect(
      "orphan registeredUpcasters link referencing absent snapshot causes MissingEventUpcasterError",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* makeSnapshots
          const orphanLink = new EventUpcasterLink({
            eventType: EventType.make("CartCreated"),
            fromVersion: EventSchemaVersion.make(1),
            toVersion: EventSchemaVersion.make(2),
          })
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: snapshots,
            currentSnapshots: snapshots,
            registeredUpcasters: [cartCheckedOutV1ToV2.link, orphanLink],
          })

          const decision = yield* decideEventSchemaEvolution(input)
          match(decision)
            .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
              expect(d.eventType).toBe("CartCreated")
              expect(d.fromVersion).toBe(1)
              expect(d.toVersion).toBe(2)
              expect(d.reason).toContain(
                "Upcaster links to version not present in currentSnapshots",
              )
            })
            .with({ _tag: "SchemaEvolutionValid" }, () => {
              expect.unreachable("Expected UnmappedEventVersionJump")
            })
            .with({ _tag: "FrozenEventVersionDrifted" }, () => {
              expect.unreachable("Expected UnmappedEventVersionJump")
            })
            .exhaustive()
        }),
    )

    it.effect(
      "non-contiguous EventUpcasterLink (v1 -> v3) is rejected by schema filter at construction",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Schema.decodeEffect(EventUpcasterLink)({
              eventType: "CartCheckedOut",
              fromVersion: 1,
              toVersion: 3,
            }),
          )
          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              expect(Cause.hasFails(f.cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected EventUpcasterLink schema failure for v1 -> v3")
            })
            .exhaustive()
        }),
    )

    describe("decideEventSchemaEvolution precedence order", () => {
      it.effect(
        "precedence: duplicate snapshot beats missing upcaster (step a beats step c -> FrozenEventVersionDrifted)",
        () =>
          Effect.gen(function* () {
            const snapV1 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(1),
              jsonSchema: JsonSchemaText.make('{"v":1}'),
            })
            const snapV2 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(2),
              jsonSchema: JsonSchemaText.make('{"v":2}'),
            })
            // Duplicate snapV1 in currentSnapshots AND missing v1->v2 upcaster in registeredUpcasters
            const input = new EventSchemaEvolutionInput({
              committedSnapshots: [snapV1],
              currentSnapshots: [snapV1, snapV1, snapV2],
              registeredUpcasters: [],
            })
            const decision = yield* decideEventSchemaEvolution(input)
            match(decision)
              .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
                expect(d.eventType).toBe("TestPrecedence")
                expect(d.version).toBe(1)
                expect(d.reason).toContain("Duplicate event version snapshot in currentSnapshots")
              })
              .with({ _tag: "UnmappedEventVersionJump" }, () => {
                expect.unreachable("Expected FrozenEventVersionDrifted (step a to beat step c)")
              })
              .with({ _tag: "SchemaEvolutionValid" }, () => {
                expect.unreachable("Expected FrozenEventVersionDrifted")
              })
              .exhaustive()
          }),
      )

      it.effect(
        "precedence: drifted committed snapshot beats non-contiguous gap (step b beats step c -> FrozenEventVersionDrifted)",
        () =>
          Effect.gen(function* () {
            const committedV1 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(1),
              jsonSchema: JsonSchemaText.make('{"v":1}'),
            })
            const driftedV1 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(1),
              jsonSchema: JsonSchemaText.make('{"v":"drifted"}'),
            })
            const snapV3 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(3),
              jsonSchema: JsonSchemaText.make('{"v":3}'),
            })
            // Drifted v1 in currentSnapshots AND non-contiguous version gap (v1 -> v3)
            const input = new EventSchemaEvolutionInput({
              committedSnapshots: [committedV1],
              currentSnapshots: [driftedV1, snapV3],
              registeredUpcasters: [],
            })
            const decision = yield* decideEventSchemaEvolution(input)
            match(decision)
              .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
                expect(d.eventType).toBe("TestPrecedence")
                expect(d.version).toBe(1)
                expect(d.reason).toBe("Committed event version JSON Schema has drifted")
              })
              .with({ _tag: "UnmappedEventVersionJump" }, () => {
                expect.unreachable("Expected FrozenEventVersionDrifted (step b to beat step c)")
              })
              .with({ _tag: "SchemaEvolutionValid" }, () => {
                expect.unreachable("Expected FrozenEventVersionDrifted")
              })
              .exhaustive()
          }),
      )

      it.effect(
        "precedence: non-contiguous gap beats dangling upcaster (step c beats step d -> UnmappedEventVersionJump with Non-contiguous event version gap)",
        () =>
          Effect.gen(function* () {
            const snapV1 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(1),
              jsonSchema: JsonSchemaText.make('{"v":1}'),
            })
            const snapV3 = new EventVersionSnapshotEntry({
              eventType: EventType.make("TestPrecedence"),
              version: EventSchemaVersion.make(3),
              jsonSchema: JsonSchemaText.make('{"v":3}'),
            })
            const danglingUpcaster = new EventUpcasterLink({
              eventType: EventType.make("DanglingEvent"),
              fromVersion: EventSchemaVersion.make(1),
              toVersion: EventSchemaVersion.make(2),
            })
            // Non-contiguous gap (v1 -> v3) AND dangling upcaster for nonexistent event
            const input = new EventSchemaEvolutionInput({
              committedSnapshots: [snapV1, snapV3],
              currentSnapshots: [snapV1, snapV3],
              registeredUpcasters: [danglingUpcaster],
            })
            const decision = yield* decideEventSchemaEvolution(input)
            match(decision)
              .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
                expect(d.eventType).toBe("TestPrecedence")
                expect(d.fromVersion).toBe(1)
                expect(d.toVersion).toBe(3)
                expect(d.reason).toBe("Non-contiguous event version gap")
              })
              .with({ _tag: "FrozenEventVersionDrifted" }, () => {
                expect.unreachable("Expected UnmappedEventVersionJump (step c)")
              })
              .with({ _tag: "SchemaEvolutionValid" }, () => {
                expect.unreachable("Expected UnmappedEventVersionJump")
              })
              .exhaustive()
          }),
      )
    })
  })

  describe("verifyCommittedSnapshotParity & prepareUpdatedEventSnapshots", () => {
    it.effect(
      "verifyCommittedSnapshotParity succeeds when currentSnapshots and committedSnapshots are identical and valid",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* computeCartEventSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: snapshots,
            currentSnapshots: snapshots,
            registeredUpcasters: cartRegisteredUpcasters,
          })
          const verified = yield* verifyCommittedSnapshotParity(input)
          expect(verified._tag).toBe("SchemaEvolutionValid")
          expect(verified.checkedEventCount).toBe(4)
        }),
    )

    it.effect(
      "verifyCommittedSnapshotParity fails with FrozenEventSchemaViolationError when currentSnapshots contains uncommitted v2",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* computeCartEventSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[2]!],
            currentSnapshots: snapshots,
            registeredUpcasters: cartRegisteredUpcasters,
          })
          const exit = yield* Effect.exit(verifyCommittedSnapshotParity(input))
          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              const errOpt = Cause.findErrorOption(f.cause)
              match(errOpt)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof FrozenEventSchemaViolationError).toBe(true)
                  match(value)
                    .with({ _tag: "FrozenEventSchemaViolationError" }, (v) => {
                      expect(v.eventType).toBe("CartCheckedOut")
                      expect(v.version).toBe(2)
                      expect(v.reason).toContain("Uncommitted event schema version")
                    })
                    .with({ _tag: "MissingEventUpcasterError" }, () => {
                      expect.unreachable("Expected FrozenEventSchemaViolationError")
                    })
                    .exhaustive()
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed error")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected failure")
            })
            .exhaustive()
        }),
    )

    it.effect(
      "prepareUpdatedEventSnapshots succeeds and returns currentSnapshots when adding v2 on top of frozen v1",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* computeCartEventSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[2]!],
            currentSnapshots: snapshots,
            registeredUpcasters: cartRegisteredUpcasters,
          })
          const updated = yield* prepareUpdatedEventSnapshots(input)
          expect(updated).toEqual(snapshots)
        }),
    )

    it.effect(
      "prepareUpdatedEventSnapshots fails with FrozenEventSchemaViolationError when frozen v1 snapshot was mutated",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* computeCartEventSnapshots
          const mutatedV1 = new EventVersionSnapshotEntry({
            eventType: snapshots[0]!.eventType,
            version: snapshots[0]!.version,
            jsonSchema: JsonSchemaText.make('{"mutated":true}'),
          })
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: snapshots,
            currentSnapshots: [mutatedV1, snapshots[1]!, snapshots[2]!, snapshots[3]!],
            registeredUpcasters: cartRegisteredUpcasters,
          })
          const exit = yield* Effect.exit(prepareUpdatedEventSnapshots(input))
          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              const errOpt = Cause.findErrorOption(f.cause)
              match(errOpt)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof FrozenEventSchemaViolationError).toBe(true)
                  match(value)
                    .with({ _tag: "FrozenEventSchemaViolationError" }, (v) => {
                      expect(v.eventType).toBe("CartCreated")
                      expect(v.version).toBe(1)
                      expect(v.reason).toBe("Committed event version JSON Schema has drifted")
                    })
                    .with({ _tag: "MissingEventUpcasterError" }, () => {
                      expect.unreachable("Expected FrozenEventSchemaViolationError")
                    })
                    .exhaustive()
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed error")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected failure")
            })
            .exhaustive()
        }),
    )

    it.effect(
      "prepareUpdatedEventSnapshots fails with MissingEventUpcasterError when adding v2 without registering upcaster",
      () =>
        Effect.gen(function* () {
          const snapshots = yield* computeCartEventSnapshots
          const input = new EventSchemaEvolutionInput({
            committedSnapshots: [snapshots[0]!, snapshots[1]!, snapshots[2]!],
            currentSnapshots: snapshots,
            registeredUpcasters: [],
          })
          const exit = yield* Effect.exit(prepareUpdatedEventSnapshots(input))
          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              const errOpt = Cause.findErrorOption(f.cause)
              match(errOpt)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof MissingEventUpcasterError).toBe(true)
                  match(value)
                    .with({ _tag: "MissingEventUpcasterError" }, (v) => {
                      expect(v.eventType).toBe("CartCheckedOut")
                      expect(v.fromVersion).toBe(1)
                      expect(v.toVersion).toBe(2)
                      expect(v.reason).toBe("Missing upcaster for event version transition")
                    })
                    .with({ _tag: "FrozenEventSchemaViolationError" }, () => {
                      expect.unreachable("Expected MissingEventUpcasterError")
                    })
                    .exhaustive()
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed error")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected failure")
            })
            .exhaustive()
        }),
    )
  })

  describe("makeDeciderTestHarness negative paths", () => {
    it.effect("dies when decider.decide succeeds unexpectedly while thenFails was called", () =>
      Effect.gen(function* () {
        const harness = makeDeciderTestHarness(cartDeciderV2)
        const addCmd = AddItem.make({
          cartId: CartId.make("cart-neg-1"),
          itemId: ItemId.make("item-neg-1"),
          quantity: PositiveInt.make(1),
        })
        const exit = yield* Effect.exit(
          harness
            .given([])
            .when(addCmd)
            .thenFails(new EmptyCartCheckoutError({ cartId: CartId.make("cart-neg-1") })),
        )
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            expect(Cause.hasDies(f.cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected harness to die when decider unexpectedly succeeded")
          })
          .exhaustive()
      }),
    )

    it.effect(
      "dies when decider.decide fails with a different error than expected in thenFails",
      () =>
        Effect.gen(function* () {
          const harness = makeDeciderTestHarness(cartDeciderV2)
          const checkoutCmd = CheckoutV2.make({
            cartId: CartId.make("cart-neg-2"),
            orderId: OrderId.make("order-neg-2"),
            channel: CheckoutChannel.make("web"),
          })
          const exit = yield* Effect.exit(
            harness
              .given([])
              .when(checkoutCmd)
              .thenFails(new CartAlreadyCheckedOutError({ cartId: CartId.make("cart-neg-2") })),
          )
          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              expect(Cause.hasDies(f.cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected harness to die when decider failed with different error")
            })
            .exhaustive()
        }),
    )

    it.effect("dies when decider.decide fails unexpectedly while thenEvents was called", () =>
      Effect.gen(function* () {
        const harness = makeDeciderTestHarness(cartDeciderV2)
        const checkoutCmd = CheckoutV2.make({
          cartId: CartId.make("cart-neg-3"),
          orderId: OrderId.make("order-neg-3"),
          channel: CheckoutChannel.make("web"),
        })
        const exit = yield* Effect.exit(harness.given([]).when(checkoutCmd).thenEvents([]))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            expect(Cause.hasDies(f.cause)).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected harness to die when decider failed during thenEvents")
          })
          .exhaustive()
      }),
    )
  })
})
