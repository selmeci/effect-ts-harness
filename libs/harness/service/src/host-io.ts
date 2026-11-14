/**
 * Synchronous host I/O adapter contract (`SyncHostIo` / `ExtendedHostIo`).
 *
 * Architectural rationale ("why"): TypeScript's `ts.CompilerHost` (`ts.createProgram`)
 * and `ts-morph` require strictly synchronous filesystem callbacks (`fileExists`,
 * `readFile`, `realpath`, `getDirectories`) that cannot yield Effect fibers. Isolating
 * those synchronous callbacks behind `SyncHostIo` keeps `@harness/graph`, `@harness/gates`,
 * and `@harness/ingest` free of direct `node:fs` / `node:child_process` imports while
 * `@harness/infra` (`nodeSyncHostIo`) owns the concrete Node binding. All Effect-native
 * asynchronous workflows should prefer `WorkspaceFs` and `HarnessSubprocessRunner`.
 */
export interface SyncHostDirEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

export interface SyncHostExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly spawnError?: string | undefined
  readonly signal?: string | null | undefined
  readonly timedOut?: boolean | undefined
}

export interface SyncHostExecOptions {
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBufferBytes?: number | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export interface SyncHostIo {
  readonly existsSync: (filePath: string) => boolean
  readonly isFileSync: (filePath: string) => boolean
  readonly isDirectorySync: (filePath: string) => boolean
  readonly isSymbolicLinkSync: (filePath: string) => boolean
  readonly readTextSync: (filePath: string) => string
  readonly readBytesSync: (filePath: string) => Uint8Array
  readonly writeTextSync: (filePath: string, content: string) => void
  readonly appendTextSync: (filePath: string, content: string) => void
  readonly mkdirRecursiveSync: (dirPath: string, mode?: number) => void
  readonly renameSync: (oldPath: string, newPath: string) => void
  readonly unlinkSync: (filePath: string) => void
  readonly readdirSync: (dirPath: string) => ReadonlyArray<SyncHostDirEntry>
  readonly realpathSync: (filePath: string) => string
  readonly execFileSync: (
    command: string,
    args: ReadonlyArray<string>,
    options?: SyncHostExecOptions,
  ) => SyncHostExecResult
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
    options?: {
      readonly cwd?: string | undefined
      readonly env?: Readonly<Record<string, string | undefined>> | undefined
    },
  ) => void
}
