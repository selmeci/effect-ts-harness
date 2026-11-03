import { Effect, Schema } from "effect"
import { stub } from "@harness/gates"
import {
  type AggregateId,
  type AggregateName,
  type AggregateNotFoundError,
  type CrossProjectionNotFoundError,
  type EventMetadata,
  LocalProjectionNotFoundError,
  type ProcessorId,
  type ProjectionName,
  type ProjectionSequenceDecision,
  type ProjectionSequenceInput,
  type ProjectionVersion,
} from "@harness/es-contract"

export interface HistoricalEvent<Event> {
  readonly event: Event
  readonly metadata: EventMetadata
}

export interface ArchivedEvent<Event> {
  readonly aggregateName: AggregateName
  readonly aggregateId: AggregateId
  readonly event: Event
  readonly metadata: EventMetadata
}

/**
 * Strongly-consistent local read-model projection updated inside the aggregate's event transaction.
 *
 * Contract (REQ-3.2): implementations of `rebuild(aggregateId, events)` MUST first purge/delete
 * any existing read-model state for `aggregateId` and then replay `events` in `streamVersion` order
 * so the resulting read model matches incremental `apply` execution.
 */
export interface LocalProjection<Event, ReadModel, Env = never, Err = never> {
  readonly name: ProjectionName
  readonly version: ProjectionVersion
  readonly model: Schema.Top & { readonly Type: ReadModel }
  readonly apply: (event: Event, metadata: EventMetadata) => Effect.Effect<void, Err, Env>
  readonly query: (
    aggregateId: AggregateId,
  ) => Effect.Effect<ReadModel, AggregateNotFoundError | Err, Env>
  /**
   * Rebuilds the local projection for a given aggregate stream (REQ-3.2).
   *
   * Implementations of `rebuild(aggregateId, events)` MUST first purge/delete any existing
   * read-model state for `aggregateId` and then replay `events` in `streamVersion` order
   * so the resulting read model matches incremental `apply` execution.
   */
  readonly rebuild: (
    aggregateId: AggregateId,
    events: ReadonlyArray<HistoricalEvent<Event>>,
  ) => Effect.Effect<void, Err, Env>
}

export const applyLocalProjection = Effect.fn("LocalProjection.apply")(function* <
  Event,
  ReadModel,
  Env,
  Err,
>(projection: LocalProjection<Event, ReadModel, Env, Err>, event: Event, metadata: EventMetadata) {
  yield* projection.apply(event, metadata)
})

export const queryLocalProjection = Effect.fn("LocalProjection.query")(function* <
  Event,
  ReadModel,
  Env,
  Err,
>(
  projections: ReadonlyArray<LocalProjection<Event, ReadModel, Env, Err>>,
  projectionName: ProjectionName,
  aggregateId: AggregateId,
) {
  const target = projections.find((p) => p.name === projectionName)
  if (target === undefined) {
    return yield* new LocalProjectionNotFoundError({ name: projectionName })
  }
  return yield* target.query(aggregateId)
})

/**
 * Rebuilds a local projection from historical events (REQ-3.2).
 *
 * Implementations of `rebuild(aggregateId, events)` MUST first purge/delete any existing
 * read-model state for `aggregateId` and then replay `events` in `streamVersion` order
 * so the resulting read model matches incremental `apply` execution.
 */
export const rebuildLocalProjection = Effect.fn("LocalProjection.rebuild")(function* <
  Event,
  ReadModel,
  Env,
  Err,
>(
  projection: LocalProjection<Event, ReadModel, Env, Err>,
  aggregateId: AggregateId,
  events: ReadonlyArray<HistoricalEvent<Event>>,
) {
  yield* projection.rebuild(aggregateId, events)
})

export const LocalProjection = {
  make: <Event, ReadModel, Env = never, Err = never>(
    definition: LocalProjection<Event, ReadModel, Env, Err>,
  ): LocalProjection<Event, ReadModel, Env, Err> => definition,
}

/**
 * Eventually-consistent cross-aggregate projection fed via the outbox and event archive.
 */
export interface CrossAggregateProjection<
  Event,
  ReadModel,
  QueryInput = void,
  Env = never,
  Err = never,
> {
  readonly processorId: ProcessorId
  readonly aggregateName: AggregateName
  readonly eventSchema: Schema.Codec<Event, unknown>
  readonly model: Schema.Top & { readonly Type: ReadModel }
  readonly apply: (event: Event, metadata: EventMetadata) => Effect.Effect<void, Err, Env>
  readonly query: (input: QueryInput) => Effect.Effect<ReadModel, Err, Env>
  readonly purge: Effect.Effect<void, Err, Env>
}

export const decideProjectionSequence = Effect.fn("ProjectionSequence.decide")(function* (
  input: ProjectionSequenceInput,
) {
  return yield* stub<ProjectionSequenceDecision, never, never>(input)
})

export const applyCrossProjection = Effect.fn("CrossProjection.apply")(function* <
  Event,
  ReadModel,
  QueryInput,
  Env,
  Err,
>(
  projection: CrossAggregateProjection<Event, ReadModel, QueryInput, Env, Err>,
  event: Event,
  metadata: EventMetadata,
) {
  return yield* stub<void, Err, Env>(projection, event, metadata)
})

export const queryCrossProjection = Effect.fn("CrossProjection.query")(function* <
  Event,
  ReadModel,
  QueryInput,
  Env,
  Err,
>(
  projections: ReadonlyArray<CrossAggregateProjection<Event, ReadModel, QueryInput, Env, Err>>,
  processorId: ProcessorId,
  input: QueryInput,
) {
  return yield* stub<ReadModel, CrossProjectionNotFoundError | Err, Env>(
    projections,
    processorId,
    input,
  )
})

export const rebuildCrossProjection = Effect.fn("CrossProjection.rebuild")(function* <
  Event,
  ReadModel,
  QueryInput,
  Env,
  Err,
>(
  projection: CrossAggregateProjection<Event, ReadModel, QueryInput, Env, Err>,
  events: ReadonlyArray<ArchivedEvent<Event>>,
) {
  return yield* stub<void, Err, Env>(projection, events)
})

export const CrossAggregateProjection = {
  make: <Event, ReadModel, QueryInput = void, Env = never, Err = never>(
    definition: CrossAggregateProjection<Event, ReadModel, QueryInput, Env, Err>,
  ): CrossAggregateProjection<Event, ReadModel, QueryInput, Env, Err> => definition,
}
