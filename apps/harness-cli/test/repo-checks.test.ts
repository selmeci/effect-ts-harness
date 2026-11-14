import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  runBenchmarkCompare,
  runCheckEventSchemas,
  runCheckMigrations,
  runCheckOpenApi,
} from "../src/commands/repo-checks.command.js"
import { collectHarnessTierTopologyViolationMessages } from "../src/commands/verify-delta-gates.js"
import { evaluatePackageAndMigrationPlugin } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"

const tempDirs: Array<string> = []

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("repo-checks.command behavioral suite (F-7.1, F-9.1b)", () => {
  it("runCheckOpenApi: handles --write (0), fresh (0), stale (1), and breaking removal vs --baseline (2)", async () => {
    const tmpDir = makeTempDir("harness-cli-openapi-")
    const modPath = join(tmpDir, "openapi-mod.mjs")
    const outPath = join(tmpDir, "openapi.json")
    const baselinePath = join(tmpDir, "baseline.json")

    writeFileSync(
      modPath,
      [
        "export const buildOpenApiSpec = () => ({",
        '  openapi: "3.1.0",',
        '  paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } },',
        "})",
        "export const detectOpenApiBreakingChanges = (baseline, current) => {",
        "  const bPaths = Object.keys((baseline && baseline.paths) || {})",
        "  const cPaths = new Set(Object.keys((current && current.paths) || {}))",
        "  return bPaths.filter((p) => !cPaths.has(p)).map((p) => `Removed path ${p}`)",
        "}",
      ].join("\n"),
      "utf8",
    )

    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const writeRes = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json", "--write"], opts),
    )
    expect(writeRes.exitCode).toBe(0)

    const freshRes = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
    )
    expect(freshRes.exitCode).toBe(0)

    writeFileSync(outPath, JSON.stringify({ openapi: "3.1.0", paths: {} }), "utf8")
    const staleRes = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
    )
    expect(staleRes.exitCode).toBe(1)

    writeFileSync(
      baselinePath,
      JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/health": { get: {} },
          "/removed-endpoint": { get: {} },
        },
      }),
      "utf8",
    )
    const breakingRes = await Effect.runPromise(
      runCheckOpenApi(
        [
          "check-openapi",
          "--module",
          "openapi-mod.mjs",
          "--out",
          "openapi.json",
          "--baseline",
          "baseline.json",
        ],
        opts,
      ),
    )
    expect(breakingRes.exitCode).toBe(2)
    expect(breakingRes.stderr).toContain("ESCALATE")
  })

  it("runCheckMigrations: missing dir (1), clean additive SQL (0), destructive DROP TABLE (2)", async () => {
    const tmpDir = makeTempDir("harness-cli-migrations-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const missingRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations"], opts),
    )
    expect(missingRes.exitCode).toBe(1)

    const migrationsDir = join(tmpDir, "libs", "sample", "infra", "migrations")
    mkdirSync(migrationsDir, { recursive: true })
    writeFileSync(
      join(migrationsDir, "0001_init.sql"),
      "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY NOT NULL);\n",
      "utf8",
    )
    const cleanRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations"], opts),
    )
    expect(cleanRes.exitCode).toBe(0)

    writeFileSync(
      join(migrationsDir, "0002_drop.sql"),
      "DROP TABLE items;\n",
      "utf8",
    )
    const destructiveRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations"], opts),
    )
    expect(destructiveRes.exitCode).toBe(2)
    expect(destructiveRes.stderr).toContain("ESCALATE")
  })

  it("runCheckEventSchemas: missing (1), --update (0), valid (0), tampered (1), frozen drift (2)", async () => {
    const tmpDir = makeTempDir("harness-cli-events-")
    const modPath = join(tmpDir, "events-mod.mjs")
    const snapPath = join(tmpDir, "snapshots.json")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    writeFileSync(
      modPath,
      [
        "export const registeredUpcasters = []",
        "export const computeEventSnapshots = () => [",
        "  {",
        '    eventType: "ItemAdded",',
        "    version: 1,",
        '    jsonSchema: "{\\"type\\":\\"object\\",\\"properties\\":{\\"id\\":{\\"type\\":\\"string\\"}}}",',
        "  },",
        "]",
      ].join("\n"),
      "utf8",
    )

    const missingRes = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-mod.mjs", "--snapshot", "snapshots.json"],
        opts,
      ),
    )
    expect(missingRes.exitCode).toBe(1)

    const updateRes = await Effect.runPromise(
      runCheckEventSchemas(
        [
          "check-event-schemas",
          "--module",
          "events-mod.mjs",
          "--snapshot",
          "snapshots.json",
          "--update",
        ],
        opts,
      ),
    )
    expect(updateRes.exitCode).toBe(0)

    const validRes = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-mod.mjs", "--snapshot", "snapshots.json"],
        opts,
      ),
    )
    expect(validRes.exitCode).toBe(0)

    writeFileSync(snapPath, "{not-valid-json", "utf8")
    const tamperedRes = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-mod.mjs", "--snapshot", "snapshots.json"],
        opts,
      ),
    )
    expect(tamperedRes.exitCode).toBe(1)

    writeFileSync(
      snapPath,
      JSON.stringify([
        {
          eventType: "ItemAdded",
          version: 1,
          jsonSchema: '{"type":"object"}',
        },
      ]),
      "utf8",
    )
    const driftRes = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-mod.mjs", "--snapshot", "snapshots.json"],
        opts,
      ),
    )
    expect(driftRes.exitCode).toBe(2)
  })

  it("runBenchmarkCompare: within budget (0) with --out, regression/broken baseline (1)", async () => {
    const tmpDir = makeTempDir("harness-cli-bench-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const passRes = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--out", "bench-out.json"], opts),
    )
    expect(passRes.exitCode).toBe(0)
    expect(readFileSync(join(tmpDir, "bench-out.json"), "utf8")).toContain('"passedAcceptance": true')

    const brokenRes = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--baseline", "missing-baseline.json"], opts),
    )
    expect(brokenRes.exitCode).toBe(1)

    const regressionPath = join(tmpDir, "regression.json")
    writeFileSync(
      regressionPath,
      JSON.stringify([
        {
          taskId: "task-1",
          mode: "harness",
          diagnosticsBeforeGreen: 10,
          fixUpIterations: 10,
          tokenCount: 99999,
        },
        {
          taskId: "task-1",
          mode: "no-harness",
          diagnosticsBeforeGreen: 0,
          fixUpIterations: 1,
          tokenCount: 100,
        },
      ]),
      "utf8",
    )
    const regressRes = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--baseline", "regression.json"], opts),
    )
    expect(regressRes.exitCode).toBe(1)
  })

  it("T-7: check-migrations supports --package and --dir, rejects conflicting flags, empty dir (1), and invalid SqliteMigrator.fromRecord key (2)", async () => {
    const tmpDir = makeTempDir("harness-cli-migrations-t7-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const conflictRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/a", "--dir", "libs/b"], opts),
    )
    expect(conflictRes.exitCode).toBe(1)

    const emptyDir = join(tmpDir, "empty-migrations")
    mkdirSync(emptyDir, { recursive: true })
    const emptyRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "empty-migrations"], opts),
    )
    expect(emptyRes.exitCode).toBe(1)

    const customMigrations = join(tmpDir, "custom-migrations")
    mkdirSync(customMigrations, { recursive: true })
    writeFileSync(
      join(customMigrations, "0001_init.sql"),
      "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY NOT NULL);\n",
      "utf8",
    )
    const dirCleanRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "custom-migrations"], opts),
    )
    expect(dirCleanRes.exitCode).toBe(0)

    const pkgSrcDir = join(tmpDir, "libs", "custom", "infra", "src")
    mkdirSync(pkgSrcDir, { recursive: true })
    writeFileSync(
      join(pkgSrcDir, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        "export const badMigrations = SqliteMigrator.fromRecord({",
        '  "badKey": () => Effect.void,',
        "})",
      ].join("\n"),
      "utf8",
    )
    const badKeyRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/custom/infra"], opts),
    )
    expect(badKeyRes.exitCode).toBe(2)
    expect(badKeyRes.stderr).toContain("invalid-migrator-record-key")
  })

  it("T-9: rejects ../ traversal and symlink escapes across --out, --module, --baseline, OPENAPI_BASELINE_PATH, --snapshot, --package, and --dir", async () => {
    const tmpDir = makeTempDir("harness-cli-escape-root-")
    const outsideDir = makeTempDir("harness-cli-escape-outside-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    writeFileSync(
      join(outsideDir, "secret.json"),
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
      "utf8",
    )
    writeFileSync(join(outsideDir, "mod.mjs"), "export const x = 1\n", "utf8")
    symlinkSync(outsideDir, join(tmpDir, "sym-escape"), "dir")

    const validMod = join(tmpDir, "openapi-mod.mjs")
    writeFileSync(
      validMod,
      [
        "export const buildOpenApiSpec = () => ({ openapi: '3.1.0', paths: {} })",
        "export const detectOpenApiBreakingChanges = () => []",
      ].join("\n"),
      "utf8",
    )
    writeFileSync(
      join(tmpDir, "openapi.json"),
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
      "utf8",
    )

    // --out
    expect(
      (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--out", "../escape.json"], opts)))
        .exitCode,
    ).toBe(1)
    expect(
      (
        await Effect.runPromise(
          runCheckOpenApi(["check-openapi", "--out", "sym-escape/out.json"], opts),
        )
      ).exitCode,
    ).toBe(1)

    // --module
    expect(
      (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--module", "../mod.mjs"], opts)))
        .exitCode,
    ).toBe(1)
    expect(
      (
        await Effect.runPromise(
          runCheckOpenApi(["check-openapi", "--module", "sym-escape/mod.mjs"], opts),
        )
      ).exitCode,
    ).toBe(1)

    // --baseline on check-openapi and benchmark
    expect(
      (
        await Effect.runPromise(
          runCheckOpenApi(
            [
              "check-openapi",
              "--module",
              "openapi-mod.mjs",
              "--out",
              "openapi.json",
              "--baseline",
              "sym-escape/secret.json",
            ],
            opts,
          ),
        )
      ).exitCode,
    ).toBe(1)
    expect(
      (
        await Effect.runPromise(
          runBenchmarkCompare(["benchmark", "--baseline", "sym-escape/secret.json"], opts),
        )
      ).exitCode,
    ).toBe(1)

    // OPENAPI_BASELINE_PATH
    const prevEnv = process.env.OPENAPI_BASELINE_PATH
    try {
      process.env.OPENAPI_BASELINE_PATH = "sym-escape/secret.json"
      expect(
        (
          await Effect.runPromise(
            runCheckOpenApi(
              ["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"],
              opts,
            ),
          )
        ).exitCode,
      ).toBe(1)
    } finally {
      if (prevEnv === undefined) {
        Reflect.deleteProperty(process.env, "OPENAPI_BASELINE_PATH")
      } else {
        process.env.OPENAPI_BASELINE_PATH = prevEnv
      }
    }

    // --snapshot
    expect(
      (
        await Effect.runPromise(
          runCheckEventSchemas(
            ["check-event-schemas", "--snapshot", "sym-escape/snap.json"],
            opts,
          ),
        )
      ).exitCode,
    ).toBe(1)

    // --package & --dir
    expect(
      (
        await Effect.runPromise(
          runCheckMigrations(["check-migrations", "--package", "sym-escape"], opts),
        )
      ).exitCode,
    ).toBe(1)
    expect(
      (
        await Effect.runPromise(
          runCheckMigrations(["check-migrations", "--dir", "sym-escape"], opts),
        )
      ).exitCode,
    ).toBe(1)
  })

  it("T-9b: rejects ../../etc/passwd traversal, dangling symlinks, and nested migration symlinks", async () => {
    const tmpDir = makeTempDir("harness-cli-dangling-root-")
    const outsideDir = makeTempDir("harness-cli-dangling-outside-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const validMod = join(tmpDir, "openapi-mod.mjs")
    writeFileSync(
      validMod,
      [
        "export const buildOpenApiSpec = () => ({ openapi: '3.1.0', paths: {} })",
        "export const detectOpenApiBreakingChanges = () => []",
      ].join("\n"),
      "utf8",
    )
    writeFileSync(
      join(tmpDir, "openapi.json"),
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
      "utf8",
    )

    // Dangling symlinks pointing to non-existent targets outside repoRoot
    symlinkSync(join(outsideDir, "nonexistent-out.json"), join(tmpDir, "dangling-out.json"))
    symlinkSync(join(outsideDir, "nonexistent-base.json"), join(tmpDir, "dangling-base.json"))
    symlinkSync(join(outsideDir, "nonexistent-snap.json"), join(tmpDir, "dangling-snap.json"))
    symlinkSync(join(outsideDir, "nonexistent-bench.json"), join(tmpDir, "dangling-bench.json"))

    // 1. ../../etc/passwd traversal
    expect(
      (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--baseline", "../../etc/passwd", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runBenchmarkCompare(["benchmark", "--baseline", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runBenchmarkCompare(["benchmark", "--out", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckEventSchemas(["check-event-schemas", "--snapshot", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckEventSchemas(["check-event-schemas", "--out", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckMigrations(["check-migrations", "--package", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckMigrations(["check-migrations", "--dir", "../../etc/passwd"], opts))).exitCode,
    ).toBe(1)

    // 2. Dangling symlinks
    expect(
      (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--out", "dangling-out.json", "--write", "--module", "openapi-mod.mjs"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--baseline", "dangling-base.json", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckEventSchemas(["check-event-schemas", "--snapshot", "dangling-snap.json"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runCheckEventSchemas(["check-event-schemas", "--out", "dangling-snap.json"], opts))).exitCode,
    ).toBe(1)
    expect(
      (await Effect.runPromise(runBenchmarkCompare(["benchmark", "--out", "dangling-bench.json"], opts))).exitCode,
    ).toBe(1)
    expect(existsSync(join(outsideDir, "nonexistent-bench.json"))).toBe(false)

    const prevEnv = process.env.OPENAPI_BASELINE_PATH
    try {
      process.env.OPENAPI_BASELINE_PATH = "dangling-base.json"
      expect(
        (await Effect.runPromise(runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts))).exitCode,
      ).toBe(1)
    } finally {
      if (prevEnv === undefined) Reflect.deleteProperty(process.env, "OPENAPI_BASELINE_PATH")
      else process.env.OPENAPI_BASELINE_PATH = prevEnv
    }

    // 3. Nested migration .sql and .ts symlinks escaping repoRoot
    const outsideSql = join(outsideDir, "evil.sql")
    writeFileSync(outsideSql, "SELECT 1;\n", "utf8")
    const nestedMigDir = join(tmpDir, "nested-migs")
    mkdirSync(nestedMigDir, { recursive: true })
    symlinkSync(outsideSql, join(nestedMigDir, "0001_escape.sql"))
    expect(
      (await Effect.runPromise(runCheckMigrations(["check-migrations", "--dir", "nested-migs"], opts))).exitCode,
    ).toBe(1)

    const outsideTs = join(outsideDir, "evil.ts")
    writeFileSync(outsideTs, "export const x = 1\n", "utf8")
    const pkgSrc = join(tmpDir, "libs", "nested", "infra", "src")
    mkdirSync(pkgSrc, { recursive: true })
    symlinkSync(outsideTs, join(pkgSrc, "escape.ts"))
    expect(
      (await Effect.runPromise(runCheckMigrations(["check-migrations", "--package", "libs/nested/infra"], opts))).exitCode,
    ).toBe(1)
  })

  it("collectHarnessTierTopologyViolationMessages & gc plugin ban drizzle-kit in root package.json and devDependencies", async () => {
    const tmpDir = makeTempDir("harness-drizzle-manifest-")
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root-repo", devDependencies: { "drizzle-kit": "^0.30.0" } }),
      "utf8",
    )
    mkdirSync(join(tmpDir, "libs", "sample", "contract", "src"), { recursive: true })
    writeFileSync(
      join(tmpDir, "libs", "sample", "contract", "package.json"),
      JSON.stringify({
        name: "@sample/contract",
        nx: { tags: ["type:contract"] },
        dependencies: { effect: "^4.0.0" },
        devDependencies: { vitest: "^3.0.0", "drizzle-kit": "^0.30.0" },
      }),
      "utf8",
    )
    writeFileSync(join(tmpDir, "libs", "sample", "contract", "src", "index.ts"), "export const x = 1\n", "utf8")

    const msgs = await Effect.runPromise(collectHarnessTierTopologyViolationMessages(tmpDir))
    expect(msgs.some((m) => m.includes("package.json") && m.includes("drizzle-kit"))).toBe(true)
    expect(msgs.some((m) => m.includes("libs/sample/contract/package.json") && m.includes("drizzle-kit"))).toBe(true)
    expect(msgs.some((m) => m.includes("vitest"))).toBe(false)

    const gcFindings = await Effect.runPromise(
      evaluatePackageAndMigrationPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tmpDir,
        hostIo: nodeSyncHostIo,
      }),
    )
    expect(gcFindings.some((f) => f.location === "package.json" && f.message.includes("drizzle-kit"))).toBe(true)
    expect(
      gcFindings.some((f) => f.location === "libs/sample/contract/package.json" && f.message.includes("drizzle-kit")),
    ).toBe(true)

    writeFileSync(join(tmpDir, "package.json"), "{malformed-json", "utf8")
    const malformedMsgs = await Effect.runPromise(collectHarnessTierTopologyViolationMessages(tmpDir))
    expect(malformedMsgs.some((m) => m.includes("[invalid-package-manifest] package.json"))).toBe(true)
    const malformedGc = await Effect.runPromise(
      evaluatePackageAndMigrationPlugin({
        graph: buildHarnessGraph({}),
        workspaceRoot: tmpDir,
        hostIo: nodeSyncHostIo,
      }),
    )
    expect(malformedGc.some((f) => f.nodeId === "package.json:corrupt-manifest")).toBe(true)
  })
})
