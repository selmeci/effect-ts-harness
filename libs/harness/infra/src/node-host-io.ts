import { spawn, spawnSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { join } from "node:path"
import { Schema } from "effect"
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
} from "@harness/service"

/**
 * Concrete Node.js implementation of `ExtendedHostIo`.
 *
 * Architectural rationale ("why"): TypeScript's `ts.CompilerHost` (`ts.createProgram`)
 * and `ts-morph` require strictly synchronous filesystem callbacks (`fileExists`,
 * `readFile`, `realpath`, `getDirectories`) that cannot yield Effect fibers. Isolating
 * those synchronous bindings here keeps `@harness/graph`, `@harness/gates`, and
 * `@harness/ingest` free of direct `node:fs` / `node:child_process` imports while
 * Effect-native async workflows use `WorkspaceFs` and `HarnessSubprocessRunner`.
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
    const validationErr =
      trimmedCommand.length === 0
        ? undefined
        : validateSubprocessInput({
            command: SubprocessCommand.make(trimmedCommand),
            args: args.map((arg) => SubprocessArg.make(arg)),
            ...(options?.cwd !== undefined ? { cwd: WorkspaceFilePath.make(options.cwd) } : {}),
          })
    const invalidReason =
      validationErr === undefined
        ? "Subprocess command must not be empty"
        : match(validationErr)
            .with({ _tag: "Some" }, ({ value }) => value.reason)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
    if (invalidReason !== undefined) {
      Schema.decodeSync(
        Schema.String.pipe(Schema.check(Schema.makeFilter(() => invalidReason))),
      )("")
    }

    const result = spawnSync(command, [...args], {
      cwd: options?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes,
      env: options?.env,
      windowsHide: true,
    })
    const errCode =
      result.error !== undefined && "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : undefined
    const timedOut = errCode === "ETIMEDOUT"
    const spawnError = result.error !== undefined ? result.error.message : undefined
    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error !== undefined ? result.error.message : ""),
      ...(spawnError !== undefined ? { spawnError } : {}),
      signal: result.signal,
      timedOut,
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
    options?: {
      readonly cwd?: string | undefined
      readonly env?: Readonly<Record<string, string | undefined>> | undefined
    },
  ): void => {
    spawn(command, [...args], {
      cwd: options?.cwd,
      env: options?.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref()
  },
}
