import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { Result } from "effect"
import type { SyncHostIo } from "../src/host-io.js"

const makeBaseTestHostIo = (): SyncHostIo => ({
  getEnv: () => process.env,
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
    const stdout = res.stdout ?? ""
    const stderr = res.stderr ?? ""
    if (errCode === "ETIMEDOUT") {
      return {
        _tag: "TimedOut",
        stdout,
        stderr,
        ...(res.signal !== null ? { signal: res.signal } : {}),
        ...(res.error !== undefined ? { spawnError: res.error.message } : {}),
      }
    }
    if (res.error !== undefined) {
      return {
        _tag: "SpawnFailed",
        spawnError: `${errCode !== undefined ? `${errCode}: ` : ""}${res.error.message}`,
        ...(errCode !== undefined ? { errorCode: errCode } : {}),
        stdout,
        stderr,
      }
    }
    if (res.signal !== null) {
      return {
        _tag: "Signaled",
        signal: res.signal,
        stdout,
        stderr,
      }
    }
    return {
      _tag: "Exited",
      exitCode: res.status ?? 0,
      stdout,
      stderr,
    }
  },
})

export const testHostIo: SyncHostIo = makeBaseTestHostIo()

export const makeTestHostIo = (overrides?: Partial<SyncHostIo>): SyncHostIo => ({
  ...makeBaseTestHostIo(),
  ...overrides,
})
