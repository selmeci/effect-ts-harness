import { Effect } from "effect"
import { ts } from "@harness/graph"
import {
  GateVerdict,
  type HarnessTierTopologyInput,
  type HarnessTierTopologyReport,
  type HarnessTierTopologyViolation,
  NonNegativeCount,
  NxTierTag,
  PackageManifestPath,
  type PackageTierManifestInput,
  type ServiceTierSourceInput,
  TierTopologyMessage,
  TierTopologyRuleId,
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

const isImpureServiceSpecifier = (specifier: string): boolean => {
  const trimmed = specifier.trim()
  if (trimmed.startsWith("node:")) return true
  const rootModule = trimmed.split("/")[0] ?? ""
  if (NODE_BUILTIN_ROOT_MODULES.has(rootModule)) return true
  if (trimmed === "@harness/infra" || trimmed.endsWith("-infra")) return true
  if (
    trimmed === "@harness/gates" ||
    trimmed === "@harness/graph" ||
    trimmed === "@harness/decision" ||
    trimmed === "@harness/ingest"
  ) {
    return true
  }
  return /(^|\/)infra(\/|$)/.test(trimmed)
}

const isAllowedServiceDependency = (dep: string): boolean =>
  dep === "effect" || dep === "@harness/contract" || dep.endsWith("-contract")

const isDedicatedServiceTierManifest = (manifest: PackageTierManifestInput, serviceTag: NxTierTag): boolean =>
  manifest.nxTags.includes(serviceTag) &&
  (/(^|\/)service\/package\.json$/.test(manifest.manifestPath) ||
    manifest.packageName === "@harness/service" ||
    manifest.packageName.endsWith("-service"))

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
): ReadonlyArray<HarnessTierTopologyViolation> => {
  const { sourceFile } = getOrCreateCachedSourceFile(file.filePath, file.content)
  const location = PackageManifestPath.make(file.filePath)
  const found: Array<HarnessTierTopologyViolation> = []

  const checkSpecifier = (specifier: string | undefined): void => {
    if (specifier !== undefined && isImpureServiceSpecifier(specifier)) {
      found.push({
        rule: TierTopologyRuleId.make("impure-service-tier-import"),
        location,
        message: TierTopologyMessage.make(
          `Service-tier source "${file.filePath}" imports impure module "${specifier}" — type:service modules must not import Node built-ins or type:infra packages.`,
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
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if (isDynamicImport || isRequireCall) {
        checkSpecifier(extractStringOrTemplateText(node.arguments[0]))
      }
      return
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Layer"
    ) {
      found.push({
        rule: TierTopologyRuleId.make("impure-service-tier-import"),
        location,
        message: TierTopologyMessage.make(
          `Service-tier source "${file.filePath}" constructs or composes "Layer.${node.name.text}" — live Layer implementations belong in type:infra, not type:service.`,
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

export const decideHarnessTierTopology = Effect.fn("HarnessTierTopology.decide")(
  (input: HarnessTierTopologyInput): Effect.Effect<HarnessTierTopologyReport> =>
    Effect.sync(() => {
      const violations: Array<HarnessTierTopologyViolation> = []
      const contractTag = NxTierTag.make("type:contract")
      const serviceTag = NxTierTag.make("type:service")

      for (const manifest of input.manifests) {
        const hasContractTag = manifest.nxTags.includes(contractTag)
        const otherTierTags = manifest.nxTags.filter(
          (tag) => tag.startsWith("type:") && tag !== contractTag,
        )

        if (hasContractTag && otherTierTags.length > 0) {
          violations.push({
            rule: TierTopologyRuleId.make("dual-contract-tier-tag"),
            location: manifest.manifestPath,
            message: TierTopologyMessage.make(
              `Package "${manifest.packageName}" declares dual Nx tier tags ("type:contract" alongside ${otherTierTags.join(", ")}) in "${manifest.manifestPath}".`,
            ),
          })
        }

        if (hasContractTag) {
          for (const dep of manifest.dependencyNames) {
            if (dep !== "effect") {
              violations.push({
                rule: TierTopologyRuleId.make("forbidden-contract-dependency"),
                location: manifest.manifestPath,
                message: TierTopologyMessage.make(
                  `Contract package "${manifest.packageName}" declares forbidden dependency "${dep}" — type:contract packages may depend only on "effect".`,
                ),
              })
            }
          }
        }

        if (isDedicatedServiceTierManifest(manifest, serviceTag)) {
          for (const dep of manifest.dependencyNames) {
            if (!isAllowedServiceDependency(dep)) {
              violations.push({
                rule: TierTopologyRuleId.make("forbidden-service-dependency"),
                location: manifest.manifestPath,
                message: TierTopologyMessage.make(
                  `Service package "${manifest.packageName}" declares forbidden dependency "${dep}" — dedicated type:service packages may depend only on "effect" and type:contract packages.`,
                ),
              })
            }
          }
        }
      }

      for (const file of input.serviceFiles) {
        violations.push(...collectServiceSourceImpurityViolations(file))
      }

      return {
        verdict: GateVerdict.make(violations.length === 0 ? "clean" : "violated"),
        violations,
        inspectedPackageCount: NonNegativeCount.make(input.manifests.length),
      }
    }),
)
