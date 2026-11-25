import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type MutationCacheAuth,
  MutationCacheHmacSecret,
  MutationEpochMillis,
  SourceLineNumber,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import {
  MutationCheck,
  evaluateMutationOutcomes,
  runDomainMutationSuite,
} from "../src/mutation-check.js"
import {
  type CodeMutant,
  MutantId,
  type MutantOutcome,
  MutantSourceText,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import { loadMutationCache } from "../src/mutation/mutation-cache.js"
import { partitionReachingTestFiles } from "../src/mutation/mutation-target-discovery.js"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("failfast-stagea-hmac-secret-0123456789abcd"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}
const BASE_NOW_MS = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))

const NOT_GIT_RESULT: SyncHostExecResult = {
  _tag: "Exited",
  exitCode: 128,
  stdout: "",
  stderr: "not a git repository",
}

const writeFileMkdir = (filePath: string, content: string): void => {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

const setupTempPkgRepo = (): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-ff-stagea-"))
  writeFileMkdir(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n')
  writeFileMkdir(
    join(repoRoot, "node_modules", "vitest", "package.json"),
    '{"name":"vitest","version":"5.0.0"}\n',
  )
  writeFileMkdir(join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "package.json"),
    '{"name":"@sample/domain","nx":{"tags":["type:domain"]}}\n',
  )
  return repoRoot
}

const makeMutant = (id: string, line = 1): CodeMutant => ({
  id: MutantId.make(id),
  file: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
  line: SourceLineNumber.make(line),
  category: "boolean-return",
  original: MutantSourceText.make("a === b"),
  replacement: MutantSourceText.make("false"),
  mutatedSource: MutantSourceText.make("export const f = () => false\n"),
})

const captureStderr = <A>(fn: () => A): { readonly result: A; readonly stderrText: string } => {
  const chunks: Array<string> = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stderr.write
  try {
    const result = fn()
    return { result, stderrText: chunks.join("") }
  } finally {
    process.stderr.write = origWrite
  }
}

