import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { match } from "ts-pattern"
import {
  type RealPathWithAncestorWalkResult,
  resolveRealPathWithAncestorWalkLite,
} from "./hook-io-realpath.js"

const GraphHeadMetaLiteSchema = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
})
export type GraphHeadMetaLite = typeof GraphHeadMetaLiteSchema.Type
export type GitHeadStateLite = typeof GraphHeadMetaLiteSchema.Type
const decodeGraphHeadMetaLite = Schema.decodeOption(Schema.fromJsonString(GraphHeadMetaLiteSchema))

const GraphSnapshotLiteSchema = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
  edges: Schema.Array(Schema.Unknown),
})
const decodeGraphSnapshotLite = Schema.decodeOption(Schema.fromJsonString(GraphSnapshotLiteSchema))

export interface HookStdinOk {
  readonly _tag: "Ok"
  readonly text: string
}

export interface HookStdinFailed {
  readonly _tag: "Failed"
  readonly reason: string
}

export type HookStdinReadResult = HookStdinOk | HookStdinFailed

const HookTelemetrySurfaceSchema = Schema.Literals(["hook", "cli"])
const HookTelemetryCategorySchema = Schema.Literals(["guard", "lifecycle"])
const HookTelemetryOutcomeSchema = Schema.Literals(["ok", "deny", "ask", "fail"])

export interface HookTelemetryLiteInput {
  readonly repoRoot: string
  readonly cliRepoRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly surface: typeof HookTelemetrySurfaceSchema.Type
  readonly category: typeof HookTelemetryCategorySchema.Type
  readonly toolName: string
  readonly outcome: typeof HookTelemetryOutcomeSchema.Type
  readonly durationMs: number
  readonly detail?: string | undefined
}

export interface PreInvocationCacheLiteHit {
  readonly _tag: "Hit"
  readonly stdout: string
  readonly stderr: string
}

export interface PreInvocationCacheLiteMiss {
  readonly _tag: "Miss"
  readonly fingerprint: Option.Option<string>
}

export type PreInvocationCacheLiteLookup = PreInvocationCacheLiteHit | PreInvocationCacheLiteMiss

export interface PreInvocationCacheLiteInput {
  readonly repoRoot: string
  readonly cliRepoRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface HookStdinReadOptions {
  readonly timeoutMs: number
  readonly maxBytes: number
}

const PRE_INVOCATION_CACHE_TTL_MS = 300_000
const DEGRADED_PRE_INVOCATION_CACHE_TTL_MS = 30_000

const PreInvocationCacheLiteSchema = Schema.Struct({
  version: Schema.Literal("session-preinvocation-v1"),
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  recordedAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ollamaReady: Schema.Boolean,
  ollamaProbed: Schema.Boolean,
  degraded: Schema.optional(Schema.Boolean),
  injectSteps: Schema.Array(Schema.String),
  stderr: Schema.String,
})
const decodePreInvocationCacheLite = Schema.decodeOption(
  Schema.fromJsonString(PreInvocationCacheLiteSchema),
)

const tryOr = <A>(fn: () => A, fallback: A): A =>
  match(Result.try(fn))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => fallback)
    .exhaustive()

const unwrapOpt = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const findWorkspaceRootLite = (startDir: string = process.cwd(), fallbackRoot?: string): string => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) return curr
    curr = dirname(curr)
  }
  return resolve(fallbackRoot ?? startDir)
}

