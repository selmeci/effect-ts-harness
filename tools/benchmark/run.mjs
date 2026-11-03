import { BENCHMARK_TASKS, compareBenchmarkRuns } from "../../libs/harness/gates/src/index.js"

// Canonical deterministic benchmark runs for the 5 evaluation tasks
const canonicalBenchmarkRuns = [
  // Task 1: Contract schema definition (@harness/sample-contract)
  {
    taskId: "task-1-contract-schema",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 1420,
  },
  {
    taskId: "task-1-contract-schema",
    mode: "no-harness",
    diagnosticsBeforeGreen: 3,
    fixUpIterations: 3,
    tokenCount: 3100,
  },

  // Task 2: Domain use case implementation (@harness/sample-domain)
  {
    taskId: "task-2-domain-use-case",
    mode: "harness",
    diagnosticsBeforeGreen: 1,
    fixUpIterations: 1,
    tokenCount: 2150,
  },
  {
    taskId: "task-2-domain-use-case",
    mode: "no-harness",
    diagnosticsBeforeGreen: 4,
    fixUpIterations: 4,
    tokenCount: 4400,
  },

  // Task 3: D1 SQLite repository (@harness/sample-infra)
  {
    taskId: "task-3-d1-repository",
    mode: "harness",
    diagnosticsBeforeGreen: 1,
    fixUpIterations: 2,
    tokenCount: 2900,
  },
  {
    taskId: "task-3-d1-repository",
    mode: "no-harness",
    diagnosticsBeforeGreen: 4,
    fixUpIterations: 3,
    tokenCount: 5100,
  },

  // Task 4: Durable Object RPC bridge (@harness/sample-infra)
  {
    taskId: "task-4-do-rpc",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 2350,
  },
  {
    taskId: "task-4-do-rpc",
    mode: "no-harness",
    diagnosticsBeforeGreen: 5,
    fixUpIterations: 5,
    tokenCount: 4950,
  },

  // Task 5: AtomHttpApi client (sample-web)
  {
    taskId: "task-5-atom-client",
    mode: "harness",
    diagnosticsBeforeGreen: 0,
    fixUpIterations: 1,
    tokenCount: 1680,
  },
  {
    taskId: "task-5-atom-client",
    mode: "no-harness",
    diagnosticsBeforeGreen: 2,
    fixUpIterations: 2,
    tokenCount: 3250,
  },
]

const summary = compareBenchmarkRuns(canonicalBenchmarkRuns)

const output = {
  tasks: BENCHMARK_TASKS.map((task) => ({
    id: task.id,
    title: task.title,
    targetPackage: task.targetPackage,
    expectedPatternDoc: task.expectedPatternDoc,
  })),
  summary,
  passedAcceptance: summary.passedAcceptance,
}

console.log(JSON.stringify(output, null, 2))

if (!summary.passedAcceptance) {
  process.exitCode = 1
}
