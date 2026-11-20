import { createHash, randomUUID } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  CompiledPlan,
  type CyclicPlanWorkflowError,
  type DisjointOwnershipViolationError,
  GitCommitSha,
  type InvalidPlanWorkflowGraphError,
  NxProjectName,
  OwnedRelPath,
  PackageVerifyCommand,
  PlanSha256,
  SliceBranchName,
  StubSymbolKey,
  UnitDependency,
  UnitMode,
  WorkUnitDraft,
  WorkUnitId,
  WorkflowLevel,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  compareCodeUnits,
  toErrorReasonMessage,
} from "@harness/contract"
import { PlanWorkflowCompiler, scanWorkspaceTsFilesChecked } from "@harness/gates"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"

/** Input options for extracting and compiling a `CompiledPlan` from a repository workspace. */
export interface CompileWorkflowPlanRequest {
  readonly repoRoot: AbsoluteRepoRoot
  readonly level: WorkflowLevel
  readonly mode: UnitMode
  readonly inputJsonPath?: WorkspaceFilePath | undefined
  readonly hostIo?: ExtendedHostIo | undefined
}

/** Failure union emitted by `compileWorkflowPlanFromRepo`. */
export type CompileWorkflowPlanError =
  | CyclicPlanWorkflowError
  | DisjointOwnershipViolationError
  | InvalidPlanWorkflowGraphError
  | WorkspaceFsError
  | Schema.SchemaError

const PlanWorkflowFileInputSchema = Schema.Struct({
  runId: Schema.optional(WorkflowRunId),
  level: Schema.optional(WorkflowLevel),
  baseSha: Schema.optional(GitCommitSha),
  mode: Schema.optional(UnitMode),
  units: Schema.Array(WorkUnitDraft),
  dependencies: Schema.optional(Schema.Array(UnitDependency)),
  sharedStepPaths: Schema.optional(Schema.Array(OwnedRelPath)),
})
const decodePlanWorkflowFileJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlanWorkflowFileInputSchema),
)

const PackageManifestNameSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
  }),
)
const decodePackageManifestNameOption = Schema.decodeUnknownOption(PackageManifestNameSchema)

const toPlanFsError = (
  filePath: string,
  operation: "read" | "stat" | "readdir",
  reason: unknown,
): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-plan-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(reason, "Workflow plan extraction failed"),
  })
}

