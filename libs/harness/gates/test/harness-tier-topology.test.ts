import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  HarnessSubprocessError,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  type PackageTierManifestInput,
  SelfDogfoodingViolationError,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessOutput,
  WorkspaceFilePath,
  WorkspaceFsError,
} from "@harness/contract"
import { Layer } from "effect"
import {
  evaluateAllGatePlugins,
  GatePluginRegistryLive,
} from "../src/plugins/gate-plugin-registry.js"
import { decideHarnessTierTopology } from "../src/plugins/harness-tier-topology.js"
import { execCheckedSubprocess } from "../src/services/subprocess-runner.js"
import { statAndReadWorkspaceFiles } from "../src/services/workspace-fs.js"
import {
  makeHarnessSubprocessRunnerTestLayer,
  makeWorkspaceFsMemoryLayer,
} from "./helpers/test-layers.js"

const CleanTierTopologySpec = Schema.Struct({
  scope: Schema.Literals(["harness", "sample", "billing"]),
  includeService: Schema.Boolean,
  extraServiceFiles: Schema.Array(Schema.Literals(["fs-port", "runner-port", "clock-port"])),
})

describe("HarnessTierTopology & WorkspaceFs (SPEC-0012)", () => {
  it.effect.prop(
    "REQ-1.1: valid canonical tier manifests and pure service files always return clean with R = never",
    {
      spec: CleanTierTopologySpec,
    },
    ({ spec }) =>
      Effect.gen(function* () {
        const contractName =
          spec.scope === "harness" ? "@harness/contract" : `@harness/${spec.scope}-contract`
        const manifests: Array<PackageTierManifestInput> = [
          {
            manifestPath: PackageManifestPath.make(`libs/${spec.scope}/contract/package.json`),
            packageName: PackageManifestName.make(contractName),
            nxTags: [NxTierTag.make("type:contract")],
            dependencyNames: [PackageDependencyName.make("effect")],
          },
        ]

        if (spec.includeService) {
          manifests.push({
            manifestPath: PackageManifestPath.make(`libs/${spec.scope}/service/package.json`),
            packageName: PackageManifestName.make(
              spec.scope === "harness" ? "@harness/service" : `@harness/${spec.scope}-service`,
            ),
            nxTags: [NxTierTag.make("type:service")],
            dependencyNames: [
              PackageDependencyName.make("effect"),
              PackageDependencyName.make(contractName),
            ],
          })
        }

        const serviceFiles = spec.extraServiceFiles.map((portName, index) => ({
          filePath: AstSourceFilePath.make(`libs/${spec.scope}/service/src/${portName}-${index}.ts`),
          content: AstSourceContent.make(
            [
              'import { Context, Effect } from "effect"',
              `import type { WorkspaceFilePath } from "${contractName}"`,
              `// Commented out import "node:fs" and Layer.succeed should be ignored`,
              `export class Port${index} extends Context.Service<Port${index}, { readonly ping: Effect.Effect<WorkspaceFilePath> }>()("@${spec.scope}/Port${index}") {}`,
            ].join("\n"),
          ),
        }))

        const report = yield* decideHarnessTierTopology({
          manifests,
          serviceFiles,
        })

        expect(report.verdict).toBe("clean")
        expect(report.violations).toHaveLength(0)
        expect(report.inspectedPackageCount).toBe(manifests.length)
      }),
  )

  it.effect("REQ-1.2: reports dual-contract-tier-tag when type:contract is combined with another type:* tag", () =>
    Effect.gen(function* () {
      const report = yield* decideHarnessTierTopology({
        manifests: [
          {
            manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
            packageName: PackageManifestName.make("@harness/contract"),
            nxTags: [NxTierTag.make("type:contract"), NxTierTag.make("type:service")],
            dependencyNames: [PackageDependencyName.make("effect")],
          },
        ],
        serviceFiles: [],
      })

      expect(report.verdict).toBe("violated")
      expect(report.violations).toHaveLength(1)
      expect(report.violations[0]?.rule).toBe("dual-contract-tier-tag")
      expect(report.violations[0]?.location).toBe("libs/harness/contract/package.json")
    }),
  )

  it.effect("REQ-1.3: reports forbidden-contract-dependency when type:contract depends on anything outside effect", () =>
    Effect.gen(function* () {
      const report = yield* decideHarnessTierTopology({
        manifests: [
          {
            manifestPath: PackageManifestPath.make("libs/harness/contract/package.json"),
            packageName: PackageManifestName.make("@harness/contract"),
            nxTags: [NxTierTag.make("type:contract")],
            dependencyNames: [
              PackageDependencyName.make("effect"),
              PackageDependencyName.make("@harness/service"),
            ],
          },
        ],
        serviceFiles: [],
      })

      expect(report.verdict).toBe("violated")
      expect(report.violations).toHaveLength(1)
      expect(report.violations[0]?.rule).toBe("forbidden-contract-dependency")
      expect(report.violations[0]?.message).toContain("@harness/service")
    }),
  )

  it.effect("REQ-1.4: reports forbidden-service-dependency when type:service depends on anything outside effect and type:contract", () =>
    Effect.gen(function* () {
      const report = yield* decideHarnessTierTopology({
        manifests: [
          {
            manifestPath: PackageManifestPath.make("libs/sample/service/package.json"),
            packageName: PackageManifestName.make("@harness/sample-service"),
            nxTags: [NxTierTag.make("type:service")],
            dependencyNames: [
              PackageDependencyName.make("effect"),
              PackageDependencyName.make("@harness/sample-contract"),
              PackageDependencyName.make("@harness/infra"),
            ],
          },
        ],
        serviceFiles: [],
      })

      expect(report.verdict).toBe("violated")
      expect(report.violations).toHaveLength(1)
      expect(report.violations[0]?.rule).toBe("forbidden-service-dependency")
      expect(report.violations[0]?.message).toContain("@harness/infra")
    }),
  )

  it.effect("REQ-1.5: reports impure-service-tier-import for Node built-ins, infra imports, and Layer constructions in type:service", () =>
    Effect.gen(function* () {
      const report = yield* decideHarnessTierTopology({
        manifests: [],
        serviceFiles: [
          {
            filePath: AstSourceFilePath.make("libs/harness/service/src/bad-node.ts"),
            content: AstSourceContent.make('import { readFileSync } from "node:fs"\nexport const x = readFileSync\n'),
          },
          {
            filePath: AstSourceFilePath.make("libs/harness/service/src/bad-infra.ts"),
            content: AstSourceContent.make('import { live } from "@harness/infra"\nexport const y = live\n'),
          },
          {
            filePath: AstSourceFilePath.make("libs/harness/service/src/bad-layer.ts"),
            content: AstSourceContent.make(
              'import { Layer } from "effect"\nconst docUrl = "https://effect.website/*ok*/"\nexport const z = Layer.effectDiscard(Layer.succeed("Svc", {}))\n',
            ),
          },
          {
            filePath: AstSourceFilePath.make("libs/harness/service/src/bad-subpath-and-template.ts"),
            content: AstSourceContent.make(
              'import { readFile } from "fs/promises"\nexport const load = () => import(`../infra/live.js`)\nexport const r = readFile\n',
            ),
          },
          {
            filePath: AstSourceFilePath.make("libs/harness/service/src/clean-string-literal.ts"),
            content: AstSourceContent.make(
              'export const DOC_EXAMPLE = \'import { readFileSync } from "node:fs"; Layer.succeed()\' as const\n',
            ),
          },
        ],
      })

      expect(report.verdict).toBe("violated")
      expect(report.violations).toHaveLength(7)
      expect(report.violations.every((v) => v.rule === "impure-service-tier-import")).toBe(true)
      expect(
        report.violations.some((v) => v.location === "libs/harness/service/src/clean-string-literal.ts"),
      ).toBe(false)
    }),
  )

  it.effect("REQ-2.1: statAndReadWorkspaceFiles preserves input order and computes line counts", () =>
    Effect.gen(function* () {
      const files = {
        "libs/a.ts": "line1\nline2",
        "libs/b.ts": "only-one-line",
        "libs/c.ts": "a\nb\nc",
      }
      const paths = [
        WorkspaceFilePath.make("libs/c.ts"),
        WorkspaceFilePath.make("libs/a.ts"),
        WorkspaceFilePath.make("libs/b.ts"),
      ]

      const stats = yield* statAndReadWorkspaceFiles(paths).pipe(
        Effect.provide(makeWorkspaceFsMemoryLayer(files)),
      )

      expect(stats.map((s) => s.filePath)).toEqual(["libs/c.ts", "libs/a.ts", "libs/b.ts"])
      expect(stats[0]?.lineCount).toBe(3)
      expect(stats[1]?.lineCount).toBe(2)
      expect(stats[2]?.lineCount).toBe(1)
    }),
  )

  it.effect("REQ-2.2: statAndReadWorkspaceFiles fails with typed WorkspaceFsError when any file is unreadable", () =>
    Effect.gen(function* () {
      const exit = yield* statAndReadWorkspaceFiles([
        WorkspaceFilePath.make("libs/exists.ts"),
        WorkspaceFilePath.make("libs/missing.ts"),
      ]).pipe(
        Effect.provide(makeWorkspaceFsMemoryLayer({ "libs/exists.ts": "export const ok = true\n" })),
        Effect.exit,
      )

      const failureCause = match(exit)
        .with({ _tag: "Failure" }, (f) => f.cause)
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected statAndReadWorkspaceFiles to fail on missing file")
        })
        .exhaustive()

      const errOpt = Cause.findErrorOption(failureCause)
      const fsError = match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => {
          throw new Error("Expected typed WorkspaceFsError in failure cause")
        })
        .exhaustive()

      expect(fsError).toBeInstanceOf(WorkspaceFsError)
      expect(fsError.filePath).toBe("libs/missing.ts")
      expect(fsError.operation).toBe("read")
    }),
  )

  it.effect("REQ-2.3: execCheckedSubprocess fails with typed HarnessSubprocessError from @harness/contract on non-zero exit", () =>
    Effect.gen(function* () {
      const exit = yield* execCheckedSubprocess({
        command: SubprocessCommand.make("pnpm"),
        args: [],
      }).pipe(
        Effect.provide(
          makeHarnessSubprocessRunnerTestLayer((input) =>
            Effect.succeed({
              command: input.command,
              exitCode: SubprocessExitCode.make(2),
              stdout: SubprocessOutput.make(""),
              stderr: SubprocessOutput.make("build failed"),
            }),
          ),
        ),
        Effect.exit,
      )

      const failureCause = match(exit)
        .with({ _tag: "Failure" }, (f) => f.cause)
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected execCheckedSubprocess to fail on exit code 2")
        })
        .exhaustive()

      const errOpt = Cause.findErrorOption(failureCause)
      const subErr = match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => {
          throw new Error("Expected typed HarnessSubprocessError")
        })
        .exhaustive()

      expect(subErr).toBeInstanceOf(HarnessSubprocessError)
      expect(subErr.exitCode).toBe(2)
      expect(subErr.stderr).toBe("build failed")
    }),
  )

  it.effect("REQ-2.4: evaluateAllGatePlugins fails with typed SelfDogfoodingViolationError from @harness/contract when failOnViolation is true", () =>
    Effect.gen(function* () {
      const exit = yield* evaluateAllGatePlugins({
        filePaths: [WorkspaceFilePath.make("libs/harness/gates/src/bad.ts")],
        failOnViolation: true,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            GatePluginRegistryLive,
            makeWorkspaceFsMemoryLayer({
              "libs/harness/gates/src/bad.ts":
                "export const run = (x: number) => { switch (x) { case 1: return 1; default: return 0 } }\n",
            }),
          ),
        ),
        Effect.exit,
      )

      const failureCause = match(exit)
        .with({ _tag: "Failure" }, (f) => f.cause)
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected evaluateAllGatePlugins to fail on switch statement")
        })
        .exhaustive()

      const errOpt = Cause.findErrorOption(failureCause)
      const violationErr = match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => {
          throw new Error("Expected typed SelfDogfoodingViolationError")
        })
        .exhaustive()

      const narrowedErr = match(violationErr)
        .with({ _tag: "SelfDogfoodingViolationError" }, (e) => e)
        .with({ _tag: "WorkspaceFsError" }, (e) => {
          throw new Error(`Unexpected WorkspaceFsError: ${e.reason}`)
        })
        .exhaustive()

      expect(narrowedErr).toBeInstanceOf(SelfDogfoodingViolationError)
      expect(narrowedErr.violations[0]?.rule).toBe("harness-switch-statement")
    }),
  )

  it.effect(
    "F-8.3b & S-3.2: enforces tag-based topology across arbitrary package names, dual tags, type:core, and relative escapes",
    () =>
      Effect.gen(function* () {
        const report = yield* decideHarnessTierTopology({
          manifests: [
            {
              manifestPath: PackageManifestPath.make("libs/acme/ports/package.json"),
              packageName: PackageManifestName.make("@acme/custom-ports"),
              nxTags: [NxTierTag.make("type:service")],
              dependencyNames: [
                PackageDependencyName.make("effect"),
                PackageDependencyName.make("@acme/shared-types"),
                PackageDependencyName.make("@acme/custom-domain"),
              ],
            },
            {
              manifestPath: PackageManifestPath.make("libs/acme/types/package.json"),
              packageName: PackageManifestName.make("@acme/shared-types"),
              nxTags: [NxTierTag.make("type:contract")],
              dependencyNames: [PackageDependencyName.make("effect")],
            },
            {
              manifestPath: PackageManifestPath.make("libs/acme/domain/package.json"),
              packageName: PackageManifestName.make("@acme/custom-domain"),
              nxTags: [NxTierTag.make("type:core")],
              dependencyNames: [PackageDependencyName.make("@acme/custom-adapters")],
            },
            {
              manifestPath: PackageManifestPath.make("libs/acme/adapters/package.json"),
              packageName: PackageManifestName.make("@acme/custom-adapters"),
              nxTags: [NxTierTag.make("type:infra")],
              dependencyNames: [],
            },
            {
              manifestPath: PackageManifestPath.make("libs/acme/dual/package.json"),
              packageName: PackageManifestName.make("@acme/dual-tier"),
              nxTags: [NxTierTag.make("type:service"), NxTierTag.make("type:core")],
              dependencyNames: [],
            },
          ],
          serviceFiles: [
            {
              filePath: AstSourceFilePath.make("libs/acme/ports/src/index.ts"),
              content: AstSourceContent.make(
                'import { x } from "@acme/shared-types"\nimport { y } from "@acme/custom-adapters"\nimport { z } from "../infra/db.js"\nexport { x, y, z }\n',
              ),
            },
          ],
        })

        expect(report.verdict).toBe("violated")
        const rules = report.violations.map((v) => v.rule)
        expect(rules).toContain("forbidden-service-dependency")
        expect(rules).toContain("forbidden-core-dependency")
        expect(rules).toContain("dual-contract-tier-tag")
        expect(rules).toContain("impure-service-tier-import")
        // @acme/shared-types (type:contract without -contract suffix) is allowed!
        expect(report.violations.some((v) => v.message.includes("@acme/shared-types"))).toBe(false)
        // @acme/custom-adapters (type:infra without -infra suffix) is caught in both manifest and source!
        expect(report.violations.some((v) => v.message.includes("@acme/custom-adapters"))).toBe(true)
      }),
  )

  it.effect(
    "F-18.1: real libs/harness/* manifests and @harness/service source files pass HarnessTierTopology.decide cleanly",
    () =>
      Effect.gen(function* () {
        const harnessDir = resolvePath(process.cwd(), "..")
        const manifests: Array<{
          readonly manifestPath: PackageManifestPath
          readonly packageName: PackageManifestName
          readonly nxTags: Array<NxTierTag>
          readonly dependencyNames: Array<PackageDependencyName>
        }> = []
        for (const pkgDir of readdirSync(harnessDir).sort()) {
          const pkgJsonPath = join(harnessDir, pkgDir, "package.json")
          if (!existsSync(pkgJsonPath)) continue
          const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
            readonly name?: string
            readonly dependencies?: Readonly<Record<string, string>>
            readonly nx?: { readonly tags?: ReadonlyArray<string> }
          }
          if (!parsed.name) continue
          manifests.push({
            manifestPath: PackageManifestPath.make(`libs/harness/${pkgDir}/package.json`),
            packageName: PackageManifestName.make(parsed.name),
            nxTags: (parsed.nx?.tags ?? []).map((t) => NxTierTag.make(t)),
            dependencyNames: Object.keys(parsed.dependencies ?? {}).map((d) =>
              PackageDependencyName.make(d),
            ),
          })
        }

        const serviceSrcDir = join(harnessDir, "service", "src")
        const serviceFiles = readdirSync(serviceSrcDir)
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => ({
            filePath: AstSourceFilePath.make(`libs/harness/service/src/${f}`),
            content: AstSourceContent.make(readFileSync(join(serviceSrcDir, f), "utf8")),
          }))

        const report = yield* decideHarnessTierTopology({ manifests, serviceFiles })
        expect(report.verdict).toBe("clean")
        expect(report.violations).toEqual([])
      }),
  )
})
