import { existsSync, statSync } from "node:fs"
import { Context, Effect, Layer, Schema } from "effect"
import { type HarnessGraph } from "../model.js"
import {
  type ExtractTypeGraphOptions,
  extractTypeGraph,
  getOrCreateWarmProgramSession,
  type TypeScriptProgramSession,
} from "../type-extractor.js"

export const CompilerRepoRootPath = Schema.NonEmptyString.pipe(Schema.brand("CompilerRepoRootPath"))
export type CompilerRepoRootPath = typeof CompilerRepoRootPath.Type

export const CompilerRepoRootInput = Schema.String.pipe(Schema.brand("CompilerRepoRootInput"))
export type CompilerRepoRootInput = typeof CompilerRepoRootInput.Type

export const CompilerOverlayErrorReason = Schema.NonEmptyString.pipe(
  Schema.brand("CompilerOverlayErrorReason"),
)
export type CompilerOverlayErrorReason = typeof CompilerOverlayErrorReason.Type

export class TsCompilerOverlayError extends Schema.TaggedError<TsCompilerOverlayError>()(
  "TsCompilerOverlayError",
  {
    repoRoot: CompilerRepoRootInput,
    reason: CompilerOverlayErrorReason,
  },
) {}

export interface TsCompilerOverlayServiceShape {
  readonly getSession: (
    repoRoot: CompilerRepoRootPath,
  ) => Effect.Effect<TypeScriptProgramSession, TsCompilerOverlayError>
  readonly extractGraphWithOverlays: (
    options: ExtractTypeGraphOptions,
  ) => Effect.Effect<HarnessGraph, TsCompilerOverlayError>
}

export class TsCompilerOverlayService extends Context.Service<
  TsCompilerOverlayService,
  TsCompilerOverlayServiceShape
>()("@harness/graph/TsCompilerOverlayService") {}

export const TsCompilerOverlayServiceLive: Layer.Layer<TsCompilerOverlayService> = Layer.effect(
  TsCompilerOverlayService,
  Effect.gen(function* () {
    const scopedSessions = yield* Effect.acquireRelease(
      Effect.sync(() => new Map<string, TypeScriptProgramSession>()),
      (sessions) =>
        Effect.sync(() => {
          for (const session of sessions.values()) {
            session.sourceFileCache.clear()
            session.fileFragmentCache.clear()
            session.reverseImportsByFile.clear()
          }
          sessions.clear()
        }),
    )
    return {
      getSession: (repoRoot) =>
        Effect.suspend(() => {
          const trimmed = repoRoot.trim()
          if (trimmed.length === 0) {
            return Effect.fail(
              new TsCompilerOverlayError({
                repoRoot: CompilerRepoRootInput.make(repoRoot),
                reason: CompilerOverlayErrorReason.make("Repository root path must be non-empty."),
              }),
            )
          }
          if (!existsSync(trimmed) || !statSync(trimmed).isDirectory()) {
            return Effect.fail(
              new TsCompilerOverlayError({
                repoRoot: CompilerRepoRootInput.make(repoRoot),
                reason: CompilerOverlayErrorReason.make(
                  `Repository root path does not exist or is not a directory: ${trimmed}`,
                ),
              }),
            )
          }
          const existing = scopedSessions.get(trimmed)
          if (existing !== undefined) {
            return Effect.succeed(existing)
          }
          const created = getOrCreateWarmProgramSession(trimmed)
          scopedSessions.set(trimmed, created)
          return Effect.succeed(created)
        }),
      extractGraphWithOverlays: (options) =>
        Effect.gen(function* () {
          const trimmed = options.repoRoot.trim()
          if (trimmed.length === 0) {
            return yield* new TsCompilerOverlayError({
              repoRoot: CompilerRepoRootInput.make(options.repoRoot),
              reason: CompilerOverlayErrorReason.make("Repository root path must be non-empty."),
            })
          }
          if (!existsSync(trimmed) || !statSync(trimmed).isDirectory()) {
            return yield* new TsCompilerOverlayError({
              repoRoot: CompilerRepoRootInput.make(options.repoRoot),
              reason: CompilerOverlayErrorReason.make(
                `Repository root path does not exist or is not a directory: ${trimmed}`,
              ),
            })
          }
          const session =
            options.session ??
            scopedSessions.get(trimmed) ??
            getOrCreateWarmProgramSession(trimmed)
          scopedSessions.set(trimmed, session)
          return yield* extractTypeGraph({
            ...options,
            session,
          })
        }),
    }
  }),
)

export const extractGraphViaCompilerOverlay = Effect.fn("TsCompilerOverlay.extractGraph")(
  function* (
    options: ExtractTypeGraphOptions,
  ): Effect.fn.Return<HarnessGraph, TsCompilerOverlayError, TsCompilerOverlayService> {
    const svc = yield* TsCompilerOverlayService
    return yield* svc.extractGraphWithOverlays(options)
  },
)

export const TsCompilerOverlay = {
  extractGraph: extractGraphViaCompilerOverlay,
} as const
