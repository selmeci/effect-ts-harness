import { Context, type Effect } from "effect"
import type { OutboxPublishError, PublishedEventEnvelope } from "@harness/es-contract"

/**
 * Abstract message bus capability for publishing drained outbox envelopes to downstream consumers.
 */
export interface EventBus<Env = never, Err = never> {
  readonly publish: (
    envelope: PublishedEventEnvelope,
  ) => Effect.Effect<void, OutboxPublishError | Err, Env>
}

export const EventBus = Object.assign(Context.Service<EventBus>("EventBus"), {
  make: <Env = never, Err = never>(definition: EventBus<Env, Err>): EventBus<Env, Err> =>
    definition,
})
