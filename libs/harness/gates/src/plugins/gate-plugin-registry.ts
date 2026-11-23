import { Context, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  ErrorReasonMessage,
  makeSelfDogfoodingReport,
  type MaxPluginFileLines,
  PluginId,
  SelfDogfoodingMessage,
  type SelfDogfoodingReport,
  type SelfDogfoodingViolation,
  SelfDogfoodingViolationError,
  type WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { NonNegativeCount } from "@harness/graph"
import { WorkspaceFs } from "@harness/service"
import { type SelfDogfoodingFileInput } from "./self-dogfooding-contract.js"
import { decideSelfDogfooding } from "./self-dogfooding-plugin.js"
import { statAndReadWorkspaceFiles } from "../services/workspace-fs.js"

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
  Layer.effect(
    GatePluginRegistry,
    Effect.gen(function* () {
      const seenIds = new Set<string>()
      for (const plugin of plugins) {
        if (seenIds.has(plugin.pluginId)) {
          return yield* Effect.die(
            new Error(`Duplicate gate plugin ID registered: ${plugin.pluginId}`),
          )
        }
        seenIds.add(plugin.pluginId)
      }

      return GatePluginRegistry.of({
        listPlugins: Effect.succeed(plugins),
        evaluateFiles: (files, options) =>
          Effect.gen(function* () {
            const allViolations: Array<SelfDogfoodingViolation> = []
            let maxInspectedCount = 0
            for (const plugin of plugins) {
              const report = yield* plugin.evaluate(files, options?.maxPluginFileLines)
              allViolations.push(...report.violations)
              if (report.inspectedFileCount > maxInspectedCount) {
                maxInspectedCount = report.inspectedFileCount
              }
            }
            const nonTestFileCount = files.filter(
              (f) => !f.filePath.endsWith(".test.ts") && !f.filePath.endsWith(".spec.ts"),
            ).length
            const inspectedCount = Math.max(maxInspectedCount, nonTestFileCount)
            const report = makeSelfDogfoodingReport(
              allViolations,
              NonNegativeCount.make(inspectedCount),
            )

            const [firstViolation, ...restViolations] = allViolations
            if (options?.failOnViolation === true && firstViolation !== undefined) {
              return yield* new SelfDogfoodingViolationError({
                message: SelfDogfoodingMessage.make(
                  `GatePluginRegistry found ${allViolations.length} violation(s) across ${plugins.length} plugin(s).`,
                ),
                violations: [firstViolation, ...restViolations],
              })
            }
            return report
          }),
      })
    }),
  )

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
  const stats = yield* statAndReadWorkspaceFiles(input.filePaths)
  const loadedFiles: Array<SelfDogfoodingFileInput> = []
  for (const fileStat of stats) {
    const decodedPath = Schema.decodeOption(AstSourceFilePath)(fileStat.filePath)
    const decodedContent = Schema.decodeOption(AstSourceContent)(fileStat.content)
    const decoded = match([decodedPath, decodedContent] as const)
      .with([{ _tag: "Some" }, { _tag: "Some" }], ([p, c]) => ({
        filePath: p.value,
        content: c.value,
      }))
      .otherwise(() => undefined)
    if (decoded === undefined) {
      return yield* new WorkspaceFsError({
        filePath: fileStat.filePath,
        operation: WorkspaceFsOperation.make("read"),
        reason: ErrorReasonMessage.make(
          `AST gate file '${fileStat.filePath}' failed bounded path or content validation`,
        ),
      })
    }
    loadedFiles.push(decoded)
  }

  return yield* registry.evaluateFiles(loadedFiles, {
    maxPluginFileLines: input.maxPluginFileLines,
    failOnViolation: input.failOnViolation,
  })
})
