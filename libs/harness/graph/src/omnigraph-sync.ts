import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { type Diff, type FetchLike, Omnigraph } from "@modernrelay/omnigraph"
import {
  deriveRepoOmnigraphPort,
  resolveOmnigraphClusterDir
} from "./cluster-resolver.js"
import {
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  type HarnessGqQueryName
} from "./gq-queries.js"
import { saveGraphSnapshot, toOmnigraphNdjson } from "./graph-engine.js"
import type { HarnessGraph } from "./model.js"

const decodeJsonRecordOption = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)

export const OmnigraphClient = Omnigraph

export class OmnigraphLoadError extends Data.TaggedError("OmnigraphLoadError")<{
  readonly cause: unknown
}> {}

export interface OmnigraphSyncResult {
  readonly syncedToOmnigraph: boolean
  readonly snapshotPath: string
  readonly error?: string | undefined
}

export interface OmnigraphConnectionOptions {
  readonly baseUrl?: string | undefined
  readonly repoRoot?: string | undefined
  readonly graphId?: string | undefined
  readonly token?: string | undefined
  readonly fetch?: FetchLike | undefined
}

const OmnigraphServerMetaSchema = Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Finite),
  pid: Schema.optional(Schema.Finite),
  canonicalRepoRoot: Schema.optional(Schema.String)
})

const decodeServerMetaOption = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema)
)

export const resolveOmnigraphBaseUrl = (
  options?: OmnigraphConnectionOptions,
  env: NodeJS.ProcessEnv = process.env
): string => {
  if (options?.baseUrl !== undefined) {
    return options.baseUrl
  }
  if (env.OMNIGRAPH_URL && env.OMNIGRAPH_URL !== "http://127.0.0.1:8080") {
    return env.OMNIGRAPH_URL
  }
  if (options?.repoRoot) {
    const clusterDir = resolveOmnigraphClusterDir(options.repoRoot, env)
    const serverJsonPath = join(clusterDir, "server.json")
    if (existsSync(serverJsonPath)) {
      const metaOpt = Effect.runSync(
        Effect.try({
          try: () => readFileSync(serverJsonPath, "utf8"),
          catch: () => ""
        }).pipe(
          Effect.flatMap((raw) => Effect.fromOption(decodeServerMetaOption(raw))),
          Effect.option
        )
      )
      if (Option.isSome(metaOpt)) {
        const meta = metaOpt.value
        if (meta.baseUrl && meta.baseUrl.length > 0) {
          return meta.baseUrl
        }
      }
    }
    return `http://127.0.0.1:${deriveRepoOmnigraphPort(options.repoRoot)}`
  }
  return env.OMNIGRAPH_URL ?? "http://127.0.0.1:8080"
}

export const makeOmnigraphClient = (
  options?: OmnigraphConnectionOptions
): Omnigraph => {
  const baseUrl = resolveOmnigraphBaseUrl(options)
  const graphId =
    options?.graphId ?? process.env.OMNIGRAPH_GRAPH_ID ?? "harness"
  const token = options?.token ?? process.env.OMNIGRAPH_TOKEN

  return new Omnigraph({
    baseUrl,
    graphId,
    ...(token ? { token } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {})
  })
}

