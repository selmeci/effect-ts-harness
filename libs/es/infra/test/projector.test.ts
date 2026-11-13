import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AggregateId,
  AggregateName,
  BatchLimit,
  CommandId,
  CrossProjectionNotFoundError,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  EventType,
  OutboxPublishError,
  PositiveInt,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  PublishedEventEnvelope,
  SerializedPayload,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import { CrossAggregateProjection, EventBus, queryCrossProjection } from "@harness/es-core"
import { type CartCommand, CartEvent, CartId, ItemId } from "@harness/es-core/fixtures/cart"
import { match, P } from "ts-pattern"
import {
  checkProjectorCatchUp,
  drainAggregateOutbox,
  handleAggregateCommand,
  ingestPublishedEvent,
  initializeAggregateTables,
  initializeProjectorTables,
  rebuildProjectorFromArchive,
} from "../src/index.js"
import { SqlClientMemoryLayer } from "../src/memory.js"
import {
  applyOpenCarts,
  cartAggregateConfig,
  cartAggregateWithOutboxConfig,
  initCartViewTable,
  initOpenCartsProjectionTable,
  OpenCartsReport,
  openCartsProjection,
  purgeOpenCarts,
  queryOpenCarts,
} from "./fixtures/cart-sqlite.js"

const at = <T>(arr: ReadonlyArray<T>, idx: number): T => {
  const el = arr[idx]
  if (el === undefined) {
    throw new Error(`Expected element at index ${idx}`)
  }
  return el
}

