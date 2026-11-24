import { fork, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HEAVY_META_TESTS = new Set([
  "mutation-check.test.ts",
  "mutation-speedup.test.ts",
  "self-dogfooding-capability-plugins.test.ts",
  "self-dogfooding-plugin-harness.test.ts",
  "milestone5-dst-ears-mutation-dpo.test.ts",
  "policy-check.test.ts",
  "type-extractor.test.ts",
  "graph-projector.test.ts",
  "structural-search.test.ts",
  "workflow-graph-assets.test.ts",
  "ts-compiler-overlay-service.test.ts",
])

const VERY_HEAVY_TESTS = new Set(["policy-check.test.ts", "type-extractor.test.ts"])

export const sortTestsByStaticSpeed = (tests) =>
  [...tests].sort((a, b) => {
    const baseA = a.split(/[/\\]/).pop() ?? a
    const baseB = b.split(/[/\\]/).pop() ?? b
    const rankA = VERY_HEAVY_TESTS.has(baseA) ? 2 : isHeavyMetaTest(a) ? 1 : 0
    const rankB = VERY_HEAVY_TESTS.has(baseB) ? 2 : isHeavyMetaTest(b) ? 1 : 0
    if (rankA !== rankB) return rankA - rankB
    return a < b ? -1 : a > b ? 1 : 0
  })

export const truncateBatchOutput = (text) =>
  text.length > 48_000
    ? `${text.slice(0, 16_000)}\n...[truncated]...\n${text.slice(-24_000)}`
    : text

const appendCapped = (current, chunk, maxChars = 16_000) => {
  const combined = current + String(chunk)
  return combined.length > maxChars ? combined.slice(-maxChars) : combined
}

export const isHeavyMetaTest = (testPath) => {
  const base = testPath.split(/[/\\]/).pop() ?? testPath
  return HEAVY_META_TESTS.has(base)
}

export const parsePassedCount = (stdout) => {
  const m = /\bTests\s+([1-9]\d*)\s+passed\b/.exec(stdout)
  return m !== null ? Number(m[1]) : null
}

export const dedupCanonicalTests = (cwd, rawTestFiles) => {
  const seen = new Set()
  const testFiles = []
  const absToRaw = new Map()
  for (const tf of rawTestFiles) {
    const abs = resolve(cwd, tf)
    if (!seen.has(abs)) {
      seen.add(abs)
      testFiles.push(tf)
      absToRaw.set(abs, tf)
    }
  }
  return { testFiles, absToRaw }
}

export const resolveBatchConcurrency = (mutantCount, warmMode, env = process.env) => {
  const totalCores = Math.max(1, availableParallelism())
  const rawOverride = env["HARNESS_MUTATE_CONCURRENCY"]
  if (rawOverride !== undefined && rawOverride.trim().length > 0) {
    const parsed = Number(rawOverride)
    if (Number.isInteger(parsed) && parsed >= 1) {
      return Math.min(totalCores, parsed, mutantCount)
    }
  }
  const coreLimit = Math.max(2, Math.floor(totalCores / 2))
  if (warmMode) {
    return Math.min(8, Math.max(1, Math.min(mutantCount, Math.ceil(mutantCount / 2))), coreLimit)
  }
  return Math.min(8, coreLimit, mutantCount)
}

export const createBatchTempTracker = () => {
  const activeChildren = new Set()
  const activeStateDirs = new Set()

  const makeTempDir = (prefix) => {
    const dir = resolve(mkdtempSync(join(tmpdir(), prefix)))
    activeStateDirs.add(dir)
    return dir
  }

  const cleanupTempDir = (dir) => {
    activeStateDirs.delete(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of temporary directory
    }
  }

  const cleanupAll = () => {
    for (const child of activeChildren) {
      try {
        child.kill("SIGKILL")
      } catch {
        // Best-effort termination of active worker child
      }
    }
    activeChildren.clear()
    for (const dir of activeStateDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup of active temp directory
      }
    }
    activeStateDirs.clear()
  }

  return { activeChildren, makeTempDir, cleanupTempDir, cleanupAll }
}

const VITEST_CONFIG_FILENAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
]

