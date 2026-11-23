import * as path from "node:path"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostIo, SyncHostReader } from "@harness/service/host-io"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AdrDocNode,
  type BranchingViolation,
  type EarsSpecNode,
  EffectFnNode,
  PackageTag,
  type PatternDocNode,
  SchemaDefNode,
  ServiceLayerNode,
  ServiceTagNode,
  TaggedErrorNode,
  ViolationRule,
} from "../model.js"

export interface FileGraphFragment {
  readonly filePath: string
  readonly packageTag?: PackageTag | undefined
  readonly contentSha256: string
  readonly declHash: string
  readonly importedSpecs: ReadonlyArray<string>
  readonly fns: ReadonlyArray<EffectFnNode>
  readonly services?: ReadonlyArray<ServiceTagNode> | undefined
  readonly layers: ReadonlyArray<ServiceLayerNode>
  readonly errors?: ReadonlyArray<TaggedErrorNode> | undefined
  readonly schemas?: ReadonlyArray<SchemaDefNode> | undefined
  readonly requiresService: ReadonlyArray<{
    readonly callerQualname: string
    readonly tagId: string
  }>
  readonly failsWith: ReadonlyArray<{ readonly callerQualname: string; readonly errorTag: string }>
  readonly providesService: ReadonlyArray<{
    readonly layerQualname: string
    readonly tagId: string
  }>
  readonly layerRequires: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>
  readonly branchingViolations: ReadonlyArray<BranchingViolation>
}

export interface FileGraphCacheSession {
  readonly hostIo?: SyncHostReader | undefined
  readonly persistToDisk?: boolean | undefined
  readonly fileFragmentCache: Map<string, FileGraphFragment>
  readonly sourceFileCache: Map<
    string,
    {
      readonly packageTag?: PackageTag | undefined
      readonly contentSha256: string
      readonly declHash: string
      readonly importedSpecs: ReadonlyArray<string>
    }
  >
}

const FILE_GRAPH_CACHE_VERSION = "file-graph-v1"

const BranchingViolationSchema = Schema.Struct({
  rule: ViolationRule,
  message: Schema.String,
  file: Schema.String,
  line: Schema.Int,
  enclosingSymbol: Schema.String,
  path: Schema.optional(Schema.Array(Schema.String)),
})

const FileGraphFragmentSchema = Schema.Struct({
  filePath: Schema.String,
  packageTag: Schema.optional(PackageTag),
  contentSha256: Schema.String,
  declHash: Schema.String,
  importedSpecs: Schema.Array(Schema.String),
  fns: Schema.Array(EffectFnNode),
  services: Schema.optional(Schema.Array(ServiceTagNode)),
  layers: Schema.Array(ServiceLayerNode),
  errors: Schema.optional(Schema.Array(TaggedErrorNode)),
  schemas: Schema.optional(Schema.Array(SchemaDefNode)),
  requiresService: Schema.Array(
    Schema.Struct({ callerQualname: Schema.String, tagId: Schema.String }),
  ),
  failsWith: Schema.Array(
    Schema.Struct({ callerQualname: Schema.String, errorTag: Schema.String }),
  ),
  providesService: Schema.Array(
    Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String }),
  ),
  layerRequires: Schema.Array(
    Schema.Struct({ layerQualname: Schema.String, tagId: Schema.String }),
  ),
  branchingViolations: Schema.Array(BranchingViolationSchema),
})

const FileGraphCacheStoreSchema = Schema.Struct({
  version: Schema.String,
  fragments: Schema.Record(Schema.String, FileGraphFragmentSchema),
})

const decodeFileGraphCacheStore = Schema.decodeOption(
  Schema.fromJsonString(FileGraphCacheStoreSchema),
)

const resolveFileGraphCachePath = (repoRoot: string): string =>
  path.join(repoRoot, ".harness", "cache", "file-graph-v1.json")

