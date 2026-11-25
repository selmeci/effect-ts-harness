import { join, posix } from "node:path"
import { Schema } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { type GcFinding, readdirOrReport, readTextOrReport } from "./gc-helpers.js"

export const HOOK_FASTPATH_ENTRYPOINTS: ReadonlyArray<string> = [
  "libs/harness/gates/src/hook-fastpath.ts",
  "libs/harness/gates/src/policy.ts",
  "libs/harness/decision/src/hook-fastpath.ts",
  "libs/harness/infra/src/hook-fastpath.ts",
  "libs/harness/infra/src/hook-io.ts",
  "libs/harness/graph/src/cluster-resolver.ts",
  "apps/harness-cli/src/index.ts",
  "apps/harness-cli/src/hook-entry.ts",
  "apps/harness-cli/src/commands/guard-and-route.command.ts",
  "apps/harness-cli/src/commands/session-fastpath.ts",
  "apps/harness-cli/src/commands/ingest-fastpath.ts",
  "apps/harness-cli/src/commands/session-learn-report.command.ts",
  "apps/harness-cli/src/commands/learn-and-report.command.ts",
]

const FALLBACK_WORKSPACE_SPECIFIER_MAP: Readonly<Record<string, string>> = {
  "@harness/contract": "libs/harness/contract/src/index.ts",
  "@harness/service": "libs/harness/service/src/index.ts",
  "@harness/service/host-io": "libs/harness/service/src/host-io.ts",
  "@harness/gates": "libs/harness/gates/src/index.ts",
  "@harness/gates/hook-fastpath": "libs/harness/gates/src/hook-fastpath.ts",
  "@harness/gates/policy": "libs/harness/gates/src/policy.ts",
  "@harness/decision": "libs/harness/decision/src/index.ts",
  "@harness/decision/hook-fastpath": "libs/harness/decision/src/hook-fastpath.ts",
  "@harness/infra": "libs/harness/infra/src/index.ts",
  "@harness/infra/hook-fastpath": "libs/harness/infra/src/hook-fastpath.ts",
  "@harness/infra/hook-io": "libs/harness/infra/src/hook-io.ts",
  "@harness/graph/cluster-resolver": "libs/harness/graph/src/cluster-resolver.ts",
}

const PkgExportsSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    exports: Schema.optional(Schema.Unknown),
  }),
)
const decodePkgExports = Schema.decodeUnknownOption(PkgExportsSchema)

const extractExportTargetString = (val: unknown): string | undefined => {
  if (typeof val === "string") return val
  if (typeof val === "object" && val !== null) {
    const rec = val as { readonly import?: unknown; readonly default?: unknown }
    if (typeof rec.import === "string") return rec.import
    if (typeof rec.default === "string") return rec.default
  }
  return undefined
}

