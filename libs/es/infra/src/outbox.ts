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
import { match } from "ts-pattern"

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
    const idOpt = Schema.decodeOption(OutboxRowId)(row.id)
    const aggNameOpt = Schema.decodeOption(AggregateName)(row.aggregate_name)
    const aggIdOpt = Schema.decodeOption(AggregateId)(row.aggregate_id)
    const posIntOpt = Schema.decodeOption(PositiveInt)(row.stream_version)
    const streamVerOpt = Schema.decodeOption(StreamVersion)(row.stream_version)
    const eventTypeOpt = Schema.decodeOption(EventType)(row.event_type)
    const payloadOpt = Schema.decodeOption(SerializedPayload)(row.payload)

    const fallbackAggName = match(aggNameOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => AggregateName.make("UnknownAggregate"))
      .exhaustive()
    const fallbackAggId = match(aggIdOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
      .exhaustive()
    const fallbackStreamVer = match(streamVerOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => StreamVersion.make(0))
      .exhaustive()

    const validatedStream = yield* match({
      idOpt,
      aggNameOpt,
      aggIdOpt,
      posIntOpt,
      streamVerOpt,
    })
      .with(
        {
          idOpt: { _tag: "Some" },
          aggNameOpt: { _tag: "Some" },
          aggIdOpt: { _tag: "Some" },
          posIntOpt: { _tag: "Some" },
          streamVerOpt: { _tag: "Some" },
        },
        ({
          idOpt: { value: outboxRowId },
          aggNameOpt: { value: aggName },
          aggIdOpt: { value: aggId },
          streamVerOpt: { value: streamVer },
        }) => Effect.succeed({ outboxRowId, aggName, aggId, streamVer }),
      )
      .with({ idOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventStreamCorruptionError({
            aggregateName: fallbackAggName,
            aggregateId: fallbackAggId,
            expectedStreamVersion: StreamVersion.make(1),
            actualStreamVersion: fallbackStreamVer,
            reason: ErrorMessage.make(`Invalid outbox id: ${String(row.id)}`),
          }),
        ),
      )
      .with({ aggNameOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventStreamCorruptionError({
            aggregateName: fallbackAggName,
            aggregateId: fallbackAggId,
            expectedStreamVersion: StreamVersion.make(1),
            actualStreamVersion: fallbackStreamVer,
            reason: ErrorMessage.make(
              `Invalid outbox aggregate_name: ${String(row.aggregate_name)}`,
            ),
          }),
        ),
      )
      .with({ aggIdOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventStreamCorruptionError({
            aggregateName: fallbackAggName,
            aggregateId: fallbackAggId,
            expectedStreamVersion: StreamVersion.make(1),
            actualStreamVersion: fallbackStreamVer,
            reason: ErrorMessage.make(`Invalid outbox aggregate_id: ${String(row.aggregate_id)}`),
          }),
        ),
      )
      .with({ posIntOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventStreamCorruptionError({
            aggregateName: fallbackAggName,
            aggregateId: fallbackAggId,
            expectedStreamVersion: StreamVersion.make(1),
            actualStreamVersion: fallbackStreamVer,
            reason: ErrorMessage.make(
              `Invalid outbox stream_version: ${String(row.stream_version)}`,
            ),
          }),
        ),
      )
      .with({ streamVerOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventStreamCorruptionError({
            aggregateName: fallbackAggName,
            aggregateId: fallbackAggId,
            expectedStreamVersion: StreamVersion.make(1),
            actualStreamVersion: fallbackStreamVer,
            reason: ErrorMessage.make(
              `Invalid outbox stream_version: ${String(row.stream_version)}`,
            ),
          }),
        ),
      )
      .exhaustive()

    const { outboxRowId, aggName, aggId, streamVer } = validatedStream

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

    const validatedEvent = yield* match({ eventTypeOpt, payloadOpt })
      .with(
        { eventTypeOpt: { _tag: "Some" }, payloadOpt: { _tag: "Some" } },
        ({ eventTypeOpt: { value: eventType }, payloadOpt: { value: payload } }) =>
          Effect.succeed({ eventType, payload }),
      )
      .with({ eventTypeOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventSerializationError({
            aggregateName: aggName,
            aggregateId: aggId,
            streamVersion: streamVer,
            reason: ErrorMessage.make("Empty or invalid event_type in outbox row"),
          }),
        ),
      )
      .with({ payloadOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new EventSerializationError({
            aggregateName: aggName,
            aggregateId: aggId,
            streamVersion: streamVer,
            reason: ErrorMessage.make("Empty or invalid payload in outbox row"),
          }),
        ),
      )
      .exhaustive()

    const { eventType, payload } = validatedEvent

    yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(payload).pipe(
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
      eventType,
      payload,
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
