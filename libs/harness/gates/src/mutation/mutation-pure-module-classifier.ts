import { basename, join, relative } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"

export type PureModuleClassification =
  | { readonly _tag: "Pure" }
  | { readonly _tag: "Excluded"; readonly reason: string }

export interface PureDiscoveredFile {
  readonly scope: string
  readonly pkgDir: string
  readonly pkgName?: string | undefined
  readonly tier: "infra-pure" | "app-pure"
  readonly fullPath: string
  readonly relFile: string
}

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
  "effect/workflow",
  "effect/ai",
  "effect/sql",
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
  "effect/unstable/sql",
  "@harness/infra/",
]

const DISALLOWED_EFFECT_IO_SYMBOLS: ReadonlySet<string> = new Set([
  "FileSystem",
  "Terminal",
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
  spec.startsWith("./") || spec.startsWith("../")

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

/**
 * Classifies an `infra` or non-web `app` TypeScript source module as `"Pure"` when it
 * defines runtime logic with zero runtime I/O imports, host globals, or live Layer builders,
 * and `"Excluded"` otherwise.
 */
export const classifyMutationModulePurity = (
  relFile: string,
  sourceText: string,
): PureModuleClassification => {
  const norm = relFile.replace(/\\/g, "/").replace(/^\.\//, "")
  const base = basename(norm)
  if (norm.endsWith(".d.ts") || /\.config\.[cm]?tsx?$/.test(base)) {
    return { _tag: "Excluded", reason: `non-module config/declaration '${base}'` }
  }
  if (
    base === "index.ts" ||
    base === "index.tsx" ||
    base === "hook-entry.ts" ||
    base === "server.ts"
  ) {
    return { _tag: "Excluded", reason: `entrypoint or barrel file '${base}'` }
  }

  const sf = ts.createSourceFile(norm, sourceText, ts.ScriptTarget.Latest, true)
  if (!hasRuntimeTopLevelStatement(sf)) {
    return { _tag: "Excluded", reason: `type-only or re-export-only file '${base}'` }
  }

  let exclusionReason: string | undefined

  const visit = (node: ts.Node): void => {
    if (exclusionReason !== undefined) return
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
            if (!el.isTypeOnly && DISALLOWED_EFFECT_IO_SYMBOLS.has(el.name.text)) {
              exclusionReason = `imports runtime I/O service '${el.name.text}' from 'effect'`
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
            if (!el.isTypeOnly && DISALLOWED_CLUSTER_IO_SYMBOLS.has(el.name.text)) {
              exclusionReason = `imports runtime I/O service '${el.name.text}' from 'effect/cluster'`
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
        if (spec === "effect/cluster") {
          if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
            exclusionReason = "re-exports runtime namespace from 'effect/cluster'"
            return
          }
          for (const el of node.exportClause.elements) {
            if (!el.isTypeOnly && DISALLOWED_CLUSTER_IO_SYMBOLS.has(el.name.text)) {
              exclusionReason = `re-exports runtime I/O service '${el.name.text}' from 'effect/cluster'`
              return
            }
          }
        }
      }
      return
    }

    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const specErr = checkModuleSpecifier(node.arguments[0].text)
        if (specErr !== undefined) {
          exclusionReason = `dynamic ${specErr}`
          return
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const specErr = checkModuleSpecifier(node.arguments[0].text)
        if (specErr !== undefined) {
          exclusionReason = `require ${specErr}`
          return
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        exclusionReason = "calls global fetch()"
        return
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "globalThis" &&
        node.expression.name.text === "fetch"
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

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "process" && DISALLOWED_PROCESS_PROPS.has(node.name.text)) {
        exclusionReason = `accesses runtime global 'process.${node.name.text}'`
        return
      }
      if (node.expression.text === "Layer" && DISALLOWED_LAYER_BUILDERS.has(node.name.text)) {
        exclusionReason = `constructs runtime effectful Layer via 'Layer.${node.name.text}'`
        return
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
  return exclusionReason !== undefined
    ? { _tag: "Excluded", reason: exclusionReason }
    : { _tag: "Pure" }
}

/** Convenience predicate returning `true` when `classifyMutationModulePurity` returns `"Pure"`. */
export const isPureMutationCandidate = (relFile: string, sourceText: string): boolean =>
  match(classifyMutationModulePurity(relFile, sourceText))
    .with({ _tag: "Pure" }, () => true)
    .with({ _tag: "Excluded" }, () => false)
    .exhaustive()

const checkNonSymlinkEntry = (path: string, hostIo: SyncHostIo): string | undefined =>
  match(
    Result.try({
      try: () => hostIo.isSymbolicLinkSync(path),
      catch: (err) =>
        `Failed to check symlink '${path}': ${err instanceof Error ? err.message : String(err)}`,
    }),
  )
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success: isSym }) =>
      isSym ? `Refusing symlink entry '${path}'` : undefined,
    )
    .exhaustive()

/** Walks `srcDir`, collects TypeScript files that pass `isPureMutationCandidate`, and appends them to `results`. */
export const collectPureCandidateFilesChecked = (input: {
  readonly dir: string
  readonly repoRoot: string
  readonly scope: string
  readonly pkgDir: string
  readonly pkgName: string | undefined
  readonly tier: "infra-pure" | "app-pure"
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const dirExistsRes = Result.try({
    try: () => input.hostIo.existsSync(input.dir),
    catch: (err) =>
      `Failed to stat '${input.dir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const existsErr = match(dirExistsRes)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => (success ? undefined : null))
    .exhaustive()
  if (existsErr === null) return undefined
  if (existsErr !== undefined) return existsErr

  const dirSymErr = checkNonSymlinkEntry(input.dir, input.hostIo)
  if (dirSymErr !== undefined) return dirSymErr

  const entriesRes = Result.try({
    try: () => input.hostIo.readdirSync(input.dir),
    catch: (err) =>
      `Failed to read directory '${input.dir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const rawEntries = match(entriesRes)
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  if (rawEntries === undefined) {
    return match(entriesRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
  }

  const entries = [...rawEntries].sort((a, b) => compareCodeUnits(a.name, b.name))
  for (const entry of entries) {
    const full = join(input.dir, entry.name)
    const symErr = checkNonSymlinkEntry(full, input.hostIo)
    if (symErr !== undefined) return symErr

    if (entry.isDirectory) {
      const subErr = collectPureCandidateFilesChecked({ ...input, dir: full })
      if (subErr !== undefined) return subErr
      continue
    }
    if (
      !entry.isFile ||
      !(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ||
      entry.name.endsWith(".d.ts")
    ) {
      continue
    }

    const relFile = relative(input.repoRoot, full).replace(/\\/g, "/").replace(/^\.\//, "")
    if (input.targetSet !== undefined && !input.targetSet.has(relFile)) continue

    const readRes = Result.try({
      try: () => input.hostIo.readTextSync(full),
      catch: (err) =>
        `Failed to read '${full}': ${err instanceof Error ? err.message : String(err)}`,
    })
    const content = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (content === undefined) {
      return match(readRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive()
    }

    if (isPureMutationCandidate(relFile, content)) {
      input.results.push({
        scope: input.scope,
        pkgDir: input.pkgDir,
        pkgName: input.pkgName,
        tier: input.tier,
        fullPath: full,
        relFile,
      })
    }
  }
  return undefined
}

export type AppManifestReadResult =
  | {
      readonly _tag: "Ok"
      readonly manifest: {
        readonly pkgName: string | undefined
        readonly tags: ReadonlyArray<string>
      }
    }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "CorruptManifest"
      readonly packageJsonPath: string
      readonly reason: string
    }

/** Scans top-level non-web/non-fixture packages under `apps/` for pure zero-I/O source modules. */
export const discoverAppPureFilesChecked = (input: {
  readonly repoRoot: string
  readonly scope: string | undefined
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly readPackageManifest: (pkgPath: string, hostIo: SyncHostIo) => AppManifestReadResult
  readonly matchesScopeFilter: (
    scope: string,
    sDir: string,
    pkgDir: string,
    pkgName: string | undefined,
  ) => boolean
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const appsDir = join(input.repoRoot, "apps")
  const existsRes = Result.try({
    try: () => input.hostIo.existsSync(appsDir),
    catch: (err) =>
      `Failed to stat '${appsDir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const existsErr = match(existsRes)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => (success ? undefined : null))
    .exhaustive()
  if (existsErr === null) return undefined
  if (existsErr !== undefined) return existsErr

  const symErr = checkNonSymlinkEntry(appsDir, input.hostIo)
  if (symErr !== undefined) return symErr

  const dirRes = Result.try({
    try: () => input.hostIo.readdirSync(appsDir),
    catch: (err) =>
      `Failed to read directory '${appsDir}': ${err instanceof Error ? err.message : String(err)}`,
  })
  const rawEntries = match(dirRes)
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  if (rawEntries === undefined) {
    return match(dirRes)
      .with({ _tag: "Failure" }, ({ failure }) => failure)
      .with({ _tag: "Success" }, () => "")
      .exhaustive()
  }

  const appDirs = [...rawEntries]
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort(compareCodeUnits)

  for (const appDir of appDirs) {
    const appPath = join(appsDir, appDir)
    const appErr = match(input.readPackageManifest(appPath, input.hostIo))
      .with({ _tag: "CorruptManifest" }, ({ reason }) => reason)
      .with({ _tag: "Missing" }, () => undefined)
      .with({ _tag: "Ok" }, ({ manifest }) => {
        if (
          manifest.tags.includes("scope:web") ||
          manifest.tags.includes("scope:fixture") ||
          !manifest.tags.includes("type:app")
        ) {
          return undefined
        }
        if (
          input.scope !== undefined &&
          !input.matchesScopeFilter(input.scope, "apps", appDir, manifest.pkgName)
        ) {
          return undefined
        }
        return collectPureCandidateFilesChecked({
          dir: join(appPath, "src"),
          repoRoot: input.repoRoot,
          scope: "apps",
          pkgDir: appDir,
          pkgName: manifest.pkgName,
          tier: "app-pure",
          targetSet: input.targetSet,
          hostIo: input.hostIo,
          results: input.results,
        })
      })
      .exhaustive()
    if (appErr !== undefined) return appErr
  }
  return undefined
}

/** Scans a single `type:infra` or non-web `type:app` library package for pure zero-I/O source files. */
export const collectExcludedLibPureFilesChecked = (input: {
  readonly pkgPath: string
  readonly repoRoot: string
  readonly sDir: string
  readonly pkgDir: string
  readonly pkgName: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly scope: string | undefined
  readonly targetSet: ReadonlySet<string> | undefined
  readonly hostIo: SyncHostIo
  readonly matchesScopeFilter: (
    scope: string,
    sDir: string,
    pkgDir: string,
    pkgName: string | undefined,
  ) => boolean
  readonly results: Array<PureDiscoveredFile>
}): string | undefined => {
  const pureTier: PureDiscoveredFile["tier"] | undefined =
    input.tags.includes("type:infra") && !input.tags.includes("scope:fixture")
      ? "infra-pure"
      : input.tags.includes("type:app") &&
          !input.tags.includes("scope:web") &&
          !input.tags.includes("scope:fixture")
        ? "app-pure"
        : undefined
  if (pureTier === undefined) return undefined
  if (
    input.scope !== undefined &&
    !input.matchesScopeFilter(input.scope, input.sDir, input.pkgDir, input.pkgName)
  ) {
    return undefined
  }
  return collectPureCandidateFilesChecked({
    dir: join(input.pkgPath, "src"),
    repoRoot: input.repoRoot,
    scope: input.sDir,
    pkgDir: input.pkgDir,
    pkgName: input.pkgName,
    tier: pureTier,
    targetSet: input.targetSet,
    hostIo: input.hostIo,
    results: input.results,
  })
}
