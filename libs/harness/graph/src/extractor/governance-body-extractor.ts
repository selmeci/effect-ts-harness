import {
  DocLineNumber,
  DocTreePath,
  EarsAreaName,
  EarsClauseText,
  EarsEffectSymbol,
  EarsPatternName,
  EarsRequirementNodeId,
  EarsVerificationKind,
  GovernanceDocIdentifier,
  RequirementId,
} from "@harness/contract"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type AdrDocNode,
  type EarsRequirementNode,
  type EarsSpecNode,
  type EffectFnNode,
  type GovernanceDocStatus,
  type HarnessEdge,
  type HarnessNode,
  NodeKey,
  RelationId,
  RoleName,
  type ServiceTagNode,
  type TaggedErrorNode,
  type TraceabilityTupleRelation,
  type UnresolvedGraphReference,
  getNodeKey,
} from "../model.js"
import {
  HEADING_RE,
  isTableSeparatorRow,
  iterNonFencedLines,
  normalizeEarsPattern,
  normalizeEffectSymbol,
  splitMarkdownTableCells,
  stripFrontmatterAndStartLine,
  stripMarkdownInline,
} from "./governance-markdown-helpers.js"

export interface ExtractedEarsRequirementRow {
  readonly id: EarsRequirementNodeId
  readonly specId: GovernanceDocIdentifier
  readonly requirementId: RequirementId
  readonly area: EarsAreaName
  readonly pattern: EarsPatternName
  readonly clauseText: EarsClauseText
  readonly effectSymbol: EarsEffectSymbol
  readonly verification: EarsVerificationKind
  readonly path: DocTreePath
  readonly line: DocLineNumber
  readonly status: GovernanceDocStatus
}

export const extractEarsRequirements = (
  specId: string,
  relPath: string,
  status: GovernanceDocStatus,
  content: string,
): ReadonlyArray<ExtractedEarsRequirementRow> => {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  const { startIndex } = stripFrontmatterAndStartLine(lines)
  const rows: Array<ExtractedEarsRequirementRow> = []
  const seenIds = new Set<string>()
  let currentArea = ""

  iterNonFencedLines(content, startIndex, (rawLine, i) => {
    const headingMatch = rawLine.match(HEADING_RE)
    if (headingMatch) {
      const depth = headingMatch[1]!.length
      if (depth >= 2 && depth <= 4) {
        const headingText = stripMarkdownInline(headingMatch[2]!)
        if (!/^requirements$/i.test(headingText)) currentArea = headingText
      }
      return
    }
    if (!rawLine.trim().startsWith("|")) return
    const cells = splitMarkdownTableCells(rawLine)
    if (cells.length < 3 || isTableSeparatorRow(cells)) return
    const rawReqId = stripMarkdownInline(cells[0] ?? "")
    if (!/^REQ-[A-Za-z0-9_.-]+$/.test(rawReqId)) return
    const pattern = stripMarkdownInline(cells[1] ?? "")
    const clauseText = stripMarkdownInline(cells[2] ?? "")
    if (clauseText.length === 0) return

    let uniqueReqId = rawReqId
    let suffix = 2
    while (seenIds.has(uniqueReqId)) {
      uniqueReqId = `${rawReqId}#${suffix}`
      suffix++
    }
    seenIds.add(uniqueReqId)

    rows.push({
      id: EarsRequirementNodeId.make(`${specId}::${uniqueReqId}`),
      specId: GovernanceDocIdentifier.make(specId),
      requirementId: RequirementId.make(uniqueReqId),
      area: EarsAreaName.make(currentArea.length > 0 ? currentArea : "General"),
      pattern: EarsPatternName.make(pattern.length > 0 ? pattern : "Ubiquitous"),
      clauseText: EarsClauseText.make(clauseText),
      effectSymbol: EarsEffectSymbol.make(normalizeEffectSymbol(cells[3])),
      verification: EarsVerificationKind.make(stripMarkdownInline(cells[4] ?? "") || "UnitTest"),
      path: DocTreePath.make(relPath),
      line: DocLineNumber.make(i + 1),
      status,
    })
  })

  return rows
}

