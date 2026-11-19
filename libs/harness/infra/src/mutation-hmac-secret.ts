import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Redacted, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  MutationCacheHmacSecret,
  MutationCacheHmacSecretResult,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
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

const resolved = (secret: MutationCacheHmacSecret): MutationCacheHmacSecretResult => ({
  _tag: "Resolved",
  secret: Redacted.make(secret),
})

const unavailable = (reason: ErrorReasonMessage): MutationCacheHmacSecretResult => ({
  _tag: "Unavailable",
  reason,
})

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

const checkNotSymlink = (
  targetPath: string,
  label: string,
  hostIo: ExtendedHostIo,
): Result.Result<void, ErrorReasonMessage> => {
  const res = Result.try({
    try: () => hostIo.isSymbolicLinkSync(targetPath),
    catch: (err) => toErrorReasonMessage(err),
  })
  return match(res)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(
        toErrorReasonMessage(
          `Failed to inspect symlink status for ${label} '${targetPath}': ${failure}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      success
        ? Result.fail(toErrorReasonMessage(`Refusing symlink ${label} '${targetPath}'`))
        : Result.succeed(undefined),
    )
    .exhaustive()
}

const ensurePrivateMode = (
  targetPath: string,
  expectedMode: number,
  hostIo: ExtendedHostIo,
): Result.Result<void, ErrorReasonMessage> => {
  const initialModeRes = Result.try({
    try: () => hostIo.statModeSync(targetPath),
    catch: (err) => toErrorReasonMessage(err),
  })
  const initialCheck = match(initialModeRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(
        toErrorReasonMessage(
          `Failed to enforce private permissions on '${targetPath}': ${failure}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success: mode }) => {
      if (mode === undefined) {
        return Result.fail(
          toErrorReasonMessage(
            `Failed to enforce private permissions on '${targetPath}': path missing`,
          ),
        )
      }
      return Result.succeed(mode)
    })
    .exhaustive()

  return match(initialCheck)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: initialMode }) => {
      if ((initialMode & GROUP_OR_WORLD_PERMS_MASK) === 0) {
        return Result.succeed(undefined)
      }
      const chmodRes = Result.try({
        try: () => {
          hostIo.chmodSync(targetPath, expectedMode)
        },
        catch: (err) => toErrorReasonMessage(err),
      })
      return match(chmodRes)
        .with({ _tag: "Failure" }, ({ failure }) =>
          Result.fail(
            toErrorReasonMessage(
              `Failed to enforce private permissions on '${targetPath}': ${failure}`,
            ),
          ),
        )
        .with({ _tag: "Success" }, () => {
          const verifiedRes = Result.try({
            try: () => hostIo.statModeSync(targetPath),
            catch: (err) => toErrorReasonMessage(err),
          })
          return match(verifiedRes)
            .with({ _tag: "Failure" }, ({ failure }) =>
              Result.fail(
                toErrorReasonMessage(
                  `Failed to enforce private permissions on '${targetPath}': ${failure}`,
                ),
              ),
            )
            .with({ _tag: "Success" }, ({ success: verifiedMode }) =>
              verifiedMode !== undefined && (verifiedMode & GROUP_OR_WORLD_PERMS_MASK) === 0
                ? Result.succeed(undefined)
                : Result.fail(
                    toErrorReasonMessage(
                      `Failed to enforce private permissions on '${targetPath}': mode remains permissive`,
                    ),
                  ),
            )
            .exhaustive()
        })
        .exhaustive()
    })
    .exhaustive()
}

