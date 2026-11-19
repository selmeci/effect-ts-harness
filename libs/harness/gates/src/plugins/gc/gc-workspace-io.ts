import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import type { SyncHostDirEntry, SyncHostIo } from "@harness/service/host-io"
import type { GovernanceDocStatus } from "@harness/graph"
import { isModularPluginPath } from "../self-dogfooding-plugin.js"

export const GcFindingKind = Schema.Literals([
  "unused-service",
  "unprovided-service",
  "dead-tagged-error",
  "orphan-effect-fn",
  "missing-pattern-doc",
  "untested-effect-fn",
  "missing-decider-property-test",
  "shallow-decider-property-test",
  "empty-source-module",
  "unused-package-dependency",
  "stale-doc-reference",
  "ears-spec-lint",
  "adr-doc-lint",
  "ontology-invariant",
  "unused-contract-export",
  "node-sqlite-in-infra",
  "unmanaged-sql-ddl",
  "invalid-migrator-record-key",
  "unsafe-sql-migration",
  "untrusted-row-brand-make",
  "architecture-policy-violation",
  "unreadable-workspace-file",
  "governance-doc-read-error",
  "inline-test-ddl-bypassing-migrations",
  "doc-unknown-package-name",
  "doc-unknown-rule-id",
  "doc-missing-file-path",
  "agents-duplicate-section",
  "adapter-rules-drift",
  "hook-timeout-parity",
  "hook-bootstrap-fail-closed",
  "skill-tier-table-drift",
  "mermaid-dependency-drift",
  "doc-banned-or-phantom-tech",
  "stale-gate-rule-version",
  "contract-test-effect-vitest-import",
  "chained-equality-ternary",
  "hook-fastpath-forbidden-import",
])
export type GcFindingKind = typeof GcFindingKind.Type

export const GcFinding = Schema.Struct({
  kind: GcFindingKind,
  nodeId: Schema.String,
  message: Schema.String,
  location: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
})
export type GcFinding = typeof GcFinding.Type

export const GovernanceDocRef = Schema.Struct({
  docPath: Schema.String,
  id: Schema.String,
  status: Schema.Literals(["accepted", "proposed", "superseded", "deprecated"]),
  markdown: Schema.optional(Schema.String),
  enforcedByFiles: Schema.optional(Schema.Array(Schema.String)),
  existingFiles: Schema.optional(Schema.Array(Schema.String)),
  referencedSpans: Schema.optional(Schema.Array(Schema.String)),
  referencedServices: Schema.optional(Schema.Array(Schema.String)),
  referencedErrors: Schema.optional(Schema.Array(Schema.String)),
  enforcedByFileContents: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type GovernanceDocRef = typeof GovernanceDocRef.Type
export type GovernanceDocReference = GovernanceDocRef

export type ParseGovernanceDocFrontmatterResult =
  | { readonly _tag: "Ok"; readonly doc: GovernanceDocReference }
  | { readonly _tag: "Err"; readonly reason: string }

const FRONTMATTER_LIST_KEYS = new Set(["enforced_by", "spans", "services", "errors"])

const stripFrontmatterQuotes = (val: string): string => {
  const t = val.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim()
  }
  const hash = t.indexOf("#")
  return hash !== -1 ? t.slice(0, hash).trim() : t
}

export const parseGovernanceDocFrontmatterChecked = (
  docPath: string,
  markdown: string,
  existingFileCheck?: (relPath: string) => boolean,
): ParseGovernanceDocFrontmatterResult => {
  const normalized = markdown.replace(/^\uFEFF/, "")
  const matchFrontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!matchFrontmatter || matchFrontmatter[1] === undefined) {
    return { _tag: "Err", reason: `Missing YAML frontmatter block in '${docPath}'.` }
  }

  const lines = matchFrontmatter[1].split(/\r?\n/)
  const scalars = new Map<string, string>(),
    lists = new Map<string, Array<string>>()
  let currentListKey: string | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch) {
      if (currentListKey === null) {
        return {
          _tag: "Err",
          reason: `List item outside list key in frontmatter of '${docPath}': '${rawLine}'.`,
        }
      }
      const item = stripFrontmatterQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) {
        const l = lists.get(currentListKey)
        if (l) l.push(item)
      }
      continue
    }
    currentListKey = null
    const kv = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (!kv) {
      return {
        _tag: "Err",
        reason: `Malformed frontmatter line in '${docPath}': '${rawLine}'.`,
      }
    }
    const key = kv[1]!.trim(),
      rest = kv[2]!.trim()
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) {
        return {
          _tag: "Err",
          reason: `Unclosed inline array for '${key}' in frontmatter of '${docPath}'.`,
        }
      }
      const inner = rest.slice(1, -1).trim()
      lists.set(
        key,
        inner.length === 0
          ? []
          : inner
              .split(",")
              .map(stripFrontmatterQuotes)
              .filter((s) => s.length > 0),
      )
      continue
    }
    if (rest === "") {
      lists.set(key, [])
      currentListKey = key
      continue
    }
    if (FRONTMATTER_LIST_KEYS.has(key)) {
      return {
        _tag: "Err",
        reason: `Expected list value for '${key}' in frontmatter of '${docPath}', got scalar.`,
      }
    }
    scalars.set(key, stripFrontmatterQuotes(rest))
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") {
    return { _tag: "Err", reason: `Missing or empty 'id' in frontmatter of '${docPath}'.` }
  }
  const rawStatus = scalars.get("status")
  if (
    rawStatus !== "accepted" &&
    rawStatus !== "proposed" &&
    rawStatus !== "superseded" &&
    rawStatus !== "deprecated"
  ) {
    return {
      _tag: "Err",
      reason: `Invalid or missing 'status' (${rawStatus ?? "<missing>"}) in frontmatter of '${docPath}'.`,
    }
  }
  const status: GovernanceDocStatus = rawStatus

  const enforcedByRaw = lists.get("enforced_by")
  const enforcedByFiles: ReadonlyArray<string> | undefined = enforcedByRaw
  const existingFiles: ReadonlyArray<string> | undefined =
    enforcedByRaw !== undefined
      ? existingFileCheck
        ? enforcedByRaw.filter(existingFileCheck)
        : [...enforcedByRaw]
      : undefined
  const referencedSpans = lists.get("spans"),
    referencedServices = lists.get("services"),
    referencedErrors = lists.get("errors")
  const isSpecOrAdr =
    docPath.includes("/specs/") ||
    docPath.includes("/adr/") ||
    id.includes(":SPEC-") ||
    id.includes(":ADR-") ||
    id.startsWith("ADR-") ||
    id.startsWith("SPEC-")

  return {
    _tag: "Ok",
    doc: {
      docPath,
      id,
      status,
      ...(isSpecOrAdr ? { markdown } : {}),
      ...(enforcedByFiles !== undefined ? { enforcedByFiles, existingFiles } : {}),
      ...(referencedSpans !== undefined ? { referencedSpans } : {}),
      ...(referencedServices !== undefined ? { referencedServices } : {}),
      ...(referencedErrors !== undefined ? { referencedErrors } : {}),
    },
  }
}

