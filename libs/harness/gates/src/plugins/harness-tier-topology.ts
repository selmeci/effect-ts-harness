import { posix } from "node:path"
import { Effect } from "effect"
import { ts } from "@harness/graph"
import {
  type HarnessTierTopologyInput,
  type HarnessTierTopologyReport,
  type HarnessTierTopologyViolation,
  makeHarnessTierTopologyReport,
  NonNegativeCount,
  NxTierTag,
  type PackageTierManifestInput,
  type ServiceTierSourceInput,
  TierTopologyMessage,
  TierTopologyRuleId,
  WorkspaceFilePath,
} from "@harness/contract"
import { getOrCreateCachedSourceFile } from "../ast-cache.js"

const NODE_BUILTIN_ROOT_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sqlite",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
])

const resolvePackageRootName = (specifier: string): string => {
  const trimmed = specifier.trim()
  if (trimmed.startsWith("@")) {
    const parts = trimmed.split("/")
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : trimmed
  }
  return trimmed.split("/")[0] ?? trimmed
}

const buildManifestTagsByPackage = (
  manifests: ReadonlyArray<PackageTierManifestInput>,
): ReadonlyMap<string, ReadonlyArray<NxTierTag>> => {
  const map = new Map<string, ReadonlyArray<NxTierTag>>()
  for (const manifest of manifests) {
    map.set(manifest.packageName, manifest.nxTags)
  }
  return map
}

const FORBIDDEN_RELATIVE_SERVICE_SEGMENTS = new Set([
  "infra",
  "core",
  "domain",
  "gates",
  "graph",
  "decision",
  "ingest",
  "apps",
  "harness-cli",
  "harness-mcp",
])

const isImpureServiceSpecifier = (
  specifier: string,
  manifestTagsByPkg: ReadonlyMap<string, ReadonlyArray<NxTierTag>>,
): boolean => {
  const trimmed = specifier.trim()
  if (trimmed.startsWith("node:")) return true
  if (trimmed === "effect/Layer" || trimmed.startsWith("effect/Layer/")) return true
  if (trimmed.startsWith(".")) {
    const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..")
    return segments.some((seg) => FORBIDDEN_RELATIVE_SERVICE_SEGMENTS.has(seg))
  }
  const rootPkg = resolvePackageRootName(trimmed)
  if (NODE_BUILTIN_ROOT_MODULES.has(rootPkg)) return true
  const targetTags = manifestTagsByPkg.get(rootPkg)
  if (targetTags !== undefined) {
    return targetTags.some(
      (tag) => tag === "type:infra" || tag === "type:core" || tag === "type:domain" || tag === "type:app",
    )
  }
  if (
    rootPkg === "@harness/infra" ||
    rootPkg.endsWith("-infra") ||
    rootPkg === "@harness/gates" ||
    rootPkg === "@harness/graph" ||
    rootPkg === "@harness/decision" ||
    rootPkg === "@harness/ingest"
  ) {
    return true
  }
  return /(?:^|\/)infra(?:\/|$)/.test(trimmed)
}

const isAllowedServiceDependency = (
  dep: string,
  manifestTagsByPkg: ReadonlyMap<string, ReadonlyArray<NxTierTag>>,
): boolean => {
  if (dep === "effect") return true
  const rootPkg = resolvePackageRootName(dep)
  const targetTags = manifestTagsByPkg.get(rootPkg)
  if (targetTags !== undefined) {
    return targetTags.some((tag) => tag === "type:contract" || tag === "type:service")
  }
  return rootPkg === "@harness/contract" || rootPkg.endsWith("-contract")
}

const isDrizzleDependency = (dep: string): boolean => {
  const rootPkg = resolvePackageRootName(dep)
  return rootPkg === "drizzle-orm" || rootPkg === "drizzle-kit"
}

