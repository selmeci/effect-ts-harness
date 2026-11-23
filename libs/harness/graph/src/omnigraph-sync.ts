import {
  OmnigraphBranchName,
  OmnigraphCommitId,
  OmnigraphMergeConflictError,
  OmnigraphPreconditionError,
  toErrorReasonMessage,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { type BlobWrite, type Commit, type CommitChanges, type Diff } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import { writeGraphHeadMeta } from "./cluster-resolver.js"
import {
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  type HarnessGqQueryName,
} from "./gq-queries.js"
import { findTestsReaching, saveGraphSnapshot } from "./graph-engine.js"
import type { HarnessGraph, VitestCaseNode } from "./model.js"
import {
  executeGetBlobText,
  executePollChanges,
  executeStatBlob,
  isOmnigraphUnavailableError,
  makeOmnigraphClient as makeOmnigraphClientFromOps,
  mapOmnigraphConflictError,
  mapOmnigraphPreconditionError,
  type OmnigraphBlobSelectorInput,
  type OmnigraphBlobStatResult,
  type OmnigraphChangeFeedResult,
  OmnigraphClient,
  type OmnigraphCommitActionInput,
  type OmnigraphConditionalMutationInput,
  type OmnigraphConditionalMutationResult,
  type OmnigraphConnectionOptions,
  type OmnigraphDryRunMergeInput,
  type OmnigraphDryRunMergeResult,
  type OmnigraphGetBlobInput,
  type OmnigraphInspectCommitChangesInput,
  OmnigraphLoadError,
  type OmnigraphPollChangesInput,
  type OmnigraphProposeMergeInput,
  type OmnigraphPutBlobInput,
  resolveOmnigraphBaseUrl as resolveOmnigraphBaseUrlFromOps,
  toOmnigraphServerNdjson,
  toOmnigraphServerNdjsonResult,
} from "./omnigraph-operations.js"
import { decodeStrictOptionalCommitId, executeLoadWithStaleRefork } from "./omnigraph-v014-ops.js"

export {
  OmnigraphClient,
  OmnigraphLoadError,
  toOmnigraphServerNdjson,
  toOmnigraphServerNdjsonResult,
  type OmnigraphBlobSelectorInput,
  type OmnigraphBlobStatResult,
  type OmnigraphChangeFeedResult,
  type OmnigraphCommitActionInput,
  type OmnigraphConditionalMutationInput,
  type OmnigraphConditionalMutationResult,
  type OmnigraphConnectionOptions,
  type OmnigraphDryRunMergeInput,
  type OmnigraphDryRunMergeResult,
  type OmnigraphGetBlobInput,
  type OmnigraphInspectCommitChangesInput,
  type OmnigraphPollChangesInput,
  type OmnigraphProposeMergeInput,
  type OmnigraphPutBlobInput,
}

export const resolveOmnigraphBaseUrl = (
  options?: OmnigraphConnectionOptions,
  env?: Readonly<Record<string, string | undefined>>,
  hostIo?: SyncHostIo,
): string => resolveOmnigraphBaseUrlFromOps(options, env, hostIo)

export const makeOmnigraphClient = (
  options?: OmnigraphConnectionOptions,
  hostIo?: SyncHostIo,
  env?: Readonly<Record<string, string | undefined>>,
) => makeOmnigraphClientFromOps(options, hostIo, env)

export interface OmnigraphSyncResult {
  readonly syncedToOmnigraph: boolean
  readonly snapshotPath: string
  readonly commitId?: OmnigraphCommitId | undefined
  readonly error?: string | undefined
}

export const omnigraphReachableTests = (
  graph: HarnessGraph,
  targetOrSpan: string,
): ReadonlyArray<VitestCaseNode> => findTestsReaching(graph, targetOrSpan)

export type OmnigraphBranchDiff = Diff

export type OmnigraphNamedQueryResult =
  | {
      readonly source: "omnigraph"
      readonly rows: ReadonlyArray<Record<string, unknown>>
      readonly degraded: false
    }
  | {
      readonly source: "memory-fallback"
      readonly rows: ReadonlyArray<Record<string, unknown>>
      readonly degraded: true
      readonly fallbackError: string
    }

export interface OmnigraphBranchOpsShape {
  readonly sync: (
    graph: HarnessGraph,
    options?: OmnigraphConnectionOptions & {
      readonly branch?: OmnigraphBranchName | string | undefined
      readonly snapshotPath?: string | undefined
      readonly from?: OmnigraphBranchName | string | undefined
      readonly mode?: "overwrite" | "merge" | undefined
      readonly embeddingsByNodeKey?: ReadonlyMap<string, ReadonlyArray<number>> | undefined
    },
  ) => Effect.Effect<OmnigraphSyncResult>
  readonly mergeBranch: (
    options?: OmnigraphConnectionOptions & {
      readonly source?: OmnigraphBranchName | string | undefined
      readonly target?: OmnigraphBranchName | string | undefined
      readonly cleanupBranches?: ReadonlyArray<OmnigraphBranchName | string> | undefined
    },
  ) => Effect.Effect<void, OmnigraphLoadError>
  readonly dryRunMerge: (
    options: OmnigraphDryRunMergeInput,
  ) => Effect.Effect<OmnigraphDryRunMergeResult, OmnigraphLoadError | OmnigraphMergeConflictError>
  readonly diffBranches: (
    input?: OmnigraphConnectionOptions & {
      readonly source?: OmnigraphBranchName | string | undefined
      readonly target?: OmnigraphBranchName | string | undefined
    },
  ) => Effect.Effect<OmnigraphBranchDiff, OmnigraphLoadError>
}

export interface OmnigraphQueryOpsShape {
  readonly query: (
    input: OmnigraphConnectionOptions & {
      readonly query: string
      readonly name?: string | undefined
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: OmnigraphBranchName | string | undefined
    },
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, OmnigraphLoadError>
  readonly mutateConditional: (
    input: OmnigraphConditionalMutationInput,
  ) => Effect.Effect<
    OmnigraphConditionalMutationResult,
    OmnigraphLoadError | OmnigraphPreconditionError
  >
  readonly invokeNamedQuery: (
    input: OmnigraphConnectionOptions & {
      readonly name: HarnessGqQueryName
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: OmnigraphBranchName | string | undefined
      readonly fallbackGraph?: HarnessGraph | undefined
    },
  ) => Effect.Effect<OmnigraphNamedQueryResult, OmnigraphLoadError>
}

export interface OmnigraphChangeFeedOpsShape {
  readonly pollChanges: (
    input: OmnigraphPollChangesInput,
  ) => Effect.Effect<OmnigraphChangeFeedResult, OmnigraphLoadError>
}

export interface OmnigraphCommitProposalOpsShape {
  readonly proposeMergeCommit: (
    input: OmnigraphProposeMergeInput,
  ) => Effect.Effect<OmnigraphCommitId | null, OmnigraphLoadError | OmnigraphMergeConflictError>
  readonly inspectCommitChanges: (
    input: OmnigraphInspectCommitChangesInput,
  ) => Effect.Effect<CommitChanges, OmnigraphLoadError>
  readonly publishCommit: (
    input: OmnigraphCommitActionInput,
  ) => Effect.Effect<Commit, OmnigraphLoadError>
  readonly dropCommit: (
    input: OmnigraphCommitActionInput,
  ) => Effect.Effect<void, OmnigraphLoadError>
}

export interface OmnigraphBlobOpsShape {
  readonly putBlob: (input: OmnigraphPutBlobInput) => Effect.Effect<BlobWrite, OmnigraphLoadError>
  readonly getBlobText: (
    input: OmnigraphGetBlobInput,
  ) => Effect.Effect<string | null, OmnigraphLoadError>
  readonly statBlob: (
    input: OmnigraphGetBlobInput,
  ) => Effect.Effect<OmnigraphBlobStatResult, OmnigraphLoadError>
}

export interface OmnigraphSyncShape
  extends
    OmnigraphBranchOpsShape,
    OmnigraphQueryOpsShape,
    OmnigraphChangeFeedOpsShape,
    OmnigraphCommitProposalOpsShape,
    OmnigraphBlobOpsShape {}

export class OmnigraphSync extends Context.Service<OmnigraphSync, OmnigraphSyncShape>()(
  "@harness/graph/OmnigraphSync",
) {}

export const makeOmnigraphSyncLayer = (
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>> = hostIo.getEnv(),
): Layer.Layer<OmnigraphSync> =>
  Layer.succeed(
    OmnigraphSync,
    OmnigraphSync.of({
      sync: (graph, options) =>
        Effect.gen(function* () {
          const snapshotPath = options?.snapshotPath ?? ".harness/graph-snapshot.json"
          const ndjsonRes = toOmnigraphServerNdjsonResult(graph, options?.embeddingsByNodeKey)
          const ndjson = match(ndjsonRes)
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, () => undefined)
            .exhaustive()

          if (ndjson === undefined) {
            return match(ndjsonRes)
              .with({ _tag: "Failure" }, ({ failure }) => ({
                syncedToOmnigraph: false,
                snapshotPath,
                error: toErrorReasonMessage(failure.cause),
              }))
              .with({ _tag: "Success" }, () => ({
                syncedToOmnigraph: false,
                snapshotPath,
              }))
              .exhaustive()
          }

          if (ndjson.trim().length === 0) {
            return {
              syncedToOmnigraph: false,
              snapshotPath,
              error: "Cannot sync empty graph payload (0 entities)",
            }
          }

          const shouldWriteMeta = Boolean(
            options?.repoRoot && !snapshotPath.endsWith("plan-graph-snapshot.json"),
          )

          const branch = options?.branch ?? "main"
          const og = makeOmnigraphClient(options, hostIo, env)

          const mode = options?.mode ?? (branch !== "main" ? "overwrite" : "merge")
          const fromOpt = branch !== "main" ? (options?.from ?? "main") : undefined

          return yield* executeLoadWithStaleRefork(og, {
            branch,
            from: fromOpt,
            mode,
            data: ndjson,
          }).pipe(
            Effect.flatMap((loadRes) => {
              return match(decodeStrictOptionalCommitId(loadRes.commit?.graphCommitId))
                .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
                .with({ _tag: "Success" }, ({ success: decodedCommitId }) => {
                  const commitId = decodedCommitId ?? undefined
                  saveGraphSnapshot(graph, snapshotPath, hostIo)
                  if (shouldWriteMeta && options?.repoRoot) {
                    const metaSaved =
                      commitId !== undefined
                        ? writeGraphHeadMeta(options.repoRoot, hostIo, undefined, env, {
                            omnigraphCommitId: commitId,
                          })
                        : writeGraphHeadMeta(options.repoRoot, hostIo, undefined, env)
                    if (commitId !== undefined && metaSaved === null) {
                      return Effect.fail(
                        new OmnigraphLoadError({
                          cause: new Error(
                            "Failed to persist graph-head.json with omnigraphCommitId",
                          ),
                        }),
                      )
                    }
                  }
                  return Effect.succeed({
                    syncedToOmnigraph: true,
                    snapshotPath,
                    ...(commitId !== undefined ? { commitId } : {}),
                  })
                })
                .exhaustive()
            }),
            Effect.catch((err) => {
              if (!hostIo.existsSync(snapshotPath)) {
                saveGraphSnapshot(graph, snapshotPath, hostIo)
              }
              return Effect.succeed({
                syncedToOmnigraph: false,
                snapshotPath,
                error: err.cause instanceof Error ? err.cause.message : String(err.cause),
              })
            }),
          )
        }),

      mergeBranch: (options) =>
        Effect.gen(function* () {
          const source = options?.source ?? "impl/current"
          const target = options?.target ?? "main"
          const og = makeOmnigraphClient(options, hostIo, env)

          const branches = yield* Effect.tryPromise({
            try: () => og.branches.list(),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          })
          if (!branches.includes(source)) {
            return yield* new OmnigraphLoadError({
              cause: new Error(`Source branch "${source}" does not exist`),
            })
          }
          const mergeRes = yield* Effect.tryPromise({
            try: () => og.branches.merge({ source, target, deleteBranch: true }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          })

          if (options?.repoRoot !== undefined) {
            const commitId = yield* match(
              decodeStrictOptionalCommitId(mergeRes.commit?.graphCommitId),
            )
              .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
              .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success ?? undefined))
              .exhaustive()
            const metaSaved =
              commitId !== undefined
                ? writeGraphHeadMeta(options.repoRoot, hostIo, undefined, env, {
                    omnigraphCommitId: commitId,
                  })
                : writeGraphHeadMeta(options.repoRoot, hostIo, undefined, env)
            if (commitId !== undefined && metaSaved === null) {
              return yield* new OmnigraphLoadError({
                cause: new Error("Failed to persist graph-head.json with omnigraphCommitId"),
              })
            }
          }

          const cleanup = options?.cleanupBranches ?? []
          for (const branchToDelete of cleanup) {
            if (branchToDelete === source && mergeRes.branchDeleted === true) {
              continue
            }
            if (branchToDelete !== target && branchToDelete !== "main") {
              yield* Effect.tryPromise({
                try: () => og.branches.delete(branchToDelete),
                catch: (cause) => new OmnigraphLoadError({ cause }),
              }).pipe(
                Effect.catch((cleanupErr) =>
                  Effect.logWarning(
                    `Failed to delete cleanup branch "${branchToDelete}": ${toErrorReasonMessage(cleanupErr.cause)}`,
                  ),
                ),
              )
            }
          }
        }),

      dryRunMerge: (options) =>
        Effect.gen(function* () {
          const sourceBranch = OmnigraphBranchName.make(options.source)
          const targetBranch = OmnigraphBranchName.make(options.target ?? "main")
          const og = makeOmnigraphClient(options, hostIo, env)
          const res = yield* Effect.tryPromise({
            try: () =>
              og.branches.merge({
                source: sourceBranch,
                target: targetBranch,
                dryRun: true,
              }),
            catch: (cause) => mapOmnigraphConflictError(cause, sourceBranch, targetBranch),
          })
          return {
            outcome: res.outcome,
            source: sourceBranch,
            target: targetBranch,
            dryRun: true as const,
          }
        }),

      query: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input, hostIo, env)
          const res = yield* Effect.tryPromise({
            try: () =>
              og.query({
                query: input.query,
                ...(input.name ? { name: input.name } : {}),
                ...(input.params ? { params: input.params } : {}),
                branch: input.branch ?? "main",
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          })
          if (!Array.isArray(res.rows)) {
            return yield* new OmnigraphLoadError({
              cause: new Error("Omnigraph query response missing rows array"),
            })
          }
          return res.rows as ReadonlyArray<Record<string, unknown>>
        }),

      mutateConditional: (input) =>
        Effect.gen(function* () {
          const branch = OmnigraphBranchName.make(input.branch ?? "main")
          const og = makeOmnigraphClient(input, hostIo, env)
          const res = yield* Effect.tryPromise({
            try: () =>
              og.mutate(
                {
                  branch,
                  query: input.query,
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.params ? { params: input.params } : {}),
                },
                { ifGraphCommit: input.ifGraphCommit },
              ),
            catch: (cause) => mapOmnigraphPreconditionError(cause, branch, input.ifGraphCommit),
          })
          const commitId = yield* match(decodeStrictOptionalCommitId(res.commit?.graphCommitId))
            .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
            .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
            .exhaustive()
          return {
            branch: OmnigraphBranchName.make(res.branch),
            commitId,
            affectedNodes: res.affectedNodes,
            affectedEdges: res.affectedEdges,
            queryName: res.queryName,
          }
        }),

      invokeNamedQuery: (input) =>
        Effect.gen(function* () {
          if (!Object.hasOwn(HARNESS_GQ_QUERIES, input.name)) {
            return yield* new OmnigraphLoadError({
              cause: new Error(`Unknown named GQ query: ${String(input.name)}`),
            })
          }
          const og = makeOmnigraphClient(input, hostIo, env)
          const branch = input.branch ?? "main"

          const rowsEnvelopeSchema = Schema.Struct({
            rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
          })
          const decodeRowsEnvelope = Schema.decodeUnknownOption(rowsEnvelopeSchema)
          const extractRows = (res: unknown): ReadonlyArray<Record<string, unknown>> | undefined =>
            Option.getOrUndefined(Option.map(decodeRowsEnvelope(res), (decoded) => decoded.rows))

          return yield* Effect.tryPromise({
            try: () =>
              og.queries.invoke(input.name, {
                ...(input.params ? { params: input.params } : {}),
                branch,
                expectMutation: false,
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.flatMap((res) => {
              const rows = extractRows(res)
              return rows !== undefined
                ? Effect.succeed({
                    source: "omnigraph" as const,
                    rows,
                    degraded: false as const,
                  })
                : Effect.fail(
                    new OmnigraphLoadError({
                      cause: new Error("Omnigraph named query response missing rows array"),
                    }),
                  )
            }),
            Effect.catch((primaryErr) => {
              const queryDescriptor = HARNESS_GQ_QUERIES[input.name]
              return Effect.tryPromise({
                try: () =>
                  og.query({
                    query: queryDescriptor.source,
                    name: input.name,
                    ...(input.params ? { params: input.params } : {}),
                    branch,
                  }),
                catch: (cause) => new OmnigraphLoadError({ cause }),
              }).pipe(
                Effect.flatMap((res) => {
                  const rows = extractRows(res)
                  return rows !== undefined
                    ? Effect.succeed({
                        source: "omnigraph" as const,
                        rows,
                        degraded: false as const,
                      })
                    : Effect.fail(
                        new OmnigraphLoadError({
                          cause: new Error("Omnigraph named query response missing rows array"),
                        }),
                      )
                }),
                Effect.catch((fallbackErr) => {
                  const primaryMsg = toErrorReasonMessage(primaryErr.cause)
                  const fallbackMsg = toErrorReasonMessage(fallbackErr.cause)
                  const fallbackError = `Primary queries.invoke failed (${primaryMsg}); fallback query failed (${fallbackMsg})`
                  if (
                    input.fallbackGraph === undefined ||
                    !isOmnigraphUnavailableError(fallbackErr.cause)
                  ) {
                    return Effect.fail(
                      new OmnigraphLoadError({
                        cause: new Error(fallbackError, { cause: fallbackErr.cause }),
                      }),
                    )
                  }
                  return Effect.logWarning(
                    `Named query "${input.name}" falling back to in-memory execution: ${fallbackError}`,
                  ).pipe(
                    Effect.as({
                      source: "memory-fallback" as const,
                      rows: executeNamedGqQueryInMemory(
                        input.fallbackGraph,
                        input.name,
                        input.params,
                      ),
                      degraded: true as const,
                      fallbackError,
                    }),
                  )
                }),
              )
            }),
          )
        }),

      diffBranches: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input, hostIo, env)
          const source = input?.source ?? "impl/current"
          const target = input?.target ?? "plan/current"

          return yield* Effect.tryPromise({
            try: () => og.branches.diff({ source, target }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          })
        }),

      pollChanges: (input) => executePollChanges(makeOmnigraphClient(input, hostIo, env), input),

      proposeMergeCommit: (input) =>
        Effect.gen(function* () {
          const sourceBranch = OmnigraphBranchName.make(input.source)
          const targetBranch = OmnigraphBranchName.make(input.target ?? "main")
          const og = makeOmnigraphClient(input, hostIo, env)
          const res = yield* Effect.tryPromise({
            try: () =>
              og.branches.merge({
                source: sourceBranch,
                target: targetBranch,
                asCommit: true,
              }),
            catch: (cause) => mapOmnigraphConflictError(cause, sourceBranch, targetBranch),
          })
          return yield* match(decodeStrictOptionalCommitId(res.commit?.graphCommitId))
            .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
            .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
            .exhaustive()
        }),

      inspectCommitChanges: (input) =>
        Effect.tryPromise({
          try: () =>
            makeOmnigraphClient(input, hostIo, env).commits.changes(input.commitId, {
              ...(input.pageToken ? { pageToken: input.pageToken } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            }),
          catch: (cause) => new OmnigraphLoadError({ cause }),
        }),

      publishCommit: (input) =>
        Effect.tryPromise({
          try: () => makeOmnigraphClient(input, hostIo, env).commits.publish(input.commitId),
          catch: (cause) => new OmnigraphLoadError({ cause }),
        }),

      dropCommit: (input) =>
        Effect.tryPromise({
          try: () => makeOmnigraphClient(input, hostIo, env).commits.drop(input.commitId),
          catch: (cause) => new OmnigraphLoadError({ cause }),
        }),

      putBlob: (input) => {
        const bytes =
          typeof input.data === "string" ? new TextEncoder().encode(input.data) : input.data
        return Effect.tryPromise({
          try: () =>
            makeOmnigraphClient(input, hostIo, env).blobs.put({
              entity: input.entity,
              type: input.type,
              id: input.id,
              property: input.property,
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}),
              data: bytes,
            }),
          catch: (cause) => new OmnigraphLoadError({ cause }),
        })
      },

      getBlobText: (input) => executeGetBlobText(makeOmnigraphClient(input, hostIo, env), input),

      statBlob: (input) => executeStatBlob(makeOmnigraphClient(input, hostIo, env), input),
    }),
  )

