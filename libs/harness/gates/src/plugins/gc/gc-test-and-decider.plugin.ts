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
  readonly variantName: string
  readonly file: string
  readonly line: number
}

const isExportedStmt = (stmt: ts.Statement): stmt is ts.VariableStatement =>
  ts.isVariableStatement(stmt) &&
  Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

const unwrapTaggedUnionInit = (init: ts.Expression): ts.Expression => {
  let expr = init
  while (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    SCHEMA_CHAIN_METHODS.has(expr.expression.name.text)
  ) {
    expr = expr.expression.expression
  }
  return expr
}

const extractExportedTaggedUnionVariants = (
  sourceFile: ts.SourceFile,
  relPath: string,
): ReadonlyArray<ExtractedUnionVariant> => {
  const variants: Array<ExtractedUnionVariant> = []
  for (const stmt of sourceFile.statements) {
    if (!isExportedStmt(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
      const expr = unwrapTaggedUnionInit(decl.initializer)
      const isTaggedUnion =
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "Schema" &&
        expr.expression.name.text === "TaggedUnion"
      if (!isTaggedUnion || expr.arguments[0] === undefined) continue
      const arg0 = expr.arguments[0]
      if (!ts.isObjectLiteralExpression(arg0)) continue
      for (const prop of arg0.properties) {
        if (
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          (ts.isIdentifier(prop.name) ||
            ts.isStringLiteral(prop.name) ||
            ts.isNoSubstitutionTemplateLiteral(prop.name))
        ) {
          variants.push({
            unionName: decl.name.text,
            variantName: prop.name.text,
            file: relPath,
            line: sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line + 1,
          })
        }
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

  const tokens = new Set<string>()
  for (const tf of testFiles) {
    const content = readTextOrReport(tf.absPath, hostIo, repoRoot, findings)
    if (content === undefined) continue
    const sf = ts.createSourceFile(tf.relPath, content, ts.ScriptTarget.Latest, true)
    collectTestReferencedTokens(sf, tokens)
  }

  for (const v of variants) {
    if (!tokens.has(v.variantName)) {
      findings.push({
        kind: "untested-union-variant",
        nodeId: `${v.unionName}.${v.variantName}`,
        location: `${v.file}:${v.line}`,
        message: `Exported Schema.TaggedUnion variant "${v.unionName}.${v.variantName}" in "${v.file}" has 0 references across workspace test/ suites.`,
        action: `Add unit or property test coverage exercising the "${v.variantName}" variant of "${v.unionName}".`,
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
