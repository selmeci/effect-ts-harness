import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const fsModuleCachePath = join(tmpdir(), "effect-harness-vitest-fs-cache")

const vitestNodeEntry = process.env["HARNESS_WARM_VITEST_NODE_ENTRY"] ?? ""
const cwd = process.env["HARNESS_WARM_CWD"] ?? process.cwd()
const rawTestFiles = JSON.parse(process.env["HARNESS_WARM_TESTS_JSON"] ?? "[]")
const mode = process.env["HARNESS_WARM_MODE"] ?? "worker"
const coverageSetup = process.env["HARNESS_WARM_COVERAGE_SETUP"] ?? ""
const coverageOutDir = process.env["HARNESS_WARM_COVERAGE_OUT_DIR"] ?? ""
const probeStateDir = process.env["HARNESS_WARM_STATE_DIR"] ?? ""
const warmIsolate = true

for (const key of Object.keys(process.env)) {
  if (key.startsWith("HARNESS_WARM_") || key.startsWith("HARNESS_BATCH_")) {
    delete process.env[key]
  }
}
delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
delete process.env["HARNESS_COVERAGE_OUT_DIR"]
delete process.env["HARNESS_MUTATE_WARM_ISOLATE"]
delete process.env["HARNESS_WARM_ISOLATE"]

const CONFIG_FILENAMES = [
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

const toRepoRelForwardSlash = (filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) return ""
  const abs = resolve(cwd, filePath)
  const rel = relative(resolve(cwd), abs).replace(/\\/g, "/")
  return rel.length > 0 ? rel : filePath.replace(/\\/g, "/")
}

