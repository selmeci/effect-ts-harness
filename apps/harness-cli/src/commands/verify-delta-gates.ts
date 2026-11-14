import { join, relative } from "node:path"
import { Cause, Data, Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  HARNESS_GATE_RULE_VERSION,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  AstGateCache,
  collectModularPluginFiles,
  evaluateAllGatePlugins,
  GatePluginRegistryLive,
  isModularPluginPath,
  type SpanSample,
} from "@harness/gates"
import { nodeSyncHostIo, WorkspaceFsLive } from "@harness/infra"
import type { CliResult } from "./daemon-and-omnigraph.service.js"

export const runDeltaAstAndPluginGates = (
  repoRoot: string,
  deltaFiles: ReadonlyArray<string>,
): Effect.Effect<Option.Option<CliResult>> =>
  Effect.gen(function* () {
    if (deltaFiles.length === 0) return Option.none()
    const astGateFiles = deltaFiles.map((relPath) => ({
      filePath: AstSourceFilePath.make(relPath),
      content: AstSourceContent.make(nodeSyncHostIo.readTextSync(join(repoRoot, relPath))),
    }))
    const astReport = yield* AstGateCache.decide({
      files: astGateFiles,
      ruleVersion: HARNESS_GATE_RULE_VERSION,
      cacheFilePath: AstGateCache.resolveCachePath(repoRoot),
    })
    const enforcedAstViolations = astReport.violations.filter((v) => !v.file.startsWith("tools/"))
    if (enforcedAstViolations.length > 0) {
      const msg = enforcedAstViolations
        .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
        .join("\n")
      return Option.some({ exitCode: 1, stdout: "", stderr: `[GATE FAILURE] verify:ast-gates\n${msg}` })
    }

    let modularDeltaFiles = deltaFiles.filter((f) => isModularPluginPath(f))
    if (
      modularDeltaFiles.length === 0 &&
      nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "gates", "src"))
    ) {
      process.stderr.write(
        `[harness:verify] Warning: no modular gate delta files detected in ${repoRoot}; falling back to scanning all modular gate files.\n`,
      )
      modularDeltaFiles = collectModularPluginFiles(repoRoot, nodeSyncHostIo).map((abs) =>
        relative(repoRoot, abs).replace(/\\/g, "/"),
      )
    }
    if (modularDeltaFiles.length === 0) return Option.none()
    const pluginExit = yield* evaluateAllGatePlugins({
      filePaths: modularDeltaFiles.map((relPath) => WorkspaceFilePath.make(join(repoRoot, relPath))),
      failOnViolation: true,
    }).pipe(Effect.provide(Layer.mergeAll(GatePluginRegistryLive, WorkspaceFsLive)), Effect.exit)

    return match(pluginExit)
      .with({ _tag: "Success" }, () => Option.none<CliResult>())
      .with({ _tag: "Failure" }, ({ cause }) => {
        const errOpt = Cause.findErrorOption(cause)
        return match(errOpt)
          .with({ _tag: "Some" }, ({ value }) =>
            match(value)
              .with({ _tag: "SelfDogfoodingViolationError" }, (err) => {
                const msg = err.violations
                  .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
                  .join("\n")
                return Option.some({
                  exitCode: 1,
                  stdout: "",
                  stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${msg}`,
                })
              })
              .with({ _tag: "WorkspaceFsError" }, (err) =>
                Option.some({
                  exitCode: 1,
                  stdout: "",
                  stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\nFailed to read ${err.filePath}: ${err.reason}`,
                }),
              )
              .exhaustive(),
          )
          .with({ _tag: "None" }, () =>
            Option.some({
              exitCode: 1,
              stdout: "",
              stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${Cause.pretty(cause)}`,
            }),
          )
          .exhaustive()
      })
      .exhaustive()
  })

export class SpanTraceReadError extends Data.TaggedError("SpanTraceReadError")<{
  readonly filePath: string
  readonly reason: "ReadError" | "ParseError" | "InvalidShapeError"
  readonly message: string
}> {}

export const readRecordedSpans = Effect.fn("HarnessCli.readRecordedSpans")(function* (
  repoRoot: string,
): Effect.fn.Return<Array<SpanSample>, SpanTraceReadError> {
  const spanTracePath = join(repoRoot, ".harness", "span-trace.json")
  if (!nodeSyncHostIo.existsSync(spanTracePath)) return []
  const rawSpanJson = yield* Effect.try({
    try: () => nodeSyncHostIo.readTextSync(spanTracePath),
    catch: (err) =>
      new SpanTraceReadError({
        filePath: spanTracePath,
        reason: "ReadError",
        message: `Failed to read span trace file '${spanTracePath}': ${err instanceof Error ? err.message : String(err)}`,
      }),
  })
  if (rawSpanJson.trim().length === 0) return []
  const parsedOpt = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(rawSpanJson)
  return yield* match(parsedOpt)
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new SpanTraceReadError({
          filePath: spanTracePath,
          reason: "ParseError",
          message: `Invalid JSON in span trace file '${spanTracePath}'.`,
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value: parsed }) => {
      if (Array.isArray(parsed)) {
        return Effect.succeed(parsed as Array<SpanSample>)
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "spans" in parsed &&
        Array.isArray(parsed.spans)
      ) {
        return Effect.succeed(parsed.spans as Array<SpanSample>)
      }
      return Effect.fail(
        new SpanTraceReadError({
          filePath: spanTracePath,
          reason: "InvalidShapeError",
          message: `Unexpected JSON shape in span trace file '${spanTracePath}': expected an array or { spans: [...] }.`,
        }),
      )
    })
    .exhaustive()
})
