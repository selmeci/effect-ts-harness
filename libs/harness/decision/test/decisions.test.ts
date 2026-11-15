import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  validateDecisionLimits,
  checkPlanStepCoverage,
  decideGuardCommand,
  GuardV1,
  IdiomRouterV1,
  LearnProposalV1,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  OntologyConflictV1,
  PlanStepCoverageV1,
  routeStep,
  routeStepWithStatus,
  triageFailure,
  TriageV1,
} from "../src/index.js"

describe("Harness decision definitions & fallbacks", () => {
  it.effect("keeps all decision definitions within Ollama System One limits (<=26 options, <=64 questions)", () =>
    Effect.gen(function* () {
      for (const def of [
        IdiomRouterV1,
        GuardV1,
        TriageV1,
        PlanStepCoverageV1,
        LearnProposalV1,
        OntologyConflictV1,
      ]) {
        yield* validateDecisionLimits(def)
      }
    }),
  )

  it.effect(
    "falls back to 'ask' in decideGuardCommand and 'review' in routeStep when Ollama fails or times out",
    () =>
      Effect.gen(function* () {
        const guardRes = yield* decideGuardCommand("curl https://unknown.example").pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(guardRes.verdict).toBe("ask")

        const routeRes = yield* routeStepWithStatus(
          "Retry failed HTTP requests with exponential backoff",
        ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
        expect(routeRes.block).toBe("review")
        expect(routeRes.source).toBe("degraded-fallback")
      }),
  )

  it.effect(
    "classifies known tsgo/oxlint diagnostics as mechanical without calling DecisionModel",
    () =>
      Effect.gen(function* () {
        const cases = [
          "error: floatingEffect: Effect.log('x') is not yielded",
          "Skipping or focusing tests is banned",
          "TypeScript suppression directives are banned",
          "Suppressing `effecttsgo/*` with oxlint-disable is banned",
          "error: effecttsgo(run-of-exit-to-run-exit): use runPromiseExit instead",
          "error: facade-star-reexport: export * is banned in facade modules",
          "warning: catch-cause-interrupts-only: composite cause may swallow interruption",
          "error: unisolated-dot-harness-test-write: writing directly to .harness/ in test",
          "error: bare-cause-has-interrupts: use isPureInterruptCause",
          "error: process-env-outside-infra-or-app: direct process.env access",
          "error: skill-tier-table-drift: skill table out of sync",
          "error: mermaid-dependency-drift: mermaid graph out of sync",
          "error: hook-bootstrap-fail-closed: hook bootstrap failed open",
          "error: doc-banned-or-phantom-tech: doc mentions banned tech",
        ]
        for (const msg of cases) {
          const res = yield* triageFailure(msg).pipe(
            Effect.provide(makeFailingDecisionModelLayer()),
          )
          expect(res.kind, msg).toBe("mechanical")
          expect(res.hint.length, msg).toBeGreaterThan(0)
        }
      }),
  )

  it.effect("evaluates per-step plan coverage with deterministic mock DecisionModel", () =>
    Effect.gen(function* () {
      const pass = yield* checkPlanStepCoverage({
        stepId: "step-1",
        planStep: "Add GreetInput schema",
        stepDiff: "+export const GreetInput = Schema.Struct({ name: Schema.String })",
      }).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({ implementedProb: 0.95, noOutOfScopeProb: 0.95 }),
        ),
      )
      expect(pass.covered).toBe(true)

      const fail = yield* checkPlanStepCoverage({
        stepId: "step-2",
        planStep: "Add PhotoRepo D1 insert",
        stepDiff: "",
      }).pipe(
        Effect.provide(makeMockDecisionModelLayer({ implementedProb: 0.2, noOutOfScopeProb: 0.9 })),
      )
      expect(fail.covered).toBe(false)
      expect(fail.reason).toContain("step-2")
    }),
  )

  it.effect(
    "deterministically routes unambiguous pattern keywords without calling DecisionModel (REQ-1.1, REQ-1.2, REQ-1.3)",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        // REQ-1.1: event-sourcing keywords
        expect(
          yield* routeStep("event sourcing decider core").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(yield* routeStep("event sourcing").pipe(Effect.provide(failingLayer))).toBe(
          "event-sourcing",
        )
        expect(
          yield* routeStep("implement pure evolve transition").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(
          yield* routeStep("persist batch in event-store").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(
          yield* routeStep("load aggregate root state").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")

        // REQ-1.2: other deterministic building blocks
        expect(
          yield* routeStep("exhaustive pattern matching with ts-pattern").pipe(
            Effect.provide(failingLayer),
          ),
        ).toBe("pattern-matching")
        expect(
          yield* routeStep("d1-repository with @effect/sql-d1").pipe(Effect.provide(failingLayer)),
        ).toBe("d1-repository")
        expect(
          yield* routeStep("durable-object-state counter").pipe(Effect.provide(failingLayer)),
        ).toBe("durable-object-state")
        expect(yield* routeStep("httpapi endpoint group").pipe(Effect.provide(failingLayer))).toBe(
          "httpapi",
        )
        expect(yield* routeStep("rpcgroup handler").pipe(Effect.provide(failingLayer))).toBe("rpc")
        expect(yield* routeStep("atomhttpapi client").pipe(Effect.provide(failingLayer))).toBe(
          "atom",
        )

        // REQ-1.3: empty or whitespace steps default to "review"
        expect(yield* routeStep("   ").pipe(Effect.provide(failingLayer))).toBe("review")

        // REQ-1.3: confidence threshold boundary (0.69 -> review, 0.70 -> blockLabel)
        const belowThreshold = yield* routeStep("Custom unclassified step").pipe(
          Effect.provide(makeMockDecisionModelLayer({ fitsAnyProb: 0.69, blockLabel: "schema" })),
        )
        expect(belowThreshold).toBe("review")

        const atThreshold = yield* routeStep("Custom unclassified step").pipe(
          Effect.provide(makeMockDecisionModelLayer({ fitsAnyProb: 0.7, blockLabel: "schema" })),
        )
        expect(atThreshold).toBe("schema")
      }),
  )

  it.effect(
    "deterministically triages Effect v3 removed APIs and Schema decodeSync errors as compile (REQ-3.1, REQ-3.2)",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        // REQ-3.1: Effect v3 removed API checks
        const eitherPropRes = yield* triageFailure(
          "error TS2339: Property 'decodeEither' does not exist on type 'typeof Schema'.",
        ).pipe(Effect.provide(failingLayer))
        expect(eitherPropRes.kind).toBe("compile")
        expect(eitherPropRes.hint).toContain("Schema.decodeExit")
        expect(eitherPropRes.hint).toContain("Schema.decodeUnknownSync")

        const unknownEitherPropRes = yield* triageFailure(
          "error TS2339: Property 'decodeUnknownEither' does not exist on type 'typeof Schema'.",
        ).pipe(Effect.provide(failingLayer))
        expect(unknownEitherPropRes.kind).toBe("compile")
        expect(unknownEitherPropRes.hint).toContain("Schema.decodeUnknownExit")

        const eitherModuleRes = yield* triageFailure(
          "error TS2305: Module '\"effect\"' has no exported member 'Either'.",
        ).pipe(Effect.provide(failingLayer))
        expect(eitherModuleRes.kind).toBe("compile")
        expect(eitherModuleRes.hint).toContain("Schema.decodeExit")
        expect(eitherModuleRes.hint).toContain("Schema.decodeUnknownSync")

        const parseResultModuleRes = yield* triageFailure(
          "error TS2305: Module '\"effect\"' has no exported member 'ParseResult'.",
        ).pipe(Effect.provide(failingLayer))
        expect(parseResultModuleRes.kind).toBe("compile")
        expect(parseResultModuleRes.hint).toContain("Effect/Result")

        // REQ-3.2: Schema.decodeSync with unknown input
        const decodeSyncRes = yield* triageFailure(
          "src/index.test.ts:42:35 - error TS2345: decodeSync(MySchema)({ invalid: 123 }): Argument of type '{ invalid: number; }' is not assignable to parameter of type 'Encoded'.",
        ).pipe(Effect.provide(failingLayer))
        expect(decodeSyncRes.kind).toBe("compile")
        expect(decodeSyncRes.hint).toContain("Schema.decodeUnknownSync")
      }),
  )

  it.effect(
    "deterministically denies cd commands with Cwd hint and allows git restore --staged in decideGuardCommand (REQ-4.1, REQ-4.2)",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        const cdRes = yield* decideGuardCommand("cd libs/sample/domain").pipe(
          Effect.provide(failingLayer),
        )
        expect(cdRes.verdict).toBe("deny")
        expect(cdRes.reason).toContain("Cwd")

        const restoreStagedRes = yield* decideGuardCommand(
          "git restore --staged docs/mvps/mvp_event_sourcing.md",
        ).pipe(Effect.provide(failingLayer))
        expect(restoreStagedRes.verdict).toBe("allow")
      }),
  )

  it.effect(
    "ignores passing Vitest stdout check lines and triages security/defect/permission rules deterministically",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        // Passing ✓ lines in Vitest stdout must not false-trigger mechanical rules when an unrelated semantic failure happens
        const mixedOutput = [
          " ✓ apps/harness-cli/test/index.test.ts > flags raw primitive type aliases (3 ms)",
          " ✔ apps/harness-cli/test/index.test.ts > enforces Config.redacted and Effect.ignore (2 ms)",
          " FAIL apps/sample/test/cart.test.ts > calculates subtotal",
          " AssertionError: expected 100 to be 120",
        ].join("\n")
        const semanticRes = yield* triageFailure(mixedOutput).pipe(Effect.provide(failingLayer))
        expect(semanticRes.kind).toBe("semantic")
        expect(semanticRes.hint).toContain("harness_tests_reaching")

        const silentDefectRes = yield* triageFailure(
          "error: silent-catch-defect: Effect.catchDefect handler silently swallows runtime defects without logging",
        ).pipe(Effect.provide(failingLayer))
        expect(silentDefectRes.kind).toBe("mechanical")
        expect(silentDefectRes.hint).toContain("Effect.logWarning")

        const chmodRes = yield* triageFailure(
          "error: ignored-chmod-permission: Ignoring chmodSync/fchmodSync failure with Effect.ignore",
        ).pipe(Effect.provide(failingLayer))
        expect(chmodRes.kind).toBe("mechanical")
        expect(chmodRes.hint).toContain("fail closed")

        const escapeRes = yield* triageFailure(
          "ProjectPathEscapeError: path '../../etc/passwd' escapes repoRoot",
        ).pipe(Effect.provide(failingLayer))
        expect(escapeRes.kind).toBe("mechanical")
        expect(escapeRes.hint).toContain("ProjectPathEscapeError")

        const socketChmodRes = yield* triageFailure(
          "DaemonSocketChmodError: failed to chmod 0o600 on daemon.sock",
        ).pipe(Effect.provide(failingLayer))
        expect(socketChmodRes.kind).toBe("mechanical")
        expect(socketChmodRes.hint).toContain("DaemonSocketChmodError")

        const clefEndpointRes = yield* triageFailure(
          'error: model "clef-flash" does not support generate',
        ).pipe(Effect.provide(failingLayer))
        expect(clefEndpointRes.kind).toBe("semantic")
        expect(clefEndpointRes.hint).toContain("@effect/ai-typesafe")

        const docTruthRes = yield* triageFailure(
          "doc-unknown-package-name: unknown @harness/ghost in README.md",
        ).pipe(Effect.provide(failingLayer))
        expect(docTruthRes.kind).toBe("mechanical")
        expect(docTruthRes.hint).toContain("Documentation or adapter truth drift")

        const staleVersionRes = yield* triageFailure(
          "stale-gate-rule-version: EXPECTED_GATE_RULE_VERSION_DIGEST mismatch",
        ).pipe(Effect.provide(failingLayer))
        expect(staleVersionRes.kind).toBe("mechanical")
        expect(staleVersionRes.hint).toContain("HARNESS_GATE_RULE_VERSION")

        const silentFsRes = yield* triageFailure(
          "silent-gate-fs-fallback: safeFs() in libs/harness/gates/src/plugins/gc/gc-helpers.ts",
        ).pipe(Effect.provide(failingLayer))
        expect(silentFsRes.kind).toBe("mechanical")
        expect(silentFsRes.hint).toContain("unreadable-workspace-file")
      }),
  )
})