const mapExportTargetToWorkspacePath = (
  repoRoot: string,
  pkgRelDir: string,
  rawTarget: string,
  hostIo: SyncHostIo,
): string | undefined => {
  const clean = rawTarget.replace(/^\.\//, "")
  const candidates: Array<string> = []
  if (clean.startsWith("dist/") && clean.endsWith(".js")) {
    const base = clean.slice("dist/".length, -3)
    candidates.push(`${pkgRelDir}/src/${base}.ts`, `${pkgRelDir}/src/${base}/index.ts`)
  }
  if (clean.startsWith("dist/") && clean.endsWith(".mjs")) {
    const base = clean.slice("dist/".length, -4)
    candidates.push(`${pkgRelDir}/src/${base}.ts`)
  }
  candidates.push(`${pkgRelDir}/${clean}`)
  for (const cand of candidates) {
    if (hostIo.existsSync(join(repoRoot, cand))) return cand
  }
  return undefined
}

interface WorkspaceSpecifierResolution {
  readonly workspaceMap: ReadonlyMap<string, string>
  readonly unresolvedWorkspaceExports: ReadonlyMap<string, string>
}

const buildWorkspaceSpecifierMap = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): WorkspaceSpecifierResolution => {
  const map = new Map<string, string>(Object.entries(FALLBACK_WORKSPACE_SPECIFIER_MAP))
  const unresolvedWorkspaceExports = new Map<string, string>()
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return { workspaceMap: map, unresolvedWorkspaceExports }
  const scopeEntries = readdirOrReport(libsDir, hostIo, repoRoot, findings)
  if (scopeEntries === undefined) return { workspaceMap: map, unresolvedWorkspaceExports }
  for (const scope of [...scopeEntries].sort((a, b) => compareCodeUnits(a.name, b.name))) {
    if (!scope.isDirectory || scope.name === "node_modules") continue
    const scopeDir = join(libsDir, scope.name)
    const pkgEntries = readdirOrReport(scopeDir, hostIo, repoRoot, findings)
    if (pkgEntries === undefined) continue
    for (const pkg of [...pkgEntries].sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (!pkg.isDirectory || pkg.name === "node_modules") continue
      const pkgRelDir = `libs/${scope.name}/${pkg.name}`
      const pkgJsonPath = join(repoRoot, pkgRelDir, "package.json")
      if (!hostIo.existsSync(pkgJsonPath)) continue
      const raw = readTextOrReport(pkgJsonPath, hostIo, repoRoot, findings)
      if (raw === undefined) continue
      match(decodePkgExports(raw))
        .with({ _tag: "None" }, () => undefined)
        .with({ _tag: "Some" }, ({ value }) => {
          const pkgName = value.name?.trim()
          if (pkgName === undefined || pkgName.length === 0) return
          const isHarnessPkg = pkgName.startsWith("@harness/")
          const exp = value.exports
          if (typeof exp === "string") {
            const resolved = mapExportTargetToWorkspacePath(repoRoot, pkgRelDir, exp, hostIo)
            if (resolved !== undefined) {
              map.set(pkgName, resolved)
              return
            }
            if (isHarnessPkg) {
              map.delete(pkgName)
              unresolvedWorkspaceExports.set(pkgName, exp)
            }
            return
          }
          if (typeof exp === "object" && exp !== null) {
            for (const [subKey, subVal] of Object.entries(exp)) {
              const target = extractExportTargetString(subVal)
              if (target === undefined) continue
              const resolved = mapExportTargetToWorkspacePath(repoRoot, pkgRelDir, target, hostIo)
              if (resolved === undefined) {
                if (!isHarnessPkg) continue
                if (subKey === ".") {
                  map.delete(pkgName)
                  unresolvedWorkspaceExports.set(pkgName, target)
                  continue
                }
                if (subKey.startsWith("./")) {
                  const suffix = subKey.slice(2)
                  const specifier = `${pkgName}/${suffix}`
                  map.delete(specifier)
                  if (!suffix.endsWith(".js")) map.delete(`${specifier}.js`)
                  unresolvedWorkspaceExports.set(specifier, target)
                }
                continue
              }
              if (subKey === ".") {
                map.set(pkgName, resolved)
                continue
              }
              if (subKey.startsWith("./")) {
                const suffix = subKey.slice(2)
                map.set(`${pkgName}/${suffix}`, resolved)
                if (!suffix.endsWith(".js")) map.set(`${pkgName}/${suffix}.js`, resolved)
              }
            }
          }
        })
        .exhaustive()
    }
  }
  return { workspaceMap: map, unresolvedWorkspaceExports }
}

type FastpathClosureProfile =
  | "standard"
  | "policy-zero-dep"
  | "hook-entry-lightweight"
  | "session-no-infra-barrel"

const LIGHTWEIGHT_EFFECT_SUBPATHS: ReadonlySet<string> = new Set([
  "effect/Option",
  "effect/Result",
  "effect/Schema",
])

const getClosureProfile = (entryRel: string): FastpathClosureProfile => {
  if (entryRel === "libs/harness/gates/src/policy.ts") return "policy-zero-dep"
  if (
    entryRel === "apps/harness-cli/src/hook-entry.ts" ||
    entryRel === "apps/harness-cli/src/commands/ingest-fastpath.ts" ||
    entryRel === "libs/harness/infra/src/hook-io.ts"
  ) {
    return "hook-entry-lightweight"
  }
  if (
    entryRel === "apps/harness-cli/src/commands/session-learn-report.command.ts" ||
    entryRel === "apps/harness-cli/src/commands/learn-and-report.command.ts"
  ) {
    return "session-no-infra-barrel"
  }
  return "standard"
}

