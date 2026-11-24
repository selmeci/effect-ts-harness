import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { match } from "ts-pattern"
import { LocalDecisionModel, makeLocalDecisionModelLayer } from "../src/hook-fastpath.js"
import {
  appendHookTelemetryLite,
  findWorkspaceRootLite,
  type HookStdinReadResult,
  isIngestSnapshotUpToDateLite,
  readHookStdinCallback,
  resolveGitHeadStateLite,
  resolveHarnessStateDirLite,
  shouldSuppressLiveRepoTestSideEffectsLite,
  tryReadPreInvocationCacheLite,
} from "../src/hook-io.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../../../..")

const withTempDir = <A, E, R>(
  prefix: string,
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

const withMockStdin = <A, E, R>(
  use: (stream: PassThrough & { isTTY?: boolean }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
      stream.isTTY = false
      Object.defineProperty(process, "stdin", {
        value: stream,
        configurable: true,
        writable: true,
      })
      return stream
    }),
    use,
    (stream) =>
      Effect.sync(() => {
        if (!stream.destroyed) {
          stream.destroy()
        }
        if (originalDescriptor !== undefined) {
          Object.defineProperty(process, "stdin", originalDescriptor)
        }
      }),
  )
}

const runStdinCallback = (
  opts: { readonly timeoutMs: number; readonly maxBytes: number },
  drive: (stream: PassThrough & { isTTY?: boolean }) => void,
  stream: PassThrough & { isTTY?: boolean },
): Effect.Effect<HookStdinReadResult> =>
  Effect.callback<HookStdinReadResult>((resume) => {
    readHookStdinCallback(opts, (res) => {
      resume(Effect.succeed(res))
    })
    drive(stream)
  })

const writeFile = (filePath: string, content: string): void => {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

const withCapturedStderr = <A, E, R>(
  use: (chunks: Array<string>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const originalWrite = process.stderr.write.bind(process.stderr)
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const chunks: Array<string> = []
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      }
      return chunks
    }),
    use,
    () =>
      Effect.sync(() => {
        process.stderr.write = originalWrite
      }),
  )
}

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
  writeFile(join(dir, "README.md"), "hello\n")
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })
}

