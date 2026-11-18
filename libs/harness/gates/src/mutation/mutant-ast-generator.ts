/**
 * @fileoverview AST-based mutant discovery, schema module compilation, and in-process mutant evaluation.
 */
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import { getActiveMutantId, setActiveMutantId } from "../services/active-mutant-context.js"

export { getActiveMutantId, setActiveMutantId }

export const MutantCategory = Schema.Literals([
  "boundary-operator",
  "equality-operator",
  "arithmetic-operator",
  "boolean-return",
  "batch-folding",
  "terminal-state-preservation",
  "guard-condition",
])
export type MutantCategory = typeof MutantCategory.Type

export const CodeMutant = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  line: Schema.Finite,
  category: MutantCategory,
  original: Schema.String,
  replacement: Schema.String,
  mutatedSource: Schema.String,
})
export type CodeMutant = typeof CodeMutant.Type

export const MutantOutcome = Schema.Struct({
  mutant: CodeMutant,
  status: Schema.Literals(["killed", "survived", "equivalent"]),
})
export type MutantOutcome = typeof MutantOutcome.Type

export interface MutantSchemaModule {
  readonly filePath: string
  readonly schemaSource: string
  readonly mutantIds: ReadonlyArray<string>
}

export const MUTATION_PATTERNS: ReadonlyArray<{
  readonly original: string
  readonly replacement: string
  readonly category: MutantCategory
}> = [
  { original: ">=", replacement: ">", category: "boundary-operator" },
  { original: "<=", replacement: "<", category: "boundary-operator" },
  { original: "===", replacement: "!==", category: "equality-operator" },
  { original: "!==", replacement: "===", category: "equality-operator" },
  { original: "+ 1", replacement: "- 1", category: "arithmetic-operator" },
  { original: "- 1", replacement: "+ 1", category: "arithmetic-operator" },
  { original: "return true", replacement: "return false", category: "boolean-return" },
  { original: "return false", replacement: "return true", category: "boolean-return" },
  {
    original: "events.reduce(",
    replacement: "events.slice(0, 1).reduce(",
    category: "batch-folding",
  },
  {
    original: ".reduce(evolve,",
    replacement: ".slice(0, 1).reduce(evolve,",
    category: "batch-folding",
  },
  {
    original: "() => state",
    replacement: "() => initialState",
    category: "terminal-state-preservation",
  },
  {
    original: "return state",
    replacement: "return initialState",
    category: "terminal-state-preservation",
  },
  {
    original: "!Equal.equals(someErr.value, expectedError)",
    replacement:
      "((someErr.value as { readonly _tag?: unknown })?._tag !== (expectedError as { readonly _tag?: unknown })?._tag)",
    category: "equality-operator",
  },
  {
    original: "if (!Equal.equals(",
    replacement: "if (false && !Equal.equals(",
    category: "guard-condition",
  },
  {
    original: "if (Equal.equals(",
    replacement: "if (true || Equal.equals(",
    category: "guard-condition",
  },
  {
    original: "if (Exit.isSuccess(",
    replacement: "if (false && Exit.isSuccess(",
    category: "guard-condition",
  },
  { original: "Effect.die(", replacement: "Effect.succeed(", category: "guard-condition" },
]

const HOISTED_MUTANT_HELPER =
  'function __hMut(id: string): boolean { const g: object = globalThis; const p: unknown = Reflect.get(g, "process"); const env: unknown = typeof p === "object" && p !== null ? Reflect.get(p, "env") : undefined; const activeG: unknown = Reflect.get(g, "__HARNESS_ACTIVE_MUTANT_ID"); const activeE: unknown = typeof env === "object" && env !== null ? Reflect.get(env, "HARNESS_ACTIVE_MUTANT_ID") : undefined; return activeG === id || activeE === id; /* globalThis.__HARNESS_ACTIVE_MUTANT_ID */ }'

