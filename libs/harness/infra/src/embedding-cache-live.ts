import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EmbeddingCacheError,
  type EmbeddingCacheErrorKind,
  type EmbeddingCacheOperation,
  EmbeddingCacheSnapshot,
  ErrorReasonMessage,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import { isRelativeEscape } from "@harness/graph"
import { EmbeddingCachePort } from "@harness/service"
import { resolveHarnessStateDir } from "./cache-helpers.js"
import { nodeSyncHostIo } from "./node-host-io.js"

const DEFAULT_CACHE_FILENAME = "embeddings-v1.json"
const decodeCacheSnapshot = Schema.decodeEffect(Schema.fromJsonString(EmbeddingCacheSnapshot))
const encodeCacheSnapshot = Schema.encodeSync(Schema.fromJsonString(EmbeddingCacheSnapshot))

export interface FileEmbeddingCacheOptions {
  readonly cacheFilename?: string | undefined
}

const isContainedWithinDir = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || !isRelativeEscape(rel)
}

const makeCacheError = (
  operation: EmbeddingCacheOperation,
  kind: EmbeddingCacheErrorKind,
  targetPath: string,
  reason: string,
): EmbeddingCacheError =>
  new EmbeddingCacheError({
    operation,
    kind,
    path: WorkspaceFilePath.make(targetPath.trim() || "<unknown>"),
    reason: ErrorReasonMessage.make(
      toErrorReasonMessage(reason, "Embedding cache operation failed"),
    ),
  })

const hasNodeErrno = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && "code" in err && err.code === code

const resolveSafeCacheTarget = (
  repoRoot: WorkspaceFilePath,
  cacheFilename: string,
  operation: EmbeddingCacheOperation,
): Effect.Effect<
  { readonly stateDir: string; readonly cacheDir: string; readonly cachePath: string },
  EmbeddingCacheError
> => {
  const res = Result.try(() => {
    const stateDir = resolve(resolveHarnessStateDir(repoRoot))
    const cacheDir = join(stateDir, "cache")
    const cachePath = resolve(cacheDir, cacheFilename)
    return { stateDir, cacheDir, cachePath }
  })
  return match(res)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeCacheError(
          operation,
          "invalid-state-dir",
          repoRoot,
          `Invalid state directory for ${repoRoot}: ${toErrorReasonMessage(failure)}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) => {
      if (!isContainedWithinDir(success.cacheDir, success.cachePath)) {
        return Effect.fail(
          makeCacheError(
            operation,
            "boundary-escape",
            success.cachePath,
            `Cache filename '${cacheFilename}' escapes cache directory '${success.cacheDir}'`,
          ),
        )
      }
      return Effect.succeed(success)
    })
    .exhaustive()
}

const checkNotSymlink = (
  operation: EmbeddingCacheOperation,
  targetPath: string,
  label: string,
): Effect.Effect<void, EmbeddingCacheError> => {
  const probe = Result.try(() => nodeSyncHostIo.isSymbolicLinkSync(targetPath))
  return match(probe)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeCacheError(
          operation,
          "io-error",
          targetPath,
          `Failed inspecting ${label} at ${targetPath}: ${toErrorReasonMessage(failure)}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success: isSymlink }) =>
      isSymlink
        ? Effect.fail(
            makeCacheError(
              operation,
              "symlink-refused",
              targetPath,
              `Refusing symlink ${label} ${targetPath}`,
            ),
          )
        : Effect.void,
    )
    .exhaustive()
}

const verifySafeCacheDirectories = (
  operation: EmbeddingCacheOperation,
  stateDir: string,
  cacheDir: string,
  cachePath: string,
): Effect.Effect<void, EmbeddingCacheError> =>
  Effect.gen(function* () {
    yield* checkNotSymlink(operation, stateDir, "state directory")
    yield* checkNotSymlink(operation, cacheDir, "cache directory")
    yield* checkNotSymlink(operation, cachePath, "cache file")
    if (nodeSyncHostIo.existsSync(stateDir) && nodeSyncHostIo.existsSync(cacheDir)) {
      const realCheck = Result.try(() => ({
        stateReal: nodeSyncHostIo.realpathSync(stateDir),
        cacheDirReal: nodeSyncHostIo.realpathSync(cacheDir),
      }))
      const resolvedDirs = yield* match(realCheck)
        .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.fail(
            makeCacheError(
              operation,
              "io-error",
              cacheDir,
              `Failed resolving cache directory realpath: ${toErrorReasonMessage(failure)}`,
            ),
          ),
        )
        .exhaustive()
      if (!isContainedWithinDir(resolvedDirs.stateReal, resolvedDirs.cacheDirReal)) {
        return yield* makeCacheError(
          operation,
          "boundary-escape",
          cacheDir,
          `Cache directory escapes state directory boundary ${cacheDir}`,
        )
      }
      if (nodeSyncHostIo.existsSync(cachePath)) {
        const realFileRes = Result.try(() => nodeSyncHostIo.realpathSync(cachePath))
        const realFile = yield* match(realFileRes)
          .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.fail(
              makeCacheError(
                operation,
                "io-error",
                cachePath,
                `Failed resolving cache file realpath: ${toErrorReasonMessage(failure)}`,
              ),
            ),
          )
          .exhaustive()
        if (!isContainedWithinDir(resolvedDirs.cacheDirReal, realFile)) {
          return yield* makeCacheError(
            operation,
            "boundary-escape",
            cachePath,
            `Cache file escapes cache directory boundary ${cacheDir}`,
          )
        }
      }
    }
  })

