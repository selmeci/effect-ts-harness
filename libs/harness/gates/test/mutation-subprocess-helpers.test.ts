import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  classifyMutantSubprocessResult,
  runVitestTargetList,
} from "../src/mutation-subprocess-helpers.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  isAssertionFailure,
  locateWrapTargetSpan,
  verifyMutantSchemaSyntax,
} from "../src/mutation/mutant-ast-generator.js"
import { testHostIo } from "./helpers/test-host-io.js"
import { makeSubprocessFixture } from "./helpers/mutation-subprocess-fixture.js"

describe("mutation-subprocess-helpers: classifyMutantSubprocessResult", () => {
  const noisyInfraStderr =
    'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "vitest" not found\nError: Cannot find module "@missing/pkg"\n'

  it("aborts when Vitest test failure evidence is paired with noisy infra strings in stderr", () => {
    const res = classifyMutantSubprocessResult(
      "m-1",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "Tests  1 failed (1)\n",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res.kind).toBe("abort")
  })

  it("aborts when stderr contains infra errors even on exitCode 0 with passed summary", () => {
    const res = classifyMutantSubprocessResult(
      "m-2",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "Tests  5 passed (5)\n",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res.kind).toBe("abort")
  })

  it("classifies exitCode 1 with FAIL header in stderr (Vitest v5 --bail=1) as killed", () => {
    const res = classifyMutantSubprocessResult(
      "m-stderr-fail",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: " FAIL  libs/demo/test/a.test.ts > fails\n",
      }),
    )
    expect(res).toEqual({ kind: "outcome", status: "killed" })
  })

  it("aborts when stdout is empty and stderr contains infra errors on exitCode 1 or 0", () => {
    const res1 = classifyMutantSubprocessResult(
      "m-3",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res1.kind).toBe("abort")

    const res0 = classifyMutantSubprocessResult(
      "m-4",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res0.kind).toBe("abort")

    const missingPassSummary = classifyMutantSubprocessResult(
      "m-5",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "runner exited without vitest test summary\n",
        stderr: "",
      }),
    )
    match(missingPassSummary)
      .with({ kind: "abort" }, ({ diagnostic }) => {
        expect(diagnostic).toContain("missingVitestPassSummary=true")
      })
      .with({ kind: "outcome" }, () => {
        expect.unreachable("Expected abort when Vitest pass summary is missing")
      })
      .exhaustive()
  })
})