const toOmnigraphServerNdjson = (graph: HarnessGraph): string => {
  const raw = toOmnigraphNdjson(graph)
  const rawLines = raw.split("\n").filter((l) => l.trim().length > 0)
  const nodeLines: Array<string> = []
  const edgeRecords: Array<{
    readonly edge: string
    readonly from: string
    readonly to: string
    readonly data: Record<string, unknown>
  }> = []
  const nodeKeysByType = new Map<string, Set<string>>()
  const anyNodes = new Map<string, string>()

  const addNodeKey = (type: string, key: string): void => {
    let set = nodeKeysByType.get(type)
    if (!set) {
      set = new Set<string>()
      nodeKeysByType.set(type, set)
    }
    set.add(key)
  }

  for (const line of rawLines) {
    const decoded = decodeJsonRecordOption(line)
    if (Option.isNone(decoded)) continue
    const parsed = decoded.value
    if (typeof parsed.edge === "string") {
      const edgeName = parsed.edge
      const from = typeof parsed.from === "string" ? parsed.from : ""
      const to = typeof parsed.to === "string" ? parsed.to : ""
      const data =
        typeof parsed.data === "object" && parsed.data !== null
          ? { ...(parsed.data as Record<string, unknown>) }
          : {}
      edgeRecords.push({ edge: edgeName, from, to, data })
      if (edgeName === "GovernsSymbol" || edgeName === "SpecifiesSymbol") {
        const targetKind =
          typeof data.targetKind === "string" ? data.targetKind : "EffectFn"
        anyNodes.set(to, targetKind)
      }
    } else if (typeof parsed.type === "string") {
      const nodeType = parsed.type
      const data =
        typeof parsed.data === "object" && parsed.data !== null
          ? { ...(parsed.data as Record<string, unknown>) }
          : {}
      if (nodeType === "EffectFn" && data.successType === null) {
        data.successType = "unknown"
      }
      if (nodeType === "VitestCase" && data.lastTreeHash === null) {
        data.lastTreeHash = ""
      }
      const id = typeof parsed.id === "string" ? parsed.id : ""
      if (id.length > 0) {
        addNodeKey(nodeType, id)
      }
      nodeLines.push(JSON.stringify({ type: nodeType, data }))
    }
  }

  for (const [symbolKey, targetKind] of anyNodes.entries()) {
    addNodeKey("Any", symbolKey)
    nodeLines.push(
      JSON.stringify({
        type: "Any",
        data: {
          symbolKey,
          targetKind,
          archimateLayer: "Business",
          archimateAspect: "Behavior",
          archimateElementType: targetKind
        }
      })
    )
  }

  const edgeEndpoints: Readonly<Record<string, readonly [string, string]>> = {
    RequiresService: ["EffectFn", "ServiceTag"],
    FailsWith: ["EffectFn", "TaggedError"],
    ProvidesService: ["ServiceLayer", "ServiceTag"],
    LayerRequires: ["ServiceLayer", "ServiceTag"],
    TracedCall: ["EffectFn", "EffectFn"],
    ExercisesSpan: ["VitestCase", "EffectFn"],
    GovernsSymbol: ["AdrDoc", "Any"],
    SpecifiesSymbol: ["EarsSpec", "Any"]
  }

  const validEdgeLines: Array<string> = []
  const seenEdges = new Set<string>()
  for (const rec of edgeRecords) {
    const endpoints = edgeEndpoints[rec.edge]
    if (!endpoints) continue
    const [srcType, dstType] = endpoints
    const edgeKey = `${rec.edge}::${rec.from}::${rec.to}`
    if (seenEdges.has(edgeKey)) continue
    if (
      nodeKeysByType.get(srcType)?.has(rec.from) &&
      nodeKeysByType.get(dstType)?.has(rec.to)
    ) {
      seenEdges.add(edgeKey)
      validEdgeLines.push(JSON.stringify(rec))
    }
  }

  return [...nodeLines, ...validEdgeLines].join("\n")
}

export interface OmnigraphSyncShape {
  readonly sync: (
    graph: HarnessGraph,
    options?: OmnigraphConnectionOptions & {
      readonly branch?: string | undefined
      readonly snapshotPath?: string | undefined
      readonly from?: string | undefined
    }
  ) => Effect.Effect<OmnigraphSyncResult>
  readonly mergeBranch: (
    options?: OmnigraphConnectionOptions & {
      readonly source?: string | undefined
      readonly target?: string | undefined
    }
  ) => Effect.Effect<boolean>
  readonly query: (
    input: OmnigraphConnectionOptions & {
      readonly query: string
      readonly name?: string | undefined
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: string | undefined
    }
  ) => Effect.Effect<Option.Option<ReadonlyArray<Record<string, unknown>>>>
  readonly invokeNamedQuery: (
    input: OmnigraphConnectionOptions & {
      readonly name: HarnessGqQueryName
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: string | undefined
      readonly fallbackGraph?: HarnessGraph | undefined
    }
  ) => Effect.Effect<{
    readonly source: "omnigraph" | "memory-fallback"
    readonly rows: ReadonlyArray<Record<string, unknown>>
  }>
  readonly diffBranches: (
    input?: OmnigraphConnectionOptions & {
      readonly source?: string | undefined
      readonly target?: string | undefined
    }
  ) => Effect.Effect<Option.Option<Diff>>
}

