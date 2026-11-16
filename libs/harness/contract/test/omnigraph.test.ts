import { Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  WorkspaceFilePath,
  makeVerdictReport,
} from "../src/index.js"
import {
  OmnigraphActorToken,
  OmnigraphAuthTokensSchema,
  OmnigraphBaseUrl,
  OmnigraphBranchName,
  OmnigraphBranchVerifyInput,
  OmnigraphBranchVerifyReport,
  type OmnigraphBranchViolation,
  OmnigraphChangeCursor,
  OmnigraphChangeOp,
  OmnigraphCommitId,
  OmnigraphConfigDriftKind,
  OmnigraphConflictKind,
  OmnigraphDiagnosticCode,
  type OmnigraphDiffChangeSummary,
  OmnigraphEntityId,
  OmnigraphEntityKind,
  OmnigraphIsoTimestamp,
  OmnigraphLintDiagnostic,
  OmnigraphLintError,
  OmnigraphLintInput,
  OmnigraphLintReport,
  OmnigraphLintStatus,
  type OmnigraphLintViolation,
  OmnigraphMergeConflictDetail,
  OmnigraphMergeConflictError,
  OmnigraphPreconditionError,
  OmnigraphProcessId,
  OmnigraphSchemaEvolutionAction,
  OmnigraphSchemaEvolutionInput,
  OmnigraphServerMetaSchema,
  OmnigraphSpanName,
  OmnigraphTargetName,
  OmnigraphTcpPort,
  OmnigraphTypeName,
} from "../src/omnigraph.js"