describe("hook-io lite helpers and lazy LocalDecisionModel", () => {
  it.effect(
    "findWorkspaceRootLite finds workspace root from nested subdir and falls back to fallbackRoot",
    () =>
      withTempDir("hook-io-wsroot-", (tempDir) =>
        Effect.sync(() => {
          const nested = join(repoRoot, "libs", "harness", "infra", "src")
          expect(findWorkspaceRootLite(nested)).toBe(repoRoot)

          const externalNested = join(tempDir, "a", "b")
          mkdirSync(externalNested, { recursive: true })
          expect(findWorkspaceRootLite(externalNested, repoRoot)).toBe(repoRoot)
          expect(findWorkspaceRootLite(externalNested)).toBe(externalNested)
        }),
      ),
  )

  it.effect(
    "resolveHarnessStateDirLite handles default, HARNESS_STATE_DIR, and HARNESS_WORKTREE_ID",
    () =>
      withTempDir("hook-io-state-", (tempDir) =>
        Effect.sync(() => {
          expect(resolveHarnessStateDirLite(tempDir, {})).toEqual(
            Option.some(join(tempDir, ".harness")),
          )

          expect(
            resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: ".custom-state" }),
          ).toEqual(Option.some(join(tempDir, ".custom-state")))
          const absOverride = join(tempDir, "nested", "state")
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: absOverride })).toEqual(
            Option.some(absOverride),
          )

          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: "." })).toEqual(
            Option.none(),
          )
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: tempDir })).toEqual(
            Option.none(),
          )
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: " .custom " })).toEqual(
            Option.none(),
          )
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: "bad\0dir" })).toEqual(
            Option.none(),
          )
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_STATE_DIR: "/" })).toEqual(
            Option.none(),
          )

          expect(
            resolveHarnessStateDirLite(tempDir, { HARNESS_WORKTREE_ID: "feat/my worktree" }),
          ).toEqual(Option.some(join(tempDir, ".harness", "worktrees", "feat_my_worktree")))
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_WORKTREE_ID: ".." })).toEqual(
            Option.none(),
          )
          expect(resolveHarnessStateDirLite(tempDir, { HARNESS_WORKTREE_ID: "." })).toEqual(
            Option.none(),
          )
        }),
      ),
  )

  it.effect(
    "resolveGitHeadStateLite resolves regular repo, detached HEAD, linked worktree commondir, and env overrides",
    () =>
      withTempDir("hook-io-git-", (tempDir) =>
        Effect.sync(() => {
          const regularRepo = join(tempDir, "regular")
          writeFile(join(regularRepo, ".git", "HEAD"), "ref: refs/heads/feature/x\n")
          writeFile(
            join(regularRepo, ".git", "refs", "heads", "feature", "x"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
          )
          expect(resolveGitHeadStateLite(regularRepo, {})).toEqual({
            gitBranch: "feature/x",
            headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          })

          expect(
            resolveGitHeadStateLite(regularRepo, {
              HARNESS_GIT_BRANCH: "override-branch",
              HARNESS_GIT_HEAD_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            }),
          ).toEqual({
            gitBranch: "override-branch",
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          })

          const detachedRepo = join(tempDir, "detached")
          writeFile(
            join(detachedRepo, ".git", "HEAD"),
            "cccccccccccccccccccccccccccccccccccccccc\n",
          )
          expect(resolveGitHeadStateLite(detachedRepo, {})).toEqual({
            gitBranch: null,
            headSha: "cccccccccccccccccccccccccccccccccccccccc",
          })

          const commonGitDir = join(tempDir, "common.git")
          const worktreeGitDir = join(commonGitDir, "worktrees", "wt-1")
          const worktreeRepo = join(tempDir, "wt-1")
          writeFile(
            join(commonGitDir, "packed-refs"),
            "# pack-refs with: peeled fully-peeled sorted\ndddddddddddddddddddddddddddddddddddddddd refs/heads/wt-branch\n",
          )
          writeFile(join(worktreeGitDir, "HEAD"), "ref: refs/heads/wt-branch\n")
          writeFile(join(worktreeGitDir, "commondir"), "../..\n")
          writeFile(join(worktreeRepo, ".git"), `gitdir: ${worktreeGitDir}\n`)

          expect(resolveGitHeadStateLite(worktreeRepo, {})).toEqual({
            gitBranch: "wt-branch",
            headSha: "dddddddddddddddddddddddddddddddddddddddd",
          })
        }),
      ),
  )

  it.effect(
    "isIngestSnapshotUpToDateLite checks matching SHA/branch, mismatched branch, malformed meta, and symlinked dir/files",
    () =>
      withTempDir("hook-io-ingest-", (tempDir) =>
        Effect.sync(() => {
          const sha = "1111111111111111111111111111111111111111"
          writeFile(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n")
          writeFile(join(tempDir, ".git", "refs", "heads", "main"), `${sha}\n`)

          // Missing snapshot
          writeFile(
            join(tempDir, ".harness", "graph-head.json"),
            JSON.stringify({ headSha: sha, gitBranch: "main" }),
          )
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Matching snapshot + meta
          writeFile(
            join(tempDir, ".harness", "graph-snapshot.json"),
            JSON.stringify({ nodes: [], edges: [] }),
          )
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(true)

          // Invalid / empty / non-schema graph-snapshot.json returns false (F-8.1a)
          writeFile(join(tempDir, ".harness", "graph-snapshot.json"), "")
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)
          writeFile(join(tempDir, ".harness", "graph-snapshot.json"), "{}")
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)
          writeFile(join(tempDir, ".harness", "graph-snapshot.json"), "{not-json")
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)
          writeFile(
            join(tempDir, ".harness", "graph-snapshot.json"),
            JSON.stringify({ nodes: [], edges: [] }),
          )

          // Stale SHA
          writeFile(
            join(tempDir, ".harness", "graph-head.json"),
            JSON.stringify({
              headSha: "2222222222222222222222222222222222222222",
              gitBranch: "main",
            }),
          )
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Mismatched gitBranch
          writeFile(
            join(tempDir, ".harness", "graph-head.json"),
            JSON.stringify({ headSha: sha, gitBranch: "other-branch" }),
          )
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Malformed graph-head.json
          writeFile(join(tempDir, ".harness", "graph-head.json"), "{not-json")
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Symlinked graph-head.json
          const targetMeta = join(tempDir, "outside-meta.json")
          writeFile(targetMeta, JSON.stringify({ headSha: sha, gitBranch: "main" }))
          rmSync(join(tempDir, ".harness", "graph-head.json"))
          symlinkSync(targetMeta, join(tempDir, ".harness", "graph-head.json"))
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Symlinked graph-snapshot.json
          rmSync(join(tempDir, ".harness", "graph-head.json"))
          writeFile(
            join(tempDir, ".harness", "graph-head.json"),
            JSON.stringify({ headSha: sha, gitBranch: "main" }),
          )
          const targetSnap = join(tempDir, "outside-snap.json")
          writeFile(targetSnap, "{}")
          rmSync(join(tempDir, ".harness", "graph-snapshot.json"))
          symlinkSync(targetSnap, join(tempDir, ".harness", "graph-snapshot.json"))
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)

          // Symlinked .harness directory
          const outsideHarness = join(tempDir, "outside-harness")
          writeFile(
            join(outsideHarness, "graph-head.json"),
            JSON.stringify({ headSha: sha, gitBranch: "main" }),
          )
          writeFile(join(outsideHarness, "graph-snapshot.json"), "{}")
          rmSync(join(tempDir, ".harness"), { recursive: true, force: true })
          symlinkSync(outsideHarness, join(tempDir, ".harness"))
          expect(isIngestSnapshotUpToDateLite(tempDir, {})).toBe(false)
        }),
      ),
  )

  it.effect(
    "appendHookTelemetryLite writes telemetry-log.jsonl and respects HARNESS_DISABLE_LIVE_TELEMETRY, HARNESS_TEST_ISOLATION, and HARNESS_STATE_DIR",
    () =>
      withTempDir("hook-io-telemetry-", (tempDir) =>
        Effect.sync(() => {
          const liveRepo = join(tempDir, "live-repo")
          const externalRepo = join(tempDir, "external-repo")
          mkdirSync(liveRepo, { recursive: true })
          mkdirSync(externalRepo, { recursive: true })

          // Suppressed under HARNESS_DISABLE_LIVE_TELEMETRY=1
          appendHookTelemetryLite({
            repoRoot: liveRepo,
            cliRepoRoot: liveRepo,
            env: { HARNESS_DISABLE_LIVE_TELEMETRY: "1" },
            surface: "hook",
            category: "guard",
            toolName: "Bash",
            outcome: "ok",
            durationMs: 12.4,
            detail: "suppressed",
          })
          expect(existsSync(join(liveRepo, ".harness", "telemetry-log.jsonl"))).toBe(false)

          // Suppressed under HARNESS_TEST_ISOLATION=1
          appendHookTelemetryLite({
            repoRoot: liveRepo,
            cliRepoRoot: liveRepo,
            env: { HARNESS_TEST_ISOLATION: "1" },
            surface: "hook",
            category: "guard",
            toolName: "Bash",
            outcome: "ok",
            durationMs: 3,
          })
          expect(existsSync(join(liveRepo, ".harness", "telemetry-log.jsonl"))).toBe(false)

          // Writes when HARNESS_STATE_DIR is explicitly set even if repoRoot === cliRepoRoot
          appendHookTelemetryLite({
            repoRoot: liveRepo,
            cliRepoRoot: liveRepo,
            env: { HARNESS_TEST_ISOLATION: "1", HARNESS_STATE_DIR: ".isolated-harness" },
            surface: "hook",
            category: "guard",
            toolName: "Read",
            outcome: "ok",
            durationMs: 2.1,
          })
          expect(existsSync(join(liveRepo, ".isolated-harness", "telemetry-log.jsonl"))).toBe(true)

          // Writes cleanly when repoRoot !== cliRepoRoot
          appendHookTelemetryLite({
            repoRoot: externalRepo,
            cliRepoRoot: liveRepo,
            env: { HARNESS_DISABLE_LIVE_TELEMETRY: "1" },
            surface: "cli",
            category: "lifecycle",
            toolName: "session",
            outcome: "ok",
            durationMs: 4.8,
            detail: "cache=hit",
          })
          const logPath = join(externalRepo, ".harness", "telemetry-log.jsonl")
          expect(existsSync(logPath)).toBe(true)
          const lines = readFileSync(logPath, "utf8").trim().split("\n")
          expect(lines).toHaveLength(1)
          const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
          expect(parsed.surface).toBe("cli")
          expect(parsed.category).toBe("lifecycle")
          expect(parsed.toolName).toBe("session")
          expect(parsed.outcome).toBe("ok")
          expect(parsed.durationMs).toBe(5)
          expect(parsed.detail).toBe("cache=hit")
        }),
      ),
  )

  it.effect(
    "readHookStdinCallback handles isTTY, readableEnded, destroyed, chunked Ok, maxBytes+1, timeoutMs, error, close, and cleans up listeners",
    () =>
      Effect.gen(function* () {
        // 1. isTTY === true
        const ttyRes = yield* withMockStdin((stream) =>
          Effect.callback<HookStdinReadResult>((resume) => {
            stream.isTTY = true
            readHookStdinCallback({ timeoutMs: 200, maxBytes: 64 }, (res) => {
              resume(Effect.succeed(res))
            })
          }),
        )
        expect(ttyRes).toEqual({ _tag: "Ok", text: "" })

        // 2. readableEnded === true
        const endedRes = yield* withMockStdin((stream) =>
          Effect.callback<HookStdinReadResult>((resume) => {
            stream.end()
            stream.resume()
            queueMicrotask(() => {
              readHookStdinCallback({ timeoutMs: 200, maxBytes: 64 }, (res) => {
                resume(Effect.succeed(res))
              })
            })
          }),
        )
        expect(endedRes).toEqual({ _tag: "Ok", text: "" })

        // 3. destroyed === true
        const destroyedRes = yield* withMockStdin((stream) =>
          Effect.callback<HookStdinReadResult>((resume) => {
            stream.destroy()
            readHookStdinCallback({ timeoutMs: 200, maxBytes: 64 }, (res) => {
              resume(Effect.succeed(res))
            })
          }),
        )
        expect(destroyedRes).toEqual({
          _tag: "Failed",
          reason: "Stdin stream is already destroyed",
        })

        // 4. Chunked Ok + listeners cleaned up
        yield* withMockStdin((stream) =>
          Effect.gen(function* () {
            const res = yield* runStdinCallback(
              { timeoutMs: 200, maxBytes: 64 },
              (s) => {
                s.write("hello ")
                s.write("world")
                s.end()
              },
              stream,
            )
            expect(res).toEqual({ _tag: "Ok", text: "hello world" })
            expect(stream.listenerCount("data")).toBe(0)
            expect(stream.listenerCount("end")).toBe(0)
            expect(stream.listenerCount("close")).toBe(0)
            expect(stream.listenerCount("error")).toBe(0)
          }),
        )

        // 5. maxBytes + 1 fails and destroys stream
        yield* withMockStdin((stream) =>
          Effect.gen(function* () {
            const res = yield* runStdinCallback(
              { timeoutMs: 200, maxBytes: 5 },
              (s) => {
                s.write("123456")
              },
              stream,
            )
            expect(res._tag).toBe("Failed")
            expect(stream.destroyed).toBe(true)
            expect(stream.listenerCount("data")).toBe(0)
            expect(stream.listenerCount("error")).toBe(0)
          }),
        )

        // 6. timeoutMs fails and destroys stream
        yield* withMockStdin((stream) =>
          Effect.gen(function* () {
            const res = yield* runStdinCallback({ timeoutMs: 25, maxBytes: 64 }, () => {}, stream)
            expect(res._tag).toBe("Failed")
            expect(stream.destroyed).toBe(true)
            expect(stream.listenerCount("data")).toBe(0)
            expect(stream.listenerCount("close")).toBe(0)
          }),
        )

        // 7. error event settles Failed
        yield* withMockStdin((stream) =>
          Effect.gen(function* () {
            const res = yield* runStdinCallback(
              { timeoutMs: 200, maxBytes: 64 },
              (s) => {
                s.emit("error", new Error("boom"))
              },
              stream,
            )
            expect(res).toEqual({ _tag: "Failed", reason: "Stdin stream error: boom" })
            expect(stream.listenerCount("error")).toBe(0)
          }),
        )

        // 8. premature close settles Failed before end (F-9.3)
        yield* withMockStdin((stream) =>
          Effect.gen(function* () {
            const res = yield* runStdinCallback(
              { timeoutMs: 200, maxBytes: 64 },
              (s) => {
                s.write("partial")
                s.emit("close")
              },
              stream,
            )
            expect(res).toEqual({
              _tag: "Failed",
              reason: "Stdin stream closed prematurely before end",
            })
            expect(stream.listenerCount("close")).toBe(0)
          }),
        )
      }),
  )

  it.effect(
    "tryReadPreInvocationCacheLite handles hits, post-hit edit invalidation, future/expired TTL, cluster.yaml, malformed JSON, symlinks, HARNESS_REQUIRE_OLLAMA=1, and OMNIGRAPH_URL",
    () =>
      withTempDir("hook-io-cache-", (tempDir) =>
        Effect.sync(() => {
          const workRepo = join(tempDir, "work-repo")
          const cliRepo = repoRoot
          mkdirSync(workRepo, { recursive: true })
          initGitRepo(workRepo)

          const cachePath = join(workRepo, ".harness", "session-preinvocation-cache.json")
          const writeCache = (overrides: Record<string, unknown>) => {
            writeFile(
              cachePath,
              JSON.stringify({
                version: "session-preinvocation-v1",
                fingerprint: "0".repeat(64),
                recordedAtMs: Date.now(),
                ollamaReady: false,
                ollamaProbed: false,
                injectSteps: ["step-1"],
                stderr: "cached-stderr",
                ...overrides,
              }),
            )
          }

          // 1. Fingerprint mismatch returns Miss with precomputed fingerprint
          writeCache({})
          const firstMiss = tryReadPreInvocationCacheLite({
            repoRoot: workRepo,
            cliRepoRoot: cliRepo,
            env: {},
          })
          const fpOpt = match(firstMiss)
            .with({ _tag: "Miss" }, ({ fingerprint }) => fingerprint)
            .with({ _tag: "Hit" }, () => {
              throw new Error("expected Miss")
            })
            .exhaustive()
          expect(Option.isSome(fpOpt)).toBe(true)
          const fp = Option.getOrThrow(fpOpt)
          expect(fp).toMatch(/^[0-9a-f]{64}$/)

          // 2. Valid cache hit with matching fingerprint
          writeCache({ fingerprint: fp })
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({
            _tag: "Hit",
            stdout: JSON.stringify({ injectSteps: ["step-1"] }),
            stderr: "cached-stderr",
          })

          // 3. Routine tracked edit keeps cache hit; .env edit invalidates cache and returns updated fingerprint
          writeFile(join(workRepo, "README.md"), "modified\n")
          const editedHit = tryReadPreInvocationCacheLite({
            repoRoot: workRepo,
            cliRepoRoot: cliRepo,
            env: {},
          })
          expect(editedHit._tag).toBe("Hit")
          writeFile(join(workRepo, "README.md"), "hello\n")

          writeFile(join(workRepo, ".env"), "FOO=bar\n")
          const envMiss = tryReadPreInvocationCacheLite({
            repoRoot: workRepo,
            cliRepoRoot: cliRepo,
            env: {},
          })
          expect(envMiss._tag).toBe("Miss")
          rmSync(join(workRepo, ".env"), { force: true })

          // 4. Whitespace-only OMNIGRAPH_URL does not trigger requireOllama on external repo
          const wsEnv = { OMNIGRAPH_URL: "   " }
          const wsMiss = tryReadPreInvocationCacheLite({
            repoRoot: workRepo,
            cliRepoRoot: cliRepo,
            env: wsEnv,
          })
          const wsFp = Option.getOrThrow(
            match(wsMiss)
              .with({ _tag: "Miss" }, ({ fingerprint }) => fingerprint)
              .with({ _tag: "Hit" }, () => {
                throw new Error("expected Miss for different OMNIGRAPH_URL env")
              })
              .exhaustive(),
          )
          writeCache({ fingerprint: wsFp })
          expect(
            tryReadPreInvocationCacheLite({
              repoRoot: workRepo,
              cliRepoRoot: cliRepo,
              env: wsEnv,
            })._tag,
          ).toBe("Hit")

          // Restore cache with `fp` for remaining checks
          writeCache({ fingerprint: fp })

          // 5. Custom non-default OMNIGRAPH_URL triggers requireOllama miss when ollamaProbed=false
          expect(
            tryReadPreInvocationCacheLite({
              repoRoot: workRepo,
              cliRepoRoot: cliRepo,
              env: { OMNIGRAPH_URL: "http://127.0.0.1:9090" },
            }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          // 6. cluster.yaml present + ollamaProbed: false triggers Miss
          writeFile(join(workRepo, "libs", "harness", "graph", "cluster.yaml"), "nodes: []\n")
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })
          rmSync(join(workRepo, "libs"), { recursive: true, force: true })

          // 7. HARNESS_REQUIRE_OLLAMA=1 forces Miss
          expect(
            tryReadPreInvocationCacheLite({
              repoRoot: workRepo,
              cliRepoRoot: cliRepo,
              env: { HARNESS_REQUIRE_OLLAMA: "1" },
            }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          // 8. Expired TTL and future recordedAtMs (< 0 ageMs) both return Miss
          writeCache({ fingerprint: fp, recordedAtMs: Date.now() - 400_000 })
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          writeCache({ fingerprint: fp, recordedAtMs: Date.now() + 60_000 })
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          // 9. Malformed cache JSON returns Miss
          writeFile(cachePath, "{not-valid-json")
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          // 10. Symlinked cache file is rejected
          const outsideCache = join(tempDir, "outside-cache.json")
          writeFile(
            outsideCache,
            JSON.stringify({
              version: "session-preinvocation-v1",
              fingerprint: fp,
              recordedAtMs: Date.now(),
              ollamaReady: false,
              ollamaProbed: false,
              injectSteps: ["step-1"],
              stderr: "cached-stderr",
            }),
          )
          rmSync(cachePath)
          symlinkSync(outsideCache, cachePath)
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })

          // 11. Symlinked .harness directory is rejected
          const outsideHarness = join(tempDir, "outside-harness")
          writeFile(
            join(outsideHarness, "session-preinvocation-cache.json"),
            readFileSync(outsideCache, "utf8"),
          )
          rmSync(join(workRepo, ".harness"), { recursive: true, force: true })
          symlinkSync(outsideHarness, join(workRepo, ".harness"))
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: workRepo, cliRepoRoot: cliRepo, env: {} }),
          ).toEqual({ _tag: "Miss", fingerprint: Option.none() })
        }),
      ),
  )

  it("importing @harness/infra/hook-fastpath and building LocalDecisionModel never loads @effect/ai-typesafe", () => {
    const loaderSrc = `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "@effect/ai-typesafe" || specifier.startsWith("@effect/ai-typesafe/")) {
          throw new Error("FORBIDDEN_EAGER_IMPORT: " + specifier + " from " + (context.parentURL ?? ""))
        }
        const res = await nextResolve(specifier, context)
        if (res.url.includes("/@effect/ai-typesafe/")) {
          throw new Error("FORBIDDEN_EAGER_URL: " + res.url)
        }
        return res
      }
    `
    const script = `
      import { register } from "node:module"
      import { Effect, Layer } from "effect"
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSrc)}))
      const mod = await import("@harness/infra/hook-fastpath")
      if (typeof mod.makeLocalDecisionModelLayer !== "function" || !mod.LocalDecisionModel) {
        throw new Error("MISSING_EXPORTS")
      }
      await Effect.runPromise(Effect.scoped(Layer.build(mod.LocalDecisionModel)))
      process.stdout.write("BUILD_LAZY_OK")
    `
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        join(repoRoot, "tools/node-ts-resolver.mjs"),
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(out).toContain("BUILD_LAZY_OK")
  })

  it("missing @effect/ai-typesafe during DecisionModel.decide surfaces as AiError rather than defect", () => {
    const loaderSrc = `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "@effect/ai-typesafe" || specifier.startsWith("@effect/ai-typesafe/")) {
          throw new Error("SIMULATED_MISSING_MODULE")
        }
        return nextResolve(specifier, context)
      }
    `
    const script = `
      import { register } from "node:module"
      import { Effect, Result, Schema } from "effect"
      import * as Decision from "effect/ai/Decision"
      import * as DecisionModel from "effect/ai/DecisionModel"
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSrc)}))
      const { LocalDecisionModel } = await import("@harness/infra/hook-fastpath")
      const TestDecision = Decision.make({
        input: Schema.Struct({ ok: Schema.Boolean }),
        decisions: { check: Decision.probability({ instructions: "ok?" }) },
      })
      const res = await Effect.runPromise(
        Effect.result(
          DecisionModel.decide(TestDecision, { input: { ok: true } }).pipe(Effect.provide(LocalDecisionModel)),
        ),
      )
      if (res._tag !== "Failure" || res.failure._tag !== "AiError") {
        throw new Error("UNEXPECTED_RESULT: " + JSON.stringify(res))
      }
      process.stdout.write("AI_ERROR_OK")
    `
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        join(repoRoot, "tools/node-ts-resolver.mjs"),
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(out).toContain("AI_ERROR_OK")
  })

  it.effect(
    "makeLocalDecisionModelLayer lazily loads @effect/ai-typesafe on decide, caches delegate across calls, and decodes /v1/systemone",
    () =>
      Effect.gen(function* () {
        expect(Layer.isLayer(LocalDecisionModel)).toBe(true)

        const requests: Array<{
          readonly url: string
          readonly method: string
          readonly body: string
        }> = []
        const mockHttpClient = HttpClient.make((req, url) => {
          const bodyText = match(req.body)
            .with({ _tag: "Uint8Array" }, (b) => b.text ?? new TextDecoder().decode(b.body))
            .otherwise(() => "")
          requests.push({ url: url.toString(), method: req.method, body: bodyText })
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(
                JSON.stringify({
                  model: "clef-flash",
                  answers: {
                    check: { type: "noul", noul: 0.85 },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
          )
        })

        const layer = makeLocalDecisionModelLayer({
          apiUrl: "http://127.0.0.1:11434/v1",
          model: "clef-flash",
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, mockHttpClient)))

        const TestDecision = Decision.make({
          input: Schema.Struct({ ok: Schema.Boolean }),
          decisions: {
            check: Decision.probability({ instructions: "Is lazy model working?" }),
          },
        })

        const firstOutcome = yield* DecisionModel.decide(TestDecision, {
          input: { ok: true },
        }).pipe(Effect.provide(layer))
        expect(firstOutcome.answers.check.probability).toBeCloseTo(0.85, 4)

        // Second invocation reuses single-flight cached delegate cleanly
        const secondResult = yield* Effect.result(
          DecisionModel.decide(TestDecision, { input: { ok: true } }),
        ).pipe(Effect.provide(layer))
        expect(Result.isSuccess(secondResult)).toBe(true)
        expect(requests).toHaveLength(2)
        expect(requests[0]?.url).toBe("http://127.0.0.1:11434/v1/systemone")
        expect(requests[0]?.method).toBe("POST")
        expect(requests[0]?.body).toContain("clef-flash")
      }),
  )

  it.effect(
    "makeLocalDecisionModelLayer single-flights concurrent decide calls and retries after transient loadModule failure (F-7.1a)",
    () =>
      Effect.gen(function* () {
        const makeMockClient = () =>
          HttpClient.make((req) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({
                    model: "clef-flash",
                    answers: {
                      check: { type: "noul", noul: 0.75 },
                    },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          )

        const TestDecision = Decision.make({
          input: Schema.Struct({ ok: Schema.Boolean }),
          decisions: {
            check: Decision.probability({ instructions: "Check?" }),
          },
        })

        // (a) 3 concurrent calls invoke loadModule only once
        let concurrentLoadCount = 0
        const concurrentLayer = makeLocalDecisionModelLayer({
          apiUrl: "http://127.0.0.1:11434/v1",
          model: "clef-flash",
          loadModule: () => {
            concurrentLoadCount += 1
            return import("@effect/ai-typesafe")
          },
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient())))

        const concurrentResults = yield* Effect.all(
          [
            DecisionModel.decide(TestDecision, { input: { ok: true } }),
            DecisionModel.decide(TestDecision, { input: { ok: true } }),
            DecisionModel.decide(TestDecision, { input: { ok: true } }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(concurrentLayer))
        expect(concurrentLoadCount).toBe(1)
        expect(concurrentResults).toHaveLength(3)

        // (b) First call failing returns AiError, second call retries and succeeds
        let attempt = 0
        const retryLayer = makeLocalDecisionModelLayer({
          apiUrl: "http://127.0.0.1:11434/v1",
          model: "clef-flash",
          loadModule: () => {
            attempt += 1
            return attempt === 1
              ? Promise.reject(new Error("transient"))
              : import("@effect/ai-typesafe")
          },
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient())))

        const firstRes = yield* Effect.result(
          DecisionModel.decide(TestDecision, { input: { ok: true } }),
        ).pipe(Effect.provide(retryLayer))
        match(firstRes)
          .with({ _tag: "Failure" }, ({ failure }) => {
            expect(failure._tag).toBe("AiError")
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected first call to fail")
          })
          .exhaustive()

        const secondRes = yield* Effect.result(
          DecisionModel.decide(TestDecision, { input: { ok: true } }),
        ).pipe(Effect.provide(retryLayer))
        expect(secondRes._tag).toBe("Success")
        expect(attempt).toBe(2)
      }),
  )

  it.effect(
    "logs stderr warnings on telemetry write failure (F-9.1) and unexpected git HEAD read failure (F-9.2)",
    () =>
      withTempDir("hook-io-warnings-", (tempDir) =>
        withCapturedStderr((stderrChunks) =>
          Effect.sync(() => {
            // F-9.1: blocked telemetry target (.harness is a regular file)
            const blockedRepo = join(tempDir, "blocked-telemetry")
            writeFile(join(blockedRepo, ".harness"), "blocking-file")
            appendHookTelemetryLite({
              repoRoot: blockedRepo,
              cliRepoRoot: join(tempDir, "other-cli"),
              env: {},
              surface: "hook",
              category: "guard",
              toolName: "Bash",
              outcome: "ok",
              durationMs: 1,
            })
            expect(stderrChunks.join("")).toContain(
              "[harness:hook-io] Warning: failed to append hook telemetry:",
            )

            // F-9.2: .git exists and .git/HEAD is a directory (EISDIR)
            const brokenGitRepo = join(tempDir, "broken-git")
            mkdirSync(join(brokenGitRepo, ".git", "HEAD"), { recursive: true })
            const headRes = resolveGitHeadStateLite(brokenGitRepo, {})
            expect(headRes).toEqual({ gitBranch: null, headSha: null })
            expect(stderrChunks.join("")).toContain(
              "[harness:hook-io] Warning: failed to read git HEAD state:",
            )
          }),
        ),
      ),
  )

  it.effect(
    "keeps session cache hit across .nx and ignored source writes while invalidating on .harness metadata changes",
    () =>
      withTempDir("hook-io-nx-", (dir) =>
        Effect.sync(() => {
          initGitRepo(dir)
          writeFile(join(dir, ".gitignore"), ".nx/\nlibs/demo/src/ignored.ts\n")
          execFileSync("git", ["add", ".gitignore"], { cwd: dir, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "add gitignore"], { cwd: dir, stdio: "ignore" })

          const head = resolveGitHeadStateLite(dir, {})
          writeFile(join(dir, ".harness", "graph-head.json"), JSON.stringify(head))
          writeFile(join(dir, ".harness", "graph-snapshot.json"), "{}")
          const cachePath = join(dir, ".harness", "session-preinvocation-cache.json")
          writeFile(
            cachePath,
            JSON.stringify({
              version: "session-preinvocation-v1",
              fingerprint: "0".repeat(64),
              recordedAtMs: Date.now(),
              ollamaReady: true,
              ollamaProbed: true,
              injectSteps: ["step1"],
              stderr: "",
            }),
          )

          const miss = tryReadPreInvocationCacheLite({
            repoRoot: dir,
            cliRepoRoot: dir,
            env: {},
          })
          const fpOpt = match(miss)
            .with({ _tag: "Miss" }, ({ fingerprint }) => fingerprint)
            .with({ _tag: "Hit" }, () => Option.none<string>())
            .exhaustive()
          const cleanFp = Option.getOrThrow(fpOpt)

          writeFile(
            cachePath,
            JSON.stringify({
              version: "session-preinvocation-v1",
              fingerprint: cleanFp,
              recordedAtMs: Date.now(),
              ollamaReady: true,
              ollamaProbed: true,
              injectSteps: ["step1"],
              stderr: "",
            }),
          )

          writeFile(join(dir, ".nx", "cache", "terminalOutputs", "chunk-1"), "x".repeat(4096))
          const hitAfterNx = tryReadPreInvocationCacheLite({
            repoRoot: dir,
            cliRepoRoot: dir,
            env: {},
          })
          expect(hitAfterNx._tag).toBe("Hit")

          writeFile(join(dir, "libs", "demo", "src", "ignored.ts"), "export const x = 42\n")
          const hitAfterIgnoredSrc = tryReadPreInvocationCacheLite({
            repoRoot: dir,
            cliRepoRoot: dir,
            env: {},
          })
          expect(hitAfterIgnoredSrc._tag).toBe("Hit")

          writeFile(join(dir, ".harness", "verify-stamp.json"), JSON.stringify({ ok: true }))
          const missAfterHarnessState = tryReadPreInvocationCacheLite({
            repoRoot: dir,
            cliRepoRoot: dir,
            env: {},
          })
          expect(missAfterHarnessState._tag).toBe("Miss")
          const nextFp = Option.getOrThrow(
            match(missAfterHarnessState)
              .with({ _tag: "Miss" }, ({ fingerprint }) => fingerprint)
              .with({ _tag: "Hit" }, () => Option.none<string>())
              .exhaustive(),
          )
          expect(nextFp).not.toBe(cleanFp)

          // Degraded cache entry hits within 30s and expires after 30s
          writeFile(
            cachePath,
            JSON.stringify({
              version: "session-preinvocation-v1",
              fingerprint: nextFp,
              recordedAtMs: Date.now() - 10_000,
              ollamaReady: true,
              ollamaProbed: true,
              degraded: true,
              injectSteps: ["degraded-step"],
              stderr: "",
            }),
          )
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: dir, cliRepoRoot: dir, env: {} })._tag,
          ).toBe("Hit")

          writeFile(
            cachePath,
            JSON.stringify({
              version: "session-preinvocation-v1",
              fingerprint: nextFp,
              recordedAtMs: Date.now() - 35_000,
              ollamaReady: true,
              ollamaProbed: true,
              degraded: true,
              injectSteps: ["degraded-step"],
              stderr: "",
            }),
          )
          expect(
            tryReadPreInvocationCacheLite({ repoRoot: dir, cliRepoRoot: dir, env: {} })._tag,
          ).toBe("Miss")

          // VITEST / NODE_ENV=test live-repo suppression covers subdirectories while allowing temp repos or explicit HARNESS_STATE_DIR
          expect(
            shouldSuppressLiveRepoTestSideEffectsLite(
              join(repoRoot, "apps", "harness-mcp"),
              repoRoot,
              { VITEST: "true" },
            ),
          ).toBe(true)
          expect(
            shouldSuppressLiveRepoTestSideEffectsLite(repoRoot, repoRoot, { NODE_ENV: "test" }),
          ).toBe(true)
          expect(shouldSuppressLiveRepoTestSideEffectsLite(dir, repoRoot, { VITEST: "true" })).toBe(
            false,
          )
          expect(
            shouldSuppressLiveRepoTestSideEffectsLite(repoRoot, repoRoot, {
              VITEST: "true",
              HARNESS_STATE_DIR: "/tmp/custom-state",
            }),
          ).toBe(false)
        }),
      ),
  )
})
