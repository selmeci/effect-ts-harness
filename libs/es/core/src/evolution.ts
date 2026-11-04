import { Effect, Schema, SchemaTransformation } from "effect"
import {
  AggregateCount,
  ErrorMessage,
  type EventSchemaEvolutionDecision,
  type EventSchemaEvolutionInput,
  EventSchemaVersion,
  type EventType,
  EventUpcasterLink,
  EventVersionSnapshotEntry,
  FrozenEventSchemaViolationError,
  FrozenEventVersionDrifted,
  JsonSchemaText,
  MissingEventUpcasterError,
  SchemaEvolutionValid,
  UnmappedEventVersionJump,
} from "@harness/es-contract"
import { match } from "ts-pattern"

export interface EventUpcasterConfig<From extends Schema.Top, To extends Schema.Top> {
  readonly eventType: EventType
  readonly fromVersion: EventSchemaVersion
  readonly toVersion: EventSchemaVersion
  readonly from: From
  readonly to: To
  readonly decode: (from: From["Type"]) => To["Encoded"]
  readonly encode: (to: To["Encoded"]) => From["Type"]
}

export interface RegisteredEventUpcaster<From extends Schema.Top, To extends Schema.Top> {
  readonly link: EventUpcasterLink
  readonly schema: Schema.decodeTo<To, From>
}

export const makeEventUpcaster = <From extends Schema.Top, To extends Schema.Top>(
  config: EventUpcasterConfig<From, To>,
): RegisteredEventUpcaster<From, To> => {
  const link = new EventUpcasterLink({
    eventType: config.eventType,
    fromVersion: config.fromVersion,
    toVersion: config.toVersion,
  })
  const schema = config.from.pipe(
    Schema.decodeTo(
      config.to,
      SchemaTransformation.transform({
        decode: config.decode,
        encode: config.encode,
      }),
    ),
  )
  return { link, schema }
}

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    const sortedObj: Record<string, unknown> = {}
    for (const [key, val] of entries) {
      sortedObj[key] = canonicalizeJsonValue(val)
    }
    return sortedObj
  }
  return value
}

export const toEventVersionSnapshot = Effect.fn("EventSchemaEvolution.snapshot")((
  eventType: EventType,
  version: EventSchemaVersion,
  schema: Schema.Top,
): Effect.Effect<EventVersionSnapshotEntry, never, never> => {
  const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const canonicalDoc = canonicalizeJsonValue({
    dialect: doc.dialect,
    schema: doc.schema,
    definitions: doc.definitions,
  })
  const serialized = JSON.stringify(canonicalDoc)
  return Effect.succeed(
    new EventVersionSnapshotEntry({
      eventType,
      version,
      jsonSchema: JsonSchemaText.make(serialized),
    }),
  )
})

