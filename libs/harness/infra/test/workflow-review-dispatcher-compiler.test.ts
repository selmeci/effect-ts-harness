import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Option } from "effect"
import { match } from "ts-pattern"
import {
  AgentAuthRequiredError,
  AgentExitCode,
  AgentExitError,
  AgentResultText,
  type AgentRunRequest,
  AttemptNumber,
  MaxConcurrency,
  OwnedRelPath,
  ReviewDepth,
  RunnerId,
  UnitRejection,
  WorkflowRunId,
  WorkspaceFilePath,
} from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { decideSpanBudgets } from "@harness/gates"
import { AgentRunnerPort, UnitAgentDispatcher, WorkflowReviewRouter } from "@harness/service"
import {
  UnitAgentDispatcherLive,
  UnitAgentDispatcherLiveFromPort,
  compileWorkflowPlanFromRepo,
  makeWorkflowReviewRouterLayer,
  routeWorkflowReviewImpl,
} from "../src/index.js"
import {
  runWithTestTracer,
  withTempDir,
  initGitRepo,
  makePackageUnit,
} from "./helpers/workflow-verifier-fixture.js"

describe("WorkflowReviewRouter & UnitAgentDispatcher", () => {
  it.live(
    "UnitAgentDispatcherLive exposes live runnerKind and UnitAgentDispatcherLiveFromPort dispatches via AgentRunnerPort",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const liveKind = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return dispatcher.runnerKind
          }).pipe(Effect.provide(UnitAgentDispatcherLive))
          expect(liveKind).toBe("live")

          const capturedRequests: Array<AgentRunRequest> = []
          const mockPortLayer = Layer.succeed(AgentRunnerPort, {
            run: (request) => {
              capturedRequests.push(request)
              return Effect.succeed({
                runner: request.runner,
                exit: AgentExitCode.make(0),
                resultText: AgentResultText.make("ok"),
                usage: { status: "unavailable" },
              })
            },
          })

          const completedRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            expect(dispatcher.runnerKind).toBe("live")
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-dispatch-1"),
              unit: makePackageUnit({ unitId: "u-1" }),
              attempt: AttemptNumber.make(2),
              runner: RunnerId.make("claude-code"),
              cwd: repoRoot,
              priorRejection: UnitRejection.cases.StampMissing.make({}),
            })
          }).pipe(
            Effect.provide(UnitAgentDispatcherLiveFromPort.pipe(Layer.provide(mockPortLayer))),
          )

          expect(completedRes._tag).toBe("Completed")
          expect(capturedRequests).toHaveLength(1)
          expect(capturedRequests[0]?.brief.attempt).toBe(2)
          expect(capturedRequests[0]?.brief.promptText).toContain(repoRoot)

          const authFailLayer = Layer.succeed(AgentRunnerPort, {
            run: (request) => Effect.fail(new AgentAuthRequiredError({ runner: request.runner })),
          })
          const authRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-dispatch-2"),
              unit: makePackageUnit({ unitId: "u-1" }),
              attempt: AttemptNumber.make(1),
              runner: RunnerId.make("antigravity"),
              cwd: repoRoot,
            })
          }).pipe(
            Effect.provide(UnitAgentDispatcherLiveFromPort.pipe(Layer.provide(authFailLayer))),
          )
          expect(authRes).toEqual({ _tag: "AuthRequired", runner: "antigravity" })

          const exitFailLayer = Layer.succeed(AgentRunnerPort, {
            run: (request) =>
              Effect.fail(
                new AgentExitError({
                  runner: request.runner,
                  exit: AgentExitCode.make(2),
                }),
              ),
          })
          const failedRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-dispatch-3"),
              unit: makePackageUnit({ unitId: "u-1" }),
              attempt: AttemptNumber.make(1),
              runner: RunnerId.make("claude-code"),
              cwd: repoRoot,
            })
          }).pipe(
            Effect.provide(UnitAgentDispatcherLiveFromPort.pipe(Layer.provide(exitFailLayer))),
          )
          expect(failedRes._tag).toBe("Failed")
        }),
      ),
  )

  it.live(
    "routeWorkflowReviewImpl returns SkipReviewPlan on empty diff and ActiveReviewPlan on modified package",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const emptyReview = yield* routeWorkflowReviewImpl({
            runId: WorkflowRunId.make("run-rev-1"),
            baseSha,
            canonicalRepoRoot: repoRoot,
          })
          expect(emptyReview._tag).toBe("SkipReviewPlan")

          writeFileSync(
            join(repoRoot, "libs", "alpha", "package.json"),
            JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
            "utf8",
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 2\n",
            "utf8",
          )
          const mockDmLayer = makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("focused"),
          })
          const activeReview = yield* Effect.gen(function* () {
            const router = yield* WorkflowReviewRouter
            return yield* router.routeReview({
              runId: WorkflowRunId.make("run-rev-1"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            })
          }).pipe(
            Effect.provide(makeWorkflowReviewRouterLayer({ decisionModelLayer: mockDmLayer })),
          )
          expect(activeReview._tag).toBe("ActiveReviewPlan")
        }),
      ),
  )

  it.live(
    "routeWorkflowReviewImpl fails closed with WorkspaceFsError on corrupt/unreadable package.json or unreadable untracked file (F-14.1)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const pkgPath = join(repoRoot, "libs", "alpha", "package.json")
          writeFileSync(pkgPath, "{not-valid-json", "utf8")
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 9\n",
            "utf8",
          )

          const corruptPkgExit = yield* Effect.exit(
            routeWorkflowReviewImpl({
              runId: WorkflowRunId.make("run-rev-corrupt"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            }),
          )
          match(corruptPkgExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for corrupt package.json")
            })
            .exhaustive()

          writeFileSync(
            pkgPath,
            JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
            "utf8",
          )
          const untrackedPath = join(repoRoot, "libs", "alpha", "src", "secret.ts")
          writeFileSync(untrackedPath, "export const secret = 1\n", "utf8")
          chmodSync(untrackedPath, 0o000)

          const unreadableUntrackedExit = yield* Effect.exit(
            routeWorkflowReviewImpl({
              runId: WorkflowRunId.make("run-rev-unreadable"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            }),
          )
          chmodSync(untrackedPath, 0o644)
          match(unreadableUntrackedExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unreadable untracked file")
            })
            .exhaustive()
        }),
      ),
  )
})

