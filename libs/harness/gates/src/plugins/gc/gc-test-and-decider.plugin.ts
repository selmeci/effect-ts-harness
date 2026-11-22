/**
 * Test & Pure Decider Entropy Gate Plugin.
 *
 * Verifies test reachability and property-based test coverage for domain functions.
 *
 * Rules owned:
 * - untested-effect-fn: Flags domain/contract EffectFn symbols with 0 reaching tests.
 * - missing-decider-property-test: Flags domain deciders lacking property-based test coverage.
 * - shallow-decider-property-test: Flags deciders exercised only by scalar/primitive arbitraries.
 * - untested-union-variant: Flags exported `Schema.TaggedUnion` variants in `type:contract` with 0 test references.
 */
import { join } from "node:path"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
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
  /^(?:libs|apps)\/.*\/test\/(?!fixtures\/).*\.(?:test|spec)\.tsx?$/.test(relPath)

export const checkUntestedContractUnionVariants = (
  repoRoot: string,
  hostIo: SyncHostIo,
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
    if (isNonFixtureTestRelPath(relPath)) {
      testFiles.push({ absPath, relPath })
    }
  }

  if (variants.length === 0) return findings

  const perFileTokens: Array<ReadonlySet<string>> = []
  for (const tf of testFiles) {
    const content = readTextOrReport(tf.absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    const sf = ts.createSourceFile(tf.relPath, content, ts.ScriptTarget.Latest, true)
    const fileTokens = new Set<string>()
    collectTestReferencedTokens(sf, fileTokens)
    perFileTokens.push(fileTokens)
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
    findings.push(...checkUntestedContractUnionVariants(input.workspaceRoot, input.hostIo))
  }

  return findings
}
