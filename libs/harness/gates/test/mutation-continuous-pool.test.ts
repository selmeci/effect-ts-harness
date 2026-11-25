import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { MUTATION_TEST_TIMINGS_SCHEMA_VERSION, computeContentSha256 } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  classifyMutantSubprocessResult,
  needsSoloColdRecheck,
} from "../src/mutation-subprocess-helpers.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import { writeMutationBackup } from "../src/mutation/mutation-backup.js"
import {
  cleanupStreamReportFile,
  readStreamedPackageBatchReports,
  writePackageBatchPlan,
} from "../src/mutation/mutation-batch-stream.js"
import {
  type PackageBatchFileResult,
  type QueuedPackageEntry,
  executeQueuedPackageBatches,
  runPackageMutantBatchChecked,
} from "../src/mutation/mutation-package-batch.js"
import type { DomainFile } from "../src/mutation/mutation-target-discovery.js"
import {
  createSuiteTimingsTracker,
  loadMutationTestTimings,
} from "../src/mutation/mutation-test-timings.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")

const makePkgRepo = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
  mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
  writeFileSync(
    join(dir, "libs", "demo", "core", "package.json"),
    JSON.stringify({ name: "@demo/core", nx: { tags: ["type:core"] } }),
    "utf8",
  )
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
  symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")
  return dir
}

const makeDomainFile = (root: string, relFile: string): DomainFile => ({
  scope: "demo",
  pkgDir: "core",
  pkgName: "@demo/core",
  tier: "core",
  fullPath: join(root, relFile),
  relFile,
})

const makeQueued = (
  dir: string,
  idx: number,
  body = `export const f${idx} = (n: number): number => n + 1\n`,
): QueuedPackageEntry => {
  const relFile = `libs/demo/core/src/f${idx}.ts`
  writeFileSync(join(dir, relFile), body, "utf8")
  const mutants = discoverDomainMutants(relFile, body)
  const mod = compileMutantSchemaModule(relFile, body, mutants)
  const testRel = `libs/demo/core/test/f${idx}.test.ts`
  return {
    pkgKey: "demo/core",
    mutantKeys: new Map(mutants.map((m) => [m.id, computeContentSha256(m.id)])),
    input: {
      file: makeDomainFile(dir, relFile),
      originalContent: body,
      schemaSource: mod.schemaSource,
      mutants,
      uncachedMutants: mutants,
      primaryTests: [testRel],
      scopedFallbackTests: [],
      packageFallbackTests: [],
      fallbackTests: [],
      cachedHitIds: new Set(),
    },
  }
}

const ProbeStatsOutputSchema = Schema.fromJsonString(
  Schema.Struct({
    inWorkerProbes: Schema.Finite,
    cachedProbes: Schema.Finite,
    coldProbes: Schema.Finite,
    observedKeys: Schema.Array(Schema.String),
  }),
)

const WorkerStatsOutputSchema = Schema.fromJsonString(
  Schema.Struct({
    afterInvalidate: Schema.Finite,
    afterRuns: Schema.Finite,
    exitCodes: Schema.Array(Schema.Finite),
  }),
)

const RssAndSignalOutputSchema = Schema.fromJsonString(
  Schema.Struct({
    recycledCount: Schema.Finite,
    workerMarkedRecycled: Schema.Boolean,
    signalResultTag: Schema.String,
    coldCalled: Schema.Finite,
  }),
)

