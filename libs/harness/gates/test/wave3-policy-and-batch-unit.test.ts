import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { match } from "ts-pattern"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  executeQueuedPackageBatches,
  type PackageBatchFileResult,
  type QueuedPackageEntry,
} from "../src/mutation/mutation-package-batch.js"
import {
  partitionReachingTestFilesChecked,
  type DomainFile,
} from "../src/mutation/mutation-target-discovery.js"
import { isCommandAllowed, splitCommandTokens } from "../src/policy-command-rules.js"
import {
  expandCommandVariables,
  extractExecutedShellSnippets,
  hasUnexpandedShellVariable,
} from "../src/policy-harness-state.js"
import {
  applyPipedXargsTokens,
  extractEchoOrPrintfTokens,
  extractEmbeddedCommandPayloads,
  extractJsRuntimeEvalPayloads,
  isBlockedInlineJsEvalPayload,
  isHarnessCliTargetToken,
  unwrapWorkerCommandWords,
} from "../src/policy-worker-isolation-helpers.js"
import { isWorkerRecursiveWorkflowCommand } from "../src/policy-worker-isolation.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const tempDirs: Array<string> = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wave3-policy-batch-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const makeQueuedEntry = (repoRoot: string, pkgKey: string, relFile: string): QueuedPackageEntry => {
  const file: DomainFile = {
    tier: "domain",
    scope: "harness",
    pkgDir: "demo",
    pkgName: `@harness/${pkgKey.split("/").pop() ?? "demo"}`,
    fullPath: join(repoRoot, relFile),
    relFile,
  }
  return {
    pkgKey,
    mutantKeys: new Map(),
    input: {
      file,
      originalContent: "export const a = 1\n",
      schemaSource: "export const a = 1\n",
      mutants: [],
      uncachedMutants: [],
      primaryTests: [`libs/${pkgKey}/test/a.test.ts`],
      scopedFallbackTests: [],
      packageFallbackTests: [],
      fallbackTests: [],
      cachedHitIds: new Set(),
    },
  }
}