const resolveCommonPackageConfig = (repoCwd, absTestFiles) => {
  const resolvedCwd = resolve(repoCwd)
  if (absTestFiles.length === 0) return { root: resolvedCwd }
  const dirs = absTestFiles.map((f) => dirname(f))
  let commonDir = dirs[0]
  while (!dirs.every((d) => isPathWithin(commonDir, d))) {
    const parent = dirname(commonDir)
    if (parent === commonDir) {
      commonDir = resolvedCwd
      break
    }
    commonDir = parent
  }
  if (!isPathWithin(resolvedCwd, commonDir)) return { root: resolvedCwd }
  let cur = commonDir
  while (isPathWithin(resolvedCwd, cur)) {
    for (const cfgName of CONFIG_FILENAMES) {
      const cfgPath = join(cur, cfgName)
      if (existsSync(cfgPath)) return { root: cur, config: cfgPath }
    }
    if (cur === resolvedCwd) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return { root: resolvedCwd }
}

const truncateOutput = (text) =>
  text.length > 48_000
    ? `${text.slice(0, 16_000)}\n...[truncated]...\n${text.slice(-24_000)}`
    : text

const formatErrorText = (err) => {
  if (err instanceof Error) {
    return typeof err.stack === "string" && err.stack.length > 0
      ? err.stack
      : `${err.name}: ${err.message}`
  }
  if (typeof err === "object" && err !== null) {
    const rec = err
    const name = typeof rec.name === "string" ? rec.name : "Error"
    const message = typeof rec.message === "string" ? rec.message : JSON.stringify(err)
    if (typeof rec.stack === "string" && rec.stack.length > 0) return rec.stack
    return `${name}: ${message}`
  }
  return String(err)
}

const INFRA_OR_TRANSFORM_RE =
  /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|Failed to resolve import|Failed to load config|SyntaxError:|Transform failed with \d+ error/i

const synthesizeRunOutcome = (specs, runRes) => {
  if (!Array.isArray(specs) || specs.length === 0) {
    return {
      summary: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "No test files found\n",
        stderr: "",
      },
      cleanDurationsByTest: undefined,
    }
  }
  const ranModuleIds = new Set(specs.map((s) => resolve(s.moduleId)))
  let passed = 0
  let failed = 0
  let firstFailLabel = ""
  let firstFailModLabel = ""
  let firstModuleErrLabel = ""
  const failedErrorTexts = []
  const moduleAndUnhandledTexts = []
  const cleanDurationsByTest = {}

  for (const mod of runRes.testModules ?? []) {
    const modAbs = resolve(mod.moduleId || "")
    if (!ranModuleIds.has(modAbs)) continue
    const modLabel = toRepoRelForwardSlash(mod.moduleId || "") || String(mod.moduleId)
    const modErrors = typeof mod.errors === "function" ? mod.errors() : []
    for (const modErr of modErrors) {
      if (firstModuleErrLabel.length === 0) firstModuleErrLabel = modLabel
      moduleAndUnhandledTexts.push(formatErrorText(modErr))
    }
    const tests =
      mod.children && typeof mod.children.allTests === "function" ? mod.children.allTests() : []
    for (const test of tests) {
      const res = test.result()
      if (res.state === "passed") {
        passed += 1
      } else if (res.state === "failed") {
        failed += 1
        if (firstFailLabel.length === 0) {
          firstFailLabel = `${modLabel} > ${test.fullName}`
        }
        if (firstFailModLabel.length === 0) {
          firstFailModLabel = modLabel
        }
        for (const err of res.errors ?? []) {
          failedErrorTexts.push(formatErrorText(err))
        }
      }
    }
    const diag = typeof mod.diagnostic === "function" ? mod.diagnostic() : undefined
    const rawMs =
      (typeof diag?.duration === "number" && Number.isFinite(diag.duration) ? diag.duration : 0) +
      (typeof diag?.collectDuration === "number" && Number.isFinite(diag.collectDuration)
        ? diag.collectDuration
        : 0)
    if (modLabel.length > 0 && Number.isFinite(rawMs) && rawMs >= 0) {
      cleanDurationsByTest[modLabel] = Math.max(1, Math.round(rawMs))
    }
  }
  for (const unhandledErr of runRes.unhandledErrors ?? []) {
    moduleAndUnhandledTexts.push(formatErrorText(unhandledErr))
  }

  const modAndUnhandledCombined = moduleAndUnhandledTexts.join("\n")
  if (modAndUnhandledCombined.length > 0 && INFRA_OR_TRANSFORM_RE.test(modAndUnhandledCombined)) {
    const killingTestFile = firstModuleErrLabel || firstFailModLabel
    return {
      summary: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: truncateOutput(modAndUnhandledCombined),
        ...(killingTestFile.length > 0 ? { killingTestFile } : {}),
      },
      cleanDurationsByTest: undefined,
    }
  }
  if (failed > 0) {
    const killingTestFile = firstFailModLabel || firstModuleErrLabel
    const failedStderr = [modAndUnhandledCombined, ...failedErrorTexts].filter(Boolean).join("\n")
    return {
      summary: {
        _tag: "Exited",
        exitCode: 1,
        stdout: truncateOutput(
          ` FAIL  ${firstFailLabel}\nTests  ${failed} failed (${passed + failed})\n`,
        ),
        stderr: truncateOutput(failedStderr),
        ...(killingTestFile.length > 0 ? { killingTestFile } : {}),
      },
      cleanDurationsByTest: undefined,
    }
  }
  if (moduleAndUnhandledTexts.length > 0) {
    const killingTestFile = firstModuleErrLabel || firstFailModLabel
    return {
      summary: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: truncateOutput(modAndUnhandledCombined),
        ...(killingTestFile.length > 0 ? { killingTestFile } : {}),
      },
      cleanDurationsByTest: undefined,
    }
  }
  if (passed > 0) {
    return {
      summary: {
        _tag: "Exited",
        exitCode: 0,
        stdout: `Tests  ${passed} passed (${passed})\n`,
        stderr: "",
      },
      cleanDurationsByTest,
    }
  }
  return {
    summary: {
      _tag: "Exited",
      exitCode: 0,
      stdout: "Tests  0 passed (0)\n",
      stderr: "",
    },
    cleanDurationsByTest: undefined,
  }
}

const synthesizeExecResult = (specs, runRes) => synthesizeRunOutcome(specs, runRes).summary

const baseEnv = { ...process.env }