const readExistingValidatedKey = (
  keyPath: string,
  realKeyDir: string,
  hostIo: ExtendedHostIo,
): MutationCacheHmacSecretResult => {
  const symCheck = checkNotSymlink(keyPath, "HMAC key file", hostIo)
  const symErr = match(symCheck)
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (symErr !== undefined) {
    return unavailable(symErr)
  }

  const isFileRes = Result.try({
    try: () => hostIo.isFileSync(keyPath),
    catch: (err) => toErrorReasonMessage(err),
  })
  const fileErr = match(isFileRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      toErrorReasonMessage(`Failed to inspect HMAC key file '${keyPath}': ${failure}`),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      success
        ? undefined
        : toErrorReasonMessage(`HMAC key path '${keyPath}' is not a regular file`),
    )
    .exhaustive()
  if (fileErr !== undefined) {
    return unavailable(fileErr)
  }

  const realKeyRes = Result.try({
    try: () => hostIo.realpathSync(keyPath),
    catch: (err) => toErrorReasonMessage(err),
  })
  const realKeyErr = match(realKeyRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      toErrorReasonMessage(`Failed to resolve realpath for HMAC key file '${keyPath}': ${failure}`),
    )
    .with({ _tag: "Success" }, ({ success: realKeyPath }) =>
      realKeyPath === join(realKeyDir, MUTATION_HMAC_KEY_FILENAME)
        ? undefined
        : toErrorReasonMessage(
            `HMAC key file '${keyPath}' resolves outside key directory '${realKeyDir}'`,
          ),
    )
    .exhaustive()
  if (realKeyErr !== undefined) {
    return unavailable(realKeyErr)
  }

  const modeErr = match(ensurePrivateMode(keyPath, KEY_FILE_MODE, hostIo))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (modeErr !== undefined) {
    return unavailable(modeErr)
  }

  const readRes = Result.try({
    try: () => hostIo.readTextSync(keyPath),
    catch: (err) => toErrorReasonMessage(err),
  })
  return match(readRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      unavailable(toErrorReasonMessage(`Failed to read HMAC secret '${keyPath}': ${failure}`)),
    )
    .with({ _tag: "Success" }, ({ success: rawText }) =>
      match(Schema.decodeOption(MutationCacheHmacSecret)(rawText.trim()))
        .with({ _tag: "Some" }, ({ value }) => resolved(value))
        .with({ _tag: "None" }, () =>
          unavailable(toErrorReasonMessage(`Corrupt or invalid HMAC secret in '${keyPath}'`)),
        )
        .exhaustive(),
    )
    .exhaustive()
}

/**
 * Resolves or atomically initializes the out-of-workspace HMAC secret used to sign `mutation-cache-v2.json`.
 *
 * Key directory precedence: `options.keyDirOverride` → `env.XDG_CACHE_HOME/effect-harness` →
 * `~/.cache/effect-harness`, enforced outside `repoRoot` with `0o700` directory and `0o600` key permissions
 * so a workspace attacker or repo fixture cannot self-forge valid cache MACs.
 *
 * Returns a `MutationCacheHmacSecretResult`: `{ _tag: "Resolved", secret }` with a `Redacted` secret on
 * success, or `{ _tag: "Unavailable", reason }` failing closed with an exact `ErrorReasonMessage` on symlink,
 * in-repo key paths, permissive permissions, corrupt key material, or I/O failures.
 */
