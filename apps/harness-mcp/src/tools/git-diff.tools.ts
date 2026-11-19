import * as path from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostExecExited } from "@harness/service/host-io"
import {
  GitDiffErrorReason,
  GitDiffExecutionError,
  isPathInsideRoot,
  McpToolName,
  type McpToolExecutionError,
  type McpToolPluginDescriptor,
  ProjectPathEscapeError,
  resolveDefaultRepoRoot,
  type ServerOptions,
} from "./mcp-helpers.js"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const DEFAULT_MAX_PATCH_CHARS = 120_000
const HARD_MAX_PATCH_CHARS = 400_000
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const BoundedRepoRoot = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024)))
const BoundedGitRef = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512)))
const BoundedDiffPath = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512)))

const hasWhitespaceOrControlChar = (value: string): boolean => {
  if (/\s/.test(value)) return true
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export const GitDiffToolInputSchema = Schema.Struct({
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path (defaults to the active workspace root)",
    }),
  ),
  baseRef: Schema.optional(
    BoundedGitRef.annotate({
      description:
        "Optional base git ref (e.g. main or HEAD~1) to diff via git merge-base <baseRef> HEAD against working tree plus untracked files",
    }),
  ),
  paths: Schema.optional(
    Schema.Array(BoundedDiffPath)
      .pipe(Schema.check(Schema.isMaxLength(200)))
      .annotate({ description: "Optional relative or repo-confined path filters passed after --" }),
  ),
  statOnly: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true, return only diffstat, changedFiles, and untrackedFiles without patches",
    }),
  ),
  maxPatchChars: Schema.optional(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: HARD_MAX_PATCH_CHARS })),
    ).annotate({
      description:
        "Maximum UTF-16 characters returned in patch output (default 120000, max 400000)",
    }),
  ),
})

export type GitDiffToolInput = typeof GitDiffToolInputSchema.Type

export interface GitDiffToolResult {
  readonly resolvedBase: string | null
  readonly stat: string
  readonly changedFiles: ReadonlyArray<string>
  readonly untrackedFiles: ReadonlyArray<string>
  readonly patch: string
  readonly totalPatchChars: number
  readonly truncated: boolean
}

const decodeGitDiffToolInput = Schema.decodeUnknownEffect(GitDiffToolInputSchema)

const toGitDiffReason = (raw: string): GitDiffErrorReason => {
  const trimmed = raw.trim()
  return GitDiffErrorReason.make(trimmed.length > 0 ? trimmed : "git diff execution failed")
}

const failGitDiff = (raw: string): Effect.Effect<never, GitDiffExecutionError> =>
  Effect.fail(new GitDiffExecutionError({ reason: toGitDiffReason(raw) }))

const validateBaseRef = (baseRef: string): Effect.Effect<string, GitDiffExecutionError> =>
  baseRef.length === 0 || baseRef.startsWith("-") || hasWhitespaceOrControlChar(baseRef)
    ? failGitDiff(
        "Invalid baseRef: must be a non-empty git ref without leading '-' or whitespace/control characters",
      )
    : Effect.succeed(baseRef)

