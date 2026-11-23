import * as path from "node:path"
import * as Graph from "effect/Graph"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  DocHeadingLevel,
  DocHeadingTitle,
  DocLineNumber,
  DocSectionId,
  DocSectionSliceText,
  DocSummarySnippet,
  type DocTreeHeadingNode,
  type DocTreeInput,
  DocTreePath,
  DocTreePathError,
  type DocTreeResponse,
  type GovernanceCatalogEntry,
  GovernanceDocIdentifier,
  GovernanceDocLifecycleStatus,
  NonNegativeCount,
  WorkspaceFilePath,
  toErrorReasonMessage,
  type WorkspaceFileContent,
} from "@harness/contract"
import { WorkspaceFs } from "@harness/service"
import type { HarnessGraph } from "./model.js"

const ALLOWED_DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".mdx", ".pg", ".gq"])
const MAX_PREVIEW_CHARS = 180
const MAX_SECTION_SLICE_LINES = 250

const advanceFence = (
  trimmed: string,
  state: { inFence: boolean; fenceChar: string; fenceLength: number },
): boolean => {
  const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
  if (!fenceMatch) return false
  const marker = fenceMatch[1]!
  const rest = fenceMatch[2] ?? ""
  const ch = marker[0] ?? "`"
  return match(state.inFence)
    .with(false, () => {
      state.inFence = true
      state.fenceChar = ch
      state.fenceLength = marker.length
      return true
    })
    .with(true, () => {
      if (
        ch === state.fenceChar &&
        marker.length >= state.fenceLength &&
        rest.trim().length === 0
      ) {
        state.inFence = false
        state.fenceChar = ""
        state.fenceLength = 0
        return true
      }
      return false
    })
    .exhaustive()
}

const extractPreviewFromLines = (
  lines: ReadonlyArray<string>,
  startIdx: number,
  endIdx: number,
): string => {
  const fence = { inFence: false, fenceChar: "", fenceLength: 0 }
  for (let i = startIdx; i <= endIdx && i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim()
    if (
      advanceFence(trimmed, fence) ||
      fence.inFence ||
      trimmed.length === 0 ||
      trimmed === "---"
    ) {
      continue
    }
    const cleaned = trimmed
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim()
    if (cleaned.length > 0) {
      return cleaned.slice(0, MAX_PREVIEW_CHARS)
    }
  }
  return ""
}

const parseMarkdownTreeSync = (content: string): ReadonlyArray<DocTreeHeadingNode> => {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  const rawHeadings: Array<{
    readonly level: number
    readonly title: string
    readonly startLine: number
    readonly sectionId: string
  }> = []

  let i = 0
  if (lines.length > 0 && /^---\s*$/.test((lines[0] ?? "").trim())) {
    for (let fm = 1; fm < lines.length; fm++) {
      if (/^---\s*$/.test((lines[fm] ?? "").trim())) {
        i = fm + 1
        break
      }
    }
  }

  const fence = { inFence: false, fenceChar: "", fenceLength: 0 }
  let ordinal = 0

  for (; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (advanceFence(line.trim(), fence) || fence.inFence) continue

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!headingMatch) continue

    ordinal++
    const level = headingMatch[1]!.length
    const rawTitle = headingMatch[2]!.replace(/\s+#+\s*$/, "").trim()
    const title = rawTitle.length > 0 ? rawTitle : `Section ${ordinal}`
    rawHeadings.push({
      level,
      title,
      startLine: i + 1,
      sectionId: `h${level}-${ordinal}`,
    })
  }

  const totalLines = lines.length
  return rawHeadings.map((h, idx) => {
    let endLine = totalLines
    for (let j = idx + 1; j < rawHeadings.length; j++) {
      const next = rawHeadings[j]!
      if (next.level <= h.level) {
        endLine = Math.max(h.startLine, next.startLine - 1)
        break
      }
    }
    const preview = extractPreviewFromLines(lines, h.startLine, endLine - 1)
    return {
      sectionId: DocSectionId.make(h.sectionId),
      level: DocHeadingLevel.make(h.level),
      title: DocHeadingTitle.make(h.title.slice(0, 4096)),
      startLine: DocLineNumber.make(h.startLine),
      endLine: DocLineNumber.make(Math.max(h.startLine, endLine)),
      preview: DocSummarySnippet.make(preview),
    }
  })
}

export const parseMarkdownTree = Effect.fn("DocTree.parseMarkdownTree")(function* (
  content: WorkspaceFileContent,
): Effect.fn.Return<ReadonlyArray<DocTreeHeadingNode>, never, never> {
  return yield* Effect.succeed(parseMarkdownTreeSync(content))
})

