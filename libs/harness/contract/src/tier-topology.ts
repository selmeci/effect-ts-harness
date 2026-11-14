import { Schema } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  GateVerdict,
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

export const NxTierTag = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("NxTierTag"),
)
export type NxTierTag = typeof NxTierTag.Type

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
  "impure-service-tier-import",
])
export type TierTopologyRuleId = typeof TierTopologyRuleId.Type

export const TierTopologyMessage = Schema.NonEmptyString.pipe(Schema.brand("TierTopologyMessage"))
export type TierTopologyMessage = typeof TierTopologyMessage.Type

export const PackageTierManifestInput = Schema.Struct({
  manifestPath: PackageManifestPath,
  packageName: PackageManifestName,
  nxTags: Schema.Array(NxTierTag),
  dependencyNames: Schema.Array(PackageDependencyName),
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
})
export type HarnessTierTopologyInput = typeof HarnessTierTopologyInput.Type

export const HarnessTierTopologyViolation = Schema.Struct({
  rule: TierTopologyRuleId,
  location: WorkspaceFilePath,
  message: TierTopologyMessage,
})
export type HarnessTierTopologyViolation = typeof HarnessTierTopologyViolation.Type

export const HarnessTierTopologyReport = Schema.Struct({
  verdict: GateVerdict,
  violations: Schema.Array(HarnessTierTopologyViolation),
  inspectedPackageCount: NonNegativeCount,
}).pipe(
  Schema.check(
    Schema.makeFilter((report) =>
      (report.verdict === "clean") === (report.violations.length === 0)
        ? undefined
        : "HarnessTierTopologyReport verdict and violations length must agree",
    ),
  ),
)
export type HarnessTierTopologyReport = typeof HarnessTierTopologyReport.Type

export const makeHarnessTierTopologyReport = (
  violations: ReadonlyArray<HarnessTierTopologyViolation>,
  inspectedPackageCount: NonNegativeCount,
): HarnessTierTopologyReport => ({
  verdict: violations.length === 0 ? "clean" : "violated",
  violations: [...violations],
  inspectedPackageCount,
})
