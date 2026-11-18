import { createHash, randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { resolveHarnessStateDir } from "@harness/gates/hook-fastpath"
import { resolveGitHeadState } from "@harness/graph/cluster-resolver"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import type { CliEnv, CliResult } from "./daemon-and-omnigraph.service.js"
import { hasAntigravityFormat } from "./hook-format.js"
import {
  findWorkspaceRoot,
  isInsideRoot,
  isIsolatedExternalWorkspace,
  shouldSuppressLiveRepoTestSideEffects,
} from "./repo-path.js"

export const PRE_INVOCATION_CACHE_TTL_MS = 15_000
const PRE_INVOCATION_CACHE_FILE = "session-preinvocation-cache.json"

export const PreInvocationCacheSchema = Schema.Struct({
  version: Schema.Literal("session-preinvocation-v1"),
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  recordedAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ollamaReady: Schema.Boolean,
  ollamaProbed: Schema.Boolean,
  injectSteps: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(32),
  ),
  stderr: Schema.String,
})
export type PreInvocationCacheEntry = typeof PreInvocationCacheSchema.Type
export type PreInvocationCacheRecord = Omit<PreInvocationCacheEntry, "version">

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export const resolveHarnessStateDirSafe = (repoRoot: string): Option.Option<string> =>
  match(Result.try(() => resolveHarnessStateDir(repoRoot)))
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(`[harness:session] Warning: invalid HARNESS_STATE_DIR: ${msg}\n`)
      return Option.none()
    })
    .exhaustive()

export const ensureHarnessDirSafe = (
  harnessDirOpt: Option.Option<string>,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean =>
  match(harnessDirOpt)
    .with({ _tag: "None" }, () => false)
    .with({ _tag: "Some" }, ({ value: dir }) =>
      tryOr(() => {
        if (!hostIo.existsSync(dir)) hostIo.mkdirRecursiveSync(dir)
        return true
      }, false),
    )
    .exhaustive()

const decodeCacheEntry = Schema.decodeOption(Schema.fromJsonString(PreInvocationCacheSchema))

const unwrapOption = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const tryOr = <A>(fn: () => A, fallback: A): A =>
  match(Result.try(fn))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => fallback)
    .exhaustive()

const hasStatMtimeMsSync = (
  hostIo: SyncHostIo,
): hostIo is SyncHostIo & Pick<ExtendedHostIo, "statMtimeMsSync"> =>
  "statMtimeMsSync" in hostIo && typeof hostIo.statMtimeMsSync === "function"

export const shouldRequireLiveOllama = (
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean => {
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const isolatedExternal = isIsolatedExternalWorkspace(repoRoot, hostIo)
  return (
    process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
    (!isolatedExternal &&
      options?.decisionLayer === undefined &&
      options?.skipBackgroundDaemons !== true)
  )
}

export const resolveHarnessTsgoPkgJsonPath = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): string => {
  const localPath = join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
  return hostIo.existsSync(localPath)
    ? localPath
    : join(findWorkspaceRoot(), "node_modules", "@effect", "tsgo", "package.json")
}

const digestFile = (
  filePath: string,
  hostIo: SyncHostIo,
  contentHash: boolean,
): Option.Option<string> => {
  const isSym = tryOr(() => hostIo.isSymbolicLinkSync(filePath), true)
  if (isSym) return Option.none()
  const exists = tryOr(() => hostIo.existsSync(filePath), undefined)
  if (exists === undefined) return Option.none()
  if (!exists) return Option.some("absent")
  const isFile = tryOr(() => hostIo.isFileSync(filePath), false)
  if (!isFile) return Option.none()
  if (contentHash) {
    const hex = tryOr(
      () => createHash("sha256").update(hostIo.readBytesSync(filePath)).digest("hex"),
      undefined,
    )
    return Option.fromUndefinedOr(hex)
  }
  const meta = hasStatMtimeMsSync(hostIo)
    ? tryOr(() => `mtime:${String(hostIo.statMtimeMsSync(filePath))}`, undefined)
    : tryOr(() => `len:${String(hostIo.readBytesSync(filePath).length)}`, undefined)
  return Option.fromUndefinedOr(meta)
}

