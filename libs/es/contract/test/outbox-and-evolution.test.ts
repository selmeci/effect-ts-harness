import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  AggregateCount,
  AggregateId,
  AggregateName,
  BatchLimit,
  CommandId,
  ErrorMessage,
  EventMetadata,
  EventSchemaEvolutionDecision,
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventUpcasterLink,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
  FrozenEventVersionDrifted,
  JsonSchemaText,
  makeHandledCommandResponseSchema,
  MissingEventUpcasterError,
  OutboxDrainOutcome,
  OutboxRowId,
  ProcessorId,
  ProjectionCatchUpStatus,
  ProjectionSequenceDecision,
  ProjectionSequenceInput,
  PublishedEventEnvelope,
  SchemaEvolutionValid,
  SerializedPayload,
  StreamVersion,
  TimestampMs,
  UnmappedEventVersionJump,
} from "../src/index.js"

describe("@harness/es-contract outbox and schema evolution", () => {
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

      // ApplyContiguousEvents rejects non-contiguous versionsToApply [1, 3] or starting at 0 [0, 1]
      expect(() =>
        Schema.decodeSync(ProjectionSequenceDecision)({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [1, 3],
          newCheckpointVersion: 3,
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [StreamVersion.make(1), StreamVersion.make(3)],
          newCheckpointVersion: StreamVersion.make(3),
        }),
      ).toThrow()
      expect(() =>
        ProjectionSequenceDecision.make({
          _tag: "ApplyContiguousEvents",
          versionsToApply: [StreamVersion.make(0), StreamVersion.make(1)],
          newCheckpointVersion: StreamVersion.make(1),
        }),
      ).toThrow()
    })
  })

  describe("Phase 4 Event Schema Evolution & Command Response Schemas", () => {
    describe("EventSchemaVersion", () => {
      it("decodes positive integers >= 1", () => {
        expect(Schema.decodeSync(EventSchemaVersion)(1)).toBe(1)
        expect(Schema.decodeSync(EventSchemaVersion)(42)).toBe(42)
        expect(EventSchemaVersion.make(1)).toBe(1)
        expect(EventSchemaVersion.make(42)).toBe(42)
      })

      it("rejects 0, negative integers, floats, strings, null, and undefined", () => {
        const str: unknown = "1"
        const nil: unknown = null
        const undef: unknown = undefined
        expect(() => Schema.decodeSync(EventSchemaVersion)(0)).toThrow()
        expect(() => Schema.decodeSync(EventSchemaVersion)(-1)).toThrow()
        expect(() => Schema.decodeSync(EventSchemaVersion)(1.5)).toThrow()
        expect(() => Schema.decodeUnknownSync(EventSchemaVersion)(str)).toThrow()
        expect(() => Schema.decodeUnknownSync(EventSchemaVersion)(nil)).toThrow()
        expect(() => Schema.decodeUnknownSync(EventSchemaVersion)(undef)).toThrow()
        expect(() => EventSchemaVersion.make(0)).toThrow()
        expect(() => EventSchemaVersion.make(-1)).toThrow()
        expect(() => EventSchemaVersion.make(1.5)).toThrow()
      })
    })

    describe("JsonSchemaText", () => {
      it("decodes non-empty strings", () => {
        expect(Schema.decodeSync(JsonSchemaText)("{}")).toBe("{}")
        expect(Schema.decodeSync(JsonSchemaText)("schema-text")).toBe("schema-text")
        expect(JsonSchemaText.make("{}")).toBe("{}")
      })

      it("rejects empty strings and non-strings", () => {
        const nil: unknown = null
        const num: unknown = 123
        expect(() => Schema.decodeSync(JsonSchemaText)("")).toThrow()
        expect(() => Schema.decodeUnknownSync(JsonSchemaText)(nil)).toThrow()
        expect(() => Schema.decodeUnknownSync(JsonSchemaText)(num)).toThrow()
        expect(() => JsonSchemaText.make("")).toThrow()
      })
    })

    describe("EventVersionSnapshotEntry", () => {
      it("decodes and instantiates valid snapshot entries", () => {
        const decoded = Schema.decodeSync(EventVersionSnapshotEntry)({
          eventType: "CartCreated",
          version: 1,
          jsonSchema: "{}",
        })
        expect(decoded.eventType).toBe("CartCreated")
        expect(decoded.version).toBe(1)
        expect(decoded.jsonSchema).toBe("{}")

        const constructed = new EventVersionSnapshotEntry({
          eventType: EventType.make("CartCreated"),
          version: EventSchemaVersion.make(1),
          jsonSchema: JsonSchemaText.make("{}"),
        })
        expect(constructed.eventType).toBe("CartCreated")
        expect(constructed.version).toBe(1)
        expect(constructed.jsonSchema).toBe("{}")
      })

      it("rejects invalid versions, empty eventType, and empty jsonSchema", () => {
        expect(() =>
          Schema.decodeSync(EventVersionSnapshotEntry)({
            eventType: "CartCreated",
            version: 0,
            jsonSchema: "{}",
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeSync(EventVersionSnapshotEntry)({
            eventType: "CartCreated",
            version: -1,
            jsonSchema: "{}",
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeSync(EventVersionSnapshotEntry)({
            eventType: "",
            version: 1,
            jsonSchema: "{}",
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeSync(EventVersionSnapshotEntry)({
            eventType: "CartCreated",
            version: 1,
            jsonSchema: "",
          }),
        ).toThrow()
      })
    })

    describe("EventUpcasterLink", () => {
      it("decodes and instantiates contiguous links where toVersion === fromVersion + 1", () => {
        const decoded = Schema.decodeSync(EventUpcasterLink)({
          eventType: "CartCheckedOut",
          fromVersion: 1,
          toVersion: 2,
        })
        expect(decoded.eventType).toBe("CartCheckedOut")
        expect(decoded.fromVersion).toBe(1)
        expect(decoded.toVersion).toBe(2)

        const constructed = new EventUpcasterLink({
          eventType: EventType.make("CartCheckedOut"),
          fromVersion: EventSchemaVersion.make(1),
          toVersion: EventSchemaVersion.make(2),
        })
        expect(constructed.eventType).toBe("CartCheckedOut")
        expect(constructed.fromVersion).toBe(1)
        expect(constructed.toVersion).toBe(2)
      })

      it("rejects toVersion === fromVersion, toVersion === fromVersion + 2, and toVersion < fromVersion", () => {
        // toVersion === fromVersion
        expect(() =>
          Schema.decodeSync(EventUpcasterLink)({
            eventType: "CartCheckedOut",
            fromVersion: 1,
            toVersion: 1,
          }),
        ).toThrow()
        expect(
          () =>
            new EventUpcasterLink({
              eventType: EventType.make("CartCheckedOut"),
              fromVersion: EventSchemaVersion.make(1),
              toVersion: EventSchemaVersion.make(1),
            }),
        ).toThrow()

        // toVersion === fromVersion + 2
        expect(() =>
          Schema.decodeSync(EventUpcasterLink)({
            eventType: "CartCheckedOut",
            fromVersion: 1,
            toVersion: 3,
          }),
        ).toThrow()
        expect(
          () =>
            new EventUpcasterLink({
              eventType: EventType.make("CartCheckedOut"),
              fromVersion: EventSchemaVersion.make(1),
              toVersion: EventSchemaVersion.make(3),
            }),
        ).toThrow()

        // toVersion < fromVersion
        expect(() =>
          Schema.decodeSync(EventUpcasterLink)({
            eventType: "CartCheckedOut",
            fromVersion: 2,
            toVersion: 1,
          }),
        ).toThrow()
        expect(
          () =>
            new EventUpcasterLink({
              eventType: EventType.make("CartCheckedOut"),
              fromVersion: EventSchemaVersion.make(2),
              toVersion: EventSchemaVersion.make(1),
            }),
        ).toThrow()
      })
    })

    describe("EventSchemaEvolutionInput and EventSchemaEvolutionDecision", () => {
      it("decodes and instantiates valid EventSchemaEvolutionInput", () => {
        const entry = new EventVersionSnapshotEntry({
          eventType: EventType.make("CartCreated"),
          version: EventSchemaVersion.make(1),
          jsonSchema: JsonSchemaText.make("{}"),
        })
        const link = new EventUpcasterLink({
          eventType: EventType.make("CartCheckedOut"),
          fromVersion: EventSchemaVersion.make(1),
          toVersion: EventSchemaVersion.make(2),
        })

        const input = new EventSchemaEvolutionInput({
          committedSnapshots: [entry],
          currentSnapshots: [entry],
          registeredUpcasters: [link],
        })
        expect(input.committedSnapshots.length).toBe(1)
        expect(input.currentSnapshots.length).toBe(1)
        expect(input.registeredUpcasters.length).toBe(1)

        const decoded = Schema.decodeSync(EventSchemaEvolutionInput)({
          committedSnapshots: [{ eventType: "CartCreated", version: 1, jsonSchema: "{}" }],
          currentSnapshots: [{ eventType: "CartCreated", version: 1, jsonSchema: "{}" }],
          registeredUpcasters: [{ eventType: "CartCheckedOut", fromVersion: 1, toVersion: 2 }],
        })
        expect(decoded.committedSnapshots.length).toBe(1)
      })

      it("rejects non-array or invalid entries in EventSchemaEvolutionInput", () => {
        const nonArray: unknown = {
          committedSnapshots: null,
          currentSnapshots: [],
          registeredUpcasters: [],
        }
        expect(() => Schema.decodeUnknownSync(EventSchemaEvolutionInput)(nonArray)).toThrow()
        expect(() =>
          Schema.decodeSync(EventSchemaEvolutionInput)({
            committedSnapshots: [{ eventType: "CartCreated", version: 0, jsonSchema: "{}" }],
            currentSnapshots: [],
            registeredUpcasters: [],
          }),
        ).toThrow()
      })

      it("decodes and instantiates each EventSchemaEvolutionDecision variant", () => {
        const valid = Schema.decodeSync(SchemaEvolutionValid)({
          _tag: "SchemaEvolutionValid",
          checkedEventCount: 4,
        })
        expect(valid._tag).toBe("SchemaEvolutionValid")
        expect(valid.checkedEventCount).toBe(4)

        const validViaUnion = Schema.decodeSync(EventSchemaEvolutionDecision)({
          _tag: "SchemaEvolutionValid",
          checkedEventCount: 4,
        })
        expect(validViaUnion._tag).toBe("SchemaEvolutionValid")

        const validConstructed = SchemaEvolutionValid.make({
          checkedEventCount: AggregateCount.make(4),
        })
        expect(validConstructed._tag).toBe("SchemaEvolutionValid")
        expect(validConstructed.checkedEventCount).toBe(4)

        const drifted = Schema.decodeSync(FrozenEventVersionDrifted)({
          _tag: "FrozenEventVersionDrifted",
          eventType: "CartCreated",
          version: 1,
          reason: "schema modified",
        })
        expect(drifted._tag).toBe("FrozenEventVersionDrifted")
        expect(drifted.eventType).toBe("CartCreated")
        expect(drifted.version).toBe(1)
        expect(drifted.reason).toBe("schema modified")

        const driftedViaUnion = Schema.decodeSync(EventSchemaEvolutionDecision)({
          _tag: "FrozenEventVersionDrifted",
          eventType: "CartCreated",
          version: 1,
          reason: "schema modified",
        })
        expect(driftedViaUnion._tag).toBe("FrozenEventVersionDrifted")

        const driftedConstructed = FrozenEventVersionDrifted.make({
          eventType: EventType.make("CartCreated"),
          version: EventSchemaVersion.make(1),
          reason: ErrorMessage.make("schema modified"),
        })
        expect(driftedConstructed._tag).toBe("FrozenEventVersionDrifted")
        expect(driftedConstructed.eventType).toBe("CartCreated")

        const jump = Schema.decodeSync(UnmappedEventVersionJump)({
          _tag: "UnmappedEventVersionJump",
          eventType: "CartCheckedOut",
          fromVersion: 1,
          toVersion: 3,
          reason: "gap detected",
        })
        expect(jump._tag).toBe("UnmappedEventVersionJump")
        expect(jump.eventType).toBe("CartCheckedOut")
        expect(jump.fromVersion).toBe(1)
        expect(jump.toVersion).toBe(3)
        expect(jump.reason).toBe("gap detected")

        const jumpViaUnion = Schema.decodeSync(EventSchemaEvolutionDecision)({
          _tag: "UnmappedEventVersionJump",
          eventType: "CartCheckedOut",
          fromVersion: 1,
          toVersion: 3,
          reason: "gap detected",
        })
        expect(jumpViaUnion._tag).toBe("UnmappedEventVersionJump")

        const jumpConstructed = UnmappedEventVersionJump.make({
          eventType: EventType.make("CartCheckedOut"),
          fromVersion: EventSchemaVersion.make(1),
          toVersion: EventSchemaVersion.make(3),
          reason: ErrorMessage.make("gap detected"),
        })
        expect(jumpConstructed._tag).toBe("UnmappedEventVersionJump")
        expect(jumpConstructed.fromVersion).toBe(1)
        expect(jumpConstructed.toVersion).toBe(3)
      })

      it("rejects unknown tags or missing fields in EventSchemaEvolutionDecision", () => {
        const unknownDecision: unknown = {
          _tag: "UnknownDecision",
        }
        expect(() =>
          Schema.decodeUnknownSync(EventSchemaEvolutionDecision)(unknownDecision),
        ).toThrow()
        expect(() =>
          Schema.decodeSync(EventSchemaEvolutionDecision)({
            _tag: "SchemaEvolutionValid",
            checkedEventCount: -1,
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeSync(EventSchemaEvolutionDecision)({
            _tag: "FrozenEventVersionDrifted",
            eventType: "CartCreated",
            version: 0,
            reason: "bad",
          }),
        ).toThrow()
      })
    })

    describe("makeHandledCommandResponseSchema", () => {
      const StateSchema = Schema.Struct({ count: Schema.Finite })
      const EventSchema = Schema.TaggedStruct("TestEvent", { value: Schema.String })
      const ResponseSchema = makeHandledCommandResponseSchema(StateSchema, EventSchema)

      it("decodes valid command response envelopes", () => {
        const decoded = Schema.decodeSync(ResponseSchema)({
          state: { count: 3 },
          events: [{ _tag: "TestEvent", value: "hello" }],
          result: {
            nextExpectedStreamVersion: 1,
            creationStatus: { _tag: "CreatedStream" },
            processingStatus: { _tag: "Processed" },
          },
        })
        expect(decoded.state.count).toBe(3)
        expect(decoded.events.length).toBe(1)
        expect(decoded.events[0]?._tag).toBe("TestEvent")
        expect(decoded.result.nextExpectedStreamVersion).toBe(1)
        expect(decoded.result.creationStatus._tag).toBe("CreatedStream")
      })

      it("rejects invalid result, state, or events", () => {
        // Invalid result (CreatedStream at version 0 violates AggregateCommandResult filter)
        expect(() =>
          Schema.decodeSync(ResponseSchema)({
            state: { count: 3 },
            events: [],
            result: {
              nextExpectedStreamVersion: 0,
              creationStatus: { _tag: "CreatedStream" },
              processingStatus: { _tag: "Processed" },
            },
          }),
        ).toThrow()

        // Invalid state
        const invalidState: unknown = {
          state: { count: "not-a-number" },
          events: [],
          result: {
            nextExpectedStreamVersion: 0,
            creationStatus: { _tag: "NoStream" },
            processingStatus: { _tag: "Processed" },
          },
        }
        expect(() => Schema.decodeUnknownSync(ResponseSchema)(invalidState)).toThrow()

        // Invalid event
        const invalidEvent: unknown = {
          state: { count: 1 },
          events: [{ _tag: "WrongEvent", value: 123 }],
          result: {
            nextExpectedStreamVersion: 0,
            creationStatus: { _tag: "NoStream" },
            processingStatus: { _tag: "Processed" },
          },
        }
        expect(() => Schema.decodeUnknownSync(ResponseSchema)(invalidEvent)).toThrow()

        // Valid Deduplicated with empty events
        const validDeduplicated = Schema.decodeSync(ResponseSchema)({
          state: { count: 3 },
          events: [],
          result: {
            nextExpectedStreamVersion: 1,
            creationStatus: { _tag: "ExistingStream" },
            processingStatus: { _tag: "Deduplicated" },
          },
        })
        expect(validDeduplicated.result.processingStatus._tag).toBe("Deduplicated")
        expect(validDeduplicated.events).toEqual([])

        // Invalid Deduplicated with non-empty events
        expect(() =>
          Schema.decodeSync(ResponseSchema)({
            state: { count: 3 },
            events: [{ _tag: "TestEvent", value: "duplicate-event" }],
            result: {
              nextExpectedStreamVersion: 1,
              creationStatus: { _tag: "ExistingStream" },
              processingStatus: { _tag: "Deduplicated" },
            },
          }),
        ).toThrow(/Deduplicated command response requires an empty events array/)
      })
    })

    describe("FrozenEventSchemaViolationError and MissingEventUpcasterError", () => {
      it("instantiates FrozenEventSchemaViolationError with exact fields", () => {
        const error = new FrozenEventSchemaViolationError({
          eventType: EventType.make("CartCreated"),
          version: EventSchemaVersion.make(1),
          reason: ErrorMessage.make("hash mismatch"),
        })
        expect(error._tag).toBe("FrozenEventSchemaViolationError")
        expect(error.eventType).toBe("CartCreated")
        expect(error.version).toBe(1)
        expect(error.reason).toBe("hash mismatch")
      })

      it("instantiates MissingEventUpcasterError with exact fields", () => {
        const error = new MissingEventUpcasterError({
          eventType: EventType.make("CartCheckedOut"),
          fromVersion: EventSchemaVersion.make(1),
          toVersion: EventSchemaVersion.make(2),
          reason: ErrorMessage.make("No link registered"),
        })
        expect(error._tag).toBe("MissingEventUpcasterError")
        expect(error.eventType).toBe("CartCheckedOut")
        expect(error.fromVersion).toBe(1)
        expect(error.toVersion).toBe(2)
        expect(error.reason).toBe("No link registered")
      })
    })
  })
})
