import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, type Exit, Fiber, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AgentAuthRequiredError,
  AgentDiagnosticDetail,
  AgentExitError,
  AgentNoChangeError,
  AgentNonZeroExitCode,
  AgentOutputParseError,
  type AgentRunnerError,
  AgentTimeoutError,
  AgentToolDeniedError,
  AttemptNumber,
  BriefPrompt,
  DenialNotice,
  OwnedRelPath,
  RunnerConfigFilePath,
  TimeoutMillis,
  UnitBrief,
  UnitRejection,
  WorkUnitId,
  WorkflowRunId,
} from "@harness/contract"
import { decideSpanBudgets, type SpanSample } from "@harness/gates"
import { TypedHoleContextBundle } from "@harness/graph"
import { AgentRunnerPort, UnitAgentDispatcher, UnitVerifier } from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"
import {
  UnitVerifierLive,
  dispatchUnitImpl,
  inspectWorkflowRunnerDoctorChecks,
  makeAgentRunnerPortLayer,
  makeAntigravityRunnerLayer,
  makeClaudeCodeRunnerLayer,
  makeRunnerPgidRecordPath,
  makeUnitAgentDispatcherLayer,
  nodeSyncHostIo,
  reapOrphanAttemptProcessGroup,
  runClaudeCodeImpl,
  spawnSupervisedAgentProcess,
  toOutcome,
  writePgidRecordAtomic,
} from "../src/index.js"
import { isProcessGroupAlive, killProcessGroupPosix } from "../src/workflow/verify-child-process.js"
import {
  initGitRepo,
  makePackageUnit,
  waitForFilesExist,
  withTempDir,
  writeExecutableScript,
} from "./helpers/workflow-verifier-fixture.js"

const readLinuxProcStartTimeForTest = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
  const commEnd = raw.lastIndexOf(")")
  return raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/)[19]
}

const makeFakeCliEnv = (
  binDir: string,
  homeDir: string,
  extra?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => ({
  PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: homeDir,
  ...extra,
})

const makeBrief = (overrides?: { readonly promptText?: string }): UnitBrief =>
  UnitBrief.make({
    unitId: WorkUnitId.make("pkg-alpha"),
    attempt: AttemptNumber.make(1),
    promptText: BriefPrompt.make(
      overrides?.promptText ?? "Implement SPEC-0036 REQ-1 in libs/alpha",
    ),
    ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
  })

const expectTypedError = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): E =>
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) =>
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => expect.unreachable("Expected typed error"))
        .exhaustive(),
    )
    .with({ _tag: "Success" }, () => expect.unreachable("Expected failure, got success"))
    .exhaustive()

const makeClaudeSuccessScript = (promptCapturePath?: string): string => `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const capturePath = ${JSON.stringify(promptCapturePath ?? "")};
if (capturePath.length > 0 && pIdx >= 0) {
  fs.writeFileSync(capturePath, argv[pIdx + 1], "utf8");
}
process.stdout.write(JSON.stringify({
  result: "Implemented alpha",
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.04,
  duration_ms: 120,
  session_id: "sess-claude-1",
  usage: { input_tokens: 100, output_tokens: 50 },
}));
`

const CLAUDE_SUCCESS_SCRIPT = makeClaudeSuccessScript()

