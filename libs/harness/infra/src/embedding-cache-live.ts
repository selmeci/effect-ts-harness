import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { EmbeddingCacheSnapshot, type WorkspaceFilePath } from "@harness/contract"
import { EmbeddingCachePort } from "@harness/service"
import { resolveHarnessStateDir } from "./cache-helpers.js"
import { nodeSyncHostIo } from "./node-host-io.js"

const DEFAULT_CACHE_FILENAME = "embeddings-v1.json"
const decodeCacheSnapshot = Schema.decodeOption(Schema.fromJsonString(EmbeddingCacheSnapshot))
const encodeCacheSnapshot = Schema.encodeSync(Schema.fromJsonString(EmbeddingCacheSnapshot))

export interface FileEmbeddingCacheOptions {
  readonly cacheFilename?: string | undefined
}

const isContainedWithinDir = (parentReal: string, childReal: string): boolean => {
  const rel = relative(parentReal, childReal)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const resolveSafeCacheTarget = (
  repoRoot: WorkspaceFilePath,
  cacheFilename: string,
):
  | { readonly stateDir: string; readonly cacheDir: string; readonly cachePath: string }
  | undefined => {
  const res = Result.try(() => {
    const stateDir = resolve(resolveHarnessStateDir(repoRoot))
    const cacheDir = join(stateDir, "cache")
    const cachePath = join(cacheDir, cacheFilename)
    return { stateDir, cacheDir, cachePath }
  })
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:embedding-cache] Warning: invalid state directory for ${repoRoot}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      )
      return undefined
    })
    .exhaustive()
}

const verifySafeCacheDirectories = (
  stateDir: string,
  cacheDir: string,
  cachePath: string,
): boolean => {
  if (nodeSyncHostIo.isSymbolicLinkSync(stateDir)) {
    process.stderr.write(
      `[harness:embedding-cache] Warning: refusing symlink state directory ${stateDir}\n`,
    )
    return false
  }
  if (nodeSyncHostIo.isSymbolicLinkSync(cacheDir)) {
    process.stderr.write(
      `[harness:embedding-cache] Warning: refusing symlink cache directory ${cacheDir}\n`,
    )
    return false
  }
  if (nodeSyncHostIo.isSymbolicLinkSync(cachePath)) {
    process.stderr.write(
      `[harness:embedding-cache] Warning: refusing symlink cache file ${cachePath}\n`,
    )
    return false
  }
  if (nodeSyncHostIo.existsSync(stateDir) && nodeSyncHostIo.existsSync(cacheDir)) {
    const contained = Result.getOrElse(
      Result.try(() =>
        isContainedWithinDir(
          nodeSyncHostIo.realpathSync(stateDir),
          nodeSyncHostIo.realpathSync(cacheDir),
        ),
      ),
      () => false,
    )
    if (!contained) {
      process.stderr.write(
        `[harness:embedding-cache] Warning: cache directory escapes state directory boundary ${cacheDir}\n`,
      )
      return false
    }
  }
  return true
}

const readRegularFileNoFollow = (filePath: string): Result.Result<string, string> => {
  const openRes = Result.try({
    try: () => openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return match(openRes)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: fd }) => {
      // oxlint-disable-next-line -- foreign node:fs boundary: deterministic fd cleanup
      try {
        if (!fstatSync(fd).isFile()) {
          return Result.fail(`Refusing non-regular cache file '${filePath}'`)
        }
        return Result.try({
          try: () => readFileSync(fd, "utf8"),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        })
      } finally {
        closeSync(fd)
      }
    })
    .exhaustive()
}

const makeFileEmbeddingCacheLayer = (
  options?: FileEmbeddingCacheOptions,
): Layer.Layer<EmbeddingCachePort> => {
  const filename = options?.cacheFilename ?? DEFAULT_CACHE_FILENAME

  return Layer.succeed(
    EmbeddingCachePort,
    EmbeddingCachePort.of({
      readCache: (repoRoot: WorkspaceFilePath) =>
        Effect.sync(() => {
          const target = resolveSafeCacheTarget(repoRoot, filename)
          if (target === undefined) return Option.none()
          const { stateDir, cacheDir, cachePath } = target
          if (!verifySafeCacheDirectories(stateDir, cacheDir, cachePath)) {
            return Option.none()
          }
          if (!nodeSyncHostIo.existsSync(cachePath)) {
            return Option.none()
          }
          return match(readRegularFileNoFollow(cachePath))
            .with({ _tag: "Failure" }, ({ failure }) => {
              process.stderr.write(
                `[harness:embedding-cache] Warning: failed to read ${cachePath}: ${failure}\n`,
              )
              return Option.none<EmbeddingCacheSnapshot>()
            })
            .with({ _tag: "Success" }, ({ success: raw }) =>
              match(decodeCacheSnapshot(raw))
                .with({ _tag: "None" }, () => {
                  process.stderr.write(
                    `[harness:embedding-cache] Warning: corrupt or incompatible embedding cache at ${cachePath}; rebuilding on next sync\n`,
                  )
                  return Option.none<EmbeddingCacheSnapshot>()
                })
                .with({ _tag: "Some" }, ({ value }) => Option.some(value))
                .exhaustive(),
            )
            .exhaustive()
        }),

      writeCache: (repoRoot: WorkspaceFilePath, snapshot: EmbeddingCacheSnapshot) =>
        Effect.sync(() => {
          const target = resolveSafeCacheTarget(repoRoot, filename)
          if (target === undefined) return
          const { stateDir, cacheDir, cachePath } = target
          if (!verifySafeCacheDirectories(stateDir, cacheDir, cachePath)) {
            return
          }
          const mkdirRes = Result.try(() => {
            nodeSyncHostIo.mkdirRecursiveSync(dirname(cachePath), 0o700)
          })
          const mkdirOk = match(mkdirRes)
            .with({ _tag: "Success" }, () => true)
            .with({ _tag: "Failure" }, ({ failure }) => {
              process.stderr.write(
                `[harness:embedding-cache] Warning: failed to create cache dir for ${cachePath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
              )
              return false
            })
            .exhaustive()
          if (!mkdirOk) {
            return
          }
          if (!verifySafeCacheDirectories(stateDir, cacheDir, cachePath)) {
            return
          }
          const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
          const writeRes = Result.try(() => {
            const jsonText = encodeCacheSnapshot(snapshot)
            nodeSyncHostIo.writeTextWithModeSync(tmpPath, jsonText, 0o600)
            nodeSyncHostIo.renameSync(tmpPath, cachePath)
          })
          match(writeRes)
            .with({ _tag: "Success" }, () => undefined)
            .with({ _tag: "Failure" }, ({ failure }) => {
              process.stderr.write(
                `[harness:embedding-cache] Warning: failed to persist ${cachePath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
              )
              if (nodeSyncHostIo.existsSync(tmpPath)) {
                Result.try(() => nodeSyncHostIo.unlinkSync(tmpPath))
              }
            })
            .exhaustive()
        }),
    }),
  )
}

export const FileEmbeddingCacheLive: Layer.Layer<EmbeddingCachePort> = makeFileEmbeddingCacheLayer()

export { makeFileEmbeddingCacheLayer }
