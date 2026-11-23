/**
 * Topology & Hypergraph Entropy Gate Plugin.
 *
 * Evaluates core graph topology and contract reachability rules.
 *
 * Rules owned:
 * - unused-service: Detects declared ServiceTags with 0 consumer edges.
 * - unprovided-service: Detects ServiceTags without a providing ServiceLayer.
 * - dead-tagged-error: Detects Schema.TaggedError types never emitted in E channels.
 * - missing-pattern-doc: Detects registered idiom patterns missing documentation.
 * - node-sqlite-in-infra: Enforces real workerd storage against branching violations.
 * - unused-contract-export: Detects dead contract exports not used across tiers.
 */
import { join, relative } from "node:path"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  collectWorkspaceAllFiles,
  collectWorkspaceTsFiles,
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  IGNORED_ERRORS,
  isIgnoredServiceTag,
  readdirOrReport,
  readTextOrReport,
} from "./gc-helpers.js"

export const checkUnusedContractExports = (
  repoRoot: string,
  hostIo: SyncHostIo,
  targetScope?: string,
): ReadonlyArray<GcFinding> => {
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return []
  const findings: Array<GcFinding> = []
  const scopes =
    targetScope !== undefined
      ? [targetScope]
      : (readdirOrReport(libsDir, hostIo, repoRoot, findings) ?? [])
          .filter((e) => e.isDirectory)
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b))

  for (const scope of scopes) {
    const scopeDir = join(libsDir, scope)
    const contractSrcDir = join(scopeDir, "contract", "src")
    if (!hostIo.existsSync(contractSrcDir)) continue

    const existingSiblingDirs: Array<string> = []
    const scopeChildren = readdirOrReport(scopeDir, hostIo, repoRoot, findings) ?? []
    for (const child of scopeChildren) {
      if (child.isDirectory && child.name !== "contract" && child.name !== "docs") {
        existingSiblingDirs.push(join(scopeDir, child.name))
      }
    }
    const appsDir = join(repoRoot, "apps")
    if (hostIo.existsSync(appsDir)) {
      const appChildren = readdirOrReport(appsDir, hostIo, repoRoot, findings) ?? []
      for (const appChild of appChildren) {
        if (
          appChild.isDirectory &&
          (appChild.name === scope ||
            appChild.name.startsWith(`${scope}-`) ||
            appChild.name === "harness-cli")
        ) {
          existingSiblingDirs.push(join(appsDir, appChild.name))
        }
      }
    }
    const contractScriptsDir = join(scopeDir, "contract", "scripts")
    if (hostIo.existsSync(contractScriptsDir)) existingSiblingDirs.push(contractScriptsDir)
    if (existingSiblingDirs.length === 0) continue

    const contractFiles = collectWorkspaceTsFiles(contractSrcDir, hostIo, findings, repoRoot)
    const siblingFiles: Array<string> = []
    for (const sibDir of existingSiblingDirs) {
      if (sibDir.endsWith("/scripts"))
        siblingFiles.push(...collectWorkspaceAllFiles(sibDir, hostIo, findings, repoRoot))
      else siblingFiles.push(...collectWorkspaceTsFiles(sibDir, hostIo, findings, repoRoot))
    }

    const stripCommentsAndStrings = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\r\n]*/g, " ")
        .replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '""')

    const combinedSiblingContent = siblingFiles
      .map((f) => readTextOrReport(f, hostIo, repoRoot, findings) ?? "")
      .map((text) =>
        stripCommentsAndStrings(text).replace(
          /export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["'][^"']*["']/g,
          "",
        ),
      )
      .join("\n")

    const nonTestSiblingContent = siblingFiles
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
      .map((f) => readTextOrReport(f, hostIo, repoRoot, findings) ?? "")
      .map(stripCommentsAndStrings)
      .join("\n")

    const hasActiveStubs = /\bstub\s*</.test(nonTestSiblingContent)

    for (const contractFile of contractFiles) {
      const content = readTextOrReport(contractFile, hostIo, repoRoot, findings)
      if (content === undefined) continue
      const strippedContractContent = stripCommentsAndStrings(content)
      const relContractFile = relative(repoRoot, contractFile).replace(/\\/g, "/")
      const exportRegex = /(?:^|\n)\s*export\s+(?:const|class|function)\s+([A-Za-z_$][\w$]*)/g
      const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      let exportMatch: RegExpExecArray | null
      while ((exportMatch = exportRegex.exec(strippedContractContent)) !== null) {
        const symbolName = exportMatch[1]!
        const escapedSym = escapeRegex(symbolName)
        const symbolRefRegex = new RegExp(`\\b${escapedSym}\\b`)
        const internalStripped = strippedContractContent
          .replace(new RegExp(`export\\s+class\\s+${escapedSym}\\b[\\s\\S]*?\\{`, "g"), "{")
          .replace(new RegExp(`export\\s+(?:const|function)\\s+${escapedSym}\\b[^\\n]*`, "g"), "")
          .replace(new RegExp(`export\\s+type\\s+${escapedSym}\\s*=[\\s\\S]*?(?:\\n|$)`, "g"), "")
        if (
          !symbolRefRegex.test(combinedSiblingContent) &&
          !symbolRefRegex.test(internalStripped)
        ) {
          findings.push({
            kind: "unused-contract-export",
            nodeId: `${scope}/contract:${symbolName}`,
            location: relContractFile,
            message: `Contract symbol "${symbolName}" exported from "${relContractFile}" is never imported or used by any downstream package or fixture in scope "${scope}".`,
            action: `Import "${symbolName}" in a downstream package/fixture or remove the unused contract export from "${relContractFile}".`,
          })
        }
      }

      if (!hasActiveStubs && nonTestSiblingContent.trim().length > 0) {
        const taggedErrorRegex =
          /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+Schema\.TaggedError/g
        let errMatch: RegExpExecArray | null
        while ((errMatch = taggedErrorRegex.exec(strippedContractContent)) !== null) {
          const errName = errMatch[1]!
          const escapedErr = escapeRegex(errName)
          const constructRegex = new RegExp(
            `(?:\\bnew\\s+${escapedErr}\\s*\\(|\\b${escapedErr}\\.make\\s*\\()`,
          )
          if (!constructRegex.test(nonTestSiblingContent)) {
            findings.push({
              kind: "dead-tagged-error",
              nodeId: `${scope}/contract:${errName}`,
              location: relContractFile,
              message: `Contract TaggedError "${errName}" in "${relContractFile}" is never constructed (new ${errName}(...)) in any non-test implementation or fixture file in scope "${scope}".`,
              action: `Construct and fail with "new ${errName}(...)" in the implementation or remove the phantom error from "${relContractFile}".`,
            })
          }
        }
      }
    }
  }
  return findings
}

