/**
 * Test & Pure Decider Entropy Gate Plugin.
 *
 * Verifies test reachability and property-based test coverage for EffectFn symbols,
 * `.decide` deciders, and `Schema.TaggedUnion` variants.
 *
 * Rules owned:
 * - untested-effect-fn: Flags `domain`/`contract`/`infra`/`app` `EffectFn` symbols with 0 reaching tests.
 * - missing-decider-property-test: Flags `domain`/`contract` `.decide` deciders lacking property-based test coverage.
 * - shallow-decider-property-test: Flags `domain`/`contract` `.decide` deciders exercised only by scalar/primitive arbitraries.
 * - untested-union-variant: Flags exported `Schema.TaggedUnion` variants in `type:contract` with 0 test references.
 * - test-domain-sprawl: Flags large test suites (>= 300 lines) spanning more than 6 production source domains.
 */
import { join, posix } from "node:path"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  collectWorkspaceTsFiles,
  formatRelPath,
  readTextOrReport,
} from "./gc-helpers.js"

const SCHEMA_CHAIN_METHODS = new Set(["pipe", "check", "annotate"])

interface ExtractedUnionVariant {
  readonly unionName: string
  readonly relatedSymbols: ReadonlyArray<string>
  readonly variantName: string
  readonly file: string
  readonly line: number
}

const isExportedStmt = (stmt: ts.Statement): stmt is ts.VariableStatement =>
  ts.isVariableStatement(stmt) &&
  Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

const unwrapParensAndCasts = (expr: ts.Expression): ts.Expression => {
  let curr = expr
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isSatisfiesExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression
  }
  return curr
}

const unwrapTaggedUnionInit = (init: ts.Expression): ts.Expression => {
  let expr = unwrapParensAndCasts(init)
  while (ts.isCallExpression(expr)) {
    const callee = unwrapParensAndCasts(expr.expression)
    if (ts.isPropertyAccessExpression(callee) && SCHEMA_CHAIN_METHODS.has(callee.name.text)) {
      expr = unwrapParensAndCasts(callee.expression)
      continue
    }
    if (ts.isIdentifier(callee) && callee.text === "pipe" && expr.arguments[0] !== undefined) {
      expr = unwrapParensAndCasts(expr.arguments[0])
      continue
    }
    break
  }
  return expr
}

const referencesAnySymbol = (root: ts.Node, symbols: ReadonlySet<string>): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && symbols.has(n.text)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

const computeRelatedExportedSymbols = (
  unionName: string,
  exportedDecls: ReadonlyArray<{ readonly name: string; readonly init: ts.Expression }>,
): ReadonlyArray<string> => {
  const related = new Set<string>([unionName])
  let changed = true
  while (changed) {
    changed = false
    for (const d of exportedDecls) {
      if (!related.has(d.name) && referencesAnySymbol(d.init, related)) {
        related.add(d.name)
        changed = true
      }
    }
  }
  return [...related]
}

const extractExportedTaggedUnionVariants = (
  sourceFile: ts.SourceFile,
  relPath: string,
): ReadonlyArray<ExtractedUnionVariant> => {
  const exportedDecls: Array<{ readonly name: string; readonly init: ts.Expression }> = []
  for (const stmt of sourceFile.statements) {
    if (!isExportedStmt(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
        exportedDecls.push({ name: decl.name.text, init: decl.initializer })
      }
    }
  }

  const variants: Array<ExtractedUnionVariant> = []
  for (const decl of exportedDecls) {
    const expr = unwrapTaggedUnionInit(decl.init)
    const callee = ts.isCallExpression(expr) ? unwrapParensAndCasts(expr.expression) : undefined
    const isTaggedUnion =
      callee !== undefined &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(unwrapParensAndCasts(callee.expression)) &&
      (unwrapParensAndCasts(callee.expression) as ts.Identifier).text === "Schema" &&
      callee.name.text === "TaggedUnion"
    if (!isTaggedUnion || !ts.isCallExpression(expr) || expr.arguments[0] === undefined) continue
    const arg0 = unwrapParensAndCasts(expr.arguments[0])
    if (!ts.isObjectLiteralExpression(arg0)) continue
    const relatedSymbols = computeRelatedExportedSymbols(decl.name, exportedDecls)
    for (const prop of arg0.properties) {
      if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        (ts.isIdentifier(prop.name) ||
          ts.isStringLiteral(prop.name) ||
          ts.isNoSubstitutionTemplateLiteral(prop.name))
      ) {
        variants.push({
          unionName: decl.name,
          relatedSymbols,
          variantName: prop.name.text,
          file: relPath,
          line: sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line + 1,
        })
      }
    }
  }
  return variants
}

