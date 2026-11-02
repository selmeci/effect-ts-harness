import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  AggregateCommandResult,
  type AggregateId,
  type AggregateName,
  type CommandId,
  ConcurrencyConflictError,
  EventMetadata,
  StreamVersion,
  TimestampMs
} from "@harness/es-contract"
import type { Decider } from "./decider.js"
import {
  applyLocalProjection,
  type HistoricalEvent,
  type LocalProjection,
  rebuildLocalProjection
} from "./projection.js"

export interface AggregateConfig<Command, Event, State, Err> {
  readonly aggregateName: AggregateName
  readonly decider: Decider<Command, Event, State, Err>
  readonly eventSchema: Schema.Codec<Event, unknown>
  readonly projections?: ReadonlyArray<LocalProjection<Event, unknown>> | undefined
  readonly publish?: boolean | undefined
}

export interface LoadedAggregate<State> {
  readonly state: State
  readonly currentVersion: StreamVersion
}

export interface HandledCommandResult<State, Event> {
  readonly state: State
  readonly events: ReadonlyArray<Event>
  readonly result: AggregateCommandResult
}

interface StoredEventRow {
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
  readonly aggregate_id: string
  readonly stream_version: number
  readonly result_json: string
  readonly created_at: number
}

interface ProjectionMetaRow {
  readonly aggregate_id: string
  readonly projection_name: string
  readonly projection_version: number
  readonly last_stream_version: number
  readonly updated_at: number
}

export const loadAggregate = Effect.fn("Aggregate.load")(
  function* <Command, Event, State, Err>(
    aggregateId: AggregateId,
    config: AggregateConfig<Command, Event, State, Err>
  ) {
    const sql = yield* SqlClient

    const rows = yield* sql<StoredEventRow>`
      SELECT aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
      FROM es_events
      WHERE aggregate_id = ${aggregateId}
      ORDER BY stream_version ASC
    `

    let currentState: State = config.decider.initialState
    let currentVersion = StreamVersion.make(0)
    const historicalEvents: Array<HistoricalEvent<Event>> = []

    const eventJsonSchema = Schema.fromJsonString(config.eventSchema)
    const metadataJsonSchema = Schema.fromJsonString(EventMetadata)

    for (const row of rows) {
      const event = yield* Schema.decodeEffect(eventJsonSchema)(row.payload).pipe(
        Effect.orDie
      )
      const metadata = yield* Schema.decodeEffect(metadataJsonSchema)(row.metadata).pipe(
        Effect.orDie
      )

      currentState = config.decider.evolve(currentState, event)
      currentVersion = StreamVersion.make(row.stream_version)
      historicalEvents.push({ event, metadata })
    }

    if (config.projections !== undefined && config.projections.length > 0) {
      for (const projection of config.projections) {
        const metaRows = yield* sql<ProjectionMetaRow>`
          SELECT aggregate_id, projection_name, projection_version, last_stream_version, updated_at
          FROM es_projections_meta
          WHERE aggregate_id = ${aggregateId} AND projection_name = ${projection.name}
        `
        const storedMeta = metaRows[0]
        const needsRebuild =
          storedMeta === undefined || storedMeta.projection_version < projection.version

        if (needsRebuild) {
          yield* rebuildLocalProjection(projection, historicalEvents)
          const nowMs = yield* Clock.currentTimeMillis
          const now = TimestampMs.make(nowMs)
          yield* sql`
            INSERT INTO es_projections_meta (
              aggregate_id,
              projection_name,
              projection_version,
              last_stream_version,
              updated_at
            ) VALUES (
              ${aggregateId},
              ${projection.name},
              ${projection.version},
              ${currentVersion},
              ${now}
            )
            ON CONFLICT (aggregate_id, projection_name) DO UPDATE SET
              projection_version = excluded.projection_version,
              last_stream_version = excluded.last_stream_version,
              updated_at = excluded.updated_at
          `
        }
      }
    }

    const loaded: LoadedAggregate<State> = {
      state: currentState,
      currentVersion
    }
    return loaded
  }
)

