import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type {
  AggregateId,
  AggregateNotFoundError,
  EventMetadata,
  LocalProjectionNotFoundError,
  ProjectionName,
  ProjectionVersion
} from "@harness/es-contract"

export interface HistoricalEvent<Event> {
  readonly event: Event
  readonly metadata: EventMetadata
}

export interface LocalProjection<Event, ReadModel> {
  readonly name: ProjectionName
  readonly version: ProjectionVersion
  readonly model: Schema.Schema<ReadModel>
  readonly apply: (
    event: Event,
    metadata: EventMetadata
  ) => Effect.Effect<void, never, SqlClient>
  readonly query: (
    aggregateId: AggregateId
  ) => Effect.Effect<ReadModel, AggregateNotFoundError | LocalProjectionNotFoundError, SqlClient>
  readonly rebuild: (
    events: ReadonlyArray<HistoricalEvent<Event>>
  ) => Effect.Effect<void, never, SqlClient>
}

export const applyLocalProjection = Effect.fn("LocalProjection.apply")(
  function* <Event, ReadModel>(
    projection: LocalProjection<Event, ReadModel>,
    event: Event,
    metadata: EventMetadata
  ) {
    yield* projection.apply(event, metadata)
  }
)

export const queryLocalProjection = Effect.fn("LocalProjection.query")(
  function* <Event, ReadModel>(
    projection: LocalProjection<Event, ReadModel>,
    aggregateId: AggregateId
  ) {
    return yield* projection.query(aggregateId)
  }
)

export const rebuildLocalProjection = Effect.fn("LocalProjection.rebuild")(
  function* <Event, ReadModel>(
    projection: LocalProjection<Event, ReadModel>,
    events: ReadonlyArray<HistoricalEvent<Event>>
  ) {
    yield* projection.rebuild(events)
  }
)

export const LocalProjection = {
  make: <Event, ReadModel>(
    definition: LocalProjection<Event, ReadModel>
  ): LocalProjection<Event, ReadModel> => definition
}
