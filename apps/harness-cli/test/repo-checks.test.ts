import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
})
