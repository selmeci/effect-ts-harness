import { join } from "node:path"
import {
  OmnigraphAuthTokensSchema,
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
import type { SyncHostIo } from "@harness/service/host-io"
import { Data, Effect, Option, Result, Schema, Stream } from "effect"
import {
  type BranchMergeOutcome,
  type ChangeBlock,
  ConflictError,
  type FetchLike,
  GoneError,
  NotFoundError,
  Omnigraph,
  PreconditionFailedError,
} from "@modernrelay/omnigraph"
import { match } from "ts-pattern"

export class OmnigraphLoadError extends Data.TaggedError("OmnigraphLoadError")<{
  readonly cause: unknown
}> {}

export interface OmnigraphConnectionOptions {
  readonly baseUrl?: string | undefined
  readonly repoRoot?: string | undefined
  readonly graphId?: string | undefined
  readonly token?: string | undefined
  readonly actor?: "harness-cli" | "agent-mcp" | undefined
  readonly fetch?: FetchLike | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

const decodeAuthTokensOption = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphAuthTokensSchema),
)

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

export const readAuthTokensFromClusterDir = (
  clusterDir: string,
  hostIo: SyncHostIo,
  actor: "harness-cli" | "agent-mcp",
): string | undefined => {
  const authPath = join(clusterDir, "auth-tokens.json")
  if (!hostIo.existsSync(authPath)) {
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

export const extractOmnigraphCommitId = (raw: unknown): OmnigraphCommitId | undefined => {
  if (typeof raw !== "string") {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  return Option.getOrUndefined(Schema.decodeOption(OmnigraphCommitId)(trimmed))
}

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
        Schema.decodeOption(OmnigraphConflictKind)(c.kind),
        Schema.decodeOption(OmnigraphEntityKind)(c.entityKind),
        Schema.decodeOption(OmnigraphTypeName)(c.typeName),
      ])
      const fieldsOrErr = match(decodedOpt)
        .with({ _tag: "Some" }, ({ value: [kind, entityKind, typeName] }) => ({
          ok: true as const,
          kind,
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
      const { kind, entityKind, typeName } = fieldsOrErr
      const entityIdRes = decodeStrictOptionalEntityId(c.entityId)
      const earlyErr = match(entityIdRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, ({ success: entityId }) => {
          conflicts.push({
            kind,
            entityKind,
            typeName,
            entityId,
            message: toErrorReasonMessage(c.message),
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
      .with({ _tag: "Success" }, ({ success: actualCommit }) =>
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

export const decodeCursorOrNull = (raw: string | null | undefined): OmnigraphChangeCursor | null => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null
  }
  return Option.getOrNull(Schema.decodeOption(OmnigraphChangeCursor)(raw.trim()))
}

export interface OmnigraphDryRunMergeInput extends OmnigraphConnectionOptions {
  readonly source: OmnigraphBranchName
  readonly target?: OmnigraphBranchName | undefined
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
  readonly branch?: OmnigraphBranchName | undefined
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
  readonly branch?: OmnigraphBranchName | undefined
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
  readonly source: OmnigraphBranchName
  readonly target?: OmnigraphBranchName | undefined
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
  readonly branch?: OmnigraphBranchName | undefined
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
    Effect.map(
      (feed): OmnigraphChangeFeedResult => ({
        blocks: feed.blocks,
        cursor: decodeCursorOrNull(feed.cursor),
        caughtUp: feed.caughtUp ?? false,
        nextPageToken: feed.nextPageToken ?? null,
        requiresBaseline: false,
      }),
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
          Stream.runFold(
            () => null as OmnigraphChangeCursor | null,
            (acc, rec) => ("baseline" in rec ? decodeCursorOrNull(rec.baseline.resumeCursor) : acc),
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