const collectTestReferencedTokens = (sourceFile: ts.SourceFile, out: Set<string>): void => {
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      out.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

const isContractSourceRelPath = (relPath: string): boolean =>
  /^libs\/[^/]+\/contract\/src\/.*\.ts$/.test(relPath)

const isNonFixtureTestRelPath = (relPath: string): boolean =>
  /^(?:libs|apps)\/.*\/test\/(?!fixtures\/).*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relPath)

/** Maximum distinct resolved source domain buckets permitted in a non-compact test file. */
export const MAX_TEST_SOURCE_DOMAINS = 6

/** Minimum line count at which `test-domain-sprawl` evaluates cross-domain fan-out. */
export const MIN_LINES_FOR_DOMAIN_SPRAWL = 300

const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?$/
const BARREL_INDEX_RE = /^index(?:\.[cm]?[jt]sx?)?$/
const TEST_PACKAGE_PREFIX_RE = /^((?:libs\/[^/]+\/[^/]+|apps\/[^/]+))\/test\//

interface ParsedTestFileEntry {
  readonly relPath: string
  readonly content: string
  readonly sourceFile: ts.SourceFile
}

/**
 * Maps a package-relative `src/` path to its canonical source domain bucket for
 * `test-domain-sprawl` analysis.
 */
export const resolveSourceDomainBucket = (srcRelPath: string): string => {
  const norm = srcRelPath.replace(/^(?:\.\/)+/, "").replace(SCRIPT_EXT_RE, "")
  const parts = norm.split("/")
  if (parts[0] === "plugins" && parts[1] === "gc") return "plugins/gc"
  if (parts[0] === "commands" && parts.length >= 2 && parts[1] !== undefined) {
    return `commands/${parts[1]}`
  }
  return parts[0] ?? norm
}

const resolveRelativeSrcEntry = (
  pkgSrcAbs: string,
  fromRelFile: string,
  specifier: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromRelFile), specifier))
  if (base.startsWith("..")) return undefined
  const findExisting = (candidates: ReadonlyArray<string>): string | undefined =>
    candidates.find((cand) => hostIo.existsSync(join(pkgSrcAbs, cand)))
  if (/\.(?:js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.replace(SCRIPT_EXT_RE, "")
    return findExisting([
      `${stem}.ts`,
      `${stem}.tsx`,
      base,
      `${stem}/index.ts`,
      `${stem}/index.tsx`,
    ])
  }
  if (/\.(?:ts|tsx|mts|cts)$/.test(base)) {
    return findExisting([base])
  }
  const prefix = base === "." ? "" : `${base}/`
  return findExisting([`${base}.ts`, `${base}.tsx`, `${prefix}index.ts`, `${prefix}index.tsx`])
}

const buildPackageBarrelExportMap = (
  pkgSrcAbs: string,
  relFile: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
  visited: Set<string>,
): ReadonlyMap<string, string> => {
  const exportMap = new Map<string, string>()
  if (visited.has(relFile)) return exportMap
  visited.add(relFile)
  const abs = join(pkgSrcAbs, relFile)
  if (!hostIo.existsSync(abs)) return exportMap
  const content = readTextOrReport(abs, hostIo, repoRoot, findings)
  if (content === undefined) return exportMap
  const sf = ts.createSourceFile(
    abs,
    content,
    ts.ScriptTarget.Latest,
    true,
    relFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      if (stmt.isTypeOnly) continue
      const targetRel = resolveRelativeSrcEntry(
        pkgSrcAbs,
        relFile,
        stmt.moduleSpecifier.text,
        hostIo,
      )
      if (targetRel === undefined) continue
      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (!el.isTypeOnly) exportMap.set(el.name.text, targetRel)
        }
        continue
      }
      if (stmt.exportClause !== undefined && ts.isNamespaceExport(stmt.exportClause)) {
        exportMap.set(stmt.exportClause.name.text, targetRel)
        continue
      }
      if (stmt.exportClause === undefined) {
        const subMap = buildPackageBarrelExportMap(
          pkgSrcAbs,
          targetRel,
          hostIo,
          repoRoot,
          findings,
          visited,
        )
        for (const [sym, target] of subMap) {
          if (!exportMap.has(sym)) exportMap.set(sym, target)
        }
      }
      continue
    }
    const isExported = Boolean(
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    )
    if (!isExported) continue
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exportMap.set(decl.name.text, relFile)
      }
      continue
    }
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      exportMap.set(stmt.name.text, relFile)
    }
  }
  return exportMap
}

