import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AggregateId,
  AggregateName,
  CommandId,
  ErrorMessage,
  EventMetadata,
  EventType,
  OutboxPublishError,
  ProcessorId,
  ProjectionName,
  ProjectionSequenceInput,
  ProjectionVersion,
  PublishedEventEnvelope,
  SerializedPayload,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  applyCrossProjection,
  applyLocalProjection,
  type ArchivedEvent,
  CrossAggregateProjection,
  decideProjectionSequence,
  EventBus,
  LocalProjection,
  queryCrossProjection,
  queryLocalProjection,
  rebuildCrossProjection,
  rebuildLocalProjection,
} from "../src/index.js"

const makeTestEnvelope = (streamVersionNum: number = 1) =>
  new PublishedEventEnvelope({
    aggregateName: AggregateName.make("Cart"),
    aggregateId: AggregateId.make("cart-1"),
    streamVersion: StreamVersion.make(streamVersionNum),
    eventType: EventType.make("CartCreated"),
    payload: SerializedPayload.make('{"_tag":"CartCreated"}'),
    metadata: new EventMetadata({
      aggregateId: AggregateId.make("cart-1"),
      streamVersion: StreamVersion.make(streamVersionNum),
      commandId: CommandId.make(`cmd-${streamVersionNum}`),
      timestamp: TimestampMs.make(1700000000000 + streamVersionNum),
    }),
  })

describe("EventBus Service & Layer Construction", () => {
  it.effect("constructs EventBus with EventBus.make and delivers events via Layer.succeed", () =>
    Effect.gen(function* () {
      const delivered: Array<PublishedEventEnvelope> = []

      const busService = EventBus.make({
        publish: (envelope) =>
          Effect.sync(() => {
            delivered.push(envelope)
          }),
      })

      const busLayer = Layer.succeed(EventBus, busService)

      yield* Effect.gen(function* () {
        const bus = yield* EventBus
        const envelope = makeTestEnvelope(1)
        yield* bus.publish(envelope)
      }).pipe(Effect.provide(busLayer))

      expect(delivered.length).toBe(1)
      expect(delivered[0]?.aggregateId).toBe(AggregateId.make("cart-1"))
      expect(delivered[0]?.streamVersion).toBe(StreamVersion.make(1))
    }),
  )

  it.effect("preserves typed OutboxPublishError when EventBus.publish fails", () =>
    Effect.gen(function* () {
      const expectedError = new OutboxPublishError({
        aggregateName: AggregateName.make("Cart"),
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(1),
        reason: ErrorMessage.make("Kafka broker connection refused"),
      })

      const failingBus = EventBus.make({
        publish: () => Effect.fail(expectedError),
      })

      const busLayer = Layer.succeed(EventBus, failingBus)

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const bus = yield* EventBus
          yield* bus.publish(makeTestEnvelope(1))
        }).pipe(Effect.provide(busLayer)),
      )

      match(exit)
        .with({ _tag: "Failure" }, (failure) => {
          const errorOpt = Cause.findErrorOption(failure.cause)
          match(errorOpt)
            .with({ _tag: "Some" }, (some) => {
              match(some.value)
                .with({ _tag: "OutboxPublishError" }, (err) => {
                  expect(err.reason).toBe(ErrorMessage.make("Kafka broker connection refused"))
                  expect(err.aggregateName).toBe(AggregateName.make("Cart"))
                })
                .exhaustive()
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected Some(OutboxPublishError)")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected publish to fail")
        })
        .exhaustive()
    }),
  )
})

