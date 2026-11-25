import { dirname, join, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type ErrorReasonMessage,
  type NxScopeTag,
  type NxTierTag,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  type ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewSummaryText,
  SkipReviewPlan,
  compareCodeUnits,
  parseManifestTags,
  toErrorReasonMessage,
} from "@harness/contract"
import {
  attachReviewSlicesIfThresholdReached,
  inferReviewDiffSignals,
  routeReviewDiff,
} from "@harness/decision"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import type { SyncHostExecResult } from "@harness/service/host-io"
import {
  type CliEnv,
  type CliResult,
  findWorkspaceRoot,
  resolveDecisionModelLayer,
} from "./daemon-and-omnigraph.service.js"
import { tryGitDiffRange } from "./nx-affected-git.helpers.js"

const isHarnessRuntimeArtifact = (relPath: string): boolean =>
  relPath === ".harness/verify-stamp.json" ||
  relPath === ".harness/mutate-stamp.json" ||
  relPath === ".harness/telemetry-log.jsonl" ||
  relPath === ".harness/friction-log.jsonl" ||
  relPath === ".harness/session-report.json" ||
  relPath === ".harness/session-report.md" ||
  relPath === ".harness/graph-snapshot.json" ||
  relPath === ".harness/plan-graph-snapshot.json" ||
  relPath === ".harness/graph-head.json"

const ManifestTagsJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    tags: Schema.optional(Schema.Array(Schema.String)),
    nx: Schema.optional(
      Schema.Struct({
        tags: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
)
const decodeManifestJsonOption = Schema.decodeUnknownOption(ManifestTagsJsonSchema)

type ParsedReviewRouteArgs =
  | {
      readonly _tag: "Ok"
      readonly baseRef: string | undefined
      readonly explicitFiles: ReadonlyArray<string>
      readonly hasExplicitFileFlag: boolean
      readonly outputFormat: "json" | "text"
    }
  | { readonly _tag: "Err"; readonly reason: string }

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

const normalizeCliRelPath = (raw: string): string => {
  let normalized = raw.trim().replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized
}

const parseFormatValue = (
  raw: string,
):
  | { readonly _tag: "Ok"; readonly fmt: "json" | "text" }
  | { readonly _tag: "Err"; readonly reason: string } =>
  match(raw)
    .with("json", () => ({ _tag: "Ok" as const, fmt: "json" as const }))
    .with("text", "summary", () => ({ _tag: "Ok" as const, fmt: "text" as const }))
    .otherwise(() => ({
      _tag: "Err" as const,
      reason: `Unsupported --format '${raw}' (expected json or text)`,
    }))

const parseReviewRouteArgs = (args: ReadonlyArray<string>): ParsedReviewRouteArgs => {
  let baseRef: string | undefined
  const explicitFiles: Array<string> = []
  let hasExplicitFileFlag = false
  let outputFormat: "json" | "text" = "json"
  let forceJson = false

  const pushFilesCsv = (csv: string): void => {
    for (const part of csv.split(",")) {
      const normalized = normalizeCliRelPath(part)
      if (normalized.length > 0) {
        explicitFiles.push(normalized)
      }
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ""
    const next = args[i + 1]
    if (arg === "--json") {
      forceJson = true
      continue
    }
    if (arg === "--base") {
      if (next === undefined) return { _tag: "Err", reason: "Missing value for --base" }
      baseRef = next
      i += 1
      continue
    }
    if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length)
      continue
    }
    if (arg === "--files" || arg === "--file") {
      if (next === undefined) return { _tag: "Err", reason: `Missing value for ${arg}` }
      hasExplicitFileFlag = true
      pushFilesCsv(next)
      i += 1
      continue
    }
    if (arg.startsWith("--files=")) {
      hasExplicitFileFlag = true
      pushFilesCsv(arg.slice("--files=".length))
      continue
    }
    if (arg.startsWith("--file=")) {
      hasExplicitFileFlag = true
      pushFilesCsv(arg.slice("--file=".length))
      continue
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const isInline = arg.startsWith("--format=")
      const rawFmt = isInline ? arg.slice("--format=".length) : next
      if (rawFmt === undefined) return { _tag: "Err", reason: "Missing value for --format" }
      const fmtErr = match(parseFormatValue(rawFmt))
        .with({ _tag: "Ok" }, ({ fmt }) => {
          outputFormat = fmt
          return undefined
        })
        .with({ _tag: "Err" }, ({ reason }) => reason)
        .exhaustive()
      if (fmtErr !== undefined) return { _tag: "Err", reason: fmtErr }
      if (!isInline) i += 1
      continue
    }
    if (arg.startsWith("-")) {
      return { _tag: "Err", reason: `Unrecognized flag for review-route: ${arg}` }
    }
    pushFilesCsv(arg)
  }

  if (baseRef !== undefined && !isSafeGitBaseRef(baseRef)) {
    return { _tag: "Err", reason: `Invalid --base git ref: '${baseRef}'` }
  }
  if (hasExplicitFileFlag && explicitFiles.length === 0) {
    return { _tag: "Err", reason: "--files must include at least one non-empty file path" }
  }
  return {
    _tag: "Ok",
    baseRef,
    explicitFiles: Array.from(new Set(explicitFiles)),
    hasExplicitFileFlag,
    outputFormat: forceJson ? "json" : outputFormat,
  }
}

type GitRunOutcome =
  | { readonly _tag: "Ok"; readonly stdout: string }
  | { readonly _tag: "Err"; readonly reason: string }

const runGitSync = (repoRoot: string, args: ReadonlyArray<string>): GitRunOutcome =>
  match(
    Result.try({
      try: (): SyncHostExecResult =>
        nodeSyncHostIo.execFileSync("git", ["--no-optional-locks", ...args], {
          cwd: repoRoot,
          timeoutMs: 10_000,
        }),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }),
  )
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Err" as const, reason: failure }))
    .with({ _tag: "Success" }, ({ success: res }) =>
      match(res)
        .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
          exitCode === 0
            ? { _tag: "Ok" as const, stdout }
            : {
                _tag: "Err" as const,
                reason: `git ${args[0] ?? "diff"} failed (${stderr.trim() || `exit code ${exitCode}`})`,
              },
        )
        .with({ _tag: "TimedOut" }, () => ({ _tag: "Err" as const, reason: "git diff timed out" }))
        .with({ _tag: "Signaled" }, ({ signal }) => ({
          _tag: "Err" as const,
          reason: `git diff killed by signal ${signal}`,
        }))
        .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
          _tag: "Err" as const,
          reason: `git diff spawn failed: ${spawnError}`,
        }))
        .exhaustive(),
    )
    .exhaustive()

