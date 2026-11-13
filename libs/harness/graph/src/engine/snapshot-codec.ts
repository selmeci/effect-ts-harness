import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match, P } from "ts-pattern"
import {
  GraphSnapshotError,
  HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  HarnessNode,
  getNodeKey,
} from "../model.js"
import { mapPlaysRoleToOmnigraphEdgeName } from "./hypergraph-store.js"

const getOmnigraphVertexQualname = (node: HarnessNode): string =>
  match(node)
    .with({ _tag: "EffectFn" }, (n) => n.qualname)
    .with({ _tag: "ServiceTag" }, (n) => n.tagId)
    .with({ _tag: "ServiceLayer" }, (n) => n.qualname)
    .with({ _tag: "TaggedError" }, (n) => n.errorTag)
    .with({ _tag: "SchemaDef" }, (n) => n.schemaName)
    .with({ _tag: "VitestCase" }, (n) => n.testId)
    .with({ _tag: "PatternDoc" }, (n) => n.slug)
    .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => n.id)
    .with(
      { _tag: "EffectSignature" },
      { _tag: "LayerFlow" },
      { _tag: "TraceabilityTuple" },
      { _tag: "HttpEndpointTuple" },
      { _tag: "MigrationTuple" },
      (n) => n.relationId,
    )
    .exhaustive()

/**
 * Exports the Clean-Slate PERA Levi hypergraph as Omnigraph NDJSON matching `schema.pg`.
 * Only concrete `EntityNode` and `RelationNode` vertices and `PlaysRole` edges are emitted.
 */
