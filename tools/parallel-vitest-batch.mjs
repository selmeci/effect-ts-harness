import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  WARM_WORKER_SCRIPT,
  createBatchTempTracker,
  createWarmVitestWorker,
  dedupCanonicalTests,
  resolveBatchConcurrency,
  runCoverageProbe,
  runOneColdMutant,
  runWarmMutantWithWorker,
} from "./vitest-pool-helpers.mjs"

const vitestCli = process.env["HARNESS_BATCH_VITEST_CLI"] ?? ""
const cwd = process.env["HARNESS_BATCH_CWD"] ?? process.cwd()
const parsedTimeout = Number(process.env["HARNESS_BATCH_TIMEOUT_MS"] ?? "30000")
const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000
const rawTestFiles = JSON.parse(process.env["HARNESS_BATCH_TESTS_JSON"] ?? "[]")
const mutantIds = JSON.parse(process.env["HARNESS_BATCH_MUTANTS_JSON"] ?? "[]")

const { testFiles, absToRaw } = dedupCanonicalTests(cwd, rawTestFiles)

const childBaseEnv = { ...process.env }
delete childBaseEnv["HARNESS_BATCH_VITEST_CLI"]
delete childBaseEnv["HARNESS_BATCH_CWD"]
delete childBaseEnv["HARNESS_BATCH_TIMEOUT_MS"]
delete childBaseEnv["HARNESS_BATCH_TESTS_JSON"]
delete childBaseEnv["HARNESS_BATCH_MUTANTS_JSON"]
delete childBaseEnv["HARNESS_BATCH_TARGET_FILE"]
delete childBaseEnv["HARNESS_ACTIVE_MUTANT_ID"]
delete childBaseEnv["HARNESS_MUTATE_WARM_ISOLATE"]
delete childBaseEnv["HARNESS_WARM_ISOLATE"]
delete childBaseEnv["HARNESS_COVERAGE_OUT_DIR"]

const tracker = createBatchTempTracker()

for (const [sig, code] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
]) {
  process.once(sig, () => {
    tracker.cleanupAll()
    process.exit(128 + code)
  })
}

const vitestNodeEntry = vitestCli.length > 0 ? resolve(dirname(vitestCli), "dist", "node.js") : ""
const useWarmMode =
  vitestNodeEntry.length > 0 &&
  existsSync(vitestNodeEntry) &&
  existsSync(WARM_WORKER_SCRIPT) &&
  process.env["HARNESS_MUTATE_USE_WARM_VITEST"] !== "0"

const results = Array.from({ length: mutantIds.length })
if (mutantIds.length > 0) {
  const concurrency = resolveBatchConcurrency(mutantIds.length, useWarmMode)
  let nextIdx = 0
  if (useWarmMode) {
    const coverageInfo = await runCoverageProbe({
      vitestNodeEntry,
      cwd,
      childBaseEnv,
      testFiles,
      absToRaw,
      mutantCount: mutantIds.length,
      minTests: 2,
      minMutants: 4,
      timeoutMs,
      tracker,
    })
    const spawnWorker = () =>
      createWarmVitestWorker({
        vitestNodeEntry,
        cwd,
        childBaseEnv,
        allTests: testFiles,
        tracker,
      })
    const coldFallback = (mutantId, targetTests, stepTimeoutMs) =>
      runOneColdMutant({
        vitestCli,
        cwd,
        childBaseEnv,
        testFiles: targetTests,
        mutantId,
        timeoutMs: stepTimeoutMs,
        tracker,
      })
    const workers = Array.from({ length: concurrency }, async () => {
      const workerRef = { current: await spawnWorker() }
      try {
        while (nextIdx < mutantIds.length) {
          const idx = nextIdx
          nextIdx += 1
          results[idx] = await runWarmMutantWithWorker({
            workerRef,
            spawnWorker,
            coldFallback,
            mutantId: mutantIds[idx],
            targetTests: testFiles,
            coverageInfo,
            timeoutMs,
            cwd,
          })
        }
      } finally {
        if (workerRef.current) await workerRef.current.shutdown()
      }
    })
    try {
      await Promise.all(workers)
    } finally {
      tracker.cleanupAll()
    }
  } else {
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIdx < mutantIds.length) {
        const idx = nextIdx
        nextIdx += 1
        results[idx] = await runOneColdMutant({
          vitestCli,
          cwd,
          childBaseEnv,
          testFiles,
          mutantId: mutantIds[idx],
          timeoutMs,
          tracker,
        })
      }
    })
    try {
      await Promise.all(workers)
    } finally {
      tracker.cleanupAll()
    }
  }
}

const payload = JSON.stringify(results)
await new Promise((resolveDone) => {
  process.stdout.write(payload, () => resolveDone(undefined))
})
