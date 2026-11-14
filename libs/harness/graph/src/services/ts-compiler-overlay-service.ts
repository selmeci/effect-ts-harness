import { resolve } from "node:path"
import type { SyncHostIo } from "@harness/service"
import { Cause, Context, Effect, Layer, Semaphore } from "effect"
import {
  CompilerOverlayErrorReason,
  CompilerRepoRootInput,
  CompilerRepoRootPath,
  TsCompilerOverlayError,
} from "@harness/contract"
import { type HarnessGraph } from "../model.js"
import {
  createTypeScriptProgramSession as createWarmProgramSession,
  type ExtractTypeGraphOptions,
  extractTypeGraph,
  type TypeScriptProgramSession,
} from "../type-extractor.js"

export {
  CompilerOverlayErrorReason,
  CompilerRepoRootInput,
  CompilerRepoRootPath,
  TsCompilerOverlayError,
}

export type TsCompilerOverlayExtractOptions = Omit<ExtractTypeGraphOptions, "hostIo"> & {
  readonly hostIo?: SyncHostIo | undefined
}

export interface TsCompilerOverlayServiceShape {
  readonly getSession: (
    repoRoot: CompilerRepoRootPath,
  ) => Effect.Effect<TypeScriptProgramSession, TsCompilerOverlayError>
  readonly extractGraphWithOverlays: (
    options: TsCompilerOverlayExtractOptions,
  ) => Effect.Effect<HarnessGraph, TsCompilerOverlayError>
}

export class TsCompilerOverlayService extends Context.Service<
  TsCompilerOverlayService,
  TsCompilerOverlayServiceShape
>()("@harness/graph/TsCompilerOverlayService") {}

export const makeTsCompilerOverlayLayer = (
  hostIo: SyncHostIo,
): Layer.Layer<TsCompilerOverlayService> =>
  Layer.effect(
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
      const sem = yield* Semaphore.make(1)
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
            const resolvedRoot = resolve(trimmed)
            if (!hostIo.existsSync(resolvedRoot) || !hostIo.isDirectorySync(resolvedRoot)) {
              return Effect.fail(
                new TsCompilerOverlayError({
                  repoRoot: CompilerRepoRootInput.make(repoRoot),
                  reason: CompilerOverlayErrorReason.make(
                    `Repository root path does not exist or is not a directory: ${trimmed}`,
                  ),
                }),
              )
            }
            const existing = scopedSessions.get(resolvedRoot)
            if (existing !== undefined) {
              return Effect.succeed(existing)
            }
            return Effect.try({
              try: () => {
                const created = createWarmProgramSession(resolvedRoot, hostIo)
                scopedSessions.set(resolvedRoot, created)
                return created
              },
              catch: (err) =>
                new TsCompilerOverlayError({
                  repoRoot: CompilerRepoRootInput.make(repoRoot),
                  reason: CompilerOverlayErrorReason.make(
                    err instanceof Error && err.message.trim().length > 0
                      ? err.message
                      : "Failed to initialize TypeScript compiler session.",
                  ),
                }),
            })
          }),
        extractGraphWithOverlays: (options) =>
          sem.withPermits(1)(
            Effect.gen(function* () {
              const trimmed = options.repoRoot.trim()
              if (trimmed.length === 0) {
                return yield* new TsCompilerOverlayError({
                  repoRoot: CompilerRepoRootInput.make(options.repoRoot),
                  reason: CompilerOverlayErrorReason.make("Repository root path must be non-empty."),
                })
              }
              const resolvedRoot = resolve(trimmed)
              if (!hostIo.existsSync(resolvedRoot) || !hostIo.isDirectorySync(resolvedRoot)) {
                return yield* new TsCompilerOverlayError({
                  repoRoot: CompilerRepoRootInput.make(options.repoRoot),
                  reason: CompilerOverlayErrorReason.make(
                    `Repository root path does not exist or is not a directory: ${trimmed}`,
                  ),
                })
              }
              const activeHostIo = options.hostIo ?? hostIo
              let session: TypeScriptProgramSession
              if (options.session !== undefined) {
                session = options.session
              } else {
                const existing = scopedSessions.get(resolvedRoot)
                if (existing !== undefined) {
                  session = existing
                } else {
                  session = yield* Effect.try({
                    try: () => createWarmProgramSession(resolvedRoot, activeHostIo),
                    catch: (err) =>
                      new TsCompilerOverlayError({
                        repoRoot: CompilerRepoRootInput.make(options.repoRoot),
                        reason: CompilerOverlayErrorReason.make(
                          err instanceof Error && err.message.trim().length > 0
                            ? err.message
                            : "Failed to initialize TypeScript compiler session.",
                        ),
                      }),
                  })
                  scopedSessions.set(resolvedRoot, session)
                }
              }
              return yield* extractTypeGraph({
                ...options,
                repoRoot: resolvedRoot,
                hostIo: activeHostIo,
                session,
              }).pipe(
                Effect.catchCause((cause) => {
                  if (Cause.hasInterrupts(cause)) {
                    return Effect.failCause(cause)
                  }
                  const defectMsg = Cause.pretty(cause)
                  return Effect.fail(
                    new TsCompilerOverlayError({
                      repoRoot: CompilerRepoRootInput.make(options.repoRoot),
                      reason: CompilerOverlayErrorReason.make(
                        defectMsg.trim().length > 0
                          ? defectMsg
                          : "TypeGraph.extract failed with an unexpected error.",
                      ),
                    }),
                  )
                }),
              )
            }),
          ),
      }
    }),
  )

export const extractGraphViaCompilerOverlay = Effect.fn("TsCompilerOverlay.extractGraph")(
  function* (
    options: TsCompilerOverlayExtractOptions,
  ): Effect.fn.Return<HarnessGraph, TsCompilerOverlayError, TsCompilerOverlayService> {
    const svc = yield* TsCompilerOverlayService
    return yield* svc.extractGraphWithOverlays(options)
  },
)

export const TsCompilerOverlay = {
  extractGraph: extractGraphViaCompilerOverlay,
} as const
