import { createHash, randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  isWorkspaceRelPathIncludedInStamp,
  resolveHarnessStateDir,
} from "@harness/gates/hook-fastpath"
import { resolveGitHeadState } from "@harness/graph/cluster-resolver"
import {
  GIT_FINGERPRINT_MAX_BUFFER_BYTES,
  GIT_FINGERPRINT_STATUS_ARGS,
} from "@harness/infra/hook-io"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import type { CliEnv, CliResult } from "./daemon-and-omnigraph.service.js"
import { hasAntigravityFormat } from "./hook-format.js"
import {
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  isInsideRoot,
  isIsolatedExternalWorkspace,
  shouldSuppressLiveRepoTestSideEffects,
} from "./repo-path.js"

export const PRE_INVOCATION_CACHE_TTL_MS = 300_000
export const DEGRADED_PRE_INVOCATION_CACHE_TTL_MS = 30_000
const PRE_INVOCATION_CACHE_FILE = "session-preinvocation-cache.json"

export const PreInvocationCacheSchema = Schema.Struct({
  version: Schema.Literal("session-preinvocation-v1"),
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  recordedAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ollamaReady: Schema.Boolean,
  ollamaProbed: Schema.Boolean,
  degraded: Schema.optional(Schema.Boolean),
  injectSteps: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(32),
  ),
  stderr: Schema.String,
})
export type PreInvocationCacheEntry = typeof PreInvocationCacheSchema.Type
export type PreInvocationCacheRecord = Omit<PreInvocationCacheEntry, "version">

