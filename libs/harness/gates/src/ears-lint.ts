import { Effect } from "effect"

export type EarsLintFindingKind =
  | "no-requirements-table"
  | "forbidden-column"
  | "id-format"
  | "duplicate-id"
  | "numbering-gap"
  | "area-structure"
  | "missing-modal"
  | "weak-modal"
  | "generic-subject"
  | "compound-obligation"
  | "pattern-keyword-mismatch"
  | "invalid-verification"
  | "unfilled-placeholder"
  | "legacy-effect-v3-symbol"
  | "defect-polarity-inversion"

export interface EarsLintFinding {
  readonly line: number
  readonly kind: EarsLintFindingKind
  readonly message: string
}

export interface EarsRequirementRow {
  readonly line: number
  readonly id: string
  readonly pattern: string
  readonly requirement: string
  readonly effectSymbol?: string | undefined
  readonly verification: string
}

export interface EarsSpecLintInput {
  readonly docPath: string
  readonly markdown: string
}

export interface EarsSpecLintReport {
  readonly docPath: string
  readonly clean: boolean
  readonly requirementCount: number
  readonly requirements: ReadonlyArray<EarsRequirementRow>
  readonly findings: ReadonlyArray<EarsLintFinding>
}

const ALLOWED_VERIFICATION_METHODS = new Set([
  "test",
  "unittest",
  "propertytest",
  "tracetest",
  "inspection",
  "astgate",
  "graphcheck",
  "analysis",
  "demonstration"
])

const FORBIDDEN_COLUMNS = new Set([
  "status",
  "state",
  "evidence",
  "proof",
  "done"
])

