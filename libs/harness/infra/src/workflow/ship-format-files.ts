import { constants } from "node:os"
import { extname, join } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  GateExitCode,
  GateStderrSummary,
  ShipGateFailedError,
  compareCodeUnits,
  toErrorReasonMessage,
} from "@harness/contract"
import type { SyncHostExecExited, SyncHostIo } from "@harness/service/host-io"

const MAX_STDERR_SUMMARY_CHARS = 4096
const GIT_READ_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const FORMATTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
])

const ALWAYS_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  ".harness",
  "node_modules",
  ".nx",
  ".git",
])

const DEFAULT_OXFMT_IGNORE_PATTERNS: ReadonlyArray<string> = [
  "repos/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  ".worktrees/**",
  ".harness/**",
  ".idea/**",
  "pnpm-lock.yaml",
]

const FALLBACK_DEFAULT_BRANCHES: ReadonlyArray<string> = [
  "main",
  "origin/main",
  "master",
  "origin/master",
]

const OxfmtIgnoreConfigSchema = Schema.fromJsonString(
  Schema.Struct({
    ignorePatterns: Schema.optional(Schema.Array(Schema.String)),
  }),
)
const decodeOxfmtIgnoreConfigOption = Schema.decodeUnknownOption(OxfmtIgnoreConfigSchema)

const GIT_OBJECT_SHA_RE = /^[0-9a-f]{40,64}$/i
const UNSAFE_GIT_REF_PRINTABLE_RE = /[\s\\~^:?*[]/

const hasControlChar = (raw: string): boolean => {
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

const toGateStderrSummary = (raw: string): GateStderrSummary => {
  const trimmed = raw.trim()
  return GateStderrSummary.make(
    trimmed.length <= MAX_STDERR_SUMMARY_CHARS
      ? trimmed
      : trimmed.slice(-MAX_STDERR_SUMMARY_CHARS).trim(),
  )
}

const toGateExitCode = (rawCode: number): GateExitCode =>
  GateExitCode.make(Number.isInteger(rawCode) ? Math.min(255, Math.max(1, rawCode)) : 1)

const resolveSignaledExitCode = (signal: string): GateExitCode => {
  const signalNumber = Reflect.get(constants.signals, signal)
  return typeof signalNumber === "number" && Number.isInteger(signalNumber) && signalNumber >= 1
    ? GateExitCode.make(Math.min(255, 128 + signalNumber))
    : GateExitCode.make(1)
}

const normalizeRelPath = (raw: string): string => {
  let normalized = raw.replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized
}

const matchWildcardSegment = (pattern: string, text: string): boolean => {
  let pi = 0
  let ti = 0
  let starPi = -1
  let starTi = 0
  while (ti < text.length) {
    const pCh = pattern[pi]
    if (pCh !== undefined && (pCh === "?" || pCh === text[ti])) {
      pi += 1
      ti += 1
      continue
    }
    if (pCh === "*") {
      starPi = pi
      starTi = ti
      pi += 1
      continue
    }
    if (starPi !== -1) {
      pi = starPi + 1
      starTi += 1
      ti = starTi
      continue
    }
    return false
  }
  while (pattern[pi] === "*") {
    pi += 1
  }
  return pi === pattern.length
}

const collapseDoubleStars = (segments: ReadonlyArray<string>): ReadonlyArray<string> => {
  const collapsed: Array<string> = []
  for (const seg of segments) {
    if (seg === "**" && collapsed[collapsed.length - 1] === "**") {
      continue
    }
    collapsed.push(seg)
  }
  return collapsed
}

const matchGlobSegments = (
  patSegs: ReadonlyArray<string>,
  pathSegs: ReadonlyArray<string>,
): boolean => {
  let pi = 0
  let si = 0
  let starPi = -1
  let starSi = 0
  while (si < pathSegs.length) {
    const patSeg = patSegs[pi]
    const pathSeg = pathSegs[si]
    if (patSeg === "**") {
      starPi = pi
      starSi = si
      pi += 1
      continue
    }
    if (patSeg !== undefined && pathSeg !== undefined && matchWildcardSegment(patSeg, pathSeg)) {
      pi += 1
      si += 1
      continue
    }
    if (starPi !== -1) {
      pi = starPi + 1
      starSi += 1
      si = starSi
      continue
    }
    return false
  }
  while (patSegs[pi] === "**") {
    pi += 1
  }
  return pi === patSegs.length
}

const matchesOxfmtIgnorePattern = (relPath: string, rawPattern: string): boolean => {
  let pattern = rawPattern.replaceAll("\\", "/").trim()
  while (pattern.startsWith("./") || pattern.startsWith("/")) {
    pattern = pattern.startsWith("./") ? pattern.slice(2) : pattern.slice(1)
  }
  if (pattern.length === 0 || pattern.startsWith("!")) {
    return false
  }
  if (pattern.endsWith("/")) {
    pattern = `${pattern}**`
  }
  const pathSegs = relPath.split("/")
  if (!pattern.includes("/")) {
    const baseName = pathSegs[pathSegs.length - 1] ?? ""
    return matchWildcardSegment(pattern, baseName)
  }
  const patSegs = collapseDoubleStars(pattern.split("/").filter((seg) => seg.length > 0))
  return matchGlobSegments(patSegs, pathSegs)
}

const isIgnoredShipFormatPath = (
  relPath: string,
  ignorePatterns: ReadonlyArray<string>,
): boolean => {
  const parts = relPath.split("/")
  if (parts.some((seg) => ALWAYS_IGNORED_SEGMENTS.has(seg))) {
    return true
  }
  return ignorePatterns.some((pattern) => matchesOxfmtIgnorePattern(relPath, pattern))
}

const resolveCanonicalPath = (filePath: string, hostIo: SyncHostIo): string | undefined =>
  match(Result.try(() => hostIo.realpathSync(filePath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()

const isSafeRegularWorkspaceFile = (
  repoRoot: string,
  canonicalRoot: string | undefined,
  relPath: string,
  hostIo: SyncHostIo,
): boolean => {
  if (canonicalRoot === undefined || relPath.startsWith("/")) {
    return false
  }
  const parts = relPath.split("/")
  if (parts.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
    return false
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (hostIo.isSymbolicLinkSync(join(repoRoot, ...parts.slice(0, i + 1)))) {
      return false
    }
  }
  const absPath = join(repoRoot, relPath)
  if (!hostIo.isFileSync(absPath)) {
    return false
  }
  const canonicalFile = resolveCanonicalPath(absPath, hostIo)
  if (canonicalFile === undefined) {
    return false
  }
  const rootPrefix = canonicalRoot.endsWith("/") ? canonicalRoot : `${canonicalRoot}/`
  return canonicalFile.startsWith(rootPrefix)
}

const loadOxfmtIgnorePatterns = (
  repoRoot: string,
  canonicalRoot: string | undefined,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  if (!isSafeRegularWorkspaceFile(repoRoot, canonicalRoot, ".oxfmtrc.json", hostIo)) {
    return DEFAULT_OXFMT_IGNORE_PATTERNS
  }
  const rawResult = Result.try(() => hostIo.readTextSync(join(repoRoot, ".oxfmtrc.json")))
  const loaded = match(rawResult)
    .with({ _tag: "Failure" }, () => [] as ReadonlyArray<string>)
    .with({ _tag: "Success" }, ({ success: rawText }) =>
      match(decodeOxfmtIgnoreConfigOption(rawText))
        .with({ _tag: "Some" }, ({ value }) => value.ignorePatterns ?? [])
        .with({ _tag: "None" }, () => [] as ReadonlyArray<string>)
        .exhaustive(),
    )
    .exhaustive()
  return Array.from(new Set([...DEFAULT_OXFMT_IGNORE_PATTERNS, ...loaded]))
}

const makeFormatCheckGitError = (exitCode: GateExitCode, detail: string): ShipGateFailedError =>
  new ShipGateFailedError({
    stage: "format-check",
    exitCode,
    stderrSummary: toGateStderrSummary(detail),
    circuitBreakerStatus: "clear",
  })

const execGitRaw = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
): Result.Result<SyncHostExecExited, ShipGateFailedError> =>
  match(
    Result.try(() =>
      hostIo.execFileSync("git", args, {
        cwd: repoRoot,
        env,
        maxBufferBytes: GIT_READ_MAX_BUFFER_BYTES,
      }),
    ),
  )
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(
        makeFormatCheckGitError(
          GateExitCode.make(1),
          toErrorReasonMessage(failure, `git ${args.join(" ")} threw unexpectedly`),
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (exited) => Result.succeed(exited))
        .with({ _tag: "TimedOut" }, ({ stdout, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              GateExitCode.make(1),
              stderr.trim() || stdout.trim() || `git ${args.join(" ")} timed out`,
            ),
          ),
        )
        .with({ _tag: "Signaled" }, ({ signal, stdout, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              resolveSignaledExitCode(signal),
              stderr.trim() || stdout.trim() || `git ${args.join(" ")} signaled ${signal}`,
            ),
          ),
        )
        .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              GateExitCode.make(1),
              spawnError.trim() || stderr.trim() || `git ${args.join(" ")} failed to spawn`,
            ),
          ),
        )
        .exhaustive(),
    )
    .exhaustive()

const execGitCheckedStdout = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
): Result.Result<string, ShipGateFailedError> =>
  Result.flatMap(execGitRaw(repoRoot, hostIo, env, args), (exited) =>
    exited.exitCode === 0
      ? Result.succeed(exited.stdout)
      : Result.fail(
          makeFormatCheckGitError(
            toGateExitCode(exited.exitCode),
            exited.stderr.trim() ||
              exited.stdout.trim() ||
              `git ${args.join(" ")} exited with code ${exited.exitCode}`,
          ),
        ),
  )

const probeGitRefExists = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  ref: string,
): Result.Result<boolean, ShipGateFailedError> =>
  Result.flatMap(
    execGitRaw(repoRoot, hostIo, env, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      ref,
    ]),
    (exited) => {
      if (exited.exitCode === 0) return Result.succeed(true)
      if (exited.exitCode === 1) return Result.succeed(false)
      return Result.fail(
        makeFormatCheckGitError(
          toGateExitCode(exited.exitCode),
          exited.stderr.trim() ||
            exited.stdout.trim() ||
            `git rev-parse --verify --quiet --end-of-options ${ref} exited with code ${exited.exitCode}`,
        ),
      )
    },
  )

const isSafeGitRefCandidate = (raw: string): boolean =>
  raw.length > 0 &&
  !raw.startsWith("-") &&
  !raw.startsWith("/") &&
  !raw.endsWith("/") &&
  !raw.endsWith(".lock") &&
  !raw.includes("..") &&
  !raw.includes("@{") &&
  !raw.includes("//") &&
  !hasControlChar(raw) &&
  !UNSAFE_GIT_REF_PRINTABLE_RE.test(raw)

const pushUniqueCandidate = (target: Array<string>, seen: Set<string>, candidate: string): void => {
  const trimmed = candidate.trim()
  if (isSafeGitRefCandidate(trimmed) && !seen.has(trimmed)) {
    seen.add(trimmed)
    target.push(trimmed)
  }
}

const resolveDefaultBranchCandidates = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): Result.Result<ReadonlyArray<string>, ShipGateFailedError> => {
  const candidates: Array<string> = []
  const seen = new Set<string>()

  const afterSymRef = Result.flatMap(
    execGitRaw(repoRoot, hostIo, env, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
    (exited) => {
      if (exited.exitCode === 0) {
        const remoteRef = exited.stdout.trim()
        if (remoteRef.length > 0) {
          if (remoteRef.startsWith("origin/")) {
            pushUniqueCandidate(candidates, seen, remoteRef.slice("origin/".length))
          }
          pushUniqueCandidate(candidates, seen, remoteRef)
        }
        return Result.succeed(undefined)
      }
      if (exited.exitCode === 1) {
        return Result.succeed(undefined)
      }
      return Result.fail(
        makeFormatCheckGitError(
          toGateExitCode(exited.exitCode),
          exited.stderr.trim() ||
            exited.stdout.trim() ||
            `git symbolic-ref --quiet --short refs/remotes/origin/HEAD exited with code ${exited.exitCode}`,
        ),
      )
    },
  )

  return Result.flatMap(afterSymRef, () =>
    Result.flatMap(
      execGitRaw(repoRoot, hostIo, env, ["config", "--get", "init.defaultBranch"]),
      (exited) => {
        if (exited.exitCode === 0) {
          const defaultBranch = exited.stdout.trim()
          if (isSafeGitRefCandidate(defaultBranch)) {
            pushUniqueCandidate(candidates, seen, defaultBranch)
            pushUniqueCandidate(candidates, seen, `origin/${defaultBranch}`)
          }
          for (const fallback of FALLBACK_DEFAULT_BRANCHES) {
            pushUniqueCandidate(candidates, seen, fallback)
          }
          return Result.succeed(candidates)
        }
        if (exited.exitCode === 1) {
          for (const fallback of FALLBACK_DEFAULT_BRANCHES) {
            pushUniqueCandidate(candidates, seen, fallback)
          }
          return Result.succeed(candidates)
        }
        return Result.fail(
          makeFormatCheckGitError(
            toGateExitCode(exited.exitCode),
            exited.stderr.trim() ||
              exited.stdout.trim() ||
              `git config --get init.defaultBranch exited with code ${exited.exitCode}`,
          ),
        )
      },
    ),
  )
}

const tryMergeBaseRange = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  headSha: string,
  branches: ReadonlyArray<string>,
  sawHeadMatch = false,
): Result.Result<string | undefined, ShipGateFailedError> => {
  const [branch, ...rest] = branches
  if (branch === undefined) {
    if (sawHeadMatch) {
      return Result.succeed(undefined)
    }
    return Result.map(probeGitRefExists(repoRoot, hostIo, env, "HEAD~1"), (hasParent) =>
      hasParent ? "HEAD~1..HEAD" : undefined,
    )
  }
  return Result.flatMap(probeGitRefExists(repoRoot, hostIo, env, branch), (exists) => {
    if (!exists) {
      return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, sawHeadMatch)
    }
    return Result.flatMap(
      execGitRaw(repoRoot, hostIo, env, ["merge-base", "--end-of-options", "HEAD", branch]),
      (mb) => {
        const mbSha = mb.stdout.trim()
        if (mb.exitCode === 0 && mbSha.length > 0) {
          if (!GIT_OBJECT_SHA_RE.test(mbSha)) {
            return Result.fail(
              makeFormatCheckGitError(
                GateExitCode.make(1),
                `git merge-base returned invalid object id '${mbSha}'`,
              ),
            )
          }
          if (mbSha === headSha) {
            return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, true)
          }
          return Result.succeed(`${mbSha}..HEAD`)
        }
        if (mb.exitCode === 0 || mb.exitCode === 1) {
          return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, sawHeadMatch)
        }
        return Result.fail(
          makeFormatCheckGitError(
            toGateExitCode(mb.exitCode),
            mb.stderr.trim() ||
              mb.stdout.trim() ||
              `git merge-base HEAD ${branch} exited with code ${mb.exitCode}`,
          ),
        )
      },
    )
  })
}

const splitGitNullPaths = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\0")
    .map(normalizeRelPath)
    .filter((line) => line.length > 0)

/**
 * Resolves the sorted, deduplicated list of changed regular files eligible for `oxfmt --check`
 * during the `"format-check"` ship stage, failing closed on unexpected git errors.
 */
const resolveShipFormatCheckFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): Result.Result<ReadonlyArray<string>, ShipGateFailedError> =>
  Result.flatMap(probeGitRefExists(repoRoot, hostIo, env, "HEAD"), (hasHead) => {
    const committedRangeRes: Result.Result<string | undefined, ShipGateFailedError> = hasHead
      ? Result.flatMap(
          execGitCheckedStdout(repoRoot, hostIo, env, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            "HEAD",
          ]),
          (rawHeadSha) => {
            const headSha = rawHeadSha.trim()
            if (!GIT_OBJECT_SHA_RE.test(headSha)) {
              return Result.fail(
                makeFormatCheckGitError(
                  GateExitCode.make(1),
                  `git rev-parse HEAD returned invalid object id '${headSha}'`,
                ),
              )
            }
            return Result.flatMap(
              resolveDefaultBranchCandidates(repoRoot, hostIo, env),
              (branches) => tryMergeBaseRange(repoRoot, hostIo, env, headSha, branches),
            )
          },
        )
      : Result.succeed(undefined)
    return Result.flatMap(committedRangeRes, (committedRange) => {
      const queries: Array<ReadonlyArray<string>> = [
        ["diff", "--no-renames", "--cached", "--name-only", "-z", "--"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
      ]
      if (hasHead) {
        queries.unshift([
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          "--end-of-options",
          "HEAD",
          "--",
        ])
      }
      if (committedRange !== undefined) {
        queries.unshift([
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          "--end-of-options",
          committedRange,
          "--",
        ])
      }
      const gitBase = ["-c", "core.quotePath=false"] as const
      return Result.map(
        Result.all(
          queries.map((q) =>
            Result.map(
              execGitCheckedStdout(repoRoot, hostIo, env, [...gitBase, ...q]),
              splitGitNullPaths,
            ),
          ),
        ),
        (buckets) => {
          const canonicalRoot = resolveCanonicalPath(repoRoot, hostIo)
          const ignorePatterns = loadOxfmtIgnorePatterns(repoRoot, canonicalRoot, hostIo)
          const unique = new Set<string>()
          for (const bucket of buckets) {
            for (const rel of bucket) {
              if (
                !isIgnoredShipFormatPath(rel, ignorePatterns) &&
                FORMATTABLE_EXTENSIONS.has(extname(rel).toLowerCase()) &&
                isSafeRegularWorkspaceFile(repoRoot, canonicalRoot, rel, hostIo)
              ) {
                unique.add(rel)
              }
            }
          }
          return Array.from(unique).sort(compareCodeUnits)
        },
      )
    })
  })

export { resolveShipFormatCheckFiles, resolveSignaledExitCode, toGateExitCode, toGateStderrSummary }
