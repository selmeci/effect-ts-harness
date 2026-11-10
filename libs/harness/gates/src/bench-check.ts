import { Effect, Schema } from "effect"
import { match } from "ts-pattern"

export const BenchStageName = Schema.NonEmptyString.pipe(Schema.brand("BenchStageName"))
export type BenchStageName = typeof BenchStageName.Type

export const LatencyMillis = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(1_000_000_000)),
  Schema.brand("LatencyMillis"),
)
export type LatencyMillis = typeof LatencyMillis.Type

export const BenchSampleCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("BenchSampleCount"),
)
export type BenchSampleCount = typeof BenchSampleCount.Type

export const StageLatencyStatus = Schema.Literals(["pass", "fail"]).pipe(
  Schema.brand("StageLatencyStatus"),
)
export type StageLatencyStatus = typeof StageLatencyStatus.Type

export const LatencyExceededDimension = Schema.Literals(["none", "p50", "p95", "both"]).pipe(
  Schema.brand("LatencyExceededDimension"),
)
export type LatencyExceededDimension = typeof LatencyExceededDimension.Type

export const LatencySloViolationMessage = Schema.NonEmptyString.pipe(
  Schema.brand("LatencySloViolationMessage"),
)
export type LatencySloViolationMessage = typeof LatencySloViolationMessage.Type

export const StageLatencyBudget = Schema.Struct({
  stage: BenchStageName,
  p50BudgetMs: LatencyMillis,
  p95BudgetMs: LatencyMillis,
})
export type StageLatencyBudget = typeof StageLatencyBudget.Type

export const StageLatencyMeasurement = Schema.Struct({
  stage: BenchStageName,
  p50Ms: LatencyMillis,
  p95Ms: LatencyMillis,
  sampleCount: Schema.optional(BenchSampleCount),
})
export type StageLatencyMeasurement = typeof StageLatencyMeasurement.Type

export const StageLatencyViolation = Schema.Struct({
  stage: BenchStageName,
  p50Ms: LatencyMillis,
  p50BudgetMs: LatencyMillis,
  p95Ms: LatencyMillis,
  p95BudgetMs: LatencyMillis,
  exceededDimension: LatencyExceededDimension,
})
export type StageLatencyViolation = typeof StageLatencyViolation.Type

export const StageLatencyEvaluation = Schema.Struct({
  stage: BenchStageName,
  status: StageLatencyStatus,
  p50Ms: LatencyMillis,
  p50BudgetMs: LatencyMillis,
  p95Ms: LatencyMillis,
  p95BudgetMs: LatencyMillis,
  exceededDimension: LatencyExceededDimension,
})
export type StageLatencyEvaluation = typeof StageLatencyEvaluation.Type

export const HarnessBenchInput = Schema.Struct({
  measurements: Schema.Array(StageLatencyMeasurement),
  budgets: Schema.optional(Schema.Array(StageLatencyBudget)),
})
export type HarnessBenchInput = typeof HarnessBenchInput.Type

export const HarnessBenchReport = Schema.Struct({
  status: StageLatencyStatus,
  evaluations: Schema.Array(StageLatencyEvaluation),
  violations: Schema.Array(StageLatencyViolation),
})
export type HarnessBenchReport = typeof HarnessBenchReport.Type

export class LatencySloViolationError extends Schema.TaggedError<LatencySloViolationError>()(
  "LatencySloViolationError",
  {
    message: LatencySloViolationMessage,
    violations: Schema.Array(StageLatencyViolation),
  },
) {}

export const DEFAULT_STAGE_LATENCY_BUDGETS: ReadonlyArray<StageLatencyBudget> = [
  {
    stage: BenchStageName.make("extractTypeGraph.warm"),
    p50BudgetMs: LatencyMillis.make(120),
    p95BudgetMs: LatencyMillis.make(250),
  },
  {
    stage: BenchStageName.make("DatalogSession.stepDelta"),
    p50BudgetMs: LatencyMillis.make(40),
    p95BudgetMs: LatencyMillis.make(90),
  },
  {
    stage: BenchStageName.make("AstGateCache.warm"),
    p50BudgetMs: LatencyMillis.make(5),
    p95BudgetMs: LatencyMillis.make(15),
  },
  {
    stage: BenchStageName.make("GraphRewrite.decide"),
    p50BudgetMs: LatencyMillis.make(120),
    p95BudgetMs: LatencyMillis.make(250),
  },
]

export const computePercentileMillis = (
  samplesMs: ReadonlyArray<number>,
  percentile: number,
): LatencyMillis => {
  if (samplesMs.length === 0) {
    return LatencyMillis.make(0)
  }
  const sorted = [...samplesMs]
    .map((x) => (Number.isFinite(x) && x >= 0 ? x : 0))
    .sort((a, b) => a - b)
  const clamped = Math.min(1, Math.max(0, percentile))
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1))
  const value = Math.round((sorted[idx] ?? 0) * 1000) / 1000
  return LatencyMillis.make(value)
}

