import { describe, expect, it } from "@effect/vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import {
  buildHarnessGraph,
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
import {
  buildSessionHandoff,
  checkLoopThrashing,
  checkMigrationSqlSafety,
  classifyFileWrite,
  decideGraphEntropy,
  decideLoopThrashing,
  decideMigrationSafety,
  decideMutationReport,
  decideSessionHandoff,
  decideSpanBudgets,
  discoverDomainMutants,
  evaluateMutationOutcomes,
  MutantId,
  MutantSourceText,
  resolveHarnessStateDir,
  type CodeMutant,
  type FrictionCluster,
  type FrictionEvent,
  type SpanSample,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("Harness Gates: Session Handoff, Span Budget, Mutation, and State Dir", () => {
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

  describe("decideSessionHandoff / buildSessionHandoff", () => {
    it("returns handoffMessage: null when clean with no active tasks", () => {
      const summary = buildSessionHandoff({
        stampValid: true,
        activeStubs: [],
        missingPlannedFns: [],
        frictionClusters: [],
      })

      expect(summary.hasActiveTask).toBe(false)
      expect(summary.stampValid).toBe(true)
      expect(summary.recentFrictionCount).toBe(0)
      expect(summary.topFrictionSummary).toHaveLength(0)
      expect(summary.handoffMessage).toBeNull()
    })

    it.effect("builds a structured handoff message when tasks or friction exist", () =>
      Effect.gen(function* () {
        const clusters: ReadonlyArray<FrictionCluster> = [
          {
            key: "verify_failure::typecheck",
            kind: "verify_failure",
            summary: "tsc error in domain",
            detail: "detail 1",
            occurrences: 3,
            lastSeen: "2026-10-26T12:00:00.000Z",
          },
          {
            key: "route_miss::d1",
            kind: "route_miss",
            summary: "missing d1 route",
            detail: "detail 2",
            occurrences: 2,
            lastSeen: "2026-10-26T12:05:00.000Z",
          },
        ]

        const summary = yield* decideSessionHandoff({
          stampValid: false,
          stampReason: "Workspace files modified",
          activeStubs: ["libs/sample/domain/src/index.ts#greet"],
          missingPlannedFns: ["libs/sample/domain/src/index.ts#cancel"],
          frictionClusters: clusters,
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.recentFrictionCount).toBe(5)
        expect(summary.topFrictionSummary).toEqual([
          "[verify_failure x3] tsc error in domain",
          "[route_miss x2] missing d1 route",
        ])

        expect(summary.handoffMessage).not.toBeNull()
        const msg = summary.handoffMessage!
        expect(msg).toContain("[Harness Context Handoff]")
        expect(msg).toContain(
          "Active stub() skeletons remaining: libs/sample/domain/src/index.ts#greet",
        )
        expect(msg).toContain(
          "Missing planned functions from plan-graph-snapshot: libs/sample/domain/src/index.ts#cancel",
        )
        expect(msg).toContain("Verify stamp status: INVALID (Workspace files modified)")
        expect(msg).toContain(
          "Recent friction events: [verify_failure x3] tsc error in domain; [route_miss x2] missing d1 route",
        )
      }),
    )

    it.effect("surfaces stuck loop escalation and marks hasActiveTask when loop is thrashing", () =>
      Effect.gen(function* () {
        const thrashing = yield* decideLoopThrashing([
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "tsc error",
            detail: "error detail 1",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "tsc error",
            detail: "error detail 2",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: "tsc error",
            detail: "error detail 3",
          },
        ])

        const summary = yield* decideSessionHandoff({
          stampValid: true,
          activeStubs: [],
          missingPlannedFns: [],
          frictionClusters: [],
          loopThrashing: thrashing,
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.stuckLoopEscalation).not.toBeNull()
        expect(summary.stuckLoopEscalation).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(summary.handoffMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
      }),
    )
  })

  describe("decideLoopThrashing / checkLoopThrashing (LoopCircuitBreaker.decide)", () => {
    it.effect("detects stuck loops when consecutive identical failure events meet threshold", () =>
      Effect.gen(function* () {
        const events: ReadonlyArray<FrictionEvent> = [
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "type error in domain",
            detail: "d1",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "type error in domain",
            detail: "d2",
          },
          {
            kind: "route_miss",
            timestamp: "2026-10-27T10:01:30.000Z",
            summary: "missed route",
            detail: "d3",
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: " type error in domain ",
            detail: "d4",
          },
        ]

        const status = yield* decideLoopThrashing(events, 3)
        expect(status.stuck).toBe(true)
        expect(status.consecutiveCount).toBe(3)
        expect(status.threshold).toBe(3)
        expect(status.repeatedKey).toBe("verify_failure::type error in domain")
        expect(status.summary).toBe(" type error in domain ")
        expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(status.escalationMessage).toContain("3 times consecutively")

        const syncStatus = checkLoopThrashing(events, 3)
        expect(syncStatus).toEqual(status)
      }),
    )

    it("resets consecutive streak when failure summary changes and handles empty events", () => {
      const emptyStatus = checkLoopThrashing([])
      expect(emptyStatus.stuck).toBe(false)
      expect(emptyStatus.consecutiveCount).toBe(0)
      expect(emptyStatus.repeatedKey).toBeNull()
      expect(emptyStatus.summary).toBeNull()
      expect(emptyStatus.escalationMessage).toBeNull()

      const events: ReadonlyArray<FrictionEvent> = [
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:00:00.000Z",
          summary: "syntax ban",
          detail: "d1",
        },
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:01:00.000Z",
          summary: "syntax ban",
          detail: "d2",
        },
        {
          kind: "guard_escalation",
          timestamp: "2026-10-27T10:02:00.000Z",
          summary: "alchemy dev",
          detail: "d3",
        },
      ]

      const status = checkLoopThrashing(events, 3)
      expect(status.stuck).toBe(false)
      expect(status.consecutiveCount).toBe(1)
      expect(status.repeatedKey).toBe("guard_escalation::alchemy dev")
    })

    it.effect.prop(
      "LoopCircuitBreaker.decide: stuck is true if and only if consecutive failure count meets or exceeds threshold",
      {
        repeatCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        threshold: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
      },
      ({ repeatCount, threshold }) =>
        Effect.gen(function* () {
          const events: Array<FrictionEvent> = Array.from({ length: repeatCount }, (_, i) => ({
            kind: "verify_failure" as const,
            timestamp: new Date(1000 + i * 1000).toISOString(),
            summary: "tsc error",
            detail: "error detail",
          }))
          const status = yield* decideLoopThrashing(events, threshold)
          const effectiveThreshold = Math.max(2, threshold)
          const expectedStuck = repeatCount >= effectiveThreshold
          expect(status.stuck).toBe(expectedStuck)
          expect(status.consecutiveCount).toBe(repeatCount)
          expect(status.threshold).toBe(effectiveThreshold)
          if (expectedStuck) {
            expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
            expect(status.escalationMessage).toContain("verify_failure")
          } else {
            expect(status.escalationMessage).toBeNull()
          }
        }),
    )
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

  describe("decideSpanBudgets", () => {
    it.effect("detects n-plus-one-call violations when child span count exceeds budget", () =>
      Effect.gen(function* () {
        const parent: SpanSample = {
          spanId: "parent-1",
          name: "Order.checkout",
          parentSpanId: null,
        }
        const children: Array<SpanSample> = Array.from({ length: 6 }, (_, i) => ({
          spanId: `child-${i}`,
          name: "Db.query",
          parentSpanId: "parent-1",
        }))

        const violations = yield* decideSpanBudgets({
          spans: [parent, ...children],
          maxRepeatedChildCalls: 5,
        })

        expect(violations).toHaveLength(1)
        const v = violations[0]!
        expect(v.kind).toBe("n-plus-one-call")
        expect(v.parentSpan).toBe("Order.checkout")
        expect(v.targetSpan).toBe("Db.query")
        expect(v.count).toBe(6)
        expect(v.maxAllowed).toBe(5)
        expect(v.message).toContain("N+1 span repetition detected")
      }),
    )

    it.effect("detects span-duration-exceeded violations", () =>
      Effect.gen(function* () {
        const spans: ReadonlyArray<SpanSample> = [
          {
            spanId: "s1",
            name: "SlowOperation",
            parentSpanId: null,
            durationMs: 250.7,
          },
          {
            spanId: "s2",
            name: "FastOperation",
            parentSpanId: null,
            durationMs: 45.2,
          },
        ]

        const violations = yield* decideSpanBudgets({
          spans,
          maxSpanDurationMs: 100,
        })

        expect(violations).toHaveLength(1)
        const v = violations[0]!
        expect(v.kind).toBe("span-duration-exceeded")
        expect(v.parentSpan).toBe("root")
        expect(v.targetSpan).toBe("SlowOperation")
        expect(v.count).toBe(251)
        expect(v.maxAllowed).toBe(100)
        expect(v.message).toContain("Span duration budget exceeded")
      }),
    )
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

  describe("decider property tests & AST mutation testing", () => {
    it.effect(
      "flags domain *.decide without property-based test and passes when property test exists",
      () =>
        Effect.gen(function* () {
          const fnQualname = "libs/sample/domain/src/index.ts#Album.decide"
          const testId = "libs/sample/domain/test/index.test.ts::suite"

          const graphWithoutProp = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Album.decide",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 14,
                successType: "number",
                isStub: false,
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
                isPropertyTest: false,
              },
            ],
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const failingReport = yield* decideGraphEntropy({
            graph: graphWithoutProp,
            checkDeciderPropertyTests: true,
          })

          expect(failingReport.clean).toBe(false)
          const missing = failingReport.findings.find(
            (f) => f.kind === "missing-decider-property-test",
          )
          expect(missing).toBeDefined()
          expect(missing?.nodeId).toBe("Album.decide")
          expect(missing?.message).toContain("0 Property-Based Tests")

          // Now test with isPropertyTest: true
          const graphWithProp = buildHarnessGraph({
            fns: [
              {
                qualname: fnQualname,
                spanName: "Album.decide",
                packageTag: "domain",
                file: "libs/sample/domain/src/index.ts",
                line: 14,
                successType: "number",
                isStub: false,
              },
            ],
            tests: [
              {
                testId,
                testFile: "libs/sample/domain/test/index.test.ts",
                testName: "libs/sample/domain/test/index.test.ts",
                lastTreeHash: "workspace",
                isPropertyTest: true,
              },
            ],
            exercisesSpans: [
              {
                testId,
                calleeQualname: fnQualname,
                callCount: 1,
                receiverLayer: null,
              },
            ],
          })

          const passingReport = yield* decideGraphEntropy({
            graph: graphWithProp,
            checkDeciderPropertyTests: true,
          })

          const deciderFindings = passingReport.findings.filter(
            (f) => f.kind === "missing-decider-property-test",
          )
          expect(deciderFindings).toHaveLength(0)
        }),
    )

    it("discovers boundary, equality, and arithmetic mutants in domain code", () => {
      let root = process.cwd()
      while (root !== dirname(root)) {
        if (existsSync(join(root, "pnpm-workspace.yaml"))) {
          break
        }
        root = dirname(root)
      }
      const diskSource = readFileSync(join(root, "libs/sample/domain/src/index.ts"), "utf8")
      // diskSource has >= and + 1; append equality operator for comprehensive discovery check
      const sampleSource = `${diskSource}\nconst isExact = (a: number) => a === 100\n`
      const mutants = discoverDomainMutants("libs/sample/domain/src/index.ts", sampleSource)

      const expectedBoundaryLine =
        sampleSource.split("\n").findIndex((l) => l.includes("c >= MAX_PHOTOS_PER_ALBUM")) + 1
      const boundary = mutants.find(
        (m) => m.category === "boundary-operator" && m.original === ">=" && m.replacement === ">",
      )
      expect(boundary).toBeDefined()
      expect(boundary?.line).toBe(expectedBoundaryLine)
      expect(boundary?.mutatedSource).toContain("c > MAX_PHOTOS_PER_ALBUM")

      const expectedArithmeticLine =
        sampleSource.split("\n").findIndex((l) => l.includes("currentCount + 1")) + 1
      const arithmetic = mutants.find(
        (m) =>
          m.category === "arithmetic-operator" && m.original === "+ 1" && m.replacement === "- 1",
      )
      expect(arithmetic).toBeDefined()
      expect(arithmetic?.line).toBe(expectedArithmeticLine)
      expect(arithmetic?.mutatedSource).toContain("currentCount - 1")

      const equality = mutants.find(
        (m) =>
          m.category === "equality-operator" && m.original === "===" && m.replacement === "!==",
      )
      expect(equality).toBeDefined()
      expect(equality?.mutatedSource).toContain("a !== 100")
    })

    it("discovers boolean-return mutants (return true -> return false, return false -> return true)", () => {
      const code = `
export const isEnabled = (x: number): boolean => {
  if (x > 0) {
    return true
  }
  return false
}
`
      const mutants = discoverDomainMutants("libs/sample/contract/src/index.ts", code)
      const boolTrue = mutants.find(
        (m) =>
          m.category === "boolean-return" &&
          m.original === "return true" &&
          m.replacement === "return false",
      )
      expect(boolTrue).toBeDefined()
      expect(boolTrue?.mutatedSource).toContain("return false")

      const boolFalse = mutants.find(
        (m) =>
          m.category === "boolean-return" &&
          m.original === "return false" &&
          m.replacement === "return true",
      )
      expect(boolFalse).toBeDefined()
      expect(boolFalse?.mutatedSource).toContain("return true")
    })

    it("discovers batch-folding and terminal-state-preservation mutants for event sourcing", () => {
      const code = `
export const foldEvents = (events: ReadonlyArray<number>, state: number): number => {
  return events.reduce((acc, ev) => acc + ev, state)
}

export const evolveCart = (state: CartState, event: CartEvent): CartState => {
  if (state._tag === "CheckedOut") {
    return state
  }
  return state
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/index.ts", code)
      const batchFolding = mutants.find(
        (m) => m.category === "batch-folding" && m.original === "events.reduce(",
      )
      expect(batchFolding).toBeDefined()
      expect(batchFolding?.mutatedSource).toContain("events.slice(0, 1).reduce(")

      const terminalPreservation = mutants.find(
        (m) => m.category === "terminal-state-preservation" && m.original === "return state",
      )
      expect(terminalPreservation).toBeDefined()
      expect(terminalPreservation?.mutatedSource).toContain("return initialState")
    })

    it.effect("evaluates mutation outcomes and computes correct mutation score", () =>
      Effect.gen(function* () {
        const dummyMutant1: CodeMutant = {
          id: MutantId.make("test:1:>=->>"),
          file: AstSourceFilePath.make("test.ts"),
          line: SourceLineNumber.make(1),
          category: "boundary-operator",
          original: MutantSourceText.make(">="),
          replacement: MutantSourceText.make(">"),
          mutatedSource: MutantSourceText.make("x > 1"),
        }
        const dummyMutant2: CodeMutant = {
          id: MutantId.make("test:2:+ 1->- 1"),
          file: AstSourceFilePath.make("test.ts"),
          line: SourceLineNumber.make(2),
          category: "arithmetic-operator",
          original: MutantSourceText.make("+ 1"),
          replacement: MutantSourceText.make("- 1"),
          mutatedSource: MutantSourceText.make("x - 1"),
        }

        // All killed -> pass with score 1
        const allKilledReport = evaluateMutationOutcomes([
          { mutant: dummyMutant1, status: "killed" },
          { mutant: dummyMutant2, status: "killed" },
        ])
        expect(allKilledReport.passed).toBe(true)
        expect(allKilledReport.totalMutants).toBe(2)
        expect(allKilledReport.killedCount).toBe(2)
        expect(allKilledReport.survivedCount).toBe(0)
        expect(allKilledReport.mutationScore).toBe(1)
        expect(allKilledReport.survivedMutants).toHaveLength(0)

        // One survived -> fail with survivedMutants listing
        const oneSurvivedReport = yield* decideMutationReport({
          outcomes: [
            { mutant: dummyMutant1, status: "killed" },
            { mutant: dummyMutant2, status: "survived" },
          ],
        })
        expect(oneSurvivedReport.passed).toBe(false)
        expect(oneSurvivedReport.totalMutants).toBe(2)
        expect(oneSurvivedReport.killedCount).toBe(1)
        expect(oneSurvivedReport.survivedCount).toBe(1)
        expect(oneSurvivedReport.mutationScore).toBe(0.5)
        expect(oneSurvivedReport.survivedMutants).toEqual([dummyMutant2])
      }),
    )
  })

  describe("decider property tests & AST mutation testing (continued)", () => {
    it("discovers guard-condition mutants for Equal.equals and Exit.isSuccess", () => {
      const sourceCode = `
export const checkGuard = (actual: unknown, expected: unknown, exit: Exit.Exit<unknown, unknown>) => {
  if (!Equal.equals(actual, expected)) {
    return false
  }
  if (Equal.equals(actual, expected)) {
    return true
  }
  if (Exit.isSuccess(exit)) {
    return true
  }
  return false
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/check.ts", sourceCode)
      const guardMutants = mutants.filter((m) => m.category === "guard-condition")
      expect(guardMutants).toHaveLength(3)

      const notEqualMutant = guardMutants.find((m) => m.original === "if (!Equal.equals(")
      expect(notEqualMutant?.replacement).toBe("if (false && !Equal.equals(")

      const equalMutant = guardMutants.find((m) => m.original === "if (Equal.equals(")
      expect(equalMutant?.replacement).toBe("if (true || Equal.equals(")

      const exitMutant = guardMutants.find((m) => m.original === "if (Exit.isSuccess(")
      expect(exitMutant?.replacement).toBe("if (false && Exit.isSuccess(")
    })

    it("discovers mutants for Effect.die, binary addition, array spread, and terminal state counter copy", () => {
      const sourceCode = `
export const evolve = (s: State, e: Event) => {
  const nextCount = s.itemCount + e.quantity
  const nextItems = [...s.items, { itemId: e.itemId, quantity: e.quantity }]
  return {
    ...s,
    items: nextItems,
    totalItems: s.itemCount,
    failArm: Effect.die(new Error("unexpected defect"))
  }
}
`
      const mutants = discoverDomainMutants("libs/sample/domain/src/evolve.ts", sourceCode)

      const dieMutant = mutants.find((m) => m.original === "Effect.die(")
      expect(dieMutant).toBeDefined()
      expect(dieMutant?.replacement).toBe("Effect.succeed(")
      expect(dieMutant?.category).toBe("guard-condition")

      const addMutant = mutants.find(
        (m) => m.category === "arithmetic-operator" && m.original === "s.itemCount + e.quantity",
      )
      expect(addMutant).toBeDefined()
      expect(addMutant?.replacement).toBe("s.itemCount - e.quantity")

      const spreadMutant = mutants.find((m) => m.category === "batch-folding")
      expect(spreadMutant).toBeDefined()
      expect(spreadMutant?.replacement).toBe("s.items")

      const counterMutant = mutants.find((m) => m.original === "totalItems: s.itemCount")
      expect(counterMutant).toBeDefined()
      expect(counterMutant?.replacement).toBe("totalItems: 0")
      expect(counterMutant?.category).toBe("arithmetic-operator")
    })
  })
})
