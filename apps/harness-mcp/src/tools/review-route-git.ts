import * as path from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  ReviewChangedLines,
  type ReviewSignalPath,
  toErrorReasonMessage,
} from "@harness/contract"
import { execFileAsyncEffect, nodeSyncHostIo } from "@harness/infra"
import { isPathInsideRoot } from "./mcp-helpers.js"

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const GIT_NUMSTAT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
const NUMSTAT_DIGITS_RE = /^\d+$/

const isSafeGitBaseRef = (value: string): boolean => {
  if (value.length === 0 || value.length > 512 || value.startsWith("-")) {
    return false
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f || /\s/.test(value[i] ?? "")) {
      return false
    }
  }
  return true
}

/** Validated, bounded git ref safe to pass after `--end-of-options`. */
export const ReviewGitBaseRef = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 512)),
  Schema.check(
    Schema.makeFilter(isSafeGitBaseRef, {
      message:
        "Invalid baseRef: must be a non-empty git ref (<= 512 chars) without leading '-' or whitespace/control characters",
    }),
  ),
  Schema.brand("ReviewGitBaseRef"),
)
export type ReviewGitBaseRef = typeof ReviewGitBaseRef.Type

const decodeReviewGitBaseRefResult = Schema.decodeUnknownResult(ReviewGitBaseRef)

const parseNumstatChangedLines = (numstatOutput: string): number => {
  let total = 0
  for (const line of numstatOutput.split(/\r?\n/)) {
    if (line.length === 0) continue
    const parts = line.split("\t")
    if (parts.length < 2) continue
    const addedRaw = parts[0] ?? ""
    const deletedRaw = parts[1] ?? ""
    if (addedRaw === "-" || deletedRaw === "-") continue
    if (!NUMSTAT_DIGITS_RE.test(addedRaw) || !NUMSTAT_DIGITS_RE.test(deletedRaw)) continue
    const added = Number(addedRaw)
    const deleted = Number(deletedRaw)
    if (Number.isSafeInteger(added) && Number.isSafeInteger(deleted)) {
      total += added + deleted
    }
  }
  return total
}

const trimIncompleteTrailingUtf8 = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length === 0) return bytes
  let i = bytes.length - 1
  let contCount = 0
  while (i >= 0 && contCount < 3 && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i -= 1
    contCount += 1
  }
  if (i < 0) return bytes
  const lead = bytes[i] ?? 0
  if ((lead & 0x80) === 0) return bytes
  const expectedLen =
    (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
  return bytes.length - i < expectedLen ? bytes.subarray(0, i) : bytes
}

const countUtf8Lines = (content: string): number => {
  if (content.length === 0 || content.includes("\0")) return 0
  const rawLines = content.split(/\r?\n/)
  return content.endsWith("\n") ? rawLines.length - 1 : rawLines.length
}