export const decideEventSchemaEvolution = Effect.fn("EventSchemaEvolution.decide")((
  input: EventSchemaEvolutionInput,
): Effect.Effect<EventSchemaEvolutionDecision, never, never> => {
  // (a) Check for duplicate (eventType, version) entries in input.committedSnapshots or input.currentSnapshots
  const committedSeen = new Set<string>()
  for (const snap of input.committedSnapshots) {
    const key = `${snap.eventType}::${snap.version}`
    if (committedSeen.has(key)) {
      return Effect.succeed(
        FrozenEventVersionDrifted.make({
          eventType: snap.eventType,
          version: snap.version,
          reason: ErrorMessage.make(
            `Duplicate event version snapshot in committedSnapshots for ${snap.eventType} v${snap.version}`,
          ),
        }),
      )
    }
    committedSeen.add(key)
  }

  const currentSeen = new Set<string>()
  for (const snap of input.currentSnapshots) {
    const key = `${snap.eventType}::${snap.version}`
    if (currentSeen.has(key)) {
      return Effect.succeed(
        FrozenEventVersionDrifted.make({
          eventType: snap.eventType,
          version: snap.version,
          reason: ErrorMessage.make(
            `Duplicate event version snapshot in currentSnapshots for ${snap.eventType} v${snap.version}`,
          ),
        }),
      )
    }
    currentSeen.add(key)
  }

  // (b) Check every entry committed in input.committedSnapshots
  for (const committed of input.committedSnapshots) {
    const current = input.currentSnapshots.find(
      (c) => c.eventType === committed.eventType && c.version === committed.version,
    )
    if (!current) {
      return Effect.succeed(
        FrozenEventVersionDrifted.make({
          eventType: committed.eventType,
          version: committed.version,
          reason: ErrorMessage.make("Committed event version is missing from currentSnapshots"),
        }),
      )
    }
    if (current.jsonSchema !== committed.jsonSchema) {
      return Effect.succeed(
        FrozenEventVersionDrifted.make({
          eventType: committed.eventType,
          version: committed.version,
          reason: ErrorMessage.make("Committed event version JSON Schema has drifted"),
        }),
      )
    }
  }

  // (c) Group input.currentSnapshots by eventType (sorted by eventType ascending, versions ascending)
  const groups = new Map<EventType, Array<EventSchemaVersion>>()
  for (const snap of input.currentSnapshots) {
    const list = groups.get(snap.eventType)
    if (list === undefined) {
      groups.set(snap.eventType, [snap.version])
    } else {
      list.push(snap.version)
    }
  }

  const sortedEventTypes = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b))

  for (const eventType of sortedEventTypes) {
    const versions = (groups.get(eventType) ?? []).sort((a, b) => a - b)
    if (versions.length === 0) {
      continue
    }
    const firstVersion = versions[0]
    if (firstVersion === undefined || firstVersion !== 1) {
      return Effect.succeed(
        UnmappedEventVersionJump.make({
          eventType,
          fromVersion: EventSchemaVersion.make(1),
          toVersion: firstVersion ?? EventSchemaVersion.make(1),
          reason: ErrorMessage.make("Event version history must start at version 1"),
        }),
      )
    }

    for (let i = 1; i < versions.length; i++) {
      const prevVer = versions[i - 1]!
      const nextVer = versions[i]!
      if (nextVer !== prevVer + 1) {
        return Effect.succeed(
          UnmappedEventVersionJump.make({
            eventType,
            fromVersion: prevVer,
            toVersion: nextVer,
            reason: ErrorMessage.make("Non-contiguous event version gap"),
          }),
        )
      }
      const hasUpcaster = input.registeredUpcasters.some(
        (u) => u.eventType === eventType && u.fromVersion === prevVer && u.toVersion === nextVer,
      )
      if (!hasUpcaster) {
        return Effect.succeed(
          UnmappedEventVersionJump.make({
            eventType,
            fromVersion: prevVer,
            toVersion: nextVer,
            reason: ErrorMessage.make("Missing upcaster for event version transition"),
          }),
        )
      }
    }
  }

  // (d) Also check if input.registeredUpcasters contains duplicate (eventType, fromVersion, toVersion) links
  // or links whose fromVersion or toVersion snapshot is missing from input.currentSnapshots for u.eventType
  const seenUpcasters = new Set<string>()
  for (const u of input.registeredUpcasters) {
    const key = `${u.eventType}::${u.fromVersion}::${u.toVersion}`
    if (seenUpcasters.has(key)) {
      return Effect.succeed(
        UnmappedEventVersionJump.make({
          eventType: u.eventType,
          fromVersion: u.fromVersion,
          toVersion: u.toVersion,
          reason: ErrorMessage.make(
            `Duplicate upcaster link registered for ${u.eventType} from v${u.fromVersion} to v${u.toVersion}`,
          ),
        }),
      )
    }
    seenUpcasters.add(key)
  }

  for (const u of input.registeredUpcasters) {
    const hasFrom = input.currentSnapshots.some(
      (s) => s.eventType === u.eventType && s.version === u.fromVersion,
    )
    const hasTo = input.currentSnapshots.some(
      (s) => s.eventType === u.eventType && s.version === u.toVersion,
    )
    if (!hasFrom || !hasTo) {
      return Effect.succeed(
        UnmappedEventVersionJump.make({
          eventType: u.eventType,
          fromVersion: u.fromVersion,
          toVersion: u.toVersion,
          reason: ErrorMessage.make(
            `Upcaster links to version not present in currentSnapshots for ${u.eventType}`,
          ),
        }),
      )
    }
  }

  // (e) If all checks pass
  return Effect.succeed(
    SchemaEvolutionValid.make({
      checkedEventCount: AggregateCount.make(input.currentSnapshots.length),
    }),
  )
})

export const verifyEventSchemaEvolution = Effect.fn("EventSchemaEvolution.verify")(
  (
    input: EventSchemaEvolutionInput,
  ): Effect.Effect<
    SchemaEvolutionValid,
    FrozenEventSchemaViolationError | MissingEventUpcasterError,
    never
  > =>
    Effect.gen(function* () {
      const decision = yield* decideEventSchemaEvolution(input)
      return yield* match(decision)
        .with({ _tag: "SchemaEvolutionValid" }, (d) => Effect.succeed(d))
        .with({ _tag: "FrozenEventVersionDrifted" }, (d) =>
          Effect.fail(
            new FrozenEventSchemaViolationError({
              eventType: d.eventType,
              version: d.version,
              reason: d.reason,
            }),
          ),
        )
        .with({ _tag: "UnmappedEventVersionJump" }, (d) =>
          Effect.fail(
            new MissingEventUpcasterError({
              eventType: d.eventType,
              fromVersion: d.fromVersion,
              toVersion: d.toVersion,
              reason: d.reason,
            }),
          ),
        )
        .exhaustive()
    }),
)
