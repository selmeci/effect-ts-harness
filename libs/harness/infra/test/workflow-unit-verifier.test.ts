import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, type Exit, Fiber, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan,
  EarsRequirementKey,
  EscalationDecision,
  FrictionLogState,
  GitCommitSha,
  GitCommonDirPath,
  LeaseEpoch,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageVerifyCommand,
  PlanSha256,
  ReviewDepth,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  StubSymbolKey,
  WaveIndex,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceTreeHash,
  isPureInterruptCause,
  parsePackageVerifyCommand,
  toPackageVerifyCommandArgv,
} from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { type SpanSample, decideSpanBudgets, writeVerifyStamp } from "@harness/gates"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import type { ExtendedHostIo, SyncHostExecOptions, SyncHostIo } from "@harness/service/host-io"
import {
  UnitAgentDispatcherLive,
  UnixSocketDaemonLive,
  abortWorkflowViaDaemon,
  compileWorkflowPlanFromRepo,
  completeSharedStepImpl,
  completeUnitImpl,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  makeUnitVerifierLayer,
  makeWorkflowReviewRouterLayer,
  makeWorkflowWorktreePortLayer,
  mergeSliceWaveImpl,
  nodeSyncHostIo,
  provisionWorkflowWorktreesImpl,
  removeWorktreeCheckoutsImpl,
  resumeWorkflowViaDaemon,
  routeWorkflowReviewImpl,
  startScopedUnixSocketDaemon,
  startWorkflowViaDaemon,
} from "../src/index.js"
import {
  resolveWorkflowRuntimePaths,
  resolveWorkflowWorktreeDir,
} from "../src/worktree-repo-root.js"
import { isLocalPidAlive } from "../src/writer-lease.js"

const runWithTestTracer = <A, E, R>(
  testId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly result: A; readonly spans: ReadonlyArray<SpanSample> }, E, R> =>
  Effect.gen(function* () {
    const recorded = new Map<string, SpanSample>()
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        const parentSpanId = Option.match(options.parent, {
          onNone: () => null,
          onSome: (p) => p.spanId,
        })
        const startTimeMs =
          typeof span.status.startTime === "bigint"
            ? Number(span.status.startTime) / 1_000_000
            : undefined
        recorded.set(span.spanId, {
          spanId: span.spanId,
          name: span.name,
          parentSpanId,
          ...(startTimeMs !== undefined ? { startTimeMs } : {}),
        })
        const origEnd = span.end.bind(span)
        span.end = (endTime, exit) => {
          const durationMs =
            typeof endTime === "bigint" && typeof span.status.startTime === "bigint"
              ? Number(endTime - span.status.startTime) / 1_000_000
              : undefined
          const endTimeMs = typeof endTime === "bigint" ? Number(endTime) / 1_000_000 : undefined
          const exitMeta = match(exit)
            .with({ _tag: "Success" }, () => ({ exitTag: "Success" as const, errorTag: null }))
            .with({ _tag: "Failure" }, ({ cause }) =>
              Option.match(Cause.findErrorOption(cause), {
                onSome: (err) => ({
                  exitTag: "Failure" as const,
                  errorTag: err instanceof Error ? err.name : null,
                }),
                onNone: () => ({ exitTag: "Defect" as const, errorTag: null }),
              }),
            )
            .exhaustive()
          recorded.set(span.spanId, {
            spanId: span.spanId,
            name: span.name,
            parentSpanId,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(startTimeMs !== undefined ? { startTimeMs } : {}),
            ...(endTimeMs !== undefined ? { endTimeMs } : {}),
            exitTag: exitMeta.exitTag,
            errorTag: exitMeta.errorTag,
          })
          origEnd(endTime, exit)
        }
        return span
      },
    })
    const result = yield* effect.pipe(
      Effect.withSpan(`Test:${testId}`),
      Effect.provideService(Tracer.Tracer, tracer),
    )
    return { result, spans: Array.from(recorded.values()) }
  })

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "wf3-unit-verifier-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

