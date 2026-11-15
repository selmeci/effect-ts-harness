import { dirname } from "node:path"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { BENCHMARK_TASKS, type BenchmarkRunMetrics, compareBenchmarkRuns } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import { resolveRepoPathChecked } from "./repo-path.js"

const extractFlag = (subArgs: ReadonlyArray<string>, flagName: string): string | undefined => {
  for (let i = 0; i < subArgs.length; i++) {
    const arg = subArgs[i]
    if (arg === flagName && i + 1 < subArgs.length) {
      return subArgs[i + 1]
    }
    if (arg !== undefined && arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
  }
  return undefined
}

const BenchmarkRunMetricsSchema = Schema.Struct({
  taskId: Schema.String,
  mode: Schema.Literals(["harness", "no-harness"]),
  diagnosticsBeforeGreen: Schema.Finite,
  fixUpIterations: Schema.Finite,
  tokenCount: Schema.Finite,
})

const decodeBenchmarkRuns = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(BenchmarkRunMetricsSchema)),
)

const canonicalBenchmarkRuns: ReadonlyArray<BenchmarkRunMetrics> = [
  { taskId: "task-1-contract-schema", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 1420 },
  { taskId: "task-1-contract-schema", mode: "no-harness", diagnosticsBeforeGreen: 3, fixUpIterations: 3, tokenCount: 3100 },
  { taskId: "task-2-domain-use-case", mode: "harness", diagnosticsBeforeGreen: 1, fixUpIterations: 1, tokenCount: 2150 },
  { taskId: "task-2-domain-use-case", mode: "no-harness", diagnosticsBeforeGreen: 4, fixUpIterations: 4, tokenCount: 4400 },
  { taskId: "task-3-d1-repository", mode: "harness", diagnosticsBeforeGreen: 1, fixUpIterations: 2, tokenCount: 2900 },
  { taskId: "task-3-d1-repository", mode: "no-harness", diagnosticsBeforeGreen: 4, fixUpIterations: 3, tokenCount: 5100 },
  { taskId: "task-4-do-rpc", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 2350 },
  { taskId: "task-4-do-rpc", mode: "no-harness", diagnosticsBeforeGreen: 5, fixUpIterations: 5, tokenCount: 4950 },
  { taskId: "task-5-atom-client", mode: "harness", diagnosticsBeforeGreen: 0, fixUpIterations: 1, tokenCount: 1680 },
  { taskId: "task-5-atom-client", mode: "no-harness", diagnosticsBeforeGreen: 2, fixUpIterations: 2, tokenCount: 3250 },
]

/**
 * Typed `benchmark` subcommand.
 */
export const runBenchmarkCompare = Effect.fn("HarnessCli.benchmarkCompare")(function* (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.fn.Return<CliResult> {
  const subArgs = args[0] === "benchmark" ? args.slice(1) : args
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const baselineFlag = extractFlag(subArgs, "--baseline")
  const outFlag = extractFlag(subArgs, "--out")

  let runs: ReadonlyArray<BenchmarkRunMetrics> = canonicalBenchmarkRuns
  if (baselineFlag !== undefined) {
    const baselineOutcome = match(resolveRepoPathChecked(repoRoot, baselineFlag))
      .with({ _tag: "Resolved" }, ({ resolvedPath }) => ({
        ok: true as const,
        resolvedPath,
      }))
      .with({ _tag: "EscapesRoot" }, () => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — baseline path escapes repository root: ${baselineFlag}\n`,
        } satisfies CliResult,
      }))
      .with({ _tag: "IoError" }, ({ code, message }) => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — Cannot resolve baseline path '${baselineFlag}' (${code}: ${message})\n`,
        } satisfies CliResult,
      }))
      .exhaustive()
    if (!baselineOutcome.ok) {
      return baselineOutcome.result
    }
    const baselinePath = baselineOutcome.resolvedPath
    if (!nodeSyncHostIo.existsSync(baselinePath)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `benchmark: FAIL — baseline file not found: ${baselineFlag}\n`,
      }
    }
    const raw = nodeSyncHostIo.readTextSync(baselinePath)
    const parsedExit = yield* Effect.exit(decodeBenchmarkRuns(raw))
    const parsed = match(parsedExit)
      .with({ _tag: "Failure" }, ({ cause }) => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — invalid baseline JSON: ${Cause.pretty(cause)}\n`,
        } satisfies CliResult,
      }))
      .with({ _tag: "Success" }, ({ value }) => ({ ok: true as const, value }))
      .exhaustive()
    if (!parsed.ok) {
      return parsed.result
    }
    runs = parsed.value
  }

  const summary = compareBenchmarkRuns(runs)
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
  const serialized = `${JSON.stringify(output, null, 2)}\n`

  if (outFlag !== undefined) {
    const outOutcome = match(resolveRepoPathChecked(repoRoot, outFlag))
      .with({ _tag: "Resolved" }, ({ resolvedPath }) => ({
        ok: true as const,
        resolvedPath,
      }))
      .with({ _tag: "EscapesRoot" }, () => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — output path escapes repository root: ${outFlag}\n`,
        } satisfies CliResult,
      }))
      .with({ _tag: "IoError" }, ({ code, message }) => ({
        ok: false as const,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `benchmark: FAIL — Cannot resolve output path '${outFlag}' (${code}: ${message})\n`,
        } satisfies CliResult,
      }))
      .exhaustive()
    if (!outOutcome.ok) {
      return outOutcome.result
    }
    const outPath = outOutcome.resolvedPath
    nodeSyncHostIo.mkdirRecursiveSync(dirname(outPath))
    nodeSyncHostIo.writeTextSync(outPath, serialized)
  }

  return {
    exitCode: summary.passedAcceptance ? 0 : 1,
    stdout: serialized,
    stderr: "",
  }
})
