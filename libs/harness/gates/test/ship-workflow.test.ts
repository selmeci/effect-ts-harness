import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, type Exit, Fiber, Layer } from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AstSourceContent,
  AstSourceFilePath,
  CircuitBreakerStatus,
  GateDurationMs,
  GateExitCode,
  GateStderrSummary,
  MutationRestoreError,
  PlanSha256,
  SHIP_STAGES,
  ShipAttempt,
  ShipFailureMessage,
  ShipGateFailedError,
  type ShipRecoverBackupInput,
  ShipStage,
  type ShipStageCommandInput,
  ShipStagePassed,
  ShipTreeDriftError,
  type ShipTreeHashInput,
  ShipTreeMismatchError,
  type ShipWorkflowError,
  type ShipWorkflowPayload,
  WorkflowRunId,
  WorkspaceTreeHash,
} from "@harness/contract"
import { ts } from "@harness/graph"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { ShipGateRunner } from "@harness/service"
import {
  ShipWorkflow,
  ShipWorkflowLayer,
  type SpanSample,
  collectWorkflowBodyViolations,
  decideSpanBudgets,
  decideSyntaxBansGate,
  shipExecutionIdOf,
} from "../src/index.js"

const TREE_HASH_A = WorkspaceTreeHash.make("a".repeat(64))
const TREE_HASH_B = WorkspaceTreeHash.make("b".repeat(64))
const TREE_HASH_C = WorkspaceTreeHash.make("c".repeat(64))
const PLAN_SHA = PlanSha256.make("1".repeat(64))
const REPO_ROOT = AbsoluteRepoRoot.make("/tmp/harness-ship-workflow-test")

interface ShipSpy {
  readonly callOrder: Array<string>
  readonly computeInputs: Array<ShipTreeHashInput>
  readonly recoverInputs: Array<ShipRecoverBackupInput>
  readonly executeInputs: Array<ShipStageCommandInput>
}

const makeShipSpy = (): ShipSpy => ({
  callOrder: [],
  computeInputs: [],
  recoverInputs: [],
  executeInputs: [],
})

interface FakeRunnerHandlers {
  readonly computeTreeHash?: (
    input: ShipTreeHashInput,
    callIndex: number,
  ) => Effect.Effect<WorkspaceTreeHash, ShipGateFailedError>
  readonly recoverMutationBackup?: (
    input: ShipRecoverBackupInput,
  ) => Effect.Effect<void, MutationRestoreError>
  readonly executeStageCommand?: (
    input: ShipStageCommandInput,
  ) => Effect.Effect<ShipStagePassed, ShipGateFailedError>
}

const makeRunnerLayer = (spy: ShipSpy, handlers: FakeRunnerHandlers = {}) => {
  const runnerLayer = Layer.succeed(ShipGateRunner, {
    computeTreeHash: (input) =>
      Effect.gen(function* () {
        const callIndex = spy.computeInputs.length + 1
        spy.callOrder.push(`computeTreeHash:${input.stage}:${callIndex}`)
        spy.computeInputs.push(input)
        return handlers.computeTreeHash !== undefined
          ? yield* handlers.computeTreeHash(input, callIndex)
          : TREE_HASH_A
      }),
    recoverMutationBackup: (input) =>
      Effect.gen(function* () {
        spy.callOrder.push("recoverMutationBackup")
        spy.recoverInputs.push(input)
        if (handlers.recoverMutationBackup !== undefined) {
          yield* handlers.recoverMutationBackup(input)
        }
      }),
    executeStageCommand: (input) =>
      Effect.gen(function* () {
        spy.callOrder.push(`executeStageCommand:${input.stage}`)
        spy.executeInputs.push(input)
        return handlers.executeStageCommand !== undefined
          ? yield* handlers.executeStageCommand(input)
          : ShipStagePassed.make({
              stage: input.stage,
              durationMs: GateDurationMs.make(10),
            })
      }),
  })

  return ShipWorkflowLayer.pipe(
    Layer.provide(runnerLayer),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.merge(runnerLayer),
  )
}

