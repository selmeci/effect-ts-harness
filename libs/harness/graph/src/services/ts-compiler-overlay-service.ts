import { resolve } from "node:path"
import type { SyncHostIo } from "@harness/service/host-io"
import { Cause, Context, Effect, Layer, Semaphore } from "effect"
import {
  CompilerOverlayErrorReason,
  CompilerRepoRootInput,
  CompilerRepoRootPath,
  isPureInterruptCause,
  toCompilerOverlayErrorReason,
  toCompilerRepoRootInput,
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

const makeOverlayError = (
  repoRoot: string,
  reason: string,
  fallback?: string,
): TsCompilerOverlayError =>
  new TsCompilerOverlayError({
    repoRoot: toCompilerRepoRootInput(repoRoot),
    reason: toCompilerOverlayErrorReason(reason, fallback),
  })

export const makeTsCompilerOverlayLayer = (
  hostIo: SyncHostIo,
): Layer.Layer<TsCompilerOverlayService> =>
  Layer.effect(
    TsCompilerOverlayService,
    Effect.gen(function* () {
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          byHost: new WeakMap<SyncHostIo, Map<string, TypeScriptProgramSession>>(),
          all: new Set<TypeScriptProgramSession>(),
        })),
        (state) =>
          Effect.sync(() => {
            for (const session of state.all) {
              session.sourceFileCache.clear()
              session.fileFragmentCache.clear()
              session.reverseImportsByFile.clear()
              session.oldProgram = undefined
              session.project = undefined
              session.lastWorkspaceSnapshot = undefined
            }
            state.all.clear()
          }),
      )
      const getHostSessions = (targetHostIo: SyncHostIo): Map<string, TypeScriptProgramSession> => {
        const existing = registry.byHost.get(targetHostIo)
        if (existing !== undefined) return existing
        const created = new Map<string, TypeScriptProgramSession>()
        registry.byHost.set(targetHostIo, created)
        return created
      }
      const sem = yield* Semaphore.make(1)
      return {
        getSession: (repoRoot) =>
          Effect.suspend(() => {
            const trimmed = repoRoot.trim()
            if (trimmed.length === 0) {
              return Effect.fail(
                makeOverlayError(repoRoot, "Repository root path must be non-empty."),
              )
            }
            const resolvedRoot = resolve(trimmed)
            if (!hostIo.existsSync(resolvedRoot) || !hostIo.isDirectorySync(resolvedRoot)) {
              return Effect.fail(
                makeOverlayError(
                  repoRoot,
                  `Repository root path does not exist or is not a directory: ${trimmed}`,
                ),
              )
            }
            const hostSessions = getHostSessions(hostIo)
            const existing = hostSessions.get(resolvedRoot)
            if (existing !== undefined) {
              return Effect.succeed(existing)
            }
            return Effect.try({
              try: () => {
                const created = createWarmProgramSession(resolvedRoot, hostIo)
                hostSessions.set(resolvedRoot, created)
                registry.all.add(created)
                return created
              },
              catch: (err) =>
                makeOverlayError(
                  repoRoot,
                  err instanceof Error && err.message.trim().length > 0 ? err.message : "",
                  "Failed to initialize TypeScript compiler session.",
                ),
            })
          }),
        extractGraphWithOverlays: (options) =>
          sem.withPermits(1)(
            Effect.gen(function* () {
              const trimmed = options.repoRoot.trim()
              if (trimmed.length === 0) {
                return yield* makeOverlayError(
                  options.repoRoot,
                  "Repository root path must be non-empty.",
                )
              }
              const activeHostIo = options.hostIo ?? hostIo
              const resolvedRoot = resolve(trimmed)
              if (
                !activeHostIo.existsSync(resolvedRoot) ||
                !activeHostIo.isDirectorySync(resolvedRoot)
              ) {
                return yield* makeOverlayError(
                  options.repoRoot,
                  `Repository root path does not exist or is not a directory: ${trimmed}`,
                )
              }
              const hostSessions = getHostSessions(activeHostIo)
              let session: TypeScriptProgramSession
              if (options.session !== undefined) {
                session = options.session
              } else {
                const existing = hostSessions.get(resolvedRoot)
                if (existing !== undefined) {
                  session = existing
                } else {
                  session = yield* Effect.try({
                    try: () => createWarmProgramSession(resolvedRoot, activeHostIo),
                    catch: (err) =>
                      makeOverlayError(
                        options.repoRoot,
                        err instanceof Error && err.message.trim().length > 0 ? err.message : "",
                        "Failed to initialize TypeScript compiler session.",
                      ),
                  })
                  hostSessions.set(resolvedRoot, session)
                  registry.all.add(session)
                }
              }
              return yield* extractTypeGraph({
                ...options,
                repoRoot: resolvedRoot,
                hostIo: activeHostIo,
                session,
              }).pipe(
                Effect.catchCause((cause) => {
                  if (isPureInterruptCause(cause)) {
                    return Effect.failCause(cause)
                  }
                  const defectMsg = Cause.pretty(cause)
                  return Effect.fail(
                    makeOverlayError(
                      options.repoRoot,
                      defectMsg.trim().length > 0 ? defectMsg : "",
                      "TypeGraph.extract failed with an unexpected error.",
                    ),
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
