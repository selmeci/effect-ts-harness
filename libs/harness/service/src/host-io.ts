export interface SyncHostDirEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

export interface SyncHostExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
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