const hashDirtyPathContent = (
  repoRoot: string,
  relPath: string,
  hostIo: SyncHostIo,
): Option.Option<string> => {
  if (relPath === ".git" || relPath.endsWith("/.git")) return Option.none()
  const absPath = join(repoRoot, relPath)
  if (tryOr(() => hostIo.isSymbolicLinkSync(absPath), true)) return Option.none()
  if (tryOr(() => hostIo.existsSync(join(absPath, ".git")), true)) return Option.none()
  const exists = tryOr(() => hostIo.existsSync(absPath), undefined)
  if (exists === undefined) return Option.none()
  if (!exists) return Option.some("deleted")
  return digestFile(absPath, hostIo, true)
}

export const computePreInvocationFingerprint = (
  repoRoot: string,
  harnessDir: string,
  hostIo: SyncHostIo,
  options?: CliEnv,
): Option.Option<string> => {
  if (!tryOr(() => hostIo.existsSync(join(repoRoot, ".git")), false)) return Option.none()
  const statusStdout = tryOr(() => {
    const res = hostIo.execFileSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot, timeoutMs: 2_000 },
    )
    return match(res)
      .with({ _tag: "Exited" }, ({ exitCode, stdout }) => (exitCode === 0 ? stdout : undefined))
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => undefined)
      .exhaustive()
  }, undefined)
  if (statusStdout === undefined) return Option.none()

  const headState = resolveGitHeadState(repoRoot, hostIo)
  const hash = createHash("sha256")
  hash.update(`branch:${headState.gitBranch ?? ""}\nsha:${headState.headSha ?? ""}\n`)
  const entries = statusStdout.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const relPath = entry.slice(3)
    if (xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C") {
      const origPath = entries[i + 1] ?? ""
      i += 1
      if (origPath.length > 0 && origPath !== ".harness" && !origPath.startsWith(".harness/")) {
        hash.update(`renamed-from:${origPath}\n`)
      }
    }
    if (relPath.length === 0 || relPath === ".harness" || relPath.startsWith(".harness/")) continue
    const dirtyDigest = unwrapOption(hashDirtyPathContent(repoRoot, relPath, hostIo))
    if (dirtyDigest === undefined) return Option.none()
    hash.update(`dirty:${xy}:${relPath}:${dirtyDigest}\n`)
  }
  const frictionDigest = unwrapOption(
    digestFile(join(harnessDir, "friction-log.jsonl"), hostIo, true),
  )
  if (frictionDigest === undefined) return Option.none()
  const hasNonEmptyFriction = frictionDigest !== "absent" && frictionDigest !== EMPTY_SHA256
  for (const f of [
    "friction-log.jsonl",
    "verify-stamp.json",
    "mutate-stamp.json",
    "plan-graph-snapshot.json",
    "graph-head.json",
    "graph-snapshot.json",
    ...(hasNonEmptyFriction ? ["telemetry-log.jsonl"] : []),
  ]) {
    const d = unwrapOption(digestFile(join(harnessDir, f), hostIo, true))
    if (d === undefined) return Option.none()
    hash.update(`state:${f}:${d}\n`)
  }
  const tsgoPkgPath = resolveHarnessTsgoPkgJsonPath(repoRoot, hostIo)
  const workspaceTsconfig = join(findWorkspaceRoot(), "tsconfig.base.json")
  const repoTsconfig = join(repoRoot, "tsconfig.base.json")
  const tsconfigPath = hostIo.existsSync(repoTsconfig) ? repoTsconfig : workspaceTsconfig
  const fixedInputs: ReadonlyArray<readonly [string, string, boolean]> = [
    ["tsgo", tsgoPkgPath, false],
    ["tsconfig", tsconfigPath, true],
    ["cluster", join(repoRoot, "libs/harness/graph/cluster.yaml"), true],
    ["devvars", join(repoRoot, ".dev.vars"), false],
    ["envfile", join(repoRoot, ".env"), false],
  ]
  for (const [label, path, contentHash] of fixedInputs) {
    const d = unwrapOption(digestFile(path, hostIo, contentHash))
    if (d === undefined) return Option.none()
    hash.update(`${label}:${d}\n`)
  }
  hash.update(
    `env:${process.env.HARNESS_OLLAMA_URL ?? process.env.OLLAMA_HOST ?? ""}|${process.env.OMNIGRAPH_URL ?? ""}|${String(Boolean(options?.skipBackgroundDaemons))}|${String(Boolean(options?.decisionLayer))}\n`,
  )
  return Option.some(hash.digest("hex"))
}

