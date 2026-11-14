import * as path from "node:path"
import type { SyncHostIo } from "@harness/service"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { ts } from "ts-morph"
import {
  type AdrDocNode,
  type BranchingViolation,
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
  type VitestCaseNode,
  getNodeKey,
} from "../model.js"
import {
  decodePackageJson,
  resolveRepoRoot,
  stripCommentsAndTestTitles,
} from "./extractor-types-and-helpers.js"
import type { SourceFileInput } from "./compiler-session.js"

export interface PackageJsonEntry {
  readonly name?: string | undefined
  readonly dir: string
}

export const findPackageForRelFile = (
  root: string,
  relFile: string,
  hostIo?: SyncHostIo,
  packageJsonCache?: Map<string, PackageJsonEntry>,
): PackageJsonEntry | null => {
  if (hostIo === undefined) return null
  let curr = path.dirname(path.join(root, relFile))
  const rootResolved = path.resolve(root)
  while (curr.startsWith(rootResolved)) {
    const cached = packageJsonCache?.get(curr)
    if (cached !== undefined) return cached
    const pkgPath = path.join(curr, "package.json")
    if (hostIo.existsSync(pkgPath)) {
      const content = hostIo.readTextSync(pkgPath)
      const opt = decodePackageJson(content)
      const relDir = path.relative(rootResolved, curr).replace(/\\/g, "/")
      const entry: PackageJsonEntry = {
        name: match(opt).with({ _tag: "Some" }, ({ value }) => value.name).with({ _tag: "None" }, () => undefined).exhaustive(),
        dir: relDir,
      }
      packageJsonCache?.set(curr, entry)
      return entry
    }
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return null
}

export const testImportsFn = (
  root: string,
  testRelPath: string,
  testContent: string,
  fnFile: string,
  hostIo?: SyncHostIo,
  packageJsonCache?: Map<string, PackageJsonEntry>,
): boolean => {
  const fnPkg = findPackageForRelFile(root, fnFile, hostIo, packageJsonCache)
  if (fnPkg?.name && (testContent.includes(`"${fnPkg.name}"`) || testContent.includes(`'${fnPkg.name}'`) || testContent.includes(`"${fnPkg.name}/`) || testContent.includes(`'${fnPkg.name}/`))) {
    return true
  }

  const testFullDir = path.dirname(path.join(root, testRelPath)), fnFullFile = path.join(root, fnFile)
  const fnFullDir = path.dirname(fnFullFile), fnPkgFullDir = fnPkg ? path.join(root, fnPkg.dir) : null

  for (const m of testContent.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/g)) {
    const spec = m[1]
    if (!spec) continue
    if (spec.startsWith(".")) {
      const resolved = path.resolve(testFullDir, spec)
      if (
        resolved === fnFullFile || resolved === fnFullFile.replace(/\.tsx?$/, ".js") ||
        resolved.replace(/\.js$/, "") === fnFullFile.replace(/\.tsx?$/, "") ||
        resolved.startsWith(fnFullDir) || (fnPkgFullDir && resolved.startsWith(fnPkgFullDir))
      ) return true
    } else if (fnPkg?.dir && spec.includes(fnPkg.dir)) return true
  }
  return false
}

export const parseGovernanceDocFile = (
  relDocPath: string,
  content: string,
): AdrDocNode | EarsSpecNode | null => {
  const normalized = content.replace(/^\uFEFF/, "")
  const matchFm = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!matchFm || matchFm[1] === undefined) return null

  const lines = matchFm[1].split(/\r?\n/)
  const scalars = new Map<string, string>(), lists = new Map<string, Array<string>>()
  let currentListKey: string | null = null

  const stripQuotes = (val: string): string => {
    let t = val.trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim()
    const hashIdx = t.indexOf("#")
    return hashIdx !== -1 ? t.slice(0, hashIdx).trim() : t
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) lists.get(currentListKey)?.push(item)
      continue
    }
    currentListKey = null
    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim(), rest = keyValMatch[2]!.trim()
      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        lists.set(key, inner.length === 0 ? [] : inner.split(",").map(stripQuotes).filter((s) => s.length > 0))
      } else if (rest === "") {
        lists.set(key, [])
        currentListKey = key
      } else {
        scalars.set(key, stripQuotes(rest))
      }
    }
  }

  const id = scalars.get("id")
  if (!id || id.trim() === "") return null

  let title = scalars.get("title")
  if (!title || title.trim() === "") {
    const titleMatch = normalized.match(/^#\s+(.+)$/m)
    title = titleMatch ? titleMatch[1]!.trim() : id
  }

  const rawStatus = scalars.get("status")
  const status: GovernanceDocStatus =
    rawStatus === "accepted" || rawStatus === "proposed" || rawStatus === "superseded" || rawStatus === "deprecated"
      ? rawStatus : "proposed"

  const enforcedByFiles = lists.get("enforced_by") ?? []
  const referencedSpans = lists.get("spans") ?? []
  const referencedServices = lists.get("services") ?? []
  const referencedErrors = lists.get("errors") ?? []

  if (relDocPath.includes("/adr/")) return { _tag: "AdrDoc", id, title, status, path: relDocPath, enforcedByFiles, referencedSpans, referencedServices, referencedErrors }
  if (relDocPath.includes("/specs/")) return { _tag: "EarsSpec", id, title, status, path: relDocPath, enforcedByFiles, referencedSpans, referencedServices, referencedErrors }
  return null
}

