import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import {
  ErrorReasonMessage,
  WorkspaceFileContent,
  type WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { type SyncHostIo, WorkspaceFs, type WorkspaceFsShape } from "@harness/service"

const toWorkspaceFsError = (
  filePath: WorkspaceFilePath,
  operation: "read" | "write" | "stat" | "readdir",
  err: unknown,
): WorkspaceFsError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : `Workspace filesystem ${operation} failed`
  return new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: ErrorReasonMessage.make(message),
  })
}

const makeWorkspaceFsLayer = (
  _options?: Record<string, never>,
): Layer.Layer<WorkspaceFs, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    WorkspaceFs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const impl: WorkspaceFsShape = {
        readTextFile: (filePath) =>
          fs.readFileString(filePath).pipe(
            Effect.map((content) => WorkspaceFileContent.make(content)),
            Effect.mapError((err) => toWorkspaceFsError(filePath, "read", err)),
          ),
        writeTextFileAtomic: (filePath, content) =>
          Effect.suspend(() => {
            const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`
            return fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(tmpPath, content)),
              Effect.andThen(fs.rename(tmpPath, filePath)),
              Effect.mapError((err) => toWorkspaceFsError(filePath, "write", err)),
              Effect.ensuring(fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
            )
          }),
        exists: (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
      }

      return impl
    }),
  )

export const WorkspaceFsLive: Layer.Layer<WorkspaceFs> = makeWorkspaceFsLayer().pipe(
  Layer.provide(NodeServices.layer),
)

const makeWorkspaceFsHostIoLayer = (hostIo: SyncHostIo): Layer.Layer<WorkspaceFs> =>
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

export { makeWorkspaceFsHostIoLayer, makeWorkspaceFsLayer }
