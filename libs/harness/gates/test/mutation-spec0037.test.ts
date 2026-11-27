import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  MutantCacheId,
  MutationCacheAuth,
  type MutationCacheEntry,
  MutationCacheHmacSecret,
  type MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  PackageRelKey,
  SourceLineNumber,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  CodeMutant,
  MutantCategory,
  MutantId,
  type MutantOutcome,
  MutantSourceText,
  MutationCache,
  MutationCheck,
  computeMutantCacheKey,
  computeMutationContextDigestsChecked,
  computeMutationEntryMac,
  computeSourceOnlyClosureDigest,
  extractWitnessTestBlockDigests,
  isAppendOnlyWitnessDigestsPreserved,
  isMutatedModuleInitFailure,
  partitionMutationCacheLookup,
  readLastSurvivorIds,
  verifyMutationEntryMac,
  writeLastSurvivorIds,
} from "../src/index.js"
import {
  classifyMutantSubprocessResult,
  needsSoloColdRecheck,
  runVitestTargetList,
} from "../src/mutation-subprocess-helpers.js"
import { executeQueuedPackageBatches } from "../src/mutation/mutation-package-batch.js"
import {
  hydrateFileMutantCacheHits,
  recordKilledMutantsToCache,
} from "../src/mutation/mutation-suite-helpers.js"
import {
  analyzeWitnessTestBlocks,
  computeWitnessSupportClosureDigest,
  computeWitnessTestAstDigestsForPath,
  prepareTwoTierLookupInputs,
} from "../src/mutation/mutation-two-tier-cache.js"
import type { DomainFile } from "../src/mutation/mutation-target-discovery.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const mkMutant = (id: string): CodeMutant => ({
  id: MutantId.make(id),
  file: AstSourceFilePath.make("libs/demo/domain/src/index.ts"),
  line: SourceLineNumber.make(10),
  category: MutantCategory.make("boolean-return"),
  original: MutantSourceText.make("true"),
  replacement: MutantSourceText.make("false"),
  mutatedSource: MutantSourceText.make("export const ok = false"),
})

const TEST_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("spec0037-test-hmac-secret-key-0123456789abcdef"),
)
const TEST_AUTH = MutationCacheAuth.cases.Enabled.make({ hmacSecret: TEST_SECRET })

const DecidePropInput = Schema.Struct({
  baseKilledCount: Schema.Literals([0, 1, 2]),
  initFailCount: Schema.Literals([0, 1, 2]),
  baselineImportClean: Schema.Boolean,
  isModuleInitThrow: Schema.Boolean,
})