export const buildStageLatencyMeasurement = (
  stage: string,
  samplesMs: ReadonlyArray<number>,
): StageLatencyMeasurement => {
  if (samplesMs.length === 0) {
    return {
      stage: BenchStageName.make(stage),
      p50Ms: LatencyMillis.make(0),
      p95Ms: LatencyMillis.make(0),
      sampleCount: BenchSampleCount.make(0),
    }
  }
  return {
    stage: BenchStageName.make(stage),
    p50Ms: computePercentileMillis(samplesMs, 0.5),
    p95Ms: computePercentileMillis(samplesMs, 0.95),
    sampleCount: BenchSampleCount.make(samplesMs.length),
  }
}

export const decideHarnessBench = Effect.fn("HarnessBench.decide")(function* (
  input: HarnessBenchInput,
): Effect.fn.Return<HarnessBenchReport, LatencySloViolationError> {
  const budgetByStage = new Map<string, StageLatencyBudget>()
  for (const defaultBudget of DEFAULT_STAGE_LATENCY_BUDGETS) {
    budgetByStage.set(defaultBudget.stage, defaultBudget)
  }
  for (const customBudget of input.budgets ?? []) {
    budgetByStage.set(customBudget.stage, customBudget)
  }

  const evaluations: Array<StageLatencyEvaluation> = []
  const violations: Array<StageLatencyViolation> = []

  for (const measurement of input.measurements) {
    const budget = budgetByStage.get(measurement.stage)

    if (budget === undefined || measurement.sampleCount === 0) {
      const p50BudgetMs = budget !== undefined ? budget.p50BudgetMs : LatencyMillis.make(0)
      const p95BudgetMs = budget !== undefined ? budget.p95BudgetMs : LatencyMillis.make(0)
      const exceededDimension = LatencyExceededDimension.make("both")
      const status = StageLatencyStatus.make("fail")

      evaluations.push({
        stage: measurement.stage,
        status,
        p50Ms: measurement.p50Ms,
        p50BudgetMs,
        p95Ms: measurement.p95Ms,
        p95BudgetMs,
        exceededDimension,
      })

      violations.push({
        stage: measurement.stage,
        p50Ms: measurement.p50Ms,
        p50BudgetMs,
        p95Ms: measurement.p95Ms,
        p95BudgetMs,
        exceededDimension,
      })
      continue
    }

    const p50Over = measurement.p50Ms > budget.p50BudgetMs
    const p95Over = measurement.p95Ms > budget.p95BudgetMs

    const exceededDimension: LatencyExceededDimension = match({ p50Over, p95Over })
      .with({ p50Over: true, p95Over: true }, () => LatencyExceededDimension.make("both"))
      .with({ p50Over: true, p95Over: false }, () => LatencyExceededDimension.make("p50"))
      .with({ p50Over: false, p95Over: true }, () => LatencyExceededDimension.make("p95"))
      .with({ p50Over: false, p95Over: false }, () => LatencyExceededDimension.make("none"))
      .exhaustive()

    const status: StageLatencyStatus =
      p50Over || p95Over ? StageLatencyStatus.make("fail") : StageLatencyStatus.make("pass")

    evaluations.push({
      stage: measurement.stage,
      status,
      p50Ms: measurement.p50Ms,
      p50BudgetMs: budget.p50BudgetMs,
      p95Ms: measurement.p95Ms,
      p95BudgetMs: budget.p95BudgetMs,
      exceededDimension,
    })

    if (p50Over || p95Over) {
      violations.push({
        stage: measurement.stage,
        p50Ms: measurement.p50Ms,
        p50BudgetMs: budget.p50BudgetMs,
        p95Ms: measurement.p95Ms,
        p95BudgetMs: budget.p95BudgetMs,
        exceededDimension,
      })
    }
  }

  if (violations.length > 0) {
    const summary = violations
      .map(
        (v) =>
          `${v.stage} (p50=${v.p50Ms}ms/${v.p50BudgetMs}ms, p95=${v.p95Ms}ms/${v.p95BudgetMs}ms, exceeded=${v.exceededDimension})`,
      )
      .join("; ")
    return yield* new LatencySloViolationError({
      message: LatencySloViolationMessage.make(`Latency SLO violated: ${summary}`),
      violations,
    })
  }

  return {
    status: StageLatencyStatus.make("pass"),
    evaluations,
    violations: [],
  }
})

export const HarnessBench = {
  decide: decideHarnessBench,
  defaultBudgets: DEFAULT_STAGE_LATENCY_BUDGETS,
  computePercentileMillis,
  buildStageLatencyMeasurement,
} as const