const buildGovernanceCatalogSync = (graph: HarnessGraph): ReadonlyArray<GovernanceCatalogEntry> => {
  const entries: Array<GovernanceCatalogEntry> = []
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "AdrDoc" }, (adr) => {
        entries.push({
          id: GovernanceDocIdentifier.make(adr.id),
          kind: "AdrDoc" as const,
          title: DocHeadingTitle.make((adr.title.trim() || adr.id).slice(0, 4096)),
          status: GovernanceDocLifecycleStatus.make(adr.status),
          path: DocTreePath.make(adr.path),
          summary: DocSummarySnippet.make(adr.summary ?? adr.searchText ?? adr.title),
          informedByAdrs: [],
          requirementCount: NonNegativeCount.make(0),
          sections: [],
        })
      })
      .with({ _tag: "EarsSpec" }, (spec) => {
        entries.push({
          id: GovernanceDocIdentifier.make(spec.id),
          kind: "EarsSpec" as const,
          title: DocHeadingTitle.make((spec.title.trim() || spec.id).slice(0, 4096)),
          status: GovernanceDocLifecycleStatus.make(spec.status),
          path: DocTreePath.make(spec.path),
          summary: DocSummarySnippet.make(spec.goalSummary ?? spec.title),
          informedByAdrs: (spec.informedByAdrs ?? []).map((id) => GovernanceDocIdentifier.make(id)),
          requirementCount: NonNegativeCount.make(spec.requirements?.length ?? 0),
          sections: [],
        })
      })
      .with(
        { _tag: "EarsRequirement" },
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  return entries.sort((a, b) => compareCodeUnits(a.id, b.id))
}

export const buildGovernanceCatalog = Effect.fn("DocTree.buildGovernanceCatalog")(function* (
  graph: HarnessGraph,
): Effect.fn.Return<ReadonlyArray<GovernanceCatalogEntry>, never, never> {
  return yield* Effect.succeed(buildGovernanceCatalogSync(graph))
})

export interface DocTreeInspectRequest {
  readonly repoRoot: WorkspaceFilePath
  readonly input: DocTreeInput
  readonly graph: HarnessGraph
}

const makePathError = (requestedPath: string, reason: string): DocTreePathError =>
  new DocTreePathError({
    requestedPath: DocTreePath.make(requestedPath.trim() || "<empty>"),
    reason: toErrorReasonMessage(reason),
  })

const resolveValidatedDocFile = Effect.fn("DocTree.resolveValidatedDocFile")(function* (
  repoRoot: WorkspaceFilePath,
  rawRequestedPath: DocTreePath | undefined,
): Effect.fn.Return<
  {
    readonly relPath: DocTreePath
    readonly absPath: WorkspaceFilePath
  },
  DocTreePathError
> {
  if (rawRequestedPath === undefined || rawRequestedPath.trim().length === 0) {
    return yield* makePathError("<empty>", "Missing required 'path' parameter")
  }
  const normalizedInput = rawRequestedPath.trim()
  if (normalizedInput.includes("\0")) {
    return yield* makePathError(normalizedInput, "Null byte in path is forbidden")
  }
  const resolvedRoot = path.resolve(repoRoot)
  if (path.isAbsolute(normalizedInput)) {
    const relFromAbs = path.relative(resolvedRoot, path.resolve(normalizedInput))
    if (relFromAbs === "" || relFromAbs.startsWith("..") || path.isAbsolute(relFromAbs)) {
      return yield* makePathError(normalizedInput, "Path escapes repository root boundary")
    }
    const extAbs = path.extname(relFromAbs).toLowerCase()
    if (!ALLOWED_DOC_EXTENSIONS.has(extAbs)) {
      return yield* makePathError(
        normalizedInput,
        `Unsupported documentation file extension '${extAbs || "<none>"}'`,
      )
    }
    return {
      relPath: DocTreePath.make(relFromAbs.replace(/\\/g, "/")),
      absPath: WorkspaceFilePath.make(path.resolve(resolvedRoot, relFromAbs)),
    }
  }

  const candidateAbs = path.resolve(resolvedRoot, normalizedInput)
  const rel = path.relative(resolvedRoot, candidateAbs)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return yield* makePathError(normalizedInput, "Path escapes repository root boundary")
  }
  const ext = path.extname(rel).toLowerCase()
  if (!ALLOWED_DOC_EXTENSIONS.has(ext)) {
    return yield* makePathError(
      normalizedInput,
      `Unsupported documentation file extension '${ext || "<none>"}'`,
    )
  }
  return {
    relPath: DocTreePath.make(rel.replace(/\\/g, "/")),
    absPath: WorkspaceFilePath.make(candidateAbs),
  }
})

