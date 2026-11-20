import * as path from "node:path"
import { Cause, Effect, Exit, ManagedRuntime, Schema, Scope, SynchronizedRef } from "effect"
import * as Graph from "effect/Graph"
import type * as Semaphore from "effect/Semaphore"
import { match } from "ts-pattern"
import {
  type DaemonServerError,
  type DaemonSocketPath,
  isPureInterruptCause,
  LeaseEpoch,
  toErrorReasonMessage,
  WorkspaceFilePath,
  type WriterLeaseHeldError,
} from "@harness/contract"
import { type DatalogSessionShape, extractWorkspaceTypeAwareGraph } from "@harness/graph"
import {
  type AstGateCacheRuleSourceConfig,
  DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  nodeSyncHostIo,
  resolveDiskGateRuleVersion,
  type ResolvedGateRuleVersion,
  resolveHarnessDaemonSocketPath,
  resolveWorkflowRuntimePaths,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "@harness/infra"
import { UnixSocketDaemonPort } from "@harness/service"
import {
  type CachedDaemonAstPort,
  computeGraphExtractorSourceDigest,
  type GraphExtractorDigestResult,
  handleDaemonAstGatesRequest,
  resolveDaemonRuleSourceConfig,
  verifyWorktreeExtractorConsistency,
  verifyWorktreeRuleVersionConsistency,
} from "./ast-gate-daemon-helper.js"
import { handleDaemonPollChangesRequest } from "./poll-changes-daemon-helper.js"
import {
  type DaemonWorktreeScopeCache,
  handleDaemonWorkflowHandshakeRequest,
  makeDaemonWorktreeScopeCache,
  resolveDaemonRequestScope,
  type WorktreeValidatorFn,
} from "./workflow-daemon-helper.js"
import {
  acquireWorkflowEngineInScope,
  buildAlreadyAliveLeaseError,
  forkWorkflowLeaseWatchers,
  type WorkflowDaemonRuntime,
  type WorkflowEngineDaemonMode,
  type WorkflowEngineDaemonOptions,
} from "./workflow-engine-daemon-helper.js"
import {
  handleDaemonWorkflowAbortRequest,
  handleDaemonWorkflowCompleteRequest,
  handleDaemonWorkflowDoctorRequest,
  handleDaemonWorkflowResumeRequest,
  handleDaemonWorkflowStartRequest,
  handleDaemonWorkflowStatusRpcRequest,
} from "./workflow-rpc-daemon-helper.js"

export type { WorkflowEngineDaemonMode, WorkflowEngineDaemonOptions }

export interface StartHarnessDaemonServerOptions {
  readonly ruleSourceRoot?: WorkspaceFilePath | undefined
  readonly writerLeaseEpoch?: LeaseEpoch | undefined
  readonly workflowEngine?: WorkflowEngineDaemonOptions | undefined
  readonly validateWorktree?: WorktreeValidatorFn | undefined
  readonly linkedWorktreeCacheMaxEntries?: number | undefined
}

export interface HarnessDaemonServerHandle {
  readonly socketPath: string
  readonly writerLeaseEpoch: LeaseEpoch
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
    "workflow.handshake",
    "workflow.start",
    "workflow.status",
    "workflow.complete",
    "workflow.resume",
    "workflow.abort",
    "workflow.doctor",
  ]),
  argv: Schema.optional(Schema.Array(Schema.String)),
  repoRoot: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)),
  branch: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.String),
  commonGitDir: Schema.optional(Schema.String),
})

const decodeDaemonRequest = Schema.decodeOption(Schema.fromJsonString(DaemonRequestSchema))
const decodeJsonRecordOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

export const resolveDaemonSocketPath = (repoRoot: string): string =>
  resolveHarnessDaemonSocketPath(repoRoot)

