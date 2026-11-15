import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildHarnessGraph } from "@harness/graph"
import { checkVerifyStamp, computeWorkspaceTreeHash, diffPlanAndImplGraphs, writeVerifyStamp } from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("verify-stamp and plan/impl graph diff", () => {
  it("invalidates verify-stamp.json when a file changes after verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-stamp-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n")
      writeVerifyStamp(dir, testHostIo, "impl/current")
      expect(checkVerifyStamp(dir, testHostIo).valid).toBe(true)

      writeFileSync(join(dir, "file.ts"), "export const x = 2\n")
      const afterEdit = checkVerifyStamp(dir, testHostIo)
      expect(afterEdit.valid).toBe(false)
      if (!afterEdit.valid) {
        expect(afterEdit.reason).toContain("Run harness verify")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores files in .remember directory and preserves verify-stamp validity", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-stamp-remember-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n")
      writeVerifyStamp(dir, testHostIo, "impl/current")
      expect(checkVerifyStamp(dir, testHostIo).valid).toBe(true)

      mkdirSync(join(dir, ".remember"), { recursive: true })
      writeFileSync(join(dir, ".remember", "metadata.json"), '{"lastSeen": 123}\n')
      const afterRememberEdit = checkVerifyStamp(dir, testHostIo)
      expect(afterRememberEdit.valid).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("computeWorkspaceTreeHash skips transient temp-* and __temp_* files cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-stamp-temp-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n")
      const baselineHash = computeWorkspaceTreeHash(dir, testHostIo)
      writeVerifyStamp(dir, testHostIo, "impl/current")

      writeFileSync(join(dir, "temp-probe-123.ts"), "export const tmp = 1\n")
      writeFileSync(join(dir, "__temp_scratch.ts"), "export const tmp2 = 2\n")
      mkdirSync(join(dir, "temp-dir"), { recursive: true })
      writeFileSync(join(dir, "temp-dir", "nested.ts"), "export const nested = 3\n")

      expect(computeWorkspaceTreeHash(dir, testHostIo)).toBe(baselineHash)
      expect(checkVerifyStamp(dir, testHostIo).valid).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handles missing or corrupt verify-stamp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-stamp-missing-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n")
      const missing = checkVerifyStamp(dir, testHostIo)
      expect(missing.valid).toBe(false)
      if (!missing.valid) {
        expect(missing.reason).toContain("Run harness verify")
      }

      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".harness", "verify-stamp.json"), "invalid json content")
      const corrupt = checkVerifyStamp(dir, testHostIo)
      expect(corrupt.valid).toBe(false)
      if (!corrupt.valid) {
        expect(corrupt.reason).toContain("Run harness verify")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("blocks when impl/current still has isStub:true or misses a planned EffectFn", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: true,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const stillStub = diffPlanAndImplGraphs(planGraph, planGraph)
    expect(stillStub.ok).toBe(false)
    expect(stillStub.reasons[0]).toContain("isStub")
  })

  it("passes when impl graph implements planned EffectFn without stubs", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: true,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const implGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: false,
        },
      ],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const green = diffPlanAndImplGraphs(planGraph, implGraph)
    expect(green.ok).toBe(true)
    expect(green.reasons.length).toBe(0)
  })

  it("reports missing planned functions and missing planned services", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "libs/sample/service/src/index.ts#Greeter",
          name: "Greeter",
          file: "libs/sample/service/src/index.ts",
          packageTag: "service",
        },
      ],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const emptyImplGraph = buildHarnessGraph({
      fns: [],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
      requiresService: [],
      failsWith: [],
      providesService: [],
      layerRequires: [],
      tracedCalls: [],
      exercisesSpans: [],
    })

    const diff = diffPlanAndImplGraphs(planGraph, emptyImplGraph)
    expect(diff.ok).toBe(false)
    expect(diff.reasons.some((r) => r.includes("greet"))).toBe(true)
    expect(diff.reasons.some((r) => r.includes("Greeter"))).toBe(true)
  })

  it("diffPlanAndImplGraphs detects missing planned SpecifiesSymbol and GovernsSymbol edges with descriptive reasons", () => {
    const planGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      adrDocs: [
        {
          id: "sample:ADR-0001",
          title: "ADR Title",
          status: "accepted",
          path: "docs/adr/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: ["PhotoRepo"],
          referencedErrors: [],
        },
      ],
      earsSpecs: [
        {
          id: "sample:SPEC-0001",
          title: "Spec Title",
          status: "accepted",
          path: "docs/specs/0001.md",
          enforcedByFiles: [],
          referencedSpans: ["Sample.greet"],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      governsSymbols: [
        {
          adrId: "sample:ADR-0001",
          targetKey: "PhotoRepo",
          targetKind: "ServiceTag",
        },
      ],
      specifiesSymbols: [
        {
          specId: "sample:SPEC-0001",
          targetKey: "libs/sample/domain/src/index.ts#greet",
          targetKind: "EffectFn",
        },
      ],
    })

    const implGraph = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          file: "libs/sample/domain/src/index.ts",
          line: 4,
          packageTag: "domain",
          successType: "string",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "PhotoRepo",
          name: "PhotoRepo",
          packageTag: "service",
          file: "libs/sample/service/src/index.ts",
        },
      ],
      adrDocs: [
        {
          id: "sample:ADR-0001",
          title: "ADR Title",
          status: "accepted",
          path: "docs/adr/0001.md",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: ["PhotoRepo"],
          referencedErrors: [],
        },
      ],
      earsSpecs: [
        {
          id: "sample:SPEC-0001",
          title: "Spec Title",
          status: "accepted",
          path: "docs/specs/0001.md",
          enforcedByFiles: [],
          referencedSpans: ["Sample.greet"],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      governsSymbols: [],
      specifiesSymbols: [],
    })

    const planImplDiff = diffPlanAndImplGraphs(planGraph, implGraph)
    expect(planImplDiff.ok).toBe(false)
    expect(planImplDiff.reasons).toEqual(
      expect.arrayContaining([
        'Missing planned PlaysRole(governing-adr) relation on AdrDoc "sample:ADR-0001" (TraceabilityTuple:governs:sample:ADR-0001->ServiceTag:PhotoRepo -> AdrDoc:sample:ADR-0001)',
        'Missing planned PlaysRole(specifying-ears) relation on EarsSpec "sample:SPEC-0001" (TraceabilityTuple:specifies:sample:SPEC-0001->EffectFn:libs/sample/domain/src/index.ts#greet -> EarsSpec:sample:SPEC-0001)',
      ]),
    )
  })

  it("fails when a planned ServiceLayer or TaggedError is missing in the implementation graph", () => {
    const planGraph = buildHarnessGraph({
      layers: [
        {
          qualname: "libs/sample/infra/src/index.ts#GreeterLive",
          layerKind: "live",
          packageTag: "infra",
          file: "libs/sample/infra/src/index.ts",
        },
      ],
      errors: [
        {
          errorTag: "GreeterError",
          file: "libs/sample/contract/src/index.ts",
        },
      ],
    })

    const emptyImplGraph = buildHarnessGraph({})

    const diff = diffPlanAndImplGraphs(planGraph, emptyImplGraph)
    expect(diff.ok).toBe(false)
    expect(diff.reasons).toContain(
      "Planned ServiceLayer 'libs/sample/infra/src/index.ts#GreeterLive' is missing in implementation graph",
    )
    expect(diff.reasons).toContain(
      "Planned TaggedError 'GreeterError' is missing in implementation graph",
    )
  })
})
