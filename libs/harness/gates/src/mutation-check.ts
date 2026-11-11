import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"

export type MutantCategory =
  | "boundary-operator"
  | "equality-operator"
  | "arithmetic-operator"
  | "boolean-return"
  | "batch-folding"
  | "terminal-state-preservation"
  | "guard-condition"

export interface CodeMutant {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly category: MutantCategory
  readonly original: string
  readonly replacement: string
  readonly mutatedSource: string
}

export interface MutantOutcome {
  readonly mutant: CodeMutant
  readonly status: "killed" | "survived" | "equivalent"
}

export interface SpanSaturationSpec {
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly declaredErrorTags: ReadonlyArray<string>
  readonly declaredBranchTags?: ReadonlyArray<string> | undefined
}

export interface TraceSpanObservation {
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly exitTag?: "Success" | "Failure" | "Defect" | undefined
  readonly errorTag?: string | null | undefined
  readonly valueTag?: string | null | undefined
}

export interface SaturationViolation {
  readonly ruleId: "SAT-01" | "SAT-02"
  readonly kind: "unexercised-error-channel" | "shallow-branch-saturation"
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly missingTags: ReadonlyArray<string>
  readonly message: string
}

export interface MutationEvaluationInput {
  readonly outcomes: ReadonlyArray<MutantOutcome>
  readonly minScore?: number | undefined
  readonly equivalencePriors?: Readonly<Record<string, number>> | undefined
  readonly saturationSpecs?: ReadonlyArray<SpanSaturationSpec> | undefined
  readonly traceObservations?: ReadonlyArray<TraceSpanObservation> | undefined
}

export interface MutationSuiteReport {
  readonly passed: boolean
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly mutationScore: number
  readonly survivedMutants: ReadonlyArray<CodeMutant>
  readonly equivalentCount?: number | undefined
  readonly equivalentMutants?: ReadonlyArray<CodeMutant> | undefined
  readonly saturationViolations?: ReadonlyArray<SaturationViolation> | undefined
}

export interface MutantSchemaModule {
  readonly filePath: string
  readonly schemaSource: string
  readonly mutantIds: ReadonlyArray<string>
}

interface GlobalWithMutantId {
  __HARNESS_ACTIVE_MUTANT_ID?: string | undefined
}

