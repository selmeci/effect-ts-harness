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
import { findWorkspaceRoot, isInsideRoot, isIsolatedExternalWorkspace } from "./repo-path.js"

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
})
export type PreInvocationCacheEntry = typeof PreInvocationCacheSchema.Type
export type PreInvocationCacheRecord = Omit<PreInvocationCacheEntry, "version">

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

const digestFile = (filePath: string, hostIo: SyncHostIo, contentHash: boolean): string => {
  if (!hostIo.existsSync(filePath)) return "missing"
  if (hostIo.isSymbolicLinkSync(filePath)) return "symlink"
  if (!hostIo.isFileSync(filePath)) return "non-file"
  if (contentHash) {
    return tryOr(
      () => createHash("sha256").update(hostIo.readBytesSync(filePath)).digest("hex"),
      "unreadable",
    )
  }
  return hasStatMtimeMsSync(hostIo)
    ? tryOr(() => `mtime:${String(hostIo.statMtimeMsSync(filePath))}`, "unstatable")
    : tryOr(() => `len:${String(hostIo.readBytesSync(filePath).length)}`, "unreadable")
}

const hashDirtyPathContent = (
  repoRoot: string,
  relPath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (relPath === ".git" || relPath.endsWith("/.git")) return undefined
  const absPath = join(repoRoot, relPath)
  if (hostIo.isSymbolicLinkSync(absPath)) return undefined
  if (hostIo.existsSync(join(absPath, ".git"))) return undefined
  if (!hostIo.existsSync(absPath)) return "deleted"
  if (!hostIo.isFileSync(absPath)) return undefined
  const digest = digestFile(absPath, hostIo, true)
  return digest === "unreadable" || digest === "symlink" ? undefined : digest
}

export const computePreInvocationFingerprint = (
  repoRoot: string,
  harnessDir: string,
  hostIo: SyncHostIo,
  options?: CliEnv,
): Option.Option<string> => {
  if (!hostIo.existsSync(join(repoRoot, ".git"))) return Option.none()
  const statusStdout = tryOr(() => {
    const res = hostIo.execFileSync(
      "git",
      ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: repoRoot },
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
  for (const line of statusStdout.split(/\r?\n/)) {
    if (line.length < 4) continue
    const relPath = line
      .slice(3)
      .trim()
      .replace(/^.*->\s*/, "")
    if (relPath.length === 0 || relPath === ".harness" || relPath.startsWith(".harness/")) continue
    const dirtyDigest = hashDirtyPathContent(repoRoot, relPath, hostIo)
    if (dirtyDigest === undefined) return Option.none()
    hash.update(`dirty:${line.slice(0, 2)}:${relPath}:${dirtyDigest}\n`)
  }
  const frictionPath = join(harnessDir, "friction-log.jsonl")
  const hasNonEmptyFriction =
    hostIo.existsSync(frictionPath) &&
    hostIo.isFileSync(frictionPath) &&
    tryOr(() => hostIo.readBytesSync(frictionPath).length > 0, false)
  for (const f of [
    "friction-log.jsonl",
    "verify-stamp.json",
    "mutate-stamp.json",
    "plan-graph-snapshot.json",
    "graph-head.json",
    "graph-snapshot.json",
    ...(hasNonEmptyFriction ? ["telemetry-log.jsonl"] : []),
  ]) {
    hash.update(`state:${f}:${digestFile(join(harnessDir, f), hostIo, true)}\n`)
  }
  const tsgoPkgPath = resolveHarnessTsgoPkgJsonPath(repoRoot, hostIo)
  const workspaceTsconfig = join(findWorkspaceRoot(), "tsconfig.base.json")
  const repoTsconfig = join(repoRoot, "tsconfig.base.json")
  const tsconfigPath = hostIo.existsSync(repoTsconfig) ? repoTsconfig : workspaceTsconfig
  hash.update(`tsgo:${digestFile(tsgoPkgPath, hostIo, false)}\n`)
  hash.update(`tsconfig:${digestFile(tsconfigPath, hostIo, true)}\n`)
  hash.update(
    `cluster:${digestFile(join(repoRoot, "libs/harness/graph/cluster.yaml"), hostIo, true)}\n`,
  )
  hash.update(`devvars:${digestFile(join(repoRoot, ".dev.vars"), hostIo, false)}\n`)
  hash.update(`envfile:${digestFile(join(repoRoot, ".env"), hostIo, false)}\n`)
  hash.update(
    `env:${process.env.HARNESS_OLLAMA_URL ?? process.env.OLLAMA_HOST ?? ""}|${process.env.OMNIGRAPH_URL ?? ""}|${String(Boolean(options?.skipBackgroundDaemons))}|${String(Boolean(options?.decisionLayer))}\n`,
  )
  return Option.some(hash.digest("hex"))
}

const hasSymlinkAncestor = (targetPath: string, hostIo: SyncHostIo): boolean => {
  let curr = resolve(targetPath)
  while (true) {
    if (hostIo.existsSync(curr) && hostIo.isSymbolicLinkSync(curr)) return true
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

const isSafeCacheDirAndPath = (
  repoRoot: string,
  harnessDir: string,
  cachePath: string,
  hostIo: SyncHostIo,
  requireExistingFile: boolean,
): boolean => {
  if (hasSymlinkAncestor(harnessDir, hostIo) || hasSymlinkAncestor(cachePath, hostIo)) return false
  if (!process.env.HARNESS_STATE_DIR) {
    const realRepo = tryOr(() => hostIo.realpathSync(repoRoot), undefined)
    const existingAnchor = findDeepestExistingDir(harnessDir, hostIo)
    const realAnchor = existingAnchor
      ? tryOr(() => hostIo.realpathSync(existingAnchor), undefined)
      : undefined
    if (realRepo === undefined || realAnchor === undefined || !isInsideRoot(realRepo, realAnchor)) {
      return false
    }
  }
  if (hostIo.existsSync(cachePath)) {
    if (!hostIo.isFileSync(cachePath)) return false
    const realHarness = tryOr(() => hostIo.realpathSync(harnessDir), undefined)
    const realCache = tryOr(() => hostIo.realpathSync(cachePath), undefined)
    return (
      realHarness !== undefined && realCache !== undefined && isInsideRoot(realHarness, realCache)
    )
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
  const harnessDir = resolveHarnessStateDir(repoRoot)
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
    stderr: "",
  })
}

export const writePreInvocationSessionCache = (
  repoRoot: string,
  harnessDir: string,
  record: PreInvocationCacheRecord,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  const cachePath = join(harnessDir, PRE_INVOCATION_CACHE_FILE)
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, cachePath, hostIo, false)) return
  if (!hostIo.existsSync(harnessDir)) {
    const mkdirOk = match(Result.try(() => hostIo.mkdirRecursiveSync(dirname(cachePath))))
      .with({ _tag: "Success" }, () => true)
      .with({ _tag: "Failure" }, () => false)
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
    .with({ _tag: "Failure" }, () => {
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
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): void => {
  const fp = unwrapOption(computePreInvocationFingerprint(repoRoot, harnessDir, hostIo, options))
  if (fp !== undefined) {
    writePreInvocationSessionCache(
      repoRoot,
      harnessDir,
      { fingerprint: fp, recordedAtMs: Date.now(), ollamaReady, ollamaProbed, injectSteps },
      hostIo,
    )
  }
}
