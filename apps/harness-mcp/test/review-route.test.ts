import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { describe, expect, it } from "vitest"
import {
  type InvalidReviewRouteInputError,
  NxScopeTag,
  NxTierTag,
  REVIEW_SLICE_FILE_THRESHOLD,
  RemediationFindingSeverity,
  RemediationReviewContext,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRouteToolOutput,
  ReviewSignalPath,
  ReviewSummaryText,
  ReviewTimeoutMillis,
  ReviewerId,
} from "@harness/contract"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph } from "@harness/graph"
import { runWithTestTracer } from "@harness/ingest"
import { match } from "ts-pattern"
import { executeToolEffect } from "../src/server.js"
import { executeReviewRouteTool } from "../src/tools/graph-navigation.tools.js"
import { deriveChangedLineCountFromGit } from "../src/tools/review-route-helpers.js"
import { ReviewGitBaseRef } from "../src/tools/review-route-git.js"
import { executeTool } from "./execute-tool-helper.js"

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-review-route-"))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const expectFailureTag = async <A, E>(
  effect: Effect.Effect<A, E>,
  expectedTag: string,
  expectedFields?: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect)
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toMatchObject({
            _tag: expectedTag,
            ...expectedFields,
          })
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable(`Expected ${expectedTag} failure`)
        })
        .exhaustive()
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable(`Expected ${expectedTag} failure, got Success`)
    })
    .exhaustive()
}

const expectSchemaRejection = async (
  args: Readonly<Record<string, unknown>>,
  repoRoot: string,
): Promise<void> => {
  const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
  const exit = await Effect.runPromiseExit(
    executeToolEffect("harness_review_route", args, {
      repoRoot,
      graph,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      skipActiveWorkspaceLookup: true,
      decisionLayer: makeMockDecisionModelLayer(),
    }),
  )
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => {
          expect(Schema.isSchemaError(value)).toBe(true)
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected SchemaError")
        })
        .exhaustive()
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable("Expected SchemaError, got Success")
    })
    .exhaustive()
}