describe("wave3 mutation batch & target discovery unit tests", () => {
  it("executeQueuedPackageBatches handles multi-chunk Ok, finalize abort, and Abort with partial results", () => {
    const repoRoot = makeTempDir()
    const fakeVitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs")
    const fakeRunner = join(repoRoot, "tools", "package-vitest-batch.mjs")
    mkdirSync(join(repoRoot, "node_modules", "vitest"), { recursive: true })
    mkdirSync(join(repoRoot, "tools"), { recursive: true })
    writeFileSync(fakeVitest, "")
    writeFileSync(fakeRunner, "")

    const entries = [1, 2, 3, 4, 5].map((n) =>
      makeQueuedEntry(repoRoot, "harness/demo", `libs/harness/demo/src/f${n}.ts`),
    )
    const mockHostIo = (mode: "ok" | "abortPartial"): SyncHostIo => ({
      ...isolatedTestHostIo,
      execFileSync: (_cmd, _args, opts) => {
        const plan = JSON.parse(
          isolatedTestHostIo.readTextSync(opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!),
        ) as {
          readonly files: ReadonlyArray<{ readonly relFile: string }>
        }
        const rows = plan.files.map((f, idx) => ({
          relFile: f.relFile,
          primaryResults: [],
          scopedFallbackResults: [],
          packageFallbackResults: [],
          ...(mode === "abortPartial" && idx === 1 ? { restoreError: "restore boom" } : {}),
        }))
        return { _tag: "Exited" as const, exitCode: 0, stdout: JSON.stringify(rows), stderr: "" }
      },
    })

    const finalizedOk: Array<string> = []
    const okErr = executeQueuedPackageBatches({
      repoRoot,
      backupPath: join(repoRoot, "backup", "snap.json"),
      hostIo: mockHostIo("ok"),
      baseSubprocessEnv: {},
      queuedByPkg: new Map([["harness/demo", entries]]),
      finalizeEntry: (entry, _result: PackageBatchFileResult) => {
        finalizedOk.push(entry.input.file.relFile)
        return undefined
      },
      recordPartialOnAbort: () => {},
    })
    expect(okErr).toBeUndefined()
    expect(finalizedOk).toEqual(entries.map((e) => e.input.file.relFile))

    const finalizedFinErr: Array<string> = []
    const finAbort = executeQueuedPackageBatches({
      repoRoot,
      backupPath: join(repoRoot, "backup", "snap.json"),
      hostIo: mockHostIo("ok"),
      baseSubprocessEnv: {},
      queuedByPkg: new Map([["harness/demo", entries.slice(0, 2)]]),
      finalizeEntry: (entry) => {
        finalizedFinErr.push(entry.input.file.relFile)
        return "fin-stop"
      },
      recordPartialOnAbort: () => {},
    })
    expect(finAbort).toBe("fin-stop")
    expect(finalizedFinErr).toEqual([entries[0]!.input.file.relFile])

    const finalizedPartial: Array<string> = []
    const abortErr = executeQueuedPackageBatches({
      repoRoot,
      backupPath: join(repoRoot, "backup", "snap.json"),
      hostIo: mockHostIo("abortPartial"),
      baseSubprocessEnv: {},
      queuedByPkg: new Map([["harness/demo", entries.slice(0, 2)]]),
      finalizeEntry: (entry) => {
        finalizedPartial.push(entry.input.file.relFile)
        return undefined
      },
      recordPartialOnAbort: () => {},
    })
    expect(abortErr).toBe("restore boom")
    expect(finalizedPartial).toEqual([entries[0]!.input.file.relFile])
  })

  it("partitionReachingTestFilesChecked resolves app-pure directory for apps scope vs libs scope", () => {
    const repoRoot = makeTempDir()
    mkdirSync(join(repoRoot, "apps", "demo-app", "src"), { recursive: true })
    mkdirSync(join(repoRoot, "apps", "demo-app", "test"), { recursive: true })
    mkdirSync(join(repoRoot, "libs", "harness", "demo-lib", "src"), { recursive: true })
    mkdirSync(join(repoRoot, "libs", "harness", "demo-lib", "test"), { recursive: true })
    const appSrc = "export const appVal = 1\n"
    writeFileSync(join(repoRoot, "apps", "demo-app", "src", "helper.ts"), appSrc)
    writeFileSync(
      join(repoRoot, "apps", "demo-app", "src", "index.ts"),
      "export { appVal as reExportedApp } from './helper.js'\n",
    )
    writeFileSync(
      join(repoRoot, "apps", "demo-app", "test", "app.test.ts"),
      "import { reExportedApp } from 'demo-app'\nexport const u = reExportedApp\n",
    )
    writeFileSync(
      join(repoRoot, "apps", "demo-app", "test", "unrelated1.test.ts"),
      "export const z1 = 1\n",
    )
    writeFileSync(
      join(repoRoot, "apps", "demo-app", "test", "unrelated2.test.ts"),
      "export const z2 = 1\n",
    )

    const libSrc = "export const libVal = 2\n"
    writeFileSync(join(repoRoot, "libs", "harness", "demo-lib", "src", "helper.ts"), libSrc)
    writeFileSync(
      join(repoRoot, "libs", "harness", "demo-lib", "src", "index.ts"),
      "export { libVal as reExportedLib } from './helper.js'\n",
    )
    writeFileSync(
      join(repoRoot, "libs", "harness", "demo-lib", "test", "lib.test.ts"),
      "import { reExportedLib } from '@harness/demo-lib'\nexport const v = reExportedLib\n",
    )
    writeFileSync(
      join(repoRoot, "libs", "harness", "demo-lib", "test", "unrelated1.test.ts"),
      "export const z1 = 2\n",
    )
    writeFileSync(
      join(repoRoot, "libs", "harness", "demo-lib", "test", "unrelated2.test.ts"),
      "export const z2 = 2\n",
    )

    const appRes = partitionReachingTestFilesChecked(
      repoRoot,
      {
        tier: "app-pure",
        scope: "apps",
        pkgDir: "demo-app",
        pkgName: "demo-app",
        fullPath: join(repoRoot, "apps", "demo-app", "src", "helper.ts"),
        relFile: "apps/demo-app/src/helper.ts",
      },
      appSrc,
      isolatedTestHostIo,
    )
    expect(
      match(appRes)
        .with({ _tag: "Ok" }, ({ partition }) => partition.primaryTests)
        .with({ _tag: "Error" }, ({ reason }) => [reason])
        .exhaustive(),
    ).toEqual([join(repoRoot, "apps", "demo-app", "test", "app.test.ts")])

    const libRes = partitionReachingTestFilesChecked(
      repoRoot,
      {
        tier: "app-pure",
        scope: "harness",
        pkgDir: "demo-lib",
        pkgName: "@harness/demo-lib",
        fullPath: join(repoRoot, "libs", "harness", "demo-lib", "src", "helper.ts"),
        relFile: "libs/harness/demo-lib/src/helper.ts",
      },
      libSrc,
      isolatedTestHostIo,
    )
    expect(
      match(libRes)
        .with({ _tag: "Ok" }, ({ partition }) => partition.primaryTests)
        .with({ _tag: "Error" }, ({ reason }) => [reason])
        .exhaustive(),
    ).toEqual([join(repoRoot, "libs", "harness", "demo-lib", "test", "lib.test.ts")])
    expect(computeContentSha256("a").length).toBeGreaterThan(0)
  })
})

