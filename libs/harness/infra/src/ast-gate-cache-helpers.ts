import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, FileSystem, Path, Result, Schema } from "effect"
import { match, P } from "ts-pattern"
import {
  type AstGateCacheRuleSourceConfig,
  AstSourceContent,
  computeGateRuleVersionFromSources,
  ErrorReasonMessage,
  type GateRuleSourceSnapshot,
  GateRuleVersion,
  PersistedAstCacheEntry,
  PersistedAstCacheKey,
  PersistedAstCacheStore,
  type ResolvedGateRuleVersion,
  selectActivePersistedAstCacheEntries,
  WorkspaceFilePath,
  type WorkspaceFsError,
} from "@harness/contract"

export type { AstGateCacheRuleSourceConfig, ResolvedGateRuleVersion }

const RawPersistedEnvelopeSchema = Schema.Struct({
  version: Schema.NonEmptyString,
  entries: Schema.Record(Schema.String, Schema.Unknown),
})

const decodeRawEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RawPersistedEnvelopeSchema),
)
const decodePersistedKeyOpt = Schema.decodeUnknownOption(PersistedAstCacheKey)
const decodePersistedEntryOpt = Schema.decodeUnknownOption(PersistedAstCacheEntry)
export const encodePersistedStoreJson = Schema.encodeSync(
  Schema.fromJsonString(PersistedAstCacheStore),
)

interface SnapshotFailure {
  readonly relPath: WorkspaceFilePath
  readonly reason: ErrorReasonMessage
}

type SnapshotReadResult = Result.Result<GateRuleSourceSnapshot, SnapshotFailure>

const resolveDefaultGateRuleSourceRoot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<WorkspaceFilePath, never> =>
  Effect.gen(function* () {
    const startDir = dirname(fileURLToPath(import.meta.url))
    let currentDir = startDir
    while (true) {
      const marker = path.join(currentDir, "pnpm-workspace.yaml")
      const existsRes = yield* fs
        .exists(marker)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))
      if (existsRes) {
        return WorkspaceFilePath.make(currentDir)
      }
      const parent = path.dirname(currentDir)
      if (parent === currentDir) {
        return WorkspaceFilePath.make(resolve(startDir, "../../../.."))
      }
      currentDir = parent
    }
  })

const readRuleSourceSnapshot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: WorkspaceFilePath,
  relPath: WorkspaceFilePath,
): Effect.Effect<SnapshotReadResult, never> =>
  Effect.gen(function* () {
    const absPath = path.join(rootDir, relPath)
    const linkExit = yield* fs.readLink(absPath).pipe(Effect.exit)
    return yield* match(linkExit)
      .with({ _tag: "Success" }, () =>
        Effect.succeed<SnapshotReadResult>(
          Result.fail({
            relPath,
            reason: ErrorReasonMessage.make(`Refusing symlink AST gate rule file '${absPath}'`),
          }),
        ),
      )
      .with({ _tag: "Failure" }, () =>
        fs.readFileString(absPath).pipe(
          Effect.exit,
          Effect.map((readExit): SnapshotReadResult =>
            match(readExit)
              .with({ _tag: "Failure" }, ({ cause }) =>
                Result.fail({
                  relPath,
                  reason: ErrorReasonMessage.make(
                    Cause.pretty(cause).split("\n")[0] ?? "read failed",
                  ),
                }),
              )
              .with({ _tag: "Success" }, ({ value }) =>
                Result.succeed({
                  filePath: relPath,
                  content: AstSourceContent.make(value),
                }),
              )
              .exhaustive(),
          ),
        ),
      )
      .exhaustive()
  })

/**
 * Resolves the active `GateRuleVersion` from either an explicit version or by
 * hashing disk rule-source files using the supplied `FileSystem` and `Path`
 * (rejecting symlinks and failing closed on empty lists).
 */
