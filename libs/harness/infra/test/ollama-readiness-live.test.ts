import { describe, expect, it, vi } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { match } from "ts-pattern"
import {
  DEFAULT_QWEN_EMBEDDING_DIMENSIONS,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  EmbeddingComponent,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  EmbeddingProviderError,
  type EmbeddingSourceText,
  type EmbeddingVector,
  ErrorReasonMessage,
  KnowledgeQueryText,
  OllamaWarmupError,
} from "@harness/contract"
import { EmbeddingClient } from "@harness/service"
import {
  OllamaReadiness,
  checkOllamaServerReadyDetailed,
  createOllamaWarmupState,
  ensureOllamaWarm,
  nodeSyncHostIo,
} from "../src/index.js"
import { runWithTestTracer } from "./helpers/workflow-verifier-fixture.js"

interface FetchCallRecord {
  readonly url: string
  readonly method: string
  readonly body: string | undefined
}

const makeMockEmbeddingLayer = (options?: {
  readonly onEmbedBatch?: (texts: ReadonlyArray<EmbeddingSourceText>) => void
  readonly failWith?: string | undefined
  readonly hang?: boolean | undefined
}): Layer.Layer<EmbeddingClient> =>
  Layer.succeed(
    EmbeddingClient,
    EmbeddingClient.of({
      config: {
        baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
        model: EmbeddingModelId.make(DEFAULT_QWEN_EMBEDDING_MODEL),
        dimensions: EmbeddingDimensionCount.make(DEFAULT_QWEN_EMBEDDING_DIMENSIONS),
      },
      checkAvailability: Effect.succeed({ _tag: "Available" }),
      embedBatch: (texts) => {
        options?.onEmbedBatch?.(texts)
        if (options?.hang === true) {
          return Effect.never
        }
        if (options?.failWith !== undefined) {
          return Effect.fail(
            new EmbeddingProviderError({
              model: EmbeddingModelId.make(DEFAULT_QWEN_EMBEDDING_MODEL),
              reason: ErrorReasonMessage.make(options.failWith),
            }),
          )
        }
        const vector: EmbeddingVector = {
          components: [EmbeddingComponent.make(1)],
        }
        return Effect.succeed(texts.map(() => vector))
      },
      embedQuery: (_query: KnowledgeQueryText) =>
        Effect.succeed({ components: [EmbeddingComponent.make(1)] }),
    }),
  )

const expectOllamaWarmupError = (
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit<unknown, OllamaWarmupError>>>,
  expectedStage: "server-start" | "systemone-probe" | "embeddings-probe",
  expectedReasonSubstr?: string,
): OllamaWarmupError =>
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) =>
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toBeInstanceOf(OllamaWarmupError)
          expect(value.stage).toBe(expectedStage)
          if (expectedReasonSubstr !== undefined) {
            expect(value.reason).toContain(expectedReasonSubstr)
          }
          return value
        })
        .with({ _tag: "None" }, () =>
          expect.unreachable(`Expected OllamaWarmupError at stage '${expectedStage}'`),
        )
        .exhaustive(),
    )
    .with({ _tag: "Success" }, () =>
      expect.unreachable(`Expected failure with OllamaWarmupError at stage '${expectedStage}'`),
    )
    .exhaustive()

const withCleanOllamaEnv = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prevCustomUrl = process.env.HARNESS_OLLAMA_URL
      const prevHost = process.env.OLLAMA_HOST
      const prevKeepAlive = process.env.OLLAMA_KEEP_ALIVE
      Reflect.deleteProperty(process.env, "HARNESS_OLLAMA_URL")
      Reflect.deleteProperty(process.env, "OLLAMA_HOST")
      Reflect.deleteProperty(process.env, "OLLAMA_KEEP_ALIVE")
      return { prevCustomUrl, prevHost, prevKeepAlive }
    }),
    () => effect,
    ({ prevCustomUrl, prevHost, prevKeepAlive }) =>
      Effect.sync(() => {
        if (prevCustomUrl === undefined) Reflect.deleteProperty(process.env, "HARNESS_OLLAMA_URL")
        else process.env.HARNESS_OLLAMA_URL = prevCustomUrl
        if (prevHost === undefined) Reflect.deleteProperty(process.env, "OLLAMA_HOST")
        else process.env.OLLAMA_HOST = prevHost
        if (prevKeepAlive === undefined) Reflect.deleteProperty(process.env, "OLLAMA_KEEP_ALIVE")
        else process.env.OLLAMA_KEEP_ALIVE = prevKeepAlive
      }),
  )

