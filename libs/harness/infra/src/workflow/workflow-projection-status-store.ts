import { basename, isAbsolute, join, relative, sep } from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  GitCommonDirPath,
  WorkflowProjectionStatus,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  toErrorReasonMessage,
} from "@harness/contract"
import { resolveGitCommonDir } from "@harness/graph/cluster-resolver"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { resolveWorkflowRuntimePaths } from "../worktree-repo-root.js"

const STATUS_FILENAME = "workflow-projection-status.json" as const
const MAX_STATUS_FILE_BYTES = 2 * 1024 * 1024
const STATE_DIR_MODE = 0o700
const STATUS_FILE_MODE = 0o600

export const WORKFLOW_PROJECTION_STATUS_STORE_VERSION = 1 as const

/** Schema-validated persisted map of workflow run readable projection statuses. */
export const WorkflowProjectionStatusStoreData = Schema.Struct({
  version: Schema.Literal(WORKFLOW_PROJECTION_STATUS_STORE_VERSION),
  statuses: Schema.Record(WorkflowRunId, WorkflowProjectionStatus),
})
export type WorkflowProjectionStatusStoreData = typeof WorkflowProjectionStatusStoreData.Type

const WorkflowProjectionStatusStoreJson = Schema.fromJsonString(WorkflowProjectionStatusStoreData)
const decodeStatusStoreOption = Schema.decodeUnknownOption(WorkflowProjectionStatusStoreJson)
const encodeStatusStoreSync = Schema.encodeSync(WorkflowProjectionStatusStoreJson)
const decodeGitCommonDirOption = Schema.decodeUnknownOption(GitCommonDirPath)

export interface ResolvedWorkflowProjectionStatusPath {
  readonly baseDir: string
  readonly stateDir: string
  readonly statusFilePath: WorkspaceFilePath
}

const makeStatusStoreError = (
  filePath: string,
  operation: "read" | "write" | "stat",
  reason: unknown,
): WorkspaceFsError => {
  const safePath = match(Schema.decodeOption(WorkspaceFilePath)(filePath))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => WorkspaceFilePath.make("/invalid-projection-status-path"))
    .exhaustive()
  return new WorkspaceFsError({
    filePath: safePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(reason, "Workflow projection status store operation failed"),
  })
}

const isExtendedHostIo = (hostIo: SyncHostIo): hostIo is ExtendedHostIo =>
  "tryWriteExclusiveTextSync" in hostIo &&
  typeof hostIo.tryWriteExclusiveTextSync === "function" &&
  "chmodSync" in hostIo &&
  typeof hostIo.chmodSync === "function" &&
  "readBytesPrefixSync" in hostIo &&
  typeof hostIo.readBytesPrefixSync === "function"

