import { createHash } from "node:crypto"
import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Result, Schema, Scope, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  type GateRuleVersion,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  AST_GATE_RULE_SOURCE_FILES,
  AST_GATE_TYPESCRIPT_VERSION,
  AstGateCache,
} from "@harness/gates"
import {
  type AstGateCacheRuleSourceConfig,
  makeAstGateCacheLayer,
  nodeSyncHostIo,
  resolveAstGateCachePath,
  resolveDiskGateRuleVersion,
  type ResolvedGateRuleVersion,
} from "@harness/infra"
import { AstGateCachePort, type AstGateCachePortShape } from "@harness/service"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"

export interface CachedDaemonAstPort {
  readonly port: AstGateCachePortShape
  readonly scope: Scope.Closeable
}

export type RuleVersionConsistencyResult =
  | { readonly _tag: "Match"; readonly ruleVersion: GateRuleVersion }
  | { readonly _tag: "Mismatch"; readonly error: string }

export type GraphExtractorDigestResult =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Ready"; readonly digest: string }
  | { readonly _tag: "Unreadable"; readonly error: string }

export type ExtractorConsistencyResult =
  | { readonly _tag: "Match" }
  | { readonly _tag: "Mismatch"; readonly error: string }

const GRAPH_EXTRACTOR_REL_DIR = path.join("libs", "harness", "graph", "src")

export const computeGraphExtractorSourceDigest = (rootDir: string): GraphExtractorDigestResult => {
  const graphSrcDir = path.join(rootDir, GRAPH_EXTRACTOR_REL_DIR)
  const scanRes = Result.try({
    try: (): GraphExtractorDigestResult => {
      if (nodeSyncHostIo.isSymbolicLinkSync(graphSrcDir)) {
        return {
          _tag: "Unreadable",
          error: `Refusing symlink graph extractor directory: ${graphSrcDir}`,
        }
      }
      if (!nodeSyncHostIo.existsSync(graphSrcDir)) {
        return { _tag: "Missing" }
      }
      const files: Array<string> = []
      const walk = (absDir: string): string | undefined => {
        const entries = [...nodeSyncHostIo.readdirSync(absDir)].sort((a, b) =>
          a.name.localeCompare(b.name),
        )
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          const full = path.join(absDir, entry.name)
          if (nodeSyncHostIo.isSymbolicLinkSync(full)) {
            return `Refusing symlink in graph extractor sources: ${full}`
          }
          if (entry.isDirectory) {
            const err = walk(full)
            if (err !== undefined) return err
            continue
          }
          if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
            files.push(full)
          }
        }
        return undefined
      }
      const walkErr = walk(graphSrcDir)
      if (walkErr !== undefined) {
        return { _tag: "Unreadable", error: walkErr }
      }
      const hasher = createHash("sha256")
      for (const filePath of files.sort((a, b) => a.localeCompare(b))) {
        const rel = path.relative(graphSrcDir, filePath).replace(/\\/g, "/")
        hasher.update(`${rel}\0`)
        hasher.update(nodeSyncHostIo.readTextSync(filePath))
        hasher.update("\0")
      }
      return { _tag: "Ready", digest: hasher.digest("hex") }
    },
    catch: (err) =>
      toErrorReasonMessage(err, `Failed to hash graph extractor under ${graphSrcDir}`),
  })
  return match(scanRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Unreadable" as const, error: failure }))
    .exhaustive()
}

