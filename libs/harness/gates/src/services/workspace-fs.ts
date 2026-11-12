import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  computeWorkspaceFileLineCount,
  ErrorReasonMessage,
  WorkspaceFileContent,
  type WorkspaceFilePath,
  type WorkspaceFileStat,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "../plugins/self-dogfooding-contract.js"

export interface WorkspaceFsShape {
  readonly readTextFile: (
    filePath: WorkspaceFilePath,
  ) => Effect.Effect<WorkspaceFileContent, WorkspaceFsError>
  readonly writeTextFileAtomic: (
    filePath: WorkspaceFilePath,
    content: WorkspaceFileContent,
  ) => Effect.Effect<void, WorkspaceFsError>
  readonly exists: (filePath: WorkspaceFilePath) => Effect.Effect<boolean, never>
}

export class WorkspaceFs extends Context.Service<WorkspaceFs, WorkspaceFsShape>()(
  "@harness/gates/WorkspaceFs",
) {}

export const WorkspaceFsLive: Layer.Layer<WorkspaceFs> = Layer.succeed(WorkspaceFs, {
  readTextFile: (filePath) =>
    Effect.try({
      try: () => WorkspaceFileContent.make(readFileSync(filePath, "utf8")),
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
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(tmpPath, content, "utf8")
          renameSync(tmpPath, filePath)
        },
        catch: (err) =>
          new WorkspaceFsError({
            filePath,
            operation: WorkspaceFsOperation.make("write"),
            reason: ErrorReasonMessage.make(
              err instanceof Error && err.message.trim().length > 0 ? err.message : "Write failed",
            ),
          }),
      }).pipe(
        Effect.ensuring(
          Effect.ignore(
            Effect.try({
              try: () => {
                if (existsSync(tmpPath)) {
                  unlinkSync(tmpPath)
                }
              },
              catch: () => undefined,
            }),
          ),
        ),
      )
    }),
  exists: (filePath) => Effect.sync(() => existsSync(filePath)),
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