const readRegularFileNoFollow = (
  filePath: string,
): Effect.Effect<Option.Option<string>, EmbeddingCacheError> => {
  const openRes = Result.try(() =>
    openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
  )
  return match(openRes)
    .with({ _tag: "Failure" }, ({ failure }) => {
      if (hasNodeErrno(failure, "ENOENT")) {
        return Effect.succeedNone
      }
      if (hasNodeErrno(failure, "ELOOP")) {
        return Effect.fail(
          makeCacheError(
            "read",
            "symlink-refused",
            filePath,
            `Refusing symlink cache file ${filePath}`,
          ),
        )
      }
      return Effect.fail(
        makeCacheError(
          "read",
          "io-error",
          filePath,
          `Failed to open cache file ${filePath}: ${toErrorReasonMessage(failure)}`,
        ),
      )
    })
    .with({ _tag: "Success" }, ({ success: fd }) => {
      // oxlint-disable-next-line -- foreign node:fs boundary: deterministic fd cleanup
      try {
        if (!fstatSync(fd).isFile()) {
          return Effect.fail(
            makeCacheError(
              "read",
              "io-error",
              filePath,
              `Refusing non-regular cache file '${filePath}'`,
            ),
          )
        }
        const readRes = Result.try(() => readFileSync(fd, "utf8"))
        return match(readRes)
          .with({ _tag: "Success" }, ({ success }) => Effect.succeedSome(success))
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.fail(
              makeCacheError(
                "read",
                "io-error",
                filePath,
                `Failed reading cache file ${filePath}: ${toErrorReasonMessage(failure)}`,
              ),
            ),
          )
          .exhaustive()
      } finally {
        closeSync(fd)
      }
    })
    .exhaustive()
}

export const readEmbeddingCacheFile = Effect.fn("FileEmbeddingCache.read")(function* (
  repoRoot: WorkspaceFilePath,
  options?: FileEmbeddingCacheOptions,
): Effect.fn.Return<Option.Option<EmbeddingCacheSnapshot>, EmbeddingCacheError> {
  const filename = options?.cacheFilename ?? DEFAULT_CACHE_FILENAME
  const { stateDir, cacheDir, cachePath } = yield* resolveSafeCacheTarget(
    repoRoot,
    filename,
    "read",
  )
  yield* verifySafeCacheDirectories("read", stateDir, cacheDir, cachePath)
  if (!nodeSyncHostIo.existsSync(cachePath)) {
    return Option.none()
  }
  const rawOpt = yield* readRegularFileNoFollow(cachePath)
  return yield* match(rawOpt)
    .with({ _tag: "None" }, () => Effect.succeedNone)
    .with({ _tag: "Some" }, ({ value: raw }) =>
      decodeCacheSnapshot(raw).pipe(
        Effect.asSome,
        Effect.mapError((err) =>
          makeCacheError(
            "read",
            "corrupt-snapshot",
            cachePath,
            `Corrupt or incompatible embedding cache at ${cachePath}: ${String(err)}`,
          ),
        ),
      ),
    )
    .exhaustive()
})

export const writeEmbeddingCacheFile = Effect.fn("FileEmbeddingCache.write")(function* (
  repoRoot: WorkspaceFilePath,
  snapshot: EmbeddingCacheSnapshot,
  options?: FileEmbeddingCacheOptions,
): Effect.fn.Return<void, EmbeddingCacheError> {
  const filename = options?.cacheFilename ?? DEFAULT_CACHE_FILENAME
  const { stateDir, cacheDir, cachePath } = yield* resolveSafeCacheTarget(
    repoRoot,
    filename,
    "write",
  )
  yield* verifySafeCacheDirectories("write", stateDir, cacheDir, cachePath)

  const mkdirRes = Result.try(() => {
    nodeSyncHostIo.mkdirRecursiveSync(dirname(cachePath), 0o700)
  })
  yield* match(mkdirRes)
    .with({ _tag: "Success" }, () => Effect.void)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeCacheError(
          "write",
          "io-error",
          cachePath,
          `Failed to create cache dir for ${cachePath}: ${toErrorReasonMessage(failure)}`,
        ),
      ),
    )
    .exhaustive()

  yield* verifySafeCacheDirectories("write", stateDir, cacheDir, cachePath)

  const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  yield* checkNotSymlink("write", tmpPath, "temp cache file")
  const writeRes = Result.try(() => {
    const jsonText = encodeCacheSnapshot(snapshot)
    nodeSyncHostIo.writeTextWithModeSync(tmpPath, jsonText, 0o600)
    nodeSyncHostIo.renameSync(tmpPath, cachePath)
  })
  return yield* match(writeRes)
    .with({ _tag: "Success" }, () => Effect.void)
    .with({ _tag: "Failure" }, ({ failure }) => {
      if (nodeSyncHostIo.existsSync(tmpPath)) {
        Result.try(() => nodeSyncHostIo.unlinkSync(tmpPath))
      }
      return Effect.fail(
        makeCacheError(
          "write",
          "io-error",
          cachePath,
          `Failed to persist ${cachePath}: ${toErrorReasonMessage(failure)}`,
        ),
      )
    })
    .exhaustive()
})

const makeFileEmbeddingCacheLayer = (
  options?: FileEmbeddingCacheOptions,
): Layer.Layer<EmbeddingCachePort> =>
  Layer.succeed(
    EmbeddingCachePort,
    EmbeddingCachePort.of({
      readCache: (repoRoot: WorkspaceFilePath) => readEmbeddingCacheFile(repoRoot, options),
      writeCache: (repoRoot: WorkspaceFilePath, snapshot: EmbeddingCacheSnapshot) =>
        writeEmbeddingCacheFile(repoRoot, snapshot, options),
    }),
  )

export const FileEmbeddingCacheLive: Layer.Layer<EmbeddingCachePort> = makeFileEmbeddingCacheLayer()

export { makeFileEmbeddingCacheLayer }
