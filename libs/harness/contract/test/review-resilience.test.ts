import { Cause, Exit, Redacted, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AstSourceFilePath,
  DEFAULT_DECISION_MODEL_TIMEOUT_MS,
  DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
  DEFAULT_REVIEW_ROUTE_TIMEOUT_MS,
  ErrorReasonMessage,
  LspCommandName,
  LspDiagnosticHint,
  LspDiagnosticsTimeoutError,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheLookupInput,
  MutationCacheMac,
  MutationCacheTimestamp,
  MutationEpochMillis,
  OllamaEndpointUrl,
  OllamaModelName,
  OllamaWarmupError,
  OllamaWarmupStage,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowTimeoutBudgets,
  WorkflowTimeoutMs,
  WorkspaceFilePath,
  computeContentSha256,
  validateWorkflowTimeoutBudgets,
} from "../src/index.js"

const expectDecodeFailure = <A, E>(exit: Exit.Exit<A, E>): void => {
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
}

describe("SPEC-0037 review-loop resilience contracts", () => {
  it("exposes unified 5000ms DecisionModel, 45000ms LSP watchdog, and 10000ms Ollama warmup budgets", () => {
    expect(WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs).toBe(5_000)
    expect(WORKFLOW_TIMEOUT_BUDGETS.lspDiagnosticsWatchdogMs).toBe(45_000)
    expect(WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs).toBe(10_000)
    expect(DEFAULT_DECISION_MODEL_TIMEOUT_MS).toBe(WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs)
    expect(DEFAULT_LSP_WATCHDOG_TIMEOUT_MS).toBe(WORKFLOW_TIMEOUT_BUDGETS.lspDiagnosticsWatchdogMs)
    expect(DEFAULT_REVIEW_ROUTE_TIMEOUT_MS).toBe(WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs)
    expect(DEFAULT_REVIEW_ROUTE_TIMEOUT_MS).toBe(5_000)

    expect(WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs).toBeGreaterThanOrEqual(
      WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.lspDiagnosticsWatchdogMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
    )
    expect(WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs).toBeGreaterThan(
      WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
    )
  })

  it("enforces monotonicity checks for ollamaWarmupProbeMs, lspDiagnosticsWatchdogMs, and workflowIpcMs vs decisionModelTimeoutMs", () => {
    // ollamaWarmupProbeMs >= decisionModelTimeoutMs
    const warmupTooSmall = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      ollamaWarmupProbeMs: WorkflowTimeoutMs.make(
        WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs - 1,
      ),
    })
    match(warmupTooSmall)
      .with({ _tag: "Failure" }, ({ failure }) => expect(failure).toContain("ollamaWarmupProbeMs"))
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected ollamaWarmupProbeMs < decisionModelTimeoutMs to fail"),
      )
      .exhaustive()

    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          ollamaWarmupProbeMs: WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
        }),
      ),
    ).toBe(true)

    // lspDiagnosticsWatchdogMs > decisionModelTimeoutMs
    const watchdogNotGreater = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      lspDiagnosticsWatchdogMs: WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
    })
    match(watchdogNotGreater)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect(failure).toContain("lspDiagnosticsWatchdogMs"),
      )
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected lspDiagnosticsWatchdogMs <= decisionModelTimeoutMs to fail"),
      )
      .exhaustive()

    expect(
      Result.isSuccess(
        validateWorkflowTimeoutBudgets({
          ...WORKFLOW_TIMEOUT_BUDGETS,
          lspDiagnosticsWatchdogMs: WorkflowTimeoutMs.make(
            WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs + 1,
          ),
        }),
      ),
    ).toBe(true)

    // workflowIpcMs > decisionModelTimeoutMs
    const ipcNotGreater = validateWorkflowTimeoutBudgets({
      ...WORKFLOW_TIMEOUT_BUDGETS,
      decisionModelTimeoutMs: WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs,
      lspDiagnosticsWatchdogMs: WorkflowTimeoutMs.make(WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs + 1),
      ollamaWarmupProbeMs: WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs,
    })
    match(ipcNotGreater)
      .with({ _tag: "Failure" }, ({ failure }) => expect(failure).toContain("workflowIpcMs"))
      .with({ _tag: "Success" }, () =>
        expect.unreachable("Expected workflowIpcMs <= decisionModelTimeoutMs to fail"),
      )
      .exhaustive()

    expectDecodeFailure(
      Schema.decodeExit(WorkflowTimeoutBudgets)({
        ...WORKFLOW_TIMEOUT_BUDGETS,
        lspDiagnosticsWatchdogMs: WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
      }),
    )
  })

  it("round-trips LspDiagnosticsTimeoutError and rejects invalid branded fields", () => {
    const err = new LspDiagnosticsTimeoutError({
      command: LspCommandName.make("effect-tsgo"),
      timeoutMs: DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
      targetPath: WorkspaceFilePath.make("libs/harness/contract/tsconfig.json"),
      cycleHint: LspDiagnosticHint.make("TS2484 circular re-export cycle"),
      reason: ErrorReasonMessage.make("LSP watchdog exceeded 45000ms"),
    })
    expect(err._tag).toBe("LspDiagnosticsTimeoutError")
    expect(err.command).toBe("effect-tsgo")
    expect(err.timeoutMs).toBe(45_000)

    const encoded = Schema.encodeSync(LspDiagnosticsTimeoutError)(err)
    const decoded = Schema.decodeSync(LspDiagnosticsTimeoutError)(encoded)
    expect(decoded._tag).toBe("LspDiagnosticsTimeoutError")
    expect(decoded.command).toBe(err.command)
    expect(decoded.timeoutMs).toBe(err.timeoutMs)
    expect(decoded.targetPath).toBe(err.targetPath)
    expect(decoded.cycleHint).toBe(err.cycleHint)
    expect(decoded.reason).toBe(err.reason)

    const minimal = Schema.decodeSync(LspDiagnosticsTimeoutError)({
      _tag: "LspDiagnosticsTimeoutError",
      command: "tsgolint",
      timeoutMs: 45_000,
      reason: "Process group killed after timeout",
    })
    expect(minimal.targetPath).toBeUndefined()
    expect(minimal.cycleHint).toBeUndefined()

    expectDecodeFailure(
      Schema.decodeExit(LspDiagnosticsTimeoutError)({
        _tag: "LspDiagnosticsTimeoutError",
        command: "  ",
        timeoutMs: 45_000,
        reason: "bad command",
      }),
    )
    expectDecodeFailure(
      Schema.decodeExit(LspDiagnosticsTimeoutError)({
        _tag: "LspDiagnosticsTimeoutError",
        command: "effect-tsgo",
        timeoutMs: 0,
        reason: "bad timeout",
      }),
    )
    expectDecodeFailure(Schema.decodeExit(LspDiagnosticHint)("a".repeat(513)))
  })

  it("round-trips OllamaWarmupError across all warmup stages and rejects malformed inputs", () => {
    const stages: ReadonlyArray<OllamaWarmupStage> = [
      OllamaWarmupStage.make("server-start"),
      OllamaWarmupStage.make("systemone-probe"),
      OllamaWarmupStage.make("embeddings-probe"),
    ]

    for (const stage of stages) {
      const stageLiteral: "server-start" | "systemone-probe" | "embeddings-probe" = stage
      const stageLabel = match(stageLiteral)
        .with("server-start", () => "server")
        .with("systemone-probe", () => "systemone")
        .with("embeddings-probe", () => "embeddings")
        .exhaustive()

      const err = new OllamaWarmupError({
        stage,
        model: OllamaModelName.make("clef-flash"),
        endpoint: OllamaEndpointUrl.make("http://127.0.0.1:11434/v1/systemone"),
        timeoutMs: WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs,
        reason: ErrorReasonMessage.make(`Warmup failed at ${stageLabel}`),
      })
      const encoded = Schema.encodeSync(OllamaWarmupError)(err)
      const decoded = Schema.decodeSync(OllamaWarmupError)(encoded)
      expect(decoded._tag).toBe("OllamaWarmupError")
      expect(decoded.stage).toBe(stage)
      expect(decoded.model).toBe("clef-flash")
      expect(decoded.endpoint).toBe("http://127.0.0.1:11434/v1/systemone")
      expect(decoded.timeoutMs).toBe(10_000)
    }

    expectDecodeFailure(
      Schema.decodeUnknownExit(OllamaWarmupError)({
        _tag: "OllamaWarmupError",
        stage: "invalid-stage",
        model: "clef-flash",
        endpoint: "http://127.0.0.1:11434",
        timeoutMs: 10_000,
        reason: "bad stage",
      }),
    )
    expectDecodeFailure(Schema.decodeExit(OllamaModelName)(" untrimmed "))
    expectDecodeFailure(Schema.decodeExit(OllamaEndpointUrl)(""))
  })

  it("round-trips two-tier MutationCacheEntry and MutationCacheLookupInput optional digests", () => {
    const keySha = computeContentSha256("mutant-key")
    const witnessSha = computeContentSha256("witness-closure")
    const sourceSha = computeContentSha256("source-closure")
    const testAstSha1 = computeContentSha256("test-ast-1")
    const testAstSha2 = computeContentSha256("test-ast-2")
    const sourceFile = AstSourceFilePath.make("libs/harness/contract/src/review-resilience.ts")
    const witnessTest = AstSourceFilePath.make(
      "libs/harness/contract/test/review-resilience.test.ts",
    )
    const supportSha = computeContentSha256("witness-support")
    const mac = MutationCacheMac.make(computeContentSha256("entry-mac"))
    const secret = Redacted.make(MutationCacheHmacSecret.make("0123456789abcdef0123456789abcdef"))

    const entry = Schema.decodeSync(MutationCacheEntry)({
      key: keySha,
      file: sourceFile,
      mutantId: MutantCacheId.make("review-resilience.ts:1:0"),
      status: "killed",
      recordedAt: MutationCacheTimestamp.make("2026-11-27T09:00:00.000Z"),
      witnessTestFile: witnessTest,
      witnessClosureSha256: witnessSha,
      twoTierWitness: {
        sourceClosureSha256: sourceSha,
        witnessSupportSha256: supportSha,
        witnessTestAstDigests: [testAstSha1, testAstSha2],
      },
      mac,
    })

    const encodedEntry = Schema.encodeSync(MutationCacheEntry)(entry)
    const roundTrippedEntry = Schema.decodeSync(MutationCacheEntry)(encodedEntry)
    expect(roundTrippedEntry.twoTierWitness?.sourceClosureSha256).toBe(sourceSha)
    expect(roundTrippedEntry.twoTierWitness?.witnessSupportSha256).toBe(supportSha)
    expect(roundTrippedEntry.twoTierWitness?.witnessTestAstDigests).toEqual([
      testAstSha1,
      testAstSha2,
    ])

    const lookupInput = Schema.decodeSync(MutationCacheLookupInput)({
      candidateKeys: [keySha],
      store: {
        version: MUTATION_CACHE_SCHEMA_VERSION,
        entries: {
          [keySha]: roundTrippedEntry,
        },
      },
      auth: { _tag: "Enabled", hmacSecret: secret },
      nowMs: MutationEpochMillis.make(1_700_000_000_000),
      reachingTests: [witnessTest],
      witnessClosureDigests: {
        [witnessTest]: witnessSha,
      },
      sourceClosureDigests: {
        [sourceFile]: sourceSha,
      },
      witnessSupportDigests: {
        [witnessTest]: supportSha,
      },
      witnessTestAstDigests: {
        [witnessTest]: [testAstSha1, testAstSha2],
      },
    })

    expect(lookupInput.sourceClosureDigests?.[sourceFile]).toBe(sourceSha)
    expect(lookupInput.witnessSupportDigests?.[witnessTest]).toBe(supportSha)
    expect(lookupInput.witnessTestAstDigests?.[witnessTest]).toEqual([testAstSha1, testAstSha2])

    expectDecodeFailure(
      Schema.decodeExit(MutationCacheEntry)({
        ...encodedEntry,
        twoTierWitness: {
          sourceClosureSha256: "not-a-sha256",
          witnessSupportSha256: supportSha,
          witnessTestAstDigests: [testAstSha1],
        },
      }),
    )
    expectDecodeFailure(
      Schema.decodeUnknownExit(MutationCacheEntry)({
        ...encodedEntry,
        twoTierWitness: {
          sourceClosureSha256: sourceSha,
          witnessTestAstDigests: [testAstSha1],
        },
      }),
    )
    expectDecodeFailure(
      Schema.decodeExit(MutationCacheEntry)({
        ...encodedEntry,
        twoTierWitness: {
          sourceClosureSha256: sourceSha,
          witnessSupportSha256: supportSha,
          witnessTestAstDigests: ["bad-sha"],
        },
      }),
    )
    expectDecodeFailure(
      Schema.decodeExit(MutationCacheLookupInput)({
        candidateKeys: [keySha],
        store: { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} },
        auth: { _tag: "Disabled", reason: "no secret" },
        nowMs: 1_700_000_000_000,
        reachingTests: [witnessTest],
        witnessClosureDigests: { [witnessTest]: witnessSha },
        sourceClosureDigests: { [sourceFile]: "bad-sha" },
      }),
    )
  })
})
