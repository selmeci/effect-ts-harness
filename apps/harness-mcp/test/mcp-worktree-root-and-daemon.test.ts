import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it, vi } from "vitest"
import { nodeSyncHostIo } from "@harness/infra"
import { executeToolEffect } from "../src/server.js"
import {
  hasValidWorkspaceRootMarker,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  resolveDaemonStartupRepoRoot,
  resolveDefaultRepoRoot,
  SERVER_REPO_ROOT,
} from "../src/tools/mcp-repo-root.js"

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

const initWorkspaceGitRepo = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true })
  runGit(dir, ["init", "-b", "main"])
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  fs.writeFileSync(path.join(dir, "README.md"), "# temp\n", "utf8")
  runGit(dir, ["add", "."])
  runGit(dir, ["commit", "-m", "init"])
}

const expectProjectPathEscape = async <A, E>(
  effect: Effect.Effect<A, E>,
  expectedProjectPath?: string,
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

describe("mcp worktree root containment and daemon startup (SPEC-0035 REQ-1.1 .. REQ-1.3)", () => {
  it("REQ-1.1: hasValidWorkspaceRootMarker requires existing directory with both pnpm-workspace.yaml and .git", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-marker-"))
    const validRepo = path.join(tmpBase, "valid-repo")
    const linkedWt = path.join(tmpBase, "linked-wt")
    const workspaceOnly = path.join(tmpBase, "workspace-only")
    const gitOnly = path.join(tmpBase, "git-only")
    const pluginSubdir = path.join(
      validRepo,
      "adapters",
      "antigravity",
      "plugins",
      "effect-harness",
    )

    try {
      initWorkspaceGitRepo(validRepo)
      runGit(validRepo, ["worktree", "add", "-b", "wt-marker", linkedWt])
      fs.mkdirSync(pluginSubdir, { recursive: true })

      fs.mkdirSync(workspaceOnly, { recursive: true })
      fs.writeFileSync(path.join(workspaceOnly, "pnpm-workspace.yaml"), "packages: []\n", "utf8")

      fs.mkdirSync(gitOnly, { recursive: true })
      runGit(gitOnly, ["init", "-b", "main"])

      expect(hasValidWorkspaceRootMarker("")).toBe(false)
      expect(hasValidWorkspaceRootMarker("   ")).toBe(false)
      expect(hasValidWorkspaceRootMarker(path.join(tmpBase, "missing-dir"))).toBe(false)
      expect(hasValidWorkspaceRootMarker(workspaceOnly)).toBe(false)
      expect(hasValidWorkspaceRootMarker(gitOnly)).toBe(false)
      expect(hasValidWorkspaceRootMarker(pluginSubdir)).toBe(false)
      expect(hasValidWorkspaceRootMarker(validRepo)).toBe(true)
      expect(hasValidWorkspaceRootMarker(linkedWt)).toBe(true)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.1: resolveDaemonStartupRepoRoot anchors plugin subdir and ghost paths onto validated workspace root", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-daemon-root-"))
    const mainRepo = path.join(tmpBase, "main-repo")
    const tempPluginDir = path.join(
      mainRepo,
      "adapters",
      "antigravity",
      "plugins",
      "effect-harness",
    )
    const outsideNonWorkspace = path.join(tmpBase, "outside-non-workspace")
    const ghostSubdir = path.join(tmpBase, "deleted-ghost", "subdir")

    try {
      initWorkspaceGitRepo(mainRepo)
      fs.mkdirSync(tempPluginDir, { recursive: true })
      fs.mkdirSync(outsideNonWorkspace, { recursive: true })

      expect(resolveDaemonStartupRepoRoot(tempPluginDir)).toBe(mainRepo)
      expect(fs.existsSync(path.join(tempPluginDir, ".harness"))).toBe(false)

      const realPluginDir = path.join(
        SERVER_REPO_ROOT,
        "adapters",
        "antigravity",
        "plugins",
        "effect-harness",
      )
      const resolvedReal = resolveDaemonStartupRepoRoot(realPluginDir)
      expect(resolvedReal).toBe(SERVER_REPO_ROOT)
      expect(resolvedReal).not.toContain("adapters/antigravity/plugins")
      expect(hasValidWorkspaceRootMarker(resolvedReal)).toBe(true)

      const resolvedOutside = resolveDaemonStartupRepoRoot(outsideNonWorkspace)
      expect(resolvedOutside).not.toBe(outsideNonWorkspace)
      expect(hasValidWorkspaceRootMarker(resolvedOutside)).toBe(true)

      const resolvedGhost = resolveDaemonStartupRepoRoot(ghostSubdir)
      expect(resolvedGhost).not.toBe(ghostSubdir)
      expect(hasValidWorkspaceRootMarker(resolvedGhost)).toBe(true)

      const defaultFromGhost = resolveDefaultRepoRoot(
        { repoRoot: ghostSubdir },
        { cwd: outsideNonWorkspace, skipActiveWorkspaceLookup: true },
      )
      expect(defaultFromGhost).not.toBe(ghostSubdir)
      expect(defaultFromGhost).not.toBe(outsideNonWorkspace)
      expect(hasValidWorkspaceRootMarker(defaultFromGhost)).toBe(true)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.2: resolveContainedRepoRoot resolves linked worktree when boundaryRoot/cwd is plugin subdir or ghost path and rejects outside dirs", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req12-anchor-"))
    const mainRepo = path.join(tmpBase, "main-repo")
    const linkedWt = path.join(tmpBase, "linked-wt")
    const externalRepo = path.join(tmpBase, "external-repo")
    const outsideDir = path.join(tmpBase, "outside-plain")
    const workspaceOnlyDir = path.join(tmpBase, "workspace-only-no-git")
    const pluginSubdir = path.join(mainRepo, "adapters", "antigravity", "plugins", "effect-harness")
    const ghostInsideMain = path.join(mainRepo, "ghost-missing-worktree")

    try {
      initWorkspaceGitRepo(mainRepo)
      runGit(mainRepo, ["worktree", "add", "-b", "wt-anchor", linkedWt])
      fs.mkdirSync(pluginSubdir, { recursive: true })
      fs.mkdirSync(outsideDir, { recursive: true })
      fs.mkdirSync(workspaceOnlyDir, { recursive: true })
      fs.writeFileSync(path.join(workspaceOnlyDir, "pnpm-workspace.yaml"), "packages: []\n", "utf8")

      fs.mkdirSync(externalRepo, { recursive: true })
      runGit(externalRepo, ["init", "-b", "main"])
      fs.writeFileSync(path.join(externalRepo, "README.md"), "ext\n", "utf8")
      runGit(externalRepo, ["add", "."])
      runGit(externalRepo, ["commit", "-m", "init"])

      const realLinkedWt = fs.realpathSync.native(linkedWt)
      const realMainRepo = fs.realpathSync.native(mainRepo)
      const pluginNested = path.join(pluginSubdir, "src")
      fs.mkdirSync(pluginNested, { recursive: true })

      expect(
        await Effect.runPromise(
          resolveContainedRepoRoot(linkedWt, {
            cwd: pluginSubdir,
            skipActiveWorkspaceLookup: true,
          }),
        ),
      ).toBe(realLinkedWt)

      expect(
        await Effect.runPromise(
          resolveContainedRepoRoot(linkedWt, {
            cwd: ghostInsideMain,
            skipActiveWorkspaceLookup: true,
          }),
        ),
      ).toBe(realLinkedWt)

      expect(
        await Effect.runPromise(resolveContainedRepoRoot(pluginNested, { repoRoot: pluginSubdir })),
      ).toBe(path.resolve(pluginNested))

      await expectProjectPathEscape(
        resolveContainedRepoRoot(linkedWt, { repoRoot: pluginSubdir }),
        linkedWt,
      )
      await expectProjectPathEscape(
        resolveContainedRepoRoot(linkedWt, { repoRoot: ghostInsideMain }),
        linkedWt,
      )

      await expectProjectPathEscape(
        resolveContainedRepoRoot(outsideDir, { repoRoot: pluginSubdir }),
        outsideDir,
      )
      await expectProjectPathEscape(
        resolveContainedRepoRoot(externalRepo, { repoRoot: pluginSubdir }),
        externalRepo,
      )

      const realServerRoot = fs.realpathSync.native(SERVER_REPO_ROOT)
      expect(
        await Effect.runPromise(
          resolveContainedRepoRoot(SERVER_REPO_ROOT, {
            cwd: workspaceOnlyDir,
            skipActiveWorkspaceLookup: true,
          }),
        ),
      ).toBe(realServerRoot)

      await expectProjectPathEscape(
        resolveContainedRepoRoot(outsideDir, {
          cwd: workspaceOnlyDir,
          skipActiveWorkspaceLookup: true,
        }),
        outsideDir,
      )

      const staleWt = path.join(tmpBase, "stale-linked-wt")
      runGit(mainRepo, ["worktree", "add", "-b", "wt-stale-canon", staleWt])
      const staleGitPtr = fs.readFileSync(path.join(staleWt, ".git"), "utf8").trim()
      const staleGitDir = path.resolve(staleWt, staleGitPtr.slice("gitdir:".length).trim())
      fs.rmSync(staleGitDir, { recursive: true, force: true })

      expect(
        await Effect.runPromise(
          resolveContainedRepoRoot(mainRepo, {
            cwd: staleWt,
            skipActiveWorkspaceLookup: true,
          }),
        ),
      ).toBe(realMainRepo)
      expect(
        await Effect.runPromise(
          resolveContainedRepoRoot(linkedWt, {
            cwd: staleWt,
            skipActiveWorkspaceLookup: true,
          }),
        ),
      ).toBe(realLinkedWt)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.3: harness_telemetry_report warns on non-workspace dir and omits warning on valid workspace", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req13-telemetry-"))
    const nonWorkspaceDir = path.join(tmpBase, "non-workspace")
    const validRepo = path.join(tmpBase, "valid-repo")

    try {
      fs.mkdirSync(nonWorkspaceDir, { recursive: true })
      initWorkspaceGitRepo(validRepo)

      const jsonReport = (await Effect.runPromise(
        executeToolEffect(
          "harness_telemetry_report",
          { format: "json", repoRoot: nonWorkspaceDir },
          { repoRoot: nonWorkspaceDir, skipTelemetry: true },
        ),
      )) as {
        readonly resolvedRepoRoot: string
        readonly recommendations: ReadonlyArray<string>
      }

      expect(jsonReport.resolvedRepoRoot).toBe(nonWorkspaceDir)
      expect(
        jsonReport.recommendations.some(
          (r) =>
            r.includes(nonWorkspaceDir) &&
            r.includes("not a valid workspace root") &&
            r.includes("repoRoot"),
        ),
      ).toBe(true)

      const mdReport = (await Effect.runPromise(
        executeToolEffect(
          "harness_telemetry_report",
          { format: "markdown", repoRoot: nonWorkspaceDir },
          { repoRoot: nonWorkspaceDir, skipTelemetry: true },
        ),
      )) as {
        readonly markdown: string
        readonly resolvedRepoRoot: string
        readonly report: { readonly recommendations: ReadonlyArray<string> }
      }

      expect(mdReport.resolvedRepoRoot).toBe(nonWorkspaceDir)
      expect(mdReport.markdown).toContain("not a valid workspace root")
      expect(
        mdReport.report.recommendations.some((r) => r.includes("not a valid workspace root")),
      ).toBe(true)

      const validReport = (await Effect.runPromise(
        executeToolEffect(
          "harness_telemetry_report",
          { format: "json", repoRoot: validRepo },
          { repoRoot: validRepo, skipTelemetry: true },
        ),
      )) as {
        readonly resolvedRepoRoot: string
        readonly recommendations: ReadonlyArray<string>
      }

      expect(validReport.resolvedRepoRoot).toBe(validRepo)
      expect(
        validReport.recommendations.some((r) => r.includes("not a valid workspace root")),
      ).toBe(false)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.3: harness_lsp_diagnostics fails cleanly on non-workspace dir without invoking tsgo", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-req13-lsp-"))
    const nonWorkspaceDir = path.join(tmpBase, "non-workspace")
    const validRepo = path.join(tmpBase, "valid-repo")

    try {
      fs.mkdirSync(nonWorkspaceDir, { recursive: true })
      fs.writeFileSync(path.join(nonWorkspaceDir, "tsconfig.json"), "{}", "utf8")
      initWorkspaceGitRepo(validRepo)
      fs.writeFileSync(path.join(validRepo, "tsconfig.base.json"), "{}", "utf8")

      let tsgoCalled = false
      const exit = await Effect.runPromiseExit(
        executeToolEffect(
          "harness_lsp_diagnostics",
          { repoRoot: nonWorkspaceDir },
          {
            repoRoot: nonWorkspaceDir,
            skipTelemetry: true,
            lspTsgoExecutor: () =>
              Effect.sync(() => {
                tsgoCalled = true
                return { _tag: "Exited" as const, exitCode: 0, stdout: "{}", stderr: "" }
              }),
          },
        ),
      )

      expect(tsgoCalled).toBe(false)
      match(exit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          match(Cause.findErrorOption(cause))
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(ProjectPathEscapeError)
              if (value instanceof ProjectPathEscapeError) {
                expect(value.message).toContain("not a valid workspace root")
                expect(value.message).toContain(nonWorkspaceDir)
              }
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected ProjectPathEscapeError failure")
            })
            .exhaustive()
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected failure for non-workspace repoRoot")
        })
        .exhaustive()

      const validRes = (await Effect.runPromise(
        executeToolEffect(
          "harness_lsp_diagnostics",
          { repoRoot: validRepo },
          {
            repoRoot: validRepo,
            skipTelemetry: true,
            lspTsgoExecutor: () =>
              Effect.sync(() => {
                tsgoCalled = true
                return {
                  _tag: "Exited" as const,
                  exitCode: 0,
                  stdout: JSON.stringify({
                    diagnostics: [],
                    summary: {
                      filesChecked: 1,
                      filesWithoutPlugin: 0,
                      totalFiles: 1,
                      errors: 0,
                      warnings: 0,
                      messages: 0,
                    },
                  }),
                  stderr: "",
                }
              }),
          },
        ),
      )) as { readonly clean: boolean }

      expect(tsgoCalled).toBe(true)
      expect(validRes.clean).toBe(true)
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.1: resolveDefaultRepoRoot ignores active-workspace.json pointing to dir without pnpm-workspace.yaml", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-active-ws-nomarker-"))
    const plainDir = path.join(tmpBase, "plain-dir")
    const activeWorkspacePath = path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")

    fs.mkdirSync(plainDir, { recursive: true })

    const existsSpy = vi.spyOn(nodeSyncHostIo, "existsSync").mockImplementation((target) => {
      if (target === activeWorkspacePath) return true
      return fs.existsSync(target)
    })
    const readSpy = vi.spyOn(nodeSyncHostIo, "readTextSync").mockImplementation((target) => {
      if (target === activeWorkspacePath) {
        return JSON.stringify({
          repoRoot: plainDir,
          updatedAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
      return fs.readFileSync(target, "utf8")
    })

    try {
      const resolved = resolveDefaultRepoRoot(undefined, { cwd: tmpBase })
      expect(resolved).not.toBe(plainDir)
      expect(hasValidWorkspaceRootMarker(resolved)).toBe(true)
    } finally {
      readSpy.mockRestore()
      existsSpy.mockRestore()
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("REQ-1.3: harness_lsp_diagnostics with overlays fails with ProjectPathEscapeError on missing/ghost repoRoot", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lsp-ghost-overlay-"))
    const ghostRoot = path.join(tmpBase, "deleted-ghost-worktree")
    const regularFile = path.join(tmpBase, "not-a-dir.txt")

    try {
      fs.writeFileSync(regularFile, "x\n", "utf8")

      await expectProjectPathEscape(
        executeToolEffect(
          "harness_lsp_diagnostics",
          {
            repoRoot: ghostRoot,
            overlays: { "src/a.ts": "export const x: number = 1\n" },
          },
          { repoRoot: ghostRoot, skipTelemetry: true },
        ),
        ghostRoot,
      )

      await expectProjectPathEscape(
        executeToolEffect(
          "harness_lsp_diagnostics",
          {
            overlays: { "src/a.ts": "export const x: number = 1\n" },
          },
          { repoRoot: regularFile, skipTelemetry: true },
        ),
        regularFile,
      )
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