export class OmnigraphSync extends Context.Service<OmnigraphSync, OmnigraphSyncShape>()(
  "@harness/graph/OmnigraphSync"
) {
  static readonly Live: Layer.Layer<OmnigraphSync> = Layer.succeed(
    OmnigraphSync,
    OmnigraphSync.of({
      sync: (graph, options) =>
        Effect.gen(function* () {
          const snapshotPath =
            options?.snapshotPath ?? ".harness/graph-snapshot.json"
          saveGraphSnapshot(graph, snapshotPath)

          const branch = options?.branch ?? "main"
          const og = makeOmnigraphClient(options)
          const ndjson = toOmnigraphServerNdjson(graph)

          if (ndjson.trim().length === 0) {
            const branchReady = yield* Effect.gen(function* () {
              if (branch === "main") {
                yield* Effect.tryPromise({
                  try: () => og.health(),
                  catch: (cause) => new OmnigraphLoadError({ cause })
                })
                return true
              }
              const branches = yield* Effect.tryPromise({
                try: () => og.branches.list(),
                catch: (cause) => new OmnigraphLoadError({ cause })
              })
              if (!branches.includes(branch)) {
                yield* Effect.tryPromise({
                  try: () =>
                    og.branches.create({
                      name: branch,
                      from: options?.from ?? "main"
                    }),
                  catch: (cause) => new OmnigraphLoadError({ cause })
                })
              }
              return true
            }).pipe(Effect.orElseSucceed(() => false))

            return {
              syncedToOmnigraph: branchReady,
              snapshotPath
            }
          }

          return yield* Effect.tryPromise({
            try: () =>
              og.load({
                branch,
                ...(branch !== "main" ? { from: options?.from ?? "main" } : {}),
                mode: "merge",
                data: ndjson
              }),
            catch: (cause) => new OmnigraphLoadError({ cause })
          }).pipe(
            Effect.map(() => ({
              syncedToOmnigraph: true,
              snapshotPath
            })),
            Effect.catch((err) =>
              Effect.succeed({
                syncedToOmnigraph: false,
                snapshotPath,
                error:
                  err.cause instanceof Error
                    ? err.cause.message
                    : String(err.cause)
              })
            )
          )
        }),

      mergeBranch: (options) =>
        Effect.gen(function* () {
          const source = options?.source ?? "impl/current"
          const target = options?.target ?? "main"
          const og = makeOmnigraphClient(options)

          return yield* Effect.gen(function* () {
            const branches = yield* Effect.tryPromise({
              try: () => og.branches.list(),
              catch: (cause) => new OmnigraphLoadError({ cause })
            })
            if (!branches.includes(source)) {
              yield* Effect.tryPromise({
                try: () => og.branches.create({ name: source, from: target }),
                catch: (cause) => new OmnigraphLoadError({ cause })
              })
            }
            yield* Effect.tryPromise({
              try: () => og.branches.merge({ source, target }),
              catch: (cause) => new OmnigraphLoadError({ cause })
            })
            return true
          }).pipe(Effect.orElseSucceed(() => false))
        }),

      query: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input)
          return yield* Effect.tryPromise({
            try: () =>
              og.query({
                query: input.query,
                ...(input.name ? { name: input.name } : {}),
                ...(input.params ? { params: input.params } : {}),
                branch: input.branch ?? "main"
              }),
            catch: (cause) => new OmnigraphLoadError({ cause })
          }).pipe(
            Effect.map((res) =>
              Array.isArray(res.rows)
                ? Option.some(res.rows as ReadonlyArray<Record<string, unknown>>)
                : Option.none()
            ),
            Effect.orElseSucceed(() => Option.none())
          )
        }),

      invokeNamedQuery: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input)
          const branch = input.branch ?? "main"

          const invokeAttempt = yield* Effect.tryPromise({
            try: () =>
              og.queries.invoke(input.name, {
                ...(input.params ? { params: input.params } : {}),
                branch,
                expectMutation: false
              }),
            catch: (cause) => new OmnigraphLoadError({ cause })
          }).pipe(
            Effect.map((res) => {
              if (
                res &&
                typeof res === "object" &&
                "rows" in res &&
                Array.isArray((res as { rows: unknown }).rows)
              ) {
                return Option.some(
                  (res as { rows: ReadonlyArray<Record<string, unknown>> }).rows
                )
              }
              return Option.none<ReadonlyArray<Record<string, unknown>>>()
            }),
            Effect.orElseSucceed(() =>
              Option.none<ReadonlyArray<Record<string, unknown>>>()
            )
          )

          if (Option.isSome(invokeAttempt)) {
            return {
              source: "omnigraph" as const,
              rows: invokeAttempt.value
            }
          }

          const queryDescriptor = HARNESS_GQ_QUERIES[input.name]
          const queryAttempt = yield* Effect.tryPromise({
            try: () =>
              og.query({
                query: queryDescriptor.source,
                name: input.name,
                ...(input.params ? { params: input.params } : {}),
                branch
              }),
            catch: (cause) => new OmnigraphLoadError({ cause })
          }).pipe(
            Effect.map((res) => {
              if (
                res &&
                typeof res === "object" &&
                "rows" in res &&
                Array.isArray((res as { rows: unknown }).rows)
              ) {
                return Option.some(
                  (res as { rows: ReadonlyArray<Record<string, unknown>> }).rows
                )
              }
              return Option.none<ReadonlyArray<Record<string, unknown>>>()
            }),
            Effect.orElseSucceed(() =>
              Option.none<ReadonlyArray<Record<string, unknown>>>()
            )
          )

          if (Option.isSome(queryAttempt)) {
            return {
              source: "omnigraph" as const,
              rows: queryAttempt.value
            }
          }

          const fallbackRows = input.fallbackGraph
            ? executeNamedGqQueryInMemory(
                input.fallbackGraph,
                input.name,
                input.params
              )
            : []

          return {
            source: "memory-fallback" as const,
            rows: fallbackRows
          }
        }),

      diffBranches: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input)
          const source = input?.source ?? "impl/current"
          const target = input?.target ?? "plan/current"

          return yield* Effect.tryPromise({
            try: () => og.branches.diff({ source, target }),
            catch: (cause) => new OmnigraphLoadError({ cause })
          }).pipe(
            Effect.asSome,
            Effect.orElseSucceed(() => Option.none())
          )
        })
    })
  )
}

