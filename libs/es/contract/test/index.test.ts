import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  AggregateCommandResult,
  AggregateId,
  AggregateName,
  AggregateNotFoundError,
  CausationId,
  CommandAggregateMismatchError,
  CommandId,
  CommandProcessingStatus,
  ConcurrencyConflictError,
  CorrelationId,
  EventMetadata,
  EventStreamCorruptionError,
  LocalProjectionNotFoundError,
  OutboxPublicationMode,
  PositiveInt,
  ProjectionName,
  ProjectionVersion,
  StreamCreationStatus,
  StreamVersion,
  TimestampMs
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
    })

    it("rejects empty strings for identifiers", () => {
      expect(() => Schema.decodeSync(CommandId)("")).toThrow()
      expect(() => Schema.decodeSync(AggregateId)("")).toThrow()
      expect(() => Schema.decodeSync(AggregateName)("")).toThrow()
      expect(() => Schema.decodeSync(ProjectionName)("")).toThrow()
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
        causationId: "cause-1"
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
        timestamp: 1700000000000
      })
      expect(minimal.aggregateId).toBe("agg-2")
      expect(minimal.correlationId).toBeUndefined()
    })
  })

  describe("AggregateCommandResult & Status Unions", () => {
    it("decodes valid command results with closed status variants", () => {
      expect(Schema.decodeSync(StreamCreationStatus)({ _tag: "CreatedStream" })._tag).toBe("CreatedStream")
      expect(Schema.decodeSync(StreamCreationStatus)({ _tag: "NoStream" })._tag).toBe("NoStream")
      expect(Schema.decodeSync(CommandProcessingStatus)({ _tag: "Processed" })._tag).toBe("Processed")
      expect(Schema.decodeSync(OutboxPublicationMode)({ _tag: "PublishOutbox" })._tag).toBe("PublishOutbox")
      expect(Schema.decodeSync(OutboxPublicationMode)({ _tag: "SuppressOutbox" })._tag).toBe("SuppressOutbox")

      const res1 = Schema.decodeSync(AggregateCommandResult)({
        nextExpectedStreamVersion: 1,
        creationStatus: { _tag: "CreatedStream" },
        processingStatus: { _tag: "Processed" }
      })
      expect(res1.nextExpectedStreamVersion).toBe(1)
      expect(res1.creationStatus._tag).toBe("CreatedStream")
      expect(res1.processingStatus._tag).toBe("Processed")

      const res2 = Schema.decodeSync(AggregateCommandResult)({
        nextExpectedStreamVersion: 5,
        creationStatus: { _tag: "ExistingStream" },
        processingStatus: { _tag: "Deduplicated" }
      })
      expect(res2.creationStatus._tag).toBe("ExistingStream")
      expect(res2.processingStatus._tag).toBe("Deduplicated")
    })
  })

  describe("Tagged Errors", () => {
    it("instantiates ConcurrencyConflictError with aggregateId and versions", () => {
      const err = new ConcurrencyConflictError({
        aggregateId: AggregateId.make("cart-1"),
        expectedVersion: StreamVersion.make(1),
        actualVersion: StreamVersion.make(2)
      })
      expect(err._tag).toBe("ConcurrencyConflictError")
      expect(err.aggregateId).toBe("cart-1")
      expect(err.expectedVersion).toBe(1)
      expect(err.actualVersion).toBe(2)
    })

    it("instantiates AggregateNotFoundError", () => {
      const err = new AggregateNotFoundError({
        aggregateId: AggregateId.make("cart-404")
      })
      expect(err._tag).toBe("AggregateNotFoundError")
      expect(err.aggregateId).toBe("cart-404")
    })

    it("instantiates LocalProjectionNotFoundError", () => {
      const err = new LocalProjectionNotFoundError({
        name: ProjectionName.make("missing-view")
      })
      expect(err._tag).toBe("LocalProjectionNotFoundError")
      expect(err.name).toBe("missing-view")
    })

    it("instantiates CommandAggregateMismatchError and EventStreamCorruptionError", () => {
      const mismatch = new CommandAggregateMismatchError({
        commandId: CommandId.make("cmd-1"),
        expectedAggregateName: AggregateName.make("Cart"),
        expectedAggregateId: AggregateId.make("cart-1"),
        actualAggregateName: AggregateName.make("Cart"),
        actualAggregateId: AggregateId.make("cart-2")
      })
      expect(mismatch._tag).toBe("CommandAggregateMismatchError")

      const corrupt = new EventStreamCorruptionError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        expectedStreamVersion: StreamVersion.make(1),
        actualStreamVersion: StreamVersion.make(3)
      })
      expect(corrupt._tag).toBe("EventStreamCorruptionError")
    })
  })
})
