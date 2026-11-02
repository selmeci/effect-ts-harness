import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
  appendFrictionEvent,
  clearFrictionEvents,
  decideFrictionClusters,
  readFrictionEvents,
  resolveHarnessStateDir,
  summarizeFrictionEvents,
  type FrictionEvent
} from "../src/index.js"

describe("Friction log and clustering", () => {
  it.effect("clusters and sorts friction events deterministically", () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<FrictionEvent> = [
        {
          kind: "route_miss",
          timestamp: "2026-10-26T10:00:00.000Z",
          summary: "Missing D1 Route",
          detail: "first miss"
        },
        {
          kind: "verify_failure",
          timestamp: "2026-10-26T11:00:00.000Z",
          summary: "syntax ban error",
          detail: "harness/syntax-bans"
        },
        {
          kind: "route_miss",
          timestamp: "2026-10-26T12:00:00.000Z",
          summary: " missing d1 route ",
          detail: "second miss with latest detail"
        },
        {
          kind: "guard_escalation",
          timestamp: "2026-10-26T09:00:00.000Z",
          summary: "curl command",
          detail: "curl blocked"
        }
      ]

      const clusters = yield* decideFrictionClusters(events)
      expect(clusters.length).toBe(3)

      // Top cluster should be route_miss (2 occurrences)
      expect(clusters[0]).toEqual({
        key: "route_miss::missing d1 route",
        kind: "route_miss",
        summary: " missing d1 route ",
        detail: "second miss with latest detail",
        occurrences: 2,
        lastSeen: "2026-10-26T12:00:00.000Z"
      })

      // Ties sorted by key ascending
      // "guard_escalation::curl command" vs "verify_failure::syntax ban error"
      expect(clusters[1]?.key).toBe("guard_escalation::curl command")
      expect(clusters[1]?.occurrences).toBe(1)
      expect(clusters[2]?.key).toBe("verify_failure::syntax ban error")
      expect(clusters[2]?.occurrences).toBe(1)

      // summarizeFrictionEvents returns identical clusters via Effect.runSync
      const summarized = summarizeFrictionEvents(events)
      expect(summarized).toEqual(clusters)
    })
  )

  it("handles empty events in summarizeFrictionEvents", () => {
    const clusters = summarizeFrictionEvents([])
    expect(clusters).toEqual([])
  })

  it("appends, reads, skips malformed lines, and clears friction log", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-friction-test-"))
    try {
      // 1. readFrictionEvents on non-existent dir/file returns empty
      expect(readFrictionEvents(tempDir)).toEqual([])

      // 2. appendFrictionEvent creates .harness dir and appends JSONL
      const ev1 = appendFrictionEvent(tempDir, {
        kind: "route_miss",
        summary: "Route miss 1",
        detail: "detail 1",
        timestamp: "2026-10-26T12:00:00.000Z"
      })
      expect(ev1.summary).toBe("Route miss 1")
      expect(ev1.timestamp).toBe("2026-10-26T12:00:00.000Z")

      const ev2 = appendFrictionEvent(tempDir, {
        kind: "guard_escalation",
        summary: "rm -rf",
        detail: "blocked destructive command"
      })
      expect(ev2.timestamp).toBeDefined()

      const readBack = readFrictionEvents(tempDir)
      expect(readBack.length).toBe(2)
      expect(readBack[0]).toEqual(ev1)
      expect(readBack[1]?.summary).toBe("rm -rf")

      // 3. Add malformed lines and empty lines to friction-log.jsonl
      const filePath = join(resolveHarnessStateDir(tempDir), "friction-log.jsonl")
      const currentRaw = readFileSync(filePath, "utf-8")
      writeFileSync(
        filePath,
        currentRaw +
          "\n" +
          "not valid json\n" +
          '{"kind":"unknown_kind","timestamp":"2026-10-26T12:00:00.000Z","summary":"bad","detail":"bad"}\n' +
          '{"missing":"fields"}\n' +
          "\n\n",
        "utf-8"
      )

      // Malformed lines are skipped, original 2 remain
      const readFiltered = readFrictionEvents(tempDir)
      expect(readFiltered.length).toBe(2)
      expect(readFiltered[0]).toEqual(ev1)

      // 4. clearFrictionEvents clears the file
      clearFrictionEvents(tempDir)
      expect(readFrictionEvents(tempDir)).toEqual([])
      expect(readFileSync(filePath, "utf-8")).toBe("")

      // 5. clearFrictionEvents works when .harness dir does not exist
      const freshTempDir = mkdtempSync(join(tmpdir(), "harness-friction-fresh-"))
      try {
        clearFrictionEvents(freshTempDir)
        expect(readFrictionEvents(freshTempDir)).toEqual([])
      } finally {
        rmSync(freshTempDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
