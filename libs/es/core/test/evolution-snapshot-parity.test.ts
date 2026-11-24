import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import {
  EventSchemaEvolutionInput,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
  JsonSchemaText,
  MissingEventUpcasterError,
  PositiveInt,
} from "@harness/es-contract"
import { match } from "ts-pattern"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "../src/evolution.js"
import { makeDeciderTestHarness } from "../src/testing.js"
import {
  AddItem,
  CartAlreadyCheckedOutError,
  cartDeciderV2,
  CartId,
  cartRegisteredUpcasters,
  CheckoutChannel,
  CheckoutV2,
  computeCartEventSnapshots,
  EmptyCartCheckoutError,
  ItemId,
  OrderId,
} from "./fixtures/cart.js"

describe("EventSchemaEvolution snapshots & decider harness negative paths", () => {
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
