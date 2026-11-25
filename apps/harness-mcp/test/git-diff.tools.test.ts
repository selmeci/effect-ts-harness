import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { match } from "ts-pattern"
import { CANONICAL_MCP_TOOL_NAMES, GitDiffExecutionError, McpToolName } from "@harness/contract"
import { decideSpanBudgets, type SpanSample } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { runWithTestTracer, type IndexedEffectFn, type RecordedSpanEvent } from "@harness/ingest"
import { executeGitDiffTool, GitDiffToolInputSchema } from "../src/tools/git-diff.tools.js"
import {
  formatMcpToolExit,
  type McpToolExecutionError,
  ProjectPathEscapeError,
  resolveDefaultRepoRoot,
} from "../src/tools/mcp-helpers.js"
import { dispatchMcpTool, makeMcpToolRegistryLayer } from "../src/tools/tool-registry.js"
import { buildGitDiffToolDescriptors } from "../src/tools/git-diff.tools.js"

const toSpanSamples = (spans: ReadonlyArray<RecordedSpanEvent>): ReadonlyArray<SpanSample> =>
  spans.map((s) => ({
    spanId: s.spanId,
    name: s.name,
    parentSpanId: s.parentSpanId,
    durationMs: s.durationMs,
    startTimeMs: s.startTimeMs,
    endTimeMs: s.endTimeMs,
    exitTag:
      s.exitTag === "Success" || s.exitTag === "Failure" || s.exitTag === "Defect"
        ? s.exitTag
        : undefined,
    errorTag: s.errorTag,
  }))

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const withTempDir = <A, E, R>(
  fn: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "harness-git-diff-"))),
    fn,
    (dir) =>
      Effect.sync(() => {
        fs.rmSync(dir, { recursive: true, force: true })
      }),
  )

const initGitRepo = (dir: string): void => {
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.name", "Harness Test"])
  git(dir, ["config", "user.email", "test@harness.local"])
}

const expectFailureError = <A>(
  eff: Effect.Effect<A, McpToolExecutionError>,
  onError: (err: McpToolExecutionError) => void,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(eff)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        const errOpt = Cause.findErrorOption(cause)
        match(errOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            onError(value)
          })
          .with({ _tag: "None" }, () => {
            expect.fail("Expected typed failure in cause")
          })
          .exhaustive()
      })
      .with({ _tag: "Success" }, () => {
        expect.fail("Expected Effect to fail")
      })
      .exhaustive()
  })

