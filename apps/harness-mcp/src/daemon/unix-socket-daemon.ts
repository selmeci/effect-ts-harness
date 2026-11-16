import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import * as Graph from "effect/Graph"
import * as Semaphore from "effect/Semaphore"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  OmnigraphBranchName,
  OmnigraphChangeCursor,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import { AstGateCache } from "@harness/gates"
import {
  DatalogFilePath,
  DatalogSession,
  type DatalogSessionShape,
  extractWorkspaceTypeAwareGraph,
  makeOmnigraphSyncLayer,
  pollOmnigraphChanges,
  readGraphHeadMeta,
  updateGraphHeadCursor,
} from "@harness/graph"
import {
  makeAstGateCacheLayer,
  nodeSyncHostIo,
  resolveAstGateCachePath,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  WorkspaceFsLive,
} from "@harness/infra"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"

export interface HarnessDaemonServerHandle {
  readonly socketPath: string
  readonly close: () => Promise<void>
}

const DaemonRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literals([
    "ping",
    "extract-graph",
    "ast-gates",
    "plan-check",
    "gc",
    "verify",
    "bench",
    "poll-changes",
  ]),
  argv: Schema.optional(Schema.Array(Schema.String)),
  repoRoot: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)),
  branch: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
})

const decodeDaemonRequest = Schema.decodeOption(Schema.fromJsonString(DaemonRequestSchema))

export const resolveDaemonSocketPath = (repoRoot: string): string =>
  resolveHarnessDaemonSocketPath(repoRoot)

const extractChangedTsFilesFromImage = (
  image: { readonly properties: unknown } | null | undefined,
  out: Set<string>,
): void => {
  if (image === null || image === undefined) return
  const props = image.properties
  if (typeof props !== "object" || props === null) return
  const record = props as {
    readonly file?: unknown
    readonly testFile?: unknown
    readonly moduleFile?: unknown
    readonly path?: unknown
  }
  for (const candidate of [record.file, record.testFile, record.moduleFile, record.path]) {
    if (
      typeof candidate === "string" &&
      candidate.trim().length > 0 &&
      (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))
    ) {
      out.add(candidate.trim())
    }
  }
}

