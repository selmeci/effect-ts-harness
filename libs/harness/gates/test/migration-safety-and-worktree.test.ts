import { describe, expect, it } from "@effect/vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Effect } from "effect"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import {
  checkMigrationSqlSafety,
  classifyFileWrite,
  decideMigrationSafety,
  resolveHarnessStateDir,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("Harness Gates: Migration Safety, File Write & State Dir", () => {
  describe("decideMigrationSafety / checkMigrationSqlSafety", () => {
    it.effect(
      "reports safe: true for clean CREATE TABLE and ALTER TABLE ADD COLUMN with DEFAULT",
      () =>
        Effect.gen(function* () {
          const report = yield* decideMigrationSafety({
            files: [
              {
                file: "migrations/0001_init.sql",
                sql: `
                CREATE TABLE users (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL
                );
                --> statement-breakpoint
                ALTER TABLE users ADD COLUMN age INTEGER NOT NULL DEFAULT 0;
              `,
              },
            ],
          })

          expect(report.safe).toBe(true)
          expect(report.requiresEscalation).toBe(false)
          expect(report.violations).toHaveLength(0)
        }),
    )

    it("detects DROP TABLE, table rebuild, and ADD NOT NULL without DEFAULT via checkMigrationSqlSafety", () => {
      const report = checkMigrationSqlSafety([
        {
          file: "migrations/0002_drop.sql",
          sql: "DROP TABLE users;",
        },
        {
          file: "migrations/0003_rebuild.sql",
          sql: "CREATE TABLE `__new_users` (id INTEGER PRIMARY KEY); PRAGMA foreign_keys=OFF;",
        },
        {
          file: "migrations/0004_not_null.sql",
          sql: "ALTER TABLE photos ADD COLUMN owner_id TEXT NOT NULL;",
        },
      ])

      expect(report.safe).toBe(false)
      expect(report.requiresEscalation).toBe(true)
      expect(report.violations).toHaveLength(4)

      const kinds = report.violations.map((v) => v.kind)
      expect(kinds).toContain("drop-statement")
      expect(kinds).toContain("table-rebuild")
      expect(kinds).toContain("add-not-null-without-default")

      const notNull = report.violations.find((v) => v.kind === "add-not-null-without-default")
      expect(notNull?.file).toBe("migrations/0004_not_null.sql")
      expect(notNull?.message).toContain("ALTER TABLE ADD COLUMN NOT NULL without DEFAULT")
    })

    it("resists SQL comment spoofing of DEFAULT and detects SQLite ALTER TABLE DROP <col> without COLUMN keyword", () => {
      const report = checkMigrationSqlSafety([
        {
          file: "migrations/0005_adversarial.sql",
          sql: `
            -- DEFAULT 0 should not bypass NOT NULL check
            ALTER TABLE "default" ADD COLUMN tenant_id TEXT NOT NULL /* DEFAULT 'none' */;
            ALTER TABLE users DROP is_admin;
          `,
        },
      ])

      expect(report.safe).toBe(false)
      expect(report.requiresEscalation).toBe(true)
      expect(report.violations.map((v) => v.kind)).toEqual([
        "add-not-null-without-default",
        "drop-statement",
      ])
    })
  })

  describe("classifyFileWrite (controlled write-surface)", () => {
    it("denies writes to protected read-only repos subtrees", () => {
      expect(classifyFileWrite("repos/effect/LLMS.md").verdict).toBe("deny")
      expect(classifyFileWrite("repos/alchemy/package.json").verdict).toBe("deny")
      expect(classifyFileWrite("repos/effect/src/index.ts").verdict).toBe("deny")
      expect(classifyFileWrite("repos/effect").verdict).toBe("deny")
    })

    it("denies direct modification of verify-stamp.json (forgery protection)", () => {
      expect(classifyFileWrite(".harness/verify-stamp.json").verdict).toBe("deny")
      expect(classifyFileWrite(".harness/worktrees/wt-1/verify-stamp.json").verdict).toBe("deny")
      expect(classifyFileWrite("/home/user/project/.harness/verify-stamp.json").verdict).toBe(
        "deny",
      )
    })

    it("denies modification of secret and credential files", () => {
      expect(classifyFileWrite(".env").verdict).toBe("deny")
      expect(classifyFileWrite(".env.local").verdict).toBe("deny")
      expect(classifyFileWrite(".dev.vars").verdict).toBe("deny")
      expect(classifyFileWrite("secret.pem").verdict).toBe("deny")
      expect(classifyFileWrite("server.key").verdict).toBe("deny")
    })

    it("allows template/example/sample environment files", () => {
      expect(classifyFileWrite(".env.example").verdict).toBe("allow")
      expect(classifyFileWrite(".env.template").verdict).toBe("allow")
      expect(classifyFileWrite(".env.sample").verdict).toBe("allow")
    })

    it("asks human confirmation for governance and linter policy changes", () => {
      expect(classifyFileWrite(".oxlintrc.json").verdict).toBe("ask")
      expect(classifyFileWrite("tools/oxlint/syntax-bans.js").verdict).toBe("ask")
      expect(classifyFileWrite("libs/harness/graph/policies.cedar").verdict).toBe("ask")
    })

    it("allows standard codebase modifications and handles empty input", () => {
      expect(classifyFileWrite("libs/sample/domain/src/index.ts").verdict).toBe("allow")
      expect(classifyFileWrite("apps/sample-web/src/client.ts").verdict).toBe("allow")
      expect(classifyFileWrite("").verdict).toBe("allow")
    })
  })

  describe("resolveHarnessStateDir", () => {
    it("defaults to repoRoot/.harness when env vars are unset", () => {
      expect(resolveHarnessStateDir("/repo", {})).toBe("/repo/.harness")
    })

    it("respects HARNESS_WORKTREE_ID and sanitizes special characters", () => {
      expect(resolveHarnessStateDir("/repo", { HARNESS_WORKTREE_ID: "feature-branch" })).toBe(
        "/repo/.harness/worktrees/feature-branch",
      )

      expect(resolveHarnessStateDir("/repo", { HARNESS_WORKTREE_ID: "feat/nested#branch" })).toBe(
        "/repo/.harness/worktrees/feat_nested_branch",
      )
    })

    it("respects HARNESS_STATE_DIR (both relative and absolute)", () => {
      expect(resolveHarnessStateDir("/repo", { HARNESS_STATE_DIR: ".custom-state" })).toBe(
        "/repo/.custom-state",
      )

      expect(resolveHarnessStateDir("/repo", { HARNESS_STATE_DIR: "/tmp/custom-state" })).toBe(
        "/tmp/custom-state",
      )
    })

    it("rejects root-resolving paths and invalid HARNESS_WORKTREE_ID or HARNESS_STATE_DIR segments", () => {
      for (const invalidRoot of ["/.", "/..", "/tmp/..", ".", ".."]) {
        expect(() => resolveHarnessStateDir(invalidRoot, {})).toThrow()
      }
      for (const invalidWorktreeId of ["..", ".", "...", "   "]) {
        expect(() =>
          resolveHarnessStateDir("/repo", { HARNESS_WORKTREE_ID: invalidWorktreeId }),
        ).toThrow()
      }
      expect(() => resolveHarnessStateDir("/repo", { HARNESS_STATE_DIR: ".." })).toThrow()
    })

    it("resolveCanonicalRepoRoot resolves regular directory vs linked worktree directory", () => {
      const regularDir = mkdtempSync(join(tmpdir(), "harness-reg-repo-"))
      const wtDir = mkdtempSync(join(tmpdir(), "harness-wt-repo-"))
      try {
        expect(resolveCanonicalRepoRoot(regularDir, testHostIo)).toBe(regularDir)

        writeFileSync(join(wtDir, ".git"), "gitdir: /path/to/main/.git/worktrees/wt-1\n")
        expect(resolveCanonicalRepoRoot(wtDir, testHostIo)).toBe("/path/to/main")
      } finally {
        rmSync(regularDir, { recursive: true, force: true })
        rmSync(wtDir, { recursive: true, force: true })
      }
    })

    it("resolveOmnigraphClusterDir always resolves to canonicalRepoRoot/.harness/omnigraph-cluster", () => {
      const mainRepo = mkdtempSync(join(tmpdir(), "harness-main-repo-"))
      const wtDir = mkdtempSync(join(tmpdir(), "harness-linked-wt-"))
      try {
        writeFileSync(
          join(wtDir, ".git"),
          `gitdir: ${join(mainRepo, ".git", "worktrees", "wt-1")}\n`,
        )

        // Without HARNESS_WORKTREE_ID
        expect(resolveOmnigraphClusterDir(mainRepo, testHostIo, {})).toBe(
          join(mainRepo, ".harness", "omnigraph-cluster"),
        )

        // With HARNESS_WORKTREE_ID set, still points to canonical repo root cluster
        expect(
          resolveOmnigraphClusterDir(mainRepo, testHostIo, { HARNESS_WORKTREE_ID: "wt-feature" }),
        ).toBe(join(mainRepo, ".harness", "omnigraph-cluster"))

        // Inside linked git worktree, points to canonical repo root cluster
        expect(resolveOmnigraphClusterDir(wtDir, testHostIo, {})).toBe(
          join(mainRepo, ".harness", "omnigraph-cluster"),
        )

        // With explicit HARNESS_STATE_DIR
        expect(
          resolveOmnigraphClusterDir(mainRepo, testHostIo, { HARNESS_STATE_DIR: ".custom-state" }),
        ).toBe(join(mainRepo, ".custom-state", "omnigraph-cluster"))
      } finally {
        rmSync(mainRepo, { recursive: true, force: true })
        rmSync(wtDir, { recursive: true, force: true })
      }
    })

    it("deriveRepoOmnigraphPort produces deterministic port in range and isolates repositories", () => {
      const mainRepo = mkdtempSync(join(tmpdir(), "harness-main-port-"))
      const wtDir = mkdtempSync(join(tmpdir(), "harness-wt-port-"))
      try {
        writeFileSync(
          join(wtDir, ".git"),
          `gitdir: ${join(mainRepo, ".git", "worktrees", "wt-1")}\n`,
        )

        const mainPort = deriveRepoOmnigraphPort(mainRepo, testHostIo)
        const wtPort = deriveRepoOmnigraphPort(wtDir, testHostIo)

        expect(wtPort).toBe(mainPort)
        expect(mainPort).toBeGreaterThanOrEqual(18080)
        expect(mainPort).toBeLessThanOrEqual(28079)

        const portAlpha = deriveRepoOmnigraphPort("/tmp/repo-alpha", testHostIo)
        const portBeta = deriveRepoOmnigraphPort("/tmp/repo-beta", testHostIo)
        expect(portAlpha).toBeGreaterThanOrEqual(18080)
        expect(portAlpha).toBeLessThanOrEqual(28079)
        expect(portBeta).toBeGreaterThanOrEqual(18080)
        expect(portBeta).toBeLessThanOrEqual(28079)
        expect(portAlpha).not.toBe(portBeta)
      } finally {
        rmSync(mainRepo, { recursive: true, force: true })
        rmSync(wtDir, { recursive: true, force: true })
      }
    })

    it("resolveOmnigraphTaskBranches resolves default vs worktree task branches", () => {
      const mainRepo = mkdtempSync(join(tmpdir(), "harness-main-branches-"))
      const wtDir = mkdtempSync(join(tmpdir(), "harness-wt-branches-"))
      try {
        writeFileSync(
          join(wtDir, ".git"),
          `gitdir: ${join(mainRepo, ".git", "worktrees", "wt-1")}\n`,
        )

        // Default
        expect(resolveOmnigraphTaskBranches(mainRepo, testHostIo, {})).toEqual({
          planBranch: "plan/current",
          implBranch: "impl/current",
          mainBranch: "main",
        })

        // With HARNESS_WORKTREE_ID
        expect(
          resolveOmnigraphTaskBranches(mainRepo, testHostIo, {
            HARNESS_WORKTREE_ID: "feature-auth",
          }),
        ).toEqual({
          planBranch: "plan/wt-feature-auth",
          implBranch: "impl/wt-feature-auth",
          mainBranch: "main",
        })

        expect(
          resolveOmnigraphTaskBranches(mainRepo, testHostIo, {
            HARNESS_WORKTREE_ID: "feat/nested#branch",
          }),
        ).toEqual({
          planBranch: "plan/wt-feat_nested_branch",
          implBranch: "impl/wt-feat_nested_branch",
          mainBranch: "main",
        })

        // Inside linked git worktree directory
        const slug = basename(wtDir).replace(/[^a-zA-Z0-9._-]/g, "_")
        expect(resolveOmnigraphTaskBranches(wtDir, testHostIo, {})).toEqual({
          planBranch: `plan/wt-${slug}`,
          implBranch: `impl/wt-${slug}`,
          mainBranch: "main",
        })
      } finally {
        rmSync(mainRepo, { recursive: true, force: true })
        rmSync(wtDir, { recursive: true, force: true })
      }
    })
  })
})
