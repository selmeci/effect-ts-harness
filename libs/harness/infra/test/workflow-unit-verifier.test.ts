import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AttemptNumber,
  GitCommitSha,
  OwnedRelPath,
  PackageVerifyCommand,
  SHARED_STEP_UNIT_ID,
  WorkflowRunId,
  isPureInterruptCause,
  parsePackageVerifyCommand,
  toPackageVerifyCommandArgv,
} from "@harness/contract"
import { decideSpanBudgets, writeVerifyStamp } from "@harness/gates"
import { UnitVerifier } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecOptions } from "@harness/service/host-io"
import {
  completeSharedStepImpl,
  completeUnitImpl,
  makeUnitVerifierLayer,
  nodeSyncHostIo,
} from "../src/index.js"
import { spawnVerifyCommand } from "../src/workflow/verify-child-process.js"
import { isLocalPidAlive } from "../src/writer-lease.js"
import {
  runWithTestTracer,
  withTempDir,
  initGitRepo,
  makeStampHostIo,
  makeSliceUnit,
  makePackageUnit,
  writeExecutableScript,
  waitForFilesExist,
} from "./helpers/workflow-verifier-fixture.js"

describe("UnitVerifier (L1 epic, L2 slice, shared-step)", () => {
  it.live(
    "L1 epic rejects uncommitted edits with AgentFailed even when HARNESS_WORKTREE_ID is set",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 2\n",
            "utf8",
          )
          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l1-0001"),
              level: "epic",
              baseSha,
              unit: makeSliceUnit(),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: { ...process.env, HARNESS_WORKTREE_ID: "must-be-ignored-in-l1" } },
          )
          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("AgentFailed")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(AgentFailed)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live("L1 epic rejects missing verify stamp with StampMissing", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        writeFileSync(
          join(repoRoot, "libs", "alpha", "src", "index.ts"),
          "export const alpha = 2\n",
          "utf8",
        )
        execFileSync("git", ["add", "libs/alpha/src/index.ts"], { cwd: repoRoot })
        execFileSync("git", ["commit", "-m", "alpha slice work"], {
          cwd: repoRoot,
          stdio: "ignore",
        })

        const outcome = yield* completeUnitImpl(
          {
            runId: WorkflowRunId.make("run-l1-0001"),
            level: "epic",
            baseSha,
            unit: makeSliceUnit(),
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          },
          { env: { ...process.env, HARNESS_WORKTREE_ID: "must-be-ignored-in-l1" } },
        )
        match(outcome)
          .with({ _tag: "Rejected" }, (r) => {
            expect(r.rejection._tag).toBe("StampMissing")
          })
          .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
            expect.unreachable("Expected Rejected(StampMissing)")
          })
          .exhaustive()
      }),
    ),
  )

  it.live(
    "L1 epic completes after valid repo-level verify stamp ignoring HARNESS_WORKTREE_ID",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 2\n",
            "utf8",
          )
          execFileSync("git", ["add", "libs/alpha/src/index.ts"], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "alpha slice work"], {
            cwd: repoRoot,
            stdio: "ignore",
          })

          const cleanEnv: Record<string, string | undefined> = { ...process.env }
          Reflect.deleteProperty(cleanEnv, "HARNESS_WORKTREE_ID")
          Reflect.deleteProperty(cleanEnv, "HARNESS_STATE_DIR")
          const stamp = writeVerifyStamp(repoRoot, makeStampHostIo(cleanEnv), "slice/alpha-unit")

          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l1-0001"),
              level: "epic",
              baseSha,
              unit: makeSliceUnit(),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: { ...process.env, HARNESS_WORKTREE_ID: "must-be-ignored-in-l1" } },
          )
          match(outcome)
            .with({ _tag: "Completed" }, (c) => {
              expect(c.unitId).toBe("alpha-slice")
              expect(c.changedPaths).toEqual([OwnedRelPath.make("libs/alpha/src/index.ts")])
              expect(c.packageStampHash).toBe(stamp.treeHash)
            })
            .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Completed")
            })
            .exhaustive()
        }),
      ),
  )

  it.live("L2 slice rejects empty diff with AgentFailed", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        const outcome = yield* completeUnitImpl({
          runId: WorkflowRunId.make("run-l2-0001"),
          level: "slice",
          baseSha,
          unit: makePackageUnit(),
          attempt: AttemptNumber.make(1),
          cwd: repoRoot,
          siblingInFlightOwnedPaths: [],
        })
        match(outcome)
          .with({ _tag: "Rejected" }, (r) => {
            expect(r.rejection._tag).toBe("AgentFailed")
          })
          .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
            expect.unreachable("Expected Rejected(AgentFailed)")
          })
          .exhaustive()
      }),
    ),
  )

  it.live(
    "L2 slice rejects unowned changes with WriteSetViolation and completes when excluded via siblingInFlightOwnedPaths",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 42\n",
            "utf8",
          )
          writeFileSync(
            join(repoRoot, "libs", "beta", "src", "index.ts"),
            "export const beta = 99\n",
            "utf8",
          )

          const recordedCalls: Array<{
            readonly cmd: string
            readonly args: ReadonlyArray<string>
            readonly worktreeId: string | undefined
          }> = []
          const mockHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (
              cmd: string,
              args: ReadonlyArray<string>,
              opts?: SyncHostExecOptions,
            ) => {
              if (cmd === "git") {
                return nodeSyncHostIo.execFileSync(cmd, args, opts)
              }
              recordedCalls.push({ cmd, args, worktreeId: opts?.env?.HARNESS_WORKTREE_ID })
              return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
            },
          }

          const violationOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: mockHostIo },
          )
          match(violationOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "WriteSetViolation" }, (v) => {
                  expect(v.offendingPaths).toEqual([OwnedRelPath.make("libs/beta/src/index.ts")])
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected WriteSetViolation")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation)")
            })
            .exhaustive()

          const layer = makeUnitVerifierLayer({ hostIo: mockHostIo })
          const passOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(2),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [OwnedRelPath.make("libs/beta")],
            })
          }).pipe(Effect.provide(layer))

          match(passOutcome)
            .with({ _tag: "Completed" }, (c) => {
              expect(c.changedPaths).toEqual([OwnedRelPath.make("libs/alpha/src/index.ts")])
              expect(c.packageStampHash).toMatch(/^[0-9a-f]{64}$/)
            })
            .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Completed with sibling exclusion")
            })
            .exhaustive()

          expect(recordedCalls).toEqual([
            { cmd: "pnpm", args: ["nx", "run", "@harness/alpha:verify"], worktreeId: "pkg-alpha" },
          ])
        }),
      ),
  )

  it.live(
    "L2 slice rejects non-zero exit with PackageVerifyFailed(non-zero-exit), clamped exitCode 1..255, and detail",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 42\n",
            "utf8",
          )
          const mockHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) =>
              cmd === "git"
                ? nodeSyncHostIo.execFileSync(cmd, args, opts)
                : {
                    _tag: "Exited",
                    exitCode: 300,
                    stdout: "",
                    stderr: "  lint failed at line 9  \n",
                  },
          }

          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(3),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: mockHostIo },
          )
          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.exitCode).toBe(255)
                  expect(p.failureKind).toBe("non-zero-exit")
                  expect(p.detail).toBe("lint failed at line 9")
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected PackageVerifyFailed")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(PackageVerifyFailed)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "L2 slice enforces case-sensitive NFC ownership and exact boundary matching (F-13.2 / F-23.6)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          mkdirSync(join(repoRoot, "Src"), { recursive: true })
          mkdirSync(join(repoRoot, "libs", "alpha-extra"), { recursive: true })
          writeFileSync(join(repoRoot, "Src", "A.ts"), "export const upper = 1\n", "utf8")
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "other.ts"),
            "export const o = 1\n",
            "utf8",
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha-extra", "file.ts"),
            "export const extra = 1\n",
            "utf8",
          )

          const mockHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) =>
              cmd === "git"
                ? nodeSyncHostIo.execFileSync(cmd, args, opts)
                : { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" },
          }

          // Case mismatch + sibling-prefix ("libs/alpha" vs "libs/alpha-extra")
          const caseMismatchOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-case-1"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({ ownedRelPaths: ["src", "libs/alpha"] }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: mockHostIo },
          )
          match(caseMismatchOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "WriteSetViolation" }, (v) => {
                  expect(v.offendingPaths).toEqual([
                    OwnedRelPath.make("Src/A.ts"),
                    OwnedRelPath.make("libs/alpha-extra/file.ts"),
                  ])
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable(
                      "Expected WriteSetViolation on Src/A.ts and libs/alpha-extra/file.ts",
                    )
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation)")
            })
            .exhaustive()

          // Exact-file boundary: owning "libs/alpha/src/index.ts" rejects "libs/alpha/src/other.ts"
          const narrowFileDir = join(dir, "narrow-repo")
          mkdirSync(narrowFileDir, { recursive: true })
          const { repoRoot: narrowRoot, baseSha: narrowBase } = initGitRepo(narrowFileDir)
          writeFileSync(
            join(narrowRoot, "libs", "alpha", "src", "other.ts"),
            "export const o = 2\n",
            "utf8",
          )
          const narrowOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-narrow-1"),
              level: "slice",
              baseSha: narrowBase,
              unit: makePackageUnit({ ownedRelPaths: ["libs/alpha/src/index.ts"] }),
              attempt: AttemptNumber.make(1),
              cwd: narrowRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: mockHostIo },
          )
          match(narrowOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "WriteSetViolation" }, (v) => {
                  expect(v.offendingPaths).toEqual([OwnedRelPath.make("libs/alpha/src/other.ts")])
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected WriteSetViolation for non-owned other.ts")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation)")
            })
            .exhaustive()

          // Unicode NFC/NFD normalization: owner NFC "Café.ts" matches NFD "Cafe\u0301.ts" on disk
          const unicodeDir = join(dir, "unicode-repo")
          mkdirSync(unicodeDir, { recursive: true })
          const { repoRoot: unicodeRoot, baseSha: unicodeBase } = initGitRepo(unicodeDir)
          writeFileSync(
            join(unicodeRoot, "libs", "alpha", "src", "Cafe\u0301.ts"),
            "export const cafe = 1\n",
            "utf8",
          )
          const unicodeOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-unicode-1"),
              level: "slice",
              baseSha: unicodeBase,
              unit: makePackageUnit({ ownedRelPaths: ["libs/alpha/src/Caf\u00e9.ts"] }),
              attempt: AttemptNumber.make(1),
              cwd: unicodeRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: mockHostIo },
          )
          expect(unicodeOutcome._tag).toBe("Completed")
        }),
      ),
  )

  it("parsePackageVerifyCommand and toPackageVerifyCommandArgv parse supported command variants canonically (F-13.3 / S-3.1)", () => {
    const pnpmNxRun = parsePackageVerifyCommand(
      PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    )
    expect(Option.isOption(pnpmNxRun)).toBe(true)
    match(pnpmNxRun)
      .with({ _tag: "Some" }, ({ value }) => {
        expect(value._tag).toBe("NxRun")
        expect(toPackageVerifyCommandArgv(value)).toEqual({
          executable: "pnpm",
          args: ["nx", "run", "@harness/alpha:verify"],
        })
      })
      .with({ _tag: "None" }, () => {
        expect.unreachable("Expected Some")
      })
      .exhaustive()

    const nxAffected = parsePackageVerifyCommand(
      PackageVerifyCommand.make("nx affected -t typecheck"),
    )
    match(nxAffected)
      .with({ _tag: "Some" }, ({ value }) => {
        expect(value._tag).toBe("NxAffected")
        expect(toPackageVerifyCommandArgv(value)).toEqual({
          executable: "nx",
          args: ["affected", "-t", "typecheck"],
        })
      })
      .with({ _tag: "None" }, () => {
        expect.unreachable("Expected Some")
      })
      .exhaustive()

    const pnpmFilter = parsePackageVerifyCommand(
      PackageVerifyCommand.make("pnpm --filter @harness/infra lint"),
    )
    match(pnpmFilter)
      .with({ _tag: "Some" }, ({ value }) => {
        expect(value._tag).toBe("PnpmFilter")
        expect(toPackageVerifyCommandArgv(value)).toEqual({
          executable: "pnpm",
          args: ["--filter", "@harness/infra", "lint"],
        })
      })
      .with({ _tag: "None" }, () => {
        expect.unreachable("Expected Some")
      })
      .exhaustive()
  })

  it.live("empty or invalid packageVerifyCommand fails closed with WorkspaceFsError (F-13.1)", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        writeFileSync(
          join(repoRoot, "libs", "alpha", "src", "index.ts"),
          "export const alpha = 55\n",
          "utf8",
        )
        const invalidCmdUnit = {
          ...makePackageUnit(),
          packageVerifyCommand: "" as PackageVerifyCommand,
        }
        const exit = yield* Effect.exit(
          completeUnitImpl({
            runId: WorkflowRunId.make("run-empty-cmd"),
            level: "slice",
            baseSha,
            unit: invalidCmdUnit,
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          }),
        )
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => undefined,
                onSome: (e) => e._tag,
              }),
            ).toBe("WorkspaceFsError")
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected WorkspaceFsError for empty packageVerifyCommand")
          })
          .exhaustive()
      }),
    ),
  )

  it.live(
    "real subprocess strips HARNESS_STATE_DIR, sets HARNESS_WORKTREE_ID, and meets SpanBudget (F-23.4)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const envCapturePath = join(dir, "captured-env.json")
          writeExecutableScript(
            binDir,
            "nx",
            `const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({ wid: process.env.HARNESS_WORKTREE_ID || null, sdir: process.env.HARNESS_STATE_DIR || null }))
process.exit(0)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )
          const { result: outcome, spans } = yield* runWithTestTracer(
            "completeUnit.async",
            completeUnitImpl(
              {
                runId: WorkflowRunId.make("run-async-1"),
                level: "slice",
                baseSha,
                unit: makePackageUnit({
                  unitId: "pkg-async",
                  command: "nx run @harness/alpha:verify",
                }),
                attempt: AttemptNumber.make(1),
                cwd: repoRoot,
                siblingInFlightOwnedPaths: [],
              },
              {
                env: {
                  ...process.env,
                  PATH: `${binDir}:${process.env.PATH ?? ""}`,
                  HARNESS_STATE_DIR: "/tmp/inherited-state-dir-must-be-stripped",
                  HARNESS_WORKTREE_ID: "parent-worktree-id",
                },
              },
            ),
          )
          expect(spans.some((s) => s.name === "Harness.completeUnit")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])
          expect(outcome._tag).toBe("Completed")
          const captured = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                wid: Schema.NullOr(Schema.String),
                sdir: Schema.NullOr(Schema.String),
              }),
            ),
          )(readFileSync(envCapturePath, "utf8"))
          expect(captured).toEqual({ wid: "pkg-async", sdir: null })
        }),
      ),
  )

  it.live(
    "real subprocess timeout returns PackageVerifyFailed(timed-out) with stderr tail and does not hang on detached grandchild stdio (F-13.1 / F-23.4)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
process.stderr.write("timeout-diagnostic-tail\\n")
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: ["ignore", process.stdout, process.stderr] })
grandchild.unref()
setTimeout(() => {}, 15000)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )
          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-timeout-real"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({
                unitId: "pkg-timeout",
                command: "nx run @harness/alpha:verify",
              }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            {
              verifyTimeoutMs: 120,
              env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
            },
          )
          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.failureKind).toBe("timed-out")
                  expect(p.exitCode).toBe(1)
                  expect(p.detail).toContain("timeout-diagnostic-tail")
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected PackageVerifyFailed(timed-out)")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(PackageVerifyFailed)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "real subprocess signal termination returns PackageVerifyFailed(signaled) with signal exitCode and stderr tail (F-13.1 / F-23.4)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          writeExecutableScript(
            binDir,
            "nx",
            `process.stderr.write("killed-by-sigterm-tail\\n", () => {
  process.kill(process.pid, "SIGTERM")
})`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )
          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-signal-real"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({
                unitId: "pkg-signal",
                command: "nx run @harness/alpha:verify",
              }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
          )
          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.failureKind).toBe("signaled")
                  expect(p.exitCode).toBe(143)
                  expect(p.detail).toContain("killed-by-sigterm-tail")
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected PackageVerifyFailed(signaled)")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(PackageVerifyFailed)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "real subprocess spawn failure (ENOENT) fails closed with WorkspaceFsError instead of PackageVerifyFailed (F-13.1 / F-23.4)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )
          const exit = yield* Effect.exit(
            completeUnitImpl(
              {
                runId: WorkflowRunId.make("run-enoent-real"),
                level: "slice",
                baseSha,
                unit: makePackageUnit({ command: "nx run @harness/alpha:verify" }),
                attempt: AttemptNumber.make(1),
                cwd: repoRoot,
                siblingInFlightOwnedPaths: [],
              },
              { env: { ...process.env, PATH: join(dir, "empty-bin") } },
            ),
          )
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError on ENOENT spawn failure")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "real subprocess caps stderr buffer at 64 KiB and truncates PackageVerifyFailed.detail to <= 2048 trimmed chars preserving tail (F-13.1 / S-2.1 / F-23.4)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          writeExecutableScript(
            binDir,
            "nx",
            `const flood = "X".repeat(140 * 1024)
process.stdout.write(flood)
process.stderr.write(flood + "\\n  FINAL_TAIL_MARKER  \\n")
process.exit(2)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )
          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-cap-real"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({ command: "nx run @harness/alpha:verify" }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
          )
          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.failureKind).toBe("non-zero-exit")
                  expect(p.exitCode).toBe(2)
                  expect(p.detail).toBeDefined()
                  expect(p.detail?.length).toBeLessThanOrEqual(2048)
                  expect(p.detail?.endsWith("FINAL_TAIL_MARKER")).toBe(true)
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected PackageVerifyFailed")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(PackageVerifyFailed)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "rejects protected .harness paths with AgentFailed, git mv renames with WriteSetViolation, and invalid baseSha with WorkspaceFsError",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const pkgUnit = makePackageUnit()

          mkdirSync(join(repoRoot, ".harness"), { recursive: true })
          writeFileSync(join(repoRoot, ".harness", "custom-policy.json"), "{}\n", "utf8")
          const protectedOutcome = yield* completeUnitImpl({
            runId: WorkflowRunId.make("run-async-1"),
            level: "slice",
            baseSha,
            unit: pkgUnit,
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          })
          match(protectedOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("AgentFailed")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(AgentFailed)")
            })
            .exhaustive()
          rmSync(join(repoRoot, ".harness"), { recursive: true, force: true })

          // F-6.1: .harness/runner-pgids/* inside worktree is NOT silently excluded; triggers rejection
          mkdirSync(join(repoRoot, ".harness", "runner-pgids"), { recursive: true })
          writeFileSync(
            join(repoRoot, ".harness", "runner-pgids", "fake.json"),
            '{"pgid":999}\n',
            "utf8",
          )
          execFileSync("git", ["add", "-f", ".harness/runner-pgids/fake.json"], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "commit fake pgid inside worktree"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const pgidLeakOutcome = yield* completeUnitImpl({
            runId: WorkflowRunId.make("run-pgid-leak-1"),
            level: "slice",
            baseSha,
            unit: pkgUnit,
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          })
          match(pgidLeakOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "AgentFailed" }, (a) => {
                  expect(a.reason).toContain(".harness/runner-pgids/fake.json")
                })
                .with(
                  { _tag: "WriteSetViolation" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected AgentFailed for .harness/runner-pgids/fake.json")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected for committed .harness/runner-pgids/fake.json")
            })
            .exhaustive()
          execFileSync("git", ["reset", "--hard", baseSha], { cwd: repoRoot, stdio: "ignore" })

          execFileSync("git", ["mv", "libs/alpha/src/index.ts", "libs/beta/src/moved.ts"], {
            cwd: repoRoot,
          })
          execFileSync("git", ["commit", "-m", "rename outside ownership"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const renameOutcome = yield* completeUnitImpl({
            runId: WorkflowRunId.make("run-async-1"),
            level: "slice",
            baseSha,
            unit: pkgUnit,
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          })
          match(renameOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "WriteSetViolation" }, (v) => {
                  expect(v.offendingPaths).toContain(OwnedRelPath.make("libs/beta/src/moved.ts"))
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "PackageVerifyFailed" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected WriteSetViolation on git mv")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation)")
            })
            .exhaustive()

          const badShaExit = yield* Effect.exit(
            completeUnitImpl({
              runId: WorkflowRunId.make("run-async-1"),
              level: "slice",
              baseSha: GitCommitSha.make("0".repeat(40)),
              unit: pkgUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            }),
          )
          match(badShaExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for invalid baseSha")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "completeSharedStepImpl rejects empty or out-of-scope edits and completes when priorUnitOwnedPaths excludes prior units",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const emptyRes = yield* completeSharedStepImpl({
            runId: WorkflowRunId.make("run-shared-01"),
            baseSha,
            sharedStepPaths: [OwnedRelPath.make("libs/shared")],
            priorUnitOwnedPaths: [],
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
          })
          match(emptyRes)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("AgentFailed")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected AgentFailed rejection for empty shared step change set")
            })
            .exhaustive()

          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const a = 2\n",
            "utf8",
          )
          const badRes = yield* completeSharedStepImpl({
            runId: WorkflowRunId.make("run-shared-01"),
            baseSha,
            sharedStepPaths: [OwnedRelPath.make("libs/shared")],
            priorUnitOwnedPaths: [],
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
          })
          match(badRes)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("WriteSetViolation")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected WriteSetViolation")
            })
            .exhaustive()

          writeFileSync(
            join(repoRoot, "libs", "shared", "barrel.ts"),
            "export const shared = 2\n",
            "utf8",
          )
          const okRes = yield* completeSharedStepImpl({
            runId: WorkflowRunId.make("run-shared-01"),
            baseSha,
            sharedStepPaths: [OwnedRelPath.make("libs/shared")],
            priorUnitOwnedPaths: [OwnedRelPath.make("libs/alpha")],
            attempt: AttemptNumber.make(2),
            cwd: repoRoot,
          })
          match(okRes)
            .with({ _tag: "Completed" }, (c) => {
              expect(c.unitId).toBe(SHARED_STEP_UNIT_ID)
              expect(c.changedPaths).toEqual([OwnedRelPath.make("libs/shared/barrel.ts")])
            })
            .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Completed")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "S-2.1: spawnVerifyCommand timeout reaps surviving SIGTERM-trapping grandchild after direct child exits immediately on SIGTERM",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const binDir = join(dir, "bin")
          const grandchildPidFile = join(dir, "gc-spawn.pid")
          const grandchildTermMarker = join(dir, "gc-spawn.term")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