const verifyExplicitBaseRef = (repoRoot: string, baseRef: string): string | undefined => {
  if (!nodeSyncHostIo.existsSync(join(repoRoot, ".git"))) {
    return `Cannot diff against --base '${baseRef}': no .git directory`
  }
  return match(
    runGitSync(repoRoot, [
      "--literal-pathspecs",
      "rev-parse",
      "--verify",
      "--end-of-options",
      baseRef,
    ]),
  )
    .with({ _tag: "Ok" }, () => undefined)
    .with({ _tag: "Err" }, ({ reason }) => `Invalid --base '${baseRef}': ${reason}`)
    .exhaustive()
}

const parseGitFileLines = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split(/\r?\n/)
    .map(normalizeCliRelPath)
    .filter((line) => line.length > 0 && !isHarnessRuntimeArtifact(line))

const addGitLinesOnOk = (outcome: GitRunOutcome, target: Set<string>): string | undefined =>
  match(outcome)
    .with({ _tag: "Ok" }, ({ stdout }) => {
      for (const f of parseGitFileLines(stdout)) target.add(f)
      return undefined
    })
    .with({ _tag: "Err" }, ({ reason }) => reason)
    .exhaustive()

const parseNumstatChangedLines = (stdout: string): number => {
  let total = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\t+/)
    const added = parts[0] !== undefined ? Number(parts[0]) : 0
    const deleted = parts[1] !== undefined ? Number(parts[1]) : 0
    if (Number.isFinite(added) && added > 0) total += Math.trunc(added)
    if (Number.isFinite(deleted) && deleted > 0) total += Math.trunc(deleted)
  }
  return total
}