const expectFailureError = <A>(exit: Exit.Exit<A, ShipWorkflowError>): ShipWorkflowError =>
  match(exit)
    .with({ _tag: "Success" }, () => expect.unreachable("Expected workflow failure exit"))
    .with({ _tag: "Failure" }, ({ cause }) => {
      expect(Cause.hasDies(cause)).toBe(false)
      expect(Cause.hasFails(cause)).toBe(true)
      return match(Cause.findErrorOption(cause))
        .with({ _tag: "None" }, () => expect.unreachable("Expected typed ShipWorkflowError"))
        .with({ _tag: "Some" }, ({ value }) => value)
        .exhaustive()
    })
    .exhaustive()

const makeGateFailedError = (
  stage: ShipStage,
  opts: {
    readonly exitCode?: number
    readonly stderr?: string
    readonly breaker?: CircuitBreakerStatus
    readonly escalation?: string
  } = {},
): ShipGateFailedError =>
  new ShipGateFailedError({
    stage,
    exitCode: GateExitCode.make(opts.exitCode ?? 1),
    stderrSummary: GateStderrSummary.make(opts.stderr ?? `${stage} failed`),
    circuitBreakerStatus: opts.breaker ?? "clear",
    ...(opts.escalation !== undefined
      ? { escalationMessage: ShipFailureMessage.make(opts.escalation) }
      : {}),
  })

const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