process.on("SIGTERM", () => process.exit(0))
const gc = spawn(
  process.execPath,
  [
    "-e",
    \`const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(grandchildTermMarker)}, "trapped"); }); fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid)); setInterval(() => {}, 1000)\`,
  ],
  { stdio: "ignore" },
)
setInterval(() => {}, 1000)`,
          )

          const res = yield* spawnVerifyCommand(join(binDir, "nx"), [], {
            cwd: dir,
            env: process.env,
            timeoutMs: 250,
          })
          expect(res._tag).toBe("TimedOut")
          expect(existsSync(grandchildPidFile)).toBe(true)
          expect(existsSync(grandchildTermMarker)).toBe(true)
          const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim())
          expect(grandchildPid).toBeGreaterThan(0)
          expect(isLocalPidAlive(grandchildPid)).toBe(false)
        }),
      ),
  )

  it.live(
    "S-2.1: completeUnitImpl verifyTimeoutMs reaps surviving SIGTERM-trapping grandchild after direct child exits immediately on SIGTERM",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const grandchildPidFile = join(dir, "gc-unit.pid")
          const grandchildTermMarker = join(dir, "gc-unit.term")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
process.on("SIGTERM", () => process.exit(0))
const gc = spawn(
  process.execPath,
  [
    "-e",
    \`const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(grandchildTermMarker)}, "trapped"); }); fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid)); setInterval(() => {}, 1000)\`,
  ],
  { stdio: "inherit" },
)
setInterval(() => {}, 1000)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 56\n",
            "utf8",
          )

          const outcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-s21-grandchild-reap"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({
                unitId: "pkg-s21-timeout",
                command: "nx run @harness/alpha:verify",
              }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            {
              verifyTimeoutMs: 250,
              env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
            },
          )

          match(outcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.failureKind).toBe("timed-out")
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => expect.unreachable("Expected PackageVerifyFailed(timed-out)"),
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () =>
              expect.unreachable("Expected Rejected(PackageVerifyFailed)"),
            )
            .exhaustive()

          expect(existsSync(grandchildPidFile)).toBe(true)
          expect(existsSync(grandchildTermMarker)).toBe(true)
          const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim())
          expect(grandchildPid).toBeGreaterThan(0)
          expect(isLocalPidAlive(grandchildPid)).toBe(false)
        }),
      ),
  )

  it.live(
    "F-26: immediate fiber interruption terminates child process group including spawned descendant",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const parentPidFile = join(dir, "parent-imm.pid")
          const descendantPidFile = join(dir, "descendant-imm.pid")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid))
writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
setInterval(() => {}, 1000)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )

          const fiber = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-interrupt-group-1"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({
                unitId: "pkg-int-1",
                command: "nx run @harness/alpha:verify",
              }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
          ).pipe(Effect.forkChild)

          expect(yield* waitForFilesExist([parentPidFile, descendantPidFile])).toBe(true)
          const parentPid = Number(readFileSync(parentPidFile, "utf8").trim())
          const descendantPid = Number(readFileSync(descendantPidFile, "utf8").trim())
          expect(isLocalPidAlive(parentPid)).toBe(true)
          expect(isLocalPidAlive(descendantPid)).toBe(true)

          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => expect.unreachable("Expected pure interrupt"))
            .exhaustive()
          expect(isLocalPidAlive(parentPid)).toBe(false)
          expect(isLocalPidAlive(descendantPid)).toBe(false)
        }),
      ),
  )

  it.live(
    "F-26: post-SIGTERM fiber interruption escalates to SIGKILL and kills trapped process group",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const parentPidFile = join(dir, "parent-term.pid")
          const descendantPidFile = join(dir, "descendant-term.pid")
          const sigtermReceivedFile = join(dir, "sigterm-received.marker")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(sigtermReceivedFile)}, "sigterm-received\\n")
})
const child = spawn(
  process.execPath,
  [
    "-e",
    \`const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); setInterval(() => {}, 1000)\`,
  ],
  { stdio: "ignore" },
)
writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
setInterval(() => {}, 1000)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )

          const fiber = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-interrupt-group-2"),
              level: "slice",
              baseSha,
              unit: makePackageUnit({
                unitId: "pkg-int-2",
                command: "nx run @harness/alpha:verify",
              }),
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            {
              verifyTimeoutMs: 180,
              env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
            },
          ).pipe(Effect.forkChild)

          expect(yield* waitForFilesExist([parentPidFile, descendantPidFile])).toBe(true)
          expect(yield* waitForFilesExist([sigtermReceivedFile])).toBe(true)
          const parentPid = Number(readFileSync(parentPidFile, "utf8").trim())
          const descendantPid = Number(readFileSync(descendantPidFile, "utf8").trim())
          expect(isLocalPidAlive(parentPid)).toBe(true)
          expect(isLocalPidAlive(descendantPid)).toBe(true)

          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => expect.unreachable("Expected pure interrupt"))
            .exhaustive()
          expect(isLocalPidAlive(parentPid)).toBe(false)
          expect(isLocalPidAlive(descendantPid)).toBe(false)
        }),
      ),
  )
})