describe("PlanWorkflowCompiler Extractor (compileWorkflowPlanFromRepo)", () => {
  it.live("extracts workspace stubs into CompiledPlan with SpanBudget compliance", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot } = initGitRepo(dir)
        writeFileSync(
          join(repoRoot, "libs", "alpha", "package.json"),
          JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
          "utf8",
        )
        writeFileSync(
          join(repoRoot, "libs", "alpha", "src", "index.ts"),
          `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const runAlpha = Effect.fn("Alpha.run")(function* () {\n  return yield* stub<void>("harness:SPEC-1", "REQ-1")\n})\n`,
          "utf8",
        )
        const { result: compiled, spans } = yield* runWithTestTracer(
          "compileWorkflowPlanFromRepo",
          compileWorkflowPlanFromRepo({
            repoRoot,
            level: "slice",
            mode: {
              _tag: "Automatic",
              runner: RunnerId.make("claude-code"),
              maxConcurrency: MaxConcurrency.make(2),
            },
          }),
        )
        expect(spans.some((s) => s.name === "Harness.compileWorkflowPlanFromRepo")).toBe(true)
        expect(yield* decideSpanBudgets({ spans })).toEqual([])
        expect(compiled.units.length).toBe(1)
        expect(compiled.units[0]?.ownedRelPaths).toEqual([OwnedRelPath.make("libs/alpha")])
      }),
    ),
  )

  it.live(
    "compiles explicit inputJsonPath and honors explicit CLI level/mode precedence over JSON overrides (F-14.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const inputJsonPath = WorkspaceFilePath.make(join(dir, "plan-input.json"))
          writeFileSync(
            inputJsonPath,
            JSON.stringify({
              runId: "run-json-0001",
              level: "epic",
              mode: {
                _tag: "Automatic",
                runner: "antigravity",
                maxConcurrency: 4,
              },
              units: [
                {
                  _tag: "PackageUnit",
                  unitId: "u-alpha",
                  projectName: "@harness/alpha",
                  ownedRelPaths: ["libs/alpha"],
                  stubKeys: ["Alpha.run"],
                  earsKeys: ["REQ-1"],
                  packageVerifyCommand: "pnpm nx run @harness/alpha:verify",
                },
              ],
              dependencies: [],
              sharedStepPaths: ["libs/shared"],
            }),
            "utf8",
          )
          const compiledExplicit = yield* compileWorkflowPlanFromRepo({
            repoRoot,
            level: "slice",
            mode: { _tag: "Manual" },
            inputJsonPath,
          })
          expect(compiledExplicit.runId).toBe("run-json-0001")
          expect(compiledExplicit.level).toBe("slice")
          expect(compiledExplicit.mode).toEqual({ _tag: "Manual" })
          expect(compiledExplicit.sharedStepPaths).toEqual([OwnedRelPath.make("libs/shared")])

          const compiledOmitted = yield* compileWorkflowPlanFromRepo({
            repoRoot,
            inputJsonPath,
          })
          expect(compiledOmitted.runId).toBe("run-json-0001")
          expect(compiledOmitted.level).toBe("epic")
          expect(compiledOmitted.mode).toEqual({
            _tag: "Automatic",
            runner: RunnerId.make("antigravity"),
            maxConcurrency: MaxConcurrency.make(4),
          })
          expect(compiledOmitted.sharedStepPaths).toEqual([OwnedRelPath.make("libs/shared")])
        }),
      ),
  )

  it.live(
    "fails closed with WorkspaceFsError on unreadable stub files or corrupt/unreadable package.json (F-14.2)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const pkgPath = join(repoRoot, "libs", "alpha", "package.json")
          const stubPath = join(repoRoot, "libs", "alpha", "src", "index.ts")
          writeFileSync(pkgPath, "{corrupt-json", "utf8")
          writeFileSync(
            stubPath,
            `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const runAlpha = Effect.fn("Alpha.run")(function* () {\n  return yield* stub<void>("harness:SPEC-1", "REQ-1")\n})\n`,
            "utf8",
          )

          const corruptPkgExit = yield* Effect.exit(
            compileWorkflowPlanFromRepo({
              repoRoot,
              level: "slice",
              mode: { _tag: "Manual" },
            }),
          )
          match(corruptPkgExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for corrupt package.json")
            })
            .exhaustive()

          writeFileSync(pkgPath, JSON.stringify({ name: "@harness/alpha" }), "utf8")
          chmodSync(stubPath, 0o000)

          const unreadableStubExit = yield* Effect.exit(
            compileWorkflowPlanFromRepo({
              repoRoot,
              level: "slice",
              mode: { _tag: "Manual" },
            }),
          )
          chmodSync(stubPath, 0o644)
          match(unreadableStubExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unreadable stub file")
            })
            .exhaustive()
        }),
      ),
  )
})
