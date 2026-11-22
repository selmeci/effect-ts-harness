import * as path from "node:path"
import type { SyncHostIo } from "@harness/service/host-io"
import { match } from "ts-pattern"
import {
  type AdrDocNode,
  AdrStatus,
  type BranchingViolation,
  type EarsSpecNode,
  EarsStatus,
  ViolationRule,
} from "../model.js"
import { resolveRepoRoot } from "./extractor-types-and-helpers.js"

export type ParseGovernanceDocFileResult =
  | { readonly _tag: "Ok"; readonly node: AdrDocNode | EarsSpecNode }
  | { readonly _tag: "Skip" }
  | {
      readonly _tag: "InvalidStatus"
      readonly id: string
      readonly path: string
      readonly rawStatus: string | undefined
      readonly reason: string
    }

const isAdrStatusValue = (value: string | undefined): value is AdrStatus =>
  value === "accepted" || value === "proposed" || value === "superseded" || value === "deprecated"

const isEarsStatusValue = (value: string | undefined): value is EarsStatus =>
  value === "draft" || isAdrStatusValue(value)

const stripFmQuotes = (val: string): string => {
  const t = val.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim()
  }
  const hashIdx = t.indexOf("#")
  return hashIdx !== -1 ? t.slice(0, hashIdx).trim() : t
}

export const parseGovernanceDocFileChecked = (
  relDocPath: string,
  content: string,
): ParseGovernanceDocFileResult => {
  const isAdrDoc = relDocPath.includes("/adr/")
  const isSpecDoc = relDocPath.includes("/specs/")
  if (!isAdrDoc && !isSpecDoc) return { _tag: "Skip" }

  const normalized = content.replace(/^\uFEFF/, "")
  const matchFm = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!matchFm || matchFm[1] === undefined) return { _tag: "Skip" }

  const lines = matchFm[1].split(/\r?\n/)
  const scalars = new Map<string, string>()
  const lists = new Map<string, Array<string>>()
  let currentListKey: string | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripFmQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) lists.get(currentListKey)?.push(item)
      continue
    }
    currentListKey = null
    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim()
      const rest = keyValMatch[2]!.trim()
      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        lists.set(
          key,
          inner.length === 0
            ? []
            : inner
                .split(",")
                .map(stripFmQuotes)
                .filter((s) => s.length > 0),
        )
        continue
      }
      if (rest === "") {
        lists.set(key, [])
        currentListKey = key
        continue
      }
      scalars.set(key, stripFmQuotes(rest))
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") return { _tag: "Skip" }

  let title = scalars.get("title")
  if (!title || title.trim() === "") {
    const bodyAfterFm = normalized.slice(matchFm[0].length)
    const titleMatch = bodyAfterFm.match(/^#\s+(.+)$/m)
    title = titleMatch ? titleMatch[1]!.trim() : id
  }

  const rawStatus = scalars.get("status")
  const enforcedByFiles = lists.get("enforced_by") ?? []
  const referencedSpans = lists.get("spans") ?? []
  const referencedServices = lists.get("services") ?? []
  const referencedErrors = lists.get("errors") ?? []

  if (isAdrDoc) {
    if (!isAdrStatusValue(rawStatus)) {
      return {
        _tag: "InvalidStatus",
        id,
        path: relDocPath,
        rawStatus,
        reason: `ADR '${id}' (${relDocPath}) declares unrecognized or missing status '${rawStatus ?? "<missing>"}' (allowed: proposed, accepted, superseded, deprecated).`,
      }
    }
    return {
      _tag: "Ok",
      node: {
        _tag: "AdrDoc",
        id,
        title,
        status: rawStatus,
        path: relDocPath,
        enforcedByFiles,
        referencedSpans,
        referencedServices,
        referencedErrors,
      },
    }
  }

  if (!isEarsStatusValue(rawStatus)) {
    return {
      _tag: "InvalidStatus",
      id,
      path: relDocPath,
      rawStatus,
      reason: `EARS Spec '${id}' (${relDocPath}) declares unrecognized or missing status '${rawStatus ?? "<missing>"}' (allowed: draft, proposed, accepted, superseded, deprecated).`,
    }
  }
  return {
    _tag: "Ok",
    node: {
      _tag: "EarsSpec",
      id,
      title,
      status: rawStatus,
      path: relDocPath,
      enforcedByFiles,
      referencedSpans,
      referencedServices,
      referencedErrors,
    },
  }
}

export const parseGovernanceDocFile = (
  relDocPath: string,
  content: string,
): AdrDocNode | EarsSpecNode | null =>
  match(parseGovernanceDocFileChecked(relDocPath, content))
    .with({ _tag: "Ok" }, ({ node }) => node)
    .with({ _tag: "Skip" }, { _tag: "InvalidStatus" }, () => null)
    .exhaustive()

export const loadWorkspaceGovernanceDocsWithViolations = (
  repoRoot: string,
  hostIo: SyncHostIo,
): {
  readonly docs: ReadonlyArray<AdrDocNode | EarsSpecNode>
  readonly violations: ReadonlyArray<BranchingViolation>
} => {
  const root = resolveRepoRoot(repoRoot, hostIo)
  const candidateRelDirs: Array<string> = ["docs/adr", "docs/specs"]
  const listSubdirs = (p: string) =>
    !hostIo.existsSync(path.join(root, p))
      ? []
      : hostIo
          .readdirSync(path.join(root, p))
          .filter((e) => e.isDirectory)
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b))
  for (const s of listSubdirs("libs")) {
    candidateRelDirs.push(`libs/${s}/docs/adr`, `libs/${s}/docs/specs`)
  }
  for (const a of listSubdirs("apps")) {
    candidateRelDirs.push(`apps/${a}/docs/adr`, `apps/${a}/docs/specs`)
  }

  const docs: Array<AdrDocNode | EarsSpecNode> = []
  const violations: Array<BranchingViolation> = []
  for (const relDir of candidateRelDirs) {
    const fullDir = path.join(root, relDir)
    if (!hostIo.existsSync(fullDir)) continue
    const files = hostIo
      .readdirSync(fullDir)
      .filter(
        (e) =>
          e.isFile && e.name.endsWith(".md") && e.name !== "README.md" && e.name !== "TEMPLATE.md",
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const parsed = parseGovernanceDocFileChecked(
        relDocPath,
        hostIo.readTextSync(path.join(root, relDocPath)),
      )
      match(parsed)
        .with({ _tag: "Ok" }, ({ node }) => {
          docs.push(node)
        })
        .with({ _tag: "InvalidStatus" }, ({ id, path: docPath, rawStatus, reason }) => {
          violations.push({
            rule: ViolationRule.make("unmapped-spec-symbol"),
            message: reason,
            file: docPath,
            line: 1,
            enclosingSymbol: id,
            path: [id, rawStatus ?? "<missing>"],
          })
        })
        .with({ _tag: "Skip" }, () => {})
        .exhaustive()
    }
  }
  return { docs, violations }
}

export const loadWorkspaceGovernanceDocs = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<AdrDocNode | EarsSpecNode> =>
  loadWorkspaceGovernanceDocsWithViolations(repoRoot, hostIo).docs