describe("SPEC-0036 WF-5 Process Supervision, PGID Safety, Dispatcher & Doctor", () => {
  it.live(
    "F-1.1 / S-1.1: spawnSupervisedAgentProcess reaps background grandchild on exit 0, error exit, and timeout BEFORE unlinking pgid record",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const binDir = join(dir, "bin")
          const pgidDir = join(dir, "pgids")
          mkdirSync(pgidDir, { recursive: true })

          // 1. Exit 0 immediately while background grandchild writes to a file in the same PGID
          const exit0Log = join(dir, "exit0-gc.log")
          const exit0PidFile = join(dir, "exit0-gc.pid")
          const exit0Pgid = join(pgidDir, "exit0.json")
          writeExecutableScript(
            binDir,
            "gc-exit0",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const pidFile = ${JSON.stringify(exit0PidFile)};
const gc = spawn(
  process.execPath,
  [
    "-e",
    "const fs=require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => { fs.appendFileSync(process.argv[2], 'tick '); }, 25);",
    pidFile,
    ${JSON.stringify(exit0Log)},
  ],
  { stdio: "ignore" },
);
gc.unref();
const timer = setInterval(() => {
  if (fs.existsSync(pidFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 10);
`,
          )
          const exit0Res = yield* spawnSupervisedAgentProcess(join(binDir, "gc-exit0"), [], {
            cwd: dir,
            env: process.env,
            timeoutMs: 5_000,
            killGraceMs: 250,
            pgidRecordPath: exit0Pgid,
            runner: "claude-code",
          })
          expect(exit0Res._tag).toBe("Exited")
          const exit0GcPid = Number(readFileSync(exit0PidFile, "utf8").trim())
          expect(exit0GcPid).toBeGreaterThan(0)
          expect(isProcessGroupAlive(exit0GcPid)).toBe(false)
          expect(existsSync(exit0Pgid)).toBe(false)
          const logLenAtReturn = existsSync(exit0Log) ? readFileSync(exit0Log, "utf8").length : 0
          yield* Effect.sleep("100 millis")
          const logLenAfter = existsSync(exit0Log) ? readFileSync(exit0Log, "utf8").length : 0
          expect(logLenAfter).toBe(logLenAtReturn)

          // 2. Non-zero error exit reaps background grandchild
          const errGcPidFile = join(dir, "err-gc.pid")
          const errPgid = join(pgidDir, "err.json")
          writeExecutableScript(
            binDir,
            "gc-err",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const pidFile = ${JSON.stringify(errGcPidFile)};
const gc = spawn(
  process.execPath,
  ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidFile],
  { stdio: "ignore" },
);
gc.unref();
const timer = setInterval(() => {
  if (fs.existsSync(pidFile)) {
    clearInterval(timer);
    process.exit(1);
  }
}, 10);
`,
          )
          const errRes = yield* spawnSupervisedAgentProcess(join(binDir, "gc-err"), [], {
            cwd: dir,
            env: process.env,
            timeoutMs: 5_000,
            killGraceMs: 250,
            pgidRecordPath: errPgid,
            runner: "claude-code",
          })
          expect(errRes._tag).toBe("Exited")
          const errGcPid = Number(readFileSync(errGcPidFile, "utf8").trim())
          expect(isProcessGroupAlive(errGcPid)).toBe(false)
          expect(existsSync(errPgid)).toBe(false)

          // 3. Timeout reaps SIGTERM-ignoring background grandchild (S-6.3 safe margins)
          const toGcPidFile = join(dir, "to-gc.pid")
          const toPgid = join(pgidDir, "to.json")
          writeExecutableScript(
            binDir,
            "gc-to",
            `
const { spawn } = require("node:child_process");
const gc = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(toGcPidFile)}) + ", String(process.pid)); setInterval(() => {}, 1000);"],
  { stdio: "ignore" },
);
gc.unref();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          )
          const toRes = yield* spawnSupervisedAgentProcess(join(binDir, "gc-to"), [], {
            cwd: dir,
            env: process.env,
            timeoutMs: 400,
            killGraceMs: 250,
            pgidRecordPath: toPgid,
            runner: "claude-code",
          })
          expect(toRes._tag).toBe("TimedOut")
          const toGcPid = Number(readFileSync(toGcPidFile, "utf8").trim())
          expect(isProcessGroupAlive(toGcPid)).toBe(false)
          expect(existsSync(toPgid)).toBe(false)
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-1.4 / S-6.3: Process-group timeout and fiber interruption reap SIGTERM-ignoring grandchild and clean gitCommonDir pgid record",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const grandchildPidPath = join(dir, "grandchild.pid")
          writeExecutableScript(
            binDir,
            "claude",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid), "utf8");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          )

          const runId = WorkflowRunId.make("run-timeout-pgid")
          const timeoutErr = expectTypedError(
            yield* Effect.exit(
              runClaudeCodeImpl(
                { runId, runner: "claude-code", brief: makeBrief(), cwd: repoRoot },
                { env, timeoutMs: 400, killGraceMs: 250 },
              ),
            ),
          )
          expect(timeoutErr._tag).toBe("AgentTimeoutError")
          const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8").trim())
          expect(isProcessGroupAlive(grandchildPid)).toBe(false)
          expect(
            existsSync(
              join(repoRoot, ".git", "harness", "runner-pgids", `${runId}-pkg-alpha-1.json`),
            ),
          ).toBe(false)
          expect(existsSync(join(repoRoot, ".harness", "runner-pgids"))).toBe(false)

          const interruptPidPath = join(dir, "interrupt-child.pid")
          writeExecutableScript(
            binDir,
            "claude",
            `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(interruptPidPath)}, String(child.pid), "utf8");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          )
          const interruptRunId = WorkflowRunId.make("run-interrupt-1")
          const interruptFiber = yield* Effect.forkChild(
            runClaudeCodeImpl(
              { runId: interruptRunId, runner: "claude-code", brief: makeBrief(), cwd: repoRoot },
              { env, timeoutMs: 10_000, killGraceMs: 250 },
            ),
          )
          expect(yield* waitForFilesExist([interruptPidPath])).toBe(true)
          const expectedInterruptPgidPath = join(
            repoRoot,
            ".git",
            "harness",
            "runner-pgids",
            `${interruptRunId}-pkg-alpha-1.json`,
          )
          expect(existsSync(expectedInterruptPgidPath)).toBe(true)
          yield* Fiber.interrupt(interruptFiber)
          const interruptChildPid = Number(readFileSync(interruptPidPath, "utf8").trim())
          expect(isProcessGroupAlive(interruptChildPid)).toBe(false)
          expect(existsSync(expectedInterruptPgidPath)).toBe(false)
        }),
      ),
  )

  it.live(
    "F-16.2 / F-16.3 / S-6.1: Non-git fallback uses per-UID harness-runner-pgids-<uid> (0o700), exists while running, and fails closed on insecure mode or wrong UID",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          const nonGitCwd = join(dir, "non-git-cwd")
          mkdirSync(homeDir, { recursive: true })
          mkdirSync(nonGitCwd, { recursive: true })

          const uidSuffix = typeof process.getuid === "function" ? String(process.getuid()) : "user"
          const nonGitRunId = WorkflowRunId.make("run-non-git-1")
          const expectedDir = join(tmpdir(), `harness-runner-pgids-${uidSuffix}`)
          const expectedPgidPath = join(expectedDir, `${nonGitRunId}-pkg-alpha-1.json`)

          // F-16.3: makeRunnerPgidRecordPath always resolves a non-empty string
          const resolvedPgidPath = yield* makeRunnerPgidRecordPath(
            {
              runId: nonGitRunId,
              runner: "claude-code",
              brief: makeBrief(),
              cwd: AbsoluteRepoRoot.make(nonGitCwd),
            },
            nodeSyncHostIo,
          )
          expect(resolvedPgidPath).toBe(expectedPgidPath)

          const pgidExistedDuringRunPath = join(dir, "pgid-existed.txt")
          writeExecutableScript(
            binDir,
            "claude",
            `
const fs = require("node:fs");
const existed = fs.existsSync(${JSON.stringify(expectedPgidPath)});
fs.writeFileSync(${JSON.stringify(pgidExistedDuringRunPath)}, String(existed), "utf8");
process.stdout.write(JSON.stringify({ result: "non-git ok", is_error: false }));
`,
          )
          const env = makeFakeCliEnv(binDir, homeDir)
          const nonGitRes = yield* runClaudeCodeImpl(
            {
              runId: nonGitRunId,
              runner: "claude-code",
              brief: makeBrief(),
              cwd: AbsoluteRepoRoot.make(nonGitCwd),
            },
            { env },
          )
          expect(nonGitRes.exit).toBe(0)
          expect(readFileSync(pgidExistedDuringRunPath, "utf8")).toBe("true")
          expect(existsSync(expectedPgidPath)).toBe(false)
          expect(existsSync(join(nonGitCwd, ".harness"))).toBe(false)
          if (process.platform !== "win32") {
            expect(nodeSyncHostIo.statModeSync(expectedDir)! & 0o777).toBe(0o700)
          }

          // F-16.2: insecure permissions on fallback dir fail closed with AgentExitError
          const insecureHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            statModeSync: (p) => (p === expectedDir ? 0o755 : nodeSyncHostIo.statModeSync(p)),
          }
          const insecureErr = expectTypedError(
            yield* Effect.exit(
              runClaudeCodeImpl(
                {
                  runId: WorkflowRunId.make("run-insecure-mode"),
                  runner: "claude-code",
                  brief: makeBrief(),
                  cwd: AbsoluteRepoRoot.make(nonGitCwd),
                },
                { env, hostIo: insecureHostIo },
              ),
            ),
          )
          expect(insecureErr._tag).toBe("AgentExitError")
          match(insecureErr)
            .with({ _tag: "AgentExitError" }, (e) => {
              expect(e.detail).toContain("insecure permissions")
            })
            .with(
              { _tag: "AgentTimeoutError" },
              { _tag: "AgentToolDeniedError" },
              { _tag: "AgentAuthRequiredError" },
              { _tag: "AgentOutputParseError" },
              { _tag: "AgentNoChangeError" },
              () => expect.unreachable("Expected AgentExitError"),
            )
            .exhaustive()

          // F-16.2: non-owned fallback dir fails closed with AgentExitError
          if (process.platform !== "win32" && typeof process.getuid === "function") {
            const wrongUidErr = expectTypedError(
              yield* Effect.exit(
                runClaudeCodeImpl(
                  {
                    runId: WorkflowRunId.make("run-wrong-uid"),
                    runner: "claude-code",
                    brief: makeBrief(),
                    cwd: AbsoluteRepoRoot.make(nonGitCwd),
                  },
                  { env, statUidSync: () => process.getuid!() + 10_000 },
                ),
              ),
            )
            expect(wrongUidErr._tag).toBe("AgentExitError")
            match(wrongUidErr)
              .with({ _tag: "AgentExitError" }, (e) => {
                expect(e.detail).toContain("not owned by uid")
              })
              .with(
                { _tag: "AgentTimeoutError" },
                { _tag: "AgentToolDeniedError" },
                { _tag: "AgentAuthRequiredError" },
                { _tag: "AgentOutputParseError" },
                { _tag: "AgentNoChangeError" },
                () => expect.unreachable("Expected AgentExitError"),
              )
              .exhaustive()
          }
        }),
      ),
  )

  it.live(
    "F-16.1 / F-17.1: reapOrphanAttemptProcessGroup fails closed on symlink PGID record while leaving target and live process alive",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const liveGuardReady = join(dir, "guard.ready")
          const liveGuardProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(liveGuardReady)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const liveGuardPid = liveGuardProc.pid!
          liveGuardProc.unref()
          expect(yield* waitForFilesExist([liveGuardReady])).toBe(true)

          const symTargetPgidPath = join(dir, "sym-target-pgid.json")
          const startTime = readLinuxProcStartTimeForTest(liveGuardPid)
          writeFileSync(
            symTargetPgidPath,
            JSON.stringify({
              pgid: liveGuardPid,
              ...(startTime !== undefined ? { procStartTime: startTime } : {}),
            }),
            "utf8",
          )
          const symPgidPath = join(dir, "sym-pgid.json")
          symlinkSync(symTargetPgidPath, symPgidPath)

          const symErr = expectTypedError(
            yield* Effect.exit(reapOrphanAttemptProcessGroup(symPgidPath)),
          )
          expect(symErr._tag).toBe("AgentExitError")
          expect(existsSync(symTargetPgidPath)).toBe(true)
          expect(isProcessGroupAlive(liveGuardPid)).toBe(true)

          if (isProcessGroupAlive(liveGuardPid)) {
            process.kill(-liveGuardPid, "SIGKILL")
          }
        }),
      ),
  )

  it.live(
    "F-16.1 / F-17.2: writePgidRecordAtomic and reapOrphanAttemptProcessGroup fail closed with AgentExitError on every refusal branch",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const targetPath = join(dir, "pgid-dir", "rec.json")
          const pgidDir = join(dir, "pgid-dir")

          // 1. symlink parentDir
          const errSymParent = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => p === dir,
          })
          expect(errSymParent?._tag).toBe("AgentExitError")
          expect(errSymParent?.detail).toContain("symlink pgid parent directory")

          // 2. symlink dir before mkdir
          const errSymDirBefore = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => p === pgidDir,
          })
          expect(errSymDirBefore?._tag).toBe("AgentExitError")
          expect(errSymDirBefore?.detail).toContain("symlink pgid directory")

          // 3. symlink dir after mkdir
          let dirSymChecks = 0
          const errSymDirAfter = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => {
              if (p === pgidDir) {
                dirSymChecks += 1
                return dirSymChecks > 1
              }
              return false
            },
          })
          expect(errSymDirAfter?._tag).toBe("AgentExitError")
          expect(errSymDirAfter?.detail).toContain("after mkdir")

          // 4. symlink pgidRecordPath
          const errSymFile = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => p === targetPath,
          })
          expect(errSymFile?._tag).toBe("AgentExitError")
          expect(errSymFile?.detail).toContain("symlink pgid record")

          // 5. tryWriteExclusiveTextSync returns Exists
          const errExists = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            tryWriteExclusiveTextSync: () => ({ _tag: "Exists" }),
          })
          expect(errExists?._tag).toBe("AgentExitError")
          expect(errExists?.detail).toContain("pre-existing temp pgid record")

          // 6. tryWriteExclusiveTextSync returns Failed
          const errFailed = writePgidRecordAtomic(targetPath, 1234, {
            ...nodeSyncHostIo,
            tryWriteExclusiveTextSync: () => ({
              _tag: "Failed",
              code: "EACCES",
              message: "permission denied",
            }),
          })
          expect(errFailed?._tag).toBe("AgentExitError")
          expect(errFailed?.detail).toContain("EACCES")

          // 7. reapOrphanAttemptProcessGroup refuses non-file and read failures
          const nonFilePath = join(dir, "non-file-pgid")
          mkdirSync(nonFilePath, { recursive: true })
          const nonFileErr = expectTypedError(
            yield* Effect.exit(reapOrphanAttemptProcessGroup(nonFilePath)),
          )
          expect(nonFileErr._tag).toBe("AgentExitError")

          const readFailPath = join(dir, "read-fail.json")
          writeFileSync(readFailPath, "{}", "utf8")
          const readErr = expectTypedError(
            yield* Effect.exit(
              reapOrphanAttemptProcessGroup(readFailPath, {
                ...nodeSyncHostIo,
                readBytesPrefixSync: () => {
                  throw new Error("EIO: read error")
                },
              }),
            ),
          )
          expect(readErr._tag).toBe("AgentExitError")
        }),
      ),
  )

  it.live(
    "F-17.3: reapOrphanAttemptProcessGroup reaps live process group without procStartTime when /proc/<pid>/stat is unreadable",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const orphanReadyPath = join(dir, "noproc-orphan.ready")
          const orphanProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(orphanReadyPath)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const orphanPid = orphanProc.pid!
          orphanProc.unref()
          expect(yield* waitForFilesExist([orphanReadyPath])).toBe(true)
          expect(isProcessGroupAlive(orphanPid)).toBe(true)

          const recordPath = join(dir, "noproc-pgid.json")
          writeFileSync(recordPath, JSON.stringify({ pgid: orphanPid }), "utf8")

          const noProcHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            readTextSync: (p) => {
              if (p.startsWith("/proc/")) {
                throw new Error("ENOENT: /proc not mounted")
              }
              return nodeSyncHostIo.readTextSync(p)
            },
          }
          yield* reapOrphanAttemptProcessGroup(recordPath, noProcHostIo)
          expect(isProcessGroupAlive(orphanPid)).toBe(false)
          expect(existsSync(recordPath)).toBe(false)
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-1.4: reapOrphanAttemptProcessGroup enforces procStartTime, PID reuse guard, and corrupt JSON cleanup",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const env = makeFakeCliEnv(binDir, homeDir)

          const orphanReadyPath = join(dir, "orphan.ready")
          const orphanProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(orphanReadyPath)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const orphanPid = orphanProc.pid!
          orphanProc.unref()
          expect(yield* waitForFilesExist([orphanReadyPath])).toBe(true)

          const gitPgidDir = join(repoRoot, ".git", "harness", "runner-pgids")
          mkdirSync(gitPgidDir, { recursive: true })
          const orphanRunId = WorkflowRunId.make("run-orphan-1")
          const orphanRecordPath = join(gitPgidDir, `${orphanRunId}-pkg-alpha-1.json`)
          const orphanStartTime = readLinuxProcStartTimeForTest(orphanPid)
          writeFileSync(
            orphanRecordPath,
            JSON.stringify({
              pgid: orphanPid,
              ...(orphanStartTime !== undefined ? { procStartTime: orphanStartTime } : {}),
            }),
            "utf8",
          )

          writeExecutableScript(binDir, "claude", CLAUDE_SUCCESS_SCRIPT)
          const recoveredRes = yield* runClaudeCodeImpl(
            { runId: orphanRunId, runner: "claude-code", brief: makeBrief(), cwd: repoRoot },
            { env },
          )
          expect(recoveredRes.exit).toBe(0)
          expect(isProcessGroupAlive(orphanPid)).toBe(false)
          expect(existsSync(orphanRecordPath)).toBe(false)

          const corruptPgidPath = join(dir, "corrupt-pgid.json")
          writeFileSync(corruptPgidPath, "{bad-pgid", "utf8")
          yield* reapOrphanAttemptProcessGroup(corruptPgidPath)
          expect(existsSync(corruptPgidPath)).toBe(false)

          const initPgidPath = join(dir, "init-pgid.json")
          writeFileSync(initPgidPath, JSON.stringify({ pgid: 1 }), "utf8")
          yield* reapOrphanAttemptProcessGroup(initPgidPath)
          expect(existsSync(initPgidPath)).toBe(false)

          const selfPgidPath = join(dir, "self-pgid.json")
          writeFileSync(selfPgidPath, JSON.stringify({ pgid: process.pid }), "utf8")
          yield* reapOrphanAttemptProcessGroup(selfPgidPath)
          expect(existsSync(selfPgidPath)).toBe(false)

          expect(killProcessGroupPosix(1, 0)).toBe(false)
          expect(killProcessGroupPosix(process.pid, 0)).toBe(false)
          expect(killProcessGroupPosix(1.5, 0)).toBe(false)

          const liveGuardReady = join(dir, "guard2.ready")
          const liveGuardProc = spawn(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(liveGuardReady)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`,
            ],
            { detached: true, stdio: "ignore" },
          )
          const liveGuardPid = liveGuardProc.pid!
          liveGuardProc.unref()
          expect(yield* waitForFilesExist([liveGuardReady])).toBe(true)

          if (process.platform === "linux") {
            const missingStartPath = join(dir, "missing-start-pgid.json")
            writeFileSync(missingStartPath, JSON.stringify({ pgid: liveGuardPid }), "utf8")
            yield* reapOrphanAttemptProcessGroup(missingStartPath)
            expect(isProcessGroupAlive(liveGuardPid)).toBe(true)
            expect(existsSync(missingStartPath)).toBe(false)
          }

          const reuseRecordPath = join(dir, "reuse-pgid.json")
          writeFileSync(
            reuseRecordPath,
            JSON.stringify({ pgid: liveGuardPid, procStartTime: "999999999999" }),
            "utf8",
          )
          yield* reapOrphanAttemptProcessGroup(reuseRecordPath)
          if (process.platform === "linux") {
            expect(isProcessGroupAlive(liveGuardPid)).toBe(true)
          }
          expect(existsSync(reuseRecordPath)).toBe(false)
          if (isProcessGroupAlive(liveGuardPid)) {
            process.kill(-liveGuardPid, "SIGKILL")
          }
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-4.1..4.4: toOutcome maps all 6 AgentRunnerError variants and UnitVerifierLive emits AgentNoChangeError",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const unitId = WorkUnitId.make("pkg-alpha")
          const attempt = AttemptNumber.make(1)

          expect(
            toOutcome(unitId, attempt, new AgentAuthRequiredError({ runner: "claude-code" }))._tag,
          ).toBe("Escalated")

          const rejectedErrors: ReadonlyArray<AgentRunnerError> = [
            new AgentTimeoutError({ runner: "claude-code", afterMillis: TimeoutMillis.make(1000) }),
            new AgentToolDeniedError({
              runner: "claude-code",
              notice: DenialNotice.make("denied"),
            }),
            new AgentExitError({
              runner: "antigravity",
              exit: AgentNonZeroExitCode.make(2),
            }),
            new AgentOutputParseError({
              runner: "antigravity",
              detail: AgentDiagnosticDetail.make("bad json"),
            }),
            new AgentNoChangeError({ runner: "claude-code" }),
          ]
          for (const err of rejectedErrors) {
            const outcome = toOutcome(unitId, attempt, err)
            expect(outcome).toMatchObject({ _tag: "Rejected", rejection: { _tag: "AgentFailed" } })
          }

          const autoEmptyOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-empty-auto"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt,
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
              runner: "claude-code",
            })
          }).pipe(Effect.provide(UnitVerifierLive))
          expect(autoEmptyOutcome).toMatchObject({
            _tag: "Rejected",
            rejection: { _tag: "AgentFailed" },
          })

          const manualEmptyOutcome = yield* Effect.gen(function* () {
            const verifier = yield* UnitVerifier
            return yield* verifier.completeUnit({
              runId: WorkflowRunId.make("run-empty-manual"),
              level: "slice",
              baseSha,
              unit: makePackageUnit(),
              attempt,
              cwd: repoRoot,
              siblingInFlightOwnedPaths: [],
            })
          }).pipe(Effect.provide(UnitVerifierLive))
          expect(manualEmptyOutcome).toMatchObject({
            _tag: "Rejected",
            rejection: {
              _tag: "AgentFailed",
              reason: "No changed files detected for unit completion",
            },
          })
        }),
      ),
  )

  it.live(
    "F-5.1 / F-17.4 / S-3.3: UnitAgentDispatcher injects loadHoleBundles, mcpConfigPath, REPO_ROOT, ownedRelPaths, priorRejection into -p prompt and annotates telemetry span",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const promptCapturePath = join(dir, "captured-prompt.txt")
          const mcpFile = join(dir, "custom-mcp.json")
          writeFileSync(mcpFile, '{"mcpServers":{"test":{"command":"echo"}}}', "utf8")
          writeExecutableScript(binDir, "claude", makeClaudeSuccessScript(promptCapturePath))
          const env = makeFakeCliEnv(binDir, homeDir)

          const bundle = yield* Schema.decodeEffect(TypedHoleContextBundle)({
            holeQualname: "Alpha.compute",
            spanName: "Alpha.compute",
            estimatedTokens: 120,
            successTypeSignature: "Effect.Effect<void, never, never>",
            allowedErrorConstructors: ["WorkspaceFsError"],
            requiredServiceCapabilities: ["WorkspaceFs"],
            inhabitingCandidates: [],
          })

          const capturedAnnotations = new Map<string, unknown>()
          const recordedSpans: Array<SpanSample> = []
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options)
              const parentSpanId = Option.match(options.parent, {
                onNone: () => null,
                onSome: (p) => p.spanId,
              })
              const origAttr = span.attribute.bind(span)
              span.attribute = (k, v) => {
                if (span.name === "UnitAgentDispatcher.dispatchUnit") {
                  capturedAnnotations.set(k, v)
                }
                origAttr(k, v)
              }
              recordedSpans.push({ spanId: span.spanId, name: span.name, parentSpanId })
              const origEnd = span.end.bind(span)
              span.end = (endTime, exit) => {
                recordedSpans.push({ spanId: span.spanId, name: span.name, parentSpanId })
                origEnd(endTime, exit)
              }
              return span
            },
          })

          const dispatched = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-dispatch-hole"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(2),
              runner: "claude-code",
              cwd: repoRoot,
              priorRejection: UnitRejection.cases.StampMissing.make({}),
              mcpConfigPath: RunnerConfigFilePath.make(mcpFile),
            })
          }).pipe(
            Effect.provide(
              makeUnitAgentDispatcherLayer({
                env,
                loadHoleBundles: () => Effect.succeed([bundle]),
              }),
            ),
            Effect.provideService(Tracer.Tracer, tracer),
          )

          expect(dispatched._tag).toBe("Completed")
          const promptText = readFileSync(promptCapturePath, "utf8")
          expect(promptText).toContain(`REPO_ROOT=${repoRoot}`)
          expect(promptText).toContain("libs/alpha")
          expect(promptText).toContain("<typed-hole-context>")
          expect(promptText).toContain("Alpha.compute")
          expect(promptText).toContain("Effect.Effect<void, never, never>")
          expect(promptText).toContain("<prior-rejection>")
          expect(promptText).toContain("StampMissing")

          expect(capturedAnnotations.get("runner")).toBe("claude-code")
          expect(capturedAnnotations.get("resultLength")).toBe("Implemented alpha".length)
          expect(capturedAnnotations.get("usage._tag")).toBe("Reported")
          expect(capturedAnnotations.get("inputTokens")).toBe(100)
          expect(capturedAnnotations.get("outputTokens")).toBe(50)
          expect(capturedAnnotations.get("totalCostUsd")).toBe(0.04)
          expect(yield* decideSpanBudgets({ spans: recordedSpans })).toEqual([])
        }),
      ),
  )

  it.live(
    "F-5.2: UnitAgentDispatcher forwards antigravity mcpIsolation & hardMcpFallback (reject and fallback-claude)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const promptCapturePath = join(dir, "fallback-prompt.txt")
          writeExecutableScript(binDir, "claude", makeClaudeSuccessScript(promptCapturePath))
          const env = makeFakeCliEnv(binDir, homeDir)
          const emptyBinDir = join(dir, "empty-bin")
          mkdirSync(emptyBinDir, { recursive: true })

          const rejectLayer = makeUnitAgentDispatcherLayer({ env: { ...env, PATH: emptyBinDir } })
          const layer = makeUnitAgentDispatcherLayer({ env })

          const rejectedRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-agy-hard-reject"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              runner: "antigravity",
              cwd: repoRoot,
              mcpIsolation: "hard",
              hardMcpFallback: "reject",
            })
          }).pipe(Effect.provide(rejectLayer))
          expect(rejectedRes._tag).toBe("Failed")
          match(rejectedRes)
            .with({ _tag: "Failed" }, (r) => {
              expect(r.reason).toContain("hard MCP isolation")
            })
            .with({ _tag: "Completed" }, { _tag: "FatalFailed" }, { _tag: "AuthRequired" }, () =>
              expect.unreachable("Expected Failed"),
            )
            .exhaustive()

          const fallbackRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-agy-hard-fallback"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              runner: "antigravity",
              cwd: repoRoot,
              mcpIsolation: "hard",
              hardMcpFallback: "fallback-claude",
            })
          }).pipe(Effect.provide(layer))
          expect(fallbackRes._tag).toBe("Completed")
          expect(readFileSync(promptCapturePath, "utf8")).toContain(`REPO_ROOT=${repoRoot}`)
        }),
      ),
  )

  it.live(
    "F-17.5 / F-11.1 / F-7.1: UnitAgentDispatcher covers Failed, FatalFailed (missing binary), AuthRequired, brief failure, and dedicated runner layer mismatches",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(homeDir, { recursive: true })
          const okEnv = makeFakeCliEnv(binDir, homeDir)
          const emptyEnv = { ...okEnv, PATH: join(dir, "empty-bin") }

          // 1. FatalFailed on missing binary
          const fatalRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-disp-fatal"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              runner: "claude-code",
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeUnitAgentDispatcherLayer({ env: emptyEnv })))
          expect(fatalRes._tag).toBe("FatalFailed")

          // 2. AuthRequired on auth failure
          writeExecutableScript(
            binDir,
            "claude",
            `process.stderr.write("Authentication required: please run /login\\n"); process.exit(1);`,
          )
          const authRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-disp-auth"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              runner: "claude-code",
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeUnitAgentDispatcherLayer({ env: okEnv })))
          expect(authRes).toEqual({ _tag: "AuthRequired", runner: "claude-code" })

          // 3. Failed on non-zero exit
          writeExecutableScript(
            binDir,
            "claude",
            `process.stdout.write(JSON.stringify({ result: "boom", is_error: true })); process.exit(2);`,
          )
          const failedRes = yield* Effect.gen(function* () {
            const dispatcher = yield* UnitAgentDispatcher
            return yield* dispatcher.dispatchUnit({
              runId: WorkflowRunId.make("run-disp-fail"),
              unit: makePackageUnit(),
              attempt: AttemptNumber.make(1),
              runner: "claude-code",
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeUnitAgentDispatcherLayer({ env: okEnv })))
          expect(failedRes._tag).toBe("Failed")

          // 4. F-11.1: Unexpected brief-construction throw is caught as UnitAgentDispatchResult.Failed
          const badUnit = makePackageUnit()
          Object.defineProperty(badUnit, "ownedRelPaths", {
            get() {
              throw new Error("unexpected brief getter failure")
            },
          })
          const briefErrRes = yield* dispatchUnitImpl({
            runId: WorkflowRunId.make("run-disp-brief-err"),
            unit: badUnit,
            attempt: AttemptNumber.make(1),
            runner: "claude-code",
            cwd: repoRoot,
          }).pipe(Effect.provide(makeAgentRunnerPortLayer({ env: okEnv })))
          expect(briefErrRes._tag).toBe("Failed")
          match(briefErrRes)
            .with({ _tag: "Failed" }, (r) => {
              expect(r.reason).toContain("unexpected brief getter failure")
            })
            .with({ _tag: "Completed" }, { _tag: "FatalFailed" }, { _tag: "AuthRequired" }, () =>
              expect.unreachable("Expected Failed"),
            )
            .exhaustive()

          // 5. Dedicated runner layers succeed on match and fail closed on mismatch
          writeExecutableScript(binDir, "claude", CLAUDE_SUCCESS_SCRIPT)
          writeExecutableScript(
            binDir,
            "agy",
            `process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "Layer agy ok" }));`,
          )
          const claudeOk = yield* Effect.gen(function* () {
            const port = yield* AgentRunnerPort
            return yield* port.run({
              runId: WorkflowRunId.make("run-layer-claude"),
              runner: "claude-code",
              brief: makeBrief(),
              cwd: repoRoot,
            })
          }).pipe(Effect.provide(makeClaudeCodeRunnerLayer({ env: okEnv })))
          expect(claudeOk.runner).toBe("claude-code")

          const mismatchClaude = expectTypedError(
            yield* Effect.exit(
              Effect.gen(function* () {
                const port = yield* AgentRunnerPort
                return yield* port.run({
                  runId: WorkflowRunId.make("run-layer-mismatch-1"),
                  runner: "antigravity",
                  brief: makeBrief(),
                  cwd: repoRoot,
                })
              }).pipe(Effect.provide(makeClaudeCodeRunnerLayer({ env: okEnv }))),
            ),
          )
          expect(mismatchClaude._tag).toBe("AgentExitError")

          const mismatchAgy = expectTypedError(
            yield* Effect.exit(
              Effect.gen(function* () {
                const port = yield* AgentRunnerPort
                return yield* port.run({
                  runId: WorkflowRunId.make("run-layer-mismatch-2"),
                  runner: "claude-code",
                  brief: makeBrief(),
                  cwd: repoRoot,
                })
              }).pipe(Effect.provide(makeAntigravityRunnerLayer({ env: okEnv }))),
            ),
          )
          expect(mismatchAgy._tag).toBe("AgentExitError")
        }),
      ),
  )

  it.live(
    "SPEC-0036 REQ-4.6 / S-6.2: inspectWorkflowRunnerDoctorChecks tests placeholder, ready, single-fault missing/non-exec binary, and single-fault invalid/symlink settings.json",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const binDir = join(dir, "bin")
          const homeDir = join(dir, "home")
          mkdirSync(binDir, { recursive: true })
          mkdirSync(homeDir, { recursive: true })

          const missingChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "placeholder",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(missingChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "warn"],
            ["runner-claude-code", "warn"],
            ["runner-antigravity", "warn"],
          ])

          writeExecutableScript(binDir, "claude", "process.exit(0);")
          writeExecutableScript(binDir, "agy", "process.exit(0);")
          const agySettingsDir = join(homeDir, ".gemini", "antigravity-cli")
          mkdirSync(agySettingsDir, { recursive: true })
          const agySettingsPath = join(agySettingsDir, "settings.json")
          writeFileSync(agySettingsPath, JSON.stringify({ mode: "accept-edits" }), "utf8")

          const readyChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(readyChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "ok"],
            ["runner-claude-code", "ok"],
            ["runner-antigravity", "ok"],
          ])

          // Single-fault 1: non-executable claude with valid settings.json
          chmodSync(join(binDir, "claude"), 0o644)
          const nonExecClaudeChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(nonExecClaudeChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "ok"],
            ["runner-claude-code", "warn"],
            ["runner-antigravity", "ok"],
          ])
          chmodSync(join(binDir, "claude"), 0o755)

          // Single-fault 2: present binaries with corrupt settings.json
          writeFileSync(agySettingsPath, "{corrupt-json", "utf8")
          const corruptSettingsChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: homeDir },
          })
          expect(corruptSettingsChecks.map((c) => [c.name, c.status])).toEqual([
            ["agent-dispatcher", "ok"],
            ["runner-claude-code", "ok"],
            ["runner-antigravity", "warn"],
          ])

          // Symlink settings.json -> runner-antigravity warn
          const realTarget = join(dir, "real-agy-settings.json")
          writeFileSync(realTarget, JSON.stringify({ mode: "accept-edits" }), "utf8")
          const symHome = join(dir, "sym-home")
          const symSettingsDir = join(symHome, ".gemini", "antigravity-cli")
          mkdirSync(symSettingsDir, { recursive: true })
          symlinkSync(realTarget, join(symSettingsDir, "settings.json"))
          const symChecks = yield* inspectWorkflowRunnerDoctorChecks({
            runnerKind: "live",
            env: { PATH: binDir, HOME: symHome },
          })
          expect(symChecks[2]?.name).toBe("runner-antigravity")
          expect(symChecks[2]?.status).toBe("warn")
        }),
      ),
  )
})