const resolveTestSourceDomains = (
  tf: ParsedTestFileEntry,
  pkgDirRel: string,
  barrelMap: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const srcPrefix = `${pkgDirRel}/src/`
  const srcExact = `${pkgDirRel}/src`
  const domains = new Set<string>()
  const barrelNsAliases = new Set<string>()

  for (const stmt of tf.sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue
    const nb = stmt.importClause?.namedBindings
    if (
      nb !== undefined &&
      ts.isNamedImports(nb) &&
      nb.elements.length > 0 &&
      nb.elements.every((el) => el.isTypeOnly)
    ) {
      continue
    }
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith(".")) continue
    const joined = posix.normalize(posix.join(posix.dirname(tf.relPath), spec))
    if (joined !== srcExact && !joined.startsWith(srcPrefix)) continue
    const srcRel = joined === srcExact ? "index.ts" : joined.slice(srcPrefix.length)
    if (!BARREL_INDEX_RE.test(srcRel)) {
      domains.add(resolveSourceDomainBucket(srcRel))
      continue
    }
    if (nb === undefined) continue
    if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue
        const exportedSym = (el.propertyName ?? el.name).text
        const resolvedRel = barrelMap.get(exportedSym)
        if (resolvedRel !== undefined && !BARREL_INDEX_RE.test(resolvedRel)) {
          domains.add(resolveSourceDomainBucket(resolvedRel))
        }
      }
      continue
    }
    if (ts.isNamespaceImport(nb)) {
      barrelNsAliases.add(nb.name.text)
    }
  }

  if (barrelNsAliases.size > 0) {
    const visitNsAccess = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        barrelNsAliases.has(node.expression.text)
      ) {
        const resolvedRel = barrelMap.get(node.name.text)
        if (resolvedRel !== undefined && !BARREL_INDEX_RE.test(resolvedRel)) {
          domains.add(resolveSourceDomainBucket(resolvedRel))
        }
      }
      ts.forEachChild(node, visitNsAccess)
    }
    visitNsAccess(tf.sourceFile)
  }

  return [...domains].sort(compareCodeUnits)
}

/**
 * Flags non-fixture test files with at least `MIN_LINES_FOR_DOMAIN_SPRAWL` (`300`) lines
 * whose runtime `../src/**` or barrel-resolved imports span more than `MAX_TEST_SOURCE_DOMAINS`
 * (`6`) distinct production source domains.
 */