const confineRepoPaths = (
  root: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ProjectPathEscapeError> =>
  Effect.forEach(paths, (rawPath) => {
    if (rawPath.startsWith(":") || rawPath.includes("\0")) {
      return Effect.fail(
        new ProjectPathEscapeError({
          projectPath: rawPath,
          repoRoot: root,
          message: `Path '${rawPath}' is not a valid repository-relative path.`,
        }),
      )
    }
    const resolvedPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(root, rawPath)
    if (!isPathInsideRoot(root, resolvedPath)) {
      return Effect.fail(
        new ProjectPathEscapeError({
          projectPath: rawPath,
          repoRoot: root,
          message: `Path '${rawPath}' escapes repository root '${root}'.`,
        }),
      )
    }
    const posixRel = path.relative(path.resolve(root), resolvedPath).split(path.sep).join("/")
    return Effect.succeed(posixRel.length > 0 ? posixRel : ".")
  })

const execGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<SyncHostExecExited, GitDiffExecutionError> =>
  Effect.try({
    try: () =>
      nodeSyncHostIo.execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBufferBytes: GIT_MAX_BUFFER_BYTES,
      }),
    catch: (err) =>
      new GitDiffExecutionError({
        reason: toGitDiffReason(err instanceof Error ? err.message : String(err)),
      }),
  }).pipe(
    Effect.flatMap((res) =>
      match(res)
        .with({ _tag: "Exited" }, (exited) => Effect.succeed(exited))
        .with({ _tag: "TimedOut" }, () =>
          failGitDiff(`git ${args[0] ?? ""} timed out after ${String(GIT_TIMEOUT_MS)}ms`),
        )
        .with({ _tag: "Signaled" }, ({ signal }) =>
          failGitDiff(`git ${args[0] ?? ""} terminated by signal ${signal}`),
        )
        .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
          failGitDiff(`git ${args[0] ?? ""} spawn failed: ${spawnError}`),
        )
        .exhaustive(),
    ),
  )

const execGitOk = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitDiffExecutionError> =>
  execGit(cwd, args).pipe(
    Effect.flatMap((exited) =>
      exited.exitCode === 0
        ? Effect.succeed(exited.stdout)
        : failGitDiff(
            exited.stderr.trim().length > 0
              ? exited.stderr
              : `git ${args[0] ?? ""} exited with code ${String(exited.exitCode)}`,
          ),
    ),
  )

const resolveDiffBase = (
  root: string,
  baseRef: string | undefined,
): Effect.Effect<
  { readonly resolvedBase: string | null; readonly diffBase: string },
  GitDiffExecutionError
> =>
  Effect.gen(function* () {
    if (baseRef !== undefined) {
      const validRef = yield* validateBaseRef(baseRef)
      const mergeBase = (yield* execGitOk(root, ["merge-base", validRef, "HEAD"])).trim()
      if (mergeBase.length === 0) {
        return yield* failGitDiff(`git merge-base returned empty output for '${validRef}'`)
      }
      return { resolvedBase: mergeBase, diffBase: mergeBase }
    }
    const headCheck = yield* execGit(root, ["rev-parse", "--verify", "HEAD"])
    if (headCheck.exitCode === 0) {
      return { resolvedBase: "HEAD", diffBase: "HEAD" }
    }
    // Allow unborn repository diff against empty tree ONLY when inside a real git repository.
    yield* execGitOk(root, ["rev-parse", "--git-dir"])
    return { resolvedBase: null, diffBase: EMPTY_TREE_SHA }
  })

const parseNulList = (raw: string): ReadonlyArray<string> =>
  raw.split("\0").filter((entry) => entry.length > 0)

const sliceUtf8Safe = (bytes: Uint8Array, maxBytes: number): Uint8Array => {
  if (bytes.length <= maxBytes) return bytes
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end)
}

