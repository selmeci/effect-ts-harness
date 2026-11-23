import { join } from "node:path"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import { IDIOM_BLOCKS } from "@harness/decision"
import {
  checkLoopThrashing,
  computeMutableTreeHashChecked,
  decideGraphEntropy,
  decideSpanBudgets,
  DstExecutionTier,
  type GovernanceDocReference,
  parseDstSeedEnv,
  readExistingVerifyStamp,
  readFrictionEvents,
  resolveDstSeedCount,
  writeVerifyStamp,
} from "@harness/gates"
import type { HarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, recordFriction } from "./daemon-and-omnigraph.service.js"
import {
  evaluateVerifyMutateStampGate,
  isVerifyMutateStampGateEnforced,
  resolveVerifyStampMutateMeta,
} from "./mutate-and-bench.command.js"
import { readRecordedSpans } from "./verify-delta-gates.js"

export const verifyFailureWithThrashing = (
  options: CliEnv | undefined,
  repoRoot: string,
  summary: string,
  detail: string,
  stderrMsg: string,
): CliResult => {
  recordFriction(options, { kind: "verify_failure", summary, detail })
  const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot, nodeSyncHostIo))
  if (thrashing.stuck && thrashing.escalationMessage !== null) {
    return { exitCode: 2, stdout: "", stderr: `${thrashing.escalationMessage}\n${stderrMsg}` }
  }
  return { exitCode: 1, stdout: "", stderr: stderrMsg }
}

export type DocOnlyVerifyFastPathOutcome =
  | { readonly _tag: "Executed"; readonly result: CliResult }
  | { readonly _tag: "Skipped"; readonly reason: string }

const fastPathSkipped = (reason: string): DocOnlyVerifyFastPathOutcome => ({
  _tag: "Skipped",
  reason,
})

const fastPathExecuted = (result: CliResult): DocOnlyVerifyFastPathOutcome => ({
  _tag: "Executed",
  result,
})