describe("ShipWorkflow", () => {
  it.live(
    "SPEC-0032 REQ-1.1 / RFC-0013 REQ-3.3 TraceTest: executes SHIP_STAGES in canonical order, passes SpanBudget.decide, emits ShipWorkflow/* & RunGate/* spans, and handles optional fields",
    () =>
      Effect.gen(function* () {
        const spyWithOpt = makeShipSpy()
        const payloadWithOpt: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-run-0001"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
          repoRoot: REPO_ROOT,
          planSha: PLAN_SHA,
        }

        const tracedEffect = Effect.gen(function* () {
          const executionId = yield* shipExecutionIdOf(payloadWithOpt)
          const receipt = yield* ShipWorkflow.execute(payloadWithOpt)
          return { executionId, receipt }
        }).pipe(Effect.provide(makeRunnerLayer(spyWithOpt)))

        const { result, spans } = yield* runWithTestTracer(
          "ShipWorkflow.REQ-1.1",
          tracedEffect,
          emptyFnIndex,
        )

        expect(result.executionId.length).toBeGreaterThan(0)
        expect(result.receipt).toEqual({
          runId: payloadWithOpt.runId,
          attempt: payloadWithOpt.attempt,
          verifiedTreeHash: TREE_HASH_A,
          planSha: PLAN_SHA,
        })

        const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
          spanId: s.spanId,
          name: s.name,
          parentSpanId: s.parentSpanId,
          durationMs: s.durationMs,
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          exitTag: match(s.exitTag)
            .with("Success", () => "Success" as const)
            .with("Failure", () => "Failure" as const)
            .with("Defect", () => "Defect" as const)
            .with("Interrupt", () => "Failure" as const)
            .with(undefined, () => undefined)
            .exhaustive(),
          errorTag: s.errorTag,
        }))
        const budgetViolations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(budgetViolations).toEqual([])
        expect(spans.some((s) => s.name === "ShipWorkflow.execute")).toBe(true)
        expect(spans.some((s) => s.name === "ShipWorkflow.executionIdOf")).toBe(true)
        expect(spans.filter((s) => s.name === "ShipWorkflow.runGate")).toHaveLength(6)
        expect(spans.filter((s) => s.name.startsWith("RunGate/")).map((s) => s.name)).toEqual(
          SHIP_STAGES.map((stage) => `RunGate/${stage}`),
        )

        expect(spyWithOpt.executeInputs.map((i) => i.stage)).toEqual([...SHIP_STAGES])
        expect(spyWithOpt.recoverInputs).toEqual([
          {
            runId: payloadWithOpt.runId,
            attempt: payloadWithOpt.attempt,
            expectedTreeHash: TREE_HASH_A,
            repoRoot: REPO_ROOT,
          },
        ])
        expect(spyWithOpt.computeInputs.length).toBe(8)
        expect(spyWithOpt.computeInputs.every((i) => i.repoRoot === REPO_ROOT)).toBe(true)
        expect(spyWithOpt.executeInputs.every((i) => i.repoRoot === REPO_ROOT)).toBe(true)

        const mutateStartIdx = spyWithOpt.callOrder.indexOf("computeTreeHash:mutate-strict:4")
        expect(spyWithOpt.callOrder.slice(mutateStartIdx, mutateStartIdx + 4)).toEqual([
          "computeTreeHash:mutate-strict:4",
          "recoverMutationBackup",
          "executeStageCommand:mutate-strict",
          "computeTreeHash:mutate-strict:5",
        ])
        expect(spyWithOpt.callOrder.slice(-3)).toEqual([
          "computeTreeHash:done:7",
          "executeStageCommand:done",
          "computeTreeHash:done:8",
        ])

        const spyNoOpt = makeShipSpy()
        const payloadNoOpt: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-run-0002"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const receiptNoOpt = yield* ShipWorkflow.execute(payloadNoOpt).pipe(
          Effect.provide(makeRunnerLayer(spyNoOpt)),
        )
        expect(receiptNoOpt).toEqual({
          runId: payloadNoOpt.runId,
          attempt: payloadNoOpt.attempt,
          verifiedTreeHash: TREE_HASH_A,
        })
        expect("planSha" in receiptNoOpt).toBe(false)
        expect(spyNoOpt.computeInputs.every((i) => !("repoRoot" in i))).toBe(true)
        expect(spyNoOpt.recoverInputs.every((i) => !("repoRoot" in i))).toBe(true)
        expect(spyNoOpt.executeInputs.every((i) => !("repoRoot" in i))).toBe(true)
      }),
    15_000,
  )

  it.live(
    "SPEC-0032 REQ-1.1 / RFC-0013 REQ-3.3: replays memoised ShipReceipt with zero re-executions and derives distinct executionIds across runId, treeHash, and attempt",
    () =>
      Effect.gen(function* () {
        const base: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-replay-01"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const idBase = yield* shipExecutionIdOf(base)
        const idSame = yield* shipExecutionIdOf(base)
        const idDiffRun = yield* shipExecutionIdOf({
          ...base,
          runId: WorkflowRunId.make("ship-replay-02"),
        })
        const idDiffHash = yield* shipExecutionIdOf({ ...base, treeHash: TREE_HASH_B })
        const idNextAttempt = yield* shipExecutionIdOf({ ...base, attempt: ShipAttempt.make(2) })

        expect(idSame).toBe(idBase)
        expect(new Set([idBase, idDiffRun, idDiffHash, idNextAttempt]).size).toBe(4)

        const spy = makeShipSpy()
        const layer = makeRunnerLayer(spy)
        yield* Effect.gen(function* () {
          const first = yield* ShipWorkflow.execute(base)
          const replayed = yield* ShipWorkflow.execute(base)
          expect(replayed).toEqual(first)
          expect(spy.executeInputs.length).toBe(6)
          expect(spy.computeInputs.length).toBe(8)
          expect(spy.recoverInputs.length).toBe(1)

          const attempt2Payload: ShipWorkflowPayload = { ...base, attempt: ShipAttempt.make(2) }
          const second = yield* ShipWorkflow.execute(attempt2Payload)
          expect(second.attempt).toBe(2)
          expect(spy.executeInputs.length).toBe(12)
          expect(spy.computeInputs.length).toBe(16)
          expect(spy.recoverInputs.length).toBe(2)
        }).pipe(Effect.provide(layer))
      }),
    15_000,
  )

  it.live(
    "SPEC-0032 REQ-1.2 / RFC-0013 REQ-3.4: fails with ShipTreeMismatchError before any backup recovery or command execution when pre-gate hash mismatches",
    () =>
      Effect.gen(function* () {
        for (const mismatchStage of ["format-check", "mutate-strict", "done"] as const) {
          const spy = makeShipSpy()
          const payload: ShipWorkflowPayload = {
            runId: WorkflowRunId.make(`ship-mis-${mismatchStage.slice(0, 4)}-1`),
            treeHash: TREE_HASH_A,
            attempt: ShipAttempt.make(1),
          }
          const layer = makeRunnerLayer(spy, {
            computeTreeHash: (input) =>
              Effect.succeed(input.stage === mismatchStage ? TREE_HASH_B : TREE_HASH_A),
          })

          const exit = yield* ShipWorkflow.execute(payload).pipe(Effect.exit, Effect.provide(layer))
          const err = expectFailureError(exit)
          expect(err).toBeInstanceOf(ShipTreeMismatchError)
          if (err instanceof ShipTreeMismatchError) {
            expect(err.stage).toBe(mismatchStage)
            expect(err.expected).toBe(TREE_HASH_A)
            expect(err.actual).toBe(TREE_HASH_B)
          }
          expect(spy.executeInputs.map((i) => i.stage)).toEqual(
            SHIP_STAGES.slice(0, SHIP_STAGES.indexOf(mismatchStage)),
          )
          expect(spy.recoverInputs.length).toBe(mismatchStage === "done" ? 1 : 0)
        }
      }),
    15_000,
  )

  it.live(
    "SPEC-0032 REQ-1.3 / RFC-0013 REQ-3.5: propagates MutationRestoreError, preserves ShipGateFailedError on post-mutate computeTreeHash failure, and cleans up backup on mutate-strict failure or interrupt",
    () =>
      Effect.gen(function* () {
        const basePayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-mutate-01"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }

        // 1. recoverMutationBackup fails -> MutationRestoreError, zero mutate-strict executeStageCommand
        const recoverFailSpy = makeShipSpy()
        const recoverExit = yield* ShipWorkflow.execute(basePayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(recoverFailSpy, {
              recoverMutationBackup: () =>
                Effect.fail(
                  new MutationRestoreError({
                    expected: TREE_HASH_A,
                    actual: TREE_HASH_B,
                    detail: ShipFailureMessage.make("backup bundle missing"),
                  }),
                ),
            }),
          ),
        )
        const recoverErr = expectFailureError(recoverExit)
        expect(recoverErr).toBeInstanceOf(MutationRestoreError)
        expect(recoverErr.message).toContain("backup bundle missing")
        expect(recoverFailSpy.executeInputs.map((i) => i.stage)).toEqual([
          "format-check",
          "gc-strict",
          "ontology-check-strict",
        ])

        // 2. Post-mutate computeTreeHash differs -> MutationRestoreError with expected/actual
        const driftSpy = makeShipSpy()
        const driftExit = yield* ShipWorkflow.execute(basePayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(driftSpy, {
              computeTreeHash: (input, callIndex) =>
                Effect.succeed(
                  input.stage === "mutate-strict" && callIndex === 5 ? TREE_HASH_C : TREE_HASH_A,
                ),
            }),
          ),
        )
        const driftErr = expectFailureError(driftExit)
        expect(driftErr).toBeInstanceOf(MutationRestoreError)
        if (driftErr instanceof MutationRestoreError) {
          expect(driftErr.expected).toBe(TREE_HASH_A)
          expect(driftErr.actual).toBe(TREE_HASH_C)
          expect(driftErr.detail).toBeUndefined()
        }
        expect(driftSpy.executeInputs.map((i) => i.stage)).toEqual([
          "format-check",
          "gc-strict",
          "ontology-check-strict",
          "mutate-strict",
        ])

        // 3. Post-mutate computeTreeHash fails -> propagates ShipGateFailedError cleanly via ShipWorkflow.execute
        const hashErrSpy = makeShipSpy()
        const hashErrPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-mutate-hash-err-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const postHashFailExit = yield* ShipWorkflow.execute(hashErrPayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(hashErrSpy, {
              computeTreeHash: (input, callIndex) =>
                input.stage === "mutate-strict" && callIndex === 5
                  ? Effect.fail(
                      makeGateFailedError("mutate-strict", {
                        exitCode: 7,
                        stderr: "git status failed",
                      }),
                    )
                  : Effect.succeed(TREE_HASH_A),
            }),
          ),
        )
        const postHashErr = expectFailureError(postHashFailExit)
        expect(postHashErr).toBeInstanceOf(ShipGateFailedError)
        if (postHashErr instanceof ShipGateFailedError) {
          expect(postHashErr.stage).toBe("mutate-strict")
          expect(postHashErr.exitCode).toBe(7)
          expect(postHashErr.stderrSummary).toBe("git status failed")
        }

        // 4. mutate-strict executeStageCommand failure runs backup cleanup while preserving original error
        const cmdFailSpy = makeShipSpy()
        const cmdFailPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-mutate-cmd-fail-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        let recoverCallCount = 0
        const cmdFailExit = yield* ShipWorkflow.execute(cmdFailPayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(cmdFailSpy, {
              recoverMutationBackup: () => {
                recoverCallCount += 1
                return recoverCallCount === 2
                  ? Effect.fail(
                      new MutationRestoreError({
                        expected: TREE_HASH_A,
                        actual: TREE_HASH_B,
                        detail: ShipFailureMessage.make("cleanup error ignored"),
                      }),
                    )
                  : Effect.void
              },
              executeStageCommand: (input) =>
                input.stage === "mutate-strict"
                  ? Effect.fail(
                      makeGateFailedError("mutate-strict", {
                        exitCode: 9,
                        stderr: "mutant survived",
                      }),
                    )
                  : Effect.succeed(
                      ShipStagePassed.make({
                        stage: input.stage,
                        durationMs: GateDurationMs.make(5),
                      }),
                    ),
            }),
          ),
        )
        const cmdFailErr = expectFailureError(cmdFailExit)
        expect(cmdFailErr).toBeInstanceOf(ShipGateFailedError)
        if (cmdFailErr instanceof ShipGateFailedError) {
          expect(cmdFailErr.stage).toBe("mutate-strict")
          expect(cmdFailErr.exitCode).toBe(9)
        }
        expect(cmdFailSpy.recoverInputs).toHaveLength(2)

        // 5. mutate-strict fiber interruption runs backup cleanup while preserving interrupt cause
        const interruptSpy = makeShipSpy()
        const interruptPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-mutate-interrupt-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const startedMutate = yield* Deferred.make<void>()
        const fiber = yield* ShipWorkflow.execute(interruptPayload).pipe(
          Effect.provide(
            makeRunnerLayer(interruptSpy, {
              executeStageCommand: (input) =>
                input.stage === "mutate-strict"
                  ? Deferred.succeed(startedMutate, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed(
                      ShipStagePassed.make({
                        stage: input.stage,
                        durationMs: GateDurationMs.make(5),
                      }),
                    ),
            }),
          ),
          Effect.forkChild,
        )
        yield* Deferred.await(startedMutate)
        yield* Fiber.interrupt(fiber)
        const interruptExit = yield* Fiber.await(fiber)
        match(interruptExit)
          .with({ _tag: "Success" }, () => expect.unreachable("Expected interrupt failure exit"))
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasInterruptsOnly(cause)).toBe(true)
          })
          .exhaustive()
        expect(interruptSpy.recoverInputs).toHaveLength(2)
      }),
    15_000,
  )

  it.live(
    "SPEC-0032 REQ-1.4 / RFC-0013 REQ-3.6 & stage errors: fails with ShipTreeDriftError after done drift and preserves ShipGateFailedError via ShipWorkflow.execute",
    () =>
      Effect.gen(function* () {
        // 1. done post-gate drift -> ShipTreeDriftError
        const driftSpy = makeShipSpy()
        const driftPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-done-drift-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const driftExit = yield* ShipWorkflow.execute(driftPayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(driftSpy, {
              computeTreeHash: (input, callIndex) =>
                Effect.succeed(
                  input.stage === "done" && callIndex === 8 ? TREE_HASH_B : TREE_HASH_A,
                ),
            }),
          ),
        )
        const driftErr = expectFailureError(driftExit)
        expect(driftErr).toBeInstanceOf(ShipTreeDriftError)
        if (driftErr instanceof ShipTreeDriftError) {
          expect(driftErr.stage).toBe("done")
          expect(driftErr.expected).toBe(TREE_HASH_A)
          expect(driftErr.actual).toBe(TREE_HASH_B)
        }

        // 2. done post-gate computeTreeHash failure propagates ShipGateFailedError directly via ShipWorkflow.execute
        const doneHashFailSpy = makeShipSpy()
        const doneFailPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-done-hash-fail-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const doneFailExit = yield* ShipWorkflow.execute(doneFailPayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(doneHashFailSpy, {
              computeTreeHash: (input, callIndex) =>
                input.stage === "done" && callIndex === 8
                  ? Effect.fail(makeGateFailedError("done", { exitCode: 3 }))
                  : Effect.succeed(TREE_HASH_A),
            }),
          ),
        )
        const doneFailErr = expectFailureError(doneFailExit)
        expect(doneFailErr).toBeInstanceOf(ShipGateFailedError)
        if (doneFailErr instanceof ShipGateFailedError) {
          expect(doneFailErr.stage).toBe("done")
          expect(doneFailErr.exitCode).toBe(3)
        }

        // 3. executeStageCommand ShipGateFailedError stops at failing stage and preserves all fields
        const gateFailSpy = makeShipSpy()
        const gateFailPayload: ShipWorkflowPayload = {
          runId: WorkflowRunId.make("ship-gate-fail-1"),
          treeHash: TREE_HASH_A,
          attempt: ShipAttempt.make(1),
        }
        const gateFailExit = yield* ShipWorkflow.execute(gateFailPayload).pipe(
          Effect.exit,
          Effect.provide(
            makeRunnerLayer(gateFailSpy, {
              executeStageCommand: (input) =>
                input.stage === "gc-strict"
                  ? Effect.fail(
                      makeGateFailedError("gc-strict", {
                        exitCode: 42,
                        stderr: "orphan node detected",
                        breaker: "tripped",
                        escalation: "Remove orphan node and rerun",
                      }),
                    )
                  : Effect.succeed(
                      ShipStagePassed.make({
                        stage: input.stage,
                        durationMs: GateDurationMs.make(5),
                      }),
                    ),
            }),
          ),
        )
        const gateErr = expectFailureError(gateFailExit)
        expect(gateErr).toBeInstanceOf(ShipGateFailedError)
        if (gateErr instanceof ShipGateFailedError) {
          expect(gateErr.stage).toBe("gc-strict")
          expect(gateErr.exitCode).toBe(42)
          expect(gateErr.stderrSummary).toBe("orphan node detected")
          expect(gateErr.circuitBreakerStatus).toBe("tripped")
          expect(gateErr.escalationMessage).toBe("Remove orphan node and rerun")
        }
        expect(gateFailSpy.executeInputs.map((i) => i.stage)).toEqual(["format-check", "gc-strict"])
        expect(gateFailSpy.computeInputs.map((i) => i.stage)).toEqual(["format-check", "gc-strict"])
      }),
    15_000,
  )

  it.effect(
    "SPEC-0032 REQ-1.1: produces zero workflow-body AST and syntax-bans violations on libs/harness/gates/src/ship-workflow.ts",
    () =>
      Effect.gen(function* () {
        const filePath = resolve(import.meta.dirname, "../src/ship-workflow.ts")
        const content = readFileSync(filePath, "utf8")
        const normPath = "libs/harness/gates/src/ship-workflow.ts"
        const sourceFile = ts.createSourceFile(
          normPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        )

        expect(collectWorkflowBodyViolations(sourceFile, normPath)).toEqual([])
        const report = yield* decideSyntaxBansGate({
          files: [
            {
              filePath: AstSourceFilePath.make(normPath),
              content: AstSourceContent.make(content),
            },
          ],
        })
        expect(report.verdict).toBe("clean")
        expect(report.violations).toEqual([])
      }),
  )
})
