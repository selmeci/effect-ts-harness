import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  AggregateCommandResult,
  AggregateId,
  AggregateName,
  CommandAggregateMismatchError,
  type CommandId,
  ConcurrencyConflictError,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  type OutboxPublicationMode,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  type AggregateConfig,
  applyLocalProjection,
  type HandledCommandResult,
  type HistoricalEvent,
  type LoadedAggregate,
  rebuildLocalProjection,
} from "@harness/es-core"
import { match } from "ts-pattern"

interface StoredEventRow {
  readonly aggregate_name: string
  readonly aggregate_id: string
  readonly stream_version: number
  readonly command_id: string
  readonly event_type: string
  readonly payload: string
  readonly metadata: string
  readonly created_at: number
}

interface CommandRow {
  readonly command_id: string
  readonly aggregate_name: string
  readonly aggregate_id: string
  readonly stream_version: number
  readonly result_json: string
  readonly created_at: number
}

interface ProjectionMetaRow {
  readonly aggregate_name: string
  readonly aggregate_id: string
  readonly projection_name: string
  readonly projection_version: number
  readonly last_stream_version: number
  readonly updated_at: number
}

interface MaxVersionRow {
  readonly max_version: number | null
}

const toErrorMessage = (cause: unknown): ErrorMessage => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const trimmed = raw.trim()
  return ErrorMessage.make(trimmed.length > 0 ? trimmed : "Schema validation failure")
}

const extractCauseText = (sqlErr: SqlError): string => {
  const nestedCause = sqlErr.reason.cause
  const causeMsg = nestedCause instanceof Error ? nestedCause.message : String(nestedCause)
  return `${sqlErr.message} ${sqlErr.reason.message ?? ""} ${causeMsg}`
}

const isEventStreamUniqueConflict = (sqlErr: SqlError): boolean =>
  match(sqlErr.reason)
    .with(
      { _tag: "UniqueViolation" },
      (r) => r.constraint.includes("es_events") || extractCauseText(sqlErr).includes("es_events"),
    )
    .with({ _tag: "ConstraintError" }, { _tag: "UnknownError" }, () => {
      const errMsg = extractCauseText(sqlErr)
      return errMsg.includes("UNIQUE constraint failed") && errMsg.includes("es_events")
    })
    .with(
      { _tag: "ConnectionError" },
      { _tag: "AuthenticationError" },
      { _tag: "AuthorizationError" },
      { _tag: "SqlSyntaxError" },
      { _tag: "DeadlockError" },
      { _tag: "SerializationError" },
      { _tag: "LockTimeoutError" },
      { _tag: "StatementTimeoutError" },
      () => false,
    )
    .exhaustive()

export { isEventStreamUniqueConflict }

export const aggregateCoreMigrations: Readonly<
  Record<string, Effect.Effect<void, SqlError, SqlClient>>
> = {
  "1_init_es_core_tables": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        command_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(aggregate_name, aggregate_id, stream_version)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_commands (
        command_id TEXT PRIMARY KEY,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_projections_meta (
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        projection_name TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        last_stream_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (aggregate_name, aggregate_id, projection_name)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  }),
}

export const initializeAggregateTables = Effect.fn("AggregateInfra.initTables")(function* (
  additionalMigrations?: Readonly<Record<string, Effect.Effect<void, SqlError, SqlClient>>>,
) {
  return yield* SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord({
      ...aggregateCoreMigrations,
      ...additionalMigrations,
    }),
  })
})