const isForbiddenCoreDependency = (
  dep: string,
  manifestTagsByPkg: ReadonlyMap<string, ReadonlyArray<NxTierTag>>,
): boolean => {
  const rootPkg = resolvePackageRootName(dep)
  const targetTags = manifestTagsByPkg.get(rootPkg)
  if (targetTags !== undefined) {
    return targetTags.some((tag) => tag === "type:infra" || tag === "type:app")
  }
  return (
    rootPkg === "@harness/infra" ||
    rootPkg.endsWith("-infra") ||
    rootPkg === "alchemy" ||
    rootPkg.startsWith("@alchemy.run/") ||
    rootPkg.startsWith("@effect/sql-") ||
    rootPkg === "@effect/platform-node" ||
    rootPkg === "@effect/platform-node-shared"
  )
}

const extractStringOrTemplateText = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}${node.templateSpans.map((s) => s.literal.text).join("")}`
  }
  return undefined
}

const collectServiceSourceImpurityViolations = (
  file: ServiceTierSourceInput,
  manifestTagsByPkg: ReadonlyMap<string, ReadonlyArray<NxTierTag>>,
): ReadonlyArray<HarnessTierTopologyViolation> => {
  const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)
  const location = WorkspaceFilePath.make(file.filePath)
  const found: Array<HarnessTierTopologyViolation> = []
  const layerIdentifiers = new Set<string>(["Layer"])
  const effectNamespaceNames = new Set<string>()

  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "effect" &&
      stmt.importClause?.isTypeOnly !== true &&
      stmt.importClause?.namedBindings !== undefined
    ) {
      const bindings = stmt.importClause.namedBindings
      if (ts.isNamespaceImport(bindings)) {
        effectNamespaceNames.add(bindings.name.text)
      }
      if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const importedName = (el.propertyName ?? el.name).text
          if (importedName === "Layer" && !el.isTypeOnly) {
            layerIdentifiers.add(el.name.text)
            found.push({
              rule: TierTopologyRuleId.make("impure-service-tier-import"),
              location,
              message: TierTopologyMessage.make(
                `Service-tier source "${file.filePath}" imports value "Layer" from "effect" — live Layer implementations belong in type:infra, not type:service.`,
              ),
            })
          }
        }
      }
    }
  }

  const checkSpecifier = (specifier: string | undefined): void => {
    if (specifier !== undefined && isImpureServiceSpecifier(specifier, manifestTagsByPkg)) {
      found.push({
        rule: TierTopologyRuleId.make("impure-service-tier-import"),
        location,
        message: TierTopologyMessage.make(
          `Service-tier source "${file.filePath}" imports impure module "${specifier}" — type:service modules must not import Node built-ins or type:infra/type:core/type:domain/type:app packages.`,
        ),
      })
    }
  }

  const visitNode = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && node.arguments[0] !== undefined) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequireCall =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
      if (isDynamicImport || isRequireCall) {
        checkSpecifier(extractStringOrTemplateText(node.arguments[0]))
      }
      return
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (layerIdentifiers.has(node.expression.text) ||
        (effectNamespaceNames.has(node.expression.text) && node.name.text === "Layer"))
    ) {
      found.push({
        rule: TierTopologyRuleId.make("impure-service-tier-import"),
        location,
        message: TierTopologyMessage.make(
          `Service-tier source "${file.filePath}" constructs or composes "${node.expression.text}.${node.name.text}" — live Layer implementations belong in type:infra, not type:service.`,
        ),
      })
    }
  }

  const walk = (node: ts.Node): void => {
    visitNode(node)
    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return found
}

const collectUndeclaredWorkspaceDependencyViolations = (
  manifest: PackageTierManifestInput,
  workspaceSourceFiles: ReadonlyArray<ServiceTierSourceInput>,
  workspacePackageNames: ReadonlySet<string>,
  manifestDirs: ReadonlyArray<{ readonly pkgDir: string; readonly packageName: string }>,
): ReadonlyArray<HarnessTierTopologyViolation> => {
  const pkgDir = manifest.manifestPath.replace(/\/package\.json$/, "")
  const srcPrefix = `${pkgDir}/src/`
  const declaredDeps = new Set<string>(manifest.dependencyNames)
  const reported = new Set<string>()
  const found: Array<HarnessTierTopologyViolation> = []

  const checkSpecifier = (filePath: WorkspaceFilePath, specifier: string | undefined): void => {
    if (specifier === undefined) return
    if (specifier.startsWith(".")) {
      const resolved = posix.normalize(posix.join(posix.dirname(filePath), specifier))
      if (resolved !== pkgDir && !resolved.startsWith(`${pkgDir}/`)) {
        const targetManifest = manifestDirs.find(
          (m) => resolved === m.pkgDir || resolved.startsWith(`${m.pkgDir}/`),
        )
        if (targetManifest !== undefined) {
          if (
            targetManifest.packageName !== manifest.packageName &&
            !declaredDeps.has(targetManifest.packageName) &&
            !reported.has(targetManifest.packageName)
          ) {
            reported.add(targetManifest.packageName)
            found.push({
              rule: TierTopologyRuleId.make("undeclared-workspace-dependency"),
              location: filePath,
              message: TierTopologyMessage.make(
                `Source "${filePath}" imports workspace package "${targetManifest.packageName}" via relative path "${specifier}", which is not declared in "${manifest.manifestPath}" dependencies.`,
              ),
            })
          }
          return
        }
        if (
          (resolved.startsWith("libs/") || resolved.startsWith("apps/")) &&
          !reported.has(resolved)
        ) {
          reported.add(resolved)
          found.push({
            rule: TierTopologyRuleId.make("undeclared-workspace-dependency"),
            location: filePath,
            message: TierTopologyMessage.make(
              `Source "${filePath}" imports cross-package relative path "${specifier}" (resolved "${resolved}") outside "${pkgDir}/", bypassing "${manifest.manifestPath}" dependencies.`,
            ),
          })
        }
      }
      return
    }
    const rootPkg = resolvePackageRootName(specifier)
    if (rootPkg === manifest.packageName) return
    if (!workspacePackageNames.has(rootPkg) && !rootPkg.startsWith("@harness/")) return
    if (declaredDeps.has(rootPkg) || reported.has(rootPkg)) return
    reported.add(rootPkg)
    found.push({
      rule: TierTopologyRuleId.make("undeclared-workspace-dependency"),
      location: filePath,
      message: TierTopologyMessage.make(
        `Source "${filePath}" imports workspace package "${rootPkg}" (via "${specifier}"), which is not declared in "${manifest.manifestPath}" dependencies.`,
      ),
    })
  }

  for (const file of workspaceSourceFiles) {
    if (!file.filePath.startsWith(srcPrefix) || !/\.(?:ts|tsx|mts|cts)$/.test(file.filePath)) {
      continue
    }
    const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)
    const location = WorkspaceFilePath.make(file.filePath)
    const walk = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          checkSpecifier(location, node.moduleSpecifier.text)
        }
        return
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        checkSpecifier(location, node.moduleReference.expression.text)
        return
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0 && node.arguments[0] !== undefined) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequireCall =
          (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
        if (isDynamicImport || isRequireCall) {
          checkSpecifier(location, extractStringOrTemplateText(node.arguments[0]))
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sourceFile)
  }

  return found
}

export const decideHarnessTierTopology = Effect.fn("HarnessTierTopology.decide")(
  (input: HarnessTierTopologyInput): Effect.Effect<HarnessTierTopologyReport> =>
    Effect.sync(() => {
      const violations: Array<HarnessTierTopologyViolation> = []
      const contractTag = NxTierTag.make("type:contract")
      const serviceTag = NxTierTag.make("type:service")
      const coreTag = NxTierTag.make("type:core")
      const domainTag = NxTierTag.make("type:domain")
      const manifestTagsByPkg = buildManifestTagsByPackage(input.manifests)
      const workspacePackageNames = new Set(input.manifests.map((m) => m.packageName))
      const manifestDirs = input.manifests.map((m) => ({
        pkgDir: m.manifestPath.replace(/\/package\.json$/, ""),
        packageName: m.packageName,
      }))

      for (const manifest of input.manifests) {
        const location = WorkspaceFilePath.make(manifest.manifestPath)
        const tierTags = manifest.nxTags.filter((tag) => tag.startsWith("type:"))

        if (tierTags.length !== 1) {
          violations.push({
            rule: TierTopologyRuleId.make("dual-contract-tier-tag"),
            location,
            message: TierTopologyMessage.make(
              tierTags.length === 0
                ? `Package "${manifest.packageName}" declares zero Nx tier tags (type:*) in "${manifest.manifestPath}" — every workspace package must declare exactly one canonical type:* tag.`
                : `Package "${manifest.packageName}" declares multiple Nx tier tags (${tierTags.join(", ")}) in "${manifest.manifestPath}".`,
            ),
          })
        }

        const isContract = manifest.nxTags.includes(contractTag)
        const isService = !isContract && manifest.nxTags.includes(serviceTag)
        const isCoreOrDomain =
          !isContract &&
          !isService &&
          (manifest.nxTags.includes(coreTag) || manifest.nxTags.includes(domainTag))

        if (isContract) {
          for (const dep of manifest.dependencyNames) {
            if (dep !== "effect") {
              violations.push({
                rule: TierTopologyRuleId.make("forbidden-contract-dependency"),
                location,
                message: TierTopologyMessage.make(
                  `Contract package "${manifest.packageName}" declares forbidden dependency "${dep}" — type:contract packages may depend only on "effect".`,
                ),
              })
            }
          }
        }
        if (isService) {
          for (const dep of manifest.dependencyNames) {
            if (!isAllowedServiceDependency(dep, manifestTagsByPkg)) {
              violations.push({
                rule: TierTopologyRuleId.make("forbidden-service-dependency"),
                location,
                message: TierTopologyMessage.make(
                  `Service package "${manifest.packageName}" declares forbidden dependency "${dep}" — type:service packages may depend only on "effect", type:contract, and type:service packages.`,
                ),
              })
            }
          }
        }
        const allDependencyNames = [
          ...manifest.dependencyNames,
          ...(manifest.nonRuntimeDependencyNames ?? []),
        ]
        for (const dep of allDependencyNames) {
          if (isDrizzleDependency(dep)) {
            violations.push({
              rule: TierTopologyRuleId.make("forbidden-core-dependency"),
              location,
              message: TierTopologyMessage.make(
                `Package "${manifest.packageName}" declares banned Drizzle dependency "${dep}" in "${manifest.manifestPath}" — use native Effect v4 SQL (@effect/sql-d1, @effect/sql-sqlite-do, SqlClient, SqliteMigrator).`,
              ),
            })
          }
        }

        if (isCoreOrDomain) {
          for (const dep of manifest.dependencyNames) {
            if (isForbiddenCoreDependency(dep, manifestTagsByPkg)) {
              violations.push({
                rule: TierTopologyRuleId.make("forbidden-core-dependency"),
                location,
                message: TierTopologyMessage.make(
                  `Core/domain package "${manifest.packageName}" declares forbidden dependency "${dep}" — type:core and type:domain packages must not depend on type:infra or type:app packages.`,
                ),
              })
            }
          }
        }
      }

      for (const file of input.serviceFiles) {
        violations.push(...collectServiceSourceImpurityViolations(file, manifestTagsByPkg))
      }

      const workspaceSourceFiles = input.workspaceSourceFiles ?? []
      if (workspaceSourceFiles.length > 0) {
        for (const manifest of input.manifests) {
          violations.push(
            ...collectUndeclaredWorkspaceDependencyViolations(
              manifest,
              workspaceSourceFiles,
              workspacePackageNames,
              manifestDirs,
            ),
          )
        }
      }

      return makeHarnessTierTopologyReport(violations, NonNegativeCount.make(input.manifests.length))
    }),
)