export const resolveHarnessStateDirSafe = (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Option.Option<string> =>
  match(Result.try(() => resolveHarnessStateDir(repoRoot, env)))
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
  const env = hostIo.getEnv()
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const isolatedExternal = isIsolatedExternalWorkspace(repoRoot, hostIo)
  return (
    env["HARNESS_REQUIRE_OLLAMA"] === "1" ||
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
  return tryOr(() => hostIo.existsSync(localPath), false)
    ? localPath
    : join(CLI_REPO_ROOT, "node_modules", "@effect", "tsgo", "package.json")
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
    const res = hostIo.execFileSync("git", GIT_FINGERPRINT_STATUS_ARGS, {
      cwd: repoRoot,
      timeoutMs: 2_000,
      maxBufferBytes: GIT_FINGERPRINT_MAX_BUFFER_BYTES,
    })
    return match(res)
      .with({ _tag: "Exited" }, ({ exitCode, stdout }) => (exitCode === 0 ? stdout : undefined))
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => undefined)
      .exhaustive()
  }, undefined)
  if (statusStdout === undefined) return Option.none()

  const headState = resolveGitHeadState(repoRoot, hostIo)
  if (headState.gitBranch === null && headState.headSha === null) return Option.none()
  const rawRelHarness = relative(repoRoot, harnessDir).replace(/\\/g, "/")
  const customHarnessRel =
    rawRelHarness.length > 0 &&
    rawRelHarness !== "." &&
    !rawRelHarness.startsWith("..") &&
    !isAbsolute(rawRelHarness)
      ? rawRelHarness
      : undefined
  const isHarnessStateRelPath = (relPath: string): boolean =>
    relPath === ".harness" ||
    relPath.startsWith(".harness/") ||
    (customHarnessRel !== undefined &&
      (relPath === customHarnessRel || relPath.startsWith(`${customHarnessRel}/`)))
  const isExcludedIgnoredRelPath = (relPath: string): boolean =>
    relPath.length === 0 ||
    isHarnessStateRelPath(relPath) ||
    relPath === ".env" ||
    relPath === ".dev.vars" ||
    !isWorkspaceRelPathIncludedInStamp(relPath)
  const hash = createHash("sha256")
  hash.update(`branch:${headState.gitBranch ?? ""}\nsha:${headState.headSha ?? ""}\n`)
  const seenPaths = new Set<string>()
  const ignoredFiles: Array<string> = []
  const collectIgnoredDir = (dirRel: string, absDir: string): boolean => {
    if (
      tryOr(() => hostIo.isSymbolicLinkSync(absDir), true) ||
      tryOr(() => hostIo.existsSync(join(absDir, ".git")), true)
    ) {
      return false
    }
    const dirEntries = tryOr(() => hostIo.readdirSync(absDir), undefined)
    if (dirEntries === undefined) return false
    const sorted = [...dirEntries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of sorted) {
      const childRel = `${dirRel}/${entry.name}`
      if (isExcludedIgnoredRelPath(childRel)) continue
      const childAbs = join(absDir, entry.name)
      if (tryOr(() => hostIo.isSymbolicLinkSync(childAbs), true) || entry.name === ".git") {
        return false
      }
      if (entry.isDirectory) {
        if (!collectIgnoredDir(childRel, childAbs)) return false
        continue
      }
      ignoredFiles.push(childRel)
    }
    return true
  }
  const entries = statusStdout.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const relPath = entry.slice(3)
    if (xy === "!!") {
      const trimmedRel = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath
      if (isExcludedIgnoredRelPath(trimmedRel)) continue
      if (relPath.endsWith("/")) {
        if (!collectIgnoredDir(trimmedRel, join(repoRoot, trimmedRel))) return Option.none()
      } else {
        ignoredFiles.push(trimmedRel)
      }
      continue
    }
    if (xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C") {
      const origPath = entries[i + 1] ?? ""
      i += 1
      if (origPath.length > 0 && !isHarnessStateRelPath(origPath)) {
        hash.update(`renamed-from:${origPath}\n`)
      }
    }
    if (relPath.length === 0 || isHarnessStateRelPath(relPath)) continue
    seenPaths.add(relPath)
    const dirtyDigest = unwrapOption(hashDirtyPathContent(repoRoot, relPath, hostIo))
    if (dirtyDigest === undefined) return Option.none()
    hash.update(`dirty:${xy}:${relPath}:${dirtyDigest}\n`)
  }
  ignoredFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  let prevIgnored = ""
  for (const relPath of ignoredFiles) {
    if (relPath === prevIgnored || seenPaths.has(relPath)) continue
    prevIgnored = relPath
    const ignoredDigest = unwrapOption(hashDirtyPathContent(repoRoot, relPath, hostIo))
    if (ignoredDigest === undefined) return Option.none()
    hash.update(`ignored:${relPath}:${ignoredDigest}\n`)
  }
  const stateInputs: ReadonlyArray<readonly [string, boolean]> = [
    ["friction-log.jsonl", true],
    ["verify-stamp.json", true],
    ["mutate-stamp.json", true],
    ["plan-graph-snapshot.json", false],
    ["graph-head.json", true],
    ["graph-snapshot.json", false],
    ["last-done.json", true],
  ]
  for (const [f, contentHash] of stateInputs) {
    const d = unwrapOption(digestFile(join(harnessDir, f), hostIo, contentHash))
    if (d === undefined) return Option.none()
    hash.update(`state:${f}:${d}\n`)
  }
  const tsgoPkgPath = resolveHarnessTsgoPkgJsonPath(repoRoot, hostIo)
  const workspaceTsconfig = join(CLI_REPO_ROOT, "tsconfig.base.json")
  const repoTsconfig = join(repoRoot, "tsconfig.base.json")
  const tsconfigPath = tryOr(() => hostIo.existsSync(repoTsconfig), false)
    ? repoTsconfig
    : workspaceTsconfig
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
  const env = hostIo.getEnv()
  hash.update(
    `env:${env["HARNESS_OLLAMA_URL"] ?? env["OLLAMA_HOST"] ?? ""}|${env["OMNIGRAPH_URL"] ?? ""}|${String(Boolean(options?.skipBackgroundDaemons))}|${String(Boolean(options?.decisionLayer))}\n`,
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
    if (tryOr(() => hostIo.isSymbolicLinkSync(curr), true)) return true
    if (curr === resolvedStop) return false
    const parent = dirname(curr)
    if (parent === curr) return false
    curr = parent
  }
}