export const loadWorkspaceGovernanceDocs = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<AdrDocNode | EarsSpecNode> => {
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
  for (const s of listSubdirs("libs")) candidateRelDirs.push(`libs/${s}/docs/adr`, `libs/${s}/docs/specs`)
  for (const a of listSubdirs("apps")) candidateRelDirs.push(`apps/${a}/docs/adr`, `apps/${a}/docs/specs`)

  const results: Array<AdrDocNode | EarsSpecNode> = []
  for (const relDir of candidateRelDirs) {
    const fullDir = path.join(root, relDir)
    if (!hostIo.existsSync(fullDir)) continue
    const files = hostIo
      .readdirSync(fullDir)
      .filter((e) => e.isFile && e.name.endsWith(".md") && e.name !== "README.md" && e.name !== "TEMPLATE.md")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    for (const file of files) {
      const relDocPath = `${relDir}/${file}`
      const parsed = parseGovernanceDocFile(relDocPath, hostIo.readTextSync(path.join(root, relDocPath)))
      if (parsed !== null) results.push(parsed)
    }
  }
  return results
}

const splitTopLevelCommas = (input: string): Array<string> => {
  const items: Array<string> = []
  let depth = 0, current = ""
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === "(" || char === "[" || char === "{") { depth++; current += char }
    else if (char === ")" || char === "]" || char === "}") { if (depth > 0) depth--; current += char }
    else if (char === "," && depth === 0) { items.push(current); current = "" }
    else { current += char }
  }
  if (current.length > 0) items.push(current)
  return items
}

const PRIMITIVE_SCALAR_REGEX =
  /^(?:(?:Schema|S)\.(?:String|Number|Boolean|Int|Natural|Positive|Negative|NonNegative|NonPositive|NonEmptyString)(?:\.[A-Za-z0-9_($. )]+)*|PositiveInt|NonEmptyString|StreamVersion|fc\.(?:integer|nat|string|boolean|float|double)\s*\([^)]*\))$/

export const isAllPrimitiveArbitraryBlock = (rawBlock: string): boolean => {
  const block = rawBlock.trim()
  if (block.startsWith("[") && block.endsWith("]")) {
    const items = splitTopLevelCommas(block.slice(1, -1)).map((s) => s.trim()).filter((s) => s.length > 0)
    return items.length === 0 ? true : items.every((item) => PRIMITIVE_SCALAR_REGEX.test(item))
  }
  if (block.startsWith("{") && block.endsWith("}")) {
    const items = splitTopLevelCommas(block.slice(1, -1)).map((s) => s.trim()).filter((s) => s.length > 0)
    if (items.length === 0) return true
    return items.every((entry) => {
      const parts = entry.split(":")
      if (parts.length < 2) return false
      const val = parts.slice(1).join(":").trim()
      return val.length > 0 && PRIMITIVE_SCALAR_REGEX.test(val)
    })
  }
  return false
}

export const getScopeDir = (relPath: string): string | null => {
  const m = relPath.replace(/\\/g, "/").match(/^(libs\/[^/]+|apps\/[^/]+)/)
  return m ? m[1]! : null
}

