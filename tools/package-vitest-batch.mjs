import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  WARM_WORKER_SCRIPT,
  createBatchTempTracker,
  createWarmVitestWorker,
  dedupCanonicalTests,
  isHeavyMetaTest,
  parsePassedCount,
  resolveBatchConcurrency,
  runCoverageProbe,
  runOneColdMutant,
  runWarmMutantWithWorker,
  sortTestsByStaticSpeed,
} from "./vitest-pool-helpers.mjs"

const planPath = process.env["HARNESS_PACKAGE_PLAN_FILE"] ?? ""
if (planPath.length === 0 || !existsSync(planPath)) {
  process.stderr.write("[package-vitest-batch] Missing HARNESS_PACKAGE_PLAN_FILE.\n")
  process.exit(1)
}

const plan = JSON.parse(readFileSync(planPath, "utf8"))
const cwd = plan.cwd
const backupPath = plan.backupPath
const vitestCli = plan.vitestCli
const { testFiles: allPackageTests } = dedupCanonicalTests(cwd, plan.allPackageTests ?? [])
const files = Array.isArray(plan.files) ? plan.files : []

const childBaseEnv = { ...process.env }
delete childBaseEnv["HARNESS_PACKAGE_PLAN_FILE"]
delete childBaseEnv["HARNESS_ACTIVE_MUTANT_ID"]
delete childBaseEnv["HARNESS_BATCH_VITEST_CLI"]
delete childBaseEnv["HARNESS_BATCH_CWD"]
delete childBaseEnv["HARNESS_BATCH_TIMEOUT_MS"]
delete childBaseEnv["HARNESS_BATCH_TESTS_JSON"]
delete childBaseEnv["HARNESS_BATCH_MUTANTS_JSON"]

