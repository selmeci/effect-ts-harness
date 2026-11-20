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
import { Cause, Effect, Option, Schema, Tracer } from "effect"
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
import { resolveWorkflowRuntimePaths } from "../src/worktree-repo-root.js"

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

const decodeJsonLine = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      command: Schema.optional(Schema.String),
    }),
  ),
)

describe("WF-3 UnitVerifier, WorkflowWorktreePort, ReviewRouter, PlanCompiler, and DaemonClient", () => {
  it.live(
    "L1 epic unit verification checks .harness/verify-stamp.json with HARNESS_WORKTREE_ID unset and rejects missing/stale stamps",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const sliceUnit = {
            _tag: "SliceUnit" as const,
            unitId: WorkUnitId.make("alpha-slice"),
            branch: SliceBranchName.make("slice/alpha-unit"),
            waveIndex: WaveIndex.make(0),
            dependsOn: [],
            ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
            earsKeys: [EarsRequirementKey.make("REQ-2.1")],
          }

          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 2\n",
            "utf8",
          )

          const envWithWorktreeId: Readonly<Record<string, string | undefined>> = {
            ...process.env,
            HARNESS_WORKTREE_ID: "must-be-ignored-in-l1",
          }

          // Uncommitted edits on L1 epic must be rejected (AgentFailed)
          const uncommittedOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l1-0001"),
              level: "epic",
              baseSha,
              unit: sliceUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: envWithWorktreeId },
          )
          match(uncommittedOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("AgentFailed")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(AgentFailed) on uncommitted L1 edit")
            })
            .exhaustive()

          // Commit L1 work before checking stamp
          execFileSync("git", ["add", "libs/alpha/src/index.ts"], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "alpha slice work"], {
            cwd: repoRoot,
            stdio: "ignore",
          })

          // Missing stamp -> StampMissing
          const missingOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l1-0001"),
              level: "epic",
              baseSha,
              unit: sliceUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: envWithWorktreeId },
          )
          expect(missingOutcome._tag).toBe("Rejected")
          match(missingOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("StampMissing")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(StampMissing)")
            })
            .exhaustive()

          // Write valid L1 repo-level verify stamp (without HARNESS_WORKTREE_ID)
          const cleanEnv: Record<string, string | undefined> = { ...process.env }
          Reflect.deleteProperty(cleanEnv, "HARNESS_WORKTREE_ID")
          Reflect.deleteProperty(cleanEnv, "HARNESS_STATE_DIR")
          const stamp = writeVerifyStamp(repoRoot, makeStampHostIo(cleanEnv), "slice/alpha-unit")

          const okOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l1-0001"),
              level: "epic",
              baseSha,
              unit: sliceUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { env: envWithWorktreeId },
          )
          match(okOutcome)
            .with({ _tag: "Completed" }, (completed) => {
              expect(completed.unitId).toBe("alpha-slice")
              expect(completed.changedPaths).toEqual([OwnedRelPath.make("libs/alpha/src/index.ts")])
              expect(completed.packageStampHash).toBe(stamp.treeHash)
            })
            .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Completed after valid verify stamp")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "L2 slice unit verification runs packageVerifyCommand with HARNESS_WORKTREE_ID, excludes sibling paths, and rejects write-set violations & empty diffs",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const pkgUnit = {
            _tag: "PackageUnit" as const,
            unitId: WorkUnitId.make("pkg-alpha"),
            projectName: NxProjectName.make("@harness/alpha"),
            waveIndex: WaveIndex.make(0),
            dependsOn: [],
            ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
            stubKeys: [StubSymbolKey.make("Alpha.run")],
            earsKeys: [EarsRequirementKey.make("REQ-2.1")],
            packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
          }

          // Empty diff -> Rejected(AgentFailed)
          const emptyOutcome = yield* completeUnitImpl({
            runId: WorkflowRunId.make("run-l2-0001"),
            level: "slice",
            baseSha,
            unit: pkgUnit,
            attempt: AttemptNumber.make(1),
            cwd: repoRoot,
            siblingInFlightOwnedPaths: [],
          })
          match(emptyOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              expect(r.rejection._tag).toBe("AgentFailed")
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(AgentFailed) on empty diff")
            })
            .exhaustive()

          // Edit inside owned path + edit inside sibling in-flight path
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

          const makeMockHostIo = (verifyExitCode: number): ExtendedHostIo => ({
            ...nodeSyncHostIo,
            execFileSync: (
              cmd: string,
              args: ReadonlyArray<string>,
              opts?: SyncHostExecOptions,
            ) => {
              if (cmd === "git") {
                return nodeSyncHostIo.execFileSync(cmd, args, opts)
              }
              recordedCalls.push({
                cmd,
                args,
                worktreeId: opts?.env?.HARNESS_WORKTREE_ID,
              })
              return {
                _tag: "Exited",
                exitCode: verifyExitCode,
                stdout: "",
                stderr: verifyExitCode === 0 ? "" : "failed",
              }
            },
          })

          // Without sibling exclusion -> WriteSetViolation on libs/beta/src/index.ts
          const violationOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: pkgUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            { hostIo: makeMockHostIo(0) },
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

          // With sibling exclusion for libs/beta -> runs package verify command with HARNESS_WORKTREE_ID and succeeds
          const layer = makeUnitVerifierLayer({ hostIo: makeMockHostIo(0) })
          const passOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: pkgUnit,
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
            {
              cmd: "pnpm",
              args: ["nx", "run", "@harness/alpha:verify"],
              worktreeId: "pkg-alpha",
            },
          ])

          // Non-zero exit code -> PackageVerifyFailed clamped to 1..255
          const failOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: pkgUnit,
              attempt: AttemptNumber.make(3),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [OwnedRelPath.make("libs/beta")],
            },
            { hostIo: makeMockHostIo(300) },
          )
          match(failOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.exitCode).toBe(255)
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

          // One-way ownership edge case: owning libs/alpha/src must NOT cover libs/alpha-extra/file.ts
          // and owning libs/alpha/src/index.ts must NOT cover libs/alpha/src/other.ts
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "other.ts"),
            "export const o = 1\n",
            "utf8",
          )
          const narrowUnit = {
            ...pkgUnit,
            ownedRelPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
          }
          const narrowOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-l2-0001"),
              level: "slice",
              baseSha,
              unit: narrowUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [OwnedRelPath.make("libs/beta")],
            },
            { hostIo: makeMockHostIo(0) },
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
                    expect.unreachable("Expected WriteSetViolation on narrow ownership")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation)")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "completeSharedStepImpl validates sharedStepPaths, excludes priorUnitOwnedPaths, and rejects empty or out-of-scope changes",
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
              expect.unreachable("Expected WriteSetViolation for shared step")
            })
            .exhaustive()

          // With priorUnitOwnedPaths covering libs/alpha AND shared edit in libs/shared -> Completed!
          writeFileSync(
            join(repoRoot, "libs", "shared", "barrel.ts"),
            "export const shared = 2\n",
            "utf8",
          )
          const okWithPriorRes = yield* completeSharedStepImpl({
            runId: WorkflowRunId.make("run-shared-01"),
            baseSha,
            sharedStepPaths: [OwnedRelPath.make("libs/shared")],
            priorUnitOwnedPaths: [OwnedRelPath.make("libs/alpha")],
            attempt: AttemptNumber.make(2),
            cwd: repoRoot,
          })
          match(okWithPriorRes)
            .with({ _tag: "Completed" }, (c) => {
              expect(c.unitId).toBe(SHARED_STEP_UNIT_ID)
              expect(c.changedPaths).toEqual([OwnedRelPath.make("libs/shared/barrel.ts")])
            })
            .with({ _tag: "Rejected" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Completed for shared step with priorUnitOwnedPaths")
            })
            .exhaustive()
        }),
      ),
  )

  it.live(
    "WorkflowWorktreePortLive provisions L2 canonical, L1 linked worktrees, removes checkouts preserving slice/* branches, and merges idempotently with conflict abort",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const portLayer = makeWorkflowWorktreePortLayer({ repoRoot })

          const l2Plan: CompiledPlan = {
            runId: WorkflowRunId.make("run-l2-wt-1"),
            level: "slice",
            planSha: PlanSha256.make("a".repeat(64)),
            baseSha,
            mode: { _tag: "Manual" },
            units: [
              {
                _tag: "PackageUnit",
                unitId: WorkUnitId.make("u-alpha"),
                projectName: NxProjectName.make("@harness/alpha"),
                waveIndex: WaveIndex.make(0),
                dependsOn: [],
                ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
                stubKeys: [],
                earsKeys: [],
                packageVerifyCommand: PackageVerifyCommand.make(
                  "pnpm nx run @harness/alpha:verify",
                ),
              },
            ],
            sharedStepPaths: [],
          }

          const l2Receipt = yield* provisionWorkflowWorktreesImpl(l2Plan, { repoRoot })
          expect(l2Receipt.entries).toEqual([
            { unitId: WorkUnitId.make("u-alpha"), cwd: repoRoot, worktreeKind: "canonical" },
          ])

          const l1Plan: CompiledPlan = {
            runId: WorkflowRunId.make("run-l1-wt-1"),
            level: "epic",
            planSha: PlanSha256.make("b".repeat(64)),
            baseSha,
            mode: { _tag: "Manual" },
            units: [
              {
                _tag: "SliceUnit",
                unitId: WorkUnitId.make("s-alpha"),
                branch: SliceBranchName.make("slice/wf3-alpha"),
                waveIndex: WaveIndex.make(0),
                dependsOn: [],
                ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
                earsKeys: [],
              },
              {
                _tag: "SliceUnit",
                unitId: WorkUnitId.make("s-beta"),
                branch: SliceBranchName.make("slice/wf3-beta"),
                waveIndex: WaveIndex.make(0),
                dependsOn: [],
                ownedRelPaths: [OwnedRelPath.make("libs/beta")],
                earsKeys: [],
              },
            ],
            sharedStepPaths: [],
          }

          // Pre-existing leftover worktree directory on crash replay is cleaned idempotently
          const staleWorktreeDir = join(
            repoRoot,
            ".git",
            "harness",
            "worktrees",
            l1Plan.runId,
            "s-alpha",
          )
          mkdirSync(staleWorktreeDir, { recursive: true })
          writeFileSync(join(staleWorktreeDir, "stale.txt"), "leftover\n", "utf8")

          const receipt = yield* Effect.gen(function* () {
            const wt = yield* WorkflowWorktreePort
            return yield* wt.provisionWorktrees(l1Plan)
          }).pipe(Effect.provide(portLayer))

          expect(existsSync(join(staleWorktreeDir, "stale.txt"))).toBe(false)
          expect(receipt.entries.length).toBe(2)
          const alphaWt = receipt.entries[0]!
          const betaWt = receipt.entries[1]!
          expect(alphaWt.worktreeKind).toBe("linked")
          expect(betaWt.worktreeKind).toBe("linked")
          expect(existsSync(alphaWt.cwd)).toBe(true)
          expect(existsSync(betaWt.cwd)).toBe(true)

          // Commit non-conflicting work on both slice branches
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

          // Remove linked checkouts (compensation) -> directories gone, slice/* branches preserved!
          const { spans: removeSpans } = yield* runWithTestTracer(
            "removeWorktreeCheckouts",
            removeWorktreeCheckoutsImpl(receipt),
          )
          expect(removeSpans.some((s) => s.name === "Harness.removeWorktreeCheckouts")).toBe(true)
          expect(yield* decideSpanBudgets({ spans: removeSpans })).toEqual([])
          expect(existsSync(alphaWt.cwd)).toBe(false)
          expect(existsSync(betaWt.cwd)).toBe(false)
          const branches = execFileSync("git", ["branch", "--list", "slice/*"], {
            cwd: repoRoot,
            encoding: "utf8",
          })
          expect(branches).toContain("slice/wf3-alpha")
          expect(branches).toContain("slice/wf3-beta")

          // Calling removeWorktreeCheckoutsImpl again on already-removed checkouts logs warning and returns void (E = never)
          yield* removeWorktreeCheckoutsImpl(receipt)

          // Merge wave idempotently
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

          // Re-running mergeSliceWave on already-merged branches is idempotent!
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

          // Missing branch (exit 128) -> WorkspaceFsError, NOT Conflict!
          const missingBranchExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/does-not-exist")],
            }),
          )
          match(missingBranchExit)
            .with({ _tag: "Failure" }, () => undefined)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for missing branch")
            })
            .exhaustive()

          // Conflict case: create conflicting branch slice/wf3-conflict touching libs/alpha/src/index.ts
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

          // Dirty working tree colliding with incoming branch -> exit 128 WorkspaceFsError, NOT Conflict!
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 777\n",
            "utf8",
          )
          const dirtyMergeExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/wf3-conflict")],
            }),
          )
          match(dirtyMergeExit)
            .with({ _tag: "Failure" }, () => undefined)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for dirty merge")
            })
            .exhaustive()
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
          // git merge --abort left repo clean without MERGE_HEAD
          expect(existsSync(join(repoRoot, ".git", "MERGE_HEAD"))).toBe(false)
        }),
      ),
  )

  it.live(
    "WorkflowReviewRouterLive, UnitAgentDispatcherLive, and compileWorkflowPlanFromRepo work end-to-end",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)

          // UnitAgentDispatcherLive returns Failed
          const dispatchExit = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-dispatch-1"),
              unit: {
                _tag: "PackageUnit",
                unitId: WorkUnitId.make("u-1"),
                projectName: NxProjectName.make("@harness/alpha"),
                waveIndex: WaveIndex.make(0),
                dependsOn: [],
                ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
                stubKeys: [],
                earsKeys: [],
                packageVerifyCommand: PackageVerifyCommand.make(
                  "pnpm nx run @harness/alpha:verify",
                ),
              },
              attempt: AttemptNumber.make(1),
              runner: RunnerId.make("claude-code"),
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(UnitAgentDispatcherLive))
          expect(dispatchExit._tag).toBe("Failed")

          // Review router on empty diff -> SkipReviewPlan
          const emptyReview = yield* routeWorkflowReviewImpl({
            runId: WorkflowRunId.make("run-rev-1"),
            baseSha,
            canonicalRepoRoot: repoRoot,
          })
          expect(emptyReview._tag).toBe("SkipReviewPlan")

          // Add stub file & package.json for compileWorkflowPlanFromRepo auto-extraction + review routing
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

          const mockDmLayer = makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("focused"),
          })
          const reviewLayer = makeWorkflowReviewRouterLayer({
            decisionModelLayer: mockDmLayer,
          })
          const activeReview = yield* Effect.gen(function* () {
            const router = yield* WorkflowReviewRouter
            return yield* router.routeReview({
              runId: WorkflowRunId.make("run-rev-1"),
              baseSha,
              canonicalRepoRoot: repoRoot,
            })
          }).pipe(Effect.provide(reviewLayer))
          expect(activeReview._tag).toBe("ActiveReviewPlan")

          const { result: autoCompiled, spans: compileSpans } = yield* runWithTestTracer(
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
          expect(compileSpans.some((s) => s.name === "Harness.compileWorkflowPlanFromRepo")).toBe(
            true,
          )
          expect(yield* decideSpanBudgets({ spans: compileSpans })).toEqual([])
          expect(autoCompiled.units.length).toBe(1)
          expect(autoCompiled.units[0]?.ownedRelPaths).toEqual([OwnedRelPath.make("libs/alpha")])

          // Explicit inputJsonPath compilation
          const inputJsonPath = WorkspaceFilePath.make(join(dir, "plan-input.json"))
          writeFileSync(
            inputJsonPath,
            JSON.stringify({
              runId: "run-json-0001",
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
          const jsonCompiled = yield* compileWorkflowPlanFromRepo({
            repoRoot,
            level: "slice",
            mode: { _tag: "Manual" },
            inputJsonPath,
          })
          expect(jsonCompiled.runId).toBe("run-json-0001")
          expect(jsonCompiled.sharedStepPaths).toEqual([OwnedRelPath.make("libs/shared")])
        }),
      ),
  )

  it.live(
    "daemon-client WF-3 helpers perform handshake capability checks and decode typed RPC responses",
    () =>
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
            units: [
              {
                _tag: "PackageUnit",
                unitId: WorkUnitId.make("u-alpha"),
                projectName: NxProjectName.make("@harness/alpha"),
                waveIndex: WaveIndex.make(0),
                dependsOn: [],
                ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
                stubKeys: [],
                earsKeys: [],
                packageVerifyCommand: PackageVerifyCommand.make(
                  "pnpm nx run @harness/alpha:verify",
                ),
              },
            ],
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
                        units: [],
                        attempts: [],
                        pendingDeferreds: [],
                        storeStatus: "ready",
                        projectionStatus: "fresh",
                        writerLeaseEpoch: 1,
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

              const statusRes = yield* getWorkflowStatusViaDaemon(
                { repoRoot, runId },
                { socketPath },
              )
              expect(statusRes.storeStatus).toBe("ready")
              expect(statusRes.writerLeaseEpoch).toBe(LeaseEpoch.make(1))

              const completeRes = yield* completeWorkflowViaDaemon(
                { _tag: "CompleteLlmPhase", repoRoot, runId },
                { socketPath },
              )
              expect(completeRes._tag).toBe("LlmPhaseCompleted")

              const resumeRes = yield* resumeWorkflowViaDaemon(
                {
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

  it.live(
    "async spawn strips HARNESS_STATE_DIR, records Harness.completeUnit span budget, catches git mv renames, protected paths, TimedOut, and invalid baseSha",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const pkgUnit = {
            _tag: "PackageUnit" as const,
            unitId: WorkUnitId.make("pkg-async"),
            projectName: NxProjectName.make("@harness/alpha"),
            waveIndex: WaveIndex.make(0),
            dependsOn: [],
            ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
            stubKeys: [],
            earsKeys: [],
            packageVerifyCommand: PackageVerifyCommand.make("nx run @harness/alpha:verify"),
          }

          // Real async spawn subprocess via fake executable `nx` on PATH
          const binDir = join(dir, "bin")
          mkdirSync(binDir, { recursive: true })
          const envCapturePath = join(dir, "captured-env.json")
          const nxScript = join(binDir, "nx")
          writeFileSync(
            nxScript,
            `#!/usr/bin/env node\nconst fs = require("node:fs")\nfs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({ wid: process.env.HARNESS_WORKTREE_ID || null, sdir: process.env.HARNESS_STATE_DIR || null }))\nprocess.exit(0)\n`,
            "utf8",
          )
          chmodSync(nxScript, 0o755)

          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 55\n",
            "utf8",
          )

          const envWithInheritedState: Readonly<Record<string, string | undefined>> = {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            HARNESS_STATE_DIR: "/tmp/inherited-state-dir-must-be-stripped",
            HARNESS_WORKTREE_ID: "parent-worktree-id",
          }

          const { result: asyncOutcome, spans: completeSpans } = yield* runWithTestTracer(
            "completeUnit.async",
            completeUnitImpl(
              {
                runId: WorkflowRunId.make("run-async-1"),
                level: "slice",
                baseSha,
                unit: pkgUnit,
                attempt: AttemptNumber.make(1),
                cwd: repoRoot,
                siblingInFlightOwnedPaths: [],
              },
              { env: envWithInheritedState },
            ),
          )
          expect(completeSpans.some((s) => s.name === "Harness.completeUnit")).toBe(true)
          expect(yield* decideSpanBudgets({ spans: completeSpans })).toEqual([])
          expect(asyncOutcome._tag).toBe("Completed")
          const capturedEnv = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                wid: Schema.NullOr(Schema.String),
                sdir: Schema.NullOr(Schema.String),
              }),
            ),
          )(readFileSync(envCapturePath, "utf8"))
          expect(capturedEnv).toEqual({ wid: "pkg-async", sdir: null })

          // TimedOut verification -> Rejected(PackageVerifyFailed(exitCode: 1))
          const timeoutOutcome = yield* completeUnitImpl(
            {
              runId: WorkflowRunId.make("run-async-1"),
              level: "slice",
              baseSha,
              unit: pkgUnit,
              attempt: AttemptNumber.make(1),
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            },
            {
              runVerifyCommand: () =>
                Effect.succeed({ _tag: "TimedOut", stdout: "", stderr: "timed out" }),
            },
          )
          match(timeoutOutcome)
            .with({ _tag: "Rejected" }, (r) => {
              match(r.rejection)
                .with({ _tag: "PackageVerifyFailed" }, (p) => {
                  expect(p.exitCode).toBe(1)
                })
                .with(
                  { _tag: "AgentFailed" },
                  { _tag: "WriteSetViolation" },
                  { _tag: "StampMissing" },
                  () => {
                    expect.unreachable("Expected PackageVerifyFailed on TimedOut")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(PackageVerifyFailed)")
            })
            .exhaustive()

          // Protected path (.harness/custom-policy.json) -> Rejected(AgentFailed)
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
              expect.unreachable("Expected Rejected(AgentFailed) for protected .harness path")
            })
            .exhaustive()
          rmSync(join(repoRoot, ".harness"), { recursive: true, force: true })

          // git mv across ownership boundary (--no-renames) -> WriteSetViolation
          execFileSync("git", ["checkout", "--", "libs/alpha/src/index.ts"], { cwd: repoRoot })
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
                    expect.unreachable("Expected WriteSetViolation on git mv outside ownership")
                  },
                )
                .exhaustive()
            })
            .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
              expect.unreachable("Expected Rejected(WriteSetViolation) on git mv")
            })
            .exhaustive()

          // Invalid baseSha -> WorkspaceFsError
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
})
