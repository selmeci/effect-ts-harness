import type { Schema } from "effect"
import type {
  AggregateCommandResult,
  AggregateName,
  OutboxPublicationMode,
  StreamVersion
} from "@harness/es-contract"
import type { Decider } from "./decider.js"
import type { LocalProjection } from "./projection.js"

export interface AggregateConfig<
  Command,
  Event,
  State,
  Err,
  ProjectionEnv = never,
  ProjectionErr = never
> {
  readonly aggregateName: AggregateName
  readonly decider: Decider<Command, Event, State, Err>
  readonly eventSchema: Schema.Codec<Event, unknown>
  readonly projections?:
    | ReadonlyArray<LocalProjection<Event, unknown, ProjectionEnv, ProjectionErr>>
    | undefined
  readonly outboxMode?: OutboxPublicationMode | undefined
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
