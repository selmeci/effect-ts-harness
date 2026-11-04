import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  type AggregateId,
  type AggregateNotFoundError,
  CommandId,
  ConcurrencyConflictError,
  type CrossProjectionNotFoundError,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  type LocalProjectionNotFoundError,
  OutboxPublishError,
  type ProcessorId,
  ProjectionArchiveCorruptionError,
  type ProjectionName,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  type AggregateConfig,
  applyLocalProjection,
  type CrossAggregateProjection,
  EventBus,
  type LocalProjection,
  queryCrossProjection,
  queryLocalProjection,
} from "@harness/es-core"
import { match, P } from "ts-pattern"
import { handleAggregateCommand, isEventStreamUniqueConflict, loadAggregate } from "./aggregate.js"
import { DEFAULT_OUTBOX_BATCH_LIMIT, drainAggregateOutbox } from "./outbox.js"
import { ingestPublishedEvent } from "./projector.js"

interface MaxVersionRow {
  readonly max_version: number | null
}

const toErrorMessage = (cause: unknown): ErrorMessage => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const trimmed = raw.trim()
  return ErrorMessage.make(trimmed.length > 0 ? trimmed : "Schema validation failure")
}

export const seedAggregateStream = Effect.fn("AggregateHttp.seedStream")(
  <Command, Event, State, Err, ProjectionEnv = never, ProjectionErr = never>(
    aggregateId: AggregateId,
    events: ReadonlyArray<Event>,
    config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
    seedCommandPrefix?: CommandId,
  ): Effect.Effect<
    StreamVersion,
    | EventSerializationError
    | EventStreamCorruptionError
    | ConcurrencyConflictError
    | ProjectionErr
    | SqlError,
    SqlClient | ProjectionEnv
  > =>
    Effect.gen(function* () {
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
            const payloadJson = yield* Schema.encodeEffect(eventJsonSchema)(event).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSerializationError({
                    aggregateName: config.aggregateName,
                    aggregateId,
                    streamVersion: eventVersion,
                    reason: toErrorMessage(cause),
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
                    reason: toErrorMessage(cause),
                  }),
              ),
            )
            const eventType =
              typeof event === "object" &&
              event !== null &&
              "_tag" in event &&
              typeof event._tag === "string"
                ? event._tag
                : "Event"

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
    }),
)

export const executeAggregateCommandAndSync = Effect.fn("AggregateHttp.executeCommand")(function* <
  Command,
  Event,
  State,
  Err,
  ProjectionEnv = never,
  ProjectionErr = never,
  CrossReadModel = unknown,
  CrossQueryInput = void,
  CrossProjEnv = never,
  CrossProjErr = never,
>(
  aggregateId: AggregateId,
  command: Command,
  commandId: CommandId,
  config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
  crossProjections?: ReadonlyArray<
    CrossAggregateProjection<Event, CrossReadModel, CrossQueryInput, CrossProjEnv, CrossProjErr>
  >,
) {
  const handled = yield* handleAggregateCommand(aggregateId, command, commandId, config)

  yield* match(config.outboxMode)
    .with({ _tag: "PublishOutbox" }, () => {
      if (crossProjections === undefined || crossProjections.length === 0) {
        return Effect.void
      }
      return Effect.gen(function* () {
        let capturedArchiveError: ProjectionArchiveCorruptionError | undefined
        const bus = EventBus.make<SqlClient | CrossProjEnv>({
          publish: (envelope) =>
            ingestPublishedEvent(envelope, crossProjections).pipe(
              Effect.asVoid,
              Effect.mapError((cause) => {
                if (cause instanceof ProjectionArchiveCorruptionError) {
                  capturedArchiveError = cause
                }
                return new OutboxPublishError({
                  aggregateName: config.aggregateName,
                  aggregateId: envelope.aggregateId,
                  streamVersion: envelope.streamVersion,
                  reason: toErrorMessage(cause),
                })
              }),
            ),
        })
        return yield* drainAggregateOutbox(
          bus,
          DEFAULT_OUTBOX_BATCH_LIMIT,
          config.aggregateName,
        ).pipe(
          Effect.asVoid,
          Effect.mapError((err) =>
            err instanceof OutboxPublishError && capturedArchiveError !== undefined
              ? capturedArchiveError
              : err,
          ),
        )
      })
    })
    .with({ _tag: "SuppressOutbox" }, () => Effect.void)
    .exhaustive()

  return handled
})

export const queryAggregateReadModel = Effect.fn("AggregateHttp.queryLocal")(
  <Command, Event, State, Err, ReadModel, ProjectionEnv = never, ProjectionErr = never>(
    aggregateId: AggregateId,
    projectionName: ProjectionName,
    config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
    projections: ReadonlyArray<LocalProjection<Event, ReadModel, ProjectionEnv, ProjectionErr>>,
  ): Effect.Effect<
    ReadModel,
    | AggregateNotFoundError
    | LocalProjectionNotFoundError
    | EventStreamCorruptionError
    | ProjectionErr
    | SqlError,
    SqlClient | ProjectionEnv
  > =>
    Effect.gen(function* () {
      yield* loadAggregate(aggregateId, config)
      return yield* queryLocalProjection(projections, projectionName, aggregateId)
    }),
)

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
