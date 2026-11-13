import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Cause, Data, Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  collectModularPluginFiles,
  evaluateAllGatePlugins,
  GatePluginRegistryLive,
  HARNESS_GATE_RULE_VERSION,
  isModularPluginPath,
  isRepoWideAstRule,
  type SpanSample,
  WorkspaceFilePath,
  WorkspaceFsLive,
} from "@harness/gates"
import type { CliResult } from "./daemon-and-omnigraph.service.js"

export const runDeltaAstAndPluginGates = (
  repoRoot: string,
  deltaFiles: ReadonlyArray<string>,
): Effect.Effect<Option.Option<CliResult>> =>
  Effect.gen(function* () {
    if (deltaFiles.length === 0) return Option.none()
    const astGateFiles = deltaFiles.map((relPath) => ({
      filePath: AstSourceFilePath.make(relPath),
      content: AstSourceContent.make(readFileSync(join(repoRoot, relPath), "utf-8")),
    }))
    const astReport = yield* AstGateCache.decide({
      files: astGateFiles,
      ruleVersion: HARNESS_GATE_RULE_VERSION,
      cacheFilePath: AstGateCache.resolveCachePath(repoRoot),
    })
    const enforcedAstViolations = astReport.violations.filter((v) => {
      // Repo-wide AST rules enforce uniformly across libs/harness/*, apps/harness-*, and tools/*;
      // legacy AST rules still exempt internal harness packages during incremental migration.
      if (isRepoWideAstRule(v.rule, v.message)) {
        return true
      }
      return (
        !v.file.startsWith("libs/harness/") &&
        !v.file.startsWith("apps/harness-") &&
        !v.file.startsWith("tools/")
      )
    })
    if (enforcedAstViolations.length > 0) {
      const msg = enforcedAstViolations
        .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
        .join("\n")
      return Option.some({ exitCode: 1, stdout: "", stderr: `[GATE FAILURE] verify:ast-gates\n${msg}` })
    }

    let modularDeltaFiles = deltaFiles.filter((f) => isModularPluginPath(f))
    if (
      modularDeltaFiles.length === 0 &&
      existsSync(join(repoRoot, "libs", "harness", "gates", "src"))
    ) {
      process.stderr.write(
        `[harness:verify] Warning: no modular gate delta files detected in ${repoRoot}; falling back to scanning all modular gate files.\n`,
      )
      modularDeltaFiles = collectModularPluginFiles(repoRoot).map((abs) =>
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
        if (Option.isSome(errOpt) && errOpt.value._tag === "SelfDogfoodingViolationError") {
          const msg = errOpt.value.violations
            .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
            .join("\n")
          return Option.some({
            exitCode: 1,
            stdout: "",
            stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${msg}`,
          })
        }
        if (Option.isSome(errOpt) && errOpt.value._tag === "WorkspaceFsError") {
          return Option.some({
            exitCode: 1,
            stdout: "",
            stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\nFailed to read ${errOpt.value.filePath}: ${errOpt.value.reason}`,
          })
        }
        return Option.some({
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${Cause.pretty(cause)}`,
        })
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
  if (!existsSync(spanTracePath)) return []
  const rawSpanJson = yield* Effect.try({
    try: () => readFileSync(spanTracePath, "utf-8"),
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
