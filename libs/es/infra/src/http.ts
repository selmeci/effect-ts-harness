import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  type AggregateId,
  type AggregateNotFoundError,
  type CommandAggregateMismatchError,
  CommandId,
  ConcurrencyConflictError,
  type CrossProjectionNotFoundError,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  EventType,
  type LocalProjectionNotFoundError,
  type ProcessorId,
  type ProjectionName,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  type AggregateConfig,
  applyLocalProjection,
  type CrossAggregateProjection,
  type HandledCommandResult,
  type LocalProjection,
  queryCrossProjection,
  queryLocalProjection,
} from "@harness/es-core"
import { match, P } from "ts-pattern"
import { handleAggregateCommand, isEventStreamUniqueConflict, loadAggregate } from "./aggregate.js"
import { relayAggregateOutbox } from "./outbox.js"

export { relayAggregateOutbox }

interface MaxVersionRow {
  readonly max_version: number | null
}

const formatErrorCause = (cause: unknown): ErrorMessage => {
  if (cause instanceof Error) {
    const trimmed = cause.message.trim()
    return ErrorMessage.make(trimmed.length > 0 ? trimmed : cause.name || "Error")
  }
  const raw = String(cause).trim()
  return ErrorMessage.make(raw.length > 0 ? raw : "Schema validation failure")
}

/**
 * Seeds a stream of historical domain events into `es_events` within a single SQLite transaction,
 * synchronously updating local same-DO projections (`es_projections_meta`) and `es_outbox` according
 * to `config.outboxMode`.
 *
 * Designed for test fixtures (`makeAggregateApiTestHarness`) and deterministic state setup.
 */
export const seedAggregateStream = Effect.fn("AggregateHttp.seedStream")(
  function* <Command, Event, State, Err, ProjectionEnv = never, ProjectionErr = never>(
    aggregateId: AggregateId,
    events: ReadonlyArray<Event>,
    config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
    seedCommandPrefix?: CommandId,
  ): Effect.fn.Return<
    StreamVersion,
    | EventSerializationError
    | EventStreamCorruptionError
    | ConcurrencyConflictError
    | ProjectionErr
    | SqlError,
    SqlClient | ProjectionEnv
  > {
    const sql = yield* SqlClient
    const eventJsonSchema = Schema.fromJsonString(config.eventSchema)
    const metadataJsonSchema = Schema.fromJsonString(EventMetadata)

    return yield* sql.withTransaction(
      Effect.gen(function* () {
          const headRows = yield* sql<MaxVersionRow>`
            SELECT MAX(stream_version) as max_version
            FROM es_events
            WHERE aggregate_name = ${config.aggregateName} AND aggregate_id = ${aggregateId}
          `
          const maxRaw = headRows[0]?.max_version
          let eventVersion: StreamVersion = yield* match(maxRaw)
            .with(null, undefined, () => Effect.succeed(StreamVersion.make(0)))
            .with(P.number, (rawNum) =>
              match(Schema.decodeOption(StreamVersion)(rawNum))
                .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                .with({ _tag: "None" }, () =>
                  Effect.fail(
                    new EventStreamCorruptionError({
                      aggregateName: config.aggregateName,
                      aggregateId,
                      expectedStreamVersion: StreamVersion.make(0),
                      reason: ErrorMessage.make(
                        `Corrupt max(stream_version) in es_events: ${String(rawNum)}`,
                      ),
                    }),
                  ),
                )
                .exhaustive(),
            )
            .exhaustive()

          if (events.length === 0) {
            return eventVersion
          }

          const prefix = seedCommandPrefix ?? CommandId.make("seed")

          for (let idx = 0; idx < events.length; idx++) {
            const event = events[idx]!
            const prevVersion = eventVersion
            eventVersion = StreamVersion.make(eventVersion + 1)
            const commandId = CommandId.make(`${prefix}-${aggregateId}-${eventVersion}`)
            const nowMs = yield* Clock.currentTimeMillis
            const now = TimestampMs.make(nowMs)
            const metadata = new EventMetadata({
              aggregateId,
              streamVersion: eventVersion,
              commandId,
              timestamp: now,
            })

            const rawTag =
              typeof event === "object" && event !== null && "_tag" in event
                ? event._tag
                : undefined
            const eventType = yield* Schema.decodeUnknownEffect(EventType)(rawTag).pipe(
              Effect.mapError(
                () =>
                  new EventSerializationError({
                    aggregateName: config.aggregateName,
                    aggregateId,
                    streamVersion: eventVersion,
                    reason: ErrorMessage.make("Missing or invalid _tag on seeded domain event"),
                  }),
              ),
            )

            const payloadJson = yield* Schema.encodeEffect(eventJsonSchema)(event).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSerializationError({
                    aggregateName: config.aggregateName,
                    aggregateId,
                    streamVersion: eventVersion,
                    reason: formatErrorCause(cause),
                  }),
              ),
            )
            const metadataJson = yield* Schema.encodeEffect(metadataJsonSchema)(metadata).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSerializationError({
                    aggregateName: config.aggregateName,
                    aggregateId,
                    streamVersion: eventVersion,
                    reason: formatErrorCause(cause),
                  }),
              ),
            )

            yield* sql`
              INSERT INTO es_events (
                aggregate_name,
                aggregate_id,
                stream_version,
                command_id,
                event_type,
                payload,
                metadata,
                created_at
              ) VALUES (
                ${config.aggregateName},
                ${aggregateId},
                ${eventVersion},
                ${commandId},
                ${eventType},
                ${payloadJson},
                ${metadataJson},
                ${now}
              )
            `.pipe(
              Effect.catchIf(isEventStreamUniqueConflict, () =>
                Effect.gen(function* () {
                  const conflictHeadRows = yield* sql<MaxVersionRow>`
                    SELECT MAX(stream_version) as max_version
                    FROM es_events
                    WHERE aggregate_name = ${config.aggregateName} AND aggregate_id = ${aggregateId}
                  `
                  const conflictRaw = conflictHeadRows[0]?.max_version
                  return yield* match(conflictRaw)
                    .with(P.number, (rawNum) =>
                      match(Schema.decodeOption(StreamVersion)(rawNum))
                        .with({ _tag: "Some" }, ({ value: actualHead }) =>
                          Effect.fail(
                            new ConcurrencyConflictError({
                              aggregateId,
                              expectedVersion: prevVersion,
                              actualVersion: actualHead,
                            }),
                          ),
                        )
                        .with({ _tag: "None" }, () =>
                          Effect.fail(
                            new EventStreamCorruptionError({
                              aggregateName: config.aggregateName,
                              aggregateId,
                              expectedStreamVersion: eventVersion,
                              reason: ErrorMessage.make(
                                `Corrupt max(stream_version) in es_events: ${String(rawNum)}`,
                              ),
                            }),
                          ),
                        )
                        .exhaustive(),
                    )
                    .with(null, undefined, () =>
                      Effect.fail(
                        new EventStreamCorruptionError({
                          aggregateName: config.aggregateName,
                          aggregateId,
                          expectedStreamVersion: eventVersion,
                          reason: ErrorMessage.make(
                            "Missing max(stream_version) during unique conflict resolution in es_events",
                          ),
                        }),
                      ),
                    )
                    .exhaustive()
                }),
              ),
            )

            if (config.projections !== undefined) {
              for (const projection of config.projections) {
                yield* applyLocalProjection(projection, event, metadata)
                yield* sql`
                  INSERT INTO es_projections_meta (
                    aggregate_name,
                    aggregate_id,
                    projection_name,
                    projection_version,
                    last_stream_version,
                    updated_at
                  ) VALUES (
                    ${config.aggregateName},
                    ${aggregateId},
                    ${projection.name},
                    ${projection.version},
                    ${eventVersion},
                    ${now}
                  )
                  ON CONFLICT (aggregate_name, aggregate_id, projection_name) DO UPDATE SET
                    projection_version = excluded.projection_version,
                    last_stream_version = excluded.last_stream_version,
                    updated_at = excluded.updated_at
                `
              }
            }

            yield* match(config.outboxMode)
              .with({ _tag: "PublishOutbox" }, () =>
                sql`
                  INSERT INTO es_outbox (
                    aggregate_name,
                    aggregate_id,
                    stream_version,
                    event_type,
                    payload,
                    metadata,
                    created_at
                  ) VALUES (
                    ${config.aggregateName},
                    ${aggregateId},
                    ${eventVersion},
                    ${eventType},
                    ${payloadJson},
                    ${metadataJson},
                    ${now}
                  )
                `.pipe(Effect.asVoid),
              )
              .with({ _tag: "SuppressOutbox" }, () => Effect.void)
              .exhaustive()
          }

          return eventVersion
        }),
      )
  },
)

