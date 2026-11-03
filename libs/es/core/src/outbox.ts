import type { Effect } from "effect"
import type { OutboxPublishError, PublishedEventEnvelope } from "@harness/es-contract"

/**
 * Abstract message bus capability for publishing drained outbox envelopes to downstream consumers.
 */
export interface EventBus<Env = never> {
  readonly publish: (
    envelope: PublishedEventEnvelope,
  ) => Effect.Effect<void, OutboxPublishError, Env>
}

export const EventBus = {
  make: <Env = never>(definition: EventBus<Env>): EventBus<Env> => definition,
}
