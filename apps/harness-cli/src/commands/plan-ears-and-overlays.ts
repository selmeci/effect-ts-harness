import { dirname, relative, resolve } from "node:path"
import { Effect, Option } from "effect"
import { match, P } from "ts-pattern"
import {
  classifyFileWrite,
  decideEarsSpecQuality,
  EarsClauseId,
  EarsClausePatternKind,
  EarsClausePolarity,
  EarsConsistencyFlag,
  type EarsConsistencyInput,
  EarsEffectSymbolName,
  EarsFilePath,
  EarsGuardText,
  EarsOutcomeTag,
  type EarsSemanticClause,
  EarsSpecId,
  EarsVariantTag,
  evaluateEarsConsistencyReport,
  type GovernanceDocReference,
  normalizeConditionPrefix,
} from "@harness/gates"
import type { ShadowFileOverlay } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { CliResult } from "./daemon-and-omnigraph.service.js"

export const checkPlanEarsConsistency = (
  governanceDocs: ReadonlyArray<GovernanceDocReference>,
): Effect.Effect<Option.Option<CliResult>> =>
  Effect.gen(function* () {
    for (const doc of governanceDocs) {
      if (
        doc.markdown === undefined ||
        (!doc.docPath.includes("/specs/") && !doc.id.includes(":SPEC-"))
      ) {
        continue
      }
      const lintReport = yield* decideEarsSpecQuality({
        docPath: doc.docPath,
        markdown: doc.markdown,
      })
      if (lintReport.requirements.length === 0) {
        continue
      }
      const clausesBySymbol = new Map<string, Array<EarsSemanticClause>>()
      for (const req of lintReport.requirements) {
        const sym = req.effectSymbol?.trim()
        if (!sym) continue

        const lowerReq = req.requirement.toLowerCase()
        const isDoubleNegativeAllow = /\bshall\s+not\s+(?:deny|fail|reject)\b/.test(lowerReq)
        const isNot = lowerReq.includes("shall not") && !isDoubleNegativeAllow
        const isFail =
          !isDoubleNegativeAllow &&
          (lowerReq.includes("shall fail") ||
            lowerReq.includes("fails with") ||
            lowerReq.includes("fail with") ||
            lowerReq.includes("shall return deny") ||
            lowerReq.includes("shall return escalate"))
        const failMatch = /fail(?:s)? with\s+`?([A-Za-z0-9_]+)`?/i.exec(req.requirement)
        const errorTag = failMatch?.[1] ?? (isFail ? "Failure" : "Success")

        const patternKind: EarsClausePatternKind = match(req.pattern)
          .with("Ubiquitous", () => EarsClausePatternKind.make("Ubiquitous"))
          .with("Event-driven", () => EarsClausePatternKind.make("Event-driven"))
          .with("State-driven", () => EarsClausePatternKind.make("State-driven"))
          .with("Unwanted behaviour", () => EarsClausePatternKind.make("Unwanted behaviour"))
          .with("Optional feature", () => EarsClausePatternKind.make("Optional feature"))
          .with("Complex", () => EarsClausePatternKind.make("Complex"))
          .otherwise(() => EarsClausePatternKind.make("Complex"))

        const rawPrefix = normalizeConditionPrefix(req.requirement)
        const hasExplicitPrecondition = /^(?:when|while|if|where)\b/i.test(rawPrefix)
        const baseGuardKey = hasExplicitPrecondition
          ? rawPrefix
          : lowerReq.replace(/[*_`]/g, "").trim()
        const effectiveGuardKey =
          isFail || isNot ? baseGuardKey : `${baseGuardKey}:${req.id || `REQ-${req.line}`}`

        const clause: EarsSemanticClause = {
          clauseId: EarsClauseId.make(req.id || `REQ-${req.line}`),
          pattern: patternKind,
          effectSymbol: EarsEffectSymbolName.make(sym),
          polarity: isNot
            ? EarsClausePolarity.make("shall_not")
            : EarsClausePolarity.make("shall"),
          outcomeTag: EarsOutcomeTag.make(isFail ? errorTag : "Success"),
          guardVariant: EarsVariantTag.make(
            effectiveGuardKey.length > 0 ? effectiveGuardKey : req.id || `REQ-${req.line}`,
          ),
          guardText: EarsGuardText.make(
            effectiveGuardKey.length > 0 ? effectiveGuardKey : req.requirement.slice(0, 100),
          ),
        }
        const existing = clausesBySymbol.get(sym) ?? []
        existing.push(clause)
        clausesBySymbol.set(sym, existing)
      }

      for (const [, symbolClauses] of clausesBySymbol) {
        if (symbolClauses.length < 2) continue
        const consistencyInput: EarsConsistencyInput = {
          specId: EarsSpecId.make(doc.id),
          filePath: EarsFilePath.make(doc.docPath),
          stateDomainVariants: [],
          guardDomainVariants: [],
          clauses: symbolClauses,
          requireExhaustiveStateCoverage: EarsConsistencyFlag.make(false),
        }
        const report = evaluateEarsConsistencyReport(consistencyInput)
        const blocking = report.violations.filter(
          (v) => v.ruleId === "EARS-01" || v.ruleId === "EARS-02",
        )
        if (blocking.length > 0) {
          return Option.some({
            exitCode: 1,
            stdout: "",
            stderr: `[GATE FAILURE] plan-check:ears-consistency\n${blocking.map((v) => `[${v.ruleId}] ${v.message}`).join("\n")}`,
          })
        }
      }
    }
    return Option.none()
  })

export const formatProjectionError = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<string, unknown>
    const tag = match(Reflect.get(rec, "_tag"))
      .with(P.string, (t) => t)
      .otherwise(() => undefined)
    const reason = typeof rec.reason === "string" ? rec.reason : undefined
    const msg = typeof rec.message === "string" ? rec.message : undefined
    if (tag !== undefined && reason !== undefined) {
      return msg !== undefined ? `${tag} (${reason}): ${msg}` : `${tag} (${reason})`
    }
    if (msg !== undefined) return msg
  }
  return String(err)
}

export const matchesExactSpecToken = (text: string, specId: string): boolean => {
  const escaped = specId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`).test(text)
}

export const persistVerifiedOverlays = (
  repoRoot: string,
  overlays: ReadonlyArray<ShadowFileOverlay>,
): Effect.Effect<{
  readonly ok: boolean
  readonly writtenFiles: ReadonlyArray<string>
  readonly rejectedFiles: ReadonlyArray<{ readonly file: string; readonly reason: string }>
  readonly error?: string | undefined
}> =>
  Effect.gen(function* () {
    const canonicalRoot = resolve(repoRoot)
    const realCanonicalRoot = nodeSyncHostIo.existsSync(canonicalRoot)
      ? nodeSyncHostIo.realpathSync(canonicalRoot)
      : canonicalRoot
    const rejectedFiles: Array<{ readonly file: string; readonly reason: string }> = []
    for (const overlay of overlays) {
      const absTarget = resolve(canonicalRoot, overlay.targetFile)
      if (!absTarget.startsWith(`${canonicalRoot}/`) || absTarget === canonicalRoot) {
        rejectedFiles.push({ file: overlay.targetFile, reason: "Target path escapes workspace root." })
        continue
      }
      if (nodeSyncHostIo.isSymbolicLinkSync(absTarget)) {
        rejectedFiles.push({
          file: overlay.targetFile,
          reason: "Target file is a symbolic link.",
        })
        continue
      }
      let checkDir = absTarget
      while (
        !nodeSyncHostIo.existsSync(checkDir) &&
        checkDir !== canonicalRoot &&
        dirname(checkDir) !== checkDir
      ) {
        checkDir = dirname(checkDir)
      }
      if (nodeSyncHostIo.existsSync(checkDir)) {
        const realExisting = nodeSyncHostIo.realpathSync(checkDir)
        const rel = relative(realCanonicalRoot, realExisting)
        if (rel.startsWith("..") || rel === "..") {
          rejectedFiles.push({
            file: overlay.targetFile,
            reason: "Target symlink escapes workspace root.",
          })
          continue
        }
      }
      const guardDecision = classifyFileWrite(overlay.targetFile)
      match(guardDecision.verdict)
        .with("allow", () => undefined)
        .with("deny", "ask", (verdict) => {
          rejectedFiles.push({
            file: overlay.targetFile,
            reason: `File write verdict is '${verdict}': ${guardDecision.reason}`,
          })
        })
        .exhaustive()
    }

    if (rejectedFiles.length > 0) {
      return {
        ok: false,
        writtenFiles: [],
        rejectedFiles,
        error: `Refusing to write ${rejectedFiles.length} protected or out-of-workspace file(s): ${rejectedFiles.map((r) => `${r.file} (${r.reason})`).join("; ")}`,
      }
    }

    const writtenFiles: Array<string> = []
    const writeExit = yield* Effect.exit(
      Effect.try({
        try: () => {
          for (const overlay of overlays) {
            const absTarget = resolve(canonicalRoot, overlay.targetFile)
            nodeSyncHostIo.mkdirRecursiveSync(dirname(absTarget))
            nodeSyncHostIo.writeTextSync(absTarget, overlay.content)
            writtenFiles.push(overlay.targetFile)
          }
        },
        catch: (fsErr) => (fsErr instanceof Error ? fsErr.message : String(fsErr)),
      }),
    )

    return match(writeExit)
      .with({ _tag: "Success" }, () => ({ ok: true, writtenFiles, rejectedFiles: [] }))
      .with({ _tag: "Failure" }, (f) => ({
        ok: false,
        writtenFiles,
        rejectedFiles: [],
        error: `Filesystem write failed: ${String(f.cause)}`,
      }))
      .exhaustive()
  })

export const finalizeProjectionCliResult = (params: {
  readonly repoRoot: string
  readonly shouldWrite: boolean
  readonly totalStepsApplied: number
  readonly patchCount: number
  readonly extraFields: Record<string, unknown>
  readonly projection: {
    readonly operations: ReadonlyArray<unknown>
    readonly overlays: ReadonlyArray<ShadowFileOverlay>
    readonly verificationStatus: unknown
    readonly roundTripVerified: boolean
    readonly compilerDiagnostics: ReadonlyArray<unknown>
    readonly bisectionProbes: unknown
    readonly skippedRuleIds: ReadonlyArray<string>
  }
}): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const { repoRoot, shouldWrite, totalStepsApplied, patchCount, extraFields, projection } = params
    if (projection.skippedRuleIds.length > 0) {
      const skipMsg = `Skipped ${projection.skippedRuleIds.length} patch(es) due to round-trip verification failure: ${projection.skippedRuleIds.join(", ")}`
      return {
        exitCode: 1,
        stdout: JSON.stringify(
          shouldWrite
            ? {
                ...extraFields,
                error: "Round-trip verification failed; aborting file write.",
                verificationStatus: projection.verificationStatus,
                roundTripVerified: false,
                compilerDiagnostics: projection.compilerDiagnostics,
                skippedRuleIds: projection.skippedRuleIds,
                written: false,
                writtenFiles: [],
              }
            : {
                ...extraFields,
                totalStepsApplied,
                patchCount,
                operationCount: projection.operations.length,
                overlayCount: projection.overlays.length,
                overlays: projection.overlays,
                operations: projection.operations,
                verificationStatus: projection.verificationStatus,
                roundTripVerified: projection.roundTripVerified,
                compilerDiagnostics: projection.compilerDiagnostics,
                bisectionProbes: projection.bisectionProbes,
                skippedRuleIds: projection.skippedRuleIds,
                written: false,
                writtenFiles: [],
              },
        ),
        stderr: skipMsg,
      }
    }

    if (shouldWrite && projection.verificationStatus !== "Verified") {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          ...extraFields,
          error: "Round-trip verification failed; aborting file write.",
          verificationStatus: projection.verificationStatus,
          roundTripVerified: false,
          compilerDiagnostics: projection.compilerDiagnostics,
          skippedRuleIds: projection.skippedRuleIds,
          written: false,
          writtenFiles: [],
        }),
        stderr: "Round-trip verification failed; aborting file write.",
      }
    }

    let writtenFiles: ReadonlyArray<string> = []
    if (shouldWrite) {
      if (projection.overlays.length === 0) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            ...extraFields,
            error: "No projected overlays to write.",
            written: false,
            writtenFiles: [],
          }),
          stderr: "No projected overlays to write.",
        }
      }
      const writeResult = yield* persistVerifiedOverlays(repoRoot, projection.overlays)
      if (!writeResult.ok) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            ...extraFields,
            error: writeResult.error,
            rejectedFiles: writeResult.rejectedFiles,
            written: false,
            writtenFiles: writeResult.writtenFiles,
          }),
          stderr: writeResult.error ?? "Failed to write overlays.",
        }
      }
      writtenFiles = writeResult.writtenFiles
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ...extraFields,
        totalStepsApplied,
        patchCount,
        operationCount: projection.operations.length,
        overlayCount: projection.overlays.length,
        overlays: projection.overlays,
        operations: projection.operations,
        verificationStatus: projection.verificationStatus,
        roundTripVerified: projection.roundTripVerified,
        compilerDiagnostics: projection.compilerDiagnostics,
        bisectionProbes: projection.bisectionProbes,
        skippedRuleIds: projection.skippedRuleIds,
        written: shouldWrite,
        writtenFiles,
      }),
      stderr: "",
    }
  })