export const syncToOmnigraphAndSnapshot = Effect.fn("OmnigraphSync.sync")(function* (
  graph: HarnessGraph,
  options?: OmnigraphConnectionOptions & {
    readonly branch?: OmnigraphBranchName | string | undefined
    readonly snapshotPath?: string | undefined
    readonly from?: OmnigraphBranchName | string | undefined
    readonly mode?: "overwrite" | "merge" | undefined
    readonly embeddingsByNodeKey?: ReadonlyMap<string, ReadonlyArray<number>> | undefined
  },
) {
  const service = yield* OmnigraphSync
  return yield* service.sync(graph, options)
})

export const mergeOmnigraphBranch = Effect.fn("OmnigraphSync.mergeBranch")(function* (
  options?: OmnigraphConnectionOptions & {
    readonly source?: OmnigraphBranchName | string | undefined
    readonly target?: OmnigraphBranchName | string | undefined
    readonly cleanupBranches?: ReadonlyArray<OmnigraphBranchName | string> | undefined
  },
) {
  const service = yield* OmnigraphSync
  return yield* service.mergeBranch(options)
})

export const dryRunMergeOmnigraphBranches = Effect.fn("OmnigraphSync.dryRunMerge")(function* (
  options: OmnigraphDryRunMergeInput,
): Effect.fn.Return<
  OmnigraphDryRunMergeResult,
  OmnigraphLoadError | OmnigraphMergeConflictError,
  OmnigraphSync
> {
  const service = yield* OmnigraphSync
  return yield* service.dryRunMerge(options)
})

