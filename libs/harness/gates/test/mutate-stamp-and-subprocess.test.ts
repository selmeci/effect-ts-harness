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
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { BatchMutantResultsSchema, PackageRelKey } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  checkMutateStamp,
  checkVerifyStamp,
  classifyFileWrite,
  computeMutableTreeHashChecked,
  isImmutableTcbPath,
  isMarkdownDocPath,
  MutantCount,
  MutateStampPassed,
  readExistingVerifyStamp,
  removeMutateStamp,
  StampRelFilePath,
  writeMutateStamp,
  writeVerifyStamp,
} from "../src/index.js"
import { computeMutationContextDigestsChecked } from "../src/mutation/mutation-context-digest.js"
import { parseDstSeedEnv } from "../src/verify-stamp.js"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import { runVitestTargetList } from "../src/mutation-subprocess-helpers.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"
import { makeSubprocessFixture } from "./helpers/mutation-subprocess-fixture.js"

describe("verify-stamp, policy, and rule-synthesizer: mutate stamp lifecycle, guard denial, and TCB protection", () => {
  it("writeMutateStamp / checkMutateStamp / removeMutateStamp and VerifyStamp mutate metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-stamp-"))
    try {
      const srcFile = join(dir, "libs", "demo", "domain", "src", "x.ts")
      mkdirSync(join(dir, "libs", "demo", "domain", "src"), { recursive: true })
      writeFileSync(srcFile, "export const x = 1\n", "utf8")

      // Missing stamp
      const missing = checkMutateStamp(dir, isolatedTestHostIo)
      expect(missing._tag).toBe("Invalid")

      // Corrupt JSON
      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".harness", "mutate-stamp.json"), "{bad-json", "utf8")
      const corrupt = checkMutateStamp(dir, isolatedTestHostIo)
      expect(corrupt._tag).toBe("Invalid")

      // Advisory enforcementMode rejected
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "advisory",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const advisory = checkMutateStamp(dir, isolatedTestHostIo)
      expect(advisory._tag).toBe("Invalid")

      // Valid strict stamp accepted
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const valid = checkMutateStamp(dir, isolatedTestHostIo)
      expect(valid._tag).toBe("Valid")

      // VerifyStamp carries mutateEnforcementMode + mutantsEvaluated
      const verifyStamp = writeVerifyStamp(dir, isolatedTestHostIo, "impl/test", undefined, {
        mutateEnforcementMode: "strict",
        mutantsEvaluated: MutantCount.make(2),
      })
      expect(verifyStamp.mutateEnforcementMode).toBe("strict")
      expect(verifyStamp.mutantsEvaluated).toBe(2)
      const checkedVerify = checkVerifyStamp(dir, isolatedTestHostIo)
      expect(checkedVerify.valid).toBe(true)

      // Stale treeHash after file edit rejected
      writeFileSync(srcFile, "export const x = 2\n", "utf8")
      const stale = checkMutateStamp(dir, isolatedTestHostIo)
      expect(stale._tag).toBe("Invalid")

      // removeMutateStamp cleans up
      removeMutateStamp(dir, isolatedTestHostIo)
      expect(checkMutateStamp(dir, isolatedTestHostIo)._tag).toBe("Invalid")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifyFileWrite denies mutate-stamp.json and isImmutableTcbPath protects mutation TCB files", () => {
    expect(classifyFileWrite(".harness/mutate-stamp.json").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/worktrees/wt1/mutate-stamp.json").verdict).toBe("deny")

    expect(isImmutableTcbPath("libs/harness/gates/src/mutation/mutation-backup.ts")).toBe(true)
    expect(isImmutableTcbPath("libs/harness/gates/src/mutation/mutation-target-discovery.ts")).toBe(
      true,
    )
    expect(isImmutableTcbPath("libs/harness/gates/src/mutation-subprocess-helpers.ts")).toBe(true)
    expect(isImmutableTcbPath("libs/harness/gates/src/verify-stamp.ts")).toBe(true)
  })
})

