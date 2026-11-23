import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { CLUSTER_SCHEMA_EPOCH } from "../../src/commands/omnigraph-auth-and-drift.js"

export const getDeadChildPid = (): number => {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"])
  expect(res.pid).toBeGreaterThan(1)
  return res.pid
}

export const createRfc0009TempRepo = (tempDirs: Array<string>, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "harness", "graph", "queries"), { recursive: true })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "schema.pg"), "node EffectFn {}\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "queries", "harness.gq"),
    "query q() { match (n:EffectFn) return n }\n",
    "utf8",
  )
  return dir
}

export const cleanupRfc0009TempDirs = (tempDirs: Array<string>): void => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

export const setupNonIsolatedWorkspaceDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const configDir = join(dir, "libs", "harness", "graph")
  mkdirSync(join(configDir, "queries"), { recursive: true })
  writeFileSync(join(configDir, "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(join(configDir, "schema.pg"), "", "utf8")
  writeFileSync(join(configDir, "queries", "harness.gq"), "", "utf8")
  const clusterRootDir = join(dir, ".harness", "omnigraph-cluster")
  mkdirSync(clusterRootDir, { recursive: true })
  writeFileSync(join(clusterRootDir, ".config-stamp"), "name: test\n\n---\n\n---\n", "utf8")
  writeFileSync(join(clusterRootDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH, "utf8")
  return dir
}