const applyRunEnv = (overrides) => {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(baseEnv, key)) delete process.env[key]
  }
  for (const [key, val] of Object.entries(baseEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  if (!Object.hasOwn(overrides, "HARNESS_COVERAGE_OUT_DIR")) {
    delete process.env["HARNESS_COVERAGE_OUT_DIR"]
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  Reflect.deleteProperty(globalThis, "__HARNESS_ACTIVE_MUTANT_ID")
  Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
}

const sendMsg = (msg) => {
  if (typeof process.send === "function") process.send(msg)
}

const attachCoverageSetup = (vitestInstance) => {
  if (coverageSetup.length === 0) return
  const resolvedSetup = resolve(coverageSetup)
  const appendIfMissing = (cfg) => {
    if (!cfg || typeof cfg !== "object") return
    if (!Array.isArray(cfg.setupFiles)) {
      cfg.setupFiles = [resolvedSetup]
    } else if (!cfg.setupFiles.includes(resolvedSetup)) {
      cfg.setupFiles.push(resolvedSetup)
    }
  }
  appendIfMissing(vitestInstance.config)
  for (const project of vitestInstance.projects ?? []) {
    appendIfMissing(project?.config)
  }
}

const absTests = rawTestFiles.map((f) => resolve(cwd, f))
const rootAndConfig = resolveCommonPackageConfig(cwd, absTests)
const { createVitest } = await import(pathToFileURL(vitestNodeEntry).href)

if (mode === "probe") {
  applyRunEnv({
    HARNESS_STATE_DIR: probeStateDir,
    HARNESS_COVERAGE_OUT_DIR: coverageOutDir,
  })
  let vitest
  try {
    vitest = await createVitest("test", {
      watch: false,
      run: true,
      bail: 0,
      maxWorkers: Math.min(8, Math.max(1, absTests.length)),
      pool: "threads",
      isolate: true,
      reporters: [],
      silent: true,
      fsModuleCache: true,
      fsModuleCachePath,
      ...rootAndConfig,
    })
    attachCoverageSetup(vitest)
    const specs = await vitest.globTestSpecifications(absTests)
    process.exitCode = 0
    const runRes = await vitest.runTestSpecifications(specs, true)
    process.exitCode = 0
    const summary = synthesizeExecResult(specs, runRes)
    const ok =
      specs.length === absTests.length &&
      summary.exitCode === 0 &&
      !/\bTests\s+0\s+passed\b/i.test(summary.stdout)
    const durationsByTest = {}
    for (const mod of runRes.testModules ?? []) {
      const diag = typeof mod.diagnostic === "function" ? mod.diagnostic() : undefined
      const ms =
        (typeof diag?.duration === "number" ? diag.duration : 0) +
        (typeof diag?.collectDuration === "number" ? diag.collectDuration : 0)
      durationsByTest[resolve(mod.moduleId || "")] = Math.max(1, Math.round(ms))
    }
    sendMsg({
      type: "probeDone",
      ok,
      ranModules: (runRes.testModules ?? []).length,
      summary,
      durationsByTest,
    })
  } finally {
    delete process.env["HARNESS_COVERAGE_OUT_DIR"]
    Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
    if (vitest) {
      try {
        await vitest.close()
      } catch {
        // Best-effort cleanup of probe Vitest instance
      }
    }
    process.exitCode = 0
  }
  process.exit(0)
}

const vitest = await createVitest("test", {
  watch: false,
  run: true,
  bail: 1,
  maxWorkers: 1,
  pool: "threads",
  isolate: warmIsolate,
  reporters: [],
  silent: true,
  fsModuleCache: true,
  fsModuleCachePath,
  ...rootAndConfig,
})
attachCoverageSetup(vitest)

const allSpecs = await vitest.globTestSpecifications(absTests)
const specByPath = new Map()
for (const spec of allSpecs) {
  specByPath.set(resolve(spec.moduleId), spec)
  specByPath.set(spec.moduleId, spec)
}

let queueChain = Promise.resolve()
let shuttingDown = false
let invalidateCallCount = 0

const resetVitestStateBeforeRun = () => {
  if (!vitest.state) return
  if (typeof vitest.state.clearErrors === "function") {
    vitest.state.clearErrors()
  }
  for (const key of ["filesMap", "pathsSet", "idMap", "errorsSet", "leakSet"]) {
    const collection = vitest.state[key]
    if (collection && typeof collection.clear === "function") {
      collection.clear()
    }
  }
}

const executeRunMessage = async (msg) => {
  const subsetFiles = Array.isArray(msg.testFiles) ? msg.testFiles : rawTestFiles
  const specs = []
  for (const tf of subsetFiles) {
    const spec = specByPath.get(resolve(cwd, tf)) ?? specByPath.get(tf)
    if (spec) specs.push(spec)
  }
  if (specs.length !== subsetFiles.length || specs.length === 0) {
    sendMsg({
      type: "result",
      id: msg.id,
      result: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: `[warm-vitest-worker] Missing test specification (${specs.length}/${subsetFiles.length})`,
      },
      invalidateCallCount,
    })
    return
  }
  const hasTestNamePattern =
    typeof msg.testNamePattern === "string" && msg.testNamePattern.length > 0
  try {
    applyRunEnv({
      HARNESS_ACTIVE_MUTANT_ID:
        typeof msg.id === "string" && msg.id.length > 0 ? msg.id : undefined,
      HARNESS_STATE_DIR: msg.stateDir,
    })
    if (hasTestNamePattern && typeof vitest.setGlobalTestNamePattern === "function") {
      vitest.setGlobalTestNamePattern(new RegExp(msg.testNamePattern))
    } else if (typeof vitest.resetGlobalTestNamePattern === "function") {
      vitest.resetGlobalTestNamePattern()
    }
    resetVitestStateBeforeRun()
    process.exitCode = 0
    let runRes
    try {
      runRes = await vitest.runTestSpecifications(specs, true)
    } finally {
      delete process.env["HARNESS_COVERAGE_OUT_DIR"]
      Reflect.deleteProperty(globalThis, "__HARNESS_ACTIVE_MUTANT_ID")
      Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
      if (typeof vitest.resetGlobalTestNamePattern === "function") {
        vitest.resetGlobalTestNamePattern()
      }
    }
    process.exitCode = 0
    const { summary, cleanDurationsByTest } = synthesizeRunOutcome(specs, runRes)
    sendMsg({
      type: "result",
      id: msg.id,
      result: summary,
      ...(!hasTestNamePattern &&
      cleanDurationsByTest !== undefined &&
      Object.keys(cleanDurationsByTest).length > 0
        ? { durationsByTest: cleanDurationsByTest }
        : {}),
      invalidateCallCount,
      rssBytes: process.memoryUsage().rss,
    })
  } catch (err) {
    process.exitCode = 0
    sendMsg({
      type: "result",
      id: msg.id,
      result: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: truncateOutput(formatErrorText(err)),
      },
      invalidateCallCount,
    })
  }
}