const shouldSkipLine = (trimmed: string): boolean =>
  trimmed.length === 0 ||
  trimmed.startsWith("//") ||
  trimmed.startsWith("/*") ||
  trimmed.startsWith("*") ||
  trimmed.startsWith("import ") ||
  trimmed.startsWith("import\t") ||
  trimmed.startsWith("export type ") ||
  trimmed.startsWith("export type\t") ||
  trimmed.startsWith("type ") ||
  trimmed.startsWith("type\t") ||
  trimmed.startsWith("interface ") ||
  trimmed.startsWith("export interface ")

export const parseGitDiffModifiedLines = (
  diffOutput: string,
): ReadonlyMap<string, ReadonlySet<number>> => {
  const result = new Map<string, Set<number>>()
  let currentFile: string | null = null
  let currentNewLine = 0
  let inHunk = false

  for (const rawLine of diffOutput.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6).trim()
      inHunk = false
      continue
    }
    if (rawLine.startsWith("--- ")) continue
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine)
    if (hunkMatch !== null && currentFile !== null) {
      currentNewLine = Number(hunkMatch[1] ?? "1")
      inHunk = true
      continue
    }
    if (!inHunk || currentFile === null) continue
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      let lineSet = result.get(currentFile)
      if (lineSet === undefined) {
        lineSet = new Set<number>()
        result.set(currentFile, lineSet)
      }
      lineSet.add(currentNewLine)
      currentNewLine += 1
      continue
    }
    if (rawLine.startsWith(" ")) currentNewLine += 1
  }
  return result
}

const createSourceFile = (filePath: string, sourceCode: string): ts.SourceFile =>
  ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

const findCoveringChain = (
  sf: ts.SourceFile,
  editStart: number,
  editEnd: number,
): ReadonlyArray<ts.Node> => {
  const chain: Array<ts.Node> = []
  const visit = (node: ts.Node): void => {
    if (node.getStart(sf) <= editStart && editEnd <= node.getEnd()) {
      chain.push(node)
      ts.forEachChild(node, visit)
    }
  }
  visit(sf)
  return chain
}

const isDisallowedAstNode = (node: ts.Node): boolean =>
  ts.isTypeNode(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isImportDeclaration(node) ||
  ts.isExportDeclaration(node) ||
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node) ||
  ts.isRegularExpressionLiteral(node)

const NON_WRAP_EXPR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.ImportKeyword,
])

const PROPERTY_OWNER_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.BindingElement,
])

const INC_DEC_OP_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
])

const ASSIGNMENT_OP_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

const isPropertyNamePosition = (node: ts.Node, parent: ts.Node): boolean =>
  PROPERTY_OWNER_KINDS.has(parent.kind) && Reflect.get(parent, "name") === node

const isCalleeOrTargetPosition = (node: ts.Node, parent: ts.Node): boolean =>
  ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
  (ts.isTaggedTemplateExpression(parent) && parent.tag === node) ||
  (ts.isBinaryExpression(parent) &&
    parent.left === node &&
    ASSIGNMENT_OP_KINDS.has(parent.operatorToken.kind)) ||
  ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    INC_DEC_OP_KINDS.has(parent.operator))

const isWrapSafeExpression = (node: ts.Node, parent: ts.Node): boolean =>
  ts.isExpression(node) &&
  !NON_WRAP_EXPR_KINDS.has(node.kind) &&
  !isPropertyNamePosition(node, parent) &&
  !isCalleeOrTargetPosition(node, parent)

export interface WrapTargetSpan {
  readonly start: number
  readonly end: number
}

export const locateWrapTargetSpan = (
  origSf: ts.SourceFile,
  editStart: number,
  editEnd: number,
): WrapTargetSpan | undefined => {
  const chain = findCoveringChain(origSf, editStart, editEnd)
  if (chain.length === 0) return undefined

  for (const node of [...chain].reverse()) {
    if (ts.isIfStatement(node) && editEnd <= node.expression.getEnd()) {
      return { start: node.expression.getStart(origSf), end: node.expression.getEnd() }
    }
  }
  for (const node of [...chain].reverse()) {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      return { start: node.expression.getStart(origSf), end: node.expression.getEnd() }
    }
  }
  for (const [idx, node] of [...chain.entries()].reverse()) {
    if (idx > 0 && isWrapSafeExpression(node, chain[idx - 1]!)) {
      return { start: node.getStart(origSf), end: node.getEnd() }
    }
  }
  return undefined
}

