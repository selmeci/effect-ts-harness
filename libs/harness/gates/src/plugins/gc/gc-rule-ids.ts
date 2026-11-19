import { dirname, join, posix } from "node:path"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { AST_GATE_RULE_SOURCE_FILES } from "../../ast-cache.js"
import { type GcFinding, readTextOrReport } from "./gc-helpers.js"

/**
 * Named source-file map inspected by `GraphGc` (`evaluateDocTruthPlugin`) to
 * collect all canonical gate rule IDs documented in markdown tables and specs.
 */
export const DOC_TRUTH_RULE_ID_SOURCES = {
  astVisitors: "libs/harness/gates/src/plugins/ast-gate-visitors.ts",
  selfDogfooding: "libs/harness/gates/src/plugins/self-dogfooding-plugin.ts",
  tierTopology: "libs/harness/gates/src/plugins/harness-tier-topology.ts",
  syntaxBans: "tools/oxlint/syntax-bans.js",
  gcWorkspaceIo: "libs/harness/gates/src/plugins/gc/gc-workspace-io.ts",
} as const

/**
 * Extracts and sorts canonical gate rule IDs from AST visitor, self-dogfooding,
 * tier-topology, oxlint, and GC finding source texts using UTF-16 code-unit order.
 */
export const extractGateRuleIdsFromSources = (
  astVisitorsSource: string,
  selfDogfoodingSource: string,
  tierTopologySource: string,
  syntaxBansSource = "",
  gcWorkspaceIoSource = "",
): ReadonlyArray<string> => {
  const ids = new Set<string>()
  for (const m of astVisitorsSource.matchAll(/pushViolation\s*\(\s*[^,]+,\s*"([a-z0-9-]+)"/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of astVisitorsSource.matchAll(/GateRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of selfDogfoodingSource.matchAll(
    /SelfDogfoodingRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g,
  )) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of tierTopologySource.matchAll(
    /TierTopologyRuleId\.make\(\s*"([a-z0-9-]+)"\s*\)/g,
  )) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  for (const m of syntaxBansSource.matchAll(/["'`]\[([a-z][a-z0-9-]*(?:-[a-z0-9]+)+)\]/g)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  const gcKindBlock = /GcFindingKind\s*=\s*Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(
    gcWorkspaceIoSource,
  )
  const gcKindList = gcKindBlock?.[1]
  if (gcKindList !== undefined) {
    for (const m of gcKindList.matchAll(/"([a-z][a-z0-9-]*(?:-[a-z0-9]+)+)"/g)) {
      if (m[1] !== undefined) ids.add(m[1])
    }
  }
  return [...ids].sort(compareCodeUnits)
}

const AST_GATE_CLOSURE_ENTRY = "libs/harness/gates/src/ast-cache.ts"

const resolveRelativeModuleFile = (
  fromRelPath: string,
  specifier: string,
  repoRoot: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const joined = posix.normalize(posix.join(dirname(fromRelPath), specifier))
  const candidates: Array<string> = [joined]
  if (joined.endsWith(".js") || joined.endsWith(".jsx")) {
    const stem = joined.slice(0, joined.endsWith(".jsx") ? -4 : -3)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`)
  } else {
    candidates.push(`${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}/index.ts`)
  }
  return candidates.find((cand) => hostIo.existsSync(join(repoRoot, cand)))
}

const isRuntimeRelativeImport = (stmt: ts.Statement): string | undefined => {
  if (ts.isImportDeclaration(stmt)) {
    const clause = stmt.importClause
    if (clause?.isTypeOnly) return undefined
    if (
      clause !== undefined &&
      clause.name === undefined &&
      clause.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((el) => el.isTypeOnly)
    ) {
      return undefined
    }
    if (ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith(".")) {
      return stmt.moduleSpecifier.text
    }
    return undefined
  }
  if (
    ts.isExportDeclaration(stmt) &&
    !stmt.isTypeOnly &&
    stmt.moduleSpecifier !== undefined &&
    ts.isStringLiteral(stmt.moduleSpecifier) &&
    stmt.moduleSpecifier.text.startsWith(".")
  ) {
    if (
      stmt.exportClause !== undefined &&
      ts.isNamedExports(stmt.exportClause) &&
      stmt.exportClause.elements.length > 0 &&
      stmt.exportClause.elements.every((el) => el.isTypeOnly)
    ) {
      return undefined
    }
    return stmt.moduleSpecifier.text
  }
  return undefined
}

/**
 * Verifies every path in `AST_GATE_RULE_SOURCE_FILES` exists on disk and every
 * relative runtime module transitively imported by `ast-cache.ts` is included.
 */
export const checkAstGateRuleClosure = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const listedSet = new Set<string>(AST_GATE_RULE_SOURCE_FILES)
  const someExist = AST_GATE_RULE_SOURCE_FILES.some((rel) => hostIo.existsSync(join(repoRoot, rel)))
  if (!someExist) return

  for (const rel of AST_GATE_RULE_SOURCE_FILES) {
    if (!hostIo.existsSync(join(repoRoot, rel))) {
      findings.push({
        kind: "architecture-policy-violation",
        nodeId: "AST_GATE_RULE_SOURCE_FILES",
        location: rel,
        message: `AST gate rule source file '${rel}' listed in AST_GATE_RULE_SOURCE_FILES does not exist on disk.`,
        action: `Restore '${rel}' or update AST_GATE_RULE_SOURCE_FILES in libs/harness/gates/src/ast-cache.ts.`,
      })
    }
  }

  if (!hostIo.existsSync(join(repoRoot, AST_GATE_CLOSURE_ENTRY))) return

  const visited = new Set<string>()
  const queue: Array<string> = [AST_GATE_CLOSURE_ENTRY]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    const content = readTextOrReport(join(repoRoot, current), hostIo, repoRoot, findings)
    if (content === undefined) continue
    const sf = ts.createSourceFile(
      current,
      content,
      ts.ScriptTarget.Latest,
      true,
      current.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const stmt of sf.statements) {
      const spec = isRuntimeRelativeImport(stmt)
      if (spec === undefined) continue
      const targetRel = resolveRelativeModuleFile(current, spec, repoRoot, hostIo)
      if (targetRel === undefined) continue
      if (!listedSet.has(targetRel)) {
        findings.push({
          kind: "architecture-policy-violation",
          nodeId: "AST_GATE_RULE_SOURCE_FILES",
          location: targetRel,
          message: `AST gate dependency '${targetRel}' (imported by '${current}') is missing from AST_GATE_RULE_SOURCE_FILES.`,
          action: `Add '${targetRel}' to AST_GATE_RULE_SOURCE_FILES in libs/harness/gates/src/ast-cache.ts.`,
        })
      }
      queue.push(targetRel)
    }
  }
}