const collectManifestTagsSafe = (
  repoRoot: string,
  changedFiles: ReadonlyArray<string>,
): {
  readonly tiers: ReadonlyArray<NxTierTag>
  readonly scopes: ReadonlyArray<NxScopeTag>
  readonly warnings: ReadonlyArray<ErrorReasonMessage>
} => {
  const tiers = new Set<NxTierTag>()
  const scopes = new Set<NxScopeTag>()
  const warnings: Array<ErrorReasonMessage> = []
  const visitedDirs = new Set<string>()
  const resolvedRoot = resolve(repoRoot)

  for (const relFile of changedFiles) {
    let currDir = dirname(resolve(resolvedRoot, relFile))
    while (currDir === resolvedRoot || currDir.startsWith(`${resolvedRoot}/`)) {
      if (visitedDirs.has(currDir)) break
      visitedDirs.add(currDir)
      for (const manifestName of ["project.json", "package.json"] as const) {
        const manifestPath = join(currDir, manifestName)
        if (!nodeSyncHostIo.existsSync(manifestPath)) continue
        const readRes = Result.try({
          try: () => nodeSyncHostIo.readTextSync(manifestPath),
          catch: (err) => toErrorReasonMessage(err, `Failed to read manifest "${manifestPath}"`),
        })
        match(readRes)
          .with({ _tag: "Failure" }, ({ failure }) => {
            warnings.push(failure)
          })
          .with({ _tag: "Success" }, ({ success: raw }) => {
            match(decodeManifestJsonOption(raw))
              .with({ _tag: "None" }, () => {
                warnings.push(toErrorReasonMessage(`Failed to parse manifest "${manifestPath}"`))
              })
              .with({ _tag: "Some" }, ({ value: decoded }) => {
                const tags = [...(decoded.tags ?? []), ...(decoded.nx?.tags ?? [])]
                if (tags.length > 0) {
                  const parsed = parseManifestTags(tags)
                  for (const t of parsed.nxTags) tiers.add(t)
                  for (const s of parsed.scopeTags) scopes.add(s)
                }
              })
              .exhaustive()
          })
          .exhaustive()
      }
      if (currDir === resolvedRoot) break
      currDir = dirname(currDir)
    }
  }
  return {
    tiers: Array.from(tiers).slice(0, 16),
    scopes: Array.from(scopes).slice(0, 16),
    warnings,
  }
}

const resolveChangedFilesFromGit = (
  repoRoot: string,
  baseRef: string | undefined,
):
  | {
      readonly _tag: "Ok"
      readonly files: ReadonlyArray<string>
      readonly diffBase: string | undefined
    }
  | { readonly _tag: "Err"; readonly reason: string } => {
  if (!nodeSyncHostIo.existsSync(join(repoRoot, ".git"))) {
    return baseRef !== undefined
      ? { _tag: "Err", reason: `Cannot diff against --base '${baseRef}': no .git directory` }
      : { _tag: "Ok", files: [], diffBase: undefined }
  }
  const files = new Set<string>()
  if (baseRef !== undefined) {
    const err = addGitLinesOnOk(
      runGitSync(repoRoot, [
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "--end-of-options",
        baseRef,
        "--",
      ]),
      files,
    )
    if (err !== undefined) {
      return { _tag: "Err", reason: err }
    }
  } else {
    match(runGitSync(repoRoot, ["diff", "--name-only", "HEAD"]))
      .with({ _tag: "Ok" }, ({ stdout }) => {
        for (const f of parseGitFileLines(stdout)) files.add(f)
      })
      .with({ _tag: "Err" }, () => {
        addGitLinesOnOk(runGitSync(repoRoot, ["diff", "--name-only"]), files)
        addGitLinesOnOk(runGitSync(repoRoot, ["diff", "--cached", "--name-only"]), files)
      })
      .exhaustive()
  }

  addGitLinesOnOk(runGitSync(repoRoot, ["ls-files", "--others", "--exclude-standard"]), files)
  let fallbackDiffBase: string | undefined
  if (baseRef === undefined && files.size === 0) {
    for (const range of ["main...HEAD", "origin/main...HEAD", "HEAD~1...HEAD"]) {
      const added = match(tryGitDiffRange(repoRoot, range, nodeSyncHostIo))
        .with({ _tag: "Ok" }, ({ files: rangeFiles }) => {
          for (const f of rangeFiles) {
            const norm = normalizeCliRelPath(f)
            if (norm.length > 0 && !isHarnessRuntimeArtifact(norm)) files.add(norm)
          }
          return rangeFiles.length > 0
        })
        .with({ _tag: "RefMissing" }, { _tag: "GitFailed" }, () => false)
        .exhaustive()
      if (added) {
        fallbackDiffBase = range
        break
      }
    }
  }
  return {
    _tag: "Ok",
    files: Array.from(files).sort(compareCodeUnits),
    diffBase: baseRef ?? fallbackDiffBase,
  }
}

