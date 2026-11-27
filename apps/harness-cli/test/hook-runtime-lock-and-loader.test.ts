import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"
import {
  buildHookRuntimeSnapshot,
  HarnessHookRuntime,
  swapStagedDirectoryAtomic,
} from "../src/commands/hook-runtime-loader.js"
import { withHookRuntimeBuildLock } from "../src/commands/hook-runtime-lock.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const RESOLVER_PATH = join(REAL_REPO_ROOT, "tools", "node-ts-resolver.mjs")

const tempDirs: Array<string> = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const copyMinimalRuntimeSources = (dir: string): void => {
  const packages: ReadonlyArray<string> = [
    "libs/harness/contract",
    "libs/harness/service",
    "libs/harness/gates",
    "libs/harness/decision",
    "libs/harness/infra",
    "libs/harness/graph",
    "libs/harness/ingest",
    "apps/harness-cli",
  ]
  for (const pkgRel of packages) {
    const srcFrom = join(REAL_REPO_ROOT, pkgRel, "src")
    const srcTo = join(dir, pkgRel, "src")
    mkdirSync(join(dir, pkgRel), { recursive: true })
    nodeSyncHostIo.execFileSync("cp", ["-r", srcFrom, srcTo])
    const pkgJsonFrom = join(REAL_REPO_ROOT, pkgRel, "package.json")
    if (existsSync(pkgJsonFrom)) {
      nodeSyncHostIo.execFileSync("cp", [pkgJsonFrom, join(dir, pkgRel, "package.json")])
    }
  }
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"))
}

const writeParityFixtureRepo = (
  dir: string,
  options?: {
    readonly omitPolicyFromHashes?: boolean
    readonly corruptManifest?: boolean
    readonly packageMapOverride?: Readonly<Record<string, string>>
    readonly extraFileHashes?: Readonly<Record<string, string>>
    readonly tamperPolicyBody?: boolean
  },
): {
  readonly harnessDir: string
  readonly runtimeDir: string
  readonly currentDir: string
  readonly manifestPath: string
  readonly liveEntryPath: string
} => {
  const liveEntryPath = join(dir, "apps", "harness-cli", "src", "hook-entry.ts")
  mkdirSync(join(dir, "apps", "harness-cli", "src"), { recursive: true })
  writeFileSync(liveEntryPath, 'process.stdout.write("LIVE_SOURCE_FALLBACK\\n")\n', "utf8")

  const harnessDir = join(dir, ".harness")
  const runtimeDir = join(harnessDir, "hook-runtime")
  const currentDir = join(runtimeDir, "current")
  const entryRel = "apps/harness-cli/src/hook-entry.js"
  const policyRel = "libs/harness/gates/src/policy.js"

  mkdirSync(join(currentDir, "apps", "harness-cli", "src"), { recursive: true })
  mkdirSync(join(currentDir, "libs", "harness", "gates", "src"), { recursive: true })

  const entryBody = 'process.stdout.write("SNAPSHOT_LOADED\\n")\n'
  const policyBody = "export const policyLoaded = true\n"
  writeFileSync(join(currentDir, "package.json"), '{"type":"module"}\n', "utf8")
  writeFileSync(join(currentDir, entryRel), entryBody, "utf8")
  writeFileSync(
    join(currentDir, policyRel),
    options?.tamperPolicyBody ? `${policyBody}// tampered\n` : policyBody,
    "utf8",
  )

  const fileHashes: Record<string, string> = {
    [entryRel]: sha256Hex(entryBody),
    ...(options?.omitPolicyFromHashes === true ? {} : { [policyRel]: sha256Hex(policyBody) }),
    ...options?.extraFileHashes,
  }

  const manifestPath = join(currentDir, "manifest.json")
  if (options?.corruptManifest === true) {
    writeFileSync(manifestPath, "{not-valid-json", "utf8")
  } else {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          builtAt: new Date().toISOString(),
          entryRel,
          packageMap: options?.packageMapOverride ?? { "@harness/gates/policy": policyRel },
          fileHashes,
        },
        null,
        2,
      ),
      "utf8",
    )
  }

  return { harnessDir, runtimeDir, currentDir, manifestPath, liveEntryPath }
}