export const tryRunDocOnlyVerifyFastPath = (input: {
  readonly repoRoot: string
  readonly graph: HarnessGraph
  readonly governanceDocs: ReadonlyArray<GovernanceDocReference>
  readonly implBranch: string
  readonly options: CliEnv | undefined
}): Effect.Effect<DocOnlyVerifyFastPathOutcome> =>
  Effect.gen(function* () {
    if (input.options?.skipSubprocessVerify === true) {
      return fastPathSkipped("skipSubprocessVerify flag enabled")
    }
    const existingStamp = readExistingVerifyStamp(input.repoRoot, nodeSyncHostIo)
    if (
      existingStamp?.mutableTreeHash === undefined ||
      existingStamp.taskBranch !== input.implBranch
    ) {
      return fastPathSkipped("no valid prior verify-stamp or taskBranch mismatch")
    }

    const seedRes = Result.try(() => parseDstSeedEnv(process.env["DST_SEED"]))
    const seedOutcome = match(seedRes)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        errorReason: failure instanceof Error ? failure.message : String(failure),
        pinnedSeed: undefined,
      }))
      .with({ _tag: "Success" }, ({ success }) => ({
        errorReason: undefined,
        pinnedSeed: success,
      }))
      .exhaustive()
    if (seedOutcome.errorReason !== undefined) {
      return fastPathExecuted({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:dst-seed\n${seedOutcome.errorReason}`,
      })
    }
    if (seedOutcome.pinnedSeed !== undefined && existingStamp.dstSeed !== seedOutcome.pinnedSeed) {
      return fastPathSkipped("DST_SEED mismatch")
    }

    const requiredSeeds = resolveDstSeedCount(
      DstExecutionTier.make(process.env.CI === "true" ? "ci_full" : "fast_local"),
    )
    if ((existingStamp.dstSeedsRun ?? 0) < requiredSeeds) {
      return fastPathSkipped("insufficient dstSeedsRun")
    }

    const currentMutableRes = computeMutableTreeHashChecked(input.repoRoot, nodeSyncHostIo)
    const mutableOutcome = match(currentMutableRes)
      .with({ _tag: "Success" }, ({ success }) =>
        success === existingStamp.mutableTreeHash
          ? undefined
          : fastPathSkipped("mutableTreeHash mismatch"),
      )
      .with({ _tag: "Failure" }, ({ failure }) =>
        fastPathExecuted({
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:mutable-tree-hash\n${failure}`,
        }),
      )
      .exhaustive()
    if (mutableOutcome !== undefined) {
      return mutableOutcome
    }

    const mutateReason = evaluateVerifyMutateStampGate(input.repoRoot, input.options)
    if (mutateReason !== undefined) {
      return fastPathExecuted({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:mutate-stamp\n${mutateReason}`,
      })
    }

    const hasPatternsDir = nodeSyncHostIo.existsSync(join(input.repoRoot, "agent-patterns"))
    const gcReport = yield* decideGraphEntropy({
      graph: input.graph,
      expectedPatterns: hasPatternsDir ? IDIOM_BLOCKS : undefined,
      checkUntestedDomainFns: true,
      checkDeciderPropertyTests: true,
      governanceDocs: input.governanceDocs,
      workspaceRoot: input.repoRoot,
      hostIo: nodeSyncHostIo,
    })
    if (!gcReport.clean) {
      const msg = gcReport.findings
        .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
        .join("\n")
      return fastPathExecuted({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:gc-doc-only\n${msg}`,
      })
    }

    const spanReadResult = yield* readRecordedSpans(input.repoRoot).pipe(
      Effect.map((spans) => ({ _tag: "Ok" as const, spans })),
      Effect.catchTag("SpanTraceReadError", (err) =>
        Effect.succeed({ _tag: "SpanReadErr" as const, err }),
      ),
    )
    const spanBudgetFailure = yield* match(spanReadResult)
      .with({ _tag: "SpanReadErr" }, ({ err }) => Effect.succeed(err.message))
      .with({ _tag: "Ok" }, ({ spans: recordedSpans }) =>
        decideSpanBudgets({
          spans: recordedSpans,
          causalityRules: [],
          failOnViolation: true,
        }).pipe(
          Effect.as(undefined),
          Effect.catchTag("SpanCausalityError", (err) => Effect.succeed(err.message)),
        ),
      )
      .exhaustive()
    if (spanBudgetFailure !== undefined) {
      return fastPathExecuted({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:span-budget\n${spanBudgetFailure}`,
      })
    }

    const mutateMeta = isVerifyMutateStampGateEnforced(input.repoRoot, input.options)
      ? resolveVerifyStampMutateMeta(input.repoRoot)
      : existingStamp.mutateEnforcementMode !== undefined
        ? {
            mutateEnforcementMode: existingStamp.mutateEnforcementMode,
            ...(existingStamp.mutantsEvaluated !== undefined
              ? { mutantsEvaluated: existingStamp.mutantsEvaluated }
              : {}),
          }
        : undefined
    const writeRes = Result.try(() =>
      writeVerifyStamp(
        input.repoRoot,
        nodeSyncHostIo,
        input.implBranch,
        {
          ...(existingStamp.dstSeed !== undefined ? { dstSeed: existingStamp.dstSeed } : {}),
          ...(existingStamp.dstSeedsRun !== undefined
            ? { dstSeedsRun: existingStamp.dstSeedsRun }
            : {}),
        },
        mutateMeta,
      ),
    )
    return match(writeRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        fastPathExecuted({
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:stamp-write\n${failure instanceof Error ? failure.message : String(failure)}`,
        }),
      )
      .with({ _tag: "Success" }, ({ success: refreshed }) =>
        fastPathExecuted({
          exitCode: 0,
          stdout: JSON.stringify(refreshed),
          stderr: "",
        }),
      )
      .exhaustive()
  })