describe("HarnessMcp.gitDiff (harness:SPEC-0020 · 2)", () => {
  it("REQ-2.1: registers harness_git_diff in CANONICAL_MCP_TOOL_NAMES and validates GitDiffToolInputSchema bounds", () => {
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_git_diff"))
    const decoded = Schema.decodeSync(GitDiffToolInputSchema)({
      baseRef: "main",
      paths: ["libs/harness/gates"],
      statOnly: true,
      maxPatchChars: 4096,
    })
    expect(decoded.baseRef).toBe("main")
    expect(decoded.statOnly).toBe(true)

    expect(() => Schema.decodeSync(GitDiffToolInputSchema)({ maxPatchChars: 400_001 })).toThrow()
    expect(() => Schema.decodeSync(GitDiffToolInputSchema)({ maxPatchChars: -1 })).toThrow()
    expect(() => Schema.decodeSync(GitDiffToolInputSchema)({ maxPatchChars: 1.5 })).toThrow()
    expect(() => Schema.decodeSync(GitDiffToolInputSchema)({ repoRoot: "" })).toThrow()
    expect(() => Schema.decodeSync(GitDiffToolInputSchema)({ baseRef: "" })).toThrow()
  })

  it.effect(
    "REQ-2.1: diffs working tree modified tracked file and untracked text/binary previews",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "tracked.ts"), "export const a = 1\n", "utf8")
          git(dir, ["add", "tracked.ts"])
          git(dir, ["commit", "-m", "init"])

          fs.writeFileSync(path.join(dir, "tracked.ts"), "export const a = 2\n", "utf8")
          fs.writeFileSync(path.join(dir, "untracked.ts"), "export const b = 3\n", "utf8")
          fs.writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]))
          fs.writeFileSync(path.join(dir, "invalid-utf8.bin"), Buffer.from([0xff, 0xfe, 0x80]))

          const res = yield* executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir })
          expect(res._tag).toBe("PatchComplete")
          expect(res.resolvedBase).toBe("HEAD")
          expect(res.changedFiles).toEqual(["tracked.ts"])
          expect(res.untrackedFiles).toEqual(["binary.bin", "invalid-utf8.bin", "untracked.ts"])
          expect(res.stat).toContain("tracked.ts")
          expect(res.patch).toContain("diff --git a/tracked.ts b/tracked.ts")
          expect(res.patch).toContain("+export const a = 2")
          expect(res.patch).toContain("diff --git a/untracked.ts b/untracked.ts")
          expect(res.patch).toContain("+export const b = 3")
          expect(res.patch).toContain("Binary files /dev/null and b/binary.bin differ")
          expect(res.patch).toContain("Binary files /dev/null and b/invalid-utf8.bin differ")
          expect(res.truncated).toBe(false)
          expect(res.totalPatchChars).toBe(res.patch.length)
        }),
      ),
  )

  it.effect("REQ-2.1: supports baseRef merge-base diff combined with working tree edits", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        initGitRepo(dir)
        fs.writeFileSync(path.join(dir, "base.ts"), "export const v = 1\n", "utf8")
        git(dir, ["add", "base.ts"])
        git(dir, ["commit", "-m", "base"])
        const baseSha = git(dir, ["rev-parse", "HEAD"])

        git(dir, ["checkout", "-b", "feature"])
        fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1\n", "utf8")
        git(dir, ["add", "feature.ts"])
        git(dir, ["commit", "-m", "feature commit"])

        fs.writeFileSync(path.join(dir, "base.ts"), "export const v = 2\n", "utf8")

        const res = yield* executeGitDiffTool({ repoRoot: dir, baseRef: "main" }, { repoRoot: dir })
        expect(res.resolvedBase).toBe(baseSha)
        expect(res.changedFiles).toEqual(["base.ts", "feature.ts"])
        expect(res.patch).toContain("diff --git a/base.ts b/base.ts")
        expect(res.patch).toContain("diff --git a/feature.ts b/feature.ts")
      }),
    ),
  )

  it.effect("REQ-2.1: supports unborn repository diff against empty tree", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        initGitRepo(dir)
        fs.writeFileSync(path.join(dir, "new.ts"), "export const n = 1\n", "utf8")

        const res = yield* executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir })
        expect(res.resolvedBase).toBeNull()
        expect(res.untrackedFiles).toEqual(["new.ts"])
        expect(res.patch).toContain("diff --git a/new.ts b/new.ts")
        expect(res.patch).toContain("+export const n = 1")
      }),
    ),
  )

  it.effect("REQ-2.1: restricts changedFiles, untrackedFiles, and patch via paths filter", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        initGitRepo(dir)
        fs.mkdirSync(path.join(dir, "a"), { recursive: true })
        fs.mkdirSync(path.join(dir, "b"), { recursive: true })
        fs.writeFileSync(path.join(dir, "a", "one.ts"), "1\n", "utf8")
        fs.writeFileSync(path.join(dir, "b", "two.ts"), "2\n", "utf8")
        git(dir, ["add", "."])
        git(dir, ["commit", "-m", "init"])

        fs.writeFileSync(path.join(dir, "a", "one.ts"), "11\n", "utf8")
        fs.writeFileSync(path.join(dir, "b", "two.ts"), "22\n", "utf8")
        fs.writeFileSync(path.join(dir, "a", "extra.ts"), "extra-a\n", "utf8")
        fs.writeFileSync(path.join(dir, "b", "extra.ts"), "extra-b\n", "utf8")

        const res = yield* executeGitDiffTool({ repoRoot: dir, paths: ["a"] }, { repoRoot: dir })
        expect(res.changedFiles).toEqual(["a/one.ts"])
        expect(res.untrackedFiles).toEqual(["a/extra.ts"])
        expect(res.patch).toContain("a/one.ts")
        expect(res.patch).toContain("a/extra.ts")
        expect(res.patch).not.toContain("b/two.ts")
        expect(res.patch).not.toContain("b/extra.ts")
      }),
    ),
  )

  it.effect("REQ-2.1: statOnly returns metadata with empty patch and truncated=false", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        initGitRepo(dir)
        fs.writeFileSync(path.join(dir, "file.ts"), "const x = 1\n", "utf8")
        git(dir, ["add", "file.ts"])
        git(dir, ["commit", "-m", "init"])
        fs.writeFileSync(path.join(dir, "file.ts"), "const x = 2\n", "utf8")
        fs.writeFileSync(path.join(dir, "extra.ts"), "const y = 3\n", "utf8")

        const res = yield* executeGitDiffTool({ repoRoot: dir, statOnly: true }, { repoRoot: dir })
        expect(res._tag).toBe("StatOnly")
        expect(res.changedFiles).toEqual(["file.ts"])
        expect(res.untrackedFiles).toEqual(["extra.ts"])
        expect(res.stat).toContain("file.ts")
        expect(res.patch).toBe("")
        expect(res.totalPatchChars).toBe(0)
        expect(res.truncated).toBe(false)
      }),
    ),
  )

  it.effect(
    "REQ-2.1: bounds patch at maxPatchChars, handles maxPatchChars=0, and clamps oversized direct values",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "01-big.ts"), "line\n".repeat(40), "utf8")
          fs.writeFileSync(path.join(dir, "02-skip.ts"), "second\n".repeat(20), "utf8")

          const res = yield* executeGitDiffTool(
            { repoRoot: dir, maxPatchChars: 50 },
            { repoRoot: dir },
          )
          expect(res._tag).toBe("PatchTruncated")
          expect(res.truncated).toBe(true)
          expect(res.patch.length).toBeLessThanOrEqual(50)
          expect(res.totalPatchChars).toBeGreaterThan(50)
          expect(res.untrackedFiles).toEqual(["01-big.ts", "02-skip.ts"])

          const zeroRes = yield* executeGitDiffTool(
            { repoRoot: dir, maxPatchChars: 0 },
            { repoRoot: dir },
          )
          expect(zeroRes._tag).toBe("PatchBudgetZero")
          expect(zeroRes.patch).toBe("")
          expect(zeroRes.truncated).toBe(true)
          expect(zeroRes.untrackedFiles).toEqual(["01-big.ts", "02-skip.ts"])

          const clampedRes = yield* executeGitDiffTool(
            { repoRoot: dir, maxPatchChars: 999_999 },
            { repoRoot: dir },
          )
          expect(clampedRes._tag).toBe("PatchComplete")
          expect(clampedRes.truncated).toBe(false)
          expect(clampedRes.patch).toContain("02-skip.ts")
        }),
      ),
  )

  it.effect(
    "REQ-2.2: fails closed with GitDiffExecutionError on invalid inputs or non-git dir",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* expectFailureError(
            executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir }),
            (err) => {
              expect(err._tag).toBe("GitDiffExecutionError")
              if (err instanceof GitDiffExecutionError) {
                expect(err.reason.length).toBeGreaterThan(0)
              }
            },
          )

          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "a.ts"), "1\n", "utf8")
          git(dir, ["add", "a.ts"])
          git(dir, ["commit", "-m", "init"])

          const badRefs = [
            "-n",
            "--output=/tmp/x",
            "",
            "   ",
            "main branch",
            "main\n",
            "main\0",
            "nonexistent-ref",
          ]
          for (const badRef of badRefs) {
            yield* expectFailureError(
              executeGitDiffTool({ repoRoot: dir, baseRef: badRef }, { repoRoot: dir }),
              (err) => {
                expect(err._tag).toBe("GitDiffExecutionError")
                if (err instanceof GitDiffExecutionError) {
                  expect(err.reason.length).toBeGreaterThan(0)
                }
              },
            )
          }
        }),
      ),
  )

  it.effect("REQ-2.2: fails closed with ProjectPathEscapeError on paths escaping repoRoot", () =>
    withTempDir((dir) =>
      withTempDir((outsideDir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "a.ts"), "1\n", "utf8")
          git(dir, ["add", "a.ts"])
          git(dir, ["commit", "-m", "init"])

          yield* expectFailureError(
            executeGitDiffTool({ repoRoot: dir, paths: ["../outside"] }, { repoRoot: dir }),
            (err) => {
              expect(err._tag).toBe("ProjectPathEscapeError")
              if (err instanceof ProjectPathEscapeError) {
                expect(err.projectPath).toBe("../outside")
                expect(err.repoRoot).toBe(dir)
                expect(err.message.length).toBeGreaterThan(0)
              }
            },
          )

          fs.writeFileSync(path.join(outsideDir, "pnpm-workspace.yaml"), "packages: []\n", "utf8")
          const otherRepoFile = path.join(outsideDir, "secret.txt")
          fs.writeFileSync(otherRepoFile, "secret", "utf8")
          yield* expectFailureError(
            executeGitDiffTool({ paths: [otherRepoFile] }, { repoRoot: dir }),
            (err) => {
              expect(err._tag).toBe("ProjectPathEscapeError")
              if (err instanceof ProjectPathEscapeError) {
                expect(err.projectPath).toBe(otherRepoFile)
                expect(err.repoRoot).toBe(dir)
              }
            },
          )

          yield* expectFailureError(
            executeGitDiffTool({ repoRoot: dir, paths: [":/.env"] }, { repoRoot: dir }),
            (err) => {
              expect(err._tag).toBe("ProjectPathEscapeError")
              if (err instanceof ProjectPathEscapeError) {
                expect(err.projectPath).toBe(":/.env")
                expect(err.repoRoot).toBe(dir)
              }
            },
          )

          const linkPath = path.join(dir, "escape-link.txt")
          fs.symlinkSync(otherRepoFile, linkPath)
          yield* expectFailureError(
            executeGitDiffTool({ repoRoot: dir, paths: ["escape-link.txt"] }, { repoRoot: dir }),
            (err) => {
              expect(err._tag).toBe("ProjectPathEscapeError")
              if (err instanceof ProjectPathEscapeError) {
                expect(err.projectPath).toBe("escape-link.txt")
                expect(err.repoRoot).toBe(dir)
              }
            },
          )
        }),
      ),
    ),
  )

  it.effect(
    "REQ-2.1 / REQ-2.2: wires end-to-end through dispatchMcpTool and formatMcpToolExit for success and GitDiffExecutionError",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1\n", "utf8")
          git(dir, ["add", "a.ts"])
          git(dir, ["commit", "-m", "init"])
          fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 2\n", "utf8")

          const layer = makeMcpToolRegistryLayer(buildGitDiffToolDescriptors({ repoRoot: dir }))

          const okExit = yield* Effect.exit(
            dispatchMcpTool({
              toolName: "harness_git_diff",
              args: { statOnly: true },
            }).pipe(Effect.provide(layer)),
          )
          const okFormatted = formatMcpToolExit("harness_git_diff", okExit)
          if (okFormatted instanceof Promise) {
            expect.fail("Expected synchronous MCP exit formatting for success")
            return
          }
          expect(okFormatted.isError).not.toBe(true)
          expect(okFormatted.content[0]?.text).toContain('"changedFiles"')

          const errExit = yield* Effect.exit(
            dispatchMcpTool({
              toolName: "harness_git_diff",
              args: { baseRef: "-n" },
            }).pipe(Effect.provide(layer)),
          )
          const errFormatted = formatMcpToolExit("harness_git_diff", errExit)
          if (errFormatted instanceof Promise) {
            expect.fail("Expected synchronous MCP exit formatting for GitDiffExecutionError")
            return
          }
          expect(errFormatted.isError).toBe(true)
          expect(errFormatted.content[0]?.text).toContain("Invalid baseRef")
        }),
      ),
  )

  it.effect(
    "REQ-2.1: records HarnessMcp.gitDiff span with Success exitTag and zero span budget violations",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1\n", "utf8")
          git(dir, ["add", "a.ts"])
          git(dir, ["commit", "-m", "init"])
          fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 2\n", "utf8")

          const emptyFnIndex = new Map<string, IndexedEffectFn>()
          const { result, spans } = yield* runWithTestTracer(
            "HarnessMcp.gitDiff::span",
            executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir }),
            emptyFnIndex,
          )

          expect(result.changedFiles).toEqual(["a.ts"])
          const diffSpan = spans.find((s) => s.name === "HarnessMcp.gitDiff")
          expect(diffSpan).toBeDefined()
          expect(diffSpan?.durationMs).toBeGreaterThanOrEqual(0)
          expect(diffSpan?.exitTag).toBe("Success")

          const violations = yield* decideSpanBudgets({ spans: toSpanSamples(spans) })
          expect(violations).toHaveLength(0)
        }),
      ),
  )

  it.effect(
    "F-14.b: direct executeGitDiffTool calls reject invalid repoRoot and invalid maxPatchChars",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "a.ts"), "1\n", "utf8")
          git(dir, ["add", "a.ts"])
          git(dir, ["commit", "-m", "init"])

          yield* expectFailureError(executeGitDiffTool({ repoRoot: "" }), (err) => {
            expect(err._tag).toBe("GitDiffExecutionError")
          })
          for (const badMax of [-1, Number.NaN, 1.5]) {
            yield* expectFailureError(
              executeGitDiffTool({ repoRoot: dir, maxPatchChars: badMax }, { repoRoot: dir }),
              (err) => {
                expect(err._tag).toBe("GitDiffExecutionError")
              },
            )
          }
        }),
      ),
  )

  it.effect(
    "F-12.b / F-14.c: emits notice for untracked symlinks, uses bounded prefix reads, and fails closed on read error",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          initGitRepo(dir)
          fs.writeFileSync(path.join(dir, "tracked.ts"), "export const t = 1\n", "utf8")
          git(dir, ["add", "tracked.ts"])
          git(dir, ["commit", "-m", "init"])

          fs.symlinkSync(path.join(dir, "tracked.ts"), path.join(dir, "sym-untracked.ts"))
          const symRes = yield* executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir })
          expect(symRes._tag).toBe("PatchComplete")
          expect(symRes.patch).toContain("diff --git a/sym-untracked.ts b/sym-untracked.ts")
          expect(symRes.patch).toContain(
            "# [untracked entry omitted: symlink, directory, or non-regular file]",
          )
          fs.rmSync(path.join(dir, "sym-untracked.ts"), { force: true })

          const regularPath = path.join(dir, "large.txt")
          fs.writeFileSync(regularPath, "a".repeat(20_000), "utf8")
          const prefixSpy = vi.spyOn(nodeSyncHostIo, "readBytesPrefixSync")
          try {
            const boundedRes = yield* executeGitDiffTool(
              { repoRoot: dir, maxPatchChars: 128 },
              { repoRoot: dir },
            )
            expect(boundedRes._tag).toBe("PatchTruncated")
            expect(prefixSpy).toHaveBeenCalled()
            const maxBytesPassed = prefixSpy.mock.calls[0]?.[1]
            expect(typeof maxBytesPassed).toBe("number")
            expect(maxBytesPassed).toBeLessThan(10_000)
          } finally {
            prefixSpy.mockRestore()
          }

          const errSpy = vi.spyOn(nodeSyncHostIo, "readBytesPrefixSync").mockImplementation(() => {
            throw new Error("EACCES: permission denied")
          })
          try {
            yield* expectFailureError(
              executeGitDiffTool({ repoRoot: dir }, { repoRoot: dir }),
              (err) => {
                expect(err._tag).toBe("GitDiffExecutionError")
                if (err instanceof GitDiffExecutionError) {
                  expect(err.reason).toContain("Failed to read untracked file 'large.txt'")
                }
              },
            )
          } finally {
            errSpy.mockRestore()
          }
        }),
      ),
  )

  it("F-13.d: resolveDefaultRepoRoot warns to stderr when active-workspace.json fails to decode", () => {
    const activeWorkspacePath = path.join(
      path.resolve(import.meta.dirname, "../../.."),
      ".harness",
      "active-workspace.json",
    )
    const existsSpy = vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((target) => {
      if (target === activeWorkspacePath) return true
      return fs.existsSync(target)
    })
    const readSpy = vi.spyOn(nodeSyncHostIo, "readTextSync").mockImplementation((target) => {
      if (target === activeWorkspacePath) return "{corrupt-active-workspace"
      return fs.readFileSync(target, "utf8")
    })
    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    try {
      const resolved = resolveDefaultRepoRoot(undefined, {})
      expect(typeof resolved).toBe("string")
      expect(stderrChunks.join("")).toContain("failed to decode")
    } finally {
      stderrSpy.mockRestore()
      readSpy.mockRestore()
      existsSpy.mockRestore()
    }
  })

  it("SPEC-0024 REQ-1.1: resolveDefaultRepoRoot picks latest valid active-workspace.json across worktree and canonical root", () => {
    const serverRepoRoot = path.resolve(import.meta.dirname, "../../..")
    const localActivePath = path.join(serverRepoRoot, ".harness", "active-workspace.json")
    const gitCommonSpy = vi.spyOn(nodeSyncHostIo, "readTextSync")
    const tmpMain = fs.mkdtempSync(path.join(os.tmpdir(), "harness-active-main-"))
    const tmpWt = fs.mkdtempSync(path.join(os.tmpdir(), "harness-active-wt-"))
    fs.writeFileSync(path.join(tmpMain, "pnpm-workspace.yaml"), "packages: []\n", "utf8")
    fs.writeFileSync(path.join(tmpWt, "pnpm-workspace.yaml"), "packages: []\n", "utf8")
    const existsSpy = vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((target) => {
      if (target === localActivePath || target.endsWith("active-workspace.json")) return true
      return fs.existsSync(target)
    })
    gitCommonSpy.mockImplementation((target) => {
      if (target === localActivePath) {
        return JSON.stringify({ repoRoot: tmpMain, updatedAt: "2026-11-20T10:00:00.000Z" })
      }
      if (target.endsWith("active-workspace.json")) {
        return JSON.stringify({ repoRoot: tmpWt, updatedAt: "2026-11-20T12:00:00.000Z" })
      }
      return fs.readFileSync(target, "utf8")
    })
    try {
      const resolved = resolveDefaultRepoRoot(undefined, {})
      expect(resolved === tmpMain || resolved === tmpWt).toBe(true)
    } finally {
      gitCommonSpy.mockRestore()
      existsSpy.mockRestore()
      fs.rmSync(tmpMain, { recursive: true, force: true })
      fs.rmSync(tmpWt, { recursive: true, force: true })
    }
  })

  it.effect(
    "SPEC-0033: accepts linked worktree repoRoot and rejects external git repo escape",
    () =>
      withTempDir((tmpBase) =>
        Effect.gen(function* () {
          const mainRepo = path.join(tmpBase, "main-repo")
          const linkedWt = path.join(tmpBase, "linked-wt")
          const externalRepo = path.join(tmpBase, "external-repo")
          fs.mkdirSync(mainRepo, { recursive: true })
          fs.mkdirSync(externalRepo, { recursive: true })

          initGitRepo(mainRepo)
          fs.writeFileSync(path.join(mainRepo, "a.ts"), "export const a = 1\n", "utf8")
          git(mainRepo, ["add", "a.ts"])
          git(mainRepo, ["commit", "-m", "init"])
          git(mainRepo, ["worktree", "add", "-b", "wt-branch", linkedWt])

          fs.writeFileSync(path.join(linkedWt, "a.ts"), "export const a = 2\n", "utf8")

          initGitRepo(externalRepo)
          fs.writeFileSync(path.join(externalRepo, "ext.ts"), "export const e = 1\n", "utf8")
          git(externalRepo, ["add", "ext.ts"])
          git(externalRepo, ["commit", "-m", "init"])

          const wtRes = yield* executeGitDiffTool({ repoRoot: linkedWt }, { repoRoot: mainRepo })
          expect(wtRes.changedFiles).toEqual(["a.ts"])
          expect(wtRes.patch).toContain("+export const a = 2")

          yield* expectFailureError(
            executeGitDiffTool({ repoRoot: externalRepo }, { repoRoot: mainRepo }),
            (err) => {
              expect(err._tag).toBe("ProjectPathEscapeError")
              if (err instanceof ProjectPathEscapeError) {
                expect(err.projectPath).toBe(externalRepo)
              }
            },
          )
        }),
      ),
  )
})
