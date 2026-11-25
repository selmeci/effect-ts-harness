import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it, vi } from "vitest"
import { ReviewDepth, ReviewRouteToolOutput } from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { decideSessionReport, readTelemetryEvents } from "@harness/gates"
import { buildHarnessGraph, resolveCanonicalRepoRoot } from "@harness/graph"
import { runWithTestTracer, type IndexedEffectFn } from "@harness/ingest"
import { nodeSyncHostIo } from "@harness/infra"
import { executeToolEffect } from "../src/server.js"
import {
  isPathInsideRoot,
  ProjectPathEscapeError,
  recordMcpToolTelemetry,
  resolveContainedRepoRoot,
  resolveDefaultRepoRoot,
  SERVER_REPO_ROOT,
} from "../src/tools/mcp-helpers.js"

const runGit = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", [...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
}

const expectProjectPathEscape = async <A, E>(
  effect: Effect.Effect<A, E>,
  expectedProjectPath?: string,
  expectedRepoRoot?: string,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect)
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toBeInstanceOf(ProjectPathEscapeError)
          if (expectedProjectPath !== undefined && value instanceof ProjectPathEscapeError) {
            expect(value.projectPath).toBe(expectedProjectPath)
          }
          if (expectedRepoRoot !== undefined && value instanceof ProjectPathEscapeError) {
            expect(value.repoRoot).toBe(expectedRepoRoot)
          }
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected ProjectPathEscapeError failure")
        })
        .exhaustive()
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable("Expected ProjectPathEscapeError, got Success")
    })
    .exhaustive()
}

