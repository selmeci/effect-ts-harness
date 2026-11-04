import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Equal, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventUpcasterLink,
  EventVersionSnapshotEntry,
  JsonSchemaText,
  PositiveInt,
  ProjectionSequenceInput,
  StreamVersion,
} from "@harness/es-contract"
import { decideProjectionSequence } from "../src/index.js"
import { decideEventSchemaEvolution } from "../src/evolution.js"
import {
  AddItem,
  CartCommand,
  CartEvent,
  CartEventV2Codec,
  CartId,
  type CartState,
  cartDeciderV2,
  decideCart,
  evolveCart,
  initialCartState,
  initialCartStateV2,
  ItemAdded,
  ItemCount,
  ItemId,
  OrderId,
  positiveInt,
} from "./fixtures/cart.js"

const cid = (v: string) => CartId.make(v)
const iid = (v: string) => ItemId.make(v)
const oid = (v: string) => OrderId.make(v)
const icount = (v: number) => ItemCount.make(v)

describe("Cart Reducer Property-Based Tests", () => {
  it.prop(
    "satisfies chunked fold equivalence across arbitrary CartEvent streams",
    {
      events: Schema.Array(CartEvent),
      splitRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    },
    ({ events, splitRatio }) => {
      const k = Math.floor(events.length * splitRatio)
      const fullFold = events.reduce(evolveCart, initialCartState)
      const firstChunkState = events.slice(0, k).reduce(evolveCart, initialCartState)
      const chunkedFold = events.slice(k).reduce(evolveCart, firstChunkState)

      expect(Equal.equals(chunkedFold, fullFold)).toBe(true)
    },
  )

  it.prop(
    "produces deterministic state transitions identical across repeated evaluations",
    {
      events: Schema.Array(CartEvent),
    },
    ({ events }) => {
      const state1 = events.reduce(evolveCart, initialCartState)
      const state2 = events.reduce(evolveCart, initialCartState)
      expect(Equal.equals(state1, state2)).toBe(true)
    },
  )

  it.prop(
    "preserves terminal status when subsequent events are applied in CheckedOutCart state",
    {
      subsequentEvents: Schema.Array(CartEvent),
    },
    ({ subsequentEvents }) => {
      const checkedOutState = [
        { _tag: "CartCreated" as const, cartId: cid("c-1"), version: 1 as const },
        {
          _tag: "ItemAdded" as const,
          cartId: cid("c-1"),
          itemId: iid("i-1"),
          quantity: positiveInt(4),
          version: 1 as const,
        },
        {
          _tag: "CartCheckedOut" as const,
          cartId: cid("c-1"),
          orderId: oid("o-1"),
          version: 1 as const,
        },
      ].reduce(evolveCart, initialCartState)
      const finalState = subsequentEvents.reduce(evolveCart, checkedOutState)
      match(finalState)
        .with({ _tag: "CheckedOutCart" }, (s) => {
          expect(s.cartId).toBe(cid("c-1"))
          expect(s.orderId).toBe(oid("o-1"))
          expect(s.totalItems).toBe(icount(4))
        })
        .with({ _tag: "ActiveCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .with({ _tag: "EmptyCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .exhaustive()
    },
  )

  it.prop(
    "accumulates items and itemCount accurately across arbitrary ItemAdded batches for the active cart",
    {
      additions: Schema.Array(ItemAdded),
    },
    ({ additions }) => {
      const cartId = cid("cart-prop")
      const normalizedAdditions = additions.map((ev) => ({
        ...ev,
        cartId,
      }))
      const initialState: CartState = {
        _tag: "ActiveCart",
        cartId,
        items: [],
        itemCount: icount(0),
      }
      const finalState = normalizedAdditions.reduce(evolveCart, initialState)
      const expectedTotal = normalizedAdditions.reduce((acc, ev) => acc + ev.quantity, 0)

      match(finalState)
        .with({ _tag: "ActiveCart" }, (s) => {
          expect(s.items.length).toBe(additions.length)
          expect(s.itemCount).toBe(icount(expectedTotal))
          expect(
            Equal.equals(
              s.items,
              normalizedAdditions.map((a) => ({ itemId: a.itemId, quantity: a.quantity })),
            ),
          ).toBe(true)
        })
        .with({ _tag: "EmptyCart" }, () => {
          expect.unreachable("Expected ActiveCart")
        })
        .with({ _tag: "CheckedOutCart" }, () => {
          expect.unreachable("Expected ActiveCart")
        })
        .exhaustive()
    },
  )
})

describe("Cart Decider Property-Based Tests", () => {
  it.effect.prop(
    "decideCart succeeds and emits ItemAdded for any valid AddItem on active cart",
    {
      command: AddItem,
    },
    ({ command }) =>
      Effect.gen(function* () {
        const activeState: CartState = {
          _tag: "ActiveCart",
          cartId: command.cartId,
          items: [],
          itemCount: icount(0),
        }
        const events = yield* decideCart(command, activeState)
        expect(events.length).toBe(1)
        const [firstEvent] = events
        match(firstEvent)
          .with({ _tag: "ItemAdded" }, (ev) => {
            expect(ev.cartId).toBe(command.cartId)
            expect(ev.itemId).toBe(command.itemId)
            expect(ev.quantity).toBe(command.quantity)
          })
          .with({ _tag: "CartCreated" }, () => {
            expect.unreachable("Expected ItemAdded")
          })
          .with({ _tag: "CartCheckedOut" }, () => {
            expect.unreachable("Expected ItemAdded")
          })
          .with(undefined, () => {
            expect.unreachable("Expected at least one event")
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "decideCart fails with CartAlreadyCheckedOutError for any command on CheckedOutCart",
    {
      command: CartCommand,
    },
    ({ command }) =>
      Effect.gen(function* () {
        const checkedOutState: CartState = {
          _tag: "CheckedOutCart",
          cartId: command.cartId,
          orderId: oid("o-1"),
          totalItems: icount(5),
        }
        const exit = yield* Effect.exit(decideCart(command, checkedOutState))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartAlreadyCheckedOutError" }, (err) => {
                    expect(err.cartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartIdMismatchError" }, () => {
                    expect.unreachable("Expected CartAlreadyCheckedOutError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartAlreadyCheckedOutError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartAlreadyCheckedOutError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected decider to fail on checked-out cart")
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "decideCart fails with CartIdMismatchError whenever command.cartId differs from state.cartId",
    {
      command: CartCommand,
    },
    ({ command }) =>
      Effect.gen(function* () {
        const stateCartId = cid(`${command.cartId}-other-aggregate`)
        const activeState: CartState = {
          _tag: "ActiveCart",
          cartId: stateCartId,
          items: [],
          itemCount: icount(0),
        }
        const activeExit = yield* Effect.exit(decideCart(command, activeState))
        match(activeExit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartIdMismatchError" }, (err) => {
                    expect(err.expectedCartId).toBe(stateCartId)
                    expect(err.actualCartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartAlreadyCheckedOutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartIdMismatchError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected CartIdMismatchError on active cart")
          })
          .exhaustive()

        const checkedOutState: CartState = {
          _tag: "CheckedOutCart",
          cartId: stateCartId,
          orderId: oid("order-prop"),
          totalItems: icount(3),
        }
        const checkedOutExit = yield* Effect.exit(decideCart(command, checkedOutState))
        match(checkedOutExit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartIdMismatchError" }, (err) => {
                    expect(err.expectedCartId).toBe(stateCartId)
                    expect(err.actualCartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartAlreadyCheckedOutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartIdMismatchError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected CartIdMismatchError on checked out cart")
          })
          .exhaustive()
      }),
  )
})

describe("ProjectionSequence.decide Property-Based Tests", () => {
  it.effect.prop(
    "classifies every ProjectionSequenceInput into a valid decision and preserves version invariants",
    { input: ProjectionSequenceInput },
    ({ input }) =>
      Effect.gen(function* () {
        const decision = yield* decideProjectionSequence(input)

        match(decision)
          .with({ _tag: "SkipDuplicateEvent" }, (d) => {
            expect(input.incomingVersion <= input.checkpointVersion).toBe(true)
            expect(d.checkpointVersion).toBe(input.checkpointVersion)
          })
          .with({ _tag: "ParkOutOfOrderEvent" }, (d) => {
            expect(input.incomingVersion > input.checkpointVersion + 1).toBe(true)
            expect(d.expectedVersion).toBe(StreamVersion.make(input.checkpointVersion + 1))
            expect(d.parkedVersion).toBe(input.incomingVersion)
          })
          .with({ _tag: "ApplyContiguousEvents" }, (d) => {
            expect(input.incomingVersion).toBe(input.checkpointVersion + 1)
            expect(d.versionsToApply.length).toBeGreaterThanOrEqual(1)
            expect(d.versionsToApply[0]).toBe(input.checkpointVersion + 1)
            expect(d.newCheckpointVersion).toBe(d.versionsToApply[d.versionsToApply.length - 1])
            for (let i = 0; i < d.versionsToApply.length - 1; i++) {
              const current = d.versionsToApply[i]
              const next = d.versionsToApply[i + 1]
              if (current !== undefined && next !== undefined) {
                expect(next - current).toBe(1)
              }
            }
            const candidateParked = new Set(
              input.parkedVersions.filter((v) => v > input.checkpointVersion),
            )
            expect(candidateParked.has(StreamVersion.make(d.newCheckpointVersion + 1))).toBe(false)
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "converges to the exact same final checkpoint and applied sequence regardless of permutation order of versions 1..N",
    {
      count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 })),
      seed: Schema.Int,
    },
    ({ count, seed }) =>
      Effect.gen(function* () {
        const versions = Array.from({ length: count }, (_, i) => StreamVersion.make(i + 1))

        let currentSeed = Math.abs(seed) % 2147483647
        if (currentSeed === 0) {
          currentSeed = 1
        }
        const nextRand = () => {
          currentSeed = (currentSeed * 16807) % 2147483647
          return (currentSeed - 1) / 2147483646
        }
        for (let i = versions.length - 1; i > 0; i--) {
          const j = Math.floor(nextRand() * (i + 1))
          const current = versions[i]
          const target = versions[j]
          if (current !== undefined && target !== undefined) {
            versions[i] = target
            versions[j] = current
          }
        }

        let currentCheckpoint = StreamVersion.make(0)
        let parkedVersions: Array<StreamVersion> = []
        const allApplied: Array<StreamVersion> = []

        for (const incoming of versions) {
          const input = new ProjectionSequenceInput({
            checkpointVersion: currentCheckpoint,
            incomingVersion: incoming,
            parkedVersions,
          })

          const decision = yield* decideProjectionSequence(input)

          match(decision)
            .with({ _tag: "SkipDuplicateEvent" }, () => {
              // Duplicate skipped
            })
            .with({ _tag: "ParkOutOfOrderEvent" }, (d) => {
              parkedVersions.push(d.parkedVersion)
            })
            .with({ _tag: "ApplyContiguousEvents" }, (d) => {
              for (const v of d.versionsToApply) {
                allApplied.push(v)
              }
              currentCheckpoint = d.newCheckpointVersion
              const appliedSet = new Set(d.versionsToApply)
              parkedVersions = parkedVersions.filter((v) => !appliedSet.has(v))
            })
            .exhaustive()
        }

        expect(currentCheckpoint).toBe(count)
        expect(allApplied).toEqual(
          Array.from({ length: count }, (_, i) => StreamVersion.make(i + 1)),
        )
        expect(parkedVersions.length).toBe(0)
      }),
  )
})

describe("EventSchemaEvolution Property-Based Tests", () => {
  it.effect.prop(
    "REQ-1.2: detects schema drift or omitted committed snapshots across arbitrary versions",
    {
      versionCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
      tamperIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
      driftType: Schema.Union([Schema.Literal("modify"), Schema.Literal("omit")]),
    },
    ({ versionCount, tamperIndex, driftType }) =>
      Effect.gen(function* () {
        const idx = tamperIndex % versionCount
        const snapshots: Array<EventVersionSnapshotEntry> = []
        const upcasters: Array<EventUpcasterLink> = []

        for (let v = 1; v <= versionCount; v++) {
          snapshots.push(
            new EventVersionSnapshotEntry({
              eventType: EventType.make("OrderEvent"),
              version: EventSchemaVersion.make(v),
              jsonSchema: JsonSchemaText.make(`{"version":${v}}`),
            }),
          )
          if (v > 1) {
            upcasters.push(
              new EventUpcasterLink({
                eventType: EventType.make("OrderEvent"),
                fromVersion: EventSchemaVersion.make(v - 1),
                toVersion: EventSchemaVersion.make(v),
              }),
            )
          }
        }

        const committed = snapshots.map(
          (s) =>
            new EventVersionSnapshotEntry({
              eventType: s.eventType,
              version: s.version,
              jsonSchema: s.jsonSchema,
            }),
        )

        let current: Array<EventVersionSnapshotEntry>
        if (driftType === "modify") {
          current = snapshots.map((s, i) =>
            i === idx
              ? new EventVersionSnapshotEntry({
                  eventType: s.eventType,
                  version: s.version,
                  jsonSchema: JsonSchemaText.make(`{"version":${s.version},"drifted":true}`),
                })
              : s,
          )
        } else {
          current = snapshots.filter((_, i) => i !== idx)
        }

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: committed,
          currentSnapshots: current,
          registeredUpcasters: upcasters,
        })

        const decision = yield* decideEventSchemaEvolution(input)
        match(decision)
          .with({ _tag: "FrozenEventVersionDrifted" }, (d) => {
            expect(d.eventType).toBe("OrderEvent")
            expect(d.version).toBe(idx + 1)
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected FrozenEventVersionDrifted")
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "REQ-1.3: rejects non-contiguous version sequences or sequences not starting at 1",
    {
      startVersion: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
      gapStep: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 4 })),
    },
    ({ startVersion, gapStep }) =>
      Effect.gen(function* () {
        // Case A: does not start at 1
        const notStartingAt1 = [
          new EventVersionSnapshotEntry({
            eventType: EventType.make("AccountEvent"),
            version: EventSchemaVersion.make(startVersion),
            jsonSchema: JsonSchemaText.make(`{"ver":${startVersion}}`),
          }),
        ]
        const inputA = new EventSchemaEvolutionInput({
          committedSnapshots: [],
          currentSnapshots: notStartingAt1,
          registeredUpcasters: [],
        })
        const decisionA = yield* decideEventSchemaEvolution(inputA)
        match(decisionA)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(startVersion)
          })
          .with({ _tag: "SchemaEvolutionValid" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected UnmappedEventVersionJump")
          })
          .exhaustive()

        // Case B: contiguous v1 then gap to 1 + gapStep
        const gapped = [
          new EventVersionSnapshotEntry({
            eventType: EventType.make("AccountEvent"),
            version: EventSchemaVersion.make(1),
            jsonSchema: JsonSchemaText.make('{"ver":1}'),
          }),
          new EventVersionSnapshotEntry({
            eventType: EventType.make("AccountEvent"),
            version: EventSchemaVersion.make(1 + gapStep),
            jsonSchema: JsonSchemaText.make(`{"ver":${1 + gapStep}}`),
          }),
        ]
        const inputB = new EventSchemaEvolutionInput({
          committedSnapshots: [],
          currentSnapshots: gapped,
          registeredUpcasters: [],
        })
        const decisionB = yield* decideEventSchemaEvolution(inputB)
        match(decisionB)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.fromVersion).toBe(1)
            expect(d.toVersion).toBe(1 + gapStep)
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

  it.effect.prop(
    "REQ-1.4: requires all contiguous version transitions to have registered upcasters",
    {
      versionCount: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
      missingUpcasterIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
    },
    ({ versionCount, missingUpcasterIndex }) =>
      Effect.gen(function* () {
        const missingStep = 1 + (missingUpcasterIndex % (versionCount - 1))
        const snapshots: Array<EventVersionSnapshotEntry> = []
        const fullUpcasters: Array<EventUpcasterLink> = []

        for (let v = 1; v <= versionCount; v++) {
          snapshots.push(
            new EventVersionSnapshotEntry({
              eventType: EventType.make("InventoryEvent"),
              version: EventSchemaVersion.make(v),
              jsonSchema: JsonSchemaText.make(`{"ver":${v}}`),
            }),
          )
          if (v > 1) {
            fullUpcasters.push(
              new EventUpcasterLink({
                eventType: EventType.make("InventoryEvent"),
                fromVersion: EventSchemaVersion.make(v - 1),
                toVersion: EventSchemaVersion.make(v),
              }),
            )
          }
        }

        // Case with all upcasters present -> valid
        const validInput = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: snapshots,
          registeredUpcasters: fullUpcasters,
        })
        const validDecision = yield* decideEventSchemaEvolution(validInput)
        match(validDecision)
          .with({ _tag: "SchemaEvolutionValid" }, (d) => {
            expect(d.checkedEventCount).toBe(versionCount)
          })
          .with({ _tag: "FrozenEventVersionDrifted" }, () => {
            expect.unreachable("Expected SchemaEvolutionValid")
          })
          .with({ _tag: "UnmappedEventVersionJump" }, () => {
            expect.unreachable("Expected SchemaEvolutionValid")
          })
          .exhaustive()

        // Case with one upcaster missing -> UnmappedEventVersionJump
        const partialUpcasters = fullUpcasters.filter((u) => u.fromVersion !== missingStep)
        const missingInput = new EventSchemaEvolutionInput({
          committedSnapshots: snapshots,
          currentSnapshots: snapshots,
          registeredUpcasters: partialUpcasters,
        })
        const missingDecision = yield* decideEventSchemaEvolution(missingInput)
        match(missingDecision)
          .with({ _tag: "UnmappedEventVersionJump" }, (d) => {
            expect(d.fromVersion).toBe(missingStep)
            expect(d.toVersion).toBe(missingStep + 1)
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

  it.prop(
    "CartEventV2Codec upcasts arbitrary v1 and v2 checkout events and preserves cartDeciderV2 invariants",
    {
      itemQuantities: Schema.Array(PositiveInt),
      isV1Checkout: Schema.Boolean,
      channel: Schema.Union([
        Schema.Literal("web"),
        Schema.Literal("mobile"),
        Schema.Literal("in-store"),
      ]),
    },
    ({ itemQuantities, isV1Checkout, channel }) => {
      const rawEvents: Array<unknown> = [
        { _tag: "CartCreated", cartId: "prop-cart", version: 1 },
        ...itemQuantities.map((q, idx) => ({
          _tag: "ItemAdded",
          cartId: "prop-cart",
          itemId: `item-${idx}`,
          quantity: q,
          version: 1,
        })),
        isV1Checkout
          ? { _tag: "CartCheckedOut", cartId: "prop-cart", orderId: "order-1", version: 1 }
          : {
              _tag: "CartCheckedOut",
              cartId: "prop-cart",
              orderId: "order-1",
              channel,
              version: 2,
            },
      ]

      const decodedEvents = rawEvents.map((e) => Schema.decodeUnknownSync(CartEventV2Codec)(e))

      for (const evt of decodedEvents) {
        match(evt)
          .with({ _tag: "CartCheckedOut" }, (e) => {
            expect(e.version).toBe(2)
            match(isV1Checkout)
              .with(true, () => {
                expect(e.channel).toBe("web")
              })
              .with(false, () => {
                expect(e.channel).toBe(channel)
              })
              .exhaustive()
          })
          .with({ _tag: "CartCreated" }, () => {})
          .with({ _tag: "ItemAdded" }, () => {})
          .exhaustive()
      }

      const finalState = decodedEvents.reduce(cartDeciderV2.evolve, initialCartStateV2)
      const expectedTotal = itemQuantities.reduce((acc, n) => acc + n, 0)

      match(finalState)
        .with({ _tag: "CheckedOutCart" }, (s) => {
          expect(s.totalItems).toBe(expectedTotal)
          match(isV1Checkout)
            .with(true, () => {
              expect(s.channel).toBe("web")
            })
            .with(false, () => {
              expect(s.channel).toBe(channel)
            })
            .exhaustive()
        })
        .with({ _tag: "ActiveCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .with({ _tag: "EmptyCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .exhaustive()
    },
  )
})