export const resolveDiskGateRuleVersionWithPlatform = Effect.fn(
  "AstGateCache.resolveDiskRuleVersionWithPlatform",
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: AstGateCacheRuleSourceConfig,
): Effect.fn.Return<ResolvedGateRuleVersion> {
  return yield* match(config)
    .with({ _tag: "ExplicitVersion" }, ({ ruleVersion }) =>
      Effect.succeed<ResolvedGateRuleVersion>({ _tag: "Resolved", ruleVersion }),
    )
    .with({ _tag: "HashedSources" }, ({ ruleSourceFiles, ruleSourceRoot, compilerVersion }) =>
      Effect.gen(function* () {
        const rootDir =
          ruleSourceRoot !== undefined
            ? ruleSourceRoot
            : yield* resolveDefaultGateRuleSourceRoot(fs, path)
        const readResults = yield* Effect.forEach(
          ruleSourceFiles,
          (relPath) => readRuleSourceSnapshot(fs, path, rootDir, relPath),
          { concurrency: "unbounded" },
        )

        const snapshots: Array<GateRuleSourceSnapshot> = []
        let firstFailure: SnapshotFailure | undefined
        for (const res of readResults) {
          match(res)
            .with({ _tag: "Failure" }, ({ failure }) => {
              firstFailure ??= failure
            })
            .with({ _tag: "Success" }, ({ success }) => {
              snapshots.push(success)
            })
            .exhaustive()
        }
        if (firstFailure !== undefined) {
          yield* Effect.logWarning(
            `Failed to hash AST gate rule file '${firstFailure.relPath}' under root '${rootDir}' (${firstFailure.reason}); bypassing persistent AST gate cache (evaluating without cache)`,
          )
          return {
            _tag: "Uncached" as const,
            reason: firstFailure.reason,
            rootDir,
            failedFile: firstFailure.relPath,
          }
        }

        return yield* match(computeGateRuleVersionFromSources(snapshots, compilerVersion))
          .with({ _tag: "Success" }, ({ success: ruleVersion }) =>
            Effect.succeed<ResolvedGateRuleVersion>({ _tag: "Resolved", ruleVersion }),
          )
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.logWarning(
              `Failed to compute AST gate rule digest under root '${rootDir}' (${failure}); bypassing persistent AST gate cache (evaluating without cache)`,
            ).pipe(
              Effect.as<ResolvedGateRuleVersion>({
                _tag: "Uncached",
                reason: failure,
                rootDir,
              }),
            ),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})

/**
 * Resolves the active `GateRuleVersion` against live `NodeServices.layer`
 * from either an explicit version or by hashing disk rule-source files.
 */
export const resolveDiskGateRuleVersion = Effect.fn("AstGateCache.resolveDiskRuleVersion")(
  function* (config: AstGateCacheRuleSourceConfig): Effect.fn.Return<ResolvedGateRuleVersion> {
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return yield* resolveDiskGateRuleVersionWithPlatform(fs, path, config)
    }).pipe(Effect.provide(NodeServices.layer))
  },
)

/**
 * Verifies whether `filePath` exists and is not a symlink; fails with `toErr`
 * when `filePath` is a symlink or `stat` fails with an unexpected `PlatformError`.
 */
export const checkNonSymlinkCachePath = Effect.fn("AstGateCache.checkNonSymlinkCachePath")(
  function* (
    fs: FileSystem.FileSystem,
    filePath: WorkspaceFilePath,
    toErr: (p: WorkspaceFilePath, err: unknown, msg?: string) => WorkspaceFsError,
  ): Effect.fn.Return<boolean, WorkspaceFsError> {
    const linkExit = yield* fs.readLink(filePath).pipe(Effect.exit)
    return yield* match(linkExit)
      .with({ _tag: "Success" }, () =>
        Effect.fail(
          toErr(filePath, new Error(`Refusing symlink AST gate cache file '${filePath}'`)),
        ),
      )
      .with({ _tag: "Failure" }, () =>
        fs.stat(filePath).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (err) =>
            match(err.reason)
              .with({ _tag: "NotFound" }, () => Effect.succeed(false))
              .with({ _tag: P.not("NotFound") }, () => Effect.fail(toErr(filePath, err)))
              .exhaustive(),
          ),
        ),
      )
      .exhaustive()
  },
)