const readValidatedDocument = Effect.fn("DocTree.readValidatedDocument")(function* (
  repoRoot: WorkspaceFilePath,
  requestedPath: DocTreePath | undefined,
): Effect.fn.Return<
  {
    readonly relPath: DocTreePath
    readonly lines: ReadonlyArray<string>
    readonly sections: ReadonlyArray<DocTreeHeadingNode>
  },
  DocTreePathError,
  WorkspaceFs
> {
  const fs = yield* WorkspaceFs
  const { relPath, absPath } = yield* resolveValidatedDocFile(repoRoot, requestedPath)
  const exists = yield* fs
    .exists(absPath)
    .pipe(
      Effect.mapError((err) =>
        makePathError(relPath, `Failed checking file '${relPath}': ${err.message}`),
      ),
    )
  if (!exists) {
    return yield* makePathError(relPath, `Document file does not exist: ${relPath}`)
  }
  const realRoot = yield* fs
    .realPath(WorkspaceFilePath.make(path.resolve(repoRoot)))
    .pipe(
      Effect.mapError((err) =>
        makePathError(relPath, `Failed resolving repository root '${repoRoot}': ${err.message}`),
      ),
    )
  const realTarget = yield* fs
    .realPath(absPath)
    .pipe(
      Effect.mapError((err) =>
        makePathError(relPath, `Failed resolving document path '${relPath}': ${err.message}`),
      ),
    )
  const realRel = path.relative(realRoot, realTarget)
  if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return yield* makePathError(relPath, "Resolved symlink target escapes repository root boundary")
  }
  const realExt = path.extname(realTarget).toLowerCase()
  if (!ALLOWED_DOC_EXTENSIONS.has(realExt)) {
    return yield* makePathError(
      relPath,
      `Unsupported resolved documentation file extension '${realExt || "<none>"}'`,
    )
  }
  const content = yield* fs
    .readTextFile(realTarget)
    .pipe(
      Effect.mapError((err) =>
        makePathError(relPath, `Failed reading file '${relPath}': ${err.message}`),
      ),
    )
  return {
    relPath,
    lines: content.replace(/^\uFEFF/, "").split(/\r?\n/),
    sections: parseMarkdownTreeSync(content),
  }
})

export const inspectDocTree = Effect.fn("DocTree.inspect")(function* (
  request: DocTreeInspectRequest,
): Effect.fn.Return<DocTreeResponse, DocTreePathError, WorkspaceFs> {
  const { input, repoRoot, graph } = request

  return yield* match(input.mode)
    .with("catalog", () => {
      const allEntries = buildGovernanceCatalogSync(graph)
      const scope = input.scope?.trim()
      const filtered =
        scope !== undefined && scope.length > 0
          ? allEntries.filter(
              (entry) =>
                entry.id.startsWith(`${scope}:`) ||
                entry.path.includes(`libs/${scope}/`) ||
                entry.path.includes(`apps/${scope}/`) ||
                entry.path.includes(`packages/${scope}/`),
            )
          : allEntries
      return Effect.succeed({
        _tag: "GovernanceCatalog" as const,
        totalDocs: NonNegativeCount.make(filtered.length),
        entries: filtered,
      } satisfies DocTreeResponse)
    })
    .with("tree", () =>
      Effect.gen(function* () {
        const { relPath, lines, sections } = yield* readValidatedDocument(repoRoot, input.path)
        return {
          _tag: "DocumentTree" as const,
          path: relPath,
          totalLines: NonNegativeCount.make(lines.length),
          sections,
        } satisfies DocTreeResponse
      }),
    )
    .with("section", () =>
      Effect.gen(function* () {
        const { relPath, lines, sections } = yield* readValidatedDocument(repoRoot, input.path)
        const requestedSectionId = input.sectionId?.trim()
        if (requestedSectionId === undefined || requestedSectionId.length === 0) {
          return yield* makePathError(
            relPath,
            "Missing required 'sectionId' parameter for section mode",
          )
        }
        const section = sections.find((s) => s.sectionId === requestedSectionId)
        if (section === undefined) {
          return yield* makePathError(
            relPath,
            `Unknown sectionId '${requestedSectionId}' in ${relPath}`,
          )
        }
        const boundedEnd = Math.min(
          section.endLine,
          section.startLine + MAX_SECTION_SLICE_LINES - 1,
        )
        const slice = lines.slice(section.startLine - 1, boundedEnd).join("\n")
        return {
          _tag: "SectionContent" as const,
          path: relPath,
          section,
          content: DocSectionSliceText.make(slice),
        } satisfies DocTreeResponse
      }),
    )
    .exhaustive()
})