export const parseGovernanceDocFrontmatter = (
  docPath: string,
  markdown: string,
  existingFileCheck?: (relPath: string) => boolean,
): GovernanceDocReference | null =>
  match(parseGovernanceDocFrontmatterChecked(docPath, markdown, existingFileCheck))
    .with({ _tag: "Ok" }, ({ doc }) => doc)
    .with({ _tag: "Err" }, () => null)
    .exhaustive()

export const formatRelPath = (repoRoot: string, absPath: string): string =>
  relative(repoRoot, absPath).replace(/\\/g, "/") || "."

export const readTextOrReport = (
  absPath: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): string | undefined =>
  match(Result.try(() => hostIo.readTextSync(absPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const relPath = formatRelPath(repoRoot, absPath)
      findings.push({
        kind: "unreadable-workspace-file",
        nodeId: relPath,
        location: relPath,
        message: `Failed to read workspace file "${relPath}": ${String(failure)}`,
        action: `Restore read permissions or fix the broken path at "${relPath}".`,
      })
      return undefined
    })
    .exhaustive()

export const readdirOrReport = (
  absDirPath: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): ReadonlyArray<SyncHostDirEntry> | undefined =>
  match(Result.try(() => hostIo.readdirSync(absDirPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const relPath = formatRelPath(repoRoot, absDirPath)
      findings.push({
        kind: "unreadable-workspace-file",
        nodeId: relPath,
        location: relPath,
        message: `Failed to read workspace directory "${relPath}": ${String(failure)}`,
        action: `Restore directory permissions or fix the broken directory at "${relPath}".`,
      })
      return undefined
    })
    .exhaustive()

const existsGuardedOrReport = (
  absPath: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): boolean =>
  match(Result.try(() => hostIo.existsSync(absPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const relPath = formatRelPath(repoRoot, absPath)
      findings.push({
        kind: "unreadable-workspace-file",
        nodeId: relPath,
        location: relPath,
        message: `Failed to stat workspace path "${relPath}": ${String(failure)}`,
        action: `Restore permissions or fix the broken path at "${relPath}".`,
      })
      return false
    })
    .exhaustive()

export const loadGovernanceDocsFromDisk = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings?: Array<GcFinding>,
): ReadonlyArray<GovernanceDocReference> => {
  const sink = findings ?? []
  const relDirs: Array<string> = ["docs/adr", "docs/specs"]
  const listSubs = (p: string): ReadonlyArray<string> => {
    const full = join(repoRoot, p)
    if (!existsGuardedOrReport(full, hostIo, repoRoot, sink)) return []
    const entries = readdirOrReport(full, hostIo, repoRoot, sink)
    if (entries === undefined) return []
    return entries
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort(compareCodeUnits)
  }
  for (const s of listSubs("libs")) relDirs.push(`libs/${s}/docs/adr`, `libs/${s}/docs/specs`)
  for (const a of listSubs("apps")) relDirs.push(`apps/${a}/docs/adr`, `apps/${a}/docs/specs`)

  const results: Array<GovernanceDocReference> = []
  for (const relDir of relDirs) {
    const fullDir = join(repoRoot, relDir)
    if (!existsGuardedOrReport(fullDir, hostIo, repoRoot, sink)) continue
    const dirEntries = readdirOrReport(fullDir, hostIo, repoRoot, sink)
    if (dirEntries === undefined) continue
    const files = dirEntries
      .filter(
        (e) =>
          e.isFile && e.name.endsWith(".md") && e.name !== "README.md" && e.name !== "TEMPLATE.md",
      )
      .map((e) => e.name)
      .sort(compareCodeUnits)
    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const absDocPath = join(repoRoot, relDocPath)
      const isSym = match(Result.try(() => hostIo.isSymbolicLinkSync(absDocPath)))
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, ({ failure }) => {
          sink.push({
            kind: "governance-doc-read-error",
            nodeId: relDocPath,
            location: relDocPath,
            message: `Failed to check symlink status for governance doc '${relDocPath}': ${String(failure)}`,
            action: `Fix permissions or replace symlink at '${relDocPath}' with a regular file.`,
          })
          return true
        })
        .exhaustive()
      if (isSym) {
        sink.push({
          kind: "governance-doc-read-error",
          nodeId: relDocPath,
          location: relDocPath,
          message: `Refusing symlink governance doc '${relDocPath}'.`,
          action: `Replace symlink '${relDocPath}' with a regular markdown file.`,
        })
        continue
      }
      const content = readTextOrReport(absDocPath, hostIo, repoRoot, sink)
      if (content === undefined) continue
      const parsedRes = parseGovernanceDocFrontmatterChecked(relDocPath, content, (rel) =>
        existsGuardedOrReport(join(repoRoot, rel), hostIo, repoRoot, sink),
      )
      const parsed = match(parsedRes)
        .with({ _tag: "Ok" }, ({ doc }) => doc)
        .with({ _tag: "Err" }, ({ reason }) => {
          sink.push({
            kind: "governance-doc-read-error",
            nodeId: relDocPath,
            location: relDocPath,
            message: reason,
            action: `Fix the YAML frontmatter in '${relDocPath}' (requires non-empty id and valid status: accepted | proposed | superseded | deprecated).`,
          })
          return undefined
        })
        .exhaustive()
      if (parsed === undefined) continue
      const enforcedByFileContents: Record<string, string> = {}
      for (const ef of parsed.enforcedByFiles ?? []) {
        const fullEf = join(repoRoot, ef)
        if (existsGuardedOrReport(fullEf, hostIo, repoRoot, sink)) {
          const efContent = readTextOrReport(fullEf, hostIo, repoRoot, sink)
          if (efContent !== undefined) enforcedByFileContents[ef] = efContent
        }
      }
      const isSpecOrAdr =
        relDir.endsWith("/specs") ||
        relDir.endsWith("/adr") ||
        parsed.id.includes(":SPEC-") ||
        parsed.id.includes(":ADR-") ||
        parsed.id.startsWith("ADR-") ||
        parsed.id.startsWith("SPEC-")
      results.push({
        ...parsed,
        ...(isSpecOrAdr ? { markdown: content } : {}),
        enforcedByFileContents,
      })
    }
  }
  if (findings === undefined && sink.length > 0) {
    const summary = sink
      .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
      .join("\n")
    process.stderr.write(`loadGovernanceDocsFromDisk warnings (${sink.length}):\n${summary}\n`)
  }
  return results
}