const collectGitDiffStats = (
  repoRoot: string,
  baseRef: string | undefined,
  files: ReadonlyArray<string>,
): { readonly changedLineCount: number; readonly diffSummary: string } => {
  if (files.length === 0 || !nodeSyncHostIo.existsSync(join(repoRoot, ".git"))) {
    return { changedLineCount: 0, diffSummary: "" }
  }
  const ref = baseRef ?? "HEAD"
  const numstatRes = runGitSync(repoRoot, [
    "--literal-pathspecs",
    "diff",
    "--numstat",
    "--no-renames",
    "--end-of-options",
    ref,
    "--",
    ...files,
  ])
  const statRes = runGitSync(repoRoot, [
    "--literal-pathspecs",
    "diff",
    "--stat",
    "--no-renames",
    "--end-of-options",
    ref,
    "--",
    ...files,
  ])
  const diffLines = match(numstatRes)
    .with({ _tag: "Ok" }, ({ stdout }) => parseNumstatChangedLines(stdout))
    .with({ _tag: "Err" }, () => 0)
    .exhaustive()
  const statSummary = match(statRes)
    .with({ _tag: "Ok" }, ({ stdout }) => stdout.trim().slice(0, 4096))
    .with({ _tag: "Err" }, () => "")
    .exhaustive()
  return { changedLineCount: Math.max(0, diffLines), diffSummary: statSummary }
}

export type PreparedReviewRouteInput =
  | { readonly _tag: "Error"; readonly reason: string }
  | {
      readonly _tag: "Skip"
      readonly plan: SkipReviewPlan
      readonly outputFormat: "json" | "text"
    }
  | {
      readonly _tag: "Ready"
      readonly rawDiffInput: ReviewRawDiffInput
      readonly warnings: ReadonlyArray<ErrorReasonMessage>
      readonly outputFormat: "json" | "text"
    }

/** Resolves CLI arguments, changed files, manifest tags, and git stats for `review-route`. */
export const prepareReviewRouteInput = (
  args: ReadonlyArray<string>,
  repoRoot: string,
): PreparedReviewRouteInput =>
  match(parseReviewRouteArgs(args))
    .with({ _tag: "Err" }, ({ reason }) => ({ _tag: "Error" as const, reason }))
    .with({ _tag: "Ok" }, ({ baseRef, explicitFiles, outputFormat }) => {
      if (explicitFiles.length > 0 && baseRef !== undefined) {
        const baseErr = verifyExplicitBaseRef(repoRoot, baseRef)
        if (baseErr !== undefined) {
          return { _tag: "Error" as const, reason: baseErr }
        }
      }
      const changedFilesRes =
        explicitFiles.length > 0
          ? {
              _tag: "Ok" as const,
              files: [...explicitFiles].sort(compareCodeUnits),
              diffBase: baseRef,
            }
          : resolveChangedFilesFromGit(repoRoot, baseRef)
      return match(changedFilesRes)
        .with({ _tag: "Err" }, ({ reason }) => ({ _tag: "Error" as const, reason }))
        .with({ _tag: "Ok" }, ({ files: changedFiles, diffBase }) => {
          if (changedFiles.length === 0) {
            return {
              _tag: "Skip" as const,
              outputFormat,
              plan: SkipReviewPlan.make({
                depth: ReviewDepth.make("skip"),
                source: ReviewRoutingSource.make("deterministic"),
                reason: ReviewRoutingReason.make("No changed files detected"),
                selections: [],
              }),
            }
          }
          const boundedFiles = changedFiles
            .slice(0, 200)
            .map((f) => ReviewRawFileInput.make(f.slice(0, 512)))
          const { tiers, scopes, warnings } = collectManifestTagsSafe(repoRoot, boundedFiles)
          const { changedLineCount, diffSummary } = collectGitDiffStats(
            repoRoot,
            diffBase,
            boundedFiles,
          )
          const rawDiffInput = Schema.decodeSync(ReviewRawDiffInput)({
            changedFiles: boundedFiles,
            diffSummary: ReviewSummaryText.make(diffSummary),
            changedLineCount: ReviewChangedLines.make(changedLineCount),
            touchedTiers: tiers,
            touchedScopes: scopes,
          })
          return {
            _tag: "Ready" as const,
            rawDiffInput,
            warnings,
            outputFormat,
          }
        })
        .exhaustive()
    })
    .exhaustive()

