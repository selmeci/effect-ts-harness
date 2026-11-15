import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  WorkspaceFilePath,
} from "@harness/contract"
import { AstGateCache } from "@harness/gates"
import { extractWorkspaceTypeAwareGraph } from "@harness/graph"
import {
  makeAstGateCacheLayer,
  nodeSyncHostIo,
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
  ]),
  argv: Schema.optional(Schema.Array(Schema.String)),
  repoRoot: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)),
})

const decodeDaemonRequest = Schema.decodeOption(Schema.fromJsonString(DaemonRequestSchema))

export const resolveDaemonSocketPath = (repoRoot: string): string =>
  resolveHarnessDaemonSocketPath(repoRoot)

const createDaemonLineHandler =
  (
    repoRoot: string,
    daemonScope: Scope.Scope,
    cachePortsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, AstGateCachePortShape>>,
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
              const cachePath = AstGateCache.resolveCachePath(resolvedRoot)
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
              const loadedFiles = requestedRelPaths.flatMap((rel) => {
                const abs = path.resolve(resolvedRoot, rel)
                if (!nodeSyncHostIo.existsSync(abs)) return []
                return [
                  {
                    filePath: AstSourceFilePath.make(rel),
                    content: AstSourceContent.make(nodeSyncHostIo.readTextSync(abs)),
                  },
                ]
              })
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
          .exhaustive()
          .pipe(
            Effect.map((res) => JSON.stringify(res)),
            Effect.catchDefect((defect: unknown) =>
              Effect.sync(() => {
                const message = defect instanceof Error ? defect.message : "Daemon execution error"
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
        return yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
          lineHandler: createDaemonLineHandler(repoRoot, scope, cachePortsRef),
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
                  .finally(() => daemonRuntime.dispose()),
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
          daemonRuntime.dispose().then(() => Promise.reject(Cause.squash(cause))),
        onSuccess: (handle) => handle,
      }),
    )
}