describe("mutate-stamp-and-subprocess diff, retry & markdown hygiene", () => {
  it("checkMutateStamp exact reason strings across all failure modes and parseDstSeedEnv", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-stamp-reasons-"))
    try {
      const srcFile = join(dir, "libs", "demo", "domain", "src", "x.ts")
      mkdirSync(join(dir, "libs", "demo", "domain", "src"), { recursive: true })
      writeFileSync(srcFile, "export const x = 1\n", "utf8")
      const stampPath = join(dir, ".harness", "mutate-stamp.json")

      // missing
      expect(checkMutateStamp(dir, isolatedTestHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Missing .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // missing
      mkdirSync(join(dir, ".harness"), { recursive: true })
      const statFailIo: SyncHostIo = {
        ...isolatedTestHostIo,
        existsSync: (p) => {
          if (p === stampPath) throw new Error("stat EACCES")
          return isolatedTestHostIo.existsSync(p)
        },
      }
      expect(checkMutateStamp(dir, statFailIo)).toEqual({
        _tag: "Invalid",
        reason: `Failed to stat '${stampPath}': stat EACCES`,
      })
      writeFileSync(stampPath, "{}", "utf8")
      const readFailIo: SyncHostIo = {
        ...isolatedTestHostIo,
        readTextSync: (p) => {
          if (p === stampPath) throw new Error("read EIO")
          return isolatedTestHostIo.readTextSync(p)
        },
      }
      expect(checkMutateStamp(dir, readFailIo)).toEqual({
        _tag: "Invalid",
        reason: `Failed to read '${stampPath}': read EIO`,
      })

      // corrupt JSON
      writeFileSync(stampPath, "{not-json", "utf8")
      expect(checkMutateStamp(dir, isolatedTestHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Invalid .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // advisory
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "advisory",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, isolatedTestHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Advisory .harness/mutate-stamp.json is insufficient for verify. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // totalMutants: 0
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [],
        totalMutants: MutantCount.make(0),
        killedCount: MutantCount.make(0),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, isolatedTestHostIo)._tag).toBe("Invalid")

      // survivedCount > 0
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(1),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, isolatedTestHostIo)._tag).toBe("Invalid")

      // killedCount !== totalMutants
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, isolatedTestHostIo)._tag).toBe("Invalid")

      // missing requiredDiffFiles coverage
      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, isolatedTestHostIo, ["libs/demo/domain/src/other.ts"])).toEqual({
        _tag: "Invalid",
        reason:
          "Mutate stamp does not cover required diff file(s): libs/demo/domain/src/other.ts. Run pnpm harness mutate --strict.",
      })

      // symlink refusal
      const symlinkIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) =>
          p === srcFile ? true : isolatedTestHostIo.isSymbolicLinkSync(p),
      }
      expect(checkMutateStamp(dir, symlinkIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Failed to compute mutable workspace tree hash (Refusing to hash symbolic link 'libs/demo/domain/src/x.ts'). Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // unreadable file refusal
      const unreadIo: SyncHostIo = {
        ...isolatedTestHostIo,
        readBytesSync: (p) => {
          if (p === srcFile) throw new Error("EACCES")
          return isolatedTestHostIo.readBytesSync(p)
        },
      }
      expect(checkMutateStamp(dir, unreadIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Failed to compute mutable workspace tree hash (Failed to read workspace file 'libs/demo/domain/src/x.ts' while computing tree hash: EACCES). Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // treeHash mismatch
      writeFileSync(srcFile, "export const x = 2\n", "utf8")
      expect(checkMutateStamp(dir, isolatedTestHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Workspace files changed since last mutate --strict. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // Invalid DST_SEED
      expect(() => parseDstSeedEnv("not-an-int")).toThrow('Invalid DST_SEED value "not-an-int"')
      expect(() => parseDstSeedEnv("-5")).toThrow('Invalid DST_SEED value "-5"')
      expect(parseDstSeedEnv("42")).toBe(42)
      expect(parseDstSeedEnv(undefined)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-1.3: diffOnly filters explicit targetFiles to git diff modified lines and skips unchanged files", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "diff-only-target-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      const testDir = join(repoRoot, "libs", "demo", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      writeFileSync(
        join(srcDir, "a.ts"),
        "export const f1 = (x: number) => x === 1\nexport const f2 = (x: number) => x === 2\n",
      )
      writeFileSync(join(srcDir, "b.ts"), "export const g1 = (x: number) => x === 1\n")
      writeFileSync(
        join(testDir, "a.test.ts"),
        'import { f1, f2 } from "../src/a.js"\nimport { g1 } from "../src/b.js"\n',
      )

      const unifiedDiff = [
        "diff --git a/libs/demo/domain/src/a.ts b/libs/demo/domain/src/a.ts",
        "--- a/libs/demo/domain/src/a.ts",
        "+++ b/libs/demo/domain/src/a.ts",
        "@@ -2,0 +2,1 @@",
        "+export const f2 = (x: number) => x === 2",
      ].join("\n")

      const mutatedLinesSeen: Array<number> = []
      const diffIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") {
            if (args.includes("rev-parse")) {
              return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
            }
            if (args.includes("diff")) {
              return { _tag: "Exited", exitCode: 0, stdout: unifiedDiff, stderr: "" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
          }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          const lineMatch = /:(\d+)(?:@|:)/.exec(activeId)
          if (lineMatch !== null) mutatedLinesSeen.push(Number(lineMatch[1]))
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }

      const report = runDomainMutationSuite(repoRoot, diffIo, {
        targetFiles: ["libs/demo/domain/src/a.ts", "libs/demo/domain/src/b.ts"],
        diffOnly: true,
        disableMutantCache: true,
      })
      expect(report.passed).toBe(true)
      expect(report.diffMode).toBe("working-tree")
      expect(report.diffMatchedFiles).toEqual(["libs/demo/domain/src/a.ts"])
      expect(report.evaluatedFiles).toEqual(["libs/demo/domain/src/a.ts"])
      expect(report.totalMutants).toBeGreaterThan(0)
      expect(mutatedLinesSeen.length).toBeGreaterThan(0)
      expect(mutatedLinesSeen.every((line) => line === 2)).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-1.a & F-2.b: batch solo recheck recovers flaky batch timeout/unconfirmed exit and parallel-vitest-batch isolates HARNESS_STATE_DIR", () => {
    const {
      dir,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    } = makeSubprocessFixture()
    try {
      const soloRecheckedIds: Array<string> = []
      const recheckRecoverIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          if (args[0] === batchRunnerPath) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                { id: "m-1", result: { _tag: "TimedOut", stdout: "", stderr: "" } },
                {
                  id: "m-2",
                  result: {
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "FAIL  libs/demo/core/test/mod.test.ts\n",
                    stderr: "",
                  },
                },
              ]),
              stderr: "",
            }
          }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          soloRecheckedIds.push(activeId)
          if (activeId === "m-1") {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const recovered = runVitestTargetList(
        dir,
        domainFile,
        recheckRecoverIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(soloRecheckedIds).toEqual(["m-1", "m-2"])
      match(recovered)
        .with({ _tag: "Ok" }, ({ outcomes, nonCacheableIds }) => {
          expect(outcomes.map((o) => [o.mutant.id, o.status])).toEqual([
            ["m-1", "survived"],
            ["m-2", "killed"],
          ])
          expect(nonCacheableIds.has("m-2")).toBe(false)
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected recovered Ok, got: ${diagnostic}`)
        })
        .exhaustive()

      // Persistent solo TimedOut aborts fail-closed
      const persistentTimeoutIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          if (args[0] === batchRunnerPath) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                { id: "m-1", result: { _tag: "TimedOut", stdout: "", stderr: "" } },
                {
                  id: "m-2",
                  result: {
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "Tests  1 failed (1)\n",
                    stderr: "",
                  },
                },
              ]),
              stderr: "",
            }
          }
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "TimedOut", stdout: "", stderr: "" }
        },
      }
      const persistentAbort = runVitestTargetList(
        dir,
        domainFile,
        persistentTimeoutIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(persistentAbort._tag).toBe("Abort")

      // Real tools/parallel-vitest-batch.mjs: worker HARNESS_STATE_DIR isolation + cleanup + TimedOut + SIGTERM
      const batchScript = fileURLToPath(
        new URL("../../../../tools/parallel-vitest-batch.mjs", import.meta.url),
      )
      const fakeVitest = join(dir, "fake-batch-vitest.mjs")
      const stateDirLog = join(dir, "state-dirs.jsonl")
      writeFileSync(
        fakeVitest,
        `import { appendFileSync } from "node:fs";
const id = process.env.HARNESS_ACTIVE_MUTANT_ID;
appendFileSync(${JSON.stringify(stateDirLog)}, JSON.stringify({ id, stateDir: process.env.HARNESS_STATE_DIR ?? null }) + "\\n");
if (id === "m-sigterm") {
  process.kill(process.pid, "SIGTERM");
} else if (id === "m-timeout") {
  setTimeout(() => {}, 10_000);
} else {
  process.stdout.write("Tests  1 failed (1)\\n");
  process.exit(1);
}
`,
        "utf8",
      )
      const sharedParentStateDir = join(dir, "shared-parent-state")
      const proc = spawnSync(process.execPath, [batchScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_STATE_DIR: sharedParentStateDir,
          HARNESS_BATCH_VITEST_CLI: fakeVitest,
          HARNESS_BATCH_CWD: dir,
          HARNESS_BATCH_TIMEOUT_MS: "250",
          HARNESS_BATCH_TESTS_JSON: JSON.stringify(["a.test.ts"]),
          HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-ok", "m-sigterm", "m-timeout"]),
        },
      })
      expect(proc.status).toBe(0)
      const parsed = Schema.decodeSync(BatchMutantResultsSchema)(proc.stdout)
      const byId = new Map<string, (typeof parsed)[number]["result"]>(
        parsed.map((e) => [e.id, e.result]),
      )
      expect(byId.get("m-ok")?._tag).toBe("Exited")
      expect(byId.get("m-sigterm")).toMatchObject({ _tag: "Signaled", signal: "SIGTERM" })
      expect(byId.get("m-timeout")?._tag).toBe("TimedOut")

      const recorded = readFileSync(stateDirLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; stateDir: string | null })
      expect(recorded).toHaveLength(3)
      const stateDirs = recorded.map((r) => r.stateDir)
      expect(stateDirs.every((s) => typeof s === "string" && s.length > 0)).toBe(true)
      expect(stateDirs.every((s) => s !== sharedParentStateDir)).toBe(true)
      expect(new Set(stateDirs).size).toBe(3)
      for (const s of stateDirs) {
        if (s !== null) expect(existsSync(s)).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("SPEC-0026 REQ-4.1 & REQ-4.2: mutate stamp uses mutable-only tree hash and LIBS_EXCLUDED_DIRS excludes libs/*/docs while digesting apps/", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-mutable-hash-"))
    try {
      mkdirSync(join(dir, "docs"), { recursive: true })
      mkdirSync(join(dir, "libs", "demo", "gates", "src"), { recursive: true })
      mkdirSync(join(dir, "libs", "demo", "gates", "docs"), { recursive: true })
      mkdirSync(join(dir, "apps", "demo-cli", "src"), { recursive: true })
      mkdirSync(join(dir, "apps", "demo-cli", "test"), { recursive: true })
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "tmp-mut-hash", version: "0.0.0" }),
        "utf8",
      )
      symlinkSync(
        join(resolve(import.meta.dirname, "../../../.."), "node_modules"),
        join(dir, "node_modules"),
      )
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
      writeFileSync(
        join(dir, "libs", "demo", "gates", "package.json"),
        JSON.stringify({ name: "@demo/gates", nx: { tags: ["type:core"] } }),
        "utf8",
      )
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const e = 1\n",
        "utf8",
      )
      writeFileSync(join(dir, "libs", "demo", "gates", "docs", "spec.md"), "# initial\n", "utf8")
      writeFileSync(
        join(dir, "apps", "demo-cli", "package.json"),
        JSON.stringify({ name: "demo-cli", nx: { tags: ["type:app"] } }),
        "utf8",
      )
      writeFileSync(join(dir, "apps", "demo-cli", "src", "pure.ts"), "export const p = 1\n", "utf8")
      writeFileSync(
        join(dir, "apps", "demo-cli", "test", "pure.test.ts"),
        "export const t = 1\n",
        "utf8",
      )
      writeFileSync(join(dir, "docs", "overview.md"), "# docs overview\n", "utf8")
      writeFileSync(join(dir, "README.md"), "# root doc\n", "utf8")

      const mutableBefore = computeMutableTreeHashChecked(dir, testHostIo)
      expect(mutableBefore._tag).toBe("Success")

      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        equivalentCount: MutantCount.make(0),
        survivedCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const verifyStamp = writeVerifyStamp(dir, testHostIo, "impl/test-branch")
      expect(readExistingVerifyStamp(dir, testHostIo)).toEqual(verifyStamp)
      expect(verifyStamp.mutableTreeHash).toBeDefined()

      const digestBefore = computeMutationContextDigestsChecked(dir, testHostIo)

      // Modify markdown files in docs/ and libs/*/docs/ -> mutate stamp stays Valid and allLibsSrcDigest stays unchanged
      writeFileSync(join(dir, "docs", "overview.md"), "# updated docs overview\n", "utf8")
      writeFileSync(
        join(dir, "libs", "demo", "gates", "docs", "spec.md"),
        "# updated spec\n",
        "utf8",
      )
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Valid")

      // F-2.1: root README.md IS included in mutableTreeHash (asserted by adapter-config/doc-truth tests)
      writeFileSync(join(dir, "README.md"), "# updated root doc\n", "utf8")
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")
      writeFileSync(join(dir, "README.md"), "# root doc\n", "utf8")
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Valid")

      const digestAfterDocEdit = computeMutationContextDigestsChecked(dir, testHostIo)
      const okBefore = match(digestBefore)
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) =>
          expect.unreachable(`Expected digests before doc edit, got Disabled: ${reason}`),
        )
        .exhaustive()
      const okAfter = match(digestAfterDocEdit)
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) =>
          expect.unreachable(`Expected digests after doc edit, got Disabled: ${reason}`),
        )
        .exhaustive()
      expect(okAfter.allLibsSrcDigest).toBe(okBefore.allLibsSrcDigest)
      expect(okAfter.fileDigests.get("apps/demo-cli/src/pure.ts")).toBeDefined()
      expect(okAfter.packageSupportDigests.get(PackageRelKey.make("apps/demo-cli"))).toBeDefined()
      expect(okAfter.testSupportDigests.get(PackageRelKey.make("apps/demo-cli"))).toBeDefined()

      // Modify .ts code -> checkMutateStamp turns Invalid immediately
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const e = 2\n",
        "utf8",
      )
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")
      expect(checkVerifyStamp(dir, testHostIo).valid).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-2.1: isMarkdownDocPath excludes root README.md/AGENTS.md and executable/test/adapter directories per ADR-0019", () => {
    for (const nonDocPath of [
      "README.md",
      "./README.md",
      "readme.md",
      "AGENTS.md",
      "./agents.md",
      "adapters/antigravity/README.md",
      "adapters/claude-code/skills/effect-lfg/SKILL.md",
      "agent-patterns/planning.md",
      "libs/harness/gates/src/notes.md",
      "libs/harness/gates/test/fixtures/sample.mdx",
      "libs/harness/gates/tests/sample.md",
      "libs/harness/gates/__tests__/sample.md",
      "apps/web/src/fixtures/demo.md",
    ]) {
      expect(isMarkdownDocPath(nonDocPath), nonDocPath).toBe(false)
    }
    for (const docPath of [
      "docs/adr/0019.md",
      "docs/README.md",
      "libs/harness/docs/spec.mdx",
      "notes.md",
    ]) {
      expect(isMarkdownDocPath(docPath), docPath).toBe(true)
    }
  })

  it.prop(
    "isMarkdownDocPath property: recognizes .md/.mdx case-insensitively outside non-doc directories and root README/AGENTS.md",
    {
      prefixDir: Schema.Literals([
        "",
        "docs/",
        "libs/harness/docs/",
        "adapters/",
        "agent-patterns/",
        "libs/demo/src/",
        "libs/demo/test/",
        "libs/demo/tests/",
        "libs/demo/__tests__/",
        "libs/demo/fixtures/",
      ]),
      fileName: Schema.Literals(["README", "AGENTS", "0019-note", "design-spec"]),
      leadingDotSlash: Schema.Boolean,
      useBackslash: Schema.Boolean,
      ext: Schema.Literals([".md", ".MD", ".mdx", ".MDX", ".ts", ".tsx", ".json"]),
    },
    ({ prefixDir, fileName, leadingDotSlash, useBackslash, ext }) => {
      const lower = ext.toLowerCase()
      const excludedPrefixes = new Set([
        "adapters/",
        "agent-patterns/",
        "libs/demo/src/",
        "libs/demo/test/",
        "libs/demo/tests/",
        "libs/demo/__tests__/",
        "libs/demo/fixtures/",
      ])
      const rawRel = `${leadingDotSlash ? "./" : ""}${prefixDir}${fileName}${ext}`
      const rel = useBackslash ? rawRel.replace(/\//g, "\\") : rawRel
      const isDocExt = lower === ".md" || lower === ".mdx"
      const isRootTestAsserted =
        prefixDir === "" && /^(?:README|AGENTS)\.md$/i.test(`${fileName}${ext}`)
      expect(isMarkdownDocPath(rel)).toBe(
        isDocExt && !excludedPrefixes.has(prefixDir) && !isRootTestAsserted,
      )
    },
  )

  it("F-8.1: removeMutateStamp inspects structured code/cause before anchored ENOENT fallback and never ignores EACCES mentioning ENOENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-enoent-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      writeFileSync(join(dir, "libs", "demo", "core", "src", "x.ts"), "export const x = 1\n")
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/core/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/core/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/core/src/x.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })

      const eaccesWithEnoentPath: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {
          throw Object.assign(
            new Error("EACCES: permission denied, unlink '/tmp/ENOENT/mutate-stamp.json'"),
            { code: "EACCES" },
          )
        },
      }
      const eaccesRes = removeMutateStamp(dir, eaccesWithEnoentPath)
      match(eaccesRes)
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure).toContain("EACCES")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected Failure for EACCES error mentioning ENOENT")
        })
        .exhaustive()

      const uncodedMessageWithEnoentPath: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {
          throw new Error("EACCES: permission denied, unlink '/tmp/ENOENT/mutate-stamp.json'")
        },
      }
      match(removeMutateStamp(dir, uncodedMessageWithEnoentPath))
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure).toContain("EACCES")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected Failure for uncoded error mentioning ENOENT")
        })
        .exhaustive()

      const nestedCauseEnoent: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {
          throw new Error("unlink wrapper failed", {
            cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
          })
        },
      }
      expect(removeMutateStamp(dir, nestedCauseEnoent)).toEqual(Result.succeed(undefined))

      const anchoredEnoentMsg: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {
          throw new Error("ENOENT: no such file or directory")
        },
      }
      expect(removeMutateStamp(dir, anchoredEnoentMsg)).toEqual(Result.succeed(undefined))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