const filterValidatedEntries = (
  rawEntries: Readonly<Record<string, unknown>>,
  activeRuleVersion: GateRuleVersion,
): {
  readonly activeEntries: ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>
  readonly evictedCount: number
} => {
  const validatedEntries: Record<string, PersistedAstCacheEntry> = Object.create(null)
  let totalRaw = 0
  let validCount = 0
  for (const [rawKey, rawEntry] of Object.entries(rawEntries)) {
    totalRaw += 1
    const keyOpt = decodePersistedKeyOpt(rawKey)
    const entryOpt = decodePersistedEntryOpt(rawEntry)
    match([keyOpt, entryOpt] as const)
      .with([{ _tag: "Some" }, { _tag: "Some" }], ([k, e]) => {
        validatedEntries[k.value] = e.value
        validCount += 1
      })
      .with([{ _tag: "None" }, P._], [P._, { _tag: "None" }], () => undefined)
      .exhaustive()
  }
  const activeEntries = selectActivePersistedAstCacheEntries(
    { version: activeRuleVersion, entries: validatedEntries },
    activeRuleVersion,
  )
  const evictedCount = totalRaw - validCount + (validCount - activeEntries.size)
  return { activeEntries, evictedCount }
}

/**
 * Decodes a raw JSON persisted AST cache string against `activeRuleVersion`
 * using envelope-first validation so version upgrades reset without corrupt warnings.
 */
export const decodeStoreForActiveVersion = Effect.fn("AstGateCache.decodeStoreForActiveVersion")(
  function* (
    raw: string,
    activeRuleVersion: GateRuleVersion,
    filePath: WorkspaceFilePath,
  ): Effect.fn.Return<ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>> {
    const envelopeExit = yield* decodeRawEnvelope(raw).pipe(Effect.exit)
    return yield* match(envelopeExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        const reason = Cause.pretty(cause).split("\n")[0] ?? "invalid JSON or schema"
        return Effect.logWarning(
          `Corrupt AST gate cache at '${filePath}' (${reason}); resetting to empty store`,
        ).pipe(Effect.as(new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()))
      })
      .with({ _tag: "Success" }, ({ value: envelope }) =>
        Effect.gen(function* () {
          if (envelope.version !== activeRuleVersion) {
            yield* Effect.logInfo(
              `Resetting AST gate cache at '${filePath}' from rule version '${envelope.version}' to '${activeRuleVersion}'`,
            )
            return new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
          }
          const { activeEntries, evictedCount } = filterValidatedEntries(
            envelope.entries,
            activeRuleVersion,
          )
          if (evictedCount > 0) {
            yield* Effect.logInfo(
              `Evicted ${evictedCount} stale or invalid AST gate cache entry(ies) from '${filePath}' for rule version '${activeRuleVersion}'`,
            )
          }
          return activeEntries
        }),
      )
      .exhaustive()
  },
)

/**
 * Reads active persisted cache entries from disk for read-before-write merge
 * during `persistEntries`. Returns an empty map on missing, corrupt, or version-mismatched stores.
 */
export const readActiveEntriesForMerge = Effect.fn("AstGateCache.readActiveEntriesForMerge")(
  function* (
    fs: FileSystem.FileSystem,
    filePath: WorkspaceFilePath,
    activeRuleVersion: GateRuleVersion,
  ): Effect.fn.Return<ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>> {
    const diskRawOpt = yield* fs.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )
    return yield* match(diskRawOpt)
      .with({ _tag: "None" }, () =>
        Effect.succeed<ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry>>(new Map()),
      )
      .with({ _tag: "Some" }, ({ value: raw }) =>
        decodeRawEnvelope(raw).pipe(
          Effect.exit,
          Effect.map((diskEnvelopeExit) =>
            match(diskEnvelopeExit)
              .with(
                { _tag: "Failure" },
                () => new Map<PersistedAstCacheKey, PersistedAstCacheEntry>(),
              )
              .with({ _tag: "Success" }, ({ value: envelope }) =>
                envelope.version === activeRuleVersion
                  ? filterValidatedEntries(envelope.entries, activeRuleVersion).activeEntries
                  : new Map<PersistedAstCacheKey, PersistedAstCacheEntry>(),
              )
              .exhaustive(),
          ),
        ),
      )
      .exhaustive()
  },
)
