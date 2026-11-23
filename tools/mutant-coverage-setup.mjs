import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, expect } from "vitest"

const moduleHits = new Set()
const perTestHits = []
let currentTestStartMs = 0
let activeTestHits = null
Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)

beforeEach(() => {
  activeTestHits = new Set()
  currentTestStartMs = performance.now()
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", activeTestHits)
})

afterEach(() => {
  const durationMs = Math.max(0.1, performance.now() - currentTestStartMs)
  const testName = expect.getState().currentTestName
  const collected = activeTestHits
  activeTestHits = null
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)
  if (collected !== null) {
    for (const id of collected) moduleHits.add(id)
    if (typeof testName === "string" && testName.length > 0 && collected.size > 0) {
      perTestHits.push({ testName, durationMs, hits: [...collected] })
    }
  }
})

afterAll(() => {
  Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", moduleHits)
  const outDir = process.env["HARNESS_COVERAGE_OUT_DIR"]
  const testPath = expect.getState().testPath
  if (
    typeof outDir === "string" &&
    outDir.length > 0 &&
    typeof testPath === "string" &&
    testPath.length > 0
  ) {
    const outFile = join(outDir, `${process.pid}-${randomUUID()}.json`)
    writeFileSync(
      outFile,
      JSON.stringify({ testFile: testPath, hits: [...moduleHits], perTestHits }),
      "utf8",
    )
  }
})
