import { Effect, Schema } from "effect"
import { ActiveMutantId } from "../plugins/self-dogfooding-contract.js"
import { ActiveMutantContextLive, withActiveMutantEffect } from "../services/active-mutant-context.js"

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

interface GlobalWithMutantId {
  __HARNESS_ACTIVE_MUTANT_ID?: string | undefined
  __harnessActiveMutant?: string | undefined
}

export const getActiveMutantId = (): string | undefined =>
  (globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID ??
  (globalThis as GlobalWithMutantId).__harnessActiveMutant ??
  process.env["HARNESS_ACTIVE_MUTANT_ID"]

export const setActiveMutantId = (mutantId: string | undefined): void => {
  ;(globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID = mutantId
  ;(globalThis as GlobalWithMutantId).__harnessActiveMutant = mutantId
  if (mutantId === undefined) {
    delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
  } else {
    process.env["HARNESS_ACTIVE_MUTANT_ID"] = mutantId
  }
}

const MUTATION_PATTERNS: ReadonlyArray<{
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

const shouldSkipLine = (trimmed: string): boolean => {
  if (trimmed.length === 0) return true
  if (
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
  ) {
    return true
  }
  return false
}

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
    if (rawLine.startsWith("--- ")) {
      continue
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine)
    if (hunkMatch !== null && currentFile !== null) {
      currentNewLine = Number(hunkMatch[1] ?? "1")
      inHunk = true
      continue
    }
    if (!inHunk || currentFile === null) {
      continue
    }
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
    if (rawLine.startsWith(" ")) {
      currentNewLine += 1
    }
  }

  return result
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

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    if (restrictByModifiedLines && !modifiedLines.has(lineNo)) {
      continue
    }

    const line = lines[i]!
    const trimmed = line.trim()
    if (shouldSkipLine(trimmed)) {
      continue
    }

    const commentIdx = line.indexOf("//")
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line
    const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : ""
    if (codePart.trim() === "") {
      continue
    }

    for (const pattern of MUTATION_PATTERNS) {
      if (codePart.includes(pattern.original)) {
        const mutatedLines = [...lines]
        mutatedLines[i] = codePart.replace(pattern.original, pattern.replacement) + commentPart
        const mutatedSource = mutatedLines.join(newline)

        mutants.push({
          id: `${filePath}:${lineNo}:${pattern.original}->${pattern.replacement}`,
          file: filePath,
          line: lineNo,
          category: pattern.category,
          original: pattern.original,
          replacement: pattern.replacement,
          mutatedSource,
        })
      }
    }

    const binaryAddMatch = codePart.match(
      /\b([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*\+\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/,
    )
    if (binaryAddMatch && binaryAddMatch[1] && binaryAddMatch[2]) {
      const orig = binaryAddMatch[0]
      const repl = `${binaryAddMatch[1]} - ${binaryAddMatch[2]}`
      const mutatedLines = [...lines]
      mutatedLines[i] = codePart.replace(orig, repl) + commentPart
      mutants.push({
        id: `${filePath}:${lineNo}:${orig}->${repl}`,
        file: filePath,
        line: lineNo,
        category: "arithmetic-operator",
        original: orig,
        replacement: repl,
        mutatedSource: mutatedLines.join(newline),
      })
    }

    const spreadAppendMatch = codePart.match(
      /\[\s*\.\.\.([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*,\s*\{[^[\]]+\}\s*\]/,
    )
    if (spreadAppendMatch && spreadAppendMatch[1]) {
      const orig = spreadAppendMatch[0]
      const repl = spreadAppendMatch[1]
      const mutatedLines = [...lines]
      mutatedLines[i] = codePart.replace(orig, repl) + commentPart
      mutants.push({
        id: `${filePath}:${lineNo}:${orig}->${repl}`,
        file: filePath,
        line: lineNo,
        category: "batch-folding",
        original: orig,
        replacement: repl,
        mutatedSource: mutatedLines.join(newline),
      })
    }

    const counterCopyMatch = codePart.match(
      /\b(totalItems|totalCount|itemCount)\s*:\s*([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\b/,
    )
    if (counterCopyMatch && counterCopyMatch[1]) {
      const orig = counterCopyMatch[0]
      const repl = `${counterCopyMatch[1]}: 0`
      const mutatedLines = [...lines]
      mutatedLines[i] = codePart.replace(orig, repl) + commentPart
      mutants.push({
        id: `${filePath}:${lineNo}:${orig}->${repl}`,
        file: filePath,
        line: lineNo,
        category: "arithmetic-operator",
        original: orig,
        replacement: repl,
        mutatedSource: mutatedLines.join(newline),
      })
    }
  }

  return mutants
}

/**
 * Compiles all `M` discovered mutations for a module into a single in-memory
 * Mutant Schema AST parameterized by `globalThis.__HARNESS_ACTIVE_MUTANT_ID` and
 * `globalThis.__harnessActiveMutant` (`RFC-0005 §4.3.2`).
 */
export const compileMutantSchemaModule = (
  filePath: string,
  sourceCode: string,
  mutants: ReadonlyArray<CodeMutant>,
): MutantSchemaModule => {
  const newline = sourceCode.includes("\r\n") ? "\r\n" : "\n"
  const lines = sourceCode.split(newline)
  const mutantsByLine = new Map<number, Array<CodeMutant>>()

  for (const m of mutants) {
    if (m.file !== filePath) continue
    const list = mutantsByLine.get(m.line) ?? []
    list.push(m)
    mutantsByLine.set(m.line, list)
  }

  for (const [lineNo, lineMutants] of mutantsByLine.entries()) {
    const idx = lineNo - 1
    const origLine = lines[idx]
    if (origLine === undefined) continue
    let transformed = origLine
    for (const m of lineMutants) {
      const mutantCondition = `((globalThis.__HARNESS_ACTIVE_MUTANT_ID ?? (globalThis as { __HARNESS_ACTIVE_MUTANT_ID?: string }).__HARNESS_ACTIVE_MUTANT_ID ?? (globalThis as { __harnessActiveMutant?: string }).__harnessActiveMutant ?? process.env["HARNESS_ACTIVE_MUTANT_ID"]) === ${JSON.stringify(m.id)})`
      if (m.original.startsWith("return ")) {
        const origExpr = m.original.slice("return ".length)
        const replExpr = m.replacement.slice("return ".length)
        transformed = transformed.replace(
          m.original,
          `return (${mutantCondition} ? (${replExpr}) : (${origExpr}))`,
        )
        continue
      }
      const ifCondMatch = /^(\s*if\s*\()(.*)(\)\s*\{?\s*)$/.exec(transformed)
      if (ifCondMatch !== null && ifCondMatch[2]?.includes(m.original)) {
        const prefix = ifCondMatch[1]!
        const origCond = ifCondMatch[2]!
        const suffix = ifCondMatch[3]!
        const mutatedCond = origCond.replace(m.original, m.replacement)
        transformed = `${prefix}(${mutantCondition} ? (${mutatedCond}) : (${origCond}))${suffix}`
        continue
      }
      transformed = transformed.replace(
        m.original,
        `(${mutantCondition} ? (${m.replacement}) : (${m.original}))`,
      )
    }
    lines[idx] = transformed
  }

  return {
    filePath,
    schemaSource: lines.join(newline),
    mutantIds: mutants.map((m) => m.id),
  }
}

const isAssertionFailure = (err: unknown): boolean =>
  err instanceof Error &&
  (err.name === "AssertionError" ||
    err.name === "ExpectError" ||
    err.message.includes("expected") ||
    err.message.includes("assert"))

const invokeMutantTestFn = (
  testFn: (activeMutantId: string) => boolean | void,
  mutantId: string,
): "killed" | "defect" | "survived" =>
  Effect.runSync(
    Effect.try({
      try: () => (testFn(mutantId) === false ? ("killed" as const) : ("survived" as const)),
      catch: (err) => (isAssertionFailure(err) ? ("killed" as const) : ("defect" as const)),
    }).pipe(Effect.orElseSucceed((status) => status)),
  )

/**
 * Evaluates all `M` mutants inside a single warm process by toggling
 * `ActiveMutantContext` / `globalThis.__HARNESS_ACTIVE_MUTANT_ID` across `ExercisesSpan`-linked test callbacks (`RFC-0005 §4.3.2`).
 */
export const evaluateMutantSchemaInProcess = (
  mutants: ReadonlyArray<CodeMutant>,
  exercisesSpanTests: ReadonlyArray<(activeMutantId: string) => boolean | void>,
): ReadonlyArray<MutantOutcome> =>
  Effect.runSync(
    Effect.gen(function* () {
      const outcomes: Array<MutantOutcome> = []
      for (const mutant of mutants) {
        const killed = yield* withActiveMutantEffect(ActiveMutantId.make(mutant.id), () => {
          for (const testFn of exercisesSpanTests) {
            const res = invokeMutantTestFn(testFn, mutant.id)
            if (res === "killed") {
              return true
            }
            if (res === "defect") {
              return false
            }
          }
          return false
        })
        outcomes.push({
          mutant,
          status: killed ? "killed" : "survived",
        })
      }
      return outcomes
    }).pipe(Effect.provide(ActiveMutantContextLive)),
  )