const hasSymlinkAncestor = (
  targetPath: string,
  stopBoundary: string,
  hostIo: SyncHostIo,
): boolean => {
  const resolvedStop = resolve(stopBoundary)
  let curr = resolve(targetPath)
  while (true) {
    if (tryOr(() => hostIo.existsSync(curr) && hostIo.isSymbolicLinkSync(curr), true)) return true
    if (curr === resolvedStop) return false
    const parent = dirname(curr)
    if (parent === curr) return false
    curr = parent
  }
}

const findDeepestExistingDir = (targetDir: string, hostIo: SyncHostIo): string | undefined => {
  let curr = resolve(targetDir)
  while (true) {
    if (hostIo.existsSync(curr)) return curr
    const parent = dirname(curr)
    if (parent === curr) return undefined
    curr = parent
  }
}

const warnUnsafeCache = (reason: string): false => {
  process.stderr.write(`[harness:session] Warning: disabling hook session cache (${reason}).\n`)
  return false
}

const isSafeCacheDirAndPath = (
  repoRoot: string,
  harnessDir: string,
  cachePath: string,
  hostIo: SyncHostIo,
  requireExistingFile: boolean,
): boolean => {
  const hasStateDirOverride =
    process.env.HARNESS_STATE_DIR !== undefined && process.env.HARNESS_STATE_DIR !== ""
  const stopBoundary =
    !hasStateDirOverride && isInsideRoot(resolve(repoRoot), resolve(harnessDir))
      ? resolve(repoRoot)
      : resolve(harnessDir)
  if (
    hasSymlinkAncestor(harnessDir, stopBoundary, hostIo) ||
    hasSymlinkAncestor(cachePath, stopBoundary, hostIo)
  ) {
    return warnUnsafeCache(`symlink detected in ${cachePath}`)
  }
  if (!hasStateDirOverride) {
    const realRepo = tryOr(() => hostIo.realpathSync(repoRoot), undefined)
    const existingAnchor = findDeepestExistingDir(harnessDir, hostIo)
    const realAnchor = existingAnchor
      ? tryOr(() => hostIo.realpathSync(existingAnchor), undefined)
      : undefined
    if (realRepo === undefined || realAnchor === undefined || !isInsideRoot(realRepo, realAnchor)) {
      return warnUnsafeCache(`cache dir ${harnessDir} resolves outside repoRoot`)
    }
  }
  if (tryOr(() => hostIo.existsSync(cachePath), true)) {
    if (!tryOr(() => hostIo.isFileSync(cachePath), false)) {
      return warnUnsafeCache(`cache path ${cachePath} is not a regular file`)
    }
    const realHarness = tryOr(() => hostIo.realpathSync(harnessDir), undefined)
    const realCache = tryOr(() => hostIo.realpathSync(cachePath), undefined)
    if (
      realHarness === undefined ||
      realCache === undefined ||
      !isInsideRoot(realHarness, realCache)
    ) {
      return warnUnsafeCache(`cache path ${cachePath} resolves outside ${harnessDir}`)
    }
    return true
  }
  return !requireExistingFile
}