const createDaemonLineHandler =
  (
    repoRoot: string,
    daemonScope: Scope.Scope,
    cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, AstGateCachePortShape>>,
    datalogSessionsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, DatalogSessionShape>>,
    pollSemaphoresRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, Semaphore.Semaphore>>,
  ) =>
  (line: string): Effect.Effect<string> => {
    const reqOpt = decodeDaemonRequest(line.trim())
    return match(reqOpt)
      .with({ _tag: "None" }, () =>
        Effect.succeed(JSON.stringify({ ok: false, error: "Invalid daemon request payload" })),
      )
      .with({ _tag: "Some" }, ({ value: req }) => {
        const baseRoot = path.resolve(repoRoot)
        const resolvedRoot =
          req.repoRoot !== undefined
            ? path.isAbsolute(req.repoRoot)
              ? path.resolve(req.repoRoot)
              : path.resolve(baseRoot, req.repoRoot)
            : baseRoot
        if (req.repoRoot !== undefined && !isPathInsideRoot(baseRoot, resolvedRoot)) {
          return Effect.succeed(
            JSON.stringify({
              id: req.id,
              ok: false,
              error: `Requested repoRoot '${req.repoRoot}' escapes daemon root`,
            }),
          )
        }
        return match<typeof req.command, Effect.Effect<Record<string, unknown>>>(
          req.command,
        )
          .with("ping", () => Effect.succeed({ id: req.id, ok: true, status: "warm" }))
          .with("extract-graph", () =>
            Effect.gen(function* () {
              const graph = yield* extractWorkspaceTypeAwareGraph(resolvedRoot, nodeSyncHostIo)
              return {
                id: req.id,
                ok: true,
                nodeCount: Graph.nodeCount(graph.graph),
                edgeCount: Graph.edgeCount(graph.graph),
                violationCount: (graph.branchingViolations ?? []).length,
              }
            }),
          )
          .with("ast-gates", () =>
            Effect.gen(function* () {
              const cachePath = resolveAstGateCachePath(resolvedRoot)
              const requestedRelPaths = req.files ?? []
              for (const rel of requestedRelPaths) {
                const resolvedAbs = path.resolve(resolvedRoot, rel)
                if (!isPathInsideRoot(resolvedRoot, resolvedAbs)) {
                  return {
                    id: req.id,
                    ok: false,
                    error: `Path traversal outside workspace root is forbidden: ${rel}`,
                  }
                }
              }
              const loadedFiles: Array<{
                readonly filePath: AstSourceFilePath
                readonly content: AstSourceContent
              }> = []
              for (const rel of requestedRelPaths) {
                const abs = path.resolve(resolvedRoot, rel)
                if (!nodeSyncHostIo.existsSync(abs)) {
                  return {
                    id: req.id,
                    ok: false,
                    error: `AST gate target file unavailable: ${rel} (file does not exist)`,
                  }
                }
                const readRes = Result.try(() => nodeSyncHostIo.readTextSync(abs))
                const textOrError = match(readRes)
                  .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, text: success }))
                  .with({ _tag: "Failure" }, ({ failure }) => ({
                    ok: false as const,
                    error: `AST gate target file unavailable: ${rel} (${failure instanceof Error ? failure.message : String(failure)})`,
                  }))
                  .exhaustive()
                if (!textOrError.ok) {
                  return {
                    id: req.id,
                    ok: false,
                    error: textOrError.error,
                  }
                }
                loadedFiles.push({
                  filePath: AstSourceFilePath.make(rel),
                  content: AstSourceContent.make(textOrError.text),
                })
              }
              const cachePort = yield* SynchronizedRef.modifyEffect(cachePortsRef, (ports) => {
                const existing = ports.get(cachePath)
                if (existing !== undefined) {
                  return Effect.succeed([existing, ports] as const)
                }
                const astGateCacheLayer = makeAstGateCacheLayer({
                  cacheFilePath: WorkspaceFilePath.make(cachePath),
                }).pipe(Layer.provide(Layer.mergeAll(WorkspaceFsLive, NodeServices.layer)))
                return Layer.buildWithScope(astGateCacheLayer, daemonScope).pipe(
                  Effect.map((ctx) => {
                    const built = Context.get(ctx, AstGateCachePort)
                    const next = new Map(ports)
                    next.set(cachePath, built)
                    return [built, next] as const
                  }),
                )
              })
              const report = yield* AstGateCache.evaluateCached(loadedFiles).pipe(
                Effect.provideService(AstGateCachePort, cachePort),
                Effect.catch((err) =>
                  Effect.succeed({
                    error: `AST gate cache error: ${err instanceof Error ? err.message : String(err)}`,
                  }),
                ),
              )
              if ("error" in report) {
                return { id: req.id, ok: false, error: report.error }
              }
              return { id: req.id, ok: true, report }
            }),
          )
          .with("plan-check", "gc", "verify", "bench", () =>
            Effect.succeed({ id: req.id, ok: false, fallbackToInProcess: true }),
          )
          .with("poll-changes", () =>
            Effect.gen(function* () {
              const pollSem = yield* SynchronizedRef.modifyEffect(pollSemaphoresRef, (sems) => {
                const existing = sems.get(resolvedRoot)
                if (existing !== undefined) {
                  return Effect.succeed([existing, sems] as const)
                }
                return Semaphore.make(1).pipe(
                  Effect.map((created) => {
                    const next = new Map(sems)
                    next.set(resolvedRoot, created)
                    return [created, next] as const
                  }),
                )
              })
              return yield* pollSem.withPermits(1)(
                Effect.gen(function* () {
                  const headMeta = readGraphHeadMeta(resolvedRoot, nodeSyncHostIo)
                  const rawReqCursor = req.cursor?.trim() || undefined
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
                  const rawBranch = req.branch?.trim() || undefined
                  const branch =
                    rawBranch === undefined
                      ? undefined
                      : match(Schema.decodeOption(OmnigraphBranchName)(rawBranch))
                          .with({ _tag: "Some" }, ({ value }) => value)
                          .with({ _tag: "None" }, () => null)
                          .exhaustive()
                  if (branch === null) {
                    return { id: req.id, ok: false, error: `Invalid branch name: ${rawBranch}` }
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
                      id: req.id,
                      ok: false,
                      error: `Invalid change cursor: ${rawReqCursor}`,
                    }
                  }

                  const feedRes = yield* pollOmnigraphChanges({
                    repoRoot: resolvedRoot,
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
                      Effect.succeed({ id: req.id, ok: false, error }),
                    )
                    .with({ _tag: "Ok" }, ({ feed }) =>
                      Effect.gen(function* () {
                        const changedTsFiles = new Set<string>()
                        for (const block of feed.blocks) {
                          for (const change of block.changes) {
                            extractChangedTsFilesFromImage(change.before, changedTsFiles)
                            extractChangedTsFilesFromImage(change.after, changedTsFiles)
                          }
                        }
                        for (const relPath of changedTsFiles) {
                          const absPath = path.resolve(resolvedRoot, relPath)
                          if (!isPathInsideRoot(resolvedRoot, absPath)) {
                            return {
                              id: req.id,
                              ok: false,
                              error: `Change-feed file path escapes workspace root: ${relPath}`,
                            }
                          }
                        }

                        const hasNonTsChanges =
                          changedTsFiles.size === 0 &&
                          feed.blocks.some((block) => block.changes.length > 0)
                        if (feed.requiresBaseline || hasNonTsChanges || changedTsFiles.size > 0) {
                          const nextGraph = yield* extractWorkspaceTypeAwareGraph(
                            resolvedRoot,
                            nodeSyncHostIo,
                          )
                          if (feed.requiresBaseline || hasNonTsChanges) {
                            const rebuiltRes = yield* DatalogSession.make(nextGraph).pipe(
                              Effect.flatMap((created) =>
                                SynchronizedRef.update(datalogSessionsRef, (sessions) => {
                                  const next = new Map(sessions)
                                  next.set(resolvedRoot, created)
                                  return next
                                }),
                              ),
                              Effect.map(() => ({ ok: true as const })),
                              Effect.catch((err) =>
                                Effect.succeed({
                                  ok: false as const,
                                  error: toErrorReasonMessage(err),
                                }),
                              ),
                            )
                            if (!rebuiltRes.ok) {
                              return { id: req.id, ok: false, error: rebuiltRes.error }
                            }
                          } else {
                            const sessionRes = yield* SynchronizedRef.modifyEffect(
                              datalogSessionsRef,
                              (sessions) => {
                                const existing = sessions.get(resolvedRoot)
                                if (existing !== undefined) {
                                  return Effect.succeed([existing, sessions] as const)
                                }
                                return DatalogSession.make(nextGraph).pipe(
                                  Effect.map((created) => {
                                    const next = new Map(sessions)
                                    next.set(resolvedRoot, created)
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
                                          SynchronizedRef.update(datalogSessionsRef, (sessions) => {
                                            const next = new Map(sessions)
                                            next.delete(resolvedRoot)
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
                              return { id: req.id, ok: false, error: stepOutcome.error }
                            }
                          }
                        }

                        if (feed.cursor !== null) {
                          const persisted = updateGraphHeadCursor(
                            resolvedRoot,
                            nodeSyncHostIo,
                            feed.cursor,
                          )
                          if (persisted === null) {
                            return {
                              id: req.id,
                              ok: false,
                              error: "Failed to persist graph-head.json",
                            }
                          }
                        }

                        return {
                          id: req.id,
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
            }),
          )
          .exhaustive()
          .pipe(
            Effect.map((res) => JSON.stringify(res)),
            Effect.catchDefect((defect: unknown) =>
              Effect.sync(() => {
                const message = toErrorReasonMessage(defect)
                process.stderr.write(`[harness-mcp] Daemon line handler defect: ${message}\n`)
                return JSON.stringify({ id: req.id, ok: false, error: message })
              }),
            ),
          )
      })
      .exhaustive()
  }

export const startHarnessDaemonServer = (
  repoRoot: string = process.cwd(),
): Promise<HarnessDaemonServerHandle> => {
  const daemonRuntime = ManagedRuntime.make(UnixSocketDaemonLive)
  return daemonRuntime
    .runPromiseExit(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const cachePortsRef = yield* SynchronizedRef.make<
          ReadonlyMap<string, AstGateCachePortShape>
        >(new Map())
        const datalogSessionsRef = yield* SynchronizedRef.make<
          ReadonlyMap<string, DatalogSessionShape>
        >(new Map())
        const pollSemaphoresRef = yield* SynchronizedRef.make<
          ReadonlyMap<string, Semaphore.Semaphore>
        >(new Map())
        return yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
          lineHandler: createDaemonLineHandler(
            repoRoot,
            scope,
            cachePortsRef,
            datalogSessionsRef,
            pollSemaphoresRef,
          ),
        }).pipe(
          Scope.provide(scope),
          Effect.map(
            (info): HarnessDaemonServerHandle => ({
              socketPath: info.socketPath,
              close: () =>
                daemonRuntime
                  .runPromiseExit(Scope.close(scope, Exit.void))
                  .then((closeExit) =>
                    Exit.match(closeExit, {
                      onFailure: (cause) => Promise.reject(Cause.squash(cause)),
                      onSuccess: () => undefined,
                    }),
                  )
                  .finally(() =>
                    daemonRuntime.dispose().catch((disposeErr: unknown) => {
                      process.stderr.write(
                        `[harness-mcp] Daemon runtime dispose error: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
                      )
                    }),
                  ),
            }),
          ),
          Effect.catchTag("DaemonServerError", (err) =>
            match(err.reasonKind)
              .with("already-alive", () =>
                Scope.close(scope, Exit.void).pipe(
                  Effect.as<HarnessDaemonServerHandle>({
                    socketPath: err.socketPath,
                    close: () => daemonRuntime.dispose(),
                  }),
                ),
              )
              .with(
                "not-a-socket",
                "probe-failed",
                "bind-failed",
                "chmod-failed",
                "invalid-path",
                () => Effect.fail(err),
              )
              .exhaustive(),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
      }),
    )
    .then((exit) =>
      Exit.match(exit, {
        onFailure: (cause) =>
          daemonRuntime
            .dispose()
            .catch((disposeErr: unknown) => {
              process.stderr.write(
                `[harness-mcp] Daemon runtime dispose error: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
              )
            })
            .then(() => Promise.reject(Cause.squash(cause))),
        onSuccess: (handle) => handle,
      }),
    )
}