const createDaemonLineHandler =
  (input: {
    readonly baseRoot: string
    readonly canonicalBaseRoot: string
    readonly daemonScope: Scope.Scope
    readonly scopeCache: DaemonWorktreeScopeCache
    readonly cachePortsRef: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, CachedDaemonAstPort>
    >
    readonly datalogSessionsRef: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, DatalogSessionShape>
    >
    readonly pollSemaphoresRef: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, Semaphore.Semaphore>
    >
    readonly startupRuleVersion: ResolvedGateRuleVersion
    readonly startupExtractorDigest: GraphExtractorDigestResult
    readonly ruleSourceConfig: AstGateCacheRuleSourceConfig
    readonly writerLeaseEpoch: LeaseEpoch
    readonly socketPath?: DaemonSocketPath | undefined
    readonly workflowRuntime?: WorkflowDaemonRuntime | undefined
  }) =>
  (line: string): Effect.Effect<string> => {
    const trimmedLine = line.trim()
    const reqOpt = decodeDaemonRequest(trimmedLine)
    const rawPayload = match(decodeJsonRecordOption(trimmedLine))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => ({}))
      .exhaustive()
    return match(reqOpt)
      .with({ _tag: "None" }, () =>
        Effect.succeed(JSON.stringify({ ok: false, error: "Invalid daemon request payload" })),
      )
      .with({ _tag: "Some" }, ({ value: req }) =>
        Effect.gen(function* () {
          const scopeRes = yield* resolveDaemonRequestScope(input.baseRoot, req.repoRoot, {
            scopeCache: input.scopeCache,
          })
          return yield* match(scopeRes)
            .with({ _tag: "Rejected" }, ({ error }) =>
              Effect.succeed<Record<string, unknown>>({ id: req.id, ok: false, error }),
            )
            .with({ _tag: "Allowed" }, (allowedScope) => {
              const { resolvedRoot } = allowedScope
              const workflowInput = {
                requestId: req.id,
                rawPayload,
                scope: allowedScope,
                writerLeaseEpoch: input.writerLeaseEpoch,
                ...(input.workflowRuntime !== undefined ? { runtime: input.workflowRuntime } : {}),
              }
              return match<typeof req.command, Effect.Effect<Record<string, unknown>>>(req.command)
                .with("ping", () =>
                  Effect.succeed({
                    id: req.id,
                    ok: true,
                    status: "warm",
                    cacheHit: allowedScope.cacheHit ?? false,
                  }),
                )
                .with("workflow.handshake", () =>
                  handleDaemonWorkflowHandshakeRequest({
                    requestId: req.id,
                    scope: allowedScope,
                    writerLeaseEpoch: input.writerLeaseEpoch,
                    protocolVersion: req.protocolVersion,
                    commonGitDir: req.commonGitDir,
                    ...(req.repoRoot !== undefined ? { requestedRepoRoot: req.repoRoot } : {}),
                    ...(input.socketPath !== undefined ? { socketPath: input.socketPath } : {}),
                  }),
                )
                .with("workflow.start", () => handleDaemonWorkflowStartRequest(workflowInput))
                .with("workflow.status", () => handleDaemonWorkflowStatusRpcRequest(workflowInput))
                .with("workflow.complete", () => handleDaemonWorkflowCompleteRequest(workflowInput))
                .with("workflow.resume", () => handleDaemonWorkflowResumeRequest(workflowInput))
                .with("workflow.abort", () => handleDaemonWorkflowAbortRequest(workflowInput))
                .with("workflow.doctor", () => handleDaemonWorkflowDoctorRequest(workflowInput))
                .with("extract-graph", () =>
                  Effect.gen(function* () {
                    const versionCheck = yield* verifyWorktreeRuleVersionConsistency({
                      baseRoot: input.canonicalBaseRoot,
                      resolvedRoot,
                      startupRuleVersion: input.startupRuleVersion,
                      ruleSourceConfig: input.ruleSourceConfig,
                      cachePortsRef: input.cachePortsRef,
                    })
                    const versionMismatchErr = match(versionCheck)
                      .with({ _tag: "Mismatch" }, ({ error }) => error)
                      .with({ _tag: "Match" }, () => undefined)
                      .exhaustive()
                    if (versionMismatchErr !== undefined) {
                      return {
                        id: req.id,
                        ok: false,
                        fallbackToInProcess: true,
                        error: versionMismatchErr,
                      }
                    }
                    const extractorMismatchErr = match(
                      verifyWorktreeExtractorConsistency({
                        baseRoot: input.canonicalBaseRoot,
                        resolvedRoot,
                        startupDigest: input.startupExtractorDigest,
                      }),
                    )
                      .with({ _tag: "Mismatch" }, ({ error }) => error)
                      .with({ _tag: "Match" }, () => undefined)
                      .exhaustive()
                    if (extractorMismatchErr !== undefined) {
                      return {
                        id: req.id,
                        ok: false,
                        fallbackToInProcess: true,
                        error: extractorMismatchErr,
                      }
                    }
                    const graph = yield* extractWorkspaceTypeAwareGraph(
                      resolvedRoot,
                      nodeSyncHostIo,
                    )
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
                    baseRoot: input.canonicalBaseRoot,
                    resolvedRoot,
                    requestedRelPaths: req.files ?? [],
                    daemonScope: input.daemonScope,
                    cachePortsRef: input.cachePortsRef,
                    startupRuleVersion: input.startupRuleVersion,
                    ruleSourceConfig: input.ruleSourceConfig,
                  }),
                )
                .with("plan-check", "gc", "verify", "bench", () =>
                  Effect.succeed({ id: req.id, ok: false, fallbackToInProcess: true }),
                )
                .with("poll-changes", () => {
                  const extractorMismatch = match(
                    verifyWorktreeExtractorConsistency({
                      baseRoot: input.canonicalBaseRoot,
                      resolvedRoot,
                      startupDigest: input.startupExtractorDigest,
                    }),
                  )
                    .with({ _tag: "Mismatch" }, ({ error }) => error)
                    .with({ _tag: "Match" }, () => undefined)
                    .exhaustive()
                  if (extractorMismatch !== undefined) {
                    return Effect.succeed({
                      id: req.id,
                      ok: false,
                      fallbackToInProcess: true,
                      error: extractorMismatch,
                    })
                  }
                  return handleDaemonPollChangesRequest({
                    requestId: req.id,
                    resolvedRoot,
                    branch: req.branch,
                    cursor: req.cursor,
                    datalogSessionsRef: input.datalogSessionsRef,
                    pollSemaphoresRef: input.pollSemaphoresRef,
                  })
                })
                .exhaustive()
            })
            .exhaustive()
        }).pipe(
          Effect.map((res) => JSON.stringify(res)),
          Effect.catchDefect((defect: unknown) =>
            Effect.sync(() => {
              const message = toErrorReasonMessage(defect)
              process.stderr.write(`[harness-mcp] Daemon line handler defect: ${message}\n`)
              return JSON.stringify({ id: req.id, ok: false, error: message })
            }),
          ),
        ),
      )
      .exhaustive()
  }

