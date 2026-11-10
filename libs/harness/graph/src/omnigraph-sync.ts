import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { type Diff, type FetchLike, Omnigraph } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import { classifyOntologyEdge, classifyOntologyNode } from "./archimate-ontology.js"
import {
  deriveRepoOmnigraphPort,
  resolveOmnigraphClusterDir,
  writeGraphHeadMeta,
} from "./cluster-resolver.js"
import {
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  type HarnessGqQueryName,
} from "./gq-queries.js"
import {
  findTestsReaching,
  loadGraphSnapshotEffect,
  mapPlaysRoleToOmnigraphEdgeName,
  saveGraphSnapshot,
} from "./graph-engine.js"
import { getNodeKey, type HarnessGraph, type HarnessNode, type VitestCaseNode } from "./model.js"

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
  canonicalRepoRoot: Schema.optional(Schema.String),
})

const decodeServerMetaOption = Schema.decodeOption(Schema.fromJsonString(OmnigraphServerMetaSchema))

export const resolveOmnigraphBaseUrl = (
  options?: OmnigraphConnectionOptions,
  env: NodeJS.ProcessEnv = process.env,
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
          catch: () => "",
        }).pipe(
          Effect.flatMap((raw) => Effect.fromOption(decodeServerMetaOption(raw))),
          Effect.option,
        ),
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

