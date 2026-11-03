import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  AggregateCommandResult,
  AggregateCount,
  AggregateId,
  AggregateName,
  AggregateNotFoundError,
  BatchLimit,
  CausationId,
  CommandAggregateMismatchError,
  CommandId,
  CommandProcessingStatus,
  ConcurrencyConflictError,
  CorrelationId,
  CrossProjectionNotFoundError,
  ErrorMessage,
  EventMetadata,
  EventSerializationError,
  EventStreamCorruptionError,
  EventType,
  LocalProjectionNotFoundError,
  OutboxDrainOutcome,
  OutboxPublicationMode,
  OutboxPublishError,
  OutboxRowId,
  PositiveInt,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  ProjectionCatchUpStatus,
  ProjectionName,
  ProjectionSequenceDecision,
  ProjectionSequenceInput,
  ProjectionVersion,
  PublishedEventEnvelope,
  SerializedPayload,
  StreamCreationStatus,
  StreamVersion,
  TimestampMs,
} from "../src/index.js"

describe("@harness/es-contract", () => {
  describe("StreamVersion", () => {
    it("decodes valid 0-based stream revisions", () => {
      expect(Schema.decodeSync(StreamVersion)(0)).toBe(0)
      expect(Schema.decodeSync(StreamVersion)(42)).toBe(42)
    })

    it("rejects negative numbers and non-integers", () => {
      const negative: unknown = -1
      const float: unknown = 1.5
      const notANumber: unknown = "0"
      const nil: unknown = null
      const undef: unknown = undefined
      expect(() => Schema.decodeSync(StreamVersion)(-1)).toThrow()
      expect(() => Schema.decodeSync(StreamVersion)(1.5)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(negative)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(float)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(notANumber)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(nil)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(undef)).toThrow()
    })
  })

  describe("PositiveInt", () => {
    it("decodes strictly positive integers", () => {
      expect(Schema.decodeSync(PositiveInt)(1)).toBe(1)
      expect(Schema.decodeSync(PositiveInt)(100)).toBe(100)
    })

    it("rejects zero and negative numbers", () => {
      const notANumber: unknown = "1"
      expect(() => Schema.decodeSync(PositiveInt)(0)).toThrow()
      expect(() => Schema.decodeSync(PositiveInt)(-5)).toThrow()
      expect(() => Schema.decodeSync(PositiveInt)(2.5)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(notANumber)).toThrow()
    })
  })

  describe("Branded Identifiers and Versions", () => {
    it("decodes non-empty strings into branded identifiers", () => {
      expect(Schema.decodeSync(CommandId)("cmd-1")).toBe("cmd-1")
      expect(Schema.decodeSync(AggregateId)("cart-123")).toBe("cart-123")
      expect(Schema.decodeSync(AggregateName)("Cart")).toBe("Cart")
      expect(Schema.decodeSync(ProjectionName)("cart-view")).toBe("cart-view")
      expect(Schema.decodeSync(CorrelationId)("corr-999")).toBe("corr-999")
      expect(Schema.decodeSync(CausationId)("cause-888")).toBe("cause-888")
      expect(Schema.decodeSync(ErrorMessage)("stream corrupted")).toBe("stream corrupted")
    })

    it("rejects empty strings for identifiers and error messages", () => {
      expect(() => Schema.decodeSync(CommandId)("")).toThrow()
      expect(() => Schema.decodeSync(AggregateId)("")).toThrow()
      expect(() => Schema.decodeSync(AggregateName)("")).toThrow()
      expect(() => Schema.decodeSync(ProjectionName)("")).toThrow()
      expect(() => Schema.decodeSync(ErrorMessage)("")).toThrow()
    })

    it("decodes natural numbers into ProjectionVersion and TimestampMs", () => {
      expect(Schema.decodeSync(ProjectionVersion)(1)).toBe(1)
      expect(Schema.decodeSync(ProjectionVersion)(0)).toBe(0)
      expect(Schema.decodeSync(TimestampMs)(1700000000000)).toBe(1700000000000)
      expect(() => Schema.decodeSync(ProjectionVersion)(-1)).toThrow()
      expect(() => Schema.decodeSync(TimestampMs)(-10)).toThrow()
    })
  })

  describe("EventMetadata", () => {
    it("decodes valid metadata with and without optional correlation/causation", () => {
      const full = Schema.decodeSync(EventMetadata)({
        aggregateId: "agg-1",
        streamVersion: 2,
        commandId: "cmd-abc",
        timestamp: 1700000000000,
        correlationId: "corr-1",
        causationId: "cause-1",
      })
      expect(full.aggregateId).toBe("agg-1")
      expect(full.streamVersion).toBe(2)
      expect(full.commandId).toBe("cmd-abc")
      expect(full.correlationId).toBe("corr-1")
      expect(full.causationId).toBe("cause-1")

      const minimal = Schema.decodeSync(EventMetadata)({
        aggregateId: "agg-2",
        streamVersion: 0,
        commandId: "cmd-def",
        timestamp: 1700000000000,
      })
      expect(minimal.aggregateId).toBe("agg-2")
      expect(minimal.correlationId).toBeUndefined()
    })
  })

  describe("AggregateCommandResult & Status Unions", () => {
    it("decodes valid command results with closed status variants", () => {
      expect(Schema.decodeSync(StreamCreationStatus)({ _tag: "CreatedStream" })._tag).toBe(
        "CreatedStream",
      )
      expect(Schema.decodeSync(StreamCreationStatus)({ _tag: "NoStream" })._tag).toBe("NoStream")
      expect(Schema.decodeSync(CommandProcessingStatus)({ _tag: "Processed" })._tag).toBe(
        "Processed",
      )
      expect(Schema.decodeSync(OutboxPublicationMode)({ _tag: "PublishOutbox" })._tag).toBe(
        "PublishOutbox",
      )
      expect(Schema.decodeSync(OutboxPublicationMode)({ _tag: "SuppressOutbox" })._tag).toBe(
        "SuppressOutbox",
      )

      const res1 = Schema.decodeSync(AggregateCommandResult)({
        nextExpectedStreamVersion: 1,
        creationStatus: { _tag: "CreatedStream" },
        processingStatus: { _tag: "Processed" },
      })
      expect(res1.nextExpectedStreamVersion).toBe(1)
      expect(res1.creationStatus._tag).toBe("CreatedStream")
      expect(res1.processingStatus._tag).toBe("Processed")

      const res2 = Schema.decodeSync(AggregateCommandResult)({
        nextExpectedStreamVersion: 5,
        creationStatus: { _tag: "ExistingStream" },
        processingStatus: { _tag: "Deduplicated" },
      })
      expect(res2.creationStatus._tag).toBe("ExistingStream")
      expect(res2.processingStatus._tag).toBe("Deduplicated")

      const resNoStream = Schema.decodeSync(AggregateCommandResult)({
        nextExpectedStreamVersion: 0,
        creationStatus: { _tag: "NoStream" },
        processingStatus: { _tag: "Processed" },
      })
      expect(resNoStream.nextExpectedStreamVersion).toBe(0)
      expect(resNoStream.creationStatus._tag).toBe("NoStream")
    })

    it("accepts valid combinations via constructor and decoding", () => {
      const c1 = new AggregateCommandResult({
        nextExpectedStreamVersion: StreamVersion.make(0),
        creationStatus: { _tag: "NoStream" },
        processingStatus: { _tag: "Processed" },
      })
      expect(c1.nextExpectedStreamVersion).toBe(0)
      expect(c1.creationStatus._tag).toBe("NoStream")

      const c2 = new AggregateCommandResult({
        nextExpectedStreamVersion: StreamVersion.make(1),
        creationStatus: { _tag: "CreatedStream" },
        processingStatus: { _tag: "Processed" },
      })
      expect(c2.nextExpectedStreamVersion).toBe(1)
      expect(c2.creationStatus._tag).toBe("CreatedStream")

      const c3 = new AggregateCommandResult({
        nextExpectedStreamVersion: StreamVersion.make(3),
        creationStatus: { _tag: "ExistingStream" },
        processingStatus: { _tag: "Processed" },
      })
      expect(c3.nextExpectedStreamVersion).toBe(3)
      expect(c3.creationStatus._tag).toBe("ExistingStream")
    })

    it("rejects invalid stream version and creation status combinations", () => {
      // CreatedStream at version 0
      expect(
        () =>
          new AggregateCommandResult({
            nextExpectedStreamVersion: StreamVersion.make(0),
            creationStatus: { _tag: "CreatedStream" },
            processingStatus: { _tag: "Processed" },
          }),
      ).toThrow()
      expect(() =>
        Schema.decodeSync(AggregateCommandResult)({
          nextExpectedStreamVersion: 0,
          creationStatus: { _tag: "CreatedStream" },
          processingStatus: { _tag: "Processed" },
        }),
      ).toThrow()

      // ExistingStream at version 0
      expect(
        () =>
          new AggregateCommandResult({
            nextExpectedStreamVersion: StreamVersion.make(0),
            creationStatus: { _tag: "ExistingStream" },
            processingStatus: { _tag: "Processed" },
          }),
      ).toThrow()
      expect(() =>
        Schema.decodeSync(AggregateCommandResult)({
          nextExpectedStreamVersion: 0,
          creationStatus: { _tag: "ExistingStream" },
          processingStatus: { _tag: "Processed" },
        }),
      ).toThrow()

      // NoStream at version > 0
      expect(
        () =>
          new AggregateCommandResult({
            nextExpectedStreamVersion: StreamVersion.make(1),
            creationStatus: { _tag: "NoStream" },
            processingStatus: { _tag: "Processed" },
          }),
      ).toThrow()
      expect(() =>
        Schema.decodeSync(AggregateCommandResult)({
          nextExpectedStreamVersion: 1,
          creationStatus: { _tag: "NoStream" },
          processingStatus: { _tag: "Processed" },
        }),
      ).toThrow()
      expect(() =>
        Schema.decodeSync(AggregateCommandResult)({
          nextExpectedStreamVersion: 5,
          creationStatus: { _tag: "NoStream" },
          processingStatus: { _tag: "Processed" },
        }),
      ).toThrow()
    })
  })

  describe("Tagged Errors", () => {
    it("instantiates ConcurrencyConflictError with aggregateId and versions", () => {
      const err = new ConcurrencyConflictError({
        aggregateId: AggregateId.make("cart-1"),
        expectedVersion: StreamVersion.make(1),
        actualVersion: StreamVersion.make(2),
      })
      expect(err._tag).toBe("ConcurrencyConflictError")
      expect(err.aggregateId).toBe("cart-1")
      expect(err.expectedVersion).toBe(1)
      expect(err.actualVersion).toBe(2)
    })

    it("instantiates AggregateNotFoundError", () => {
      const err = new AggregateNotFoundError({
        aggregateId: AggregateId.make("cart-404"),
      })
      expect(err._tag).toBe("AggregateNotFoundError")
      expect(err.aggregateId).toBe("cart-404")
    })

    it("instantiates LocalProjectionNotFoundError", () => {
      const err = new LocalProjectionNotFoundError({
        name: ProjectionName.make("missing-view"),
      })
      expect(err._tag).toBe("LocalProjectionNotFoundError")
      expect(err.name).toBe("missing-view")
    })

    it("instantiates CommandAggregateMismatchError", () => {
      const mismatch = new CommandAggregateMismatchError({
        commandId: CommandId.make("cmd-1"),
        expectedAggregateName: AggregateName.make("Cart"),
        expectedAggregateId: AggregateId.make("cart-1"),
        actualAggregateName: AggregateName.make("Cart"),
        actualAggregateId: AggregateId.make("cart-2"),
      })
      expect(mismatch._tag).toBe("CommandAggregateMismatchError")
    })

    it("instantiates EventStreamCorruptionError with and without optional fields", () => {
      const corruptFull = new EventStreamCorruptionError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        expectedStreamVersion: StreamVersion.make(1),
        actualStreamVersion: StreamVersion.make(3),
        reason: ErrorMessage.make("Non-contiguous version sequence"),
      })
      expect(corruptFull._tag).toBe("EventStreamCorruptionError")
      expect(corruptFull.actualStreamVersion).toBe(3)
      expect(corruptFull.reason).toBe("Non-contiguous version sequence")

      const corruptMinimal = new EventStreamCorruptionError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        expectedStreamVersion: StreamVersion.make(1),
      })
      expect(corruptMinimal._tag).toBe("EventStreamCorruptionError")
      expect(corruptMinimal.actualStreamVersion).toBeUndefined()
      expect(corruptMinimal.reason).toBeUndefined()

      const corruptOnlyActual = new EventStreamCorruptionError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        expectedStreamVersion: StreamVersion.make(1),
        actualStreamVersion: StreamVersion.make(4),
      })
      expect(corruptOnlyActual.actualStreamVersion).toBe(4)
      expect(corruptOnlyActual.reason).toBeUndefined()

      const corruptOnlyReason = new EventStreamCorruptionError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        expectedStreamVersion: StreamVersion.make(1),
        reason: ErrorMessage.make("Invalid JSON payload"),
      })
      expect(corruptOnlyReason.actualStreamVersion).toBeUndefined()
      expect(corruptOnlyReason.reason).toBe("Invalid JSON payload")
    })

    it("instantiates EventSerializationError", () => {
      const serializationErr = new EventSerializationError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(2),
        reason: ErrorMessage.make("Schema decode failed for CartItemAdded"),
      })
      expect(serializationErr._tag).toBe("EventSerializationError")
      expect(serializationErr.aggregateName).toBe("Cart")
      expect(serializationErr.aggregateId).toBe("cart-1")
      expect(serializationErr.streamVersion).toBe(2)
      expect(serializationErr.reason).toBe("Schema decode failed for CartItemAdded")
    })

    it("instantiates OutboxPublishError, ProjectionArchiveCorruptionError, and CrossProjectionNotFoundError", () => {
      const outboxErr = new OutboxPublishError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(1),
        reason: ErrorMessage.make("Queue publish failed"),
      })
      expect(outboxErr._tag).toBe("OutboxPublishError")
      expect(outboxErr.aggregateName).toBe("Cart")
      expect(outboxErr.aggregateId).toBe("cart-1")
      expect(outboxErr.streamVersion).toBe(1)
      expect(outboxErr.reason).toBe("Queue publish failed")

      const archiveErr = new ProjectionArchiveCorruptionError({
        processorId: ProcessorId.make("open-carts-v1"),
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(2),
        reason: ErrorMessage.make("Archive gap detected"),
      })
      expect(archiveErr._tag).toBe("ProjectionArchiveCorruptionError")
      expect(archiveErr.processorId).toBe("open-carts-v1")
      expect(archiveErr.reason).toBe("Archive gap detected")

      const notFoundErr = new CrossProjectionNotFoundError({
        processorId: ProcessorId.make("missing-proj"),
      })
      expect(notFoundErr._tag).toBe("CrossProjectionNotFoundError")
      expect(notFoundErr.processorId).toBe("missing-proj")
    })
  })

  describe("Phase 3 Outbox & Cross-Aggregate Projection Schemas", () => {
    it("decodes valid Phase 3 branded scalars and rejects invalid values", () => {
      const invalidValues: ReadonlyArray<unknown> = [null, undefined, "1", 1.5, Number.NaN]
      expect(Schema.decodeSync(OutboxRowId)(1)).toBe(1)
      expect(() => Schema.decodeSync(OutboxRowId)(0)).toThrow()
      expect(() => Schema.decodeSync(OutboxRowId)(-1)).toThrow()
      for (const bad of invalidValues) {
        expect(() => Schema.decodeUnknownSync(OutboxRowId)(bad)).toThrow()
        expect(() => Schema.decodeUnknownSync(BatchLimit)(bad)).toThrow()
        expect(() => Schema.decodeUnknownSync(AggregateCount)(bad)).toThrow()
      }

      const invalidStrings: ReadonlyArray<unknown> = [null, undefined, 123, ""]
      expect(Schema.decodeSync(EventType)("CartCreated")).toBe("CartCreated")
      expect(Schema.decodeSync(SerializedPayload)('{"_tag":"CartCreated"}')).toBe(
        '{"_tag":"CartCreated"}',
      )
      expect(Schema.decodeSync(ProcessorId)("open-carts-v1")).toBe("open-carts-v1")
      for (const badStr of invalidStrings) {
        expect(() => Schema.decodeUnknownSync(EventType)(badStr)).toThrow()
        expect(() => Schema.decodeUnknownSync(SerializedPayload)(badStr)).toThrow()
        expect(() => Schema.decodeUnknownSync(ProcessorId)(badStr)).toThrow()
      }

      expect(Schema.decodeSync(BatchLimit)(100)).toBe(100)
      expect(() => Schema.decodeSync(BatchLimit)(0)).toThrow()
      expect(() => Schema.decodeSync(BatchLimit)(-5)).toThrow()

      expect(Schema.decodeSync(AggregateCount)(0)).toBe(0)
      expect(Schema.decodeSync(AggregateCount)(5)).toBe(5)
      expect(() => Schema.decodeSync(AggregateCount)(-1)).toThrow()
    })

    it("decodes PublishedEventEnvelope and OutboxDrainOutcome", () => {
      const envelope = Schema.decodeSync(PublishedEventEnvelope)({
        aggregateName: "Cart",
        aggregateId: "cart-1",
        streamVersion: 1,
        eventType: "CartCreated",
        payload: '{"_tag":"CartCreated","cartId":"cart-1"}',
        metadata: {
          aggregateId: "cart-1",
          streamVersion: 1,
          commandId: "cmd-1",
          timestamp: 1700000000000,
        },
      })
      expect(envelope.aggregateName).toBe("Cart")
      expect(envelope.eventType).toBe("CartCreated")

      const emptyOutcome = Schema.decodeSync(OutboxDrainOutcome)({ _tag: "OutboxEmpty" })
      expect(emptyOutcome._tag).toBe("OutboxEmpty")

      const drainedOutcome = Schema.decodeSync(OutboxDrainOutcome)({
        _tag: "OutboxDrained",
        drainedCount: 3,
      })
      expect(drainedOutcome._tag).toBe("OutboxDrained")
    })

    it("decodes ProjectionSequenceInput, ProjectionSequenceDecision, and ProjectionCatchUpStatus", () => {
      const seqInput = Schema.decodeSync(ProjectionSequenceInput)({
        checkpointVersion: 1,
        incomingVersion: 2,
        parkedVersions: [3, 4],
      })
      expect(seqInput.checkpointVersion).toBe(1)
      expect(seqInput.incomingVersion).toBe(2)
      expect(seqInput.parkedVersions).toEqual([3, 4])

      const skipDec = Schema.decodeSync(ProjectionSequenceDecision)({
        _tag: "SkipDuplicateEvent",
        checkpointVersion: 2,
      })
      expect(skipDec._tag).toBe("SkipDuplicateEvent")

      const parkDec = Schema.decodeSync(ProjectionSequenceDecision)({
        _tag: "ParkOutOfOrderEvent",
        expectedVersion: 2,
        parkedVersion: 3,
      })
      expect(parkDec._tag).toBe("ParkOutOfOrderEvent")

      const applyDec = Schema.decodeSync(ProjectionSequenceDecision)({
        _tag: "ApplyContiguousEvents",
        versionsToApply: [2, 3],
        newCheckpointVersion: 3,
      })
      expect(applyDec._tag).toBe("ApplyContiguousEvents")

      const caughtUp = Schema.decodeSync(ProjectionCatchUpStatus)({
        _tag: "CaughtUp",
        archiveAggregatesCount: 2,
      })
      expect(caughtUp._tag).toBe("CaughtUp")

      const lagging = Schema.decodeSync(ProjectionCatchUpStatus)({
        _tag: "Lagging",
        laggingAggregateId: "cart-1",
        checkpointVersion: 1,
        archiveHeadVersion: 3,
      })
      expect(lagging._tag).toBe("Lagging")
    })

    it("enforces PublishedEventEnvelope invariants on streamVersion > 0 and matching metadata identity", () => {
      const validEnvelopePayload = {
        aggregateName: "Cart",
        aggregateId: "cart-1",
        streamVersion: 1,
        eventType: "CartCreated",
        payload: '{"_tag":"CartCreated"}',
        metadata: {
          aggregateId: "cart-1",
          streamVersion: 1,
          commandId: "cmd-1",
          timestamp: 1700000000000,
        },
      }

      // Rejects streamVersion: 0
      expect(() =>
        Schema.decodeSync(PublishedEventEnvelope)({
          ...validEnvelopePayload,
          streamVersion: 0,
          metadata: {
            ...validEnvelopePayload.metadata,
            streamVersion: 0,
          },
        }),
      ).toThrow()
      expect(
        () =>
          new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-1"),
            streamVersion: StreamVersion.make(0),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make('{"_tag":"CartCreated"}'),
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-1"),
              streamVersion: StreamVersion.make(0),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          }),
      ).toThrow()

      // Rejects metadata.aggregateId !== aggregateId
      expect(() =>
        Schema.decodeSync(PublishedEventEnvelope)({
          ...validEnvelopePayload,
          metadata: {
            ...validEnvelopePayload.metadata,
            aggregateId: "cart-2",
          },
        }),
      ).toThrow()
      expect(
        () =>
          new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-1"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make('{"_tag":"CartCreated"}'),
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-2"),
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          }),
      ).toThrow()

      // Rejects metadata.streamVersion !== streamVersion
      expect(() =>
        Schema.decodeSync(PublishedEventEnvelope)({
          ...validEnvelopePayload,
          metadata: {
            ...validEnvelopePayload.metadata,
            streamVersion: 2,
          },
        }),
      ).toThrow()
      expect(
        () =>
          new PublishedEventEnvelope({
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-1"),
            streamVersion: StreamVersion.make(1),
            eventType: EventType.make("CartCreated"),
            payload: SerializedPayload.make('{"_tag":"CartCreated"}'),
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-1"),
              streamVersion: StreamVersion.make(2),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000000),
            }),
          }),
      ).toThrow()
    })

    it("enforces ProjectionSequenceDecision invariants on ParkOutOfOrderEvent and ApplyContiguousEvents", () => {
      // ParkOutOfOrderEvent rejects expectedVersion: 0
      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: 0,
          parkedVersion: 2,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: StreamVersion.make(0),
          parkedVersion: StreamVersion.make(2),
        }),
      ).toThrow()

      // ParkOutOfOrderEvent rejects parkedVersion <= expectedVersion
      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: 2,
          parkedVersion: 2,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: StreamVersion.make(2),
          parkedVersion: StreamVersion.make(2),
        }),
      ).toThrow()

      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: 3,
          parkedVersion: 2,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ParkOutOfOrderEvent",
          expectedVersion: StreamVersion.make(3),
          parkedVersion: StreamVersion.make(2),
        }),
      ).toThrow()

      // ApplyContiguousEvents rejects empty versionsToApply []
      expect(() =>
        Schema.decodeUnknownSync(ProjectionSequenceDecision)({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [],
          newCheckpointVersion: 1,
        }),
      ).toThrow()

      // ApplyContiguousEvents rejects newCheckpointVersion: 0
      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [0],
          newCheckpointVersion: 0,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [StreamVersion.make(0)],
          newCheckpointVersion: StreamVersion.make(0),
        }),
      ).toThrow()

      // ApplyContiguousEvents rejects versionsToApply[last] !== newCheckpointVersion
      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [1, 2],
          newCheckpointVersion: 3,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [StreamVersion.make(1), StreamVersion.make(2)],
          newCheckpointVersion: StreamVersion.make(3),
        }),
      ).toThrow()
    })
  })
})
