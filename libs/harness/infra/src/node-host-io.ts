import { spawn, spawnSync } from "node:child_process"
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import {
  SubprocessArg,
  SubprocessCommand,
  validateSubprocessInput,
  WorkspaceFilePath,
} from "@harness/contract"
import type {
  ExtendedHostIo,
  SyncHostDirEntry,
  SyncHostExecOptions,
  SyncHostExecResult,
  SyncHostSpawnDetachedOptions,
  SyncHostSpawnDetachedResult,
} from "@harness/service/host-io"

const validateSyncCommandInput = (
  trimmedCommand: string,
  args: ReadonlyArray<string>,
  normalizedCwd?: string,
): string | undefined => {
  if (trimmedCommand.length === 0) {
    return "Subprocess command must not be empty"
  }
  if (trimmedCommand.includes("\0")) {
    return "Subprocess command contains a disallowed null byte"
  }
  if (args.some((arg) => arg.includes("\0"))) {
    return "Subprocess arguments contain a disallowed null byte"
  }
  if (normalizedCwd !== undefined && normalizedCwd.length === 0) {
    return "Subprocess cwd must not be empty"
  }
  if (normalizedCwd !== undefined && normalizedCwd.includes("\0")) {
    return "Subprocess cwd contains a disallowed null byte"
  }
  const validationErr = validateSubprocessInput({
    command: SubprocessCommand.make(trimmedCommand),
    args: args.map((arg) => SubprocessArg.make(arg)),
    ...(normalizedCwd !== undefined ? { cwd: WorkspaceFilePath.make(normalizedCwd) } : {}),
  })
  return match(validationErr)
    .with({ _tag: "Some" }, ({ value }) => value.reason)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const getErrnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined

interface ExecutableResolved {
  readonly _tag: "Resolved"
  readonly resolvedPath: string
}

interface ExecutableFailed {
  readonly _tag: "Failed"
  readonly spawnError: string
  readonly errorCode: string
}

type ExecutableResolution = ExecutableResolved | ExecutableFailed

const resolveExecutableSync = (
  command: string,
  env?: Readonly<Record<string, string | undefined>>,
): ExecutableResolution => {
  if (command.includes("/") || isAbsolute(command)) {
    const st = statSync(command, { throwIfNoEntry: false })
    if (st === undefined) {
      return {
        _tag: "Failed",
        spawnError: `Executable '${command}' not found (ENOENT)`,
        errorCode: "ENOENT",
      }
    }
    if (!st.isFile()) {
      return {
        _tag: "Failed",
        spawnError: `Executable '${command}' is not a regular file (EACCES)`,
        errorCode: "EACCES",
      }
    }
    const accessResult = Result.try({
      try: () => {
        accessSync(command, constants.X_OK)
      },
      catch: (err) => getErrnoCode(err) ?? "EACCES",
    })
    return match(accessResult)
      .with({ _tag: "Success" }, () => ({
        _tag: "Resolved" as const,
        resolvedPath: command,
      }))
      .with({ _tag: "Failure" }, ({ failure: code }) => ({
        _tag: "Failed" as const,
        spawnError: `Executable '${command}' is not executable (${code})`,
        errorCode: code,
      }))
      .exhaustive()
  }

  const pathEnv = env?.PATH ?? process.env.PATH ?? ""
  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0)
  let sawPermissionDenied = false
  for (const dir of dirs) {
    const candidate = join(dir, command)
    const st = statSync(candidate, { throwIfNoEntry: false })
    if (st === undefined || !st.isFile()) {
      continue
    }
    const accessResult = Result.try({
      try: () => {
        accessSync(candidate, constants.X_OK)
      },
      catch: (err) => getErrnoCode(err),
    })
    const resolvedOrNull = match(accessResult)
      .with({ _tag: "Success" }, () => ({
        _tag: "Resolved" as const,
        resolvedPath: candidate,
      }))
      .with({ _tag: "Failure" }, ({ failure: code }) => {
        if (code === "EACCES") {
          sawPermissionDenied = true
        }
        return undefined
      })
      .exhaustive()
    if (resolvedOrNull !== undefined) {
      return resolvedOrNull
    }
  }

  if (sawPermissionDenied) {
    return {
      _tag: "Failed",
      spawnError: `Executable '${command}' is not executable (EACCES)`,
      errorCode: "EACCES",
    }
  }
  return {
    _tag: "Failed",
    spawnError: `Executable '${command}' not found on PATH (ENOENT)`,
    errorCode: "ENOENT",
  }
}