export const loadGovernanceDocsChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): {
  readonly docs: ReadonlyArray<GovernanceDocReference>
  readonly findings: ReadonlyArray<GcFinding>
} => {
  if ((hostIo as SyncHostIo | undefined) === undefined) {
    return {
      docs: [],
      findings: [
        {
          kind: "governance-doc-read-error",
          nodeId: "loadGovernanceDocsChecked",
          location: repoRoot,
          message: "loadGovernanceDocsChecked called without SyncHostIo",
          action: "Pass SyncHostIo (e.g. nodeSyncHostIo).",
        },
      ],
    }
  }
  const findings: Array<GcFinding> = []
  const docs = loadGovernanceDocsFromDisk(repoRoot, hostIo, findings)
  return { docs, findings }
}

const EXCLUDED_WORKSPACE_SCAN_DIRS = new Set([
  "node_modules",
  "dist",
  "repos",
  ".git",
  ".nx",
  "coverage",
])
const EXCLUDED_MODULAR_SCAN_DIRS = new Set([...EXCLUDED_WORKSPACE_SCAN_DIRS, "test"])

const collectWorkspaceFiles = (
  dir: string,
  hostIo: SyncHostIo,
  predicate: (name: string) => boolean,
  excludedDirs: ReadonlySet<string> = EXCLUDED_WORKSPACE_SCAN_DIRS,
  findings?: Array<GcFinding>,
  repoRoot?: string,
): ReadonlyArray<string> => {
  const sink = findings ?? []
  const root = repoRoot ?? dir
  if (!existsGuardedOrReport(dir, hostIo, root, sink)) return []
  const entries = readdirOrReport(dir, hostIo, root, sink)
  if (entries === undefined) return []
  const result: Array<string> = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory) {
      if (!excludedDirs.has(e.name)) {
        result.push(...collectWorkspaceFiles(full, hostIo, predicate, excludedDirs, sink, root))
      }
      continue
    }
    if (e.isFile && predicate(e.name)) result.push(full)
  }
  return result.sort((a, b) => a.localeCompare(b))
}