const isInsideRootLite = (rootDir: string, candidatePath: string): boolean => {
  const rel = relative(resolve(rootDir), resolve(candidatePath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const shouldSuppressLiveRepoTestSideEffectsLite = (
  targetRepoRoot: string,
  cliRepoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean =>
  (env["HARNESS_DISABLE_LIVE_TELEMETRY"] === "1" ||
    env["HARNESS_TEST_ISOLATION"] === "1" ||
    env["VITEST"] === "true" ||
    env["NODE_ENV"] === "test") &&
  (env["HARNESS_STATE_DIR"] === undefined || env["HARNESS_STATE_DIR"].trim() === "") &&
  isInsideRootLite(cliRepoRoot, targetRepoRoot)

const resolveHarnessStateDirLite = (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Option.Option<string> => {
  const trimmedRoot = repoRoot.trim()
  if (trimmedRoot.length === 0 || trimmedRoot.includes("\0") || trimmedRoot.length > 4096) {
    return Option.none()
  }
  const validRoot = resolve(trimmedRoot)
  const rawCustomDir = env["HARNESS_STATE_DIR"]
  if (rawCustomDir !== undefined && rawCustomDir.length > 0) {
    const customTrim = rawCustomDir.trim()
    if (customTrim !== rawCustomDir || customTrim.includes("\0") || customTrim.length > 4096) {
      return Option.none()
    }
    const resolved = resolve(validRoot, customTrim)
    return resolved === validRoot || resolved === dirname(resolved)
      ? Option.none()
      : Option.some(resolved)
  }
  const rawWorktreeId = env["HARNESS_WORKTREE_ID"]
  if (rawWorktreeId !== undefined && rawWorktreeId.length > 0) {
    const trimmedId = rawWorktreeId.trim()
    if (trimmedId.includes("\0") || trimmedId.length > 4096) return Option.none()
    const sanitized = trimmedId.replace(/[^a-zA-Z0-9._-]/g, "_")
    if (/^\.+$/.test(sanitized) || sanitized.length === 0) return Option.none()
    return Option.some(join(validRoot, ".harness", "worktrees", sanitized))
  }
  return Option.some(join(validRoot, ".harness"))
}

const existsRegularFileLite = (filePath: string): boolean =>
  tryOr(() => {
    const st = lstatSync(filePath)
    return !st.isSymbolicLink() && st.isFile()
  }, false)

const resolveGitDirsLite = (
  repoRoot: string,
): { readonly gitDir: string; readonly commonGitDir: string } | null => {
  const absRoot = resolve(repoRoot)
  const dotGit = join(absRoot, ".git")
  if (!existsSync(dotGit)) return null
  const st = tryOr(() => statSync(dotGit), undefined)
  if (st?.isDirectory() === true) return { gitDir: dotGit, commonGitDir: dotGit }
  if (st?.isFile() === true) {
    const content = readFileSync(dotGit, "utf8").trim()
    if (content.startsWith("gitdir:")) {
      const gitDir = resolve(absRoot, content.slice("gitdir:".length).trim())
      const commonDirFile = join(gitDir, "commondir")
      if (existsSync(commonDirFile)) {
        return { gitDir, commonGitDir: resolve(gitDir, readFileSync(commonDirFile, "utf8").trim()) }
      }
      return { gitDir, commonGitDir: gitDir }
    }
  }
  return null
}

const resolveRefShaLite = (
  gitDir: string,
  commonGitDir: string,
  refPath: string,
): string | null => {
  for (const dir of [gitDir, commonGitDir]) {
    const f = join(dir, refPath)
    if (existsRegularFileLite(f)) {
      const sha = readFileSync(f, "utf8").trim()
      if (sha.length > 0) return sha
    }
  }
  const packed = join(commonGitDir, "packed-refs")
  if (existsRegularFileLite(packed)) {
    for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
      const t = line.trim()
      if (t.length === 0 || t.startsWith("#") || t.startsWith("^")) continue
      const idx = t.indexOf(" ")
      if (idx > 0 && t.slice(idx + 1).trim() === refPath) {
        const sha = t.slice(0, idx).trim()
        if (sha.length > 0) return sha
      }
    }
  }
  return null
}

const resolveGitHeadStateLite = (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHeadStateLite => {
  const envBranch = env["HARNESS_GIT_BRANCH"]?.trim()
  const envSha = env["HARNESS_GIT_HEAD_SHA"]?.trim()
  const fallback: GitHeadStateLite = {
    gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
    headSha: envSha && envSha.length > 0 ? envSha : null,
  }
  const dotGit = join(resolve(repoRoot), ".git")
  if (!existsSync(dotGit)) return fallback
  return match(
    Result.try((): GitHeadStateLite => {
      const dirs = resolveGitDirsLite(repoRoot)
      if (dirs === null) return fallback
      const headFile = join(dirs.gitDir, "HEAD")
      if (!existsSync(headFile)) return fallback
      const headContent = readFileSync(headFile, "utf8").trim()
      if (headContent.startsWith("ref:")) {
        const refPath = headContent.slice("ref:".length).trim()
        const detectedBranch = refPath.startsWith("refs/heads/")
          ? refPath.slice("refs/heads/".length)
          : null
        const detectedSha = resolveRefShaLite(dirs.gitDir, dirs.commonGitDir, refPath)
        return {
          gitBranch: envBranch && envBranch.length > 0 ? envBranch : detectedBranch,
          headSha: envSha && envSha.length > 0 ? envSha : detectedSha,
        }
      }
      return {
        gitBranch: envBranch && envBranch.length > 0 ? envBranch : null,
        headSha: envSha && envSha.length > 0 ? envSha : headContent.length > 0 ? headContent : null,
      }
    }),
  )
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(`[harness:hook-io] Warning: failed to read git HEAD state: ${msg}\n`)
      return fallback
    })
    .exhaustive()
}

const readGraphHeadMetaLite = (harnessDir: string): Option.Option<GraphHeadMetaLite> => {
  const metaPath = join(harnessDir, "graph-head.json")
  if (!existsRegularFileLite(metaPath)) return Option.none()
  const raw = tryOr(() => readFileSync(metaPath, "utf8"), undefined)
  return raw === undefined ? Option.none() : decodeGraphHeadMetaLite(raw)
}

const isIngestSnapshotUpToDateLite = (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const harnessDir = unwrapOpt(resolveHarnessStateDirLite(repoRoot, env))
  if (harnessDir === undefined) return false
  const snapshotPath = join(harnessDir, "graph-snapshot.json")
  const metaPath = join(harnessDir, "graph-head.json")
  if (!isSafeHarnessLeafPath(repoRoot, harnessDir, snapshotPath, env)) return false
  if (!isSafeHarnessLeafPath(repoRoot, harnessDir, metaPath, env)) return false
  const rawSnapshot = tryOr(() => readFileSync(snapshotPath, "utf8"), undefined)
  if (rawSnapshot === undefined || unwrapOpt(decodeGraphSnapshotLite(rawSnapshot)) === undefined) {
    return false
  }
  const meta = unwrapOpt(readGraphHeadMetaLite(harnessDir))
  if (meta === undefined) return false
  const head = resolveGitHeadStateLite(repoRoot, env)
  return meta.headSha === head.headSha && meta.gitBranch === head.gitBranch
}

const readHookStdinCallback = (
  opts: HookStdinReadOptions,
  onDone: (res: HookStdinReadResult) => void,
): void => {
  if (process.stdin.isTTY === true || process.stdin.readableEnded) {
    onDone({ _tag: "Ok", text: "" })
    return
  }
  if (process.stdin.destroyed) {
    onDone({ _tag: "Failed", reason: "Stdin stream is already destroyed" })
    return
  }
  const chunks: Array<Buffer> = []
  let totalBytes = 0
  let settled = false
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined = undefined
  const noopError = (): void => {}
  const finish = (res: HookStdinReadResult, destroyStream: boolean = false): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    process.stdin.off("data", onData)
    process.stdin.off("end", onEnd)
    process.stdin.off("close", onClose)
    process.stdin.off("error", onError)
    process.stdin.pause()
    if (typeof process.stdin.unref === "function") {
      process.stdin.unref()
    }
    if (destroyStream) {
      match(res)
        .with({ _tag: "Failed" }, () => {
          process.stdin.on("error", noopError)
          process.stdin.destroy()
          process.stdin.off("error", noopError)
        })
        .with({ _tag: "Ok" }, () => undefined)
        .exhaustive()
    }
    onDone(res)
  }
  const onData = (chunk: Buffer | string): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    totalBytes += buf.byteLength
    if (totalBytes > opts.maxBytes) {
      finish(
        {
          _tag: "Failed",
          reason: `Stdin payload exceeded maximum size of ${opts.maxBytes} bytes`,
        },
        true,
      )
      return
    }
    chunks.push(buf)
  }
  const onEnd = (): void => {
    ended = true
    finish({ _tag: "Ok", text: Buffer.concat(chunks).toString("utf8") })
  }
  const onClose = (): void => {
    if (ended || process.stdin.readableEnded) {
      finish({ _tag: "Ok", text: Buffer.concat(chunks).toString("utf8") })
      return
    }
    finish({
      _tag: "Failed",
      reason: "Stdin stream closed prematurely before end",
    })
  }
  const onError = (err: unknown): void => {
    finish({
      _tag: "Failed",
      reason: `Stdin stream error: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  timer = setTimeout(() => {
    finish({ _tag: "Failed", reason: `Timed out reading stdin after ${opts.timeoutMs}ms` }, true)
  }, opts.timeoutMs)
  process.stdin.on("data", onData)
  process.stdin.once("end", onEnd)
  process.stdin.once("close", onClose)
  process.stdin.once("error", onError)
  process.stdin.resume()
}

const appendHookTelemetryLite = (input: HookTelemetryLiteInput): void => {
  const env = input.env ?? process.env
  if (shouldSuppressLiveRepoTestSideEffectsLite(input.repoRoot, input.cliRepoRoot, env)) return
  const harnessDir = unwrapOpt(resolveHarnessStateDirLite(input.repoRoot, env))
  if (harnessDir === undefined) return
  match(
    Result.try(() => {
      if (!existsSync(harnessDir)) mkdirSync(harnessDir, { recursive: true })
      const entry = {
        timestamp: new Date().toISOString(),
        surface: input.surface,
        category: input.category,
        toolName: input.toolName,
        outcome: input.outcome,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      }
      appendFileSync(join(harnessDir, "telemetry-log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8")
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const msg = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(`[harness:hook-io] Warning: failed to append hook telemetry: ${msg}\n`)
    })
    .exhaustive()
}

export interface PreInvocationFingerprintIo {
  readonly repoRoot: string
  readonly harnessDir: string
  readonly existsSync: (filePath: string) => boolean
  readonly isFileSync: (filePath: string) => boolean
  readonly isSymbolicLinkSync: (filePath: string) => boolean
  readonly readBytesSync: (filePath: string) => Uint8Array
  readonly statMtimeMsSync?: ((filePath: string) => number | undefined) | undefined
  readonly getEnv: () => Readonly<Record<string, string | undefined>>
  readonly resolveHead: () => GitHeadStateLite
  readonly resolveTsconfigPath: () => string
  readonly resolveTsgoPkgJsonPath: () => string
  readonly skipBackgroundDaemons?: boolean | undefined
  readonly hasDecisionLayer?: boolean | undefined
}

export interface SafeHarnessLeafPathIo {
  readonly existsSync: (filePath: string) => boolean
  readonly isFileSync: (filePath: string) => boolean
  readonly isSymbolicLinkSync: (filePath: string) => boolean
  readonly realpathSync: (filePath: string) => string
  readonly getEnv: () => Readonly<Record<string, string | undefined>>
  readonly onUnsafe?: ((reason: string) => void) | undefined
}

const isSymbolicLinkLite = (filePath: string): boolean => {
  const st = lstatSync(filePath, { throwIfNoEntry: false })
  return st !== undefined && st.isSymbolicLink()
}

const isFileLite = (filePath: string): boolean => {
  const st = lstatSync(filePath, { throwIfNoEntry: false })
  return st !== undefined && !st.isSymbolicLink() && st.isFile()
}

type DigestFileMode = "content" | "mtime" | "existence"

const digestFileFromIo = (
  filePath: string,
  io: Pick<
    PreInvocationFingerprintIo,
    "existsSync" | "isFileSync" | "isSymbolicLinkSync" | "readBytesSync" | "statMtimeMsSync"
  >,
  mode: DigestFileMode,
): Option.Option<string> => {
  const isSym = tryOr(() => io.isSymbolicLinkSync(filePath), true)
  if (isSym) return Option.none()
  const exists = tryOr(() => io.existsSync(filePath), undefined)
  if (exists === undefined) return Option.none()
  if (!exists) {
    return match(mode)
      .with("existence", () => Option.some("missing"))
      .with("content", "mtime", () => Option.some("absent"))
      .exhaustive()
  }
  const isFile = tryOr(() => io.isFileSync(filePath), false)
  if (!isFile) return Option.none()
  return match(mode)
    .with("existence", () => Option.some("present"))
    .with("content", () => {
      const hex = tryOr(
        () => createHash("sha256").update(io.readBytesSync(filePath)).digest("hex"),
        undefined,
      )
      return Option.fromUndefinedOr(hex)
    })
    .with("mtime", () => {
      const statFn = io.statMtimeMsSync
      const meta =
        statFn !== undefined
          ? tryOr(() => {
              const mtime = statFn(filePath)
              return mtime !== undefined ? `mtime:${String(mtime)}` : undefined
            }, undefined)
          : tryOr(() => `len:${String(io.readBytesSync(filePath).length)}`, undefined)
      return Option.fromUndefinedOr(meta)
    })
    .exhaustive()
}

const computePreInvocationFingerprintFromIo = (
  io: PreInvocationFingerprintIo,
): Option.Option<string> => {
  if (!tryOr(() => io.existsSync(join(io.repoRoot, ".git")), false)) return Option.none()
  const head = io.resolveHead()
  if (head.gitBranch === null && head.headSha === null) return Option.none()
  const hash = createHash("sha256")
  hash.update(`branch:${head.gitBranch ?? ""}\nsha:${head.headSha ?? ""}\n`)
  const stateInputs: ReadonlyArray<readonly [string, DigestFileMode]> = [
    ["friction-log.jsonl", "content"],
    ["verify-stamp.json", "content"],
    ["mutate-stamp.json", "content"],
    ["plan-graph-snapshot.json", "existence"],
    ["graph-head.json", "content"],
    ["graph-snapshot.json", "existence"],
    ["last-done.json", "content"],
  ]
  for (const [f, mode] of stateInputs) {
    const d = unwrapOpt(digestFileFromIo(join(io.harnessDir, f), io, mode))
    if (d === undefined) return Option.none()
    hash.update(`state:${f}:${d}\n`)
  }
  const fixedInputs: ReadonlyArray<readonly [string, string, DigestFileMode]> = [
    ["tsgo", io.resolveTsgoPkgJsonPath(), "mtime"],
    ["tsconfig", io.resolveTsconfigPath(), "content"],
    ["cluster", join(io.repoRoot, "libs/harness/graph/cluster.yaml"), "content"],
    ["devvars", join(io.repoRoot, ".dev.vars"), "mtime"],
    ["envfile", join(io.repoRoot, ".env"), "mtime"],
  ]
  for (const [label, path, mode] of fixedInputs) {
    const d = unwrapOpt(digestFileFromIo(path, io, mode))
    if (d === undefined) return Option.none()
    hash.update(`${label}:${d}\n`)
  }
  const env = io.getEnv()
  hash.update(
    `env:${env["HARNESS_OLLAMA_URL"] ?? env["OLLAMA_HOST"] ?? ""}|${env["OMNIGRAPH_URL"] ?? ""}|${String(Boolean(io.skipBackgroundDaemons))}|${String(Boolean(io.hasDecisionLayer))}\n`,
  )
  return Option.some(hash.digest("hex"))
}

const computeFingerprintLite = (
  repoRoot: string,
  cliRepoRoot: string,
  harnessDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Option.Option<string> => {
  const wsRoot = findWorkspaceRootLite(cliRepoRoot)
  return computePreInvocationFingerprintFromIo({
    repoRoot,
    harnessDir,
    existsSync,
    isFileSync: isFileLite,
    isSymbolicLinkSync: isSymbolicLinkLite,
    readBytesSync: (filePath) => readFileSync(filePath),
    statMtimeMsSync: (filePath) => statSync(filePath).mtimeMs,
    getEnv: () => env,
    resolveHead: () => resolveGitHeadStateLite(repoRoot, env),
    resolveTsgoPkgJsonPath: () => {
      const localTsgo = join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
      return tryOr(() => existsSync(localTsgo), false)
        ? localTsgo
        : join(wsRoot, "node_modules", "@effect", "tsgo", "package.json")
    },
    resolveTsconfigPath: () => {
      const repoTsconfig = join(repoRoot, "tsconfig.base.json")
      return tryOr(() => existsSync(repoTsconfig), false)
        ? repoTsconfig
        : join(wsRoot, "tsconfig.base.json")
    },
  })
}

const isSafeHarnessLeafPathWith = (
  repoRoot: string,
  harnessDir: string,
  leafPath: string,
  io: SafeHarnessLeafPathIo,
  requireExistingFile: boolean = true,
): boolean => {
  const absRepo = resolve(repoRoot)
  const absHarness = resolve(harnessDir)
  const absLeaf = resolve(leafPath)
  const env = io.getEnv()
  const hasOverride = env["HARNESS_STATE_DIR"] !== undefined && env["HARNESS_STATE_DIR"] !== ""
  const inRepo = isInsideRootLite(absRepo, absHarness)

  const failUnsafe = (reason: string): false => {
    io.onUnsafe?.(reason)
    return false
  }

  const hasSymlinkAncestor = (targetPath: string, stopAt: string): boolean => {
    let curr = targetPath
    while (true) {
      if (tryOr(() => io.isSymbolicLinkSync(curr), true)) return true
      if (curr === stopAt) return false
      const parent = dirname(curr)
      if (parent === curr) return false
      curr = parent
    }
  }

  if (tryOr(() => io.isSymbolicLinkSync(absHarness), true)) {
    return failUnsafe(`symlink detected at ${harnessDir}`)
  }
  if (
    hasSymlinkAncestor(absHarness, inRepo ? absRepo : absHarness) ||
    hasSymlinkAncestor(absLeaf, inRepo ? absRepo : absHarness)
  ) {
    return failUnsafe(`symlink detected in ${leafPath}`)
  }

  if (!hasOverride || inRepo) {
    let anchor: string | undefined = absHarness
    while (anchor !== undefined && !tryOr(() => io.existsSync(anchor!), false)) {
      const parent = dirname(anchor)
      anchor = parent === anchor ? undefined : parent
    }
    const realRepo = tryOr(() => io.realpathSync(absRepo), undefined)
    const realAnchor =
      anchor !== undefined ? tryOr(() => io.realpathSync(anchor), undefined) : undefined
    if (
      realRepo === undefined ||
      realAnchor === undefined ||
      !isInsideRootLite(realRepo, realAnchor)
    ) {
      return failUnsafe(`cache dir ${harnessDir} resolves outside repoRoot`)
    }
  }
  if (tryOr(() => io.existsSync(absLeaf), true)) {
    if (!tryOr(() => io.isFileSync(absLeaf), false)) {
      return failUnsafe(`cache path ${leafPath} is not a regular file`)
    }
    const realHarness = tryOr(() => io.realpathSync(absHarness), undefined)
    const realLeaf = tryOr(() => io.realpathSync(absLeaf), undefined)
    if (
      realHarness === undefined ||
      realLeaf === undefined ||
      !isInsideRootLite(realHarness, realLeaf)
    ) {
      return failUnsafe(`cache path ${leafPath} resolves outside ${harnessDir}`)
    }
    if (inRepo) {
      const realRepo = tryOr(() => io.realpathSync(absRepo), undefined)
      if (realRepo === undefined || !isInsideRootLite(realRepo, realLeaf)) {
        return failUnsafe(`cache path ${leafPath} resolves outside ${repoRoot}`)
      }
    }
    return true
  }
  return !requireExistingFile
}

const isSafeHarnessLeafPath = (
  repoRoot: string,
  harnessDir: string,
  leafPath: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  isSafeHarnessLeafPathWith(
    repoRoot,
    harnessDir,
    leafPath,
    {
      existsSync,
      isFileSync: isFileLite,
      isSymbolicLinkSync: isSymbolicLinkLite,
      realpathSync,
      getEnv: () => env,
    },
    true,
  )

const isSafeSessionCachePath = (
  repoRoot: string,
  harnessDir: string,
  cachePath: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean => isSafeHarnessLeafPath(repoRoot, harnessDir, cachePath, env)

const tryReadPreInvocationCacheLite = (
  input: PreInvocationCacheLiteInput,
): PreInvocationCacheLiteLookup => {
  const env = input.env ?? process.env
  if (env["HARNESS_REQUIRE_OLLAMA"] === "1") {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const harnessDir = unwrapOpt(resolveHarnessStateDirLite(input.repoRoot, env))
  if (harnessDir === undefined) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const cachePath = join(harnessDir, "session-preinvocation-cache.json")
  if (!isSafeSessionCachePath(input.repoRoot, harnessDir, cachePath, env)) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const raw = tryOr(() => readFileSync(cachePath, "utf8"), undefined)
  if (raw === undefined) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const cached = unwrapOpt(decodePreInvocationCacheLite(raw))
  if (cached === undefined) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const effectiveTtlMs =
    cached.degraded === true ? DEGRADED_PRE_INVOCATION_CACHE_TTL_MS : PRE_INVOCATION_CACHE_TTL_MS
  const ageMs = Date.now() - cached.recordedAtMs
  if (ageMs < 0 || ageMs > effectiveTtlMs) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const requireOllama =
    existsSync(join(input.repoRoot, "libs", "harness", "graph", "cluster.yaml")) ||
    (env["OMNIGRAPH_URL"] !== undefined &&
      env["OMNIGRAPH_URL"].trim() !== "" &&
      env["OMNIGRAPH_URL"] !== "http://127.0.0.1:8080") ||
    tryOr(
      () => realpathSync(input.repoRoot) === realpathSync(input.cliRepoRoot),
      resolve(input.repoRoot) === resolve(input.cliRepoRoot),
    )
  if (requireOllama && (!cached.ollamaProbed || !cached.ollamaReady)) {
    return { _tag: "Miss", fingerprint: Option.none() }
  }
  const fp = computeFingerprintLite(input.repoRoot, input.cliRepoRoot, harnessDir, env)
  const fpVal = unwrapOpt(fp)
  if (fpVal !== undefined && fpVal === cached.fingerprint) {
    return {
      _tag: "Hit",
      stdout: JSON.stringify({ injectSteps: cached.injectSteps }),
      stderr: cached.stderr,
    }
  }
  return { _tag: "Miss", fingerprint: fp }
}

const resolveRealPathLite = (targetPath: string): Option.Option<string> =>
  match(Result.try(() => realpathSync(targetPath)))
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()

export { availableParallelism as getHostAvailableParallelism } from "node:os"

export {
  appendHookTelemetryLite,
  computePreInvocationFingerprintFromIo,
  computeFingerprintLite as computePreInvocationFingerprintLite,
  existsRegularFileLite,
  findWorkspaceRootLite,
  isIngestSnapshotUpToDateLite,
  isInsideRootLite,
  isSafeHarnessLeafPathWith,
  readGraphHeadMetaLite,
  readHookStdinCallback,
  resolveGitHeadStateLite,
  resolveHarnessStateDirLite,
  resolveRealPathLite,
  resolveRealPathWithAncestorWalkLite,
  type RealPathWithAncestorWalkResult,
  shouldSuppressLiveRepoTestSideEffectsLite,
  tryReadPreInvocationCacheLite,
}