export const tryReadPreInvocationSessionCache = (
  args: ReadonlyArray<string>,
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): Option.Option<CliResult> => {
  if (
    process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
    !hasAntigravityFormat(args) ||
    options?.governanceDocs !== undefined ||
    options?.planGraph !== undefined ||
    options?.implGraph !== undefined
  ) {
    return Option.none()
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const harnessDir = unwrapOption(resolveHarnessStateDirSafe(repoRoot))
  if (harnessDir === undefined) return Option.none()
  const cachePath = join(harnessDir, PRE_INVOCATION_CACHE_FILE)
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, cachePath, hostIo, true)) return Option.none()
  const raw = tryOr(() => hostIo.readTextSync(cachePath), undefined)
  if (raw === undefined) return Option.none()
  const cached = unwrapOption(decodeCacheEntry(raw))
  if (cached === undefined) return Option.none()
  const ageMs = Date.now() - cached.recordedAtMs
  if (ageMs < 0 || ageMs > PRE_INVOCATION_CACHE_TTL_MS) return Option.none()
  const requireOllama = shouldRequireLiveOllama(options, hostIo)
  if (requireOllama && (!cached.ollamaProbed || !cached.ollamaReady)) return Option.none()
  const fp = unwrapOption(computePreInvocationFingerprint(repoRoot, harnessDir, hostIo, options))
  if (fp === undefined || fp !== cached.fingerprint) return Option.none()
  return Option.some({
    exitCode: 0,
    stdout: JSON.stringify({ injectSteps: cached.injectSteps }),
    stderr: cached.stderr,
    telemetryDetail: "cache=hit",
  })
}

export const writePreInvocationSessionCache = (
  repoRoot: string,
  harnessDir: string,
  record: PreInvocationCacheRecord,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot)) return
  const cachePath = join(harnessDir, PRE_INVOCATION_CACHE_FILE)
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, cachePath, hostIo, false)) return
  if (!hostIo.existsSync(harnessDir)) {
    const mkdirRes = Result.try(() => hostIo.mkdirRecursiveSync(dirname(cachePath)))
    const mkdirOk = match(mkdirRes)
      .with({ _tag: "Success" }, () => true)
      .with({ _tag: "Failure" }, ({ failure }) => {
        const msg = failure instanceof Error ? failure.message : String(failure)
        process.stderr.write(
          `[harness:session] Warning: Failed to write hook session cache: ${msg}\n`,
        )
        return false
      })
      .exhaustive()
    if (!mkdirOk) return
  }
  const tmpPath = join(
    harnessDir,
    `.${PRE_INVOCATION_CACHE_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  )
  const payload: PreInvocationCacheEntry = {
    version: "session-preinvocation-v1",
    ...record,
  }
  match(
    Result.try(() => {
      hostIo.writeTextSync(tmpPath, JSON.stringify(payload))
      hostIo.renameSync(tmpPath, cachePath)
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(
        `[harness:session] Warning: Failed to write hook session cache: ${msg}\n`,
      )
      Result.try(() => {
        if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
      })
    })
    .exhaustive()
}

export const tryCachePreInvocationResult = (
  repoRoot: string,
  harnessDir: string,
  ollamaReady: boolean,
  ollamaProbed: boolean,
  injectSteps: ReadonlyArray<string>,
  stderr: string,
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  const fp = unwrapOption(computePreInvocationFingerprint(repoRoot, harnessDir, hostIo, options))
  if (fp !== undefined) {
    writePreInvocationSessionCache(
      repoRoot,
      harnessDir,
      { fingerprint: fp, recordedAtMs: Date.now(), ollamaReady, ollamaProbed, injectSteps, stderr },
      hostIo,
    )
  }
}
