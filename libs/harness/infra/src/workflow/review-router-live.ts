import { dirname, join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
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
  type WorkflowRouteReviewInput,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  compareCodeUnits,
  parseManifestTags,
  toErrorReasonMessage,
} from "@harness/contract"
import { routeReviewDiff } from "@harness/decision"
import { WorkflowReviewRouter, type WorkflowReviewRouterShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { LocalDecisionModel } from "../local-decision-model-live.js"
import { nodeSyncHostIo } from "../node-host-io.js"

/** Optional host and decision model overrides for `WorkflowReviewRouterLive`. */
export interface WorkflowReviewRouterOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly decisionModelLayer?: Layer.Layer<DecisionModel.DecisionModel> | undefined
}

const HARNESS_STAMP_ARTIFACTS: ReadonlySet<string> = new Set([
  ".harness/verify-stamp.json",
  ".harness/mutate-stamp.json",
])

const PackageTagsManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    tags: Schema.optional(Schema.Array(Schema.String)),
    nx: Schema.optional(
      Schema.Struct({
        tags: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
)
const decodePackageTags = Schema.decodeUnknownEffect(PackageTagsManifestSchema)

const getErrnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined

const toReviewFsError = (filePath: string, reason: unknown): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-review-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make("read"),
    reason: toErrorReasonMessage(reason, "Workflow review routing failed"),
  })
}

const readExistingFileTextOrFail = (
  filePath: string,
  hostIo: ExtendedHostIo,
): Effect.Effect<Option.Option<string>, WorkspaceFsError> =>
  Effect.gen(function* () {
    if (!hostIo.existsSync(filePath) || !hostIo.isFileSync(filePath)) {
      return Option.none()
    }
    return yield* Effect.try({
      try: () => Option.some(hostIo.readTextSync(filePath)),
      catch: (cause) =>
        getErrnoCode(cause) === "ENOENT" ? ("ENOENT" as const) : toReviewFsError(filePath, cause),
    }).pipe(
      Effect.catchIf(
        (err) => err === "ENOENT",
        () => Effect.succeedNone,
      ),
    )
  })

const normalizeRelPath = (raw: string): string => {
  let normalized = raw.trim().replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized
}

