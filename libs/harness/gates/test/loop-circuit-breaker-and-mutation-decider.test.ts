import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
import {
  checkLoopThrashing,
  decideGraphEntropy,
  decideLoopThrashing,
  decideMutationReport,
  discoverDomainMutants,
  evaluateMutationOutcomes,
  MutantId,
  MutantSourceText,
  type CodeMutant,
  type FrictionEvent,
} from "../src/index.js"

describe("Harness Gates: Loop Circuit Breaker & Mutation Deciders", () => {
  describe("decideLoopThrashing / checkLoopThrashing (LoopCircuitBreaker.decide)", () => {
    it.effect("detects stuck loops when consecutive identical failure events meet threshold", () =>
      Effect.gen(function* () {
        const events: ReadonlyArray<FrictionEvent> = [
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "type error in domain",
            detail: "d1",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "type error in domain",
            detail: "d2",
          },
          {
            kind: "route_miss",
            timestamp: "2026-10-27T10:01:30.000Z",
            summary: "missed route",
            detail: "d3",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: " type error in domain ",
            detail: "d4",
          },
        ]

        const status = yield* decideLoopThrashing(events, 3)
        expect(status.stuck).toBe(true)
        expect(status.consecutiveCount).toBe(3)
        expect(status.threshold).toBe(3)
        expect(status.repeatedKey).toBe("verify_failure::type error in domain")
        expect(status.summary).toBe(" type error in domain ")
        expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(status.escalationMessage).toContain("3 times consecutively")

        const syncStatus = checkLoopThrashing(events, 3)
        expect(syncStatus).toEqual(status)
      }),
    )

    it("resets consecutive streak when failure summary changes and handles empty events", () => {
      const emptyStatus = checkLoopThrashing([])
      expect(emptyStatus.stuck).toBe(false)
      expect(emptyStatus.consecutiveCount).toBe(0)
      expect(emptyStatus.repeatedKey).toBeNull()
      expect(emptyStatus.summary).toBeNull()
      expect(emptyStatus.escalationMessage).toBeNull()

      const events: ReadonlyArray<FrictionEvent> = [
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:00:00.000Z",
          summary: "syntax ban",
          detail: "d1",
        },
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:01:00.000Z",
          summary: "syntax ban",
          detail: "d2",
        },
        {
          kind: "guard_escalation",
          timestamp: "2026-10-27T10:02:00.000Z",
          summary: "alchemy dev",
          detail: "d3",
        },
      ]

      const status = checkLoopThrashing(events, 3)
      expect(status.stuck).toBe(false)
      expect(status.consecutiveCount).toBe(1)
      expect(status.repeatedKey).toBe("guard_escalation::alchemy dev")
    })

    it.effect.prop(
      "LoopCircuitBreaker.decide: stuck is true if and only if consecutive failure count meets or exceeds threshold",
      {
        repeatCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        threshold: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
      },
      ({ repeatCount, threshold }) =>
        Effect.gen(function* () {
          const events: Array<FrictionEvent> = Array.from({ length: repeatCount }, (_, i) => ({
            kind: "verify_failure" as const,
            timestamp: new Date(1000 + i * 1000).toISOString(),
            summary: "tsc error",
            detail: "error detail",
          }))
          const status = yield* decideLoopThrashing(events, threshold)
          const effectiveThreshold = Math.max(2, threshold)
          const expectedStuck = repeatCount >= effectiveThreshold
          expect(status.stuck).toBe(expectedStuck)
          expect(status.consecutiveCount).toBe(repeatCount)
          expect(status.threshold).toBe(effectiveThreshold)
          if (expectedStuck) {
            expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
            expect(status.escalationMessage).toContain("verify_failure")
          } else {
            expect(status.escalationMessage).toBeNull()
          }
        }),
    )
  })

  describe("decider property tests & AST mutation testing", () => {
    it.effect(
      "flags domain *.decide without property-based test and passes when property test exists",
      () =>
        Effect.gen(function* () {
          const fnQualname = "libs/sample/domain/src/index.ts#Album.decide"
          const testId = "libs/sample/domain/test/index.test.ts::suite"

          const graphWithoutProp = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Album.decide",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 14,
                successType: "number",
                isStub: false,
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
                isPropertyTest: false,
              },
            ],
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const failingReport = yield* decideGraphEntropy({
            graph: graphWithoutProp,
            checkDeciderPropertyTests: true,
          })

          expect(failingReport.clean).toBe(false)
          const missing = failingReport.findings.find(
            (f) => f.kind === "missing-decider-property-test",
          )
          expect(missing).toBeDefined()
          expect(missing?.nodeId).toBe("Album.decide")
          expect(missing?.message).toContain("0 Property-Based Tests")

          // Now test with isPropertyTest: true
          const graphWithProp = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Album.decide",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 14,
                successType: "number",
                isStub: false,
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
                isPropertyTest: true,
              },
            ],
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const passingReport = yield* decideGraphEntropy({
            graph: graphWithProp,
            checkDeciderPropertyTests: true,
          })

          const deciderFindings = passingReport.findings.filter(
            (f) => f.kind === "missing-decider-property-test",
          )
          expect(deciderFindings).toHaveLength(0)
        }),
    )

    it("discovers boundary, equality, and arithmetic mutants in domain code", () => {
      let root = process.cwd()
      while (root !== dirname(root)) {
        if (existsSync(join(root, "pnpm-workspace.yaml"))) {
          break
        }
        root = dirname(root)
      }
      const diskSource = readFileSync(join(root, "libs/sample/domain/src/index.ts"), "utf8")
      // diskSource has >= and + 1; append equality operator for comprehensive discovery check
      const sampleSource = `${diskSource}\nconst isExact = (a: number) => a === 100\n`
      const mutants = discoverDomainMutants("libs/sample/domain/src/index.ts", sampleSource)

      const expectedBoundaryLine =
        sampleSource.split("\n").findIndex((l) => l.includes("c >= MAX_PHOTOS_PER_ALBUM")) + 1
      const boundary = mutants.find(
        (m) => m.category === "boundary-operator" && m.original === ">=" && m.replacement === ">",
      )
      expect(boundary).toBeDefined()
      expect(boundary?.line).toBe(expectedBoundaryLine)
      expect(boundary?.mutatedSource).toContain("c > MAX_PHOTOS_PER_ALBUM")

      const expectedArithmeticLine =
        sampleSource.split("\n").findIndex((l) => l.includes("currentCount + 1")) + 1
      const arithmetic = mutants.find(
        (m) =>
          m.category === "arithmetic-operator" && m.original === "+ 1" && m.replacement === "- 1",
      )
      expect(arithmetic).toBeDefined()
      expect(arithmetic?.line).toBe(expectedArithmeticLine)
      expect(arithmetic?.mutatedSource).toContain("currentCount - 1")

      const equality = mutants.find(
        (m) =>
          m.category === "equality-operator" && m.original === "===" && m.replacement === "!==",
      )
      expect(equality).toBeDefined()
      expect(equality?.mutatedSource).toContain("a !== 100")
    })

    it("discovers boolean-return mutants (return true -> return false, return false -> return true)", () => {
      const code = `
export const isEnabled = (x: number): boolean => {
  if (x > 0) {
    return true
  }
  return false
}
`
      const mutants = discoverDomainMutants("libs/sample/contract/src/index.ts", code)
      const boolTrue = mutants.find(
        (m) =>
          m.category === "boolean-return" &&
          m.original === "return true" &&
          m.replacement === "return false",
      )
      expect(boolTrue).toBeDefined()
      expect(boolTrue?.mutatedSource).toContain("return false")

      const boolFalse = mutants.find(
        (m) =>
          m.category === "boolean-return" &&
          m.original === "return false" &&
          m.replacement === "return true",
      )
      expect(boolFalse).toBeDefined()
      expect(boolFalse?.mutatedSource).toContain("return true")
    })

    it("discovers batch-folding and terminal-state-preservation mutants for event sourcing", () => {
      const code = `
export const foldEvents = (events: ReadonlyArray<number>, state: number): number => {
  return events.reduce((acc, ev) => acc + ev, state)
}

export const evolveCart = (state: CartState, event: CartEvent): CartState => {
  if (state._tag === "CheckedOut") {
    return state
  }
  return state
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/index.ts", code)
      const batchFolding = mutants.find(
        (m) => m.category === "batch-folding" && m.original === "events.reduce(",
      )
      expect(batchFolding).toBeDefined()
      expect(batchFolding?.mutatedSource).toContain("events.slice(0, 1).reduce(")

      const terminalPreservation = mutants.find(
        (m) => m.category === "terminal-state-preservation" && m.original === "return state",
      )
      expect(terminalPreservation).toBeDefined()
      expect(terminalPreservation?.mutatedSource).toContain("return initialState")
    })

    it.effect("evaluates mutation outcomes and computes correct mutation score", () =>
      Effect.gen(function* () {
        const dummyMutant1: CodeMutant = {
          id: MutantId.make("test:1:>=->>"),
          file: AstSourceFilePath.make("test.ts"),
          line: SourceLineNumber.make(1),
          category: "boundary-operator",
          original: MutantSourceText.make(">="),
          replacement: MutantSourceText.make(">"),
          mutatedSource: MutantSourceText.make("x > 1"),
        }
        const dummyMutant2: CodeMutant = {
          id: MutantId.make("test:2:+ 1->- 1"),
          file: AstSourceFilePath.make("test.ts"),
          line: SourceLineNumber.make(2),
          category: "arithmetic-operator",
          original: MutantSourceText.make("+ 1"),
          replacement: MutantSourceText.make("- 1"),
          mutatedSource: MutantSourceText.make("x - 1"),
        }

        // All killed -> pass with score 1
        const allKilledReport = evaluateMutationOutcomes([
          { mutant: dummyMutant1, status: "killed" },
          { mutant: dummyMutant2, status: "killed" },
        ])
        expect(allKilledReport.passed).toBe(true)
        expect(allKilledReport.totalMutants).toBe(2)
        expect(allKilledReport.killedCount).toBe(2)
        expect(allKilledReport.survivedCount).toBe(0)
        expect(allKilledReport.mutationScore).toBe(1)
        expect(allKilledReport.survivedMutants).toHaveLength(0)

        // One survived -> fail with survivedMutants listing
        const oneSurvivedReport = yield* decideMutationReport({
          outcomes: [
            { mutant: dummyMutant1, status: "killed" },
            { mutant: dummyMutant2, status: "survived" },
          ],
        })
        expect(oneSurvivedReport.passed).toBe(false)
        expect(oneSurvivedReport.totalMutants).toBe(2)
        expect(oneSurvivedReport.killedCount).toBe(1)
        expect(oneSurvivedReport.survivedCount).toBe(1)
        expect(oneSurvivedReport.mutationScore).toBe(0.5)
        expect(oneSurvivedReport.survivedMutants).toEqual([dummyMutant2])
      }),
    )
  })

  describe("decider property tests & AST mutation testing (continued)", () => {
    it("discovers guard-condition mutants for Equal.equals and Exit.isSuccess", () => {
      const sourceCode = `
export const checkGuard = (actual: unknown, expected: unknown, exit: Exit.Exit<unknown, unknown>) => {
  if (!Equal.equals(actual, expected)) {
    return false
  }
  if (Equal.equals(actual, expected)) {
    return true
  }
  if (Exit.isSuccess(exit)) {
    return true
  }
  return false
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/check.ts", sourceCode)
      const guardMutants = mutants.filter((m) => m.category === "guard-condition")
      expect(guardMutants).toHaveLength(3)

      const notEqualMutant = guardMutants.find((m) => m.original === "if (!Equal.equals(")
      expect(notEqualMutant?.replacement).toBe("if (false && !Equal.equals(")

      const equalMutant = guardMutants.find((m) => m.original === "if (Equal.equals(")
      expect(equalMutant?.replacement).toBe("if (true || Equal.equals(")

      const exitMutant = guardMutants.find((m) => m.original === "if (Exit.isSuccess(")
      expect(exitMutant?.replacement).toBe("if (false && Exit.isSuccess(")
    })

    it("discovers mutants for Effect.die, binary addition, array spread, and terminal state counter copy", () => {
      const sourceCode = `
export const evolve = (s: State, e: Event) => {
  const nextCount = s.itemCount + e.quantity
  const nextItems = [...s.items, { itemId: e.itemId, quantity: e.quantity }]
  return {
    ...s,
    items: nextItems,
    totalItems: s.itemCount,
    failArm: Effect.die(new Error("unexpected defect"))
  }
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/evolve.ts", sourceCode)

      const dieMutant = mutants.find((m) => m.original === "Effect.die(")
      expect(dieMutant).toBeDefined()
      expect(dieMutant?.replacement).toBe("Effect.succeed(")
      expect(dieMutant?.category).toBe("guard-condition")

      const addMutant = mutants.find(
        (m) => m.category === "arithmetic-operator" && m.original === "s.itemCount + e.quantity",
      )
      expect(addMutant).toBeDefined()
      expect(addMutant?.replacement).toBe("s.itemCount - e.quantity")

      const spreadMutant = mutants.find((m) => m.category === "batch-folding")
      expect(spreadMutant).toBeDefined()
      expect(spreadMutant?.replacement).toBe("s.items")

      const counterMutant = mutants.find((m) => m.original === "totalItems: s.itemCount")
      expect(counterMutant).toBeDefined()
      expect(counterMutant?.replacement).toBe("totalItems: 0")
      expect(counterMutant?.category).toBe("arithmetic-operator")
    })
  })
})