export const checkTestDomainSprawl = (
  repoRoot: string,
  hostIo: SyncHostIo,
  preParsedTestFiles?: ReadonlyArray<ParsedTestFileEntry>,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  let parsedTests = preParsedTestFiles
  if (parsedTests === undefined) {
    const tsFiles = [
      ...collectWorkspaceTsFiles(join(repoRoot, "libs"), hostIo, findings, repoRoot),
      ...collectWorkspaceTsFiles(join(repoRoot, "apps"), hostIo, findings, repoRoot),
    ]
    const collected: Array<ParsedTestFileEntry> = []
    for (const absPath of tsFiles) {
      const relPath = formatRelPath(repoRoot, absPath)
      if (!isNonFixtureTestRelPath(relPath)) continue
      const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
      if (content === undefined) continue
      collected.push({
        relPath,
        content,
        sourceFile: ts.createSourceFile(
          relPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      })
    }
    parsedTests = collected
  }

  const barrelCache = new Map<string, ReadonlyMap<string, string>>()
  const getBarrelMap = (pkgDirRel: string): ReadonlyMap<string, string> => {
    const cached = barrelCache.get(pkgDirRel)
    if (cached !== undefined) return cached
    const pkgSrcAbs = join(repoRoot, pkgDirRel, "src")
    const entryRel = hostIo.existsSync(join(pkgSrcAbs, "index.tsx")) ? "index.tsx" : "index.ts"
    const built = buildPackageBarrelExportMap(
      pkgSrcAbs,
      entryRel,
      hostIo,
      repoRoot,
      findings,
      new Set<string>(),
    )
    barrelCache.set(pkgDirRel, built)
    return built
  }

  for (const tf of parsedTests) {
    if (!isNonFixtureTestRelPath(tf.relPath)) continue
    const lineCount = tf.content.length === 0 ? 0 : tf.content.split(/\r?\n/).length
    if (lineCount < MIN_LINES_FOR_DOMAIN_SPRAWL) continue
    const pkgMatch = TEST_PACKAGE_PREFIX_RE.exec(tf.relPath)
    if (pkgMatch === null || pkgMatch[1] === undefined) continue
    const pkgDirRel = pkgMatch[1]
    const domains = resolveTestSourceDomains(tf, pkgDirRel, getBarrelMap(pkgDirRel))
    if (domains.length > MAX_TEST_SOURCE_DOMAINS) {
      findings.push({
        kind: "test-domain-sprawl",
        nodeId: tf.relPath,
        location: `${tf.relPath}:1`,
        message: `Test file "${tf.relPath}" (${lineCount} lines) spans ${domains.length} distinct production source domains (max ${MAX_TEST_SOURCE_DOMAINS}): ${domains.join(", ")}.`,
        action: `Split "${tf.relPath}" by domain into focused *.test.ts suites targeting <= ${MAX_TEST_SOURCE_DOMAINS} production domains each.`,
      })
    }
  }
  return findings
}

export const checkUntestedContractUnionVariants = (
  repoRoot: string,
  hostIo: SyncHostIo,
  preParsedTestFiles?: ReadonlyArray<ParsedTestFileEntry>,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  const tsFiles = [
    ...collectWorkspaceTsFiles(join(repoRoot, "libs"), hostIo, findings, repoRoot),
    ...collectWorkspaceTsFiles(join(repoRoot, "apps"), hostIo, findings, repoRoot),
  ]

  const variants: Array<ExtractedUnionVariant> = []
  const testFiles: Array<{ readonly absPath: string; readonly relPath: string }> = []

  for (const absPath of tsFiles) {
    const relPath = formatRelPath(repoRoot, absPath)
    if (isContractSourceRelPath(relPath)) {
      const content = readTextOrReport(absPath, hostIo, repoRoot, findings)
      if (content !== undefined) {
        const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true)
        variants.push(...extractExportedTaggedUnionVariants(sf, relPath))
      }
      continue
    }
    if (preParsedTestFiles === undefined && isNonFixtureTestRelPath(relPath)) {
      testFiles.push({ absPath, relPath })
    }
  }

  if (variants.length === 0) return findings

  const perFileTokens: Array<ReadonlySet<string>> = []
  if (preParsedTestFiles !== undefined) {
    for (const tf of preParsedTestFiles) {
      const fileTokens = new Set<string>()
      collectTestReferencedTokens(tf.sourceFile, fileTokens)
      perFileTokens.push(fileTokens)
    }
  } else {
    for (const tf of testFiles) {
      const content = readTextOrReport(tf.absPath, hostIo, repoRoot, findings)
      if (content === undefined) continue
      const sf = ts.createSourceFile(tf.relPath, content, ts.ScriptTarget.Latest, true)
      const fileTokens = new Set<string>()
      collectTestReferencedTokens(sf, fileTokens)
      perFileTokens.push(fileTokens)
    }
  }

  for (const v of variants) {
    const isCovered = perFileTokens.some(
      (fileTokens) =>
        fileTokens.has(v.variantName) && v.relatedSymbols.some((sym) => fileTokens.has(sym)),
    )
    if (!isCovered) {
      findings.push({
        kind: "untested-union-variant",
        nodeId: `${v.unionName}.${v.variantName}`,
        location: `${v.file}:${v.line}`,
        message: `Exported Schema.TaggedUnion variant "${v.unionName}.${v.variantName}" in "${v.file}" has 0 references across workspace test/ suites referencing ${v.unionName}.`,
        action: `Add unit or property test coverage referencing "${v.unionName}" and exercising its "${v.variantName}" variant.`,
      })
    }
  }
  return findings
}

