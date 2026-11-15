import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  runBenchmarkCompare,
  runCheckEventSchemas,
  runCheckMigrations,
  runCheckOpenApi,
} from "../src/commands/repo-checks.command.js"
import { resolveRepoPath, resolveRepoPathChecked } from "../src/commands/repo-path.js"
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

    // --out (escape + positive in-root control)
    const outEscape1 = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--out", "../escape.json"], opts),
    )
    expect(outEscape1.exitCode).toBe(1)
    expect(outEscape1.stderr).toMatch(/escapes repository root/)
    expect(existsSync(join(tmpDir, "..", "escape.json"))).toBe(false)

    const outEscape2 = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--out", "sym-escape/out.json"], opts),
    )
    expect(outEscape2.exitCode).toBe(1)
    expect(outEscape2.stderr).toMatch(/escapes repository root/)
    expect(existsSync(join(outsideDir, "out.json"))).toBe(false)

    const outControl = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
    )
    expect(outControl.exitCode).toBe(0)

    // --module (escape + positive in-root control)
    const modEscape1 = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "../mod.mjs"], opts),
    )
    expect(modEscape1.exitCode).toBe(1)
    expect(modEscape1.stderr).toMatch(/escapes repository root/)

    const modEscape2 = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--module", "sym-escape/mod.mjs"], opts),
    )
    expect(modEscape2.exitCode).toBe(1)
    expect(modEscape2.stderr).toMatch(/escapes repository root/)

    // --baseline on check-openapi and benchmark
    const openapiBaseEscape = await Effect.runPromise(
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
    expect(openapiBaseEscape.exitCode).toBe(1)
    expect(openapiBaseEscape.stderr).toMatch(/escapes (?:repository )?root/)

    const benchBaseEscape = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--baseline", "sym-escape/secret.json"], opts),
    )
    expect(benchBaseEscape.exitCode).toBe(1)
    expect(benchBaseEscape.stderr).toMatch(/escapes (?:repository )?root/)

    // OPENAPI_BASELINE_PATH
    const prevEnv = process.env.OPENAPI_BASELINE_PATH
    try {
      process.env.OPENAPI_BASELINE_PATH = "sym-escape/secret.json"
      const openapiEnvEscape = await Effect.runPromise(
        runCheckOpenApi(
          ["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"],
          opts,
        ),
      )
      expect(openapiEnvEscape.exitCode).toBe(1)
      expect(openapiEnvEscape.stderr).toMatch(/escapes (?:repository )?root/)
    } finally {
      if (prevEnv === undefined) {
        Reflect.deleteProperty(process.env, "OPENAPI_BASELINE_PATH")
      } else {
        process.env.OPENAPI_BASELINE_PATH = prevEnv
      }
    }

    // --snapshot (escape + positive in-root control)
    const snapEscape = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--snapshot", "sym-escape/snap.json"],
        opts,
      ),
    )
    expect(snapEscape.exitCode).toBe(1)
    expect(snapEscape.stderr).toMatch(/escapes repository root/)
    expect(existsSync(join(outsideDir, "snap.json"))).toBe(false)

    // --package & --dir (escape + positive in-root control)
    const pkgEscape = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "sym-escape"], opts),
    )
    expect(pkgEscape.exitCode).toBe(1)
    expect(pkgEscape.stderr).toMatch(/escapes repository root/)

    const dirEscape = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "sym-escape"], opts),
    )
    expect(dirEscape.exitCode).toBe(1)
    expect(dirEscape.stderr).toMatch(/escapes repository root/)

    const inRootMigs = join(tmpDir, "in-root-migs")
    mkdirSync(inRootMigs, { recursive: true })
    writeFileSync(
      join(inRootMigs, "0001_init.sql"),
      "CREATE TABLE IF NOT EXISTS control_items (id TEXT PRIMARY KEY NOT NULL);\n",
      "utf8",
    )
    const dirControl = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "in-root-migs"], opts),
    )
    expect(dirControl.exitCode).toBe(0)
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

    const evMod = join(tmpDir, "events-control.mjs")
    writeFileSync(
      evMod,
      [
        "export const registeredUpcasters = []",
        "export const computeEventSnapshots = () => [{ eventType: 'Ping', version: 1, jsonSchema: '{\"type\":\"object\"}' }]",
      ].join("\n"),
      "utf8",
    )

    // Dangling symlinks pointing to non-existent targets outside repoRoot
    symlinkSync(join(outsideDir, "nonexistent-out.json"), join(tmpDir, "dangling-out.json"))
    symlinkSync(join(outsideDir, "nonexistent-base.json"), join(tmpDir, "dangling-base.json"))
    symlinkSync(join(outsideDir, "nonexistent-snap.json"), join(tmpDir, "dangling-snap.json"))
    symlinkSync(join(outsideDir, "nonexistent-bench.json"), join(tmpDir, "dangling-bench.json"))

    // 1. ../../etc/passwd traversal
    const openApiBaseTrav = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--baseline", "../../etc/passwd", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
    )
    expect(openApiBaseTrav.exitCode).toBe(1)
    expect(openApiBaseTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const benchBaseTrav = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--baseline", "../../etc/passwd"], opts),
    )
    expect(benchBaseTrav.exitCode).toBe(1)
    expect(benchBaseTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const benchOutTrav = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--out", "../../etc/passwd"], opts),
    )
    expect(benchOutTrav.exitCode).toBe(1)
    expect(benchOutTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const evSnapTrav = await Effect.runPromise(
      runCheckEventSchemas(["check-event-schemas", "--snapshot", "../../etc/passwd"], opts),
    )
    expect(evSnapTrav.exitCode).toBe(1)
    expect(evSnapTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const evOutTrav = await Effect.runPromise(
      runCheckEventSchemas(["check-event-schemas", "--module", "events-control.mjs", "--out", "../../etc/passwd"], opts),
    )
    expect(evOutTrav.exitCode).toBe(1)
    expect(evOutTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const migPkgTrav = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "../../etc/passwd"], opts),
    )
    expect(migPkgTrav.exitCode).toBe(1)
    expect(migPkgTrav.stderr).toMatch(/escapes (?:repository )?root/)

    const migDirTrav = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "../../etc/passwd"], opts),
    )
    expect(migDirTrav.exitCode).toBe(1)
    expect(migDirTrav.stderr).toMatch(/escapes (?:repository )?root/)

    // 2. Dangling symlinks
    const openApiDanglingOut = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--out", "dangling-out.json", "--write", "--module", "openapi-mod.mjs"], opts),
    )
    expect(openApiDanglingOut.exitCode).toBe(1)
    expect(openApiDanglingOut.stderr).toMatch(/escapes (?:repository )?root/)

    const openApiDanglingBase = await Effect.runPromise(
      runCheckOpenApi(["check-openapi", "--baseline", "dangling-base.json", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
    )
    expect(openApiDanglingBase.exitCode).toBe(1)
    expect(openApiDanglingBase.stderr).toMatch(/escapes (?:repository )?root/)

    const danglingSnap = await Effect.runPromise(
      runCheckEventSchemas(["check-event-schemas", "--snapshot", "dangling-snap.json"], opts),
    )
    expect(danglingSnap.exitCode).toBe(1)
    expect(danglingSnap.stderr).toMatch(/escapes (?:repository )?root/)
    expect(existsSync(join(outsideDir, "nonexistent-snap.json"))).toBe(false)

    // Positive in-root control for check-event-schemas
    const evUpdate = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-control.mjs", "--snapshot", "in-root-snap.json", "--update"],
        opts,
      ),
    )
    expect(evUpdate.exitCode).toBe(0)
    const evControl = await Effect.runPromise(
      runCheckEventSchemas(
        ["check-event-schemas", "--module", "events-control.mjs", "--snapshot", "in-root-snap.json"],
        opts,
      ),
    )
    expect(evControl.exitCode).toBe(0)

    const evDanglingOut = await Effect.runPromise(
      runCheckEventSchemas(["check-event-schemas", "--module", "events-control.mjs", "--out", "dangling-snap.json"], opts),
    )
    expect(evDanglingOut.exitCode).toBe(1)
    expect(evDanglingOut.stderr).toMatch(/escapes (?:repository )?root/)

    const benchDanglingOut = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--out", "dangling-bench.json"], opts),
    )
    expect(benchDanglingOut.exitCode).toBe(1)
    expect(benchDanglingOut.stderr).toMatch(/escapes (?:repository )?root/)
    expect(existsSync(join(outsideDir, "nonexistent-bench.json"))).toBe(false)

    const prevEnv = process.env.OPENAPI_BASELINE_PATH
    try {
      process.env.OPENAPI_BASELINE_PATH = "dangling-base.json"
      const openApiDanglingEnv = await Effect.runPromise(
        runCheckOpenApi(["check-openapi", "--module", "openapi-mod.mjs", "--out", "openapi.json"], opts),
      )
      expect(openApiDanglingEnv.exitCode).toBe(1)
      expect(openApiDanglingEnv.stderr).toMatch(/escapes (?:repository )?root/)
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
    const nestedSqlRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "nested-migs"], opts),
    )
    expect(nestedSqlRes.exitCode).toBe(1)
    expect(nestedSqlRes.stderr).toMatch(/escapes (?:repository )?root/)

    const outsideTs = join(outsideDir, "evil.ts")
    writeFileSync(outsideTs, "export const x = 1\n", "utf8")
    const pkgSrc = join(tmpDir, "libs", "nested", "infra", "src")
    mkdirSync(pkgSrc, { recursive: true })
    symlinkSync(outsideTs, join(pkgSrc, "escape.ts"))
    const nestedTsRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/nested/infra"], opts),
    )
    expect(nestedTsRes.exitCode).toBe(1)
    expect(nestedTsRes.stderr).toMatch(/escapes (?:repository )?root/)

    // 4. benchmark IoError (ENOTDIR) vs EscapesRoot
    writeFileSync(join(tmpDir, "regular-file.txt"), "not a directory\n", "utf8")
    const benchBaseIoErr = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--baseline", "regular-file.txt/sub.json"], opts),
    )
    expect(benchBaseIoErr.exitCode).toBe(1)
    expect(benchBaseIoErr.stderr).toMatch(/Cannot resolve baseline path.*ENOTDIR/)
    expect(benchBaseIoErr.stderr).not.toMatch(/escapes (?:repository )?root/)

    const benchOutIoErr = await Effect.runPromise(
      runBenchmarkCompare(["benchmark", "--out", "regular-file.txt/out.json"], opts),
    )
    expect(benchOutIoErr.exitCode).toBe(1)
    expect(benchOutIoErr.stderr).toMatch(/Cannot resolve output path.*ENOTDIR/)
    expect(benchOutIoErr.stderr).not.toMatch(/escapes (?:repository )?root/)
  })

  it("check-migrations fails closed (exitCode 1) when SqliteMigrator.fromRecord has 0 static keys and no .sql files", async () => {
    const tmpDir = makeTempDir("harness-mig-zero-keys-")
    const pkgSrc = join(tmpDir, "libs", "zero", "infra", "src")
    mkdirSync(pkgSrc, { recursive: true })
    writeFileSync(
      join(pkgSrc, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        'import { importedMigrations } from "./other.js"',
        "export const run = SqliteMigrator.fromRecord(importedMigrations)",
      ].join("\n"),
      "utf8",
    )
    const res = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/zero/infra"], {
        repoRoot: tmpDir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("no SqliteMigrator.fromRecord records were found")
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

  it("F-3.1 & F-3.2: check-migrations AST validates inline/identifier SqliteMigrator.fromRecord, ignores nested object keys, and fails closed on empty package", async () => {
    const tmpDir = makeTempDir("harness-cli-mig-ast-")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    // 1. Empty package with zero migrations -> fail closed (exitCode 1)
    mkdirSync(join(tmpDir, "libs", "empty", "infra", "src"), { recursive: true })
    writeFileSync(join(tmpDir, "libs", "empty", "infra", "src", "index.ts"), "export const x = 1\n", "utf8")
    const emptyPkgRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/empty/infra"], opts),
    )
    expect(emptyPkgRes.exitCode).toBe(1)
    expect(emptyPkgRes.stderr).toContain("no SqliteMigrator.fromRecord records were found")

    // 2. Multi-line body containing nested object property `table_name:` -> pass (exitCode 0)
    const nestedPropDir = join(tmpDir, "libs", "nestedprop", "infra", "src")
    mkdirSync(nestedPropDir, { recursive: true })
    writeFileSync(
      join(nestedPropDir, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        "export const migrations = SqliteMigrator.fromRecord({",
        '  "1_init": () => {',
        "    const meta = {",
        '      table_name: "items",',
        "    }",
        "    return meta",
        "  },",
        "})",
      ].join("\n"),
      "utf8",
    )
    const nestedPropRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/nestedprop/infra"], opts),
    )
    expect(nestedPropRes.exitCode).toBe(0)

    // 3. Inline { "1_init": ..., "BadKey": ... } -> fail (exitCode 2)
    const mixedDir = join(tmpDir, "libs", "mixed", "infra", "src")
    mkdirSync(mixedDir, { recursive: true })
    writeFileSync(
      join(mixedDir, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        "export const migrations = SqliteMigrator.fromRecord({",
        '  "1_init": () => {},',
        '  "BadKey": () => {},',
        "})",
      ].join("\n"),
      "utf8",
    )
    const mixedRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/mixed/infra"], opts),
    )
    expect(mixedRes.exitCode).toBe(2)
    expect(mixedRes.stderr).toContain("invalid-migrator-record-key")

    // 4. Identifier SqliteMigrator.fromRecord(albumCounterMigrations) -> checked & validated
    const identValidDir = join(tmpDir, "libs", "identvalid", "infra", "src")
    mkdirSync(identValidDir, { recursive: true })
    writeFileSync(
      join(identValidDir, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        "const albumCounterMigrations = {",
        '  "1_init_albums": () => {},',
        "}",
        "export const layer = SqliteMigrator.fromRecord(albumCounterMigrations)",
      ].join("\n"),
      "utf8",
    )
    const identValidRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/identvalid/infra"], opts),
    )
    expect(identValidRes.exitCode).toBe(0)

    const identBadDir = join(tmpDir, "libs", "identbad", "infra", "src")
    mkdirSync(identBadDir, { recursive: true })
    writeFileSync(
      join(identBadDir, "migrator.ts"),
      [
        'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
        "const albumCounterMigrations = {",
        '  "BadIdentKey": () => {},',
        "}",
        "export const layer = SqliteMigrator.fromRecord(albumCounterMigrations)",
      ].join("\n"),
      "utf8",
    )
    const identBadRes = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--package", "libs/identbad/infra"], opts),
    )
    expect(identBadRes.exitCode).toBe(2)
    expect(identBadRes.stderr).toContain("invalid-migrator-record-key")
  })

  it("M-12.1(d): resolveRepoPathChecked distinguishes ELOOP and ENOTDIR I/O errors from EscapesRoot", async () => {
    const tmpDir = makeTempDir("harness-cli-repopath-io-")
    symlinkSync(join(tmpDir, "loop-b"), join(tmpDir, "loop-a"))
    symlinkSync(join(tmpDir, "loop-a"), join(tmpDir, "loop-b"))

    const eloopRes = resolveRepoPathChecked(tmpDir, "loop-a")
    match(eloopRes)
      .with({ _tag: "IoError" }, ({ code }) => {
        expect(code).toBe("ELOOP")
      })
      .with({ _tag: "Resolved" }, { _tag: "EscapesRoot" }, () => {
        expect.unreachable("Expected IoError for ELOOP")
      })
      .exhaustive()

    writeFileSync(join(tmpDir, "regular-file"), "hello\n", "utf8")
    const enotdirRes = resolveRepoPathChecked(tmpDir, "regular-file/child.sql")
    match(enotdirRes)
      .with({ _tag: "IoError" }, ({ code }) => {
        expect(code).toBe("ENOTDIR")
      })
      .with({ _tag: "Resolved" }, { _tag: "EscapesRoot" }, () => {
        expect.unreachable("Expected IoError for ENOTDIR")
      })
      .exhaustive()

    const migEloop = await Effect.runPromise(
      runCheckMigrations(["check-migrations", "--dir", "loop-a"], {
        repoRoot: tmpDir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(migEloop.exitCode).toBe(1)
    expect(migEloop.stderr).toContain("Cannot resolve")
    expect(migEloop.stderr).toContain("ELOOP")
    expect(migEloop.stderr).not.toContain("escapes repository root")
  })

  it("F-19.1: resolveRepoPathChecked returns IoError when repoRoot hits ELOOP and resolveRepoPath returns undefined on IoError/EscapesRoot", () => {
    const tmpDir = makeTempDir("harness-cli-repopath-f19-1-")
    const loopRootA = join(tmpDir, "root-loop-a")
    const loopRootB = join(tmpDir, "root-loop-b")
    symlinkSync(loopRootB, loopRootA)
    symlinkSync(loopRootA, loopRootB)

    const rootIoRes = resolveRepoPathChecked(loopRootA, "src/index.ts")
    match(rootIoRes)
      .with({ _tag: "IoError" }, ({ code }) => {
        expect(code).toBe("ELOOP")
      })
      .with({ _tag: "Resolved" }, { _tag: "EscapesRoot" }, () => {
        expect.unreachable("Expected IoError when repoRoot hits ELOOP")
      })
      .exhaustive()

    expect(resolveRepoPath(loopRootA, "src/index.ts")).toBeUndefined()
    expect(resolveRepoPath(tmpDir, "../outside.ts")).toBeUndefined()
  })
})
