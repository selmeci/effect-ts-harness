import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import {
  ErrorReasonMessage,
  WorkspaceFileContent,
  type WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { WorkspaceFs, type WorkspaceFsShape } from "@harness/service"

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

export const WorkspaceFsNodeLive: Layer.Layer<WorkspaceFs> = Layer.effect(
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
).pipe(Layer.provide(NodeServices.layer))

export const WorkspaceFsLive: Layer.Layer<WorkspaceFs> = WorkspaceFsNodeLive