const initGitRepo = (
  baseDir: string,
): { readonly repoRoot: AbsoluteRepoRoot; readonly baseSha: GitCommitSha } => {
  const rawRepo = join(baseDir, "repo")
  mkdirSync(rawRepo, { recursive: true })
  execFileSync("git", ["init"], { cwd: rawRepo, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "wf3@example.com"], {
    cwd: rawRepo,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "WF3 Test"], { cwd: rawRepo, stdio: "ignore" })
  mkdirSync(join(rawRepo, "libs", "alpha", "src"), { recursive: true })
  mkdirSync(join(rawRepo, "libs", "beta", "src"), { recursive: true })
  mkdirSync(join(rawRepo, "libs", "shared"), { recursive: true })
  writeFileSync(
    join(rawRepo, "libs", "alpha", "src", "index.ts"),
    "export const alpha = 1\n",
    "utf8",
  )
  writeFileSync(join(rawRepo, "libs", "beta", "src", "index.ts"), "export const beta = 1\n", "utf8")
  writeFileSync(join(rawRepo, "libs", "shared", "barrel.ts"), "export const shared = 1\n", "utf8")
  execFileSync("git", ["add", "."], { cwd: rawRepo, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: rawRepo, stdio: "ignore" })
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rawRepo,
    encoding: "utf8",
  }).trim()
  return {
    repoRoot: AbsoluteRepoRoot.make(realpathSync.native(rawRepo)),
    baseSha: GitCommitSha.make(headSha),
  }
}

const makeStampHostIo = (baseEnv: Readonly<Record<string, string | undefined>>): SyncHostIo => ({
  ...nodeSyncHostIo,
  getEnv: () => baseEnv,
})

const makeSliceUnit = (
  unitId = "alpha-slice",
  branch = "slice/alpha-unit",
  ownedRelPaths: ReadonlyArray<string> = ["libs/alpha"],
) => ({
  _tag: "SliceUnit" as const,
  unitId: WorkUnitId.make(unitId),
  branch: SliceBranchName.make(branch),
  waveIndex: WaveIndex.make(0),
  dependsOn: [],
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-2.1")],
})

const makePackageUnit = (overrides?: {
  readonly unitId?: string
  readonly ownedRelPaths?: ReadonlyArray<string>
  readonly command?: string
}) => ({
  _tag: "PackageUnit" as const,
  unitId: WorkUnitId.make(overrides?.unitId ?? "pkg-alpha"),
  projectName: NxProjectName.make("@harness/alpha"),
  waveIndex: WaveIndex.make(0),
  dependsOn: [],
  ownedRelPaths: (overrides?.ownedRelPaths ?? ["libs/alpha"]).map((p) => OwnedRelPath.make(p)),
  stubKeys: [StubSymbolKey.make("Alpha.run")],
  earsKeys: [EarsRequirementKey.make("REQ-2.1")],
  packageVerifyCommand: PackageVerifyCommand.make(
    overrides?.command ?? "pnpm nx run @harness/alpha:verify",
  ),
})

const makeEpicPlan = (
  baseSha: GitCommitSha,
  runId = "run-l1-wt-1",
  units = [
    makeSliceUnit("s-alpha", "slice/wf3-alpha", ["libs/alpha"]),
    makeSliceUnit("s-beta", "slice/wf3-beta", ["libs/beta"]),
  ],
): CompiledPlan => ({
  runId: WorkflowRunId.make(runId),
  level: "epic",
  planSha: PlanSha256.make("b".repeat(64)),
  baseSha,
  mode: { _tag: "Manual" },
  units,
  sharedStepPaths: [],
})

const writeExecutableScript = (binDir: string, name: string, jsBody: string): void => {
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, name)
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${jsBody}\n`, "utf8")
  chmodSync(scriptPath, 0o755)
}

const expectWorkspaceFsErrorExit = <A, E extends { readonly _tag: string }>(
  exit: Exit.Exit<A, E>,
  label: string,
): void => {
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
      expect.unreachable(label)
    })
    .exhaustive()
}

const decodeJsonLine = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      command: Schema.optional(Schema.String),
    }),
  ),
)

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
          expect(emptyRes._tag).toBe("Rejected")

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
    "F-26: fiber interruption terminates child process group including spawned descendant and escalates immediately if SIGTERM was already sent",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const parentPidFile = join(dir, "parent.pid")
          const descendantPidFile = join(dir, "descendant.pid")
          writeExecutableScript(
            binDir,
            "nx",
            `const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const trapTerm = process.env.TRAP_TERM === "1"