describe("Cross-Aggregate Outbox Drain, Projector Checkpoints, Gap Parking, and Archive Rebuild", () => {
  describe("Group 1: At-Least-Once Outbox Drain (REQ-1.1, REQ-1.2, REQ-1.3, REQ-1.4)", () => {
    it.effect("REQ-1.2: returns OutboxEmpty when es_outbox table contains no pending rows", () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        let publishedCount = 0
        const dummyBus = EventBus.make({
          publish: () =>
            Effect.sync(() => {
              publishedCount += 1
            }),
        })

        const outcome = yield* drainAggregateOutbox(dummyBus)
        expect(outcome._tag).toBe("OutboxEmpty")
        expect(publishedCount).toBe(0)
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-1.1: drains pending outbox rows in ascending id order, deletes drained rows, and returns OutboxDrained",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const cartId = AggregateId.make("cart-outbox-1")
          const addCmd: CartCommand = {
            _tag: "AddItem",
            cartId: CartId.make("cart-outbox-1"),
            itemId: ItemId.make("item-apple"),
            quantity: PositiveInt.make(2),
          }

          yield* handleAggregateCommand(
            cartId,
            addCmd,
            CommandId.make("cmd-outbox-1"),
            cartAggregateWithOutboxConfig,
          )

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          const drainResult = yield* drainAggregateOutbox(bus)
          expect(drainResult._tag).toBe("OutboxDrained")
          match(drainResult)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(2)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained")
            })
            .exhaustive()

          expect(published.length).toBe(2)
          expect(at(published, 0).streamVersion).toBe(1)
          expect(at(published, 0).eventType).toBe("CartCreated")
          expect(at(published, 1).streamVersion).toBe(2)
          expect(at(published, 1).eventType).toBe("ItemAdded")

          const secondDrain = yield* drainAggregateOutbox(bus)
          expect(secondDrain._tag).toBe("OutboxEmpty")
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-1.3: failure during drain deletes already-published rows and leaves failed and subsequent rows in es_outbox for retry",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          const sql = yield* SqlClient

          const cartId = AggregateId.make("cart-outbox-fail")
          const addCmd: CartCommand = {
            _tag: "AddItem",
            cartId: CartId.make("cart-outbox-fail"),
            itemId: ItemId.make("item-berry"),
            quantity: PositiveInt.make(5),
          }

          yield* handleAggregateCommand(
            cartId,
            addCmd,
            CommandId.make("cmd-outbox-fail"),
            cartAggregateWithOutboxConfig,
          )

          const deliveredFirstPass: Array<PublishedEventEnvelope> = []
          let shouldFailOnSecond = true

          const failingBus = EventBus.make({
            publish: (env) =>
              Effect.gen(function* () {
                if (env.streamVersion === 2 && shouldFailOnSecond) {
                  return yield* new OutboxPublishError({
                    aggregateName: env.aggregateName,
                    aggregateId: env.aggregateId,
                    streamVersion: env.streamVersion,
                    reason: ErrorMessage.make("Simulated network failure on event 2"),
                  })
                }
                deliveredFirstPass.push(env)
              }),
          })

          const firstDrainError = yield* Effect.flip(drainAggregateOutbox(failingBus))
          match(firstDrainError)
            .with(P.instanceOf(OutboxPublishError), (err) => {
              expect(err.streamVersion).toBe(2)
            })
            .otherwise(() => {
              expect.unreachable("expected OutboxPublishError")
            })

          expect(deliveredFirstPass.length).toBe(1)
          expect(at(deliveredFirstPass, 0).streamVersion).toBe(1)

          const remainingRows = yield* sql<{ id: number; stream_version: number }>`
            SELECT id, stream_version FROM es_outbox ORDER BY id ASC
          `
          expect(remainingRows.length).toBe(1)
          expect(at(remainingRows, 0).stream_version).toBe(2)

          shouldFailOnSecond = false
          const deliveredSecondPass: Array<PublishedEventEnvelope> = []
          const recoveredBus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                deliveredSecondPass.push(env)
              }),
          })

          const secondDrain = yield* drainAggregateOutbox(recoveredBus)
          expect(secondDrain._tag).toBe("OutboxDrained")
          match(secondDrain)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(1)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained")
            })
            .exhaustive()

          expect(deliveredSecondPass.length).toBe(1)
          expect(at(deliveredSecondPass, 0).streamVersion).toBe(2)

          const finalRows = yield* sql<{ id: number }>`SELECT id FROM es_outbox`
          expect(finalRows.length).toBe(0)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-1.4: corrupt metadata JSON or invalid stream_version in es_outbox fails with EventStreamCorruptionError, and corrupt payload JSON fails with EventSerializationError",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initCartViewTable
          const sql = yield* SqlClient

          yield* handleAggregateCommand(
            AggregateId.make("cart-suppressed"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-suppressed"),
              itemId: ItemId.make("item-sup"),
              quantity: PositiveInt.make(1),
            },
            CommandId.make("cmd-sup-1"),
            cartAggregateConfig,
          )
          const suppressedRows = yield* sql<{ id: number }>`SELECT id FROM es_outbox`
          expect(suppressedRows.length).toBe(0)

          const dummyBus = EventBus.make({
            publish: () => Effect.void,
          })

          yield* sql`
            INSERT INTO es_outbox (
              aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', 'cart-corrupt', 1, 'CartCreated', '{"_tag":"CartCreated"}', 'NOT_VALID_JSON', 1700000000000
            )
          `

          const corruptMetaErr = yield* Effect.flip(drainAggregateOutbox(dummyBus))
          match(corruptMetaErr)
            .with(P.instanceOf(EventStreamCorruptionError), (err) => {
              expect(err.expectedStreamVersion).toBe(1)
            })
            .otherwise(() => {
              expect.unreachable("expected EventStreamCorruptionError")
            })

          yield* sql`DELETE FROM es_outbox`

          yield* sql`
            INSERT INTO es_outbox (
              aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', 'cart-bad-payload', 1, 'CartCreated', 'NOT_VALID_JSON', '{"aggregateId":"cart-bad-payload","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}', 1700000000000
            )
          `

          const corruptPayloadErr = yield* Effect.flip(drainAggregateOutbox(dummyBus))
          match(corruptPayloadErr)
            .with(P.instanceOf(EventSerializationError), (err) => {
              expect(err.streamVersion).toBe(1)
            })
            .otherwise(() => {
              expect.unreachable("expected EventSerializationError")
            })

          yield* sql`DELETE FROM es_outbox`

          yield* sql`
            INSERT INTO es_outbox (
              aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', 'cart-zero', 0, 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"cart-zero","streamVersion":0,"commandId":"cmd-1","timestamp":1700000000000}', 1700000000000
            )
          `

          const corruptVerErr = yield* Effect.flip(drainAggregateOutbox(dummyBus))
          match(corruptVerErr)
            .with(P.instanceOf(EventStreamCorruptionError), (err) => {
              expect(err.expectedStreamVersion).toBe(1)
            })
            .otherwise(() => {
              expect.unreachable("expected EventStreamCorruptionError")
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )
  })

  describe("Group 2: Projector Ingestion, Checkpoints, and Gap Parking (REQ-3.1 - REQ-3.6)", () => {
    it.effect(
      "REQ-3.1: initializeProjectorTables runs idempotently and records 1_init_es_projector_tables migration in isolated table",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* initializeProjectorTables()
          yield* initializeProjectorTables()

          const migrations = yield* sql<{
            readonly migration_id: number
            readonly name: string
          }>`
            SELECT migration_id, name FROM es_projector_sql_migrations ORDER BY migration_id ASC
          `
          expect(
            migrations.some((m) => m.migration_id === 1 && m.name === "init_es_projector_tables"),
          ).toBe(true)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-3.2 & REQ-3.5: ingests contiguous events across multiple Cart aggregates and advances checkpoints",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          yield* handleAggregateCommand(
            AggregateId.make("cart-1"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-1"),
              itemId: ItemId.make("apple"),
              quantity: PositiveInt.make(3),
            },
            CommandId.make("cmd-c1"),
            cartAggregateWithOutboxConfig,
          )

          yield* handleAggregateCommand(
            AggregateId.make("cart-2"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-2"),
              itemId: ItemId.make("banana"),
              quantity: PositiveInt.make(4),
            },
            CommandId.make("cmd-c2"),
            cartAggregateWithOutboxConfig,
          )

          yield* drainAggregateOutbox(bus)
          expect(published.length).toBe(4)

          for (const env of published) {
            yield* ingestPublishedEvent(env, [openCartsProjection])
          }

          const report = yield* queryOpenCarts
          expect(report.carts.length).toBe(2)
          expect(at(report.carts, 0).cartId).toBe("cart-1")
          expect(at(report.carts, 0).totalQuantity).toBe(3)
          expect(at(report.carts, 1).cartId).toBe("cart-2")
          expect(at(report.carts, 1).totalQuantity).toBe(4)

          const sql = yield* SqlClient
          const checkpoints = yield* sql<{ aggregate_id: string; last_stream_version: number }>`
            SELECT aggregate_id, last_stream_version
            FROM es_projection_checkpoints
            WHERE processor_id = 'open-carts-v1'
            ORDER BY aggregate_id ASC
          `
          expect(checkpoints.length).toBe(2)
          expect(at(checkpoints, 0).last_stream_version).toBe(2)
          expect(at(checkpoints, 1).last_stream_version).toBe(2)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-3.3: duplicate event delivery is skipped idempotently without double-counting",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          yield* handleAggregateCommand(
            AggregateId.make("cart-dup"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-dup"),
              itemId: ItemId.make("orange"),
              quantity: PositiveInt.make(2),
            },
            CommandId.make("cmd-dup-1"),
            cartAggregateWithOutboxConfig,
          )

          yield* drainAggregateOutbox(bus)
          expect(published.length).toBe(2)

          yield* ingestPublishedEvent(at(published, 0), [openCartsProjection])
          yield* ingestPublishedEvent(at(published, 1), [openCartsProjection])

          const reportBefore = yield* queryOpenCarts
          expect(at(reportBefore.carts, 0).totalQuantity).toBe(2)

          const dec1 = yield* ingestPublishedEvent(at(published, 0), [openCartsProjection])
          const dec2 = yield* ingestPublishedEvent(at(published, 1), [openCartsProjection])

          expect(at(dec1, 0)._tag).toBe("SkipDuplicateEvent")
          expect(at(dec2, 0)._tag).toBe("SkipDuplicateEvent")

          const reportAfter = yield* queryOpenCarts
          expect(at(reportAfter.carts, 0).totalQuantity).toBe(2)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-3.4: out-of-order delivery parks gaps, delays checkpoints, and applies contiguous events in exact order when missing version arrives",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          const cartId = AggregateId.make("cart-gap")

          yield* handleAggregateCommand(
            cartId,
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-gap"),
              itemId: ItemId.make("item-1"),
              quantity: PositiveInt.make(1),
            },
            CommandId.make("cmd-g1"),
            cartAggregateWithOutboxConfig,
          )

          yield* handleAggregateCommand(
            cartId,
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-gap"),
              itemId: ItemId.make("item-2"),
              quantity: PositiveInt.make(2),
            },
            CommandId.make("cmd-g2"),
            cartAggregateWithOutboxConfig,
          )

          yield* drainAggregateOutbox(bus)
          expect(published.length).toBe(3)

          const env1 = at(published, 0)
          const env2 = at(published, 1)
          const env3 = at(published, 2)

          const dec2 = yield* ingestPublishedEvent(env2, [openCartsProjection])
          expect(at(dec2, 0)._tag).toBe("ParkOutOfOrderEvent")

          let gaps = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE aggregate_id = 'cart-gap'
          `
          expect(gaps.length).toBe(1)
          expect(at(gaps, 0).stream_version).toBe(2)

          let checkpoints = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-gap'
          `
          expect(checkpoints.length).toBe(0)

          const dec3 = yield* ingestPublishedEvent(env3, [openCartsProjection])
          expect(at(dec3, 0)._tag).toBe("ParkOutOfOrderEvent")

          gaps = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE aggregate_id = 'cart-gap' ORDER BY stream_version ASC
          `
          expect(gaps.length).toBe(2)
          expect(at(gaps, 0).stream_version).toBe(2)
          expect(at(gaps, 1).stream_version).toBe(3)

          const dec1 = yield* ingestPublishedEvent(env1, [openCartsProjection])
          const firstDec = at(dec1, 0)
          expect(firstDec._tag).toBe("ApplyContiguousEvents")
          match(firstDec)
            .with({ _tag: "ApplyContiguousEvents" }, (res) => {
              expect(res.versionsToApply).toEqual([1, 2, 3])
              expect(res.newCheckpointVersion).toBe(3)
            })
            .with({ _tag: "SkipDuplicateEvent" }, { _tag: "ParkOutOfOrderEvent" }, () => {
              expect.unreachable("expected ApplyContiguousEvents")
            })
            .exhaustive()

          gaps = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE aggregate_id = 'cart-gap'
          `
          expect(gaps.length).toBe(0)

          checkpoints = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-gap'
          `
          expect(checkpoints.length).toBe(1)
          expect(at(checkpoints, 0).last_stream_version).toBe(3)

          const report = yield* queryOpenCarts
          expect(at(report.carts, 0).itemCount).toBe(2)
          expect(at(report.carts, 0).totalQuantity).toBe(3)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-3.6: corrupt JSON, zero streamVersion, metadata mismatch, or conflicting payload/metadata at existing version fails with ProjectionArchiveCorruptionError",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const zeroVerEnv = new PublishedEventEnvelope(
            {
              aggregateName: AggregateName.make("Cart"),
              aggregateId: AggregateId.make("cart-zero"),
              streamVersion: StreamVersion.make(0),
              eventType: EventType.make("CartCreated"),
              payload: SerializedPayload.make(
                '{"_tag":"CartCreated","cartId":"cart-zero","version":1}',
              ),
              metadata: new EventMetadata({
                aggregateId: AggregateId.make("cart-zero"),
                streamVersion: StreamVersion.make(0),
                commandId: CommandId.make("cmd-zero"),
                timestamp: TimestampMs.make(1700000000000),
              }),
            },
            { disableChecks: true },
          )
          const zeroErr = yield* Effect.flip(
            ingestPublishedEvent(zeroVerEnv, [openCartsProjection]),
          )
          match(zeroErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.streamVersion).toBe(0)
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for streamVersion 0")
            })

          const validMeta = new EventMetadata({
            aggregateId: AggregateId.make("cart-err"),
            streamVersion: StreamVersion.make(1),
            commandId: CommandId.make("cmd-err-1"),
            timestamp: TimestampMs.make(1700000000000),
          })

          const corruptPayloadEnv = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-err"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make("{invalid-json"),
            metadata: validMeta,
          })
          const corruptJsonErr = yield* Effect.flip(
            ingestPublishedEvent(corruptPayloadEnv, [openCartsProjection]),
          )
          match(corruptJsonErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.streamVersion).toBe(1)
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for corrupt JSON")
            })

          const mismatchedEnvelope = new PublishedEventEnvelope(
            {
              aggregateName: AggregateName.make("Cart"),
              aggregateId: AggregateId.make("cart-err"),
              streamVersion: StreamVersion.make(2),
              eventType: EventType.make("CartCreated"),
              payload: SerializedPayload.make(
                '{"_tag":"CartCreated","cartId":"cart-err","version":1}',
              ),
              metadata: validMeta,
            },
            { disableChecks: true },
          )

          const mismatchErr = yield* Effect.flip(
            ingestPublishedEvent(mismatchedEnvelope, [openCartsProjection]),
          )
          match(mismatchErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError")
            })

          const validEnv = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-err"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-err","version":1}',
            ),
            metadata: validMeta,
          })
          yield* ingestPublishedEvent(validEnv, [openCartsProjection])

          const conflictingEnv = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-err"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-err","version":1,"conflict":true}',
            ),
            metadata: validMeta,
          })
          const conflictErr = yield* Effect.flip(
            ingestPublishedEvent(conflictingEnv, [openCartsProjection]),
          )
          match(conflictErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError")
            })

          const conflictingMetaEnv = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-err"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-err","version":1}',
            ),
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-err"),
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-tampered"),
              timestamp: TimestampMs.make(1700000099999),
            }),
          })
          const metaConflictErr = yield* Effect.flip(
            ingestPublishedEvent(conflictingMetaEnv, [openCartsProjection]),
          )
          match(metaConflictErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateId).toBe("cart-err")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for metadata conflict")
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )
  })

  describe("Group 3: Archive Rebuild, Queries, and Catch-Up Inspection (REQ-4.1 - REQ-4.6)", () => {
    it.effect(
      "REQ-4.5: checkProjectorCatchUp returns Lagging on parked gaps or trailing checkpoints, CaughtUp when synchronized, and fails on orphan checkpoints",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const processorId = ProcessorId.make("open-carts-v1")
          const aggregateName = AggregateName.make("Cart")

          const emptyStatus = yield* checkProjectorCatchUp(processorId, aggregateName)
          expect(emptyStatus._tag).toBe("CaughtUp")

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          yield* handleAggregateCommand(
            AggregateId.make("cart-sync"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-sync"),
              itemId: ItemId.make("item-sync"),
              quantity: PositiveInt.make(1),
            },
            CommandId.make("cmd-sync-1"),
            cartAggregateWithOutboxConfig,
          )

          yield* drainAggregateOutbox(bus)
          expect(published.length).toBe(2)

          yield* ingestPublishedEvent(at(published, 1), [openCartsProjection])

          const laggingGap = yield* checkProjectorCatchUp(processorId, aggregateName)
          expect(laggingGap._tag).toBe("Lagging")
          match(laggingGap)
            .with({ _tag: "Lagging" }, (lag) => {
              expect(lag.laggingAggregateId).toBe("cart-sync")
            })
            .with({ _tag: "CaughtUp" }, () => {
              expect.unreachable("expected Lagging on parked gap")
            })
            .exhaustive()

          yield* ingestPublishedEvent(at(published, 0), [openCartsProjection])

          const caughtUpStatus = yield* checkProjectorCatchUp(processorId, aggregateName)
          expect(caughtUpStatus._tag).toBe("CaughtUp")
          match(caughtUpStatus)
            .with({ _tag: "CaughtUp" }, (c) => {
              expect(c.archiveAggregatesCount).toBe(1)
            })
            .with({ _tag: "Lagging" }, () => {
              expect.unreachable("expected CaughtUp")
            })
            .exhaustive()

          yield* sql`
            INSERT INTO es_projection_checkpoints (
              processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'ghost-cart', 5, 1700000000000
            )
          `
          const orphanErr = yield* Effect.flip(checkProjectorCatchUp(processorId, aggregateName))
          match(orphanErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateId).toBe("ghost-cart")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for orphan checkpoint")
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-4.1 & REQ-4.2: rebuildProjectorFromArchive purges projection, replays event archive, and produces exact parity (including updated_at) with live projection",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const published: Array<PublishedEventEnvelope> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                published.push(env)
              }),
          })

          yield* handleAggregateCommand(
            AggregateId.make("cart-rb-A"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-rb-A"),
              itemId: ItemId.make("item-A"),
              quantity: PositiveInt.make(3),
            },
            CommandId.make("cmd-rb-A"),
            cartAggregateWithOutboxConfig,
          )

          yield* handleAggregateCommand(
            AggregateId.make("cart-rb-B"),
            {
              _tag: "AddItem",
              cartId: CartId.make("cart-rb-B"),
              itemId: ItemId.make("item-B"),
              quantity: PositiveInt.make(7),
            },
            CommandId.make("cmd-rb-B"),
            cartAggregateWithOutboxConfig,
          )

          yield* drainAggregateOutbox(bus)
          // Deliver cart-rb-A out of order (v2 before v1) and cart-rb-B in order
          yield* ingestPublishedEvent(at(published, 1), [openCartsProjection])
          yield* ingestPublishedEvent(at(published, 0), [openCartsProjection])
          yield* ingestPublishedEvent(at(published, 2), [openCartsProjection])
          yield* ingestPublishedEvent(at(published, 3), [openCartsProjection])

          const liveReport = yield* queryOpenCarts
          expect(liveReport.carts.length).toBe(2)

          const sql = yield* SqlClient
          const liveCheckpoints = yield* sql<{
            aggregate_id: string
            last_stream_version: number
            updated_at: number
          }>`
            SELECT aggregate_id, last_stream_version, updated_at
            FROM es_projection_checkpoints
            WHERE processor_id = 'open-carts-v1'
            ORDER BY aggregate_id ASC
          `

          yield* rebuildProjectorFromArchive(openCartsProjection)

          const rebuiltReport = yield* queryOpenCarts
          expect(rebuiltReport.carts).toEqual(liveReport.carts)

          const rebuiltCheckpoints = yield* sql<{
            aggregate_id: string
            last_stream_version: number
            updated_at: number
          }>`
            SELECT aggregate_id, last_stream_version, updated_at
            FROM es_projection_checkpoints
            WHERE processor_id = 'open-carts-v1'
            ORDER BY aggregate_id ASC
          `
          expect(rebuiltCheckpoints).toEqual(liveCheckpoints)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-4.6: rebuildProjectorFromArchive fails and rolls back when archive has a missing version gap or corrupt JSON",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-gap-archive', 1, 'cmd-1', 'CartCreated', '{"_tag":"CartCreated","cartId":"cart-gap-archive","version":1}', '{"aggregateId":"cart-gap-archive","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}', 1700000000000
            ), (
              'Cart', 'cart-gap-archive', 3, 'cmd-3', 'ItemAdded', '{"_tag":"ItemAdded","cartId":"cart-gap-archive","itemId":"item-1","quantity":1,"version":1}', '{"aggregateId":"cart-gap-archive","streamVersion":3,"commandId":"cmd-3","timestamp":1700000000000}', 1700000000000
            )
          `

          const rebuildGapErr = yield* Effect.flip(rebuildProjectorFromArchive(openCartsProjection))
          match(rebuildGapErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.processorId).toBe("open-carts-v1")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError")
            })

          yield* sql`DELETE FROM es_event_archive`
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-corrupt-archive', 1, 'cmd-1', 'CartCreated', '{invalid-json', '{"aggregateId":"cart-corrupt-archive","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}', 1700000000000
            )
          `

          const rebuildJsonErr = yield* Effect.flip(
            rebuildProjectorFromArchive(openCartsProjection),
          )
          match(rebuildJsonErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateId).toBe("cart-corrupt-archive")
            })
            .otherwise(() => {
              expect.unreachable(
                "expected ProjectionArchiveCorruptionError for corrupt archive JSON",
              )
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-4.3 & REQ-4.4: queryCrossProjection returns read model or fails with CrossProjectionNotFoundError",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable

          const report = yield* queryCrossProjection(
            [openCartsProjection],
            ProcessorId.make("open-carts-v1"),
            undefined,
          )
          expect(report.carts.length).toBe(0)

          const notFoundErr = yield* Effect.flip(
            queryCrossProjection(
              [openCartsProjection],
              ProcessorId.make("unknown-processor"),
              undefined,
            ),
          )
          match(notFoundErr)
            .with(P.instanceOf(CrossProjectionNotFoundError), (err) => {
              expect(err.processorId).toBe("unknown-processor")
            })
            .otherwise(() => {
              expect.unreachable("expected CrossProjectionNotFoundError")
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )
  })

  describe("Group 4: Hardened Guards and Reviewer Edge Cases (F-1, F-2, F-3.1 - F-3.6, F-7)", () => {
    it.effect(
      "F-1: running initializeProjectorTables before initializeAggregateTables on the same SQLite DB isolates migration tables",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* initializeProjectorTables()
          yield* initializeAggregateTables()

          const projMigrations = yield* sql<{ migration_id: number; name: string }>`
            SELECT migration_id, name FROM es_projector_sql_migrations ORDER BY migration_id ASC
          `
          const aggMigrations = yield* sql<{ migration_id: number; name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
          `
          expect(
            projMigrations.some(
              (m) => m.migration_id === 1 && m.name === "init_es_projector_tables",
            ),
          ).toBe(true)
          expect(
            aggMigrations.some((m) => m.migration_id === 1 && m.name === "init_es_core_tables"),
          ).toBe(true)

          yield* sql`SELECT id FROM es_event_archive LIMIT 1`
          yield* sql`SELECT processor_id FROM es_projection_checkpoints LIMIT 1`
          yield* sql`SELECT processor_id FROM es_projection_gaps LIMIT 1`
          yield* sql`SELECT id FROM es_events LIMIT 1`
          yield* sql`SELECT command_id FROM es_commands LIMIT 1`
          yield* sql`SELECT id FROM es_outbox LIMIT 1`
          yield* sql`SELECT aggregate_id FROM es_projections_meta LIMIT 1`
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-2: fractional stream_version (1.5) in SQLite fails with typed ProjectionArchiveCorruptionError instead of defect",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const cartId = AggregateId.make("cart-frac")
          const env = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: cartId,
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-frac","version":1}',
            ),
            metadata: new EventMetadata({
              aggregateId: cartId,
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          })

          // 1. Corrupt checkpoint last_stream_version = 1.5 -> ingestPublishedEvent fails
          yield* sql`
            INSERT INTO es_projection_checkpoints (
              processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-frac', 1.5, 1700000000000
            )
          `
          const ingestCpErr = yield* Effect.flip(ingestPublishedEvent(env, [openCartsProjection]))
          match(ingestCpErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable(
                "expected ProjectionArchiveCorruptionError for fractional checkpoint",
              )
            })

          // 2. Corrupt gap stream_version = 1.5 -> ingestPublishedEvent fails
          yield* sql`DELETE FROM es_projection_checkpoints`
          yield* sql`
            INSERT INTO es_projection_gaps (
              processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-frac', 1.5, 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-frac","version":1}',
              '{"aggregateId":"cart-frac","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `
          const ingestGapErr = yield* Effect.flip(ingestPublishedEvent(env, [openCartsProjection]))
          match(ingestGapErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for fractional gap")
            })

          // 3. Corrupt archive stream_version = 1.5 -> rebuildProjectorFromArchive fails
          yield* sql`DELETE FROM es_projection_gaps`
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-frac', 1.5, 'cmd-1', 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-frac","version":1}',
              '{"aggregateId":"cart-frac","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `
          const rebuildErr = yield* Effect.flip(rebuildProjectorFromArchive(openCartsProjection))
          match(rebuildErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable(
                "expected ProjectionArchiveCorruptionError for fractional archive version",
              )
            })

          // 4. Corrupt checkpoint last_stream_version = 1.5 -> checkProjectorCatchUp fails
          yield* sql`DELETE FROM es_event_archive`
          yield* sql`
            INSERT INTO es_projection_checkpoints (
              processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-frac', 1.5, 1700000000000
            )
          `
          const catchUpErr = yield* Effect.flip(
            checkProjectorCatchUp(ProcessorId.make("open-carts-v1"), AggregateName.make("Cart")),
          )
          match(catchUpErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
              expect(err.reason).toContain("Invalid checkpoint last_stream_version")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError for catch-up check")
            })

          // 5. Corrupt archive stream_version = 1.5 with clean checkpoints -> checkProjectorCatchUp fails on archive head
          yield* sql`DELETE FROM es_projection_checkpoints`
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-frac', 1.5, 'cmd-1', 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-frac","version":1}',
              '{"aggregateId":"cart-frac","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `
          const catchUpHeadErr = yield* Effect.flip(
            checkProjectorCatchUp(ProcessorId.make("open-carts-v1"), AggregateName.make("Cart")),
          )
          match(catchUpHeadErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
              expect(err.reason).toContain("Invalid archive head max_version")
            })
            .otherwise(() => {
              expect.unreachable(
                "expected ProjectionArchiveCorruptionError for fractional archive head in catch-up",
              )
            })

          // 6. Corrupt gap stream_version = 1.5 with valid archive and checkpoint -> checkProjectorCatchUp fails on gap row
          yield* sql`DELETE FROM es_event_archive`
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-frac', 1, 'cmd-1', 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-frac","version":1}',
              '{"aggregateId":"cart-frac","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `
          yield* sql`
            INSERT INTO es_projection_checkpoints (
              processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-frac', 1, 1700000000000
            )
          `
          yield* sql`
            INSERT INTO es_projection_gaps (
              processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-frac', 1.5, 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-frac","itemId":"apple","quantity":1,"version":1}',
              '{"aggregateId":"cart-frac","streamVersion":2,"commandId":"cmd-2","timestamp":1700000000010}',
              1700000000010
            )
          `
          const catchUpGapErr = yield* Effect.flip(
            checkProjectorCatchUp(ProcessorId.make("open-carts-v1"), AggregateName.make("Cart")),
          )
          match(catchUpGapErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (err) => {
              expect(err.aggregateName).toBe("Cart")
              expect(err.reason).toContain("Invalid gap stream_version")
            })
            .otherwise(() => {
              expect.unreachable(
                "expected ProjectionArchiveCorruptionError for fractional gap version in catch-up",
              )
            })
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.1: metadata identity mismatch in outbox row (aggregateId or streamVersion) fails with EventStreamCorruptionError, publish called 0 times, row remains in outbox",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          const sql = yield* SqlClient

          let publishCalls = 0
          const bus = EventBus.make({
            publish: () =>
              Effect.sync(() => {
                publishCalls += 1
              }),
          })

          // 1. Mismatched metadata.aggregateId
          yield* sql`
            INSERT INTO es_outbox (
              aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', 'cart-1', 1, 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-1","version":1}',
              '{"aggregateId":"cart-OTHER","streamVersion":1,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `

          const errAggId = yield* Effect.flip(drainAggregateOutbox(bus))
          match(errAggId)
            .with(P.instanceOf(EventStreamCorruptionError), (e) => {
              expect(e.aggregateName).toBe("Cart")
            })
            .otherwise(() => {
              expect.unreachable("expected EventStreamCorruptionError for aggregateId mismatch")
            })

          expect(publishCalls).toBe(0)
          const remainingAfterAggId = yield* sql<{ id: number }>`SELECT id FROM es_outbox`
          expect(remainingAfterAggId.length).toBe(1)

          // 2. Mismatched metadata.streamVersion
          yield* sql`DELETE FROM es_outbox`
          yield* sql`
            INSERT INTO es_outbox (
              aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', 'cart-1', 1, 'CartCreated',
              '{"_tag":"CartCreated","cartId":"cart-1","version":1}',
              '{"aggregateId":"cart-1","streamVersion":2,"commandId":"cmd-1","timestamp":1700000000000}',
              1700000000000
            )
          `

          const errVer = yield* Effect.flip(drainAggregateOutbox(bus))
          match(errVer)
            .with(P.instanceOf(EventStreamCorruptionError), (e) => {
              expect(e.aggregateName).toBe("Cart")
              expect(e.expectedStreamVersion).toBe(1)
              expect(e.actualStreamVersion).toBe(2)
            })
            .otherwise(() => {
              expect.unreachable("expected EventStreamCorruptionError for streamVersion mismatch")
            })

          expect(publishCalls).toBe(0)
          const remainingAfterVer = yield* sql<{ id: number }>`SELECT id FROM es_outbox`
          expect(remainingAfterVer.length).toBe(1)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.2: publish failure on non-last row deletes previously published rows and leaves failed and subsequent rows in outbox",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          const sql = yield* SqlClient

          yield* sql`
            INSERT INTO es_outbox (
              id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES
              (1, 'Cart', 'cart-stream', 1, 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"cart-stream","streamVersion":1,"commandId":"c1","timestamp":100}', 100),
              (2, 'Cart', 'cart-stream', 2, 'ItemAdded', '{"_tag":"ItemAdded"}', '{"aggregateId":"cart-stream","streamVersion":2,"commandId":"c2","timestamp":200}', 200),
              (3, 'Cart', 'cart-stream', 3, 'ItemAdded', '{"_tag":"ItemAdded"}', '{"aggregateId":"cart-stream","streamVersion":3,"commandId":"c3","timestamp":300}', 300)
          `

          const publishedVersions: Array<number> = []
          const bus = EventBus.make({
            publish: (env) => {
              publishedVersions.push(env.streamVersion)
              if (env.streamVersion === 2) {
                return Effect.fail(
                  new OutboxPublishError({
                    aggregateName: env.aggregateName,
                    aggregateId: env.aggregateId,
                    streamVersion: env.streamVersion,
                    reason: ErrorMessage.make("Simulated network drop on version 2"),
                  }),
                )
              }
              return Effect.void
            },
          })

          const drainErr = yield* Effect.flip(drainAggregateOutbox(bus))
          match(drainErr)
            .with(P.instanceOf(OutboxPublishError), (e) => {
              expect(e.streamVersion).toBe(2)
            })
            .otherwise(() => {
              expect.unreachable("expected OutboxPublishError")
            })

          expect(publishedVersions).toEqual([1, 2])
          const remainingRows = yield* sql<{ id: number; stream_version: number }>`
            SELECT id, stream_version FROM es_outbox ORDER BY id ASC
          `
          expect(remainingRows.length).toBe(2)
          expect(remainingRows[0]?.stream_version).toBe(2)
          expect(remainingRows[1]?.stream_version).toBe(3)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-7: drainAggregateOutbox respects batchLimit with and without aggregateName filter",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          const sql = yield* SqlClient

          yield* sql`
            INSERT INTO es_outbox (
              id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at
            ) VALUES
              (1, 'Cart', 'c-1', 1, 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"c-1","streamVersion":1,"commandId":"c1","timestamp":100}', 100),
              (2, 'Cart', 'c-2', 1, 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"c-2","streamVersion":1,"commandId":"c2","timestamp":200}', 200),
              (3, 'Cart', 'c-3', 1, 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"c-3","streamVersion":1,"commandId":"c3","timestamp":300}', 300),
              (4, 'Order', 'o-1', 1, 'OrderPlaced', '{"_tag":"OrderPlaced"}', '{"aggregateId":"o-1","streamVersion":1,"commandId":"o1","timestamp":400}', 400),
              (5, 'Order', 'o-2', 1, 'OrderPlaced', '{"_tag":"OrderPlaced"}', '{"aggregateId":"o-2","streamVersion":1,"commandId":"o2","timestamp":500}', 500),
              (6, 'Order', 'o-3', 1, 'OrderPlaced', '{"_tag":"OrderPlaced"}', '{"aggregateId":"o-3","streamVersion":1,"commandId":"o3","timestamp":600}', 600)
          `

          const publishedIds: Array<string> = []
          const bus = EventBus.make({
            publish: (env) =>
              Effect.sync(() => {
                publishedIds.push(env.aggregateId)
              }),
          })

          // 1. Filtered by aggregateName = "Cart" with batchLimit = 2
          const firstDrain = yield* drainAggregateOutbox(
            bus,
            BatchLimit.make(2),
            AggregateName.make("Cart"),
          )
          match(firstDrain)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(2)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained")
            })
            .exhaustive()

          expect(publishedIds).toEqual(["c-1", "c-2"])

          const secondDrain = yield* drainAggregateOutbox(
            bus,
            BatchLimit.make(2),
            AggregateName.make("Cart"),
          )
          match(secondDrain)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(1)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained")
            })
            .exhaustive()

          expect(publishedIds).toEqual(["c-1", "c-2", "c-3"])

          // 2. Unfiltered (aggregateName omitted) with batchLimit = 2 over remaining 3 "Order" rows
          const thirdDrain = yield* drainAggregateOutbox(bus, BatchLimit.make(2))
          match(thirdDrain)
            .with({ _tag: "OutboxDrained" }, (d) => {
              expect(d.drainedCount).toBe(2)
            })
            .with({ _tag: "OutboxEmpty" }, () => {
              expect.unreachable("expected OutboxDrained for unfiltered batchLimit")
            })
            .exhaustive()

          expect(publishedIds).toEqual(["c-1", "c-2", "c-3", "o-1", "o-2"])

          const afterThird = yield* sql<{ aggregate_id: string }>`
            SELECT aggregate_id FROM es_outbox ORDER BY id ASC
          `
          expect(afterThird.map((r) => r.aggregate_id)).toEqual(["o-3"])
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.3: partial gap unblock and duplicate parked version delivery leaves higher gaps parked",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const cartId = AggregateId.make("cart-gap-chain")

          const makeEnv = (ver: number) =>
            new PublishedEventEnvelope({
              aggregateName: AggregateName.make("Cart"),
              aggregateId: cartId,
              streamVersion: StreamVersion.make(ver),
              eventType: EventType.make(ver === 1 ? "CartCreated" : "ItemAdded"),
              payload: SerializedPayload.make(
                ver === 1
                  ? '{"_tag":"CartCreated","cartId":"cart-gap-chain","version":1}'
                  : `{"_tag":"ItemAdded","cartId":"cart-gap-chain","itemId":"item-${ver}","quantity":1,"version":1}`,
              ),
              metadata: new EventMetadata({
                aggregateId: cartId,
                streamVersion: StreamVersion.make(ver),
                commandId: CommandId.make(`cmd-${ver}`),
                timestamp: TimestampMs.make(1700000000000 + ver),
              }),
            })

          // Ingest version 2 (parked)
          const d2 = yield* ingestPublishedEvent(makeEnv(2), [openCartsProjection])
          expect(d2[0]?._tag).toBe("ParkOutOfOrderEvent")

          // Ingest version 2 again (duplicate delivery while parked, ON CONFLICT DO NOTHING)
          const d2Dup = yield* ingestPublishedEvent(makeEnv(2), [openCartsProjection])
          expect(d2Dup[0]?._tag).toBe("ParkOutOfOrderEvent")

          // Ingest version 4 (parked)
          const d4 = yield* ingestPublishedEvent(makeEnv(4), [openCartsProjection])
          expect(d4[0]?._tag).toBe("ParkOutOfOrderEvent")

          const gapsBefore = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE aggregate_id = 'cart-gap-chain' ORDER BY stream_version ASC
          `
          expect(gapsBefore.map((g) => g.stream_version)).toEqual([2, 4])

          // Ingest version 1: applies [1, 2], advances checkpoint to 2, deletes 2 from gaps, leaves 4 parked
          const d1 = yield* ingestPublishedEvent(makeEnv(1), [openCartsProjection])
          match(d1[0])
            .with({ _tag: "ApplyContiguousEvents" }, (a) => {
              expect(a.versionsToApply).toEqual([1, 2])
              expect(a.newCheckpointVersion).toBe(2)
            })
            .otherwise(() => {
              expect.unreachable("expected ApplyContiguousEvents")
            })

          const checkpoints = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-gap-chain'
          `
          expect(checkpoints[0]?.last_stream_version).toBe(2)

          const gapsAfter = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE aggregate_id = 'cart-gap-chain' ORDER BY stream_version ASC
          `
          expect(gapsAfter.map((g) => g.stream_version)).toEqual([4])
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.4: multiple projections on the same aggregate isolate checkpoints, gaps, and archive rebuilds",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          let secondCount = 0
          const secondProjection = CrossAggregateProjection.make({
            processorId: ProcessorId.make("cart-audit-v1"),
            aggregateName: AggregateName.make("Cart"),
            eventSchema: CartEvent,
            model: OpenCartsReport,
            query: () => Effect.succeed(new OpenCartsReport({ carts: [] })),
            apply: () =>
              Effect.sync(() => {
                secondCount += 1
              }),
            purge: Effect.sync(() => {
              secondCount = 0
            }),
          })

          const cartId = AggregateId.make("cart-multi")
          const env1 = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: cartId,
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-multi","version":1}',
            ),
            metadata: new EventMetadata({
              aggregateId: cartId,
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          })

          yield* ingestPublishedEvent(env1, [openCartsProjection, secondProjection])

          // Park a gap for secondProjection
          yield* sql`
            INSERT INTO es_projection_gaps (
              processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
            ) VALUES (
              'cart-audit-v1', 'Cart', 'cart-multi', 3, 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-multi","itemId":"apple","quantity":1}',
              '{"aggregateId":"cart-multi","streamVersion":3,"commandId":"cmd-3","timestamp":1700000000030}',
              1700000000030
            )
          `

          // Call rebuildProjectorFromArchive for openCartsProjection
          yield* rebuildProjectorFromArchive(openCartsProjection)

          // Verify secondProjection's checkpoint and gap are completely untouched!
          const secondCp = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE processor_id = 'cart-audit-v1'
          `
          expect(secondCp.length).toBe(1)
          expect(secondCp[0]?.last_stream_version).toBe(1)

          const secondGaps = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE processor_id = 'cart-audit-v1'
          `
          expect(secondGaps.length).toBe(1)
          expect(secondGaps[0]?.stream_version).toBe(3)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.5: checkProjectorCatchUp returns Lagging when checkpoint is missing or trails archive head with zero gap rows",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          const sql = yield* SqlClient

          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES
              ('Cart', 'cart-trail', 1, 'c1', 'CartCreated', '{"_tag":"CartCreated"}', '{"aggregateId":"cart-trail","streamVersion":1,"commandId":"c1","timestamp":100}', 100),
              ('Cart', 'cart-trail', 2, 'c2', 'ItemAdded', '{"_tag":"ItemAdded"}', '{"aggregateId":"cart-trail","streamVersion":2,"commandId":"c2","timestamp":200}', 200)
          `

          const gapCount = yield* sql<{
            count: number
          }>`SELECT count(*) as count FROM es_projection_gaps`
          expect(gapCount[0]?.count).toBe(0)

          // 1. No checkpoint row exists at all -> Lagging with checkpointVersion = 0
          const statusMissingCp = yield* checkProjectorCatchUp(
            ProcessorId.make("open-carts-v1"),
            AggregateName.make("Cart"),
          )

          match(statusMissingCp)
            .with({ _tag: "Lagging" }, (l) => {
              expect(l.laggingAggregateId).toBe("cart-trail")
              expect(l.checkpointVersion).toBe(0)
              expect(l.archiveHeadVersion).toBe(2)
            })
            .with({ _tag: "CaughtUp" }, () => {
              expect.unreachable("expected Lagging status when checkpoint row is missing")
            })
            .exhaustive()

          // 2. Checkpoint row exists at version 1 (< archive head 2) -> Lagging with checkpointVersion = 1
          yield* sql`
            INSERT INTO es_projection_checkpoints (
              processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-trail', 1, 100
            )
          `

          const statusTrailingCp = yield* checkProjectorCatchUp(
            ProcessorId.make("open-carts-v1"),
            AggregateName.make("Cart"),
          )

          match(statusTrailingCp)
            .with({ _tag: "Lagging" }, (l) => {
              expect(l.laggingAggregateId).toBe("cart-trail")
              expect(l.checkpointVersion).toBe(1)
              expect(l.archiveHeadVersion).toBe(2)
            })
            .with({ _tag: "CaughtUp" }, () => {
              expect.unreachable("expected Lagging status")
            })
            .exhaustive()
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "F-3.6: failed rebuildProjectorFromArchive after purge and DELETE rolls back within sql.withTransaction and preserves live read model, checkpoints, and gaps",
      () =>
        Effect.gen(function* () {
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const cartId = AggregateId.make("cart-rollback")

          const env1 = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: cartId,
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make(
              '{"_tag":"CartCreated","cartId":"cart-rollback","version":1}',
            ),
            metadata: new EventMetadata({
              aggregateId: cartId,
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          })

          const env2 = new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: cartId,
            streamVersion: StreamVersion.make(2),
            eventType: EventType.make("ItemAdded"),
            payload: SerializedPayload.make(
              '{"_tag":"ItemAdded","cartId":"cart-rollback","itemId":"apple","quantity":3,"version":1}',
            ),
            metadata: new EventMetadata({
              aggregateId: cartId,
              streamVersion: StreamVersion.make(2),
              commandId: CommandId.make("cmd-2"),
              timestamp: TimestampMs.make(1700000000010),
            }),
          })

          yield* ingestPublishedEvent(env1, [openCartsProjection])
          yield* ingestPublishedEvent(env2, [openCartsProjection])

          // Also park a gap row for open-carts-v1 to verify DELETE FROM es_projection_gaps rolls back
          yield* sql`
            INSERT INTO es_projection_gaps (
              processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-rollback', 4, 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-rollback","itemId":"orange","quantity":1,"version":1}',
              '{"aggregateId":"cart-rollback","streamVersion":4,"commandId":"cmd-4","timestamp":1700000000020}',
              1700000000020
            )
          `

          const beforeReport = yield* queryOpenCarts
          expect(beforeReport.carts.length).toBe(1)
          expect(beforeReport.carts[0]?.totalQuantity).toBe(3)

          const beforeCp = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-rollback'
          `
          expect(beforeCp[0]?.last_stream_version).toBe(2)

          // 1. Mid-rebuild failure AFTER DELETE FROM es_projection_gaps, DELETE FROM es_projection_checkpoints,
          //    purgeOpenCarts (DELETE FROM projection_open_carts), and event 1 apply (INSERT total_quantity = 0) have executed!
          let purgeExecuted = false
          let firstEventApplied = false
          const failingMidRebuildProjection = CrossAggregateProjection.make({
            processorId: ProcessorId.make("open-carts-v1"),
            aggregateName: AggregateName.make("Cart"),
            eventSchema: CartEvent,
            model: OpenCartsReport,
            query: () => queryOpenCarts,
            purge: Effect.gen(function* () {
              yield* purgeOpenCarts
              purgeExecuted = true
            }),
            apply: (event, metadata) =>
              Effect.gen(function* () {
                if (metadata.streamVersion === 1) {
                  yield* applyOpenCarts(event, metadata)
                  firstEventApplied = true
                  return
                }
                yield* sql`INSERT INTO nonexistent_table_during_rebuild (id) VALUES (1)`.pipe(
                  Effect.asVoid,
                )
              }),
          })

          yield* Effect.flip(rebuildProjectorFromArchive(failingMidRebuildProjection))
          expect(purgeExecuted).toBe(true)
          expect(firstEventApplied).toBe(true)

          // Verify sql.withTransaction rolled back purgeOpenCarts, event 1 apply, checkpoint DELETE, and gap DELETE!
          const afterMidFailReport = yield* queryOpenCarts
          expect(afterMidFailReport.carts.length).toBe(1)
          expect(afterMidFailReport.carts[0]?.totalQuantity).toBe(3)

          const afterMidFailCp = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-rollback'
          `
          expect(afterMidFailCp.length).toBe(1)
          expect(afterMidFailCp[0]?.last_stream_version).toBe(2)

          const afterMidFailGaps = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_projection_gaps WHERE processor_id = 'open-carts-v1'
          `
          expect(afterMidFailGaps.length).toBe(1)
          expect(afterMidFailGaps[0]?.stream_version).toBe(4)

          // 2. Non-contiguous archive row (version 4) fails with ProjectionArchiveCorruptionError
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-rollback', 4, 'cmd-4', 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-rollback","itemId":"orange","quantity":1,"version":1}',
              '{"aggregateId":"cart-rollback","streamVersion":4,"commandId":"cmd-4","timestamp":1700000000020}',
              1700000000020
            )
          `

          const rebuildErr = yield* Effect.flip(rebuildProjectorFromArchive(openCartsProjection))
          match(rebuildErr)
            .with(P.instanceOf(ProjectionArchiveCorruptionError), (e) => {
              expect(e.aggregateId).toBe("cart-rollback")
            })
            .otherwise(() => {
              expect.unreachable("expected ProjectionArchiveCorruptionError")
            })

          const afterReport = yield* queryOpenCarts
          expect(afterReport.carts.length).toBe(1)
          expect(afterReport.carts[0]?.totalQuantity).toBe(3)

          const afterCp = yield* sql<{ last_stream_version: number }>`
            SELECT last_stream_version FROM es_projection_checkpoints WHERE aggregate_id = 'cart-rollback'
          `
          expect(afterCp[0]?.last_stream_version).toBe(2)
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect(
      "REQ-3.6: rejects metadata aggregateId or streamVersion mismatches during ingestion, parked gap drain, and archive rebuild",
      () =>
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          // 1. Envelope metadata mismatch during ingestPublishedEvent
          const badEnvelope: PublishedEventEnvelope = {
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-meta-bad"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("ItemAdded"),
            payload: SerializedPayload.make(
              '{"_tag":"ItemAdded","cartId":"cart-meta-bad","itemId":"apple","quantity":1,"version":1}',
            ),
            metadata: EventMetadata.make({
              aggregateId: AggregateId.make("other-cart"),
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-meta-1"),
              timestamp: TimestampMs.make(1700000000001),
            }),
          }
          const ingestErr = yield* Effect.flip(
            ingestPublishedEvent(badEnvelope, [openCartsProjection]),
          )
          expect(ingestErr._tag).toBe("ProjectionArchiveCorruptionError")
          expect(String(ingestErr.reason)).toContain(
            "Metadata aggregateId or streamVersion mismatch with envelope",
          )

          // 2. Parked gap metadata mismatch when draining contiguous gap v2 on arrival of v1
          yield* sql`
            INSERT INTO es_projection_gaps (
              processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
            ) VALUES (
              'open-carts-v1', 'Cart', 'cart-gap-bad', 2, 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-gap-bad","itemId":"apple","quantity":1,"version":1}',
              '{"aggregateId":"wrong-agg","streamVersion":2,"commandId":"cmd-g2","timestamp":1700000000002}',
              1700000000002
            )
          `
          const validFirstEnvelope = PublishedEventEnvelope.make({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-gap-bad"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("ItemAdded"),
            payload: SerializedPayload.make(
              '{"_tag":"ItemAdded","cartId":"cart-gap-bad","itemId":"apple","quantity":1,"version":1}',
            ),
            metadata: EventMetadata.make({
              aggregateId: AggregateId.make("cart-gap-bad"),
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-g1"),
              timestamp: TimestampMs.make(1700000000001),
            }),
          })
          const gapErr = yield* Effect.flip(
            ingestPublishedEvent(validFirstEnvelope, [openCartsProjection]),
          )
          expect(gapErr._tag).toBe("ProjectionArchiveCorruptionError")
          expect(String(gapErr.reason)).toContain("Parked gap metadata mismatch")

          // 3. Archive row metadata mismatch during rebuildProjectorFromArchive
          yield* sql`
            INSERT INTO es_event_archive (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
            ) VALUES (
              'Cart', 'cart-arch-bad', 1, 'cmd-a1', 'ItemAdded',
              '{"_tag":"ItemAdded","cartId":"cart-arch-bad","itemId":"pear","quantity":1,"version":1}',
              '{"aggregateId":"cart-arch-bad","streamVersion":99,"commandId":"cmd-a1","timestamp":1700000000003}',
              1700000000003
            )
          `
          const rebuildMetaErr = yield* Effect.flip(
            rebuildProjectorFromArchive(openCartsProjection),
          )
          expect(rebuildMetaErr._tag).toBe("ProjectionArchiveCorruptionError")
          expect(String(rebuildMetaErr.reason)).toContain(
            "Archive metadata mismatch with row columns",
          )
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )
  })
})
