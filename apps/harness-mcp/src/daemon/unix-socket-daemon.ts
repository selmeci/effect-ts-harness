import * as path from "node:path"
import { Cause, Effect, Exit, ManagedRuntime, Schema, Scope, SynchronizedRef } from "effect"
import * as Graph from "effect/Graph"
import * as Semaphore from "effect/Semaphore"
import { match } from "ts-pattern"
import {
  OmnigraphBranchName,
  OmnigraphChangeCursor,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import { AST_GATE_RULE_SOURCE_FILES, AST_GATE_TYPESCRIPT_VERSION } from "@harness/gates"
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
import {
  type AstGateCacheRuleSourceConfig,
  nodeSyncHostIo,
  resolveDiskGateRuleVersion,
  type ResolvedGateRuleVersion,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "@harness/infra"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"
import { type CachedDaemonAstPort, handleDaemonAstGatesRequest } from "./ast-gate-daemon-helper.js"

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

const createDaemonLineHandler =
  (
    repoRoot: string,
    daemonScope: Scope.Scope,
    cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, CachedDaemonAstPort>>,
    datalogSessionsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, DatalogSessionShape>>,
    pollSemaphoresRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, Semaphore.Semaphore>>,
    startupRuleVersion: ResolvedGateRuleVersion,
    ruleSourceConfig: AstGateCacheRuleSourceConfig,
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
        return match<typeof req.command, Effect.Effect<Record<string, unknown>>>(req.command)
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
            handleDaemonAstGatesRequest({
              requestId: req.id,
              resolvedRoot,
              requestedRelPaths: req.files ?? [],
              daemonScope,
              cachePortsRef,
              startupRuleVersion,
              ruleSourceConfig,
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
                  if (req.branch !== undefined && req.branch.trim().length === 0) {
                    return { id: req.id, ok: false, error: "Invalid branch name" }
                  }
                  if (req.cursor !== undefined && req.cursor.trim().length === 0) {
                    return { id: req.id, ok: false, error: "Invalid change cursor" }
                  }
                  const headMetaState = readGraphHeadMetaState(resolvedRoot, nodeSyncHostIo)
                  const headMetaOrErr = match(headMetaState)
                    .with({ _tag: "Present" }, ({ meta }) => ({ ok: true as const, meta }))
                    .with({ _tag: "Missing" }, () => ({ ok: true as const, meta: null }))
                    .with({ _tag: "Corrupt" }, ({ path: corruptPath, reason }) => ({
                      ok: false as const,
                      error: `Corrupt graph-head.json at ${corruptPath}: ${reason}`,
                    }))
                    .exhaustive()
                  if (!headMetaOrErr.ok) {
                    return { id: req.id, ok: false, error: headMetaOrErr.error }
                  }
                  const headMeta = headMetaOrErr.meta
                  const rawReqCursor = req.cursor?.trim()
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
                  const rawBranch = req.branch?.trim()
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
                          const absPath = path.resolve(resolvedRoot, relPath)
                          if (!isPathInsideRoot(resolvedRoot, absPath)) {
                            return {
                              id: req.id,
                              ok: false,
                              error: `Change-feed file path escapes workspace root: ${relPath}`,
                            }
                          }
                        }

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
  options?: { readonly ruleSourceRoot?: WorkspaceFilePath },
): Promise<HarnessDaemonServerHandle> => {
  const daemonRuntime = ManagedRuntime.make(UnixSocketDaemonLive)
  return daemonRuntime
    .runPromiseExit(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const ruleSourceConfig: AstGateCacheRuleSourceConfig = {
          _tag: "HashedSources",
          ruleSourceFiles: AST_GATE_RULE_SOURCE_FILES,
          compilerVersion: AST_GATE_TYPESCRIPT_VERSION,
          ...(options?.ruleSourceRoot !== undefined
            ? { ruleSourceRoot: options.ruleSourceRoot }
            : {}),
        }
        const startupRuleVersion = yield* resolveDiskGateRuleVersion(ruleSourceConfig)
        const cachePortsRef = yield* SynchronizedRef.make<ReadonlyMap<string, CachedDaemonAstPort>>(
          new Map(),
        )
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
            startupRuleVersion,
            ruleSourceConfig,
          ),
        }).pipe(
          Scope.provide(scope),
          Effect.map((info): HarnessDaemonServerHandle => ({
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
          })),
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
