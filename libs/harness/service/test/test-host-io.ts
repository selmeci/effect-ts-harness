import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { Result } from "effect"
import type { SyncHostIo } from "../src/host-io.js"

const makeBaseTestHostIo = (): SyncHostIo => ({
  existsSync: (filePath) => fs.existsSync(filePath),
  isFileSync: (filePath) =>
    Result.getOrElse(
      Result.try(() => fs.statSync(filePath).isFile()),
      () => false,
    ),
  isDirectorySync: (filePath) =>
    Result.getOrElse(
      Result.try(() => fs.statSync(filePath).isDirectory()),
      () => false,
    ),
  isSymbolicLinkSync: (filePath) =>
    Result.getOrElse(
      Result.try(() => fs.lstatSync(filePath).isSymbolicLink()),
      () => false,
    ),
  readTextSync: (filePath) => fs.readFileSync(filePath, "utf8"),
  readBytesSync: (filePath) => fs.readFileSync(filePath),
  writeTextSync: (filePath, content) => {
    fs.writeFileSync(filePath, content, "utf8")
  },
  appendTextSync: (filePath, content) => {
    fs.appendFileSync(filePath, content, "utf8")
  },
  mkdirRecursiveSync: (dirPath, mode) => {
    fs.mkdirSync(dirPath, mode === undefined ? { recursive: true } : { recursive: true, mode })
  },
  renameSync: (oldPath, newPath) => {
    fs.renameSync(oldPath, newPath)
  },
  unlinkSync: (filePath) => {
    fs.unlinkSync(filePath)
  },
  readdirSync: (dirPath) =>
    fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    })),
  realpathSync: (filePath) => fs.realpathSync(filePath),
  execFileSync: (command, args, options) => {
    const res = spawnSync(command, [...args], {
      encoding: "utf8",
      cwd: options?.cwd,
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    })
    const errCode =
      res.error !== undefined && "code" in res.error && typeof res.error.code === "string"
        ? res.error.code
        : undefined
    const timedOut = errCode === "ETIMEDOUT"
    const spawnError = res.error !== undefined ? `${errCode !== undefined ? `${errCode}: ` : ""}${res.error.message}` : undefined
    return {
      exitCode: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      ...(spawnError !== undefined ? { spawnError } : {}),
      ...(res.signal !== null ? { signal: res.signal } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    }
  },
})

export const testHostIo: SyncHostIo = makeBaseTestHostIo()

export const makeTestHostIo = (overrides?: Partial<SyncHostIo>): SyncHostIo => ({
  ...makeBaseTestHostIo(),
  ...overrides,
})