if (trapTerm) { process.on("SIGTERM", () => {}) }
const child = spawn(process.execPath, ["-e", trapTerm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid))
writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
setInterval(() => {}, 1000)`,
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )

          // 1. Direct fiber interruption kills both parent verify process and non-detached descendant
          const fiber1 = yield* completeUnitImpl(
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

          for (let i = 0; i < 100; i += 1) {
            if (existsSync(parentPidFile) && existsSync(descendantPidFile)) break
            yield* Effect.sleep("20 millis")
          }
          const parentPid1 = Number(readFileSync(parentPidFile, "utf8").trim())
          const descendantPid1 = Number(readFileSync(descendantPidFile, "utf8").trim())
          expect(isLocalPidAlive(parentPid1)).toBe(true)
          expect(isLocalPidAlive(descendantPid1)).toBe(true)

          yield* Fiber.interrupt(fiber1)
          const exit1 = yield* Fiber.await(fiber1)
          match(exit1)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => expect.unreachable("Expected pure interrupt"))
            .exhaustive()
          expect(isLocalPidAlive(parentPid1)).toBe(false)
          expect(isLocalPidAlive(descendantPid1)).toBe(false)

          rmSync(parentPidFile, { force: true })
          rmSync(descendantPidFile, { force: true })

          // 2. Interruption after timeout already sent SIGTERM escalates immediately to SIGKILL (-pid)
          const fiber2 = yield* completeUnitImpl(
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
              verifyTimeoutMs: 60,
              env: {
                ...process.env,
                TRAP_TERM: "1",
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
              },
            },
          ).pipe(Effect.forkChild)

          for (let i = 0; i < 100; i += 1) {
            if (existsSync(parentPidFile) && existsSync(descendantPidFile)) break
            yield* Effect.sleep("20 millis")
          }
          const parentPid2 = Number(readFileSync(parentPidFile, "utf8").trim())
          const descendantPid2 = Number(readFileSync(descendantPidFile, "utf8").trim())
          // Allow verifyTimeoutMs (60ms) to send SIGTERM while 500ms grace timer is still pending
          yield* Effect.sleep("120 millis")
          expect(isLocalPidAlive(parentPid2)).toBe(true)
          expect(isLocalPidAlive(descendantPid2)).toBe(true)

          const startInterruptMs = Date.now()
          yield* Fiber.interrupt(fiber2)
          const interruptElapsedMs = Date.now() - startInterruptMs
          const exit2 = yield* Fiber.await(fiber2)
          match(exit2)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => expect.unreachable("Expected pure interrupt"))
            .exhaustive()
          expect(isLocalPidAlive(parentPid2)).toBe(false)
          expect(isLocalPidAlive(descendantPid2)).toBe(false)
          expect(interruptElapsedMs).toBeLessThan(350)
        }),
      ),
  )
})

describe("WorkflowWorktreePort", () => {
  it.live("provisions L2 canonical mappings", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        const l2Plan: CompiledPlan = {
          runId: WorkflowRunId.make("run-l2-wt-1"),
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha,
          mode: { _tag: "Manual" },
          units: [makePackageUnit({ unitId: "u-alpha" })],
          sharedStepPaths: [],
        }
        const receipt = yield* provisionWorkflowWorktreesImpl(l2Plan, { repoRoot })
        expect(receipt.entries).toEqual([
          { unitId: WorkUnitId.make("u-alpha"), cwd: repoRoot, worktreeKind: "canonical" },
        ])
      }),
    ),
  )

  it.live(
    "provisions L1 linked worktrees at .harness/workflow-worktrees/<runId>/<unitId> and cleans stale dirs (F-1.1)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const expectedAlphaDir = resolveWorkflowWorktreeDir(
            repoRoot,
            l1Plan.runId,
            WorkUnitId.make("s-alpha"),
          )
          mkdirSync(expectedAlphaDir, { recursive: true })
          writeFileSync(join(expectedAlphaDir, "stale.txt"), "leftover\n", "utf8")

          const receipt = yield* Effect.gen(function* () {
            const wt = yield* WorkflowWorktreePort
            return yield* wt.provisionWorktrees(l1Plan)
          }).pipe(Effect.provide(makeWorkflowWorktreePortLayer({ repoRoot })))

          expect(existsSync(join(expectedAlphaDir, "stale.txt"))).toBe(false)
          expect(existsSync(join(repoRoot, ".git", "harness", "worktrees"))).toBe(false)
          expect(receipt.entries.length).toBe(2)
          expect(receipt.entries[0]?.cwd).toBe(realpathSync.native(expectedAlphaDir))
          expect(receipt.entries[0]?.worktreeKind).toBe("linked")
          expect(existsSync(receipt.entries[0]!.cwd)).toBe(true)
          expect(existsSync(receipt.entries[1]!.cwd)).toBe(true)
        }),
      ),
  )

  it.live(
    "re-provisioning existing slice/* branch attaches non-destructively preserving commits when baseSha is ancestor (F-5.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const plan = makeEpicPlan(baseSha, "run-reattach-1", [
            makeSliceUnit("s-alpha", "slice/reattach-alpha", ["libs/alpha"]),
          ])
          const receipt1 = yield* provisionWorkflowWorktreesImpl(plan, { repoRoot })
          const alphaCwd = receipt1.entries[0]!.cwd
          writeFileSync(
            join(alphaCwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 77\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaCwd })
          execFileSync("git", ["commit", "-m", "slice commit preserved"], {
            cwd: alphaCwd,
            stdio: "ignore",
          })
          const sliceSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: alphaCwd,
            encoding: "utf8",
          }).trim()

          yield* removeWorktreeCheckoutsImpl(receipt1)
          const receipt2 = yield* provisionWorkflowWorktreesImpl(plan, { repoRoot })
          const reattachedSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: receipt2.entries[0]!.cwd,
            encoding: "utf8",
          }).trim()
          expect(reattachedSha).toBe(sliceSha)
          expect(
            readFileSync(
              join(receipt2.entries[0]!.cwd, "libs", "alpha", "src", "index.ts"),
              "utf8",
            ),
          ).toBe("export const alpha = 77\n")
        }),
      ),
  )

  it.live(
    "re-provisioning diverged slice/* branch fails closed with WorkspaceFsError without resetting it (F-5.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          execFileSync("git", ["checkout", "-b", "slice/diverged-alpha"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 101\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "diverged slice commit"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const divergedSliceSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).trim()

          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(
            join(repoRoot, "libs", "beta", "src", "index.ts"),
            "export const beta = 202\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "advance main past slice"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const advancedBaseSha = GitCommitSha.make(
            execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
          )

          const plan = makeEpicPlan(advancedBaseSha, "run-diverged-1", [
            makeSliceUnit("s-alpha", "slice/diverged-alpha", ["libs/alpha"]),
          ])
          const exit = yield* Effect.exit(provisionWorkflowWorktreesImpl(plan, { repoRoot }))
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
              expect.unreachable("Expected WorkspaceFsError for diverged slice branch")
            })
            .exhaustive()

          const preservedSha = execFileSync(
            "git",
            ["rev-parse", "refs/heads/slice/diverged-alpha"],
            {
              cwd: repoRoot,
              encoding: "utf8",
            },
          ).trim()
          expect(preservedSha).toBe(divergedSliceSha)
        }),
      ),
  )

  it.live(
    "rolls back earlier worktrees cleanly when Nth worktree add fails (F-11.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          execFileSync("git", ["checkout", "-b", "slice/diverged-beta"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "beta", "src", "index.ts"),
            "export const beta = 50\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "beta diverged"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(
            join(repoRoot, "libs", "shared", "barrel.ts"),
            "export const shared = 50\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "advance base"], { cwd: repoRoot, stdio: "ignore" })
          const advancedBaseSha = GitCommitSha.make(
            execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
          )

          const plan = makeEpicPlan(advancedBaseSha, "run-rollback-1", [
            makeSliceUnit("s-alpha", "slice/ok-alpha", ["libs/alpha"]),
            makeSliceUnit("s-beta", "slice/diverged-beta", ["libs/beta"]),
          ])
          const alphaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-alpha"),
          )

          const exit = yield* Effect.exit(provisionWorkflowWorktreesImpl(plan, { repoRoot }))
          expectWorkspaceFsErrorExit(exit, "Expected WorkspaceFsError on Nth worktree add failure")
          expect(existsSync(alphaWtDir)).toBe(false)
          const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd: repoRoot,
            encoding: "utf8",
          })
          expect(wtList).not.toContain("s-alpha")
        }),
      ),
  )

  it.live(
    "fiber interruption during Nth worktree creation triggers Effect.onExit rollback and preserves pure interrupt (F-11.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const plan = makeEpicPlan(baseSha, "run-interrupt-1")
          const alphaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-alpha"),
          )
          const betaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-beta"),
          )
          const firstProvisioned = yield* Deferred.make<void>()

          const spyHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            realpathSync: (filePath: string) => {
              const resolved = nodeSyncHostIo.realpathSync(filePath)
              if (filePath === alphaWtDir) {
                Deferred.doneUnsafe(firstProvisioned, Effect.void)
              }
              return resolved
            },
          }

          const fiber = yield* provisionWorkflowWorktreesImpl(plan, {
            repoRoot,
            hostIo: spyHostIo,
          }).pipe(Effect.forkChild)

          yield* Deferred.await(firstProvisioned)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected pure interrupt failure")
            })
            .exhaustive()

          expect(existsSync(alphaWtDir)).toBe(false)
          expect(existsSync(betaWtDir)).toBe(false)
        }),
      ),
  )

  it.live(
    "removeWorktreeCheckoutsImpl detaches linked checkouts while preserving slice/* branches and is idempotent",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const receipt = yield* provisionWorkflowWorktreesImpl(l1Plan, { repoRoot })
          const alphaWt = receipt.entries[0]!
          const betaWt = receipt.entries[1]!

          writeFileSync(
            join(alphaWt.cwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 10\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaWt.cwd })
          execFileSync("git", ["commit", "-m", "alpha work"], { cwd: alphaWt.cwd, stdio: "ignore" })

          writeFileSync(
            join(betaWt.cwd, "libs", "beta", "src", "index.ts"),
            "export const beta = 20\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: betaWt.cwd })
          execFileSync("git", ["commit", "-m", "beta work"], { cwd: betaWt.cwd, stdio: "ignore" })

          const { spans } = yield* runWithTestTracer(
            "removeWorktreeCheckouts",
            removeWorktreeCheckoutsImpl(receipt),
          )
          expect(spans.some((s) => s.name === "Harness.removeWorktreeCheckouts")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])
          expect(existsSync(alphaWt.cwd)).toBe(false)
          expect(existsSync(betaWt.cwd)).toBe(false)

          const branches = execFileSync("git", ["branch", "--list", "slice/*"], {
            cwd: repoRoot,
            encoding: "utf8",
          })
          expect(branches).toContain("slice/wf3-alpha")
          expect(branches).toContain("slice/wf3-beta")

          yield* removeWorktreeCheckoutsImpl(receipt)
        }),
      ),
  )

  it.live(
    "mergeSliceWaveImpl merges idempotently, rejects missing branch and dirty collision, and aborts conflicts strictly",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const receipt = yield* provisionWorkflowWorktreesImpl(l1Plan, { repoRoot })
          const alphaWt = receipt.entries[0]!
          const betaWt = receipt.entries[1]!

          writeFileSync(
            join(alphaWt.cwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 10\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaWt.cwd })
          execFileSync("git", ["commit", "-m", "alpha work"], { cwd: alphaWt.cwd, stdio: "ignore" })

          writeFileSync(
            join(betaWt.cwd, "libs", "beta", "src", "index.ts"),
            "export const beta = 20\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: betaWt.cwd })
          execFileSync("git", ["commit", "-m", "beta work"], { cwd: betaWt.cwd, stdio: "ignore" })

          yield* removeWorktreeCheckoutsImpl(receipt)

          const merge1 = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(0),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })
          expect(merge1).toEqual({
            _tag: "Merged",
            mergedBranches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })

          const merge2 = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(0),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })
          expect(merge2).toEqual(merge1)

          const missingExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/does-not-exist")],
            }),
          )
          expectWorkspaceFsErrorExit(missingExit, "Expected WorkspaceFsError for missing branch")

          execFileSync("git", ["checkout", "-b", "slice/wf3-conflict", baseSha], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 999\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "conflict work"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })

          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 777\n",
            "utf8",
          )
          const dirtyExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/wf3-conflict")],
            }),
          )
          expectWorkspaceFsErrorExit(dirtyExit, "Expected WorkspaceFsError for dirty merge")
          execFileSync("git", ["checkout", "--", "libs/alpha/src/index.ts"], { cwd: repoRoot })

          const conflictMerge = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(1),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [SliceBranchName.make("slice/wf3-conflict")],
          })
          expect(conflictMerge).toEqual({
            _tag: "Conflict",
            branch: SliceBranchName.make("slice/wf3-conflict"),
          })
          expect(existsSync(join(repoRoot, ".git", "MERGE_HEAD"))).toBe(false)
        }),
      ),
  )

  it.live(
    "mergeSliceWaveImpl fails closed with WorkspaceFsError when abortMergeStrict fails or unmerged paths exist without MERGE_HEAD (F-11.2)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const unmergedWithoutHeadHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) => {
              if (cmd === "git" && args[0] === "diff" && args.includes("--diff-filter=U")) {
                return {
                  _tag: "Exited",
                  exitCode: 0,
                  stdout: "libs/alpha/src/index.ts\n",
                  stderr: "",
                }
              }
              return nodeSyncHostIo.execFileSync(cmd, args, opts)
            },
          }
          const unmergedExit = yield* Effect.exit(
            mergeSliceWaveImpl(
              {
                runId: WorkflowRunId.make("run-unmerged-1"),
                waveIndex: WaveIndex.make(0),
                baseSha,
                canonicalRepoRoot: repoRoot,
                branches: [],
              },
              { hostIo: unmergedWithoutHeadHostIo },
            ),
          )
          match(unmergedExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unmerged paths without MERGE_HEAD")
            })
            .exhaustive()

          execFileSync("git", ["checkout", "-b", "slice/abort-fail", baseSha], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 5\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "branch edit"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })

          const abortFailHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) => {
              if (cmd === "git" && args[0] === "merge" && args[1] === "--no-ff") {
                return { _tag: "TimedOut", stdout: "", stderr: "merge timed out" }
              }
              if (cmd === "git" && args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
                return { _tag: "Exited", exitCode: 0, stdout: ".git/HEAD\n", stderr: "" }
              }
              if (cmd === "git" && args[0] === "merge" && args[1] === "--abort") {
                return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "abort refused" }
              }
              return nodeSyncHostIo.execFileSync(cmd, args, opts)
            },
          }

          const abortFailExit = yield* Effect.exit(
            mergeSliceWaveImpl(
              {
                runId: WorkflowRunId.make("run-abort-fail"),
                waveIndex: WaveIndex.make(0),
                baseSha,
                canonicalRepoRoot: repoRoot,
                branches: [SliceBranchName.make("slice/abort-fail")],
              },
              { hostIo: abortFailHostIo },
            ),
          )
          match(abortFailExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              const err = Option.getOrUndefined(Cause.findErrorOption(cause))
              expect(err?._tag).toBe("WorkspaceFsError")
              expect(err?.reason).toContain("abort refused")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError when abortMergeStrict fails")
            })
            .exhaustive()
        }),
      ),
  )
})

describe("WorkflowReviewRouter & UnitAgentDispatcher", () => {
  it.live("UnitAgentDispatcherLive exposes placeholder runnerKind and returns Failed", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot } = initGitRepo(dir)
        const res = yield* Effect.gen(function* () {
          const dispatcher = yield* UnitAgentDispatcher
          expect(dispatcher.runnerKind).toBe("placeholder")
          return yield* dispatcher.dispatchUnit({
            runId: WorkflowRunId.make("run-dispatch-1"),
            unit: makePackageUnit({ unitId: "u-1" }),
            attempt: AttemptNumber.make(1),
            runner: RunnerId.make("claude-code"),
            cwd: repoRoot,
          })
        }).pipe(Effect.provide(UnitAgentDispatcherLive))
        expect(res._tag).toBe("Failed")
      }),
    ),
  )

  it.live(
    "routeWorkflowReviewImpl returns SkipReviewPlan on empty diff and ActiveReviewPlan on modified package",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const emptyReview = yield* routeWorkflowReviewImpl({
            runId: WorkflowRunId.make("run-rev-1"),
            baseSha,
            canonicalRepoRoot: repoRoot,
          })
          expect(emptyReview._tag).toBe("SkipReviewPlan")

          writeFileSync(
            join(repoRoot, "libs", "alpha", "package.json"),
            JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
            "utf8",
          )
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 2\n",
            "utf8",
          )
          const mockDmLayer = makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("focused"),
          })
          const activeReview = yield* Effect.gen(function* () {
            const router = yield* WorkflowReviewRouter
            return yield* router.routeReview({
              runId: WorkflowRunId.make("run-rev-1"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            })
          }).pipe(
            Effect.provide(makeWorkflowReviewRouterLayer({ decisionModelLayer: mockDmLayer })),
          )
          expect(activeReview._tag).toBe("ActiveReviewPlan")
        }),
      ),
  )

  it.live(
    "routeWorkflowReviewImpl fails closed with WorkspaceFsError on corrupt/unreadable package.json or unreadable untracked file (F-14.1)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const pkgPath = join(repoRoot, "libs", "alpha", "package.json")
          writeFileSync(pkgPath, "{not-valid-json", "utf8")
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 9\n",
            "utf8",
          )

          const corruptPkgExit = yield* Effect.exit(
            routeWorkflowReviewImpl({
              runId: WorkflowRunId.make("run-rev-corrupt"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            }),
          )
          match(corruptPkgExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for corrupt package.json")
            })
            .exhaustive()

          writeFileSync(
            pkgPath,
            JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
            "utf8",
          )
          const untrackedPath = join(repoRoot, "libs", "alpha", "src", "secret.ts")
          writeFileSync(untrackedPath, "export const secret = 1\n", "utf8")
          chmodSync(untrackedPath, 0o000)

          const unreadableUntrackedExit = yield* Effect.exit(
            routeWorkflowReviewImpl({
              runId: WorkflowRunId.make("run-rev-unreadable"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            }),
          )
          chmodSync(untrackedPath, 0o644)
          match(unreadableUntrackedExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unreadable untracked file")
            })
            .exhaustive()
        }),
      ),
  )
})

describe("PlanWorkflowCompiler Extractor (compileWorkflowPlanFromRepo)", () => {
  it.live("extracts workspace stubs into CompiledPlan with SpanBudget compliance", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot } = initGitRepo(dir)
        writeFileSync(
          join(repoRoot, "libs", "alpha", "package.json"),
          JSON.stringify({ name: "@harness/alpha", nx: { tags: ["type:domain"] } }),
          "utf8",
        )
        writeFileSync(
          join(repoRoot, "libs", "alpha", "src", "index.ts"),
          `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const runAlpha = Effect.fn("Alpha.run")(function* () {\n  return yield* stub<void>("harness:SPEC-1", "REQ-1")\n})\n`,
          "utf8",
        )
        const { result: compiled, spans } = yield* runWithTestTracer(
          "compileWorkflowPlanFromRepo",
          compileWorkflowPlanFromRepo({
            repoRoot,
            level: "slice",
            mode: {
              _tag: "Automatic",
              runner: RunnerId.make("claude-code"),
              maxConcurrency: MaxConcurrency.make(2),
            },
          }),
        )
        expect(spans.some((s) => s.name === "Harness.compileWorkflowPlanFromRepo")).toBe(true)
        expect(yield* decideSpanBudgets({ spans })).toEqual([])
        expect(compiled.units.length).toBe(1)
        expect(compiled.units[0]?.ownedRelPaths).toEqual([OwnedRelPath.make("libs/alpha")])
      }),
    ),
  )

  it.live(
    "compiles explicit inputJsonPath and honors explicit CLI level/mode precedence over JSON overrides (F-14.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const inputJsonPath = WorkspaceFilePath.make(join(dir, "plan-input.json"))
          writeFileSync(
            inputJsonPath,
            JSON.stringify({
              runId: "run-json-0001",
              level: "epic",
              mode: {
                _tag: "Automatic",
                runner: "antigravity",
                maxConcurrency: 4,
              },
              units: [
                {
                  _tag: "PackageUnit",
                  unitId: "u-alpha",
                  projectName: "@harness/alpha",
                  ownedRelPaths: ["libs/alpha"],
                  stubKeys: ["Alpha.run"],
                  earsKeys: ["REQ-1"],
                  packageVerifyCommand: "pnpm nx run @harness/alpha:verify",
                },
              ],
              dependencies: [],
              sharedStepPaths: ["libs/shared"],
            }),
            "utf8",
          )
          const compiledExplicit = yield* compileWorkflowPlanFromRepo({
            repoRoot,
            level: "slice",
            mode: { _tag: "Manual" },
            inputJsonPath,
          })
          expect(compiledExplicit.runId).toBe("run-json-0001")
          expect(compiledExplicit.level).toBe("slice")
          expect(compiledExplicit.mode).toEqual({ _tag: "Manual" })
          expect(compiledExplicit.sharedStepPaths).toEqual([OwnedRelPath.make("libs/shared")])

          const compiledOmitted = yield* compileWorkflowPlanFromRepo({
            repoRoot,
            inputJsonPath,
          })
          expect(compiledOmitted.runId).toBe("run-json-0001")
          expect(compiledOmitted.level).toBe("epic")
          expect(compiledOmitted.mode).toEqual({
            _tag: "Automatic",
            runner: RunnerId.make("antigravity"),
            maxConcurrency: MaxConcurrency.make(4),
          })
          expect(compiledOmitted.sharedStepPaths).toEqual([OwnedRelPath.make("libs/shared")])
        }),
      ),
  )

  it.live(
    "fails closed with WorkspaceFsError on unreadable stub files or corrupt/unreadable package.json (F-14.2)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const pkgPath = join(repoRoot, "libs", "alpha", "package.json")
          const stubPath = join(repoRoot, "libs", "alpha", "src", "index.ts")
          writeFileSync(pkgPath, "{corrupt-json", "utf8")
          writeFileSync(
            stubPath,
            `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const runAlpha = Effect.fn("Alpha.run")(function* () {\n  return yield* stub<void>("harness:SPEC-1", "REQ-1")\n})\n`,
            "utf8",
          )

          const corruptPkgExit = yield* Effect.exit(
            compileWorkflowPlanFromRepo({
              repoRoot,
              level: "slice",
              mode: { _tag: "Manual" },
            }),
          )
          match(corruptPkgExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for corrupt package.json")
            })
            .exhaustive()

          writeFileSync(pkgPath, JSON.stringify({ name: "@harness/alpha" }), "utf8")
          chmodSync(stubPath, 0o000)

          const unreadableStubExit = yield* Effect.exit(
            compileWorkflowPlanFromRepo({
              repoRoot,
              level: "slice",
              mode: { _tag: "Manual" },
            }),
          )
          chmodSync(stubPath, 0o644)
          match(unreadableStubExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unreadable stub file")
            })
            .exhaustive()
        }),
      ),
  )
})

describe("DaemonClient WF-3 IPC", () => {
  it.live("performs handshake capability checks and decodes typed RPC responses", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        const commonGitDir = GitCommonDirPath.make(realpathSync.native(join(repoRoot, ".git")))
        const { socketPath } = resolveWorkflowRuntimePaths(commonGitDir)

        const samplePlan: CompiledPlan = {
          runId: WorkflowRunId.make("run-ipc-0001"),
          level: "slice",
          planSha: PlanSha256.make("c".repeat(64)),
          baseSha,
          mode: { _tag: "Manual" },
          units: [makePackageUnit({ unitId: "u-alpha" })],
          sharedStepPaths: [],
        }

        const runId = WorkflowRunId.make("run-ipc-0001")
        const executionId = WorkflowExecutionId.make("run-ipc-0001")

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
              lineHandler: (line: string) => {
                const parsed = decodeJsonLine(line)
                const id = parsed.id ?? ""
                const command = parsed.command ?? ""
                const response = match(command)
                  .with("workflow.handshake", () => ({
                    id,
                    ok: true,
                    command,
                    handshake: {
                      protocolVersion: "1",
                      capabilities: [
                        "workflow.handshake",
                        "workflow.start",
                        "workflow.status",
                        "workflow.complete",
                        "workflow.resume",
                        "workflow.abort",
                        "workflow.doctor",
                      ],
                      repoRoot,
                      commonGitDir,
                      writerLeaseEpoch: 1,
                    },
                  }))
                  .with("workflow.start", () => ({
                    id,
                    ok: true,
                    result: { runId, executionId, outcome: "started" },
                  }))
                  .with("workflow.status", () => ({
                    id,
                    ok: true,
                    result: {
                      _tag: "Ready",
                      writerLeaseEpoch: 1,
                      outcome: { _tag: "NotFound" },
                    },
                  }))
                  .with("workflow.complete", () => ({
                    id,
                    ok: true,
                    result: {
                      _tag: "LlmPhaseCompleted",
                      runId,
                      executionId,
                      receipt: {
                        workspaceHash: WorkspaceTreeHash.make("d".repeat(64)),
                        frictionLogCleared: FrictionLogState.make("cleared"),
                      },
                    },
                  }))
                  .with("workflow.resume", () => ({
                    id,
                    ok: true,
                    result: {
                      _tag: "EscalationResolved",
                      runId,
                      executionId,
                      unitId: WorkUnitId.make("u-alpha"),
                      decision: EscalationDecision.make("retry"),
                    },
                  }))
                  .with("workflow.abort", () => ({
                    id,
                    ok: true,
                    result: { runId, executionId, state: "aborted" },
                  }))
                  .with("workflow.doctor", () => ({
                    id,
                    ok: true,
                    result: {
                      repoRoot,
                      commonGitDir,
                      writerLeaseEpoch: 1,
                      rebuiltRunCount: 2,
                      checks: [],
                    },
                  }))
                  .otherwise(() => ({ id, ok: false, error: `Unknown command ${command}` }))
                return Effect.succeed(JSON.stringify(response))
              },
            })

            const startRes = yield* startWorkflowViaDaemon(
              { repoRoot, plan: samplePlan },
              { socketPath },
            )
            expect(startRes).toEqual({ runId, executionId, outcome: "started" })

            const statusRes = yield* getWorkflowStatusViaDaemon({ repoRoot, runId }, { socketPath })
            expect(statusRes._tag).toBe("Ready")
            match(statusRes)
              .with({ _tag: "Ready" }, (ready) => {
                expect(ready.writerLeaseEpoch).toBe(LeaseEpoch.make(1))
                expect(ready.outcome._tag).toBe("NotFound")
              })
              .with({ _tag: "DaemonOffline" }, { _tag: "StorePaused" }, () => {
                expect.unreachable("Expected Ready status")
              })
              .exhaustive()

            const completeRes = yield* completeWorkflowViaDaemon(
              { _tag: "CompleteLlmPhase", repoRoot, runId },
              { socketPath },
            )
            expect(completeRes._tag).toBe("LlmPhaseCompleted")

            const resumeRes = yield* resumeWorkflowViaDaemon(
              {
                _tag: "ResolveEscalation",
                repoRoot,
                runId,
                unitId: WorkUnitId.make("u-alpha"),
                decision: EscalationDecision.make("retry"),
              },
              { socketPath },
            )
            expect(resumeRes._tag).toBe("EscalationResolved")

            const abortRes = yield* abortWorkflowViaDaemon({ repoRoot, runId }, { socketPath })
            expect(abortRes.state).toBe("aborted")

            const doctorRes = yield* doctorWorkflowViaDaemon(
              { repoRoot, mode: WorkflowDoctorMode.make("rebuild") },
              { socketPath },
            )
            expect(doctorRes.rebuiltRunCount).toBe(2)
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )
})
