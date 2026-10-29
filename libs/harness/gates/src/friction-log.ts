import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { resolveHarnessStateDir } from "./worktree.js"

export const FrictionEventKind = Schema.Literals([
  "route_miss",
  "verify_failure",
  "guard_escalation"
])
export type FrictionEventKind = typeof FrictionEventKind.Type

export const FrictionEvent = Schema.Struct({
  kind: FrictionEventKind,
  timestamp: Schema.String,
  summary: Schema.String,
  detail: Schema.String
})
export type FrictionEvent = typeof FrictionEvent.Type

export interface FrictionCluster {
  readonly key: string
  readonly kind: FrictionEventKind
  readonly summary: string
  readonly detail: string
  readonly occurrences: number
  readonly lastSeen: string
}

export const decideFrictionClusters = Effect.fn("Friction.decide")(function* (
  events: ReadonlyArray<FrictionEvent>
) {
  yield* Effect.void
  const map = new Map<
    string,
    {
      key: string
      kind: FrictionEventKind
      summary: string
      detail: string
      occurrences: number
      lastSeen: string
    }
  >()

  for (const event of events) {
    const key = `${event.kind}::${event.summary.trim().toLowerCase()}`
    const existing = map.get(key)
    if (existing === undefined) {
      map.set(key, {
        key,
        kind: event.kind,
        summary: event.summary,
        detail: event.detail,
        occurrences: 1,
        lastSeen: event.timestamp
      })
    } else {
      existing.occurrences += 1
      const existingTime = Date.parse(existing.lastSeen)
      const eventTime = Date.parse(event.timestamp)
      const isLater =
        !Number.isNaN(eventTime) && !Number.isNaN(existingTime)
          ? eventTime >= existingTime
          : event.timestamp >= existing.lastSeen
      if (isLater) {
        existing.lastSeen = event.timestamp
        existing.detail = event.detail
        existing.summary = event.summary
      }
    }
  }

  const clusters = Array.from(map.values())
  clusters.sort((a, b) => {
    if (b.occurrences !== a.occurrences) {
      return b.occurrences - a.occurrences
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })

  return clusters as ReadonlyArray<FrictionCluster>
})

export const summarizeFrictionEvents = (
  events: ReadonlyArray<FrictionEvent>
): ReadonlyArray<FrictionCluster> => Effect.runSync(decideFrictionClusters(events))

export interface LoopThrashingStatus {
  readonly stuck: boolean
  readonly consecutiveCount: number
  readonly threshold: number
  readonly repeatedKey: string | null
  readonly summary: string | null
  readonly escalationMessage: string | null
}

export const decideLoopThrashing = Effect.fn("LoopCircuitBreaker.decide")(function* (
  events: ReadonlyArray<FrictionEvent>,
  threshold: number = 3
) {
  yield* Effect.void
  const failures = events.filter(
    (event) =>
      (event.kind === "verify_failure" || event.kind === "guard_escalation") &&
      !(event.kind === "guard_escalation" && event.detail.startsWith("verdict=allow"))
  )
  const effectiveThreshold = Math.max(2, threshold)
  if (failures.length === 0) {
    return {
      stuck: false,
      consecutiveCount: 0,
      threshold: effectiveThreshold,
      repeatedKey: null,
      summary: null,
      escalationMessage: null
    } satisfies LoopThrashingStatus
  }

  const last = failures[failures.length - 1]!
  const lastKey = `${last.kind}::${last.summary.trim().toLowerCase()}`
  let consecutiveCount = 0
  for (let i = failures.length - 1; i >= 0; i--) {
    const ev = failures[i]!
    const key = `${ev.kind}::${ev.summary.trim().toLowerCase()}`
    if (key === lastKey) {
      consecutiveCount += 1
    } else {
      break
    }
  }

  const stuck = consecutiveCount >= effectiveThreshold
  const escalationMessage = stuck
    ? `[ESCALATE: STUCK LOOP DETECTED] Repeated ${last.kind} (${last.summary}) ${consecutiveCount} times consecutively (threshold: ${effectiveThreshold}). Stop retrying variations of the same fix and escalate to the human.`
    : null

  return {
    stuck,
    consecutiveCount,
    threshold: effectiveThreshold,
    repeatedKey: lastKey,
    summary: last.summary,
    escalationMessage
  } satisfies LoopThrashingStatus
})

export const checkLoopThrashing = (
  events: ReadonlyArray<FrictionEvent>,
  threshold: number = 3
): LoopThrashingStatus => Effect.runSync(decideLoopThrashing(events, threshold))

const decodeFrictionEvent = Schema.decodeOption(Schema.fromJsonString(FrictionEvent))

export const appendFrictionEvent = (
  repoRoot: string,
  input: {
    readonly kind: FrictionEventKind
    readonly summary: string
    readonly detail: string
    readonly timestamp?: string | undefined
  }
): FrictionEvent => {
  const record: FrictionEvent = {
    kind: input.kind,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: input.summary,
    detail: input.detail
  }
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(harnessDir)) {
        mkdirSync(harnessDir, { recursive: true })
      }
      appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8")
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
  return record
}

export const readFrictionEvents = (repoRoot: string): ReadonlyArray<FrictionEvent> => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  if (!existsSync(filePath)) {
    return []
  }
  const contentOption = Effect.runSync(
    Effect.try(() => readFileSync(filePath, "utf-8")).pipe(Effect.option)
  )
  if (Option.isNone(contentOption)) {
    return []
  }
  const lines = contentOption.value.split("\n")
  const events: Array<FrictionEvent> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const decoded = decodeFrictionEvent(trimmed)
    if (Option.isSome(decoded)) {
      events.push(decoded.value)
    }
  }
  return events
}

export const clearFrictionEvents = (repoRoot: string): void => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(harnessDir)) {
        mkdirSync(harnessDir, { recursive: true })
      }
      writeFileSync(filePath, "", "utf-8")
    }).pipe(Effect.orElseSucceed(() => undefined))
  )
}