const ADR_RELEVANT_SECTION_RE =
  /^(?:context|decision(?:\s+outcome)?|chosen\s+option|decision\s+drivers|considered\s+options|rejected\s+alternatives|consequences)/i

export const extractAdrSearchText = (title: string, content: string): string => {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  const { startIndex } = stripFrontmatterAndStartLine(lines)
  const parts: Array<string> = []
  let activeHeading = ""
  let includeSection = false

  iterNonFencedLines(content, startIndex, (rawLine) => {
    const headingMatch = rawLine.match(HEADING_RE)
    if (headingMatch) {
      activeHeading = stripMarkdownInline(headingMatch[2]!)
      includeSection = ADR_RELEVANT_SECTION_RE.test(activeHeading)
      if (includeSection) parts.push(`${activeHeading}:`)
      return
    }
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) return
    if (trimmed.startsWith("|") && isTableSeparatorRow(splitMarkdownTableCells(trimmed))) return
    if (
      includeSection ||
      /\bchosen option:/i.test(trimmed) ||
      (activeHeading === "" && !trimmed.startsWith("---"))
    ) {
      parts.push(stripMarkdownInline(trimmed))
    }
  })

  return `${stripMarkdownInline(title)}. ${parts.join(" ")}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400)
    .trim()
}

export const extractGovernanceSummary = (kind: "AdrDoc" | "EarsSpec", content: string): string => {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  const { startIndex } = stripFrontmatterAndStartLine(lines)
  const targetHeadingRe = match(kind)
    .with("EarsSpec", () => /^(?:goal|context)$/i)
    .with("AdrDoc", () => /^(?:decision\s+outcome|context)/i)
    .exhaustive()

  let inPreferredSection = false
  let donePreferred = false
  let directChoice: string | undefined
  const preferredLines: Array<string> = []
  const fallbackLines: Array<string> = []

  iterNonFencedLines(content, startIndex, (rawLine) => {
    if (directChoice !== undefined || donePreferred) return
    const headingMatch = rawLine.match(HEADING_RE)
    if (headingMatch) {
      if (preferredLines.length > 0) {
        donePreferred = true
        return
      }
      if (headingMatch[1]!.length >= 2) {
        inPreferredSection = targetHeadingRe.test(stripMarkdownInline(headingMatch[2]!))
      }
      return
    }
    const trimmed = rawLine.trim()
    if (trimmed.length === 0 || trimmed.startsWith("|") || trimmed.startsWith(">")) return
    const cleaned = stripMarkdownInline(trimmed)
    if (cleaned.length === 0) return
    const isDirectChoice = match(kind)
      .with("AdrDoc", () => {
        if (/\bchosen option:/i.test(cleaned)) {
          directChoice = cleaned.slice(0, 400).trim()
          return true
        }
        return false
      })
      .with("EarsSpec", () => false)
      .exhaustive()
    if (isDirectChoice) return
    match(inPreferredSection)
      .with(true, () => {
        preferredLines.push(cleaned)
      })
      .with(false, () => {
        if (fallbackLines.length < 3) fallbackLines.push(cleaned)
      })
      .exhaustive()
  })

  if (directChoice !== undefined) return directChoice
  return (preferredLines.length > 0 ? preferredLines : fallbackLines)
    .join(" ")
    .trim()
    .slice(0, 400)
    .trim()
}

export const linkExtractedEarsRequirements = (
  mutable: Graph.MutableDirectedGraph<HarnessNode, HarnessEdge>,
  docNode: EarsSpecNode,
  docIdx: Graph.NodeIndex,
  effectFns: ReadonlyArray<EffectFnNode>,
  serviceTags: ReadonlyArray<ServiceTagNode>,
  taggedErrors: ReadonlyArray<TaggedErrorNode>,
  updatedNodeIndexByKey: Map<string, Graph.NodeIndex>,
): void => {
  const requirements = docNode.requirements ?? []
  for (const req of requirements) {
    const reqNode: EarsRequirementNode = req
    const reqKey = getNodeKey(reqNode)
    const reqIdx = updatedNodeIndexByKey.get(reqKey) ?? Graph.addNode(mutable, reqNode)
    updatedNodeIndexByKey.set(reqKey, reqIdx)

    const matchedTargets: Array<string> = []
    const sym = req.effectSymbol.trim()
    if (sym.length > 0 && sym !== "—") {
      for (const fn of effectFns) {
        if (fn.spanName === sym || fn.qualname === sym || fn.qualname.endsWith(`#${sym}`)) {
          matchedTargets.push(getNodeKey(fn))
        }
      }
      for (const svc of serviceTags) {
        if (svc.tagId === sym || svc.name === sym || svc.tagId.endsWith(`#${sym}`)) {
          matchedTargets.push(getNodeKey(svc))
        }
      }
      for (const err of taggedErrors) {
        if (err.errorTag === sym) {
          matchedTargets.push(getNodeKey(err))
        }
      }
      const directSchemaKey = `SchemaDef:${sym}`
      if (updatedNodeIndexByKey.has(directSchemaKey)) {
        matchedTargets.push(directSchemaKey)
      }
      const directLayerKey = `ServiceLayer:${sym}`
      if (updatedNodeIndexByKey.has(directLayerKey)) {
        matchedTargets.push(directLayerKey)
      }
    }

    const dedupTargets = [...new Set(matchedTargets)]
    const primaryTargetQualname = dedupTargets[0] ?? req.id
    const relId = RelationId.make(`TraceabilityTuple:req:${docNode.id}#${req.requirementId}`)
    if (!updatedNodeIndexByKey.has(relId)) {
      const normalizedPattern = normalizeEarsPattern(req.pattern)
      const relNode: TraceabilityTupleRelation = {
        _tag: "TraceabilityTuple",
        relationId: relId,
        earsSpecId: docNode.id,
        requirementId: req.requirementId,
        ...(normalizedPattern !== undefined ? { earsPattern: normalizedPattern } : {}),
        targetSymbolQualname: primaryTargetQualname,
        verifyingTestQualnames: [],
      }
      const relIdx = Graph.addNode(mutable, relNode)
      updatedNodeIndexByKey.set(relId, relIdx)
      Graph.addEdge(mutable, relIdx, docIdx, {
        _tag: "PlaysRole",
        relationId: relId,
        entityKey: NodeKey.make(getNodeKey(docNode)),
        role: RoleName.make("specifying-ears"),
        archimateRelation: "Realization",
      })
      Graph.addEdge(mutable, relIdx, reqIdx, {
        _tag: "PlaysRole",
        relationId: relId,
        entityKey: NodeKey.make(reqKey),
        role: RoleName.make("specified-requirement"),
        archimateRelation: "Realization",
      })
      for (const targetKey of dedupTargets) {
        const targetIdx = updatedNodeIndexByKey.get(targetKey)
        if (targetIdx !== undefined) {
          Graph.addEdge(mutable, relIdx, targetIdx, {
            _tag: "PlaysRole",
            relationId: relId,
            entityKey: NodeKey.make(targetKey),
            role: RoleName.make("specified-target"),
            archimateRelation: "Realization",
          })
        }
      }
    }
  }
}

