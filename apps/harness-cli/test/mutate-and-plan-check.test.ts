import { execFileSync } from "node:child_process"
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
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph, resolveOmnigraphTaskBranches } from "@harness/graph"
import {
  checkVerifyStamp,
  computeMutableTreeHashChecked,
  DstSeed,
  DstSeedsRunCount,
  MutantCount,
  MutateStampPassed,
  StampRelFilePath,
  writeMutateStamp,
  writeVerifyStamp,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  collectModifiedMutableFiles,
  evaluateVerifyMutateStampGate,
  handleBench,
  handleMutate,
} from "../src/commands/mutate-and-bench.command.js"
import { cleanupStalePlanSnapshotAfterDone } from "../src/commands/omnigraph-safety-helpers.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import { tryRunDocOnlyVerifyFastPath } from "../src/commands/verify-doc-fastpath.js"
import { runDeclarativeCli } from "../src/index.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const gitCommitAll = (cwd: string, message: string): void => {
  git(cwd, ["add", "-A"])
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message])
}

const initTempGitRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, ["init", "-b", "main"])
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.harness\n", "utf8")
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "temp-repo", type: "module" }),
    "utf8",
  )
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"))
  gitCommitAll(dir, "init")
  return dir
}

const writeDemoGatesPkg = (dir: string, engineSource: string, testSource: string): void => {
  const pkgDir = join(dir, "libs", "demo", "gates")
  mkdirSync(join(pkgDir, "src"), { recursive: true })
  mkdirSync(join(pkgDir, "test"), { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@demo/gates", nx: { tags: ["type:core"] } }),
    "utf8",
  )
  writeFileSync(join(pkgDir, "src", "engine.ts"), engineSource, "utf8")
  writeFileSync(join(pkgDir, "test", "engine.test.ts"), testSource, "utf8")
}

describe("CLI handleMutate, handleVerify (mutate-stamp), handleBench, and handlePlanCheck", () => {
  it("handleMutate discovers untracked libs/demo/gates/src/engine.ts (working-tree) with weak and strong tests", async () => {
    const dir = initTempGitRepo("cli-mut-untracked-")
    try {
      const engineSource = "export const isAdult = (age: number): boolean => age >= 18\n"
      const weakTest = [
        'import { expect, it } from "vitest"',
        'import { isAdult } from "../src/engine.js"',
        'it("weak", () => { expect(isAdult(20)).toBe(true) })',
      ].join("\n")

      writeDemoGatesPkg(dir, engineSource, weakTest)

      const weakRes = await Effect.runPromise(handleMutate(["mutate"], { repoRoot: dir }))
      expect(weakRes.exitCode).toBe(1)
      const weakReport = JSON.parse(weakRes.stdout) as {
        readonly passed: boolean
        readonly totalMutants: number
        readonly survivedCount: number
        readonly diffMode: string
      }
      expect(weakReport.diffMode).toBe("working-tree")
      expect(weakReport.totalMutants).toBe(1)
      expect(weakReport.survivedCount).toBe(1)

      const strongTest = [
        'import { expect, it } from "vitest"',
        'import { isAdult } from "../src/engine.js"',
        'it("strong", () => {',
        "  expect(isAdult(18)).toBe(true)",
        "  expect(isAdult(17)).toBe(false)",
        "})",
      ].join("\n")
      writeFileSync(
        join(dir, "libs", "demo", "gates", "test", "engine.test.ts"),
        strongTest,
        "utf8",
      )

      const strongRes = await Effect.runPromise(handleMutate(["mutate"], { repoRoot: dir }))
      expect(strongRes.exitCode).toBe(0)
      const strongReport = JSON.parse(strongRes.stdout) as {
        readonly passed: boolean
        readonly totalMutants: number
        readonly killedCount: number
        readonly diffMode: string
      }
      expect(strongReport.diffMode).toBe("working-tree")
      expect(strongReport.totalMutants).toBe(1)
      expect(strongReport.killedCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("handleMutate --strict falls back to branch-base on clean feature branch and writes strict mutate-stamp.json", async () => {
    const dir = initTempGitRepo("cli-mut-branch-")
    try {
      git(dir, ["checkout", "-b", "feat/test"])
      writeDemoGatesPkg(
        dir,
        "export const isSame = (a: number, b: number): boolean => a === b\n",
        [
          'import { expect, it } from "vitest"',
          'import { isSame } from "../src/engine.js"',
          'it("kills ===", () => {',
          "  expect(isSame(1, 1)).toBe(true)",
          "  expect(isSame(1, 2)).toBe(false)",
          "})",
        ].join("\n"),
      )
      gitCommitAll(dir, "add demo gates")

      const res = await Effect.runPromise(handleMutate(["mutate", "--strict"], { repoRoot: dir }))
      expect(res.exitCode).toBe(0)
      const report = JSON.parse(res.stdout) as {
        readonly passed: boolean
        readonly diffMode: string
        readonly killedCount: number
      }
      expect(report.passed).toBe(true)
      expect(report.diffMode).toBe("branch-base")
      expect(report.killedCount).toBe(1)

      const stampPath = join(dir, ".harness", "mutate-stamp.json")
      expect(existsSync(stampPath)).toBe(true)
      const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
        readonly enforcementMode: string
        readonly diffMode: string
        readonly killedCount: number
      }
      expect(stamp.enforcementMode).toBe("strict")
      expect(stamp.diffMode).toBe("branch-base")
      expect(stamp.killedCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("handleMutate --strict fails closed on --scope=nonexistent, --file=libs/missing.ts, unclassified package, and deletes stale stamp", async () => {
    const dir = initTempGitRepo("cli-mut-strict-fail-")
    try {
      const stampDir = join(dir, ".harness")
      const stampPath = join(stampDir, "mutate-stamp.json")
      mkdirSync(stampDir, { recursive: true })
      writeFileSync(stampPath, JSON.stringify({ stale: true }), "utf8")

      const badScope = await Effect.runPromise(
        handleMutate(["mutate", "--strict", "--scope=nonexistent"], { repoRoot: dir }),
      )
      expect(badScope.exitCode).toBe(1)
      expect(existsSync(stampPath)).toBe(false)

      writeFileSync(stampPath, JSON.stringify({ stale: true }), "utf8")
      const badFile = await Effect.runPromise(
        handleMutate(["mutate", "--strict", "--file=libs/missing.ts"], { repoRoot: dir }),
      )
      expect(badFile.exitCode).toBe(1)
      expect(existsSync(stampPath)).toBe(false)

      const mysteryDir = join(dir, "libs", "demo", "mystery")
      mkdirSync(join(mysteryDir, "src"), { recursive: true })
      writeFileSync(
        join(mysteryDir, "package.json"),
        JSON.stringify({ name: "@demo/mystery", nx: { tags: [] } }),
        "utf8",
      )
      writeFileSync(
        join(mysteryDir, "src", "x.ts"),
        "export const x = (n: number) => n >= 1\n",
        "utf8",
      )

      writeFileSync(stampPath, JSON.stringify({ stale: true }), "utf8")
      const unclassRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(unclassRes.exitCode).toBe(1)
      expect(unclassRes.stderr).toContain("Unclassified modified lib file")
      expect(existsSync(stampPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handleVerify with mutateStampPolicy=enforce fails without stamp, fails on stale treeHash, and passes with strict stamp", async () => {
    const dir = initTempGitRepo("cli-verify-stamp-")
    try {
      git(dir, ["checkout", "-b", "feat/verify-stamp"])
      writeDemoGatesPkg(
        dir,
        "export const isPositive = (n: number): boolean => n >= 1\n",
        [
          'import { expect, it } from "vitest"',
          'import { isPositive } from "../src/engine.js"',
          'it("kills >=", () => {',
          "  expect(isPositive(1)).toBe(true)",
          "  expect(isPositive(0)).toBe(false)",
          "})",
        ].join("\n"),
      )
      gitCommitAll(dir, "add gates")

      const verifyOpts = {
        repoRoot: dir,
        skipSubprocessVerify: true,
        skipBackgroundDaemons: true,
        skipAutoSessionReport: true,
        mutateStampPolicy: "enforce" as const,
        decisionLayer: makeMockDecisionModelLayer(),
      }

      // 1. Fails closed without .harness/mutate-stamp.json
      const noStampRes = await Effect.runPromise(handleVerify(verifyOpts))
      expect(noStampRes.exitCode).toBe(1)
      expect(noStampRes.stderr).toContain("verify:mutate-stamp")

      // 2. Run mutate --strict to write valid stamp
      const mutRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(mutRes.exitCode).toBe(0)

      // 3. Edit file -> treeHash mismatch -> verify fails closed
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isPositive = (n: number): boolean => n >= 1 // edited\n",
        "utf8",
      )
      const staleRes = await Effect.runPromise(handleVerify(verifyOpts))
      expect(staleRes.exitCode).toBe(1)
      expect(staleRes.stderr).toContain("verify:mutate-stamp")

      // 4. Re-run mutate --strict -> verify passes and records mutate metadata in verify-stamp.json
      const mutRes2 = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(mutRes2.exitCode).toBe(0)

      const passRes = await Effect.runPromise(handleVerify(verifyOpts))
      expect(passRes.exitCode).toBe(0)

      const verifyStampPath = join(dir, ".harness", "verify-stamp.json")
      expect(existsSync(verifyStampPath)).toBe(true)
      const verifyStamp = JSON.parse(readFileSync(verifyStampPath, "utf8")) as {
        readonly mutateEnforcementMode?: string
        readonly mutantsEvaluated?: number
      }
      expect(verifyStamp.mutateEnforcementMode).toBe("strict")
      expect(verifyStamp.mutantsEvaluated).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("handleBench --iterations=1 includes PlanWorkflowCompiler.decide in measurements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-bench-pwc-"))
    try {
      const sampleSrc = join(dir, "libs", "sample", "domain", "src")
      mkdirSync(sampleSrc, { recursive: true })
      writeFileSync(join(sampleSrc, "index.ts"), "export const x = 1\n", "utf8")

      const res = await Effect.runPromise(
        handleBench(["bench", "--iterations=1", "--budget-ms=5000"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(0)
      const json = JSON.parse(res.stdout) as {
        readonly overallStatus: string
        readonly measurements: ReadonlyArray<{ readonly stage: string }>
      }
      expect(json.overallStatus).toBe("passed")
      expect(json.measurements.some((m) => m.stage === "PlanWorkflowCompiler.decide")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handlePlanCheck --graph-only allows IGNORED_ERRORS (OutboxPublishError, ProjectPathEscapeError) and fails closed on unignored dead TaggedError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-plancheck-deaderr-"))
    try {
      const srcDir = join(dir, "libs", "sample", "src")
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(
        join(srcDir, "a.ts"),
        'import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n',
        "utf8",
      )

      const passRes = await Effect.runPromise(
        handlePlanCheck(["plan-check", "--graph-only"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipSubprocessVerify: true,
          governanceDocs: [
            {
              docPath: "docs/spec.md",
              id: "spec-001",
              status: "accepted",
              referencedErrors: ["OutboxPublishError", "ProjectPathEscapeError"],
            },
          ],
        }),
      )
      expect(passRes.exitCode).toBe(0)

      const failRes = await Effect.runPromise(
        handlePlanCheck(["plan-check", "--graph-only"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipSubprocessVerify: true,
          governanceDocs: [
            {
              docPath: "docs/spec.md",
              id: "spec-001",
              status: "accepted",
              referencedErrors: ["PhantomWorkflowError"],
            },
          ],
        }),
      )
      expect(failRes.exitCode).toBe(1)
      expect(failRes.stdout).toContain("[dead-tagged-error]")
      expect(failRes.stdout).toContain("PhantomWorkflowError")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("evaluateVerifyMutateStampGate full decision matrix: skip, skipSubprocessVerify, isolated workspace, diff-failed, uncovered dirty, and unclassified dirty", () => {
    const dir = initTempGitRepo("cli-gate-matrix-")
    try {
      const strongTest = [
        'import { expect, it } from "vitest"',
        'import { isAdult } from "../src/engine.js"',
        'it("strong", () => { expect(isAdult(21)).toBe(true); expect(isAdult(20)).toBe(false) })',
      ].join("\n")
      writeDemoGatesPkg(
        dir,
        "export const isAdult = (age: number): boolean => age >= 18\n",
        strongTest,
      )

      // 1. Isolated external workspace (no cluster.yaml) with policy: undefined -> bypasses
      expect(evaluateVerifyMutateStampGate(dir, { repoRoot: dir })).toBeUndefined()

      // 2. Isolated external workspace with policy: "enforce" -> enforces and fails without stamp
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "enforce" }),
      ).toContain("Missing .harness/mutate-stamp.json")

      // Make it non-isolated by adding cluster.yaml
      mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")

      // 3. mutateStampPolicy: "skip" -> bypasses even when non-isolated & dirty
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "skip" }),
      ).toBeUndefined()

      // 4. skipSubprocessVerify: true with policy: undefined -> bypasses; with "enforce" -> enforces
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, skipSubprocessVerify: true }),
      ).toBeUndefined()
      expect(
        evaluateVerifyMutateStampGate(dir, {
          repoRoot: dir,
          skipSubprocessVerify: true,
          mutateStampPolicy: "enforce",
        }),
      ).toContain("Missing .harness/mutate-stamp.json")

      // 5. diff-failed -> fails closed
      const diffFailIo: SyncHostIo = {
        ...nodeSyncHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse")) {
            return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "fatal: not a git repo" }
          }
          return nodeSyncHostIo.execFileSync(_cmd, args)
        },
      }
      expect(
        evaluateVerifyMutateStampGate(
          dir,
          { repoRoot: dir, mutateStampPolicy: "enforce" },
          diffFailIo,
        ),
      ).toContain("git rev-parse")

      // 6. dirty with uncovered modified mutable file fails even when stamp treeHash matches and totalMutants >= 1
      writeMutateStamp(dir, nodeSyncHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/gates/src/other.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/gates/src/other.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/gates/src/other.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "enforce" }),
      ).toContain("does not cover required diff file(s): libs/demo/gates/src/engine.ts")

      // 7. dirty with unclassified modified lib file fails closed
      const unclassDir = join(dir, "libs", "demo", "mystery")
      mkdirSync(join(unclassDir, "src"), { recursive: true })
      writeFileSync(
        join(unclassDir, "package.json"),
        JSON.stringify({ name: "@demo/mystery", nx: { tags: ["type:unknown"] } }),
        "utf8",
      )
      writeFileSync(join(unclassDir, "src", "mystery.ts"), "export const m = 1\n", "utf8")
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "enforce" }),
      ).toContain("Unclassified modified lib file(s)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handleMutate CLI integration: failing strict deletes stamp; --scope/--file/--base never write stamp; --file= and 0-mutant strict fail closed", async () => {
    const dir = initTempGitRepo("cli-mut-integration-")
    try {
      const engineSource = "export const isAdult = (age: number): boolean => age >= 18\n"
      const strongTest = [
        'import { expect, it } from "vitest"',
        'import { isAdult } from "../src/engine.js"',
        'it("strong", () => { expect(isAdult(21)).toBe(true); expect(isAdult(20)).toBe(false) })',
      ].join("\n")
      writeDemoGatesPkg(dir, engineSource, strongTest)
      gitCommitAll(dir, "add demo")
      git(dir, ["checkout", "-b", "feat/cli-int"])
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isAdult = (age: number): boolean => age >= 21\n",
        "utf8",
      )
      gitCommitAll(dir, "update age")

      const stampPath = join(dir, ".harness", "mutate-stamp.json")

      // 1. --scope, --file, and --base NEVER write a stamp even on passing --strict
      for (const extraFlag of [
        "--scope=@demo/gates",
        "--file=libs/demo/gates/src/engine.ts",
        "--base=main",
      ]) {
        if (existsSync(stampPath)) rmSync(stampPath)
        const res = await Effect.runPromise(
          handleMutate(["mutate", "--strict", extraFlag], { repoRoot: dir }),
        )
        expect(res.exitCode, extraFlag).toBe(0)
        expect(existsSync(stampPath), extraFlag).toBe(false)
      }

      // 2. --file= empty, bare --base/--file/--scope, and --base -foo fail closed (exitCode === 1) without minting stamp and remove existing stamp
      for (const badArgs of [
        ["mutate", "--strict", "--file="],
        ["mutate", "--strict", "--file"],
        ["mutate", "--strict", "--scope"],
        ["mutate", "--strict", "--base"],
        ["mutate", "--strict", "--base", "-foo"],
      ]) {
        writeMutateStamp(dir, nodeSyncHostIo, {
          enforcementMode: "strict",
          diffMode: "working-tree",
          scannedCandidateFiles: MutantCount.make(1),
          scannedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
          diffMatchedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
          evaluatedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
          totalMutants: MutantCount.make(1),
          killedCount: MutantCount.make(1),
          survivedCount: MutantCount.make(0),
          equivalentCount: MutantCount.make(0),
          passed: MutateStampPassed.make(true),
        })
        expect(existsSync(stampPath)).toBe(true)
        const badRes = await Effect.runPromise(handleMutate(badArgs, { repoRoot: dir }))
        expect(badRes.exitCode, badArgs.join(" ")).toBe(1)
        expect(existsSync(stampPath), badArgs.join(" ")).toBe(false)
      }

      // 3. Failing mutate --strict deletes existing valid stamp
      writeMutateStamp(dir, nodeSyncHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/gates/src/engine.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      writeFileSync(
        join(dir, "libs", "demo", "gates", "test", "engine.test.ts"),
        'import { expect, it } from "vitest"\nimport { isAdult } from "../src/engine.js"\nit("weak", () => { expect(isAdult(30)).toBe(true) })\n',
        "utf8",
      )
      const failStrictRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(failStrictRes.exitCode).toBe(1)
      expect(existsSync(stampPath)).toBe(false)

      // 4. 0-mutant strict run fails closed (exitCode === 1)
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const VERSION = 1\n",
        "utf8",
      )
      const zeroMutantRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(zeroMutantRes.exitCode).toBe(1)
      expect(existsSync(stampPath)).toBe(false)

      // 5. --strict --all with 0-mutant contract sibling passes evaluateVerifyMutateStampGate E2E
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isAdult = (age: number): boolean => age >= 21\n",
        "utf8",
      )
      writeFileSync(
        join(dir, "libs", "demo", "gates", "test", "engine.test.ts"),
        strongTest,
        "utf8",
      )
      const contractDir = join(dir, "libs", "demo", "contract")
      mkdirSync(join(contractDir, "src"), { recursive: true })
      writeFileSync(
        join(contractDir, "package.json"),
        JSON.stringify({ name: "@demo/contract", nx: { tags: ["type:contract"] } }),
        "utf8",
      )
      writeFileSync(join(contractDir, "src", "types.ts"), "export const KIND = 'v1'\n", "utf8")

      expect(collectModifiedMutableFiles(dir)._tag).toBe("Dirty")
      const allRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict", "--all"], { repoRoot: dir }),
      )
      expect(allRes.exitCode).toBe(0)
      expect(existsSync(stampPath)).toBe(true)
      expect(
        evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "enforce" }),
      ).toBeUndefined()

      // 6. Warm second mutate run hits mutant cache (cachedKilledCount > 0), and --no-cache bypasses it
      const warmRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(warmRes.exitCode).toBe(0)
      const warmReport = JSON.parse(warmRes.stdout) as { cachedKilledCount?: number }
      expect(warmReport.cachedKilledCount).toBeGreaterThan(0)

      rmSync(stampPath, { force: true })
      const noCacheRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict", "--no-cache"], { repoRoot: dir }),
      )
      expect(noCacheRes.exitCode).toBe(0)
      const noCacheReport = JSON.parse(noCacheRes.stdout) as { cachedKilledCount?: number }
      expect(noCacheReport.cachedKilledCount ?? 0).toBe(0)
      expect(existsSync(stampPath)).toBe(true)

      // 7. F-2.1b: handleMutate wires out-of-workspace HMAC secret and isolates cache per secret
      const prevXdg = process.env.XDG_CACHE_HOME
      const cacheHomeA = mkdtempSync(join(tmpdir(), "harness-hmac-a-"))
      const cacheHomeB = mkdtempSync(join(tmpdir(), "harness-hmac-b-"))
      try {
        process.env.XDG_CACHE_HOME = cacheHomeA
        const primeA = await Effect.runPromise(
          handleMutate(["mutate", "--strict"], { repoRoot: dir }),
        )
        expect(primeA.exitCode).toBe(0)
        const hitA = await Effect.runPromise(
          handleMutate(["mutate", "--strict"], { repoRoot: dir }),
        )
        expect(hitA.exitCode).toBe(0)
        expect(
          (JSON.parse(hitA.stdout) as { cachedKilledCount?: number }).cachedKilledCount,
        ).toBeGreaterThan(0)

        process.env.XDG_CACHE_HOME = cacheHomeB
        const missB = await Effect.runPromise(
          handleMutate(["mutate", "--strict"], { repoRoot: dir }),
        )
        expect(missB.exitCode).toBe(0)
        expect(
          (JSON.parse(missB.stdout) as { cachedKilledCount?: number }).cachedKilledCount ?? 0,
        ).toBe(0)
      } finally {
        if (prevXdg === undefined) Reflect.deleteProperty(process.env, "XDG_CACHE_HOME")
        else process.env.XDG_CACHE_HOME = prevXdg
        rmSync(cacheHomeA, { recursive: true, force: true })
        rmSync(cacheHomeB, { recursive: true, force: true })
      }
      // 8. REQ-1.3: --diff filters to branch-base changed lines on explicit --file and never writes mutate-stamp.json
      rmSync(stampPath, { force: true })
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isAdult = (age: number): boolean => age >= 21\n",
        "utf8",
      )
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "base-engine"], { cwd: dir })
      execFileSync("git", ["update-ref", "refs/heads/main", "HEAD"], { cwd: dir })
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isAdult = (age: number): boolean => age >= 21\nexport const isSenior = (age: number): boolean => age >= 65\n",
        "utf8",
      )
      writeFileSync(
        join(dir, "libs", "demo", "gates", "test", "engine.test.ts"),
        'import { expect, it } from "vitest"\nimport { isAdult, isSenior } from "../src/engine.js"\nit("adult", () => { expect(isAdult(21)).toBe(true); expect(isAdult(20)).toBe(false) })\nit("senior", () => { expect(isSenior(65)).toBe(true); expect(isSenior(64)).toBe(false) })\n',
        "utf8",
      )
      const cliDiffRes = await Effect.runPromise(
        runDeclarativeCli(
          ["mutate", "--file", "libs/demo/gates/src/engine.ts", "--diff", "--strict"],
          { repoRoot: dir, skipBackgroundDaemons: true },
        ),
      )
      expect(cliDiffRes.exitCode).toBe(0)
      const cliDiffReport = JSON.parse(cliDiffRes.stdout) as {
        diffMode: string
        totalMutants: number
      }
      expect(cliDiffReport.diffMode).toBe("branch-base")
      expect(cliDiffReport.totalMutants).toBe(1)
      expect(existsSync(stampPath)).toBe(false)

      const diffAllRes = await Effect.runPromise(
        runDeclarativeCli(
          ["mutate", "--file", "libs/demo/gates/src/engine.ts", "--diff", "--all", "--strict"],
          { repoRoot: dir, skipBackgroundDaemons: true },
        ),
      )
      expect(diffAllRes.exitCode).toBe(0)
      const diffAllReport = JSON.parse(diffAllRes.stdout) as { totalMutants: number }
      expect(diffAllReport.totalMutants).toBe(2)
      expect(existsSync(stampPath)).toBe(false)

      const unscopedDiffRes = await Effect.runPromise(
        handleMutate(["mutate", "--diff", "--strict"], { repoRoot: dir }),
      )
      expect(unscopedDiffRes.exitCode).toBe(0)
      expect(existsSync(stampPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-4.3 & REQ-4.4: doc-only handleVerify fast-path skips subprocess verify on matching mutableTreeHash and cleanupStalePlanSnapshotAfterDone removes stale snapshot", async () => {
    const dir = initTempGitRepo("harness-doc-fastpath-")
    try {
      git(dir, ["checkout", "-b", "feat/doc-fastpath"])
      writeDemoGatesPkg(
        dir,
        "export const isEven = (n: number): boolean => n % 2 === 0\n",
        [
          'import { expect, it } from "vitest"',
          'import { isEven } from "../src/engine.js"',
          'it("kills %", () => { expect(isEven(2)).toBe(true); expect(isEven(3)).toBe(false) })',
        ].join("\n"),
      )
      writeFileSync(join(dir, "README.md"), "# initial readme\n", "utf8")
      gitCommitAll(dir, "add gates")

      // 1. Prime mutate-stamp & verify-stamp (with mutableTreeHash and branch)
      const mutRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict"], { repoRoot: dir }),
      )
      expect(mutRes.exitCode).toBe(0)

      const { implBranch } = resolveOmnigraphTaskBranches(dir, nodeSyncHostIo)
      const initialStamp = writeVerifyStamp(dir, nodeSyncHostIo, implBranch, {
        dstSeed: DstSeed.make(12345),
        dstSeedsRun: DstSeedsRunCount.make(42),
      })
      expect(initialStamp.mutableTreeHash).toBeDefined()

      // 2. Modify markdown only -> handleVerify WITHOUT skipSubprocessVerify takes fast-path without invoking Nx/pnpm
      writeFileSync(join(dir, "README.md"), "# updated markdown only\n", "utf8")
      const fastPathRes = await Effect.runPromise(
        handleVerify({
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipAutoSessionReport: true,
          mutateStampPolicy: "enforce",
          decisionLayer: makeMockDecisionModelLayer(),
        }),
      )
      expect(fastPathRes.exitCode).toBe(0)
      const refreshedCheck = checkVerifyStamp(dir, nodeSyncHostIo)
      expect(refreshedCheck.valid).toBe(true)
      if (refreshedCheck.valid) {
        expect(refreshedCheck.stamp.mutableTreeHash).toBe(initialStamp.mutableTreeHash)
        expect(refreshedCheck.stamp.treeHash).not.toBe(initialStamp.treeHash)
        expect(refreshedCheck.stamp.dstSeed).toBe(12345)
      }

      // 3. Direct tryRunDocOnlyVerifyFastPath checks: branch mismatch returns undefined, GC failure fails closed
      const emptyGraph = buildHarnessGraph({
        fns: [],
        services: [],
        layers: [],
        errors: [],
        tests: [],
      })
      const mismatchRes = await Effect.runPromise(
        tryRunDocOnlyVerifyFastPath({
          repoRoot: dir,
          graph: emptyGraph,
          governanceDocs: [],
          implBranch: "impl/other-branch",
          options: { repoRoot: dir },
        }),
      )
      expect(mismatchRes).toBeUndefined()

      const gcFailRes = await Effect.runPromise(
        tryRunDocOnlyVerifyFastPath({
          repoRoot: dir,
          graph: emptyGraph,
          governanceDocs: [
            {
              id: "harness:SPEC-9999",
              docPath: "libs/harness/docs/specs/bad.md",
              status: "accepted",
              markdown:
                "## Requirements\n\n### 1 · Bad\n**Source:** t\n\n| ID | Pattern | Requirement | Effect Symbol | Verification |\n|---|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The system should fail. | x | test |\n",
              enforcedByFiles: [],
            },
          ],
          implBranch,
          options: { repoRoot: dir },
        }),
      )
      expect(gcFailRes?.exitCode).toBe(1)
      expect(gcFailRes?.stderr).toContain("verify:gc-doc-only")

      // 4. Editing .ts code bypasses fast path (mutableTreeHash mismatches)
      writeFileSync(
        join(dir, "libs", "demo", "gates", "src", "engine.ts"),
        "export const isEven = (n: number): boolean => n % 2 === 0 // code edit\n",
        "utf8",
      )
      const codeEditedFastPath = await Effect.runPromise(
        tryRunDocOnlyVerifyFastPath({
          repoRoot: dir,
          graph: emptyGraph,
          governanceDocs: [],
          implBranch,
          options: { repoRoot: dir },
        }),
      )
      expect(codeEditedFastPath).toBeUndefined()
      expect(computeMutableTreeHashChecked(dir, nodeSyncHostIo)._tag).toBe("Success")

      // 5. cleanupStalePlanSnapshotAfterDone removes .harness/plan-graph-snapshot.json, no-ops if absent, fails on symlink/unlink error
      const planSnapPath = join(dir, ".harness", "plan-graph-snapshot.json")
      writeFileSync(planSnapPath, "{}", "utf8")
      expect(cleanupStalePlanSnapshotAfterDone(dir, nodeSyncHostIo)).toBeUndefined()
      expect(existsSync(planSnapPath)).toBe(false)
      expect(cleanupStalePlanSnapshotAfterDone(dir, nodeSyncHostIo)).toBeUndefined()

      writeFileSync(planSnapPath, "{}", "utf8")
      const symlinkIo: SyncHostIo = {
        ...nodeSyncHostIo,
        isSymbolicLinkSync: (p) =>
          p === planSnapPath ? true : nodeSyncHostIo.isSymbolicLinkSync(p),
      }
      expect(cleanupStalePlanSnapshotAfterDone(dir, symlinkIo)).toContain("Refusing symlink")

      const failUnlinkIo: SyncHostIo = {
        ...nodeSyncHostIo,
        isSymbolicLinkSync: () => false,
        unlinkSync: () => {
          throw new Error("EPERM")
        },
      }
      expect(cleanupStalePlanSnapshotAfterDone(dir, failUnlinkIo)).toContain("EPERM")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
