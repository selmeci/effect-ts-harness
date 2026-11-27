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
  computeMutationContextDigestsChecked,
  computeMutationEntryMac,
  computeSourceOnlyClosureDigest,
  extractWitnessTestBlockDigests,
  isAppendOnlyWitnessPreserved,
  isMutatedModuleInitFailure,
  readLastSurvivorIds,
  writeLastSurvivorIds,
} from "../src/index.js"
import { classifyMutantSubprocessResult } from "../src/mutation-subprocess-helpers.js"
import { recordKilledMutantsToCache } from "../src/mutation/mutation-suite-helpers.js"
import {
  computeWitnessTestAstDigestsForPath,
  prepareTwoTierLookupInputs,
} from "../src/mutation/mutation-two-tier-cache.js"
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
  it("REQ-3.1 extractWitnessTestBlockDigests and isAppendOnlyWitnessPreserved support append-only test edits and invalidate modified assertions", () => {
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
    expect(isAppendOnlyWitnessPreserved(dBase, dAppended)).toBe(true)
    expect(isAppendOnlyWitnessPreserved(dBase, dModified)).toBe(false)
    expect(isAppendOnlyWitnessPreserved(dBase, dDeleted)).toBe(false)
    expect(isAppendOnlyWitnessPreserved([], dAppended)).toBe(false)
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
          const baseAstDigests = [...extractWitnessTestBlockDigests(baseTestSrc)]

          const entryWithoutMac = {
            key,
            file: srcRel,
            mutantId: MutantCacheId.make("m1"),
            status: "killed" as const,
            recordedAt,
            witnessTestFile: witnessRel,
            witnessClosureSha256: oldWitnessDigest,
            sourceClosureSha256: srcClosureRes.closureDigest,
            witnessTestAstDigests: baseAstDigests,
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
            witnessTestAstDigests: { [witnessRel]: [...extractWitnessTestBlockDigests(editedSrc)] },
          })
          expect(missDecision.hitKeys).toEqual([])
          expect(missDecision.missKeys).toEqual([key])

          // Tampering with sourceClosureSha256 invalidates MAC
          const tamperedMacDecision = yield* MutationCache.decide({
            candidateKeys: [key],
            store: {
              version: "mutation-cache-v3",
              entries: {
                [key]: {
                  ...entryWithoutMac,
                  sourceClosureSha256: computeContentSha256("tampered"),
                  mac,
                },
              },
            },
            auth: TEST_AUTH,
            nowMs,
            reachingTests: [witnessRel],
            witnessClosureDigests: { [witnessRel]: computeContentSha256("new-witness-closure") },
            sourceClosureDigests: { [srcRel]: computeContentSha256("tampered") },
            witnessTestAstDigests: {
              [witnessRel]: [...extractWitnessTestBlockDigests(appendedSrc)],
            },
          })
          expect(tamperedMacDecision.hitKeys).toEqual([])
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

  it.effect(
    "records and prepares two-tier cache inputs and persists survivors on real non-runner MutationCheck.run",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-two-tier-helpers-"))
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
          const srcRel = AstSourceFilePath.make("libs/demo/domain/src/logic.ts")
          const witnessRel = AstSourceFilePath.make("libs/demo/domain/test/logic.test.ts")
          const missingRel = AstSourceFilePath.make("libs/demo/domain/test/missing.test.ts")
          writeFileSync(
            join(tmpDir, srcRel),
            [
              "export const checkA = (x: number): boolean => x >= 0",
              "export const checkB = (y: number): boolean => y <= 0",
            ].join("\n") + "\n",
          )
          writeFileSync(
            join(tmpDir, witnessRel),
            'import { it, expect } from "vitest"\nimport { checkA } from "../src/logic.js"\nit("a", () => { expect(checkA(0)).toBe(true) })\n',
          )

          expect(
            computeWitnessTestAstDigestsForPath(tmpDir, missingRel, isolatedTestHostIo),
          ).toBeUndefined()
          const presentAst = computeWitnessTestAstDigestsForPath(
            tmpDir,
            witnessRel,
            isolatedTestHostIo,
          )
          expect(presentAst?.length).toBeGreaterThan(0)

          const digestsRes = match(computeMutationContextDigestsChecked(tmpDir, isolatedTestHostIo))
            .with({ _tag: "Ok" }, (ok) => ok)
            .with({ _tag: "Disabled" }, ({ reason }) => {
              throw new Error(`digests disabled: ${reason}`)
            })
            .exhaustive()

          const mutant = mkMutant("libs/demo/domain/src/logic.ts:1:>=->")
          const key1 = computeContentSha256("k1")
          const key2 = computeContentSha256("k2")
          const cacheEntries: Record<ContentSha256, MutationCacheEntry> = {}
          const nowMs = MutationEpochMillis.make(Date.parse("2026-11-27T10:05:00.000Z"))
          const dirtied = recordKilledMutantsToCache({
            relFile: srcRel,
            uncachedMutants: [mutant],
            fileOutcomes: new Map<string, MutantOutcome>([
              [mutant.id, { mutant, status: "killed" }],
            ]),
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
          expect(dirtied).toBe(true)
          expect(cacheEntries[key1]?.sourceClosureSha256).toBeDefined()
          expect(cacheEntries[key1]?.witnessTestAstDigests).toBeDefined()

          const twoTierStore: MutationCacheStore = {
            version: "mutation-cache-v3",
            entries: {
              [key1]: cacheEntries[key1]!,
              [key2]: {
                ...cacheEntries[key1]!,
                key: key2,
                witnessTestFile: missingRel,
                sourceClosureSha256: undefined,
                witnessTestAstDigests: undefined,
              },
            },
          }
          const withTwoTier = prepareTwoTierLookupInputs({
            repoRoot: tmpDir,
            relFile: srcRel,
            candidateKeys: [key1],
            loadedCacheStore: twoTierStore,
            reachingSet: new Set([witnessRel]),
            digests: digestsRes.digests,
            hostIo: isolatedTestHostIo,
          })
          expect(withTwoTier.sourceClosureDigests[srcRel]).toBeDefined()
          expect(withTwoTier.witnessTestAstDigests[witnessRel]).toBeDefined()
          expect(withTwoTier.witnessClosureDigests[witnessRel]).toBeDefined()

          const withoutTwoTier = prepareTwoTierLookupInputs({
            repoRoot: tmpDir,
            relFile: srcRel,
            candidateKeys: [key2],
            loadedCacheStore: twoTierStore,
            reachingSet: new Set([missingRel]),
            digests: digestsRes.digests,
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
          const execReport = yield* MutationCheck.run(tmpDir, execHostIo, {
            includeAllLines: true,
            disableMutantCache: true,
          })
          expect(execReport.killedCount).toBeGreaterThan(0)
          expect(execReport.survivedCount).toBeGreaterThan(0)
          expect([...readLastSurvivorIds(tmpDir, isolatedTestHostIo)]).toEqual(
            execReport.survivedMutants.map((m) => m.id).sort(),
          )
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      }),
  )
})