export const collectWorkspaceTsFiles = (
  dir: string,
  hostIo: SyncHostIo,
  findings?: Array<GcFinding>,
  repoRoot?: string,
): ReadonlyArray<string> =>
  collectWorkspaceFiles(
    dir,
    hostIo,
    (n) => (n.endsWith(".ts") || n.endsWith(".tsx")) && !n.endsWith(".d.ts"),
    EXCLUDED_WORKSPACE_SCAN_DIRS,
    findings,
    repoRoot,
  )

export const collectWorkspaceSqlFiles = (
  dir: string,
  hostIo: SyncHostIo,
  findings?: Array<GcFinding>,
  repoRoot?: string,
): ReadonlyArray<string> =>
  collectWorkspaceFiles(
    dir,
    hostIo,
    (n) => n.endsWith(".sql"),
    EXCLUDED_WORKSPACE_SCAN_DIRS,
    findings,
    repoRoot,
  )

export const collectWorkspaceAllFiles = (
  dir: string,
  hostIo: SyncHostIo,
  findings?: Array<GcFinding>,
  repoRoot?: string,
): ReadonlyArray<string> =>
  collectWorkspaceFiles(dir, hostIo, () => true, EXCLUDED_WORKSPACE_SCAN_DIRS, findings, repoRoot)

export const collectMarkdownFilesRecursive = (
  dir: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): ReadonlyArray<string> => {
  if (!existsGuardedOrReport(dir, hostIo, repoRoot, findings)) return []
  const entries = readdirOrReport(dir, hostIo, repoRoot, findings)
  if (entries === undefined) return []
  const out: Array<string> = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory) {
      out.push(...collectMarkdownFilesRecursive(full, hostIo, repoRoot, findings))
      continue
    }
    if (e.isFile && e.name.endsWith(".md")) {
      out.push(full)
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export const collectModularPluginFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings?: Array<GcFinding>,
): ReadonlyArray<string> => {
  const sink = findings ?? []
  return [
    ...new Set(
      ["libs", "apps"]
        .map((d) => join(repoRoot, d))
        .filter((d) => existsGuardedOrReport(d, hostIo, repoRoot, sink))
        .flatMap((d) =>
          collectWorkspaceFiles(
            d,
            hostIo,
            (n) => (n.endsWith(".ts") || n.endsWith(".tsx")) && !n.endsWith(".d.ts"),
            EXCLUDED_MODULAR_SCAN_DIRS,
            sink,
            repoRoot,
          ).filter((f) => isModularPluginPath(relative(repoRoot, f).replace(/\\/g, "/"))),
        ),
    ),
  ].sort((a, b) => a.localeCompare(b))
}