const isPathWithin = (parentDir, childPath) => {
  const rel = relative(parentDir, childPath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export const resolveCommonVitestConfig = (cwd, testFiles) => {
  if (!Array.isArray(testFiles) || testFiles.length === 0) return undefined
  const resolvedCwd = resolve(cwd)
  const dirs = testFiles.map((f) => dirname(resolve(resolvedCwd, f)))
  let commonDir = dirs[0]
  while (!dirs.every((d) => isPathWithin(commonDir, d))) {
    const parent = dirname(commonDir)
    if (parent === commonDir) return undefined
    commonDir = parent
  }
  if (!isPathWithin(resolvedCwd, commonDir)) return undefined
  let cur = commonDir
  while (isPathWithin(resolvedCwd, cur)) {
    for (const cfgName of VITEST_CONFIG_FILENAMES) {
      const cfgPath = join(cur, cfgName)
      if (existsSync(cfgPath)) return cfgPath
    }
    if (cur === resolvedCwd) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

export const runOneColdMutant = async ({
  vitestCli,
  cwd,
  childBaseEnv,
  testFiles,
  mutantId,
  timeoutMs,
  tracker,
}) => {
  const workerStateDir = tracker.makeTempDir("harness-batch-state-")
  const childEnv = {
    ...childBaseEnv,
    HARNESS_STATE_DIR: workerStateDir,
    HARNESS_ACTIVE_MUTANT_ID: mutantId,
  }
  const configPath = resolveCommonVitestConfig(cwd, testFiles)
  const resolvedTests = configPath ? testFiles.map((tf) => resolve(cwd, tf)) : testFiles
  const vitestArgs = configPath
    ? [
        vitestCli,
        "run",
        "--root",
        dirname(configPath),
        "--config",
        configPath,
        "--bail=1",
        "--maxWorkers=1",
        ...resolvedTests,
      ]
    : [vitestCli, "run", "--bail=1", "--maxWorkers=1", ...testFiles]
  try {
    return await new Promise((resolvePromise) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false
      let settled = false
      let child
      try {
        child = spawn(process.execPath, vitestArgs, {
          cwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (err) {
        const rawErr = (err instanceof Error ? err.message : String(err)).trim()
        resolvePromise({
          id: mutantId,
          result: {
            _tag: "SpawnFailed",
            spawnError: rawErr.length > 0 ? rawErr : "Spawn failed",
            stdout: "",
            stderr: "",
          },
        })
        return
      }
      tracker.activeChildren.add(child)
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        tracker.activeChildren.delete(child)
        resolvePromise({ id: mutantId, result })
      }
      child.stdout?.on("data", (c) => {
        stdout += String(c)
      })
      child.stderr?.on("data", (c) => {
        stderr += String(c)
      })
      child.on("error", (err) => {
        const rawErr = (err instanceof Error ? err.message : String(err)).trim()
        finish({
          _tag: "SpawnFailed",
          spawnError: rawErr.length > 0 ? rawErr : "Spawn failed",
          stdout: truncateBatchOutput(stdout),
          stderr: truncateBatchOutput(stderr),
        })
      })
      child.on("close", (code, signal) => {
        const out = truncateBatchOutput(stdout)
        const errOut = truncateBatchOutput(stderr)
        if (timedOut) return finish({ _tag: "TimedOut", stdout: out, stderr: errOut })
        if (signal !== null)
          return finish({ _tag: "Signaled", signal, stdout: out, stderr: errOut })
        finish({ _tag: "Exited", exitCode: code ?? -1, stdout: out, stderr: errOut })
      })
    })
  } finally {
    tracker.cleanupTempDir(workerStateDir)
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const WARM_WORKER_SCRIPT = join(scriptDir, "warm-vitest-worker.mjs")
export const COVERAGE_SETUP_SCRIPT = join(scriptDir, "mutant-coverage-setup.mjs")

const escapeRegexLiteral = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const runCoverageProbe = async ({
  vitestNodeEntry,
  cwd,
  childBaseEnv,
  testFiles,
  absToRaw,
  mutantCount,
  minTests = 2,
  minMutants = 4,
  timeoutMs,
  tracker,
}) => {
  if (
    testFiles.length < minTests ||
    mutantCount < minMutants ||
    !existsSync(COVERAGE_SETUP_SCRIPT)
  ) {
    return null
  }
  const probeStateDir = tracker.makeTempDir("harness-probe-state-")
  const covOutDir = tracker.makeTempDir("harness-probe-cov-")
  try {
    const probeEnv = {
      ...childBaseEnv,
      HARNESS_WARM_MODE: "probe",
      HARNESS_WARM_VITEST_NODE_ENTRY: vitestNodeEntry,
      HARNESS_WARM_CWD: cwd,
      HARNESS_WARM_TESTS_JSON: JSON.stringify(testFiles),
      HARNESS_WARM_COVERAGE_SETUP: COVERAGE_SETUP_SCRIPT,
      HARNESS_WARM_COVERAGE_OUT_DIR: covOutDir,
      HARNESS_WARM_STATE_DIR: probeStateDir,
    }
    const probeResult = await new Promise((resolvePromise) => {
      let child
      try {
        child = fork(WARM_WORKER_SCRIPT, [], {
          cwd,
          env: probeEnv,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      } catch {
        resolvePromise({ ok: false, durationsByTest: {} })
        return
      }
      tracker.activeChildren.add(child)
      let doneOk = false
      let durationsByTest = {}
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        tracker.activeChildren.delete(child)
        resolvePromise({ ok, durationsByTest })
      }
      const timer = setTimeout(
        () => {
          try {
            child.kill("SIGKILL")
          } catch {
            // Best-effort kill on probe timeout
          }
          finish(false)
        },
        Math.max(timeoutMs, 45_000),
      )
      child.stdout?.resume()
      child.stderr?.resume()
      child.on("message", (msg) => {
        if (typeof msg === "object" && msg !== null && msg.type === "probeDone") {
          doneOk = msg.ok === true
          if (typeof msg.durationsByTest === "object" && msg.durationsByTest !== null) {
            durationsByTest = msg.durationsByTest
          }
        }
      })
      child.on("error", () => finish(false))
      child.on("close", (code) => finish(doneOk && code === 0))
    })
    if (!probeResult.ok) return null

    const coveredCanonical = new Set()
    const hitCountByTest = new Map()
    const fileDurationMs = new Map()
    const coveringSets = new Map()
    const perTestByMutantFile = new Map()
    const totalTestsByFile = new Map()

    for (const fileName of readdirSync(covOutDir)) {
      if (!fileName.endsWith(".json")) continue
      const parsed = JSON.parse(readFileSync(join(covOutDir, fileName), "utf8"))
      const absTestPath = resolve(cwd, String(parsed.testFile ?? ""))
      const mappedTest = absToRaw.get(absTestPath)
      if (!mappedTest) continue
      coveredCanonical.add(mappedTest)
      const measuredMs = probeResult.durationsByTest[absTestPath]
      fileDurationMs.set(
        mappedTest,
        typeof measuredMs === "number" && Number.isFinite(measuredMs)
          ? measuredMs
          : isHeavyMetaTest(mappedTest)
            ? 5_000
            : 500,
      )
      const hits = Array.isArray(parsed.hits) ? parsed.hits : []
      hitCountByTest.set(mappedTest, hits.length)
      for (const hitId of hits) {
        let set = coveringSets.get(hitId)
        if (!set) {
          set = new Set()
          coveringSets.set(hitId, set)
        }
        set.add(mappedTest)
      }
      const perTestList = Array.isArray(parsed.perTestHits) ? parsed.perTestHits : []
      const distinctTestNames = new Set()
      for (const entry of perTestList) {
        if (typeof entry !== "object" || entry === null) continue
        const testName = typeof entry.testName === "string" ? entry.testName : ""
        if (testName.length === 0) continue
        distinctTestNames.add(testName)
        const durMs = typeof entry.durationMs === "number" ? entry.durationMs : 100
        const entryHits = Array.isArray(entry.hits) ? entry.hits : []
        for (const hitId of entryHits) {
          let byFile = perTestByMutantFile.get(hitId)
          if (!byFile) {
            byFile = new Map()
            perTestByMutantFile.set(hitId, byFile)
          }
          let byTestName = byFile.get(mappedTest)
          if (!byTestName) {
            byTestName = new Map()
            byFile.set(mappedTest, byTestName)
          }
          const prev = byTestName.get(testName)
          if (prev === undefined || durMs < prev) byTestName.set(testName, durMs)
        }
      }
      totalTestsByFile.set(mappedTest, distinctTestNames.size)
    }
    if (coveredCanonical.size !== testFiles.length) return null

    const coveringByMutant = new Map()
    const targetedByMutant = new Map()
    for (const [mId, testSet] of coveringSets.entries()) {
      const sorted = [...testSet].sort((a, b) => {
        const durDiff = (fileDurationMs.get(a) ?? 500) - (fileDurationMs.get(b) ?? 500)
        if (durDiff !== 0) return durDiff
        const countDiff = (hitCountByTest.get(a) ?? 0) - (hitCountByTest.get(b) ?? 0)
        return countDiff !== 0 ? countDiff : a < b ? -1 : a > b ? 1 : 0
      })
      coveringByMutant.set(mId, sorted)

      const fastestFile = sorted[0]
      if (fastestFile !== undefined) {
        const durMs = fileDurationMs.get(fastestFile) ?? 500
        const byTestName = perTestByMutantFile.get(mId)?.get(fastestFile)
        const distinctTotal = totalTestsByFile.get(fastestFile) ?? 0
        if (
          (durMs >= 1_200 || isHeavyMetaTest(fastestFile)) &&
          byTestName !== undefined &&
          byTestName.size > 0 &&
          (distinctTotal === 0 || byTestName.size < distinctTotal || byTestName.size <= 6)
        ) {
          const pickedTests = [...byTestName.entries()]
            .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .slice(0, 6)
            .map(([name]) => escapeRegexLiteral(name))
          if (pickedTests.length > 0) {
            targetedByMutant.set(mId, {
              file: fastestFile,
              pattern: `^(?:${pickedTests.join("|")})$`,
            })
          }
        }
      }
    }
    return { coveringByMutant, targetedByMutant }
  } catch {
    return null
  } finally {
    tracker.cleanupTempDir(covOutDir)
    tracker.cleanupTempDir(probeStateDir)
  }
}

const MAX_WORKER_RSS_BYTES = 750 * 1024 * 1024

export const createWarmVitestWorker = async ({
  vitestNodeEntry,
  cwd,
  childBaseEnv,
  allTests,
  tracker,
  isolate = true,
}) => {
  let child
  try {
    child = fork(WARM_WORKER_SCRIPT, [], {
      cwd,
      env: {
        ...childBaseEnv,
        HARNESS_WARM_MODE: "worker",
        HARNESS_WARM_VITEST_NODE_ENTRY: vitestNodeEntry,
        HARNESS_WARM_CWD: cwd,
        HARNESS_WARM_TESTS_JSON: JSON.stringify(allTests),
        HARNESS_WARM_ISOLATE: isolate ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
  } catch {
    return null
  }
  tracker.activeChildren.add(child)

  let tailStdout = ""
  let tailStderr = ""
  let closed = false
  let pendingRun = null
  let pendingInvalidate = null
  let reqSeq = 0
  let lastRssBytes = 0

  child.stdout?.on("data", (c) => {
    tailStdout = appendCapped(tailStdout, c)
  })
  child.stderr?.on("data", (c) => {
    tailStderr = appendCapped(tailStderr, c)
  })

  const bootOk = await new Promise((resolveBoot) => {
    let settled = false
    const finishBoot = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(bootTimer)
      resolveBoot(ok)
    }
    const bootTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // Best-effort kill on boot timeout
      }
      finishBoot(false)
    }, 25_000)

    child.on("message", (msg) => {
      if (typeof msg !== "object" || msg === null) return
      if (msg.type === "ready") return finishBoot(true)
      if (
        msg.type === "invalidated" &&
        pendingInvalidate &&
        msg.reqId === pendingInvalidate.reqId
      ) {
        return pendingInvalidate.resolve(true)
      }
      if (msg.type === "result" && pendingRun !== null && msg.id === pendingRun.id) {
        if (typeof msg.rssBytes === "number") lastRssBytes = msg.rssBytes
        return pendingRun.resolve({ _tag: "Result", result: msg.result })
      }
    })
    child.on("error", (err) => {
      closed = true
      tracker.activeChildren.delete(child)
      finishBoot(false)
      if (pendingInvalidate) pendingInvalidate.resolve(false)
      if (pendingRun !== null) {
        const msg = err instanceof Error ? err.message : String(err)
        pendingRun.resolve({
          _tag: "SpawnFailed",
          spawnError: msg.length > 0 ? msg : "Warm worker IPC error",
          stdout: tailStdout,
          stderr: tailStderr,
        })
      }
    })
    child.on("close", (code, signal) => {
      closed = true
      tracker.activeChildren.delete(child)
      finishBoot(false)
      if (pendingInvalidate) pendingInvalidate.resolve(false)
      if (pendingRun !== null) {
        pendingRun.resolve(
          signal !== null
            ? { _tag: "Signaled", signal, stdout: tailStdout, stderr: tailStderr }
            : { _tag: "Exited", exitCode: code ?? -1, stdout: tailStdout, stderr: tailStderr },
        )
      }
    })
  })

  if (!bootOk) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Best-effort cleanup of failed worker
    }
    tracker.activeChildren.delete(child)
    return null
  }

  const invalidateFiles = async (files) => {
    if (closed || !child.connected) return false
    if (!Array.isArray(files) || files.length === 0) return true
    reqSeq += 1
    const reqId = reqSeq
    return new Promise((resolveInv) => {
      let settled = false
      const settle = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(invTimer)
        pendingInvalidate = null
        resolveInv(ok)
      }
      const invTimer = setTimeout(() => {
        closed = true
        try {
          child.kill("SIGKILL")
        } catch {
          // Best-effort kill on invalidate timeout
        }
        settle(false)
      }, 5_000)
      pendingInvalidate = { reqId, resolve: settle }
      try {
        child.send({ type: "invalidate", reqId, files })
      } catch {
        closed = true
        settle(false)
      }
    })
  }

  const runSubset = async (
    mutantId,
    subsetFiles,
    timeoutMs,
    invalidateFile = "",
    testNamePattern = "",
  ) => {
    if (closed || !child.connected) return null
    const stateDir = tracker.makeTempDir("harness-batch-state-")
    tailStdout = ""
    tailStderr = ""
    try {
      return await new Promise((resolveRun) => {
        let settled = false
        let timedOut = false
        const settle = (res) => {
          if (settled) return
          settled = true
          clearTimeout(runTimer)
          pendingRun = null
          resolveRun(res)
        }
        const runTimer = setTimeout(() => {
          timedOut = true
          closed = true
          try {
            child.kill("SIGKILL")
          } catch {
            // Best-effort kill on mutant run timeout
          }
          settle({ _tag: "TimedOut", stdout: tailStdout, stderr: tailStderr })
        }, timeoutMs)

        pendingRun = {
          id: mutantId,
          resolve: (ev) => {
            if (timedOut) {
              settle({ _tag: "TimedOut", stdout: tailStdout, stderr: tailStderr })
            } else if (ev._tag === "Result") {
              settle(ev.result)
            } else {
              settle(ev)
            }
          },
        }
        try {
          child.send({
            type: "run",
            id: mutantId,
            testFiles: subsetFiles,
            stateDir,
            ...(invalidateFile ? { invalidateFile } : {}),
            ...(testNamePattern ? { testNamePattern } : {}),
          })
        } catch (err) {
          closed = true
          const rawErr = err instanceof Error ? err.message : String(err)
          settle({
            _tag: "SpawnFailed",
            spawnError: rawErr,
            stdout: tailStdout,
            stderr: tailStderr,
          })
        }
      })
    } finally {
      tracker.cleanupTempDir(stateDir)
    }
  }

  const shutdown = async () => {
    if (closed) return
    await new Promise((resolveStop) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Best-effort kill on shutdown timeout
        }
        resolveStop(undefined)
      }, 3_000)
      child.once("close", () => {
        clearTimeout(killTimer)
        resolveStop(undefined)
      })
      try {
        child.send({ type: "shutdown" })
      } catch {
        clearTimeout(killTimer)
        try {
          child.kill("SIGKILL")
        } catch {
          // Best-effort kill on disconnected channel
        }
        resolveStop(undefined)
      }
    })
    tracker.activeChildren.delete(child)
  }

  return {
    invalidateFiles,
    runSubset,
    shutdown,
    isAlive: () => !closed && child.connected,
    shouldRecycle: () => lastRssBytes > MAX_WORKER_RSS_BYTES,
  }
}

