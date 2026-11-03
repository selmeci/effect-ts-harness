import { Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { stub } from "@harness/gates"
import {
  type BatchLimit,
  type EventStreamCorruptionError,
  type OutboxDrainOutcome,
  type OutboxPublishError,
  OutboxRowId,
} from "@harness/es-contract"
import type { EventBus } from "@harness/es-core"

export const DEFAULT_OUTBOX_BATCH_LIMIT: OutboxRowId = OutboxRowId.make(100)

export const drainAggregateOutbox = Effect.fn("Outbox.drain")(function* <BusEnv = never>(
  eventBus: EventBus<BusEnv>,
  batchLimit?: BatchLimit,
) {
  return yield* stub<
    OutboxDrainOutcome,
    OutboxPublishError | EventStreamCorruptionError | SqlError,
    SqlClient | BusEnv
  >(eventBus, batchLimit)
})