const isForbiddenRuntimeSpecifier = (spec: string, profile: FastpathClosureProfile): boolean =>
  match(profile)
    .with(
      "standard",
      () =>
        spec === "typescript" ||
        spec.startsWith("typescript/") ||
        spec === "ts-morph" ||
        spec.startsWith("ts-morph/") ||
        spec === "@harness/graph" ||
        (spec.startsWith("@harness/graph/") &&
          spec !== "@harness/graph/cluster-resolver" &&
          spec !== "@harness/graph/cluster-resolver.js"),
    )
    .with(
      "policy-zero-dep",
      () =>
        spec === "effect" ||
        spec.startsWith("effect/") ||
        spec.startsWith("@effect/") ||
        spec === "typescript" ||
        spec.startsWith("typescript/") ||
        spec === "ts-morph" ||
        spec.startsWith("ts-morph/") ||
        spec.startsWith("@harness/"),
    )
    .with(
      "hook-entry-lightweight",
      () =>
        spec === "<non-literal-dynamic-import>" ||
        spec === "effect" ||
        (spec.startsWith("effect/") && !LIGHTWEIGHT_EFFECT_SUBPATHS.has(spec)) ||
        spec === "@effect/platform-node" ||
        spec.startsWith("@effect/platform-node/") ||
        spec === "@effect/ai-typesafe" ||
        spec.startsWith("@effect/ai-typesafe/") ||
        spec === "@harness/contract" ||
        spec.startsWith("@harness/contract/") ||
        spec === "@harness/service" ||
        spec.startsWith("@harness/service/") ||
        spec === "@harness/decision" ||
        spec.startsWith("@harness/decision/") ||
        spec === "@harness/ingest" ||
        spec.startsWith("@harness/ingest/") ||
        spec === "@harness/graph" ||
        spec.startsWith("@harness/graph/") ||
        spec === "@harness/gates" ||
        (spec.startsWith("@harness/gates/") &&
          spec !== "@harness/gates/policy" &&
          spec !== "@harness/gates/policy.js") ||
        spec === "@harness/infra" ||
        (spec.startsWith("@harness/infra/") &&
          spec !== "@harness/infra/hook-io" &&
          spec !== "@harness/infra/hook-io.js") ||
        spec === "typescript" ||
        spec.startsWith("typescript/") ||
        spec === "ts-morph" ||
        spec.startsWith("ts-morph/"),
    )
    .with(
      "session-no-infra-barrel",
      () => spec === "@harness/infra" || spec === "<non-literal-dynamic-import>",
    )
    .exhaustive()

const isForbiddenResolvedTarget = (resolved: string, profile: FastpathClosureProfile): boolean =>
  match(profile)
    .with("standard", () => resolved === "libs/harness/graph/src/index.ts")
    .with("policy-zero-dep", () => !resolved.startsWith("libs/harness/gates/src/policy"))
    .with(
      "hook-entry-lightweight",
      () =>
        resolved === "apps/harness-cli/src/index.ts" ||
        resolved === "libs/harness/graph/src/index.ts" ||
        resolved === "libs/harness/graph/src/cluster-resolver.ts" ||
        resolved === "libs/harness/gates/src/index.ts" ||
        resolved === "libs/harness/gates/src/hook-fastpath.ts" ||
        resolved === "libs/harness/infra/src/index.ts" ||
        resolved === "libs/harness/infra/src/hook-fastpath.ts" ||
        resolved.startsWith("libs/harness/contract/") ||
        resolved.startsWith("libs/harness/service/") ||
        resolved.startsWith("libs/harness/decision/") ||
        resolved.startsWith("libs/harness/ingest/"),
    )
    .with("session-no-infra-barrel", () => resolved === "libs/harness/infra/src/index.ts")
    .exhaustive()

const extractStringLiteralText = (expr: ts.Expression): string | undefined =>
  ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : undefined

