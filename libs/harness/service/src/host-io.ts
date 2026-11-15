/**
 * Synchronous host I/O adapter contract (`SyncHostIo` / `ExtendedHostIo`).
 *
 * Architectural rationale ("why"): TypeScript's `ts.CompilerHost` (`ts.createProgram`)
 * and `ts-morph` require strictly synchronous filesystem callbacks (`fileExists`,
 * `readFile`, `realpath`, `getDirectories`) that cannot yield Effect fibers. Isolating
 * those synchronous callbacks behind `SyncHostIo` / `ExtendedHostIo` keeps `@harness/graph`,
 * `@harness/gates`, and `@harness/ingest` free of direct `node:fs` / `node:child_process`
 * imports while `@harness/infra` (`nodeSyncHostIo`) owns the concrete Node binding.
 *
 * Capabilities:
 * - `SyncHostIo`: synchronous file/directory reads and metadata (`existsSync`, `isFileSync`,
 *   `isDirectorySync`, `isSymbolicLinkSync`, `readTextSync`, `readBytesSync`, `readdirSync`,
 *   `realpathSync`), writes and mutations (`writeTextSync`, `appendTextSync`,
 *   `mkdirRecursiveSync`, `renameSync`, `unlinkSync`), and synchronous subprocess execution
 *   (`execFileSync`).
 * - `ExtendedHostIo`: extends `SyncHostIo` with recursive/temp/permission/process helpers
 *   (`rmRecursiveSync`, `cpRecursiveSync`, `mkdtempSync`, `statMtimeMsSync`, `chmodSync`,
 *   `spawnDetached`).
 *
 * Note: Standalone compiler extractors fall back to `ts.sys` only when `hostIo` is
 * omitted. All Effect-native asynchronous workflows should prefer `WorkspaceFs` and
 * `HarnessSubprocessRunner`.
 */
export interface SyncHostDirEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

export interface SyncHostExecExited {
  readonly _tag: "Exited"
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface SyncHostExecTimedOut {
  readonly _tag: "TimedOut"
  readonly stdout: string
  readonly stderr: string
  readonly signal?: string | undefined
  readonly spawnError?: string | undefined
}

export interface SyncHostExecSignaled {
  readonly _tag: "Signaled"
  readonly signal: string
  readonly stdout: string
  readonly stderr: string
  readonly spawnError?: string | undefined
}

export interface SyncHostExecSpawnFailed {
  readonly _tag: "SpawnFailed"
  readonly spawnError: string
  readonly errorCode?: string | undefined
  readonly stdout: string
  readonly stderr: string
}

export type SyncHostExecResult =
  | SyncHostExecExited
  | SyncHostExecTimedOut
  | SyncHostExecSignaled
  | SyncHostExecSpawnFailed

export interface SyncHostExecOptions {
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBufferBytes?: number | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export interface SyncHostReader {
  readonly existsSync: (filePath: string) => boolean
  readonly isFileSync: (filePath: string) => boolean
  readonly isDirectorySync: (filePath: string) => boolean
  readonly isSymbolicLinkSync: (filePath: string) => boolean
  readonly readTextSync: (filePath: string) => string
  readonly readBytesSync: (filePath: string) => Uint8Array
  readonly readdirSync: (dirPath: string) => ReadonlyArray<SyncHostDirEntry>
  readonly realpathSync: (filePath: string) => string
}

export interface SyncHostMutator {
  readonly writeTextSync: (filePath: string, content: string) => void
  readonly appendTextSync: (filePath: string, content: string) => void
  readonly mkdirRecursiveSync: (dirPath: string, mode?: number) => void
  readonly renameSync: (oldPath: string, newPath: string) => void
  readonly unlinkSync: (filePath: string) => void
  readonly execFileSync: (
    command: string,
    args: ReadonlyArray<string>,
    options?: SyncHostExecOptions,
  ) => SyncHostExecResult
}

export interface SyncHostIo extends SyncHostReader, SyncHostMutator {}

export interface SyncHostSpawned {
  readonly _tag: "Spawned"
  readonly pid: number
}

export interface SyncHostSpawnFailed {
  readonly _tag: "SpawnFailed"
  readonly spawnError: string
  readonly errorCode?: string | undefined
}

export type SyncHostSpawnDetachedResult = SyncHostSpawned | SyncHostSpawnFailed

export interface SyncHostSpawnDetachedOptions {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly stderrLogPath?: string | undefined
}

export interface ExtendedHostIo extends SyncHostIo {
  readonly rmRecursiveSync: (targetPath: string) => void
  readonly cpRecursiveSync: (srcPath: string, destPath: string) => void
  readonly mkdtempSync: (prefix: string) => string
  readonly statMtimeMsSync: (filePath: string) => number | undefined
  readonly chmodSync: (filePath: string, mode: number) => void
  readonly spawnDetached: (
    command: string,
    args: ReadonlyArray<string>,
    options?: SyncHostSpawnDetachedOptions,
  ) => SyncHostSpawnDetachedResult
}