const formatGitExecFailure = (
  label: string,
  res: Effect.Success<ReturnType<typeof execFileAsyncEffect>>,
): ErrorReasonMessage =>
  match(res)
    .with({ _tag: "Exited" }, ({ exitCode, stderr }) =>
      toErrorReasonMessage(
        `${label} exited with code ${String(exitCode)}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
      ),
    )
    .with({ _tag: "TimedOut" }, () => toErrorReasonMessage(`${label} timed out`))
    .with({ _tag: "Signaled" }, ({ signal }) =>
      toErrorReasonMessage(`${label} terminated by signal ${signal}`),
    )
    .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
      toErrorReasonMessage(`${label} spawn failed: ${spawnError}`),
    )
    .exhaustive()

const execGit = (cwd: string, args: ReadonlyArray<string>) =>
  execFileAsyncEffect("git", ["--no-optional-locks", ...args], {
    cwd,
    timeoutMs: GIT_NUMSTAT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES,
  })

const execGitNumstatDiff = (
  cwd: string,
  diffRef: string,
  changedFiles: ReadonlyArray<ReviewSignalPath>,
) =>
  execGit(cwd, [
    "--literal-pathspecs",
    "diff",
    "--numstat",
    "--no-renames",
    "--end-of-options",
    diffRef,
    "--",
    ...changedFiles,
  ])

const isExitZero = (res: Effect.Success<ReturnType<typeof execFileAsyncEffect>>): boolean =>
  match(res)
    .with({ _tag: "Exited" }, (c) => c.exitCode === 0)
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
    .exhaustive()

type NumstatOutcome =
  | { readonly _tag: "Ok"; readonly stdout: string }
  | { readonly _tag: "Warn"; readonly warning: ErrorReasonMessage }

const toNumstatOutcome = (
  label: string,
  res: Effect.Success<ReturnType<typeof execFileAsyncEffect>>,
): NumstatOutcome =>
  match(res)
    .with({ _tag: "Exited" }, (c) =>
      c.exitCode === 0
        ? { _tag: "Ok" as const, stdout: c.stdout }
        : { _tag: "Warn" as const, warning: formatGitExecFailure(label, res) },
    )
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => ({
      _tag: "Warn" as const,
      warning: formatGitExecFailure(label, res),
    }))
    .exhaustive()

/** Derives changed line count from `git diff --numstat` and untracked regular files. */
export const deriveChangedLineCountFromGit = Effect.fn("HarnessMcp.deriveChangedLineCountFromGit")(
  function* (
    repoRoot: string,
    changedFiles: ReadonlyArray<ReviewSignalPath>,
    baseRef?: string,
  ): Effect.fn.Return<{
    readonly changedLineCount: ReviewChangedLines
    readonly warning?: ErrorReasonMessage | undefined
  }> {
    if (changedFiles.length === 0) {
      return { changedLineCount: ReviewChangedLines.make(0) }
    }

    const validatedBaseRef =
      baseRef !== undefined
        ? match(decodeReviewGitBaseRefResult(baseRef))
            .with({ _tag: "Success" }, ({ success }) => ({
              _tag: "Valid" as const,
              ref: success,
              warning: undefined,
            }))
            .with({ _tag: "Failure" }, ({ failure }) => ({
              _tag: "Invalid" as const,
              ref: undefined,
              warning: toErrorReasonMessage(failure),
            }))
            .exhaustive()
        : undefined

    const baseRefWarning =
      validatedBaseRef !== undefined
        ? match(validatedBaseRef)
            .with({ _tag: "Invalid" }, ({ warning }) => warning)
            .with({ _tag: "Valid" }, () => undefined)
            .exhaustive()
        : undefined

    if (baseRefWarning !== undefined) {
      return {
        changedLineCount: ReviewChangedLines.make(0),
        warning: baseRefWarning,
      }
    }

    const rootValidation = yield* Effect.try(() => {
      const resolvedRoot = path.resolve(repoRoot)
      if (!nodeSyncHostIo.existsSync(resolvedRoot)) {
        return {
          _tag: "Invalid" as const,
          warning: toErrorReasonMessage(`Configured repoRoot does not exist on disk: ${repoRoot}`),
        }
      }
      if (nodeSyncHostIo.isSymbolicLinkSync(resolvedRoot)) {
        return {
          _tag: "Invalid" as const,
          warning: toErrorReasonMessage(`Configured repoRoot must not be a symlink: ${repoRoot}`),
        }
      }
      if (!nodeSyncHostIo.isDirectorySync(resolvedRoot)) {
        return {
          _tag: "Invalid" as const,
          warning: toErrorReasonMessage(`Configured repoRoot is not a directory: ${repoRoot}`),
        }
      }
      return { _tag: "Valid" as const, resolvedRoot }
    }).pipe(
      Effect.catch((err) =>
        Effect.succeed({
          _tag: "Invalid" as const,
          warning: toErrorReasonMessage(`Failed to inspect repoRoot "${repoRoot}": ${String(err)}`),
        }),
      ),
    )

    const requestedRef =
      validatedBaseRef !== undefined
        ? match(validatedBaseRef)
            .with({ _tag: "Valid" }, ({ ref }) => ref)
            .with({ _tag: "Invalid" }, () => undefined)
            .exhaustive()
        : undefined

    return yield* match(rootValidation)
      .with({ _tag: "Invalid" }, ({ warning }) =>
        Effect.succeed({
          changedLineCount: ReviewChangedLines.make(0),
          warning,
        }),
      )
      .with({ _tag: "Valid" }, ({ resolvedRoot }) =>
        Effect.gen(function* () {
          const primaryDiffOutcome:
            | { readonly _tag: "Ready"; readonly diffRef: string; readonly label: string }
            | { readonly _tag: "Warn"; readonly warning: ErrorReasonMessage } =
            requestedRef !== undefined
              ? yield* Effect.gen(function* () {
                  const mbRes = yield* execGit(resolvedRoot, [
                    "merge-base",
                    "--end-of-options",
                    requestedRef,
                    "HEAD",
                  ])
                  return match(mbRes)
                    .with({ _tag: "Exited" }, ({ exitCode, stdout }) => {
                      const sha = stdout.trim()
                      if (exitCode === 0 && sha.length > 0) {
                        return {
                          _tag: "Ready" as const,
                          diffRef: sha,
                          label: `git diff --numstat ${requestedRef}`,
                        }
                      }
                      return {
                        _tag: "Warn" as const,
                        warning: formatGitExecFailure(`git merge-base ${requestedRef} HEAD`, mbRes),
                      }
                    })
                    .with(
                      { _tag: "TimedOut" },
                      { _tag: "Signaled" },
                      { _tag: "SpawnFailed" },
                      () => ({
                        _tag: "Warn" as const,
                        warning: formatGitExecFailure(`git merge-base ${requestedRef} HEAD`, mbRes),
                      }),
                    )
                    .exhaustive()
                })
              : { _tag: "Ready", diffRef: "HEAD", label: "git diff --numstat HEAD" }

          return yield* match(primaryDiffOutcome)
            .with({ _tag: "Warn" }, ({ warning }) =>
              Effect.succeed({
                changedLineCount: ReviewChangedLines.make(0),
                warning,
              }),
            )
            .with({ _tag: "Ready" }, ({ diffRef: primaryDiffRef }) =>
              Effect.gen(function* () {
                const primaryDiff = yield* execGitNumstatDiff(
                  resolvedRoot,
                  primaryDiffRef,
                  changedFiles,
                )

                const numstatOutcome: NumstatOutcome = yield* match(primaryDiff)
                  .with({ _tag: "Exited" }, ({ exitCode, stdout }) => {
                    if (exitCode === 0) {
                      return Effect.succeed({ _tag: "Ok" as const, stdout })
                    }
                    if (requestedRef !== undefined) {
                      return Effect.succeed({
                        _tag: "Warn" as const,
                        warning: formatGitExecFailure(
                          `git diff --numstat ${requestedRef}`,
                          primaryDiff,
                        ),
                      })
                    }
                    return Effect.gen(function* () {
                      const gitDirCheck = yield* execGit(resolvedRoot, ["rev-parse", "--git-dir"])
                      if (!isExitZero(gitDirCheck)) {
                        return {
                          _tag: "Warn" as const,
                          warning: formatGitExecFailure("git diff --numstat HEAD", primaryDiff),
                        }
                      }
                      const headCheck = yield* execGit(resolvedRoot, [
                        "rev-parse",
                        "--verify",
                        "HEAD",
                      ])
                      if (!isExitZero(headCheck)) {
                        const emptyTreeDiff = yield* execGitNumstatDiff(
                          resolvedRoot,
                          EMPTY_TREE_SHA,
                          changedFiles,
                        )
                        return toNumstatOutcome(
                          `git diff --numstat ${EMPTY_TREE_SHA}`,
                          emptyTreeDiff,
                        )
                      }
                      return {
                        _tag: "Warn" as const,
                        warning: formatGitExecFailure("git diff --numstat HEAD", primaryDiff),
                      }
                    })
                  })
                  .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () =>
                    Effect.succeed({
                      _tag: "Warn" as const,
                      warning: formatGitExecFailure(
                        `git diff --numstat ${primaryDiffRef}`,
                        primaryDiff,
                      ),
                    }),
                  )
                  .exhaustive()

                return yield* match(numstatOutcome)
                  .with({ _tag: "Warn" }, ({ warning }) =>
                    Effect.succeed({
                      changedLineCount: ReviewChangedLines.make(0),
                      warning,
                    }),
                  )
                  .with({ _tag: "Ok" }, ({ stdout: numstatStdout }) =>
                    Effect.gen(function* () {
                      const trackedLines = parseNumstatChangedLines(numstatStdout)
                      const lsFilesRes = yield* execGit(resolvedRoot, [
                        "--literal-pathspecs",
                        "ls-files",
                        "--others",
                        "--exclude-standard",
                        "-z",
                        "--end-of-options",
                        "--",
                        ...changedFiles,
                      ])
                      const lsFilesOutcome = toNumstatOutcome("git ls-files --others", lsFilesRes)

                      return yield* match(lsFilesOutcome)
                        .with({ _tag: "Warn" }, ({ warning }) =>
                          Effect.succeed({
                            changedLineCount: ReviewChangedLines.make(Math.max(0, trackedLines)),
                            warning,
                          }),
                        )
                        .with({ _tag: "Ok" }, ({ stdout: lsFilesStdout }) =>
                          Effect.gen(function* () {
                            let totalLines = trackedLines
                            const untrackedWarnings: Array<string> = []
                            const untrackedFiles = lsFilesStdout
                              .split("\0")
                              .filter((entry) => entry.length > 0)
                            for (const relPath of untrackedFiles) {
                              const absPath = path.resolve(resolvedRoot, relPath)
                              const entryOutcome = yield* Effect.try(() => {
                                if (
                                  !isPathInsideRoot(resolvedRoot, absPath) ||
                                  nodeSyncHostIo.isSymbolicLinkSync(absPath) ||
                                  !nodeSyncHostIo.isFileSync(absPath)
                                ) {
                                  return { _tag: "Skip" as const }
                                }
                                const rawBytes = nodeSyncHostIo.readBytesPrefixSync(
                                  absPath,
                                  MAX_UNTRACKED_BYTES,
                                )
                                if (rawBytes.includes(0)) {
                                  return { _tag: "Skip" as const }
                                }
                                const boundedBytes =
                                  rawBytes.length === MAX_UNTRACKED_BYTES
                                    ? trimIncompleteTrailingUtf8(rawBytes)
                                    : rawBytes
                                const content = new TextDecoder("utf-8", { fatal: true }).decode(
                                  boundedBytes,
                                )
                                return { _tag: "Lines" as const, count: countUtf8Lines(content) }
                              }).pipe(
                                Effect.map((ok) => ({ _tag: "Ok" as const, ok })),
                                Effect.catch((err) =>
                                  Effect.succeed({ _tag: "Err" as const, err }),
                                ),
                              )
                              match(entryOutcome)
                                .with({ _tag: "Ok" }, ({ ok }) => {
                                  match(ok)
                                    .with({ _tag: "Lines" }, ({ count }) => {
                                      totalLines += count
                                    })
                                    .with({ _tag: "Skip" }, () => {})
                                    .exhaustive()
                                })
                                .with({ _tag: "Err" }, ({ err }) => {
                                  untrackedWarnings.push(
                                    `Failed to inspect untracked file "${relPath}": ${toErrorReasonMessage(err)}`,
                                  )
                                })
                                .exhaustive()
                            }

                            return {
                              changedLineCount: ReviewChangedLines.make(Math.max(0, totalLines)),
                              ...(untrackedWarnings.length > 0
                                ? { warning: toErrorReasonMessage(untrackedWarnings.join("; ")) }
                                : {}),
                            }
                          }),
                        )
                        .exhaustive()
                    }),
                  )
                  .exhaustive()
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  },
)