describe("mutation-subprocess-helpers & mutant-ast-generator: Wave 2B #63 saturation", () => {
  it("3a. mutation-subprocess-helpers: diagnostics & backup-retry restore", () => {
    const missingEvidence = classifyMutantSubprocessResult(
      "m-x",
      Result.succeed({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }),
    )
    match(missingEvidence)
      .with({ kind: "abort" }, ({ diagnostic }) => {
        expect(diagnostic).toContain("missingVitestFailureEvidence=true")
      })
      .with({ kind: "outcome" }, () => {
        expect.unreachable("Expected abort")
      })
      .exhaustive()

    const exit2 = classifyMutantSubprocessResult(
      "m-x",
      Result.succeed({ _tag: "Exited", exitCode: 2, stdout: "", stderr: "boom" }),
    )
    expect(exit2).toEqual({
      kind: "abort",
      diagnostic:
        "[mutation-check] Runner infrastructure failure for mutant 'm-x': exitCode=2, stderr=boom",
    })

    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      for (const failUnlink of [true, false]) {
        writeFileSync(srcPath, originalSource, "utf8")
        let srcWriteCount = 0
        const retryIo: SyncHostIo = {
          ...testHostIo,
          existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
          writeTextSync: (p, c) => {
            if (p === srcPath) {
              srcWriteCount += 1
              if (srcWriteCount === 2) throw new Error("disk busy")
            }
            testHostIo.writeTextSync(p, c)
          },
          unlinkSync: (p) => {
            if (failUnlink && p === backupPath) throw new Error("unlink denied")
            testHostIo.unlinkSync(p)
          },
          execFileSync: (_cmd, _args, opts) => {
            if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
              return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
            }
            return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
          },
        }
        const retryRes = runVitestTargetList(
          dir,
          domainFile,
          retryIo,
          { NO_COLOR: "1" },
          [testPath],
          originalSource,
          mutatedSchemaSource,
          backupPath,
          [m1],
        )
        if (failUnlink) {
          match(retryRes)
            .with({ _tag: "Abort" }, ({ diagnostic }) => {
              expect(diagnostic).toContain("from backup retry but Failed to unlink")
            })
            .with({ _tag: "Ok" }, () => {
              expect.unreachable("Expected abort when unlink fails")
            })
            .exhaustive()
          if (testHostIo.existsSync(backupPath)) testHostIo.unlinkSync(backupPath)
        } else {
          match(retryRes)
            .with({ _tag: "Ok" }, ({ outcomes }) => {
              expect(outcomes).toHaveLength(1)
              expect(outcomes[0]?.status).toBe("killed")
            })
            .with({ _tag: "Abort" }, ({ diagnostic }) => {
              expect.unreachable(`Expected ok, got: ${diagnostic}`)
            })
            .exhaustive()
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3b. mutation-subprocess-helpers: batch vs sequential runner selection and batch error cases", () => {
    const {
      dir,
      testPath,
      backupPath,
      vitestCliPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    } = makeSubprocessFixture()
    try {
      const seenSingleArgs: Array<ReadonlyArray<string>> = []
      const singleIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          seenSingleArgs.push(args)
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const singleRes = runVitestTargetList(
        dir,
        domainFile,
        singleIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      expect(singleRes._tag).toBe("Ok")
      expect(seenSingleArgs.every((a) => !a.includes(batchRunnerPath))).toBe(true)
      expect(seenSingleArgs.some((a) => a.includes(vitestCliPath))).toBe(true)

      const makeBatchIo = (batchResult: SyncHostExecResult): SyncHostIo => ({
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args[0] === batchRunnerPath) return batchResult
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      })

      const batchOk = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" },
            },
            {
              id: "m-2",
              result: { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" },
            },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      match(batchOk)
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes.map((o) => o.status)).toEqual(["killed", "survived"])
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected batchOk, got: ${diagnostic}`)
        })
        .exhaustive()

      // F-2.a & F-2.b: batch Signaled preserves signal name (SIGTERM) and fails closed (abort)
      const batchSignaled = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" },
            },
            { id: "m-2", result: { _tag: "Signaled", signal: "SIGTERM", stdout: "", stderr: "" } },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      match(batchSignaled)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("terminated by signal SIGTERM")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected batchSignaled to abort")
        })
        .exhaustive()

      const batchExit2 = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({ _tag: "Exited", exitCode: 2, stdout: "", stderr: "batch crash" }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchExit2._tag === "Abort" && batchExit2.diagnostic.includes("exited with code 2"),
      ).toBe(true)

      const batchMissing = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" },
            },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchMissing._tag === "Abort" &&
          batchMissing.diagnostic.includes("Batch runner missing result"),
      ).toBe(true)

      const batchSpawnFail = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" },
            },
            {
              id: "m-2",
              result: { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" },
            },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchSpawnFail._tag === "Abort" && batchSpawnFail.diagnostic.includes("spawnError="),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3c. mutation-subprocess-helpers: sequential loop with 2 mutants (survive vs abort)", () => {
    const {
      dir,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    } = makeSubprocessFixture()
    try {
      const seqSurviveIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: () => ({
          _tag: "Exited",
          exitCode: 0,
          stdout: "Tests  1 passed (1)\n",
          stderr: "",
        }),
      }
      const seqSurviveRes = runVitestTargetList(
        dir,
        domainFile,
        seqSurviveIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      match(seqSurviveRes)
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes).toHaveLength(2)
          expect(outcomes.map((o) => o.status)).toEqual(["survived", "survived"])
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected ok, got: ${diagnostic}`)
        })
        .exhaustive()

      let seqExecCalls = 0
      const seqAbortIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          seqExecCalls += 1
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }
        },
      }
      const seqAbortRes = runVitestTargetList(
        dir,
        domainFile,
        seqAbortIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(seqAbortRes._tag).toBe("Abort")
      expect(seqExecCalls).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3d. mutation-subprocess-helpers: writeSchemaErr when 1st writeTextSync throws", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      for (const failUnlink of [false, true]) {
        writeFileSync(srcPath, originalSource, "utf8")
        let firstWrite = true
        const writeErrIo: SyncHostIo = {
          ...testHostIo,
          writeTextSync: (p, c) => {
            if (p === srcPath && firstWrite) {
              firstWrite = false
              throw new Error("schema write denied")
            }
            testHostIo.writeTextSync(p, c)
          },
          unlinkSync: (p) => {
            if (failUnlink && p === backupPath) throw new Error("unlink blocked")
            testHostIo.unlinkSync(p)
          },
          execFileSync: () => ({
            _tag: "Exited",
            exitCode: 0,
            stdout: "Tests  1 passed (1)\n",
            stderr: "",
          }),
        }
        const writeErrRes = runVitestTargetList(
          dir,
          domainFile,
          writeErrIo,
          { NO_COLOR: "1" },
          [testPath],
          originalSource,
          mutatedSchemaSource,
          backupPath,
          [m1],
        )
        match(writeErrRes)
          .with({ _tag: "Abort" }, ({ diagnostic }) => {
            expect(diagnostic).toContain("Failed to write mutated schema")
            if (failUnlink) {
              expect(diagnostic).toContain("Failed to unlink")
            } else {
              expect(diagnostic.endsWith("schema write denied")).toBe(true)
            }
          })
          .with({ _tag: "Ok" }, () => {
            expect.unreachable("Expected abort on writeSchemaErr")
          })
          .exhaustive()
        if (testHostIo.existsSync(backupPath)) testHostIo.unlinkSync(backupPath)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3e. mutation-subprocess-helpers: mid-run reversion guard", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      writeFileSync(srcPath, originalSource, "utf8")
      const clobberIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          testHostIo.writeTextSync(srcPath, originalSource)
          return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const clobberRes = runVitestTargetList(
        dir,
        domainFile,
        clobberIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      match(clobberRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("modified externally mid-run")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected abort on mid-run reversion")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3f. mutation-subprocess-helpers: mid-loop exception always runs restoreOriginalFile and reports restore status", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      const throwingIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          throw new Error("unexpected mid-loop exec crash")
        },
      }
      const res = runVitestTargetList(
        dir,
        domainFile,
        throwingIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      expect(testHostIo.readTextSync(srcPath)).toBe(originalSource)
      expect(testHostIo.existsSync(backupPath)).toBe(false)
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("unexpected mid-loop exec crash")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected abort on mid-loop exception")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("4. mutant-ast-generator: offset-0, CRLF, locateWrapTargetSpan edge cases, shebang, and syntax verification", () => {
    const topMutants = discoverDomainMutants(
      "libs/demo/domain/src/top.ts",
      "events.reduce((a, b) => a + b, 0)\n",
    )
    expect(topMutants).toHaveLength(1)

    const crlfSource = ["const pad = 'x === y'", "events.reduce((a, b) => a + b, 0)"].join("\r\n")
    const crlfMutants = discoverDomainMutants("libs/demo/domain/src/crlf.ts", crlfSource)
    expect(crlfMutants).toHaveLength(1)
    expect(crlfMutants[0]?.line).toBe(2)
    expect(crlfMutants[0]?.mutatedSource).toContain("\r\n")

    const spanOf = (code: string, needle: string, atEnd = false): string | undefined => {
      const sf = ts.createSourceFile(
        "span.ts",
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const start = code.indexOf(needle)
      const span = locateWrapTargetSpan(
        sf,
        atEnd ? start + needle.length : start,
        start + needle.length,
      )
      return span === undefined ? undefined : code.slice(span.start, span.end)
    }

    expect(spanOf("if (flag) { return a === b }", "flag", true)).toBe("flag")
    expect(spanOf("if (flagA && flagB) { return a === b }", "flagB")).toBe("flagA && flagB")
    expect(spanOf("if (flag) { return a === b }", "a === b")).toBe("a === b")
    expect(spanOf("function f() { return }", "return")).toBeUndefined()
    expect(spanOf("function f(a: number, b: number) { return a === b }", "a === b")).toBe("a === b")
    expect(spanOf("class Sub extends Base { m() { return super.foo() } }", "super")).toBe(
      "super.foo()",
    )
    expect(spanOf("const v = obj.prop", "prop")).toBe("obj.prop")
    expect(spanOf("const v = obj.prop", "obj")).toBe("obj")
    expect(spanOf("const o = { key: val }", "key")).toBe("{ key: val }")
    expect(spanOf("const o = { key: val }", "val")).toBe("val")
    expect(spanOf("fn(arg)", "fn")).toBe("fn(arg)")
    expect(spanOf("fn(arg)", "arg")).toBe("arg")
    expect(spanOf("new Cls(arg)", "Cls")).toBe("new Cls(arg)")
    expect(spanOf("new Cls(arg)", "arg")).toBe("arg")
    expect(spanOf("tag`tpl`", "tag")).toBe("tag`tpl`")
    expect(spanOf("obj.x += 1", "obj.x")).toBe("obj.x += 1")
    expect(spanOf("obj.x += 1", "1")).toBe("1")
    expect(spanOf("++obj.x", "obj.x")).toBe("++obj.x")

    const shebangSrc = "#!/usr/bin/env node\nexport const eq = (a: number, b: number) => a === b\n"
    const shebangMutants = discoverDomainMutants("libs/demo/domain/src/cli.ts", shebangSrc)
    const shebangBundle = compileMutantSchemaModule(
      "libs/demo/domain/src/cli.ts",
      shebangSrc,
      shebangMutants,
    )
    expect(shebangBundle.schemaSource.startsWith("#!/usr/bin/env node\nfunction __hMut")).toBe(true)
    expect(
      verifyMutantSchemaSyntax("libs/demo/domain/src/cli.ts", shebangBundle.schemaSource),
    ).toEqual([])
    expect(verifyMutantSchemaSyntax("bad.ts", "export const x = (;").length).toBeGreaterThan(0)

    expect(isAssertionFailure(new Error("plain failure"))).toBe(false)
    const assertionErr = new Error("boom")
    assertionErr.name = "AssertionError"
    expect(isAssertionFailure(assertionErr)).toBe(true)
    const expectErr = new Error("boom")
    expectErr.name = "ExpectError"
    expect(isAssertionFailure(expectErr)).toBe(true)

    expect(evaluateMutantSchemaInProcess(topMutants, [() => true]).map((o) => o.status)).toEqual([
      "survived",
    ])
    expect(evaluateMutantSchemaInProcess(topMutants, [() => {}]).map((o) => o.status)).toEqual([
      "survived",
    ])
    expect(evaluateMutantSchemaInProcess(topMutants, [() => false]).map((o) => o.status)).toEqual([
      "killed",
    ])
  })

  it("REQ-1.2: batched per-package baseline runs 1 baseline call across multiple files and falls back to per-file baseline on package failure", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pkg-baseline-test-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      const testDir = join(repoRoot, "libs", "demo", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      writeFileSync(join(srcDir, "a.ts"), "export const eqA = (x: number, y: number) => x === y\n")
      writeFileSync(join(srcDir, "b.ts"), "export const eqB = (x: number, y: number) => x === y\n")
      writeFileSync(join(testDir, "a.test.ts"), 'import { eqA } from "../src/a.js"\n')
      writeFileSync(join(testDir, "b.test.ts"), 'import { eqB } from "../src/b.js"\n')

      let baselineCalls = 0
      const notGit: SyncHostExecResult = {
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "not a git repository",
      }
      const okIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            baselineCalls += 1
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  2 passed (2)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const okReport = runDomainMutationSuite(repoRoot, okIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(okReport.passed).toBe(true)
      expect(okReport.evaluatedFiles).toEqual([
        "libs/demo/domain/src/a.ts",
        "libs/demo/domain/src/b.ts",
      ])
      expect(baselineCalls).toBe(1)

      // When package baseline fails and a.test.ts passes while b.test.ts fails,
      // fall back to per-file baseline and emit exact failing file 'libs/demo/domain/src/b.ts'
      const failIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            if (args.some((a) => a.includes("b.test.ts"))) {
              return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "b-broken" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      // Make a.test.ts import only a.ts (already true), and use targetFiles: [a.ts] first to verify single-file < 2 guard
      let singleBaselineCalls = 0
      const singleReport = runDomainMutationSuite(
        repoRoot,
        {
          ...okIo,
          execFileSync: (cmd, args, opts) => {
            if (cmd !== "git" && opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
              singleBaselineCalls += 1
            }
            return okIo.execFileSync(cmd, args, opts)
          },
        },
        {
          targetFiles: ["libs/demo/domain/src/a.ts"],
          includeAllLines: true,
          disableMutantCache: true,
        },
      )
      expect(singleReport.passed).toBe(true)
      expect(singleBaselineCalls).toBe(1)

      // In failIo: a.test.ts only reaches a.ts? Wait: findReachingTestFilesChecked returns all tests in test/ unless filtered,
      // so mock a.test.ts-only pass when only a.test.ts is in args; if both a.test.ts and b.test.ts are in args,
      // package baseline fails and a.ts passes if a.ts only imports a.test.ts — let's ensure a.test.ts has a vitest import so
      // partitionReachingTestFilesChecked puts a.test.ts in primaryTests for a.ts and b.test.ts in primaryTests for b.ts.
      const failReport = runDomainMutationSuite(repoRoot, failIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(failReport.passed).toBe(false)
      expect(failReport.diagnostic).toContain(
        "[mutation-check] Baseline test suite failed on unmutated file 'libs/demo/domain/src/",
      )
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-Adv.9: runVitestTargetList scales baseline, batch, and sequential timeouts with reachingTestFiles.length", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "scaled-timeout-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      mkdirSync(srcDir, { recursive: true })
      const modPath = join(srcDir, "mod.ts")
      const src = "export const eq = (a: number, b: number) => a === b\n"
      writeFileSync(modPath, src)
      const mutants = discoverDomainMutants("libs/demo/domain/src/mod.ts", src)
      const bundle = compileMutantSchemaModule("libs/demo/domain/src/mod.ts", src, mutants)
      const seenTimeouts: Array<number | undefined> = []
      const io: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, opts) => {
          seenTimeouts.push(opts?.timeoutMs)
          return opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined
            ? { _tag: "Exited", exitCode: 0, stdout: "Tests  5 passed (5)\n", stderr: "" }
            : { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const fiveTests = ["t1.test.ts", "t2.test.ts", "t3.test.ts", "t4.test.ts", "t5.test.ts"]
      const res = runVitestTargetList(
        repoRoot,
        {
          scope: "demo",
          pkgDir: "domain",
          tier: "domain",
          fullPath: modPath,
          relFile: "libs/demo/domain/src/mod.ts",
        },
        io,
        {},
        fiveTests,
        src,
        bundle.schemaSource,
        join(repoRoot, ".harness", "mutation-backup.json"),
        mutants.slice(0, 1),
      )
      expect(res._tag).toBe("Ok")
      expect(seenTimeouts).toEqual([50_000, 50_000])
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