describe("mutation-continuous-pool (SPEC-0034 Wave 2 integration)", () => {
  it("REQ-4.1 & REQ-1.5: runs 6-file package in 1 continuous batch and recovers streamed NDJSON reports on abort", () => {
    const dir = makePkgRepo("cont-batch-")
    const stderrLines: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const entries = [1, 2, 3, 4, 5, 6].map((i) => makeQueued(dir, i))
      const batchSizes: Array<number> = []
      const okIo: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {},
        execFileSync: (_cmd, _args, opts) => {
          const plan = JSON.parse(
            testHostIo.readTextSync(opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!),
          ) as {
            readonly files: ReadonlyArray<{
              readonly relFile: string
              readonly mutantIds: ReadonlyArray<string>
            }>
          }
          batchSizes.push(plan.files.length)
          const rows = plan.files.map((f) => ({
            relFile: f.relFile,
            primaryResults: f.mutantIds.map((id) => ({
              id,
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" },
            })),
            scopedFallbackResults: [],
            packageFallbackResults: [],
          }))
          return { _tag: "Exited", exitCode: 0, stdout: JSON.stringify(rows), stderr: "" }
        },
      }
      const finalizedOk: Array<string> = []
      let flushes = 0
      const okErr = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: okIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([["demo/core", entries]]),
        finalizeEntry: (entry) => {
          finalizedOk.push(entry.input.file.relFile)
          return undefined
        },
        recordPartialOnAbort: () => {},
        onBatchFlushed: () => {
          flushes += 1
        },
      })
      expect(okErr).toBeUndefined()
      expect(batchSizes).toEqual([6])
      expect(finalizedOk).toHaveLength(6)
      expect(flushes).toBe(1)
      expect(stderrLines.join("")).toContain(
        "[mutation-check] demo/core (6/6 files, 6 mutants) done in ",
      )

      // Mid-batch timeout writes 2 valid NDJSON reports + 1 trailing truncated line
      let capturedStreamPath = ""
      const abortIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, opts) => {
          const plan = JSON.parse(
            testHostIo.readTextSync(opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!),
          ) as { readonly streamReportPath: string }
          capturedStreamPath = plan.streamReportPath
          const lines = entries.slice(0, 2).map((e, idx) =>
            JSON.stringify({
              relFile: e.input.file.relFile,
              primaryResults: e.input.uncachedMutants.map((m) => ({
                id: m.id,
                result: { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" },
              })),
              scopedFallbackResults: [],
              packageFallbackResults: [],
              observedTestDurationsMs: { [e.input.primaryTests[0]!]: 42 + idx },
            }),
          )
          writeFileSync(
            capturedStreamPath,
            `${lines.join("\n")}\n{"relFile":"libs/demo/core/src/f3.ts","partial":`,
            "utf8",
          )
          return { _tag: "TimedOut", stdout: "", stderr: "" }
        },
      }
      const recoveredFiles: Array<string> = []
      const observedMap = new Map<string, number>()
      let abortFlushes = 0
      const abortErr = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: abortIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([["demo/core", entries]]),
        finalizeEntry: (entry, res) => {
          recoveredFiles.push(entry.input.file.relFile)
          expect(res.fileOutcomes.size).toBe(1)
          return undefined
        },
        recordPartialOnAbort: () => {},
        onObservedTestDurations: (_pkg, obs) => {
          for (const [k, v] of obs instanceof Map ? obs.entries() : Object.entries(obs)) {
            observedMap.set(k, v)
          }
        },
        onBatchFlushed: () => {
          abortFlushes += 1
        },
      })
      expect(abortErr).toContain("timed out")
      expect(recoveredFiles).toEqual(entries.slice(0, 2).map((e) => e.input.file.relFile))
      expect(observedMap.get("libs/demo/core/test/f1.test.ts")).toBe(42)
      expect(observedMap.get("libs/demo/core/test/f2.test.ts")).toBe(43)
      expect(abortFlushes).toBe(1)
      expect(existsSync(capturedStreamPath)).toBe(false)
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-4.2 & REQ-3.2: runs in-worker Stage 0 probe with probeCache hit and persists observedTestDurationsMs", () => {
    const dir = makePkgRepo("probe-timings-")
    try {
      const e1 = makeQueued(
        dir,
        1,
        "export const f1 = (n: number): number => n + 1\nexport const f1Surv = (n: number): number => n - 1\n",
      )
      const e2 = makeQueued(
        dir,
        2,
        "export const f2 = (n: number): number => n + 1\nexport const f2Surv = (n: number): number => n - 1\n",
      )
      writeFileSync(
        join(dir, e1.input.primaryTests[0]!),
        'import { expect, it } from "vitest"\nimport { f1 } from "../src/f1.js"\nit("f1", () => { expect(f1(2)).toBe(3) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, e2.input.primaryTests[0]!),
        'import { expect, it } from "vitest"\nimport { f2 } from "../src/f2.js"\nit("f2", () => { expect(f2(2)).toBe(3) })\n',
        "utf8",
      )

      const probeHarness = join(dir, "probe-harness.mjs")
      writeFileSync(
        probeHarness,
        [
          'import { join } from "node:path"',
          'import { createBatchTempTracker, createWarmVitestWorker, dedupCanonicalTests, runCoverageProbe } from "./tools/vitest-pool-helpers.mjs"',
          "const cwd = process.cwd()",
          'const vitestNodeEntry = join(cwd, "node_modules", "vitest", "dist", "node.js")',
          'const tests = ["libs/demo/core/test/f1.test.ts", "libs/demo/core/test/f2.test.ts"]',
          "const { testFiles, absToRaw } = dedupCanonicalTests(cwd, tests)",
          "const tracker = createBatchTempTracker()",
          "const workerRef = { current: await createWarmVitestWorker({ vitestNodeEntry, cwd, childBaseEnv: process.env, allTests: testFiles, tracker }) }",
          "const probeCache = new Map()",
          "const probeStats = { inWorkerProbes: 0, cachedProbes: 0, coldProbes: 0 }",
          "const spawnWorker = () => createWarmVitestWorker({ vitestNodeEntry, cwd, childBaseEnv: process.env, allTests: testFiles, tracker })",
          'const args = { vitestNodeEntry, cwd, childBaseEnv: process.env, testFiles, absToRaw, mutantCount: 4, minTests: 2, minMutants: 2, timeoutMs: 20000, tracker, workerRef, spawnWorker, probeCache, probeCacheKey: "k1", probeStats }',
          "const r1 = await runCoverageProbe(args)",
          "const r2 = await runCoverageProbe(args)",
          "if (workerRef.current) await workerRef.current.shutdown()",
          "tracker.cleanupAll()",
          "console.log(JSON.stringify({ inWorkerProbes: probeStats.inWorkerProbes, cachedProbes: probeStats.cachedProbes, coldProbes: probeStats.coldProbes, observedKeys: Object.keys(r1?.observedDurationsByTest ?? r2?.observedDurationsByTest ?? {}) }))",
        ].join("\n"),
        "utf8",
      )
      const probeExec = spawnSync(process.execPath, [probeHarness], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(probeExec.status, probeExec.stderr).toBe(0)
      const probeOut = Schema.decodeSync(ProbeStatsOutputSchema)(probeExec.stdout.trim())
      expect(probeOut.inWorkerProbes).toBe(1)
      expect(probeOut.cachedProbes).toBe(1)
      expect(probeOut.coldProbes).toBe(0)
      expect(probeOut.observedKeys).toContain("libs/demo/core/test/f1.test.ts")
      expect(probeOut.observedKeys).toContain("libs/demo/core/test/f2.test.ts")

      const tracker = createSuiteTimingsTracker(dir, isolatedTestHostIo)
      const err = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        queuedByPkg: new Map([["demo/core", [e1, e2]]]),
        finalizeEntry: (_entry, res: PackageBatchFileResult) => {
          const statuses = Array.from(res.fileOutcomes.values()).map((o) => o.status)
          expect(statuses).toContain("killed")
          expect(statuses).toContain("survived")
          return undefined
        },
        recordPartialOnAbort: () => {},
        onObservedTestDurations: (pkgKey, obs) => tracker.recordObserved(pkgKey, obs),
      })
      expect(err).toBeUndefined()
      tracker.flushIfDirty()
      const loaded = loadMutationTestTimings(dir, isolatedTestHostIo)
      expect(loaded.version).toBe(MUTATION_TEST_TIMINGS_SCHEMA_VERSION)
      expect(Object.keys(loaded.entries).length).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-4.3: keeps warm-vitest-worker invalidateCalls constant across multiple mutant runs on a fixed schema", () => {
    const dir = makePkgRepo("warm-inv-")
    try {
      const modRel = "libs/demo/core/src/calc.ts"
      const testRel = "libs/demo/core/test/calc.test.ts"
      const modAbs = join(dir, modRel)
      writeFileSync(
        modAbs,
        [
          'function __m(id) { return process.env["HARNESS_ACTIVE_MUTANT_ID"] === id }',
          'export const add = (n) => (__m("m1") ? n - 1 : n + 1)',
          'export const mul = (n) => (__m("m2") ? n + 2 : n * 2)',
          'export const unused = (n) => (__m("m3") ? n - 9 : n)',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        join(dir, testRel),
        'import { expect, it } from "vitest"\nimport { add, mul } from "../src/calc.js"\nit("calc", () => { expect(add(2)).toBe(3); expect(mul(3)).toBe(6) })\n',
        "utf8",
      )
      const harness = join(dir, "inv-harness.mjs")
      writeFileSync(
        harness,
        [
          'import { join } from "node:path"',
          'import { createBatchTempTracker, createWarmVitestWorker } from "./tools/vitest-pool-helpers.mjs"',
          "const cwd = process.cwd()",
          'const vitestNodeEntry = join(cwd, "node_modules", "vitest", "dist", "node.js")',
          "const tracker = createBatchTempTracker()",
          `const worker = await createWarmVitestWorker({ vitestNodeEntry, cwd, childBaseEnv: process.env, allTests: [${JSON.stringify(testRel)}], tracker })`,
          `await worker.invalidateFiles([${JSON.stringify(modAbs)}])`,
          "const afterInvalidate = worker.getStats().invalidateCalls",
          "const exitCodes = []",
          'for (const id of ["m1", "m2", "m3"]) {',
          `  const r = await worker.runSubset(id, [${JSON.stringify(testRel)}], 20000)`,
          "  exitCodes.push(r.exitCode)",
          "}",
          "const afterRuns = worker.getStats().invalidateCalls",
          "await worker.shutdown()",
          "tracker.cleanupAll()",
          "console.log(JSON.stringify({ afterInvalidate, afterRuns, exitCodes }))",
        ].join("\n"),
        "utf8",
      )
      const res = spawnSync(process.execPath, [harness], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(res.status, res.stderr).toBe(0)
      const parsed = Schema.decodeSync(WorkerStatsOutputSchema)(res.stdout.trim())
      expect(parsed.afterInvalidate).toBe(1)
      expect(parsed.afterRuns).toBe(1)
      expect(parsed.exitCodes).toEqual([1, 1, 0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 45_000)

  it("REQ-4.4: recycles warm worker on maxWorkerRssBytes, fails closed on Signaled, and solo-confirms ambiguous exits", () => {
    const dir = makePkgRepo("rss-signal-")
    try {
      const src = "export const calc = (n: number): number => n + 1\n"
      const relFile = "libs/demo/core/src/calc.ts"
      const testRel = "libs/demo/core/test/calc.test.ts"
      writeFileSync(join(dir, relFile), src, "utf8")
      writeFileSync(
        join(dir, testRel),
        'import { expect, it } from "vitest"\nimport { calc } from "../src/calc.js"\nit("calc", () => { expect(calc(1)).toBe(2) })\n',
        "utf8",
      )
      const harness = join(dir, "rss-signal-harness.mjs")
      writeFileSync(
        harness,
        [
          'import { join } from "node:path"',
          'import { createBatchTempTracker, createWarmVitestWorker, runWarmMutantWithWorker } from "./tools/vitest-pool-helpers.mjs"',
          "const cwd = process.cwd()",
          'const vitestNodeEntry = join(cwd, "node_modules", "vitest", "dist", "node.js")',
          "const tracker = createBatchTempTracker()",
          "let recycledCount = 0",
          "let workerMarkedRecycled = false",
          "let coldCalled = 0",
          `const spawnWorker = () => createWarmVitestWorker({ vitestNodeEntry, cwd, childBaseEnv: process.env, allTests: [${JSON.stringify(testRel)}], tracker, maxWorkerRssBytes: 1 })`,
          "const workerRef = { current: await spawnWorker() }",
          "const coldFallback = async () => { coldCalled += 1; return { id: 'x', result: { _tag: 'Exited', exitCode: 0, stdout: 'Tests 1 passed (1)\\n', stderr: '' } } }",
          `await runWarmMutantWithWorker({ workerRef, spawnWorker, coldFallback, mutantId: "m-rss", targetTests: [${JSON.stringify(testRel)}], coverageInfo: null, timeoutMs: 20000, cwd, onRecycle: () => { recycledCount += 1 } })`,
          "const sigWorker = { isAlive: () => true, shouldRecycle: () => false, runSubset: async () => ({ _tag: 'Signaled', signal: 'SIGKILL', stdout: '', stderr: '' }), shutdown: async () => {}, getStats: () => ({ rssBytes: 0, invalidateCalls: 0, recycled: false }) }",
          "const sigRef = { current: sigWorker }",
          `const sigOut = await runWarmMutantWithWorker({ workerRef: sigRef, spawnWorker: async () => sigWorker, coldFallback, mutantId: "m-sig", targetTests: [${JSON.stringify(testRel)}], coverageInfo: null, timeoutMs: 20000, cwd })`,
          "const w2 = await spawnWorker()",
          `await w2.runSubset("m2", [${JSON.stringify(testRel)}], 20000)`,
          "await w2.shutdown()",
          "workerMarkedRecycled = w2.getStats().recycled",
          "tracker.cleanupAll()",
          "console.log(JSON.stringify({ recycledCount, workerMarkedRecycled, signalResultTag: sigOut.result._tag, coldCalled }))",
        ].join("\n"),
        "utf8",
      )
      const execOut = spawnSync(process.execPath, [harness], {
        cwd: dir,
        encoding: "utf8",
        timeout: 45_000,
      })
      expect(execOut.status, execOut.stderr).toBe(0)
      const parsed = Schema.decodeSync(RssAndSignalOutputSchema)(execOut.stdout.trim())
      expect(parsed.recycledCount).toBeGreaterThanOrEqual(1)
      expect(parsed.workerMarkedRecycled).toBe(true)
      expect(parsed.signalResultTag).toBe("Signaled")
      expect(parsed.coldCalled).toBe(0)

      // Batch outcome mapper: Signaled fails closed (Abort, no solo fallback); ambiguous Exited(1) triggers solo confirmation
      const mutants = discoverDomainMutants(relFile, src)
      const mod = compileMutantSchemaModule(relFile, src, mutants)
      let soloCalls = 0
      const makeMockIo = (mode: "signaled" | "ambiguous"): SyncHostIo => ({
        ...testHostIo,
        unlinkSync: () => {},
        execFileSync: (_cmd, args) => {
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile,
                  primaryResults: [
                    {
                      id: mutants[0]!.id,
                      result:
                        mode === "signaled"
                          ? { _tag: "Signaled", signal: "SIGKILL", stdout: "", stderr: "" }
                          : { _tag: "Exited", exitCode: 1, stdout: "no clear line", stderr: "" },
                    },
                  ],
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          soloCalls += 1
          return { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      })
      const sigBatch = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: makeMockIo("signaled"),
        baseSubprocessEnv: {},
        allPackageTests: [testRel],
        files: [
          {
            file: makeDomainFile(dir, relFile),
            originalContent: src,
            schemaSource: mod.schemaSource,
            mutants,
            uncachedMutants: mutants,
            primaryTests: [testRel],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
        ],
      })
      expect(sigBatch._tag).toBe("Abort")
      expect(soloCalls).toBe(0)

      const ambigBatch = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: makeMockIo("ambiguous"),
        baseSubprocessEnv: {},
        allPackageTests: [testRel],
        files: [
          {
            file: makeDomainFile(dir, relFile),
            originalContent: src,
            schemaSource: mod.schemaSource,
            mutants,
            uncachedMutants: mutants,
            primaryTests: [testRel],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
        ],
      })
      expect(ambigBatch._tag).toBe("Ok")
      expect(soloCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-2.1: stops early at maxSurvivors across files and restores all source files cleanly", () => {
    const dir = makePkgRepo("early-isolate-")
    try {
      const f1Src = [
        "export const TOP_CONST = 10 + 1",
        "export const f1Surv = (n: number): number => n + 1",
      ].join("\n")
      const f2Src = "export const f2 = (n: number): number => n + 2\n"
      const f3Src = "export const f3 = (n: number): number => n + 3\n"
      const f1Rel = "libs/demo/core/src/f1.ts"
      const f2Rel = "libs/demo/core/src/f2.ts"
      const f3Rel = "libs/demo/core/src/f3.ts"
      writeFileSync(join(dir, f1Rel), f1Src, "utf8")
      writeFileSync(join(dir, f2Rel), f2Src, "utf8")
      writeFileSync(join(dir, f3Rel), f3Src, "utf8")
      const t1 = "libs/demo/core/test/f1.test.ts"
      const t2 = "libs/demo/core/test/f2.test.ts"
      const t3 = "libs/demo/core/test/f3.test.ts"
      writeFileSync(
        join(dir, t1),
        'import { expect, it } from "vitest"\nimport { TOP_CONST, f1Surv } from "../src/f1.js"\nit("kills top only", () => { expect(TOP_CONST).toBe(11); expect(typeof f1Surv).toBe("function") })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, t2),
        'import { expect, it } from "vitest"\nimport { f2 } from "../src/f2.js"\nit("f2", () => { expect(f2(1)).toBe(3) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, t3),
        'import { expect, it } from "vitest"\nimport { f3 } from "../src/f3.js"\nit("f3", () => { expect(f3(1)).toBe(4) })\n',
        "utf8",
      )

      const makeInput = (relFile: string, src: string, testRel: string) => {
        const mutants = discoverDomainMutants(relFile, src)
        const mod = compileMutantSchemaModule(relFile, src, mutants)
        return {
          file: makeDomainFile(dir, relFile),
          originalContent: src,
          schemaSource: mod.schemaSource,
          mutants,
          uncachedMutants: mutants,
          primaryTests: [testRel],
          scopedFallbackTests: [],
          packageFallbackTests: [],
          fallbackTests: [],
          cachedHitIds: new Set<string>(),
        }
      }

      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: testHostIo,
        baseSubprocessEnv: {
          ...process.env,
          HARNESS_MUTATE_WARM_ISOLATE: "0",
          HARNESS_WARM_ISOLATE: "0",
        },
        allPackageTests: [t1, t2, t3],
        files: [
          makeInput(f1Rel, f1Src, t1),
          makeInput(f2Rel, f2Src, t2),
          makeInput(f3Rel, f3Src, t3),
        ],
        maxSurvivors: 1,
      })

      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected early-stopped Ok, got Abort: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults).toHaveLength(1)
          expect(fileResults[0]!.file.relFile).toBe(f1Rel)
          const statuses = Array.from(fileResults[0]!.fileOutcomes.values()).map((o) => o.status)
          expect(statuses).toContain("killed")
          expect(statuses).toContain("survived")
        })
        .exhaustive()

      expect(readFileSync(join(dir, f1Rel), "utf8")).toBe(f1Src)
      expect(readFileSync(join(dir, f2Rel), "utf8")).toBe(f2Src)
      expect(readFileSync(join(dir, f3Rel), "utf8")).toBe(f3Src)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-4.4 & REQ-1.5: recovers leftover backupPath before TimedOut solo confirmation and aborts without solo rechecks on unrecoverable backup", () => {
    const dir = makePkgRepo("backup-solo-")
    try {
      const src = "export const calc = (n: number): number => n + 1\n"
      const relFile = "libs/demo/core/src/calc.ts"
      const testRel = "libs/demo/core/test/calc.test.ts"
      const fullPath = join(dir, relFile)
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      writeFileSync(fullPath, src, "utf8")
      writeFileSync(
        join(dir, testRel),
        'import { expect, it } from "vitest"\nimport { calc } from "../src/calc.js"\nit("calc", () => { expect(calc(1)).toBe(2) })\n',
        "utf8",
      )
      const mutants = discoverDomainMutants(relFile, src)
      const mod = compileMutantSchemaModule(relFile, src, mutants)
      const fileInput = {
        file: makeDomainFile(dir, relFile),
        originalContent: src,
        schemaSource: mod.schemaSource,
        mutants,
        uncachedMutants: mutants,
        primaryTests: [testRel],
        scopedFallbackTests: [],
        packageFallbackTests: [],
        fallbackTests: [],
        cachedHitIds: new Set<string>(),
      }

      // 1. Batch runner crashes after leaving mutated file + backupPath on disk, returning TimedOut mutant
      let soloSawOriginalBeforeMutate = false
      let soloCalls = 0
      const events: Array<string> = []
      const recoverFirstIo: SyncHostIo = {
        ...testHostIo,
        unlinkSync: (p) => {
          if (p === backupPath) events.push("unlink-backup")
          testHostIo.unlinkSync(p)
        },
        writeTextSync: (p, content) => {
          if (p === fullPath && content === mod.schemaSource) {
            soloSawOriginalBeforeMutate = readFileSync(fullPath, "utf8") === src
            events.push("solo-write-schema")
          }
          testHostIo.writeTextSync(p, content)
        },
        execFileSync: (_cmd, args) => {
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            const err = writeMutationBackup(
              dir,
              backupPath,
              relFile,
              src,
              mod.schemaSource,
              testHostIo,
            )
            expect(err).toBeUndefined()
            writeFileSync(fullPath, mod.schemaSource, "utf8")
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile,
                  primaryResults: mutants.map((m) => ({
                    id: m.id,
                    result: { _tag: "TimedOut", stdout: "", stderr: "" },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          soloCalls += 1
          return { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      }
      const recoveredRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: recoverFirstIo,
        baseSubprocessEnv: {},
        allPackageTests: [testRel],
        files: [fileInput],
      })
      expect(recoveredRes._tag).toBe("Ok")
      expect(soloCalls).toBe(1)
      expect(soloSawOriginalBeforeMutate).toBe(true)
      expect(events.slice(0, 2)).toEqual(["unlink-backup", "solo-write-schema"])
      expect(existsSync(backupPath)).toBe(false)
      expect(readFileSync(fullPath, "utf8")).toBe(src)

      // 2. Unrecoverable backup (external edit mismatch) aborts immediately with ZERO solo rechecks
      soloCalls = 0
      const unrecoverableIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            writeMutationBackup(dir, backupPath, relFile, src, mod.schemaSource, testHostIo)
            writeFileSync(fullPath, "// external user edit\n", "utf8")
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile,
                  primaryResults: mutants.map((m) => ({
                    id: m.id,
                    result: { _tag: "TimedOut", stdout: "", stderr: "" },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          soloCalls += 1
          return { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      }
      const abortRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: unrecoverableIo,
        baseSubprocessEnv: {},
        allPackageTests: [testRel],
        files: [fileInput],
      })
      match(abortRes)
        .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort on unrecoverable backup"))
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("CRITICAL")
        })
        .exhaustive()
      expect(soloCalls).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-5.3 & REQ-3.2: isolate:true prevents false kills from module-level Set leakage on surviving mutants and measuredDurationsMs >= 2000 gates Stage B", () => {
    const dir = makePkgRepo("iso-stage-b-")
    try {
      const cacheModRel = "libs/demo/core/src/mod-cache.ts"
      const targetRel = "libs/demo/core/src/target.ts"
      const target2Rel = "libs/demo/core/src/target2.ts"
      const tFast = "libs/demo/core/test/fast.test.ts"
      const tFast2 = "libs/demo/core/test/fast2.test.ts"
      const tSlow = "libs/demo/core/test/a-dynamic-heavy.test.ts"
      const slowMarker = join(dir, "slow-ran.txt")
      writeFileSync(
        join(dir, cacheModRel),
        [
          "const seen = new Set<string>()",
          "export const checkOnce = (k: string): boolean => {",
          "  const existed = seen.has(k)",
          "  seen.add(k)",
          "  return existed",
          "}",
        ].join("\n"),
        "utf8",
      )
      const targetSrc = [
        "export const evalA = (n: number): number => n + 1",
        "export const evalUncovered = (n: number): number => n - 1",
      ].join("\n")
      const target2Src = "export const evalC = (n: number): number => n + 5\n"
      writeFileSync(join(dir, targetRel), targetSrc, "utf8")
      writeFileSync(join(dir, target2Rel), target2Src, "utf8")
      writeFileSync(
        join(dir, tFast),
        [
          'import { expect, it } from "vitest"',
          'import { checkOnce } from "../src/mod-cache.js"',
          'import { evalA, evalUncovered } from "../src/target.js"',
          'it("fresh module cache per mutant", () => {',
          '  expect(checkOnce("a")).toBe(false)',
          "  expect(evalA(2)).toBe(3)",
          '  expect(typeof evalUncovered).toBe("function")',
          "})",
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        join(dir, tFast2),
        [
          'import { expect, it } from "vitest"',
          'import { evalC } from "../src/target2.js"',
          'it("kills evalC", () => { expect(evalC(1)).toBe(6) })',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        join(dir, tSlow),
        [
          'import { writeFileSync } from "node:fs"',
          'import { expect, it } from "vitest"',
          'import { evalC } from "../src/target2.js"',
          `it("dynamic heavy", () => { writeFileSync(${JSON.stringify(slowMarker)}, "ran"); expect(evalC(1)).toBe(6) })`,
        ].join("\n"),
        "utf8",
      )

      const mutants1 = discoverDomainMutants(targetRel, targetSrc)
      const mod1 = compileMutantSchemaModule(targetRel, targetSrc, mutants1)
      const mutants2 = discoverDomainMutants(target2Rel, target2Src)
      const mod2 = compileMutantSchemaModule(target2Rel, target2Src, mutants2)
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: testHostIo,
        baseSubprocessEnv: {
          ...process.env,
          HARNESS_MUTATE_WARM_ISOLATE: "0",
          HARNESS_WARM_ISOLATE: "0",
          HARNESS_MUTATE_CONCURRENCY: "1",
        },
        allPackageTests: [tFast, tFast2, tSlow],
        files: [
          {
            file: makeDomainFile(dir, targetRel),
            originalContent: targetSrc,
            schemaSource: mod1.schemaSource,
            mutants: mutants1,
            uncachedMutants: mutants1,
            primaryTests: [tFast],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
          {
            file: makeDomainFile(dir, target2Rel),
            originalContent: target2Src,
            schemaSource: mod2.schemaSource,
            mutants: mutants2,
            uncachedMutants: mutants2,
            primaryTests: [tFast2, tSlow],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
        ],
        measuredDurationsMs: { [tFast]: 10, [tFast2]: 10, [tSlow]: 2500 },
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => expect.unreachable(diagnostic))
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults).toHaveLength(2)
          const r1Outcomes = Array.from(fileResults[0]!.fileOutcomes.values())
          const killed1 = r1Outcomes.filter((o) => o.status === "killed")
          const survived1 = r1Outcomes.filter((o) => o.status === "survived")
          expect(killed1.length).toBeGreaterThanOrEqual(1)
          expect(survived1.length).toBeGreaterThanOrEqual(1)
          const r2Statuses = Array.from(fileResults[1]!.fileOutcomes.values()).map((o) => o.status)
          expect(r2Statuses.every((s) => s === "killed")).toBe(true)
        })
        .exhaustive()
      expect(existsSync(slowMarker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-2.1 & Batch Security: scopes equivalencePriors budget per package and rejects symlinked batch dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "scoped-eq-"))
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      mkdirSync(join(dir, "tools"), { recursive: true })
      mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true })
      writeFileSync(join(dir, "tools", "package-vitest-batch.mjs"), "// batch\n")
      writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "core", "package.json"),
        JSON.stringify({ name: "@demo/core", nx: { tags: ["type:core"] } }),
      )
      for (const n of [1, 2]) {
        writeFileSync(
          join(dir, "libs", "demo", "core", "src", `f${n}.ts`),
          `export const fn${n} = (a: number): number => a + 1\n`,
        )
        writeFileSync(
          join(dir, "libs", "demo", "core", "test", `f${n}.test.ts`),
          `import { expect, it } from "vitest"\nimport { fn${n} } from "../src/f${n}.js"\nit("ok", () => { expect(fn${n}(1)).toBe(2) })\n`,
        )
      }

      let capturedMaxSurvivors: number | undefined
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") {
            return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "not a git repository" }
          }
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            const plan = JSON.parse(
              isolatedTestHostIo.readTextSync(opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!),
            ) as {
              readonly maxSurvivors?: number
              readonly files: ReadonlyArray<{
                readonly relFile: string
                readonly mutantIds: ReadonlyArray<string>
              }>
            }
            capturedMaxSurvivors = plan.maxSurvivors
            const f0 = plan.files[0]!
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: f0.relFile,
                  primaryResults: f0.mutantIds.map((id) => ({
                    id,
                    result: {
                      _tag: "Exited",
                      exitCode: 0,
                      stdout: "Tests 1 passed (1)\n",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
        },
      }
      const report = runDomainMutationSuite(dir, mockIo, {
        includeAllLines: true,
        maxSurvivors: 1,
        equivalencePriors: { "unrelated/pkg/src/x.ts:1:+->-": 990 },
      })
      expect(report.earlyTerminated).toBe(true)
      expect(capturedMaxSurvivors).toBe(1)

      // Symlinked .harness directory is rejected by writePackageBatchPlan / readStreamedPackageBatchReports / cleanupStreamReportFile
      const outsideDir = mkdtempSync(join(tmpdir(), "sym-outside-"))
      try {
        const symHarness = join(dir, ".harness")
        rmSync(symHarness, { recursive: true, force: true })
        symlinkSync(outsideDir, symHarness)
        const planRes = writePackageBatchPlan({
          repoRoot: dir,
          backupPath: join(symHarness, "mutation-backup.json"),
          vitestCliPath: join(dir, "node_modules", "vitest", "vitest.mjs"),
          hostIo: isolatedTestHostIo,
          allPackageTests: [],
          files: [],
        })
        expect(planRes._tag).toBe("Err")
        const outsideStream = join(outsideDir, "stream.ndjson")
        writeFileSync(outsideStream, "{}\n", "utf8")
        expect(
          readStreamedPackageBatchReports(
            join(symHarness, "stream.ndjson"),
            isolatedTestHostIo,
            dir,
          ),
        ).toEqual([])
        cleanupStreamReportFile(join(symHarness, "stream.ndjson"), isolatedTestHostIo, dir)
        expect(existsSync(outsideStream)).toBe(true)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("#2: executeQueuedPackageBatches returns Abort diagnostic when Ok finishes with processedCount < queuedEntries.length and isEarlyStopped() !== true", () => {
    const dir = makePkgRepo("short-ok-")
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const e1 = makeQueued(dir, 1)
      const e2 = makeQueued(dir, 2)
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (_cmd, args) => {
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: e1.input.file.relFile,
                  primaryResults: e1.input.uncachedMutants.map((m) => ({
                    id: m.id,
                    result: {
                      _tag: "Exited",
                      exitCode: 0,
                      stdout: "Tests 1 passed (1)\n",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
        },
      }
      const finalized: Array<string> = []
      const diag = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([["demo/core", [e1, e2]]]),
        finalizeEntry: (entry) => {
          finalized.push(entry.input.file.relFile)
          return undefined
        },
        recordPartialOnAbort: () => {},
        getRemainingSurvivorBudget: () => 1,
        isEarlyStopped: () => false,
      })
      expect(finalized).toEqual([e1.input.file.relFile])
      expect(diag).toContain("completed only 1/2 queued file(s) without hitting survivor limit")
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("#4: module/unhandled error in warm-vitest-worker yields 0 failed tests (stdout: ''), needsSoloColdRecheck=true, and classifyMutantSubprocessResult returns abort (not killed)", () => {
    const unitModErr = {
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "Error: module eval boom",
    } as const
    expect(needsSoloColdRecheck(unitModErr)).toBe(true)
    const classified = classifyMutantSubprocessResult("m-mod-err", Result.succeed(unitModErr))
    match(classified)
      .with({ kind: "abort" }, ({ diagnostic }) => {
        expect(diagnostic).toContain("missingVitestFailureEvidence=true")
      })
      .with({ kind: "outcome" }, ({ status }) => {
        expect.unreachable(`Expected abort, got outcome=${status}`)
      })
      .exhaustive()

    const dir = makePkgRepo("warm-mod-err-")
    try {
      const testRel = "libs/demo/core/test/mod-err.test.ts"
      writeFileSync(
        join(dir, testRel),
        [
          'import { expect, it } from "vitest"',
          'if (process.env["HARNESS_ACTIVE_MUTANT_ID"] === "m-mod-err") {',
          '  throw new Error("module-load-boom")',
          "}",
          'it("ok", () => { expect(1).toBe(1) })',
        ].join("\n"),
        "utf8",
      )
      const WarmModErrOutputSchema = Schema.fromJsonString(
        Schema.Struct({
          _tag: Schema.String,
          exitCode: Schema.Finite,
          stdout: Schema.String,
          stderr: Schema.String,
        }),
      )
      const harness = join(dir, "mod-err-harness.mjs")
      writeFileSync(
        harness,
        [
          'import { join } from "node:path"',
          'import { createBatchTempTracker, createWarmVitestWorker } from "./tools/vitest-pool-helpers.mjs"',
          "const cwd = process.cwd()",
          'const vitestNodeEntry = join(cwd, "node_modules", "vitest", "dist", "node.js")',
          "const tracker = createBatchTempTracker()",
          `const worker = await createWarmVitestWorker({ vitestNodeEntry, cwd, childBaseEnv: process.env, allTests: [${JSON.stringify(testRel)}], tracker })`,
          `const res = await worker.runSubset("m-mod-err", [${JSON.stringify(testRel)}], 20000)`,
          "await worker.shutdown()",
          "tracker.cleanupAll()",
          "console.log(JSON.stringify(res))",
        ].join("\n"),
        "utf8",
      )
      const execOut = spawnSync(process.execPath, [harness], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(execOut.status, execOut.stderr).toBe(0)
      const workerRes = Schema.decodeSync(WarmModErrOutputSchema)(execOut.stdout.trim())
      expect(workerRes._tag).toBe("Exited")
      expect(workerRes.exitCode).toBe(1)
      expect(workerRes.stdout).toBe("")
      expect(workerRes.stderr).toContain("module-load-boom")
      const mapped = {
        _tag: "Exited" as const,
        exitCode: workerRes.exitCode,
        stdout: workerRes.stdout,
        stderr: workerRes.stderr,
      }
      expect(needsSoloColdRecheck(mapped)).toBe(true)
      expect(classifyMutantSubprocessResult("m-mod-err", Result.succeed(mapped)).kind).toBe("abort")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 45_000)

  it("#8: readStreamedPackageBatchReports ignores trailing truncated line, warns+skips mid-stream malformed line, recovers valid v1 reports, and rejects schemaVersion 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-ndjson-"))
    const stderrLines: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const streamPath = join(dir, ".harness", "pkg-stream.ndjson")
      mkdirSync(join(dir, ".harness"), { recursive: true })
      const valid1 = JSON.stringify({
        schemaVersion: 1,
        relFile: "libs/demo/core/src/a.ts",
        primaryResults: [],
        scopedFallbackResults: [],
        packageFallbackResults: [],
      })
      const invalidV2 = JSON.stringify({
        schemaVersion: 2,
        relFile: "libs/demo/core/src/v2.ts",
        primaryResults: [],
        scopedFallbackResults: [],
        packageFallbackResults: [],
      })
      const valid2 = JSON.stringify({
        schemaVersion: 1,
        relFile: "libs/demo/core/src/b.ts",
        primaryResults: [],
        scopedFallbackResults: [],
        packageFallbackResults: [],
      })
      writeFileSync(
        streamPath,
        [valid1, "{malformed-mid-line", invalidV2, valid2, '{"relFile":"truncated"'].join("\n"),
        "utf8",
      )
      const parsed = readStreamedPackageBatchReports(streamPath, isolatedTestHostIo, dir)
      expect(parsed.map((r) => r.relFile)).toEqual([
        "libs/demo/core/src/a.ts",
        "libs/demo/core/src/b.ts",
      ])
      const warnings = stderrLines.join("")
      expect(warnings).toContain("Skipping malformed NDJSON batch line 2/5")
      expect(warnings).toContain("Skipping malformed NDJSON batch line 3/5")
      expect(warnings).not.toContain("5/5")
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-4.4: runCoverageProbe failure falls back cleanly and runWarmMutantWithWorker handles TimedOut, Signaled, Exited, and SpawnFailed->coldFallback", async () => {
    const dir = makePkgRepo("warm-tags-")
    try {
      const testRel = "libs/demo/core/test/calc.test.ts"
      writeFileSync(
        join(dir, testRel),
        'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
        "utf8",
      )
      const WarmBranchesSchema = Schema.fromJsonString(
        Schema.Struct({
          probeNullOnFail: Schema.Boolean,
          timedOutTag: Schema.String,
          timedOutClearedRef: Schema.Boolean,
          signaledTag: Schema.String,
          signaledClearedRef: Schema.Boolean,
          exitedCode: Schema.Finite,
          exitedKeptRef: Schema.Boolean,
          spawnFailFallbackCalls: Schema.Finite,
          spawnFailExitCode: Schema.Finite,
          coldFallbackTotal: Schema.Finite,
        }),
      )
      const harness = join(dir, "warm-branches-harness.mjs")
      writeFileSync(
        harness,
        [
          'import { createBatchTempTracker, runCoverageProbe, runWarmMutantWithWorker } from "./tools/vitest-pool-helpers.mjs"',
          "const cwd = process.cwd()",
          "const tracker = createBatchTempTracker()",
          "const absToRaw = new Map([[`${cwd}/a.test.ts`, 'a.test.ts'], [`${cwd}/b.test.ts`, 'b.test.ts']])",
          "let coldFallbackTotal = 0",
          "const coldFallback = async (id) => {",
          "  coldFallbackTotal += 1",
          "  return { id, result: { _tag: 'Exited', exitCode: 1, stdout: 'Tests 1 failed (1)\\n', stderr: '' } }",
          "}",
          "const failingProbeWorker = { isAlive: () => true, runProbe: async () => ({ ok: false, error: 'probe boom', durationsByTest: {} }), shutdown: async () => {} }",
          "const probeRes = await runCoverageProbe({",
          "  vitestNodeEntry: '', cwd, childBaseEnv: process.env,",
          "  testFiles: ['a.test.ts', 'b.test.ts'], absToRaw, mutantCount: 4, minTests: 2, minMutants: 4,",
          "  timeoutMs: 5000, tracker, workerRef: { current: failingProbeWorker }, spawnWorker: async () => failingProbeWorker",
          "})",
          "const throwingProbeWorker = { isAlive: () => true, runProbe: async () => { throw new Error('probe throw') }, shutdown: async () => {} }",
          "const probeThrowRes = await runCoverageProbe({",
          "  vitestNodeEntry: '', cwd, childBaseEnv: process.env,",
          "  testFiles: ['a.test.ts', 'b.test.ts'], absToRaw, mutantCount: 4, minTests: 2, minMutants: 4,",
          "  timeoutMs: 5000, tracker, workerRef: { current: throwingProbeWorker }, spawnWorker: async () => throwingProbeWorker",
          "})",
          "const mkWorker = (result) => ({",
          "  isAlive: () => true, shouldRecycle: () => false,",
          "  runSubset: async () => result,",
          "  shutdown: async () => {},",
          "})",
          "const refTo = { current: mkWorker({ _tag: 'TimedOut', stdout: '', stderr: '' }) }",
          "const outTo = await runWarmMutantWithWorker({ workerRef: refTo, spawnWorker: async () => refTo.current, coldFallback, mutantId: 'm-to', targetTests: ['a.test.ts'], coverageInfo: null, timeoutMs: 1000, cwd })",
          "const refSig = { current: mkWorker({ _tag: 'Signaled', signal: 'SIGTERM', stdout: '', stderr: '' }) }",
          "const outSig = await runWarmMutantWithWorker({ workerRef: refSig, spawnWorker: async () => refSig.current, coldFallback, mutantId: 'm-sig', targetTests: ['a.test.ts'], coverageInfo: null, timeoutMs: 1000, cwd })",
          "const refEx = { current: mkWorker({ _tag: 'Exited', exitCode: 1, stdout: 'Tests 1 failed (1)\\n', stderr: '' }) }",
          "const outEx = await runWarmMutantWithWorker({ workerRef: refEx, spawnWorker: async () => refEx.current, coldFallback, mutantId: 'm-ex', targetTests: ['a.test.ts'], coverageInfo: null, timeoutMs: 1000, cwd })",
          "const coldCallsBeforeSpawnFail = coldFallbackTotal",
          "const refSf = { current: mkWorker({ _tag: 'SpawnFailed', spawnError: 'ipc closed', stdout: '', stderr: '' }) }",
          "const outSf = await runWarmMutantWithWorker({ workerRef: refSf, spawnWorker: async () => refSf.current, coldFallback, mutantId: 'm-sf', targetTests: ['a.test.ts'], coverageInfo: null, timeoutMs: 1000, cwd })",
          "tracker.cleanupAll()",
          "console.log(JSON.stringify({",
          "  probeNullOnFail: probeRes === null && probeThrowRes === null,",
          "  timedOutTag: outTo.result._tag,",
          "  timedOutClearedRef: refTo.current === null,",
          "  signaledTag: outSig.result._tag,",
          "  signaledClearedRef: refSig.current === null,",
          "  exitedCode: outEx.result.exitCode,",
          "  exitedKeptRef: refEx.current !== null,",
          "  spawnFailFallbackCalls: coldFallbackTotal - coldCallsBeforeSpawnFail,",
          "  spawnFailExitCode: outSf.result.exitCode,",
          "  coldFallbackTotal,",
          "}))",
        ].join("\n"),
        "utf8",
      )
      const execOut = spawnSync(process.execPath, [harness], {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
      })
      expect(execOut.status, execOut.stderr).toBe(0)
      expect(execOut.stderr).toContain(
        "[mutation-check] Warning: Coverage probe failed (probe boom)",
      )
      expect(execOut.stderr).toContain(
        "[mutation-check] Warning: Coverage probe failed (probe throw)",
      )
      const parsed = Schema.decodeSync(WarmBranchesSchema)(execOut.stdout.trim())
      expect(parsed).toEqual({
        probeNullOnFail: true,
        timedOutTag: "TimedOut",
        timedOutClearedRef: true,
        signaledTag: "Signaled",
        signaledClearedRef: true,
        exitedCode: 1,
        exitedKeptRef: true,
        spawnFailFallbackCalls: 1,
        spawnFailExitCode: 1,
        coldFallbackTotal: 1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runPackageMutantBatchChecked NDJSON recovery preserves inner processBatchFileReport Abort diagnostic and skips aborted timings", () => {
    const dir = makePkgRepo("ndjson-abort-diag-")
    try {
      const e1 = makeQueued(
        dir,
        1,
        "export const f1 = (a: number, b: number): boolean => a === b\n",
      )
      const e2 = makeQueued(
        dir,
        2,
        "export const f2 = (a: number, b: number): boolean => a !== b\n",
      )
      const t1 = e1.input.primaryTests[0]!
      const t2 = e2.input.primaryTests[0]!
      const planSchema = Schema.fromJsonString(Schema.Struct({ streamReportPath: Schema.String }))
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (_cmd, _args, opts) => {
          const planPath = opts?.env?.["HARNESS_PACKAGE_PLAN_FILE"]
          if (planPath !== undefined) {
            const { streamReportPath } = Schema.decodeSync(planSchema)(
              readFileSync(planPath, "utf8"),
            )
            const r1 = JSON.stringify({
              schemaVersion: 1,
              relFile: e1.input.file.relFile,
              primaryResults: e1.input.uncachedMutants.map((m) => ({
                id: m.id,
                result: {
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: `FAIL ${t1}\nTests 1 failed (1)\n`,
                  stderr: "",
                },
              })),
              scopedFallbackResults: [],
              packageFallbackResults: [],
              observedTestDurationsMs: { [t1]: 12 },
            })
            const r2 = JSON.stringify({
              schemaVersion: 1,
              relFile: e2.input.file.relFile,
              primaryResults: [],
              scopedFallbackResults: [],
              packageFallbackResults: [],
              restoreError: "[mutation-check] CRITICAL: failed to restore f2",
              observedTestDurationsMs: { [t2]: 999 },
            })
            writeFileSync(streamReportPath, `${r1}\n${r2}\n`, "utf8")
          }
          return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "worker crashed mid-batch" }
        },
      }
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness", "mutation-backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        allPackageTests: [t1, t2],
        files: [e1.input, e2.input],
      })
      match(res)
        .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort"))
        .with({ _tag: "Abort" }, ({ partialResults, observedDurationsMs, diagnostic }) => {
          expect(partialResults).toHaveLength(1)
          expect(partialResults[0]!.file.relFile).toBe(e1.input.file.relFile)
          expect(observedDurationsMs.get(t1)).toBe(12)
          expect(observedDurationsMs.has(t2)).toBe(false)
          expect(diagnostic).toContain("worker crashed mid-batch")
          expect(diagnostic).toContain("NDJSON recovery aborted")
          expect(diagnostic).toContain(e2.input.file.relFile)
          expect(diagnostic).toContain("CRITICAL: failed to restore f2")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-4.4: ensureStageBaselined falls back to cold baseline when warm worker runSubset returns SpawnFailed", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-spawnfail-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
      mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true })
      mkdirSync(join(dir, "tools"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      const coldMarker = join(dir, "cold-baseline.txt")
      writeFileSync(
        join(dir, "node_modules", "vitest", "vitest.mjs"),
        `import { appendFileSync } from "node:fs"\nconst args = process.argv.slice(2)\nappendFileSync(${JSON.stringify(coldMarker)}, args.join(" ") + "\\n")\nconsole.log("Tests  1 passed (1)")\nprocess.exit(0)\n`,
      )
      copyFileSync(
        join(REAL_REPO_ROOT, "tools", "package-vitest-batch.mjs"),
        join(dir, "tools", "package-vitest-batch.mjs"),
      )
      const helpersUrl = JSON.stringify(join(REAL_REPO_ROOT, "tools", "vitest-pool-helpers.mjs"))
      writeFileSync(
        join(dir, "tools", "vitest-pool-helpers.mjs"),
        [
          `import * as real from ${helpersUrl}`,
          `export * from ${helpersUrl}`,
          "export const createWarmVitestWorker = async () => ({",
          "  isAlive: () => true,",
          "  shouldRecycle: () => false,",
          "  invalidateFiles: async () => true,",
          "  runProbe: async () => { throw new Error('probe-throw') },",
          "  runSubset: async (id) => id === ''",
          "    ? { _tag: 'SpawnFailed', spawnError: '  ipc disconnected  ', stdout: '', stderr: '' }",
          "    : { _tag: 'Exited', exitCode: 1, stdout: 'Tests  1 failed (1)\\n', stderr: '' },",
          "  shutdown: async () => {},",
          "})",
        ].join("\n"),
      )
      const relFile = "libs/demo/core/src/f1.ts"
      const src = "export const f1 = (a: number, b: number): boolean => a === b\n"
      const tPrimary = "libs/demo/core/test/primary.test.ts"
      const tFallback = "libs/demo/core/test/fb.test.ts"
      writeFileSync(join(dir, relFile), src)
      writeFileSync(join(dir, tPrimary), "// primary\n")
      writeFileSync(join(dir, tFallback), "// fallback\n")
      const mutants = discoverDomainMutants(relFile, src)
      const mod = compileMutantSchemaModule(relFile, src, mutants)
      const planPath = join(dir, "plan.json")
      writeFileSync(
        planPath,
        JSON.stringify({
          cwd: dir,
          backupPath: join(dir, "backup.json"),
          vitestCli: join(dir, "node_modules", "vitest", "vitest.mjs"),
          allPackageTests: [tPrimary, tFallback],
          baselinedTests: [tPrimary],
          streamReportPath: join(dir, "stream.ndjson"),
          files: [
            {
              relFile,
              fullPath: join(dir, relFile),
              originalSha256: computeContentSha256(src),
              mutatedSha256: computeContentSha256(mod.schemaSource),
              originalSource: src,
              schemaSource: mod.schemaSource,
              primaryTests: [tPrimary],
              scopedFallbackTests: [tFallback],
              packageFallbackTests: [],
              mutantIds: mutants.map((m) => m.id),
              primaryTimeoutMs: 15_000,
              scopedFallbackTimeoutMs: 15_000,
              packageFallbackTimeoutMs: 15_000,
            },
          ],
        }),
      )
      const res = spawnSync(process.execPath, [join(dir, "tools", "package-vitest-batch.mjs")], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, HARNESS_PACKAGE_PLAN_FILE: planPath },
        timeout: 20_000,
      })
      expect(res.status, res.stderr).toBe(0)
      expect(existsSync(coldMarker)).toBe(true)
      expect(readFileSync(coldMarker, "utf8")).toContain(tFallback)
      const BatchOutSchema = Schema.fromJsonString(
        Schema.Array(
          Schema.Struct({ relFile: Schema.String, baselineError: Schema.optional(Schema.String) }),
        ),
      )
      const reports = Schema.decodeSync(BatchOutSchema)(res.stdout.trim())
      expect(reports).toHaveLength(1)
      expect(reports[0]!.baselineError).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