export const verifyWorktreeExtractorConsistency = (input: {
  readonly baseRoot: string
  readonly resolvedRoot: string
  readonly startupDigest: GraphExtractorDigestResult
}): ExtractorConsistencyResult =>
  match(input.startupDigest)
    .with({ _tag: "Unreadable" }, ({ error }) => ({ _tag: "Mismatch" as const, error }))
    .with({ _tag: "Missing" }, () => {
      const isLinked = path.resolve(input.resolvedRoot) !== path.resolve(input.baseRoot)
      if (!isLinked) return { _tag: "Match" as const }
      return match(computeGraphExtractorSourceDigest(input.resolvedRoot))
        .with({ _tag: "Missing" }, () => ({ _tag: "Match" as const }))
        .with({ _tag: "Unreadable" }, ({ error }) => ({ _tag: "Mismatch" as const, error }))
        .with({ _tag: "Ready" }, () => ({
          _tag: "Mismatch" as const,
          error:
            "Linked worktree defines graph extractor sources missing at daemon startup; refusing stale cross-worktree evaluation",
        }))
        .exhaustive()
    })
    .with({ _tag: "Ready" }, ({ digest: expectedDigest }) =>
      match(computeGraphExtractorSourceDigest(input.resolvedRoot))
        .with({ _tag: "Unreadable" }, ({ error }) => ({ _tag: "Mismatch" as const, error }))
        .with({ _tag: "Missing" }, () => ({
          _tag: "Mismatch" as const,
          error:
            "Target worktree is missing graph extractor sources present at daemon startup; refusing stale evaluation",
        }))
        .with({ _tag: "Ready" }, ({ digest: actualDigest }) =>
          actualDigest === expectedDigest
            ? { _tag: "Match" as const }
            : {
                _tag: "Mismatch" as const,
                error:
                  path.resolve(input.resolvedRoot) !== path.resolve(input.baseRoot)
                    ? "Linked worktree graph extractor version differs from daemon startup version; refusing stale cross-worktree evaluation"
                    : "Graph extractor source files changed since daemon startup; refusing stale evaluation",
              },
        )
        .exhaustive(),
    )
    .exhaustive()

export const hasRuleSourceFilesOnDisk = (rootDir: string): boolean =>
  AST_GATE_RULE_SOURCE_FILES.some((rel) => nodeSyncHostIo.existsSync(path.join(rootDir, rel)))

export const resolveDaemonRuleSourceConfig = (
  baseRoot: string,
  explicitRuleSourceRoot?: WorkspaceFilePath,
): AstGateCacheRuleSourceConfig => {
  const effectiveRuleRoot =
    explicitRuleSourceRoot !== undefined
      ? explicitRuleSourceRoot
      : hasRuleSourceFilesOnDisk(baseRoot)
        ? WorkspaceFilePath.make(baseRoot)
        : undefined
  return {
    _tag: "HashedSources",
    ruleSourceFiles: AST_GATE_RULE_SOURCE_FILES,
    compilerVersion: AST_GATE_TYPESCRIPT_VERSION,
    ...(effectiveRuleRoot !== undefined ? { ruleSourceRoot: effectiveRuleRoot } : {}),
  }
}

const evictCachePorts = (
  cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, CachedDaemonAstPort>>,
  targetCachePath?: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stalePorts = yield* SynchronizedRef.modify(
      cachePortsRef,
      (
        ports,
      ): readonly [
        ReadonlyArray<CachedDaemonAstPort>,
        ReadonlyMap<string, CachedDaemonAstPort>,
      ] => {
        if (targetCachePath === undefined) {
          return [Array.from(ports.values()), new Map<string, CachedDaemonAstPort>()]
        }
        const existing = ports.get(targetCachePath)
        if (existing === undefined) {
          return [[], ports]
        }
        const next = new Map(ports)
        next.delete(targetCachePath)
        return [[existing], next]
      },
    )
    for (const entry of stalePorts) {
      yield* Scope.close(entry.scope, Exit.void)
    }
  })

/**
 * Verifies that the requested worktree's on-disk AST gate rule / extractor sources
 * match the daemon's `startupRuleVersion`. On mismatch (including linked worktrees on
 * a different branch/revision), evicts affected cache entries and returns `Mismatch`
 * so the caller returns `{ ok: false, fallbackToInProcess: true }`.
 */
