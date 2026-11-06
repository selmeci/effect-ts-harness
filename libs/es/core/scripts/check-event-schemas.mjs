import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import {
  ErrorMessage,
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
} from "@harness/es-contract"
import { cartRegisteredUpcasters, computeCartEventSnapshots } from "../test/fixtures/cart.ts"
import { prepareUpdatedEventSnapshots, verifyCommittedSnapshotParity } from "../src/evolution.ts"

const snapshotFileUrl = new URL("../event-snapshots.json", import.meta.url)
const snapshotFilePath = fileURLToPath(snapshotFileUrl)

const loadCommittedSnapshots = (allowMissing) =>
  Effect.gen(function* () {
    if (!existsSync(snapshotFilePath)) {
      if (allowMissing) {
        return []
      }
      return yield* new FrozenEventSchemaViolationError({
        eventType: EventType.make("EventSnapshotsFile"),
        version: EventSchemaVersion.make(1),
        reason: ErrorMessage.make(
          `Snapshot file not found at ${snapshotFilePath}. Run with --update to generate.`,
        ),
      })
    }
    const raw = readFileSync(snapshotFilePath, "utf-8")
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(EventVersionSnapshotEntry)),
    )(raw, { onExcessProperty: "error" })
  })

const main = Effect.gen(function* () {
  const currentSnapshots = yield* computeCartEventSnapshots
  const isUpdate = process.argv.includes("--update")
  const committedSnapshots = yield* loadCommittedSnapshots(isUpdate)

  const input = new EventSchemaEvolutionInput({
    committedSnapshots,
    currentSnapshots,
    registeredUpcasters: cartRegisteredUpcasters,
  })

  if (isUpdate) {
    const validatedSnapshots = yield* prepareUpdatedEventSnapshots(input)
    const serialized = JSON.stringify(validatedSnapshots, null, 2) + "\n"
    writeFileSync(snapshotFilePath, serialized, "utf-8")
    console.log(
      `[check-event-schemas] Updated ${snapshotFilePath} with ${validatedSnapshots.length} verified append-only event snapshots.`,
    )
    return
  }

  const valid = yield* verifyCommittedSnapshotParity(input)
  console.log(
    `[check-event-schemas] Event schema evolution verified: ${valid.checkedEventCount} snapshots valid.`,
  )
})

Effect.runPromise(main).catch((err) => {
  console.error("[check-event-schemas] Verification failed:", err)
  process.exitCode = 1
})
