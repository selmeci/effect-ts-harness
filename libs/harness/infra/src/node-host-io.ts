import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import type { SyncHostDirEntry, SyncHostExecOptions, SyncHostExecResult, SyncHostIo } from "@harness/service"

export const nodeSyncHostIo: SyncHostIo = {
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
    const result = spawnSync(command, [...args], {
      cwd: options?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes,
      env: options?.env,
      windowsHide: true,
    })
    return {
      exitCode: result.status ?? (result.error !== undefined ? 1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error !== undefined ? result.error.message : ""),
    }
  },
}