export const checkUnassertedStateFieldsForInputs = (
  sourceInputs: ReadonlyArray<SourceFileInput>,
  testFiles: ReadonlyArray<{ filePath: string; getContent: () => string }>,
): ReadonlyArray<BranchingViolation> => {
  const violations: Array<BranchingViolation> = []

  for (const input of sourceInputs) {
    if (!/\bevolve\w*\b/.test(input.content)) continue
    const scope = getScopeDir(input.filePath)
    if (!scope) continue

    const scopeTestFiles = testFiles.filter(
      (t) => getScopeDir(t.filePath) === scope && !t.filePath.includes("/test/fixtures/"),
    )
    if (scopeTestFiles.length === 0) continue

    const sf = ts.createSourceFile(input.filePath, input.content, ts.ScriptTarget.Latest, true)
    const evolveFns: Array<ts.Node> = []
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && /^evolve/i.test(stmt.name.text)) evolveFns.push(stmt)
      else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && /^evolve/i.test(decl.name.text) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            evolveFns.push(decl.initializer)
          }
        }
      }
    }

    const assignedFields = new Set<string>()
    const collectProps = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const p of node.properties) {
          let pName: string | null = null
          if (ts.isPropertyAssignment(p) && p.name) pName = p.name.getText(sf).replace(/^["'`]|["'`]$/g, "")
          else if (ts.isShorthandPropertyAssignment(p)) pName = p.name.text
          if (pName && pName !== "_tag" && !pName.endsWith("Id") && pName !== "id") assignedFields.add(pName)
        }
      }
      ts.forEachChild(node, collectProps)
    }
    for (const fnNode of evolveFns) collectProps(fnNode)

    if (assignedFields.size > 0) {
      let combinedTestContent = ""
      for (const t of scopeTestFiles) combinedTestContent += " " + stripCommentsAndTestTitles(t.getContent())

      for (const field of assignedFields) {
        const dotRead = new RegExp("\\.\\s*" + field + "\\b")
        const assertBlock = new RegExp(`(?:expect|Equal\\.equals)\\s*\\([\\s\\S]{0,240}?\\b${field}\\b`)
        if (!dotRead.test(combinedTestContent) && !assertBlock.test(combinedTestContent)) {
          violations.push({
            rule: "unasserted-state-field",
            message: `State property '${field}' computed in reducer '${input.filePath}' is never read or asserted in any test file in scope '${scope}' — add fold assertions verifying '${field}' on folded states.`,
            file: input.filePath, line: 1, enclosingSymbol: `${input.filePath}#evolve`,
          })
        }
      }
    }
  }
  return violations
}

