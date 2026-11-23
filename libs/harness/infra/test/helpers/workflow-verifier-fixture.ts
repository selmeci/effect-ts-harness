import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "@effect/vitest"
import { Cause, Effect, type Exit, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  NxProjectName,
  OwnedRelPath,
  PackageVerifyCommand,
  PlanSha256,
  SliceBranchName,
  StubSymbolKey,
  WaveIndex,
  WorkUnitId,
  WorkflowRunId,
} from "@harness/contract"
import { type SpanSample } from "@harness/gates"
import type { SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../../src/index.js"

export const runWithTestTracer = <A, E, R>(
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

export const withTempDir = <A, E, R>(
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

export const initGitRepo = (
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

export const makeStampHostIo = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): SyncHostIo => ({
  ...nodeSyncHostIo,
  getEnv: () => baseEnv,
})

export const makeSliceUnit = (
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

export const makePackageUnit = (overrides?: {
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

export const makeEpicPlan = (
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

export const writeExecutableScript = (binDir: string, name: string, jsBody: string): void => {
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, name)
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${jsBody}\n`, "utf8")
  chmodSync(scriptPath, 0o755)
}

export const waitForFilesExist = Effect.fnUntraced(function* (
  paths: ReadonlyArray<string>,
  maxAttempts = 200,
  intervalMs = 15,
) {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (paths.every((p) => existsSync(p))) {
      return true
    }
    yield* Effect.sleep(`${intervalMs} millis`)
  }
  return paths.every((p) => existsSync(p))
})

export const expectWorkspaceFsErrorExit = <A, E extends { readonly _tag: string }>(
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

export const decodeJsonLine = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      command: Schema.optional(Schema.String),
    }),
  ),
)