const stripMarkup = (text: string): string => text.replace(/[*_`]/g, "").trim()

const isTableRow = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.includes("|", 1)
}

const parseTableRow = (line: string): Array<string> => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return []
  const parts = trimmed.split("|")
  const sliceStart = 1
  const sliceEnd = parts[parts.length - 1] === "" ? parts.length - 1 : parts.length
  return parts.slice(sliceStart, sliceEnd).map((s) => s.trim())
}

interface TableContext {
  readonly headerLine: number
  readonly idCol: number
  readonly patternCol: number
  readonly reqCol: number
  readonly effectSymbolCol: number
  readonly verifCol: number
  seenSeparator: boolean
}

export const decideEarsSpecQuality = Effect.fn("EarsSpecLint.decide")(function* (
  input: EarsSpecLintInput
) {
  yield* Effect.void

  const findings: Array<EarsLintFinding> = []
  const requirements: Array<EarsRequirementRow> = []

  const rawLines = input.markdown.split(/\r?\n/)

  let frontmatterEndIdx = -1
  if (rawLines[0]?.trim() === "---") {
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i]?.trim() === "---") {
        frontmatterEndIdx = i
        break
      }
    }
  }

  const hasH2 = rawLines.some(
    (line, idx) =>
      idx > frontmatterEndIdx &&
      /^##\s+/.test(line)
  )

  let inRequirementsSection = !hasH2
  let currentAreaNumber: number | null = null
  let nextExpectedAreaNumber = 1
  let pendingSourceCheckForArea: number | null = null
  let pendingSourceCheckLine: number | null = null

  let insideCodeBlock = false
  let currentTable: TableContext | null = null
  let foundRequirementsTableCount = 0

  const seenIds = new Set<string>()
  const lastItemByGroup = new Map<number, number>()

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!
    const lineNum = i + 1

    if (i <= frontmatterEndIdx) {
      continue
    }

    if (/^\s*```/.test(rawLine)) {
      insideCodeBlock = !insideCodeBlock
      currentTable = null
      continue
    }

    if (insideCodeBlock) {
      continue
    }

    // 1. Unfilled placeholders
    const strippedBackticks = rawLine.replace(/`[^`]*`/g, "")
    if (
      strippedBackticks.includes("<!--") ||
      /<(?!!--)[^<>`\n]{1,60}>/.test(strippedBackticks)
    ) {
      findings.push({
        line: lineNum,
        kind: "unfilled-placeholder",
        message: `Line ${lineNum} contains unfilled placeholder or HTML comment.`
      })
    }

    // Check heading transitions
    if (/^##\s+Requirements\b/i.test(rawLine)) {
      inRequirementsSection = true
      currentAreaNumber = null
      if (pendingSourceCheckForArea !== null) {
        findings.push({
          line: pendingSourceCheckLine ?? lineNum,
          kind: "area-structure",
          message: `Area ${pendingSourceCheckForArea} must have '**Source' on the first non-empty line following its heading.`
        })
        pendingSourceCheckForArea = null
      }
      currentTable = null
      continue
    } else if (/^##\s+/.test(rawLine)) {
      inRequirementsSection = false
      currentAreaNumber = null
      if (pendingSourceCheckForArea !== null) {
        findings.push({
          line: pendingSourceCheckLine ?? lineNum,
          kind: "area-structure",
          message: `Area ${pendingSourceCheckForArea} must have '**Source' on the first non-empty line following its heading.`
        })
        pendingSourceCheckForArea = null
      }
      currentTable = null
      continue
    }

    // If waiting for **Source after ### <n> · <Title>
    if (pendingSourceCheckForArea !== null) {
      if (rawLine.trim().length > 0) {
        if (!rawLine.trim().startsWith("**Source")) {
          findings.push({
            line: lineNum,
            kind: "area-structure",
            message: `Area ${pendingSourceCheckForArea} must have '**Source' on the first non-empty line following its heading.`
          })
        }
        pendingSourceCheckForArea = null
      }
    }

    // Area headings under ## Requirements
    if (/^###\s+/.test(rawLine)) {
      currentTable = null
      if (inRequirementsSection) {
        const areaMatch = rawLine.match(/^### (\d+) · \S/)
        if (areaMatch) {
          const areaNum = parseInt(areaMatch[1]!, 10)
          if (areaNum !== nextExpectedAreaNumber) {
            findings.push({
              line: lineNum,
              kind: "area-structure",
              message: `Expected area number ${nextExpectedAreaNumber}, but got ${areaNum}.`
            })
          }
          nextExpectedAreaNumber = areaNum + 1
          currentAreaNumber = areaNum
          pendingSourceCheckForArea = areaNum
          pendingSourceCheckLine = lineNum
        } else {
          findings.push({
            line: lineNum,
            kind: "area-structure",
            message: `Area heading '${rawLine}' does not match format '### <n> · <Title>' with sequential numbering.`
          })
          currentAreaNumber = null
          pendingSourceCheckForArea = null
        }
      }
      continue
    }

    // Table parsing
    if (isTableRow(rawLine)) {
      const cells = parseTableRow(rawLine)
      const isSep = cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))

      if (currentTable === null) {
        if (!isSep && cells.length >= 2) {
          const cleanCols = cells.map((c) => stripMarkup(c).toLowerCase())
          const idCol = cleanCols.indexOf("id")
          const reqCol = cleanCols.indexOf("requirement")
          const patternCol = cleanCols.indexOf("pattern")
          const effectSymbolCol = cleanCols.findIndex(
            (c) => c === "effect symbol" || c === "effect_symbol" || c === "symbol"
          )
          const verifCol = cleanCols.indexOf("verification")

          if (idCol !== -1 && reqCol !== -1) {
            foundRequirementsTableCount++

            for (const col of cleanCols) {
              if (FORBIDDEN_COLUMNS.has(col)) {
                findings.push({
                  line: lineNum,
                  kind: "forbidden-column",
                  message: `Forbidden column '${col}' in requirements table.`
                })
              }
            }

            if (patternCol === -1) {
              findings.push({
                line: lineNum,
                kind: "pattern-keyword-mismatch",
                message: "Requirements table must contain a 'Pattern' column."
              })
            }

            if (verifCol === -1) {
              findings.push({
                line: lineNum,
                kind: "invalid-verification",
                message: "Requirements table must contain a 'Verification' column."
              })
            }

            currentTable = {
              headerLine: lineNum,
              idCol,
              patternCol,
              reqCol,
              effectSymbolCol,
              verifCol,
              seenSeparator: false
            }
          }
        }
      } else {
        if (!currentTable.seenSeparator) {
          if (isSep) {
            currentTable.seenSeparator = true
            continue
          } else {
            currentTable = null
          }
        } else {
          if (isSep) {
            continue
          }

          const rawId = currentTable.idCol < cells.length ? cells[currentTable.idCol]! : ""
          const rawPattern =
            currentTable.patternCol !== -1 && currentTable.patternCol < cells.length
              ? cells[currentTable.patternCol]!
              : ""
          const rawReq =
            currentTable.reqCol < cells.length ? cells[currentTable.reqCol]! : ""
          const rawEffectSymbol =
            currentTable.effectSymbolCol !== -1 && currentTable.effectSymbolCol < cells.length
              ? cells[currentTable.effectSymbolCol]
              : undefined
          const rawVerif =
            currentTable.verifCol !== -1 && currentTable.verifCol < cells.length
              ? cells[currentTable.verifCol]!
              : ""

          if (rawId.trim() === "" && rawReq.trim() === "") {
            continue
          }

          const cleanId = stripMarkup(rawId)
          const idMatch = cleanId.match(/^REQ-(\d+)\.(\d+)$/)

          if (!idMatch) {
            findings.push({
              line: lineNum,
              kind: "id-format",
              message: `Requirement ID '${rawId}' does not match format 'REQ-<group>.<item>' (e.g. REQ-1.1).`
            })
          } else {
            const group = parseInt(idMatch[1]!, 10)
            const item = parseInt(idMatch[2]!, 10)

            if (seenIds.has(cleanId)) {
              findings.push({
                line: lineNum,
                kind: "duplicate-id",
                message: `Duplicate requirement ID '${cleanId}'.`
              })
            } else {
              seenIds.add(cleanId)
            }

            if (currentAreaNumber !== null) {
              if (group !== currentAreaNumber) {
                findings.push({
                  line: lineNum,
                  kind: "area-structure",
                  message: `Requirement '${cleanId}' is inside area ${currentAreaNumber}, but group is ${group}.`
                })
              }
            } else if (inRequirementsSection) {
              findings.push({
                line: lineNum,
                kind: "area-structure",
                message: `Requirement '${cleanId}' must be placed under an area heading (### <n> · <Title>).`
              })
            }

            const expectedItem = (lastItemByGroup.get(group) ?? 0) + 1
            if (item !== expectedItem) {
              findings.push({
                line: lineNum,
                kind: "numbering-gap",
                message: `Requirement ID '${cleanId}' has a numbering gap: expected item ${expectedItem}, got ${item}.`
              })
            }
            lastItemByGroup.set(group, item)
          }

          const plain = stripMarkup(rawReq).toLowerCase()
          const normalizedPlain = plain.replace(/\s+/g, " ")

          // Modal check
          const hasShall = /\bshall\b/.test(plain)
          if (!hasShall) {
            const hasWeakModal = /\b(must|should|will|needs to|has to)\b/.test(plain)
            if (hasWeakModal) {
              findings.push({
                line: lineNum,
                kind: "weak-modal",
                message: `${cleanId} uses weak modal instead of 'shall' or 'shall not'.`
              })
            } else {
              findings.push({
                line: lineNum,
                kind: "missing-modal",
                message: `${cleanId} is missing mandatory modal 'shall' or 'shall not'.`
              })
            }
          }

          // Generic subject
          if (
            normalizedPlain.includes("the system shall") ||
            normalizedPlain.includes("the system must")
          ) {
            findings.push({
              line: lineNum,
              kind: "generic-subject",
              message: `${cleanId} uses generic subject 'the system shall' — name the specific Effect service, use-case, or decider.`
            })
          }

          // Compound obligation
          if (
            normalizedPlain.includes(" and shall ") ||
            normalizedPlain.includes(" and shall not ") ||
            normalizedPlain.includes(" and must ")
          ) {
            findings.push({
              line: lineNum,
              kind: "compound-obligation",
              message: `${cleanId} joins two obligations with 'and shall' — split into separate REQ rows if they can fail independently, or drop negative restatements.`
            })
          }

          // Defect safety polarity check
          if (
            /\b(?:fail|fails|thenfails)\b/.test(normalizedPlain) &&
            /\bwithout\s+(?:dying|throwing)\b.*\bdefect/.test(normalizedPlain)
          ) {
            findings.push({
              line: lineNum,
              kind: "defect-polarity-inversion",
              message: `${cleanId} inverts defect safety polarity ('without dying on ... defects'): in Effect-TS test harnesses, unexpected defects MUST die/fail the assertion rather than being ignored.`
            })
          }

          // Removed Effect v3 terminology check
          const legacyV3Regex = /\b(?:ParseError|ParseResult|Context\.Tag|Effect\.Service)\b/
          const isMetaV3DetectionRule =
            /\bEffect\s+v3\b/i.test(rawReq) || /\bhas no exported member\b/i.test(rawReq)
          if (
            !isMetaV3DetectionRule &&
            (legacyV3Regex.test(rawReq) || legacyV3Regex.test(stripMarkup(rawReq)))
          ) {
            findings.push({
              line: lineNum,
              kind: "legacy-effect-v3-symbol",
              message: `Requirement ${cleanId} references legacy Effect v3 symbol (use Effect v4 Schema.SchemaError / Context.Service instead).`
            })
          }

          // Pattern-keyword agreement
          const cleanPattern = stripMarkup(rawPattern).toLowerCase()
          switch (cleanPattern) {
            case "ubiquitous": {
              const trimmedReq = normalizedPlain.trimStart()
              if (/^(when|while|if|where)\b/.test(trimmedReq)) {
                findings.push({
                  line: lineNum,
                  kind: "pattern-keyword-mismatch",
                  message: `${cleanId} is declared as Ubiquitous but starts with conditional keyword (${trimmedReq.split(" ")[0]}).`
                })
              }
              break
            }
            case "event-driven": {
              if (!/\bwhen\b/.test(normalizedPlain)) {
                findings.push({
                  line: lineNum,
                  kind: "pattern-keyword-mismatch",
                  message: `${cleanId} is declared as Event-driven but does not contain keyword 'when'.`
                })
              }
              break
            }
            case "state-driven": {
              if (!/\bwhile\b/.test(normalizedPlain)) {
                findings.push({
                  line: lineNum,
                  kind: "pattern-keyword-mismatch",
                  message: `${cleanId} is declared as State-driven but does not contain keyword 'while'.`
                })
              }
              break
            }
            case "unwanted behaviour":
            case "unwanted behavior": {
              if (!/\bif\b/.test(normalizedPlain) || !/\bthen\b/.test(normalizedPlain)) {
                findings.push({
                  line: lineNum,
                  kind: "pattern-keyword-mismatch",
                  message: `${cleanId} is declared as Unwanted behaviour but does not contain both 'if' and 'then'.`
                })
              }
              break
            }
            case "optional feature": {
              if (!/\bwhere\b/.test(normalizedPlain)) {
                findings.push({
                  line: lineNum,
                  kind: "pattern-keyword-mismatch",
                  message: `${cleanId} is declared as Optional feature but does not contain keyword 'where'.`
                })
              }
              break
            }
            default: {
              findings.push({
                line: lineNum,
                kind: "pattern-keyword-mismatch",
                message: `${cleanId} has unknown EARS pattern '${rawPattern}'. Allowed: Ubiquitous, Event-driven, State-driven, Unwanted behaviour, Optional feature.`
              })
              break
            }
          }

          // Verification method
          const cleanVerif = stripMarkup(rawVerif).toLowerCase()
          const verifTokens = cleanVerif
            .split(/[/,]/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0)

          if (verifTokens.length === 0) {
            findings.push({
              line: lineNum,
              kind: "invalid-verification",
              message: `${cleanId} has missing verification method.`
            })
          } else {
            for (const token of verifTokens) {
              if (!ALLOWED_VERIFICATION_METHODS.has(token)) {
                findings.push({
                  line: lineNum,
                  kind: "invalid-verification",
                  message: `${cleanId} has invalid verification method '${token}'. Allowed: test, unittest, propertytest, tracetest, inspection, astgate, graphcheck, analysis, demonstration.`
                })
              }
            }
          }

          requirements.push({
            line: lineNum,
            id: cleanId,
            pattern: rawPattern.trim(),
            requirement: rawReq.trim(),
            effectSymbol: rawEffectSymbol ? rawEffectSymbol.trim() || undefined : undefined,
            verification: rawVerif.trim()
          })
        }
      }
    } else {
      currentTable = null
    }
  }

  if (pendingSourceCheckForArea !== null) {
    findings.push({
      line: pendingSourceCheckLine ?? rawLines.length,
      kind: "area-structure",
      message: `Area ${pendingSourceCheckForArea} must have '**Source' on the first non-empty line following its heading.`
    })
  }

  if (foundRequirementsTableCount === 0) {
    findings.push({
      line: 1,
      kind: "no-requirements-table",
      message: "No EARS requirements table with ID and Requirement columns found."
    })
  }

  return {
    docPath: input.docPath,
    clean: findings.length === 0,
    requirementCount: requirements.length,
    requirements,
    findings
  } satisfies EarsSpecLintReport
})

export const lintEarsSpecMarkdown = (
  docPath: string,
  markdown: string
): EarsSpecLintReport => Effect.runSync(decideEarsSpecQuality({ docPath, markdown }))