const resolveOrCreateMutationCacheHmacSecret = (
  repoRoot: WorkspaceFilePath,
  options?: ResolveMutationHmacSecretOptions,
): MutationCacheHmacSecretResult => {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const env = options?.env ?? process.env
  const rawKeyDir = options?.keyDirOverride ?? resolveDefaultKeyDir(env)
  const resolvedKeyDir = resolve(rawKeyDir)
  const resolvedRepoRoot = resolve(repoRoot)
  const realRepoRootEarly = match(Result.try(() => hostIo.realpathSync(resolvedRepoRoot)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => resolvedRepoRoot)
    .exhaustive()

  const targetSymPrecheck = match(checkNotSymlink(resolvedKeyDir, "HMAC key directory", hostIo))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (targetSymPrecheck !== undefined) {
    return unavailable(targetSymPrecheck)
  }

  let ancestorProbe = resolvedKeyDir
  while (true) {
    const probeExists = match(Result.try(() => hostIo.existsSync(ancestorProbe)))
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => false)
      .exhaustive()
    if (probeExists) {
      const ancestorRealRes = Result.try({
        try: () => hostIo.realpathSync(ancestorProbe),
        catch: (err) => toErrorReasonMessage(err),
      })
      const ancestorErr = match(ancestorRealRes)
        .with({ _tag: "Failure" }, ({ failure }) =>
          toErrorReasonMessage(
            `Failed to resolve realpath for HMAC key directory '${ancestorProbe}': ${failure}`,
          ),
        )
        .with({ _tag: "Success" }, ({ success: realAncestor }) => {
          const tail = relative(ancestorProbe, resolvedKeyDir)
          const intended = tail.length > 0 ? resolve(realAncestor, tail) : realAncestor
          return isOutsideRealRoot(realRepoRootEarly, intended)
            ? undefined
            : toErrorReasonMessage(
                `HMAC key directory '${intended}' lies inside workspace '${realRepoRootEarly}'`,
              )
        })
        .exhaustive()
      if (ancestorErr !== undefined) {
        return unavailable(ancestorErr)
      }
      break
    }
    const parent = dirname(ancestorProbe)
    if (parent === ancestorProbe) break
    ancestorProbe = parent
  }

  const mkdirRes = Result.try({
    try: () => {
      hostIo.mkdirRecursiveSync(resolvedKeyDir, KEY_DIR_MODE)
    },
    catch: (err) => toErrorReasonMessage(err),
  })
  const mkdirErr = match(mkdirRes)
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) =>
      toErrorReasonMessage(`Failed to create HMAC key directory '${resolvedKeyDir}': ${failure}`),
    )
    .exhaustive()
  if (mkdirErr !== undefined) {
    return unavailable(mkdirErr)
  }

  const dirSymErr = match(checkNotSymlink(resolvedKeyDir, "HMAC key directory", hostIo))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (dirSymErr !== undefined) {
    return unavailable(dirSymErr)
  }

  const isDirRes = Result.try({
    try: () => hostIo.isDirectorySync(resolvedKeyDir),
    catch: (err) => toErrorReasonMessage(err),
  })
  const isDirErr = match(isDirRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      toErrorReasonMessage(`Failed to inspect HMAC key directory '${resolvedKeyDir}': ${failure}`),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      success
        ? undefined
        : toErrorReasonMessage(`HMAC key directory path '${resolvedKeyDir}' is not a directory`),
    )
    .exhaustive()
  if (isDirErr !== undefined) {
    return unavailable(isDirErr)
  }

  const realKeyDirRes = Result.try({
    try: () => hostIo.realpathSync(resolvedKeyDir),
    catch: (err) => toErrorReasonMessage(err),
  })
  const realKeyDirOutcome = match(realKeyDirRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(
        toErrorReasonMessage(
          `Failed to resolve realpath for HMAC key directory '${resolvedKeyDir}': ${failure}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) => Result.succeed(success))
    .exhaustive()

  return match(realKeyDirOutcome)
    .with({ _tag: "Failure" }, ({ failure }) => unavailable(failure))
    .with({ _tag: "Success" }, ({ success: realKeyDir }) => {
      const realRepoRoot = match(Result.try(() => hostIo.realpathSync(resolvedRepoRoot)))
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, () => resolvedRepoRoot)
        .exhaustive()
      if (!isOutsideRealRoot(realRepoRoot, realKeyDir)) {
        return unavailable(
          toErrorReasonMessage(
            `HMAC key directory '${realKeyDir}' lies inside workspace '${realRepoRoot}'`,
          ),
        )
      }

      const dirModeErr = match(ensurePrivateMode(resolvedKeyDir, KEY_DIR_MODE, hostIo))
        .with({ _tag: "Success" }, () => undefined)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .exhaustive()
      if (dirModeErr !== undefined) {
        return unavailable(dirModeErr)
      }

      const keyPath = join(realKeyDir, MUTATION_HMAC_KEY_FILENAME)
      const existsRes = Result.try({
        try: () => hostIo.existsSync(keyPath),
        catch: (err) => toErrorReasonMessage(err),
      })

      return match(existsRes)
        .with({ _tag: "Failure" }, ({ failure }) =>
          unavailable(
            toErrorReasonMessage(
              `Failed to check existence of HMAC key file '${keyPath}': ${failure}`,
            ),
          ),
        )
        .with({ _tag: "Success" }, ({ success: exists }) => {
          if (exists) {
            return readExistingValidatedKey(keyPath, realKeyDir, hostIo)
          }
          const candidate = MutationCacheHmacSecret.make(randomBytes(32).toString("hex"))
          const writeAttempt = Result.try({
            try: () => hostIo.tryWriteExclusiveTextSync(keyPath, `${candidate}\n`, KEY_FILE_MODE),
            catch: (err) => toErrorReasonMessage(err),
          })
          return match(writeAttempt)
            .with({ _tag: "Failure" }, ({ failure }) =>
              unavailable(
                toErrorReasonMessage(`Failed to create HMAC secret '${keyPath}': ${failure}`),
              ),
            )
            .with({ _tag: "Success" }, ({ success: writeOutcome }) =>
              match(writeOutcome)
                .with({ _tag: "Written" }, () =>
                  match(ensurePrivateMode(keyPath, KEY_FILE_MODE, hostIo))
                    .with({ _tag: "Success" }, () => resolved(candidate))
                    .with({ _tag: "Failure" }, ({ failure }) => unavailable(failure))
                    .exhaustive(),
                )
                .with({ _tag: "Exists" }, () =>
                  readExistingValidatedKey(keyPath, realKeyDir, hostIo),
                )
                .with({ _tag: "Failed" }, ({ message }) =>
                  unavailable(
                    toErrorReasonMessage(
                      `Failed to create HMAC secret '${keyPath}': ${toErrorReasonMessage(message)}`,
                    ),
                  ),
                )
                .exhaustive(),
            )
            .exhaustive()
        })
        .exhaustive()
    })
    .exhaustive()
}

export { resolveOrCreateMutationCacheHmacSecret }