export const runWarmMutantWithWorker = async ({
  workerRef,
  spawnWorker,
  coldFallback,
  mutantId,
  targetTests,
  coverageInfo,
  timeoutMs,
  cwd,
  targetFilePath = "",
}) => {
  const ensureWorker = async () => {
    if (!workerRef.current || !workerRef.current.isAlive()) {
      workerRef.current = await spawnWorker()
    }
    return workerRef.current
  }
  const maybeRecycle = async () => {
    if (workerRef.current?.shouldRecycle?.()) {
      await workerRef.current.shutdown()
      workerRef.current = null
    }
  }

  const targeted = coverageInfo?.targetedByMutant?.get(mutantId)
  if (targeted) {
    const w0 = await ensureWorker()
    if (w0) {
      const stage0 = await w0.runSubset(
        mutantId,
        [targeted.file],
        timeoutMs,
        targetFilePath,
        targeted.pattern,
      )
      await maybeRecycle()
      if (stage0 !== null && (stage0._tag !== "Exited" || stage0.exitCode !== 0)) {
        return { id: mutantId, result: stage0 }
      }
    }
  }

  const w1 = await ensureWorker()
  if (!w1) return coldFallback(mutantId, targetTests, timeoutMs)

  const covering = coverageInfo?.coveringByMutant?.get(mutantId)
  if (!covering || covering.length === 0 || covering.length >= targetTests.length) {
    const res = await w1.runSubset(mutantId, targetTests, timeoutMs, targetFilePath)
    await maybeRecycle()
    if (res === null) return coldFallback(mutantId, targetTests, timeoutMs)
    return { id: mutantId, result: res }
  }

  const coveringSet = new Set(covering.map((f) => resolve(cwd, f)))
  const remaining = targetTests.filter((f) => !coveringSet.has(resolve(cwd, f)))
  if (remaining.length === 0) {
    const res = await w1.runSubset(mutantId, targetTests, timeoutMs, targetFilePath)
    await maybeRecycle()
    if (res === null) return coldFallback(mutantId, targetTests, timeoutMs)
    return { id: mutantId, result: res }
  }

  const stage1 = await w1.runSubset(mutantId, covering, timeoutMs, targetFilePath)
  if (stage1 === null) {
    await maybeRecycle()
    return coldFallback(mutantId, targetTests, timeoutMs)
  }
  if (stage1._tag !== "Exited" || stage1.exitCode !== 0) {
    await maybeRecycle()
    return { id: mutantId, result: stage1 }
  }
  const count1 = parsePassedCount(stage1.stdout)
  if (count1 === null) {
    await maybeRecycle()
    return { id: mutantId, result: stage1 }
  }

  const w2 = await ensureWorker()
  if (!w2) return coldFallback(mutantId, targetTests, timeoutMs)
  const stage2 = await w2.runSubset(mutantId, remaining, timeoutMs, targetFilePath)
  await maybeRecycle()
  if (stage2 === null) return coldFallback(mutantId, targetTests, timeoutMs)
  if (stage2._tag !== "Exited" || stage2.exitCode !== 0) {
    return { id: mutantId, result: stage2 }
  }
  const count2 = parsePassedCount(stage2.stdout)
  if (count2 === null) return { id: mutantId, result: stage2 }

  const totalPassed = count1 + count2
  return {
    id: mutantId,
    result: {
      _tag: "Exited",
      exitCode: 0,
      stdout: `Tests  ${totalPassed} passed (${totalPassed})\n`,
      stderr: [stage1.stderr, stage2.stderr].filter(Boolean).join("\n"),
    },
  }
}
