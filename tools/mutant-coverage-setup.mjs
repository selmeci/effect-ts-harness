import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, expect } from "vitest"

const isCoverageEnabled = () => {
  const outDir = process.env["HARNESS_COVERAGE_OUT_DIR"]
  return typeof outDir === "string" && outDir.length > 0
}

const moduleHits = new Set()
const perTestHits = []
let currentTestStartMs = 0
let activeTestHits = null
let activeDepth = 0
let concurrentOverlap = false

if (isCoverageEnabled()) {
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)
}

beforeEach(() => {
  if (!isCoverageEnabled()) return
  activeDepth += 1
  if (activeDepth > 1 || concurrentOverlap) {
    concurrentOverlap = true
    if (activeTestHits !== null) {
      for (const id of activeTestHits) moduleHits.add(id)
      activeTestHits = null
    }
    Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)
    return
  }
  activeTestHits = new Set()
  currentTestStartMs = performance.now()
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", activeTestHits)
})

afterEach(() => {
  if (!isCoverageEnabled()) return
  const durationMs = Math.max(0.1, performance.now() - currentTestStartMs)
  const testName = expect.getState().currentTestName
  const collected = activeTestHits
  activeTestHits = null
  if (activeDepth > 0) activeDepth -= 1
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)
  if (collected !== null) {
    for (const id of collected) moduleHits.add(id)
    if (
      !concurrentOverlap &&
      activeDepth === 0 &&
      typeof testName === "string" &&
      testName.length > 0 &&
      collected.size > 0
    ) {
      perTestHits.push({ testName, durationMs, hits: [...collected] })
    }
  }
  if (activeDepth === 0) {
    concurrentOverlap = false
  }
})

afterAll(() => {
  const outDir = process.env["HARNESS_COVERAGE_OUT_DIR"]
  if (typeof outDir !== "string" || outDir.length === 0) return
  try {
    const testPath = expect.getState().testPath
    if (typeof testPath === "string" && testPath.length > 0) {
      const outFile = join(outDir, `${process.pid}-${randomUUID()}.json`)
      writeFileSync(
        outFile,
        JSON.stringify({ testFile: testPath, hits: [...moduleHits], perTestHits }),
        "utf8",
      )
    }
  } finally {
    moduleHits.clear()
    perTestHits.length = 0
    activeTestHits = null
    activeDepth = 0
    concurrentOverlap = false
    Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
  }
})
