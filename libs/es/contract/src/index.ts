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

export const OutboxRowId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("OutboxRowId"),
)
export type OutboxRowId = typeof OutboxRowId.Type

export const EventType = Schema.NonEmptyString.pipe(Schema.brand("EventType"))
export type EventType = typeof EventType.Type

export const SerializedPayload = Schema.NonEmptyString.pipe(Schema.brand("SerializedPayload"))
export type SerializedPayload = typeof SerializedPayload.Type

export const ProcessorId = Schema.NonEmptyString.pipe(Schema.brand("ProcessorId"))
export type ProcessorId = typeof ProcessorId.Type

export const BatchLimit = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("BatchLimit"))
export type BatchLimit = typeof BatchLimit.Type

export const AggregateCount = Schema.Natural.pipe(Schema.brand("AggregateCount"))
export type AggregateCount = typeof AggregateCount.Type

export const EventSchemaVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EventSchemaVersion"),
)
export type EventSchemaVersion = typeof EventSchemaVersion.Type

export const JsonSchemaText = Schema.NonEmptyString.pipe(Schema.brand("JsonSchemaText"))
export type JsonSchemaText = typeof JsonSchemaText.Type

export class EventVersionSnapshotEntry extends Schema.Class<EventVersionSnapshotEntry>(
  "EventVersionSnapshotEntry",
)({
  eventType: EventType,
  version: EventSchemaVersion,
  jsonSchema: JsonSchemaText,
}) {}

export class EventUpcasterLink extends Schema.Class<EventUpcasterLink>("EventUpcasterLink")(
  Schema.Struct({
    eventType: EventType,
    fromVersion: EventSchemaVersion,
    toVersion: EventSchemaVersion,
  }).pipe(
    Schema.check(
      Schema.makeFilter((u) => u.toVersion === u.fromVersion + 1, {
        message: "EventUpcasterLink requires contiguous toVersion === fromVersion + 1",
      }),
    ),
  ),
) {}

export class EventSchemaEvolutionInput extends Schema.Class<EventSchemaEvolutionInput>(
  "EventSchemaEvolutionInput",
)({
  committedSnapshots: Schema.Array(EventVersionSnapshotEntry),
  currentSnapshots: Schema.Array(EventVersionSnapshotEntry),
  registeredUpcasters: Schema.Array(EventUpcasterLink),
}) {}

export const SchemaEvolutionValid = Schema.TaggedStruct("SchemaEvolutionValid", {
  checkedEventCount: AggregateCount,
})
export type SchemaEvolutionValid = typeof SchemaEvolutionValid.Type

export const FrozenEventVersionDrifted = Schema.TaggedStruct("FrozenEventVersionDrifted", {
  eventType: EventType,
  version: EventSchemaVersion,
  reason: ErrorMessage,
})
export type FrozenEventVersionDrifted = typeof FrozenEventVersionDrifted.Type

export const UnmappedEventVersionJump = Schema.TaggedStruct("UnmappedEventVersionJump", {
  eventType: EventType,
  fromVersion: EventSchemaVersion,
  toVersion: EventSchemaVersion,
  reason: ErrorMessage,
})
export type UnmappedEventVersionJump = typeof UnmappedEventVersionJump.Type

export const EventSchemaEvolutionDecision = Schema.Union([
  SchemaEvolutionValid,
  FrozenEventVersionDrifted,
  UnmappedEventVersionJump,
])
export type EventSchemaEvolutionDecision = typeof EventSchemaEvolutionDecision.Type

// Canonical metadata accompanying every persisted and dispatched event
export class EventMetadata extends Schema.Class<EventMetadata>("EventMetadata")({
  aggregateId: AggregateId,
  streamVersion: StreamVersion,
  commandId: CommandId,
  timestamp: TimestampMs,
  correlationId: Schema.optional(CorrelationId),
  causationId: Schema.optional(CausationId),
}) {}

// Canonical wire envelope for events published from the aggregate outbox to the EventBus
export class PublishedEventEnvelope extends Schema.Class<PublishedEventEnvelope>(
  "PublishedEventEnvelope",
)(
  Schema.Struct({
    aggregateName: AggregateName,
    aggregateId: AggregateId,
    streamVersion: StreamVersion,
    eventType: EventType,
    payload: SerializedPayload,
    metadata: EventMetadata,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (e) =>
          e.streamVersion > 0 &&
          e.metadata.aggregateId === e.aggregateId &&
          e.metadata.streamVersion === e.streamVersion,
        {
          message:
            "PublishedEventEnvelope requires streamVersion > 0 and metadata identity (aggregateId, streamVersion) matching the envelope",
        },
      ),
    ),
  ),
) {}

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

