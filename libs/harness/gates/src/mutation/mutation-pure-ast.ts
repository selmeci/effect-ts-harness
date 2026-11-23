import { basename } from "node:path"
import { match } from "ts-pattern"
import { ts } from "@harness/graph"

export type PureModuleClassification =
  | { readonly _tag: "Pure" }
  | { readonly _tag: "Excluded"; readonly reason: string }

const DISALLOWED_NODE_BUILTINS: ReadonlySet<string> = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
  "http2",
  "dgram",
  "tls",
  "dns",
  "os",
  "worker_threads",
  "cluster",
  "readline",
  "sqlite",
  "stream",
  "tty",
  "v8",
  "vm",
  "inspector",
  "perf_hooks",
  "process",
  "module",
  "timers",
  "timers/promises",
  "async_hooks",
  "dns/promises",
  "stream/promises",
])

const DISALLOWED_PACKAGE_EXACT: ReadonlySet<string> = new Set([
  "@effect/platform",
  "@effect/platform-node",
  "@effect/ai-typesafe",
  "alchemy",
  "better-sqlite3",
  "drizzle-orm",
  "drizzle-kit",
  "undici",
  "ws",
  "execa",
  "chokidar",
  "effect/FileSystem",
  "effect/Terminal",
  "effect/ChildProcess",
  "effect/Stdio",
  "effect/workflow",
  "effect/ai",
  "effect/sql",
  "effect/http",
  "effect/http-api",
  "effect/process",
  "effect/rpc",
  "effect/cli",
  "effect/socket",
  "effect/net",
  "effect/workers",
  "effect/persistence",
  "effect/eventlog",
  "effect/devtools",
  "@harness/infra",
])

const DISALLOWED_PACKAGE_PREFIXES: ReadonlyArray<string> = [
  "@effect/platform/",
  "@effect/platform-node/",
  "@effect/sql",
  "@modelcontextprotocol/",
  "alchemy/",
  "@alchemy.run/",
  "@cloudflare/",
  "effect/cluster/",
  "effect/sql/",
  "effect/ai/",
  "effect/http/",
  "effect/http-api/",
  "effect/process/",
  "effect/rpc/",
  "effect/cli/",
  "effect/socket/",
  "effect/net/",
  "effect/workers/",
  "effect/persistence/",
  "effect/eventlog/",
  "effect/Stdio/",
  "effect/devtools/",
  "effect/workflow/",
  "effect/unstable/",
  "@harness/infra/",
]

const DISALLOWED_EFFECT_IO_SYMBOLS: ReadonlySet<string> = new Set([
  "FileSystem",
  "Terminal",
  "Stdio",
  "Command",
  "HttpClient",
  "HttpServer",
])

const DISALLOWED_CLUSTER_IO_SYMBOLS: ReadonlySet<string> = new Set([
  "Sharding",
  "Runners",
  "RunnerStorage",
  "RunnerHealth",
  "MessageStorage",
  "ClusterWorkflowEngine",
  "HttpRunner",
  "SocketRunner",
  "SqlMessageStorage",
  "SqlRunnerStorage",
  "SocketAddress",
  "SingleRunner",
  "Snowflake",
])

const DISALLOWED_INTERNAL_STEMS: ReadonlySet<string> = new Set([
  "node-host-io",
  "hook-io",
  "hook-io-realpath",
  "hook-fastpath",
  "omnigraph-workflow-store",
  "omnigraph-runner",
  "omnigraph-message-storage",
  "workflow-engine-live",
  "workflow-graph-backup",
  "workflow-maintenance",
  "unix-socket-daemon",
  "unix-socket-daemon-live",
  "daemon-client",
  "daemon-and-omnigraph.service",
  "cli-runtime",
  "mcp-helpers",
  "worktree-port-live",
  "workflow-worktree-live",
  "workflow-merge-live",
  "unit-verifier-live",
  "review-router-live",
  "agent-dispatcher-live",
  "read-model-live",
  "message-storage-cas",
  "message-storage-hydration",
  "cluster-startup-lock",
  "flock-lock",
  "writer-lease",
  "ast-gate-cache",
  "ast-gate-cache-live",
  "ast-gate-cache-helpers",
  "decision-cache-live",
  "local-decision-model-live",
  "subprocess-runner-live",
  "workspace-fs-live",
  "active-mutant-context-live",
  "worktree-repo-root",
  "plan-compiler-extractor",
  "mutation-hmac-secret",
  "git-helpers",
  "scenario-fs",
  "omnigraph-lifecycle",
  "omnigraph-lifecycle-setup",
  "omnigraph-auth-and-drift",
  "omnigraph-workflow-backup",
  "omnigraph-workflow-journal",
  "workflow-rpc-shared",
  "workflow-rpc-complete-validation",
  "workflow-engine-daemon-helper",
  "ollama-readiness",
])

