import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AggregateId,
  AggregateName,
  BatchLimit,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  EventType,
  type OutboxDrainOutcome,
  OutboxPublishError,
  OutboxRowId,
  PositiveInt,
  PublishedEventEnvelope,
  SerializedPayload,
  StreamVersion,
} from "@harness/es-contract"
import type { EventBus } from "@harness/es-core"

export const DEFAULT_OUTBOX_BATCH_LIMIT: BatchLimit = BatchLimit.make(100)

interface OutboxRow {
  readonly id: number
  readonly aggregate_name: string
  readonly aggregate_id: string
  readonly stream_version: number
  readonly event_type: string
  readonly payload: string
  readonly metadata: string
  readonly created_at: number
}

export const drainAggregateOutbox = Effect.fn("Outbox.drain")(function* <BusEnv = never>(
  eventBus: EventBus<BusEnv>,
  batchLimit: BatchLimit = DEFAULT_OUTBOX_BATCH_LIMIT,
  aggregateName?: AggregateName,
) {
  const sql = yield* SqlClient

  const rows =
    aggregateName !== undefined
      ? yield* sql<OutboxRow>`
          SELECT
            id,
            aggregate_name,
            aggregate_id,
            stream_version,
            event_type,
            payload,
            metadata,
            created_at
          FROM es_outbox
          WHERE aggregate_name = ${aggregateName}
          ORDER BY id ASC
          LIMIT ${batchLimit}
        `
      : yield* sql<OutboxRow>`
          SELECT
            id,
            aggregate_name,
            aggregate_id,
            stream_version,
            event_type,
            payload,
            metadata,
            created_at
          FROM es_outbox
          ORDER BY id ASC
          LIMIT ${batchLimit}
        `

  if (rows.length === 0) {
    const emptyOutcome: OutboxDrainOutcome = { _tag: "OutboxEmpty" }
    return emptyOutcome
  }

  for (const row of rows) {
    const fallbackAggName = AggregateName.make(
      row.aggregate_name.length > 0 ? row.aggregate_name : "UnknownAggregate",
    )
    const fallbackAggId = AggregateId.make(
      row.aggregate_id.length > 0 ? row.aggregate_id : "unknown-id",
    )

    if (
      row.id <= 0 ||
      row.aggregate_name.length === 0 ||
      row.aggregate_id.length === 0 ||
      row.stream_version <= 0 ||
      !Number.isInteger(row.stream_version)
    ) {
      return yield* new EventStreamCorruptionError({
        aggregateName: fallbackAggName,
        aggregateId: fallbackAggId,
        expectedStreamVersion: StreamVersion.make(1),
        actualStreamVersion: StreamVersion.make(0),
        reason: ErrorMessage.make(`Invalid outbox row or stream_version: ${row.stream_version}`),
      })
    }

    const outboxRowId = OutboxRowId.make(row.id)
    const aggName = AggregateName.make(row.aggregate_name)
    const aggId = AggregateId.make(row.aggregate_id)
    const streamVer = StreamVersion.make(row.stream_version)

    const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(EventMetadata))(
      row.metadata,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new EventStreamCorruptionError({
            aggregateName: aggName,
            aggregateId: aggId,
            expectedStreamVersion: streamVer,
            actualStreamVersion: streamVer,
            reason: ErrorMessage.make(`Invalid outbox metadata JSON: ${String(cause)}`),
          }),
      ),
    )

    if (metadata.aggregateId !== aggId || metadata.streamVersion !== streamVer) {
      return yield* new EventStreamCorruptionError({
        aggregateName: aggName,
        aggregateId: aggId,
        expectedStreamVersion: streamVer,
        actualStreamVersion: metadata.streamVersion,
        reason: ErrorMessage.make(
          "Outbox row metadata mismatch with aggregate_id or stream_version",
        ),
      })
    }

    if (row.event_type.length === 0 || row.payload.length === 0) {
      return yield* new EventSerializationError({
        aggregateName: aggName,
        aggregateId: aggId,
        streamVersion: streamVer,
        reason: ErrorMessage.make("Empty event_type or payload in outbox row"),
      })
    }

    yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(row.payload).pipe(
      Effect.mapError(
        (cause) =>
          new EventSerializationError({
            aggregateName: aggName,
            aggregateId: aggId,
            streamVersion: streamVer,
            reason: ErrorMessage.make(`Invalid outbox payload JSON: ${String(cause)}`),
          }),
      ),
    )

    const envelope = new PublishedEventEnvelope({
      aggregateName: aggName,
      aggregateId: aggId,
      streamVersion: streamVer,
      eventType: EventType.make(row.event_type),
      payload: SerializedPayload.make(row.payload),
      metadata,
    })

    yield* eventBus.publish(envelope).pipe(
      Effect.mapError(
        (err) =>
          new OutboxPublishError({
            aggregateName: aggName,
            aggregateId: aggId,
            streamVersion: envelope.streamVersion,
            reason: err.reason,
          }),
      ),
    )

    yield* sql`DELETE FROM es_outbox WHERE id = ${outboxRowId}`
  }

  const drainedOutcome: OutboxDrainOutcome = {
    _tag: "OutboxDrained",
    drainedCount: PositiveInt.make(rows.length),
  }
  return drainedOutcome
})
