import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service"
import { resolveHarnessStateDir } from "./worktree.js"

export const FrictionEventKind = Schema.Literals([
  "route_miss",
  "verify_failure",
  "guard_escalation",
])
export type FrictionEventKind = typeof FrictionEventKind.Type

export const FrictionEvent = Schema.Struct({
  kind: FrictionEventKind,
  timestamp: Schema.String,
  summary: Schema.String,
  detail: Schema.String,
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

export const summarizeFrictionEvents = (
  events: ReadonlyArray<FrictionEvent>,
): ReadonlyArray<FrictionCluster> => {
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
        lastSeen: event.timestamp,
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
}

export const decideFrictionClusters = Effect.fn("Friction.decide")(function* (
  events: ReadonlyArray<FrictionEvent>,
) {
  return yield* Effect.succeed(summarizeFrictionEvents(events))
})
export * from "./plan-search.js"
import {
  type PlanSearchCandidate,
  comparePlanSearchCandidates,
} from "./plan-search.js"


export interface LoopThrashingStatus {
  readonly stuck: boolean
  readonly consecutiveCount: number
  readonly threshold: number
  readonly repeatedKey: string | null
  readonly summary: string | null
  readonly escalationMessage: string | null
  readonly recommendedPlanCandidate?: PlanSearchCandidate | undefined
}

export const checkLoopThrashing = (
  events: ReadonlyArray<FrictionEvent>,
  threshold: number = 3,
  planCandidates?: ReadonlyArray<PlanSearchCandidate>,
): LoopThrashingStatus => {
  const failures = events.filter((event) =>
    match(event)
      .with({ kind: "verify_failure" }, () => true)
      .with({ kind: "guard_escalation" }, (ev) => !ev.detail.startsWith("verdict=allow"))
      .with({ kind: "route_miss" }, () => false)
      .exhaustive(),
  )
  const effectiveThreshold = Math.max(2, threshold)
  if (failures.length === 0) {
    return {
      stuck: false,
      consecutiveCount: 0,
      threshold: effectiveThreshold,
      repeatedKey: null,
      summary: null,
      escalationMessage: null,
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
  let recommendedPlanCandidate: PlanSearchCandidate | undefined = undefined
  if (planCandidates !== undefined && planCandidates.length > 0 && consecutiveCount >= 2) {
    const sorted = [...planCandidates].sort(comparePlanSearchCandidates)
    recommendedPlanCandidate = sorted[0]
  }

  const escalationMessage = stuck
    ? `[ESCALATE: STUCK LOOP DETECTED] Repeated ${last.kind} (${last.summary}) ${consecutiveCount} times consecutively (threshold: ${effectiveThreshold}). Stop retrying variations of the same fix and escalate to the human.`
    : null

  return {
    stuck,
    consecutiveCount,
    threshold: effectiveThreshold,
    repeatedKey: lastKey,
    summary: last.summary,
    escalationMessage,
    ...(recommendedPlanCandidate !== undefined ? { recommendedPlanCandidate } : {}),
  } satisfies LoopThrashingStatus
}

export const decideLoopThrashing = Effect.fn("LoopCircuitBreaker.decide")(function* (
  events: ReadonlyArray<FrictionEvent>,
  threshold: number = 3,
  planCandidates?: ReadonlyArray<PlanSearchCandidate>,
): Effect.fn.Return<LoopThrashingStatus, never, never> {
  return yield* Effect.succeed(checkLoopThrashing(events, threshold, planCandidates))
})

const decodeFrictionEvent = Schema.decodeOption(Schema.fromJsonString(FrictionEvent))

export const appendFrictionEvent = (
  repoRoot: string,
  input: {
    readonly kind: FrictionEventKind
    readonly summary: string
    readonly detail: string
    readonly timestamp?: string | undefined
  },
  hostIo: SyncHostIo,
): FrictionEvent => {
  const record: FrictionEvent = {
    kind: input.kind,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: input.summary,
    detail: input.detail,
  }
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  Result.getOrElse(
    Result.try(() => {
      if (!hostIo.existsSync(harnessDir)) {
        hostIo.mkdirRecursiveSync(harnessDir)
      }
      hostIo.appendTextSync(filePath, JSON.stringify(record) + "\n")
    }),
    () => undefined,
  )
  return record
}

export const readFrictionEvents = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<FrictionEvent> => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  if (!hostIo.existsSync(filePath)) {
    return []
  }
  const content = Result.getOrElse(
    Result.try(() => hostIo.readTextSync(filePath)),
    () => null,
  )
  if (content === null) {
    return []
  }
  const lines = content.split("\n")
  const events: Array<FrictionEvent> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const decoded = decodeFrictionEvent(trimmed)
    match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        events.push(value)
      })
      .with({ _tag: "None" }, () => {})
      .exhaustive()
  }
  return events
}

export const clearFrictionEvents = (repoRoot: string, hostIo: SyncHostIo): void => {
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const filePath = join(harnessDir, "friction-log.jsonl")
  Result.getOrElse(
    Result.try(() => {
      if (!hostIo.existsSync(harnessDir)) {
        hostIo.mkdirRecursiveSync(harnessDir)
      }
      hostIo.writeTextSync(filePath, "")
    }),
    () => undefined,
  )
}