const findDeepestExistingDir = (targetDir: string, hostIo: SyncHostIo): string | undefined => {
  let curr = resolve(targetDir)
  while (true) {
    if (tryOr(() => hostIo.existsSync(curr), false)) return curr
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
  const env = hostIo.getEnv()
  const hasStateDirOverride =
    env["HARNESS_STATE_DIR"] !== undefined && env["HARNESS_STATE_DIR"] !== ""
  const isInsideRepo = isInsideRoot(resolve(repoRoot), resolve(harnessDir))
  const stopBoundary = isInsideRepo ? resolve(repoRoot) : resolve(harnessDir)
  if (tryOr(() => hostIo.isSymbolicLinkSync(harnessDir), true)) {
    return warnUnsafeCache(`symlink detected at ${harnessDir}`)
  }
  if (
    hasSymlinkAncestor(harnessDir, stopBoundary, hostIo) ||
    hasSymlinkAncestor(cachePath, stopBoundary, hostIo)
  ) {
    return warnUnsafeCache(`symlink detected in ${cachePath}`)
  }
  if (tryOr(() => hostIo.isSymbolicLinkSync(cachePath), true)) {
    return warnUnsafeCache(`symlink detected in ${cachePath}`)
  }
  if (!hasStateDirOverride || isInsideRepo) {
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
  const env = hostIo.getEnv()
  if (
    options?.skipInitialSessionCacheRead === true ||
    env["HARNESS_REQUIRE_OLLAMA"] === "1" ||
    !hasAntigravityFormat(args) ||
    options?.governanceDocs !== undefined ||
    options?.planGraph !== undefined ||
    options?.implGraph !== undefined
  ) {
    return Option.none()
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const harnessDir = unwrapOption(resolveHarnessStateDirSafe(repoRoot, env))
  if (harnessDir === undefined) return Option.none()
  const cachePath = join(harnessDir, PRE_INVOCATION_CACHE_FILE)
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, cachePath, hostIo, true)) return Option.none()
  const raw = tryOr(() => hostIo.readTextSync(cachePath), undefined)
  if (raw === undefined) return Option.none()
  const cached = unwrapOption(decodeCacheEntry(raw))
  if (cached === undefined) return Option.none()
  const effectiveTtlMs =
    cached.degraded === true ? DEGRADED_PRE_INVOCATION_CACHE_TTL_MS : PRE_INVOCATION_CACHE_TTL_MS
  const ageMs = Date.now() - cached.recordedAtMs
  if (ageMs < 0 || ageMs > effectiveTtlMs) return Option.none()
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

const verifyTempFileContainment = (
  harnessDir: string,
  tmpPath: string,
  hostIo: SyncHostIo,
): boolean => {
  if (tryOr(() => hostIo.isSymbolicLinkSync(harnessDir), true)) return false
  if (tryOr(() => hostIo.isSymbolicLinkSync(tmpPath), true)) return false
  const realHarness = tryOr(() => hostIo.realpathSync(harnessDir), undefined)
  const realTmp = tryOr(() => hostIo.realpathSync(tmpPath), undefined)
  return realHarness !== undefined && realTmp !== undefined && isInsideRoot(realHarness, realTmp)
}

export const writePreInvocationSessionCache = (
  repoRoot: string,
  harnessDir: string,
  record: PreInvocationCacheRecord,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  const env = hostIo.getEnv()
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot, env)) return
  const cachePath = join(harnessDir, PRE_INVOCATION_CACHE_FILE)
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, cachePath, hostIo, false)) return
  if (!tryOr(() => hostIo.existsSync(harnessDir), false)) {
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
      if (!verifyTempFileContainment(harnessDir, tmpPath, hostIo)) {
        hostIo.unlinkSync(tmpPath)
        return false
      }
      hostIo.renameSync(tmpPath, cachePath)
      return true
    }),
  )
    .with({ _tag: "Success" }, ({ success }) => {
      if (!success) {
        process.stderr.write(
          `[harness:session] Warning: disabling hook session cache (unsafe temp cache path ${tmpPath}).\n`,
        )
      }
    })
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

export const writeLastDoneMarker = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  const env = hostIo.getEnv()
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot, env)) return
  const harnessDir = unwrapOption(resolveHarnessStateDirSafe(repoRoot, env))
  if (harnessDir === undefined) return
  const markerPath = join(harnessDir, "last-done.json")
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, markerPath, hostIo, false)) return
  if (!ensureHarnessDirSafe(Option.some(harnessDir), hostIo)) return
  const tmpPath = join(
    harnessDir,
    `.last-done.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  )
  match(
    Result.try(() => {
      hostIo.writeTextSync(tmpPath, JSON.stringify({ completedAt: new Date().toISOString() }))
      if (!verifyTempFileContainment(harnessDir, tmpPath, hostIo)) {
        hostIo.unlinkSync(tmpPath)
        return false
      }
      hostIo.renameSync(tmpPath, markerPath)
      return true
    }),
  )
    .with({ _tag: "Success" }, ({ success }) => {
      if (!success) {
        process.stderr.write(`[harness:done] Warning: unsafe temp marker path ${tmpPath}.\n`)
      }
    })
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(`[harness:done] Warning: Failed to write last-done.json: ${msg}\n`)
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
  degraded?: boolean,
): void => {
  const fp = unwrapOption(computePreInvocationFingerprint(repoRoot, harnessDir, hostIo, options))
  if (fp !== undefined) {
    writePreInvocationSessionCache(
      repoRoot,
      harnessDir,
      {
        fingerprint: fp,
        recordedAtMs: Date.now(),
        ollamaReady,
        ollamaProbed,
        ...(degraded === true ? { degraded: true } : {}),
        injectSteps,
        stderr,
      },
      hostIo,
    )
  }
}