const runResolverProbe = (liveEntryPath: string): string => {
  const proc = spawnSync(process.execPath, ["--import", RESOLVER_PATH, liveEntryPath], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_TEST_ISOLATION: "1" },
  })
  expect(proc.status).toBe(0)
  return proc.stdout.trim()
}

describe("SPEC-0037 hook-runtime-lock (F-9.1, F-9.2, F-9.3, F-11.1)", () => {
  it("acquires, returns fn result, and cleans up .build.lock on both success and failure", () => {
    const dir = makeTempDir("hook-lock-basic-")
    const lockPath = join(dir, ".build.lock")

    const okRes = withHookRuntimeBuildLock(dir, () => {
      expect(existsSync(lockPath)).toBe(true)
      return Result.succeed("ok-value")
    })
    expect(okRes).toEqual(Result.succeed("ok-value"))
    expect(existsSync(lockPath)).toBe(false)

    const failRes = withHookRuntimeBuildLock(dir, () => Result.fail("fn-failed"))
    expect(failRes).toEqual(Result.fail("fn-failed"))
    expect(existsSync(lockPath)).toBe(false)
  })

  it("F-9.3: NEVER steals a lock held by a live PID even when createdAtMs exceeds 60s", () => {
    const dir = makeTempDir("hook-lock-live-pid-")
    const lockPath = join(dir, ".build.lock")
    const originalPayload = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now() - 120_000,
      nonce: "live-old-nonce",
    })
    writeFileSync(lockPath, originalPayload, "utf8")

    let fnCalled = false
    const res = withHookRuntimeBuildLock(
      dir,
      () => {
        fnCalled = true
        return Result.succeed("should-not-run")
      },
      { maxWaitMs: 120, pollMs: 20 },
    )

    expect(fnCalled).toBe(false)
    expect(Result.isFailure(res)).toBe(true)
    match(res)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("Timed out waiting for hook-runtime build lock")
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected timeout failure"))
      .exhaustive()
    expect(readFileSync(lockPath, "utf8")).toBe(originalPayload)
  })

  it("steals stale lock held by a dead PID and completes", () => {
    const dir = makeTempDir("hook-lock-dead-pid-")
    const lockPath = join(dir, ".build.lock")
    const deadChild = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" })
    expect(deadChild.pid).toBeDefined()

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadChild.pid,
        createdAtMs: Date.now(),
        nonce: "dead-owner",
      }),
      "utf8",
    )

    const res = withHookRuntimeBuildLock(dir, () => Result.succeed("acquired-after-dead-pid"), {
      maxWaitMs: 500,
      pollMs: 20,
    })
    expect(res).toEqual(Result.succeed("acquired-after-dead-pid"))
    expect(existsSync(lockPath)).toBe(false)
  })

  it("enforces corrupt lock grace window (<= 500ms waits/times out, > 500ms steals)", () => {
    const dir = makeTempDir("hook-lock-corrupt-")
    const lockPath = join(dir, ".build.lock")

    // Fresh corrupt lock within 500ms grace window must not be stolen
    writeFileSync(lockPath, "{corrupt-lock", "utf8")
    let fnCalled = false
    const freshRes = withHookRuntimeBuildLock(
      dir,
      () => {
        fnCalled = true
        return Result.succeed("unexpected")
      },
      { maxWaitMs: 120, pollMs: 20 },
    )
    expect(fnCalled).toBe(false)
    match(freshRes)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("Timed out waiting for hook-runtime build lock")
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected corrupt-lock grace timeout"))
      .exhaustive()

    // Backdated corrupt lock (> 500ms) is treated as stale and reclaimed
    const past = new Date(Date.now() - 2_000)
    utimesSync(lockPath, past, past)
    const staleRes = withHookRuntimeBuildLock(dir, () => Result.succeed("reclaimed-corrupt"), {
      maxWaitMs: 500,
      pollMs: 20,
    })
    expect(staleRes).toEqual(Result.succeed("reclaimed-corrupt"))
    expect(existsSync(lockPath)).toBe(false)
  })

  it("F-9.1: surfaces last stale-lock unlink failure when retries exhaust", () => {
    const dir = makeTempDir("hook-lock-unlink-err-")
    const lockPath = join(dir, ".build.lock")
    const deadChild = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" })
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadChild.pid, createdAtMs: Date.now(), nonce: "stale" }),
      "utf8",
    )

    const origUnlink = nodeSyncHostIo.unlinkSync.bind(nodeSyncHostIo)
    vi.spyOn(nodeSyncHostIo, "unlinkSync").mockImplementation((target) => {
      if (target === lockPath) {
        throw new Error("EACCES: permission denied unlinking stale lock")
      }
      origUnlink(target)
    })

    const res = withHookRuntimeBuildLock(dir, () => Result.succeed("never"), {
      maxWaitMs: 120,
      pollMs: 20,
    })
    match(res)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toContain("Timed out waiting for hook-runtime build lock")
        expect(failure).toContain("EACCES: permission denied unlinking stale lock")
      })
      .with({ _tag: "Success" }, () => expect.unreachable("Expected timeout with unlink error"))
      .exhaustive()
  })

  it("F-9.2: logs stderr warning on release when lock payload has mismatched nonce or invalid payload", () => {
    const dir = makeTempDir("hook-lock-nonce-mismatch-")
    const lockPath = join(dir, ".build.lock")
    const stderrChunks: Array<string> = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })

    const mismatchPayload = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      nonce: "other-owner-nonce",
    })
    const res1 = withHookRuntimeBuildLock(dir, () => {
      writeFileSync(lockPath, mismatchPayload, "utf8")
      return Result.succeed("done-1")
    })
    expect(res1).toEqual(Result.succeed("done-1"))
    expect(existsSync(lockPath)).toBe(true)
    expect(stderrChunks.join("")).toContain("[harness:hook-runtime-lock] Warning:")
    expect(stderrChunks.join("")).toContain("nonce mismatch")

    rmSync(lockPath, { force: true })
    stderrChunks.length = 0

    const res2 = withHookRuntimeBuildLock(dir, () => {
      writeFileSync(lockPath, "corrupted-during-hold", "utf8")
      return Result.succeed("done-2")
    })
    expect(res2).toEqual(Result.succeed("done-2"))
    expect(existsSync(lockPath)).toBe(true)
    expect(stderrChunks.join("")).toContain("[harness:hook-runtime-lock] Warning:")
    expect(stderrChunks.join("")).toContain("nonce mismatch")
  })

  it("retries exclusive acquisition until contender releases the lock", () => {
    const dir = makeTempDir("hook-lock-wait-")
    const lockPath = join(dir, ".build.lock")
    const origTryWrite = nodeSyncHostIo.tryWriteExclusiveTextSync.bind(nodeSyncHostIo)
    let attempts = 0
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), nonce: "holder" }),
      "utf8",
    )
    vi.spyOn(nodeSyncHostIo, "tryWriteExclusiveTextSync").mockImplementation((path, content) => {
      attempts += 1
      if (attempts === 3 && path === lockPath) {
        rmSync(lockPath, { force: true })
      }
      return origTryWrite(path, content)
    })

    const res = withHookRuntimeBuildLock(dir, () => Result.succeed("acquired-on-retry"), {
      maxWaitMs: 1_000,
      pollMs: 15,
    })
    expect(attempts).toBe(3)
    expect(res).toEqual(Result.succeed("acquired-on-retry"))
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe("SPEC-0037 hook-runtime-loader rollback & cross-parity (F-7.1, F-12.1, F-14.3)", () => {
  it.effect(
    "F-12.1 & F-7.1: restores current on swap failure and reports both primary and rollback errors if rollback also fails",
    () =>
      Effect.gen(function* () {
        const dir = makeTempDir("hook-loader-rollback-")
        copyMinimalRuntimeSources(dir)

        const initial = buildHookRuntimeSnapshot(dir)
        expect(initial._tag).toBe("Built")
        const currentDir = join(dir, ".harness", "hook-runtime", "current")
        const manifestBefore = readFileSync(join(currentDir, "manifest.json"), "utf8")

        // 1. Primary staging -> current fails, rollback .prev-* -> current succeeds
        const origRename = nodeSyncHostIo.renameSync.bind(nodeSyncHostIo)
        let failNextStagingSwap = true
        const renameSpy = vi
          .spyOn(nodeSyncHostIo, "renameSync")
          .mockImplementation((oldPath, newPath) => {
            if (failNextStagingSwap && oldPath.includes(".staging-") && newPath === currentDir) {
              failNextStagingSwap = false
              throw new Error("EXDEV: primary swap failed")
            }
            origRename(oldPath, newPath)
          })

        const rolledBack = buildHookRuntimeSnapshot(dir)
        expect(rolledBack).toEqual({
          _tag: "Failed",
          reason: "EXDEV: primary swap failed",
        })
        expect(readFileSync(join(currentDir, "manifest.json"), "utf8")).toBe(manifestBefore)
        const loadedAfterRollback = yield* HarnessHookRuntime.load(dir)
        expect(loadedAfterRollback._tag).toBe("Snapshot")
        renameSpy.mockRestore()

        // 2. Both staging -> current AND rollback .prev-* -> current fail
        const stagingDir2 = join(dir, ".harness", "hook-runtime", ".staging-rollback-fail")
        mkdirSync(stagingDir2, { recursive: true })
        writeFileSync(join(stagingDir2, "marker.txt"), "new", "utf8")
        const runtimeRootReal = nodeSyncHostIo.realpathSync(join(dir, ".harness", "hook-runtime"))
        const renameSpyBoth = vi
          .spyOn(nodeSyncHostIo, "renameSync")
          .mockImplementation((oldPath, newPath) => {
            if (oldPath === stagingDir2 && newPath === currentDir) {
              throw new Error("EIO: primary swap failed")
            }
            if (oldPath.includes(".prev-") && newPath === currentDir) {
              throw new Error("EPERM: rollback rename failed")
            }
            origRename(oldPath, newPath)
          })

        const bothFailed = swapStagedDirectoryAtomic(runtimeRootReal, stagingDir2)
        match(bothFailed)
          .with({ _tag: "Failure" }, ({ failure }) => {
            expect(failure).toContain("EIO: primary swap failed")
            expect(failure).toContain("rollback of")
            expect(failure).toContain("EPERM: rollback rename failed")
          })
          .with({ _tag: "Success" }, () => expect.unreachable("Expected swap + rollback failure"))
          .exhaustive()
        renameSpyBoth.mockRestore()
      }),
    25_000,
  )

  it.effect(
    "F-14.3: HarnessHookRuntime.load and tools/node-ts-resolver.mjs enforce identical safety and integrity checks",
    () =>
      Effect.gen(function* () {
        // Positive baseline
        const baseDir = makeTempDir("hook-parity-ok-")
        const base = writeParityFixtureRepo(baseDir)
        const okLoad = yield* HarnessHookRuntime.load(baseDir)
        expect(okLoad._tag).toBe("Snapshot")
        expect(runResolverProbe(base.liveEntryPath)).toBe("SNAPSHOT_LOADED")

        // 1. Symlinked .harness
        const symHarnessDir = makeTempDir("hook-parity-sym-harness-")
        const symH = writeParityFixtureRepo(symHarnessDir)
        const outsideH = makeTempDir("hook-parity-outside-h-")
        nodeSyncHostIo.cpRecursiveSync(symH.harnessDir, outsideH)
        rmSync(symH.harnessDir, { recursive: true, force: true })
        symlinkSync(outsideH, symH.harnessDir)
        expect((yield* HarnessHookRuntime.load(symHarnessDir))._tag).toBe("SourceFallback")
        expect(runResolverProbe(symH.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 2. Symlinked hook-runtime
        const symRuntimeDir = makeTempDir("hook-parity-sym-runtime-")
        const symR = writeParityFixtureRepo(symRuntimeDir)
        const outsideR = makeTempDir("hook-parity-outside-r-")
        nodeSyncHostIo.cpRecursiveSync(symR.runtimeDir, outsideR)
        rmSync(symR.runtimeDir, { recursive: true, force: true })
        symlinkSync(outsideR, symR.runtimeDir)
        expect((yield* HarnessHookRuntime.load(symRuntimeDir))._tag).toBe("SourceFallback")
        expect(runResolverProbe(symR.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 3. Symlinked current
        const symCurrentDir = makeTempDir("hook-parity-sym-current-")
        const symC = writeParityFixtureRepo(symCurrentDir)
        const outsideC = makeTempDir("hook-parity-outside-c-")
        nodeSyncHostIo.cpRecursiveSync(symC.currentDir, outsideC)
        rmSync(symC.currentDir, { recursive: true, force: true })
        symlinkSync(outsideC, symC.currentDir)
        expect((yield* HarnessHookRuntime.load(symCurrentDir))._tag).toBe("SourceFallback")
        expect(runResolverProbe(symC.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 4. Symlinked manifest.json
        const symManifestDir = makeTempDir("hook-parity-sym-manifest-")
        const symM = writeParityFixtureRepo(symManifestDir)
        const outsideManifest = join(symManifestDir, "outside-manifest.json")
        writeFileSync(outsideManifest, readFileSync(symM.manifestPath, "utf8"), "utf8")
        rmSync(symM.manifestPath, { force: true })
        symlinkSync(outsideManifest, symM.manifestPath)
        expect((yield* HarnessHookRuntime.load(symManifestDir))._tag).toBe("SourceFallback")
        expect(runResolverProbe(symM.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 5. Path escape ../
        const escapeDir = makeTempDir("hook-parity-escape-")
        const outsideEscapeJs = join(escapeDir, "escape.js")
        writeFileSync(outsideEscapeJs, "export const escaped = true\n", "utf8")
        const esc = writeParityFixtureRepo(escapeDir, {
          packageMapOverride: { "@harness/gates/policy": "../../../escape.js" },
          extraFileHashes: { "../../../escape.js": sha256Hex("export const escaped = true\n") },
        })
        expect((yield* HarnessHookRuntime.load(escapeDir))._tag).toBe("SourceFallback")
        expect(runResolverProbe(esc.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 6. Corrupt manifest JSON
        const corruptDir = makeTempDir("hook-parity-corrupt-")
        const cor = writeParityFixtureRepo(corruptDir, { corruptManifest: true })
        expect(yield* HarnessHookRuntime.load(corruptDir)).toEqual({
          _tag: "SourceFallback",
          reason: "manifest-corrupt",
        })
        expect(runResolverProbe(cor.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 7. Missing required entrypoint (policy.js)
        const missingPolicyDir = makeTempDir("hook-parity-missing-policy-")
        const mp = writeParityFixtureRepo(missingPolicyDir, { omitPolicyFromHashes: true })
        rmSync(join(mp.currentDir, "libs", "harness", "gates", "src", "policy.js"), {
          force: true,
        })
        expect(yield* HarnessHookRuntime.load(missingPolicyDir)).toEqual({
          _tag: "SourceFallback",
          reason: "missing-required:libs/harness/gates/src/policy.js",
        })
        expect(runResolverProbe(mp.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 8. Invalid packageMap target
        const badPkgDir = makeTempDir("hook-parity-bad-pkg-")
        const bp = writeParityFixtureRepo(badPkgDir, {
          packageMapOverride: {
            "@harness/gates/policy": "libs/harness/gates/src/policy.js",
            "@harness/contract": "libs/harness/contract/src/missing.js",
          },
        })
        expect(yield* HarnessHookRuntime.load(badPkgDir)).toEqual({
          _tag: "SourceFallback",
          reason: "invalid-package-target:@harness/contract",
        })
        expect(runResolverProbe(bp.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")

        // 9. integrity-mismatch
        const tamperDir = makeTempDir("hook-parity-tamper-")
        const tp = writeParityFixtureRepo(tamperDir, { tamperPolicyBody: true })
        expect(yield* HarnessHookRuntime.load(tamperDir)).toEqual({
          _tag: "SourceFallback",
          reason: "integrity-mismatch:libs/harness/gates/src/policy.js",
        })
        expect(runResolverProbe(tp.liveEntryPath)).toBe("LIVE_SOURCE_FALLBACK")
      }),
  )
})
