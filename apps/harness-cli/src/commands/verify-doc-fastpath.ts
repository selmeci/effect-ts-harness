import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  checkLoopThrashing,
  computeMutableTreeHashChecked,
  decideGraphEntropy,
  type GovernanceDocReference,
  readExistingVerifyStamp,
  readFrictionEvents,
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

export const tryRunDocOnlyVerifyFastPath = (input: {
  readonly repoRoot: string
  readonly graph: HarnessGraph
  readonly governanceDocs: ReadonlyArray<GovernanceDocReference>
  readonly implBranch: string
  readonly options: CliEnv | undefined
}): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    if (input.options?.skipSubprocessVerify === true) {
      return undefined
    }
    const existingStamp = readExistingVerifyStamp(input.repoRoot, nodeSyncHostIo)
    if (
      existingStamp?.mutableTreeHash === undefined ||
      existingStamp.taskBranch !== input.implBranch
    ) {
      return undefined
    }
    const currentMutableRes = computeMutableTreeHashChecked(input.repoRoot, nodeSyncHostIo)
    const mutableMatched = match(currentMutableRes)
      .with({ _tag: "Success" }, ({ success }) => success === existingStamp.mutableTreeHash)
      .with({ _tag: "Failure" }, () => false)
      .exhaustive()
    if (!mutableMatched) {
      return undefined
    }

    const mutateReason = evaluateVerifyMutateStampGate(input.repoRoot, input.options)
    if (mutateReason !== undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:mutate-stamp\n${mutateReason}`,
      }
    }

    const gcReport = yield* decideGraphEntropy({
      graph: input.graph,
      governanceDocs: input.governanceDocs,
      workspaceRoot: input.repoRoot,
      hostIo: nodeSyncHostIo,
    })
    if (!gcReport.clean) {
      const msg = gcReport.findings
        .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
        .join("\n")
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:gc-doc-only\n${msg}`,
      }
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
    const refreshed = writeVerifyStamp(
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
    )
    return {
      exitCode: 0,
      stdout: JSON.stringify(refreshed),
      stderr: "",
    }
  })