export const startHarnessDaemonServer = (
  repoRoot: string = process.cwd(),
  options?: StartHarnessDaemonServerOptions,
): Promise<HarnessDaemonServerHandle> => {
  const baseRoot = path.resolve(repoRoot)
  const fallbackWriterLeaseEpoch = options?.writerLeaseEpoch ?? LeaseEpoch.make(0)
  const daemonRuntime = ManagedRuntime.make(UnixSocketDaemonLive)

  return daemonRuntime
    .runPromiseExit(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        let closePromise: Promise<void> | undefined
        const close = (): Promise<void> => {
          if (closePromise !== undefined) {
            return closePromise
          }
          closePromise = daemonRuntime
            .runPromiseExit(Scope.close(scope, Exit.void))
            .then((closeExit) =>
              Exit.match(closeExit, {
                onFailure: (cause) =>
                  isPureInterruptCause(cause) ? undefined : Promise.reject(Cause.squash(cause)),
                onSuccess: () => undefined,
              }),
            )
            .finally(() =>
              daemonRuntime.dispose().catch((disposeErr: unknown) => {
                process.stderr.write(
                  `[harness-mcp] Daemon runtime dispose error: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
                )
              }),
            )
          return closePromise
        }
        const triggerShutdown = (): void => {
          queueMicrotask(() => {
            void close().catch((shutdownErr: unknown) => {
              process.stderr.write(
                `[harness-mcp] Daemon shutdown error: ${toErrorReasonMessage(shutdownErr)}\n`,
              )
            })
          })
        }

        const startResult = yield* Effect.gen(function* () {
          const scopeCache = yield* makeDaemonWorktreeScopeCache(baseRoot, {
            maxEntries: options?.linkedWorktreeCacheMaxEntries,
            validateWorktree: options?.validateWorktree,
          })
          const unixSocketDaemon = yield* UnixSocketDaemonPort
          const workflowState = yield* acquireWorkflowEngineInScope({
            daemonScope: scope,
            startupState: scopeCache.startupState,
            fallbackWriterLeaseEpoch,
            workflowEngineOptions: options?.workflowEngine,
            unixSocketDaemon,
          })

          return yield* match(workflowState)
            .with({ _tag: "AttachedAlreadyAlive" }, ({ socketPath }) =>
              Scope.close(scope, Exit.void).pipe(
                Effect.as<HarnessDaemonServerHandle>({
                  socketPath,
                  writerLeaseEpoch: LeaseEpoch.make(0),
                  close: () => daemonRuntime.dispose(),
                }),
              ),
            )
            .with({ _tag: "Active" }, { _tag: "Inactive" }, (readyState) =>
              Effect.gen(function* () {
                const effectiveWriterLeaseEpoch = match(readyState)
                  .with({ _tag: "Active" }, ({ lease }) => lease.leaseEpoch)
                  .with({ _tag: "Inactive" }, ({ writerLeaseEpoch }) => writerLeaseEpoch)
                  .exhaustive()

                const canonicalBaseRoot = match(scopeCache.startupState)
                  .with({ _tag: "Valid" }, ({ worktree }) => worktree.worktreeRoot)
                  .with({ _tag: "NonGit" }, { _tag: "InvalidGit" }, () => baseRoot)
                  .exhaustive()

                const ruleSourceConfig = resolveDaemonRuleSourceConfig(
                  canonicalBaseRoot,
                  options?.ruleSourceRoot,
                )
                const startupRuleVersion = yield* resolveDiskGateRuleVersion(ruleSourceConfig)
                const startupExtractorDigest = computeGraphExtractorSourceDigest(canonicalBaseRoot)
                const canonicalSocketPath = match(scopeCache.startupState)
                  .with(
                    { _tag: "Valid" },
                    ({ worktree }) => resolveWorkflowRuntimePaths(worktree.commonGitDir).socketPath,
                  )
                  .with({ _tag: "NonGit" }, { _tag: "InvalidGit" }, () => undefined)
                  .exhaustive()
                const cachePortsRef = yield* SynchronizedRef.make<
                  ReadonlyMap<string, CachedDaemonAstPort>
                >(new Map())
                const datalogSessionsRef = yield* SynchronizedRef.make<
                  ReadonlyMap<string, DatalogSessionShape>
                >(new Map())
                const pollSemaphoresRef = yield* SynchronizedRef.make<
                  ReadonlyMap<string, Semaphore.Semaphore>
                >(new Map())

                type DaemonBindOutcome =
                  | { readonly _tag: "Bound"; readonly socketPath: DaemonSocketPath }
                  | { readonly _tag: "AlreadyAlive"; readonly socketPath: DaemonSocketPath }

                const socketResult = yield* startScopedUnixSocketDaemon(
                  WorkspaceFilePath.make(baseRoot),
                  {
                    socketTimeoutMs: DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
                    ...(canonicalSocketPath !== undefined
                      ? { socketPathOverride: canonicalSocketPath }
                      : {}),
                    lineHandler: createDaemonLineHandler({
                      baseRoot,
                      canonicalBaseRoot,
                      daemonScope: scope,
                      scopeCache,
                      cachePortsRef,
                      datalogSessionsRef,
                      pollSemaphoresRef,
                      startupRuleVersion,
                      startupExtractorDigest,
                      ruleSourceConfig,
                      writerLeaseEpoch: effectiveWriterLeaseEpoch,
                      ...(canonicalSocketPath !== undefined
                        ? { socketPath: canonicalSocketPath }
                        : {}),
                      ...match(readyState)
                        .with({ _tag: "Active" }, ({ runtime }) => ({ workflowRuntime: runtime }))
                        .with({ _tag: "Inactive" }, () => ({}))
                        .exhaustive(),
                    }),
                  },
                ).pipe(
                  Scope.provide(scope),
                  Effect.map((info): DaemonBindOutcome => ({
                    _tag: "Bound",
                    socketPath: info.socketPath,
                  })),
                  Effect.catchTag("DaemonServerError", (err) =>
                    match<
                      typeof err.reasonKind,
                      Effect.Effect<DaemonBindOutcome, DaemonServerError | WriterLeaseHeldError>
                    >(err.reasonKind)
                      .with("already-alive", () => {
                        if (options?.workflowEngine?.mode === "required") {
                          const commonGitDir = match(scopeCache.startupState)
                            .with({ _tag: "Valid" }, ({ worktree }) => worktree.commonGitDir)
                            .with({ _tag: "NonGit" }, { _tag: "InvalidGit" }, () => undefined)
                            .exhaustive()
                          if (commonGitDir !== undefined) {
                            return Scope.close(scope, Exit.void).pipe(
                              Effect.andThen(
                                Effect.fail(
                                  buildAlreadyAliveLeaseError(
                                    commonGitDir,
                                    options.workflowEngine?.hostIo,
                                  ),
                                ),
                              ),
                            )
                          }
                        }
                        return Scope.close(scope, Exit.void).pipe(
                          Effect.as<DaemonBindOutcome>({
                            _tag: "AlreadyAlive",
                            socketPath: err.socketPath,
                          }),
                        )
                      })
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
                )

                return yield* match(socketResult)
                  .with({ _tag: "AlreadyAlive" }, ({ socketPath }) =>
                    Effect.succeed<HarnessDaemonServerHandle>({
                      socketPath,
                      writerLeaseEpoch: LeaseEpoch.make(0),
                      close: () => daemonRuntime.dispose(),
                    }),
                  )
                  .with({ _tag: "Bound" }, ({ socketPath }) =>
                    Effect.gen(function* () {
                      yield* match(readyState)
                        .with({ _tag: "Active" }, (activeState) =>
                          forkWorkflowLeaseWatchers({
                            daemonScope: scope,
                            activeState,
                            options: options?.workflowEngine,
                            triggerShutdown,
                          }),
                        )
                        .with({ _tag: "Inactive" }, () => Effect.void)
                        .exhaustive()
                      return {
                        socketPath,
                        writerLeaseEpoch: effectiveWriterLeaseEpoch,
                        close,
                      } satisfies HarnessDaemonServerHandle
                    }),
                  )
                  .exhaustive()
              }),
            )
            .exhaustive()
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))

        return startResult
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
