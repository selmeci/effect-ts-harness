import { describe, expect, it } from "vitest"
import { BENCHMARK_TASKS, compareBenchmarkRuns } from "../src/index.js"

describe("5-task MVP v2 benchmark evaluation", () => {
  it("defines 5 canonical benchmark tasks covering contract, domain, D1, DO RPC, and AtomHttpApi", () => {
    expect(BENCHMARK_TASKS).toHaveLength(5)
    expect(BENCHMARK_TASKS.map((t) => t.id)).toEqual([
      "task-1-contract-schema",
      "task-2-domain-use-case",
      "task-3-d1-repository",
      "task-4-do-rpc",
      "task-5-atom-client",
    ])
    expect(BENCHMARK_TASKS.map((t) => t.targetPackage)).toEqual([
      "@harness/sample-contract",
      "@harness/sample-domain",
      "@harness/sample-infra",
      "@harness/sample-infra",
      "sample-web",
    ])
    expect(BENCHMARK_TASKS.map((t) => t.expectedPatternDoc)).toEqual([
      "agent-patterns/httpapi.md",
      "agent-patterns/planning.md",
      "agent-patterns/d1-repository.md",
      "agent-patterns/durable-object-state.md",
      "agent-patterns/atom.md",
    ])
  })

  it("evaluates harness vs no-harness across the 3 acceptance metrics (winning >= 2 of 3)", () => {
    const summary = compareBenchmarkRuns([
      {
        taskId: "t1",
        mode: "harness",
        diagnosticsBeforeGreen: 0,
        fixUpIterations: 1,
        tokenCount: 1800,
      },
      {
        taskId: "t1",
        mode: "no-harness",
        diagnosticsBeforeGreen: 3,
        fixUpIterations: 3,
        tokenCount: 3200,
      },
    ])
    expect(summary.winsOnDiagnostics).toBe(true)
    expect(summary.winsOnIterations).toBe(true)
    expect(summary.winsOnTokens).toBe(true)
    expect(summary.passedAcceptance).toBe(true)
  })

  it("accepts totalTokens as an alias for tokenCount in BenchmarkRunMetrics", () => {
    const summary = compareBenchmarkRuns([
      {
        taskId: "t1",
        mode: "harness",
        diagnosticsBeforeGreen: 1,
        fixUpIterations: 1,
        totalTokens: 1500,
      },
      {
        taskId: "t1",
        mode: "no-harness",
        diagnosticsBeforeGreen: 4,
        fixUpIterations: 2,
        totalTokens: 3000,
      },
    ])
    expect(summary.winsOnTokens).toBe(true)
    expect(summary.harnessMedians.tokenCount).toBe(1500)
    expect(summary.noHarnessMedians.tokenCount).toBe(3000)
  })

  it("passes acceptance when winning 2 of 3 metrics", () => {
    const summary = compareBenchmarkRuns([
      // diagnostics win (1 < 3), iterations win (1 < 2), tokens lose (5000 > 4000)
      {
        taskId: "t1",
        mode: "harness",
        diagnosticsBeforeGreen: 1,
        fixUpIterations: 1,
        tokenCount: 5000,
      },
      {
        taskId: "t1",
        mode: "no-harness",
        diagnosticsBeforeGreen: 3,
        fixUpIterations: 2,
        tokenCount: 4000,
      },
    ])
    expect(summary.winsOnDiagnostics).toBe(true)
    expect(summary.winsOnIterations).toBe(true)
    expect(summary.winsOnTokens).toBe(false)
    expect(summary.passedAcceptance).toBe(true)
  })

  it("rejects acceptance when winning fewer than 2 of 3 metrics", () => {
    const summary = compareBenchmarkRuns([
      // diagnostics win (1 < 3), iterations lose (3 > 2), tokens lose (5000 > 4000)
      {
        taskId: "t1",
        mode: "harness",
        diagnosticsBeforeGreen: 1,
        fixUpIterations: 3,
        tokenCount: 5000,
      },
      {
        taskId: "t1",
        mode: "no-harness",
        diagnosticsBeforeGreen: 3,
        fixUpIterations: 2,
        tokenCount: 4000,
      },
    ])
    expect(summary.winsOnDiagnostics).toBe(true)
    expect(summary.winsOnIterations).toBe(false)
    expect(summary.winsOnTokens).toBe(false)
    expect(summary.passedAcceptance).toBe(false)
  })

  it("correctly computes medians across all 5 benchmark tasks", () => {
    const runs = [
      {
        taskId: "task-1-contract-schema",
        mode: "harness" as const,
        diagnosticsBeforeGreen: 0,
        fixUpIterations: 1,
        tokenCount: 1200,
      },
      {
        taskId: "task-2-domain-use-case",
        mode: "harness" as const,
        diagnosticsBeforeGreen: 1,
        fixUpIterations: 1,
        tokenCount: 2000,
      },
      {
        taskId: "task-3-d1-repository",
        mode: "harness" as const,
        diagnosticsBeforeGreen: 1,
        fixUpIterations: 2,
        tokenCount: 2800,
      },
      {
        taskId: "task-4-do-rpc",
        mode: "harness" as const,
        diagnosticsBeforeGreen: 0,
        fixUpIterations: 1,
        tokenCount: 2200,
      },
      {
        taskId: "task-5-atom-client",
        mode: "harness" as const,
        diagnosticsBeforeGreen: 0,
        fixUpIterations: 1,
        tokenCount: 1500,
      },

      {
        taskId: "task-1-contract-schema",
        mode: "no-harness" as const,
        diagnosticsBeforeGreen: 2,
        fixUpIterations: 3,
        tokenCount: 3000,
      },
      {
        taskId: "task-2-domain-use-case",
        mode: "no-harness" as const,
        diagnosticsBeforeGreen: 4,
        fixUpIterations: 4,
        tokenCount: 4500,
      },
      {
        taskId: "task-3-d1-repository",
        mode: "no-harness" as const,
        diagnosticsBeforeGreen: 3,
        fixUpIterations: 3,
        tokenCount: 5200,
      },
      {
        taskId: "task-4-do-rpc",
        mode: "no-harness" as const,
        diagnosticsBeforeGreen: 5,
        fixUpIterations: 5,
        tokenCount: 4800,
      },
      {
        taskId: "task-5-atom-client",
        mode: "no-harness" as const,
        diagnosticsBeforeGreen: 2,
        fixUpIterations: 2,
        tokenCount: 3100,
      },
    ]
    const summary = compareBenchmarkRuns(runs)
    expect(summary.harnessMedians).toEqual({
      diagnosticsBeforeGreen: 0,
      fixUpIterations: 1,
      tokenCount: 2000,
    })
    expect(summary.noHarnessMedians).toEqual({
      diagnosticsBeforeGreen: 3,
      fixUpIterations: 3,
      tokenCount: 4500,
    })
    expect(summary.winsOnDiagnostics).toBe(true)
    expect(summary.winsOnIterations).toBe(true)
    expect(summary.winsOnTokens).toBe(true)
    expect(summary.passedAcceptance).toBe(true)
  })
})
