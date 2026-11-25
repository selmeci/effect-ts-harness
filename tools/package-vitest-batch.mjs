import { createHash, randomBytes } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  DEFAULT_HEAVY_TEST_THRESHOLD_MS,
  WARM_WORKER_SCRIPT,
  createBatchTempTracker,
  createWarmVitestWorker,
  dedupCanonicalTests,
  isHeavyTest,
  parsePassedCount,
  resolveBatchConcurrency,
  runCoverageProbe,
  runOneColdMutant,
  runWarmMutantWithWorker,
  sortTestsByMeasuredOrStaticSpeed,
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
const testDurationsMs =
  typeof plan.testDurationsMs === "object" && plan.testDurationsMs !== null
    ? plan.testDurationsMs
    : undefined
const heavyThresholdMs =
  typeof plan.heavyThresholdMs === "number" &&
  Number.isFinite(plan.heavyThresholdMs) &&
  plan.heavyThresholdMs > 0
    ? plan.heavyThresholdMs
    : DEFAULT_HEAVY_TEST_THRESHOLD_MS
const maxWorkerRssBytes =
  typeof plan.maxWorkerRssBytes === "number" &&
  Number.isFinite(plan.maxWorkerRssBytes) &&
  plan.maxWorkerRssBytes > 0
    ? plan.maxWorkerRssBytes
    : undefined
const streamReportPath =
  typeof plan.streamReportPath === "string" && plan.streamReportPath.length > 0
    ? plan.streamReportPath
    : undefined
const maxSurvivors =
  typeof plan.maxSurvivors === "number" &&
  Number.isInteger(plan.maxSurvivors) &&
  plan.maxSurvivors >= 1
    ? plan.maxSurvivors
    : undefined

const childBaseEnv = { ...process.env }
delete childBaseEnv["HARNESS_PACKAGE_PLAN_FILE"]
delete childBaseEnv["HARNESS_ACTIVE_MUTANT_ID"]
delete childBaseEnv["HARNESS_BATCH_VITEST_CLI"]
delete childBaseEnv["HARNESS_BATCH_CWD"]
delete childBaseEnv["HARNESS_BATCH_TIMEOUT_MS"]
delete childBaseEnv["HARNESS_BATCH_TESTS_JSON"]
delete childBaseEnv["HARNESS_BATCH_MUTANTS_JSON"]
delete childBaseEnv["HARNESS_MUTATE_WARM_ISOLATE"]
delete childBaseEnv["HARNESS_WARM_ISOLATE"]
delete childBaseEnv["HARNESS_COVERAGE_OUT_DIR"]