/**
 * Concrete Node.js implementation of `ExtendedHostIo`.
 *
 * Architectural rationale ("why"): TypeScript's `ts.CompilerHost` (`ts.createProgram`)
 * and `ts-morph` require strictly synchronous filesystem callbacks (`fileExists`,
 * `readFile`, `realpath`, `getDirectories`) that cannot yield Effect fibers. Isolating
 * those synchronous bindings here keeps `@harness/graph`, `@harness/gates`, and
 * `@harness/ingest` free of direct `node:fs` / `node:child_process` imports while
 * Effect-native async workflows use `WorkspaceFs` and `HarnessSubprocessRunner`.
 *
 * Capabilities:
 * - Reads & metadata: `existsSync`, `isFileSync`, `isDirectorySync`, `isSymbolicLinkSync`,
 *   `readTextSync`, `readBytesSync`, `readdirSync`, `realpathSync`, `statMtimeMsSync`.
 * - Writes & filesystem mutations: `writeTextSync`, `appendTextSync`, `mkdirRecursiveSync`,
 *   `renameSync`, `unlinkSync`, `rmRecursiveSync`, `cpRecursiveSync`, `mkdtempSync`,
 *   `chmodSync`.
 * - Subprocess execution: `execFileSync` (returning discriminated `SyncHostExecResult`),
 *   `spawnDetached` (with synchronous executable resolution and optional `stderrLogPath`).
 *
 * Note: Standalone compiler extractors fall back to `ts.sys` only when `hostIo` is
 * omitted.
 */