/**
 * Executes an aggregate command via `handleAggregateCommand`, committing new events, local same-DO
 * projections, and `es_outbox` rows atomically in a single SQLite transaction.
 *
 * Strictly obeys the transactional outbox boundary (`harness(aggregate-direct-bus-publish)`): never
 * publishes to `EventBus` or drains `es_outbox` inline during command execution. Cross-aggregate
 * projections are updated asynchronously via `relayAggregateOutbox` (`Outbox.relay`).
 */
export const executeAggregateCommandAndSync = Effect.fn("AggregateHttp.executeCommand")(
  <Command, Event, State, Err, ProjectionEnv = never, ProjectionErr = never>(
    aggregateId: AggregateId,
    command: Command,
    commandId: CommandId,
    config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
  ): Effect.Effect<
    HandledCommandResult<State, Event>,
    | Err
    | CommandAggregateMismatchError
    | ConcurrencyConflictError
    | EventSerializationError
    | EventStreamCorruptionError
    | ProjectionErr
    | SqlError,
    SqlClient | ProjectionEnv
  > => handleAggregateCommand(aggregateId, command, commandId, config),
)

/**
 * Queries a local same-DO read model after verifying that the aggregate stream exists and its local
 * projections are caught up.
 */
export const queryAggregateReadModel = Effect.fn("AggregateHttp.queryLocal")(
  function* <Command, Event, State, Err, ReadModel, ProjectionEnv = never, ProjectionErr = never>(
    aggregateId: AggregateId,
    projectionName: ProjectionName,
    config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
    projections: ReadonlyArray<LocalProjection<Event, ReadModel, ProjectionEnv, ProjectionErr>>,
  ): Effect.fn.Return<
    ReadModel,
    | AggregateNotFoundError
    | LocalProjectionNotFoundError
    | EventStreamCorruptionError
    | ProjectionErr
    | SqlError,
    SqlClient | ProjectionEnv
  > {
    yield* loadAggregate(aggregateId, config)
    return yield* queryLocalProjection(projections, projectionName, aggregateId)
  },
)

/**
 * Queries a cross-aggregate read model by `processorId`.
 */
export const queryCrossAggregateReadModel = Effect.fn("AggregateHttp.queryCross")(
  <Event, ReadModel, QueryInput = void, ProjEnv = never, ProjErr = never>(
    processorId: ProcessorId,
    input: QueryInput,
    projections: ReadonlyArray<
      CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>
    >,
  ): Effect.Effect<ReadModel, CrossProjectionNotFoundError | ProjErr, ProjEnv> =>
    queryCrossProjection(projections, processorId, input),
)
