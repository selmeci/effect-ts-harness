import * as path from "node:path"
import { Effect, Exit, Schema, Scope } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { WorkspaceFilePath } from "@harness/contract"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  HARNESS_GATE_RULE_VERSION,
} from "@harness/gates"
import { extractWorkspaceTypeAwareGraph } from "@harness/graph"
import {
  nodeSyncHostIo,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "@harness/infra"
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
  (repoRoot: string) =>
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
              const report = yield* AstGateCache.decide({
                files: loadedFiles,
                ruleVersion: HARNESS_GATE_RULE_VERSION,
                cacheFilePath: cachePath,
              })
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
): Promise<HarnessDaemonServerHandle> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const runPromise = Effect.runPromiseWith(services)
      const scope = yield* Scope.make()
      const info = yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
        lineHandler: createDaemonLineHandler(repoRoot),
      }).pipe(
        Scope.provide(scope),
        Effect.provide(UnixSocketDaemonLive),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
      return {
        socketPath: info.socketPath,
        close: () => runPromise(Scope.close(scope, Exit.void)),
      }
    }),
  )