describe("decideProjectionSequence (ProjectionSequence.decide)", () => {
  it.effect("returns SkipDuplicateEvent when incomingVersion < checkpointVersion", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(5),
        incomingVersion: StreamVersion.make(3),
        parkedVersions: [StreamVersion.make(6)],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "SkipDuplicateEvent" }, (d) => {
          expect(d.checkpointVersion).toBe(StreamVersion.make(5))
        })
        .with({ _tag: "ParkOutOfOrderEvent" }, () => {
          expect.unreachable("Expected SkipDuplicateEvent")
        })
        .with({ _tag: "ApplyContiguousEvents" }, () => {
          expect.unreachable("Expected SkipDuplicateEvent")
        })
        .exhaustive()
    }),
  )

  it.effect("returns SkipDuplicateEvent when incomingVersion === checkpointVersion", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(4),
        incomingVersion: StreamVersion.make(4),
        parkedVersions: [],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "SkipDuplicateEvent" }, (d) => {
          expect(d.checkpointVersion).toBe(StreamVersion.make(4))
        })
        .with({ _tag: "ParkOutOfOrderEvent" }, () => {
          expect.unreachable("Expected SkipDuplicateEvent")
        })
        .with({ _tag: "ApplyContiguousEvents" }, () => {
          expect.unreachable("Expected SkipDuplicateEvent")
        })
        .exhaustive()
    }),
  )

  it.effect("returns ParkOutOfOrderEvent when incomingVersion > checkpointVersion + 1", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(2),
        incomingVersion: StreamVersion.make(5),
        parkedVersions: [StreamVersion.make(4)],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "ParkOutOfOrderEvent" }, (d) => {
          expect(d.expectedVersion).toBe(StreamVersion.make(3))
          expect(d.parkedVersion).toBe(StreamVersion.make(5))
        })
        .with({ _tag: "SkipDuplicateEvent" }, () => {
          expect.unreachable("Expected ParkOutOfOrderEvent")
        })
        .with({ _tag: "ApplyContiguousEvents" }, () => {
          expect.unreachable("Expected ParkOutOfOrderEvent")
        })
        .exhaustive()
    }),
  )

  it.effect(
    "returns ApplyContiguousEvents when incomingVersion === checkpointVersion + 1 with empty parked gaps",
    () =>
      Effect.gen(function* () {
        const input = new ProjectionSequenceInput({
          checkpointVersion: StreamVersion.make(0),
          incomingVersion: StreamVersion.make(1),
          parkedVersions: [],
        })

        const decision = yield* decideProjectionSequence(input)

        match(decision)
          .with({ _tag: "ApplyContiguousEvents" }, (d) => {
            expect(d.versionsToApply).toEqual([StreamVersion.make(1)])
            expect(d.newCheckpointVersion).toBe(StreamVersion.make(1))
          })
          .with({ _tag: "SkipDuplicateEvent" }, () => {
            expect.unreachable("Expected ApplyContiguousEvents")
          })
          .with({ _tag: "ParkOutOfOrderEvent" }, () => {
            expect.unreachable("Expected ApplyContiguousEvents")
          })
          .exhaustive()
      }),
  )

  it.effect("returns ApplyContiguousEvents unblocking contiguous parked gaps in order", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(0),
        incomingVersion: StreamVersion.make(1),
        parkedVersions: [StreamVersion.make(3), StreamVersion.make(2)],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "ApplyContiguousEvents" }, (d) => {
          expect(d.versionsToApply).toEqual([
            StreamVersion.make(1),
            StreamVersion.make(2),
            StreamVersion.make(3),
          ])
          expect(d.newCheckpointVersion).toBe(StreamVersion.make(3))
        })
        .with({ _tag: "SkipDuplicateEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .with({ _tag: "ParkOutOfOrderEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .exhaustive()
    }),
  )

  it.effect("returns ApplyContiguousEvents stopping at non-contiguous parked gap", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(0),
        incomingVersion: StreamVersion.make(1),
        parkedVersions: [
          StreamVersion.make(2),
          StreamVersion.make(3),
          StreamVersion.make(5),
          StreamVersion.make(6),
        ],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "ApplyContiguousEvents" }, (d) => {
          expect(d.versionsToApply).toEqual([
            StreamVersion.make(1),
            StreamVersion.make(2),
            StreamVersion.make(3),
          ])
          expect(d.newCheckpointVersion).toBe(StreamVersion.make(3))
        })
        .with({ _tag: "SkipDuplicateEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .with({ _tag: "ParkOutOfOrderEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .exhaustive()
    }),
  )

  it.effect("deduplicates parkedVersions and ignores parked versions at or below checkpoint", () =>
    Effect.gen(function* () {
      const input = new ProjectionSequenceInput({
        checkpointVersion: StreamVersion.make(2),
        incomingVersion: StreamVersion.make(3),
        parkedVersions: [
          StreamVersion.make(1),
          StreamVersion.make(2),
          StreamVersion.make(3),
          StreamVersion.make(4),
          StreamVersion.make(4),
        ],
      })

      const decision = yield* decideProjectionSequence(input)

      match(decision)
        .with({ _tag: "ApplyContiguousEvents" }, (d) => {
          expect(d.versionsToApply).toEqual([StreamVersion.make(3), StreamVersion.make(4)])
          expect(d.newCheckpointVersion).toBe(StreamVersion.make(4))
        })
        .with({ _tag: "SkipDuplicateEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .with({ _tag: "ParkOutOfOrderEvent" }, () => {
          expect.unreachable("Expected ApplyContiguousEvents")
        })
        .exhaustive()
    }),
  )
})

