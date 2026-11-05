import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import {
  EventSchemaEvolutionInput,
  EventSchemaVersion,
  EventType,
  EventVersionSnapshotEntry,
} from "@harness/es-contract"
import {
  CartCheckedOut,
  CartCheckedOutV2,
  cartCheckedOutV1ToV2,
  CartCreated,
  ItemAdded,
} from "../test/fixtures/cart.ts"
import { toEventVersionSnapshot, verifyEventSchemaEvolution } from "../src/evolution.ts"

const snapshotFileUrl = new URL("../event-snapshots.json", import.meta.url)
const snapshotFilePath = fileURLToPath(snapshotFileUrl)

const computeCurrentSnapshots = Effect.gen(function* () {
  const cartCreatedV1 = yield* toEventVersionSnapshot(
    EventType.make("CartCreated"),
    EventSchemaVersion.make(1),
    CartCreated,
  )
  const itemAddedV1 = yield* toEventVersionSnapshot(
    EventType.make("ItemAdded"),
    EventSchemaVersion.make(1),
    ItemAdded,
  )
  const cartCheckedOutV1 = yield* toEventVersionSnapshot(
    EventType.make("CartCheckedOut"),
    EventSchemaVersion.make(1),
    CartCheckedOut,
  )
  const cartCheckedOutV2 = yield* toEventVersionSnapshot(
    EventType.make("CartCheckedOut"),
    EventSchemaVersion.make(2),
    CartCheckedOutV2,
  )
  return [cartCreatedV1, itemAddedV1, cartCheckedOutV1, cartCheckedOutV2]
})

const main = Effect.gen(function* () {
  const currentSnapshots = yield* computeCurrentSnapshots

  if (process.argv.includes("--update")) {
    const serialized = JSON.stringify(currentSnapshots, null, 2) + "\n"
    writeFileSync(snapshotFilePath, serialized, "utf-8")
    console.log(
      `[check-event-schemas] Updated ${snapshotFilePath} with ${currentSnapshots.length} event snapshots.`,
    )
    return
  }

  if (!existsSync(snapshotFilePath)) {
    console.error(
      `[check-event-schemas] Snapshot file not found at ${snapshotFilePath}. Run with --update to generate.`,
    )
    process.exit(1)
  }

  const raw = readFileSync(snapshotFilePath, "utf-8")
  const committedSnapshots = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(EventVersionSnapshotEntry)),
  )(raw, { onExcessProperty: "error" })

  const input = new EventSchemaEvolutionInput({
    committedSnapshots,
    currentSnapshots,
    registeredUpcasters: [cartCheckedOutV1ToV2.link],
  })

  const valid = yield* verifyEventSchemaEvolution(input)
  const committedKeys = new Set(committedSnapshots.map((s) => `${s.eventType}@v${s.version}`))
  for (const current of currentSnapshots) {
    const key = `${current.eventType}@v${current.version}`
    if (!committedKeys.has(key)) {
      console.error(
        `[check-event-schemas] Event version ${key} is missing from ${snapshotFilePath}. Run with --update to freeze the new event version snapshot.`,
      )
      process.exit(1)
    }
  }
  console.log(
    `[check-event-schemas] Event schema evolution verified: ${valid.checkedEventCount} snapshots valid.`,
  )
})

Effect.runPromise(main).catch((err) => {
  console.error("[check-event-schemas] Verification failed:", err)
  process.exit(1)
})