describe("@harness/contract omnigraph schemas", () => {
  it("decodes branded Omnigraph scalars and rejects untrimmed, empty, or invalid values", () => {
    expect(Schema.decodeSync(OmnigraphCommitId)("commit-abc123")).toBe("commit-abc123")
    expect(Schema.decodeSync(OmnigraphBranchName)("impl/rfc-0009")).toBe("impl/rfc-0009")
    expect(Schema.decodeSync(OmnigraphChangeCursor)("cursor-42")).toBe("cursor-42")
    expect(Schema.decodeSync(OmnigraphDiagnosticCode)("GQ-T37")).toBe("GQ-T37")
    expect(Schema.decodeSync(OmnigraphTypeName)("EffectFn")).toBe("EffectFn")
    expect(Schema.decodeSync(OmnigraphEntityId)("fn:Orders.create")).toBe("fn:Orders.create")
    expect(Schema.decodeSync(OmnigraphTargetName)("rank_patterns_hybrid")).toBe(
      "rank_patterns_hybrid",
    )
    expect(Schema.decodeSync(OmnigraphSpanName)("Orders.create")).toBe("Orders.create")

    const trimmedScalars = [
      OmnigraphCommitId,
      OmnigraphBranchName,
      OmnigraphChangeCursor,
      OmnigraphDiagnosticCode,
      OmnigraphTypeName,
      OmnigraphEntityId,
      OmnigraphTargetName,
      OmnigraphSpanName,
      OmnigraphActorToken,
      OmnigraphBaseUrl,
      OmnigraphIsoTimestamp,
    ] as const
    for (const scalar of trimmedScalars) {
      expect(() => Schema.decodeSync(scalar)("")).toThrow()
      expect(() => Schema.decodeSync(scalar)("  padded  ")).toThrow()
      expect(() => Schema.decodeUnknownSync(scalar)(123)).toThrow()
    }

    expect(Schema.decodeSync(OmnigraphProcessId)(1234)).toBe(1234)
    expect(() => Schema.decodeSync(OmnigraphProcessId)(1)).toThrow()
    expect(Schema.decodeSync(OmnigraphTcpPort)(18080)).toBe(18080)
    expect(() => Schema.decodeSync(OmnigraphTcpPort)(70000)).toThrow()

    expect(() => Schema.decodeUnknownSync(OmnigraphConflictKind)("unknown_conflict")).toThrow()
    expect(() => Schema.decodeUnknownSync(OmnigraphEntityKind)("vertex")).toThrow()
    expect(() => Schema.decodeUnknownSync(OmnigraphChangeOp)("upsert")).toThrow()
    expect(() => Schema.decodeUnknownSync(OmnigraphConfigDriftKind)("breaking")).toThrow()
  })

  it("roundtrips OmnigraphBranchVerifyInput and OmnigraphBranchVerifyReport with closed tagged unions", () => {
    const conflict: OmnigraphMergeConflictDetail = {
      kind: Schema.decodeSync(OmnigraphConflictKind)("divergent_update"),
      entityKind: Schema.decodeSync(OmnigraphEntityKind)("node"),
      typeName: OmnigraphTypeName.make("EffectFn"),
      entityId: OmnigraphEntityId.make("fn:Cart.checkout"),
      message: ErrorReasonMessage.make("Concurrent update on EffectFn"),
    }

    const change: OmnigraphDiffChangeSummary = {
      _tag: "EffectFnUpdated",
      entityId: OmnigraphEntityId.make("fn:Cart.checkout"),
      wasStubBefore: true,
      stubAfter: false,
      spanName: OmnigraphSpanName.make("Cart.checkout"),
    }

    const input: OmnigraphBranchVerifyInput = {
      planBranch: OmnigraphBranchName.make("plan/task-1"),
      implBranch: OmnigraphBranchName.make("impl/task-1"),
      mainBranch: OmnigraphBranchName.make("main"),
      diffState: {
        _tag: "ResolvedDiff",
        changes: [change],
        observedImplEffectFnCount: NonNegativeCount.make(1),
        unchangedStubCount: NonNegativeCount.make(0),
      },
      dryRunConflicts: [conflict],
    }

    const decodedInput = Schema.decodeSync(OmnigraphBranchVerifyInput)(
      Schema.encodeSync(OmnigraphBranchVerifyInput)(input),
    )
    expect(decodedInput.planBranch).toBe("plan/task-1")
    expect(decodedInput.diffState._tag).toBe("ResolvedDiff")
    expect(decodedInput.dryRunConflicts).toHaveLength(1)

    const violation: OmnigraphBranchViolation = {
      _tag: "dry-run-merge-conflict",
      message: ErrorReasonMessage.make("Merge conflict detected"),
      conflict,
    }

    const report: OmnigraphBranchVerifyReport = makeVerdictReport([violation], {
      verifiedChangeCount: NonNegativeCount.make(1),
      conflictCount: NonNegativeCount.make(1),
      implEffectFnCount: NonNegativeCount.make(1),
    })

    const decodedReport = Schema.decodeSync(OmnigraphBranchVerifyReport)(
      Schema.encodeSync(OmnigraphBranchVerifyReport)(report),
    )
    expect(decodedReport.verdict).toBe("violated")
    expect(decodedReport.violations).toHaveLength(1)
    expect(decodedReport.implEffectFnCount).toBe(1)
  })

  it("roundtrips OmnigraphSchemaEvolutionInput, OmnigraphSchemaEvolutionAction, and canonical wire schemas", () => {
    const driftKinds: ReadonlyArray<OmnigraphConfigDriftKind> = [
      "none",
      "queries-only",
      "schema-additive-or-rename",
      "edge-key-or-policy-bundle-breaking",
    ]
    for (const kind of driftKinds) {
      const decoded = Schema.decodeSync(OmnigraphConfigDriftKind)(kind)
      const label = match(decoded)
        .with("none", () => "none")
        .with("queries-only", () => "queries")
        .with("schema-additive-or-rename", () => "additive")
        .with("edge-key-or-policy-bundle-breaking", () => "breaking")
        .exhaustive()
      expect(label.length).toBeGreaterThan(0)
    }

    const evoInputs: ReadonlyArray<OmnigraphSchemaEvolutionInput> = [
      { _tag: "ClusterMissing" },
      {
        _tag: "ClusterPresent",
        driftKind: "queries-only",
        serverAlive: true,
      },
    ]
    for (const evoInput of evoInputs) {
      const decodedEvo = Schema.decodeSync(OmnigraphSchemaEvolutionInput)(
        Schema.encodeSync(OmnigraphSchemaEvolutionInput)(evoInput),
      )
      expect(decodedEvo._tag).toBe(evoInput._tag)
    }

    const actions: ReadonlyArray<OmnigraphSchemaEvolutionAction> = [
      { _tag: "NoOp" },
      { _tag: "LiveClusterApply", requiresUnlock: false },
      {
        _tag: "RequiresCleanRebuild",
        reason: ErrorReasonMessage.make("Edge key changed"),
      },
    ]
    for (const action of actions) {
      const roundtripped = Schema.decodeSync(OmnigraphSchemaEvolutionAction)(
        Schema.encodeSync(OmnigraphSchemaEvolutionAction)(action),
      )
      expect(roundtripped._tag).toBe(action._tag)
    }

    const tokens = Schema.decodeSync(Schema.fromJsonString(OmnigraphAuthTokensSchema))(
      JSON.stringify({ schemaVersion: 1, cliToken: "cli-tok", mcpToken: "mcp-tok" }),
    )
    expect(tokens.cliToken).toBe("cli-tok")

    const meta = Schema.decodeSync(Schema.fromJsonString(OmnigraphServerMetaSchema))(
      JSON.stringify({
        pid: 4242,
        port: 18080,
        baseUrl: "http://127.0.0.1:18080",
        canonicalRepoRoot: WorkspaceFilePath.make("/tmp/repo"),
        updatedAt: "2026-11-16T00:00:00Z",
      }),
    )
    expect(meta.port).toBe(18080)
    const invalidMetaPort: unknown = {
      pid: 4242,
      port: 70000,
      baseUrl: "http://127.0.0.1:18080",
      canonicalRepoRoot: "/tmp/repo",
      updatedAt: null,
    }
    expect(() => Schema.decodeUnknownSync(OmnigraphServerMetaSchema)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(OmnigraphServerMetaSchema)(invalidMetaPort)).toThrow()

    expect(Schema.decodeSync(OmnigraphLintStatus)("ok")).toBe("ok")
    expect(Schema.decodeSync(OmnigraphLintStatus)("error")).toBe("error")
    expect(() => Schema.decodeUnknownSync(OmnigraphLintStatus)("warning")).toThrow()
  })

  it("roundtrips OmnigraphLintInput, OmnigraphLintReport, and TaggedErrors with negative validation rejections", () => {
    const diagnostic: OmnigraphLintDiagnostic = {
      code: OmnigraphDiagnosticCode.make("GQ-T37"),
      message: ErrorReasonMessage.make("rrf cannot be projected in return"),
      targetName: OmnigraphTargetName.make("rank_patterns_hybrid"),
      severity: "error",
    }

    const lintInput: OmnigraphLintInput = {
      statusOk: false,
      queriesProcessed: NonNegativeCount.make(14),
      diagnostics: [diagnostic],
      policy: "fail-on-error",
    }

    const decodedLintInput = Schema.decodeSync(OmnigraphLintInput)(
      Schema.encodeSync(OmnigraphLintInput)(lintInput),
    )
    expect(decodedLintInput.diagnostics).toHaveLength(1)

    const lintViolation: OmnigraphLintViolation = {
      _tag: "omnigraph-lint-error",
      message: ErrorReasonMessage.make("Query failed lint"),
      diagnostic,
    }

    const lintReport: OmnigraphLintReport = makeVerdictReport([lintViolation], {
      queriesProcessed: NonNegativeCount.make(14),
      errorCount: NonNegativeCount.make(1),
      warningCount: NonNegativeCount.make(0),
    })

    const decodedLintReport = Schema.decodeSync(OmnigraphLintReport)(
      Schema.encodeSync(OmnigraphLintReport)(lintReport),
    )
    expect(decodedLintReport.verdict).toBe("violated")

    const precondRaw = {
      _tag: "OmnigraphPreconditionError" as const,
      branch: "main",
      expectedCommit: "commit-1",
      actualCommit: null,
    }
    const decodedPrecond = Schema.decodeSync(OmnigraphPreconditionError)(precondRaw)
    expect(decodedPrecond._tag).toBe("OmnigraphPreconditionError")
    expect(decodedPrecond.actualCommit).toBeNull()
    expect(Schema.encodeSync(OmnigraphPreconditionError)(decodedPrecond)).toEqual(precondRaw)
    const invalidPrecond: unknown = {
      _tag: "OmnigraphPreconditionError",
      branch: "",
      expectedCommit: "commit-1",
      actualCommit: null,
    }
    expect(() => Schema.decodeUnknownSync(OmnigraphPreconditionError)(invalidPrecond)).toThrow()

    const conflictRaw = {
      _tag: "OmnigraphMergeConflictError" as const,
      sourceBranch: "impl/task-1",
      targetBranch: "main",
      conflicts: [
        {
          kind: "orphan_edge" as const,
          entityKind: "edge" as const,
          typeName: "PlaysCallerRole",
          entityId: null,
          message: "Target missing",
        },
      ],
    }
    const decodedConflict = Schema.decodeSync(OmnigraphMergeConflictError)(conflictRaw)
    expect(decodedConflict._tag).toBe("OmnigraphMergeConflictError")
    expect(Schema.encodeSync(OmnigraphMergeConflictError)(decodedConflict)).toEqual(conflictRaw)
    const invalidConflict: unknown = { ...conflictRaw, sourceBranch: "  " }
    expect(() => Schema.decodeUnknownSync(OmnigraphMergeConflictError)(invalidConflict)).toThrow()

    const lintErrRaw = {
      _tag: "OmnigraphLintError" as const,
      errorCount: 1,
      diagnosticsSummary: "GQ-T37 error",
    }
    const decodedLintErr = Schema.decodeSync(OmnigraphLintError)(lintErrRaw)
    expect(decodedLintErr._tag).toBe("OmnigraphLintError")
    expect(Schema.encodeSync(OmnigraphLintError)(decodedLintErr)).toEqual(lintErrRaw)
    const invalidLintCount: unknown = {
      _tag: "OmnigraphLintError",
      errorCount: -1,
      diagnosticsSummary: "GQ-T37 error",
    }
    const invalidLintSummary: unknown = {
      _tag: "OmnigraphLintError",
      errorCount: 1,
      diagnosticsSummary: "",
    }
    expect(() => Schema.decodeUnknownSync(OmnigraphLintError)(invalidLintCount)).toThrow()
    expect(() => Schema.decodeUnknownSync(OmnigraphLintError)(invalidLintSummary)).toThrow()
  })
})