export const verifyWorktreeRuleVersionConsistency = (input: {
  readonly baseRoot: string
  readonly resolvedRoot: string
  readonly startupRuleVersion: ResolvedGateRuleVersion
  readonly ruleSourceConfig: AstGateCacheRuleSourceConfig
  readonly cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, CachedDaemonAstPort>>
}): Effect.Effect<RuleVersionConsistencyResult> =>
  Effect.gen(function* () {
    const isLinkedWorktree = path.resolve(input.resolvedRoot) !== path.resolve(input.baseRoot)
    const cachePath = resolveAstGateCachePath(input.resolvedRoot)

    if (isLinkedWorktree) {
      const baseHasSources = hasRuleSourceFilesOnDisk(input.baseRoot)
      const linkedHasSources = hasRuleSourceFilesOnDisk(input.resolvedRoot)
      if (baseHasSources && !linkedHasSources) {
        yield* evictCachePorts(input.cachePortsRef, cachePath)
        return {
          _tag: "Mismatch",
          error:
            "Linked worktree is missing AST gate rule source files present in daemon root; refusing stale cross-worktree evaluation",
        }
      }
      const explicitCheckPassed = yield* match(input.ruleSourceConfig)
        .with({ _tag: "HashedSources" }, () => Effect.succeed(true))
        .with({ _tag: "ExplicitVersion" }, () =>
          Effect.gen(function* () {
            if (!baseHasSources && !linkedHasSources) {
              return true
            }
            const baseDigest = yield* resolveDiskGateRuleVersion({
              _tag: "HashedSources",
              ruleSourceFiles: AST_GATE_RULE_SOURCE_FILES,
              compilerVersion: AST_GATE_TYPESCRIPT_VERSION,
              ruleSourceRoot: WorkspaceFilePath.make(input.baseRoot),
            })
            const linkedDigest = yield* resolveDiskGateRuleVersion({
              _tag: "HashedSources",
              ruleSourceFiles: AST_GATE_RULE_SOURCE_FILES,
              compilerVersion: AST_GATE_TYPESCRIPT_VERSION,
              ruleSourceRoot: WorkspaceFilePath.make(input.resolvedRoot),
            })
            return match(baseDigest)
              .with({ _tag: "Resolved" }, (b) =>
                match(linkedDigest)
                  .with({ _tag: "Resolved" }, (l) => b.ruleVersion === l.ruleVersion)
                  .with({ _tag: "Uncached" }, () => false)
                  .exhaustive(),
              )
              .with({ _tag: "Uncached" }, () => false)
              .exhaustive()
          }),
        )
        .exhaustive()
      if (!explicitCheckPassed) {
        yield* evictCachePorts(input.cachePortsRef, cachePath)
        return {
          _tag: "Mismatch",
          error:
            "Linked worktree rule/extractor sources differ from daemon root under ExplicitVersion; refusing stale cross-worktree evaluation",
        }
      }
    }

    const effectiveConfig: AstGateCacheRuleSourceConfig =
      isLinkedWorktree && hasRuleSourceFilesOnDisk(input.resolvedRoot)
        ? match(input.ruleSourceConfig)
            .with({ _tag: "HashedSources" }, (cfg) => ({
              ...cfg,
              ruleSourceRoot: WorkspaceFilePath.make(input.resolvedRoot),
            }))
            .with({ _tag: "ExplicitVersion" }, (cfg) => cfg)
            .exhaustive()
        : input.ruleSourceConfig

    const currentRuleVersion = yield* resolveDiskGateRuleVersion(effectiveConfig)
    const validRuleVersion = match(input.startupRuleVersion)
      .with({ _tag: "Resolved" }, (s) =>
        match(currentRuleVersion)
          .with({ _tag: "Resolved" }, (c) =>
            s.ruleVersion === c.ruleVersion ? s.ruleVersion : undefined,
          )
          .with({ _tag: "Uncached" }, () => undefined)
          .exhaustive(),
      )
      .with({ _tag: "Uncached" }, () => undefined)
      .exhaustive()

    if (validRuleVersion === undefined) {
      yield* evictCachePorts(input.cachePortsRef, isLinkedWorktree ? cachePath : undefined)
      return {
        _tag: "Mismatch",
        error: isLinkedWorktree
          ? "Linked worktree rule/extractor version differs from daemon startupRuleVersion; refusing stale cross-worktree evaluation"
          : "AST gate rule files changed since daemon startup; refusing stale cached evaluation",
      }
    }

    return { _tag: "Match", ruleVersion: validRuleVersion }
  })

