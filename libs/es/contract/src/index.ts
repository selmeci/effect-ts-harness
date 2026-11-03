import { Schema } from "effect"

// 0-based stream revisions and counters (0 is valid)
export const StreamVersion = Schema.Natural.pipe(Schema.brand("StreamVersion"))
export type StreamVersion = typeof StreamVersion.Type

// Strictly positive quantities (> 0, 0 is invalid)
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt"),
)
export type PositiveInt = typeof PositiveInt.Type

// Branded identifier schemas for command idempotency and aggregate addressing
export const CommandId = Schema.NonEmptyString.pipe(Schema.brand("CommandId"))
export type CommandId = typeof CommandId.Type

export const AggregateId = Schema.NonEmptyString.pipe(Schema.brand("AggregateId"))
export type AggregateId = typeof AggregateId.Type

export const AggregateName = Schema.NonEmptyString.pipe(Schema.brand("AggregateName"))
export type AggregateName = typeof AggregateName.Type

export const ProjectionName = Schema.NonEmptyString.pipe(Schema.brand("ProjectionName"))
export type ProjectionName = typeof ProjectionName.Type

export const ProjectionVersion = Schema.Natural.pipe(Schema.brand("ProjectionVersion"))
export type ProjectionVersion = typeof ProjectionVersion.Type

export const TimestampMs = Schema.Natural.pipe(Schema.brand("TimestampMs"))
export type TimestampMs = typeof TimestampMs.Type

export const CorrelationId = Schema.NonEmptyString.pipe(Schema.brand("CorrelationId"))
export type CorrelationId = typeof CorrelationId.Type

export const CausationId = Schema.NonEmptyString.pipe(Schema.brand("CausationId"))
export type CausationId = typeof CausationId.Type

export const ErrorMessage = Schema.NonEmptyString.pipe(Schema.brand("ErrorMessage"))
export type ErrorMessage = typeof ErrorMessage.Type

// Canonical metadata accompanying every persisted and dispatched event
export class EventMetadata extends Schema.Class<EventMetadata>("EventMetadata")({
  aggregateId: AggregateId,
  streamVersion: StreamVersion,
  commandId: CommandId,
  timestamp: TimestampMs,
  correlationId: Schema.optional(CorrelationId),
  causationId: Schema.optional(CausationId),
}) {}

// Lifecycle and publication states modeled as closed discriminated unions (no boolean flags)
export const StreamCreationStatus = Schema.Union([
  Schema.TaggedStruct("CreatedStream", {}),
  Schema.TaggedStruct("ExistingStream", {}),
  Schema.TaggedStruct("NoStream", {}),
])
export type StreamCreationStatus = typeof StreamCreationStatus.Type

export const CommandProcessingStatus = Schema.Union([
  Schema.TaggedStruct("Processed", {}),
  Schema.TaggedStruct("Deduplicated", {}),
])
export type CommandProcessingStatus = typeof CommandProcessingStatus.Type

export const OutboxPublicationMode = Schema.Union([
  Schema.TaggedStruct("PublishOutbox", {}),
  Schema.TaggedStruct("SuppressOutbox", {}),
])
export type OutboxPublicationMode = typeof OutboxPublicationMode.Type

// Command execution outcome contract
export class AggregateCommandResult extends Schema.Class<AggregateCommandResult>(
  "AggregateCommandResult",
)(
  Schema.Struct({
    nextExpectedStreamVersion: StreamVersion,
    creationStatus: StreamCreationStatus,
    processingStatus: CommandProcessingStatus,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (r) =>
          (r.creationStatus._tag === "NoStream" && r.nextExpectedStreamVersion === 0) ||
          (r.creationStatus._tag !== "NoStream" && r.nextExpectedStreamVersion > 0),
        {
          message:
            "CreatedStream and ExistingStream require nextExpectedStreamVersion > 0, while NoStream requires nextExpectedStreamVersion === 0",
        },
      ),
    ),
  ),
) {}

// Typed domain and persistence errors
export class ConcurrencyConflictError extends Schema.TaggedError<ConcurrencyConflictError>()(
  "ConcurrencyConflictError",
  {
    aggregateId: AggregateId,
    expectedVersion: StreamVersion,
    actualVersion: StreamVersion,
  },
) {}

export class AggregateNotFoundError extends Schema.TaggedError<AggregateNotFoundError>()(
  "AggregateNotFoundError",
  {
    aggregateId: AggregateId,
  },
) {}

export class LocalProjectionNotFoundError extends Schema.TaggedError<LocalProjectionNotFoundError>()(
  "LocalProjectionNotFoundError",
  {
    name: ProjectionName,
  },
) {}

export class CommandAggregateMismatchError extends Schema.TaggedError<CommandAggregateMismatchError>()(
  "CommandAggregateMismatchError",
  {
    commandId: CommandId,
    expectedAggregateName: AggregateName,
    expectedAggregateId: AggregateId,
    actualAggregateName: AggregateName,
    actualAggregateId: AggregateId,
  },
) {}

export class EventStreamCorruptionError extends Schema.TaggedError<EventStreamCorruptionError>()(
  "EventStreamCorruptionError",
  {
    aggregateName: AggregateName,
    aggregateId: AggregateId,
    expectedStreamVersion: StreamVersion,
    actualStreamVersion: Schema.optional(StreamVersion),
    reason: Schema.optional(ErrorMessage),
  },
) {}

export class EventSerializationError extends Schema.TaggedError<EventSerializationError>()(
  "EventSerializationError",
  {
    aggregateName: AggregateName,
    aggregateId: AggregateId,
    streamVersion: StreamVersion,
    reason: ErrorMessage,
  },
) {}