export const mutateOmnigraphConditional = Effect.fn("OmnigraphSync.mutateConditional")(function* (
  input: OmnigraphConditionalMutationInput,
): Effect.fn.Return<
  OmnigraphConditionalMutationResult,
  OmnigraphLoadError | OmnigraphPreconditionError,
  OmnigraphSync
> {
  const service = yield* OmnigraphSync
  return yield* service.mutateConditional(input)
})

export const pollOmnigraphChanges = Effect.fn("OmnigraphSync.pollChanges")(function* (
  input: OmnigraphPollChangesInput,
): Effect.fn.Return<OmnigraphChangeFeedResult, OmnigraphLoadError, OmnigraphSync> {
  const service = yield* OmnigraphSync
  return yield* service.pollChanges(input)
})

export const queryOmnigraph = (
  input: OmnigraphConnectionOptions & {
    readonly query: string
    readonly name?: string | undefined
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: OmnigraphBranchName | string | undefined
  },
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, OmnigraphLoadError, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.query(input))

export const invokeOmnigraphNamedQuery = (
  input: OmnigraphConnectionOptions & {
    readonly name: HarnessGqQueryName
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: OmnigraphBranchName | string | undefined
    readonly fallbackGraph?: HarnessGraph | undefined
  },
): Effect.Effect<OmnigraphNamedQueryResult, OmnigraphLoadError, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.invokeNamedQuery(input))

export const diffOmnigraphBranches = (
  input?: OmnigraphConnectionOptions & {
    readonly source?: OmnigraphBranchName | string | undefined
    readonly target?: OmnigraphBranchName | string | undefined
  },
): Effect.Effect<OmnigraphBranchDiff, OmnigraphLoadError, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.diffBranches(input))