export const handleAggregateCommand = Effect.fn("Aggregate.handleCommand")(
  function* <Command, Event, State, Err>(
    aggregateId: AggregateId,
    command: Command,
    commandId: CommandId,
    config: AggregateConfig<Command, Event, State, Err>
  ) {
    const sql = yield* SqlClient
    const commandResultJsonSchema = Schema.fromJsonString(AggregateCommandResult)

    const existingCommands = yield* sql<CommandRow>`
      SELECT command_id, aggregate_id, stream_version, result_json, created_at
      FROM es_commands
      WHERE command_id = ${commandId}
    `
    const cachedCommand = existingCommands[0]
    if (cachedCommand !== undefined) {
      const loaded = yield* loadAggregate(aggregateId, config)
      const cachedResult = new AggregateCommandResult({
        nextExpectedStreamVersion: loaded.currentVersion,
        creationStatus:
          loaded.currentVersion > 0
            ? { _tag: "ExistingStream" }
            : { _tag: "CreatedStream" },
        processingStatus: { _tag: "Deduplicated" }
      })
      const handledResult: HandledCommandResult<State, Event> = {
        state: loaded.state,
        events: [],
        result: cachedResult
      }
      return handledResult
    }

    const loaded = yield* loadAggregate(aggregateId, config)
    const currentVersion = loaded.currentVersion
    const currentState = loaded.state

    const events = yield* config.decider.decide(command, currentState)

    if (events.length === 0) {
      const nowMs = yield* Clock.currentTimeMillis
      const now = TimestampMs.make(nowMs)
      const result = new AggregateCommandResult({
        nextExpectedStreamVersion: currentVersion,
        creationStatus:
          currentVersion > 0
            ? { _tag: "ExistingStream" }
            : { _tag: "CreatedStream" },
        processingStatus: { _tag: "Processed" }
      })
      const resultJson = yield* Schema.encodeEffect(commandResultJsonSchema)(result).pipe(
        Effect.orDie
      )
      yield* sql`
        INSERT INTO es_commands (command_id, aggregate_id, stream_version, result_json, created_at)
        VALUES (${commandId}, ${aggregateId}, ${currentVersion}, ${resultJson}, ${now})
      `
      const handledResult: HandledCommandResult<State, Event> = {
        state: currentState,
        events: [],
        result
      }
      return handledResult
    }

    const nextExpectedStreamVersion = StreamVersion.make(currentVersion + events.length)
    const creationStatus =
      currentVersion === 0
        ? ({ _tag: "CreatedStream" } as const)
        : ({ _tag: "ExistingStream" } as const)
    const processingStatus = { _tag: "Processed" } as const
    const commandResult = new AggregateCommandResult({
      nextExpectedStreamVersion,
      creationStatus,
      processingStatus
    })

    const eventJsonSchema = Schema.fromJsonString(config.eventSchema)
    const metadataJsonSchema = Schema.fromJsonString(EventMetadata)

    const commitTx = Effect.gen(function* () {
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
          timestamp: now
        })
        const payloadJson = yield* Schema.encodeEffect(eventJsonSchema)(event).pipe(
          Effect.orDie
        )
        const metadataJson = yield* Schema.encodeEffect(metadataJsonSchema)(metadata).pipe(
          Effect.orDie
        )
        const eventType =
          typeof event === "object" && event !== null && "_tag" in event && typeof event._tag === "string"
            ? event._tag
            : "Event"

        yield* sql`
          INSERT INTO es_events (
            aggregate_id,
            stream_version,
            command_id,
            event_type,
            payload,
            metadata,
            created_at
          ) VALUES (
            ${aggregateId},
            ${eventVersion},
            ${commandId},
            ${eventType},
            ${payloadJson},
            ${metadataJson},
            ${now}
          )
        `

        if (config.projections !== undefined) {
          for (const projection of config.projections) {
            yield* applyLocalProjection(projection, event, metadata)
            yield* sql`
              INSERT INTO es_projections_meta (
                aggregate_id,
                projection_name,
                projection_version,
                last_stream_version,
                updated_at
              ) VALUES (
                ${aggregateId},
                ${projection.name},
                ${projection.version},
                ${eventVersion},
                ${now}
              )
              ON CONFLICT (aggregate_id, projection_name) DO UPDATE SET
                last_stream_version = excluded.last_stream_version,
                updated_at = excluded.updated_at
            `
          }
        }

        if (config.publish === true) {
          yield* sql`
            INSERT INTO es_outbox (
              aggregate_id,
              stream_version,
              event_type,
              payload,
              metadata,
              created_at
            ) VALUES (
              ${aggregateId},
              ${eventVersion},
              ${eventType},
              ${payloadJson},
              ${metadataJson},
              ${now}
            )
          `
        }
      }

      const nowMs = yield* Clock.currentTimeMillis
      const now = TimestampMs.make(nowMs)
      const commandResultJson = yield* Schema.encodeEffect(commandResultJsonSchema)(
        commandResult
      ).pipe(Effect.orDie)
      yield* sql`
        INSERT INTO es_commands (command_id, aggregate_id, stream_version, result_json, created_at)
        VALUES (${commandId}, ${aggregateId}, ${nextExpectedStreamVersion}, ${commandResultJson}, ${now})
      `

      return activeState
    })

    const newState = yield* sql.withTransaction(commitTx).pipe(
      Effect.catch((sqlErr: SqlError) => {
        const reasonObj = sqlErr as { readonly reason?: { readonly cause?: unknown } }
        const reasonCause = reasonObj.reason?.cause
        const causeStr = reasonCause instanceof Error ? reasonCause.message : String(reasonCause)
        const errMsg = `${sqlErr.message} ${causeStr} ${String(sqlErr.cause)}`
        if (
          errMsg.includes("UNIQUE") ||
          errMsg.includes("constraint") ||
          errMsg.includes("StreamVersion")
        ) {
          return Effect.fail(
            new ConcurrencyConflictError({
              aggregateId,
              expectedVersion: currentVersion,
              actualVersion: nextExpectedStreamVersion
            })
          )
        }
        return Effect.die(sqlErr)
      })
    )

    const handled: HandledCommandResult<State, Event> = {
      state: newState,
      events,
      result: commandResult
    }
    return handled
  }
)