export const toOmnigraphNdjson = (harnessGraph: HarnessGraph): string => {
  const lines: Array<string> = []

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    const line = match(node)
      .with({ _tag: "EffectFn" }, (n) =>
        JSON.stringify({
          type: "EffectFn",
          key: n.qualname,
          properties: {
            qualname: n.qualname,
            spanName: n.spanName,
            packageTag: n.packageTag,
            file: n.file,
            line: n.line,
            isStub: n.isStub ?? false,
            payloadSchemas: n.payloadSchemas ? JSON.stringify(n.payloadSchemas) : null,
            inputSchema: n.inputSchema ?? null,
            outputSchema: n.outputSchema ?? null,
          },
        }),
      )
      .with({ _tag: "ServiceTag" }, (n) =>
        JSON.stringify({
          type: "ServiceTag",
          key: n.tagId,
          properties: {
            qualname: n.tagId,
            identifier: n.name,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "ServiceLayer" }, (n) =>
        JSON.stringify({
          type: "ServiceLayer",
          key: n.qualname,
          properties: {
            qualname: n.qualname,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "TaggedError" }, (n) =>
        JSON.stringify({
          type: "TaggedError",
          key: n.errorTag,
          properties: {
            qualname: n.errorTag,
            tag: n.errorTag,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "SchemaDef" }, (n) =>
        JSON.stringify({
          type: "SchemaDef",
          key: n.schemaName,
          properties: {
            qualname: n.schemaName,
            name: n.schemaName,
            file: n.file,
            line: n.line ?? 1,
            isBranded: n.isBranded ?? false,
          },
        }),
      )
      .with({ _tag: "VitestCase" }, (n) =>
        JSON.stringify({
          type: "VitestCase",
          key: n.testId,
          properties: {
            qualname: n.testId,
            name: n.testName,
            file: n.testFile,
            line: n.line ?? 1,
            isPropertyTest: n.isPropertyTest ?? false,
          },
        }),
      )
      .with({ _tag: "PatternDoc" }, (n) =>
        JSON.stringify({
          type: "PatternDoc",
          key: n.slug,
          properties: {
            qualname: n.slug,
            path: n.path,
            title: n.title ?? n.summary,
            coveredSpans: n.coveredSpans ? JSON.stringify(n.coveredSpans) : null,
            coveredTags: n.coveredTags ? JSON.stringify(n.coveredTags) : null,
          },
        }),
      )
      .with({ _tag: "AdrDoc" }, (n) =>
        JSON.stringify({
          type: "AdrDoc",
          key: n.id,
          properties: {
            qualname: n.id,
            id: n.id,
            title: n.title,
            status: n.status,
            date: n.date ?? "2026-11-06",
            path: n.path,
            enforcedByFiles: JSON.stringify(n.enforcedByFiles),
          },
        }),
      )
      .with({ _tag: "EarsSpec" }, (n) =>
        JSON.stringify({
          type: "EarsSpec",
          key: n.id,
          properties: {
            qualname: n.id,
            id: n.id,
            title: n.title,
            status: n.status,
            date: n.date ?? "2026-11-06",
            path: n.path,
            enforcedByFiles: JSON.stringify(n.enforcedByFiles),
            informedByAdrs: n.informedByAdrs ? JSON.stringify(n.informedByAdrs) : null,
          },
        }),
      )
      .with({ _tag: "EffectSignature" }, (n) =>
        JSON.stringify({
          type: "EffectSignature",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            callerQualname: n.callerQualname,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "LayerFlow" }, (n) =>
        JSON.stringify({
          type: "LayerFlow",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            layerQualname: n.layerQualname,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "TraceabilityTuple" }, (n) =>
        JSON.stringify({
          type: "TraceabilityTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            adrId: n.adrId ?? null,
            earsSpecId: n.earsSpecId ?? null,
            requirementId: n.requirementId ?? null,
            earsPattern: n.earsPattern ?? null,
            targetSymbolQualname: n.targetSymbolQualname,
          },
        }),
      )
      .with({ _tag: "HttpEndpointTuple" }, (n) =>
        JSON.stringify({
          type: "HttpEndpointTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            endpointGroup: n.endpointGroup,
            endpointName: n.endpointName,
            method: n.method,
            path: n.path,
            handlerQualname: n.handlerQualname ?? null,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "MigrationTuple" }, (n) =>
        JSON.stringify({
          type: "MigrationTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            migrationId: n.migrationId,
            engine: n.engine,
            moduleFile: n.moduleFile,
            isDestructive: n.isDestructive,
            line: n.line,
          },
        }),
      )
      .exhaustive()

    lines.push(line)
  }

  for (const [, edge] of Graph.edges(harnessGraph.graph)) {
    const sourceNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, edge.source))
    const targetNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, edge.target))
    if (sourceNode === undefined || targetNode === undefined) continue

    const edgeName = mapPlaysRoleToOmnigraphEdgeName(
      sourceNode._tag,
      targetNode._tag,
      edge.data.role,
    )
    if (!edgeName) {
      // oxlint-disable-next-line -- synchronous boundary
      throw new Error(
        `Unmappable role '${edge.data.role}' from ${sourceNode._tag} to ${targetNode._tag} in toOmnigraphNdjson`,
      )
    }

    lines.push(
      JSON.stringify({
        edge: edgeName,
        from: getOmnigraphVertexQualname(sourceNode),
        to: getOmnigraphVertexQualname(targetNode),
        properties: {
          role: edge.data.role,
          archimateRelation: edge.data.archimateRelation ?? null,
        },
      }),
    )
  }

  return lines.join("\n")
}

export interface SerializedGraphSnapshot {
  readonly nodes: ReadonlyArray<HarnessNode>
  readonly edges: ReadonlyArray<{
    readonly sourceKey: string
    readonly targetKey: string
    readonly data: HarnessEdge
  }>
}

export const serializeGraphSnapshot = (harnessGraph: HarnessGraph): SerializedGraphSnapshot => {
  const nodes: Array<HarnessNode> = []
  const edges: Array<{ sourceKey: string; targetKey: string; data: HarnessEdge }> = []

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    nodes.push(node)
  }

  for (const [, edge] of Graph.edges(harnessGraph.graph)) {
    const sourceOpt = Graph.getNode(harnessGraph.graph, edge.source)
    const targetOpt = Graph.getNode(harnessGraph.graph, edge.target)
    match([sourceOpt, targetOpt])
      .with([{ _tag: "Some" }, { _tag: "Some" }], ([s, t]) => {
        edges.push({
          sourceKey: getNodeKey(s.value),
          targetKey: getNodeKey(t.value),
          data: edge.data,
        })
      })
      .with([{ _tag: "None" }, P._], [P._, { _tag: "None" }], () => {})
      .exhaustive()
  }

  return { nodes, edges }
}

const SerializedGraphSnapshotSchema = Schema.Struct({
  nodes: Schema.Array(HarnessNode),
  edges: Schema.Array(
    Schema.Struct({
      sourceKey: Schema.String,
      targetKey: Schema.String,
      data: HarnessEdge,
    }),
  ),
})

export const deserializeGraphSnapshotEffect = Effect.fn("GraphEngine.deserializeSnapshot")(
  function* (snapshot: SerializedGraphSnapshot, snapshotPath = "<in-memory>") {
    const nodeIndexByKey = new Map<string, Graph.NodeIndex>()

    let danglingEdge: (typeof snapshot.edges)[number] | undefined
    const graph = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
      for (const node of snapshot.nodes) {
        const idx = Graph.addNode(mutable, node)
        nodeIndexByKey.set(getNodeKey(node), idx)
      }

      for (const edge of snapshot.edges) {
        const s = nodeIndexByKey.get(edge.sourceKey)
        const t = nodeIndexByKey.get(edge.targetKey)
        if (s === undefined || t === undefined) {
          danglingEdge ??= edge
          continue
        }
        Graph.addEdge(mutable, s, t, edge.data)
      }
    })

    if (danglingEdge !== undefined) {
      return yield* new GraphSnapshotError({
        path: snapshotPath,
        reason: "dangling-edge",
        message: `Snapshot edge references missing node: sourceKey='${danglingEdge.sourceKey}', targetKey='${danglingEdge.targetKey}' at ${snapshotPath}`,
      })
    }

    const result: HarnessGraph = {
      [HarnessGraphTypeId]: HarnessGraphTypeId,
      graph,
      nodeIndexByKey,
    }
    return result
  },
)

