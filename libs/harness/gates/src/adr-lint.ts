import { Effect } from "effect"

export type AdrLintFindingKind =
  | "adr-frontmatter-invalid"
  | "adr-section-structure"
  | "adr-missing-drivers-or-options"
  | "adr-missing-chosen-option"
  | "adr-rejected-alternative-structure"
  | "adr-missing-enforcement-table"
  | "adr-unfilled-placeholder"
  | "adr-enforcement-mismatch"

export interface AdrLintFinding {
  readonly line: number
  readonly kind: AdrLintFindingKind
  readonly message: string
}

export interface AdrDocLintInput {
  readonly docPath: string
  readonly markdown: string
}

export interface AdrDocLintReport {
  readonly docPath: string
  readonly clean: boolean
  readonly findings: ReadonlyArray<AdrLintFinding>
}

export const CANONICAL_ADR_SECTIONS = [
  "Context and Problem Statement",
  "Decision Drivers",
  "Considered Options",
  "Decision Outcome",
  "Rejected Alternatives",
  "Consequences and Enforcement"
] as const

const EXPECTED_ENFORCEMENT_TABLE_COLS = [
  "rule",
  "enforced by",
  "gate / mechanism",
  "governed symbols"
] as const

const stripMarkup = (text: string): string => text.replace(/[*_`]/g, "").trim()

const stripQuotes = (val: string): string => {
  let trimmed = val.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  const hashIdx = trimmed.indexOf("#")
  if (hashIdx !== -1) {
    trimmed = trimmed.slice(0, hashIdx).trim()
  }
  return trimmed
}

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

interface ParsedFrontmatter {
  readonly scalars: Map<string, string>
  readonly lists: Map<string, Array<string>>
  readonly endLineIdx: number
}

const parseFrontmatter = (
  rawLines: ReadonlyArray<string>
): ParsedFrontmatter | null => {
  if (rawLines[0]?.trim() !== "---") {
    return null
  }

  let endLineIdx = -1
  for (let i = 1; i < rawLines.length; i++) {
    if (rawLines[i]?.trim() === "---") {
      endLineIdx = i
      break
    }
  }

  if (endLineIdx === -1) {
    return null
  }

  const scalars = new Map<string, string>()
  const lists = new Map<string, Array<string>>()
  let currentListKey: string | null = null

  for (let i = 1; i < endLineIdx; i++) {
    const rawLine = rawLines[i]!
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const listItemMatch = rawLine.match(/^\s*-\s*(.*)$/)
    if (listItemMatch && currentListKey !== null) {
      const item = stripQuotes(listItemMatch[1] ?? "")
      if (item.length > 0) {
        const list = lists.get(currentListKey)
        if (list) {
          list.push(item)
        }
      }
      continue
    }

    currentListKey = null

    const keyValMatch = rawLine.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/)
    if (keyValMatch) {
      const key = keyValMatch[1]!.trim()
      const rest = keyValMatch[2]!.trim()

      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim()
        const items =
          inner.length === 0
            ? []
            : inner
                .split(",")
                .map(stripQuotes)
                .filter((s) => s.length > 0)
        lists.set(key, items)
      } else if (rest === "") {
        lists.set(key, [])
        currentListKey = key
      } else {
        scalars.set(key, stripQuotes(rest))
      }
    }
  }

  return { scalars, lists, endLineIdx }
}

interface SectionInfo {
  readonly title: string
  readonly line: number
  readonly startLineIdx: number
  endLineIdx: number
}

export const decideAdrDocQuality = Effect.fn("AdrDocLint.decide")(function* (
  input: AdrDocLintInput
) {
  yield* Effect.void

  const findings: Array<AdrLintFinding> = []
  const rawLines = input.markdown.split(/\r?\n/)

  // 1. Frontmatter validation
  const fm = parseFrontmatter(rawLines)
  if (!fm) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: "Missing or unclosed YAML frontmatter delimited by '---'."
    })
    return {
      docPath: input.docPath,
      clean: false,
      findings
    } satisfies AdrDocLintReport
  }

  const id = fm.scalars.get("id")
  if (!id || !/^([a-z0-9-]+:)?ADR-\d{4}$/.test(id)) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: `Frontmatter 'id' must match format 'ADR-XXXX' or 'scope:ADR-XXXX', got: ${id ?? "missing"}.`
    })
  }

  const title = fm.scalars.get("title")
  if (!title || title.trim() === "") {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: "Frontmatter 'title' must be a non-empty string."
    })
  }

  const status = fm.scalars.get("status")
  const validStatuses = new Set(["proposed", "accepted", "superseded", "deprecated"])
  if (!status || !validStatuses.has(status)) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: `Frontmatter 'status' must be one of 'proposed', 'accepted', 'superseded', 'deprecated', got: ${status ?? "missing"}.`
    })
  }

  if (status === "superseded") {
    const supersededBy = fm.scalars.get("superseded_by")
    if (!supersededBy || !/^([a-z0-9-]+:)?ADR-\d{4}$/.test(supersededBy)) {
      findings.push({
        line: 1,
        kind: "adr-frontmatter-invalid",
        message: `Frontmatter 'superseded_by' must match format '([a-z0-9-]+:)?ADR-\\d{4}' when status is 'superseded', got: ${supersededBy ?? "missing"}.`
      })
    }
  }

  const date = fm.scalars.get("date")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: `Frontmatter 'date' must match 'YYYY-MM-DD', got: ${date ?? "missing"}.`
    })
  }

  const enforcedBy = fm.lists.get("enforced_by")
  if (!enforcedBy || enforcedBy.length === 0) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message: "Frontmatter 'enforced_by' must be a list containing at least 1 file path."
    })
  }

  const spans = fm.lists.get("spans")
  const services = fm.lists.get("services")
  const errors = fm.lists.get("errors")
  const totalGoverned =
    (spans?.length ?? 0) + (services?.length ?? 0) + (errors?.length ?? 0)
  if (totalGoverned < 1) {
    findings.push({
      line: 1,
      kind: "adr-frontmatter-invalid",
      message:
        "ADR must govern at least one symbol in 'spans', 'services', or 'errors'."
    })
  }

  const declaredSymbols = new Set<string>([
    ...(spans ?? []),
    ...(services ?? []),
    ...(errors ?? [])
  ])

  // Pre-calculate code block lines
  const isCodeBlock: Array<boolean> = Array.from(
    { length: rawLines.length },
    () => false
  )
  let inCode = false
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      isCodeBlock[i] = true
      continue
    }
    isCodeBlock[i] = inCode
  }

  // 2. Unfilled placeholders outside code blocks
  for (let i = fm.endLineIdx + 1; i < rawLines.length; i++) {
    if (isCodeBlock[i]) {
      continue
    }
    const rawLine = rawLines[i]!
    const lineNum = i + 1
    const strippedBackticks = rawLine.replace(/`[^`]*`/g, "")
    if (
      strippedBackticks.includes("<!--") ||
      /<(?!!--)[^<>`\n]{1,60}>/.test(strippedBackticks)
    ) {
      findings.push({
        line: lineNum,
        kind: "adr-unfilled-placeholder",
        message: `Line ${lineNum} contains unfilled placeholder or HTML comment.`
      })
    }
  }

  // 3. Collect H2 sections outside code blocks
  const sections: Array<SectionInfo> = []
  for (let i = fm.endLineIdx + 1; i < rawLines.length; i++) {
    if (isCodeBlock[i]) {
      continue
    }
    const rawLine = rawLines[i]!
    const lineNum = i + 1
    const h2Match = rawLine.match(/^##\s+(.*)$/)
    if (h2Match) {
      const headingTitle = h2Match[1]!.trim()
      sections.push({
        title: headingTitle,
        line: lineNum,
        startLineIdx: i,
        endLineIdx: rawLines.length
      })
    }
  }

  for (let s = 0; s < sections.length; s++) {
    if (s + 1 < sections.length) {
      sections[s]!.endLineIdx = sections[s + 1]!.startLineIdx
    }
  }

  const seenCanonical = new Map<string, number>()
  let lastCanonicalIdx = -1

  for (const sec of sections) {
    const canonicalIdx = CANONICAL_ADR_SECTIONS.indexOf(
      sec.title as (typeof CANONICAL_ADR_SECTIONS)[number]
    )

    if (canonicalIdx === -1) {
      findings.push({
        line: sec.line,
        kind: "adr-section-structure",
        message: `Unexpected section "## ${sec.title}". Allowed canonical sections are: ${CANONICAL_ADR_SECTIONS.join(", ")}.`
      })
      continue
    }

    if (seenCanonical.has(sec.title)) {
      findings.push({
        line: sec.line,
        kind: "adr-section-structure",
        message: `Duplicate section "## ${sec.title}". Already defined at line ${seenCanonical.get(sec.title)}.`
      })
    } else {
      seenCanonical.set(sec.title, sec.line)
      if (canonicalIdx < lastCanonicalIdx) {
        findings.push({
          line: sec.line,
          kind: "adr-section-structure",
          message: `Section "## ${sec.title}" is out of order. Expected order: ${CANONICAL_ADR_SECTIONS.join(" -> ")}.`
        })
      } else {
        lastCanonicalIdx = canonicalIdx
      }
    }
  }

  for (const expectedSec of CANONICAL_ADR_SECTIONS) {
    if (!seenCanonical.has(expectedSec)) {
      findings.push({
        line: 1,
        kind: "adr-section-structure",
        message: `Missing canonical section "## ${expectedSec}".`
      })
    }
  }

  for (const sec of sections) {
    let hasBodyContent = false
    for (let idx = sec.startLineIdx + 1; idx < sec.endLineIdx; idx++) {
      if (rawLines[idx]!.trim().length > 0) {
        hasBodyContent = true
        break
      }
    }
    if (!hasBodyContent) {
      findings.push({
        line: sec.line,
        kind: "adr-section-structure",
        message: `Section "## ${sec.title}" has an empty body.`
      })
    }
  }

  // Helper to extract lines of a section outside code blocks
  const getSectionLines = (
    secTitle: string
  ): {
    readonly sec: SectionInfo | undefined
    readonly lines: ReadonlyArray<{ readonly text: string; readonly line: number; readonly idx: number }>
  } => {
    const sec = sections.find((s) => s.title === secTitle)
    if (!sec) {
      return { sec: undefined, lines: [] }
    }
    const lines: Array<{ text: string; line: number; idx: number }> = []
    for (let i = sec.startLineIdx + 1; i < sec.endLineIdx; i++) {
      if (!isCodeBlock[i]) {
        lines.push({ text: rawLines[i]!, line: i + 1, idx: i })
      }
    }
    return { sec, lines }
  }

  // 4. Decision Drivers and Considered Options
  const driversInfo = getSectionLines("Decision Drivers")
  if (driversInfo.sec) {
    let bulletCount = 0
    for (const item of driversInfo.lines) {
      if (/^\s*[-*]\s+\S/.test(item.text)) {
        bulletCount++
      }
    }
    if (bulletCount < 2) {
      findings.push({
        line: driversInfo.sec.line,
        kind: "adr-missing-drivers-or-options",
        message: `Section "## Decision Drivers" must contain at least 2 bullet items (found ${bulletCount}).`
      })
    }
  }

  const optionsInfo = getSectionLines("Considered Options")
  if (optionsInfo.sec) {
    let listCount = 0
    for (const item of optionsInfo.lines) {
      if (/^\s*([-*]|\d+\.)\s+\S/.test(item.text)) {
        listCount++
      }
    }
    if (listCount < 2) {
      findings.push({
        line: optionsInfo.sec.line,
        kind: "adr-missing-drivers-or-options",
        message: `Section "## Considered Options" must contain at least 2 list items (found ${listCount}).`
      })
    }
  }

  // 5. Decision Outcome contains "Chosen option:"
  const outcomeInfo = getSectionLines("Decision Outcome")
  if (outcomeInfo.sec) {
    const hasChosen = outcomeInfo.lines.some((item) =>
      /chosen option:/i.test(item.text)
    )
    if (!hasChosen) {
      findings.push({
        line: outcomeInfo.sec.line,
        kind: "adr-missing-chosen-option",
        message:
          'Section "## Decision Outcome" must specify a chosen option containing "Chosen option:".'
      })
    }
  }

  // 6. Rejected Alternatives
  const rejectedInfo = getSectionLines("Rejected Alternatives")
  if (rejectedInfo.sec) {
    const subHeadings: Array<{ text: string; line: number; idx: number }> = []
    for (const item of rejectedInfo.lines) {
      if (/^###\s+/.test(item.text)) {
        subHeadings.push(item)
      }
    }

    if (subHeadings.length === 0) {
      findings.push({
        line: rejectedInfo.sec.line,
        kind: "adr-rejected-alternative-structure",
        message:
          'Section "## Rejected Alternatives" must contain at least one "### <n> · <Option Name>" subsection.'
      })
    } else {
      let nextExpectedNum = 1
      for (let j = 0; j < subHeadings.length; j++) {
        const sub = subHeadings[j]!
        const match = sub.text.match(/^### (\d+) · \S/)
        if (!match) {
          findings.push({
            line: sub.line,
            kind: "adr-rejected-alternative-structure",
            message: `Rejected alternative heading '${sub.text}' must match format '### <n> · <Option Name>'.`
          })
        } else {
          const num = parseInt(match[1]!, 10)
          if (num !== nextExpectedNum) {
            findings.push({
              line: sub.line,
              kind: "adr-rejected-alternative-structure",
              message: `Expected rejected alternative number ${nextExpectedNum}, but got ${num}.`
            })
          }
          nextExpectedNum = num + 1
        }

        const nextSubIdx =
          j + 1 < subHeadings.length
            ? subHeadings[j + 1]!.idx
            : rejectedInfo.sec.endLineIdx
        let hasWhyRejected = false
        for (let k = sub.idx + 1; k < nextSubIdx; k++) {
          if (!isCodeBlock[k] && rawLines[k]!.includes("**Why rejected:**")) {
            hasWhyRejected = true
            break
          }
        }
        if (!hasWhyRejected) {
          findings.push({
            line: sub.line,
            kind: "adr-rejected-alternative-structure",
            message: `Subsection '${sub.text}' must contain '**Why rejected:**'.`
          })
        }
      }
    }
  }

  // 7. Consequences and Enforcement
  const consequencesInfo = getSectionLines("Consequences and Enforcement")
  if (consequencesInfo.sec) {
    const requiredSubsections = [
      "Positive Consequences",
      "Negative Consequences and Trade-offs",
      "Deterministic Enforcement"
    ] as const

    const subMap = new Map<string, { line: number; idx: number }>()
    for (const item of consequencesInfo.lines) {
      const match = item.text.match(/^###\s+(.*)$/)
      if (match) {
        subMap.set(match[1]!.trim(), { line: item.line, idx: item.idx })
      }
    }

    for (const reqSub of requiredSubsections) {
      if (!subMap.has(reqSub)) {
        findings.push({
          line: consequencesInfo.sec.line,
          kind: "adr-missing-enforcement-table",
          message: `Missing required subsection "### ${reqSub}".`
        })
      }
    }

    const detEnforcement = subMap.get("Deterministic Enforcement")
    if (detEnforcement) {
      // Find end line of Deterministic Enforcement subsection
      let detEndIdx = consequencesInfo.sec.endLineIdx
      for (const item of consequencesInfo.lines) {
        if (item.idx > detEnforcement.idx && /^###\s+/.test(item.text)) {
          detEndIdx = item.idx
          break
        }
      }

      let validTableFound = false
      for (let i = detEnforcement.idx + 1; i < detEndIdx; i++) {
        if (isCodeBlock[i]) continue
        const line = rawLines[i]!
        if (isTableRow(line)) {
          const cells = parseTableRow(line)
          const cleanCols = cells.map((c) => stripMarkup(c).toLowerCase())
          if (
            cleanCols.length === EXPECTED_ENFORCEMENT_TABLE_COLS.length &&
            cleanCols.every(
              (col, cIdx) => col === EXPECTED_ENFORCEMENT_TABLE_COLS[cIdx]
            )
          ) {
            // Found matching header, check separator next
            let sepIdx = i + 1
            while (
              sepIdx < detEndIdx &&
              !isCodeBlock[sepIdx] &&
              rawLines[sepIdx]!.trim() === ""
            ) {
              sepIdx++
            }
            if (sepIdx < detEndIdx && !isCodeBlock[sepIdx]) {
              const sepCells = parseTableRow(rawLines[sepIdx]!)
              if (
                sepCells.length > 0 &&
                sepCells.every((c) => /^:?-+:?$/.test(c))
              ) {
                // Count data rows
                let dataRowCount = 0
                for (let r = sepIdx + 1; r < detEndIdx; r++) {
                  if (isCodeBlock[r]) break
                  const rowLine = rawLines[r]!
                  if (!isTableRow(rowLine)) {
                    if (rowLine.trim() === "") continue
                    break
                  }
                  const rowCells = parseTableRow(rowLine)
                  if (
                    rowCells.some((c) => c.length > 0) &&
                    !rowCells.every((c) => /^:?-+:?$/.test(c))
                  ) {
                    dataRowCount++

                    const lineNum = r + 1

                    // a) Check that none of the 4 cells (Rule, Enforced By, Gate / Mechanism, Governed Symbols) in a data row is empty or - / N/A
                    const isCellEmptyOrPlaceholder = (cell: string | undefined): boolean => {
                      if (cell === undefined) return true
                      const clean = stripMarkup(cell).trim().toLowerCase()
                      return (
                        clean === "" ||
                        clean === "-" ||
                        clean === "n/a" ||
                        clean === "na" ||
                        clean === "none" ||
                        clean === "tbd"
                      )
                    }

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
                        message: `Row at line ${lineNum} in 'Deterministic Enforcement' table contains empty or placeholder cell.`
                      })
                    }

                    // b) Collect all governed symbols declared in the ADR frontmatter (spans, services, errors).
                    // If the frontmatter declares at least one symbol, verify that every backtick-enclosed identifier
                    // in the Governed Symbols column (that is not a file path containing / or .ts and not a wildcard *)
                    // matches one of the frontmatter spans, services, or errors (or ends with #<symbol>).
                    if (declaredSymbols.size > 0 && governedSymbolsCell) {
                      const backtickMatches = Array.from(
                        governedSymbolsCell.matchAll(/`([^`]+)`/g)
                      ).map((m) => m[1]!.trim())

                      for (const sym of backtickMatches) {
                        if (
                          sym === "*" ||
                          sym.includes("/") ||
                          sym.includes(".ts")
                        ) {
                          continue
                        }

                        const matches =
                          declaredSymbols.has(sym) ||
                          Array.from(declaredSymbols).some(
                            (ds) =>
                              ds.endsWith(`#${sym}`) ||
                              sym.endsWith(`#${ds}`)
                          )

                        if (!matches) {
                          findings.push({
                            line: lineNum,
                            kind: "adr-enforcement-mismatch",
                            message: `Governed symbol '${sym}' at line ${lineNum} is not declared in ADR frontmatter spans, services, or errors.`
                          })
                        }
                      }
                    }
                  }
                }
                if (dataRowCount >= 1) {
                  validTableFound = true
                  break
                }
              }
            }
          }
        }
      }

      if (!validTableFound) {
        findings.push({
          line: detEnforcement.line,
          kind: "adr-missing-enforcement-table",
          message:
            "Subsection '### Deterministic Enforcement' must contain a table with columns ['Rule', 'Enforced By', 'Gate / Mechanism', 'Governed Symbols'] and at least 1 data row."
        })
      }
    }
  }

  return {
    docPath: input.docPath,
    clean: findings.length === 0,
    findings
  } satisfies AdrDocLintReport
})

export const lintAdrDocMarkdown = (
  docPath: string,
  markdown: string
): AdrDocLintReport => Effect.runSync(decideAdrDocQuality({ docPath, markdown }))
