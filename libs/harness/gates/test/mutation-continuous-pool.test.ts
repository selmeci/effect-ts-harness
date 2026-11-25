import { spawnSync } from "node:child_process"
import {
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
import { Schema } from "effect"
import { match } from "ts-pattern"
import { MUTATION_TEST_TIMINGS_SCHEMA_VERSION, computeContentSha256 } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
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
        onChunkFlushed: () => {
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
        onChunkFlushed: () => {
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

  it("REQ-5.3 & REQ-2.1: stops early at maxSurvivors across files and enforces isolate:true despite env overrides", () => {
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

  it("REQ-5.3 & REQ-3.2: isolate:true prevents module-level Set cache leakage and measuredDurationsMs >= 2000 gates Stage B", () => {
    const dir = makePkgRepo("iso-stage-b-")
    try {
      const cacheModRel = "libs/demo/core/src/mod-cache.ts"
      const targetRel = "libs/demo/core/src/target.ts"
      const tFast = "libs/demo/core/test/fast.test.ts"
      const tSlow = "libs/demo/core/test/plain-dynamic.test.ts"
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
        'import { checkOnce } from "./mod-cache.js"',
        "export const evalA = (n: number): number => (checkOnce('a') ? -999 : n + 1)",
        "export const evalB = (n: number): number => (checkOnce('b') ? -999 : n * 2)",
      ].join("\n")
      writeFileSync(join(dir, targetRel), targetSrc, "utf8")
      writeFileSync(
        join(dir, tFast),
        [
          'import { expect, it } from "vitest"',
          'import { evalA, evalB } from "../src/target.js"',
          'it("fresh module cache per mutant", () => { expect(evalA(2)).toBe(3); expect(evalB(3)).toBe(6) })',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        join(dir, tSlow),
        [
          'import { writeFileSync } from "node:fs"',
          'import { expect, it } from "vitest"',
          'import { evalA } from "../src/target.js"',
          `it("dynamic heavy", () => { writeFileSync(${JSON.stringify(slowMarker)}, "ran"); expect(evalA(2)).toBe(3) })`,
        ].join("\n"),
        "utf8",
      )

      const mutants = discoverDomainMutants(targetRel, targetSrc)
      const mod = compileMutantSchemaModule(targetRel, targetSrc, mutants)
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
        allPackageTests: [tFast, tSlow],
        files: [
          {
            file: makeDomainFile(dir, targetRel),
            originalContent: targetSrc,
            schemaSource: mod.schemaSource,
            mutants,
            uncachedMutants: mutants,
            primaryTests: [tFast, tSlow],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
        ],
        measuredDurationsMs: { [tFast]: 10, [tSlow]: 2500 },
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => expect.unreachable(diagnostic))
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults).toHaveLength(1)
          const statuses = Array.from(fileResults[0]!.fileOutcomes.values()).map((o) => o.status)
          expect(statuses.every((s) => s === "killed")).toBe(true)
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
})