const extractStaticRuntimeSpecifiers = (
  filePath: string,
  content: string,
  profile: FastpathClosureProfile,
): ReadonlyArray<string> => {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const specifiers: Array<string> = []
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause
      if (clause?.isTypeOnly === true) continue
      if (
        clause !== undefined &&
        clause.name === undefined &&
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((el) => el.isTypeOnly)
      ) {
        continue
      }
      specifiers.push(stmt.moduleSpecifier.text)
      continue
    }
    if (
      ts.isImportEqualsDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      ts.isExternalModuleReference(stmt.moduleReference)
    ) {
      const modText = extractStringLiteralText(stmt.moduleReference.expression)
      if (modText !== undefined) specifiers.push(modText)
      continue
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      if (stmt.isTypeOnly) continue
      if (
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause) &&
        stmt.exportClause.elements.length > 0 &&
        stmt.exportClause.elements.every((el) => el.isTypeOnly)
      ) {
        continue
      }
      specifiers.push(stmt.moduleSpecifier.text)
    }
  }

  const walkCalls = (node: ts.Node, insideFunctionLike: boolean): void => {
    const nextInsideFn =
      insideFunctionLike ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    if (ts.isCallExpression(node) && node.arguments.length > 0 && node.arguments[0] !== undefined) {
      const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
      if (isDynImport || isRequire) {
        const spec = extractStringLiteralText(node.arguments[0])
        if (spec === undefined) {
          match(profile)
            .with("session-no-infra-barrel", "hook-entry-lightweight", () => {
              specifiers.push("<non-literal-dynamic-import>")
            })
            .with("standard", "policy-zero-dep", () => {})
            .exhaustive()
        } else {
          const isAllowedLazyFallback =
            profile === "hook-entry-lightweight" &&
            filePath === "apps/harness-cli/src/commands/hook-fastpath-core.ts" &&
            spec === "./hook-fallback.js"
          const shouldPush = match(profile)
            .with(
              "standard",
              () => !insideFunctionLike || isForbiddenRuntimeSpecifier(spec, profile),
            )
            .with(
              "session-no-infra-barrel",
              () =>
                !insideFunctionLike ||
                isForbiddenRuntimeSpecifier(spec, profile) ||
                spec.startsWith(".") ||
                spec.startsWith("@harness/"),
            )
            .with("policy-zero-dep", "hook-entry-lightweight", () => {
              return !insideFunctionLike || !isAllowedLazyFallback
            })
            .exhaustive()
          if (shouldPush) {
            specifiers.push(spec)
          }
        }
      }
    }
    ts.forEachChild(node, (child) => walkCalls(child, nextInsideFn))
  }
  walkCalls(sourceFile, false)
  return specifiers
}

const resolveWorkspaceImportTarget = (
  repoRoot: string,
  fromRelPath: string,
  spec: string,
  workspaceMap: ReadonlyMap<string, string>,
  hostIo: SyncHostIo,
): string | undefined => {
  const mapped = workspaceMap.get(spec)
  if (mapped !== undefined) {
    return hostIo.existsSync(join(repoRoot, mapped)) ? mapped : undefined
  }
  if (!spec.startsWith(".")) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromRelPath), spec))
  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
    : base.endsWith(".jsx")
      ? [`${base.slice(0, -4)}.tsx`, `${base.slice(0, -4)}.ts`, base]
      : [base, `${base}.ts`, `${base}.tsx`, posix.join(base, "index.ts")]
  for (const candidate of candidates) {
    if (hostIo.existsSync(join(repoRoot, candidate))) return candidate
  }
  return undefined
}

/**
 * Verifies hook fast-path import closures across all three closure profiles:
 * - `"standard"`: forbids `"typescript"`, `"ts-morph"`, and non-cluster-resolver `"@harness/graph"` modules.
 * - `"policy-zero-dep"`: forbids `"effect"`, `"@effect/*"`, `"typescript"`, `"ts-morph"`, and any `"@harness/*"`
 *   module outside `libs/harness/gates/src/policy*`.
 * - `"hook-entry-lightweight"`: forbids `"effect"` root, heavy `"effect/*"` subpaths, `"@effect/platform-node"`,
 *   `"@effect/ai-typesafe"`, `"typescript"`, `"ts-morph"`, and heavy `"@harness/*"` modules (allowing only
 *   lightweight `effect/*` subpaths, `@harness/gates/policy`, and `@harness/infra/hook-io`).
 */