const DISALLOWED_PROCESS_PROPS: ReadonlySet<string> = new Set([
  "stdin",
  "stdout",
  "stderr",
  "exit",
  "cwd",
  "chdir",
  "kill",
  "env",
  "argv",
  "hrtime",
  "nextTick",
])

const DISALLOWED_LAYER_BUILDERS: ReadonlySet<string> = new Set([
  "effect",
  "scoped",
  "unwrapEffect",
  "effectDiscard",
  "scopedDiscard",
  "sync",
  "scopedContext",
])

const isRelativeSpecifier = (spec: string): boolean =>
  spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")

const getStaticModuleLiteral = (expr: ts.Expression | undefined): string | undefined => {
  if (expr === undefined) return undefined
  const u = unwrapAstExpr(expr)
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
}

const isProcessRefExpr = (expr: ts.Expression): boolean => {
  const u = unwrapAstExpr(expr)
  if (ts.isIdentifier(u) && u.text === "process") return true
  if (
    ts.isPropertyAccessExpression(u) &&
    u.name.text === "process" &&
    ts.isIdentifier(unwrapAstExpr(u.expression)) &&
    (unwrapAstExpr(u.expression) as ts.Identifier).text === "globalThis"
  ) {
    return true
  }
  return (
    ts.isElementAccessExpression(u) &&
    ts.isIdentifier(unwrapAstExpr(u.expression)) &&
    (unwrapAstExpr(u.expression) as ts.Identifier).text === "globalThis" &&
    getStaticModuleLiteral(u.argumentExpression) === "process"
  )
}

const stripNodePrefix = (spec: string): string =>
  spec.startsWith("node:") ? spec.slice("node:".length) : spec

const extractModuleStem = (spec: string): string =>
  basename(spec).replace(/\.(?:[cm]?[jt]sx?)$/, "")

const checkModuleSpecifier = (spec: string): string | undefined => {
  if (isRelativeSpecifier(spec)) {
    const stem = extractModuleStem(spec)
    if (DISALLOWED_INTERNAL_STEMS.has(stem)) {
      return `imports internal I/O module '${spec}'`
    }
    return undefined
  }
  const bare = stripNodePrefix(spec)
  const firstBuiltinRoot = bare.split("/")[0] ?? bare
  if (
    spec.startsWith("node:")
      ? DISALLOWED_NODE_BUILTINS.has(bare) || DISALLOWED_NODE_BUILTINS.has(firstBuiltinRoot)
      : DISALLOWED_NODE_BUILTINS.has(bare)
  ) {
    return `imports Node I/O builtin '${spec}'`
  }
  if (
    DISALLOWED_PACKAGE_EXACT.has(spec) ||
    DISALLOWED_PACKAGE_PREFIXES.some((prefix) => spec.startsWith(prefix))
  ) {
    return `imports runtime I/O package '${spec}'`
  }
  return undefined
}

const isImportTypeOnly = (clause: ts.ImportClause | undefined): boolean => {
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined || clause.namedBindings === undefined) return false
  if (!ts.isNamedImports(clause.namedBindings)) return false
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((el) => el.isTypeOnly)
  )
}

const isExportTypeOnly = (decl: ts.ExportDeclaration): boolean => {
  if (decl.isTypeOnly) return true
  if (decl.exportClause === undefined || !ts.isNamedExports(decl.exportClause)) return false
  return (
    decl.exportClause.elements.length > 0 && decl.exportClause.elements.every((el) => el.isTypeOnly)
  )
}

const hasRuntimeTopLevelStatement = (sf: ts.SourceFile): boolean => {
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEmptyStatement(stmt)
    ) {
      continue
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      continue
    }
    return true
  }
  return false
}