describe("SPEC-0037 REQ-3.1..REQ-3.4: Two-Tier Mutation Cache, Module-Init Classification & MutationCheck.run", () => {
  it("REQ-3.1 extractWitnessTestBlockDigests and isAppendOnlyWitnessDigestsPreserved support append-only test edits and invalidate modified assertions", () => {
    const baseTest = [
      'import { describe, expect, it } from "vitest"',
      'describe("suite", () => {',
      "  const helper = (x: number) => x + 1",
      '  it("t1", () => { expect(helper(1)).toBe(2) })',
      "})",
    ].join("\n")

    const appendedTest = [
      'import { describe, expect, it } from "vitest"',
      'describe("suite", () => {',
      "  const helper = (x: number) => x + 1",
      '  it("t1", () => { expect(helper(1)).toBe(2) })',
      '  it("t2", () => { expect(helper(2)).toBe(3) })',
      "})",
    ].join("\n")

    const modifiedAssertionTest = [
      'import { describe, expect, it } from "vitest"',
      'describe("suite", () => {',
      "  const helper = (x: number) => x + 1",
      '  it("t1", () => { expect(helper(1)).toBe(999) })',
      "})",
    ].join("\n")

    const deletedTest = [
      'import { describe, expect, it } from "vitest"',
      'describe("suite", () => {',
      "  const helper = (x: number) => x + 1",
      "})",
    ].join("\n")

    const dBase = extractWitnessTestBlockDigests(baseTest)
    const dAppended = extractWitnessTestBlockDigests(appendedTest)
    const dModified = extractWitnessTestBlockDigests(modifiedAssertionTest)
    const dDeleted = extractWitnessTestBlockDigests(deletedTest)

    expect(dBase.length).toBeGreaterThan(0)
    expect(isAppendOnlyWitnessDigestsPreserved(dBase, dAppended)).toBe(true)
    expect(isAppendOnlyWitnessDigestsPreserved(dBase, dModified)).toBe(false)
    expect(isAppendOnlyWitnessDigestsPreserved(dBase, dDeleted)).toBe(false)
    expect(isAppendOnlyWitnessDigestsPreserved([], dAppended)).toBe(false)
  })

  it.effect(
    "REQ-3.1 two-tier cache hits on append-only witness edit when Tier-1 source closure matches and misses on assertion edit or MAC tamper",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-two-tier-cache-"))
        try {
          mkdirSync(join(tmpDir, "libs/demo/domain/src"), { recursive: true })
          mkdirSync(join(tmpDir, "libs/demo/domain/test"), { recursive: true })
          writeFileSync(
            join(tmpDir, "package.json"),
            JSON.stringify({ name: "tmp-ws", private: true }),
          )
          writeFileSync(
            join(tmpDir, "libs/demo/domain/package.json"),
            JSON.stringify({ name: "@demo/domain", nx: { tags: ["type:domain"] } }),
          )
          writeFileSync(
            join(tmpDir, "libs/demo/domain/src/index.ts"),
            "export const add = (a: number, b: number) => a + b\n",
          )
          const witnessRel = AstSourceFilePath.make("libs/demo/domain/test/index.test.ts")
          const srcRel = AstSourceFilePath.make("libs/demo/domain/src/index.ts")
          const baseTestSrc =
            'import { it, expect } from "vitest"\nit("a", () => { expect(1).toBe(1) })\n'
          writeFileSync(join(tmpDir, witnessRel), baseTestSrc)

          const digestsRes = match(computeMutationContextDigestsChecked(tmpDir, testHostIo))
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()
          const srcClosureRes = match(
            computeSourceOnlyClosureDigest({
              repoRoot: tmpDir,
              relFile: srcRel,
              digests: digestsRes.digests,
              hostIo: testHostIo,
            }),
          )
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`source closure disabled: ${reason}`)
            })
            .exhaustive()

          const key = computeContentSha256("mutant-key-1")
          const recordedAt = MutationCacheTimestamp.make("2026-11-27T10:00:00.000Z")
          const nowMs = MutationEpochMillis.make(Date.parse("2026-11-27T10:05:00.000Z"))
          const oldWitnessDigest = computeContentSha256("old-witness-closure")
          const witnessSupportDigest = computeContentSha256("witness-support-1")
          const baseAstDigests = [...extractWitnessTestBlockDigests(baseTestSrc)]

          const entryWithoutMac = {
            key,
            file: srcRel,
            mutantId: MutantCacheId.make("m1"),
            status: "killed" as const,
            recordedAt,
            witnessTestFile: witnessRel,
            witnessClosureSha256: oldWitnessDigest,
            twoTierWitness: {
              sourceClosureSha256: srcClosureRes.closureDigest,
              witnessSupportSha256: witnessSupportDigest,
              witnessTestAstDigests: baseAstDigests,
            },
          }
          const mac = computeMutationEntryMac(TEST_SECRET, entryWithoutMac)
          const store = {
            version: "mutation-cache-v3" as const,
            entries: { [key]: { ...entryWithoutMac, mac } },
          }

          // Append-only test edit changes witnessClosureSha256, so exact match misses, but two-tier matches
          const appendedSrc = baseTestSrc + 'it("b", () => { expect(2).toBe(2) })\n'
          const hitDecision = yield* MutationCache.decide({
            candidateKeys: [key],
            store,
            auth: TEST_AUTH,
            nowMs,
            reachingTests: [witnessRel],
            witnessClosureDigests: { [witnessRel]: computeContentSha256("new-witness-closure") },
            sourceClosureDigests: { [srcRel]: srcClosureRes.closureDigest },
            witnessSupportDigests: { [witnessRel]: witnessSupportDigest },
            witnessTestAstDigests: {
              [witnessRel]: [...extractWitnessTestBlockDigests(appendedSrc)],
            },
          })
          expect(hitDecision.hitKeys).toEqual([key])
          expect(hitDecision.missKeys).toEqual([])

          // Modifying existing test assertion misses
          const editedSrc =
            'import { it, expect } from "vitest"\nit("a", () => { expect(1).toBe(2) })\n'
          const missDecision = yield* MutationCache.decide({
            candidateKeys: [key],
            store,
            auth: TEST_AUTH,
            nowMs,
            reachingTests: [witnessRel],
            witnessClosureDigests: { [witnessRel]: computeContentSha256("new-witness-closure") },
            sourceClosureDigests: { [srcRel]: srcClosureRes.closureDigest },
            witnessSupportDigests: { [witnessRel]: witnessSupportDigest },
            witnessTestAstDigests: { [witnessRel]: [...extractWitnessTestBlockDigests(editedSrc)] },
          })
          expect(missDecision.hitKeys).toEqual([])
          expect(missDecision.missKeys).toEqual([key])

          // Missing sourceClosureDigests map fails closed instead of hitting two-tier match
          const missingSourceDigestsDecision = yield* MutationCache.decide({
            candidateKeys: [key],
            store,
            auth: TEST_AUTH,
            nowMs,
            reachingTests: [witnessRel],
            witnessClosureDigests: { [witnessRel]: computeContentSha256("new-witness-closure") },
            witnessSupportDigests: { [witnessRel]: witnessSupportDigest },
            witnessTestAstDigests: {
              [witnessRel]: [...extractWitnessTestBlockDigests(appendedSrc)],
            },
          })
          expect(missingSourceDigestsDecision.hitKeys).toEqual([])
          expect(missingSourceDigestsDecision.missKeys).toEqual([key])

          // Tampering with any sub-field of twoTierWitness invalidates MAC & lookup
          const appendedAstDigests = [...extractWitnessTestBlockDigests(appendedSrc)]
          const tamperedVariants = [
            {
              label: "sourceClosureSha256",
              tamperedEntry: {
                ...entryWithoutMac,
                twoTierWitness: {
                  ...entryWithoutMac.twoTierWitness,
                  sourceClosureSha256: computeContentSha256("tampered-src"),
                },
                mac,
              },
              sourceClosureSha256: computeContentSha256("tampered-src"),
              witnessSupportSha256: witnessSupportDigest,
              witnessTestAstDigests: appendedAstDigests,
            },
            {
              label: "witnessSupportSha256",
              tamperedEntry: {
                ...entryWithoutMac,
                twoTierWitness: {
                  ...entryWithoutMac.twoTierWitness,
                  witnessSupportSha256: computeContentSha256("tampered-support"),
                },
                mac,
              },
              sourceClosureSha256: srcClosureRes.closureDigest,
              witnessSupportSha256: computeContentSha256("tampered-support"),
              witnessTestAstDigests: appendedAstDigests,
            },
            {
              label: "witnessTestAstDigests",
              tamperedEntry: {
                ...entryWithoutMac,
                twoTierWitness: {
                  ...entryWithoutMac.twoTierWitness,
                  witnessTestAstDigests: [computeContentSha256("tampered-ast")],
                },
                mac,
              },
              sourceClosureSha256: srcClosureRes.closureDigest,
              witnessSupportSha256: witnessSupportDigest,
              witnessTestAstDigests: [computeContentSha256("tampered-ast"), ...appendedAstDigests],
            },
          ] as const

          for (const variant of tamperedVariants) {
            expect(verifyMutationEntryMac(TEST_SECRET, variant.tamperedEntry), variant.label).toBe(
              false,
            )
            const tamperedDecision = partitionMutationCacheLookup({
              candidateKeys: [key],
              store: {
                version: "mutation-cache-v3",
                entries: { [key]: variant.tamperedEntry },
              },
              auth: TEST_AUTH,
              nowMs,
              reachingTests: [witnessRel],
              witnessClosureDigests: {
                [witnessRel]: computeContentSha256("new-witness-closure"),
              },
              sourceClosureDigests: { [srcRel]: variant.sourceClosureSha256 },
              witnessSupportDigests: { [witnessRel]: variant.witnessSupportSha256 },
              witnessTestAstDigests: { [witnessRel]: variant.witnessTestAstDigests },
            })
            expect(tamperedDecision.hitKeys, variant.label).toEqual([])
            expect(tamperedDecision.missKeys, variant.label).toEqual([key])
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      }),
  )

  it("REQ-3.2 classifies mutated module-init throws as killed when baselineImportClean is true and rejects hard infra/syntax errors", () => {
    for (const initOutput of [
      "Startup Error\nSchemaError: Invalid configuration\nTests  no tests\n",
      "ParseError: Expected positive integer\n",
      "TypeError: Cannot read properties of undefined\n",
      "RangeError: Maximum call stack size exceeded\n",
      "ReferenceError: x is not defined\n",
      "Error: Invalid WORKFLOW_TIMEOUT_BUDGETS: settleMs must exceed\n    at module (src/index.ts:10:1)\n",
      "Error: boom during top-level eval\n    at libs/demo/src/index.ts:3:9\n",
    ]) {
      expect(
        isMutatedModuleInitFailure({
          exitCode: 1,
          stdout: "",
          stderr: initOutput,
          baselineImportClean: true,
        }),
        initOutput,
      ).toBe(true)

      expect(
        isMutatedModuleInitFailure({
          exitCode: 1,
          stdout: "",
          stderr: initOutput,
          baselineImportClean: false,
        }),
        initOutput,
      ).toBe(false)

      expect(
        classifyMutantSubprocessResult(
          "m-init",
          Result.succeed({ _tag: "Exited", exitCode: 1, stdout: "", stderr: initOutput }),
          { baselineImportClean: true },
        ),
      ).toEqual({ kind: "outcome", status: "killed" })
    }

    for (const infraOutput of [
      "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\nTypeError: noise",
      "Cannot find module '@missing/pkg'\nError: boom\n    at a.ts:1:1",
      "ERR_MODULE_NOT_FOUND\nSchemaError: noise",
      "Failed to resolve import './missing.js'\nError: boom\n    at a.ts:1:1",
      "SyntaxError: Unexpected token\n    at a.ts:1:1",
      "Transform failed with 1 error\nError: esbuild",
      "Worker exited unexpectedly\nTypeError: noise",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "Error: EMFILE: too many open files\n    at fs.open",
      "TypeError: runner crash\n    at node_modules/vitest/dist/worker.js:12:4",
    ]) {
      expect(
        isMutatedModuleInitFailure({
          exitCode: 1,
          stdout: "",
          stderr: infraOutput,
          baselineImportClean: true,
        }),
        infraOutput,
      ).toBe(false)
      expect(
        classifyMutantSubprocessResult(
          "m-infra",
          Result.succeed({ _tag: "Exited", exitCode: 1, stdout: "", stderr: infraOutput }),
          { baselineImportClean: true },
        ).kind,
      ).toBe("abort")
    }

    expect(
      needsSoloColdRecheck(
        {
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "SchemaError: Invalid configuration\n",
        },
        { baselineImportClean: true },
      ),
    ).toBe(false)
    expect(
      needsSoloColdRecheck(
        {
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "SchemaError: Invalid configuration\n",
        },
        { baselineImportClean: false },
      ),
    ).toBe(true)
  })

  it.effect(
    "REQ-3.3 & REQ-3.4 MutationCheck.run filters to prior survivors when survivorsOnly is true and persists remaining survivors",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-survivors-only-"))
        try {
          mkdirSync(join(tmpDir, "libs/demo/domain/src"), { recursive: true })
          mkdirSync(join(tmpDir, "libs/demo/domain/test"), { recursive: true })
          writeFileSync(
            join(tmpDir, "package.json"),
            JSON.stringify({ name: "tmp-ws", private: true }),
          )
          writeFileSync(
            join(tmpDir, "libs/demo/domain/package.json"),
            JSON.stringify({ name: "@demo/domain", nx: { tags: ["type:domain"] } }),
          )
          writeFileSync(
            join(tmpDir, "libs/demo/domain/src/index.ts"),
            [
              "export const checkA = (x: number): boolean => x >= 0",
              "export const checkB = (y: number): boolean => y <= 0",
            ].join("\n") + "\n",
          )
          writeFileSync(
            join(tmpDir, "libs/demo/domain/test/index.test.ts"),
            'import { checkA } from "../src/index.js"\n',
          )

          const fullReport = yield* MutationCheck.run(tmpDir, testHostIo, {
            includeAllLines: true,
            disableMutantCache: true,
            testRunner: (mutant) =>
              mutant.id === "__baseline__" ? "survived" : mutant.line === 1 ? "killed" : "survived",
          })
          expect(fullReport.survivedCount).toBeGreaterThan(0)
          const survivedIds = fullReport.survivedMutants.map((m) => m.id)

          writeLastSurvivorIds(tmpDir, survivedIds, testHostIo)
          expect([...readLastSurvivorIds(tmpDir, testHostIo)]).toEqual([...survivedIds].sort())

          const seenMutantIds: Array<string> = []
          const scopedReport = yield* MutationCheck.run(tmpDir, testHostIo, {
            includeAllLines: true,
            disableMutantCache: true,
            survivorsOnly: true,
            testRunner: (mutant) => {
              if (mutant.id !== "__baseline__") seenMutantIds.push(mutant.id)
              return mutant.id === "__baseline__" ? "survived" : "killed"
            },
          })
          expect(scopedReport.passed).toBe(true)
          expect(seenMutantIds.sort()).toEqual([...survivedIds].sort())
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect.prop(
    "MutationCheck.decide classifies baseline-clean module-init throws as killed and dirty-baseline crashes as infraFailure",
    {
      spec: DecidePropInput,
    },
    ({ spec }) =>
      Effect.gen(function* () {
        const outcomes = Array.from({ length: spec.baseKilledCount }, (_, i) => ({
          mutant: mkMutant(`base-${i}`),
          status: "killed" as const,
        }))
        const moduleInitFailures = Array.from({ length: spec.initFailCount }, (_, i) => ({
          mutant: mkMutant(`init-${i}`),
          baselineImportClean: spec.baselineImportClean,
          isModuleInitThrow: spec.isModuleInitThrow,
        }))
        const report = yield* MutationCheck.decide({
          outcomes,
          moduleInitFailures,
        })

        const isCleanKill = spec.baselineImportClean && spec.isModuleInitThrow
        if (spec.initFailCount === 0 || isCleanKill) {
          expect(report.killedCount).toBe(spec.baseKilledCount + spec.initFailCount)
          expect(report.infraFailureCount ?? 0).toBe(0)
          expect(report.passed).toBe(true)
        } else {
          expect(report.killedCount).toBe(spec.baseKilledCount)
          expect(report.infraFailureCount).toBe(spec.initFailCount)
          expect(report.passed).toBe(false)
        }
      }),
  )

  const setupDemoTwoTierFixture = () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-two-tier-helpers-"))
    mkdirSync(join(tmpDir, "libs/demo/domain/src"), { recursive: true })
    mkdirSync(join(tmpDir, "libs/demo/domain/test"), { recursive: true })
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "tmp-ws", private: true }))
    writeFileSync(
      join(tmpDir, "libs/demo/domain/package.json"),
      JSON.stringify({ name: "@demo/domain", nx: { tags: ["type:domain"] } }),
    )
    const srcRel = AstSourceFilePath.make("libs/demo/domain/src/logic.ts")
    const helperRel = AstSourceFilePath.make("libs/demo/domain/test/helper.ts")
    const witnessRel = AstSourceFilePath.make("libs/demo/domain/test/logic.test.ts")
    const missingRel = AstSourceFilePath.make("libs/demo/domain/test/missing.test.ts")
    const srcContent =
      "export const checkA = (x: number): boolean => x >= 0\nexport const checkB = (y: number): boolean => y <= 0\n"
    const originalWitnessText =
      'import { it, expect } from "vitest"\nimport { checkA } from "../src/logic.js"\nimport { assertEq } from "./helper.js"\nit("a", () => { expect(assertEq(checkA(0), true)).toBe(true) })\n'
    writeFileSync(join(tmpDir, srcRel), srcContent)
    writeFileSync(
      join(tmpDir, helperRel),
      "export const assertEq = (a: boolean, b: boolean): boolean => a === b\n",
    )
    writeFileSync(join(tmpDir, witnessRel), originalWitnessText)

    const digestsRes = match(computeMutationContextDigestsChecked(tmpDir, isolatedTestHostIo))
      .with({ _tag: "Ok" }, (ok) => ok)
      .with({ _tag: "Disabled" }, ({ reason }) => {
        throw new Error(`digests disabled: ${reason}`)
      })
      .exhaustive()
    const expectedSupport = computeWitnessSupportClosureDigest({
      repoRoot: tmpDir,
      witnessTestFile: witnessRel,
      digests: digestsRes.digests,
      hostIo: isolatedTestHostIo,
    })
    const demoDomainFile: DomainFile = {
      scope: "demo",
      pkgDir: "domain",
      pkgName: "@demo/domain",
      tier: "domain",
      relFile: srcRel,
      fullPath: join(tmpDir, srcRel),
    }
    const mutant = {
      ...mkMutant("libs/demo/domain/src/logic.ts:1:>=->"),
      file: srcRel,
    }
    const key1 = computeMutantCacheKey({
      pkgKey: PackageRelKey.make("demo/domain"),
      relFile: srcRel,
      originalContentSha256: computeContentSha256(srcContent),
      compiledSchemaSha256: computeContentSha256("export const __mutant = 0"),
      mutant,
      digests: digestsRes.digests,
    })
    const key2 = computeContentSha256("k2")
    const cacheEntries: Record<ContentSha256, MutationCacheEntry> = {}
    const nowMs = MutationEpochMillis.make(Date.parse("2026-11-27T10:05:00.000Z"))
    const dirtied = recordKilledMutantsToCache({
      relFile: srcRel,
      uncachedMutants: [mutant],
      fileOutcomes: new Map<string, MutantOutcome>([[mutant.id, { mutant, status: "killed" }]]),
      mutantKeys: new Map([[mutant.id, key1]]),
      fileNonCacheableIds: new Set(),
      witnessByMutantId: new Map([[mutant.id, witnessRel]]),
      repoRoot: tmpDir,
      digests: digestsRes.digests,
      hostIo: isolatedTestHostIo,
      cacheAuth: TEST_AUTH,
      nowMs,
      cacheEntries,
    })
    const legacyEntryBase = {
      key: key2,
      file: srcRel,
      mutantId: cacheEntries[key1]!.mutantId,
      status: "killed" as const,
      recordedAt: cacheEntries[key1]!.recordedAt,
      witnessTestFile: witnessRel,
      witnessClosureSha256: cacheEntries[key1]!.witnessClosureSha256,
    }
    const twoTierStore: MutationCacheStore = {
      version: "mutation-cache-v3",
      entries: {
        [key1]: cacheEntries[key1]!,
        [key2]: {
          ...legacyEntryBase,
          mac: computeMutationEntryMac(TEST_SECRET, legacyEntryBase),
        },
      },
    }
    return {
      tmpDir,
      srcRel,
      helperRel,
      witnessRel,
      missingRel,
      srcContent,
      originalWitnessText,
      digests: digestsRes.digests,
      expectedSupport,
      demoDomainFile,
      mutant,
      key1,
      key2,
      cacheEntries,
      nowMs,
      dirtied,
      twoTierStore,
    }
  }

  it.effect(
    "records two-tier cache inputs and rejects unsafe append-only tests/hooks/options",
    () =>
      Effect.gen(function* () {
        const ctx = setupDemoTwoTierFixture()
        try {
          expect(
            computeWitnessTestAstDigestsForPath(ctx.tmpDir, ctx.missingRel, isolatedTestHostIo),
          ).toBeUndefined()
          const presentAst = computeWitnessTestAstDigestsForPath(
            ctx.tmpDir,
            ctx.witnessRel,
            isolatedTestHostIo,
          )
          expect(presentAst?.length).toBeGreaterThan(0)
          expect(ctx.expectedSupport).toMatch(/^[0-9a-f]{64}$/)
          expect(ctx.dirtied).toBe(true)
          expect(ctx.cacheEntries[ctx.key1]?.twoTierWitness?.sourceClosureSha256).toMatch(
            /^[0-9a-f]{64}$/,
          )
          expect(ctx.cacheEntries[ctx.key1]?.twoTierWitness?.witnessSupportSha256).toBe(
            ctx.expectedSupport,
          )
          expect(ctx.cacheEntries[ctx.key1]?.twoTierWitness?.witnessTestAstDigests).toEqual(
            presentAst,
          )

          const withTwoTier = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key1],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.witnessRel]),
            digests: ctx.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(withTwoTier.sourceClosureDigests[ctx.srcRel]).toBe(
            ctx.cacheEntries[ctx.key1]?.twoTierWitness?.sourceClosureSha256,
          )
          expect(withTwoTier.witnessSupportDigests[ctx.witnessRel]).toBe(ctx.expectedSupport)
          expect(withTwoTier.witnessTestAstDigests[ctx.witnessRel]).toEqual(presentAst)
          expect(withTwoTier.witnessClosureDigests[ctx.witnessRel]).toBe(
            ctx.cacheEntries[ctx.key1]?.witnessClosureSha256,
          )

          writeFileSync(
            join(ctx.tmpDir, ctx.witnessRel),
            `${ctx.originalWitnessText}it("b", () => { expect(checkA(1)).toBe(true) })\n`,
          )
          const updatedDigestsRes = match(
            computeMutationContextDigestsChecked(ctx.tmpDir, isolatedTestHostIo),
          )
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()
          const matchingKey = yield* Effect.sync(() =>
            hydrateFileMutantCacheHits({
              repoRoot: ctx.tmpDir,
              file: ctx.demoDomainFile,
              originalContent: ctx.srcContent,
              schemaSource: "export const __mutant = 0",
              mutants: [ctx.mutant],
              allReachingTests: [ctx.witnessRel],
              hostIo: isolatedTestHostIo,
              cacheEnabled: true,
              cacheAuth: TEST_AUTH,
              nowMs: ctx.nowMs,
              contextDigests: updatedDigestsRes.digests,
              loadedCacheStore: ctx.twoTierStore,
              cacheEntries: {},
            }),
          )
          expect(matchingKey.mutantKeys.get(ctx.mutant.id)).toBe(ctx.key1)
          expect([...matchingKey.cachedHitIds]).toEqual([ctx.mutant.id])
          expect(matchingKey.dirtiedCache).toBe(true)

          const optionOnlyAnalysis = analyzeWitnessTestBlocks(
            `${ctx.originalWitnessText}it("opt", { only: true }, () => { expect(true).toBe(true) })\n`,
          )
          expect(optionOnlyAnalysis.unsafeBlockDigests.size).toBeGreaterThan(0)

          writeFileSync(
            join(ctx.tmpDir, ctx.witnessRel),
            `${ctx.originalWitnessText}it.only("focus", () => { expect(true).toBe(true) })\n`,
          )
          const unsafeOnlyInputs = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key1],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.witnessRel]),
            digests: updatedDigestsRes.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(unsafeOnlyInputs.witnessTestAstDigests[ctx.witnessRel]).toBeUndefined()

          writeFileSync(
            join(ctx.tmpDir, ctx.witnessRel),
            `${ctx.originalWitnessText}describe("added", () => { beforeEach(() => {}); it("nested", () => {}) })\n`,
          )
          const unsafeDescribeInputs = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key1],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.witnessRel]),
            digests: updatedDigestsRes.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(unsafeDescribeInputs.witnessTestAstDigests[ctx.witnessRel]).toBeUndefined()
        } finally {
          rmSync(ctx.tmpDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "invalidates two-tier hits on legacy missing support, config/helper edits, and persists survivors on real MutationCheck.run",
    () =>
      Effect.gen(function* () {
        const ctx = setupDemoTwoTierFixture()
        try {
          writeFileSync(
            join(ctx.tmpDir, ctx.witnessRel),
            `${ctx.originalWitnessText}it("b", () => { expect(checkA(1)).toBe(true) })\n`,
          )
          const updatedDigestsRes = match(
            computeMutationContextDigestsChecked(ctx.tmpDir, isolatedTestHostIo),
          )
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()
          const missingSupportInputs = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key2],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.witnessRel]),
            digests: updatedDigestsRes.digests,
            hostIo: isolatedTestHostIo,
          })
          const missingSupportLookup = yield* MutationCache.decide({
            candidateKeys: [ctx.key2],
            store: ctx.twoTierStore,
            auth: TEST_AUTH,
            nowMs: ctx.nowMs,
            reachingTests: [ctx.witnessRel],
            ...missingSupportInputs,
          })
          expect(missingSupportLookup.hitKeys).toEqual([])
          expect(missingSupportLookup.missKeys).toEqual([ctx.key2])

          writeFileSync(
            join(ctx.tmpDir, "libs/demo/domain/vitest.config.ts"),
            "export default { test: { globals: true } }\n",
          )
          const cfgChangedDigests = match(
            computeMutationContextDigestsChecked(ctx.tmpDir, isolatedTestHostIo),
          )
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()
          const afterCfgSupport = computeWitnessSupportClosureDigest({
            repoRoot: ctx.tmpDir,
            witnessTestFile: ctx.witnessRel,
            digests: cfgChangedDigests.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(afterCfgSupport).not.toBe(ctx.expectedSupport)

          writeFileSync(join(ctx.tmpDir, ctx.witnessRel), ctx.originalWitnessText)
          writeFileSync(
            join(ctx.tmpDir, ctx.helperRel),
            "export const assertEq = (): boolean => true\n",
          )
          const helperChangedDigests = match(
            computeMutationContextDigestsChecked(ctx.tmpDir, isolatedTestHostIo),
          )
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()
          const afterHelperInputs = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key1],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.witnessRel]),
            digests: helperChangedDigests.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(afterHelperInputs.witnessSupportDigests[ctx.witnessRel]).not.toBe(
            ctx.expectedSupport,
          )
          const afterHelperLookup = yield* MutationCache.decide({
            candidateKeys: [ctx.key1],
            store: ctx.twoTierStore,
            auth: TEST_AUTH,
            nowMs: ctx.nowMs,
            reachingTests: [ctx.witnessRel],
            ...afterHelperInputs,
          })
          expect(afterHelperLookup.hitKeys).toEqual([])
          expect(afterHelperLookup.missKeys).toEqual([ctx.key1])

          const withoutTwoTier = prepareTwoTierLookupInputs({
            repoRoot: ctx.tmpDir,
            relFile: ctx.srcRel,
            candidateKeys: [ctx.key2],
            loadedCacheStore: ctx.twoTierStore,
            reachingSet: new Set([ctx.missingRel]),
            digests: ctx.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(withoutTwoTier.sourceClosureDigests).toEqual({})
          expect(withoutTwoTier.witnessTestAstDigests).toEqual({})

          const execHostIo: SyncHostIo = {
            ...isolatedTestHostIo,
            execFileSync: (cmd, _args, opts) => {
              if (cmd === "git") {
                return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "not a git repository" }
              }
              const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
              if (activeId !== undefined && activeId.includes(":1:")) {
                return {
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: "FAIL libs/demo/domain/test/logic.test.ts\nTests  1 failed (1)\n",
                  stderr: "AssertionError",
                }
              }
              return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
            },
          }
          const execReport = yield* MutationCheck.run(ctx.tmpDir, execHostIo, {
            includeAllLines: true,
            disableMutantCache: true,
          })
          expect(execReport.killedCount).toBeGreaterThan(0)
          expect(execReport.survivedCount).toBeGreaterThan(0)
          expect([...readLastSurvivorIds(ctx.tmpDir, isolatedTestHostIo)]).toEqual(
            execReport.survivedMutants.map((m) => m.id).sort(),
          )
        } finally {
          rmSync(ctx.tmpDir, { recursive: true, force: true })
        }
      }),
  )

  it("F-4.1 runVitestTargetList requires verified baseline before classifying module-init SchemaError as killed", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-f41-baseline-"))
    try {
      mkdirSync(join(tmpDir, "libs/demo/domain/src"), { recursive: true })
      mkdirSync(join(tmpDir, "libs/demo/domain/test"), { recursive: true })
      const srcRel = AstSourceFilePath.make("libs/demo/domain/src/index.ts")
      const fullPath = join(tmpDir, srcRel)
      const originalSource = "export const ok = true\n"
      writeFileSync(fullPath, originalSource)
      const file: DomainFile = {
        scope: "demo",
        pkgDir: "domain",
        pkgName: "@demo/domain",
        tier: "domain",
        relFile: srcRel,
        fullPath,
      }
      const mutant = mkMutant("m-init-f41")
      const backupPath = join(tmpDir, ".harness", "mutation-backup.json")
      const initThrowHostIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => ({
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "SchemaError: Invalid configuration\nTests  no tests\n",
        }),
      }

      const unverifiedOmitted = runVitestTargetList(
        tmpDir,
        file,
        initThrowHostIo,
        {},
        ["libs/demo/domain/test/index.test.ts"],
        originalSource,
        "export const ok = false\n",
        backupPath,
        [mutant],
        { skipBaselineCheck: true },
      )
      expect(unverifiedOmitted._tag).toBe("Abort")

      const unverifiedFalse = runVitestTargetList(
        tmpDir,
        file,
        initThrowHostIo,
        {},
        ["libs/demo/domain/test/index.test.ts"],
        originalSource,
        "export const ok = false\n",
        backupPath,
        [mutant],
        { skipBaselineCheck: true, baselineVerified: false },
      )
      expect(unverifiedFalse._tag).toBe("Abort")

      const verifiedTrue = runVitestTargetList(
        tmpDir,
        file,
        initThrowHostIo,
        {},
        ["libs/demo/domain/test/index.test.ts"],
        originalSource,
        "export const ok = false\n",
        backupPath,
        [mutant],
        { skipBaselineCheck: true, baselineVerified: true },
      )
      match(verifiedTrue)
        .with({ _tag: "Abort" }, ({ diagnostic }) => expect.unreachable(diagnostic))
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes).toEqual([{ mutant, status: "killed" }])
        })
        .exhaustive()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("F-4.1: executeQueuedPackageBatches requires every queued entry to have baselineVerified === true before killing module-init SchemaError", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spec0037-queued-batch-"))
    try {
      const vitestCli = join(tmpDir, "node_modules", "vitest", "vitest.mjs")
      const runnerJs = join(tmpDir, "tools", "package-vitest-batch.mjs")
      mkdirSync(join(tmpDir, "node_modules", "vitest"), { recursive: true })
      mkdirSync(join(tmpDir, "tools"), { recursive: true })
      mkdirSync(join(tmpDir, ".harness"), { recursive: true })
      writeFileSync(vitestCli, "// stub\n", "utf8")
      writeFileSync(runnerJs, "// stub\n", "utf8")

      const makeFile = (rel: string): DomainFile => ({
        scope: "demo",
        pkgDir: "domain",
        pkgName: "@demo/domain",
        tier: "domain",
        relFile: AstSourceFilePath.make(rel),
        fullPath: join(tmpDir, rel),
      })
      const f1 = makeFile("libs/demo/domain/src/a.ts")
      const f2 = makeFile("libs/demo/domain/src/b.ts")
      mkdirSync(join(tmpDir, "libs", "demo", "domain", "src"), { recursive: true })
      writeFileSync(f1.fullPath, "export const ok = true\n", "utf8")
      writeFileSync(f2.fullPath, "export const ok = true\n", "utf8")
      const m1 = mkMutant("m-a-init")
      const m2 = mkMutant("m-b-init")
      const batchHostIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes(runnerJs)) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  schemaVersion: 1,
                  relFile: f1.relFile,
                  primaryResults: [
                    {
                      id: m1.id,
                      result: {
                        _tag: "Exited",
                        exitCode: 1,
                        stdout: "",
                        stderr: "SchemaError: Invalid configuration\nTests  no tests\n",
                      },
                    },
                  ],
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
                {
                  schemaVersion: 1,
                  relFile: f2.relFile,
                  primaryResults: [
                    {
                      id: m2.id,
                      result: {
                        _tag: "Exited",
                        exitCode: 1,
                        stdout: "",
                        stderr: "SchemaError: Invalid configuration\nTests  no tests\n",
                      },
                    },
                  ],
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "SchemaError: Invalid configuration\nTests  no tests\n",
          }
        },
      }
      const makeEntry = (file: DomainFile, mutant: CodeMutant, baselineVerified: boolean) => ({
        pkgKey: "libs/demo/domain",
        input: {
          file,
          originalContent: "export const ok = true\n",
          schemaSource: "export const ok = false\n",
          mutants: [mutant],
          uncachedMutants: [mutant],
          primaryTests: ["libs/demo/domain/test/a.test.ts"],
          fallbackTests: [],
          scopedFallbackTests: [],
          packageFallbackTests: [],
          cachedHitIds: new Set<string>(),
        },
        mutantKeys: new Map<string, ContentSha256>(),
        baselineVerified,
      })

      const bothVerifiedErr = executeQueuedPackageBatches({
        repoRoot: tmpDir,
        backupPath: join(tmpDir, ".harness", "mutation-backup.json"),
        hostIo: batchHostIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([
          ["libs/demo/domain", [makeEntry(f1, m1, true), makeEntry(f2, m2, true)]],
        ]),
        finalizeEntry: () => undefined,
        recordPartialOnAbort: () => {},
      })
      expect(bothVerifiedErr).toBeUndefined()

      const mixedVerifiedErr = executeQueuedPackageBatches({
        repoRoot: tmpDir,
        backupPath: join(tmpDir, ".harness", "mutation-backup.json"),
        hostIo: batchHostIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([
          ["libs/demo/domain", [makeEntry(f1, m1, true), makeEntry(f2, m2, false)]],
        ]),
        finalizeEntry: () => undefined,
        recordPartialOnAbort: () => {},
      })
      expect(mixedVerifiedErr).toContain("[mutation-check] Baseline test suite failed")

      const neitherVerifiedErr = executeQueuedPackageBatches({
        repoRoot: tmpDir,
        backupPath: join(tmpDir, ".harness", "mutation-backup.json"),
        hostIo: batchHostIo,
        baseSubprocessEnv: {},
        queuedByPkg: new Map([
          ["libs/demo/domain", [makeEntry(f1, m1, false), makeEntry(f2, m2, false)]],
        ]),
        finalizeEntry: () => undefined,
        recordPartialOnAbort: () => {},
      })
      expect(neitherVerifiedErr).toContain("[mutation-check] Baseline test suite failed")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