export const evaluateHookFastpathImportClosure = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const { workspaceMap, unresolvedWorkspaceExports } = buildWorkspaceSpecifierMap(
    repoRoot,
    hostIo,
    findings,
  )
  for (const [specifier, target] of [...unresolvedWorkspaceExports.entries()].sort(([a], [b]) =>
    compareCodeUnits(a, b),
  )) {
    findings.push({
      kind: "hook-fastpath-forbidden-import",
      nodeId: `unresolved-export:${specifier}`,
      location: specifier,
      message: `Workspace package export '${specifier}' declares missing target '${target}', breaking hook fast-path import-closure resolution.`,
      action: `Fix the 'exports' target '${target}' for '${specifier}' or restore the missing source file.`,
    })
  }
  const hasHarnessLibs = hostIo.existsSync(join(repoRoot, "libs", "harness"))
  const fileSpecCache = new Map<string, ReadonlyArray<string>>()
  const readSpecs = (
    relPath: string,
    profile: FastpathClosureProfile,
  ): ReadonlyArray<string> | undefined => {
    const cacheKey = `${profile}:${relPath}`
    if (fileSpecCache.has(cacheKey)) return fileSpecCache.get(cacheKey)
    const content = readTextOrReport(join(repoRoot, relPath), hostIo, repoRoot, findings)
    if (content === undefined) return undefined
    const specs = extractStaticRuntimeSpecifiers(relPath, content, profile)
    fileSpecCache.set(cacheKey, specs)
    return specs
  }

  for (const entryRel of HOOK_FASTPATH_ENTRYPOINTS) {
    const profile = getClosureProfile(entryRel)
    if (!hostIo.existsSync(join(repoRoot, entryRel))) {
      if (hasHarnessLibs) {
        findings.push({
          kind: "hook-fastpath-forbidden-import",
          nodeId: `${entryRel}:missing-entrypoint`,
          location: entryRel,
          message: `Hook fast-path entrypoint '${entryRel}' is missing in harness workspace; cannot verify runtime import closure.`,
          action: `Restore '${entryRel}' or update HOOK_FASTPATH_ENTRYPOINTS in libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts.`,
        })
      }
      continue
    }
    const visited = new Set<string>()
    const queue: Array<readonly [string, ReadonlyArray<string>]> = [[entryRel, [entryRel]]]
    const violationEdges = new Set<string>()
    while (queue.length > 0) {
      const nextItem = queue.shift()
      if (nextItem === undefined) break
      const [currentRel, chain] = nextItem
      if (visited.has(currentRel)) continue
      visited.add(currentRel)
      const specs = readSpecs(currentRel, profile)
      if (specs === undefined) continue
      for (const spec of specs) {
        if (isForbiddenRuntimeSpecifier(spec, profile)) {
          violationEdges.add(`${chain.join(" -> ")} -> ${spec}`)
          continue
        }
        const resolved = resolveWorkspaceImportTarget(
          repoRoot,
          currentRel,
          spec,
          workspaceMap,
          hostIo,
        )
        if (resolved === undefined) {
          if (spec.startsWith(".") || spec.startsWith("@harness/")) {
            violationEdges.add(`${chain.join(" -> ")} -> ${spec} (unresolved)`)
          }
          continue
        }
        if (isForbiddenResolvedTarget(resolved, profile)) {
          violationEdges.add(`${chain.join(" -> ")} -> ${resolved}`)
          continue
        }
        if (!visited.has(resolved)) {
          queue.push([resolved, [...chain, resolved]])
        }
      }
    }
    const profileRuleSummary = match(profile)
      .with("standard", () => "'typescript', 'ts-morph', and '@harness/graph'")
      .with(
        "policy-zero-dep",
        () => "'effect', 'effect/*', '@effect/*', 'typescript', 'ts-morph', and '@harness/*'",
      )
      .with(
        "hook-entry-lightweight",
        () =>
          "full 'effect' barrel, heavy 'effect/*' subpaths, '@effect/platform-node', '@effect/ai-typesafe', 'typescript', 'ts-morph', and heavy '@harness/*' packages",
      )
      .with("session-no-infra-barrel", () => "'@harness/infra' barrel")
      .exhaustive()
    for (const trace of [...violationEdges].sort(compareCodeUnits)) {
      findings.push({
        kind: "hook-fastpath-forbidden-import",
        nodeId: `${entryRel}:${trace}`,
        location: entryRel,
        message: `Hook fast-path entrypoint '${entryRel}' transitively imports forbidden runtime dependency (${trace}). Keep ${entryRel} free of ${profileRuleSummary}.`,
        action: `Replace direct/transitive runtime imports of ${profileRuleSummary} in ${entryRel} with a lightweight subpath export or 'import type'.`,
      })
    }
  }
}
