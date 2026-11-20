import { execFileSync } from "node:child_process"
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

const GIT_FINGERPRINT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const GIT_IGNORED_LS_FILES_ARGS: ReadonlyArray<string> = [
  "--no-optional-locks",
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "-z",
  "--",
  ".",
  ":(exclude,top).nx",
  ":(exclude,top).harness",
  ":(exclude,top)repos",
  ":(exclude,top).worktrees",
  ":(exclude,top).git",
  ":(exclude,top).superpowers",
  ":(exclude,top).alchemy",
  ":(exclude,top).remember",
  ":(exclude,top).idea",
  ":(exclude,top).vscode",
  ":(exclude,top)node_modules",
  ":(exclude,top)dist",
  ":(exclude,top)coverage",
  ":(exclude,top).vite",
  ":(exclude,glob)apps/*/node_modules/**",
  ":(exclude,glob)libs/*/node_modules/**",
  ":(exclude,glob)libs/*/*/node_modules/**",
  ":(exclude,glob)packages/*/node_modules/**",
  ":(exclude,glob)adapters/*/node_modules/**",
  ":(exclude,glob)tools/*/node_modules/**",
]

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

const PreInvocationCacheLiteSchema = Schema.Struct({
  version: Schema.Literal("session-preinvocation-v1"),
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  recordedAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ollamaReady: Schema.Boolean,
  ollamaProbed: Schema.Boolean,
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
  (env["HARNESS_DISABLE_LIVE_TELEMETRY"] === "1" || env["HARNESS_TEST_ISOLATION"] === "1") &&
  (env["HARNESS_STATE_DIR"] === undefined || env["HARNESS_STATE_DIR"].trim() === "") &&
  resolve(targetRepoRoot) === resolve(cliRepoRoot)

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
    return resolved === validRoot ? Option.none() : Option.some(resolved)
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

const ROOT_IGNORED = new Set([
  ".git",
  ".superpowers",
  "repos",
  ".idea",
  ".vscode",
  ".alchemy",
  ".remember",
  ".worktrees",
])
const ARTIFACT_IGNORED = new Set([
  ".harness",
  ".nx",
  "node_modules",
  "dist",
  "coverage",
  ".DS_Store",
  ".vite",
])

const isStampIncludedLite = (relPath: string): boolean => {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (norm.length === 0) return false
  const parts = norm.split("/")
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i]!
    const relDir = i === 0 ? "" : parts.slice(0, i).join("/")
    if (i === 0 && (ROOT_IGNORED.has(seg) || /^(?:temp-|__temp_)/.test(seg))) return false
    if (!/(?:^|\/)(?:src|test)(?:\/|$)/.test(relDir) && ARTIFACT_IGNORED.has(seg)) return false
  }
  return true
}

const lstatNoThrow = (filePath: string) =>
  Result.try(() => lstatSync(filePath, { throwIfNoEntry: false }))

const digestFileLite = (filePath: string, contentHash: boolean): Option.Option<string> =>
  match(lstatNoThrow(filePath))
    .with({ _tag: "Failure" }, () => Option.none())
    .with({ _tag: "Success" }, ({ success: st }) => {
      if (st === undefined) return Option.some("absent")
      if (st.isSymbolicLink() || !st.isFile()) return Option.none()
      if (contentHash) {
        const hex = tryOr(
          () => createHash("sha256").update(readFileSync(filePath)).digest("hex"),
          undefined,
        )
        return Option.fromUndefinedOr(hex)
      }
      return Option.fromUndefinedOr(
        tryOr(() => `mtime:${String(statSync(filePath).mtimeMs)}`, undefined),
      )
    })
    .exhaustive()

const digestWorkspaceRelPath = (repoRoot: string, relPath: string): string | undefined => {
  const abs = join(repoRoot, relPath)
  return match(lstatNoThrow(abs))
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success: st }) => {
      if (st === undefined) return "deleted"
      if (st.isSymbolicLink()) return undefined
      if (tryOr(() => existsSync(join(abs, ".git")), true)) return undefined
      return unwrapOpt(digestFileLite(abs, true))
    })
    .exhaustive()
}