/** Formats a `ReviewRoutingPlan` for `harness review-route` JSON or text output. */
export const formatReviewRouteOutput = (
  plan: ReviewRoutingPlan,
  outputFormat: "json" | "text",
  warnings: ReadonlyArray<ErrorReasonMessage>,
  signals?: unknown,
): string => {
  const reviewSlices = match(plan)
    .with({ _tag: "ActiveReviewPlan" }, (active) => active.reviewSlices)
    .with({ _tag: "SkipReviewPlan" }, () => undefined)
    .exhaustive()
  return match(outputFormat)
    .with("json", () =>
      JSON.stringify({
        plan,
        ...(signals !== undefined ? { signals } : {}),
        ...(reviewSlices !== undefined ? { reviewSlices } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    )
    .with("text", () =>
      match(plan)
        .with(
          { _tag: "SkipReviewPlan" },
          (skip) => `depth: ${skip.depth}\nsource: ${skip.source}\nreason: ${skip.reason}`,
        )
        .with({ _tag: "ActiveReviewPlan" }, (active) => {
          const reviewers = active.selections
            .map((s) => `- ${s.reviewer}${s.mandatory ? " (mandatory)" : ""}: ${s.reason}`)
            .join("\n")
          return `depth: ${active.depth}\nsource: ${active.source}\nreviewers:\n${reviewers}`
        })
        .exhaustive(),
    )
    .exhaustive()
}

/** Routes changed diff files to deterministic and System One specialist code reviewers. */
export const handleReviewRoute = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const prepared = prepareReviewRouteInput(argv.slice(1), repoRoot)
    return yield* match(prepared)
      .with({ _tag: "Error" }, ({ reason }) =>
        Effect.succeed<CliResult>({ exitCode: 1, stdout: "", stderr: `${reason}\n` }),
      )
      .with({ _tag: "Skip" }, ({ plan, outputFormat }) =>
        Effect.succeed<CliResult>({
          exitCode: 0,
          stdout: formatReviewRouteOutput(plan, outputFormat, []),
          stderr: "",
        }),
      )
      .with({ _tag: "Ready" }, ({ rawDiffInput, warnings, outputFormat }) =>
        Effect.gen(function* () {
          const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
          const signals = yield* inferReviewDiffSignals(rawDiffInput)
          const routedPlan = yield* routeReviewDiff(rawDiffInput, signals).pipe(
            Effect.provide(decisionLayer),
          )
          const finalPlan = attachReviewSlicesIfThresholdReached(signals, routedPlan)
          return {
            exitCode: 0,
            stdout: formatReviewRouteOutput(finalPlan, outputFormat, warnings, signals),
            stderr: "",
          }
        }),
      )
      .exhaustive()
  }).pipe(
    Effect.catchTag("InvalidReviewRouteInputError", (err) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: `Invalid review-route input (${err.offendingPath}): ${err.reason}\n`,
      }),
    ),
  )