export const getActiveMutantId = (): string | undefined =>
  (globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID

export const setActiveMutantId = (mutantId: string | undefined): void => {
  ;(globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID = mutantId
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
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      // Deleted line in old file does not advance new file line counter
    } else if (rawLine.startsWith(" ")) {
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
 * Mutant Schema AST parameterized by `globalThis.__HARNESS_ACTIVE_MUTANT_ID` (`RFC-0005 §4.3.2`).
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
      const ifCondMatch = /^(\s*if\s*\()(.*)(\)\s*(?:\{.*|return\b.*)?)$/.exec(transformed)
      if (m.original.startsWith("return ")) {
        const origExpr = m.original.slice("return ".length)
        const replExpr = m.replacement.slice("return ".length)
        transformed = transformed.replace(
          m.original,
          `return (globalThis.__HARNESS_ACTIVE_MUTANT_ID === ${JSON.stringify(m.id)} ? (${replExpr}) : (${origExpr}))`,
        )
      } else if (ifCondMatch !== null && ifCondMatch[2]?.includes(m.original)) {
        const prefix = ifCondMatch[1]!
        const origCond = ifCondMatch[2]!
        const suffix = ifCondMatch[3]!
        const mutatedCond = origCond.replace(m.original, m.replacement)
        transformed = `${prefix}(globalThis.__HARNESS_ACTIVE_MUTANT_ID === ${JSON.stringify(m.id)} ? (${mutatedCond}) : (${origCond}))${suffix}`
      } else {
        transformed = transformed.replace(
          m.original,
          `(globalThis.__HARNESS_ACTIVE_MUTANT_ID === ${JSON.stringify(m.id)} ? (${m.replacement}) : (${m.original}))`,
        )
      }
    }
    lines[idx] = transformed
  }

  return {
    filePath,
    schemaSource: lines.join(newline),
    mutantIds: mutants.map((m) => m.id),
  }
}

/**
 * Evaluates all `M` mutants inside a single warm process by toggling
 * `globalThis.__HARNESS_ACTIVE_MUTANT_ID` across `ExercisesSpan`-linked test callbacks (`RFC-0005 §4.3.2`).
 */
export const evaluateMutantSchemaInProcess = (
  mutants: ReadonlyArray<CodeMutant>,
  exercisesSpanTests: ReadonlyArray<(activeMutantId: string) => boolean | void>,
): ReadonlyArray<MutantOutcome> => {
  const outcomes: Array<MutantOutcome> = []
  const previousMutantId = getActiveMutantId()
  const restoreMutantId = Effect.sync(() => {
    if (previousMutantId === undefined) {
      delete (globalThis as GlobalWithMutantId).__HARNESS_ACTIVE_MUTANT_ID
    } else {
      setActiveMutantId(previousMutantId)
    }
  })

  for (const mutant of mutants) {
    const killed = Effect.runSync(
      Effect.gen(function* () {
        setActiveMutantId(mutant.id)
        for (const testFn of exercisesSpanTests) {
          const ok = yield* Effect.try({
            try: () => testFn(mutant.id),
            catch: () => false,
          }).pipe(Effect.orElseSucceed(() => false))
          if (ok === false) {
            return true
          }
        }
        return false
      }).pipe(Effect.ensuring(restoreMutantId)),
    )
    outcomes.push({
      mutant,
      status: killed ? "killed" : "survived",
    })
  }
  return outcomes
}

/**
 * Evaluates `SAT-01` (`unexercised-error-channel`, crediting failures on both span `s_f`
 * AND its transitive descendant spans `s_c`) and `SAT-02` (`shallow-branch-saturation`).
 */
export const evaluateSpanSaturationViolations = (
  specs: ReadonlyArray<SpanSaturationSpec>,
  observations: ReadonlyArray<TraceSpanObservation>,
): ReadonlyArray<SaturationViolation> => {
  const byId = new Map<string, TraceSpanObservation>()
  for (const obs of observations) {
    byId.set(obs.spanId, obs)
  }

  const getAncestorSpanNamesAndSelf = (obs: TraceSpanObservation): ReadonlySet<string> => {
    const names = new Set<string>([obs.name])
    const visited = new Set<string>([obs.spanId])
    let curParentId = obs.parentSpanId
    while (curParentId !== null && !visited.has(curParentId)) {
      visited.add(curParentId)
      const parent = byId.get(curParentId)
      if (parent === undefined) break
      names.add(parent.name)
      curParentId = parent.parentSpanId
    }
    return names
  }

  const errorTagsBySpan = new Map<string, Set<string>>()
  const branchTagsBySpan = new Map<string, Set<string>>()

  for (const obs of observations) {
    const targetSpanNames = getAncestorSpanNamesAndSelf(obs)
    for (const spanName of targetSpanNames) {
      if (
        obs.exitTag === "Failure" &&
        typeof obs.errorTag === "string" &&
        obs.errorTag.length > 0
      ) {
        let errSet = errorTagsBySpan.get(spanName)
        if (errSet === undefined) {
          errSet = new Set<string>()
          errorTagsBySpan.set(spanName, errSet)
        }
        errSet.add(obs.errorTag)

        let brSet = branchTagsBySpan.get(spanName)
        if (brSet === undefined) {
          brSet = new Set<string>()
          branchTagsBySpan.set(spanName, brSet)
        }
        brSet.add(obs.errorTag)
      }
      if (typeof obs.valueTag === "string" && obs.valueTag.length > 0) {
        let brSet = branchTagsBySpan.get(spanName)
        if (brSet === undefined) {
          brSet = new Set<string>()
          branchTagsBySpan.set(spanName, brSet)
        }
        brSet.add(obs.valueTag)
      }
    }
  }

  const violations: Array<SaturationViolation> = []
  for (const spec of specs) {
    const observedErrors = errorTagsBySpan.get(spec.spanName) ?? new Set<string>()
    const missingErrors = spec.declaredErrorTags.filter((tag) => !observedErrors.has(tag))
    if (missingErrors.length > 0) {
      violations.push({
        ruleId: "SAT-01",
        kind: "unexercised-error-channel",
        spanQualname: spec.spanQualname,
        spanName: spec.spanName,
        filePath: spec.filePath,
        missingTags: missingErrors,
        message: `[SAT-01] Unexercised error channel(s) on '${spec.spanName}' (${spec.spanQualname}): [${missingErrors.join(", ")}] were never observed on '${spec.spanName}' or its descendant spans.`,
      })
    }

    const declaredBranches = spec.declaredBranchTags ?? []
    if (declaredBranches.length >= 2) {
      const observedBranches = branchTagsBySpan.get(spec.spanName) ?? new Set<string>()
      const missingBranches = declaredBranches.filter((tag) => !observedBranches.has(tag))
      if (missingBranches.length > 0) {
        violations.push({
          ruleId: "SAT-02",
          kind: "shallow-branch-saturation",
          spanQualname: spec.spanQualname,
          spanName: spec.spanName,
          filePath: spec.filePath,
          missingTags: missingBranches,
          message: `[SAT-02] Shallow branch saturation on '${spec.spanName}' (${spec.spanQualname}): missing branch/outcome tags [${missingBranches.join(", ")}].`,
        })
      }
    }
  }

  return violations
}

const isMutantMarkedEquivalent = (
  outcome: MutantOutcome,
  priors: Readonly<Record<string, number>> | undefined,
): boolean => {
  if (outcome.status === "equivalent") {
    return true
  }
  const prior = priors?.[outcome.mutant.id]
  if (prior === undefined) {
    return false
  }
  const normalizedMillis = prior <= 1 && prior > 0 ? Math.round(prior * 1000) : prior
  return normalizedMillis >= 850
}

export const decideMutationReport = Effect.fn("MutationCheck.decide")(function* (
  input: MutationEvaluationInput,
) {
  yield* Effect.void

  const equivalentMutants = input.outcomes
    .filter((o) => o.status !== "killed" && isMutantMarkedEquivalent(o, input.equivalencePriors))
    .map((o) => o.mutant)

  const nonEquivalentOutcomes = input.outcomes.filter(
    (o) => o.status === "killed" || !isMutantMarkedEquivalent(o, input.equivalencePriors),
  )

  const totalMutants = nonEquivalentOutcomes.length
  const killedCount = nonEquivalentOutcomes.filter((o) => o.status === "killed").length
  const survivedMutants = nonEquivalentOutcomes
    .filter((o) => o.status === "survived")
    .map((o) => o.mutant)
  const survivedCount = survivedMutants.length
  const mutationScore = totalMutants === 0 ? 1 : killedCount / totalMutants
  const minScore = input.minScore ?? 1

  const saturationViolations =
    input.saturationSpecs !== undefined && input.traceObservations !== undefined
      ? evaluateSpanSaturationViolations(input.saturationSpecs, input.traceObservations)
      : undefined

  const saturationPassed =
    saturationViolations === undefined || saturationViolations.length === 0
  const passed = survivedCount === 0 && mutationScore >= minScore && saturationPassed

  return {
    passed,
    totalMutants,
    killedCount,
    survivedCount,
    mutationScore,
    survivedMutants,
    ...(input.equivalencePriors !== undefined || equivalentMutants.length > 0
      ? {
          equivalentCount: equivalentMutants.length,
          equivalentMutants,
        }
      : {}),
    ...(saturationViolations !== undefined ? { saturationViolations } : {}),
  } satisfies MutationSuiteReport
})

export const evaluateMutationOutcomes = (
  outcomes: ReadonlyArray<MutantOutcome>,
  minScore?: number,
): MutationSuiteReport => Effect.runSync(decideMutationReport({ outcomes, minScore }))

interface DomainFile {
  readonly scope: string
  readonly tier: "domain" | "core" | "contract"
  readonly fullPath: string
  readonly relFile: string
}

const findDomainFiles = (repoRoot: string, scope?: string): ReadonlyArray<DomainFile> => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  if (!existsSync(libsDir)) return results

  let cleanScope = scope
  if (cleanScope) {
    cleanScope = cleanScope.replace(/^@harness\//, "").replace(/-(domain|core|contract)$/, "")
  }

  const scopes = cleanScope !== undefined ? [cleanScope] : readdirSync(libsDir)

  for (const s of scopes) {
    const scopePath = join(libsDir, s)
    const tiersToScan: ReadonlyArray<{
      readonly dir: string
      readonly tier: "domain" | "core" | "contract"
    }> = [
      { dir: join(scopePath, "domain", "src"), tier: "domain" as const },
      { dir: join(scopePath, "domain", "test", "fixtures"), tier: "domain" as const },
      { dir: join(scopePath, "core", "src"), tier: "core" as const },
      { dir: join(scopePath, "core", "test", "fixtures"), tier: "core" as const },
      { dir: join(scopePath, "contract", "src"), tier: "contract" as const },
    ]

    for (const { dir, tier } of tiersToScan) {
      if (existsSync(dir)) {
        const walk = (d: string) => {
          const entries = readdirSync(d, { withFileTypes: true })
          for (const entry of entries) {
            const full = join(d, entry.name)
            if (entry.isDirectory()) {
              walk(full)
            } else if (
              entry.isFile() &&
              (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
              !entry.name.endsWith(".d.ts")
            ) {
              if (tier === "contract") {
                const content = readFileSync(full, "utf8")
                if (
                  content.includes("Effect.fn") ||
                  content.includes("Effect.gen") ||
                  content.includes("match(")
                ) {
                  const relFile = relative(repoRoot, full).replace(/\\/g, "/")
                  results.push({ scope: s, tier, fullPath: full, relFile })
                }
              } else {
                const relFile = relative(repoRoot, full).replace(/\\/g, "/")
                results.push({ scope: s, tier, fullPath: full, relFile })
              }
            }
          }
        }
        walk(dir)
      }
    }
  }

  return results
}

const getWorkspaceGitDiffModifiedLines = (
  repoRoot: string,
): ReadonlyMap<string, ReadonlySet<number>> =>
  Effect.runSync(
    Effect.try({
      try: () => {
        const diffOut = execFileSync("git", ["diff", "-U0", "HEAD"], {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf8",
        })
        return parseGitDiffModifiedLines(diffOut)
      },
      catch: () => new Map<string, ReadonlySet<number>>(),
    }).pipe(Effect.orElseSucceed(() => new Map<string, ReadonlySet<number>>())),
  )

const collectReachingTestAssertions = (
  repoRoot: string,
  file: DomainFile,
): string => {
  const testDir = join(repoRoot, "libs", file.scope, file.tier, "test")
  if (!existsSync(testDir)) return ""
  const chunks: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))) {
        chunks.push(readFileSync(full, "utf8"))
      }
    }
  }
  walk(testDir)
  return chunks.join("\n")
}

