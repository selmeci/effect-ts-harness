import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { Result } from "effect"
import type { SyncHostIo } from "@harness/service"

export const testHostIo: SyncHostIo = {
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
    return {
      exitCode: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    }
  },
}