// Rule: node-sqlite-in-infra (branching violations filter)
export const evaluateBranchingSqliteViolations = (
  input: GraphEntropyInput,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  for (const bv of input.graph.branchingViolations ?? []) {
    if (bv.rule === "node-sqlite-in-infra") {
      findings.push({
        kind: "node-sqlite-in-infra",
        nodeId: bv.enclosingSymbol,
        location: `${bv.file}:${bv.line}`,
        message: bv.message,
        action:
          "Replace node:sqlite with real Cloudflare workerd storage via @alchemy.run/cloudflare-runtime (Workerd SQLite Durable Object or D1.local) per harness:ADR-0008 / harness:SPEC-0006.",
      })
    }
  }
  return findings
}

const unwrapParens = (expr: ts.Expression): ts.Expression => {
  let current = expr
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

const isLiteralLikeExpr = (expr: ts.Expression): boolean => {
  const e = unwrapParens(expr)
  return (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === "undefined")
  )
}

const astPrinter = ts.createPrinter({ removeComments: true })

const normalizeTargetExpr = (expr: ts.Expression, sourceFile: ts.SourceFile): string =>
  astPrinter
    .printNode(ts.EmitHint.Expression, unwrapParens(expr), sourceFile)
    .replace(/\s+/g, " ")
    .trim()