const tracker = createBatchTempTracker()
let activeMutation = null

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const assertNotSymlinkSync = (targetPath, { allowMissing = false } = {}) => {
  let st
  try {
    st = lstatSync(targetPath)
  } catch (err) {
    if (allowMissing && typeof err === "object" && err !== null && err.code === "ENOENT") {
      return
    }
    throw err
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to operate on symbolic link '${targetPath}'`)
  }
}

const writeFileAtomicSync = (filePath, content, { allowMissing = false } = {}) => {
  assertNotSymlinkSync(filePath, { allowMissing })
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  let renamed = false
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" })
    renameSync(tmpPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        // Best-effort cleanup of temp file
      }
    }
  }
}

const restoreActiveMutationSync = () => {
  const cur = activeMutation
  if (cur === null) return undefined
  activeMutation = null
  if (cur.wroteSchema) {
    try {
      assertNotSymlinkSync(cur.fullPath)
      if (!cur.writeFailed) {
        const currentDisk = readFileSync(cur.fullPath, "utf8")
        const diskSha = sha256Hex(currentDisk)
        if (diskSha !== cur.mutatedSha256) {
          return `[mutation-check] CRITICAL: Target '${cur.relFile}' was modified externally mid-run (sha256=${diskSha}); refusing to overwrite user edits. Preserving '${backupPath}'.`
        }
      }
      writeFileAtomicSync(cur.fullPath, cur.originalSource)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `[mutation-check] CRITICAL: Failed to restore '${cur.fullPath}' (${msg}). Preserving '${backupPath}'.`
    }
  }
  try {
    assertNotSymlinkSync(dirname(backupPath), { allowMissing: true })
    assertNotSymlinkSync(backupPath, { allowMissing: true })
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
    const restoreErr = restoreActiveMutationSync()
    if (restoreErr !== undefined) {
      process.stderr.write(`${restoreErr}\n`)
    }
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
    maxWorkerRssBytes,
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

const appendStreamReport = (report) => {
  if (streamReportPath === undefined) return
  mkdirSync(dirname(streamReportPath), { recursive: true })
  appendFileSync(streamReportPath, `${JSON.stringify(report)}\n`, "utf8")
}

const createObservedDurationRecorder = (targetRecord) => {
  const resolvedCwd = resolve(cwd)
  return (durationsByTest) => {
    if (typeof durationsByTest !== "object" || durationsByTest === null) return
    for (const [rawPath, ms] of Object.entries(durationsByTest)) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) continue
      const abs = resolve(resolvedCwd, rawPath)
      const rel = relative(resolvedCwd, abs).replace(/\\/g, "/")
      if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
        targetRecord[rel] = Math.max(1, Math.round(ms))
      }
    }
  }
}

const ensureStageBaselined = async ({
  workerRefs,
  stageTests,
  timeoutMs,
  relFile,
  onObservedDurations,
}) => {
  const unbaselined = stageTests.filter((t) => !baselinedAbsTests.has(resolve(cwd, t)))
  if (unbaselined.length === 0) return undefined
  let res = null
  const startedMs = performance.now()
  let usedWarm = false
  if (useWarmMode && workerRefs.length > 0) {
    const ref = workerRefs[0]
    if (!ref.current || !ref.current.isAlive()) {
      ref.current = await spawnWorker()
    }
    if (ref.current) {
      usedWarm = true
      res = await ref.current.runSubset("", unbaselined, timeoutMs, "", onObservedDurations)
      if (ref.current && !ref.current.isAlive()) {
        await ref.current.shutdown()
        ref.current = null
      }
    }
  }
  if (res === null) {
    usedWarm = false
    res = (await coldFallback("", unbaselined, timeoutMs)).result
  }
  if (!isCleanSurvivorResult(res)) {
    const detail = ((res?.stderr ?? "") || (res?.stdout ?? "")).trim().slice(0, 300)
    return `[mutation-check] Baseline test suite failed on fallback tests for '${relFile}' (${unbaselined.length} file(s)): ${detail}`
  }
  if (!usedWarm && unbaselined.length === 1 && typeof onObservedDurations === "function") {
    onObservedDurations({
      [unbaselined[0]]: Math.max(1, Math.round(performance.now() - startedMs)),
    })
  }
  for (const t of unbaselined) baselinedAbsTests.add(resolve(cwd, t))
  return undefined
}

const probeCache = new Map()
const probeStats = { inWorkerProbes: 0, cachedProbes: 0, coldProbes: 0 }

const runMutantPassWithPool = async ({
  workerRefs,
  targetTests,
  mutantIds,
  timeoutMs,
  probeMinTests,
  probeMinMutants,
  relFile,
  mutatedSha256,
  stageLabel,
  requireBaseline = false,
  onObservedDurations = undefined,
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
        relFile,
        onObservedDurations,
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

  const probeCacheKey = sha256Hex(
    `${relFile}\0${mutatedSha256}\0${stageLabel}\0${canonTests.join("\0")}`,
  )
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
    workerRef: workerRefs[0],
    spawnWorker,
    probeCache,
    probeCacheKey,
    probeStats,
    onObservedDurations,
    heavyThresholdMs,
    testDurationsMs,
  })
  if (coverageInfo !== null) {
    for (const t of canonTests) baselinedAbsTests.add(resolve(cwd, t))
  } else if (requireBaseline) {
    const baseErr = await ensureStageBaselined({
      workerRefs,
      stageTests: canonTests,
      timeoutMs,
      relFile,
      onObservedDurations,
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
          onObservedDurations,
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
  relFile,
  mutatedSha256,
  stagePrefix,
  requireBaseline,
  onObservedDurations,
}) => {
  if (mutantIds.length === 0 || !Array.isArray(targetTests) || targetTests.length === 0) {
    return { results: [], baselineError: undefined }
  }
  const sortedTests = sortTestsByMeasuredOrStaticSpeed(
    targetTests,
    cwd,
    testDurationsMs,
    heavyThresholdMs,
  )
  const fastTests = sortedTests.filter(
    (t) => !isHeavyTest(t, cwd, testDurationsMs, heavyThresholdMs),
  )
  const heavyTests = sortedTests.filter((t) =>
    isHeavyTest(t, cwd, testDurationsMs, heavyThresholdMs),
  )

  let stageAResults = []
  if (fastTests.length > 0) {
    const passA = await runMutantPassWithPool({
      workerRefs,
      targetTests: fastTests,
      mutantIds,
      timeoutMs,
      probeMinTests: fastTests.length === 1 ? 1 : 2,
      probeMinMutants: fastTests.length === 1 ? 8 : 4,
      relFile,
      mutatedSha256,
      stageLabel: `${stagePrefix}:stageA`,
      requireBaseline,
      onObservedDurations,
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
      probeMinMutants: 2,
      relFile,
      mutatedSha256,
      stageLabel: `${stagePrefix}:stageB`,
      requireBaseline,
      onObservedDurations,
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

const recycleWorkersBetweenFiles = async (workerRefs) => {
  if (!useWarmMode) return
  await Promise.all(
    workerRefs.map(async (ref) => {
      if (!ref.current) return
      if (ref.current.shouldRecycle?.() || !ref.current.isAlive()) {
        await ref.current.shutdown()
        ref.current = null
      }
    }),
  )
}

const runFallbackStagePass = async ({
  workerRefs,
  targetTests,
  mutantIds,
  timeoutMs,
  relFile,
  mutatedSha256,
  stagePrefix,
  onObservedDurations,
}) => {
  if (mutantIds.length === 0 || !Array.isArray(targetTests) || targetTests.length === 0) {
    return { results: [], baselineError: undefined }
  }
  const pass = await runTwoPhasePass({
    workerRefs,
    targetTests,
    mutantIds,
    timeoutMs,
    relFile,
    mutatedSha256,
    stagePrefix,
    requireBaseline: true,
    onObservedDurations,
  })
  return pass.baselineError !== undefined
    ? { results: [], baselineError: pass.baselineError }
    : { results: pass.results, baselineError: undefined }
}

const filterSurvivorsByStageResults = (mutantIds, stageTests, stageResults) => {
  if (!Array.isArray(stageTests) || stageTests.length === 0) return mutantIds
  const byId = new Map(stageResults.filter(Boolean).map((entry) => [entry.id, entry.result]))
  return mutantIds.filter((id) => isCleanSurvivorResult(byId.get(id)))
}

const countFileConfirmedSurvivors = ({
  file,
  primaryResults,
  scopedFallbackResults,
  packageFallbackResults,
  scopedBaselineError,
  packageBaselineError,
}) => {
  const primarySurvivors = primaryResults
    .filter((entry) => isCleanSurvivorResult(entry?.result))
    .map((entry) => entry.id)
  if (primarySurvivors.length === 0) return 0

  const hasScoped = Array.isArray(file.scopedFallbackTests) && file.scopedFallbackTests.length > 0
  if (hasScoped && scopedBaselineError !== undefined) return 0
  const survivorsAfterScoped = filterSurvivorsByStageResults(
    primarySurvivors,
    file.scopedFallbackTests,
    scopedFallbackResults,
  )
  if (survivorsAfterScoped.length === 0) return 0

  const hasPkgFb = Array.isArray(file.packageFallbackTests) && file.packageFallbackTests.length > 0
  if (hasPkgFb && packageBaselineError !== undefined) return 0
  return filterSurvivorsByStageResults(
    survivorsAfterScoped,
    file.packageFallbackTests,
    packageFallbackResults,
  ).length
}

const fileReports = []
const workerRefs = []

try {
  if (useWarmMode) {
    for (let i = 0; i < concurrency; i += 1) {
      workerRefs.push({ current: null })
    }
    await Promise.all(
      workerRefs.map(async (ref) => {
        ref.current = await spawnWorker()
      }),
    )
  }
  let prevFullPath = null
  let confirmedSurvivors = 0
  for (const file of files) {
    const observedTestDurationsMs = {}
    const onObservedDurations = createObservedDurationRecorder(observedTestDurationsMs)

    activeMutation = {
      relFile: file.relFile,
      fullPath: file.fullPath,
      originalSource: file.originalSource,
      originalSha256: file.originalSha256,
      mutatedSha256: file.mutatedSha256,
      wroteSchema: false,
      writeFailed: false,
    }
    let preflightMismatch = false
    try {
      assertNotSymlinkSync(file.fullPath)
      const currentDisk = readFileSync(file.fullPath, "utf8")
      const diskSha = sha256Hex(currentDisk)
      if (diskSha !== file.originalSha256) {
        activeMutation = null
        const errReport = {
          relFile: file.relFile,
          primaryResults: [],
          scopedFallbackResults: [],
          packageFallbackResults: [],
          observedTestDurationsMs,
          restoreError: `[mutation-check] Refusing to mutate '${file.relFile}': disk sha256 (${diskSha}) does not match planned originalSha256 (${file.originalSha256}).`,
        }
        fileReports.push(errReport)
        appendStreamReport(errReport)
        preflightMismatch = true
      } else {
        assertNotSymlinkSync(dirname(backupPath), { allowMissing: true })
        mkdirSync(dirname(backupPath), { recursive: true })
        assertNotSymlinkSync(dirname(backupPath))
        writeFileAtomicSync(
          backupPath,
          JSON.stringify({
            filePath: file.fullPath,
            originalSha256: file.originalSha256,
            mutatedSha256: file.mutatedSha256,
            content: file.originalSource,
          }),
          { allowMissing: true },
        )
        activeMutation.wroteSchema = true
        writeFileAtomicSync(file.fullPath, file.schemaSource)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      activeMutation.writeFailed = true
      const cleanupErr = restoreActiveMutationSync()
      const restoreError =
        cleanupErr !== undefined
          ? `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${msg}; ${cleanupErr}`
          : `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${msg}`
      const errReport = {
        relFile: file.relFile,
        primaryResults: [],
        scopedFallbackResults: [],
        packageFallbackResults: [],
        observedTestDurationsMs,
        restoreError,
      }
      fileReports.push(errReport)
      appendStreamReport(errReport)
      break
    }
    if (preflightMismatch) break

    const toInvalidate = prevFullPath !== null ? [prevFullPath, file.fullPath] : [file.fullPath]
    await broadcastInvalidate(workerRefs, toInvalidate)

    const { results: primaryResults } = await runTwoPhasePass({
      workerRefs,
      targetTests: file.primaryTests,
      mutantIds: file.mutantIds,
      timeoutMs: file.primaryTimeoutMs,
      relFile: file.relFile,
      mutatedSha256: file.mutatedSha256,
      stagePrefix: "primary",
      requireBaseline: false,
      onObservedDurations,
    })

    const survivingAfterPrimary = primaryResults
      .filter((entry) => isCleanSurvivorResult(entry?.result))
      .map((entry) => entry.id)

    const scopedPass = await runFallbackStagePass({
      workerRefs,
      targetTests: file.scopedFallbackTests,
      mutantIds: survivingAfterPrimary,
      timeoutMs: file.scopedFallbackTimeoutMs ?? 30_000,
      relFile: file.relFile,
      mutatedSha256: file.mutatedSha256,
      stagePrefix: "scopedFallback",
      onObservedDurations,
    })
    const scopedFallbackResults = scopedPass.results
    const scopedBaselineError = scopedPass.baselineError

    const survivingAfterScoped = filterSurvivorsByStageResults(
      survivingAfterPrimary,
      file.scopedFallbackTests,
      scopedFallbackResults,
    )

    const pkgPass =
      scopedBaselineError === undefined
        ? await runFallbackStagePass({
            workerRefs,
            targetTests: file.packageFallbackTests,
            mutantIds: survivingAfterScoped,
            timeoutMs: file.packageFallbackTimeoutMs ?? 30_000,
            relFile: file.relFile,
            mutatedSha256: file.mutatedSha256,
            stagePrefix: "packageFallback",
            onObservedDurations,
          })
        : { results: [], baselineError: undefined }
    const packageFallbackResults = pkgPass.results
    const packageBaselineError = pkgPass.baselineError

    const restoreErr = restoreActiveMutationSync()
    prevFullPath = file.fullPath
    const reportErr = restoreErr ?? scopedBaselineError ?? packageBaselineError
    const fileReport = {
      relFile: file.relFile,
      primaryResults,
      scopedFallbackResults,
      packageFallbackResults,
      observedTestDurationsMs,
      ...(reportErr !== undefined ? { restoreError: reportErr } : {}),
    }
    fileReports.push(fileReport)
    appendStreamReport(fileReport)

    await recycleWorkersBetweenFiles(workerRefs)

    if (reportErr !== undefined) break
    confirmedSurvivors += countFileConfirmedSurvivors({
      file,
      primaryResults,
      scopedFallbackResults,
      packageFallbackResults,
      scopedBaselineError,
      packageBaselineError,
    })
    if (maxSurvivors !== undefined && confirmedSurvivors >= maxSurvivors) break
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