const unwrapAstExpr = (expr: ts.Expression): ts.Expression => {
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

export interface ModulePurityAnalysis {
  readonly classification: PureModuleClassification
  readonly relativeValueImports: ReadonlyArray<string>
}

/** Analyzes single-module TypeScript AST purity plus extracted non-type-only relative imports. */
export const analyzeModulePurityAst = (
  relFile: string,
  sourceText: string,
): ModulePurityAnalysis => {
  const norm = relFile.replace(/\\/g, "/").replace(/^\.\//, "")
  const base = basename(norm)
  if (norm.endsWith(".d.ts") || /\.config\.[cm]?tsx?$/.test(base)) {
    return {
      classification: { _tag: "Excluded", reason: `non-module config/declaration '${base}'` },
      relativeValueImports: [],
    }
  }
  if (
    base === "index.ts" ||
    base === "index.tsx" ||
    base === "hook-entry.ts" ||
    base === "server.ts"
  ) {
    return {
      classification: { _tag: "Excluded", reason: `entrypoint or barrel file '${base}'` },
      relativeValueImports: [],
    }
  }

  const sf = ts.createSourceFile(norm, sourceText, ts.ScriptTarget.Latest, true)
  const relativeValueImports: Array<string> = []
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      isRelativeSpecifier(stmt.moduleSpecifier.text) &&
      !isImportTypeOnly(stmt.importClause)
    ) {
      relativeValueImports.push(stmt.moduleSpecifier.text)
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      isRelativeSpecifier(stmt.moduleSpecifier.text) &&
      !isExportTypeOnly(stmt)
    ) {
      relativeValueImports.push(stmt.moduleSpecifier.text)
    }
  }

  if (!hasRuntimeTopLevelStatement(sf)) {
    return {
      classification: { _tag: "Excluded", reason: `type-only or re-export-only file '${base}'` },
      relativeValueImports,
    }
  }

  let exclusionReason: string | undefined

  const visit = (node: ts.Node): void => {
    if (exclusionReason !== undefined) return
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) {
      return
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      visit(node.expression)
      return
    }
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      return
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isImportTypeOnly(node.importClause)) {
        const spec = node.moduleSpecifier.text
        const specErr = checkModuleSpecifier(spec)
        if (specErr !== undefined) {
          exclusionReason = specErr
          return
        }
        if (
          spec === "effect" &&
          node.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const el of node.importClause.namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text
            if (!el.isTypeOnly && DISALLOWED_EFFECT_IO_SYMBOLS.has(imported)) {
              exclusionReason = `imports runtime I/O service '${imported}' from 'effect'`
              return
            }
          }
        }
        if (spec === "effect/cluster") {
          const clause = node.importClause
          if (
            clause === undefined ||
            clause.name !== undefined ||
            clause.namedBindings === undefined ||
            !ts.isNamedImports(clause.namedBindings)
          ) {
            exclusionReason = "imports runtime namespace from 'effect/cluster'"
            return
          }
          for (const el of clause.namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text
            if (!el.isTypeOnly && DISALLOWED_CLUSTER_IO_SYMBOLS.has(imported)) {
              exclusionReason = `imports runtime I/O service '${imported}' from 'effect/cluster'`
              return
            }
          }
        }
      }
      return
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isExportTypeOnly(node)) {
        const spec = node.moduleSpecifier.text
        const specErr = checkModuleSpecifier(spec)
        if (specErr !== undefined) {
          exclusionReason = specErr
          return
        }
        if (spec === "effect") {
          if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
            exclusionReason = "re-exports runtime namespace from 'effect'"
            return
          }
          for (const el of node.exportClause.elements) {
            const exported = (el.propertyName ?? el.name).text
            if (!el.isTypeOnly && DISALLOWED_EFFECT_IO_SYMBOLS.has(exported)) {
              exclusionReason = `re-exports runtime I/O service '${exported}' from 'effect'`
              return
            }
          }
        }
        if (spec === "effect/cluster") {
          if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
            exclusionReason = "re-exports runtime namespace from 'effect/cluster'"
            return
          }
          for (const el of node.exportClause.elements) {
            const exported = (el.propertyName ?? el.name).text
            if (!el.isTypeOnly && DISALLOWED_CLUSTER_IO_SYMBOLS.has(exported)) {
              exclusionReason = `re-exports runtime I/O service '${exported}' from 'effect/cluster'`
              return
            }
          }
        }
      }
      return
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapAstExpr(node.expression)
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = getStaticModuleLiteral(node.arguments[0])
        if (spec !== undefined) {
          if (isRelativeSpecifier(spec)) {
            relativeValueImports.push(spec)
          }
          const specErr = checkModuleSpecifier(spec)
          if (specErr !== undefined) {
            exclusionReason = `dynamic ${specErr}`
            return
          }
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "require") {
        const spec = getStaticModuleLiteral(node.arguments[0])
        if (spec !== undefined) {
          if (isRelativeSpecifier(spec)) {
            relativeValueImports.push(spec)
          }
          const specErr = checkModuleSpecifier(spec)
          if (specErr !== undefined) {
            exclusionReason = `require ${specErr}`
            return
          }
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        exclusionReason = "calls global fetch()"
        return
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(unwrapAstExpr(callee.expression)) &&
        (unwrapAstExpr(callee.expression) as ts.Identifier).text === "globalThis" &&
        callee.name.text === "fetch"
      ) {
        exclusionReason = "calls globalThis.fetch()"
        return
      }
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "OmnigraphClient"
    ) {
      exclusionReason = "instantiates live client 'new OmnigraphClient()'"
      return
    }

    if (ts.isPropertyAccessExpression(node)) {
      const target = unwrapAstExpr(node.expression)
      if (isProcessRefExpr(target) && DISALLOWED_PROCESS_PROPS.has(node.name.text)) {
        exclusionReason = `accesses runtime global 'process.${node.name.text}'`
        return
      }
      if (
        ts.isIdentifier(target) &&
        target.text === "Layer" &&
        DISALLOWED_LAYER_BUILDERS.has(node.name.text)
      ) {
        exclusionReason = `constructs runtime effectful Layer via 'Layer.${node.name.text}'`
        return
      }
    }

    if (ts.isElementAccessExpression(node)) {
      if (isProcessRefExpr(node.expression)) {
        const arg =
          node.argumentExpression !== undefined ? unwrapAstExpr(node.argumentExpression) : undefined
        if (
          arg === undefined ||
          ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
            DISALLOWED_PROCESS_PROPS.has(arg.text)) ||
          (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))
        ) {
          exclusionReason = "accesses runtime global 'process[...]'"
          return
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (isProcessRefExpr(node.initializer)) {
        if (ts.isIdentifier(node.name)) {
          exclusionReason = "aliases runtime global 'process'"
          return
        }
        if (ts.isObjectBindingPattern(node.name)) {
          const accessesProp = node.name.elements.some((el) => {
            if (el.dotDotDotToken !== undefined) return true
            const keyNode = el.propertyName ?? el.name
            if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode)) {
              return DISALLOWED_PROCESS_PROPS.has(keyNode.text)
            }
            return true
          })
          if (accessesProp) {
            exclusionReason = "destructures runtime global 'process'"
            return
          }
        }
      }
    }

    if (ts.isIdentifier(node)) {
      if (
        node.text === "nodeSyncHostIo" ||
        node.text === "nodeExtendedHostIo" ||
        node.text === "makeWorkflowOmnigraphClient"
      ) {
        exclusionReason = `references live host/client dependency '${node.text}'`
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  return {
    classification:
      exclusionReason !== undefined
        ? { _tag: "Excluded", reason: exclusionReason }
        : { _tag: "Pure" },
    relativeValueImports,
  }
}

/**
 * Classifies an `infra` or non-web `app` TypeScript source module as `"Pure"` when it
 * defines runtime logic with zero runtime I/O imports, host globals, or live Layer builders,
 * and `"Excluded"` otherwise.
 */
export const classifyMutationModulePurity = (
  relFile: string,
  sourceText: string,
): PureModuleClassification => analyzeModulePurityAst(relFile, sourceText).classification

/** Convenience predicate returning `true` when `classifyMutationModulePurity` returns `"Pure"`. */
export const isPureMutationCandidate = (relFile: string, sourceText: string): boolean =>
  match(classifyMutationModulePurity(relFile, sourceText))
    .with({ _tag: "Pure" }, () => true)
    .with({ _tag: "Excluded" }, () => false)
    .exhaustive()