export const linkGovernanceDocsToGraph = (
  mutable: Graph.MutableDirectedGraph<HarnessNode, HarnessEdge>,
  governanceDocs: ReadonlyArray<AdrDocNode | EarsSpecNode>,
  effectFns: ReadonlyArray<EffectFnNode>,
  serviceTags: ReadonlyArray<ServiceTagNode>,
  taggedErrors: ReadonlyArray<TaggedErrorNode>,
  updatedNodeIndexByKey: Map<string, Graph.NodeIndex>,
  unresolvedReferences: Array<UnresolvedGraphReference>,
): void => {
  for (const docNode of governanceDocs) {
    const docKey = getNodeKey(docNode)
    const docIdx = Graph.addNode(mutable, docNode)
    updatedNodeIndexByKey.set(docKey, docIdx)
    const { kindPrefix, docRole, docArchimate, docIdField } = match(docNode)
      .with({ _tag: "AdrDoc" }, (d) => ({
        kindPrefix: "governs",
        docRole: "governing-adr",
        docArchimate: "Influence" as const,
        docIdField: { adrId: d.id },
      }))
      .with({ _tag: "EarsSpec" }, (d) => ({
        kindPrefix: "specifies",
        docRole: "specifying-ears",
        docArchimate: "Realization" as const,
        docIdField: { earsSpecId: d.id },
      }))
      .exhaustive()

    const addGovernanceTraceability = (targetKey: string, targetIdx: Graph.NodeIndex) => {
      const relId = RelationId.make(`TraceabilityTuple:${kindPrefix}:${docNode.id}->${targetKey}`)
      if (!updatedNodeIndexByKey.has(relId)) {
        const relNode: TraceabilityTupleRelation = {
          _tag: "TraceabilityTuple",
          relationId: relId,
          ...docIdField,
          targetSymbolQualname: targetKey,
          verifyingTestQualnames: [],
        }
        const relIdx = Graph.addNode(mutable, relNode)
        updatedNodeIndexByKey.set(relId, relIdx)
        Graph.addEdge(mutable, relIdx, docIdx, {
          _tag: "PlaysRole",
          relationId: relId,
          entityKey: NodeKey.make(docKey),
          role: RoleName.make(docRole),
          archimateRelation: docArchimate,
        })
        Graph.addEdge(mutable, relIdx, targetIdx, {
          _tag: "PlaysRole",
          relationId: relId,
          entityKey: NodeKey.make(targetKey),
          role: RoleName.make("realizing-symbol"),
          archimateRelation: "Realization",
        })
      }
    }

    const linkGovRefs = <T extends HarnessNode>(
      items: ReadonlyArray<string> | undefined,
      nodes: ReadonlyArray<T>,
      matchFn: (item: string, node: T) => boolean,
    ) => {
      const added = new Set<string>()
      for (const item of items ?? []) {
        let found = false
        for (const n of nodes) {
          if (matchFn(item, n)) {
            found = true
            const k = getNodeKey(n),
              idx = !added.has(k) ? updatedNodeIndexByKey.get(k) : undefined
            if (!added.has(k)) {
              added.add(k)
              if (idx !== undefined) addGovernanceTraceability(k, idx)
            }
          }
        }
        if (!found)
          unresolvedReferences.push({
            relationId: `TraceabilityTuple:${kindPrefix}:${docNode.id}->${item}`,
            role: "realizing-symbol",
            targetKey: item,
            file: docNode.path,
          })
      }
    }

    linkGovRefs(
      docNode.referencedSpans,
      effectFns,
      (s, n) => n.spanName === s || n.qualname === s || n.qualname.endsWith(`#${s}`),
    )
    linkGovRefs(
      docNode.referencedServices,
      serviceTags,
      (s, n) => n.tagId === s || n.name === s || n.tagId.endsWith(`#${s}`),
    )
    linkGovRefs(docNode.referencedErrors, taggedErrors, (s, n) => n.errorTag === s)
    match(docNode)
      .with({ _tag: "EarsSpec" }, (spec) =>
        linkExtractedEarsRequirements(
          mutable,
          spec,
          docIdx,
          effectFns,
          serviceTags,
          taggedErrors,
          updatedNodeIndexByKey,
        ),
      )
      .with({ _tag: "AdrDoc" }, () => undefined)
      .exhaustive()
  }
}