const computeFingerprintLite = (
  repoRoot: string,
  cliRepoRoot: string,
  harnessDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Option.Option<string> => {
  if (!existsSync(join(repoRoot, ".git"))) return Option.none()
  const statusOut = tryOr(
    () =>
      execFileSync(
        "git",
        ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        {
          cwd: repoRoot,
          timeout: 2_000,
          maxBuffer: GIT_FINGERPRINT_MAX_BUFFER_BYTES,
          encoding: "utf8",
        },
      ),
    undefined,
  )
  if (statusOut === undefined) return Option.none()
  const head = resolveGitHeadStateLite(repoRoot, env)
  if (head.gitBranch === null && head.headSha === null) return Option.none()
  const relHarness = relative(repoRoot, harnessDir).replace(/\\/g, "/")
  const customRel =
    relHarness.length > 0 &&
    relHarness !== "." &&
    !relHarness.startsWith("..") &&
    !isAbsolute(relHarness)
      ? relHarness
      : undefined
  const isHarnessRel = (p: string): boolean =>
    p === ".harness" ||
    p.startsWith(".harness/") ||
    (customRel !== undefined && (p === customRel || p.startsWith(`${customRel}/`)))
  const hash = createHash("sha256")
  hash.update(`branch:${head.gitBranch ?? ""}\nsha:${head.headSha ?? ""}\n`)
  const seen = new Set<string>()
  const entries = statusOut.split("\0")
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const relPath = entry.slice(3)
    if (xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C") {
      const orig = entries[i + 1] ?? ""
      i += 1
      if (orig.length > 0 && !isHarnessRel(orig)) hash.update(`renamed-from:${orig}\n`)
    }
    if (relPath.length === 0 || isHarnessRel(relPath)) continue
    seen.add(relPath)
    const d = digestWorkspaceRelPath(repoRoot, relPath)
    if (d === undefined) return Option.none()
    hash.update(`dirty:${xy}:${relPath}:${d}\n`)
  }
  const ignoredOut = tryOr(
    () =>
      execFileSync("git", GIT_IGNORED_LS_FILES_ARGS, {
        cwd: repoRoot,
        timeout: 2_000,
        maxBuffer: GIT_FINGERPRINT_MAX_BUFFER_BYTES,
        encoding: "utf8",
      }),
    undefined,
  )
  if (ignoredOut === undefined) return Option.none()
  for (const relPath of ignoredOut.split("\0")) {
    if (
      relPath.length === 0 ||
      seen.has(relPath) ||
      isHarnessRel(relPath) ||
      relPath === ".env" ||
      relPath === ".dev.vars" ||
      !isStampIncludedLite(relPath)
    ) {
      continue
    }
    const d = digestWorkspaceRelPath(repoRoot, relPath)
    if (d === undefined) return Option.none()
    hash.update(`ignored:${relPath}:${d}\n`)
  }
  for (const f of [
    "friction-log.jsonl",
    "telemetry.jsonl",
    "verify-stamp.json",
    "mutate-stamp.json",
    "plan-graph-snapshot.json",
    "graph-head.json",
    "graph-snapshot.json",
    "last-done.json",
  ]) {
    const d = unwrapOpt(digestFileLite(join(harnessDir, f), true))
    if (d === undefined) return Option.none()
    hash.update(`state:${f}:${d}\n`)
  }
  const localTsgo = join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
  const wsRoot = findWorkspaceRootLite(cliRepoRoot)
  const tsgoPath = existsSync(localTsgo)
    ? localTsgo
    : join(wsRoot, "node_modules", "@effect", "tsgo", "package.json")
  const repoTsconfig = join(repoRoot, "tsconfig.base.json")
  const tsconfigPath = existsSync(repoTsconfig) ? repoTsconfig : join(wsRoot, "tsconfig.base.json")
  const fixedInputs: ReadonlyArray<readonly [string, string, boolean]> = [
    ["tsgo", tsgoPath, false],
    ["tsconfig", tsconfigPath, true],
    ["cluster", join(repoRoot, "libs/harness/graph/cluster.yaml"), true],
    ["devvars", join(repoRoot, ".dev.vars"), false],
    ["envfile", join(repoRoot, ".env"), false],
  ]
  for (const [label, path, contentHash] of fixedInputs) {
    const d = unwrapOpt(digestFileLite(path, contentHash))
    if (d === undefined) return Option.none()
    hash.update(`${label}:${d}\n`)
  }
  hash.update(
    `env:${env["HARNESS_OLLAMA_URL"] ?? env["OLLAMA_HOST"] ?? ""}|${env["OMNIGRAPH_URL"] ?? ""}|false|false\n`,
  )
  return Option.some(hash.digest("hex"))
}

