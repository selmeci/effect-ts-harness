import { Option, Schema } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  makeVerdictReport,
  makeVerdictReportSchema,
  NonNegativeCount,
  WorkspaceFilePath,
} from "./ast-and-gate-primitives.js"

export const PackageManifestPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PackageManifestPath"),
)
export type PackageManifestPath = typeof PackageManifestPath.Type

export const PackageManifestName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PackageManifestName"),
)
export type PackageManifestName = typeof PackageManifestName.Type

export const NxTierTag = Schema.Literals([
  "type:contract",
  "type:service",
  "type:core",
  "type:domain",
  "type:infra",
  "type:app",
]).pipe(Schema.brand("NxTierTag"))
export type NxTierTag = typeof NxTierTag.Type

export const NxScopeTag = Schema.Literals(["scope:web", "scope:fixture"]).pipe(
  Schema.brand("NxScopeTag"),
)
export type NxScopeTag = typeof NxScopeTag.Type

const decodeNxTierTag = Schema.decodeUnknownOption(NxTierTag)
const decodeNxScopeTag = Schema.decodeUnknownOption(NxScopeTag)

export const parseManifestTags = (
  rawTags: ReadonlyArray<string>,
): {
  readonly nxTags: ReadonlyArray<NxTierTag>
  readonly scopeTags: ReadonlyArray<NxScopeTag>
  readonly unknownTags: ReadonlyArray<string>
} => {
  const nxTags: Array<NxTierTag> = []
  const scopeTags: Array<NxScopeTag> = []
  const unknownTags: Array<string> = []
  for (const raw of rawTags) {
    Option.match(decodeNxTierTag(raw), {
      onSome: (tierTag) => {
        nxTags.push(tierTag)
      },
      onNone: () => {
        Option.match(decodeNxScopeTag(raw), {
          onSome: (scopeTag) => {
            scopeTags.push(scopeTag)
          },
          onNone: () => {
            unknownTags.push(raw)
          },
        })
      },
    })
  }
  return { nxTags, scopeTags, unknownTags }
}

export const PackageDependencyName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PackageDependencyName"),
)
export type PackageDependencyName = typeof PackageDependencyName.Type

export const TierTopologyRuleId = Schema.Literals([
  "dual-contract-tier-tag",
  "forbidden-contract-dependency",
  "forbidden-service-dependency",
  "forbidden-core-dependency",
  "impure-core-tier-import",
  "impure-service-tier-import",
  "undeclared-workspace-dependency",
  "banned-workspace-dependency",
  "forbidden-domain-dependency",
  "forbidden-infra-dependency",
  "forbidden-web-app-dependency",
])
export type TierTopologyRuleId = typeof TierTopologyRuleId.Type

export const TierTopologyMessage = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(8192)),
  Schema.brand("TierTopologyMessage"),
)
export type TierTopologyMessage = typeof TierTopologyMessage.Type

export const PackageTierManifestInput = Schema.Struct({
  manifestPath: PackageManifestPath,
  packageName: PackageManifestName,
  nxTags: Schema.Array(NxTierTag),
  scopeTags: Schema.Array(NxScopeTag),
  dependencyNames: Schema.Array(PackageDependencyName),
  nonRuntimeDependencyNames: Schema.Array(PackageDependencyName),
})
export type PackageTierManifestInput = typeof PackageTierManifestInput.Type

export const ServiceTierSourceInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
})
export type ServiceTierSourceInput = typeof ServiceTierSourceInput.Type

export const HarnessTierTopologyInput = Schema.Struct({
  manifests: Schema.Array(PackageTierManifestInput),
  serviceFiles: Schema.Array(ServiceTierSourceInput),
  workspaceSourceFiles: Schema.Array(ServiceTierSourceInput),
})
export type HarnessTierTopologyInput = typeof HarnessTierTopologyInput.Type

export const HarnessTierTopologyViolation = Schema.Struct({
  rule: TierTopologyRuleId,
  location: WorkspaceFilePath,
  message: TierTopologyMessage,
})
export type HarnessTierTopologyViolation = typeof HarnessTierTopologyViolation.Type

export const HarnessTierTopologyReport = makeVerdictReportSchema(HarnessTierTopologyViolation, {
  inspectedPackageCount: NonNegativeCount,
})
export type HarnessTierTopologyReport = typeof HarnessTierTopologyReport.Type

export const makeHarnessTierTopologyReport = (
  violations: ReadonlyArray<HarnessTierTopologyViolation>,
  inspectedPackageCount: NonNegativeCount,
): HarnessTierTopologyReport => makeVerdictReport(violations, { inspectedPackageCount })
