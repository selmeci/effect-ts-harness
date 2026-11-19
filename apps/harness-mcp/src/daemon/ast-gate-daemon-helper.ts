import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Result, Scope, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import { AstSourceContent, AstSourceFilePath, WorkspaceFilePath } from "@harness/contract"
import { AstGateCache } from "@harness/gates"
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

export const handleDaemonAstGatesRequest = (input: {
  readonly requestId: string
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
      loadedFiles.push({
        filePath: AstSourceFilePath.make(rel),
        content: AstSourceContent.make(textOrErr.text),
      })
    }

    const currentRuleVersion = yield* resolveDiskGateRuleVersion(input.ruleSourceConfig)
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
      const stalePorts = yield* SynchronizedRef.modify(input.cachePortsRef, (ports) => [
        Array.from(ports.values()),
        new Map<string, CachedDaemonAstPort>(),
      ])
      for (const entry of stalePorts) {
        yield* Scope.close(entry.scope, Exit.void)
      }
      return {
        id: input.requestId,
        ok: false,
        fallbackToInProcess: true,
        error: "AST gate rule files changed since daemon startup; refusing stale cached evaluation",
      }
    }

    const cachePort = yield* SynchronizedRef.modifyEffect(input.cachePortsRef, (ports) => {
      const existing = ports.get(cachePath)
      if (existing !== undefined) {
        return Effect.succeed([existing.port, ports] as const)
      }
      const astGateCacheLayer = makeAstGateCacheLayer({
        cacheFilePath: WorkspaceFilePath.make(cachePath),
        ruleSource: { _tag: "ExplicitVersion", ruleVersion: validRuleVersion },
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
