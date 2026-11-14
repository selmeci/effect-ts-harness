import { Effect } from "effect"
import {
  computeWorkspaceFileLineCount,
  type WorkspaceFilePath,
  type WorkspaceFileStat,
  type WorkspaceFsError,
} from "@harness/contract"
import { WorkspaceFs } from "@harness/service"

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
