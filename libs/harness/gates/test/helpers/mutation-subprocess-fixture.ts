import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
import { MutantId, MutantSourceText } from "../../src/index.js"

export const makeSubprocessFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "mut-sub-63-"))
  const srcPath = join(dir, "libs", "demo", "core", "src", "mod.ts")
  const testPath = join(dir, "libs", "demo", "core", "test", "mod.test.ts")
  const backupPath = join(dir, ".harness", "mutation-backup.json")
  const vitestCliPath = join(dir, "node_modules", "vitest", "vitest.mjs")
  const batchRunnerPath = join(dir, "tools", "parallel-vitest-batch.mjs")
  mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
  mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
  mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true })
  mkdirSync(join(dir, "tools"), { recursive: true })
  writeFileSync(vitestCliPath, "// stub\n", "utf8")
  writeFileSync(batchRunnerPath, "// stub\n", "utf8")

  const originalSource = "export const eq = (a: number, b: number) => a === b\n"
  const mutatedSchemaSource = "export const eq = (a: number, b: number) => a !== b\n"
  writeFileSync(srcPath, originalSource, "utf8")
  writeFileSync(testPath, "// test\n", "utf8")

  const domainFile = {
    scope: "demo",
    pkgDir: "core",
    pkgName: "@demo/core",
    tier: "core" as const,
    fullPath: srcPath,
    relFile: "libs/demo/core/src/mod.ts",
  }
  const m1 = {
    id: MutantId.make("m-1"),
    file: AstSourceFilePath.make(domainFile.relFile),
    line: SourceLineNumber.make(1),
    category: "equality-operator" as const,
    original: MutantSourceText.make("==="),
    replacement: MutantSourceText.make("!=="),
    mutatedSource: MutantSourceText.make(mutatedSchemaSource),
  }
  const m2 = {
    id: MutantId.make("m-2"),
    file: AstSourceFilePath.make(domainFile.relFile),
    line: SourceLineNumber.make(1),
    category: "equality-operator" as const,
    original: MutantSourceText.make("==="),
    replacement: MutantSourceText.make("!=="),
    mutatedSource: MutantSourceText.make(mutatedSchemaSource),
  }
  return {
    dir,
    srcPath,
    testPath,
    backupPath,
    vitestCliPath,
    batchRunnerPath,
    originalSource,
    mutatedSchemaSource,
    domainFile,
    m1,
    m2,
  }
}
