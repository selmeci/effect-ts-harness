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

/**
 * Configuration for registering a bidirectional schema transformation between two consecutive versions
 * of an event payload schema.
 */
export interface EventUpcasterConfig<From extends Schema.Top, To extends Schema.Top> {
  readonly eventType: EventType
  readonly fromVersion: EventSchemaVersion
  readonly toVersion: EventSchemaVersion
  readonly from: From
  readonly to: To
  readonly decode: (from: From["Type"]) => To["Encoded"]
  readonly encode: (to: To["Encoded"]) => From["Type"]
}

/**
 * Registered event upcaster combining its metadata link (`EventUpcasterLink`) and composable Effect `Schema.decodeTo` transformation.
 */
export interface RegisteredEventUpcaster<From extends Schema.Top, To extends Schema.Top> {
  readonly link: EventUpcasterLink
  readonly schema: Schema.decodeTo<To, From>
}

/**
 * Constructs a registered event upcaster using `Schema.decodeTo` and `SchemaTransformation.transform`.
 */
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

/**
 * Deterministic UTF-16 code-unit comparator (RFC 8785 JCS ordering), independent of OS/ICU locale settings.
 */
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Recursively canonicalizes a JSON value by sorting object keys in deterministic UTF-16 code-unit order
 * and defining properties via `Object.defineProperty` so `"__proto__"` keys are preserved safely.
 */
const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b))
    const sortedObj: Record<string, unknown> = {}
    for (const [key, val] of entries) {
      Object.defineProperty(sortedObj, key, {
        value: canonicalizeJsonValue(val),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return sortedObj
  }
  return value
}

/**
 * Derives a deterministic, canonical JSON Schema snapshot for a single `(eventType, version)` schema.
 * Fails with `FrozenEventSchemaViolationError` if the schema cannot be converted to a JSON Schema document.
 */
export const toEventVersionSnapshot = Effect.fn("EventSchemaEvolution.snapshot")(
  (
    eventType: EventType,
    version: EventSchemaVersion,
    schema: Schema.Top,
  ): Effect.Effect<EventVersionSnapshotEntry, FrozenEventSchemaViolationError, never> =>
    Effect.try({
      try: () => {
        const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
        const canonicalDoc = canonicalizeJsonValue({
          dialect: doc.dialect,
          schema: doc.schema,
          definitions: doc.definitions,
        })
        const serialized = JSON.stringify(canonicalDoc)
        return new EventVersionSnapshotEntry({
          eventType,
          version,
          jsonSchema: JsonSchemaText.make(serialized),
        })
      },
      catch: (cause) =>
        new FrozenEventSchemaViolationError({
          eventType,
          version,
          reason: ErrorMessage.make(
            `Failed to generate canonical JSON Schema snapshot for ${eventType} v${version}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          ),
        }),
    }),
)

/**
 * Pure decision function evaluating append-only event schema evolution invariants in deterministic order:
 * 1. No duplicate `(eventType, version)` entries in `committedSnapshots` or `currentSnapshots` (`FrozenEventVersionDrifted`).
 * 2. Every committed `(eventType, version)` exists in `currentSnapshots` with an identical canonical `jsonSchema` (`FrozenEventVersionDrifted`).
 * 3. For each `eventType` (sorted by UTF-16 code units), versions start at `1`, are contiguous (`1..N`), and have a registered upcaster for every `v -> v + 1` step (`UnmappedEventVersionJump`).
 * 4. No duplicate or dangling upcaster links in `registeredUpcasters` (`UnmappedEventVersionJump`).
 * 5. Returns `SchemaEvolutionValid({ checkedEventCount })` where `checkedEventCount` is the total number of verified event-version snapshots.
 */
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

  // (c) Group input.currentSnapshots by eventType (sorted by eventType code units ascending, versions ascending)
  const groups = new Map<EventType, Array<EventSchemaVersion>>()
  for (const snap of input.currentSnapshots) {
    const list = groups.get(snap.eventType)
    if (list === undefined) {
      groups.set(snap.eventType, [snap.version])
    } else {
      list.push(snap.version)
    }
  }

  const sortedEventTypes = Array.from(groups.keys()).sort(compareCodeUnits)

  for (const eventType of sortedEventTypes) {
    const versions = (groups.get(eventType) ?? []).sort((a, b) => a - b)
    const firstVersion = versions[0]!
    if (firstVersion !== 1) {
      return Effect.succeed(
        UnmappedEventVersionJump.make({
          eventType,
          fromVersion: EventSchemaVersion.make(1),
          toVersion: firstVersion,
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

  // (d) Check if input.registeredUpcasters contains duplicate (eventType, fromVersion, toVersion) links
  // or links whose fromVersion or toVersion snapshot is missing from input.currentSnapshots
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

  // (e) All checks passed
  return Effect.succeed(
    SchemaEvolutionValid.make({
      checkedEventCount: AggregateCount.make(input.currentSnapshots.length),
    }),
  )
})

/**
 * Verifies event schema evolution invariants and maps invalid decisions to typed errors
 * (`FrozenEventSchemaViolationError` | `MissingEventUpcasterError`).
 */
export const verifyEventSchemaEvolution = Effect.fn("EventSchemaEvolution.verify")(
  function* (
    input: EventSchemaEvolutionInput,
  ): Effect.fn.Return<
    SchemaEvolutionValid,
    FrozenEventSchemaViolationError | MissingEventUpcasterError,
    never
  > {
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
  },
)

/**
 * Enforces strict CI snapshot parity: verifies all evolution invariants AND ensures that every snapshot
 * in `currentSnapshots` has been committed to `committedSnapshots`.
 */
export const verifyCommittedSnapshotParity = Effect.fn("EventSchemaEvolution.verifyParity")(
  function* (
    input: EventSchemaEvolutionInput,
  ): Effect.fn.Return<
    SchemaEvolutionValid,
    FrozenEventSchemaViolationError | MissingEventUpcasterError,
    never
  > {
    const valid = yield* verifyEventSchemaEvolution(input)
    for (const cur of input.currentSnapshots) {
      const isCommitted = input.committedSnapshots.some(
        (c) => c.eventType === cur.eventType && c.version === cur.version,
      )
      if (!isCommitted) {
        return yield* new FrozenEventSchemaViolationError({
          eventType: cur.eventType,
          version: cur.version,
          reason: ErrorMessage.make(
            `Uncommitted event schema version ${cur.eventType} v${cur.version}; run harness check-event-schemas --update to freeze new version`,
          ),
        })
      }
    }
    return valid
  },
)

/**
 * Validates that an `--update` operation is strictly additive and append-only:
 * runs `verifyEventSchemaEvolution` against the already-committed snapshots FIRST so that any mutation or deletion
 * of an existing frozen version (or a missing upcaster for a newly added version) is rejected before writing.
 */
export const prepareUpdatedEventSnapshots = Effect.fn("EventSchemaEvolution.prepareUpdate")(
  function* (
    input: EventSchemaEvolutionInput,
  ): Effect.fn.Return<
    ReadonlyArray<EventVersionSnapshotEntry>,
    FrozenEventSchemaViolationError | MissingEventUpcasterError,
    never
  > {
    yield* verifyEventSchemaEvolution(input)
    return input.currentSnapshots
  },
)
