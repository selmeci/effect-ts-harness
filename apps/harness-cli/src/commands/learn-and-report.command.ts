import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { deterministicLearnFallback, proposeLearningAction } from "@harness/decision"
import {
  buildSessionReport,
  checkVerifyStamp,
  clearFrictionEvents,
  clearTelemetryEvents,
  decidePlanSearch,
  decideRuleSynthesizer,
  type FrictionEvent,
  PlanSearchInput,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  RuleSynthesizerInput,
  summarizeFrictionEvents,
  type TelemetryEvent,
  writeSessionReportFiles,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type CliEnv,
  type CliResult,
  findWorkspaceRoot,
  resolveDecisionModelLayer,
  shouldSuppressLiveRepoTestSideEffects,
} from "./daemon-and-omnigraph.service.js"

/** Reads friction events without crashing on invalid `HARNESS_STATE_DIR`. */
export const readFrictionEventsSafe = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ReadonlyArray<FrictionEvent> =>
  match(Result.try(() => readFrictionEvents(repoRoot, hostIo)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:session] Warning: failed to read friction events (${failure instanceof Error ? failure.message : String(failure)})\n`,
      )
      return []
    })
    .exhaustive()

/** Reads telemetry events without crashing on invalid `HARNESS_STATE_DIR`. */
export const readTelemetryEventsSafe = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ReadonlyArray<TelemetryEvent> =>
  match(Result.try(() => readTelemetryEvents(repoRoot, hostIo)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:session] Warning: failed to read telemetry events (${failure instanceof Error ? failure.message : String(failure)})\n`,
      )
      return []
    })
    .exhaustive()

const clearFrictionEventsSafe = (repoRoot: string, hostIo: SyncHostIo): void => {
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot)) return
  match(Result.try(() => clearFrictionEvents(repoRoot, hostIo)))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:learn] Warning: failed to clear friction events (${failure instanceof Error ? failure.message : String(failure)})\n`,
      )
    })
    .exhaustive()
}

const clearTelemetryEventsSafe = (repoRoot: string, hostIo: SyncHostIo): void => {
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot)) return
  match(Result.try(() => clearTelemetryEvents(repoRoot, hostIo)))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:report] Warning: failed to clear telemetry events (${failure instanceof Error ? failure.message : String(failure)})\n`,
      )
    })
    .exhaustive()
}

