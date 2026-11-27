import { join } from "node:path"
import { Effect, Option, Result } from "effect"
import { match } from "ts-pattern"
import {
  decideSpanBudgets,
  DstExecutionTier,
  DstStepCount,
  parseDstSeedEnv,
  runDstSeedSuite,
  writeVerifyStamp,
} from "@harness/gates"
import type { HarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  type CliEnv,
  type CliResult,
  formatSubprocessError,
  isIsolatedExternalWorkspace,
  shouldSuppressLiveRepoTestSideEffects,
} from "./daemon-and-omnigraph.service.js"
import { buildHookRuntimeSnapshot } from "./hook-runtime-loader.js"
import {
  isVerifyMutateStampGateEnforced,
  resolveVerifyStampMutateMeta,
} from "./mutate-and-bench.command.js"
import { CLI_REPO_ROOT } from "./repo-path.js"
import { buildDstTargetsFromGraph, readRecordedSpans } from "./verify-delta-gates.js"

const resolveOxfmtBinaryPath = (repoRoot: string): string | undefined => {
  const repoLocalBin = join(repoRoot, "node_modules", ".bin", "oxfmt")
  if (nodeSyncHostIo.existsSync(repoLocalBin)) {
    return repoLocalBin
  }
  const workspaceBin = join(CLI_REPO_ROOT, "node_modules", ".bin", "oxfmt")
  if (nodeSyncHostIo.existsSync(workspaceBin)) {
    return workspaceBin
  }
  return undefined
}

/**
 * Runs `oxfmt --check` on existing modified delta files as a fail-fast pre-flight
 * gate before `nx affected -t verify` (`SPEC-0037 REQ-4.1`, `REQ-4.2`).
 */