export const evaluateTestAndDeciderPlugin = (
  input: GraphEntropyInput,
  ctx: GraphReachabilityContext,
): ReadonlyArray<GcFinding> => {
  const g = input.graph.graph
  const findings: Array<GcFinding> = []

  // Rule: untested-effect-fn
  if (input.checkUntestedDomainFns === true || ctx.hasVitestCases) {
    for (const [idx, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => {
          if (
            (n.packageTag === "domain" ||
              n.packageTag === "contract" ||
              n.packageTag === "infra" ||
              n.packageTag === "app") &&
            !n.isStub &&
            (ctx.incomingTestOrCall.get(idx) ?? 0) === 0
          ) {
            findings.push({
              kind: "untested-effect-fn",
              nodeId: n.spanName,
              location: `${n.file}:${n.line}`,
              message: `EffectFn "${n.spanName}" (${n.qualname}) in tier "${n.packageTag}" has 0 reaching tests (0 ExercisesSpan / TracedCall edges).`,
              action: `Add a unit/integration test importing and calling "${n.spanName}" to verify behavior.`,
            })
          }
        })
        .with(
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EarsRequirement" },
          { _tag: "PatternDoc" },
          { _tag: "SchemaDef" },
          { _tag: "ServiceLayer" },
          { _tag: "ServiceTag" },
          { _tag: "TaggedError" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          { _tag: "VitestCase" },
          () => {},
        )
        .exhaustive()
    }
  }

  // Rules: missing-decider-property-test & shallow-decider-property-test
  if (input.checkDeciderPropertyTests === true) {
    for (const [idx, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => {
          if (
            (n.packageTag === "domain" || n.packageTag === "contract") &&
            !n.isStub &&
            (n.spanName.endsWith(".decide") || n.spanName === "decide")
          ) {
            if ((ctx.incomingPropertyTests.get(idx) ?? 0) === 0) {
              findings.push({
                kind: "missing-decider-property-test",
                nodeId: n.spanName,
                location: `${n.file}:${n.line}`,
                message: `Pure domain decider "${n.spanName}" (${n.qualname}) has 0 Property-Based Tests (use it.effect.prop / it.prop with Schema arbitraries to prevent example-only blind spots).`,
                action: `Create a property-based test with it.effect.prop / it.prop using fast-check / Schema arbitraries exercising "${n.spanName}".`,
              })
              return
            }
            if ((ctx.incomingRichPropertyTests.get(idx) ?? 0) === 0) {
              findings.push({
                kind: "shallow-decider-property-test",
                nodeId: n.spanName,
                location: `${n.file}:${n.line}`,
                message: `Pure domain decider "${n.spanName}" (${n.qualname}) is only exercised by scalar/primitive property tests — generate domain Event or Command schemas (e.g. Schema.Array(EventSchema)) in it.prop / it.effect.prop.`,
                action: `Replace scalar arguments in it.prop / it.effect.prop with composite domain generators (e.g. Schema.Array(EventSchema)).`,
              })
            }
          }
        })
        .with(
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EarsRequirement" },
          { _tag: "PatternDoc" },
          { _tag: "SchemaDef" },
          { _tag: "ServiceLayer" },
          { _tag: "ServiceTag" },
          { _tag: "TaggedError" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          { _tag: "VitestCase" },
          () => {},
        )
        .exhaustive()
    }
  }

  if (input.workspaceRoot !== undefined && input.hostIo !== undefined) {
    const tsFiles = [
      ...collectWorkspaceTsFiles(
        join(input.workspaceRoot, "libs"),
        input.hostIo,
        findings,
        input.workspaceRoot,
      ),
      ...collectWorkspaceTsFiles(
        join(input.workspaceRoot, "apps"),
        input.hostIo,
        findings,
        input.workspaceRoot,
      ),
    ]
    const parsedTests: Array<ParsedTestFileEntry> = []
    for (const absPath of tsFiles) {
      const relPath = formatRelPath(input.workspaceRoot, absPath)
      if (!isNonFixtureTestRelPath(relPath)) continue
      const content = readTextOrReport(absPath, input.hostIo, input.workspaceRoot, findings)
      if (content === undefined) continue
      parsedTests.push({
        relPath,
        content,
        sourceFile: ts.createSourceFile(
          relPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      })
    }
    findings.push(
      ...checkUntestedContractUnionVariants(input.workspaceRoot, input.hostIo, parsedTests),
      ...checkTestDomainSprawl(input.workspaceRoot, input.hostIo, parsedTests),
    )
  }

  return findings
}