export const checkNodeSqliteTestViolations = (
  testFiles: ReadonlyArray<string>,
  testContentMap: ReadonlyMap<string, string>,
): ReadonlyArray<BranchingViolation> => {
  const violations: Array<BranchingViolation> = []
  for (const relTestFile of testFiles) {
    if (relTestFile.startsWith("libs/harness/") || relTestFile.startsWith("apps/harness-") || !/(?:^libs\/[^/]+\/infra\/|^apps\/)/.test(relTestFile)) continue
    const content = testContentMap.get(relTestFile)
    if (content === undefined) continue
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]?.match(/\b(?:import\s*\(\s*|require\s*\(\s*|(?:import|from)\s+)["'](node:sqlite|sqlite|better-sqlite3)["']/)
      if (m && m[1]) {
        violations.push({
          rule: "node-sqlite-in-infra",
          message: `Do not import '${m[1]}' in '${relTestFile}' — Cloudflare Durable Object SQLite and D1 tests in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
          file: relTestFile, line: i + 1, enclosingSymbol: relTestFile,
        })
      }
    }
  }
  return violations
}

export const assembleTestAndGovernanceGraph = (
  mutable: Graph.MutableDirectedGraph<HarnessNode, HarnessEdge>,
  testFiles: ReadonlyArray<string>,
  testContentMap: ReadonlyMap<string, string>,
  governanceDocs: ReadonlyArray<AdrDocNode | EarsSpecNode>,
  effectFns: ReadonlyArray<EffectFnNode>,
  serviceTags: ReadonlyArray<ServiceTagNode>,
  taggedErrors: ReadonlyArray<TaggedErrorNode>,
  inputs: ReadonlyArray<SourceFileInput>,
  updatedNodeIndexByKey: Map<string, Graph.NodeIndex>,
  unresolvedReferences: Array<UnresolvedGraphReference>,
  repoRoot: string,
  hostIo?: SyncHostIo,
): void => {
  const packageJsonCache = new Map<string, PackageJsonEntry>()
  const deciderAliasesByFnName = new Map<string, Set<string>>()
  for (const input of inputs) {
    for (const m of input.content.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:Decider\.)?make\s*(?:<[\s\S]*?>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      const varName = m[1], body = m[2]
      if (!varName || !body) continue
      const dFn = body.match(/decide\s*:\s*([A-Za-z0-9_$]+)/)?.[1] ?? (/\bdecide\b/.test(body) ? "decide" : null)
      const eFn = body.match(/evolve\s*:\s*([A-Za-z0-9_$]+)/)?.[1] ?? (/\bevolve\b/.test(body) ? "evolve" : null)
      for (const fn of [dFn, eFn]) {
        if (!fn) continue
        let s = deciderAliasesByFnName.get(fn)
        if (!s) { s = new Set<string>(); deciderAliasesByFnName.set(fn, s) }
        s.add(varName)
      }
    }
  }

  for (const relTestFile of testFiles) {
    const content = testContentMap.get(relTestFile)
    if (content === undefined) continue
    if (
      !content.includes("describe(") && !content.includes("it(") &&
      !content.includes("it.effect(") && !content.includes("it.prop(") && !content.includes("it.effect.prop(")
    ) {
      continue
    }

    const hasPropTest = /\b(?:it|test)(?:\.effect)?\.prop\s*\(/.test(content) || /\bfc\.assert\s*\(/.test(content)
    const strippedContent = stripCommentsAndTestTitles(content)
    let hasNonPrimitiveArbitrary: boolean | undefined = undefined
    if (hasPropTest) {
      const propCallRegex = /\b(?:it|test)(?:\.effect)?\.prop\s*\(\s*(?:""|''|``)\s*,\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*,/g
      const matches = [...strippedContent.matchAll(propCallRegex)]
      hasNonPrimitiveArbitrary = matches.length > 0 && matches.every((m) => !isAllPrimitiveArbitraryBlock(m[1]!))
    }

    const testNode: VitestCaseNode = {
      _tag: "VitestCase", testId: `${relTestFile}::suite`, testFile: relTestFile,
      testName: relTestFile, lastTreeHash: "workspace", isPropertyTest: hasPropTest,
      ...(hasNonPrimitiveArbitrary !== undefined ? { hasNonPrimitiveArbitrary } : {}),
    }
    const testKey = getNodeKey(testNode)
    const testIdx = Graph.addNode(mutable, testNode)
    updatedNodeIndexByKey.set(testKey, testIdx)

    const usesTestTracer = strippedContent.includes("runWithTestTracer")
    const identTokens = new Set<string>()
    for (const m of strippedContent.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) if (m[1]) identTokens.add(m[1])
    const callOrArgTokens = new Set<string>()
    for (const m of strippedContent.matchAll(/(?:\b|\$)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\(|\)|,)/g)) if (m[1]) callOrArgTokens.add(m[1])
    const dottedCallTokens = new Set<string>()
    for (const m of strippedContent.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\s*\(/g)) if (m[1]) dottedCallTokens.add(m[1])

    const testScope = getScopeDir(relTestFile)
    const importCheckedByFnFile = new Map<string, boolean>()

    for (const fnNode of effectFns) {
      const fnScope = fnNode.file ? getScopeDir(fnNode.file) : null
      if (testScope && fnScope && testScope !== fnScope && fnNode.file) {
        let importsFn = importCheckedByFnFile.get(fnNode.file)
        if (importsFn === undefined) {
          importsFn = testImportsFn(repoRoot, relTestFile, content, fnNode.file, hostIo, packageJsonCache)
          importCheckedByFnFile.set(fnNode.file, importsFn)
        }
        if (!importsFn) continue
      }
      const fnName = fnNode.qualname.split("#")[1] ?? ""
      const fnCallMatches = fnName.length > 0 && callOrArgTokens.has(fnName)
      const spanCallMatches = fnNode.spanName.length > 0 && (dottedCallTokens.has(fnNode.spanName) || callOrArgTokens.has(fnNode.spanName))
      const testTracerMatches = usesTestTracer && ((fnName.length > 0 && strippedContent.includes(fnName)) || (fnNode.spanName.length > 0 && strippedContent.includes(fnNode.spanName)))
      const deciderAliases = deciderAliasesByFnName.get(fnName)
      let deciderAliasMatches = false
      if (deciderAliases) {
        for (const alias of deciderAliases) {
          if (identTokens.has(alias)) { deciderAliasMatches = true; break }
        }
      }

      if (fnCallMatches || spanCallMatches || testTracerMatches || deciderAliasMatches) {
        const fnKey = getNodeKey(fnNode)
        const calleeIdx = updatedNodeIndexByKey.get(fnKey)
        if (calleeIdx !== undefined) {
          const relId = RelationId.make(`TraceabilityTuple:exercise:${testNode.testId}->${fnNode.qualname}`)
          if (!updatedNodeIndexByKey.has(relId)) {
            const relNode: TraceabilityTupleRelation = {
              _tag: "TraceabilityTuple", relationId: relId,
              targetSymbolQualname: fnNode.qualname, verifyingTestQualnames: [testNode.testId],
            }
            const relIdx = Graph.addNode(mutable, relNode)
            updatedNodeIndexByKey.set(relId, relIdx)
            Graph.addEdge(mutable, relIdx, testIdx, {
              _tag: "PlaysRole", relationId: relId, entityKey: NodeKey.make(testKey),
              role: RoleName.make("exercising-test"), archimateRelation: "Triggering",
            })
            Graph.addEdge(mutable, relIdx, calleeIdx, {
              _tag: "PlaysRole", relationId: relId, entityKey: NodeKey.make(fnKey),
              role: RoleName.make("exercised-span"), archimateRelation: "Realization",
            })
          }
        }
      }
    }
  }

  for (const docNode of governanceDocs) {
    const docKey = getNodeKey(docNode), docIdx = Graph.addNode(mutable, docNode)
    updatedNodeIndexByKey.set(docKey, docIdx)
    const kindPrefix = docNode._tag === "AdrDoc" ? "governs" : "specifies"

    const addGovernanceTraceability = (targetKey: string, targetIdx: Graph.NodeIndex) => {
      const docRole = docNode._tag === "AdrDoc" ? "governing-adr" : "specifying-ears"
      const docArchimate = docNode._tag === "AdrDoc" ? ("Influence" as const) : ("Realization" as const)
      const relId = RelationId.make(`TraceabilityTuple:${kindPrefix}:${docNode.id}->${targetKey}`)
      if (!updatedNodeIndexByKey.has(relId)) {
        const relNode: TraceabilityTupleRelation = {
          _tag: "TraceabilityTuple", relationId: relId,
          ...(docNode._tag === "AdrDoc" ? { adrId: docNode.id } : { earsSpecId: docNode.id }),
          targetSymbolQualname: targetKey, verifyingTestQualnames: [],
        }
        const relIdx = Graph.addNode(mutable, relNode)
        updatedNodeIndexByKey.set(relId, relIdx)
        Graph.addEdge(mutable, relIdx, docIdx, {
          _tag: "PlaysRole", relationId: relId, entityKey: NodeKey.make(docKey),
          role: RoleName.make(docRole), archimateRelation: docArchimate,
        })
        Graph.addEdge(mutable, relIdx, targetIdx, {
          _tag: "PlaysRole", relationId: relId, entityKey: NodeKey.make(targetKey),
          role: RoleName.make("realizing-symbol"), archimateRelation: "Realization",
        })
      }
    }

    const linkGovRefs = <T extends HarnessNode>(items: ReadonlyArray<string> | undefined, nodes: ReadonlyArray<T>, matchFn: (item: string, node: T) => boolean) => {
      const added = new Set<string>()
      for (const item of items ?? []) {
        let found = false
        for (const n of nodes) {
          if (matchFn(item, n)) {
            found = true
            const k = getNodeKey(n)
            if (!added.has(k)) {
              added.add(k)
              const idx = updatedNodeIndexByKey.get(k)
              if (idx !== undefined) addGovernanceTraceability(k, idx)
            }
          }
        }
        if (!found) unresolvedReferences.push({ relationId: `TraceabilityTuple:${kindPrefix}:${docNode.id}->${item}`, role: "realizing-symbol", targetKey: item, file: docNode.path })
      }
    }

    linkGovRefs(docNode.referencedSpans, effectFns, (s, n) => n.spanName === s || n.qualname === s || n.qualname.endsWith(`#${s}`))
    linkGovRefs(docNode.referencedServices, serviceTags, (s, n) => n.tagId === s || n.name === s || n.tagId.endsWith(`#${s}`))
    linkGovRefs(docNode.referencedErrors, taggedErrors, (s, n) => n.errorTag === s)
  }
}