describe("OllamaReadinessLive (SPEC-0037 REQ-2.1, REQ-2.2, REQ-2.3)", () => {
  it.effect(
    "REQ-2.1: spawns ollama serve with OLLAMA_KEEP_ALIVE=-1 when down, probes POST /v1/systemone (never /api/generate or /api/chat), and records OllamaReadiness.ensureWarm span",
    () =>
      withCleanOllamaEnv(
        Effect.gen(function* () {
          let serverUp = false
          const fetchCalls: Array<FetchCallRecord> = []
          const embedBatchCalls: Array<ReadonlyArray<EmbeddingSourceText>> = []
          const spawnedCommands: Array<{
            readonly cmd: string
            readonly args: ReadonlyArray<string>
            readonly keepAlive: string | undefined
          }> = []

          const spawnSpy = vi
            .spyOn(nodeSyncHostIo, "spawnDetached")
            .mockImplementation((cmd, args, opts) => {
              spawnedCommands.push({
                cmd,
                args,
                keepAlive: opts?.env?.OLLAMA_KEEP_ALIVE,
              })
              serverUp = true
              return { _tag: "Spawned", pid: 4242 }
            })

          const mockFetch: typeof globalThis.fetch = (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const method = init?.method ?? "GET"
            const body = typeof init?.body === "string" ? init.body : undefined
            fetchCalls.push({ url, method, body })

            if (url.endsWith("/api/tags")) {
              if (!serverUp) {
                return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434"))
              }
              return Promise.resolve(
                new Response(JSON.stringify({ models: [{ name: "clef-flash" }] }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              )
            }
            if (url.endsWith("/v1/systemone")) {
              return Promise.resolve(
                new Response(JSON.stringify({ ready: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              )
            }
            return Promise.reject(new Error(`Unexpected endpoint: ${url}`))
          }

          const state = createOllamaWarmupState()

          const { result: receipt, spans } = yield* Effect.ensuring(
            Effect.gen(function* () {
              const fiber = yield* runWithTestTracer(
                "ollama-readiness-spawn",
                OllamaReadiness.ensureWarm({
                  fetch: mockFetch,
                  state,
                  pollIntervalMs: 200,
                }).pipe(
                  Effect.provide(
                    makeMockEmbeddingLayer({
                      onEmbedBatch: (texts) => {
                        embedBatchCalls.push(texts)
                      },
                    }),
                  ),
                ),
              ).pipe(Effect.forkChild)

              yield* TestClock.adjust("200 millis")
              return yield* Fiber.join(fiber)
            }),
            Effect.sync(() => {
              spawnSpy.mockRestore()
            }),
          )

          expect(receipt.clefWarm).toBe(true)
          expect(receipt.embeddingsWarm).toBe(true)
          expect(receipt.cached).toBe(false)

          expect(spawnedCommands).toEqual([
            {
              cmd: "ollama",
              args: ["serve"],
              keepAlive: "-1",
            },
          ])

          expect(fetchCalls.some((c) => c.url.includes("/api/generate"))).toBe(false)
          expect(fetchCalls.some((c) => c.url.includes("/api/chat"))).toBe(false)

          const systemOneCall = fetchCalls.find((c) => c.url.endsWith("/v1/systemone"))
          expect(systemOneCall).toBeDefined()
          expect(systemOneCall?.method).toBe("POST")
          expect(systemOneCall?.body).toContain('"model":"clef-flash"')
          expect(systemOneCall?.body).toContain('"questions"')

          expect(embedBatchCalls).toEqual([["warmup"]])
          expect(spans.some((s) => s.name === "OllamaReadiness.ensureWarm")).toBe(true)
        }),
      ),
  )

  it.effect(
    "REQ-2.2: single-flight coalesces concurrent callers and caches process-local warm state on subsequent calls",
    () =>
      Effect.gen(function* () {
        let systemOneCount = 0
        let embedCount = 0
        const state = createOllamaWarmupState()

        const mockFetch: typeof globalThis.fetch = (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith("/api/tags")) {
            return Promise.resolve(
              new Response(JSON.stringify({ models: [{ name: "clef-flash" }] }), { status: 200 }),
            )
          }
          if (url.endsWith("/v1/systemone")) {
            systemOneCount += 1
            return Promise.resolve(new Response(JSON.stringify({ ready: true }), { status: 200 }))
          }
          return Promise.reject(new Error(`Unexpected URL ${url}`))
        }

        const embedLayer = makeMockEmbeddingLayer({
          onEmbedBatch: () => {
            embedCount += 1
          },
        })

        const [first, second] = yield* Effect.all(
          [
            ensureOllamaWarm({ fetch: mockFetch, state }),
            ensureOllamaWarm({ fetch: mockFetch, state }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(embedLayer))

        expect(first.clefWarm).toBe(true)
        expect(first.embeddingsWarm).toBe(true)
        expect(second.clefWarm).toBe(true)
        expect(second.embeddingsWarm).toBe(true)
        expect(systemOneCount).toBe(1)
        expect(embedCount).toBe(1)

        const third = yield* ensureOllamaWarm({ fetch: mockFetch, state }).pipe(
          Effect.provide(embedLayer),
        )
        expect(third.cached).toBe(true)
        expect(systemOneCount).toBe(1)
        expect(embedCount).toBe(1)
      }),
  )

  it.effect(
    "REQ-2.3: fails closed with typed OllamaWarmupError across server-start, systemone-probe, and embeddings-probe stages",
    () =>
      Effect.gen(function* () {
        const state = createOllamaWarmupState()

        // 1) Non-loopback host rejected at server-start
        const nonLoopbackExit = yield* Effect.exit(
          ensureOllamaWarm({
            baseUrl: "http://evil.example:11434",
            state,
          }).pipe(Effect.provide(makeMockEmbeddingLayer())),
        )
        expectOllamaWarmupError(nonLoopbackExit, "server-start", "non-loopback")

        // 2) Server unreachable within probeBudgetMs
        const unreachableFetch: typeof globalThis.fetch = () =>
          Promise.reject(new Error("ECONNREFUSED"))
        const serverFailFiber = yield* Effect.exit(
          ensureOllamaWarm({
            fetch: unreachableFetch,
            spawnOllama: () => ({ _tag: "Spawned", pid: 99 }),
            probeBudgetMs: 400,
            pollIntervalMs: 200,
            state,
          }).pipe(Effect.provide(makeMockEmbeddingLayer())),
        ).pipe(Effect.forkChild)
        yield* TestClock.adjust("200 millis")
        yield* TestClock.adjust("200 millis")
        const serverFailExit = yield* Fiber.join(serverFailFiber)
        expectOllamaWarmupError(serverFailExit, "server-start", "ECONNREFUSED")

        // 3) POST /v1/systemone HTTP error
        const badSystemOneFetch: typeof globalThis.fetch = (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith("/api/tags")) {
            return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }))
          }
          return Promise.resolve(new Response("model not found", { status: 404 }))
        }
        const systemOneExit = yield* Effect.exit(
          ensureOllamaWarm({
            fetch: badSystemOneFetch,
            state,
          }).pipe(Effect.provide(makeMockEmbeddingLayer())),
        )
        expectOllamaWarmupError(systemOneExit, "systemone-probe", "HTTP 404")

        // 4) EmbeddingClient.embedBatch error
        const okSystemOneFetch: typeof globalThis.fetch = (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith("/api/tags")) {
            return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }))
          }
          return Promise.resolve(new Response(JSON.stringify({ ready: true }), { status: 200 }))
        }
        const embedFailExit = yield* Effect.exit(
          ensureOllamaWarm({
            fetch: okSystemOneFetch,
            state,
          }).pipe(Effect.provide(makeMockEmbeddingLayer({ failWith: "qwen3-embedding offline" }))),
        )
        expectOllamaWarmupError(embedFailExit, "embeddings-probe", "qwen3-embedding offline")
      }),
  )

  it.effect(
    "checkOllamaServerReadyDetailed detects clef-flash and reports non-loopback, HTTP, and missing-model failures",
    () =>
      Effect.gen(function* () {
        const nonLoopback = yield* checkOllamaServerReadyDetailed("http://evil.example:11434")
        expect(nonLoopback.ready).toBe(false)

        const readyProbe = yield* checkOllamaServerReadyDetailed("http://127.0.0.1:11434", () =>
          Promise.resolve(
            new Response(JSON.stringify({ models: [{ name: "clef-flash:latest" }] }), {
              status: 200,
            }),
          ),
        )
        expect(readyProbe).toEqual({ ready: true })

        const missingModel = yield* checkOllamaServerReadyDetailed("127.0.0.1:11434", () =>
          Promise.resolve(
            new Response(JSON.stringify({ models: [{ name: "qwen3-embedding:8b" }] }), {
              status: 200,
            }),
          ),
        )
        expect(missingModel.ready).toBe(false)

        const httpErr = yield* checkOllamaServerReadyDetailed("http://localhost:11434", () =>
          Promise.resolve(new Response("down", { status: 503 })),
        )
        expect(httpErr.ready).toBe(false)
      }),
  )
})