export const syncToOmnigraphAndSnapshot = (
  graph: HarnessGraph,
  options?: OmnigraphConnectionOptions & {
    readonly branch?: string | undefined
    readonly snapshotPath?: string | undefined
    readonly from?: string | undefined
  }
): Effect.Effect<OmnigraphSyncResult, never, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.sync(graph, options))

export const mergeOmnigraphBranch = (
  options?: OmnigraphConnectionOptions & {
    readonly source?: string | undefined
    readonly target?: string | undefined
  }
): Effect.Effect<boolean, never, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.mergeBranch(options))

export const queryOmnigraph = (
  input: OmnigraphConnectionOptions & {
    readonly query: string
    readonly name?: string | undefined
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: string | undefined
  }
): Effect.Effect<
  Option.Option<ReadonlyArray<Record<string, unknown>>>,
  never,
  OmnigraphSync
> => Effect.flatMap(OmnigraphSync, (service) => service.query(input))

export const invokeOmnigraphNamedQuery = (
  input: OmnigraphConnectionOptions & {
    readonly name: HarnessGqQueryName
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: string | undefined
    readonly fallbackGraph?: HarnessGraph | undefined
  }
): Effect.Effect<
  {
    readonly source: "omnigraph" | "memory-fallback"
    readonly rows: ReadonlyArray<Record<string, unknown>>
  },
  never,
  OmnigraphSync
> => Effect.flatMap(OmnigraphSync, (service) => service.invokeNamedQuery(input))

export const diffOmnigraphBranches = (
  input?: OmnigraphConnectionOptions & {
    readonly source?: string | undefined
    readonly target?: string | undefined
  }
): Effect.Effect<Option.Option<Diff>, never, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.diffBranches(input))