export const handleDaemonAstGatesRequest = (input: {
  readonly requestId: string
  readonly baseRoot: string
  readonly resolvedRoot: string
  readonly requestedRelPaths: ReadonlyArray<string>
  readonly daemonScope: Scope.Scope
  readonly cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, CachedDaemonAstPort>>
  readonly startupRuleVersion: ResolvedGateRuleVersion
  readonly ruleSourceConfig: AstGateCacheRuleSourceConfig
}): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const cachePath = resolveAstGateCachePath(input.resolvedRoot)
    for (const rel of input.requestedRelPaths) {
      const resolvedAbs = path.resolve(input.resolvedRoot, rel)
      if (!isPathInsideRoot(input.resolvedRoot, resolvedAbs)) {
        return {
          id: input.requestId,
          ok: false,
          error: `Path traversal outside workspace root is forbidden: ${rel}`,
        }
      }
    }
    const loadedFiles: Array<{
      readonly filePath: AstSourceFilePath
      readonly content: AstSourceContent
    }> = []
    for (const rel of input.requestedRelPaths) {
      const abs = path.resolve(input.resolvedRoot, rel)
      if (!nodeSyncHostIo.existsSync(abs)) {
        return {
          id: input.requestId,
          ok: false,
          error: `AST gate target file unavailable: ${rel} (file does not exist)`,
        }
      }
      const readRes = Result.try(() => nodeSyncHostIo.readTextSync(abs))
      const textOrErr = match(readRes)
        .with({ _tag: "Success" }, ({ success }) => ({ text: success, error: undefined }))
        .with({ _tag: "Failure" }, ({ failure }) => ({
          text: undefined,
          error: `AST gate target file unavailable: ${rel} (${failure instanceof Error ? failure.message : String(failure)})`,
        }))
        .exhaustive()
      if (textOrErr.error !== undefined) {
        return { id: input.requestId, ok: false, error: textOrErr.error }
      }
      const decodedPathOpt = Schema.decodeOption(AstSourceFilePath)(rel)
      const decodedContentOpt = Schema.decodeOption(AstSourceContent)(textOrErr.text)
      const decodedEntry = match([decodedPathOpt, decodedContentOpt] as const)
        .with([{ _tag: "Some" }, { _tag: "Some" }], ([p, c]) => ({
          ok: true as const,
          filePath: p.value,
          content: c.value,
        }))
        .otherwise(() => ({
          ok: false as const,
          error: `AST gate target file exceeds bounded size or path limits: ${rel}`,
        }))
      if (!decodedEntry.ok) {
        return { id: input.requestId, ok: false, error: decodedEntry.error }
      }
      loadedFiles.push({
        filePath: decodedEntry.filePath,
        content: decodedEntry.content,
      })
    }

    const versionCheck = yield* verifyWorktreeRuleVersionConsistency({
      baseRoot: input.baseRoot,
      resolvedRoot: input.resolvedRoot,
      startupRuleVersion: input.startupRuleVersion,
      ruleSourceConfig: input.ruleSourceConfig,
      cachePortsRef: input.cachePortsRef,
    })
    const validRuleVersion = match(versionCheck)
      .with({ _tag: "Mismatch" }, ({ error }) => ({ ok: false as const, error }))
      .with({ _tag: "Match" }, ({ ruleVersion }) => ({ ok: true as const, ruleVersion }))
      .exhaustive()
    if (!validRuleVersion.ok) {
      return {
        id: input.requestId,
        ok: false,
        fallbackToInProcess: true,
        error: validRuleVersion.error,
      }
    }

    const cachePort = yield* SynchronizedRef.modifyEffect(input.cachePortsRef, (ports) => {
      const existing = ports.get(cachePath)
      if (existing !== undefined) {
        return Effect.succeed([existing.port, ports] as const)
      }
      const astGateCacheLayer = makeAstGateCacheLayer({
        cacheFilePath: WorkspaceFilePath.make(cachePath),
        ruleSource: { _tag: "ExplicitVersion", ruleVersion: validRuleVersion.ruleVersion },
      }).pipe(Layer.provide(NodeServices.layer))
      return Effect.gen(function* () {
        const portScope = yield* Scope.fork(input.daemonScope)
        return yield* Layer.buildWithScope(astGateCacheLayer, portScope).pipe(
          Effect.onError(() => Scope.close(portScope, Exit.void)),
          Effect.map((ctx) => {
            const built = Context.get(ctx, AstGateCachePort)
            const next = new Map(ports)
            next.set(cachePath, { port: built, scope: portScope })
            return [built, next] as const
          }),
        )
      })
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
      return { id: input.requestId, ok: false, error: report.error }
    }
    return { id: input.requestId, ok: true, report }
  })
