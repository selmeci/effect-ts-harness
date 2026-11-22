export type AdrLintFindingKind =
  | "adr-frontmatter-invalid"
  | "adr-section-structure"
  | "adr-missing-drivers-or-options"
  | "adr-missing-chosen-option"
  | "adr-rejected-alternative-structure"
  | "adr-missing-enforcement-table"
  | "adr-unfilled-placeholder"
  | "adr-enforcement-mismatch"
  | "adr-overstated-proof-claim"

export interface AdrLintFinding {
  readonly line: number
  readonly kind: AdrLintFindingKind
  readonly message: string
}

export const EXPECTED_ENFORCEMENT_TABLE_COLS = [
  "rule",
  "enforced by",
  "gate / mechanism",
  "governed symbols",
] as const

export const ADR_ENFORCED_FILE_EXT_RE = /\.(?:ts|tsx|js|mjs|md|json|cedar|pg|gq|yaml|yml|sql)$/

export const stripTableMarkup = (text: string): string => text.replace(/[*_`]/g, "").trim()

export const isMarkdownTableRow = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.includes("|", 1)
}

export const parseMarkdownTableRow = (line: string): Array<string> => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return []
  const cells: Array<string> = []
  let current = ""
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "\\|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (!trimmed.endsWith("|") || trimmed.endsWith("\\|") || tail.length > 0) {
    cells.push(tail)
  }
  return cells
}

const isCellEmptyOrPlaceholder = (cell: string | undefined): boolean => {
  if (cell === undefined) return true
  const clean = stripTableMarkup(cell).trim().toLowerCase()
  return (
    clean === "" ||
    clean === "-" ||
    clean === "n/a" ||
    clean === "na" ||
    clean === "none" ||
    clean === "tbd"
  )
}

export const extractEnforcedFilePathsFromCell = (enforcedByCell: string): ReadonlyArray<string> => {
  const extractedPaths: Array<string> = []
  const backticks = Array.from(enforcedByCell.matchAll(/`([^`]+)`/g)).map((m) => m[1]!.trim())
  for (const b of backticks) {
    if (b.includes("/") && ADR_ENFORCED_FILE_EXT_RE.test(b) && !extractedPaths.includes(b)) {
      extractedPaths.push(b)
    }
  }
  const tokens = enforcedByCell.replace(/`([^`]+)`/g, " $1 ").split(/[,\s]+/)
  for (const t of tokens) {
    const trimmed = t.trim()
    if (
      trimmed.includes("/") &&
      ADR_ENFORCED_FILE_EXT_RE.test(trimmed) &&
      !extractedPaths.includes(trimmed)
    ) {
      extractedPaths.push(trimmed)
    }
  }
  return extractedPaths
}

export interface ValidateAdrEnforcementTableInput {
  readonly rawLines: ReadonlyArray<string>
  readonly isCodeBlock: ReadonlyArray<boolean>
  readonly detEnforcementLine: number
  readonly detEnforcementIdx: number
  readonly detEndIdx: number
  readonly declaredEnforcedBy: ReadonlySet<string>
  readonly declaredSymbols: ReadonlySet<string>
  readonly findings: Array<AdrLintFinding>
}

/** Validates `### Deterministic Enforcement` rows bidirectionally against ADR frontmatter. */
export const validateAdrDeterministicEnforcementTable = (
  input: ValidateAdrEnforcementTableInput,
): void => {
  const {
    rawLines,
    isCodeBlock,
    detEnforcementLine,
    detEnforcementIdx,
    detEndIdx,
    declaredEnforcedBy,
    declaredSymbols,
    findings,
  } = input

  let validTableFound = false
  const tableReferencedFiles = new Set<string>()

  for (let i = detEnforcementIdx + 1; i < detEndIdx; i++) {
    if (isCodeBlock[i]) continue
    const line = rawLines[i]!
    if (!isMarkdownTableRow(line)) continue

    const cells = parseMarkdownTableRow(line)
    const cleanCols = cells.map((c) => stripTableMarkup(c).toLowerCase())
    const matchesHeader =
      cleanCols.length === EXPECTED_ENFORCEMENT_TABLE_COLS.length &&
      cleanCols.every((col, cIdx) => col === EXPECTED_ENFORCEMENT_TABLE_COLS[cIdx])
    if (!matchesHeader) continue

    let sepIdx = i + 1
    while (sepIdx < detEndIdx && !isCodeBlock[sepIdx] && rawLines[sepIdx]!.trim() === "") {
      sepIdx++
    }
    if (sepIdx >= detEndIdx || isCodeBlock[sepIdx]) continue
    const sepCells = parseMarkdownTableRow(rawLines[sepIdx]!)
    if (sepCells.length === 0 || !sepCells.every((c) => /^:?-+:?$/.test(c))) continue

    let dataRowCount = 0
    for (let r = sepIdx + 1; r < detEndIdx; r++) {
      if (isCodeBlock[r]) break
      const rowLine = rawLines[r]!
      if (!isMarkdownTableRow(rowLine)) {
        if (rowLine.trim() === "") continue
        break
      }
      const rowCells = parseMarkdownTableRow(rowLine)
      if (!rowCells.some((c) => c.length > 0) || rowCells.every((c) => /^:?-+:?$/.test(c))) {
        continue
      }

      dataRowCount++
      const lineNum = r + 1
      const ruleCell = rowCells[0]
      const enforcedByCell = rowCells[1]
      const gateCell = rowCells[2]
      const governedSymbolsCell = rowCells[3]

      if (
        rowCells.length < 4 ||
        isCellEmptyOrPlaceholder(ruleCell) ||
        isCellEmptyOrPlaceholder(enforcedByCell) ||
        isCellEmptyOrPlaceholder(gateCell) ||
        isCellEmptyOrPlaceholder(governedSymbolsCell)
      ) {
        findings.push({
          line: lineNum,
          kind: "adr-enforcement-mismatch",
          message: `Row at line ${lineNum} in 'Deterministic Enforcement' table contains empty or placeholder cell.`,
        })
      }

      if (enforcedByCell) {
        for (const p of extractEnforcedFilePathsFromCell(enforcedByCell)) {
          tableReferencedFiles.add(p)
          if (declaredEnforcedBy.size > 0 && !declaredEnforcedBy.has(p)) {
            findings.push({
              line: lineNum,
              kind: "adr-enforcement-mismatch",
              message: `Enforced By file '${p}' at line ${lineNum} is not declared in ADR frontmatter 'enforced_by'.`,
            })
          }
        }
      }

      if (declaredSymbols.size > 0 && governedSymbolsCell) {
        const backtickMatches = Array.from(governedSymbolsCell.matchAll(/`([^`]+)`/g)).map((m) =>
          m[1]!.trim(),
        )
        for (const sym of backtickMatches) {
          if (sym === "*" || sym.includes("/") || sym.includes(".ts")) continue
          const matches =
            declaredSymbols.has(sym) ||
            Array.from(declaredSymbols).some(
              (ds) => ds.endsWith(`#${sym}`) || sym.endsWith(`#${ds}`),
            )
          if (!matches) {
            findings.push({
              line: lineNum,
              kind: "adr-enforcement-mismatch",
              message: `Governed symbol '${sym}' at line ${lineNum} is not declared in ADR frontmatter spans, services, or errors.`,
            })
          }
        }
      }
    }

    if (dataRowCount >= 1) {
      validTableFound = true
      break
    }
  }

  if (!validTableFound) {
    findings.push({
      line: detEnforcementLine,
      kind: "adr-missing-enforcement-table",
      message:
        "Subsection '### Deterministic Enforcement' must contain a table with columns ['Rule', 'Enforced By', 'Gate / Mechanism', 'Governed Symbols'] and at least 1 data row.",
    })
    return
  }

  for (const declaredPath of declaredEnforcedBy) {
    if (!tableReferencedFiles.has(declaredPath)) {
      findings.push({
        line: detEnforcementLine,
        kind: "adr-enforcement-mismatch",
        message: `ADR frontmatter 'enforced_by' file '${declaredPath}' is missing from 'Deterministic Enforcement' table.`,
      })
    }
  }
}