export const nodeSyncHostIo: ExtendedHostIo = {
  existsSync: (filePath: string): boolean => existsSync(filePath),
  isFileSync: (filePath: string): boolean => {
    const st = statSync(filePath, { throwIfNoEntry: false })
    return st !== undefined && st.isFile()
  },
  isDirectorySync: (filePath: string): boolean => {
    const st = statSync(filePath, { throwIfNoEntry: false })
    return st !== undefined && st.isDirectory()
  },
  isSymbolicLinkSync: (filePath: string): boolean => {
    const st = lstatSync(filePath, { throwIfNoEntry: false })
    return st !== undefined && st.isSymbolicLink()
  },
  readTextSync: (filePath: string): string => readFileSync(filePath, "utf8"),
  readBytesSync: (filePath: string): Uint8Array => readFileSync(filePath),
  writeTextSync: (filePath: string, content: string): void => {
    writeFileSync(filePath, content, "utf8")
  },
  appendTextSync: (filePath: string, content: string): void => {
    appendFileSync(filePath, content, "utf8")
  },
  mkdirRecursiveSync: (dirPath: string, mode?: number): void => {
    mkdirSync(dirPath, mode !== undefined ? { recursive: true, mode } : { recursive: true })
  },
  renameSync: (oldPath: string, newPath: string): void => {
    renameSync(oldPath, newPath)
  },
  unlinkSync: (filePath: string): void => {
    unlinkSync(filePath)
  },
  readdirSync: (dirPath: string): ReadonlyArray<SyncHostDirEntry> =>
    readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    })),
  realpathSync: (filePath: string): string => realpathSync.native(filePath),
  execFileSync: (
    command: string,
    args: ReadonlyArray<string>,
    options?: SyncHostExecOptions,
  ): SyncHostExecResult => {
    const trimmedCommand = command.trim()
    const normalizedCwd = options?.cwd !== undefined ? options.cwd.trim() : undefined
    const invalidReason = validateSyncCommandInput(trimmedCommand, args, normalizedCwd)
    if (invalidReason !== undefined) {
      return {
        _tag: "SpawnFailed",
        spawnError: invalidReason,
        stdout: "",
        stderr: invalidReason,
      }
    }

    const result = spawnSync(trimmedCommand, [...args], {
      cwd: normalizedCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes,
      env: options?.env,
      windowsHide: true,
    })
    const errCode = getErrnoCode(result.error)
    const stdout = result.stdout ?? ""
    const stderr = result.stderr ?? (result.error !== undefined ? result.error.message : "")

    if (errCode === "ETIMEDOUT") {
      return {
        _tag: "TimedOut",
        stdout,
        stderr,
        ...(result.signal != null ? { signal: result.signal } : {}),
        ...(result.error !== undefined ? { spawnError: result.error.message } : {}),
      }
    }
    if (result.error !== undefined) {
      return {
        _tag: "SpawnFailed",
        spawnError: result.error.message,
        ...(errCode !== undefined ? { errorCode: errCode } : {}),
        stdout,
        stderr,
      }
    }
    if (result.signal != null) {
      return {
        _tag: "Signaled",
        signal: result.signal,
        stdout,
        stderr,
      }
    }
    return {
      _tag: "Exited",
      exitCode: result.status ?? 0,
      stdout,
      stderr,
    }
  },
  rmRecursiveSync: (targetPath: string): void => {
    rmSync(targetPath, { recursive: true, force: true })
  },
  cpRecursiveSync: (srcPath: string, destPath: string): void => {
    cpSync(srcPath, destPath, { recursive: true })
  },
  mkdtempSync: (prefix: string): string => mkdtempSync(join(tmpdir(), prefix)),
  statMtimeMsSync: (filePath: string): number | undefined =>
    statSync(filePath, { throwIfNoEntry: false })?.mtimeMs,
  chmodSync: (filePath: string, mode: number): void => {
    chmodSync(filePath, mode)
  },
  spawnDetached: (
    command: string,
    args: ReadonlyArray<string>,
    options?: SyncHostSpawnDetachedOptions,
  ): SyncHostSpawnDetachedResult => {
    const trimmedCommand = command.trim()
    const normalizedCwd = options?.cwd !== undefined ? options.cwd.trim() : undefined
    const invalidReason = validateSyncCommandInput(trimmedCommand, args, normalizedCwd)
    if (invalidReason !== undefined) {
      return { _tag: "SpawnFailed", spawnError: invalidReason }
    }

    const trimmedStderrLogPath =
      options?.stderrLogPath !== undefined ? options.stderrLogPath.trim() : undefined
    if (
      trimmedStderrLogPath !== undefined &&
      (trimmedStderrLogPath.length === 0 || trimmedStderrLogPath.includes("\0"))
    ) {
      return {
        _tag: "SpawnFailed",
        spawnError: "Invalid stderrLogPath for detached process",
      }
    }

    const resolved = resolveExecutableSync(trimmedCommand, options?.env)
    return match(resolved)
      .with({ _tag: "Failed" }, (failed) => ({
        _tag: "SpawnFailed" as const,
        spawnError: failed.spawnError,
        errorCode: failed.errorCode,
      }))
      .with({ _tag: "Resolved" }, ({ resolvedPath }) => {
        const openResult =
          trimmedStderrLogPath !== undefined
            ? Result.try({
                try: () => openSync(trimmedStderrLogPath, "a"),
                catch: (err) => ({
                  spawnError:
                    err instanceof Error && err.message.trim().length > 0
                      ? err.message.trim()
                      : `Failed to open stderr log '${trimmedStderrLogPath}'`,
                  errorCode: getErrnoCode(err),
                }),
              })
            : Result.succeed(undefined as number | undefined)

        return match(openResult)
          .with({ _tag: "Failure" }, ({ failure }) => ({
            _tag: "SpawnFailed" as const,
            spawnError: failure.spawnError,
            ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
          }))
          .with({ _tag: "Success" }, ({ success: stderrFd }) => {
            const spawnRes = Result.try({
              try: () => {
                const child = spawn(resolvedPath, [...args], {
                  cwd: normalizedCwd,
                  env: options?.env,
                  detached: true,
                  stdio: stderrFd !== undefined ? ["ignore", "ignore", stderrFd] : "ignore",
                  windowsHide: true,
                })
                child.on("error", () => {})
                child.unref()
                return child.pid
              },
              catch: (err) => ({
                spawnError:
                  err instanceof Error && err.message.trim().length > 0
                    ? err.message.trim()
                    : "Detached spawn failed",
                errorCode: getErrnoCode(err),
              }),
            })
            if (stderrFd !== undefined) {
              Result.try(() => {
                closeSync(stderrFd)
              })
            }
            return match(spawnRes)
              .with({ _tag: "Failure" }, ({ failure }) => ({
                _tag: "SpawnFailed" as const,
                spawnError: failure.spawnError,
                ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
              }))
              .with({ _tag: "Success" }, ({ success: pid }) =>
                pid !== undefined
                  ? { _tag: "Spawned" as const, pid }
                  : {
                      _tag: "SpawnFailed" as const,
                      spawnError: "Detached process failed to allocate PID",
                    },
              )
              .exhaustive()
          })
          .exhaustive()
      })
      .exhaustive()
  },
}