export const loadFileGraphFragmentsFromDisk = (
  repoRoot: string,
  session: FileGraphCacheSession,
  hostIo: SyncHostReader | undefined = session.hostIo,
): void => {
  if (hostIo === undefined) return
  const cachePath = resolveFileGraphCachePath(repoRoot)
  if (!hostIo.existsSync(cachePath)) return
  Result.try(() => {
    const raw = hostIo.readTextSync(cachePath)
    const decoded = decodeFileGraphCacheStore(raw)
    match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        if (value.version !== FILE_GRAPH_CACHE_VERSION) return
        for (const [relPath, frag] of Object.entries(value.fragments)) {
          session.fileFragmentCache.set(relPath, frag)
          session.sourceFileCache.set(relPath, {
            packageTag: frag.packageTag,
            contentSha256: frag.contentSha256,
            declHash: frag.declHash,
            importedSpecs: frag.importedSpecs,
          })
        }
      })
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
  })
}

const isSyncHostIo = (io: SyncHostReader): io is SyncHostIo =>
  "writeTextSync" in io &&
  "appendTextSync" in io &&
  "mkdirRecursiveSync" in io &&
  "renameSync" in io &&
  "unlinkSync" in io &&
  "execFileSync" in io

export const saveFileGraphFragmentsToDisk = (
  repoRoot: string,
  session: FileGraphCacheSession,
  hostIo?: SyncHostIo,
): void => {
  const effectiveHostIo =
    hostIo ??
    (session.hostIo !== undefined && isSyncHostIo(session.hostIo) ? session.hostIo : undefined)
  if (session.persistToDisk !== true || effectiveHostIo === undefined) return
  const cachePath = resolveFileGraphCachePath(repoRoot)
  Result.try(() => {
    effectiveHostIo.mkdirRecursiveSync(path.dirname(cachePath))
    const fragments: Record<string, FileGraphFragment> = {}
    for (const [relPath, frag] of session.fileFragmentCache.entries()) {
      fragments[relPath] = frag
    }
    const serialized = JSON.stringify({ version: FILE_GRAPH_CACHE_VERSION, fragments })
    const tmpPath = `${cachePath}.${computeContentSha256(serialized).slice(0, 16)}.tmp`
    Result.try(() => {
      effectiveHostIo.writeTextSync(tmpPath, serialized)
      effectiveHostIo.renameSync(tmpPath, cachePath)
    })
    if (effectiveHostIo.existsSync(tmpPath)) {
      Result.try(() => effectiveHostIo.unlinkSync(tmpPath))
    }
  })
}

export const buildGovAndPatternShaMaps = (
  governanceDocs: ReadonlyArray<AdrDocNode | EarsSpecNode>,
  patternDocs: ReadonlyArray<PatternDocNode>,
): {
  readonly govShaMap: Map<string, string>
  readonly patternShaMap: Map<string, string>
} => {
  const govShaMap = new Map<string, string>()
  for (const d of governanceDocs) {
    const extraHash = match(d)
      .with({ _tag: "AdrDoc" }, (adr) => `${adr.date ?? ""}:${adr.searchText ?? ""}`)
      .with(
        { _tag: "EarsSpec" },
        (spec) =>
          `${spec.date ?? ""}:${(spec.informedByAdrs ?? []).join(",")}:${spec.goalSummary ?? ""}:${(spec.requirements ?? []).map((r) => `${r.requirementId}:${r.clauseText}:${r.effectSymbol}`).join("|")}`,
      )
      .exhaustive()
    govShaMap.set(
      d.path,
      computeContentSha256(
        `${d.id}:${d.title}:${d.status}:${(d.referencedSpans ?? []).join(",")}:${(d.referencedServices ?? []).join(",")}:${(d.referencedErrors ?? []).join(",")}:${extraHash}`,
      ),
    )
  }
  const patternShaMap = new Map<string, string>()
  for (const p of patternDocs) {
    patternShaMap.set(
      p.path,
      computeContentSha256(
        `${p.slug}:${p.title ?? ""}:${(p.headings ?? []).join("|")}:${p.summary}:${(p.coveredSpans ?? []).join(",")}:${(p.coveredTags ?? []).join(",")}`,
      ),
    )
  }
  return { govShaMap, patternShaMap }
}