const loadAggregateInTx = <Command, Event, State, Err, ProjectionEnv, ProjectionErr>(
  aggregateId: AggregateId,
  config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
): Effect.Effect<
  LoadedAggregate<State>,
  EventStreamCorruptionError | ProjectionErr | SqlError,
  SqlClient | ProjectionEnv
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient

    const rows = yield* sql<StoredEventRow>`
      SELECT aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
      FROM es_events
      WHERE aggregate_name = ${config.aggregateName} AND aggregate_id = ${aggregateId}
      ORDER BY stream_version ASC
    `

    let currentState: State = config.decider.initialState
    let currentVersion = StreamVersion.make(0)
    const historicalEvents: Array<HistoricalEvent<Event>> = []

    const eventJsonSchema = Schema.fromJsonString(config.eventSchema)
    const metadataJsonSchema = Schema.fromJsonString(EventMetadata)

    let expectedSeq = 1
    for (const row of rows) {
      const expectedStreamVersion = StreamVersion.make(expectedSeq)
      const decodedRowVersionOpt = Schema.decodeOption(StreamVersion)(row.stream_version)
      const actualRowVersion = match(decodedRowVersionOpt)
        .with({ _tag: "Some" }, (v) => v.value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (actualRowVersion !== expectedStreamVersion) {
        return yield* new EventStreamCorruptionError({
          aggregateName: config.aggregateName,
          aggregateId,
          expectedStreamVersion,
          actualStreamVersion: actualRowVersion,
          reason: ErrorMessage.make(
            `Expected contiguous stream_version ${String(expectedSeq)} but found ${String(row.stream_version)}`,
          ),
        })
      }

      const event = yield* Schema.decodeEffect(eventJsonSchema)(row.payload).pipe(
        Effect.mapError(
          (cause) =>
            new EventStreamCorruptionError({
              aggregateName: config.aggregateName,
              aggregateId,
              expectedStreamVersion,
              actualStreamVersion: actualRowVersion,
              reason: toErrorMessage(cause),
            }),
        ),
      )
      const metadata = yield* Schema.decodeEffect(metadataJsonSchema)(row.metadata).pipe(
        Effect.mapError(
          (cause) =>
            new EventStreamCorruptionError({
              aggregateName: config.aggregateName,
              aggregateId,
              expectedStreamVersion,
              actualStreamVersion: actualRowVersion,
              reason: toErrorMessage(cause),
            }),
        ),
      )

      if (
        metadata.aggregateId !== aggregateId ||
        metadata.streamVersion !== expectedStreamVersion
      ) {
        return yield* new EventStreamCorruptionError({
          aggregateName: config.aggregateName,
          aggregateId,
          expectedStreamVersion,
          actualStreamVersion: metadata.streamVersion,
          reason: ErrorMessage.make(
            "Stored event metadata identity or streamVersion does not match row",
          ),
        })
      }

      currentState = config.decider.evolve(currentState, event)
      currentVersion = expectedStreamVersion
      historicalEvents.push({ event, metadata })
      expectedSeq += 1
    }

    if (config.projections !== undefined && config.projections.length > 0) {
      for (const projection of config.projections) {
        const metaRows = yield* sql<ProjectionMetaRow>`
          SELECT aggregate_name, aggregate_id, projection_name, projection_version, last_stream_version, updated_at
          FROM es_projections_meta
          WHERE aggregate_name = ${config.aggregateName}
            AND aggregate_id = ${aggregateId}
            AND projection_name = ${projection.name}
        `
        const storedMeta = metaRows[0]
        const needsRebuild =
          storedMeta === undefined
            ? currentVersion > 0
            : storedMeta.projection_version !== projection.version ||
              storedMeta.last_stream_version !== currentVersion

        if (needsRebuild) {
          yield* rebuildLocalProjection(projection, aggregateId, historicalEvents)
          const nowMs = yield* Clock.currentTimeMillis
          const now = TimestampMs.make(nowMs)
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
              ${currentVersion},
              ${now}
            )
            ON CONFLICT (aggregate_name, aggregate_id, projection_name) DO UPDATE SET
              projection_version = excluded.projection_version,
              last_stream_version = excluded.last_stream_version,
              updated_at = excluded.updated_at
          `
        }
      }
    }

    const loaded: LoadedAggregate<State> = {
      state: currentState,
      currentVersion,
    }
    return loaded
  })

export const loadAggregate = Effect.fn("Aggregate.load")(function* <
  Command,
  Event,
  State,
  Err,
  ProjectionEnv = never,
  ProjectionErr = never,
>(
  aggregateId: AggregateId,
  config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
) {
  const sql = yield* SqlClient
  return yield* sql.withTransaction(loadAggregateInTx(aggregateId, config))
})

export const handleAggregateCommand = Effect.fn("Aggregate.handleCommand")(function* <
  Command,
  Event,
  State,
  Err,
  ProjectionEnv = never,
  ProjectionErr = never,
>(
  aggregateId: AggregateId,
  command: Command,
  commandId: CommandId,
  config: AggregateConfig<Command, Event, State, Err, ProjectionEnv, ProjectionErr>,
) {
  const sql = yield* SqlClient
  const commandResultJsonSchema = Schema.fromJsonString(AggregateCommandResult)
  const eventJsonSchema = Schema.fromJsonString(config.eventSchema)
  const metadataJsonSchema = Schema.fromJsonString(EventMetadata)
  const outboxMode: OutboxPublicationMode = config.outboxMode

  const txEffect = Effect.gen(function* () {
    const existingCommands = yield* sql<CommandRow>`
        SELECT command_id, aggregate_name, aggregate_id, stream_version, result_json, created_at
        FROM es_commands
        WHERE command_id = ${commandId}
      `
    const cachedCommand = existingCommands[0]
    if (cachedCommand !== undefined) {
      const decodedNameOpt = Schema.decodeOption(AggregateName)(cachedCommand.aggregate_name)
      const decodedIdOpt = Schema.decodeOption(AggregateId)(cachedCommand.aggregate_id)
      const decodedVersionOpt = Schema.decodeOption(StreamVersion)(cachedCommand.stream_version)
      const actualCachedVersion = match(decodedVersionOpt)
        .with({ _tag: "Some" }, (v) => v.value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      const cachedIdentity = yield* match({
        nameOpt: decodedNameOpt,
        idOpt: decodedIdOpt,
        versionOpt: decodedVersionOpt,
      })
        .with(
          {
            nameOpt: { _tag: "Some" },
            idOpt: { _tag: "Some" },
            versionOpt: { _tag: "Some" },
          },
          ({ idOpt, nameOpt, versionOpt }) =>
            Effect.succeed({
              actualName: nameOpt.value,
              actualId: idOpt.value,
              storedVersion: versionOpt.value,
            }),
        )
        .with(
          { nameOpt: { _tag: "None" } },
          { idOpt: { _tag: "None" } },
          { versionOpt: { _tag: "None" } },
          () =>
            Effect.fail(
              new EventStreamCorruptionError({
                aggregateName: config.aggregateName,
                aggregateId,
                expectedStreamVersion: StreamVersion.make(0),
                actualStreamVersion: actualCachedVersion,
                reason: ErrorMessage.make("Corrupt identity or stream_version in es_commands"),
              }),
            ),
        )
        .exhaustive()

      if (
        cachedIdentity.actualName !== config.aggregateName ||
        cachedIdentity.actualId !== aggregateId
      ) {
        return yield* new CommandAggregateMismatchError({
          commandId,
          expectedAggregateName: config.aggregateName,
          expectedAggregateId: aggregateId,
          actualAggregateName: cachedIdentity.actualName,
          actualAggregateId: cachedIdentity.actualId,
        })
      }

      const storedResult = yield* Schema.decodeEffect(commandResultJsonSchema)(
        cachedCommand.result_json,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EventStreamCorruptionError({
              aggregateName: config.aggregateName,
              aggregateId,
              expectedStreamVersion: cachedIdentity.storedVersion,
              actualStreamVersion: cachedIdentity.storedVersion,
              reason: toErrorMessage(cause),
            }),
        ),
      )

      if (storedResult.nextExpectedStreamVersion !== cachedIdentity.storedVersion) {
        return yield* new EventStreamCorruptionError({
          aggregateName: config.aggregateName,
          aggregateId,
          expectedStreamVersion: cachedIdentity.storedVersion,
          actualStreamVersion: storedResult.nextExpectedStreamVersion,
          reason: ErrorMessage.make(
            "Stored command result_json nextExpectedStreamVersion does not match es_commands.stream_version",
          ),
        })
      }

      const loaded = yield* loadAggregateInTx(aggregateId, config)
      const deduplicatedResult = new AggregateCommandResult({
        nextExpectedStreamVersion: storedResult.nextExpectedStreamVersion,
        creationStatus: storedResult.creationStatus,
        processingStatus: { _tag: "Deduplicated" },
      })
      const handledDeduplicated: HandledCommandResult<State, Event> = {
        state: loaded.state,
        events: [],
        result: deduplicatedResult,
      }
      return handledDeduplicated
    }

    const loaded = yield* loadAggregateInTx(aggregateId, config)
    const currentVersion = loaded.currentVersion
    const currentState = loaded.state

    const events = yield* config.decider.decide(command, currentState)

    if (events.length === 0) {
      const nowMs = yield* Clock.currentTimeMillis
      const now = TimestampMs.make(nowMs)
      const noOpCreationStatus =
        currentVersion === 0
          ? ({ _tag: "NoStream" } as const)
          : ({ _tag: "ExistingStream" } as const)
      const noOpResult = new AggregateCommandResult({
        nextExpectedStreamVersion: currentVersion,
        creationStatus: noOpCreationStatus,
        processingStatus: { _tag: "Processed" },
      })
      const noOpResultJson = yield* Schema.encodeEffect(commandResultJsonSchema)(noOpResult).pipe(
        Effect.mapError(
          (cause) =>
            new EventSerializationError({
              aggregateName: config.aggregateName,
              aggregateId,
              streamVersion: currentVersion,
              reason: toErrorMessage(cause),
            }),
        ),
      )
      yield* sql`
          INSERT INTO es_commands (
            command_id, aggregate_name, aggregate_id, stream_version, result_json, created_at
          ) VALUES (
            ${commandId}, ${config.aggregateName}, ${aggregateId}, ${currentVersion}, ${noOpResultJson}, ${now}
          )
        `
      const handledNoOp: HandledCommandResult<State, Event> = {
        state: currentState,
        events: [],
        result: noOpResult,
      }
      return handledNoOp
    }

    const nextExpectedStreamVersion = StreamVersion.make(currentVersion + events.length)
    const creationStatus =
      currentVersion === 0
        ? ({ _tag: "CreatedStream" } as const)
        : ({ _tag: "ExistingStream" } as const)
    const commandResult = new AggregateCommandResult({
      nextExpectedStreamVersion,
      creationStatus,
      processingStatus: { _tag: "Processed" },
    })

    let activeState = currentState
    let eventVersion = currentVersion

    for (const event of events) {
      eventVersion = StreamVersion.make(eventVersion + 1)
      activeState = config.decider.evolve(activeState, event)
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
            const headRows = yield* sql<MaxVersionRow>`
                SELECT MAX(stream_version) as max_version
                FROM es_events
                WHERE aggregate_name = ${config.aggregateName} AND aggregate_id = ${aggregateId}
              `
            const maxVerOpt = Schema.decodeUnknownOption(StreamVersion)(headRows[0]?.max_version)
            return yield* match(maxVerOpt)
              .with({ _tag: "Some" }, ({ value: actualHead }) =>
                Effect.fail(
                  new ConcurrencyConflictError({
                    aggregateId,
                    expectedVersion: currentVersion,
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
                      `Corrupt max(stream_version) in es_events: ${String(headRows[0]?.max_version)}`,
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

      yield* match(outboxMode)
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

    const nowMs = yield* Clock.currentTimeMillis
    const now = TimestampMs.make(nowMs)
    const commandResultJson = yield* Schema.encodeEffect(commandResultJsonSchema)(
      commandResult,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new EventSerializationError({
            aggregateName: config.aggregateName,
            aggregateId,
            streamVersion: nextExpectedStreamVersion,
            reason: toErrorMessage(cause),
          }),
      ),
    )
    yield* sql`
        INSERT INTO es_commands (
          command_id, aggregate_name, aggregate_id, stream_version, result_json, created_at
        ) VALUES (
          ${commandId},
          ${config.aggregateName},
          ${aggregateId},
          ${nextExpectedStreamVersion},
          ${commandResultJson},
          ${now}
        )
      `

    const handled: HandledCommandResult<State, Event> = {
      state: activeState,
      events,
      result: commandResult,
    }
    return handled
  })

  return yield* sql.withTransaction(txEffect)
})
