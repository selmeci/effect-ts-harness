/**
 * Governance Documents & Architectural Invariants Gate Plugin.
 *
 * Verifies references in ADRs and EARS specifications, clause consistency,
 * MADR structure, and ArchiMate ontology invariants.
 *
 * Rules owned:
 * - stale-doc-reference: Flags missing enforced_by files, unknown spans/services/errors,
 *   unreferenced enforcement table mechanisms, and invalid/missing YAML frontmatter.
 * - ears-spec-lint: Validates EARS clause syntax and cross-clause consistency.
 * - adr-doc-lint: Validates MADR structural compliance and enforcement table rules.
 * - ontology-invariant: Validates ArchiMate architectural layers and relation invariants.
 */
import { Effect } from "effect"
import { match } from "ts-pattern"
import * as Graph from "effect/Graph"
import {
  findClosestMatch,
  parseGovernanceDocFrontmatter,
  type GcFinding,
  type GovernanceDocReference,
  type GraphEntropyInput,
  type GraphReachabilityContext,
} from "./gc-helpers.js"
import { decideEarsSpecQuality } from "../../ears-lint.js"
import {
  decideEarsConsistency,
  EarsClauseId,
  EarsClausePatternKind,
  EarsClausePolarity,
  EarsConsistencyFlag,
  type EarsConsistencyInput,
  EarsEffectSymbolName,
  EarsFilePath,
  EarsGuardText,
  EarsOutcomeTag,
  EarsSpecId,
  EarsVariantTag,
  type EarsSemanticClause,
} from "../../ears-consistency.js"
import { decideAdrDocQuality } from "../../adr-lint.js"
import { decideOntologyInvariants, normalizeConditionPrefix } from "../../ontology-invariants.js"