const tracker = createBatchTempTracker()
let activeMutation = null

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const restoreActiveMutationSync = () => {
  const cur = activeMutation
  if (cur === null) return undefined
  activeMutation = null
  if (cur.wroteSchema) {
    try {
      const currentDisk = readFileSync(cur.fullPath, "utf8")
      const diskSha = sha256Hex(currentDisk)
      if (diskSha !== cur.mutatedSha256) {
        return `[mutation-check] CRITICAL: Target '${cur.relFile}' was modified externally mid-run (sha256=${diskSha}); refusing to overwrite user edits. Preserving '${backupPath}'.`
      }
      writeFileSync(cur.fullPath, cur.originalSource, "utf8")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `[mutation-check] CRITICAL: Failed to restore '${cur.fullPath}' (${msg}). Preserving '${backupPath}'.`
    }
  }
  try {
    if (existsSync(backupPath)) unlinkSync(backupPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[mutation-check] CRITICAL: Restored '${cur.fullPath}' but failed to unlink '${backupPath}': ${msg}`
  }
  return undefined
}

for (const [sig, code] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
]) {
  process.once(sig, () => {
    restoreActiveMutationSync()
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

const maxMutantsInFile = files.reduce(
  (mx, f) => Math.max(mx, Array.isArray(f.mutantIds) ? f.mutantIds.length : 0),
  1,
)
const concurrency = resolveBatchConcurrency(maxMutantsInFile, useWarmMode)

const baselinedAbsTests = new Set(
  (Array.isArray(plan.baselinedTests) ? plan.baselinedTests : []).map((t) => resolve(cwd, t)),
)

const spawnWorker = () =>
  createWarmVitestWorker({
    vitestNodeEntry,
    cwd,
    childBaseEnv,
    allTests: allPackageTests,
    tracker,
    isolate: process.env["HARNESS_MUTATE_WARM_ISOLATE"] !== "0",
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

const isCleanSurvivorResult = (result) =>
  result !== undefined &&
  result._tag === "Exited" &&
  result.exitCode === 0 &&
  parsePassedCount(result.stdout) !== null

const ensureStageBaselined = async ({
  workerRefs,
  stageTests,
  timeoutMs,
  targetFilePath,
  relFile,
}) => {
  const unbaselined = stageTests.filter((t) => !baselinedAbsTests.has(resolve(cwd, t)))
  if (unbaselined.length === 0) return undefined
  let res = null
  if (useWarmMode && workerRefs.length > 0) {
    const ref = workerRefs[0]
    if (!ref.current || !ref.current.isAlive()) {
      ref.current = await spawnWorker()
    }
    if (ref.current) {
      res = await ref.current.runSubset("", unbaselined, timeoutMs, targetFilePath)
    }
  }
  if (res === null) {
    res = (await coldFallback("", unbaselined, timeoutMs)).result
  }
  if (!isCleanSurvivorResult(res)) {
    const detail = ((res?.stderr ?? "") || (res?.stdout ?? "")).trim().slice(0, 300)
    return `[mutation-check] Baseline test suite failed on fallback tests for '${relFile}' (${unbaselined.length} file(s)): ${detail}`
  }
  for (const t of unbaselined) baselinedAbsTests.add(resolve(cwd, t))
  return undefined
}

const runMutantPassWithPool = async ({
  workerRefs,
  targetTests,
  mutantIds,
  timeoutMs,
  probeMinTests,
  probeMinMutants,
  targetFilePath,
  relFile,
  requireBaseline = false,
}) => {
  const results = Array.from({ length: mutantIds.length })
  if (mutantIds.length === 0 || targetTests.length === 0) {
    return { results: [], baselineError: undefined }
  }
  const { testFiles: canonTests, absToRaw } = dedupCanonicalTests(cwd, targetTests)

  if (!useWarmMode) {
    if (requireBaseline) {
      const baseErr = await ensureStageBaselined({
        workerRefs,
        stageTests: canonTests,
        timeoutMs,
        targetFilePath,
        relFile,
      })
      if (baseErr !== undefined) return { results: [], baselineError: baseErr }
    }
    let nextIdx = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, mutantIds.length) }, async () => {
        while (nextIdx < mutantIds.length) {
          const idx = nextIdx
          nextIdx += 1
          results[idx] = await coldFallback(mutantIds[idx], canonTests, timeoutMs)
        }
      }),
    )
    return { results, baselineError: undefined }
  }

  const coverageInfo = await runCoverageProbe({
    vitestNodeEntry,
    cwd,
    childBaseEnv,
    testFiles: canonTests,
    absToRaw,
    mutantCount: mutantIds.length,
    minTests: probeMinTests,
    minMutants: probeMinMutants,
    timeoutMs,
    tracker,
  })
  if (coverageInfo !== null) {
    for (const t of canonTests) baselinedAbsTests.add(resolve(cwd, t))
  } else if (requireBaseline) {
    const baseErr = await ensureStageBaselined({
      workerRefs,
      stageTests: canonTests,
      timeoutMs,
      targetFilePath,
      relFile,
    })
    if (baseErr !== undefined) return { results: [], baselineError: baseErr }
  }

  let nextIdx = 0
  const laneCount = Math.min(workerRefs.length, mutantIds.length)
  await Promise.all(
    Array.from({ length: laneCount }, async (_, laneIdx) => {
      const workerRef = workerRefs[laneIdx]
      while (nextIdx < mutantIds.length) {
        const idx = nextIdx
        nextIdx += 1
        results[idx] = await runWarmMutantWithWorker({
          workerRef,
          spawnWorker,
          coldFallback,
          mutantId: mutantIds[idx],
          targetTests: canonTests,
          coverageInfo,
          timeoutMs,
          cwd,
          targetFilePath,
        })
      }
    }),
  )
  return { results, baselineError: undefined }
}

const mergeTwoPhaseResults = (targetIds, stageAResults, stageBResults) => {
  const mapA = new Map(stageAResults.filter(Boolean).map((e) => [e.id, e]))
  const mapB = new Map(stageBResults.filter(Boolean).map((e) => [e.id, e]))
  return targetIds.map((id) => {
    const entryA = mapA.get(id)
    const entryB = mapB.get(id)
    if (entryB === undefined) return entryA
    if (entryA === undefined) return entryB
    if (!isCleanSurvivorResult(entryB.result)) return entryB
    const countA = parsePassedCount(entryA.result.stdout) ?? 0
    const countB = parsePassedCount(entryB.result.stdout) ?? 0
    const totalPassed = countA + countB
    return {
      id,
      result: {
        _tag: "Exited",
        exitCode: 0,
        stdout: `Tests  ${totalPassed} passed (${totalPassed})\n`,
        stderr: [entryA.result.stderr, entryB.result.stderr].filter(Boolean).join("\n"),
      },
    }
  })
}

const runTwoPhasePass = async ({
  workerRefs,
  targetTests,
  mutantIds,
  timeoutMs,
  targetFilePath,
  relFile,
  requireBaseline,
}) => {
  if (mutantIds.length === 0 || !Array.isArray(targetTests) || targetTests.length === 0) {
    return { results: [], baselineError: undefined }
  }
  const fastTests = targetTests.filter((t) => !isHeavyMetaTest(t))
  const heavyTests = sortTestsByStaticSpeed(targetTests.filter((t) => isHeavyMetaTest(t)))

  let stageAResults = []
  if (fastTests.length > 0) {
    const passA = await runMutantPassWithPool({
      workerRefs,
      targetTests: fastTests,
      mutantIds,
      timeoutMs,
      probeMinTests: 3,
      probeMinMutants: 4,
      targetFilePath,
      relFile,
      requireBaseline,
    })
    if (passA.baselineError !== undefined) {
      return { results: [], baselineError: passA.baselineError }
    }
    stageAResults = passA.results
  }

  const stillSurvivingIds =
    fastTests.length > 0
      ? stageAResults
          .filter((entry) => isCleanSurvivorResult(entry?.result))
          .map((entry) => entry.id)
      : mutantIds

  let stageBResults = []
  if (stillSurvivingIds.length > 0 && heavyTests.length > 0) {
    const passB = await runMutantPassWithPool({
      workerRefs,
      targetTests: heavyTests,
      mutantIds: stillSurvivingIds,
      timeoutMs: Math.max(timeoutMs, 60_000),
      probeMinTests: 1,
      probeMinMutants: 4,
      targetFilePath,
      relFile,
      requireBaseline,
    })
    if (passB.baselineError !== undefined) {
      return { results: [], baselineError: passB.baselineError }
    }
    stageBResults = passB.results
  }

  return {
    results: mergeTwoPhaseResults(mutantIds, stageAResults, stageBResults),
    baselineError: undefined,
  }
}

const broadcastInvalidate = async (workerRefs, filesToInvalidate) => {
  if (!useWarmMode || filesToInvalidate.length === 0) return
  await Promise.all(
    workerRefs.map(async (ref) => {
      if (!ref.current || !ref.current.isAlive()) return
      const ok = await ref.current.invalidateFiles(filesToInvalidate)
      if (!ok) {
        await ref.current.shutdown()
        ref.current = null
      }
    }),
  )
}

const fileReports = []
const workerRefs = useWarmMode
  ? await Promise.all(
      Array.from({ length: concurrency }, async () => ({ current: await spawnWorker() })),
    )
  : []

try {
  let prevFullPath = null
  for (const file of files) {
    activeMutation = {
      relFile: file.relFile,
      fullPath: file.fullPath,
      originalSource: file.originalSource,
      originalSha256: file.originalSha256,
      mutatedSha256: file.mutatedSha256,
      wroteSchema: false,
    }
    try {
      mkdirSync(dirname(backupPath), { recursive: true })
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: file.fullPath,
          originalSha256: file.originalSha256,
          mutatedSha256: file.mutatedSha256,
          content: file.originalSource,
        }),
        "utf8",
      )
      writeFileSync(file.fullPath, file.schemaSource, "utf8")
      activeMutation.wroteSchema = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      restoreActiveMutationSync()
      fileReports.push({
        relFile: file.relFile,
        primaryResults: [],
        fallbackResults: [],
        restoreError: `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${msg}`,
      })
      break
    }

    const toInvalidate = prevFullPath !== null ? [prevFullPath, file.fullPath] : [file.fullPath]
    await broadcastInvalidate(workerRefs, toInvalidate)

    const { results: primaryResults } = await runTwoPhasePass({
      workerRefs,
      targetTests: file.primaryTests,
      mutantIds: file.mutantIds,
      timeoutMs: file.primaryTimeoutMs,
      targetFilePath: file.fullPath,
      relFile: file.relFile,
      requireBaseline: false,
    })

    const survivingIds = primaryResults
      .filter((entry) => isCleanSurvivorResult(entry?.result))
      .map((entry) => entry.id)

    let fallbackResults = []
    let fallbackBaselineError
    if (
      survivingIds.length > 0 &&
      Array.isArray(file.fallbackTests) &&
      file.fallbackTests.length > 0
    ) {
      const fbPass = await runTwoPhasePass({
        workerRefs,
        targetTests: file.fallbackTests,
        mutantIds: survivingIds,
        timeoutMs: file.fallbackTimeoutMs,
        targetFilePath: file.fullPath,
        relFile: file.relFile,
        requireBaseline: true,
      })
      if (fbPass.baselineError !== undefined) {
        fallbackBaselineError = fbPass.baselineError
      } else {
        fallbackResults = fbPass.results
      }
    }

    const restoreErr = restoreActiveMutationSync()
    prevFullPath = file.fullPath
    const reportErr = restoreErr ?? fallbackBaselineError
    fileReports.push({
      relFile: file.relFile,
      primaryResults,
      fallbackResults,
      ...(reportErr !== undefined ? { restoreError: reportErr } : {}),
    })
    if (reportErr !== undefined) break
  }
} finally {
  const activeRestoreErr = restoreActiveMutationSync()
  if (activeRestoreErr !== undefined) {
    process.stderr.write(`${activeRestoreErr}\n`)
  }
  await Promise.all(
    workerRefs.map(async (ref) => {
      if (ref.current) await ref.current.shutdown()
    }),
  )
  tracker.cleanupAll()
}

const payload = JSON.stringify(fileReports)
await new Promise((resolveDone) => {
  process.stdout.write(payload, () => resolveDone(undefined))
})