export const runVerifyFormatPreFlight = (
  repoRoot: string,
  deltaFiles: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Option.Option<CliResult> => {
  if (options?.skipSubprocessVerify === true || deltaFiles.length === 0) {
    return Option.none()
  }
  const existingFiles = deltaFiles.filter((relPath) =>
    nodeSyncHostIo.existsSync(join(repoRoot, relPath)),
  )
  if (existingFiles.length === 0) {
    return Option.none()
  }
  const oxfmtBin = resolveOxfmtBinaryPath(repoRoot)
  if (oxfmtBin === undefined) {
    return Option.some<CliResult>({
      exitCode: 1,
      stdout: "",
      stderr:
        "[GATE FAILURE] verify:format\noxfmt binary not found in repo or workspace node_modules/.bin/oxfmt.",
    })
  }

  const configArgs =
    !nodeSyncHostIo.existsSync(join(repoRoot, ".oxfmtrc.json")) &&
    nodeSyncHostIo.existsSync(join(CLI_REPO_ROOT, ".oxfmtrc.json"))
      ? ["--config", join(CLI_REPO_ROOT, ".oxfmtrc.json")]
      : []

  const res = nodeSyncHostIo.execFileSync(
    oxfmtBin,
    [...configArgs, "--check", "--no-error-on-unmatched-pattern", "--", ...existingFiles],
    { cwd: repoRoot },
  )
  return match(res)
    .with({ _tag: "Exited" }, (exited) =>
      exited.exitCode === 0
        ? Option.none()
        : Option.some<CliResult>({
            exitCode: 1,
            stdout: "",
            stderr: `[GATE FAILURE] verify:format\n${formatSubprocessError(exited) || "Unformatted files detected by oxfmt --check."}`,
          }),
    )
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, (err) =>
      Option.some<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:format\n${formatSubprocessError(err)}`,
      }),
    )
    .exhaustive()
}

/**
 * Evaluates DST seed schedule, span causality budgets, refreshes the isolated hook
 * runtime snapshot (`REQ-4.3`), and writes `.harness/verify-stamp.json`.
 */
export const finalizeVerifyPostChecks = (input: {
  readonly repoRoot: string
  readonly graph: HarnessGraph
  readonly implBranch: string
  readonly options: CliEnv | undefined
}): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const seedRes = Result.try(() => parseDstSeedEnv(process.env["DST_SEED"]))
    return yield* match(seedRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.succeed<CliResult>({
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:dst-seed\n${failure instanceof Error ? failure.message : String(failure)}`,
        }),
      )
      .with({ _tag: "Success" }, ({ success: pinnedSeed }) =>
        Effect.gen(function* () {
          const dstSuiteResult = yield* runDstSeedSuite({
            tier: DstExecutionTier.make(process.env.CI === "true" ? "ci_full" : "fast_local"),
            pinnedSeed,
            stepCount: DstStepCount.make(8),
            targets: buildDstTargetsFromGraph(input.graph),
          }).pipe(
            Effect.map((suite) => ({ _tag: "Ok" as const, suite })),
            Effect.catchTag("DstScheduleError", (err) =>
              Effect.succeed({ _tag: "Err" as const, err }),
            ),
          )
          return yield* match(dstSuiteResult)
            .with({ _tag: "Err" }, ({ err }) =>
              Effect.succeed<CliResult>({
                exitCode: 1,
                stdout: "",
                stderr: `[GATE FAILURE] verify:dst-schedule\n${err.reason ?? err.message}`,
              }),
            )
            .with({ _tag: "Ok" }, ({ suite }) =>
              Effect.gen(function* () {
                const spanReadResult = yield* readRecordedSpans(input.repoRoot).pipe(
                  Effect.map((spans) => ({ _tag: "Ok" as const, spans })),
                  Effect.catchTag("SpanTraceReadError", (err) =>
                    Effect.succeed({ _tag: "SpanReadErr" as const, err }),
                  ),
                )
                return yield* match(spanReadResult)
                  .with({ _tag: "SpanReadErr" }, ({ err }) =>
                    Effect.succeed<CliResult>({
                      exitCode: 1,
                      stdout: "",
                      stderr: `[GATE FAILURE] verify:span-budget\n${err.message}`,
                    }),
                  )
                  .with({ _tag: "Ok" }, ({ spans: recordedSpans }) =>
                    Effect.gen(function* () {
                      const spanBudgetsResult = yield* decideSpanBudgets({
                        spans: recordedSpans,
                        // Empty causalityRules preserves pre-existing default span-budget behavior from main.
                        causalityRules: [],
                        failOnViolation: true,
                      }).pipe(
                        Effect.map(() => ({ _tag: "Ok" as const })),
                        Effect.catchTag("SpanCausalityError", (err) =>
                          Effect.succeed({ _tag: "Err" as const, err }),
                        ),
                      )
                      return match(spanBudgetsResult)
                        .with({ _tag: "Err" }, ({ err }) => ({
                          exitCode: 1,
                          stdout: "",
                          stderr: `[GATE FAILURE] verify:span-budget\n${err.message}`,
                        }))
                        .with({ _tag: "Ok" }, () => {
                          if (
                            !isIsolatedExternalWorkspace(input.repoRoot) &&
                            !shouldSuppressLiveRepoTestSideEffects(input.repoRoot)
                          ) {
                            const snapErr = match(buildHookRuntimeSnapshot(input.repoRoot))
                              .with({ _tag: "Built" }, () => undefined)
                              .with({ _tag: "Failed" }, ({ reason }) => reason)
                              .exhaustive()
                            if (snapErr !== undefined) {
                              return {
                                exitCode: 1,
                                stdout: "",
                                stderr: `[GATE FAILURE] verify:hook-runtime-snapshot\n${snapErr}`,
                              }
                            }
                          }
                          const stamp = writeVerifyStamp(
                            input.repoRoot,
                            nodeSyncHostIo,
                            input.implBranch,
                            {
                              dstSeed: suite.initialSeed,
                              dstSeedsRun: suite.seedsRun,
                            },
                            isVerifyMutateStampGateEnforced(input.repoRoot, input.options)
                              ? resolveVerifyStampMutateMeta(input.repoRoot)
                              : undefined,
                          )
                          return { exitCode: 0, stdout: JSON.stringify(stamp), stderr: "" }
                        })
                        .exhaustive()
                    }),
                  )
                  .exhaustive()
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  })
