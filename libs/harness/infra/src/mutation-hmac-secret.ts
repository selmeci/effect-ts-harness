import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { MutationCacheHmacSecret, WorkspaceFilePath } from "@harness/contract"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"

const MUTATION_HMAC_KEY_FILENAME = "mutation-hmac-v2.key" as const
const KEY_DIR_MODE = 0o700
const KEY_FILE_MODE = 0o600
const GROUP_OR_WORLD_PERMS_MASK = 0o077

export interface ResolveMutationHmacSecretOptions {
  readonly hostIo?: ExtendedHostIo
  readonly keyDirOverride?: WorkspaceFilePath
  readonly env?: Readonly<Record<string, string | undefined>>
}

const isOutsideRealRoot = (realRepoRoot: string, realTarget: string): boolean => {
  const rel = relative(realRepoRoot, realTarget)
  if (rel.length === 0) {
    return false
  }
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

const resolveDefaultKeyDir = (env: Readonly<Record<string, string | undefined>>): string => {
  const xdgCache = env.XDG_CACHE_HOME?.trim()
  if (xdgCache !== undefined && xdgCache.length > 0) {
    return join(xdgCache, "effect-harness")
  }
  return join(homedir(), ".cache", "effect-harness")
}

const checkNotSymlink = (targetPath: string, hostIo: ExtendedHostIo): boolean =>
  match(Result.try(() => hostIo.isSymbolicLinkSync(targetPath)))
    .with({ _tag: "Success" }, ({ success }) => !success)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()

const ensurePrivateMode = (
  targetPath: string,
  expectedMode: number,
  hostIo: ExtendedHostIo,
): boolean => {
  const initialModeRes = Result.try(() => hostIo.statModeSync(targetPath))
  const initialMode = match(initialModeRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (initialMode === undefined) {
    return false
  }
  if ((initialMode & GROUP_OR_WORLD_PERMS_MASK) === 0) {
    return true
  }
  const chmodRes = Result.try(() => {
    hostIo.chmodSync(targetPath, expectedMode)
  })
  const chmodOk = match(chmodRes)
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (!chmodOk) {
    return false
  }
  const verifiedMode = match(Result.try(() => hostIo.statModeSync(targetPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  return verifiedMode !== undefined && (verifiedMode & GROUP_OR_WORLD_PERMS_MASK) === 0
}

const readExistingValidatedKey = (
  keyPath: string,
  realKeyDir: string,
  hostIo: ExtendedHostIo,
): Option.Option<MutationCacheHmacSecret> => {
  if (!checkNotSymlink(keyPath, hostIo)) {
    return Option.none()
  }
  const isRegularFile = match(Result.try(() => hostIo.isFileSync(keyPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (!isRegularFile) {
    return Option.none()
  }
  const realKeyPath = match(Result.try(() => hostIo.realpathSync(keyPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (realKeyPath !== join(realKeyDir, MUTATION_HMAC_KEY_FILENAME)) {
    return Option.none()
  }
  if (!ensurePrivateMode(keyPath, KEY_FILE_MODE, hostIo)) {
    return Option.none()
  }
  return match(Result.try(() => hostIo.readTextSync(keyPath)))
    .with({ _tag: "Success" }, ({ success }) =>
      Schema.decodeOption(MutationCacheHmacSecret)(success.trim()),
    )
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()
}

/**
 * Resolves or atomically initializes the out-of-workspace HMAC secret used to sign `mutation-cache-v2.json`.
 * Keeps key material in `~/.cache/effect-harness` (`0o700` dir, `0o600` key) outside the repo so a workspace
 * attacker or repo fixture cannot self-forge valid cache MACs; fails closed (`Option.none()`) on symlink,
 * in-repo key paths, permissive permissions, or I/O failures.
 */
const resolveOrCreateMutationCacheHmacSecret = (
  repoRoot: WorkspaceFilePath,
  options?: ResolveMutationHmacSecretOptions,
): Option.Option<MutationCacheHmacSecret> => {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const env = options?.env ?? process.env
  const rawKeyDir = options?.keyDirOverride ?? resolveDefaultKeyDir(env)
  const resolvedKeyDir = resolve(rawKeyDir)
  const resolvedRepoRoot = resolve(repoRoot)

  const mkdirRes = Result.try(() => {
    hostIo.mkdirRecursiveSync(resolvedKeyDir, KEY_DIR_MODE)
  })
  const mkdirOk = match(mkdirRes)
    .with({ _tag: "Success" }, () => true)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (!mkdirOk || !checkNotSymlink(resolvedKeyDir, hostIo)) {
    return Option.none()
  }
  const isDir = match(Result.try(() => hostIo.isDirectorySync(resolvedKeyDir)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => false)
    .exhaustive()
  if (!isDir) {
    return Option.none()
  }

  const realKeyDir = match(Result.try(() => hostIo.realpathSync(resolvedKeyDir)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (realKeyDir === undefined) {
    return Option.none()
  }

  const realRepoRoot = match(Result.try(() => hostIo.realpathSync(resolvedRepoRoot)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => resolvedRepoRoot)
    .exhaustive()
  if (!isOutsideRealRoot(realRepoRoot, realKeyDir)) {
    return Option.none()
  }
  if (!ensurePrivateMode(resolvedKeyDir, KEY_DIR_MODE, hostIo)) {
    return Option.none()
  }

  const keyPath = join(realKeyDir, MUTATION_HMAC_KEY_FILENAME)
  const exists = match(Result.try(() => hostIo.existsSync(keyPath)))
    .with({ _tag: "Success" }, ({ success }) => Option.some(success))
    .with({ _tag: "Failure" }, () => Option.none())
    .exhaustive()

  return match(exists)
    .with({ _tag: "None" }, () => Option.none())
    .with({ _tag: "Some", value: true }, () =>
      readExistingValidatedKey(keyPath, realKeyDir, hostIo),
    )
    .with({ _tag: "Some", value: false }, () => {
      const candidate = MutationCacheHmacSecret.make(randomBytes(32).toString("hex"))
      const writeAttempt = Result.try(() =>
        hostIo.tryWriteExclusiveTextSync(keyPath, `${candidate}\n`, KEY_FILE_MODE),
      )
      return match(writeAttempt)
        .with({ _tag: "Failure" }, () => Option.none())
        .with({ _tag: "Success" }, ({ success: writeOutcome }) =>
          match(writeOutcome)
            .with({ _tag: "Written" }, () =>
              ensurePrivateMode(keyPath, KEY_FILE_MODE, hostIo)
                ? Option.some(candidate)
                : Option.none(),
            )
            .with({ _tag: "Exists" }, () => readExistingValidatedKey(keyPath, realKeyDir, hostIo))
            .with({ _tag: "Failed" }, () => Option.none())
            .exhaustive(),
        )
        .exhaustive()
    })
    .exhaustive()
}

export { resolveOrCreateMutationCacheHmacSecret }
