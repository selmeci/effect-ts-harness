import { join } from "node:path"
import { OmnigraphServerMetaSchema, toErrorReasonMessage } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { Option, Result, Schema } from "effect"
import * as Graph from "effect/Graph"
import { Omnigraph } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import { classifyOntologyEdge, classifyOntologyNode } from "./archimate-ontology.js"
import {
  deriveClusterOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "./cluster-resolver.js"
import { mapPlaysRoleToOmnigraphEdgeName } from "./graph-engine.js"
import { getNodeKey, type HarnessGraph, type HarnessNode } from "./model.js"
import {
  HARNESS_OMNIGRAPH_GRAPH_ID,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
  decodeStrictOptionalCommitId,
  decodeStrictOptionalCursor,
  executeGetBlobText,
  executePollChanges,
  executeStatBlob,
  isChangeFeedGapError,
  isLoopbackOmnigraphUrl,
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  isOmnigraphUnavailableError,
  mapOmnigraphConflictError,
  mapOmnigraphPreconditionError,
  type OmnigraphBlobSelectorInput,
  type OmnigraphBlobStatResult,
  type OmnigraphChangeFeedResult,
  type OmnigraphCommitActionInput,
  type OmnigraphConditionalMutationInput,
  type OmnigraphConditionalMutationResult,
  type OmnigraphConnectionOptions,
  type OmnigraphDryRunMergeInput,
  type OmnigraphDryRunMergeResult,
  type OmnigraphGetBlobInput,
  type OmnigraphInspectCommitChangesInput,
  OmnigraphLoadError,
  type OmnigraphPollChangesInput,
  type OmnigraphProposeMergeInput,
  type OmnigraphPutBlobInput,
  DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES,
  readAuthTokensFromClusterDir,
  resolveOmnigraphGraphId,
  splitNdjsonIntoByteChunks,
} from "./omnigraph-v014-ops.js"

export {
  HARNESS_OMNIGRAPH_GRAPH_ID,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
  DEFAULT_OMNIGRAPH_LOAD_CHUNK_BYTES,
  decodeStrictOptionalCommitId,
  decodeStrictOptionalCursor,
  executeGetBlobText,
  executePollChanges,
  executeStatBlob,
  isChangeFeedGapError,
  isLoopbackOmnigraphUrl,
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  isOmnigraphUnavailableError,
  mapOmnigraphConflictError,
  mapOmnigraphPreconditionError,
  OmnigraphLoadError,
  readAuthTokensFromClusterDir,
  resolveOmnigraphGraphId,
  splitNdjsonIntoByteChunks,
  type OmnigraphBlobSelectorInput,
  type OmnigraphBlobStatResult,
  type OmnigraphChangeFeedResult,
  type OmnigraphCommitActionInput,
  type OmnigraphConditionalMutationInput,
  type OmnigraphConditionalMutationResult,
  type OmnigraphConnectionOptions,
  type OmnigraphDryRunMergeInput,
  type OmnigraphDryRunMergeResult,
  type OmnigraphGetBlobInput,
  type OmnigraphInspectCommitChangesInput,
  type OmnigraphPollChangesInput,
  type OmnigraphProposeMergeInput,
  type OmnigraphPutBlobInput,
}

export const OmnigraphClient = Omnigraph

const decodeServerMetaOption = Schema.decodeOption(Schema.fromJsonString(OmnigraphServerMetaSchema))

/**
 * Resolves the Omnigraph server base URL from explicit options, environment
 * variables, or `.harness/omnigraph-cluster/server.json`.
 */
export const resolveOmnigraphBaseUrl = (
  options?: OmnigraphConnectionOptions,
  env?: Readonly<Record<string, string | undefined>>,
  hostIo?: SyncHostIo,
): string => {
  const effectiveHostIo = hostIo ?? options?.hostIo
  const effectiveEnv = options?.env ?? env ?? effectiveHostIo?.getEnv() ?? {}
  if (options?.baseUrl !== undefined) {
    return options.baseUrl
  }
  if (effectiveEnv.OMNIGRAPH_URL && effectiveEnv.OMNIGRAPH_URL !== "http://127.0.0.1:8080") {
    return effectiveEnv.OMNIGRAPH_URL
  }
  if (options?.repoRoot && effectiveHostIo !== undefined) {
    const clusterDir = resolveOmnigraphClusterDir(options.repoRoot, effectiveHostIo, effectiveEnv)
    const serverJsonPath = join(clusterDir, "server.json")
    if (effectiveHostIo.existsSync(serverJsonPath)) {
      const expectedCanonicalRoot = resolveCanonicalRepoRoot(options.repoRoot, effectiveHostIo)
      const baseUrlFromMeta = match(Result.try(() => effectiveHostIo.readTextSync(serverJsonPath)))
        .with({ _tag: "Failure" }, ({ failure }) => {
          process.stderr.write(
            `[harness/graph] Warning: failed to read ${serverJsonPath}: ${toErrorReasonMessage(failure)}\n`,
          )
          return undefined
        })
        .with({ _tag: "Success" }, ({ success: raw }) =>
          match(decodeServerMetaOption(raw))
            .with({ _tag: "None" }, () => {
              process.stderr.write(
                `[harness/graph] Warning: failed to decode ${serverJsonPath} as OmnigraphServerMeta JSON\n`,
              )
              return undefined
            })
            .with({ _tag: "Some" }, ({ value: meta }) => {
              const validRoot = meta.canonicalRepoRoot === expectedCanonicalRoot
              if (!validRoot) {
                process.stderr.write(
                  `[harness/graph] Warning: ignoring ${serverJsonPath} with mismatched canonicalRepoRoot (${meta.canonicalRepoRoot} !== ${expectedCanonicalRoot})\n`,
                )
                return undefined
              }
              if (!isLoopbackOmnigraphUrl(meta.baseUrl)) {
                process.stderr.write(
                  `[harness/graph] Warning: ignoring non-loopback baseUrl in ${serverJsonPath}: ${meta.baseUrl}\n`,
                )
                return undefined
              }
              return meta.baseUrl
            })
            .exhaustive(),
        )
        .exhaustive()
      if (baseUrlFromMeta !== undefined) {
        return baseUrlFromMeta
      }
    }
    return `http://127.0.0.1:${deriveClusterOmnigraphPort(options.repoRoot, effectiveHostIo, effectiveEnv)}`
  }
  return effectiveEnv.OMNIGRAPH_URL ?? "http://127.0.0.1:8080"
}

export interface ResolvedOmnigraphClientConfig {
  readonly baseUrl: string
  readonly graphId: string
  readonly token: string | undefined
}

export const resolveWorkflowOmnigraphConfig = (
  options?: OmnigraphConnectionOptions,
  hostIo?: SyncHostIo,
  env?: Readonly<Record<string, string | undefined>>,
): ResolvedOmnigraphClientConfig => {
  const effectiveHostIo = hostIo ?? options?.hostIo
  const effectiveEnv = options?.env ?? env ?? effectiveHostIo?.getEnv() ?? {}
  const baseUrl = resolveOmnigraphBaseUrl(options, effectiveEnv, effectiveHostIo)
  const graphId = options?.graphId ?? WORKFLOW_OMNIGRAPH_GRAPH_ID
  const localAuthToken =
    options?.token === undefined &&
    effectiveEnv.OMNIGRAPH_TOKEN === undefined &&
    options?.repoRoot &&
    effectiveHostIo !== undefined &&
    isLoopbackOmnigraphUrl(baseUrl)
      ? readAuthTokensFromClusterDir(
          resolveOmnigraphClusterDir(options.repoRoot, effectiveHostIo, effectiveEnv),
          effectiveHostIo,
          options.actor ?? "harness-cli",
        )
      : undefined
  const token = options?.token ?? effectiveEnv.OMNIGRAPH_TOKEN ?? localAuthToken
  return { baseUrl, graphId, token }
}

export const makeOmnigraphClient = (
  options?: OmnigraphConnectionOptions,
  hostIo?: SyncHostIo,
  env?: Readonly<Record<string, string | undefined>>,
): Omnigraph => {
  const effectiveHostIo = hostIo ?? options?.hostIo
  const effectiveEnv = options?.env ?? env ?? effectiveHostIo?.getEnv() ?? {}
  const resolved = resolveWorkflowOmnigraphConfig(
    {
      ...options,
      graphId: resolveOmnigraphGraphId(options, effectiveEnv, HARNESS_OMNIGRAPH_GRAPH_ID),
    },
    effectiveHostIo,
    effectiveEnv,
  )
  return new Omnigraph({
    baseUrl: resolved.baseUrl,
    graphId: resolved.graphId,
    ...(resolved.token ? { token: resolved.token } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  })
}

export const makeWorkflowOmnigraphClient = (
  options?: OmnigraphConnectionOptions,
  hostIo?: SyncHostIo,
  env?: Readonly<Record<string, string | undefined>>,
): Omnigraph => {
  const resolved = resolveWorkflowOmnigraphConfig(
    { ...options, actor: options?.actor ?? "harness-cli" },
    hostIo,
    env,
  )
  return new Omnigraph({
    baseUrl: resolved.baseUrl,
    graphId: resolved.graphId,
    ...(resolved.token ? { token: resolved.token } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  })
}

const EDGE_CALL_METRICS_ALLOWED = new Set([
  "PlaysCalleeRole",
  "PlaysExercisingTestRole",
  "PlaysExercisedSpanRole",
])

export interface OmnigraphNdjsonExportOptions {
  readonly clearMissingEmbeddings?: boolean | undefined
}

export const toOmnigraphServerNdjsonResult = (
  graph: HarnessGraph,
  embeddingsByNodeKey?: ReadonlyMap<string, ReadonlyArray<number>>,
  options?: OmnigraphNdjsonExportOptions,
): Result.Result<string, OmnigraphLoadError> => {
  const nodeLines: Array<string> = []
  const seenNodes = new Set<string>()
  const nodeMetaByKey = new Map<
    string,
    { readonly tag: HarnessNode["_tag"]; readonly id: string }
  >()
  const clearMissing = options?.clearMissingEmbeddings ?? true

  const lookupEmbedding = (key: string, id: string): ReadonlyArray<number> | undefined =>
    embeddingsByNodeKey?.get(key) ?? embeddingsByNodeKey?.get(id)

  const toEmbeddingField = (
    propName: "summaryEmbedding" | "searchEmbedding" | "clauseEmbedding",
    vec: ReadonlyArray<number> | undefined,
  ): Readonly<Record<string, ReadonlyArray<number> | null>> => {
    if (vec !== undefined) {
      return { [propName]: vec }
    }
    if (embeddingsByNodeKey !== undefined && clearMissing) {
      return { [propName]: null }
    }
    return {}
  }

  const pushNode = (type: string, id: string, data: Record<string, unknown>): void => {
    const dedupKey = `${type}::${id}`
    if (seenNodes.has(dedupKey)) return
    seenNodes.add(dedupKey)
    nodeLines.push(JSON.stringify({ type, id, data }))
  }

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
        pushNode("EffectFn", n.qualname, {
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
        })
      })
      .with({ _tag: "ServiceTag" }, (n) => {
        if (!n.tagId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.tagId })
        pushNode("ServiceTag", n.tagId, {
          tagId: n.tagId,
          qualname: n.qualname ?? n.tagId,
          name: n.name,
          ...(n.identifier ? { identifier: n.identifier } : {}),
          ...(n.packageTag ? { packageTag: n.packageTag } : {}),
          file: n.file,
          ...(n.line !== undefined ? { line: n.line } : {}),
          ...archimateFields,
        })
      })
      .with({ _tag: "ServiceLayer" }, (n) => {
        if (!n.qualname) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.qualname })
        pushNode("ServiceLayer", n.qualname, {
          qualname: n.qualname,
          ...(n.layerKind ? { layerKind: n.layerKind } : {}),
          ...(n.packageTag ? { packageTag: n.packageTag } : {}),
          file: n.file,
          ...(n.line !== undefined ? { line: n.line } : {}),
          ...archimateFields,
        })
      })
      .with({ _tag: "TaggedError" }, (n) => {
        if (!n.errorTag) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.errorTag })
        pushNode("TaggedError", n.errorTag, {
          errorTag: n.errorTag,
          qualname: n.qualname ?? n.errorTag,
          ...(n.tag ? { tag: n.tag } : {}),
          file: n.file,
          ...(n.line !== undefined ? { line: n.line } : {}),
          ...archimateFields,
        })
      })
      .with({ _tag: "SchemaDef" }, (n) => {
        if (!n.schemaName) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.schemaName })
        pushNode("SchemaDef", n.schemaName, {
          schemaName: n.schemaName,
          qualname: n.qualname ?? n.schemaName,
          name: n.name ?? n.schemaName,
          ...(n.packageTag ? { packageTag: n.packageTag } : {}),
          file: n.file,
          ...(n.line !== undefined ? { line: n.line } : {}),
          ...(n.isBranded !== undefined ? { isBranded: n.isBranded } : {}),
          ...archimateFields,
        })
      })
      .with({ _tag: "VitestCase" }, (n) => {
        if (!n.testId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.testId })
        pushNode("VitestCase", n.testId, {
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
        })
      })
      .with({ _tag: "PatternDoc" }, (n) => {
        if (!n.slug) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.slug })
        const embeddingField = toEmbeddingField("summaryEmbedding", lookupEmbedding(key, n.slug))
        pushNode("PatternDoc", n.slug, {
          slug: n.slug,
          qualname: n.slug,
          path: n.path,
          summary: n.summary,
          ...(n.title ? { title: n.title } : {}),
          ...(n.coveredSpans ? { coveredSpans: n.coveredSpans } : {}),
          ...(n.coveredTags ? { coveredTags: n.coveredTags } : {}),
          ...embeddingField,
          ...archimateFields,
        })
      })
      .with({ _tag: "AdrDoc" }, (n) => {
        if (!n.id) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.id })
        const embeddingField = toEmbeddingField("searchEmbedding", lookupEmbedding(key, n.id))
        pushNode("AdrDoc", n.id, {
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
          ...(n.searchText ? { searchText: n.searchText } : {}),
          ...embeddingField,
          ...archimateFields,
        })
      })
      .with({ _tag: "EarsSpec" }, (n) => {
        if (!n.id) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.id })
        pushNode("EarsSpec", n.id, {
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
        })
      })
      .with({ _tag: "EarsRequirement" }, (n) => {
        if (!n.id) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.id })
        const embeddingField = toEmbeddingField("clauseEmbedding", lookupEmbedding(key, n.id))
        pushNode("EarsRequirement", n.id, {
          id: n.id,
          qualname: n.id,
          specId: n.specId,
          requirementId: n.requirementId,
          area: n.area,
          pattern: n.pattern,
          clauseText: n.clauseText,
          effectSymbol: n.effectSymbol,
          verification: n.verification,
          path: n.path,
          line: n.line,
          status: n.status,
          ...embeddingField,
          ...archimateFields,
        })
      })
      .with({ _tag: "EffectSignature" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        pushNode("EffectSignature", n.relationId, {
          relationId: n.relationId,
          qualname: n.relationId,
          callerQualname: n.callerQualname,
          file: n.file,
          line: n.line,
        })
      })
      .with({ _tag: "LayerFlow" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        pushNode("LayerFlow", n.relationId, {
          relationId: n.relationId,
          qualname: n.relationId,
          layerQualname: n.layerQualname,
          file: n.file,
          line: n.line,
        })
      })
      .with({ _tag: "TraceabilityTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        pushNode("TraceabilityTuple", n.relationId, {
          relationId: n.relationId,
          qualname: n.relationId,
          ...(n.adrId ? { adrId: n.adrId } : {}),
          ...(n.earsSpecId ? { earsSpecId: n.earsSpecId } : {}),
          ...(n.requirementId ? { requirementId: n.requirementId } : {}),
          ...(n.earsPattern ? { earsPattern: n.earsPattern } : {}),
          targetSymbolQualname: n.targetSymbolQualname,
        })
      })
      .with({ _tag: "HttpEndpointTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        pushNode("HttpEndpointTuple", n.relationId, {
          relationId: n.relationId,
          qualname: n.relationId,
          endpointGroup: n.endpointGroup,
          endpointName: n.endpointName,
          method: n.method,
          path: n.path,
          ...(n.handlerQualname ? { handlerQualname: n.handlerQualname } : {}),
          file: n.file,
          line: n.line,
        })
      })
      .with({ _tag: "MigrationTuple" }, (n) => {
        if (!n.relationId) return
        nodeMetaByKey.set(key, { tag: n._tag, id: n.relationId })
        pushNode("MigrationTuple", n.relationId, {
          relationId: n.relationId,
          qualname: n.relationId,
          migrationId: n.migrationId,
          engine: n.engine,
          moduleFile: n.moduleFile,
          isDestructive: n.isDestructive,
          line: n.line,
        })
      })
      .exhaustive()
  }

  const validEdgeLines: Array<string> = []
  const seenEdges = new Set<string>()

  for (const [, edge] of Graph.edges(graph.graph)) {
    const srcNode = Option.getOrUndefined(Graph.getNode(graph.graph, edge.source))
    const dstNode = Option.getOrUndefined(Graph.getNode(graph.graph, edge.target))
    if (srcNode === undefined || dstNode === undefined) continue
    const srcMeta = nodeMetaByKey.get(getNodeKey(srcNode))
    const dstMeta = nodeMetaByKey.get(getNodeKey(dstNode))
    if (!srcMeta || !dstMeta) continue

    const omnigraphEdgeName = mapPlaysRoleToOmnigraphEdgeName(
      srcMeta.tag,
      dstMeta.tag,
      edge.data.role,
    )
    if (!omnigraphEdgeName) {
      return Result.fail(
        new OmnigraphLoadError({
          cause: new Error(
            `Unmappable role '${edge.data.role}' from ${srcMeta.tag} to ${dstMeta.tag} in toOmnigraphServerNdjson`,
          ),
        }),
      )
    }

    const dedupKey = `${omnigraphEdgeName}::${srcMeta.id}::${dstMeta.id}::${edge.data.role}`
    if (seenEdges.has(dedupKey)) continue
    seenEdges.add(dedupKey)

    const archimateRelation = classifyOntologyEdge(edge.data)
    const allowCallMetrics = EDGE_CALL_METRICS_ALLOWED.has(omnigraphEdgeName)
    validEdgeLines.push(
      JSON.stringify({
        edge: omnigraphEdgeName,
        from: srcMeta.id,
        to: dstMeta.id,
        data: {
          role: edge.data.role,
          archimateRelation,
          ...(allowCallMetrics && edge.data.callCount !== undefined
            ? { callCount: edge.data.callCount }
            : {}),
          ...(allowCallMetrics &&
          edge.data.receiverLayer !== undefined &&
          edge.data.receiverLayer !== null
            ? { receiverLayer: edge.data.receiverLayer }
            : {}),
        },
      }),
    )
  }

  if (nodeLines.length > 0) {
    const canonicalPolicies = [
      {
        policyId: "policy-0001-domain-spans-verified",
        name: "Domain Spans Verified",
        statement: "Every non-stub domain EffectFn must be exercised by at least one VitestCase.",
        severity: "error",
        checkQuery: "policy_unverified_domain_fns",
        enabled: true,
      },
      {
        policyId: "policy-0002-no-orphan-effect-signatures",
        name: "No Orphan EffectSignatures",
        statement: "Every EffectSignature relation node must link to an EffectFn caller.",
        severity: "error",
        checkQuery: "policy_orphan_effect_signatures",
        enabled: true,
      },
      {
        policyId: "policy-0003-AcceptedSpecsEnforced",
        name: "Accepted Specs Enforced",
        statement: "Every accepted EarsSpec must link to realizing symbols via TraceabilityTuple.",
        severity: "error",
        enabled: true,
      },
    ] as const

    for (const policy of canonicalPolicies) {
      pushNode("GraphPolicy", policy.policyId, policy)
    }
  }

  return Result.succeed([...nodeLines, ...validEdgeLines].join("\n"))
}

export const toOmnigraphServerNdjson = (graph: HarnessGraph): string =>
  Result.getOrThrow(toOmnigraphServerNdjsonResult(graph))
