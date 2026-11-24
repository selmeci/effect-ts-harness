import { join } from "node:path"
import {
  ErrorReasonMessage,
  OmnigraphActorToken,
  OmnigraphAuthTokensSchema,
  OmnigraphBaseUrl,
  OmnigraphBranchName,
  OmnigraphChangeCursor,
  OmnigraphChangeOp,
  OmnigraphCommitId,
  OmnigraphConflictKind,
  OmnigraphEntityId,
  OmnigraphEntityKind,
  OmnigraphMergeConflictDetail,
  OmnigraphMergeConflictError,
  OmnigraphPreconditionError,
  OmnigraphTypeName,
  toErrorReasonMessage,
} from "@harness/contract"
import type { ExtendedHostIo, SyncHostIo } from "@harness/service/host-io"
import { Data, Effect, Option, Result, Schema, Stream } from "effect"
import {
  DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES,
  DEFAULT_OMNIGRAPH_OVERWRITE_CHUNK_BYTES,
  splitNdjsonIntoByteChunks,
} from "./omnigraph-ndjson-chunks.js"
import {
  type BranchMergeOutcome,
  type ChangeBlock,
  ConflictError,
  type FetchLike,
  GoneError,
  type Ingest,
  NetworkError,
  NotFoundError,
  Omnigraph,
  PreconditionFailedError,
  ServiceUnavailableError,
  TooManyRequestsError,
} from "@modernrelay/omnigraph"
import { match } from "ts-pattern"

export const HARNESS_OMNIGRAPH_GRAPH_ID = "harness" as const
export const WORKFLOW_OMNIGRAPH_GRAPH_ID = "harness-workflows" as const

export class OmnigraphLoadError extends Data.TaggedError("OmnigraphLoadError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return toErrorReasonMessage(this.cause, "Omnigraph operation failed")
  }
}

export interface OmnigraphConnectionOptions {
  readonly baseUrl?: OmnigraphBaseUrl | string | undefined
  readonly repoRoot?: string | undefined
  readonly graphId?: string | undefined
  readonly token?: OmnigraphActorToken | string | undefined
  readonly actor?: "harness-cli" | "agent-mcp" | undefined
  readonly fetch?: FetchLike | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

const decodeAuthTokensOption = Schema.decodeOption(Schema.fromJsonString(OmnigraphAuthTokensSchema))

export const isLoopbackOmnigraphUrl = (rawUrl: string): boolean =>
  Result.getOrElse(
    Result.try(() => {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false
      }
      const host = parsed.hostname.toLowerCase()
      return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
    }),
    () => false,
  )

const hasStatModeSync = (
  hostIo: SyncHostIo,
): hostIo is SyncHostIo & Pick<ExtendedHostIo, "statModeSync"> =>
  "statModeSync" in hostIo && typeof hostIo.statModeSync === "function"

