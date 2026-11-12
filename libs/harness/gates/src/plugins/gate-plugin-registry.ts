import { Context, Effect, Layer } from "effect"
import { NonNegativeCount } from "@harness/graph"
import { AstSourceContent, AstSourceFilePath, GateVerdict } from "../ast-cache.js"
import {
  type MaxPluginFileLines,
  PluginId,
  type SelfDogfoodingFileInput,
  SelfDogfoodingMessage,
  type SelfDogfoodingReport,
  type SelfDogfoodingViolation,
  SelfDogfoodingViolationError,
  type WorkspaceFilePath,
  type WorkspaceFsError,
} from "./self-dogfooding-contract.js"
import { decideSelfDogfooding } from "./self-dogfooding-plugin.js"
import { WorkspaceFs } from "../services/workspace-fs.js"

export interface GatePluginDescriptor {
  readonly pluginId: PluginId
  readonly description: string
  readonly evaluate: (
    files: ReadonlyArray<SelfDogfoodingFileInput>,
    maxPluginFileLines?: MaxPluginFileLines,
  ) => Effect.Effect<SelfDogfoodingReport, SelfDogfoodingViolationError>
}

export interface GatePluginRegistryShape {
  readonly listPlugins: Effect.Effect<ReadonlyArray<GatePluginDescriptor>>
  readonly evaluateFiles: (
    files: ReadonlyArray<SelfDogfoodingFileInput>,
    options?: {
      readonly maxPluginFileLines?: MaxPluginFileLines | undefined
      readonly failOnViolation?: boolean | undefined
    },
  ) => Effect.Effect<SelfDogfoodingReport, SelfDogfoodingViolationError>
}

export class GatePluginRegistry extends Context.Service<
  GatePluginRegistry,
  GatePluginRegistryShape
>()("@harness/gates/GatePluginRegistry") {}

export const DEFAULT_GATE_PLUGINS: ReadonlyArray<GatePluginDescriptor> = [
  {
    pluginId: PluginId.make("self-dogfooding-core"),
    description:
      "Enforces zero yield* Effect.void, zero nested Effect.runSync, zero switch statements, and modular file line budgets.",
    evaluate: (files, maxPluginFileLines) =>
      decideSelfDogfooding({
        files: [...files],
        maxPluginFileLines,
        failOnViolation: false,
      }),
  },
]

export const makeGatePluginRegistryLayer = (
  plugins: ReadonlyArray<GatePluginDescriptor> = DEFAULT_GATE_PLUGINS,
): Layer.Layer<GatePluginRegistry> =>
  Layer.succeed(GatePluginRegistry, {
    listPlugins: Effect.succeed(plugins),
    evaluateFiles: (files, options) =>
      Effect.gen(function* () {
        const allViolations: Array<SelfDogfoodingViolation> = []
        for (const plugin of plugins) {
          const report = yield* plugin.evaluate(files, options?.maxPluginFileLines)
          allViolations.push(...report.violations)
        }
        const report: SelfDogfoodingReport = {
          verdict: GateVerdict.make(allViolations.length === 0 ? "clean" : "violated"),
          violations: allViolations,
          inspectedFileCount: NonNegativeCount.make(files.length),
        }
        if (options?.failOnViolation === true && allViolations.length > 0) {
          return yield* new SelfDogfoodingViolationError({
            message: SelfDogfoodingMessage.make(
              `GatePluginRegistry found ${allViolations.length} violation(s) across ${plugins.length} plugin(s).`,
            ),
            violations: allViolations,
          })
        }
        return report
      }),
  })

export const GatePluginRegistryLive: Layer.Layer<GatePluginRegistry> =
  makeGatePluginRegistryLayer(DEFAULT_GATE_PLUGINS)

export interface EvaluateGatePluginsInput {
  readonly filePaths: ReadonlyArray<WorkspaceFilePath>
  readonly maxPluginFileLines?: MaxPluginFileLines | undefined
  readonly failOnViolation?: boolean | undefined
}

export const evaluateAllGatePlugins = Effect.fn("GatePluginRunner.evaluateAll")(function* (
  input: EvaluateGatePluginsInput,
): Effect.fn.Return<
  SelfDogfoodingReport,
  SelfDogfoodingViolationError | WorkspaceFsError,
  GatePluginRegistry | WorkspaceFs
> {
  const registry = yield* GatePluginRegistry
  const fs = yield* WorkspaceFs
  const plugins = yield* registry.listPlugins

  const loadedFiles: Array<SelfDogfoodingFileInput> = []
  for (const filePath of input.filePaths) {
    const content = yield* fs.readTextFile(filePath)
    loadedFiles.push({
      filePath: AstSourceFilePath.make(filePath),
      content: AstSourceContent.make(content),
    })
  }

  const allViolations: Array<SelfDogfoodingViolation> = []
  for (const plugin of plugins) {
    const report = yield* plugin.evaluate(loadedFiles, input.maxPluginFileLines)
    allViolations.push(...report.violations)
  }

  const report: SelfDogfoodingReport = {
    verdict: GateVerdict.make(allViolations.length === 0 ? "clean" : "violated"),
    violations: allViolations,
    inspectedFileCount: NonNegativeCount.make(loadedFiles.length),
  }

  if (input.failOnViolation === true && allViolations.length > 0) {
    return yield* new SelfDogfoodingViolationError({
      message: SelfDogfoodingMessage.make(
        `GatePluginRunner.evaluateAll found ${allViolations.length} violation(s) across ${plugins.length} plugin(s).`,
      ),
      violations: allViolations,
    })
  }

  return report
})
