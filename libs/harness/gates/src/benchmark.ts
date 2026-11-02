export interface BenchmarkTaskDefinition {
  readonly id: string
  readonly title: string
  readonly targetPackage: string
  readonly expectedPatternDoc: string
  readonly description: string
}

export const BENCHMARK_TASKS: ReadonlyArray<BenchmarkTaskDefinition> = [
  {
    id: "task-1-contract-schema",
    title: "Contract Schema & HttpApi Definition",
    targetPackage: "@harness/sample-contract",
    expectedPatternDoc: "agent-patterns/httpapi.md",
    description: "Define schemas and HttpApi endpoints in @harness/sample-contract",
  },
  {
    id: "task-2-domain-use-case",
    title: "Domain Use Case Implementation",
    targetPackage: "@harness/sample-domain",
    expectedPatternDoc: "agent-patterns/planning.md",
    description: "Implement domain use case with pure decider and Effect.fn spans",
  },
  {
    id: "task-3-d1-repository",
    title: "D1 Repository Implementation",
    targetPackage: "@harness/sample-infra",
    expectedPatternDoc: "agent-patterns/d1-repository.md",
    description: "Implement SQLite/D1 Drizzle repository decoding rows into contract schemas",
  },
  {
    id: "task-4-do-rpc",
    title: "Durable Object RPC Bridge",
    targetPackage: "@harness/sample-infra",
    expectedPatternDoc: "agent-patterns/durable-object-state.md",
    description: "Implement Durable Object state and W3C traceparent RPC bridge",
  },
  {
    id: "task-5-atom-client",
    title: "AtomHttpApi Web Client",
    targetPackage: "sample-web",
    expectedPatternDoc: "agent-patterns/atom.md",
    description: "Derive typed query and mutation atoms with AtomHttpApi",
  },
]

export interface BenchmarkRunMetrics {
  readonly taskId: string
  readonly mode: "harness" | "no-harness"
  readonly diagnosticsBeforeGreen: number
  readonly fixUpIterations: number
  readonly tokenCount?: number | undefined
  readonly totalTokens?: number | undefined
}

export interface BenchmarkComparisonSummary {
  readonly winsOnDiagnostics: boolean
  readonly winsOnIterations: boolean
  readonly winsOnTokens: boolean
  readonly passedAcceptance: boolean
  readonly harnessMedians: {
    readonly diagnosticsBeforeGreen: number
    readonly fixUpIterations: number
    readonly tokenCount: number
  }
  readonly noHarnessMedians: {
    readonly diagnosticsBeforeGreen: number
    readonly fixUpIterations: number
    readonly tokenCount: number
  }
}

const computeMedian = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const computeMean = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sum = values.reduce((acc, curr) => acc + curr, 0)
  return sum / values.length
}

const isWinning = (
  harnessValues: ReadonlyArray<number>,
  noHarnessValues: ReadonlyArray<number>,
): boolean => {
  if (harnessValues.length === 0 || noHarnessValues.length === 0) {
    return false
  }
  const hMedian = computeMedian(harnessValues)
  const nhMedian = computeMedian(noHarnessValues)
  if (hMedian < nhMedian) {
    return true
  }
  if (hMedian === nhMedian) {
    return computeMean(harnessValues) < computeMean(noHarnessValues)
  }
  return false
}

export const compareBenchmarkRuns = (
  runs: ReadonlyArray<BenchmarkRunMetrics>,
): BenchmarkComparisonSummary => {
  const harnessRuns = runs.filter((r) => r.mode === "harness")
  const noHarnessRuns = runs.filter((r) => r.mode === "no-harness")

  const harnessDiags = harnessRuns.map((r) => r.diagnosticsBeforeGreen)
  const noHarnessDiags = noHarnessRuns.map((r) => r.diagnosticsBeforeGreen)

  const harnessIters = harnessRuns.map((r) => r.fixUpIterations)
  const noHarnessIters = noHarnessRuns.map((r) => r.fixUpIterations)

  const harnessTokens = harnessRuns.map((r) => r.tokenCount ?? r.totalTokens ?? 0)
  const noHarnessTokens = noHarnessRuns.map((r) => r.tokenCount ?? r.totalTokens ?? 0)

  const winsOnDiagnostics = isWinning(harnessDiags, noHarnessDiags)
  const winsOnIterations = isWinning(harnessIters, noHarnessIters)
  const winsOnTokens = isWinning(harnessTokens, noHarnessTokens)

  const passedAcceptance =
    [winsOnDiagnostics, winsOnIterations, winsOnTokens].filter(Boolean).length >= 2

  return {
    winsOnDiagnostics,
    winsOnIterations,
    winsOnTokens,
    passedAcceptance,
    harnessMedians: {
      diagnosticsBeforeGreen: computeMedian(harnessDiags),
      fixUpIterations: computeMedian(harnessIters),
      tokenCount: computeMedian(harnessTokens),
    },
    noHarnessMedians: {
      diagnosticsBeforeGreen: computeMedian(noHarnessDiags),
      fixUpIterations: computeMedian(noHarnessIters),
      tokenCount: computeMedian(noHarnessTokens),
    },
  }
}