const resolveGitHeadSha = (
  repoRoot: AbsoluteRepoRoot,
  hostIo: ExtendedHostIo,
): Effect.Effect<GitCommitSha, WorkspaceFsError> =>
  Effect.try({
    try: () => hostIo.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    catch: (cause) => toPlanFsError(repoRoot, "read", cause),
  }).pipe(
    Effect.flatMap((res: SyncHostExecResult) =>
      match(res)
        .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
          if (exitCode !== 0) {
            return Effect.fail(
              toPlanFsError(
                repoRoot,
                "read",
                `git rev-parse HEAD exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
              ),
            )
          }
          return Schema.decodeEffect(GitCommitSha)(stdout.trim()).pipe(
            Effect.mapError((err) => toPlanFsError(repoRoot, "read", err)),
          )
        })
        .with({ _tag: "TimedOut" }, ({ stderr }) =>
          Effect.fail(
            toPlanFsError(repoRoot, "read", `git rev-parse HEAD timed out: ${stderr.trim()}`),
          ),
        )
        .with({ _tag: "Signaled" }, ({ signal }) =>
          Effect.fail(toPlanFsError(repoRoot, "read", `git rev-parse HEAD signaled (${signal})`)),
        )
        .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
          Effect.fail(toPlanFsError(repoRoot, "read", `git rev-parse HEAD failed: ${spawnError}`)),
        )
        .exhaustive(),
    ),
  )

const sanitizeWorkUnitId = (raw: string): WorkUnitId => {
  const cleaned = raw
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
  return WorkUnitId.make(cleaned.length > 0 ? cleaned : "unit")
}

const sanitizeSliceBranchSegment = (raw: string): string => {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unit"
}

const extractActiveStubSpansFromSource = (content: string): ReadonlyArray<StubSymbolKey> => {
  if (!content.includes("stub")) {
    return []
  }
  const spans = new Set<StubSymbolKey>()
  const fnRe = /Effect\.fn\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  let lastMatch: RegExpExecArray | null = fnRe.exec(content)
  while (lastMatch !== null) {
    const spanName = lastMatch[1]
    const nextMatch = fnRe.exec(content)
    const sliceEnd = nextMatch !== null ? nextMatch.index : content.length
    const segment = content.slice(lastMatch.index, sliceEnd)
    if (
      spanName !== undefined &&
      spanName.trim().length > 0 &&
      /\bstub(?:\s*<|\s*\()/.test(segment)
    ) {
      match(Schema.decodeOption(StubSymbolKey)(spanName.trim()))
        .with({ _tag: "Some" }, ({ value }) => {
          spans.add(value)
        })
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
    }
    lastMatch = nextMatch
  }
  return Array.from(spans).sort(compareCodeUnits)
}

interface PackageStubCluster {
  readonly packageRelDir: OwnedRelPath
  readonly projectName: NxProjectName
  readonly stubKeys: Array<StubSymbolKey>
}

const findNearestPackageForFile = (
  repoRoot: string,
  absFilePath: string,
  hostIo: ExtendedHostIo,
): { readonly relDir: OwnedRelPath; readonly projectName: NxProjectName } | undefined => {
  let current = dirname(absFilePath)
  while (current.length > repoRoot.length) {
    const pkgPath = join(current, "package.json")
    if (hostIo.existsSync(pkgPath) && hostIo.isFileSync(pkgPath)) {
      const readRes = Result.try(() => hostIo.readTextSync(pkgPath))
      const pkgName = match(readRes)
        .with({ _tag: "Success" }, ({ success: raw }) =>
          match(decodePackageManifestNameOption(raw))
            .with({ _tag: "Some" }, ({ value }) => value.name)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive(),
        )
        .with({ _tag: "Failure" }, () => undefined)
        .exhaustive()

      const relDirRaw = relative(repoRoot, current).replaceAll("\\", "/")
      const relDirOpt = Schema.decodeOption(OwnedRelPath)(relDirRaw)
      const projectNameOpt =
        pkgName !== undefined
          ? Schema.decodeOption(NxProjectName)(pkgName)
          : Option.none<NxProjectName>()

      return match([relDirOpt, projectNameOpt] as const)
        .with(
          [{ _tag: "Some" }, { _tag: "Some" }],
          ([{ value: relDir }, { value: projectName }]) => ({
            relDir,
            projectName,
          }),
        )
        .otherwise(() => undefined)
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return undefined
}

const extractDraftUnitsFromWorkspaceStubs = (
  repoRoot: AbsoluteRepoRoot,
  level: WorkflowLevel,
  hostIo: ExtendedHostIo,
): Effect.Effect<ReadonlyArray<WorkUnitDraft>, WorkspaceFsError> =>
  Effect.gen(function* () {
    const scanRes = scanWorkspaceTsFilesChecked(repoRoot, hostIo)
    const files = yield* match(scanRes)
      .with({ _tag: "Ok" }, ({ files: scanned }) => Effect.succeed(scanned))
      .with({ _tag: "Error" }, ({ reason }) =>
        Effect.fail(toPlanFsError(repoRoot, "readdir", reason)),
      )
      .exhaustive()

    const clustersByDir = new Map<string, PackageStubCluster>()

    for (const absFile of files) {
      const relFile = relative(repoRoot, absFile).replaceAll("\\", "/")
      if (
        !relFile.includes("/src/") ||
        (!relFile.startsWith("libs/") &&
          !relFile.startsWith("apps/") &&
          !relFile.startsWith("packages/"))
      ) {
        continue
      }
      const contentRes = Result.try(() => hostIo.readTextSync(absFile))
      const content = match(contentRes)
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, () => undefined)
        .exhaustive()
      if (content === undefined || !content.includes("stub")) {
        continue
      }
      const stubKeys = extractActiveStubSpansFromSource(content)
      if (stubKeys.length === 0) {
        continue
      }
      const pkg = findNearestPackageForFile(repoRoot, absFile, hostIo)
      if (pkg === undefined) {
        continue
      }
      const existing = clustersByDir.get(pkg.relDir)
      if (existing !== undefined) {
        for (const key of stubKeys) {
          if (!existing.stubKeys.includes(key)) {
            existing.stubKeys.push(key)
          }
        }
      } else {
        clustersByDir.set(pkg.relDir, {
          packageRelDir: pkg.relDir,
          projectName: pkg.projectName,
          stubKeys: [...stubKeys],
        })
      }
    }

    const sortedClusters = Array.from(clustersByDir.values()).sort((a, b) =>
      compareCodeUnits(a.projectName, b.projectName),
    )

    return sortedClusters.map((cluster): WorkUnitDraft => {
      const unitId = sanitizeWorkUnitId(cluster.projectName)
      return match(level)
        .with("slice", () => ({
          _tag: "PackageUnit" as const,
          unitId,
          projectName: cluster.projectName,
          ownedRelPaths: [cluster.packageRelDir],
          stubKeys: [...cluster.stubKeys].sort(compareCodeUnits),
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make(
            `pnpm nx run ${cluster.projectName}:verify`,
          ),
        }))
        .with("epic", () => ({
          _tag: "SliceUnit" as const,
          unitId,
          branch: SliceBranchName.make(`slice/${sanitizeSliceBranchSegment(unitId)}-unit`),
          ownedRelPaths: [cluster.packageRelDir],
          earsKeys: [],
        }))
        .exhaustive()
    })
  })

/** Compiles either an explicit `PlanWorkflowInput` JSON file or active repo stub targets into a `CompiledPlan`. */
export const compileWorkflowPlanFromRepo = Effect.fn("Harness.compileWorkflowPlanFromRepo")(
  function* (
    request: CompileWorkflowPlanRequest,
  ): Effect.fn.Return<CompiledPlan, CompileWorkflowPlanError> {
    const hostIo = request.hostIo ?? nodeSyncHostIo

    const extracted = yield* match(request.inputJsonPath)
      .with(undefined, () =>
        Effect.gen(function* () {
          const baseSha = yield* resolveGitHeadSha(request.repoRoot, hostIo)
          const units = yield* extractDraftUnitsFromWorkspaceStubs(
            request.repoRoot,
            request.level,
            hostIo,
          )
          return {
            runId: undefined as WorkflowRunId | undefined,
            level: request.level,
            baseSha,
            mode: request.mode,
            units,
            dependencies: [] as ReadonlyArray<UnitDependency>,
            sharedStepPaths: [] as ReadonlyArray<OwnedRelPath>,
          }
        }),
      )
      .otherwise((inputJsonPath) =>
        Effect.gen(function* () {
          const resolvedPath = resolve(request.repoRoot, inputJsonPath)
          const rawText = yield* Effect.try({
            try: () => hostIo.readTextSync(resolvedPath),
            catch: (cause) => toPlanFsError(resolvedPath, "read", cause),
          })
          const parsed = yield* decodePlanWorkflowFileJson(rawText)
          const baseSha =
            parsed.baseSha !== undefined
              ? parsed.baseSha
              : yield* resolveGitHeadSha(request.repoRoot, hostIo)
          return {
            runId: parsed.runId,
            level: parsed.level ?? request.level,
            baseSha,
            mode: parsed.mode ?? request.mode,
            units: parsed.units,
            dependencies: parsed.dependencies ?? [],
            sharedStepPaths: parsed.sharedStepPaths ?? [],
          }
        }),
      )

    const compiledWaves = yield* PlanWorkflowCompiler.decide({
      units: extracted.units,
      dependencies: extracted.dependencies,
    })

    const planShaDigest = createHash("sha256")
      .update(
        JSON.stringify({
          level: extracted.level,
          baseSha: extracted.baseSha,
          mode: extracted.mode,
          units: compiledWaves.units,
          sharedStepPaths: extracted.sharedStepPaths,
        }),
      )
      .digest("hex")

    const planSha = PlanSha256.make(planShaDigest)
    const runId =
      extracted.runId ?? WorkflowRunId.make(`wf-${randomUUID().replace(/-/g, "").slice(0, 12)}`)

    return yield* Schema.decodeEffect(CompiledPlan)({
      runId,
      level: extracted.level,
      planSha,
      baseSha: extracted.baseSha,
      mode: extracted.mode,
      units: compiledWaves.units,
      sharedStepPaths: extracted.sharedStepPaths,
    })
  },
)