describe("SPEC-0034 Area 2: Early Termination (failFast / maxSurvivors) & Stage-A Probing", () => {
  it.effect(
    "REQ-2.1 & REQ-2.2 SpanTrace: MutationCheck.decide fails when earlyTerminated=true or survived>=maxSurvivors with zero span budget violations",
    () =>
      Effect.gen(function* () {
        const outcomes: ReadonlyArray<MutantOutcome> = [
          { mutant: makeMutant("m1", 1), status: "killed" },
          { mutant: makeMutant("m2", 2), status: "killed" },
          { mutant: makeMutant("m3", 3), status: "survived" },
        ]
        const { result, spans } = yield* runWithTestTracer(
          "MutationCheck.decide::early-terminated",
          MutationCheck.decide({
            outcomes,
            minScore: 0.5,
            earlyTerminated: true,
            maxSurvivors: 1,
          }),
          new Map(),
        )
        expect(result.passed).toBe(false)
        expect(result.mutationScore).toBeCloseTo(2 / 3)
        expect(result.survivedCount).toBe(1)

        const decideSpan = spans.find((s) => s.name === "MutationCheck.decide")
        expect(decideSpan?.exitTag).toBe("Success")

        const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
          spanId: s.spanId,
          name: s.name,
          parentSpanId: s.parentSpanId,
          durationMs: s.durationMs,
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          exitTag: match(s.exitTag)
            .with("Success", () => "Success" as const)
            .with("Failure", () => "Failure" as const)
            .with("Defect", () => "Defect" as const)
            .with("Interrupt", () => "Failure" as const)
            .with(undefined, () => undefined)
            .exhaustive(),
          errorTag: s.errorTag,
        }))
        const violations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(violations).toEqual([])

        // Even with 0 survivors, earlyTerminated=true forces passed=false
        const earlyZero = evaluateMutationOutcomes(
          [{ mutant: makeMutant("m-ok", 1), status: "killed" }],
          0.5,
          undefined,
          undefined,
          undefined,
          true,
          1,
        )
        expect(earlyZero.passed).toBe(false)

        // maxSurvivors=1 fails even when minScore is low
        const maxSurvSummary = evaluateMutationOutcomes(
          outcomes,
          0.1,
          undefined,
          undefined,
          undefined,
          false,
          1,
        )
        expect(maxSurvSummary.passed).toBe(false)
      }),
  )

  it("REQ-2.1 & REQ-2.2 Early Termination: failFast and maxSurvivors=1 flush file 1 kills, print exact survivor line, skip file 3, and fail closed", () => {
    for (const mode of ["failFast", "maxSurvivors1"] as const) {
      const repoRoot = setupTempPkgRepo()
      try {
        const f1Src = "export const eq1 = (a: number, b: number): boolean => a === b\n"
        const f2Src = "export const eq2 = (a: number, b: number): boolean => a === b\n"
        const f3Src = "export const eq3 = (a: number, b: number): boolean => a === b\n"
        writeFileMkdir(
          join(repoRoot, "libs", "sample2", "domain", "package.json"),
          '{"name":"@sample2/domain","nx":{"tags":["type:domain"]}}\n',
        )
        writeFileMkdir(join(repoRoot, "libs", "sample", "domain", "src", "f1.ts"), f1Src)
        writeFileMkdir(join(repoRoot, "libs", "sample", "domain", "src", "f2.ts"), f2Src)
        writeFileMkdir(join(repoRoot, "libs", "sample2", "domain", "src", "f3.ts"), f3Src)
        writeFileMkdir(
          join(repoRoot, "libs", "sample", "domain", "test", "f1.test.ts"),
          'import { expect, it } from "vitest"\nimport { eq1 } from "../src/f1.js"\nit("ok", () => { expect(eq1(1, 1)).toBe(true) })\n',
        )
        writeFileMkdir(
          join(repoRoot, "libs", "sample", "domain", "test", "f2.test.ts"),
          'import { expect, it } from "vitest"\nimport { eq2 } from "../src/f2.js"\nit("ok", () => { expect(eq2(1, 1)).toBe(true) })\n',
        )
        writeFileMkdir(
          join(repoRoot, "libs", "sample2", "domain", "test", "f3.test.ts"),
          'import { expect, it } from "vitest"\nimport { eq3 } from "../src/f3.js"\nit("ok", () => { expect(eq3(1, 1)).toBe(true) })\n',
        )

        const f2Mutants = discoverDomainMutants("libs/sample/domain/src/f2.ts", f2Src)
        const executedTestArgs: Array<string> = []
        const mockIo: SyncHostIo = {
          ...isolatedTestHostIo,
          execFileSync: (cmd, args, opts) => {
            if (cmd === "git") return NOT_GIT_RESULT
            const joinedArgs = args.join(" ")
            executedTestArgs.push(joinedArgs)
            const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
            if (activeId === undefined) {
              return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
            }
            if (activeId.startsWith("libs/sample/domain/src/f1.ts")) {
              return {
                _tag: "Exited",
                exitCode: 1,
                stdout: "FAIL  libs/sample/domain/test/f1.test.ts\nTests  1 failed (1)\n",
                stderr: "",
              }
            }
            // f2 mutants survive across primary and fallback
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          },
        }

        const { result: report, stderrText } = captureStderr(() =>
          runDomainMutationSuite(repoRoot, mockIo, {
            includeAllLines: true,
            cacheAuth: TEST_CACHE_AUTH,
            nowMs: BASE_NOW_MS,
            ...(mode === "failFast" ? { failFast: true } : { maxSurvivors: 1 }),
          }),
        )

        expect(report.passed).toBe(false)
        expect(report.earlyTerminated).toBe(true)
        expect(report.survivedCount).toBeGreaterThanOrEqual(1)
        expect(executedTestArgs.some((a) => a.includes("f3.test.ts"))).toBe(false)

        const expectedLine = `${f2Mutants[0]!.file}:${f2Mutants[0]!.line}:${f2Mutants[0]!.original}->${f2Mutants[0]!.replacement}`
        expect(stderrText).toContain(expectedLine)

        const cached = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
        const cachedEntries = Object.values(cached.entries)
        expect(cachedEntries.length).toBeGreaterThan(0)
        expect(cachedEntries.every((e) => e.file === "libs/sample/domain/src/f1.ts")).toBe(true)
      } finally {
        rmSync(repoRoot, { recursive: true, force: true })
      }
    }
  })

  it("REQ-2.1 & REQ-2.2 maxSurvivors=2 ignores equivalent mutants via equivalencePriors, stops at 2 confirmed survivors, and rejects invalid maxSurvivors", () => {
    const repoRoot = setupTempPkgRepo()
    try {
      const f1Src = "export const f1 = (x: number): number => x + 1\n"
      const f2Src = "export const f2 = (x: number): number => x - 1\n"
      const f3Src = "export const f3 = (a: number, b: number): boolean => a === b\n"
      const f4Src = "export const f4 = (a: number, b: number): boolean => a !== b\n"

      writeFileMkdir(
        join(repoRoot, "libs", "sample2", "domain", "package.json"),
        '{"name":"@sample2/domain","nx":{"tags":["type:domain"]}}\n',
      )
      for (const [idx, pkg, src] of [
        [1, "sample", f1Src],
        [2, "sample", f2Src],
        [3, "sample", f3Src],
        [4, "sample2", f4Src],
      ] as const) {
        writeFileMkdir(join(repoRoot, "libs", pkg, "domain", "src", `f${idx}.ts`), src)
        writeFileMkdir(
          join(repoRoot, "libs", pkg, "domain", "test", `f${idx}.test.ts`),
          `import { expect, it } from "vitest"\nimport { f${idx} } from "../src/f${idx}.js"\nit("ok", () => { expect(f${idx}).toBeDefined() })\n`,
        )
      }

      const f1Mutants = discoverDomainMutants("libs/sample/domain/src/f1.ts", f1Src)
      expect(f1Mutants).toHaveLength(1)
      const f2Mutants = discoverDomainMutants("libs/sample/domain/src/f2.ts", f2Src)
      expect(f2Mutants).toHaveLength(1)
      const f3Mutants = discoverDomainMutants("libs/sample/domain/src/f3.ts", f3Src)
      expect(f3Mutants).toHaveLength(1)

      const executedArgs: Array<string> = []
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, args) => {
          if (cmd === "git") return NOT_GIT_RESULT
          executedArgs.push(args.join(" "))
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      }

      const { result: report } = captureStderr(() =>
        runDomainMutationSuite(repoRoot, mockIo, {
          includeAllLines: true,
          maxSurvivors: 2,
          equivalencePriors: { [f1Mutants[0]!.id]: 950 },
        }),
      )
      expect(report.passed).toBe(false)
      expect(report.earlyTerminated).toBe(true)
      expect(report.equivalentCount).toBe(1)
      expect(report.survivedCount).toBe(2)
      expect(executedArgs.some((a) => a.includes("f2.test.ts"))).toBe(true)
      expect(executedArgs.some((a) => a.includes("f3.test.ts"))).toBe(true)
      expect(executedArgs.some((a) => a.includes("f4.test.ts"))).toBe(false)

      // Invalid maxSurvivors (0 and -1) fail closed before running any target
      for (const badLimit of [0, -1]) {
        let called = false
        const spyIo: SyncHostIo = {
          ...isolatedTestHostIo,
          execFileSync: () => {
            called = true
            return NOT_GIT_RESULT
          },
        }
        const { result: badReport } = captureStderr(() =>
          runDomainMutationSuite(repoRoot, spyIo, {
            includeAllLines: true,
            maxSurvivors: badLimit,
          }),
        )
        expect(badReport.passed).toBe(false)
        expect(badReport.diagnostic).toContain("Invalid maxSurvivors")
        expect(called).toBe(false)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.3 --stage-a-only executes only primaryTests, skips scopedFallbackTests and packageFallbackTests, and reports fallback-only kills as survived", () => {
    const repoRoot = setupTempPkgRepo()
    try {
      const targetSrc = [
        "export const computePrimary = (a: number, b: number): boolean => a === b",
        "export const computeHelper = (x: number): number => x + 1",
      ].join("\n")
      const targetPath = join(repoRoot, "libs", "sample", "domain", "src", "target.ts")
      const otherPath = join(repoRoot, "libs", "sample", "domain", "src", "other.ts")
      writeFileMkdir(targetPath, targetSrc)
      writeFileMkdir(otherPath, "export const computeOther = (x: number): number => x * 2\n")
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        [
          'export { computePrimary as aliasedPrimary, computeHelper } from "./target.js"',
          'export { computeOther } from "./other.js"',
        ].join("\n"),
      )

      const directTest = join(repoRoot, "libs", "sample", "domain", "test", "direct.test.ts")
      const barrelHelperTest = join(
        repoRoot,
        "libs",
        "sample",
        "domain",
        "test",
        "barrel-helper.test.ts",
      )
      const unrelatedMetaTest = join(
        repoRoot,
        "libs",
        "sample",
        "domain",
        "test",
        "unrelated-meta.test.ts",
      )
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "test", "helpers", "bridge.ts"),
        'import { aliasedPrimary } from "../../src/index.js"\nexport const runBridge = () => aliasedPrimary(1, 1)\n',
      )
      writeFileMkdir(
        directTest,
        'import { expect, it } from "vitest"\nimport { computePrimary } from "../src/target.js"\nit("direct", () => { expect(computePrimary(1, 1)).toBe(true) })\n',
      )
      writeFileMkdir(
        barrelHelperTest,
        'import { expect, it } from "vitest"\nimport { runBridge } from "./helpers/bridge.js"\nit("bridge", () => { expect(runBridge()).toBe(true) })\n',
      )
      writeFileMkdir(
        unrelatedMetaTest,
        'import { expect, it } from "vitest"\nexport const meta = 1\nit("meta", () => { expect(meta).toBe(1) })\n',
      )

      const part = partitionReachingTestFiles(
        repoRoot,
        {
          scope: "sample",
          pkgDir: "domain",
          pkgName: "@sample/domain",
          tier: "domain",
          fullPath: targetPath,
          relFile: "libs/sample/domain/src/target.ts",
        },
        targetSrc,
        testHostIo,
      )
      expect(part.primaryTests).toEqual([directTest])
      expect(part.scopedFallbackTests).toEqual([barrelHelperTest])
      expect(part.packageFallbackTests).toEqual([unrelatedMetaTest])

      const targetMutants = discoverDomainMutants("libs/sample/domain/src/target.ts", targetSrc)
      const primaryKilledIds = new Set(targetMutants.filter((m) => m.line === 1).map((m) => m.id))
      const helperMutants = targetMutants.filter((m) => m.line === 2)
      expect(primaryKilledIds.size).toBeGreaterThan(0)
      expect(helperMutants.length).toBeGreaterThan(0)

      const recordedArgs: Array<string> = []
      const makeMockIo = (killAllInPrimary: boolean): SyncHostIo => ({
        ...isolatedTestHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") return NOT_GIT_RESULT
          const joined = args.join(" ")
          recordedArgs.push(joined)
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          if (joined.includes("barrel-helper.test.ts")) {
            return {
              _tag: "Exited",
              exitCode: 1,
              stdout: "FAIL  libs/sample/domain/test/barrel-helper.test.ts\nTests  1 failed (1)\n",
              stderr: "",
            }
          }
          if (killAllInPrimary || primaryKilledIds.has(MutantId.make(activeId))) {
            return {
              _tag: "Exited",
              exitCode: 1,
              stdout: "FAIL  libs/sample/domain/test/direct.test.ts\nTests  1 failed (1)\n",
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      })

      // 1) Mutants killed by primaryTests pass under stageAOnly=true without running fallback tests
      const passReport = runDomainMutationSuite(repoRoot, makeMockIo(true), {
        targetFiles: ["libs/sample/domain/src/target.ts"],
        includeAllLines: true,
        stageAOnly: true,
      })
      expect(passReport.stageAOnly).toBe(true)
      expect(passReport.passed).toBe(true)
      expect(passReport.killedCount).toBe(targetMutants.length)
      expect(recordedArgs.some((a) => a.includes("barrel-helper.test.ts"))).toBe(false)
      expect(recordedArgs.some((a) => a.includes("unrelated-meta.test.ts"))).toBe(false)

      // 2) Mutant only killable by fallback survives under stageAOnly=true (passed=false), still skipping fallback tests
      recordedArgs.length = 0
      const survReport = runDomainMutationSuite(repoRoot, makeMockIo(false), {
        targetFiles: ["libs/sample/domain/src/target.ts"],
        includeAllLines: true,
        stageAOnly: true,
      })
      expect(survReport.stageAOnly).toBe(true)
      expect(survReport.passed).toBe(false)
      expect(survReport.killedCount).toBe(primaryKilledIds.size)
      expect(survReport.survivedCount).toBe(helperMutants.length)
      expect(recordedArgs.some((a) => a.includes("barrel-helper.test.ts"))).toBe(false)
      expect(recordedArgs.some((a) => a.includes("unrelated-meta.test.ts"))).toBe(false)

      // 3) Same scenario with stageAOnly=false runs scopedFallbackTests and kills the remaining mutant
      recordedArgs.length = 0
      const fullReport = runDomainMutationSuite(repoRoot, makeMockIo(false), {
        targetFiles: ["libs/sample/domain/src/target.ts"],
        includeAllLines: true,
      })
      expect(fullReport.stageAOnly).toBeUndefined()
      expect(fullReport.passed).toBe(true)
      expect(recordedArgs.some((a) => a.includes("barrel-helper.test.ts"))).toBe(true)
      expect(recordedArgs.some((a) => a.includes("unrelated-meta.test.ts"))).toBe(false)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
