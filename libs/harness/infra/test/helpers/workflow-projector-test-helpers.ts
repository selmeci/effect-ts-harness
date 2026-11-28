import { Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { expect } from "@effect/vitest"
import {
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanJsonPayload,
  PlanSha256,
  RunnerId,
  StubSymbolKey,
  WaveIndex,
  WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  type WorkflowProjectAllOutcome,
  type WorkflowProjectionOutcome,
  WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  type WorkflowUnitRecord,
} from "@harness/contract"
import { WorkflowReadModelQuery, type WorkflowReadModelQueryShape } from "@harness/service"
import { type Omnigraph } from "./workflow-read-model-fixture.js"

export const encodeCompiledPlan = Schema.encodeSync(Schema.fromJsonString(CompiledPlan))

export const BASE_SHA = GitCommitSha.make("a".repeat(40))
export const PLAN_SHA = PlanSha256.make("b".repeat(64))
export const STAMP_HASH = PackageStampHash.make("c".repeat(64))
export const NOW_MS = WorkflowTimestampMs.make(1_700_000_000_000)

export const wrapHarnessClient = (
  client: Omnigraph,
  overrides: {
    readonly onMutate?: (
      orig: typeof client.mutate,
      input: Parameters<typeof client.mutate>[0],
      opts?: Parameters<typeof client.mutate>[1],
    ) => ReturnType<typeof client.mutate>
    readonly onQuery?: (
      orig: typeof client.query,
      input: Parameters<typeof client.query>[0],
      opts?: Parameters<typeof client.query>[1],
    ) => ReturnType<typeof client.query>
    readonly onBranchesList?: (
      orig: typeof client.branches.list,
      opts?: Parameters<typeof client.branches.list>[0],
    ) => ReturnType<typeof client.branches.list>
    readonly onBranchesCreate?: (
      orig: typeof client.branches.create,
      input: Parameters<typeof client.branches.create>[0],
      opts?: Parameters<typeof client.branches.create>[1],
    ) => ReturnType<typeof client.branches.create>
  },
): Omnigraph =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "mutate" && overrides.onMutate !== undefined) {
        const fn = overrides.onMutate
        return (
          input: Parameters<typeof target.mutate>[0],
          opts?: Parameters<typeof target.mutate>[1],
        ) => fn(target.mutate.bind(target), input, opts)
      }
      if (prop === "query" && overrides.onQuery !== undefined) {
        const fn = overrides.onQuery
        return (
          input: Parameters<typeof target.query>[0],
          opts?: Parameters<typeof target.query>[1],
        ) => fn(target.query.bind(target), input, opts)
      }
      if (
        prop === "branches" &&
        (overrides.onBranchesList !== undefined || overrides.onBranchesCreate !== undefined)
      ) {
        return new Proxy(target.branches, {
          get(bTarget, bProp, bReceiver) {
            if (bProp === "list" && overrides.onBranchesList !== undefined) {
              const fn = overrides.onBranchesList
              return (opts?: Parameters<typeof target.branches.list>[0]) =>
                fn(bTarget.list.bind(bTarget), opts)
            }
            if (bProp === "create" && overrides.onBranchesCreate !== undefined) {
              const fn = overrides.onBranchesCreate
              return (
                input: Parameters<typeof target.branches.create>[0],
                opts?: Parameters<typeof target.branches.create>[1],
              ) => fn(bTarget.create.bind(bTarget), input, opts)
            }
            return Reflect.get(bTarget, bProp, bReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })

export const makeStubReadModelLayer = (data: {
  readonly runs: ReadonlyMap<WorkflowRunId, WorkflowRunRecord>
  readonly unitsByRun: ReadonlyMap<WorkflowRunId, ReadonlyArray<WorkflowUnitRecord>>
  readonly attemptsByRun: ReadonlyMap<WorkflowRunId, ReadonlyArray<WorkflowAttemptRecord>>
  readonly failOnGetRun?: WorkflowStoreUnavailableError | undefined
}): Layer.Layer<WorkflowReadModelQuery> => {
  const shape: WorkflowReadModelQueryShape = {
    getRun: (runId) =>
      data.failOnGetRun !== undefined
        ? Effect.fail(data.failOnGetRun)
        : Effect.succeed(Option.fromUndefinedOr(data.runs.get(runId))),
    listRuns:
      data.failOnGetRun !== undefined
        ? Effect.fail(data.failOnGetRun)
        : Effect.succeed(Array.from(data.runs.values())),
    listUnits: (runId) => Effect.succeed(data.unitsByRun.get(runId) ?? []),
    listAttempts: (runId) => Effect.succeed(data.attemptsByRun.get(runId) ?? []),
    probeAvailability: Effect.succeed("ready" as const),
  }
  return Layer.succeed(WorkflowReadModelQuery, shape)
}

export const makeRunRecord = (
  runId: WorkflowRunId,
  planJson?: PlanJsonPayload,
): WorkflowRunRecord => ({
  runId,
  executionId: WorkflowExecutionId.make(`exec-${runId}`),
  level: "slice",
  planSha: PLAN_SHA,
  baseSha: BASE_SHA,
  state: "running",
  ...(planJson !== undefined ? { planJson } : {}),
  updatedMs: NOW_MS,
})

export const makeSingleRunReadModelLayer = (
  runId: WorkflowRunId,
  options?: {
    readonly planJson?: PlanJsonPayload | undefined
    readonly units?: ReadonlyArray<WorkflowUnitRecord> | undefined
    readonly attempts?: ReadonlyArray<WorkflowAttemptRecord> | undefined
  },
): Layer.Layer<WorkflowReadModelQuery> =>
  makeStubReadModelLayer({
    runs: new Map([[runId, makeRunRecord(runId, options?.planJson)]]),
    unitsByRun: options?.units !== undefined ? new Map([[runId, options.units]]) : new Map(),
    attemptsByRun:
      options?.attempts !== undefined ? new Map([[runId, options.attempts]]) : new Map(),
  })

export const makeAlphaPlan = (runId: WorkflowRunId, unitId: WorkUnitId): CompiledPlan => ({
  runId,
  level: "slice",
  planSha: PLAN_SHA,
  baseSha: BASE_SHA,
  mode: {
    _tag: "Automatic",
    runner: RunnerId.make("claude-code"),
    maxConcurrency: MaxConcurrency.make(2),
  },
  units: [
    {
      _tag: "PackageUnit",
      unitId,
      projectName: NxProjectName.make("@harness/alpha"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
      stubKeys: [StubSymbolKey.make("libs/alpha/src/index.ts#alphaFn")],
      earsKeys: [EarsRequirementKey.make("harness:SPEC-0038::REQ-3.1")],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    },
  ],
  sharedStepPaths: [],
})

export const makeHangingBranchesClient = (client: Omnigraph): Omnigraph =>
  wrapHarnessClient(client, {
    onBranchesList: (_orig, opts) =>
      new Promise((_r, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  })

export const expectStaleOutcome = (
  outcome: WorkflowProjectionOutcome | WorkflowProjectAllOutcome,
  expectedReasonSubstr?: string,
): void => {
  match(outcome)
    .with({ _tag: "Stale" }, (s) => {
      expect(s.projectionStatus).toBe("stale")
      if (expectedReasonSubstr !== undefined) {
        expect(s.reason).toContain(expectedReasonSubstr)
      }
    })
    .with({ _tag: "Projected" }, { _tag: "Skipped" }, () =>
      expect.unreachable(`expected Stale outcome, got ${outcome._tag}`),
    )
    .exhaustive()
}
