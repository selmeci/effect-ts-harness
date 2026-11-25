import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { resolveHarnessStateDir } from "@harness/gates/hook-fastpath"
import { resolveGitHeadState } from "@harness/graph/cluster-resolver"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import {
  computePreInvocationFingerprintFromIo,
  isSafeHarnessLeafPathWith,
} from "@harness/infra/hook-io"
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

export const LastDoneMarkerSchema = Schema.Struct({
  completedAt: Schema.NonEmptyString,
  treeHash: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
})
export type LastDoneMarker = typeof LastDoneMarkerSchema.Type

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
const decodeLastDoneMarker = Schema.decodeUnknownOption(Schema.fromJsonString(LastDoneMarkerSchema))

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

export const computePreInvocationFingerprint = (
  repoRoot: string,
  harnessDir: string,
  hostIo: SyncHostIo,
  options?: CliEnv,
): Option.Option<string> => {
  const workspaceTsconfig = join(CLI_REPO_ROOT, "tsconfig.base.json")
  const repoTsconfig = join(repoRoot, "tsconfig.base.json")
  return computePreInvocationFingerprintFromIo({
    repoRoot,
    harnessDir,
    existsSync: (filePath) => hostIo.existsSync(filePath),
    isFileSync: (filePath) => hostIo.isFileSync(filePath),
    isSymbolicLinkSync: (filePath) => hostIo.isSymbolicLinkSync(filePath),
    readBytesSync: (filePath) => hostIo.readBytesSync(filePath),
    statMtimeMsSync: hasStatMtimeMsSync(hostIo)
      ? (filePath) => hostIo.statMtimeMsSync(filePath)
      : undefined,
    getEnv: () => hostIo.getEnv(),
    resolveHead: () => resolveGitHeadState(repoRoot, hostIo),
    resolveTsgoPkgJsonPath: () => resolveHarnessTsgoPkgJsonPath(repoRoot, hostIo),
    resolveTsconfigPath: () =>
      tryOr(() => hostIo.existsSync(repoTsconfig), false) ? repoTsconfig : workspaceTsconfig,
    skipBackgroundDaemons: options?.skipBackgroundDaemons,
    hasDecisionLayer: options?.decisionLayer !== undefined,
  })
}

const isSafeCacheDirAndPath = (
  repoRoot: string,
  harnessDir: string,
  cachePath: string,
  hostIo: SyncHostIo,
  requireExistingFile: boolean,
): boolean =>
  isSafeHarnessLeafPathWith(
    repoRoot,
    harnessDir,
    cachePath,
    {
      existsSync: (filePath) => hostIo.existsSync(filePath),
      isFileSync: (filePath) => hostIo.isFileSync(filePath),
      isSymbolicLinkSync: (filePath) => hostIo.isSymbolicLinkSync(filePath),
      realpathSync: (filePath) => hostIo.realpathSync(filePath),
      getEnv: () => hostIo.getEnv(),
      onUnsafe: (reason) => {
        process.stderr.write(
          `[harness:session] Warning: disabling hook session cache (${reason}).\n`,
        )
      },
    },
    requireExistingFile,
  )

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
  treeHash?: string,
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
      hostIo.writeTextSync(
        tmpPath,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          ...(treeHash !== undefined ? { treeHash } : {}),
        }),
      )
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

export const readLastDoneMarker = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): LastDoneMarker | undefined => {
  const env = hostIo.getEnv()
  const harnessDir = unwrapOption(resolveHarnessStateDirSafe(repoRoot, env))
  if (harnessDir === undefined) return undefined
  const markerPath = join(harnessDir, "last-done.json")
  if (!isSafeCacheDirAndPath(repoRoot, harnessDir, markerPath, hostIo, true)) return undefined
  return match(Result.try(() => hostIo.readTextSync(markerPath)))
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(`[harness:done] Warning: Failed to read last-done.json: ${msg}\n`)
      return undefined
    })
    .with({ _tag: "Success" }, ({ success }) => unwrapOption(decodeLastDoneMarker(success)))
    .exhaustive()
}

export const isAlreadyDoneForVerifiedTree = (
  repoRoot: string,
  stamp: { readonly treeHash: string; readonly timestamp: string },
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean => {
  if (
    options?.planGraph !== undefined ||
    options?.implGraph !== undefined ||
    (options?.planSteps !== undefined && options.planSteps.length > 0)
  ) {
    return false
  }
  const lastDone = readLastDoneMarker(repoRoot, hostIo)
  if (lastDone === undefined || lastDone.treeHash !== stamp.treeHash) return false
  const completedAtMs = Date.parse(lastDone.completedAt)
  const stampTsMs = Date.parse(stamp.timestamp)
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(stampTsMs) || stampTsMs > completedAtMs) {
    return false
  }
  const harnessDir = unwrapOption(resolveHarnessStateDirSafe(repoRoot, hostIo.getEnv()))
  if (harnessDir === undefined) return false
  const planPath = join(harnessDir, "plan-graph-snapshot.json")
  if (tryOr(() => hostIo.existsSync(planPath), true)) {
    if (!isSafeCacheDirAndPath(repoRoot, harnessDir, planPath, hostIo, true)) return false
    const planMtimeMs = hasStatMtimeMsSync(hostIo)
      ? tryOr(() => hostIo.statMtimeMsSync(planPath), undefined)
      : undefined
    if (planMtimeMs === undefined || !Number.isFinite(planMtimeMs) || planMtimeMs > completedAtMs) {
      return false
    }
  }
  return true
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
