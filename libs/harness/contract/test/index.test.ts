import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ActiveMutantId,
  AstSourceContent,
  AstSourceFilePath,
  GateVerdict,
  HarnessTierTopologyInput,
  HarnessTierTopologyReport,
  NonNegativeCount,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  PluginId,
  SelfDogfoodingReport,
  SubprocessCommand,
  WorkspaceFilePath,
} from "../src/index.js"

describe("@harness/contract schemas", () => {
  it("decodes branded AST, self-dogfooding, and workspace primitives", () => {
    expect(Schema.decodeSync(PluginId)("plugin-1")).toBe("plugin-1")
    expect(Schema.decodeSync(NonNegativeCount)(0)).toBe(0)
    expect(Schema.decodeSync(WorkspaceFilePath)("libs/harness/contract/src/index.ts")).toBe(
      "libs/harness/contract/src/index.ts",
    )
    expect(Schema.decodeSync(SubprocessCommand)("pnpm")).toBe("pnpm")
    expect(Schema.decodeSync(ActiveMutantId)("mutant-1")).toBe("mutant-1")
    const report = Schema.decodeSync(SelfDogfoodingReport)({
      verdict: GateVerdict.make("clean"),
      violations: [],
      inspectedFileCount: NonNegativeCount.make(1),
    })
    expect(report.verdict).toBe("clean")
    expect(report.inspectedFileCount).toBe(1)
  })

  it("decodes tier topology input and report schemas", () => {
    const input = Schema.decodeSync(HarnessTierTopologyInput)({
      manifests: [
        {
          manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
          packageName: PackageManifestName.make("@harness/contract"),
          nxTags: [NxTierTag.make("type:contract")],
          dependencyNames: [PackageDependencyName.make("effect")],
        },
      ],
      serviceFiles: [
        {
          filePath: AstSourceFilePath.make("libs/harness/service/src/index.ts"),
          content: AstSourceContent.make("export const x = 1"),
        },
      ],
    })
    expect(input.manifests).toHaveLength(1)
    expect(input.serviceFiles).toHaveLength(1)

    const report = Schema.decodeSync(HarnessTierTopologyReport)({
      verdict: GateVerdict.make("clean"),
      violations: [],
      inspectedPackageCount: NonNegativeCount.make(1),
    })
    expect(report.verdict).toBe("clean")
  })
})