export const OutboxDrainOutcome = Schema.Union([
  Schema.TaggedStruct("OutboxEmpty", {}),
  Schema.TaggedStruct("OutboxDrained", {
    drainedCount: PositiveInt,
  }),
])
export type OutboxDrainOutcome = typeof OutboxDrainOutcome.Type

export class ProjectionSequenceInput extends Schema.Class<ProjectionSequenceInput>(
  "ProjectionSequenceInput",
)({
  checkpointVersion: StreamVersion,
  incomingVersion: StreamVersion,
  parkedVersions: Schema.Array(StreamVersion),
}) {}

export const ProjectionSequenceDecision = Schema.Union([
  Schema.TaggedStruct("SkipDuplicateEvent", {
    checkpointVersion: StreamVersion,
  }),
  Schema.TaggedStruct("ParkOutOfOrderEvent", {
    expectedVersion: StreamVersion,
    parkedVersion: StreamVersion,
  }).pipe(
    Schema.check(
      Schema.makeFilter((d) => d.expectedVersion > 0 && d.parkedVersion > d.expectedVersion, {
        message:
          "ParkOutOfOrderEvent requires expectedVersion > 0 and parkedVersion > expectedVersion",
      }),
    ),
  ),
  Schema.TaggedStruct("ApplyContiguousEvents", {
    versionsToApply: Schema.NonEmptyArray(StreamVersion),
    newCheckpointVersion: StreamVersion,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (d) =>
          d.newCheckpointVersion > 0 &&
          d.versionsToApply[d.versionsToApply.length - 1] === d.newCheckpointVersion &&
          d.versionsToApply.every((v, idx) =>
            idx === 0 ? v > 0 : v === d.versionsToApply[idx - 1]! + 1,
          ),
        {
          message:
            "ApplyContiguousEvents requires positive contiguous versionsToApply (step +1) matching newCheckpointVersion",
        },
      ),
    ),
  ),
])
export type ProjectionSequenceDecision = typeof ProjectionSequenceDecision.Type

export const ProjectionCatchUpStatus = Schema.Union([
  Schema.TaggedStruct("CaughtUp", {
    archiveAggregatesCount: AggregateCount,
  }),
  Schema.TaggedStruct("Lagging", {
    laggingAggregateId: AggregateId,
    checkpointVersion: StreamVersion,
    archiveHeadVersion: StreamVersion,
  }),
])
export type ProjectionCatchUpStatus = typeof ProjectionCatchUpStatus.Type

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

export const makeHandledCommandResponseSchema = <
  StateSchema extends Schema.Top,
  EventSchema extends Schema.Top,
>(
  stateSchema: StateSchema,
  eventSchema: EventSchema,
) =>
  Schema.Struct({
    state: stateSchema,
    events: Schema.Array(eventSchema),
    result: AggregateCommandResult,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (r: unknown) => {
          if (typeof r !== "object" || r === null || !("result" in r) || !("events" in r)) {
            return false
          }
          const result = r.result
          const events = r.events
          if (typeof result !== "object" || result === null || !("processingStatus" in result)) {
            return false
          }
          const status = result.processingStatus
          if (typeof status !== "object" || status === null || !("_tag" in status)) {
            return false
          }
          return status._tag !== "Deduplicated" || (Array.isArray(events) && events.length === 0)
        },
        {
          message: "Deduplicated command response requires an empty events array",
        },
      ),
    ),
  )

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

export class OutboxPublishError extends Schema.TaggedError<OutboxPublishError>()(
  "OutboxPublishError",
  {
    aggregateName: AggregateName,
    aggregateId: AggregateId,
    streamVersion: StreamVersion,
    reason: ErrorMessage,
  },
) {}

export class ProjectionArchiveCorruptionError extends Schema.TaggedError<ProjectionArchiveCorruptionError>()(
  "ProjectionArchiveCorruptionError",
  {
    processorId: ProcessorId,
    aggregateName: AggregateName,
    aggregateId: AggregateId,
    streamVersion: StreamVersion,
    reason: ErrorMessage,
  },
) {}

export class CrossProjectionNotFoundError extends Schema.TaggedError<CrossProjectionNotFoundError>()(
  "CrossProjectionNotFoundError",
  {
    processorId: ProcessorId,
  },
) {}

export class FrozenEventSchemaViolationError extends Schema.TaggedError<FrozenEventSchemaViolationError>()(
  "FrozenEventSchemaViolationError",
  {
    eventType: EventType,
    version: EventSchemaVersion,
    reason: ErrorMessage,
  },
) {}

export class MissingEventUpcasterError extends Schema.TaggedError<MissingEventUpcasterError>()(
  "MissingEventUpcasterError",
  {
    eventType: EventType,
    fromVersion: EventSchemaVersion,
    toVersion: EventSchemaVersion,
    reason: ErrorMessage,
  },
) {}
