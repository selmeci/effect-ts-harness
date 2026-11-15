export { Decider } from "./decider.js"
export {
  type AggregateApiSpecConfig,
  type AggregateApiTestScenario,
  type DeciderTestScenario,
  makeAggregateApiTestHarness,
  makeDeciderTestHarness,
} from "./testing.js"
export {
  type ArchivedEvent,
  applyCrossProjection,
  applyLocalProjection,
  CrossAggregateProjection,
  decideProjectionSequence,
  type HistoricalEvent,
  LocalProjection,
  queryCrossProjection,
  queryLocalProjection,
  rebuildCrossProjection,
  rebuildLocalProjection,
} from "./projection.js"
export type {
  AggregateConfig,
  HandledCommandResult,
  LoadedAggregate,
} from "./aggregate.js"
export { EventBus } from "./outbox.js"
export {
  decideEventSchemaEvolution,
  type EventUpcasterConfig,
  makeEventUpcaster,
  prepareUpdatedEventSnapshots,
  type RegisteredEventUpcaster,
  toEventVersionSnapshot,
  verifyCommittedSnapshotParity,
  verifyEventSchemaEvolution,
} from "./evolution.js"