const computeEditDiff = (
  orig: string,
  mutated: string,
): { readonly editStart: number; readonly editEnd: number; readonly editReplacement: string } => {
  let prefix = 0
  const minLen = Math.min(orig.length, mutated.length)
  while (prefix < minLen && orig.charCodeAt(prefix) === mutated.charCodeAt(prefix)) prefix += 1
  let origEnd = orig.length
  let mutEnd = mutated.length
  while (
    origEnd > prefix &&
    mutEnd > prefix &&
    orig.charCodeAt(origEnd - 1) === mutated.charCodeAt(mutEnd - 1)
  ) {
    origEnd -= 1
    mutEnd -= 1
  }
  return { editStart: prefix, editEnd: origEnd, editReplacement: mutated.slice(prefix, mutEnd) }
}

export const discoverDomainMutants = (
  filePath: string,
  sourceCode: string,
  options?: { readonly modifiedLines?: ReadonlySet<number> | undefined },
): ReadonlyArray<CodeMutant> => {
  const mutants: Array<CodeMutant> = []
  const newline = sourceCode.includes("\r\n") ? "\r\n" : "\n"
  const lines = sourceCode.split(newline)
  const modifiedLines = options?.modifiedLines
  const restrictByModifiedLines = modifiedLines !== undefined && modifiedLines.size > 0
  const origSf = createSourceFile(filePath, sourceCode)

  const lineStarts: Array<number> = []
  let runningOffset = 0
  for (const line of lines) {
    lineStarts.push(runningOffset)
    runningOffset += line.length + newline.length
  }

  const tryPushCandidate = (
    lineIdx: number,
    lineNo: number,
    posInLine: number,
    origSpanLen: number,
    mutatedLine: string,
    id: string,
    category: MutantCategory,
    original: string,
    replacement: string,
    seenMutatedSources: Set<string>,
  ): void => {
    const absStart = (lineStarts[lineIdx] ?? 0) + posInLine
    const absEnd = absStart + origSpanLen
    if (findCoveringChain(origSf, absStart, absEnd).some(isDisallowedAstNode)) return
    if (locateWrapTargetSpan(origSf, absStart, absEnd) === undefined) return
    const mutatedLines = [...lines]
    mutatedLines[lineIdx] = mutatedLine
    const mutatedSource = mutatedLines.join(newline)
    if (seenMutatedSources.has(mutatedSource)) return
    seenMutatedSources.add(mutatedSource)
    mutants.push({
      id,
      file: filePath,
      line: lineNo,
      category,
      original,
      replacement,
      mutatedSource,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    if (restrictByModifiedLines && !modifiedLines.has(lineNo)) continue
    const line = lines[i]!
    if (shouldSkipLine(line.trim())) continue
    const commentIdx = line.indexOf("//")
    const codePart = commentIdx < 0 ? line : line.slice(0, commentIdx)
    const commentPart = commentIdx < 0 ? "" : line.slice(commentIdx)
    if (codePart.trim() === "") continue

    const seenMutatedSources = new Set<string>()
    for (const pattern of MUTATION_PATTERNS) {
      let searchFrom = 0
      let occ = 0
      while (searchFrom < codePart.length) {
        const pos = codePart.indexOf(pattern.original, searchFrom)
        if (pos < 0) break
        const mutatedLine =
          codePart.slice(0, pos) +
          pattern.replacement +
          codePart.slice(pos + pattern.original.length) +
          commentPart
        const id =
          occ === 0
            ? `${filePath}:${lineNo}:${pattern.original}->${pattern.replacement}`
            : `${filePath}:${lineNo}@${occ + 1}:${pattern.original}->${pattern.replacement}`
        tryPushCandidate(
          i,
          lineNo,
          pos,
          pattern.original.length,
          mutatedLine,
          id,
          pattern.category,
          pattern.original,
          pattern.replacement,
          seenMutatedSources,
        )
        occ += 1
        searchFrom = pos + Math.max(1, pattern.original.length)
      }
    }

    const binaryAddMatch =
      /\b([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*\+\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/.exec(
        codePart,
      )
    if (binaryAddMatch && binaryAddMatch[1] && binaryAddMatch[2]) {
      const orig = binaryAddMatch[0]
      const repl = `${binaryAddMatch[1]} - ${binaryAddMatch[2]}`
      const pos = binaryAddMatch.index
      const mutatedLine =
        codePart.slice(0, pos) + repl + codePart.slice(pos + orig.length) + commentPart
      tryPushCandidate(
        i,
        lineNo,
        pos,
        orig.length,
        mutatedLine,
        `${filePath}:${lineNo}:${orig}->${repl}`,
        "arithmetic-operator",
        orig,
        repl,
        seenMutatedSources,
      )
    }

    const spreadAppendMatch =
      /\[\s*\.\.\.([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*,\s*\{[^[\]]+\}\s*\]/.exec(codePart)
    if (spreadAppendMatch && spreadAppendMatch[1]) {
      const orig = spreadAppendMatch[0]
      const repl = spreadAppendMatch[1]
      const pos = spreadAppendMatch.index
      const mutatedLine =
        codePart.slice(0, pos) + repl + codePart.slice(pos + orig.length) + commentPart
      tryPushCandidate(
        i,
        lineNo,
        pos,
        orig.length,
        mutatedLine,
        `${filePath}:${lineNo}:${orig}->${repl}`,
        "batch-folding",
        orig,
        repl,
        seenMutatedSources,
      )
    }

    const counterCopyMatch =
      /\b(totalItems|totalCount|itemCount)\s*:\s*([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\b/.exec(
        codePart,
      )
    if (counterCopyMatch && counterCopyMatch[1] && counterCopyMatch[2]) {
      const orig = counterCopyMatch[0]
      const repl = `${counterCopyMatch[1]}: 0`
      const pos = counterCopyMatch.index
      const valueOffset = orig.indexOf(counterCopyMatch[2])
      const mutatedLine =
        codePart.slice(0, pos) + repl + codePart.slice(pos + orig.length) + commentPart
      tryPushCandidate(
        i,
        lineNo,
        pos + Math.max(0, valueOffset),
        counterCopyMatch[2].length,
        mutatedLine,
        `${filePath}:${lineNo}:${orig}->${repl}`,
        "arithmetic-operator",
        orig,
        repl,
        seenMutatedSources,
      )
    }
  }
  return mutants
}

/**
 * Compiles all `M` discovered mutations for a module into a single in-memory
 * Mutant Schema AST parameterized by `globalThis.__HARNESS_ACTIVE_MUTANT_ID` (`RFC-0005 §4.3.2`).
 */
export const compileMutantSchemaModule = (
  filePath: string,
  sourceCode: string,
  mutants: ReadonlyArray<CodeMutant>,
): MutantSchemaModule => {
  const relevant = mutants.filter((m) => m.file === filePath)
  if (relevant.length === 0) return { filePath, schemaSource: sourceCode, mutantIds: [] }

  const origSf = createSourceFile(filePath, sourceCode)
  interface CompiledMutantItem {
    readonly mutant: CodeMutant
    readonly editStart: number
    readonly editEnd: number
    readonly editReplacement: string
    readonly targetStart: number
    readonly targetEnd: number
  }

  const items: Array<CompiledMutantItem> = []
  for (const mutant of relevant) {
    const diff = computeEditDiff(sourceCode, mutant.mutatedSource)
    const span = locateWrapTargetSpan(origSf, diff.editStart, diff.editEnd)
    if (span !== undefined) {
      items.push({ mutant, ...diff, targetStart: span.start, targetEnd: span.end })
    }
  }
  if (items.length === 0) return { filePath, schemaSource: sourceCode, mutantIds: [] }

  items.sort((a, b) =>
    a.targetStart !== b.targetStart ? a.targetStart - b.targetStart : b.targetEnd - a.targetEnd,
  )

  interface TargetGroup {
    start: number
    end: number
    readonly items: Array<CompiledMutantItem>
  }
  const groups: Array<TargetGroup> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last === undefined || item.targetStart > last.end) {
      groups.push({ start: item.targetStart, end: item.targetEnd, items: [item] })
      continue
    }
    last.items.push(item)
  }

  let transformed = sourceCode
  for (let gIdx = groups.length - 1; gIdx >= 0; gIdx--) {
    const group = groups[gIdx]!
    const origExpr = sourceCode.slice(group.start, group.end)
    let wrapped = `(${origExpr})`
    for (let j = group.items.length - 1; j >= 0; j--) {
      const m = group.items[j]!
      const mutExpr =
        origExpr.slice(0, m.editStart - group.start) +
        m.editReplacement +
        origExpr.slice(m.editEnd - group.start)
      wrapped = `(__hMut(${JSON.stringify(m.mutant.id)}) ? (${mutExpr}) : ${wrapped})`
    }
    transformed = transformed.slice(0, group.start) + wrapped + transformed.slice(group.end)
  }

  let prologueEnd = 0
  for (const stmt of origSf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression))
    ) {
      prologueEnd = stmt.getEnd()
    } else {
      break
    }
  }

  const injectHelper = (): string => {
    if (prologueEnd > 0) {
      return `${transformed.slice(0, prologueEnd)}; ${HOISTED_MUTANT_HELPER}; ${transformed.slice(prologueEnd)}`
    }
    if (transformed.startsWith("#!")) {
      const firstNl = transformed.indexOf("\n")
      return firstNl < 0
        ? `${transformed}\n${HOISTED_MUTANT_HELPER}`
        : `${transformed.slice(0, firstNl + 1)}${HOISTED_MUTANT_HELPER}; ${transformed.slice(firstNl + 1)}`
    }
    return `${HOISTED_MUTANT_HELPER}; ${transformed}`
  }

  return { filePath, schemaSource: injectHelper(), mutantIds: items.map((i) => i.mutant.id) }
}

export const verifyMutantSchemaSyntax = (
  filePath: string,
  schemaSource: string,
): ReadonlyArray<string> => {
  const result = ts.transpileModule(schemaSource, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  })
  return (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
}

export const isAssertionFailure = (err: unknown): boolean =>
  err instanceof Error &&
  (err.name === "AssertionError" ||
    err.name === "ExpectError" ||
    "matcherResult" in err ||
    /^(?:AssertionError|ExpectError|expect\()/i.test(err.message) ||
    err.message.includes("toBe") ||
    err.message.includes("toEqual"))

/**
 * Evaluates all `M` mutants inside a single warm process by toggling
 * `ActiveMutantContext` / `globalThis.__HARNESS_ACTIVE_MUTANT_ID` across `ExercisesSpan`-linked test callbacks (`RFC-0005 §4.3.2`).
 */
export const evaluateMutantSchemaInProcess = (
  mutants: ReadonlyArray<CodeMutant>,
  exercisesSpanTests: ReadonlyArray<(activeMutantId: string) => boolean | void>,
): ReadonlyArray<MutantOutcome> => {
  const outcomes: Array<MutantOutcome> = []
  const prevGlobal = getActiveMutantId()

  for (const mutant of mutants) {
    setActiveMutantId(mutant.id)
    let mutantKilled = false
    for (const testFn of exercisesSpanTests) {
      const res = Result.try(() => testFn(mutant.id) === false)
      const killed = match(res)
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, ({ failure }) => isAssertionFailure(failure))
        .exhaustive()
      if (killed) {
        mutantKilled = true
        break
      }
    }
    setActiveMutantId(prevGlobal)
    outcomes.push({ mutant, status: mutantKilled ? "killed" : "survived" })
  }
  return outcomes
}
