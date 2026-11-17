import * as path from "node:path"
import { Cause, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRouteToolOutput,
  ReviewSummaryText,
  ReviewerId,
} from "@harness/contract"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph } from "@harness/graph"
import { runWithTestTracer } from "@harness/ingest"
import { match } from "ts-pattern"
import { executeToolEffect } from "../src/server.js"
import { executeReviewRouteTool } from "../src/tools/graph-navigation.tools.js"
import { executeTool } from "./execute-tool-helper.js"

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")

describe("harness_review_route MCP tool", () => {
  it("routes active diffs with manifest tag inference and populated ReviewGraphContextBundle", async () => {
    const graph = buildHarnessGraph({
      fns: [
        {
          qualname: "ReviewRouter.decideDeterministic",
          spanName: "ReviewRouter.decideDeterministic",
          packageTag: "domain",
          file: path.join(REPO_ROOT, "libs/harness/decision/src/review-router-decision.ts"),
          line: 10,
        },
      ],
      tests: [
        {
          testId: "test-review-router-1",
          testFile: path.join(REPO_ROOT, "libs/harness/decision/test/review-router.test.ts"),
          testName: "REQ-2.1 & REQ-2.2: returns SkipReviewPlan",
          line: 1,
        },
      ],
      exercisesSpans: [
        {
          testId: "test-review-router-1",
          calleeQualname: "ReviewRouter.decideDeterministic",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      earsSpecs: [
        {
          id: "harness:SPEC-0013",
          title: "Monotonic Hybrid Review Routing",
          status: "proposed",
          path: "libs/harness/docs/specs/2026-11-17-review-routing-and-specialist-code-review.md",
          enforcedByFiles: ["libs/harness/decision/src/review-router-decision.ts"],
          referencedSpans: ["ReviewRouter.decideDeterministic"],
        },
      ],
    })

    const raw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["libs/harness/decision/src/review-router-decision.ts"],
        diffSummary: "Update ReviewRouter.decideDeterministic",
        changedLineCount: 25,
      },
      {
        repoRoot: REPO_ROOT,
        graph,
        decisionLayer: makeMockDecisionModelLayer({
          reviewDepthLabel: ReviewDepth.make("focused"),
        }),
      },
    )

    const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
    expect(output.plan._tag).toBe("ActiveReviewPlan")
    expect(output.plan.source).toBe("model-augmented")
    expect(output.plan.selections.map((s) => s.reviewer)).toContain(
      ReviewerId.make("effect-architecture-reviewer"),
    )
    expect(output.graphContext.touchedSymbols).toContain("ReviewRouter.decideDeterministic")
    expect(output.graphContext.reachingTests).toContain("REQ-2.1 & REQ-2.2: returns SkipReviewPlan")
    expect(output.graphContext.governanceRefs).toContain(
      "libs/harness/docs/specs/2026-11-17-review-routing-and-specialist-code-review.md",
    )
  })

  it("returns SkipReviewPlan for trivial doc-only edits under 40 lines", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const raw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["docs/notes.md"],
        diffSummary: "Fix typo",
        changedLineCount: 3,
      },
      {
        repoRoot: REPO_ROOT,
        graph,
        decisionLayer: makeMockDecisionModelLayer({
          reviewDepthLabel: ReviewDepth.make("skip"),
        }),
      },
    )

    const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
    expect(output.plan._tag).toBe("SkipReviewPlan")
    expect(output.plan.depth).toBe("skip")
    expect(output.plan.selections).toEqual([])
  })

  it("degrades cleanly to degraded-fallback when DecisionModel fails", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const raw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["libs/harness/contract/src/review-routing.ts"],
        diffSummary: "Update contract",
        changedLineCount: 15,
      },
      {
        repoRoot: REPO_ROOT,
        graph,
        decisionLayer: makeFailingDecisionModelLayer("Ollama offline"),
      },
    )

    const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
    expect(output.plan._tag).toBe("ActiveReviewPlan")
    expect(output.plan.source).toBe("degraded-fallback")
    expect(output.signals.touchedTiers).toContain("type:contract")
  })

  it("rejects path traversal inputs with ProjectPathEscapeError", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const exit = await Effect.runPromiseExit(
      executeToolEffect(
        "harness_review_route",
        {
          changedFiles: ["../secret.ts"],
          diffSummary: "Traversal",
          changedLineCount: 1,
        },
        {
          repoRoot: REPO_ROOT,
          graph,
          skipOmnigraphSpawn: true,
          skipTelemetry: true,
          skipActiveWorkspaceLookup: true,
          decisionLayer: makeMockDecisionModelLayer(),
        },
      ),
    )

    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        match(Cause.findErrorOption(cause))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toMatchObject({
              _tag: "ProjectPathEscapeError",
              projectPath: "../secret.ts",
              repoRoot: REPO_ROOT,
              message: expect.any(String),
            })
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected ProjectPathEscapeError")
          })
          .exhaustive()
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected ProjectPathEscapeError")
      })
      .exhaustive()
  })

  it("REQ-3.3: executeReviewRouteTool records all 4 SPEC-0013 spans via runWithTestTracer", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const { result: output, spans } = await Effect.runPromise(
      runWithTestTracer(
        "review-route-tracer",
        executeReviewRouteTool(
          ReviewRawDiffInput.make({
            changedFiles: [ReviewRawFileInput.make("libs/harness/contract/src/review-routing.ts")],
            diffSummary: ReviewSummaryText.make("Direct tool call"),
            changedLineCount: ReviewChangedLines.make(10),
            touchedTiers: [],
            touchedScopes: [],
          }),
          { repoRoot: REPO_ROOT, graph },
        ).pipe(Effect.provide(makeMockDecisionModelLayer())),
        new Map(),
      ),
    )

    expect(output.plan._tag).toBe("ActiveReviewPlan")
    expect(output.signals.hasContractBoundaryChange).toBe(true)
    const spanNames = spans.map((s) => s.name)
    expect(spanNames).toContain("HarnessMcp.routeReview")
    expect(spanNames).toContain("Harness.routeReviewDiff")
    expect(spanNames).toContain("ReviewRouter.inferDiffSignals")
    expect(spanNames).toContain("ReviewRouter.decideDeterministic")
  })
})
