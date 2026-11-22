import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { match, P } from "ts-pattern"
import {
  toErrorReasonMessage,
  WorkspaceFileContent,
  type WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { WorkspaceFs, type WorkspaceFsShape } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"

const toWorkspaceFsError = (
  filePath: WorkspaceFilePath,
  operation: "read" | "write" | "stat" | "readdir",
  err: unknown,
): WorkspaceFsError =>
  new WorkspaceFsError({
    filePath,
    operation: WorkspaceFsOperation.make(operation),
    reason: toErrorReasonMessage(err, `Workspace filesystem ${operation} failed`),
  })

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
            Effect.flatMap((content) => Schema.decodeEffect(WorkspaceFileContent)(content)),
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
        exists: (filePath) =>
          fs.stat(filePath).pipe(
            Effect.as(true),
            Effect.catchTag("PlatformError", (err) =>
              match(err.reason)
                .with({ _tag: "NotFound" }, () => Effect.succeed(false))
                .with({ _tag: P.not("NotFound") }, () =>
                  Effect.fail(toWorkspaceFsError(filePath, "stat", err)),
                )
                .exhaustive(),
            ),
          ),
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
        catch: (err) => toWorkspaceFsError(filePath, "read", err),
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
          catch: (err) => toWorkspaceFsError(filePath, "write", err),
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
    exists: (filePath) =>
      Effect.try({
        try: () =>
          hostIo.isFileSync(filePath) ||
          hostIo.isDirectorySync(filePath) ||
          hostIo.isSymbolicLinkSync(filePath) ||
          hostIo.existsSync(filePath),
        catch: (err) => toWorkspaceFsError(filePath, "stat", err),
      }),
  })

export { makeWorkspaceFsHostIoLayer, makeWorkspaceFsLayer }
