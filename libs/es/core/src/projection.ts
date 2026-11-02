import { Effect, Schema } from "effect"
import {
  type AggregateId,
  type AggregateNotFoundError,
  type EventMetadata,
  LocalProjectionNotFoundError,
  type ProjectionName,
  type ProjectionVersion
} from "@harness/es-contract"

export interface HistoricalEvent<Event> {
  readonly event: Event
  readonly metadata: EventMetadata
}

export interface LocalProjection<Event, ReadModel, Env = never, Err = never> {
  readonly name: ProjectionName
  readonly version: ProjectionVersion
  readonly model: Schema.Top & { readonly Type: ReadModel }
  readonly apply: (
    event: Event,
    metadata: EventMetadata
  ) => Effect.Effect<void, Err, Env>
  readonly query: (
    aggregateId: AggregateId
  ) => Effect.Effect<ReadModel, AggregateNotFoundError | Err, Env>
  readonly rebuild: (
    aggregateId: AggregateId,
    events: ReadonlyArray<HistoricalEvent<Event>>
  ) => Effect.Effect<void, Err, Env>
}

export const applyLocalProjection = Effect.fn("LocalProjection.apply")(
  function* <Event, ReadModel, Env, Err>(
    projection: LocalProjection<Event, ReadModel, Env, Err>,
    event: Event,
    metadata: EventMetadata
  ) {
    yield* projection.apply(event, metadata)
  }
)

export const queryLocalProjection = Effect.fn("LocalProjection.query")(
  function* <Event, ReadModel, Env, Err>(
    projections: ReadonlyArray<LocalProjection<Event, ReadModel, Env, Err>>,
    projectionName: ProjectionName,
    aggregateId: AggregateId
  ) {
    const target = projections.find((p) => p.name === projectionName)
    if (target === undefined) {
      return yield* new LocalProjectionNotFoundError({ name: projectionName })
    }
    return yield* target.query(aggregateId)
  }
)

export const rebuildLocalProjection = Effect.fn("LocalProjection.rebuild")(
  function* <Event, ReadModel, Env, Err>(
    projection: LocalProjection<Event, ReadModel, Env, Err>,
    aggregateId: AggregateId,
    events: ReadonlyArray<HistoricalEvent<Event>>
  ) {
    yield* projection.rebuild(aggregateId, events)
  }
)

export const LocalProjection = {
  make: <Event, ReadModel, Env = never, Err = never>(
    definition: LocalProjection<Event, ReadModel, Env, Err>
  ): LocalProjection<Event, ReadModel, Env, Err> => definition
}