const formatUntrackedPreview = (
  root: string,
  relPath: string,
  remainingChars: number,
): string | undefined => {
  const absPath = path.resolve(root, relPath)
  if (!isPathInsideRoot(root, absPath)) return undefined
  if (nodeSyncHostIo.isSymbolicLinkSync(absPath) || !nodeSyncHostIo.isFileSync(absPath)) {
    return undefined
  }
  const bytesOpt = Result.getOrUndefined(Result.try(() => nodeSyncHostIo.readBytesSync(absPath)))
  if (bytesOpt === undefined) return undefined
  const boundedBytes = sliceUtf8Safe(bytesOpt, Math.max(4096, remainingChars * 4 + 4096))
  const decodedOpt = boundedBytes.includes(0)
    ? undefined
    : Result.getOrUndefined(
        Result.try(() => new TextDecoder("utf-8", { fatal: true }).decode(boundedBytes)),
      )
  if (decodedOpt === undefined) {
    return [
      `diff --git a/${relPath} b/${relPath}`,
      "new file mode 100644",
      `Binary files /dev/null and b/${relPath} differ`,
    ].join("\n")
  }
  const rawLines = decodedOpt.split(/\r?\n/)
  const lines = decodedOpt.endsWith("\n") ? rawLines.slice(0, -1) : rawLines
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relPath}`,
  ]
  return lines.length === 0
    ? header.join("\n")
    : [...header, `@@ -0,0 +1,${String(lines.length)} @@`, ...lines.map((l) => `+${l}`)].join("\n")
}

const clampMaxPatchChars = (rawMax: number | undefined): number =>
  Math.max(
    0,
    Math.min(
      rawMax !== undefined && Number.isFinite(rawMax)
        ? Math.floor(rawMax)
        : DEFAULT_MAX_PATCH_CHARS,
      HARD_MAX_PATCH_CHARS,
    ),
  )

export const executeGitDiffTool = Effect.fn("HarnessMcp.gitDiff")(function* (
  input: GitDiffToolInput,
  options?: ServerOptions,
): Effect.fn.Return<GitDiffToolResult, McpToolExecutionError> {
  const root =
    options?.repoRoot ??
    resolveDefaultRepoRoot(
      input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : undefined,
      options,
    )
  const relPaths = input.paths !== undefined ? yield* confineRepoPaths(root, input.paths) : []
  const pathArgs: ReadonlyArray<string> = relPaths.length > 0 ? ["--", ...relPaths] : []
  const { resolvedBase, diffBase } = yield* resolveDiffBase(root, input.baseRef)

  const stat = (yield* execGitOk(root, [
    "diff",
    "--stat",
    "--no-color",
    diffBase,
    ...pathArgs,
  ])).trimEnd()
  const changedFiles = parseNulList(
    yield* execGitOk(root, ["diff", "--name-only", "-z", diffBase, ...pathArgs]),
  )
  const untrackedFiles = parseNulList(
    yield* execGitOk(root, ["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs]),
  )

  if (input.statOnly === true) {
    return {
      resolvedBase,
      stat,
      changedFiles,
      untrackedFiles,
      patch: "",
      totalPatchChars: 0,
      truncated: false,
    }
  }

  const clampedMax = clampMaxPatchChars(input.maxPatchChars)
  const trackedTrimmed = (yield* execGitOk(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    diffBase,
    ...pathArgs,
  ])).trimEnd()

  if (clampedMax === 0) {
    return {
      resolvedBase,
      stat,
      changedFiles,
      untrackedFiles,
      patch: "",
      totalPatchChars: trackedTrimmed.length,
      truncated: trackedTrimmed.length > 0 || untrackedFiles.length > 0,
    }
  }

  let accChars = trackedTrimmed.length
  let budgetExhausted = false
  const untrackedPreviews: Array<string> = []
  for (const relPath of untrackedFiles) {
    if (accChars >= clampedMax) {
      budgetExhausted = true
      break
    }
    const preview = formatUntrackedPreview(root, relPath, clampedMax - accChars)
    if (preview !== undefined) {
      untrackedPreviews.push(preview)
      accChars += (accChars > 0 ? 1 : 0) + preview.length
    }
  }

  const fullPatch = [
    ...(trackedTrimmed.length > 0 ? [trackedTrimmed] : []),
    ...untrackedPreviews,
  ].join("\n")
  const totalPatchChars = fullPatch.length
  const truncated = budgetExhausted || totalPatchChars > clampedMax
  const patch = fullPatch.length > clampedMax ? fullPatch.slice(0, clampedMax) : fullPatch

  return { resolvedBase, stat, changedFiles, untrackedFiles, patch, totalPatchChars, truncated }
})

export const buildGitDiffToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_git_diff"),
    description:
      "Read-only bounded git diff (merge-base with optional baseRef vs working tree plus untracked file previews) using --no-optional-locks.",
    inputSchema: GitDiffToolInputSchema,
    execute: (args) =>
      decodeGitDiffToolInput(args).pipe(
        Effect.flatMap((decoded) => executeGitDiffTool(decoded, options)),
      ),
  },
]