describe("harness_review_route MCP tool", () => {
  it("1. routes active diffs with model augmentation (needsSecurityProb: 0.9) and deterministic unchanged output", async () => {
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

    const augmentedRaw = await executeTool(
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
          needsSecurityProb: 0.9,
        }),
      },
    )

    const augmented = Schema.decodeUnknownSync(ReviewRouteToolOutput)(augmentedRaw)
    expect(augmented.plan._tag).toBe("ActiveReviewPlan")
    expect(augmented.plan.source).toBe("model-augmented")
    expect(augmented.plan.selections.map((s) => s.reviewer)).toContain(
      ReviewerId.make("effect-architecture-reviewer"),
    )
    expect(augmented.plan.selections.map((s) => s.reviewer)).toContain(
      ReviewerId.make("effect-security-reviewer"),
    )
    expect(augmented.graphContext.touchedSymbols).toContain("ReviewRouter.decideDeterministic")
    expect(augmented.graphContext.reachingTests).toContain(
      "REQ-2.1 & REQ-2.2: returns SkipReviewPlan",
    )
    expect(augmented.graphContext.governanceRefs).toContain(
      "libs/harness/docs/specs/2026-11-17-review-routing-and-specialist-code-review.md",
    )

    const deterministicRaw = await executeTool(
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
          reviewDepthLabel: ReviewDepth.make("lite"),
        }),
      },
    )

    const deterministic = Schema.decodeUnknownSync(ReviewRouteToolOutput)(deterministicRaw)
    expect(deterministic.plan._tag).toBe("ActiveReviewPlan")
    expect(deterministic.plan.source).toBe("deterministic")
  })

  it("2. returns SkipReviewPlan for trivial doc-only edits under 40 lines with clean status", async () => {
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
    expect(output.degraded).toBe(false)
    expect(output.warnings).toEqual([])
  })

  it("3. degrades cleanly to degraded-fallback with degradedReason when DecisionModel fails", async () => {
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
    expect(output.plan.degradedReason).toContain("Ollama offline")
    expect(output.signals.touchedTiers).toContain("type:contract")
  })

  it("4. rejects path traversal changedFiles with InvalidReviewRouteInputError (not ProjectPathEscapeError)", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    await expectFailureTag(
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
      "InvalidReviewRouteInputError",
      {
        offendingPath: "../secret.ts",
      },
    )
  })

  it("5. rejects repoRoot escape with ProjectPathEscapeError both when options.repoRoot is set and unset", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    await expectFailureTag(
      executeToolEffect(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          changedLineCount: 1,
          repoRoot: "/etc",
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
      "ProjectPathEscapeError",
      {
        projectPath: "/etc",
        repoRoot: REPO_ROOT,
      },
    )

    await expectFailureTag(
      executeToolEffect(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          changedLineCount: 1,
          repoRoot: "../../outside-workspace",
        },
        {
          graph,
          skipOmnigraphSpawn: true,
          skipTelemetry: true,
          skipActiveWorkspaceLookup: true,
          decisionLayer: makeMockDecisionModelLayer(),
        },
      ),
      "ProjectPathEscapeError",
      {
        projectPath: "../../outside-workspace",
      },
    )
  })

  it("6. honors valid subdirectory repoRoot manifests and escalates non-existent repoRoot", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    await withTempDir(async (tmpRoot) => {
      fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      const pkgDir = path.join(tmpRoot, "libs", "pkg")
      fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, "project.json"), JSON.stringify({ tags: ["type:domain"] }))
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@test/pkg", nx: { tags: ["scope:web"] } }),
      )
      fs.writeFileSync(path.join(pkgDir, "src", "index.ts"), "export const x = 1\n")

      const raw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["libs/pkg/src/index.ts"],
          diffSummary: "Add export",
          changedLineCount: 5,
          repoRoot: tmpRoot,
        },
        {
          repoRoot: tmpRoot,
          graph,
          decisionLayer: makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("lite"),
          }),
        },
      )

      const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
      expect(output.warnings).toEqual([])
      expect(output.signals.touchedTiers).toContain("type:domain")
      expect(output.signals.touchedScopes).toContain("scope:web")

      const missingRoot = path.join(tmpRoot, "does-not-exist")
      const missingRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          diffSummary: "Doc note",
          changedLineCount: 3,
          repoRoot: missingRoot,
        },
        {
          repoRoot: tmpRoot,
          graph,
          decisionLayer: makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("skip"),
          }),
        },
      )

      const missingOutput = Schema.decodeUnknownSync(ReviewRouteToolOutput)(missingRaw)
      expect(missingOutput.warnings.length).toBeGreaterThan(0)
      expect(missingOutput.plan._tag).toBe("ActiveReviewPlan")
      expect(["focused", "full"]).toContain(missingOutput.plan.depth)
      expect(missingOutput.plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )
    })
  })

  it("7. records warnings and floors depth at focused on corrupt project.json and unknownTags", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    await withTempDir(async (tmpRoot) => {
      fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages:\n  - 'docs/*'\n")
      const corruptDir = path.join(tmpRoot, "docs")
      fs.mkdirSync(corruptDir, { recursive: true })
      fs.writeFileSync(path.join(corruptDir, "project.json"), "{ not valid json")
      fs.writeFileSync(path.join(corruptDir, "notes.md"), "# Notes\n")

      const corruptRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          diffSummary: "Typo",
          changedLineCount: 3,
        },
        {
          repoRoot: tmpRoot,
          graph,
          decisionLayer: makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("skip"),
          }),
        },
      )

      const corruptOutput = Schema.decodeUnknownSync(ReviewRouteToolOutput)(corruptRaw)
      expect(corruptOutput.warnings.some((w) => w.includes("Failed to parse manifest"))).toBe(true)
      expect(corruptOutput.plan._tag).toBe("ActiveReviewPlan")
      expect(corruptOutput.plan.depth).toBe("focused")
      expect(corruptOutput.plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )

      fs.writeFileSync(
        path.join(corruptDir, "project.json"),
        JSON.stringify({ tags: ["custom:unknown-tag "] }),
      )

      const unknownRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          diffSummary: "Check auth session with Scope",
          changedLineCount: 3,
        },
        {
          repoRoot: tmpRoot,
          graph,
          decisionLayer: makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("skip"),
          }),
        },
      )

      const unknownOutput = Schema.decodeUnknownSync(ReviewRouteToolOutput)(unknownRaw)
      expect(unknownOutput.warnings.some((w) => w.includes("Unrecognized Nx tags"))).toBe(true)
      expect(unknownOutput.plan._tag).toBe("ActiveReviewPlan")
      expect(unknownOutput.plan.depth).toBe("full")
      expect(unknownOutput.plan.selections).toHaveLength(3)
      expect(unknownOutput.plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )
    })
  })

  it("8. propagates degraded graphStatus when graph snapshot is missing", async () => {
    await withTempDir(async (tmpRoot) => {
      fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages: []\n")
      const raw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["docs/notes.md"],
          diffSummary: "Typo",
          changedLineCount: 3,
        },
        {
          repoRoot: tmpRoot,
          decisionLayer: makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("skip"),
          }),
        },
      )

      const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
      expect(output.degraded).toBe(true)
      expect(output.degradedReason).toBe("missing-graph-snapshot")
    })
  })

  it("9. accepts caller-supplied touchedTiers, touchedScopes, and custom timeoutMs", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const raw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["README.md"],
        diffSummary: "Update docs",
        changedLineCount: 2,
        touchedTiers: ["type:contract"],
        touchedScopes: ["scope:web"],
        timeoutMs: 500,
      },
      {
        repoRoot: REPO_ROOT,
        graph,
        decisionLayer: makeMockDecisionModelLayer({
          reviewDepthLabel: ReviewDepth.make("lite"),
        }),
      },
    )

    const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
    expect(output.signals.touchedTiers).toContain("type:contract")
    expect(output.signals.touchedScopes).toContain("scope:web")
    expect(output.plan._tag).toBe("ActiveReviewPlan")
    expect(output.plan.selections.map((s) => s.reviewer)).toContain(
      ReviewerId.make("effect-web-reviewer"),
    )
  })

  it("10. enforces input bounds and maps > 16 touchedTiers in executeReviewRouteTool to InvalidReviewRouteInputError", async () => {
    await expectSchemaRejection({ changedFiles: [], changedLineCount: 1 }, REPO_ROOT)
    await expectSchemaRejection(
      { changedFiles: ["docs/notes.md"], changedLineCount: -1 },
      REPO_ROOT,
    )
    await expectSchemaRejection(
      {
        changedFiles: Array.from({ length: 201 }, (_, i) => `docs/file-${i}.md`),
        changedLineCount: 1,
      },
      REPO_ROOT,
    )
    await expectSchemaRejection(
      {
        changedFiles: ["a".repeat(513)],
        changedLineCount: 1,
      },
      REPO_ROOT,
    )

    await withTempDir(async (tmpRoot) => {
      fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages: []\n")
      const pkgDir = path.join(tmpRoot, "libs", "pkg")
      fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, "project.json"), JSON.stringify({ tags: ["type:infra"] }))
      fs.writeFileSync(path.join(pkgDir, "src", "index.ts"), "export const x = 1\n")

      const seventeenTiers: ReadonlyArray<NxTierTag> = Array.from({ length: 17 }, () =>
        NxTierTag.make("type:domain"),
      )
      const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })

      const invalidInput: ReviewRawDiffInput = {
        changedFiles: [ReviewRawFileInput.make("libs/pkg/src/index.ts")],
        diffSummary: ReviewSummaryText.make("Too many tiers"),
        changedLineCount: ReviewChangedLines.make(5),
        touchedTiers: seventeenTiers,
        touchedScopes: [NxScopeTag.make("scope:web")],
        timeoutMs: ReviewTimeoutMillis.make(1500),
      }

      await expectFailureTag(
        executeReviewRouteTool(invalidInput, { repoRoot: tmpRoot, graph }).pipe(
          Effect.provide(makeMockDecisionModelLayer()),
        ),
        "InvalidReviewRouteInputError",
      )
    })
  })

  it("11. REQ-3.3: records all 4 SPEC-0013 spans and runs ReviewRouter.inferDiffSignals exactly once", async () => {
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
    expect(spans.filter((s) => s.name === "ReviewRouter.inferDiffSignals")).toHaveLength(1)
  })

  it("12. SPEC-0030 REQ-1.1: returns deterministic disjoint reviewSlices above REVIEW_SLICE_FILE_THRESHOLD and omits below", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const opts = {
      repoRoot: REPO_ROOT,
      graph,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      skipActiveWorkspaceLookup: true,
      decisionLayer: makeMockDecisionModelLayer(),
    } as const

    const belowRaw = await executeTool(
      "harness_review_route",
      {
        changedFiles: Array.from(
          { length: REVIEW_SLICE_FILE_THRESHOLD - 1 },
          (_, i) => `libs/sample/domain/src/item-${i}.ts`,
        ),
        changedLineCount: 30,
      },
      opts,
    )
    const belowOutput = Schema.decodeUnknownSync(ReviewRouteToolOutput)(belowRaw)
    expect(belowOutput.reviewSlices).toBeUndefined()

    const twelveFiles = [
      "apps/harness-mcp/src/a.ts",
      "libs/harness/contract/src/b.ts",
      "libs/harness/decision/src/c.ts",
      ...Array.from({ length: 9 }, (_, i) => `libs/harness/gates/src/g-${i}.ts`),
    ]
    const firstRaw = await executeTool(
      "harness_review_route",
      { changedFiles: twelveFiles, changedLineCount: 95 },
      opts,
    )
    const secondRaw = await executeTool(
      "harness_review_route",
      { changedFiles: [...twelveFiles].reverse(), changedLineCount: 95 },
      opts,
    )
    const firstOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(firstRaw)
    const secondOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(secondRaw)

    expect(firstOut.reviewSlices).toBeDefined()
    expect(firstOut.reviewSlices?.map((s) => s.sliceId)).toEqual([
      "apps/harness-mcp",
      "libs/harness/contract",
      "libs/harness/decision",
      "libs/harness/gates",
    ])
    expect(secondOut.reviewSlices?.map((s) => s.sliceId)).toEqual(
      firstOut.reviewSlices?.map((s) => s.sliceId),
    )
    const flatFiles = firstOut.reviewSlices?.flatMap((s) => s.files) ?? []
    expect(new Set(flatFiles)).toEqual(new Set(twelveFiles))
  })

  it("13. SPEC-0030 REQ-3.1: forwards remediationContext to enforce focused mandatory re-audit and rejects malformed remediationContext", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const opts = {
      repoRoot: REPO_ROOT,
      graph,
      skipOmnigraphSpawn: true,
      skipTelemetry: true,
      skipActiveWorkspaceLookup: true,
      decisionLayer: makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
    } as const

    const raw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["docs/notes.md"],
        changedLineCount: 4,
        diffSummary: "Remediation patch",
        remediationContext: RemediationReviewContext.make({
          priorSpecialists: [ReviewerId.make("effect-adversarial-reviewer")],
          maxSeverity: RemediationFindingSeverity.make("critical"),
        }),
      },
      opts,
    )
    const output = Schema.decodeUnknownSync(ReviewRouteToolOutput)(raw)
    expect(output.plan._tag).toBe("ActiveReviewPlan")
    expect(output.plan.depth).toBe("focused")
    expect(
      output.plan.selections.some(
        (s) => s.reviewer === ReviewerId.make("effect-adversarial-reviewer") && s.mandatory,
      ),
    ).toBe(true)

    await expectSchemaRejection(
      {
        changedFiles: ["docs/notes.md"],
        changedLineCount: 4,
        remediationContext: { priorSpecialists: [], maxSeverity: "critical" },
      },
      REPO_ROOT,
    )
    await expectSchemaRejection(
      {
        changedFiles: ["docs/notes.md"],
        changedLineCount: 4,
        remediationContext: {
          priorSpecialists: ["effect-security-reviewer"],
          maxSeverity: "unknown-severity",
        },
      },
      REPO_ROOT,
    )

    const diagRaw = await executeReviewRouteTool(
      ReviewRawDiffInput.make({
        changedFiles: Array.from({ length: 12 }, (_, i) =>
          ReviewRawFileInput.make(`docs/notes/page-${i}.md`),
        ),
        diffSummary: ReviewSummaryText.make("Doc batch"),
        changedLineCount: ReviewChangedLines.make(12),
        touchedTiers: [],
        touchedScopes: [],
      }),
      { graph },
    ).pipe(
      Effect.provide(makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") })),
      Effect.runPromise,
    )
    expect(diagRaw.warnings.length).toBeGreaterThan(0)
    expect(diagRaw.plan._tag).toBe("ActiveReviewPlan")
    expect(diagRaw.reviewSlices).toHaveLength(1)
    expect(
      diagRaw.reviewSlices?.[0]?.selections.some(
        (s) => s.reviewer === ReviewerId.make("effect-architecture-reviewer"),
      ),
    ).toBe(true)

    await expectSchemaRejection(
      {
        changedFiles: ["docs/notes.md"],
        changedLineCount: 2,
        repoRoot: "adapters\0bad",
      },
      REPO_ROOT,
    )

    const subdirRaw = await executeTool(
      "harness_review_route",
      {
        changedFiles: ["SKILL.md"],
        diffSummary: "Update skill doc",
        changedLineCount: 5,
        repoRoot: path.join(REPO_ROOT, "adapters/claude-code/skills/effect-code-review"),
      },
      {
        repoRoot: REPO_ROOT,
        graph,
        skipOmnigraphSpawn: true,
        skipTelemetry: true,
        skipActiveWorkspaceLookup: true,
        decisionLayer: makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
      },
    )
    const subdirOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(subdirRaw)
    expect(subdirOut.plan._tag).toBe("ActiveReviewPlan")
    expect(subdirOut.signals.changedFiles).toEqual([
      "adapters/claude-code/skills/effect-code-review/SKILL.md",
    ])
  })

  it("16. auto-derives changedLineCount via git diff --numstat and untracked files when omitted (REQ-3.8)", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const runGit = (cwd: string, args: ReadonlyArray<string>): void => {
      childProcess.execFileSync("git", args, { cwd, stdio: "pipe" })
    }

    await withTempDir(async (tmpRepo) => {
      runGit(tmpRepo, ["init"])
      runGit(tmpRepo, ["config", "user.email", "test@example.com"])
      runGit(tmpRepo, ["config", "user.name", "Test User"])
      fs.writeFileSync(path.join(tmpRepo, "tracked.txt"), "line1\nline2\n", "utf8")
      fs.writeFileSync(path.join(tmpRepo, "asset.bin"), Buffer.from([0, 1, 2, 3]))
      runGit(tmpRepo, ["add", "tracked.txt", "asset.bin"])
      runGit(tmpRepo, ["commit", "-m", "init"])

      // Modify tracked.txt (+185 lines) and asset.bin (binary) plus an untracked 5-line file.
      const addedLines = Array.from({ length: 185 }, (_, i) => `extra-${i}`).join("\n")
      fs.writeFileSync(path.join(tmpRepo, "tracked.txt"), `line1\nline2\n${addedLines}\n`, "utf8")
      fs.writeFileSync(path.join(tmpRepo, "asset.bin"), Buffer.from([0, 1, 2, 4, 5]))
      fs.writeFileSync(path.join(tmpRepo, "untracked.txt"), "u1\nu2\nu3\nu4\nu5\n", "utf8")

      const directDerived = await Effect.runPromise(
        deriveChangedLineCountFromGit(tmpRepo, [
          ReviewSignalPath.make("tracked.txt"),
          ReviewSignalPath.make("asset.bin"),
          ReviewSignalPath.make("untracked.txt"),
        ]),
      )
      expect(directDerived.changedLineCount).toBe(190)
      expect(directDerived.warning).toBeUndefined()

      const autoRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["tracked.txt", "asset.bin", "untracked.txt"],
          diffSummary: "Auto-derived line count check",
          repoRoot: tmpRepo,
        },
        {
          repoRoot: tmpRepo,
          graph,
          skipOmnigraphSpawn: true,
          skipTelemetry: true,
          skipActiveWorkspaceLookup: true,
          decisionLayer: makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
        },
      )
      const autoOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(autoRaw)
      expect(autoOut.signals.changedLineCount).toBe(190)
      expect(autoOut.warnings).toHaveLength(0)
      expect(autoOut.plan._tag).toBe("ActiveReviewPlan")
      expect(autoOut.plan.depth).toBe("full")
      expect(
        autoOut.plan._tag === "ActiveReviewPlan" &&
          autoOut.plan.selections.some(
            (s) => s.reviewer === ReviewerId.make("effect-architecture-reviewer"),
          ),
      ).toBe(true)

      const overrideOut = await executeReviewRouteTool(
        {
          changedFiles: ["tracked.txt"],
          diffSummary: "Explicit override",
          changedLineCount: ReviewChangedLines.make(4),
        },
        { repoRoot: tmpRepo, graph },
      ).pipe(
        Effect.provide(makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") })),
        Effect.runPromise,
      )
      expect(overrideOut.signals.changedLineCount).toBe(4)
    })

    await withTempDir(async (nonGitDir) => {
      fs.writeFileSync(path.join(nonGitDir, "notes.md"), "hello\n", "utf8")
      const fallbackOut = await executeReviewRouteTool(
        {
          changedFiles: ["notes.md"],
          diffSummary: "Non-git fallback",
        },
        { repoRoot: nonGitDir, graph },
      ).pipe(
        Effect.provide(makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") })),
        Effect.runPromise,
      )
      expect(fallbackOut.signals.changedLineCount).toBe(0)
      expect(fallbackOut.warnings.length).toBeGreaterThan(0)
      match(fallbackOut.plan)
        .with({ _tag: "ActiveReviewPlan" }, (active) => {
          expect(active.depth).toBe("focused")
          expect(
            active.selections.some(
              (s) => s.reviewer === ReviewerId.make("effect-architecture-reviewer"),
            ),
          ).toBe(true)
        })
        .with({ _tag: "SkipReviewPlan" }, () => {
          expect.unreachable("Expected ActiveReviewPlan")
        })
        .exhaustive()
    })
  })

  it("17. handles unborn repo, deleted lines, untracked no-newline, binary \\0, and symlink files in deriveChangedLineCountFromGit", async () => {
    const runGit = (cwd: string, args: ReadonlyArray<string>): void => {
      childProcess.execFileSync("git", args, { cwd, stdio: "pipe" })
    }

    await withTempDir(async (unbornRepo) => {
      runGit(unbornRepo, ["init"])
      runGit(unbornRepo, ["config", "user.email", "test@example.com"])
      runGit(unbornRepo, ["config", "user.name", "Test User"])
      fs.writeFileSync(path.join(unbornRepo, "staged.txt"), "s1\ns2\n", "utf8")
      runGit(unbornRepo, ["add", "staged.txt"])
      fs.writeFileSync(path.join(unbornRepo, "staged.txt"), "s1\ns2\ns3\n", "utf8")
      fs.writeFileSync(path.join(unbornRepo, "no-nl.txt"), "u1\nu2\nu3", "utf8")
      fs.writeFileSync(path.join(unbornRepo, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]))
      fs.symlinkSync(path.join(unbornRepo, "no-nl.txt"), path.join(unbornRepo, "link.txt"))

      const unbornDerived = await Effect.runPromise(
        deriveChangedLineCountFromGit(unbornRepo, [
          ReviewSignalPath.make("staged.txt"),
          ReviewSignalPath.make("no-nl.txt"),
          ReviewSignalPath.make("blob.bin"),
          ReviewSignalPath.make("link.txt"),
        ]),
      )
      expect(unbornDerived.changedLineCount).toBe(6)
      expect(unbornDerived.warning).toBeUndefined()

      runGit(unbornRepo, ["add", "staged.txt", "no-nl.txt"])
      runGit(unbornRepo, ["commit", "-m", "initial"])
      fs.writeFileSync(path.join(unbornRepo, "staged.txt"), "s1\n", "utf8")
      fs.writeFileSync(path.join(unbornRepo, "no-nl.txt"), "u1", "utf8")

      const deletedDerived = await Effect.runPromise(
        deriveChangedLineCountFromGit(unbornRepo, [
          ReviewSignalPath.make("staged.txt"),
          ReviewSignalPath.make("no-nl.txt"),
        ]),
      )
      // staged.txt lost 2 lines (0 added, 2 deleted); no-nl.txt changed 3 lines -> 1 line (1 added, 3 deleted)
      expect(deletedDerived.changedLineCount).toBe(6)
      expect(deletedDerived.warning).toBeUndefined()
    })
  })

  it("18. supports explicit baseRef on committed branch diff, warns on invalid/missing repoRoot, and preserves tracked lines on untracked read failure", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const runGit = (cwd: string, args: ReadonlyArray<string>): void => {
      childProcess.execFileSync("git", args, { cwd, stdio: "pipe" })
    }

    await withTempDir(async (tmpDir) => {
      const branchRepo = path.join(tmpDir, "repo")
      fs.mkdirSync(branchRepo, { recursive: true })
      runGit(branchRepo, ["init", "-b", "main"])
      runGit(branchRepo, ["config", "user.email", "test@example.com"])
      runGit(branchRepo, ["config", "user.name", "Test User"])
      fs.writeFileSync(path.join(branchRepo, "app.ts"), "export const a = 1\n", "utf8")
      runGit(branchRepo, ["add", "app.ts"])
      runGit(branchRepo, ["commit", "-m", "main base"])
      runGit(branchRepo, ["checkout", "-b", "feature"])
      fs.writeFileSync(
        path.join(branchRepo, "app.ts"),
        "export const a = 1\nexport const b = 2\nexport const c = 3\n",
        "utf8",
      )
      runGit(branchRepo, ["add", "app.ts"])
      runGit(branchRepo, ["commit", "-m", "feature changes"])

      const branchRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["app.ts"],
          diffSummary: "Feature diff against main",
          baseRef: ReviewGitBaseRef.make("main"),
          repoRoot: branchRepo,
        },
        {
          repoRoot: branchRepo,
          graph,
          skipOmnigraphSpawn: true,
          skipTelemetry: true,
          skipActiveWorkspaceLookup: true,
          decisionLayer: makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
        },
      )
      const branchOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(branchRaw)
      expect(branchOut.signals.changedLineCount).toBe(2)
      expect(branchOut.warnings).toEqual([])

      runGit(branchRepo, ["checkout", "main"])
      fs.writeFileSync(
        path.join(branchRepo, "upstream.ts"),
        Array.from({ length: 10 }, (_, idx) => `export const u${idx} = ${idx}`).join("\n") + "\n",
        "utf8",
      )
      runGit(branchRepo, ["add", "upstream.ts"])
      runGit(branchRepo, ["commit", "-m", "main diverged upstream commit"])
      runGit(branchRepo, ["checkout", "feature"])

      const divergedBranchRaw = await executeTool(
        "harness_review_route",
        {
          changedFiles: ["app.ts", "upstream.ts"],
          diffSummary: "Feature diff after main diverged uses merge-base",
          baseRef: ReviewGitBaseRef.make("main"),
          repoRoot: branchRepo,
        },
        {
          repoRoot: branchRepo,
          graph,
          skipOmnigraphSpawn: true,
          skipTelemetry: true,
          skipActiveWorkspaceLookup: true,
          decisionLayer: makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
        },
      )
      const divergedOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(divergedBranchRaw)
      expect(divergedOut.signals.changedLineCount).toBe(2)
      expect(divergedOut.warnings).toEqual([])

      await expectSchemaRejection(
        { changedFiles: ["app.ts"], baseRef: "--exec=bad", repoRoot: branchRepo },
        branchRepo,
      )

      const missingDirRes = await Effect.runPromise(
        deriveChangedLineCountFromGit(path.join(tmpDir, "missing"), [
          ReviewSignalPath.make("app.ts"),
        ]),
      )
      expect(missingDirRes.changedLineCount).toBe(0)
      expect(missingDirRes.warning).toContain("does not exist on disk")

      const linkRoot = path.join(tmpDir, "repo-link")
      fs.symlinkSync(branchRepo, linkRoot)
      const symlinkRootRes = await Effect.runPromise(
        deriveChangedLineCountFromGit(linkRoot, [ReviewSignalPath.make("app.ts")]),
      )
      expect(symlinkRootRes.changedLineCount).toBe(0)
      expect(symlinkRootRes.warning).toContain("must not be a symlink")

      fs.writeFileSync(
        path.join(branchRepo, "app.ts"),
        "export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n",
        "utf8",
      )
      fs.writeFileSync(path.join(branchRepo, "bad-utf8.txt"), Buffer.from([0xff, 0xfe, 0x80]))
      const partialRes = await Effect.runPromise(
        deriveChangedLineCountFromGit(branchRepo, [
          ReviewSignalPath.make("app.ts"),
          ReviewSignalPath.make("bad-utf8.txt"),
        ]),
      )
      expect(partialRes.changedLineCount).toBe(1)
      expect(partialRes.warning).toContain("Failed to inspect untracked file")
    })
  })

  it("19. handles omitted repoRoot + changedLineCount, resolves input repoRoot when context.repoRoot is omitted, and maps missing changedFiles cleanly", async () => {
    const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
    const omittedOut = await executeReviewRouteTool(
      {
        changedFiles: ["docs/notes.md"],
        diffSummary: "No repoRoot and no changedLineCount",
      },
      { graph },
    ).pipe(
      Effect.provide(makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") })),
      Effect.runPromise,
    )
    expect(omittedOut.signals.changedLineCount).toBe(0)
    expect(
      omittedOut.warnings.some((w) =>
        w.includes("No repoRoot supplied; changedLineCount auto-derivation unavailable"),
      ),
    ).toBe(true)
    match(omittedOut.plan)
      .with({ _tag: "ActiveReviewPlan" }, (active) => {
        expect(active.depth).toBe("focused")
        expect(active.selections.map((s) => s.reviewer)).toContain(
          ReviewerId.make("effect-architecture-reviewer"),
        )
      })
      .with({ _tag: "SkipReviewPlan" }, () => {
        expect.unreachable("Expected ActiveReviewPlan")
      })
      .exhaustive()

    const inputRootOut = await executeReviewRouteTool(
      {
        changedFiles: ["libs/harness/contract/src/review-routing.ts"],
        diffSummary: "Direct repoRoot without context.repoRoot",
        changedLineCount: ReviewChangedLines.make(5),
        repoRoot: REPO_ROOT,
      },
      { graph },
    ).pipe(
      Effect.provide(makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("lite") })),
      Effect.runPromise,
    )
    expect(inputRootOut.warnings).toEqual([])
    expect(inputRootOut.signals.touchedTiers).toContain("type:contract")

    await expectFailureTag(
      executeReviewRouteTool(
        {
          changedFiles: ["docs/notes.md"],
          changedLineCount: ReviewChangedLines.make(1),
          repoRoot: "/etc",
        },
        { graph },
      ).pipe(Effect.provide(makeMockDecisionModelLayer())),
      "InvalidReviewRouteInputError",
    )

    const malformedCall: Effect.Effect<
      ReviewRouteToolOutput,
      InvalidReviewRouteInputError,
      DecisionModel.DecisionModel
    > = Reflect.apply(executeReviewRouteTool, undefined, [{}])
    await expectFailureTag(
      malformedCall.pipe(Effect.provide(makeMockDecisionModelLayer())),
      "InvalidReviewRouteInputError",
      {
        offendingPath: "unknown",
      },
    )
  })
})
