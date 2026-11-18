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
import { handleBench, handleMutate } from "../src/commands/mutate-and-bench.command.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"

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
        handleBench(["bench", "--iterations=1"], {
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
})
