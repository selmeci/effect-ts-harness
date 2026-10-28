import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import {
  checkOntologyInvariants,
  decideOntologyInvariants,
  type GovernanceDocReference
} from "../src/index.js"

describe("OntologyInvariants.decide", () => {
  it.effect("passes cleanly with 0 findings on a valid spec and realization graph", () =>
    Effect.gen(function* () {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Gallery",
            status: "accepted",
            path: "libs/sample/docs/specs/0001.md",
            enforcedByFiles: ["libs/sample/domain/src/index.ts"],
            referencedSpans: ["Album.decide"],
            referencedServices: ["PhotoRepo"],
            referencedErrors: ["PhotoNotFoundError"]
          }
        ],
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#Album.decide",
            spanName: "Album.decide",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 10,
            successType: "boolean",
            isStub: false
          }
        ],
        services: [
          {
            tagId: "PhotoRepo",
            name: "PhotoRepo",
            packageTag: "service",
            file: "libs/sample/service/src/index.ts"
          }
        ],
        errors: [
          {
            errorTag: "PhotoNotFoundError",
            file: "libs/sample/contract/src/index.ts"
          }
        ],
        specifiesSymbols: [
          {
            specId: "sample:SPEC-0001",
            targetKey: "libs/sample/domain/src/index.ts#Album.decide",
            targetKind: "EffectFn"
          },
          {
            specId: "sample:SPEC-0001",
            targetKey: "PhotoRepo",
            targetKind: "ServiceTag"
          }
        ]
      })

      const doc: GovernanceDocReference = {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/0001.md",
        status: "accepted",
        referencedSpans: ["Album.decide"],
        referencedServices: ["PhotoRepo"],
        referencedErrors: ["PhotoNotFoundError"],
        markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Album.decide
services:
  - PhotoRepo
errors:
  - PhotoNotFoundError
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | State-driven | While album quota is active, the engine shall decide quota limit. | Album.decide | test |
| REQ-1.2 | Unwanted behaviour | If photo is missing, then the engine shall fail with PhotoNotFoundError. | PhotoNotFoundError | test |
`
      }

      const report = yield* decideOntologyInvariants({
        graph,
        governanceDocs: [doc]
      })

      expect(report.clean).toBe(true)
      expect(report.findings).toEqual([])

      const syncReport = checkOntologyInvariants({
        graph,
        governanceDocs: [doc]
      })
      expect(syncReport.clean).toBe(true)
    })
  )

  it.effect("detects Rule 1: ontology-while-decider-mismatch when State-driven maps to impure fn or non-decider", () =>
    Effect.gen(function* () {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Gallery",
            status: "accepted",
            path: "libs/sample/docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.uploadPhoto", "Impure.decide"],
            referencedServices: ["PhotoRepo"],
            referencedErrors: []
          }
        ],
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
            spanName: "Sample.uploadPhoto",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 10,
            successType: "Photo",
            isStub: false
          },
          {
            qualname: "libs/sample/domain/src/index.ts#impureDecide",
            spanName: "Impure.decide",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 30,
            successType: "boolean",
            isStub: false
          }
        ],
        services: [
          {
            tagId: "PhotoRepo",
            name: "PhotoRepo",
            packageTag: "service",
            file: "libs/sample/service/src/index.ts"
          }
        ],
        requiresService: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#impureDecide",
            tagId: "PhotoRepo"
          }
        ],
        specifiesSymbols: [
          {
            specId: "sample:SPEC-0001",
            targetKey: "libs/sample/domain/src/index.ts#uploadPhoto",
            targetKind: "EffectFn"
          },
          {
            specId: "sample:SPEC-0001",
            targetKey: "libs/sample/domain/src/index.ts#impureDecide",
            targetKind: "EffectFn"
          }
        ]
      })

      const doc: GovernanceDocReference = {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/0001.md",
        status: "accepted",
        markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Sample.uploadPhoto
  - Impure.decide
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | State-driven | While album quota is active, the engine shall run upload. | Sample.uploadPhoto | test |
| REQ-1.2 | State-driven | While album quota is active, the engine shall decide quota. | Impure.decide | test |
`
      }

      const report = yield* decideOntologyInvariants({
        graph,
        governanceDocs: [doc]
      })

      expect(report.clean).toBe(false)
      const kinds = report.findings.map((f) => f.kind)
      expect(kinds).toContain("ontology-while-decider-mismatch")
      expect(report.findings.some((f) => f.nodeId === "sample:SPEC-0001:REQ-1.1")).toBe(true)
      expect(report.findings.some((f) => f.nodeId === "sample:SPEC-0001:REQ-1.2")).toBe(true)
    })
  )

  it.effect("detects Rule 2: ontology-if-then-error-mismatch when errors are unreferenced or undeclared", () =>
    Effect.gen(function* () {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Gallery",
            status: "accepted",
            path: "libs/sample/docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: [],
            referencedServices: [],
            referencedErrors: ["UnreferencedError", "DeclaredError"]
          }
        ],
        errors: [
          { errorTag: "UnreferencedError", file: "libs/sample/contract/src/index.ts" },
          { errorTag: "DeclaredError", file: "libs/sample/contract/src/index.ts" },
          { errorTag: "MissingFromFrontmatterError", file: "libs/sample/contract/src/index.ts" }
        ]
      })

      const doc: GovernanceDocReference = {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/0001.md",
        status: "accepted",
        referencedErrors: ["UnreferencedError", "DeclaredError"],
        markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
errors:
  - UnreferencedError
  - DeclaredError
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Unwanted behaviour | If quota is exceeded, then the engine shall fail with DeclaredError. | DeclaredError | test |
| REQ-1.2 | Unwanted behaviour | If validation fails, then the engine shall fail with MissingFromFrontmatterError. | MissingFromFrontmatterError | test |
`
      }

      const report = yield* decideOntologyInvariants({
        graph,
        governanceDocs: [doc]
      })

      expect(report.clean).toBe(false)
      expect(
        report.findings.some(
          (f) =>
            f.kind === "ontology-if-then-error-mismatch" &&
            f.nodeId === "sample:SPEC-0001:UnreferencedError"
        )
      ).toBe(true)
      expect(
        report.findings.some(
          (f) =>
            f.kind === "ontology-if-then-error-mismatch" &&
            f.nodeId === "sample:SPEC-0001:REQ-1.2"
        )
      ).toBe(true)
    })
  )

  it.effect("detects Rule 3: ontology-conflicting-requirements when requirements contradict on condition prefix", () =>
    Effect.gen(function* () {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Gallery",
            status: "accepted",
            path: "libs/sample/docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: ["Sample.uploadPhoto"],
            referencedServices: [],
            referencedErrors: []
          }
        ],
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
            spanName: "Sample.uploadPhoto",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 10,
            successType: "Photo",
            isStub: false
          }
        ]
      })

      const doc: GovernanceDocReference = {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/0001.md",
        status: "accepted",
        markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Sample.uploadPhoto
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Event-driven | When a photo upload is submitted, the system shall approve the upload. | Sample.uploadPhoto | test |
| REQ-1.2 | Event-driven | When a photo upload is submitted, the system shall reject the upload. | Sample.uploadPhoto | test |
`
      }

      const report = yield* decideOntologyInvariants({
        graph,
        governanceDocs: [doc]
      })

      expect(report.clean).toBe(false)
      expect(
        report.findings.some(
          (f) =>
            f.kind === "ontology-conflicting-requirements" &&
            f.nodeId.includes("sample:SPEC-0001:REQ-1.1") &&
            f.nodeId.includes("sample:SPEC-0001:REQ-1.2")
        )
      ).toBe(true)
    })
  )

  it.effect("detects Rule 4: ontology-broken-realization-chain when domain function in governed scope lacks ADR or Spec", () =>
    Effect.gen(function* () {
      const graph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "sample:SPEC-0001",
            title: "Photo Gallery",
            status: "accepted",
            path: "libs/sample/docs/specs/0001.md",
            enforcedByFiles: [],
            referencedSpans: [],
            referencedServices: [],
            referencedErrors: []
          }
        ],
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#orphanDomainFn",
            spanName: "Sample.orphanDomainFn",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 55,
            successType: "void",
            isStub: false
          }
        ]
      })

      const report = yield* decideOntologyInvariants({
        graph,
        governanceDocs: []
      })

      expect(report.clean).toBe(false)
      expect(
        report.findings.some(
          (f) =>
            f.kind === "ontology-broken-realization-chain" &&
            f.nodeId === "Sample.orphanDomainFn"
        )
      ).toBe(true)
    })
  )

  it.effect.prop(
    "OntologyInvariants.decide: report clean matches findings length across arbitrary requirement variations",
    {
      reqIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
      hasConflict: Schema.Boolean
    },
    ({ reqIndex, hasConflict }) =>
      Effect.gen(function* () {
        const req2Text = hasConflict
          ? "When a photo upload is requested, the system shall reject the upload."
          : "When a different event occurs, the system shall record metric."

        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "sample:SPEC-0001",
              title: "Photo Gallery",
              status: "accepted",
              path: "libs/sample/docs/specs/0001.md",
              enforcedByFiles: [],
              referencedSpans: ["Sample.uploadPhoto"],
              referencedServices: [],
              referencedErrors: []
            }
          ],
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#uploadPhoto",
              spanName: "Sample.uploadPhoto",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 10,
              successType: "Photo",
              isStub: false
            }
          ],
          specifiesSymbols: [
            {
              specId: "sample:SPEC-0001",
              targetKey: "libs/sample/domain/src/index.ts#uploadPhoto",
              targetKind: "EffectFn"
            }
          ]
        })

        const doc: GovernanceDocReference = {
          id: "sample:SPEC-0001",
          docPath: "libs/sample/docs/specs/0001.md",
          status: "accepted",
          markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Sample.uploadPhoto
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Event-driven | When a photo upload is requested, the system shall approve the upload. | Sample.uploadPhoto | test |
| REQ-1.${reqIndex + 1} | Event-driven | ${req2Text} | Sample.uploadPhoto | test |
`
        }

        const report = yield* decideOntologyInvariants({
          graph,
          governanceDocs: [doc]
        })

        expect(report.clean).toBe(report.findings.length === 0)
        if (hasConflict) {
          expect(report.clean).toBe(false)
          expect(
            report.findings.some(
              (f) => f.kind === "ontology-conflicting-requirements"
            )
          ).toBe(true)
        } else {
          expect(report.clean).toBe(true)
        }
      })
  )

  it.effect("flags Rule 5: ontology-unverified-requirement when graph has VitestCase nodes and requirements lack reaching tests", () =>
    Effect.gen(function* () {
      const fnQualname = "libs/sample/domain/src/index.ts#Album.decide"
      const testId = "libs/sample/domain/test/index.test.ts::suite"

      const doc: GovernanceDocReference = {
        id: "sample:SPEC-0001",
        docPath: "libs/sample/docs/specs/0001.md",
        status: "accepted",
        referencedSpans: ["Album.decide"],
        referencedServices: [],
        referencedErrors: [],
        markdown: `---
id: sample:SPEC-0001
title: Photo Gallery
status: accepted
date: 2026-10-25
enforced_by:
  - libs/sample/domain/src/index.ts
spans:
  - Album.decide
---

# sample:SPEC-0001: Photo Gallery

## Requirements

### Area 1: Quota

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | State-driven | While album quota is active, the engine shall decide quota limit. | Album.decide | PropertyTest |
| REQ-1.2 | Ubiquitous | The system shall decide album status. | Album.decide | UnitTest |
`
      }

      // 1. Graph with VitestCase nodes but NO ExercisesSpan edges
      const graphWithoutExercises = buildHarnessGraph({
        fns: [
          {
            qualname: fnQualname,
            spanName: "Album.decide",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 10,
            successType: "boolean",
            isStub: false
          }
        ],
        tests: [
          {
            testId,
            testFile: "libs/sample/domain/test/index.test.ts",
            testName: "libs/sample/domain/test/index.test.ts",
            lastTreeHash: "workspace",
            isPropertyTest: false
          }
        ]
      })

      const reportUnverified = yield* decideOntologyInvariants({
        graph: graphWithoutExercises,
        governanceDocs: [doc]
      })

      expect(reportUnverified.clean).toBe(false)
      const propFinding = reportUnverified.findings.find(
        (f) =>
          f.kind === "ontology-unverified-requirement" &&
          f.nodeId === "sample:SPEC-0001:REQ-1.1"
      )
      expect(propFinding).toBeDefined()
      expect(propFinding?.message).toContain(
        "claims PropertyTest verification for 'Album.decide' but 0 property tests exercise it"
      )

      const unitFinding = reportUnverified.findings.find(
        (f) =>
          f.kind === "ontology-unverified-requirement" &&
          f.nodeId === "sample:SPEC-0001:REQ-1.2"
      )
      expect(unitFinding).toBeDefined()
      expect(unitFinding?.message).toContain(
        "claims UnitTest verification for 'Album.decide' but 0 tests exercise it"
      )

      // 2. Now add a property test ExercisesSpan edge reaching Album.decide
      const graphWithPropExercises = buildHarnessGraph({
        fns: [
          {
            qualname: fnQualname,
            spanName: "Album.decide",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 10,
            successType: "boolean",
            isStub: false
          }
        ],
        tests: [
          {
            testId,
            testFile: "libs/sample/domain/test/index.test.ts",
            testName: "libs/sample/domain/test/index.test.ts",
            lastTreeHash: "workspace",
            isPropertyTest: true
          }
        ],
        exercisesSpans: [
          {
            testId,
            calleeQualname: fnQualname,
            callCount: 1,
            receiverLayer: null
          }
        ]
      })

      const reportVerified = yield* decideOntologyInvariants({
        graph: graphWithPropExercises,
        governanceDocs: [doc]
      })

      const unverifiedFindings = reportVerified.findings.filter(
        (f) => f.kind === "ontology-unverified-requirement"
      )
      expect(unverifiedFindings).toHaveLength(0)
    })
  )
})