describe("worktree routing and degraded telemetry (REQ-1.1 .. REQ-1.4)", () => {
  it("REQ-1.1: resolveDefaultRepoRoot skips cwd missing pnpm-workspace.yaml and picks active-workspace.json", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req11-"))
    const staleCwd = path.join(tmpBase, "stale-cwd")
    const activeTarget = path.join(tmpBase, "active-target")
    fs.mkdirSync(staleCwd, { recursive: true })
    fs.mkdirSync(activeTarget, { recursive: true })
    fs.writeFileSync(path.join(activeTarget, "pnpm-workspace.yaml"), "packages: []\n")

    const localActivePath = path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")
    const existsSpy = vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((target) => {
      if (target === localActivePath) return true
      return fs.existsSync(target)
    })
    const readSpy = vi.spyOn(nodeSyncHostIo, "readTextSync").mockImplementation((target) => {
      if (target === localActivePath) {
        return JSON.stringify({
          repoRoot: activeTarget,
          updatedAt: "2099-01-01T00:00:00.000Z",
        })
      }
      return fs.readFileSync(target, "utf8")
    })

    try {
      const resolved = resolveDefaultRepoRoot(undefined, { cwd: staleCwd })
      expect(resolved).toBe(activeTarget)

      const deletedCwd = path.join(tmpBase, "deleted-cwd")
      const resolvedDeleted = resolveDefaultRepoRoot(undefined, { cwd: deletedCwd })
      expect(resolvedDeleted).toBe(activeTarget)
    } finally {
      readSpy.mockRestore()
      existsSpy.mockRestore()
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.4: recordMcpToolTelemetry records degraded=reason with outcome=fallback", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req14-"))
    try {
      recordMcpToolTelemetry(
        "harness_review_route",
        { repoRoot: tmpDir },
        { degraded: true, degradedReason: "corrupt-graph-snapshot" },
        12,
        { repoRoot: tmpDir },
      )
      recordMcpToolTelemetry(
        "harness_resolve",
        { repoRoot: tmpDir },
        { degraded: true, degradedReason: "   " },
        5,
        { repoRoot: tmpDir },
      )

      recordMcpToolTelemetry(
        "harness_resolve",
        { repoRoot: "   " },
        { degraded: true, degradedReason: "x".repeat(200) },
        5,
        { repoRoot: tmpDir },
      )
      recordMcpToolTelemetry(
        "harness_review_route",
        { repoRoot: "libs/pkg" },
        { degraded: true, degradedReason: "multiline\n  reason   here" },
        8,
        { repoRoot: tmpDir },
      )

      const events = readTelemetryEvents(tmpDir, nodeSyncHostIo)
      expect(events).toHaveLength(4)
      expect(events[0]).toMatchObject({
        toolName: "harness_review_route",
        outcome: "fallback",
        detail: "degraded=corrupt-graph-snapshot",
      })
      expect(events[1]).toMatchObject({
        toolName: "harness_resolve",
        outcome: "fallback",
        detail: "degraded=degraded",
      })
      expect(events[2]?.detail?.length).toBe(160)
      expect(events[3]).toMatchObject({
        toolName: "harness_review_route",
        outcome: "fallback",
        detail: "degraded=multiline reason here",
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("REQ-1.2 & REQ-1.3: accepts linked git worktree and rejects external git repo or symlink escape", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req12-"))
    const mainRepo = path.join(tmpBase, "main-repo")
    const linkedWt = path.join(tmpBase, "linked-wt")
    const externalRepo = path.join(tmpBase, "external-repo")
    const symlinkToWt = path.join(tmpBase, "symlink-wt")

    try {
      fs.mkdirSync(mainRepo, { recursive: true })
      runGit(mainRepo, ["init", "-b", "main"])
      fs.writeFileSync(path.join(mainRepo, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      fs.mkdirSync(path.join(mainRepo, "libs", "pkg", "src"), { recursive: true })
      fs.writeFileSync(
        path.join(mainRepo, "libs", "pkg", "project.json"),
        JSON.stringify({ tags: ["type:domain"] }),
      )
      fs.writeFileSync(
        path.join(mainRepo, "libs", "pkg", "src", "index.ts"),
        "export const a = 1\n",
      )
      runGit(mainRepo, ["add", "."])
      runGit(mainRepo, ["commit", "-m", "init"])
      runGit(mainRepo, ["worktree", "add", "-b", "wt-branch", linkedWt])

      fs.mkdirSync(externalRepo, { recursive: true })
      runGit(externalRepo, ["init", "-b", "main"])
      fs.writeFileSync(path.join(externalRepo, "README.md"), "external\n")
      runGit(externalRepo, ["add", "."])
      runGit(externalRepo, ["commit", "-m", "init"])

      fs.symlinkSync(linkedWt, symlinkToWt, "dir")

      const realLinkedWt = fs.realpathSync.native(linkedWt)
      const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })

      const resolvedWt = await Effect.runPromise(
        resolveContainedRepoRoot(linkedWt, { repoRoot: mainRepo }),
      )
      expect(resolvedWt).toBe(realLinkedWt)

      await expectProjectPathEscape(
        resolveContainedRepoRoot(externalRepo, { repoRoot: mainRepo }),
        externalRepo,
        mainRepo,
      )
      const externalSubdir = path.join(externalRepo, "libs", "foo")
      fs.mkdirSync(externalSubdir, { recursive: true })
      await expectProjectPathEscape(
        resolveContainedRepoRoot(externalSubdir, { repoRoot: mainRepo }),
        externalSubdir,
        mainRepo,
      )
      await expectProjectPathEscape(
        resolveContainedRepoRoot(symlinkToWt, { repoRoot: mainRepo }),
        symlinkToWt,
        mainRepo,
      )

      const routeRaw = await Effect.runPromise(
        executeToolEffect(
          "harness_review_route",
          {
            changedFiles: ["libs/pkg/src/index.ts"],
            diffSummary: "Linked worktree edit",
            changedLineCount: 3,
            repoRoot: linkedWt,
          },
          {
            repoRoot: mainRepo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
            }),
          },
        ),
      )
      const routeOutput = Schema.decodeUnknownSync(ReviewRouteToolOutput)(routeRaw)
      expect(routeOutput.signals.touchedTiers).toContain("type:domain")

      await expectProjectPathEscape(
        executeToolEffect(
          "harness_review_route",
          {
            changedFiles: ["README.md"],
            changedLineCount: 1,
            repoRoot: externalRepo,
          },
          {
            repoRoot: mainRepo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer(),
          },
        ),
        externalRepo,
      )
      await expectProjectPathEscape(
        executeToolEffect(
          "harness_review_route",
          {
            changedFiles: ["libs/pkg/src/index.ts"],
            changedLineCount: 1,
            repoRoot: symlinkToWt,
          },
          {
            repoRoot: mainRepo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer(),
          },
        ),
        symlinkToWt,
      )
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.1: resolves newest active-workspace.json, falls back on deleted target, and prioritizes valid sibling cwd", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req11-ext-"))
    const olderTarget = path.join(tmpBase, "older-target")
    const newerTarget = path.join(tmpBase, "newer-target")
    const deletedTarget = path.join(tmpBase, "deleted-target")
    const siblingCwd = path.join(tmpBase, "sibling-cwd")
    fs.mkdirSync(olderTarget, { recursive: true })
    fs.mkdirSync(newerTarget, { recursive: true })
    fs.mkdirSync(siblingCwd, { recursive: true })
    fs.writeFileSync(path.join(olderTarget, "pnpm-workspace.yaml"), "packages: []\n")
    fs.writeFileSync(path.join(newerTarget, "pnpm-workspace.yaml"), "packages: []\n")
    fs.writeFileSync(path.join(siblingCwd, "pnpm-workspace.yaml"), "packages: []\n")

    const localActivePath = path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")
    const canonicalRoot = resolveCanonicalRepoRoot(SERVER_REPO_ROOT, nodeSyncHostIo)
    const canonicalActivePath = path.join(canonicalRoot, ".harness", "active-workspace.json")
    let localContent = JSON.stringify({
      repoRoot: olderTarget,
      updatedAt: "2026-11-20T10:00:00.000Z",
    })
    let canonicalContent = JSON.stringify({
      repoRoot: newerTarget,
      updatedAt: "2026-11-20T12:00:00.000Z",
    })

    const existsSpy = vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((target) => {
      if (target === localActivePath || target === canonicalActivePath) return true
      return fs.existsSync(target)
    })
    const readSpy = vi.spyOn(nodeSyncHostIo, "readTextSync").mockImplementation((target) => {
      if (target === localActivePath) return localContent
      if (target === canonicalActivePath) return canonicalContent
      return fs.readFileSync(target, "utf8")
    })

    try {
      const winner = resolveDefaultRepoRoot(undefined, { cwd: tmpBase })
      expect(winner).toBe(
        newerTarget === olderTarget
          ? olderTarget
          : canonicalRoot !== SERVER_REPO_ROOT
            ? newerTarget
            : olderTarget,
      )

      localContent = JSON.stringify({
        repoRoot: deletedTarget,
        updatedAt: "2099-01-01T00:00:00.000Z",
      })
      canonicalContent = JSON.stringify({
        repoRoot: deletedTarget,
        updatedAt: "2099-01-01T00:00:00.000Z",
      })
      expect(resolveDefaultRepoRoot(undefined, { cwd: tmpBase })).toBe(SERVER_REPO_ROOT)

      expect(resolveDefaultRepoRoot(undefined, { cwd: siblingCwd })).toBe(siblingCwd)
    } finally {
      readSpy.mockRestore()
      existsSpy.mockRestore()
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.4: records end-to-end degraded ontology_check and route telemetry and non-degraded clean=false fail", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req14-e2e-"))
    const stateDir = path.join(tmpRoot, ".harness")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages: []\n")
    fs.writeFileSync(path.join(stateDir, "graph-snapshot.json"), "{corrupt-json", "utf8")

    try {
      await Effect.runPromise(
        executeToolEffect(
          "harness_ontology_check",
          { repoRoot: tmpRoot },
          {
            repoRoot: tmpRoot,
            governanceDocs: [],
            skipOmnigraphSpawn: true,
            decisionLayer: makeMockDecisionModelLayer(),
          },
        ),
      )

      const eventsAfterCorrupt = readTelemetryEvents(tmpRoot, nodeSyncHostIo)
      expect(eventsAfterCorrupt).toHaveLength(1)
      expect(eventsAfterCorrupt[0]).toMatchObject({
        toolName: "harness_ontology_check",
        outcome: "fallback",
      })
      expect(eventsAfterCorrupt[0]?.detail).toContain("degraded=corrupt-graph-snapshot")

      const report = await Effect.runPromise(
        decideSessionReport({ events: eventsAfterCorrupt, frictionEvents: [] }),
      )
      expect(report.healthScore).toBe(95)
      expect(
        report.recommendations.some((r) => r.includes("Degraded MCP responses detected")),
      ).toBe(true)

      recordMcpToolTelemetry(
        "harness_ontology_check",
        { repoRoot: tmpRoot },
        { clean: false, degraded: false },
        7,
        { repoRoot: tmpRoot },
      )
      const eventsAfterFail = readTelemetryEvents(tmpRoot, nodeSyncHostIo)
      expect(eventsAfterFail[1]).toMatchObject({
        toolName: "harness_ontology_check",
        outcome: "fail",
      })

      await Effect.runPromise(
        executeToolEffect(
          "harness_route",
          { planStep: "Add schema validation", repoRoot: tmpRoot },
          {
            repoRoot: tmpRoot,
            skipOmnigraphSpawn: true,
            decisionLayer: makeMockDecisionModelLayer(),
          },
        ),
      )
      const eventsAfterRoute = readTelemetryEvents(tmpRoot, nodeSyncHostIo)
      expect(eventsAfterRoute[2]).toMatchObject({
        toolName: "harness_route",
        outcome: "fallback",
      })
      expect(eventsAfterRoute[2]?.detail).toContain("degraded=corrupt-graph-snapshot")
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.2 & REQ-1.3: rejects whitespace/relative/regular-file repoRoots, missing logicalRoot, preserves nested .git boundary, and emits resolveContainedRepoRoot span", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req12-edge-"))
    const mainRepo = path.join(tmpBase, "main-repo")
    const regularFile = path.join(mainRepo, "file.txt")
    const nestedWt = path.join(mainRepo, ".harness", "workflow-worktrees", "unit-1")
    const nestedPkg = path.join(nestedWt, "libs", "pkg")

    try {
      fs.mkdirSync(mainRepo, { recursive: true })
      runGit(mainRepo, ["init", "-b", "main"])
      fs.writeFileSync(path.join(mainRepo, "pnpm-workspace.yaml"), "packages: []\n")
      fs.writeFileSync(regularFile, "not a dir\n")
      runGit(mainRepo, ["add", "."])
      runGit(mainRepo, ["commit", "-m", "init"])

      fs.mkdirSync(nestedPkg, { recursive: true })
      fs.writeFileSync(path.join(nestedWt, ".git"), "gitdir: ../.git/worktrees/unit-1\n")
      fs.writeFileSync(
        path.join(nestedPkg, "project.json"),
        JSON.stringify({ tags: ["type:domain"] }),
      )

      expect(isPathInsideRoot(path.join(tmpBase, "missing-root"), mainRepo)).toBe(false)
      await expectProjectPathEscape(resolveContainedRepoRoot("   ", { repoRoot: mainRepo }), "   ")
      await expectProjectPathEscape(
        resolveContainedRepoRoot("../outside", { repoRoot: mainRepo }),
        "../outside",
      )
      await expectProjectPathEscape(
        resolveContainedRepoRoot(regularFile, { repoRoot: mainRepo }),
        regularFile,
      )

      const graph = buildHarnessGraph({ fns: [], services: [], layers: [], errors: [] })
      const routeRaw = await Effect.runPromise(
        executeToolEffect(
          "harness_review_route",
          {
            changedFiles: ["src/index.ts"],
            changedLineCount: 2,
            repoRoot: nestedPkg,
          },
          {
            repoRoot: mainRepo,
            graph,
            skipOmnigraphSpawn: true,
            skipTelemetry: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
            }),
          },
        ),
      )
      const routeOut = Schema.decodeUnknownSync(ReviewRouteToolOutput)(routeRaw)
      expect(routeOut.signals.changedFiles).toEqual(["src/index.ts"])

      const emptyIndex = new Map<string, IndexedEffectFn>()
      const traced = await Effect.runPromise(
        runWithTestTracer(
          "HarnessMcp.resolveContainedRepoRoot::test",
          resolveContainedRepoRoot(mainRepo, { repoRoot: mainRepo }),
          emptyIndex,
        ),
      )
      expect(traced.result).toBe(path.resolve(mainRepo))
      expect(
        traced.spans.some(
          (s) => s.name === "HarnessMcp.resolveContainedRepoRoot" && s.exitTag === "Success",
        ),
      ).toBe(true)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