export const evaluateGovernanceDocsPlugin = (
  input: GraphEntropyInput,
  _ctx: GraphReachabilityContext,
): Effect.Effect<ReadonlyArray<GcFinding>> =>
  Effect.gen(function* () {
    const g = input.graph.graph
    const findings: Array<GcFinding> = []

    // Rule: stale-doc-reference
    const docRefs: Array<GovernanceDocReference> = []
    const seenDocIds = new Set<string>()
    if (input.governanceDocs !== undefined && input.governanceDocs.length > 0) {
      for (const doc of input.governanceDocs) {
        docRefs.push(doc); seenDocIds.add(doc.id)
      }
    }

    for (const [, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => {
          if (!seenDocIds.has(n.id)) {
            seenDocIds.add(n.id)
            docRefs.push({
              docPath: n.path, id: n.id, status: n.status,
              enforcedByFiles: n.enforcedByFiles, referencedSpans: n.referencedSpans,
              referencedServices: n.referencedServices, referencedErrors: n.referencedErrors,
            })
          }
        })
        .with(
          { _tag: "EffectFn" },
          { _tag: "ServiceTag" },
          { _tag: "TaggedError" },
          { _tag: "PatternDoc" },
          { _tag: "SchemaDef" },
          { _tag: "ServiceLayer" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          { _tag: "VitestCase" },
          () => {},
        )
        .exhaustive()
    }

    if (docRefs.length > 0) {
      const knownSpans = new Set<string>(), knownServices = new Set<string>(), knownErrors = new Set<string>()
      for (const [, node] of Graph.nodes(g)) {
        match(node)
          .with({ _tag: "EffectFn" }, (n) => {
            knownSpans.add(n.spanName)
            knownSpans.add(n.qualname)
          })
          .with({ _tag: "ServiceTag" }, (n) => {
            knownServices.add(n.tagId)
            knownServices.add(n.name)
          })
          .with({ _tag: "TaggedError" }, (n) => {
            knownErrors.add(n.errorTag)
          })
          .with(
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "PatternDoc" },
            { _tag: "SchemaDef" },
            { _tag: "ServiceLayer" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            { _tag: "VitestCase" },
            () => {},
          )
          .exhaustive()
      }

      for (const doc of docRefs) {
        if (
          doc.id.trim().length === 0 ||
          (doc.markdown !== undefined && parseGovernanceDocFrontmatter(doc.docPath, doc.markdown) === null)
        ) {
          findings.push({
            kind: "stale-doc-reference",
            nodeId: doc.id || doc.docPath,
            location: doc.docPath,
            message: `Governance document "${doc.docPath}" has missing or unparseable YAML frontmatter.`,
            action: `Add valid YAML frontmatter (id, title, status) to "${doc.docPath}".`,
          })
          continue
        }

        const isAccepted = match(doc.status)
          .with("accepted", () => true)
          .with("proposed", "superseded", "deprecated", () => false)
          .exhaustive()
        if (!isAccepted) continue

        if (doc.enforcedByFiles !== undefined && doc.existingFiles !== undefined) {
          const existingSet = new Set(doc.existingFiles)
          for (const file of doc.enforcedByFiles) {
            if (!existingSet.has(file)) {
              findings.push({
                kind: "stale-doc-reference", nodeId: `${doc.id}:${file}`, location: doc.docPath,
                message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent enforced_by file "${file}".`,
                action: `Create file "${file}" or update enforced_by in "${doc.docPath}".`,
              })
            }
          }
        }

        for (const span of doc.referencedSpans ?? []) {
          if (!knownSpans.has(span)) {
            const closest = findClosestMatch(span, knownSpans)
            findings.push({
              kind: "stale-doc-reference", nodeId: `${doc.id}:${span}`, location: doc.docPath,
              message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent EffectFn span "${span}".${closest ? ` Did you mean "${closest}"?` : ""}`,
              action: closest ? `Update reference in "${doc.docPath}" to "${closest}" or declare Effect.fn("${span}").` : `Declare Effect.fn("${span}") in domain/service code or update doc frontmatter.`,
            })
          }
        }

        for (const svc of doc.referencedServices ?? []) {
          if (!knownServices.has(svc)) {
            const closest = findClosestMatch(svc, knownServices)
            findings.push({
              kind: "stale-doc-reference", nodeId: `${doc.id}:${svc}`, location: doc.docPath,
              message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent ServiceTag "${svc}".${closest ? ` Did you mean "${closest}"?` : ""}`,
              action: closest ? `Update reference in "${doc.docPath}" to "${closest}" or declare ServiceTag "${svc}".` : `Declare ServiceTag "${svc}" in domain/service code or update doc frontmatter.`,
            })
          }
        }

        for (const err of doc.referencedErrors ?? []) {
          if (!knownErrors.has(err)) {
            const closest = findClosestMatch(err, knownErrors)
            findings.push({
              kind: "stale-doc-reference", nodeId: `${doc.id}:${err}`, location: doc.docPath,
              message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent TaggedError "${err}".${closest ? ` Did you mean "${closest}"?` : ""}`,
              action: closest ? `Update reference in "${doc.docPath}" to "${closest}" or declare TaggedError "${err}".` : `Declare TaggedError "${err}" in contract/domain code or update doc frontmatter.`,
            })
          }
        }

        if (doc.markdown !== undefined) {
          const mermaidRegex = /```mermaid([\s\S]*?)```/g
          const ignoredMermaidErrors = new Set([
            "Error", "TypeError", "RangeError", "SyntaxError", "TaggedError", "SchemaError",
            "UnknownToolError", "OmnigraphLoadError",
          ])
          const seenDocMermaidErrors = new Set<string>()
          let mermaidMatch: RegExpExecArray | null
          while ((mermaidMatch = mermaidRegex.exec(doc.markdown)) !== null) {
            const block = mermaidMatch[1] ?? ""
            const errRegex = /\b([A-Z][A-Za-z0-9_]*Error)\b/g
            let errMatch: RegExpExecArray | null
            while ((errMatch = errRegex.exec(block)) !== null) {
              const errName = errMatch[1]!
              if (!ignoredMermaidErrors.has(errName) && !seenDocMermaidErrors.has(errName)) {
                seenDocMermaidErrors.add(errName)
                if (!knownErrors.has(errName)) {
                  const closest = findClosestMatch(errName, knownErrors)
                  findings.push({
                    kind: "stale-doc-reference", nodeId: `${doc.id}:${errName}`, location: doc.docPath,
                    message: `Governance doc "${doc.docPath}" (${doc.id}) references non-existent TaggedError "${errName}" in a Mermaid diagram.${closest ? ` Did you mean "${closest}"?` : ""}`,
                    action: closest ? `Update Mermaid diagram in "${doc.docPath}" to reference "${closest}" or declare TaggedError "${errName}".` : `Declare TaggedError "${errName}" in contract/domain code or remove from Mermaid diagram.`,
                  })
                }
              }
            }
          }

          const detEnfMatch = doc.markdown.match(/###\s+Deterministic Enforcement([\s\S]*?)(?:\n##|\n#|$)/)
          if (detEnfMatch && detEnfMatch[1]) {
            const tableLines = detEnfMatch[1].split(/\r?\n/)
            let seenSep = false
            for (const line of tableLines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith("|")) continue
              const parts = trimmed.split("|").slice(1, -1).map((p) => p.trim())
              if (parts.length < 3) continue
              if (parts.every((p) => /^:?-+:?$/.test(p))) { seenSep = true; continue }
              if (seenSep) {
                const enforcedByCol = parts[1] ?? "", gateMechCol = parts[2] ?? ""
                const col1Paths: Array<string> = []
                for (const b of Array.from(enforcedByCol.matchAll(/`([^`]+)`/g)).map((m) => m[1]!.trim())) {
                  if (b.includes("/") && /\.(?:ts|tsx|js|mjs|md|json|cedar)$/.test(b) && !col1Paths.includes(b)) col1Paths.push(b)
                }
                for (const t of enforcedByCol.replace(/`([^`]+)`/g, " $1 ").split(/[,\s]+/)) {
                  const tr = t.trim()
                  if (tr.includes("/") && /\.(?:ts|tsx|js|mjs|md|json|cedar)$/.test(tr) && !col1Paths.includes(tr)) col1Paths.push(tr)
                }
                const gateBackticks = Array.from(gateMechCol.matchAll(/`([^`]+)`/g)).map((m) => m[1]!.trim())
                const genericWords = new Set(["vitest", "oxlint", "tsc", "nx", "cedar"])
                const existingCol1Paths = col1Paths.filter((p) => doc.existingFiles === undefined || doc.existingFiles.includes(p))

                if (
                  existingCol1Paths.length > 0 &&
                  doc.enforcedByFileContents !== undefined &&
                  existingCol1Paths.every((p) => doc.enforcedByFileContents?.[p] !== undefined)
                ) {
                  for (const mech of gateBackticks) {
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(mech) || genericWords.has(mech.toLowerCase())) continue
                    const found = existingCol1Paths.some((p) => doc.enforcedByFileContents?.[p]?.includes(mech))
                    if (!found) {
                      findings.push({
                        kind: "stale-doc-reference", nodeId: `${doc.id}:${mech}`, location: doc.docPath,
                        message: `Governance doc "${doc.docPath}" (${doc.id}) enforcement table attributes "${mech}" to "${enforcedByCol}", but none of those files define or reference "${mech}".`,
                        action: `Update "${doc.docPath}" enforcement table or implement "${mech}" in "${enforcedByCol}".`,
                      })
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Rule: ears-spec-lint
    for (const doc of input.governanceDocs ?? []) {
      if (doc.markdown !== undefined && (doc.docPath.includes("/specs/") || doc.id.includes(":SPEC-"))) {
        const lintReport = yield* decideEarsSpecQuality({ docPath: doc.docPath, markdown: doc.markdown })
        for (const f of lintReport.findings) {
          findings.push({
            kind: "ears-spec-lint", nodeId: doc.id, location: `${doc.docPath}:${f.line}`,
            message: `EARS spec "${doc.id}" (${doc.docPath}:${f.line}) [${f.kind}]: ${f.message}`,
            action: `Fix EARS clause syntax at ${doc.docPath}:${f.line} to conform to specifying-ears-with-effect requirements.`,
          })
        }

        if (lintReport.requirements.length > 0) {
          const clausesBySymbol = new Map<string, Array<EarsSemanticClause>>()
          for (const req of lintReport.requirements) {
            const sym = req.effectSymbol?.trim()
            if (!sym) continue
            const lowerReq = req.requirement.toLowerCase()
            const isDoubleNegativeAllow = /\bshall\s+not\s+(?:deny|fail|reject)\b/.test(lowerReq)
            const isNot = lowerReq.includes("shall not") && !isDoubleNegativeAllow
            const isFail = !isDoubleNegativeAllow && (
              lowerReq.includes("shall fail") || lowerReq.includes("fails with") ||
              lowerReq.includes("fail with") || lowerReq.includes("shall return deny") || lowerReq.includes("shall return escalate")
            )
            const cleanReq = req.requirement.replace(/[*_`]/g, "")
            const failMatch = /fail(?:s)? with\s+`?([A-Za-z0-9_]+)`?/i.exec(cleanReq)
            const errorTag = failMatch?.[1] ?? (isFail ? "Failure" : "Success")
            const outcomeTag = isFail ? errorTag : "Success"

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
            const baseGuardKey = hasExplicitPrecondition ? rawPrefix : lowerReq.replace(/[*_`]/g, "").trim()
            const effectiveGuardKey = isFail || isNot ? baseGuardKey : `${baseGuardKey}:${req.id || `REQ-${req.line}`}`

            const clause: EarsSemanticClause = {
              clauseId: EarsClauseId.make(req.id || `REQ-${req.line}`),
              pattern: patternKind,
              effectSymbol: EarsEffectSymbolName.make(sym),
              polarity: isNot ? EarsClausePolarity.make("shall_not") : EarsClausePolarity.make("shall"),
              outcomeTag: EarsOutcomeTag.make(outcomeTag),
              guardVariant: EarsVariantTag.make(effectiveGuardKey.length > 0 ? effectiveGuardKey : req.id || `REQ-${req.line}`),
              guardText: EarsGuardText.make(effectiveGuardKey.length > 0 ? effectiveGuardKey : req.requirement.slice(0, 100)),
            }
            const existing = clausesBySymbol.get(sym) ?? []
            existing.push(clause)
            clausesBySymbol.set(sym, existing)
          }

          for (const [sym, symbolClauses] of clausesBySymbol) {
            if (symbolClauses.length >= 2) {
              const consistencyInput: EarsConsistencyInput = {
                specId: EarsSpecId.make(doc.id), filePath: EarsFilePath.make(doc.docPath),
                stateDomainVariants: [], guardDomainVariants: [], clauses: symbolClauses,
                requireExhaustiveStateCoverage: EarsConsistencyFlag.make(false),
              }
              const report = yield* decideEarsConsistency(consistencyInput).pipe(
                Effect.catchTag("EarsConsistencyError", (err) => Effect.succeed({ violations: err.violations })),
              )
              for (const v of report.violations) {
                if (v.ruleId === "EARS-01" || v.ruleId === "EARS-02") {
                  findings.push({
                    kind: "ears-spec-lint", nodeId: doc.id, location: `${doc.docPath}`,
                    message: `EARS spec "${doc.id}" (${doc.docPath}) [${v.kind}]: ${v.message}`,
                    action: `Resolve EARS clause consistency violation (${v.ruleId}) in ${doc.docPath} for symbol ${sym}.`,
                  })
                }
              }
            }
          }
        }
      }
    }

    // Rule: adr-doc-lint
    for (const doc of input.governanceDocs ?? []) {
      if (doc.markdown !== undefined && (doc.docPath.includes("/adr/") || doc.id.includes(":ADR-") || doc.id.startsWith("ADR-"))) {
        const adrLint = yield* decideAdrDocQuality({ docPath: doc.docPath, markdown: doc.markdown })
        for (const f of adrLint.findings) {
          findings.push({
            kind: "adr-doc-lint", nodeId: doc.id, location: `${doc.docPath}:${f.line}`,
            message: `ADR doc "${doc.id}" (${doc.docPath}:${f.line}) [${f.kind}]: ${f.message}`,
            action: `Update ${doc.docPath}:${f.line} to satisfy MADR 6-section structure and enforcement table rules.`,
          })
        }
      }
    }

    // Rule: ontology-invariant
    const ontologyReport = yield* decideOntologyInvariants({
      graph: input.graph, governanceDocs: input.governanceDocs,
    })
    for (const f of ontologyReport.findings) {
      findings.push({
        kind: "ontology-invariant", nodeId: f.nodeId, location: f.nodeId,
        message: `[${f.kind}] ${f.message}`,
        action: `Align ArchiMate layer invariants or governance doc references for ${f.nodeId}.`,
      })
    }

    return findings
  })