export const makeOmnigraphClient = (options?: OmnigraphConnectionOptions): Omnigraph => {
  const baseUrl = resolveOmnigraphBaseUrl(options)
  const graphId = options?.graphId ?? process.env.OMNIGRAPH_GRAPH_ID ?? "harness"
  const token = options?.token ?? process.env.OMNIGRAPH_TOKEN

  return new Omnigraph({
    baseUrl,
    graphId,
    ...(token ? { token } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  })
}

export const omnigraphReachableTests = (
  graph: HarnessGraph,
  targetOrSpan: string,
): ReadonlyArray<VitestCaseNode> => findTestsReaching(graph, targetOrSpan)

const toOmnigraphServerNdjson = (graph: HarnessGraph): string => {
  const nodeLines: Array<string> = []
  const nodeMetaByKey = new Map<
    string,
    { readonly tag: HarnessNode["_tag"]; readonly id: string }
  >()

  for (const [, node] of Graph.nodes(graph.graph)) {
    const key = getNodeKey(node)
    const classified = classifyOntologyNode(node)
    const archimateFields = {
      archimateLayer: classified.layer,
      archimateAspect: classified.aspect,
      archimateElementType: classified.elementType,
    }

    match(node)
      .with({ _tag: "EffectFn" }, (n) => {
        if (!n.qualname) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.qualname })
        nodeLines.push(
          JSON.stringify({
            type: "EffectFn",
            data: {
              qualname: n.qualname,
              spanName: n.spanName,
              packageTag: n.packageTag,
              file: n.file,
              line: n.line,
              successType: n.successType ?? "unknown",
              isStub: n.isStub ?? false,
              ...(n.payloadSchemas ? { payloadSchemas: n.payloadSchemas } : {}),
              ...(n.inputSchema ? { inputSchema: n.inputSchema } : {}),
              ...(n.outputSchema ? { outputSchema: n.outputSchema } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "ServiceTag" }, (n) => {
        if (!n.tagId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.tagId })
        nodeLines.push(
          JSON.stringify({
            type: "ServiceTag",
            data: {
              tagId: n.tagId,
              qualname: n.qualname ?? n.tagId,
              name: n.name,
              ...(n.identifier ? { identifier: n.identifier } : {}),
              ...(n.packageTag ? { packageTag: n.packageTag } : {}),
              file: n.file,
              ...(n.line !== undefined ? { line: n.line } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "ServiceLayer" }, (n) => {
        if (!n.qualname) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.qualname })
        nodeLines.push(
          JSON.stringify({
            type: "ServiceLayer",
            data: {
              qualname: n.qualname,
              ...(n.layerKind ? { layerKind: n.layerKind } : {}),
              ...(n.packageTag ? { packageTag: n.packageTag } : {}),
              file: n.file,
              ...(n.line !== undefined ? { line: n.line } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "TaggedError" }, (n) => {
        if (!n.errorTag) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.errorTag })
        nodeLines.push(
          JSON.stringify({
            type: "TaggedError",
            data: {
              errorTag: n.errorTag,
              qualname: n.qualname ?? n.errorTag,
              ...(n.tag ? { tag: n.tag } : {}),
              file: n.file,
              ...(n.line !== undefined ? { line: n.line } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "SchemaDef" }, (n) => {
        if (!n.schemaName) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.schemaName })
        nodeLines.push(
          JSON.stringify({
            type: "SchemaDef",
            data: {
              schemaName: n.schemaName,
              qualname: n.qualname ?? n.schemaName,
              name: n.name ?? n.schemaName,
              ...(n.packageTag ? { packageTag: n.packageTag } : {}),
              file: n.file,
              ...(n.line !== undefined ? { line: n.line } : {}),
              ...(n.isBranded !== undefined ? { isBranded: n.isBranded } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "VitestCase" }, (n) => {
        if (!n.testId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.testId })
        nodeLines.push(
          JSON.stringify({
            type: "VitestCase",
            data: {
              testId: n.testId,
              qualname: n.qualname ?? n.testId,
              testFile: n.testFile,
              testName: n.testName,
              ...(n.name ? { name: n.name } : {}),
              ...(n.file ? { file: n.file } : {}),
              ...(n.line !== undefined ? { line: n.line } : {}),
              lastTreeHash: n.lastTreeHash ?? "",
              isPropertyTest: n.isPropertyTest ?? false,
              ...(n.hasNonPrimitiveArbitrary !== undefined
                ? { hasNonPrimitiveArbitrary: n.hasNonPrimitiveArbitrary }
                : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "PatternDoc" }, (n) => {
        if (!n.slug) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.slug })
        nodeLines.push(
          JSON.stringify({
            type: "PatternDoc",
            data: {
              slug: n.slug,
              qualname: n.slug,
              path: n.path,
              summary: n.summary,
              ...(n.title ? { title: n.title } : {}),
              ...(n.coveredSpans ? { coveredSpans: n.coveredSpans } : {}),
              ...(n.coveredTags ? { coveredTags: n.coveredTags } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "AdrDoc" }, (n) => {
        if (!n.id) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.id })
        nodeLines.push(
          JSON.stringify({
            type: "AdrDoc",
            data: {
              id: n.id,
              qualname: n.id,
              title: n.title,
              status: n.status,
              ...(n.date ? { date: n.date } : {}),
              path: n.path,
              enforcedByFiles: n.enforcedByFiles,
              ...(n.referencedSpans ? { referencedSpans: n.referencedSpans } : {}),
              ...(n.referencedServices ? { referencedServices: n.referencedServices } : {}),
              ...(n.referencedErrors ? { referencedErrors: n.referencedErrors } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "EarsSpec" }, (n) => {
        if (!n.id) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.id })
        nodeLines.push(
          JSON.stringify({
            type: "EarsSpec",
            data: {
              id: n.id,
              qualname: n.id,
              title: n.title,
              status: n.status,
              ...(n.date ? { date: n.date } : {}),
              path: n.path,
              enforcedByFiles: n.enforcedByFiles,
              ...(n.informedByAdrs ? { informedByAdrs: n.informedByAdrs } : {}),
              ...(n.referencedSpans ? { referencedSpans: n.referencedSpans } : {}),
              ...(n.referencedServices ? { referencedServices: n.referencedServices } : {}),
              ...(n.referencedErrors ? { referencedErrors: n.referencedErrors } : {}),
              ...archimateFields,
            },
          }),
        )
      })
      .with({ _tag: "EffectSignature" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        nodeLines.push(
          JSON.stringify({
            type: "EffectSignature",
            data: {
              relationId: n.relationId,
              qualname: n.relationId,
              callerQualname: n.callerQualname,
              file: n.file,
              line: n.line,
            },
          }),
        )
      })
      .with({ _tag: "LayerFlow" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        nodeLines.push(
          JSON.stringify({
            type: "LayerFlow",
            data: {
              relationId: n.relationId,
              qualname: n.relationId,
              layerQualname: n.layerQualname,
              file: n.file,
              line: n.line,
            },
          }),
        )
      })
      .with({ _tag: "TraceabilityTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        nodeLines.push(
          JSON.stringify({
            type: "TraceabilityTuple",
            data: {
              relationId: n.relationId,
              qualname: n.relationId,
              ...(n.adrId ? { adrId: n.adrId } : {}),
              ...(n.earsSpecId ? { earsSpecId: n.earsSpecId } : {}),
              ...(n.requirementId ? { requirementId: n.requirementId } : {}),
              ...(n.earsPattern ? { earsPattern: n.earsPattern } : {}),
              targetSymbolQualname: n.targetSymbolQualname,
            },
          }),
        )
      })
      .with({ _tag: "HttpEndpointTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        nodeLines.push(
          JSON.stringify({
            type: "HttpEndpointTuple",
            data: {
              relationId: n.relationId,
              qualname: n.relationId,
              endpointGroup: n.endpointGroup,
              endpointName: n.endpointName,
              method: n.method,
              path: n.path,
              ...(n.handlerQualname ? { handlerQualname: n.handlerQualname } : {}),
              file: n.file,
              line: n.line,
            },
          }),
        )
      })
      .with({ _tag: "MigrationTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        nodeLines.push(
          JSON.stringify({
            type: "MigrationTuple",
            data: {
              relationId: n.relationId,
              qualname: n.relationId,
              migrationId: n.migrationId,
              engine: n.engine,
              moduleFile: n.moduleFile,
              isDestructive: n.isDestructive,
              line: n.line,
            },
          }),
        )
      })
      .exhaustive()
  }

  const validEdgeLines: Array<string> = []
  const seenEdges = new Set<string>()

  for (const [, edge] of Graph.edges(graph.graph)) {
    const srcOpt = Graph.getNode(graph.graph, edge.source)
    const dstOpt = Graph.getNode(graph.graph, edge.target)
    if (Option.isNone(srcOpt) || Option.isNone(dstOpt)) continue
    const srcMeta = nodeMetaByKey.get(getNodeKey(srcOpt.value))
    const dstMeta = nodeMetaByKey.get(getNodeKey(dstOpt.value))
    if (!srcMeta || !dstMeta) continue

    const omnigraphEdgeName = mapPlaysRoleToOmnigraphEdgeName(
      srcMeta.tag,
      dstMeta.tag,
      edge.data.role,
    )
    if (!omnigraphEdgeName) {
      // oxlint-disable-next-line -- synchronous serializer boundary
      throw new Error(
        `Unmappable role '${edge.data.role}' from ${srcMeta.tag} to ${dstMeta.tag} in toOmnigraphServerNdjson`,
      )
    }

    const dedupKey = `${omnigraphEdgeName}::${srcMeta.id}::${dstMeta.id}::${edge.data.role}`
    if (seenEdges.has(dedupKey)) continue
    seenEdges.add(dedupKey)

    const archimateRelation = classifyOntologyEdge(edge.data)
    validEdgeLines.push(
      JSON.stringify({
        edge: omnigraphEdgeName,
        from: srcMeta.id,
        to: dstMeta.id,
        data: {
          role: edge.data.role,
          archimateRelation,
          ...(edge.data.callCount !== undefined ? { callCount: edge.data.callCount } : {}),
          ...(edge.data.receiverLayer !== undefined && edge.data.receiverLayer !== null
            ? { receiverLayer: edge.data.receiverLayer }
            : {}),
        },
      }),
    )
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
    },
  ) => Effect.Effect<OmnigraphSyncResult>
  readonly mergeBranch: (
    options?: OmnigraphConnectionOptions & {
      readonly source?: string | undefined
      readonly target?: string | undefined
      readonly cleanupBranches?: ReadonlyArray<string> | undefined
    },
  ) => Effect.Effect<boolean>
  readonly query: (
    input: OmnigraphConnectionOptions & {
      readonly query: string
      readonly name?: string | undefined
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: string | undefined
    },
  ) => Effect.Effect<Option.Option<ReadonlyArray<Record<string, unknown>>>>
  readonly invokeNamedQuery: (
    input: OmnigraphConnectionOptions & {
      readonly name: HarnessGqQueryName
      readonly params?: Readonly<Record<string, unknown>> | undefined
      readonly branch?: string | undefined
      readonly fallbackGraph?: HarnessGraph | undefined
    },
  ) => Effect.Effect<{
    readonly source: "omnigraph" | "memory-fallback"
    readonly rows: ReadonlyArray<Record<string, unknown>>
  }>
  readonly diffBranches: (
    input?: OmnigraphConnectionOptions & {
      readonly source?: string | undefined
      readonly target?: string | undefined
    },
  ) => Effect.Effect<Option.Option<Diff>>
}

export class OmnigraphSync extends Context.Service<OmnigraphSync, OmnigraphSyncShape>()(
  "@harness/graph/OmnigraphSync",
) {
  static readonly Live: Layer.Layer<OmnigraphSync> = Layer.succeed(
    OmnigraphSync,
    OmnigraphSync.of({
      sync: (graph, options) =>
        Effect.gen(function* () {
          const snapshotPath = options?.snapshotPath ?? ".harness/graph-snapshot.json"
          saveGraphSnapshot(graph, snapshotPath)
          if (options?.repoRoot && !snapshotPath.endsWith("plan-graph-snapshot.json")) {
            writeGraphHeadMeta(options.repoRoot)
          }

          const branch = options?.branch ?? "main"
          const og = makeOmnigraphClient(options)
          const ndjson = toOmnigraphServerNdjson(graph)

          if (ndjson.trim().length === 0) {
            const branchReady = yield* Effect.gen(function* () {
              if (branch === "main") {
                yield* Effect.tryPromise({
                  try: () => og.health(),
                  catch: (cause) => new OmnigraphLoadError({ cause }),
                })
                return true
              }
              const branches = yield* Effect.tryPromise({
                try: () => og.branches.list(),
                catch: (cause) => new OmnigraphLoadError({ cause }),
              })
              if (!branches.includes(branch)) {
                yield* Effect.tryPromise({
                  try: () =>
                    og.branches.create({
                      name: branch,
                      from: options?.from ?? "main",
                    }),
                  catch: (cause) => new OmnigraphLoadError({ cause }),
                })
              }
              return true
            }).pipe(Effect.orElseSucceed(() => false))

            return {
              syncedToOmnigraph: branchReady,
              snapshotPath,
            }
          }

          if (branch !== "main") {
            yield* Effect.tryPromise({
              try: () => og.branches.delete(branch),
              catch: (cause) => new OmnigraphLoadError({ cause }),
            }).pipe(Effect.orElseSucceed(() => undefined))
          }

          return yield* Effect.tryPromise({
            try: () =>
              og.load({
                branch,
                ...(branch !== "main" ? { from: options?.from ?? "main" } : {}),
                mode: "merge",
                data: ndjson,
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.map(() => ({
              syncedToOmnigraph: true,
              snapshotPath,
            })),
            Effect.catch((err) =>
              Effect.succeed({
                syncedToOmnigraph: false,
                snapshotPath,
                error: err.cause instanceof Error ? err.cause.message : String(err.cause),
              }),
            ),
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
              catch: (cause) => new OmnigraphLoadError({ cause }),
            })
            if (!branches.includes(source)) {
              yield* Effect.tryPromise({
                try: () => og.branches.create({ name: source, from: target }),
                catch: (cause) => new OmnigraphLoadError({ cause }),
              })
            }
            yield* Effect.tryPromise({
              try: () => og.branches.merge({ source, target }),
              catch: (cause) => new OmnigraphLoadError({ cause }),
            }).pipe(
              Effect.catch((mergeErr) =>
                Effect.gen(function* () {
                  if (!options?.repoRoot) {
                    return yield* mergeErr
                  }
                  const fallbackSnap = join(options.repoRoot, ".harness", "graph-snapshot.json")
                  if (!existsSync(fallbackSnap)) {
                    return yield* mergeErr
                  }
                  const snapGraph = yield* loadGraphSnapshotEffect(fallbackSnap).pipe(
                    Effect.mapError((cause) => new OmnigraphLoadError({ cause })),
                  )
                  const ndjson = toOmnigraphServerNdjson(snapGraph)
                  if (ndjson.trim().length > 0) {
                    yield* Effect.tryPromise({
                      try: () =>
                        og.load({
                          branch: target,
                          mode: "merge",
                          data: ndjson,
                        }),
                      catch: (cause) => new OmnigraphLoadError({ cause }),
                    })
                  }
                }),
              ),
            )
            const cleanup = options?.cleanupBranches ?? []
            for (const branchToDelete of cleanup) {
              if (branchToDelete !== target && branchToDelete !== "main") {
                yield* Effect.tryPromise({
                  try: () => og.branches.delete(branchToDelete),
                  catch: (cause) => new OmnigraphLoadError({ cause }),
                }).pipe(Effect.orElseSucceed(() => undefined))
              }
            }
            if (options?.repoRoot) {
              writeGraphHeadMeta(options.repoRoot)
            }
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
                branch: input.branch ?? "main",
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.map((res) =>
              Array.isArray(res.rows)
                ? Option.some(res.rows as ReadonlyArray<Record<string, unknown>>)
                : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none()),
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
                expectMutation: false,
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.map((res) => {
              if (
                res &&
                typeof res === "object" &&
                "rows" in res &&
                Array.isArray((res as { rows: unknown }).rows)
              ) {
                return Option.some((res as { rows: ReadonlyArray<Record<string, unknown>> }).rows)
              }
              return Option.none<ReadonlyArray<Record<string, unknown>>>()
            }),
            Effect.orElseSucceed(() => Option.none<ReadonlyArray<Record<string, unknown>>>()),
          )

          if (Option.isSome(invokeAttempt)) {
            return {
              source: "omnigraph" as const,
              rows: invokeAttempt.value,
            }
          }

          const queryDescriptor = HARNESS_GQ_QUERIES[input.name]
          const queryAttempt = yield* Effect.tryPromise({
            try: () =>
              og.query({
                query: queryDescriptor.source,
                name: input.name,
                ...(input.params ? { params: input.params } : {}),
                branch,
              }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.map((res) => {
              if (
                res &&
                typeof res === "object" &&
                "rows" in res &&
                Array.isArray((res as { rows: unknown }).rows)
              ) {
                return Option.some((res as { rows: ReadonlyArray<Record<string, unknown>> }).rows)
              }
              return Option.none<ReadonlyArray<Record<string, unknown>>>()
            }),
            Effect.orElseSucceed(() => Option.none<ReadonlyArray<Record<string, unknown>>>()),
          )

          if (Option.isSome(queryAttempt)) {
            return {
              source: "omnigraph" as const,
              rows: queryAttempt.value,
            }
          }

          const fallbackRows = input.fallbackGraph
            ? executeNamedGqQueryInMemory(input.fallbackGraph, input.name, input.params)
            : []

          return {
            source: "memory-fallback" as const,
            rows: fallbackRows,
          }
        }),

      diffBranches: (input) =>
        Effect.gen(function* () {
          const og = makeOmnigraphClient(input)
          const source = input?.source ?? "impl/current"
          const target = input?.target ?? "plan/current"

          return yield* Effect.tryPromise({
            try: () => og.branches.diff({ source, target }),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(
            Effect.asSome,
            Effect.orElseSucceed(() => Option.none()),
          )
        }),
    }),
  )
}

export const syncToOmnigraphAndSnapshot = Effect.fn("OmnigraphSync.sync")(function* (
  graph: HarnessGraph,
  options?: OmnigraphConnectionOptions & {
    readonly branch?: string | undefined
    readonly snapshotPath?: string | undefined
    readonly from?: string | undefined
  },
) {
  const service = yield* OmnigraphSync
  return yield* service.sync(graph, options)
})

export const mergeOmnigraphBranch = Effect.fn("OmnigraphSync.mergeBranch")(function* (
  options?: OmnigraphConnectionOptions & {
    readonly source?: string | undefined
    readonly target?: string | undefined
    readonly cleanupBranches?: ReadonlyArray<string> | undefined
  },
) {
  const service = yield* OmnigraphSync
  return yield* service.mergeBranch(options)
})

export const queryOmnigraph = (
  input: OmnigraphConnectionOptions & {
    readonly query: string
    readonly name?: string | undefined
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: string | undefined
  },
): Effect.Effect<Option.Option<ReadonlyArray<Record<string, unknown>>>, never, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.query(input))

export const invokeOmnigraphNamedQuery = (
  input: OmnigraphConnectionOptions & {
    readonly name: HarnessGqQueryName
    readonly params?: Readonly<Record<string, unknown>> | undefined
    readonly branch?: string | undefined
    readonly fallbackGraph?: HarnessGraph | undefined
  },
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
  },
): Effect.Effect<Option.Option<Diff>, never, OmnigraphSync> =>
  Effect.flatMap(OmnigraphSync, (service) => service.diffBranches(input))
