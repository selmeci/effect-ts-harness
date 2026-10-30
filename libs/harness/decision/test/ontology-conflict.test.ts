import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  assertDecisionLimits,
  checkOntologyInvariants,
  checkOntologyPairConflict,
  decideOntologyInvariants,
  evaluateOntologyConflicts,
  extractOntologyConflictPairs,
  type GovernanceDocReference,
  loadGovernanceDocsFromDisk,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  OntologyConflictV1
} from "../src/index.js"

describe("Ontology Conflict Decision", () => {
  it("keeps OntologyConflictV1 within Ollama System One limits", () => {
    expect(() => assertDecisionLimits(OntologyConflictV1)).not.toThrow()
  })

  it.effect("detects conflict when contradicts probability is high and conflictKind is non-none", () =>
    Effect.gen(function* () {
      const mockLayer = makeMockDecisionModelLayer({
        contradictsProb: 0.9,
        conflictKindLabel: "state-transition-conflict"
      })

      const result = yield* checkOntologyPairConflict({
        sourceId: "sample:SPEC-0001:REQ-1.1",
        sourceText: "When upload is requested, the system shall approve.",
        targetId: "sample:SPEC-0001:REQ-1.2",
        targetText: "When upload is requested, the system shall reject.",
        sharedSymbol: "Sample.uploadPhoto"
      }).pipe(Effect.provide(mockLayer))

      expect(result.hasConflict).toBe(true)
      expect(result.probability).toBe(0.9)
      expect(result.conflictKind).toBe("state-transition-conflict")
      expect(result.reason).toContain("Semantic conflict")
      expect(result.reason).toContain("sample:SPEC-0001:REQ-1.1")
    })
  )

  it.effect("returns no conflict when contradicts probability is low by default", () =>
    Effect.gen(function* () {
      const mockLayer = makeMockDecisionModelLayer()

      const result = yield* checkOntologyPairConflict({
        sourceId: "sample:SPEC-0001:REQ-1.1",
        sourceText: "When upload is requested, the system shall approve.",
        targetId: "sample:SPEC-0001:REQ-1.2",
        targetText: "While album quota is normal, the system shall record metric.",
        sharedSymbol: "Sample.uploadPhoto"
      }).pipe(Effect.provide(mockLayer))

      expect(result.hasConflict).toBe(false)
      expect(result.conflictKind).toBe("none")
      expect(result.reason).toContain("No semantic conflict detected")
    })
  )

  it.effect("falls back gracefully when DecisionModel fails or times out", () =>
    Effect.gen(function* () {
      const failingLayer = makeFailingDecisionModelLayer()

      const result = yield* checkOntologyPairConflict({
        sourceId: "sample:SPEC-0001:REQ-1.1",
        sourceText: "When upload is requested, the system shall approve.",
        targetId: "sample:SPEC-0001:REQ-1.2",
        targetText: "When upload is requested, the system shall reject.",
        sharedSymbol: "Sample.uploadPhoto"
      }).pipe(Effect.provide(failingLayer))

      expect(result.hasConflict).toBe(false)
      expect(result.probability).toBe(0)
      expect(result.conflictKind).toBe("none")
      expect(result.reason).toContain("DecisionModel unavailable or timed out")
    })
  )

  it("re-exports ontology gates utilities correctly", () => {
    expect(typeof decideOntologyInvariants).toBe("function")
    expect(typeof checkOntologyInvariants).toBe("function")
    expect(typeof loadGovernanceDocsFromDisk).toBe("function")
  })

  it("extracts candidate conflict pairs from EARS specs and ADRs", () => {
    const validSpecMd = `---
id: SPEC-0001
title: Photo Upload Spec
status: accepted
---

# Photo Upload Spec

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Event-driven | When a photo is uploaded, the photo service shall process it. | Sample.uploadPhoto | test |
| REQ-1.2 | Event-driven | When a photo is uploaded, the photo service shall deny it immediately. | Sample.uploadPhoto | test |
`

    const validAdrMd = `---
id: ADR-0001
title: Photo Persistence Strategy
status: accepted
referencedSpans:
  - Sample.uploadPhoto
---

# Photo Persistence Strategy

## Context and Problem Statement
How to persist photos.

## Decision Drivers
* Reliability

## Considered Options
* Option 1
* Option 2

## Decision Outcome
**Chosen option:** "Reject all synchronous photo processing"

## Rejected Alternatives
### 1 · Option 2
**Why rejected:** Too slow

## Consequences and Enforcement
### Deterministic Enforcement
| Rule | Component | Enforcement Tool | Verified in CI |
|---|---|---|---|
| No async | Domain | AST Gate | Yes |
`

    const docs: ReadonlyArray<GovernanceDocReference> = [
      {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/SPEC-0001.md",
        status: "accepted",
        markdown: validSpecMd
      },
      {
        id: "sample:ADR-0001",
        docPath: "libs/sample/docs/adr/0001.md",
        status: "accepted",
        referencedSpans: ["Sample.uploadPhoto"],
        markdown: validAdrMd
      }
    ]

    const pairs = extractOntologyConflictPairs(docs, "sample")
    expect(pairs.length).toBeGreaterThanOrEqual(2)

    const specPair = pairs.find((p) => p.targetId === "sample:SPEC-0001#REQ-1.2")
    expect(specPair).toBeDefined()
    expect(specPair?.sourceId).toBe("sample:SPEC-0001#REQ-1.1")
    expect(specPair?.sharedSymbol).toBe("Sample.uploadPhoto")

    const adrPair = pairs.find((p) => p.targetId === "sample:ADR-0001")
    expect(adrPair).toBeDefined()
    expect(adrPair?.targetText).toContain("Reject all synchronous photo processing")
  })

  it.effect("evaluates candidate pairs and collects semantic conflicts", () =>
    Effect.gen(function* () {
      const mockLayer = makeMockDecisionModelLayer({
        contradictsProb: 0.85,
        conflictKindLabel: "state-transition-conflict"
      })

      const pairs = [
        {
          sourceId: "sample:SPEC-0001#REQ-1.1",
          sourceText: "When photo is submitted, the system shall approve.",
          targetId: "sample:SPEC-0001#REQ-1.2",
          targetText: "When photo is submitted, the system shall reject.",
          sharedSymbol: "Sample.uploadPhoto"
        }
      ]

      const conflicts = yield* evaluateOntologyConflicts(pairs).pipe(
        Effect.provide(mockLayer)
      )

      expect(conflicts.length).toBe(1)
      expect(conflicts[0]?.hasConflict).toBe(true)
      expect(conflicts[0]?.conflictKind).toBe("state-transition-conflict")
      expect(conflicts[0]?.sourceId).toBe("sample:SPEC-0001#REQ-1.1")
    })
  )

  it.effect("short-circuits after 1 call when DecisionModel times out or fails on the first pair", () =>
    Effect.gen(function* () {
      let callCount = 0
      const failingLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => {
            callCount++
            return Effect.fail(
              AiError.make({
                module: "DecisionModel",
                method: "decide",
                reason: new AiError.UnknownError({ description: "Unavailable" })
              })
            )
          }
        })
      )

      const pairs = Array.from({ length: 16 }, (_, i) => ({
        sourceId: `sample:SPEC-0001#REQ-${i}`,
        sourceText: `Requirement ${i}`,
        targetId: `sample:SPEC-0001#REQ-${i + 1}`,
        targetText: `Requirement ${i + 1}`,
        sharedSymbol: "Sample.operation"
      }))

      const conflicts = yield* evaluateOntologyConflicts(pairs).pipe(
        Effect.provide(failingLayer)
      )

      expect(conflicts).toEqual([])
      expect(callCount).toBe(1)
    })
  )
})