/** Writes session report files without crashing on invalid `HARNESS_STATE_DIR`. */
export const writeSessionReportFilesSafe = (
  repoRoot: string,
  report: ReturnType<typeof buildSessionReport>,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot)) return
  match(Result.try(() => writeSessionReportFiles(repoRoot, report, hostIo)))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:report] Warning: failed to write session report (${failure instanceof Error ? failure.message : String(failure)})\n`,
      )
    })
    .exhaustive()
}

export const handleLearn = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldClear = argv.includes("--clear")
    const events = readFrictionEventsSafe(repoRoot, nodeSyncHostIo)
    const clusters = summarizeFrictionEvents(events)
    const proposals = []
    let useFastFallback =
      (shouldClear && options?.decisionLayer === undefined) || argv.includes("--deterministic")

    for (const cluster of clusters) {
      const input = {
        kind: cluster.kind,
        summary: cluster.summary,
        detail: cluster.detail,
        occurrences: cluster.occurrences,
      }
      const proposal = useFastFallback
        ? deterministicLearnFallback(input)
        : yield* proposeLearningAction(input).pipe(Effect.provide(decisionLayer))
      if (proposal.source === "deterministic-fallback") {
        useFastFallback = true
      }
      proposals.push({
        key: cluster.key,
        kind: cluster.kind,
        summary: cluster.summary,
        occurrences: cluster.occurrences,
        lastSeen: cluster.lastSeen,
        ...proposal,
      })
    }

    const warnings: Array<string> = []
    const warnLearn = (msg: string): void => {
      warnings.push(msg)
      process.stderr.write(`[harness:learn] Warning: ${msg}\n`)
    }
    let synthesizedRules: ReadonlyArray<unknown> = []
    const rejectedRules: Array<{ ruleId: string; stage: string; reason: string }> = []
    let planSearchResults: unknown = undefined
    const learnedSlicesPath = join(repoRoot, ".harness", "learned-slices.json")
    if (nodeSyncHostIo.existsSync(learnedSlicesPath)) {
      const rawSlices = yield* Effect.try({
        try: () => nodeSyncHostIo.readTextSync(learnedSlicesPath),
        catch: (err) => {
          warnLearn(
            `failed to read ${learnedSlicesPath}: ${err instanceof Error ? err.message : String(err)}`,
          )
          return undefined
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (rawSlices !== undefined) {
        const decodeJson = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )
        const parsedOpt = decodeJson(rawSlices)
        yield* match(parsedOpt)
          .with({ _tag: "Some" }, ({ value: parsed }) =>
            Effect.gen(function* () {
              if (Array.isArray(parsed["slices"])) {
                const rules: Array<unknown> = []
                for (let idx = 0; idx < parsed["slices"].length; idx++) {
                  const s = parsed["slices"][idx]
                  const decodedSlice = Schema.decodeUnknownOption(RuleSynthesizerInput)(s)
                  yield* match(decodedSlice)
                    .with({ _tag: "Some" }, ({ value: slice }) =>
                      Effect.gen(function* () {
                        const synthRes = yield* decideRuleSynthesizer(slice).pipe(
                          Effect.map((report) => ({ _tag: "Ok" as const, report })),
                          Effect.catchTag("RuleSynthesisError", (err) =>
                            Effect.succeed({ _tag: "Err" as const, err }),
                          ),
                        )
                        match(synthRes)
                          .with({ _tag: "Ok" }, ({ report }) => {
                            rules.push(report)
                          })
                          .with({ _tag: "Err" }, ({ err }) => {
                            const stage = err.stage ?? "unknown"
                            const reason = err.reason ?? err.message
                            rejectedRules.push({
                              ruleId: String(slice.taskId),
                              stage,
                              reason,
                            })
                            warnLearn(
                              `rule synthesis rejected for '${slice.taskId}' [${stage}]: ${reason}`,
                            )
                          })
                          .exhaustive()
                      }),
                    )
                    .with({ _tag: "None" }, () =>
                      Effect.sync(() => {
                        warnLearn(
                          `invalid RuleSynthesizerInput at slices[${idx}] in ${learnedSlicesPath}`,
                        )
                      }),
                    )
                    .exhaustive()
                }
                synthesizedRules = rules
              }
              if (Array.isArray(parsed["candidates"])) {
                const rawPlanInput: unknown = {
                  candidates: parsed["candidates"],
                  requireZeroViolations: false,
                }
                const decodedPlanSearch = Schema.decodeUnknownOption(PlanSearchInput)(rawPlanInput)
                planSearchResults = yield* match(decodedPlanSearch)
                  .with({ _tag: "Some" }, ({ value: input }) =>
                    decidePlanSearch(input).pipe(
                      Effect.catch((err) =>
                        Effect.sync(() => {
                          warnLearn(`decidePlanSearch failed: ${String(err)}`)
                          return undefined
                        }),
                      ),
                    ),
                  )
                  .with({ _tag: "None" }, () =>
                    Effect.sync(() => {
                      warnLearn(`invalid PlanSearchInput candidates in ${learnedSlicesPath}`)
                      return undefined
                    }),
                  )
                  .exhaustive()
              }
            }),
          )
          .with({ _tag: "None" }, () =>
            Effect.sync(() => {
              warnLearn(`failed to decode ${learnedSlicesPath} as JSON object`)
            }),
          )
          .exhaustive()
      }
    }

    const hasErrors = rejectedRules.length > 0 || warnings.length > 0
    const cleared = shouldClear && !hasErrors
    if (cleared) {
      clearFrictionEventsSafe(repoRoot, nodeSyncHostIo)
    }

    return {
      exitCode: hasErrors ? 1 : 0,
      stdout: JSON.stringify({
        totalEvents: events.length,
        proposals,
        cleared,
        ...(synthesizedRules.length > 0 ? { synthesizedRules } : {}),
        ...(rejectedRules.length > 0 ? { rejectedRules } : {}),
        ...(planSearchResults !== undefined ? { planSearchResults } : {}),
      }),
      stderr: warnings.join("\n"),
    }
  })

export const handleReport = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (argv.includes("--reset") || argv.includes("--clear")) {
      clearTelemetryEventsSafe(repoRoot, nodeSyncHostIo)
    }
    const events = readTelemetryEventsSafe(repoRoot, nodeSyncHostIo)
    const frictionEvents = readFrictionEventsSafe(repoRoot, nodeSyncHostIo)
    const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
    const report = buildSessionReport({
      events,
      frictionEvents,
      stampValid: stampCheck.valid,
      cumulative: argv.includes("--all"),
    })
    if (
      (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true) &&
      !shouldSuppressLiveRepoTestSideEffects(repoRoot)
    ) {
      writeSessionReportFilesSafe(repoRoot, report, nodeSyncHostIo)
    }
    return {
      exitCode: 0,
      stdout: argv.includes("--format=markdown")
        ? renderSessionReportMarkdown(report)
        : JSON.stringify(report),
      stderr: "",
    }
  })