const extractEqualityTargets = (
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): ReadonlyArray<string> | undefined => {
  const e = unwrapParens(expr)
  if (!ts.isBinaryExpression(e)) return undefined
  if (
    e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
    e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    const left = extractEqualityTargets(e.left, sourceFile)
    const right = extractEqualityTargets(e.right, sourceFile)
    if (left === undefined || right === undefined) return undefined
    const shared = left.filter((t) => right.includes(t))
    return shared.length > 0 ? shared : undefined
  }
  if (
    e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    const leftLit = isLiteralLikeExpr(e.left)
    const rightLit = isLiteralLikeExpr(e.right)
    if (leftLit && rightLit) return undefined
    if (leftLit) return [normalizeTargetExpr(e.right, sourceFile)]
    if (rightLit) return [normalizeTargetExpr(e.left, sourceFile)]
    return [normalizeTargetExpr(e.left, sourceFile), normalizeTargetExpr(e.right, sourceFile)]
  }
  return undefined
}

export const checkChainedEqualityTernaries = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  const candidateFiles: Array<string> = []
  for (const rootSubdir of ["libs", "apps"]) {
    const dir = join(repoRoot, rootSubdir)
    if (hostIo.existsSync(dir)) {
      candidateFiles.push(...collectWorkspaceTsFiles(dir, hostIo, findings, repoRoot))
    }
  }

  for (const filePath of candidateFiles) {
    const relPath = relative(repoRoot, filePath).replace(/\\/g, "/")
    if (!/^(?:libs|apps)\/.*\/src\/.*\.tsx?$/.test(relPath)) continue
    if (/\/test\//.test(relPath) || /\.test\.tsx?$/.test(relPath)) continue

    const content = readTextOrReport(filePath, hostIo, repoRoot, findings)
    if (content === undefined) continue

    const scriptKind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(
      relPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    )
    const reported = new Set<ts.ConditionalExpression>()

    const markMatchingArmChain = (arm: ts.Expression, sharedTarget: string): void => {
      const unwrapped = unwrapParens(arm)
      if (!ts.isConditionalExpression(unwrapped)) return
      const armTargets = extractEqualityTargets(unwrapped.condition, sourceFile)
      if (armTargets === undefined || !armTargets.includes(sharedTarget)) return
      reported.add(unwrapped)
      markMatchingArmChain(unwrapped.whenFalse, sharedTarget)
      markMatchingArmChain(unwrapped.whenTrue, sharedTarget)
    }

    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node) && !reported.has(node)) {
        const targets1 = extractEqualityTargets(node.condition, sourceFile)
        if (targets1 !== undefined) {
          const falseCond = unwrapParens(node.whenFalse)
          const trueCond = unwrapParens(node.whenTrue)
          const falseTargets = ts.isConditionalExpression(falseCond)
            ? extractEqualityTargets(falseCond.condition, sourceFile)
            : undefined
          const trueTargets = ts.isConditionalExpression(trueCond)
            ? extractEqualityTargets(trueCond.condition, sourceFile)
            : undefined
          const sharedTarget = targets1.find(
            (t) =>
              (falseTargets !== undefined && falseTargets.includes(t)) ||
              (trueTargets !== undefined && trueTargets.includes(t)),
          )
          if (sharedTarget !== undefined) {
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
            findings.push({
              kind: "chained-equality-ternary",
              nodeId: `${relPath}:${line}:${sharedTarget}`,
              location: `${relPath}:${line}`,
              message: `Chained equality ternary on "${sharedTarget}" at ${relPath}:${line}.`,
              action: `Replace chained equality ternary on "${sharedTarget}" with match(value).with(...).exhaustive() from ts-pattern (or RECORD[key] with satisfies Record<(typeof LITERALS)[number], V> in effect-only type:contract).`,
            })
            reported.add(node)
            markMatchingArmChain(node.whenFalse, sharedTarget)
            markMatchingArmChain(node.whenTrue, sharedTarget)
          }
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return findings
}

export const evaluateTopologyEntropyPlugin = (
  input: GraphEntropyInput,
  ctx: GraphReachabilityContext,
): ReadonlyArray<GcFinding> => {
  const g = input.graph.graph
  const findings: Array<GcFinding> = []

  // Rule: unused-service
  for (const [idx, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "ServiceTag" }, (n) => {
        if (isIgnoredServiceTag(n.tagId, n.name)) return
        const totalConsumers =
          (ctx.incomingRequires.get(idx) ?? 0) + (ctx.incomingLayerRequires.get(idx) ?? 0)
        if (totalConsumers === 0) {
          const location = n.file
            ? typeof n.line === "number"
              ? `${n.file}:${n.line}`
              : n.file
            : undefined
          findings.push({
            kind: "unused-service",
            nodeId: n.tagId,
            location,
            message: `ServiceTag "${n.tagId}" has no consumers (0 RequiresService / LayerRequires edges).`,
            action: `Either inject ServiceTag "${n.tagId}" into an Effect generator (yield* ${n.name}) or remove the unused declaration.`,
          })
        }
      })
      .with(
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectFn" },
        { _tag: "PatternDoc" },
        { _tag: "SchemaDef" },
        { _tag: "ServiceLayer" },
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

  // Rule: unprovided-service
  for (const [idx, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "ServiceTag" }, (n) => {
        if (isIgnoredServiceTag(n.tagId, n.name)) return
        const providers = ctx.incomingProvides.get(idx) ?? 0
        if (providers === 0) {
          const location = n.file
            ? typeof n.line === "number"
              ? `${n.file}:${n.line}`
              : n.file
            : undefined
          findings.push({
            kind: "unprovided-service",
            nodeId: n.tagId,
            location,
            message: `ServiceTag "${n.tagId}" has no providing ServiceLayer (0 ProvidesService edges).`,
            action: `Provide a live layer implementing "${n.tagId}" (e.g. Layer.succeed / Layer.effect) in type:infra.`,
          })
        }
      })
      .with(
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectFn" },
        { _tag: "PatternDoc" },
        { _tag: "SchemaDef" },
        { _tag: "ServiceLayer" },
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

  // Rule: dead-tagged-error
  for (const [idx, node] of Graph.nodes(g)) {
    match(node)
      .with({ _tag: "TaggedError" }, (n) => {
        if (IGNORED_ERRORS.has(n.errorTag)) return
        const failsWithCount = ctx.incomingFailsWith.get(idx) ?? 0
        if (failsWithCount === 0) {
          const location = n.file
            ? typeof n.line === "number"
              ? `${n.file}:${n.line}`
              : n.file
            : undefined
          findings.push({
            kind: "dead-tagged-error",
            nodeId: n.errorTag,
            location,
            message: `TaggedError "${n.errorTag}" is never emitted in any E channel (0 FailsWith edges).`,
            action: `Fail with this error using Effect.fail(new ${n.errorTag}(...)) in a domain use case or prune unused error definition.`,
          })
        }
      })
      .with(
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectFn" },
        { _tag: "PatternDoc" },
        { _tag: "SchemaDef" },
        { _tag: "ServiceLayer" },
        { _tag: "ServiceTag" },
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

  // Rule: missing-pattern-doc
  if (input.expectedPatterns !== undefined) {
    const existingPatternSlugs = new Set<string>()
    for (const [, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "PatternDoc" }, (n) => {
          existingPatternSlugs.add(n.slug)
          if (typeof n.patternName === "string") existingPatternSlugs.add(n.patternName)
          if (typeof n.path === "string" && n.path.endsWith(".md")) {
            const base = n.path.split("/").pop()?.replace(/\.md$/, "")
            if (base) existingPatternSlugs.add(base)
          }
        })
        .with(
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EarsRequirement" },
          { _tag: "EffectFn" },
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
    for (const p of input.expectedPatterns) {
      if (p === "review" || p === "effect") continue
      if (!existingPatternSlugs.has(p)) {
        findings.push({
          kind: "missing-pattern-doc",
          nodeId: `Pattern:${p}`,
          location: `agent-patterns/${p}.md`,
          message: `Pattern doc "agent-patterns/${p}.md" registered in IdiomRouterV1 is missing from the graph.`,
          action: `Create "agent-patterns/${p}.md" documenting this idiom or remove "${p}" from IDIOM_BLOCKS in IdiomRouter.`,
        })
      }
    }
  }

  if (input.workspaceRoot !== undefined && input.hostIo !== undefined) {
    findings.push(...checkChainedEqualityTernaries(input.workspaceRoot, input.hostIo))
  }

  return findings
}