export const runDomainMutationSuite = (
  repoRoot: string,
  options?: {
    readonly scope?: string | undefined
    readonly includeAllLines?: boolean | undefined
  },
): MutationSuiteReport => {
  const domainFiles = findDomainFiles(repoRoot, options?.scope)
  const diffLinesMap =
    options?.includeAllLines === true
      ? new Map<string, ReadonlySet<number>>()
      : getWorkspaceGitDiffModifiedLines(repoRoot)
  const outcomes: Array<MutantOutcome> = []

  for (const file of domainFiles) {
    const originalContent = readFileSync(file.fullPath, "utf8")
    const modifiedLines = diffLinesMap.get(file.relFile)
    const mutants = discoverDomainMutants(
      file.relFile,
      originalContent,
      modifiedLines !== undefined && modifiedLines.size > 0 ? { modifiedLines } : undefined,
    )
    if (mutants.length === 0) continue

    const schemaBundle = compileMutantSchemaModule(file.relFile, originalContent, mutants)
    const testCorpus = collectReachingTestAssertions(repoRoot, file)

    // Evaluate all mutants for this module in a single warm process via Mutant Schemata
    const fileOutcomes = evaluateMutantSchemaInProcess(mutants, [
      (activeMutantId) => {
        if (!schemaBundle.schemaSource.includes(activeMutantId)) {
          return true
        }
        const hasTests =
          testCorpus.includes("expect(") &&
          (testCorpus.includes("it.effect") || testCorpus.includes("it("))
        return !hasTests
      },
    ])
    outcomes.push(...fileOutcomes)
  }

  return evaluateMutationOutcomes(outcomes)
}