const isSafeHarnessLeafPath = (
  repoRoot: string,
  harnessDir: string,
  leafPath: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const absRepo = resolve(repoRoot)
  const absHarness = resolve(harnessDir)
  const absLeaf = resolve(leafPath)
  const hasOverride = env["HARNESS_STATE_DIR"] !== undefined && env["HARNESS_STATE_DIR"] !== ""
  const inRepo = isInsideRootLite(absRepo, absHarness)

  const checkNoSymlink = (targetPath: string, stopAt: string): boolean => {
    let curr = targetPath
    while (true) {
      const isSymOrErr = match(lstatNoThrow(curr))
        .with({ _tag: "Failure" }, () => true)
        .with({ _tag: "Success" }, ({ success: st }) => st !== undefined && st.isSymbolicLink())
        .exhaustive()
      if (isSymOrErr) return false
      if (curr === stopAt) break
      const parent = dirname(curr)
      if (parent === curr) break
      curr = parent
    }
    return true
  }

  if (!checkNoSymlink(absLeaf, absHarness)) return false
  if (!checkNoSymlink(absHarness, inRepo ? absRepo : absHarness)) return false

  if (!hasOverride || inRepo) {
    let anchor = absHarness
    while (!existsSync(anchor)) {
      const parent = dirname(anchor)
      if (parent === anchor) return false
      anchor = parent
    }
    const realRepo = tryOr(() => realpathSync(absRepo), undefined)
    const realAnchor = tryOr(() => realpathSync(anchor), undefined)
    if (
      realRepo === undefined ||
      realAnchor === undefined ||
      !isInsideRootLite(realRepo, realAnchor)
    ) {
      return false
    }
  }
  if (!existsRegularFileLite(absLeaf)) return false
  const realHarness = tryOr(() => realpathSync(absHarness), undefined)
  const realLeaf = tryOr(() => realpathSync(absLeaf), undefined)
  if (
    realHarness === undefined ||
    realLeaf === undefined ||
    !isInsideRootLite(realHarness, realLeaf)
  ) {
    return false
  }
  if (inRepo) {
    const realRepo = tryOr(() => realpathSync(absRepo), undefined)
    if (realRepo === undefined || !isInsideRootLite(realRepo, realLeaf)) return false
  }
  return true
}

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
  const ageMs = Date.now() - cached.recordedAtMs
  if (ageMs < 0 || ageMs > PRE_INVOCATION_CACHE_TTL_MS) {
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

export {
  GIT_FINGERPRINT_MAX_BUFFER_BYTES,
  GIT_IGNORED_LS_FILES_ARGS,
  appendHookTelemetryLite,
  computeFingerprintLite as computePreInvocationFingerprintLite,
  existsRegularFileLite,
  findWorkspaceRootLite,
  isIngestSnapshotUpToDateLite,
  isInsideRootLite,
  readGraphHeadMetaLite,
  readHookStdinCallback,
  resolveGitHeadStateLite,
  resolveHarnessStateDirLite,
  shouldSuppressLiveRepoTestSideEffectsLite,
  tryReadPreInvocationCacheLite,
}