describe("CrossAggregateProjection Lifecycle & Operations", () => {
  const TestReadModel = Schema.Struct({
    cartId: AggregateId,
    totalCount: Schema.Natural,
  })
  type TestReadModel = typeof TestReadModel.Type

  const makeMockProjection = () => {
    let state: TestReadModel = {
      cartId: AggregateId.make("cart-1"),
      totalCount: 0,
    }
    const traceLog: Array<string> = []

    const projection = CrossAggregateProjection.make<string, TestReadModel, void, never, never>({
      processorId: ProcessorId.make("test-processor"),
      aggregateName: AggregateName.make("Cart"),
      eventSchema: Schema.String,
      model: TestReadModel,
      apply: (_event, metadata) =>
        Effect.sync(() => {
          traceLog.push(`apply-${metadata.streamVersion}`)
          state = {
            ...state,
            totalCount: state.totalCount + 1,
          }
        }),
      query: () => Effect.succeed(state),
      purge: Effect.sync(() => {
        traceLog.push("purge")
        state = {
          cartId: AggregateId.make("cart-1"),
          totalCount: 0,
        }
      }),
    })

    return { projection, getTraceLog: () => traceLog, getState: () => state }
  }

  it.effect("applyCrossProjection invokes projection.apply with event and metadata", () =>
    Effect.gen(function* () {
      const { projection, getTraceLog, getState } = makeMockProjection()
      const metadata = new EventMetadata({
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(1),
        commandId: CommandId.make("cmd-1"),
        timestamp: TimestampMs.make(1700000000000),
      })

      yield* applyCrossProjection(projection, "ItemAdded", metadata)

      expect(getTraceLog()).toEqual(["apply-1"])
      expect(getState().totalCount).toBe(1)
    }),
  )

  it.effect("queryCrossProjection returns read model when processorId matches", () =>
    Effect.gen(function* () {
      const { projection } = makeMockProjection()
      const metadata = new EventMetadata({
        aggregateId: AggregateId.make("cart-1"),
        streamVersion: StreamVersion.make(1),
        commandId: CommandId.make("cmd-1"),
        timestamp: TimestampMs.make(1700000000000),
      })
      yield* applyCrossProjection(projection, "ItemAdded", metadata)

      const result = yield* queryCrossProjection(
        [projection],
        ProcessorId.make("test-processor"),
        undefined,
      )

      expect(result.cartId).toBe(AggregateId.make("cart-1"))
      expect(result.totalCount).toBe(1)
    }),
  )

  it.effect(
    "queryCrossProjection fails with CrossProjectionNotFoundError when processorId is missing",
    () =>
      Effect.gen(function* () {
        const { projection } = makeMockProjection()

        const exit = yield* Effect.exit(
          queryCrossProjection([projection], ProcessorId.make("unregistered-processor"), undefined),
        )

        match(exit)
          .with({ _tag: "Failure" }, (failure) => {
            const errorOpt = Cause.findErrorOption(failure.cause)
            match(errorOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CrossProjectionNotFoundError" }, (err) => {
                    expect(err.processorId).toBe(ProcessorId.make("unregistered-processor"))
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected Some(CrossProjectionNotFoundError)")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected queryCrossProjection to fail")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "rebuildCrossProjection executes purge before replaying all archived events in order",
    () =>
      Effect.gen(function* () {
        const { projection, getTraceLog, getState } = makeMockProjection()

        // Apply initial event before rebuild
        const initMeta = new EventMetadata({
          aggregateId: AggregateId.make("cart-1"),
          streamVersion: StreamVersion.make(99),
          commandId: CommandId.make("cmd-init"),
          timestamp: TimestampMs.make(1700000000000),
        })
        yield* applyCrossProjection(projection, "StaleEvent", initMeta)
        expect(getState().totalCount).toBe(1)

        const archivedEvents: ReadonlyArray<ArchivedEvent<string>> = [
          {
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-1"),
            event: "ItemAdded",
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-1"),
              streamVersion: StreamVersion.make(1),
              commandId: CommandId.make("cmd-1"),
              timestamp: TimestampMs.make(1700000000001),
            }),
          },
          {
            aggregateName: AggregateName.make("Cart"),
            aggregateId: AggregateId.make("cart-1"),
            event: "ItemAdded",
            metadata: new EventMetadata({
              aggregateId: AggregateId.make("cart-1"),
              streamVersion: StreamVersion.make(2),
              commandId: CommandId.make("cmd-2"),
              timestamp: TimestampMs.make(1700000000002),
            }),
          },
        ]

        yield* rebuildCrossProjection(projection, archivedEvents)

        expect(getTraceLog()).toEqual(["apply-99", "purge", "apply-1", "apply-2"])
        expect(getState().totalCount).toBe(2)
      }),
  )
})

describe("LocalProjection Lifecycle & Operations", () => {
  const LocalReadModel = Schema.Struct({
    aggregateId: AggregateId,
    label: Schema.String,
    count: Schema.Natural,
  })
  type LocalReadModel = typeof LocalReadModel.Type

  const makeMockLocalProjection = (nameStr: string, labelStr: string) => {
    let count = 0
    const traceLog: Array<string> = []

    const projection = LocalProjection.make<string, LocalReadModel>({
      name: ProjectionName.make(nameStr),
      version: ProjectionVersion.make(1),
      model: LocalReadModel,
      apply: (_event, metadata) =>
        Effect.sync(() => {
          traceLog.push(`apply-${metadata.streamVersion}`)
          count += 1
        }),
      query: (aggregateId) =>
        Effect.succeed({
          aggregateId,
          label: labelStr,
          count,
        }),
      rebuild: (_aggregateId, events) =>
        Effect.sync(() => {
          traceLog.push("rebuild")
          count = events.length
        }),
    })

    return { projection, getTraceLog: () => traceLog }
  }

  it.effect(
    "queryLocalProjection selects matching projection by name and rebuildLocalProjection replays events",
    () =>
      Effect.gen(function* () {
        const { projection: projA, getTraceLog } = makeMockLocalProjection("proj_a", "alpha")
        const { projection: projB } = makeMockLocalProjection("proj_b", "beta")

        const meta1 = new EventMetadata({
          aggregateId: AggregateId.make("cart-1"),
          streamVersion: StreamVersion.make(1),
          commandId: CommandId.make("cmd-1"),
          timestamp: TimestampMs.make(1700000000001),
        })

        yield* applyLocalProjection(projA, "ItemAdded", meta1)

        const queriedB = yield* queryLocalProjection(
          [projA, projB],
          ProjectionName.make("proj_b"),
          AggregateId.make("cart-1"),
        )
        expect(queriedB.label).toBe("beta")
        expect(queriedB.count).toBe(0)

        const queriedA = yield* queryLocalProjection(
          [projA, projB],
          ProjectionName.make("proj_a"),
          AggregateId.make("cart-1"),
        )
        expect(queriedA.label).toBe("alpha")
        expect(queriedA.count).toBe(1)

        yield* rebuildLocalProjection(projA, AggregateId.make("cart-1"), [
          { event: "ItemAdded", metadata: meta1 },
          { event: "ItemAdded", metadata: meta1 },
        ])
        expect(getTraceLog()).toEqual(["apply-1", "rebuild"])

        const afterRebuild = yield* queryLocalProjection(
          [projA, projB],
          ProjectionName.make("proj_a"),
          AggregateId.make("cart-1"),
        )
        expect(afterRebuild.count).toBe(2)
      }),
  )

  it.effect(
    "queryLocalProjection fails with LocalProjectionNotFoundError when projectionName is missing",
    () =>
      Effect.gen(function* () {
        const { projection: projA } = makeMockLocalProjection("proj_a", "alpha")

        const exit = yield* Effect.exit(
          queryLocalProjection(
            [projA],
            ProjectionName.make("missing_proj"),
            AggregateId.make("cart-1"),
          ),
        )

        match(exit)
          .with({ _tag: "Failure" }, (failure) => {
            const errorOpt = Cause.findErrorOption(failure.cause)
            match(errorOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "LocalProjectionNotFoundError" }, (err) => {
                    expect(err.name).toBe(ProjectionName.make("missing_proj"))
                  })
                  .with({ _tag: "AggregateNotFoundError" }, () => {
                    expect.unreachable("Expected LocalProjectionNotFoundError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected Some(LocalProjectionNotFoundError)")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected queryLocalProjection to fail")
          })
          .exhaustive()
      }),
  )
})
