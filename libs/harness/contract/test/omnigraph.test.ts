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
  OmnigraphLintCliOutputSchema,
  OmnigraphLintDiagnostic,
  OmnigraphLintError,
  OmnigraphLintInput,
  OmnigraphLintReport,
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
      _tag: "EffectFnDiffChange",
      entityId: OmnigraphEntityId.make("fn:Cart.checkout"),
      op: Schema.decodeSync(OmnigraphChangeOp)("update"),
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
      },
      dryRunConflicts: [conflict],
      implEffectFnCount: NonNegativeCount.make(1),
      remainingStubCount: NonNegativeCount.make(0),
    }

    const decodedInput = Schema.decodeSync(OmnigraphBranchVerifyInput)(
      Schema.encodeSync(OmnigraphBranchVerifyInput)(input),
    )
    expect(decodedInput.planBranch).toBe("plan/task-1")
    expect(decodedInput.diffState._tag).toBe("ResolvedDiff")
    expect(decodedInput.dryRunConflicts).toHaveLength(1)

    const violation: OmnigraphBranchViolation = {
      _tag: "DryRunMergeConflictViolation",
      ruleId: "dry-run-merge-conflict",
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

    const lintOut = Schema.decodeSync(Schema.fromJsonString(OmnigraphLintCliOutputSchema))(
      JSON.stringify({
        status: "ok",
        errors: 0,
        warnings: 1,
        queries_processed: 14,
        findings: [{ code: "GQ-W01", message: "hint", severity: "warning", target: null }],
      }),
    )
    expect(lintOut.warnings).toBe(1)
  })

  it("roundtrips OmnigraphLintInput, OmnigraphLintReport, and constructs TaggedErrors", () => {
    const diagnostic: OmnigraphLintDiagnostic = {
      code: OmnigraphDiagnosticCode.make("GQ-T37"),
      message: ErrorReasonMessage.make("rrf cannot be projected in return"),
      targetName: OmnigraphTargetName.make("rank_patterns_hybrid"),
      severity: "error",
    }

    const lintInput: OmnigraphLintInput = {
      statusOk: false,
      errorCount: NonNegativeCount.make(1),
      warningCount: NonNegativeCount.make(0),
      queriesProcessed: NonNegativeCount.make(14),
      diagnostics: [diagnostic],
      policy: "fail-on-error",
    }

    const decodedLintInput = Schema.decodeSync(OmnigraphLintInput)(
      Schema.encodeSync(OmnigraphLintInput)(lintInput),
    )
    expect(decodedLintInput.diagnostics).toHaveLength(1)

    const lintViolation: OmnigraphLintViolation = {
      _tag: "LintDiagnosticViolation",
      ruleId: "omnigraph-lint-error",
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

    const precondErr = new OmnigraphPreconditionError({
      branch: OmnigraphBranchName.make("main"),
      expectedCommit: OmnigraphCommitId.make("commit-1"),
      actualCommit: OmnigraphCommitId.make("commit-2"),
    })
    expect(precondErr._tag).toBe("OmnigraphPreconditionError")
    expect(precondErr.branch).toBe("main")
    expect(precondErr.expectedCommit).toBe("commit-1")
    expect(precondErr.actualCommit).toBe("commit-2")

    const precondNullErr = new OmnigraphPreconditionError({
      branch: OmnigraphBranchName.make("main"),
      expectedCommit: OmnigraphCommitId.make("commit-1"),
      actualCommit: null,
    })
    expect(precondNullErr.actualCommit).toBeNull()

    const conflictDetail: OmnigraphMergeConflictDetail = {
      kind: OmnigraphConflictKind.make("orphan_edge"),
      entityKind: OmnigraphEntityKind.make("edge"),
      typeName: OmnigraphTypeName.make("PlaysCallerRole"),
      entityId: null,
      message: ErrorReasonMessage.make("Target missing"),
    }
    const conflictErr = new OmnigraphMergeConflictError({
      sourceBranch: OmnigraphBranchName.make("impl/task-1"),
      targetBranch: OmnigraphBranchName.make("main"),
      conflicts: [conflictDetail],
    })
    expect(conflictErr._tag).toBe("OmnigraphMergeConflictError")
    expect(conflictErr.sourceBranch).toBe("impl/task-1")
    expect(conflictErr.targetBranch).toBe("main")
    expect(conflictErr.conflicts).toEqual([conflictDetail])

    const lintErr = new OmnigraphLintError({
      errorCount: NonNegativeCount.make(1),
      diagnosticsSummary: ErrorReasonMessage.make("GQ-T37 error"),
    })
    expect(lintErr._tag).toBe("OmnigraphLintError")
    expect(lintErr.errorCount).toBe(1)
    expect(lintErr.diagnosticsSummary).toBe("GQ-T37 error")
  })
})
