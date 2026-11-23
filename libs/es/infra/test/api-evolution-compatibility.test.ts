import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { HttpApiTest } from "effect/http-api"
import {
  AggregateId,
  AggregateName,
  BatchLimit,
  CommandId,
  ConcurrencyConflictError,
  EventSerializationError,
  EventStreamCorruptionError,
  OutboxPublishError,
  PositiveInt,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  ProjectionName,
} from "@harness/es-contract"
import { type AggregateConfig, CrossAggregateProjection, type Decider } from "@harness/es-core"
import {
  CartAlreadyCheckedOutError,
  type CartCommandV2,
  CartEventV2,
  CartId,
  type CartStateV2,
  CheckoutChannel,
  EmptyCartCheckoutError,
  ItemId,
  OrderId,
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"
import {
  executeAggregateCommandAndSync,
  initializeAggregateTables,
  initializeProjectorTables,
  queryAggregateReadModel,
  relayAggregateOutbox,
  seedAggregateStream,
} from "../src/index.js"
import {
  cartAggregateConfigV2,
  CartEsApi,
  cartViewV2Projection,
  initCartViewV2Table,
  initOpenCartsProjectionTable,
  openCartsProjectionV2,
} from "./fixtures/cart-sqlite.js"
import { positiveInt, TestEnv, cartApiLayer } from "./helpers/api-evolution-fixture.js"

describe("Aggregate HTTP & Evolution Compatibility Specs", () => {
  it.effect(
    "seedAggregateStream fails with EventSerializationError on domain event with missing or invalid _tag",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()

          interface UntaggedEvent {
            readonly _tag: string
            readonly cartId: CartId
            readonly version: 1
          }
          const UntaggedEventSchema = Schema.Struct({
            _tag: Schema.String,
            cartId: CartId,
            version: Schema.Literal(1),
          })
          const dummyDecider: Decider<
            CartCommandV2,
            UntaggedEvent,
            CartStateV2,
            CartAlreadyCheckedOutError | EmptyCartCheckoutError
          > = {
            initialState: { _tag: "EmptyCart" },
            decide: () => Effect.succeed([]),
            evolve: (state) => state,
          }
          const invalidTagConfig: AggregateConfig<
            CartCommandV2,
            UntaggedEvent,
            CartStateV2,
            CartAlreadyCheckedOutError | EmptyCartCheckoutError
          > = {
            aggregateName: AggregateName.make("Cart"),
            decider: dummyDecider,
            eventSchema: UntaggedEventSchema,
            outboxMode: { _tag: "SuppressOutbox" },
          }

          const badTagEvent: UntaggedEvent = {
            _tag: "",
            cartId: CartId.make("cart-invalid-tag"),
            version: 1,
          }

          const exit = yield* seedAggregateStream(
            AggregateId.make("cart-invalid-tag"),
            [badTagEvent],
            invalidTagConfig,
          ).pipe(Effect.exit)

          match(exit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventSerializationError).toBe(true)
                  match(value)
                    .with({ _tag: "EventSerializationError" }, (serErr) => {
                      expect(serErr.reason).toBe("Missing or invalid _tag on seeded domain event")
                    })
                    .otherwise(() => {
                      expect.unreachable("expected EventSerializationError")
                    })
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventSerializationError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream and executeAggregateCommandAndSync honor SuppressOutbox mode",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          const sql = yield* SqlClient

          const suppressOutboxConfig = {
            ...cartAggregateConfigV2,
            outboxMode: { _tag: "SuppressOutbox" as const },
          }
          const suppressCartId = AggregateId.make("cart-suppress-outbox")
          const suppressSeedVer = yield* seedAggregateStream(
            suppressCartId,
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-suppress-outbox"),
              },
            ],
            suppressOutboxConfig,
          )
          expect(suppressSeedVer).toBe(1)

          yield* executeAggregateCommandAndSync(
            suppressCartId,
            {
              _tag: "AddItem" as const,
              cartId: CartId.make("cart-suppress-outbox"),
              itemId: ItemId.make("item-suppress-1"),
              quantity: positiveInt(1),
            },
            CommandId.make("cmd-suppress-1"),
            suppressOutboxConfig,
          )

          const suppressEvents = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM es_events WHERE aggregate_id = ${suppressCartId}
          `
          expect(suppressEvents[0]?.cnt).toBe(2)

          const suppressView = yield* queryAggregateReadModel(
            suppressCartId,
            ProjectionName.make("CartView"),
            suppressOutboxConfig,
            [cartViewV2Projection],
          )
          expect(suppressView.itemCount).toBe(1)

          const suppressOutbox = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM es_outbox WHERE aggregate_id = ${suppressCartId}
          `
          expect(suppressOutbox[0]?.cnt).toBe(0)
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream rolls back transaction when a subsequent event in the batch fails encoding",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          const sql = yield* SqlClient

          const RejectSecondEventSchema = CartEventV2.pipe(
            Schema.check(
              Schema.makeFilter((e) =>
                match(e)
                  .with({ _tag: "ItemAdded" }, () => "Reject second event during seed")
                  .with({ _tag: "CartCreated" }, { _tag: "CartCheckedOut" }, () => undefined)
                  .exhaustive(),
              ),
            ),
          )

          const rollbackCartId = AggregateId.make("cart-seed-rollback")
          const rollbackExit = yield* seedAggregateStream(
            rollbackCartId,
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-rollback"),
              },
              {
                _tag: "ItemAdded" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-rollback"),
                itemId: ItemId.make("item-rollback-1"),
                quantity: positiveInt(1),
              },
            ],
            {
              ...cartAggregateConfigV2,
              eventSchema: RejectSecondEventSchema,
            },
          ).pipe(Effect.exit)

          match(rollbackExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventSerializationError).toBe(true)
                  match(value)
                    .with({ _tag: "EventSerializationError" }, (serErr) => {
                      expect(serErr.streamVersion).toBe(2)
                    })
                    .otherwise(() => {
                      expect.unreachable("expected EventSerializationError")
                    })
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventSerializationError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()

          const rollbackEventsCount = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM es_events WHERE aggregate_id = ${rollbackCartId}
          `
          expect(rollbackEventsCount[0]?.cnt).toBe(0)

          const rollbackProjectionCount = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM projection_cart_view_v2 WHERE cart_id = ${rollbackCartId}
          `
          expect(rollbackProjectionCount[0]?.cnt).toBe(0)
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "relayAggregateOutbox loops across multiple batches until outbox is completely drained",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          yield* sql`DELETE FROM es_outbox`

          const cartId = AggregateId.make("cart-multi-batch")
          const events: ReadonlyArray<CartEventV2> = [
            { _tag: "CartCreated", version: 1, cartId: CartId.make("cart-multi-batch") },
            {
              _tag: "ItemAdded",
              version: 1,
              cartId: CartId.make("cart-multi-batch"),
              itemId: ItemId.make("item-1"),
              quantity: positiveInt(1),
            },
            {
              _tag: "ItemAdded",
              version: 1,
              cartId: CartId.make("cart-multi-batch"),
              itemId: ItemId.make("item-2"),
              quantity: positiveInt(2),
            },
            {
              _tag: "ItemAdded",
              version: 1,
              cartId: CartId.make("cart-multi-batch"),
              itemId: ItemId.make("item-3"),
              quantity: positiveInt(3),
            },
            {
              _tag: "CartCheckedOut",
              version: 2,
              cartId: CartId.make("cart-multi-batch"),
              orderId: OrderId.make("order-mb-1"),
              channel: CheckoutChannel.make("web"),
            },
          ]
          const head = yield* seedAggregateStream(cartId, events, cartAggregateConfigV2)
          expect(head).toBe(5)

          const initialOutboxRows = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM es_outbox WHERE aggregate_name = 'Cart'
          `
          expect(initialOutboxRows[0]?.cnt).toBe(5)

          const outcome = yield* relayAggregateOutbox(
            AggregateName.make("Cart"),
            [openCartsProjectionV2],
            BatchLimit.make(2),
          )
          match(outcome)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(5)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained")
            })
            .exhaustive()

          const remainingOutbox = yield* sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM es_outbox WHERE aggregate_name = 'Cart'
          `
          expect(remainingOutbox[0]?.cnt).toBe(0)

          const secondOutcome = yield* relayAggregateOutbox(
            AggregateName.make("Cart"),
            [openCartsProjectionV2],
            BatchLimit.make(2),
          )
          match(secondOutcome)
            .with({ _tag: "OutboxEmpty" }, () => {
              // successfully empty!
            })
            .with({ _tag: "OutboxDrained" }, () => {
              expect.unreachable("expected OutboxEmpty")
            })
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "relayAggregateOutbox fails with OutboxPublishError when cross-aggregate projection fails, preserving es_outbox row",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const outboxFailCartId = AggregateId.make("cart-outbox-fail")
          const failingCrossWithTypedErr = CrossAggregateProjection.make({
            processorId: ProcessorId.make("failing-cross-proj-typed"),
            aggregateName: AggregateName.make("Cart"),
            eventSchema: CartEventV2,
            model: Schema.Struct({ count: PositiveInt }),
            apply: () => sql`SELECT * FROM non_existent_table_for_outbox_test`.pipe(Effect.asVoid),
            query: () => Effect.succeed({ count: positiveInt(1) }),
            purge: Effect.void,
          })

          yield* sql`DELETE FROM es_outbox`

          yield* executeAggregateCommandAndSync(
            outboxFailCartId,
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-outbox-fail"),
              itemId: ItemId.make("item-1"),
              quantity: positiveInt(1),
            },
            CommandId.make("cmd-outbox-fail-1"),
            cartAggregateConfigV2,
          )

          const outboxFailExit = yield* relayAggregateOutbox(AggregateName.make("Cart"), [
            failingCrossWithTypedErr,
          ]).pipe(Effect.exit)

          match(outboxFailExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof OutboxPublishError).toBe(true)
                })
                .with({ _tag: "None" }, () => expect.unreachable("expected OutboxPublishError"))
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()

          const remainingOutbox = yield* sql<{ aggregate_id: string }>`
            SELECT aggregate_id FROM es_outbox WHERE aggregate_id = ${outboxFailCartId}
          `
          expect(remainingOutbox.length).toBeGreaterThan(0)
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "relayAggregateOutbox surfaces ProjectionArchiveCorruptionError when cross-projection schema fails to decode payload",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const RejectingCartEventSchema = CartEventV2.pipe(
            Schema.check(Schema.makeFilter(() => "Simulated serialization failure")),
          )
          yield* sql`DELETE FROM es_outbox`
          const incompatibleCrossProjection = CrossAggregateProjection.make({
            processorId: ProcessorId.make("incompatible-cross-proj"),
            aggregateName: AggregateName.make("Cart"),
            eventSchema: RejectingCartEventSchema,
            model: Schema.Struct({ count: PositiveInt }),
            apply: () => Effect.void,
            query: () => Effect.succeed({ count: positiveInt(1) }),
            purge: Effect.void,
          })
          const archiveCorruptCartId = AggregateId.make("cart-archive-corrupt")
          yield* executeAggregateCommandAndSync(
            archiveCorruptCartId,
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-archive-corrupt"),
              itemId: ItemId.make("item-1"),
              quantity: positiveInt(1),
            },
            CommandId.make("cmd-archive-corrupt-1"),
            cartAggregateConfigV2,
          )
          const archiveCorruptExit = yield* relayAggregateOutbox(AggregateName.make("Cart"), [
            incompatibleCrossProjection,
          ]).pipe(Effect.exit)

          match(archiveCorruptExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof ProjectionArchiveCorruptionError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected ProjectionArchiveCorruptionError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream maps unique insert conflict to ConcurrencyConflictError or EventStreamCorruptionError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const conflictCartId = AggregateId.make("cart-seed-conflict")

          yield* sql`
            CREATE TRIGGER IF NOT EXISTS test_seed_conflict_trigger
            BEFORE INSERT ON es_events
            FOR EACH ROW
            WHEN NEW.aggregate_id = 'cart-seed-conflict' AND NEW.command_id LIKE 'seed-%'
            BEGIN
              SELECT RAISE(ABORT, 'UNIQUE constraint failed: es_events.aggregate_name, es_events.aggregate_id, es_events.stream_version');
            END;
          `

          yield* Effect.addFinalizer(() =>
            sql`DROP TRIGGER IF EXISTS test_seed_conflict_trigger`.pipe(Effect.orDie),
          )

          // 1. With existing valid row at stream_version = 1 -> maps unique conflict to ConcurrencyConflictError
          yield* sql`
            INSERT INTO es_events (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', ${conflictCartId}, 1, 'cmd-valid-1', 'CartCreated', '{}', '{}', 1000
            )
          `

          const conflictExit = yield* seedAggregateStream(
            conflictCartId,
            [
              {
                _tag: "ItemAdded" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-conflict"),
                itemId: ItemId.make("item-conf-1"),
                quantity: positiveInt(1),
              },
            ],
            cartAggregateConfigV2,
          ).pipe(Effect.exit)

          match(conflictExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof ConcurrencyConflictError).toBe(true)
                  match(value)
                    .with({ _tag: "ConcurrencyConflictError" }, (cErr) => {
                      expect(cErr.aggregateId).toBe("cart-seed-conflict")
                      expect(cErr.expectedVersion).toBe(1)
                      expect(cErr.actualVersion).toBe(1)
                    })
                    .otherwise(() => {
                      expect.unreachable("expected ConcurrencyConflictError")
                    })
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected ConcurrencyConflictError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()

          // 2. With corrupt row at stream_version = -5 -> maps to EventStreamCorruptionError
          yield* sql`DELETE FROM es_events WHERE aggregate_id = ${conflictCartId}`
          yield* sql`
            INSERT INTO es_events (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', ${conflictCartId}, -5, 'cmd-corrupt-5', 'CartCreated', '{}', '{}', 1000
            )
          `

          const corruptExit = yield* seedAggregateStream(
            conflictCartId,
            [
              {
                _tag: "ItemAdded" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-conflict"),
                itemId: ItemId.make("item-conf-2"),
                quantity: positiveInt(1),
              },
            ],
            cartAggregateConfigV2,
          ).pipe(Effect.exit)

          match(corruptExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventStreamCorruptionError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventStreamCorruptionError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()

          // 3. Without any existing rows (missing max_version) -> maps to EventStreamCorruptionError
          yield* sql`DELETE FROM es_events WHERE aggregate_id = ${conflictCartId}`

          const missingExit = yield* seedAggregateStream(
            conflictCartId,
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-conflict"),
              },
            ],
            cartAggregateConfigV2,
          ).pipe(Effect.exit)

          match(missingExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventStreamCorruptionError).toBe(true)
                  match(value)
                    .with({ _tag: "EventStreamCorruptionError" }, (corrErr) => {
                      expect(corrErr.reason).toContain(
                        "Missing max(stream_version) during unique conflict resolution",
                      )
                    })
                    .otherwise(() => {
                      expect.unreachable("expected EventStreamCorruptionError")
                    })
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventStreamCorruptionError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "HttpApi executeCommand rejects params.cartId !== payload.command.cartId with CartIdMismatchError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const client = yield* HttpApiTest.groups(CartEsApi, ["carts"]).pipe(
            Effect.provide(cartApiLayer),
          )

          const mismatchHttpExit = yield* client.carts
            .executeCommand({
              params: { cartId: AggregateId.make("url-cart-id") },
              payload: {
                commandId: CommandId.make("cmd-url-mismatch"),
                command: {
                  _tag: "AddItem",
                  cartId: CartId.make("body-cart-id"),
                  itemId: ItemId.make("item-1"),
                  quantity: positiveInt(1),
                },
              },
            })
            .pipe(Effect.exit)
          match(mismatchHttpExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value._tag).toBe("CartIdMismatchError")
                })
                .with({ _tag: "None" }, () => expect.unreachable("expected CartIdMismatchError"))
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "F-20: seedAggregateStream bounds composite CommandId <= 256 chars deterministically when prefix + aggregateId > 256",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const longAggregateId = AggregateId.make("a".repeat(200))
          const longPrefix = CommandId.make("p".repeat(200))
          const seededVer = yield* seedAggregateStream(
            longAggregateId,
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-long-cmd"),
              },
              {
                _tag: "ItemAdded" as const,
                version: 1 as const,
                cartId: CartId.make("cart-long-cmd"),
                itemId: ItemId.make("item-long-1"),
                quantity: positiveInt(1),
              },
            ],
            cartAggregateConfigV2,
            longPrefix,
          )
          expect(seededVer).toBe(2)

          const eventRows = yield* sql<{ stream_version: number; command_id: string }>`
            SELECT stream_version, command_id FROM es_events
            WHERE aggregate_id = ${longAggregateId}
            ORDER BY stream_version ASC
          `
          expect(eventRows).toHaveLength(2)
          for (const row of eventRows) {
            expect(row.command_id.length).toBeLessThanOrEqual(256)
            expect(row.command_id.trim()).toBe(row.command_id)
            expect(() => Schema.decodeSync(CommandId)(row.command_id)).not.toThrow()
          }
          expect(eventRows[0]?.command_id).not.toBe(eventRows[1]?.command_id)
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "SPEC-0030 2nd-pass: seedAggregateStream clamps oversized >65536 schema failure causes into typed EventSerializationError without synchronous ErrorMessage defect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable

          const hugeCauseConfig = {
            ...cartAggregateConfigV2,
            projections: [],
            eventSchema: CartEventV2.pipe(
              Schema.check(
                Schema.makeFilter(() => `Oversized serialization cause: ${"x".repeat(70_000)}`),
              ),
            ),
          }

          const seedExit = yield* seedAggregateStream(
            AggregateId.make("cart-oversized-cause"),
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-oversized-cause"),
              },
            ],
            hugeCauseConfig,
          ).pipe(Effect.exit)

          match(seedExit)
            .with({ _tag: "Failure" }, (f) => {
              match(Cause.findErrorOption(f.cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  match(value)
                    .with({ _tag: "EventSerializationError" }, (serErr) => {
                      expect(serErr.reason.length).toBeLessThanOrEqual(65_536)
                      expect(serErr.reason).toContain("Oversized serialization cause:")
                    })
                    .otherwise(() =>
                      expect.unreachable(`expected EventSerializationError, got ${value._tag}`),
                    )
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected typed EventSerializationError, not Defect"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected EventSerializationError"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )
})