const executeProbeMessage = async (msg) => {
  try {
    const subsetFiles = Array.isArray(msg.testFiles) ? msg.testFiles : []
    const missingAbs = []
    for (const tf of subsetFiles) {
      const abs = resolve(cwd, tf)
      if (!specByPath.has(abs) && !specByPath.has(tf)) {
        missingAbs.push(abs)
      }
    }
    if (missingAbs.length > 0) {
      const extraSpecs = await vitest.globTestSpecifications(missingAbs)
      for (const spec of extraSpecs) {
        specByPath.set(resolve(spec.moduleId), spec)
        specByPath.set(spec.moduleId, spec)
      }
    }
    const specs = []
    for (const tf of subsetFiles) {
      const spec = specByPath.get(resolve(cwd, tf)) ?? specByPath.get(tf)
      if (spec) specs.push(spec)
    }
    if (specs.length !== subsetFiles.length || specs.length === 0) {
      sendMsg({
        type: "probeResult",
        reqId: msg.reqId,
        ok: false,
        error: `missing matching Vitest test specs (${specs.length}/${subsetFiles.length})`,
        durationsByTest: {},
        invalidateCallCount,
        rssBytes: process.memoryUsage().rss,
      })
      return
    }
    applyRunEnv({
      HARNESS_ACTIVE_MUTANT_ID: undefined,
      HARNESS_STATE_DIR: msg.stateDir,
      HARNESS_COVERAGE_OUT_DIR: msg.coverageOutDir,
    })
    if (typeof vitest.resetGlobalTestNamePattern === "function") {
      vitest.resetGlobalTestNamePattern()
    }
    resetVitestStateBeforeRun()
    process.exitCode = 0
    const runRes = await vitest.runTestSpecifications(specs, true)
    process.exitCode = 0
    const summary = synthesizeExecResult(specs, runRes)
    const ok =
      specs.length === subsetFiles.length &&
      summary.exitCode === 0 &&
      !/\bTests\s+0\s+passed\b/i.test(summary.stdout)
    const error = ok
      ? undefined
      : (summary.stderr.trim() || summary.stdout.trim() || `exitCode=${summary.exitCode}`)
          .slice(0, 300)
          .trim()
    const ranModuleIds = new Set(specs.map((s) => resolve(s.moduleId)))
    const durationsByTest = {}
    for (const mod of runRes.testModules ?? []) {
      const absMod = resolve(mod.moduleId || "")
      if (!ranModuleIds.has(absMod)) continue
      const diag = typeof mod.diagnostic === "function" ? mod.diagnostic() : undefined
      const rawMs =
        (typeof diag?.duration === "number" && Number.isFinite(diag.duration) ? diag.duration : 0) +
        (typeof diag?.collectDuration === "number" && Number.isFinite(diag.collectDuration)
          ? diag.collectDuration
          : 0)
      const ms = Math.max(1, Math.round(rawMs))
      durationsByTest[absMod] = ms
      const relMod = toRepoRelForwardSlash(mod.moduleId || "")
      if (relMod.length > 0 && relMod !== absMod) {
        durationsByTest[relMod] = ms
      }
    }
    sendMsg({
      type: "probeResult",
      reqId: msg.reqId,
      ok,
      ...(error !== undefined ? { error } : {}),
      durationsByTest,
      invalidateCallCount,
      rssBytes: process.memoryUsage().rss,
    })
  } catch (err) {
    process.exitCode = 0
    const rawErr = (err instanceof Error ? err.message : String(err)).trim()
    sendMsg({
      type: "probeResult",
      reqId: msg.reqId,
      ok: false,
      error: rawErr.slice(0, 300).trim() || "probe execution failed",
      durationsByTest: {},
      invalidateCallCount,
      rssBytes: process.memoryUsage().rss,
    })
  } finally {
    delete process.env["HARNESS_COVERAGE_OUT_DIR"]
    Reflect.deleteProperty(globalThis, "__HARNESS_ACTIVE_MUTANT_ID")
    Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
    if (typeof vitest.resetGlobalTestNamePattern === "function") {
      vitest.resetGlobalTestNamePattern()
    }
    process.exitCode = 0
  }
}