export const readAuthTokensFromClusterDir = (
  clusterDir: string,
  hostIo: SyncHostIo,
  actor: "harness-cli" | "agent-mcp",
): string | undefined => {
  const authPath = join(clusterDir, "auth-tokens.json")
  if (!hostIo.existsSync(authPath)) {
    return undefined
  }
  const mode = hasStatModeSync(hostIo) ? hostIo.statModeSync(authPath) : undefined
  if (mode === undefined || (mode & 0o077) !== 0) {
    process.stderr.write(
      `[harness/graph] Warning: refusing ${authPath} with ${mode === undefined ? "unknown" : `permissive (${(mode & 0o777).toString(8)})`} mode\n`,
    )
    return undefined
  }
  return match(Result.try(() => hostIo.readTextSync(authPath)))
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness/graph] Warning: failed to read ${authPath}: ${toErrorReasonMessage(failure)}\n`,
      )
      return undefined
    })
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeAuthTokensOption(raw))
        .with({ _tag: "Some" }, ({ value: tokens }) => {
          const selected = match(actor)
            .with("harness-cli", () => tokens.cliToken)
            .with("agent-mcp", () => tokens.mcpToken)
            .exhaustive()
          return selected && selected.length > 0 ? selected : undefined
        })
        .with({ _tag: "None" }, () => {
          process.stderr.write(
            `[harness/graph] Warning: failed to decode ${authPath} as OmnigraphAuthTokens JSON\n`,
          )
          return undefined
        })
        .exhaustive(),
    )
    .exhaustive()
}

export const isOmnigraphUnavailableError = (cause: unknown): boolean => {
  if (cause instanceof ServiceUnavailableError || cause instanceof NetworkError) {
    return true
  }
  if (typeof cause === "object" && cause !== null) {
    const status = Reflect.get(cause, "status")
    if (
      status === 502 ||
      status === 503 ||
      status === 504 ||
      (status === 0 && Reflect.get(cause, "requestDispatched") === false)
    ) {
      return true
    }
  }
  if (cause instanceof TypeError) {
    return true
  }
  if (cause instanceof Error) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "EPIPE" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true
    }
    if ("cause" in cause && cause.cause !== undefined && cause.cause !== cause) {
      return isOmnigraphUnavailableError(cause.cause)
    }
  }
  return false
}

const matchesErrorChain = (error: unknown, predicate: (item: unknown) => boolean): boolean => {
  const visited = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !visited.has(current)) {
    if (predicate(current)) {
      return true
    }
    visited.add(current)
    if (typeof current !== "object") {
      break
    }
    current = Reflect.get(current, "cause")
  }
  return false
}

export const isOmnigraphTooManyRequestsError = (error: unknown): boolean =>
  matchesErrorChain(
    error,
    (item) =>
      item instanceof TooManyRequestsError ||
      (typeof item === "object" && item !== null && Reflect.get(item, "status") === 429),
  )

export const isOmnigraphPreconditionOrConflictError = (error: unknown): boolean =>
  matchesErrorChain(
    error,
    (item) =>
      item instanceof PreconditionFailedError ||
      item instanceof ConflictError ||
      (typeof item === "object" &&
        item !== null &&
        (Reflect.get(item, "status") === 412 || Reflect.get(item, "status") === 409)),
  )

export const resolveOmnigraphGraphId = (
  options?: Pick<OmnigraphConnectionOptions, "graphId">,
  env?: Readonly<Record<string, string | undefined>>,
  defaultGraphId: string = HARNESS_OMNIGRAPH_GRAPH_ID,
): string => options?.graphId ?? env?.OMNIGRAPH_GRAPH_ID ?? defaultGraphId

const decodeStrictOptionalEntityId = (
  raw: unknown,
): Result.Result<OmnigraphEntityId | null, OmnigraphLoadError> => {
  if (raw === null || raw === undefined) {
    return Result.succeed(null)
  }
  if (typeof raw !== "string") {
    return Result.fail(
      new OmnigraphLoadError({
        cause: new Error(`Invalid non-string Omnigraph entityId (${typeof raw})`),
      }),
    )
  }
  return match(Schema.decodeOption(OmnigraphEntityId)(raw.trim()))
    .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
    .with({ _tag: "None" }, () =>
      Result.fail(
        new OmnigraphLoadError({
          cause: new Error(`Invalid Omnigraph entityId: ${JSON.stringify(raw)}`),
        }),
      ),
    )
    .exhaustive()
}

export const decodeStrictOptionalCommitId = (
  raw: unknown,
): Result.Result<OmnigraphCommitId | null, OmnigraphLoadError> => {
  if (raw === null || raw === undefined) {
    return Result.succeed(null)
  }
  if (typeof raw !== "string") {
    return Result.fail(
      new OmnigraphLoadError({
        cause: new Error(`Invalid non-string Omnigraph commitId (${typeof raw})`),
      }),
    )
  }
  return match(Schema.decodeOption(OmnigraphCommitId)(raw.trim()))
    .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
    .with({ _tag: "None" }, () =>
      Result.fail(
        new OmnigraphLoadError({
          cause: new Error(`Invalid Omnigraph commitId: ${JSON.stringify(raw)}`),
        }),
      ),
    )
    .exhaustive()
}

export const mapOmnigraphConflictError = (
  cause: unknown,
  sourceBranch: OmnigraphBranchName,
  targetBranch: OmnigraphBranchName,
): OmnigraphLoadError | OmnigraphMergeConflictError => {
  if (cause instanceof ConflictError) {
    const conflicts: Array<OmnigraphMergeConflictDetail> = []
    for (const c of cause.mergeConflicts ?? []) {
      const decodedOpt = Option.all([
        Schema.decodeOption(OmnigraphEntityKind)(c.entityKind),
        Schema.decodeOption(OmnigraphTypeName)(c.typeName),
      ])
      const fieldsOrErr = match(decodedOpt)
        .with({ _tag: "Some" }, ({ value: [entityKind, typeName] }) => ({
          ok: true as const,
          entityKind,
          typeName,
        }))
        .with({ _tag: "None" }, () => ({
          ok: false as const,
          error: new OmnigraphLoadError({
            cause: new Error(
              `Invalid Omnigraph merge conflict metadata (kind=${JSON.stringify(c.kind)}, entityKind=${JSON.stringify(c.entityKind)}, typeName=${JSON.stringify(c.typeName)})`,
            ),
          }),
        }))
        .exhaustive()
      if (!fieldsOrErr.ok) {
        return fieldsOrErr.error
      }
      const { entityKind, typeName } = fieldsOrErr
      const baseMessage = toErrorReasonMessage(c.message)
      const { kind, message } = match(Schema.decodeOption(OmnigraphConflictKind)(c.kind))
        .with({ _tag: "Some" }, ({ value }) => ({
          kind: value,
          message: baseMessage,
        }))
        .with({ _tag: "None" }, () => {
          const rawKind = String(c.kind).trim() || String(c.kind)
          return {
            kind: "value_constraint_violation" as const,
            message: ErrorReasonMessage.make(`[${rawKind}] ${baseMessage}`),
          }
        })
        .exhaustive()
      const entityIdRes = decodeStrictOptionalEntityId(c.entityId)
      const earlyErr = match(entityIdRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, ({ success: entityId }) => {
          conflicts.push({
            kind,
            entityKind,
            typeName,
            entityId,
            message,
          })
          return undefined
        })
        .exhaustive()
      if (earlyErr !== undefined) {
        return earlyErr
      }
    }
    return new OmnigraphMergeConflictError({
      sourceBranch,
      targetBranch,
      conflicts,
    })
  }
  return new OmnigraphLoadError({ cause })
}

export const mapOmnigraphPreconditionError = (
  cause: unknown,
  branch: OmnigraphBranchName,
  expectedCommit: OmnigraphCommitId,
): OmnigraphLoadError | OmnigraphPreconditionError => {
  if (cause instanceof PreconditionFailedError) {
    const actualCommitRes = decodeStrictOptionalCommitId(cause.preconditionFailure?.actual)
    return match(actualCommitRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with(
        { _tag: "Success" },
        ({ success: actualCommit }) =>
          new OmnigraphPreconditionError({
            branch,
            expectedCommit,
            actualCommit,
          }),
      )
      .exhaustive()
  }
  return new OmnigraphLoadError({ cause })
}

export const isChangeFeedGapError = (cause: unknown): boolean =>
  cause instanceof GoneError ||
  (typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    (cause as { readonly status: unknown }).status === 410)

export const decodeStrictOptionalCursor = (
  raw: unknown,
): Result.Result<OmnigraphChangeCursor | null, OmnigraphLoadError> => {
  if (raw === null || raw === undefined) {
    return Result.succeed(null)
  }
  if (typeof raw !== "string") {
    return Result.fail(
      new OmnigraphLoadError({
        cause: new Error(`Invalid non-string Omnigraph change cursor (${typeof raw})`),
      }),
    )
  }
  return match(Schema.decodeOption(OmnigraphChangeCursor)(raw.trim()))
    .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
    .with({ _tag: "None" }, () =>
      Result.fail(
        new OmnigraphLoadError({
          cause: new Error(`Invalid Omnigraph change cursor: ${JSON.stringify(raw)}`),
        }),
      ),
    )
    .exhaustive()
}

export interface OmnigraphDryRunMergeInput extends OmnigraphConnectionOptions {
  readonly source: OmnigraphBranchName | string
  readonly target?: OmnigraphBranchName | string | undefined
}

export interface OmnigraphDryRunMergeResult {
  readonly outcome: BranchMergeOutcome
  readonly source: OmnigraphBranchName
  readonly target: OmnigraphBranchName
  readonly dryRun: true
}

export interface OmnigraphConditionalMutationInput extends OmnigraphConnectionOptions {
  readonly query: string
  readonly name?: string | undefined
  readonly params?: Readonly<Record<string, unknown>> | undefined
  readonly branch?: OmnigraphBranchName | string | undefined
  readonly ifGraphCommit: OmnigraphCommitId
}

export interface OmnigraphConditionalMutationResult {
  readonly branch: OmnigraphBranchName
  readonly commitId: OmnigraphCommitId | null
  readonly affectedNodes: number
  readonly affectedEdges: number
  readonly queryName: string
}

export interface OmnigraphPollChangesInput extends OmnigraphConnectionOptions {
  readonly branch?: OmnigraphBranchName | string | undefined
  readonly cursor?: OmnigraphChangeCursor | undefined
  readonly start?: "now" | "beginning" | `after:${string}` | undefined
  readonly kind?: ReadonlyArray<OmnigraphEntityKind> | undefined
  readonly type?: ReadonlyArray<OmnigraphTypeName> | undefined
  readonly op?: ReadonlyArray<OmnigraphChangeOp> | undefined
  readonly limit?: number | undefined
}

export interface OmnigraphChangeFeedResult {
  readonly blocks: ReadonlyArray<ChangeBlock>
  readonly cursor: OmnigraphChangeCursor | null
  readonly caughtUp: boolean
  readonly nextPageToken: string | null
  readonly requiresBaseline: boolean
}

export interface OmnigraphProposeMergeInput extends OmnigraphConnectionOptions {
  readonly source: OmnigraphBranchName | string
  readonly target?: OmnigraphBranchName | string | undefined
}

export interface OmnigraphInspectCommitChangesInput extends OmnigraphConnectionOptions {
  readonly commitId: OmnigraphCommitId
  readonly pageToken?: string | undefined
  readonly limit?: number | undefined
}

export interface OmnigraphCommitActionInput extends OmnigraphConnectionOptions {
  readonly commitId: OmnigraphCommitId
}

export interface OmnigraphBlobSelectorInput extends OmnigraphConnectionOptions {
  readonly entity: OmnigraphEntityKind
  readonly type: OmnigraphTypeName
  readonly id: OmnigraphEntityId
  readonly property: string
  readonly branch?: OmnigraphBranchName | string | undefined
}

export interface OmnigraphPutBlobInput extends OmnigraphBlobSelectorInput {
  readonly data: string | Uint8Array<ArrayBuffer>
  readonly ifMatch?: string | undefined
}

export interface OmnigraphGetBlobInput extends OmnigraphBlobSelectorInput {
  readonly snapshot?: OmnigraphCommitId | undefined
  readonly ifNoneMatch?: string | undefined
}

export interface OmnigraphBlobStatResult {
  readonly status: number
  readonly etag: string | null
  readonly contentLength: number | null
  readonly contentType: string | null
}

const cancelResponseBody = (res: Response): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => (res.body ? res.body.cancel() : Promise.resolve()),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

export const executePollChanges = (
  og: Omnigraph,
  input: OmnigraphPollChangesInput,
): Effect.Effect<OmnigraphChangeFeedResult, OmnigraphLoadError> =>
  Effect.tryPromise({
    try: () =>
      og.changes.poll({
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.start ? { start: input.start } : {}),
        ...(input.kind ? { kind: [...input.kind] } : {}),
        ...(input.type ? { type: [...input.type] } : {}),
        ...(input.op ? { op: [...input.op] } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    catch: (cause) => new OmnigraphLoadError({ cause }),
  }).pipe(
    Effect.flatMap((feed) =>
      match(decodeStrictOptionalCursor(feed.cursor))
        .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
        .with({ _tag: "Success" }, ({ success: cursor }) =>
          Effect.succeed<OmnigraphChangeFeedResult>({
            blocks: feed.blocks,
            cursor,
            caughtUp: feed.caughtUp ?? false,
            nextPageToken: feed.nextPageToken ?? null,
            requiresBaseline: false,
          }),
        )
        .exhaustive(),
    ),
    Effect.catchIf(
      (err) => isChangeFeedGapError(err.cause),
      () =>
        Stream.fromAsyncIterable(
          og.changes.baseline({
            ...(input.branch ? { branch: input.branch } : {}),
            ...(input.kind ? { kind: [...input.kind] } : {}),
            ...(input.type ? { type: [...input.type] } : {}),
            ...(input.op ? { op: [...input.op] } : {}),
          }),
          (cause) => new OmnigraphLoadError({ cause }),
        ).pipe(
          Stream.mapEffect((rec) =>
            "baseline" in rec
              ? match(decodeStrictOptionalCursor(rec.baseline.resumeCursor))
                  .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
                  .with({ _tag: "Success" }, ({ success }) => Effect.succeedSome(success))
                  .exhaustive()
              : Effect.succeedNone,
          ),
          Stream.runFold(
            () => null as OmnigraphChangeCursor | null,
            (acc, cursorOpt) =>
              match(cursorOpt)
                .with({ _tag: "Some" }, ({ value }) => value)
                .with({ _tag: "None" }, () => acc)
                .exhaustive(),
          ),
          Effect.flatMap((resumeCursor) =>
            resumeCursor === null
              ? Effect.fail(
                  new OmnigraphLoadError({
                    cause: new Error("Omnigraph baseline stream completed without a resumeCursor"),
                  }),
                )
              : Effect.succeed<OmnigraphChangeFeedResult>({
                  blocks: [],
                  cursor: resumeCursor,
                  caughtUp: true,
                  nextPageToken: null,
                  requiresBaseline: true,
                }),
          ),
        ),
    ),
  )

export const executeGetBlobText = (
  og: Omnigraph,
  input: OmnigraphGetBlobInput,
): Effect.Effect<string | null, OmnigraphLoadError> =>
  Effect.tryPromise({
    try: () =>
      og.blobs.get({
        entity: input.entity,
        type: input.type,
        id: input.id,
        property: input.property,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
        ...(input.ifNoneMatch ? { ifNoneMatch: input.ifNoneMatch } : {}),
      }),
    catch: (cause) => new OmnigraphLoadError({ cause }),
  }).pipe(
    Effect.flatMap((res) =>
      match(res.status)
        .with(404, 304, () => cancelResponseBody(res).pipe(Effect.as<string | null>(null)))
        .when(
          (status) => status >= 200 && status < 300,
          () =>
            Effect.tryPromise({
              try: () => res.text(),
              catch: (cause) => new OmnigraphLoadError({ cause }),
            }),
        )
        .otherwise((status) =>
          cancelResponseBody(res).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new OmnigraphLoadError({
                  cause: new Error(`Omnigraph blob GET failed with status ${status}`),
                }),
              ),
            ),
          ),
        ),
    ),
    Effect.catchIf(
      (err) => err.cause instanceof NotFoundError,
      () => Effect.succeed<string | null>(null),
    ),
  )

export const executeStatBlob = (
  og: Omnigraph,
  input: OmnigraphGetBlobInput,
): Effect.Effect<OmnigraphBlobStatResult, OmnigraphLoadError> =>
  Effect.tryPromise({
    try: () =>
      og.blobs.stat({
        entity: input.entity,
        type: input.type,
        id: input.id,
        property: input.property,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
        ...(input.ifNoneMatch ? { ifNoneMatch: input.ifNoneMatch } : {}),
      }),
    catch: (cause) => new OmnigraphLoadError({ cause }),
  }).pipe(
    Effect.flatMap((res) =>
      cancelResponseBody(res).pipe(
        Effect.flatMap(() =>
          match(res.status)
            .when(
              (status) => status === 304 || status === 404 || (status >= 200 && status < 300),
              () => {
                const lenHeader = res.headers.get("content-length")
                const parsedLen =
                  lenHeader !== null && lenHeader.trim() !== "" ? Number(lenHeader) : Number.NaN
                return Effect.succeed<OmnigraphBlobStatResult>({
                  status: res.status,
                  etag: res.headers.get("etag"),
                  contentLength: Number.isFinite(parsedLen) ? parsedLen : null,
                  contentType: res.headers.get("content-type"),
                })
              },
            )
            .otherwise((status) =>
              Effect.fail(
                new OmnigraphLoadError({
                  cause: new Error(`Omnigraph blob HEAD failed with status ${status}`),
                }),
              ),
            ),
        ),
      ),
    ),
  )

export {
  DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES,
  DEFAULT_OMNIGRAPH_OVERWRITE_CHUNK_BYTES,
  splitNdjsonIntoByteChunks,
}

export interface OmnigraphLoadWithReforkInput {
  readonly branch: string
  readonly from?: string | undefined
  readonly mode: "overwrite" | "append" | "merge"
  readonly data: string
  readonly maxChunkBytes?: number | undefined
}

const runSingleLoad = (
  og: Omnigraph,
  branch: string,
  mode: "overwrite" | "append" | "merge",
  data: string,
  from?: string,
): Effect.Effect<Ingest, OmnigraphLoadError> =>
  Effect.tryPromise({
    try: () => og.load({ branch, mode, data, ...(from !== undefined ? { from } : {}) }),
    catch: (cause) => new OmnigraphLoadError({ cause }),
  })

export const executeLoadWithStaleRefork = (
  og: Omnigraph,
  input: OmnigraphLoadWithReforkInput,
): Effect.Effect<Ingest, OmnigraphLoadError> =>
  Effect.gen(function* () {
    const { isOverwrite, nextMode } = match(input.mode)
      .with("overwrite", () => ({ isOverwrite: true, nextMode: "merge" as const }))
      .with("merge", () => ({ isOverwrite: false, nextMode: "merge" as const }))
      .with("append", () => ({ isOverwrite: false, nextMode: "append" as const }))
      .exhaustive()
    const chunkBytes =
      input.maxChunkBytes ??
      (isOverwrite ? DEFAULT_OMNIGRAPH_OVERWRITE_CHUNK_BYTES : DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES)
    const chunks = splitNdjsonIntoByteChunks(input.data, chunkBytes)
    const runChunkedLoad = Effect.gen(function* () {
      const firstData = chunks[0] ?? input.data
      const firstRes = yield* runSingleLoad(og, input.branch, input.mode, firstData, input.from)
      let lastRes = firstRes
      for (let i = 1; i < chunks.length; i++) {
        lastRes = yield* runSingleLoad(og, input.branch, nextMode, chunks[i] ?? "")
      }
      return { firstCreated: firstRes.branchCreated, lastRes }
    })

    const initial = yield* runChunkedLoad
    const skipRefork =
      initial.firstCreated !== false ||
      !isOverwrite ||
      input.branch === "main" ||
      input.from === undefined ||
      input.from === input.branch
    if (skipRefork) return initial.lastRes

    const fromBranch = input.from
    const mergeBaseRes = yield* Effect.tryPromise({
      try: () => og.branches.mergeBase({ source: input.branch, target: fromBranch }),
      catch: (cause) => new OmnigraphLoadError({ cause }),
    })
    if (mergeBaseRes.mergeBase.graphCommitId === mergeBaseRes.targetCommitId) {
      return initial.lastRes
    }
    const hasConflict = yield* Effect.tryPromise({
      try: () => og.branches.merge({ source: input.branch, target: fromBranch, dryRun: true }),
      catch: (cause) => new OmnigraphLoadError({ cause }),
    }).pipe(
      Effect.as(false),
      Effect.catchIf(
        (err) => err.cause instanceof ConflictError,
        () => Effect.succeed(true),
      ),
    )
    if (!hasConflict) return initial.lastRes

    yield* Effect.tryPromise({
      try: () => og.branches.delete(input.branch),
      catch: (cause) => new OmnigraphLoadError({ cause }),
    }).pipe(
      Effect.catchIf(
        (err) => err.cause instanceof NotFoundError,
        () => Effect.void,
      ),
    )

    return (yield* runChunkedLoad).lastRes
  })
