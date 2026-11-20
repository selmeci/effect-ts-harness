import * as path from "node:path"
import { Effect, Schema, SynchronizedRef } from "effect"
import * as Semaphore from "effect/Semaphore"
import { match } from "ts-pattern"
import { OmnigraphBranchName, OmnigraphChangeCursor, toErrorReasonMessage } from "@harness/contract"
import {
  DatalogFilePath,
  DatalogSession,
  type DatalogSessionShape,
  extractWorkspaceTypeAwareGraph,
  makeOmnigraphSyncLayer,
  pollOmnigraphChanges,
  readGraphHeadMetaState,
  updateGraphHeadCursor,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"

const classifyImageFiles = (
  image: { readonly properties: unknown } | null | undefined,
  tsOut: Set<string>,
): { readonly hasTs: boolean; readonly hasNonTs: boolean } => {
  if (image === null || image === undefined) {
    return { hasTs: false, hasNonTs: false }
  }
  const props = image.properties
  if (typeof props !== "object" || props === null) {
    return { hasTs: false, hasNonTs: false }
  }
  const record = props as {
    readonly file?: unknown
    readonly testFile?: unknown
    readonly moduleFile?: unknown
    readonly path?: unknown
  }
  let hasTs = false
  let hasNonTs = false
  for (const candidate of [record.file, record.testFile, record.moduleFile, record.path]) {
    if (typeof candidate !== "string") continue
    const trimmed = candidate.trim()
    if (trimmed.length === 0) continue
    if (trimmed.endsWith(".ts") || trimmed.endsWith(".tsx")) {
      tsOut.add(trimmed)
      hasTs = true
    } else {
      hasNonTs = true
    }
  }
  return { hasTs, hasNonTs }
}

/**
 * Handles a `poll-changes` daemon IPC request under a per-worktree `Semaphore(1)`,
 * stepping or rebuilding `DatalogSession` and persisting the updated cursor.
 */
export const handleDaemonPollChangesRequest = (input: {
  readonly requestId: string
  readonly resolvedRoot: string
  readonly branch?: string | undefined
  readonly cursor?: string | undefined
  readonly datalogSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, DatalogSessionShape>
  >
  readonly pollSemaphoresRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, Semaphore.Semaphore>
  >
}): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const pollSem = yield* SynchronizedRef.modifyEffect(input.pollSemaphoresRef, (sems) => {
      const existing = sems.get(input.resolvedRoot)
      if (existing !== undefined) {
        return Effect.succeed([existing, sems] as const)
      }
      return Semaphore.make(1).pipe(
        Effect.map((created) => {
          const next = new Map(sems)
          next.set(input.resolvedRoot, created)
          return [created, next] as const
        }),
      )
    })
    return yield* pollSem.withPermits(1)(
      Effect.gen(function* () {
        if (input.branch !== undefined && input.branch.trim().length === 0) {
          return { id: input.requestId, ok: false, error: "Invalid branch name" }
        }
        if (input.cursor !== undefined && input.cursor.trim().length === 0) {
          return { id: input.requestId, ok: false, error: "Invalid change cursor" }
        }
        const headMetaState = readGraphHeadMetaState(input.resolvedRoot, nodeSyncHostIo)
        const headMetaOrErr = match(headMetaState)
          .with({ _tag: "Present" }, ({ meta }) => ({ ok: true as const, meta }))
          .with({ _tag: "Missing" }, () => ({ ok: true as const, meta: null }))
          .with({ _tag: "Corrupt" }, ({ path: corruptPath, reason }) => ({
            ok: false as const,
            error: `Corrupt graph-head.json at ${corruptPath}: ${reason}`,
          }))
          .exhaustive()
        if (!headMetaOrErr.ok) {
          return { id: input.requestId, ok: false, error: headMetaOrErr.error }
        }
        const headMeta = headMetaOrErr.meta
        const rawReqCursor = input.cursor?.trim()
        const storedCursor =
          headMeta?.changeFeedCursor !== undefined && headMeta.changeFeedCursor !== null
            ? match(Schema.decodeOption(OmnigraphChangeCursor)(headMeta.changeFeedCursor))
                .with({ _tag: "Some" }, ({ value }) => value)
                .with({ _tag: "None" }, () => {
                  process.stderr.write(
                    "[harness-mcp] Warning: ignoring malformed stored changeFeedCursor in graph-head.json\n",
                  )
                  return undefined
                })
                .exhaustive()
            : undefined
        const rawBranch = input.branch?.trim()
        const branch =
          rawBranch === undefined
            ? undefined
            : match(Schema.decodeOption(OmnigraphBranchName)(rawBranch))
                .with({ _tag: "Some" }, ({ value }) => value)
                .with({ _tag: "None" }, () => null)
                .exhaustive()
        if (branch === null) {
          return {
            id: input.requestId,
            ok: false,
            error: `Invalid branch name: ${rawBranch}`,
          }
        }
        const cursor =
          rawReqCursor === undefined
            ? storedCursor
            : match(Schema.decodeOption(OmnigraphChangeCursor)(rawReqCursor))
                .with({ _tag: "Some" }, ({ value }) => value)
                .with({ _tag: "None" }, () => null)
                .exhaustive()
        if (cursor === null) {
          return {
            id: input.requestId,
            ok: false,
            error: `Invalid change cursor: ${rawReqCursor}`,
          }
        }

        const feedRes = yield* pollOmnigraphChanges({
          repoRoot: input.resolvedRoot,
          actor: "agent-mcp",
          ...(branch !== undefined ? { branch } : {}),
          ...(cursor !== undefined ? { cursor } : { start: "beginning" as const }),
        }).pipe(
          Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
          Effect.map((feed) => ({ _tag: "Ok" as const, feed })),
          Effect.catchTag("OmnigraphLoadError", (err) =>
            Effect.succeed({
              _tag: "Err" as const,
              error: toErrorReasonMessage(err.cause),
            }),
          ),
        )

        return yield* match(feedRes)
          .with({ _tag: "Err" }, ({ error }) =>
            Effect.succeed({ id: input.requestId, ok: false, error }),
          )
          .with({ _tag: "Ok" }, ({ feed }) =>
            Effect.gen(function* () {
              const changedTsFiles = new Set<string>()
              let hasNonTsChanges = false
              for (const block of feed.blocks) {
                for (const change of block.changes) {
                  const beforeFiles = classifyImageFiles(change.before, changedTsFiles)
                  const afterFiles = classifyImageFiles(change.after, changedTsFiles)
                  if (
                    beforeFiles.hasNonTs ||
                    afterFiles.hasNonTs ||
                    (!beforeFiles.hasTs && !afterFiles.hasTs)
                  ) {
                    hasNonTsChanges = true
                  }
                }
              }
              for (const relPath of changedTsFiles) {
                const absPath = path.resolve(input.resolvedRoot, relPath)
                if (!isPathInsideRoot(input.resolvedRoot, absPath)) {
                  return {
                    id: input.requestId,
                    ok: false,
                    error: `Change-feed file path escapes workspace root: ${relPath}`,
                  }
                }
              }

              if (feed.requiresBaseline || hasNonTsChanges || changedTsFiles.size > 0) {
                const nextGraph = yield* extractWorkspaceTypeAwareGraph(
                  input.resolvedRoot,
                  nodeSyncHostIo,
                )
                if (feed.requiresBaseline || hasNonTsChanges) {
                  const rebuiltRes = yield* DatalogSession.make(nextGraph).pipe(
                    Effect.flatMap((created) =>
                      SynchronizedRef.update(input.datalogSessionsRef, (sessions) => {
                        const next = new Map(sessions)
                        next.set(input.resolvedRoot, created)
                        return next
                      }),
                    ),
                    Effect.map(() => ({ ok: true as const })),
                    Effect.catch((err) =>
                      SynchronizedRef.update(input.datalogSessionsRef, (sessions) => {
                        const next = new Map(sessions)
                        next.delete(input.resolvedRoot)
                        return next
                      }).pipe(
                        Effect.as({
                          ok: false as const,
                          error: toErrorReasonMessage(err),
                        }),
                      ),
                    ),
                  )
                  if (!rebuiltRes.ok) {
                    return { id: input.requestId, ok: false, error: rebuiltRes.error }
                  }
                } else {
                  const sessionRes = yield* SynchronizedRef.modifyEffect(
                    input.datalogSessionsRef,
                    (sessions) => {
                      const existing = sessions.get(input.resolvedRoot)
                      if (existing !== undefined) {
                        return Effect.succeed([existing, sessions] as const)
                      }
                      return DatalogSession.make(nextGraph).pipe(
                        Effect.map((created) => {
                          const next = new Map(sessions)
                          next.set(input.resolvedRoot, created)
                          return [created, next] as const
                        }),
                      )
                    },
                  ).pipe(
                    Effect.map((s) => ({ _tag: "Ok" as const, session: s })),
                    Effect.catch((err) =>
                      Effect.succeed({
                        _tag: "Err" as const,
                        error: toErrorReasonMessage(err),
                      }),
                    ),
                  )

                  const stepOutcome = yield* match(sessionRes)
                    .with({ _tag: "Err" }, ({ error }) =>
                      Effect.succeed({ ok: false as const, error }),
                    )
                    .with({ _tag: "Ok" }, ({ session }) =>
                      Effect.gen(function* () {
                        for (const filePath of changedTsFiles) {
                          const stepRes = yield* session
                            .stepFileDelta({
                              filePath: DatalogFilePath.make(filePath),
                              nextGraph,
                            })
                            .pipe(
                              Effect.map(() => ({ ok: true as const })),
                              Effect.catch((err) =>
                                SynchronizedRef.update(input.datalogSessionsRef, (sessions) => {
                                  const next = new Map(sessions)
                                  next.delete(input.resolvedRoot)
                                  return next
                                }).pipe(
                                  Effect.as({
                                    ok: false as const,
                                    error: toErrorReasonMessage(err),
                                  }),
                                ),
                              ),
                            )
                          if (!stepRes.ok) {
                            return stepRes
                          }
                        }
                        return { ok: true as const }
                      }),
                    )
                    .exhaustive()

                  if (!stepOutcome.ok) {
                    return { id: input.requestId, ok: false, error: stepOutcome.error }
                  }
                }
              }

              if (feed.cursor !== null) {
                const persisted = updateGraphHeadCursor(
                  input.resolvedRoot,
                  nodeSyncHostIo,
                  feed.cursor,
                )
                if (persisted === null) {
                  return {
                    id: input.requestId,
                    ok: false,
                    error: "Failed to persist graph-head.json",
                  }
                }
              }

              return {
                id: input.requestId,
                ok: true,
                cursor: feed.cursor,
                caughtUp: feed.caughtUp,
                requiresBaseline: feed.requiresBaseline,
                blockCount: feed.blocks.length,
                updatedFiles: Array.from(changedTsFiles),
              }
            }),
          )
          .exhaustive()
      }),
    )
  })