describe("wave3 policy helpers & quote scanner unit tests", () => {
  it("policy-harness-state quote scanner covers single, double, ANSI-C, backslash, comments, parens, and vars", () => {
    expect(
      extractExecutedShellSnippets(
        `# $(col0)\necho ' $(no1) ' $'a\\' $(no2) ' "a\\"$(yes1)" <(cat f) #$(no3)\nfoo#$(yes2) \`cmd\\\`sub\` "$(nested 'x)' $'y)' "z\\")")`,
      ),
    ).toEqual(["yes1", "cat f", "yes2", "cmd\\`sub", `nested 'x)' $'y)' "z\\")"`])

    expect(hasUnexpandedShellVariable(`echo ' $SKIP ' $' $SKIP2 \\' ' "ok\\" $HIT"`)).toBe(true)
    expect(hasUnexpandedShellVariable(`echo ' $SKIP ' $'a\\' \\$NO "a\\" $1"`)).toBe(false)
    expect(hasUnexpandedShellVariable(`echo \${OK}`)).toBe(true)

    const exp = expandCommandVariables(
      `A=hello; export B=world; echo '$A' $'\\'$A' "\\"$A $B" \${B} \\$A`,
    )
    expect(exp).toEqual({
      text: `A=hello; export B=world; echo '$A' $'\\'$A' "\\"hello world" world \\$A`,
      overflowed: false,
    })
  })

  it("policy-command-rules splitCommandTokens handles double-quoted escapes and trailing backslash", () => {
    expect(splitCommandTokens(`pnpm exec "a\\"b" 'c\\d' e\\ f`)).toEqual([
      "pnpm",
      "exec",
      'a"b',
      "c\\d",
      "e f",
    ])
    expect(splitCommandTokens(`"a\\`)).toEqual(["a\\"])
    expect(isCommandAllowed(`"pnpm" "exec" "vitest"`)).toBe(true)
    expect(
      isCommandAllowed(`HARNESS_WORKTREE_ID=w1 pnpm exec nx run --flag="x\\"harness-cli" pkg:test`),
    ).toBe(false)
  })

  it("policy-worker-isolation blocks xargs feeding inline JS eval targeting harness workflow", () => {
    expect(isWorkerRecursiveWorkflowCommand(`echo "harness-cli" | xargs node -e`)).toBe(true)
    expect(isWorkerRecursiveWorkflowCommand(`echo "harness status" | xargs node -e`)).toBe(false)
  })

  it("policy-worker-isolation-helpers covers target tokens, unwrappers, payloads, evals, and echo/printf", () => {
    expect(isHarnessCliTargetToken("   ")).toBe(false)
    expect(isHarnessCliTargetToken("{...}")).toBe(false)
    expect(isHarnessCliTargetToken("harness-cli")).toBe(true)
    expect(isHarnessCliTargetToken("@harness/harness-cli")).toBe(true)
    expect(isHarnessCliTargetToken("@harness/cli")).toBe(true)
    expect(isHarnessCliTargetToken("apps/harness-cli")).toBe(true)
    expect(isHarnessCliTargetToken("other-pkg")).toBe(false)

    const baseSeg = {
      rawWords: [] as Array<string>,
      commandWords: [] as Array<string>,
      envAssignments: [],
      wrapperDirs: [],
      sawPackageRunner: false,
      isPnpmHarness: false,
    }
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["exec", "--", "node"],
        commandWords: ["exec", "--", "node"],
      }).commandWords,
    ).toEqual(["node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["exec", "-a", "argv0", "-c", "-l", "-afoo", "node"],
        commandWords: ["exec", "-a", "argv0", "-c", "-l", "-afoo", "node"],
      }).commandWords,
    ).toEqual(["node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["command", "-p", "--", "node"],
        commandWords: ["command", "-p", "--", "node"],
      }).commandWords,
    ).toEqual(["node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["command", "-p", "node"],
        commandWords: ["command", "-p", "node"],
      }).commandWords,
    ).toEqual(["node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["env", "-C", "subA", "--chdir", "subB", "-u", "K", "node"],
        commandWords: ["env", "-C", "subA", "--chdir", "subB", "-u", "K", "node"],
      }),
    ).toMatchObject({ commandWords: ["node"], wrapperDirs: ["subA", "subB"] })
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["env", "-u"],
        commandWords: ["env", "-u"],
      }),
    ).toMatchObject({ commandWords: ["env", "-u"], wrapperDirs: [] })
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["env", "-i", "node"],
        commandWords: ["-i", "node"],
      }).commandWords,
    ).toEqual(["node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["ls", "-i", "node"],
        commandWords: ["-i", "node"],
      }).commandWords,
    ).toEqual(["-i", "node"])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["xargs", "-I", "X", "-n", "1", "xargs", "-n", "1", "node"],
        commandWords: ["xargs", "-I", "X", "-n", "1", "xargs", "-n", "1", "node"],
      }),
    ).toMatchObject({ sawXargs: true, xargsReplaceToken: "X", commandWords: ["node"] })
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["xargs", "-n"],
        commandWords: ["xargs", "-n"],
      }).commandWords,
    ).toEqual([])
    expect(
      unwrapWorkerCommandWords({
        ...baseSeg,
        rawWords: ["xargs", "-I"],
        commandWords: ["xargs", "-I"],
      }).commandWords,
    ).toEqual([])

    expect(extractEmbeddedCommandPayloads(["eval", "--", "echo", "hi"])).toEqual(["echo hi"])
    expect(extractEmbeddedCommandPayloads(["env", "-S", "sh -c id"])).toEqual(["sh -c id"])
    expect(extractEmbeddedCommandPayloads(["env", "--split-string", "id"])).toEqual(["id"])
    expect(extractEmbeddedCommandPayloads(["env", "-S"])).toEqual([])
    expect(extractEmbeddedCommandPayloads(["bash", "-xc", "harness status"])).toEqual([
      "harness status",
    ])
    expect(extractEmbeddedCommandPayloads(["bash", "-x", "script.sh"])).toEqual([])

    expect(extractJsRuntimeEvalPayloads(["deno", "eval", "--", "a", "b"])).toEqual(["a b"])
    expect(extractJsRuntimeEvalPayloads(["deno", "eval", "--"])).toEqual([])
    expect(
      extractJsRuntimeEvalPayloads(["deno", "--import-map", "m.json", "-q", "eval", "body"]),
    ).toEqual(["body"])
    expect(
      extractJsRuntimeEvalPayloads([
        "node",
        "--eval",
        "a",
        "--print",
        "b",
        "-pe",
        "c",
        "--eval=d",
        "-r",
        "m",
        "-w",
        "-e",
      ]),
    ).toEqual(["a", "b", "c", "d"])

    const blocked = new Set(["ship"])
    expect(isBlockedInlineJsEvalPayload("harness daemon.sock", blocked)).toBe(true)
    expect(isBlockedInlineJsEvalPayload("harness auth-tokens.json", blocked)).toBe(true)
    expect(isBlockedInlineJsEvalPayload("harness done", blocked)).toBe(true)
    expect(isBlockedInlineJsEvalPayload("harness status", blocked)).toBe(false)

    expect(
      extractEchoOrPrintfTokens({ ...baseSeg, commandWords: ["printf", "-v", "out", "%s", "a"] }),
    ).toEqual(["a"])
    expect(extractEchoOrPrintfTokens({ ...baseSeg, commandWords: ["printf", "%s"] })).toEqual([
      "%s",
    ])
    expect(extractEchoOrPrintfTokens({ ...baseSeg, commandWords: ["printf", "%s", "x"] })).toEqual([
      "x",
    ])
    expect(
      applyPipedXargsTokens(
        {
          commandWords: ["node", "-e", "run({})", "{}"],
          sawPackageRunner: false,
          wrapperDirs: [],
          packageTargets: [],
          sawXargs: true,
          xargsReplaceToken: "{}",
        },
        ["a", "b"],
      ),
    ).toEqual(["node", "-e", "run(a b)", "a", "b"])
  })
})