export const saveGraphSnapshot = (
  harnessGraph: HarnessGraph,
  snapshotPath = path.resolve(process.cwd(), ".harness/graph-snapshot.json"),
): void => {
  const dir = path.dirname(snapshotPath)
  fs.mkdirSync(dir, { recursive: true })
  const serialized = serializeGraphSnapshot(harnessGraph)
  fs.writeFileSync(snapshotPath, JSON.stringify(serialized, null, 2), "utf8")
}

export const loadGraphSnapshotEffect = Effect.fn("GraphEngine.loadSnapshot")(function* (
  snapshotPath = path.resolve(process.cwd(), ".harness/graph-snapshot.json"),
) {
  if (!fs.existsSync(snapshotPath)) {
    return yield* new GraphSnapshotError({
      path: snapshotPath,
      reason: "missing-file",
      message: `Graph snapshot file does not exist at '${snapshotPath}'`,
    })
  }

  const raw = yield* Effect.try({
    try: () => fs.readFileSync(snapshotPath, "utf8"),
    catch: (err) =>
      new GraphSnapshotError({
        path: snapshotPath,
        reason: "invalid-json",
        message: `Failed to read snapshot file at '${snapshotPath}': ${String(err)}`,
      }),
  })

  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SerializedGraphSnapshotSchema))(
    raw,
  ).pipe(
    Effect.mapError(
      (err) =>
        new GraphSnapshotError({
          path: snapshotPath,
          reason: "invalid-json",
          message: `Snapshot JSON decoding failed at '${snapshotPath}': ${String(err)}`,
        }),
    ),
  )

  return yield* deserializeGraphSnapshotEffect(decoded, snapshotPath)
})
