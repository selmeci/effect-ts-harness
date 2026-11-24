import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Tracer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  extractTriageFailureScope,
  makeFailingDecisionModelLayer,
  triageFailure,
} from "../src/index.js"

describe("REQ-1.6: extractTriageFailureScope & test-timeout-contention triage", () => {
  it("strips passing Vitest lines and returns non-empty fallback when no failure block markers exist", () => {
    const raw = [
      "  ✓ test/alpha.test.ts (3 tests) 12ms",
      "✔ test/beta.test.ts (1 test) 4ms",
      "Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
    ].join("\n")

    expect(extractTriageFailureScope(raw)).toBe(
      "Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
    )
    const passingOnly = "  ✓ test/only-passing.test.ts (1 test) 2ms"
    expect(extractTriageFailureScope(passingOnly)).toBe(passingOnly)
  })

  it("isolates per-task nx run blocks and retains failure diagnostics without resetting on RUN vN", () => {
    const log = [
      "> nx run @harness/passing:verify",
      " RUN  v5.0.3 /repo/libs/harness/passing",
      "  ✓ test/ok.test.ts (2 tests) 5ms",
      "passing-only task stdout that should be ignored",
      "> nx run @harness/first:verify",
      " RUN  v5.0.3 /repo/libs/harness/first",
      "noisy passing stdout that should be ignored",
      " FAIL  test/first.test.ts > suite > case",
      "AssertionError: expected 1 to be 2",
      "> nx run @harness/middle:verify",
      "middle passing stdout to ignore",
      " Failed Tests 1 ",
      "Error: boom in second project",
      " RUN  v5.0.3 /repo/libs/harness/middle-extra",
      "Unhandled Errors",
      "TypeError: bad",
      "> nx run @harness/fourth:verify",
      "fourth task diagnostic line before footer",
      "> nx run @harness/sixth:verify",
      "sixth passing task stdout that must be dropped before runner footer",
      "Mutate stamp does not cover required diff file",
      "Command failed with exit code 1",
      "stderr tail",
      "Failed tasks:",
      "",
      "  - @harness/fourth:verify",
    ].join("\n")

    const scoped = extractTriageFailureScope(log)
    expect(scoped).toContain("FAIL  test/first.test.ts > suite > case")
    expect(scoped).toContain("AssertionError: expected 1 to be 2")
    expect(scoped).toContain("Failed Tests 1")
    expect(scoped).toContain("Error: boom in second project")
    expect(scoped).toContain("fourth task diagnostic line before footer")
    expect(scoped).toContain("Unhandled Errors")
    expect(scoped).toContain("TypeError: bad")
    expect(scoped).toContain("Command failed with exit code 1")
    expect(scoped).toContain("stderr tail")

    expect(scoped).not.toContain("passing-only task stdout")
    expect(scoped).not.toContain("noisy passing stdout")
    expect(scoped).not.toContain("middle passing stdout")
    expect(scoped).not.toContain("sixth passing task stdout")
    expect(scoped).not.toContain("Mutate stamp does not cover")
    expect(scoped).not.toContain("test/ok.test.ts")
  })

  it("preserves pre-footer tsc error TS2322 before Command failed with exit code 2 and Failed tasks", () => {
    const tscLog = [
      "> nx run @harness/passing:typecheck",
      "all good in passing",
      "> nx run @harness/broken:typecheck",
      "libs/harness/broken/src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Command failed with exit code 2",
      "Failed tasks:",
      "  - @harness/broken:typecheck",
    ].join("\n")

    const scoped = extractTriageFailureScope(tscLog)
    expect(scoped).toContain("error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(scoped).toContain("Command failed with exit code 2")
    expect(scoped).not.toContain("all good in passing")
  })

  it.effect(
    "classifies pre-footer oxlint harness(syntax-bans) followed by Failed tasks as mechanical",
    () =>
      Effect.gen(function* () {
        const lintLog = [
          "> nx run @harness/domain:lint",
          "  × harness(syntax-bans): Do not use try/catch in Effect code",
          "   ╭─[libs/harness/domain/src/foo.ts:10:3]",
          "Failed tasks:",
          "  - @harness/domain:lint",
        ].join("\n")

        const res = yield* triageFailure(lintLog).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )

        expect(res.kind).toBe("mechanical")
        expect(res.hint).toContain("Banned syntax in Effect code")
      }),
  )

  it.effect(
    "does not let trailing passing nx run task with mutate text plus runner footer shadow earlier timeout-contention",
    () =>
      Effect.gen(function* () {
        const log = [
          "> nx run @harness/app:verify",
          " FAIL  test/slow.test.ts > timeout case",
          "Error: Test timed out in 5000ms.",
          "> nx run @harness/gates:verify",
          "[mutation-check] Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
          "Command failed with exit code 1",
          "Failed tasks:",
          "",
          "  - @harness/app:verify",
        ].join("\n")

        const res = yield* triageFailure(log).pipe(Effect.provide(makeFailingDecisionModelLayer()))
        expect(res.kind).toBe("mechanical")
        expect(res.hint).toContain("timeout-contention")
        expect(res.hint).not.toContain("Run `pnpm harness mutate --strict`")
      }),
  )

  it.effect(
    "isolates parallel multi-block Nx output and classifies timeout without mutate --strict false positive",
    () =>
      Effect.gen(function* () {
        const multiProjectLog = [
          "> nx run @a:test",
          " RUN  v5.0.3 /repo/libs/a",
          '  ✓ test/mutate.test.ts > enforces "mutate --strict" (4 tests) 20ms',
          "passing output in @a:test",
          "> nx run @b:test",
          " RUN  v5.0.3 /repo/libs/b",
          "  ✓ test/ok.test.ts (1 test) 5ms",
          " FAIL  test/foo.test.ts > bar",
          "Error: Test timed out in 5000ms.",
          "> nx run @c:test",
          "  ✓ test/c.test.ts (2 tests) 3ms",
          "passing output in @c:test",
        ].join("\n")

        const scoped = extractTriageFailureScope(multiProjectLog)
        expect(scoped).not.toContain("mutate --strict")
        expect(scoped).not.toContain("passing output in @a:test")
        expect(scoped).not.toContain("passing output in @c:test")

        const res = yield* triageFailure(multiProjectLog).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )

        expect(res.kind).toBe("mechanical")
        expect(res.hint).toContain("timeout-contention")
        expect(res.hint).toContain("HARNESS_VERIFY_PARALLEL")
        expect(res.hint).not.toContain("mutate --strict")
      }),
  )

  it.effect(
    "classifies unframed Zero mutants evaluated in strict mode as mutate-stamp-coverage and supports case-insensitive timeout spacing",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        const mutateRes = yield* triageFailure(
          "Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
        ).pipe(Effect.provide(failingLayer))
        expect(mutateRes.kind).toBe("mechanical")
        expect(mutateRes.hint).toContain("Run `pnpm harness mutate --strict`")

        const timeoutRes = yield* triageFailure("error: test timed out in 5000 ms").pipe(
          Effect.provide(failingLayer),
        )
        expect(timeoutRes.kind).toBe("mechanical")
        expect(timeoutRes.hint).toContain("timeout-contention")
      }),
  )

  it.effect(
    "passes non-empty fallback to TriageV1 for passing-only output and emits Harness.triageFailure span with decision.definition",
    () =>
      Effect.gen(function* () {
        const seenInputs: Array<string> = []
        const TriageInputSchema = Schema.Struct({ failureOutput: Schema.String })
        const decodeInput = Schema.decodeUnknownEffect(TriageInputSchema)
        const capturingLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              decodeInput(options.state).pipe(
                Effect.orDie,
                Effect.map((decoded) => {
                  seenInputs.push(decoded.failureOutput)
                  return {
                    answers: {
                      kind: {
                        _tag: "Classify",
                        label: "semantic",
                        probabilities: { mechanical: 0.1, semantic: 0.9 },
                      },
                    },
                    usage: { inputTokens: 0, outputTokens: 0 },
                  }
                }),
              ),
          }),
        )

        const recordedSpans: Array<Tracer.NativeSpan> = []
        const testTracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options)
            recordedSpans.push(span)
            return span
          },
        })

        const passingOnly = "✓ test A\n✓ test B"
        expect(extractTriageFailureScope(passingOnly)).toBe(passingOnly)

        const res = yield* triageFailure(passingOnly).pipe(
          Effect.provide(capturingLayer),
          Effect.provideService(Tracer.Tracer, testTracer),
        )
        expect(res.kind).toBe("semantic")
        expect(seenInputs).toHaveLength(1)
        expect(seenInputs[0]).toBe(passingOnly)
        expect(seenInputs[0]?.length).toBeGreaterThan(0)

        const triageSpan = recordedSpans.find((s) => s.name === "Harness.triageFailure")
        expect(triageSpan).toBeDefined()
        expect(triageSpan?.attributes.get("decision.definition")).toBe("TriageV1")
      }),
  )

  it.effect(
    "passes scoped failure output (not raw passing stdout) to DecisionModel TriageV1 fallback",
    () =>
      Effect.gen(function* () {
        const seenInputs: Array<string> = []
        const TriageInputSchema = Schema.Struct({ failureOutput: Schema.String })
        const decodeInput = Schema.decodeUnknownEffect(TriageInputSchema)
        const capturingLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              decodeInput(options.state).pipe(
                Effect.orDie,
                Effect.map((decoded) => {
                  seenInputs.push(decoded.failureOutput)
                  return {
                    answers: {
                      kind: {
                        _tag: "Classify",
                        label: "semantic",
                        probabilities: { mechanical: 0.1, semantic: 0.9 },
                      },
                    },
                    usage: { inputTokens: 0, outputTokens: 0 },
                  }
                }),
              ),
          }),
        )

        const log = [
          "> nx run @harness/passing:verify",
          "  ✓ test/ok.test.ts (1 test) 2ms",
          "passing noise before failure",
          " FAIL  test/semantic.test.ts > logic check",
          "Expected true to be false",
        ].join("\n")

        const res = yield* triageFailure(log).pipe(Effect.provide(capturingLayer))
        expect(res.kind).toBe("semantic")
        expect(seenInputs).toHaveLength(1)
        expect(seenInputs[0]).toContain("FAIL  test/semantic.test.ts > logic check")
        expect(seenInputs[0]).toContain("Expected true to be false")
        expect(seenInputs[0]).not.toContain("passing noise before failure")
        expect(seenInputs[0]).not.toContain("test/ok.test.ts")
      }),
  )
})