process.on("message", (rawMsg) => {
  if (typeof rawMsg !== "object" || rawMsg === null) return
  if (rawMsg.type === "shutdown") {
    shuttingDown = true
    queueChain = queueChain
      .then(async () => {
        try {
          await vitest.close()
        } catch {
          // Best-effort Vitest close
        }
        process.exitCode = 0
        process.exit(0)
      })
      .catch(() => {
        process.exitCode = 0
        process.exit(0)
      })
    return
  }
  if (rawMsg.type === "invalidate" && !shuttingDown) {
    const files = Array.isArray(rawMsg.files) ? rawMsg.files : []
    queueChain = queueChain
      .then(() => {
        try {
          for (const filePath of files) {
            if (
              typeof filePath === "string" &&
              filePath.length > 0 &&
              typeof vitest.invalidateFile === "function"
            ) {
              vitest.invalidateFile(resolve(cwd, filePath))
              invalidateCallCount += 1
            }
          }
          sendMsg({ type: "invalidated", reqId: rawMsg.reqId, ok: true, invalidateCallCount })
        } catch {
          sendMsg({ type: "invalidated", reqId: rawMsg.reqId, ok: false, invalidateCallCount })
        }
      })
      .catch(() => {})
    return
  }
  if (rawMsg.type === "probe" && !shuttingDown) {
    queueChain = queueChain.then(() => executeProbeMessage(rawMsg)).catch(() => {})
    return
  }
  if (rawMsg.type === "run" && !shuttingDown) {
    queueChain = queueChain.then(() => executeRunMessage(rawMsg)).catch(() => {})
  }
})

sendMsg({ type: "ready" })