const runGitStdout = (
  hostIo: ExtendedHostIo,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, WorkspaceFsError> =>
  Effect.try({
    try: () => hostIo.execFileSync("git", args, { cwd }),
    catch: (cause) => toReviewFsError(cwd, cause),
  }).pipe(
    Effect.flatMap((res: SyncHostExecResult) =>
      match(res)
        .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
          exitCode === 0
            ? Effect.succeed(stdout)
            : Effect.fail(
                toReviewFsError(
                  cwd,
                  `git ${args.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
                ),
              ),
        )
        .with({ _tag: "TimedOut" }, ({ stderr }) =>
          Effect.fail(toReviewFsError(cwd, `git ${args.join(" ")} timed out: ${stderr.trim()}`)),
        )
        .with({ _tag: "Signaled" }, ({ signal }) =>
          Effect.fail(toReviewFsError(cwd, `git ${args.join(" ")} signaled (${signal})`)),
        )
        .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
          Effect.fail(toReviewFsError(cwd, `git ${args.join(" ")} spawn failed: ${spawnError}`)),
        )
        .exhaustive(),
    ),
  )

const parseLineList = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split(/\r?\n/)
    .map(normalizeRelPath)
    .filter((line) => line.length > 0 && !HARNESS_STAMP_ARTIFACTS.has(line))

const parseNumstatChangedLines = (stdout: string): number => {
  let total = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    const parts = trimmed.split(/\t+/)
    const added = parts[0] !== undefined ? Number(parts[0]) : 0
    const deleted = parts[1] !== undefined ? Number(parts[1]) : 0
    if (Number.isFinite(added) && added > 0) {
      total += Math.trunc(added)
    }
    if (Number.isFinite(deleted) && deleted > 0) {
      total += Math.trunc(deleted)
    }
  }
  return total
}

const collectManifestTags = (
  repoRoot: string,
  changedFiles: ReadonlyArray<string>,
  hostIo: ExtendedHostIo,
): Effect.Effect<
  { readonly tiers: ReadonlyArray<NxTierTag>; readonly scopes: ReadonlyArray<NxScopeTag> },
  WorkspaceFsError
> =>
  Effect.gen(function* () {
    const tiers = new Set<NxTierTag>()
    const scopes = new Set<NxScopeTag>()
    const visitedDirs = new Set<string>()

    for (const relFile of changedFiles) {
      let dir = dirname(join(repoRoot, relFile))
      while (dir.length >= repoRoot.length) {
        if (visitedDirs.has(dir)) {
          break
        }
        visitedDirs.add(dir)
        const pkgPath = join(dir, "package.json")
        const rawOpt = yield* readExistingFileTextOrFail(pkgPath, hostIo)
        const didMatchPkg = yield* match(rawOpt)
          .with({ _tag: "None" }, () => Effect.succeed(false))
          .with({ _tag: "Some" }, ({ value: raw }) =>
            Effect.gen(function* () {
              const decoded = yield* decodePackageTags(raw).pipe(
                Effect.mapError((err) => toReviewFsError(pkgPath, err)),
              )
              const rawTags = decoded.nx?.tags ?? decoded.tags ?? []
              const parsed = parseManifestTags(rawTags)
              for (const t of parsed.nxTags) {
                tiers.add(t)
              }
              for (const s of parsed.scopeTags) {
                scopes.add(s)
              }
              return true
            }),
          )
          .exhaustive()
        if (didMatchPkg) {
          break
        }
        const parent = dirname(dir)
        if (parent === dir) {
          break
        }
        dir = parent
      }
    }

    return {
      tiers: Array.from(tiers).slice(0, 16),
      scopes: Array.from(scopes).slice(0, 16),
    }
  })

/** Routes changed paths at the end of a workflow run via `Harness.routeReviewDiff`. */
export const routeWorkflowReviewImpl = Effect.fn("Harness.routeWorkflowReview")(function* (
  input: WorkflowRouteReviewInput,
  options?: WorkflowReviewRouterOptions,
): Effect.fn.Return<ReviewRoutingPlan, WorkspaceFsError> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const committed = parseLineList(
    yield* runGitStdout(hostIo, input.canonicalRepoRoot, [
      "diff",
      "--name-only",
      `${input.baseSha}..HEAD`,
    ]),
  )
  const unstaged = parseLineList(
    yield* runGitStdout(hostIo, input.canonicalRepoRoot, ["diff", "--name-only", "HEAD"]),
  )
  const staged = parseLineList(
    yield* runGitStdout(hostIo, input.canonicalRepoRoot, ["diff", "--cached", "--name-only"]),
  )
  const untracked = parseLineList(
    yield* runGitStdout(hostIo, input.canonicalRepoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  )

  const changedSet = new Set<string>([...committed, ...unstaged, ...staged, ...untracked])
  const changedFiles = Array.from(changedSet).sort(compareCodeUnits)

  if (changedFiles.length === 0) {
    return SkipReviewPlan.make({
      depth: ReviewDepth.make("skip"),
      source: ReviewRoutingSource.make("deterministic"),
      reason: ReviewRoutingReason.make("No changed files detected against baseSha"),
      selections: [],
    })
  }

  const numstatOut = yield* runGitStdout(hostIo, input.canonicalRepoRoot, [
    "diff",
    "--numstat",
    input.baseSha,
  ])
  const statOut = yield* runGitStdout(hostIo, input.canonicalRepoRoot, [
    "diff",
    "--stat",
    input.baseSha,
  ])

  let untrackedLineCount = 0
  for (const rel of untracked) {
    const absPath = join(input.canonicalRepoRoot, rel)
    const contentOpt = yield* readExistingFileTextOrFail(absPath, hostIo)
    match(contentOpt)
      .with({ _tag: "None" }, () => undefined)
      .with({ _tag: "Some" }, ({ value: content }) => {
        untrackedLineCount += content.length === 0 ? 0 : content.split(/\r?\n/).length
      })
      .exhaustive()
  }

  const changedLineCount = ReviewChangedLines.make(
    Math.max(0, parseNumstatChangedLines(numstatOut) + untrackedLineCount),
  )
  const untrackedSummary = untracked.length > 0 ? `\nUntracked: ${untracked.join(", ")}` : ""
  const diffSummary = ReviewSummaryText.make(
    `${statOut.trim()}${untrackedSummary}`.trim().slice(0, 4096),
  )

  const manifestTags = yield* collectManifestTags(input.canonicalRepoRoot, changedFiles, hostIo)
  const boundedChangedFiles = changedFiles
    .slice(0, 200)
    .map((file) => ReviewRawFileInput.make(file.slice(0, 512)))

  const rawDiffInput = yield* Schema.decodeEffect(ReviewRawDiffInput)({
    changedFiles: boundedChangedFiles,
    diffSummary,
    changedLineCount,
    touchedTiers: manifestTags.tiers,
    touchedScopes: manifestTags.scopes,
  }).pipe(Effect.mapError((err) => toReviewFsError(input.canonicalRepoRoot, err)))

  const decisionLayer = options?.decisionModelLayer ?? LocalDecisionModel

  return yield* routeReviewDiff(rawDiffInput).pipe(
    Effect.provide(decisionLayer),
    Effect.mapError((err) => toReviewFsError(input.canonicalRepoRoot, err.reason)),
  )
})

/** Constructs a `WorkflowReviewRouter` layer. */
const makeWorkflowReviewRouterLayer = (
  options?: WorkflowReviewRouterOptions,
): Layer.Layer<WorkflowReviewRouter> =>
  Layer.succeed(WorkflowReviewRouter, {
    routeReview: (input) => routeWorkflowReviewImpl(input, options),
  } satisfies WorkflowReviewRouterShape)

/** Production `WorkflowReviewRouter` layer. */
export const WorkflowReviewRouterLive: Layer.Layer<WorkflowReviewRouter> =
  makeWorkflowReviewRouterLayer()

export { makeWorkflowReviewRouterLayer }
