import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import {
  computeWorkspaceFileLineCount,
  ErrorReasonMessage,
  WorkspaceFileContent,
  type WorkspaceFilePath,
  type WorkspaceFileStat,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { type SyncHostIo, WorkspaceFs, type WorkspaceFsShape } from "@harness/service"

export { WorkspaceFs, type WorkspaceFsShape }

export const makeWorkspaceFsHostIoLayer = (hostIo: SyncHostIo): Layer.Layer<WorkspaceFs> =>
  Layer.succeed(WorkspaceFs, {
    readTextFile: (filePath) =>
      Effect.try({
        try: () => WorkspaceFileContent.make(hostIo.readTextSync(filePath)),
        catch: (err) =>
          new WorkspaceFsError({
            filePath,
            operation: WorkspaceFsOperation.make("read"),
            reason: ErrorReasonMessage.make(
              err instanceof Error && err.message.trim().length > 0 ? err.message : "Read failed",
            ),
          }),
      }),
    writeTextFileAtomic: (filePath, content) =>
      Effect.suspend(() => {
        const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        return Effect.try({
          try: () => {
            hostIo.mkdirRecursiveSync(dirname(filePath))
            hostIo.writeTextSync(tmpPath, content)
            hostIo.renameSync(tmpPath, filePath)
          },
          catch: (err) =>
            new WorkspaceFsError({
              filePath,
              operation: WorkspaceFsOperation.make("write"),
              reason: ErrorReasonMessage.make(
                err instanceof Error && err.message.trim().length > 0
                  ? err.message
                  : "Write failed",
              ),
            }),
        }).pipe(
          Effect.ensuring(
            Effect.ignore(
              Effect.try({
                try: () => {
                  if (hostIo.existsSync(tmpPath)) {
                    hostIo.unlinkSync(tmpPath)
                  }
                },
                catch: () => undefined,
              }),
            ),
          ),
        )
      }),
    exists: (filePath) => Effect.sync(() => hostIo.existsSync(filePath)),
  })

export const makeWorkspaceFsMemoryLayer = (
  initialFiles: Readonly<Record<string, string>> = {},
): Layer.Layer<WorkspaceFs> =>
  Layer.effect(
    WorkspaceFs,
    Effect.sync(() => {
      const store = new Map<string, string>(Object.entries(initialFiles))
      return {
        readTextFile: (filePath) =>
          Effect.suspend(() => {
            const val = store.get(filePath)
            if (val === undefined) {
              return Effect.fail(
                new WorkspaceFsError({
                  filePath,
                  operation: WorkspaceFsOperation.make("read"),
                  reason: ErrorReasonMessage.make(`File not found in memory layer: ${filePath}`),
                }),
              )
            }
            return Effect.succeed(WorkspaceFileContent.make(val))
          }),
        writeTextFileAtomic: (filePath, content) =>
          Effect.sync(() => {
            store.set(filePath, content)
          }),
        exists: (filePath) => Effect.sync(() => store.has(filePath)),
      }
    }),
  )

export const readAndVerifyWorkspaceFile = Effect.fn("WorkspaceFs.readAndVerifyFile")(function* (
  filePath: WorkspaceFilePath,
): Effect.fn.Return<WorkspaceFileStat, WorkspaceFsError, WorkspaceFs> {
  const fs = yield* WorkspaceFs
  const content = yield* fs.readTextFile(filePath)
  const lineCount = computeWorkspaceFileLineCount(content)
  return {
    filePath,
    content,
    lineCount,
  }
})

export const statAndReadWorkspaceFiles = Effect.fn("WorkspaceFs.statAndReadAll")(function* (
  filePaths: ReadonlyArray<WorkspaceFilePath>,
): Effect.fn.Return<ReadonlyArray<WorkspaceFileStat>, WorkspaceFsError, WorkspaceFs> {
  const stats: Array<WorkspaceFileStat> = []
  for (const filePath of filePaths) {
    const stat = yield* readAndVerifyWorkspaceFile(filePath)
    stats.push(stat)
  }
  return stats
})