const isWithinBaseDir = (realBaseDir: string, realTarget: string): boolean => {
  const rel = relative(realBaseDir, realTarget)
  return rel.length === 0 || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const assertNotSymlink = (
  hostIo: SyncHostIo,
  targetPath: string,
  label: string,
  operation: "read" | "write" | "stat",
): Result.Result<void, WorkspaceFsError> =>
  Result.flatMap(
    Result.try({
      try: () => hostIo.isSymbolicLinkSync(targetPath),
      catch: (cause) => makeStatusStoreError(targetPath, operation, cause),
    }),
    (isSymlink) =>
      isSymlink
        ? Result.fail(
            makeStatusStoreError(
              targetPath,
              operation,
              `Refusing symlink ${label} '${targetPath}'`,
            ),
          )
        : Result.succeed(undefined),
  )

const readValidatedStatusText = (
  hostIo: SyncHostIo,
  filePath: string,
): Result.Result<string, WorkspaceFsError> =>
  Result.try({
    try: () =>
      isExtendedHostIo(hostIo)
        ? Buffer.from(hostIo.readBytesPrefixSync(filePath, MAX_STATUS_FILE_BYTES)).toString("utf8")
        : hostIo.readTextSync(filePath),
    catch: (cause) => makeStatusStoreError(filePath, "read", cause),
  })

const parseStatusMapFromText = (
  rawText: string,
  filePath: string,
  operation: "read" | "write",
): Result.Result<Map<WorkflowRunId, WorkflowProjectionStatus>, WorkspaceFsError> =>
  match(decodeStatusStoreOption(rawText))
    .with({ _tag: "None" }, () =>
      Result.fail(
        makeStatusStoreError(
          filePath,
          operation,
          `Corrupt or schema-invalid workflow projection status store at '${filePath}'`,
        ),
      ),
    )
    .with({ _tag: "Some" }, ({ value }) => {
      const result = new Map<WorkflowRunId, WorkflowProjectionStatus>()
      for (const [runIdRaw, status] of Object.entries(value.statuses)) {
        match(Schema.decodeOption(WorkflowRunId)(runIdRaw))
          .with({ _tag: "Some" }, ({ value: runId }) => {
            result.set(runId, status)
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      }
      return Result.succeed(result)
    })
    .exhaustive()

/**
 * Resolves the persisted `workflow-projection-status.json` path under
 * `<git-common-dir>/harness/workflow-projection-status.json` when inside a git checkout,
 * or `<repoRoot>/.harness/workflow-projection-status.json` when `.git` is absent.
 */
const resolveWorkflowProjectionStatusPath = (
  repoRoot: AbsoluteRepoRoot,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ResolvedWorkflowProjectionStatusPath => {
  const rawCommonGitDir = resolveGitCommonDir(repoRoot, hostIo)
  if (rawCommonGitDir !== null) {
    const commonGitOpt = decodeGitCommonDirOption(rawCommonGitDir)
    const matchedCommon = Option.getOrUndefined(commonGitOpt)
    if (matchedCommon !== undefined) {
      return {
        baseDir: matchedCommon,
        stateDir: join(matchedCommon, "harness"),
        statusFilePath: resolveWorkflowRuntimePaths(matchedCommon).projectionStatusPath,
      }
    }
  }
  const stateDir = join(repoRoot, ".harness")
  return {
    baseDir: repoRoot,
    stateDir,
    statusFilePath: WorkspaceFilePath.make(join(stateDir, STATUS_FILENAME)),
  }
}

const readExistingStatusesSync = (
  paths: ResolvedWorkflowProjectionStatusPath,
  hostIo: SyncHostIo,
  operation: "read" | "write",
): Result.Result<Map<WorkflowRunId, WorkflowProjectionStatus>, WorkspaceFsError> =>
  Result.gen(function* () {
    yield* assertNotSymlink(hostIo, paths.baseDir, "status base directory", operation)
    yield* assertNotSymlink(hostIo, paths.stateDir, "status directory", operation)
    yield* assertNotSymlink(hostIo, paths.statusFilePath, "status file", operation)

    const baseExists = yield* Result.try({
      try: () => hostIo.existsSync(paths.baseDir),
      catch: (cause) => makeStatusStoreError(paths.baseDir, "stat", cause),
    })
    if (!baseExists) {
      return yield* match(operation)
        .with("read", () => Result.succeed(new Map<WorkflowRunId, WorkflowProjectionStatus>()))
        .with("write", () =>
          Result.fail(
            makeStatusStoreError(
              paths.baseDir,
              "write",
              `Base directory '${paths.baseDir}' does not exist`,
            ),
          ),
        )
        .exhaustive()
    }

    const fileExists = yield* Result.try({
      try: () => hostIo.existsSync(paths.statusFilePath),
      catch: (cause) => makeStatusStoreError(paths.statusFilePath, "stat", cause),
    })
    if (!fileExists) {
      return new Map<WorkflowRunId, WorkflowProjectionStatus>()
    }

    const isRegFile = yield* Result.try({
      try: () => hostIo.isFileSync(paths.statusFilePath),
      catch: (cause) => makeStatusStoreError(paths.statusFilePath, "stat", cause),
    })
    if (!isRegFile) {
      return yield* Result.fail(
        makeStatusStoreError(
          paths.statusFilePath,
          operation,
          `Status path '${paths.statusFilePath}' is not a regular file`,
        ),
      )
    }

    const contained = yield* Result.try({
      try: () => {
        const realBase = hostIo.realpathSync(paths.baseDir)
        const realDir = hostIo.realpathSync(paths.stateDir)
        const realFile = hostIo.realpathSync(paths.statusFilePath)
        const expectedDir = join(realBase, basename(paths.stateDir))
        const expectedFile = join(realDir, STATUS_FILENAME)
        return (
          isWithinBaseDir(realBase, realDir) &&
          realDir === expectedDir &&
          isWithinBaseDir(realBase, realFile) &&
          realFile === expectedFile
        )
      },
      catch: (cause) => makeStatusStoreError(paths.statusFilePath, "stat", cause),
    })
    if (!contained) {
      return yield* Result.fail(
        makeStatusStoreError(
          paths.statusFilePath,
          operation,
          `Status file '${paths.statusFilePath}' resolves outside containment root '${paths.baseDir}'`,
        ),
      )
    }

    const rawText = yield* readValidatedStatusText(hostIo, paths.statusFilePath)
    return yield* parseStatusMapFromText(rawText, paths.statusFilePath, operation)
  })

/** Reads persisted `WorkflowProjectionStatus` entries with symlink-safe containment checks. */
const readWorkflowProjectionStatuses = Effect.fn("WorkflowProjectionStatusStore.read")(function* (
  repoRoot: AbsoluteRepoRoot,
  hostIo: SyncHostIo = nodeSyncHostIo,
): Effect.fn.Return<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>, WorkspaceFsError> {
  const paths = resolveWorkflowProjectionStatusPath(repoRoot, hostIo)
  return yield* match(readExistingStatusesSync(paths, hostIo, "read"))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
    .exhaustive()
})

const unlinkBestEffort = (hostIo: SyncHostIo, tmpPath: string): void => {
  Result.try(() => {
    if (!hostIo.isSymbolicLinkSync(tmpPath) && hostIo.existsSync(tmpPath)) {
      hostIo.unlinkSync(tmpPath)
    }
  })
}

const prepareContainedStateDir = (
  paths: ResolvedWorkflowProjectionStatusPath,
  hostIo: SyncHostIo,
): Result.Result<string, WorkspaceFsError> =>
  Result.gen(function* () {
    const isBaseDir = yield* Result.try({
      try: () => hostIo.isDirectorySync(paths.baseDir),
      catch: (cause) => makeStatusStoreError(paths.baseDir, "write", cause),
    })
    if (!isBaseDir) {
      return yield* Result.fail(
        makeStatusStoreError(
          paths.baseDir,
          "write",
          `Status base path '${paths.baseDir}' is not a directory`,
        ),
      )
    }
    const realBase = yield* Result.try({
      try: () => hostIo.realpathSync(paths.baseDir),
      catch: (cause) => makeStatusStoreError(paths.baseDir, "write", cause),
    })
    yield* Result.try({
      try: () => {
        hostIo.mkdirRecursiveSync(paths.stateDir, STATE_DIR_MODE)
      },
      catch: (cause) => makeStatusStoreError(paths.stateDir, "write", cause),
    })
    yield* assertNotSymlink(hostIo, paths.stateDir, "status directory after mkdir", "write")
    const isStateDir = yield* Result.try({
      try: () => hostIo.isDirectorySync(paths.stateDir),
      catch: (cause) => makeStatusStoreError(paths.stateDir, "write", cause),
    })
    if (!isStateDir) {
      return yield* Result.fail(
        makeStatusStoreError(
          paths.stateDir,
          "write",
          `Status directory '${paths.stateDir}' is not a directory`,
        ),
      )
    }
    const realDir = yield* Result.try({
      try: () => hostIo.realpathSync(paths.stateDir),
      catch: (cause) => makeStatusStoreError(paths.stateDir, "write", cause),
    })
    const expectedDir = join(realBase, basename(paths.stateDir))
    if (!isWithinBaseDir(realBase, realDir) || realDir !== expectedDir) {
      return yield* Result.fail(
        makeStatusStoreError(
          paths.stateDir,
          "write",
          `Status directory '${paths.stateDir}' resolves outside '${realBase}'`,
        ),
      )
    }
    yield* assertNotSymlink(hostIo, paths.statusFilePath, "status file", "write")
    return realDir
  })

const writePayloadAtomicSync = (
  hostIo: SyncHostIo,
  tmpPath: string,
  targetFilePath: string,
  payload: string,
): Result.Result<void, WorkspaceFsError> => {
  const attempt = Result.try({
    try: (): Result.Result<void, WorkspaceFsError> => {
      if (isExtendedHostIo(hostIo)) {
        const exclRes = hostIo.tryWriteExclusiveTextSync(tmpPath, `${payload}\n`, STATUS_FILE_MODE)
        return match(exclRes)
          .with({ _tag: "Written" }, () => {
            hostIo.renameSync(tmpPath, targetFilePath)
            hostIo.chmodSync(targetFilePath, STATUS_FILE_MODE)
            return Result.succeed(undefined)
          })
          .with({ _tag: "Exists" }, () =>
            Result.fail(
              makeStatusStoreError(
                tmpPath,
                "write",
                `Refusing pre-existing temp status file '${tmpPath}'`,
              ),
            ),
          )
          .with({ _tag: "Failed" }, ({ code, message }) =>
            Result.fail(
              makeStatusStoreError(
                tmpPath,
                "write",
                `Exclusive temp status write failed${code !== undefined ? ` (${code})` : ""}: ${message}`,
              ),
            ),
          )
          .exhaustive()
      }
      hostIo.writeTextSync(tmpPath, `${payload}\n`)
      hostIo.renameSync(tmpPath, targetFilePath)
      return Result.succeed(undefined)
    },
    catch: (cause) => makeStatusStoreError(targetFilePath, "write", cause),
  })
  return match(attempt)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .exhaustive()
}

/**
 * Atomically writes or updates one `runId -> WorkflowProjectionStatus` entry at `0o600`
 * with symlink-safe containment under `<git-common-dir>/harness/` or `<repoRoot>/.harness/`.
 */
const writeWorkflowProjectionStatus = Effect.fn("WorkflowProjectionStatusStore.write")(function* (
  repoRoot: AbsoluteRepoRoot,
  runId: WorkflowRunId,
  status: WorkflowProjectionStatus,
  hostIo: SyncHostIo = nodeSyncHostIo,
): Effect.fn.Return<void, WorkspaceFsError> {
  const paths = resolveWorkflowProjectionStatusPath(repoRoot, hostIo)
  const existingMap = yield* match(readExistingStatusesSync(paths, hostIo, "write"))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
    .exhaustive()

  const realDir = yield* match(prepareContainedStateDir(paths, hostIo))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
    .exhaustive()

  const mergedStatuses = new Map(existingMap)
  mergedStatuses.set(runId, status)
  const statusRecord: Record<WorkflowRunId, WorkflowProjectionStatus> = {}
  for (const [k, v] of mergedStatuses.entries()) {
    statusRecord[k] = v
  }
  const payload = encodeStatusStoreSync({
    version: WORKFLOW_PROJECTION_STATUS_STORE_VERSION,
    statuses: statusRecord,
  })

  const targetFilePath = join(realDir, STATUS_FILENAME)
  const nonce = Math.random().toString(36).slice(2, 10)
  const tmpPath = join(realDir, `${STATUS_FILENAME}.tmp.${process.pid}.${Date.now()}.${nonce}`)

  return yield* match(writePayloadAtomicSync(hostIo, tmpPath, targetFilePath, payload))
    .with({ _tag: "Success" }, () => Effect.void)
    .with({ _tag: "Failure" }, ({ failure }) => {
      unlinkBestEffort(hostIo, tmpPath)
      return Effect.fail(failure)
    })
    .exhaustive()
})

export {
  readWorkflowProjectionStatuses,
  resolveWorkflowProjectionStatusPath,
  writeWorkflowProjectionStatus,
}
